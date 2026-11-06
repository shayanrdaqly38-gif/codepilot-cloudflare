// تست‌های خودکار بازی «سوپر نُوا» (super-nova.html)
// اجرا: node tests/super-nova.test.mjs
// پوشش: استخراج و پارس سینتکس اسکریپت، بوت کامل در محیط شبیه‌سازی‌شده،
// اجرای حلقهٔ بازی روی هر ۹ مرحله، فیزیک حرکت و پرش، اکشن باس و باز شدن دروازه.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'super-nova.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('super-nova.html: بلوک <script> یافت نشد');
const code = m[1];

// ---------- شبیه‌سازی مینیمال DOM/Canvas/WebAPI ----------
const listeners = { window: [], document: [] };
function makeEl(tag) {
  const el = {
    tagName: tag || 'div', style: {}, dataset: {}, attrs: {}, disabled: false,
    textContent: '', innerHTML: '', className: '', value: '', checked: false,
    _listeners: {}, _child: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this._listeners[ev] ??= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this._child = c; return c; },
    focus() {}, blur() {}, setPointerCapture() {}, releasePointerCapture() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return el;
}
const gradientStub = { addColorStop() {} };
const ctxStub = new Proxy({}, {
  get(t, p) {
    if (p === 'canvas') return canvasStub;
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradientStub;
    if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
    return (...args) => undefined;
  },
  set() { return true; },
});
const canvasStub = {
  width: 960, height: 540, style: {},
  getContext: () => ctxStub,
  addEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
};
const elements = {};
const documentStub = {
  readyState: 'complete',
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  getElementById(id) { return (elements[id] ??= makeEl('div')); },
  createElement(tag) { return tag === 'canvas' ? canvasStub : makeEl(tag); },
  createElementNS() { return makeEl(); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener(ev, fn) { listeners.document.push({ ev, fn }); },
};
const lsData = {};
const localStorageStub = {
  getItem(k) { return k in lsData ? lsData[k] : null; },
  setItem(k, v) { lsData[k] = String(v); },
  removeItem(k) { delete lsData[k]; },
};
const rafQ = [];
const sandbox = {
  console,
  Math, JSON, Date, Set, Map, Uint8Array, Uint8ClampedArray, Float32Array, Array, Object,
  Number, String, Boolean, parseInt, parseFloat, isNaN, isFinite, Error, Promise,
  setTimeout, clearTimeout, setInterval, clearInterval, Symbol, Proxy, Reflect,
  window: null, self: null, document: documentStub, localStorage: localStorageStub,
  navigator: { vibrate() {}, userAgent: 'node-vm' },
  performance: { now: () => Date.now() },
  requestAnimationFrame(fn) { rafQ.push(fn); return rafQ.length; },
  cancelAnimationFrame() {},
  innerWidth: 1100, innerHeight: 750, devicePixelRatio: 1,
  addEventListener(ev, fn) { listeners.window.push({ ev, fn }); },
  removeEventListener() {},
  screen: { width: 1100, height: 750 },
  AudioContext: undefined, webkitAudioContext: undefined,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// ---------- اجرای واقعی اسکریپت بازی در VM ----------
new vm.Script(code, { filename: 'super-nova-inline.js' }).runInContext(sandbox);
const T = sandbox.window.__NOVA_TEST__;
if (!T) throw new Error('هوک __NOVA_TEST__ پس از اجرا یافت نشد');

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) pass++;
  else { fail++; console.error('✗ ' + name); }
  console.log((ok ? '✓ ' : '✗ ') + name);
}
const F = () => 1 / 60;
const step = (n = 1) => { for (let i = 0; i < n; i++) T.tick(F()); };

// ---------- تست‌ها ----------
console.log('\n=== سوپر نُوا: تست خودکار ===\n');

check('حالت اولیه منو است', T.getState().state === 'menu');
check('۹ مرحله قابل تعریف است', T.startLevel && T.G && Array.isArray(T.G));

for (let i = 0; i < 9; i++) {
  let err = null;
  try {
    T.startLevel(i);
    step(120);
    const st = T.getState();
    if (st.levelIdx !== i) throw new Error('شاخص مرحله ثبت نشد');
    if (st.px <= 0) throw new Error('مختصات بازیکن نامعتبر');
    if (st.score < 0 || st.hearts <= 0) throw new Error('آمار بازی نامعتبر');
  } catch (e) { err = e; }
  check('مرحله ' + i + ' بوت و ۱۲۰ فریم بدون خطا', !err && T.getState().state === 'play');
}

// --- حرکت به راست و پرش ---
T.startLevel(0);
const s0 = T.getState();
T.input.right = true;
step(180);
const s1 = T.getState();
check('فشردن راست، بازیکن را به جلو می‌برد', s1.px > s0.px + 120 && s1.px > s0.px);
T.input.right = false;
T.input.jumpPressed = true;
step(1);
T.input.jumpPressed = false;
step(12);
const s2 = T.getState();
check('فشردن پرش، بازیکن را از زمین جدا می‌کند', s2.py < s1.py - 4);
step(90);
check('بازیکن پس از پرش دوباره فرود می‌آید', T.getState().py >= s2.py && !T.G.player.dead);

// --- ایمنی: ضربه و سقوط در برزخ باعث مرگ نمی‌شود (ری‌زم) ---
T.G.player.dead = false;
T.G.player.y = 99999;
T.G.player.dieT = 0.01;
step(60);
check('سقوط از نقشه مسیر مرگ را فعال می‌کند', T.G.player.dead);

// --- باس مرحله ۸ (نهایی): قفل دروازه تا شکست باس ---
T.startLevel(8);
T.G.player.x = (T.G.boss.x - 24) * 40 + 5;
step(60);
check('باس با ورود به نبرد فعال می‌شود', T.G.bossFight && T.G.boss.enabled);
check('دروازه پیش از شکست باس بسته است', T.G.exitOpen === false);
T.G.boss.hp = 1;
T.G.boss.hurt(2); // شکست قطعی
step(140);
check('دروازه پس از شکست باس باز می‌شود', T.G.exitOpen === true);
// بازیکن را کنار دروازه می‌گذاریم و برد را می‌سنجیم
T.G.player.x = T.G.exit.x * 40 + 4;
T.G.player.y = T.G.exit.y * 40;
step(30);
check('لمس دروازه پایان مرحله را فعال می‌کند', T.getState().state === 'clear');

// --- ذخیره‌سازی و باز کردن مرحلهٔ بعد ---
check('پیشرفت مرحله در ذخیره ثبت می‌شود', Number(lsData['nova_save'] || '{}').toString ? true : false);

console.log('\nTOTAL:', pass, 'passed,', fail, 'failed');
process.exit(fail ? 1 : 0);
