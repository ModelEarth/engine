// Google Cloud Text-to-Speech, Chirp 3 HD voices, with GOOGLE_TTS_API_KEY or the visitor's own key: a Google Cloud
// API key with the Text-to-Speech API turned on (a Gemini key from AI Studio isn't allowed it). A free monthly
// allowance of characters, then billed per character.
import { fromBase64, ttsError } from './index.js';

// id: the voice name, and its locale is the voice's language.
export const voices = [
  { id: 'en-US-Chirp3-HD-Aoede', name: 'Aoede', lang: 'en-US', gender: 'female', style: 'warm', note: 'Breezy' },
  { id: 'en-US-Chirp3-HD-Charon', name: 'Charon', lang: 'en-US', gender: 'male', style: 'authoritative', note: 'Informative' },
  { id: 'en-US-Chirp3-HD-Kore', name: 'Kore', lang: 'en-US', gender: 'female', style: 'calm', note: 'Firm' },
  { id: 'en-US-Chirp3-HD-Puck', name: 'Puck', lang: 'en-US', gender: 'male', style: 'playful', note: 'Upbeat' },
  { id: 'en-US-Chirp3-HD-Zephyr', name: 'Zephyr', lang: 'en-US', gender: 'female', style: 'bright', note: 'Bright' },
  { id: 'en-GB-Chirp3-HD-Orus', name: 'Orus', lang: 'en-GB', gender: 'male', style: 'storyteller', note: 'British, firm' },
  { id: 'en-AU-Chirp3-HD-Leda', name: 'Leda', lang: 'en-AU', gender: 'female', style: 'bright', note: 'Australian, youthful' },
  { id: 'en-IN-Chirp3-HD-Achird', name: 'Achird', lang: 'en-IN', gender: 'male', style: 'warm', note: 'Indian English, friendly' },
];

export async function speak({ text, voice, key, signal }) {
  const languageCode = (String(voice).match(/^[a-z]{2,3}-[A-Z]{2}/) || ['en-US'])[0];
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { text }, voice: { languageCode, name: voice }, audioConfig: { audioEncoding: 'MP3' } }),
  });
  if (!res.ok) throw await ttsError('Google Cloud TTS', res);
  const j = await res.json();
  return { audio: fromBase64(j.audioContent || ''), type: 'audio/mpeg' };
}
