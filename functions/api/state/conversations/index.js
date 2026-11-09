// GET /api/state/conversations?archived=0|1
// Lightweight list for the sidebar and for switching devices.
// Each row carries `turnActive` when a headless/live turn is still running in
// that conversation, so the UI can badge it (⏳) and poll for progress.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { conversationView, listConversations } from '../../../_lib/store.js';
import { activeTurnConversations } from '../../../_lib/active-turn.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const archivedParam = url.searchParams.get('archived');
    const archived = archivedParam === '1' ? true : archivedParam === '0' ? false : null;
    const limit = Number(url.searchParams.get('limit') || 200);
    const [rows, activeMap] = await Promise.all([
      listConversations(env, identity.owner, { archived, limit }),
      activeTurnConversations(env, identity.owner)
    ]);
    return {
      ok: true,
      conversations: rows.map((row) => {
        const view = conversationView(row);
        if (activeMap[view.id]) view.turnActive = true;
        return view;
      })
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
