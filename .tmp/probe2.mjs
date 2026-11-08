import { CHUNK_BYTES, resolveUploadRefs, hydrateUploadParts, uploadAction } from '../functions/_lib/uploads.js';

const fileStore = new Map(), chunkStore = new Map();
const DB = {
  prepare(sql){ return { bind(...p){ return {
    async first(){ for (const [id,f] of fileStore) if (sql.includes('WHERE id=?') && p[0]===id) return f; return null; },
    async all(){ const rows=[]; for (const [k,v] of chunkStore) if (k.startsWith(p[0])) rows.push(v); rows.sort((a,b)=>a.part-b.part); return {results:rows}; },
    async run(){ if (sql.includes('INSERT INTO uploads')) fileStore.set(p[0], p[1]); else chunkStore.set(p[0]+':'+p[1], {data:p[2],part:p[1]}); } }; } }; },
  async batch(stmts){ for (const s of stmts) await s.run(); }
};
const env = { DB };

const totalChunks = 22;
const size = totalChunks * CHUNK_BYTES;
const started = await uploadAction(env,'alice',{action:'start',name:'report.pdf',size,type:'application/pdf'});
const headerBuf = Buffer.alloc(CHUNK_BYTES, 0);
Buffer.from('%PDF-1.7 Sample Embedded Text Inside Large Binary').copy(headerBuf,0);
await uploadAction(env,'alice',{action:'chunk',id:started.id,part:0,data:headerBuf.toString('base64')});
for (let part=1; part<totalChunks; part++) {
  const bytes = Math.min(CHUNK_BYTES, size - part*CHUNK_BYTES);
  await uploadAction(env,'alice',{action:'chunk',id:started.id,part,data:Buffer.alloc(bytes,65).toString('base64')});
}

const refs = await resolveUploadRefs(env,'alice',[started]);
const messages = [
  {role:'user',content:[{type:'text',text:'old'},{type:'text',text:'[پیوست: gone.bin]',uploadId:'00000000-0000-0000-0000-000000000000'}]},
  {role:'user',content:[{type:'text',text:'old2'},{type:'text',text:'[پیوست: gone2.bin]',uploadId:'00000000-0000-0000-0000-000000000001'}]},
  {role:'user',content:[{type:'text',text:'خلاصه کن'},...(Array.isArray(refs[0])?refs[0]:[refs[0]])]}
];

for (let run=0; run<3; run++){
  const t0 = performance.now();
  await hydrateUploadParts(env,'alice', messages, {resilient:true});
  console.log('run',run, (performance.now()-t0).toFixed(2)+'ms', 'type='+messages[2].content[1].type, 'len='+(messages[2].content[1].text||'').length);
}
