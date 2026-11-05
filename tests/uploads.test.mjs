import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { uploadAction, resolveUploadRefs, hydrateUploadParts, CHUNK_BYTES } from '../functions/_lib/uploads.js';
import { toWire } from '../functions/_lib/memory.js';
import { onRequest } from '../functions/api/uploads.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function makeEnv() {
  const files = new Map(), chunks = new Map();
  const DB = {
    prepare(sql) {
      return { bind(...p) {
        return {
          async first() {
            if (sql.includes('SUM(size)')) return { bytes: [...files.values()].filter(f => f.owner === p[0]).reduce((n, f) => n + f.size, 0) };
            if (sql.startsWith('SELECT data')) return chunks.has(p[0] + ':' + p[1]) ? {data:chunks.get(p[0] + ':' + p[1])} : null;
            const file = files.get(p[0]);
            return file?.owner === p[1] ? {...file} : null;
          },
          async all() {
            return { results:[...chunks].filter(([key]) => key.startsWith(p[0] + ':')).sort(([a],[b]) => Number(a.split(':')[1]) - Number(b.split(':')[1])).map(([,data]) => ({data})) };
          },
          async run() {
            if (sql.startsWith('INSERT INTO uploads')) files.set(p[0], {id:p[0],owner:p[1],name:p[2],type:p[3],size:p[4],chunks:p[5],received:0});
            else if (sql.startsWith('INSERT INTO upload_chunks')) {
              const key = p[0] + ':' + p[1];
              if (chunks.has(key)) throw new Error('duplicate');
              chunks.set(key,p[2]);
            } else if (sql.startsWith('UPDATE uploads')) { if (files.get(p[0]).received === p[1]) files.get(p[0]).received++; }
            else if (sql.startsWith('DELETE FROM upload_chunks')) { for (const key of chunks.keys()) if (key.startsWith(p[0]+':')) chunks.delete(key); }
            else if (sql.startsWith('DELETE FROM uploads')) files.delete(p[0]);
            else throw new Error('unexpected SQL ' + sql);
          }
        };
      }};
    },
    async batch(stmts) { for (const stmt of stmts) await stmt.run(); }
  };
  return {DB};
}

test('upload API exists and returns JSON for unsupported method', async () => {
  const response = await onRequest({request:new Request('https://app.test/api/uploads',{method:'PUT'}),env:{}});
  assert.equal(response.status,405);
  assert.match(response.headers.get('content-type'),/application\/json/);
  assert.equal((await response.json()).code,'method_not_allowed');
});

test('upload lifecycle rejects incomplete and cross-owner references; hydrates model parts', async () => {
  const env = makeEnv();
  const file = await uploadAction(env,'alice',{action:'start',name:'hello.txt',size:5,type:'text/plain'});
  assert.equal(file.chunkBytes,CHUNK_BYTES);
  await assert.rejects(resolveUploadRefs(env,'alice',[file]),/کامل/);
  await assert.rejects(uploadAction(env,'bob',{action:'chunk',id:file.id,part:0,data:btoa('hello')}));
  assert.equal((await uploadAction(env,'alice',{action:'chunk',id:file.id,part:0,data:btoa('hello')})).ready,true);
  // Lost-response retry is idempotent.
  assert.equal((await uploadAction(env,'alice',{action:'chunk',id:file.id,part:0,data:btoa('hello')})).ready,true);
  await assert.rejects(uploadAction(env,'alice',{action:'chunk',id:file.id,part:0,data:btoa('other')}));
  const refs = await resolveUploadRefs(env,'alice',[file]);
  assert.equal(refs[0].data,undefined);
  const messages = [toWire({role:'user',content:'read',attachments:refs})];
  await hydrateUploadParts(env,'alice',messages);
  assert.match(messages[0].content[1].text,/hello/);
  assert.equal(messages[0].content[1].uploadId,undefined);
  await assert.rejects(resolveUploadRefs(env,'bob',[file]));
  await uploadAction(env,'alice',{action:'delete',id:file.id});
  await assert.rejects(resolveUploadRefs(env,'alice',[file]));
});

test('chunks enforce exact size, order and aggregate trusted file sizes', async () => {
  const env = makeEnv();
  const file = await uploadAction(env,'alice',{action:'start',name:'big.bin',size:CHUNK_BYTES+1});
  await assert.rejects(uploadAction(env,'alice',{action:'chunk',id:file.id,part:1,data:'AA=='}));
  await assert.rejects(uploadAction(env,'alice',{action:'chunk',id:file.id,part:0,data:'AA=='}));
  assert.equal((await uploadAction(env,'alice',{action:'chunk',id:file.id,part:0,data:Buffer.alloc(CHUNK_BYTES).toString('base64')})).ready,false);
  await assert.rejects(resolveUploadRefs(env,'alice',[file]));
  assert.equal((await uploadAction(env,'alice',{action:'chunk',id:file.id,part:1,data:'AA=='})).ready,true);
  const refs = await resolveUploadRefs(env,'alice',[{...file,size:0,name:'forged'}]);
  assert.equal(refs[0].size,CHUNK_BYTES+1);
  assert.equal(refs[0].name,'big.bin');
});

test('resilient chat hydration handles multi-MB (>20 chunk) uploads, binary files, and deleted history refs without 503 CPU spikes', async () => {
  const env = makeEnv();
  const totalChunks = 22; // ~4.22 MB (> MAX_FULL_HYDRATE_CHUNKS)
  const size = totalChunks * CHUNK_BYTES;
  const started = await uploadAction(env, 'alice', { action: 'start', name: 'report.pdf', size, type: 'application/pdf' });
  const headerBuf = Buffer.alloc(CHUNK_BYTES, 0);
  Buffer.from('%PDF-1.7 Sample Embedded Text Inside Large Binary').copy(headerBuf, 0);
  const fullChunkB64 = Buffer.alloc(CHUNK_BYTES, 65).toString('base64');
  await uploadAction(env, 'alice', { action: 'chunk', id: started.id, part: 0, data: headerBuf.toString('base64') });
  for (let part = 1; part < totalChunks; part += 1) {
    await uploadAction(env, 'alice', { action: 'chunk', id: started.id, part, data: fullChunkB64 });
  }
  const refs = await resolveUploadRefs(env, 'alice', [started]);

  // Include a deleted historical upload on an older turn + the active 4.22 MB PDF on the latest turn.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'text', text: '[پیوست: gone.bin]', uploadId: '00000000-0000-0000-0000-000000000000' }] },
    { role: 'user', content: [{ type: 'text', text: 'old2' }, { type: 'text', text: '[پیوست: gone2.bin]', uploadId: '00000000-0000-0000-0000-000000000001' }] },
    toWire({ role: 'user', content: 'خلاصه کن', attachments: refs })
  ];

  const t0 = performance.now();
  await hydrateUploadParts(env, 'alice', messages, { resilient: true });
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 35, `hydration took too long: ${elapsedMs.toFixed(2)}ms`);
  assert.match(messages[0].content[1].text, /در پیام‌های قبلی بررسی شد/);
  assert.match(messages[1].content[1].text, /در دسترس نیست/);
  assert.equal(messages[2].content[1].type, 'text');
  assert.match(messages[2].content[1].text, /Sample Embedded Text Inside Large Binary/);
});

test('callModel recovers from upstream 503 via binary file-part downgrade and CF_PAGES model failover', async () => {
  const { callModel } = await import('../functions/_lib/model.js');
  const originalFetch = globalThis.fetch;

  // Case 1: Upstream returns 503 when `{ type: 'file' }` is present, then 200 once downgraded to text.
  const seenBodies = [];
  globalThis.fetch = async (_url, init) => {
    const parsed = JSON.parse(init.body);
    seenBodies.push(parsed);
    const hasFileBlock = parsed.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file')
    );
    if (hasFileBlock) return new Response('upstream 503 on binary block', { status: 503 });
    return new Response(
      JSON.stringify({ model: parsed.model, choices: [{ message: { role: 'assistant', content: 'recovered-from-file' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  try {
    const res1 = await callModel(
      { MODEL_API_KEY: 'tc_test_1234567890123456' },
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check' },
              { type: 'file', file: { filename: 'a.bin', file_data: 'data:application/octet-stream;base64,AP8=' } }
            ]
          }
        ]
      }
    );
    assert.equal(res1.message.content, 'recovered-from-file');
    assert.equal(seenBodies.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Case 2: On live Cloudflare Pages (`CF_PAGES: '1'`), if selected model channel returns 503, fail over to backup model.
  const modelsTried = [];
  globalThis.fetch = async (_url, init) => {
    const parsed = JSON.parse(init.body);
    modelsTried.push(parsed.model);
    if (parsed.model === 'claude-opus-5-5') {
      return new Response('channel overloaded', { status: 503, headers: { 'Retry-After': '0.01' } });
    }
    return new Response(
      JSON.stringify({ model: parsed.model, choices: [{ message: { role: 'assistant', content: 'failover-ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  try {
    const res2 = await callModel(
      { MODEL_API_KEY: 'tc_test_1234567890123456', CF_PAGES: '1' },
      { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'سلام' }] }
    );
    assert.equal(res2.message.content, 'failover-ok');
    assert.equal(res2.model, 'claude-sonnet-5-5');
    assert.deepEqual(modelsTried, ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
