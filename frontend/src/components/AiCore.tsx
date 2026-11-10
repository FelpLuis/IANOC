/**
 * Núcleo animado da IA: anéis girando em volta de um núcleo que "respira".
 * O estado muda cor e velocidade: parado, pensando, ouvindo, falando.
 */

import { cn } from '../utils/helpers';

export type CoreState = 'idle' | 'thinking' | 'listening' | 'speaking';

const PALETTE: Record<CoreState, { core: string; ring: string; glow: string }> = {
  idle: { core: 'from-cyan-300 via-sky-400 to-indigo-500', ring: 'border-cyan-300/50', glow: 'rgba(18,186,234,0.55)' },
  thinking: { core: 'from-cyan-200 via-sky-400 to-violet-500', ring: 'border-sky-300/70', glow: 'rgba(18,186,234,0.8)' },
  listening: { core: 'from-rose-300 via-pink-400 to-fuchsia-500', ring: 'border-rose-300/70', glow: 'rgba(244,114,182,0.75)' },
  speaking: { core: 'from-emerald-200 via-cyan-300 to-sky-500', ring: 'border-emerald-300/70', glow: 'rgba(52,211,153,0.75)' },
};

export function AiCore({ size = 40, state = 'idle', className }: { size?: number; state?: CoreState; className?: string }) {
  const p = PALETTE[state];
  const fast = state !== 'idle';
  return (
    <div className={cn('relative flex-shrink-0', className)} style={{ width: size, height: size }} aria-hidden>
      {/* ondas */}
      {fast && (
        <>
          <span className={cn('absolute inset-0 rounded-full border', p.ring)} style={{ animation: 'core-wave 1.8s ease-out infinite' }} />
          <span className={cn('absolute inset-0 rounded-full border', p.ring)} style={{ animation: 'core-wave 1.8s ease-out 0.9s infinite' }} />
        </>
      )}
      {/* anéis */}
      <span
        className={cn('absolute inset-0 rounded-full border-2 border-dashed', p.ring)}
        style={{ animation: `spin ${fast ? 3 : 12}s linear infinite` }}
      />
      <span
        className={cn('absolute rounded-full border', p.ring)}
        style={{ inset: size * 0.12, borderTopColor: 'transparent', borderBottomColor: 'transparent', animation: `spinRev ${fast ? 1.6 : 8}s linear infinite` }}
      />
      {/* núcleo */}
      <span
        className={cn('absolute rounded-full bg-gradient-to-br', p.core)}
        style={{
          inset: size * 0.27,
          boxShadow: `0 0 ${size * 0.45}px ${size * 0.06}px ${p.glow}`,
          animation: `core-breathe ${fast ? 1.1 : 3.2}s ease-in-out infinite`,
        }}
      />
      <span className="absolute rounded-full bg-white/80 blur-[1px]" style={{ width: size * 0.1, height: size * 0.1, left: size * 0.4, top: size * 0.36 }} />
    </div>
  );
}
