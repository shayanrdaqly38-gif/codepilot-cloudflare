// GET  /api/auth   → who am I (creates a session cookie on first Access visit)
// POST /api/auth   → { action: "logout" } clears the session cookie

import { authenticate, clearSessionCookie } from '../_lib/auth.js';
import { errorResponse, json, readJson, assertSameOrigin } from '../_lib/util.js';
import { getUser, upsertUser } from '../_lib/store.js';

export async function onRequestGet({ request, env }) {
  try {
    const { identity, setCookie } = await authenticate(request, env);
    await upsertUser(env, identity);
    const user = await getUser(env, identity.owner);
    return json(
      {
        signedIn: true,
        user: {
          email: identity.email,
          name: identity.name || user?.display_name || '',
          since: user?.created_at || null
        },
        auth: identity.via === 'dev-fallback' ? 'dev-fallback' : 'cloudflare-access',
        warning:
          identity.via === 'dev-fallback'
            ? 'حالت بدون Cloudflare Access فعال است (DEV_ACCESS_EMAIL). این محیط تک‌کاربره و بدون ورود واقعی است؛ هر کسی که آدرس را بداند می‌تواند وارد شود.'
            : null,
        storage: 'd1'
      },
      200,
      setCookie ? { 'Set-Cookie': setCookie } : {}
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    assertSameOrigin(request);
    await readJson(request, 4096);
    return json({ signedIn: false }, 200, { 'Set-Cookie': clearSessionCookie(request) });
  } catch (error) {
    return errorResponse(error);
  }
}
