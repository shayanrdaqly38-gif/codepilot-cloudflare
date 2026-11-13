// Studio-grade, zero-cost, multi-engine AI Image Generation for CodePilot.
//
// Engine cascade (default `engine: 'auto'`):
//   1. Cloudflare Workers AI (`env.AI`) — FREE daily Neurons directly on Cloudflare's edge:
//      • `@cf/black-forest-labs/flux-1-schnell` (12B FLUX.1 rectified-flow transformer at max 8 steps)
//      • `@cf/leonardo/phoenix-1.0` (native custom HD aspect ratios: 16:9, 9:16, 4:3, 3:4, 1:1)
//      • `@cf/bytedance/stable-diffusion-xl-lightning` (fast HD fallback on Cloudflare edge)
//   2. Free Unlimited FLUX Relay (`free-flux-unlimited`) — automatic zero-key failover when
//      `env.AI` is unbound in local dev or daily free Cloudflare Neurons are exhausted.
//   3. Connected Provider `/images/generations` (only when explicitly requested via `engine: 'provider'`).
//
// Generated images are persisted in D1 (`generated_images` + `generated_image_chunks` in 192 KB
// slices) and served via `/api/images/:id` so chat history & LLM context never bloat with Base64!

import { fail } from './util.js';
import { assertSafeExternalUrl } from './web.js';

export const IMAGE_CHUNK_BYTES = 192_000; // Divisible by 3 -> 256,000 Base64 chars/row (< 300 KB SQL)
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_REMOTE_IMAGE_REDIRECTS = 4;
const MAX_STORED_IMAGES_PER_OWNER = 120;
const MAX_PROMPT_CHARS = 1_900;

/** Download provider-returned image URLs without allowing SSRF or unbounded bodies. */
export async function fetchRemoteImageBytes(rawUrl, signal = null) {
  let currentUrl;
  try {
    currentUrl = assertSafeExternalUrl(rawUrl);
    if (currentUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  for (let hop = 0; hop <= MAX_REMOTE_IMAGE_REDIRECTS; hop += 1) {
    const response = await fetch(currentUrl.href, {
      method: 'GET',
      redirect: 'manual',
      signal
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REMOTE_IMAGE_REDIRECTS) return null;
      try {
        currentUrl = assertSafeExternalUrl(new URL(location, currentUrl.href).href);
        if (currentUrl.protocol !== 'https:') return null;
      } catch {
        return null;
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.body) return null;

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.byteLength > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock?.();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  return null;
}

export const IMAGE_ASPECT_SPECS = {
  '1:1': { width: 1024, height: 1024, label: 'مربع (1:1 · 1024×1024)' },
  '16:9': { width: 1344, height: 768, label: 'افقی سینمایی (16:9 · 1344×768)' },
  '9:16': { width: 768, height: 1344, label: 'عمودی موبایل (9:16 · 768×1344)' },
  '4:3': { width: 1152, height: 896, label: 'کلاسیک افقی (4:3 · 1152×896)' },
  '3:4': { width: 896, height: 1152, label: 'پرتره عمودی (3:4 · 896×1152)' }
};

export const IMAGE_STYLE_PRESETS = {
  auto: {
    label: '✨ خودکار استودیویی',
    suffix:
      'masterpiece quality, ultra-crisp focus, coherent composition, rich micro-textures, balanced natural and rim lighting, high dynamic range, 8k clarity'
  },
  photorealistic: {
    label: '📷 عکاسی واقع‌گرایانه',
    suffix:
      'award-winning editorial photograph, shot on 85mm f/1.4 prime lens, natural global illumination, lifelike skin and surface textures, shallow depth of field, authentic RAW color science'
  },
  cinematic: {
    label: '🎬 سینمایی (IMAX)',
    suffix:
      'epic anamorphic widescreen film still, volumetric atmospheric lighting, dramatic shadows, rich teal-and-amber cinema color grading, 70mm IMAX clarity'
  },
  'digital-art': {
    label: '🎨 هنر دیجیتال و کانسپت',
    suffix:
      'breathtaking digital concept art illustration, luminous atmospheric perspective, expressive refined brushwork, rich color harmony, ArtStation flagship quality'
  },
  'logo-icon': {
    label: '💎 لوگو و آیکون مدرن',
    suffix:
      'iconic minimalist brand mark and app icon design, razor-sharp geometric precision, bold memorable silhouette, clean studio presentation, balanced negative space'
  },
  'ui-mockup': {
    label: '📱 رابط کاربری و محصول',
    suffix:
      'sleek modern product and UI hero illustration, clean geometric forms, subtle glassmorphism, soft studio lighting, Apple and Dribbble design excellence'
  },
  '3d-render': {
    label: '🧊 رندر سه‌بعدی (Octane)',
    suffix:
      'Octane and Blender Cycles 3D render, physically based materials, subtle subsurface scattering, soft studio three-point lighting, ultra-clean 3D geometry'
  },
  anime: {
    label: '🌸 انیمه سینمایی',
    suffix:
      'high-budget theatrical anime key visual, Makoto Shinkai luminous sky and dramatic lighting, crisp clean linework, vibrant emotional atmosphere'
  },
  'pixel-art': {
    label: '👾 پیکسل‌آرت حرفه‌ای',
    suffix:
      'masterpiece 16-bit / 32-bit pixel art scene, crisp clean pixel grid, handcrafted dithering, vibrant retro arcade color palette'
  }
};

const PERSIAN_OR_NON_LATIN_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function normalizeAspectRatio(value) {
  const clean = String(value || '1:1').trim();
  return IMAGE_ASPECT_SPECS[clean] ? clean : '1:1';
}

export function normalizeImageStyle(value) {
  const clean = String(value || 'auto').trim().toLowerCase();
  return IMAGE_STYLE_PRESETS[clean] ? clean : 'auto';
}

export function detectImageMime(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 64) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  return null;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const step = 24_576; // Multiple of 3 & well under V8 argument stack limit
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const clean = String(b64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Normalize every possible Cloudflare Workers AI image output shape into `{ bytes, mimeType }`:
 *   - `{ image: "<base64>" }` (used by `@cf/black-forest-labs/flux-1-schnell`)
 *   - `{ data: [{ b64_json: "<base64>" }] }`
 *   - `ReadableStream` (used by `@cf/leonardo/phoenix-1.0` & SDXL models)
 *   - `Uint8Array` / `ArrayBuffer` / `Response`
 */
export async function normalizeAiImageOutput(raw) {
  if (!raw) return null;
  let bytes = null;

  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (raw instanceof ArrayBuffer) {
    bytes = new Uint8Array(raw);
  } else if (typeof Response !== 'undefined' && raw instanceof Response) {
    bytes = new Uint8Array(await raw.arrayBuffer());
  } else if (typeof ReadableStream !== 'undefined' && raw instanceof ReadableStream) {
    bytes = new Uint8Array(await new Response(raw).arrayBuffer());
  } else if (typeof raw === 'string') {
    bytes = base64ToBytes(raw);
  } else if (typeof raw === 'object') {
    if (typeof raw.image === 'string' && raw.image.length > 64) {
      bytes = base64ToBytes(raw.image);
    } else if (Array.isArray(raw.data) && typeof raw.data[0]?.b64_json === 'string') {
      bytes = base64ToBytes(raw.data[0].b64_json);
    } else if (raw.image instanceof Uint8Array) {
      bytes = raw.image;
    } else if (typeof ReadableStream !== 'undefined' && raw.image instanceof ReadableStream) {
      bytes = new Uint8Array(await new Response(raw.image).arrayBuffer());
    }
  }

  if (!bytes || bytes.byteLength < 64) return null;
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    fail('اندازه فایل تصویر تولیدشده بیش از حد مجاز است.', 413, 'image_too_large');
  }
  const mimeType = detectImageMime(bytes);
  if (!mimeType) return null;
  return { bytes, mimeType };
}

/**
 * Translate Persian / short user descriptions into vivid, studio-grade English FLUX prompts
 * using Cloudflare Workers AI's fast free Llama model when available, with instant safe fallback.
 */
export async function enhanceImagePrompt(env, rawPrompt, style = 'auto', { enhance = true } = {}) {
  const trimmed = String(rawPrompt || '').trim();
  if (!trimmed) fail('توضیح تصویر (پرامپت) خالی است.', 400, 'empty_prompt');

  const styleKey = normalizeImageStyle(style);
  const stylePreset = IMAGE_STYLE_PRESETS[styleKey] || IMAGE_STYLE_PRESETS.auto;
  const hasPersian = PERSIAN_OR_NON_LATIN_RE.test(trimmed);
  const needsLlmBoost = Boolean(env?.AI?.run) && (hasPersian || (enhance !== false && trimmed.length < 90));

  let coreEnglish = trimmed;
  if (needsLlmBoost) {
    const llmModels = ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/meta/llama-3.1-8b-instruct'];
    for (const llm of llmModels) {
      try {
        const res = await Promise.race([
          env.AI.run(llm, {
            max_tokens: 190,
            temperature: 0.35,
            messages: [
              {
                role: 'system',
                content:
                  'You are an elite FLUX.1 visual art director. Convert the user request (which may be in Persian or English) into ONE vivid, concrete English image generation prompt (50 to 110 words). Specify subject, composition, lighting, materials, atmosphere, and color palette. Output ONLY the final English prompt text with no quotes, no preamble, and no markdown.'
              },
              {
                role: 'user',
                content: `Style: ${styleKey}\nRequest: ${trimmed.slice(0, 800)}`
              }
            ]
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('prompt_enhance_timeout')), 4500))
        ]);
        const text = String(res?.response || res?.result?.response || '').trim();
        if (text && text.length >= 16 && !PERSIAN_OR_NON_LATIN_RE.test(text)) {
          coreEnglish = text.replace(/^["'`]+|["'`]+$/g, '').trim();
          break;
        }
      } catch {
        // Fall through silently — image generation must never fail because prompt enhancement timed out.
      }
    }
  }

  const combined =
    enhance === false && !hasPersian
      ? coreEnglish
      : `${coreEnglish}. ${stylePreset.suffix}`;

  return combined.slice(0, MAX_PROMPT_CHARS);
}

async function tryWorkersAiModels(env, { prompt, aspectRatio, width, height, seed }) {
  if (!env?.AI || typeof env.AI.run !== 'function') {
    return { ok: false, errors: ['workers_ai_unbound'] };
  }

  // Model priority:
  // - Square (1:1): FLUX.1-schnell at max 8 steps is the sharpest 12B model on Workers AI.
  // - Non-square (16:9, 9:16, 4:3, 3:4): Leonardo Phoenix 1.0 & SDXL Lightning support exact native HD dimensions,
  //   with FLUX.1-schnell as ultra-reliable fallback.
  const candidates =
    aspectRatio === '1:1'
      ? [
          {
            model: '@cf/black-forest-labs/flux-1-schnell',
            label: 'Cloudflare FLUX.1 Schnell',
            input: { prompt, steps: 8 },
            outWidth: 1024,
            outHeight: 1024
          },
          {
            model: '@cf/leonardo/phoenix-1.0',
            label: 'Cloudflare Leonardo Phoenix 1.0',
            input: { prompt, width: 1024, height: 1024, num_steps: 25, guidance: 4, seed },
            outWidth: 1024,
            outHeight: 1024
          },
          {
            model: '@cf/bytedance/stable-diffusion-xl-lightning',
            label: 'Cloudflare SDXL Lightning',
            input: { prompt, width: 1024, height: 1024, num_steps: 4 },
            outWidth: 1024,
            outHeight: 1024
          }
        ]
      : [
          {
            model: '@cf/leonardo/phoenix-1.0',
            label: 'Cloudflare Leonardo Phoenix 1.0',
            input: { prompt, width, height, num_steps: 25, guidance: 4, seed },
            outWidth: width,
            outHeight: height
          },
          {
            model: '@cf/bytedance/stable-diffusion-xl-lightning',
            label: 'Cloudflare SDXL Lightning',
            input: { prompt, width, height, num_steps: 4 },
            outWidth: width,
            outHeight: height
          },
          {
            model: '@cf/black-forest-labs/flux-1-schnell',
            label: 'Cloudflare FLUX.1 Schnell',
            input: { prompt, steps: 8 },
            outWidth: 1024,
            outHeight: 1024
          }
        ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      const raw = await env.AI.run(candidate.model, candidate.input);
      const parsed = await normalizeAiImageOutput(raw);
      if (parsed) {
        return {
          ok: true,
          bytes: parsed.bytes,
          mimeType: parsed.mimeType,
          engine: 'cloudflare-ai',
          model: candidate.model,
          modelLabel: candidate.label,
          width: candidate.outWidth,
          height: candidate.outHeight
        };
      }
      errors.push(`${candidate.model}:invalid_image_output`);
    } catch (err) {
      errors.push(`${candidate.model}:${String(err?.message || err || 'error').slice(0, 120)}`);
    }
  }
  return { ok: false, errors };
}

async function tryFreeUnlimitedFluxRelay({ prompt, width, height, seed, externalSignal }) {
  const attempts = [
    {
      model: 'flux',
      label: 'FLUX Free Relay',
      url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=flux&width=${width}&height=${height}&seed=${seed}&nologo=true&enhance=false`
    },
    {
      model: 'flux-alt',
      label: 'FLUX Free Relay (Fallback)',
      url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?width=${width}&height=${height}&seed=${(seed + 7919) % 999999}&nologo=true`
    }
  ];

  const errors = [];
  for (const item of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 26_000);
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        fail('عملیات ساخت تصویر توسط کاربر متوقف شد.', 499, 'turn_stopped');
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const res = await fetch(item.url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.9',
          'User-Agent': 'CodePilot-ImageStudio/2.1'
        }
      });
      if (!res.ok) {
        errors.push(`${item.model}:http_${res.status}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        errors.push(`${item.model}:too_large`);
        continue;
      }
      const mimeType = detectImageMime(bytes);
      if (!mimeType || bytes.byteLength < 1024) {
        errors.push(`${item.model}:non_image_payload`);
        continue;
      }
      return {
        ok: true,
        bytes,
        mimeType,
        engine: 'free-flux-relay',
        model: 'flux-1-free',
        modelLabel: item.label,
        width,
        height
      };
    } catch (err) {
      if (externalSignal?.aborted) {
        fail('عملیات ساخت تصویر توسط کاربر متوقف شد.', 499, 'turn_stopped');
      }
      errors.push(`${item.model}:${String(err?.message || err || 'fetch_error').slice(0, 100)}`);
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
  return { ok: false, errors };
}

async function tryProviderImagesEndpoint(env, { prompt, width, height, externalSignal }) {
  const apiKey = String(env?.MODEL_API_KEY || '').trim();
  const baseUrl = String(env?.MODEL_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!apiKey || !baseUrl) return { ok: false, errors: ['provider_unconfigured'] };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 28_000);
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      fail('عملیات ساخت تصویر توسط کاربر متوقف شد.', 499, 'turn_stopped');
    }
    externalSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const size = width === height ? '1024x1024' : width > height ? '1536x1024' : '1024x1536';
    const imageModel = /tooken\.club/i.test(baseUrl) ? 'gpt-image-2.5-sunburst' : 'dall-e-3';
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json'
      })
    });
    if (!res.ok) return { ok: false, errors: [`provider_http_${res.status}`] };
    const payload = await res.json();
    const parsed = await normalizeAiImageOutput(payload);
    if (parsed) {
      return {
        ok: true,
        bytes: parsed.bytes,
        mimeType: parsed.mimeType,
        engine: 'provider-api',
        model: imageModel,
        modelLabel: `Provider (${imageModel})`,
        width,
        height
      };
    }
    const remoteUrl = payload?.data?.[0]?.url;
    if (typeof remoteUrl === 'string') {
      const bytes = await fetchRemoteImageBytes(remoteUrl, ctrl.signal);
      const mimeType = bytes ? detectImageMime(bytes) : null;
      if (bytes && mimeType) {
        return {
          ok: true,
          bytes,
          mimeType,
          engine: 'provider-api',
          model: imageModel,
          modelLabel: `Provider (${imageModel})`,
          width,
          height
        };
      }
    }
    return { ok: false, errors: ['provider_empty_image'] };
  } catch (err) {
    return { ok: false, errors: [String(err?.message || err || 'provider_error').slice(0, 100)] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist a generated binary image into chunked D1 tables and prune old entries past cap.
 */
export async function storeGeneratedImage(env, owner, record) {
  const id = crypto.randomUUID();
  const bytes = record.bytes;
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / IMAGE_CHUNK_BYTES));
  const now = Date.now();

  const statements = [
    env.DB.prepare(
      `INSERT INTO generated_images(
        id, owner, conversation_id, title, prompt, enhanced_prompt, style,
        aspect_ratio, width, height, engine, model, mime_type, byte_size, chunks, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id,
      owner,
      String(record.conversationId || ''),
      String(record.title || '').slice(0, 180),
      String(record.prompt || '').slice(0, 2000),
      String(record.enhancedPrompt || '').slice(0, 2000),
      String(record.style || 'auto'),
      String(record.aspectRatio || '1:1'),
      Number(record.width) || 1024,
      Number(record.height) || 1024,
      String(record.engine || ''),
      String(record.model || ''),
      String(record.mimeType || 'image/jpeg'),
      bytes.byteLength,
      totalChunks,
      now
    )
  ];

  for (let part = 0; part < totalChunks; part += 1) {
    const slice = bytes.subarray(part * IMAGE_CHUNK_BYTES, (part + 1) * IMAGE_CHUNK_BYTES);
    const b64 = bytesToBase64(slice);
    statements.push(
      env.DB.prepare('INSERT INTO generated_image_chunks(image_id, part, data) VALUES (?,?,?)').bind(id, part, b64)
    );
  }

  await env.DB.batch(statements);

  // Best-effort rolling retention cleanup so free D1 storage stays feather-light forever.
  pruneOldGeneratedImages(env, owner).catch(() => {});

  return {
    id,
    url: `/api/images/${id}`,
    downloadUrl: `/api/images/${id}?download=1`,
    title: String(record.title || '').slice(0, 180),
    prompt: String(record.prompt || ''),
    enhancedPrompt: String(record.enhancedPrompt || ''),
    style: String(record.style || 'auto'),
    aspectRatio: String(record.aspectRatio || '1:1'),
    width: Number(record.width) || 1024,
    height: Number(record.height) || 1024,
    engine: String(record.engine || ''),
    model: String(record.model || ''),
    modelLabel: String(record.modelLabel || record.model || ''),
    mimeType: String(record.mimeType || 'image/jpeg'),
    byteSize: bytes.byteLength,
    createdAt: now
  };
}

async function pruneOldGeneratedImages(env, owner) {
  const oldRows = await env.DB.prepare(
    `SELECT id FROM generated_images
     WHERE owner=?
     ORDER BY created_at DESC
     LIMIT 40 OFFSET ?`
  )
    .bind(owner, MAX_STORED_IMAGES_PER_OWNER)
    .all();
  const ids = (oldRows?.results || []).map((r) => r.id).filter(Boolean);
  if (!ids.length) return;
  const stmts = [];
  for (const id of ids) {
    stmts.push(env.DB.prepare('DELETE FROM generated_image_chunks WHERE image_id=?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM generated_images WHERE id=? AND owner=?').bind(id, owner));
  }
  await env.DB.batch(stmts);
}

export async function loadGeneratedImage(env, owner, imageId) {
  const cleanId = String(imageId || '').trim();
  if (!cleanId || !/^[a-zA-Z0-9_-]{8,64}$/.test(cleanId)) {
    fail('شناسه تصویر معتبر نیست.', 400, 'bad_image_id');
  }
  const meta = await env.DB.prepare('SELECT * FROM generated_images WHERE id=? AND owner=?')
    .bind(cleanId, owner)
    .first();
  if (!meta) fail('تصویر مورد نظر پیدا نشد.', 404, 'image_not_found');

  const chunkRows = await env.DB.prepare(
    'SELECT part, data FROM generated_image_chunks WHERE image_id=? ORDER BY part ASC'
  )
    .bind(cleanId)
    .all();
  const list = chunkRows?.results || [];
  if (!list.length) fail('داده‌های تصویر در دیتابیس یافت نشد.', 404, 'image_chunks_missing');

  const decodedParts = list.map((row) => base64ToBytes(row.data));
  const totalBytes = decodedParts.reduce((sum, arr) => sum + arr.byteLength, 0);
  const full = new Uint8Array(totalBytes);
  let offset = 0;
  for (const arr of decodedParts) {
    full.set(arr, offset);
    offset += arr.byteLength;
  }

  return { meta, bytes: full };
}

export async function listGeneratedImages(env, owner, { limit = 24 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 24, 60));
  const rows = await env.DB.prepare(
    `SELECT id, conversation_id, title, prompt, enhanced_prompt, style, aspect_ratio,
            width, height, engine, model, mime_type, byte_size, created_at
     FROM generated_images
     WHERE owner=?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(owner, safeLimit)
    .all();
  return (rows?.results || []).map((r) => ({
    id: r.id,
    url: `/api/images/${r.id}`,
    downloadUrl: `/api/images/${r.id}?download=1`,
    conversationId: r.conversation_id,
    title: r.title,
    prompt: r.prompt,
    enhancedPrompt: r.enhanced_prompt,
    style: r.style,
    aspectRatio: r.aspect_ratio,
    width: r.width,
    height: r.height,
    engine: r.engine,
    model: r.model,
    mimeType: r.mime_type,
    byteSize: r.byte_size,
    createdAt: r.created_at
  }));
}

/**
 * End-to-end Studio Image Generation + D1 Persistence.
 */
export async function generateAndStoreImage(
  env,
  owner,
  {
    prompt,
    title = '',
    style = 'auto',
    aspectRatio = '1:1',
    engine = 'auto',
    enhance = true,
    seed,
    conversationId = '',
    externalSignal = null
  } = {}
) {
  const rawPrompt = String(prompt || '').trim();
  if (!rawPrompt) fail('لطفاً توضیح تصویر مورد نظر را بنویسید.', 400, 'empty_prompt');
  if (rawPrompt.length > 4000) fail('توضیح تصویر بیش از حد طولانی است.', 400, 'prompt_too_long');

  const normalizedRatio = normalizeAspectRatio(aspectRatio);
  const normalizedStyle = normalizeImageStyle(style);
  const { width, height } = IMAGE_ASPECT_SPECS[normalizedRatio];
  const resolvedSeed =
    Number.isInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 899_999) + 100_000;

  const enhancedPrompt = await enhanceImagePrompt(env, rawPrompt, normalizedStyle, { enhance });

  const requestedEngine = String(engine || 'auto').toLowerCase();
  const diagnostics = [];
  let generated = null;

  if (requestedEngine === 'provider') {
    const prov = await tryProviderImagesEndpoint(env, {
      prompt: enhancedPrompt,
      width,
      height,
      externalSignal
    });
    if (prov.ok) generated = prov;
    else diagnostics.push(...prov.errors);
  }

  if (!generated && requestedEngine !== 'free-relay') {
    const cf = await tryWorkersAiModels(env, {
      prompt: enhancedPrompt,
      aspectRatio: normalizedRatio,
      width,
      height,
      seed: resolvedSeed
    });
    if (cf.ok) generated = cf;
    else diagnostics.push(...cf.errors);
  }

  if (!generated && requestedEngine !== 'cloudflare-only') {
    const relay = await tryFreeUnlimitedFluxRelay({
      prompt: enhancedPrompt,
      width,
      height,
      seed: resolvedSeed,
      externalSignal
    });
    if (relay.ok) generated = relay;
    else diagnostics.push(...relay.errors);
  }

  if (!generated && requestedEngine === 'auto' && env?.MODEL_API_KEY) {
    const provFallback = await tryProviderImagesEndpoint(env, {
      prompt: enhancedPrompt,
      width,
      height,
      externalSignal
    });
    if (provFallback.ok) generated = provFallback;
    else diagnostics.push(...provFallback.errors);
  }

  if (!generated) {
    fail(
      'ساخت تصویر در این لحظه ناموفق بود. لطفاً چند ثانیه بعد دوباره امتحان کنید یا توضیح را کمی تغییر دهید.',
      502,
      'image_generation_failed',
      { attempts: diagnostics.slice(0, 6) }
    );
  }

  const cleanTitle =
    String(title || '').trim() ||
    rawPrompt
      .replace(/\s+/g, ' ')
      .slice(0, 72);

  return storeGeneratedImage(env, owner, {
    conversationId,
    title: cleanTitle,
    prompt: rawPrompt,
    enhancedPrompt,
    style: normalizedStyle,
    aspectRatio: normalizedRatio,
    width: generated.width,
    height: generated.height,
    engine: generated.engine,
    model: generated.model,
    modelLabel: generated.modelLabel,
    mimeType: generated.mimeType,
    bytes: generated.bytes
  });
}
