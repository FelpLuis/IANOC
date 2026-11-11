/**
 * Voz em tom de conversa: quando a pergunta veio pelo microfone, o primeiro parágrafo da
 * resposta (o que a NIA fala) é reescrito como alguém falaria com um colega do NOC — frases
 * curtas, português do dia a dia, sem parênteses, dois-pontos ou ponto e vírgula. As tabelas e
 * os detalhes na tela não mudam. Números e nomes são conferidos: se o modelo mexer em algum,
 * vale a simplificação por regras.
 */

import { llmGeral } from './native/geral.js';

/** Sem modelo (ou se ele mexer nos dados): tira a pontuação de texto escrito. */
export function simplificarFala(texto: string): string {
  return texto
    .replace(/\*\*|__|`/g, '')
    .replace(/\s*\(([^)]{1,120})\)/g, ', $1,')
    .replace(/\s*[;:—–]\s+/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const numeros = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]/g, ''));

// Abertura sugerida, em rodízio: sem isso o modelo começa quase sempre com "Olha".
const ABERTURAS = ['Então', 'Ó', '', 'Beleza', 'Olha', 'Bom', '', 'Certo', 'Vamos lá', ''];
let vez = Math.floor(Math.random() * ABERTURAS.length);

const instrucoes = () => {
  vez = (vez + 1) % ABERTURAS.length;
  const abertura = ABERTURAS[vez];
  return [
    'Você é a NIA conversando por voz com um colega do NOC da UpDown. Reescreva o texto como você FALARIA numa conversa, não como quem escreve.',
    `Português do dia a dia, informal mas educado, frases curtas e diretas. ${abertura ? `Comece com "${abertura}" se soar natural.` : 'Vá direto ao ponto, sem palavra de abertura.'}`,
    INSTRUCOES,
  ].join(' ');
};

const INSTRUCOES = [
  'Regras: mantenha TODOS os números, nomes de equipamentos, clientes, planos e protocolos exatamente como estão; não acrescente nem invente nada; no máximo 3 frases;',
  'sem listas, sem markdown, sem parênteses, sem dois-pontos, sem ponto e vírgula e sem travessão; vírgula só onde a pessoa respiraria.',
  'Responda só com o texto reescrito.',
].join(' ');

/** Reescreve o parágrafo falado em tom de conversa (até ~5 s); devolve o markdown com o novo começo. */
export async function emTomDeConversa(markdown: string): Promise<string> {
  const blocos = markdown.split(/\n\s*\n/);
  const i = blocos.findIndex((b) => b.trim() && !/^\s*(#|\||[-*+] |\d+[.)] |>|```)/.test(b));
  if (i < 0) return markdown;
  const original = blocos[i].trim();
  if (original.length < 25) { blocos[i] = simplificarFala(original); return blocos.join('\n\n'); }

  let falado = simplificarFala(original);
  const cfg = llmGeral();
  if (cfg) {
    try {
      const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.model, max_tokens: 600, temperature: 0.6,
          ...(cfg.reasoning ? { reasoning_effort: 'low' } : {}),
          messages: [{ role: 'system', content: instrucoes() }, { role: 'user', content: original }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const novo = j.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Só vale se todos os números do original continuam lá (nada mudou nos dados).
      const ok = novo && novo.length < original.length * 1.6 && numeros(original).every((n) => numeros(novo).includes(n));
      if (ok) falado = simplificarFala(novo);
    } catch { /* sem modelo agora: fica a versão simplificada */ }
  }
  blocos[i] = falado;
  return blocos.join('\n\n');
}
