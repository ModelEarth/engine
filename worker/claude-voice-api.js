// Cloudflare Worker endpoint for claude-voice.js (production / wrangler deploy).
//
// Use it standalone (this file's default export serves /api/claude-voice and falls back
// to your static assets), or import { handleClaudeVoice } into your existing Worker:
//
//   import { handleClaudeVoice, CLAUDE_VOICE_PATH } from './engine/worker/claude-voice-api.js';
//   if (new URL(request.url).pathname === CLAUDE_VOICE_PATH) return handleClaudeVoice(request, env, ctx);
//
// Secrets/vars (push from .env with: node engine/server/push-secrets.mjs):
//   ANTHROPIC_API_KEY  (secret, required)
//   CLAUDE_MODEL       (optional, default claude-opus-5-5)
//   ALLOWED_ORIGINS    (optional, comma-separated; default = same origin only)
//   TEAM_PASSPHRASE    (secret, optional): when set, each request needs it (shared/passphrase.js). claude-voice.js
//                      asks for it on a 401 and keeps it in the browser, so only people given it use the key.
//                      handleClaudeVoice(..., { passphrase: true }) requires one to be set.

import { DEFAULT_MODEL, sanitizeMessages, systemPrompt } from '../shared/voice-prompt.js';
import { streamClaude } from '../shared/anthropic.js';
import { PASSPHRASE_HEADER, passphraseRefusal } from '../shared/passphrase.js';

export const CLAUDE_VOICE_PATH = '/api/claude-voice';

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
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': `content-type, ${PASSPHRASE_HEADER}`, 'access-control-max-age': '600' } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  if (!env.ANTHROPIC_API_KEY) return Response.json({ error: 'ANTHROPIC_API_KEY secret is not set' }, { status: 500, headers: cors });

  const refusal = await passphraseRefusal(request, env, { required, to: 'talk to Claude' });
  if (refusal) return Response.json({ error: refusal.error, passphrase: refusal.passphrase }, { status: refusal.status, headers: cors });

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

  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  const work = (async () => {
    try {
      // For the settings panel's Agent section: what's answering, then the reply's token counts.
      await send({ t: 'agent', v: { name: 'Claude API', detail: 'the site\'s API key', model } });
      await streamClaude({
        apiKey: env.ANTHROPIC_API_KEY,
        model,
        system: systemPrompt(output),
        messages,
        signal: request.signal,
        onText: (text) => send({ t: 'text', v: text }),
        onUsage: (usage) => send({ t: 'usage', v: usage }),
      });
      await send({ t: 'done' });
    } catch (err) {
      await send({ t: 'error', v: err.message || 'Upstream error' });
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
