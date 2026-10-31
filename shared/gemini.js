// Minimal streaming client for the Gemini API, the voice endpoint's fallback when Claude can't answer.
// Same shape as streamClaude (anthropic.js), and runs in Node 18+ and Cloudflare Workers.

import { ProviderError, providerError } from './provider-error.js';

// gemini-flash-latest follows Google's current Flash model, which is quick enough for speech.
export const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';

// messages: [{ role: "user" | "assistant", content }], alternating and ending with the user (sanitizeMessages).
// onUsage gets { input, cacheRead, output } once the reply is complete. A refusal throws a ProviderError.
export async function streamGemini({ apiKey, model = GEMINI_DEFAULT_MODEL, system, messages, maxTokens = 700, signal, onText, onUsage }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok || !res.body) throw providerError('Gemini', res.status, await res.text().catch(() => ''));

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
      if (evt.error) throw new ProviderError('Gemini', evt.error.code || 500, evt.error.message || '', 'other', `Gemini API error: ${evt.error.message || 'unknown'}`);
      for (const part of evt.candidates?.[0]?.content?.parts || []) if (part.text && !part.thought) onText(part.text);
      const u = evt.usageMetadata;
      if (u) usage = { input: (u.promptTokenCount || 0) - (u.cachedContentTokenCount || 0), cacheRead: u.cachedContentTokenCount, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
    }
  }
  if (onUsage) onUsage(usage);
}
