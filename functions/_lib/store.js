// D1 data access layer: users, conversations, messages, memory, usage.
// Every query is scoped by owner; there is no API path that reads another
// user's row.

import { ensureSchema } from './schema.js';
import { validateAttachments } from './attachments.js';
import { clamp, fail, redactCode, redactSecrets, safeInt } from './util.js';

const MAX_CONVERSATIONS_PER_USER = 300;
const MAX_MESSAGES_PER_CONVERSATION = 4000;
const MAX_WORKSPACE_CHARS = 6_000_000;
const INLINE_WORKSPACE_MAX_BYTES = 900_000;
const MAX_TITLE = 120;
const utf8Encoder = new TextEncoder();

export async function db(env) {
  await ensureSchema(env);
  return env.DB;
}

/* ---------------------------------- users --------------------------------- */

export async function upsertUser(env, identity) {
  const database = await db(env);
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO users(owner,email,display_name,created_at,last_seen_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(owner) DO UPDATE SET
         email=excluded.email,
         display_name=CASE WHEN excluded.display_name<>'' THEN excluded.display_name ELSE users.display_name END,
         last_seen_at=excluded.last_seen_at`
    )
    .bind(identity.owner, identity.email || '', identity.name || '', now, now)
    .run();
}

export async function getUser(env, owner) {
  const database = await db(env);
  return database.prepare('SELECT * FROM users WHERE owner=?').bind(owner).first();
}

/* ------------------------------ conversations ----------------------------- */

const CONVERSATION_COLUMNS = `id,title,created_at,updated_at,revision,archived,pinned,
  message_count,last_message_at,last_model,summary_until`;

export async function listConversations(env, owner, { archived = null, limit = 200 } = {}) {
  const database = await db(env);
  const capped = clamp(safeInt(limit, 200), 1, 300);
  const where = archived === null ? 'owner=?' : 'owner=? AND archived=?';
  const bindings = archived === null ? [owner] : [owner, archived ? 1 : 0];
  const rows = await database
    .prepare(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
       WHERE ${where}
       ORDER BY pinned DESC, updated_at DESC
       LIMIT ?`
    )
    .bind(...bindings, capped)
    .all();
  return rows.results || [];
}

export async function createConversation(env, owner, { title = 'گفتگوی جدید', workspace = {}, copyWorkspaceFrom = '' } = {}) {
  const database = await db(env);
  const count = await database
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE owner=?')
    .bind(owner)
    .first();
  if ((count?.n || 0) >= MAX_CONVERSATIONS_PER_USER) {
    fail('تعداد گفتگوها به سقف رسیده است؛ چند گفتگوی قدیمی را حذف کنید.', 409, 'quota');
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const cleanTitle = sanitizeTitle(title);

  // Zero-upload server-side clone when starting a new chat from an active conversation:
  // avoids uploading/re-parsing 1–3 MB of workspace files over slow mobile networks!
  if (typeof copyWorkspaceFrom === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(copyWorkspaceFrom)) {
    const src = await database
      .prepare('SELECT id, workspace FROM conversations WHERE id=? AND owner=?')
      .bind(copyWorkspaceFrom, owner)
      .first();
    if (src) {
      await database.batch([
        database
          .prepare(
            `INSERT INTO conversations(id,owner,title,created_at,updated_at,workspace,last_message_at)
             VALUES(?,?,?,?,?,?,?)`
          )
          .bind(id, owner, cleanTitle, now, now, src.workspace || '{}', now),
        database
          .prepare(
            `INSERT INTO workspace_files(conversation_id,path,content,updated_at)
             SELECT ?, path, content, ? FROM workspace_files WHERE conversation_id=?`
          )
          .bind(id, now, src.id)
      ]);
      return id;
    }
  }

  const safe = safeWorkspace(workspace);
  const inlineJson = JSON.stringify(safe);
  const byteLen = utf8Encoder.encode(inlineJson).byteLength;
  if (byteLen <= INLINE_WORKSPACE_MAX_BYTES) {
    await database
      .prepare(
        `INSERT INTO conversations(id,owner,title,created_at,updated_at,workspace,last_message_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .bind(id, owner, cleanTitle, now, now, inlineJson, now)
      .run();
  } else {
    const pointerJson = JSON.stringify({
      __externalFiles: true,
      active: safe.active,
      repo: safe.repo,
      files: {}
    });
    const fileRows = Object.entries(safe.files).map(([path, content]) => [id, path, content, now]);
    await database.batch([
      database
        .prepare(
          `INSERT INTO conversations(id,owner,title,created_at,updated_at,workspace,last_message_at)
           VALUES(?,?,?,?,?,?,?)`
        )
        .bind(id, owner, cleanTitle, now, now, pointerJson, now),
      ...insertRows(database, 'workspace_files', ['conversation_id', 'path', 'content', 'updated_at'], fileRows)
    ]);
  }
  return id;
}

export async function getConversation(env, owner, id) {
  // Accepts UUIDs and short ids written by the earlier prototype.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    fail('شناسه‌ی گفتگو نامعتبر است.', 400, 'bad_id');
  }
  const database = await db(env);
  const row = await database
    .prepare('SELECT * FROM conversations WHERE id=? AND owner=?')
    .bind(id, owner)
    .first();
  if (!row) fail('گفتگو پیدا نشد.', 404, 'not_found');
  return row;
}

export async function renameConversation(env, owner, id, title) {
  const conversation = await getConversation(env, owner, id);
  const next = sanitizeTitle(title);
  await (await db(env))
    .prepare('UPDATE conversations SET title=?, updated_at=?, revision=revision+1 WHERE id=? AND owner=? AND revision=?')
    .bind(next, Date.now(), conversation.id, owner, conversation.revision)
    .run();
  return { id: conversation.id, title: next };
}

export async function setConversationFlags(env, owner, id, flags) {
  const conversation = await getConversation(env, owner, id);
  const archived = flags.archived === undefined ? conversation.archived : flags.archived ? 1 : 0;
  const pinned = flags.pinned === undefined ? conversation.pinned : flags.pinned ? 1 : 0;
  await (await db(env))
    .prepare('UPDATE conversations SET archived=?, pinned=?, updated_at=? WHERE id=? AND owner=?')
    .bind(archived, pinned, Date.now(), conversation.id, owner)
    .run();
  return { id: conversation.id, archived: Boolean(archived), pinned: Boolean(pinned) };
}

export async function deleteConversation(env, owner, id) {
  const conversation = await getConversation(env, owner, id);
  const database = await db(env);
  await database.batch([
    database.prepare('DELETE FROM workspace_files WHERE conversation_id=?').bind(conversation.id),
    database.prepare('DELETE FROM messages WHERE conversation_id=?').bind(conversation.id),
    database.prepare('DELETE FROM conversations WHERE id=? AND owner=?').bind(conversation.id, owner)
  ]);
  return { id: conversation.id, deleted: true };
}

/* --------------------------------- messages -------------------------------- */

function slimMessageForLiteUi(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  let out = msg;
  if (Array.isArray(out.attachments) && out.attachments.some((a) => typeof a?.data === 'string' && a.data.length > 300_000)) {
    out = {
      ...out,
      attachments: out.attachments.map((a) =>
        typeof a?.data === 'string' && a.data.length > 300_000
          ? { name: a.name, type: a.type, size: Math.floor((a.data.length / 4) * 3) }
          : a
      )
    };
  }
  if (out.role === 'tool' && typeof out.content === 'string' && out.content.length > 4200) {
    out = { ...out, content: out.content.slice(0, 4200) + '\n…' };
  }
  if (out.role === 'assistant' && Array.isArray(out.tool_calls) && out.tool_calls.length) {
    let changed = false;
    const slimCalls = out.tool_calls.map((call) => {
      const name = call?.function?.name || '';
      const args = String(call?.function?.arguments || '');
      const cap = name === 'think' ? 4500 : 240;
      if (args.length <= cap) return call;
      changed = true;
      return {
        ...call,
        function: {
          ...call.function,
          arguments: args.slice(0, cap)
        }
      };
    });
    if (changed) out = { ...out, tool_calls: slimCalls };
  }
  return out;
}

export async function listMessagesPage(env, conversationId, { limit = 100, beforeSeq = null, lite = false } = {}) {
  const database = await db(env);
  const pageSize = clamp(safeInt(limit, 100), 1, 500);
  const fetchCount = pageSize + 1;
  const hasBefore = beforeSeq !== null && beforeSeq !== undefined && Number.isFinite(Number(beforeSeq));
  const rows = hasBefore
    ? await database
        .prepare(
          `SELECT seq,created_at,body FROM messages
           WHERE conversation_id=? AND seq<?
           ORDER BY seq DESC LIMIT ?`
        )
        .bind(conversationId, Math.floor(Number(beforeSeq)), fetchCount)
        .all()
    : await database
        .prepare(
          `SELECT seq,created_at,body FROM messages
           WHERE conversation_id=?
           ORDER BY seq DESC LIMIT ?`
        )
        .bind(conversationId, fetchCount)
        .all();

  const rawList = rows.results || [];
  const hasOlderMessages = rawList.length > pageSize;
  const slice = hasOlderMessages ? rawList.slice(0, pageSize) : rawList;
  slice.reverse();

  const messages = [];
  for (const row of slice) {
    try {
      const body = JSON.parse(row.body);
      const parsed = { ...body, seq: row.seq, created_at: row.created_at };
      messages.push(lite ? slimMessageForLiteUi(parsed) : parsed);
    } catch {
      messages.push({ role: 'assistant', content: '[پیام خراب حذف شد]', seq: row.seq, created_at: row.created_at });
    }
  }
  return {
    messages,
    hasOlderMessages,
    oldestSeq: messages.length ? messages[0].seq : null
  };
}

export async function listMessages(env, conversationId, { afterSeq = -1, limit = 6000 } = {}) {
  const database = await db(env);
  const rows = await database
    .prepare(
      `SELECT seq,created_at,body FROM messages
       WHERE conversation_id=? AND seq>?
       ORDER BY seq ASC LIMIT ?`
    )
    .bind(conversationId, safeInt(afterSeq, -1), clamp(safeInt(limit, 6000), 1, 8000))
    .all();
  const out = [];
  for (const row of rows.results || []) {
    try {
      const body = JSON.parse(row.body);
      out.push({ ...body, seq: row.seq, created_at: row.created_at });
    } catch {
      // Corrupt row: keep a placeholder so seq numbering stays stable.
      out.push({ role: 'assistant', content: '[پیام خراب حذف شد]', seq: row.seq, created_at: row.created_at });
    }
  }
  return out;
}

export async function messageStats(env, conversationId) {
  const database = await db(env);
  const row = await database
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq),-1) AS last FROM messages WHERE conversation_id=?')
    .bind(conversationId)
    .first();
  // seq is 1-based, so an empty conversation's last seq is 0, not -1. The old
  // -1 made the first stored message land on seq=0 and every nextSeq one short.
  const lastSeq = Math.max(row?.last ?? -1, 0);
  return { count: row?.n || 0, lastSeq };
}

/**
 * Sanitize a message before it is written to D1.
 * Credentials must never be persisted, no matter which endpoint wrote them.
 */
export function sanitizeStoredMessage(message) {
  const role = ['user', 'assistant', 'tool', 'system'].includes(message?.role) ? message.role : 'assistant';
  const out = {
    role,
    content: redactSecrets(typeof message?.content === 'string' ? message.content : ''),
    created_at: safeInt(message?.created_at, Date.now()) || Date.now()
  };
  if (role === 'user' && Array.isArray(message?.attachments) && message.attachments.length) {
    out.attachments = validateAttachments(message.attachments);
  }
  if (role === 'assistant') {
    if (typeof message?.reasoning === 'string' && message.reasoning.trim()) {
      out.reasoning = redactSecrets(message.reasoning).slice(0, 10_000);
    }
    if (
      typeof message?.reasoning_effort === 'string' &&
      /^(none|minimal|low|medium|high|xhigh|max)$/.test(message.reasoning_effort)
    ) {
      out.reasoning_effort = message.reasoning_effort;
    }
    if (Number.isInteger(message?.reasoning_tokens) && message.reasoning_tokens > 0) {
      out.reasoning_tokens = message.reasoning_tokens;
    }
  }
  if (role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    out.tool_calls = message.tool_calls
      .filter((call) => call && /^[\w-]{1,128}$/.test(String(call.id || '')) && typeof call.function?.name === 'string')
      .slice(0, 20)
      .map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name.slice(0, 64),
          arguments: redactCode(String(call.function.arguments ?? '{}')).slice(0, 60_000)
        }
      }));
  }
  if (role === 'tool' && typeof message?.tool_call_id === 'string') {
    out.tool_call_id = message.tool_call_id.slice(0, 128);
  }
  if (typeof message?.seq === 'number') out.seq = message.seq;
  return out;
}

/**
 * Build one multi-row INSERT.
 *
 * The previous implementation emitted `INSERT ... SELECT ?,... UNION ALL SELECT
 * ?,...`, which D1 rejects once a turn stores more than a handful of messages:
 * "D1_ERROR: too many terms in compound SELECT". A turn with tool calls easily
 * appends 7+ messages, so a normal agent turn failed at the persist step after
 * the tools had already run -- the work was done but the reply was an error.
 *
 * Row-value syntax keeps the statement count at one regardless of chunk size.
 * Chunks stay small so the bound-parameter limit is never the next wall we hit.
 */
function insertRows(database, table, columns, rows) {
  const statements = [];
  const width = columns.length;
  const perChunk = Math.max(1, Math.floor(90 / width));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const tuple = `(${columns.map(() => '?').join(',')})`;
    const sql = `INSERT INTO ${table}(${columns.join(',')}) VALUES ${chunk.map(() => tuple).join(',')}`;
    statements.push(database.prepare(sql).bind(...chunk.flat()));
  }
  return statements;
}

/** Insert messages after `lastSeq`, keeping seq contiguous (with optimistic retry on concurrent inserts). */
export async function appendMessages(env, conversation, messages) {
  const database = await db(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { count, lastSeq } = await messageStats(env, conversation.id);
    if (count + messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      fail('این گفتگو به سقف پیام رسیده است؛ گفتگوی جدیدی بسازید.', 409, 'quota');
    }
    const rows = messages.map((message, index) => {
      const clean = sanitizeStoredMessage(message);
      return [conversation.id, lastSeq + 1 + index, clean.created_at, clean.role || '', JSON.stringify(clean)];
    });
    const statements = insertRows(database, 'messages', ['conversation_id', 'seq', 'created_at', 'role', 'body'], rows);
    try {
      if (statements.length) await database.batch(statements);
      return { nextSeq: lastSeq + messages.length, inserted: messages.length };
    } catch (err) {
      if (attempt < 2 && /unique|constraint/i.test(String(err?.message || ''))) {
        continue;
      }
      throw err;
    }
  }
}

/** Replace the whole history (used by "rewind" / branch a conversation). */
export async function replaceMessages(env, conversation, messages) {
  const database = await db(env);
  const rows = messages.map((message, index) => {
    const clean = sanitizeStoredMessage(message);
    return [conversation.id, index + 1, clean.created_at, clean.role || '', JSON.stringify(clean)];
  });
  const statements = [
    database.prepare('DELETE FROM messages WHERE conversation_id=?').bind(conversation.id),
    ...insertRows(database, 'messages', ['conversation_id', 'seq', 'created_at', 'role', 'body'], rows)
  ];
  await database.batch(statements);
  return { count: messages.length };
}

/* -------------------------------- workspace ------------------------------- */

export function safeWorkspace(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const files = {};
  let approxChars = 64;
  const rawFiles = source.files && typeof source.files === 'object' && !Array.isArray(source.files) ? source.files : {};
  for (const [path, content] of Object.entries(rawFiles).slice(0, 200)) {
    if (!isSafePath(path) || typeof content !== 'string' || content.length > 400_000) continue;
    approxChars += path.length + content.length + 8;
    if (approxChars > MAX_WORKSPACE_CHARS) {
      fail('حجم فایل‌های کاری بیش از حد مجاز است.', 413, 'too_large');
    }
    files[path] = content;
  }
  return {
    files,
    active: typeof source.active === 'string' && files[source.active] !== undefined ? source.active : Object.keys(files)[0] || '',
    repo:
      source.repo && typeof source.repo === 'object'
        ? {
            owner: String(source.repo.owner || '').slice(0, 80),
            repo: String(source.repo.repo || '').slice(0, 120),
            branch: String(source.repo.branch || 'main').slice(0, 120)
          }
        : null
  };
}

export function isSafePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length < 240 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !/^(\.env|.*\.pem|.*\.key|id_rsa.*)$/i.test(path) &&
    !path.startsWith('.git/') &&
    !path.startsWith('.github/')
  );
}

export async function hydrateConversationWorkspace(env, conversation) {
  let parsed = {};
  try {
    parsed = JSON.parse(conversation?.workspace || '{}');
  } catch {
    parsed = {};
  }
  if (parsed && parsed.__externalFiles && conversation?.id) {
    const database = await db(env);
    const rows = await database
      .prepare('SELECT path, content FROM workspace_files WHERE conversation_id=? ORDER BY path ASC')
      .bind(conversation.id)
      .all();
    const files = {};
    for (const row of rows.results || []) {
      if (row && typeof row.path === 'string' && typeof row.content === 'string') {
        files[row.path] = row.content;
      }
    }
    return safeWorkspace({
      files,
      active: parsed.active,
      repo: parsed.repo
    });
  }
  return safeWorkspace(parsed);
}

export async function persistConversationWorkspace(
  env,
  owner,
  conversationId,
  workspace,
  { bumpRevision = false } = {}
) {
  const database = await db(env);
  const safe = safeWorkspace(workspace);
  const now = Date.now();
  const inlineJson = JSON.stringify(safe);
  const byteLen = utf8Encoder.encode(inlineJson).byteLength;
  const revClause = bumpRevision ? ', revision=revision+1' : '';

  if (byteLen <= INLINE_WORKSPACE_MAX_BYTES) {
    await database.batch([
      database.prepare('DELETE FROM workspace_files WHERE conversation_id=?').bind(conversationId),
      database
        .prepare(`UPDATE conversations SET workspace=?, updated_at=?${revClause} WHERE id=? AND owner=?`)
        .bind(inlineJson, now, conversationId, owner)
    ]);
  } else {
    const pointerJson = JSON.stringify({
      __externalFiles: true,
      active: safe.active,
      repo: safe.repo,
      files: {}
    });
    const fileRows = Object.entries(safe.files).map(([path, content]) => [conversationId, path, content, now]);
    await database.batch([
      database.prepare('DELETE FROM workspace_files WHERE conversation_id=?').bind(conversationId),
      ...insertRows(database, 'workspace_files', ['conversation_id', 'path', 'content', 'updated_at'], fileRows),
      database
        .prepare(`UPDATE conversations SET workspace=?, updated_at=?${revClause} WHERE id=? AND owner=?`)
        .bind(pointerJson, now, conversationId, owner)
    ]);
  }
  return safe;
}

export async function saveWorkspace(env, owner, id, workspace) {
  const conversation = await getConversation(env, owner, id);
  return persistConversationWorkspace(env, owner, conversation.id, workspace);
}

/* --------------------------------- summary -------------------------------- */

export async function saveSummary(env, owner, id, { summary, summaryUntil }) {
  const conversation = await getConversation(env, owner, id);
  const clean = redactSecrets(String(summary || '')).slice(0, 8000);
  const until = clamp(safeInt(summaryUntil, 0), 0, 100000);
  await (await db(env))
    .prepare(
      'UPDATE conversations SET summary=?, summary_until=?, summary_updated_at=? WHERE id=? AND owner=? AND revision=?'
    )
    .bind(clean, until, Date.now(), conversation.id, owner, conversation.revision)
    .run();
  return { summary: clean, summaryUntil: until };
}

/* ------------------------------ long-term memory -------------------------- */

const MEMORY_SCOPES = new Set(['global', 'project']);

export async function listMemories(env, owner, { scope = null, project = null } = {}) {
  const database = await db(env);
  let sql = 'SELECT * FROM memories WHERE owner=?';
  const bindings = [owner];
  if (scope && MEMORY_SCOPES.has(scope)) {
    sql += ' AND scope=?';
    bindings.push(scope);
  }
  if (project !== null) {
    sql += ' AND project=?';
    bindings.push(String(project).slice(0, 120));
  }
  sql += ' ORDER BY updated_at DESC LIMIT 500';
  const rows = await database.prepare(sql).bind(...bindings).all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    scope: row.scope,
    project: row.project,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function upsertMemory(env, owner, { scope, project = '', key, value }) {
  const cleanScope = MEMORY_SCOPES.has(scope) ? scope : 'global';
  const cleanKey = String(key || '').trim().slice(0, 80);
  const cleanValue = redactSecrets(String(value || '')).trim().slice(0, 4000);
  if (!cleanKey) fail('کلید حافظه لازم است.', 400, 'bad_memory');
  if (!cleanValue) fail('مقدار حافظه لازم است.', 400, 'bad_memory');
  const cleanProject = cleanScope === 'project' ? String(project || '').slice(0, 120) : '';
  const database = await db(env);
  const now = Date.now();
  await database
    .prepare(
      `INSERT INTO memories(id,owner,scope,project,key,value,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(owner,scope,project,key) DO UPDATE SET
         value=excluded.value, updated_at=excluded.updated_at`
    )
    .bind(crypto.randomUUID(), owner, cleanScope, cleanProject, cleanKey, cleanValue, now, now)
    .run();
  return { scope: cleanScope, project: cleanProject, key: cleanKey, value: cleanValue };
}

export async function deleteMemory(env, owner, key, { scope = 'global', project = '' } = {}) {
  const database = await db(env);
  const result = await database
    .prepare('DELETE FROM memories WHERE owner=? AND scope=? AND project=? AND key=?')
    .bind(owner, MEMORY_SCOPES.has(scope) ? scope : 'global', scope === 'project' ? project : '', String(key).slice(0, 80))
    .run();
  return { deleted: Boolean(result.meta?.changes) };
}

/* ---------------------------------- usage --------------------------------- */

export async function recordUsage(
  env,
  owner,
  { inputChars = 0, outputChars = 0, promptTokens = 0, completionTokens = 0, reasoningTokens = 0 }
) {
  const day = new Date().toISOString().slice(0, 10);
  await (await db(env))
    .prepare(
      `INSERT INTO usage_daily(owner,day,requests,input_chars,output_chars,prompt_tokens,completion_tokens,reasoning_tokens)
       VALUES(?,?,1,?,?,?,?,?)
       ON CONFLICT(owner,day) DO UPDATE SET
         requests=requests+1,
         input_chars=input_chars+excluded.input_chars,
         output_chars=output_chars+excluded.output_chars,
         prompt_tokens=prompt_tokens+excluded.prompt_tokens,
         completion_tokens=completion_tokens+excluded.completion_tokens,
         reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens`
    )
    .bind(
      owner,
      day,
      safeInt(inputChars, 0),
      safeInt(outputChars, 0),
      safeInt(promptTokens, 0),
      safeInt(completionTokens, 0),
      safeInt(reasoningTokens, 0)
    )
    .run()
    .catch(() => {});
}

export async function getUsage(env, owner) {
  const database = await db(env);
  const rows = await database
    .prepare(
      'SELECT day,requests,input_chars,output_chars,prompt_tokens,completion_tokens,reasoning_tokens FROM usage_daily WHERE owner=? ORDER BY day DESC LIMIT 30'
    )
    .bind(owner)
    .all();
  return rows.results || [];
}

/* --------------------------------- helpers -------------------------------- */

export function sanitizeTitle(title) {
  const cleaned = redactSecrets(String(title || ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (cleaned || 'گفتگوی جدید').slice(0, MAX_TITLE);
}

export function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!firstUser) return 'گفتگوی جدید';
  return sanitizeTitle(firstUser.content.trim().split('\n')[0]);
}

export function conversationView(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    archived: Boolean(row.archived),
    pinned: Boolean(row.pinned),
    messageCount: row.message_count || 0,
    lastMessageAt: row.last_message_at || 0,
    lastModel: row.last_model || '',
    summaryUntil: row.summary_until || 0
  };
}
