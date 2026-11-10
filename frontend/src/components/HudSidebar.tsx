/**
 * Painel lateral: estado dos sistemas que o assistente alcança, ações rápidas,
 * aparelhos já consultados nesta conversa e o usuário.
 */

import { useEffect, useState } from 'react';
import { Activity, FileBarChart, LogOut, ShieldAlert, Headset, CalendarDays, User, X, Network } from 'lucide-react';
import { AiCore } from './AiCore';
import { KIND_ICON, STATUS_STYLE } from './DevicePanel';
import type { DeviceCard } from '../types';
import { cn } from '../utils/helpers';

interface NocStatus {
  llm?: { configured: boolean; model: string };
  connectors?: Record<string, boolean>;
  knowledge?: { equipamentos?: number; caixas?: number };
}

const SYSTEMS: Array<[string, string]> = [
  ['zabbix', 'Zabbix'],
  ['ixc', 'IXC Soft'],
  ['opa', 'Opa! Suite'],
  ['noc', 'Sistema NOC'],
  ['genieacs', 'GenieACS'],
];

export const QUICK_ACTIONS: Array<{ label: string; prompt: string; icon: typeof Activity }> = [
  { label: 'Alarmes agora', prompt: 'Quais alarmes de severidade alta ou desastre estão abertos agora?', icon: ShieldAlert },
  { label: 'Topologia 3D', prompt: 'Gere a topologia 3D da minha rede backbone', icon: Network },
  { label: 'Relatório de hoje', prompt: 'Gere o relatório do NOC de hoje.', icon: FileBarChart },
  { label: 'Relatório de ontem', prompt: 'Gere o relatório do NOC de ontem.', icon: CalendarDays },
  { label: 'Relatório da semana', prompt: 'Gere o relatório do NOC da semana.', icon: Activity },
  { label: 'Fila do atendimento', prompt: 'Como está a fila de atendimentos no Opa agora? Quantos aguardando e há quanto tempo?', icon: Headset },
];

export function HudSidebar({ user, onLogout, onAction, devices, onOpenDevice, onClose, busy }: {
  user: { username: string; display_name?: string; role: string };
  onLogout: () => void;
  onAction: (prompt: string) => void;
  devices: DeviceCard[];
  onOpenDevice: (index: number) => void;
  onClose?: () => void;
  busy: boolean;
}) {
  const [status, setStatus] = useState<NocStatus | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/noc/status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null)).then(setStatus).catch(() => {});
    load();
    const t = window.setInterval(load, 60000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="glass flex h-full flex-col border-r border-sky-400/10">
      {/* marca */}
      <div className="flex items-center gap-3 px-5 pb-4 pt-5">
        <AiCore size={42} state={busy ? 'thinking' : 'idle'} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-bold tracking-[0.2em] neon-text" style={{ fontFamily: 'Orbitron, Inter, sans-serif' }}>NIA</div>
          <div className="hud-label">IA NOC · UpDown</div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="icon-btn lg:hidden" title="Fechar">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-4 scrollbar-thin">
        {/* sistemas */}
        <section>
          <div className="hud-label mb-2 px-1">Sistemas</div>
          <ul className="space-y-1">
            {SYSTEMS.map(([key, label]) => {
              const on = status?.connectors?.[key];
              return (
                <li key={key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm">
                  <span className="relative flex h-2 w-2">
                    {on && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />}
                    <span className={cn('relative inline-flex h-2 w-2 rounded-full', on ? 'bg-emerald-400' : status ? 'bg-slate-600' : 'bg-slate-700 animate-pulse')} />
                  </span>
                  <span className={cn('flex-1', on ? 'text-slate-200' : 'text-slate-500')}>{label}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{status ? (on ? 'online' : 'off') : '···'}</span>
                </li>
              );
            })}
          </ul>
          {status?.llm && (
            <div className="mt-2 rounded-lg border border-slate-700/60 bg-slate-900/50 px-3 py-2">
              <div className="hud-label">Modelo</div>
              <div className="truncate font-mono text-xs text-cyan-100" title={status.llm.model}>{status.llm.model}</div>
            </div>
          )}
          {status?.knowledge && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 px-3 py-2">
                <div className="hud-label">Equip.</div>
                <div className="font-mono text-sm tabular-nums text-cyan-100">{status.knowledge.equipamentos ?? 0}</div>
              </div>
              <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 px-3 py-2">
                <div className="hud-label">Caixas</div>
                <div className="font-mono text-sm tabular-nums text-cyan-100">{status.knowledge.caixas ?? 0}</div>
              </div>
            </div>
          )}
        </section>

        {/* ações */}
        <section>
          <div className="hud-label mb-2 px-1">Ações rápidas</div>
          <div className="space-y-1">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={busy}
                onClick={() => onAction(a.prompt)}
                className="group flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 text-left text-sm text-slate-300 transition-all hover:border-cyan-400/20 hover:bg-cyan-400/5 hover:text-cyan-100 disabled:opacity-40"
              >
                <a.icon className="h-4 w-4 text-cyan-400/70 transition-colors group-hover:text-cyan-300" />
                {a.label}
              </button>
            ))}
          </div>
        </section>

        {/* aparelhos */}
        {devices.length > 0 && (
          <section>
            <div className="hud-label mb-2 px-1">Aparelhos consultados</div>
            <div className="space-y-1">
              {devices.map((d, i) => {
                const I = KIND_ICON[d.tipo];
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onOpenDevice(i)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-slate-300 transition-colors hover:bg-cyan-400/5 hover:text-cyan-100"
                    title={d.nome}
                  >
                    <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', STATUS_STYLE[d.status].dot)} />
                    <I className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400/70" />
                    <span className="truncate">{d.nome}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* usuário */}
      <div className="flex items-center gap-3 border-t border-sky-400/10 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10">
          <User className="h-4 w-4 text-cyan-200" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-slate-200">{user.display_name || user.username}</div>
          <div className="hud-label">{user.role}</div>
        </div>
        <button type="button" onClick={onLogout} className="icon-btn" title="Sair">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
