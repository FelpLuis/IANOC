/**
 * Perguntas gerais (fora dos sistemas do NOC): contas, data e hora, conhecimento geral.
 *
 * - Contas e data/hora: resolvidas aqui mesmo, sem rede ("quanto é 15% de 230?").
 * - Demais perguntas: busca na web (Tavily + Wikipédia) e, se houver um modelo de linguagem
 *   configurado (LLM_API_KEY: Groq, Gemini, OpenRouter, OpenAI ou Ollama local), ele escreve
 *   a resposta a partir dos resultados, citando as fontes. Sem modelo, a resposta é montada
 *   da busca: resposta curta da Tavily, resumo da Wikipédia ou os trechos encontrados.
 *
 * Só a pergunta e os resultados da busca vão para o modelo: nenhum dado da rede, de cliente
 * ou dos sistemas da UpDown sai por aqui.
 */

import { OPENAI_PRESETS } from '../config.js';
import { pesquisarWeb, resumoWikipedia, type SearchResult } from '../web/research.js';
import { horaLocal } from '../http.js';
import { norm } from './nlu.js';
import { NOME, TRATAMENTO, pick } from './persona.js';

// ------------------------------------------------------------------ contas

const NUMEROS: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, mil: 1000,
};

const GATILHO_CONTA = /^(?:me (?:diga|diz|fala|fale)\s+)?(?:quanto (?:e|eh|da|fica|vale|sao|seria)|calcule|calcula|calcular|qual (?:e )?o resultado de|resultado de|fa[cz]a a conta(?: de)?|faz a conta(?: de)?|conta)\s*:?\s*/;

/** Converte a pergunta numa expressão ("quanto é 15% de 230" → "15%*230"); null se não for conta. */
export function expressaoDe(original: string): string | null {
  let s = norm(original.replace(/^\s*\[voz\]\s*/i, '')).replace(/^(?:(?:ei|oi|ok)\s*,?\s*)?nia\b[\s,:!.-]*/, '');
  s = s.replace(/[?!]+/g, ' ').replace(/\s*=\s*$/, '').trim();
  const comGatilho = GATILHO_CONTA.test(s);
  s = s.replace(GATILHO_CONTA, '');
  // Sem "quanto é", data escrita ("10/11", "2026-11-10") não é conta.
  if (!comGatilho && /^\d{1,4}\s*[/-]\s*\d{1,2}(?:\s*[/-]\s*\d{2,4})?$/.test(s)) return null;
  s = s.replace(/\b[a-z]+\b/g, (w) => (w in NUMEROS ? String(NUMEROS[w]) : w));
  s = s.replace(/\b([2-9]0) e ([1-9])\b/g, (_, d, u) => String(Number(d) + Number(u)));
  s = s
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/raiz quadrada (?:de )?/g, '√').replace(/raiz cubica (?:de )?/g, '∛').replace(/raiz (?:de )?/g, '√')
    .replace(/\s*por ?cento/g, '%').replace(/%\s*(?:de|do|da|sobre)\s*/g, '%*')
    .replace(/\s*ao quadrado/g, '^2').replace(/\s*ao cubo/g, '^3')
    .replace(/\belevado (?:a|ao|na)(?: potencia(?: de)?)?\s*/g, '^')
    .replace(/\b(?:multiplicado por|vezes)\b/g, '*').replace(/×/g, '*')
    .replace(/\b(?:dividido por|divido por)\b/g, '/').replace(/÷/g, '/')
    .replace(/\bmais\b/g, '+').replace(/\bmenos\b/g, '-');
  for (let i = 0; i < 2; i++) s = s.replace(/(\d|\))\s*x\s*(\d|\(|√)/g, '$1*$2');
  s = s.replace(/\s+/g, '');
  if (!/\d/.test(s) || !/^[0-9.+\-*/^()%√∛]+$/.test(s) || !/[+\-*/^%√∛]/.test(s)) return null;
  // Sem "quanto é", número negativo solto não é conta.
  if (!comGatilho && /^-?\d+(?:\.\d+)?$/.test(s)) return null;
  return s;
}

/** Avalia a expressão (só números e + - * / ^ % √ ∛ e parênteses), sem eval. */
export function avaliar(expr: string): number {
  let i = 0;
  const peek = () => expr[i];
  const num = (): number => {
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(expr.slice(i));
    if (!m) throw new Error('expressão inválida');
    i += m[0].length;
    return Number(m[0]);
  };
  const primario = (): number => {
    const c = peek();
    if (c === '√') { i++; return Math.sqrt(primario()); }
    if (c === '∛') { i++; return Math.cbrt(primario()); }
    if (c === '(') {
      i++;
      const v = soma();
      if (peek() !== ')') throw new Error('parêntese aberto');
      i++;
      return v;
    }
    return num();
  };
  const posfixo = (): number => { let v = primario(); while (peek() === '%') { i++; v /= 100; } return v; };
  const potencia = (): number => { const b = posfixo(); if (peek() === '^') { i++; return b ** unario(); } return b; };
  const unario = (): number => {
    if (peek() === '-') { i++; return -unario(); }
    if (peek() === '+') { i++; return unario(); }
    return potencia();
  };
  const produto = (): number => {
    let v = unario();
    while (peek() === '*' || peek() === '/') {
      const op = expr[i++];
      const d = unario();
      if (op === '/' && d === 0) throw new Error('divisão por zero');
      v = op === '*' ? v * d : v / d;
    }
    return v;
  };
  const soma = (): number => {
    let v = produto();
    while (peek() === '+' || peek() === '-') { const op = expr[i++]; const d = produto(); v = op === '+' ? v + d : v - d; }
    return v;
  };
  const v = soma();
  if (i < expr.length) throw new Error('expressão inválida');
  if (!Number.isFinite(v)) throw new Error('resultado fora do alcance');
  return v;
}

const numBR = (n: number) => Number(n.toPrecision(12)).toLocaleString('pt-BR', { maximumFractionDigits: 10 });
const exibir = (expr: string) => expr
  .replace(/(\d)\.(\d)/g, '$1,$2')
  .replace(/%\*/g, '% de ')
  .replace(/([+\-*/^])/g, ' $1 ').replace(/\*/g, '×').replace(/\//g, '÷').replace(/\( /g, '(').replace(/\s+/g, ' ').trim();
const falar = (expr: string) => exibir(expr)
  .replace(/×/g, 'vezes').replace(/÷/g, 'dividido por').replace(/\+/g, 'mais').replace(/(^|\s)-\s/g, '$1menos ')
  .replace(/\^/g, 'elevado a').replace(/√/g, 'raiz de ').replace(/∛/g, 'raiz cúbica de ').replace(/%/g, ' por cento').replace(/\s+/g, ' ');

/** Resposta pronta para contas; null se a pergunta não for uma conta. */
export function calcular(original: string): string | null {
  const expr = expressaoDe(original);
  if (!expr) return null;
  try {
    const r = numBR(avaliar(expr));
    const abertura = pick('conta', ['', 'Conta feita: ', `Essa foi rápida, ${TRATAMENTO}: `]);
    return `${abertura}${falar(expr)} dá **${r}**.\n\n\`${exibir(expr)} = ${r}\``;
  } catch (e) {
    return `Não consegui fazer essa conta: ${e instanceof Error ? e.message : String(e)}. Confira a expressão, por exemplo "quanto é (12 + 8) × 3?".`;
  }
}

// ------------------------------------------------------------------ data e hora

export function dataHora(original: string): string | null {
  const t = norm(original.replace(/^\s*\[voz\]\s*/i, '')).replace(/^nia\b[\s,]*/, '');
  if (t.split(' ').length > 8) return null;
  const agora = new Date();
  if (/\b(que|quais) horas?\b|\bhora (certa|atual|agora)\b|\bhorario (atual|agora)\b/.test(t)) {
    return `Agora são **${horaLocal(agora).slice(11, 16)}** (horário de Brasília).`;
  }
  if (/\b(que|qual) (e )?(o )?(dia|data)\b.*\bhoje\b|\bdata de hoje\b|\bhoje e que dia\b|\bque dia e hoje\b|\bdia da semana\b.*\bhoje\b/.test(t)) {
    const d = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(agora);
    return `Hoje é **${d}**.`;
  }
  return null;
}

// ------------------------------------------------------------------ modelo de linguagem (opcional)

interface LlmCfg { baseUrl: string; apiKey: string; model: string; reasoning?: string }

/**
 * Modelo para perguntas gerais. IANOC_GERAL_LLM escolhe o provedor (groq, gemini, openrouter,
 * openai, ollama) ou "nao" para desligar; sem ele, usa LLM_BASE_URL/LLM_PROVIDER ou deduz
 * pelo formato da chave (gsk_ = Groq). Modelo: IANOC_GERAL_MODEL ou LLM_MODEL.
 */
export function llmGeral(): LlmCfg | null {
  const env = (k: string) => (process.env[k] || '').trim();
  const escolha = env('IANOC_GERAL_LLM').toLowerCase();
  if (/^(0|n|nao|não|off|false|no)$/.test(escolha)) return null;
  const apiKey = env('IANOC_GERAL_API_KEY') || env('LLM_API_KEY');
  const porChave = apiKey.startsWith('gsk_') ? 'groq' : apiKey.startsWith('sk-or-') ? 'openrouter' : apiKey.startsWith('AIza') ? 'gemini' : apiKey.startsWith('sk-') ? 'openai' : '';
  const baseUrl = (env('IANOC_GERAL_BASE_URL') || OPENAI_PRESETS[escolha] || env('LLM_BASE_URL') || OPENAI_PRESETS[env('LLM_PROVIDER').toLowerCase()] || OPENAI_PRESETS[porChave] || '').replace(/\/+$/, '');
  const model = env('IANOC_GERAL_MODEL') || env('LLM_MODEL');
  if (!baseUrl || !model || (!apiKey && !baseUrl.includes('127.0.0.1') && !baseUrl.includes('localhost'))) return null;
  return { baseUrl, apiKey, model, reasoning: env('IANOC_GERAL_REASONING') || env('LLM_REASONING_EFFORT') || undefined };
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

async function chat(cfg: LlmCfg, messages: Msg[]): Promise<string> {
  const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: 2048, temperature: 0.4, ...(cfg.reasoning ? { reasoning_effort: cfg.reasoning } : {}) }),
    signal: AbortSignal.timeout(Number(process.env.IANOC_GERAL_TIMEOUT_MS || 45000)),
  });
  if (!r.ok) throw new Error(`modelo respondeu HTTP ${r.status}`);
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const txt = (j.choices?.[0]?.message?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/【(\d+)(?:†[^】]*)?】/g, '[$1]')
    // Lista de fontes que o modelo escreva por conta própria (a NIA põe a dela com os links).
    .replace(/\n+\s*\**fontes?( consultadas)?\**\s*:?[^\n]*(\n\s*[-*\d[][^\n]*)*\s*$/i, '')
    .trim();
  if (!txt) throw new Error('modelo não devolveu texto');
  return txt;
}

const SISTEMA = () => [
  `Você é a ${NOME}, assistente virtual do NOC (Centro de Operações de Rede) da UpDown Internet, um provedor de internet por fibra óptica. Chama o operador de "${TRATAMENTO}" de vez em quando, sem exagero.`,
  'Agora a pergunta é de conhecimento geral (fora dos sistemas do NOC). Responda em português do Brasil, correto e direto, com tom profissional e leve.',
  'A primeira frase deve ser a resposta em si, curta: ela é lida em voz alta. Depois, se ajudar, detalhe em poucos parágrafos ou tópicos em Markdown. Em geral, até 180 palavras, a não ser que peçam mais.',
  'Quando houver resultados de busca, baseie-se neles para fatos recentes ou específicos e cite a fonte com o número entre colchetes, como [1], no meio do texto. Não escreva lista de fontes no final: ela é acrescentada automaticamente. Se os resultados não bastarem e você não tiver certeza, diga isso em vez de inventar.',
  'Nunca invente dados da rede da UpDown (alarmes, clientes, equipamentos, atendimentos): para isso, sugira perguntar direto, como "alarmes agora" ou "relatório de hoje".',
  `Data e hora atuais: ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' }).format(new Date())} (Brasília).`,
].join('\n');

// Pedidos de escrita ou conversa não precisam de busca.
const SEM_BUSCA = /^(escrev|redij|reescrev|crie|cria|elabor|fa[cz]a um|monte um|traduz|resum|corrij|revis|me (conta|conte) uma|conte uma|piada|poema|poesia|sugira|sugest|ideias? (de|para)|como (voce|vc) (esta|ta)|tudo bem)/;

// Conversa das perguntas gerais por sessão (para "e a de 2018?").
const historicos = new Map<string, Msg[]>();
export function resetGeral(sessionId: string) { historicos.delete(sessionId); }

export interface RespostaGeral { text: string; modelo?: string }

type Track = <T>(name: string, input: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;

function listaFontes(fontes: SearchResult[], citadas?: Set<number>): string {
  const usadas = fontes.map((f, i) => ({ f, n: i + 1 })).filter(({ n }) => !citadas || citadas.has(n));
  if (!usadas.length) return '';
  return `**Fontes:** ${usadas.map(({ f, n }) => `[${n}] [${f.title.slice(0, 70)}](${f.url})`).join(' · ')}`;
}

/** Responde uma pergunta geral: busca na web e, com modelo configurado, escreve a resposta. */
export async function responderGeral(sessionId: string, pergunta: string, track: Track): Promise<RespostaGeral> {
  const texto = norm(pergunta);
  const cfg = llmGeral();
  const buscar = !SEM_BUSCA.test(texto) && texto.split(' ').length >= 2;

  let busca: { resposta?: string; results: SearchResult[] } = { results: [] };
  if (buscar) {
    busca = await track('web_pesquisa', { tema: pergunta, modo: 'resposta' }, () => pesquisarWeb(pergunta, 5, !cfg)).catch(() => ({ results: [] }));
  }
  const fontes = busca.results.slice(0, 5);

  if (cfg) {
    const hist = historicos.get(sessionId) ?? [];
    const contexto = fontes.length
      ? `\n\nResultados da busca na web:\n${fontes.map((f, i) => `[${i + 1}] ${f.title} — ${f.url}\n${f.snippet.slice(0, 600)}`).join('\n\n')}`
      : '';
    try {
      const resposta = await track('resposta_geral', { modelo: cfg.model }, () => chat(cfg, [
        { role: 'system', content: SISTEMA() },
        ...hist,
        { role: 'user', content: `${pergunta}${contexto}` },
      ]));
      hist.push({ role: 'user', content: pergunta }, { role: 'assistant', content: resposta });
      historicos.set(sessionId, hist.slice(-8));
      const citadas = new Set([...resposta.matchAll(/\[(\d)\]/g)].map((m) => Number(m[1])));
      const rodape = listaFontes(fontes, citadas.size ? citadas : undefined);
      return { text: rodape ? `${resposta}\n\n${rodape}` : resposta, modelo: cfg.model };
    } catch (e) {
      console.warn(`[nia] pergunta geral sem modelo (${e instanceof Error ? e.message : e}); respondendo pela busca`);
      // Sem modelo agora: cai para a resposta montada da busca.
      if (buscar && !busca.resposta) busca = await pesquisarWeb(pergunta, 5, true).catch(() => busca);
    }
  }

  // Sem modelo: resposta curta da busca, resumo da Wikipédia ou os trechos encontrados.
  if (busca.resposta) return { text: `${busca.resposta}\n\n${listaFontes(fontes.slice(0, 3))}` };
  const wiki = busca.results.find((r) => r.fonte === 'wikipedia');
  if (wiki) {
    const resumo = await resumoWikipedia(wiki.title);
    if (resumo) return { text: `${resumo.split(/(?<=[.!?])\s+/).slice(0, 4).join(' ')}\n\n**Fonte:** [${wiki.title} — Wikipédia](${wiki.url})` };
  }
  if (fontes.length) {
    return {
      text: [
        pick('geralweb', ['Pesquisei na web, Chefe. O que encontrei:', 'Varredura na web concluída. Os trechos mais relevantes:']),
        fontes.slice(0, 4).map((f, i) => `- ${f.snippet.slice(0, 260)} [${i + 1}]`).join('\n'),
        listaFontes(fontes.slice(0, 4)),
      ].join('\n\n'),
    };
  }
  return { text: '' };
}
