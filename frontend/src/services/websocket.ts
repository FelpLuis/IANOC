import type { WSMessage, WSMessageType, ChatRequest, AgentAction, AgentMemory, ProjectInfo, FileInfo, ScanResult } from '../types';

type MessageHandler = (message: WSMessage) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: Map<WSMessageType, MessageHandler[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private clientId: string | null = null;
  private pendingRequests: Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }> = new Map();
  private requestId = 0;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      // Mesma origem da página: em produção o backend serve a interface; em dev o Vite faz proxy de /ws.
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WS] Connected');
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('[WS] Parse error:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('[WS] Disconnected');
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('[WS] Error:', error);
        if (this.reconnectAttempts === 0) {
          reject(new Error('WebSocket connection failed'));
        }
      };
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  private handleMessage(message: WSMessage): void {
    // Resposta a uma request(): o servidor devolve o requestId no nível de cima da mensagem.
    // Os handlers continuam recebendo a mensagem (é por eles que o chat entra na tela).
    const pending = message.requestId ? this.pendingRequests.get(message.requestId) : undefined;
    if (pending && message.requestId) {
      this.pendingRequests.delete(message.requestId);
      const payload = message.payload as Record<string, unknown> | null;
      if (message.type === 'error' || message.type === 'scan_error' || message.type === 'action_error') {
        pending.reject(new Error(String(payload?.message ?? payload?.error ?? 'Erro no servidor')));
      } else {
        pending.resolve(message.payload);
      }
    }

    // Handle regular messages
    const handlers = this.handlers.get(message.type as WSMessageType) || [];
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(`[WS] Handler error for ${message.type}:`, error);
      }
    }
  }

  send(type: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('[WS] Not connected, queuing message');
    }
  }

  request<T>(type: string, payload: unknown, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const requestId = `${++this.requestId}-${Date.now()}`;
      this.pendingRequests.set(requestId, { 
        resolve: resolve as (value: unknown) => void, 
        reject 
      });
      
      const messagePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload as Record<string, unknown>, requestId }
        : { payload, requestId };
      
      this.send(type, messagePayload);
      
      // Timeout after specified milliseconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, timeoutMs);
    });
  }

  on(type: WSMessageType, handler: MessageHandler): () => void {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
    
    return () => {
      const currentHandlers = this.handlers.get(type) || [];
      const index = currentHandlers.indexOf(handler);
      if (index !== -1) {
        currentHandlers.splice(index, 1);
      }
    };
  }

  off(type: WSMessageType, handler: MessageHandler): void {
    const handlers = this.handlers.get(type) || [];
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  // Convenience methods
  async chat(request: ChatRequest): Promise<{ message: string; suggestions?: string[]; actions?: AgentAction[] }> {
    // O assistente NOC encadeia várias consultas (Zabbix, OLT, IXC...) antes de responder.
    return this.request('chat', request, 300000);
  }

  async getMemory(): Promise<AgentMemory> {
    return this.request('get_memory', {});
  }

  async getProjects(): Promise<ProjectInfo[]> {
    return this.request('get_projects', {});
  }

  async getProject(id: string): Promise<ProjectInfo> {
    return this.request('get_project', { id });
  }

  async getFiles(projectId: string, category?: string, importance?: string): Promise<FileInfo[]> {
    return this.request('get_files', { projectId, category, importance });
  }

  async scanProject(path: string, name?: string): Promise<ScanResult> {
    return this.request('scan', { path, name }, 120000); // 2 minutes timeout for scanning
  }

  async updatePreferences(preferences: Record<string, unknown>): Promise<void> {
    await this.request('update_preferences', preferences);
  }

  async updateProfile(profile: Record<string, unknown>): Promise<void> {
    await this.request('update_profile', profile);
  }

  async executeAction(action: AgentAction): Promise<unknown> {
    return this.request('execute_action', { action });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
    this.pendingRequests.clear();
  }

  getClientId(): string | null {
    return this.clientId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const ws = new WebSocketService();