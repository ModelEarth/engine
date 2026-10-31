/*!
 * claude-voice.js — talk to Claude by voice from any static page.
 *
 *   <div id="stage"> ...your content... </div>
 *   <script src="/engine/claude-voice.js" data-target="#stage" defer></script>
 *
 * Say "Ok Claude" (optionally followed by your question) to start. Claude keeps answering
 * until you say "Thanks". The target div's background becomes a living canvas whose colours
 * and patterns follow the mood and topic of the conversation.
 *
 * Script attributes (all optional):
 *   data-target        CSS selector of the div to animate (default: the script's parent div, else <body>)
 *   data-endpoint      API URL (default: local bridge on localhost, /api/claude-voice elsewhere)
 *   data-bridge-port   port of server/local-bridge.mjs (default 8790)
 *   data-lang          speech language (default: page lang or en-US)
 *   data-voice         part of a preferred TTS voice name, e.g. "Samantha" or "Google UK English Female"
 *   data-voice-mode    "chosen", "random" (new voice each conversation) or "response" (new voice each reply, suited
 *                      to it). Default: "chosen" when data-voice is set, else "response". The ⚙ panel overrides both
 *                      and remembers the choice in this browser.
 *   data-ui            "full" (status pill + captions), "minimal" (pill only) or "none"
 *   data-ui-place      "corner" (the target's lower right, default) or "side" (fixed at the window's right side, below
 *                      the middle, clear of controls in the target's lower right, such as the Earth map's)
 *   data-ui-bottom     px between the controls and the bottom edge (default 16)
 *                      The controls (.claude-voice-ui) carry a data-open attribute while anything shows above their row
 *                      (captions, the typing box, settings or the opened play pill), so the page can make room for it.
 *   data-idle-timeout  seconds of silence before a conversation ends on its own (default 120)
 *   data-play-button   CSS selector of a page button (such as the Earth map's play button) to move to the right end of the
 *                      controls. Hovering over it shows Audio and Motion toggles above it, in one pill with it. While
 *                      Claude replies, a click on it pauses or resumes Claude's voice and motion; otherwise it does its own job.
 *   data-words         "false" to skip the keywords that float over the target while Claude speaks
 *   data-words-replace CSS selector of content to fade out while keywords show (default: the target's own content,
 *                      except elements marked data-words-stay, such as a scene picture behind the words)
 *   data-words-unless  CSS selector of displays that keep the floating words away: while one is visible as a reply starts,
 *                      that reply shows no words and leaves the page's content as it is (localsite: the Earth map)
 *   data-text-output   the ⚙ panel's Text Output choices that start on, separated by spaces or commas: conversation
 *                      (captions of what you and Claude say), important (the key fact of each reply, in a line of its own),
 *                      words (the keywords floating over the target) and sets (Claude marks word groups, such as
 *                      "interest rates", so they float as one). Default: "conversation words sets". The panel overrides
 *                      this and remembers the choices in this browser.
 *   data-autostart    "false" to wait for a click even when the mic is already allowed
 *   data-mic-level     "false" to skip the mic-level glow (if your device can't share the mic)
 *
 * No keys live in this file. It talks only to your own endpoint (local bridge or Cloudflare Worker).
 * When the Worker asks for the site's passphrase (TEAM_PASSPHRASE), a field for it shows. The passphrase is kept in
 * this browser's localStorage and sent with each request, so it's entered once for every tab on the site.
 * When the site's keys can't answer (or no passphrase was entered), a Claude or Gemini key saved on the /keys page in this
 * browser is used instead; without one, the note says it can be added there.
 * API: window.ClaudeVoice.{start, stop, say, end, interrupt, setMood, clearWords, pauseAudio, pauseMotion, on}
 */
(function () {
  'use strict';
  if (window.ClaudeVoice) return;

  // ------------------------------------------------------------------ config
  const script = document.currentScript || document.querySelector('script[src*="claude-voice"]');
  const ds = (script && script.dataset) || {};
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.hostname.endsWith('.localhost');
  const bridgePort = String(ds.bridgePort || 8790);
  const cfg = {
    endpoint: ds.endpoint || (isLocal && location.port !== bridgePort
      ? `http://127.0.0.1:${bridgePort}/api/claude-voice`
      : '/api/claude-voice'),
    lang: ds.lang || document.documentElement.lang || 'en-US',
    voice: ds.voice || '',
    voiceMode: ds.voiceMode || '',
    ui: ds.ui || 'full',
    idleTimeout: Number(ds.idleTimeout || 120) * 1000,
    autostart: ds.autostart !== 'false',
    micLevel: ds.micLevel !== 'false',
    maxHistory: 24,
  };

  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const now = () => performance.now();

  // ------------------------------------------------------------------ colour (OKLab tweening keeps fades smooth)
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  function hexToLab(hex) {
    let h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const r = toLin(parseInt(h.slice(0, 2), 16) / 255), g = toLin(parseInt(h.slice(2, 4), 16) / 255), b = toLin(parseInt(h.slice(4, 6), 16) / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const lab = [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
    // Gentle limits: no neon, no blinding white.
    const C = Math.hypot(lab[1], lab[2]);
    if (C > 0.2) { lab[1] *= 0.2 / C; lab[2] *= 0.2 / C; }
    lab[0] = clamp(lab[0], 0.08, 0.93);
    return lab;
  }
  function labToRgb([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
      .map((c) => Math.round(clamp(toSrgb(clamp(c, 0, 1)), 0, 1) * 255));
  }

  const MOODS = {
    idle:       { palette: ['#0e1424', '#25304f', '#7d8fb8'], pattern: 'orbs',   energy: 0.12 },
    listening:  { palette: ['#13203a', '#2f4f7f', '#9cc2e8'], pattern: 'orbs',   energy: 0.25 },
    calm:       { palette: ['#10283a', '#2f6a7e', '#a6d8d4'], pattern: 'waves',  energy: 0.2 },
    curious:    { palette: ['#1d1638', '#4b3f8f', '#b7a8f0'], pattern: 'spiral', energy: 0.4 },
    joyful:     { palette: ['#3a1d2c', '#c0574f', '#ffd28a'], pattern: 'petals', energy: 0.6 },
    playful:    { palette: ['#2a1640', '#a3478f', '#ffc7e4'], pattern: 'sparks', energy: 0.65 },
    focused:    { palette: ['#0f1a24', '#28506a', '#8fc1d9'], pattern: 'grid',   energy: 0.35 },
    excited:    { palette: ['#2b0f1c', '#d1453b', '#ffcc66'], pattern: 'sparks', energy: 0.9 },
    tense:      { palette: ['#1a0f12', '#6b2430', '#d98a6e'], pattern: 'rain',   energy: 0.6 },
    melancholy: { palette: ['#121722', '#3a4b63', '#9aa9bd'], pattern: 'rain',   energy: 0.2 },
    awe:        { palette: ['#070b1f', '#2a2f7a', '#c7c9ff'], pattern: 'stars',  energy: 0.3 },
    warm:       { palette: ['#2a1810', '#a2553a', '#f4c48f'], pattern: 'orbs',   energy: 0.3 },
  };
  const PATTERN_NAMES = ['orbs', 'waves', 'stars', 'rain', 'sparks', 'spiral', 'grid', 'petals'];

  // ------------------------------------------------------------------ scene
  function Scene(host) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className = 'claude-voice-canvas';
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: '-1', pointerEvents: 'none', borderRadius: 'inherit', display: 'block' });
    const cs = getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';
    host.style.isolation = 'isolate';
    if (host === document.body) Object.assign(canvas.style, { position: 'fixed' });
    host.prepend(canvas);
    const ctx = canvas.getContext('2d');

    const S = {
      w: 1, h: 1, t: 0, dpr: 1,
      cur: MOODS.idle.palette.map(hexToLab), tgt: MOODS.idle.palette.map(hexToLab), rgb: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      energy: 0.1, energyTgt: MOODS.idle.energy,
      activity: 'idle', dim: 0.35, dimTgt: 0.35,
      pulse: 0, level: 0, levelFn: null,
      layers: [], pattern: null,
    };

    function resize() {
      const r = host === document.body ? { width: innerWidth, height: innerHeight } : host.getBoundingClientRect();
      S.dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === S.w && h === S.h) return;
      S.w = w; S.h = h;
      canvas.width = Math.round(w * S.dpr); canvas.height = Math.round(h * S.dpr);
      S.layers.forEach((L) => L.init());
    }
    new ResizeObserver(resize).observe(host === document.body ? document.documentElement : host);
    resize();

    const col = (i, a) => `rgba(${S.rgb[i][0]},${S.rgb[i][1]},${S.rgb[i][2]},${a})`;
    const area = () => (S.w * S.h) / (1280 * 720);

    // --- pattern layers -------------------------------------------------
    const factories = {
      orbs() {
        let p = [];
        return {
          init() { p = Array.from({ length: Math.round(clamp(16 * area(), 8, 34)) }, () => ({ x: rand(0, S.w), y: rand(0, S.h), r: rand(24, 130), vx: rand(-8, 8), vy: rand(-14, -3), ph: rand(0, 6.28) })); },
          draw(a, tempo, dt) {
            ctx.globalCompositeOperation = 'lighter';
            for (const o of p) {
              o.x += o.vx * tempo * dt; o.y += o.vy * tempo * dt;
              if (o.y < -o.r) { o.y = S.h + o.r; o.x = rand(0, S.w); }
              if (o.x < -o.r) o.x = S.w + o.r; else if (o.x > S.w + o.r) o.x = -o.r;
              const tw = 0.6 + 0.4 * Math.sin(S.t * 0.8 * tempo + o.ph);
              const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
              g.addColorStop(0, col(2, 0.22 * tw * a)); g.addColorStop(0.5, col(1, 0.08 * tw * a)); g.addColorStop(1, col(1, 0));
              ctx.fillStyle = g; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 6.283); ctx.fill();
            }
            ctx.globalCompositeOperation = 'source-over';
          },
        };
      },
      waves() {
        let ph = 0;
        return {
          init() {},
          draw(a, tempo, dt) {
            ph += dt * tempo;
            const n = 7, amp = S.h * (0.035 + S.energy * 0.05);
            for (let i = 0; i < n; i++) {
              const base = S.h * (0.25 + i * 0.09), f1 = 0.004 + i * 0.0007, f2 = 0.011 - i * 0.0006;
              ctx.beginPath();
              for (let x = -10; x <= S.w + 10; x += 14) {
                const y = base + Math.sin(x * f1 + ph * (0.6 + i * 0.12) + i) * amp + Math.sin(x * f2 - ph * 0.9) * amp * 0.4 + S.pulse * Math.sin(x * 0.03 + ph * 4) * 6;
                x < 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
              }
              ctx.strokeStyle = col(i % 2 ? 2 : 1, (0.12 + 0.18 * (i / n)) * a * (1.4 - S.dim));
              ctx.lineWidth = 1.2 + (i % 3);
              ctx.stroke();
            }
          },
        };
      },
      stars() {
        let p = [], shoot = [];
        return {
          init() { p = Array.from({ length: Math.round(clamp(140 * area(), 50, 260)) }, () => ({ x: rand(0, S.w), y: rand(0, S.h), r: rand(0.4, 1.8), ph: rand(0, 6.28), sp: rand(0.5, 2.2) })); shoot = []; },
          draw(a, tempo, dt) {
            for (const s of p) {
              s.x -= 3 * tempo * dt; if (s.x < 0) s.x += S.w;
              const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(S.t * s.sp * tempo + s.ph));
              ctx.fillStyle = col(2, tw * a * 0.9);
              ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
            }
            if (Math.random() < dt * (0.04 + S.energy * 0.9) * a) shoot.push({ x: rand(S.w * 0.2, S.w * 1.1), y: rand(-20, S.h * 0.4), life: 1 });
            ctx.lineCap = 'round';
            shoot = shoot.filter((s) => {
              s.x -= 520 * dt * (0.6 + tempo * 0.4); s.y += 260 * dt * (0.6 + tempo * 0.4); s.life -= dt * 1.2;
              const g = ctx.createLinearGradient(s.x, s.y, s.x + 90, s.y - 45);
              g.addColorStop(0, col(2, s.life * a)); g.addColorStop(1, col(2, 0));
              ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + 90, s.y - 45); ctx.stroke();
              return s.life > 0;
            });
          },
        };
      },
      rain() {
        let p = [];
        const drop = (top) => ({ x: rand(-50, S.w + 50), y: top ? rand(-S.h, 0) : rand(0, S.h), len: rand(10, 28), v: rand(380, 640), w: rand(0.6, 1.5) });
        return {
          init() { p = Array.from({ length: Math.round(clamp(150 * area(), 60, 300)) }, () => drop(false)); },
          draw(a, tempo, dt) {
            const slant = 0.18 + S.energy * 0.25, active = Math.round(p.length * (0.45 + S.energy * 0.55));
            ctx.lineCap = 'round';
            for (let i = 0; i < active; i++) {
              const d = p[i];
              d.y += d.v * dt * (0.45 + tempo * 0.45); d.x += d.v * slant * dt * 0.4;
              if (d.y > S.h + 30) Object.assign(d, drop(true), { y: rand(-60, -10) });
              ctx.strokeStyle = col(2, 0.28 * a); ctx.lineWidth = d.w;
              ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * slant, d.y - d.len); ctx.stroke();
            }
          },
        };
      },
      sparks() {
        let p = [], acc = 0;
        return {
          init() { p = []; },
          draw(a, tempo, dt) {
            acc += dt * (0.5 + S.energy * 7 + S.pulse * 4) * a;
            while (acc > 1 && p.length < 900) {
              acc -= 1;
              const cx = rand(S.w * 0.08, S.w * 0.92), cy = rand(S.h * 0.15, S.h * 0.85), n = Math.round(rand(12, 26 + S.energy * 20));
              for (let i = 0; i < n; i++) {
                const ang = rand(0, 6.283), sp = rand(40, 220) * (0.6 + S.energy);
                p.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: rand(0.7, 1.8), max: 0, c: Math.random() < 0.6 ? 2 : 1, r: rand(0.8, 2.4) });
              }
            }
            if (Math.random() < dt * 14 * a) p.push({ x: rand(0, S.w), y: S.h + 5, vx: rand(-10, 10), vy: rand(-90, -40), life: rand(2, 4), max: 0, c: 2, r: rand(0.8, 1.8) });
            ctx.globalCompositeOperation = 'lighter';
            const k = Math.min(1, dt * 1.6);
            p = p.filter((s) => {
              if (!s.max) s.max = s.life;
              s.vx -= s.vx * k; s.vy -= s.vy * k; s.vy += 40 * dt;
              s.x += s.vx * dt * (0.7 + tempo * 0.3); s.y += s.vy * dt * (0.7 + tempo * 0.3); s.life -= dt;
              const f = clamp(s.life / s.max, 0, 1);
              ctx.fillStyle = col(s.c, f * 0.85 * a);
              ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (0.6 + f), 0, 6.283); ctx.fill();
              return s.life > 0;
            });
            ctx.globalCompositeOperation = 'source-over';
          },
        };
      },
      spiral() {
        let rot = 0;
        return {
          init() {},
          draw(a, tempo, dt) {
            rot += dt * 0.18 * tempo;
            const cx = S.w / 2, cy = S.h / 2, arms = 5, R = Math.hypot(S.w, S.h) * 0.55, N = 70;
            for (let arm = 0; arm < arms; arm++) {
              for (let i = 1; i < N; i++) {
                const f = i / N, ang = rot + arm * (6.283 / arms) + f * 5.2 + Math.sin(S.t * 0.4 + f * 6) * 0.08;
                const r = f * R, x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
                ctx.fillStyle = col(f < 0.5 ? 2 : 1, (1 - f) * 0.5 * a);
                ctx.beginPath(); ctx.arc(x, y, 0.8 + f * 3.2 + S.pulse * 2, 0, 6.283); ctx.fill();
              }
            }
          },
        };
      },
      grid() {
        let cx = 0, cy = 0, tx = 0, ty = 0, ph = 0;
        return {
          init() { cx = tx = S.w / 2; cy = ty = S.h / 2; },
          draw(a, tempo, dt) {
            ph += dt * (1 + tempo * 1.4);
            if (Math.random() < dt * 0.25) { tx = rand(0, S.w); ty = rand(0, S.h); }
            cx += (tx - cx) * dt * 0.4; cy += (ty - cy) * dt * 0.4;
            const step = 34;
            for (let y = step / 2; y < S.h; y += step) {
              for (let x = step / 2; x < S.w; x += step) {
                const d = Math.hypot(x - cx, y - cy);
                const v = 0.08 + 0.55 * Math.max(0, Math.sin(d * 0.018 - ph)) ** 3 + S.pulse * 0.25;
                ctx.fillStyle = col(2, v * a);
                ctx.fillRect(x - 1, y - 1, 2.2, 2.2);
              }
            }
            const sy = ((S.t * 60 * tempo) % (S.h + 200)) - 100;
            const g = ctx.createLinearGradient(0, sy - 60, 0, sy + 2);
            g.addColorStop(0, col(1, 0)); g.addColorStop(1, col(2, 0.12 * a));
            ctx.fillStyle = g; ctx.fillRect(0, sy - 60, S.w, 62);
          },
        };
      },
      petals() {
        let p = [];
        const petal = (top) => ({ x: rand(-20, S.w + 20), y: top ? rand(-80, -10) : rand(0, S.h), s: rand(5, 13), rot: rand(0, 6.28), vr: rand(-1.4, 1.4), v: rand(18, 46), sw: rand(0, 6.28), c: Math.random() < 0.65 ? 2 : 1 });
        return {
          init() { p = Array.from({ length: Math.round(clamp(30 * area(), 14, 60)) }, () => petal(false)); },
          draw(a, tempo, dt) {
            for (const q of p) {
              q.y += q.v * dt * tempo; q.x += Math.sin(S.t * 0.9 + q.sw) * 22 * dt * tempo; q.rot += q.vr * dt * tempo;
              if (q.y > S.h + 20) Object.assign(q, petal(true));
              ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot);
              ctx.fillStyle = col(q.c, 0.45 * a);
              ctx.beginPath(); ctx.ellipse(0, 0, q.s, q.s * 0.48, 0, 0, 6.283); ctx.fill();
              ctx.restore();
            }
          },
        };
      },
    };

    function setPattern(name) {
      if (!factories[name] || S.pattern === name) return;
      S.pattern = name;
      let L = S.layers.find((l) => l.name === name);
      if (!L) { L = Object.assign(factories[name](), { name, alpha: 0 }); L.init(); S.layers.push(L); }
    }

    function setPalette(hexes) {
      const labs = (hexes || []).map(hexToLab).filter(Boolean);
      if (labs.length < 3) return false;
      labs.sort((x, y) => x[0] - y[0]); // dark -> light keeps foreground text readable
      S.tgt = labs.slice(0, 3);
      return true;
    }

    // --- frame loop -----------------------------------------------------
    let last = now(), raf = 0, paused = false;
    function frame() {
      const t1 = now(), dt = Math.min(0.05, (t1 - last) / 1000); last = t1;
      S.t += dt;
      // ease colours (~3.5 s), energy (~2 s), dim (~1.2 s)
      const kc = 1 - Math.exp(-dt / 1.2), ke = 1 - Math.exp(-dt / 0.8), kd = 1 - Math.exp(-dt / 0.5);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S.cur[i][j] += (S.tgt[i][j] - S.cur[i][j]) * kc;
      S.rgb = S.cur.map(labToRgb);
      S.energy += (S.energyTgt - S.energy) * ke;
      S.dim += (S.dimTgt - S.dim) * kd;
      S.pulse *= Math.exp(-dt * 3.2);
      if (S.levelFn) S.level += (S.levelFn() - S.level) * Math.min(1, dt * 10);
      const tempo = (0.3 + S.energy * 2.4) * (reducedMotion ? 0.35 : 1);

      const { w, h } = S;
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';

      // base gradient + drifting aurora blobs
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, col(0, 1)); g.addColorStop(0.55, `rgb(${S.rgb[0].map((c, i) => Math.round(c * 0.7 + S.rgb[1][i] * 0.3)).join(',')})`); g.addColorStop(1, col(0, 1));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      const bt = S.t * 0.05 * (0.6 + tempo * 0.5);
      [[0.3, 0.35, 1, 0.55], [0.72, 0.6, 1, 0.45], [0.5, 0.85, 2, 0.22]].forEach(([fx, fy, c, al], i) => {
        const x = w * (fx + 0.18 * Math.sin(bt * (1 + i * 0.37) + i * 2)), y = h * (fy + 0.15 * Math.cos(bt * (0.8 + i * 0.29) + i));
        const r = Math.max(w, h) * (0.45 + 0.08 * Math.sin(bt * 2 + i));
        const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, col(c, al)); rg.addColorStop(1, col(c, 0));
        ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
      });

      // patterns cross-fade (~2 s)
      const kp = 1 - Math.exp(-dt / 0.9);
      S.layers = S.layers.filter((L) => {
        L.alpha += ((L.name === S.pattern ? 1 : 0) - L.alpha) * kp;
        if (L.alpha > 0.005) L.draw(L.alpha, tempo, dt);
        return L.name === S.pattern || L.alpha > 0.005;
      });

      // activity overlays
      if (S.activity === 'listening' || S.activity === 'thinking' || S.activity === 'speaking') {
        const lvl = S.activity === 'listening' ? S.level : 0;
        const rg = ctx.createRadialGradient(w / 2, h * 1.05, 0, w / 2, h * 1.05, h * (0.55 + lvl * 0.5));
        rg.addColorStop(0, col(2, 0.1 + lvl * 0.35)); rg.addColorStop(1, col(2, 0));
        ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
      }
      if (S.activity === 'thinking') {
        const a = S.t * 1.3, x = w / 2 + Math.cos(a) * w * 0.22, y = h / 2 + Math.sin(a) * h * 0.18;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, Math.min(w, h) * 0.35);
        rg.addColorStop(0, col(2, 0.16)); rg.addColorStop(1, col(2, 0));
        ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
      }
      if (S.pulse > 0.01 && !reducedMotion) {
        const rg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
        rg.addColorStop(0, col(2, S.pulse * 0.18)); rg.addColorStop(1, col(2, 0));
        ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
      }
      // dim when idle, plus soft vignette
      const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
      vg.addColorStop(0, `rgba(0,0,0,${S.dim * 0.5})`); vg.addColorStop(1, `rgba(0,0,0,${0.25 + S.dim * 0.4})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);

      // expose palette as CSS variables for the page's own styling
      host.style.setProperty('--cv-c1', col(0, 1)); host.style.setProperty('--cv-c2', col(1, 1)); host.style.setProperty('--cv-c3', col(2, 1));
      host.style.setProperty('--cv-energy', S.energy.toFixed(3));
      raf = paused ? 0 : requestAnimationFrame(frame);
    }
    setPattern('orbs');
    raf = requestAnimationFrame(frame);

    return {
      applyMood(m) {
        const preset = MOODS[m && m.mood] || null;
        if (!setPalette(m && m.palette) && preset) setPalette(preset.palette);
        const pat = m && PATTERN_NAMES.includes(m.pattern) ? m.pattern : preset && preset.pattern;
        if (pat) setPattern(pat);
        const e = Number(m && m.energy);
        S.energyTgt = Number.isFinite(e) ? clamp(e, 0, 1) : preset ? preset.energy : S.energyTgt;
      },
      setActivity(a) {
        S.activity = a;
        S.dimTgt = a === 'idle' ? 0.35 : a === 'off' ? 0.5 : 0;
      },
      pulse(v) { S.pulse = Math.min(1, S.pulse + v); },
      setLevelSource(fn) { S.levelFn = fn; },
      /** Holds the canvas still (motion paused) or lets it move again, picking up where it stopped. */
      setPaused(p) {
        paused = !!p;
        if (paused) { cancelAnimationFrame(raf); raf = 0; } else if (!raf) { last = now(); raf = requestAnimationFrame(frame); }
      },
      get state() { return { pattern: S.pattern, energy: S.energy, palette: S.rgb }; },
    };
  }

  // ------------------------------------------------------------------ voices
  // chosen = always the picked voice; random = a new top voice each conversation; response = a new voice each reply, suited to it.
  const VOICE_MODES = ['chosen', 'random', 'response'];
  const VOICE_HINTS = {
    chosen: 'Always speaks with the voice you pick.',
    random: 'A new top-rated voice for each conversation.',
    response: 'A different voice for each reply, suited to the question.',
  };
  // Voices that suit each style Claude names in its mood header. Keep the keys in step with VOICE_STYLES in shared/voice-prompt.js.
  const VOICE_STYLES = {
    warm: ['Ava', 'Emma', 'Samantha', 'Jenny', 'Moira', 'Susan', 'Karen', 'Andrew'],
    bright: ['Zoe', 'Aria', 'Allison', 'Tessa', 'Jenny', 'Google US English', 'Emma'],
    calm: ['Evan', 'Serena', 'Ava', 'Nathan', 'Fiona', 'Daniel', 'Guy'],
    authoritative: ['Andrew', 'Brian', 'Guy', 'Daniel', 'Tom', 'Oliver', 'Google UK English Male'],
    playful: ['Zoe', 'Aria', 'Allison', 'Lee', 'Rishi', 'Jamie', 'Google UK English Female'],
    storyteller: ['Serena', 'Oliver', 'Daniel', 'Kate', 'Moira', 'Matilda', 'Brian'],
  };
  // Rough quality order for the voices browsers expose: neural/premium first, novelty voices last.
  const VOICE_TIERS = ['Best', 'Very good', 'Standard', 'Robotic', 'Novelty'];
  const FAVOURITE_VOICES = ['Ava', 'Andrew', 'Emma', 'Brian', 'Jenny', 'Aria', 'Guy', 'Zoe', 'Evan', 'Nathan', 'Allison', 'Samantha', 'Tom', 'Susan',
    'Serena', 'Daniel', 'Kate', 'Oliver', 'Jamie', 'Matilda', 'Karen', 'Lee', 'Moira', 'Fiona', 'Tessa', 'Rishi',
    'Google US English', 'Google UK English Female', 'Google UK English Male'];
  const ROBOTIC_RE = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|fred|kathy|ralph|junior|albert)\b/i;
  const NOVELTY_RE = /^(bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox)\b/i;
  const EN_REGIONS = { US: 'US', GB: 'UK', AU: 'Australia', CA: 'Canada', IE: 'Ireland', IN: 'India', NZ: 'New Zealand', ZA: 'South Africa',
    SG: 'Singapore', HK: 'Hong Kong', PH: 'Philippines', NG: 'Nigeria', KE: 'Kenya', TZ: 'Tanzania', SC: 'Scotland' };

  function shortVoiceName(v) {
    return v.name.replace(/^Microsoft\s+/i, '').replace(/\s+Online\s+\(Natural\)/i, ' (Natural)').replace(/\s+-\s+.*$/, '').replace(/\s*\(English \([^)]*\)\)/i, '').trim();
  }
  function voiceTier(v) {
    const n = shortVoiceName(v);
    if (NOVELTY_RE.test(n)) return 4;
    if (ROBOTIC_RE.test(n)) return 3;
    if (/natural|neural|premium/i.test(v.name)) return 0;
    if (/enhanced/i.test(v.name) || /^google\s/i.test(v.name)) return 1;
    return 2;
  }
  function rankVoices(list) {
    const fav = (v) => { const n = shortVoiceName(v).toLowerCase(); const i = FAVOURITE_VOICES.findIndex((f) => n.startsWith(f.toLowerCase())); return i < 0 ? 99 : i; };
    const region = (v) => (/^en-us/i.test(v.lang) ? 0 : /^en-gb/i.test(v.lang) ? 1 : 2);
    return list.map((v) => ({ v, t: voiceTier(v), f: fav(v), r: region(v) }))
      .sort((a, b) => a.t - b.t || a.f - b.f || a.r - b.r || a.v.name.localeCompare(b.v.name))
      .map((x) => x.v);
  }
  function voiceLabel(v) {
    const r = (v.lang.split(/[-_]/)[1] || '').toUpperCase();
    return `${shortVoiceName(v)} · ${EN_REGIONS[r] || r || 'English'}`;
  }

  // ------------------------------------------------------------------ spoken keywords
  // While Claude speaks, keywords from each sentence float into the target in widely varied sizes and transparencies,
  // some passing through, the rest staying after the reply (and after the conversation ends) beside a small statement
  // of the summary Claude gave (the <summary> tag that ends each reply). Words avoid overlapping; the lighter one gives way.
  const STOP_WORDS = new Set((
    'a about above actually after again against all almost also although always am among an and another any anything are around as at ' +
    'be because been before being below between both but by can cannot could did do does doing done down during each either else enough even ever every ' +
    'few for from further get gets getting give go goes going gone got had has have having he her here hers herself him himself his how however i if in ' +
    'into is it its itself just keep kind least less let like likely lot lots made make makes many may maybe me might more most mostly much must my myself ' +
    'neither never no nor not nothing now of off often oh ok okay on once one ones only onto or other others otherwise our ours ourselves out over own ' +
    'per perhaps put quite rather really right said same say says see seem seems several shall she should since so some something sometimes sort still ' +
    'such sure take than that the their theirs them themselves then there therefore these they thing things think this those though through thus to ' +
    'together too toward towards under until up upon us use used uses using usually very via want was way ways we well were what whatever when where ' +
    'whether which while who whole whom whose why will with within without would yes yet you your yours yourself yourselves ' +
    "i'm i've i'd i'll you're you've you'd you'll we're we've we'd we'll they're they've they'd they'll " +
    "don't doesn't didn't can't couldn't won't wouldn't shouldn't isn't aren't wasn't weren't hasn't haven't hadn't " +
    'honestly basically simply generally literally definitely certainly probably absolutely exactly pretty great good question'
  ).split(/\s+/));

  // Precise word sets: Claude marks word groups that belong together [[like this]] (the "sets" rules in shared/voice-prompt.js).
  // The marks are kept for the word field and taken out of what's spoken and shown as captions.
  const unmark = (s) => s.replace(/\[\[|\]\]/g, '');
  /** The marked word groups of a sentence, each with its position in the sentence once the marks are taken out. */
  function wordSetsOf(marked) {
    const sets = [], re = /\[\[([^\]]+?)\]\]/g;
    let m, removed = 0;
    while ((m = re.exec(marked))) {
      const text = m[1].trim();
      if (text) sets.push({ text, index: m.index - removed, end: m.index - removed + m[1].length });
      removed += 4;
    }
    return sets;
  }

  /** The few words of a sentence most worth showing: marked word groups, then longer words, names and numbers, not ones already shown. */
  function keywordsOf(marked, seen) {
    const found = [];
    const sentence = unmark(marked), sets = wordSetsOf(marked);
    sets.forEach((st) => {
      const lower = st.text.toLowerCase().replace(/’/g, "'");
      if (found.some((f) => f.lower === lower)) return;
      found.push({ word: st.text, lower, index: st.index, score: 1.2 + Math.min(st.text.split(/\s+/).length, 4) * 0.1 - (seen.has(lower) ? 1 : 0) });
    });
    const re = /\d[\d,.:]*%?|[A-Za-z][A-Za-z'’-]*/g;
    let m, first = true;
    while ((m = re.exec(sentence))) {
      const word = m[0].replace(/’/g, "'").replace(/[.,:]+$/, '').replace(/'s$/i, '').replace(/^-+|-+$/g, '');
      const lower = word.toLowerCase(), isFirst = first, isNum = /\d/.test(word);
      first = false;
      if (sets.some((st) => m.index >= st.index && m.index < st.end)) continue; // already shown within its group
      if (!word || STOP_WORDS.has(lower) || (word.length < 3 && !isNum) || found.some((f) => f.lower === lower)) continue;
      let score = Math.min(word.length, 12) / 12;
      if (isNum) score += 0.8;
      else if (/^[A-Z]/.test(word) && !isFirst) score += 0.6; // a capital mid-sentence is usually a name
      if (seen.has(lower)) score -= 1;
      found.push({ word, lower, index: m.index, score });
    }
    const k = clamp(Math.ceil(sentence.split(/\s+/).length / 3), 1, 6);
    return found.sort((a, b) => b.score - a.score).slice(0, k).filter((f) => f.score > 0.2).sort((a, b) => a.index - b.index);
  }

  function parseSummary(s) {
    if (!s) return null;
    s = s.replace(/<\/summary>[\s\S]*$/, '').trim();
    let list;
    try { list = JSON.parse(s); } catch (e) { list = s.replace(/^\[|\]$/g, '').split(','); }
    return Array.isArray(list) ? list.map((w) => String(w).replace(/^["'\s]+|["'\s]+$/g, '')).filter(Boolean).slice(0, 10) : null;
  }

  function WordField(host) {
    if (ds.words === 'false') return { begin() {}, sentence() {}, summary() {}, finish() {}, clear() {}, setPaused() {}, setEnabled() {}, off: true };
    const MAX_LIVE = 28;
    // Size steps as fractions of the target's span, from whisper to headline; each word lands on one at random, nudged up by its score.
    const SIZE_STEPS = [0.02, 0.032, 0.05, 0.078, 0.115, 0.16];
    const PAD = 18; // clear space kept around each word, a little more than its drift
    const TOP = 90; // words and the statement stay this far below the target's top, clear of headers and controls there
    const layer = document.createElement('div');
    layer.className = 'claude-voice-words';
    layer.setAttribute('aria-hidden', 'true'); // the captions already carry the words for screen readers
    Object.assign(layer.style, { position: host === document.body ? 'fixed' : 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '0' });
    host.appendChild(layer);
    const root = layer.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .w, .stmt { position: absolute; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; text-shadow: 0 2px 28px rgba(0,0,0,.45); }
        .w { white-space: nowrap; line-height: 1; letter-spacing: -0.02em; color: color-mix(in srgb, var(--cv-c3, #fff) 45%, #fff); }
        .w span, .stmt span { display: inline-block; white-space: pre; }
        .stmt { line-height: 1.6; font-weight: 400; letter-spacing: .02em; word-spacing: .3em; color: #fff; opacity: .85; }
        .stmt .sep { margin: 0 .6em; opacity: .55; }
        .stmt.amid { text-align: center; }
        .stmt.tr { text-align: right; }
      </style>
      <div class="field"></div>`;
    const field = root.querySelector('.field');
    let live = [], stmt = null, seen = new Set(), summaryList = null, keyWords = new Set(), active = false, timers = [], pageTimer = null, still = false;
    let enabled = true; // Large Words in the settings panel's Text Output

    // The target's own content (e.g. the demo's heading) steps aside while words are showing.
    const pageEls = () => (ds.wordsReplace ? [...document.querySelectorAll(ds.wordsReplace)]
      : host === document.body ? []
      : [...host.children].filter((c) => c !== layer && c.tagName !== 'SCRIPT' && !c.hasAttribute('data-words-stay')
        && !/\bclaude-voice-/.test(c.getAttribute('class') || '')));
    const showPage = (on) => pageEls().forEach((c) => { c.style.transition = 'opacity .6s ease'; c.style.opacity = on ? '' : '0'; });
    const span = () => Math.min(layer.clientWidth, layer.clientHeight * 1.6);
    // While motion is paused, words still come and go, but without moving: entrances and exits jump to their end, and the drift holds.
    const hold = (anims) => { if (still) anims.forEach((a) => (a.effect.getTiming().iterations === Infinity ? a.pause() : a.finish())); };
    // Another display (data-words-unless) is showing in the target, so the words stay away rather than hide it.
    const otherDisplay = () => !!ds.wordsUnless && [...document.querySelectorAll(ds.wordsUnless)]
      .some((d) => d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden');
    // How much a word (or word group) matters: its keyword score, plus a lift once Claude's summary names it.
    const weightOf = (o) => o.score + (o.lower.split(/\s+/).some((w) => keyWords.has(w)) ? 1.5 : 0);

    function makeWord(text) {
      const el = document.createElement('div');
      el.className = 'w';
      [...text].forEach((ch) => { const s = document.createElement('span'); s.textContent = ch; el.appendChild(s); });
      return el;
    }
    // Three entrances, picked at random: pieces rise into place, zoom in from close up, or converge from a scatter.
    function reveal(el, delay = 0, step = 38) {
      if (reducedMotion) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay, fill: 'both' });
      const spans = [...el.children], kind = Math.floor(Math.random() * 3);
      spans.forEach((s, i) => {
        const from = kind === 0 ? { transform: 'translateY(.6em) rotate(8deg)', filter: 'blur(8px)', opacity: 0 }
          : kind === 1 ? { transform: 'scale(2.4)', filter: 'blur(10px)', opacity: 0 }
          : { transform: `translate(${((i - spans.length / 2) * 0.45).toFixed(2)}em, -.4em)`, filter: 'blur(6px)', opacity: 0 };
        s.animate([from, { transform: 'none', filter: 'blur(0px)', opacity: 1 }],
          { duration: 650, delay: delay + i * step, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
      });
    }
    // Fades from whatever transparency the element has now.
    function fadeOut(el, delay = 0) {
      const a = el.animate([{ opacity: 0, filter: 'blur(10px)', transform: 'translateY(-18px) scale(.92)' }],
        { duration: reducedMotion ? 300 : 900, delay, easing: 'ease-in', fill: 'forwards' });
      a.onfinish = () => el.remove();
      hold([a]);
    }
    function drop(o, delay = 0) {
      if (!live.includes(o)) return;
      live = live.filter((x) => x !== o);
      fadeOut(o.el, delay);
    }
    const overlap = (a, b) => a.x - PAD < b.x + b.w && b.x < a.x + a.w + PAD && a.y - PAD < b.y + b.h && b.y < a.y + a.h + PAD;
    // Of the spots offered, keeps the first clear one, otherwise the one covering the fewest and lightest words.
    function findSpot(w, h, spots) {
      let best = null;
      for (const s of spots) {
        const box = { x: Math.max(0, s.x), y: Math.max(TOP, s.y), w, h };
        if (stmt && stmt.box && overlap(box, stmt.box)) continue;
        const under = live.filter((o) => overlap(box, o.box));
        const cost = under.reduce((a, o) => a + 1 + weightOf(o), 0);
        if (!best || cost < best.cost) best = { box, under, cost, kind: s.kind };
        if (!cost) break;
      }
      return best;
    }
    const scatter = (w, h, n) => {
      const W = layer.clientWidth, H = layer.clientHeight;
      return Array.from({ length: n }, () => ({ x: (W - w) * rand(0.03, 0.97), y: TOP + Math.max(0, H - h - TOP) * rand(0, 0.78) }));
    };
    function show(k) {
      if (!active) return;
      const imp = clamp(k.score / 1.8, 0, 1);
      // Mostly minor words pass through: they fade away while the rest are still arriving.
      const o = { ...k, transient: Math.random() < 0.45 - imp * 0.3 };
      let step = clamp(Math.round(imp * 2 + rand(-1.5, 3.6)), 0, SIZE_STEPS.length - 1);
      const jitter = rand(0.88, 1.12), el = makeWord(k.word);
      el.style.visibility = 'hidden';
      field.appendChild(el);
      // Try one size smaller rather than crowd; if there's still no clear spot, the lighter of this word and those in the way gives way.
      let spot;
      for (let shrunk = 0; ; shrunk++) {
        el.style.fontSize = clamp(span() * SIZE_STEPS[step] * jitter, 13, 200) + 'px';
        el.style.fontWeight = step >= 4 ? 750 : step <= 1 ? 450 : 620;
        // A long word group at a large size could be wider than the target: it shrinks to fit.
        const room = layer.clientWidth * 0.9;
        if (el.offsetWidth > room) el.style.fontSize = Math.max(13, parseFloat(el.style.fontSize) * room / el.offsetWidth) + 'px';
        spot = findSpot(el.offsetWidth, el.offsetHeight, scatter(el.offsetWidth, el.offsetHeight, 60));
        if (!spot || !spot.cost || shrunk || !step) break;
        step--;
      }
      if (!spot || spot.under.some((u) => weightOf(u) > weightOf(o))) { el.remove(); return; }
      spot.under.forEach((u) => drop(u));
      Object.assign(el.style, { left: spot.box.x + 'px', top: spot.box.y + 'px', visibility: '' });
      // Transparency varies, from faint to solid; weightier words lean solid.
      el.style.opacity = clamp(rand(0.3, 0.8) + imp * 0.35, 0.3, 1).toFixed(2);
      reveal(el);
      if (!reducedMotion) el.animate([{ translate: '0 0' }, { translate: `${rand(-16, 16).toFixed(1)}px ${rand(-12, 12).toFixed(1)}px` }],
        { duration: rand(5000, 9000), direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
      hold(el.getAnimations({ subtree: true }));
      Object.assign(o, { el, box: spot.box });
      live.push(o);
      seen.add(k.lower);
      if (o.transient) setTimeout(() => drop(o), rand(2200, 4500));
      while (live.length > MAX_LIVE) drop(live.filter((x) => x !== o).reduce((a, b) => (weightOf(b) < weightOf(a) ? b : a)));
    }
    // The summary as small text, usually one line, set among the big words or tucked into a corner (not bottom-right, where the controls are).
    function showStatement(picks) {
      const el = document.createElement('div');
      el.className = 'stmt';
      el.style.fontSize = clamp(span() * 0.015, 12, 17) + 'px';
      picks.forEach((p, i) => {
        if (i) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '·'; el.appendChild(sep); }
        const s = document.createElement('span'); s.textContent = p; el.appendChild(s);
      });
      Object.assign(el.style, { left: '0', top: '0', visibility: 'hidden' });
      field.appendChild(el);
      const W = layer.clientWidth, H = layer.clientHeight;
      if (el.offsetWidth > W * 0.9) el.style.maxWidth = W * 0.6 + 'px'; // a long summary wraps into a narrower block
      else el.style.whiteSpace = 'nowrap';
      const w = el.offsetWidth, h = el.offsetHeight;
      const corners = [{ kind: 'tl', x: W * 0.05, y: TOP }, { kind: 'tr', x: W * 0.95 - w, y: TOP }, { kind: 'bl', x: W * 0.05, y: H * 0.91 - h }]
        .sort(() => Math.random() - 0.5);
      const amid = Array.from({ length: 40 }, () => ({ kind: 'amid', x: (W - w) * rand(0.2, 0.8), y: (H - h) * rand(0.2, 0.7) }));
      // The statement always shows: of the spots, the clearest wins (amid or a corner first, at random) and any words under it make way.
      const spot = findSpot(w, h, Math.random() < 0.4 ? [...amid, ...corners] : [...corners, ...amid]);
      spot.under.forEach((u) => drop(u));
      el.classList.add(spot.kind);
      Object.assign(el.style, { left: spot.box.x + 'px', top: spot.box.y + 'px', visibility: '' });
      reveal(el, 250, 90);
      hold(el.getAnimations({ subtree: true }));
      stmt = { el, box: spot.box };
    }
    function clear() {
      active = false; summaryList = null;
      timers.forEach(clearTimeout); timers = [];
      [...live.map((o) => o.el), ...(stmt ? [stmt.el] : [])].forEach((el, i) => fadeOut(el, i * 40));
      live = []; stmt = null;
      clearTimeout(pageTimer); pageTimer = setTimeout(() => showPage(true), 700);
    }

    return {
      /** A reply is starting: the last reply's words and statement make way, and the page content steps aside. */
      begin() {
        timers.forEach(clearTimeout); timers = [];
        live.forEach((o, i) => fadeOut(o.el, i * 30));
        if (stmt) fadeOut(stmt.el);
        live = []; stmt = null;
        seen = new Set(); summaryList = null; keyWords = new Set(); active = enabled && !otherDisplay();
        if (active) { clearTimeout(pageTimer); showPage(false); }
      },
      /** Show a sentence's keywords as they are spoken: on the engine's word boundaries, or on estimated timing when it sends none.
          The sentence may hold marked word groups ([[like this]]); positions are in the spoken text, without the marks. */
      sentence(marked, u) {
        if (!active) return;
        const ks = keywordsOf(marked, seen), text = unmark(marked);
        if (!ks.length) return;
        const shown = new Set();
        const showOnce = (k) => { if (!shown.has(k)) { shown.add(k); show(k); } };
        const schedule = () => {
          const ms = text.split(/\s+/).length * 360; // rough speaking time
          ks.forEach((k) => timers.push(setTimeout(() => showOnce(k), ms * k.index / Math.max(1, text.length))));
        };
        if (!u) return schedule();
        u.addEventListener('start', schedule);
        u.addEventListener('boundary', (ev) => ks.forEach((k) => { if (ev.charIndex >= k.index) showOnce(k); }));
      },
      summary(list) {
        summaryList = list;
        keyWords = new Set((list || []).join(' ').toLowerCase().replace(/’/g, "'").replace(/'s\b/g, '').split(/[^a-z0-9']+/).filter(Boolean));
      },
      /** The reply has been spoken (or cut short): the big words stay, and the summary joins them as a small statement. */
      finish() {
        if (!active) return;
        active = false;
        timers.forEach(clearTimeout); timers = [];
        const picks = summaryList || [];
        summaryList = null;
        if (picks.length) showStatement(picks);
        else if (!live.length) clear();
      },
      clear,
      /** Large Words off: the words and statement go, and the next replies show none. */
      setEnabled(on) {
        enabled = !!on;
        if (!enabled && (live.length || stmt || active)) clear();
      },
      /** Motion paused: every word holds where it is. Resumed: they carry on. */
      setPaused(p) {
        still = !!p;
        root.getAnimations().forEach((a) => {
          if (still && a.playState === 'running') a.pause();
          else if (!still && a.playState === 'paused') a.play();
        });
      },
    };
  }

  // ------------------------------------------------------------------ UI (shadow DOM so page CSS never collides)
  function UI(host, actions) {
    if (cfg.ui === 'none') return { setState() {}, user() {}, claude() {}, important() {}, note() {}, fade() {}, showInput() {}, askPassphrase() {}, setVoices() {}, setVoiceMode() {}, setVoiceInfo() {}, setTextOutput() {}, setPaused() {}, setAgent() {}, play: null };
    let play = ds.playButton ? document.querySelector(ds.playButton) : null;
    const el = document.createElement('div');
    el.className = 'claude-voice-ui';
    // At the side, the controls go in <body> so they show even where the target is covered or hidden.
    if (ds.uiPlace === 'side') host = document.body;
    Object.assign(el.style, { position: host === document.body ? 'fixed' : 'absolute', right: '16px', bottom: ds.uiPlace === 'side' ? '30vh' : `${Number(ds.uiBottom) || 16}px`, zIndex: '2147483000', maxWidth: 'min(440px, calc(100% - 32px))' });
    const root = el.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
        .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
        .cap { max-width: 100%; padding: 10px 14px; border-radius: 14px; font-size: 15px; line-height: 1.45; color: #f4f6fb;
               background: rgba(10, 12, 20, .42); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
               border: 1px solid rgba(255,255,255,.12); transition: opacity .6s ease; max-height: 30vh; overflow: auto; }
        .cap:empty { display: none; }
        .user { font-style: italic; opacity: .85; font-size: 14px; }
        .important { font-size: 16px; font-weight: 600; }
        .important::before { content: "Important"; display: block; margin-bottom: 3px; font-size: 11px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; opacity: .6; }
        /* Text Output choices that are off. Hidden captions still update, and Claude keeps listening; notes (errors and status) still show. */
        .no-conversation .user, .no-conversation .claude, .no-important .important { display: none; }
        /* While the settings panel is open, it takes the captions' place. */
        .settings-open .cap { display: none; }
        .row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; align-items: center; }
        .panel { display: none; flex-direction: column; gap: 10px; width: min(300px, 100%); padding: 12px 14px; border-radius: 14px; color: #f4f6fb;
                 font-size: 13px; background: rgba(10,12,20,.55); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                 border: 1px solid rgba(255,255,255,.14); }
        .panel.on { display: flex; }
        .panel label { display: flex; flex-direction: column; gap: 5px; }
        .panel [hidden] { display: none; }
        .hint { font-size: 12px; line-height: 1.4; opacity: .75; }
        .text-out, .agent { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.14); }
        .text-out .head, .agent .head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
        /* "Details" shows each choice's description under its one-line label. .btn-sm as in localsite's base.css, which can't reach in here. */
        .panel .btn-sm { display: inline-flex; padding: .2rem .55rem; font-size: .75rem; font-weight: 400; line-height: 1.2; border-radius: 2rem;
                         border: 1px solid rgba(255,255,255,.3); background: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
        .panel .btn-sm:hover { background: rgba(255,255,255,.1); }
        .panel .btn-sm[aria-expanded="true"] { color: #8a93a8; }
        .panel a.btn-sm { color: #f4f6fb; text-decoration: none; }
        /* Agent: what answers, what it's doing now (from the bridge or Worker) and what the last reply used. */
        .agent { gap: 4px; }
        .agent .head { margin-bottom: 2px; }
        .agent .hint:empty { display: none; }
        /* "Details" at the end of the usage line shows how the agent reaches files (or which key it uses) on that line. */
        .panel button.link { display: inline; padding: 0; border: 0; border-radius: 0; background: none; backdrop-filter: none; -webkit-backdrop-filter: none;
                             font-size: inherit; color: #9cc2e8; text-decoration: underline; text-underline-offset: 2px; }
        .panel button.link[aria-expanded="true"] { color: #8a93a8; }
        .panel button.link[hidden] { display: none; }
        .agent-status { opacity: .9; }
        .panel label.check { flex-direction: row; align-items: flex-start; gap: 8px; cursor: pointer; }
        .check input { flex: none; width: 16px; height: 16px; margin: 1px 0 0; accent-color: #9cc2e8; cursor: pointer; }
        .check small { display: none; margin-top: 2px; font-size: 12px; line-height: 1.35; opacity: .7; }
        .text-out.open .check small { display: block; }
        .check:has(input:disabled) { opacity: .45; cursor: default; }
        /* Same height as the row's buttons; the custom arrow sits in the extra right padding. */
        select { appearance: none; -webkit-appearance: none; width: 100%; height: 38px; margin: 0; padding: 0 32px 0 14px; border-radius: 999px;
                 color: #f4f6fb; font-size: 14px; line-height: normal; cursor: pointer; outline: none; text-overflow: ellipsis;
                 background: rgba(10,12,20,.5) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23f4f6fb' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 14px center;
                 backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.16); }
        select:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        option, optgroup { color: #111; background: #fff; }
        button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border-radius: 999px;
                 color: #f4f6fb; font-size: 14px; background: rgba(10,12,20,.5); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                 border: 1px solid rgba(255,255,255,.16); }
        button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; background: #8a93a8; flex: none; }
        [data-s="wake"] .dot { background: #8fb4ff; animation: breathe 3s ease-in-out infinite; }
        [data-s="listening"] .dot { background: #5ee0a0; animation: breathe 1.4s ease-in-out infinite; }
        [data-s="thinking"] .dot { background: #f6c66b; animation: spin 0.9s linear infinite; border-radius: 3px; }
        [data-s="speaking"] .dot { background: #ff9fb4; animation: breathe .6s ease-in-out infinite; }
        [data-s="error"] .dot { background: #ff6b6b; }
        @keyframes breathe { 50% { transform: scale(1.45); opacity: .6; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
        /* One height for the row; icon buttons are circles of that size. */
        .row button { height: 38px; padding: 0 14px; }
        .row .kb { width: 38px; padding: 0; justify-content: center; }
        .kb svg { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
        form { display: none; width: min(440px, 100%); }
        form.on { display: flex; gap: 6px; }
        input[type="text"], input[type="password"] { flex: 1; min-width: 0; padding: 9px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.2);
                background: rgba(10,12,20,.55); color: #fff; font-size: 14px; outline: none; }
        .minimal .cap { display: none; }
        /* The page's play button (data-play-button), or this widget's own when the page has none, at the row's right end, in a pill that grows upward over the
           captions on hover, showing the Audio and Motion toggles above it. A paused toggle turns grey. */
        .ctl { position: relative; width: 38px; height: 38px; flex: none; }
        .ctl-pill { position: absolute; left: 0; bottom: 0; width: 38px; display: flex; flex-direction: column; border-radius: 19px; overflow: hidden;
                    background: rgba(10,12,20,.5); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.16); }
        .more { display: flex; flex-direction: column; max-height: 0; overflow: hidden; transition: max-height .2s ease; }
        .ctl:hover .more, .ctl:focus-within .more { max-height: 72px; }
        .row .ctl-pill .kb { width: 36px; height: 36px; flex: none; border: 0; border-radius: 50%; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
        .ctl-pill .kb:hover, ::slotted([slot="play"]:hover) { background: rgba(255,255,255,.12); }
        .ctl-pill .kb:focus-visible { outline-offset: -2px; }
        .ctl-pill .kb[aria-pressed="true"] { color: #7d8597; }
        .ctl-pill .playPauseButton[aria-pressed="true"] { color: #f4f6fb; }
        ::slotted([slot="play"]) { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%;
                                   color: #f4f6fb; cursor: pointer; outline: none; }
        ::slotted([slot="play"]:focus-visible) { outline: 2px solid #fff; outline-offset: -2px; }
      </style>
      <div class="wrap ${cfg.ui === 'minimal' ? 'minimal' : ''}" data-s="off">
        <div class="cap important" aria-live="polite"></div>
        <div class="cap user" aria-live="polite"></div>
        <div class="cap claude" aria-live="polite"></div>
        <div class="cap notice" role="status"></div>
        <form><input type="text" placeholder="Type to Claude…" aria-label="Message Claude"><button type="submit">Send</button></form>
        <form class="pass"><input type="password" placeholder="Site passphrase" aria-label="Site passphrase" autocomplete="current-password"><button type="submit">Unlock</button></form>
        <div class="panel" id="cv-settings" role="group" aria-label="Voice settings">
          <label>Voice
            <select class="vmode">
              <option value="chosen">Chosen voice</option>
              <option value="random">Random voice</option>
              <option value="response">Change for response</option>
            </select>
          </label>
          <label class="pick">Chosen voice<select class="voice"></select></label>
          <div class="hint"></div>
          <div class="text-out" role="group" aria-labelledby="cv-text-out">
            <div class="head"><span id="cv-text-out">Text Output</span><button class="details btn-sm" type="button" aria-expanded="false">Details</button></div>
            <label class="check"><input type="checkbox" name="conversation"><span>Conversation Text<small>Captions of what you and Claude say. Claude still listens while they're hidden.</small></span></label>
            <label class="check"><input type="checkbox" name="important"><span>Important Text<small>The key fact of each reply, in fewer words than the conversation.</small></span></label>
            <label class="check"><input type="checkbox" name="words"><span>Large Words<small>Keywords float over the page, large and small, as Claude speaks.</small></span></label>
            <label class="check"><input type="checkbox" name="sets"><span>Precise Word Sets<small>Claude marks words that belong together, such as "interest rates", so they show as one.</small></span></label>
          </div>
          <div class="agent" role="group" aria-labelledby="cv-agent">
            <div class="head"><span id="cv-agent">Agent</span><a class="btn-sm" href="/keys/" target="agents">Keys</a></div>
            <div class="agent-name"></div>
            <div class="agent-status hint" aria-live="polite"></div>
            <div class="hint"><span class="agent-usage"></span> <button class="link agent-more" type="button" aria-expanded="false">Details</button><span class="agent-via" hidden></span></div>
          </div>
        </div>
        <div class="row">
          <button class="kb gear" type="button" title="Voice settings" aria-label="Voice settings" aria-expanded="false" aria-controls="cv-settings">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button class="kb type" type="button" title="Type to Claude" aria-label="Type to Claude">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12.5h.01M10 12.5h.01M14 12.5h.01M18 12.5h.01M7 16h10"/></svg>
          </button>
          <button class="pill" type="button"><span class="dot"></span><span class="label">Enable voice</span></button>
          <div class="ctl"><div class="ctl-pill">
            <div class="more">
              <button class="kb audio" type="button" title="Pause Claude's voice" aria-label="Pause Claude's voice" aria-pressed="false">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>
              </button>
              <button class="kb motion" type="button" title="Pause Claude's motion" aria-label="Pause Claude's motion" aria-pressed="false">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="15.5" cy="12" r="5.5"/><path d="M2 8.5h5M3.5 12H7M2 15.5h5"/></svg>
              </button>
            </div>
            <slot name="play"><button class="kb playPauseButton" type="button" title="Pause Claude" aria-label="Pause Claude" aria-pressed="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>
            </button></slot>
          </div></div>
        </div>
      </div>`;
    host.appendChild(el);
    // The page's play button stays in the page's DOM, so its own scripts still find and run it. Until it's slotted
    // (some pages add it only once their map loads, others never do), the widget's own .playPauseButton fills the slot,
    // so the Audio and Motion buttons above it can always be reached.
    const adopt = (b) => { play = b; b.slot = 'play'; el.appendChild(b); actions.playAdopted(); };
    if (play) { play.slot = 'play'; el.appendChild(play); }
    else if (ds.playButton) {
      const watch = new MutationObserver(() => { const b = document.querySelector(ds.playButton); if (b && !el.contains(b)) { watch.disconnect(); adopt(b); } });
      watch.observe(document.documentElement, { childList: true, subtree: true });
    }
    const $ = (s) => root.querySelector(s);
    const wrap = $('.wrap'), label = $('.label'), userCap = $('.user'), claudeCap = $('.claude'), importantCap = $('.important'), noticeCap = $('.notice'), form = $('form'), input = $('form input');
    $('.pill').addEventListener('click', actions.pill);
    $('.type').addEventListener('click', () => { form.classList.toggle('on'); if (form.classList.contains('on')) input.focus(); });
    const panel = $('.panel'), gear = $('.gear'), modeSel = $('.vmode'), pick = $('.pick'), voiceSel = $('.voice'), hint = $('.hint');
    const showPanel = (on) => {
      panel.classList.toggle('on', on); wrap.classList.toggle('settings-open', on); gear.setAttribute('aria-expanded', String(on));
      if (on) actions.panelOpened();
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); showPanel(false); const v = input.value.trim(); if (v) { input.value = ''; actions.typed(v); } });
    const passForm = $('.pass'), passInput = $('.pass input');
    passForm.addEventListener('submit', (e) => { e.preventDefault(); const v = passInput.value.trim(); if (v) { passInput.value = ''; passForm.classList.remove('on'); actions.passphrase(v); } });
    // A click anywhere off the panel (and off its ⚙ button, which toggles it) closes it, Send included.
    // Captured on window, so the page's own handlers can't stop it. On click rather than pointerdown: the typing box sits
    // above the panel, so closing the panel on press would move Send out from under the pointer before the click lands.
    window.addEventListener('click', (e) => {
      if (!panel.classList.contains('on')) return;
      const path = e.composedPath();
      if (!path.includes(panel) && !path.includes(gear)) showPanel(false);
    }, true);
    gear.addEventListener('click', () => { showPanel(!panel.classList.contains('on')); if (panel.classList.contains('on')) modeSel.focus(); });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !panel.classList.contains('on')) return;
      e.stopPropagation(); showPanel(false); gear.focus(); // don't also interrupt Claude
    });
    modeSel.addEventListener('change', () => { pick.hidden = modeSel.value !== 'chosen'; actions.voiceMode(modeSel.value); });
    voiceSel.addEventListener('change', () => actions.voice(voiceSel.value));
    const textOutBox = $('.text-out'), detailsBtn = $('.text-out .details');
    detailsBtn.addEventListener('click', () => detailsBtn.setAttribute('aria-expanded', String(textOutBox.classList.toggle('open'))));
    const checks = [...root.querySelectorAll('.text-out input')];
    checks.forEach((c) => c.addEventListener('change', () => actions.textOutput(c.name, c.checked)));
    const audioBtn = $('.audio'), motionBtn = $('.motion'), ownPlay = $('.playPauseButton');
    audioBtn.addEventListener('click', actions.audio);
    motionBtn.addEventListener('click', actions.motion);
    ownPlay.addEventListener('click', actions.hold);
    const agentName = $('.agent-name'), agentVia = $('.agent-via'), agentStatus = $('.agent-status'), agentUsage = $('.agent-usage'), agentMore = $('.agent-more');
    agentMore.addEventListener('click', () => { agentVia.hidden = !agentVia.hidden; agentMore.setAttribute('aria-expanded', String(!agentVia.hidden)); });
    // data-open on the controls while anything shows above their row, for the page's own CSS (see the header)
    const ctl = $('.ctl');
    let ctlOpen = false;
    const showing = (c) => !!c.textContent && c.style.opacity !== '0' && c.getClientRects().length > 0; // not hidden by a Text Output choice
    const syncOpen = () => el.toggleAttribute('data-open', ctlOpen || panel.classList.contains('on') || form.classList.contains('on') || passForm.classList.contains('on')
      || [userCap, claudeCap, importantCap, noticeCap].some(showing));
    new MutationObserver(syncOpen).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
    {
      let hover = false, focus = false;
      const inside = (n) => !!n && (ctl.contains(n) || (play && play.contains(n))); // The page's play button is slotted, so it's in the page's DOM
      const set = () => { ctlOpen = hover || focus; syncOpen(); };
      ctl.addEventListener('pointerenter', () => { hover = true; set(); });
      ctl.addEventListener('pointerleave', () => { hover = false; set(); });
      ctl.addEventListener('focusin', () => { focus = true; set(); });
      ctl.addEventListener('focusout', (e) => { focus = inside(e.relatedTarget); set(); });
    }
    const toggleLabel = (btn, paused, what) => {
      const t = `${paused ? 'Resume' : 'Pause'} Claude's ${what}`;
      btn.setAttribute('aria-pressed', String(paused)); btn.title = t; btn.setAttribute('aria-label', t);
    };
    let fadeTimer, noteTimer;
    return {
      setState(s, text) { wrap.dataset.s = s; label.textContent = text; },
      user(t) { userCap.textContent = t ? `“${t}”` : ''; },
      claude(t) { claudeCap.textContent = t; claudeCap.style.opacity = 1; clearTimeout(fadeTimer); },
      important(t) { importantCap.textContent = t; },
      /** Status and errors, in a box of their own so a reply streaming into the captions can't overwrite them. */
      note(t, ms = 6000) {
        noticeCap.textContent = t; noticeCap.style.opacity = 1; clearTimeout(noteTimer);
        noteTimer = setTimeout(() => { noticeCap.style.opacity = 0; noteTimer = setTimeout(() => { noticeCap.textContent = ''; }, 600); }, ms);
      },
      fade(ms = 8000) { clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { claudeCap.style.opacity = 0; userCap.textContent = ''; }, ms); },
      showInput() { form.classList.add('on'); },
      askPassphrase() { passForm.classList.add('on'); passInput.focus(); },
      setVoices(list, selected) {
        const groups = [];
        list.forEach((v) => { const t = voiceTier(v); (groups[t] = groups[t] || []).push(v); });
        voiceSel.replaceChildren(new Option('Auto (best available)', ''));
        groups.forEach((vs, t) => {
          const g = document.createElement('optgroup');
          g.label = VOICE_TIERS[t];
          vs.forEach((v) => g.appendChild(new Option(voiceLabel(v), v.voiceURI)));
          voiceSel.appendChild(g);
        });
        voiceSel.value = list.some((v) => v.voiceURI === selected) ? selected : '';
      },
      setVoiceMode(m) { modeSel.value = m; pick.hidden = m !== 'chosen'; },
      setVoiceInfo(m, name) { hint.textContent = VOICE_HINTS[m] + (name && m !== 'chosen' ? ` Now: ${name}.` : ''); },
      /** Text Output: { conversation, important, words, sets } as booleans. noWords: the page turned the floating words off (data-words). */
      setTextOutput(o, noWords) {
        checks.forEach((c) => {
          c.checked = !!o[c.name];
          if (c.name === 'words' || c.name === 'sets') c.closest('label').hidden = noWords;
        });
        root.querySelector('[name="sets"]').disabled = !o.words; // word groups only show as Large Words
        wrap.classList.toggle('no-conversation', !o.conversation);
        wrap.classList.toggle('no-important', !o.important);
      },
      setPaused(audio, motion) {
        toggleLabel(audioBtn, audio, 'voice'); toggleLabel(motionBtn, motion, 'motion');
        const held = audio || motion, t = held ? 'Resume Claude' : 'Pause Claude';
        ownPlay.setAttribute('aria-pressed', String(held)); ownPlay.title = t; ownPlay.setAttribute('aria-label', t);
        ownPlay.querySelector('path').setAttribute('d', held ? 'M8 5.5v13l10.5-6.5z' : 'M9 6v12M15 6v12');
      },
      /** The settings panel's Agent section, a line each: which agent, how it answers, what it's doing, what it used. */
      setAgent(name, via, status, usage) {
        agentName.textContent = name; agentStatus.textContent = status; agentUsage.textContent = usage;
        agentVia.textContent = ` ${via}`; agentMore.hidden = !via;
      },
      get play() { return play; },
    };
  }

  // ------------------------------------------------------------------ phrases
  const CLAUDE_WORD = '(?:claude|claud|clawed|cloud|clode|clyde|klaud|cloudy|claudia)';
  const WAKE_RE = new RegExp(`\\b(?:ok(?:ay)?|o\\.?\\s?k\\.?)[\\s,.!]+${CLAUDE_WORD}\\b[\\s,.!?:]*`, 'i');
  const THANKS_RE = new RegExp(`(?:^|\\b)(?:thanks|thank\\s+you|thank\\s+u|thx|cheers)(?:\\s+(?:so\\s+much|very\\s+much|a\\s+lot|again|${CLAUDE_WORD}))*[\\s.!,]*$`, 'i');
  const FAREWELLS = ["You're welcome.", 'Any time.', 'Happy to help.', 'My pleasure.'];
  function isThanks(text) {
    const m = text.match(THANKS_RE);
    if (!m) return false;
    const rest = text.slice(0, m.index).replace(/[^\w\s']/g, ' ').trim();
    return rest.split(/\s+/).filter(Boolean).length <= 4; // "great, thanks" ends; "tell me about Mars, thanks" is a question
  }
  const forSpeech = (s) => s.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#`>~|]/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();

  // ------------------------------------------------------------------ controller
  const host = (ds.target && document.querySelector(ds.target)) || (script && script.parentElement && script.parentElement.tagName === 'DIV' ? script.parentElement : document.body);
  const scene = Scene(host);
  const wordField = WordField(host);
  const listeners = {};
  const emit = (type, detail) => {
    (listeners[type] || []).forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } });
    host.dispatchEvent(new CustomEvent('claude-voice:' + type, { detail }));
  };

  // Brave exposes SpeechRecognition but disables the service behind it, so every attempt ends in a "network" error.
  const isBrave = !!navigator.brave;
  const SR = isBrave ? null : (window.SpeechRecognition || window.webkitSpeechRecognition);
  const NO_SR_NOTE = isBrave
    ? 'Brave blocks the speech recognition this needs. Use Chrome, Edge or Safari to talk, or type to Claude here.'
    : 'This browser has no speech recognition (try Chrome, Edge or Safari). You can type to Claude instead.';
  const tts = window.speechSynthesis;
  let rec = null, wantListening = false, recRunning = false, restartDelay = 250, networkErrors = 0;
  let mode = 'off';            // off | wake | listening | thinking | speaking
  let history = [], pending = '', sendTimer = null, idleTimer = null, abortCtl = null, queuedTurn = '';
  let speakQueue = [], speaking = null, streamDone = true, ttsUnlocked = false, voice = null, currentSentence = '';
  let audioPaused = false, motionPaused = false;
  let voiceBlockNoted = false; // a "voice was blocked" note shows once, until speech works again

  const ui = UI(host, {
    pill() {
      unlockAudio();
      if (mode === 'off') return start();
      if (mode === 'speaking' || mode === 'thinking') return interrupt();
      if (mode === 'listening') return endConversation(false);
      if (mode === 'wake') return beginConversation('');
    },
    typed(text) {
      unlockAudio();
      if (mode === 'off' || mode === 'wake' || mode === 'error') return beginConversation(text, true);
      if (mode === 'speaking' || mode === 'thinking') interrupt();
      handleUtterance(text);
    },
    passphrase(value) {
      store(PASS_KEY, value);
      const t = lockedText; lockedText = '';
      if (t) this.typed(t); // ask again the question that waited for it
    },
    voiceMode(m) {
      voiceMode = m; currentURI = '';
      store(MODE_KEY, m);
      pickVoice(); previewVoice();
    },
    voice(uri) {
      chosenVoice = uri;
      store(VOICE_KEY, uri);
      pickVoice(); previewVoice();
    },
    audio() { setAudioPaused(!audioPaused); },
    motion() { setMotionPaused(!motionPaused); },
    hold() { const p = !(audioPaused || motionPaused); setAudioPaused(p); setMotionPaused(p); }, // the widget's own play button
    playAdopted() { syncPlayButton(); },
    panelOpened() { checkAgent(); },
    textOutput(name, on) {
      textOut[name] = on;
      store(TEXT_KEY, JSON.stringify(textOut));
      applyTextOutput();
    },
  });

  function setMode(m) {
    mode = m;
    const labels = { off: 'Enable voice', wake: SR ? 'Say “Ok Claude”' : 'Type to start', listening: 'Listening… say “Thanks” to finish', thinking: 'Thinking…', speaking: 'Speaking… tap to interrupt', error: 'Voice unavailable' };
    ui.setState(m, labels[m] || m);
    scene.setActivity(m === 'wake' ? 'idle' : m === 'off' ? 'off' : m);
    syncPlayButton();
    emit('state', { state: m });
  }

  // --- pausing: Claude's voice holds mid-word (and later replies wait), and its motion freezes, until resumed
  const replying = () => mode === 'speaking' || mode === 'thinking';
  function setAudioPaused(p) {
    audioPaused = !!p;
    if (tts) { if (audioPaused) tts.pause(); else tts.resume(); }
    ui.setPaused(audioPaused, motionPaused); syncPlayButton();
  }
  function setMotionPaused(p) {
    motionPaused = !!p;
    scene.setPaused(motionPaused); wordField.setPaused(motionPaused);
    ui.setPaused(audioPaused, motionPaused); syncPlayButton();
  }
  // While Claude replies, the page's play button (data-play-button) shows pause or play for Claude, and a click on it
  // pauses or resumes Claude's voice and motion together, ahead of the page's own listeners. Afterwards its icon and
  // label go back to the page's, including any change the page made to them meanwhile.
  let ownPlay = null, pagePlay = null;
  function syncPlayButton() {
    const btn = ui.play, icon = btn && btn.querySelector('.material-icons');
    if (!icon) return;
    if (!ownPlay || icon.textContent !== ownPlay.icon || btn.title !== ownPlay.title) pagePlay = { icon: icon.textContent, title: btn.title, label: btn.getAttribute('aria-label') };
    if (replying()) {
      const held = audioPaused || motionPaused;
      ownPlay = { icon: held ? 'play_arrow' : 'pause', title: held ? 'Resume Claude' : 'Pause Claude' };
      icon.textContent = ownPlay.icon; btn.title = ownPlay.title; btn.setAttribute('aria-label', ownPlay.title);
    } else if (ownPlay) {
      ownPlay = null;
      icon.textContent = pagePlay.icon; btn.title = pagePlay.title;
      if (pagePlay.label === null) btn.removeAttribute('aria-label'); else btn.setAttribute('aria-label', pagePlay.label);
    }
  }
  {
    const onPlay = (e) => {
      if (!replying() || !ui.play || !ui.play.contains(e.target)) return;
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); e.stopImmediatePropagation();
      const p = !(audioPaused || motionPaused);
      setAudioPaused(p); setMotionPaused(p);
    };
    window.addEventListener('click', onPlay, true); // Capturing on window runs before the page's listeners, even capturing ones on document
    window.addEventListener('keydown', onPlay, true);
  }

  // --- audio unlock & mic level
  function unlockAudio() {
    if (!ttsUnlocked && tts) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; tts.speak(u); ttsUnlocked = true; } catch (e) { /* ignore */ } }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, unlockAudio, { once: true, capture: true }));

  let audioCtx = null;
  async function startMicLevel() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      scene.setLevelSource(() => {
        an.getByteTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i += 4) { const v = (data[i] - 128) / 128; sum += v * v; }
        return clamp(Math.sqrt(sum / (data.length / 4)) * 4, 0, 1);
      });
      return true;
    } catch (err) {
      return err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'denied' : false;
    }
  }

  // The settings panel's choices are remembered in this browser and win over data-voice / data-voice-mode.
  const VOICE_KEY = 'claude-voice:voice', MODE_KEY = 'claude-voice:voice-mode';
  let voiceMode = VOICE_MODES.includes(cfg.voiceMode) ? cfg.voiceMode : (cfg.voice ? 'chosen' : 'response');
  let chosenVoice = '', currentURI = '';
  try {
    const m = localStorage.getItem(MODE_KEY), v = localStorage.getItem(VOICE_KEY);
    if (VOICE_MODES.includes(m)) voiceMode = m;
    if (v !== null && v !== 'random') chosenVoice = v; // "random" was stored here by an earlier version
  } catch (e) { /* storage blocked */ }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ } }

  // The site's passphrase, when its Worker asks for one (TEAM_PASSPHRASE): kept in this browser for every tab on the site.
  const PASS_KEY = 'team-passphrase'; // shared/passphrase.js's PASSPHRASE_STORAGE_KEY, which other pages on the site also read
  let lockedText = ''; // the question that waited for the passphrase
  function passphrase() { try { return localStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; } }

  // The visitor's own Claude or Gemini key from the /keys page (keys/key-manager.js), for when the site's keys can't
  // answer. That page keeps keys in localStorage "settings_api-keys", either plain or encrypted with an AES key it keeps
  // in IndexedDB ("km-store"). "rsa:" ones only a server could read, so they're skipped.
  const KEYS_PAGE = '/keys/';
  const OWN_LABEL = { anthropic: 'Claude', google: 'Gemini' };
  let ownKey = null;      // { name, key } while this page answers with the visitor's own key
  let failedOwnKey = '';  // a saved key that already failed, so it isn't tried again until it's changed
  async function savedKey() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('settings_api-keys') || '{}'); } catch (e) { return null; }
    for (const name of Object.keys(OWN_LABEL)) {
      const v = saved && saved[name];
      if (typeof v !== 'string' || !v || v.startsWith('rsa:')) continue;
      const key = /^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/.test(v) ? await decryptSavedKey(v).catch(() => '') : v;
      if (key && key !== failedOwnKey) return { name, key };
    }
    return null;
  }
  function decryptSavedKey(v) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('km-store', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys'); // as key-manager.js opens it
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result, get = db.transaction('keys', 'readonly').objectStore('keys').get('browser-key');
        get.onerror = () => { db.close(); reject(get.error); };
        get.onsuccess = () => { db.close(); if (get.result) resolve(get.result); else reject(new Error('No browser key')); };
      };
    }).then((cryptoKey) => {
      const [iv, data] = v.split(':').map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
    }).then((plain) => new TextDecoder().decode(plain));
  }
  ui.setVoiceMode(voiceMode);

  // Text Output, also in the settings panel: which kinds of text show (data-text-output, then this browser's choices).
  // Important Text and Precise Word Sets each add rules to Claude's prompt (shared/voice-prompt.js), so they're asked for only when on.
  const TEXT_KEY = 'claude-voice:text-output', TEXT_KINDS = ['conversation', 'important', 'words', 'sets'];
  const textOut = (() => {
    const on = ds.textOutput === undefined ? ['conversation', 'words', 'sets'] : ds.textOutput.toLowerCase().split(/[\s,]+/);
    return Object.fromEntries(TEXT_KINDS.map((k) => [k, on.includes(k)]));
  })();
  try {
    const saved = JSON.parse(localStorage.getItem(TEXT_KEY) || 'null');
    if (saved) TEXT_KINDS.forEach((k) => { if (typeof saved[k] === 'boolean') textOut[k] = saved[k]; });
  } catch (e) { /* storage blocked or unreadable */ }
  function applyTextOutput() {
    ui.setTextOutput(textOut, !!wordField.off);
    wordField.setEnabled(textOut.words);
  }
  applyTextOutput();

  function englishVoices() { return tts ? rankVoices(tts.getVoices().filter((v) => /^en/i.test(v.lang || ''))) : []; }

  // New voice for "random" and "response" modes, never the one just used. A style (from Claude's mood header) narrows it to voices that suit the reply.
  function rollVoice(style) {
    if (voiceMode === 'chosen') return;
    const english = englishVoices();
    const fresh = (list) => list.filter((v) => v.voiceURI !== currentURI);
    const best = english.filter((v) => voiceTier(v) === 0);
    const top = best.length >= 3 ? best : english.filter((v) => voiceTier(v) <= 1).concat(english.slice(0, 5));
    let pool = [];
    const names = style && VOICE_STYLES[String(style).toLowerCase()];
    if (names) {
      const suits = english.filter((v) => voiceTier(v) <= 2 && names.some((n) => shortVoiceName(v).toLowerCase().startsWith(n.toLowerCase())));
      const floor = suits.length ? Math.max(voiceTier(suits[0]), 1) : 0; // english is ranked, so suits[0] is the best match
      pool = fresh(suits.filter((v) => voiceTier(v) <= floor));
      if (!pool.length) pool = fresh(suits); // a fitting standard voice beats an unfitting premium one
    }
    if (!pool.length) pool = fresh(top);
    if (!pool.length) pool = top;
    const v = pool[Math.floor(Math.random() * pool.length)];
    if (!v) return;
    currentURI = v.voiceURI; voice = v;
    ui.setVoiceInfo(voiceMode, shortVoiceName(v));
  }

  function pickVoice() {
    if (!tts) return;
    const vs = tts.getVoices();
    if (!vs.length) return;
    ui.setVoices(englishVoices(), chosenVoice);
    if (voiceMode !== 'chosen') {
      voice = vs.find((v) => v.voiceURI === currentURI) || null;
      if (voice) ui.setVoiceInfo(voiceMode, shortVoiceName(voice)); else rollVoice();
      if (voice) return;
    }
    const lang = cfg.lang.toLowerCase().slice(0, 2);
    const pool = rankVoices(vs.filter((v) => v.lang && v.lang.toLowerCase().startsWith(lang)));
    voice = (chosenVoice && vs.find((v) => v.voiceURI === chosenVoice))
      || (cfg.voice && vs.find((v) => v.name.toLowerCase().includes(cfg.voice.toLowerCase())))
      || pool[0] || null;
    ui.setVoiceInfo(voiceMode, '');
  }

  // Preview only while not mid-conversation, so the recogniser can't take the sample as something you said.
  function previewVoice() {
    if (!voice || !tts || !(mode === 'off' || mode === 'wake' || mode === 'error')) return;
    tts.cancel();
    const u = new SpeechSynthesisUtterance(`Hi, I’m ${shortVoiceName(voice).replace(/\s*\(.*$/, '')}.`);
    u.voice = voice; u.lang = voice.lang; u.rate = 1.02;
    tts.speak(u);
  }
  if (tts) { pickVoice(); tts.addEventListener && tts.addEventListener('voiceschanged', pickVoice); }

  // --- speech recognition
  function startRecognition() {
    wantListening = true;
    if (!SR || recRunning) return;
    if (!rec) {
      rec = new SR();
      rec.continuous = true; rec.interimResults = true; rec.lang = cfg.lang; rec.maxAlternatives = 1;
      rec.onstart = () => { recRunning = true; consumedUpTo = -1; };
      rec.onresult = onResult;
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          wantListening = false; setMode('error'); ui.note('Microphone access was blocked. Allow it in the address bar, then tap the button. You can also type.', 12000); ui.showInput();
        } else if (e.error === 'audio-capture') {
          wantListening = false; setMode('error'); ui.note('No microphone was found. Connect one, then tap the button. You can also type.', 12000); ui.showInput();
        } else if (e.error === 'network') {
          // A few in a row with nothing heard means the speech service is unreachable, not a blip.
          if (++networkErrors >= 3) { wantListening = false; setMode('error'); ui.note('Speech recognition can’t reach its service in this browser. Try Chrome, Edge or Safari, or type to Claude here.', 12000); ui.showInput(); }
          else restartDelay = Math.min(8000, restartDelay * 2);
        }
      };
      rec.onend = () => {
        recRunning = false;
        if (wantListening) setTimeout(() => { if (wantListening && !recRunning) { try { rec.start(); } catch (e) { /* already starting */ } } }, restartDelay);
      };
    }
    try { rec.start(); } catch (e) { /* already running */ }
  }
  function stopRecognition() { wantListening = false; if (rec && recRunning) try { rec.abort(); } catch (e) { /* ignore */ } }

  // Half a second without new words means you've finished. The recogniser's own "final" result can lag well
  // behind that, so the pause is timed from the last interim words and acted on without waiting for the final.
  const SEND_DELAY = 500;
  let lastHeard = 0, consumedUpTo = -1; // consumedUpTo: results already acted on from interim text, whose late finals are skipped

  function onResult(e) {
    restartDelay = 250; networkErrors = 0;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (i <= consumedUpTo) continue;
      const r = e.results[i], text = r[0].transcript.trim();
      if (!text) continue;
      if (r.isFinal) onFinal(text); else interim += text + ' ';
    }
    interim = interim.trim();
    if (!interim) return;
    lastHeard = Date.now();
    const upTo = e.results.length - 1;
    const afterPause = (fn) => { clearTimeout(sendTimer); sendTimer = setTimeout(() => { consumedUpTo = upTo; fn(); }, SEND_DELAY); };
    if (mode === 'listening') {
      ui.user((pending + ' ' + interim).trim());
      resetIdle();
      afterPause(() => { const t = (pending + ' ' + interim.replace(WAKE_RE, ' ')).trim(); pending = ''; handleUtterance(t); });
    } else if (mode === 'thinking') {
      ui.user((pending + ' ' + interim).trim());
      resetIdle();
    } else if (mode === 'wake' && WAKE_RE.test(interim)) {
      scene.pulse(0.2); // instant visual acknowledgement
      afterPause(() => {
        if (mode !== 'wake') return; // the final already started the conversation
        const m = interim.match(WAKE_RE);
        beginConversation(interim.slice(m.index + m[0].length).trim());
      });
    }
  }

  function onFinal(text) {
    if (mode === 'wake') {
      const m = text.match(WAKE_RE);
      if (m) beginConversation(text.slice(m.index + m[0].length).trim());
      return;
    }
    if (mode === 'speaking') {
      // Only listen for "thanks" (or the wake phrase) while Claude talks; anything else is probably Claude's own voice.
      if (/thank/i.test(currentSentence)) return;
      if (isThanks(text)) { interrupt(); endConversation(true); }
      else if (WAKE_RE.test(text)) { interrupt(); const rest = text.slice(text.match(WAKE_RE).index + text.match(WAKE_RE)[0].length).trim(); if (rest) handleUtterance(rest); }
      return;
    }
    if (mode === 'thinking') {
      if (isThanks(text)) { interrupt(); endConversation(true); } else queuedTurn = (queuedTurn + ' ' + text).trim();
      return;
    }
    if (mode === 'listening') {
      const cleaned = text.replace(WAKE_RE, ' ').trim(); // "Ok Claude" again mid-conversation is harmless
      if (!cleaned) return;
      pending = (pending + ' ' + cleaned).trim();
      ui.user(pending);
      resetIdle();
      clearTimeout(sendTimer);
      const wait = Math.max(0, SEND_DELAY - (Date.now() - lastHeard)); // the pause already started at your last words
      sendTimer = setTimeout(() => { const t = pending; pending = ''; handleUtterance(t); }, wait);
    }
  }

  // --- conversation
  function beginConversation(firstUtterance, typed) {
    history = []; pending = ''; queuedTurn = '';
    if (voiceMode === 'random') rollVoice();
    scene.applyMood(MOODS.listening);
    scene.pulse(0.5);
    emit('start', {});
    setMode('listening');
    resetIdle();
    if (firstUtterance) handleUtterance(firstUtterance);
    else if (!typed) ui.note('I’m listening.', 3000);
  }

  function endConversation(sayGoodbye) {
    clearTimeout(sendTimer); clearTimeout(idleTimer);
    if (abortCtl) abortCtl.abort();
    pending = ''; queuedTurn = '';
    const done = () => { setMode('wake'); scene.applyMood(MOODS.idle); ui.fade(4000); wordField.finish(); emit('end', { history: history.slice() }); };
    if (sayGoodbye) {
      const bye = FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)];
      ui.claude(bye);
      speakQueue = []; streamDone = true;
      enqueueSpeech(bye, done);
    } else done();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (mode === 'listening') { ui.note('Conversation ended after a quiet spell. Say “Ok Claude” to start again.', 6000); endConversation(false); } }, cfg.idleTimeout);
  }

  function handleUtterance(text) {
    text = text.trim();
    if (!text) return;
    if (isThanks(text)) return endConversation(true);
    ui.user(text);
    history.push({ role: 'user', content: text });
    if (history.length > cfg.maxHistory) history = history.slice(-cfg.maxHistory);
    askClaude();
  }

  async function askClaude() {
    clearTimeout(idleTimer);
    setMode('thinking');
    abortCtl = new AbortController();
    const ctl = abortCtl;
    let raw = '', spokenText = '', moodDone = false, sentenceBuf = '';
    streamDone = false;
    ui.claude(''); ui.important('');
    wordField.begin();
    // "Change for response": pick this reply's voice once the mood header is in, before the first sentence is spoken.
    const voiceForReply = (style) => { if (voiceMode === 'response') rollVoice(style); };

    const feedSpeech = (chunk) => {
      spokenText += chunk;
      ui.claude(unmark(forSpeech(spokenText)).replace(/\[$/, '')); // a mark may be half arrived
      sentenceBuf += chunk;
      let m;
      // speak each complete sentence as soon as it arrives
      while ((m = sentenceBuf.match(/^([\s\S]*?[.!?…](?:["')\]]*))(\s+)/))) {
        const s = forSpeech(m[1]);
        sentenceBuf = sentenceBuf.slice(m[0].length);
        if (s) enqueueSpeech(s, null, true);
      }
    };
    // The reply ends with <important>...</important> (when Important Text is on) and <summary>[...]</summary>, which go
    // to the screen instead of being spoken. A possible start of either tag at the end of a chunk waits for the next chunk.
    const TAGS = ['<important>', '<summary>'];
    let tailRaw = null, held = '', importantShown = false;
    const showImportant = (last) => {
      if (importantShown || tailRaw === null) return;
      const m = tailRaw.match(last ? /<important>([\s\S]*?)(?:<\/important>|<summary>|$)/ : /<important>([\s\S]*?)<\/important>/);
      if (m && m[1].trim()) { importantShown = true; ui.important(unmark(m[1]).trim()); }
    };
    const feedBody = (chunk) => {
      if (tailRaw !== null) { tailRaw += chunk; return showImportant(); }
      let s = held + chunk; held = '';
      const at = Math.min(...TAGS.map((t) => { const i = s.indexOf(t); return i < 0 ? Infinity : i; }));
      if (at < Infinity) { tailRaw = s.slice(at); s = s.slice(0, at); showImportant(); }
      else { const lt = s.lastIndexOf('<'); if (lt >= 0 && TAGS.some((t) => t.startsWith(s.slice(lt)))) { held = s.slice(lt); s = s.slice(0, lt); } }
      if (s) feedSpeech(s);
    };
    const take = (chunk) => {
      raw += chunk;
      if (moodDone) return feedBody(chunk);
      const head = raw.trimStart();
      if (head.length >= 6 && !head.startsWith('<mood')) { moodDone = true; voiceForReply(); return feedBody(head); }
      const end = head.indexOf('</mood>');
      if (end >= 0) {
        moodDone = true;
        let style = null;
        try {
          const mood = JSON.parse(head.slice(head.indexOf('>') + 1, end));
          scene.applyMood(mood); scene.pulse(0.35);
          style = mood.voice;
          emit('mood', mood);
        } catch (err) { /* bad header: keep current visuals */ }
        voiceForReply(style);
        const rest = head.slice(end + 7).replace(/^\s+/, '');
        if (rest) feedBody(rest);
      } else if (head.length > 600) { moodDone = true; voiceForReply(); feedBody(head); }
    };

    const thisRun = startRun();
    let retry = false; // with the visitor's own key, once the site's keys couldn't answer
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json',
          ...(ownKey ? { 'x-provider-name': ownKey.name, 'x-provider-key': ownKey.key } : passphrase() && { 'x-team-passphrase': passphrase() }) },
        body: JSON.stringify({ messages: history, output: { conversation: textOut.conversation, important: textOut.important, sets: textOut.words && textOut.sets && !wordField.off } }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `Endpoint replied ${res.status}`), { passphrase: res.status === 401 && body.passphrase, keys: !!body.keys });
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt; try { evt = JSON.parse(line); } catch { continue; }
          if (evt.t === 'text') take(evt.v);
          else if (evt.t === 'error') throw Object.assign(new Error(evt.v), { keys: !!evt.keys }); // keys: the site's keys all failed
          else if (evt.t === 'note') ui.note(evt.v, 15000); // e.g. why Gemini is answering instead of Claude
          else if (evt.t === 'agent') { agent = evt.v; showAgent(); }
          else if (evt.t === 'tool') { thisRun.tools++; thisRun.activity = `${evt.v.name} ${evt.v.target || ''}`.trim(); showAgent(); }
          else if (evt.t === 'usage') { thisRun.usage = evt.v; showAgent(); }
        }
      }
      if (!moodDone && raw) { moodDone = true; voiceForReply(); feedBody(raw.trimStart()); }
      if (held) { feedSpeech(held); held = ''; }
      showImportant(true);
      const sum = tailRaw && tailRaw.match(/<summary>([\s\S]*)/);
      wordField.summary(parseSummary(sum && sum[1]));
      const tail = forSpeech(sentenceBuf); sentenceBuf = '';
      if (tail) enqueueSpeech(tail, null, true);
      if (raw.trim()) history.push({ role: 'assistant', content: raw.trim() });
      emit('reply', { text: unmark(forSpeech(spokenText)) });
      endRun(thisRun, 'done');
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.warn('[claude-voice]', err);
      let msg = /Failed to fetch|NetworkError|Load failed/i.test(err.message)
        ? (isLocal ? 'I can’t reach the local bridge. Start it with: node engine/server/local-bridge.mjs' : 'I can’t reach the server right now.')
        : err.message;
      if (ownKey) { msg += ` Update it on the Keys page (${KEYS_PAGE}).`; failedOwnKey = ownKey.key; ownKey = null; }
      // The site's keys all failed, or this visitor has no passphrase: answer with their own key from the Keys page.
      const own = err.keys || (err.passphrase && !passphrase()) ? await savedKey() : null;
      endRun(thisRun, 'error', msg);
      if (own) {
        ownKey = own;
        ui.note(err.keys ? `${msg} Trying your ${OWN_LABEL[own.name]} key from the Keys page.` : `Using your ${OWN_LABEL[own.name]} key from the Keys page.`, 12000);
        retry = true;
      } else {
        if (err.keys || err.passphrase) msg += ` ${err.passphrase ? 'Or add' : 'You can add'} your own Claude or Gemini key on the Keys page (${KEYS_PAGE}).`;
        const asked = history.pop();
        ui.note(msg, 12000);
        if (err.passphrase) {
          // The stored passphrase (if any) didn't match: forget it, and ask the question again once a new one is entered.
          try { localStorage.removeItem(PASS_KEY); } catch (e) { /* storage blocked */ }
          lockedText = asked && asked.role === 'user' ? asked.content : '';
          ui.askPassphrase();
        } else enqueueSpeech('Sorry, I couldn’t reach Claude just then.');
      }
    } finally {
      if (abortCtl === ctl) abortCtl = null;
      streamDone = true;
      if (!retry && !speaking && !speakQueue.length) afterSpeech();
    }
    if (retry) return askClaude(); // the question is still the last in history
  }

  // --- the settings panel's Agent section: which agent answers (sent with each reply, and by the local bridge's
  // .../status), what it's doing while it answers, and what the last reply used. After Stop, it asks the bridge
  // whether any Claude process is still running, so a reply that kept going in the background would show.
  const STATUS_URL = cfg.endpoint.replace(/\/?$/, '/status');
  let agent = null, run = null, server = null, agentTick = null;
  const secs = (ms) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
  const num = (n) => Number(n || 0).toLocaleString();
  const looks = (n) => (n ? `${n} file look${n === 1 ? '' : 's'}` : '');
  function usageText(u, tools) {
    if (!u) return looks(tools);
    const cached = (u.cacheRead || 0) + (u.cacheWrite || 0);
    return [`${num((u.input || 0) + cached)} tokens in${u.cacheRead ? ` (${num(u.cacheRead)} cached)` : ''}`, `${num(u.output)} out`,
      typeof u.costUsd === 'number' && `$${u.costUsd.toFixed(4)}`, u.turns > 1 && `${u.turns} turns`, looks(tools)].filter(Boolean).join(' · ');
  }
  function showAgent() {
    const name = agent ? [agent.name, agent.model].filter(Boolean).join(' · ') : 'Not known until Claude first answers';
    const via = agent ? agent.files || (agent.detail && `Uses ${agent.detail}`) : '';
    const others = server && server.running && !(run && run.state === 'running') ? server.running : [];
    let status = '', usage = '';
    if (run) {
      status = run.state === 'running' ? `Running ${secs(Date.now() - run.started)}${run.activity ? ` · ${run.activity}` : ''}`
        : run.state === 'stopping' ? 'Stopping…'
        : run.state === 'stopped' ? (server ? (others.length ? '' : 'Stopped. No Claude process is running.') : 'Stopped. The reply was cancelled.')
        : run.state === 'error' ? `Error: ${run.error}`
        : `Finished in ${secs(run.ms)}`;
      usage = usageText(run.usage, run.tools);
    } else if (server && server.last) {
      status = `Last request ${server.last.outcome === 'done' ? 'finished' : server.last.outcome} in ${secs(server.last.ms)}`;
      usage = usageText(server.last.usage, server.last.tools);
    } else status = 'Idle';
    if (others.length) status = `Still running: ${others.map((r) => `${r.pid ? `process ${r.pid}, ` : ''}${r.seconds}s, ${r.activity}`).join('; ')}`;
    ui.setAgent(name, via, status, usage);
  }
  function startRun() {
    run = { started: Date.now(), state: 'running', activity: '', tools: 0, usage: null };
    server = null;
    clearInterval(agentTick); agentTick = setInterval(showAgent, 1000);
    showAgent();
    return run;
  }
  function endRun(r, state, error) {
    if (r !== run || r.state !== 'running') return;
    Object.assign(r, { state, error, ms: Date.now() - r.started });
    clearInterval(agentTick);
    showAgent();
  }
  function stoppingRun() {
    if (!run || run.state !== 'running') return;
    Object.assign(run, { state: 'stopping', ms: Date.now() - run.started });
    clearInterval(agentTick);
    showAgent();
    // Asks again, a few times, while the bridge still lists a process (it ends the CLI on Stop, which can take a moment).
    const r = run;
    const check = (tries) => checkAgent().then(() => {
      if (run === r && r.state === 'stopping') { r.state = 'stopped'; showAgent(); }
      if (tries > 1 && server && server.running && server.running.length) setTimeout(() => check(tries - 1), 2000);
    });
    setTimeout(() => check(5), 1500);
  }
  // The bridge's view, which includes replies from other tabs. The Worker has none, which leaves the status as this page saw it.
  async function checkAgent() {
    try {
      const res = await fetch(STATUS_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      server = await res.json();
      if (server.agent) agent = server.agent;
    } catch (e) { server = null; }
    showAgent();
  }
  showAgent();

  // --- text to speech (own queue so we can pulse visuals, interrupt, and recover from stuck engines)
  function enqueueSpeech(text, onDone, showWords) {
    speakQueue.push({ text, onDone, showWords });
    if (!speaking) speakNext();
  }
  function speakNext() {
    const item = speakQueue.shift();
    if (!item) { speaking = null; currentSentence = ''; if (streamDone) afterSpeech(); return; }
    if (mode !== 'speaking') setMode('speaking');
    const spoken = unmark(item.text); // item.text may hold marked word groups, for the word field
    currentSentence = spoken;
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(watchdog);
      if (item.onDone) { speaking = null; currentSentence = ''; return item.onDone(); }
      speakNext();
    };
    const words = spoken.split(/\s+/).length;
    // Engines sometimes never fire onend. While the voice is paused, the wait starts over.
    let watchdog;
    const arm = () => { watchdog = setTimeout(() => (audioPaused ? arm() : finish()), 2500 + words * 520); };
    arm();
    speaking = item;
    if (!tts) { if (item.showWords) wordField.sentence(item.text, null); setTimeout(finish, 400 + words * 60); return; }
    const u = new SpeechSynthesisUtterance(spoken);
    if (item.showWords) wordField.sentence(item.text, u);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || cfg.lang; u.rate = 1.02; u.pitch = 1;
    u.onboundary = (ev) => { if (ev.name === 'word' || ev.name === undefined) scene.pulse(0.06 + 0.12 * (scene.state.energy || 0)); };
    u.onstart = () => { voiceBlockNoted = false; scene.pulse(0.15); };
    u.onend = finish;
    u.onerror = (e) => {
      // Browsers refuse to speak ("not-allowed") until the page has had a click or key press, and when the site's
      // Autoplay setting blocks sound. Without this note the reply would go by in silence.
      if (e.error === 'not-allowed' && !voiceBlockNoted) {
        voiceBlockNoted = true;
        ui.note(`${isBrave ? 'Brave' : 'Your browser'} blocked Claude’s voice. Click anywhere on the page, or allow Autoplay for this site in the site settings (left of the address).`, 15000);
      }
      finish();
    };
    tts.speak(u);
  }
  function afterSpeech() {
    wordField.finish();
    if (mode !== 'speaking' && mode !== 'thinking') return;
    setMode('listening');
    resetIdle();
    if (queuedTurn) { const t = queuedTurn; queuedTurn = ''; handleUtterance(t); }
  }
  function interrupt() {
    if (abortCtl) { abortCtl.abort(); stoppingRun(); }
    speakQueue = []; streamDone = true;
    const s = speaking; speaking = null; currentSentence = '';
    if (tts) tts.cancel();
    wordField.finish();
    if (s && s.onDone) return s.onDone();
    if (mode === 'speaking' || mode === 'thinking') { setMode('listening'); resetIdle(); }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (mode === 'speaking' || mode === 'thinking')) interrupt(); });

  // --- lifecycle
  async function start() {
    if (mode !== 'off' && mode !== 'error') return;
    if (!SR) {
      setMode('wake');
      ui.note(NO_SR_NOTE, 10000);
      ui.showInput();
      return;
    }
    const mic = cfg.micLevel ? await startMicLevel() : true;
    if (mic === 'denied') { setMode('error'); ui.note('Microphone access was blocked. Allow it in the address bar, then tap the button. You can also type.', 12000); ui.showInput(); return; }
    setMode('wake');
    startRecognition();
  }
  function stop() {
    interrupt(); stopRecognition(); clearTimeout(idleTimer);
    setMode('off'); scene.applyMood(MOODS.idle);
  }

  setMode('off');
  if (cfg.autostart && SR && navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'microphone' }).then((p) => { if (p.state === 'granted') start(); }).catch(() => {});
  }

  window.ClaudeVoice = {
    start, stop, interrupt,
    /** The words, summary and important text stay up after a conversation ends, until the next reply; this clears them sooner. */
    clearWords: () => { wordField.clear(); ui.important(''); },
    /** Pause (true) or resume (false) Claude's voice, or its motion: the canvas and floating words. */
    pauseAudio: (p = true) => setAudioPaused(p),
    pauseMotion: (p = true) => setMotionPaused(p),
    end: () => endConversation(true),
    /** Feed text as if it were spoken (useful for testing and for custom inputs). */
    say(text) { if (mode === 'off' || mode === 'wake' || mode === 'error') { const m = text.match(WAKE_RE); if (m) return beginConversation(text.slice(m.index + m[0].length).trim()); return beginConversation(text, true); } if (mode === 'speaking' || mode === 'thinking') interrupt(); handleUtterance(text); },
    setMood: (m) => scene.applyMood(typeof m === 'string' ? MOODS[m] || { mood: m } : m),
    on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); return () => { listeners[type] = listeners[type].filter((f) => f !== fn); }; },
    get state() { return mode; },
    get history() { return history.slice(); },
    config: cfg,
    moods: Object.keys(MOODS),
  };
})();
