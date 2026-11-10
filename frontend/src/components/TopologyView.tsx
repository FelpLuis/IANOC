/**
 * Tela da topologia 3D: cena, contadores, filtros, legenda e ficha do equipamento
 * selecionado (com os vizinhos clicáveis). Tela cheia no desktop e no celular.
 */

import { lazy, Suspense, useMemo, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Network, Tag, X } from 'lucide-react';
import type { TopologyGraph } from '../types';
import { AiCore } from './AiCore';
import { STATUS_STYLE } from './DevicePanel';
import { cn } from '../utils/helpers';

const Topology3D = lazy(() => import('./Topology3D'));

const TIPO_LABEL: Record<string, string> = {
  olt: 'OLT', switch: 'Switch', roteador: 'Roteador', onu: 'ONU', servidor: 'Servidor', transporte: 'Transporte óptico',
  generico: 'Equipamento', servico: 'Serviços externos', nuvem: 'Internet', site: 'Site',
};
const ORIGEM_LABEL = { topologia: 'Topologia do NOC', zabbix: 'Zabbix', virtual: 'Agrupamento' } as const;

export function TopologyView({ graph, onClose }: { graph: TopologyGraph; onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showInferred, setShowInferred] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [onlyAlarms, setOnlyAlarms] = useState(false);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const node = selected ? byId.get(selected) : undefined;
  const vizinhos = useMemo(() => {
    if (!selected) return [];
    return graph.links
      .filter((l) => l.de === selected || l.para === selected)
      .map((l) => ({ link: l, outro: byId.get(l.de === selected ? l.para : l.de)! }))
      .filter((v) => v.outro);
  }, [graph, selected, byId]);
  const s = graph.resumo;

  const toggle = (on: boolean, set: (v: boolean) => void, label: string, Icon: typeof Eye) => (
    <button
      type="button"
      onClick={() => set(!on)}
      className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-all', on ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-100' : 'border-slate-700/60 text-slate-400 hover:text-slate-200')}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-xl animate-fade-in">
      <div className="hud-bg" />
      {/* topo */}
      <div className="flex flex-wrap items-center gap-3 border-b border-sky-400/10 px-4 py-3 pt-[max(env(safe-area-inset-top),0.75rem)]">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 p-1.5 text-cyan-200"><Network className="h-4 w-4" /></div>
          <div>
            <div className="font-semibold text-slate-50">Topologia da rede</div>
            <div className="hud-label">{graph.geradoEm} · {graph.fonte.replace(/\(.*?\)/g, '').trim()}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            ['Equipamentos', s.equipamentos, 'text-cyan-100'],
            ['Enlaces', s.enlaces, 'text-cyan-100'],
            ['Inferidos', s.inferidos, 'text-slate-300'],
            ['Com alarme', s.comAlarme, s.comAlarme ? 'text-red-200' : 'text-emerald-200'],
            ['Alarmes de clientes', s.alarmesClientes, 'text-amber-200'],
          ].map(([k, v, cls]) => (
            <div key={k as string} className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-2.5 py-1">
              <div className="hud-label">{k}</div>
              <div className={cn('font-mono text-sm tabular-nums', cls as string)}>{v as number}</div>
            </div>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden gap-2 sm:flex">
            {toggle(onlyAlarms, setOnlyAlarms, 'Só alarmes', AlertTriangle)}
            {toggle(showInferred, setShowInferred, 'Inferidos', showInferred ? Eye : EyeOff)}
            {toggle(showLabels, setShowLabels, 'Rótulos', Tag)}
          </div>
          <button type="button" onClick={onClose} className="icon-btn" title="Fechar (Esc)"><X className="h-5 w-5" /></button>
        </div>
      </div>

      {/* cena + ficha */}
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><AiCore size={80} state="thinking" /></div>}>
          <Topology3D graph={graph} selected={selected} onSelect={setSelected} showInferred={showInferred} showLabels={showLabels} onlyAlarms={onlyAlarms} />
        </Suspense>

        {/* filtros no celular */}
        <div className="absolute left-3 top-3 flex gap-2 sm:hidden">
          {toggle(onlyAlarms, setOnlyAlarms, 'Alarmes', AlertTriangle)}
          {toggle(showInferred, setShowInferred, 'Inferidos', showInferred ? Eye : EyeOff)}
        </div>

        {/* legenda */}
        <div className="glass pointer-events-none absolute bottom-3 left-3 hidden rounded-xl px-3 py-2 text-[11px] text-slate-300 sm:block">
          <div className="hud-label mb-1">Legenda</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(['ok', 'atencao', 'critico', 'desconhecido'] as const).map((k) => (
              <span key={k} className="flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', STATUS_STYLE[k].dot)} />{STATUS_STYLE[k].label}</span>
            ))}
          </div>
          <div className="mt-1 flex gap-3">
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-cyan-400" />enlace cadastrado</span>
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 border-t-2 border-dashed border-slate-400" />inferido</span>
          </div>
          <div className="mt-1 text-slate-500">Andares: Internet · núcleo · agregação · transporte · POPs · OLTs</div>
        </div>

        {/* ficha */}
        {node && (
          <div className="glass hud-corners absolute inset-x-2 bottom-2 max-h-[55%] overflow-y-auto rounded-2xl p-4 scrollbar-thin animate-slide-up sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-80">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="hud-label">{TIPO_LABEL[node.tipo] ?? node.tipo} · {ORIGEM_LABEL[node.origem]}</div>
                <div className="font-semibold text-slate-50">{node.nome}{node.agrupados ? ` (${node.agrupados})` : ''}</div>
              </div>
              <span className={cn('flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]', STATUS_STYLE[node.status].cls)}>
                <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_STYLE[node.status].dot)} />{STATUS_STYLE[node.status].label}
              </span>
              <button type="button" onClick={() => setSelected(null)} className="icon-btn -mr-1 p-1"><X className="h-4 w-4" /></button>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              {[['Modelo', node.modelo], ['Local', node.local], ['Camada', node.categoria], ['Portas', node.portas ? `${node.portas.usadas}/${node.portas.total} em uso` : undefined]]
                .filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="min-w-0"><dt className="hud-label">{k}</dt><dd className="truncate text-slate-200" title={v}>{v}</dd></div>
                ))}
            </dl>

            {node.alertas && node.alertas.length > 0 && (
              <div className="mt-3">
                <div className="hud-label mb-1">Alarmes</div>
                <ul className="space-y-1">
                  {node.alertas.map((a, i) => (
                    <li key={i} className="flex gap-1.5 rounded-lg border border-red-400/20 bg-red-500/5 px-2 py-1 text-[11px] text-red-100">
                      <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-300" /><span>{a}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {node.hosts && node.hosts.length > 0 && (
              <div className="mt-3">
                <div className="hud-label mb-1">Hosts no Zabbix ({node.hosts.length})</div>
                <div className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[11px] text-slate-300 scrollbar-thin">
                  {node.hosts.map((h) => <div key={h} className="truncate" title={h}>{h}</div>)}
                </div>
              </div>
            )}

            {vizinhos.length > 0 && (
              <div className="mt-3">
                <div className="hud-label mb-1">Ligações ({vizinhos.length})</div>
                <div className="space-y-1">
                  {vizinhos.map(({ link, outro }, i) => (
                    <button
                      key={`${outro.id}-${i}`}
                      type="button"
                      onClick={() => setSelected(outro.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-slate-300 transition-colors hover:bg-cyan-400/5 hover:text-cyan-100"
                    >
                      <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', STATUS_STYLE[outro.status].dot)} />
                      <span className="flex-1 truncate">{outro.nome}</span>
                      <span className={cn('font-mono text-[10px]', link.inferido ? 'text-slate-500' : 'text-cyan-300/80')}>
                        {link.inferido ? 'inferido' : link.capacidade && !/confirmar/i.test(link.capacidade) ? link.capacidade : link.tipo ?? 'enlace'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
