/**
 * Relatório operacional do NOC montado no servidor.
 *
 * Os números e as tabelas saem direto dos conectores (Zabbix, IXC, Opa!), sem passar
 * pelo modelo: nada é inventado nem arredondado errado. O modelo só escreve a seção
 * de análise (resumo executivo, pontos de atenção, recomendações) a partir de um
 * resumo pequeno dos mesmos números — o que cabe até na cota gratuita do Groq.
 */

import { connectorEnabled } from './config.js';
import { activeProblems, problemEventsReport } from './connectors/zabbix.js';
import { ixcOsResumo } from './connectors/ixc.js';
import { opaAtendimentosResumo } from './connectors/opa.js';
import { horaLocal } from './http.js';
import { llmComplete } from './llm-complete.js';
import { analyzeReport } from './native/analysis.js';
import { nocConfig } from './config.js';
import { montarDashboard } from './dashboard.js';

export const REPORT_TOOL = 'relatorio_noc';
export type Periodo = 'hoje' | 'ontem' | 'semana' | 'mes' | 'personalizado';
export type Fonte = 'zabbix' | 'ixc' | 'opa';

const DAY = 86400000;
/** Meia-noite em São Paulo (UTC-3, sem horário de verão desde 2019) do dia de `d`. */
const midnightSP = (d: Date) => new Date(`${horaLocal(d).slice(0, 10)}T00:00:00-03:00`);

export function resolvePeriodo(periodo: Periodo, desde?: string, ate?: string) {
  const now = new Date();
  const hoje = midnightSP(now);
  switch (periodo) {
    case 'hoje': return { from: hoje, to: now, nome: `hoje, ${horaLocal(hoje).slice(0, 10)}` };
    case 'ontem': return { from: new Date(hoje.getTime() - DAY), to: hoje, nome: `ontem, ${horaLocal(new Date(hoje.getTime() - DAY)).slice(0, 10)}` };
    case 'semana': return { from: new Date(now.getTime() - 7 * DAY), to: now, nome: 'últimos 7 dias' };
    case 'mes': {
      const first = new Date(`${horaLocal(now).slice(0, 8)}01T00:00:00-03:00`);
      return { from: first, to: now, nome: `mês de ${horaLocal(now).slice(0, 7)}` };
    }
    default: {
      if (!desde) throw new Error('período personalizado precisa de "desde".');
      const parse = (v: string, end = false) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${end ? '23:59:59' : '00:00:00'}-03:00`) : new Date(v);
      const from = parse(desde);
      const to = ate ? parse(ate, true) : now;
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error('período inválido.');
      return { from, to: to > now ? now : to, nome: `${horaLocal(from).slice(0, 16)} a ${horaLocal(to > now ? now : to).slice(0, 16)}` };
    }
  }
}

// ------------------------------------------------------------------ Markdown

const esc = (v: unknown) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return '_Nenhum registro._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}
const fromCounts = (counts: Record<string, number>, header: string) =>
  table([header, 'Qtde'], Object.entries(counts).map(([k, n]) => [k, n]));
const dur = (min: number) => min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
const n = (v: number) => v.toLocaleString('pt-BR');

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };
const settle = async <T>(enabled: boolean, run: () => Promise<T>): Promise<Settled<T> | null> => {
  if (!enabled) return null;
  try { return { ok: true, value: await run() }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
};

export async function buildReport(opts: { periodo: Periodo; desde?: string; ate?: string; fontes?: Fonte[]; analise?: boolean; top?: number }) {
  const { from, to, nome } = resolvePeriodo(opts.periodo, opts.desde, opts.ate);
  const fontes = new Set<Fonte>(opts.fontes?.length ? opts.fontes : ['zabbix', 'ixc', 'opa']);
  const top = opts.top ?? 10;
  const [fromIso, toIso] = [from.toISOString(), to.toISOString()];

  const [zbx, zbxAbertos, ixc, opa] = await Promise.all([
    settle(fontes.has('zabbix') && connectorEnabled('zabbix'), () => problemEventsReport({ desde: fromIso, ate: toIso, minSeverity: 2, top })),
    settle(fontes.has('zabbix') && connectorEnabled('zabbix'), () => activeProblems({ minSeverity: 4, limit: 200 })),
    settle(fontes.has('ixc') && connectorEnabled('ixc'), () => ixcOsResumo(fromIso, toIso, top)),
    settle(fontes.has('opa') && connectorEnabled('opa'), () => opaAtendimentosResumo({ desde: horaLocal(from).slice(0, 10), ate: horaLocal(new Date(to.getTime() - 1)).slice(0, 10) }, top)),
  ]);

  const md: string[] = [];
  const digest: string[] = [`Período: ${nome} (${horaLocal(from).slice(0, 16)} a ${horaLocal(to).slice(0, 16)}).`];
  const indisponiveis: string[] = [];

  // ---------------- Zabbix
  if (fontes.has('zabbix')) {
    md.push('## Rede — Zabbix');
    if (!zbx) indisponiveis.push('Zabbix: não configurado');
    else if (!zbx.ok) { indisponiveis.push(`Zabbix: ${zbx.error}`); md.push(`_Indisponível: ${esc(zbx.error)}_`); }
    else {
      const z = zbx.value;
      md.push(`**${n(z.total_eventos)}** eventos de problema (severidade atenção ou maior) no período, **${n(z.ainda_abertos)}** ainda abertos. Instâncias: ${z.instancias.join(', ')}.`);
      if ('aviso' in z && z.aviso) md.push(`> ${z.aviso}`);
      md.push('### Por severidade', fromCounts(z.por_severidade, 'Severidade'));
      md.push('### Hosts com mais tempo em problema', table(['Host', 'Instância', 'Eventos', 'Tempo em problema', 'Abertos'],
        z.hosts_mais_tempo_com_problema.map((h) => [h.host, h.instancia, h.eventos, dur(h.minutos), h.abertos])));
      md.push('### Hosts com mais eventos', table(['Host', 'Instância', 'Eventos', 'Tempo em problema'],
        z.hosts_mais_eventos.map((h) => [h.host, h.instancia, h.eventos, dur(h.minutos)])));
      md.push('### Problemas mais frequentes', table(['Problema', 'Eventos'], z.problemas_mais_frequentes.map((p) => [p.problema, p.eventos])));
      if (z.erros) md.push(`> Instâncias com erro: ${Object.entries(z.erros).map(([k, v]) => `${k} (${v})`).join('; ')}`);
      digest.push(`Zabbix: ${z.total_eventos} eventos, ${z.ainda_abertos} abertos; severidade ${JSON.stringify(z.por_severidade)}; mais tempo em problema: ${z.hosts_mais_tempo_com_problema.slice(0, 5).map((h) => `${h.host} (${dur(h.minutos)}, ${h.eventos} ev.)`).join('; ')}; problemas frequentes: ${z.problemas_mais_frequentes.slice(0, 5).map((p) => `${p.problema} (${p.eventos})`).join('; ')}.`);
    }
    if (zbxAbertos?.ok) {
      const a = zbxAbertos.value;
      md.push(`### Alarmes alta/desastre abertos agora (${a.total})`, table(['Severidade', 'Host', 'Problema', 'Desde', 'Reconhecido'],
        a.problems.slice(0, 25).map((p) => [p.severidade, p.host, p.problema, p.desde, p.reconhecido ? 'sim' : 'não'])));
      if (a.total > 25) md.push(`_Mais ${a.total - 25} alarmes não listados._`);
      const desastres = a.problems.filter((p) => p.severidade === 'desastre');
      digest.push(`Alarmes alta/desastre abertos agora: ${a.total} (${desastres.length} desastre${desastres.length ? `: ${desastres.slice(0, 4).map((p) => `${p.host} — ${p.problema} desde ${p.desde}`).join('; ')}` : ''}); sem reconhecimento: ${a.problems.filter((p) => !p.reconhecido).length}.`);
    }
  }

  // ---------------- IXC
  if (fontes.has('ixc')) {
    md.push('## Ordens de serviço — IXC');
    if (!ixc) indisponiveis.push('IXC: não configurado');
    else if (!ixc.ok) { indisponiveis.push(`IXC: ${ixc.error}`); md.push(`_Indisponível: ${esc(ixc.error)}_`); }
    else {
      const o = ixc.value;
      const t = o.tempo_resolucao_horas;
      md.push(`**${n(o.total_os)}** O.S. abertas no período.${t ? ` Finalizadas: ${t.finalizadas}, resolução média ${t.media} h (mediana ${t.mediana} h).` : ''}`);
      if (o.aviso) md.push(`> ${o.aviso}`);
      md.push('### Por status', fromCounts(o.por_status, 'Status'));
      md.push('### Por assunto', fromCounts(o.por_assunto, 'Assunto'));
      md.push('### Por técnico', fromCounts(o.por_tecnico, 'Técnico'));
      digest.push(`IXC: ${o.total_os} O.S.; status ${JSON.stringify(o.por_status)}; assuntos ${JSON.stringify(Object.fromEntries(Object.entries(o.por_assunto).slice(0, 5)))}; ${t ? `resolução média ${t.media} h` : 'sem finalizadas'}.`);
    }
  }

  // ---------------- Opa!
  if (fontes.has('opa')) {
    md.push('## Atendimentos — Opa! Suite');
    if (!opa) indisponiveis.push('Opa! Suite: não configurado');
    else if (!opa.ok) { indisponiveis.push(`Opa! Suite: ${opa.error}`); md.push(`_Indisponível: ${esc(opa.error)}_`); }
    else {
      const a = opa.value;
      const d = a.duracao_finalizados_min;
      md.push(`**${n(a.total)}** atendimentos abertos no período, **${n(a.em_aberto.total)}** ainda em aberto.${d ? ` Duração dos finalizados: média ${dur(d.media)}, mediana ${dur(d.mediana)}, 90% em até ${dur(d.p90)}.` : ''}`);
      if ('aviso' in a && a.aviso) md.push(`> ${a.aviso}`);
      md.push('### Por status', fromCounts(a.por_status, 'Status'));
      md.push('### Por setor', fromCounts(a.por_setor, 'Setor'));
      md.push('### Por canal', fromCounts(a.por_canal, 'Canal'));
      if (Object.keys(a.por_dia).length > 1) md.push('### Por dia', fromCounts(a.por_dia, 'Dia'));
      md.push('### Por atendente', table(['Atendente', 'Atendimentos', 'Finalizados', 'Média'],
        a.por_atendente.map((r) => [r.atendente, r.atendimentos, r.finalizados, r.media_min === null ? '—' : dur(r.media_min)])));
      if (a.em_aberto.mais_antigos.length) {
        md.push('### Em aberto há mais tempo', table(['Protocolo', 'Status', 'Setor', 'Atendente', 'Aberto há'],
          a.em_aberto.mais_antigos.map((x) => [x.protocolo, x.status, x.setor, x.atendente, dur(x.aberto_ha_min)])));
      }
      digest.push(`Opa!: ${a.total} atendimentos, ${a.em_aberto.total} em aberto ${JSON.stringify(a.em_aberto.por_status)}; por setor ${JSON.stringify(a.por_setor)}; ${d ? `duração mediana ${dur(d.mediana)}, p90 ${dur(d.p90)}` : ''}; mais antigo em aberto há ${a.em_aberto.mais_antigos[0] ? dur(a.em_aberto.mais_antigos[0].aberto_ha_min) : '—'}.`);
    }
  }

  if (indisponiveis.length) {
    md.push('## Fontes indisponíveis', indisponiveis.map((i) => `- ${i}`).join('\n'));
    digest.push(`Fontes indisponíveis: ${indisponiveis.join('; ')}.`);
  }

  // ---------------- análise escrita pelo modelo (opcional; o relatório vale sem ela)
  let analise = '';
  const nativa = () => analyzeReport({
    nome,
    z: zbx?.ok ? zbx.value : undefined,
    a: zbxAbertos?.ok ? zbxAbertos.value : undefined,
    o: ixc?.ok ? ixc.value : undefined,
    opa: opa?.ok ? opa.value : undefined,
    indisponiveis,
  });
  // Motor nativo: análise por regras, sem modelo de linguagem.
  if (opts.analise !== false && nocConfig.llm.provider === 'nativo') analise = nativa();
  else if (opts.analise !== false) {
    try {
      analise = await llmComplete(
        'Você é analista sênior do NOC da UpDown Internet (provedor FTTH). Escreva em português do Brasil, direto. Use SOMENTE os números do resumo recebido; não invente nenhum número, host ou nome. Formato exato:\nUm parágrafo de 2 a 4 frases, sem Markdown, com a situação geral (será lido em voz alta).\n\n### Pontos de atenção\n- 3 a 5 itens\n\n### Recomendações\n- 3 a 5 itens objetivos',
        digest.join('\n'),
        900,
      );
    } catch (e) {
      // Modelo externo fora do ar: a análise por regras assume.
      analise = nativa();
      console.warn('[relatório] análise do modelo falhou, usando a nativa:', e instanceof Error ? e.message : e);
    }
  }

  const titulo = `# Relatório operacional do NOC — ${nome}`;
  const rodape = `---\n_Gerado em ${horaLocal(new Date())} (horário de Brasília) a partir de ${[...fontes].join(', ')}. Números lidos diretamente dos sistemas; a análise foi gerada pelo IA NOC com base neles._`;
  const NOMES: Record<Fonte, string> = { zabbix: 'Zabbix', ixc: 'IXC', opa: 'Opa! Suite' };
  return {
    markdown: [titulo, analise, ...md, rodape].filter(Boolean).join('\n\n'),
    resumo: digest.join('\n'),
    // Mesmos números, organizados para o painel visual (não vai para o modelo de linguagem).
    dashboard: montarDashboard({
      nome, from, to, fontes: [...fontes].map((f) => NOMES[f]),
      z: zbx?.ok ? zbx.value : undefined,
      a: zbxAbertos?.ok ? zbxAbertos.value : undefined,
      ixc: ixc?.ok ? ixc.value : undefined,
      opa: opa?.ok ? opa.value : undefined,
      indisponiveis, analise,
    }),
  };
}

/** Lê o relatório pronto de um resultado da ferramenta relatorio_noc (ou null). */
export function extractReport(toolText: string): { markdown: string; resumo: string } | null {
  try {
    const parsed = JSON.parse(toolText);
    return typeof parsed?.markdown === 'string' ? parsed : null;
  } catch { return null; }
}
