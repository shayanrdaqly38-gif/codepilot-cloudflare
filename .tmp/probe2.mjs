import { CHUNK_BYTES, resolveUploadRefs, hydrateUploadParts, uploadAction } from '../functions/_lib/uploads.js';
import { toWire } from '../functions/_lib/memory.js';
import { webcrypto } from 'node:crypto';
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

const SIZE = CHUNK_BYTES * 21;
const messages = [];
const tSetup = performance.now();
const env = makeEnv();
const started = await uploadAction(env,'alice',{action:'start',name:'r.pdf',type:'application/pdf',size:SIZE});
const header = Buffer.alloc(CHUNK_BYTES,0);
Buffer.from('%PDF-1.7 Sample').copy(header,0);
const fill = Buffer.alloc(CHUNK_BYTES,65);
await uploadAction(env,'alice',{action:'chunk',id:started.id,part:0,data:header.toString('base64')});
for (let part=1; part<21; part++) await uploadAction(env,'alice',{action:'chunk',id:started.id,part,data:fill.toString('base64')});
const tUploads = performance.now();
const file = {id:started.id,name:'r.pdf',type:'application/pdf',size:SIZE,parts:null};
for (let k=0;k<22;k++) messages.push([toWire({role:'user',content:[{type:'text',text:'hi'},{type:'file',...file}]}), toWire({role:'assistant',content:'ok'})]);
messages.push([toWire({role:'user',content:'hi'}), toWire({role:'assistant',content:'ok'})]);
const tMsgs = performance.now();

let t = performance.now();
const refs = await resolveUploadRefs(env,'alice',[file]);
console.log('resolveUploadRefs        '+(performance.now()-t).toFixed(2)+'ms');

const withDeleted = [[...messages[0][0].content]];
withDeleted[0][1] = {type:'file',id:'missing-id',name:'x',size:1};
const deletedMsgs = [withDeleted[0], messages[0][1]];
const binaryMsgs = messages.map(m=>m);
t = performance.now();
await hydrateUploadParts(env,'alice',binaryMsgs,{resilient:true});
console.log('hydrate 22x 4MB refs     '+(performance.now()-t).toFixed(2)+'ms  active_type='+binaryMsgs[0][1].type);
t = performance.now();
await hydrateUploadParts(env,'alice',deletedMsgs,{resilient:true});
console.log('hydrate deleted ref      '+(performance.now()-t).toFixed(2)+'ms');
console.log('--- setup '+(tSetup-performance.now()+ (tMsgs-tSetup)).toFixed(0)+'ms total-ish; uploads='+((tUploads-tSetup)).toFixed(0)+'ms msgs='+((tMsgs-tUploads)).toFixed(0)+'ms');
