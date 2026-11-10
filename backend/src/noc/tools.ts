/**
 * Ferramentas do assistente NOC. Todas são de leitura.
 *
 * Só entram na lista as ferramentas dos conectores configurados — o modelo não
 * vê o que não pode usar. A ordem é fixa para não invalidar o cache do prompt.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { connectorEnabled, nocConfig, type ConnectorName } from './config.js';

// Rankings dos relatórios: menores quando o modelo tem cota pequena por minuto (modo compacto).
const topPadrao = () => (nocConfig.llm.provider !== 'anthropic' && nocConfig.openai.compactPrompt ? 5 : 15);
import { nocGet } from './connectors/noc.js';
import { activeProblems, problemEventsReport, zabbixCall, zabbixInstanceNames } from './connectors/zabbix.js';
import { deviceFaults, findDevices, pendingTasks } from './connectors/genieacs.js';
import { IXC_OPERATORS, IXC_RESOURCES, ixcList, ixcOsResumo } from './connectors/ixc.js';
import { opaAtendimentos, opaAtendimentosResumo, opaGet } from './connectors/opa.js';
import { findEquipamento, getKnowledge, nearFtth, pathBetween, searchFtth } from './knowledge.js';
import { buildTopology } from './topology.js';
import { limitList, matchesQuery, toToolText } from './http.js';
import { buildReport, REPORT_TOOL } from './report.js';

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  connector: ConnectorName | 'knowledge';
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<unknown>;
}

const tool = <S extends z.ZodTypeAny>(def: ToolDef<S>) => def;
const limite = (padrao: number, max = 500) => z.number().int().min(1).max(max).optional().describe(`Máximo de itens (padrão ${padrao}).`);

type Records = Array<Record<string, unknown>>;
const asArray = (data: unknown, ...keys: string[]): Records => {
  if (Array.isArray(data)) return data as Records;
  for (const key of keys) {
    const value = (data as Record<string, unknown> | null)?.[key];
    if (Array.isArray(value)) return value as Records;
  }
  return [];
};

const TOOLS = [
  // ------------------------------------------------------------ relatório pronto (números exatos, montado no servidor)
  tool({
    name: REPORT_TOOL,
    connector: 'knowledge',
    description: 'SEMPRE use para qualquer pedido de relatório (diário, de ontem, semanal, mensal, de incidentes, de O.S., de atendimentos). Monta o relatório completo com os números exatos do Zabbix, IXC e Opa! e a análise; ele é entregue direto ao usuário. Não monte relatório com as outras ferramentas.',
    schema: z.object({
      periodo: z.enum(['hoje', 'ontem', 'semana', 'mes', 'personalizado']).describe('semana = últimos 7 dias; mes = do dia 1 até agora'),
      desde: z.string().optional().describe('só para personalizado: AAAA-MM-DD ou ISO 8601'),
      ate: z.string().optional().describe('só para personalizado'),
      fontes: z.array(z.enum(['zabbix', 'ixc', 'opa'])).optional().describe('padrão: todas; ex.: só ["opa"] para relatório de atendimentos'),
    }),
    run: async ({ periodo, desde, ate, fontes }) => buildReport({ periodo, desde, ate, fontes }),
  }),
  // ------------------------------------------------------------ backbone / FTTH (sempre disponíveis)
  tool({
    name: 'equipe_documentos',
    connector: 'knowledge',
    description: 'Documentos da equipe (knowledge/*.md): procedimentos, VLANs, operadoras, contatos, comandos de OLT. Com "arquivo", devolve o documento; com "busca", só os trechos que citam o termo.',
    schema: z.object({
      arquivo: z.string().optional().describe('nome do arquivo, ex.: 03-procedimentos.md'),
      busca: z.string().optional().describe('termo a procurar em todos os documentos'),
    }),
    run: async ({ arquivo, busca }) => {
      const docs = (await getKnowledge()).documentos;
      if (arquivo) return docs.find((d) => d.arquivo === arquivo) ?? { erro: `não existe. Disponíveis: ${docs.map((d) => d.arquivo).join(', ')}` };
      if (!busca) return { arquivos: docs.map((d) => ({ arquivo: d.arquivo, caracteres: d.texto.length })) };
      // Trechos (parágrafos) que contêm todos os termos da busca.
      return docs.flatMap((d) => d.texto.split(/\n\s*\n/)
        .filter((p) => matchesQuery(p, busca))
        .map((trecho) => ({ arquivo: d.arquivo, trecho: trecho.trim().slice(0, 1500) })))
        .slice(0, 15);
    },
  }),
  tool({
    name: 'backbone_equipamento',
    connector: 'knowledge',
    description: 'Detalhe de um equipamento do backbone: modelo, local, todas as portas (nome da interface, capacidade, status, descrição/ifAlias, vínculo Zabbix) e os enlaces dele. Aceita id (ex.: "f1a", "m8") ou nome.',
    schema: z.object({ termo: z.string().describe('id ou nome do equipamento') }),
    run: async ({ termo }) => findEquipamento(await getKnowledge(), termo) ?? { erro: `equipamento "${termo}" não cadastrado na topologia` },
  }),
  tool({
    name: 'backbone_caminho',
    connector: 'knowledge',
    description: 'Caminho salto a salto entre dois equipamentos pelos enlaces cadastrados na topologia (portas e capacidade de cada salto). Use para análise de impacto: "se cair X, quem perde?".',
    schema: z.object({ de: z.string(), para: z.string() }),
    run: async ({ de, para }) => pathBetween(await getKnowledge(), de, para),
  }),
  tool({
    name: 'backbone_topologia',
    connector: 'knowledge',
    description: 'Topologia completa da rede para o painel 3D: equipamentos e enlaces cadastrados (NOC/topologia) + hosts de infraestrutura do Zabbix com o estado dos alarmes. Use quando pedirem a topologia, o mapa ou o desenho da rede/backbone.',
    schema: z.object({ incluir_zabbix: z.boolean().optional().describe('padrão true') }),
    run: ({ incluir_zabbix }) => buildTopology({ incluirZabbix: incluir_zabbix }),
  }),
  tool({
    name: 'ftth_buscar',
    connector: 'knowledge',
    description: 'Busca por nome/observação nas caixas (CEO, reserva técnica, travessia...), cabos de fibra (nome, nº de fibras, extensão) e POPs/clientes ISP do mapa de fibra.',
    schema: z.object({
      termo: z.string(),
      tipo: z.enum(['caixa', 'fibra', 'pop']).optional().describe('restringe a um tipo'),
      limite: limite(30, 200),
    }),
    run: async ({ termo, tipo, limite: n }) => searchFtth(await getKnowledge(), termo, tipo, n ?? 30),
  }),
  tool({
    name: 'ftth_proximos',
    connector: 'knowledge',
    description: 'Caixas e cabos de fibra próximos de uma coordenada, ordenados por distância, e os POPs mais próximos. Use para viabilidade, rompimento reportado num endereço ou achar a CEO mais perto de um cliente.',
    schema: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      raio_m: z.number().min(10).max(20000).optional().describe('raio em metros (padrão 500)'),
      limite: limite(15, 100),
    }),
    run: async ({ lat, lon, raio_m, limite: n }) => nearFtth(await getKnowledge(), lat, lon, raio_m ?? 500, n ?? 15),
  }),

  // ------------------------------------------------------------ sistema NOC
  tool({
    name: 'noc_visao_geral',
    connector: 'noc',
    description: 'Visão geral do NOC (tela Home): clientes GPON online/offline, tráfego agregado e alertas ativos de tráfego/enlace.',
    schema: z.object({ horas: z.number().int().min(1).max(168).optional() }),
    run: ({ horas }) => nocGet('/api/home/overview', { horas }),
  }),
  tool({
    name: 'noc_interfaces',
    connector: 'noc',
    description: 'Interfaces monitoradas pelo Zabbix (espelho do NOC): nome, ifAlias, status operacional, velocidade, RX/TX e utilização. Filtre sempre que possível.',
    schema: z.object({
      equipamento: z.string().optional().describe('id do equipamento na topologia'),
      hostid: z.string().optional().describe('hostid do Zabbix'),
      status: z.enum(['up', 'down']).optional(),
      q: z.string().optional().describe('busca por nome/descrição da interface'),
      conectadas: z.boolean().optional().describe('só interfaces com ifAlias (enlaces)'),
    }),
    run: ({ equipamento, hostid, status, q, conectadas }) =>
      nocGet('/api/zabbix/interfaces', { equipamento, hostid, status, q, conectadas: conectadas ? 1 : undefined }),
  }),
  tool({
    name: 'noc_enlaces',
    connector: 'noc',
    description: 'Enlaces derivados do Zabbix (ifAlias casados entre os dois lados), com status de cada ponta.',
    schema: z.object({}),
    run: () => nocGet('/api/zabbix/links'),
  }),
  tool({
    name: 'noc_trafego',
    connector: 'noc',
    description: 'Painel de tráfego: interfaces saturadas, com erro ou down, e o histórico agregado (bps de entrada/saída) das últimas horas.',
    schema: z.object({
      horas: z.number().int().min(1).max(168).optional(),
      tempo_real: z.boolean().optional().describe('lê o Zabbix ao vivo em vez do espelho do último ciclo'),
    }),
    run: ({ horas, tempo_real }) => nocGet('/api/zabbix/overview', { horas, realtime: tempo_real ? 1 : undefined }),
  }),
  tool({
    name: 'noc_gpon_clientes',
    connector: 'noc',
    description: 'ONUs/clientes FTTH das OLTs ZTE (C300/C350) com o estado mais recente da coleta: status, sinal RX/TX (dBm), IP, velocidade, uptime. Busque por nome, serial, PON (ex.: "1/2/3"), login, OLT ou status (online, offline, los, dying-gasp...).',
    schema: z.object({
      busca: z.string().optional().describe('termos que devem aparecer no registro'),
      apenas_problema: z.boolean().optional().describe('só ONUs fora do ar ou com sinal RX pior que -27 dBm'),
      limite: limite(50),
    }),
    run: async ({ busca, apenas_problema, limite: n }) => {
      const [inventario, estado] = await Promise.all([nocGet('/api/gpon/clients'), nocGet('/api/gpon/status')]);
      const status = new Map(asArray(estado, 'clients').map((s) => [String(s.id), s]));
      let clientes = asArray(inventario, 'clients', 'clientes').map((c) => ({ ...c, ...(status.get(String(c.id)) ?? {}) }));
      if (apenas_problema) {
        clientes = clientes.filter((c) => {
          const rx = Number(c.rx_power);
          return !/^online$/i.test(String(c.status ?? '')) || (Number.isFinite(rx) && rx < -27);
        });
      }
      const filtrados = clientes.filter((c) => matchesQuery(c, busca));
      const porStatus: Record<string, number> = {};
      for (const c of clientes) { const s = String(c.status ?? 'desconhecido'); porStatus[s] = (porStatus[s] || 0) + 1; }
      return { por_status: porStatus, ...limitList(filtrados, n ?? 50) };
    },
  }),
  tool({
    name: 'noc_gpon_historico',
    connector: 'noc',
    description: 'Linha do tempo de transições de estado das ONUs (quando caiu, quantas vezes oscilou, sinal antes/depois). Sem client_id traz as últimas transições do parque inteiro — bom para detectar queda em massa numa PON/CTO.',
    schema: z.object({
      client_id: z.string().optional(),
      desde: z.string().optional().describe('ISO 8601, ex.: 2026-09-22T08:00:00-03:00'),
      evento: z.string().optional(),
      limite: limite(50),
    }),
    run: ({ client_id, desde, evento, limite: n }) => nocGet('/api/gpon/history', { client_id, since: desde, event: evento, limit: n }),
  }),
  tool({
    name: 'noc_radius_logs',
    connector: 'noc',
    description: 'Log de autenticação PPPoE (RADIUS): conexões e desconexões por cliente/login, com motivo.',
    schema: z.object({
      client_id: z.string().optional(),
      username: z.string().optional().describe('login PPPoE exato'),
      desde: z.string().optional().describe('ISO 8601'),
      status: z.string().optional(),
      limite: limite(100),
    }),
    run: ({ client_id, username, desde, status, limite: n }) =>
      nocGet('/api/radius/logs', { client_id, username, since: desde, status, limit: n }),
  }),
  tool({
    name: 'noc_clientes',
    connector: 'noc',
    description: 'Cadastro de clientes sincronizado do IXC dentro do NOC (nome, contrato, login, endereço, coordenadas, ONU vinculada).',
    schema: z.object({ q: z.string().describe('nome, login, contrato ou endereço') }),
    run: ({ q }) => nocGet('/api/clientes', { q }),
  }),
  tool({
    name: 'noc_tickets',
    connector: 'noc',
    description: 'Chamados/tickets registrados no NOC.',
    schema: z.object({ busca: z.string().optional(), limite: limite(30) }),
    run: async ({ busca, limite: n }) => {
      const tickets = asArray(await nocGet('/api/tickets'), 'tickets');
      return limitList(tickets.filter((t) => matchesQuery(t, busca)), n ?? 30);
    },
  }),

  // ------------------------------------------------------------ Zabbix direto
  tool({
    name: 'zabbix_problemas',
    connector: 'zabbix',
    description: 'Alarmes ativos no Zabbix agora (instância, host, problema, severidade, desde quando, reconhecido). Sem "instancia" consulta todas as instâncias configuradas. Primeira ferramenta para "o que está caído?".',
    schema: z.object({
      instancia: z.string().optional().describe('nome da instância do Zabbix (veja o prompt); omita para todas'),
      severidade_minima: z.number().int().min(0).max(5).optional().describe('0 não classificado … 5 desastre (padrão 2 = atenção)'),
      host: z.string().optional().describe('parte do nome do host'),
      busca: z.string().optional().describe('parte do nome do problema'),
      limite: limite(100),
    }),
    run: ({ instancia, severidade_minima, host, busca, limite: n }) =>
      activeProblems({ instancia, minSeverity: severidade_minima, hostName: host, search: busca, limit: n }),
  }),
  tool({
    name: 'zabbix_relatorio_eventos',
    connector: 'zabbix',
    description: 'Relatório de incidentes de um período no Zabbix: total de eventos de problema, por severidade, hosts com mais eventos e com mais tempo em problema, problemas mais frequentes, eventos mais longos e quantos seguem abertos. Base para relatório diário/semanal/mensal e de disponibilidade.',
    schema: z.object({
      desde: z.string().describe('início ISO 8601, ex.: 2026-11-08T00:00:00-03:00'),
      ate: z.string().optional().describe('fim ISO 8601 (padrão: agora)'),
      instancia: z.string().optional().describe('omita para todas as instâncias'),
      severidade_minima: z.number().int().min(0).max(5).optional().describe('padrão 2 = atenção'),
      host: z.string().optional().describe('parte do nome do host'),
      busca: z.string().optional().describe('parte do nome do problema, ex.: "ICMP", "Interface"'),
      top: z.number().int().min(1).max(50).optional().describe('tamanho dos rankings (padrão 15)'),
    }),
    run: ({ desde, ate, instancia, severidade_minima, host, busca, top }) =>
      problemEventsReport({ desde, ate, instancia, minSeverity: severidade_minima, hostName: host, search: busca, top: top ?? topPadrao() }),
  }),
  tool({
    name: 'zabbix_consulta',
    connector: 'zabbix',
    description: 'Chamada JSON-RPC de leitura ao Zabbix para o que as outras ferramentas não cobrem (host.get, hostgroup.get, item.get, history.get, trend.get, event.get, trigger.get, sla.getsli...). Só métodos terminados em ".get". Sempre use "output" com os campos necessários e "limit". Sem "instancia" usa a principal.',
    schema: z.object({
      metodo: z.string().regex(/\.get$/, 'somente métodos .get'),
      params: z.record(z.unknown()).describe('params do método, como na documentação da API do Zabbix 7.0'),
      instancia: z.string().optional(),
    }),
    run: ({ metodo, params, instancia }) => zabbixCall(metodo, params, instancia),
  }),

  // ------------------------------------------------------------ GenieACS (TR-069)
  tool({
    name: 'acs_buscar_cpe',
    connector: 'genieacs',
    description: 'Busca ONTs/roteadores no GenieACS por serial, usuário PPPoE, id do device ou tag. Traz último inform, firmware, uptime, WAN (IP/status PPPoE), SSIDs, nº de hosts e sinal óptico lido pela CPE.',
    schema: z.object({ busca: z.string(), limite: limite(20, 100) }),
    run: ({ busca, limite: n }) => findDevices(busca, n ?? 20),
  }),
  tool({
    name: 'acs_falhas',
    connector: 'genieacs',
    description: 'Falhas registradas pelo GenieACS (provisionamento, connection request, download de firmware). Com device_id, só daquele equipamento.',
    schema: z.object({ device_id: z.string().optional(), limite: limite(50, 200) }),
    run: ({ device_id, limite: n }) => deviceFaults(device_id, n ?? 50),
  }),
  tool({
    name: 'acs_tarefas_pendentes',
    connector: 'genieacs',
    description: 'Tarefas TR-069 enfileiradas que a CPE ainda não executou (indica CPE sem inform ou connection request falhando).',
    schema: z.object({ device_id: z.string().optional(), limite: limite(50, 200) }),
    run: ({ device_id, limite: n }) => pendingTasks(device_id, n ?? 50),
  }),

  // ------------------------------------------------------------ IXC (ERP)
  tool({
    name: 'ixc_consultar',
    connector: 'ixc',
    description: `Leitura no IXC Soft. Recursos: ${Object.entries(IXC_RESOURCES).map(([k, v]) => `${k} (${v})`).join('; ')}. Operador "L" é LIKE (busca parcial). Ex.: radusuarios, campo "login", valor "joao", operador "L". CPF/CNPJ voltam mascarados.`,
    schema: z.object({
      recurso: z.enum(Object.keys(IXC_RESOURCES) as [keyof typeof IXC_RESOURCES, ...Array<keyof typeof IXC_RESOURCES>]),
      campo: z.string().describe('coluna do recurso, ex.: id, razao, login, id_cliente, status, online'),
      valor: z.string(),
      operador: z.enum(IXC_OPERATORS).optional(),
      limite: limite(20, 100),
    }),
    run: ({ recurso, campo, valor, operador, limite: n }) => ixcList(recurso, campo, valor, operador ?? '=', n ?? 20),
  }),
  tool({
    name: 'ixc_relatorio_os',
    connector: 'ixc',
    description: 'Relatório das ordens de serviço (O.S.) abertas no IXC num período: total, por status, por assunto, por setor, por técnico e tempo de resolução das finalizadas.',
    schema: z.object({
      desde: z.string().describe('início ISO 8601'),
      ate: z.string().optional().describe('fim ISO 8601 (padrão: agora)'),
      top: z.number().int().min(1).max(50).optional(),
    }),
    run: ({ desde, ate, top }) => ixcOsResumo(desde, ate, top ?? topPadrao()),
  }),

  // ------------------------------------------------------------ Opa! Suite (atendimento)
  tool({
    name: 'opa_atendimentos',
    connector: 'opa',
    description: 'Atendimentos do Opa! Suite (WhatsApp/chat da central), os mais recentes primeiro, com nome do setor e do atendente, protocolo, status, abertura, fim e duração. Use para achar o atendimento por protocolo, ver a fila (status AG aguardando / EA em atendimento) ou o que um setor/atendente atendeu. Sem filtro nenhum, traz os de hoje.',
    schema: z.object({
      desde: z.string().optional().describe('data inicial AAAA-MM-DD (ou ISO 8601; vale o dia em São Paulo)'),
      ate: z.string().optional().describe('data final AAAA-MM-DD (padrão: hoje)'),
      status: z.string().optional().describe('AG aguardando, EA em atendimento, F finalizado'),
      protocolo: z.string().optional().describe('ex.: UPD2026407805'),
      setor: z.string().optional().describe('nome (parte) ou id do setor'),
      atendente: z.string().optional().describe('nome (parte) ou id do atendente'),
      limite: limite(30, 500),
    }),
    run: ({ limite: n, ...f }) => opaAtendimentos(f, n ?? 30),
  }),
  tool({
    name: 'opa_relatorio_atendimentos',
    connector: 'opa',
    description: 'Relatório de atendimentos do Opa! Suite num período: total, por status, setor, canal, dia e atendente (com tempo médio), duração dos finalizados (média, mediana, p90) e o que segue em aberto (aguardando/em atendimento, os mais antigos primeiro).',
    schema: z.object({
      desde: z.string().describe('data inicial AAAA-MM-DD'),
      ate: z.string().optional().describe('data final AAAA-MM-DD (padrão: hoje)'),
      status: z.string().optional(),
      setor: z.string().optional().describe('nome (parte) ou id do setor'),
      atendente: z.string().optional().describe('nome (parte) ou id do atendente'),
      top: z.number().int().min(1).max(50).optional().describe('tamanho dos rankings (padrão 15)'),
    }),
    run: ({ top, ...f }) => opaAtendimentosResumo(f, top ?? topPadrao()),
  }),
  tool({
    name: 'opa_consulta',
    connector: 'opa',
    description: 'GET de leitura na API v1 do Opa! Suite para o que as outras ferramentas não cobrem: "atendimento/<id>" (detalhe completo, com cliente e mensagens resumidas), "departamento/<id>", "usuario/<id>", "usuario" com filtro {"status":"A"} (atendentes ativos, campo online). Listagens exigem filtro; campos não aceitos dão "Field \'x\' is not allowed". Tokens, e-mails, CPF/CNPJ e telefones chegam removidos ou mascarados.',
    schema: z.object({
      caminho: z.string().describe('caminho após /api/v1, ex.: "atendimento/6af1d98b39f773f71a134421"'),
      filtro: z.record(z.unknown()).optional(),
      limite: limite(50, 1000),
    }),
    run: ({ caminho, filtro, limite: n }) => opaGet(caminho, filtro ? { filter: filtro, options: { limit: n ?? 50 } } : undefined),
  }),
];

export { zabbixInstanceNames };

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function isAvailable(t: (typeof TOOLS)[number]) {
  return t.connector === 'knowledge' || connectorEnabled(t.connector);
}

export function availableTools(): Anthropic.Beta.Messages.BetaTool[] {
  return TOOLS.filter(isAvailable).map((t) => {
    const { $schema, ...schema } = zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as Record<string, unknown>;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema };
  });
}

export function connectorStatus() {
  const nomes: Array<ConnectorName> = ['noc', 'zabbix', 'genieacs', 'ixc', 'opa'];
  return Object.fromEntries(nomes.map((n) => [n, connectorEnabled(n)]));
}

/** Executa uma chamada do modelo. Erro vira texto para o modelo (is_error), nunca exceção no loop. */
export async function runTool(name: string, input: unknown): Promise<{ text: string; isError: boolean; data?: unknown }> {
  const def = byName.get(name);
  if (!def || !isAvailable(def)) return { text: `Ferramenta ${name} indisponível (conector não configurado).`, isError: true };
  const parsed = def.schema.safeParse(input ?? {});
  if (!parsed.success) return { text: `Entrada inválida: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true };
  try {
    // O tipo do schema é garantido pelo safeParse acima.
    const result = await (def.run as (i: unknown) => Promise<unknown>)(parsed.data);
    // O dashboard do relatório é só para a interface: não entra no texto que vai ao modelo.
    const paraTexto = name === REPORT_TOOL && result && typeof result === 'object' ? { ...(result as object), dashboard: undefined } : result;
    return { text: toToolText(paraTexto), isError: false, data: result };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
