// End-to-end proof of the nine-stage image pipeline inside a real DOM.
// Drives index.html exactly like a user: type a prompt, click through every
// stage, and assert the DOM + the network calls each stage produces.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const html = readFileSync('index.html', 'utf8');
const calls = [];
const db = { conversations: [], messages: [], calls };

function jsonResponse(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://app.example.com/', pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = async (url, init = {}) => {
      const u = String(url); calls.push(u + ' ' + (init.method || 'GET'));
      if (u.includes('/api/auth')) return jsonResponse({ ok: true, user: { email: 'd@e.com' } });
      if (u.includes('/api/state/conversations')) return jsonResponse({ ok: true, conversation: { id: 'c-1', title: 'گ', mode: 'developer' }, messages: [], workspace: { files: {}, active: '' } });
      if (u.includes('/api/state')) {
        const body = init.body ? JSON.parse(init.body) : {};
        if (body.action === 'write-file') db.messages.push('WROTE:' + body.path);
        return jsonResponse({ ok: true, path: body.path, workspace: { files: { [body.path]: body.content }, active: body.path } });
      }
      if (u.includes('/api/images/enhance')) return jsonResponse({ ok: true, prompt: 'ENHANCED: a majestic golden tank, cinematic lighting, 8k', enhanced: true });
      if (u.match(/\/api\/images$/)) return jsonResponse({ ok: true, image: { id: 'img-1', url: '/api/images/img-1', downloadUrl: '/api/images/img-1?download=1', title: 'تانک', width: 1024, height: 1024, engine: 'cloudflare-ai' } });
      if (u.match(/\/api\/images\/[A-Za-z0-9_-]+/)) {
        const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
        return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (u.includes('/api/images')) return jsonResponse({ ok: true, images: [] });
      if (u.includes('/api/state')) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true });
    };
    window.addEventListener('error', (e) => console.log('PAGE ERROR:', e.message));
  }
});
const { window } = dom;
await new Promise(r => setTimeout(r, 2000));

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, x); } };
const $ = (id) => window.document.getElementById(id);

// --- مرحله ۱: دریافت پرامپت
$('imgStudioPrompt').value = 'یک تانک طلایی';
await window.startImagePipeline();
await new Promise(r => setTimeout(r, 600));

const list = $('imgPipeList');
const st = () => Array.from(list.children).map(li => li.getAttribute('data-status'));
console.log('  مراحل پس از تولید:', st().join(','));
ok('۱ دریافت پرامپت انجام شد', st()[0] === 'done');
ok('۲ تقویت پرامپت انجام شد', st()[1] === 'done');
ok('۳ تولید تصویر انجام شد', st()[2] === 'done');
ok('پرامپت تقویت‌شده نمایش داده شد', $('imgPipeEnhanced').value.includes('ENHANCED'));
ok('پیش‌نمایش تصویر نمایش داده شد', $('imgPipePreviewWrap').hidden === false);
ok('src تصویر ست شده', $('imgPipePreview').src.includes('/api/images/img-1'));
ok('دانلود لینک دارد', $('imgPipeDownloadBtn').getAttribute('href').includes('download=1'));
ok('دکمه‌های ذخیره/ارسال پنهان‌اند تا تایید', $('imgPipeActions').hidden === true);

// --- مرحله ۵: تایید
window.imgPipeApprove();
ok('۵ تایید شد', st()[4] === 'done');
ok('اکشن‌ها پس از تایید باز شدند', $('imgPipeActions').hidden === false);

// --- مرحله ۶: ذخیره (prompt را ماک می‌کنیم)
window.prompt = () => 'assets/tank.png';
window.fetch = (orig => async (url, init = {}) => {
  if (String(url).includes('/api/state')) {
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.action === 'write-file') { db.messages.push('SAVED:' + body.path); return jsonResponse({ ok: true, path: body.path }); }
  }
  return orig(url, init);
})(window.fetch);
await window.imgPipeSave();
ok('۶ ذخیره در پروژه', db.messages.some(m => m.startsWith('SAVED:')));

// --- مرحله ۷: دانلود
window.imgPipeMarkDownloaded();
ok('۷ دانلود علامت خورد', st()[6] === 'done');

// --- مرحله ۸/۹: ارسال و مالکیت
await window.imgPipeSendToChat();
await new Promise(r => setTimeout(r, 200));
ok('۸ ارسال به گفتگو', st()[7] === 'done');
ok('۹ جعبه‌ابزار باز شد', $('imgPipeToolbox').hidden === false);
ok('۹ جعبه‌ابزار پر از اکشن است', $('imgPipeToolGrid').children.length >= 10);

console.log('\n' + pass + ' passed, ' + fail + ' failed');

process.exit(fail ? 1 : 0);
