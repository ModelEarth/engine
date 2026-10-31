// Minimal streaming client for the Claude Messages API.
// Runs unchanged in Node 18+ and Cloudflare Workers (fetch + web streams).

import { SYSTEM_PROMPT } from './voice-prompt.js';
import { ProviderError, providerError } from './provider-error.js';

// onUsage, if given, gets the reply's token counts ({ input, cacheRead, cacheWrite, output }) once it's complete.
// A refusal throws a ProviderError (provider-error.js), which says whether the key is invalid or out of credits.
export async function streamClaude({ apiKey, model, system = SYSTEM_PROMPT, messages, maxTokens = 700, signal, onText, onUsage }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw providerError('Claude', res.status, await res.text().catch(() => ''));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', usage = {};
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
      else if (evt.type === 'message_start' && evt.message?.usage) {
        const u = evt.message.usage;
        usage = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens };
      } else if (evt.type === 'message_delta' && evt.usage) usage.output = evt.usage.output_tokens;
      else if (evt.type === 'error') {
        const busy = evt.error?.type === 'overloaded_error';
        throw new ProviderError('Claude', busy ? 529 : 500, evt.error?.message || '', busy ? 'busy' : 'other',
          busy ? 'Claude is busy right now (529).' : `Claude API stream error: ${evt.error?.message || 'unknown'}`);
      }
    }
  }
  if (onUsage) onUsage(usage);
}
