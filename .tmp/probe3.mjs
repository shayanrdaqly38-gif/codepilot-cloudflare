import { CHUNK_BYTES, resolveUploadRefs, hydrateUploadParts, uploadAction } from '../functions/_lib/uploads.js';
import { toWire } from '../functions/_lib/memory.js';
import { webcrypto } from 'node:crypto';
globalThis.crypto = webcrypto;
const files = new Map(), chunks = new Map();
const DB = { prepare(sql) { return { bind(...p) { return {
  async first() {
    if (sql.includes('SUM(size)')) return { bytes: [...files.values()].filter(f => f.owner === p[0]).reduce((n, f) => n + f.size, 0) };
    if (sql.startsWith('SELECT data')) return chunks.has(p[0] + ':' + p[1]) ? {data:chunks.get(p[0] + ':' + p[1])} : null;
    const file = files.get(p[0]);
    return file?.owner === p[1] ? {...file} : null;
  },
  async all() { return { results:[...chunks].filter(([key]) => key.startsWith(p[0] + ':')).sort(([a],[b]) => Number(a.split(':')[1]) - Number(b.split(':')[1])).map(([,d]) => ({data:d})) }; },
  async run() {
    if (sql.startsWith('INSERT INTO uploads')) files.set(p[0], {id:p[0],owner:p[1],name:p[2],type:p[3],size:p[4],chunks:p[5],received:0});
    else if (sql.startsWith('INSERT OR IGNORE INTO upload_chunks')) { if (!chunks.has(p[0]+':'+p[1])) chunks.set(p[0]+':'+p[1], p[2]); }
    else if (sql.startsWith('DELETE FROM upload_chunks')) { for (const k of [...chunks.keys()]) if (k.startsWith(p[0]+':')) chunks.delete(k); }
    else if (sql.startsWith('DELETE FROM uploads')) { chunks.delete(p[0]);
      for (const k of [...chunks.keys()]) if (k.startsWith(p[0]+':')) chunks.delete(k); files.delete(p[0]); }
    else if (sql.startsWith('UPDATE uploads SET received')) { const f = files.get(p[0]); f.received = p[1]; }
    else if (sql.startsWith('INSERT INTO upload_chunks')) chunks.set(p[0]+':'+p[1], p[2]);
  },
  async batch(list) { for (const s of list) await s.run(); }
}; }, bind2(...p) { return { async run() { return DB.prepare(sql).bind(...p).run(); } }; } }; },
};

const env = { DB };
const clean = (v) => { if (typeof v !== 'string') return v; let out = ''; for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13) out += v[i]; else out += ' '; } return out; };
function makeBig(chunkCount) {
  const headerBuf = new Uint8Array(CHUNK_BYTES);
  const head = clean('%PDF-1.7 Sample Embedded Text Inside Large Binary');
  for (let i = 0; i < head.length; i++) headerBuf[i] = head.charCodeAt(i);
  const footer = new Uint8Array(CHUNK_BYTES).fill(65);
  return { headerBuf, footer };
}
const run = async () => {
  const env2 = { DB: DB };
  const totalChunks = 22;
  const size = totalChunks * CHUNK_BYTES;
  const started = await uploadAction(env2, 'alice', { action: 'start', name: 'report.pdf', size, type: 'application/pdf' });
  const { headerBuf, footer } = makeBig(totalChunks);
  const hb64 = Buffer.from(headerBuf).toString('base64');
  await uploadAction(env2, 'alice', { action: 'chunk', id: started.id, part: 0, data: hb64 });
  const fb64 = Buffer.from(footer).toString('base64');
  for (let part = 1; part < totalChunks; part += 1) await uploadAction(env2, 'alice', { action: 'chunk', id: started.id, part, data: fb64 });
  const refs = await resolveUploadRefs(env2, 'alice', [started]);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'text', text: '[پیوست: gone.bin]', uploadId: '00000000-0000-0000-0000-000000000000' }] },
    { role: 'user', content: [{ type: 'text', text: 'old2' }, { type: 'text', text: '[پیوست: gone2.bin]', uploadId: '00000000-0000-0000-0000-000000000001' }] },
    toWire({ role: 'user', content: 'خلاصه کن', attachments: refs })
  ];
  const t0 = performance.now();
  await hydrateUploadParts(env2, 'alice', messages, { resilient: true });
  const elapsed = performance.now() - t0;
  console.log('hydrate elapsed:', elapsed.toFixed(2), 'ms');
  console.log('msg0 content1 text:', messages[0].content[1].text.slice(0,40));
  console.log('msg1 content1 type:', messages[1].content[1].type, '| len', (messages[1].content[1].text||'').length);
  console.log('msg2 content1 type:', messages[2].content[1].type);
};
run().catch(e => { console.error('FAIL', e?.code || e?.message || e); process.exit(1); });
