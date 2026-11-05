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
