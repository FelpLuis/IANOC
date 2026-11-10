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
 * Escritas liberadas: Zabbix host.create; sistema NOC POST /api/clientes,
 * POST /api/locais (POP) e PUT /api/topology (só acrescentando equipamento ou enlace).
 * Nada de alteração ou exclusão.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { zabbixCall, zabbixWrite } from './connectors/zabbix.js';
import { nocGet, nocSend } from './connectors/noc.js';
import { connectorEnabled, nocConfig } from './config.js';

export type TipoAcao = 'zabbix_host' | 'noc_cliente' | 'noc_pop' | 'noc_equipamento' | 'noc_enlace';
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

// ------------------------------------------------------------------ sistema NOC

function exigeNoc() {
  if (!connectorEnabled('noc')) throw new PropostaInvalida('O sistema NOC não está conectado: falta o usuário de serviço com permissão de cadastro (rode "npm run noc:criar-usuario -- --escrita").');
}
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export interface DadosCliente { client_id: string; nome: string; cpf_cnpj?: string; telefone?: string; email?: string; endereco?: string; bairro?: string; cidade?: string; plano?: string; login_pppoe?: string; ont_serial?: string; ont_modelo?: string; observacao?: string }

export async function proporCliente(conversa: string, d: DadosCliente): Promise<AcaoPublica> {
  exigeNoc();
  const campos: Campo[] = [
    { rotulo: 'Código', valor: d.client_id }, { rotulo: 'Nome', valor: d.nome },
    { rotulo: 'CPF/CNPJ', valor: d.cpf_cnpj ? `•••${d.cpf_cnpj.replace(/\D/g, '').slice(-4)}` : '' },
    { rotulo: 'Telefone', valor: d.telefone ?? '' }, { rotulo: 'E-mail', valor: d.email ?? '' },
    { rotulo: 'Endereço', valor: [d.endereco, d.bairro, d.cidade].filter(Boolean).join(', ') },
    { rotulo: 'Plano', valor: d.plano ?? '' }, { rotulo: 'Login PPPoE', valor: d.login_pppoe ?? '' },
    { rotulo: 'ONU', valor: [d.ont_modelo, d.ont_serial].filter(Boolean).join(' · ') },
  ];
  return registrar(conversa, 'noc_cliente', 'Cadastrar cliente no sistema NOC', campos, { metodo: 'POST', caminho: '/api/clientes', corpo: d },
    ['Senhas (PPPoE, roteador, Wi-Fi, portal) não são cadastradas pela NIA: defina no sistema NOC.']);
}

export interface DadosPop { nome: string; tipo?: 'POP' | 'Data Center' | 'ISP'; endereco?: string; lat?: number; lon?: number; observacao?: string }

export async function proporPop(conversa: string, d: DadosPop): Promise<AcaoPublica> {
  exigeNoc();
  const corpo = { id: `pop-${slug(d.nome)}`, nome: d.nome, tipo: d.tipo ?? 'POP', endereco: d.endereco ?? '', lat: d.lat, lon: d.lon, observacao: d.observacao ?? '' };
  return registrar(conversa, 'noc_pop', `Cadastrar ${corpo.tipo} no sistema NOC`, [
    { rotulo: 'Nome', valor: d.nome }, { rotulo: 'Tipo', valor: corpo.tipo }, { rotulo: 'Endereço', valor: corpo.endereco },
    { rotulo: 'Coordenadas', valor: d.lat !== undefined && d.lon !== undefined ? `${d.lat}, ${d.lon}` : '' },
    { rotulo: 'Id', valor: corpo.id },
  ], { metodo: 'POST', caminho: '/api/locais', corpo });
}

interface Topologia { equipamentos: Array<Record<string, unknown> & { id: string; nome: string; portas?: Array<{ numero: number; status?: string }> }>; conexoes: Array<Record<string, unknown> & { origem: string; destino: string; portaOrigem?: unknown; portaDestino?: unknown }>; pops: unknown[]; config?: unknown; fibras?: unknown[]; caixas?: unknown[]; version?: number }

const lerTopologia = () => nocGet<Topologia>('/api/topology');
const achar = (t: Topologia, termo: string) => {
  const n = termo.toLowerCase().trim();
  return t.equipamentos.find((e) => e.id.toLowerCase() === n) ?? t.equipamentos.find((e) => e.nome.toLowerCase() === n)
    ?? t.equipamentos.find((e) => e.nome.toLowerCase().includes(n));
};

export interface DadosEquipamento { nome: string; modelo?: string; categoria?: string; local?: string; portas?: number; capacidade?: string; tipoPorta?: string; observacao?: string }

export async function proporEquipamento(conversa: string, d: DadosEquipamento): Promise<AcaoPublica> {
  exigeNoc();
  const topo = await lerTopologia();
  const id = slug(d.nome) || `eq-${Date.now()}`;
  if (topo.equipamentos.some((e) => e.id === id || e.nome.toLowerCase() === d.nome.toLowerCase())) throw new PropostaInvalida(`Já existe o equipamento "${d.nome}" na topologia.`);
  const novo = {
    id, nome: d.nome, modelo: d.modelo ?? 'A identificar', categoria: d.categoria ?? 'Acesso', local: d.local ?? '', observacao: d.observacao ?? '',
    portas: Array.from({ length: Math.min(Math.max(d.portas ?? 0, 0), 128) }, (_, i) => ({ numero: i + 1, capacidade: d.capacidade ?? 'A confirmar', tipo: d.tipoPorta ?? '', status: 'livre' })),
  };
  return registrar(conversa, 'noc_equipamento', 'Cadastrar equipamento na topologia do NOC', [
    { rotulo: 'Nome', valor: novo.nome }, { rotulo: 'Modelo', valor: novo.modelo }, { rotulo: 'Camada', valor: novo.categoria },
    { rotulo: 'Local', valor: novo.local }, { rotulo: 'Portas', valor: novo.portas.length ? `${novo.portas.length} × ${novo.portas[0].capacidade}` : 'nenhuma (cadastre depois)' },
    { rotulo: 'Id', valor: novo.id },
  ], { equipamento: novo });
}

export interface DadosEnlace { de: string; portaDe: number; para: string; portaPara: number; capacidade?: string; tipo?: string }

export async function proporEnlace(conversa: string, d: DadosEnlace): Promise<AcaoPublica> {
  exigeNoc();
  const topo = await lerTopologia();
  const a = achar(topo, d.de);
  const b = achar(topo, d.para);
  if (!a || !b) throw new PropostaInvalida(`Não achei ${!a ? `"${d.de}"` : ''}${!a && !b ? ' nem ' : ''}${!b ? `"${d.para}"` : ''} na topologia do NOC.`);
  const ocupada = (eq: Topologia['equipamentos'][number], porta: number) =>
    topo.conexoes.some((c) => (c.origem === eq.id && Number(c.portaOrigem) === porta) || (c.destino === eq.id && Number(c.portaDestino) === porta));
  if (ocupada(a, d.portaDe)) throw new PropostaInvalida(`A porta ${d.portaDe} do ${a.nome} já tem enlace.`);
  if (ocupada(b, d.portaPara)) throw new PropostaInvalida(`A porta ${d.portaPara} do ${b.nome} já tem enlace.`);
  const avisos: string[] = [];
  if (a.portas?.length && !a.portas.some((p) => p.numero === d.portaDe)) avisos.push(`O ${a.nome} não tem a porta ${d.portaDe} cadastrada.`);
  if (b.portas?.length && !b.portas.some((p) => p.numero === d.portaPara)) avisos.push(`O ${b.nome} não tem a porta ${d.portaPara} cadastrada.`);
  const conexao = { origem: a.id, portaOrigem: d.portaDe, destino: b.id, portaDestino: d.portaPara, capacidade: d.capacidade ?? 'A confirmar', tipo: d.tipo ?? 'Enlace' };
  return registrar(conversa, 'noc_enlace', 'Cadastrar enlace na topologia do NOC', [
    { rotulo: 'De', valor: `${a.nome} · porta ${d.portaDe}` }, { rotulo: 'Para', valor: `${b.nome} · porta ${d.portaPara}` },
    { rotulo: 'Capacidade', valor: conexao.capacidade }, { rotulo: 'Tipo', valor: conexao.tipo },
  ], { conexao }, avisos);
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
    let mensagem: string;
    if (a.tipo === 'zabbix_host') {
      const r = await zabbixWrite<{ hostids: string[] }>('host.create', a.payload.params as Record<string, unknown>, a.payload.instancia as string);
      mensagem = `Host cadastrado no Zabbix (id ${r.hostids?.[0]}).`;
    } else if (a.tipo === 'noc_cliente' || a.tipo === 'noc_pop') {
      await nocSend('POST', a.payload.caminho as string, a.payload.corpo);
      mensagem = a.tipo === 'noc_cliente' ? 'Cliente cadastrado no sistema NOC.' : 'Local cadastrado no sistema NOC.';
    } else {
      // Topologia: relê agora e acrescenta só o item novo, para não sobrescrever edição recente.
      const t = await lerTopologia();
      const corpo: Record<string, unknown> = { equipamentos: t.equipamentos, conexoes: t.conexoes, pops: t.pops, config: t.config };
      if (t.fibras) corpo.fibras = t.fibras;
      if (t.caixas) corpo.caixas = t.caixas;
      if (a.tipo === 'noc_equipamento') {
        const eq = a.payload.equipamento as { id: string; nome: string };
        if (t.equipamentos.some((e) => e.id === eq.id)) throw new Error(`o equipamento "${eq.nome}" foi cadastrado por outra pessoa enquanto você confirmava.`);
        corpo.equipamentos = [...t.equipamentos, eq];
      } else {
        const c = a.payload.conexao as { origem: string; portaOrigem: number; destino: string; portaDestino: number };
        if (t.conexoes.some((x) => (x.origem === c.origem && Number(x.portaOrigem) === c.portaOrigem) || (x.destino === c.destino && Number(x.portaDestino) === c.portaDestino)))
          throw new Error('a porta foi ocupada por outro enlace enquanto você confirmava.');
        corpo.conexoes = [...t.conexoes, c];
      }
      await nocSend('PUT', '/api/topology', corpo);
      mensagem = a.tipo === 'noc_equipamento' ? 'Equipamento cadastrado na topologia do NOC.' : 'Enlace cadastrado na topologia do NOC.';
    }
    auditar('EXECUTADA', { acao: id, tipo: a.tipo, usuario, resultado: mensagem });
    return { ok: true, mensagem };
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    auditar('FALHOU', { acao: id, tipo: a.tipo, usuario, erro });
    return { ok: false, mensagem: `Não consegui cadastrar: ${erro}` };
  }
}
