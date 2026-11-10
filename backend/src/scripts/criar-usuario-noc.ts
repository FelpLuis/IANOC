/**
 * Cria no sistema NOC o usuário de serviço do assistente e grava as credenciais
 * em backend/.env.
 *
 *   npm run noc:criar-usuario
 *
 * Pede usuário e senha de um administrador (não ficam salvos em lugar nenhum) e:
 *   1. cria o perfil `ianoc_leitura` só com topology.view, zabbix.view,
 *      clientes.view e radius.view (sem telas: o assistente usa só a API);
 *   2. cria o usuário `ianoc-servico` com esse perfil;
 *   3. faz a troca de senha obrigatória do primeiro acesso, com uma senha
 *      aleatória que nunca aparece na tela;
 *   4. grava NOC_API_USER e NOC_API_PASSWORD no .env.
 *
 * Rodar de novo com o usuário já existente só reaplica as permissões do perfil.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROLE = 'ianoc_leitura';
const USERNAME = process.env.NOC_SERVICE_USERNAME || 'ianoc-servico';
const PERMISSIONS = ['topology.view', 'zabbix.view', 'clientes.view', 'radius.view'];
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
const baseUrl = String(process.env.NOC_API_URL || '').trim().replace(/\/+$/, '');

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    if (hidden) process.stdout.write('\n');
    resolve(answer.trim());
  }));
}

async function api<T = any>(method: string, pathname: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* corpo vazio */ }
  return { status: res.status, data };
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const newPassword = () => randomBytes(24).toString('base64url');

function writeEnv(values: Record<string, string>) {
  let env = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, () => `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, env);
}

async function main() {
  if (!baseUrl) fail('NOC_API_URL vazio em backend/.env.');
  console.log(`Sistema NOC: ${baseUrl}`);
  console.log(`Será criado o usuário "${USERNAME}" com o perfil "${ROLE}" (${PERMISSIONS.join(', ')}).\n`);

  const adminUser = await ask('Usuário administrador: ');
  const adminPass = await ask('Senha: ', true);
  const login = await api('POST', '/api/auth/login', undefined, { username: adminUser, password: adminPass });
  if (login.status !== 200 || !login.data?.token) fail(`login recusado (${login.status} ${login.data?.error || ''}).`);
  if (login.data.user?.must_change_password) fail('esse administrador precisa trocar a senha no NOC antes.');
  const admin = login.data.token as string;

  try {
    // 1. Perfil
    let roles = await api('GET', '/api/platform/roles', admin);
    if (roles.status !== 200) fail(`sem acesso a Perfis (${roles.status}). Use um administrador com roles.manage e users.manage.`);
    let role = roles.data.roles.find((r: any) => r.name === ROLE);
    if (!role) {
      const created = await api('POST', '/api/platform/roles', admin, {
        name: ROLE,
        description: 'Usuário de serviço do assistente IA NOC: somente leitura.',
      });
      if (created.status !== 201) fail(`não criou o perfil (${created.status} ${created.data?.error || ''}).`);
      role = created.data;
      console.log(`✓ perfil ${ROLE} criado`);
    } else {
      console.log(`• perfil ${ROLE} já existia`);
    }

    const ids = PERMISSIONS.map((code) => roles.data.permissions.find((p: any) => p.code === code)?.id);
    const missing = PERMISSIONS.filter((_, i) => !ids[i]);
    if (missing.length) fail(`permissões inexistentes no NOC: ${missing.join(', ')}.`);
    const access = await api('PUT', `/api/platform/roles/${role.id}/access`, admin, { permissionIds: ids, screenIds: [] });
    if (access.status !== 200) fail(`não gravou as permissões (${access.status} ${access.data?.error || ''}).`);
    console.log(`✓ permissões aplicadas: ${PERMISSIONS.join(', ')}`);

    // 2. Usuário
    const initial = newPassword();
    const user = await api('POST', '/api/users', admin, {
      username: USERNAME,
      display_name: 'IA NOC (serviço)',
      role: ROLE,
      password: initial,
    });
    if (user.status === 409) {
      console.log(`\n• o usuário ${USERNAME} já existe; o perfil foi atualizado e nada mais foi alterado.`);
      console.log('  Para gerar credenciais novas, redefina a senha dele em Gerenciar plataforma → Usuários,');
      console.log('  ou apague-o e rode este script de novo.');
      return;
    }
    if (user.status !== 201) fail(`não criou o usuário (${user.status} ${user.data?.error || ''}).`);
    console.log(`✓ usuário ${USERNAME} criado`);

    // 3. Troca de senha obrigatória do primeiro acesso
    const first = await api('POST', '/api/auth/login', undefined, { username: USERNAME, password: initial });
    if (!first.data?.token) fail(`o usuário novo não conseguiu entrar (${first.status}).`);
    const finalPassword = newPassword();
    const changed = await api('POST', '/api/auth/change-password', first.data.token, { oldPassword: initial, newPassword: finalPassword });
    if (changed.status !== 200) fail(`troca de senha recusada (${changed.status} ${changed.data?.error || ''}).`);
    await api('POST', '/api/auth/logout', first.data.token);

    // Confere o acesso final antes de gravar.
    const check = await api('POST', '/api/auth/login', undefined, { username: USERNAME, password: finalPassword });
    if (!check.data?.token || check.data.user?.must_change_password) fail('a conferência do login final falhou.');
    await api('POST', '/api/auth/logout', check.data.token);

    // 4. .env
    writeEnv({ NOC_API_USER: USERNAME, NOC_API_PASSWORD: finalPassword });
    console.log('✓ NOC_API_USER e NOC_API_PASSWORD gravados em backend/.env');
    console.log('\nPronto. Confira com: npm run noc:selftest');
  } finally {
    await api('POST', '/api/auth/logout', admin);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
