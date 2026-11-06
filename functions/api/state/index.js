// GET  /api/state            → one round-trip bootstrap: user, conversations, memory, usage
// POST /api/state            → { action } mutations and data rights (export / delete)
//
// All reads and writes are scoped to the Access identity of the caller.
// The D1 database is the source of truth across devices; localStorage is only
// a cache on the client.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { fail, redactSecrets } from '../../_lib/util.js';
import { recentPaths } from '../../_lib/versions.js';
import { forceCompactConversation } from '../../_lib/memory.js';
import { callModel } from '../../_lib/model.js';
import { resolveEffectiveEnv } from '../../_lib/provider.js';
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
    const [conversations, memories, usage, user, edited] = await Promise.all([
      listConversations(env, identity.owner),
      listMemories(env, identity.owner),
      getUsage(env, identity.owner),
      getUser(env, identity.owner),
      recentPaths(env, identity.owner, { limit: 20 }).catch(() => [])
    ]);
    return {
      ok: true,
      user: {
        email: identity.email,
        name: identity.name || user?.display_name || '',
        since: user?.created_at || null
      },
      conversations: conversations.map(conversationView),
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
            copyWorkspaceFrom: typeof data.copyWorkspaceFrom === 'string' ? data.copyWorkspaceFrom : ''
          });
          return { ok: true, id };
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
            copyWorkspaceFrom: src.id
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
