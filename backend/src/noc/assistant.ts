/**
 * Assistente virtual do NOC: modelo de linguagem + ferramentas de leitura dos ambientes do provedor.
 *
 * LLM_PROVIDER escolhe o modelo: "anthropic" (Claude, padrão) usa este arquivo;
 * ollama, groq, gemini, openrouter ou openai usam assistant-openai.ts (formato
 * OpenAI, com opções gratuitas). As ferramentas e as instruções são as mesmas.
 *
 * Loop manual (e não o tool runner) porque cada chamada de ferramenta é
 * repassada ao navegador por WebSocket enquanto acontece — o operador vê
 * "consultando Zabbix…" em vez de uma espera muda.
 *
 * Cache de prompt: ferramentas → system (identidade + resumo do backbone) são
 * estáveis e ficam em cache; data/hora vai na mensagem do usuário.
 */

import Anthropic from '@anthropic-ai/sdk';
import { nocConfig } from './config.js';
import { availableTools, runTool } from './tools.js';
import { nowSaoPaulo, systemPrompt } from './prompt.js';
import { askOpenAiCompatible, openAiConfigured, resetOpenAiConversation } from './assistant-openai.js';
import { extractReport, REPORT_TOOL } from './report.js';
import { extractDevices, type DeviceCard } from './devices.js';
import { askNative, NATIVE_LABEL, resetNative } from './native/engine.js';
import { analisarImagens } from './imagens.js';
import { llmGeral } from './native/geral.js';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type AssistantEvent =
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; ms: number; devices?: DeviceCard[]; topology?: unknown }
  // Pedido para o navegador do operador abrir uma página (só http/https, em nova guia).
  | { type: 'open_url'; url: string; label: string }
  // Proposta de cadastro aguardando confirmação de um administrador (noc/acoes.ts).
  | { type: 'pending_action'; acao: unknown }
  // Painel visual (KPIs, gráficos e tabelas) do relatório — noc/dashboard.ts.
  | { type: 'dashboard'; dashboard: unknown };

export interface AssistantReply {
  text: string;
  model: string;
  toolsUsed: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const client = new Anthropic();
const histories = new Map<string, MessageParam[]>();

const usesClaude = () => nocConfig.llm.provider === 'anthropic';
// Motor nativo: entende e responde sem modelo de linguagem externo (native/engine.ts).
const usesNative = () => nocConfig.llm.provider === 'nativo';

/** Nome do modelo em uso, para status e logs. */
export function llmLabel(): string {
  if (usesNative()) {
    const geral = llmGeral();
    return geral ? `NIA · motor nativo + ${geral.model.replace(/^.*\//, '')} (perguntas gerais)` : NATIVE_LABEL;
  }
  return usesClaude() ? `Claude (${nocConfig.llm.model})` : `${nocConfig.openai.provider} (${nocConfig.openai.model || 'modelo não definido'})`;
}

/** O SDK resolve credencial de várias fontes; aqui basta saber se alguma existe. */
export function llmConfigured(): boolean {
  if (usesNative()) return true;
  if (!usesClaude()) return openAiConfigured();
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || process.env.CLAUDE_ENABLED === 'true');
}

/** Corta o histórico só em mensagem de usuário com texto, para nunca separar tool_use de tool_result. */
function trimHistory(history: MessageParam[]) {
  const starts = history
    .map((m, i) => (m.role === 'user' && typeof m.content === 'string' ? i : -1))
    .filter((i) => i >= 0);
  const excess = starts.length - nocConfig.llm.maxHistoryTurns;
  if (excess > 0) history.splice(0, starts[excess]);
}

export async function askAssistant(
  sessionId: string,
  mensagem: string,
  onEvent: (event: AssistantEvent) => void = () => {},
  imagens: string[] = [],
): Promise<AssistantReply> {
  if (usesNative()) return askNative(sessionId, mensagem, onEvent, imagens);
  // Nos modos com modelo externo, a imagem entra como descrição + texto lido.
  let userMessage = mensagem;
  if (imagens.length) {
    const a = await analisarImagens(imagens, mensagem).catch(() => null);
    if (a) userMessage = `${mensagem}\n\n[Imagem anexada] ${a.descricao}\nTexto na imagem:\n${a.texto || '(nenhum)'}`;
  }
  if (!usesClaude()) return askOpenAiCompatible(sessionId, userMessage, onEvent);
  const history = histories.get(sessionId) ?? [];
  histories.set(sessionId, history);
  const before = history.length;
  try {
    const reply = await runTurn(history, userMessage, onEvent);
    trimHistory(history);
    return reply;
  } catch (error) {
    // Falha no meio do loop deixaria tool_use sem tool_result; volta ao estado anterior.
    history.splice(before);
    throw error;
  }
}

async function runTurn(history: MessageParam[], userMessage: string, onEvent: (event: AssistantEvent) => void): Promise<AssistantReply> {
  history.push({ role: 'user', content: `[Agora: ${nowSaoPaulo()} (America/Sao_Paulo)]\n\n${userMessage}` });

  const [system, tools] = [await systemPrompt(), availableTools()];
  const toolsUsed: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model = nocConfig.llm.model;

  for (let round = 0; round <= nocConfig.llm.maxToolRounds; round++) {
    const lastRound = round === nocConfig.llm.maxToolRounds;
    const response = await client.beta.messages.create({
      model: nocConfig.llm.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: nocConfig.llm.effort },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      // Na última rodada o modelo não pode mais consultar e tem de responder com o que já apurou.
      ...(lastRound ? { tool_choice: { type: 'none' as const } } : {}),
      cache_control: { type: 'ephemeral' },
      messages: history,
    });

    model = response.model;
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    // Conteúdo completo (inclusive thinking) volta ao histórico sem edição.
    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { text: 'O modelo recusou esta solicitação. Reformule a pergunta com o contexto operacional.', model, toolsUsed, usage };
    }
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || calls.length === 0) {
      let text = response.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (response.stop_reason === 'max_tokens') text += '\n\n_(resposta cortada pelo limite de tamanho — peça a continuação)_';
      return { text: text || '_(sem resposta)_', model, toolsUsed, usage };
    }

    // Todas as chamadas da rodada em paralelo; todos os resultados numa única mensagem.
    const reports: string[] = [];
    const results: ToolResult[] = await Promise.all(
      calls.map(async (call) => {
        const started = Date.now();
        onEvent({ type: 'tool_start', id: call.id, name: call.name, input: call.input });
        const { text, isError, data } = await runTool(call.name, call.input);
        const devices = isError ? [] : await extractDevices(call.name, call.input, data);
        const topology = !isError && call.name === 'backbone_topologia' ? data : undefined;
        onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: !isError, ms: Date.now() - started, ...(devices.length ? { devices } : {}), ...(topology ? { topology } : {}) });
        toolsUsed.push(call.name);
        // Relatório pronto vai direto ao usuário; o modelo guarda só o resumo dos números.
        const report = !isError && call.name === REPORT_TOOL ? extractReport(text) : null;
        if (report) reports.push(report.markdown);
        return { type: 'tool_result', tool_use_id: call.id, content: report ? report.resumo : text, ...(isError ? { is_error: true } : {}) };
      }),
    );
    history.push({ role: 'user', content: results });
    if (reports.length) {
      history.push({ role: 'assistant', content: '[Relatório entregue ao usuário, com os números do resumo acima.]' });
      return { text: reports.join('\n\n---\n\n'), model, toolsUsed, usage };
    }
  }

  return { text: 'Atingi o limite de consultas nesta pergunta sem concluir. Refine o pedido (equipamento, cliente ou período).', model, toolsUsed, usage };
}

export function resetConversation(sessionId: string) {
  histories.delete(sessionId);
  resetOpenAiConversation(sessionId);
  resetNative(sessionId);
}
