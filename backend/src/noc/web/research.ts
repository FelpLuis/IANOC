/**
 * Pesquisa na web sem modelo de linguagem: busca, leitura e extração do conteúdo.
 *
 * - Busca: só por API oficial (Tavily, Brave) ou SearXNG próprio, mais a Wikipédia em
 *   português (API oficial, sem chave). Sem busca configurada, lê só os links informados.
 * - Leitura: baixa a página (só HTML, até 2 MB, 10 s) e extrai o texto principal com o
 *   Readability (o mesmo do "modo leitura" do Firefox): títulos, parágrafos e listas.
 * - Filtra o que não serve para manual (vídeo, rede social, loja, Scribd) e páginas que não
 *   estão em português.
 */

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export interface SearchResult { title: string; url: string; snippet: string; fonte: 'web' | 'wikipedia' }
export interface PageList { ordered: boolean; heading?: string; items: string[] }
export interface PageContent {
  url: string; title: string; site: string; paragraphs: string[]; lists: PageList[]; headings: string[];
  /** Títulos e parágrafos na ordem da página (para achar "Passo 1… Passo 2…"). */
  blocks: Array<{ tipo: 'h' | 'p'; texto: string }>;
}

// Identificação honesta: a NIA não se passa por navegador.
const UA = 'NIA-IANOC/1.0 (assistente interno do NOC da UpDown Internet; leitura de páginas sob pedido)';
const BLOQUEADOS = /(youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|scribd\.com|pinterest\.|twitter\.com|\bx\.com|linkedin\.com\/posts|mercadolivre|amazon\.|shopee|aliexpress|reddit\.com\/r\/.+\/comments)/i;

// Também tira as notas de rodapé da Wikipédia ("[11]", "[nota 1]", "[carece de fontes?]").
const limpa = (s: string) => s.replace(/\[(\d{1,3}|nota \d+|carece de fontes\??|citation needed)\]/gi, '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
const entidades = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '');

async function getText(url: string, ms = 10000, maxBytes = 2_000_000): Promise<{ html: string; type: string } | null> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!r.ok) return null;
  const type = r.headers.get('content-type') || '';
  if (!/html|json/.test(type)) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) return { html: buf.subarray(0, maxBytes).toString('utf8'), type };
  return { html: buf.toString('utf8'), type };
}

async function wikipedia(q: string, limite: number): Promise<SearchResult[]> {
  const res = await getText(`https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=${limite}`);
  if (!res) return [];
  const j = JSON.parse(res.html) as { query?: { search?: Array<{ title: string; snippet: string }> } };
  return (j.query?.search ?? []).map((s) => ({
    title: s.title,
    url: `https://pt.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
    snippet: limpa(entidades(s.snippet)),
    fonte: 'wikipedia' as const,
  }));
}

/** Brave Search API (oficial; chave gratuita em brave.com/search/api). */
async function brave(q: string, limite: number): Promise<SearchResult[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&country=BR&search_lang=pt-br&count=${Math.min(limite, 20)}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY || '' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
  const j = (await r.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
  return (j.web?.results ?? []).map((x) => ({ title: limpa(entidades(x.title)), url: x.url, snippet: limpa(entidades(x.description ?? '')), fonte: 'web' as const }));
}

/** SearXNG próprio (metabuscador aberto): SEARXNG_URL=https://busca.suaempresa/ com formato JSON ligado. */
async function searxng(q: string, limite: number): Promise<SearchResult[]> {
  const base = (process.env.SEARXNG_URL || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json&language=pt-BR`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
  const j = (await r.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (j.results ?? []).slice(0, limite).map((x) => ({ title: limpa(x.title), url: x.url, snippet: limpa(x.content ?? ''), fonte: 'web' as const }));
}

/** Tavily (API de busca para pesquisa automatizada; plano gratuito com créditos mensais). */
async function tavily(q: string, limite: number): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY || '';
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ api_key: key, query: q, max_results: Math.min(limite, 10), search_depth: 'basic', country: 'brazil' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const j = (await r.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (j.results ?? []).map((x) => ({ title: limpa(x.title), url: x.url, snippet: limpa(x.content ?? ''), fonte: 'web' as const }));
}

/** Qual busca da web está configurada (nenhuma: só Wikipédia e links informados). */
export function provedorBusca(): string | null {
  if (process.env.TAVILY_API_KEY) return 'Tavily';
  if (process.env.BRAVE_API_KEY) return 'Brave Search';
  if (process.env.SEARXNG_URL) return 'SearXNG';
  return null;
}

// Cache de 1 h por consulta: o mesmo pedido não gasta crédito de novo.
const cacheBusca = new Map<string, { em: number; r: SearchResult[] }>();

/**
 * Busca da web só por API oficial (Tavily, Brave) ou pelo SearXNG da própria empresa.
 * Não raspa página de resultado de buscador nem contorna bloqueio anti-robô.
 */
async function buscaWeb(q: string, limite: number): Promise<SearchResult[]> {
  if (process.env.TAVILY_API_KEY) return tavily(q, limite);
  if (process.env.BRAVE_API_KEY) return brave(q, limite);
  if (process.env.SEARXNG_URL) return searxng(q, limite);
  return [];
}

/** Resultados da web (sem bloqueados e sem repetir site) + Wikipédia. */
export async function searchWeb(q: string, limite = 8): Promise<SearchResult[]> {
  const chave = `${q.toLowerCase()}|${limite}`;
  const hit = cacheBusca.get(chave);
  if (hit && Date.now() - hit.em < 3600_000) return hit.r;
  const [web, wiki] = await Promise.allSettled([buscaWeb(q, limite * 2), wikipedia(q, 2)]);
  const lista = [...(web.status === 'fulfilled' ? web.value : []), ...(wiki.status === 'fulfilled' ? wiki.value : [])];
  const sites = new Set<string>();
  const r = lista.filter((x) => {
    if (BLOQUEADOS.test(x.url)) return false;
    let host = '';
    try { host = new URL(x.url).hostname.replace(/^www\./, ''); } catch { return false; }
    if (sites.has(host)) return false;
    sites.add(host);
    return true;
  }).slice(0, limite);
  if (r.length) cacheBusca.set(chave, { em: Date.now(), r });
  return r;
}

/** Proporção de palavras típicas do português: separa pt de es/en. */
export function parecePortugues(texto: string): boolean {
  const t = ` ${texto.toLowerCase()} `;
  const pt = (t.match(/ (não|você|para|com|uma|são|também|está|então|configuração|através|após|é) /g) ?? []).length;
  const es = (t.match(/ (usted|para el|también es|configuración|hacer|está en|puede|los|las|del) /g) ?? []).length;
  return pt >= 3 && pt >= es;
}

/** Conteúdo principal da página: título, parágrafos, listas (com o título acima delas). */
export async function readPage(url: string): Promise<PageContent | null> {
  const res = await getText(url).catch(() => null);
  if (!res || !/html/.test(res.type)) return null;
  const { document } = parseHTML(res.html);
  const artigo = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 300 }).parse();
  if (!artigo?.content) return null;
  const { document: doc } = parseHTML(`<!doctype html><html><body>${artigo.content}</body></html>`);

  const paragraphs = [...doc.querySelectorAll('p')].map((p) => limpa(p.textContent ?? '')).filter((p) => p.length >= 40);
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4')].map((h) => limpa(h.textContent ?? '')).filter(Boolean);
  const lists: PageList[] = [...doc.querySelectorAll('ol,ul')].map((l) => {
    let heading: string | undefined;
    for (let el = l.previousElementSibling; el; el = el.previousElementSibling) {
      if (/^H[1-4]$/.test(el.tagName)) { heading = limpa(el.textContent ?? ''); break; }
    }
    return {
      ordered: l.tagName === 'OL',
      heading,
      items: [...l.querySelectorAll(':scope > li')].map((li) => limpa(li.textContent ?? '')).filter((i) => i.length >= 8 && i.length <= 400),
    };
  }).filter((l) => l.items.length >= 2);

  const blocks = [...doc.querySelectorAll('h1,h2,h3,h4,p')]
    .map((el) => ({ tipo: (/^H/.test(el.tagName) ? 'h' : 'p') as 'h' | 'p', texto: limpa(el.textContent ?? '') }))
    .filter((b) => b.texto.length >= 4);

  let site = '';
  try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* fica vazio */ }
  const page = { url, title: limpa(artigo.title || site), site, paragraphs, lists, headings, blocks };
  const amostra = [...paragraphs, ...lists.flatMap((l) => l.items)].join(' ').slice(0, 4000);
  return parecePortugues(amostra) ? page : null;
}
