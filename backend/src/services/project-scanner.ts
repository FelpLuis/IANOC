/**
 * Project Scanner Service
 * Scans local filesystem projects and extracts knowledge
 */

import { join, resolve, isAbsolute, basename } from 'path';
import { statSync, readdirSync, existsSync } from 'fs';
import { randomUUID as uuidv4 } from 'node:crypto';
import { scanDirectory, detectProjectType, createIgnoreFilter, ProjectConfig } from '../utils/file-utils.js';
import { memory } from '../memory/memory-manager.js';
import { ProjectInfo, FileInfo, ScanResult, ScanStats } from '../shared/types.js';

export class ProjectScanner {
  private config: ProjectConfig;
  private filter: (path: string) => boolean;

  constructor(config?: Partial<ProjectConfig>) {
    this.config = {
      // cwd is backend/, so the workspace root that holds all sibling projects
      // is three levels up (backend -> ianoc-agent -> IANOC -> projetoNOC).
      rootPath: resolve(process.env.PROJECTS_ROOT || join(process.cwd(), '..', '..', '..')),
      ignorePatterns: [],
      includePatterns: [],
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE_MB || '10'),
      maxFiles: parseInt(process.env.MAX_SCAN_FILES || '5000'),
      scanTimeoutMs: parseInt(process.env.SCAN_TIMEOUT_MS || '120000'),
      watchEnabled: true,
      autoScanInterval: parseInt(process.env.SCAN_INTERVAL_MINUTES || '30'),
      learningEnabled: true,
      ...config,
    };
    this.filter = createIgnoreFilter(this.config);
  }

  get rootPath(): string {
    return this.config.rootPath;
  }

  async scanProject(projectPath: string, projectName?: string): Promise<ScanResult> {
    const absolutePath = isAbsolute(projectPath)
      ? resolve(projectPath)
      : resolve(this.config.rootPath, projectPath);

    if (!existsSync(absolutePath)) {
      throw new Error(`Path does not exist: ${absolutePath}`);
    }

    const stats = statSync(absolutePath);

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${absolutePath}`);
    }

    // Reuse the id already stored for this path so re-scanning updates the
    // project instead of creating a duplicate entry every time.
    const existing = (await memory.getAllProjects()).find(p => p.path === projectPath);
    const projectId = existing?.id || uuidv4();
    const name = projectName || basename(absolutePath) || 'Unknown';

    console.log(`[Scanner] Scanning project: ${name} at ${absolutePath}`);
    
    const files = scanDirectory(absolutePath, this.config, this.filter);
    const { type, language, framework, packageManager } = detectProjectType(files);
    
    const scanStats = this.calculateStats(files);
    const projectInfo: ProjectInfo = {
      id: projectId,
      name,
      path: projectPath,
      type: type as ProjectInfo['type'],
      language,
      framework,
      lastScanned: Date.now(),
      fileCount: files.filter(f => !f.isDirectory).length,
      size: files.reduce((sum, f) => sum + f.size, 0),
      metadata: {
        packageManager,
        dockerfile: files.some(f => f.name.toLowerCase() === 'dockerfile'),
        readme: files.some(f => f.name.toLowerCase().startsWith('readme')),
      },
    };

    // Save project
    await memory.saveProject(projectInfo);
    await memory.addKnownProject(projectId);

    // Save files
    await memory.saveProjectFiles(projectId, files);

    // Save scan history
    await memory.saveScanHistory(projectId, Date.now(), scanStats);

    // Learn from project if enabled
    if (this.config.learningEnabled) {
      await this.learnFromProject(projectId, files);
    }

    return {
      projectId,
      scannedAt: Date.now(),
      files,
      stats: scanStats,
    };
  }

  /**
   * List the sibling directories under rootPath that look like projects.
   * Returns paths relative to rootPath, ready to hand to scanProject().
   */
  discoverProjects(): string[] {
    const found: string[] = [];

    let entries;
    try {
      entries = readdirSync(this.config.rootPath, { withFileTypes: true });
    } catch (error) {
      console.error(`[Scanner] Cannot read root ${this.config.rootPath}:`, error);
      return found;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (!this.filter(entry.name)) continue;
      found.push(entry.name);
    }

    return found;
  }

  async scanAllProjects(): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    const projects = this.discoverProjects();

    console.log(`[Scanner] Root: ${this.config.rootPath}`);
    console.log(`[Scanner] Discovered ${projects.length} project(s): ${projects.join(', ') || 'none'}`);

    for (const projectPath of projects) {
      try {
        results.push(await this.scanProject(projectPath));
      } catch (error) {
        console.error(`[Scanner] Error scanning ${projectPath}:`, error);
      }
    }

    return results;
  }

  private calculateStats(files: FileInfo[]): ScanStats {
    const byCategory: Record<string, number> = {};
    const byExtension: Record<string, number> = {};
    const byImportance: Record<string, number> = {};
    
    let newFiles = 0;
    let modifiedFiles = 0;
    
    for (const file of files) {
      if (!file.isDirectory) {
        byCategory[file.category] = (byCategory[file.category] || 0) + 1;
        if (file.extension) {
          byExtension[file.extension] = (byExtension[file.extension] || 0) + 1;
        }
        byImportance[file.importance] = (byImportance[file.importance] || 0) + 1;
      }
    }
    
    return {
      totalFiles: files.filter(f => !f.isDirectory).length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      byCategory: byCategory as ScanStats['byCategory'],
      byExtension,
      byImportance: byImportance as ScanStats['byImportance'],
      newFiles,
      modifiedFiles,
      deletedFiles: 0,
    };
  }

  private async saveProjectFiles(projectId: string, files: FileInfo[]): Promise<void> {
    await memory.saveProjectFiles(projectId, files);
  }

  private async learnFromProject(projectId: string, files: FileInfo[]): Promise<void> {
    console.log(`[Scanner] Learning from project ${projectId}...`);
    
    // Extract patterns from source files
    await this.extractCodePatterns(projectId, files);
    
    // Detect conventions
    await this.detectConventions(projectId, files);
    
    // Detect architecture patterns
    await this.detectArchitecture(projectId, files);
    
    // Detect workflows
    await this.detectWorkflows(projectId, files);
  }

  private async extractCodePatterns(projectId: string, files: FileInfo[]): Promise<void> {
    const sourceFiles = files.filter(f => f.category === 'source' && f.content);
    
    // Simple pattern extraction - in production you'd use AST parsing
    const patterns: Map<string, { count: number; examples: string[]; language: string }> = new Map();
    
    for (const file of sourceFiles) {
      if (!file.content) continue;
      
      const lines = file.content.split('\n');
      
      // Detect common patterns
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Import patterns
        if (trimmed.match(/^import\s+.*\s+from\s+['"]/)) {
          const key = `import-${file.extension}`;
          const existing = patterns.get(key) || { count: 0, examples: [], language: file.extension };
          existing.count++;
          if (existing.examples.length < 5) existing.examples.push(trimmed);
          patterns.set(key, existing);
        }
        
        // Function patterns
        if (trimmed.match(/^(export\s+)?(async\s+)?function\s+\w+/) || 
            trimmed.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/) ||
            trimmed.match(/^def\s+\w+\s*\(/)) {
          const key = `function-${file.extension}`;
          const existing = patterns.get(key) || { count: 0, examples: [], language: file.extension };
          existing.count++;
          if (existing.examples.length < 5) existing.examples.push(trimmed.substring(0, 100));
          patterns.set(key, existing);
        }
        
        // Class patterns
        if (trimmed.match(/^(export\s+)?class\s+\w+/)) {
          const key = `class-${file.extension}`;
          const existing = patterns.get(key) || { count: 0, examples: [], language: file.extension };
          existing.count++;
          if (existing.examples.length < 5) existing.examples.push(trimmed.substring(0, 100));
          patterns.set(key, existing);
        }
      }
    }
    
    // Save patterns
    for (const [key, data] of patterns) {
      if (data.count > 2) { // Only save patterns seen multiple times
        const pattern = {
          id: uuidv4(),
          name: key,
          description: `Common ${key} pattern`,
          language: data.language,
          pattern: key,
          examples: data.examples,
          frequency: data.count,
          projects: [projectId],
          lastSeen: Date.now(),
        };
        await memory.savePattern(pattern);
      }
    }
  }

  private async detectConventions(projectId: string, files: FileInfo[]): Promise<void> {
    // Naming conventions
    const fileNames = files.map(f => f.name);
    
    // Check for PascalCase components
    const pascalCaseFiles = fileNames.filter(n => /^[A-Z][a-zA-Z0-9]*\.(tsx|jsx|vue|svelte)$/.test(n));
    if (pascalCaseFiles.length > 3) {
      const convention = {
        id: uuidv4(),
        type: 'naming' as const,
        rule: 'Component files use PascalCase',
        rationale: 'Consistent with React/Vue/Svelte conventions',
        examples: [{ good: 'UserProfile.tsx', bad: 'userProfile.tsx' }],
        severity: 'info' as const,
        projects: [projectId],
        autoDetected: true,
      };
      await memory.saveConvention(convention);
    }
    
    // Check for kebab-case files
    const kebabCaseFiles = fileNames.filter(n => /^[a-z][a-z0-9-]*\.(ts|js|css|scss)$/.test(n));
    if (kebabCaseFiles.length > 3) {
      const convention = {
        id: uuidv4(),
        type: 'naming' as const,
        rule: 'Utility/config files use kebab-case',
        examples: [{ good: 'api-client.ts', bad: 'apiClient.ts' }],
        severity: 'info' as const,
        projects: [projectId],
        autoDetected: true,
      };
      await memory.saveConvention(convention);
    }
    
    // Check for test file patterns
    const testFiles = files.filter(f => f.category === 'test');
    if (testFiles.length > 0) {
      const hasSpec = testFiles.some(f => f.name.includes('.spec.'));
      const hasTest = testFiles.some(f => f.name.includes('.test.'));
      
      if (hasSpec && !hasTest) {
        const convention = {
          id: uuidv4(),
          type: 'testing' as const,
          rule: 'Test files use .spec suffix',
          examples: [{ good: 'user.spec.ts', bad: 'user.test.ts' }],
          severity: 'warning' as const,
          projects: [projectId],
          autoDetected: true,
        };
        await memory.saveConvention(convention);
      } else if (hasTest && !hasSpec) {
        const convention = {
          id: uuidv4(),
          type: 'testing' as const,
          rule: 'Test files use .test suffix',
          examples: [{ good: 'user.test.ts', bad: 'user.spec.ts' }],
          severity: 'warning' as const,
          projects: [projectId],
          autoDetected: true,
        };
        await memory.saveConvention(convention);
      }
    }
  }

  private async detectArchitecture(projectId: string, files: FileInfo[]): Promise<void> {
    const dirs = files.filter(f => f.isDirectory).map(f => f.relativePath);
    const sourceFiles = files.filter(f => f.category === 'source');
    
    // Detect layered architecture
    const hasControllers = dirs.some(d => d.includes('controller'));
    const hasServices = dirs.some(d => d.includes('service'));
    const hasRepositories = dirs.some(d => d.includes('repository') || d.includes('repo'));
    const hasModels = dirs.some(d => d.includes('model') || d.includes('entity'));
    const hasRoutes = dirs.some(d => d.includes('route'));
    const hasMiddleware = dirs.some(d => d.includes('middleware'));
    
    if (hasControllers && hasServices && hasRepositories) {
      const arch = {
        id: uuidv4(),
        name: 'Layered Architecture (Controller-Service-Repository)',
        description: 'Traditional layered architecture with clear separation of concerns',
        layers: ['controllers', 'services', 'repositories', 'models'].filter(l => 
          dirs.some(d => d.includes(l))
        ),
        components: sourceFiles.map(f => f.relativePath.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i),
        dataFlow: 'Request -> Controller -> Service -> Repository -> Database',
        projects: [projectId],
        confidence: 0.8,
      };
      await memory.saveArchitecture(arch);
    }
    
    // Detect feature-based architecture
    const featureDirs = dirs.filter(d => d.startsWith('features/') || d.startsWith('modules/'));
    if (featureDirs.length > 2) {
      const arch = {
        id: uuidv4(),
        name: 'Feature-Based Architecture',
        description: 'Code organized by feature/domain rather than layer',
        layers: ['features'],
        components: featureDirs.map(d => d.split('/')[1]).filter(Boolean),
        dataFlow: 'Feature modules encapsulate their own logic, UI, and data',
        projects: [projectId],
        confidence: 0.7,
      };
      await memory.saveArchitecture(arch);
    }
    
    // Detect monorepo
    const packageJsons = files.filter(f => f.name === 'package.json' && f.relativePath !== 'package.json');
    if (packageJsons.length > 1) {
      const arch = {
        id: uuidv4(),
        name: 'Monorepo',
        description: 'Multiple packages in a single repository',
        layers: ['packages'],
        components: packageJsons.map(f => f.relativePath.split('/')[0]),
        dataFlow: 'Shared dependencies, independent packages',
        projects: [projectId],
        confidence: 0.9,
      };
      await memory.saveArchitecture(arch);
    }
  }

  private async detectWorkflows(projectId: string, files: FileInfo[]): Promise<void> {
    // Check package.json for scripts
    const pkgFile = files.find(f => f.name === 'package.json' && f.content);
    if (pkgFile?.content) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        const scripts = pkg.scripts || {};
        
        const commonWorkflows: Record<string, string[]> = {
          'Development': ['dev', 'start', 'serve'],
          'Build': ['build', 'compile', 'bundle'],
          'Test': ['test', 'test:watch', 'test:coverage', 'test:e2e'],
          'Lint': ['lint', 'lint:fix', 'format', 'format:fix'],
          'Type Check': ['typecheck', 'type-check', 'tsc'],
          'Database': ['db:migrate', 'db:seed', 'db:studio'],
          'Docker': ['docker:build', 'docker:up', 'docker:down'],
          'Deploy': ['deploy', 'deploy:staging', 'deploy:prod'],
        };
        
        for (const [name, scriptKeys] of Object.entries(commonWorkflows)) {
          const steps = scriptKeys.filter(k => scripts[k]).map(k => ({
            name: k,
            description: `Run ${k}`,
            command: `npm run ${k}`,
            automation: true,
          }));
          
          if (steps.length > 0) {
            const workflow = {
              id: uuidv4(),
              name,
              description: `${name} workflow`,
              steps,
              triggers: ['manual', 'ci'],
              tools: ['npm', 'node'],
              frequency: 1,
              projects: [projectId],
            };
            await memory.saveWorkflow(workflow);
          }
        }
      } catch {}
    }
    
    // Check for CI/CD files
    const ciFiles = files.filter(f => 
      f.relativePath.startsWith('.github/workflows/') ||
      f.relativePath.startsWith('.gitlab-ci') ||
      f.name === 'jenkinsfile' ||
      f.relativePath.startsWith('.circleci/')
    );
    
    if (ciFiles.length > 0) {
      const workflow = {
        id: uuidv4(),
        name: 'CI/CD Pipeline',
        description: 'Automated continuous integration and deployment',
        steps: ciFiles.map(f => ({
          name: f.name,
          description: `CI config: ${f.relativePath}`,
          automation: true,
        })),
        triggers: ['push', 'pull_request', 'schedule'],
        tools: ['GitHub Actions', 'GitLab CI', 'Jenkins', 'CircleCI'].filter(t => 
          ciFiles.some(f => f.relativePath.toLowerCase().includes(t.toLowerCase().replace(' ', '')))
        ),
        frequency: 10,
        projects: [projectId],
      };
      await memory.saveWorkflow(workflow);
    }
  }

  // Get project files from database
  async getProjectFiles(projectId: string, category?: string, importance?: string): Promise<FileInfo[]> {
    return memory.getProjectFiles(projectId, category, importance);
  }
}

export const scanner = new ProjectScanner();