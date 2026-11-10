/**
 * Conector do sistema NOC (Topologia-NOC.github.io, servido em sistema.updown.com.br).
 *
 * É a porta de entrada principal: o NOC já reúne Zabbix (espelho de interfaces e
 * tráfego), o estado GPON coletado das OLTs ZTE C300/C350, o log RADIUS, os
 * clientes sincronizados do IXC e a topologia editada pela equipe.
 *
 * Autentica como um usuário de serviço. Use um perfil só de leitura
 * (Atendimento/Analista) — o assistente nunca chama rota que altera estado.
 */

import { nocConfig } from '../config.js';
import { ConnectorError, fetchJson } from '../http.js';

let sessionToken: string | null = nocConfig.noc.token || null;
let loginInFlight: Promise<string> | null = null;

async function login(): Promise<string> {
  const { username, password, baseUrl } = nocConfig.noc;
  if (!username || !password) throw new ConnectorError('noc', 'token recusado e não há NOC_API_USER/NOC_API_PASSWORD para renovar a sessão.');
  const { data } = await fetchJson<{ token?: string; user?: { must_change_password?: boolean } }>('noc', `${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!data?.token) throw new ConnectorError('noc', 'login não devolveu token de sessão.');
  if (data.user?.must_change_password) {
    throw new ConnectorError('noc', `o usuário de serviço "${username}" precisa trocar a senha no NOC antes de ser usado pelo assistente.`);
  }
  return data.token;
}

async function ensureToken(forceRenew = false): Promise<string> {
  if (sessionToken && !forceRenew) return sessionToken;
  loginInFlight ??= login().finally(() => { loginInFlight = null; });
  sessionToken = await loginInFlight;
  return sessionToken;
}

/**
 * Escrita no sistema NOC: só as rotas de cadastro, e só chamada por acoes.ts depois que
 * um administrador confirma na tela. O NOC confere a permissão de cada mudança e grava a
 * própria auditoria. Nada de exclusão.
 */
const ESCRITA_NOC = new Set(['POST /api/clientes', 'POST /api/locais', 'PUT /api/topology']);
export async function nocSend<T = unknown>(method: 'POST' | 'PUT', pathname: string, body: unknown): Promise<T> {
  if (!ESCRITA_NOC.has(`${method} ${pathname}`)) throw new ConnectorError('noc', `${method} ${pathname} não é permitido para a NIA.`);
  const url = new URL(pathname, `${nocConfig.noc.baseUrl}/`).toString();
  const call = async (token: string) => (await fetchJson<T>('noc', url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).data;
  try {
    return await call(await ensureToken());
  } catch (error) {
    if (error instanceof ConnectorError && error.status === 401 && nocConfig.noc.username) return call(await ensureToken(true));
    if (error instanceof ConnectorError && error.status === 403) {
      throw new ConnectorError('noc', `o usuário de serviço não tem permissão para ${method} ${pathname} (${error.message}). Rode "npm run noc:criar-usuario -- --escrita" para dar as permissões de cadastro.`, 403);
    }
    throw error;
  }
}

/** GET autenticado. Renova a sessão uma vez em 401 (sessão expirada após SESSION_HOURS). */
export async function nocGet<T = unknown>(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(pathname, `${nocConfig.noc.baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const call = async (token: string) =>
    (await fetchJson<T>('noc', url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })).data;

  try {
    return await call(await ensureToken());
  } catch (error) {
    if (error instanceof ConnectorError && error.status === 401 && nocConfig.noc.username) {
      return call(await ensureToken(true));
    }
    if (error instanceof ConnectorError && error.status === 403) {
      throw new ConnectorError('noc', `o usuário de serviço não tem permissão para ${pathname}. Ajuste o perfil dele em Gerenciar plataforma → Perfis.`, 403);
    }
    throw error;
  }
}
