// Shared guard for every /api/state/* endpoint:
// same-origin check → Access/session identity → schema bootstrap → user row.

import { authenticate } from './auth.js';
import { assertSameOrigin, errorResponse, json, readJson } from './util.js';
import { upsertUser } from './store.js';
import { ensureSchema } from './schema.js';

export async function session(request, env, { write = false } = {}) {
  if (write) assertSameOrigin(request);
  const { identity, setCookie } = await authenticate(request, env);
  await ensureSchema(env);
  await upsertUser(env, identity);
  return { identity, setCookie };
}

export function reply(body, status, setCookie) {
  return json(body, status || 200, setCookie ? { 'Set-Cookie': setCookie } : {});
}

/**
 * Wrap a handler with auth + error handling.
 * The handler receives ({ identity, env, request, url, data, setCookie, waitUntil }).
 */
export async function route(request, env, handler, { write = false, body = 0, waitUntil = null } = {}) {
  let data = null;
  try {
    const url = new URL(request.url);
    const { identity, setCookie } = await session(request, env, { write });
    if (body) data = await readJson(request, body);
    const result = await handler({ identity, env, request, url, data, setCookie, waitUntil });
    if (result instanceof Response) {
      if (setCookie && !result.headers.get('Set-Cookie')) {
        const copy = new Response(result.body, result);
        copy.headers.set('Set-Cookie', setCookie);
        return copy;
      }
      return result;
    }
    return reply(result || {}, 200, setCookie);
  } catch (error) {
    return errorResponse(error, { requestId: typeof data?.requestId === 'string' ? data.requestId : '' });
  }
}

export function methodNotAllowed(allow) {
  return json({ error: 'متد پشتیبانی نمی‌شود.', code: 'method_not_allowed' }, 405, { Allow: allow });
}
