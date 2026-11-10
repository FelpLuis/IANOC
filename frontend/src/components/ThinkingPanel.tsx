/**
 * Enquanto a resposta não chega: núcleo da IA, frase de etapa, cronômetro e a
 * linha do tempo das consultas (cada sistema com barra de progresso até concluir).
 */

import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { AiCore } from './AiCore';
import type { ToolActivity } from '../types';
import { cn } from '../utils/helpers';

const STEPS_IDLE = ['Interpretando a pergunta', 'Planejando as consultas', 'Preparando a análise'];
const STEPS_TOOLS = ['Consultando os ambientes', 'Cruzando os dados', 'Correlacionando eventos'];
const STEPS_WRAP = ['Montando a resposta', 'Revisando os números', 'Formatando o resultado'];

const SYSTEM: Array<[RegExp, string, string]> = [
  [/^zabbix/, 'ZBX', 'text-red-300 border-red-400/40 bg-red-400/10'],
  [/^ixc/, 'IXC', 'text-amber-200 border-amber-400/40 bg-amber-400/10'],
  [/^opa/, 'OPA', 'text-emerald-200 border-emerald-400/40 bg-emerald-400/10'],
  [/^acs|^genieacs/, 'ACS', 'text-violet-200 border-violet-400/40 bg-violet-400/10'],
  [/^relatorio/, 'REL', 'text-cyan-100 border-cyan-300/50 bg-cyan-400/15'],
  [/^backbone|^ftth|topolog/, 'TOP', 'text-sky-200 border-sky-400/40 bg-sky-400/10'],
  [/^noc/, 'NOC', 'text-cyan-200 border-cyan-400/40 bg-cyan-400/10'],
  [/^web/, 'WEB', 'text-fuchsia-200 border-fuchsia-400/40 bg-fuchsia-400/10'],
];
const systemOf = (name: string) => SYSTEM.find(([re]) => re.test(name)) ?? [null, 'IA', 'text-slate-200 border-slate-500/40 bg-slate-400/10'];

export function ThinkingPanel({ toolActivity, label }: { toolActivity: ToolActivity[]; label: (name: string) => string }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  const running = toolActivity.some((t) => !t.done);
  const allDone = toolActivity.length > 0 && !running;
  const steps = running ? STEPS_TOOLS : allDone ? STEPS_WRAP : STEPS_IDLE;
  const step = steps[Math.floor((now - started) / 2600) % steps.length];
  const secs = ((now - started) / 1000).toFixed(1);

  return (
    <div className="flex gap-3 animate-reveal">
      <AiCore size={36} state="thinking" className="mt-1" />
      <div className="glass hud-corners relative w-full max-w-xl overflow-hidden rounded-2xl rounded-tl-md px-4 py-3">
        {/* varredura */}
        <span className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-cyan-300/10 to-transparent animate-shimmer" />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-cyan-100">
            <span className="font-medium">{step}</span>
            <span className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-1 w-1 rounded-full bg-cyan-300 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </span>
          </div>
          <span className="font-mono text-xs tabular-nums text-cyan-300/70">{secs}s</span>
        </div>

        {toolActivity.length > 0 && (
          <ol className="mt-3 space-y-1.5">
            {toolActivity.map((t, i) => {
              const [, tag, tone] = systemOf(t.name);
              return (
                <li key={t.id} className="flex items-center gap-2.5 text-xs animate-slide-up" style={{ animationDelay: `${i * 60}ms` }}>
                  <span className={cn('w-10 rounded border px-1 py-0.5 text-center font-mono text-[10px] tracking-wider', tone)}>{tag}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-200">{label(t.name)}</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {t.done ? (t.ms !== undefined ? `${(t.ms / 1000).toFixed(1)}s` : '') : '…'}
                      </span>
                    </span>
                    <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-slate-800">
                      <span
                        className={cn(
                          'block h-full rounded-full transition-all duration-500',
                          !t.done ? 'w-1/3 bg-cyan-400 animate-shimmer' : t.ok === false ? 'w-full bg-red-400' : 'w-full bg-gradient-to-r from-cyan-400 to-emerald-400',
                        )}
                      />
                    </span>
                  </span>
                  <span className="w-4">
                    {t.done && (t.ok === false ? <X className="h-3.5 w-3.5 text-red-400" /> : <Check className="h-3.5 w-3.5 text-emerald-400" />)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
