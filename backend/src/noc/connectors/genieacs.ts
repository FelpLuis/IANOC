/**
 * GenieACS NBI (TR-069), somente leitura: devices, faults e tasks pendentes.
 *
 * O NBI dá controle total sobre as CPEs e não autentica por padrão
 * (ver TR70/TR070/deploy/README.md). Este conector nunca faz POST/PUT/DELETE.
 */

import { nocConfig } from '../config.js';
import { fetchJson } from '../http.js';

function headers(): Record<string, string> {
  const { username, password } = nocConfig.genieacs;
  return username ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {};
}

async function nbiGet<T>(collection: string, query: Record<string, unknown>, projection?: string[], limit = 50): Promise<T> {
  const url = new URL(`${nocConfig.genieacs.nbiUrl}/${collection}/`);
  url.searchParams.set('query', JSON.stringify(query));
  if (projection?.length) url.searchParams.set('projection', projection.join(','));
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 200)));
  return (await fetchJson<T>('genieacs', url.toString(), { headers: headers() })).data;
}

// Parâmetros que respondem às perguntas de campo: sinal óptico, Wi-Fi, WAN, firmware, último inform.
const DEVICE_PROJECTION = [
  '_id', '_lastInform', '_registered', '_tags',
  '_deviceId._Manufacturer', '_deviceId._ProductClass', '_deviceId._SerialNumber',
  'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
  'InternetGatewayDevice.DeviceInfo.UpTime',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
  'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.TXPower',
  'Device.DeviceInfo.SoftwareVersion',
  'Device.Optical.Interface.1.OpticalSignalLevel',
];

/** Busca por serial, PPPoE, MAC ou id. Valor sem campo casa em serial e usuário PPPoE. */
export async function findDevices(search: string, limit = 20) {
  const term = search.trim();
  const regex = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const query = {
    $or: [
      { _id: regex },
      { '_deviceId._SerialNumber': regex },
      { 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value': regex },
      { _tags: term },
    ],
  };
  const devices = await nbiGet<Array<Record<string, unknown>>>('devices', query, DEVICE_PROJECTION, limit);
  return devices.map(flattenDevice);
}

export async function deviceFaults(deviceId?: string, limit = 50) {
  return nbiGet('faults', deviceId ? { device: deviceId } : {}, undefined, limit);
}

export async function pendingTasks(deviceId?: string, limit = 50) {
  return nbiGet('tasks', deviceId ? { device: deviceId } : {}, undefined, limit);
}

export async function deviceCount(query: Record<string, unknown> = {}) {
  const url = new URL(`${nocConfig.genieacs.nbiUrl}/devices/`);
  url.searchParams.set('query', JSON.stringify(query));
  url.searchParams.set('projection', '_id');
  const { data } = await fetchJson<unknown[]>('genieacs', url.toString(), { headers: headers() });
  return Array.isArray(data) ? data.length : 0;
}

/** Achata a árvore do GenieACS em "caminho: valor" — o modelo lê muito melhor assim. */
function flattenDevice(device: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const walk = (node: unknown, prefix: string) => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if ('_value' in obj) { out[prefix] = obj._value; return; }
    for (const [key, child] of Object.entries(obj)) {
      if (key.startsWith('_') && prefix) continue; // metadados (_object, _writable, _timestamp)
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  for (const [key, value] of Object.entries(device)) {
    if (key.startsWith('_')) out[key] = value;
    else walk(value, key);
  }
  return out;
}
