// Cloudflare Worker endpoint for claude-voice.js (production / wrangler deploy).
//
// Use it standalone (this file's default export serves /api/claude-voice and falls back
// to your static assets), or import { handleClaudeVoice } into your existing Worker:
//
//   import { handleClaudeVoice, CLAUDE_VOICE_PATH } from './engine/worker/claude-voice-api.js';
//   if (new URL(request.url).pathname === CLAUDE_VOICE_PATH) return handleClaudeVoice(request, env, ctx);
//
// Secrets/vars (push from .env with: node engine/server/push-secrets.mjs):
//   ANTHROPIC_API_KEY  (secret) Claude answers first
//   GEMINI_API_KEY     (secret) Gemini answers when Claude can't (no key, invalid key, no credits, busy).
//                      Why one was skipped shows on the page as a note. When both fail, the error is marked
//                      keys: true, and claude-voice.js tries the visitor's own key from the /keys page (Claude,
//                      Gemini, OpenAI, xAI, Groq, Perplexity or Pollinations; OWN_PROVIDERS below), sent in the
//                      x-provider-name / x-provider-key headers. A request with the visitor's own
//                      key uses only that key and needs no TEAM_PASSPHRASE, since the site's keys aren't spent.
//   CLAUDE_MODEL       (optional, default claude-opus-5-5)
//   GEMINI_MODEL       (optional, default gemini-flash-latest)
//   ALLOWED_ORIGINS    (optional, comma-separated; default = same origin only)
//   TEAM_PASSPHRASE    (secret, optional): when set, each request needs it (shared/passphrase.js). claude-voice.js
//                      asks for it on a 401 and keeps it in the browser, so only people given it use the key.
//                      handleClaudeVoice(..., { passphrase: true }) requires one to be set.

import { DEFAULT_MODEL, sanitizeMessages, standingIn, systemPrompt } from '../shared/voice-prompt.js';
import { streamClaude } from '../shared/anthropic.js';
import { GEMINI_DEFAULT_MODEL, streamGemini } from '../shared/gemini.js';
import { streamOpenAICompat } from '../shared/openai-compat.js';
import { PASSPHRASE_HEADER, passphraseRefusal } from '../shared/passphrase.js';

export const CLAUDE_VOICE_PATH = '/api/claude-voice';
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
    return { ok: true, headers: { 'access-control-allow-origin': origin, vary: 'Origin' } };
  }
  return { ok: false, headers: {} };
}

export async function handleClaudeVoice(request, env, ctx, { passphrase: required = false } = {}) {
  const { ok, headers: cors } = corsHeaders(request, env);
  if (!ok) return new Response('Origin not allowed', { status: 403 });

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': `content-type, ${PASSPHRASE_HEADER}, x-provider-name, x-provider-key`, 'access-control-max-age': '600' } });
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

  // Optional: bind a Cloudflare rate limiter named CLAUDE_VOICE_LIMITER in wrangler config.
  if (env.CLAUDE_VOICE_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    const { success } = await env.CLAUDE_VOICE_LIMITER.limit({ key: ip });
    if (!success) return Response.json({ error: 'Too many requests' }, { status: 429, headers: cors });
  }

  let messages = null, output = null;
  try {
    const body = await request.text();
    if (body.length <= 200_000) ({ messages, output } = JSON.parse(body));
    messages = sanitizeMessages(messages);
  } catch { messages = null; }
  if (!messages) return Response.json({ error: 'Bad request' }, { status: 400, headers: cors });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});

  // Claude first, then Gemini. A provider that fails before saying anything hands over to the next one.
  const system = systemPrompt(output);
  const claude = (apiKey) => ({ name: 'Claude', model: env.CLAUDE_MODEL || DEFAULT_MODEL,
    stream: (o) => streamClaude({ ...o, apiKey, model: env.CLAUDE_MODEL || DEFAULT_MODEL, system }) });
  const gemini = (apiKey) => ({ name: 'Gemini', model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL,
    stream: (o) => streamGemini({ ...o, apiKey, model: env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL, system: standingIn(system, 'Gemini') }) });
  const openaiStyle = (p, apiKey) => ({ name: p.name, model: p.model,
    stream: (o) => streamOpenAICompat({ ...o, provider: p.name, url: p.url, apiKey, model: p.model, system: standingIn(system, p.who) }) });
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
          await send({ t: 'agent', v: { name: `${p.name} API`, detail: whose, model: p.model } });
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
    if (new URL(request.url).pathname === CLAUDE_VOICE_PATH) return handleClaudeVoice(request, env, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
