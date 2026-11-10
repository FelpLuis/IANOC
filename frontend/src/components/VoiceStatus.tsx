/** Faixa de estado da voz: ouvindo, transcrevendo, consultando, falando. */

import { cn } from '../utils/helpers';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

const LABEL: Record<VoiceState, string> = {
  idle: 'Modo conversa ligado',
  listening: 'Ouvindo…',
  transcribing: 'Transcrevendo…',
  thinking: 'Consultando…',
  speaking: 'Falando',
};

const COLOR: Record<VoiceState, string> = {
  idle: 'bg-primary-400',
  listening: 'bg-red-500',
  transcribing: 'bg-amber-500',
  thinking: 'bg-sky-500',
  speaking: 'bg-primary-500',
};

export function VoiceStatus(props: {
  state: VoiceState;
  interim?: string;
  conversation: boolean;
  aiEffect: boolean;
  onToggleEffect: () => void;
  onInterrupt?: () => void;
}) {
  const { state, interim, conversation, aiEffect, onToggleEffect, onInterrupt } = props;
  const hint = state === 'speaking'
    ? 'toque ou Esc para interromper'
    : state === 'listening'
      ? 'pode falar; uma pausa curta envia'
      : conversation ? 'diga "encerrar" para sair' : '';

  return (
    <div className="glass mb-2 flex items-center gap-3 rounded-xl px-3 py-2 text-sm animate-slide-up">
      <button
        type="button"
        onClick={onInterrupt}
        disabled={!onInterrupt}
        className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full disabled:cursor-default"
        title={onInterrupt ? (state === 'speaking' ? 'Interromper' : 'Enviar agora') : undefined}
      >
        {(state === 'listening' || state === 'thinking') && (
          <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-40', COLOR[state])} />
        )}
        {state === 'speaking' ? (
          <span className="flex h-5 items-center gap-[3px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="voice-bar h-full w-[3px] rounded-full bg-cyan-300" style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </span>
        ) : (
          <span className={cn('relative inline-flex h-3.5 w-3.5 rounded-full', COLOR[state])} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-slate-100">
          {state === 'listening' && interim ? `“${interim}”` : LABEL[state]}
        </div>
        {hint && <div className="truncate text-xs text-slate-400">{hint}</div>}
      </div>

      <button
        type="button"
        onClick={onToggleEffect}
        className={cn(
          'flex-shrink-0 rounded-full px-2.5 py-1 text-xs transition-colors',
          aiEffect
            ? 'bg-cyan-400/15 text-cyan-100'
            : 'bg-slate-800 text-slate-400'
        )}
        title="Tratamento de voz de assistente digital"
      >
        Efeito IA {aiEffect ? 'ligado' : 'desligado'}
      </button>
    </div>
  );
}
