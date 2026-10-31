#!/usr/bin/env node
// Local bridge for claude-voice.js — run on your machine while developing on localhost.
//
//   node server/local-bridge.mjs                 # API endpoint only (http://localhost:8790/api/claude-voice)
//   node server/local-bridge.mjs --serve ../     # also serve your webroot at http://localhost:8790/
//
// LOCAL_BACKEND=cli (default) answers through the Claude Code CLI using your logged-in Claude account. It can read the
//   webroot's files (this submodule's parent folder) to answer questions about the site, but not change them or read anything
//   outside it. CLI_READ_FILES=false answers without files.
// LOCAL_BACKEND=api answers through the Claude API with ANTHROPIC_API_KEY from .env.
// No npm dependencies; needs Node 18+.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync, createReadStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, sanitizeMessages, systemPrompt, transcriptPrompt } from '../shared/voice-prompt.js';
import { streamClaude } from '../shared/anthropic.js';

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
// $CLAUDE_VOICE_ENV, else ../../safe/cloudroot.env (relative to this submodule, as in automation/paths.yaml).
const envFile = process.env.CLAUDE_VOICE_ENV || path.resolve(ROOT, '..', '..', 'safe', 'cloudroot.env');
const envLoaded = loadEnv(envFile);

const args = process.argv.slice(2);
const serveIdx = args.indexOf('--serve');
const SERVE_ROOT = serveIdx >= 0 ? path.resolve(args[serveIdx + 1] || '.') : (process.env.BRIDGE_SERVE_ROOT ? path.resolve(process.env.BRIDGE_SERVE_ROOT) : null);

const PORT = Number(process.env.BRIDGE_PORT || 8790);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const MODEL = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
const BACKEND = (process.env.LOCAL_BACKEND || 'cli').toLowerCase();
const CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS || 120000);
const API_PATH = '/api/claude-voice';

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
const cliWorkDir = mkdtempSync(path.join(tmpdir(), 'claude-voice-')); // empty dir: no CLAUDE.md, no project files

// File access for the CLI: the webroot (this submodule's parent folder), read-only.
// - Only the Read, Glob and Grep tools exist in its sessions, so nothing can be written, edited or run.
// - The only path allowed is inside the webroot. Links are checked by where they lead, so one pointing outside is refused.
// - dontAsk refuses whatever isn't allowed, with no prompt, and settings files (yours, the project's) aren't loaded, so
//   none of their allow rules widen this. Env and key files are denied even inside the webroot (Grep skips hidden files too).
const WEBROOT = path.resolve(ROOT, '..');
const READ_FILES = process.env.CLI_READ_FILES !== 'false';
const SECRET_FILES = ['**/.env', '**/.env.*', '**/.envrc', '**/.dev.vars', '**/*.pem', '**/*.key'];
const CLI_SETTINGS = JSON.stringify({ permissions: { allow: [`Read(/${WEBROOT}/**)`], deny: SECRET_FILES.map((p) => `Read(${p})`) } });
// quiet: the page hides its conversation text (Text Output in claude-voice.js), so Claude looks first and says only the answer.
const filesPrompt = (quiet) => `

Files: you're running on the developer's own computer, in the folder holding this website's source files (${WEBROOT}).
When a question is about this site, its pages, code, data or documentation, look at its files with Read, Glob and Grep, then answer from what you found.
- You can only read. Files can't be changed, and nothing outside that folder is open to you. If a look is refused, say so briefly.
- Never read or repeat secrets: env files, keys, tokens or passwords.
${quiet
    ? '- Look before you say anything, then give just the answer.'
    : '- Before your first look, say in a few words what you\'re checking, so the person hears from you while you look. Then carry on once you\'ve looked.'}
- Everything you write, before and after looking, is one spoken reply: the mood header only once, at the very start, and the summary only once, at the very end.
- Tell what you found as you would in conversation: name files and folders plainly, without spelling out paths or reading code aloud.`;

// The agent answering, as the settings panel's Agent section names it (also sent with each reply and from /status).
const AGENT = BACKEND === 'api'
  ? { name: 'Claude API', detail: 'API key from the env file', model: MODEL }
  : { name: 'Claude Code CLI', detail: process.env.CLI_USE_API_KEY === 'true' ? 'API key from the env file' : 'your Claude login', model: MODEL,
      files: READ_FILES ? `${path.basename(WEBROOT)} (read-only)` : null };

// Requests being answered now (until their CLI process has exited) and how the last one went, for GET .../status.
const running = new Map();
let lastRun = null, runCount = 0;
const inWebroot = (p) => (p && path.isAbsolute(p) && p.startsWith(WEBROOT + path.sep) ? path.relative(WEBROOT, p) : p);

// onInfo gets { pid }, { tool: { name, target } } and { usage: {...} } as they happen.
function askCli(messages, system, onText, signal, output, onInfo = () => {}) {
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
      '--system-prompt', READ_FILES ? system + filesPrompt(output?.conversation === false) : system,
      ...access,
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ], { cwd: READ_FILES ? WEBROOT : cliWorkDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    onInfo({ pid: child.pid });

    let streamed = false, newMessage = false;
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
        } else if (evt.type === 'assistant') {
          for (const block of evt.message?.content || []) {
            if (block.type === 'tool_use') onInfo({ tool: { name: block.name, target: inWebroot(block.input?.file_path || block.input?.path || '') || block.input?.pattern || '' } });
            // Older CLIs without partial messages: emit whole assistant text blocks.
            else if (block.type === 'text' && !streamed) finalText += block.text;
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
  return streamClaude({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL, system, messages, signal, onText, onUsage: (usage) => onInfo({ usage }) });
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

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://x');

  if (url.pathname === API_PATH || url.pathname === API_PATH + '/health' || url.pathname === API_PATH + '/status') {
    if (!originAllowed(origin)) { res.writeHead(403); return res.end('Origin not allowed'); }
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
      return res.end();
    }
    if (url.pathname.endsWith('/health')) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, backend: BACKEND, model: MODEL }));
    }
    // What's answering, what's running now (each until its process has exited) and how the last request went.
    if (url.pathname.endsWith('/status')) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
      const now = Date.now();
      return res.end(JSON.stringify({ agent: AGENT, running: [...running.values()].map((r) => ({ ...r, seconds: Math.round((now - r.started) / 1000) })), last: lastRun }));
    }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }

    let messages, output;
    try { ({ messages, output } = JSON.parse(await readBody(req))); messages = sanitizeMessages(messages); } catch { messages = null; }
    if (!messages) { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"error":"Bad request"}'); }

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
    };
    try {
      await (BACKEND === 'api' ? askApi : askCli)(messages, systemPrompt(output), (text) => send({ t: 'text', v: text }), ac.signal, output, onInfo);
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
  if (err.code === 'EADDRINUSE') console.error(`[claude-voice] Port ${PORT} is busy. Is the bridge already running? Set BRIDGE_PORT (and data-bridge-port on the script tag) to use another.`);
  else console.error('[claude-voice]', err.message);
  process.exit(1);
});

function log(msg) { console.log(`[claude-voice] ${new Date().toLocaleTimeString()} ${msg}`); }

server.listen(PORT, HOST, () => {
  log(`bridge on http://localhost:${PORT}${API_PATH}  backend=${BACKEND}  model=${MODEL}`);
  log(envLoaded ? `env: ${envFile}` : `env: no .env at ${envFile} (using process environment)`);
  const envDir = path.dirname(path.resolve(envFile));
  if (envLoaded && (envDir === ROOT || envDir === path.resolve(ROOT, '..') || (SERVE_ROOT && envDir.startsWith(SERVE_ROOT)))) {
    log('WARNING: this .env sits inside your webroot. Other static servers or "wrangler deploy" could publish it.');
    log('         Move it above the webroot, or add the .assetsignore from assetsignore.example.');
  }
  if (SERVE_ROOT) log(`serving ${SERVE_ROOT} at http://localhost:${PORT}/`);
  if (BACKEND === 'cli') log(`CLI: ${CLI} (run "claude" once and log in if you have not)`);
  if (BACKEND === 'cli') log(READ_FILES ? `CLI files: reads ${WEBROOT}, read-only (CLI_READ_FILES=false to turn off)` : 'CLI files: none');
});
