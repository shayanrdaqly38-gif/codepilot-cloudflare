-- CodePilot D1 schema — mirrors functions/_lib/schema.js (SCHEMA_VERSION 10).
--
-- OPTIONAL: the app bootstraps and migrates this schema automatically on the
-- first request (ensureSchema), so running this file is not required. It exists
-- for transparency and for review: `npm run db:schema` executes it explicitly.
--
-- The CREATE statements are idempotent (IF NOT EXISTS), and the columns that
-- older deployments gained through migrations (v1 → v9) are already inlined
-- here, so a fresh database ends up identical to a fully-migrated one.

-- ---------------------------------------------------------------- users -----
CREATE TABLE IF NOT EXISTS users (
   owner TEXT PRIMARY KEY,
   email TEXT NOT NULL DEFAULT '',
   display_name TEXT NOT NULL DEFAULT '',
   created_at INTEGER NOT NULL,
   last_seen_at INTEGER NOT NULL,
   settings TEXT NOT NULL DEFAULT '{}'
);

-- -------------------------------------------------------- conversations -----
CREATE TABLE IF NOT EXISTS conversations (
   id TEXT PRIMARY KEY,
   owner TEXT NOT NULL,
   title TEXT NOT NULL DEFAULT 'گفتگوی جدید',
   created_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL,
   revision INTEGER NOT NULL DEFAULT 0,
   workspace TEXT NOT NULL DEFAULT '{}',
   summary TEXT NOT NULL DEFAULT '',
   summary_until INTEGER NOT NULL DEFAULT 0,
   summary_updated_at INTEGER NOT NULL DEFAULT 0,
   archived INTEGER NOT NULL DEFAULT 0,
   pinned INTEGER NOT NULL DEFAULT 0,
   message_count INTEGER NOT NULL DEFAULT 0,
   last_message_at INTEGER NOT NULL DEFAULT 0,
   last_model TEXT NOT NULL DEFAULT '',
   -- 'developer' = GitHub-linked workspace with legacy caps;
   -- 'normal'    = independent 1GB arena workspace, never synced to GitHub.
   mode TEXT NOT NULL DEFAULT 'developer'
);
CREATE INDEX IF NOT EXISTS conversations_owner_updated
   ON conversations(owner, archived, updated_at DESC);

-- ------------------------------------------------------------- messages -----
CREATE TABLE IF NOT EXISTS messages (
   conversation_id TEXT NOT NULL,
   seq INTEGER NOT NULL,
   created_at INTEGER NOT NULL,
   body TEXT NOT NULL,
   role TEXT NOT NULL DEFAULT '',
   PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages(conversation_id, seq);

-- ------------------------------------------------------------- memories -----
CREATE TABLE IF NOT EXISTS memories (
   id TEXT PRIMARY KEY,
   owner TEXT NOT NULL,
   scope TEXT NOT NULL DEFAULT 'global',
   project TEXT NOT NULL DEFAULT '',
   key TEXT NOT NULL,
   value TEXT NOT NULL,
   created_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_owner_scope_key
   ON memories(owner, scope, project, key);

-- --------------------------------------------------------- usage_daily -----
CREATE TABLE IF NOT EXISTS usage_daily (
   owner TEXT NOT NULL,
   day TEXT NOT NULL,
   requests INTEGER NOT NULL DEFAULT 0,
   input_chars INTEGER NOT NULL DEFAULT 0,
   output_chars INTEGER NOT NULL DEFAULT 0,
   prompt_tokens INTEGER NOT NULL DEFAULT 0,
   completion_tokens INTEGER NOT NULL DEFAULT 0,
   reasoning_tokens INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY (owner, day)
);

-- ------------------------------------------------------- file_versions -----
CREATE TABLE IF NOT EXISTS file_versions (
   id TEXT PRIMARY KEY,
   owner TEXT NOT NULL,
   conversation_id TEXT NOT NULL DEFAULT '',
   project TEXT NOT NULL DEFAULT '',
   path TEXT NOT NULL,
   content TEXT NOT NULL,
   reason TEXT NOT NULL DEFAULT 'edit',
   created_by TEXT NOT NULL DEFAULT 'agent',
   created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS file_versions_lookup
   ON file_versions(owner, project, path, created_at DESC);

-- -------------------------------------------------------- rate_limits -----
CREATE TABLE IF NOT EXISTS rate_limits (
   bucket TEXT PRIMARY KEY,
   count INTEGER NOT NULL DEFAULT 0,
   reset_at INTEGER NOT NULL
);

-- ------------------------------------------------------ workspace_files ----
CREATE TABLE IF NOT EXISTS workspace_files (
   conversation_id TEXT NOT NULL,
   path TEXT NOT NULL,
   content TEXT NOT NULL,
   updated_at INTEGER NOT NULL,
   -- Exact UTF-8 size of the stored file (content + chunks) for budget checks.
   bytes INTEGER NOT NULL DEFAULT 0,
   -- 1 = real content lives in workspace_file_chunks, content column is ''.
   chunked INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY (conversation_id, path)
);

-- ------------------------------------------------- workspace_file_chunks --
-- Chunked overflow storage: any file whose UTF-8 payload exceeds a single safe
-- D1 row (~1MB cap) is split into ≤700KB parts here so normal-mode workspaces
-- can grow to a real 1GB total. Reassembled by loadWorkspaceFile().
CREATE TABLE IF NOT EXISTS workspace_file_chunks (
   conversation_id TEXT NOT NULL,
   path TEXT NOT NULL,
   part INTEGER NOT NULL,
   data TEXT NOT NULL,
   PRIMARY KEY (conversation_id, path, part)
);

-- ------------------------------------------------- active turns (v10) ----
-- Cross-isolate visibility of in-flight turns: a turn keeps running after
-- the client disconnects (headless mode), so any isolate must be able to
-- (a) see that a conversation is busy, (b) request a graceful stop.
CREATE TABLE IF NOT EXISTS active_turns (
   conversation_id TEXT PRIMARY KEY,
   owner TEXT NOT NULL,
   started_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL,
   stop_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS active_turns_owner
   ON active_turns(owner, started_at);

-- -------------------------------------------------------------- uploads ----
CREATE TABLE IF NOT EXISTS uploads (
   id TEXT PRIMARY KEY,
   owner TEXT NOT NULL,
   name TEXT NOT NULL,
   type TEXT NOT NULL,
   size INTEGER NOT NULL,
   chunks INTEGER NOT NULL,
   received INTEGER NOT NULL DEFAULT 0,
   created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_chunks (
   upload_id TEXT NOT NULL,
   part INTEGER NOT NULL,
   data TEXT NOT NULL,
   PRIMARY KEY (upload_id, part)
);
CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner, created_at);

-- ---------------------------------------------------- generated_images ----
CREATE TABLE IF NOT EXISTS generated_images (
   id TEXT PRIMARY KEY,
   owner TEXT NOT NULL,
   conversation_id TEXT NOT NULL DEFAULT '',
   title TEXT NOT NULL DEFAULT '',
   prompt TEXT NOT NULL,
   enhanced_prompt TEXT NOT NULL DEFAULT '',
   style TEXT NOT NULL DEFAULT 'auto',
   aspect_ratio TEXT NOT NULL DEFAULT '1:1',
   width INTEGER NOT NULL DEFAULT 1024,
   height INTEGER NOT NULL DEFAULT 1024,
   engine TEXT NOT NULL DEFAULT '',
   model TEXT NOT NULL DEFAULT '',
   mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
   byte_size INTEGER NOT NULL DEFAULT 0,
   chunks INTEGER NOT NULL DEFAULT 1,
   created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS generated_image_chunks (
   image_id TEXT NOT NULL,
   part INTEGER NOT NULL,
   data TEXT NOT NULL,
   PRIMARY KEY (image_id, part)
);
CREATE INDEX IF NOT EXISTS generated_images_owner_created
   ON generated_images(owner, created_at DESC);

-- ------------------------------------------------------------------ meta ----
CREATE TABLE IF NOT EXISTS meta (
   key TEXT PRIMARY KEY,
   value TEXT NOT NULL
);
INSERT INTO meta(key, value) VALUES ('schema_version', '10')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value;
