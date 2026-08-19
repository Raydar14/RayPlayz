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

const SOURCES = ['ig', 'tinder', 'bumble', 'fetlife', 'tiktok', 'x'];
const BUCKETS = ['dating', 'fan'];
const STATUSES = ['new', 'warming', 'vetting', 'met', 'paying-fan', 'ghosted', 'blocked'];
const LOCATION_KINDS = ['local', 'visiting', 'remote'];
const DIRECTIONS = ['in', 'out'];

const HANDLE_FIELDS = ['handle_ig', 'handle_tinder', 'handle_bumble', 'handle_fetlife', 'handle_tiktok', 'handle_x'];

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
  handle_ig, handle_tinder, handle_bumble, handle_fetlife, handle_tiktok, handle_x,
  updated_at, met_in_person, long_term_named_confirmed`;

async function handleContactsList(req, env, url) {
  await ensureSchema(env);
  const bucket = url.searchParams.get('bucket');   // 'dating' | 'fan' | 'all' | null
  const status = url.searchParams.get('status');   // one of STATUSES | null
  const q      = url.searchParams.get('q');        // free-text search
  const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));

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
                 handle_tiktok LIKE ? ESCAPE '\\' OR handle_x LIKE ? ESCAPE '\\')`);
    for (let i = 0; i < 8; i++) binds.push(like);
  }

  const sql =
    `SELECT ${CONTACT_LIST_COLS},
      (SELECT body FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_body,
      (SELECT source FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_source,
      (SELECT direction FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_direction,
      (SELECT COALESCE(m.sent_at, m.ingested_at) FROM messages m WHERE m.contact_id = contacts.id ORDER BY COALESCE(m.sent_at, m.ingested_at) DESC, m.id DESC LIMIT 1) AS last_at
     FROM contacts
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY updated_at DESC
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
    batch.push(env.DB.prepare(
      'UPDATE contacts SET signal_score = ?, updated_at = ? WHERE id = ?'
    ).bind(score, now, contactId));

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
  { method: 'GET',    pattern: '/api/ai-usage',                          handler: handleAiUsage },
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

export async function handleApi(req, env, url) {
  const hit = matchRoute(req.method, url.pathname);
  if (!hit) return err(404, 'not_found');

  if (!hit.route.public) {
    const auth = await requireSession(req, env);
    if (auth.response) return auth.response;
  }

  try {
    return await hit.route.handler(req, env, url, hit.params);
  } catch (e) {
    // Log to Worker tail (not exposed to the client).
    console.error('api error:', e?.stack || e?.message || e);
    return err(500, 'internal_error');
  }
}
