/**
 * Express Server with WebSocket for IA NOC Agent
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { agent } from './agent/ianoc-agent.js';
import { memory } from './memory/memory-manager.js';
import { scanner } from './services/project-scanner.js';
import { llmConfigured, llmLabel, resetConversation } from './noc/assistant.js';
import { availableTools, connectorStatus } from './noc/tools.js';
import { getKnowledge } from './noc/knowledge.js';
import { nocConfig } from './noc/config.js';
import { speakToMp3, ttsEnabled, ttsVoiceLabel } from './noc/tts.js';
import { warmKokoro } from './noc/kokoro.js';
import { authenticateUpgrade, authEnabled, ipAllowed, handleLogin, handleLogout, handleMe, handlePassword, requireAuth, type SessionUser } from './auth.js';
import type { IncomingMessage } from 'http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatRequest, ChatResponse, ProjectInfo, FileInfo, AgentAction } from './shared/types.js';

// Error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  // Sem sessão válida do NOC, o upgrade do WebSocket é recusado antes de abrir.
  verifyClient: (info, done) => {
    authenticateUpgrade(info.req)
      .then((user) => {
        if (user) (info.req as IncomingMessage & { user?: SessionUser }).user = user;
        done(Boolean(user), 401, 'AUTH_REQUIRED');
      })
      .catch(() => done(false, 500));
  },
});

const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.HOST || 'localhost';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Varredura de projetos e leitura de arquivos do disco: úteis na máquina do
// desenvolvedor, perigosas num servidor. Em produção ficam desligadas.
const PROJECT_TOOLS = (process.env.IANOC_PROJECT_TOOLS || (process.env.NODE_ENV === 'production' ? 'off' : 'on')) !== 'off';
const PROJECT_ROUTES = ['/agent/scan', '/agent/scan-all', '/agent/discover', '/agent/actions/execute'];
const PROJECT_WS_TYPES = new Set(['scan', 'scan_all', 'get_files', 'execute_action']);

app.set('trust proxy', process.env.TRUST_PROXY === 'true');
// Antes de tudo (inclusive da tela de login): só os IPs liberados em IANOC_ALLOWED_IPS.
app.use((req, res, next) => {
  if (ipAllowed(req.socket.remoteAddress)) return next();
  console.warn(`[acesso] bloqueado: ${req.socket.remoteAddress} ${req.method} ${req.path}`);
  res.status(403).type('text').send('Acesso não permitido a partir deste endereço.');
});
app.use(cors({
  origin: [CORS_ORIGIN, 'http://localhost:5174', 'http://127.0.0.1:5174', 'http://127.0.0.1:5173', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

app.post('/api/auth/login', handleLogin);
app.post('/api/auth/password', handlePassword);
app.get('/api/auth/me', handleMe);
app.post('/api/auth/logout', handleLogout);
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!PROJECT_TOOLS && (PROJECT_ROUTES.includes(req.path) || /^\/agent\/projects\/[^/]+\/files$/.test(req.path))) {
    return res.status(403).json({ error: 'Função de projetos desligada neste servidor.' });
  }
  return requireAuth(req, res, next);
});

// Store active WebSocket connections
const clients = new Map<string, WebSocket>();
const clientUsers = new Map<string, string>();

// ============ REST API Routes ============

// Transcrição de voz no servidor, para navegadores sem reconhecimento de fala próprio.
// O áudio gravado (webm/ogg/mp4) é repassado a um endpoint OpenAI-compatível
// /audio/transcriptions (Groq/OpenAI Whisper ou faster-whisper local).
app.post('/api/voice/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  const { sttBaseUrl, sttApiKey, sttModel } = nocConfig.voice;
  if (!sttBaseUrl) return res.status(501).json({ error: 'Transcrição no servidor não configurada (STT_BASE_URL no .env).' });
  const audio = req.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length < 500) return res.status(400).json({ error: 'Áudio vazio ou curto demais.' });
  const type = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : type.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type }), `pergunta.${ext}`);
  form.append('model', sttModel);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  try {
    const response = await fetch(`${sttBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: sttApiKey ? { Authorization: `Bearer ${sttApiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const body = (await response.json().catch(() => ({}))) as { text?: string };
    if (!response.ok) return res.status(502).json({ error: `Transcrição falhou: HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}` });
    res.json({ text: String(body.text ?? '').trim() });
  } catch (error) {
    res.status(502).json({ error: `Transcrição falhou: ${error instanceof Error ? error.message : String(error)}` });
  }
});

// Fala da resposta: MP3 com a voz neural do servidor (uma frase por pedido).
app.post('/api/voice/speak', express.json({ limit: '16kb' }), async (req, res) => {
  if (!ttsEnabled()) return res.status(501).json({ error: 'Voz do servidor desligada (TTS_PROVIDER=browser).' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Texto vazio.' });
  try {
    const audio = await speakToMp3(text);
    // Kokoro devolve WAV; Fish e Microsoft, MP3.
    const tipo = audio.subarray(0, 4).toString('ascii') === 'RIFF' ? 'audio/wav' : 'audio/mpeg';
    res.set({ 'Content-Type': tipo, 'Cache-Control': 'no-store' }).send(audio);
  } catch (error) {
    res.status(502).json({ error: `Voz falhou: ${error instanceof Error ? error.message : String(error)}` });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), agent: 'IA NOC' });
});

// Quais ambientes do provedor o assistente alcança, e o que ele sabe do backbone.
app.get('/api/noc/status', async (req, res) => {
  try {
    const k = await getKnowledge(req.query.refresh === '1');
    res.json({
      llm: { configured: llmConfigured(), model: llmLabel() },
      connectors: connectorStatus(),
      voice: {
        serverTranscription: Boolean(nocConfig.voice.sttBaseUrl),
        serverSpeech: ttsEnabled(),
        voiceName: ttsEnabled() ? ttsVoiceLabel() : undefined,
      },
      tools: availableTools().map((t) => t.name),
      knowledge: {
        fonte: k.fonte,
        carregadoEm: k.carregadoEm,
        equipamentos: k.equipamentos.length,
        conexoes: k.conexoes.length,
        pops: k.pops.length + k.ispPops.length,
        caixas: k.caixas.length,
        fibras: k.fibras.length,
        documentos: k.documentos.map((d) => d.arquivo),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Falha ao ler status' });
  }
});

app.get('/api/agent/memory', async (req, res) => {
  try {
    res.json(await agent.getMemory());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get memory' });
  }
});

app.get('/api/agent/projects', async (req, res) => {
  try {
    res.json(await agent.getProjects());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get projects' });
  }
});

app.get('/api/agent/projects/:id', async (req, res) => {
  try {
    const project = await agent.getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get project' });
  }
});

app.get('/api/agent/projects/:id/files', async (req, res) => {
  try {
    const { category, importance } = req.query;
    const files = await scanner.getProjectFiles(req.params.id, category as string, importance as string);
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get files' });
  }
});

app.post('/api/agent/scan', async (req, res) => {
  try {
    const { path, name } = req.body;
    if (!path) {
      return res.status(400).json({ error: 'Path is required' });
    }
    const result = await agent.scanProject(path, name);
    res.json(result);
  } catch (error) {
    console.error('[API] Scan error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
  }
});

app.get('/api/agent/discover', (req, res) => {
  try {
    res.json({ root: scanner.rootPath, projects: scanner.discoverProjects() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Discover failed' });
  }
});

app.post('/api/agent/scan-all', async (req, res) => {
  try {
    const results = await scanner.scanAllProjects();
    res.json({
      root: scanner.rootPath,
      scanned: results.length,
      projects: results.map(r => ({ projectId: r.projectId, files: r.stats.totalFiles })),
    });
  } catch (error) {
    console.error('[API] Scan-all error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
  }
});

app.post('/api/agent/chat', async (req, res) => {
  try {
    const request: ChatRequest = req.body;
    const response = await agent.chat(request);
    res.json(response);
  } catch (error) {
    console.error('[API] Chat error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Chat failed' });
  }
});

app.post('/api/agent/preferences', async (req, res) => {
  try {
    await agent.updatePreferences(req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed' });
  }
});

app.post('/api/agent/profile', async (req, res) => {
  try {
    await agent.updateUserProfile(req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed' });
  }
});

app.post('/api/agent/actions/execute', async (req, res) => {
  const { action } = req.body as { action: AgentAction };
  
  try {
    let result: unknown;
    
    switch (action.type) {
      case 'read_file':
        if (action.params.path) {
          const files = await scanner.getProjectFiles(action.params.path as string);
          result = 'File read requires projectId context';
        }
        break;
      case 'analyze':
        if (action.params.projectId) {
          const project = await agent.getProject(action.params.projectId as string);
          result = project ? `Project: ${project.name}, ${project.fileCount} files, ${project.type}` : 'Project not found';
        }
        break;
      default:
        result = `Action ${action.type} not implemented yet`;
    }
    
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Action failed' });
  }
});

// ============ WebSocket Handling ============

let currentProjectId: string | undefined;

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const user = (req as IncomingMessage & { user?: SessionUser }).user;
  clients.set(clientId, ws);
  clientUsers.set(clientId, user?.username || 'anônimo');

  console.log(`[WS] Client connected: ${clientId} user=${user?.username} (${clients.size} total)`);
  
  // Send welcome message
  agent.getMemory().then(memory => {
    sendToClient(ws, {
      type: 'welcome',
      payload: {
        clientId,
        memory,
      },
    });
  }).catch(err => {
    console.error('[WS] Failed to get memory for welcome:', err);
  });
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleWebSocketMessage(clientId, ws, message);
    } catch (error) {
      console.error('[WS] Message error:', error);
      sendToClient(ws, { type: 'error', payload: { message: 'Invalid message format' } });
    }
  });
  
  ws.on('close', () => {
    clients.delete(clientId);
    clientUsers.delete(clientId);
    console.log(`[WS] Client disconnected: ${clientId} (${clients.size} total)`);
  });
  
  ws.on('error', (error) => {
    console.error('[WS] Error:', error);
    clients.delete(clientId);
    clientUsers.delete(clientId);
  });
});

async function handleWebSocketMessage(clientId: string, ws: WebSocket, message: { type: string; payload: unknown }): Promise<void> {
  // O frontend espera o requestId de volta para resolver a promessa daquela chamada.
  const requestId = (message.payload as { requestId?: string } | null)?.requestId;
  if (!PROJECT_TOOLS && PROJECT_WS_TYPES.has(message.type)) {
    sendToClient(ws, { type: 'error', payload: { message: 'Função de projetos desligada neste servidor.' } }, requestId);
    return;
  }
  switch (message.type) {
    case 'chat': {
      const request = message.payload as ChatRequest;
      if (request.projectId) currentProjectId = request.projectId;
      // Registro de uso: quem perguntou o quê (vai para o journal do systemd).
      console.log(`[chat] ${clientUsers.get(clientId)}: ${String(request.message).slice(0, 200).replace(/\s+/g, ' ')}`);
      
      sendToClient(ws, { type: 'chat_start', payload: { message: request.message } });

      try {
        const response = await agent.chat(
          { ...request, conversationId: request.conversationId || clientId },
          (event) => sendToClient(ws, { type: event.type, payload: event }),
        );
        sendToClient(ws, { type: 'chat_response', payload: response }, requestId);
      } catch (error) {
        console.error('[WS] Chat error:', error);
        sendToClient(ws, {
          type: 'chat_response',
          payload: { message: `⚠️ Falha ao consultar o assistente: ${error instanceof Error ? error.message : 'erro desconhecido'}` },
        }, requestId);
      }
      break;
    }

    case 'reset_conversation': {
      resetConversation(clientId);
      sendToClient(ws, { type: 'conversation_reset', payload: {} }, requestId);
      break;
    }
    
    case 'get_memory': {
      const mem = await agent.getMemory();
      sendToClient(ws, { type: 'memory', payload: mem }, requestId);
      break;
    }
    
    case 'get_projects': {
      const projects = await agent.getProjects();
      sendToClient(ws, { type: 'projects', payload: projects }, requestId);
      break;
    }
    
    case 'get_project': {
      const { id } = message.payload as { id: string };
      const project = await agent.getProject(id);
      sendToClient(ws, { type: 'project', payload: project }, requestId);
      break;
    }
    
    case 'get_files': {
      const { projectId: pid, category, importance } = message.payload as { projectId: string; category?: string; importance?: string };
      const files = await scanner.getProjectFiles(pid, category, importance);
      sendToClient(ws, { type: 'files', payload: files }, requestId);
      break;
    }
    
    case 'scan': {
      const { path, name } = message.payload as { path: string; name?: string };
      sendToClient(ws, { type: 'scan_start', payload: { path } });
      
      try {
        const result = await agent.scanProject(path, name);
        sendToClient(ws, { type: 'scan_complete', payload: result }, requestId);
      } catch (error) {
        sendToClient(ws, { type: 'scan_error', payload: { error: error instanceof Error ? error.message : 'Scan failed' } }, requestId);
      }
      break;
    }
    
    case 'scan_all': {
      sendToClient(ws, { type: 'scan_start', payload: { path: scanner.rootPath } });

      try {
        const results = await scanner.scanAllProjects();
        sendToClient(ws, { type: 'scan_all_complete', payload: { scanned: results.length, results } }, requestId);
      } catch (error) {
        sendToClient(ws, { type: 'scan_error', payload: { error: error instanceof Error ? error.message : 'Scan failed' } }, requestId);
      }
      break;
    }

    case 'update_preferences': {
      await agent.updatePreferences(message.payload as Record<string, unknown>);
      const mem = await agent.getMemory();
      sendToClient(ws, { type: 'preferences_updated', payload: mem.identity.preferences }, requestId);
      break;
    }
    
    case 'update_profile': {
      await agent.updateUserProfile(message.payload as Record<string, unknown>);
      const mem = await agent.getMemory();
      sendToClient(ws, { type: 'profile_updated', payload: mem.identity.userProfile }, requestId);
      break;
    }
    
    case 'execute_action': {
      const { action } = message.payload as { action: AgentAction };
      sendToClient(ws, { type: 'action_start', payload: action });
      
      try {
        let result: unknown;
        switch (action.type) {
          case 'read_file':
            if (action.params.path && currentProjectId) {
              const files = await scanner.getProjectFiles(currentProjectId);
              const file = files.find(f => f.relativePath === action.params.path);
              result = file?.content || 'File not found';
            }
            break;
          case 'analyze':
            if (action.params.projectId) {
              const p = await agent.getProject(action.params.projectId as string);
              result = p ? `Project: ${p.name}, ${p.fileCount} files` : 'Not found';
            }
            break;
        }
        sendToClient(ws, { type: 'action_complete', payload: { action, result } }, requestId);
      } catch (error) {
        sendToClient(ws, { type: 'action_error', payload: { action, error: error instanceof Error ? error.message : 'Failed' } }, requestId);
      }
      break;
    }
    
    case 'ping': {
      sendToClient(ws, { type: 'pong', payload: { timestamp: Date.now() } }, requestId);
      break;
    }
    
    default:
      sendToClient(ws, { type: 'error', payload: { message: `Unknown message type: ${message.type}` } }, requestId);
  }
}

function sendToClient(ws: WebSocket, message: { type: string; payload: unknown }, requestId?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(requestId ? { ...message, requestId } : message));
  }
}

function broadcast(message: { type: string; payload: unknown }): void {
  for (const ws of clients.values()) {
    sendToClient(ws, message);
  }
}

// ============ Frontend (build do Vite) ============

// Em produção o próprio backend serve a interface: uma porta só, mesma origem
// para o cookie de sessão e para o WebSocket.
const FRONTEND_DIST = process.env.FRONTEND_DIST
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
  app.use(express.static(FRONTEND_DIST, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));
}

// ============ Start Server ============

async function startServer() {
  // Initialize memory and create initial session
  await memory.createSession();

  server.listen(PORT, HOST, () => {
    warmKokoro();
    console.log(`🚀 IA NOC Agent server running on http://${HOST}:${PORT}`);
    console.log(`🔐 Login: ${authEnabled ? `usuário do NOC (${nocConfig.noc.baseUrl || 'NOC_API_URL não configurado!'})` : 'DESLIGADO (IANOC_AUTH=off)'}`);
    console.log(`🛡️  IPs liberados: ${process.env.IANOC_ALLOWED_IPS || 'qualquer um'}`);
    console.log(`🗂️  Varredura de projetos: ${PROJECT_TOOLS ? 'ligada' : 'desligada'}`);
    console.log(`📡 WebSocket server ready`);
    console.log(`🌐 CORS enabled for: ${CORS_ORIGIN}`);
    console.log(`🧠 Assistente NOC: ${llmConfigured() ? llmLabel() : `modelo não configurado (${llmLabel()}) — respostas locais`}`);
    console.log(`🔌 Conectores: ${Object.entries(connectorStatus()).map(([n, on]) => `${n}=${on ? 'on' : 'off'}`).join(' ')}`);
  });
}

startServer().catch(console.error);

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  const session = memory.getCurrentSession();
  if (session) {
    await memory.endSession();
  }
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

export { app, server, wss };