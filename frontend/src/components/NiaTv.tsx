/**
 * NIA TV: tela de parede do NOC (abra /tv numa TV ou monitor). Mostra só as perguntas
 * feitas por voz em qualquer sessão da NIA, sempre como apresentação visual:
 *
 * - topologia da rede → mapa 3D girando, com os equipamentos em alarme destacados;
 * - equipamentos consultados → modelo 3D de cada um, em rodízio, com a ficha ao lado;
 * - dashboard (relatório, alarmes) → o painel com indicadores e gráficos, rolando sozinho;
 * - demais respostas → holograma 3D da NIA com a resposta em destaque.
 *
 * Embaixo, a legenda com o resumo da resposta (o que a NIA fala). Na lateral, as últimas
 * perguntas por voz. Controles (somem sozinhos): som, tela cheia e voltar ao chat.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Box, Clock3, LayoutDashboard, Maximize, Mic, Minimize, Network, Radio, Sparkles as Brilho, Tv, Volume2, VolumeX } from 'lucide-react';
import { ws } from '../services/websocket';
import type { Dashboard, DeviceCard, TopologyGraph } from '../types';
import { DashboardBoard, StatusPill } from './dashboard/DashboardBoard';
import { toolLabel } from './ChatInterface';
import { markdownToSpeech, resumoFalado, useVoice } from '../hooks/useVoice';
import { cn } from '../utils/helpers';
import { AiCore } from './AiCore';

const Topology3D = lazy(() => import('./Topology3D'));
const Device3D = lazy(() => import('./Device3D'));
const Holograma3D = lazy(() => import('./Holograma3D'));

interface Resultado {
  id: string; pergunta: string; resposta: string; usuario: string; quando: number; ms: number;
  modelo?: string; sistemas: string[]; dashboard?: Dashboard; topologia?: TopologyGraph; aparelhos?: DeviceCard[]; erro?: boolean;
}
interface Pensando { id: string; pergunta: string; usuario: string; quando: number; etapas: string[] }
type Modo = 'topologia' | 'aparelhos' | 'dashboard' | 'holograma';

const SOM_KEY = 'nia.tv.som';
const lerSom = () => { try { return localStorage.getItem(SOM_KEY) === '1'; } catch { return false; } };
const hora = (t: number) => new Date(t).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const segundos = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
const STATUS_TOM = { ok: 'ok', atencao: 'atencao', critico: 'critico', desconhecido: 'info' } as const;
const STATUS_TXT = { ok: 'Operacional', atencao: 'Atenção', critico: 'Crítico', desconhecido: 'Sem telemetria' } as const;

/** Qual apresentação cada resposta ganha (sempre visual). */
function modoDe(r: Resultado): Modo {
  if (r.topologia?.nodes?.length) return 'topologia';
  // Dashboard (alarmes, relatório) informa mais que os cartões dos hosts citados nele.
  if (r.dashboard?.kpis) return 'dashboard';
  if (r.aparelhos?.length) return 'aparelhos';
  return 'holograma';
}
const MODO_ROTULO: Record<Modo, { texto: string; icone: typeof Network }> = {
  topologia: { texto: 'Topologia 3D', icone: Network },
  aparelhos: { texto: 'Equipamentos em 3D', icone: Box },
  dashboard: { texto: 'Dashboard', icone: LayoutDashboard },
  holograma: { texto: 'Resposta', icone: Brilho },
};

function Relogio() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setAgora(new Date()), 1000); return () => window.clearInterval(t); }, []);
  return (
    <div className="text-right">
      <div className="font-display text-3xl font-bold tabular-nums tracking-wider text-white xl:text-4xl">{agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
      <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-cyan-300/70">{agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long' })}</div>
    </div>
  );
}

/** Rola devagar um conteúdo maior que a área: desce, espera no fim e volta ao topo. */
function useAutoScroll(ref: React.RefObject<HTMLDivElement>, chave: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = 0;
    let parado = 0, ultimo = performance.now(), frame = 0;
    let pausaAte = performance.now() + 7000;
    const passo = (t: number) => {
      const dt = t - ultimo; ultimo = t;
      if (t >= pausaAte && el.scrollHeight - el.clientHeight > 8) {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          if (!parado) parado = t;
          if (t - parado > 9000) { el.scrollTo({ top: 0, behavior: 'smooth' }); parado = 0; pausaAte = t + 8000; }
        } else el.scrollTop += (dt / 1000) * 34;
      }
      frame = requestAnimationFrame(passo);
    };
    frame = requestAnimationFrame(passo);
    const segura = () => { pausaAte = performance.now() + 20000; };
    el.addEventListener('wheel', segura, { passive: true });
    return () => { cancelAnimationFrame(frame); el.removeEventListener('wheel', segura); };
  }, [ref, chave]);
}

const Carregando = () => <div className="flex h-full items-center justify-center"><AiCore size={90} state="thinking" /></div>;

// ------------------------------------------------------------------ palcos

function PalcoTopologia({ g }: { g: TopologyGraph }) {
  const criticos = g.nodes.filter((n) => n.status === 'critico' && n.origem !== 'virtual');
  const atencao = g.nodes.filter((n) => n.status === 'atencao' && n.origem !== 'virtual');
  return (
    <div className="relative h-full overflow-hidden rounded-3xl border border-cyan-400/15 bg-slate-950/30">
      <Suspense fallback={<Carregando />}>
        <Topology3D graph={g} selected={null} onSelect={() => {}} showInferred showLabels onlyAlarms={false} />
      </Suspense>
      <div className="pointer-events-none absolute left-5 top-5 flex flex-wrap gap-2">
        {[
          [`${g.resumo.equipamentos}`, 'equipamentos'],
          [`${g.resumo.enlaces}`, 'enlaces'],
          [`${g.resumo.comAlarme}`, 'com alarme'],
          [`${g.resumo.alarmesClientes}`, 'alarmes de clientes'],
        ].map(([v, r]) => (
          <span key={r} className="dash-card flex items-baseline gap-2 px-4 py-2">
            <b className="dash-valor font-display text-2xl">{v}</b>
            <span className="font-mono text-[11px] uppercase tracking-widest text-slate-400">{r}</span>
          </span>
        ))}
      </div>
      {(criticos.length > 0 || atencao.length > 0) && (
        <div className="dash-card pointer-events-none absolute bottom-5 left-5 max-w-md p-4">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-rose-200">Em alarme</p>
          <ul className="space-y-1.5">
            {[...criticos, ...atencao].slice(0, 7).map((n) => (
              <li key={n.id} className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: n.status === 'critico' ? '#ff2d6f' : '#ffc53d', boxShadow: `0 0 10px ${n.status === 'critico' ? '#ff2d6f' : '#ffc53d'}` }} />
                <span className="truncate text-slate-100">{n.nome}</span>
                {n.alertas?.[0] && <span className="truncate text-xs text-slate-400">· {n.alertas[0]}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="pointer-events-none absolute bottom-5 right-6 font-mono text-[10px] uppercase tracking-widest text-slate-500">{g.fonte}</p>
    </div>
  );
}

function PalcoAparelhos({ lista }: { lista: DeviceCard[] }) {
  const [i, setI] = useState(0);
  useEffect(() => { setI(0); }, [lista]);
  useEffect(() => {
    if (lista.length < 2) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % lista.length), 14000);
    return () => window.clearInterval(t);
  }, [lista]);
  const d = lista[i] ?? lista[0];
  if (!d) return null;
  const portas = d.portas ?? [];
  const ativas = portas.filter((p) => /up|conect|ativ/i.test(String(p.status))).length;
  return (
    <div className="grid h-full gap-5 lg:grid-cols-[1.4fr_1fr]">
      <div className="relative overflow-hidden rounded-3xl border border-cyan-400/15 bg-slate-950/30">
        <Suspense fallback={<Carregando />}><Device3D key={d.id} device={d} /></Suspense>
        {lista.length > 1 && (
          <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-2">
            {lista.map((x, k) => <span key={x.id} className={cn('h-1.5 rounded-full transition-all', k === i ? 'w-8 bg-cyan-300' : 'w-3 bg-slate-600')} />)}
          </div>
        )}
      </div>
      <div className="dash-card flex min-h-0 flex-col gap-4 overflow-hidden p-6 animate-reveal" key={d.id}>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-cyan-300/80">{d.tipo}{d.local ? ` · ${d.local}` : ''}</p>
          <h3 className="mt-1 font-display text-3xl font-bold leading-tight text-white">{d.nome}</h3>
          {(d.fabricante || d.modelo) && <p className="mt-1 text-lg text-slate-300">{[d.fabricante, d.modelo].filter(Boolean).join(' · ')}</p>}
        </div>
        <StatusPill tom={STATUS_TOM[d.status]} texto={STATUS_TXT[d.status]} />
        {portas.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-700/50 bg-slate-950/40 p-3"><p className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Portas</p><p className="dash-valor font-display text-3xl font-bold">{portas.length}</p></div>
            <div className="rounded-xl border border-slate-700/50 bg-slate-950/40 p-3"><p className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Em uso</p><p className="dash-valor font-display text-3xl font-bold">{ativas}</p></div>
          </div>
        )}
        {d.metricas && d.metricas.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {d.metricas.slice(0, 8).map((m) => (
              <div key={m.nome} className="min-w-0"><dt className="truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">{m.nome}</dt><dd className="truncate text-base text-slate-100">{m.valor}</dd></div>
            ))}
          </dl>
        )}
        {d.alertas && d.alertas.length > 0 && (
          <div className="min-h-0 overflow-hidden">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-amber-200">Alertas</p>
            <ul className="space-y-1.5 text-sm text-slate-200">{d.alertas.slice(0, 5).map((a, k) => <li key={k} className="line-clamp-2 border-l-2 border-amber-400/60 pl-2">{a}</li>)}</ul>
          </div>
        )}
        {lista.length > 1 && <p className="mt-auto font-mono text-[10px] uppercase tracking-widest text-slate-500">{i + 1} de {lista.length} · troca a cada 14 s</p>}
      </div>
    </div>
  );
}

function PalcoHolograma({ r, pensando }: { r?: Resultado; pensando?: Pensando | null }) {
  return (
    <div className="relative h-full overflow-hidden rounded-3xl border border-cyan-400/15 bg-slate-950/20">
      <div className="absolute inset-0 opacity-90"><Suspense fallback={null}><Holograma3D pensando={Boolean(pensando)} /></Suspense></div>
      <div className="relative z-10 flex h-full items-center justify-center p-8 lg:p-12">
        {pensando ? (
          <div className="max-w-5xl text-center animate-reveal">
            <p className="mb-4 font-mono text-sm uppercase tracking-[0.35em] text-cyan-200">Processando</p>
            <div className="flex flex-wrap justify-center gap-2">
              {pensando.etapas.length === 0 && <span className="font-mono text-base uppercase tracking-[0.25em] text-slate-300">Analisando a pergunta…</span>}
              {pensando.etapas.map((e) => <span key={e} className="rounded-lg border border-cyan-400/40 bg-slate-950/70 px-4 py-2 font-mono text-base uppercase tracking-wider text-cyan-100 animate-reveal">{toolLabel(e)}</span>)}
            </div>
          </div>
        ) : r ? (
          <div className="tv-slide max-h-full w-full max-w-5xl overflow-hidden rounded-3xl p-8 lg:p-10 animate-reveal">
            <div className="tv-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{r.resposta}</ReactMarkdown></div>
          </div>
        ) : (
          <div className="text-center">
            <p className="font-display text-4xl font-bold uppercase tracking-[0.15em] text-white xl:text-5xl">Aguardando perguntas por voz</p>
            <p className="mx-auto mt-4 max-w-3xl text-xl text-slate-300">Pergunte à NIA pelo microfone em qualquer computador ou celular. A resposta aparece aqui em 3D ou em dashboard.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tela

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
  const somRef = useRef(som); somRef.current = som;
  const voiceRef = useRef(voice); voiceRef.current = voice;
  const rolagem = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/noc/status', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).then((s) => setServerSpeech(Boolean(s?.voice?.serverSpeech))).catch(() => {});
  }, []);

  // Inscreve como TV a cada (re)conexão (o servidor manda "welcome" ao conectar).
  useEffect(() => {
    const offs = [
      ws.on('welcome', () => { setOnline(true); ws.send('tv_subscribe', {}); }),
      ws.on('tv_historico', (m) => { const p = m.payload as { resultados: Resultado[]; telas: number }; setResultados(p.resultados ?? []); setTelas(p.telas ?? 1); }),
      ws.on('tv_pensando', (m) => { const p = m.payload as Omit<Pensando, 'etapas'>; setPensando({ ...p, etapas: [] }); }),
      ws.on('tv_etapa', (m) => {
        const p = m.payload as { id: string; nome: string };
        setPensando((x) => (x && x.id === p.id && !x.etapas.includes(p.nome) ? { ...x, etapas: [...x.etapas, p.nome] } : x));
      }),
      ws.on('tv_resultado', (m) => {
        const r = m.payload as Resultado;
        setResultados((xs) => [r, ...xs.filter((x) => x.id !== r.id)].slice(0, 30));
        setSelecionado(null);
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
  const modo: Modo = pensando || !atual ? 'holograma' : modoDe(atual);
  const legenda = useMemo(() => (atual && !pensando && modo !== 'holograma' ? resumoFalado(atual.resposta).replace(/[*_`#>]/g, '') : ''), [atual, pensando, modo]);
  useAutoScroll(rolagem, `${atual?.id ?? ''}|${modo}`);
  const M = MODO_ROTULO[modo];
  const btn = 'flex items-center gap-2 rounded-xl border border-slate-600/60 bg-slate-950/70 px-3 py-2 text-sm text-slate-200 transition-colors hover:border-cyan-400/50 hover:text-white';

  return (
    <div className={cn('tv-root relative flex h-screen flex-col overflow-hidden text-slate-100', !controles && 'cursor-none')}>
      <div className="hud-bg" />

      {/* Topo */}
      <header className="relative z-20 flex items-center gap-5 border-b border-cyan-400/15 bg-slate-950/50 px-6 py-3 backdrop-blur-md xl:px-8">
        <img src="/brand/updown-internet-branco.png" alt="UpDown Internet" className="h-10 w-auto xl:h-11" />
        <span className="h-10 w-px bg-gradient-to-b from-transparent via-cyan-300/50 to-transparent" />
        <div className="flex items-center gap-3">
          <Tv className="h-7 w-7 text-cyan-300" />
          <div>
            <h1 className="font-display text-2xl font-bold uppercase tracking-[0.2em] text-white xl:text-3xl">NIA <span className="text-cyan-300">TV</span></h1>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-400">Perguntas por voz · ao vivo</p>
          </div>
        </div>
        <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-[0.2em]', online ? 'border-rose-400/50 bg-rose-500/10 text-rose-200' : 'border-slate-600 text-slate-400')}>
          <Radio className={cn('h-3.5 w-3.5', online && 'dash-pulse')} /> {online ? 'Ao vivo' : 'Reconectando'}
        </span>
        <div className={cn('ml-auto flex gap-2 transition-opacity duration-500', controles ? 'opacity-100' : 'pointer-events-none opacity-0')}>
          <button type="button" onClick={alternarSom} className={btn} title="Ler as respostas em voz alta nesta TV">
            {som ? <Volume2 className="h-4 w-4 text-cyan-300" /> : <VolumeX className="h-4 w-4" />} {som ? 'Som ligado' : 'Sem som'}
          </button>
          <button type="button" onClick={alternarTelaCheia} className={btn} title="Tela cheia">
            {cheia ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />} {cheia ? 'Sair' : 'Tela cheia'}
          </button>
          <a href="/" className={btn} title="Voltar ao chat da NIA"><ArrowLeft className="h-4 w-4" /> Chat</a>
        </div>
        <div className={cn(!controles && 'ml-auto')}><Relogio /></div>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 gap-5 p-5 xl:p-6">
        <section className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Pergunta */}
          {(pensando || atual) && (
            <div className="tv-pergunta flex items-center gap-4 rounded-2xl px-5 py-4 animate-reveal" key={pensando?.id ?? atual?.id}>
              <span className={cn('grid h-12 w-12 flex-shrink-0 place-items-center rounded-full border', pensando ? 'border-cyan-300/60 bg-cyan-400/15 text-cyan-100 animate-glow' : 'border-violet-300/50 bg-violet-500/15 text-violet-100')}>
                <Mic className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] uppercase tracking-[0.22em] text-cyan-200/80">
                  <span>{(pensando ?? atual)!.usuario} perguntou por voz · {hora((pensando ?? atual)!.quando)}</span>
                  {!pensando && atual && <span className="flex items-center gap-1 text-slate-400"><Clock3 className="h-3 w-3" /> {segundos(atual.ms)}</span>}
                </p>
                <h2 className="truncate font-display text-2xl font-bold text-white xl:text-[2rem]" title={(pensando ?? atual)!.pergunta}>“{(pensando ?? atual)!.pergunta}”</h2>
              </div>
              <span className="hidden flex-shrink-0 items-center gap-2 rounded-xl border border-cyan-400/30 bg-slate-950/50 px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-cyan-100 lg:flex">
                <M.icone className="h-4 w-4" /> {pensando ? 'Processando' : M.texto}
              </span>
            </div>
          )}

          {/* Palco: sempre visual */}
          <div className="min-h-0 flex-1">
            {modo === 'topologia' && atual?.topologia && <PalcoTopologia g={atual.topologia} />}
            {modo === 'aparelhos' && atual?.aparelhos && <PalcoAparelhos lista={atual.aparelhos} />}
            {modo === 'dashboard' && atual?.dashboard && (
              <div ref={rolagem} className="h-full overflow-y-auto rounded-3xl"><DashboardBoard d={atual.dashboard} /></div>
            )}
            {modo === 'holograma' && <PalcoHolograma r={pensando ? undefined : atual} pensando={pensando} />}
          </div>

          {/* Legenda: o resumo falado da resposta */}
          {legenda && (
            <div className="tv-legenda flex items-start gap-4 rounded-2xl px-6 py-4 animate-reveal" key={`leg-${atual?.id}`}>
              <AiCore size={40} state="speaking" className="mt-1" />
              <p className="line-clamp-3 text-xl leading-snug text-white xl:text-2xl">{legenda}</p>
            </div>
          )}
        </section>

        {/* Linha do tempo */}
        <aside className="hidden w-[340px] flex-shrink-0 flex-col overflow-hidden rounded-3xl border border-cyan-400/10 bg-slate-950/45 backdrop-blur-md xl:flex">
          <div className="flex items-center justify-between border-b border-cyan-400/10 px-5 py-4">
            <span className="font-mono text-xs uppercase tracking-[0.25em] text-slate-300">Últimas por voz</span>
            <span className="font-mono text-[10px] text-slate-500">{telas} {telas === 1 ? 'tela' : 'telas'}</span>
          </div>
          <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {resultados.length === 0 && <li className="px-2 py-1 text-sm text-slate-500">Nenhuma pergunta por voz ainda.</li>}
            {resultados.map((r) => {
              const ativo = r.id === atual?.id && !pensando;
              const I = MODO_ROTULO[modoDe(r)].icone;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelecionado(r.id)}
                    className={cn('w-full rounded-xl border px-3.5 py-3 text-left transition-all', ativo ? 'border-cyan-400/50 bg-cyan-400/10 shadow-[0_0_24px_-10px_rgba(18,186,234,0.9)]' : 'border-slate-700/50 bg-slate-900/40 hover:border-cyan-400/30')}
                  >
                    <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      <I className={cn('h-3.5 w-3.5', r.erro ? 'text-rose-300' : 'text-cyan-300')} />
                      <span>{hora(r.quando)}</span><span>·</span><span className="truncate">{r.usuario}</span>
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
