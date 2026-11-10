/**
 * Modo conversa no celular: tela cheia com o núcleo da IA no centro, o que foi
 * ouvido, o resumo da última resposta e os controles grandes (interromper/falar,
 * encerrar). No desktop o modo conversa usa só a faixa de estado acima do campo.
 */

import { Mic, PhoneOff, Square, Volume2, VolumeX } from 'lucide-react';
import { AiCore, type CoreState } from './AiCore';
import { cn } from '../utils/helpers';

const LABEL: Record<CoreState, string> = {
  idle: 'Toque no microfone para falar',
  listening: 'Ouvindo…',
  thinking: 'Consultando…',
  speaking: 'Falando',
};

export function VoiceOverlay(props: {
  state: CoreState;
  transcribing: boolean;
  level: number;
  interim: string;
  lastQuestion?: string;
  lastAnswer?: string;
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  onMic: () => void;
  onEnd: () => void;
}) {
  const { state, transcribing, level, interim, lastQuestion, lastAnswer, autoSpeak, onToggleAutoSpeak, onMic, onEnd } = props;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-xl md:hidden animate-fade-in">
      <div className="hud-bg" />
      <div className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),1rem)]">
        <span className="hud-label">NIA · modo conversa</span>
        <button type="button" onClick={onToggleAutoSpeak} className={autoSpeak ? 'icon-btn-active' : 'icon-btn'} title="Ler todas as respostas">
          {autoSpeak ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 text-center">
        <div className="relative">
          {/* halo que acompanha o volume do microfone */}
          <span
            className="absolute inset-0 rounded-full bg-rose-400/20 blur-xl transition-transform duration-100"
            style={{ transform: `scale(${state === 'listening' ? 1 + level * 0.9 : 0.6})` }}
          />
          <AiCore size={180} state={state} />
        </div>

        <div className="min-h-[5rem] max-w-sm space-y-2">
          <div className={cn('text-lg font-medium', state === 'listening' ? 'text-rose-100' : 'text-cyan-100')}>
            {transcribing ? 'Entendendo…' : LABEL[state]}
          </div>
          {state === 'listening' && interim && <p className="text-slate-300">“{interim}”</p>}
          {state !== 'listening' && lastQuestion && <p className="line-clamp-2 text-sm text-slate-400">Você: {lastQuestion}</p>}
          {state === 'speaking' && lastAnswer && <p className="line-clamp-4 text-sm text-slate-300">{lastAnswer}</p>}
        </div>
      </div>

      <div className="flex items-center justify-center gap-10 pb-[max(env(safe-area-inset-bottom),2rem)]">
        <button
          type="button"
          onClick={onEnd}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-red-400/40 bg-red-500/15 text-red-200 active:scale-95"
          title="Encerrar"
        >
          <PhoneOff className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={onMic}
          disabled={state === 'thinking' || transcribing}
          className={cn(
            'flex h-20 w-20 items-center justify-center rounded-full text-slate-950 transition-transform active:scale-95 disabled:opacity-50',
            state === 'listening' ? 'bg-gradient-to-br from-rose-300 to-fuchsia-500' : 'bg-gradient-to-br from-cyan-300 via-sky-400 to-indigo-500',
          )}
          style={{ boxShadow: state === 'listening' ? '0 0 40px -6px rgba(244,114,182,0.9)' : '0 0 40px -8px rgba(34,211,238,0.9)' }}
          title={state === 'speaking' ? 'Interromper e falar' : state === 'listening' ? 'Enviar agora' : 'Falar'}
        >
          {state === 'listening' ? <Square className="h-7 w-7" /> : <Mic className="h-8 w-8" />}
        </button>
        <span className="h-14 w-14" />
      </div>
    </div>
  );
}
