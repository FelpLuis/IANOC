/**
 * Base de conhecimento do backbone e da rede FTTH.
 *
 * Fonte, em ordem de preferência:
 *   1. /api/topology do NOC (recortes "noc" e "isp") — é o que a equipe edita;
 *   2. sementes em Topologia-NOC.github.io/public/data (geradas do KMZ do backbone);
 *   3. documentos Markdown em ianoc-agent/knowledge/ — o conhecimento que não
 *      está em sistema nenhum (VLANs, procedimentos, contatos de operadora).
 *
 * O resumo vai no system prompt (fica em cache); o detalhe sai por ferramenta.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { connectorEnabled, nocConfig } from './config.js';
import { nocGet } from './connectors/noc.js';
import { matchesQuery, normalize } from './http.js';

export interface Porta { numero: number; nome?: string; capacidade?: string; tipo?: string; status?: string; descricao?: string; zabbix?: Record<string, unknown> }
export interface Equipamento { id: string; nome: string; modelo?: string; categoria?: string; local?: string; observacao?: string; portas?: Porta[] }
export interface Conexao { origem: string; portaOrigem?: number | string; destino: string; portaDestino?: number | string; capacidade?: string; tipo?: string }
export interface Pop { id: string; nome: string; tipo?: string; endereco?: string; lat?: number; lon?: number; rotas?: string[]; observacao?: string }
export interface Caixa { id: string; nome: string; tipo?: string; observacao?: string; lat?: number; lon?: number }
export interface Fibra { id: string; nome: string; tipo?: string; fibras?: number | null; extensao?: number; observacao?: string; pontos?: [number, number][] }
export interface Documento { arquivo: string; titulo: string; texto: string }

export interface Knowledge {
  fonte: string;
  carregadoEm: string;
  equipamentos: Equipamento[];
  conexoes: Conexao[];
  pops: Pop[];
  ispPops: Pop[];
  caixas: Caixa[];
  fibras: Fibra[];
  documentos: Documento[];
}

const REFRESH_MS = 30 * 60 * 1000;
let cache: Knowledge | null = null;
let loadedAt = 0;

async function readSeed<T>(file: string): Promise<T[]> {
  try {
    const data = JSON.parse(await readFile(path.join(nocConfig.knowledge.topologiaDataDir, file), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function readDocs(): Promise<Documento[]> {
  const dir = nocConfig.knowledge.docsDir;
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md')).sort(); } catch { return []; }
  const docs: Documento[] = [];
  for (const arquivo of files) {
    const texto = await readFile(path.join(dir, arquivo), 'utf8');
    const titulo = texto.match(/^#\s+(.+)$/m)?.[1]?.trim() || arquivo;
    docs.push({ arquivo, titulo, texto });
  }
  return docs;
}

type TopologyPayload = { equipamentos?: Equipamento[]; conexoes?: Conexao[]; pops?: Pop[]; fibras?: Fibra[]; caixas?: Caixa[] };

export async function getKnowledge(force = false): Promise<Knowledge> {
  if (cache && !force && Date.now() - loadedAt < REFRESH_MS) return cache;

  const [seedEquip, seedConex, seedPops, seedIspPops, seedCaixas, seedFibras, documentos] = await Promise.all([
    readSeed<Equipamento>('equipamentos.json'),
    readSeed<Conexao>('conexoes.json'),
    readSeed<Pop>('pops.json'),
    readSeed<Pop>('isp-pops.json'),
    readSeed<Caixa>('isp-caixas.json'),
    readSeed<Fibra>('isp-fibras.json'),
    readDocs(),
  ]);

  let noc: TopologyPayload | null = null;
  let isp: TopologyPayload | null = null;
  let fonte = `sementes locais (${nocConfig.knowledge.topologiaDataDir})`;
  if (connectorEnabled('noc')) {
    try {
      [noc, isp] = await Promise.all([
        nocGet<TopologyPayload>('/api/topology', { scope: 'noc' }),
        nocGet<TopologyPayload>('/api/topology', { scope: 'isp' }),
      ]);
      fonte = `NOC ao vivo (${nocConfig.noc.baseUrl}/api/topology)`;
    } catch (error) {
      console.warn('[knowledge] topologia do NOC indisponível, usando sementes:', error instanceof Error ? error.message : error);
    }
  }

  const nonEmpty = <T>(live: T[] | undefined, seed: T[]) => (Array.isArray(live) && live.length ? live : seed);
  cache = {
    fonte,
    carregadoEm: new Date().toISOString(),
    equipamentos: nonEmpty(noc?.equipamentos, seedEquip),
    conexoes: nonEmpty(noc?.conexoes, seedConex),
    pops: nonEmpty(noc?.pops, seedPops),
    ispPops: nonEmpty(isp?.pops, seedIspPops),
    caixas: nonEmpty(isp?.caixas, seedCaixas),
    fibras: nonEmpty(isp?.fibras, seedFibras),
    documentos,
  };
  loadedAt = Date.now();
  return cache;
}

// ---------------------------------------------------------------- resumo para o system prompt

function portSummary(e: Equipamento) {
  const portas = e.portas ?? [];
  const usadas = portas.filter((p) => p.status && p.status !== 'livre').length;
  return `${portas.length} portas, ${usadas} em uso, ${portas.length - usadas} livres`;
}

/** Texto determinístico (mesma entrada → mesmos bytes) para não quebrar o cache do prompt. */
export function knowledgeSummary(k: Knowledge): string {
  const byId = new Map(k.equipamentos.map((e) => [e.id, e]));
  const nome = (id: string) => byId.get(id)?.nome ?? id;
  const km = (m: number) => (m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const contagem = <T>(items: T[], key: (i: T) => string | undefined) => {
    const out: Record<string, number> = {};
    for (const i of items) { const k2 = key(i) || 'sem tipo'; out[k2] = (out[k2] || 0) + 1; }
    return Object.entries(out).sort().map(([t, n]) => `${t}: ${n}`).join(', ');
  };

  const linhas: string[] = [];
  linhas.push(`Fonte dos dados: ${k.fonte}.`);

  linhas.push('\n### Equipamentos do backbone (id | nome | modelo | função | local | portas)');
  for (const e of k.equipamentos) {
    linhas.push(`- \`${e.id}\` | ${e.nome} | ${e.modelo || '?'} | ${e.categoria || '?'} | ${e.local || '?'} | ${portSummary(e)}`);
  }

  linhas.push('\n### Enlaces entre equipamentos (origem:porta → destino:porta, tipo, capacidade)');
  for (const c of k.conexoes) {
    linhas.push(`- ${nome(c.origem)}:${c.portaOrigem ?? '?'} → ${nome(c.destino)}:${c.portaDestino ?? '?'} — ${c.tipo || '?'}, ${c.capacidade || '?'}`);
  }

  linhas.push('\n### POPs');
  for (const p of k.pops) linhas.push(`- ${p.nome}${p.rotas?.length ? ` — rotas: ${p.rotas.join('; ')}` : ''}`);

  const ispClientes = k.ispPops.filter((p) => !/pop/i.test(p.tipo || ''));
  const ispProprios = k.ispPops.filter((p) => /pop/i.test(p.tipo || ''));
  linhas.push(`\n### Rede de fibra (mapa ISP, importado do KMZ do backbone)`);
  linhas.push(`- Pontos de presença no mapa: ${ispProprios.map((p) => p.nome).join(', ') || 'nenhum'}`);
  linhas.push(`- Clientes ISP/corporativos atendidos por fibra (${ispClientes.length}): ${ispClientes.map((p) => p.nome).join(', ')}`);
  const totalFibra = k.fibras.reduce((s, f) => s + (f.extensao || 0), 0);
  linhas.push(`- Cabos/traçados: ${k.fibras.length}, extensão somada ≈ ${km(totalFibra)} km. Por tipo: ${contagem(k.fibras, (f) => `${f.tipo}${f.fibras ? ` ${f.fibras}FO` : ''}`)}`);
  linhas.push(`- Caixas/pontos no mapa: ${k.caixas.length}. Por tipo: ${contagem(k.caixas, (c) => c.tipo)}`);
  linhas.push('- Detalhe (coordenadas, traçado, caixas próximas) só pelas ferramentas `ftth_buscar` e `ftth_proximos`.');

  if (k.documentos.length) {
    linhas.push('\n### Documentos da equipe (conteúdo integral abaixo)');
    for (const d of k.documentos) linhas.push(`\n<documento arquivo="${d.arquivo}">\n${d.texto.trim()}\n</documento>`);
  }
  return linhas.join('\n');
}

// ---------------------------------------------------------------- consultas das ferramentas

export function findEquipamento(k: Knowledge, termo: string) {
  const t = normalize(termo);
  const e = k.equipamentos.find((x) => normalize(x.id) === t)
    ?? k.equipamentos.find((x) => normalize(x.nome) === t)
    ?? k.equipamentos.find((x) => matchesQuery(x, termo));
  if (!e) return null;
  const enlaces = k.conexoes.filter((c) => c.origem === e.id || c.destino === e.id);
  return { ...e, enlaces };
}

/** Caminho físico/lógico entre dois equipamentos, por busca em largura nos enlaces. */
export function pathBetween(k: Knowledge, de: string, para: string) {
  const a = findEquipamento(k, de), b = findEquipamento(k, para);
  if (!a || !b) return { erro: `equipamento não encontrado: ${!a ? de : para}` };
  const vizinhos = new Map<string, Array<{ id: string; c: Conexao }>>();
  for (const c of k.conexoes) {
    (vizinhos.get(c.origem) ?? vizinhos.set(c.origem, []).get(c.origem)!).push({ id: c.destino, c });
    (vizinhos.get(c.destino) ?? vizinhos.set(c.destino, []).get(c.destino)!).push({ id: c.origem, c });
  }
  const anterior = new Map<string, { id: string; c: Conexao } | null>([[a.id, null]]);
  const fila = [a.id];
  while (fila.length) {
    const atual = fila.shift()!;
    if (atual === b.id) break;
    for (const v of vizinhos.get(atual) ?? []) {
      if (!anterior.has(v.id)) { anterior.set(v.id, { id: atual, c: v.c }); fila.push(v.id); }
    }
  }
  if (!anterior.has(b.id)) return { erro: `sem caminho cadastrado entre ${a.nome} e ${b.nome}` };
  const saltos: Conexao[] = [];
  for (let n = b.id; anterior.get(n); n = anterior.get(n)!.id) saltos.unshift(anterior.get(n)!.c);
  return { de: a.nome, para: b.nome, saltos: saltos.length, caminho: saltos };
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distância aproximada de um ponto a uma polilinha (projeção plana local; ok para poucos km). */
function distanceToPolyline(lat: number, lon: number, pontos: [number, number][]) {
  const kx = Math.cos(rad(lat)) * 111320, ky = 110540;
  let best = Infinity;
  for (let i = 1; i < pontos.length; i++) {
    const [aLat, aLon] = pontos[i - 1], [bLat, bLon] = pontos[i];
    const ax = (aLon - lon) * kx, ay = (aLat - lat) * ky, bx = (bLon - lon) * kx, by = (bLat - lat) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const semTracado = (f: Fibra) => {
  const { pontos, ...resto } = f;
  const inicio = pontos?.[0], fim = pontos?.[pontos.length - 1];
  return { ...resto, inicio, fim, vertices: pontos?.length ?? 0 };
};

export function searchFtth(k: Knowledge, termo: string, tipo?: 'caixa' | 'fibra' | 'pop', limite = 30) {
  const out: Record<string, unknown> = {};
  if (!tipo || tipo === 'caixa') out.caixas = k.caixas.filter((c) => matchesQuery(c, termo)).slice(0, limite);
  if (!tipo || tipo === 'fibra') out.fibras = k.fibras.filter((f) => matchesQuery(semTracado(f), termo)).slice(0, limite).map(semTracado);
  if (!tipo || tipo === 'pop') out.pops = [...k.pops, ...k.ispPops].filter((p) => matchesQuery(p, termo)).slice(0, limite);
  return out;
}

export function nearFtth(k: Knowledge, lat: number, lon: number, raioM = 500, limite = 15) {
  const caixas = k.caixas
    .filter((c) => typeof c.lat === 'number' && typeof c.lon === 'number')
    .map((c) => ({ ...c, distancia_m: Math.round(distanceM(lat, lon, c.lat!, c.lon!)) }))
    .filter((c) => c.distancia_m <= raioM)
    .sort((x, y) => x.distancia_m - y.distancia_m)
    .slice(0, limite);
  const fibras = k.fibras
    .filter((f) => (f.pontos?.length ?? 0) > 1)
    .map((f) => ({ ...semTracado(f), distancia_m: Math.round(distanceToPolyline(lat, lon, f.pontos!)) }))
    .filter((f) => f.distancia_m <= raioM)
    .sort((x, y) => x.distancia_m - y.distancia_m)
    .slice(0, limite);
  const pops = [...k.pops, ...k.ispPops]
    .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number')
    .map((p) => ({ nome: p.nome, tipo: p.tipo, distancia_m: Math.round(distanceM(lat, lon, p.lat!, p.lon!)) }))
    .sort((x, y) => x.distancia_m - y.distancia_m)
    .slice(0, 3);
  return { ponto: { lat, lon }, raio_m: raioM, caixas, fibras, pops_mais_proximos: pops };
}
