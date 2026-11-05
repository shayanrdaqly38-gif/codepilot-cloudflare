// GET /api/state/conversations/:id  → full conversation: metadata, messages, summary, workspace
//
// This is what makes "open CodePilot on another device" work: the D1 row plus
// its messages is the single source of truth.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { getConversation, listMessages, conversationView } from '../../../_lib/store.js';

export async function onRequestGet({ request, env, params }) {
  return route(request, env, async ({ identity }) => {
    const conversation = await getConversation(env, identity.owner, params.id);
    const messages = await listMessages(env, conversation.id);
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
      workspace
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
