/**
 * Uma chamada simples ao modelo, sem ferramentas: usada para a análise escrita dos
 * relatórios, que recebe só um resumo pequeno dos números (cabe em qualquer cota).
 */

import Anthropic from '@anthropic-ai/sdk';
import { nocConfig } from './config.js';

let anthropic: Anthropic | null = null;

export async function llmComplete(system: string, user: string, maxTokens = 900): Promise<string> {
  if (nocConfig.llm.provider === 'anthropic') {
    anthropic ??= new Anthropic();
    const res = await anthropic.messages.create({
      model: nocConfig.llm.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
  }

  const cfg = nocConfig.openai;
  const ollama = cfg.provider === 'ollama';
  const url = ollama ? `${cfg.baseUrl.replace(/\/v1$/, '')}/api/chat` : `${cfg.baseUrl}/chat/completions`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const body = ollama
    ? { model: cfg.model, messages, stream: false, think: false, options: { num_ctx: cfg.ollamaNumCtx, num_predict: maxTokens } }
    : { model: cfg.model, messages, max_tokens: maxTokens, temperature: 0.3, ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}) };

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) || Number(text.match(/try again in ([\d.]+)s/i)?.[1]) || 20;
      await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000 + 500));
      continue;
    }
    if (!res.ok) throw new Error(`${cfg.provider}: HTTP ${res.status} — ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const out = ollama ? data?.message?.content : data?.choices?.[0]?.message?.content;
    return String(out ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  throw new Error(`${cfg.provider}: limite por minuto atingido.`);
}
