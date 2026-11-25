import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise the widget's actual recognition handlers with a controllable speech service.
const source = readFileSync(new URL('../js/voice-chat.js', import.meta.url), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const handlers = section('  function startRecognition()', '  // --- speech to text through the bridge');
const fallback = section('  function sttFailed(', '  // The Speech to Text choice');
const results = section('  function onResult(', '  function onFinal(');

function widget({ local = true, choice = 'auto', ready = true, mode = 'wake', micLevel = false } = {}) {
  const timers = [];
  const state = {
    mode, rec: null, wantListening: false, recRunning: false, listenPaused: false,
    viaBridgeStt: false, srBroken: false, srMisses: 0, sttSwitch: '',
    micAn: micLevel ? {} : null, soundMs: 0, SOUND_MS: 400,
    restartDelay: 250, networkErrors: 0, noSpeechWarned: false,
    transcriber: { name: 'test transcriber', local },
    listenOpt: { stt: choice }, cfg: { lang: 'en-US' }, isBrave: false,
    consumedUpTo: -1, echoResults: new Set(), REC_ERRORS: {}, micHeld: false,
    handovers: 0, starts: 0,
    console: { warn() {}, debug() {} }, ui: { note() {}, showInput() {} },
    bridgeSttReady: () => ready,
    setTimeout: (fn) => timers.push(fn), clearTimeout() {},
    shownName: () => 'Claude', heard: (text) => text, onFinal() {},
  };
  state.setMode = (value) => { state.mode = value; };
  state.listenVia = () => { state.handovers++; state.viaBridgeStt = true; state.wantListening = false; };
  state.SR = class {
    start() { state.starts++; }
    abort() {}
  };
  vm.createContext(state);
  vm.runInContext(handlers + fallback + results, state);
  state.startRecognition();
  state.silence = () => state.rec.onerror({ error: 'no-speech' });
  state.sound = (ms) => { state.soundMs += ms; };
  state.flush = () => timers.splice(0).forEach((fn) => fn());
  return state;
}

test('two silence errors while waiting for the wake phrase hand over to local transcription', () => {
  const w = widget();
  w.silence();
  assert.equal(w.handovers, 0);
  w.silence();
  assert.equal(w.handovers, 1);
  assert.equal(w.srBroken, true);
});

test('a successful browser result does not disable fallback for the rest of the page', () => {
  const w = widget({ mode: 'listening' });
  w.onResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello' }], { isFinal: true })] });
  w.silence();
  w.silence();
  assert.equal(w.handovers, 1);
});

test('a browser result resets the consecutive silence counter', () => {
  const w = widget({ mode: 'listening' });
  w.silence();
  w.onResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello' }], { isFinal: true })] });
  w.silence();
  assert.equal(w.handovers, 0);
  w.silence();
  assert.equal(w.handovers, 1);
});

test('cloud transcription does not receive ambient wake recordings', () => {
  const w = widget({ local: false });
  w.silence(); w.silence(); w.silence();
  assert.equal(w.handovers, 0);
});

test('cloud transcription can take over during an active conversation', () => {
  const w = widget({ local: false, mode: 'listening' });
  w.silence(); w.silence();
  assert.equal(w.handovers, 1);
});

test('explicit Browser choice and unavailable bridge retain browser recognition', () => {
  for (const options of [{ choice: 'browser' }, { ready: false }]) {
    const w = widget(options);
    w.silence(); w.silence();
    assert.equal(w.handovers, 0);
  }
});

test('a pending browser restart cannot compete with bridge capture', () => {
  const w = widget();
  w.rec.onend();
  w.viaBridgeStt = true;
  w.flush();
  w.startRecognition();
  assert.equal(w.starts, 1);
});

test('microphone denial still reports an error without starting bridge capture', () => {
  const w = widget();
  w.rec.onerror({ error: 'not-allowed' });
  assert.equal(w.mode, 'error');
  assert.equal(w.handovers, 0);
});

test('with a mic level, silence in a quiet room never hands over', () => {
  const w = widget({ micLevel: true });
  for (let i = 0; i < 6; i++) w.silence();
  assert.equal(w.handovers, 0);
});

test('with a mic level, two silences after sound hand over and say why', () => {
  const w = widget({ micLevel: true, mode: 'listening' });
  w.sound(500); w.silence();
  w.silence();
  assert.equal(w.handovers, 0);
  w.sound(500); w.silence();
  assert.equal(w.handovers, 1);
  assert.match(w.sttSwitch, /^Switched to Bridge \(test transcriber\) at .+: This browser’s speech input isn’t hearing you\./);
});

test('a brief sound below the threshold does not count as missed speech', () => {
  const w = widget({ micLevel: true });
  w.sound(200); w.silence();
  w.sound(200); w.silence();
  assert.equal(w.handovers, 0);
});

test('a browser result clears sound heard before it', () => {
  const w = widget({ micLevel: true, mode: 'listening' });
  w.sound(500); w.silence();
  w.sound(500);
  w.onResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello' }], { isFinal: true })] });
  w.silence();
  assert.equal(w.handovers, 0);
});
