// POST /api/images/enhance  → turn a raw (often Persian) idea into a vivid
// English image prompt WITHOUT spending chat tokens or generating an image.
//
// This is stage ۲ of the image pipeline: the user sees and can edit the
// enhanced prompt before committing to a slow/expensive generation run.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { resolveEffectiveEnv } from '../../_lib/provider.js';
import { enhanceImagePrompt } from '../../_lib/image.js';

export async function onRequestPost({ request, env }) {
  return route(request, env, async ({ identity, data }) => {
    const raw = typeof data?.prompt === 'string' ? data.prompt.trim() : '';
    if (!raw) {
      return new Response(JSON.stringify({ ok: false, error: 'پرامپت خالی است.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
    const style = typeof data?.style === 'string' && data.style ? data.style : 'auto';
    const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);

    let prompt = raw;
    let enhanced = false;
    try {
      const result = await enhanceImagePrompt(effectiveEnv, raw.slice(0, 1_500), style, { enhance: true });
      if (typeof result === 'string' && result.trim()) {
        prompt = result.trim();
        enhanced = prompt !== raw;
      }
    } catch {
      // Enhancement is best-effort: never block the pipeline on it.
      prompt = raw;
      enhanced = false;
    }

    return { ok: true, prompt, original: raw, enhanced, style };
  }, { write: true, body: 60_000 });
}

export async function onRequest() {
  return methodNotAllowed('POST');
}
