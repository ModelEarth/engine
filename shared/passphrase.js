// The team's passphrase (TEAM_PASSPHRASE): routes that spend the site's own API keys ask for it, so only people
// given it use them. claude-voice.js sends it in the x-team-passphrase header after asking once, and keeps it in
// localStorage ("team-passphrase"), so other pages on the site can send it too.

export const PASSPHRASE_HEADER = 'x-team-passphrase';
export const PASSPHRASE_STORAGE_KEY = 'team-passphrase';
// Nothing limits how often a passphrase can be guessed, so a shorter one is refused.
const MIN_PASSPHRASE_LENGTH = 12;

const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
// Compared by hash, in constant time.
async function sameText(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// null when the request may go ahead, otherwise { status, error, passphrase? } to reply with:
//   503  the secret isn't set (or is too short) and `required`, so the route is off
//   401  the passphrase is missing or wrong; passphrase: true tells the page to ask for it
// Without `required`, a site with no TEAM_PASSPHRASE lets every request through.
export async function passphraseRefusal(request, env, { required = false, to = 'use this' } = {}) {
  const configured = String(env.TEAM_PASSPHRASE || '').trim();
  if (!configured && !required) return null;
  if (configured.length < MIN_PASSPHRASE_LENGTH) {
    return { status: 503, error: `This is off on this site until its TEAM_PASSPHRASE secret is set, with ${MIN_PASSPHRASE_LENGTH} or more characters.` };
  }
  const given = String(request.headers.get(PASSPHRASE_HEADER) || '').trim();
  if (given && (await sameText(given, configured))) return null;
  return { status: 401, error: given ? 'That passphrase doesn’t match.' : `Enter the team passphrase to ${to}.`, passphrase: true };
}
