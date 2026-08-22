// D1 helper: schema bootstrap + small query wrappers.
//
// The schema in migrations/0001_init.sql is inlined here so the Worker
// can apply it on demand — no `wrangler d1 migrations apply` needed.
// Every statement is idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX
// IF NOT EXISTS), so ensureSchema() is cheap and safe to call on every
// DB-touching request. We also cache the fact-of-having-run per Worker
// instance to skip the D1 round trips on hot requests.

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS contacts (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name              TEXT    NOT NULL,
    bucket                    TEXT    NOT NULL CHECK(bucket IN ('dating','fan')),
    status                    TEXT    NOT NULL DEFAULT 'new'
      CHECK(status IN ('new','warming','vetting','met','paying-fan','ghosted','blocked')),
    handle_ig                 TEXT,
    handle_tinder             TEXT,
    handle_bumble             TEXT,
    handle_fetlife            TEXT,
    handle_tiktok             TEXT,
    handle_x                  TEXT,
    handle_whatsapp           TEXT,
    location_kind             TEXT    CHECK(location_kind IN ('local','visiting','remote')),
    location_note             TEXT,
    height_cm                 INTEGER,
    speaks_spanish            INTEGER,
    speaks_english            INTEGER,
    poly_literate             INTEGER,
    kink_literate             INTEGER,
    feminist_aligned          INTEGER,
    dom_gentle                INTEGER,
    handles_strong_woman      INTEGER,
    met_in_person             INTEGER NOT NULL DEFAULT 0,
    long_term_named_confirmed INTEGER NOT NULL DEFAULT 0,
    notes                     TEXT,
    signal_score              INTEGER,
    form_score                INTEGER,
    created_at                INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at                INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_bucket_status ON contacts(bucket, status)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_updated_at   ON contacts(updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    source       TEXT    NOT NULL,
    direction    TEXT    NOT NULL CHECK(direction IN ('in','out')),
    body         TEXT    NOT NULL,
    sent_at      INTEGER,
    ingested_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    raw_json     TEXT,
    external_id  TEXT,
    content_hash TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, sent_at, id)`,

  `CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(contact_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS follow_ups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    remind_at     INTEGER NOT NULL,
    note          TEXT,
    completed_at  INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_followups_open ON follow_ups(remind_at) WHERE completed_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS flags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    rule_id     TEXT    NOT NULL,
    category    TEXT    NOT NULL CHECK(category IN ('positive','negative','gate')),
    weight      INTEGER NOT NULL,
    evidence    TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flags_contact ON flags(contact_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS ai_usage (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id       INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    purpose          TEXT    NOT NULL CHECK(purpose IN ('draft','scan')),
    model            TEXT    NOT NULL,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd   INTEGER NOT NULL DEFAULT 0,
    latency_ms       INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at DESC)`,

  // ---- Phase 3: browser-extension auth tokens ----
  // One-way SHA-256 hashes only; the plaintext is shown to the user once
  // when they generate it and never stored. revoked_at is a soft-delete
  // marker so old tokens can be audited without being usable.
  `CREATE TABLE IF NOT EXISTS extension_tokens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash    TEXT    NOT NULL UNIQUE,
    label         TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_used_at  INTEGER,
    revoked_at    INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_extension_tokens_active
     ON extension_tokens(token_hash) WHERE revoked_at IS NULL`,

  // ---- Phase 3: message dedup key on messages ----
  // The extension may push the same message twice (repeated capture of the
  // same thread). external_id is a per-source id when the platform gives us
  // one; content_hash is our fallback (sha256 of source + direction + body
  // + normalized-sent-at). Both are nullable so manually-added Phase 2
  // messages remain valid. UNIQUE partial indexes give us idempotent inserts.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
     ON messages(contact_id, source, external_id)
     WHERE external_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_content_hash
     ON messages(contact_id, source, content_hash)
     WHERE content_hash IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS schema_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '3')`,
];

// Add-column migrations. SQLite doesn't have ADD COLUMN IF NOT EXISTS, so
// we check pragma_table_info first and skip when the column already exists.
// Each entry: [table, column, sql-fragment (type + defaults)].
const ADD_COLUMN_MIGRATIONS = [
  ['messages', 'external_id',    'TEXT'],
  ['messages', 'content_hash',   'TEXT'],
  ['contacts', 'handle_whatsapp', 'TEXT'],
];

async function applyAddColumns(env) {
  for (const [table, column, spec] of ADD_COLUMN_MIGRATIONS) {
    const existing = await env.DB.prepare(
      `SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?`
    ).bind(table, column).first();
    if (existing) continue;
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`).run();
  }
}

/**
 * SQLite can't ALTER a CHECK constraint in place, so this one-shot migration
 * rebuilds the messages table with source-check removed. Application-layer
 * validation (api.js SOURCES) is now the only source-name authority, which
 * lets us add new platforms without another table rebuild. Guarded by
 * inspecting the current table SQL so it only fires once.
 */
async function migrateMessagesSourceCheck(env) {
  const info = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'"
  ).first();
  if (!info?.sql) return;
  if (!/CHECK\s*\(\s*source\s+IN/i.test(info.sql)) return; // already migrated

  // Rebuild in one batch — D1 runs batches in an implicit transaction, so
  // if any statement fails the whole thing rolls back.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE messages_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      source       TEXT    NOT NULL,
      direction    TEXT    NOT NULL CHECK(direction IN ('in','out')),
      body         TEXT    NOT NULL,
      sent_at      INTEGER,
      ingested_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      raw_json     TEXT,
      external_id  TEXT,
      content_hash TEXT
    )`),
    env.DB.prepare(
      `INSERT INTO messages_new
         (id, contact_id, source, direction, body, sent_at, ingested_at, raw_json, external_id, content_hash)
         SELECT id, contact_id, source, direction, body, sent_at, ingested_at, raw_json, external_id, content_hash
           FROM messages`
    ),
    env.DB.prepare('DROP TABLE messages'),
    env.DB.prepare('ALTER TABLE messages_new RENAME TO messages'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, sent_at, id)'),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
       ON messages(contact_id, source, external_id) WHERE external_id IS NOT NULL`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_content_hash
       ON messages(contact_id, source, content_hash) WHERE content_hash IS NOT NULL`),
  ]);
}

// Cache per Worker isolate — cheap gate around the CREATE IF NOT EXISTS batch.
let schemaReady = false;

export async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('D1 binding "DB" is not configured');
  // D1 batch runs statements sequentially in a single transaction.
  await env.DB.batch(SCHEMA_STATEMENTS.map(sql => env.DB.prepare(sql)));
  // Add-column migrations must run outside the CREATE-only batch so we can
  // read pragma_table_info between checks.
  await applyAddColumns(env);
  // One-shot rebuild of messages to drop the source CHECK constraint.
  await migrateMessagesSourceCheck(env);
  schemaReady = true;
}

// Handy wrapper: run a prepared statement with bound args, return .all()/.first()/.run() shape.
export function stmt(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds);
}
