// GET  /api/images  → list user's generated images + Workers AI binding status
// POST /api/images  → direct zero-token studio image generation (+ optional chat persistence)

import { route, methodNotAllowed } from '../../_lib/api.js';
import { resolveEffectiveEnv } from '../../_lib/provider.js';
import {
  generateAndStoreImage,
  listGeneratedImages,
  IMAGE_ASPECT_SPECS,
  IMAGE_STYLE_PRESETS
} from '../../_lib/image.js';
import {
  appendMessages,
  deriveTitle,
  getConversation,
  messageStats
} from '../../_lib/store.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const limit = Number(url.searchParams.get('limit') || 24);
    const images = await listGeneratedImages(env, identity.owner, { limit });
    return {
      ok: true,
      workersAiBound: Boolean(env?.AI && typeof env.AI.run === 'function'),
      aspects: IMAGE_ASPECT_SPECS,
      styles: Object.fromEntries(
        Object.entries(IMAGE_STYLE_PRESETS).map(([k, v]) => [k, { label: v.label }])
      ),
      images
    };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
      const image = await generateAndStoreImage(effectiveEnv, identity.owner, {
        prompt: data?.prompt,
        title: data?.title,
        style: data?.style || 'auto',
        aspectRatio: data?.aspectRatio || '1:1',
        engine: data?.engine || 'auto',
        enhance: data?.enhance !== false,
        seed: Number.isInteger(data?.seed) ? data.seed : undefined,
        overlayText: data?.overlayText ?? null,
        conversationId
      });

      let persistedToChat = false;
      if (data?.appendToConversation && conversationId) {
        try {
          const conversation = await getConversation(env, identity.owner, conversationId);
          const stats = await messageStats(env, conversation.id);
          const userMsg = `🎨 ساخت تصویر: ${image.prompt}`;
          const mdAlt = (image.title || 'تصویر تولیدشده').replace(/[\[\]\r\n]/g, ' ').trim();
          const engineBadge =
            image.engine === 'cloudflare-ai'
              ? `Cloudflare Workers AI (${image.model.split('/').pop()})`
              : image.modelLabel || image.engine;
          const assistantContent =
            `![${mdAlt}](${image.url})\n` +
            `**${mdAlt}** · \`${image.width}×${image.height}\` · موتور: \`${engineBadge}\``;

          const now = Date.now();
          await appendMessages(env, conversation, [
            { role: 'user', content: userMsg, created_at: now },
            { role: 'assistant', content: assistantContent, created_at: now + 1 }
          ]);
          const nextTitle =
            !conversation.title || conversation.title === 'گفتگوی جدید'
              ? deriveTitle([{ role: 'user', content: image.prompt }])
              : conversation.title;
          await env.DB.prepare(
            `UPDATE conversations
             SET title=?, message_count=?, last_message_at=?, updated_at=?, revision=revision+1
             WHERE id=? AND owner=?`
          )
            .bind(nextTitle, stats.count + 2, now + 1, now + 1, conversation.id, identity.owner)
            .run();
          persistedToChat = true;
        } catch {
          persistedToChat = false;
        }
      }

      return { ok: true, image, persistedToChat };
    },
    { write: true, body: 64_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
