import { fail, redactSecrets } from './util.js';
import { MAX_ATTACHMENT_BYTES, base64ByteLength, validateAttachments, attachmentParts } from './attachments.js';

// A multiple of three permits concatenating separately encoded Base64 chunks.
// Each row remains comfortably below D1's row/value limit.
export const CHUNK_BYTES = 192_000;
// Cap full in-memory chunk hydration at ~3.8 MB (20 chunks) so Cloudflare
// Workers (128 MB RAM / 10 ms Free CPU limit) and D1 (10 MB query response cap)
// can never OOM or throw HTTP 503 on 20 MB uploads.
const MAX_FULL_HYDRATE_CHUNKS = 20;

const descriptor = ({ id, name, type, size }) => ({ id, name, type, size });

async function owned(env, owner, id) {
  const file = await env.DB.prepare('SELECT * FROM uploads WHERE id=? AND owner=?').bind(String(id || ''), owner).first();
  if (!file) fail('فایل آپلودشده پیدا نشد.', 404, 'upload_not_found');
  return file;
}

function extractReadableStrings(b64Sample, maxChars = 6000) {
  if (!b64Sample) return '';
  const capped = b64Sample.slice(0, Math.min(b64Sample.length, 160_000) & ~3);
  let bin = '';
  try {
    bin = atob(capped);
  } catch {
    return '';
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!utf8.includes('\0')) return redactSecrets(utf8.slice(0, maxChars));
  } catch {
    // Not pure UTF-8; extract printable ASCII runs >= 6 chars (useful for PDFs/binaries).
  }
  const runs = [];
  let current = '';
  let total = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) {
      current += String.fromCharCode(b);
    } else {
      if (current.trim().length >= 6) {
        const clean = current.trim();
        runs.push(clean);
        total += clean.length;
        if (total >= maxChars) break;
      }
      current = '';
    }
  }
  if (current.trim().length >= 6 && total < maxChars) runs.push(current.trim());
  return runs.length ? redactSecrets(runs.join('\n').slice(0, maxChars)) : '';
}

export async function uploadAction(env, owner, data) {
  if (data?.action === 'start') {
    if (!Number.isInteger(data.size) || data.size < 0 || data.size > MAX_ATTACHMENT_BYTES || typeof data.name !== 'string') {
      fail('نام یا اندازهٔ فایل نامعتبر است.', 400, 'bad_upload');
    }
    const usage = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner=?').bind(owner).first();
    if (Number(usage?.bytes) + data.size > 200_000_000) {
      fail('فضای پیوست‌ها پر است؛ پیوست‌های استفاده‌نشده را حذف کنید.', 413, 'upload_quota');
    }
    const file = {
      id: crypto.randomUUID(),
      name: data.name.replace(/[\x00-\x1f]/g, '').slice(0, 180) || 'file',
      type: typeof data.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(data.type) ? data.type : 'application/octet-stream',
      size: data.size,
      chunks: Math.max(1, Math.ceil(data.size / CHUNK_BYTES))
    };
    await env.DB.prepare('INSERT INTO uploads(id,owner,name,type,size,chunks,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(file.id, owner, file.name, file.type, file.size, file.chunks, Date.now())
      .run();
    return { ...descriptor(file), chunks: file.chunks, chunkBytes: CHUNK_BYTES };
  }
  const file = await owned(env, owner, data?.id);
  if (data.action === 'delete') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM upload_chunks WHERE upload_id=?').bind(file.id),
      env.DB.prepare('DELETE FROM uploads WHERE id=? AND owner=?').bind(file.id, owner)
    ]);
    return { ok: true };
  }
  if (data.action !== 'chunk') fail('عملیات آپلود نامعتبر است.', 400, 'bad_upload_action');
  if (!Number.isInteger(data.part) || data.part < 0 || data.part > file.received || data.part >= file.chunks) {
    fail('ترتیب بخش‌های آپلود صحیح نیست.', 409, 'bad_chunk');
  }
  const expected = Math.min(CHUNK_BYTES, file.size - data.part * CHUNK_BYTES);
  if (typeof data.data !== 'string' || data.data.length > 256_000) fail('بخش فایل بیش از حد بزرگ است.', 413, 'bad_chunk');
  const actualBytes = base64ByteLength(data.data);
  if (actualBytes < 0) fail('پیوست نامعتبر است.', 400, 'bad_attachment');
  if (actualBytes !== expected) fail('اندازهٔ بخش فایل صحیح نیست.', 400, 'bad_chunk');

  // A retry after a lost response must not duplicate or overwrite a chunk.
  if (data.part < file.received) {
    const old = await env.DB.prepare('SELECT data FROM upload_chunks WHERE upload_id=? AND part=?').bind(file.id, data.part).first();
    if (old?.data !== data.data) fail('محتوای بخش تکراری یکسان نیست.', 409, 'bad_chunk');
  } else {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO upload_chunks(upload_id,part,data) VALUES(?,?,?)').bind(file.id, data.part, data.data),
      env.DB.prepare('UPDATE uploads SET received=received+1 WHERE id=? AND received=?').bind(file.id, data.part)
    ]);
  }
  return { ok: true, ready: Math.max(file.received, data.part + 1) === file.chunks };
}

export async function resolveUploadRefs(env, owner, attachments) {
  const files = validateAttachments(attachments);
  const resolved = [];
  for (const item of files) {
    if (!item.id) {
      resolved.push(item);
      continue;
    }
    const file = await owned(env, owner, item.id);
    if (file.received !== file.chunks) fail('آپلود فایل هنوز کامل نشده است.', 409, 'upload_not_ready');
    resolved.push(descriptor(file));
  }
  // Check aggregate size again against trusted database metadata.
  return validateAttachments(resolved);
}

export async function hydrateUploadParts(env, owner, messages, options = {}) {
  const resilient = Boolean(options.resilient);
  // Find indices of messages with upload parts so older historical turns stay lightweight.
  const uploadMsgIndices = [];
  for (let m = 0; m < messages.length; m += 1) {
    if (Array.isArray(messages[m].content) && messages[m].content.some((p) => p && p.uploadId)) {
      uploadMsgIndices.push(m);
    }
  }
  const activeSet = new Set(resilient ? uploadMsgIndices.slice(-2) : uploadMsgIndices);

  for (let m = 0; m < messages.length; m += 1) {
    const message = messages[m];
    if (!Array.isArray(message.content)) continue;
    for (let i = 0; i < message.content.length; i += 1) {
      const part = message.content[i];
      if (!part || !part.uploadId) continue;

      if (!activeSet.has(m)) {
        message.content[i] = { type: 'text', text: `${part.text || '[پیوست قبلی]'} (در پیام‌های قبلی بررسی شد)` };
        continue;
      }

      let file;
      try {
        file = await owned(env, owner, part.uploadId);
      } catch (err) {
        if (!resilient) throw err;
        message.content[i] = { type: 'text', text: `${part.text || '[پیوست]'} (فایل پیوست دیگر در دسترس نیست)` };
        continue;
      }
      if (file.received !== file.chunks) {
        if (!resilient) fail('آپلود فایل هنوز کامل نشده است.', 409, 'upload_not_ready');
        message.content[i] = { type: 'text', text: `[پیوست ناقص: ${file.name}]` };
        continue;
      }

      const isImage = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
      // Large files (> 3.8 MB) or non-image binaries in resilient chat mode:
      // read ONLY chunk 0 so we never exceed D1's 10 MB response cap or Worker's 10 ms CPU / 128 MB RAM limit!
      if (file.chunks > MAX_FULL_HYDRATE_CHUNKS) {
        const firstChunk = await env.DB.prepare('SELECT data FROM upload_chunks WHERE upload_id=? AND part=?')
          .bind(file.id, 0)
          .first();
        const preview = extractReadableStrings(firstChunk?.data || '', 8000);
        message.content[i] = {
          type: 'text',
          text:
            `[پیوست بزرگ: ${file.name} · نوع: ${file.type} · حجم: ${file.size.toLocaleString('en-US')} بایت]\n` +
            (preview
              ? `نمونهٔ محتوای قابل‌خواندن ابتدای فایل:\n${preview}`
              : '(فایل باینری بزرگ در D1 ذخیره شد؛ برای تصاویر جهت تحلیل بصری مستقیم، حجم زیر ۳.۸ مگابایت توصیه می‌شود.)')
        };
        continue;
      }

      const rows = await env.DB.prepare('SELECT data FROM upload_chunks WHERE upload_id=? ORDER BY part').bind(file.id).all();
      if (rows.results?.length !== file.chunks) {
        if (!resilient) fail('بخش‌های فایل کامل نیست.', 409, 'upload_incomplete');
        message.content[i] = { type: 'text', text: `[پیوست ناقص: ${file.name}]` };
        continue;
      }
      const joined = rows.results.map((row) => row.data).join('');
      const hydrated = attachmentParts([{ name: file.name, type: file.type, data: joined }])[0];
      // In live chat mode (`resilient: true`), convert raw `{ type: 'file' }` binary parts into
      // extracted strings + metadata so OpenAI-compatible proxies (like tooken.club / Claude)
      // never reject or 503 on unsupported `type: "file"` content blocks!
      if (resilient && hydrated.type === 'file' && !isImage) {
        const preview = extractReadableStrings(joined, 8000);
        message.content[i] = {
          type: 'text',
          text:
            `[فایل باینری پیوست‌شده: ${file.name} · نوع: ${file.type} · حجم: ${file.size} بایت]\n` +
            (preview ? `متن‌های قابل‌استخراج از فایل:\n${preview}` : '(فایل باینری بدون متن خام UTF-8)')
        };
      } else {
        message.content[i] = hydrated;
      }
    }
  }
}
