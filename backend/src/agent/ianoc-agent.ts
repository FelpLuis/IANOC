/**
 * IA NOC Agent - Main Agent Class
 * Handles chat, project interactions, and learning
 */

import { memory } from '../memory/memory-manager.js';
import { scanner } from '../services/project-scanner.js';
import { randomUUID as uuidv4 } from 'node:crypto';
import { askAssistant, llmConfigured, type AssistantEvent } from '../noc/assistant.js';
import {
  AgentMemory,
  ChatRequest,
  ChatResponse,
  Message,
  UserIntent,
  AgentAction,
  ProjectInfo,
  FileInfo,
  LearnedKnowledge,
} from '../shared/types.js';

export class IANOCAgent {
  private systemPrompt: string;
  private model: string;
  private cachedIdentity: Awaited<ReturnType<typeof memory.getIdentity>> | null = null;

  constructor(model = 'default') {
    this.model = model;
    this.systemPrompt = '';
    this.cachedIdentity = null;
    // Initialize asynchronously
    this.initialize();
  }

  private async initialize(): Promise<void> {
    this.cachedIdentity = await memory.getIdentity();
    this.systemPrompt = await this.buildSystemPrompt();
  }

  private getIdentity() {
    if (!this.cachedIdentity) {
      throw new Error('Agent not initialized yet');
    }
    return this.cachedIdentity;
  }

  private async buildSystemPrompt(): Promise<string> {
    const identity = this.getIdentity();
    const knowledge = await memory.getKnowledge();
    const session = memory.getCurrentSession();
    const project = session?.currentProject ? await memory.getProject(session.currentProject) : null;
    
    let prompt = `# IA NOC Agent

## Identidade
Você é **${identity.name} v${identity.version}**, um assistente de IA pessoal que aprende com os projetos do usuário.

## Perfil do Usuário
- **Nome**: ${identity.userProfile.name || 'Não informado'}
- **Papel**: ${identity.userProfile.role || 'Não informado'}
- **Tecnologias**: ${identity.userProfile.technologies?.join(', ') || 'Não informado'}
- **Estilo de comunicação**: ${identity.userProfile.communicationStyle || 'technical'}
- **Fuso horário**: ${identity.userProfile.timezone || 'America/Sao_Paulo'}

## Preferências
- **Idioma**: ${identity.preferences.language}
- **Verbosidade**: ${identity.preferences.verbosity}
- **Auto-aprendizado**: ${identity.preferences.autoLearn ? 'Ativado' : 'Desativado'}
- **Máximo de arquivos de contexto**: ${identity.preferences.maxContextFiles}

## Projetos Conhecidos (${identity.knownProjects.length})
`;

    if (identity.knownProjects.length > 0) {
      for (const pid of identity.knownProjects) {
        const p = await memory.getProject(pid);
        if (p) {
          prompt += `- **${p.name}** (${p.type}${p.framework ? ` - ${p.framework}` : ''}) - ${p.path}\n`;
        }
      }
    } else {
      prompt += 'Nenhum projeto cadastrado ainda.\n';
    }

    if (project) {
      prompt += `\n## Projeto Atual: ${project.name}
- **Tipo**: ${project.type}${project.framework ? ` (${project.framework})` : ''}
- **Linguagem**: ${project.language || 'Não detectada'}
- **Gerenciador de pacotes**: ${project.metadata.packageManager || 'N/A'}
- **Arquivos**: ${project.fileCount}
- **Último scan**: ${new Date(project.lastScanned).toLocaleString('pt-BR')}
`;
    }

    // Add learned knowledge summary
    prompt += this.formatKnowledgeSummary(knowledge);

    prompt += `
## Instruções
1. **Responda em ${identity.preferences.language === 'pt-BR' ? 'português brasileiro' : 'inglês'}**
2. **Seja ${identity.preferences.verbosity === 'concise' ? 'conciso' : identity.preferences.verbosity === 'detailed' ? 'detalhado' : 'equilibrado'}**
3. **Use o conhecimento aprendido** dos projetos para dar respostas contextualizadas
4. **Referencie convenções e padrões** detectados quando relevante
5. **Sugira ações** baseadas nos workflows conhecidos
6. **Aprenda continuamente** com cada interação

## Conhecimento Disponível
- **Padrões de código**: ${knowledge.patterns.length}
- **Convenções**: ${knowledge.conventions.length}
- **Arquiteturas**: ${knowledge.architectures.length}
- **Workflows**: ${knowledge.workflows.length}
- **Membros da equipe**: ${knowledge.teamMembers.length}
- **Decisões arquiteturais**: ${knowledge.decisions.length}
- **Issues conhecidos**: ${knowledge.issues.length}
`;

    return prompt;
  }

  private formatKnowledgeSummary(knowledge: LearnedKnowledge): string {
    let summary = '\n## Resumo do Conhecimento Aprendido\n';
    
    if (knowledge.patterns.length > 0) {
      summary += `\n### Padrões de Código (${knowledge.patterns.length})\n`;
      for (const p of knowledge.patterns.slice(0, 5)) {
        summary += `- **${p.name}** (${p.language}): ${p.frequency}x - ${p.examples[0]?.substring(0, 80)}...\n`;
      }
    }
    
    if (knowledge.conventions.length > 0) {
      summary += `\n### Convenções (${knowledge.conventions.length})\n`;
      for (const c of knowledge.conventions.slice(0, 5)) {
        summary += `- **[${c.severity.toUpperCase()}] ${c.type}**: ${c.rule}\n`;
      }
    }
    
    if (knowledge.architectures.length > 0) {
      summary += `\n### Arquiteturas (${knowledge.architectures.length})\n`;
      for (const a of knowledge.architectures.slice(0, 3)) {
        summary += `- **${a.name}** (confiança: ${Math.round(a.confidence * 100)}%): ${a.description}\n`;
      }
    }
    
    if (knowledge.workflows.length > 0) {
      summary += `\n### Workflows (${knowledge.workflows.length})\n`;
      for (const w of knowledge.workflows.slice(0, 3)) {
        summary += `- **${w.name}**: ${w.steps.length} passos - ${w.tools.join(', ')}\n`;
      }
    }
    
    return summary;
  }

  private async askNoc(request: ChatRequest, sessionId: string, onEvent?: (event: AssistantEvent) => void): Promise<ChatResponse> {
    // Pergunta ditada no microfone: o prompt pede um parágrafo inicial próprio para ser lido em voz alta.
    const pergunta = request.voice ? `[voz] ${request.message}` : request.message;
    const reply = await askAssistant(request.conversationId || sessionId, pergunta, onEvent);
    return {
      message: reply.text,
      metadata: {
        intent: 'question',
        modelUsed: reply.model,
        tokensUsed: reply.usage.input + reply.usage.output + reply.usage.cacheRead + reply.usage.cacheWrite,
        toolsUsed: reply.toolsUsed,
      },
      suggestions: [],
      actions: [],
    };
  }

  async chat(request: ChatRequest, onEvent?: (event: AssistantEvent) => void): Promise<ChatResponse> {
    // Ensure system prompt is built
    if (!this.systemPrompt) {
      this.systemPrompt = await this.buildSystemPrompt();
    }
    
    const session = memory.getCurrentSession() || await memory.createSession(request.projectId);
    
    if (request.projectId) {
      memory.setCurrentProject(request.projectId);
    }

    // Add user message to history
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content: request.message,
      timestamp: Date.now(),
      metadata: {
        projectId: request.projectId,
        fileRefs: request.contextFiles,
      },
    };
    await memory.addMessage(userMessage);

    // Detect intent
    const intent = this.detectIntent(request.message);
    memory.setUserIntent(intent);

    // Get relevant context files
    const contextFiles = await this.getContextFiles(request);
    
    // Com credencial do Claude configurada, responde o assistente NOC (LLM + ferramentas dos ambientes).
    // Sem ela, cai nas respostas locais abaixo, que não consultam a rede.
    const response = llmConfigured()
      ? await this.askNoc(request, session.sessionId, onEvent)
      : await this.generateResponse(request.message, contextFiles, intent);
    
    // Add assistant message to history
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: response.message,
      timestamp: Date.now(),
      metadata: {
        projectId: request.projectId,
        fileRefs: contextFiles.map(f => f.relativePath),
        intent,
      },
    };
    await memory.addMessage(assistantMessage);

    return response;
  }

  private detectIntent(message: string): UserIntent {
    const lower = message.toLowerCase();
    
    if (lower.includes('como faço') || lower.includes('how to') || lower.includes('como fazer')) return 'question';
    if (lower.includes('gere') || lower.includes('crie') || lower.includes('generate') || lower.includes('create')) return 'code_generation';
    if (lower.includes('revise') || lower.includes('review') || lower.includes('olhe') || lower.includes('check')) return 'code_review';
    if (lower.includes('erro') || lower.includes('bug') || lower.includes('debug') || lower.includes('não funciona') || lower.includes('broken')) return 'debugging';
    if (lower.includes('refatore') || lower.includes('refactor') || lower.includes('melhore') || lower.includes('improve')) return 'refactoring';
    if (lower.includes('documente') || lower.includes('document') || lower.includes('readme') || lower.includes('coment')) return 'documentation';
    if (lower.includes('explique') || lower.includes('explain') || lower.includes('o que') || lower.includes('what is') || lower.includes('como funciona')) return 'learning';
    if (lower.includes('planeje') || lower.includes('plan') || lower.includes('arquitetura') || lower.includes('design')) return 'planning';
    if (lower.includes('automatize') || lower.includes('automate') || lower.includes('script') || lower.includes('pipeline')) return 'automation';
    
    return 'question';
  }

  private async getContextFiles(request: ChatRequest): Promise<FileInfo[]> {
    const session = memory.getCurrentSession();
    const projectId = request.projectId || session?.currentProject;
    
    if (!projectId) return [];
    
    const files: FileInfo[] = [];
    
    // Add explicitly requested files
    if (request.contextFiles) {
      for (const filePath of request.contextFiles) {
        const file = (await scanner.getProjectFiles(projectId)).find(f => f.relativePath === filePath);
        if (file) files.push(file);
      }
    }
    
    // Add active files from session
    if (session?.activeFiles) {
      for (const filePath of session.activeFiles) {
        const file = (await scanner.getProjectFiles(projectId)).find(f => f.relativePath === filePath);
        if (file && !files.find(f => f.relativePath === filePath)) {
          files.push(file);
        }
      }
    }
    
    // Add important files from project
    const importantFiles = await scanner.getProjectFiles(projectId, undefined, 'critical');
    for (const file of importantFiles.slice(0, 5)) {
      if (!files.find(f => f.relativePath === file.relativePath)) {
        files.push(file);
      }
    }
    
    const highImportanceFiles = await scanner.getProjectFiles(projectId, undefined, 'high');
    for (const file of highImportanceFiles.slice(0, 10)) {
      if (!files.find(f => f.relativePath === file.relativePath)) {
        files.push(file);
      }
    }
    
    const identity = await memory.getIdentity();
    return files.slice(0, identity.preferences.maxContextFiles);
  }

  private async generateResponse(
    message: string, 
    contextFiles: FileInfo[], 
    intent: UserIntent
  ): Promise<ChatResponse> {
    // In a real implementation, this would call an LLM API
    // For now, we'll generate a contextual response based on learned knowledge
    
    const knowledge = await memory.getKnowledge();
    const project = memory.getCurrentSession()?.currentProject 
      ? await memory.getProject(memory.getCurrentSession()!.currentProject!) 
      : null;
    
    let response = '';
    const suggestions: string[] = [];
    const actions: AgentAction[] = [];
    
    // Build contextual response
    switch (intent) {
      case 'question':
        response = await this.answerQuestion(message, knowledge, project);
        break;
      case 'code_generation':
        response = this.generateCode(message, knowledge, project);
        break;
      case 'code_review':
        response = this.reviewCode(message, contextFiles, knowledge);
        break;
      case 'debugging':
        response = this.debugIssue(message, knowledge, project);
        break;
      case 'refactoring':
        response = this.suggestRefactoring(message, contextFiles, knowledge);
        break;
      case 'documentation':
        response = this.generateDocumentation(message, contextFiles, knowledge);
        break;
      case 'learning':
        response = this.explainConcept(message, knowledge, project);
        break;
      case 'planning':
        response = this.createPlan(message, knowledge, project);
        break;
      case 'automation':
        response = this.suggestAutomation(message, knowledge, project);
        break;
      default:
        response = this.generalResponse(message, knowledge, project);
    }
    
    // Add relevant suggestions
    suggestions.push(...this.generateSuggestions(intent, knowledge, project));
    
    // Add relevant actions
    actions.push(...this.generateActions(intent, contextFiles, project));
    
    return {
      message: response,
      metadata: {
        intent,
        fileRefs: contextFiles.map(f => f.relativePath),
      },
      suggestions,
      actions,
    };
  }

  private async answerQuestion(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): Promise<string> {
    const lang = this.getIdentity().preferences.language;
    
    if (project) {
      return `${lang === 'pt-BR' ? 'Com base no seu projeto **' + project.name + '**:' : 'Based on your project **' + project.name + '**:'}\n\n` +
        `Este é um projeto ${project.type}${project.framework ? ` (${project.framework})` : ''} em ${project.language || 'linguagem não detectada'}.\n\n` +
        `Principais características:\n` +
        `- ${project.fileCount} arquivos\n` +
        `- Gerenciador: ${project.metadata.packageManager || 'N/A'}\n` +
        `- ${knowledge.patterns.filter(p => p.projects.includes(project.id)).length} padrões aprendidos\n` +
        `- ${knowledge.conventions.filter(c => c.projects.includes(project.id)).length} convenções detectadas\n\n` +
        `O que especificamente você gostaria de saber?`;
    }
    
    const knownProjects = this.getIdentity().knownProjects;
    const projectInfos = await Promise.all(knownProjects.map(id => memory.getProject(id)));
    
    return `${lang === 'pt-BR' ? 'Não há projeto ativo no momento.' : 'No active project at the moment.'}\n\n` +
      `${lang === 'pt-BR' ? 'Projetos conhecidos:' : 'Known projects:'}\n` +
      projectInfos.filter((p): p is ProjectInfo => p !== null).map(p => `- **${p.name}** (${p.type})`).join('\n') + '\n\n' +
      `${lang === 'pt-BR' ? 'Use "scan" para escanear um projeto ou me diga qual projeto usar.' : 'Use "scan" to scan a project or tell me which project to use.'}`;
  }

  private generateCode(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): string {
    const lang = this.getIdentity().preferences.language;
    
    if (!project) {
      return `${lang === 'pt-BR' ? 'Preciso saber em qual projeto gerar código.' : 'I need to know which project to generate code for.'}`;
    }
    
    const conventions = knowledge.conventions.filter(c => c.projects.includes(project.id));
    const patterns = knowledge.patterns.filter(p => p.projects.includes(project.id));
    
    let response = `${lang === 'pt-BR' ? 'Para gerar código no projeto **' + project.name + '**, vou seguir:' : 'To generate code in project **' + project.name + '**, I\'ll follow:'}\n\n`;
    
    if (conventions.length > 0) {
      response += `${lang === 'pt-BR' ? '**Convenções detectadas:**' : '**Detected conventions:**'}\n`;
      for (const c of conventions.slice(0, 3)) {
        response += `- ${c.rule}\n`;
      }
      response += '\n';
    }
    
    if (patterns.length > 0) {
      response += `${lang === 'pt-BR' ? '**Padrões comuns:**' : '**Common patterns:**'}\n`;
      for (const p of patterns.slice(0, 3)) {
        response += `- ${p.name}: ${p.examples[0]}\n`;
      }
      response += '\n';
    }
    
    response += `${lang === 'pt-BR' ? 'Por favor, descreva o que você precisa que eu gere (ex: "um hook React para buscar usuários", "um service em NestJS para autenticação", etc.)' : 'Please describe what you need me to generate (e.g., "a React hook to fetch users", "a NestJS service for authentication", etc.)'}`;
    
    return response;
  }

  private reviewCode(message: string, contextFiles: FileInfo[], knowledge: LearnedKnowledge): string {
    const lang = this.getIdentity().preferences.language;
    
    if (contextFiles.length === 0) {
      return `${lang === 'pt-BR' ? 'Nenhum arquivo fornecido para revisão. Compartilhe o código ou me diga qual arquivo revisar.' : 'No files provided for review. Share the code or tell me which file to review.'}`;
    }
    
    let response = `${lang === 'pt-BR' ? 'Revisando **' + contextFiles.length + ' arquivo(s)**:' : 'Reviewing **' + contextFiles.length + ' file(s)**:'}\n\n`;
    
    for (const file of contextFiles) {
      response += `### ${file.relativePath}\n`;
      response += `- **Categoria**: ${file.category}\n`;
      response += `- **Importância**: ${file.importance}\n`;
      
      if (file.content) {
        const lines = file.content.split('\n').length;
        response += `- **Linhas**: ${lines}\n`;
        
        // Check against conventions
        const project = memory.getCurrentSession()?.currentProject;
        if (project) {
          const projectConventions = knowledge.conventions.filter(c => c.projects.includes(project));
          for (const convention of projectConventions.slice(0, 3)) {
            response += `- **Convenção**: ${convention.rule}\n`;
          }
        }
      }
      response += '\n';
    }
    
    response += `${lang === 'pt-BR' ? 'O que especificamente você gostaria que eu revisasse?' : 'What specifically would you like me to review?'}`;
    
    return response;
  }

  private debugIssue(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): string {
    const lang = this.getIdentity().preferences.language;
    const issues = knowledge.issues.filter(i => project ? i.projectId === project.id : true);
    
    let response = `${lang === 'pt-BR' ? 'Para ajudar a debugar, preciso de mais detalhes:' : 'To help debug, I need more details:'}\n\n`;
    
    if (issues.length > 0) {
      response += `${lang === 'pt-BR' ? '**Issues conhecidos semelhantes:**' : '**Known similar issues:**'}\n`;
      for (const issue of issues.slice(0, 3)) {
        response += `- **${issue.title}** (${issue.severity}): ${issue.description.substring(0, 100)}...\n`;
        if (issue.solutions.length > 0) {
          response += `  - Solução: ${issue.solutions[0].description}\n`;
        }
      }
      response += '\n';
    }
    
    response += `${lang === 'pt-BR' ? 'Por favor, forneça:' : 'Please provide:'}\n` +
      `1. ${lang === 'pt-BR' ? 'Mensagem de erro completa' : 'Full error message'}\n` +
      `2. ${lang === 'pt-BR' ? 'Stack trace (se houver)' : 'Stack trace (if any)'}\n` +
      `3. ${lang === 'pt-BR' ? 'Passos para reproduzir' : 'Steps to reproduce'}\n` +
      `4. ${lang === 'pt-BR' ? 'Arquivos relacionados' : 'Related files'}\n`;
    
    return response;
  }

  private suggestRefactoring(message: string, contextFiles: FileInfo[], knowledge: LearnedKnowledge): string {
    const lang = this.getIdentity().preferences.language;
    
    if (contextFiles.length === 0) {
      return `${lang === 'pt-BR' ? 'Nenhum arquivo para refatorar. Indique os arquivos ou diretórios.' : 'No files to refactor. Specify files or directories.'}`;
    }
    
    const project = memory.getCurrentSession()?.currentProject;
    const architectures = project ? knowledge.architectures.filter(a => a.projects.includes(project)) : [];
    
    let response = `${lang === 'pt-BR' ? 'Sugestões de refatoração para **' + contextFiles.map(f => f.name).join(', ') + '**:' : 'Refactoring suggestions for **' + contextFiles.map(f => f.name).join(', ') + '**:'}\n\n`;
    
    if (architectures.length > 0) {
      response += `${lang === 'pt-BR' ? '**Arquitetura detectada:**' : '**Detected architecture:**'}\n`;
      for (const arch of architectures.slice(0, 2)) {
        response += `- ${arch.name}: ${arch.description}\n`;
      }
      response += '\n';
    }
    
    const conventions = project ? knowledge.conventions.filter(c => c.projects.includes(project)) : [];
    if (conventions.length > 0) {
      response += `${lang === 'pt-BR' ? '**Convenções a seguir:**' : '**Conventions to follow:**'}\n`;
      for (const c of conventions.slice(0, 3)) {
        response += `- ${c.rule} (${c.severity})\n`;
      }
      response += '\n';
    }
    
    response += `${lang === 'pt-BR' ? 'Ideias de refatoração:' : 'Refactoring ideas:'}\n` +
      `1. ${lang === 'pt-BR' ? 'Extrair lógica repetida em hooks/utilitários' : 'Extract repeated logic into hooks/utils'}\n` +
      `2. ${lang === 'pt-BR' ? 'Aplicar padrões de projeto consistentes' : 'Apply consistent design patterns'}\n` +
      `3. ${lang === 'pt-BR' ? 'Melhorar tipagem TypeScript' : 'Improve TypeScript typing'}\n` +
      `4. ${lang === 'pt-BR' ? 'Adicionar testes para código crítico' : 'Add tests for critical code'}\n`;
    
    return response;
  }

  private generateDocumentation(message: string, contextFiles: FileInfo[], knowledge: LearnedKnowledge): string {
    const lang = this.getIdentity().preferences.language;
    
    if (contextFiles.length === 0) {
      return `${lang === 'pt-BR' ? 'Quais arquivos/documentos você quer documentar?' : 'Which files/documents do you want to document?'}`;
    }
    
    let response = `${lang === 'pt-BR' ? 'Gerando documentação para:' : 'Generating documentation for:'}\n\n`;
    
    for (const file of contextFiles) {
      response += `- **${file.relativePath}** (${file.category})\n`;
    }
    
    response += `\n${lang === 'pt-BR' ? 'Tipos de documentação que posso criar:' : 'Documentation types I can create:'}\n` +
      `1. ${lang === 'pt-BR' ? 'README do projeto' : 'Project README'}\n` +
      `2. ${lang === 'pt-BR' ? 'Documentação de API' : 'API documentation'}\n` +
      `3. ${lang === 'pt-BR' ? 'Guia de contribuição' : 'Contributing guide'}\n` +
      `4. ${lang === 'pt-BR' ? 'Documentação de arquitetura' : 'Architecture documentation'}\n` +
      `5. ${lang === 'pt-BR' ? 'Comentários de código (JSDoc/TSDoc)' : 'Code comments (JSDoc/TSDoc)'}\n` +
      `6. ${lang === 'pt-BR' ? 'Changelog' : 'Changelog'}\n\n` +
      `${lang === 'pt-BR' ? 'Qual tipo você prefere?' : 'Which type do you prefer?'}`;
    
    return response;
  }

  private explainConcept(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): string {
    const lang = this.getIdentity().preferences.language;
    
    let response = `${lang === 'pt-BR' ? 'Vou explicar baseado no seu contexto:' : 'I\'ll explain based on your context:'}\n\n`;
    
    if (project) {
      response += `**Projeto**: ${project.name} (${project.type}${project.framework ? ` - ${project.framework}` : ''})\n\n`;
    }
    
    // Find relevant patterns/conventions
    const relevantPatterns = knowledge.patterns.slice(0, 3);
    if (relevantPatterns.length > 0) {
      response += `${lang === 'pt-BR' ? '**Padrões relevantes:**' : '**Relevant patterns:**'}\n`;
      for (const p of relevantPatterns) {
        response += `- **${p.name}**: ${p.description}\n  Exemplo: ${p.examples[0]}\n\n`;
      }
    }
    
    const relevantConventions = knowledge.conventions.slice(0, 3);
    if (relevantConventions.length > 0) {
      response += `${lang === 'pt-BR' ? '**Convenções importantes:**' : '**Important conventions:**'}\n`;
      for (const c of relevantConventions) {
        response += `- ${c.rule}\n`;
      }
    }
    
    return response;
  }

  private createPlan(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): string {
    const lang = this.getIdentity().preferences.language;
    
    if (!project) {
      return `${lang === 'pt-BR' ? 'Preciso saber qual projeto planejar.' : 'I need to know which project to plan for.'}`;
    }
    
    const workflows = knowledge.workflows.filter(w => w.projects.includes(project.id));
    
    let response = `${lang === 'pt-BR' ? 'Planejamento para **' + project.name + '**:' : 'Planning for **' + project.name + '**:'}\n\n`;
    
    if (workflows.length > 0) {
      response += `${lang === 'pt-BR' ? '**Workflows existentes:**' : '**Existing workflows:**'}\n`;
      for (const w of workflows.slice(0, 3)) {
        response += `- **${w.name}**: ${w.steps.length} passos\n`;
      }
      response += '\n';
    }
    
    response += `${lang === 'pt-BR' ? 'Etapas sugeridas:' : 'Suggested steps:'}\n` +
      `1. ${lang === 'pt-BR' ? 'Definir requisitos claros' : 'Define clear requirements'}\n` +
      `2. ${lang === 'pt-BR' ? 'Verificar arquitetura atual' : 'Review current architecture'}\n` +
      `3. ${lang === 'pt-BR' ? 'Identificar dependências' : 'Identify dependencies'}\n` +
      `4. ${lang === 'pt-BR' ? 'Criar tarefas pequenas e testáveis' : 'Create small, testable tasks'}\n` +
      `5. ${lang === 'pt-BR' ? 'Definir critérios de aceite' : 'Define acceptance criteria'}\n\n` +
      `${lang === 'pt-BR' ? 'Qual aspecto específico você quer planejar?' : 'What specific aspect do you want to plan?'}`;
    
    return response;
  }

  private suggestAutomation(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): string {
    const lang = this.getIdentity().preferences.language;
    
    if (!project) {
      return `${lang === 'pt-BR' ? 'Preciso saber qual projeto automatizar.' : 'I need to know which project to automate.'}`;
    }
    
    const workflows = knowledge.workflows.filter(w => w.projects.includes(project.id));
    
    let response = `${lang === 'pt-BR' ? 'Automações para **' + project.name + '**:' : 'Automations for **' + project.name + '**:'}\n\n`;
    
    if (workflows.length > 0) {
      response += `${lang === 'pt-BR' ? '**Workflows que podem ser automatizados:**' : '**Workflows that can be automated:**'}\n`;
      for (const w of workflows) {
        response += `- **${w.name}**: ${w.steps.map(s => s.name).join(' → ')}\n`;
      }
      response += '\n';
    }
    
    response += `${lang === 'pt-BR' ? 'Ideias de automação:' : 'Automation ideas:'}\n` +
      `1. ${lang === 'pt-BR' ? 'CI/CD Pipeline' : 'CI/CD Pipeline'}\n` +
      `2. ${lang === 'pt-BR' ? 'Testes automatizados' : 'Automated tests'}\n` +
      `3. ${lang === 'pt-BR' ? 'Deploy automático' : 'Auto deploy'}\n` +
      `4. ${lang === 'pt-BR' ? 'Lint/format no commit' : 'Lint/format on commit'}\n` +
      `5. ${lang === 'pt-BR' ? 'Geração de documentação' : 'Doc generation'}\n` +
      `6. ${lang === 'pt-BR' ? 'Atualização de dependências' : 'Dependency updates'}\n\n` +
      `${lang === 'pt-BR' ? 'Qual automação você gostaria de implementar?' : 'Which automation would you like to implement?'}`;
    
    return response;
  }

  private generalResponse(message: string, knowledge: LearnedKnowledge, project: ProjectInfo | null): string {
    const lang = this.getIdentity().preferences.language;
    
    return `${lang === 'pt-BR' ? 'Olá! Sou o **IA NOC**, seu assistente de IA pessoal.' : 'Hello! I\'m **IA NOC**, your personal AI assistant.'}\n\n` +
      (project ? 
        `${lang === 'pt-BR' ? 'Estou conectado ao projeto **' + project.name + '**.' : 'I\'m connected to project **' + project.name + '**.'}\n\n` : 
        `${lang === 'pt-BR' ? 'Nenhum projeto ativo. Use "scan" para escanear seus projetos.' : 'No active project. Use "scan" to scan your projects.'}\n\n`
      ) +
      `${lang === 'pt-BR' ? 'Como posso ajudar?' : 'How can I help?'}\n` +
      `- ${lang === 'pt-BR' ? 'Perguntas sobre código/projeto' : 'Questions about code/project'}\n` +
      `- ${lang === 'pt-BR' ? 'Gerar código seguindo suas convenções' : 'Generate code following your conventions'}\n` +
      `- ${lang === 'pt-BR' ? 'Revisar e refatorar código' : 'Review and refactor code'}\n` +
      `- ${lang === 'pt-BR' ? 'Debugar issues' : 'Debug issues'}\n` +
      `- ${lang === 'pt-BR' ? 'Criar documentação' : 'Create documentation'}\n` +
      `- ${lang === 'pt-BR' ? 'Planejar features/arquitetura' : 'Plan features/architecture'}\n` +
      `- ${lang === 'pt-BR' ? 'Automatizar tarefas' : 'Automate tasks'}\n` +
      `- ${lang === 'pt-BR' ? 'Aprender com seus projetos' : 'Learn from your projects'}`;
  }

  private generateSuggestions(intent: UserIntent, knowledge: LearnedKnowledge, project: ProjectInfo | null): string[] {
    const suggestions: string[] = [];
    const lang = this.getIdentity().preferences.language;
    
    switch (intent) {
      case 'question':
        suggestions.push(lang === 'pt-BR' ? 'Me mostre a arquitetura do projeto' : 'Show me the project architecture');
        suggestions.push(lang === 'pt-BR' ? 'Quais são as convenções deste projeto?' : 'What are the project conventions?');
        break;
      case 'code_generation':
        suggestions.push(lang === 'pt-BR' ? 'Crie um componente React' : 'Create a React component');
        suggestions.push(lang === 'pt-BR' ? 'Gere um service NestJS' : 'Generate a NestJS service');
        break;
      case 'debugging':
        suggestions.push(lang === 'pt-BR' ? 'Verifique issues conhecidos' : 'Check known issues');
        suggestions.push(lang === 'pt-BR' ? 'Analise os logs de erro' : 'Analyze error logs');
        break;
    }
    
    return suggestions;
  }

  private generateActions(intent: UserIntent, contextFiles: FileInfo[], project: ProjectInfo | null): AgentAction[] {
    const actions: AgentAction[] = [];
    const lang = this.getIdentity().preferences.language;
    
    if (contextFiles.length > 0) {
      actions.push({
        type: 'read_file',
        description: lang === 'pt-BR' ? 'Ler arquivo completo' : 'Read full file',
        params: { path: contextFiles[0].relativePath },
        requiresApproval: false,
      });
    }
    
    if (project) {
      actions.push({
        type: 'analyze',
        description: lang === 'pt-BR' ? 'Analisar projeto completo' : 'Analyze full project',
        params: { projectId: project.id },
        requiresApproval: false,
      });
    }
    
    return actions;
  }

  // Public methods for frontend
  async getMemory(): Promise<AgentMemory> {
    return memory.exportMemory();
  }

  async getProjects(): Promise<ProjectInfo[]> {
    return memory.getAllProjects();
  }

  async getProject(id: string): Promise<ProjectInfo | null> {
    return memory.getProject(id);
  }

  async scanProject(path: string, name?: string) {
    return scanner.scanProject(path, name);
  }

  async updatePreferences(prefs: Partial<import('../shared/types.js').AgentPreferences>) {
    await memory.updatePreferences(prefs);
    // Update cache
    if (this.cachedIdentity) {
      this.cachedIdentity.preferences = { ...this.cachedIdentity.preferences, ...prefs };
    }
    this.systemPrompt = await this.buildSystemPrompt();
  }

  async updateUserProfile(profile: Partial<import('../shared/types.js').UserProfile>) {
    await memory.updateUserProfile(profile);
    // Update cache
    if (this.cachedIdentity) {
      this.cachedIdentity.userProfile = { ...this.cachedIdentity.userProfile, ...profile };
    }
    this.systemPrompt = await this.buildSystemPrompt();
  }
}

export const agent = new IANOCAgent();