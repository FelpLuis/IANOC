/**
 * Zabbix JSON-RPC direto, somente métodos .get.
 *
 * Aceita mais de uma instância (ZABBIX_*, ZABBIX2_*, ZABBIX3_* no .env): o Zabbix da
 * UpDown e, por exemplo, o de um parceiro de trânsito. Cada instância autentica por
 * token de API ou por usuário/senha (user.login, sessão renovada sozinha).
 *
 * Além dos alarmes ativos, traz eventos de um período agregados por host, severidade
 * e duração — a base dos relatórios de incidentes e disponibilidade.
 */

import { nocConfig, type ZabbixInstance } from '../config.js';
import { ConnectorError, fetchJson, horaLocal } from '../http.js';

let requestId = 1;
const sessions = new Map<string, string>();

export const zabbixInstanceNames = () => nocConfig.zabbix.map((z) => z.nome);

export function pickInstance(nome?: string): ZabbixInstance {
  const list = nocConfig.zabbix;
  if (!list.length) throw new ConnectorError('zabbix', 'nenhuma instância configurada.');
  if (!nome) return list[0];
  const found = list.find((z) => z.nome === nome.toLowerCase());
  if (!found) throw new ConnectorError('zabbix', `instância "${nome}" não existe. Disponíveis: ${zabbixInstanceNames().join(', ')}.`);
  return found;
}

async function rpc<T>(inst: ZabbixInstance, method: string, params: unknown, auth?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json-rpc' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const { data } = await fetchJson<{ result?: T; error?: { message: string; data?: string } }>(`zabbix:${inst.nome}`, inst.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: requestId++ }),
  });
  if (data?.error) throw new ConnectorError(`zabbix:${inst.nome}`, `${data.error.message} ${data.error.data || ''}`.trim());
  return data?.result as T;
}

async function login(inst: ZabbixInstance): Promise<string> {
  const session = await rpc<string>(inst, 'user.login', { username: inst.username, password: inst.password });
  sessions.set(inst.nome, session);
  return session;
}

export async function zabbixCall<T = unknown>(method: string, params: Record<string, unknown>, instancia?: string): Promise<T> {
  if (!/\.get$/.test(method) && method !== 'apiinfo.version') {
    throw new ConnectorError('zabbix', `método ${method} bloqueado: o assistente só lê do Zabbix.`);
  }
  return chamar<T>(method, params, instancia);
}

/**
 * Escrita no Zabbix: só cadastro de host, e só chamada por acoes.ts depois que um
 * administrador confirma na tela. Nenhum método de alteração ou remoção é liberado.
 */
const ESCRITA_PERMITIDA = new Set(['host.create']);
export async function zabbixWrite<T = unknown>(method: string, params: Record<string, unknown>, instancia?: string): Promise<T> {
  if (!ESCRITA_PERMITIDA.has(method)) throw new ConnectorError('zabbix', `método ${method} não é permitido para a NIA (só host.create).`);
  return chamar<T>(method, params, instancia);
}

async function chamar<T>(method: string, params: Record<string, unknown>, instancia?: string): Promise<T> {
  const inst = pickInstance(instancia);
  // apiinfo.version recusa autenticação.
  if (method === 'apiinfo.version') return rpc<T>(inst, method, []);
  if (inst.token) return rpc<T>(inst, method, params, inst.token);

  const session = sessions.get(inst.nome) ?? (await login(inst));
  try {
    return await rpc<T>(inst, method, params, session);
  } catch (error) {
    // Sessão expirada: faz login de novo uma vez.
    if (error instanceof ConnectorError && /session|re-login|not authori[sz]ed/i.test(error.message)) {
      return rpc<T>(inst, method, params, await login(inst));
    }
    throw error;
  }
}

export const ZABBIX_SEVERITY = ['não classificado', 'informação', 'atenção', 'média', 'alta', 'desastre'];

/** Roda em todas as instâncias (ou só na pedida) e junta o resultado, sem deixar uma falha derrubar as outras. */
async function eachInstance<R>(instancia: string | undefined, run: (nome: string) => Promise<R>) {
  const nomes = instancia ? [pickInstance(instancia).nome] : zabbixInstanceNames();
  const settled = await Promise.allSettled(nomes.map(run));
  const ok: Array<{ instancia: string; result: R }> = [];
  const erros: Record<string, string> = {};
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') ok.push({ instancia: nomes[i], result: s.value });
    else erros[nomes[i]] = s.reason instanceof Error ? s.reason.message : String(s.reason);
  });
  return { ok, erros: Object.keys(erros).length ? erros : undefined };
}

async function hostIdsByName(hostName: string, instancia: string): Promise<string[]> {
  const hosts = await zabbixCall<Array<{ hostid: string }>>('host.get', {
    output: ['hostid'],
    // Com curingas ligados o Zabbix não envolve o termo em %…%: sem * no termo, procura em qualquer parte do nome.
    search: { name: hostName.includes('*') ? hostName : `*${hostName}*` },
    searchWildcardsEnabled: true,
  }, instancia);
  return hosts.map((h) => h.hostid);
}

const severities = (min = 2) => [0, 1, 2, 3, 4, 5].filter((s) => s >= min);
const iso = (clock: unknown) => horaLocal(Number(clock) * 1000);

export async function activeProblems(opts: { minSeverity?: number; search?: string; hostName?: string; limit?: number; instancia?: string }) {
  const { ok, erros } = await eachInstance(opts.instancia, async (instancia) => {
    let hostids: string[] | undefined;
    if (opts.hostName) {
      hostids = await hostIdsByName(opts.hostName, instancia);
      if (!hostids.length) return [];
    }
    const problems = await zabbixCall<Array<Record<string, unknown>>>('problem.get', {
      output: ['eventid', 'objectid', 'name', 'severity', 'clock', 'acknowledged', 'suppressed'],
      recent: false,
      severities: severities(opts.minSeverity),
      ...(hostids ? { hostids } : {}),
      ...(opts.search ? { search: { name: opts.search } } : {}),
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit: Math.min(opts.limit ?? 100, 500),
    }, instancia);

    // problem.get não traz o host; resolve pelos triggers.
    const triggerIds = [...new Set(problems.map((p) => String(p.objectid)))];
    const triggers = triggerIds.length
      ? await zabbixCall<Array<{ triggerid: string; hosts: Array<{ name: string }> }>>('trigger.get', {
          output: ['triggerid'],
          triggerids: triggerIds,
          selectHosts: ['name'],
        }, instancia)
      : [];
    const hostByTrigger = new Map(triggers.map((t) => [t.triggerid, t.hosts.map((h) => h.name).join(', ')]));

    return problems.map((p) => ({
      instancia,
      host: hostByTrigger.get(String(p.objectid)) || '?',
      problema: p.name,
      severidade: ZABBIX_SEVERITY[Number(p.severity)] ?? p.severity,
      desde: iso(p.clock),
      reconhecido: p.acknowledged === '1',
    }));
  });
  const problems = ok.flatMap((r) => r.result);
  return { total: problems.length, problems, ...(erros ? { erros } : {}) };
}

/**
 * Eventos de problema num período, agregados para relatório: quantos, de que severidade,
 * quais hosts mais caíram e por quanto tempo ficaram com problema (até a recuperação, ou
 * até agora se ainda aberto).
 */
export async function problemEventsReport(opts: {
  desde: string; ate?: string; minSeverity?: number; hostName?: string; search?: string; instancia?: string; top?: number;
}) {
  const from = Math.floor(new Date(opts.desde).getTime() / 1000);
  const till = Math.floor((opts.ate ? new Date(opts.ate) : new Date()).getTime() / 1000);
  if (!Number.isFinite(from) || !Number.isFinite(till) || from >= till) {
    throw new ConnectorError('zabbix', 'período inválido: use datas ISO 8601 com "desde" antes de "ate".');
  }
  const top = Math.min(opts.top ?? 15, 50);
  const now = Math.floor(Date.now() / 1000);

  const { ok, erros } = await eachInstance(opts.instancia, async (instancia) => {
    let hostids: string[] | undefined;
    if (opts.hostName) {
      hostids = await hostIdsByName(opts.hostName, instancia);
      if (!hostids.length) return [];
    }
    const events = await zabbixCall<Array<Record<string, any>>>('event.get', {
      output: ['eventid', 'clock', 'name', 'severity', 'r_eventid', 'acknowledged'],
      source: 0, object: 0, value: 1,
      time_from: from, time_till: till,
      severities: severities(opts.minSeverity),
      ...(hostids ? { hostids } : {}),
      ...(opts.search ? { search: { name: opts.search } } : {}),
      selectHosts: ['name'],
      sortfield: ['clock'], sortorder: 'DESC',
      limit: 5000,
    }, instancia);
    const recoveryIds = events.map((e) => String(e.r_eventid)).filter((id) => id && id !== '0');
    const recoveries = recoveryIds.length
      ? await zabbixCall<Array<{ eventid: string; clock: string }>>('event.get', { output: ['eventid', 'clock'], eventids: recoveryIds }, instancia)
      : [];
    const recoveredAt = new Map(recoveries.map((r) => [r.eventid, Number(r.clock)]));
    return events.map((e) => {
      const end = recoveredAt.get(String(e.r_eventid));
      return {
        instancia,
        host: (e.hosts as Array<{ name: string }> | undefined)?.map((h) => h.name).join(', ') || '?',
        problema: String(e.name),
        severidade: ZABBIX_SEVERITY[Number(e.severity)] ?? String(e.severity),
        inicio: Number(e.clock),
        fim: end,
        minutos: Math.round(((end ?? now) - Number(e.clock)) / 60),
        aberto: !end,
        reconhecido: e.acknowledged === '1',
      };
    });
  });

  const eventos = ok.flatMap((r) => r.result);
  const count = <K extends string>(key: (e: (typeof eventos)[number]) => K) => {
    const out: Record<string, number> = {};
    for (const e of eventos) out[key(e)] = (out[key(e)] || 0) + 1;
    return out;
  };
  const porHost = new Map<string, { host: string; instancia: string; eventos: number; minutos: number; abertos: number }>();
  for (const e of eventos) {
    const key = `${e.instancia}|${e.host}`;
    const h = porHost.get(key) ?? { host: e.host, instancia: e.instancia, eventos: 0, minutos: 0, abertos: 0 };
    h.eventos++; h.minutos += e.minutos; if (e.aberto) h.abertos++;
    porHost.set(key, h);
  }
  const topProblemas = Object.entries(count((e) => e.problema)).sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([problema, n]) => ({ problema, eventos: n }));

  return {
    periodo: { desde: iso(from), ate: iso(till) },
    instancias: ok.map((r) => r.instancia),
    total_eventos: eventos.length,
    ainda_abertos: eventos.filter((e) => e.aberto).length,
    ...(eventos.length >= 5000 ? { aviso: 'atingiu 5000 eventos numa instância: o período tem mais; reduza o intervalo ou suba a severidade mínima.' } : {}),
    por_severidade: count((e) => e.severidade),
    hosts_mais_eventos: [...porHost.values()].sort((a, b) => b.eventos - a.eventos).slice(0, top),
    hosts_mais_tempo_com_problema: [...porHost.values()].sort((a, b) => b.minutos - a.minutos).slice(0, top),
    problemas_mais_frequentes: topProblemas,
    eventos_mais_longos: [...eventos].sort((a, b) => b.minutos - a.minutos).slice(0, top)
      .map((e) => ({ ...e, inicio: iso(e.inicio), fim: e.fim ? iso(e.fim) : null })),
    ...(erros ? { erros } : {}),
  };
}

/** Hosts de todas as instâncias (nome e grupos), para montar a topologia. */
export async function listHosts(): Promise<{ hosts: Array<{ instancia: string; nome: string; grupos: string[] }>; erros?: Record<string, string> }> {
  const { ok, erros } = await eachInstance(undefined, (instancia) =>
    zabbixCall<Array<{ name: string; hostgroups?: Array<{ name: string }> }>>('host.get', { output: ['name'], selectHostGroups: ['name'] }, instancia));
  return {
    hosts: ok.flatMap(({ instancia, result }) => result.map((h) => ({ instancia, nome: h.name, grupos: (h.hostgroups ?? []).map((g) => g.name) }))),
    ...(erros ? { erros } : {}),
  };
}
