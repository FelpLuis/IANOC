/**
 * Motor nativo do IA NOC: responde sem modelo de linguagem externo.
 *
 * Pergunta → entendimento (nlu.ts) → consultas às mesmas ferramentas do assistente
 * (Zabbix, IXC, Opa!, topologia, GenieACS) → resposta montada aqui, com números
 * exatos. A primeira frase de cada resposta é um resumo para ser falado; depois vêm
 * as tabelas. Guarda o contexto da conversa para perguntas de seguimento
 * ("e ontem?", "e o 6730?").
 *
 * Cada consulta emite tool_start/tool_end como no modo com modelo, então a
 * interface mostra o progresso e os aparelhos em 3D do mesmo jeito.
 */

import { randomUUID } from 'node:crypto';
import type { AssistantEvent, AssistantReply } from '../assistant.js';
import { runTool, connectorStatus } from '../tools.js';
import { extractDevices } from '../devices.js';
import { getKnowledge, type Equipamento, type Knowledge } from '../knowledge.js';
import { buildTopology } from '../topology.js';
import { nocConfig } from '../config.js';
import { ixcList } from '../connectors/ixc.js';
import { buildManual } from '../web/manual.js';
import { provedorBusca } from '../web/research.js';
import { buscar as kbBuscar, temDocumentos } from '../kb.js';
import { cadastro } from './cadastro.js';
import { horaLocal } from '../http.js';
import { dur } from './analysis.js';
import { parse, norm, type Intent, type Parsed, type Periodo } from './nlu.js';
import * as nia from './persona.js';
import { calcular, dataHora, llmGeral, resetGeral, responderGeral } from './geral.js';

type Emit = (e: AssistantEvent) => void;
type Rec = Record<string, unknown>;

interface Context { last?: Parsed; lastIntent?: Intent }
const contexts = new Map<string, Context>();

export const NATIVE_LABEL = 'NIA · motor nativo (sem IA externa)';

// ------------------------------------------------------------------ utilidades de texto

const fmt = (n: number) => n.toLocaleString('pt-BR');
const plural = (n: number, um: string, varios: string) => `${fmt(n)} ${n === 1 ? um : varios}`;
const esc = (v: unknown) => String(v ?? '—').replace(/\|/g, '/').replace(/\n/g, ' ');
const cut = (s: unknown, n = 90) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return '_Nada a listar._';
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

function counts(obj: Record<string, number> | undefined, label: string, max = 10): string {
  const rows = Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]).slice(0, max);
  return table([label, 'Qtd.'], rows.map(([k, v]) => [k, fmt(v)]));
}

const SEV_ORDER: Record<string, number> = { desastre: 5, alta: 4, 'média': 3, media: 3, 'atenção': 2, atencao: 2, 'informação': 1, informacao: 1 };
const SEV_LABEL: Record<number, string> = { 5: 'desastre', 4: 'alta ou desastre', 3: 'média ou maior', 2: 'atenção ou maior', 1: 'qualquer severidade' };
const dataSP = (d: Date) => horaLocal(d).slice(0, 10);

/** "Hoje", "Ontem", "Nos últimos 7 dias", "Neste mês"… para começar a frase. */
const quando = (p: Periodo) => {
  const r = p.rotulo;
  if (r === 'hoje' || r === 'agora') return 'Hoje';
  if (r === 'ontem') return 'Ontem';
  if (r === 'este mês') return 'Neste mês';
  if (r === 'última hora') return 'Na última hora';
  return `Nos ${r}`;
};

// Códigos de status do IXC.
const CONTRATO_STATUS: Record<string, string> = { A: 'ativo', I: 'inativo', P: 'pré-contrato', N: 'negativado', D: 'desistiu', C: 'cancelado' };
const INTERNET_STATUS: Record<string, string> = { A: 'internet ativa', D: 'internet desativada', CM: 'bloqueio manual', CA: 'bloqueio automático', FA: 'bloqueio financeiro', AA: 'aguardando assinatura' };
const statusIxc = (map: Record<string, string>, v: unknown) => map[String(v ?? '').toUpperCase()] ?? String(v ?? '—');

// ------------------------------------------------------------------ execução das ferramentas

class Turn {
  toolsUsed: string[] = [];
  /** Modelo de linguagem usado na resposta (só nas perguntas gerais). */
  modelo?: string;
  constructor(private emit: Emit) {}

  async call<T = Rec>(name: string, input: Rec): Promise<{ ok: boolean; data: T; text: string }> {
    const id = `nat_${randomUUID().slice(0, 8)}`;
    const started = Date.now();
    this.emit({ type: 'tool_start', id, name, input });
    const { text, isError, data } = await runTool(name, input);
    const devices = isError ? [] : await extractDevices(name, input, data);
    const topology = !isError && name === 'backbone_topologia' ? data : undefined;
    this.emit({ type: 'tool_end', id, name, ok: !isError, ms: Date.now() - started, ...(devices.length ? { devices } : {}), ...(topology ? { topology } : {}) });
    this.toolsUsed.push(name);
    return { ok: !isError, data: (data ?? {}) as T, text };
  }

  conversa = '';

  /** Cartão de cadastro para o operador conferir e confirmar. */
  proposta(acao: unknown) {
    this.emit({ type: 'pending_action', acao });
  }

  /** Painel visual do relatório (KPIs, gráficos e tabelas) para a interface desenhar. */
  painel(dashboard: unknown) {
    this.emit({ type: 'dashboard', dashboard });
  }

  /** Pede ao navegador do operador para abrir uma página em nova guia. */
  open(url: string, label: string) {
    this.emit({ type: 'open_url', url, label });
  }

  /** Consulta interna (fora da lista de ferramentas) com o mesmo aviso de progresso na interface. */
  async track<T>(name: string, input: Rec, fn: () => Promise<T>): Promise<T> {
    const id = `nat_${randomUUID().slice(0, 8)}`;
    const started = Date.now();
    this.emit({ type: 'tool_start', id, name, input });
    try {
      const out = await fn();
      this.emit({ type: 'tool_end', id, name, ok: true, ms: Date.now() - started });
      this.toolsUsed.push(name);
      return out;
    } catch (e) {
      this.emit({ type: 'tool_end', id, name, ok: false, ms: Date.now() - started });
      throw e;
    }
  }
}

const on = (c: string) => Boolean((connectorStatus() as Record<string, boolean>)[c]);

// ------------------------------------------------------------------ respostas

interface Problem { instancia?: string; host: string; problema: string; severidade: string; desde?: string; reconhecido?: boolean }

function causaCliente(p: string) {
  if (/\blos\b/i.test(p)) return 'LOS (sem sinal na fibra)';
  if (/energia/i.test(p)) return 'Falta de energia';
  if (/roteador|cabo/i.test(p)) return 'Roteador ou cabo';
  if (/sinal|dbm|atenua/i.test(p)) return 'Sinal degradado';
  return 'Outros';
}

async function alarmes(t: Turn, q: Parsed): Promise<string> {
  const sev = q.severidade ?? 4;
  const host = q.host ?? q.equipamentos[0]?.nome;
  const r = await t.call<{ total: number; problems: Problem[]; erros?: Rec }>('zabbix_problemas', { severidade_minima: sev, ...(host ? { host } : {}), limite: 300 });
  if (!r.ok) return nia.erro(`Zabbix: ${r.text}`);
  const probs = [...(r.data.problems ?? [])].sort((a, b) => (SEV_ORDER[b.severidade] ?? 0) - (SEV_ORDER[a.severidade] ?? 0) || String(b.desde).localeCompare(String(a.desde)));
  const onde = host ? ` em ${host}` : '';
  if (!probs.length) return nia.semAlarmes(SEV_LABEL[sev] ?? 'informada', onde);

  const clientes = probs.filter((p) => /^o cliente\b/i.test(p.problema));
  const infra = probs.filter((p) => !/^o cliente\b/i.test(p.problema));
  const desastres = probs.filter((p) => p.severidade === 'desastre');
  const semAck = probs.filter((p) => p.reconhecido === false).length;

  const causas: Record<string, number> = {};
  for (const p of clientes) causas[causaCliente(p.problema)] = (causas[causaCliente(p.problema)] ?? 0) + 1;
  const losRecentes = clientes.filter((p) => /\blos\b/i.test(p.problema) && p.desde && Date.now() - new Date(`${p.desde.replace(' ', 'T')}-03:00`).getTime() < 30 * 60_000).length;

  const fala = [
    `Há ${plural(probs.length, 'alarme', 'alarmes')} de severidade ${SEV_LABEL[sev]} ${probs.length === 1 ? 'aberto' : 'abertos'}${onde} agora`,
    infra.length || clientes.length ? `: ${plural(infra.length, 'de infraestrutura', 'de infraestrutura')} e ${plural(clientes.length, 'de cliente', 'de clientes')}.` : '.',
    desastres.length ? ` Atenção: ${plural(desastres.length, 'desastre', 'desastres')}, em ${[...new Set(desastres.map((p) => p.host))].slice(0, 3).join(', ')}.` : '',
    infra.length && !desastres.length ? ` Na infraestrutura, o primeiro da lista é ${infra[0].host}.` : '',
    losRecentes >= 5 ? ` ${losRecentes} clientes entraram em LOS nos últimos 30 minutos — pode ser rompimento de fibra.` : '',
  ].join('');

  const crise = desastres.length > 0 || losRecentes >= 5;
  const md = [nia.aberturaAlarmes(crise) + fala];
  if (infra.length) {
    md.push(`### Infraestrutura (${infra.length})`, table(['Severidade', 'Host', 'Problema', 'Desde', 'Reconhecido'],
      infra.slice(0, 20).map((p) => [p.severidade, p.host, cut(p.problema, 80), p.desde, p.reconhecido ? 'sim' : 'não'])));
    if (infra.length > 20) md.push(`_Mais ${infra.length - 20} alarmes de infraestrutura não listados._`);
  }
  if (clientes.length) {
    md.push(`### Clientes desconectados (${clientes.length})`, counts(causas, 'Causa'));
    md.push(table(['Cliente', 'Causa', 'Desde'], clientes.slice(0, 10).map((p) => [p.host, causaCliente(p.problema), p.desde])));
    if (clientes.length > 10) md.push(`_Mais ${clientes.length - 10} clientes não listados._`);
  }
  if (semAck) md.push(`> ${plural(semAck, 'alarme está', 'alarmes estão')} sem reconhecimento no Zabbix.`);
  if (r.data.erros) md.push(`> Instâncias com erro: ${Object.entries(r.data.erros).map(([k, v]) => `${k} (${v})`).join('; ')}`);
  const sug = nia.sugestaoAlarmes({ desastres: desastres.length, semAck, losRecentes, primeiroInfra: desastres.find((p) => !/^o cliente\b/i.test(p.problema))?.host });
  if (sug) md.push(sug);
  return md.join('\n\n');
}

async function eventos(t: Turn, q: Parsed): Promise<string> {
  const p = q.periodo.nome === 'agora' || q.periodo.nome === 'hoje' && !q.periodo.explicito ? { ...q.periodo, from: new Date(Date.now() - 7 * 86400_000), rotulo: 'últimos 7 dias' } : q.periodo;
  const host = q.host ?? q.equipamentos[0]?.nome;
  const r = await t.call<{
    total_eventos: number; ainda_abertos: number; por_severidade: Record<string, number>;
    hosts_mais_tempo_com_problema: Array<{ host: string; instancia: string; eventos: number; minutos: number; abertos: number }>;
    hosts_mais_eventos: Array<{ host: string; instancia: string; eventos: number; minutos: number }>;
    problemas_mais_frequentes: Array<{ problema: string; eventos: number }>;
  }>('zabbix_relatorio_eventos', { desde: p.from.toISOString(), ate: p.to.toISOString(), top: 10, ...(host ? { host } : {}), ...(q.severidade ? { severidade_minima: q.severidade } : {}) });
  if (!r.ok) return `Não consegui o histórico do Zabbix: ${r.text}`;
  const z = r.data;
  const pior = z.hosts_mais_tempo_com_problema?.[0];
  const mais = z.hosts_mais_eventos?.[0];
  const fala = `${quando(p)}${host ? `, em ${host}` : ''}, o Zabbix registrou ${plural(z.total_eventos ?? 0, 'evento de problema', 'eventos de problema')}, ${plural(z.ainda_abertos ?? 0, 'ainda aberto', 'ainda abertos')}.`
    + (mais ? ` Quem mais caiu foi ${mais.host}, com ${plural(mais.eventos, 'evento', 'eventos')}.` : '')
    + (pior && pior !== mais ? ` Mais tempo em problema: ${pior.host}, ${dur(pior.minutos)}.` : '');
  return [
    fala,
    '### Por severidade', counts(z.por_severidade, 'Severidade'),
    '### Hosts que mais caíram', table(['Host', 'Instância', 'Eventos', 'Tempo em problema'], (z.hosts_mais_eventos ?? []).map((h) => [h.host, h.instancia, h.eventos, dur(h.minutos)])),
    '### Mais tempo em problema', table(['Host', 'Eventos', 'Tempo', 'Abertos'], (z.hosts_mais_tempo_com_problema ?? []).map((h) => [h.host, h.eventos, dur(h.minutos), h.abertos])),
    '### Problemas mais frequentes', table(['Problema', 'Eventos'], (z.problemas_mais_frequentes ?? []).map((x) => [cut(x.problema, 100), x.eventos])),
  ].join('\n\n');
}

/** Relatório (texto completo) ou dashboard (painel visual em tela cheia), com os mesmos números. */
async function relatorio(t: Turn, q: Parsed, comoDashboard = false): Promise<string> {
  const n = q.periodo.nome;
  const periodo = n === 'ontem' || n === 'semana' || n === 'mes' ? n : n === 'hoje' || n === 'agora' ? 'hoje' : 'personalizado';
  const fontes = [
    /zabbix|rede|alarm|incident|backbone/.test(q.texto) && 'zabbix',
    /\bixc\b|o\.? ?s\b|ordens?|tecnic/.test(q.texto) && 'ixc',
    /\bopa\b|atendiment|suporte|fila/.test(q.texto) && 'opa',
  ].filter(Boolean) as string[];
  const r = await t.call<{ markdown?: string; dashboard?: { kpis: Array<{ rotulo: string; valor: string }>; status: { texto: string }; periodo: string; abrir?: boolean } }>('relatorio_noc', {
    periodo,
    ...(periodo === 'personalizado' ? { desde: q.periodo.from.toISOString(), ate: q.periodo.to.toISOString() } : {}),
    ...(fontes.length ? { fontes } : {}),
  });
  if (!r.ok || !r.data.markdown) return nia.erro(`relatório: ${r.text}`);
  const d = r.data.dashboard;
  if (d) t.painel({ ...d, abrir: comoDashboard });
  if (!comoDashboard || !d) return `${nia.aberturaRelatorio()}${d ? ' O dashboard visual está logo abaixo.' : ''}\n\n${r.data.markdown}`;
  // Dashboard: fala curta com os indicadores; o painel abre em tela cheia. O texto completo fica para exportar.
  const kpis = d.kpis.slice(0, 4).map((k) => `${k.rotulo.toLowerCase()}: ${k.valor}`).join('; ');
  return [
    `${nia.pick('dash', ['Dashboard projetado, Chefe.', 'Painel montado e sincronizado com os sistemas.', 'Indicadores renderizados.'])} Período: ${d.periodo}. Status geral: ${d.status.texto.toLowerCase()}${kpis ? ` — ${kpis}` : ''}.`,
    '> Painel aberto em tela cheia. Use **Exportar** para salvar em HTML ou PDF com a identidade da UpDown.',
  ].join('\n\n');
}

function vizinhoNome(k: Knowledge, id: string) {
  return k.equipamentos.find((e) => e.id === id)?.nome ?? id;
}

async function equipamento(t: Turn, q: Parsed, k: Knowledge): Promise<string> {
  const e = q.equipamentos[0];
  if (!e) return 'Qual equipamento? Diga o nome ou o id da topologia, por exemplo: "como está o NE F1A?".';
  const r = await t.call<Equipamento & { enlaces?: Array<{ origem: string; portaOrigem?: unknown; destino: string; portaDestino?: unknown; capacidade?: string; tipo?: string }>; erro?: string }>('backbone_equipamento', { termo: e.id });
  if (!r.ok || r.data.erro) return `Não achei ${e.nome} na topologia.`;
  const d = r.data;
  const portas = d.portas ?? [];
  const usadas = portas.filter((p) => /conect|up|ativ/i.test(String(p.status))).length;
  const enlaces = d.enlaces ?? [];

  // Alarmes do Zabbix com o nome do equipamento (o nome no Zabbix costuma conter o modelo ou a sigla).
  let alarmesMd = '';
  let alarmesFala = '';
  if (on('zabbix')) {
    const chave = e.nome.split(/[\s•|-]+/).find((x) => /\d/.test(x) && x.length >= 3) ?? e.nome;
    const z = await t.call<{ problems: Problem[] }>('zabbix_problemas', { host: chave, severidade_minima: 2, limite: 50 });
    const ps = z.ok ? z.data.problems ?? [] : [];
    alarmesFala = ps.length ? ` No Zabbix há ${plural(ps.length, 'alarme aberto', 'alarmes abertos')} em hosts com "${chave}" no nome.` : ' Nenhum alarme aberto no Zabbix para ele.';
    if (ps.length) alarmesMd = ['### Alarmes no Zabbix', table(['Severidade', 'Host', 'Problema', 'Desde'], ps.slice(0, 12).map((p) => [p.severidade, p.host, cut(p.problema, 80), p.desde]))].join('\n\n');
  }

  const fala = nia.aberturaEquipamento(d.nome) + `${d.nome} é ${d.modelo && !/nao identificado/i.test(norm(d.modelo)) ? `um ${d.modelo}` : 'um equipamento'}${d.categoria ? ` da camada de ${d.categoria.toLowerCase()}` : ''}${d.local ? `, em ${d.local}` : ''}.`
    + (portas.length ? ` Tem ${usadas} de ${portas.length} portas em uso` : '')
    + (enlaces.length ? `${portas.length ? ' e' : ' Tem'} ${plural(enlaces.length, 'enlace cadastrado', 'enlaces cadastrados')}.` : portas.length ? '.' : '')
    + alarmesFala;

  return [
    fala,
    d.observacao ? `> ${cut(d.observacao, 300)}` : '',
    enlaces.length ? '### Enlaces' : '',
    enlaces.length ? table(['Vizinho', 'Porta local', 'Porta remota', 'Capacidade', 'Tipo'], enlaces.map((c) => {
      const local = c.origem === d.id;
      return [vizinhoNome(k, local ? c.destino : c.origem), local ? c.portaOrigem : c.portaDestino, local ? c.portaDestino : c.portaOrigem, c.capacidade ?? '—', c.tipo ?? '—'];
    })) : '',
    alarmesMd,
    nia.sugestaoEquipamento(d.nome, alarmesMd ? 1 : 0),
    '_Abra o painel 3D para ver o equipamento e o mapa de portas._',
  ].filter(Boolean).join('\n\n');
}

function capacidadeGbps(c?: string) {
  const nums = String(c ?? '').match(/\d+(?:[.,]\d+)?/g)?.map((x) => Number(x.replace(',', '.')));
  return nums?.length ? Math.min(...nums) : undefined;
}

async function caminho(t: Turn, q: Parsed, k: Knowledge): Promise<string> {
  let [a, b] = q.equipamentos;
  if (!a || !b) {
    const m = q.original.match(/\b(?:de|do|da)\s+(.+?)\s+(?:at[eé]|para|pro|pra|->)\s+(?:o|a)?\s*(.+?)[?.!]*$/i);
    if (m) return caminhoPorNome(t, k, m[1], m[2]);
    return 'Preciso de dois equipamentos, por exemplo: "caminho do NE F1A até o NE8000-M8".';
  }
  return caminhoPorNome(t, k, a.id, b.id);
}

async function caminhoPorNome(t: Turn, k: Knowledge, de: string, para: string): Promise<string> {
  const r = await t.call<{ de?: string; para?: string; saltos?: number; caminho?: Array<{ origem: string; portaOrigem?: unknown; destino: string; portaDestino?: unknown; capacidade?: string; tipo?: string }>; erro?: string }>('backbone_caminho', { de, para });
  if (!r.ok || r.data.erro || !r.data.caminho) return `Não encontrei caminho entre ${de} e ${para}${r.data.erro ? `: ${r.data.erro}` : '.'}`;
  const hops = r.data.caminho;
  const nos = [hops[0].origem, ...hops.map((h) => h.destino)].map((id) => vizinhoNome(k, id));
  const conhecidos = hops.map((h) => ({ h, g: capacidadeGbps(h.capacidade) })).filter((x) => x.g !== undefined);
  const gargalo = conhecidos.sort((x, y) => (x.g ?? 0) - (y.g ?? 0))[0];
  const aConfirmar = hops.filter((h) => !h.capacidade || /confirmar/i.test(h.capacidade)).length;
  const fala = `De ${r.data.de} até ${r.data.para} são ${plural(hops.length, 'salto', 'saltos')}: ${nos.join(', ')}.`
    + (gargalo ? ` O trecho de menor capacidade conhecida é ${vizinhoNome(k, gargalo.h.origem)} para ${vizinhoNome(k, gargalo.h.destino)}, com ${gargalo.h.capacidade}.` : '')
    + (aConfirmar ? ` ${plural(aConfirmar, 'trecho está', 'trechos estão')} com capacidade a confirmar.` : '');
  return [
    fala,
    table(['#', 'De (porta)', 'Para (porta)', 'Capacidade', 'Tipo'], hops.map((h, i) => [i + 1, `${vizinhoNome(k, h.origem)} (${h.portaOrigem ?? '—'})`, `${vizinhoNome(k, h.destino)} (${h.portaDestino ?? '—'})`, h.capacidade ?? '—', h.tipo ?? '—'])),
    nia.sugestaoCaminho(aConfirmar),
    '_Os equipamentos do caminho estão no painel 3D._',
  ].filter(Boolean).join('\n\n');
}

/**
 * "Quais aparelhos estão conectados no X?": tudo o que está ligado ao equipamento —
 * enlaces cadastrados (com portas e capacidade), hosts do Zabbix associados a ele e
 * ligações inferidas, cada um com o estado dos alarmes. Em concentrador/roteador,
 * soma as sessões PPPoE online do IXC.
 */
async function conectados(t: Turn, q: Parsed, k: Knowledge): Promise<string> {
  const eqs = q.equipamentos.slice(0, 3);
  if (!eqs.length) return 'De qual equipamento, Chefe? Por exemplo: "aparelhos conectados no NE F1A" ou "o que está ligado no 6730".';
  for (const e of eqs) await t.call('backbone_equipamento', { termo: e.id });
  const g = await t.track('topologia_conexoes', { equipamentos: eqs.map((e) => e.id) }, () => buildTopology());

  const md: string[] = [];
  const falas: string[] = [];
  let algumRoteador = false;
  // Nomes repetidos na topologia (dois "6730") ganham a camada para distinguir.
  const rotulo = (e: Equipamento) => (k.equipamentos.filter((x) => x.nome === e.nome).length > 1 ? `${e.nome} (${[e.categoria, e.local].filter(Boolean).join(', ')})` : e.nome);
  for (const e of eqs) {
    const node = g.nodes.find((n) => n.id === e.id);
    const ligs = g.links
      .filter((l) => l.de === e.id || l.para === e.id)
      .map((l) => ({ l, outro: g.nodes.find((n) => n.id === (l.de === e.id ? l.para : l.de)) }))
      .filter((x): x is { l: typeof x.l; outro: NonNullable<typeof x.outro> } => Boolean(x.outro));
    const cad = ligs.filter((x) => !x.l.inferido);
    const inf = ligs.filter((x) => x.l.inferido);
    const comAlarme = ligs.filter((x) => x.outro.status === 'critico' || x.outro.status === 'atencao');
    if (node?.tipo === 'roteador') algumRoteador = true;
    falas.push(`${rotulo(e)} tem ${plural(cad.length, 'enlace cadastrado', 'enlaces cadastrados')}${inf.length ? ` e ${plural(inf.length, 'ligação inferida', 'ligações inferidas')}` : ''}${node?.hosts?.length ? `, com ${plural(node.hosts.length, 'host', 'hosts')} no Zabbix` : ''}${comAlarme.length ? `; ${plural(comAlarme.length, 'vizinho está', 'vizinhos estão')} com alarme` : ''}`);

    const portaDe = (outroId: string) => {
      const c = k.conexoes.find((x) => (x.origem === e.id && x.destino === outroId) || (x.destino === e.id && x.origem === outroId));
      if (!c) return '—';
      const local = c.origem === e.id ? c.portaOrigem : c.portaDestino;
      const remota = c.origem === e.id ? c.portaDestino : c.portaOrigem;
      return `${local ?? '?'} → ${remota ?? '?'}`;
    };
    const estado = (s: string) => ({ ok: 'operacional', atencao: 'atenção', critico: 'crítico', desconhecido: 'sem telemetria' } as Record<string, string>)[s] ?? s;
    md.push(`### Conectados ao ${rotulo(e)}`);
    md.push(table(['Aparelho', 'Tipo', 'Portas (local → remota)', 'Capacidade / ligação', 'Estado'], [
      ...cad.map((x) => [x.outro.nome, x.outro.tipo, portaDe(x.outro.id), x.l.capacidade ?? x.l.tipo ?? '—', estado(x.outro.status)]),
      ...inf.map((x) => [x.outro.nome + (x.outro.agrupados ? ` (${x.outro.agrupados})` : ''), x.outro.tipo, '—', `inferido: ${x.l.tipo ?? 'mesmo local'}`, estado(x.outro.status)]),
    ]));
    if (node?.hosts?.length) md.push(`Hosts do Zabbix deste equipamento: ${node.hosts.join(', ')}.`);
  }

  // Sessões de assinantes: logins PPPoE online no IXC (contagem rápida + amostra para o concentrador).
  let falaPppoe = '';
  if (algumRoteador && on('ixc')) {
    const r = await t.track('ixc_logins_online', { online: 'S' }, () => ixcList('radusuarios', 'online', 'S', '=', 500));
    const porConc: Record<string, number> = {};
    for (const x of r.registros) porConc[String(x.concentrador || '?')] = (porConc[String(x.concentrador || '?')] ?? 0) + 1;
    const concs = Object.keys(porConc);
    falaPppoe = ` Do lado dos assinantes, o IXC mostra ${fmt(r.total)} logins PPPoE online agora${concs.length === 1 ? `, no concentrador ${concs[0]}` : ''}.`;
    md.push('### Sessões PPPoE online (IXC)',
      `**${fmt(r.total)}** logins online.${concs.length === 1 ? ` Na amostra de ${r.registros.length}, todos no concentrador **${concs[0]}**.` : ''}`,
      concs.length > 1 ? counts(porConc, 'Concentrador (amostra)') : '',
      '_O IXC registra o concentrador pelo IP; o vínculo IP → equipamento não está cadastrado na topologia._');
  }

  const varios = eqs.length > 1 ? `"${q.original.match(/\b[A-Za-z]{0,3}\d{3,5}[A-Za-z]?\b/)?.[0] ?? eqs[0].nome}" corresponde a ${eqs.length} equipamentos: ${eqs.map(rotulo).join(', ')}. ` : '';
  return [
    `Varredura de conexões concluída. ${varios}${falas.join('. ')}.${falaPppoe}`,
    ...md.filter(Boolean),
    g.resumo.inferidos ? '**Sugestão:** as ligações inferidas vêm do nome/local dos hosts do Zabbix. Cadastre esses enlaces na topologia do NOC e eu passo a mostrar porta e capacidade de cada um.' : '',
  ].filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------------ abrir páginas no navegador do operador

const origem = (u?: string) => { try { return u ? new URL(u).origin : undefined; } catch { return undefined; } };
const webZabbix = () => { const z = nocConfig.zabbix[0]?.url; return z ? z.replace(/\/?api_jsonrpc\.php$/i, '').replace(/\/+$/, '') : undefined; };
const webIxc = () => { const o = origem(nocConfig.ixc.baseUrl); return o ? `${o}/adm.php` : undefined; };
const webOpa = () => { const o = origem(nocConfig.opa.baseUrl); return o ? `${o}/atendente/` : undefined; };
const webNoc = () => origem(nocConfig.noc.baseUrl);

/**
 * "Abre o Zabbix", "abre o IXC e o Opa", "abre o mapa da CTO 366", "pesquisa X no Google",
 * "abre o site exemplo.com.br". Só monta endereços http/https e manda o navegador abrir em
 * nova guia; não executa nada na máquina.
 */
async function abrir(t: Turn, q: Parsed): Promise<string> {
  const alvos: Array<{ url: string; label: string }> = [];
  const tx = q.texto;
  const host = q.host ?? q.equipamentos[0]?.nome;

  // Endereço dito na pergunta.
  for (const m of q.original.matchAll(/\b((?:https?:\/\/|www\.)[^\s<>"']+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|gov|edu|io|br)(?:\.br)?(?:\/[^\s<>"']*)?)/gi)) {
    const bruto = m[1].replace(/[.,;!?)]+$/, '');
    try {
      const u = new URL(/^https?:/i.test(bruto) ? bruto : `https://${bruto}`);
      if (u.protocol === 'http:' || u.protocol === 'https:') alvos.push({ url: u.href, label: u.hostname });
    } catch { /* não é endereço */ }
  }
  if (/\bzabbix\b/.test(tx)) {
    const b = webZabbix();
    if (b) alvos.push(host
      ? { url: `${b}/zabbix.php?action=search&search=${encodeURIComponent(host)}`, label: `Zabbix · ${host}` }
      : /alarm|problem|incident|alerta/.test(tx)
        ? { url: `${b}/zabbix.php?action=problem.view`, label: 'Zabbix · problemas' }
        : { url: `${b}/zabbix.php?action=dashboard.view`, label: 'Zabbix' });
  }
  if (/\bixc\b/.test(tx)) { const u = webIxc(); if (u) alvos.push({ url: u, label: 'IXC' }); }
  if (/\bopa\b/.test(tx)) { const u = webOpa(); if (u) alvos.push({ url: u, label: 'Opa! Suite' }); }
  if (/\bsistema( do)? noc\b|\bpainel( do)? noc\b|\bnoc\b/.test(tx) && !/\bzabbix\b/.test(tx)) { const u = webNoc(); if (u) alvos.push({ url: u, label: 'Sistema NOC' }); }
  if (q.caixa || /\b(cto|ceo|caixa)\b/.test(tx)) {
    const termo = q.caixa ?? q.original.replace(/^.*?\b(cto|ceo|caixa)\b/i, '$1').replace(/[?!.]+$/, '');
    const r = await t.call<{ caixas?: Array<{ nome: string; lat?: number; lon?: number }> }>('ftth_buscar', { termo, tipo: 'caixa' });
    for (const c of (r.data.caixas ?? []).filter((c) => c.lat && c.lon).slice(0, 3)) {
      alvos.push({ url: `https://www.google.com/maps?q=${c.lat},${c.lon}`, label: `Mapa · ${c.nome}` });
    }
  }
  // Sites conhecidos pelo nome. Música/vídeo com "toca X" abre a busca de X.
  const pedidoMusica = q.original.match(/\b(?:toca|tocar|toque|coloca|coloque|coloco|bota|p[õo]e)\s+(?:pra tocar\s+|para tocar\s+|a música\s+|a playlist\s+)?(.+?)\s+no\s+(?:spotify|youtube)\b/i)?.[1];
  const SITES: Array<[RegExp, string, string, ((s: string) => string)?]> = [
    [/\bspotify\b/, 'Spotify', 'https://open.spotify.com/', (s) => `https://open.spotify.com/search/${encodeURIComponent(s)}`],
    [/\byoutube music\b/, 'YouTube Music', 'https://music.youtube.com/', (s) => `https://music.youtube.com/search?q=${encodeURIComponent(s)}`],
    [/\byoutube\b(?! music)/, 'YouTube', 'https://www.youtube.com/', (s) => `https://www.youtube.com/results?search_query=${encodeURIComponent(s)}`],
    [/\bwhatsapp\b|\bzap\b/, 'WhatsApp Web', 'https://web.whatsapp.com/'],
    [/\bgmail\b/, 'Gmail', 'https://mail.google.com/'],
    [/\boutlook\b/, 'Outlook', 'https://outlook.office.com/'],
    [/\bdrive\b/, 'Google Drive', 'https://drive.google.com/'],
    [/\bagenda\b|\bcalendario\b/, 'Google Agenda', 'https://calendar.google.com/'],
    [/\bteams\b/, 'Microsoft Teams', 'https://teams.microsoft.com/'],
    [/\bnetflix\b/, 'Netflix', 'https://www.netflix.com/'],
  ];
  for (const [re, label, url, busca] of SITES) {
    if (!re.test(tx)) continue;
    alvos.push(pedidoMusica && busca ? { url: busca(pedidoMusica.trim()), label: `${label} · ${cut(pedidoMusica.trim(), 30)}` } : { url, label });
  }

  if (/\bgoogle\b|\bpesquis/.test(tx)) {
    const busca = q.original.match(/pesquis[ae]r?\s+(?:por\s+|sobre\s+)?(.+?)(?:\s+no\s+google)?[?.!]*$/i)?.[1]
      ?? q.original.match(/google\s+(?:por\s+|sobre\s+|com\s+)?(.+?)[?.!]*$/i)?.[1];
    alvos.push(busca && !/^(o|a|uma?)?\s*(nova\s+)?(guia|aba|janela)?$/i.test(busca.trim())
      ? { url: `https://www.google.com/search?q=${encodeURIComponent(busca.trim())}`, label: `Google · ${cut(busca.trim(), 40)}` }
      : { url: 'https://www.google.com/', label: 'Google' });
  }

  const unicos = alvos.filter((a, i) => alvos.findIndex((b) => b.url === a.url) === i).slice(0, 5);
  if (!unicos.length) return 'Para onde, Chefe? Abro Zabbix, IXC, Opa!, o sistema NOC, o mapa de uma CTO, uma pesquisa no Google ou um endereço que você disser.';
  for (const a of unicos) t.open(a.url, a.label);
  return [
    `Abrindo ${unicos.map((a) => a.label).join(', ')} em nova guia.`,
    unicos.map((a) => `- [${a.label}](${a.url})`).join('\n'),
    /\b(toca|tocar|toque|coloca|coloque|coloco|bota|poe|play)\b/.test(tx) && /spotify|youtube/.test(tx)
      ? '_A página abre pronta; o play é com você — dar play sozinha exigiria acesso à sua conta de música._'
      : '',
    '_Se o navegador bloquear, libere os pop-ups deste site uma vez (ícone na barra de endereço) ou clique nos links acima._',
  ].filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------------ pesquisa na web e manuais

/** Tira do pedido as palavras de comando e deixa só o assunto. */
function temaDe(original: string): string {
  // "Gere um manual de como fazer X" → "como fazer X" (o "como …" já é o melhor assunto para buscar).
  const comoIdx = original.search(/\bcomo\s/i);
  if (comoIdx >= 0) return original.slice(comoIdx).replace(/\s+(na|pela) (web|internet)\b/gi, '').replace(/[?!.]+$/, '').trim();
  return original
    .replace(/\b(gere|gera|gerar|crie|cria|criar|monte|monta|montar|fa[cç]a|faz|fazer|escreva|me d[eê]|quero|preciso de)\s+(um|uma|o|a)?\s*/gi, '')
    .replace(/\b(manual|guia|tutorial|passo a passo|procedimento|conte[uú]do|artigo|documenta[cç][aã]o)\s*(completo|detalhado|t[eé]cnico)?\s*(de|do|da|dos|das|sobre|para|pra|em|com)?\s*/gi, '')
    .replace(/\b(pesquis[ae]r?|busque|procure|pesquisa)\s*(na|pela)?\s*(web|internet)?\s*(sobre|por|de|a respeito de)?\s*/gi, '')
    .replace(/\b(na|pela) (web|internet)\b/gi, '')
    .replace(/^\s*(o que [eé]|o que significa|explique)\s*/i, '')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trechos da base interna (arquivos enviados) para o assunto, em Markdown. */
function secaoBaseInterna(tema: string, limite = 4): { md: string; n: number; docs: string[] } {
  const hits = kbBuscar(tema, limite).filter((h) => h.score >= 1.2);
  if (!hits.length) return { md: '', n: 0, docs: [] };
  const docs = [...new Set(hits.map((h) => h.nome))];
  return {
    md: ['### Da base interna', hits.map((h) => `- ${cut(h.trecho, 320)} _(${h.nome})_`).join('\n')].join('\n\n'),
    n: hits.length,
    docs,
  };
}

/** "O que diz o manual sobre…", "procure nos documentos…": responde só com a base interna. */
async function base(t: Turn, q: Parsed): Promise<string> {
  const tema0 = temaDe(q.original
    .replace(/\b(na|da|pela) base (de conhecimento|interna)\b/gi, ' ')
    .replace(/\b(procure|busque|pesquise|consulte|veja)\s+(nos|nas|na)\s+(documentos|arquivos|base|pdfs)\b/gi, ' ')
    .replace(/\bo que (diz|fala) o (documento|manual|pdf|arquivo|procedimento)( sobre)?\b/gi, ' ')
    .replace(/\bsegundo o (manual|documento|procedimento|pdf)\b/gi, ' ')
    .replace(/\b(nos|nas) (meus|minhas|nossos|nossas)? ?(documentos|arquivos|pdfs|manuais)( enviados| que (eu )?(mandei|enviei|subi))?\b/gi, ' '));
  const tema = tema0.replace(/^(sobre|a respeito de|de)\s+/i, '').trim();
  if (!temDocumentos()) return 'A base de conhecimento ainda está vazia, Chefe. Envie PDFs, manuais ou procedimentos em "Base e identidade" no menu, e eu passo a usar nas respostas.';
  if (tema.length < 3) return 'Sobre o quê, Chefe? Exemplo: "o que diz o manual sobre troca de ONU?".';
  const r = await t.track('base_conhecimento', { tema }, async () => secaoBaseInterna(tema, 6));
  if (!r.n) return `Não encontrei "${tema}" nos documentos enviados. Quer que eu pesquise na web? É só pedir "pesquise na web sobre ${tema}".`;
  return [`Encontrei ${plural(r.n, 'trecho', 'trechos')} sobre ${tema} em ${plural(r.docs.length, 'documento', 'documentos')} da base interna.`, r.md].join('\n\n');
}

/** "Gere um manual de…", "como configurar…", "pesquise na web sobre…": busca, lê e monta o conteúdo. */
async function pesquisa(t: Turn, q: Parsed): Promise<string> {
  const modo = /\b(manual|passo a passo|tutorial|procedimento)\b|^como /.test(q.texto) ? 'manual' : 'pesquisa';
  // Links ditos na pergunta: a NIA lê exatamente essas páginas ("gere um manual a partir de https://…").
  const links = [...q.original.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((m) => m[0].replace(/[.,;!?)]+$/, ''));
  // Só limpa "a partir deste link/site…" quando há link de verdade (senão "TP-Link" vira "TP-").
  const semLinks = !links.length ? q.original : q.original
    .replace(/https?:\/\/[^\s<>"']+/gi, ' ')
    .replace(/\b(a partir|com base|baseado|usando)\s*(d[aeo]s?|n[aeo]s?|dest[ae]s?|ness[ae]s?|nest[ae]s?)?\b/gi, ' ')
    .replace(/(^|\s)(deste|desse|destes|desses|este|esse|link|links|site|p[aá]gina|url)(?=\s|$|[,.:])/gi, ' ');
  // Com link e sem assunto claro, o título vem da própria página (buildManual).
  const tema = temaDe(semLinks);
  if (modo === 'pesquisa' && !links.length && llmGeral()) return geral(t, q);
  if (tema.length < 3 && !links.length) return 'Sobre o quê, Chefe? Exemplo: "gere um manual de como configurar a ONU Huawei HG8245H" ou "gere um manual a partir de https://…".';
  const buscaLigada = provedorBusca();
  const m = await t.track('web_pesquisa', { tema, modo, links: links.length }, () => buildManual(tema, modo, undefined, links));
  const aviso = !links.length && !buscaLigada
    ? '\n\n> Busca na web desligada: sem uma API de busca configurada eu só consulto a Wikipédia. Para manuais, me passe o link da página (ex.: o manual do fabricante) ou configure `TAVILY_API_KEY` no servidor.'
    : '';
  // A base interna (documentos enviados pela equipe) vem antes do que veio da web.
  const interna = secaoBaseInterna(tema);
  if (!interna.n) return `${m.fala}\n\n${m.markdown}${aviso}`;
  const [titulo, ...resto] = m.markdown.split('\n\n');
  return [
    `${m.fala} Também achei ${plural(interna.n, 'trecho', 'trechos')} nos documentos da equipe (${interna.docs.join(', ')}).`,
    titulo,
    interna.md,
    ...resto,
  ].join('\n\n') + aviso;
}

interface TopoResumo {
  nodes: Array<{ id: string; nome: string; tipo: string; origem: string; status: string; hosts?: string[]; alertas?: string[]; agrupados?: number; local?: string }>;
  links: Array<{ inferido?: boolean }>;
  fonte: string;
  resumo: { equipamentos: number; enlaces: number; inferidos: number; comAlarme: number; hostsZabbix: number; alarmesClientes: number; erros?: string[] };
}

/** Topologia 3D: backbone cadastrado + infraestrutura do Zabbix, com o estado dos alarmes. */
async function topologia(t: Turn): Promise<string> {
  const r = await t.call<TopoResumo>('backbone_topologia', { incluir_zabbix: true });
  if (!r.ok) return `Não consegui montar a topologia: ${r.text}`;
  const g = r.data;
  const s = g.resumo;
  const criticos = g.nodes.filter((n) => n.status === 'critico' && n.origem !== 'virtual');
  const cadastrados = g.nodes.filter((n) => n.origem === 'topologia').length;
  const doZabbix = g.nodes.filter((n) => n.origem === 'zabbix').length;
  const fala = nia.aberturaTopologia() + `Topologia em 3D com ${plural(s.equipamentos, 'equipamento', 'equipamentos')}: ${cadastrados} do backbone cadastrado e ${doZabbix} hosts de infraestrutura do Zabbix, com ${plural(s.enlaces, 'enlace cadastrado', 'enlaces cadastrados')}.`
    + (criticos.length ? ` ${plural(criticos.length, 'está crítico', 'estão críticos')}, como ${criticos.slice(0, 3).map((n) => n.nome).join(', ')}.` : ' Nenhum equipamento crítico agora.')
    + ` O painel 3D já está aberto: arraste para girar e clique num equipamento para ver os detalhes.`;
  return [
    fala,
    criticos.length ? '### Equipamentos com alarme' : '',
    criticos.length ? table(['Equipamento', 'Tipo', 'Origem', 'Alarme'], criticos.slice(0, 15).map((n) => [n.nome, n.tipo, n.origem === 'topologia' ? 'topologia' : 'Zabbix', cut(n.alertas?.[0] ?? '—', 90)])) : '',
    `> ${plural(s.inferidos, 'ligação foi inferida', 'ligações foram inferidas')} pelo local ou pela função do host (tracejadas no 3D): os enlaces dela não estão cadastrados na topologia do NOC. Hosts de cliente (ONUs) não aparecem como nó; há ${plural(s.alarmesClientes, 'alarme de cliente', 'alarmes de cliente')} agora.`,
    `_Fonte: ${g.fonte}._`,
    s.erros?.length ? `> Falhas: ${s.erros.join('; ')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Quem perde conexão com o núcleo se o equipamento cair (busca no grafo de enlaces sem ele). */
async function impacto(t: Turn, q: Parsed, k: Knowledge): Promise<string> {
  const e = q.equipamentos[0];
  if (!e) return 'Qual equipamento? Por exemplo: "se cair o 6730, quem é afetado?".';
  await t.call('backbone_equipamento', { termo: e.id });
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string) => { (adj.get(x) ?? adj.set(x, new Set()).get(x)!).add(y); };
  for (const c of k.conexoes) { link(c.origem, c.destino); link(c.destino, c.origem); }
  const nucleos = k.equipamentos.filter((x) => /n[uú]cleo|core|borda/i.test(String(x.categoria)) && x.id !== e.id).map((x) => x.id);
  const raiz = nucleos[0] ?? k.equipamentos.find((x) => x.id !== e.id)?.id;
  if (!raiz) return 'A topologia não tem equipamentos suficientes para calcular impacto.';
  const vistos = new Set([raiz]);
  const fila = [raiz];
  while (fila.length) {
    const x = fila.shift()!;
    for (const y of adj.get(x) ?? []) if (y !== e.id && !vistos.has(y)) { vistos.add(y); fila.push(y); }
  }
  const afetados = k.equipamentos.filter((x) => x.id !== e.id && !vistos.has(x.id) && adj.has(x.id));
  const vizinhos = [...(adj.get(e.id) ?? [])].map((id) => vizinhoNome(k, id));
  const fala = nia.aberturaImpacto(afetados.length) + (afetados.length
    ? `Se ${e.nome} cair, ${plural(afetados.length, 'equipamento perde', 'equipamentos perdem')} o caminho até o núcleo (${vizinhoNome(k, raiz)}): ${afetados.slice(0, 6).map((x) => x.nome).join(', ')}${afetados.length > 6 ? ' e outros' : ''}.`
    : `Se ${e.nome} cair, nenhum outro equipamento cadastrado fica isolado do núcleo (${vizinhoNome(k, raiz)}) — há caminho alternativo, ou ele está na ponta.`);
  return [
    fala,
    `Vizinhos diretos: ${vizinhos.join(', ') || '—'}.`,
    afetados.length ? table(['Equipamento isolado', 'Modelo', 'Local'], afetados.map((x) => [x.nome, x.modelo ?? '—', x.local ?? '—'])) : '',
    '_Cálculo pelos enlaces cadastrados na topologia; enlaces não cadastrados não entram na conta._',
  ].filter(Boolean).join('\n\n');
}

async function onus(t: Turn, q: Parsed): Promise<string> {
  const busca = q.cliente ?? q.host;
  if (on('noc')) {
    const r = await t.call<{ por_status?: Record<string, number>; total: number; items: Rec[] }>('noc_gpon_clientes', { apenas_problema: !busca, ...(busca ? { busca } : {}), limite: 50 });
    if (r.ok) {
      const items = r.data.items ?? [];
      const fala = busca
        ? `Encontrei ${plural(r.data.total ?? items.length, 'ONU', 'ONUs')} para "${busca}".`
        : `Há ${plural(r.data.total ?? items.length, 'ONU com problema', 'ONUs com problema')} (fora do ar ou sinal pior que menos 27 dBm).`;
      return [fala, counts(r.data.por_status, 'Status'),
        table(['Cliente/ONU', 'OLT', 'PON', 'Status', 'RX (dBm)', 'TX (dBm)'], items.slice(0, 25).map((c) => [c.name ?? c.nome ?? c.serial, c.olt, c.pon, c.status, c.rx_power, c.tx_power]))].join('\n\n');
    }
  }
  // Sem o sistema NOC: alarmes de cliente no Zabbix (LOS, energia, sinal).
  const r = await t.call<{ problems: Problem[] }>('zabbix_problemas', { severidade_minima: 2, limite: 300, ...(busca ? { host: busca } : {}) });
  if (!r.ok) return `Não consegui consultar as ONUs: ${r.text}`;
  const ps = (r.data.problems ?? []).filter((p) => /\blos\b|sinal|dbm|onu|ont|energia|desconect|dying/i.test(p.problema));
  const causas: Record<string, number> = {};
  for (const p of ps) causas[causaCliente(p.problema)] = (causas[causaCliente(p.problema)] ?? 0) + 1;
  return [
    ps.length ? `O Zabbix mostra ${plural(ps.length, 'cliente/ONU com problema', 'clientes/ONUs com problema')} agora.` : 'Nenhuma ONU com alarme no Zabbix agora.',
    ps.length ? counts(causas, 'Causa') : '',
    ps.length ? table(['Cliente', 'Problema', 'Severidade', 'Desde'], ps.slice(0, 20).map((p) => [p.host, cut(p.problema, 80), p.severidade, p.desde])) : '',
    on('noc') ? '' : '_O sinal RX/TX das ONUs vem do sistema NOC, que não está configurado neste servidor; mostrei os alarmes do Zabbix._',
  ].filter(Boolean).join('\n\n');
}

interface OpaResumo {
  total: number; por_status: Record<string, number>; por_setor: Record<string, number>; por_canal: Record<string, number>;
  por_atendente: Array<{ atendente: string; atendimentos: number; finalizados: number; media_min: number | null }>;
  duracao_finalizados_min?: { media: number; mediana: number; p90: number } | null;
  em_aberto: { total: number; por_status: Record<string, number>; mais_antigos: Array<{ protocolo?: unknown; status?: string; setor?: string; atendente?: string; aberto_ha_min: number }> };
}

async function opaResumo(t: Turn, q: Parsed, soFila: boolean): Promise<string> {
  const p = soFila ? { ...q.periodo, from: new Date(Date.now() - 86400_000 * 2), rotulo: 'agora' } : q.periodo;
  const r = await t.call<OpaResumo>('opa_relatorio_atendimentos', { desde: dataSP(p.from), ate: dataSP(p.to), top: 10, ...(q.setor ? { setor: q.setor } : {}) });
  if (!r.ok) return `Não consegui consultar o Opa!: ${r.text}`;
  const a = r.data;
  const ab = a.em_aberto;
  const aguardando = Object.entries(ab.por_status).find(([s]) => /aguard/i.test(s))?.[1] ?? 0;
  const emAtend = Object.entries(ab.por_status).find(([s]) => /em atend/i.test(s))?.[1] ?? 0;
  const antigo = ab.mais_antigos[0];
  const filaFala = `Agora há ${plural(aguardando, 'cliente aguardando', 'clientes aguardando')} e ${plural(emAtend, 'em atendimento', 'em atendimento')} no Opa!${q.setor ? ` (setor ${q.setor})` : ''}.`
    + (antigo ? ` O mais antigo em aberto é o ${antigo.protocolo ?? 'sem protocolo'}${antigo.setor ? `, do ${antigo.setor}` : ''}, há ${dur(antigo.aberto_ha_min)}.` : '');
  const tabelaAntigos = ab.mais_antigos.length
    ? table(['Protocolo', 'Status', 'Setor', 'Atendente', 'Aberto há'], ab.mais_antigos.map((x) => [x.protocolo, x.status, x.setor, x.atendente, dur(x.aberto_ha_min)]))
    : '_Nenhum atendimento em aberto._';
  if (soFila) return [filaFala, counts(ab.por_status, 'Status em aberto'), '### Em aberto há mais tempo', tabelaAntigos, nia.sugestaoFila(aguardando, antigo?.aberto_ha_min)].filter(Boolean).join('\n\n');

  const d = a.duracao_finalizados_min;
  const fala = `${quando(q.periodo)} foram ${plural(a.total, 'atendimento', 'atendimentos')} no Opa!${q.setor ? ` no setor ${q.setor}` : ''}, ${plural(ab.total, 'ainda em aberto', 'ainda em aberto')}.`
    + (d ? ` Os finalizados duraram em média ${dur(d.media)}.` : '');
  return [
    fala,
    '### Por status', counts(a.por_status, 'Status'),
    '### Por setor', counts(a.por_setor, 'Setor'),
    '### Por atendente', table(['Atendente', 'Atendimentos', 'Finalizados', 'Média'], a.por_atendente.slice(0, 10).map((x) => [x.atendente, x.atendimentos, x.finalizados, x.media_min === null ? '—' : dur(x.media_min)])),
    '### Em aberto há mais tempo', tabelaAntigos,
  ].join('\n\n');
}

async function opaProtocolo(t: Turn, q: Parsed): Promise<string> {
  const r = await t.call<{ total?: number; atendimentos?: Rec[]; items?: Rec[] }>('opa_atendimentos', { protocolo: q.protocolo, limite: 5 });
  const lista = (r.data.atendimentos ?? r.data.items ?? []) as Rec[];
  if (!r.ok || !lista.length) return `Não encontrei o protocolo ${q.protocolo} no Opa!.`;
  const a = lista[0];
  return [
    `O protocolo ${a.protocolo} está ${String(a.status ?? '—').toLowerCase()}, no setor ${a.setor ?? '—'}, com ${a.atendente ?? 'nenhum atendente'}. Aberto em ${a.abertura ?? '—'}${a.fim ? `, finalizado em ${a.fim}` : ''}.`,
    table(['Campo', 'Valor'], Object.entries(a).filter(([k]) => !/^id$/.test(k)).map(([k, v]) => [k, cut(v, 120)])),
  ].join('\n\n');
}

async function osIxc(t: Turn, q: Parsed): Promise<string> {
  const r = await t.call<{
    total_os: number; por_status: Record<string, number>; por_assunto: Record<string, number>; por_setor?: Record<string, number>; por_tecnico: Record<string, number>;
    tempo_resolucao_horas?: { finalizadas: number; media: number; mediana: number } | null;
  }>('ixc_relatorio_os', { desde: q.periodo.from.toISOString(), ate: q.periodo.to.toISOString(), top: 10 });
  if (!r.ok) return `Não consegui consultar o IXC: ${r.text}`;
  const o = r.data;
  const assunto = Object.entries(o.por_assunto ?? {}).sort((x, y) => y[1] - x[1])[0];
  const tr = o.tempo_resolucao_horas;
  const fala = `${quando(q.periodo)} foram abertas ${plural(o.total_os, 'ordem de serviço', 'ordens de serviço')} no IXC.`
    + (assunto ? ` O assunto mais comum é ${assunto[0]}, com ${assunto[1]}.` : '')
    + (tr ? ` ${plural(tr.finalizadas, 'foi finalizada', 'foram finalizadas')}, com resolução média de ${tr.media} horas.` : '');
  return [
    fala,
    '### Por status', counts(o.por_status, 'Status'),
    '### Por assunto', counts(o.por_assunto, 'Assunto'),
    '### Por técnico', counts(o.por_tecnico, 'Técnico'),
  ].join('\n\n');
}

const CLIENTE_CAMPOS = /^(id|razao|fantasia|ativo|tipo_pessoa|bairro|cidade|endereco|numero|cep|data_cadastro|status)$/;
const CONTRATO_CAMPOS = /^(id|contrato|status|status_internet|data_ativacao|data_cancelamento|id_vd_contrato|descricao_aux_plano_venda|plano)$/;
const LOGIN_CAMPOS = /^(login|online|ip|mac|onu_mac|ultima_conexao_inicial|ultima_conexao_final|concentrador|id_contrato)$/;

const pickRec = (r: Rec, re: RegExp) => Object.entries(r).filter(([k, v]) => re.test(k) && v !== '' && v !== null && v !== undefined);

async function cliente(t: Turn, q: Parsed): Promise<string> {
  const nome = q.cliente;
  if (!nome) return 'Qual cliente? Diga o nome ou o login, por exemplo: "cliente Maria da Silva".';
  const out: string[] = [];
  let falaIxc = '';
  if (on('ixc')) {
    const r = await t.call<{ total: number; registros: Rec[] }>('ixc_consultar', { recurso: 'cliente', campo: 'razao', valor: nome, operador: 'L', limite: 5 });
    const regs = r.ok ? r.data.registros ?? [] : [];
    if (regs.length) {
      const c = regs[0];
      const id = String(c.id);
      const [contr, logins] = await Promise.all([
        t.call<{ registros: Rec[] }>('ixc_consultar', { recurso: 'cliente_contrato', campo: 'id_cliente', valor: id, limite: 5 }),
        t.call<{ registros: Rec[] }>('ixc_consultar', { recurso: 'radusuarios', campo: 'id_cliente', valor: id, limite: 5 }),
      ]);
      const ctrs = contr.ok ? contr.data.registros ?? [] : [];
      const lgs = logins.ok ? logins.data.registros ?? [] : [];
      const online = lgs.filter((l) => /^s$/i.test(String(l.online))).length;
      falaIxc = `${c.razao ?? nome}${regs.length > 1 ? ` (e mais ${regs.length - 1} com nome parecido)` : ''}: ${plural(ctrs.length, 'contrato', 'contratos')}${ctrs[0] ? ` (${statusIxc(CONTRATO_STATUS, ctrs[0].status)}, ${statusIxc(INTERNET_STATUS, ctrs[0].status_internet)})` : ''}; ${lgs.length ? `${online} de ${lgs.length} logins online agora` : 'nenhum login PPPoE'}.`;
      out.push('### Cadastro (IXC)', table(['Campo', 'Valor'], pickRec(c, CLIENTE_CAMPOS).map(([k, v]) => [k, v])));
      if (ctrs.length) out.push('### Contratos', table(['Contrato', 'Status', 'Internet', 'Ativação'], ctrs.map((x) => [x.id, statusIxc(CONTRATO_STATUS, x.status), statusIxc(INTERNET_STATUS, x.status_internet), x.data_ativacao])));
      if (lgs.length) out.push('### Logins', table(['Login', 'Online', 'IP', 'Última conexão'], lgs.map((x) => [x.login, /^s$/i.test(String(x.online)) ? 'sim' : 'não', x.ip, x.ultima_conexao_inicial])));
      if (regs.length > 1) out.push(`_Outros com nome parecido: ${regs.slice(1).map((x) => x.razao).join('; ')}._`);
    } else falaIxc = `Não achei "${nome}" no cadastro do IXC.`;
  }
  let falaZbx = '';
  if (on('zabbix')) {
    const z = await t.call<{ problems: Problem[] }>('zabbix_problemas', { host: nome, severidade_minima: 1, limite: 20 });
    const ps = z.ok ? z.data.problems ?? [] : [];
    falaZbx = ps.length ? ` No Zabbix: ${cut(ps[0].problema, 140)} desde ${ps[0].desde}.` : ' Nenhum alarme dele no Zabbix agora.';
    if (ps.length) out.push('### Alarmes (Zabbix)', table(['Problema', 'Severidade', 'Desde'], ps.map((p) => [cut(p.problema, 100), p.severidade, p.desde])));
  }
  return [`${falaIxc}${falaZbx}`.trim() || `Não encontrei dados de "${nome}".`, ...out].join('\n\n');
}

async function ftth(t: Turn, q: Parsed): Promise<string> {
  const termo = q.caixa ?? q.original.replace(/^.*?\b(cto|ceo|caixa|splitter|fibra|poste)s?\b\s*/i, '$1 ').replace(/[?!.]+$/, '').trim();
  const r = await t.call<{ caixas?: Array<{ nome: string; tipo?: string; observacao?: string; lat?: number; lon?: number }>; fibras?: Rec[]; pops?: Rec[] }>('ftth_buscar', { termo, limite: 15 });
  const cx = r.data.caixas ?? [];
  if (!r.ok || (!cx.length && !(r.data.fibras ?? []).length)) return `Não encontrei "${termo}" no mapa de fibra.`;
  return [
    `Encontrei ${plural(cx.length, 'caixa', 'caixas')}${(r.data.fibras ?? []).length ? ` e ${plural(r.data.fibras!.length, 'cabo', 'cabos')}` : ''} para "${termo}".`,
    cx.length ? table(['Caixa', 'Tipo', 'Observação', 'Mapa'], cx.map((c) => [c.nome, c.tipo, cut(c.observacao, 110), c.lat && c.lon ? `[abrir](https://www.google.com/maps?q=${c.lat},${c.lon})` : '—'])) : '',
  ].filter(Boolean).join('\n\n');
}

const AJUDA = [
  nia.ajudaIntro(),
  '- **Alarmes agora** — "o que está com alarme alto?", "alarmes na OLT do Casqueiro"',
  '- **Histórico** — "quais hosts mais caíram na semana?", "incidentes de ontem"',
  '- **Relatórios e dashboards** — "relatório de hoje", "dashboard da semana", "painel de atendimentos de ontem" (painel visual com indicadores e gráficos, exportável em PDF)',
  '- **Topologia 3D** — "gere a topologia 3D da rede backbone", "mapa da rede"',
  '- **Perguntas gerais** — "quanto é 15% de 230?", "que horas são?", "quem inventou a fibra óptica?" (pesquiso na web e respondo)',
  '- **Base de conhecimento** — "o que diz o manual sobre troca de ONU?", "procure nos documentos sobre VLAN" (envie PDFs em Base e identidade)',
  '- **Cadastros (com confirmação)** — "cadastre no zabbix o host X com IP 10.0.0.5 no grupo OLTs UpDown", cliente, POP, equipamento ou enlace no sistema NOC',
  '- **Manuais e pesquisa na web** — "gere um manual de como configurar a ONU HG8245H", "pesquise na web sobre GPON"',
  '- **Navegador** — "abre o Zabbix", "abre o IXC e o Opa", "abre o mapa da CTO 366", "pesquisa fibra óptica no Google"',
  '- **Conexões** — "quais aparelhos estão conectados no N8000?", "o que está ligado no 6730?"',
  '- **Backbone** — "como está o NE F1A?", "caminho do F1A até o M8", "se cair o 6730, quem é afetado?"',
  '- **ONUs** — "ONUs com sinal ruim", "clientes em LOS"',
  '- **Atendimento** — "como está a fila do Opa?", "atendimentos de ontem", "protocolo UPD2026…"',
  '- **O.S.** — "O.S. da semana no IXC"',
  '- **Clientes** — "cliente Maria da Silva"',
  '- **Fibra** — "CTO 366", "CEO SP9"',
  '',
  nia.ajudaFim(),
].join('\n');

// ------------------------------------------------------------------ entrada

export async function askNative(sessionId: string, message: string, onEvent: Emit = () => {}): Promise<AssistantReply> {
  const k = await getKnowledge();
  const ctx = contexts.get(sessionId) ?? {};
  contexts.set(sessionId, ctx);
  const q = parse(message, k.equipamentos);

  // Contas e data/hora: respondidas na hora, sem consultar nada.
  const direta = calcular(message) ?? dataHora(message);
  if (direta) return { text: direta, model: NATIVE_LABEL, toolsUsed: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

  // Seguimento: "e ontem?", "e o 6730?", "e na semana?" herdam a intenção anterior.
  const curta = q.texto.split(' ').length <= 6 && /^(e|e o|e a|e no|e na|e do|e da|agora|e agora|mesma coisa|e para|e pro)\b/.test(q.texto);
  // Só herda em continuação curta ("e ontem?"); pergunta solta e desconhecida não herda o assunto.
  const soEntidade = q.intent === 'desconhecido' && (q.equipamentos.length > 0 || q.periodo.explicito || q.severidade !== undefined) && q.texto.split(' ').length <= 6;
  // Cadastro, abrir página e pesquisa nunca são herdados: cada um só acontece quando pedido de novo.
  const naoHerda = ['cadastrar', 'abrir', 'pesquisa', 'base'];
  if (ctx.lastIntent && !naoHerda.includes(ctx.lastIntent) && (curta || soEntidade) && !['saudacao', 'agradecimento', 'ajuda'].includes(q.intent)) {
    const anterior = ctx.last!;
    q.intent = ctx.lastIntent;
    if (!q.equipamentos.length && !q.host && !/\b(geral|tudo|todos)\b/.test(q.texto)) { q.equipamentos = anterior.equipamentos; q.host = anterior.host; }
    if (!q.periodo.explicito) q.periodo = anterior.periodo;
    q.severidade ??= anterior.severidade;
    q.cliente ??= anterior.cliente;
  }
  // Sem intenção clara: decide pela entidade citada.
  if (q.intent === 'desconhecido') {
    if (q.equipamentos.length) q.intent = 'equipamento';
    else if (q.cliente) q.intent = 'cliente';
    else if (q.protocolo) q.intent = 'opa_protocolo';
    else if (q.caixa) q.intent = 'ftth';
    // Nome solto ("na OLT do Casqueiro", "no NE8000") vira alarme; "capital da Austrália" não.
    else if (q.host && (VOCAB_NOC.test(q.texto) || /\d/.test(q.host))) q.intent = 'alarmes';
    // Fora dos sistemas do NOC: pergunta geral (web + modelo, se configurado).
    else q.intent = 'geral';
  }
  // "Como está o tempo?" casa com "como está o…" mas não cita equipamento nenhum.
  if (q.intent === 'equipamento' && !q.equipamentos.length && !q.host && !VOCAB_NOC.test(q.texto)) q.intent = 'geral';
  // "Quem inventou a fibra óptica?": palavra do NOC, mas pergunta de conhecimento geral (sem caixa, equipamento ou host citado).
  if (['ftth', 'onus', 'equipamento', 'conectados', 'os_ixc'].includes(q.intent) && !q.caixa && !q.equipamentos.length && !q.host
    && /^(quem (inventou|criou|descobriu|desenvolveu|foi|e|era)|quando (foi|surgiu|inventaram|criaram|comecou)|por ?que (a|o|as|os) |qual (e |foi )?a (historia|origem|diferenca)|historia d|origem d|diferenca entre)/.test(q.texto)) q.intent = 'geral';
  // Assunto claramente de fora ("o tempo em Santos", "cotação do dólar") vence o nome de um POP citado de passagem.
  if (['equipamento', 'conectados', 'alarmes'].includes(q.intent) && ASSUNTO_GERAL.test(q.texto) && !/\b(alarm|olt|onu|switch|roteador|porta|enlace|link)/.test(q.texto)) q.intent = 'geral';

  const t = new Turn(onEvent);
  t.conversa = sessionId;
  let text: string;
  try {
    text = await responder(t, q, k);
  } catch (e) {
    text = nia.erro(e instanceof Error ? e.message : String(e));
  }
  if (!['saudacao', 'agradecimento', 'ajuda', 'desconhecido'].includes(q.intent)) { ctx.last = q; ctx.lastIntent = q.intent; }
  return { text, model: t.modelo ? `NIA · ${t.modelo} (pergunta geral)` : NATIVE_LABEL, toolsUsed: t.toolsUsed, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

async function responder(t: Turn, q: Parsed, k: Knowledge): Promise<string> {
  switch (q.intent) {
    case 'saudacao': {
      const h = Number(horaLocal(new Date()).slice(11, 13));
      return nia.saudacao(h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite');
    }
    case 'agradecimento': return nia.agradecimento();
    case 'ajuda': return AJUDA;
    case 'relatorio': return relatorio(t, q);
    case 'dashboard': return relatorio(t, q, true);
    case 'alarmes': return on('zabbix') ? alarmes(t, q) : 'O Zabbix não está configurado neste servidor.';
    case 'eventos': return on('zabbix') ? eventos(t, q) : 'O Zabbix não está configurado neste servidor.';
    case 'equipamento': return equipamento(t, q, k);
    case 'conectados': return conectados(t, q, k);
    case 'abrir': return abrir(t, q);
    case 'pesquisa': return pesquisa(t, q);
    case 'cadastrar': return cadastro(q, t.conversa, (a) => t.proposta(a));
    case 'base': return base(t, q);
    case 'caminho': return caminho(t, q, k);
    case 'impacto': return impacto(t, q, k);
    case 'topologia': return topologia(t);
    case 'onus': return onus(t, q);
    case 'opa_fila': return on('opa') ? opaResumo(t, q, true) : 'O Opa! Suite não está configurado neste servidor.';
    case 'opa_resumo': return on('opa') ? opaResumo(t, q, false) : 'O Opa! Suite não está configurado neste servidor.';
    case 'opa_protocolo': return on('opa') ? opaProtocolo(t, q) : 'O Opa! Suite não está configurado neste servidor.';
    case 'os_ixc': return on('ixc') ? osIxc(t, q) : 'O IXC não está configurado neste servidor.';
    case 'cliente': return cliente(t, q);
    case 'ftth': return ftth(t, q);
    case 'geral': return geral(t, q);
    default:
      return `${nia.naoEntendi(cut(q.original, 80))}\n\n${AJUDA.split('\n').slice(1).join('\n')}`;
  }
}

const VOCAB_NOC = /\b(equipamento|porta|interface|olt|onu|ont|switch|roteador|host|enlace|link|modelo|fabricante|backbone|pop|servidor|concentrador|bras|bng|cto|ceo|alarme|sinal|rede|cliente)s?\b/;
const ASSUNTO_GERAL = /\b(previsao do tempo|(como (esta|ta|vai (estar|ficar))|e) o tempo|clima|temperatura|vai chover|chuva|cotacao|dolar|euro|bitcoin|noticias?|placar|jogo d[oe]|horoscopo|receita de|capital d[aoe])\b/;

/** Pergunta de conhecimento geral: pesquisa na web e responde (native/geral.ts). */
async function geral(t: Turn, q: Parsed): Promise<string> {
  const r = await responderGeral(t.conversa, q.original, (name, input, fn) => t.track(name, input, fn));
  if (r.modelo) t.modelo = r.modelo;
  if (r.text) return r.text;
  return `${nia.naoEntendi(cut(q.original, 80))}\n\n${AJUDA.split('\n').slice(1).join('\n')}`;
}

export function resetNative(sessionId: string) {
  resetGeral(sessionId);
  contexts.delete(sessionId);
}
