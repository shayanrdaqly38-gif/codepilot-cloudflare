// GET /api/state/conversations?archived=0|1
// Lightweight list for the sidebar and for switching devices.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { conversationView, listConversations } from '../../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const archivedParam = url.searchParams.get('archived');
    const archived = archivedParam === '1' ? true : archivedParam === '0' ? false : null;
    const limit = Number(url.searchParams.get('limit') || 200);
    const rows = await listConversations(env, identity.owner, { archived, limit });
    return { ok: true, conversations: rows.map(conversationView) };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
