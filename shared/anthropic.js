// Minimal streaming client for the Claude Messages API.
// Runs unchanged in Node 18+ and Cloudflare Workers (fetch + web streams).

import { SYSTEM_PROMPT } from './voice-prompt.js';
import { ProviderError, providerError } from './provider-error.js';

// onUsage, if given, gets the reply's token counts ({ input, cacheRead, cacheWrite, output }) once it's complete.
// A refusal throws a ProviderError (provider-error.js), which says whether the key is invalid or out of credits.
// tools, if given, are Claude's own tools for this reply: { definitions, run(name, input) -> Promise<string>,
// target(name, input) -> string }. Claude may call them several times (up to maxRounds) before it finishes; onTool
// gets { name, target } as each one starts. Without tools, the reply is one request, as before.
export async function streamClaude({ apiKey, model, system = SYSTEM_PROMPT, messages, maxTokens, signal, onText, onUsage, tools, onTool, maxRounds = 12 }) {
  const convo = [...messages];
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let spoke = false, reply = null;
  for (let round = 1; ; round++) {
    const last = round > maxRounds; // out of rounds: answer from what's been found, with no more tool calls
    reply = await streamOnce({
      apiKey, model, system, messages: convo, signal,
      maxTokens: maxTokens || (tools ? 16000 : 700),
      tools: tools && tools.definitions, noMoreTools: last,
      // Claude may speak, use tools, then speak again: a line break keeps the sentences either side apart.
      onText: (text) => { if (!spoke) spoke = true; else if (reply.fresh) onText('\n'); reply.fresh = false; return onText(text); },
    }, (r) => { reply = r; });
    for (const k of Object.keys(total)) total[k] += reply.usage[k] || 0;
    const calls = reply.content.filter((b) => b.type === 'tool_use');
    // Only a reply that stopped to use tools has calls to run: one cut off (max_tokens) or refused may hold a partial call.
    if (reply.stop !== 'tool_use' || !calls.length || !tools || last) break;
    // Claude's whole turn goes back unchanged, thinking blocks and all, then every call's result in one message.
    convo.push({ role: 'assistant', content: reply.content });
    const results = await Promise.all(calls.map(async (call) => {
      if (reply.invalid.has(call.id)) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_JSON: reply.invalid.get(call.id) }) };
      if (onTool) onTool({ name: call.name, target: tools.target ? tools.target(call.name, call.input) : '' });
      try {
        return { type: 'tool_result', tool_use_id: call.id, content: String(await tools.run(call.name, call.input)) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: err.message || 'The tool failed.' };
      }
    }));
    if (signal?.aborted) break;
    convo.push({ role: 'user', content: results });
  }
  if (onUsage) onUsage(total);
}

// One request, streamed. Gives setReply the reply as it builds: { content (the blocks, to send back with tool
// results), stop (stop_reason), usage, fresh (true until this request's first text), invalid (tool call id -> its
// input, when that isn't JSON) }.
async function streamOnce({ apiKey, model, system, messages, maxTokens, signal, onText, tools, noMoreTools }, setReply) {
  const reply = { content: [], stop: null, usage: {}, fresh: true, invalid: new Map() };
  setReply(reply);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system, messages, stream: true,
      // With tools, each round resends the conversation so far, so it's cached.
      ...(tools && { tools, cache_control: { type: 'ephemeral' } }),
      ...(noMoreTools && { tool_choice: { type: 'none' } }),
    }),
  });

  if (!res.ok || !res.body) {
    throw providerError('Claude', res.status, await res.text().catch(() => ''));
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
      const block = reply.content[evt.index];
      if (evt.type === 'content_block_start') {
        reply.content[evt.index] = evt.content_block.type === 'tool_use' ? { ...evt.content_block, input: {}, json: '' } : { ...evt.content_block };
      } else if (evt.type === 'content_block_delta' && block) {
        const d = evt.delta;
        if (d.type === 'text_delta') { block.text = (block.text || '') + d.text; onText(d.text); }
        else if (d.type === 'thinking_delta') block.thinking = (block.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') block.signature = (block.signature || '') + d.signature;
        else if (d.type === 'input_json_delta') block.json += d.partial_json;
      } else if (evt.type === 'content_block_stop' && block?.type === 'tool_use') {
        // Tool input can stream unchecked (eager_input_streaming), so it's parsed strictly here.
        try { block.input = block.json ? JSON.parse(block.json) : {}; } catch { reply.invalid.set(block.id, block.json); }
      } else if (evt.type === 'message_start' && evt.message?.usage) {
        const u = evt.message.usage;
        reply.usage = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens };
      } else if (evt.type === 'message_delta') {
        if (evt.usage) reply.usage.output = evt.usage.output_tokens;
        if (evt.delta?.stop_reason) reply.stop = evt.delta.stop_reason;
      } else if (evt.type === 'error') {
        const busy = evt.error?.type === 'overloaded_error';
        throw new ProviderError('Claude', busy ? 529 : 500, evt.error?.message || '', busy ? 'busy' : 'other',
          busy ? 'Claude is busy right now (529).' : `Claude API stream error: ${evt.error?.message || 'unknown'}`);
      }
    }
  }
  // Sent back as Claude wrote them: tool calls with their parsed input, without the JSON text gathered here.
  reply.content = reply.content.filter(Boolean).map(({ json, ...b }) => b);
  return reply;
}
