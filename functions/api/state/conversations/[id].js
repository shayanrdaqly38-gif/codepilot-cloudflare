// GET /api/state/conversations/:id  → full conversation: metadata, messages, summary, workspace
//
// This is what makes "open CodePilot on another device" work: the D1 row plus
// its messages is the single source of truth.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import {
  getConversation,
  listMessages,
  listMessagesPage,
  hydrateConversationWorkspace,
  conversationView
} from '../../../_lib/store.js';
import { loadTurnCheckpoint } from '../../../_lib/checkpoint.js';

export async function onRequestGet({ request, env, params }) {
  return route(request, env, async ({ identity }) => {
    const url = new URL(request.url);
    const lite = url.searchParams.get('lite') === '1';
    const skipWorkspace = url.searchParams.get('skipWorkspace') === '1';
    const beforeSeqParam = url.searchParams.get('beforeSeq');
    const beforeSeq = beforeSeqParam !== null && beforeSeqParam !== '' ? Number(beforeSeqParam) : null;
    const limitParam = Number(url.searchParams.get('limit'));

    const conversation = await getConversation(env, identity.owner, params.id);

    let messages;
    let hasOlderMessages = false;
    let oldestSeq = null;

    if (lite || beforeSeq !== null || (Number.isFinite(limitParam) && limitParam > 0)) {
      const [page, checkpoint] = await Promise.all([
        listMessagesPage(env, conversation.id, {
          limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100,
          beforeSeq,
          lite
        }),
        skipWorkspace && beforeSeq !== null
          ? Promise.resolve(null)
          : loadTurnCheckpoint(env, identity.owner, conversation.id).catch(() => null)
      ]);
      messages = page.messages;
      hasOlderMessages = page.hasOlderMessages;
      oldestSeq = page.oldestSeq;
      const workspace = skipWorkspace ? undefined : await hydrateConversationWorkspace(env, conversation, { byteBudget: 6_000_000 });
      return {
        ok: true,
        conversation: {
          ...conversationView(conversation),
          summary: conversation.summary,
          summaryUpdatedAt: conversation.summary_updated_at
        },
        messages,
        hasOlderMessages,
        oldestSeq,
        ...(workspace !== undefined ? { workspace } : {}),
        checkpoint
      };
    }

    const [rawMessages, checkpoint, workspace] = await Promise.all([
      listMessages(env, conversation.id),
      loadTurnCheckpoint(env, identity.owner, conversation.id).catch(() => null),
      skipWorkspace ? Promise.resolve(undefined) : hydrateConversationWorkspace(env, conversation, { byteBudget: 6_000_000 })
    ]);
    messages = rawMessages.map((m) => {
      if (!Array.isArray(m?.attachments) || !m.attachments.some((a) => typeof a?.data === 'string' && a.data.length > 300_000)) {
        return m;
      }
      return {
        ...m,
        attachments: m.attachments.map((a) =>
          typeof a?.data === 'string' && a.data.length > 300_000
            ? { name: a.name, type: a.type, size: Math.floor((a.data.length / 4) * 3) }
            : a
        )
      };
    });
    return {
      ok: true,
      conversation: {
        ...conversationView(conversation),
        summary: conversation.summary,
        summaryUpdatedAt: conversation.summary_updated_at
      },
      messages,
      hasOlderMessages: false,
      oldestSeq: messages.length ? messages[0].seq : null,
      ...(workspace !== undefined ? { workspace } : {}),
      checkpoint
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
