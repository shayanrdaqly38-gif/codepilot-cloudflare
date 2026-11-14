// D1 schema + idempotent bootstrap.

import { fail } from './util.js';
// Cloudflare Pages D1 runs SQLite, so `CREATE TABLE IF NOT EXISTS` plus
// versioned ALTERs let old databases (from the first prototype) upgrade in place.

export const SCHEMA_VERSION = 11;

const CREATE = [
  `CREATE TABLE IF NOT EXISTS generated_images (
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
  )`,
  `CREATE TABLE IF NOT EXISTS generated_image_chunks (
    image_id TEXT NOT NULL,
    part INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (image_id, part)
  )`,
  `CREATE INDEX IF NOT EXISTS generated_images_owner_created ON generated_images(owner, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS workspace_files (
    conversation_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, path)
  )`,
  // Chunked overflow storage for large workspace files: a file whose UTF-8
  // payload exceeds a single safe D1 row (~1MB cap) is split into ≤700KB
  // parts here so normal-mode workspaces can grow to a real 1GB total.
  `CREATE TABLE IF NOT EXISTS workspace_file_chunks (
    conversation_id TEXT NOT NULL,
    path TEXT NOT NULL,
    part INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (conversation_id, path, part)
  )`,
  // Cross-isolate visibility of in-flight turns: a turn keeps running after
  // the client disconnects (headless mode), so any isolate must be able to
  // (a) see that a conversation is busy, (b) request a graceful stop.
  `CREATE TABLE IF NOT EXISTS active_turns (
    conversation_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    turn_id TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    lease_expires_at INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS active_turns_owner ON active_turns(owner, started_at)`,
  // Idempotent admission ledger. A transport retry of the same request reads
  // this row instead of appending the user message or calling the model again.
  `CREATE TABLE IF NOT EXISTS turn_requests (
    owner TEXT NOT NULL,
    request_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL DEFAULT '',
    stop_requested INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    outcome TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (owner, request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS turn_requests_conv ON turn_requests(owner, conversation_id, created_at)`,
  // One row per outbound model HTTP attempt. The rolling 60s COUNT and the
  // running-lease COUNT are checked in the same atomic INSERT as the reservation.
  `CREATE TABLE IF NOT EXISTS provider_calls (
    call_id TEXT PRIMARY KEY,
    bucket TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'running'
  )`,
  `CREATE INDEX IF NOT EXISTS provider_calls_bucket_time ON provider_calls(bucket, started_at)`,
  `CREATE TABLE IF NOT EXISTS provider_limits (
    bucket TEXT PRIMARY KEY,
    cooldown_until INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL, chunks INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(upload_id, part)
  )`,
  `CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner, created_at)`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     owner TEXT PRIMARY KEY,
     email TEXT NOT NULL DEFAULT '',
     display_name TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     settings TEXT NOT NULL DEFAULT '{}'
   )`,
  // Table shells only. Columns are added by `migrate()` so databases created by
  // older versions get the new columns without touching existing data.
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT 'گفتگوی جدید',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     revision INTEGER NOT NULL DEFAULT 0,
     workspace TEXT NOT NULL DEFAULT '{}',
     summary TEXT NOT NULL DEFAULT '',
     summary_until INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     conversation_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     body TEXT NOT NULL,
     PRIMARY KEY (conversation_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     scope TEXT NOT NULL DEFAULT 'global',
     project TEXT NOT NULL DEFAULT '',
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS usage_daily (
     owner TEXT NOT NULL,
     day TEXT NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0,
     input_chars INTEGER NOT NULL DEFAULT 0,
     output_chars INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (owner, day)
   )`,
  `CREATE TABLE IF NOT EXISTS file_versions (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     conversation_id TEXT NOT NULL DEFAULT '',
     project TEXT NOT NULL DEFAULT '',
     path TEXT NOT NULL,
     content TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT 'edit',
     created_by TEXT NOT NULL DEFAULT 'agent',
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS file_versions_lookup
     ON file_versions(owner, project, path, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     bucket TEXT PRIMARY KEY,
     count INTEGER NOT NULL DEFAULT 0,
     reset_at INTEGER NOT NULL
   )`
];

// Indexes that depend on migrated columns are created after `migrate()`.
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS conversations_owner_updated
     ON conversations(owner, archived, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages(conversation_id, seq)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS memories_owner_scope_key
     ON memories(owner, scope, project, key)`
];

// Columns added after v1. Each entry is applied only when missing.
const COLUMNS = {
  conversations: [
    ['archived', 'INTEGER NOT NULL DEFAULT 0'],
    ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
    ['summary_updated_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['message_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_message_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_model', "TEXT NOT NULL DEFAULT ''"],
    // 'developer' (GitHub-linked, legacy caps) | 'normal' (independent 1GB arena workspace)
    ['mode', "TEXT NOT NULL DEFAULT 'developer'"]
  ],
  workspace_files: [
    // Exact UTF-8 size of the stored file (content + chunks) for budget checks
    ['bytes', 'INTEGER NOT NULL DEFAULT 0'],
    // 1 = real content lives in workspace_file_chunks, content column is ''
    ['chunked', 'INTEGER NOT NULL DEFAULT 0']
  ],
  messages: [['role', "TEXT NOT NULL DEFAULT ''"]],
  users: [['settings', "TEXT NOT NULL DEFAULT '{}'"]],
  memories: [],
  usage_daily: [
    ['prompt_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['completion_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['reasoning_tokens', 'INTEGER NOT NULL DEFAULT 0']
  ],
  rate_limits: [],
  file_versions: [],
  meta: [],
  active_turns: [
    ['turn_id', "TEXT NOT NULL DEFAULT ''"],
    ['request_id', "TEXT NOT NULL DEFAULT ''"],
    ['lease_expires_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['state', "TEXT NOT NULL DEFAULT ''"]
  ],
  turn_requests: [],
  provider_calls: [],
  provider_limits: []
};

// One bootstrap per database binding (not merely per isolate): this keeps the
// migration idempotent when a worker is scoped to a different D1 database, and
// automatically retries if the first attempt failed.
const ready = new WeakMap();

/** Ensure the schema exists. */
export function ensureSchema(env) {
  if (!env.DB) {
    // Use the shared HttpError so the client gets a precise 503 + code instead
    // of a generic "unexpected server error". A plain Error with .status was
    // silently degrading to 500.
    fail('بایندینگ D1 با نام DB پیدا نشد. در Pages → Settings → Functions → D1 bindings آن را با نام DB اضافه کنید.', 503, 'db_missing');
  }
  const cached = ready.get(env.DB);
  if (cached) return cached;
  const attempt = bootstrap(env).catch((error) => {
    ready.delete(env.DB);
    throw error;
  });
  ready.set(env.DB, attempt);
  return attempt;
}

async function bootstrap(env) {
  // Fast-path for already-bootstrapped production D1 databases: avoids ~28 DDL/PRAGMA
  // round-trips and a full-table `messages` scan on every cold Cloudflare Worker isolate!
  try {
    const ver = await env.DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first();
    if (ver && String(ver.value) === String(SCHEMA_VERSION)) {
      return;
    }
  } catch {
    // `meta` table doesn't exist yet on a fresh or v0 database — proceed with full bootstrap.
  }

  await env.DB.batch(CREATE.map((sql) => env.DB.prepare(sql)));

  for (const [table, columns] of Object.entries(COLUMNS)) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const existing = new Set((info.results || []).map((row) => row.name));
    const missing = columns.filter(([name]) => !existing.has(name));
    if (!missing.length) continue;
    for (const [name, type] of missing) {
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
      } catch (error) {
        // Another isolate may have added it a moment ago.
        if (!/duplicate column/i.test(String(error && error.message))) throw error;
      }
    }
  }

  for (const sql of INDEXES) {
    await env.DB.prepare(sql).run().catch(() => {});
  }

  // Backfill role only when upgrading from legacy v1 schema.
  await env.DB.prepare(
    `UPDATE messages SET role = COALESCE(json_extract(body,'$.role'),'') WHERE role = ''`
  ).run().catch(() => {});

  await env.DB.prepare(
    `INSERT INTO meta(key,value) VALUES('schema_version',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).bind(String(SCHEMA_VERSION)).run();
}
