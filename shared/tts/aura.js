// Deepgram Aura-2 on Cloudflare Workers AI, through the Worker's AI binding: no key of its own. $0.030 per 1,000
// characters, within Workers AI's 10,000 free Neurons a day. English and Spanish models, each with its own speakers.
export const voices = [
  { id: 'thalia', name: 'Thalia', lang: 'en-US', gender: 'female', style: 'bright', note: 'Clear, confident and energetic' },
  { id: 'helena', name: 'Helena', lang: 'en-US', gender: 'female', style: 'warm', note: 'Caring, natural and friendly' },
  { id: 'apollo', name: 'Apollo', lang: 'en-US', gender: 'male', style: 'authoritative', note: 'Confident and comfortable' },
  { id: 'arcas', name: 'Arcas', lang: 'en-US', gender: 'male', style: 'calm', note: 'Natural, smooth and clear' },
  { id: 'andromeda', name: 'Andromeda', lang: 'en-US', gender: 'female', style: 'playful', note: 'Casual and expressive' },
  { id: 'athena', name: 'Athena', lang: 'en-US', gender: 'female', style: 'calm', note: 'Calm and professional' },
  { id: 'aries', name: 'Aries', lang: 'en-US', gender: 'male', style: 'warm', note: 'Warm and energetic' },
  { id: 'luna', name: 'Luna', lang: 'en-US', gender: 'female', style: 'playful', note: 'Friendly and natural' },
  { id: 'orion', name: 'Orion', lang: 'en-US', gender: 'male', style: 'calm', note: 'Approachable and calm' },
  { id: 'draco', name: 'Draco', lang: 'en-GB', gender: 'male', style: 'storyteller', note: 'British, warm and trustworthy' },
  { id: 'pandora', name: 'Pandora', lang: 'en-GB', gender: 'female', style: 'storyteller', note: 'British, smooth and calm' },
  { id: 'hyperion', name: 'Hyperion', lang: 'en-AU', gender: 'male', style: 'warm', note: 'Australian, caring' },
  { id: 'theia', name: 'Theia', lang: 'en-AU', gender: 'female', style: 'bright', note: 'Australian, expressive' },
  { id: 'celeste', name: 'Celeste', lang: 'es-ES', gender: 'female', style: 'warm', note: 'Spanish' },
  { id: 'nestor', name: 'Néstor', lang: 'es-ES', gender: 'male', style: 'calm', note: 'Spanish' },
];
const SPANISH = new Set(['sirio', 'nestor', 'carina', 'celeste', 'alvaro', 'diana', 'aquila', 'selena', 'estrella', 'javier']);

export async function speak({ text, voice, env }) {
  const model = SPANISH.has(voice) ? '@cf/deepgram/aura-2-es' : '@cf/deepgram/aura-2-en';
  let out;
  try {
    out = await env.AI.run(model, { text, speaker: voice, encoding: 'mp3' });
  } catch (err) {
    throw Object.assign(new Error(`Aura on Cloudflare couldn’t speak: ${err.message || err}`), { status: /limit|neuron|quota|429/i.test(String(err.message)) ? 429 : 502 });
  }
  // The binding returns a ReadableStream of MP3 (or a Response, or { audio } in base64 on some versions).
  let audio;
  if (out instanceof ReadableStream || out instanceof Response) audio = new Uint8Array(await new Response(out.body || out).arrayBuffer());
  else if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) audio = new Uint8Array(out.buffer || out);
  else if (out && typeof out.audio === 'string') audio = Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0));
  if (!audio || !audio.length) throw Object.assign(new Error('Aura on Cloudflare sent no audio.'), { status: 502 });
  return { audio, type: 'audio/mpeg' };
}
