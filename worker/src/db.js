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
    source       TEXT    NOT NULL CHECK(source IN ('ig','tinder','bumble','fetlife','tiktok','x')),
    direction    TEXT    NOT NULL CHECK(direction IN ('in','out')),
    body         TEXT    NOT NULL,
    sent_at      INTEGER,
    ingested_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    raw_json     TEXT
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

  `CREATE TABLE IF NOT EXISTS schema_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1')`,
];

// Cache per Worker isolate — cheap gate around the CREATE IF NOT EXISTS batch.
let schemaReady = false;

export async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('D1 binding "DB" is not configured');
  // D1 batch runs statements sequentially in a single transaction.
  await env.DB.batch(SCHEMA_STATEMENTS.map(sql => env.DB.prepare(sql)));
  schemaReady = true;
}

// Handy wrapper: run a prepared statement with bound args, return .all()/.first()/.run() shape.
export function stmt(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds);
}
