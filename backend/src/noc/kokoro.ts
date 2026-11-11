/**
 * Voz local da NIA: Kokoro-82M (licença Apache 2.0) rodando no próprio servidor,
 * sem internet depois do primeiro download do modelo e sem créditos.
 *
 * O Kokoro recebe fonemas, não texto. A pronúncia em português do Brasil vem do
 * eSpeak NG (compilado para WebAssembly, sem instalar nada no sistema). A voz padrão
 * é a pf_dora (feminina, pt-BR).
 *
 * Desempenho medido num i7-4770 (CPU, fp32): ~0,6 s de processamento por segundo de
 * fala; frase curta em ~1,7 s. O modelo (~325 MB em fp32) é baixado uma vez do
 * Hugging Face para KOKORO_CACHE_DIR e carregado na partida do serviço.
 *
 * É também a base da clonagem da voz própria: a fala sai daqui e o conversor de
 * timbre aplica a voz gravada (quando configurado).
 */

import { mkdirSync } from 'node:fs';
import { nocConfig } from './config.js';

type Tts = {
  tokenizer: (text: string, opts: { truncation: boolean }) => { input_ids: unknown };
  generate_from_ids: (ids: unknown, opts: { voice: string; speed?: number }) => Promise<{ audio: Float32Array; sampling_rate: number; toWav: () => ArrayBuffer }>;
};

let loading: Promise<Tts> | null = null;

async function model(): Promise<Tts> {
  if (!loading) {
    loading = (async () => {
      const { env } = await import('@huggingface/transformers');
      mkdirSync(nocConfig.voice.kokoroCacheDir, { recursive: true });
      env.cacheDir = nocConfig.voice.kokoroCacheDir;
      const { KokoroTTS } = await import('kokoro-js');
      const started = Date.now();
      const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: nocConfig.voice.kokoroDtype as 'fp32' | 'fp16' | 'q8',
        device: 'cpu',
      });
      console.log(`[voz] Kokoro carregado em ${Date.now() - started} ms (${nocConfig.voice.kokoroDtype}, voz ${nocConfig.voice.kokoroVoice})`);
      return tts as unknown as Tts;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** Fonemas IPA em pt-BR pelo eSpeak NG (WebAssembly), com a pontuação de volta para as pausas. */
async function fonemas(text: string): Promise<string> {
  const { default: ESpeakNg } = await import('espeak-ng') as unknown as { default: (o: unknown) => Promise<{ FS: { readFile: (p: string, o: { encoding: 'utf8' }) => string } }> };
  const espeak = await ESpeakNg({
    arguments: ['--phonout', 'out', '--sep=""', '-q', '-b', '1', '--ipa=3', '-v', 'pt-br', '-f', 'in.txt'],
    preRun: [(m: { FS: { writeFile: (p: string, d: Uint8Array) => void } }) => { m.FS.writeFile('in.txt', new TextEncoder().encode(text)); }],
    print: () => {},
    printErr: () => {},
  });
  const linhas = espeak.FS.readFile('out', { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
  const pontuacao = text.match(/[.,!?;:]/g) ?? [];
  return linhas.map((l, i) => l + (pontuacao[i] ?? '')).join(' ').replace(/‍/g, '');
}

export const kokoroEnabled = () => nocConfig.voice.ttsProvider === 'kokoro';

/** Carrega o modelo em segundo plano na partida, para a primeira fala não esperar. */
export function warmKokoro() {
  if (!kokoroEnabled()) return;
  model()
    .then((tts) => fonemas('Sistemas online.').then((p) => tts.generate_from_ids(tts.tokenizer(p, { truncation: true }).input_ids, { voice: nocConfig.voice.kokoroVoice })))
    .catch((e) => console.warn('[voz] Kokoro não carregou; a fala usa a voz da Microsoft:', e instanceof Error ? e.message : e));
}

/** WAV (24 kHz) da frase com a voz local. */
/**
 * Frases curtas para o Kokoro. O modelo aceita ~510 fonemas por vez e, perto desse limite,
 * a fala perde qualidade no fim ("vai ficando robótica") ou é cortada. Por isso cada trecho
 * é dividido em frases (e, se preciso, em vírgulas e palavras) de até ~170 caracteres.
 */
export function trechosDeFala(text: string, max = 170): string[] {
  // Só divide em pontuação seguida de espaço: "1.161", "10:30" e "Opa!," ficam inteiros.
  const frases = text.split(/(?<=[.!?;:])\s+/).map((s) => s.trim()).filter(Boolean);
  const pedacos: string[] = [];
  for (const frase of frases) {
    if (frase.length <= max) { pedacos.push(frase); continue; }
    let atual = '';
    const empurra = () => { if (atual.trim()) pedacos.push(atual.trim()); atual = ''; };
    for (const parte of frase.split(/(?<=,)\s+/)) {
      if (parte.length > max) {
        for (const palavra of parte.split(/\s+/)) { if (`${atual} ${palavra}`.length > max) empurra(); atual += ` ${palavra}`; }
      } else {
        if (`${atual} ${parte}`.length > max) empurra();
        atual += ` ${parte}`;
      }
    }
    empurra();
  }
  // Junta frases muito curtas ("Sim." "Pronto.") para a entonação não ficar picotada.
  const out: string[] = [];
  for (const p of pedacos) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.length < 60 && `${ultimo} ${p}`.length <= max) out[out.length - 1] = `${ultimo} ${p}`;
    else out.push(p);
  }
  return out;
}

/** WAV PCM 16 bits mono. */
function wav(amostras: Float32Array, taxa: number): Buffer {
  const dados = Buffer.alloc(amostras.length * 2);
  for (let i = 0; i < amostras.length; i++) dados.writeInt16LE(Math.round(Math.max(-1, Math.min(1, amostras[i])) * 32767), i * 2);
  const cab = Buffer.alloc(44);
  cab.write('RIFF', 0); cab.writeUInt32LE(36 + dados.length, 4); cab.write('WAVE', 8);
  cab.write('fmt ', 12); cab.writeUInt32LE(16, 16); cab.writeUInt16LE(1, 20); cab.writeUInt16LE(1, 22);
  cab.writeUInt32LE(taxa, 24); cab.writeUInt32LE(taxa * 2, 28); cab.writeUInt16LE(2, 32); cab.writeUInt16LE(16, 34);
  cab.write('data', 36); cab.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cab, dados]);
}

export async function kokoroWav(text: string): Promise<Buffer> {
  const tts = await model();
  const partes: Float32Array[] = [];
  let taxa = 24000;
  for (const trecho of trechosDeFala(text)) {
    const ids = tts.tokenizer(await fonemas(trecho), { truncation: true }).input_ids;
    const audio = await tts.generate_from_ids(ids, { voice: nocConfig.voice.kokoroVoice, speed: nocConfig.voice.kokoroSpeed });
    taxa = audio.sampling_rate;
    partes.push(audio.audio);
    // Pausa natural entre trechos: maior no fim de frase, menor na vírgula.
    partes.push(new Float32Array(Math.round(taxa * (/[.!?;:]$/.test(trecho) ? 0.12 : 0.05))));
  }
  const total = partes.reduce((n, p) => n + p.length, 0);
  const tudo = new Float32Array(total);
  let pos = 0;
  for (const p of partes) { tudo.set(p, pos); pos += p.length; }
  return wav(tudo, taxa);
}
