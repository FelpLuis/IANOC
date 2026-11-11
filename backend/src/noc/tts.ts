/**
 * Voz do assistente (texto → fala) no servidor, com vozes neurais da Microsoft
 * pelo serviço de leitura em voz alta do Edge (gratuito, sem chave).
 *
 * Padrão: pt-BR-FranciscaNeural, feminina, com ritmo calmo e firme de
 * assistente. Começa a tocar ~0,3 s depois do pedido. O navegador pede uma
 * frase por vez e já busca a próxima enquanto toca a atual.
 *
 * O serviço não é uma API oficial e pode mudar: se falhar, o navegador volta
 * para a voz própria dele (speechSynthesis). O texto falado sai para a
 * Microsoft — o mesmo texto que já foi gerado pelo modelo de IA.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { nocConfig } from './config.js';
import { kokoroEnabled, kokoroWav } from './kokoro.js';

let client: MsEdgeTTS | null = null;
let ready: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

const cache = new Map<string, Buffer>();
const CACHE_MAX = 120;

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function connect(): Promise<void> {
  if (!client || !ready) {
    client = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 20000 } as ConstructorParameters<typeof MsEdgeTTS>[0]);
    ready = client.setMetadata(nocConfig.voice.ttsVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  }
  return ready;
}

function reset() {
  try { client?.close(); } catch { /* conexão já caiu */ }
  client = null;
  ready = null;
}

async function synth(text: string): Promise<Buffer> {
  await connect();
  const { audioStream } = client!.toStream(escapeXml(text), { rate: nocConfig.voice.ttsRate, pitch: nocConfig.voice.ttsPitch });
  const parts: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    audioStream.on('data', (d: Buffer) => parts.push(d));
    audioStream.on('end', () => resolve());
    audioStream.on('error', reject);
  });
  const audio = Buffer.concat(parts);
  if (audio.length < 200) throw new Error('áudio vazio');
  return audio;
}

export const ttsEnabled = () => ['edge', 'fish', 'kokoro'].includes(nocConfig.voice.ttsProvider);
const fishReady = () => nocConfig.voice.ttsProvider === 'fish' && Boolean(nocConfig.voice.fishApiKey && nocConfig.voice.fishVoiceId);

/** Nome da voz em uso, para o status. */
export const ttsVoiceLabel = () => (kokoroEnabled() ? `Kokoro local (${nocConfig.voice.kokoroVoice})` : fishReady() ? `Fish Audio (${nocConfig.voice.fishVoiceId})` : nocConfig.voice.ttsVoice);

/** Fish Audio: POST /v1/tts com o modelo de voz (reference_id) escolhido na biblioteca. */
async function fishSynth(text: string): Promise<Buffer> {
  const v = nocConfig.voice;
  const res = await fetch(`${v.fishBaseUrl}/v1/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${v.fishApiKey}`, 'Content-Type': 'application/json', model: v.fishModel },
    body: JSON.stringify({ text, reference_id: v.fishVoiceId, format: 'mp3', mp3_bitrate: 128, latency: 'balanced', normalize: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Fish Audio HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 200) throw new Error('Fish Audio devolveu áudio vazio');
  return audio;
}

/**
 * Dicionário de pronúncia: como cada sigla deve soar. Vale para toda fala gerada
 * no servidor (Fish ou Microsoft). Para acrescentar: { sigla: /regex/, fala: 'como soa' }.
 */
const PRONUNCIA: Array<[RegExp, string]> = [
  [/\bNOC\b/gi, 'nóqui'],
  [/\bNIA\b/g, 'Nía'],
  [/\bONUs\b/gi, 'óenius'],
  [/\bONU\b/gi, 'óeniu'],
  [/\bOLTs\b/gi, 'óelités'],
  [/\bOLT\b/gi, 'óelité'],
];
export const pronuncia = (s: string) => PRONUNCIA.reduce((acc, [re, fala]) => acc.replace(re, fala), s);

// Mesma frase pedida ao mesmo tempo (chat e NIA TV, ou duas TVs): uma síntese só para todos.
// `desistiu` guarda, de cada interessado, se ele abandonou o pedido.
const emAndamento = new Map<string, { job: Promise<Buffer>; desistiu: Array<() => boolean> }>();

/** Pedido abandonado (o navegador parou de falar ou recarregou) enquanto esperava na fila. */
export class FalaCancelada extends Error {}

/**
 * Áudio da frase (WAV do Kokoro ou MP3). Uma síntese por vez (a CPU é uma só); pedido que o
 * navegador abandonou enquanto esperava na fila é descartado sem gastar CPU.
 */
export function speakToMp3(raw: string, cancelado: () => boolean = () => false): Promise<Buffer> {
  const text = pronuncia(raw.replace(/\s+/g, ' ').trim().slice(0, 1200));
  const hit = cache.get(text);
  if (hit) return Promise.resolve(hit);
  const junto = emAndamento.get(text);
  if (junto) { junto.desistiu.push(cancelado); return junto.job; }
  const desistiu = [cancelado];

  const run = async () => {
    // Só descarta se todos que esperavam esta frase desistiram.
    if (desistiu.every((d) => d())) throw new FalaCancelada('pedido de voz abandonado');
    let audio: Buffer | undefined;
    if (kokoroEnabled()) {
      try { audio = await kokoroWav(text); } catch (e) { console.warn('[voz] Kokoro falhou, usando a voz da Microsoft:', e instanceof Error ? e.message : e); }
    }
    if (!audio && fishReady()) {
      try { audio = await fishSynth(text); } catch (e) { console.warn('[voz] Fish Audio falhou, usando a voz da Microsoft:', e instanceof Error ? e.message : e); }
    }
    if (!audio) {
      try {
        audio = await synth(text);
      } catch {
        reset();
        audio = await synth(text);
      }
    }
    // Frases curtas se repetem ("Consultando o Zabbix."): ficam em cache.
    if (text.length <= 200) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(text, audio);
    }
    return audio;
  };
  const job = queue.then(run, run).finally(() => emAndamento.delete(text));
  emAndamento.set(text, { job, desistiu });
  queue = job.catch(() => undefined);
  return job;
}
