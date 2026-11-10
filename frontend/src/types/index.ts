// Frontend types - mirrors shared types

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  description?: string;
  type: ProjectType;
  language?: string;
  framework?: string;
  lastScanned: number;
  fileCount: number;
  size: number;
  metadata: ProjectMetadata;
}

export type ProjectType = 
  | 'nodejs' 
  | 'python' 
  | 'rust' 
  | 'go' 
  | 'java' 
  | 'dotnet' 
  | 'php' 
  | 'ruby' 
  | 'frontend' 
  | 'mobile' 
  | 'docs' 
  | 'config' 
  | 'unknown';

export interface ProjectMetadata {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  mainEntry?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  dockerfile?: boolean;
  readme?: boolean;
  license?: string;
  repository?: string;
  author?: string;
  version?: string;
}

export interface FileInfo {
  path: string;
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  isDirectory: boolean;
  content?: string;
  hash?: string;
  lastModified: number;
  category: FileCategory;
  importance: ImportanceLevel;
}

export type FileCategory = 
  | 'source' 
  | 'test' 
  | 'config' 
  | 'documentation' 
  | 'asset' 
  | 'build' 
  | 'dependency' 
  | 'ignore';

export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low' | 'ignore';

export interface AgentIdentity {
  name: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  userProfile: UserProfile;
  preferences: AgentPreferences;
  knownProjects: string[];
}

export interface UserProfile {
  name?: string;
  role?: string;
  company?: string;
  technologies?: string[];
  workflows?: string[];
  communicationStyle?: 'formal' | 'casual' | 'technical' | 'friendly';
  timezone?: string;
  workingHours?: { start: string; end: string; days: number[] };
}

export interface AgentPreferences {
  language: 'pt-BR' | 'en-US';
  verbosity: 'concise' | 'normal' | 'detailed';
  autoLearn: boolean;
  notifyChanges: boolean;
  maxContextFiles: number;
  preferredFrameworks: string[];
}

export interface LearnedKnowledge {
  patterns: CodePattern[];
  conventions: Convention[];
  architectures: ArchitecturePattern[];
  workflows: WorkflowPattern[];
  teamMembers: TeamMember[];
  decisions: Decision[];
  issues: KnownIssue[];
}

export interface CodePattern {
  id: string;
  name: string;
  description: string;
  language: string;
  pattern: string;
  examples: string[];
  frequency: number;
  projects: string[];
  lastSeen: number;
}

export interface Convention {
  id: string;
  type: 'naming' | 'structure' | 'formatting' | 'testing' | 'documentation' | 'git' | 'other';
  rule: string;
  rationale?: string;
  examples: { good: string; bad?: string }[];
  severity: 'error' | 'warning' | 'info';
  projects: string[];
  autoDetected: boolean;
}

export interface ArchitecturePattern {
  id: string;
  name: string;
  description: string;
  layers: string[];
  components: string[];
  dataFlow: string;
  projects: string[];
  confidence: number;
}

export interface WorkflowPattern {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  triggers: string[];
  tools: string[];
  frequency: number;
  projects: string[];
}

export interface WorkflowStep {
  name: string;
  description: string;
  command?: string;
  automation?: boolean;
  dependsOn?: string[];
}

export interface TeamMember {
  id: string;
  name: string;
  email?: string;
  role: string;
  expertise: string[];
  projects: string[];
  commitPatterns: CommitPattern[];
  communicationStyle?: string;
}

export interface CommitPattern {
  type: 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore' | 'other';
  frequency: number;
  avgMessageLength: number;
  usesScope: boolean;
  usesBreaking: boolean;
}

export interface Decision {
  id: string;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  date: number;
  author?: string;
  projectId?: string;
  tags: string[];
}

export interface KnownIssue {
  id: string;
  title: string;
  description: string;
  symptoms: string[];
  causes: string[];
  solutions: Solution[];
  frequency: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  projectId?: string;
  status: 'open' | 'investigating' | 'fixed' | 'wontfix';
  lastOccurrence: number;
}

export interface Solution {
  description: string;
  steps: string[];
  codeExample?: string;
  verified: boolean;
  successRate: number;
}

export interface AgentMemory {
  identity: AgentIdentity;
  knowledge: LearnedKnowledge;
  session: SessionContext;
}

export interface SessionContext {
  sessionId: string;
  startedAt: number;
  currentProject?: string;
  activeFiles: string[];
  conversationHistory: Message[];
  userIntent?: UserIntent;
  workingMemory: WorkingMemoryItem[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
  devices?: DeviceCard[];
  topology?: TopologyGraph;
  // Páginas que a NIA abriu (ou tentou abrir) no navegador para esta resposta.
  actions?: Array<{ url: string; label: string; opened: boolean }>;
  pendentes?: AcaoPendente[];
  dashboard?: Dashboard;
}

export interface MessageMetadata {
  projectId?: string;
  fileRefs?: string[];
  intent?: UserIntent;
  tokensUsed?: number;
  modelUsed?: string;
  toolsUsed?: string[];
}

export type UserIntent = 
  | 'question' 
  | 'code_generation' 
  | 'code_review' 
  | 'debugging' 
  | 'refactoring' 
  | 'documentation' 
  | 'learning' 
  | 'planning' 
  | 'automation' 
  | 'other';

export interface WorkingMemoryItem {
  key: string;
  value: unknown;
  expiresAt: number;
  source: 'user' | 'agent' | 'file' | 'inference';
}

export interface ChatRequest {
  message: string;
  projectId?: string;
  contextFiles?: string[];
  stream?: boolean;
  model?: string;
  /** Pergunta ditada no microfone: a resposta começa com um resumo para ser falado. */
  voice?: boolean;
}

export interface ChatResponse {
  message: string;
  metadata?: MessageMetadata;
  suggestions?: string[];
  actions?: AgentAction[];
}

export interface AgentAction {
  type: 'read_file' | 'write_file' | 'run_command' | 'search' | 'analyze' | 'create_task';
  description: string;
  params: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ScanResult {
  projectId: string;
  scannedAt: number;
  files: FileInfo[];
  stats: ScanStats;
  changes?: FileChange[];
}

export interface ScanStats {
  totalFiles: number;
  totalSize: number;
  byCategory: Record<FileCategory, number>;
  byExtension: Record<string, number>;
  byImportance: Record<ImportanceLevel, number>;
  newFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
}

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  previousHash?: string;
  newHash?: string;
}

// WebSocket message types
export interface WSMessage {
  type: string;
  payload: unknown;
  requestId?: string;
}

export type WSMessageType = 
  | 'welcome'
  | 'dashboard'
  | 'chat_start'
  | 'chat_response'
  | 'memory'
  | 'projects'
  | 'project'
  | 'files'
  | 'scan_start'
  | 'scan_complete'
  | 'scan_error'
  | 'preferences_updated'
  | 'profile_updated'
  | 'action_start'
  | 'action_complete'
  | 'action_error'
  | 'error'
  | 'ping'
  | 'tool_start'
  | 'open_url'
  | 'pending_action'
  | 'tool_end'
  | 'conversation_reset'
  | 'pong';
// Consulta do assistente NOC a um ambiente (Zabbix, OLT, IXC...) em andamento ou concluída
export interface ToolActivity {
  id: string;
  name: string;
  input?: unknown;
  done: boolean;
  ok?: boolean;
  ms?: number;
  devices?: DeviceCard[];
}

// Aparelho citado numa consulta do assistente (backend/src/noc/devices.ts), mostrado em 3D.
export type DeviceKind = 'olt' | 'switch' | 'roteador' | 'onu' | 'servidor' | 'transporte' | 'generico';
export type DeviceStatus = 'ok' | 'atencao' | 'critico' | 'desconhecido';
export interface DevicePort { numero: number; status: string; tipo?: string; capacidade?: string; descricao?: string }
export interface DeviceCard {
  id: string;
  nome: string;
  tipo: DeviceKind;
  modelo?: string;
  fabricante?: string;
  local?: string;
  categoria?: string;
  status: DeviceStatus;
  alertas?: string[];
  portas?: DevicePort[];
  metricas?: Array<{ nome: string; valor: string }>;
  fonte: string;
}

// Topologia da rede para o painel 3D (backend/src/noc/topology.ts).
export type TopoKind = DeviceKind | 'servico' | 'nuvem' | 'site';
export interface TopoNode {
  id: string;
  nome: string;
  tipo: TopoKind;
  camada: number;
  origem: 'topologia' | 'zabbix' | 'virtual';
  status: DeviceStatus;
  modelo?: string;
  local?: string;
  categoria?: string;
  hosts?: string[];
  alertas?: string[];
  portas?: { usadas: number; total: number };
  agrupados?: number;
}
export interface TopoLink { de: string; para: string; capacidade?: string; tipo?: string; gbps?: number; inferido?: boolean; status: 'ok' | 'alerta' | 'desconhecido' }
export interface TopologyGraph {
  nodes: TopoNode[];
  links: TopoLink[];
  fonte: string;
  geradoEm: string;
  resumo: { equipamentos: number; enlaces: number; inferidos: number; comAlarme: number; hostsZabbix: number; alarmesClientes: number; erros?: string[] };
}

// Cadastro proposto pela NIA, aguardando confirmação (backend/src/noc/acoes.ts).
export interface AcaoPendente {
  id: string;
  tipo: 'zabbix_host' | 'noc_cliente' | 'noc_pop' | 'noc_equipamento' | 'noc_enlace';
  titulo: string;
  campos: Array<{ rotulo: string; valor: string }>;
  avisos: string[];
  expiraEm: number;
}

// ------------------------------------------------------------------ dashboards (backend noc/dashboard.ts)

export type DashTom = 'ok' | 'atencao' | 'critico' | 'info' | 'marca';
export type DashFormato = 'numero' | 'duracao_min' | 'horas';
export interface DashKpi { id: string; rotulo: string; valor: string; detalhe?: string; tom: DashTom; icone: string }
export interface DashSerie { rotulo: string; valor: number; cor?: string }
export interface DashGrafico {
  id: string;
  tipo: 'linha' | 'rosca' | 'barras' | 'barras_h';
  grupo: string;
  titulo: string;
  subtitulo?: string;
  formato?: DashFormato;
  largura?: 1 | 2;
  series: DashSerie[];
}
export interface DashTabela { grupo: string; titulo: string; colunas: string[]; linhas: string[][]; tons?: Array<DashTom | null | undefined> }
export interface Dashboard {
  id: string;
  titulo: string;
  periodo: string;
  intervalo: string;
  geradoEm: string;
  fontes: string[];
  status: { tom: DashTom; texto: string };
  resumo?: string;
  kpis: DashKpi[];
  graficos: DashGrafico[];
  tabelas: DashTabela[];
  destaques: string[];
  recomendacoes: string[];
  indisponiveis: string[];
  abrir?: boolean;
}
