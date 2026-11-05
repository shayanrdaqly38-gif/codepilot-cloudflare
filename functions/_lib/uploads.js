import { fail } from './util.js';
import { MAX_ATTACHMENT_BYTES, validateAttachments, attachmentParts } from './attachments.js';

// A multiple of three permits concatenating separately encoded Base64 chunks.
// Each row remains comfortably below D1's row/value limit.
export const CHUNK_BYTES = 192_000;
const descriptor = ({ id, name, type, size }) => ({ id, name, type, size });
async function owned(env, owner, id) {
  const file = await env.DB.prepare('SELECT * FROM uploads WHERE id=? AND owner=?').bind(String(id || ''), owner).first();
  if (!file) fail('فایل آپلودشده پیدا نشد.', 404, 'upload_not_found');
  return file;
}
export async function uploadAction(env, owner, data) {
  if (data?.action === 'start') {
    if (!Number.isInteger(data.size) || data.size < 0 || data.size > MAX_ATTACHMENT_BYTES || typeof data.name !== 'string') fail('نام یا اندازهٔ فایل نامعتبر است.', 400, 'bad_upload');
    const usage = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM uploads WHERE owner=?').bind(owner).first();
    if (Number(usage?.bytes) + data.size > 200_000_000) fail('فضای پیوست‌ها پر است؛ پیوست‌های استفاده‌نشده را حذف کنید.', 413, 'upload_quota');
    const file = {
      id: crypto.randomUUID(),
      name: data.name.replace(/[\x00-\x1f]/g, '').slice(0, 180) || 'file',
      type: typeof data.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(data.type) ? data.type : 'application/octet-stream',
      size: data.size, chunks: Math.max(1, Math.ceil(data.size / CHUNK_BYTES))
    };
    await env.DB.prepare('INSERT INTO uploads(id,owner,name,type,size,chunks,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(file.id, owner, file.name, file.type, file.size, file.chunks, Date.now()).run();
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
  if (!Number.isInteger(data.part) || data.part < 0 || data.part > file.received || data.part >= file.chunks) fail('ترتیب بخش‌های آپلود صحیح نیست.', 409, 'bad_chunk');
  const expected = Math.min(CHUNK_BYTES, file.size - data.part * CHUNK_BYTES);
  if (typeof data.data !== 'string' || data.data.length > 256_000) fail('بخش فایل بیش از حد بزرگ است.', 413, 'bad_chunk');
  const [chunk] = validateAttachments([{ name: file.name, type: file.type, data: data.data }]);
  if (atob(chunk.data).length !== expected) fail('اندازهٔ بخش فایل صحیح نیست.', 400, 'bad_chunk');
  // A retry after a lost response must not duplicate or overwrite a chunk.
  if (data.part < file.received) {
    const old = await env.DB.prepare('SELECT data FROM upload_chunks WHERE upload_id=? AND part=?').bind(file.id, data.part).first();
    if (old?.data !== chunk.data) fail('محتوای بخش تکراری یکسان نیست.', 409, 'bad_chunk');
  } else {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO upload_chunks(upload_id,part,data) VALUES(?,?,?)').bind(file.id, data.part, chunk.data),
      env.DB.prepare('UPDATE uploads SET received=received+1 WHERE id=? AND received=?').bind(file.id, data.part)
    ]);
  }
  return { ok: true, ready: Math.max(file.received, data.part + 1) === file.chunks };
}

export async function resolveUploadRefs(env, owner, attachments) {
  const files = validateAttachments(attachments);
  const resolved = [];
  for (const item of files) {
    if (!item.id) { resolved.push(item); continue; }
    const file = await owned(env, owner, item.id);
    if (file.received !== file.chunks) fail('آپلود فایل هنوز کامل نشده است.', 409, 'upload_not_ready');
    resolved.push(descriptor(file));
  }
  // Check aggregate size again against trusted database metadata.
  return validateAttachments(resolved);
}

export async function hydrateUploadParts(env, owner, messages) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (let i = 0; i < message.content.length; i++) {
      const part = message.content[i];
      if (!part.uploadId) continue;
      const file = await owned(env, owner, part.uploadId);
      if (file.received !== file.chunks) fail('آپلود فایل هنوز کامل نشده است.', 409, 'upload_not_ready');
      const rows = await env.DB.prepare('SELECT data FROM upload_chunks WHERE upload_id=? ORDER BY part').bind(file.id).all();
      if (rows.results?.length !== file.chunks) fail('بخش‌های فایل کامل نیست.', 409, 'upload_incomplete');
      message.content[i] = attachmentParts([{ name: file.name, type: file.type, data: rows.results.map(row => row.data).join('') }])[0];
    }
  }
}
