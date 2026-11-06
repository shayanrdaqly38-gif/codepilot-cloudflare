// Micro unit tests (pure logic, no D1/network) — run anywhere with Node ESM.
// Executed in CI via `npm test` (part of the suite) and manually in sandboxes.
import assert from 'node:assert/strict';
import { normalizeAgentConfig, resolvePowerExecutionPlan } from '../functions/_lib/provider.js';
import { buildSystemPrompt } from '../functions/_lib/memory.js';
import {
  redactSecrets,
  redactCode,
  stripSecrets,
  estimateTokens,
  normalizeBaseUrl,
  clamp,
  truncate,
  b64urlEncode,
  b64urlDecodeText
} from '../functions/_lib/util.js';
import { validateAttachments, attachmentParts, base64ByteLength } from '../functions/_lib/attachments.js';
import { checkBrackets, checkJson, languageOfPath, validateFile, validateChanges, scanForSecrets } from '../functions/_lib/validate.js';
import { applyEdits, normalizeSource, findFuzzyMatches, countLines } from '../functions/_lib/patch.js';
import { registerActiveTurn, abortActiveTurn } from '../functions/_lib/turn-registry.js';

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    console.error('FAIL:', name, '\n  ', e.message);
  }
}

function throws(fn, code) {
  try {
    fn();
  } catch (e) {
    if (code && e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  throw new Error('expected throw');
}

/* ---------------------------- provider.js ---------------------------- */

t('provider: defaults', () => {
  const c = normalizeAgentConfig({});
  assert.equal(c.mode, 'auto-edit');
  assert.equal(c.temperature, 0.25);
  assert.equal(c.maxSteps, 20);
  assert.equal(c.marathon.active, false);
  assert.equal(c.marathon.goal, '');
  assert.equal(c.marathon.durationH, 0);
  assert.equal(c.marathon.startedAt, null);
});

t('provider: invalid mode falls back', () => {
  const c = normalizeAgentConfig({ mode: 'bogus' });
  assert.equal(c.mode, 'auto-edit');
});

t('provider: marathon normalization', () => {
  const c = normalizeAgentConfig({
    marathon: { active: true, goal: 'x'.repeat(900), durationH: '3', startedAt: 123456 }
  });
  assert.equal(c.marathon.active, true);
  assert.ok(c.marathon.goal.length <= 600, 'goal truncated');
  assert.equal(c.marathon.durationH, 3);
  assert.equal(c.marathon.startedAt, 123456);
});

t('provider: marathon clamps', () => {
  const c = normalizeAgentConfig({ marathon: { active: true, durationH: 99, startedAt: -5 } });
  assert.equal(c.marathon.durationH, 24);
  assert.equal(c.marathon.startedAt, null);
  const d = normalizeAgentConfig({ marathon: { durationH: -5 } });
  assert.equal(d.marathon.durationH, 0);
});

t('provider: temperature clamp', () => {
  const c = normalizeAgentConfig({ temperature: 99 });
  assert.ok(c.temperature <= 1);
  const d = normalizeAgentConfig({ temperature: 'abc' });
  assert.equal(d.temperature, 0.25);
});

t('provider: power plan ultra-code', () => {
  const plan = resolvePowerExecutionPlan({
    workStamina: 'ultra-code',
    detailThinking: 'ultra-code',
    ambitionLevel: 'hard',
    humanSensitivity: 'medium'
  });
  assert.ok(Number.isInteger(plan.maxSteps) && plan.maxSteps > 0);
  assert.ok(plan.contextBudget >= 16000);
});

t('provider: power plan medium clamp', () => {
  const plan = resolvePowerExecutionPlan({ workStamina: 'medium', maxSteps: 10 });
  assert.ok(plan.maxSteps >= 10 && plan.maxSteps <= 36);
});

/* ---------------------------- memory.js ---------------------------- */

const base = { workspace: { files: {} }, memories: [], repo: {}, user: {} };

t('memory: prompt without marathon', () => {
  const p = buildSystemPrompt({ ...base, agentConfig: { marathon: { active: false } } });
  assert.ok(!p.includes('MARATHON MODE IS ACTIVE'));
});

t('memory: prompt with marathon', () => {
  const p = buildSystemPrompt({
    ...base,
    agentConfig: { marathon: { active: true, goal: 'بهبود بازی دوز', durationH: 2, startedAt: Date.now() } }
  });
  assert.ok(p.includes('MARATHON MODE IS ACTIVE'));
  assert.ok(p.includes('بهبود بازی دوز'));
  assert.ok(p.includes('2 ساعت'));
});

t('memory: null agentConfig ok', () => {
  const p = buildSystemPrompt({ ...base, agentConfig: null });
  assert.ok(p.length > 200);
});

t('memory: custom instructions included', () => {
  const p = buildSystemPrompt({ ...base, agentConfig: { customInstructions: 'همیشه مستند بنویس' } });
  assert.ok(p.includes('همیشه مستند بنویس'));
});

t('memory: self-repo detection', () => {
  const p = buildSystemPrompt({
    workspace: { files: { 'functions/api/chat.js': 'x', 'wrangler.toml': 'y' } },
    memories: [],
    repo: {},
    user: {}
  });
  assert.ok(p.length > 200);
});

t('memory: memories listed', () => {
  const p = buildSystemPrompt({ ...base, memories: [{ scope: 'global', project: null, text: 'حافظه تست' }] });
  assert.ok(p.includes('حافظه تست'));
});

/* ---------------------------- util.js ---------------------------- */

t('util: redactSecrets github token', () => {
  const tok = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGH123456';
  const out = redactSecrets('token ' + tok);
  assert.ok(!out.includes(tok));
  assert.ok(out.includes('[REDACTED]'));
});

t('util: redactSecrets sk token', () => {
  const tok = 'sk-ant-api03-' + 'A'.repeat(40);
  const out = redactSecrets('key=' + tok);
  assert.ok(!out.includes(tok));
  assert.ok(out.includes('[REDACTED]'));
});

t('util: redactSecrets private key', () => {
  const out = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----');
  assert.ok(!out.includes('AAAA'));
});

t('util: redactSecrets assignment', () => {
  const out = redactSecrets('password = "superSecretValue123"');
  assert.ok(!out.includes('superSecretValue123'));
  assert.ok(out.includes('[REDACTED]'));
});

t('util: redactSecrets plain text untouched', () => {
  const out = redactSecrets('hello world, متن معمولی');
  assert.equal(out, 'hello world, متن معمولی');
});

t('util: extraSecrets', () => {
  const secret = 'my-own-secret-value-1234567890';
  const out = redactSecrets('x ' + secret + ' y', [secret]);
  assert.ok(!out.includes(secret));
});

t('util: redactCode hides token, keeps assignment value', () => {
  const out = redactCode('const k = "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";');
  assert.ok(!out.includes('sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
});

t('util: stripSecrets', () => {
  const r = stripSecrets({
    password: 'x',
    name: 'ali',
    nested: { token: 'y', keep: 1 },
    arr: [{ authorization: 'z', ok: true }]
  });
  assert.deepEqual(r, { name: 'ali', nested: { keep: 1 }, arr: [{ ok: true }] });
});

t('util: estimateTokens', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world how are you doing today') > 0);
  assert.ok(estimateTokens('سلام خوبی چطوری امروز چکار کردی') > 0);
  const big = 'a'.repeat(100000);
  assert.ok(estimateTokens(big) > 0);
});

t('util: normalizeBaseUrl', () => {
  assert.equal(normalizeBaseUrl('https://tooken.club/v1///'), 'https://tooken.club/v1');
  assert.equal(normalizeBaseUrl('http://x.com'), 'https://tooken.club/v1');
  assert.equal(normalizeBaseUrl('not a url'), 'https://tooken.club/v1');
});

t('util: clamp/truncate', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  const s = truncate('x'.repeat(100), 30);
  assert.ok(s.length <= 30);
});

t('util: b64url round trip', () => {
  const enc = b64urlEncode(new TextEncoder().encode('سلام دنیا'));
  assert.equal(b64urlDecodeText(enc), 'سلام دنیا');
});

/* ---------------------------- attachments.js ---------------------------- */

t('attachments: empty/undefined', () => {
  assert.deepEqual(validateAttachments(undefined), []);
});

t('attachments: >5 files rejected', () => {
  throws(() => validateAttachments([1, 2, 3, 4, 5, 6]), 'bad_attachments');
});

t('attachments: bad base64 rejected', () => {
  throws(() => validateAttachments([{ name: 'a.txt', type: 'text/plain', data: '!!!not-b64!!!' }]), 'bad_attachment');
});

t('attachments: total limit', () => {
  const big = 'A'.repeat(11 * 1024 * 1024); // ~8.25MB decoded each
  throws(
    () =>
      validateAttachments([
        { name: 'a.bin', type: 'application/octet-stream', data: big },
        { name: 'b.bin', type: 'application/octet-stream', data: big }
      ]),
    'too_large'
  );
});

t('attachments: valid entry normalized', () => {
  const data = btoa('hello attachments');
  const out = validateAttachments([{ name: 'a.txt', type: 'text/plain', data }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'a.txt');
  assert.equal(out[0].type, 'text/plain');
  assert.equal(out[0].data, data);
});

t('attachments: base64ByteLength', () => {
  assert.equal(base64ByteLength(''), 0);
  assert.equal(base64ByteLength('QQ=='), 1);
  assert.equal(base64ByteLength('QUJD'), 3);
  assert.equal(base64ByteLength('A'), -1);
  assert.equal(base64ByteLength(42), -1);
});

t('attachments: parts image', () => {
  const out = attachmentParts([{ name: 'p.png', type: 'image/png', data: 'iVBORw0KGgo=' }]);
  assert.equal(out[0].type, 'image_url');
  assert.ok(out[0].image_url.url.startsWith('data:image/png;base64,'));
});

t('attachments: parts text', () => {
  const out = attachmentParts([{ name: 'n.txt', type: 'text/plain', data: btoa('const x = 1;') }]);
  assert.equal(out[0].type, 'text');
  assert.ok(out[0].text.includes('const x = 1;'));
});

t('attachments: parts binary fallback', () => {
  const bin = new Uint8Array([0, 1, 2, 255, 254]);
  let bin64 = '';
  for (const b of bin) bin64 += String.fromCharCode(b);
  const out = attachmentParts([{ name: 'b.bin', type: 'application/octet-stream', data: btoa(bin64) }]);
  assert.equal(out[0].type, 'file');
  assert.equal(out[0].file.filename, 'b.bin');
});

t('attachments: upload id passthrough', () => {
  const out = attachmentParts([{ name: 'u.txt', id: 'up_123' }]);
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].uploadId, 'up_123');
});

/* ---------------------------- validate.js ---------------------------- */

t('validate: balanced brackets', () => {
  const r = checkBrackets('function f(){ return [1,2]; }');
  assert.equal(r.balanced, true);
});

t('validate: unbalanced brackets', () => {
  const r = checkBrackets('const x = {a:1');
  assert.equal(r.balanced, false);
  assert.ok(r.firstError);
});

t('validate: brackets inside string ignored', () => {
  const r = checkBrackets("const s = '{ unbalanced';");
  assert.equal(r.balanced, true);
});

t('validate: checkJson', () => {
  assert.equal(checkJson('{"a":1}').ok, true);
  assert.equal(checkJson('{a:1}').ok, false);
});

t('validate: languageOfPath', () => {
  assert.equal(languageOfPath('x.json'), 'json');
  assert.equal(languageOfPath('x.html'), 'html');
  assert.equal(languageOfPath('x.css'), 'css');
  assert.equal(languageOfPath('x.js'), 'js');
  assert.equal(languageOfPath('x.ts'), 'js');
  assert.equal(languageOfPath('x.md'), 'md');
  assert.equal(languageOfPath('x.xyz'), 'text');
});

t('validate: scanForSecrets', () => {
  assert.ok(scanForSecrets('const k = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGH123456";').length >= 1);
  assert.equal(scanForSecrets('const a = 1;').length, 0);
  assert.equal(scanForSecrets('').length, 0);
});

t('validate: validateFile js', () => {
  const r = validateFile('a.js', 'function f(){ return 1; }');
  assert.equal(r.ok, true);
  assert.equal(r.language, 'js');
});

t('validate: validateFile json error', () => {
  const r = validateFile('a.json', '{bad}');
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
});

t('validate: validateFile script tag', () => {
  const r = validateFile('a.js', '</script>');
  assert.equal(r.ok, false);
});

t('validate: validateChanges', () => {
  const r = validateChanges({ 'a.js': 'function f(){ return 1; }' }, ['a.js']);
  assert.equal(r.ok, true);
  const bad = validateChanges({ 'b.json': '{bad}' }, ['b.json']);
  assert.equal(bad.ok, false);
});

/* ---------------------------- patch.js ---------------------------- */

t('patch: normalizeSource', () => {
  assert.equal(normalizeSource('\uFEFFa\r\nb'), 'a\nb');
});

t('patch: exact edit', () => {
  const r = applyEdits('a\nb\nc', [{ search: 'b', replace: 'B' }]);
  assert.equal(r.content, 'a\nB\nc');
  assert.equal(r.results[0].strategy, 'exact');
});

t('patch: append', () => {
  const r = applyEdits('a', [{ search: '', replace: '\nb' }]);
  assert.equal(r.content, 'a\nb');
});

t('patch: duplicate without replaceAll → error', () => {
  throws(() => applyEdits('x x', [{ search: 'x', replace: 'y' }]), 'patch_failed');
});

t('patch: duplicate with replaceAll', () => {
  const r = applyEdits('x x', [{ search: 'x', replace: 'y', replaceAll: true }]);
  assert.equal(r.content, 'y y');
  assert.equal(r.results[0].strategy, 'exact-all');
});

t('patch: missing search → error', () => {
  throws(() => applyEdits('a', [{ search: 'zzz', replace: 'y' }]), 'patch_failed');
});

t('patch: fuzzy indent match', () => {
  const r = applyEdits('  const a = 1;\nconst b = 2;', [{ search: 'const b = 2;', replace: 'const b = 3;' }]);
  assert.equal(r.content, '  const a = 1;\nconst b = 3;');
});

t('patch: findFuzzyMatches', () => {
  const hits = findFuzzyMatches(['  const a', 'const b'], ['const a']);
  assert.deepEqual(hits, [0]);
});

t('patch: countLines', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\nb'), 2);
});

/* ---------------------------- turn-registry.js ---------------------------- */

t('turn-registry: register/abort', () => {
  const r = registerActiveTurn('o', 'c1');
  assert.equal(abortActiveTurn('o', 'c1'), true);
  assert.equal(r.signal.aborted, true);
  assert.equal(abortActiveTurn('o', 'c1'), false);
  registerActiveTurn('o', 'c1'); // recreate so release() has a live entry
  r.release();
  assert.equal(abortActiveTurn('o', 'c1'), false);
});

t('turn-registry: supersede', () => {
  const r1 = registerActiveTurn('o', 'c2');
  const r2 = registerActiveTurn('o', 'c2');
  assert.equal(r1.signal.aborted, true, 'previous aborted');
  assert.equal(r2.signal.aborted, false);
  assert.equal(abortActiveTurn('o', 'c2'), true);
});

console.log(`\nmicro tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
