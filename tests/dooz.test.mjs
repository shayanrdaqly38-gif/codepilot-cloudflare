// tests/dooz.test.mjs — تست‌های دکمه تمام‌صفحه و منطق بازی دوز (dooz.html)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'dooz.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('dooz.html: بلوک اسکریپت پیدا نشد');
const code = m[1];

function makeEl() {
  return {
    textContent: '', disabled: false, className: '', value: '', checked: false,
    hidden: false, style: {}, dataset: {}, attrs: {},
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] ??= []).push(fn); },
    classList: {
      set: new Set(),
      add(...a) { a.forEach((x) => this.set.add(x)); },
      remove(...a) { a.forEach((x) => this.set.delete(x)); },
      toggle(x, force) {
        if (force === undefined) force = !this.set.has(x);
        force ? this.set.add(x) : this.set.delete(x);
        return force;
      },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild() {}, remove() {},
  };
}

function makeDOM() {
  const els = {};
  const gameEl = makeEl();
  const doc = {
    elements: els,
    getElementById(id) { return (els[id] ??= makeEl()); },
    querySelector(sel) { return sel === '.game' ? gameEl : null; },
    createElement() { return makeEl(); },
    fullscreenElement: null, webkitFullscreenElement: null,
    exitFullscreen: null, webkitExitFullscreen: null,
    exitCalls: 0, webkitExitCalls: 0,
    addEventListener() {},
  };
  const g = globalThis;
  const prevDoc = g.document, prevLS = g.localStorage;
  g.document = doc;
  g.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
  };
  return { doc, gameEl, restore() { g.document = prevDoc; g.localStorage = prevLS; } };
}

function runScenario(setup) {
  const env = makeDOM();
  try {
    setup(env);
    // ارزیابی کد واقعی بازی + هوک تست
    const harness = `
      globalThis.__h = { fsBtn, toggleFs, syncFsBtn, isFs, gameEl: document.querySelector('.game') };
    `;
    (0, eval)(code + harness);
    return globalThis.__h;
  } finally {
    env.restore();
    delete globalThis.__h;
  }
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// ── سناریوی ۱: API استاندارد (Chrome/Firefox/Edge)
console.log('سناریوی ۱ — API استاندارد fullscreen');
{
  let gameEl;
  const h = runScenario((env) => {
    gameEl = env.gameEl;
    env.doc.fullscreenElement = null;
    gameEl.requestFullscreen = function () { env.doc.fullscreenElement = gameEl; return Promise.resolve(); };
    env.doc.exitFullscreen = function () { env.doc.fullscreenElement = null; env.doc.exitCalls++; return Promise.resolve(); };
  });
  check('برچسب اولیه «تمام صفحه» است', h.fsBtn.textContent.includes('تمام صفحه'));
  check('aria-pressed اولیه false است', h.fsBtn.attrs['aria-pressed'] === 'false');
  h.toggleFs();
  check('پس از ورود، برچسب «خروج از تمام صفحه» است', h.fsBtn.textContent.includes('خروج'));
  check('aria-pressed پس از ورود true است', h.fsBtn.attrs['aria-pressed'] === 'true');
  h.toggleFs();
  check('خروج، exitFullscreen را صدا می‌زند', envDocExitCalls === 1);
  check('پس از خروج برچسب بازگشته است', h.fsBtn.textContent.includes('تمام صفحه') && !h.fsBtn.textContent.includes('خروج'));
}

// ── سناریوی ۲: پیشوند پیشکی (Safari قدیمی)
console.log('سناریوی ۲ — API با پیشوند webkit');
{
  let gameEl;
  const h = runScenario((env) => {
    gameEl = env.gameEl;
    gameEl.webkitRequestFullscreen = function () { env.doc.webkitFullscreenElement = gameEl; return Promise.resolve(); };
    env.doc.webkitExitFullscreen = function () { env.doc.webkitFullscreenElement = null; env.doc.webkitExitCalls++; return Promise.resolve(); };
  });
  h.toggleFs();
  check('ورود webkit فراخوانی شد', h.isFs());
  check('برچسب خروج فعال شد', h.fsBtn.textContent.includes('خروج'));
  h.toggleFs();
  check('خروج webkit فراخوانی شد', !h.isFs() && !h.fsBtn.textContent.includes('خروج'));
}

// ── سناریوی ۳: بدون پشتیبانی از تمام‌صفحه
console.log('سناریوی ۳ — مرورگر بدون پشتیبانی');
{
  const h = runScenario(() => {});
  h.toggleFs();
  check('دکمه غیرفعال می‌شود', h.fsBtn.disabled === true);
}

console.log(`\nنتیجه: ${passed} موفق، ${failed} ناموفق`);
process.exit(failed ? 1 : 0);
