/**
 * Conector da Documentação de equipamentos do NOC (nocup/documentacao),
 * servida em documentacao.noc.updown.com.br. Substitui o sistema NOC
 * (sistema.updown.com.br) como fonte do backbone para o assistente.
 *
 * O que a documentação entrega:
 *   GET /api/dados   → { doc: { devices: [{ id, name, model, site, role, mgmt, rack, notes,
 *                        zabbix_hosts[], ports: [{ i, d, s, o, st }] }] } }
 *   GET /api/zabbix  → { synced, hosts: { <nome>: { hostid, name, ip, ping, model, version,
 *                        ifs: [{ i, a, st, sp, rx, tx, in, out, onus, rxm, low, worst }] } } }
 *
 * Autenticação (DOC_AUTH):
 *   portal → entra no Portal NOC (login único) com o usuário de serviço e manda o cookie
 *            updown_sso; o nginx da documentação valida no portal.
 *   local  → login próprio da documentação (POST /login), cookie doc_noc.
 *   nenhum → documentação sem login (só rede interna).
 *
 * Só leitura: o assistente nunca grava na documentação.
 */

import { nocConfig } from '../config.js';
import { ConnectorError, fetchJson } from '../http.js';

export interface DocPorta { i: string; d?: string; s?: string; o?: string; st?: string }
export interface DocDevice {
  id: string; name: string; model?: string; site?: string; role?: string; mgmt?: string;
  rack?: string; notes?: string; zabbix_hosts?: string[]; ports?: DocPorta[];
}
export interface DocIf {
  i: string; a?: string; st?: string; sp?: string; rx?: string; tx?: string; in?: number; out?: number;
  onus?: string | number; rxm?: string; low?: string | number; worst?: string;
}
export interface DocHost { hostid: string; name: string; host?: string; ip?: string; ping?: string; model?: string; version?: string; sysname?: string; location?: string; ifs: DocIf[] }
export interface DocZabbix { synced: string | null; erro?: string | null; intervalo_min?: number; hosts: Record<string, DocHost>; nao_encontrados?: string[] }

let cookie: string | null = null;
let loginInFlight: Promise<string> | null = null;

function cookieDe(res: Response, nome: string): string | null {
  const lista = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const linha of lista) {
    const par = linha.split(';')[0]?.trim() ?? '';
    if (par.startsWith(`${nome}=`) && par.length > nome.length + 1) return par;
  }
  return null;
}

async function login(): Promise<string> {
  const { baseUrl, auth, loginUrl, username, password } = nocConfig.doc;
  if (auth === 'nenhum') return '';
  if (!username || !password) throw new ConnectorError('doc', 'faltam DOC_API_USER e DOC_API_PASSWORD (usuário de serviço) para entrar na documentação.');

  const portal = auth === 'portal';
  const url = portal ? `${loginUrl}/api/login` : `${baseUrl}/login`;
  const body = portal ? { username, password } : { usuario: username, senha: password, manter: true };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(portal ? { 'X-Portal': '1' } : {}) },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(nocConfig.http.timeoutMs),
    });
  } catch (error) {
    throw new ConnectorError('doc', `sem resposta de ${new URL(url).host}: ${error instanceof Error ? error.message : error}`);
  }
  const c = cookieDe(res, portal ? 'updown_sso' : 'doc_noc');
  if (!res.ok && !(res.status >= 300 && res.status < 400) || !c) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    throw new ConnectorError('doc', `login do usuário de serviço "${username}" recusado ${portal ? 'pelo Portal NOC' : 'pela documentação'} (HTTP ${res.status}) ${txt}`, res.status);
  }
  return c;
}

async function ensureCookie(forceRenew = false): Promise<string> {
  if (cookie !== null && !forceRenew) return cookie;
  loginInFlight ??= login().finally(() => { loginInFlight = null; });
  cookie = await loginInFlight;
  return cookie;
}

/** GET autenticado na documentação. Renova a sessão uma vez em 401/302 (sessão expirada). */
export async function docGet<T = unknown>(pathname: string): Promise<T> {
  const url = new URL(pathname, `${nocConfig.doc.baseUrl}/`).toString();
  const call = async (c: string) => (await fetchJson<T>('doc', url, {
    headers: { Accept: 'application/json', ...(c ? { Cookie: c } : {}) },
    redirect: 'manual',
  })).data;
  try {
    const data = await call(await ensureCookie());
    // nginx do portal redireciona para o login quando a sessão não vale: vem 302 com corpo vazio.
    if (data === null || typeof data === 'string') throw new ConnectorError('doc', 'sessão expirada', 401);
    return data;
  } catch (error) {
    if (error instanceof ConnectorError && (error.status === 401 || error.status === 302) && nocConfig.doc.auth !== 'nenhum') {
      return call(await ensureCookie(true));
    }
    if (error instanceof ConnectorError && error.status === 403) {
      throw new ConnectorError('doc', `o usuário de serviço não tem acesso à documentação no Portal NOC (libere o sistema "documentacao" para ele).`, 403);
    }
    throw error;
  }
}

// Cache curto: a documentação muda pouco e o Zabbix dela já é um espelho periódico.
const CACHE_MS = 60_000;
let dadosCache: { at: number; v: DocDevice[] } | null = null;
let zbxCache: { at: number; v: DocZabbix } | null = null;

export async function docDevices(force = false): Promise<DocDevice[]> {
  if (!force && dadosCache && Date.now() - dadosCache.at < CACHE_MS) return dadosCache.v;
  const r = await docGet<{ doc?: { devices?: DocDevice[] } }>('/api/dados');
  const v = Array.isArray(r?.doc?.devices) ? r.doc!.devices! : [];
  dadosCache = { at: Date.now(), v };
  return v;
}

export async function docZabbix(force = false): Promise<DocZabbix> {
  if (!force && zbxCache && Date.now() - zbxCache.at < CACHE_MS) return zbxCache.v;
  const r = await docGet<DocZabbix>('/api/zabbix');
  const v: DocZabbix = { synced: r?.synced ?? null, erro: r?.erro ?? null, intervalo_min: r?.intervalo_min, hosts: r?.hosts ?? {}, nao_encontrados: r?.nao_encontrados ?? [] };
  zbxCache = { at: Date.now(), v };
  return v;
}

/** Interfaces do Zabbix de um equipamento da documentação (todos os hosts ligados a ele), por nome. */
export function ifsDoEquipamento(d: DocDevice, z: DocZabbix): Map<string, DocIf & { host: string }> {
  const out = new Map<string, DocIf & { host: string }>();
  for (const h of d.zabbix_hosts ?? []) {
    const H = z.hosts[h];
    if (!H) continue;
    for (const f of H.ifs ?? []) if (!out.has(f.i)) out.set(f.i, { ...f, host: H.name });
  }
  return out;
}
