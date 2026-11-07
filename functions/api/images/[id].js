// GET    /api/images/:id  → owner-authenticated binary image delivery (+ ?download=1)
// DELETE /api/images/:id  → delete a stored generated image

import { session, route, methodNotAllowed } from '../../_lib/api.js';
import { errorResponse } from '../../_lib/util.js';
import { loadGeneratedImage } from '../../_lib/image.js';

function extForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

export async function onRequestGet({ request, env, params }) {
  try {
    const url = new URL(request.url);
    const { identity, setCookie } = await session(request, env, { write: false });
    const imageId = String(params?.id || '');
    const etag = `"img-${imageId}"`;
    const isDownload = url.searchParams.get('download') === '1';

    if (!isDownload && request.headers.get('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=604800, immutable',
          ...(setCookie ? { 'Set-Cookie': setCookie } : {})
        }
      });
    }

    const { meta, bytes } = await loadGeneratedImage(env, identity.owner, imageId);
    const ext = extForMime(meta.mime_type);
    const shortId = String(meta.id).slice(0, 8);
    const headers = {
      'Content-Type': meta.mime_type || 'image/jpeg',
      'Content-Length': String(bytes.byteLength),
      ETag: etag,
      'Cache-Control': 'private, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
      ...(isDownload
        ? { 'Content-Disposition': `attachment; filename="codepilot-image-${shortId}.${ext}"` }
        : {}),
      ...(setCookie ? { 'Set-Cookie': setCookie } : {})
    };
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestDelete({ request, env, params }) {
  return route(
    request,
    env,
    async ({ identity }) => {
      const cleanId = String(params?.id || '').trim();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM generated_image_chunks WHERE image_id=?').bind(cleanId),
        env.DB.prepare('DELETE FROM generated_images WHERE id=? AND owner=?').bind(cleanId, identity.owner)
      ]);
      return { ok: true };
    },
    { write: true }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'DELETE') return onRequestDelete(context);
  return methodNotAllowed('GET, DELETE');
}
