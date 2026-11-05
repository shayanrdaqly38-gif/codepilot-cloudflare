import { route, methodNotAllowed } from '../_lib/api.js';
import { uploadAction } from '../_lib/uploads.js';

export async function onRequest({ request, env }) {
  if (request.method === 'GET') {
    return route(request, env, () => ({ ok: true, uploadProtocol: 1, chunkBytes: 192_000 }));
  }
  if (request.method !== 'POST') return methodNotAllowed('GET, POST');
  return route(request, env, ({ identity, data }) => uploadAction(env, identity.owner, data), { write: true, body: 270_000 });
}
