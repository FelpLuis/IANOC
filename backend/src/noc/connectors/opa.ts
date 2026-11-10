/**
 * Opa! Suite (atendimento omnichannel), API v1, somente GET.
 *
 * Autenticação: token de um usuário com perfil de permissão do tipo API
 * (Configurações → Permissões → grupo de API, só leitura; o IP do servidor do
 * IA NOC precisa estar em "Redes permitidas").
 *
 * A listagem é um GET com corpo JSON ({ filter, options }), o que o fetch do Node
 * não envia; por isso a requisição sai por node:http(s).
 *
 * Comportamento da API, verificado na instância da UpDown (nov/2026):
 * - toda listagem exige ao menos um filtro válido; campo desconhecido dá
 *   "Field '<campo>' is not allowed";
 * - atendimento aceita status, protocolo, setor, id_atendente e o período
 *   dataInicialAbertura/dataFinalAbertura em "AAAA-MM-DD" (com hora, a API ignora
 *   o período e devolve os últimos 365 dias); a ordem é da abertura mais antiga
 *   para a mais nova; até 1000 por página;
 * - usuario aceita status/tipo; departamento lista só por id (departamento/<id>);
 * - registros de usuário trazem o token de API e o e-mail de cada atendente, e o
 *   detalhe do atendimento traz CPF/CNPJ do cliente: tudo isso é retirado ou
 *   mascarado aqui, antes de ir para o modelo.
 */

import http from 'node:http';
import https from 'node:https';
import { nocConfig } from '../config.js';
import { ConnectorError, horaLocal } from '../http.js';

interface OpaEnvelope { status?: string; code?: number; data?: unknown; description?: string }
type Rec = Record<string, unknown>;

// Caminho relativo à /api/v1: recurso e, opcionalmente, id ou sub-recurso.
const SAFE_PATH = /^[a-z][a-z0-9_-]*(\/[A-Za-z0-9_-]+){0,3}$/;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

// Nunca saem do conector: credenciais e dados de contato internos.
const DROP = /^(token|senha|password|hash|salt|email|twoFactor.*|perfilPermissoesApi|perfil_permissoes|integracoes|conexoes|stickers|siga_me|__v)$/i;
// Saem mascarados (últimos 4 dígitos).
const MASK = /^(cpf_cnpj|cpf|cnpj|rg|canal_cliente|telefone|celular|fone|whatsapp)$/i;

function mask(value: unknown): string {
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

/** Remove segredos e mascara documentos/telefones em qualquer profundidade. */
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Rec)
      .filter(([k]) => !DROP.test(k))
      .map(([k, v]) => [k, MASK.test(k) && (typeof v === 'string' || typeof v === 'number') ? mask(v) : sanitize(v)]),
  );
}

async function rawGet(resource: string, body?: { filter?: Rec; options?: Rec }): Promise<unknown> {
  const clean = resource.replace(/^\/+|\/+$/g, '');
  if (!SAFE_PATH.test(clean)) throw new ConnectorError('opa', `caminho inválido: ${resource}`);
  const url = new URL(`${nocConfig.opa.baseUrl}/${clean}`);
  const payload = body ? JSON.stringify(body) : undefined;
  const lib = url.protocol === 'https:' ? https : http;

  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${nocConfig.opa.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: nocConfig.http.timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`sem resposta em ${nocConfig.http.timeoutMs} ms`)));
    req.on('error', (e) => reject(new ConnectorError('opa', `sem resposta de ${url.host}: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });

  let data: OpaEnvelope | string = text;
  try { data = JSON.parse(text) as OpaEnvelope; } catch { /* corpo não-JSON */ }
  if (typeof data === 'string') throw new ConnectorError('opa', `HTTP ${status}: resposta não-JSON (${text.slice(0, 200)})`, status);
  if (status >= 400 || data.status === 'error') {
    const msg = (data.data as { message?: string } | undefined)?.message || data.description || `HTTP ${status}`;
    const hint = status === 401 ? ' (token inválido ou trocado)'
      : status === 403 ? ' (perfil de API sem permissão neste recurso, ou IP do servidor fora de "Redes permitidas")' : '';
    throw new ConnectorError('opa', `${msg}${hint}`, status);
  }
  return data.data;
}

/** GET genérico, já sem segredos. */
export async function opaGet(resource: string, body?: { filter?: Rec; options?: Rec }): Promise<unknown> {
  return sanitize(await rawGet(resource, body));
}

const asList = (data: unknown): Rec[] =>
  Array.isArray(data) ? data as Rec[] : Array.isArray((data as { data?: unknown })?.data) ? (data as { data: Rec[] }).data : [];

/** Lista bruta (uso interno) com paginação até `max` registros. */
async function listRaw(resource: string, filter: Rec, max: number, skip = 0): Promise<Rec[]> {
  const items: Rec[] = [];
  let offset = skip;
  while (items.length < max) {
    const want = Math.min(1000, max - items.length);
    const page = asList(await rawGet(resource, { filter, options: { limit: want, skip: offset } }));
    items.push(...page);
    if (page.length < want) break;
    offset += page.length;
  }
  return items;
}

// ------------------------------------------------------------------ nomes de setor e atendente

const NAME_TTL = 10 * 60 * 1000;
const names = { setor: new Map<string, string>(), atendente: new Map<string, string>(), atendentesEm: 0 };

async function loadAtendentes() {
  if (Date.now() - names.atendentesEm < NAME_TTL) return;
  const users = await listRaw('usuario', { status: 'A' }, 1000).catch(() => [] as Rec[]);
  for (const u of users) names.atendente.set(String(u._id), String(u.nome ?? u._id) + (u.tipo === 'bot' ? ' (bot)' : ''));
  names.atendentesEm = Date.now();
}

async function resolveNames(atendimentos: Rec[]) {
  await loadAtendentes();
  const setores = [...new Set(atendimentos.map((a) => String(a.setor ?? '')).filter((id) => OBJECT_ID.test(id) && !names.setor.has(id)))];
  const atendentes = [...new Set(atendimentos.map((a) => String(a.id_atendente ?? '')).filter((id) => OBJECT_ID.test(id) && !names.atendente.has(id)))];
  await Promise.all([
    ...setores.slice(0, 50).map(async (id) => {
      const d = await rawGet(`departamento/${id}`).catch(() => null) as Rec | null;
      names.setor.set(id, String(d?.nome ?? id));
    }),
    ...atendentes.slice(0, 50).map(async (id) => {
      const u = await rawGet(`usuario/${id}`).catch(() => null) as Rec | null;
      names.atendente.set(id, u ? String(u.nome ?? id) + (u.tipo === 'bot' ? ' (bot)' : '') : `inativo/removido ${id.slice(-6)}`);
    }),
  ]);
}

const setorNome = (id: unknown) => names.setor.get(String(id)) ?? (id ? String(id) : '(sem setor)');
const atendenteNome = (id: unknown) => names.atendente.get(String(id)) ?? (id ? String(id) : '(sem atendente)');

export const OPA_STATUS: Record<string, string> = { AG: 'aguardando', EA: 'em atendimento', F: 'finalizado', PA: 'pausado', E: 'em espera' };
const statusNome = (s: unknown) => OPA_STATUS[String(s)] ?? String(s ?? '(vazio)');

/** Data em São Paulo no formato que a API aceita (AAAA-MM-DD). */
export function opaDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ConnectorError('opa', `data inválida: ${value} (use AAAA-MM-DD ou ISO 8601)`);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export interface AtendimentoFiltro {
  desde?: string; ate?: string; status?: string; protocolo?: string; setor?: string; atendente?: string;
}

/** Monta o filtro aceito pela API; setor/atendente por nome viram filtro local (a API só aceita id). */
async function buildFilter(f: AtendimentoFiltro) {
  const filter: Rec = {};
  const local: Array<(a: Rec) => boolean> = [];
  if (f.protocolo) filter.protocolo = f.protocolo.trim();
  if (f.status) filter.status = f.status.trim().toUpperCase();
  if (f.desde || f.ate) {
    const hoje = opaDate(new Date().toISOString());
    filter.dataInicialAbertura = opaDate(f.desde ?? f.ate ?? hoje);
    filter.dataFinalAbertura = opaDate(f.ate ?? hoje);
  }
  if (f.setor) {
    if (OBJECT_ID.test(f.setor)) filter.setor = f.setor;
    else { const q = norm(f.setor); local.push((a) => norm(setorNome(a.setor)).includes(q)); }
  }
  if (f.atendente) {
    if (OBJECT_ID.test(f.atendente)) filter.id_atendente = f.atendente;
    else { const q = norm(f.atendente); local.push((a) => norm(atendenteNome(a.id_atendente)).includes(q)); }
  }
  // Sem nenhum filtro a API recusa; o padrão é o dia de hoje.
  if (!Object.keys(filter).length) {
    filter.dataInicialAbertura = filter.dataFinalAbertura = opaDate(new Date().toISOString());
  }
  return { filter, local };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const minutes = (a: Rec) => {
  const ini = Date.parse(String(a.date ?? ''));
  const fim = Date.parse(String(a.fim ?? ''));
  return Number.isFinite(ini) && Number.isFinite(fim) && fim >= ini ? (fim - ini) / 60000 : undefined;
};

function compact(a: Rec) {
  const dur = minutes(a);
  return {
    id: a._id,
    protocolo: a.protocolo,
    status: statusNome(a.status),
    setor: setorNome(a.setor),
    atendente: atendenteNome(a.id_atendente),
    canal: a.canal,
    cliente_contato: a.canal_cliente ? mask(a.canal_cliente) : undefined,
    abertura: horaLocal(String(a.date)),
    ...(a.fim ? { fim: horaLocal(String(a.fim)) } : {}),
    ...(dur !== undefined ? { duracao_min: Math.round(dur) } : {}),
    ...(Array.isArray(a.motivos) && a.motivos.length ? { motivos: a.motivos.length } : {}),
    ...(a.descricao ? { descricao: String(a.descricao).slice(0, 200) } : {}),
  };
}

/** Atendimentos com filtro, os mais recentes primeiro, com nomes de setor/atendente. */
export async function opaAtendimentos(f: AtendimentoFiltro, limite = 30) {
  const { filter, local } = await buildFilter(f);
  const registros = await listRaw('atendimento', filter, 5000);
  await resolveNames(registros);
  const filtrados = registros.filter((a) => local.every((fn) => fn(a))).reverse();
  return {
    filtro_api: filter,
    total: filtrados.length,
    ...(registros.length >= 5000 ? { aviso: 'mais de 5000 atendimentos no filtro; foram lidos os 5000 primeiros. Reduza o período.' } : {}),
    mostrados: Math.min(limite, filtrados.length),
    atendimentos: filtrados.slice(0, limite).map(compact),
  };
}

/**
 * Relatório de atendimentos: total, por status, setor, atendente e canal, por dia,
 * tempo de atendimento (abertura → fim) e quantos ainda estão aguardando ou em atendimento.
 */
export async function opaAtendimentosResumo(f: AtendimentoFiltro, top = 15) {
  const { filter, local } = await buildFilter(f);
  const lidos = await listRaw('atendimento', filter, 10000);
  await resolveNames(lidos);
  const regs = lidos.filter((a) => local.every((fn) => fn(a)));

  const count = (key: (a: Rec) => string, n = top) => {
    const out: Record<string, number> = {};
    for (const a of regs) { const k = key(a); out[k] = (out[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(out).sort((x, y) => y[1] - x[1]).slice(0, n));
  };
  const durs = regs.map(minutes).filter((m): m is number => m !== undefined).sort((a, b) => a - b);
  const pct = (p: number) => Math.round(durs[Math.min(durs.length - 1, Math.floor(durs.length * p))]);

  const porAtendente = new Map<string, { atendente: string; atendimentos: number; finalizados: number; soma_min: number }>();
  for (const a of regs) {
    const nome = atendenteNome(a.id_atendente);
    const r = porAtendente.get(nome) ?? { atendente: nome, atendimentos: 0, finalizados: 0, soma_min: 0 };
    r.atendimentos++;
    const m = minutes(a);
    if (m !== undefined) { r.finalizados++; r.soma_min += m; }
    porAtendente.set(nome, r);
  }

  const agora = Date.now();
  const abertos = regs.filter((a) => a.status !== 'F');
  return {
    filtro_api: filter,
    total: regs.length,
    ...(lidos.length >= 10000 ? { aviso: 'atingiu 10000 atendimentos; o período tem mais. Reduza o intervalo.' } : {}),
    por_status: count((a) => statusNome(a.status)),
    por_setor: count((a) => setorNome(a.setor)),
    por_canal: count((a) => String(a.canal ?? '(vazio)')),
    por_dia: Object.fromEntries(Object.entries(count((a) => opaDate(String(a.date)), 62)).sort((x, y) => x[0].localeCompare(y[0]))),
    por_atendente: [...porAtendente.values()]
      .sort((a, b) => b.atendimentos - a.atendimentos).slice(0, top)
      .map((r) => ({ atendente: r.atendente, atendimentos: r.atendimentos, finalizados: r.finalizados, media_min: r.finalizados ? Math.round(r.soma_min / r.finalizados) : null })),
    duracao_finalizados_min: durs.length
      ? { finalizados: durs.length, media: Math.round(durs.reduce((s, m) => s + m, 0) / durs.length), mediana: pct(0.5), p90: pct(0.9) }
      : null,
    em_aberto: {
      total: abertos.length,
      por_status: Object.fromEntries(Object.entries(abertos.reduce<Record<string, number>>((o, a) => { const k = statusNome(a.status); o[k] = (o[k] || 0) + 1; return o; }, {}))),
      mais_antigos: abertos
        .sort((a, b) => Date.parse(String(a.date)) - Date.parse(String(b.date)))
        .slice(0, Math.min(top, 10))
        .map((a) => ({ ...compact(a), aberto_ha_min: Math.round((agora - Date.parse(String(a.date))) / 60000) })),
    },
  };
}
