// OpenAI's gpt-4o-mini-tts (OPENAI_TTS_MODEL to change it), with OPENAI_API_KEY or the visitor's own key. Billed by
// the minute of audio, at a low rate.
import { ttsError } from './index.js';

export const voices = [
  { id: 'coral', name: 'Coral', lang: 'en-US', gender: 'female', style: 'warm', note: 'Warm and friendly' },
  { id: 'marin', name: 'Marin', lang: 'en-US', gender: 'female', style: 'calm', note: 'Natural and relaxed' },
  { id: 'cedar', name: 'Cedar', lang: 'en-US', gender: 'male', style: 'calm', note: 'Natural and grounded' },
  { id: 'nova', name: 'Nova', lang: 'en-US', gender: 'female', style: 'bright', note: 'Bright and lively' },
  { id: 'sage', name: 'Sage', lang: 'en-US', gender: 'female', style: 'calm', note: 'Even and thoughtful' },
  { id: 'ash', name: 'Ash', lang: 'en-US', gender: 'male', style: 'authoritative', note: 'Clear and direct' },
  { id: 'ballad', name: 'Ballad', lang: 'en-GB', gender: 'male', style: 'storyteller', note: 'Expressive, British lilt' },
  { id: 'verse', name: 'Verse', lang: 'en-US', gender: 'male', style: 'playful', note: 'Expressive and versatile' },
];

export async function speak({ text, voice, key, env, signal }) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3',
      instructions: 'Speak naturally and conversationally, as a friendly assistant answering out loud.' }),
  });
  if (!res.ok) throw await ttsError('OpenAI', res);
  return { audio: new Uint8Array(await res.arrayBuffer()), type: 'audio/mpeg' };
}
