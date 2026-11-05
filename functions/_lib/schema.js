// D1 schema + idempotent bootstrap.
// Cloudflare Pages D1 runs SQLite, so `CREATE TABLE IF NOT EXISTS` plus
// versioned ALTERs let old databases (from the first prototype) upgrade in place.

export const SCHEMA_VERSION = 3;

const CREATE = [
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
    ['last_model', "TEXT NOT NULL DEFAULT ''"]
  ],
  messages: [['role', "TEXT NOT NULL DEFAULT ''"]],
  users: [['settings', "TEXT NOT NULL DEFAULT '{}'"]],
  memories: [],
  usage_daily: [],
  rate_limits: [],
  meta: []
};

// One bootstrap per database binding (not merely per isolate): this keeps the
// migration idempotent when a worker is scoped to a different D1 database, and
// automatically retries if the first attempt failed.
const ready = new WeakMap();

/** Ensure the schema exists. */
export function ensureSchema(env) {
  if (!env.DB) {
    const error = new Error('D1 binding DB is missing.');
    error.status = 503;
    error.code = 'db_missing';
    throw error;
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

  // Backfill role for rows written by the prototype (body holds the JSON message).
  await env.DB.prepare(
    `UPDATE messages SET role = COALESCE(json_extract(body,'$.role'),'') WHERE role = ''`
  ).run().catch(() => {});

  await env.DB.prepare(
    `INSERT INTO meta(key,value) VALUES('schema_version',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).bind(String(SCHEMA_VERSION)).run();
}
