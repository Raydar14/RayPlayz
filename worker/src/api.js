// API surface for the private dashboard.
// Phase 1 only implements auth endpoints; Phase 2 adds contact/thread/message routes.

import {
  verifyPassword,
  issueSessionCookie,
  clearSessionCookie,
  currentSession,
} from './auth.js';

function json(data, init = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) };
  return new Response(JSON.stringify(data), { ...init, headers });
}

function methodNotAllowed(allow) {
  return new Response('method not allowed', {
    status: 405,
    headers: { allow },
  });
}

async function requireSession(req, env) {
  const s = await currentSession(req, env);
  if (!s) return null;
  return s;
}

export async function handleApi(req, env, url) {
  const path = url.pathname;

  if (path === '/api/login') {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad_request' }, { status: 400 }); }
    const ok = await verifyPassword(body?.password, env);
    if (!ok) {
      // Small artificial delay blunts scripted brute-force. Not a substitute
      // for a strong password — the password is the primary defense.
      await new Promise(r => setTimeout(r, 300));
      return json({ error: 'invalid_password' }, { status: 401 });
    }
    const cookie = await issueSessionCookie(env);
    return json({ ok: true }, { headers: { 'set-cookie': cookie } });
  }

  if (path === '/api/logout') {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
  }

  if (path === '/api/me') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    const s = await currentSession(req, env);
    return json({
      authed: !!s,
      session: s ? { issued: s.iat, expires: s.exp } : null,
    });
  }

  // ---- Phase 2 endpoints will attach below; every one calls requireSession first ----
  //
  // GET  /api/contacts
  // POST /api/contacts
  // GET  /api/contacts/:id
  // POST /api/contacts/:id/messages
  // POST /api/messages/ingest        (browser extension pushes here)
  // POST /api/drafts                 (AI reply drafting)
  // ...
  //
  // Left intentionally empty in Phase 1.

  return json({ error: 'not_found' }, { status: 404 });
}

// Re-exported so worker.js doesn't need to import auth directly for its gating.
export { requireSession };
