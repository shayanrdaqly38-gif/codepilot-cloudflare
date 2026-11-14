// File version history stored in D1.
//
// Every agent edit (apply_patch / write_file / delete_file) writes a snapshot
// BEFORE the workspace row changes, along with:
//   - `batch_id`: groups multi-file atomic operations for transactional group rollback
//   - `content_hash`: hash of the saved pre-edit content
//   - `after_hash`: hash of the file immediately AFTER the edit (detects external/subsequent changes)
//   - `existed`: 1 if the file existed before the edit, 0 if the edit created a brand-new file
//   - `meta`: JSON metadata (formatting, EOL/BOM, operation summary)
//
// Retention: keep the newest KEEP_PER_FILE versions per (owner, project, path)
// and prune the rest in the same batch.

import { db, isSafePath } from './store.js';
import { hashContent } from './patch.js';
import { fail } from './util.js';

const KEEP_PER_FILE = 60;
const MAX_SNAPSHOT_CHARS = 850_000;
const utf8VerEncoder = new TextEncoder();
export const DELETED_SENTINEL_HASH = '__DELETED__';

function projectOf(workspace) {
  const repo = workspace?.repo;
  if (repo && repo.owner && repo.repo) return `${repo.owner}/${repo.repo}`.slice(0, 120);
  return '';
}

export function versionContentHash(content, exists = true) {
  if (!exists) return DELETED_SENTINEL_HASH;
  return hashContent(String(content ?? ''));
}

function safeParseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Record the current state of `path` before it changes. */
export async function recordVersion(
  env,
  owner,
  conversation,
  {
    path,
    content,
    reason = 'edit',
    createdBy = 'agent',
    batchId = '',
    afterContent = undefined,
    afterHash = '',
    existed = true,
    meta = null
  }
) {
  if (!isSafePath(path)) return null;
  const database = await db(env);
  const now = Date.now();
  const parsedWs =
    typeof conversation?.workspace === 'string'
      ? JSON.parse(conversation.workspace || '{}')
      : conversation?.workspace && typeof conversation.workspace === 'object'
        ? conversation.workspace
        : {};
  const project = projectOf(parsedWs);
  const id = crypto.randomUUID();
  // Store raw content on purpose: a redacted snapshot would corrupt undo and
  // restore. These rows have exactly the same exposure as the workspace JSON in
  // the same database, and they are never sent to the model.
  const existedFlag = existed ? 1 : 0;
  const safeContent = existedFlag ? String(content ?? '').slice(0, MAX_SNAPSHOT_CHARS) : '';
  if (safeContent.length > 300_000 && utf8VerEncoder.encode(safeContent).byteLength > 900_000) {
    return null;
  }
  const contentHash = versionContentHash(safeContent, Boolean(existedFlag));
  let resolvedAfterHash = String(afterHash || '');
  if (!resolvedAfterHash && afterContent !== undefined) {
    resolvedAfterHash = afterContent === null ? DELETED_SENTINEL_HASH : versionContentHash(afterContent, true);
  }
  const safeBatchId = String(batchId || '').slice(0, 80);
  const metaJson = JSON.stringify(meta && typeof meta === 'object' ? meta : {}).slice(0, 2000);

  await database
    .prepare(
      `INSERT INTO file_versions(
         id,owner,conversation_id,project,path,content,reason,created_by,created_at,
         batch_id,content_hash,after_hash,existed,meta
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      owner,
      conversation.id,
      project,
      path,
      safeContent,
      String(reason).slice(0, 40),
      createdBy,
      now,
      safeBatchId,
      contentHash,
      resolvedAfterHash,
      existedFlag,
      metaJson
    )
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

/** Delete snapshots created under a failed transactional batchId. */
export async function deleteBatchVersions(env, owner, batchId) {
  if (!batchId) return;
  const database = await db(env);
  await database
    .prepare('DELETE FROM file_versions WHERE owner=? AND batch_id=?')
    .bind(owner, String(batchId))
    .run()
    .catch(() => {});
}

export async function listVersions(env, owner, path, { project = null, limit = 30 } = {}) {
  const database = await db(env);
  const bindings = [owner];
  let sql = `SELECT id,conversation_id,project,path,reason,created_by,created_at,
                    length(content) AS size,batch_id,content_hash,after_hash,existed,meta
             FROM file_versions WHERE owner=? AND path=?`;
  bindings.push(path);
  if (project !== null) {
    sql += ' AND project=?';
    bindings.push(project);
  }
  sql += ` ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 30, 1), 100)}`;
  const rows = await database.prepare(sql).bind(...bindings).all();
  return (rows.results || []).map((row) => ({
    ...row,
    existed: row.existed === undefined ? 1 : Number(row.existed),
    metaObj: safeParseMeta(row.meta)
  }));
}

export async function getVersion(env, owner, id) {
  const database = await db(env);
  const row = await database
    .prepare('SELECT * FROM file_versions WHERE id=? AND owner=?')
    .bind(String(id), owner)
    .first();
  if (!row) fail('نسخه پیدا نشد.', 404, 'not_found');
  return {
    ...row,
    existed: row.existed === undefined ? 1 : Number(row.existed),
    metaObj: safeParseMeta(row.meta)
  };
}

/** Return all snapshots recorded as part of a multi-file operation `batchId`. */
export async function listBatchVersions(env, owner, batchId) {
  const cleanId = String(batchId || '').trim();
  if (!cleanId) fail('شناسه گروه (batchId) معتبر نیست.', 400, 'bad_batch_id');
  const database = await db(env);
  const rows = await database
    .prepare(
      `SELECT * FROM file_versions
       WHERE owner=? AND batch_id=?
       ORDER BY created_at DESC, path ASC`
    )
    .bind(owner, cleanId)
    .all();
  const list = (rows.results || []).map((row) => ({
    ...row,
    existed: row.existed === undefined ? 1 : Number(row.existed),
    metaObj: safeParseMeta(row.meta)
  }));
  if (!list.length) fail('گروه ویرایش (batchId) پیدا نشد.', 404, 'not_found');
  // Deduplicate by path (keep earliest pre-edit state if same file was recorded twice in one batch)
  const byPath = new Map();
  for (const item of list) {
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}

/** Recent multi-file / single-file batches for audit and group rollback. */
export async function listRecentBatches(env, owner, { conversationId = '', limit = 20 } = {}) {
  const database = await db(env);
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const bindings = [owner];
  let where = "owner=? AND batch_id<>''";
  if (conversationId) {
    where += ' AND conversation_id=?';
    bindings.push(String(conversationId));
  }
  const rows = await database
    .prepare(
      `SELECT batch_id, conversation_id, reason, created_by,
              MAX(created_at) AS created_at,
              COUNT(*) AS file_count,
              GROUP_CONCAT(path, ',') AS paths
       FROM file_versions
       WHERE ${where}
       GROUP BY batch_id
       ORDER BY created_at DESC
       LIMIT ${cap}`
    )
    .bind(...bindings)
    .all();
  return (rows.results || []).map((r) => ({
    batchId: r.batch_id,
    conversationId: r.conversation_id,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    fileCount: Number(r.file_count || 0),
    paths: String(r.paths || '')
      .split(',')
      .filter(Boolean)
  }));
}

/**
 * Check whether restoring `versionRow` onto the current workspace file would
 * overwrite changes made AFTER the edit that created `versionRow`.
 */
export function analyzeUndoConflict(versionRow, currentContent, currentExists = currentContent !== null && currentContent !== undefined) {
  const targetExists = versionRow.existed === undefined ? true : Number(versionRow.existed) !== 0;
  const targetContent = targetExists ? String(versionRow.content ?? '') : '';
  const targetHash = versionRow.content_hash || versionContentHash(targetContent, targetExists);
  const currentHash = versionContentHash(currentContent, Boolean(currentExists));
  const expectedAfterHash = String(versionRow.after_hash || '');

  const alreadyAtTarget =
    Boolean(currentExists) === targetExists && (!targetExists || String(currentContent ?? '') === targetContent);

  const hasConflict = Boolean(
    !alreadyAtTarget && expectedAfterHash && currentHash !== expectedAfterHash
  );

  return {
    path: versionRow.path,
    versionId: versionRow.id,
    batchId: versionRow.batch_id || '',
    reason: versionRow.reason || 'edit',
    createdBy: versionRow.created_by || 'agent',
    createdAt: versionRow.created_at,
    targetExists,
    currentExists: Boolean(currentExists),
    alreadyAtTarget,
    hasConflict,
    conflictReason: hasConflict
      ? currentExists
        ? 'فایل پس از این ویرایش دوباره تغییر کرده است؛ بازگردانی کورکورانه متوقف شد.'
        : 'فایل پس از این ویرایش حذف شده است؛ بازگردانی نیازمند تأیید است.'
      : '',
    currentHash,
    expectedAfterHash,
    targetHash
  };
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
