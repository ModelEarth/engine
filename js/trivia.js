/* Trivia: multiple-choice questions from a CSV file, asked aloud by the voice widget (engine/js/voice-chat.js), with a
   clip of each question's song playing before and after the person guesses. Any page can add sets of questions. The talk
   circle (engine/js/talk-circle.js) adds Georgia music trivia, shown in its Music tab. Styles are in engine/css/trivia.css,
   which this loads.

     Trivia.add({ id: "georgia-music", title: "Georgia Music", csv: "/feed/music/georgia-music-trivia-all.csv", group: "City" });
     Trivia.card(parent);                       // The current question, its choices and the score, kept up to date
     Trivia.question({ set, group });  Trivia.answer(choice);  Trivia.end();

   A set's CSV has a header row. Its columns (set.columns to rename them): Question, Possible Answers (separated by |) and
   Correct Answer, and optionally Audio Clip Lookup URL (the clip) and the set's group column (City: "Ask me about Macon").
   The other columns, except those in set.omit (by default Audio Source, Rights / License and Reference), are facts that
   Claude tells after the guess, and the card shows set.reveal of them (all, by default).

   Clips: an iTunes Search API address (itunes.apple.com/search) plays a 30-second preview of its best match, the original
   recording (the row's Artist and Song, not live, karaoke or a cover, nearest its Year), with an Apple Music link beside it
   as Apple's terms ask. An archive.org item, search or file, or any other audio file, plays as it is. The clip plays for
   LEAD_S before Claude asks the question, softly under Claude's voice and while the person answers, and again from its
   start once they've guessed. The voice widget's play-pause button pauses and resumes it.

   Music (Trivia.playMusic): every clip of a set in turn, from the card's Play Music button. Trivia.music is the song
   playing, Trivia.step(1) and step(-1) move through them, and Trivia.toggleMusic() pauses and resumes. For each song,
   Claude is consulted unspoken (VoiceChat.consult) for a mood that fits it, which sets the voice widget's colors, and,
   when the song suits one, an Earth map view (show_earth) as its background, else the map closes (hide_earth).

   Claude asks each question aloud (VoiceChat.ask) with the answer and the facts sent unspoken beside it (ask's note), so it
   can say whether the guess is right. Without the voice widget, the card's choices and buttons run the questions.
   Page actions (localsite.js registerPageTool, run from an action tag in Claude's reply): trivia_question, trivia_answer
   and trivia_end. A "trivia:change" event on the document follows each change, with detail.question when one is asked. */
(function () {
  "use strict";
  if (window.Trivia) return;
  const SCRIPT = document.currentScript?.src || "";
  const CSS = SCRIPT ? new URL("../css/trivia.css", SCRIPT).href : "";
  if (CSS && !document.querySelector(`link[href="${CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS;
    document.head.append(link);
  }
  const LEAD_S = 8; // Seconds of the clip before the question is asked
  const LOAD_MS = 8000; // How long a clip has to start before the question is asked without it
  const VOLUME = { lead: 1, speaking: 0.2, listening: 0.4 };
  const COLUMNS = { question: "Question", choices: "Possible Answers", answer: "Correct Answer", clip: "Audio Clip Lookup URL" };
  const OMIT = ["Audio Source", "Rights / License", "Reference"];
  const NOT_ORIGINAL = /\b(live|karaoke|instrumental|remix|lullaby|tribute|re-?recorded|in the style|extended|acoustic|demo|cover)\b/i;

  const sets = new Map();
  const cards = new Set();
  let quiz = null; // { set, list, at, right, done, group, q, over }
  let flow = 0; // The question being asked, so an older one's steps stop
  const audio = new Audio();
  audio.preload = "auto";
  let clip = null, phase = "", held = false, blocked = false, problem = "";
  let playlist = null; // { set, list, at, src }: every clip of a set, played in turn (playMusic)
  const MOOD_WAIT_MS = 1200; // A song plays this long before Claude is asked for its mood, so quick steps past it ask nothing

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  };
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    e.append(...kids.filter((k) => k != null && k !== false));
    return e;
  };
  const vc = () => window.VoiceChat;
  const talking = () => ["listening", "thinking", "speaking"].includes(vc()?.state);

  function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') cell += c;
        else if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [head = [], ...body] = rows.filter((r) => r.some((c) => c.trim()));
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || "").trim()])));
  }

  // A set: { id, title, csv, group, columns, omit, reveal, about }. about: what Claude is told the set is, else its title.
  function add(opts) {
    const set = { ...opts, columns: { ...COLUMNS, ...opts.columns }, omit: opts.omit || OMIT, rows: null };
    sets.set(set.id, set);
    registerTools();
    render();
    return api;
  }
  async function rowsOf(set) {
    const c = set.columns;
    set.rows ||= fetch(set.csv)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`The ${set.title} questions didn't load (${r.status})`))))
      .then((text) => (set.loaded = parseCSV(text).filter((r) => r[c.question] && r[c.choices] && r[c.answer])));
    try { return await set.rows; } catch (e) { set.rows = null; throw e; }
  }
  const groupsOf = (set, rows) => (set.group ? [...new Set(rows.map((r) => r[set.group]).filter(Boolean))].sort() : []);

  // A row as a question: its choices shuffled, or in order when they're all numbers, with the answer among them.
  function questionOf(set, row) {
    const c = set.columns;
    let choices = [...new Set(row[c.choices].split("|").map((s) => s.trim()).filter(Boolean))];
    if (!choices.includes(row[c.answer])) choices.push(row[c.answer]);
    const num = (s) => parseFloat(s.replace(/,/g, ""));
    choices = choices.every((s) => /^-?[\d,.]+$/.test(s)) ? choices.sort((a, b) => num(a) - num(b)) : shuffle(choices);
    const skip = new Set([c.question, c.choices, c.answer, c.clip, ...set.omit]);
    const facts = Object.entries(row).filter(([k, v]) => v && !skip.has(k));
    return { row, text: row[c.question], choices, answer: row[c.answer], clip: row[c.clip] || "", facts, picked: null };
  }

  // The next question: of the set (else the one under way, else the first added), and of group when given.
  async function question({ set: id, group } = {}) {
    const set = sets.get(id) || quiz?.set || sets.values().next().value;
    if (!set) throw new Error("There's no trivia on this page");
    const rows = await rowsOf(set);
    const fresh = !quiz || quiz.over || quiz.set !== set || (group != null && norm(group) !== norm(quiz.group));
    if (fresh) {
      let list = rows;
      if (group) {
        const g = norm(group);
        list = rows.filter((r) => norm(r[set.group]) === g);
        if (!list.length) list = rows.filter((r) => norm(r[set.group]).includes(g) || g.includes(norm(r[set.group])));
        if (!list.length) throw new Error(`There are no ${set.title} questions about ${group}. They're about ${groupsOf(set, rows).join(", ")}.`);
      }
      quiz = { set, list: shuffle(list.slice()), at: -1, right: 0, done: 0, group: group ? list[0][set.group] : "", q: null, over: false };
    }
    if (quiz.at + 1 >= quiz.list.length) {
      quiz.over = true;
      stopClip();
      changed();
      return `That was the last ${set.title} question: ${quiz.right} of ${quiz.done} right. Asking again starts over.`;
    }
    quiz.q = questionOf(set, quiz.list[++quiz.at]);
    playlist = null;
    const q = quiz.q, my = ++flow;
    changed({ question: q });
    stopClip();
    ask(q, my).catch((e) => console.warn("[trivia]", e));
    clipOf(quiz.list[quiz.at + 1] && questionOf(set, quiz.list[quiz.at + 1])); // Looked up ahead
    return `Question ${quiz.at + 1} of ${quiz.list.length}${quiz.group ? ` about ${quiz.group}` : ""} is shown and will be asked aloud after your reply.`;
  }

  // Once Claude's reply has been spoken, the clip plays for LEAD_S, then Claude asks the question.
  async function ask(q, my) {
    await replyDone();
    if (my !== flow) return;
    phase = "lead";
    const src = await Promise.race([clipOf(q), new Promise((r) => setTimeout(() => r(null), LOAD_MS))]);
    if (my !== flow) return;
    if (src) await play(src, my, LEAD_S);
    if (my !== flow) return;
    phase = "before";
    duck();
    const v = vc();
    if (typeof v?.ask !== "function") return;
    const choices = q.choices.length > 1 ? `${q.choices.slice(0, -1).join(", ")}, or ${q.choices.at(-1)}?` : "";
    v.ask(`${q.text} ${choices}`.trim(), null, note(q));
  }
  const replyDone = () => new Promise((resolve) => {
    const busy = () => ["thinking", "speaking"].includes(vc()?.state);
    if (!busy()) return resolve();
    const on = () => { if (!busy()) { document.removeEventListener("voice-chat:state", on, true); resolve(); } };
    document.addEventListener("voice-chat:state", on, true);
  });
  // What Claude is told beside the question, unspoken: the answer, the facts and how to reply.
  function note(q) {
    const set = quiz.set;
    const facts = q.facts.map(([k, v]) => `${k}: ${v}`).join("; ");
    return `(From the page, not spoken: a trivia question from ${set.about || set.title}, number ${quiz.at + 1} of ${quiz.list.length}${quiz.group ? `, about ${quiz.group}` : ""}. `
      + `The page shows it with its choices${q.clip ? " and plays a clip of it" : ""}. The answer is "${q.answer}". About it: ${facts}. `
      + `Score before this question: ${quiz.right} of ${quiz.done}. When I answer, say warmly in a sentence or two whether I'm right, `
      + `with the answer and one fact about it, and write the trivia_answer action with the choice I picked, exactly as listed. `
      + `Don't give the answer before I guess. If I ask to hear the question or the choices again, repeat them. Then ask whether I'd like `
      + `another; for yes, write the trivia_question action, and when I'm done, the trivia_end action and my score.)`;
  }

  // The guess: the choice it matches, else what was said. A question's first guess counts.
  function answer(choice) {
    const q = quiz?.q;
    if (!q || quiz.over) throw new Error("No trivia question is waiting for an answer");
    const said = norm(choice);
    const match = q.choices.find((c) => norm(c) === said)
      || (said && q.choices.filter((c) => norm(c).includes(said) || said.includes(norm(c))).length === 1
        && q.choices.find((c) => norm(c).includes(said) || said.includes(norm(c))));
    if (!q.picked) {
      q.picked = match || String(choice || "").trim() || "—";
      quiz.done++;
      if (q.picked === q.answer) quiz.right++;
    }
    flow++;
    phase = "after";
    changed();
    clipOf(q).then((src) => src && quiz?.q === q && play(src, flow, 0, true));
    return `${q.picked === q.answer ? "Right" : "Not quite"}: the answer is ${q.answer}. ${quiz.right} of ${quiz.done} right.`;
  }

  function end() {
    flow++;
    stopClip();
    playlist = null;
    if (!quiz) return "There's no trivia under way.";
    quiz.over = true;
    changed();
    return `Trivia ended: ${quiz.right} of ${quiz.done} right.`;
  }

  // ---- Clips
  const clips = new Map(); // Lookup address: a promise of { src, kind, link, label }, or null
  const found = new Map(); // Lookup address: its clip, once found
  function clipOf(q) {
    if (!q?.clip) return Promise.resolve(null);
    if (!clips.has(q.clip)) {
      clips.set(q.clip, lookup(q).then((src) => { if (src) found.set(q.clip, src); return src; })
        .catch((e) => { console.warn("[trivia] clip", q.clip, e); clips.delete(q.clip); return null; }));
    }
    return clips.get(q.clip);
  }
  const fact = (q, start) => (q.facts.find(([k]) => k.toLowerCase().startsWith(start)) || [])[1] || "";
  async function lookup(q) {
    const u = new URL(q.clip, location.href);
    if (/(^|\.)itunes\.apple\.com$/.test(u.hostname) && u.pathname === "/search") return itunes(u, q);
    if (/(^|\.)archive\.org$/.test(u.hostname)) return archive(u);
    const label = /wikimedia\.org$/.test(u.hostname) ? "Wikimedia Commons" : u.hostname.replace(/^www\./, "");
    return { src: u.href, kind: "file", link: u.href, label };
  }
  // The best of the search's songs: the row's artist and song, not live, karaoke or a cover, nearest its year.
  async function itunes(u, q) {
    u.searchParams.set("limit", "25");
    const r = await fetch(u.href);
    if (!r.ok) throw new Error(`iTunes search ${r.status}`);
    const results = ((await r.json()).results || []).filter((x) => x.previewUrl);
    const artist = fact(q, "artist").replace(/\s*\(.*?\)\s*/g, " ").trim();
    const artists = [artist, artist.split(/\s+(?:feat\.?|featuring|with)\s+/i)[0]].map(norm).filter(Boolean);
    const song = norm(fact(q, "song")), year = parseInt(fact(q, "year"), 10);
    const score = (x) => {
      const a = norm(x.artistName), t = norm(x.trackName);
      let s = 0;
      if (artists.some((w) => a.includes(w) || w.includes(a))) s += 4;
      if (song && (t.startsWith(song) || song.startsWith(norm(x.trackName.replace(/\s*[([].*$/, ""))))) s += 3;
      if (NOT_ORIGINAL.test(`${x.trackName} ${x.collectionName || ""}`)) s -= 3;
      if (year && x.releaseDate) s -= Math.min(2, Math.abs(parseInt(x.releaseDate, 10) - year) / 20);
      return s;
    };
    const best = results.map((x, i) => ({ x, s: score(x) - i / 1000 })).sort((a, b) => b.s - a.s)[0]?.x;
    return best ? { src: best.previewUrl, kind: "apple", link: best.trackViewUrl || "https://music.apple.com/", label: "Apple Music" } : null;
  }
  // An archive.org file as it is; an item's first MP3; a search's first audio item's.
  async function archive(u) {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "download" && parts.length > 2) return { src: u.href, kind: "archive", link: `https://archive.org/details/${parts[1]}`, label: "archive.org" };
    let id = (parts[0] === "details" || parts[0] === "download") && parts[1] ? decodeURIComponent(parts[1]) : "";
    if (!id) {
      const query = u.searchParams.get("query") || u.searchParams.get("q");
      if (!query) return null;
      const s = new URL("https://archive.org/advancedsearch.php");
      s.searchParams.set("q", `(${query}) AND mediatype:audio`);
      s.searchParams.append("fl[]", "identifier");
      s.searchParams.set("rows", "1");
      s.searchParams.set("output", "json");
      const r = await fetch(s.href);
      id = r.ok ? (await r.json()).response?.docs?.[0]?.identifier : "";
      if (!id) return null;
    }
    const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`archive.org ${r.status}`);
    const files = (await r.json()).files || [];
    const rank = ["VBR MP3", "MP3", "128Kbps MP3", "64Kbps MP3"];
    const file = files.filter((f) => rank.includes(f.format)).sort((a, b) => rank.indexOf(a.format) - rank.indexOf(b.format))[0];
    return file ? { src: `https://archive.org/download/${encodeURIComponent(id)}/${file.name.split("/").map(encodeURIComponent).join("/")}`, kind: "archive", link: `https://archive.org/details/${encodeURIComponent(id)}`, label: "archive.org" } : null;
  }

  // Plays the clip from its start (or where it is, for the same clip), resolving after `until` seconds, or when it ends,
  // fails or is stopped. restart: from the start even when it's the same clip.
  function play(src, my, until = 0, restart = false) {
    return new Promise((resolve) => {
      if (clip !== src || restart) {
        clip = src;
        if (audio.src !== src.src) audio.src = src.src;
        audio.currentTime = 0;
      }
      held = false;
      duck();
      const done = () => { audio.removeEventListener("timeupdate", tick); audio.removeEventListener("ended", done); audio.removeEventListener("error", done); clearInterval(check); resolve(); };
      const tick = () => { if (!until || audio.currentTime >= until) done(); };
      const check = setInterval(() => { if (my !== flow) done(); }, 250);
      audio.addEventListener("ended", done);
      audio.addEventListener("error", done);
      if (until) audio.addEventListener("timeupdate", tick);
      const p = audio.play();
      blocked = false;
      changed();
      p?.then(() => { if (!until) done(); }, (e) => {
        blocked = e?.name === "NotAllowedError";
        changed();
        done();
      });
    });
  }
  function stopClip() {
    audio.pause();
    held = false;
    blocked = false;
    phase = "";
  }
  // Softer under Claude's voice and while the person answers; paused once they've answered, until their guess is in.
  function duck() {
    const st = vc()?.state;
    if (phase === "lead") audio.volume = VOLUME.lead;
    else if (st === "speaking" || st === "thinking") audio.volume = VOLUME.speaking;
    else audio.volume = talking() ? VOLUME.listening : VOLUME.lead;
  }
  document.addEventListener("voice-chat:state", (e) => {
    duck();
    if (e.detail?.state === "thinking" && phase === "before" && !audio.paused) audio.pause();
  }, true);
  // The widget's play-pause button: holding Claude's voice holds the clip, and resuming resumes it.
  document.addEventListener("voice-chat:pause", (e) => {
    if (e.detail?.audio) { if (!audio.paused) { audio.pause(); held = true; changed(); } }
    else if (held) { held = false; audio.play().catch(() => {}); changed(); }
  }, true);
  document.addEventListener("voice-chat:end", () => { if (phase === "song") return; flow++; stopClip(); changed(); }, true);
  for (const t of ["play", "pause"]) audio.addEventListener(t, () => (playlist ? changed() : render()));
  audio.addEventListener("ended", () => (phase === "song" && playlist ? step(1) : render()));
  audio.addEventListener("error", () => { if (phase === "song" && playlist && audio.src) step(1); });

  // ---- Music: every clip of a set in turn, each once (rows sharing a clip play it once), from the first.
  async function playMusic({ set: id, at = 0 } = {}) {
    const set = sets.get(id) || quiz?.set || sets.values().next().value;
    if (!set) throw new Error("There's no music on this page");
    const seen = new Set();
    const list = (await rowsOf(set)).map((r) => questionOf(set, r)).filter((q) => q.clip && !seen.has(q.clip) && seen.add(q.clip));
    if (!list.length) throw new Error(`The ${set.title} questions have no clips`);
    playlist = { set, list, at: 0, src: null, skipped: 0 };
    changed({ music: "start" });
    song(at);
    return `Playing ${list.length} ${set.title} clips.`;
  }
  // The song at i (around the list either way), skipping those without a clip that plays.
  function song(i) {
    const p = playlist;
    if (!p) return;
    p.at = (i + p.list.length) % p.list.length;
    p.src = null;
    const q = p.list[p.at], my = ++flow;
    stopClip();
    phase = "song";
    changed({ music: "song" });
    clipOf(q).then((src) => {
      if (my !== flow || playlist !== p) return;
      if (!src) { if (++p.skipped < p.list.length) song(p.at + 1); return; }
      p.skipped = 0;
      p.src = src;
      play(src, my, 0, true);
      phase = "song";
      setTimeout(() => { if (my === flow && playlist === p) moodFor(q, my); }, MOOD_WAIT_MS);
    });
    clipOf(p.list[(p.at + 1) % p.list.length]); // Looked up ahead
  }
  function step(by) {
    if (playlist) song(playlist.at + by);
  }
  function stopMusic() {
    if (!playlist) return;
    flow++;
    stopClip();
    playlist = null;
    changed({ music: "stop" });
  }
  function toggleMusic() {
    if (!playlist) return;
    if (!audio.paused) { audio.pause(); held = false; }
    else if (playlist.src) play(playlist.src, flow);
  }
  // What's playing: { title, artist, year, genre, at, count, src, paused }, or null.
  function music() {
    const p = playlist;
    if (!p) return null;
    const q = p.list[p.at];
    return { title: fact(q, "song") || q.answer, artist: fact(q, "artist"), year: fact(q, "year"), genre: fact(q, "genre"),
      at: p.at, count: p.list.length, src: p.src, paused: audio.paused, set: p.set.id };
  }
  // The song's mood from Claude, unspoken: the voice widget's colors, and the Earth map as its background when it suits
  // the song (show_earth), else closed (hide_earth) so the colors show. Kept for each song, so going back asks nothing.
  const moods = new Map();
  async function moodFor(q, my) {
    const v = vc();
    if (typeof v?.consult !== "function") return;
    const tools = ["show_earth", "hide_earth"];
    const facts = q.facts.map(([k, val]) => `${k}: ${val}`).join("; ");
    if (!moods.has(q.clip)) {
      moods.set(q.clip, v.consult(`(From the page, not spoken: it's playing a clip of a song. ${facts}.) Set the scene for this song from its mood and theme: `
        + `choose the mood header's mood, energy, palette and pattern to fit it. When the song is about weather, the sky, water, a river, `
        + `the sea, a season or a place, also show the Earth map as its background with the show_earth action, choosing an animation, `
        + `overlay and center that fit it. Otherwise write the hide_earth action, so the mood's colors show. Then say only the song's title.`, tools)
        .then((r) => (r?.mood ? r : (moods.delete(q.clip), null))));
    }
    const r = await moods.get(q.clip);
    if (!r || my !== flow) return;
    v.setMood(r.mood);
    const pageTools = Array.isArray(window.pageTools) ? window.pageTools : [];
    for (const call of r.actions) {
      const tool = pageTools.find((t) => t.name === call.name && tools.includes(t.name));
      try { await tool?.execute(call.input || {}); } catch (e) { console.warn("[trivia] mood action", call.name, e); }
    }
  }

  // ---- The card
  function changed(detail = {}) {
    render();
    document.dispatchEvent(new CustomEvent("trivia:change", { detail: { ...detail, quiz } }));
  }
  // The card for a set (or the first set), kept up to date in parent.
  function card(parent, id) {
    const c = el("div", { class: "trivia-card", "data-set": id || "" });
    cards.add(c);
    parent.append(c);
    render();
    return c;
  }
  function render() {
    for (const c of cards) {
      if (!c.isConnected) { cards.delete(c); continue; }
      c.replaceChildren(...cardParts(sets.get(c.dataset.set) || sets.values().next().value).filter(Boolean));
    }
  }
  function cardParts(set) {
    if (!set) return [];
    const problemLine = problem && el("p", { class: "trivia-problem", text: problem });
    if (!quiz || quiz.set !== set || !quiz.q) {
      const rows = set.loaded;
      if (!rows) rowsOf(set).then(render, (e) => { problem = e.message; render(); });
      const groups = rows ? groupsOf(set, rows) : [];
      return [
        el("div", { class: "trivia-head" }, el("strong", { text: `${set.title} Trivia` })),
        el("p", { class: "trivia-q", text: rows ? `${rows.length} questions${groups.length ? ` about ${groups.length} ${set.groupPlural || "places"}` : ""}. Say "Ask me ${set.about || set.title} trivia", or:` : problem ? "" : "Loading the questions…" }),
        problemLine,
        rows && el("div", { class: "trivia-actions" },
          el("button", { type: "button", class: "trivia-btn trivia-primary", onclick: () => run(question({ set: set.id })) }, "Start"),
          playlist?.set === set
            ? el("button", { type: "button", class: "trivia-btn", onclick: () => stopMusic() }, "Stop Music")
            : el("button", { type: "button", class: "trivia-btn", onclick: () => run(playMusic({ set: set.id })) }, "Play Music")),
      ];
    }
    const q = quiz.q, shown = q.picked || quiz.over;
    const choices = el("ol", { class: "trivia-choices" }, ...q.choices.map((ch) => el("li", {},
      el("button", { type: "button", class: "trivia-choice", disabled: !!shown,
        "data-mark": shown ? (ch === q.answer ? "right" : ch === q.picked ? "wrong" : "") : "",
        onclick: () => pick(ch) }, ch))));
    const reveal = set.reveal ? q.facts.filter(([k]) => set.reveal.includes(k)) : q.facts;
    const playing = !audio.paused && clip === found.get(q.clip);
    const src = found.get(q.clip);
    return [
      el("div", { class: "trivia-head" },
        el("strong", { text: `${set.title}${quiz.group ? ` · ${quiz.group}` : ""}` }),
        el("span", { text: `Question ${quiz.at + 1} of ${quiz.list.length} · ${quiz.right} of ${quiz.done} right` })),
      el("p", { class: "trivia-q", text: q.text }),
      choices,
      q.picked && el("p", { class: "trivia-result", "data-mark": q.picked === q.answer ? "right" : "wrong",
        text: q.picked === q.answer ? "Right!" : `The answer is ${q.answer}.` }),
      q.picked && reveal.length && el("dl", { class: "trivia-facts" }, ...reveal.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])),
      src && el("div", { class: "trivia-clip" },
        el("button", { type: "button", class: "trivia-btn", onclick: () => toggleClip(),
          title: playing ? "Pause the clip" : "Play the clip" }, playing ? "❚❚ Pause clip" : blocked ? "▶ Play clip" : "▶ Clip"),
        held && el("span", { class: "trivia-muted", text: "Paused with Claude" }),
        src.kind === "apple"
          ? el("a", { class: "trivia-badge", href: src.link, target: "_blank", rel: "noopener", title: "Preview courtesy of Apple Music" },
            el("small", { text: "Listen on" }), "Apple Music")
          : src.link && el("a", { class: "trivia-source", href: src.link, target: "_blank", rel: "noopener", text: `Public domain recording · ${src.label}` })),
      el("div", { class: "trivia-actions" },
        quiz.over ? el("span", { class: "trivia-muted", text: `Done: ${quiz.right} of ${quiz.done} right.` }) : null,
        el("button", { type: "button", class: "trivia-btn trivia-primary", onclick: () => run(question({ set: set.id })) }, quiz.over ? "Start over" : "Next question"),
        !quiz.over && el("button", { type: "button", class: "trivia-btn", onclick: () => end() }, "End")),
      problemLine,
    ];
  }
  // A card button's step, with what went wrong shown on the card.
  function run(p) {
    problem = "";
    p.catch((e) => { console.warn("[trivia]", e); problem = e.message; render(); });
  }
  // A tapped choice: said to Claude during a conversation, so it replies as to a spoken guess; else answered here.
  function pick(choice) {
    if (talking() && typeof vc()?.say === "function") vc().say(choice);
    else answer(choice);
  }
  function toggleClip() {
    if (!audio.paused) { audio.pause(); held = false; return render(); }
    clipOf(quiz?.q).then((src) => src && play(src, flow, 0, clip !== src));
  }

  // ---- Page actions, as MCP tools that Claude runs from an action tag in its reply. Registering again replaces them.
  function registerTools() {
    if (!sets.size) return;
    const register = typeof window.registerPageTool === "function" ? window.registerPageTool
      : (t) => { window.pageTools = (Array.isArray(window.pageTools) ? window.pageTools : []).filter((x) => x.name !== t.name).concat(t); };
    const list = [...sets.values()];
    const named = list.map((s) => `${s.id} (${s.title}${s.group ? `, by ${s.group.toLowerCase()}` : ""})`).join(", ");
    register({
      name: "trivia_question",
      description: `Shows the next multiple-choice trivia question and has it asked aloud after your reply, with a clip playing. Use for "Ask me music trivia", "Quiz me about Macon", "Next question" or "Another one". Just say briefly that a question is coming; don't ask it yourself, since you'll be sent its answer with it. Sets: ${named}.`,
      inputSchema: { type: "object", properties: {
        set: { type: "string", enum: list.map((s) => s.id), description: "The set. Leave it out for the one under way, else the first." },
        group: { type: "string", description: "Only questions about this, such as a city, for \"Ask me about Athens\". Leave it out for all." },
      }, additionalProperties: false },
      execute: (input = {}) => question(input),
    });
    register({
      name: "trivia_answer",
      description: "Records the person's guess at the trivia question just asked, shows whether it's right and plays its clip again. Write it in your reply to their guess.",
      inputSchema: { type: "object", properties: { answer: { type: "string", description: "The choice they picked, exactly as listed, or what they said when it matched none." } }, required: ["answer"], additionalProperties: false },
      execute: ({ answer: a } = {}) => answer(a),
    });
    register({
      name: "trivia_end",
      description: "Ends the trivia and stops its clip, as for \"Stop the quiz\" or \"No more questions\".",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => end(),
    });
  }

  const api = { add, card, question, answer, end, registerTools, get quiz() { return quiz; }, sets,
    playMusic, stopMusic, toggleMusic, step, get music() { return music(); },
    /** A row's clip, looked up: { src, kind, link, label }, or null. */
    clip: (row, id) => clipOf(questionOf(sets.get(id) || sets.values().next().value, row)) };
  window.Trivia = api;
})();
