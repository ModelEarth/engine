// Minimal streaming client for OpenAI-style chat completions (OpenAI, xAI, Groq, Perplexity, Pollinations),
// used when a visitor answers with their own key from the /keys page. Same shape as streamClaude (anthropic.js).

import { ProviderError, providerError } from './provider-error.js';

// provider: the name in messages, such as "OpenAI". messages: [{ role: "user" | "assistant", content }].
// onUsage gets { input, cacheRead, output } when the service reports it. A refusal throws a ProviderError.
export async function streamOpenAICompat({ provider, url, apiKey, model, system, messages, maxTokens = 700, signal, onText, onUsage }) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
  });

  if (!res.ok || !res.body) throw providerError(provider, res.status, await res.text().catch(() => ''));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      let evt;
      try { evt = JSON.parse(line.slice(5)); } catch { continue; }
      if (evt.error) throw new ProviderError(provider, 500, evt.error.message || '', 'other', `${provider} API error: ${evt.error.message || 'unknown'}`);
      const text = evt.choices?.[0]?.delta?.content;
      if (text) onText(text);
      const u = evt.usage;
      if (u) usage = { input: (u.prompt_tokens || 0) - (u.prompt_tokens_details?.cached_tokens || 0), cacheRead: u.prompt_tokens_details?.cached_tokens, output: u.completion_tokens };
    }
  }
  if (onUsage && usage) onUsage(usage);
}
