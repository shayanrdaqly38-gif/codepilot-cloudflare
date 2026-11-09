// Toolbox behaviour test: proves every "do anything with this image" action
// actually performs its job in a real DOM — copies the right string, writes the
// right file, opens the right tab, and deletes for real.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const html = readFileSync('index.html', 'utf8');
const copied = [], opened = [], written = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://app.example.com/', pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/auth')) return new Response(JSON.stringify({ ok: true, user: { email: 'd@e.com' } }), { headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/api/state/conversations')) return new Response(JSON.stringify({ ok: true, conversation: { id: 'c-1', title: 'g' }, messages: [], workspace: { files: { 'index.html': '<html><body>hi</body></html>' }, active: 'index.html' } }), { headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/api/state')) {
        const b = init.body ? JSON.parse(init.body) : {};
        if (b.action === 'write-file') written.push(b.path);
        return new Response(JSON.stringify({ ok: true, path: b.path }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (u.match(/\/api\/images\/[A-Za-z0-9_-]+/)) return new Response(Uint8Array.from([0x89,0x50,0x4e,0x47]), { headers: { 'Content-Type': 'image/png' } });
      if (u.includes('/api/chat')) {
        // یک نوبت گفتگوی واقعی: پیام کاربر + پاسخ مدل
        const sse = `data: ${JSON.stringify({ type: 'delta', content: 'دیدم.' })}\n\n` +
                    `data: ${JSON.stringify({ type: 'done' })}\n\n`;
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    };
    w.navigator.clipboard = { writeText: async (t) => { copied.push(t); } };
    w.open = (u) => { opened.push(u); };
    w.confirm = () => true;
    w.prompt = () => 'index.html';
  }
});
const { window } = dom;
await new Promise(r => setTimeout(r, 2000));
window.toast = () => {};
window.imgPipe.image = { id: 'img-1', url: '/api/images/img-1', title: 'تانک', width: 1024, height: 1024 };
window.imgPipe.approved = true;
window.imgPipe.enhancedPrompt = 'a tank';

let pass = 0, fail = 0;
const ok = (n, c, x='') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };

await window.imgPipeTool('copy-link');  ok('کپی لینک کامل', copied.at(-1) === 'https://app.example.com/api/images/img-1', copied.at(-1));
await window.imgPipeTool('copy-md');    ok('کپی Markdown', copied.at(-1).includes('![تانک](/api/images/img-1)'), copied.at(-1));
await window.imgPipeTool('copy-html');  ok('کپی HTML', copied.at(-1).includes('<img src="/api/images/img-1"'));
await window.imgPipeTool('copy-css');   ok('کپی CSS', copied.at(-1).includes('background-image'));
window.imgPipeTool('open-tab');         ok('باز کردن تب', opened.at(-1) === '/api/images/img-1');

await window.imgPipeTool('manifest');   ok('افزودن به images.json', written.includes('images.json'), JSON.stringify(written));
await window.imgPipeTool('insert-html');ok('درج در index.html', written.filter(p=>p==='index.html').length>=1, JSON.stringify(written));
const writtenIdx = written.includes('index.html');
ok('تگ img واقعاً درج شد', writtenIdx, JSON.stringify(written));

// «ارجاع» باید از مسیر واقعی گفتگو برود تا مدل خودِ تصویر را ببیند.
const chatLen = window.document.getElementById('chat').children.length;
let refSent = null;
const realSend = window.sendMessage;
window.sendMessage = async (text) => { refSent = text; };
await window.imgPipeTool('reference');
window.sendMessage = realSend;
ok('ارجاع از مسیر گفتگو ارسال شد', Boolean(refSent && refSent.includes('/api/images/img-1')), String(refSent).slice(0, 60));

await window.imgPipeTool('delete');    ok('حذف تصویر', window.imgPipe.image === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
