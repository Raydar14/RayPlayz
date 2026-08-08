// Session cookie + password verification for the private dashboard.
// Session token format: "<base64url(json payload)>.<base64url(hmac-sha256 sig)>"
// Payload: { iat: <ms>, exp: <ms> }
// Signed with env.SESSION_SECRET. Cookie is HttpOnly, Secure, SameSite=Lax.

const COOKIE_NAME = 'rp_session';
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const t = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4));
  const raw = atob(t + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signSession(payload, secret) {
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(p));
  return `${p}.${b64urlEncode(sig)}`;
}

async function verifySession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const p = token.slice(0, dot);
  const s = token.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(s), enc.encode(p));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(p)));
    if (typeof payload?.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const h = req.headers.get('cookie');
  if (!h) return null;
  for (const part of h.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

// Constant-time string equality using per-call ephemeral HMAC hashes.
// A fresh random key each call means length + timing don't leak.
async function constantTimeEquals(a, b) {
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  const ua = new Uint8Array(ha), ub = new Uint8Array(hb);
  if (ua.length !== ub.length) return false;
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

export async function currentSession(req, env) {
  if (!env.SESSION_SECRET) return null;
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  return verifySession(token, env.SESSION_SECRET);
}

export async function issueSessionCookie(env) {
  const hours = Math.max(1, Number(env.SESSION_MAX_AGE_HOURS || 168));
  const now = Date.now();
  const exp = now + hours * 3600 * 1000;
  const token = await signSession({ iat: now, exp }, env.SESSION_SECRET);
  const maxAge = Math.floor((exp - now) / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function verifyPassword(submitted, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  if (typeof submitted !== 'string' || submitted.length === 0 || submitted.length > 512) return false;
  return await constantTimeEquals(submitted, env.DASHBOARD_PASSWORD);
}
