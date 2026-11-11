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
  vd_contratos: 'planos de venda (nome do plano, valor)',
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

// ------------------------------------------------------------------ clientes por plano/produto

const CONTRATO_STATUS: Record<string, string> = { A: 'ativo', I: 'inativo', P: 'pré-contrato', N: 'negativado', D: 'desistiu', C: 'cancelado' };
const INTERNET_STATUS: Record<string, string> = { A: 'ativa', D: 'desativada', CM: 'bloqueio manual', CA: 'bloqueio automático', FA: 'bloqueio financeiro', AA: 'aguardando assinatura' };

/**
 * Clientes cujo contrato tem um plano com o termo no nome ("hotspot", "500 mega", "empresarial").
 * Busca nos planos de venda (vd_contratos) e no nome do plano gravado no contrato; a ligação
 * contrato × produto adicional (vd_contratos_produtos) não é liberada para o token da NIA.
 */
export async function ixcClientesPorPlano(termo: string, opts: { somenteAtivos?: boolean; max?: number } = {}) {
  const t = termo.trim();
  if (t.length < 2) throw new ConnectorError('ixc', 'informe o nome (ou parte) do plano/produto');
  const max = Math.min(opts.max ?? 1000, 2000);
  const planos = (await ixcListAll('vd_contratos', 'nome', t, 'L', 200)).registros
    .map((p) => ({ id: String(p.id), nome: String(p.nome ?? '') }));
  const contratos = new Map<string, Record<string, unknown>>();
  for (const p of planos) {
    for (const c of (await ixcListAll('cliente_contrato', 'id_vd_contrato', p.id, '=', max)).registros) contratos.set(String(c.id), c);
  }
  for (const c of (await ixcListAll('cliente_contrato', 'contrato', t, 'L', max)).registros) contratos.set(String(c.id), c);

  let lista = [...contratos.values()];
  if (opts.somenteAtivos) lista = lista.filter((c) => c.status === 'A');
  // Nome do cliente: uma consulta por cliente (até 300, 8 por vez).
  const ids = [...new Set(lista.map((c) => String(c.id_cliente)))].slice(0, 300);
  const nomes = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      const r = await ixcList('cliente', 'id', id, '=', 1).catch(() => null);
      const c = r?.registros?.[0];
      // Alguns cadastros têm o CPF/CNPJ junto do nome: o número sai mascarado.
      if (c) nomes.set(id, String(c.razao || c.fantasia || c.nome || `cliente ${id}`).replace(/\d{11,14}/g, (n) => `***${n.slice(-4)}`));
    }));
  }
  const conta = (f: (c: Record<string, unknown>) => string) => lista.reduce<Record<string, number>>((o, c) => { const k = f(c); o[k] = (o[k] ?? 0) + 1; return o; }, {});
  return {
    termo: t,
    planos_encontrados: planos,
    total_contratos: lista.length,
    clientes_distintos: new Set(lista.map((c) => String(c.id_cliente))).size,
    por_status: conta((c) => CONTRATO_STATUS[String(c.status)] ?? String(c.status)),
    por_plano: conta((c) => String(c.contrato || '(sem nome)')),
    contratos: lista
      .sort((a, b) => String(nomes.get(String(a.id_cliente)) ?? '').localeCompare(String(nomes.get(String(b.id_cliente)) ?? '')))
      .map((c) => ({
        cliente: nomes.get(String(c.id_cliente)) ?? `cliente ${c.id_cliente}`,
        id_cliente: c.id_cliente,
        contrato: c.id,
        plano: c.contrato,
        status: CONTRATO_STATUS[String(c.status)] ?? c.status,
        internet: INTERNET_STATUS[String(c.status_internet)] ?? c.status_internet,
        ativacao: c.data_ativacao && String(c.data_ativacao) !== '0000-00-00' ? c.data_ativacao : null,
        bairro: c.bairro || null,
        cidade: c.cidade || null,
      })),
  };
}
