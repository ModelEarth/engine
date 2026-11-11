// The team's passphrase (TEAM_PASSPHRASE): routes that spend the site's own API keys ask for it, so only people
// given it use them. claude-voice.js asks for it once and trades it at PASSPHRASE_PATH for a cookie that page
// scripts can't read (HttpOnly), signed with TEAM_SESSION_SECRET or BETTER_AUTH_SECRET. The passphrase itself
// isn't kept in the browser, so injected code or an extension can't copy it. Clients that can't keep the cookie,
// such as a script on another site or the local bridge, send it in the x-team-passphrase header instead.

export const PASSPHRASE_HEADER = 'x-team-passphrase';
export const PASSPHRASE_PATH = '/api/team-passphrase';
// Where older versions of claude-voice.js kept the passphrase in plain text; it reads and removes it once.
export const PASSPHRASE_STORAGE_KEY = 'team-passphrase';
const COOKIE = 'team_pass';
const COOKIE_DAYS = 30;
// Nothing limits how often a passphrase can be guessed, so a shorter one is refused.
const MIN_PASSPHRASE_LENGTH = 12;

const encoder = new TextEncoder();
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
// Compared by hash, in constant time.
async function sameText(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const configuredPassphrase = (env) => String(env.TEAM_PASSPHRASE || '').trim();
const cookieSecret = (env) => String(env.TEAM_SESSION_SECRET || env.BETTER_AUTH_SECRET || '').trim();

// The cookie's value: its expiry time and a signature over it and the passphrase, so changing TEAM_PASSPHRASE
// signs everyone out.
async function signature(env, expires) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(cookieSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`team-passphrase|${expires}|${configuredPassphrase(env)}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function validCookie(request, env) {
  if (!cookieSecret(env)) return false;
  const match = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;
  const [expires, mac] = match[1].split('.');
  if (!(Number(expires) > Date.now() / 1000) || !mac) return false;
  return sameText(mac, await signature(env, expires));
}

// The cookie is sent with any request to this site, including one another site's page makes, so it only counts
// on a request from this site's own pages or an origin in ALLOWED_ORIGINS.
function fromTrustedPage(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
}

// null when the request may go ahead, otherwise { status, error, passphrase? } to reply with:
//   503  the secret isn't set (or is too short) and `required`, so the route is off
//   401  the passphrase is missing or wrong; passphrase: true tells the page to ask for it
// Without `required`, a site with no TEAM_PASSPHRASE lets every request through.
export async function passphraseRefusal(request, env, { required = false, to = 'use this' } = {}) {
  const configured = configuredPassphrase(env);
  if (!configured && !required) return null;
  if (configured.length < MIN_PASSPHRASE_LENGTH) {
    return { status: 503, error: `This is off on this site until its TEAM_PASSPHRASE secret is set, with ${MIN_PASSPHRASE_LENGTH} or more characters.` };
  }
  const given = String(request.headers.get(PASSPHRASE_HEADER) || '').trim();
  if (given && (await sameText(given, configured))) return null;
  if (!given && fromTrustedPage(request, env) && (await validCookie(request, env))) return null;
  return { status: 401, error: given ? 'That passphrase doesn’t match.' : `Enter the team passphrase to ${to}.`, passphrase: true };
}

// POST PASSPHRASE_PATH { passphrase }: 204 with the cookie when it matches, else as passphraseRefusal.
// DELETE PASSPHRASE_PATH: clears the cookie.
export async function handleTeamPassphrase(request, env) {
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
  if (request.method === 'DELETE') return new Response(null, { status: 204, headers: { 'set-cookie': cookie('', 0) } });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  if (!fromTrustedPage(request, env)) return Response.json({ error: 'Origin not allowed' }, { status: 403 });
  if (!cookieSecret(env)) return Response.json({ error: 'TEAM_SESSION_SECRET or BETTER_AUTH_SECRET isn’t set, so the passphrase can’t be remembered.' }, { status: 503 });
  const { passphrase = '' } = await request.json().catch(() => ({}));
  const probe = new Request(request.url, { headers: { [PASSPHRASE_HEADER]: String(passphrase) } });
  const refusal = await passphraseRefusal(probe, env, { required: true });
  if (refusal) return Response.json({ error: refusal.error, passphrase: refusal.passphrase }, { status: refusal.status });
  const expires = Math.floor(Date.now() / 1000) + COOKIE_DAYS * 86400;
  return new Response(null, { status: 204, headers: { 'set-cookie': cookie(`${expires}.${await signature(env, expires)}`, COOKIE_DAYS * 86400) } });
}
