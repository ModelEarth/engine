// Text to speech for the voice widget (js/voice-chat.js): the voices behind GET .../voices and POST .../speak, on the
// local bridge (server/local-bridge.mjs) and the Worker (worker/voice-chat-api.js). Each source is its own module,
// imported the first time it's listed or used, so a source nobody uses (ElevenLabs without a key, say) never loads.
//
// A source module exports:
//   voices: [{ id, name, lang, gender, style, note }]   a curated list, best first (style: a VOICE_STYLES key in js/voice-chat.js)
//   speak({ text, voice, lang, key, env, signal }) → { audio: Uint8Array, type, words? }
//     words: [[charIndex, seconds], ...], when each word starts, for sources that give timings.
//
// SOURCES: label (shown with each voice), key (the env var holding the site's key) and own (the /keys page provider id
// for a visitor's own key). A source with neither key nor own has available(env) instead. The bridge adds Kokoro
// (server/kokoro/) through `extra`, since its npm packages can't go in the Worker.

import { voices as kokoroVoices } from './kokoro-voices.js';

export const SOURCES = {
  aura: { label: 'Aura', name: 'Deepgram Aura-2', available: (env) => !!env.AI, load: () => import('./aura.js') },
  grok: { label: 'Grok', name: 'Grok (xAI)', key: 'XAI_API_KEY', own: 'xai', load: () => import('./grok.js') },
  elevenlabs: { label: 'ElevenLabs', name: 'ElevenLabs', key: 'ELEVENLABS_API_KEY', own: 'elevenlabs', load: () => import('./elevenlabs.js') },
  openai: { label: 'OpenAI', name: 'OpenAI', key: 'OPENAI_API_KEY', own: 'openai', load: () => import('./openai.js') },
  google: { label: 'Google', name: 'Google Cloud (Chirp 3 HD)', key: 'GOOGLE_TTS_API_KEY', own: 'google-tts', load: () => import('./google.js') },
};
export const SPEAK_MAX_CHARS = 600; // one sentence at a time

const loaded = new Map();
function load(sources, id) {
  if (!loaded.has(id)) loaded.set(id, sources[id].load().catch((err) => { loaded.delete(id); throw err; }));
  return loaded.get(id);
}
const allSources = (extra) => ({ ...(extra || {}), ...SOURCES });
// A placeholder left from an example env file (your-openai-key, sk-...) counts as no key.
const keyOf = (env, s) => { const k = (s.key && String(env[s.key] || '').trim()) || ''; return /^your[-_]|\.\.\.|^x+$/i.test(k) ? '' : k; };

// The sources this server can speak with, each with its voices. ownNames: /keys page provider ids the visitor has a
// key for, so sources needing one list their voices too. A keyed source with no key anywhere is listed without voices
// (needsKey), so the page can say a key would add it.
export async function listVoices(env, { extra, ownNames = [] } = {}) {
  const sources = allSources(extra);
  const out = [];
  for (const [id, s] of Object.entries(sources)) {
    const site = s.available ? !!s.available(env) : !!keyOf(env, s);
    const own = !!s.own && ownNames.includes(s.own);
    if (!site && !own && !s.own) continue;
    const entry = { id, label: s.label, name: s.name, local: !!s.local, ...(s.own && { own: s.own }), ...(!site && { needsKey: true }) };
    if (site || own) {
      try { entry.voices = (await load(sources, id)).voices; } catch (err) { entry.error = err.message; }
    }
    out.push(entry);
  }
  // Kokoro in the visitor's own browser (js/voice-kokoro.js), after they agree to its download. Listed on any site.
  out.push({ id: 'kokoro-web', label: 'Kokoro', name: 'Kokoro (in this browser)', browser: true, voices: kokoroVoices });
  return out;
}

// One sentence as audio. own: { name, key }, the visitor's own key (x-provider-name / x-provider-key), used when it's
// for this source. Throws an Error with .status for the reply.
export async function speakText(env, { source, voice, text, lang, own, signal, extra } = {}) {
  const sources = allSources(extra);
  const s = sources[source];
  if (!s) throw Object.assign(new Error(`No voice source called ${source}.`), { status: 400 });
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) throw Object.assign(new Error('No text to speak.'), { status: 400 });
  if (text.length > SPEAK_MAX_CHARS) throw Object.assign(new Error(`Send one sentence at a time (up to ${SPEAK_MAX_CHARS} characters).`), { status: 413 });
  const ownKey = own && s.own && own.name === s.own ? own.key : '';
  const key = ownKey || keyOf(env, s);
  if (!s.available && !key) throw Object.assign(new Error(`${s.name} needs a key (${s.key}, or your own on the Keys page).`), { status: 401, needsKey: true });
  if (s.available && !s.available(env)) throw Object.assign(new Error(`${s.name} isn’t set up here.`), { status: 501 });
  const mod = await load(sources, source);
  const v = mod.voices.find((x) => x.id === voice) || (voice && /^[\w.-]{1,64}$/.test(voice) ? { id: voice } : mod.voices[0]);
  const out = await mod.speak({ text, voice: v.id, lang: lang || v.lang || 'en-US', key, env, signal });
  return { ...out, voice: v.id, ownKey: !!ownKey };
}

// A provider's refusal as an Error with the status to reply with, and a short reason.
export async function ttsError(name, res) {
  const body = await res.text().catch(() => '');
  let detail = '';
  try { const j = JSON.parse(body); detail = j.error?.message || j.detail?.message || j.message || j.error || (typeof j.detail === 'string' ? j.detail : ''); } catch { detail = body; }
  detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 200);
  const why = res.status === 401 || res.status === 403 ? 'refused the key' : res.status === 429 ? 'is busy or out of credits' : res.status === 402 ? 'is out of credits' : `answered ${res.status}`;
  return Object.assign(new Error(`${name} ${why}${detail ? `: ${detail}` : '.'}`), { status: res.status === 401 || res.status === 403 ? 401 : res.status === 429 || res.status === 402 ? 429 : 502 });
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Word start times from per-character ones: [[charIndex, seconds], ...] for each character that starts a word.
export function wordsFromChars(chars, starts) {
  const words = [];
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i]) || (i && !/\s/.test(chars[i - 1]))) continue;
    words.push([i, Math.round(Number(starts[i]) * 1000) / 1000]);
  }
  return words;
}
