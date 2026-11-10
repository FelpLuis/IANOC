/**
 * Login do assistente com o usuário e a senha do sistema NOC (sistema.updown.com.br).
 *
 * O NOC valida a senha e devolve um token de sessão; aqui fica só um id de
 * sessão aleatório em cookie HttpOnly, apontando para esse token. A cada
 * poucos minutos a sessão é reconferida no /api/auth/me do NOC — usuário
 * desativado lá perde o acesso aqui.
 *
 * IANOC_AUTH=noc liga (padrão em produção); IANOC_AUTH=local aceita só o usuário de
 * IANOC_ADMIN_USER (ex.: NOC), sem login do sistema NOC; IANOC_AUTH=off desliga (desenvolvimento).
 *
 * Usuários locais (local-users.ts, ex.: administrador master) são conferidos antes do NOC.
 * Com troca de senha pendente, a sessão só acessa /api/auth/* até a senha ser trocada.
 */

import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import { nocConfig } from './noc/config.js';
import { autenticarLocal, semearAdmin, senhaFixa, trocarSenhaLocal } from './local-users.js';

export interface SessionUser { id: number | string; username: string; display_name?: string; role: string }
interface Session { user: SessionUser; nocToken: string; expiresAt: number; checkedAt: number; local?: boolean; mustChange?: boolean }

const COOKIE = 'ianoc_session';
const SESSION_MS = Number(process.env.IANOC_SESSION_HOURS || 12) * 3600_000;
const RECHECK_MS = 5 * 60_000;
const COOKIE_SECURE = /^(1|true|sim)$/i.test(process.env.COOKIE_SECURE || '');

// Perfis do NOC que podem usar o assistente. "cliente" (assinante do app) nunca entra.
const ALLOWED_ROLES = (process.env.IANOC_ALLOWED_ROLES || 'administrador,analista,tecnico,atendimento,logistica')
  .split(',').map((r) => r.trim().toLowerCase()).filter((r) => r && r !== 'cliente');

const AUTH_MODE = (process.env.IANOC_AUTH || (process.env.NODE_ENV === 'production' ? 'noc' : 'off')).trim().toLowerCase();
export const authEnabled = AUTH_MODE !== 'off';
// IANOC_AUTH=local: só o usuário de IANOC_ADMIN_USER entra (ex.: NOC); o login do sistema NOC
// e os demais usuários locais ficam desligados.
const SOMENTE_ADMIN = AUTH_MODE === 'local';
const ADMIN_USER = (process.env.IANOC_ADMIN_USER || '').trim().toLowerCase();

const sessions = new Map<string, Session>();

if (authEnabled) semearAdmin();

// ---------------------------------------------------------------- IPs de origem liberados

// IANOC_ALLOWED_IPS=190.111.111.65,10.0.0.0/24 — vazio libera qualquer origem.
// Segunda camada: o firewall do servidor já filtra a porta (deploy/firewall.sh).
const ALLOWED_IPS = (process.env.IANOC_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);

function ipv4ToInt(ip: string) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
    : null;
}

const loopback = (ip: string) => ip === '127.0.0.1' || ip === '::1';

/**
 * IP real do cliente. Atrás do Caddy (HTTPS no subdomínio) a conexão vem de 127.0.0.1 e o
 * IP do cliente chega em X-Forwarded-For; o Caddy descarta o cabeçalho que o cliente mandar
 * e acrescenta o endereço verdadeiro no fim, então vale o último da lista. Só se confia no
 * cabeçalho quando a conexão é local (o próprio Caddy).
 */
export function clientIp(remote: string | undefined, forwarded: string | string[] | undefined): string {
  const ip = String(remote || '').replace(/^::ffff:/, '');
  const xff = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (loopback(ip) && xff) {
    const ultimo = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (ultimo) return ultimo.replace(/^::ffff:/, '');
  }
  return ip;
}

/**
 * IANOC_ACESSO_PUBLICO=sim: quem chega pelo HTTPS do próprio servidor (Caddy, conexão local
 * com X-Forwarded-For e X-Forwarded-Proto https) entra de qualquer rede — o login protege.
 * A porta HTTP direta (sem criptografia) continua só para os IPs de IANOC_ALLOWED_IPS.
 */
const ACESSO_PUBLICO = /^(1|s|sim|true|yes|on)$/i.test((process.env.IANOC_ACESSO_PUBLICO || '').trim());
export const acessoPublico = ACESSO_PUBLICO;

function viaHttpsLocal(remote: string | undefined, forwarded?: string | string[], proto?: string | string[]) {
  const ip = String(remote || '').replace(/^::ffff:/, '');
  const p = (Array.isArray(proto) ? proto.join(',') : proto || '').toLowerCase();
  return loopback(ip) && Boolean(forwarded) && p.split(',').map((s) => s.trim()).includes('https');
}

export function ipAllowed(remote: string | undefined, forwarded?: string | string[], proto?: string | string[]): boolean {
  if (!ALLOWED_IPS.length) return true;
  if (ACESSO_PUBLICO && viaHttpsLocal(remote, forwarded, proto)) return true;
  const ip = clientIp(remote, forwarded);
  if (loopback(ip)) return true; // health check local do install.sh (sem X-Forwarded-For)
  return ALLOWED_IPS.some((rule) => {
    const [base, bits] = rule.split('/');
    if (!bits) return base === ip;
    const a = ipv4ToInt(base), b = ipv4ToInt(ip), n = Number(bits);
    if (a === null || b === null || !(n >= 0 && n <= 32)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (a & mask) === (b & mask);
  });
}

// ---------------------------------------------------------------- limite de tentativas (por IP)

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10, WINDOW_MS = 15 * 60_000;
// Erros de senha por usuário, de qualquer IP: freia tentativa distribuída contra o mesmo login.
const MAX_FALHAS_USUARIO = 30;

function tooManyAttempts(chave: string, max = MAX_ATTEMPTS) {
  const now = Date.now();
  const a = attempts.get(chave);
  if (!a || a.resetAt < now) { attempts.set(chave, { count: 1, resetAt: now + WINDOW_MS }); return false; }
  a.count++;
  return a.count > max;
}
const bloqueado = (chave: string, max = MAX_ATTEMPTS) => { const a = attempts.get(chave); return Boolean(a && a.resetAt >= Date.now() && a.count > max); };

/** IP real de quem chamou (atrás do Caddy, o do cabeçalho; senão, o da conexão). */
const ipDe = (req: Request) => clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);

// ---------------------------------------------------------------- NOC

async function nocFetch(path: string, init: RequestInit = {}) {
  return fetch(`${nocConfig.noc.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
}

function readCookie(header: string | undefined, name: string) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Registro da sessão do cookie (com a pendência de troca de senha). */
async function sessionRecord(cookieHeader: string | undefined): Promise<Session | null> {
  const id = readCookie(cookieHeader, COOKIE);
  const s = id ? sessions.get(id) : undefined;
  if (!id || !s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(id); return null; }
  if (!s.local && Date.now() - s.checkedAt > RECHECK_MS) {
    try {
      const r = await nocFetch('/api/auth/me', { headers: { Authorization: `Bearer ${s.nocToken}` } });
      if (r.status === 401 || r.status === 403) { sessions.delete(id); return null; }
      s.checkedAt = Date.now();
    } catch {
      // NOC fora do ar não derruba quem já entrou; a sessão continua até expirar.
    }
  }
  return s;
}

/** Sessão válida para o cabeçalho Cookie, reconferindo no NOC quando necessário. */
export async function sessionFromCookie(cookieHeader: string | undefined): Promise<SessionUser | null> {
  return (await sessionRecord(cookieHeader))?.user ?? null;
}

// Pelo HTTPS (Caddy) o cookie sai com Secure: o navegador nunca o manda em HTTP aberto.
function cookie(value: string, maxAgeS: number, req?: Request) {
  const seguro = COOKIE_SECURE || (req ? viaHttpsLocal(req.socket.remoteAddress, req.headers['x-forwarded-for'], req.headers['x-forwarded-proto']) : false);
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${seguro ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------- rotas

export async function handleLogin(req: Request, res: Response) {
  if (!authEnabled) return res.json({ ok: true, user: { username: 'dev', role: 'administrador' } });
  if (tooManyAttempts(ipDe(req))) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
  const chaveUsuario = `usuario:${username.toLowerCase()}`;
  if (bloqueado(chaveUsuario, MAX_FALHAS_USUARIO)) return res.status(429).json({ error: 'Muitas tentativas para este usuário. Aguarde 15 minutos.' });

  if (SOMENTE_ADMIN && (!ADMIN_USER || username.toLowerCase() !== ADMIN_USER)) {
    console.warn(`[auth] login recusado (só ${ADMIN_USER || 'o usuário do .env'} entra): ${username} (${ipDe(req)})`);
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }

  // Usuário local (administrador master etc.) vem antes do NOC.
  const local = autenticarLocal(username, password);
  if (local) {
    if (!('user' in local)) {
      console.warn(`[auth] senha local incorreta: ${username} (${ipDe(req)})`);
      tooManyAttempts(chaveUsuario, MAX_FALHAS_USUARIO);
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }
    const id = randomBytes(32).toString('hex');
    const user: SessionUser = { id: `local:${local.user.username}`, username: local.user.username, display_name: local.user.display_name, role: local.user.role };
    sessions.set(id, { user, nocToken: '', expiresAt: Date.now() + SESSION_MS, checkedAt: Date.now(), local: true, mustChange: local.user.mustChange });
    attempts.delete(ipDe(req));
    console.log(`[auth] login local: ${user.username} de ${ipDe(req)}${local.user.mustChange ? ' (troca de senha pendente)' : ''}`);
    res.setHeader('Set-Cookie', cookie(id, Math.floor(SESSION_MS / 1000), req));
    return res.json({ ok: true, user, mustChangePassword: local.user.mustChange });
  }

  if (SOMENTE_ADMIN || !nocConfig.noc.baseUrl) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });

  let data: { token?: string; user?: SessionUser & { must_change_password?: boolean }; error?: string };
  let status: number;
  try {
    const r = await nocFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    status = r.status;
    data = (await r.json().catch(() => ({}))) as typeof data;
  } catch {
    return res.status(502).json({ error: 'Não foi possível falar com o sistema NOC para validar o login.' });
  }

  if (status === 429) return res.status(429).json({ error: 'O NOC bloqueou novas tentativas para este usuário. Aguarde 15 minutos.' });
  if (status !== 200 || !data.token || !data.user) {
    console.warn(`[auth] login recusado: ${username} (${ipDe(req)})`);
    tooManyAttempts(chaveUsuario, MAX_FALHAS_USUARIO);
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  if (data.user.must_change_password) {
    return res.status(403).json({ error: 'Troque sua senha no sistema NOC antes de usar o assistente.' });
  }
  const role = String(data.user.role || '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    console.warn(`[auth] perfil sem acesso: ${username} (${role})`);
    return res.status(403).json({ error: 'Seu perfil no NOC não tem acesso ao assistente.' });
  }

  const id = randomBytes(32).toString('hex');
  const user: SessionUser = { id: data.user.id, username: data.user.username, display_name: data.user.display_name, role };
  sessions.set(id, { user, nocToken: data.token, expiresAt: Date.now() + SESSION_MS, checkedAt: Date.now() });
  attempts.delete(ipDe(req));
  console.log(`[auth] login: ${user.username} (${role}) de ${ipDe(req)}`);
  res.setHeader('Set-Cookie', cookie(id, Math.floor(SESSION_MS / 1000), req));
  res.json({ ok: true, user });
}

export async function handleMe(req: Request, res: Response) {
  if (!authEnabled) return res.json({ authenticated: true, user: { username: 'dev', role: 'administrador' }, authEnabled });
  const s = await sessionRecord(req.headers.cookie);
  if (!s) return res.status(401).json({ authenticated: false, authEnabled });
  res.json({ authenticated: true, user: s.user, authEnabled, mustChangePassword: Boolean(s.mustChange) });
}

/** Troca de senha do usuário local (obrigatória no primeiro acesso do administrador master). */
export async function handlePassword(req: Request, res: Response) {
  if (!authEnabled) return res.status(400).json({ error: 'Login desligado neste ambiente.' });
  const id = readCookie(req.headers.cookie, COOKIE);
  const s = await sessionRecord(req.headers.cookie);
  if (!id || !s) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  if (!s.local) return res.status(400).json({ error: 'Troque a senha no sistema NOC.' });
  if (senhaFixa && s.user.username.toLowerCase() === ADMIN_USER) return res.status(400).json({ error: 'A senha deste usuário é fixa (definida no servidor).' });
  if (tooManyAttempts(`senha:${ipDe(req)}`)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const atual = String(req.body?.current || '');
  const nova = String(req.body?.next || '');
  const erro = trocarSenhaLocal(s.user.username, atual, nova);
  if (erro) return res.status(400).json({ error: erro });
  // Outras sessões deste usuário caem; a atual continua, já sem pendência.
  for (const [sid, other] of sessions) if (sid !== id && other.local && other.user.username === s.user.username) sessions.delete(sid);
  s.mustChange = false;
  console.log(`[auth] senha trocada: ${s.user.username} (${ipDe(req)})`);
  res.json({ ok: true });
}

export async function handleLogout(req: Request, res: Response) {
  const id = readCookie(req.headers.cookie, COOKIE);
  const s = id ? sessions.get(id) : undefined;
  if (id) sessions.delete(id);
  if (s) nocFetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${s.nocToken}` } }).catch(() => {});
  res.setHeader('Set-Cookie', cookie('', 0, req));
  res.json({ ok: true });
}

/** Protege as rotas /api (exceto login/health). */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled) return next();
  const s = await sessionRecord(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  if (s.mustChange) return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED' });
  res.locals.user = s.user;
  next();
}

/** Autentica o upgrade do WebSocket: cookie de sessão válido e mesma origem. */
export async function authenticateUpgrade(req: IncomingMessage): Promise<SessionUser | null> {
  if (!ipAllowed(req.socket.remoteAddress, req.headers['x-forwarded-for'], req.headers['x-forwarded-proto'])) return null;
  if (!authEnabled) return { id: 0, username: 'dev', role: 'administrador' };
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return null;
  const s = await sessionRecord(req.headers.cookie);
  return s && !s.mustChange ? s.user : null;
}

// Limpeza periódica de sessões e tentativas vencidas.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
  for (const [ip, a] of attempts) if (a.resetAt < now) attempts.delete(ip);
}, 10 * 60_000).unref();
