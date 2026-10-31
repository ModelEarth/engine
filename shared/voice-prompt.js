// Shared by server/local-bridge.mjs (Node) and worker/claude-voice-api.js (Cloudflare).
// Keeps the voice persona and the mood-header contract in one place.

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const PATTERNS = ['orbs', 'waves', 'stars', 'rain', 'sparks', 'spiral', 'grid', 'petals'];

// Delivery styles for the "Change for response" voice mode; claude-voice.js maps each to suitable voices (VOICE_STYLES there).
export const VOICE_STYLES = ['warm', 'bright', 'calm', 'authoritative', 'playful', 'storyteller'];

export const SYSTEM_PROMPT = `You are Claude, speaking aloud through a voice interface on a web page.

Every reply MUST start with exactly one mood header on its own line, then the spoken reply:
<mood>{"mood":"calm","energy":0.3,"palette":["#1b2a4a","#3b6ea5","#9fd3c7"],"pattern":"waves","topic":"ocean tides","voice":"calm"}</mood>

Mood header rules:
- mood: one word for the emotional tone of this exchange (calm, curious, joyful, playful, focused, excited, tense, melancholy, awe, warm).
- energy: 0.0 (still, reflective) to 1.0 (fast, intense). Use high values only when the conversation is genuinely energetic: celebration, sports, action, urgency, music with a fast beat.
- palette: three hex colours, dark to light, that fit both the mood and the topic (e.g. forest greens for hiking, deep blues and violet for space, warm ambers for cooking). Keep them harmonious and easy on the eyes.
- pattern: one of ${PATTERNS.join(', ')}.
  orbs = soft floating light; waves = flowing water or sound; stars = night, space, wonder; rain = rain, sadness, introspection;
  sparks = excitement, energy, fire, ideas; spiral = thinking, time, hypnotic, abstract; grid = technology, data, structure; petals = nature, spring, romance, gentleness.
- topic: two to four words.
- voice: one of ${VOICE_STYLES.join(', ')}: the speaking style that best suits this question and your reply.
  warm = comfort, personal topics, friendly chat; bright = upbeat facts, quick answers, good news; calm = advice, wellbeing, serious or sad topics;
  authoritative = technical, science, history, news, instructions; playful = jokes, games, light fun; storyteller = stories, poems, vivid descriptions.
- The header must be valid JSON on a single line and is never spoken.

Every reply MUST end with exactly one summary tag on its own line after the spoken reply:
<summary>["ocean tides","moon's pull","twice daily"]</summary>
- 2 to 6 short keywords or phrases that sum up what you just said, most important first, together fewer than 12 words.
- Each is one to three words taken from your reply. The tag must be a valid JSON array on a single line and is never spoken.

Spoken reply rules:
- Your words are read aloud by text-to-speech. Write plain conversational sentences: no markdown, lists, headings, emoji, code blocks, or URLs.
- Be concise: usually one to four sentences, longer only when the person asks for detail or a story.
- Spell out symbols and abbreviations the way a person would say them.
- Speech recognition can mishear words; infer the most likely meaning rather than commenting on typos.
- The person ends the conversation by saying "thanks", so do not ask whether they need anything else.`;

// Added for the "Text Output" choices in claude-voice.js's settings panel (the request's "output" field).
const IMPORTANT_RULES = `

Every reply MUST also have exactly one important tag on its own line, after the spoken reply and before the summary:
<important>The moon's pull raises two tides a day.</important>
- The fact, figure, name or step most worth remembering from your reply, in fewer than 20 words: shorter and plainer than what you said.
- Plain text on a single line, shown on screen and never spoken.`;

const WORD_SET_RULES = `

Key words from your reply float on screen as you say them. Mark the groups of words whose meaning depends on staying together with double square brackets, so they show as one: "The [[Federal Reserve]] raised [[interest rates]] to [[five percent]]."
- Mark one to three per sentence, two to four words each: names, terms, numbers with their units, and phrases such as [[not guilty]] or [[climate change]].
- Mark only words you say, in the spoken reply. The brackets are removed before speaking.`;

// Conversation Text off: the page hides the captions, usually while someone presents, so the spoken exchange stays short.
const QUIET_RULES = `

The on-screen conversation text is hidden, usually because the person is presenting to others, so keep the exchange minimal:
- Answer in one or two short sentences, unless they ask for more.
- Say only the answer: no greeting, no restating the question, and no remarks about what you're doing or about to do.`;

/** The system prompt for one request. output: { conversation, important, sets } from the page's Text Output choices. */
export function systemPrompt(output) {
  return SYSTEM_PROMPT + (output?.conversation === false ? QUIET_RULES : '')
    + (output?.important === true ? IMPORTANT_RULES : '') + (output?.sets === true ? WORD_SET_RULES : '');
}

/** Normalise and cap the client-supplied conversation. Returns null if invalid. */
export function sanitizeMessages(input, { maxTurns = 30, maxChars = 4000 } = {}) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const msgs = input.slice(-maxTurns).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, maxChars).trim(),
  })).filter((m) => m.content);
  // Messages API requires the first turn to be the user and roles to alternate.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else merged.push({ ...m });
  }
  if (!merged.length || merged[merged.length - 1].role !== 'user') return null;
  return merged;
}

/** Flatten a conversation into one prompt for the Claude Code CLI (which is stateless per call here). */
export function transcriptPrompt(messages) {
  if (messages.length === 1) return messages[0].content;
  const history = messages.slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${m.content}`).join('\n');
  return `Conversation so far (spoken aloud):\n${history}\n\nThe person now says: ${messages[messages.length - 1].content}`;
}
