/**
 * Hybrid Memory System for IA NOC Agent
 * Persistent identity + learned knowledge + session context
 * Uses LowDB (JSON file-based) for storage
 */

import { 
  getIdentity, 
  saveIdentity, 
  saveProject, 
  getProject, 
  getAllProjects, 
  deleteProject,
  saveProjectFiles,
  getProjectFiles,
  getPatterns,
  savePattern,
  getConventions,
  saveConvention,
  getArchitectures,
  saveArchitecture,
  getWorkflows,
  saveWorkflow,
  getTeamMembers,
  saveTeamMember,
  getDecisions,
  saveDecision,
  getIssues,
  saveIssue,
  createSession,
  endSession,
  saveMessage,
  getSessionMessages,
  saveScanHistory,
  getScanHistory,
} from '../utils/database.js';
import { randomUUID as uuidv4 } from 'node:crypto';
import {
  AgentMemory,
  AgentIdentity,
  UserProfile,
  AgentPreferences,
  LearnedKnowledge,
  SessionContext,
  Message,
  WorkingMemoryItem,
  ProjectInfo,
  CodePattern,
  Convention,
  ArchitecturePattern,
  WorkflowPattern,
  TeamMember,
  Decision,
  KnownIssue,
  UserIntent,
  FileInfo,
} from '../shared/types.js';

const DEFAULT_IDENTITY: AgentIdentity = {
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
};

export class MemoryManager {
  private static instance: MemoryManager;
  private currentSession: SessionContext | null = null;

  private constructor() {}

  static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  // ============ Identity (Persistent) ============
  
  async getIdentity(): Promise<AgentIdentity> {
    const identity = await getIdentity();
    if (identity) {
      return identity;
    }
    await this.saveIdentity(DEFAULT_IDENTITY);
    return DEFAULT_IDENTITY;
  }

  async saveIdentity(identity: AgentIdentity): Promise<void> {
    identity.updatedAt = Date.now();
    await saveIdentity(identity);
  }

  async updateUserProfile(profile: Partial<UserProfile>): Promise<void> {
    const identity = await this.getIdentity();
    identity.userProfile = { ...identity.userProfile, ...profile };
    await this.saveIdentity(identity);
  }

  async updatePreferences(prefs: Partial<AgentPreferences>): Promise<void> {
    const identity = await this.getIdentity();
    identity.preferences = { ...identity.preferences, ...prefs };
    await this.saveIdentity(identity);
  }

  async addKnownProject(projectId: string): Promise<void> {
    const identity = await this.getIdentity();
    if (!identity.knownProjects.includes(projectId)) {
      identity.knownProjects.push(projectId);
      await this.saveIdentity(identity);
    }
  }

  // ============ Learned Knowledge (Persistent) ============

  async getKnowledge(): Promise<LearnedKnowledge> {
    const [patterns, conventions, architectures, workflows, teamMembers, decisions, issues] = await Promise.all([
      this.getPatterns(),
      this.getConventions(),
      this.getArchitectures(),
      this.getWorkflows(),
      this.getTeamMembers(),
      this.getDecisions(),
      this.getIssues(),
    ]);
    return { patterns, conventions, architectures, workflows, teamMembers, decisions, issues };
  }

  // Patterns
  async getPatterns(): Promise<CodePattern[]> {
    const records = await getPatterns();
    return records.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      language: r.language || '',
      pattern: r.pattern,
      examples: JSON.parse(r.examples),
      frequency: r.frequency,
      projects: JSON.parse(r.projects),
      lastSeen: r.last_seen,
    }));
  }

  async savePattern(pattern: CodePattern): Promise<void> {
    const record = {
      id: pattern.id,
      name: pattern.name,
      description: pattern.description,
      language: pattern.language,
      pattern: pattern.pattern,
      examples: JSON.stringify(pattern.examples),
      frequency: pattern.frequency,
      projects: JSON.stringify(pattern.projects),
      last_seen: pattern.lastSeen,
      created_at: Date.now(),
    };
    await savePattern(record);
  }

  // Conventions
  async getConventions(): Promise<Convention[]> {
    const records = await getConventions();
    return records.map(r => ({
      id: r.id,
      type: r.type as Convention['type'],
      rule: r.rule,
      rationale: r.rationale || undefined,
      examples: JSON.parse(r.examples),
      severity: r.severity as Convention['severity'],
      projects: JSON.parse(r.projects),
      autoDetected: r.auto_detected === 1,
    }));
  }

  async saveConvention(convention: Convention): Promise<void> {
    const record = {
      id: convention.id,
      type: convention.type,
      rule: convention.rule,
      rationale: convention.rationale || null,
      examples: JSON.stringify(convention.examples),
      severity: convention.severity,
      projects: JSON.stringify(convention.projects),
      auto_detected: convention.autoDetected ? 1 : 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await saveConvention(record);
  }

  // Architectures
  async getArchitectures(): Promise<ArchitecturePattern[]> {
    const records = await getArchitectures();
    return records.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      layers: JSON.parse(r.layers),
      components: JSON.parse(r.components),
      dataFlow: r.data_flow || '',
      projects: JSON.parse(r.projects),
      confidence: r.confidence,
    }));
  }

  async saveArchitecture(arch: ArchitecturePattern): Promise<void> {
    const record = {
      id: arch.id,
      name: arch.name,
      description: arch.description,
      layers: JSON.stringify(arch.layers),
      components: JSON.stringify(arch.components),
      data_flow: arch.dataFlow,
      projects: JSON.stringify(arch.projects),
      confidence: arch.confidence,
      created_at: Date.now(),
    };
    await saveArchitecture(record);
  }

  // Workflows
  async getWorkflows(): Promise<WorkflowPattern[]> {
    const records = await getWorkflows();
    return records.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      steps: JSON.parse(r.steps),
      triggers: JSON.parse(r.triggers || '[]'),
      tools: JSON.parse(r.tools || '[]'),
      frequency: r.frequency,
      projects: JSON.parse(r.projects),
    }));
  }

  async saveWorkflow(workflow: WorkflowPattern): Promise<void> {
    const record = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      steps: JSON.stringify(workflow.steps),
      triggers: JSON.stringify(workflow.triggers),
      tools: JSON.stringify(workflow.tools),
      frequency: workflow.frequency,
      projects: JSON.stringify(workflow.projects),
      created_at: Date.now(),
    };
    await saveWorkflow(record);
  }

  // Team Members
  async getTeamMembers(): Promise<TeamMember[]> {
    const records = await getTeamMembers();
    return records.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email || undefined,
      role: r.role || '',
      expertise: JSON.parse(r.expertise),
      projects: JSON.parse(r.projects),
      commitPatterns: JSON.parse(r.commit_patterns),
      communicationStyle: r.communication_style || undefined,
    }));
  }

  async saveTeamMember(member: TeamMember): Promise<void> {
    const record = {
      id: member.id,
      name: member.name,
      email: member.email || null,
      role: member.role,
      expertise: JSON.stringify(member.expertise),
      projects: JSON.stringify(member.projects),
      commit_patterns: JSON.stringify(member.commitPatterns),
      communication_style: member.communicationStyle || null,
      created_at: Date.now(),
    };
    await saveTeamMember(record);
  }

  // Decisions
  async getDecisions(): Promise<Decision[]> {
    const records = await getDecisions();
    return records.map(r => ({
      id: r.id,
      title: r.title,
      context: r.context || '',
      decision: r.decision,
      rationale: r.rationale || '',
      alternatives: JSON.parse(r.alternatives),
      status: r.status as Decision['status'],
      date: r.date,
      author: r.author || undefined,
      projectId: r.project_id || undefined,
      tags: JSON.parse(r.tags),
    }));
  }

  async saveDecision(decision: Decision): Promise<void> {
    const record = {
      id: decision.id,
      title: decision.title,
      context: decision.context,
      decision: decision.decision,
      rationale: decision.rationale || null,
      alternatives: JSON.stringify(decision.alternatives),
      status: decision.status,
      date: decision.date,
      author: decision.author || null,
      project_id: decision.projectId || null,
      tags: JSON.stringify(decision.tags),
      created_at: Date.now(),
    };
    await saveDecision(record);
  }

  // Issues
  async getIssues(): Promise<KnownIssue[]> {
    const records = await getIssues();
    return records.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description || '',
      symptoms: JSON.parse(r.symptoms),
      causes: JSON.parse(r.causes),
      solutions: JSON.parse(r.solutions),
      frequency: r.frequency,
      severity: r.severity as KnownIssue['severity'],
      projectId: r.project_id || undefined,
      status: r.status as KnownIssue['status'],
      lastOccurrence: r.last_occurrence,
    }));
  }

  async saveIssue(issue: KnownIssue): Promise<void> {
    const record = {
      id: issue.id,
      title: issue.title,
      description: issue.description,
      symptoms: JSON.stringify(issue.symptoms),
      causes: JSON.stringify(issue.causes),
      solutions: JSON.stringify(issue.solutions),
      frequency: issue.frequency,
      severity: issue.severity,
      project_id: issue.projectId || null,
      status: issue.status,
      last_occurrence: issue.lastOccurrence,
      created_at: Date.now(),
    };
    await saveIssue(record);
  }

  // ============ Session Context (Temporary) ============

  async createSession(projectId?: string): Promise<SessionContext> {
    const sessionId = uuidv4();
    const session: SessionContext = {
      sessionId,
      startedAt: Date.now(),
      currentProject: projectId,
      activeFiles: [],
      conversationHistory: [],
      workingMemory: [],
    };
    this.currentSession = session;
    
    await createSession({
      id: sessionId,
      started_at: session.startedAt,
      ended_at: null,
      current_project: projectId || null,
      metadata: JSON.stringify({}),
    });
    
    return session;
  }

  getCurrentSession(): SessionContext | null {
    return this.currentSession;
  }

  async endSession(): Promise<void> {
    if (this.currentSession) {
      await endSession(this.currentSession.sessionId);
      this.currentSession = null;
    }
  }

  async addMessage(message: Omit<Message, 'id' | 'timestamp'>): Promise<Message> {
    const msg: Message = {
      ...message,
      id: uuidv4(),
      timestamp: Date.now(),
    };
    
    if (this.currentSession) {
      this.currentSession.conversationHistory.push(msg);
      if (this.currentSession.conversationHistory.length > 50) {
        this.currentSession.conversationHistory = this.currentSession.conversationHistory.slice(-50);
      }
    }
    
    await saveMessage({
      id: msg.id,
      session_id: this.currentSession?.sessionId || 'unknown',
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      metadata: JSON.stringify(msg.metadata || {}),
    });
    
    return msg;
  }

  async getSessionMessages(sessionId?: string, limit = 50): Promise<Message[]> {
    const id = sessionId || this.currentSession?.sessionId;
    if (!id) return [];
    
    const records = await getSessionMessages(id, limit);
    return records.map(r => ({
      id: r.id,
      role: r.role as Message['role'],
      content: r.content,
      timestamp: r.timestamp,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  setCurrentProject(projectId: string): void {
    if (this.currentSession) {
      this.currentSession.currentProject = projectId;
    }
  }

  addActiveFile(filePath: string): void {
    if (this.currentSession && !this.currentSession.activeFiles.includes(filePath)) {
      this.currentSession.activeFiles.push(filePath);
      if (this.currentSession.activeFiles.length > 20) {
        this.currentSession.activeFiles = this.currentSession.activeFiles.slice(-20);
      }
    }
  }

  setUserIntent(intent: UserIntent): void {
    if (this.currentSession) {
      this.currentSession.userIntent = intent;
    }
  }

  // Working Memory (short-term, session-scoped)
  setWorkingMemory(key: string, value: unknown, source: WorkingMemoryItem['source'] = 'agent', ttlMs = 3600000): void {
    if (this.currentSession) {
      const item: WorkingMemoryItem = {
        key,
        value,
        expiresAt: Date.now() + ttlMs,
        source,
      };
      this.currentSession.workingMemory = this.currentSession.workingMemory.filter(w => w.key !== key);
      this.currentSession.workingMemory.push(item);
    }
  }

  getWorkingMemory(key: string): unknown {
    if (!this.currentSession) return undefined;
    const item = this.currentSession.workingMemory.find(w => w.key === key);
    if (item && item.expiresAt > Date.now()) {
      return item.value;
    }
    if (item) {
      this.currentSession.workingMemory = this.currentSession.workingMemory.filter(w => w.key !== key);
    }
    return undefined;
  }

  clearExpiredWorkingMemory(): void {
    if (this.currentSession) {
      const now = Date.now();
      this.currentSession.workingMemory = this.currentSession.workingMemory.filter(w => w.expiresAt > now);
    }
  }

  // ============ Project Management ============

  async saveProject(project: ProjectInfo): Promise<void> {
    const record = {
      id: project.id,
      name: project.name,
      path: project.path,
      description: project.description || null,
      type: project.type,
      language: project.language || null,
      framework: project.framework || null,
      last_scanned: project.lastScanned,
      file_count: project.fileCount,
      size: project.size,
      metadata: JSON.stringify(project.metadata),
      created_at: project.lastScanned,
      updated_at: project.lastScanned,
    };
    await saveProject(record);
  }

  async getProject(id: string): Promise<ProjectInfo | null> {
    const record = await getProject(id);
    if (!record) return null;
    return {
      id: record.id,
      name: record.name,
      path: record.path,
      description: record.description || undefined,
      type: (record.type as ProjectInfo['type']) || 'unknown',
      language: record.language || undefined,
      framework: record.framework || undefined,
      lastScanned: record.last_scanned,
      fileCount: record.file_count,
      size: record.size,
      metadata: JSON.parse(record.metadata),
    };
  }

  async getAllProjects(): Promise<ProjectInfo[]> {
    const records = await getAllProjects();
    return records.map(r => ({
      id: r.id,
      name: r.name,
      path: r.path,
      description: r.description || undefined,
      type: (r.type as ProjectInfo['type']) || 'unknown',
      language: r.language || undefined,
      framework: r.framework || undefined,
      lastScanned: r.last_scanned,
      fileCount: r.file_count,
      size: r.size,
      metadata: JSON.parse(r.metadata),
    }));
  }

  async deleteProject(id: string): Promise<void> {
    await deleteProject(id);
    const identity = await this.getIdentity();
    identity.knownProjects = identity.knownProjects.filter(p => p !== id);
    await this.saveIdentity(identity);
  }

  // ============ Project Files ============

  async saveProjectFiles(projectId: string, files: FileInfo[]): Promise<void> {
    const records = files.map(f => ({
      id: uuidv4(),
      project_id: projectId,
      path: f.path,
      relative_path: f.relativePath,
      name: f.name,
      extension: f.extension,
      size: f.size,
      is_directory: f.isDirectory ? 1 : 0,
      hash: f.hash || null,
      last_modified: f.lastModified,
      category: f.category,
      importance: f.importance,
      content_hash: f.hash || null,
    }));
    await saveProjectFiles(projectId, records);
  }

  async getProjectFiles(projectId: string, category?: string, importance?: string): Promise<FileInfo[]> {
    const records = await getProjectFiles(projectId, category, importance);
    return records.map(r => ({
      path: r.path,
      relativePath: r.relative_path,
      name: r.name,
      extension: r.extension || '',
      size: r.size,
      isDirectory: r.is_directory === 1,
      hash: r.hash || undefined,
      lastModified: r.last_modified,
      category: r.category as FileInfo['category'],
      importance: r.importance as FileInfo['importance'],
    }));
  }

  // ============ Scan History ============

  async saveScanHistory(projectId: string, scannedAt: number, stats: unknown, changes?: unknown): Promise<void> {
    await saveScanHistory({
      id: uuidv4(),
      project_id: projectId,
      scanned_at: scannedAt,
      stats: JSON.stringify(stats),
      changes: changes ? JSON.stringify(changes) : null,
    });
  }

  async getScanHistory(projectId: string, limit = 10): Promise<unknown[]> {
    const records = await getScanHistory(projectId, limit);
    return records.map(r => ({
      ...r,
      stats: JSON.parse(r.stats),
      changes: r.changes ? JSON.parse(r.changes) : undefined,
    }));
  }

  // ============ Full Memory Export/Import ============

  async exportMemory(): Promise<AgentMemory> {
    const [identity, knowledge] = await Promise.all([
      this.getIdentity(),
      this.getKnowledge(),
    ]);
    return {
      identity,
      knowledge,
      session: this.currentSession || {
        sessionId: 'none',
        startedAt: Date.now(),
        activeFiles: [],
        conversationHistory: [],
        workingMemory: [],
      },
    };
  }

  async importMemory(memory: AgentMemory): Promise<void> {
    await this.saveIdentity(memory.identity);
    for (const p of memory.knowledge.patterns) await this.savePattern(p);
    for (const c of memory.knowledge.conventions) await this.saveConvention(c);
    for (const a of memory.knowledge.architectures) await this.saveArchitecture(a);
    for (const w of memory.knowledge.workflows) await this.saveWorkflow(w);
    for (const t of memory.knowledge.teamMembers) await this.saveTeamMember(t);
    for (const d of memory.knowledge.decisions) await this.saveDecision(d);
    for (const i of memory.knowledge.issues) await this.saveIssue(i);
  }
}

export const memory = MemoryManager.getInstance();