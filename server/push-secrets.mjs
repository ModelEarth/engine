#!/usr/bin/env node
// Copies the production keys from .env into Cloudflare Worker secrets.
// Run from the folder that holds your wrangler config:
//
//   node public/engine/server/push-secrets.mjs [path/to/.env]
//
// Only the keys the Worker needs are pushed; local-only settings stay local.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CLAUDE_MODEL is a plain var in wrangler.jsonc, so it is not pushed as a secret.
const PUSH = ['ANTHROPIC_API_KEY', 'ALLOWED_ORIGINS'];

// The env file: the first argument, else $VOICE_CHAT_ENV, else the one env_file: names in automation/paths.yaml, in
// the webroot above this submodule (relative to that automation folder), as the site's other scripts use it.
function pathsYamlEnv(webroot) {
  const yaml = path.join(webroot, 'automation', 'paths.yaml');
  if (!existsSync(yaml)) return null;
  const m = readFileSync(yaml, 'utf8').match(/^env_file:\s*["']?([^"'#\n]+?)["']?\s*(#.*)?$/m);
  return m ? path.resolve(webroot, 'automation', m[1].trim()) : null;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [process.argv[2], process.env.VOICE_CHAT_ENV, pathsYamlEnv(path.resolve(here, '..', '..'))].filter(Boolean);
const envFile = candidates.find((f) => existsSync(f));
if (!envFile) { console.error('No .env found. Pass its path as the first argument, or name it in automation/paths.yaml (env_file:).'); process.exit(1); }

const vars = {};
for (const raw of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  else v = v.replace(/\s+#.*$/, '');
  vars[m[1]] = v;
}

console.log(`Reading ${envFile}`);
let pushed = 0;
for (const key of PUSH) {
  if (!vars[key]) continue;
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', key], { input: vars[key], stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`Failed to set ${key}`); process.exit(r.status || 1); }
  pushed++;
}
if (!vars.ANTHROPIC_API_KEY) console.warn('Warning: ANTHROPIC_API_KEY is empty in .env; the Worker needs it.');
console.log(`Done: ${pushed} secret(s) set.`);
