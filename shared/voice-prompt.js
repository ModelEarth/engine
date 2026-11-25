// Shared by server/local-bridge.mjs (Node) and worker/voice-chat-api.js (Cloudflare).
// Keeps the voice persona and the mood-header contract in one place.

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const PATTERNS = ['orbs', 'waves', 'stars', 'rain', 'sparks', 'spiral', 'grid', 'petals'];

// Delivery styles for the "Change for response" voice mode; voice-chat.js maps each to suitable voices (VOICE_STYLES there).
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

// Added for the "Text Output" choices in voice-chat.js's settings panel (the request's "output" field).
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

/** The prompt introduces Claude; another model answering says who it is instead. who: e.g. "Gemini", "an OpenAI model". */
export const standingIn = (system, who) => system.replace(/^You are Claude,/, `You are ${who}, standing in for Claude,`);

/** The page the person is on (the request's "page" field: its path and hash), cleaned up for the prompt, or '' when there's none. */
export function pagePath(page) {
  if (typeof page !== 'string' || !page.startsWith('/')) return '';
  return page.replace(/[^\w\-./~%#&=+,:;@!$*'()]/g, '').slice(0, 300);
}

/** The site file a page path is served from, relative to the webroot: a folder's index.html, without the hash or query. */
export function pageFile(page) {
  const path = pagePath(page).replace(/[?#].*$/, '').split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
  if (!path) return 'index.html';
  return /\.[a-z0-9]+$/i.test(path) ? path : path + '/index.html';
}

// Where the person is, from the request's "page" field: what they're looking at as they talk.
const pageRules = (path) => `

Where the person is: they're looking at this website's page ${path} as they talk to you.
- Questions about "this page", "the current page", "this map", "here", "what I'm looking at", or anything shown on screen, without naming another page, are about that page. Answer about it directly, without asking which page they mean.
- The path says which page it is, and the part after # holds its current settings (such as the state, view or report chosen), so tell them about what they're seeing now.
- For questions about the site in general, or about another page, answer as usual.`;

// The accent a voice's language and region give it, for the prompt's list of voices.
const ACCENTS = { 'en-US': 'American English', 'en-GB': 'British English', 'en-AU': 'Australian English', 'en-IN': 'Indian English',
  'en-IE': 'Irish English', 'en-ZA': 'South African English', 'en-CA': 'Canadian English', 'en-NZ': 'New Zealand English', 'en-SC': 'Scottish English',
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', hi: 'Hindi', zh: 'Chinese' };
function accentOf(lang) {
  const [base, region] = String(lang || '').split(/[-_]/);
  return ACCENTS[`${(base || '').toLowerCase()}-${(region || '').toUpperCase()}`] || ACCENTS[(base || '').toLowerCase()] || '';
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>{}"`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const voiceEntry = (v) => v && typeof v === 'object' && clean(v.name, 40)
  ? { name: clean(v.name, 40), label: clean(v.label, 30), accent: accentOf(v.lang), gender: clean(v.gender, 12), style: clean(v.style, 16) } : null;
// "George (Kokoro)": how a voice is named in the prompt, and in the header's speaker field.
const voiceName = (v) => (v.label && v.label !== 'Browser' ? `${v.name} (${v.label})` : v.name);
const spokenName = (v) => (v.label && v.label !== 'Browser' ? `${v.name}, a ${v.label} voice` : `${v.name}, one of this browser's voices`);
const voiceLine = (v) => `${voiceName(v)}: ${[v.accent, v.gender, v.style && `${v.style} style`].filter(Boolean).join(', ') || 'a browser voice'}`;

/** The voice rules for one request. voice: { now, on, choose } from the page (js/voice-chat.js): the voice speaking
    now, the voices turned on, and whether Claude picks among them (the header's speaker). */
function voiceRules(voice) {
  if (!voice || typeof voice !== 'object') return '';
  const now = voiceEntry(voice.now);
  const on = (Array.isArray(voice.on) ? voice.on : []).slice(0, 12).map(voiceEntry).filter(Boolean);
  if (!now && !on.length) return '';
  const choose = voice.choose === true && on.length > 1;
  return `

Your voice: what you write is spoken aloud by text to speech, in a voice the person chose. You're still Claude, the AI answering; the voice is how you sound.
${choose ? `The voices turned on now, which take turns:\n${on.map((v) => `- ${voiceLine(v)}`).join('\n')}${now ? `\nThe last reply was spoken by ${voiceName(now)}.` : ''}
- Add "speaker" to the mood header: the name of the voice for this reply, written exactly as listed, such as "${voiceName(on[0])}".
- When the question is about a place or culture and one of these voices has its accent, pick that one: a British English voice for England or the UK, an Australian one for Australia, and so on. Otherwise pick the voice whose style best suits the reply, and vary it from one reply to the next.
- This reply is spoken by the speaker you name.` : `${now ? `Your replies are spoken by ${voiceLine(now)}.` : ''}`}
- If asked which voice is speaking, or what your voice is called, give the voice's name and where it comes from (such as "I'm Claude, speaking with ${spokenName(now || on[0])}"), rather than only saying you're Claude. The person can change voices under Voices in the ⚙ settings, or with the buttons below a talk circle before a conversation starts.`;
}

/** The page's tools (the request's "tools" field: MCP tool definitions, from window.pageTools in js/voice-chat.js), checked
    and capped. The page runs them: the reply names one in an action tag (actionRules). */
export function pageTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 12).map((t) => (t && typeof t === 'object' && /^[A-Za-z][\w-]{0,63}$/.test(t.name)
    ? { name: t.name, description: clean(t.description, 1500), inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' } }
    : null)).filter((t) => t && JSON.stringify(t).length <= 12000);
}

// Page actions: what the person's page lets the reply change, such as the Earth map it shows. Any model can answer with
// them, since they're a tag in the reply rather than the API's tool calls, and the page runs them as the reply arrives.
const actionRules = (tools) => `

Page actions: the page the person is on can change what it shows for you. The actions, as MCP tool definitions:
${JSON.stringify(tools)}
- When a request is about something an action can show, such as the weather or a place on a map, use it: write one action tag on its own line right after the mood header, before the spoken reply:
<action>{"name":"${tools[0].name}","input":{}}</action>
- input follows the action's inputSchema. Give only what the request calls for; fields left out keep what the page shows now.
- More than one action tag is allowed, each on its own line. Don't use an action when none fits the request.
- The tag must be valid JSON on a single line and is never spoken. Then speak as usual, saying briefly what is now on screen.
- The time now is about ${new Date().toISOString().slice(0, 13)}:00Z (UTC), for times such as tomorrow or tonight.`;

/** The system prompt for one request. output: { conversation, important, sets } from the page's Text Output choices.
    page: the path (and hash) of the page the person is on. voice: the voices (voiceRules). tools: the page's actions (pageTools). */
export function systemPrompt(output, page, voice, tools) {
  const path = pagePath(page);
  const actions = pageTools(tools);
  return SYSTEM_PROMPT + (path ? pageRules(path) : '') + (actions.length ? actionRules(actions) : '') + voiceRules(voice)
    + (output?.conversation === false ? QUIET_RULES : '')
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
