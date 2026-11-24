#!/usr/bin/env node
// Local bridge for voice-chat.js — run on your machine while developing on localhost.
//
//   node server/local-bridge.mjs                 # API endpoint only (http://localhost:3703/api/voice-chat)
//   node server/local-bridge.mjs --serve ../     # also serve your webroot at http://localhost:3703/
//
// LOCAL_BACKEND=cli (default) answers through the Claude Code CLI using your logged-in Claude account. It can read the
//   webroot's files (this submodule's parent folder) to answer questions about the site, but not change them or read anything
//   outside it. CLI_READ_FILES=false answers without files.
// LOCAL_BACKEND=api answers through the Claude API with ANTHROPIC_API_KEY from .env.
// POST .../transcribe turns speech into text for browsers whose own speech input is missing or fails (see TRANSCRIBE below).
// POST .../focus brings the page's tab to the front of its browser, on a Mac (see FOCUS below).
// GET .../voices and POST .../speak give the widget natural voices (see VOICES below): Kokoro on this computer once it's
//   installed (npm install --prefix engine/server/kokoro), and Grok, ElevenLabs, OpenAI and Google with their keys.
// No npm dependencies; needs Node 18+.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync, createReadStream, mkdtempSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, pageFile, pagePath, sanitizeMessages, systemPrompt, transcriptPrompt } from '../shared/voice-prompt.js';
import { streamClaude } from '../shared/anthropic.js';
import { listVoices, speakText } from '../shared/tts/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------- .env ----------
function loadEnv(file) {
  if (!existsSync(file)) return false;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}
// The env file named by env_file: in automation/paths.yaml, in the webroot above this submodule (relative to that
// automation folder), as the site's other scripts use it. $VOICE_CHAT_ENV, when set, names another file instead.
function pathsYamlEnv(webroot) {
  const yaml = path.join(webroot, 'automation', 'paths.yaml');
  if (!existsSync(yaml)) return null;
  const m = readFileSync(yaml, 'utf8').match(/^env_file:\s*["']?([^"'#\n]+?)["']?\s*(#.*)?$/m);
  return m ? path.resolve(webroot, 'automation', m[1].trim()) : null;
}
const envFile = process.env.VOICE_CHAT_ENV || pathsYamlEnv(path.resolve(ROOT, '..'));
const envLoaded = !!envFile && loadEnv(envFile);

const args = process.argv.slice(2);
const serveIdx = args.indexOf('--serve');
const SERVE_ROOT = serveIdx >= 0 ? path.resolve(args[serveIdx + 1] || '.') : (process.env.BRIDGE_SERVE_ROOT ? path.resolve(process.env.BRIDGE_SERVE_ROOT) : null);

const PORT = Number(process.env.BRIDGE_PORT || 3703);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const MODEL = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
const BACKEND = (process.env.LOCAL_BACKEND || 'cli').toLowerCase();
const CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS || 120000);
const API_PATH = '/api/voice-chat';

// Only pages on localhost may call the bridge (plus anything listed in LOCAL_ALLOWED_ORIGINS).
const extraOrigins = (process.env.LOCAL_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return true; // same-origin requests (when using --serve) or curl
  if (extraOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
  } catch { return false; }
}

// ---------- backends ----------
const cliWorkDir = mkdtempSync(path.join(tmpdir(), 'voice-chat-')); // empty dir: no CLAUDE.md, no project files

// File access for the CLI: the webroot (this submodule's parent folder), read-only.
// - Only the Read, Glob and Grep tools exist in its sessions, so nothing can be written, edited or run.
// - The only path allowed is inside the webroot. Links are checked by where they lead, so one pointing outside is refused.
// - dontAsk refuses whatever isn't allowed, with no prompt, and settings files (yours, the project's) aren't loaded, so
//   none of their allow rules widen this. Env and key files are denied even inside the webroot (Grep skips hidden files too).
const WEBROOT = path.resolve(ROOT, '..');
const READ_FILES = process.env.CLI_READ_FILES !== 'false';
const SECRET_FILES = ['**/.env', '**/.env.*', '**/.envrc', '**/.dev.vars', '**/*.pem', '**/*.key'];
const CLI_SETTINGS = JSON.stringify({ permissions: { allow: [`Read(/${WEBROOT}/**)`], deny: SECRET_FILES.map((p) => `Read(${p})`) } });
// quiet: the page hides its conversation text (Text Output in voice-chat.js), so Claude looks first and says only the answer.
// page: the path of the page the person is on, whose own files are where a question about it starts.
const filesPrompt = (quiet, page) => `

Files: you're running on the developer's own computer, in the folder holding this website's source files (${WEBROOT}).
When a question is about this site, its pages, code, data or documentation, look at its files with Read, Glob and Grep, then answer from what you found.
- You can only read. Files can't be changed, and nothing outside that folder is open to you. If a look is refused, say so briefly.
- Never read or repeat secrets: env files, keys, tokens or passwords.
${quiet
    ? '- Look before you say anything, then give just the answer.'
    : '- Before your first look, say in a few words what you\'re checking, so the person hears from you while you look. Then carry on once you\'ve looked.'}
- Everything you write, before and after looking, is one spoken reply: the mood header only once, at the very start, and the summary only once, at the very end.
- Tell what you found as you would in conversation: name files and folders plainly, without spelling out paths or reading code aloud.${pagePath(page) ? `
- A question about the page they're on starts with that page's own files: read ${pageFile(page)}, then the README.md in its folder if there is one, and answer from those. Look further only when they don't answer it, and don't start from the site's root README.` : ''}`;

// The agent answering, as the settings panel's Agent section names it (also sent with each reply and from /status).
const AGENT = BACKEND === 'api'
  ? { name: 'Claude API', detail: 'API key from the env file', model: MODEL }
  : { name: 'Claude Code CLI', detail: process.env.CLI_USE_API_KEY === 'true' ? 'API key from the env file' : 'your Claude login', model: MODEL,
      files: READ_FILES ? `${path.basename(WEBROOT)} (read-only)` : null };

// Requests being answered now (until their CLI process has exited) and how the last one went, for GET .../status.
const running = new Map();
let lastRun = null, runCount = 0;
const inWebroot = (p) => (p && path.isAbsolute(p) && p.startsWith(WEBROOT + path.sep) ? path.relative(WEBROOT, p) : p);

// onInfo gets { pid }, { tool: { name, target } }, { thinking } (Claude's thinking, when the model thinks) and { usage: {...} } as they happen.
function askCli(messages, system, onText, signal, output, onInfo = () => {}, page = '') {
  const access = READ_FILES
    ? ['--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--settings', CLI_SETTINGS]
    : ['--tools', ''];
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Keep the CLI on your Claude login (subscription) unless you opt in to API billing.
    if (process.env.CLI_USE_API_KEY !== 'true') delete env.ANTHROPIC_API_KEY;

    const child = spawn(CLI, [
      '-p',
      '--model', MODEL,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--system-prompt', READ_FILES ? system + filesPrompt(output?.conversation === false, page) : system,
      ...access,
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ], { cwd: READ_FILES ? WEBROOT : cliWorkDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    onInfo({ pid: child.pid });

    let streamed = false, newMessage = false, thought = false;
    let finalText = '';
    let stderr = '';
    let buf = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), CLI_TIMEOUT_MS);
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'stream_event') {
          const e = evt.event || {};
          // Claude may speak, look at files, then speak again: each part is its own message, joined by a line break so
          // the last sentence before the look and the first one after it don't run together.
          if (e.type === 'message_start') newMessage = true;
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            if (newMessage && streamed) onText('\n');
            newMessage = false;
            streamed = true;
            onText(e.delta.text);
          }
          if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) { thought = true; onInfo({ thinking: e.delta.thinking }); }
        } else if (evt.type === 'assistant') {
          for (const block of evt.message?.content || []) {
            if (block.type === 'tool_use') onInfo({ tool: { name: block.name, target: inWebroot(block.input?.file_path || block.input?.path || '') || block.input?.pattern || '' } });
            // Older CLIs without partial messages: emit whole assistant text blocks.
            else if (block.type === 'text' && !streamed) finalText += block.text;
            else if (block.type === 'thinking' && !thought && block.thinking) onInfo({ thinking: block.thinking });
          }
        } else if (evt.type === 'result') {
          if (evt.is_error) stderr += String(evt.result || evt.subtype || 'CLI error');
          else if (!streamed && !finalText && typeof evt.result === 'string') finalText = evt.result;
          const u = evt.usage || {};
          onInfo({ usage: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
            output: u.output_tokens, costUsd: evt.total_cost_usd, turns: evt.num_turns, ms: evt.duration_ms } });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`Claude Code CLI not found ("${CLI}"). Install it or set CLAUDE_CLI_PATH.`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (!streamed && finalText) onText(finalText);
      if (signal.aborted) return resolve();
      if (code !== 0 && !streamed && !finalText) return reject(new Error(stderr.trim().slice(0, 400) || `CLI exited with code ${code}`));
      resolve();
    });

    child.stdin.end(transcriptPrompt(messages));
  });
}

function askApi(messages, system, onText, signal, output, onInfo = () => {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  return streamClaude({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL, system, messages, signal, onText, onUsage: (usage) => onInfo({ usage }), onThinking: (thinking) => onInfo({ thinking }) });
}

// ---------- speech to text ----------
// For a browser whose own speech input is missing (Brave, Firefox, iOS browsers other than Safari) or isn't working:
// voice-chat.js records what's said, a turn at a time, and posts it to .../transcribe as a 16 kHz mono WAV. The text
// comes back as { text } and the page sends it on as a spoken turn. TRANSCRIBE picks how:
//   auto (default)  whisper.cpp when it's set up, else a cloud service when it has a key, else none (the page then types)
//   whisper         whisper.cpp on this computer: WHISPER_CLI (default whisper-cli, as Homebrew's whisper-cpp installs it)
//                   and WHISPER_MODEL, a ggml model file (default: one found in ~/.cache/whisper.cpp, ~/whisper.cpp/models
//                   or Homebrew's share/whisper-cpp, preferring base.en). brew install whisper-cpp, then download a model:
//                   curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
//   cloud           an OpenAI-compatible /audio/transcriptions endpoint: TRANSCRIBE_URL (default OpenAI's),
//                   TRANSCRIBE_API_KEY (default OPENAI_API_KEY) and TRANSCRIBE_MODEL (default gpt-4o-mini-transcribe).
//                   Groq works too, with its URL, key and a model such as whisper-large-v3-turbo.
//   off             none
const TRANSCRIBE = (process.env.TRANSCRIBE || 'auto').toLowerCase();
const WHISPER_PREFER = ['base.en', 'small.en', 'large-v3-turbo', 'medium.en', 'base', 'small', 'tiny.en', 'tiny'];
function onPath(cmd) {
  if (path.isAbsolute(cmd)) return existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(dir, cmd); if (dir && existsSync(f)) return f; }
  return null;
}
function findWhisperModel() {
  if (process.env.WHISPER_MODEL) return existsSync(process.env.WHISPER_MODEL) ? process.env.WHISPER_MODEL : null;
  const dirs = [path.join(homedir(), '.cache', 'whisper.cpp'), path.join(homedir(), 'whisper.cpp', 'models'),
    '/opt/homebrew/share/whisper-cpp', '/opt/homebrew/share/whisper-cpp/models', '/usr/local/share/whisper-cpp', '/usr/local/share/whisper-cpp/models'];
  const found = [];
  for (const dir of dirs) { try { for (const f of readdirSync(dir)) if (/^ggml-.+\.bin$/.test(f)) found.push(path.join(dir, f)); } catch { /* not there */ } }
  const rank = (f) => { const i = WHISPER_PREFER.findIndex((n) => path.basename(f) === `ggml-${n}.bin`); return i < 0 ? 99 : i; };
  return found.sort((a, b) => rank(a) - rank(b))[0] || null;
}
function pickTranscriber() {
  if (TRANSCRIBE === 'off') return null;
  if (TRANSCRIBE === 'auto' || TRANSCRIBE === 'whisper') {
    const cli = onPath(process.env.WHISPER_CLI || 'whisper-cli'), model = cli && findWhisperModel();
    if (cli && model) return { kind: 'whisper', name: 'whisper.cpp', model: path.basename(model).replace(/^ggml-|\.bin$/g, ''), local: true, cli, file: model };
    if (TRANSCRIBE === 'whisper') { log(`speech to text: whisper.cpp isn't set up (${cli ? 'no model found; set WHISPER_MODEL' : 'whisper-cli not found; set WHISPER_CLI'})`); return null; }
  }
  // A key left as the example's placeholder (your-openai-api-key) counts as none.
  const key = [process.env.TRANSCRIBE_API_KEY, process.env.OPENAI_API_KEY].find((k) => k && !/^(your|<|xxx|placeholder|changeme)/i.test(k));
  if (!key) { if (TRANSCRIBE === 'cloud') log('speech to text: no TRANSCRIBE_API_KEY or OPENAI_API_KEY'); return null; }
  const url = process.env.TRANSCRIBE_URL || 'https://api.openai.com/v1/audio/transcriptions';
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const name = /openai/.test(host) ? 'OpenAI' : /groq/.test(host) ? 'Groq' : host;
  return { kind: 'cloud', name, model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe', local: false, url, key };
}
let TRANSCRIBER = null; // set once the log is ready, at listen
const shownTranscriber = () => TRANSCRIBER && { name: TRANSCRIBER.name, model: TRANSCRIBER.model, local: TRANSCRIBER.local };
// What whisper writes for silence or noise ([BLANK_AUDIO], (music)) is dropped.
const cleanText = (t) => String(t || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

function transcribeWhisper(wav, lang, signal) {
  const file = path.join(cliWorkDir, `speech-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  writeFileSync(file, wav);
  return new Promise((resolve, reject) => {
    const child = spawn(TRANSCRIBER.cli, ['-m', TRANSCRIBER.file, '-f', file, '-l', lang || 'auto', '-nt', '-np'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); try { unlinkSync(file); } catch { /* gone */ } };
    child.on('error', (e) => { done(); reject(e); });
    child.on('close', (code) => { done(); if (code === 0) resolve(out); else reject(new Error(err.trim().split('\n').pop() || `whisper-cli exited with code ${code}`)); });
  });
}
async function transcribeCloud(wav, lang, signal) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', TRANSCRIBER.model);
  if (lang) form.append('language', lang);
  const res = await fetch(TRANSCRIBER.url, { method: 'POST', headers: { authorization: `Bearer ${TRANSCRIBER.key}` }, body: form, signal });
  const body = await res.text();
  if (!res.ok) throw new Error(`${TRANSCRIBER.name} answered ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body).text;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  // Never serve dotfiles (.env, .dev.vars, .git) or server-side folders.
  if (rel.split('/').some((p) => p.startsWith('.')) || /\/node_modules\//.test(rel)) { res.writeHead(404); return res.end('Not found'); }
  let file = path.join(SERVE_ROOT, rel);
  if (!file.startsWith(SERVE_ROOT)) { res.writeHead(403); return res.end(); }
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

function readBody(req, limit = 200_000, raw = false) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); resolve(raw ? b : b.toString('utf8')); });
    req.on('error', reject);
  });
}

// ---------- focus: bringing the talking tab to the front ----------
// A page can't bring its own tab or window to the front, so on a Mac the bridge does it with JavaScript for Automation
// (osascript): the tab becomes its window's active tab, the window comes in front of the browser's others, and the
// browser in front of other apps. The page sends its browser's app name, its URL and a mark of zero-width characters
// it adds to its title for the moment, which tells apart two tabs on the same page; without the mark found, a tab whose
// URL matches is used only when it's the only one. The first time, macOS asks whether the app that started the bridge
// (Terminal, say) may control the browser (System Settings > Privacy & Security > Automation). FOCUS=false turns it off.
const FOCUS = process.platform === 'darwin' && (process.env.FOCUS || 'true').toLowerCase() !== 'false';
const FOCUS_APPS = ['Brave Browser', 'Google Chrome', 'Microsoft Edge', 'Chromium', 'Safari'];
const FOCUS_JXA = `function run(argv) {
  const [name, url, mark] = argv;
  const app = Application(name);
  if (!app.running()) return 'not running';
  const safari = name === 'Safari';
  let hit = null, byUrl = [];
  for (const w of app.windows()) {
    let titles, urls;
    try { titles = safari ? w.tabs.name() : w.tabs.title(); urls = w.tabs.url(); } catch (e) { continue; }
    for (let i = 0; i < urls.length; i++) {
      if (mark && String(titles[i] || '').includes(mark)) { hit = { w, i }; break; }
      if (urls[i] === url) byUrl.push({ w, i });
    }
    if (hit) break;
  }
  if (!hit && byUrl.length === 1) hit = byUrl[0];
  if (!hit) return byUrl.length ? 'more than one tab with this URL' : 'no such tab';
  if (safari) hit.w.currentTab = hit.w.tabs[hit.i]; else hit.w.activeTabIndex = hit.i + 1;
  try { if (safari ? hit.w.miniaturized() : hit.w.minimized()) { if (safari) hit.w.miniaturized = false; else hit.w.minimized = false; } } catch (e) { /* not reported */ }
  hit.w.index = 1;
  app.activate();
  return 'ok';
}`;
function focusTab(app, url, mark) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', FOCUS_JXA, app, url, mark], { timeout: 5000 }, (err, out, errOut) => {
      if (err) return resolve(/-1743|not allowed|Not authorized/i.test(String(errOut) + err.message)
        ? `not allowed to control ${app} (System Settings > Privacy & Security > Automation)` : String(errOut || err.message).trim().split('\n').pop());
      resolve(String(out).trim());
    });
  });
}

// ---------- tabs: which browser tabs use the bridge ----------
// Each page with the widget reports itself every 15 seconds (POST .../presence, sent as text/plain so it needs no
// preflight): its tab id, URL, title, browser, state and microphone. GET .../tabs lists them for the localhost page
// (desktop/localhost.mjs), with recent questions and recordings from pages that don't report themselves, such as a tab
// still running an older copy of the widget. POST .../tabs/stop { id } turns the widget off in that tab at its next report.
const TAB_SEEN_MS = 45000, OTHER_SEEN_MS = 10 * 60 * 1000;
const tabs = new Map(), stopTabs = new Set(), others = new Map();
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
function browserOf(req) {
  const brands = String(req.headers['sec-ch-ua'] || ''), ua = String(req.headers['user-agent'] || '');
  if (/Brave/.test(brands)) return 'Brave';
  if (/Microsoft Edge/.test(brands) || /Edg\//.test(ua)) return 'Edge';
  if (/Google Chrome/.test(brands)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Version\/[\d.]+ Safari\//.test(ua)) return 'Safari';
  return /Chrom/.test(brands + ua) ? 'Chromium' : 'Other';
}
function noteRequest(req, kind, page, tab) {
  if (tab && tabs.has(tab)) { tabs.get(tab).lastUse = Date.now(); return; }
  if (!req.headers.origin) return;
  const browser = browserOf(req), key = `${req.headers.origin} ${browser}`;
  const o = others.get(key) || { origin: req.headers.origin, browser, count: 0, first: Date.now() };
  Object.assign(o, { last: Date.now(), kind, page: page || o.page || '' });
  o.count++;
  others.set(key, o);
}
function listTabs() {
  const now = Date.now();
  for (const [id, t] of tabs) if (now - t.last > TAB_SEEN_MS) { tabs.delete(id); stopTabs.delete(id); }
  for (const [key, o] of others) if (now - o.last > OTHER_SEEN_MS) others.delete(key);
  return { now, tabs: [...tabs.values()], unreported: [...others.values()] };
}

// ---------- voices: text to speech for the widget ----------
// GET .../voices lists the sources (shared/tts/index.js) and their voices; ?own=xai,elevenlabs names the /keys page
// keys the visitor has, so sources needing one list their voices too. POST .../speak { source, voice, text, lang }
// returns one sentence's audio, with word timings in x-voice-words when the source gives them. Kokoro runs here, from
// server/kokoro/ (its own npm packages, so the bridge needs none): imported only once it's installed and asked for.
const KOKORO_DIR = path.join(HERE, 'kokoro');
// KOKORO=false leaves it out even when installed, so pages offer Kokoro in the browser instead (js/voice-kokoro.js).
const kokoroInstalled = () => (process.env.KOKORO || '').toLowerCase() !== 'false' && existsSync(path.join(KOKORO_DIR, 'node_modules', 'kokoro-js'));
let kokoroModule = null;
const loadKokoro = () => (kokoroModule ||= import('./kokoro/kokoro.mjs').catch((err) => { kokoroModule = null; throw err; }));
const TTS_EXTRA = { kokoro: { label: 'Kokoro', name: 'Kokoro (on this computer)', local: true, available: kokoroInstalled, load: loadKokoro } };
const ttsEnv = process.env;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://x');

  if (url.pathname === API_PATH || ['/health', '/status', '/transcribe', '/focus', '/presence', '/tabs', '/tabs/stop', '/voices', '/speak'].some((p) => url.pathname === API_PATH + p)) {
    if (!originAllowed(origin)) { res.writeHead(403); return res.end('Origin not allowed'); }
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    const reply = (code, obj) => { res.writeHead(code, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type, x-team-passphrase, x-provider-name, x-provider-key', 'access-control-expose-headers': 'x-voice-words, x-voice-source', 'access-control-max-age': '600' });
      return res.end();
    }
    if (url.pathname.endsWith('/health')) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, backend: BACKEND, model: MODEL }));
    }
    if (url.pathname.endsWith('/tabs') && req.method === 'GET') return reply(200, listTabs());
    if (url.pathname.endsWith('/voices') && req.method === 'GET') {
      const ownNames = (url.searchParams.get('own') || '').split(',').map((s) => s.trim()).filter(Boolean);
      // A page asking is likely to speak soon, so Kokoro's model starts loading now (about 12 seconds the first time).
      if (kokoroInstalled() && url.searchParams.get('warm') === 'kokoro') loadKokoro().then((m) => m.warm()).catch((err) => log(`kokoro: ${err.message}`));
      return reply(200, { sources: await listVoices(ttsEnv, { extra: TTS_EXTRA, ownNames }), defaultSource: kokoroInstalled() ? 'kokoro' : 'browser',
        ...(!kokoroInstalled() && { install: 'npm install --prefix engine/server/kokoro' }) });
    }
    if (url.pathname.endsWith('/speak') && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await readBody(req, 8000)); } catch { b = null; }
      if (!b || typeof b.source !== 'string' || typeof b.text !== 'string') return reply(400, { error: 'Bad request' });
      const own = { name: String(req.headers['x-provider-name'] || '').trim(), key: String(req.headers['x-provider-key'] || '').trim() };
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const started = Date.now();
      try {
        const out = await speakText(ttsEnv, { source: b.source, voice: String(b.voice || ''), text: b.text, lang: String(b.lang || ''), own: own.key ? own : null, signal: ac.signal, extra: TTS_EXTRA });
        if (b.source === 'kokoro' && Date.now() - started > 5000) log(`kokoro: ${Date.now() - started} ms (the first sentence loads the model)`);
        res.writeHead(200, { ...cors, 'content-type': out.type, 'content-length': out.audio.length, 'cache-control': 'no-store', 'x-voice-source': b.source, 'access-control-expose-headers': 'x-voice-words, x-voice-source',
          ...(out.words && { 'x-voice-words': JSON.stringify(out.words) }) });
        return res.end(Buffer.from(out.audio.buffer, out.audio.byteOffset, out.audio.length));
      } catch (err) {
        if (!ac.signal.aborted) log(`speak (${b.source}): ${err.message}`);
        return reply(err.status || 502, { error: err.message, ...(err.needsKey && { needsKey: true }) });
      }
    }
    if (url.pathname.endsWith('/presence') && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await readBody(req, 8000)); } catch { b = null; }
      if (!b || typeof b.id !== 'string' || !/^[a-z0-9]{4,20}$/.test(b.id)) return reply(400, { ok: false, error: 'Bad request' });
      if (b.gone) { tabs.delete(b.id); stopTabs.delete(b.id); return reply(200, { ok: true }); }
      const prev = tabs.get(b.id);
      tabs.set(b.id, {
        id: b.id, url: clip(b.url, 500), title: clip(b.title, 200), browser: clip(b.browser, 40) || browserOf(req), app: clip(b.app, 40),
        mic: clip(b.mic, 120), state: clip(b.state, 20), paused: !!b.paused, hidden: !!b.hidden, automated: !!b.automated,
        first: prev ? prev.first : Date.now(), last: Date.now(), lastUse: prev ? prev.lastUse : 0,
      });
      return reply(200, { ok: true, stop: stopTabs.delete(b.id) });
    }
    if (url.pathname.endsWith('/tabs/stop') && req.method === 'POST') {
      let b;
      try { b = JSON.parse(await readBody(req, 2000)); } catch { b = null; }
      if (!b || !tabs.has(b.id)) return reply(404, { ok: false, error: 'No such tab. It may have closed.' });
      stopTabs.add(b.id);
      return reply(200, { ok: true });
    }
    // What's answering, what's running now (each until its process has exited) and how the last request went.
    if (url.pathname.endsWith('/status')) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
      const now = Date.now();
      return res.end(JSON.stringify({ agent: AGENT, running: [...running.values()].map((r) => ({ ...r, seconds: Math.round((now - r.started) / 1000) })), last: lastRun, transcribe: shownTranscriber(), focus: FOCUS }));
    }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }

    // Bringing the page's tab to the front: { app, url, mark } in, { ok } or { ok: false, error } out.
    if (url.pathname.endsWith('/focus')) {
      const reply = (code, obj) => { res.writeHead(code, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
      if (!FOCUS) return reply(501, { ok: false, error: process.platform === 'darwin' ? 'Turned off (FOCUS=false).' : 'Only on a Mac.' });
      let b;
      try { b = JSON.parse(await readBody(req, 4000)); } catch { b = null; }
      if (!b || !FOCUS_APPS.includes(b.app) || typeof b.url !== 'string' || !/^https?:\/\//.test(b.url) || (b.mark && !/^[\u200b\u200c\u200d\u2060]{6,32}$/.test(b.mark))) return reply(400, { ok: false, error: 'Bad request' });
      const out = await focusTab(b.app, b.url, b.mark || '');
      if (out !== 'ok') log(`focus: ${out} (${b.app})`);
      return reply(200, out === 'ok' ? { ok: true } : { ok: false, error: out });
    }

    // Speech to text: a WAV in, { text } out (or { error }). ?lang= is the page's language (en-US), sent as its first part.
    if (url.pathname.endsWith('/transcribe')) {
      const reply = (code, obj) => { res.writeHead(code, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
      if (!TRANSCRIBER) return reply(501, { error: 'No speech to text is set up on the bridge (TRANSCRIBE in server/local-bridge.mjs).' });
      let wav;
      try { wav = await readBody(req, 8_000_000, true); } catch { return reply(413, { error: 'The recording is too long.' }); }
      if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return reply(400, { error: 'Expected a WAV recording.' });
      const lang = (url.searchParams.get('lang') || '').split('-')[0].toLowerCase().replace(/[^a-z]/g, '');
      noteRequest(req, 'speech to text', '', url.searchParams.get('tab'));
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const started = Date.now();
      try {
        const text = cleanText(await (TRANSCRIBER.kind === 'whisper' ? transcribeWhisper : transcribeCloud)(wav, lang, ac.signal));
        log(`transcribed ${(wav.length / 32000).toFixed(1)}s of speech via ${TRANSCRIBER.name} in ${Date.now() - started} ms`);
        return reply(200, { text, via: TRANSCRIBER.name });
      } catch (err) {
        log(`speech to text error: ${err.message}`);
        return reply(502, { error: err.message });
      }
    }

    let messages, output, page, tab, voice;
    try { ({ messages, output, page, tab, voice } = JSON.parse(await readBody(req))); messages = sanitizeMessages(messages); } catch { messages = null; }
    if (!messages) { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"error":"Bad request"}'); }
    noteRequest(req, 'question', typeof page === 'string' ? page.slice(0, 300) : '', tab);

    res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
    const started = Date.now();
    const run = { id: ++runCount, started, pid: null, activity: 'thinking', tools: 0 };
    let usage = null, outcome = 'done';
    running.set(run.id, run);
    send({ t: 'agent', v: AGENT });
    const onInfo = (info) => {
      if (info.pid) run.pid = info.pid;
      if (info.tool) { run.tools++; run.activity = `${info.tool.name} ${info.tool.target}`.trim(); send({ t: 'tool', v: info.tool }); }
      if (info.usage) { usage = info.usage; send({ t: 'usage', v: usage }); }
      if (info.thinking) send({ t: 'thinking', v: info.thinking });
    };
    try {
      await (BACKEND === 'api' ? askApi : askCli)(messages, systemPrompt(output, page, voice), (text) => send({ t: 'text', v: text }), ac.signal, output, onInfo, page);
      if (ac.signal.aborted) outcome = 'stopped';
      send({ t: 'done' });
      log(`${outcome === 'stopped' ? 'stopped' : 'answered'} via ${BACKEND} in ${Date.now() - started} ms`);
    } catch (err) {
      outcome = ac.signal.aborted ? 'stopped' : 'error';
      if (!ac.signal.aborted) { send({ t: 'error', v: err.message }); log(`error: ${err.message}`); }
    } finally {
      // Only now, once the CLI process has exited (askCli resolves on its exit), is the request no longer running.
      running.delete(run.id);
      lastRun = { id: run.id, outcome, ms: Date.now() - started, tools: run.tools, usage, ended: Date.now() };
    }
    return res.end();
  }

  if (SERVE_ROOT && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(req, res);
  res.writeHead(404); res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[voice-chat] Port ${PORT} is busy. Is the bridge already running? Set BRIDGE_PORT (and data-bridge-port on the script tag) to use another.`);
  else console.error('[voice-chat]', err.message);
  process.exit(1);
});

function log(msg) { console.log(`[voice-chat] ${new Date().toLocaleTimeString()} ${msg}`); }

server.listen(PORT, HOST, () => {
  log(`bridge on http://localhost:${PORT}${API_PATH}  backend=${BACKEND}  model=${MODEL}`);
  log(envLoaded ? `env: ${envFile}` : envFile ? `env: no .env at ${envFile} (using process environment)`
    : 'env: none named (automation/paths.yaml env_file: or VOICE_CHAT_ENV), using process environment');
  const envDir = envLoaded ? path.dirname(path.resolve(envFile)) : '';
  if (envLoaded && (envDir === ROOT || envDir === path.resolve(ROOT, '..') || (SERVE_ROOT && envDir.startsWith(SERVE_ROOT)))) {
    log('WARNING: this .env sits inside your webroot. Other static servers or "wrangler deploy" could publish it.');
    log('         Move it above the webroot, or add the .assetsignore from assetsignore.example.');
  }
  if (SERVE_ROOT) log(`serving ${SERVE_ROOT} at http://localhost:${PORT}/`);
  if (BACKEND === 'cli') log(`CLI: ${CLI} (run "claude" once and log in if you have not)`);
  if (BACKEND === 'cli') log(READ_FILES ? `CLI files: reads ${WEBROOT}, read-only (CLI_READ_FILES=false to turn off)` : 'CLI files: none');
  log(FOCUS ? `focus: brings the talking tab to the front (${API_PATH}/focus; FOCUS=false to turn off)` : 'focus: off');
  log(kokoroInstalled() ? `voices: Kokoro on this computer (${API_PATH}/voices and /speak; the model loads with the first sentence)`
    : 'voices: Kokoro isn\'t installed, so pages use browser voices by default (npm install --prefix engine/server/kokoro)');
  TRANSCRIBER = pickTranscriber();
  log(TRANSCRIBER ? `speech to text: ${TRANSCRIBER.name} (${TRANSCRIBER.model}) at ${API_PATH}/transcribe`
    : 'speech to text: none, so browsers without their own speech input type instead (see TRANSCRIBE in this file)');
});
