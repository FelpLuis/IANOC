/**
 * Configuração dos ambientes do provedor que o assistente consulta.
 *
 * Cada conector só liga quando as variáveis dele estão preenchidas no .env.
 * Nenhum segredo tem valor padrão: conector sem credencial fica desligado e o
 * assistente diz isso ao operador, em vez de inventar dado.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// backend/src/noc -> projetoNOC/
const projetoRoot = path.resolve(here, '../../../../..');

const env = (key: string) => String(process.env[key] ?? '').trim();
const stripSlash = (value: string) => value.replace(/\/+$/, '');

/** Endereços dos provedores no formato OpenAI (chat/completions com ferramentas). */
export const OPENAI_PRESETS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
};
// Padrão: motor nativo (native/engine.ts), que não depende de modelo de linguagem externo.
const provider = (env('LLM_PROVIDER') || 'nativo').toLowerCase();

export const nocConfig = {
  llm: {
    provider,
    // Credencial resolvida pelo SDK: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ou perfil `ant auth login`.
    model: env('CLAUDE_MODEL') || 'claude-opus-5',
    effort: (env('CLAUDE_EFFORT') || 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    maxToolRounds: Number(env('CLAUDE_MAX_TOOL_ROUNDS') || 12),
    maxHistoryTurns: Number(env('CLAUDE_MAX_HISTORY_TURNS') || 20),
  },

  /**
   * Modelo no formato OpenAI, quando LLM_PROVIDER não é "anthropic". Ollama roda
   * na própria máquina e não precisa de chave; os demais pedem LLM_API_KEY.
   */
  openai: {
    provider,
    baseUrl: stripSlash(env('LLM_BASE_URL') || OPENAI_PRESETS[provider] || ''),
    apiKey: env('LLM_API_KEY'),
    model: env('LLM_MODEL'),
    // Modelo local em CPU leva minutos para responder; os de nuvem, segundos.
    timeoutMs: Number(env('LLM_TIMEOUT_MS') || (provider === 'ollama' ? 1800000 : 120000)),
    maxTokens: Number(env('LLM_MAX_TOKENS') || 4096),
    // Janela de contexto pedida ao Ollama (o padrão dele, 4096, não cabe o prompt do NOC).
    ollamaNumCtx: Number(env('OLLAMA_NUM_CTX') || 16384),
    // Raciocínio visível (Qwen3, DeepSeek-R1): melhora a escolha de ferramentas, mas em CPU
    // multiplica o tempo de resposta. Desligado por padrão; OLLAMA_THINK=true liga.
    ollamaThink: env('OLLAMA_THINK') === 'true',
    ollamaKeepAlive: env('OLLAMA_KEEP_ALIVE') || '30m',
    // Cotas gratuitas pequenas (Groq: 8 mil tokens/minuto) não comportam o prompt completo
    // (~9 mil tokens). No modo compacto o inventário e os documentos saem do prompt e
    // ficam só nas ferramentas, os resultados de ferramenta são cortados mais cedo e os
    // resultados de perguntas antigas saem do histórico.
    compactPrompt: (env('LLM_PROMPT_MODE') || (provider === 'groq' ? 'compact' : 'full')) === 'compact',
    toolResultMaxChars: Number(env('LLM_TOOL_RESULT_MAX_CHARS') || (provider === 'groq' ? 6000 : 0)),
    // Modelos de raciocínio (gpt-oss, Qwen3): low | medium | high. Vazio = padrão do provedor.
    reasoningEffort: env('LLM_REASONING_EFFORT'),
    // Em limite por minuto (HTTP 429), espera o tempo pedido pelo provedor e tenta de novo.
    rateLimitWaitMs: Number(env('LLM_RATE_LIMIT_WAIT_MS') || 90000),
    // Tokens por minuto da conta (Groq grátis: 8000). Limita max_tokens ao que cabe.
    tpmLimit: Number(env('LLM_TPM_LIMIT') || (provider === 'groq' ? 8000 : 0)),
  },

  /** Sistema NOC (Topologia) — sistema.updown.com.br. Proxy de Zabbix, GPON/OLT, RADIUS e clientes do IXC. */
  noc: {
    baseUrl: stripSlash(env('NOC_API_URL')),
    // Token de sessão fixo OU usuário de serviço (o assistente faz login e renova sozinho).
    token: env('NOC_API_TOKEN'),
    username: env('NOC_API_USER'),
    password: env('NOC_API_PASSWORD'),
  },

  /**
   * Zabbix direto (JSON-RPC). Até três instâncias: ZABBIX_* (principal), ZABBIX2_* e ZABBIX3_*.
   * Cada uma autentica por token de API (preferido) ou por usuário/senha de leitura.
   */
  zabbix: ['', '2', '3'].map(zabbixInstance).filter((z): z is ZabbixInstance => z !== null),

  /** Opa! Suite (atendimento omnichannel) — API v1, somente GET. */
  opa: {
    baseUrl: opaBase(env('OPA_URL')),
    token: env('OPA_TOKEN'),
  },

  /**
   * Voz. O navegador reconhece fala e lê as respostas sozinho (Web Speech API). Quando ele
   * não reconhece (Firefox, ou sem acesso ao serviço de voz do Chrome), o áudio gravado vem
   * para o servidor e é transcrito por um endpoint compatível com OpenAI /audio/transcriptions
   * (Groq whisper-large-v3, gratuito; OpenAI; ou um faster-whisper local).
   */
  voice: {
    sttBaseUrl: stripSlash(env('STT_BASE_URL')),
    sttApiKey: env('STT_API_KEY'),
    sttModel: env('STT_MODEL') || 'whisper-large-v3',
    /**
     * Fala das respostas. "edge": voz neural feminina gerada no servidor (padrão);
     * "browser": só a voz do navegador. Vozes pt-BR: FranciscaNeural (rápida),
     * ThalitaMultilingualNeural (mais lenta para gerar), AntonioNeural (masculina).
     */
    // "fish": Fish Audio (https://fish.audio), voz escolhida na biblioteca deles por FISH_VOICE_ID;
    // se a Fish falhar, a fala volta para a voz neural da Microsoft.
    // "kokoro": voz local no servidor (Kokoro-82M + eSpeak NG), sem internet nem créditos.
    ttsProvider: (env('TTS_PROVIDER') || 'edge') as 'edge' | 'fish' | 'kokoro' | 'browser',
    kokoroVoice: env('KOKORO_VOICE') || 'pf_dora',
    kokoroDtype: env('KOKORO_DTYPE') || 'fp32',
    kokoroSpeed: Number(env('KOKORO_SPEED') || 1),
    kokoroCacheDir: env('KOKORO_CACHE_DIR') || (process.env.NODE_ENV === 'production' ? '/var/lib/ianoc/models' : './data/models'),
    fishApiKey: env('FISH_API_KEY'),
    fishVoiceId: env('FISH_VOICE_ID'),
    fishModel: env('FISH_MODEL') || 's1',
    fishBaseUrl: stripSlash(env('FISH_BASE_URL') || 'https://api.fish.audio'),
    ttsVoice: env('TTS_VOICE') || 'pt-BR-FranciscaNeural',
    ttsRate: env('TTS_RATE') || '+0%',
    ttsPitch: env('TTS_PITCH') || '+0%',
  },

  /** GenieACS NBI (TR-069). Porta 7557 não autentica: só alcance por rede interna/túnel. */
  genieacs: {
    nbiUrl: stripSlash(env('GENIEACS_NBI_URL')),
    username: env('GENIEACS_NBI_USER'),
    password: env('GENIEACS_NBI_PASSWORD'),
  },

  /** IXC Soft (ERP) — webservice v1, somente leitura. */
  ixc: {
    baseUrl: stripSlash(env('IXC_BASE_URL')),
    token: env('IXC_API_TOKEN'),
  },

  knowledge: {
    // Sementes do backbone (geradas do KMZ) e do inventário do núcleo.
    topologiaDataDir: env('TOPOLOGIA_DATA_DIR') || path.join(projetoRoot, 'Topologia-NOC.github.io', 'public', 'data'),
    // Documentos em Markdown escritos pela equipe (procedimentos, VLANs, contatos de operadora...).
    docsDir: env('KNOWLEDGE_DIR') || path.resolve(here, '../../../knowledge'),
  },

  http: {
    timeoutMs: Number(env('CONNECTOR_TIMEOUT_MS') || 20000),
    // Teto do que volta ao modelo por chamada de ferramenta.
    maxResultChars: Number(env('TOOL_RESULT_MAX_CHARS') || 40000),
  },
};

export interface ZabbixInstance { nome: string; url: string; token: string; username: string; password: string }

/** Aceita a URL da API, a raiz do Zabbix ou um link qualquer da interface (…/zabbix.php?action=…). */
function zabbixApiUrl(raw: string): string {
  if (!raw) return '';
  const url = stripSlash(raw.replace(/[?#].*$/, '').replace(/\/(zabbix|index)\.php$/, ''));
  return /api_jsonrpc\.php$/.test(url) ? url : `${url}/api_jsonrpc.php`;
}

function zabbixInstance(suffix: string): ZabbixInstance | null {
  const k = (name: string) => env(`ZABBIX${suffix}_${name}`);
  const url = zabbixApiUrl(k('URL'));
  const [token, username, password] = [k('TOKEN'), k('USER'), k('PASSWORD')];
  if (!url || !(token || (username && password))) return null;
  const nome = (k('NAME') || (suffix ? `zabbix${suffix}` : 'principal')).toLowerCase();
  return { nome, url, token, username, password };
}

/** O endereço do atendente (…/atendente/) vira a base da API (…/api/v1). */
function opaBase(raw: string): string {
  if (!raw) return '';
  const origin = stripSlash(raw.replace(/[?#].*$/, '').replace(/\/atendente(\/.*)?$/, '').replace(/\/api\/v1\/?$/, ''));
  return `${origin}/api/v1`;
}

export type ConnectorName = 'noc' | 'zabbix' | 'genieacs' | 'ixc' | 'opa';

export function connectorEnabled(name: ConnectorName): boolean {
  switch (name) {
    case 'noc':
      return Boolean(nocConfig.noc.baseUrl && (nocConfig.noc.token || (nocConfig.noc.username && nocConfig.noc.password)));
    case 'zabbix':
      return nocConfig.zabbix.length > 0;
    case 'genieacs':
      return Boolean(nocConfig.genieacs.nbiUrl);
    case 'ixc':
      return Boolean(nocConfig.ixc.baseUrl && nocConfig.ixc.token);
    case 'opa':
      return Boolean(nocConfig.opa.baseUrl && nocConfig.opa.token);
  }
}
