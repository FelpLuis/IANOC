import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Box, Menu, X } from 'lucide-react';
import { ChatInterface } from './components/ChatInterface';
import { HudSidebar } from './components/HudSidebar';
import { DevicePanel } from './components/DevicePanel';
import { TopologyView } from './components/TopologyView';
import { KnowledgePanel } from './components/KnowledgePanel';
import { AiCore } from './components/AiCore';
import { useAgent } from './hooks/useAgent';
import type { AuthUser } from './components/AuthGate';
import type { DeviceCard, TopologyGraph } from './types';
import { cn } from './utils/helpers';

/** true quando a tela casa com a media query (ex.: desktop largo). */
function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Relógio de São Paulo no topo (HH:MM:SS). */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const date = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: 'short' });
  return (
    <div className="hidden text-right sm:block">
      <div className="font-mono text-sm tabular-nums text-cyan-100">{time}</div>
      <div className="hud-label">{date}</div>
    </div>
  );
}

export default function App({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Aparelhos em foco no painel 3D: os da última resposta, ou o que o operador escolher.
  const [view, setView] = useState<{ devices: DeviceCard[]; index: number } | null>(null);
  const lastAutoOpened = useRef<string | null>(null);
  // Topologia 3D em tela cheia (resposta que trouxe a topologia, ou reaberta pelo botão).
  const [topology, setTopology] = useState<TopologyGraph | null>(null);
  const [baseAberta, setBaseAberta] = useState(false);
  const lastTopologyOpened = useRef<string | null>(null);

  const { messages, isLoading, isChatting, toolActivity, isConnected, error, sendMessage, clearError } = useAgent();
  const busy = isLoading || isChatting;
  // Um só painel 3D montado por vez (cada um abre um contexto WebGL).
  const wide = useMedia('(min-width: 1280px)');

  // Todos os aparelhos já consultados nesta conversa (o mais recente primeiro).
  const seenDevices = useMemo(() => {
    const map = new Map<string, DeviceCard>();
    for (const m of [...messages].reverse()) for (const d of m.devices ?? []) if (!map.has(d.id)) map.set(d.id, d);
    return [...map.values()].slice(0, 12);
  }, [messages]);

  // Resposta nova com topologia abre a tela 3D sozinha.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.topology || lastTopologyOpened.current === last.id) return;
    lastTopologyOpened.current = last.id;
    setTopology(last.topology);
  }, [messages]);

  useEffect(() => {
    if (!topology) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTopology(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [topology]);

  // Resposta nova com aparelhos abre o painel 3D sozinha.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.devices?.length || lastAutoOpened.current === last.id) return;
    lastAutoOpened.current = last.id;
    setView({ devices: last.devices, index: 0 });
  }, [messages]);

  const quickAction = (prompt: string) => {
    setSidebarOpen(false);
    sendMessage(prompt);
  };

  if (!isConnected && !isLoading) {
    return (
      <div className="relative flex min-h-[100dvh] items-center justify-center">
        <div className="hud-bg" />
        <div className="text-center animate-reveal">
          <AiCore size={96} state="thinking" className="mx-auto mb-6" />
          <h1 className="mb-2 text-2xl font-bold tracking-[0.3em] neon-text" style={{ fontFamily: 'Orbitron, Inter, sans-serif' }}>NIA</h1>
          <p className="hud-label">Conectando ao servidor…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-[100dvh] overflow-hidden">
      <div className="hud-bg" />

      {/* Painel lateral: fixo no desktop, gaveta no celular */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-[18rem] transform transition-transform duration-300 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <HudSidebar
          user={user}
          onLogout={onLogout}
          onAction={quickAction}
          devices={seenDevices}
          onOpenDevice={(i) => { setView({ devices: seenDevices, index: i }); setSidebarOpen(false); }}
          onClose={() => setSidebarOpen(false)}
          onOpenBase={() => { setBaseAberta(true); setSidebarOpen(false); }}
          busy={busy}
        />
      </aside>
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-slate-950/70 backdrop-blur-sm lg:hidden animate-fade-in" onClick={() => setSidebarOpen(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior */}
        <header className="flex items-center justify-between gap-3 border-b border-sky-400/10 bg-slate-950/40 px-3 py-2.5 backdrop-blur-xl sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={() => setSidebarOpen(true)} className="icon-btn lg:hidden" title="Menu">
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2.5 lg:hidden">
              <AiCore size={28} state={busy ? 'thinking' : 'idle'} />
              <span className="font-bold tracking-[0.2em] neon-text" style={{ fontFamily: 'Orbitron, Inter, sans-serif' }}>NIA</span>
            </div>
            <div className="hidden items-center gap-2 lg:flex">
              <span className="hud-label">Sessão</span>
              <span className="text-sm text-slate-300">NIA · assistente virtual do NOC</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {seenDevices.length > 0 && (
              <button
                type="button"
                onClick={() => setView(view ? null : { devices: seenDevices, index: 0 })}
                className={view ? 'icon-btn-active' : 'icon-btn'}
                title="Aparelhos em 3D"
              >
                <Box className="h-5 w-5" />
              </button>
            )}
            <div className="flex items-center gap-2 rounded-full border border-slate-700/60 bg-slate-900/50 px-2.5 py-1">
              <span className={cn('h-1.5 w-1.5 rounded-full', isConnected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]' : 'bg-red-400')} />
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-300">{isConnected ? 'online' : 'offline'}</span>
            </div>
            <Clock />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <ChatInterface
            messages={messages}
            isLoading={busy}
            toolActivity={toolActivity}
            currentProject={null}
            projectFiles={[]}
            onSendMessage={sendMessage}
            suggestions={[]}
            onOpenDevices={(devices, index) => setView({ devices, index })}
            onOpenTopology={setTopology}
          />

          {/* Aparelho em 3D: coluna à direita no desktop largo, folha de baixo no celular */}
          {view && wide && (
              <div className="w-[400px] flex-shrink-0 p-3 pl-0">
                <DevicePanel devices={view.devices} index={view.index} onIndex={(i) => setView({ ...view, index: i })} onClose={() => setView(null)} />
              </div>
          )}
          {view && !wide && (
              <div className="fixed inset-0 z-40 flex flex-col justify-end bg-slate-950/60 backdrop-blur-sm animate-fade-in" onClick={() => setView(null)}>
                <div className="h-[86dvh] p-2 sm:mx-auto sm:w-[560px]" onClick={(e) => e.stopPropagation()}>
                  <DevicePanel devices={view.devices} index={view.index} onIndex={(i) => setView({ ...view, index: i })} onClose={() => setView(null)} />
                </div>
              </div>
          )}
        </div>
      </main>

      {topology && <TopologyView graph={topology} onClose={() => setTopology(null)} />}
      {baseAberta && <KnowledgePanel onClose={() => setBaseAberta(false)} />}

      {error && (
        <div className="fixed bottom-24 right-4 z-50 animate-slide-up">
          <div className="glass flex min-w-[280px] max-w-[90vw] items-center gap-3 rounded-xl border-red-400/30 px-4 py-3">
            <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
            <span className="flex-1 text-sm text-red-100">{error}</span>
            <button type="button" onClick={clearError} className="p-1 text-red-300 hover:text-red-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
