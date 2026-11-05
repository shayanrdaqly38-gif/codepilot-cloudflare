-- CodePilot persistent memory schema (Cloudflare D1 / SQLite)
-- The app also bootstraps this automatically on first request, but running it
-- manually makes the database explicit and lets you inspect it.
--
--   npx wrangler d1 execute codepilot-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per Cloudflare Access identity. `owner` = "<issuer>|<subject>", so a
-- display-name or email change never splits a user's history.
CREATE TABLE IF NOT EXISTS users (
  owner        TEXT PRIMARY KEY,
  email        TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  settings     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversations (
  id                 TEXT PRIMARY KEY,
  owner              TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT 'گفتگوی جدید',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  workspace          TEXT NOT NULL DEFAULT '{}',
  summary            TEXT NOT NULL DEFAULT '',
  summary_until      INTEGER NOT NULL DEFAULT 0,
  summary_updated_at INTEGER NOT NULL DEFAULT 0,
  message_count      INTEGER NOT NULL DEFAULT 0,
  last_message_at    INTEGER NOT NULL DEFAULT 0,
  last_model         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS conversations_owner_updated
  ON conversations(owner, archived, updated_at DESC);

-- `seq` is the durable ordering key. `body` is the exact Chat Completions
-- message JSON (role, content, tool_calls, tool_call_id), so replays are valid.
CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  role            TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages(conversation_id, seq);

-- Explicit long-term memory, visible and editable by the user.
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'global',
  project    TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS memories_owner_scope_key
  ON memories(owner, scope, project, key);

CREATE TABLE IF NOT EXISTS usage_daily (
  owner        TEXT NOT NULL,
  day          TEXT NOT NULL,
  requests     INTEGER NOT NULL DEFAULT 0,
  input_chars  INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, day)
);

-- Sliding per-owner request counters (protects the model budget).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

INSERT INTO meta(key, value) VALUES ('schema_version', '3')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
