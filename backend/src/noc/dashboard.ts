/**
 * Dashboard do NOC: os mesmos números do relatório (report.ts) organizados para leitura
 * visual — indicadores (KPIs), gráficos e tabelas. O backend só monta a especificação; o
 * navegador desenha (componentes React com SVG) e exporta em HTML/PDF com a identidade.
 *
 * Nada é calculado por modelo de linguagem: cada número vem do Zabbix, do IXC ou do Opa!.
 */

import { randomUUID } from 'node:crypto';
import { horaLocal } from './http.js';

export type Tom = 'ok' | 'atencao' | 'critico' | 'info' | 'marca';
export type Formato = 'numero' | 'duracao_min' | 'horas';

export interface Kpi { id: string; rotulo: string; valor: string; detalhe?: string; tom: Tom; icone: string }
export interface Serie { rotulo: string; valor: number; cor?: string }
export interface Grafico {
  id: string;
  tipo: 'linha' | 'rosca' | 'barras' | 'barras_h';
  grupo: string;
  titulo: string;
  subtitulo?: string;
  formato?: Formato;
  largura?: 1 | 2;
  series: Serie[];
}
export interface Tabela { grupo: string; titulo: string; colunas: string[]; linhas: string[][]; tons?: Array<Tom | undefined> }
export interface Dashboard {
  id: string;
  titulo: string;
  periodo: string;
  intervalo: string;
  geradoEm: string;
  fontes: string[];
  status: { tom: Tom; texto: string };
  resumo?: string;
  kpis: Kpi[];
  graficos: Grafico[];
  tabelas: Tabela[];
  destaques: string[];
  recomendacoes: string[];
  indisponiveis: string[];
  /** O navegador abre em tela cheia ao chegar (pedido explícito de dashboard). */
  abrir?: boolean;
}

// Paleta: cores da UpDown para dados neutros; quente para gravidade.
export const PALETA = ['#12baea', '#a40ae8', '#2a12f0', '#c874f8', '#38e8c6', '#5b8cff', '#f472b6', '#7dd3fc'];
const SEVERIDADE_COR: Record<string, string> = {
  desastre: '#ff2d6f', alta: '#ff7a2f', 'média': '#ffc53d', media: '#ffc53d', 'atenção': '#12baea', atencao: '#12baea', 'informação': '#7c8db5', informacao: '#7c8db5',
};
const ORDEM_SEV = ['desastre', 'alta', 'média', 'atenção', 'informação'];

const n = (v: number) => v.toLocaleString('pt-BR');
const dur = (min: number) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`);
const corta = (s: string, max = 64) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Maiores itens do mapa; com `outros`, o restante vira uma fatia só (a rosca fecha o total real). */
const doMapa = (m: Record<string, number> | undefined, max = 8, outros = false): Serie[] => {
  const tudo = Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]);
  const lista = tudo.slice(0, max).map(([rotulo, valor]) => ({ rotulo: corta(rotulo || '—', 48), valor }));
  const resto = tudo.slice(max).reduce((acc, [, v]) => acc + v, 0);
  if (outros && resto > 0) lista.push({ rotulo: 'outros', valor: resto, cor: '#4a4a78' } as Serie);
  return lista;
};

// Formas mínimas dos dados dos conectores (só o que o dashboard usa).
interface ZRel {
  total_eventos: number; ainda_abertos: number; por_severidade: Record<string, number>;
  hosts_mais_tempo_com_problema: Array<{ host: string; minutos: number; eventos: number }>;
  hosts_mais_eventos: Array<{ host: string; eventos: number; minutos: number; abertos: number }>;
  problemas_mais_frequentes: Array<{ problema: string; eventos: number }>;
  linha_do_tempo?: { passo: 'hora' | 'dia'; pontos: Array<{ rotulo: string; eventos: number }> };
}
interface ZAbertos { total: number; problems: Array<{ severidade: string; host: string; problema: unknown; desde?: string; reconhecido?: boolean }> }
interface IxcRel { total_os: number; por_status: Record<string, number>; por_assunto: Record<string, number>; por_tecnico: Record<string, number>; tempo_resolucao_horas?: { finalizadas: number; media: number; mediana: number } | null }
interface OpaRel {
  total: number;
  em_aberto: { total: number; por_status?: Record<string, number>; mais_antigos: Array<{ protocolo: unknown; status: string; setor: string; atendente: string; aberto_ha_min: number }> };
  por_status: Record<string, number>; por_setor: Record<string, number>; por_canal: Record<string, number>; por_dia: Record<string, number>;
  por_atendente: Array<{ atendente: string; atendimentos: number; finalizados: number; media_min: number | null }>;
  duracao_finalizados_min?: { media: number; mediana: number; p90: number } | null;
}

export function montarDashboard(o: {
  nome: string; from: Date; to: Date; fontes: string[];
  z?: ZRel; a?: ZAbertos; ixc?: IxcRel; opa?: OpaRel;
  indisponiveis: string[]; analise?: string;
}): Dashboard {
  const kpis: Kpi[] = [];
  const graficos: Grafico[] = [];
  const tabelas: Tabela[] = [];
  let gravidade = 0; // 0 ok · 1 atenção · 2 crítico

  // ---------------- Rede (Zabbix)
  if (o.a) {
    const desastres = o.a.problems.filter((p) => p.severidade === 'desastre').length;
    const semAck = o.a.problems.filter((p) => !p.reconhecido).length;
    const tom: Tom = desastres ? 'critico' : o.a.total ? 'atencao' : 'ok';
    gravidade = Math.max(gravidade, desastres ? 2 : o.a.total ? 1 : 0);
    kpis.push({ id: 'criticos', rotulo: 'Alarmes críticos agora', valor: n(o.a.total), detalhe: `${n(desastres)} desastre · ${n(semAck)} sem reconhecimento`, tom, icone: 'siren' });
    if (o.a.problems.length) {
      const ord = [...o.a.problems].sort((x, y) => ORDEM_SEV.indexOf(x.severidade) - ORDEM_SEV.indexOf(y.severidade));
      tabelas.push({
        grupo: 'Rede', titulo: `Alarmes alta/desastre abertos (${n(o.a.total)})`,
        colunas: ['Severidade', 'Host', 'Problema', 'Desde', 'Rec.'],
        linhas: ord.slice(0, 15).map((p) => [p.severidade, corta(p.host, 40), corta(String(p.problema), 90), p.desde ?? '—', p.reconhecido ? 'sim' : 'não']),
        tons: ord.slice(0, 15).map((p) => (p.severidade === 'desastre' ? 'critico' : 'atencao')),
      });
    }
  }
  if (o.z) {
    kpis.push({ id: 'eventos', rotulo: 'Eventos de problema', valor: n(o.z.total_eventos), detalhe: `${n(o.z.ainda_abertos)} ainda abertos`, tom: 'info', icone: 'activity' });
    // Eventos sem host no Zabbix vêm como "?": no indicador, vale o primeiro host de verdade.
    const pior = o.z.hosts_mais_tempo_com_problema.find((h) => h.host && h.host !== '?') ?? o.z.hosts_mais_tempo_com_problema[0];
    if (pior) kpis.push({ id: 'pior', rotulo: 'Tempo somado em problema', valor: dur(pior.minutos), detalhe: `${corta(pior.host, 34)} · ${n(pior.eventos)} eventos`, tom: pior.minutos >= 240 ? 'atencao' : 'info', icone: 'timer' });
    const pts = o.z.linha_do_tempo?.pontos ?? [];
    if (pts.length > 1) {
      graficos.push({
        id: 'z-linha', tipo: 'linha', grupo: 'Rede', largura: 2,
        titulo: 'Eventos ao longo do período', subtitulo: o.z.linha_do_tempo!.passo === 'hora' ? 'por hora' : 'por dia',
        series: pts.map((p) => ({ rotulo: o.z!.linha_do_tempo!.passo === 'hora' ? p.rotulo.slice(11) : `${p.rotulo.slice(8, 10)}/${p.rotulo.slice(5, 7)}`, valor: p.eventos })),
      });
    }
    const sev = ORDEM_SEV.map((s) => ({ rotulo: s, valor: o.z!.por_severidade[s] ?? 0, cor: SEVERIDADE_COR[s] })).filter((s) => s.valor);
    if (sev.length) graficos.push({ id: 'z-sev', tipo: 'rosca', grupo: 'Rede', titulo: 'Eventos por severidade', series: sev });
    if (o.z.hosts_mais_tempo_com_problema.length) {
      graficos.push({
        id: 'z-hosts', tipo: 'barras_h', grupo: 'Rede', titulo: 'Hosts com mais tempo em problema', subtitulo: 'soma da duração dos eventos', formato: 'duracao_min',
        series: o.z.hosts_mais_tempo_com_problema.slice(0, 8).map((h) => ({ rotulo: h.host === '?' ? 'sem host (evento interno)' : corta(h.host, 44), valor: h.minutos })),
      });
    }
    if (o.z.problemas_mais_frequentes.length) {
      graficos.push({
        id: 'z-prob', tipo: 'barras_h', grupo: 'Rede', titulo: 'Problemas mais frequentes',
        series: o.z.problemas_mais_frequentes.slice(0, 7).map((p) => ({ rotulo: corta(p.problema, 56), valor: p.eventos })),
      });
    }
  }

  // ---------------- O.S. (IXC)
  if (o.ixc) {
    const t = o.ixc.tempo_resolucao_horas;
    kpis.push({ id: 'os', rotulo: 'Ordens de serviço', valor: n(o.ixc.total_os), detalhe: t ? `resolução média ${String(t.media).replace('.', ',')} h · ${n(t.finalizadas)} finalizadas` : 'nenhuma finalizada no período', tom: 'marca', icone: 'wrench' });
    const st = doMapa(o.ixc.por_status, 6, true);
    if (st.length) graficos.push({ id: 'ixc-status', tipo: 'rosca', grupo: 'Ordens de serviço', titulo: 'O.S. por status', series: st });
    const as = doMapa(o.ixc.por_assunto, 8);
    if (as.length) graficos.push({ id: 'ixc-assunto', tipo: 'barras_h', grupo: 'Ordens de serviço', titulo: 'O.S. por assunto', series: as });
    const tec = doMapa(o.ixc.por_tecnico, 10);
    if (tec.length) graficos.push({ id: 'ixc-tec', tipo: 'barras', grupo: 'Ordens de serviço', titulo: 'O.S. por técnico', series: tec });
  }

  // ---------------- Atendimento (Opa!)
  if (o.opa) {
    const d = o.opa.duracao_finalizados_min;
    const aberto = o.opa.em_aberto.total;
    gravidade = Math.max(gravidade, aberto >= 10 ? 1 : 0);
    kpis.push({ id: 'atend', rotulo: 'Atendimentos', valor: n(o.opa.total), detalhe: `${n(aberto)} em aberto`, tom: aberto >= 10 ? 'atencao' : 'marca', icone: 'headset' });
    if (d) kpis.push({ id: 'duracao', rotulo: 'Duração mediana', valor: dur(d.mediana), detalhe: `90% em até ${dur(d.p90)}`, tom: 'info', icone: 'clock' });
    const dias = Object.entries(o.opa.por_dia ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (dias.length > 1) graficos.push({ id: 'opa-dia', tipo: 'linha', grupo: 'Atendimento', largura: 2, titulo: 'Atendimentos por dia', series: dias.map(([k, v]) => ({ rotulo: `${k.slice(8, 10)}/${k.slice(5, 7)}`, valor: v })) });
    const setor = doMapa(o.opa.por_setor, 6, true);
    if (setor.length) graficos.push({ id: 'opa-setor', tipo: 'rosca', grupo: 'Atendimento', titulo: 'Atendimentos por setor', series: setor });
    const canal = doMapa(o.opa.por_canal, 6);
    if (canal.length) graficos.push({ id: 'opa-canal', tipo: 'barras', grupo: 'Atendimento', titulo: 'Por canal', series: canal });
    if (o.opa.por_atendente.length) {
      graficos.push({
        id: 'opa-atend', tipo: 'barras_h', grupo: 'Atendimento', titulo: 'Atendimentos por atendente',
        series: o.opa.por_atendente.slice(0, 8).map((r) => ({ rotulo: corta(r.atendente || '—', 36), valor: r.atendimentos })),
      });
    }
    if (o.opa.em_aberto.mais_antigos.length) {
      tabelas.push({
        grupo: 'Atendimento', titulo: 'Em aberto há mais tempo',
        colunas: ['Protocolo', 'Status', 'Setor', 'Atendente', 'Aberto há'],
        linhas: o.opa.em_aberto.mais_antigos.slice(0, 10).map((x) => [String(x.protocolo), x.status, x.setor, x.atendente || '—', dur(x.aberto_ha_min)]),
        tons: o.opa.em_aberto.mais_antigos.slice(0, 10).map((x) => (x.aberto_ha_min >= 1440 ? 'atencao' : undefined)),
      });
    }
  }

  if (o.indisponiveis.length && !kpis.length) gravidade = Math.max(gravidade, 1);

  // Análise (por regras ou pelo modelo): 1º parágrafo vira resumo; os itens viram destaques.
  const linhas = (o.analise ?? '').split('\n').map((l) => l.trim());
  const resumo = linhas.find((l) => l && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('>'))?.replace(/\*\*/g, '');
  const itens = (titulo: RegExp) => {
    const i = linhas.findIndex((l) => /^#{2,4}\s/.test(l) && titulo.test(l));
    if (i < 0) return [];
    const out: string[] = [];
    for (const l of linhas.slice(i + 1)) { if (l.startsWith('#')) break; if (/^[-*]\s+/.test(l)) out.push(l.replace(/^[-*]\s+/, '').replace(/\*\*/g, '')); }
    return out.slice(0, 6);
  };
  const destaques = itens(/aten[cç][aã]o/i);
  const recomendacoes = itens(/recomenda/i);

  const status = gravidade === 2
    ? { tom: 'critico' as const, texto: 'Crítico' }
    : gravidade === 1 ? { tom: 'atencao' as const, texto: 'Atenção' } : { tom: 'ok' as const, texto: 'Operação estável' };

  return {
    id: randomUUID().slice(0, 8),
    titulo: 'Dashboard do NOC',
    periodo: o.nome,
    intervalo: `${horaLocal(o.from).slice(0, 16).replace('T', ' ')} → ${horaLocal(o.to).slice(0, 16).replace('T', ' ')}`,
    geradoEm: horaLocal(new Date()).slice(0, 16),
    fontes: o.fontes,
    status,
    resumo,
    kpis,
    graficos,
    tabelas,
    destaques,
    recomendacoes,
    indisponiveis: o.indisponiveis,
  };
}

/**
 * Dashboard das respostas de alarmes ("o que está com alarme agora?"): indicadores, rosca por
 * severidade, hosts e causas, e a tabela dos alarmes — os mesmos números do Zabbix da resposta.
 */
export function dashboardDeAlarmes(o: {
  problems: Array<{ host: string; problema: string; severidade: string; desde?: string; reconhecido?: boolean }>;
  severidade: string; onde: string; causasClientes: Record<string, number>; losRecentes: number;
}): Dashboard {
  const ps = o.problems;
  const clientes = ps.filter((p) => /^o cliente\b/i.test(p.problema));
  const infra = ps.filter((p) => !/^o cliente\b/i.test(p.problema));
  const desastres = ps.filter((p) => p.severidade === 'desastre').length;
  const semAck = ps.filter((p) => p.reconhecido === false).length;
  const hosts = new Set(infra.map((p) => p.host)).size;
  const tom: Tom = desastres || o.losRecentes >= 5 ? 'critico' : ps.length ? 'atencao' : 'ok';

  const porSev: Record<string, number> = {};
  for (const p of ps) porSev[p.severidade] = (porSev[p.severidade] ?? 0) + 1;
  const porHost: Record<string, number> = {};
  for (const p of infra) porHost[p.host] = (porHost[p.host] ?? 0) + 1;
  const ord = [...ps].sort((x, y) => ORDEM_SEV.indexOf(x.severidade) - ORDEM_SEV.indexOf(y.severidade));

  const graficos: Grafico[] = [];
  const sev = ORDEM_SEV.map((s) => ({ rotulo: s, valor: porSev[s] ?? 0, cor: SEVERIDADE_COR[s] })).filter((s) => s.valor);
  if (sev.length) graficos.push({ id: 'al-sev', tipo: 'rosca', grupo: 'Rede', titulo: 'Alarmes por severidade', series: sev });
  const topHosts = doMapa(porHost, 8);
  if (topHosts.length) graficos.push({ id: 'al-hosts', tipo: 'barras_h', grupo: 'Rede', titulo: 'Hosts com mais alarmes', series: topHosts });
  const causas = doMapa(o.causasClientes, 6);
  if (causas.length) graficos.push({ id: 'al-causas', tipo: 'barras', grupo: 'Clientes', titulo: 'Clientes desconectados por causa', series: causas });

  return {
    id: randomUUID().slice(0, 8),
    titulo: 'Alarmes agora',
    periodo: `severidade ${o.severidade}${o.onde}`,
    intervalo: `situação de ${horaLocal(new Date()).slice(11, 16)}`,
    geradoEm: horaLocal(new Date()).slice(0, 16),
    fontes: ['Zabbix'],
    status: tom === 'critico' ? { tom, texto: 'Crítico' } : tom === 'atencao' ? { tom, texto: 'Atenção' } : { tom, texto: 'Tudo verde' },
    kpis: [
      { id: 'al-total', rotulo: 'Alarmes abertos', valor: n(ps.length), detalhe: `${n(infra.length)} infra · ${n(clientes.length)} clientes`, tom, icone: 'siren' },
      { id: 'al-desastre', rotulo: 'Desastres', valor: n(desastres), detalhe: desastres ? 'prioridade máxima' : 'nenhum agora', tom: desastres ? 'critico' : 'ok', icone: 'activity' },
      { id: 'al-ack', rotulo: 'Sem reconhecimento', valor: n(semAck), detalhe: semAck ? 'alarmes sem dono' : 'todos com responsável', tom: semAck ? 'atencao' : 'ok', icone: 'clock' },
      { id: 'al-hosts', rotulo: 'Hosts de infra afetados', valor: n(hosts), detalhe: infra[0] ? `1º: ${corta(infra[0].host, 30)}` : '—', tom: hosts ? 'info' : 'ok', icone: 'timer' },
      ...(o.losRecentes ? [{ id: 'al-los', rotulo: 'LOS em 30 min', valor: n(o.losRecentes), detalhe: o.losRecentes >= 5 ? 'possível rompimento' : 'clientes', tom: (o.losRecentes >= 5 ? 'critico' : 'atencao') as Tom, icone: 'siren' }] : []),
    ],
    graficos,
    tabelas: ord.length ? [{
      grupo: 'Rede', titulo: `Alarmes (${n(ps.length)})`, colunas: ['Severidade', 'Host', 'Problema', 'Desde', 'Rec.'],
      linhas: ord.slice(0, 15).map((p) => [p.severidade, corta(p.host, 40), corta(p.problema, 90), p.desde ?? '—', p.reconhecido ? 'sim' : 'não']),
      tons: ord.slice(0, 15).map((p) => (p.severidade === 'desastre' ? 'critico' : 'atencao')),
    }] : [],
    destaques: [], recomendacoes: [], indisponiveis: [],
  };
}
