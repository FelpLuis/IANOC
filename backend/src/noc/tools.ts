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
import { docDevices, docZabbix, ifsDoEquipamento } from './connectors/doc.js';
import { activeProblems, problemEventsReport, zabbixCall, zabbixInstanceNames } from './connectors/zabbix.js';
import { deviceFaults, findDevices, pendingTasks } from './connectors/genieacs.js';
import { IXC_OPERATORS, IXC_RESOURCES, ixcClientesPorPlano, ixcList, ixcOsResumo } from './connectors/ixc.js';
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
    description: 'Topologia completa da rede para o painel 3D: equipamentos e enlaces da documentação do NOC + hosts de infraestrutura do Zabbix com o estado dos alarmes. Use quando pedirem a topologia, o mapa ou o desenho da rede/backbone.',
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

  // ------------------------------------------------------------ Documentação do NOC (documentacao.noc.updown.com.br)
  tool({
    name: 'doc_equipamentos',
    connector: 'doc',
    description: 'Documentação de equipamentos do NOC: equipamento, modelo, site/POP, rack, função, IP de gerência, observações e hosts do Zabbix ligados. Busque por nome, site, modelo, função ou IP.',
    schema: z.object({ busca: z.string().optional(), limite: limite(30, 200) }),
    run: async ({ busca, limite: n }) => {
      const devs = (await docDevices()).map(({ ports, ...d }) => ({ ...d, portas: ports?.length ?? 0 }));
      return limitList(devs.filter((d) => matchesQuery(d, busca)), n ?? 30);
    },
  }),
  tool({
    name: 'doc_interfaces',
    connector: 'doc',
    description: 'Portas/interfaces documentadas de um equipamento com o estado do Zabbix (status UP/DOWN, velocidade, RX/TX óptico em dBm, bits de entrada/saída e, nas PONs das OLTs, ONUs, RX médio, ONUs com sinal baixo e pior ONU). Filtre por equipamento e, se quiser, por texto ou status.',
    schema: z.object({
      equipamento: z.string().optional().describe('nome ou id do equipamento (ex.: "F1A CENTRAL", "OLT C300")'),
      q: z.string().optional().describe('texto na interface ou descrição (ex.: "100GE0/1/48", "PRAIA GRANDE")'),
      status: z.enum(['up', 'down']).optional(),
      apenas_problema: z.boolean().optional().describe('só portas documentadas que estão DOWN/PARCIAL ou com sinal pior que -27 dBm'),
      limite: limite(80, 500),
    }),
    run: async ({ equipamento, q, status, apenas_problema, limite: n }) => {
      const [devs, z] = await Promise.all([docDevices(), docZabbix()]);
      const alvo = equipamento ? devs.filter((d) => matchesQuery({ id: d.id, nome: d.name }, equipamento)) : devs;
      if (equipamento && !alvo.length) return { erro: `equipamento "${equipamento}" não está na documentação` };
      const linhas = alvo.flatMap((d) => {
        const ifs = ifsDoEquipamento(d, z);
        return (d.ports ?? []).map((p) => {
          const zi = ifs.get(p.i);
          return {
            equipamento: d.name, interface: p.i, descricao: p.d, servico: p.s, observacao: p.o,
            status_doc: p.st, status_zabbix: zi?.st, velocidade: zi?.sp, rx_dbm: zi?.rx, tx_dbm: zi?.tx,
            entrada_bps: zi?.in, saida_bps: zi?.out, onus: zi?.onus, rx_medio_onus: zi?.rxm, onus_sinal_baixo: zi?.low, pior_onu: zi?.worst,
          };
        });
      });
      const dbm = (v: unknown) => Number(String(v ?? '').replace(',', '.').replace(/[^-\d.]/g, ''));
      const filtradas = linhas.filter((l) => {
        const st = String(l.status_zabbix || l.status_doc || '').toLowerCase();
        if (status && st !== status) return false;
        if (apenas_problema) {
          const usada = l.descricao && !/^\?\?$|interface em down|reserva|livre/i.test(String(l.descricao));
          const rx = dbm(l.rx_dbm);
          if (!(usada && (/down|parcial/.test(st) || (Number.isFinite(rx) && rx < -27)))) return false;
        }
        return matchesQuery({ i: l.interface, d: l.descricao, s: l.servico }, q);
      });
      return { zabbix_sincronizado: z.synced, ...(z.erro ? { erro_zabbix: z.erro } : {}), ...limitList(filtradas, n ?? 80) };
    },
  }),
  tool({
    name: 'doc_pon',
    connector: 'doc',
    description: 'Resumo das PONs das OLTs pela documentação + Zabbix: ONUs por PON, RX médio, ONUs com sinal baixo e pior ONU. Use para "qual PON está com sinal ruim?" ou "como está a PON 1/2/3 da C300?".',
    schema: z.object({
      olt: z.string().optional().describe('nome da OLT (ex.: "C300", "C350")'),
      pon: z.string().optional().describe('posição da PON, ex.: "1/2/3"'),
      apenas_problema: z.boolean().optional().describe('só PONs com ONUs de sinal baixo, pior ONU < -27 dBm ou porta DOWN'),
      limite: limite(50, 300),
    }),
    run: async ({ olt, pon, apenas_problema, limite: n }) => {
      const [devs, z] = await Promise.all([docDevices(), docZabbix()]);
      const olts = devs.filter((d) => /olt/i.test(`${d.role} ${d.name}`) && (!olt || matchesQuery({ n: d.name }, olt)));
      const dbm = (v: unknown) => Number(String(v ?? '').replace(',', '.').replace(/[^-\d.]/g, ''));
      const linhas = olts.flatMap((d) => [...ifsDoEquipamento(d, z).values()]
        .filter((f) => /^gpon/i.test(f.i) && (!pon || f.i.endsWith(`_${pon}`) || f.i.includes(pon)))
        .map((f) => ({ olt: d.name, pon: f.i.replace(/^gpon[-_]?(olt_)?/i, ''), status: f.st, onus: f.onus, rx_medio: f.rxm, sinal_baixo: f.low, pior_onu: f.worst, rx_modulo: f.rx, tx_modulo: f.tx })))
        .filter((l) => !apenas_problema || Number(l.sinal_baixo) > 0 || dbm(l.pior_onu) < -27 || /down/i.test(String(l.status)));
      return { zabbix_sincronizado: z.synced, ...limitList(linhas, n ?? 50) };
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
  tool({
    name: 'ixc_clientes_por_plano',
    connector: 'ixc',
    description: 'Lista os clientes cujo contrato tem um plano/produto com o termo no nome (ex.: "hotspot", "500 mega", "empresarial"): cliente, contrato, plano, status do contrato e da internet, ativação e bairro, com totais por status e por plano.',
    schema: z.object({
      termo: z.string().min(2).describe('nome ou parte do nome do plano/produto'),
      somente_ativos: z.boolean().optional().describe('só contratos ativos'),
    }),
    run: ({ termo, somente_ativos }) => ixcClientesPorPlano(termo, { somenteAtivos: somente_ativos }),
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
  const nomes: Array<ConnectorName> = ['doc', 'zabbix', 'genieacs', 'ixc', 'opa'];
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
