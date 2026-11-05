// GET /api/state/usage → per-day request/character counters for the signed-in user.
// Useful for spotting runaway loops before they cost money.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { getUsage } from '../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity }) => {
    const days = await getUsage(env, identity.owner);
    const totals = days.reduce(
      (acc, day) => ({
        requests: acc.requests + (day.requests || 0),
        inputChars: acc.inputChars + (day.input_chars || 0),
        outputChars: acc.outputChars + (day.output_chars || 0)
      }),
      { requests: 0, inputChars: 0, outputChars: 0 }
    );
    return {
      ok: true,
      days: days.map((d) => ({
        day: d.day,
        requests: d.requests,
        inputChars: d.input_chars,
        outputChars: d.output_chars
      })),
      totals
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
