/**
 * Shared types for IA NOC Agent
 */

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

export interface AgentMemory {
  // Persistent identity (survives sessions)
  identity: AgentIdentity;
  // Learned knowledge (persistent)
  knowledge: LearnedKnowledge;
  // Session context (temporary)
  session: SessionContext;
}

export interface AgentIdentity {
  name: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  userProfile: UserProfile;
  preferences: AgentPreferences;
  knownProjects: string[]; // project IDs
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
}

export interface MessageMetadata {
  projectId?: string;
  fileRefs?: string[];
  intent?: UserIntent;
  tokensUsed?: number;
  modelUsed?: string;
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

export interface ChatRequest {
  message: string;
  projectId?: string;
  contextFiles?: string[];
  stream?: boolean;
  model?: string;
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

export interface ProjectConfig {
  rootPath: string;
  name?: string;
  ignorePatterns: string[];
  includePatterns: string[];
  maxFileSize: number;
  maxFiles: number;
  scanTimeoutMs?: number;
  watchEnabled: boolean;
  autoScanInterval: number; // minutes
  learningEnabled: boolean;
}