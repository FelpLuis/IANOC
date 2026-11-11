/**
 * Imagens no chat da NIA: recebe a imagem, entende o que ela mostra e lê o texto dela.
 *
 * - Guarda: só na memória, por 2 horas. Confere que é imagem de verdade (primeiros bytes),
 *   gira pela orientação da câmera, reduz para no máximo 2000 px e regrava em JPEG — o que também
 *   apaga metadados como a localização GPS de fotos de celular.
 * - Visão: Claude (com ANTHROPIC_API_KEY) ou o modelo com visão da Groq (IANOC_VISAO_MODEL,
 *   padrão qwen/qwen3.8-27b) responde ao pedido, descreve a imagem e transcreve o texto.
 * - OCR local (Tesseract, português + inglês): reserva quando o modelo de visão não está
 *   disponível ou falha; a imagem não sai do servidor.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { llmGeral, llmTecnico } from './native/geral.js';

// ------------------------------------------------------------------ armazenamento temporário

interface Guardada { buf: Buffer; criadaEm: number; usuario: string; largura: number; altura: number }
const imagens = new Map<string, Guardada>();
const VALIDADE_MS = 2 * 3600_000;
const MAX_IMAGENS = 60;

setInterval(() => {
  const limite = Date.now() - VALIDADE_MS;
  for (const [id, g] of imagens) if (g.criadaEm < limite) imagens.delete(id);
}, 10 * 60_000).unref();

/** PNG, JPEG, WEBP ou GIF de verdade (o nome e o tipo declarados não valem). */
function assinaturaDeImagem(buf: Buffer): boolean {
  const c = buf.subarray(0, 12);
  return c.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || c.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || (c.subarray(0, 4).toString('ascii') === 'RIFF' && c.subarray(8, 12).toString('ascii') === 'WEBP') || c.subarray(0, 4).toString('ascii') === 'GIF8';
}

export async function guardarImagem(buf: Buffer, usuario: string): Promise<{ id: string; largura: number; altura: number; bytes: number }> {
  if (!assinaturaDeImagem(buf)) throw new Error('Envie uma imagem PNG, JPG, WEBP ou GIF.');
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(buf, { limitInputPixels: 60_000_000, failOn: 'error' })
    .rotate()
    .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  // Limite de memória: as mais antigas saem primeiro.
  while (imagens.size >= MAX_IMAGENS) imagens.delete(imagens.keys().next().value as string);
  const id = randomUUID().replace(/-/g, '');
  imagens.set(id, { buf: data, criadaEm: Date.now(), usuario, largura: info.width, altura: info.height });
  return { id, largura: info.width, altura: info.height, bytes: data.length };
}

export const obterImagem = (id: string) => (/^[a-f0-9]{32}$/.test(id) ? imagens.get(id) : undefined);

// ------------------------------------------------------------------ OCR local (reserva)

type Ocr = { recognize: (img: Buffer) => Promise<{ data: { text: string } }> };
let ocr: Promise<Ocr> | null = null;

async function lerTextoLocal(buf: Buffer): Promise<string> {
  ocr ??= (async () => {
    const dir = path.join(path.dirname(process.env.DB_PATH || './data/agent.json'), 'ocr');
    mkdirSync(dir, { recursive: true });
    const { createWorker } = await import('tesseract.js');
    return (await createWorker(['por', 'eng'], 1, { cachePath: dir, logger: () => {} })) as unknown as Ocr;
  })();
  ocr.catch(() => { ocr = null; });
  const { data } = await (await ocr).recognize(buf);
  return data.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------ visão

export interface AnaliseImagem { resposta: string; descricao: string; texto: string; modelo?: string; origem: 'visao' | 'ocr' }

const instrucoes = (pedido: string) => [
  'Você é a NIA, assistente do NOC da UpDown Internet (provedor de internet por fibra). Analise a(s) imagem(ns).',
  'Responda EXATAMENTE neste formato, com as três seções e os rótulos em maiúsculas:',
  'RESPOSTA:',
  '<responda ao pedido do usuário em português do Brasil, direto, começando por uma ou duas frases de resumo; se o pedido for só a imagem, diga o que ela mostra e o que importa para o NOC>',
  'DESCRICAO:',
  '<o que a imagem mostra, em 1 a 3 frases objetivas>',
  'TEXTO:',
  '<todo o texto legível na imagem, exatamente como aparece, linha a linha — números de série, MACs, IPs, protocolos, nomes de host, potências em dBm e mensagens de erro sem alterar nada; se não houver texto, escreva (nenhum)>',
  'Não invente dados que não estejam na imagem.',
  `Pedido do usuário: ${pedido || '(só a imagem)'}`,
].join('\n');

function separar(bruto: string): { resposta: string; descricao: string; texto: string } {
  const limpo = bruto.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const m = limpo.match(/RESPOSTA:\s*([\s\S]*?)\n\s*\**DESCRI[CÇ][AÃ]O\**:\s*([\s\S]*?)\n\s*\**TEXTO\**:\s*([\s\S]*)$/i);
  if (!m) return { resposta: limpo, descricao: '', texto: '' };
  const texto = m[3].trim().replace(/^```\w*\n?|```$/g, '').trim();
  return { resposta: m[1].trim(), descricao: m[2].trim(), texto: /^\(?nenhum\)?\.?$/i.test(texto) ? '' : texto };
}

let claude: Anthropic | null = null;

async function visaoClaude(model: string, bufs: Buffer[], pedido: string): Promise<string> {
  claude ??= new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const final = await claude.beta.messages.stream({
    model,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    messages: [{
      role: 'user',
      content: [
        ...bufs.map((b) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b.toString('base64') } })),
        { type: 'text' as const, text: instrucoes(pedido) },
      ],
    }],
  }).finalMessage();
  if (final.stop_reason === 'refusal') throw new Error('o modelo recusou analisar a imagem');
  return final.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}

/** Modelo OpenAI-compatível com visão (Groq por padrão: qwen/qwen3.8-27b). */
async function visaoCompativel(bufs: Buffer[], pedido: string): Promise<{ texto: string; modelo: string } | null> {
  const cfg = llmGeral();
  if (!cfg) return null;
  const groq = cfg.baseUrl.includes('groq.com');
  const modelo = (process.env.IANOC_VISAO_MODEL || (groq ? 'qwen/qwen3.8-27b' : cfg.model)).trim();
  const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: modelo,
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'user', content: [
        { type: 'text', text: instrucoes(pedido) },
        ...bufs.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` } })),
      ] }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`modelo de visão respondeu HTTP ${r.status}`);
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const texto = j.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('o modelo de visão não devolveu texto');
  return { texto, modelo };
}

/** Entende as imagens e lê o texto delas; sem modelo de visão, só o OCR local. */
export async function analisarImagens(ids: string[], pedido: string): Promise<AnaliseImagem> {
  const bufs = ids.map(obterImagem).filter((g): g is Guardada => Boolean(g)).map((g) => g.buf).slice(0, 4);
  if (!bufs.length) throw new Error('a imagem expirou ou não foi encontrada; envie de novo');
  try {
    const dev = llmTecnico();
    if (dev?.tipo === 'anthropic') return { ...separar(await visaoClaude(dev.model, bufs, pedido)), modelo: dev.model, origem: 'visao' };
    const v = await visaoCompativel(bufs, pedido);
    if (v) return { ...separar(v.texto), modelo: v.modelo, origem: 'visao' };
  } catch (e) {
    console.warn('[imagem] visão indisponível, usando o OCR local:', e instanceof Error ? e.message : e);
  }
  const textos = [];
  for (const b of bufs) textos.push(await lerTextoLocal(b));
  const texto = textos.filter(Boolean).join('\n\n---\n\n');
  return {
    resposta: texto ? 'Li o texto da imagem (sem o modelo de visão agora, só o texto foi reconhecido):' : 'Não encontrei texto legível na imagem, e o modelo de visão não está disponível agora para descrevê-la.',
    descricao: '',
    texto,
    origem: 'ocr',
  };
}
