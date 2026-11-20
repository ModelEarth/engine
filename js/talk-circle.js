/* Talk circle: a large see-through circle that pulses slowly and shows one brief question at a time in large
   type, for people to answer by voice, such as seniors and people living with dementia. A tap or click on it has
   the voice widget (engine/js/voice-chat.js) ask the question aloud and listen for the answer, and Claude replies
   warmly with a gentle follow-up. Without the voice widget, the browser just reads the question aloud. The left and
   right arrow keys move through the questions (arrowKeys).
   Styles are in engine/css/engine.css. Used by project/goals (above its tabs) and project/care (centered).

   Each folder has its own questions. Two ways to add the circle:
   - Declared: <div data-talk-circle="talk-circle.yaml"></div>, centered in that div, with the questions (and an
     optional context for Claude) from the .yaml file beside the page:
       context: "How Claude replies..."   (optional, else TALK_CONTEXT below)
       questions:
         - text: "What's a song you love?"
   - From a page's script: TalkCircle.init({ parent, place, avoid, context }), then TalkCircle.setQuestions(list).
     place(area) positions the circle's area (a fixed area, say) and sets --talk-d, its diameter, returning whether
     it shows. Without it, the circle is centered in its area, as large as fits, up to 440px.

   When the widget's large words start (a reply being spoken), the circle shrinks to 40% and moves to a clear part
   of its area, which the words then keep clear of (data-words-avoid). Meanwhile it shows only the start of the
   next question ("What was your…"): Claude's follow-up question once the reply has it, else the next one in the
   list. A tap stops the reply and asks that question. Once the reply has been spoken, the circle comes back and
   shows the question in full. Large words the circle crosses fade to TALK_DIM, so its question stays readable. */
(function () {
  "use strict";
  if (window.TalkCircle) return;

  const TALK_MS = 20000; // Each question stays this long
  const TALK_SMALL = 0.4; // The circle's size while the large words show
  const TALK_DIM = 0.15; // The opacity of large words under the circle
  const TALK_MAX = 440, TALK_MIN = 220; // The circle's largest diameter, and the smallest it shows at
  const TALK_CONTEXT = "I'm talking with you through the page's conversation circle, which asks brief, friendly questions for older adults, including people living with dementia. It's asking me the question that follows. When I answer, reply warmly in one or two short, simple sentences. Never correct me, quiz me or ask what I remember. Then ask one easy, open question about what I said. If I seem confused or upset, reassure me and gently change the subject.";
  const HINTS = {
    idle: () => (answerAloud() ? "Tap the circle, then answer out loud" : typeof window.VoiceChat?.ask === "function" ? "Tap the circle, then type your answer below." + (speechBrowsers() && `\nFor speech input use\n${speechBrowsers()}.`) : "Tap the circle to hear the question"),
    listening: () => (answerAloud() ? "I'm listening…" : "Type to respond…"),
    thinking: () => "One moment…",
    speaking: () => "",
    error: () => "Voice isn't available in this browser",
  };

  // Whether Chrome's speech input works. It does once the microphone is allowed (engine/js/voice-chat.js, by SR):
  // then Chrome is asked for a spoken answer and suggested to browsers without speech input. False treats Chrome
  // on Mac as typing only (a typed answer, with Safari suggested), though the widget still listens there.
  const CHROME_SPEECH = true;
  // A browser whose speech input works on this device, for when this one's doesn't (Firefox has none, and Brave
  // turns off the service behind it): Safari on Mac, iPhone and iPad, Edge on Windows, and Chrome with CHROME_SPEECH.
  // Elsewhere, as on Linux without CHROME_SPEECH, no browser is suggested.
  function speechBrowsers() {
    const ua = navigator.userAgent, platform = navigator.userAgentData?.platform || navigator.platform || "";
    if (/iPhone|iPad|iPod/.test(ua) || (/mac/i.test(platform) && navigator.maxTouchPoints > 1)) return "Safari";
    if (/mac/i.test(platform)) return CHROME_SPEECH ? "Safari or Chrome" : "Safari";
    if (/win/i.test(platform)) return CHROME_SPEECH ? "Edge or Chrome" : "Edge";
    return CHROME_SPEECH && /android|linux|cros|chrome os/i.test(ua + platform) ? "Chrome" : "";
  }
  // The voice widget's answer when it's loaded. Brave has SpeechRecognition but turns off the service behind it, and
  // iOS browsers other than Safari have it without the permission to use it.
  const canListen = () => (typeof window.VoiceChat?.canListen === "boolean" ? window.VoiceChat.canListen : !navigator.brave && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent) && !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  // Whether the circle asks for a spoken answer: where the browser can listen, except Chrome on Mac without CHROME_SPEECH.
  const chromeMac = (() => {
    const brands = navigator.userAgentData?.brands;
    const chrome = brands ? brands.some((b) => b.brand === "Google Chrome") : /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\/|Vivaldi/.test(navigator.userAgent);
    return chrome && /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "") && navigator.maxTouchPoints < 2;
  })();
  const answerAloud = () => canListen() && (CHROME_SPEECH || !chromeMac);
  const calm = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  let opts = {}, area = null, slot = null, zone = null;
  let questions = [], at = 0, timer = null, talking = false;
  let text = "", asked = "", small = false, spot = null, wordsField = null, dimFrame = 0;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === "text" ? (e.textContent = v) : e.setAttribute(k, v);
    e.append(...children);
    return e;
  }
  // While a conversation from the circle is on, html.talk-circle-talking hides what's marked .talk-circle-hide (engine.css).
  function setTalking(on) {
    talking = on;
    document.documentElement.classList.toggle("talk-circle-talking", on);
  }
  const part = (name) => zone?.querySelector(`.talk-circle-${name}`);

  // Options: parent (where the area goes, else the body), area (an element to use as the area instead), place
  // (see above), avoid (a selector for what the small circle keeps clear of, besides the large words), context
  // (for Claude) and questions.
  function init(options = {}) {
    if (zone) return api;
    opts = { avoid: ".voice-chat-ui", context: TALK_CONTEXT, ...options };
    zone = el("button", { type: "button", class: "talk-circle", "data-state": "idle", "data-words-avoid": "" },
      el("span", { class: "talk-circle-question" }), el("span", { class: "talk-circle-hint" }), el("span", { class: "talk-circle-links" }));
    zone.addEventListener("click", ask);
    area = opts.area || el("div");
    area.classList.add("talk-circle-area");
    area.hidden = true;
    // The circle's slot keeps its full size while the circle shrinks inside it, so what's beside it in the area
    // (project/care: the title below it) stays put. It goes first, before what the page put in the area.
    slot = el("div", { class: "talk-circle-slot" }, zone);
    area.prepend(slot);
    if (!area.isConnected) (opts.parent || document.body).append(area);
    // The voice widget's events don't bubble up from its target (#fullscreen), so they're heard capturing.
    document.addEventListener("voice-chat:state", (e) => {
      const st = e.detail?.state;
      watchWords();
      showLinks(); // Not needed once the widget has loaded
      if (st !== "speaking") setSmall(false); // The reply has been spoken, or cut short
      if (!talking) return;
      if (st === "off" || st === "error") { setTalking(false); setState(st === "error" ? "error" : "idle"); syncTimer(); }
      else if (HINTS[st]) setState(st);
      // Without voice input, the cursor goes in the widget's typing box for the answer.
      if (st === "listening" && !answerAloud() && typeof window.VoiceChat?.focusInput === "function") window.VoiceChat.focusInput();
    }, true);
    document.addEventListener("voice-chat:reply", (e) => {
      if (!talking) return;
      const q = (String(e.detail?.text || "").match(/[^.!?]*\?/g) || []).pop()?.trim();
      if (q && q.length <= 140) showText(q);
    }, true);
    // Once the widget knows whether it can listen through the bridge (speech to text for browsers without their own),
    // the hint asks for a spoken or typed answer to match.
    document.addEventListener("voice-chat:stt", () => { if (!talking) setState("idle"); }, true);
    // While the widget's pause button holds listening, the circle doesn't say it's listening.
    document.addEventListener("voice-chat:pause", () => { if (zone?.dataset.state === "listening") setState("listening"); }, true);
    document.addEventListener("voice-chat:end", () => {
      if (!talking) return;
      setTalking(false);
      setState("idle");
      nextQuestion();
      syncTimer();
    }, true);
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    window.addEventListener("hashchange", showLinks);
    document.addEventListener("visibilitychange", syncTimer);
    document.addEventListener("keydown", arrowKeys);
    if (opts.questions) setQuestions(opts.questions);
    else place();
    return api;
  }

  // Without the voice widget (no backend for the page's site), the circle can only read its question aloud, so
  // below its hint it links to the same page where Claude can answer: the local CloudRoot Worker on port 3701
  // when it's running (AGENTS.md), and neighborhood.org, or else neighborhood.org and cloud.model.earth.
  // Only on a local page: on public sites the hint shows alone.
  const LOCAL_PORT = 3701;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.hostname.endsWith(".localhost");
  let portUp = null;
  function portCheck() {
    if (portUp) return portUp;
    portUp = location.port === String(LOCAL_PORT) ? Promise.resolve(false)
      : fetch(`http://${location.hostname}:${LOCAL_PORT}/`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(2000) })
        .then(() => true, () => false);
    return portUp;
  }
  function showLinks() {
    const links = part("links");
    if (!links) return;
    if (!local || zone.dataset.state !== "idle" || typeof window.VoiceChat?.ask === "function") { links.replaceChildren(); return; }
    const path = location.pathname + location.search + location.hash;
    // A tap on a link follows it, without the circle asking its question too.
    const link = (origin, label) => {
      const a = el("a", { href: origin + path, text: label });
      a.addEventListener("click", (e) => e.stopPropagation());
      return a;
    };
    portCheck().then((up) => {
      if (zone.dataset.state !== "idle" || typeof window.VoiceChat?.ask === "function") return;
      links.replaceChildren(...(up
        ? ["Interact on ", link(`http://${location.hostname}:${LOCAL_PORT}`, String(LOCAL_PORT)), " or ", link("https://neighborhood.org", "Neighborhood.org")]
        : ["Interact at ", link("https://neighborhood.org", "Neighborhood.org"), " or ", link("https://cloud.model.earth", "cloud.model.earth")]));
    });
  }

  // The large words (.w) arriving in the voice widget's word layer shrink the circle. The layer is
  // the widget's own, in #fullscreen, found once the widget's first event shows it's loaded.
  function watchWords() {
    const field = document.querySelector("#fullscreen > .voice-chat-words")?.shadowRoot?.querySelector(".field");
    if (!field || field === wordsField) return;
    wordsField = field;
    new MutationObserver((list) => {
      if (!list.some((m) => [...m.addedNodes].some((n) => n.classList?.contains("w")))) return;
      if (window.VoiceChat?.state === "speaking") setSmall(true);
      if (!dimFrame) dimFrame = requestAnimationFrame(dimWords);
    }).observe(field, { childList: true });
  }
  // Large words that the circle (a true circle, not its box) crosses fade to TALK_DIM, and come back
  // once it's clear of them. Checked each frame while any show, since the circle moves and grows and
  // the words drift. A filter, so the widget's own opacity and animations on the words are left alone.
  function dimWords() {
    const words = [...(wordsField?.querySelectorAll(".w") || [])];
    let c = null;
    if (zone && !area.hidden) {
      const z = zone.getBoundingClientRect();
      c = { x: z.left + z.width / 2, y: z.top + z.height / 2, r: z.width / 2 };
    }
    for (const w of words) {
      const r = w.getBoundingClientRect();
      const hit = !!c && Math.hypot(c.x - Math.max(r.left, Math.min(c.x, r.right)), c.y - Math.max(r.top, Math.min(c.y, r.bottom))) < c.r;
      if ((w.dataset.zoneDim === "1") === hit) continue;
      w.dataset.zoneDim = hit ? "1" : "";
      w.style.transition = "filter 0.3s ease";
      w.style.filter = hit ? `opacity(${TALK_DIM})` : "";
    }
    dimFrame = words.length ? requestAnimationFrame(dimWords) : 0;
  }

  // A list of items with text, or of strings.
  function setQuestions(list) {
    const qs = (Array.isArray(list) ? list : []).map((q) => String(typeof q === "string" ? q : q?.text || "").trim()).filter(Boolean);
    if (qs.join("\n") === questions.join("\n")) return place();
    questions = qs;
    at = Math.floor(Math.random() * qs.length);
    if (qs.length && !talking) showText(qs[at], true);
    place();
  }
  // Questions (and an optional context for Claude) from a .yaml file, read with localsite's YAML parser (loaded if needed).
  async function load(url) {
    if (!window.YAML?.parse) await new Promise((resolve, reject) => {
      const s = el("script", { src: "/localsite/js/yaml.js" });
      s.onload = resolve;
      s.onerror = () => reject(new Error("Can't load /localsite/js/yaml.js"));
      document.head.append(s);
    });
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const data = window.YAML.parse(await res.text()) || {};
    if (data.context) opts.context = String(data.context).trim();
    setQuestions(Array.isArray(data) ? data : data.questions);
  }
  const question = () => text || questions[at] || "";
  function nextQuestion() {
    if (!questions.length) return;
    at = (at + 1) % questions.length;
    showText(questions[at]);
  }
  // The left and right arrow keys move back and forward through the questions, around the list either way, so back
  // from the first goes to the last. Only while the circle shows, and while the focus is on the page itself or in the
  // circle's area, so the keys still work as usual in the page's controls and the voice widget's typing box.
  function arrowKeys(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!area || area.hidden || questions.length < 2) return;
    const focus = document.activeElement;
    if (focus && focus !== document.body && focus !== document.documentElement && !area.contains(focus)) return;
    e.preventDefault();
    at = (at + (e.key === "ArrowRight" ? 1 : -1) + questions.length) % questions.length;
    showText(questions[at], true); // At once, without the fade
    // A fresh TALK_MS before the next change on its own.
    if (timer) { clearInterval(timer); timer = null; }
    syncTimer();
  }
  // The start of a question, for the small circle: its first three words (fewer for a short one) and "…".
  function teaser(t) {
    const words = t.split(/\s+/);
    return `${words.slice(0, Math.max(1, Math.min(3, words.length - 1))).join(" ")}…`;
  }
  function showText(t, now = false) {
    text = t;
    renderText(now);
  }
  // Fades the question out and the new one in, or swaps it at once with reduced motion.
  // now: at once, as for the arrow keys, stopping any fade under way so the question shows fully.
  function renderText(now = false) {
    const q = part("question");
    if (!q) return;
    const shown = small ? teaser(text) : text;
    if (now && q.getAnimations) q.getAnimations().forEach((a) => a.cancel());
    if (q.textContent === shown) return;
    if (now || calm() || area.hidden || !q.animate) { q.textContent = shown; return; }
    q.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: "ease-in" }).finished.then(() => {
      q.textContent = small ? teaser(text) : text; // As it is by now
      q.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: "ease-out" });
    }, () => {}); // Cancelled by an arrow key, which shows its question itself
  }
  function setState(state) {
    if (!zone) return;
    zone.dataset.state = state;
    part("hint").textContent = state === "listening" && window.VoiceChat?.listenPaused ? "" : HINTS[state]();
    showLinks();
  }
  // Small while a reply's large words show, at a clear spot (placeSpot); back home at full size after.
  // Small during a conversation from the circle, it offers a new question rather than the one just asked.
  function setSmall(on) {
    if (!area || on === small || (on && area.hidden)) return;
    small = on;
    if (on && talking && text === asked && questions.length > 1) {
      at = (at + 1) % questions.length;
      text = questions[at];
    }
    spot = null;
    if (on) placeSpot();
    zone.classList.toggle("talk-circle-small", on);
    renderText();
  }
  // A fixed area keeps the small circle's spot in the window; one in the page keeps it in the area, as the page scrolls.
  const areaFixed = () => getComputedStyle(area).position === "fixed";
  // Of spots across the area, away from where the circle is now, the one covering the least of the large words,
  // the voice widget's controls and captions and what else opts.avoid names, picked at random among the clearest.
  function placeSpot() {
    const r = area.getBoundingClientRect(), s = slot.getBoundingClientRect();
    const d = parseFloat(area.style.getPropertyValue("--talk-d")) * TALK_SMALL;
    const home = { x: s.left + s.width / 2, y: s.top + s.height / 2 };
    const taken = [...(wordsField?.querySelectorAll(".w, .stmt") || [])].map((w) => ({ r: w.getBoundingClientRect(), weight: 1 }));
    if (opts.avoid) for (const a of document.querySelectorAll(opts.avoid)) taken.push({ r: a.getBoundingClientRect(), weight: 6 });
    const cover = (c) => taken.reduce((sum, t) => {
      const w = Math.min(c.x + d / 2, t.r.right) - Math.max(c.x - d / 2, t.r.left);
      const h = Math.min(c.y + d / 2, t.r.bottom) - Math.max(c.y - d / 2, t.r.top);
      return sum + (w > 0 && h > 0 ? w * h * t.weight : 0);
    }, 0);
    const x0 = Math.max(16, r.left) + d / 2, x1 = Math.min(window.innerWidth - 16, r.right) - d / 2;
    const y0 = Math.max(0, r.top) + d / 2, y1 = Math.min(window.innerHeight, r.bottom) - d / 2;
    const spots = [];
    for (let i = 0; i < 7; i++) for (let j = 0; j < 4; j++) {
      const c = { x: x0 + Math.max(0, x1 - x0) * (i + Math.random() * 0.6 + 0.2) / 7, y: y0 + Math.max(0, y1 - y0) * (j + Math.random() * 0.6 + 0.2) / 4 };
      if (Math.hypot(c.x - home.x, c.y - home.y) > d) spots.push({ ...c, cost: cover(c) });
    }
    if (!spots.length) return;
    const least = Math.min(...spots.map((s) => s.cost));
    const clear = spots.filter((s) => s.cost <= least * 1.1 + 1);
    const pick = clear[Math.floor(Math.random() * clear.length)];
    spot = areaFixed() ? pick : { dx: pick.x - home.x, dy: pick.y - home.y };
    moveZone();
  }
  function moveZone() {
    if (!spot) { area.style.removeProperty("--talk-dx"); area.style.removeProperty("--talk-dy"); return; }
    const r = slot.getBoundingClientRect();
    const dx = spot.dx ?? spot.x - r.left - r.width / 2, dy = spot.dy ?? spot.y - r.top - r.height / 2;
    area.style.setProperty("--talk-dx", `${Math.round(dx)}px`);
    area.style.setProperty("--talk-dy", `${Math.round(dy)}px`);
  }
  function ask() {
    const q = question();
    if (!q) return;
    if (typeof window.VoiceChat?.ask === "function") {
      setTalking(true);
      asked = q;
      syncTimer();
      setSmall(false);
      window.VoiceChat.ask(q, opts.context); // Stops a reply under way
    } else if (window.speechSynthesis) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(q));
    }
  }
  // Centered in its area, as large as fits with 16px around it, up to TALK_MAX. What else the page put in the area
  // (project/care: the title) is stacked below it and centered with it, so it keeps its place beside the circle.
  function placeCentered() {
    const r = area.getBoundingClientRect();
    const rest = [...area.children].reduce((h, c) => h + (c === slot ? 0 : c.getBoundingClientRect().height), 0);
    const d = Math.round(Math.min(r.width - 32, r.height - 32 - rest, TALK_MAX));
    area.style.setProperty("--talk-d", `${d}px`);
    return d >= TALK_MIN;
  }
  // Shows the circle when it has questions and room (opts.place, else placeCentered). The page's place is asked
  // either way, since it may do more, such as project/goals marking its up/down arrow.
  function place() {
    if (!area) return;
    const room = (opts.place || placeCentered)(area);
    const on = !!room && questions.length > 0;
    if (on) {
      if (area.hidden) setState(talking ? zone.dataset.state : "idle");
      moveZone();
    }
    area.hidden = !on;
    if (!on) setSmall(false);
    syncTimer();
  }
  // The questions change every TALK_MS while the circle shows, the tab is in view and no conversation is on.
  function syncTimer() {
    const run = !!area && !area.hidden && !talking && !document.hidden && questions.length > 1;
    if (run && !timer) timer = setInterval(nextQuestion, TALK_MS);
    else if (!run && timer) { clearInterval(timer); timer = null; }
  }

  const api = {
    init, setQuestions, load, place, ask,
    get count() { return questions.length; },
    get state() { return zone?.dataset.state || ""; },
  };
  window.TalkCircle = api;

  // A div marked data-talk-circle="<file>.yaml" gets the circle, centered, with that file's questions.
  function auto() {
    const host = document.querySelector("[data-talk-circle]");
    if (!host || zone) return;
    init({ area: host });
    load(host.dataset.talkCircle || "talk-circle.yaml").catch((err) => console.warn("Talk circle:", err.message));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", auto);
  else auto();
})();
