// POST /api/chat/stop { id } -> aborts an in-flight turn in the current isolate
// so the turn persists partial progress + durable checkpoint and exits cleanly.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { fail } from '../../_lib/util.js';
import { abortActiveTurn } from '../../_lib/turn-registry.js';

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const id = typeof data?.id === 'string' ? data.id.trim() : '';
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        fail('شناسه‌ی گفتگو معتبر نیست.', 400, 'bad_id');
      }
      const stopped = abortActiveTurn(identity.owner, id);
      return { ok: true, id, stopped };
    },
    { write: true, body: 4096 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('POST');
}
