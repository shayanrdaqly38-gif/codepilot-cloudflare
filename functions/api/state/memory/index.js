// GET  /api/state/memory            → list long-term memories
// POST /api/state/memory {action}   → upsert / delete a memory entry
//
// Memories are explicit, user-visible facts (preferences, project conventions).
// They are redacted on write and injected into the system prompt, never mixed
// into the message history.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { fail } from '../../../_lib/util.js';
import { deleteMemory, listMemories, upsertMemory } from '../../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const memories = await listMemories(env, identity.owner, {
      scope: url.searchParams.get('scope'),
      project: url.searchParams.has('project') ? url.searchParams.get('project') : null
    });
    return { ok: true, memory: memories };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const action = String(data?.action || 'upsert');
      if (action === 'delete') {
        const result = await deleteMemory(env, identity.owner, data.key, {
          scope: data.scope || 'global',
          project: data.project || ''
        });
        return { ok: true, ...result };
      }
      if (action !== 'upsert') fail('دستور ناشناخته است.', 400, 'unknown_action');
      const memory = await upsertMemory(env, identity.owner, {
        scope: data.scope,
        project: data.project,
        key: data.key,
        value: data.value
      });
      return { ok: true, memory };
    },
    { write: true, body: 32_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
