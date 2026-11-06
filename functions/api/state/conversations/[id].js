// GET /api/state/conversations/:id  → full conversation: metadata, messages, summary, workspace
//
// This is what makes "open CodePilot on another device" work: the D1 row plus
// its messages is the single source of truth.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { getConversation, listMessages, conversationView } from '../../../_lib/store.js';
import { loadTurnCheckpoint } from '../../../_lib/checkpoint.js';

export async function onRequestGet({ request, env, params }) {
  return route(request, env, async ({ identity }) => {
    const conversation = await getConversation(env, identity.owner, params.id);
    const [rawMessages, checkpoint] = await Promise.all([
      listMessages(env, conversation.id),
      loadTurnCheckpoint(env, identity.owner, conversation.id).catch(() => null)
    ]);
    const messages = rawMessages.map((m) => {
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
    let workspace = {};
    try {
      workspace = JSON.parse(conversation.workspace || '{}');
    } catch {
      workspace = {};
    }
    return {
      ok: true,
      conversation: {
        ...conversationView(conversation),
        summary: conversation.summary,
        summaryUpdatedAt: conversation.summary_updated_at
      },
      messages,
      workspace,
      checkpoint
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
