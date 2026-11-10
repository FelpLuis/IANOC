/**
 * IXC Soft webservice v1, somente "listar" (mesmo formato de
 * Topologia-NOC.github.io/collector/ixc-client.mjs).
 *
 * O NOC já sincroniza cliente/contrato/login; este conector é para quando o
 * operador precisa do dado vivo do ERP (contrato bloqueado agora, login
 * derrubado, O.S. aberta).
 */

import { nocConfig } from '../config.js';
import { ConnectorError, fetchJson } from '../http.js';

// Recursos liberados para leitura. Qualquer outro é recusado.
export const IXC_RESOURCES = {
  cliente: 'cadastro do cliente (nome/razão, CPF/CNPJ, endereço, telefone)',
  cliente_contrato: 'contratos (status, status_internet, plano, data de ativação)',
  radusuarios: 'logins PPPoE (usuário, online, IP, MAC, ONU, velocidade)',
  su_oss_chamado: 'ordens de serviço / chamados técnicos (status A aberta, AN análise, EN encaminhada, AS assumida, AG agendada, DS deslocamento, EX execução, F finalizada; datas data_abertura/data_fechamento "AAAA-MM-DD HH:MM:SS")',
  su_oss_assunto: 'assuntos (tipos) de O.S.',
  radpop: 'POPs cadastrados no IXC',
  radconcentrador: 'concentradores/NAS (BRAS)',
  fn_areceber: 'títulos a receber (financeiro)',
} as const;

export type IxcResource = keyof typeof IXC_RESOURCES;
export const IXC_OPERATORS = ['=', 'L', '>', '<', '>=', '<=', '!='] as const;

// Campos com documento pessoal: mascarados antes de irem para o modelo.
const SENSITIVE = /^(cnpj_cpf|cpf|cnpj|rg|ie_identidade|senha|password|senha_md5|hotsite_senha)$/i;

export async function ixcList(resource: IxcResource, field: string, value: string, oper: (typeof IXC_OPERATORS)[number] = '=', limit = 20) {
  if (!(resource in IXC_RESOURCES)) throw new ConnectorError('ixc', `recurso ${resource} não liberado para leitura.`);
  if (!/^[a-z_]+$/i.test(field)) throw new ConnectorError('ixc', `campo inválido: ${field}`);
  const { data } = await fetchJson<{ total?: string | number; registros?: Array<Record<string, unknown>>; message?: string }>(
    'ixc',
    `${nocConfig.ixc.baseUrl}/${resource}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(nocConfig.ixc.token).toString('base64')}`,
        'Content-Type': 'application/json',
        ixcsoft: 'listar',
      },
      body: JSON.stringify({
        qtype: `${resource}.${field}`, query: value, oper,
        page: '1', rp: String(Math.min(Math.max(limit, 1), 100)),
        sortname: `${resource}.id`, sortorder: 'desc',
      }),
    },
  );
  if (!Array.isArray(data?.registros)) throw new ConnectorError('ixc', data?.message || 'resposta inválida');
  return {
    total: Number(data.total || 0),
    registros: data.registros.map((r) => Object.fromEntries(
      Object.entries(r)
        .filter(([, v]) => v !== '' && v !== null && v !== '0000-00-00' && v !== '0000-00-00 00:00:00')
        .map(([k, v]) => [k, SENSITIVE.test(k) ? mask(String(v)) : v]),
    )),
  };
}

function mask(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

/** Lê várias páginas (até `max` registros) de um recurso liberado. */
export async function ixcListAll(resource: IxcResource, field: string, value: string, oper: (typeof IXC_OPERATORS)[number], max = 2000) {
  const all: Array<Record<string, unknown>> = [];
  let total = 0;
  for (let page = 1; all.length < max; page++) {
    const { data } = await fetchJson<{ total?: string | number; registros?: Array<Record<string, unknown>>; message?: string }>(
      'ixc',
      `${nocConfig.ixc.baseUrl}/${resource}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(nocConfig.ixc.token).toString('base64')}`,
          'Content-Type': 'application/json',
          ixcsoft: 'listar',
        },
        body: JSON.stringify({
          qtype: `${resource}.${field}`, query: value, oper,
          page: String(page), rp: '500',
          sortname: `${resource}.id`, sortorder: 'desc',
        }),
      },
    );
    if (!Array.isArray(data?.registros)) {
      if (page === 1 && Number(data?.total) === 0) break;
      throw new ConnectorError('ixc', data?.message || 'resposta inválida');
    }
    total = Number(data.total || 0);
    all.push(...data.registros);
    if (data.registros.length < 500 || all.length >= total) break;
  }
  return { total, registros: all.slice(0, max) };
}

const OS_STATUS: Record<string, string> = {
  A: 'aberta', AN: 'em análise', EN: 'encaminhada', AS: 'assumida', AG: 'agendada',
  DS: 'em deslocamento', EX: 'em execução', F: 'finalizada', RAG: 'aguardando reagendamento',
};

/** Ordens de serviço abertas num período, agregadas por status, assunto, setor e técnico. */
export async function ixcOsResumo(desde: string, ate?: string, top = 15) {
  const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
  const from = new Date(desde);
  const till = ate ? new Date(ate) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(till.getTime())) throw new ConnectorError('ixc', 'período inválido (use ISO 8601).');
  const [ini, fim] = [fmt(from), fmt(till)];

  const { total, registros } = await ixcListAll('su_oss_chamado', 'data_abertura', ini, '>=', 5000);
  const os = registros.filter((r) => String(r.data_abertura ?? '') <= fim);

  const assuntoIds = [...new Set(os.map((r) => String(r.id_assunto ?? '')).filter((id) => id && id !== '0'))];
  const assuntos = new Map<string, string>();
  if (assuntoIds.length) {
    const lista = await ixcListAll('su_oss_assunto', 'id', '0', '>', 2000).catch(() => ({ registros: [] as Array<Record<string, unknown>> }));
    for (const a of lista.registros) assuntos.set(String(a.id), String(a.assunto ?? a.descricao ?? a.id));
  }

  const count = (key: (r: Record<string, unknown>) => string) => {
    const out: Record<string, number> = {};
    for (const r of os) { const k = key(r) || '(vazio)'; out[k] = (out[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, top));
  };

  const horas = os
    .filter((r) => r.status === 'F' && r.data_fechamento && !String(r.data_fechamento).startsWith('0000'))
    .map((r) => (Date.parse(String(r.data_fechamento).replace(' ', 'T')) - Date.parse(String(r.data_abertura).replace(' ', 'T'))) / 3600000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);

  return {
    periodo: { desde: ini, ate: fim },
    total_os: os.length,
    ...(total > 5000 ? { aviso: `o IXC tem ${total} O.S. desde ${ini}; foram lidas as 5000 mais recentes.` } : {}),
    por_status: count((r) => OS_STATUS[String(r.status)] ?? String(r.status ?? '')),
    por_assunto: count((r) => assuntos.get(String(r.id_assunto)) ?? `assunto ${r.id_assunto ?? '?'}`),
    por_setor: count((r) => `setor ${r.setor ?? r.id_setor ?? '?'}`),
    por_tecnico: count((r) => (r.id_tecnico && r.id_tecnico !== '0' ? `técnico ${r.id_tecnico}` : 'sem técnico')),
    tempo_resolucao_horas: horas.length
      ? { finalizadas: horas.length, media: +(horas.reduce((s, h) => s + h, 0) / horas.length).toFixed(1), mediana: +horas[Math.floor(horas.length / 2)].toFixed(1) }
      : null,
  };
}
