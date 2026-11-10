/**
 * NIA TV: tela de parede do NOC (abra /tv numa TV ou monitor). Mostra só as perguntas
 * feitas por voz em qualquer sessão da NIA e as respostas, ao vivo e em letras grandes.
 *
 * - Pergunta chegando: a pergunta em destaque e as consultas em andamento.
 * - Resposta: texto em tamanho de TV (rola sozinho se for longo) e, se houver, o dashboard.
 * - Lateral: as últimas perguntas por voz; clique para rever uma.
 * - Controles (somem sozinhos): tela cheia, ler respostas em voz alta, voltar ao chat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Clock3, Maximize, Mic, Minimize, Radio, Tv, Volume2, VolumeX } from 'lucide-react';
import { ws } from '../services/websocket';
import type { Dashboard } from '../types';
import { AiCore } from './AiCore';
import { DashboardBoard } from './dashboard/DashboardBoard';
import { toolLabel } from './ChatInterface';
import { markdownToSpeech, useVoice } from '../hooks/useVoice';
import { cn } from '../utils/helpers';

interface Resultado {
  id: string; pergunta: string; resposta: string; usuario: string; quando: number; ms: number;
  modelo?: string; sistemas: string[]; dashboard?: Dashboard; erro?: boolean;
}
interface Pensando { id: string; pergunta: string; usuario: string; quando: number; etapas: string[] }

const SOM_KEY = 'nia.tv.som';
const lerSom = () => { try { return localStorage.getItem(SOM_KEY) === '1'; } catch { return false; } };
const hora = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const segundos = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;

function Relogio() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setAgora(new Date()), 1000); return () => window.clearInterval(t); }, []);
  return (
    <div className="text-right">
      <div className="font-display text-3xl font-bold tabular-nums tracking-wider text-white lg:text-4xl">{agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
      <div className="font-mono text-xs uppercase tracking-[0.25em] text-cyan-300/70">{agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long' })}</div>
    </div>
  );
}

/** Rola devagar um conteúdo maior que a tela: desce, espera no fim e volta ao topo. */
function useAutoScroll(ref: React.RefObject<HTMLDivElement>, chave: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = 0;
    let parado = 0;
    let ultimo = performance.now();
    let frame = 0;
    let pausaAte = performance.now() + 6000; // lê o começo com calma
    const passo = (t: number) => {
      const dt = t - ultimo; ultimo = t;
      if (t >= pausaAte && el.scrollHeight - el.clientHeight > 8) {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          if (!parado) parado = t;
          if (t - parado > 8000) { el.scrollTo({ top: 0, behavior: 'smooth' }); parado = 0; pausaAte = t + 7000; }
        } else {
          el.scrollTop += (dt / 1000) * 38; // ~38 px/s
        }
      }
      frame = requestAnimationFrame(passo);
    };
    frame = requestAnimationFrame(passo);
    // Mexeu na rolagem com o mouse: pausa a rolagem automática por 20 s.
    const segura = () => { pausaAte = performance.now() + 20000; };
    el.addEventListener('wheel', segura, { passive: true });
    el.addEventListener('touchstart', segura, { passive: true });
    return () => { cancelAnimationFrame(frame); el.removeEventListener('wheel', segura); el.removeEventListener('touchstart', segura); };
  }, [ref, chave]);
}

export function NiaTv() {
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [pensando, setPensando] = useState<Pensando | null>(null);
  const [online, setOnline] = useState(false);
  const [telas, setTelas] = useState(0);
  const [som, setSom] = useState(lerSom);
  const [controles, setControles] = useState(true);
  const [cheia, setCheia] = useState(Boolean(document.fullscreenElement));
  const [serverSpeech, setServerSpeech] = useState(false);
  const voice = useVoice({ serverTranscription: false, serverSpeech, aiEffect: false });
  const somRef = useRef(som);
  somRef.current = som;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const rolagem = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/noc/status', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).then((s) => setServerSpeech(Boolean(s?.voice?.serverSpeech))).catch(() => {});
  }, []);

  // Conexão: inscreve como TV a cada (re)conexão (o servidor manda "welcome" ao conectar).
  useEffect(() => {
    const offs = [
      ws.on('welcome', () => { setOnline(true); ws.send('tv_subscribe', {}); }),
      ws.on('tv_historico', (m) => {
        const p = m.payload as { resultados: Resultado[]; telas: number };
        setResultados(p.resultados ?? []);
        setTelas(p.telas ?? 1);
      }),
      ws.on('tv_pensando', (m) => {
        const p = m.payload as Omit<Pensando, 'etapas'>;
        setPensando({ ...p, etapas: [] });
      }),
      ws.on('tv_etapa', (m) => {
        const p = m.payload as { id: string; nome: string };
        setPensando((x) => (x && x.id === p.id && !x.etapas.includes(p.nome) ? { ...x, etapas: [...x.etapas, p.nome] } : x));
      }),
      ws.on('tv_resultado', (m) => {
        const r = m.payload as Resultado;
        setResultados((xs) => [r, ...xs.filter((x) => x.id !== r.id)].slice(0, 30));
        setSelecionado(null); // volta a acompanhar a mais recente
        setPensando((x) => (x?.id === r.id ? null : x));
        if (somRef.current && !r.erro) voiceRef.current.speak(markdownToSpeech(r.resposta, true));
      }),
    ];
    ws.connect().then(() => { setOnline(true); ws.send('tv_subscribe', {}); }).catch(() => setOnline(false));
    const vigia = window.setInterval(() => setOnline(ws.isConnected()), 5000);
    return () => { offs.forEach((off) => off()); window.clearInterval(vigia); };
  }, []);

  // Controles e cursor somem depois de alguns segundos sem mexer o mouse.
  useEffect(() => {
    let t = window.setTimeout(() => setControles(false), 4000);
    const mexeu = () => { setControles(true); window.clearTimeout(t); t = window.setTimeout(() => setControles(false), 4000); };
    window.addEventListener('mousemove', mexeu);
    window.addEventListener('touchstart', mexeu);
    const fs = () => setCheia(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', fs);
    return () => { window.clearTimeout(t); window.removeEventListener('mousemove', mexeu); window.removeEventListener('touchstart', mexeu); document.removeEventListener('fullscreenchange', fs); };
  }, []);

  const alternarTelaCheia = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }, []);
  const alternarSom = () => {
    const v = !som;
    setSom(v);
    try { localStorage.setItem(SOM_KEY, v ? '1' : '0'); } catch { /* sem armazenamento */ }
    if (!v) voice.stopSpeaking();
  };

  const atual = resultados.find((r) => r.id === selecionado) ?? resultados[0];
  useAutoScroll(rolagem, `${atual?.id ?? ''}|${pensando?.id ?? ''}`);

  return (
    <div className={cn('tv-root relative flex h-screen flex-col overflow-hidden text-slate-100', !controles && 'cursor-none')}>
      <div className="hud-bg" />

      {/* Topo */}
      <header className="relative z-10 flex items-center gap-5 border-b border-cyan-400/15 bg-slate-950/40 px-6 py-4 backdrop-blur-md lg:px-10">
        <img src="/brand/updown-internet-branco.png" alt="UpDown Internet" className="h-10 w-auto lg:h-12" />
        <span className="h-10 w-px bg-gradient-to-b from-transparent via-cyan-300/50 to-transparent" />
        <div className="flex items-center gap-3">
          <Tv className="h-7 w-7 text-cyan-300" />
          <div>
            <h1 className="font-display text-2xl font-bold uppercase tracking-[0.2em] text-white lg:text-3xl">NIA <span className="text-cyan-300">TV</span></h1>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-400">Respostas das perguntas por voz</p>
          </div>
        </div>
        <span className={cn('ml-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-[0.2em]', online ? 'border-rose-400/50 bg-rose-500/10 text-rose-200' : 'border-slate-600 text-slate-400')}>
          <Radio className={cn('h-3.5 w-3.5', online && 'dash-pulse')} /> {online ? 'Ao vivo' : 'Reconectando'}
        </span>
        <div className="ml-auto"><Relogio /></div>
      </header>

      {/* Controles */}
      <div className={cn('absolute right-6 top-24 z-20 flex gap-2 transition-opacity duration-500', controles ? 'opacity-100' : 'pointer-events-none opacity-0')}>
        <button type="button" onClick={alternarSom} className="icon-btn flex items-center gap-2 rounded-xl border border-slate-600/60 bg-slate-950/70 px-3 py-2 text-sm" title="Ler as respostas em voz alta nesta TV">
          {som ? <Volume2 className="h-4 w-4 text-cyan-300" /> : <VolumeX className="h-4 w-4" />} {som ? 'Som ligado' : 'Sem som'}
        </button>
        <button type="button" onClick={alternarTelaCheia} className="icon-btn flex items-center gap-2 rounded-xl border border-slate-600/60 bg-slate-950/70 px-3 py-2 text-sm" title="Tela cheia">
          {cheia ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />} {cheia ? 'Sair da tela cheia' : 'Tela cheia'}
        </button>
        <a href="/" className="icon-btn flex items-center gap-2 rounded-xl border border-slate-600/60 bg-slate-950/70 px-3 py-2 text-sm" title="Voltar ao chat da NIA">
          <ArrowLeft className="h-4 w-4" /> Chat
        </a>
      </div>

      <div className="relative z-10 flex min-h-0 flex-1">
        {/* Palco */}
        <main ref={rolagem} className="min-w-0 flex-1 overflow-y-auto px-6 py-6 lg:px-10 lg:py-8">
          {pensando ? (
            <div className="flex min-h-full flex-col items-center justify-center gap-8 text-center animate-reveal">
              <AiCore size={200} state="thinking" />
              <div className="max-w-5xl">
                <p className="mb-3 flex items-center justify-center gap-2 font-mono text-sm uppercase tracking-[0.3em] text-cyan-300/80"><Mic className="h-4 w-4" /> {pensando.usuario} perguntou por voz · {hora(pensando.quando)}</p>
                <p className="font-display text-4xl font-bold leading-tight text-white lg:text-5xl">“{pensando.pergunta}”</p>
              </div>
              <div className="flex max-w-5xl flex-wrap justify-center gap-2">
                {pensando.etapas.length === 0 && <span className="font-mono text-sm uppercase tracking-[0.25em] text-slate-400">Analisando…</span>}
                {pensando.etapas.map((e) => (
                  <span key={e} className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 font-mono text-sm uppercase tracking-wider text-cyan-100 animate-reveal">{toolLabel(e)}</span>
                ))}
              </div>
            </div>
          ) : atual ? (
            <article key={atual.id} className="mx-auto max-w-[1500px] animate-reveal">
              <header className="tv-pergunta mb-6 rounded-2xl p-6 lg:p-8">
                <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-sm uppercase tracking-[0.25em] text-cyan-300/80">
                  <span className="flex items-center gap-2"><Mic className="h-4 w-4" /> Pergunta por voz</span>
                  <span className="text-slate-400">{atual.usuario} · {hora(atual.quando)}</span>
                  <span className="flex items-center gap-1.5 text-slate-500"><Clock3 className="h-3.5 w-3.5" /> respondida em {segundos(atual.ms)}</span>
                </p>
                <h2 className="font-display text-3xl font-bold leading-tight text-white lg:text-[2.6rem]">“{atual.pergunta}”</h2>
              </header>
              <div className={cn('tv-prose message-assistant rounded-2xl px-6 py-5 lg:px-10 lg:py-8', atual.erro && 'border-rose-400/40')}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{atual.resposta}</ReactMarkdown>
              </div>
              {atual.dashboard?.kpis && <div className="mt-6"><DashboardBoard d={atual.dashboard} /></div>}
              {atual.sistemas.length > 0 && (
                <div className="mt-5 flex flex-wrap gap-2">
                  {atual.sistemas.map((s) => <span key={s} className="rounded border border-slate-700/60 px-2 py-1 font-mono text-xs uppercase tracking-wide text-slate-400">{toolLabel(s)}</span>)}
                </div>
              )}
            </article>
          ) : (
            <div className="flex min-h-full flex-col items-center justify-center gap-8 text-center">
              <AiCore size={220} state="idle" />
              <div>
                <p className="font-display text-4xl font-bold uppercase tracking-[0.15em] text-white lg:text-5xl">Aguardando perguntas por voz</p>
                <p className="mx-auto mt-4 max-w-3xl text-xl text-slate-400">Pergunte à NIA pelo microfone em qualquer computador ou celular conectado. A pergunta e a resposta aparecem aqui na hora.</p>
              </div>
            </div>
          )}
        </main>

        {/* Linha do tempo */}
        <aside className="hidden w-[380px] flex-shrink-0 flex-col border-l border-cyan-400/10 bg-slate-950/40 backdrop-blur-md xl:flex">
          <div className="flex items-center justify-between px-5 pb-3 pt-5">
            <span className="font-mono text-xs uppercase tracking-[0.25em] text-slate-400">Últimas por voz</span>
            <span className="font-mono text-[10px] text-slate-500">{resultados.length} · {telas} {telas === 1 ? 'tela' : 'telas'}</span>
          </div>
          <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-5">
            {resultados.length === 0 && <li className="px-1 text-sm text-slate-500">Nenhuma pergunta por voz ainda.</li>}
            {resultados.map((r) => {
              const ativo = r.id === atual?.id && !pensando;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelecionado(r.id)}
                    className={cn('w-full rounded-xl border px-3.5 py-3 text-left transition-all', ativo ? 'border-cyan-400/50 bg-cyan-400/10 shadow-[0_0_24px_-10px_rgba(18,186,234,0.9)]' : 'border-slate-700/50 bg-slate-900/40 hover:border-cyan-400/30')}
                  >
                    <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      <span className={cn('h-1.5 w-1.5 rounded-full', r.erro ? 'bg-rose-400' : r.dashboard ? 'bg-violet-400' : 'bg-cyan-400')} />
                      {hora(r.quando)} · {r.usuario}{r.dashboard ? ' · dashboard' : ''}
                    </div>
                    <p className="line-clamp-2 text-sm font-medium text-slate-100">{r.pergunta}</p>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </div>
  );
}
