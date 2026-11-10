/**
 * HTTP comum dos conectores: timeout, erro legível e corte do que volta ao modelo.
 */

import { nocConfig } from './config.js';

export class ConnectorError extends Error {
  constructor(public connector: string, message: string, public status?: number) {
    super(`[${connector}] ${message}`);
  }
}

export async function fetchJson<T = unknown>(
  connector: string,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(nocConfig.http.timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConnectorError(connector, `sem resposta de ${new URL(url).host}: ${reason}`);
  }
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON fica como texto */ }
  if (!response.ok) {
    const detail = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : text.slice(0, 300);
    throw new ConnectorError(connector, `HTTP ${response.status}: ${detail}`, response.status);
  }
  return { status: response.status, data: data as T };
}

/** Filtro textual genérico: casa todas as palavras da busca em qualquer campo do registro. */
export function matchesQuery(record: unknown, query?: string): boolean {
  if (!query) return true;
  const haystack = normalize(JSON.stringify(record));
  return normalize(query).split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Serializa o resultado para o modelo, cortando com aviso explícito em vez de truncar em silêncio. */
export function toToolText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const max = nocConfig.http.maxResultChars;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[RESULTADO CORTADO: ${text.length} caracteres, mostrados ${max}. Refine a busca com filtros para ver o restante.]`;
}

export function limitList<T>(items: T[], limit = 50): { total: number; shown: number; items: T[] } {
  const bounded = Math.min(Math.max(limit, 1), 500);
  return { total: items.length, shown: Math.min(items.length, bounded), items: items.slice(0, bounded) };
}

/** Data/hora em São Paulo ("2026-11-09 11:28:10"), para o modelo não confundir UTC com hora local. */
export function horaLocal(value: number | string | Date): string {
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
}
