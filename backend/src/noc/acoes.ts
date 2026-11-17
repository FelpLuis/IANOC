/**
 * Ações de cadastro da NIA (as únicas que escrevem em sistema externo).
 *
 * Fluxo: a NIA monta a proposta a partir da conversa e confere tudo o que dá para
 * conferir antes (grupo e template existem no Zabbix? equipamento existe na topologia?
 * porta livre?). A proposta vira um cartão com todos os campos na tela. Só quando um
 * ADMINISTRADOR clica em Confirmar a ação é executada — uma vez, em até 15 minutos.
 * Cada proposta, confirmação, cancelamento e resultado vai para o log de auditoria
 * (<dados>/auditoria.log, uma linha JSON por evento).
 *
 * Escrita liberada: só Zabbix host.create. Nada de alteração ou exclusão.
 * (Os cadastros de cliente, POP, equipamento e enlace gravavam no sistema NOC —
 * sistema.updown.com.br —, que saiu do ar; equipamentos e enlaces agora se documentam
 * em documentacao.noc.updown.com.br e clientes no IXC.)
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { zabbixCall, zabbixWrite } from './connectors/zabbix.js';
import { connectorEnabled, nocConfig } from './config.js';

export type TipoAcao = 'zabbix_host';
export interface Campo { rotulo: string; valor: string }
export interface AcaoPublica { id: string; tipo: TipoAcao; titulo: string; campos: Campo[]; avisos: string[]; expiraEm: number }
interface Acao extends AcaoPublica { payload: Record<string, unknown>; criadoEm: number; conversa: string }

const TTL_MS = 15 * 60_000;
const pendentes = new Map<string, Acao>();
const LOG = path.join(path.dirname(process.env.DB_PATH || './data/agent.json'), 'auditoria.log');

export function auditar(evento: string, dados: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify({ em: new Date().toISOString(), evento, ...dados })}\n`, { mode: 0o640 });
  } catch (e) {
    console.warn('[auditoria] não gravou:', e instanceof Error ? e.message : e);
  }
}

function registrar(conversa: string, tipo: TipoAcao, titulo: string, campos: Campo[], payload: Record<string, unknown>, avisos: string[] = []): AcaoPublica {
  const agora = Date.now();
  for (const [id, a] of pendentes) if (agora - a.criadoEm > TTL_MS) pendentes.delete(id);
  const acao: Acao = { id: randomUUID().slice(0, 12), tipo, titulo, campos: campos.filter((c) => c.valor), avisos, payload, criadoEm: agora, expiraEm: agora + TTL_MS, conversa };
  pendentes.set(acao.id, acao);
  auditar('PROPOSTA', { acao: acao.id, tipo, titulo, campos: acao.campos, conversa });
  const { payload: _p, criadoEm: _c, conversa: _v, ...publica } = acao;
  return publica;
}

export class PropostaInvalida extends Error {}

const palavras = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

// ------------------------------------------------------------------ Zabbix: host

export interface DadosHost { nome: string; ip: string; grupo: string; template?: string; interface?: 'agente' | 'snmp' | 'icmp'; comunidade?: string; instancia?: string }

export async function proporHostZabbix(conversa: string, d: DadosHost): Promise<AcaoPublica> {
  if (!connectorEnabled('zabbix')) throw new PropostaInvalida('O Zabbix não está configurado neste servidor.');
  const instancia = d.instancia || nocConfig.zabbix[0]?.nome;
  const tecnico = d.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128);
  const existe = await zabbixCall<Array<{ hostid: string }>>('host.get', { output: ['hostid'], filter: { host: [tecnico] } }, instancia);
  if (existe.length) throw new PropostaInvalida(`Já existe um host "${tecnico}" no Zabbix ${instancia}.`);

  const todosGrupos = await zabbixCall<Array<{ groupid: string; name: string }>>('hostgroup.get', { output: ['groupid', 'name'], limit: 500 }, instancia);
  const wg = palavras(d.grupo);
  const grupos = todosGrupos.filter((g) => wg.every((w) => palavras(g.name).some((x) => x.startsWith(w))));
  const grupo = grupos.find((g) => g.name.toLowerCase() === d.grupo.toLowerCase()) ?? (grupos.length === 1 ? grupos[0] : undefined);
  if (!grupo) {
    const todos = await zabbixCall<Array<{ name: string }>>('hostgroup.get', { output: ['name'], limit: 40 }, instancia);
    throw new PropostaInvalida(`Grupo "${d.grupo}" não encontrado${grupos.length > 1 ? ` (vários parecidos: ${grupos.map((g) => g.name).join(', ')})` : ''}. Grupos existentes: ${todos.map((g) => g.name).join(', ')}.`);
  }
  let template: { templateid: string; name: string } | undefined;
  if (d.template) {
    // Casa por palavras em qualquer ordem: "ICMP Ping" acha "Template Ping ICMP".
    const ts = await zabbixCall<Array<{ templateid: string; name: string }>>('template.get', { output: ['templateid', 'name'], limit: 3000 }, instancia);
    const ws = palavras(d.template);
    const candidatos = ts.filter((t) => ws.every((w) => palavras(t.name).some((x) => x.startsWith(w))));
    template = candidatos.find((t) => t.name.toLowerCase() === d.template!.toLowerCase())
      ?? candidatos.sort((a, b) => a.name.length - b.name.length)[0];
    if (!template) {
      const parecidos = ts.filter((t) => ws.some((w) => palavras(t.name).some((x) => x.startsWith(w)))).slice(0, 8).map((t) => t.name);
      throw new PropostaInvalida(`Template "${d.template}" não encontrado no Zabbix ${instancia}.${parecidos.length ? ` Parecidos: ${parecidos.join(', ')}.` : ''}`);
    }
  }
  const tipo = d.interface ?? (d.comunidade ? 'snmp' : 'agente');
  const iface = tipo === 'snmp'
    ? { type: 2, main: 1, useip: 1, ip: d.ip, dns: '', port: '161', details: { version: 2, bulk: 1, community: d.comunidade || '{$SNMP_COMMUNITY}' } }
    : { type: 1, main: 1, useip: 1, ip: d.ip, dns: '', port: '10050' };
  const params = { host: tecnico, name: d.nome, groups: [{ groupid: grupo.groupid }], interfaces: [iface], ...(template ? { templates: [{ templateid: template.templateid }] } : {}) };
  return registrar(conversa, 'zabbix_host', `Cadastrar host no Zabbix (${instancia})`, [
    { rotulo: 'Nome', valor: d.nome },
    { rotulo: 'Nome técnico', valor: tecnico },
    { rotulo: 'IP', valor: d.ip },
    { rotulo: 'Interface', valor: tipo === 'snmp' ? `SNMP v2 (porta 161${d.comunidade ? '' : ', comunidade {$SNMP_COMMUNITY}'})` : tipo === 'icmp' ? 'Agente/ICMP (porta 10050)' : 'Agente Zabbix (porta 10050)' },
    { rotulo: 'Grupo', valor: grupo.name },
    { rotulo: 'Template', valor: template?.name ?? '— (sem template)' },
  ], { metodo: 'host.create', params, instancia }, template ? [] : ['Sem template o host é cadastrado, mas não coleta nada até receber um template.']);
}

// ------------------------------------------------------------------ confirmar / cancelar

export function cancelar(id: string, usuario: string): boolean {
  const a = pendentes.get(id);
  if (!a) return false;
  pendentes.delete(id);
  auditar('CANCELADA', { acao: id, tipo: a.tipo, usuario });
  return true;
}

export async function confirmar(id: string, usuario: string, ip: string): Promise<{ ok: boolean; mensagem: string }> {
  const a = pendentes.get(id);
  if (!a) return { ok: false, mensagem: 'Essa proposta não existe mais (já foi usada, cancelada ou passou de 15 minutos). Peça de novo à NIA.' };
  pendentes.delete(id);   // uso único, mesmo se falhar
  if (Date.now() > a.expiraEm) return { ok: false, mensagem: 'A proposta expirou (15 minutos). Peça de novo à NIA.' };
  auditar('CONFIRMADA', { acao: id, tipo: a.tipo, usuario, ip });
  try {
    const r = await zabbixWrite<{ hostids: string[] }>('host.create', a.payload.params as Record<string, unknown>, a.payload.instancia as string);
    const mensagem = `Host cadastrado no Zabbix (id ${r.hostids?.[0]}).`;
    auditar('EXECUTADA', { acao: id, tipo: a.tipo, usuario, resultado: mensagem });
    return { ok: true, mensagem };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    auditar('FALHOU', { acao: id, tipo: a.tipo, usuario, erro });
    return { ok: false, mensagem: `Não consegui cadastrar: ${erro}` };
  }
}
