# IA NOC Agent

Seu assistente de IA pessoal que aprende com seus projetos locais.

## 🚀 Características

- **Aprendizado Local**: Escaneia seus projetos no filesystem e aprende padrões, convenções e arquiteturas
- **Memória Híbrida**: Identidade persistente + conhecimento aprendido + contexto de sessão temporário
- **Interface Gráfica Moderna**: React + Vite + Tailwind CSS com chat em tempo real via WebSocket
- **Contexto Inteligente**: Seleciona automaticamente arquivos relevantes para cada conversa
- **Ações Executáveis**: Lê arquivos, analisa projetos, sugere refatorações

## 🛰️ Assistente virtual do NOC

Com um modelo de IA configurado (Claude, pago, ou uma opção gratuita: Ollama local, Gemini, Groq, OpenRouter), o chat vira o assistente do NOC da UpDown:
ele consulta os ambientes do provedor em tempo real e conhece o backbone e a rede FTTH.
Sem modelo, o chat continua com as respostas locais antigas (sem consultar a rede).

**Somente leitura.** Nenhuma ferramenta altera estado: o Zabbix aceita só métodos `.get`,
o GenieACS e o Opa! Suite só GET, o IXC só `listar`, e o NOC é acessado por um usuário de serviço.
Quando uma ação resolveria o problema (reboot, provisionamento), o assistente diz qual é
e onde fazer, e um humano executa.

| Ambiente | O que o assistente consulta | Variáveis em `backend/.env` |
|---|---|---|
| Sistema NOC (sistema.updown.com.br) | topologia, interfaces/tráfego/enlaces do Zabbix, ONUs das OLTs ZTE C300/C350 com sinal RX/TX, histórico GPON, log RADIUS, clientes do IXC, tickets | `NOC_API_URL`, `NOC_API_USER`, `NOC_API_PASSWORD` |
| Zabbix (até 3 instâncias) | alarmes ativos, relatório de eventos de um período (hosts que mais caíram, tempo em problema, recorrências) e qualquer consulta `.get` | `ZABBIX_URL` + `ZABBIX_TOKEN` ou `ZABBIX_USER`/`ZABBIX_PASSWORD`; `ZABBIX2_*`, `ZABBIX3_*` |
| GenieACS (TR-069) | CPE por serial/PPPoE, último inform, WAN, Wi-Fi, falhas, tarefas pendentes | `GENIEACS_NBI_URL` |
| IXC Soft | cliente, contrato, login PPPoE, O.S., financeiro (CPF/CNPJ mascarados), relatório de O.S. por período | `IXC_BASE_URL`, `IXC_API_TOKEN` |
| Opa! Suite | atendimentos (fila, status, setor, atendente), mensagens, departamentos, relatório de atendimentos | `OPA_URL`, `OPA_TOKEN` |

**Relatórios:** botões prontos (hoje, ontem, semana, mês, O.S., atendimentos) ou peça em texto/voz.
Cada resposta pode ser baixada em `.md` ou impressa/salva em PDF pelos ícones abaixo dela.

**Voz:** botão de microfone no chat (Chrome/Edge reconhecem fala em pt-BR) e leitura das
respostas em voz alta (botão de alto-falante liga a leitura automática). Pergunta feita por
voz é respondida com um resumo falado primeiro. O navegador só libera o microfone em
**HTTPS ou localhost**: no servidor, publique atrás de HTTPS. Para Firefox, configure
`STT_BASE_URL`/`STT_API_KEY` (ex.: Groq Whisper, gratuito) e o áudio é transcrito no servidor.
| Backbone e FTTH | equipamentos, portas, enlaces, caminho entre equipamentos, cabos, CEOs e caixas por nome ou por proximidade de uma coordenada | nenhuma: lê `/api/topology` do NOC ou, sem ele, as sementes em `Topologia-NOC.github.io/public/data` |
| Documentos da equipe | tudo em `knowledge/*.md`, integral no contexto | `KNOWLEDGE_DIR` (opcional) |

Cada conector liga sozinho quando as variáveis dele estão preenchidas.

### Configurar

1. Escolha o modelo em `backend/.env` (`LLM_PROVIDER`):
   - **Grátis e local:** instale o [Ollama](https://ollama.com), rode `ollama pull qwen3:8b` e defina
     `LLM_PROVIDER=ollama` e `LLM_MODEL=qwen3:8b`. Nada sai da rede; sem placa de vídeo cada resposta leva minutos.
   - **Grátis na nuvem:** `LLM_PROVIDER=gemini` (ou `groq`/`openrouter`), `LLM_MODEL` e `LLM_API_KEY`
     do provedor. Rápido, mas com limite de uso, e na cota gratuita os dados podem ser usados pelo provedor.
     Em uso: **Groq** com `openai/gpt-oss-120b` (8 mil tokens/minuto na cota grátis). Para caber, o
     modo compacto é automático no Groq (inventário e documentos saem do prompt e ficam nas
     ferramentas; descrições encurtadas; resposta limitada ao que sobra do minuto) e, ao bater o
     limite, o assistente espera o tempo pedido e tenta de novo — perguntas com várias consultas
     levam 20–40 s. A mesma chave transcreve a voz (`STT_*`, Whisper).
   - **Relatórios** não dependem do modelo para os números: a ferramenta `relatorio_noc` monta
     tabelas com os dados exatos do Zabbix, IXC e Opa! no servidor, e o modelo só escreve a análise.
   - **Claude:** `ANTHROPIC_API_KEY` (ou `ant auth login` e `CLAUDE_ENABLED=true`), modelo padrão `claude-opus-5`.
2. Usuário de serviço do NOC: `cd backend && npm run noc:criar-usuario` pede um login de
   administrador, cria o perfil `ianoc_leitura` (só `topology.view`, `zabbix.view`,
   `clientes.view`, `radius.view`) e o usuário `ianoc-servico`, e grava `NOC_API_*` no `.env`.
3. Preencha Zabbix, GenieACS e IXC conforme disponível. O NBI do GenieACS (7557) não
   autentica: alcance por rede interna ou túnel (`ssh -L 7557:127.0.0.1:7557 ...`).
4. Complete os trechos `A PREENCHER` em `knowledge/` (VLANs, operadoras, contatos,
   comandos das OLTs). O que não estiver escrito lá nem cadastrado nos sistemas, o
   assistente não sabe, e diz isso.
5. Confira: `cd backend && npm run noc:selftest` testa conectores e ferramentas sem gastar
   chamadas de LLM. `GET /api/noc/status` mostra o que está ligado.

Em desenvolvimento, o Vite faz proxy de `/api` e `/ws` para o backend na porta `VITE_BACKEND_PORT` (padrão 3001).

### Publicar no servidor

O backend serve a interface e o WebSocket numa porta só (padrão 8090), com login pelo
usuário e senha do sistema NOC (perfil `cliente` nunca entra; perfis liberados em
`IANOC_ALLOWED_ROLES`). Em produção a varredura de projetos e a leitura de arquivos do
disco ficam desligadas.

```bash
bash deploy/deploy.sh usuario@190.111.110.13 22
```

Na primeira vez o script instala Node 22, cria o usuário `ianoc`, o serviço systemd
`ianoc` e o arquivo `/etc/ianoc/ianoc.env`, onde entram as credenciais (só no servidor).
Depois: `sudo nano /etc/ianoc/ianoc.env` e `sudo systemctl restart ianoc`.
Logs e registro de quem perguntou o quê: `journalctl -u ianoc -f`.
Os 3 últimos releases ficam em `/opt/ianoc/releases`; rollback é apontar
`/opt/ianoc/current` para o anterior e reiniciar.

## 📁 Estrutura do Projeto

```
ianoc-agent/
├── backend/                 # Servidor Node.js + Express + WebSocket
│   ├── src/
│   │   ├── agent/          # Agente principal (IA NOC)
│   │   ├── memory/         # Sistema de memória híbrida (SQLite)
│   │   ├── services/       # Scanner de projetos, etc.
│   │   ├── utils/          # Utilitários (database, file-utils)
│   │   └── index.ts        # Entry point
│   └── data/               # Banco de dados SQLite
├── frontend/               # Interface React + Vite
│   ├── src/
│   │   ├── components/     # Componentes UI (Chat, Sidebar)
│   │   ├── hooks/          # Hooks customizados (useAgent)
│   │   ├── services/       # API e WebSocket clients
│   │   ├── types/          # Tipos TypeScript
│   │   └── utils/          # Helpers
│   └── index.html
└── shared/                 # Tipos compartilhados
    └── types.ts
```

## 🛠️ Pré-requisitos

- Node.js 18+
- npm 9+

## 🚀 Início Rápido

### Windows (PowerShell)
```powershell
cd ianoc-agent
.\start-dev.ps1
```

### Windows (Batch)
```cmd
cd ianoc-agent
start-dev.bat
```

### Manual
```bash
# Terminal 1 - Backend
cd ianoc-agent/backend
npm install
npm run dev

# Terminal 2 - Frontend
cd ianoc-agent/frontend
npm install
npm run dev
```

## 📖 Como Usar

1. **Abra o frontend** em http://localhost:5173
2. **Clique no botão "+"** na sidebar para escanear um projeto
3. **Digite o caminho relativo** do projeto (ex: `../meu-projeto`)
4. **Aguarde o scan** - o agente aprende:
   - Padrões de código
   - Convenções de nomenclatura
   - Arquitetura do projeto
   - Workflows (scripts npm, CI/CD)
5. **Comece a conversar** - o agente usa o conhecimento aprendido

## 💡 Exemplos de Uso

```
"Explique a arquitetura deste projeto"
"Quais são as convenções de código aqui?"
"Gere um component React seguindo os padrões do projeto"
"Me ajude a debugar este erro: [erro]"
"Refatore este arquivo para seguir as convenções"
"Crie documentação para esta API"
"Quais workflows de deploy existem?"
```

## ⚙️ Configuração

Copie `backend/.env.example` para `backend/.env` e ajuste:

```env
# Server
PORT=3001
HOST=localhost

# Database
DB_PATH=./data/agent.db

# File System
PROJECTS_ROOT=../..
SCAN_INTERVAL_MINUTES=30
MAX_FILE_SIZE_MB=10

# Agent Identity
AGENT_NAME=IA NOC
DEFAULT_LANGUAGE=pt-BR

# Learning
AUTO_LEARN=true
MAX_CONTEXT_FILES=20
```

## 🧠 Como Funciona o Aprendizado

### 1. Scan de Projeto
- Percorre recursivamente o diretório
- Ignora `node_modules`, `.git`, `dist`, etc.
- Categoriza arquivos (source, test, config, docs, etc.)
- Determina importância (critical, high, medium, low)

### 2. Extração de Conhecimento
- **Padrões**: Imports, funções, classes, hooks
- **Convenções**: Nomenclatura, estrutura, testes
- **Arquitetura**: Camadas, feature-based, monorepo
- **Workflows**: Scripts npm, CI/CD, Docker

### 3. Memória Híbrida
- **Identidade** (persistente): Nome, preferências, perfil do usuário
- **Conhecimento** (persistente): Padrões, convenções, decisões
- **Sessão** (temporário): Histórico, arquivos ativos, intent atual

## 🔧 Desenvolvimento

### Backend
```bash
cd backend
npm run dev      # Development com hot reload
npm run build    # Build para produção
npm run start    # Inicia build de produção
npm run scan     # Scan manual de projetos
```

### Frontend
```bash
cd frontend
npm run dev      # Development server
npm run build    # Build para produção
npm run preview  # Preview do build
npm run lint     # ESLint
```

## 📦 Deploy

### Backend (Produção)
```bash
cd backend
npm run build
npm run start
```

### Frontend (Produção)
```bash
cd frontend
npm run build
# Sirva a pasta dist/ com nginx, Vercel, Netlify, etc.
```

## 🤝 Contribuindo

1. Fork o projeto
2. Crie uma branch (`git checkout -b feature/nova-funcionalidade`)
3. Commit suas mudanças (`git commit -am 'Add nova funcionalidade'`)
4. Push para a branch (`git push origin feature/nova-funcionalidade`)
5. Abra um Pull Request

## 📄 Licença

MIT License - veja [LICENSE](LICENSE) para detalhes.

## 🙏 Agradecimentos

- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) - Inspiração para arquitetura de agentes
- [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) - Banco de dados rápido
- [React](https://react.dev/) + [Vite](https://vitejs.dev/) + [Tailwind](https://tailwindcss.com/) - Stack frontend moderna