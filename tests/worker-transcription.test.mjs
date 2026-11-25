import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleVoiceChat } from '../worker/voice-chat-api.js';

const url = 'https://voice.example/api/voice-chat/transcribe?lang=en-US';
const passphrase = 'test-passphrase-only';
const audio = new Uint8Array(48);
audio.set(new TextEncoder().encode('RIFF'), 0);
audio.set(new TextEncoder().encode('WAVE'), 8);
function request(headers = {}, body = audio) {
  return new Request(url, { method: 'POST', headers, body });
}
function binding() {
  const calls = [];
  return {
    calls, TEAM_PASSPHRASE: passphrase,
    AI: { async run(model, input) {
      calls.push({ model, input });
      return { text: '[Noise] I feel happy today. (music)' };
    } },
  };
}
const handle = (req, env) => handleVoiceChat(req, env, {}, { passphrase: true });

test('status advertises cloud transcription without starting inference', async () => {
  const env = binding();
  const res = await handle(new Request(url.replace('/transcribe?lang=en-US', '/status')), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).transcribe.local, false);
  assert.equal(env.calls.length, 0);
});

test('missing passphrase is refused before inference', async () => {
  const env = binding();
  const res = await handle(request(), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).passphrase, true);
  assert.equal(env.calls.length, 0);
});

test('authorized audio arrives intact with its language and returns cleaned text', async () => {
  const env = binding();
  const res = await handle(request({ 'x-team-passphrase': passphrase }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'I feel happy today.');
  assert.equal(env.calls.length, 1);
  assert.deepEqual(new Uint8Array(Buffer.from(env.calls[0].input.audio, 'base64')), audio);
  assert.equal(env.calls[0].input.language, 'en');
});

test('a supported own-key header follows the existing authorization path', async () => {
  const env = binding();
  const res = await handle(request({ 'x-provider-name': 'anthropic', 'x-provider-key': 'fixture-key' }), env);
  assert.equal(res.status, 200);
  assert.equal(env.calls.length, 1);
});

test('empty audio is refused without inference', async () => {
  const env = binding();
  const res = await handle(request({ 'x-team-passphrase': passphrase }, new Uint8Array()), env);
  assert.equal(res.status, 400);
  assert.equal(env.calls.length, 0);
});

test('inference errors return 502', async () => {
  const env = binding();
  env.AI.run = async () => { throw new Error('test inference unavailable'); };
  const res = await handle(request({ 'x-team-passphrase': passphrase }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /test inference unavailable/);
});

test('an absent binding returns 501', async () => {
  const res = await handle(request(), {});
  assert.equal(res.status, 501);
});

test('an untrusted origin is refused before inference', async () => {
  const env = binding();
  const res = await handle(request({ origin: 'https://other.example', 'x-team-passphrase': passphrase }), env);
  assert.equal(res.status, 403);
  assert.equal(env.calls.length, 0);
});
