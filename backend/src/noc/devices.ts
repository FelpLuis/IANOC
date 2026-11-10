/**
 * Aparelhos citados nas consultas do assistente, para a interface mostrar em 3D.
 *
 * Depois de cada ferramenta, os resultados que descrevem equipamentos (topologia do
 * backbone, hosts com alarme no Zabbix, CPEs do GenieACS, ONUs do NOC) viram cartões
 * padronizados: tipo do aparelho, modelo, estado, alertas, portas e métricas.
 * Só o que já foi consultado — nada é buscado a mais.
 */

import { findEquipamento, getKnowledge } from './knowledge.js';

export type DeviceKind = 'olt' | 'switch' | 'roteador' | 'onu' | 'servidor' | 'transporte' | 'generico';
export type DeviceStatus = 'ok' | 'atencao' | 'critico' | 'desconhecido';

export interface DevicePort { numero: number; status: string; tipo?: string; capacidade?: string; descricao?: string }

export interface DeviceCard {
  id: string;
  nome: string;
  tipo: DeviceKind;
  modelo?: string;
  fabricante?: string;
  local?: string;
  categoria?: string;
  status: DeviceStatus;
  alertas?: string[];
  portas?: DevicePort[];
  metricas?: Array<{ nome: string; valor: string }>;
  fonte: string;
}

const MAX_DEVICES = 8;

export function classify(...hints: Array<unknown>): DeviceKind {
  const s = hints.filter(Boolean).map(String).join(' ').toLowerCase();
  if (/\bolt\b|ma56|ma58|ea5800|c300|c320|c350|c600|c650|an5516|an6000/.test(s)) return 'olt';
  if (/\bon[ut]\b|hg8|eg8|hs8|f6\d\d|xpon|gpon|\bcpe\b|cliente|los\b|dying|roteador do cliente/.test(s)) return 'onu';
  if (/nokia|1830|dwdm|transporte|\bradio\b|r[aá]dio|ptp|airfiber|mimosa|ubiquiti/.test(s)) return 'transporte';
  if (/cloudengine|\bs\d{4}|switch|\bce\d{3,}|\bcrs\d|agrega|distribui/.test(s)) return 'switch';
  if (/netengine|\bne\s?\d|n[uú]cleo|borda|router|roteador|\bccr\d|\bmx\d|asr\d|\bbng\b|\bbras\b|mikrotik/.test(s)) return 'roteador';
  if (/server|servidor|\bsrv|\bvm\b|proxmox|zabbix|dell|poweredge/.test(s)) return 'servidor';
  return 'generico';
}

const vendorOf = (modelo?: string) => {
  const m = String(modelo ?? '').match(/huawei|zte|nokia|mikrotik|fiberhome|intelbras|tp-?link|ubiquiti|cisco|juniper|datacom|parks|dell/i);
  return m ? m[0].replace(/^./, (c) => c.toUpperCase()) : undefined;
};

const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase() || x.toLowerCase().endsWith(`.${k.toLowerCase()}`));
    if (hit && str(o[hit])) return str(o[hit]);
  }
  return undefined;
};

function fromEquipamento(e: Record<string, unknown>): DeviceCard {
  const portas = Array.isArray(e.portas)
    ? (e.portas as Array<Record<string, unknown>>).slice(0, 96).map((p) => ({
        numero: Number(p.numero) || 0,
        status: String(p.status ?? 'desconhecido'),
        tipo: str(p.tipo),
        capacidade: str(p.capacidade),
        descricao: str(p.descricao ?? p.ifAlias ?? p.nome),
      }))
    : undefined;
  const conectadas = portas?.filter((p) => /conect|up|ativa/i.test(p.status)).length;
  return {
    id: `topo:${e.id}`,
    nome: String(e.nome ?? e.id),
    tipo: classify(e.modelo, e.categoria, e.nome),
    modelo: str(e.modelo),
    fabricante: vendorOf(str(e.modelo)),
    local: str(e.local),
    categoria: str(e.categoria),
    status: 'desconhecido',
    portas,
    metricas: portas ? [{ nome: 'Portas em uso', valor: `${conectadas}/${portas.length}` }] : undefined,
    fonte: 'Topologia',
  };
}

const SEV_RANK: Record<string, number> = { desastre: 5, alta: 4, 'média': 3, media: 3, 'atenção': 2, atencao: 2, 'informação': 1, informacao: 1 };

function fromZabbixProblems(list: Array<Record<string, unknown>>): DeviceCard[] {
  const byHost = new Map<string, { sev: number; alertas: string[]; instancia?: string }>();
  for (const p of list) {
    const host = str(p.host);
    if (!host || host === '?') continue;
    const cur = byHost.get(host) ?? { sev: 0, alertas: [], instancia: str(p.instancia) };
    cur.sev = Math.max(cur.sev, SEV_RANK[String(p.severidade ?? '').toLowerCase()] ?? 0);
    if (cur.alertas.length < 4 && p.problema) cur.alertas.push(`${p.problema}${p.desde ? ` (desde ${p.desde})` : ''}`);
    byHost.set(host, cur);
  }
  return [...byHost.entries()]
    .sort((a, b) => b[1].sev - a[1].sev || b[1].alertas.length - a[1].alertas.length)
    .slice(0, MAX_DEVICES)
    .map(([host, v]) => ({
      id: `zbx:${v.instancia ?? ''}:${host}`,
      nome: host,
      // O nome do host decide; o texto do alarme só ajuda quando o nome não diz nada.
      tipo: classify(host) !== 'generico' ? classify(host) : classify(host, ...v.alertas),
      status: v.sev >= 4 ? 'critico' : v.sev >= 2 ? 'atencao' : 'ok',
      alertas: v.alertas,
      metricas: [{ nome: 'Alarmes', valor: String(v.alertas.length) }],
      fonte: v.instancia ? `Zabbix ${v.instancia}` : 'Zabbix',
    }));
}

function fromCpe(d: Record<string, unknown>): DeviceCard | null {
  const serial = pick(d, '_SerialNumber', 'SerialNumber', 'serial', 'sn');
  const nome = pick(d, 'name', 'nome', 'login', 'cliente', 'host') ?? serial ?? pick(d, '_id', 'id');
  if (!nome) return null;
  const modelo = pick(d, 'ModelName', '_ProductClass', 'ProductClass', 'modelo', 'model', 'onu_type', 'tipo_onu');
  const fabricante = pick(d, '_Manufacturer', 'Manufacturer', 'fabricante', 'vendor');
  const rx = pick(d, 'rx_power', 'rx', 'RXPower', 'sinal_rx', 'OpticalSignalLevel');
  const tx = pick(d, 'tx_power', 'tx', 'TXPower', 'sinal_tx');
  const estado = pick(d, 'status', 'estado', 'state');
  const rxN = Number(rx);
  const offline = estado ? !/online|up|ok|conectad/i.test(estado) : false;
  const status: DeviceStatus = offline ? 'critico'
    : Number.isFinite(rxN) && rx !== undefined ? (rxN < -27 ? 'atencao' : 'ok')
    : estado ? 'ok' : 'desconhecido';
  const metricas = [
    rx && { nome: 'RX', valor: `${rx} dBm` },
    tx && { nome: 'TX', valor: `${tx} dBm` },
    estado && { nome: 'Estado', valor: estado },
    pick(d, 'pon', 'porta_pon') && { nome: 'PON', valor: pick(d, 'pon', 'porta_pon')! },
    pick(d, 'olt') && { nome: 'OLT', valor: pick(d, 'olt')! },
    pick(d, 'ip', 'ExternalIPAddress', 'ipv4') && { nome: 'IP', valor: pick(d, 'ip', 'ExternalIPAddress', 'ipv4')! },
    pick(d, '_lastInform', 'uptime') && { nome: 'Último contato', valor: pick(d, '_lastInform', 'uptime')! },
  ].filter(Boolean) as Array<{ nome: string; valor: string }>;
  return {
    id: `cpe:${serial ?? nome}`,
    nome,
    tipo: 'onu',
    modelo,
    fabricante: fabricante ?? vendorOf(modelo),
    status,
    metricas,
    fonte: pick(d, '_lastInform') ? 'GenieACS' : 'NOC',
  };
}

const listIn = (data: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v as Array<Record<string, unknown>>;
  }
  return [];
};

/** Cartões de aparelho a partir do resultado de uma ferramenta (vazio quando não há aparelho). */
export async function extractDevices(tool: string, _input: unknown, raw: unknown): Promise<DeviceCard[]> {
  try {
    const data = (typeof raw === 'string' ? parse(raw) : raw) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return [];

    if (tool === 'backbone_equipamento') return data.id ? [fromEquipamento(data)] : [];

    if (tool === 'backbone_caminho' && Array.isArray(data.caminho)) {
      const k = await getKnowledge();
      const ids: string[] = [];
      for (const h of data.caminho as Array<{ origem: string; destino: string }>) {
        for (const id of [h.origem, h.destino]) if (id && !ids.includes(id)) ids.push(id);
      }
      return ids.slice(0, MAX_DEVICES)
        .map((id) => findEquipamento(k, id))
        .filter(Boolean)
        .map((e) => fromEquipamento(e as unknown as Record<string, unknown>));
    }

    if (tool === 'zabbix_problemas' && Array.isArray(data.problems)) return fromZabbixProblems(data.problems as Array<Record<string, unknown>>);

    if (tool === 'acs_buscar_cpe' || tool === 'noc_gpon_clientes') {
      return listIn(data).slice(0, MAX_DEVICES).map(fromCpe).filter((d): d is DeviceCard => Boolean(d));
    }
    return [];
  } catch {
    return [];
  }
}
