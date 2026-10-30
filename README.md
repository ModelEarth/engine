# claude-voice

Talk to Claude Opus 5.5 by voice from a static page.

- Say **"Ok Claude"** to start. You can ask your question in the same breath.
- Claude keeps answering until you say **"Thanks"**.
- The host div's background becomes a living canvas. Colours fade between palettes and patterns cross-fade as the mood and topic shift. It stays calm for reflective talk and speeds up for exciting moments.

```
engine/                        ← this submodule, inside your webroot
  claude-voice.js              ← the only file the page loads
  demo.html
  shared/                      ← system prompt + Claude API streaming (used by both servers)
  server/local-bridge.mjs      ← localhost: Claude Code CLI (or API) bridge
  server/push-secrets.mjs      ← copies keys from .env to Cloudflare secrets
  worker/claude-voice-api.js   ← Cloudflare Worker endpoint
  worker/wrangler.example.jsonc
  .env.example
  assetsignore.example
```

## Embed

```html
<div id="stage"> …your content… </div>
<script src="/engine/claude-voice.js" data-target="#stage" defer></script>
```

The script never holds a key. It decides where to send requests based on where the page is running:

| Page served from | Requests go to | Answered by |
|---|---|---|
| `localhost` / `127.0.0.1` (any port) | `http://127.0.0.1:8790/api/claude-voice` | Local bridge, using the **Claude Code CLI** |
| Anywhere else (Cloudflare) | `/api/claude-voice` on the same site | Worker, using the **Claude API** key |

The same rule covers `wrangler dev`: on `localhost:8787` the page still uses the CLI bridge. You can override the endpoint with `data-endpoint`.

### Options (script attributes)

- `data-target`: selector of the div to animate. Default: the script's parent div, otherwise `<body>`.
- `data-endpoint`: explicit API URL.
- `data-bridge-port`: bridge port. Default `8790`.
- `data-lang`: speech language. Default: the page's `lang`, otherwise `en-US`.
- `data-voice`: part of a voice name, for example `Samantha` or `Google UK English Female`.
- `data-ui`: `full` (status pill and captions), `minimal` (pill only) or `none`.
- `data-idle-timeout`: seconds of silence before a conversation closes itself. Default `120`.
- `data-autostart="false"`: always wait for a click before starting.
- `data-mic-level="false"`: turn off the mic-reactive glow.

The script also exposes the palette as CSS variables on the target: `--cv-c1`, `--cv-c2`, `--cv-c3` and `--cv-energy`. Your own styling can follow the mood.

## Keys: `.env`

Copy `.env.example` to `../../safe/cloudroot.env`, relative to this submodule (the same file `automation/paths.yaml` names), so it sits outside the webroot. The bridge reads:

1. `$CLAUDE_VOICE_ENV`, if set
2. otherwise `../../safe/cloudroot.env`

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

## Cloudflare (wrangler)

1. Copy `worker/wrangler.example.jsonc` to the folder above your webroot as `wrangler.jsonc`, and adjust the paths.
   - If you already have a Worker, import the handler instead:
     ```js
     import { handleClaudeVoice, CLAUDE_VOICE_PATH } from './public/engine/worker/claude-voice-api.js';
     // in fetch(): if (new URL(request.url).pathname === CLAUDE_VOICE_PATH) return handleClaudeVoice(request, env, ctx);
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

## Browser notes

- Voice input needs the Web Speech API: Chrome, Edge or Safari. Firefox gets a text box instead; the ⌨ button opens it in any browser.
- Browsers only allow speech output after a click or keypress on the page. Tap **Enable voice** once per visit; after that the wake phrase works hands-free. If the mic is already allowed, listening starts by itself.
- While Claude is talking, the script only listens for "Thanks". Press Esc or tap the pill to interrupt.
- Chrome's recognition uses Google's servers, so the page must be on `https` or `localhost`.
