-- Phase 2 schema for the RayPlayz dashboard.
-- Idempotent — safe to re-run. The Worker bootstraps this on first DB access.

-- ---------- contacts ----------
-- One row per person Ray is talking to. bucket separates dating threads
-- from creator/fan DMs; the vetting fields hold what she has learned so far
-- (nullable when unknown, so the UI can distinguish "no" from "not asked yet").
CREATE TABLE IF NOT EXISTS contacts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name              TEXT    NOT NULL,
  bucket                    TEXT    NOT NULL CHECK(bucket IN ('dating','fan')),
  status                    TEXT    NOT NULL DEFAULT 'new'
    CHECK(status IN ('new','warming','vetting','met','paying-fan','ghosted','blocked')),

  -- Per-platform handles. Nullable so a contact can live on 1 or all 6 sources.
  handle_ig                 TEXT,
  handle_tinder             TEXT,
  handle_bumble             TEXT,
  handle_fetlife            TEXT,
  handle_tiktok             TEXT,
  handle_x                  TEXT,

  -- Hard filters + practical logistics (specific to Ray's spec: CR + 6' + bilingual).
  location_kind             TEXT    CHECK(location_kind IN ('local','visiting','remote')),
  location_note             TEXT,
  height_cm                 INTEGER,
  speaks_spanish            INTEGER,   -- 0/1/NULL
  speaks_english            INTEGER,   -- 0/1/NULL

  -- Soft signals. NULL = not yet known; 0/1 = confirmed no/yes.
  poly_literate             INTEGER,
  kink_literate             INTEGER,
  feminist_aligned          INTEGER,
  dom_gentle                INTEGER,   -- "dominant but understanding and gentle"
  handles_strong_woman      INTEGER,
  met_in_person             INTEGER   NOT NULL DEFAULT 0,

  -- The hard-rule gate (Ray's insight): at least two long-duration
  -- named relationships (romantic or not) must be confirmed before
  -- advancement past a given status.
  long_term_named_confirmed INTEGER   NOT NULL DEFAULT 0,

  notes                     TEXT,

  -- Reserved for Phase 4 scoring.
  signal_score              INTEGER,
  form_score                INTEGER,

  created_at                INTEGER   NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at                INTEGER   NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_contacts_bucket_status ON contacts(bucket, status);
CREATE INDEX IF NOT EXISTS idx_contacts_updated_at   ON contacts(updated_at DESC);

-- ---------- messages ----------
-- One row per DM Ray captured (manually in Phase 2, via extension in Phase 3).
-- direction = 'in' from him, 'out' from her.
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source       TEXT    NOT NULL CHECK(source IN ('ig','tinder','bumble','fetlife','tiktok','x')),
  direction    TEXT    NOT NULL CHECK(direction IN ('in','out')),
  body         TEXT    NOT NULL,
  sent_at      INTEGER,
  ingested_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  raw_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, sent_at, id);

-- ---------- tags ----------
-- Free-form. Different from status: multiple per contact, unlimited vocabulary.
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(contact_id, tag)
);

-- ---------- follow-ups ----------
-- Reminders: "nudge in 3 days if no reply", "confirm meet-up on Sat", etc.
CREATE TABLE IF NOT EXISTS follow_ups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  remind_at     INTEGER NOT NULL,
  note          TEXT,
  completed_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_followups_open ON follow_ups(remind_at) WHERE completed_at IS NULL;

-- ---------- flags ----------
-- Scoring evidence populated by Phase 4. Schema-in-advance so the UI
-- can already read flags per contact once Phase 4 lands.
CREATE TABLE IF NOT EXISTS flags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  rule_id     TEXT    NOT NULL,
  category    TEXT    NOT NULL CHECK(category IN ('positive','negative','gate')),
  weight      INTEGER NOT NULL,
  evidence    TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_flags_contact ON flags(contact_id, created_at DESC);

-- ---------- schema_meta ----------
CREATE TABLE IF NOT EXISTS schema_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('version', '1');
