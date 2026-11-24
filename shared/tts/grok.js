// Grok's text to speech (xAI POST /v1/tts), with XAI_API_KEY or the visitor's own xAI key. $15 per million characters.
// Every voice speaks every language it supports, so the language goes with each request.
import { ttsError } from './index.js';

export const voices = [
  { id: 'eve', name: 'Eve', lang: 'en-US', gender: 'female', style: 'bright', note: 'Energetic and upbeat' },
  { id: 'ara', name: 'Ara', lang: 'en-US', gender: 'female', style: 'warm', note: 'Warm and friendly' },
  { id: 'rex', name: 'Rex', lang: 'en-US', gender: 'male', style: 'authoritative', note: 'Confident and clear' },
  { id: 'sal', name: 'Sal', lang: 'en-US', gender: 'neutral', style: 'calm', note: 'Smooth and balanced' },
  { id: 'leo', name: 'Leo', lang: 'en-US', gender: 'male', style: 'storyteller', note: 'Authoritative and strong' },
];

export async function speak({ text, voice, lang, key, signal }) {
  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, language: String(lang || 'en').split('-')[0].toLowerCase() || 'en' }),
  });
  if (!res.ok) throw await ttsError('Grok', res);
  return { audio: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') || 'audio/mpeg' };
}
