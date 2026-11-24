/* Kokoro in the visitor's own browser, for the voice widget (js/voice-chat.js), which imports this module only when a
   Kokoro voice is chosen where the local bridge doesn't have Kokoro (the deployed site, say). Free, with no account,
   and nothing is sent to a server: kokoro-js (KOKORO_JS, a pinned version) runs the Kokoro-82M model in a Web Worker,
   so the page stays responsive. setup() picks how (SETUPS), measured on an M-series Mac in Chrome, Nov 2026:
   - webgpu: the fp16 model (163 MB) on the graphics chip. About 0.3 seconds for a 5-second sentence, and 7 seconds to
     load from the cache. (q8 on WebGPU was no faster than WebAssembly; fp32 is as fast as fp16 at twice the size.)
   - wasm: the q8 model (92 MB) with WebAssembly, where WebGPU is missing. About 9 seconds for a 5-second sentence: one
     thread only, since the site isn't cross-origin isolated, so speech pauses between sentences.
   Either also needs the onnxruntime WebAssembly file (about 22 MB).

   Nothing downloads until the visitor agrees in the dialog (confirm), which gives the size. The model is kept in the
   browser's Cache API for this site
   ("transformers-cache"), so restarting the browser doesn't download it again. It downloads again only if the
   site's data is cleared, in a private window, or if the browser removes it to free space (Safari can, after
   several weeks without a visit). After the download the browser is asked to keep it (navigator.storage.persist). */

const KOKORO_JS = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const CACHE_NAME = 'transformers-cache';
// mb: the whole download (the model, the runtime and a voice at 0.5 MB each).
const SETUPS = {
  webgpu: { device: 'webgpu', dtype: 'fp16', file: 'model_fp16.onnx', mb: 185 },
  wasm: { device: 'wasm', dtype: 'q8', file: 'model_quantized.onnx', mb: 115, slow: true },
};
const modelURL = (s) => `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/${s.file}`;
let chosen = null;
export function setup() {
  if (!chosen) chosen = (async () => {
    try { if (navigator.gpu && await navigator.gpu.requestAdapter()) return SETUPS.webgpu; } catch (e) { /* no WebGPU */ }
    return SETUPS.wasm;
  })();
  return chosen;
}
const AGREED_KEY = 'voice-chat:kokoro'; // "agreed" once the visitor has said yes to the download

let worker = null, ready = null, seq = 0;
const waiting = new Map();
let onProgress = null;

function startWorker() {
  if (worker) return worker;
  const src = `
    import { KokoroTTS } from '${KOKORO_JS}';
    let tts = null;
    self.onmessage = async ({ data: m }) => {
      try {
        if (m.t === 'load') {
          const files = {};
          tts = await KokoroTTS.from_pretrained('${MODEL_ID}', { dtype: m.dtype, device: m.device, progress_callback: (p) => {
            if (p.status === 'progress' && p.file) { files[p.file] = [p.loaded || 0, p.total || 0]; }
            const all = Object.values(files);
            self.postMessage({ t: 'progress', loaded: all.reduce((a, f) => a + f[0], 0), total: all.reduce((a, f) => a + f[1], 0) });
          } });
          self.postMessage({ id: m.id, ok: true });
        } else if (m.t === 'speak') {
          const audio = await tts.generate(m.text, { voice: m.voice });
          const wav = audio.toWav();
          self.postMessage({ id: m.id, ok: true, wav }, [wav]);
        }
      } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
    };`;
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.t === 'progress') { if (onProgress) onProgress(m.loaded, m.total); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.resolve(m); else w.reject(new Error(m.error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'Kokoro couldn’t start in this browser.');
    for (const w of waiting.values()) w.reject(err);
    waiting.clear(); worker = null; ready = null;
  };
  return worker;
}
function ask(msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); startWorker().postMessage({ ...msg, id }, transfer || []); });
}

export const supported = () => typeof Worker === 'function' && typeof WebAssembly === 'object' && 'caches' in window && window.isSecureContext;
export function agreed() { try { return localStorage.getItem(AGREED_KEY) === 'agreed'; } catch (e) { return false; } }

// Whether the model is in this browser's cache, so Kokoro can start with no download.
export async function cached() {
  try { return !!(await (await caches.open(CACHE_NAME)).match(modelURL(await setup()))); } catch (e) { return false; }
}
export async function cachedMB() {
  try {
    const cache = await caches.open(CACHE_NAME);
    let bytes = 0;
    for (const req of await cache.keys()) {
      if (!req.url.includes('Kokoro-82M')) continue;
      const res = await cache.match(req);
      bytes += Number(res.headers.get('content-length')) || (await res.clone().blob()).size;
    }
    return Math.round(bytes / 1e6);
  } catch (e) { return 0; }
}

// Loads the model (from the cache, or downloading it). progress(loaded, total) in bytes.
export function load(progress) {
  onProgress = progress || null;
  if (!ready) {
    ready = setup().then((s) => ask({ t: 'load', device: s.device, dtype: s.dtype })).then(() => {
      try { localStorage.setItem(AGREED_KEY, 'agreed'); } catch (e) { /* storage blocked */ }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      return true;
    }).catch((err) => { ready = null; throw err; });
  }
  return ready;
}
export const loaded = () => !!ready;

// One sentence as { blob, words: null } (Kokoro gives no word timings, so the player estimates them).
export async function speak(text, voice, signal) {
  await load();
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const m = await ask({ t: 'speak', text, voice });
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return { blob: new Blob([m.wav], { type: 'audio/wav' }), words: null };
}

// Removes the files from this browser and forgets the agreement, so choosing Kokoro asks again.
export async function remove() {
  if (worker) { worker.terminate(); worker = null; ready = null; }
  try { localStorage.removeItem(AGREED_KEY); } catch (e) { /* storage blocked */ }
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const req of await cache.keys()) if (req.url.includes('Kokoro-82M')) await cache.delete(req);
  } catch (e) { /* nothing cached */ }
}

// The dialog before the download: resolves true once Kokoro has loaded or while it downloads out of sight (Hide), and
// false for Not now or a failed download.
export async function confirm({ name = 'Kokoro' } = {}) {
  const how = await setup();
  return new Promise((resolve) => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        dialog { max-width: min(440px, calc(100vw - 32px)); padding: 20px 22px; border: 1px solid rgba(255,255,255,.18); border-radius: 16px;
          background: rgba(18,22,34,.96); color: #f4f6fb; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 18px 60px rgba(0,0,0,.45); }
        dialog::backdrop { background: rgba(0,0,0,.45); }
        h2 { margin: 0 0 10px; font-size: 19px; font-weight: 600; }
        p { margin: 0 0 10px; }
        small { display: block; color: #b9c0d0; font-size: 13px; }
        .bar { height: 8px; margin: 12px 0 4px; border-radius: 4px; background: rgba(255,255,255,.12); overflow: hidden; }
        .bar > span { display: block; height: 100%; width: 0; background: #6fd3a8; transition: width .3s; }
        .row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
        button { padding: 7px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,.3); background: transparent; color: inherit; font: inherit; cursor: pointer; }
        button.go { background: #f4f6fb; color: #121622; border-color: #f4f6fb; font-weight: 600; }
        button:focus-visible { outline: 2px solid #8fd0ff; outline-offset: 2px; }
        [hidden] { display: none !important; }
      </style>
      <dialog aria-labelledby="kt">
        <h2 id="kt">Download the Kokoro voice?</h2>
        <div class="ask">
          <p>${name} is a free, natural voice that runs in this browser. There's no account, and what it says isn't sent to a server.</p>
          <p>It needs a one-time download of about ${how.mb} MB.${how.slow ? ' This browser can’t run it on the graphics chip (WebGPU), so it may pause between sentences.' : ''}</p>
          <small>The files are kept in this browser for this site, so restarting the browser doesn't download them again. They download again only if this site's data is cleared, in a private window, or if the browser removes them to free space. Safari can also remove them after several weeks without a visit.</small>
        </div>
        <div class="busy" hidden>
          <p class="status">Downloading…</p>
          <div class="bar"><span></span></div>
          <small>Your current voice speaks meanwhile. Kokoro takes over once it's ready.</small>
        </div>
        <div class="row">
          <button type="button" class="no">Not now</button>
          <button type="button" class="go">Download</button>
        </div>
      </dialog>`;
    document.body.appendChild(host);
    const dlg = root.querySelector('dialog'), go = root.querySelector('.go'), no = root.querySelector('.no');
    const status = root.querySelector('.status'), bar = root.querySelector('.bar > span');
    let done = false, busy = false;
    const finish = (ok) => { if (done) return; done = true; try { dlg.close(); } catch (e) { /* closed */ } host.remove(); resolve(ok); };
    dlg.addEventListener('cancel', () => finish(busy));
    no.addEventListener('click', () => finish(busy));
    go.addEventListener('click', () => {
      busy = true;
      root.querySelector('.ask').hidden = true; root.querySelector('.busy').hidden = false;
      go.hidden = true; no.textContent = 'Hide';
      root.getElementById('kt').textContent = 'Downloading Kokoro';
      load((got, total) => {
        const mb = (n) => Math.round(n / 1e6);
        status.textContent = total > 1e6 ? `${mb(got)} of ${mb(total)} MB` : 'Starting…';
        bar.style.width = `${total ? Math.min(100, (got / total) * 100) : 0}%`;
      }).then(() => finish(true), (err) => {
        busy = false;
        status.textContent = `The download didn't finish: ${err.message}`;
        no.textContent = 'Close';
        no.onclick = () => finish(false);
      });
    });
    dlg.showModal();
    go.focus();
  });
}
