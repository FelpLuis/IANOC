/**
 * Entendimento da pergunta (NLU) do motor nativo do IA NOC, sem modelo de linguagem.
 *
 * 1. Normaliza o texto (minúsculas, sem acento, sem o prefixo [voz]).
 * 2. Pontua cada intenção por padrões de vocabulário do NOC.
 * 3. Extrai entidades: equipamentos da topologia, período, severidade, host,
 *    cliente, protocolo do Opa! e caixa FTTH.
 *
 * As regras foram escritas para o jeito de perguntar do NOC (alarme, queda, OLT,
 * ONU, O.S., fila, relatório…). Para ensinar uma frase nova, acrescente um padrão
 * na intenção certa em RULES.
 */

import type { Equipamento } from '../knowledge.js';

export type Intent =
  | 'saudacao' | 'ajuda' | 'agradecimento'
  | 'relatorio' | 'dashboard' | 'alarmes' | 'eventos'
  | 'equipamento' | 'conectados' | 'caminho' | 'impacto' | 'topologia' | 'abrir' | 'pesquisa' | 'base' | 'cadastrar'
  | 'onus' | 'opa_fila' | 'opa_resumo' | 'opa_protocolo'
  | 'os_ixc' | 'cliente' | 'ftth' | 'geral'
  | 'desconhecido';

export type PeriodoNome = 'agora' | 'hoje' | 'ontem' | 'semana' | 'mes' | 'horas' | 'dias';
export interface Periodo { nome: PeriodoNome; from: Date; to: Date; rotulo: string; explicito: boolean }

export interface Parsed {
  original: string;
  texto: string;              // normalizado
  voz: boolean;
  intent: Intent;
  confianca: number;          // 0–1
  periodo: Periodo;
  severidade?: number;
  equipamentos: Equipamento[];
  host?: string;
  cliente?: string;
  protocolo?: string;
  caixa?: string;
  setor?: string;
}

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const compact = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');

// ------------------------------------------------------------------ intenções

const RULES: Array<{ intent: Intent; peso?: number; padroes: RegExp[] }> = [
  { intent: 'saudacao', padroes: [/^(oi|ola|opa|bom dia|boa tarde|boa noite|e ai|eai|hey|fala)\b[\s!.,]*((oi|ola|bom dia|boa tarde|boa noite|tudo bem|td bem|beleza|ia noc|noc)[\s!.,?]*)*$/] },
  { intent: 'agradecimento', padroes: [/^(obrigad[oa]|valeu|vlw|show|perfeito|beleza|blz|ok|certo|entendi|otimo)\b[!. ]*$/] },
  { intent: 'ajuda', padroes: [/o que (voce|vc) (faz|sabe|consegue)/, /\bajuda\b/, /como (te )?us(o|ar)/, /quais (comandos|perguntas)/, /^menu$/] },
  // Painel visual (KPIs, gráficos): vence "relatório" quando os dois aparecem.
  { intent: 'dashboard', peso: 5, padroes: [/\bdash ?boards?\b/, /\bpainel (de |da |do )?(indicadores|kpis?|metricas|gerencial|operacional|executivo|visual|da rede|do noc|de alarmes|de atendimentos?|de o\.?s)\b/, /\b(kpis?|indicadores|metricas)\b/, /\bgraficos?\b/] },
  { intent: 'relatorio', peso: 2, padroes: [/relatorio/, /\bresumo (do|de|da|geral)/, /como (foi|esta|ta) (o dia|a semana|o mes|ontem|hoje|o plantao|a noite)/, /balanco/, /panorama/, /visao geral/] },
  { intent: 'eventos', padroes: [/(quais|que) hosts? (mais )?(cai|caiu|cairam|ficou|ficaram)/, /mais (cai|caiu|cairam|quedas|instav)/, /incidentes? (da|na|desta|dessa|do|no|nos|dos) (semana|mes|ultimos|periodo|ontem)/, /historico de (alarm|evento|queda|incidente)/, /(ranking|top) (de )?(hosts?|alarm|queda|evento)/, /eventos? (de|do|da|no|na) (ontem|semana|mes|periodo)/, /quantas quedas/] },
  { intent: 'alarmes', padroes: [/alarm/, /alerta/, /\bproblemas?\b/, /\bincidentes?\b/, /fora do ar/, /\bcaid[oa]s?\b/, /\bcaiu\b/, /\bquedas?\b/, /\bdown\b/, /\boffline\b/, /zabbix/, /o que (esta|ta) (acontecendo|pegando|errado)/, /tem (algo|alguma coisa) (errado|caido|fora)/, /sem (internet|conexao|sinal)/, /\bdesastres?\b/] },
  // Abrir páginas no navegador do operador ("abre o Zabbix", "abre uma guia com o IXC", "pesquisa X no Google").
  // Cadastro (escrita com confirmação): host no Zabbix; cliente, POP, equipamento, enlace no NOC.
  { intent: 'cadastrar', peso: 6, padroes: [/\b(cadastre|cadastrar|cadastra|adicione|adicionar|registre|registrar|inclua|incluir|insira|inserir|crie|criar)\b.{0,40}\b(host|cliente|assinante|pop|data ?center|equipamento|aparelho|olt|switch|roteador|servidor|enlace|link|conexao)\b/, /\b(ligue|conecte)\b.{0,40}\bporta\b.{0,60}\bporta\b/] },
  // Base de conhecimento: arquivos que o operador enviou (noc/kb.ts).
  { intent: 'base', peso: 4.5, padroes: [/\bbase (de conhecimento|interna)\b/, /\b(nos?|nas?) (meus|minhas|nossos|nossas)? ?(documentos|arquivos|pdfs?|manuais) (enviad|que (eu )?(mandei|enviei|subi))/, /\bo que (diz|fala) o (documento|manual|pdf|arquivo|procedimento)\b/, /\bsegundo o (manual|documento|procedimento|pdf)\b/, /\b(procure|busque|pesquise|consulte) (nos|nas|na) (documentos|arquivos|base|pdfs)\b/, /\bnos documentos\b/] },
  // Pesquisa na web e geração de manual/passo a passo (native/../web/manual.ts).
  { intent: 'pesquisa', peso: 3.5, padroes: [/\bmanual\b/, /\bpasso a passo\b/, /\btutorial\b/, /\bprocedimento (para|de)\b/, /\bpesquis[ae]r?\b.{0,40}\b(na|pela) (web|internet)\b/, /\b(busque|procure|pesquise|pesquisa)\b.{0,40}\b(na web|na internet)\b/, /^como (configurar|fazer|instalar|resetar|trocar|criar|liberar|habilitar|desbloquear|atualizar|provisionar|conectar|cadastrar|montar|fusionar|ajustar)\b/, /\bger[ae]r?\b.{0,25}\b(guia|manual|tutorial|conteudo|artigo|documentacao)\b/, /\b(o que e|o que significa|explique)\b/] },
  // "abro" e "coloco" aparecem quando a transcrição de voz erra a pessoa do verbo.
  { intent: 'abrir', peso: 4, padroes: [/\b(toca|tocar|toque|coloca|coloque|coloco|bota|bote|poe|ponha)\b.{0,40}\b(spotify|youtube|musica|playlist)\b/, /^(abr[aeo]|abrir|abre|acess[ae]|acessar|entr[ae] n[oa]|me leva|leva(-me)? (para|pro|pra)|vai (para|pro|pra|no|na)|navega(r)? (para|ate))\b/, /\b(abr[aei]r?|abre)\b.{0,30}\b(guia|aba|janela|pagina|site|link|painel|navegador)\b/, /\b(nova|outra) (guia|aba|janela)\b/, /\bpesquis[ae]r?\b.{0,60}\bno google\b/, /\bgoogle\b.{0,20}\b(pesquis|busc|procur)/] },
  { intent: 'topologia', peso: 3, padroes: [/topologia/, /\bmapa (da|de|do) (rede|backbone|infra)/, /\bdiagrama/, /\b3d\b|tridimensional/, /\b(desenh|mont|ger|mostr|exib|visualiz|ver)\w*\b.*\b(rede|backbone|infraestrutura)\b/, /visao (da|de) (rede|infra)/] },
  { intent: 'caminho', peso: 2, padroes: [/\b(caminho|rota|trajeto|path|saltos?)\b/, /como (chega|vai|passa) (de|do|da)/] },
  { intent: 'impacto', peso: 2, padroes: [/se (cair|parar|desligar|perder)/, /\bimpacto\b/, /quem (perde|depende|fica sem|e afetado)/, /o que depende/, /afetad[oa]s? (se|pela|pelo)/] },
  { intent: 'conectados', peso: 2.5, padroes: [/\b(aparelhos?|equipamentos?|dispositivos?|hosts?|switch(es)?|olts?|quem|o que)\b.{0,25}\b(conectad|ligad|pendurad|plugad|atras d)/, /\bconectad[oa]s? (a|ao|no|na|nos|nas|em)\b/, /\bligad[oa]s? (a|ao|no|na|nos|nas|em)\b/, /\bvizinh/, /\bdownstream\b/, /\babaixo d[oe]\b/] },
  { intent: 'equipamento', padroes: [/\bportas?\b/, /\binterfaces?\b/, /\bmodelo\b/, /\bdetalh/, /\b(informac|info)\b/, /\benlaces?\b/, /\bequipamento\b/, /\bfabricante\b/, /como (esta|ta) (o|a)\b/] },
  { intent: 'onus', padroes: [/\bonus?\b/, /\bonts?\b/, /\bsinal\b/, /\bdbm\b/, /atenuac/, /potencia (optica|de sinal)/, /\blos\b/, /dying ?gasp/, /\bpon\b/] },
  { intent: 'opa_protocolo', peso: 3, padroes: [/\bupd\d{6,}/, /protocolo\s*\d{5,}/] },
  { intent: 'opa_fila', peso: 1.5, padroes: [/\bfila\b/, /aguardando/, /esperando/, /na espera/, /em atendimento agora/, /quantos? (clientes? )?(aguard|esperand)/] },
  { intent: 'opa_resumo', padroes: [/atendimentos?/, /\bopa\b/, /\bchats?\b/, /whatsapp/, /\bsuporte\b/, /\batendentes?\b/] },
  // "os" minúsculo é artigo ("quais são os aparelhos"): a sigla O.S. é checada no texto original, em maiúsculas (ver parse).
  { intent: 'os_ixc', padroes: [/ordem de servico/, /ordens de servico/, /\bchamados?\b/, /visitas? tecnica/, /\btecnicos?\b/, /\bixc\b/, /\bagendad/] },
  { intent: 'cliente', peso: 1.5, padroes: [/\bcliente\s+[a-z0-9]/, /\blogin\s+[a-z0-9]/, /\bcontrato\b/, /\bassinante\b/, /\bpppoe\b/] },
  { intent: 'ftth', peso: 1.5, padroes: [/\bctos?\b/, /\bceos?\b/, /\bcaixas?\b/, /\bsplitter/, /\bfibras?\b/, /\bpostes?\b/, /\bemenda/] },
];

// ------------------------------------------------------------------ período

const SP_OFFSET_H = 3; // America/Sao_Paulo sem horário de verão (UTC-3)

function inicioDoDiaSP(d: Date) {
  const sp = new Date(d.getTime() - SP_OFFSET_H * 3600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate(), SP_OFFSET_H));
}

export function periodoDe(texto: string, agora = new Date()): Periodo {
  const hoje0 = inicioDoDiaSP(agora);
  const h = texto.match(/ultim[ao]s? (\d{1,3}) ?(h|horas?)\b/);
  if (h) return { nome: 'horas', from: new Date(agora.getTime() - Number(h[1]) * 3600_000), to: agora, rotulo: `últimas ${h[1]} horas`, explicito: true };
  if (/ultima hora/.test(texto)) return { nome: 'horas', from: new Date(agora.getTime() - 3600_000), to: agora, rotulo: 'última hora', explicito: true };
  const d = texto.match(/ultim[ao]s? (\d{1,3}) ?dias?/);
  if (d) return { nome: 'dias', from: new Date(hoje0.getTime() - (Number(d[1]) - 1) * 86400_000), to: agora, rotulo: `últimos ${d[1]} dias`, explicito: true };
  if (/\bontem\b/.test(texto)) return { nome: 'ontem', from: new Date(hoje0.getTime() - 86400_000), to: hoje0, rotulo: 'ontem', explicito: true };
  if (/\bsemana\b|7 dias|sete dias/.test(texto)) return { nome: 'semana', from: new Date(hoje0.getTime() - 6 * 86400_000), to: agora, rotulo: 'últimos 7 dias', explicito: true };
  if (/\bmes\b|30 dias|mensal/.test(texto)) {
    const sp = new Date(agora.getTime() - SP_OFFSET_H * 3600_000);
    const from = new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), 1, SP_OFFSET_H));
    return { nome: 'mes', from, to: agora, rotulo: 'este mês', explicito: true };
  }
  if (/\bagora\b|neste momento|no momento|atual/.test(texto)) return { nome: 'agora', from: hoje0, to: agora, rotulo: 'agora', explicito: true };
  return { nome: 'hoje', from: hoje0, to: agora, rotulo: 'hoje', explicito: /\bhoje\b|do dia\b/.test(texto) };
}

// ------------------------------------------------------------------ entidades

function severidadeDe(texto: string): number | undefined {
  if (/desastre/.test(texto)) return 5;
  if (/\b(alta|alto|altos|altas|grave|graves|critic|severo)/.test(texto)) return 4;
  if (/\bmedi[oa]s?\b/.test(texto)) return 3;
  if (/\b(todos|todas|qualquer|tudo)\b/.test(texto)) return 2;
  return undefined;
}

/** Equipamentos da topologia citados (por id ou nome), na ordem em que aparecem. */
export function equipamentosDe(original: string, equipamentos: Equipamento[]): Equipamento[] {
  const texto = norm(original);
  const tokens = texto.split(/[^a-z0-9-]+/).filter(Boolean);
  const achados: Array<{ e: Equipamento; pos: number }> = [];
  for (const e of equipamentos) {
    const id = norm(e.id);
    const nome = norm(e.nome);
    let pos = -1;
    // id exato como palavra (f1a, m8, s6730a…)
    const iTok = tokens.findIndex((t) => t === id || t.replace(/-/g, '') === id.replace(/-/g, ''));
    if (iTok >= 0) pos = texto.indexOf(tokens[iTok]);
    // nome inteiro (ne f1a, ne8000-m8…), com ou sem espaço/hífen
    if (pos < 0 && nome.length >= 3) {
      const p = texto.indexOf(nome);
      if (p >= 0) pos = p;
      else {
        const c = compact(e.nome);
        if (c.length >= 4 && compact(texto).includes(c)) pos = texto.indexOf(nome.split(' ')[0]);
      }
    }
    // número do modelo ("N8000", "NE 8000", "S6750") casa com o nome ou o modelo cadastrado
    if (pos < 0) {
      const numsEq = new Set(norm(`${e.nome} ${e.modelo ?? ''}`).match(/\d{3,5}/g) ?? []);
      const t = tokens.find((tok) => (tok.match(/\d{3,5}/g) ?? []).some((n) => numsEq.has(n)));
      if (t) pos = texto.indexOf(t);
    }
    if (pos >= 0) achados.push({ e, pos });
  }
  // Nome mais específico primeiro quando dois casam na mesma posição (ex.: "6730 • POP Santos" e "6730").
  achados.sort((a, b) => a.pos - b.pos || norm(b.e.nome).length - norm(a.e.nome).length);
  const vistos = new Set<string>();
  let lista = achados.filter(({ e }) => !vistos.has(e.id) && vistos.add(e.id)).map(({ e }) => e);
  // Local citado ("6730 do POP Santos"): fica só quem é daquele local.
  if (lista.length > 1) {
    const palavrasLocal = (e: Equipamento) => norm(`${e.nome} ${e.local ?? ''}`).split(/[^a-z]+/).filter((w) => w.length >= 4 && !/^(core|nucleo|agregacao|distribuicao|transporte)$/.test(w));
    const doLocal = lista.filter((e) => palavrasLocal(e).some((w) => new RegExp(`\\b${w}\\b`).test(texto) && !lista.every((o) => palavrasLocal(o).includes(w))));
    if (doLocal.length) lista = doLocal;
  }
  return lista;
}

const STOP_HOST = /^(o|a|os|as|de|do|da|dos|das|no|na|em|um|uma|que|qual|quais|esta|ta|com|agora|hoje|ontem|alarme|alarmes|problema|problemas|sinal|alto|alta|caido|caida)$/;

/** Host/equipamento citado por nome livre ("na OLT do Casqueiro", "no host NE8000"). */
function hostDe(original: string): string | undefined {
  const m = original.match(/\b(?:olt|host|pop|switch|roteador|equipamento|servidor|concentrador|bras|bng)\s+(?:d[oa]s?\s+|de\s+)?([A-Za-zÀ-ú0-9][\wÀ-ú .-]{1,40}?)(?=[?!.,]|\s+(?:agora|hoje|ontem|esta|está|tem|com)\b|$)/i)
    ?? original.match(/\b(?:no|na|em|do|da)\s+([A-Z0-9][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})/);
  const v = m?.[1]?.trim();
  if (!v || STOP_HOST.test(norm(v)) || v.length < 2) return undefined;
  return v;
}

function clienteDe(original: string): string | undefined {
  const m = original.match(/\b(?:cliente|assinante|login|contrato d[oa])\s+(?:d[oa]\s+)?["“]?([^"”?!]{2,60})/i);
  return m?.[1]?.replace(/\s+(est[aá]|tem|com|agora|hoje|ficou|caiu)\b.*$/i, '').trim();
}

const SETORES = /\b(suporte|financeiro|comercial|vendas|retencao|cobranca|instalacao|tecnico|noc)\b/;

export function parse(message: string, equipamentos: Equipamento[], agora = new Date()): Parsed {
  const voz = /^\s*\[voz\]/i.test(message);
  // Chamar pelo nome ("NIA, como está a rede?", "Ei NIA…") não muda a pergunta; só o nome vira saudação.
  const semVoz = message.replace(/^\s*\[voz\]\s*/i, '').trim();
  const semNome = semVoz.replace(/^(?:(?:ei|oi|ola|olá|ok|hey|fala)\s*,?\s*)?n[ií]a\b[\s,:!.?-]*/i, '').trim();
  const original = semNome || (semVoz ? 'oi' : '');
  const texto = norm(original);

  const scores = new Map<Intent, number>();
  for (const r of RULES) {
    const hits = r.padroes.filter((p) => p.test(texto)).length;
    if (hits) scores.set(r.intent, (scores.get(r.intent) ?? 0) + hits * (r.peso ?? 1));
  }
  const eqs = equipamentosDe(original, equipamentos);
  const host = hostDe(original);
  const cliente = clienteDe(original);
  const protocolo = original.match(/\bUPD\d{6,}\b/i)?.[0]?.toUpperCase();
  const caixa = original.match(/\b(CTO|CEO|caixa)\s*[:#-]?\s*([\w-]{1,12})/i);

  // Ajustes por entidade: dois equipamentos sugerem caminho; um equipamento sem outra
  // intenção forte vira consulta do equipamento.
  if (eqs.length >= 2 && /\b(ate|para|->|e o|e a)\b/.test(texto)) scores.set('caminho', (scores.get('caminho') ?? 0) + 1.5);
  if (eqs.length >= 1) scores.set('equipamento', (scores.get('equipamento') ?? 0) + 1);
  if (cliente && !/clientes/.test(texto)) scores.set('cliente', (scores.get('cliente') ?? 0) + 1);
  // "clientes sem internet", "ONUs caídas": alarme de cliente, não cadastro.
  if (/clientes? (sem|caid|desconect|offline|fora)/.test(texto)) scores.set('alarmes', (scores.get('alarmes') ?? 0) + 2);
  // Relatório pedido junto com um sistema específico continua relatório daquele sistema.
  // Sigla O.S. só em maiúsculas ou com pontos ("OS", "O.S.", "o.s."), para não confundir com o artigo "os".
  if (/\bO\.\s?S\b\.?|\bOS\b|\bO\.S\./.test(original) || /\bo\.s\.?(?=\s|$)/.test(original)) scores.set('os_ixc', (scores.get('os_ixc') ?? 0) + 1);
  if (scores.has('relatorio') && scores.has('os_ixc')) scores.set('os_ixc', (scores.get('os_ixc') ?? 0) + 2);
  if (scores.has('relatorio') && (scores.has('opa_resumo') || scores.has('opa_fila'))) scores.set('opa_resumo', (scores.get('opa_resumo') ?? 0) + 2);
  if (scores.has('relatorio') && scores.has('eventos')) scores.set('eventos', (scores.get('eventos') ?? 0) + 2);

  // "Abre o relatório de hoje" é pedir o relatório, não uma página: abrir só vale com um destino de navegador.
  const destinoNavegador = /\b(zabbix|ixc|opa|sistema|painel do noc|noc|google|maps?|cto|ceo|caixa|grafana|spotify|youtube|whatsapp|zap|gmail|outlook|drive|agenda|calendario|teams|netflix|musica|playlist|https?:|www\.|[\w-]+\.(com|net|org|br)\b|guia|aba|janela|navegador|site|pagina)\b/.test(texto);
  if (scores.has('abrir') && !destinoNavegador) scores.delete('abrir');
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [intent, score] = ranked[0] ?? ['desconhecido', 0];
  const total = ranked.reduce((acc, [, s]) => acc + s, 0) || 1;

  return {
    original,
    texto,
    voz,
    intent: intent as Intent,
    confianca: Math.min(1, score / total),
    periodo: periodoDe(texto, agora),
    severidade: severidadeDe(texto),
    equipamentos: eqs,
    host: eqs.length ? undefined : host,
    cliente,
    protocolo,
    caixa: caixa ? `${caixa[1]} ${caixa[2]}` : undefined,
    setor: texto.match(SETORES)?.[1],
  };
}
