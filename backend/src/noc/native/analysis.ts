/**
 * Análise do relatório do NOC escrita pelo motor nativo, sem modelo de linguagem:
 * regras sobre os números dos sistemas geram o parágrafo de situação (lido em voz
 * alta), os pontos de atenção e as recomendações. Nada é inventado — cada frase sai
 * de um número ou nome que veio do Zabbix, do IXC ou do Opa!.
 */

export interface ZabbixPeriodo {
  total_eventos: number;
  ainda_abertos: number;
  por_severidade: Record<string, number>;
  hosts_mais_tempo_com_problema: Array<{ host: string; eventos: number; minutos: number; abertos?: number }>;
  problemas_mais_frequentes: Array<{ problema: string; eventos: number }>;
}
export interface ZabbixAbertos {
  total: number;
  problems: Array<{ host: string; problema: unknown; severidade: string; desde?: string; reconhecido?: boolean }>;
}
export interface IxcResumo {
  total_os: number;
  por_status: Record<string, number>;
  por_assunto: Record<string, number>;
  tempo_resolucao_horas?: { finalizadas: number; media: number; mediana: number } | null;
}
export interface OpaResumo {
  total: number;
  por_setor: Record<string, number>;
  em_aberto: { total: number; por_status: Record<string, number>; mais_antigos: Array<{ protocolo?: unknown; setor?: string; atendente?: string; aberto_ha_min: number }> };
  duracao_finalizados_min?: { media: number; mediana: number; p90: number } | null;
}

export const dur = (min: number) => {
  if (!Number.isFinite(min)) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return `${Math.floor(h / 24)} dias e ${h % 24} h`;
};

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;
const top = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
const share = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

// Status de O.S. que ainda não terminaram (IXC).
const OS_PARADAS = /aberta|an[aá]lise|encaminhada|assumida|agendada|deslocamento|execu/i;

export function analyzeReport(input: {
  nome: string;
  z?: ZabbixPeriodo;
  a?: ZabbixAbertos;
  o?: IxcResumo;
  opa?: OpaResumo;
  indisponiveis?: string[];
}): string {
  const { nome, z, a, o, opa, indisponiveis = [] } = input;
  const frases: string[] = [];
  const atencao: string[] = [];
  const recomenda: string[] = [];

  // ---------------- situação geral (texto corrido, para ser falado)
  if (z) frases.push(`No período de ${nome}, o Zabbix registrou ${plural(z.total_eventos, 'evento de problema', 'eventos de problema')}, ${plural(z.ainda_abertos, 'ainda aberto', 'ainda abertos')}.`);
  if (a) {
    const desastres = a.problems.filter((p) => p.severidade === 'desastre').length;
    frases.push(a.total
      ? `Neste momento há ${plural(a.total, 'alarme', 'alarmes')} de severidade alta ou desastre${desastres ? `, ${plural(desastres, 'desastre', 'desastres')}` : ''}.`
      : 'Neste momento não há alarmes de severidade alta ou desastre.');
  }
  if (o) {
    const t = o.tempo_resolucao_horas;
    frases.push(`O IXC teve ${plural(o.total_os, 'ordem de serviço', 'ordens de serviço')}${t ? `, ${t.finalizadas} finalizadas com resolução média de ${t.media} horas` : ''}.`);
  }
  if (opa) frases.push(`No Opa! foram ${plural(opa.total, 'atendimento', 'atendimentos')}, com ${plural(opa.em_aberto.total, 'ainda em aberto', 'ainda em aberto')}.`);
  if (!frases.length) frases.push(`Não consegui dados dos sistemas para ${nome}.`);

  // ---------------- Zabbix: alarmes agora
  if (a && a.total) {
    const desastres = a.problems.filter((p) => p.severidade === 'desastre');
    if (desastres.length) {
      const hosts = [...new Set(desastres.map((p) => p.host))].slice(0, 3);
      atencao.push(`**${plural(desastres.length, 'desastre aberto', 'desastres abertos')}**: ${hosts.join(', ')}${desastres.length > hosts.length ? ' e outros' : ''}.`);
      recomenda.push(`Escalar agora os desastres em ${hosts.join(', ')} e confirmar se há equipe de campo acionada.`);
    }
    const semAck = a.problems.filter((p) => p.reconhecido === false).length;
    if (semAck) {
      atencao.push(`${plural(semAck, 'alarme alto/desastre sem reconhecimento', 'alarmes alto/desastre sem reconhecimento')} no Zabbix.`);
      recomenda.push(`Reconhecer os ${semAck} alarmes sem dono no Zabbix e registrar o responsável por cada um.`);
    }
    // Muitos hosts com o mesmo problema ao mesmo tempo = possível causa comum.
    const porProblema = new Map<string, Set<string>>();
    for (const p of a.problems) {
      const chave = String(p.problema).replace(/\b(cliente|host)\s+.+?\s+(está|esta)\b/i, '$1 … $2').replace(/\d+/g, '#');
      porProblema.set(chave, (porProblema.get(chave) ?? new Set()).add(p.host));
    }
    const massa = [...porProblema.entries()].filter(([, hosts]) => hosts.size >= 5).sort((x, y) => y[1].size - x[1].size)[0];
    if (massa) {
      atencao.push(`${massa[1].size} hosts com o mesmo tipo de alarme ao mesmo tempo ("${massa[0].slice(0, 90)}") — possível causa comum.`);
      recomenda.push('Verificar se os hosts afetados compartilham OLT, PON, caixa ou enlace antes de tratar caso a caso.');
    }
  }

  // ---------------- Zabbix: período
  if (z) {
    const pior = z.hosts_mais_tempo_com_problema[0];
    if (pior && pior.minutos >= 60) {
      atencao.push(`${pior.host} ficou ${dur(pior.minutos)} em problema (${plural(pior.eventos, 'evento', 'eventos')}).`);
      recomenda.push(`Abrir análise de causa raiz para ${pior.host}, o host com mais tempo em problema no período.`);
    }
    const freq = z.problemas_mais_frequentes[0];
    if (freq && freq.eventos >= 3) {
      atencao.push(`Problema recorrente: "${freq.problema.slice(0, 100)}" (${freq.eventos} vezes).`);
      recomenda.push('Tratar a recorrência como problema (não incidente): revisar o gatilho e a causa.');
    }
  }

  // ---------------- IXC
  if (o && o.total_os) {
    const paradas = Object.entries(o.por_status).filter(([s]) => OS_PARADAS.test(s)).reduce((acc, [, n]) => acc + n, 0);
    if (paradas && share(paradas, o.total_os) >= 40) {
      atencao.push(`${share(paradas, o.total_os)}% das O.S. do período ainda não foram finalizadas (${paradas} de ${o.total_os}).`);
      recomenda.push('Revisar a fila de O.S. não finalizadas com a coordenação de campo e reagendar as paradas.');
    }
    const assunto = top(o.por_assunto);
    if (assunto && share(assunto[1], o.total_os) >= 30) {
      atencao.push(`O assunto "${assunto[0]}" concentra ${share(assunto[1], o.total_os)}% das O.S. (${assunto[1]}).`);
      recomenda.push(`Cruzar as O.S. de "${assunto[0]}" com os alarmes do Zabbix para achar uma causa em comum.`);
    }
    const t = o.tempo_resolucao_horas;
    if (t && t.media > 24) {
      atencao.push(`Resolução média das O.S. em ${t.media} horas, acima de um dia.`);
      recomenda.push('Identificar as O.S. mais antigas e a etapa em que elas param.');
    }
  }

  // ---------------- Opa!
  if (opa) {
    const antigo = opa.em_aberto.mais_antigos[0];
    if (antigo && antigo.aberto_ha_min >= 60) {
      atencao.push(`Atendimento ${antigo.protocolo ? String(antigo.protocolo) : ''} aberto há ${dur(antigo.aberto_ha_min)}${antigo.setor ? ` (${antigo.setor})` : ''}.`.replace('  ', ' '));
      recomenda.push(`Priorizar os atendimentos em aberto há mais tempo, a começar pelo ${antigo.protocolo ? String(antigo.protocolo) : 'mais antigo'}.`);
    }
    const aguardando = Object.entries(opa.em_aberto.por_status).find(([s]) => /aguard/i.test(s))?.[1] ?? 0;
    if (aguardando >= 5) {
      atencao.push(`${aguardando} clientes aguardando atendimento no Opa!.`);
      recomenda.push('Reforçar o atendimento no horário de pico ou redistribuir entre os setores.');
    }
    const setor = top(opa.por_setor);
    if (setor && opa.total >= 10 && share(setor[1], opa.total) >= 45) {
      atencao.push(`O setor ${setor[0]} recebeu ${share(setor[1], opa.total)}% dos atendimentos.`);
    }
    const d = opa.duracao_finalizados_min;
    if (d && d.p90 >= 120) atencao.push(`10% dos atendimentos finalizados passaram de ${dur(d.p90)}.`);
  }

  for (const i of indisponiveis) atencao.push(`Fonte indisponível — ${i}.`);

  if (!atencao.length) atencao.push('Nenhum ponto crítico nos números do período.');
  if (!recomenda.length) recomenda.push('Manter o monitoramento normal; nenhuma ação extra indicada pelos números.');

  return [
    frases.join(' '),
    '### Pontos de atenção',
    atencao.slice(0, 6).map((x) => `- ${x}`).join('\n'),
    '### Recomendações',
    [...new Set(recomenda)].slice(0, 5).map((x) => `- ${x}`).join('\n'),
  ].join('\n\n');
}
