// POST /api/chat/stop { id, turnId?, requestId? } -> durable, fenced Stop.
// `accepted` means the stop intent is stored; `stopped` only means this isolate
// actually aborted a local runner. Clients must not treat acceptance as proof
// that partial progress has already been flushed.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { fail } from '../../_lib/util.js';
import { abortActiveTurn } from '../../_lib/turn-registry.js';
import { requestTurnStop, getTurnStatus } from '../../_lib/active-turn.js';

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const id = typeof data?.id === 'string' ? data.id.trim() : '';
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('شناسه‌ی گفتگو معتبر نیست.', 400, 'bad_id');
      const turnId = typeof data?.turnId === 'string' ? data.turnId.trim() : '';
      const requestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
      if (turnId && !/^[A-Za-z0-9_-]{8,80}$/.test(turnId)) fail('شناسه نوبت معتبر نیست.', 400, 'bad_turn_id');
      if (requestId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) fail('شناسه درخواست معتبر نیست.', 400, 'bad_request_id');
      const result = await requestTurnStop(env, identity.owner, id, { turnId, requestId });
      const stopped = result.turnId ? abortActiveTurn(identity.owner, id, result.turnId) : abortActiveTurn(identity.owner, id);
      const current = await getTurnStatus(env, identity.owner, id);
      return {
        ok: true,
        id,
        accepted: Boolean((result.requested || result.settled) && !result.stale),
        stopped,
        stale: Boolean(result.stale),
        settled: Boolean(result.settled),
        pending: Boolean(result.pending),
        turnId: result.turnId || current?.turnId || '',
        requestId: result.requestId || current?.requestId || requestId,
        state: result.state || current?.state || 'idle'
      };
    },
    { write: true, body: 4096 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('POST');
}
