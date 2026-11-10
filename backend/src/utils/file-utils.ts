/**
 * File system utilities for project scanning and analysis
 */

import { join, relative, extname, basename } from 'path';
import { statSync, readdirSync, readFileSync, existsSync } from 'fs';
import Ignore from 'ignore';

// Local type definitions to avoid import issues
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

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.vercel',
  '.netlify',
  '.github',
  '.vscode',
  '.idea',
  '.nx',
  '.angular',
  '.expo',
  '.svelte-kit',
  '.parcel-cache',
  '.pnpm-store',
  '.yarn',
  '.dart_tool',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'Pods',
  'target',
  'out',
  'obj',
  '.output',
  '*.log',
  '*.tmp',
  '*.temp',
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*.swo',
  '*.cache',
  '.parcel-cache',
  '.eslintcache',
  '.stylelintcache',
  '*.tsbuildinfo',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  '*.map',
  '*.min.js',
  '*.min.css',
];

const CATEGORY_PATTERNS: Record<FileCategory, RegExp[]> = {
  source: [/\.(ts|tsx|js|jsx|py|rs|go|java|kt|swift|php|rb|cs|cpp|c|h|hpp)$/],
  test: [/\.(test|spec)\.(ts|tsx|js|jsx|py|rs|go|java|kt|swift|php|rb|cs)$/, /^test\/.*/, /^tests\/.*/, /^__tests__\/.*/, /^spec\/.*/],
  config: [/^(package\.json|tsconfig\.json|webpack\.config|vite\.config|rollup\.config|babel\.config|eslint|prettier|jest\.config|vitest\.config|\.env|\.gitignore|dockerfile|docker-compose|\.github\/workflows\/.*)$/i],
  documentation: [/\.(md|mdx|txt|rst|adoc)$/i, /^(readme|changelog|contributing|license|code_of_conduct)$/i],
  asset: [/\.(png|jpg|jpeg|gif|svg|ico|webp|avif|woff|woff2|ttf|eot|mp4|webm|ogg|mp3|wav)$/i],
  build: [/^(dist|build|out|target|bin|obj|\.output)\/.*/],
  dependency: [/^(node_modules|vendor|packages|Pods|Carthage|.venv|venv|env)\/.*/],
  ignore: [],
};

const IMPORTANCE_PATTERNS: Record<ImportanceLevel, RegExp[]> = {
  critical: [/^(package\.json|tsconfig\.json|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|requirements\.txt|pyproject\.toml|setup\.py|Dockerfile|docker-compose\.yml|\.github\/workflows\/.*)$/i],
  high: [/\.(ts|tsx|js|jsx|py|rs|go|java|kt|swift|php|rb|cs)$/, /^(README|CHANGELOG|CONTRIBUTING|LICENSE|ARCHITECTURE|DESIGN)/i],
  medium: [/\.(json|yaml|yml|toml|ini|conf|config)$/, /\.(css|scss|sass|less)$/, /\.d\.ts$/],
  low: [/\.(md|txt|rst|adoc)$/, /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2)$/],
  ignore: [],
};

export function createIgnoreFilter(config: ProjectConfig): (path: string) => boolean {
  const ig = Ignore();
  ig.add(DEFAULT_IGNORE_PATTERNS);
  ig.add(config.ignorePatterns);
  
  return (filePath: string) => !ig.ignores(filePath);
}

export function categorizeFile(filePath: string, relativePath: string): FileCategory {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(filePath) || pattern.test(relativePath)) {
        return category as FileCategory;
      }
    }
  }
  return 'ignore';
}

export function determineImportance(filePath: string, relativePath: string, category: FileCategory): ImportanceLevel {
  for (const [importance, patterns] of Object.entries(IMPORTANCE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(filePath) || pattern.test(relativePath)) {
        return importance as ImportanceLevel;
      }
    }
  }
  
  if (category === 'source') return 'high';
  if (category === 'test') return 'high';
  if (category === 'config') return 'high';
  if (category === 'documentation') return 'medium';
  
  return 'low';
}

export function shouldReadContent(fileInfo: FileInfo, maxSize: number): boolean {
  if (fileInfo.isDirectory) return false;
  if (fileInfo.size > maxSize) return false;
  if (fileInfo.category === 'asset' || fileInfo.category === 'build' || fileInfo.category === 'dependency') return false;
  if (fileInfo.importance === 'ignore') return false;
  return true;
}

export function readFileContent(filePath: string, maxSize: number): string | null {
  try {
    const stats = statSync(filePath);
    if (stats.size > maxSize) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function getFileHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

export function scanDirectory(
  rootPath: string, 
  config: ProjectConfig,
  filter: (path: string) => boolean
): FileInfo[] {
  const files: FileInfo[] = [];
  const maxSize = config.maxFileSize * 1024 * 1024;
  const maxFiles = config.maxFiles || 500;
  const startTime = Date.now();
  const timeout = config.scanTimeoutMs || 120000;

  function walk(dir: string): void {
    // Check timeout
    if (Date.now() - startTime > timeout) {
      console.warn(`Scan timeout after ${timeout}ms`);
      return;
    }
    // Check file limit
    if (files.length >= maxFiles) {
      console.warn(`Max files limit (${maxFiles}) reached`);
      return;
    }
    
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        // Check limits before processing each entry
        if (files.length >= maxFiles || Date.now() - startTime > timeout) return;
        
        const fullPath = join(dir, entry.name);
        const relPath = relative(rootPath, fullPath);
        
        if (!filter(relPath)) continue;
        
        const stats = statSync(fullPath);
        const extension = extname(entry.name).toLowerCase();
        const category = categorizeFile(entry.name, relPath);
        const importance = determineImportance(entry.name, relPath, category);
        
        const fileInfo: FileInfo = {
          path: fullPath,
          relativePath: relPath,
          name: entry.name,
          extension,
          size: stats.size,
          isDirectory: entry.isDirectory(),
          lastModified: stats.mtimeMs,
          category,
          importance,
        };

        if (!entry.isDirectory() && shouldReadContent(fileInfo, maxSize)) {
          const content = readFileContent(fullPath, maxSize);
          if (content) {
            fileInfo.content = content;
            fileInfo.hash = getFileHash(content);
          }
        }

        files.push(fileInfo);
        
        if (entry.isDirectory()) {
          walk(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Error scanning ${dir}:`, error);
    }
  }

  walk(rootPath);
  return files;
}

export function detectProjectType(files: FileInfo[]): { type: string; language?: string; framework?: string; packageManager?: string } {
  const fileNames = files.map(f => f.name.toLowerCase());
  const extensions = files.map(f => f.extension).filter(Boolean);
  
  // Node.js
  if (fileNames.includes('package.json')) {
    const pkgFile = files.find(f => f.name === 'package.json');
    let framework: string | undefined;
    let packageManager = 'npm';
    
    if (pkgFile?.content) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        if (deps.next) framework = 'Next.js';
        else if (deps.nuxt) framework = 'Nuxt.js';
        else if (deps.react || deps['react-dom']) framework = 'React';
        else if (deps.vue) framework = 'Vue';
        else if (deps.svelte) framework = 'Svelte';
        else if (deps.angular || deps['@angular/core']) framework = 'Angular';
        else if (deps.express) framework = 'Express';
        else if (deps.fastify) framework = 'Fastify';
        else if (deps.nestjs || deps['@nestjs/core']) framework = 'NestJS';
        else if (deps.vite) framework = 'Vite';
        else if (deps.astro) framework = 'Astro';
        else if (deps.remix || deps['@remix-run/node']) framework = 'Remix';
        
        if (fileNames.includes('pnpm-lock.yaml')) packageManager = 'pnpm';
        else if (fileNames.includes('yarn.lock')) packageManager = 'yarn';
        else if (fileNames.includes('bun.lockb')) packageManager = 'bun';
      } catch {}
    }
    
    return { type: 'nodejs', language: 'typescript', framework, packageManager };
  }
  
  // Python
  if (fileNames.some(f => ['requirements.txt', 'pyproject.toml', 'setup.py', 'poetry.lock', 'pipfile'].includes(f))) {
    let framework: string | undefined;
    for (const f of files) {
      if (f.content) {
        const content = f.content.toLowerCase();
        if (content.includes('django')) framework = 'Django';
        else if (content.includes('flask')) framework = 'Flask';
        else if (content.includes('fastapi')) framework = 'FastAPI';
        else if (content.includes('starlette')) framework = 'Starlette';
        else if (content.includes('tornado')) framework = 'Tornado';
      }
    }
    return { type: 'python', language: 'python', framework };
  }
  
  // Rust
  if (fileNames.includes('cargo.toml')) {
    return { type: 'rust', language: 'rust' };
  }
  
  // Go
  if (fileNames.includes('go.mod')) {
    return { type: 'go', language: 'go' };
  }
  
  // Java
  if (fileNames.some(f => ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'].includes(f))) {
    return { type: 'java', language: 'java' };
  }
  
  // .NET
  if (extensions.some(e => ['.csproj', '.sln', '.fsproj', '.vbproj'].includes(e))) {
    return { type: 'dotnet', language: 'csharp' };
  }
  
  // PHP
  if (fileNames.includes('composer.json')) {
    let framework: string | undefined;
    const composerFile = files.find(f => f.name === 'composer.json');
    if (composerFile?.content) {
      try {
        const composer = JSON.parse(composerFile.content);
        const deps = { ...composer.require, ...composer['require-dev'] };
        if (deps['laravel/framework']) framework = 'Laravel';
        else if (deps['symfony/symfony']) framework = 'Symfony';
        else if (deps['symfony/*']) framework = 'Symfony';
      } catch {}
    }
    return { type: 'php', language: 'php', framework };
  }
  
  // Ruby
  if (fileNames.includes('gemfile') || fileNames.includes('gemfile.lock')) {
    return { type: 'ruby', language: 'ruby' };
  }
  
  // Frontend only
  if (extensions.some(e => ['.html', '.css', '.scss', '.sass', '.less'].includes(e))) {
    if (!fileNames.includes('package.json')) {
      return { type: 'frontend', language: 'html' };
    }
  }
  
  return { type: 'unknown' };
}