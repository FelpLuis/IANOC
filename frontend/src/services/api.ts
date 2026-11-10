import type {
  ProjectInfo,
  FileInfo,
  ChatRequest,
  ChatResponse,
  AgentMemory,
  ScanResult,
  AgentAction,
} from '../types';

const API_BASE = '/api';

class ApiService {
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }
    
    return response.json();
  }

  // Health check
  async health(): Promise<{ status: string }> {
    return this.request('/health');
  }

  // Memory
  async getMemory(): Promise<AgentMemory> {
    return this.request('/agent/memory');
  }

  // Projects
  async getProjects(): Promise<ProjectInfo[]> {
    return this.request('/agent/projects');
  }

  async getProject(id: string): Promise<ProjectInfo> {
    return this.request(`/agent/projects/${id}`);
  }

  async getProjectFiles(projectId: string, category?: string, importance?: string): Promise<FileInfo[]> {
    const params = new URLSearchParams();
    if (category) params.append('category', category);
    if (importance) params.append('importance', importance);
    return this.request(`/agent/projects/${projectId}/files?${params}`);
  }

  // Chat
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.request('/agent/chat', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  // Scan
  async scanProject(path: string, name?: string): Promise<ScanResult> {
    return this.request('/agent/scan', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    });
  }

  // Preferences
  async updatePreferences(preferences: Record<string, unknown>): Promise<{ success: boolean }> {
    return this.request('/agent/preferences', {
      method: 'POST',
      body: JSON.stringify(preferences),
    });
  }

  // Profile
  async updateProfile(profile: Record<string, unknown>): Promise<{ success: boolean }> {
    return this.request('/agent/profile', {
      method: 'POST',
      body: JSON.stringify(profile),
    });
  }

  // Actions
  async executeAction(action: AgentAction): Promise<{ success: boolean; result: unknown }> {
    return this.request('/agent/actions/execute', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  }
}

export const api = new ApiService();