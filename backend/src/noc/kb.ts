/**
 * Base de conhecimento da NIA: o que o operador ensina enviando arquivos.
 *
 * - documento: PDF, TXT, MD ou CSV. O texto é extraído, dividido em trechos e indexado
 *   (BM25); entra nas respostas e nos manuais como "base interna".
 * - molde: PDF de um relatório modelo. Além do texto, guarda a estrutura (títulos das
 *   seções, na ordem) para os documentos gerados seguirem o mesmo esqueleto.
 * - logo / imagem: identidade visual. Do logo saem as cores da marca automaticamente.
 *
 * "Aprender" aqui é guardar, indexar e reutilizar — não há treino de modelo de IA.
 * Arquivos em <pasta do DB_PATH>/kb (no servidor: /var/lib/ianoc/kb), fora do git.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type KbTipo = 'documento' | 'molde' | 'logo' | 'imagem';
export interface MoldeSecao { titulo: string; nivel: 1 | 2 }
export interface KbDoc {
  id: string;
  nome: string;
  tipo: KbTipo;
  mime: string;
  ext: string;
  tamanho: number;
  criadoEm: string;
  paginas?: number;
  caracteres?: number;
  chunks: string[];
  secoes?: MoldeSecao[];
  tituloMolde?: string;
  cabecalho?: string;
  rodape?: string;
  cores?: string[];
  aviso?: string;
}

const BASE = path.join(path.dirname(process.env.DB_PATH || './data/agent.json'), 'kb');
const ARQUIVOS = path.join(BASE, 'arquivos');
const INDICE = path.join(BASE, 'indice.json');

function ler(): KbDoc[] {
  try { return existsSync(INDICE) ? (JSON.parse(readFileSync(INDICE, 'utf8')) as KbDoc[]) : []; } catch { return []; }
}
function gravar(docs: KbDoc[]) {
  mkdirSync(BASE, { recursive: true });
  writeFileSync(`${INDICE}.tmp`, JSON.stringify(docs));
  renameSync(`${INDICE}.tmp`, INDICE);
}

const limpa = (s: string) => s.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Trechos de ~900 caracteres, quebrando em parágrafo/frase. */
function trechos(texto: string, max = 900): string[] {
  const paras = texto.split(/\n\s*\n|(?<=[.!?])\s+(?=[A-ZÀ-Ú])/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 20);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur + ' ' + p).length > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ PDF

async function lerPdf(buf: Buffer, molde: boolean) {
  const { getDocumentProxy, extractText, extractTextItems } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const paginas = (Array.isArray(text) ? text : [text]).map((t) => limpa(String(t)));
  const out: Pick<KbDoc, 'paginas' | 'chunks' | 'secoes' | 'cabecalho' | 'rodape' | 'tituloMolde'> = { paginas: totalPages, chunks: trechos(paginas.join('\n\n')) };
  if (!molde) return out;

  // Estrutura do molde: linhas com fonte maior que o corpo do texto, ou numeradas ("1. Introdução").
  const { items } = await extractTextItems(pdf);
  type Linha = { texto: string; altura: number; pagina: number; y: number };
  const linhas: Linha[] = [];
  (items as Array<Array<{ str: string; height?: number; fontSize?: number; y?: number; transform?: number[] }>>).forEach((pag, pi) => {
    const porY = new Map<number, { partes: string[]; altura: number }>();
    for (const it of pag) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.y ?? it.transform?.[5] ?? 0);
      const l = porY.get(y) ?? { partes: [], altura: 0 };
      l.partes.push(it.str);
      l.altura = Math.max(l.altura, it.fontSize || it.height || 0);
      porY.set(y, l);
    }
    for (const [y, l] of porY) linhas.push({ texto: l.partes.join(' ').replace(/\s+/g, ' ').trim(), altura: l.altura, pagina: pi, y });
  });
  const alturas = linhas.map((l) => l.altura).filter((h) => h > 0).sort((a, b) => a - b);
  const corpo = alturas[Math.floor(alturas.length / 2)] || 10;

  // Cabeçalho/rodapé: a mesma linha no topo/base de várias páginas.
  const repetidas = new Map<string, number>();
  for (const l of linhas) repetidas.set(l.texto, (repetidas.get(l.texto) ?? 0) + 1);
  const fixas = new Set([...repetidas.entries()].filter(([, n]) => totalPages > 1 && n >= Math.min(totalPages, 2)).map(([t]) => t));

  const vistas = new Set<string>();
  const secoes: Array<MoldeSecao & { altura: number }> = [];
  for (const l of linhas.sort((a, b) => a.pagina - b.pagina || b.y - a.y)) {
    const t = l.texto;
    if (t.length < 3 || t.length > 80 || fixas.has(t) || /^\d+$/.test(t)) continue;
    const numerada = /^(\d+(\.\d+)*[.)]?|[IVX]+[.)])\s+[A-ZÀ-Úa-zà-ú]/.test(t);
    const maior = l.altura >= corpo * 1.2;
    const caixaAlta = /^[A-ZÀ-Ú0-9 ,.&:/–-]{4,}$/.test(t) && /[A-ZÀ-Ú]{3}/.test(t);
    if (!(maior || numerada || caixaAlta)) continue;
    const titulo = t.replace(/^(\d+(\.\d+)*[.)]?|[IVX]+[.)])\s+/, '').replace(/[:.]$/, '').trim();
    const chave = titulo.toLowerCase();
    if (!titulo || vistas.has(chave)) continue;
    vistas.add(chave);
    secoes.push({ titulo, nivel: l.altura >= corpo * 1.5 || /^\d+[.)]?\s/.test(t) ? 1 : 2, altura: l.altura });
  }
  // A primeira linha com a maior fonte de todas é o título do molde, não uma seção.
  let tituloMolde: string | undefined;
  const maiorFonte = Math.max(0, ...secoes.map((x) => x.altura));
  if (secoes.length > 2 && secoes[0].altura === maiorFonte && secoes.slice(1).every((x) => x.altura < maiorFonte)) tituloMolde = secoes.shift()!.titulo;
  const secoesFinais: MoldeSecao[] = secoes.map(({ titulo, nivel }) => ({ titulo, nivel }));
  const fixasLista = [...fixas];
  return { ...out, secoes: secoesFinais.slice(0, 40), tituloMolde, cabecalho: fixasLista[0], rodape: fixasLista.length > 1 ? fixasLista[fixasLista.length - 1] : undefined };
}

// ------------------------------------------------------------------ cores do logo

/** Até 3 cores dominantes do logo (ignora fundo branco/preto e transparência). */
async function coresDoLogo(buf: Buffer): Promise<string[]> {
  // O sharp detecta o formato pelo conteúdo: um "logo.png" pode ser HEIF/TIFF disfarçado. Só passa
  // PNG, JPEG, WEBP ou GIF de verdade (assinatura dos primeiros bytes).
  const cab = buf.subarray(0, 12);
  const assinaturaOk = cab.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || cab.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || (cab.subarray(0, 4).toString('ascii') === 'RIFF' && cab.subarray(8, 12).toString('ascii') === 'WEBP') || cab.subarray(0, 4).toString('ascii') === 'GIF8';
  if (!assinaturaOk) return [];
  const { default: sharp } = await import('sharp');
  // Imagem enviada por usuário: limite de 40 MP e só formatos comuns (nada de HEIF/TIFF exóticos).
  const { data, info } = await sharp(buf, { limitInputPixels: 40_000_000, failOn: 'error' }).ensureAlpha().resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const conta = new Map<string, number>();
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 235 && min > 225) continue;               // branco
    if (max < 30) continue;                             // preto
    const q = (v: number) => Math.min(255, Math.round(v / 24) * 24);
    const k = `${q(r)},${q(g)},${q(b)}`;
    const sat = max ? (max - min) / max : 0;
    conta.set(k, (conta.get(k) ?? 0) + 0.3 + sat);
  }
  const hex = (k: string) => `#${k.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  // Descarta tons raros (borda/antisserrilhado): menos de 1,5% do peso total.
  const total = [...conta.values()].reduce((a, b) => a + b, 0);
  const ordem = [...conta.entries()].filter(([, n]) => n >= total * 0.015).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // Evita duas cores quase iguais.
  const escolhidas: string[] = [];
  for (const k of ordem) {
    const [r, g, b] = k.split(',').map(Number);
    if (escolhidas.every((e) => { const [r2, g2, b2] = e.split(',').map(Number); return Math.abs(r - r2) + Math.abs(g - g2) + Math.abs(b - b2) > 150; })) escolhidas.push(k);
    if (escolhidas.length >= 3) break;
  }
  return escolhidas.map(hex);
}

// ------------------------------------------------------------------ API do módulo

const EXT_TEXTO = /^(txt|md|csv|log)$/i;
const EXT_IMAGEM = /^(png|jpe?g|webp|svg|gif)$/i;

export async function adicionarArquivo(buf: Buffer, nomeOriginal: string, mime: string, tipo: KbTipo): Promise<KbDoc> {
  const ext = (path.extname(nomeOriginal).slice(1) || '').toLowerCase();
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  mkdirSync(ARQUIVOS, { recursive: true });
  writeFileSync(path.join(ARQUIVOS, `${id}.${ext || 'bin'}`), buf, { mode: 0o640 });
  const doc: KbDoc = { id, nome: path.basename(nomeOriginal).slice(0, 160), tipo, mime, ext, tamanho: buf.length, criadoEm: new Date().toISOString(), chunks: [] };

  try {
    if (ext === 'pdf' || /pdf/.test(mime)) Object.assign(doc, await lerPdf(buf, tipo === 'molde'));
    else if (EXT_TEXTO.test(ext) || /^text\//.test(mime)) doc.chunks = trechos(limpa(buf.toString('utf8')));
    else if (EXT_IMAGEM.test(ext) || /^image\//.test(mime)) {
      if (ext !== 'svg') doc.cores = await coresDoLogo(buf).catch(() => []);
    } else doc.aviso = 'Formato guardado, mas o conteúdo não é lido (envie PDF, TXT ou MD para a NIA aprender o texto).';
  } catch (e) {
    doc.aviso = `Arquivo guardado, mas não consegui ler o conteúdo: ${e instanceof Error ? e.message : String(e)}`;
  }
  if ((doc.tipo === 'documento' || doc.tipo === 'molde') && !doc.chunks.length && !doc.aviso) {
    doc.aviso = 'Não encontrei texto no arquivo (PDF escaneado como imagem não tem texto para ler).';
  }
  doc.caracteres = doc.chunks.reduce((n, c) => n + c.length, 0);
  const docs = ler();
  docs.push(doc);
  gravar(docs);
  return doc;
}

export function listar(): Array<Omit<KbDoc, 'chunks'> & { trechos: number }> {
  return ler().map(({ chunks, ...d }) => ({ ...d, trechos: chunks.length }));
}

export function obter(id: string): KbDoc | undefined {
  return ler().find((d) => d.id === id);
}

export function caminhoArquivo(d: KbDoc) {
  return path.join(ARQUIVOS, `${d.id}.${d.ext || 'bin'}`);
}

export function remover(id: string): boolean {
  const docs = ler();
  const d = docs.find((x) => x.id === id);
  if (!d) return false;
  rmSync(caminhoArquivo(d), { force: true });
  gravar(docs.filter((x) => x.id !== id));
  return true;
}

// ------------------------------------------------------------------ busca (BM25)

const STOP = new Set('a o os as um uma de do da dos das no na nos nas em para por com sem que como e ou se ao aos é ser mais muito sobre qual quais quando onde'.split(' '));
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const termos = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));

export interface KbHit { docId: string; nome: string; trecho: string; score: number }

export function buscar(consulta: string, limite = 5): KbHit[] {
  const q = [...new Set(termos(consulta))];
  if (!q.length) return [];
  const itens = ler().filter((d) => d.tipo === 'documento' || d.tipo === 'molde').flatMap((d) => d.chunks.map((c) => ({ d, c, t: termos(c) })));
  if (!itens.length) return [];
  const N = itens.length;
  const media = itens.reduce((n, i) => n + i.t.length, 0) / N;
  const df = new Map<string, number>();
  for (const i of itens) for (const w of new Set(i.t)) df.set(w, (df.get(w) ?? 0) + 1);
  const k1 = 1.4, b = 0.75;
  const pontuados = itens.map((i) => {
    const tf = new Map<string, number>();
    for (const w of i.t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0, cobertos = 0;
    for (const w of q) {
      const f = tf.get(w) ?? [...tf.keys()].filter((x) => x.startsWith(w) && w.length >= 4).reduce((n, x) => n + (tf.get(x) ?? 0), 0);
      if (!f) continue;
      cobertos++;
      const idf = Math.log(1 + (N - (df.get(w) ?? 1) + 0.5) / ((df.get(w) ?? 1) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (i.t.length / media))));
    }
    return { docId: i.d.id, nome: i.d.nome, trecho: i.c, score: s * (cobertos / q.length) };
  }).filter((h) => h.score > 0).sort((a, b) => b.score - a.score);
  // No máximo dois trechos do mesmo arquivo.
  const porDoc = new Map<string, number>();
  return pontuados.filter((h) => { const n = (porDoc.get(h.docId) ?? 0) + 1; porDoc.set(h.docId, n); return n <= 2; }).slice(0, limite);
}

export const temDocumentos = () => ler().some((d) => (d.tipo === 'documento' || d.tipo === 'molde') && d.chunks.length > 0);
