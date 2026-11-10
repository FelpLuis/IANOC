import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Mic,
  Square,
  Volume2,
  VolumeX,
  Download,
  Printer,
  FileBarChart,
  AudioLines,
  Box,
  ShieldAlert,
  Signal,
  Headset,
  Network,
  ExternalLink,
} from 'lucide-react';
import { cn, formatRelativeTime } from '../utils/helpers';
import { earcon, markdownToSpeech, resumoFalado, useVoice, type ListenEnd } from '../hooks/useVoice';
import { abrirDocumento, downloadMarkdown } from '../utils/report';
import { DashboardCard } from './dashboard/DashboardCard';
import { VoiceStatus } from './VoiceStatus';
import { VoiceOverlay } from './VoiceOverlay';
import { ActionCard } from './ActionCard';
import { ThinkingPanel } from './ThinkingPanel';
import { AiCore, type CoreState } from './AiCore';
import { KIND_ICON, STATUS_STYLE } from './DevicePanel';
import type { Message, FileInfo, ToolActivity, DeviceCard, TopologyGraph } from '../types';

// Relatórios prontos: o assistente coleta das fontes e monta no formato do prompt (backend/src/noc/prompt.ts).
const REPORTS: Array<{ label: string; prompt: string }> = [
  { label: 'Dashboard de hoje', prompt: 'Abra o dashboard do NOC de hoje' },
  { label: 'Dashboard da semana', prompt: 'Abra o dashboard do NOC da semana' },
  { label: 'Relatório do NOC de hoje', prompt: 'Gere o relatório operacional do NOC de hoje (00:00 até agora): incidentes no Zabbix, alarmes ainda abertos, ordens de serviço do IXC e atendimentos do Opa! Suite.' },
  { label: 'Relatório de ontem', prompt: 'Gere o relatório operacional do NOC de ontem (dia inteiro): incidentes no Zabbix, ordens de serviço do IXC e atendimentos do Opa! Suite, com pontos de atenção.' },
  { label: 'Incidentes da semana', prompt: 'Gere o relatório de incidentes de rede dos últimos 7 dias pelo Zabbix: hosts que mais caíram, tempo total em problema, problemas recorrentes e recomendações.' },
  { label: 'O.S. da semana (IXC)', prompt: 'Gere o relatório das ordens de serviço abertas no IXC nos últimos 7 dias: por status, assunto, setor e técnico, tempo de resolução e O.S. paradas.' },
  { label: 'Atendimentos de hoje (Opa!)', prompt: 'Gere o relatório dos atendimentos do Opa! Suite de hoje: total, por status, setor e atendente, e tempo médio de atendimento.' },
  { label: 'Relatório mensal', prompt: 'Gere o relatório mensal do NOC deste mês (do dia 1 até agora): disponibilidade e incidentes do Zabbix, O.S. do IXC e atendimentos do Opa! Suite, com tendências e recomendações.' },
];

// Perguntas de partida na tela inicial.
const STARTERS: Array<{ title: string; prompt: string; icon: typeof ShieldAlert }> = [
  { title: 'Alarmes agora', prompt: 'O que está com alarme alto ou desastre agora?', icon: ShieldAlert },
  { title: 'Topologia 3D', prompt: 'Gere a topologia 3D da minha rede backbone', icon: Network },
  { title: 'Sinal das ONUs', prompt: 'Liste as ONUs com sinal abaixo de -27 dBm', icon: Signal },
  { title: 'Fila do atendimento', prompt: 'Como está a fila de atendimentos no Opa agora?', icon: Headset },
];

const AUTO_SPEAK_KEY = 'ianoc.autoSpeak';
const readAutoSpeak = () => { try { return localStorage.getItem(AUTO_SPEAK_KEY) === '1'; } catch { return false; } };
const VOICE_FX_KEY = 'ianoc.voiceFx';
const readVoiceFx = () => { try { return localStorage.getItem(VOICE_FX_KEY) === '1'; } catch { return false; } };

// Frase curta enquanto a consulta roda, no modo voz (uma por sistema em cada pergunta).
const TOOL_SPEECH: Array<[RegExp, string]> = [
  [/^relatorio_noc$/, 'Montando o relatório.'],
  [/^zabbix/, 'Consultando o Zabbix.'],
  [/^ixc/, 'Verificando no IXC.'],
  [/^opa/, 'Olhando os atendimentos no Opa.'],
  [/^genieacs|^acs/, 'Consultando o ACS.'],
  [/topologia|backbone|caminho|rota/, 'Analisando a topologia.'],
];
const toolSpeech = (name: string) => TOOL_SPEECH.find(([re]) => re.test(name))?.[1] ?? 'Um instante.';
// Frases que encerram o modo conversa.
const END_CONVERSATION = /^(encerrar|encerra|parar|pare|pode parar|tchau|até mais|ate mais|desligar|sair|obrigad[oa],? (é|e|era) só isso|só isso|chega)\b/i;

// Nome legível de cada ferramenta do assistente NOC (backend/src/noc/tools.ts).
const TOOL_LABELS: Record<string, string> = {
  backbone_equipamento: 'Topologia · equipamento',
  backbone_caminho: 'Topologia · caminho',
  ftth_buscar: 'Mapa de fibra · busca',
  ftth_proximos: 'Mapa de fibra · proximidade',
  noc_visao_geral: 'NOC · visão geral',
  noc_interfaces: 'NOC · interfaces (Zabbix)',
  noc_enlaces: 'NOC · enlaces',
  noc_trafego: 'NOC · tráfego',
  noc_gpon_clientes: 'OLT · ONUs',
  noc_gpon_historico: 'OLT · histórico',
  noc_radius_logs: 'RADIUS',
  noc_clientes: 'NOC · clientes',
  noc_tickets: 'NOC · tickets',
  zabbix_problemas: 'Zabbix · alarmes',
  zabbix_consulta: 'Zabbix · consulta',
  zabbix_relatorio_eventos: 'Zabbix · eventos do período',
  relatorio_noc: 'Relatório (Zabbix + IXC + Opa!)',
  equipe_documentos: 'Documentos da equipe',
  ixc_relatorio_os: 'IXC · O.S. do período',
  opa_atendimentos: 'Opa! · atendimentos',
  opa_relatorio_atendimentos: 'Opa! · relatório',
  opa_consulta: 'Opa! · consulta',
  acs_buscar_cpe: 'GenieACS · CPE',
  acs_falhas: 'GenieACS · falhas',
  acs_tarefas_pendentes: 'GenieACS · tarefas',
  ixc_consultar: 'IXC',
  backbone_topologia: 'Topologia 3D (NOC + Zabbix)',
  topologia_conexoes: 'Topologia · conexões',
  ixc_logins_online: 'IXC · logins PPPoE online',
  web_pesquisa: 'Web · busca e leitura das fontes',
  base_conhecimento: 'Base de conhecimento',
  resposta_geral: 'IA · escrevendo a resposta',
  resposta_tecnica: 'IA · especialista em engenharia',
};
export const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

const greeting = () => {
  const h = Number(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
};

interface ChatInterfaceProps {
  messages: Message[];
  isLoading: boolean;
  currentProject?: { id: string; name: string } | null;
  projectFiles: FileInfo[];
  onSendMessage: (content: string, options?: { contextFiles?: string[]; voice?: boolean }) => void;
  suggestions?: string[];
  toolActivity?: ToolActivity[];
  onOpenDevices?: (devices: DeviceCard[], index: number) => void;
  onOpenTopology?: (graph: TopologyGraph) => void;
}

export function ChatInterface({
  messages,
  isLoading,
  toolActivity = [],
  onSendMessage,
  onOpenDevices,
  onOpenTopology,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const [showReports, setShowReports] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(readAutoSpeak);
  const [serverTranscription, setServerTranscription] = useState(false);
  const [serverSpeech, setServerSpeech] = useState(false);
  const [aiEffect, setAiEffect] = useState(readVoiceFx);
  // Modo conversa: depois de responder, volta a ouvir sozinho, sem clicar.
  const [conversation, setConversation] = useState(false);
  const conversationRef = useRef(false);
  const emptyListens = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  // Resposta à pergunta feita por voz é lida em voz alta mesmo com a leitura automática desligada.
  const awaitingVoiceReply = useRef(false);
  const lastSpokenId = useRef<string | null>(null);
  const spokenTools = useRef(new Set<string>());

  const voice = useVoice({ serverTranscription, serverSpeech, aiEffect });

  useEffect(() => {
    fetch('/api/noc/status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        setServerTranscription(Boolean(s?.voice?.serverTranscription));
        setServerSpeech(Boolean(s?.voice?.serverSpeech));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Sem mensagens, a tela inicial fica no topo (no celular ela é mais alta que a tela).
    if (messages.length === 0 && !isLoading) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, toolActivity.length]);

  // Lê a resposta nova em voz alta: o resumo inicial se a pergunta foi falada, ou tudo (sem tabelas) com a leitura automática.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || last.id === lastSpokenId.current) return;
    lastSpokenId.current = last.id;
    const byVoice = awaitingVoiceReply.current;
    awaitingVoiceReply.current = false;
    if (!(byVoice || autoSpeak)) return;
    // Entra na fila depois da frase de espera ("Consultando o Zabbix."), sem cortá-la.
    // Fala só o recado direto; o conteúdo completo está na tela.
    voice.speak(resumoFalado(last.content), { append: true }).then((finished) => {
      if (finished && conversationRef.current) listen();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // No modo voz, avisa o que está consultando enquanto a resposta não chega.
  useEffect(() => {
    if (!awaitingVoiceReply.current) return;
    for (const t of toolActivity) {
      const phrase = toolSpeech(t.name);
      if (t.done || spokenTools.current.has(phrase)) continue;
      spokenTools.current.add(phrase);
      voice.speak(phrase, { append: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolActivity]);

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    try { localStorage.setItem(AUTO_SPEAK_KEY, next ? '1' : '0'); } catch { /* sem armazenamento: vale só nesta aba */ }
    if (!next) voice.stopSpeaking();
  };

  const toggleAiEffect = () => {
    const next = !aiEffect;
    setAiEffect(next);
    try { localStorage.setItem(VOICE_FX_KEY, next ? '1' : '0'); } catch { /* vale só nesta aba */ }
  };

  const setConversationMode = (on: boolean) => {
    conversationRef.current = on;
    setConversation(on);
    emptyListens.current = 0;
  };

  const sendVoice = (text: string) => {
    awaitingVoiceReply.current = true;
    spokenTools.current.clear();
    onSendMessage(text, { voice: true });
  };

  // Uma rodada de escuta. No modo conversa, encadeia a próxima sozinha.
  const onHeard: ListenEnd = (text, reason) => {
    if (!conversationRef.current) {
      if (text) sendVoice(text);
      return;
    }
    if (reason === 'error') { setConversationMode(false); earcon('error'); return; }
    if (!text) {
      // Duas escutas seguidas sem fala encerram o modo conversa.
      if (++emptyListens.current >= 2) {
        setConversationMode(false);
        earcon('end');
        return;
      }
      listen();
      return;
    }
    emptyListens.current = 0;
    if (END_CONVERSATION.test(text.trim())) {
      setConversationMode(false);
      voice.speak('Certo. Encerrando o modo conversa.').then(() => earcon('end'));
      return;
    }
    sendVoice(text);
  };

  function listen() {
    window.setTimeout(() => {
      if (conversationRef.current) voice.startListening(onHeard);
    }, 180);
  }

  const handleMic = () => {
    if (voice.listening) { voice.stopListening(); return; }
    voice.startListening(onHeard);
  };

  const toggleConversation = () => {
    if (conversation) {
      setConversationMode(false);
      voice.abortListening();
      voice.stopSpeaking();
      earcon('end');
      return;
    }
    setConversationMode(true);
    if (!isLoading) voice.startListening(onHeard);
  };

  // Interromper a fala: toca de novo no microfone/orbe ou tecla Esc; no modo conversa já volta a ouvir.
  const interrupt = useCallback(() => {
    voice.stopSpeaking();
    if (conversationRef.current && !isLoading) voice.startListening(onHeard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, voice.stopSpeaking, voice.startListening]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (voice.speaking) interrupt();
      else if (conversationRef.current) toggleConversation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const send = (text: string) => {
    if (!text.trim() || isLoading) return;
    setShowReports(false);
    onSendMessage(text.trim());
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    send(input);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
  };

  const copyToClipboard = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch { /* sem permissão de área de transferência */ }
  };

  // Estado do núcleo da IA (avatar, tela inicial, modo conversa).
  const coreState: CoreState = voice.listening ? 'listening' : voice.speaking ? 'speaking' : isLoading || voice.transcribing ? 'thinking' : 'idle';

  const lastQuestion = useMemo(() => [...messages].reverse().find((m) => m.role === 'user')?.content, [messages]);
  const lastAnswer = useMemo(() => {
    const m = [...messages].reverse().find((x) => x.role === 'assistant');
    return m ? resumoFalado(m.content) : undefined;
  }, [messages]);

  const renderMessageContent = (content: string, animate: boolean) => (
    <div className={cn('prose max-w-none text-[0.94rem]', animate && 'reveal-stagger')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-slate-700/60 scrollbar-thin">
              <table className="!my-0 min-w-full">{children}</table>
            </div>
          ),
          code: ({ children, ...props }) => {
            const code = String(children);
            if (!code.includes('\n')) return <code>{code}</code>;
            const language = (props.className || '').replace('language-', '') || 'texto';
            const id = `code-${code.length}-${code.slice(0, 12)}`;
            const isExpanded = expandedCode === id;
            return (
              <div className="relative my-3 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/80">
                <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
                  <span className="hud-label">{language}</span>
                  <button type="button" onClick={() => setExpandedCode(isExpanded ? null : id)} className="text-slate-400 hover:text-cyan-200">
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
                <pre className={cn('!my-0 !border-0 overflow-x-auto p-4', isExpanded ? 'max-h-96' : 'max-h-40')}>
                  <code className={cn('font-mono text-sm', props.className)}>{code}</code>
                </pre>
              </div>
            );
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Mensagens */}
      <div className="flex-1 overflow-y-auto px-3 py-5 scrollbar-thin sm:px-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {messages.length === 0 && (
            <div className="flex min-h-[60vh] flex-col items-center justify-center pt-2 text-center animate-reveal">
              <div className="relative mb-6">
                <span className="absolute inset-0 rounded-full bg-cyan-400/20 blur-3xl" />
                <AiCore size={window.innerWidth < 640 ? 92 : 124} state={coreState} />
              </div>
              <div className="hud-label mb-2">NIA · assistente virtual do NOC</div>
              <h1 className="text-2xl font-semibold text-slate-50 sm:text-3xl">
                {greeting()}, Chefe. <span className="neon-text">Sistemas online.</span>
              </h1>
              <p className="mt-2 max-w-lg text-sm text-slate-400">
                Sou a NIA. Zabbix, IXC, Opa! Suite, OLTs e backbone sob vigilância. Pergunte por texto, pelo microfone, ou ligue o modo conversa e me chame pelo nome.
              </p>

              <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
                {STARTERS.map((s, i) => (
                  <button
                    key={s.title}
                    type="button"
                    disabled={isLoading}
                    onClick={() => send(s.prompt)}
                    className="glass glass-hover group flex items-start gap-3 rounded-xl p-4 text-left animate-slide-up disabled:opacity-50"
                    style={{ animationDelay: `${120 + i * 70}ms`, animationFillMode: 'both' }}
                  >
                    <span className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 p-2 text-cyan-200 transition-transform group-hover:scale-110">
                      <s.icon className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-slate-100">{s.title}</span>
                      <span className="block text-xs text-slate-400">{s.prompt}</span>
                    </span>
                  </button>
                ))}
              </div>

              <div className="hud-label mb-2 mt-8">Relatórios</div>
              <div className="flex max-w-2xl flex-wrap justify-center gap-2">
                {REPORTS.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    disabled={isLoading}
                    onClick={() => send(r.prompt)}
                    className="flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-3 py-1.5 text-xs text-cyan-100 transition-all hover:border-cyan-400/50 hover:bg-cyan-400/10 disabled:opacity-50"
                  >
                    <FileBarChart className="h-3.5 w-3.5" />
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => {
            const isUser = message.role === 'user';
            const isNewest = message.id === lastAssistantId;
            return (
              <div key={message.id} className={cn('group flex gap-3', isUser ? 'flex-row-reverse animate-slide-up' : 'animate-reveal')}>
                {!isUser && <AiCore size={30} state={isNewest ? (coreState === 'speaking' ? 'speaking' : 'idle') : 'idle'} className="mt-1 hidden sm:block" />}

                <div className={cn('min-w-0', isUser ? 'max-w-[85%] text-right' : 'w-full max-w-[92%] sm:max-w-[85%]')}>
                  <div
                    ref={(el) => { if (el) bubbleRefs.current.set(message.id, el); else bubbleRefs.current.delete(message.id); }}
                    className={cn('inline-block max-w-full text-left', isUser ? 'message-user' : 'message-assistant hud-corners w-full px-4 py-3 sm:px-5')}
                  >
                    {isUser ? <div className="whitespace-pre-wrap text-[0.94rem] font-medium">{message.content}</div> : renderMessageContent(message.content, isNewest)}
                  </div>

                  {/* Dashboard visual do relatório */}
                  {!isUser && message.dashboard && <DashboardCard d={message.dashboard} messageId={message.id} novo={isNewest} />}

                  {/* Cadastros propostos: só gravam depois de Confirmar */}
                  {!isUser && message.pendentes?.map((a) => <ActionCard key={a.id} acao={a} />)}

                  {/* Páginas abertas no navegador */}
                  {!isUser && message.actions && message.actions.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {message.actions.map((a) => (
                        <a
                          key={a.url}
                          href={a.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-100 transition-all hover:bg-cyan-400/20"
                        >
                          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="truncate">{a.label}</span>
                        </a>
                      ))}
                      {message.actions.some((a) => !a.opened) && (
                        <span className="text-[11px] text-amber-200/80">O navegador bloqueou a abertura automática: clique no link ou libere os pop-ups deste site.</span>
                      )}
                    </div>
                  )}

                  {/* Topologia 3D desta resposta */}
                  {!isUser && message.topology && (
                    <button
                      type="button"
                      onClick={() => onOpenTopology?.(message.topology!)}
                      className="mt-2 flex items-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-sm font-medium text-cyan-100 transition-all hover:bg-cyan-400/20 animate-glow"
                    >
                      <Network className="h-4 w-4" /> Abrir topologia 3D
                      <span className="font-mono text-[11px] text-cyan-300/70">{message.topology.resumo.equipamentos} equip. · {message.topology.resumo.comAlarme} com alarme</span>
                    </button>
                  )}

                  {/* Aparelhos consultados nesta resposta */}
                  {!isUser && message.devices && message.devices.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenDevices?.(message.devices!, 0)}
                        className="flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1 text-xs font-medium text-cyan-100 transition-all hover:bg-cyan-400/20 animate-glow"
                      >
                        <Box className="h-3.5 w-3.5" /> Ver em 3D
                      </button>
                      {message.devices.slice(0, 6).map((d, i) => {
                        const I = KIND_ICON[d.tipo];
                        return (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => onOpenDevices?.(message.devices!, i)}
                            className="flex max-w-[12rem] items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-900/60 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
                            title={d.nome}
                          >
                            <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', STATUS_STYLE[d.status].dot)} />
                            <I className="h-3 w-3 flex-shrink-0" />
                            <span className="truncate">{d.nome}</span>
                          </button>
                        );
                      })}
                      {message.devices.length > 6 && <span className="text-xs text-slate-500">+{message.devices.length - 6}</span>}
                    </div>
                  )}

                  {/* Sistemas consultados */}
                  {!isUser && message.metadata?.toolsUsed?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1" title="Ambientes consultados para esta resposta">
                      {[...new Set(message.metadata.toolsUsed)].map((name) => (
                        <span key={name} className="rounded border border-slate-700/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-400">
                          {toolLabel(name)}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {/* Ações */}
                  <div className={cn('mt-1.5 flex items-center gap-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100', isUser && 'justify-end')}>
                    <span className="mr-1 font-mono text-[10px] text-slate-500">{formatRelativeTime(message.timestamp)}</span>
                    {!isUser && (
                      <>
                        <button type="button" onClick={() => copyToClipboard(message.id, message.content)} className="icon-btn p-1.5" title="Copiar">
                          {copied === message.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                        {voice.canSpeak && (
                          <button
                            type="button"
                            onClick={() => (voice.speaking ? voice.stopSpeaking() : voice.speak(markdownToSpeech(message.content)))}
                            className="icon-btn p-1.5"
                            title={voice.speaking ? 'Parar leitura' : 'Ouvir resposta'}
                          >
                            {voice.speaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <button type="button" onClick={() => downloadMarkdown(message.content)} className="icon-btn p-1.5" title="Baixar relatório (.md)">
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => abrirDocumento(message.content, message.dashboard)}
                          className="icon-btn p-1.5"
                          title="Gerar documento (PDF com a identidade visual e o molde)"
                        >
                          <Printer className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {isLoading && <ThinkingPanel toolActivity={toolActivity} label={toolLabel} />}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Campo de pergunta */}
      <form onSubmit={handleSubmit} className="px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 sm:px-6">
        <div className="mx-auto max-w-4xl">
          {(conversation || voice.listening || voice.transcribing || voice.speaking) && (
            <VoiceStatus
              state={voice.listening ? 'listening' : voice.transcribing ? 'transcribing' : voice.speaking ? 'speaking' : isLoading ? 'thinking' : 'idle'}
              interim={voice.interim}
              conversation={conversation}
              aiEffect={aiEffect}
              onToggleEffect={toggleAiEffect}
              onInterrupt={voice.speaking ? interrupt : voice.listening ? voice.stopListening : undefined}
            />
          )}
          {voice.error && (
            <div className="mb-2 flex items-start justify-between gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100 animate-slide-up">
              <span>{voice.error}</span>
              <button type="button" onClick={voice.clearError} className="text-amber-300 hover:text-amber-100">×</button>
            </div>
          )}
          {showReports && (
            <div className="mb-2 flex flex-wrap gap-2 animate-slide-up">
              {REPORTS.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  disabled={isLoading}
                  onClick={() => send(r.prompt)}
                  className="flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-slate-900/80 px-3 py-1 text-xs text-cyan-100 transition-all hover:border-cyan-400/50"
                >
                  <FileBarChart className="h-3 w-3" />
                  {r.label}
                </button>
              ))}
            </div>
          )}

          <div className="glass flex items-end gap-1 rounded-2xl p-1.5 transition-all focus-within:border-cyan-400/40 focus-within:shadow-[0_0_30px_-12px_rgba(18,186,234,0.8)] sm:gap-1.5 sm:p-2">
            <button type="button" onClick={() => setShowReports(!showReports)} className={showReports ? 'icon-btn-active' : 'icon-btn'} title="Relatórios">
              <FileBarChart className="h-5 w-5" />
            </button>
            {voice.canSpeak && (
              <button type="button" onClick={toggleAutoSpeak} className={cn(autoSpeak ? 'icon-btn-active' : 'icon-btn', 'hidden sm:block')} title={autoSpeak ? 'Leitura automática das respostas: ligada' : 'Leitura automática das respostas: desligada'}>
                {autoSpeak ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
              </button>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
              onKeyDown={handleKeyDown}
              placeholder="Pergunte sobre a rede…"
              disabled={isLoading}
              rows={1}
              className="max-h-40 min-h-[40px] min-w-0 flex-1 resize-none overflow-hidden bg-transparent placeholder:truncate px-2 py-2 text-[0.95rem] text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-60"
            />

            {voice.canListen && voice.canSpeak && (
              <button type="button" onClick={toggleConversation} className={conversation ? 'icon-btn-active' : 'icon-btn'} title={conversation ? 'Encerrar modo conversa (Esc)' : 'Modo conversa: falar e ouvir sem clicar'}>
                <AudioLines className="h-5 w-5" />
              </button>
            )}
            {voice.canListen && (
              <button
                type="button"
                onClick={voice.speaking ? interrupt : handleMic}
                disabled={(isLoading && !voice.speaking) || voice.transcribing}
                className={cn(
                  'relative flex-shrink-0 rounded-xl p-2 transition-all disabled:opacity-40',
                  voice.listening ? 'bg-rose-500 text-white' : 'text-slate-300 hover:bg-cyan-400/10 hover:text-cyan-200',
                )}
                style={voice.listening ? { boxShadow: `0 0 0 ${2 + voice.level * 10}px rgba(244,114,182,0.25), 0 0 24px -4px rgba(244,114,182,0.9)` } : undefined}
                title={voice.listening ? 'Parar e enviar' : 'Perguntar por voz'}
              >
                {voice.transcribing ? <Loader2 className="h-5 w-5 animate-spin" /> : voice.listening ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>
            )}
            <button type="submit" disabled={!input.trim() || isLoading} className="btn-primary flex-shrink-0 rounded-xl p-2.5" title="Enviar">
              {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
          <div className="mt-1.5 hidden text-center font-mono text-[10px] text-slate-600 sm:block">
            Enter envia · Shift+Enter quebra linha · Esc interrompe a voz
          </div>
        </div>
      </form>

      {conversation && (
        <VoiceOverlay
          state={coreState}
          transcribing={voice.transcribing}
          level={voice.level}
          interim={voice.interim}
          lastQuestion={lastQuestion}
          lastAnswer={lastAnswer}
          autoSpeak={autoSpeak}
          onToggleAutoSpeak={toggleAutoSpeak}
          onMic={voice.speaking ? interrupt : handleMic}
          onEnd={toggleConversation}
        />
      )}
    </div>
  );
}
