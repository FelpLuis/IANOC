import { useState, useEffect, useCallback, useRef } from 'react';
import { ws } from '../services/websocket';
import type { AgentMemory, ProjectInfo, FileInfo, ChatResponse, AgentAction, ScanResult, Message, ToolActivity, DeviceCard, TopologyGraph, AcaoPendente, Dashboard } from '../types';

export function useAgent() {
  const [memory, setMemory] = useState<AgentMemory | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectInfo | null>(null);
  const [projectFiles, setProjectFiles] = useState<FileInfo[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  // Aparelhos vistos nas consultas da pergunta atual; vão junto com a resposta.
  const turnDevices = useRef(new Map<string, DeviceCard>());
  const turnTopology = useRef<TopologyGraph | null>(null);
  const turnActions = useRef<Array<{ url: string; label: string; opened: boolean }>>([]);
  const turnPendentes = useRef<AcaoPendente[]>([]);
  const turnDashboard = useRef<Dashboard | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  // Initialize connection
  useEffect(() => {
    const init = async () => {
      try {
        setIsLoading(true);
        await ws.connect();
        setIsConnected(true);
        
        // Load initial data
        const [mem, projs] = await Promise.all([
          ws.getMemory(),
          ws.getProjects(),
        ]);
        
        setMemory(mem);
        setProjects(projs);
        
        if (projs.length > 0) {
          const firstProject = projs[0];
          setCurrentProject(firstProject);
          const files = await ws.getFiles(firstProject.id);
          setProjectFiles(files);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initialize');
      } finally {
        setIsLoading(false);
      }
    };

    // A conexão abre uma vez só. Os handlers abaixo, não: no StrictMode o efeito
    // roda duas vezes e a limpeza da primeira remove os handlers registrados nela.
    if (!initialized.current) {
      initialized.current = true;
      init();
    }

    // Set up message handlers
    const unsubscribeWelcome = ws.on('welcome', (msg) => {
      if (msg.payload && typeof msg.payload === 'object' && 'memory' in msg.payload) {
        setMemory(msg.payload.memory as AgentMemory);
      }
    });

    const unsubscribeChat = ws.on('chat_response', (msg) => {
      if (msg.payload && typeof msg.payload === 'object' && 'message' in msg.payload) {
        const response = msg.payload as ChatResponse;
        const assistantMsg: Message = {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: response.message,
          timestamp: Date.now(),
          metadata: response.metadata,
          ...(turnDevices.current.size ? { devices: [...turnDevices.current.values()] } : {}),
          ...(turnTopology.current ? { topology: turnTopology.current } : {}),
          ...(turnActions.current.length ? { actions: turnActions.current } : {}),
          ...(turnPendentes.current.length ? { pendentes: turnPendentes.current } : {}),
          ...(turnDashboard.current ? { dashboard: turnDashboard.current } : {}),
        };
        turnDashboard.current = null;
        turnActions.current = [];
        turnPendentes.current = [];
        turnDevices.current = new Map();
        turnTopology.current = null;
        setMessages(prev => [...prev, assistantMsg]);
      }
    });

    const unsubscribeToolStart = ws.on('tool_start', (msg) => {
      const e = msg.payload as { id: string; name: string; input?: unknown };
      setToolActivity(prev => [...prev, { id: e.id, name: e.name, input: e.input, done: false }]);
    });

    const unsubscribeToolEnd = ws.on('tool_end', (msg) => {
      const e = msg.payload as { id: string; ok: boolean; ms: number; devices?: DeviceCard[]; topology?: TopologyGraph };
      for (const d of e.devices ?? []) turnDevices.current.set(d.id, d);
      if (e.topology) turnTopology.current = e.topology;
      setToolActivity(prev => prev.map(t => t.id === e.id ? { ...t, done: true, ok: e.ok, ms: e.ms, devices: e.devices } : t));
    });

    // A NIA pediu para abrir uma página: só http/https, em nova guia. Se o navegador bloquear
    // o pop-up, a resposta mostra o link para clicar.
    const unsubscribeOpen = ws.on('open_url', (msg) => {
      const e = msg.payload as { url?: string; label?: string };
      let url: URL;
      try { url = new URL(String(e.url)); } catch { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      const w = window.open(url.href, '_blank');
      if (w) w.opener = null;
      turnActions.current.push({ url: url.href, label: String(e.label ?? url.hostname), opened: Boolean(w) });
    });

    // Cadastro proposto: vira um cartão com Confirmar/Cancelar na resposta.
    const unsubscribePending = ws.on('pending_action', (msg) => {
      const e = msg.payload as { acao?: AcaoPendente };
      if (e.acao?.id) turnPendentes.current.push(e.acao);
    });

    // Dashboard do relatório: vai junto com a resposta e aparece como painel visual.
    const unsubscribeDashboard = ws.on('dashboard', (msg) => {
      const e = msg.payload as { dashboard?: Dashboard };
      if (e.dashboard?.kpis) turnDashboard.current = e.dashboard;
    });

    const unsubscribeProjects = ws.on('projects', (msg) => {
      if (msg.payload) {
        setProjects(msg.payload as ProjectInfo[]);
      }
    });

    const unsubscribeProject = ws.on('project', (msg) => {
      if (msg.payload) {
        setCurrentProject(msg.payload as ProjectInfo);
      }
    });

    const unsubscribeFiles = ws.on('files', (msg) => {
      if (msg.payload) {
        setProjectFiles(msg.payload as FileInfo[]);
      }
    });

    const unsubscribeScan = ws.on('scan_complete', (msg) => {
      if (msg.payload) {
        const result = msg.payload as ScanResult;
        setProjects(prev => {
          const exists = prev.find(p => p.id === result.projectId);
          if (exists) {
            return prev.map(p => p.id === result.projectId ? { ...p, lastScanned: result.scannedAt, fileCount: result.files.filter(f => !f.isDirectory).length } : p);
          }
          return [...prev, { 
            id: result.projectId, 
            name: result.projectId, 
            path: '', 
            type: 'unknown', 
            lastScanned: result.scannedAt, 
            fileCount: result.files.filter(f => !f.isDirectory).length, 
            size: 0, 
            metadata: {} 
          }];
        });
      }
    });

    const unsubscribeMemory = ws.on('memory', (msg) => {
      if (msg.payload) {
        setMemory(msg.payload as AgentMemory);
      }
    });

    return () => {
      unsubscribeWelcome();
      unsubscribeChat();
      unsubscribeToolStart();
      unsubscribeToolEnd();
      unsubscribeOpen();
      unsubscribePending();
      unsubscribeDashboard();
      unsubscribeProjects();
      unsubscribeProject();
      unsubscribeFiles();
      unsubscribeScan();
      unsubscribeMemory();
    };
  }, []);

  // Send chat message
  const sendMessage = useCallback(async (content: string, options?: { projectId?: string; contextFiles?: string[]; voice?: boolean }) => {
    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      metadata: { projectId: options?.projectId, fileRefs: options?.contextFiles },
    };
    setMessages(prev => [...prev, userMsg]);
    setError(null);
    setToolActivity([]);
    setIsChatting(true);

    try {
      await ws.chat({
        message: content,
        projectId: options?.projectId || currentProject?.id,
        contextFiles: options?.contextFiles,
        voice: options?.voice,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      // Remove user message on error
      setMessages(prev => prev.filter(m => m.id !== userMsg.id));
    } finally {
      setIsChatting(false);
    }
  }, [currentProject?.id]);

  // Switch project
  const switchProject = useCallback(async (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    setCurrentProject(project);
    setIsLoading(true);
    
    try {
      const files = await ws.getFiles(projectId);
      setProjectFiles(files);
      setMessages([]); // Clear messages when switching projects
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setIsLoading(false);
    }
  }, [projects]);

  // Scan new project
  const scanProject = useCallback(async (path: string, name?: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await ws.scanProject(path, name);
      // Refresh projects list
      const projs = await ws.getProjects();
      setProjects(projs);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Scan failed';
      setError(errorMsg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Update preferences
  const updatePreferences = useCallback(async (preferences: Record<string, unknown>) => {
    try {
      await ws.updatePreferences(preferences);
      if (memory) {
        setMemory({ ...memory, identity: { ...memory.identity, preferences: { ...memory.identity.preferences, ...preferences } as typeof memory.identity.preferences } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preferences');
    }
  }, [memory]);

  // Update profile
  const updateProfile = useCallback(async (profile: Record<string, unknown>) => {
    try {
      await ws.updateProfile(profile);
      if (memory) {
        setMemory({ ...memory, identity: { ...memory.identity, userProfile: { ...memory.identity.userProfile, ...profile } as typeof memory.identity.userProfile } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    }
  }, [memory]);

  // Execute action
  const executeAction = useCallback(async (action: AgentAction) => {
    try {
      return await ws.executeAction(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      throw err;
    }
  }, []);

  // Clear error
  const clearError = useCallback(() => setError(null), []);

  return {
    // State
    memory,
    projects,
    currentProject,
    projectFiles,
    messages,
    isLoading,
    isChatting,
    toolActivity,
    isConnected,
    error,
    
    // Actions
    sendMessage,
    switchProject,
    scanProject,
    updatePreferences,
    updateProfile,
    executeAction,
    clearError,
    
    // Setters for optimistic updates
    setMessages,
    setCurrentProject,
    setProjectFiles,
  };
}