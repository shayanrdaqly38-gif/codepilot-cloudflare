// POST /api/state/search { conversationId, query, regex?, caseSensitive?, pathFilter? }
//   → path:line hits over the conversation's stored workspace
//
// The search runs against D1 (not the browser copy) so two devices get identical
// results even if the local editor is mid-edit.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { getConversation, safeWorkspace } from '../../../_lib/store.js';
import { searchWorkspace } from '../../../_lib/search.js';

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const conversation = await getConversation(env, identity.owner, String(data?.conversationId || ''));
      const workspace = safeWorkspace(JSON.parse(conversation.workspace || '{}'));
      const result = searchWorkspace(workspace.files, data?.query, {
        regex: Boolean(data?.regex),
        caseSensitive: Boolean(data?.caseSensitive),
        pathFilter: String(data?.pathFilter || ''),
        maxResults: 60
      });
      return {
        ok: true,
        query: result.query,
        filesScanned: result.filesScanned,
        truncated: result.truncated,
        total: result.total,
        results: result.results.map((hit) => ({
          path: hit.path,
          line: hit.line,
          column: hit.column,
          snippet: hit.snippet
        }))
      };
    },
    { write: true, body: 16_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('POST');
}
