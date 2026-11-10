import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return 'agora mesmo';
  if (minutes < 60) return `${minutes} min atrás`;
  if (hours < 24) return `${hours}h atrás`;
  if (days < 7) return `${days}d atrás`;
  
  return formatDate(timestamp);
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function getFileIcon(extension: string, category: string): string {
  const icons: Record<string, string> = {
    // Code
    ts: 'file-code',
    tsx: 'file-code',
    js: 'file-code',
    jsx: 'file-code',
    py: 'file-code',
    rs: 'file-code',
    go: 'file-code',
    java: 'file-code',
    cs: 'file-code',
    cpp: 'file-code',
    c: 'file-code',
    php: 'file-code',
    rb: 'file-code',
    swift: 'file-code',
    kt: 'file-code',
    
    // Config
    json: 'file-json',
    yaml: 'file-cog',
    yml: 'file-cog',
    toml: 'file-cog',
    xml: 'file-cog',
    ini: 'file-cog',
    config: 'file-cog',
    
    // Docs
    md: 'file-text',
    mdx: 'file-text',
    txt: 'file-text',
    rst: 'file-text',
    
    // Styles
    css: 'file-code',
    scss: 'file-code',
    sass: 'file-code',
    less: 'file-code',
    
    // Data
    csv: 'file-spreadsheet',
    sql: 'database',
    
    // Images
    png: 'file-image',
    jpg: 'file-image',
    jpeg: 'file-image',
    gif: 'file-image',
    svg: 'file-image',
    webp: 'file-image',
    ico: 'file-image',
    
    // Archives
    zip: 'file-archive',
    tar: 'file-archive',
    gz: 'file-archive',
    
    // Other
    dockerfile: 'docker',
    gitignore: 'git-branch',
    env: 'key',
  };
  
  return icons[extension.toLowerCase()] || icons[category] || 'file';
}

export function getImportanceColor(importance: string): string {
  const colors: Record<string, string> = {
    critical: 'text-red-600 bg-red-100 dark:bg-red-900/30 dark:text-red-400',
    high: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30 dark:text-orange-400',
    medium: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400',
    low: 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-400',
    ignore: 'text-gray-400 bg-gray-100 dark:bg-gray-800 dark:text-gray-500',
  };
  return colors[importance] || colors.low;
}

export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    source: 'text-green-600 bg-green-100 dark:bg-green-900/30 dark:text-green-400',
    test: 'text-purple-600 bg-purple-100 dark:bg-purple-900/30 dark:text-purple-400',
    config: 'text-blue-600 bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400',
    documentation: 'text-indigo-600 bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-400',
    asset: 'text-pink-600 bg-pink-100 dark:bg-pink-900/30 dark:text-pink-400',
    build: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400',
    dependency: 'text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-400',
    ignore: 'text-gray-400 bg-gray-100 dark:bg-gray-800 dark:text-gray-500',
  };
  return colors[category] || colors.ignore;
}

export function getProjectTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    nodejs: 'server',
    python: 'terminal',
    rust: 'cog',
    go: 'zap',
    java: 'coffee',
    dotnet: 'windows',
    php: 'globe',
    ruby: 'gem',
    frontend: 'layout',
    mobile: 'smartphone',
    docs: 'book-open',
    config: 'settings',
    unknown: 'help-circle',
  };
  return icons[type] || icons.unknown;
}

export function getProjectTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    nodejs: 'Node.js',
    python: 'Python',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    dotnet: '.NET',
    php: 'PHP',
    ruby: 'Ruby',
    frontend: 'Frontend',
    mobile: 'Mobile',
    docs: 'Documentação',
    config: 'Configuração',
    unknown: 'Desconhecido',
  };
  return labels[type] || type;
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export function downloadFile(content: string, filename: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}