# Plan: higher-quality voices for the voice agent

Goal: let the voice widget (js/voice-chat.js) speak with natural voices from several services, alongside the browser's own voices, without slowing page loads. By default it uses Kokoro on localhost and Deepgram Aura on Cloudflare. Voice choices show as toggle buttons below the Talk Circle, and each voice greets you by name when you turn it on.

## Voice sources

| Source | Where it runs | Key | Cost (check before relying on these) | Word timings |
| --- | --- | --- | --- | --- |
| Browser (speechSynthesis) | The browser, as now | None | Free | Yes (boundary events) |
| Kokoro (Kokoro-82M, open source) | The local bridge, on this computer | None | Free, offline. The model downloads once (about 90 MB, q8). | Estimated (kokoro-js gives no timings) |
| Kokoro in the browser | The visitor's browser, on any site including the deployed one (kokoro-js with WebGPU, or WebAssembly where WebGPU is missing) | None | Free. A one-time download of about 185 MB with WebGPU, or 115 MB without, after the visitor confirms it | Estimated |
| Deepgram Aura-2 (`@cf/deepgram/aura-2-en`, `aura-2-es`) | The Cloudflare Worker, through the AI binding | None (the binding) | $0.030 per 1,000 characters, within Workers AI's 10,000 free Neurons per day | Estimated |
| Grok TTS (xAI `POST /v1/tts`) | Bridge or Worker | `XAI_API_KEY`, or the visitor's own xAI key | $15 per million characters | Estimated |
| ElevenLabs (Flash v2.5) | Bridge or Worker | `ELEVENLABS_API_KEY`, or the visitor's own | Free tier of 10,000 credits a month (non-commercial, with attribution), then paid plans | Yes (`/stream/with-timestamps`) |
| OpenAI (`gpt-4o-mini-tts`) | Bridge or Worker | `OPENAI_API_KEY`, or the visitor's own | Low, per minute of audio | Estimated |
| Google Cloud TTS (Chirp 3 HD) | Bridge or Worker | `GOOGLE_TTS_API_KEY`, or the visitor's own | Free monthly allowance, then per character | Estimated |

Anthropic has no text-to-speech API, so it isn't included. macOS Premium and Enhanced voices, and Edge's Natural voices, come in through the browser source, as now.

Defaults:
- **On localhost:** Kokoro, when it's installed on the bridge. Otherwise the browser's voices, with a note saying how to install Kokoro.
- **On the deployed site:** Aura-2 through the AI binding. Otherwise the browser's voices. Kokoro in the browser is a choice there, but never the default, since it needs the download.

## Kokoro in the browser (deployed site)

- **Choosing it:** Kokoro shows among the voice choices on the deployed site too. Choosing it the first time opens a dialog before anything downloads. The dialog says:
  - Kokoro is a free voice that runs in this browser, with no account and nothing sent to a server.
  - It needs a one-time download: about 185 MB with WebGPU, or 115 MB without.
  - The files are kept in the browser's storage for this site, so **restarting the browser doesn't download them again**. They download again only if the site's data is cleared, in a private or incognito window (cleared when it closes), or if the browser removes them to free space. Safari can also remove a site's stored files after several weeks without a visit.
  - It has **Download** and **Not now** buttons, and shows download progress.
- **Not now:** the widget keeps the current voice. The dialog shows again only when Kokoro is chosen again.
- **Keeping the files:** after the download, ask for persistent storage (`navigator.storage.persist()`), which makes the browser less likely to remove the files. A later visit checks whether the files are still cached. If they are, Kokoro starts with no dialog. If they're gone, the dialog shows again before re-downloading.
- **Loading:** kokoro-js (pinned version, from a CDN) and the model load only after the visitor confirms. The ⚙ panel shows the files' size, with a **Remove Kokoro files** button.
- **Speed:** with WebGPU (Chrome, Edge, Brave, recent Safari), the fp16 model makes a 5-second sentence in about 0.3 seconds. Without it, the q8 model on WebAssembly takes about twice a sentence's length, so the dialog says it may pause between sentences.
- **On localhost:** the bridge's Kokoro is used when it's installed. Browser Kokoro is the fallback there, after the same dialog.

## Keeping it modular

- **Browser:** voice-chat.js gets a small "speaker" interface. The existing speechSynthesis code becomes the browser speaker. A new js/voice-audio.js plays audio from the server. voice-chat.js loads it with `import()` only when a server voice is selected or previewed, so a page that uses browser voices loads nothing extra. No provider code ever runs in the browser.
- **Server:** each provider is its own file in shared/tts/ (kokoro.js, aura.js, grok.js, elevenlabs.js, openai.js, google.js). Each exports `{ id, label, available(env), voices(), speak({ text, voice, lang, key }) }`, and speak returns `{ audio, type, words? }`. A registry, shared/tts/index.js, loads a provider with dynamic `import()` the first time it's used. So when nobody uses ElevenLabs, the bridge never loads its module.
- **Kokoro dependencies:** Kokoro is the one source with npm dependencies (kokoro-js, which uses onnxruntime). It gets its own folder, server/kokoro/, with its own package.json, installed with `npm install --prefix engine/server/kokoro`. The bridge stays free of npm dependencies and imports Kokoro only when it's installed and chosen. The model loads on the first Kokoro request and stays in memory.

## Endpoints, on both the bridge and the Worker

- `GET /api/voice-chat/voices`: the sources available here, each with its curated voices (id, name, language, gender and a short description) and whether it needs a key. The bridge lists only Kokoro when it's installed. The Worker lists Aura when it has the AI binding. Keyed sources are listed when a server key is set, or marked as needing the visitor's own key.
- `POST /api/voice-chat/speak` `{ source, voice, text, lang }`:
  - It returns the audio (mp3, or wav for Kokoro), plus word timings in an `x-voice-words` header (JSON) when the source gives them.
  - It accepts one sentence at a time, capped at about 600 characters.
  - The passphrase and rate limit work as for /transcribe.
  - The visitor's own key arrives as `x-provider-name` / `x-provider-key`, the same headers the conversation already uses.
- **Worker caching:** keep a sentence's audio in the Cache API, keyed by source, voice and a hash of the text, so repeated greetings and questions cost nothing.

## Playing server voices (js/voice-audio.js)

The widget already speaks a sentence at a time (speakQueue). With a server voice:
- **Fetching:** each sentence is fetched as the one before it plays, so there's no gap between sentences.
- **Playback** goes through one Audio element:
  - Pause and resume use `audio.pause()` and `audio.play()`.
  - Interrupting aborts the fetch and stops the audio.
  - The `ended` event takes the place of speechSynthesis's `end` event.
- **Word timings** drive the floating keywords and the pulse, as the browser's boundary events do now. They come from the source when it gives them. Otherwise they're estimated from each word's share of the characters across the audio's length.
- **Autoplay:** the existing unlockAudio() also unlocks the Audio element on the first tap.
- **Errors:** if a server voice fails (no key, quota used up, network), that sentence falls back to the best browser voice, and a note says why, once.

## Voice choices below the Talk Circle (js/talk-circle.js, css/engine.css)

- When the circle first loads, a row of 2 to 10 toggle buttons appears below it, one per quality voice. The voices come from `VoiceChat.voices()`, which asks .../voices and ranks the browser's own voices: Premium, Enhanced, Natural and Google voices only, never the robotic ones. The default voice starts turned on.
- Each button shows the voice's name and a small source label, such as "Heart · Kokoro" or "Thalia · Aura". The buttons use `aria-pressed`.
- **Several voices can be on.** One voice on works like "chosen" mode now. With several on, they rotate for each reply by sentiment, as "response" mode does now: the style in Claude's mood header (warm, bright, calm and so on, in VOICE_STYLES) picks the best-suited voice from the ones turned on, never the one just used. VoiceChat gets `setVoicePool(ids)`, and the choice is stored in localStorage (`voice-chat:pool`). VOICE_STYLES gets entries for the new voices, such as Kokoro's af_heart (warm) and bm_george (storyteller), and Aura's thalia (bright).
- **Greeting:** turning a voice on has it greet you with its name, in a greeting usual for its language and region. For example:
  - en-US: "Hi, I'm Heart."
  - en-GB: "Hello, I'm George."
  - en-AU: "G'day, I'm …"
  - en-IN: "Namaste, I'm …"
  - es: "¡Hola, soy …!"
  - fr: "Bonjour, je suis …"
  - ja: "こんにちは、…です。"
  - hi: "नमस्ते, मैं … हूँ।"

  The greetings sit in a small table keyed by language and region, with English as the fallback. Like previewVoice(), a greeting plays only while there's no conversation, so the mic can't take it as speech.
- **Only before the conversation begins:** the row shows when the circle loads and while no conversation has started yet. Once one begins (a tap on the circle, speech, or typing), the row goes away and doesn't come back on that page. From then on, voices change through the ⚙ panel.
- **The ⚙ panel's voice list** groups voices by source, with the same toggles and greetings, so voices can be changed during a conversation and on pages without the circle. It's the same pool, so a change in either place shows in the other.

## Keys and setup

- **.env.example:** `XAI_API_KEY` (already used for conversations), `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` (already used), `GOOGLE_TTS_API_KEY`, and `KOKORO_VOICE` / `KOKORO_DTYPE` (q8 by default).
- **Worker:** the AI binding covers Aura. Other keys are optional secrets, pushed with server/push-secrets.mjs.
- **Keys page:** add ElevenLabs and Google TTS key types, so visitors can use their own keys. xAI and OpenAI keys already exist.

## Steps

Progress is marked on each step: ✅ done, 🔶 in progress.


1. ✅ **Server providers:** shared/tts/ with the registry and the six providers, plus `/voices` and `/speak` on the bridge. Test each with curl to a WAV/MP3 file, and check that providers load only when used.
2. ✅ **Kokoro:** server/kokoro/ with its package.json and the timestamped model. Measure the first-load time and the time per sentence on this Mac.
   - Done: server/kokoro/kokoro.mjs with kokoro-js 1.2.1 (q8). On this Mac the first sentence takes about 12 seconds while the model loads, then 1 to 2 seconds a sentence, faster than it plays. kokoro-js doesn't give word timings, so they're estimated.
   - Tested with curl through a second bridge on 3793: Kokoro and Grok speak. ElevenLabs, OpenAI and Google wait for keys (the env file's OpenAI key is a placeholder, which now counts as no key).
3. ✅ **Worker:** `/voices` and `/speak` in worker/voice-chat-api.js, with Aura-2 through the AI binding, the keyed sources by fetch, and the cache. Test with `npm run dev` on 3701.
   - Done. On 3701, .../voices lists Aura's 15 voices, and .../speak is refused without the team passphrase, as planned. Aura's audio itself isn't confirmed yet: that needs the passphrase (or a test on the deployed site).
   - Changed: a visitor's own key opens only its own source (an xAI key for Grok). Unlike .../transcribe, another of their keys doesn't open Aura, since an unchecked key header would spend the site's allowance.
   - worker/src/keys.js opens Keys page keys encrypted for the server ("rsa:") at .../speak too, and accepts ElevenLabs and Google TTS ones.
4. ✅ **Widget:** the speaker interface in voice-chat.js and the lazy js/voice-audio.js:
   - Check that pages using browser voices make no extra requests.
   - Check pause, resume, interrupt and the floating words in Brave, Chrome and Safari.
   - Done in Chrome: js/voice-audio.js loads only when a server voice first speaks. Kokoro replies spoke, rotating voices, and pause held for 4 seconds then resumed, with no console errors. Not yet tried in Brave or Safari.
   - A failed or slow server voice (9 seconds) hands that sentence to the best browser voice, with a note once.
5. ✅ **Talk Circle:** the voice buttons, the greetings, the pool, and the ⚙ panel grouping.
   - Done: checked on project/care and project/goals, where the circle shrinks to make room for the row. The row goes once a conversation begins.
   - Sources needing a key are one "With a key" line in the ⚙ panel, rather than a group each. The panel's old Voice and Chosen voice choices became Voices, Take Turns and More Browser Voices. A stored chosen voice becomes a pool of that voice.
6. ✅ **Kokoro in the browser:** the download dialog, the persistent-storage request, the cache check on later visits, and Remove Kokoro files. Test it with a restart of Brave and Chrome, and in a private window.
   - Done in Chrome: the dialog, a 29-second download, a cached second visit with no dialog, a reply in Kokoro, Remove Kokoro files, and the dialog again with Not now. Not yet tried: restarting a browser, a private window, Brave or Safari.
   - Changed, from measurements on this Mac: q8 on WebAssembly runs on one thread (the site isn't cross-origin isolated), taking 9 seconds for a 5-second sentence. q8 on WebGPU was no faster. fp16 on WebGPU takes 0.3 seconds. So WebGPU browsers get fp16 (about 185 MB in all), and others q8 (about 115 MB, with pauses, and a longer wait before falling back). The dialog gives whichever size applies.
7. ✅ **Keys page:** the ElevenLabs and Google TTS key types.
   - ElevenLabs was already there. Google Cloud Text-to-Speech is added, with its steps.
8. ✅ **Docs:** README.md gets a "Voices" section on each source, its cost, its key, how to install Kokoro and the defaults, plus .env.example.
   - Also: push-secrets.mjs pushes the voice keys only with --voices, since they let the deployed site spend those accounts. The bridge takes KOKORO=false.
9. 🔶 **Review:** show the changes and confirm before committing. A push to CloudRoot publishes cloud.model.earth.

## Decisions

- **The agent knows its voice:** each question sends the voice speaking now and the voices on (voiceContext in js/voice-chat.js, voiceRules in shared/voice-prompt.js). With several on, Claude names the reply's voice in its header (speaker), preferring an accent that fits the place asked about, such as a British voice for England. Tested through the bridge: a question about London picked George (Kokoro), and "Which voice is speaking?" named the voice.

- **Several voices on:** they rotate for each reply by sentiment, as "response" mode does now.
- **Voice buttons below the circle:** shown only before the conversation begins. After that, voices change in the ⚙ panel.
- **Kokoro on the deployed site:** yes, in the browser, after a dialog confirms the one-time download (185 MB with WebGPU, 115 MB without). The dialog also says that restarting the browser doesn't download it again.
