/* Server voices for the voice widget (js/voice-chat.js), which imports this module only once a voice other than the
   browser's own is chosen or previewed, so pages using browser voices load nothing more.

   createPlayer(audio) plays a sentence at a time through one Audio element (audio, which the widget unlocks on the
   page's first tap, as Safari needs). player.speak(text, fetcher, key) returns an EventTarget that stands in for a
   SpeechSynthesisUtterance, firing the same events: start, boundary (with charIndex, for the floating words and the
   pulse), end, and error (with .error, a message). fetcher(signal) resolves to { blob, words }, where words are
   [[charIndex, seconds], ...] from the voice source, or null to estimate them from each word's share of the text.
   prefetch(text, fetcher, key) fetches the next sentence while this one plays, so there's no gap between them. */

// Each word's start, estimated from the characters before it, when the source gives no timings.
function estimateWords(text, seconds) {
  const out = [], spoken = Math.max(0.1, seconds * 0.94); // a little silence at the end
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i]) && (i === 0 || /\s/.test(text[i - 1]))) out.push([i, spoken * (i / text.length)]);
  return out;
}

export function createPlayer(audio = new Audio()) {
  audio.preload = 'auto';
  const cache = new Map(); // key → { ctl, promise }, for the sentence playing and the one after it
  let current = null, paused = false;

  function load(key, fetcher) {
    let hit = cache.get(key);
    if (!hit) {
      const ctl = new AbortController();
      hit = { ctl, promise: fetcher(ctl.signal) };
      hit.promise.catch(() => cache.delete(key));
      cache.set(key, hit);
      while (cache.size > 3) { const [k, old] = cache.entries().next().value; if (old === hit) break; old.ctl.abort(); cache.delete(k); }
    }
    return hit;
  }

  function speak(text, fetcher, key = text) {
    const u = new EventTarget();
    const fire = (type, extra) => u.dispatchEvent(Object.assign(new Event(type), extra));
    let cancelled = false, url = '', frame = 0, words = [], next = 0, started = false;
    const cleanup = () => {
      cancelAnimationFrame(frame);
      audio.onended = audio.onerror = audio.onplaying = null;
      if (url) { URL.revokeObjectURL(url); url = ''; }
      if (current === u) current = null;
    };
    const tick = () => {
      while (next < words.length && audio.currentTime >= words[next][1]) fire('boundary', { charIndex: words[next++][0], name: 'word' });
      if (!audio.paused) frame = requestAnimationFrame(tick);
    };
    u.cancel = () => {
      if (cancelled) return;
      cancelled = true;
      const hit = cache.get(key);
      if (hit && !started) hit.ctl.abort();
      cache.delete(key);
      if (current === u) audio.pause();
      cleanup();
    };
    u.resume = () => { if (url && !cancelled && audio.paused) audio.play().catch(() => {}); };
    if (current) current.cancel();
    current = u;
    const hit = load(key, fetcher);
    hit.promise.then(({ blob, words: given }) => {
      if (cancelled) return;
      cache.delete(key);
      url = URL.createObjectURL(blob);
      audio.src = url;
      audio.onplaying = () => {
        if (!started) {
          started = true;
          words = (given && given.length ? given : estimateWords(text, audio.duration || text.length / 15)).slice().sort((a, b) => a[1] - b[1]);
          fire('start');
        }
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(tick);
      };
      audio.onended = () => { if (cancelled) return; while (next < words.length) fire('boundary', { charIndex: words[next++][0], name: 'word' }); cleanup(); fire('end'); };
      audio.onerror = () => { if (cancelled) return; cleanup(); fire('error', { error: 'The audio couldn’t play.' }); };
      if (!paused) audio.play().catch((err) => { if (cancelled) return; cleanup(); fire('error', { error: err.name === 'NotAllowedError' ? 'not-allowed' : err.message }); });
    }, (err) => {
      if (cancelled || err.name === 'AbortError') return;
      cleanup();
      fire('error', { error: err.message || String(err), status: err.status, passphrase: err.passphrase, needsKey: err.needsKey });
    });
    return u;
  }

  return {
    speak,
    prefetch(text, fetcher, key = text) { load(key, fetcher); },
    pause() { paused = true; if (current) audio.pause(); },
    resume() { paused = false; if (current) current.resume(); },
    stop() { if (current) current.cancel(); for (const { ctl } of cache.values()) ctl.abort(); cache.clear(); },
    get speaking() { return !!current; },
  };
}

