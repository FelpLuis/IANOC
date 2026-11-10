/**
 * Usuários locais da NIA, independentes do sistema NOC (ex.: administrador master).
 *
 * Ficam em <pasta do DB_PATH>/usuarios.json (no servidor: /var/lib/ianoc/usuarios.json),
 * com a senha só como hash scrypt (sal aleatório por usuário). Nada de senha em texto.
 *
 * Administrador master: na partida, se IANOC_ADMIN_USER ainda não existe no arquivo e
 * IANOC_ADMIN_PASSWORD está definido, ele é criado com essa senha inicial e com troca
 * obrigatória no primeiro acesso. Depois que existe, o .env deixa de valer para ele.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LocalUser {
  username: string;
  display_name?: string;
  role: string;
  hash: string;              // scrypt$<sal hex>$<hash hex>
  mustChange: boolean;
  createdAt: string;
  passwordChangedAt?: string;
}

const ARQUIVO = path.join(path.dirname(process.env.DB_PATH || './data/agent.json'), 'usuarios.json');

function ler(): LocalUser[] {
  try { return existsSync(ARQUIVO) ? (JSON.parse(readFileSync(ARQUIVO, 'utf8')) as LocalUser[]) : []; } catch { return []; }
}

function gravar(users: LocalUser[]) {
  mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  const tmp = `${ARQUIVO}.tmp`;
  writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  renameSync(tmp, ARQUIVO);
}

export function hashSenha(senha: string): string {
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('hex')}$${scryptSync(senha, sal, 64).toString('hex')}`;
}

function confere(senha: string, hash: string): boolean {
  const [alg, salHex, hHex] = hash.split('$');
  if (alg !== 'scrypt' || !salHex || !hHex) return false;
  const esperado = Buffer.from(hHex, 'hex');
  const calculado = scryptSync(senha, Buffer.from(salHex, 'hex'), esperado.length);
  return timingSafeEqual(esperado, calculado);
}

const igual = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Senha fixa: com IANOC_ADMIN_TROCA_SENHA=nao a senha do .env vale sempre (sem troca no
 * primeiro acesso) e, se mudar no .env, o hash é atualizado na próxima partida.
 */
export const senhaFixa = /^(0|n|nao|não|false|no|off)$/i.test((process.env.IANOC_ADMIN_TROCA_SENHA || '').trim());

/** Cria o administrador master do .env, se ainda não existir (e sincroniza a senha fixa). */
export function semearAdmin() {
  const username = (process.env.IANOC_ADMIN_USER || '').trim();
  const senha = process.env.IANOC_ADMIN_PASSWORD || '';
  if (!username || !senha) return;
  const users = ler();
  const existente = users.find((u) => igual(u.username, username));
  if (existente) {
    if (senhaFixa && (existente.mustChange || !confere(senha, existente.hash) || existente.role !== 'administrador')) {
      existente.hash = hashSenha(senha);
      existente.mustChange = false;
      existente.role = 'administrador';
      existente.display_name = process.env.IANOC_ADMIN_NAME || existente.display_name;
      existente.passwordChangedAt = new Date().toISOString();
      gravar(users);
      console.log(`[auth] senha fixa de "${username}" sincronizada com o .env.`);
    }
    return;
  }
  users.push({
    username,
    display_name: process.env.IANOC_ADMIN_NAME || username,
    role: 'administrador',
    hash: hashSenha(senha),
    mustChange: !senhaFixa,
    createdAt: new Date().toISOString(),
  });
  gravar(users);
  console.log(`[auth] administrador "${username}" criado${senhaFixa ? ' com senha fixa' : '; troca de senha obrigatória no primeiro acesso'}.`);
}

/** Usuário local com a senha conferida, ou null (não existe ou senha errada). */
export function autenticarLocal(username: string, senha: string): { user: LocalUser } | { existe: true; ok: false } | null {
  const u = ler().find((x) => igual(x.username, username));
  if (!u) return null;
  return confere(senha, u.hash) ? { user: u } : { existe: true, ok: false };
}

export function existeLocal(username: string) {
  return ler().some((x) => igual(x.username, username));
}

/** Regras da senha nova; devolve o motivo da recusa ou null. */
export function problemaNaSenha(username: string, atual: string, nova: string): string | null {
  if (nova.length < 10) return 'A senha nova precisa ter pelo menos 10 caracteres.';
  if (!/[a-z]/.test(nova) || !/[A-Z]/.test(nova) || !/\d/.test(nova)) return 'Use letras maiúsculas, minúsculas e números.';
  if (nova === atual) return 'A senha nova precisa ser diferente da atual.';
  if (nova.toLowerCase().includes(username.toLowerCase().split(/[.@_-]/)[0])) return 'A senha não pode conter o seu usuário.';
  return null;
}

export function trocarSenhaLocal(username: string, atual: string, nova: string): string | null {
  const users = ler();
  const u = users.find((x) => igual(x.username, username));
  if (!u) return 'Usuário não encontrado.';
  if (!confere(atual, u.hash)) return 'Senha atual incorreta.';
  const problema = problemaNaSenha(u.username, atual, nova);
  if (problema) return problema;
  u.hash = hashSenha(nova);
  u.mustChange = false;
  u.passwordChangedAt = new Date().toISOString();
  gravar(users);
  return null;
}
