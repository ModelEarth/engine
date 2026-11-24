// ElevenLabs Flash v2.5 (ELEVENLABS_MODEL to change it), with ELEVENLABS_API_KEY or the visitor's own key. The free
// tier gives 10,000 credits a month, for non-commercial use with attribution. Word timings come with the audio.
import { fromBase64, ttsError, wordsFromChars } from './index.js';

export const voices = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', lang: 'en-US', gender: 'female', style: 'calm', note: 'Calm and clear' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', lang: 'en-US', gender: 'female', style: 'warm', note: 'Soft and reassuring' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', lang: 'en-US', gender: 'male', style: 'storyteller', note: 'Deep and resonant' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', lang: 'en-US', gender: 'male', style: 'authoritative', note: 'Deep and steady' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', lang: 'en-US', gender: 'female', style: 'bright', note: 'Friendly and upbeat' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', lang: 'en-GB', gender: 'male', style: 'storyteller', note: 'British, warm' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', lang: 'en-GB', gender: 'female', style: 'warm', note: 'British, gentle' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', lang: 'en-AU', gender: 'male', style: 'playful', note: 'Australian, casual' },
];

export async function speak({ text, voice, lang, key, env, signal }) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', signal,
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5', language_code: String(lang || 'en').split('-')[0].toLowerCase() }),
  });
  if (!res.ok) throw await ttsError('ElevenLabs', res);
  const j = await res.json();
  const a = j.alignment || j.normalized_alignment;
  return {
    audio: fromBase64(j.audio_base64 || ''), type: 'audio/mpeg',
    ...(a && a.characters && { words: wordsFromChars(a.characters, a.character_start_times_seconds || []) }),
  };
}
