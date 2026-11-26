# voice-chat

Talk to Claude Opus 5.5 by voice from a static page.

- Say **"Ok Claude"** to start. You can ask your question in the same breath.
- Claude keeps answering until you say **"Thanks"**.
- The host div's background becomes a living canvas. Colours fade between palettes and patterns cross-fade as the mood and topic shift. It stays calm for reflective talk and speeds up for exciting moments.

```
engine/                        ← this submodule, inside your webroot
  js/voice-chat.js             ← the only file the page loads
  js/voice-audio.js            ← plays the natural voices (imported only when one speaks)
  js/voice-kokoro.js           ← Kokoro in the browser (imported only when it's chosen)
  js/talk-circle.js            ← the Talk Circle, with its voice buttons and commands
  info/                        ← what people can say: weather.md, voices.md and locations.md, a tab each (the ⓘ beside the voice buttons)
  demo.html
  shared/                      ← system prompt + Claude API streaming (used by both servers)
  shared/tts/                  ← the voice services, one module each (see "Voices")
  server/local-bridge.mjs      ← localhost: Claude Code CLI (or API) bridge
  server/kokoro/               ← Kokoro for the bridge, with its own npm packages
  server/push-secrets.mjs      ← copies keys from .env to Cloudflare secrets
  worker/voice-chat-api.js     ← Cloudflare Worker endpoint
  worker/wrangler.example.jsonc
  .env.example
  assetsignore.example
```

## Embed

```html
<div id="stage"> …your content… </div>
<script src="/engine/js/voice-chat.js" data-target="#stage" defer></script>
```

The script never holds a key. It decides where to send requests based on where the page is running:

| Page served from | Requests go to | Answered by |
|---|---|---|
| `localhost` / `127.0.0.1` (any port) | `http://127.0.0.1:3703/api/voice-chat` | Local bridge, using the **Claude Code CLI** |
| Anywhere else (Cloudflare) | `/api/voice-chat` on the same site | Worker, using the **Claude API** key |

The same rule covers `wrangler dev`: on `localhost:8787` the page still uses the CLI bridge. You can override the endpoint with `data-endpoint`.

### Options (script attributes)

- `data-target`: selector of the div to animate. Default: the script's parent div, otherwise `<body>`.
- `data-endpoint`: explicit API URL.
- `data-bridge-port`: bridge port. Default `3703`.
- `data-lang`: speech language. Default: the page's `lang`, otherwise `en-US`.
- `data-voice`: a voice to start with, by name, from any source: for example `Heart` (Kokoro), `Samantha` or `Google UK English Female`.
- `data-voice-mode`: when several voices take turns, `response` (each reply, by its mood; the default) or `random` (each conversation). See "Voices" below. The ⚙ panel's choices override both and are remembered in that browser.
- `data-ui`: `full` (status pill and captions), `minimal` (pill only) or `none`.
- `data-idle-timeout`: seconds of silence before a conversation closes itself. Default `120`.
- `data-autostart="false"`: always wait for a click before starting.
- `data-mic-level="false"`: turn off the mic-reactive glow.

The script also exposes the palette as CSS variables on the target: `--cv-c1`, `--cv-c2`, `--cv-c3` and `--cv-energy`. Your own styling can follow the mood.

## Keys: `.env`

Copy `.env.example` to the env file that `automation/paths.yaml` names in the webroot above this submodule (`env_file:`, relative to the automation folder), the same file the site's other scripts use. Keep it outside the webroot. The bridge and `push-secrets.mjs` read:

1. `$VOICE_CHAT_ENV`, if set in the shell (optional, for a different env file)
2. otherwise the file `env_file:` names in `automation/paths.yaml`

`push-secrets.mjs` also takes the path as its first argument, ahead of both.

It prints a warning if the `.env` it finds is inside the webroot. A `.env` in the webroot can be served by other static servers or uploaded by `wrangler deploy`. If you must keep it there, copy `assetsignore.example` to `<webroot>/.assetsignore`.

## Localhost (Claude Code CLI)

```bash
npm i -g @anthropic-ai/claude-code   # once
claude                               # once, to log in
node engine/server/local-bridge.mjs            # bridge only; keep your usual static server
node engine/server/local-bridge.mjs --serve .  # or let it serve the webroot too (dotfiles blocked)
```

How the bridge runs each turn:

- It calls `claude -p --model claude-opus-5-5 --output-format stream-json --include-partial-messages`.
- Built-in tools and MCP are turned off, and it runs in an empty temp folder. Claude only talks; it never reads or writes your files.
- `ANTHROPIC_API_KEY` is **not** passed to the CLI, so usage stays on your Claude subscription. To bill the API key instead, set `CLI_USE_API_KEY=true`.
- To skip the CLI entirely, set `LOCAL_BACKEND=api`.
- Only localhost origins may call the bridge.

### Speech to text for browsers without working speech input

Brave, Firefox and iOS browsers other than Safari have no speech input, and Chrome's sometimes hears nothing. For these, the widget can record what you say and send it to the bridge, which turns it into text. Each turn ends at a pause and goes to `POST /api/voice-chat/transcribe` as a 16 kHz WAV. The text then goes to `claude -p` like any spoken turn.

- **Automatic (default):** the widget uses the browser's own speech input. It switches to the bridge when that's missing or fails: "service-not-allowed", repeated "network" errors, or two "no-speech" errors during a conversation that each follow sound the mic picked up (at least 0.4 seconds at speaking level). Chrome reports "no-speech" every few seconds in a quiet room, so silence alone doesn't switch; on a page with the mic level off (`data-mic-level="false"`), any two do. With local transcription, the same applies while waiting for the wake phrase. A successful browser result resets the count. Speech to Text in the settings panel's Listening section can also be set to Browser or Bridge.
- **When it switched on its own:** Speech to Text is highlighted in amber in the settings panel, with the time and the reason, and the ⚙ button shows an amber dot until the panel is opened. A voice set aside after failing is highlighted the same way. Choosing a Speech to Text option again gives the browser's speech input another try.
- **Tests:** `node --test tests/*.test.mjs` runs the speech fallback and Worker transcription tests.
- **When it listens:** not while Claude speaks or thinks. To start, you say "Ok Claude" when the transcriber runs on this computer. With a cloud service, a tap starts the conversation instead, so audio isn't sent to the cloud all the time.

The bridge picks a transcriber when it starts (`TRANSCRIBE=auto`), and its log says which:

- **whisper.cpp on this computer.** Run `brew install whisper-cpp`, then download a model:
  ```bash
  mkdir -p ~/.cache/whisper.cpp && curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
  `WHISPER_CLI` and `WHISPER_MODEL` override where they're looked for.
- **A cloud service:** an OpenAI-compatible `/audio/transcriptions` endpoint, used when there's no whisper.cpp. It needs `OPENAI_API_KEY`, or `TRANSCRIBE_API_KEY` with `TRANSCRIBE_URL` for another service such as Groq. `TRANSCRIBE_MODEL` defaults to `gpt-4o-mini-transcribe`.
- `TRANSCRIBE=whisper`, `cloud` or `off` forces one choice.

**On the deployed site,** the Worker does the same with Whisper on Cloudflare's Workers AI (`@cf/openai/whisper-large-v3-turbo`), through an AI binding in the wrangler config (`[ai] binding = "AI"`, or `"ai": { "binding": "AI" }`). `GET /api/voice-chat/status` tells the page it's there, and `POST /api/voice-chat/transcribe` takes each turn. As with a conversation, it needs the team passphrase when one is set (the page asks for it), or the visitor's own key from the Keys page. A tap starts the conversation, since the audio goes to Cloudflare. Without the binding, the widget falls back to the browser's speech input or typing.

`wrangler dev` reaches an AI binding only on Cloudflare itself, which needs a login, so CloudRoot's `npm run dev` runs it with `--local` (binding off). Locally, the bridge transcribes instead.

## Cloudflare (wrangler)

1. Copy `worker/wrangler.example.jsonc` to the folder above your webroot as `wrangler.jsonc`, and adjust the paths.
   - If you already have a Worker, import the handler instead:
     ```js
     import { handleVoiceChat, VOICE_CHAT_PATH } from './public/engine/worker/voice-chat-api.js';
     // in fetch(): if (new URL(request.url).pathname === VOICE_CHAT_PATH) return handleVoiceChat(request, env, ctx);
     ```
2. Push the key from `.env`: `node public/engine/server/push-secrets.mjs`. This sets the `ANTHROPIC_API_KEY` secret and, if present, `ALLOWED_ORIGINS`.
3. Deploy: `npx wrangler deploy`.

The Worker only accepts same-origin requests, plus any origins in `ALLOWED_ORIGINS`. It caps the size of the conversation and streams the reply. For a public page, uncomment the `ratelimits` block in the wrangler config so strangers can't run up your API bill.

## How the visuals follow the conversation

Every reply begins with a hidden header that Claude writes, for example:

```
<mood>{"mood":"excited","energy":0.95,"palette":["#3a0d0d","#e0531f","#ffd447"],"pattern":"sparks","topic":"championship win"}</mood>
```

The script strips the header before speaking, and the visuals change before the first word is spoken.

**Colours.** Colours are tweened in OKLab over about 3 seconds, so fades pass through natural in-between hues instead of going muddy. Over-bright or neon colours are softened.

**Patterns.** Patterns cross-fade over about 2 seconds:

| Pattern | Look |
|---|---|
| `orbs` | soft floating light |
| `waves` | flowing lines |
| `stars` | twinkling stars, with shooting stars at higher energy |
| `rain` | falling streaks |
| `sparks` | firework bursts; the high-tempo pattern |
| `spiral` | rotating arms of dots |
| `grid` | dot grid with scanning pulses |
| `petals` | tumbling petals |

**Energy.** `energy` (0–1) sets the tempo. Spoken words pulse the scene, and your mic level makes a glow while you talk.

**Reduced motion.** `prefers-reduced-motion` slows everything down and removes the flashes.

## Voices

Replies can be spoken by natural voices from several services, or by the browser's own voices (`speechSynthesis`). The services are listed by the bridge or the Worker at `GET /api/voice-chat/voices`, and `POST /api/voice-chat/speak` turns one sentence at a time into audio. Each service is its own small module in `shared/tts/`, loaded only when it's used. In the page, `js/voice-audio.js` plays their audio, and it's imported only once one of them speaks, so a page that uses browser voices loads nothing more.

| Source | Where it runs | Key | Cost (check before relying on these) |
| --- | --- | --- | --- |
| Kokoro (Kokoro-82M, open source) | The local bridge, on this computer | None | Free, offline |
| Kokoro in the browser | The visitor's browser, on any site | None | Free, after a one-time download the visitor agrees to |
| Deepgram Aura-2 | The Cloudflare Worker, through the AI binding | None | $0.030 per 1,000 characters, within Workers AI's 10,000 free Neurons a day |
| Grok (xAI) | Bridge or Worker | `XAI_API_KEY`, or the visitor's own xAI key | $15 per million characters |
| ElevenLabs (Flash v2.5) | Bridge or Worker | `ELEVENLABS_API_KEY`, or the visitor's own | 10,000 free credits a month (non-commercial, with attribution), then paid plans |
| OpenAI (`gpt-4o-mini-tts`) | Bridge or Worker | `OPENAI_API_KEY`, or the visitor's own | Low, per minute of audio |
| Google Cloud (Chirp 3 HD) | Bridge or Worker | `GOOGLE_TTS_API_KEY`, or the visitor's own | A free monthly allowance, then per character |
| The browser's own voices | The browser | None | Free |

Anthropic has no text-to-speech service, so Claude's own voice isn't among them.

**Defaults.** Until voices are chosen, the default source's first voice speaks: Kokoro's Heart on localhost, once Kokoro is installed on the bridge, and Aura's Thalia on the deployed site. Without either, the browser's voices speak, as below. `data-voice` names a voice to start with instead, from any source.

**Installing Kokoro on the bridge.** Kokoro has its own npm packages, kept apart from the bridge in `server/kokoro/`:

```bash
npm install --prefix engine/server/kokoro
```

Then restart the bridge. Its model (about 90 MB) downloads from Hugging Face with the first sentence and stays cached. A page asking for the voices starts loading it, which takes about 12 seconds on an M-series Mac. After that, a sentence takes 1 to 2 seconds, faster than it plays. `KOKORO=false` leaves it out even when installed, and `KOKORO_DTYPE` picks the model's precision (`q8` by default). Kokoro speaks American and British English.

**Kokoro in the browser.** Where the bridge doesn't have Kokoro, as on the deployed site, it can run in the visitor's own browser (`js/voice-kokoro.js`, with kokoro-js from jsDelivr). Nothing downloads until the visitor agrees in a dialog that gives the size:
- With WebGPU (Chrome, Edge, Brave, recent Safari), it's the fp16 model, about 185 MB in all. A 5-second sentence takes about 0.3 seconds.
- Without WebGPU, it's the q8 model on WebAssembly, about 115 MB. That takes about twice a sentence's length, so the speech pauses between sentences.

The files are kept in the browser's storage for the site, so restarting the browser doesn't download them again. They download again only if the site's data is cleared, in a private window, or if the browser removes them to free space. Safari can also remove a site's files after several weeks without a visit. If they're gone, the dialog asks again before downloading. The ⚙ panel has **Remove Kokoro files**.

**Keys.** Keyed sources use the server's key from the env file (pushed to the Worker with `node engine/server/push-secrets.mjs --voices`), or the visitor's own key from the Keys page: an xAI key for Grok, an OpenAI key for OpenAI, and ElevenLabs and Google Cloud Text-to-Speech keys. A source with neither is listed in the ⚙ panel under **With a key**. On the deployed site, a source using the site's key or the AI binding needs the team passphrase, as a conversation does. The Worker keeps each sentence's audio in the Cache API, so a greeting or a repeated reply costs nothing the second time.

**Commands.** The ⓘ after the voice buttons opens what people can say, in Weather, Voices and Locations tabs over the left 2/3 of the page (localsite's page tabs, `localsite/js/page-tabs.js`), each a README from `info/`. "Show commands" (show_commands) opens them too, "Hide commands" closes them, and a link with `#info=voices` (or another tab) opens on that tab. While they're open, the circle moves to the space at their right. Their ◀ minimizes them to localsite's mini nav pill, as clicking or playing the Earth map does.

**Choosing voices.** Below a Talk Circle (`js/talk-circle.js`), 2 to 10 voices show as buttons before a conversation begins: the default source's best, a couple from each other source and the browser's best. Once the conversation begins, the buttons hide (Claude brings them back when asked: show_voices), and the ⚙ panel's **Voices** list has every voice, grouped by source, plus **More Browser Voices**. Both change the same choice, which is remembered in the browser (`voice-chat:pool` in localStorage):
- Turning a voice on has it greet you by name, as usual for its language and region: "Hi, I'm Heart." (US English), "Hello, I'm George." (UK), "G'day, I'm Theia." (Australia), "¡Hola, soy Celeste!" (Spanish).
- With one voice on, it speaks every reply.
- With several on, they take turns, and Claude picks the voice for each reply. Each question tells Claude which voices are on, with their accents and styles, and Claude's hidden header for the reply names one as `speaker`. Claude prefers a voice whose accent belongs to the place the question is about, such as a British English voice for a question about England. Otherwise it picks by the reply's delivery style: `warm`, `bright`, `calm`, `authoritative`, `playful` or `storyteller` (`VOICE_STYLES` in `shared/voice-prompt.js`). When the header names no voice that's on, the style picks one, never the one just used. Only voices that are on are used: with only an American voice on, a question about England is still answered in it. **Take Turns** can change voice for each conversation instead (`data-voice-mode="random"`).
- Claude knows which voice it's speaking with (`voiceRules` in `shared/voice-prompt.js`), so "Which voice is this?" gets the voice's name and source.
- With none on, the browser's best voices take turns in the same way.

A page can do the same from its own script: `VoiceChat.voices()` lists the voices for buttons, `VoiceChat.setVoicePool(ids)` and `VoiceChat.toggleVoice(id)` choose them, and the `voice-chat:voices` event says when they change.

**When a voice can't speak.** If a service fails (no key, out of credits, offline) or hasn't started a sentence within 9 seconds, the best browser voice says that sentence. A note says why, once. After a refusal or a second failure, that service waits until it's chosen again.

### The browser's own voices

The browser's voices are whatever that browser and OS have installed, so they differ from one browser to the next: Edge has Microsoft's online voices, such as "Microsoft Ava Online (Natural)", Chrome has "Google US English" and Safari has Apple's, such as "Samantha" or "Ava (Premium)". On a Mac, the Premium and Enhanced voices are added in System Settings > Accessibility > Spoken Content > System Voice > Manage Voices.

Browsers don't rate their voices, so the widget ranks the English ones by name (`voiceTier` and `rankVoices` in `js/voice-chat.js`):

| Tier | Voice name | Example |
|---|---|---|
| Best | contains "natural", "neural" or "premium" | Microsoft Ava Online (Natural) |
| Very good | contains "enhanced", or starts with "Google " | Google UK English Female |
| Standard | anything else | Samantha |
| Robotic | old Mac voices such as Fred, Ralph, Albert and Grandma | Fred |
| Novelty | Bubbles, Bells, Jester, Zarvox and the like | Zarvox |

Within a tier, a favourites list (Ava, Andrew, Emma, Brian, Jenny and others) comes first, then US English, then UK English, then other English voices. The Best and Very good ones are offered as buttons. With no voices chosen, a reply's style picks an installed voice that suits it (`VOICE_STYLES` in `js/voice-chat.js`): for example, `authoritative` prefers Andrew, Brian or Guy, and `playful` prefers Zoe, Aria or Allison.

## Browser notes

- Voice input uses the Web Speech API in Chrome, Edge and Safari. Brave and Firefox, which lack it, record what you say and have the bridge or the Worker turn it into text (see "Speech to text" above); without either, they get a text box. The ⌨ button opens it in any browser.
- Browsers only allow speech output after a click or keypress on the page. Tap **Enable voice** once per visit; after that the wake phrase works hands-free. If the mic is already allowed, listening starts by itself.
- You can talk while Claude is talking. **Hear Me While Claude Speaks**, in the ⚙ panel's Listening settings and on by default, keeps the mic on while Claude speaks. The mic also hears Claude through the speakers, so runs of the words Claude just spoke are taken out of what it hears, and only your own words are kept. They're sent as your next turn once you stop and Claude finishes its sentences. "Thanks" ends the conversation, and the wake phrase ("Ok Claude") interrupts Claude, with anything said after it sent at once. With the setting off, the mic is off while Claude speaks and comes back after **Mic Back After Claude** (0.7 s by default). Press Esc or tap the pill to interrupt at any time.
- Hear Me While Claude Speaks applies to the browser's own speech input. When speech to text goes through Whisper (Brave, Firefox, or Bridge chosen under Speech to Text), the mic doesn't record while Claude speaks or for a moment after, since Claude's voice isn't taken out of a recording. The setting is then greyed out in the ⚙ panel, with a note saying why. On the deployed site, Whisper runs on the site's Cloudflare Workers AI quota with the team passphrase: 10,000 neurons a day free, about 3.5 hours of audio at roughly 47 neurons a minute, then $0.011 per 1,000 neurons on Cloudflare's paid Workers plan. On the free plan, transcription stops until the daily reset at 00:00 UTC. That's billed by Cloudflare, apart from the Claude API usage that Anthropic bills for the replies. Listening over Claude would send Claude's voice to Whisper too, which is another reason it stays off there.
- Chrome's recognition uses Google's servers, so the page must be on `https` or `localhost`.

## Finding the talking tab

A page can't bring its own tab or window to the front: browsers allow `window.focus()` only on a window the page opened, or when someone clicks one of the page's notifications. No meta tag can do it either. So the widget does three things:

- **One talking tab.** Voice is on in one of the site's tabs at a time. Tabs on the same origin in the same browser coordinate over a `BroadcastChannel`. Turning voice on in a tab (Enable voice, or a conversation started there) turns it off in the others. Their pill then says **Voice is on in another tab**, and they let go of the mic. Tap the pill to take voice back. A tab whose voice moved away takes it back by itself when it's in sight again (with the mic already allowed), unless the other tab is in a conversation. This is what stops "Ok Claude" from waking several tabs at once. Pages can watch for the `elsewhere` event, or read `VoiceChat.elsewhere`.
- **Bring This Tab Forward** (⚙ panel, Finding This Tab, on by default). This works on localhost with the bridge running on a Mac. When Claude starts to answer while its tab is out of sight, the page calls `POST /api/voice-chat/focus` with its browser's app name and URL. The bridge then uses JavaScript for Automation (`osascript`) to make that tab active, bring its window in front of the browser's other windows, and bring the browser in front of other apps.
  - **Which tab:** two tabs on the same page are told apart by a mark of zero-width characters, which the page adds to its title for the moment. Without the mark, the bridge uses a matching URL only when there's one.
  - **Browsers:** Brave, Chrome, Edge, Chromium and Safari. Firefox and Arc can't be controlled this way.
  - **First time:** macOS asks whether the app that started the bridge (Terminal, say) may control the browser. You can change that later in System Settings > Privacy & Security > Automation.
  - **Turning it off:** set `FOCUS=false` on the bridge to turn it off for every page. `GET .../status` reports `focus: true` when it's available, and the setting shows only then.
- **Notify Me** (off by default). When Claude starts to answer while its tab is out of sight, a notification names the page. Clicking it brings the tab to the front, in any browser and on the deployed site too. The browser asks once whether to allow notifications. If they're blocked, the setting turns itself off with a note. When the bridge has just brought the tab forward, no notification shows.

Each of these happens at most once per reply.

### Every tab using the bridge

"One talking tab" reaches only tabs in the same browser and profile. A tab in another browser, or in a copy of the browser started with its own profile for testing, keeps listening and answering on its own. So on localhost each page also reports itself to the bridge every 10 seconds (`POST /api/voice-chat/presence`, sent as text/plain so it needs no preflight): a tab id, its URL and title, browser, state, whether it's paused or in the background, and its microphone's name. A closing page says it's gone.

- `GET /api/voice-chat/tabs` lists the tabs seen in the last 45 seconds. It also lists, for 10 minutes, the questions and recordings that came without a tab id, by site and browser: a tab still running an older copy of the widget.
- `POST /api/voice-chat/tabs/stop` with `{ "id": "..." }` turns the widget off in that tab. The bridge tells the tab in its reply to the tab's next report.
- http://localhost/ (desktop/localhost.mjs in the desktop repo) shows this list, with Show and Turn off buttons. It also finds browsers started with remote debugging, and their voice pages.
