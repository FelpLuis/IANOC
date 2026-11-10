/**
 * Voz do IA NOC: ditar a pergunta e ouvir a resposta, com conversa contínua.
 *
 * Fala: voz neural feminina gerada no servidor (/api/voice/speak, uma frase por
 * pedido). A próxima frase é buscada enquanto a atual toca, e as frases são
 * encadeadas no Web Audio sem pausa entre elas. Um tratamento leve de "assistente
 * digital" (presença e um eco curtíssimo) pode ser ligado. Sem voz do servidor,
 * usa a melhor voz feminina pt-BR do navegador (speechSynthesis).
 *
 * Reconhecimento: Web Speech API do navegador (Chrome/Edge, pt-BR). Sem ela
 * (Firefox), grava com MediaRecorder, detecta o fim da fala pelo silêncio e
 * manda para /api/voice/transcribe (Whisper no servidor).
 *
 * Microfone só funciona em HTTPS ou em localhost (regra do navegador).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Recognition = {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

const RecognitionCtor = (): (new () => Recognition) | undefined => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

const RECOGNITION_ERRORS: Record<string, string> = {
  'not-allowed': 'Permissão do microfone negada. Libere o microfone para este site no navegador.',
  'service-not-allowed': 'O navegador bloqueou o reconhecimento de voz.',
  'audio-capture': 'Nenhum microfone encontrado.',
  network: 'O reconhecimento de voz deste navegador não está disponível. Use o Chrome, ou ative a transcrição no servidor (STT_BASE_URL).',
};

/** Fim da escuta: texto reconhecido, ou vazio com o motivo. */
export type ListenEnd = (text: string, reason?: 'empty' | 'error') => void;

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const hora = (h: string, m: string) => {
  const hh = Number(h); const mm = Number(m);
  return mm === 0 ? `${hh} horas` : `${hh} e ${String(mm).padStart(2, '0')}`;
};

/**
 * Texto escrito → texto para ser falado com naturalidade: datas, horas, unidades
 * e siglas como uma pessoa leria, e pausa entre itens de lista.
 */
function naturalize(text: string): string {
  return text
    // 2026-11-09 13:38:28 → 9 de novembro, às 13 e 38
    .replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/g, (_, _y, mo, d, h, mi) =>
      `${Number(d)} de ${MESES[Number(mo) - 1] ?? mo}${h ? `, às ${hora(h, mi)}` : ''}`)
    .replace(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g, (_, d, mo) => `${Number(d)} de ${MESES[Number(mo) - 1] ?? mo}`)
    .replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/g, (_, h, m) => hora(h, m))
    // unidades
    .replace(/(\d)\s?Gbps\b/g, '$1 gigabits por segundo')
    .replace(/(\d)\s?Mbps\b/g, '$1 megabits por segundo')
    .replace(/(\d)\s?Kbps\b/gi, '$1 kilobits por segundo')
    .replace(/(\d)\s?ms\b/g, '$1 milissegundos')
    .replace(/(\d)\s?min\b/g, '$1 minutos')
    .replace(/(\d)\s?h\b/g, '$1 horas')
    .replace(/(\d)\s?%/g, '$1 por cento')
    .replace(/(\d)\s?dBm\b/g, '$1 dê bê ême')
    .replace(/\bdBm\b/g, 'dê bê ême')
    .replace(/(\d)\s?[xX]\s?(\d)/g, '$1 por $2')
    .replace(/(?<![\d.])(\d+)\.(\d{1,2})(?![\d.])/g, '$1,$2')     // 27.5 → 27,5 (não mexe em IP)
    .replace(/(\d)\/(?=\d)/g, '$1 barra ')                           // porta 0/1/5
    .replace(/(^|[\s(])[-−](\d)/g, '$1menos $2')
    // siglas e símbolos (dicionário de pronúncia, igual ao do servidor em tts.ts)
    .replace(/\bNOC\b/gi, 'nóqui')
    .replace(/\bNIA\b/g, 'Nía')
    .replace(/\bONUs\b/gi, 'óenius')
    .replace(/\bONU\b/gi, 'óeniu')
    .replace(/\bOLTs\b/gi, 'óelités')
    .replace(/\bOLT\b/gi, 'óelité')
    .replace(/\bO\.?S\.?(?=\s|$|[,.;])/g, 'O S')
    .replace(/\bvs\.?\s/gi, 'contra ')
    .replace(/\s*(?:->|→|=>)\s*/g, ' para ')
    .replace(/\s*&\s*/g, ' e ')
    .replace(/[•·▪►✅❌⚠️🔴🟠🟡🟢⬆⬇]/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    // parênteses viram pausa
    .replace(/\s*\(([^)]{1,120})\)/g, ', $1,')
    .replace(/,\s*([.;:!?])/g, '$1')
    .replace(/,\s*,/g, ',');
}

/** Texto em Markdown → texto corrido para falar: sem tabelas, código, links e marcações. */
export function markdownToSpeech(markdown: string, onlySummary = false): string {
  const lines = markdown
    .replace(/```[\s\S]*?```/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*[-=_*]{3,}\s*$/.test(line))   // tabelas e réguas
    .map((line) => line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')           // imagens
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // links
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*#+\s*/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/[*_~]+/g, '')
      .trim())
    // Cada linha (título, item de lista) termina com pausa: sem isso a voz emenda tudo.
    .map((line) => (line && !/[.!?;:,]$/.test(line) ? `${line}.` : line));
  let text = lines.join('\n');
  if (onlySummary) {
    // O início da resposta em texto corrido (o prompt pede um resumo falado primeiro), até ~600 caracteres.
    const flat = text.replace(/\n{2,}/g, '\n');
    const cut = flat.slice(0, 600);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
    text = flat.length <= 600 ? flat : cut.slice(0, end > 200 ? end + 1 : 600);
  }
  return naturalize(text.replace(/:\s*\n/g, '. ').replace(/\s+/g, ' ')).trim();
}

const FECHOS = ['O restante está na sua tela.', 'Os detalhes estão na sua tela, Chefe.', 'Está tudo na tela.'];
let ultimoFecho = -1;

/**
 * O que a NIA fala sozinha: só o recado direto do começo da resposta (até duas frases,
 * ~220 caracteres), sem ler tabelas, listas nem o passo a passo. Se há mais na tela,
 * fecha com "o restante está na sua tela". A leitura completa fica no botão de ouvir.
 */
export function resumoFalado(markdown: string): string {
  // Primeiro parágrafo de texto corrido (pula título "# …", tabela, lista e citação).
  const blocos = markdown.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const primeiro = blocos.find((b) => !/^(#|\||[-*+] |\d+[.)] |>|```)/.test(b)) ?? blocos[0] ?? '';
  const falado = markdownToSpeech(primeiro);
  // Resposta curta e sem nada além na tela (saudação, confirmação): fala inteira.
  if (blocos.length === 1 && falado.length <= 200) return falado;
  const frases = falado.match(/[^.!?]+[.!?]+/g) ?? [falado];
  // Uma frase só; a segunda entra apenas se a primeira for um aviso curto ("Relatório pronto.").
  let curto = (frases[0] ?? '').trim();
  if (curto.length < 60 && frases[1] && (curto + frases[1]).length <= 180) curto = `${curto} ${frases[1].trim()}`;
  curto = curto || falado.slice(0, 180);
  const temMais = markdown.length > primeiro.length + 40 || /\n\s*(\||#|[-*+] |\d+[.)] )/.test(markdown);
  if (!temMais) return curto;
  ultimoFecho = (ultimoFecho + 1) % FECHOS.length;
  return `${curto} ${FECHOS[ultimoFecho]}`;
}

/**
 * Divide a fala em trechos. A primeira parte é curta para a voz começar logo; as
 * seguintes são longas (várias frases), para a entonação seguir natural — sintetizar
 * frase por frase soa robótico.
 */
function chunks(text: string, first: number, rest: number): string[] {
  const parts = text.match(/[^.!?;]+[.!?;]*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    const limit = out.length === 0 ? first : rest;
    if ((cur + p).length > limit && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

// ------------------------------------------------------------------ áudio (Web Audio)

let ctx: AudioContext | null = null;
let entry: GainNode | null = null;
let plainOut: GainNode | null = null;
let fxOut: GainNode | null = null;

function audio(): AudioContext | null {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    // entrada → saída limpa
    //        → passa-alta → presença → (seco + eco curto) → saída "assistente digital"
    entry = ctx.createGain();
    plainOut = ctx.createGain();
    fxOut = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.2;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 130;
    const presence = ctx.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 3200; presence.Q.value = 0.9; presence.gain.value = 3.5;
    const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = 2;
    const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.012;
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    entry.connect(plainOut).connect(comp);
    entry.connect(hp).connect(presence).connect(air);
    air.connect(fxOut);
    air.connect(delay).connect(wet).connect(fxOut);
    fxOut.connect(comp);
    comp.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function setEffect(on: boolean) {
  if (!plainOut || !fxOut) return;
  plainOut.gain.value = on ? 0 : 1;
  fxOut.gain.value = on ? 0.92 : 0;
}

/** Sinais curtos: começou a ouvir, entendeu, erro. */
export function earcon(kind: 'listen' | 'heard' | 'end' | 'error') {
  const c = audio();
  if (!c) return;
  const notes = { listen: [740, 1110], heard: [1110, 880], end: [880, 660, 440], error: [330, 247] }[kind];
  const t0 = c.currentTime + 0.01;
  notes.forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = t0 + i * 0.075;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.16);
  });
}

// ------------------------------------------------------------------ voz do navegador (reserva)

function pickBrowserVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const pt = voices.filter((v) => /^pt(-|_)BR/i.test(v.lang));
  const male = /antonio|daniel|felipe|ricardo|heitor|donato|fabio|humberto|julio|nicolau|valerio/i;
  const female = pt.filter((v) => !male.test(v.name));
  return female.find((v) => /francisca|thalita/i.test(v.name) && /natural|online/i.test(v.name))
    ?? female.find((v) => /natural|online/i.test(v.name))
    ?? female.find((v) => /google/i.test(v.name))
    ?? female.find((v) => /maria|luciana|vit[oó]ria|leila|yara|manuela/i.test(v.name))
    ?? female[0] ?? pt[0] ?? voices.find((v) => /^pt/i.test(v.lang));
}

function speakBrowser(parts: string[], alive: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !parts.length) return resolve(alive());
    const voice = pickBrowserVoice();
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = voice?.lang ?? 'pt-BR';
      if (voice) u.voice = voice;
      u.rate = 1;
      u.pitch = 1;
      if (i === parts.length - 1) { u.onend = () => resolve(alive()); u.onerror = () => resolve(false); }
      window.speechSynthesis.speak(u);
    });
  });
}

// ------------------------------------------------------------------ hook

export function useVoice(opts: { serverTranscription: boolean; serverSpeech: boolean; aiEffect: boolean }) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [interim, setInterim] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);          // volume do microfone (0–1) enquanto grava
  const recognitionRef = useRef<Recognition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const genRef = useRef(0);                       // muda a cada parada: falas antigas desistem
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const pendingRef = useRef(0);                   // falas na fila (para o estado "falando")
  // Voz do servidor falhou (sessão caiu num reinício, Kokoro carregando…): usa a do navegador
  // só por um tempo e depois volta a tentar a neural. Antes ficava robótica até recarregar a página.
  const serverPausaAte = useRef(0);
  const servidorOk = () => Date.now() >= serverPausaAte.current;

  const browserStt = typeof window !== 'undefined' && Boolean(RecognitionCtor());
  const recorderStt = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  const canListen = browserStt || (recorderStt && opts.serverTranscription);
  const canSpeak = typeof window !== 'undefined' && (opts.serverSpeech || 'speechSynthesis' in window);

  useEffect(() => { setEffect(opts.aiEffect); }, [opts.aiEffect]);

  // As vozes do navegador carregam depois da página.
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.getVoices();
    const onVoices = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', onVoices);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', onVoices);
  }, []);

  const stopSpeaking = useCallback(() => {
    genRef.current++;
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch { /* já parou */ } });
    sourcesRef.current = [];
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    chainRef.current = Promise.resolve(true);
    pendingRef.current = 0;
    setSpeaking(false);
  }, []);

  /** Toca as frases pela voz do servidor; devolve as que sobraram se ela falhar. */
  const speakServer = useCallback(async (parts: string[], gen: number): Promise<{ done: boolean; rest: string[] }> => {
    const c = audio();
    if (!c) return { done: false, rest: parts };
    setEffect(opts.aiEffect);
    const fetchPart = (text: string) => fetch('/api/voice/speak', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return c.decodeAudioData(await r.arrayBuffer());
    });
    const pending: Promise<AudioBuffer>[] = [];
    const want = (i: number) => { if (i < parts.length && !pending[i]) pending[i] = fetchPart(parts[i]); };
    want(0); want(1);
    let at = 0;
    let last: AudioBufferSourceNode | null = null;
    for (let i = 0; i < parts.length; i++) {
      let buf: AudioBuffer;
      try { buf = await pending[i]; } catch (e) {
        if (i === 0) { serverPausaAte.current = Date.now() + 45_000; console.warn('[voz] voz do servidor falhou; usando a do navegador por 45 s:', e); }
        return { done: false, rest: parts.slice(i) };
      }
      if (gen !== genRef.current) return { done: false, rest: [] };
      want(i + 2);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(entry!);
      at = Math.max(c.currentTime + 0.02, at);
      src.start(at);
      at += buf.duration + 0.05;
      sourcesRef.current.push(src);
      last = src;
    }
    if (!last) return { done: true, rest: [] };
    const end = last;
    await new Promise<void>((resolve) => { end.onended = () => resolve(); });
    sourcesRef.current = sourcesRef.current.filter((s) => s !== end);
    return { done: gen === genRef.current, rest: [] };
  }, [opts.aiEffect]);

  /**
   * Fala o texto. `append`: entra na fila depois do que está tocando (sem cortar).
   * Resolve `true` quando terminou de falar, `false` se foi interrompido.
   */
  const speak = useCallback((text: string, options: { append?: boolean } = {}): Promise<boolean> => {
    if (!canSpeak || !text.trim()) return Promise.resolve(true);
    if (!options.append) stopSpeaking();
    const gen = genRef.current;
    const useServer = opts.serverSpeech && servidorOk();
    // Voz do servidor aguenta trechos longos; a do navegador (Chrome) corta falas acima de ~15 s.
    const parts = useServer ? chunks(text, 160, 480) : chunks(text, 160, 220);
    pendingRef.current++;
    setSpeaking(true);
    const run = async (): Promise<boolean> => {
      if (gen !== genRef.current) return false;
      let rest = parts;
      if (useServer && servidorOk()) {
        const r = await speakServer(parts, gen);
        if (r.done || gen !== genRef.current) return r.done;
        rest = r.rest.length ? chunks(r.rest.join(' '), 160, 220) : [];
      }
      return speakBrowser(rest, () => gen === genRef.current);
    };
    const job = chainRef.current.then(run, run).finally(() => {
      if (gen !== genRef.current) return;
      pendingRef.current = Math.max(0, pendingRef.current - 1);
      if (pendingRef.current === 0) setSpeaking(false);
    });
    chainRef.current = job;
    return job;
  }, [canSpeak, opts.serverSpeech, speakServer, stopSpeaking]);

  /** Começa a ouvir; `onEnd` recebe a frase reconhecida (ou vazio e o motivo). */
  const startListening = useCallback(async (onEnd: ListenEnd) => {
    setError(null);
    setInterim('');
    stopSpeaking();
    audio();
    if (!window.isSecureContext) {
      setError('O microfone só funciona em HTTPS ou em localhost. Acesse o IA NOC por https://.');
      return onEnd('', 'error');
    }

    // Com transcrição no servidor (Whisper), grava e manda para lá: funciona igual em
    // qualquer navegador. O reconhecimento do próprio navegador depende de um serviço
    // externo que falha no Edge, Brave e navegadores embutidos (erro "network").
    const useRecorder = recorderStt && opts.serverTranscription;
    const Ctor = RecognitionCtor();
    if (Ctor && !useRecorder) {
      const rec = new Ctor();
      rec.lang = 'pt-BR';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let finalText = '';
      let failed = false;
      rec.onresult = (e) => {
        let partial = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else partial += r[0].transcript;
        }
        setInterim((finalText + ' ' + partial).trim());
      };
      rec.onerror = (e) => {
        if (e.error === 'aborted' || e.error === 'no-speech') return;
        failed = true;
        setError(RECOGNITION_ERRORS[e.error] ?? `Falha no reconhecimento de voz (${e.error}).`);
      };
      rec.onend = () => {
        setListening(false);
        setInterim('');
        recognitionRef.current = null;
        const text = finalText.trim();
        if (text) earcon('heard');
        onEnd(text, failed ? 'error' : text ? undefined : 'empty');
      };
      recognitionRef.current = rec;
      setListening(true);
      earcon('listen');
      try { rec.start(); } catch { setListening(false); onEnd('', 'error'); }
      return;
    }

    if (!(recorderStt && opts.serverTranscription)) {
      setError('Este navegador não reconhece voz. Use Chrome ou Edge, ou configure STT_BASE_URL no servidor.');
      return onEnd('', 'error');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const parts: Blob[] = [];
      let heardSpeech = false;

      // Fim da fala pelo silêncio: ~1,2 s quieto depois de ter falado; 7 s sem falar nada encerra.
      const c = audio();
      let vadTimer = 0;
      if (c) {
        const analyser = c.createAnalyser();
        analyser.fftSize = 1024;
        c.createMediaStreamSource(stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        const started = performance.now();
        let floor = 0.01; let lastLoud = started;
        vadTimer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0; for (const v of data) sum += v * v;
          const rms = Math.sqrt(sum / data.length);
          const now = performance.now();
          setLevel(Math.min(1, rms * 9));
          if (now - started < 350) { floor = Math.max(floor, rms); return; }
          if (rms > Math.max(0.02, floor * 2.5)) { heardSpeech = true; lastLoud = now; }
          if ((heardSpeech && now - lastLoud > 1200) || (!heardSpeech && now - started > 7000)) {
            if (recorder.state === 'recording') recorder.stop();
          }
        }, 100);
      }

      recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      recorder.onstop = async () => {
        window.clearInterval(vadTimer);
        setLevel(0);
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        recorderRef.current = null;
        const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 500 || (c && !heardSpeech)) return onEnd('', 'empty');
        earcon('heard');
        setTranscribing(true);
        try {
          const res = await fetch('/api/voice/transcribe', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': blob.type.split(';')[0] || 'audio/webm' },
            body: blob,
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          const text = String(body.text ?? '').trim();
          onEnd(text, text ? undefined : 'empty');
        } catch (e) {
          setError(`Transcrição falhou: ${e instanceof Error ? e.message : e}`);
          onEnd('', 'error');
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setListening(true);
      earcon('listen');
      setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 30000);
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError'
        ? RECOGNITION_ERRORS['not-allowed']
        : `Não consegui abrir o microfone: ${e instanceof Error ? e.message : e}`);
      onEnd('', 'error');
    }
  }, [opts.serverTranscription, recorderStt, stopSpeaking]);

  /** Para de ouvir e entrega o que já foi dito. */
  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  /** Para de ouvir e descarta o que foi dito. */
  const abortListening = useCallback(() => {
    if (recognitionRef.current) { recognitionRef.current.onend = null; recognitionRef.current.abort(); recognitionRef.current = null; }
    if (recorderRef.current?.state === 'recording') { recorderRef.current.onstop = null; recorderRef.current.stream.getTracks().forEach((t) => t.stop()); recorderRef.current.stop(); recorderRef.current = null; }
    setListening(false);
    setInterim('');
  }, []);

  useEffect(() => () => {
    recognitionRef.current?.abort();
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    genRef.current++;
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch { /* já parou */ } });
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  return {
    canListen, canSpeak, listening, transcribing, interim, speaking, error, level,
    clearError: () => setError(null),
    startListening, stopListening, abortListening, speak, stopSpeaking,
  };
}
