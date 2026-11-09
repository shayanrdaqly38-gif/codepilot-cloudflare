// GET /api/state/workspace-file?conversationId=..&path=..
//   → single workspace file content, owner-scoped.
//
// Powers lazy loading in the UI: a normal-mode ("arena") workspace can hold a
// real 1GB in D1, so GET /api/state/conversations/:id ships only a byte-budgeted
// slice of file contents plus a lazy path list. The browser then pulls exactly
// the file the user opens through this endpoint — never the whole workspace.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { fail } from '../../_lib/util.js';
import { getConversation, loadWorkspaceFile } from '../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const conversationId = String(url.searchParams.get('conversationId') || '').trim();
    const path = String(url.searchParams.get('path') || '').trim();
    if (!conversationId || !path) {
      fail('پارامترهای conversationId و path الزامی است.', 400, 'bad_request');
    }
    // getConversation is owner-scoped: another user's conversation id → 404.
    const conversation = await getConversation(env, identity.owner, conversationId);
    const file = await loadWorkspaceFile(env, conversation, path);
    if (!file) fail('فایل در فضای کاری پیدا نشد.', 404, 'not_found');
    return {
      ok: true,
      path: file.path,
      content: file.content,
      bytes: file.bytes,
      mode: conversation.mode || 'developer'
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
