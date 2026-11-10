/**
 * Assistente NOC com modelos no formato OpenAI (chat/completions com ferramentas).
 *
 * Cobre as opções gratuitas: Ollama (modelo local, sem chave, nada sai da rede),
 * Groq, Google Gemini e OpenRouter (nuvem, com cota gratuita e chave própria).
 * Mesmo loop do assistant.ts: ferramentas em paralelo, eventos por WebSocket,
 * última rodada sem ferramentas.
 *
 * O Ollama usa a API nativa (/api/chat) porque só ela aceita num_ctx: na
 * compatível com OpenAI o contexto fica no padrão do servidor (4096 tokens) e
 * o prompt do NOC seria cortado sem aviso.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { nocConfig } from './config.js';
import { availableTools, runTool } from './tools.js';
import { nowSaoPaulo, systemPrompt } from './prompt.js';
import type { AssistantEvent, AssistantReply } from './assistant.js';
import { extractReport, REPORT_TOOL } from './report.js';
import { extractDevices } from './devices.js';

// raw guarda a chamada como o provedor mandou: o Gemini 3 exige de volta campos
// extras (assinatura de raciocínio) na rodada seguinte.
interface ToolCall { id: string; name: string; args: unknown; raw?: Record<string, any> }

type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

interface ModelTurn { text: string; toolCalls: ToolCall[]; truncated: boolean; input: number; output: number; model: string }

const cfg = nocConfig.openai;
const isOllama = () => cfg.provider === 'ollama';
const histories = new Map<string, Msg[]>();

export function openAiConfigured(): boolean {
  return Boolean(cfg.baseUrl && cfg.model && (isOllama() || cfg.apiKey));
}

export function resetOpenAiConversation(sessionId: string) {
  histories.delete(sessionId);
}

/** Primeira frase, até `max` caracteres: as descrições completas custam ~1/3 do limite do Groq. */
function shorten(text: string, max: number): string {
  const first = text.split(/(?<=[.!?])\s/)[0];
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
}

function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema as Record<string, unknown>)
    .filter(([k]) => k !== 'additionalProperties')
    .map(([k, v]) => [k, k === 'description' && typeof v === 'string' ? shorten(v, 90) : compactSchema(v)]));
}

let toolsCache: { compact: boolean; list: ReturnType<typeof buildTools> } | null = null;
function buildTools(compact: boolean) {
  return availableTools().map((t) => ({
    type: 'function' as const,
    function: compact
      ? { name: t.name, description: shorten(t.description ?? '', 220), parameters: compactSchema(t.input_schema) }
      : { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}
function tools() {
  if (!toolsCache || toolsCache.compact !== cfg.compactPrompt) toolsCache = { compact: cfg.compactPrompt, list: buildTools(cfg.compactPrompt) };
  return toolsCache.list;
}

/**
 * Tamanho máximo da resposta que cabe no limite por minuto (LLM_TPM_LIMIT): o Groq soma
 * o prompt estimado com max_tokens e recusa o pedido inteiro se passar do limite.
 */
function maxTokensFor(system: string, messages: unknown[]): number {
  if (!cfg.tpmLimit) return cfg.maxTokens;
  const chars = system.length + JSON.stringify(messages).length + JSON.stringify(tools()).length;
  // ~3,3 caracteres por token medido no prompt do NOC; margem para a contagem do provedor.
  const estimate = Math.ceil(chars / 3.3) + 500;
  const max = Math.max(600, Math.min(cfg.maxTokens, cfg.tpmLimit - estimate));
  if (process.env.LLM_DEBUG) console.log(`[llm] prompt ~${estimate} tokens, max_tokens ${max}`);
  return max;
}

// Modelos de raciocínio (Qwen3, DeepSeek-R1...) devolvem o pensamento no texto.
const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw || '{}'); } catch { return { __argumentos_invalidos: raw }; }
}

async function post(url: string, body: unknown, waited = { left: cfg.rateLimitWaitMs }): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    const motivo = error instanceof Error && error.name === 'TimeoutError'
      ? `o modelo não respondeu em ${Math.round(cfg.timeoutMs / 1000)} s`
      : `sem conexão com ${cfg.baseUrl}${isOllama() ? ' (o Ollama está aberto?)' : ''}`;
    throw new Error(`${cfg.provider}: ${motivo}.`);
  }
  const text = await res.text();
  if (res.status === 413 || (res.status === 400 && /request too large|tokens per minute/i.test(text))) {
    const [, limit, requested] = text.match(/Limit (\d+), Requested (\d+)/i) ?? [];
    console.warn(`[llm] pedido acima do limite por minuto: ${text.slice(0, 300)}`);
    throw new Error(`${cfg.provider}: a pergunta ficou maior que o limite por minuto da cota gratuita${limit ? ` (${requested} de ${limit} tokens)` : ''}. Comece uma conversa nova (o histórico conta) ou peça um período menor.`);
  }
  if (res.status === 429) {
    // Limite por minuto: o provedor diz quanto esperar (cabeçalho ou texto "try again in 12.3s").
    const header = Number(res.headers.get('retry-after'));
    const fromText = Number(text.match(/try again in (?:(\d+)m)?([\d.]+)s/i)?.slice(1).reduce((s, v, i) => s + (Number(v) || 0) * (i === 0 ? 60 : 1), 0));
    const waitMs = Math.ceil((Number.isFinite(header) && header > 0 ? header : fromText || 0) * 1000) + 500;
    if (waitMs > 500 && waitMs <= waited.left) {
      waited.left -= waitMs;
      await new Promise((r) => setTimeout(r, waitMs));
      return post(url, body, waited);
    }
    throw new Error(`${cfg.provider}: limite da cota gratuita atingido. Aguarde ${waitMs > 500 ? `uns ${Math.ceil(waitMs / 1000)} s` : 'alguns minutos'} e pergunte de novo.`);
  }
  if (res.status === 403 && /free tier is not available|billing/i.test(text)) {
    throw new Error(`${cfg.provider}: o Google não libera a cota gratuita para o projeto desta chave. Ative o faturamento em https://aistudio.google.com/billing ou troque LLM_PROVIDER no .env.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${cfg.provider}: chave recusada (HTTP ${res.status}). Confira LLM_API_KEY no .env.`);
  if (!res.ok) throw new Error(`${cfg.provider}: HTTP ${res.status} — ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${cfg.provider}: resposta inválida.`); }
}

/**
 * POST em fluxo (NDJSON) ao Ollama, juntando os pedaços numa resposta só.
 *
 * Usa node:http e não fetch: o Ollama só manda o cabeçalho quando termina de ler
 * o prompt, e o fetch do Node desiste após 300 s sem cabeçalho. Em CPU a
 * primeira leitura do prompt do NOC passa de 10 min; o teto aqui é LLM_TIMEOUT_MS.
 */
function postOllamaStream(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const out: any = { message: { content: '', tool_calls: [] as unknown[] } };
    let buffer = '';
    let failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; clearTimeout(timer); req.destroy(); reject(error); } };
    const take = (line: string) => {
      if (!line.trim()) return;
      let chunk: any;
      try { chunk = JSON.parse(line); } catch { return fail(new Error(`${cfg.provider}: resposta inválida.`)); }
      if (chunk.error) return fail(new Error(`${cfg.provider}: ${chunk.error}`));
      out.message.content += chunk.message?.content ?? '';
      if (chunk.message?.tool_calls?.length) out.message.tool_calls.push(...chunk.message.tool_calls);
      if (chunk.done) Object.assign(out, { model: chunk.model, done_reason: chunk.done_reason, prompt_eval_count: chunk.prompt_eval_count, eval_count: chunk.eval_count });
    };

    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.setEncoding('utf8');
      if ((res.statusCode ?? 500) >= 400) {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => fail(new Error(`${cfg.provider}: HTTP ${res.statusCode} — ${text.slice(0, 300)}`)));
        return;
      }
      res.on('data', (d: string) => {
        buffer += d;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(take);
      });
      res.on('end', () => {
        take(buffer);
        if (!failed) { clearTimeout(timer); resolve(out); }
      });
      res.on('error', fail);
    });
    const timer = setTimeout(
      () => fail(new Error(`${cfg.provider}: o modelo não respondeu em ${Math.round(cfg.timeoutMs / 1000)} s.`)),
      cfg.timeoutMs,
    );
    req.on('error', (error) => fail(new Error(`${cfg.provider}: sem conexão com ${cfg.baseUrl} (o Ollama está aberto?) — ${error.message}`)));
    req.end(JSON.stringify(body));
  });
}

/** Formato OpenAI: Groq, Gemini, OpenRouter, OpenAI, LM Studio, vLLM... */
async function callOpenAi(system: string, history: Msg[], withTools: boolean): Promise<ModelTurn> {
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls.length ? {
          tool_calls: m.toolCalls.map((c) => ({
            ...c.raw,
            id: c.id,
            type: 'function',
            function: { ...c.raw?.function, name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        } : {}),
      };
    }),
  ];
  const data = await post(`${cfg.baseUrl}/chat/completions`, {
    model: cfg.model,
    messages,
    max_tokens: maxTokensFor(system, messages),
    temperature: 0.2,
    tools: tools(),
    tool_choice: withTools ? 'auto' : 'none',
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
  });
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new Error(`${cfg.provider}: resposta sem conteúdo.`);
  return {
    text: stripThinking(String(choice.message.content ?? '')),
    toolCalls: withTools
      ? (choice.message.tool_calls ?? []).map((c: any) => ({ id: c.id || randomUUID(), name: c.function?.name, args: parseArgs(c.function?.arguments), raw: c }))
      : [],
    truncated: choice.finish_reason === 'length',
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
    model: data.model || cfg.model,
  };
}

/** API nativa do Ollama. */
async function callOllama(system: string, history: Msg[], withTools: boolean): Promise<ModelTurn> {
  const base = cfg.baseUrl.replace(/\/v1$/, '');
  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      if (m.role === 'tool') return { role: 'tool', tool_name: m.name, content: m.content };
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })) } : {}),
      };
    }),
  ];
  const data = await postOllamaStream(`${base}/api/chat`, {
    model: cfg.model,
    messages,
    stream: true,
    think: cfg.ollamaThink,
    // Mantém o modelo e o prompt já processado na memória entre perguntas.
    keep_alive: cfg.ollamaKeepAlive,
    // Na última rodada as ferramentas saem da lista: o Ollama não tem tool_choice.
    ...(withTools ? { tools: tools() } : {}),
    options: { num_ctx: cfg.ollamaNumCtx, num_predict: cfg.maxTokens, temperature: 0.2 },
  });
  if (!data?.message) throw new Error(`${cfg.provider}: resposta sem conteúdo.`);
  return {
    text: stripThinking(String(data.message.content ?? '')),
    toolCalls: (data.message.tool_calls ?? []).map((c: any) => ({ id: randomUUID(), name: c.function?.name, args: parseArgs(c.function?.arguments) })),
    truncated: data.done_reason === 'length',
    input: data.prompt_eval_count ?? 0,
    output: data.eval_count ?? 0,
    model: data.model || cfg.model,
  };
}

/** Corta o histórico só em mensagem de usuário, para nunca separar chamada de ferramenta do resultado. */
function trimHistory(history: Msg[]) {
  const starts = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const excess = starts.length - nocConfig.llm.maxHistoryTurns;
  if (excess > 0) history.splice(0, starts[excess]);
}

export async function askOpenAiCompatible(
  sessionId: string,
  userMessage: string,
  onEvent: (event: AssistantEvent) => void = () => {},
): Promise<AssistantReply> {
  if (!openAiConfigured()) {
    throw new Error(`LLM_PROVIDER=${cfg.provider}: falta ${!cfg.model ? 'LLM_MODEL' : !cfg.baseUrl ? 'LLM_BASE_URL' : 'LLM_API_KEY'} em backend/.env.`);
  }
  const history = histories.get(sessionId) ?? [];
  histories.set(sessionId, history);
  const before = history.length;
  try {
    const reply = await runTurn(history, userMessage, onEvent);
    trimHistory(history);
    return reply;
  } catch (error) {
    history.splice(before);
    throw error;
  }
}

async function runTurn(history: Msg[], userMessage: string, onEvent: (event: AssistantEvent) => void): Promise<AssistantReply> {
  if (cfg.compactPrompt) {
    // Resultados de ferramenta de perguntas anteriores voltariam a cada chamada e estourariam
    // o limite por minuto; a resposta final de cada pergunta já resume o que importava.
    for (const m of history) if (m.role === 'tool' && m.content.length > 300) m.content = `${m.content.slice(0, 300)}… [resultado antigo resumido]`;
  }
  history.push({ role: 'user', content: `[Agora: ${nowSaoPaulo()} (America/Sao_Paulo)]\n\n${userMessage}` });
  const system = await systemPrompt({ compact: cfg.compactPrompt });
  // LLM_TOOL_RESULT_MAX_CHARS é o orçamento da rodada inteira, dividido entre as chamadas paralelas.
  const cap = (text: string, calls: number) => {
    if (!cfg.toolResultMaxChars) return text;
    const max = Math.max(1500, Math.floor(cfg.toolResultMaxChars / calls));
    return text.length <= max ? text
      : `${text.slice(0, max)}\n[CORTADO: ${text.length} caracteres, mostrados ${max}. Use filtros, período menor ou "top" menor para ver o resto.]`;
  };
  const call = isOllama() ? callOllama : callOpenAi;
  const toolsUsed: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model = cfg.model;

  for (let round = 0; round <= nocConfig.llm.maxToolRounds; round++) {
    const lastRound = round === nocConfig.llm.maxToolRounds;
    const turn = await call(system, history, !lastRound);
    model = turn.model;
    usage.input += turn.input;
    usage.output += turn.output;
    history.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });

    if (turn.toolCalls.length === 0) {
      let text = turn.text;
      if (turn.truncated) text += '\n\n_(resposta cortada pelo limite de tamanho — peça a continuação)_';
      return { text: text || '_(sem resposta)_', model, toolsUsed, usage };
    }

    const reports: string[] = [];
    const results = await Promise.all(
      turn.toolCalls.map(async (c) => {
        const started = Date.now();
        onEvent({ type: 'tool_start', id: c.id, name: c.name, input: c.args });
        const { text, isError, data } = await runTool(c.name, c.args);
        const devices = isError ? [] : await extractDevices(c.name, c.args, data);
        const topology = !isError && c.name === 'backbone_topologia' ? data : undefined;
        onEvent({ type: 'tool_end', id: c.id, name: c.name, ok: !isError, ms: Date.now() - started, ...(devices.length ? { devices } : {}), ...(topology ? { topology } : {}) });
        toolsUsed.push(c.name);
        const report = !isError && c.name === REPORT_TOOL ? extractReport(text) : null;
        if (report) reports.push(report.markdown);
        // O relatório vai inteiro para o usuário; no histórico fica só o resumo dos números.
        return { role: 'tool' as const, toolCallId: c.id, name: c.name, content: isError ? `ERRO: ${text}` : report ? report.resumo : cap(text, turn.toolCalls.length) };
      }),
    );
    history.push(...results);
    if (reports.length) {
      const text = reports.join('\n\n---\n\n');
      history.push({ role: 'assistant', content: '[Relatório entregue ao usuário, com os números do resumo acima.]', toolCalls: [] });
      return { text, model, toolsUsed, usage };
    }
  }

  return { text: 'Atingi o limite de consultas nesta pergunta sem concluir. Refine o pedido (equipamento, cliente ou período).', model, toolsUsed, usage };
}
