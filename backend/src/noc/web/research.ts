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

import { lookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';
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

// ------------------------------------------------------------------ proteção contra SSRF

/** Endereços que a NIA nunca busca: loopback, redes privadas, CGNAT, link-local, metadados, multicast. */
export function ipInterno(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return ipInterno(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('64:ff9b');
}

/**
 * Só deixa buscar URL pública: http(s), portas 80/443, sem usuário/senha e com todos os IPs do
 * nome fora das faixas internas. Sem isso, "gere um manual a partir de http://127.0.0.1:8080/…"
 * faria o servidor ler os próprios serviços internos (SSRF).
 */
export async function urlPublica(endereco: string): Promise<URL> {
  const url = new URL(endereco);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('só links http/https');
  if (url.username || url.password) throw new Error('link com usuário/senha não é aceito');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('porta não permitida');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan)$/i.test(host)) throw new Error('endereço interno bloqueado');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(ipInterno)) throw new Error('endereço interno bloqueado');
  return url;
}

async function getText(url: string, ms = 10000, maxBytes = 2_000_000): Promise<{ html: string; type: string } | null> {
  const sinal = AbortSignal.timeout(ms);
  // Redirecionamentos um a um, conferindo cada destino (um site público pode redirecionar para dentro).
  let atual = await urlPublica(url);
  let r: Response | null = null;
  for (let saltos = 0; saltos <= 4; saltos++) {
    r = await fetch(atual, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, redirect: 'manual', signal: sinal });
    const destino = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!destino) break;
    await r.body?.cancel().catch(() => {});
    atual = await urlPublica(new URL(destino, atual).href);
    r = null;
  }
  if (!r || !r.ok) return null;
  const type = r.headers.get('content-type') || '';
  if (!/html|json/.test(type)) { await r.body?.cancel().catch(() => {}); return null; }
  // Lê no máximo maxBytes (página gigante não esgota a memória).
  const partes: Buffer[] = [];
  let total = 0;
  const leitor = r.body?.getReader();
  while (leitor) {
    const { done, value } = await leitor.read();
    if (done || !value) break;
    partes.push(Buffer.from(value));
    total += value.length;
    if (total >= maxBytes) { await leitor.cancel().catch(() => {}); break; }
  }
  return { html: Buffer.concat(partes).subarray(0, maxBytes).toString('utf8'), type };
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
async function tavily(q: string, limite: number, resposta = false): Promise<Busca> {
  const key = process.env.TAVILY_API_KEY || '';
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ api_key: key, query: q, max_results: Math.min(limite, 10), search_depth: 'basic', country: 'brazil', ...(resposta ? { include_answer: 'basic' } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const j = (await r.json()) as { answer?: string; results?: Array<{ title: string; url: string; content?: string }> };
  return {
    resposta: j.answer ? limpa(j.answer) : undefined,
    results: (j.results ?? []).map((x) => ({ title: limpa(x.title), url: x.url, snippet: limpa(x.content ?? ''), fonte: 'web' as const })),
  };
}

/** Resultado da busca: resposta curta pronta (só a Tavily dá) e os links. */
export interface Busca { resposta?: string; results: SearchResult[] }

/** Qual busca da web está configurada (nenhuma: só Wikipédia e links informados). */
export function provedorBusca(): string | null {
  if (process.env.TAVILY_API_KEY) return 'Tavily';
  if (process.env.BRAVE_API_KEY) return 'Brave Search';
  if (process.env.SEARXNG_URL) return 'SearXNG';
  return null;
}

// Cache de 1 h por consulta: o mesmo pedido não gasta crédito de novo.
const cacheBusca = new Map<string, { em: number; r: Busca }>();

/**
 * Busca da web só por API oficial (Tavily, Brave) ou pelo SearXNG da própria empresa.
 * Não raspa página de resultado de buscador nem contorna bloqueio anti-robô.
 */
async function buscaWeb(q: string, limite: number, resposta: boolean): Promise<Busca> {
  if (process.env.TAVILY_API_KEY) return tavily(q, limite, resposta);
  if (process.env.BRAVE_API_KEY) return { results: await brave(q, limite) };
  if (process.env.SEARXNG_URL) return { results: await searxng(q, limite) };
  return { results: [] };
}

/** Resultados da web (sem bloqueados e sem repetir site) + Wikipédia. */
export async function searchWeb(q: string, limite = 8): Promise<SearchResult[]> {
  return (await pesquisarWeb(q, limite)).results;
}

/** Busca com a resposta curta pronta (quando o provedor dá) + resultados filtrados. */
export async function pesquisarWeb(q: string, limite = 8, resposta = false): Promise<Busca> {
  const chave = `${q.toLowerCase()}|${limite}|${resposta ? 'r' : ''}`;
  const hit = cacheBusca.get(chave);
  if (hit && Date.now() - hit.em < 3600_000) return hit.r;
  const [web, wiki] = await Promise.allSettled([buscaWeb(q, limite * 2, resposta), wikipedia(q, 2)]);
  const lista = [...(web.status === 'fulfilled' ? web.value.results : []), ...(wiki.status === 'fulfilled' ? wiki.value : [])];
  const sites = new Set<string>();
  const r = lista.filter((x) => {
    if (BLOQUEADOS.test(x.url)) return false;
    let host = '';
    try { host = new URL(x.url).hostname.replace(/^www\./, ''); } catch { return false; }
    if (sites.has(host)) return false;
    sites.add(host);
    return true;
  }).slice(0, limite);
  const out: Busca = { resposta: web.status === 'fulfilled' ? web.value.resposta : undefined, results: r };
  if (r.length) cacheBusca.set(chave, { em: Date.now(), r: out });
  return out;
}

/** Resumo do verbete da Wikipédia em português (API oficial, sem chave). */
export async function resumoWikipedia(titulo: string): Promise<string | null> {
  const res = await getText(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titulo.replace(/ /g, '_'))}`).catch(() => null);
  if (!res) return null;
  try {
    const j = JSON.parse(res.html) as { extract?: string; type?: string };
    return j.type === 'disambiguation' || !j.extract ? null : limpa(j.extract);
  } catch { return null; }
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
