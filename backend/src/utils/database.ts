/**
 * LowDB Database Setup for IA NOC Agent
 * Pure JavaScript JSON file-based storage
 */

import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DB_PATH || join(__dirname, '..', '..', 'data', 'agent.json');

export interface DbSchema {
  agent_identity: Record<string, { value: string; updated_at: number }>;
  projects: ProjectRecord[];
  project_files: ProjectFileRecord[];
  learned_patterns: PatternRecord[];
  conventions: ConventionRecord[];
  architecture_patterns: ArchitectureRecord[];
  workflows: WorkflowRecord[];
  team_members: TeamMemberRecord[];
  decisions: DecisionRecord[];
  known_issues: IssueRecord[];
  sessions: SessionRecord[];
  messages: MessageRecord[];
  scan_history: ScanHistoryRecord[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description: string | null;
  type: string | null;
  language: string | null;
  framework: string | null;
  last_scanned: number;
  file_count: number;
  size: number;
  metadata: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectFileRecord {
  id: string;
  project_id: string;
  path: string;
  relative_path: string;
  name: string;
  extension: string | null;
  size: number;
  is_directory: number;
  hash: string | null;
  last_modified: number;
  category: string;
  importance: string;
  content_hash: string | null;
}

export interface PatternRecord {
  id: string;
  name: string;
  description: string | null;
  language: string | null;
  pattern: string;
  examples: string;
  frequency: number;
  projects: string;
  last_seen: number;
  created_at: number;
}

export interface ConventionRecord {
  id: string;
  type: string;
  rule: string;
  rationale: string | null;
  examples: string;
  severity: string;
  projects: string;
  auto_detected: number;
  created_at: number;
  updated_at: number;
}

export interface ArchitectureRecord {
  id: string;
  name: string;
  description: string | null;
  layers: string;
  components: string;
  data_flow: string | null;
  projects: string;
  confidence: number;
  created_at: number;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  steps: string;
  triggers: string | null;
  tools: string | null;
  frequency: number;
  projects: string;
  created_at: number;
}

export interface TeamMemberRecord {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  expertise: string;
  projects: string;
  commit_patterns: string;
  communication_style: string | null;
  created_at: number;
}

export interface DecisionRecord {
  id: string;
  title: string;
  context: string | null;
  decision: string;
  rationale: string | null;
  alternatives: string;
  status: string;
  date: number;
  author: string | null;
  project_id: string | null;
  tags: string;
  created_at: number;
}

export interface IssueRecord {
  id: string;
  title: string;
  description: string | null;
  symptoms: string;
  causes: string;
  solutions: string;
  frequency: number;
  severity: string;
  project_id: string | null;
  status: string;
  last_occurrence: number;
  created_at: number;
}

export interface SessionRecord {
  id: string;
  started_at: number;
  ended_at: number | null;
  current_project: string | null;
  metadata: string;
}

export interface MessageRecord {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
  metadata: string | null;
}

export interface ScanHistoryRecord {
  id: string;
  project_id: string;
  scanned_at: number;
  stats: string;
  changes: string | null;
}

const defaultData: DbSchema = {
  agent_identity: {},
  projects: [],
  project_files: [],
  learned_patterns: [],
  conventions: [],
  architecture_patterns: [],
  workflows: [],
  team_members: [],
  decisions: [],
  known_issues: [],
  sessions: [],
  messages: [],
  scan_history: [],
};

let dbInstance: Low<DbSchema> | null = null;

export async function initializeDatabase(): Promise<Low<DbSchema>> {
  if (dbInstance) return dbInstance;

  const dbDir = dirname(DB_PATH);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const adapter = new JSONFile<DbSchema>(DB_PATH);
  dbInstance = new Low(adapter, defaultData);
  
  await dbInstance.read();
  
  // Ensure all tables exist
  if (!dbInstance.data) {
    dbInstance.data = defaultData;
  }
  
  // Initialize with defaults if empty
  if (!dbInstance.data.agent_identity.identity) {
    await saveIdentity({
      name: 'IA NOC',
      version: '1.0.0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userProfile: {
        name: 'Usuário',
        role: 'Desenvolvedor',
        technologies: [],
        workflows: [],
        communicationStyle: 'technical',
        timezone: 'America/Sao_Paulo',
        workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      },
      preferences: {
        language: 'pt-BR',
        verbosity: 'normal',
        autoLearn: true,
        notifyChanges: true,
        maxContextFiles: 20,
        preferredFrameworks: [],
      },
      knownProjects: [],
    });
  }
  
  await dbInstance.write();
  
  return dbInstance;
}

export function getDb(): Low<DbSchema> {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return dbInstance;
}

// Identity operations
export async function getIdentity() {
  const db = getDb();
  const identity = db.data.agent_identity.identity;
  if (identity) {
    return JSON.parse(identity.value);
  }
  return null;
}

export async function saveIdentity(identity: unknown) {
  const db = getDb();
  db.data.agent_identity.identity = {
    value: JSON.stringify(identity),
    updated_at: Date.now(),
  };
  await db.write();
}

// Project operations
export async function saveProject(project: ProjectRecord) {
  const db = getDb();
  const existingIndex = db.data.projects.findIndex(p => p.id === project.id);
  if (existingIndex >= 0) {
    db.data.projects[existingIndex] = project;
  } else {
    db.data.projects.push(project);
  }
  await db.write();
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = getDb();
  return db.data.projects.find(p => p.id === id) || null;
}

export async function getAllProjects(): Promise<ProjectRecord[]> {
  const db = getDb();
  return [...db.data.projects].sort((a, b) => b.last_scanned - a.last_scanned);
}

export async function deleteProject(id: string) {
  const db = getDb();
  db.data.projects = db.data.projects.filter(p => p.id !== id);
  db.data.project_files = db.data.project_files.filter(f => f.project_id !== id);
  await db.write();
}

// Project files operations
export async function saveProjectFiles(projectId: string, files: ProjectFileRecord[]) {
  const db = getDb();
  // Remove existing files for this project
  db.data.project_files = db.data.project_files.filter(f => f.project_id !== projectId);
  // Add new files
  db.data.project_files.push(...files);
  await db.write();
}

export async function getProjectFiles(projectId: string, category?: string, importance?: string): Promise<ProjectFileRecord[]> {
  const db = getDb();
  let files = db.data.project_files.filter(f => f.project_id === projectId);
  
  if (category) {
    files = files.filter(f => f.category === category);
  }
  if (importance) {
    files = files.filter(f => f.importance === importance);
  }
  
  // Sort by importance, then category, then path
  const importanceOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, ignore: 4 };
  files.sort((a, b) => {
    const impDiff = (importanceOrder[a.importance] || 99) - (importanceOrder[b.importance] || 99);
    if (impDiff !== 0) return impDiff;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.relative_path.localeCompare(b.relative_path);
  });
  
  return files;
}

// Patterns
export async function getPatterns(): Promise<PatternRecord[]> {
  const db = getDb();
  return [...db.data.learned_patterns].sort((a, b) => b.frequency - a.frequency);
}

export async function savePattern(pattern: PatternRecord) {
  const db = getDb();
  const existingIndex = db.data.learned_patterns.findIndex(p => p.id === pattern.id);
  if (existingIndex >= 0) {
    db.data.learned_patterns[existingIndex] = pattern;
  } else {
    db.data.learned_patterns.push(pattern);
  }
  await db.write();
}

// Conventions
export async function getConventions(): Promise<ConventionRecord[]> {
  const db = getDb();
  return [...db.data.conventions].sort((a, b) => {
    const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
    return (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99);
  });
}

export async function saveConvention(convention: ConventionRecord) {
  const db = getDb();
  const existingIndex = db.data.conventions.findIndex(c => c.id === convention.id);
  if (existingIndex >= 0) {
    db.data.conventions[existingIndex] = convention;
  } else {
    db.data.conventions.push(convention);
  }
  await db.write();
}

// Architectures
export async function getArchitectures(): Promise<ArchitectureRecord[]> {
  const db = getDb();
  return [...db.data.architecture_patterns].sort((a, b) => b.confidence - a.confidence);
}

export async function saveArchitecture(arch: ArchitectureRecord) {
  const db = getDb();
  const existingIndex = db.data.architecture_patterns.findIndex(a => a.id === arch.id);
  if (existingIndex >= 0) {
    db.data.architecture_patterns[existingIndex] = arch;
  } else {
    db.data.architecture_patterns.push(arch);
  }
  await db.write();
}

// Workflows
export async function getWorkflows(): Promise<WorkflowRecord[]> {
  const db = getDb();
  return [...db.data.workflows].sort((a, b) => b.frequency - a.frequency);
}

export async function saveWorkflow(workflow: WorkflowRecord) {
  const db = getDb();
  const existingIndex = db.data.workflows.findIndex(w => w.id === workflow.id);
  if (existingIndex >= 0) {
    db.data.workflows[existingIndex] = workflow;
  } else {
    db.data.workflows.push(workflow);
  }
  await db.write();
}

// Team members
export async function getTeamMembers(): Promise<TeamMemberRecord[]> {
  const db = getDb();
  return db.data.team_members;
}

export async function saveTeamMember(member: TeamMemberRecord) {
  const db = getDb();
  const existingIndex = db.data.team_members.findIndex(m => m.id === member.id);
  if (existingIndex >= 0) {
    db.data.team_members[existingIndex] = member;
  } else {
    db.data.team_members.push(member);
  }
  await db.write();
}

// Decisions
export async function getDecisions(): Promise<DecisionRecord[]> {
  const db = getDb();
  return [...db.data.decisions].sort((a, b) => b.date - a.date);
}

export async function saveDecision(decision: DecisionRecord) {
  const db = getDb();
  const existingIndex = db.data.decisions.findIndex(d => d.id === decision.id);
  if (existingIndex >= 0) {
    db.data.decisions[existingIndex] = decision;
  } else {
    db.data.decisions.push(decision);
  }
  await db.write();
}

// Issues
export async function getIssues(): Promise<IssueRecord[]> {
  const db = getDb();
  return [...db.data.known_issues].sort((a, b) => {
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sevDiff = (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99);
    if (sevDiff !== 0) return sevDiff;
    return b.last_occurrence - a.last_occurrence;
  });
}

export async function saveIssue(issue: IssueRecord) {
  const db = getDb();
  const existingIndex = db.data.known_issues.findIndex(i => i.id === issue.id);
  if (existingIndex >= 0) {
    db.data.known_issues[existingIndex] = issue;
  } else {
    db.data.known_issues.push(issue);
  }
  await db.write();
}

// Sessions
export async function createSession(session: SessionRecord) {
  const db = getDb();
  db.data.sessions.push(session);
  await db.write();
}

export async function endSession(sessionId: string) {
  const db = getDb();
  const session = db.data.sessions.find(s => s.id === sessionId);
  if (session) {
    session.ended_at = Date.now();
    await db.write();
  }
}

// Messages
export async function saveMessage(message: MessageRecord) {
  const db = getDb();
  db.data.messages.push(message);
  // Keep only last 1000 messages
  if (db.data.messages.length > 1000) {
    db.data.messages = db.data.messages.slice(-1000);
  }
  await db.write();
}

export async function getSessionMessages(sessionId: string, limit = 50): Promise<MessageRecord[]> {
  const db = getDb();
  return db.data.messages
    .filter(m => m.session_id === sessionId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

// Scan history
export async function saveScanHistory(record: ScanHistoryRecord) {
  const db = getDb();
  db.data.scan_history.push(record);
  await db.write();
}

export async function getScanHistory(projectId: string, limit = 10): Promise<ScanHistoryRecord[]> {
  const db = getDb();
  return db.data.scan_history
    .filter(s => s.project_id === projectId)
    .sort((a, b) => b.scanned_at - a.scanned_at)
    .slice(0, limit);
}

export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.write();
    dbInstance = null;
  }
}

// Initialize immediately
await initializeDatabase();