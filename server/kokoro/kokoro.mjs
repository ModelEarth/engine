// Kokoro (Kokoro-82M, open source, Apache 2.0) for the local bridge: free and offline, on this computer's CPU. The
// model (about 90 MB at q8) downloads from Hugging Face on first use and stays cached; it loads on the first request
// and stays in memory. KOKORO_DTYPE: q8 (default), q4, fp16 or fp32. Only American and British English voices.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const installed = () => existsSync(path.join(HERE, 'node_modules', 'kokoro-js'));

import { voices } from '../../shared/tts/kokoro-voices.js';

export { voices };

let ready = null, loadMs = 0;
function model() {
  if (!ready) {
    const started = Date.now();
    ready = import('kokoro-js')
      .then(({ KokoroTTS }) => KokoroTTS.from_pretrained(MODEL_ID, { dtype: process.env.KOKORO_DTYPE || 'q8', device: 'cpu' }))
      .then((tts) => { loadMs = Date.now() - started; return tts; })
      .catch((err) => { ready = null; throw err; });
  }
  return ready;
}
export const loadTime = () => loadMs;
export const warm = () => model().then(() => true, () => false);

// One request at a time: the model runs on the CPU, and overlapping ones only slow each other down.
let queue = Promise.resolve();
export function speak({ text, voice }) {
  const run = queue.then(async () => {
    const tts = await model();
    const out = await tts.generate(text, { voice: voices.some((v) => v.id === voice) || /^[ab][fm]_[a-z]+$/.test(voice) ? voice : 'af_heart' });
    return { audio: new Uint8Array(out.toWav()), type: 'audio/wav' };
  });
  queue = run.catch(() => {});
  return run;
}
