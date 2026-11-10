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
export async function kokoroWav(text: string): Promise<Buffer> {
  const tts = await model();
  const ids = tts.tokenizer(await fonemas(text), { truncation: true }).input_ids;
  const audio = await tts.generate_from_ids(ids, { voice: nocConfig.voice.kokoroVoice, speed: nocConfig.voice.kokoroSpeed });
  return Buffer.from(audio.toWav());
}
