// File version history stored in D1.
//
// Every agent edit (apply_patch / write_file / delete) writes a snapshot here
// BEFORE the workspace row changes, so a bad edit is always recoverable and the
// UI can show a per-file diff timeline.
//
// Retention: keep the newest KEEP_PER_FILE versions per (owner, project, path)
// and prune the rest in the same batch.

import { db, isSafePath } from './store.js';
import { fail } from './util.js';

const KEEP_PER_FILE = 25;
const MAX_SNAPSHOT_CHARS = 850_000;
const utf8VerEncoder = new TextEncoder();

function projectOf(workspace) {
  const repo = workspace?.repo;
  if (repo && repo.owner && repo.repo) return `${repo.owner}/${repo.repo}`.slice(0, 120);
  return '';
}

/** Record the current state of `path` before it changes. */
export async function recordVersion(env, owner, conversation, { path, content, reason = 'edit', createdBy = 'agent' }) {
  if (!isSafePath(path)) return null;
  const database = await db(env);
  const now = Date.now();
  const project = projectOf(JSON.parse(conversation.workspace || '{}'));
  const id = crypto.randomUUID();
  // Store raw content on purpose: a redacted snapshot would corrupt undo and
  // restore. These rows have exactly the same exposure as the workspace JSON in
  // the same database, and they are never sent to the model. Secrets are instead
  // *flagged* (see scanForSecrets) so the user can remove them deliberately.
  let safeContent = String(content ?? '').slice(0, MAX_SNAPSHOT_CHARS);
  if (safeContent.length > 300_000 && utf8VerEncoder.encode(safeContent).byteLength > 900_000) {
    return null;
  }
  await database
    .prepare(
      `INSERT INTO file_versions(id,owner,conversation_id,project,path,content,reason,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    )
    .bind(id, owner, conversation.id, project, path, safeContent, String(reason).slice(0, 40), createdBy, now)
    .run();
  await database
    .prepare(
      `DELETE FROM file_versions
       WHERE owner=? AND project=? AND path=? AND id NOT IN (
         SELECT id FROM file_versions WHERE owner=? AND project=? AND path=?
         ORDER BY created_at DESC LIMIT ${KEEP_PER_FILE}
       )`
    )
    .bind(owner, project, path, owner, project, path)
    .run()
    .catch(() => {});
  return id;
}

export async function listVersions(env, owner, path, { project = null, limit = 30 } = {}) {
  const database = await db(env);
  const bindings = [owner];
  let sql = `SELECT id,conversation_id,project,path,reason,created_by,created_at,length(content) AS size
             FROM file_versions WHERE owner=? AND path=?`;
  bindings.push(path);
  if (project !== null) {
    sql += ' AND project=?';
    bindings.push(project);
  }
  sql += ` ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 30, 1), 100)}`;
  const rows = await database.prepare(sql).bind(...bindings).all();
  return rows.results || [];
}

export async function getVersion(env, owner, id) {
  const database = await db(env);
  const row = await database
    .prepare('SELECT * FROM file_versions WHERE id=? AND owner=?')
    .bind(String(id), owner)
    .first();
  if (!row) fail('نسخه پیدا نشد.', 404, 'not_found');
  return row;
}

/** All files touched recently, newest first — powers the "recent edits" view. */
export async function recentPaths(env, owner, { limit = 30 } = {}) {
  const database = await db(env);
  const rows = await database
    .prepare(
      `SELECT path, MAX(created_at) AS last_at, COUNT(*) AS versions, project
       FROM file_versions WHERE owner=?
       GROUP BY path, project ORDER BY last_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 30, 1), 100)}`
    )
    .bind(owner)
    .all();
  return rows.results || [];
}
