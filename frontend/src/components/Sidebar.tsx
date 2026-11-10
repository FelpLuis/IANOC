'use client';

import { useState } from 'react';
import { 
  Folder, 
  FileCode, 
  Settings, 
  Brain, 
  Search, 
  Plus, 
  RefreshCw,
  Database,
  Terminal,
  Globe,
  BookOpen,
  Cog,
  HelpCircle,
  Zap,
  Sparkles,
  Layout,
  Gem,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { cn, formatRelativeTime, formatFileSize, truncate, getImportanceColor, getCategoryColor } from '../utils/helpers';
import type { ProjectInfo, FileInfo } from '../types';

interface SidebarProps {
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  projectFiles: FileInfo[];
  isLoading: boolean;
  onSwitchProject: (id: string) => void;
  onScanProject: () => void;
  onRefreshProject: (id: string) => void;
  onRemoveProject: (id: string) => void;
}

export function Sidebar({
  projects,
  currentProject,
  projectFiles,
  isLoading,
  onSwitchProject,
  onScanProject,
  onRefreshProject,
  onRemoveProject,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'projects' | 'files' | 'knowledge' | 'settings'>('projects');

  const filteredProjects = projects.filter(p => 
    p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredFiles = projectFiles.filter(f => 
    f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    f.relativePath.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Render file list separately to avoid JSX parsing issues
  const renderFileList = () => {
    const nonDirFiles = filteredFiles.filter(f => !f.isDirectory);
    if (nonDirFiles.length === 0) {
      return (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          <FileCode className="w-12 h-12 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Nenhum arquivo encontrado</p>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        {nonDirFiles.slice(0, 50).map(file => (
          <div
            key={file.relativePath}
            className="px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 group"
          >
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-gray-400" />
              <span className="text-sm truncate flex-1">{truncate(file.relativePath, 40)}</span>
            </div>
            <div className="flex items-center gap-2 ml-6 text-xs text-gray-500 dark:text-gray-400">
              <span className={cn('px-1.5 py-0.5 rounded', getImportanceColor(file.importance))}>
                {file.importance}
              </span>
              <span className={cn('px-1.5 py-0.5 rounded', getCategoryColor(file.category))}>
                {file.category}
              </span>
              <span>{formatFileSize(file.size)}</span>
            </div>
          </div>
        ))}
        {nonDirFiles.length > 50 && (
          <div className="text-center text-xs text-gray-500 pt-2">
            Mostrando 50 de {nonDirFiles.length} arquivos
          </div>
        )}
      </div>
    );
  };

  const getProjectIcon = (type: string) => {
    const icons: Record<string, React.ReactNode> = {
      nodejs: <Terminal className="w-4 h-4" />,
      python: <Terminal className="w-4 h-4" />,
      rust: <Cog className="w-4 h-4" />,
      go: <Zap className="w-4 h-4" />,
      java: <Database className="w-4 h-4" />,
      dotnet: <Globe className="w-4 h-4" />,
      php: <Globe className="w-4 h-4" />,
      ruby: <Gem className="w-4 h-4" />,
      frontend: <Layout className="w-4 h-4" />,
      mobile: <Smartphone className="w-4 h-4" />,
      docs: <BookOpen className="w-4 h-4" />,
      config: <Cog className="w-4 h-4" />,
      unknown: <HelpCircle className="w-4 h-4" />,
    };
    return icons[type] || icons.unknown;
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-dark-900 border-r border-gray-200 dark:border-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <span className="font-semibold text-gray-900 dark:text-gray-100">IA NOC</span>
        </div>
        <button
          onClick={onScanProject}
          disabled={isLoading}
          className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          title="Escanear novo projeto"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-800 px-2">
        {[
          { id: 'projects', label: 'Projetos', icon: Folder, count: projects.length },
          { id: 'files', label: 'Arquivos', icon: FileCode, count: projectFiles.filter(f => !f.isDirectory).length },
          { id: 'knowledge', label: 'Conhecimento', icon: Brain, count: 0 },
          { id: 'settings', label: 'Config', icon: Settings, count: 0 },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors',
              activeTab === tab.id
                ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20 border-b-2 border-primary-600'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
            {tab.count > 0 && (
              <span className="w-5 h-5 rounded-full bg-gray-200 dark:bg-gray-700 text-xs flex items-center justify-center">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="p-3 border-b border-gray-200 dark:border-gray-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={`Buscar ${activeTab === 'projects' ? 'projetos' : activeTab === 'files' ? 'arquivos' : 'conhecimento'}...`}
            className="input pl-10 text-sm"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {activeTab === 'projects' && (
          <div className="p-3 space-y-1">
            {filteredProjects.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <Folder className="w-12 h-12 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Nenhum projeto encontrado</p>
                <button
                  onClick={onScanProject}
                  className="mt-2 text-xs text-primary-600 hover:underline"
                >
                  Escanear primeiro projeto
                </button>
              </div>
            ) : (
              filteredProjects.map(project => (
                <div
                  key={project.id}
                  className={cn(
                    'group relative overflow-hidden',
                    currentProject?.id === project.id && 'bg-primary-50 dark:bg-primary-900/20'
                  )}
                >
                  <button
                    onClick={() => onSwitchProject(project.id)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                      currentProject?.id === project.id
                        ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                    )}
                  >
                    <div className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                      currentProject?.id === project.id
                        ? 'bg-primary-200 dark:bg-primary-800'
                        : 'bg-gray-100 dark:bg-gray-800'
                    )}>
                      {getProjectIcon(project.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{project.name}</span>
                        {project.framework && (
                          <span className="px-1.5 py-0.5 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                            {project.framework}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span className="truncate flex-1">{project.path}</span>
                        <span>{formatRelativeTime(project.lastScanned)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); onRefreshProject(project.id); }}
                        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                        title="Atualizar"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); onRemoveProject(project.id); }}
                        className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500"
                        title="Remover"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'files' && currentProject && (
          <div className="p-3 space-y-1">
            {renderFileList()}
          </div>
        )}

        {activeTab === 'knowledge' && (
          <div className="p-3 space-y-4">
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              <Brain className="w-12 h-12 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Conhecimento aprendido</p>
              <p className="text-xs mt-1">Padrões, convenções e arquiteturas detectadas</p>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-3 space-y-4">
            <div>
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Preferências</h3>
              <div className="space-y-3">
                <label className="flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-300">Auto-aprendizado</span>
                  <input type="checkbox" className="rounded border-gray-300 text-primary-600" defaultChecked />
                </label>
                <label className="flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-300">Notificar mudanças</span>
                  <input type="checkbox" className="rounded border-gray-300 text-primary-600" defaultChecked />
                </label>
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Idioma</h3>
              <select className="input text-sm">
                <option value="pt-BR">Português (BR)</option>
                <option value="en-US">English (US)</option>
              </select>
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Verbosidade</h3>
              <select className="input text-sm">
                <option value="concise">Conciso</option>
                <option value="normal" selected>Normal</option>
                <option value="detailed">Detalhado</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span className={cn('w-2 h-2 rounded-full', isLoading ? 'bg-yellow-500 animate-pulse' : 'bg-green-500')} />
          <span>{isLoading ? 'Conectando...' : 'Conectado'}</span>
        </div>
      </div>
    </div>
  );
}