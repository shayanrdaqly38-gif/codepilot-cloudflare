// تست‌های خودکار بازی دوز (dooz.html)
// اجرا: node tests/dooz.test.mjs
// پوشش: تمام‌صفحه (استاندارد/webkit/بدون پشتیبانی)، صدا، لرزش، حرکت‌ها، برد و ناوبری کیبورد
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'dooz.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('dooz.html: block <script> یافت نشد');
const code = m[1];

function makeEl(onFocus) {
  return {
    textContent: '', disabled: false, value: '', checked: false, hidden: false, className: '',
    style: {}, dataset: {}, attrs: {}, _listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(ev, fn) { (this._listeners[ev] ??= []).push(fn); },
    dispatch(ev) { (this._listeners[ev] ?? []).forEach(f => f({})); },
    focus() { onFocus && onFocus(this); },
    classList: {
      set: new Set(),
      add(...a) { a.forEach(x => this.set.add(x)); },
      remove(...a) { a.forEach(x => this.set.delete(x)); },
      toggle(x, f) {
        if (f === undefined) f = !this.set.has(x);
        f ? this.set.add(x) : this.set.delete(x);
        return f;
      },
    },
    appendChild() {}, remove() {},
  };
}

function setup(type) {
  const els = {};
  const doc = {
    activeElement: null,
    getElementById: id => els[id] ??= makeEl(() => { doc.activeElement = els[id]; }),
    querySelector: sel => sel === '.game' ? gameEl : null,
    createElement: () => makeEl(() => { doc.activeElement = null; }),
    addEventListener(ev, fn) { this._listeners[ev] ??= []; this._listeners[ev].push(fn); },
    _listeners: {},
    fullscreenElement: null, webkitFullscreenElement: null,
    exitFullscreen: null, webkitExitFullscreen: null,
  };
  const gameEl = makeEl(() => { doc.activeElement = gameEl; });
  if (type === 'standard') {
    gameEl.requestFullscreen = () => { gameEl.reqCalls = (gameEl.reqCalls || 0) + 1; return Promise.resolve(); };
    doc.exitFullscreen = () => { doc.exitCalls = (doc.exitCalls || 0) + 1; return Promise.resolve(); };
  }
  if (type === 'webkit') {
    gameEl.webkitRequestFullscreen = () => { gameEl.reqCalls = (gameEl.reqCalls || 0) + 1; };
    doc.webkitExitFullscreen = () => { doc.exitCalls = (doc.exitCalls || 0) + 1; };
  }
  const lsData = {};
  const ls = {
    getItem: k => k in lsData ? lsData[k] : null,
    setItem: (k, v) => { lsData[k] = String(v); },
    removeItem: k => { delete lsData[k]; },
  };
  return { doc, els, gameEl, ls };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class FakeAudioContext {
  static osc = 0;
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = 'running'; }
  createOscillator() { FakeAudioContext.osc++; return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
}
globalThis.AudioContext = FakeAudioContext;

const scenarios = ['standard', 'webkit', 'unsupported'];
for (const type of scenarios) {
  const { doc, els, gameEl, ls } = setup(type);
  FakeAudioContext.osc = 0;
  const vib = [];
  globalThis.navigator = { vibrate: ms => { vib.push(ms); } };

  const fn = new Function('document', 'localStorage',
    code + '\n;globalThis.__h={isFs,toggleFs,syncFsBtn,fsBtn,soundBtn,sfx,buzz,play,cells,newRound};');
  fn(doc, ls);
  const h = globalThis.__h;

  console.log('\n== سناریو:', type, '==');
  check('تعداد سلول‌ها ۹ است', h.cells.length === 9);
  check('برچسب اولیه تمام‌صفحه', h.fsBtn.textContent === '⛶ تمام صفحه');

  if (type !== 'unsupported') {
    h.toggleFs();
    check('درخواست ورود تمام‌صفحه', gameEl.reqCalls === 1);
    if (type === 'webkit') doc.webkitFullscreenElement = gameEl; else doc.fullscreenElement = gameEl;
    h.syncFsBtn();
    check('برچسب خروج از تمام‌صفحه', h.fsBtn.textContent === '✕ خروج از تمام صفحه');
    check('aria-pressed=true', h.fsBtn.getAttribute('aria-pressed') === 'true');
    h.toggleFs();
    check('درخواست خروج تمام‌صفحه', doc.exitCalls === 1);
    if (type === 'webkit') doc.webkitFullscreenElement = null; else doc.fullscreenElement = null;
    h.syncFsBtn();
    check('بازگشت برچسب اولیه', h.fsBtn.textContent === '⛶ تمام صفحه');
  } else {
    h.toggleFs();
    check('غیرفعال‌سازی در نبود پشتیبانی', h.fsBtn.disabled === true);
  }

  // ── صدا ──
  check('صدا پیش‌فرض روشن', h.soundBtn.getAttribute('aria-pressed') === 'true');
  check('برچسب صدا (روشن)', h.soundBtn.textContent.includes('🔊'));
  h.soundBtn.dispatch('click');
  check('خاموش‌کردن صدا در localStorage ذخیره شد', ls.getItem('dooz-sound') === 'off');
  check('برچسب بی‌صدا', h.soundBtn.textContent.includes('🔇'));
  check('aria-pressed=false برای صدا', h.soundBtn.getAttribute('aria-pressed') === 'false');
  const oscSilent = FakeAudioContext.osc;
  h.sfx('place');
  check('در حالت خاموش صدایی تولید نمی‌شود', FakeAudioContext.osc === oscSilent);
  h.soundBtn.dispatch('click');
  check('روشن‌کردن دوباره صدا', ls.getItem('dooz-sound') === 'on' && h.soundBtn.getAttribute('aria-pressed') === 'true');
  h.sfx('place');
  check('پس از روشن‌شدن صدا تولید می‌شود', FakeAudioContext.osc > oscSilent);

  // ── حرکت، لرزش و برد (فقط در سناریوی استاندارد) ──
  if (type === 'standard') {
    h.play(0);
    check('حرکت روی صفحه ثبت شد', h.cells[0].textContent === 'X');
    check('لرزش هنگام حرکت', vib.some(v => deepEq(v, 12)));

    h.newRound();
    h.play(0); // X
    h.play(1); // O
    h.play(3); // X
    h.play(4); // O
    h.play(6); // X → ستون [0,3,6]
    const savedScores = JSON.parse(ls.getItem('dooz-scores-v1'));
    check('برد تشخیص داده شد و امتیاز ثبت شد', savedScores && savedScores.X === 1);
    check('صدای برد پخش شد (چند تُن)', FakeAudioContext.osc >= 3);
    check('لرزش برد به‌صورت الگو', vib.some(v => Array.isArray(v) && v.length === 3));

    // ── ناوبری کیبورد ──
    doc.activeElement = h.cells[4];
    const kb = doc._listeners['keydown'][0];
    kb({ key: 'ArrowRight', preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false });
    check('ناوبری کیبورد → راست', doc.activeElement === h.cells[5]);
    kb({ key: 'ArrowUp', preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false });
    check('ناوبری کیبورد → بالا', doc.activeElement === h.cells[2]);
  }
}

console.log('\nTOTAL:', pass, 'passed,', fail, 'failed');
process.exit(fail ? 1 : 0);
