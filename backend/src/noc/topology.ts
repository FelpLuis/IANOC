/**
 * Topologia da rede para o painel 3D: junta o backbone cadastrado (sistema NOC ou
 * sementes da topologia) com os hosts de infraestrutura do Zabbix e o estado dos
 * alarmes ativos.
 *
 * - Equipamento cadastrado + enlaces cadastrados: exatos.
 * - Host de infraestrutura do Zabbix: liga ao equipamento cadastrado do mesmo modelo
 *   e local (ex.: "SWITCH S6730 SANTOS" → 6730 • POP Santos); sem correspondência,
 *   vira um nó próprio, ligado ao site pelo nome (enlace "inferido", tracejado).
 * - Trânsito/IX, serviços externos monitorados e clientes dedicados ficam agrupados
 *   em volta da nuvem "Internet", ligada ao núcleo.
 * Hosts de cliente (ONUs) não entram como nó: são centenas; entram só na contagem.
 */

import { connectorEnabled } from './config.js';
import { getKnowledge, type Equipamento } from './knowledge.js';
import { activeProblems, listHosts } from './connectors/zabbix.js';
import { classify, type DeviceKind, type DeviceStatus } from './devices.js';
import { horaLocal } from './http.js';

export type TopoKind = DeviceKind | 'servico' | 'nuvem' | 'site';

export interface TopoNode {
  id: string;
  nome: string;
  tipo: TopoKind;
  camada: number;                 // altura no 3D: nuvem em cima, acesso embaixo
  origem: 'topologia' | 'zabbix' | 'virtual';
  status: DeviceStatus;
  modelo?: string;
  local?: string;
  categoria?: string;
  hosts?: string[];               // hosts do Zabbix ligados a este nó
  alertas?: string[];
  portas?: { usadas: number; total: number };
  agrupados?: number;             // nós que representam um grupo (ex.: 51 serviços)
}

export interface TopoLink { de: string; para: string; capacidade?: string; tipo?: string; gbps?: number; inferido?: boolean; status: 'ok' | 'alerta' | 'desconhecido' }

export interface TopologyGraph {
  nodes: TopoNode[];
  links: TopoLink[];
  fonte: string;
  geradoEm: string;
  resumo: { equipamentos: number; enlaces: number; inferidos: number; comAlarme: number; hostsZabbix: number; alarmesClientes: number; erros?: string[] };
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const semPrefixo = (nome: string) => nome.replace(/^\s*\d{5}\s*UPT\s*\|\s*/i, '').replace(/\s+/g, ' ').trim();

// Locais conhecidos pelos nomes dos hosts (para agrupar por site).
const LOCAIS = ['ASCENTY', 'SANTOS', 'SAO VICENTE', 'PRAIA GRANDE', 'RIO BRANCO', 'VILA NATAL', 'CASQUEIRO', 'CUBATAO', 'GUARUJA', 'BERTIOGA', 'MONGAGUA', 'ITANHAEM', 'PERUIBE', 'CPD'];
const localDe = (s: string) => LOCAIS.find((l) => norm(s).includes(l));

// Identificadores de modelo que aparecem tanto na topologia quanto nos nomes do Zabbix.
const modelTokens = (s: string) => [...new Set((norm(s).match(/\b(?:[A-Z]{0,3}\d{3,5}[A-Z]?\d?|F1A|M8|C3\d0|C6\d0)\b/g) ?? []).map((t) => t.replace(/^S(?=\d{4})/, '').replace(/^NE(?=\d)/, '')))];

const INFRA_NOME = /\b(NE\s?\d{3,4}|SWITCH\d*|S\d{4}|OLT|SERVIDOR|SERVER|PVE\d*|ROUTER|ROTEADOR|BGP|PPPOE|NOKIA|DATACOM|DWDM\d*|MIKROTIK|CCR\d*|CRS\d*|CONCENTRADOR|BRAS|BNG|ZABBIX|GRAFANA|DNS|PROXY|TACACS|NAGIOS|CGNAT|WANGUARD|FLOW|CDN|ISIS|ENERGIA)\b/;
const TRANSITO = /\b(TRANSITO|IXBR|IX\.?BR|PTT|IP ISIS|IP CONLINE|CDN)\b/;
const SERVICO_EXTERNO = /^MONITORAMENTO\b(?!.*ENERGIA)/;
const CLIENTE_DEDICADO = /\bCLIENTE(\b|_)/;

const SEV_RANK: Record<string, number> = { desastre: 5, alta: 4, 'média': 3, 'atenção': 2, 'informação': 1 };
const statusDe = (sev: number): DeviceStatus => (sev >= 4 ? 'critico' : sev >= 2 ? 'atencao' : 'ok');

function camadaDe(tipo: TopoKind, categoria?: string): number {
  const c = norm(categoria ?? '');
  if (tipo === 'nuvem') return 3.2;
  if (tipo === 'servico') return 3.2;
  if (/NUCLEO|CORE|BORDA|BGP/.test(c)) return 2;
  if (/AGREGA/.test(c)) return 1;
  if (/TRANSPORTE/.test(c) || tipo === 'transporte') return 0.2;
  if (/DISTRIBUI|POP|CONCENTRADOR/.test(c)) return -0.6;
  if (tipo === 'site') return -0.9;
  if (tipo === 'olt') return -1.8;
  if (tipo === 'servidor') return 1.2;
  if (tipo === 'roteador') return 1.6;
  if (tipo === 'switch') return -1.4;
  return -1.2;
}

function capGbps(c?: string) {
  const n = String(c ?? '').match(/\d+(?:[.,]\d+)?/g)?.map((x) => Number(x.replace(',', '.')));
  return n?.length ? Math.max(...n) : undefined;
}

export async function buildTopology(opts: { incluirZabbix?: boolean } = {}): Promise<TopologyGraph> {
  const k = await getKnowledge();
  const nodes = new Map<string, TopoNode>();
  const links: TopoLink[] = [];
  const erros: string[] = [];

  // ---------------- backbone cadastrado
  for (const e of k.equipamentos) {
    const tipo = classify(e.modelo, e.categoria, e.nome);
    const portas = e.portas ?? [];
    nodes.set(e.id, {
      id: e.id, nome: e.nome, tipo, camada: camadaDe(tipo, e.categoria), origem: 'topologia', status: 'desconhecido',
      modelo: e.modelo, local: e.local, categoria: e.categoria,
      ...(portas.length ? { portas: { usadas: portas.filter((p) => /conect|up|ativ/i.test(String(p.status))).length, total: portas.length } } : {}),
    });
  }
  for (const c of k.conexoes) {
    if (!nodes.has(c.origem) || !nodes.has(c.destino)) continue;
    links.push({ de: c.origem, para: c.destino, capacidade: c.capacidade, tipo: c.tipo, gbps: capGbps(c.capacidade), status: 'desconhecido' });
  }

  let hostsZabbix = 0;
  let alarmesClientes = 0;
  if (opts.incluirZabbix !== false && connectorEnabled('zabbix')) {
    const [hostsRes, probsRes] = await Promise.allSettled([listHosts(), activeProblems({ minSeverity: 2, limit: 2000 })]);
    const hosts = hostsRes.status === 'fulfilled' ? hostsRes.value.hosts : [];
    if (hostsRes.status === 'rejected') erros.push(`Zabbix (hosts): ${hostsRes.reason instanceof Error ? hostsRes.reason.message : hostsRes.reason}`);
    const problems = probsRes.status === 'fulfilled' ? probsRes.value.problems : [];
    if (probsRes.status === 'rejected') erros.push(`Zabbix (alarmes): ${probsRes.reason instanceof Error ? probsRes.reason.message : probsRes.reason}`);

    // Alarmes por host (nome sem prefixo de proxy).
    const sevPorHost = new Map<string, { sev: number; alertas: string[] }>();
    for (const p of problems) {
      const h = semPrefixo(p.host);
      const cur = sevPorHost.get(h) ?? { sev: 0, alertas: [] };
      cur.sev = Math.max(cur.sev, SEV_RANK[p.severidade] ?? 0);
      if (cur.alertas.length < 4) cur.alertas.push(`${String(p.problema)} (desde ${p.desde})`);
      sevPorHost.set(h, cur);
      if (/^o cliente\b/i.test(String(p.problema))) alarmesClientes++;
    }

    // Hosts de infraestrutura, sem duplicar o mesmo host visto pelas duas instâncias.
    const infra = new Map<string, { nome: string; grupos: string[] }>();
    for (const h of hosts) {
      const nome = semPrefixo(h.nome);
      const n = norm(nome);
      const grupoInfra = h.grupos.some((g) => /links|olts|zabbix servers/i.test(g));
      const prefixoInfra = /^\s*(18400|18401|18450|18402|18403)\b/.test(h.nome);
      if (!(grupoInfra || (prefixoInfra && (INFRA_NOME.test(n) || TRANSITO.test(n) || SERVICO_EXTERNO.test(n) || CLIENTE_DEDICADO.test(n) || /^\s*1840[1]\b/.test(h.nome))))) continue;
      if (!infra.has(n)) infra.set(n, { nome, grupos: h.grupos });
    }
    hostsZabbix = infra.size;

    const eqs = [...nodes.values()].filter((n) => n.origem === 'topologia');
    const anexar = (node: TopoNode, host: string) => {
      node.hosts = [...new Set([...(node.hosts ?? []), host])];
      const s = sevPorHost.get(host);
      const sev = s?.sev ?? 0;
      const atual = node.status === 'critico' ? 4 : node.status === 'atencao' ? 2 : node.status === 'ok' ? 1 : 0;
      if (sev >= 4 || (sev >= 2 && atual < 4) || atual === 0) node.status = statusDe(sev);
      if (s?.alertas.length) node.alertas = [...(node.alertas ?? []), ...s.alertas.map((a) => `${host}: ${a}`)].slice(0, 6);
    };

    // Núcleo para pendurar Internet, servidores e clientes dedicados.
    const nucleo = eqs.find((n) => /NUCLEO|BGP/.test(norm(n.categoria ?? ''))) ?? eqs[0];
    const ensure = (id: string, base: Omit<TopoNode, 'id'>) => nodes.get(id) ?? nodes.set(id, { id, ...base }).get(id)!;
    const linkInferido = (de: string, para: string, tipo: string) => {
      if (!links.some((l) => (l.de === de && l.para === para) || (l.de === para && l.para === de))) links.push({ de, para, tipo, inferido: true, status: 'desconhecido' });
    };

    for (const { nome } of infra.values()) {
      const n = norm(nome);
      // 1) trânsito / IX / serviços externos / clientes dedicados → em volta da Internet
      if (SERVICO_EXTERNO.test(n) || TRANSITO.test(n) || CLIENTE_DEDICADO.test(n)) {
        const nuvem = ensure('internet', { nome: 'Internet', tipo: 'nuvem', camada: camadaDe('nuvem'), origem: 'virtual', status: 'ok' });
        if (nucleo) linkInferido(nucleo.id, 'internet', 'Upstream');
        if (SERVICO_EXTERNO.test(n)) {
          const g = ensure('servicos', { nome: 'Serviços monitorados', tipo: 'servico', camada: 3.6, origem: 'virtual', status: 'ok', agrupados: 0 });
          g.agrupados = (g.agrupados ?? 0) + 1;
          anexar(g, nome);
          linkInferido('internet', 'servicos', 'Monitoramento');
        } else if (CLIENTE_DEDICADO.test(n)) {
          const g = ensure('dedicados', { nome: 'Clientes dedicados / trânsito', tipo: 'generico', camada: 2.6, origem: 'virtual', status: 'ok', agrupados: 0 });
          g.agrupados = (g.agrupados ?? 0) + 1;
          anexar(g, nome);
          if (nucleo) linkInferido(nucleo.id, 'dedicados', 'Clientes');
        } else {
          const id = `zbx:${n}`;
          const t = ensure(id, { nome, tipo: 'roteador', camada: 2.8, origem: 'zabbix', status: 'ok', categoria: 'Trânsito / IX' });
          anexar(t, nome);
          linkInferido('internet', id, 'Trânsito');
          if (nucleo) linkInferido(nucleo.id, id, 'BGP');
        }
        continue;
      }

      // 2) mesmo equipamento da topologia (modelo + local)
      const toks = modelTokens(nome);
      const local = localDe(nome);
      let melhor: { node: TopoNode; score: number } | undefined;
      for (const e of eqs) {
        const etoks = modelTokens(`${e.nome} ${e.modelo ?? ''} ${e.id}`);
        const comum = toks.filter((t) => etoks.includes(t)).length;
        if (!comum) continue;
        const elocal = localDe(`${e.nome} ${e.local ?? ''}`);
        if (local && elocal && local !== elocal) continue;
        const score = comum * 2 + (local && elocal === local ? 3 : 0);
        if (!melhor || score > melhor.score) melhor = { node: e, score };
      }
      if (melhor) { anexar(melhor.node, nome); continue; }

      // 3) nó próprio, ligado ao site (inferido pelo nome) ou ao CPD
      const tipo: TopoKind = /ENERGIA/.test(n) ? 'generico'
        : classify(nome) === 'generico' && /DNS|PROXY|TACACS|NAGIOS|ZABBIX|GRAFANA|WIN|SERVIDOR|WANGUARD|FLOW|CGNAT/.test(n) ? 'servidor' : classify(nome);
      const id = `zbx:${n}`;
      const node = ensure(id, { nome, tipo, camada: camadaDe(tipo), origem: 'zabbix', status: 'ok', local: local ? local.replace(/\b\w/g, (c) => c) : undefined });
      anexar(node, nome);
      if (tipo === 'servidor' || local === 'CPD') {
        const cpd = ensure('site:CPD', { nome: 'CPD / Servidores', tipo: 'site', camada: 1.2, origem: 'virtual', status: 'ok' });
        linkInferido('site:CPD', id, 'Gerência');
        if (nucleo) linkInferido(nucleo.id, cpd.id, 'Gerência');
      } else if (local) {
        // Equipamento cadastrado no mesmo local vira o ponto de ligação; senão, um nó de site.
        const ancora = eqs.find((e) => localDe(`${e.nome} ${e.local ?? ''}`) === local && /POP|DISTRIBUI|AGREGA|NUCLEO/.test(norm(e.categoria ?? '')));
        if (ancora) linkInferido(ancora.id, id, 'Mesmo local');
        else {
          const siteId = `site:${local}`;
          ensure(siteId, { nome: `Site ${local.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}`, tipo: 'site', camada: camadaDe('site'), origem: 'virtual', status: 'ok', local });
          linkInferido(siteId, id, 'Mesmo local');
        }
      } else if (nucleo) linkInferido(nucleo.id, id, 'Sem local');
    }

    // Transporte do mesmo modelo em locais diferentes (ex.: DWDM4920 Ascenty ↔ Praia Grande) é um enlace entre os sites.
    const transportes = [...nodes.values()].filter((n) => n.origem === 'zabbix' && n.tipo === 'transporte');
    for (const a of transportes) for (const b of transportes) {
      if (a.id >= b.id) continue;
      const comum = modelTokens(a.nome).some((t) => modelTokens(b.nome).includes(t));
      if (comum && localDe(a.nome) !== localDe(b.nome)) linkInferido(a.id, b.id, 'Transporte óptico');
    }
    // Site sem ligação com o resto: pendura no núcleo (tracejado), para não ficar solto.
    const alcancavel = (inicio: string) => {
      const vistos = new Set([inicio]);
      const fila = [inicio];
      while (fila.length) {
        const x = fila.shift()!;
        for (const l of links) for (const [p, q] of [[l.de, l.para], [l.para, l.de]]) if (p === x && !vistos.has(q)) { vistos.add(q); fila.push(q); }
      }
      return vistos;
    };
    if (nucleo) {
      const ligados = alcancavel(nucleo.id);
      for (const n of [...nodes.values()]) {
        if (n.tipo !== 'site' || ligados.has(n.id)) continue;
        linkInferido(nucleo.id, n.id, 'Sem enlace cadastrado');
        for (const id of alcancavel(n.id)) ligados.add(id);
      }
    }

    // Site herda o pior estado dos seus nós.
    for (const n of nodes.values()) {
      if (n.tipo !== 'site' && n.tipo !== 'nuvem') continue;
      const filhos = links.filter((l) => l.de === n.id).map((l) => nodes.get(l.para)!).filter(Boolean);
      if (filhos.some((f) => f.status === 'critico')) n.status = 'atencao';
    }
  }

  // Enlace em alerta quando uma das pontas está crítica.
  for (const l of links) {
    const a = nodes.get(l.de); const b = nodes.get(l.para);
    if (!a || !b) continue;
    l.status = a.status === 'critico' || b.status === 'critico' ? 'alerta' : a.status === 'desconhecido' && b.status === 'desconhecido' ? 'desconhecido' : 'ok';
  }

  const lista = [...nodes.values()];
  return {
    nodes: lista,
    links,
    fonte: `${k.fonte}${connectorEnabled('zabbix') && opts.incluirZabbix !== false ? ' + Zabbix ao vivo' : ''}`,
    geradoEm: horaLocal(new Date()),
    resumo: {
      equipamentos: lista.filter((n) => n.origem !== 'virtual').length,
      enlaces: links.filter((l) => !l.inferido).length,
      inferidos: links.filter((l) => l.inferido).length,
      comAlarme: lista.filter((n) => n.status === 'critico' || n.status === 'atencao').length,
      hostsZabbix,
      alarmesClientes,
      ...(erros.length ? { erros } : {}),
    },
  };
}

export type { Equipamento };
