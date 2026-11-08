import { performance } from 'node:perf_hooks';
const { hydrateUploadParts } = await import('../functions/_lib/uploads.js');
const CHUNK_BYTES = 200_000;
import { uploadAction, resolveUploadRefs } from '../functions/_lib/uploads.js';

function makeEnv() {
  const rows = { uploads: new Map(), upload_chunks: new Map() };
  const DB = {
    prepare(sql) {
      const s = sql;
      let params = [];
      const stmt = {
        bind(...p) { params = p; return stmt; },
        async run() {
          if (/^INSERT INTO upload_chunks/.test(s)) rows.upload_chunks.set(`${params[0]}:${params[1]}`, { data: params[2] });
          else if (/^UPDATE uploads SET received/.test(s)) {
            const f = rows.uploads.get(params[0]); if (f) f.received += 1;
          }
          return {};
        },
        async first() {
          if (/^SELECT \* FROM uploads/.test(s)) return rows.uploads.get(params[0]) || null;
          if (/^SELECT data FROM upload_chunks/.test(s)) return rows.upload_chunks.get(`${params[0]}:${params[1]}`) || null;
          if (/SUM\(size\)/.test(s)) return { bytes: 0 };
          return null;
        },
        async all() { return { results: [] }; }
      };
      return stmt;
    },
    async batch(stmts) { for (const st of stmts) await st.run(); }
  };
  return { DB, rows };
}

const env = makeEnv();
const totalChunks = 22;
const size = totalChunks * CHUNK_BYTES;
const started = await uploadAction(env, 'alice', { action: 'start', name: 'report.pdf', size, type: 'application/pdf' });
const headerBuf = Buffer.alloc(CHUNK_BYTES, 0);
Buffer.from('%PDF-1.7 Sample Embedded Text Inside Large Binary').copy(headerBuf, 0);
const full = Buffer.alloc(CHUNK_BYTES, 65).toString('base64');
await uploadAction(env, 'alice', { action: 'chunk', id: started.id, part: 0, data: headerBuf.toString('base64') });
for (let p = 1; p < totalChunks; p++) await uploadAction(env, 'alice', { action: 'chunk', id: started.id, part: p, data: full });
const refs = await resolveUploadRefs(env, 'alice', [started]);
const messages = [{
  role: 'user',
  content: [
    { type: 'text', text: 'read' },
    { type: 'text', text: '[پیوست: report.pdf]', uploadId: started.id }
  ]
}];

// warm up
for (let i = 0; i < 3; i++) {
  messages[0].content[1] = { type: 'text', text: '[پیوست: report.pdf]', uploadId: started.id };
  await hydrateUploadParts(env, 'alice', messages, { resilient: true });
}
const times = [];
for (let i = 0; i < 5; i++) {
  messages[0].content[1] = { type: 'text', text: '[پیوست: report.pdf]', uploadId: started.id };
  const t0 = performance.now();
  await hydrateUploadParts(env, 'alice', messages, { resilient: true });
  times.push(performance.now() - t0);
}
console.log('times:', times.map(t => t.toFixed(2)).join(' '), 'avg', (times.reduce((a, b) => a + b) / times.length).toFixed(2));
console.log('node', process.version, process.arch);
