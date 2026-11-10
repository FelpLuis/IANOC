/**
 * Painel do aparelho: modelo 3D + dados consultados (estado, modelo, local,
 * métricas, alarmes e mapa de portas). Vários aparelhos da mesma resposta
 * aparecem como abas.
 */

import { lazy, Suspense } from 'react';
import { AlertTriangle, Box, Cpu, MapPin, Router, Server, Radio, Network, Wifi, X } from 'lucide-react';
import type { DeviceCard, DeviceKind, DeviceStatus } from '../types';
import { cn } from '../utils/helpers';
import { AiCore } from './AiCore';

const Device3D = lazy(() => import('./Device3D'));

export const KIND_LABEL: Record<DeviceKind, string> = {
  olt: 'OLT', switch: 'Switch', roteador: 'Roteador', onu: 'ONU / CPE', servidor: 'Servidor', transporte: 'Transporte óptico', generico: 'Equipamento',
};

export const KIND_ICON: Record<DeviceKind, typeof Box> = {
  olt: Server, switch: Network, roteador: Router, onu: Wifi, servidor: Cpu, transporte: Radio, generico: Box,
};

export const STATUS_STYLE: Record<DeviceStatus, { label: string; cls: string; dot: string }> = {
  ok: { label: 'Operacional', cls: 'text-emerald-200 bg-emerald-400/10 border-emerald-400/30', dot: 'bg-emerald-400' },
  atencao: { label: 'Atenção', cls: 'text-amber-200 bg-amber-400/10 border-amber-400/30', dot: 'bg-amber-400' },
  critico: { label: 'Crítico', cls: 'text-red-200 bg-red-500/10 border-red-400/40', dot: 'bg-red-400 animate-pulse' },
  desconhecido: { label: 'Sem telemetria', cls: 'text-sky-200 bg-sky-400/10 border-sky-400/30', dot: 'bg-sky-400' },
};

const portTone = (s: string) =>
  /falha|down|erro|los|alarm/i.test(s) ? 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.9)]'
    : /conect|up|ativ|online/i.test(s) ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
    : 'bg-slate-700';

export function DevicePanel({ devices, index, onIndex, onClose }: {
  devices: DeviceCard[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const device = devices[Math.min(index, devices.length - 1)];
  if (!device) return null;
  const st = STATUS_STYLE[device.status];
  const Icon = KIND_ICON[device.tipo];

  return (
    <div className="glass hud-corners flex h-full flex-col overflow-hidden rounded-2xl animate-slide-up">
      {/* cabeçalho */}
      <div className="flex items-start gap-3 border-b border-sky-400/10 px-4 py-3">
        <div className="mt-0.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 p-1.5 text-cyan-200">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="hud-label">{KIND_LABEL[device.tipo]} · {device.fonte}</div>
          <div className="truncate font-semibold text-slate-50" title={device.nome}>{device.nome}</div>
        </div>
        <span className={cn('mt-0.5 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]', st.cls)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} />
          {st.label}
        </span>
        <button type="button" onClick={onClose} className="icon-btn -mr-1 p-1" title="Fechar">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* abas */}
      {devices.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-sky-400/10 px-3 py-2 scrollbar-thin">
          {devices.map((d, i) => {
            const I = KIND_ICON[d.tipo];
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => onIndex(i)}
                className={cn(
                  'flex max-w-[11rem] flex-shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-all',
                  i === index ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-100' : 'border-slate-700/60 text-slate-400 hover:border-cyan-400/30 hover:text-slate-200',
                )}
                title={d.nome}
              >
                <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', STATUS_STYLE[d.status].dot)} />
                <I className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{d.nome}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* 3D */}
        <div className="relative h-64 border-b border-sky-400/10 bg-[radial-gradient(ellipse_at_center,rgba(14,165,233,0.12),transparent_70%)]">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><AiCore size={44} state="thinking" /></div>}>
            <Device3D key={device.id} device={device} />
          </Suspense>
          <div className="pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] text-cyan-300/50">arraste para girar · role para aproximar</div>
        </div>

        <div className="space-y-4 p-4">
          {/* ficha */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {[
              ['Modelo', device.modelo],
              ['Fabricante', device.fabricante],
              ['Categoria', device.categoria],
              ['Local', device.local],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="hud-label">{k}</dt>
                <dd className="truncate text-slate-200" title={v}>
                  {k === 'Local' && <MapPin className="mr-1 inline h-3 w-3 text-cyan-300" />}
                  {v}
                </dd>
              </div>
            ))}
          </dl>

          {/* métricas */}
          {device.metricas && device.metricas.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {device.metricas.map((m) => (
                <div key={m.nome} className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2">
                  <div className="hud-label">{m.nome}</div>
                  <div className="truncate font-mono text-sm tabular-nums text-cyan-100" title={m.valor}>{m.valor}</div>
                </div>
              ))}
            </div>
          )}

          {/* alarmes */}
          {device.alertas && device.alertas.length > 0 && (
            <div>
              <div className="hud-label mb-1.5">Alarmes</div>
              <ul className="space-y-1.5">
                {device.alertas.map((a, i) => (
                  <li key={i} className="flex gap-2 rounded-lg border border-red-400/20 bg-red-500/5 px-2.5 py-1.5 text-xs text-red-100">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-300" />
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* portas */}
          {device.portas && device.portas.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="hud-label">Mapa de portas</span>
                <span className="flex gap-2 text-[10px] text-slate-400">
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-emerald-400" />em uso</span>
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-slate-700" />livre</span>
                  <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-sm bg-red-400" />falha</span>
                </span>
              </div>
              <div className="grid grid-cols-12 gap-1">
                {device.portas.map((p) => (
                  <span
                    key={p.numero}
                    className={cn('h-3 rounded-sm transition-transform hover:scale-125', portTone(p.status))}
                    title={`Porta ${p.numero} · ${p.status}${p.tipo ? ` · ${p.tipo}` : ''}${p.capacidade ? ` · ${p.capacidade}` : ''}${p.descricao ? ` · ${p.descricao}` : ''}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
