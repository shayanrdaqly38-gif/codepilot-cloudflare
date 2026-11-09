// GET  /api/state            → one round-trip bootstrap: user, conversations, memory, usage
// POST /api/state            → { action } mutations and data rights (export / delete)
//
// All reads and writes are scoped to the Access identity of the caller.
// The D1 database is the source of truth across devices; localStorage is only
// a cache on the client.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { fail, redactSecrets, safeInt } from '../../_lib/util.js';
import { recentPaths } from '../../_lib/versions.js';
import { forceCompactConversation } from '../../_lib/memory.js';
import { callModel } from '../../_lib/model.js';
import { resolveEffectiveEnv } from '../../_lib/provider.js';
import { activeTurnConversations } from '../../_lib/active-turn.js';
import {
  conversationView,
  createConversation,
  deleteConversation,
  deleteMemory,
  deriveTitle,
  getUsage,
  getUser,
  listConversations,
  listMemories,
  listMessages,
  appendMessages,
  replaceMessages,
  renameConversation,
  saveWorkspace,
  hydrateConversationWorkspace,
  setConversationFlags,
  upsertMemory,
  getConversation,
  messageStats
} from '../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity }) => {
    // `?archived=1` powers the archive drawer: same payload shape, but the
    // archived list instead of the live one, so those chats are reachable
    // (and restorable) instead of vanishing forever.
    const wantArchived =
      new URL(request.url).searchParams.get('archived') === '1';
    const [conversations, memories, usage, user, edited] = await Promise.all([
      wantArchived
        ? listConversations(env, identity.owner, { archived: true })
        : // The live sidebar must not show archived chats: they are reachable
          // from the 🗄 drawer instead, and they no longer count against the
          // 300-conversation quota.
          listConversations(env, identity.owner, { archived: false }),
      listMemories(env, identity.owner),
      getUsage(env, identity.owner),
      getUser(env, identity.owner),
      recentPaths(env, identity.owner, { limit: 20 }).catch(() => [])
    ]);
    const activeTurns = await activeTurnConversations(env, identity.owner);
    return {
      ok: true,
      user: {
        email: identity.email,
        name: identity.name || user?.display_name || '',
        since: user?.created_at || null
      },
      ...(wantArchived
        ? {
            archived: conversations.map((row) => conversationView(row)),
            conversations: []
          }
        : {
            conversations: conversations.map((row) => {
              const view = conversationView(row);
              if (activeTurns[view.id]) view.turnActive = true;
              return view;
            })
          }),
      memory: memories,
      usage,
      recentFiles: edited.map((row) => ({
        path: row.path,
        versions: row.versions,
        lastAt: row.last_at,
        project: row.project
      }))
    };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const owner = identity.owner;
      const action = String(data?.action || '');

      switch (action) {
        case 'create': {
          const id = await createConversation(env, owner, {
            title: data.title ? String(data.title) : 'گفتگوی جدید',
            workspace: data.workspace || {},
            copyWorkspaceFrom: typeof data.copyWorkspaceFrom === 'string' ? data.copyWorkspaceFrom : '',
            mode: data.mode === 'normal' ? 'normal' : 'developer'
          });
          return { ok: true, id, mode: data.mode === 'normal' ? 'normal' : 'developer' };
        }

        case 'rename': {
          const result = await renameConversation(env, owner, data.id, data.title);
          return { ok: true, ...result };
        }

        case 'flags': {
          const result = await setConversationFlags(env, owner, data.id, {
            archived: data.archived,
            pinned: data.pinned
          });
          return { ok: true, ...result };
        }

        case 'delete': {
          const result = await deleteConversation(env, owner, data.id);
          return { ok: true, ...result };
        }

        case 'append': {
          const conversation = await getConversation(env, owner, data.id);
          const messages = Array.isArray(data.messages) ? data.messages : [];
          if (!messages.length) fail('پیامی برای ذخیره وجود ندارد.', 400, 'bad_messages');
          if (messages.length > 400) fail('تعداد پیام‌های هر درخواست بیش از حد است.', 413, 'too_large');
          const stats = await messageStats(env, conversation.id);
          const nextSeq = await appendMessages(env, conversation, messages);
          const now = Date.now();
          const patch = {
            title:
              conversation.title === 'گفتگوی جدید' || !conversation.title
                ? deriveTitle(await listMessages(env, conversation.id, { limit: 50 }).catch(() => messages))
                : conversation.title,
            count: stats.count + messages.length,
            now
          };
          await env.DB.prepare(
            `UPDATE conversations SET title=?, message_count=?, last_message_at=?, updated_at=?, revision=revision+1
             WHERE id=? AND owner=?`
          )
            .bind(patch.title, patch.count, now, now, conversation.id, owner)
            .run();
          return { ok: true, nextSeq: nextSeq.nextSeq, messageCount: patch.count, title: patch.title };
        }

        case 'replace-messages': {
          const conversation = await getConversation(env, owner, data.id);
          const messages = Array.isArray(data.messages) ? data.messages : [];
          if (messages.length > 4000) fail('تاریخچه بیش از حد بزرگ است.', 413, 'too_large');
          await replaceMessages(env, conversation, messages);
          const now = Date.now();
          await env.DB.prepare(
            `UPDATE conversations SET message_count=?, last_message_at=?, updated_at=?, revision=revision+1,
             summary='', summary_until=0, summary_updated_at=0 WHERE id=? AND owner=?`
          )
            .bind(messages.length, now, now, conversation.id, owner)
            .run();
          return { ok: true, count: messages.length };
        }

        case 'workspace': {
          const workspace = await saveWorkspace(env, owner, data.id, data.workspace || {});
          return { ok: true, workspace };
        }

        case 'write-file': {
          // Save ONE file into the conversation workspace without shipping the
          // whole tree back. Used by the "save this image into my project"
          // button: the bytes arrive as a data: URL, which validateWorkspaceFile
          // accepts as an inline payload.
          const conversation = await getConversation(env, owner, data.id);
          const filePath = String(data.path || '').trim();
          const content = typeof data.content === 'string' ? data.content : '';
          if (!filePath) fail('مسیر فایل لازم است.', 400, 'bad_path');
          if (!content) fail('محتوای فایل خالی است.', 400, 'empty_file');
          const workspace = await hydrateConversationWorkspace(env, conversation);
          const nextWorkspace = {
            ...workspace,
            files: { ...(workspace.files || {}), [filePath]: content },
            active: filePath
          };
          const saved = await saveWorkspace(env, owner, conversation.id, nextWorkspace);
          return { ok: true, path: filePath, bytes: content.length, workspace: saved };
        }

        case 'compact': {
          const conversation = await getConversation(env, owner, data.id);
          const messages = await listMessages(env, conversation.id);
          const effectiveEnv = await resolveEffectiveEnv(env, owner);
          const outcome = await forceCompactConversation({
            env: effectiveEnv,
            conversation: { ...conversation, owner },
            messages,
            callModel: (payload) => callModel(effectiveEnv, payload),
            saveMemories: (memo) =>
              env.DB.prepare(
                `INSERT INTO memories(id,owner,scope,project,key,value,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner,scope,project,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
              )
                .bind(
                  crypto.randomUUID(),
                  owner,
                  'global',
                  '',
                  memo.key,
                  redactSecrets(memo.value),
                  Date.now(),
                  Date.now()
                )
                .run()
          });
          return { ok: true, ...outcome };
        }

        case 'fork': {
          const src = await getConversation(env, owner, data.id);
          const srcMessages = await listMessages(env, src.id);
          const forkTitle = String(data.title || `⑂ ${src.title || 'گفتگو'}`).slice(0, 120);
          const newId = await createConversation(env, owner, {
            title: forkTitle,
            copyWorkspaceFrom: src.id,
            mode: src.mode
          });
          if (srcMessages.length) {
            const newConv = await getConversation(env, owner, newId);
            await appendMessages(env, newConv, srcMessages);
            const now = Date.now();
            await env.DB.prepare(
              `UPDATE conversations SET message_count=?, last_message_at=?, updated_at=?, summary=?, summary_until=?, summary_updated_at=?
               WHERE id=? AND owner=?`
            )
              .bind(
                srcMessages.length,
                now,
                now,
                String(src.summary || ''),
                Number(src.summary_until) || 0,
                Number(src.summary_updated_at) || 0,
                newId,
                owner
              )
              .run();
          }
          return { ok: true, id: newId, title: forkTitle, messageCount: srcMessages.length };
        }

        case 'memory-upsert': {
          const memory = await upsertMemory(env, owner, {
            scope: data.scope,
            project: data.project,
            key: data.key,
            value: data.value
          });
          return { ok: true, memory };
        }

        case 'memory-delete': {
          const result = await deleteMemory(env, owner, data.key, {
            scope: data.scope || 'global',
            project: data.project || ''
          });
          return { ok: true, ...result };
        }

        case 'export': {
          const conversations = await listConversations(env, owner, { limit: 300 });
          const dump = [];
          for (const row of conversations) {
            const full = await getConversation(env, owner, row.id);
            dump.push({
              conversation: conversationView(full),
              messages: await listMessages(env, full.id),
              summary: full.summary,
              workspace: await hydrateConversationWorkspace(env, full)
            });
          }
          return {
            ok: true,
            exportedAt: new Date().toISOString(),
            account: identity.email,
            memory: await listMemories(env, owner),
            conversations: dump
          };
        }

        case 'search-conversations': {
          // Full-text-ish search across every message body, scoped to the
          // owner. Without this, finding "that chat where I said X" among 300
          // conversations × 4000 messages was impossible from the UI.
          const q = String(data.query || '').trim();
          if (q.length < 2) fail('عبارت جست‌وجو باید حداقل ۲ کاراکتر باشد.', 400, 'query_too_short');
          if (q.length > 120) fail('عبارت جست‌وجو بیش از حد طولانی است.', 400, 'query_too_long');
          const needle = q.toLowerCase();
          const limit = Math.min(Math.max(safeInt(data.limit, 40), 1), 100);
          const rows = await env.DB.prepare(
            `SELECT m.conversation_id AS cid, m.seq, m.role, m.body, c.title
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
              WHERE c.owner = ? AND c.archived = 0 AND lower(m.body) LIKE ?
              ORDER BY m.created_at DESC
              LIMIT ?`
          )
            .bind(owner, `%${needle.replace(/[%_]/g, (ch) => '\\' + ch)}%`, limit)
            .all();
          const hits = [];
          for (const row of rows.results || []) {
            let content = '';
            try { content = String(JSON.parse(row.body)?.content || ''); } catch { content = ''; }
            const at = content.toLowerCase().indexOf(needle);
            if (at < 0) continue; // body matched outside `content` (e.g. reasoning)
            const start = Math.max(0, at - 60);
            hits.push({
              conversationId: row.cid,
              seq: row.seq,
              role: row.role,
              title: row.title,
              snippet: (start > 0 ? '…' : '') + content.slice(start, at + needle.length + 90).trim()
            });
          }
          return { ok: true, query: q, results: hits };
        }

        case 'delete-all': {
          const conversations = await listConversations(env, owner, { limit: 300 });
          const statements = [];
          for (const row of conversations) {
            statements.push(env.DB.prepare('DELETE FROM workspace_files WHERE conversation_id=?').bind(row.id));
            statements.push(env.DB.prepare('DELETE FROM messages WHERE conversation_id=?').bind(row.id));
          }
          statements.push(env.DB.prepare('DELETE FROM conversations WHERE owner=?').bind(owner));
          statements.push(env.DB.prepare('DELETE FROM memories WHERE owner=?').bind(owner));
          if (statements.length) await env.DB.batch(statements);
          return { ok: true, deletedConversations: conversations.length };
        }

        default:
          fail('دستور ناشناخته است.', 400, 'unknown_action');
      }
    },
    { write: true, body: 9_000_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
