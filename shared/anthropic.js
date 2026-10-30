// Minimal streaming client for the Claude Messages API.
// Runs unchanged in Node 18+ and Cloudflare Workers (fetch + web streams).

import { SYSTEM_PROMPT } from './voice-prompt.js';

export async function streamClaude({ apiKey, model, messages, maxTokens = 700, signal, onText }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages, stream: true }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5)); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') onText(evt.delta.text);
      else if (evt.type === 'error') throw new Error(evt.error?.message || 'Claude API stream error');
    }
  }
}
