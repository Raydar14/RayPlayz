// API surface for the private dashboard.
//
// All endpoints below require a valid session cookie (checked via
// currentSession → requireSession). Auth endpoints (/api/login,
// /api/logout, /api/me) are public.
//
// Route table style: routes are matched by (method, pattern) where
// pattern supports :param segments. Handlers receive (req, env, url, params).

import {
  verifyPassword,
  issueSessionCookie,
  clearSessionCookie,
  currentSession,
} from './auth.js';
import { ensureSchema } from './db.js';
import { callClaude, recordUsage } from './anthropic.js';
import {
  DRAFT_SYSTEM_PROMPT, DRAFT_TOOL,
  SCORE_SYSTEM_PROMPT, SCORE_TOOL,
  IMAGE_EXTRACT_SYSTEM_PROMPT, IMAGE_EXTRACT_TOOL,
  renderContactContext,
} from './prompts.js';

// ---------- response helpers ----------

function json(data, init = {}) {
  const headers = { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) };
  return new Response(JSON.stringify(data), { ...init, headers });
}
function err(status, code, extra = {}) {
  return json({ error: code, ...extra }, { status });
}

// ---------- validation helpers ----------

const SOURCES = ['ig', 'tinder', 'bumble', 'fetlife', 'tiktok', 'x', 'whatsapp'];
const BUCKETS = ['dating', 'fan'];
const STATUSES = ['new', 'warming', 'vetting', 'met', 'paying-fan', 'ghosted', 'blocked'];
const LOCATION_KINDS = ['local', 'visiting', 'remote'];
const DIRECTIONS = ['in', 'out'];

const HANDLE_FIELDS = ['handle_ig', 'handle_tinder', 'handle_bumble', 'handle_fetlife', 'handle_tiktok', 'handle_x', 'handle_whatsapp'];

// Contact fields safe to accept from PATCH. Each maps to a validator.
const CONTACT_FIELDS = {
  display_name:              v => str(v, 200, false),
  bucket:                    v => oneOf(v, BUCKETS),
  status:                    v => oneOf(v, STATUSES),
  handle_ig:                 v => str(v, 200, true),
  handle_tinder:             v => str(v, 200, true),
  handle_bumble:             v => str(v, 200, true),
  handle_fetlife:            v => str(v, 200, true),
  handle_tiktok:             v => str(v, 200, true),
  handle_x:                  v => str(v, 200, true),
  handle_whatsapp:           v => str(v, 200, true),
  location_kind:             v => v === null ? null : oneOf(v, LOCATION_KINDS),
  location_note:             v => str(v, 500, true),
  height_cm:                 v => int(v, 0, 300, true),
  speaks_spanish:            v => bool01(v, true),
  speaks_english:            v => bool01(v, true),
  poly_literate:             v => bool01(v, true),
  kink_literate:             v => bool01(v, true),
  feminist_aligned:          v => bool01(v, true),
  dom_gentle:                v => bool01(v, true),
  handles_strong_woman:      v => bool01(v, true),
  met_in_person:             v => bool01(v, false),
  long_term_named_confirmed: v => bool01(v, false),
  notes:                     v => str(v, 20000, true),
};

function str(v, max, nullable) {
  if (v == null || v === '') return nullable ? null : (v === '' ? '' : bad('empty'));
  if (typeof v !== 'string') bad('not_string');
  if (v.length > max) bad('too_long');
  return v;
}
function oneOf(v, allowed) {
  if (!allowed.includes(v)) bad('bad_enum');
  return v;
}
function int(v, min, max, nullable) {
  if (v == null) return nullable ? null : bad('missing');
  const n = Number(v);
  if (!Number.isInteger(n)) bad('not_int');
  if (n < min || n > max) bad('out_of_range');
  return n;
}
function bool01(v, nullable) {
  if (v == null) return nullable ? null : bad('missing');
  if (v === 0 || v === false) return 0;
  if (v === 1 || v === true) return 1;
  bad('not_bool');
}
function bad(reason) { const e = new Error('validation:' + reason); e.validation = reason; throw e; }

// Map validation errors to 400 responses.
async function tryValidate(fn) {
  try { return { ok: true, value: fn() }; }
  catch (e) {
    if (e?.validation) return { ok: false, response: err(400, 'invalid_input', { detail: e.validation }) };
    throw e;
  }
}

// ---------- auth ----------

async function requireSession(req, env) {
  const s = await currentSession(req, env);
  return s ? { session: s } : { response: err(401, 'unauthenticated') };
}

// ---------- extension token helpers (Phase 3) ----------

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

function generateTokenString() {
  // 32 random bytes → url-safe token. Prefix so tokens are recognizable
  // and can be pattern-scrubbed from logs.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/1/o/i to avoid confusion
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return 'rpx_' + out;
}

/**
 * Look up an active extension token by the Authorization header.
 * Updates last_used_at on success. Returns null if not present or revoked.
 */
async function currentExtensionToken(req, env) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(rpx_[a-z0-9]{32,64})$/i);
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    'SELECT id, created_at, revoked_at FROM extension_tokens WHERE token_hash = ?'
  ).bind(hash).first();
  if (!row || row.revoked_at) return null;
  // Fire-and-forget last_used_at update; failure shouldn't block ingest.
  env.DB.prepare('UPDATE extension_tokens SET last_used_at = ? WHERE id = ?')
    .bind(Date.now(), row.id).run().catch(() => {});
  return row;
}

async function requireExtensionToken(req, env) {
  const t = await currentExtensionToken(req, env);
  return t ? { token: t } : { response: err(401, 'unauthenticated', { detail: 'extension token missing or revoked' }) };
}

async function handleLogin(req, env) {
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }
  const ok = await verifyPassword(body?.password, env);
  if (!ok) {
    await new Promise(r => setTimeout(r, 300)); // blunt scripted brute force
    return err(401, 'invalid_password');
  }
  const cookie = await issueSessionCookie(env);
  return json({ ok: true }, { headers: { 'set-cookie': cookie } });
}
async function handleLogout() {
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
}
async function handleMe(req, env) {
  const s = await currentSession(req, env);
  return json({ authed: !!s, session: s ? { issued: s.iat, expires: s.exp } : null });
}

// ---------- counts ----------

async function handleCounts(req, env) {
  await ensureSchema(env);
  const rows = await env.DB.prepare(
    'SELECT bucket, COUNT(*) AS n FROM contacts GROUP BY bucket'
  ).all();
  const counts = { dating: 0, fan: 0, all: 0, open_followups: 0 };
  for (const r of rows.results ?? []) {
    if (r.bucket === 'dating') counts.dating = r.n;
    if (r.bucket === 'fan') counts.fan = r.n;
  }
  counts.all = counts.dating + counts.fan;
  const fu = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM follow_ups WHERE completed_at IS NULL'
  ).first();
  counts.open_followups = fu?.n ?? 0;
  return json(counts);
}

// ---------- contacts ----------

// Small projection used in list view.
const CONTACT_LIST_COLS = `id, display_name, bucket, status,
  handle_ig, handle_tinder, handle_bumble, handle_fetlife, handle_tiktok, handle_x, handle_whatsapp,
  updated_at, met_in_person, long_term_named_confirmed,
  signal_score, recommend_action, last_scanned_at`;

async function handleContactsList(req, env, url) {
  await ensureSchema(env);
  const bucket    = url.searchParams.get('bucket');   // 'dating' | 'fan' | 'all' | null
  const status    = url.searchParams.get('status');   // one of STATUSES | null
  const q         = url.searchParams.get('q');        // free-text search
  const rec       = url.searchParams.get('recommend'); // advance | hold | vet_more | close | unscanned | null
  const sort      = url.searchParams.get('sort');     // 'score' | 'updated' (default)
  const limit     = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));

  const where = [];
  const binds = [];
  if (bucket && bucket !== 'all') {
    if (!BUCKETS.includes(bucket)) return err(400, 'bad_bucket');
    where.push('bucket = ?'); binds.push(bucket);
  }
  if (status) {
    if (!STATUSES.includes(status)) return err(400, 'bad_status');
    where.push('status = ?'); binds.push(status);
  }
  if (q) {
    const like = '%' + q.replace(/[%_]/g, s => '\\' + s) + '%';
    where.push(`(display_name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR
                 handle_ig LIKE ? ESCAPE '\\' OR handle_tinder LIKE ? ESCAPE '\\' OR
                 handle_bumble LIKE ? ESCAPE '\\' OR handle_fetlife LIKE ? ESCAPE '\\' OR
                 handle_tiktok LIKE ? ESCAPE '\\' OR handle_x LIKE ? ESCAPE '\\' OR
                 handle_whatsapp LIKE ? ESCAPE '\\')`);
    for (let i = 0; i < 9; i++) binds.push(like);
  }
  if (rec === 'unscanned') {
    where.push('signal_score IS NULL');
  } else if (['advance', 'hold', 'vet_more', 'close'].includes(rec)) {
    where.push('recommend_action = ?'); binds.push(rec);
  }

  // Default sort: recent activity. sort=score → highest signal_score first,
  // nulls last (so unscored contacts sink to the bottom).
  const orderBy = sort === 'score'
    ? 'signal_score IS NULL, signal_score DESC, updated_at DESC'
    : 'updated_at DESC';

  const sql =
    `SELECT ${CONTACT_LIST_COLS},
      (SELECT body FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_body,
      (SELECT source FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_source,
      (SELECT direction FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_direction,
      (SELECT COALESCE(m.sent_at, m.ingested_at) FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_at
     FROM contacts
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${orderBy}
     LIMIT ?`;
  binds.push(limit);
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ contacts: rows.results ?? [] });
}

async function handleContactCreate(req, env) {
  await ensureSchema(env);
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }

  // display_name + bucket are required.
  const dn = body?.display_name;
  const bk = body?.bucket;
  if (!dn || typeof dn !== 'string' || dn.length === 0 || dn.length > 200) return err(400, 'display_name_required');
  if (!BUCKETS.includes(bk)) return err(400, 'bucket_required');

  // Validate everything else that was supplied.
  const cols = ['display_name', 'bucket'];
  const vals = [dn, bk];
  for (const [k, validate] of Object.entries(CONTACT_FIELDS)) {
    if (k === 'display_name' || k === 'bucket') continue;
    if (!(k in body)) continue;
    const r = await tryValidate(() => validate(body[k]));
    if (!r.ok) return r.response;
    cols.push(k); vals.push(r.value);
  }
  const placeholders = cols.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `INSERT INTO contacts (${cols.join(', ')}) VALUES (${placeholders})`
  ).bind(...vals).run();
  const id = res.meta?.last_row_id;
  return json({ ok: true, id }, { status: 201 });
}

async function handleContactGet(req, env, url, params) {
  await ensureSchema(env);
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err(400, 'bad_id');
  const contact = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  if (!contact) return err(404, 'not_found');

  const messages = await env.DB.prepare(
    `SELECT id, source, direction, body, sent_at, ingested_at
       FROM messages WHERE contact_id = ?
       ORDER BY COALESCE(sent_at, ingested_at) ASC, id ASC`
  ).bind(id).all();

  const tags = await env.DB.prepare(
    'SELECT tag FROM tags WHERE contact_id = ? ORDER BY created_at ASC'
  ).bind(id).all();

  const followUps = await env.DB.prepare(
    `SELECT id, remind_at, note, completed_at, created_at
       FROM follow_ups WHERE contact_id = ?
       ORDER BY remind_at ASC`
  ).bind(id).all();

  const flags = await env.DB.prepare(
    `SELECT id, message_id, rule_id, category, weight, evidence, created_at
       FROM flags WHERE contact_id = ?
       ORDER BY created_at DESC`
  ).bind(id).all();

  return json({
    contact,
    messages:   messages.results ?? [],
    tags:       (tags.results ?? []).map(r => r.tag),
    follow_ups: followUps.results ?? [],
    flags:      flags.results ?? [],
  });
}

async function handleContactPatch(req, env, url, params) {
  await ensureSchema(env);
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err(400, 'bad_id');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }

  const sets = [];
  const binds = [];
  for (const [k, validate] of Object.entries(CONTACT_FIELDS)) {
    if (!(k in body)) continue;
    const r = await tryValidate(() => validate(body[k]));
    if (!r.ok) return r.response;
    sets.push(`${k} = ?`);
    binds.push(r.value);
  }
  if (sets.length === 0) return err(400, 'nothing_to_update');

  sets.push('updated_at = ?'); binds.push(Date.now());
  binds.push(id);
  const res = await env.DB.prepare(
    `UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
  if (!res.meta?.changes) return err(404, 'not_found');
  return json({ ok: true });
}

async function handleContactDelete(req, env, url, params) {
  await ensureSchema(env);
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err(400, 'bad_id');
  const res = await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  if (!res.meta?.changes) return err(404, 'not_found');
  return json({ ok: true });
}

// ---------- messages ----------

async function handleMessageCreate(req, env, url, params) {
  await ensureSchema(env);
  const contactId = Number(params.id);
  if (!Number.isInteger(contactId)) return err(400, 'bad_id');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }

  const source = body?.source;
  const direction = body?.direction;
  const text = body?.body;
  const sentAt = body?.sent_at ?? null;

  if (!SOURCES.includes(source)) return err(400, 'bad_source');
  if (!DIRECTIONS.includes(direction)) return err(400, 'bad_direction');
  if (typeof text !== 'string' || text.length === 0 || text.length > 100000) return err(400, 'bad_body');
  if (sentAt != null && !Number.isFinite(Number(sentAt))) return err(400, 'bad_sent_at');

  // Contact existence check (foreign key would fail silently in D1 without PRAGMA).
  const c = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
  if (!c) return err(404, 'contact_not_found');

  const res = await env.DB.prepare(
    `INSERT INTO messages (contact_id, source, direction, body, sent_at)
       VALUES (?, ?, ?, ?, ?)`
  ).bind(contactId, source, direction, text, sentAt == null ? null : Number(sentAt)).run();

  // Bump the contact's updated_at so recent activity floats the list.
  await env.DB.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?')
    .bind(Date.now(), contactId).run();

  return json({ ok: true, id: res.meta?.last_row_id }, { status: 201 });
}

async function handleMessageDelete(req, env, url, params) {
  await ensureSchema(env);
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err(400, 'bad_id');
  const res = await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
  if (!res.meta?.changes) return err(404, 'not_found');
  return json({ ok: true });
}

// ---------- tags ----------

async function handleTagCreate(req, env, url, params) {
  await ensureSchema(env);
  const contactId = Number(params.id);
  if (!Number.isInteger(contactId)) return err(400, 'bad_id');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }
  const tag = body?.tag;
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > 80) return err(400, 'bad_tag');
  const c = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
  if (!c) return err(404, 'contact_not_found');
  await env.DB.prepare(
    'INSERT OR IGNORE INTO tags (contact_id, tag) VALUES (?, ?)'
  ).bind(contactId, tag).run();
  return json({ ok: true });
}

async function handleTagDelete(req, env, url, params) {
  await ensureSchema(env);
  const contactId = Number(params.id);
  const tag = decodeURIComponent(params.tag || '');
  if (!Number.isInteger(contactId)) return err(400, 'bad_id');
  if (!tag) return err(400, 'bad_tag');
  await env.DB.prepare(
    'DELETE FROM tags WHERE contact_id = ? AND tag = ?'
  ).bind(contactId, tag).run();
  return json({ ok: true });
}

// ---------- follow-ups ----------

async function handleFollowUpCreate(req, env, url, params) {
  await ensureSchema(env);
  const contactId = Number(params.id);
  if (!Number.isInteger(contactId)) return err(400, 'bad_id');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }
  const remindAt = Number(body?.remind_at);
  const note = body?.note ?? null;
  if (!Number.isFinite(remindAt)) return err(400, 'bad_remind_at');
  if (note != null && (typeof note !== 'string' || note.length > 500)) return err(400, 'bad_note');
  const c = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
  if (!c) return err(404, 'contact_not_found');
  const res = await env.DB.prepare(
    'INSERT INTO follow_ups (contact_id, remind_at, note) VALUES (?, ?, ?)'
  ).bind(contactId, remindAt, note).run();
  return json({ ok: true, id: res.meta?.last_row_id }, { status: 201 });
}

async function handleFollowUpPatch(req, env, url, params) {
  await ensureSchema(env);
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err(400, 'bad_id');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }
  const sets = [];
  const binds = [];
  if ('completed' in body) {
    sets.push('completed_at = ?');
    binds.push(body.completed ? Date.now() : null);
  }
  if ('note' in body) {
    if (body.note != null && (typeof body.note !== 'string' || body.note.length > 500)) return err(400, 'bad_note');
    sets.push('note = ?'); binds.push(body.note ?? null);
  }
  if ('remind_at' in body) {
    const n = Number(body.remind_at);
    if (!Number.isFinite(n)) return err(400, 'bad_remind_at');
    sets.push('remind_at = ?'); binds.push(n);
  }
  if (sets.length === 0) return err(400, 'nothing_to_update');
  binds.push(id);
  const res = await env.DB.prepare(
    `UPDATE follow_ups SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
  if (!res.meta?.changes) return err(404, 'not_found');
  return json({ ok: true });
}

async function handleFollowUpsList(req, env, url) {
  await ensureSchema(env);
  const due = url.searchParams.get('due') === '1';
  const sql = due
    ? `SELECT f.*, c.display_name FROM follow_ups f JOIN contacts c ON c.id = f.contact_id
       WHERE f.completed_at IS NULL AND f.remind_at <= ? ORDER BY f.remind_at ASC`
    : `SELECT f.*, c.display_name FROM follow_ups f JOIN contacts c ON c.id = f.contact_id
       WHERE f.completed_at IS NULL ORDER BY f.remind_at ASC`;
  const rows = due
    ? await env.DB.prepare(sql).bind(Date.now()).all()
    : await env.DB.prepare(sql).all();
  return json({ follow_ups: rows.results ?? [] });
}

// ---------- AI: drafting + scoring + usage ----------

// Load a contact and its recent thread. Used by both drafting and scoring.
async function loadContactAndThread(env, contactId, limitMessages) {
  const contact = await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contactId).first();
  if (!contact) return { error: err(404, 'contact_not_found') };
  const msgSql = limitMessages
    ? `SELECT id, source, direction, body, sent_at, ingested_at
         FROM messages WHERE contact_id = ?
         ORDER BY COALESCE(sent_at, ingested_at) DESC, id DESC LIMIT ?`
    : `SELECT id, source, direction, body, sent_at, ingested_at
         FROM messages WHERE contact_id = ?
         ORDER BY COALESCE(sent_at, ingested_at) ASC, id ASC`;
  const rowsRes = limitMessages
    ? await env.DB.prepare(msgSql).bind(contactId, limitMessages).all()
    : await env.DB.prepare(msgSql).bind(contactId).all();
  let messages = rowsRes.results ?? [];
  // If we asked for a limited window we grabbed newest-first — reverse to chronological.
  if (limitMessages) messages = messages.slice().reverse();
  return { contact, messages };
}

async function handleDraftsGenerate(req, env, url, params) {
  await ensureSchema(env);
  const contactId = Number(params.id);
  if (!Number.isInteger(contactId)) return err(400, 'bad_id');

  const { contact, messages, error } = await loadContactAndThread(env, contactId, 30);
  if (error) return error;
  if (messages.length === 0) {
    return err(400, 'no_messages', { detail: 'add at least one message before drafting a reply' });
  }
  // Refuse to draft a reply if the most recent message is already Ray's — that
  // means she's already responded and this would just be a redundant call.
  const last = messages[messages.length - 1];
  if (last.direction !== 'in') {
    return err(400, 'last_message_is_hers',
      { detail: 'last message is already from you; add his reply before drafting' });
  }

  const userMsg = renderContactContext(contact, messages);

  let usage = { model: 'unknown', input_tokens: 0, output_tokens: 0, cost_micro_usd: 0, latency_ms: 0 };
  try {
    const { output, usage: u } = await callClaude(env, {
      system: DRAFT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
      tool: DRAFT_TOOL,
      maxTokens: 1024,
      temperature: 0.85,
    });
    usage = u;
    await recordUsage(env, contactId, 'draft', usage, null);

    const drafts = output.tool_input?.drafts;
    const readOfThread = output.tool_input?.read_of_thread;
    if (!Array.isArray(drafts) || drafts.length === 0) {
      return err(502, 'draft_shape_bad', { detail: 'model did not return drafts' });
    }
    return json({
      ok: true,
      drafts,
      read_of_thread: readOfThread,
      usage: { cost_micro_usd: usage.cost_micro_usd, latency_ms: usage.latency_ms, model: usage.model },
    });
  } catch (e) {
    await recordUsage(env, contactId, 'draft', usage, e?.message || String(e));
    return err(502, 'draft_failed', { detail: e?.detail || e?.message || 'unknown' });
  }
}

async function handleContactScan(req, env, url, params) {
  await ensureSchema(env);
  const contactId = Number(params.id);
  if (!Number.isInteger(contactId)) return err(400, 'bad_id');

  const { contact, messages, error } = await loadContactAndThread(env, contactId, null);
  if (error) return error;
  if (messages.length === 0) {
    return err(400, 'no_messages', { detail: 'add at least one message before scanning' });
  }

  const userMsg = renderContactContext(contact, messages);

  let usage = { model: 'unknown', input_tokens: 0, output_tokens: 0, cost_micro_usd: 0, latency_ms: 0 };
  try {
    const { output, usage: u } = await callClaude(env, {
      system: SCORE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
      tool: SCORE_TOOL,
      maxTokens: 2048,
      temperature: 0.2,
    });
    usage = u;
    await recordUsage(env, contactId, 'scan', usage, null);

    const analysis = output.tool_input;
    if (!analysis || !Array.isArray(analysis.flags)) {
      return err(502, 'scan_shape_bad', { detail: 'model did not return analysis' });
    }

    // Replace existing flags for this contact with the fresh scan.
    // Wrap in a batch so partial state can't leak on error.
    const now = Date.now();
    const inserts = analysis.flags
      .filter(f => f && f.rule_id && f.category && Number.isInteger(f.weight))
      .map(f => {
        const msgIdx = Number.isInteger(f.message_index) ? f.message_index : null;
        const msgRow = msgIdx != null ? messages[msgIdx] : null;
        return env.DB.prepare(
          `INSERT INTO flags (contact_id, message_id, rule_id, category, weight, evidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          contactId,
          msgRow ? msgRow.id : null,
          String(f.rule_id).slice(0, 80),
          f.category,
          f.weight,
          f.evidence ? String(f.evidence).slice(0, 2000) : null,
          now,
        );
      });

    const batch = [env.DB.prepare('DELETE FROM flags WHERE contact_id = ?').bind(contactId)];
    if (inserts.length) batch.push(...inserts);

    const score = Math.max(-100, Math.min(100, Number(analysis.signal_score) || 0));
    const rec = ['advance', 'hold', 'vet_more', 'close'].includes(analysis.recommend_action)
      ? analysis.recommend_action : null;
    batch.push(env.DB.prepare(
      `UPDATE contacts SET signal_score = ?, recommend_action = ?, last_scanned_at = ?, updated_at = ?
         WHERE id = ?`
    ).bind(score, rec, now, now, contactId));

    await env.DB.batch(batch);

    // Read back what we stored so the UI has fresh ids.
    const stored = await env.DB.prepare(
      `SELECT id, message_id, rule_id, category, weight, evidence, created_at
         FROM flags WHERE contact_id = ? ORDER BY created_at DESC, id DESC`
    ).bind(contactId).all();

    return json({
      ok: true,
      overall_read: analysis.overall_read,
      recommend_action: analysis.recommend_action,
      signal_score: score,
      flags: stored.results ?? [],
      usage: { cost_micro_usd: usage.cost_micro_usd, latency_ms: usage.latency_ms, model: usage.model },
    });
  } catch (e) {
    await recordUsage(env, contactId, 'scan', usage, e?.message || String(e));
    return err(502, 'scan_failed', { detail: e?.detail || e?.message || 'unknown' });
  }
}

async function handleScanUnscanned(req, env) {
  await ensureSchema(env);
  const MAX_PER_CALL = 30;

  // Pick contacts that (a) haven't been scanned yet AND (b) have at least
  // one message to scan. Cap so a runaway inbox doesn't blow the budget.
  const targets = await env.DB.prepare(
    `SELECT c.id, c.display_name
       FROM contacts c
       WHERE c.signal_score IS NULL
         AND EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id)
       ORDER BY c.updated_at DESC
       LIMIT ?`
  ).bind(MAX_PER_CALL + 1).all();

  const rows = targets.results ?? [];
  const overflow = rows.length > MAX_PER_CALL;
  const batch = rows.slice(0, MAX_PER_CALL);

  if (batch.length === 0) {
    return json({ ok: true, scanned: 0, results: [], overflow: false, total_cost_micro_usd: 0 });
  }

  const results = [];
  let totalCost = 0;

  for (const row of batch) {
    try {
      const { contact, messages } = await loadContactAndThread(env, row.id, null);
      if (!messages || messages.length === 0) {
        results.push({ contact_id: row.id, error: 'no_messages' });
        continue;
      }
      const userMsg = renderContactContext(contact, messages);
      const { output, usage } = await callClaude(env, {
        system: SCORE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
        tool: SCORE_TOOL,
        maxTokens: 2048,
        temperature: 0.2,
      });
      totalCost += usage.cost_micro_usd || 0;
      await recordUsage(env, row.id, 'scan', usage, null);

      const analysis = output.tool_input;
      if (!analysis || !Array.isArray(analysis.flags)) {
        results.push({ contact_id: row.id, error: 'shape_bad' });
        continue;
      }
      const now = Date.now();
      const score = Math.max(-100, Math.min(100, Number(analysis.signal_score) || 0));
      const rec = ['advance', 'hold', 'vet_more', 'close'].includes(analysis.recommend_action)
        ? analysis.recommend_action : null;

      const inserts = analysis.flags
        .filter(f => f && f.rule_id && f.category && Number.isInteger(f.weight))
        .map(f => {
          const msgIdx = Number.isInteger(f.message_index) ? f.message_index : null;
          const msgRow = msgIdx != null ? messages[msgIdx] : null;
          return env.DB.prepare(
            `INSERT INTO flags (contact_id, message_id, rule_id, category, weight, evidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            row.id, msgRow ? msgRow.id : null,
            String(f.rule_id).slice(0, 80), f.category, f.weight,
            f.evidence ? String(f.evidence).slice(0, 2000) : null, now,
          );
        });
      const stmts = [env.DB.prepare('DELETE FROM flags WHERE contact_id = ?').bind(row.id)];
      if (inserts.length) stmts.push(...inserts);
      stmts.push(env.DB.prepare(
        `UPDATE contacts SET signal_score = ?, recommend_action = ?, last_scanned_at = ?, updated_at = ?
           WHERE id = ?`
      ).bind(score, rec, now, now, row.id));
      await env.DB.batch(stmts);

      results.push({
        contact_id: row.id, display_name: contact.display_name,
        signal_score: score, recommend_action: rec,
        overall_read: analysis.overall_read,
      });
    } catch (e) {
      results.push({ contact_id: row.id, error: e?.message || String(e) });
    }
  }

  return json({
    ok: true,
    scanned: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    overflow, // true if there are more unscanned than we did in this call
    total_cost_micro_usd: totalCost,
    results,
  });
}

async function handleAiUsage(req, env, url) {
  await ensureSchema(env);
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const rows = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN created_at >= ? THEN cost_micro_usd ELSE 0 END) AS today_micro,
       SUM(CASE WHEN created_at >= ? THEN cost_micro_usd ELSE 0 END) AS week_micro,
       SUM(CASE WHEN created_at >= ? THEN cost_micro_usd ELSE 0 END) AS month_micro,
       COUNT(*) AS total_calls,
       SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
     FROM ai_usage`
  ).bind(now - day, now - 7 * day, now - 30 * day).first();

  const micros = (v) => (Number(v) || 0);
  const usd = (v) => Math.round(micros(v) / 1000) / 1000; // usd rounded to 3 decimals

  return json({
    today_usd: usd(rows?.today_micro),
    week_usd: usd(rows?.week_micro),
    month_usd: usd(rows?.month_micro),
    total_calls: rows?.total_calls ?? 0,
    errors: rows?.errors ?? 0,
  });
}

// ---------- Phase 3: extension token management (session-gated) ----------

async function handleExtensionTokenInfo(req, env) {
  await ensureSchema(env);
  const row = await env.DB.prepare(
    `SELECT id, label, created_at, last_used_at FROM extension_tokens
       WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`
  ).first();
  return json({
    active: !!row,
    token: row ? {
      id: row.id,
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    } : null,
  });
}

async function handleExtensionTokenRotate(req, env) {
  await ensureSchema(env);
  let body = {};
  try { body = await req.json(); } catch { /* body is optional */ }
  const label = typeof body?.label === 'string' ? body.label.slice(0, 80) : null;

  const now = Date.now();
  // Revoke ALL currently-active tokens so exactly one token is live at a time.
  await env.DB.prepare(
    'UPDATE extension_tokens SET revoked_at = ? WHERE revoked_at IS NULL'
  ).bind(now).run();

  const plaintext = generateTokenString();
  const hash = await sha256Hex(plaintext);
  const res = await env.DB.prepare(
    'INSERT INTO extension_tokens (token_hash, label, created_at) VALUES (?, ?, ?)'
  ).bind(hash, label, now).run();

  return json({
    ok: true,
    id: res.meta?.last_row_id,
    token: plaintext,
    warning: 'This token is shown once. Paste it into the extension now — you cannot see it again.',
  });
}

async function handleExtensionTokenRevoke(req, env) {
  await ensureSchema(env);
  const now = Date.now();
  const res = await env.DB.prepare(
    'UPDATE extension_tokens SET revoked_at = ? WHERE revoked_at IS NULL'
  ).bind(now).run();
  return json({ ok: true, revoked: res.meta?.changes ?? 0 });
}

// ---------- Phase 3: ingest endpoint (extension-token gated) ----------

const HANDLE_COL_FOR_SOURCE = {
  ig: 'handle_ig', tinder: 'handle_tinder', bumble: 'handle_bumble',
  fetlife: 'handle_fetlife', tiktok: 'handle_tiktok', x: 'handle_x',
  whatsapp: 'handle_whatsapp',
};

function normalizeHandle(s) {
  if (typeof s !== 'string') return null;
  return s.trim().replace(/^@+/, '').toLowerCase().slice(0, 200) || null;
}

async function contentHashFor(source, direction, body, sentAt) {
  // Round sent_at to the nearest 30s to absorb small clock differences
  // between captures of the same message. Absent times become empty.
  const t = Number.isFinite(sentAt) ? Math.round(sentAt / 30_000) : '';
  return await sha256Hex(`${source}|${direction}|${t}|${body}`);
}

/**
 * Core "upsert contact + insert messages" logic used by BOTH the plain
 * text ingest and the vision-based image ingest. Assumes source has
 * already been validated against SOURCES.
 */
async function ingestMessagesFor(env, {
  source, externalId, displayName, bucket, messagesInput,
}) {
  const handleCol = HANDLE_COL_FOR_SOURCE[source];
  if (!handleCol) throw new Error('bad_source_for_ingest');

  let contact = await env.DB.prepare(
    `SELECT id, display_name FROM contacts WHERE ${handleCol} = ? LIMIT 1`
  ).bind(externalId).first();

  let contactCreated = false;
  if (!contact) {
    const ins = await env.DB.prepare(
      `INSERT INTO contacts (display_name, bucket, ${handleCol}) VALUES (?, ?, ?)`
    ).bind(displayName, bucket, externalId).run();
    contact = { id: ins.meta?.last_row_id, display_name: displayName };
    contactCreated = true;
  }

  let added = 0, existing = 0, rejected = 0;
  for (const m of messagesInput) {
    if (!DIRECTIONS.includes(m?.direction)) { rejected++; continue; }
    if (typeof m?.body !== 'string' || m.body.length === 0 || m.body.length > 100000) { rejected++; continue; }
    const sentAt = Number.isFinite(m?.sent_at) ? Number(m.sent_at) : null;
    const extId = (typeof m?.external_id === 'string' && m.external_id)
      ? m.external_id.slice(0, 200) : null;
    const contentHash = await contentHashFor(source, m.direction, m.body, sentAt);
    try {
      const res = await env.DB.prepare(
        `INSERT INTO messages
           (contact_id, source, direction, body, sent_at, external_id, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(contact.id, source, m.direction, m.body, sentAt, extId, contentHash).run();
      if (res.meta?.changes) added++;
      else existing++;
    } catch (e) {
      if (String(e?.message || e).toLowerCase().includes('unique')) existing++;
      else { rejected++; console.error('ingest insert failed:', e?.message || e); }
    }
  }

  if (added > 0) {
    await env.DB.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?')
      .bind(Date.now(), contact.id).run();
  }

  return {
    contact: { id: contact.id, created: contactCreated, display_name: contact.display_name },
    added, existing, rejected,
  };
}

async function handleIngest(req, env) {
  await ensureSchema(env);
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }

  const source = body?.source;
  if (!SOURCES.includes(source)) return err(400, 'bad_source');

  const contactInput = body?.contact || {};
  const externalId = normalizeHandle(contactInput.external_id);
  if (!externalId) return err(400, 'contact_external_id_required');

  const displayName = (typeof contactInput.display_name === 'string' && contactInput.display_name.trim())
    ? contactInput.display_name.trim().slice(0, 200)
    : externalId;
  const bucket = BUCKETS.includes(contactInput.bucket) ? contactInput.bucket : 'dating';

  const messagesInput = Array.isArray(body?.messages) ? body.messages : [];
  if (messagesInput.length === 0) return err(400, 'no_messages');
  if (messagesInput.length > 500) return err(400, 'too_many_messages');

  const result = await ingestMessagesFor(env, {
    source, externalId, displayName, bucket, messagesInput,
  });
  return json({ ok: true, ...result });
}

// ---------- Phase 3 (v0.2): vision-based screenshot ingest ----------

async function handleIngestImage(req, env) {
  await ensureSchema(env);
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad_request'); }

  // Accept base64 (no data: URL prefix) + media type. Extension always sends
  // a stripped base64 string so the payload stays JSON.
  const imageB64 = body?.image;
  const mediaType = body?.image_media_type || 'image/png';
  if (typeof imageB64 !== 'string' || imageB64.length < 100) return err(400, 'bad_image');
  if (imageB64.length > 20 * 1024 * 1024) return err(400, 'image_too_large');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
    return err(400, 'bad_image_media_type');
  }

  // Optional user-provided hints. Vision output can override these if the
  // image is unambiguous.
  const sourceHint = SOURCES.includes(body?.source) ? body.source : null;
  const bucketHint = BUCKETS.includes(body?.bucket) ? body.bucket : 'dating';

  // Ask Claude Vision to extract the thread.
  let usage = { model: 'unknown', input_tokens: 0, output_tokens: 0, cost_micro_usd: 0, latency_ms: 0 };
  let extraction;
  try {
    const { output, usage: u } = await callClaude(env, {
      system: IMAGE_EXTRACT_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
          { type: 'text', text: sourceHint
              ? `Caller hint: source is likely "${sourceHint}". Override if the image clearly says otherwise.`
              : 'No source hint. Best-guess from visual cues.' },
        ],
      }],
      tool: IMAGE_EXTRACT_TOOL,
      maxTokens: 4096,
      temperature: 0.1,
    });
    usage = u;
    await recordUsage(env, null, 'scan', usage, null); // reuse 'scan' bucket for spend
    extraction = output.tool_input;
  } catch (e) {
    await recordUsage(env, null, 'scan', usage, e?.message || String(e));
    return err(502, 'vision_failed', { detail: e?.detail || e?.message || 'unknown' });
  }

  if (!extraction || !extraction.mode) {
    return err(422, 'no_mode', { detail: extraction?.issue || 'Vision could not classify the image.' });
  }

  const source = SOURCES.includes(extraction.source) ? extraction.source
               : sourceHint || null;
  if (!source && extraction.mode !== 'unknown') {
    return err(422, 'source_unknown',
      { detail: 'Could not identify the platform from the image; pick one in the popup and try again.' });
  }

  // ---- Branch on mode ----
  if (extraction.mode === 'thread') {
    if (!Array.isArray(extraction.messages) || extraction.messages.length === 0) {
      return err(422, 'no_messages_found',
        { detail: extraction.issue || 'Vision saw a thread but no messages.' });
    }
    const contact = extraction.contact || {};
    const displayName = (typeof contact.display_name === 'string' && contact.display_name.trim())
      ? contact.display_name.trim().slice(0, 200) : null;
    const rawHandle = typeof contact.handle === 'string' ? contact.handle : '';
    const externalId = normalizeHandle(rawHandle) || normalizeHandle(displayName);
    if (!externalId) return err(422, 'no_contact_identity',
      { detail: 'Could not extract a contact handle or name from the image header.' });

    const messagesInput = extraction.messages
      .filter(m => m && ['in', 'out'].includes(m.direction) && typeof m.body === 'string' && m.body.trim().length > 0)
      .map(m => ({ direction: m.direction, body: m.body.trim() }));
    if (messagesInput.length === 0) {
      return err(422, 'no_valid_messages', { detail: 'Vision returned messages but none had valid direction + body.' });
    }

    const result = await ingestMessagesFor(env, {
      source, externalId,
      displayName: displayName || externalId,
      bucket: bucketHint, messagesInput,
    });

    return json({
      ok: true,
      mode: 'thread',
      ...result,
      detected: { source, handle: externalId, display_name: displayName },
      issue: extraction.issue || null,
      usage: { cost_micro_usd: usage.cost_micro_usd, latency_ms: usage.latency_ms, model: usage.model },
    });
  }

  if (extraction.mode === 'inbox') {
    const rows = Array.isArray(extraction.contacts) ? extraction.contacts : [];
    if (rows.length === 0) {
      return err(422, 'no_inbox_rows',
        { detail: extraction.issue || 'Vision detected an inbox but no rows.' });
    }
    const results = [];
    let totalAdded = 0, totalExisting = 0, totalRejected = 0, contactsCreated = 0;
    for (const row of rows) {
      const displayName = (typeof row?.display_name === 'string' && row.display_name.trim())
        ? row.display_name.trim().slice(0, 200) : null;
      const rawHandle = typeof row?.handle === 'string' ? row.handle : '';
      const externalId = normalizeHandle(rawHandle) || normalizeHandle(displayName);
      const preview = row?.preview;
      if (!externalId || !preview || !['in', 'out'].includes(preview.direction) ||
          typeof preview.body !== 'string' || !preview.body.trim()) {
        results.push({ display_name: displayName, added: 0, error: 'incomplete_row' });
        continue;
      }
      try {
        const r = await ingestMessagesFor(env, {
          source, externalId,
          displayName: displayName || externalId,
          bucket: bucketHint,
          messagesInput: [{ direction: preview.direction, body: preview.body.trim() }],
        });
        totalAdded += r.added;
        totalExisting += r.existing;
        totalRejected += r.rejected;
        if (r.contact.created) contactsCreated++;
        results.push({
          contact_id: r.contact.id,
          display_name: r.contact.display_name,
          created: r.contact.created,
          added: r.added,
          existing: r.existing,
          unread: !!row?.unread,
        });
      } catch (e) {
        results.push({ display_name: displayName, added: 0, error: e?.message || 'ingest_failed' });
      }
    }

    return json({
      ok: true,
      mode: 'inbox',
      source,
      total: rows.length,
      contacts_created: contactsCreated,
      added: totalAdded, existing: totalExisting, rejected: totalRejected,
      results,
      issue: extraction.issue || null,
      usage: { cost_micro_usd: usage.cost_micro_usd, latency_ms: usage.latency_ms, model: usage.model },
    });
  }

  // mode === 'unknown'
  return err(422, 'unknown_image_kind',
    { detail: extraction.issue || 'Vision could not classify this image as a thread or inbox.' });
}

// ---------- route table ----------

const ROUTES = [
  // public
  { method: 'POST',   pattern: '/api/login',                             handler: handleLogin,          public: true },
  { method: 'POST',   pattern: '/api/logout',                            handler: handleLogout,         public: true },
  { method: 'GET',    pattern: '/api/me',                                handler: handleMe,             public: true },

  // authed
  { method: 'GET',    pattern: '/api/counts',                            handler: handleCounts },
  { method: 'GET',    pattern: '/api/contacts',                          handler: handleContactsList },
  { method: 'POST',   pattern: '/api/contacts',                          handler: handleContactCreate },
  { method: 'GET',    pattern: '/api/contacts/:id',                      handler: handleContactGet },
  { method: 'PATCH',  pattern: '/api/contacts/:id',                      handler: handleContactPatch },
  { method: 'DELETE', pattern: '/api/contacts/:id',                      handler: handleContactDelete },
  { method: 'POST',   pattern: '/api/contacts/:id/messages',             handler: handleMessageCreate },
  { method: 'DELETE', pattern: '/api/messages/:id',                      handler: handleMessageDelete },
  { method: 'POST',   pattern: '/api/contacts/:id/tags',                 handler: handleTagCreate },
  { method: 'DELETE', pattern: '/api/contacts/:id/tags/:tag',            handler: handleTagDelete },
  { method: 'POST',   pattern: '/api/contacts/:id/follow-ups',           handler: handleFollowUpCreate },
  { method: 'PATCH',  pattern: '/api/follow-ups/:id',                    handler: handleFollowUpPatch },
  { method: 'GET',    pattern: '/api/follow-ups',                        handler: handleFollowUpsList },

  // AI (Phase 4)
  { method: 'POST',   pattern: '/api/contacts/:id/drafts',               handler: handleDraftsGenerate },
  { method: 'POST',   pattern: '/api/contacts/:id/scan',                 handler: handleContactScan },
  { method: 'POST',   pattern: '/api/scan-unscanned',                    handler: handleScanUnscanned },
  { method: 'GET',    pattern: '/api/ai-usage',                          handler: handleAiUsage },

  // Extension (Phase 3)
  { method: 'GET',    pattern: '/api/settings/extension-token',          handler: handleExtensionTokenInfo },
  { method: 'POST',   pattern: '/api/settings/extension-token/rotate',   handler: handleExtensionTokenRotate },
  { method: 'POST',   pattern: '/api/settings/extension-token/revoke',   handler: handleExtensionTokenRevoke },
  { method: 'POST',   pattern: '/api/ingest',                            handler: handleIngest,      bearerAuth: true },
  { method: 'POST',   pattern: '/api/ingest-image',                      handler: handleIngestImage, bearerAuth: true },
];

// Match /api/contacts/:id against /api/contacts/42 → { id: "42" }
function matchRoute(method, path) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const pParts = r.pattern.split('/');
    const aParts = path.split('/');
    if (pParts.length !== aParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = aParts[i];
      else if (pParts[i] !== aParts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

// Chrome extensions POST from a chrome-extension:// origin, which needs
// CORS. We open it only on the ingest endpoint (which is Bearer-token
// gated anyway). Session-cookie endpoints stay same-origin only.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function withCors(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// Any route with bearerAuth also allows a CORS preflight response so the
// extension's cross-origin POST can proceed.
function isBearerRoute(method, path) {
  const hit = matchRoute(method, path);
  return !!(hit && hit.route.bearerAuth);
}

export async function handleApi(req, env, url) {
  // CORS preflight for bearer-auth routes.
  if (req.method === 'OPTIONS' && isBearerRoute('POST', url.pathname)) {
    return withCors(new Response(null, { status: 204 }));
  }

  const hit = matchRoute(req.method, url.pathname);
  if (!hit) return err(404, 'not_found');

  if (hit.route.bearerAuth) {
    const auth = await requireExtensionToken(req, env);
    if (auth.response) return withCors(auth.response);
  } else if (!hit.route.public) {
    const auth = await requireSession(req, env);
    if (auth.response) return auth.response;
  }

  try {
    const resp = await hit.route.handler(req, env, url, hit.params);
    return hit.route.bearerAuth ? withCors(resp) : resp;
  } catch (e) {
    // Log to Worker tail (not exposed to the client).
    console.error('api error:', e?.stack || e?.message || e);
    const resp = err(500, 'internal_error');
    return hit.route.bearerAuth ? withCors(resp) : resp;
  }
}
