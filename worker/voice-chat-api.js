// Cloudflare Worker endpoint for voice-chat.js (production / wrangler deploy).
//
// Use it standalone (this file's default export serves /api/voice-chat and falls back
// to your static assets), or import { handleVoiceChat } into your existing Worker:
//
//   import { handleVoiceChat, VOICE_CHAT_PATH } from './engine/worker/voice-chat-api.js';
//   if (new URL(request.url).pathname === VOICE_CHAT_PATH) return handleVoiceChat(request, env, ctx);
//
// Secrets/vars (push from .env with: node engine/server/push-secrets.mjs):
//   ANTHROPIC_API_KEY  (secret) Claude answers first
//   GEMINI_API_KEY     (secret) Gemini answers when Claude can't (no key, invalid key, no credits, busy).
//                      Why one was skipped shows on the page as a note. When both fail, the error is marked
//                      keys: true, and voice-chat.js tries the visitor's own key from the /keys page (Claude,
//                      Gemini, OpenAI, xAI, Groq, Perplexity or Pollinations; OWN_PROVIDERS below), sent in the
//                      x-provider-name / x-provider-key headers. A request with the visitor's own
//                      key uses only that key and needs no TEAM_PASSPHRASE, since the site's keys aren't spent.
//   CLAUDE_MODEL       (optional, default claude-opus-5-5)
//   GEMINI_MODEL       (optional, default gemini-flash-latest)
//   ALLOWED_ORIGINS    (optional, comma-separated; default = same origin only)
//   AI                 (Workers AI binding, optional): speech to text for browsers whose own speech input is missing or
//                      blocked, such as Brave and Firefox. .../status tells the page it's there, and .../transcribe turns
//                      each spoken turn (a 16 kHz WAV) into text with Whisper (TRANSCRIBE_MODEL), as the local bridge does
//                      with whisper.cpp. Bind it in wrangler: [ai] binding = "AI" (wrangler.toml) or "ai": { "binding": "AI" }.
//                      Like a conversation, it needs the team passphrase when one is set, or the visitor's own key.
//   Voices             .../voices and .../speak give the widget natural voices (shared/tts/index.js): Deepgram Aura-2
//                      through the AI binding (the default here), and Grok, ElevenLabs, OpenAI and Google Cloud with
//                      XAI_API_KEY, ELEVENLABS_API_KEY, OPENAI_API_KEY and GOOGLE_TTS_API_KEY (secrets, optional), or
//                      the visitor's own key for that source. Each sentence's audio is kept in the Cache API, so a
//                      greeting or a repeated question costs nothing the second time.
//   TEAM_PASSPHRASE    (secret, optional): when set, each request needs it (shared/passphrase.js). voice-chat.js
//                      asks for it on a 401 and trades it at /api/team-passphrase for a cookie page scripts can't
//                      read (handleTeamPassphrase there), so only people given it use the key.
//                      handleVoiceChat(..., { passphrase: true }) requires one to be set.
//
// handleVoiceChat(..., { tools: (env, { origin, page }) => toolkit }) gives Claude tools of its own, such as reading
// the site's code (CloudRoot's worker/src/site-code.js reads it from GitHub, where the local bridge reads files). Only
// for requests with the team passphrase, since tools can spend the site's tokens: the site's keys, or a visitor's own
// Claude key sent with the passphrase. toolkit: { definitions, run(name, input), target(name, input), prompt (added to
// the system prompt), label (for the settings panel's Agent section) }; see streamClaude in shared/anthropic.js.

import { DEFAULT_MODEL, sanitizeMessages, standingIn, systemPrompt } from '../shared/voice-prompt.js';
import { streamClaude } from '../shared/anthropic.js';
import { GEMINI_DEFAULT_MODEL, streamGemini } from '../shared/gemini.js';
import { streamOpenAICompat } from '../shared/openai-compat.js';
import { PASSPHRASE_HEADER, passphraseRefusal } from '../shared/passphrase.js';
import { listVoices, speakText, SOURCES as TTS_SOURCES } from '../shared/tts/index.js';

export const VOICE_CHAT_PATH = '/api/voice-chat';
// The conversation at VOICE_CHAT_PATH, plus .../status and .../transcribe under it
export const isVoiceChatPath = (path) => path === VOICE_CHAT_PATH || path.startsWith(VOICE_CHAT_PATH + '/');
const TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TRANSCRIBE_MAX_BYTES = 4_000_000; // A turn is at most 30 seconds, about 1 MB as a 16 kHz WAV
// The /keys page's provider ids (keys/providers.js) this endpoint can answer with, given the visitor's own key: name
// (in messages), who (in the prompt, standing in for Claude), and for OpenAI-style services their chat URL and a quick
// model suited to speech. The page's other providers (images, 3D, voices, search, data) can't hold a conversation.
const OWN_PROVIDERS = {
  anthropic: { name: 'Claude' },
  google: { name: 'Gemini', who: 'Gemini' },
  openai: { name: 'OpenAI', who: 'an OpenAI model', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-6-luna' },
  xai: { name: 'xAI', who: 'Grok', url: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.3' },
  groq: { name: 'Groq', who: 'an open model on Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  perplexity: { name: 'Perplexity', who: 'Perplexity', url: 'https://api.perplexity.ai/chat/completions', model: 'sonar' },
  pollinations: { name: 'Pollinations', who: 'a model on Pollinations', url: 'https://gen.pollinations.ai/v1/chat/completions', model: 'openai' },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return { ok: true, headers: {} };
  const self = new URL(request.url).origin;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin === self || allowed.includes(origin)) {
    // Credentials: the team passphrase's cookie, from a page on an allowed site.
    return { ok: true, headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } };
  }
  return { ok: false, headers: {} };
}

// .../status: what this Worker offers the page (voice-chat.js checkAgent). worker: true, since it has no view of
// running replies as the local bridge does.
function voiceStatus(env, cors) {
  const transcribe = env.AI ? { name: 'Whisper on Cloudflare', model: TRANSCRIBE_MODEL.split('/').pop(), local: false } : null;
  return Response.json({ worker: true, transcribe }, { headers: { ...cors, 'cache-control': 'no-store' } });
}

// .../transcribe?lang=en-US: a spoken turn as a WAV, back as { text } (or { error }).
async function voiceTranscribe(request, env, cors, required) {
  if (!env.AI) return Response.json({ error: 'Speech to text isn’t set up on this site (the Worker’s AI binding).' }, { status: 501, headers: cors });
  const ownName = String(request.headers.get('x-provider-name') || '').trim();
  const own = String(request.headers.get('x-provider-key') || '').trim() && OWN_PROVIDERS[ownName];
  if (!own) {
    const refusal = await passphraseRefusal(request, env, { required, to: 'talk' });
    if (refusal) return Response.json({ error: refusal.error, passphrase: refusal.passphrase }, { status: refusal.status, headers: cors });
  }
  if (env.VOICE_CHAT_LIMITER) {
    const { success } = await env.VOICE_CHAT_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'anon' });
    if (!success) return Response.json({ error: 'Too many requests' }, { status: 429, headers: cors });
  }
  const wav = new Uint8Array(await request.arrayBuffer());
  if (!wav.length || wav.length > TRANSCRIBE_MAX_BYTES) return Response.json({ error: wav.length ? 'That recording is too long.' : 'No recording was sent.' }, { status: 400, headers: cors });
  let b64 = '';
  for (let i = 0; i < wav.length; i += 0x8000) b64 += String.fromCharCode(...wav.subarray(i, i + 0x8000));
  const lang = (new URL(request.url).searchParams.get('lang') || '').split('-')[0].toLowerCase();
  try {
    const out = await env.AI.run(TRANSCRIBE_MODEL, { audio: btoa(b64), ...(/^[a-z]{2}$/.test(lang) && { language: lang }), vad_filter: true });
    // Whisper writes sounds as [Music] or (coughs), as the local bridge also leaves out (cleanText)
    const text = String(out?.text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    return Response.json({ text, via: 'Whisper on Cloudflare' }, { headers: { ...cors, 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json({ error: `Whisper on Cloudflare couldn’t turn it into text: ${err.message || err}` }, { status: 502, headers: cors });
  }
}

// .../voices: the sources this Worker can speak with, and their voices. ?own=xai,elevenlabs names the /keys page keys
// the visitor has, so sources needing one list their voices too.
async function voiceList(request, env, cors) {
  const ownNames = (new URL(request.url).searchParams.get('own') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const sources = await listVoices(env, { ownNames });
  return Response.json({ sources, defaultSource: env.AI ? 'aura' : 'browser' }, { headers: { ...cors, 'cache-control': 'no-store' } });
}

// .../speak { source, voice, text, lang }: one sentence as audio, with word timings in x-voice-words when the source
// gives them. A source using the site's own key or binding needs the team passphrase when one is set, as a
// conversation does. A keyed source takes the visitor's own key for it instead (an xAI key for Grok, say). Unlike
// .../transcribe, another of their keys doesn't open Aura, since an unchecked key header would spend the site's.
const SPEAK_CACHE_DAYS = 30;
async function voiceSpeak(request, env, ctx, cors, required) {
  let b = null;
  try { const t = await request.text(); if (t.length <= 8000) b = JSON.parse(t); } catch { b = null; }
  if (!b || typeof b.source !== 'string' || typeof b.text !== 'string' || !TTS_SOURCES[b.source]) return Response.json({ error: 'Bad request' }, { status: 400, headers: cors });
  const src = TTS_SOURCES[b.source];
  const ownName = String(request.headers.get('x-provider-name') || '').trim();
  const ownKey = String(request.headers.get('x-provider-key') || '').trim();
  const ownForSource = !!ownKey && !!src.own && ownName === src.own;
  if (!ownForSource) {
    const refusal = await passphraseRefusal(request, env, { required, to: 'use this voice' });
    if (refusal) return Response.json({ error: refusal.error, passphrase: refusal.passphrase }, { status: refusal.status, headers: cors });
  }
  if (env.VOICE_CHAT_LIMITER) {
    const { success } = await env.VOICE_CHAT_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'anon' });
    if (!success) return Response.json({ error: 'Too many requests' }, { status: 429, headers: cors });
  }
  const text = b.text.replace(/\s+/g, ' ').trim(), voice = String(b.voice || ''), lang = String(b.lang || '');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${voice}|${lang}|${text}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const cacheKey = new Request(`https://voice-chat.cache/${b.source}/${encodeURIComponent(voice)}/${hash}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const hit = cache && await cache.match(cacheKey).catch(() => null);
  if (hit) {
    const h = new Headers(hit.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    h.set('x-voice-cache', 'hit');
    h.set('access-control-expose-headers', 'x-voice-words, x-voice-source');
    return new Response(hit.body, { headers: h });
  }
  try {
    const out = await speakText(env, { source: b.source, voice, text, lang, own: ownForSource ? { name: ownName, key: ownKey } : null, signal: request.signal });
    const headers = { 'content-type': out.type, 'x-voice-source': b.source, ...(out.words && { 'x-voice-words': JSON.stringify(out.words) }) };
    if (cache) ctx?.waitUntil?.(cache.put(cacheKey, new Response(out.audio.slice(), { headers: { ...headers, 'cache-control': `public, max-age=${SPEAK_CACHE_DAYS * 86400}` } })).catch(() => {}));
    return new Response(out.audio, { headers: { ...cors, ...headers, 'access-control-expose-headers': 'x-voice-words, x-voice-source', 'cache-control': 'no-store' } });
  } catch (err) {
    return Response.json({ error: err.message || 'That voice couldn’t speak.', ...(err.needsKey && { needsKey: true }) }, { status: err.status || 502, headers: cors });
  }
}

export async function handleVoiceChat(request, env, ctx, { passphrase: required = false, tools = null } = {}) {
  const { ok, headers: cors } = corsHeaders(request, env);
  if (!ok) return new Response('Origin not allowed', { status: 403 });
  const path = new URL(request.url).pathname;
  if (path === VOICE_CHAT_PATH + '/status' && request.method === 'GET') return voiceStatus(env, cors);
  if (path === VOICE_CHAT_PATH + '/transcribe' && request.method === 'POST') return voiceTranscribe(request, env, cors, required);
  if (path === VOICE_CHAT_PATH + '/voices' && request.method === 'GET') return voiceList(request, env, cors);
  if (path === VOICE_CHAT_PATH + '/speak' && request.method === 'POST') return voiceSpeak(request, env, ctx, cors, required);
  if (path !== VOICE_CHAT_PATH && request.method !== 'OPTIONS') return Response.json({ error: 'Not found' }, { status: 404, headers: cors });

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': `content-type, ${PASSPHRASE_HEADER}, x-provider-name, x-provider-key`, 'access-control-expose-headers': 'x-voice-words, x-voice-source', 'access-control-max-age': '600' } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  // The visitor's own key (the /keys page's "anthropic" or "google"), or else the site's keys behind the passphrase.
  const ownName = String(request.headers.get('x-provider-name') || '').trim();
  const ownKey = String(request.headers.get('x-provider-key') || '').trim();
  const own = ownKey && OWN_PROVIDERS[ownName];
  if (ownKey && !own) return Response.json({ error: `A ${ownName || 'key with no provider'} key can't hold a conversation here. Use a Claude, Gemini, OpenAI, xAI, Groq, Perplexity or Pollinations key.` }, { status: 400, headers: cors });
  if (!own) {
    if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) return Response.json({ error: 'Neither the ANTHROPIC_API_KEY nor the GEMINI_API_KEY secret is set.', keys: true }, { status: 500, headers: cors });
    const refusal = await passphraseRefusal(request, env, { required, to: 'talk to Claude' });
    if (refusal) return Response.json({ error: refusal.error, passphrase: refusal.passphrase }, { status: refusal.status, headers: cors });
  }

  // Optional: bind a Cloudflare rate limiter named VOICE_CHAT_LIMITER in wrangler config.
  if (env.VOICE_CHAT_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    const { success } = await env.VOICE_CHAT_LIMITER.limit({ key: ip });
    if (!success) return Response.json({ error: 'Too many requests' }, { status: 429, headers: cors });
  }

  let messages = null, output = null, page = null, voice = null, pageActions = null;
  try {
    const body = await request.text();
    if (body.length <= 200_000) ({ messages, output, page, voice, tools: pageActions } = JSON.parse(body));
    messages = sanitizeMessages(messages);
  } catch { messages = null; }
  if (!messages) return Response.json({ error: 'Bad request' }, { status: 400, headers: cors });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});

  // Claude first, then Gemini. A provider that fails before saying anything hands over to the next one.
  const system = systemPrompt(output, page, voice, pageActions);
  const gemini = (apiKey) => ({ name: 'Gemini', model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL,
    stream: (o) => streamGemini({ ...o, apiKey, model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL, system: standingIn(system, 'Gemini') }) });
  const openaiStyle = (p, apiKey) => ({ name: p.name, model: p.model,
    stream: (o) => streamOpenAICompat({ ...o, provider: p.name, url: p.url, apiKey, model: p.model, system: standingIn(system, p.who) }) });
  // Tools only for those with the passphrase (a visitor using their own key may send it too), even where it isn't required.
  const team = tools && !(await passphraseRefusal(request, env, { required: true }));
  const toolkit = team ? tools(env, { origin: new URL(request.url).origin, page }) : null;
  const claude = (apiKey) => ({ name: 'Claude', model: env.CLAUDE_MODEL || DEFAULT_MODEL, files: toolkit?.label,
    stream: (o) => streamClaude({ ...o, apiKey, model: env.CLAUDE_MODEL || DEFAULT_MODEL, system: toolkit ? system + toolkit.prompt : system,
      tools: toolkit, onTool: (tool) => send({ t: 'tool', v: tool }), onThinking: (v) => send({ t: 'thinking', v }) }) });
  const providers = own
    ? [own.name === 'Claude' ? claude(ownKey) : own.name === 'Gemini' ? gemini(ownKey) : openaiStyle(own, ownKey)]
    : [env.ANTHROPIC_API_KEY && claude(env.ANTHROPIC_API_KEY), env.GEMINI_API_KEY && gemini(env.GEMINI_API_KEY)].filter(Boolean);
  const whose = own ? 'your key from the Keys page' : 'the site\'s API key';
  const work = (async () => {
    const failed = []; // why each earlier provider couldn't answer, one sentence each
    try {
      for (const p of providers) {
        let spoke = false;
        try {
          // For the settings panel's Agent section: what's answering, then the reply's token counts.
          await send({ t: 'agent', v: { name: `${p.name} API`, detail: whose, model: p.model, ...(p.files && { files: p.files }) } });
          await p.stream({
            messages,
            signal: request.signal,
            onText: (text) => {
              // Once a fallback starts answering, say why the providers before it didn't.
              if (!spoke && failed.length) send({ t: 'note', v: `${failed.join(' ')} ${p.name} is answering instead.` });
              spoke = true;
              return send({ t: 'text', v: text });
            },
            onUsage: (usage) => send({ t: 'usage', v: usage }),
          });
          await send({ t: 'done' });
          return;
        } catch (err) {
          if (spoke || request.signal.aborted) throw err; // part of the reply is already out
          const why = err.message || `The ${p.name} API key couldn't answer.`;
          failed.push(own ? why.replace(/^The /, 'Your ') : why);
        }
      }
      throw Object.assign(new Error(failed.join(' | ')), { allFailed: true });
    } catch (err) {
      // keys: true when every one of the site's keys failed, so the page can offer the visitor's own.
      await send({ t: 'error', v: err.message || 'Upstream error', ...(err.allFailed && !own && { keys: true }) });
    } finally {
      writer.close().catch(() => {});
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);

  return new Response(readable, {
    headers: { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (isVoiceChatPath(new URL(request.url).pathname)) return handleVoiceChat(request, env, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
