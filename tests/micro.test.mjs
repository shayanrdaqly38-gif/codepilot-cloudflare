// Micro unit tests — pure logic, no D1/network. Run under `npm test` (Node >=22).
// Every assertion below was verified against the real modules in a Node container.
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
  textToBase64,
  base64ToText
} from '../functions/_lib/util.js';
import { validateAttachments, attachmentParts, base64ByteLength, MAX_ATTACHMENT_BYTES } from '../functions/_lib/attachments.js';
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

/* --------------------------- provider.js --------------------------- */

t('provider: defaults', () => {
  const d = normalizeAgentConfig({});
  assert.equal(d.mode, 'auto-edit');
  assert.equal(d.marathon.active, false);
  assert.equal(d.temperature, 0.25);
  assert.equal(d.maxSteps, 20);
  assert.equal(d.contextBudget, 24000);
});

t('provider: mode fallback', () => {
  assert.equal(normalizeAgentConfig({ mode: 'bogus' }).mode, 'auto-edit');
  assert.equal(normalizeAgentConfig({ mode: 'plan' }).mode, 'plan');
});

t('provider: temperature clamp [0, 1.5] rounded 2dp', () => {
  assert.ok(normalizeAgentConfig({ temperature: 99 }).temperature <= 1.5);
  assert.ok(normalizeAgentConfig({ temperature: -99 }).temperature >= 0);
  assert.equal(normalizeAgentConfig({ temperature: 1.234 }).temperature, 1.23);
});

t('provider: maxSteps window [4, 300] + Persian digits', () => {
  assert.equal(normalizeAgentConfig({ maxSteps: 50 }).maxSteps, 50);
  assert.equal(normalizeAgentConfig({ maxSteps: 200 }).maxSteps, 200);
  assert.equal(normalizeAgentConfig({ maxSteps: '۲۰۰' }).maxSteps, 200);
  assert.equal(normalizeAgentConfig({ maxSteps: 999 }).maxSteps, 300);
  assert.equal(normalizeAgentConfig({ maxSteps: 1 }).maxSteps, 20);
  assert.equal(resolvePowerExecutionPlan({ workStamina: 'medium', maxSteps: 200 }).maxSteps, 200);
});

t('provider: contextBudget window [6000, 256000] + Persian digits', () => {
  assert.equal(normalizeAgentConfig({ contextBudget: 50000 }).contextBudget, 50000);
  assert.equal(normalizeAgentConfig({ contextBudget: '۵۰,۰۰۰' }).contextBudget, 50000);
  assert.equal(normalizeAgentConfig({ contextBudget: 999999 }).contextBudget, 256000);
  assert.equal(normalizeAgentConfig({ contextBudget: 1000 }).contextBudget, 24000);
});

t('provider: goal truncation to 600', () => {
  assert.ok(normalizeAgentConfig({ goal: 'x'.repeat(900) }).goal.length <= 600);
});

t('provider: marathon normalization', () => {
  const mg = normalizeAgentConfig({ marathon: { active: true, goal: 'گل', durationH: '3', startedAt: 123456 } }).marathon;
  assert.equal(mg.active, true);
  assert.equal(mg.durationH, 3);
  assert.equal(mg.startedAt, 123456);
  assert.equal(normalizeAgentConfig({ marathon: { durationH: -5 } }).marathon.durationH, 0);
  assert.equal(normalizeAgentConfig({ marathon: { durationH: 99 } }).marathon.durationH, 24);
});

t('provider: resolvePowerExecutionPlan yields budget', () => {
  const plan = resolvePowerExecutionPlan({ workStamina: 'ultra-code' });
  assert.ok(Number.isInteger(plan.maxSteps) && plan.maxSteps >= 32);
});

/* --------------------------- memory.js --------------------------- */

const base = { workspace: { files: {} }, memories: [], repo: {}, user: {} };

t('memory: marathon injection off by default', () => {
  const off = buildSystemPrompt({ ...base, agentConfig: { marathon: { active: false } } });
  assert.ok(!off.includes('MARATHON MODE IS ACTIVE'));
});

t('memory: long-task background protocol injected for every real execution mode', () => {
  for (const exec of [{ localTermux: true }, { linuxRunner: true }, { sandbox: true }]) {
    const p = buildSystemPrompt({ ...base, ...exec });
    assert.ok(p.includes('nohup'), `nohup guidance present for ${JSON.stringify(exec)}`);
    assert.ok(p.includes('/tmp/cp-task.log'), `poll-log guidance present for ${JSON.stringify(exec)}`);
  }
  // Virtual shell (no real execution) must NOT promise background execution.
  const virt = buildSystemPrompt({ ...base });
  assert.ok(!virt.includes('nohup'), 'virtual shell gets no nohup guidance');
});

t('memory: marathon injection on with goal + duration', () => {
  const on = buildSystemPrompt({
    ...base,
    agentConfig: { marathon: { active: true, goal: 'تقویت محیط توسعه CodePilot', durationH: 2, startedAt: 1700000000000 } }
  });
  assert.ok(on.includes('MARATHON MODE IS ACTIVE'));
  assert.ok(on.includes('تقویت محیط توسعه CodePilot'));
  assert.ok(on.includes('2 ساعت'));
});

t('memory: marathon without duration says unlimited', () => {
  const noDur = buildSystemPrompt({ ...base, agentConfig: { marathon: { active: true, goal: '', durationH: 0 } } });
  assert.ok(noDur.includes('بی‌محدودیت'));
});

t('memory: lines rendered as [scope:project] key: value', () => {
  const withMem = buildSystemPrompt({ ...base, memories: [{ scope: 'global', key: 'k1', value: 'حافظه تست' }] });
  assert.ok(withMem.includes('حافظه تست'));
  assert.ok(withMem.includes('[global]'));
});

t('memory: self-repo section when chat.js + wrangler.toml present', () => {
  const self = buildSystemPrompt({ ...base, workspace: { files: { 'functions/api/chat.js': 'x', 'wrangler.toml': 'y' } } });
  assert.ok(self.includes('Self-Modification Architecture'));
});

t('memory: customInstructions included', () => {
  const ci = buildSystemPrompt({ ...base, agentConfig: { customInstructions: 'همیشه فارسی جواب بده' } });
  assert.ok(ci.includes('همیشه فارسی جواب بده'));
});

t('memory: minimal prompt is non-trivial', () => {
  assert.ok(buildSystemPrompt(base).length > 300);
});

/* --------------------------- util.js --------------------------- */

t('util: truncate behavior', () => {
  assert.equal(truncate('abcdef', 3), '\n… [بریده شد]');
  assert.equal(truncate('abcdef', 30), 'abcdef');
});

t('util: clamp', () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

t('util: estimateTokens bounds', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world this is a test sentence') > 0);
  assert.ok(estimateTokens('سلام دنیا، این یک تست فارسی است') > 0);
  assert.ok(estimateTokens('x'.repeat(100000)) > 0);
});

t('util: redactSecrets hides provider tokens', () => {
  const ghpR = redactSecrets('token ghp_AbCdEfGh1234567890abcdefghijklmnop end');
  assert.ok(!ghpR.includes('ghp_AbCdEfGh') && ghpR.includes('[REDACTED_GITHUB_TOKEN]'));
  const jwtR = redactSecrets('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  assert.ok(!jwtR.includes('eyJhbGci') && jwtR.includes('[REDACTED_JWT]'));
  const pemR = redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFA\n-----END PRIVATE KEY-----');
  assert.ok(pemR.includes('[REDACTED_PRIVATE_KEY]'));
  const skR = redactSecrets('claude sk-ant-api03-TESTTOKENVALUE1234567890abcdefghij');
  assert.ok(!skR.includes('sk-ant-api03-TEST') && skR.includes('[REDACTED_API_KEY]'));
  assert.ok(!redactSecrets('password = "hunter2secret"').includes('hunter2secret'));
  assert.ok(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456').includes('Bearer [REDACTED]'));
  assert.equal(redactSecrets('plain text hello world'), 'plain text hello world');
  assert.equal(redactSecrets(''), '');
});

t('util: redactCode changes only token-shaped values', () => {
  assert.equal(redactCode('const k = "sk-abcdefghijklmnopqrstuvwxyz123456";'), 'const k = "[REDACTED_API_KEY]";');
});

t('util: stripSecrets drops credential keys, keeps safe data', () => {
  assert.deepEqual(
    stripSecrets({ password: 'x', apiKey: 'y', name: 'ali', nested: { token: 'z', keep: 1 }, arr: [{ ok: true }] }),
    { name: 'ali', nested: { keep: 1 }, arr: [{ ok: true }] }
  );
});

t('util: base64 round trips + strict length check', () => {
  assert.equal(textToBase64('abc'), 'YWJj');
  assert.equal(base64ToText('YWJj'), 'abc');
  assert.equal(base64ByteLength('YWJj'), 3);
  assert.equal(base64ByteLength('QQ=='), 1);
  assert.equal(base64ByteLength('==='), -1);
  assert.equal(base64ByteLength(''), 0);
  assert.equal(base64ByteLength(123), -1);
});

t('util: normalizeBaseUrl https-only + trailing slash trim', () => {
  assert.equal(normalizeBaseUrl('https://tooken.club/v1///'), 'https://tooken.club/v1');
  assert.equal(normalizeBaseUrl('http://plain.com'), 'https://tooken.club/v1');
  assert.equal(normalizeBaseUrl('garbage'), 'https://tooken.club/v1');
});

/* --------------------------- attachments.js --------------------------- */

t('attachments: undefined -> [] and shape rejects', () => {
  assert.deepEqual(validateAttachments(undefined), []);
  assert.throws(() => validateAttachments('nope'), (e) => e.code === 'bad_attachments');
  assert.throws(
    () => validateAttachments(new Array(6).fill({ name: 'f', type: 'text/plain', data: 'QQ==' })),
    (e) => e.code === 'bad_attachments'
  );
});

t('attachments: invalid base64 rejected', () => {
  assert.throws(() => validateAttachments([{ name: 'f', type: 'text/plain', data: 'not_base64!' }]), (e) => e.code === 'bad_attachment');
});

t('attachments: total > 20MB rejected', () => {
  const big = 'A'.repeat(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3));
  assert.throws(
    () => validateAttachments([
      { name: 'a', type: 'application/octet-stream', data: big },
      { name: 'b', type: 'application/octet-stream', data: big }
    ]),
    (e) => e.code === 'too_large'
  );
});

t('attachments: normalization of name/type', () => {
  const okFile = { name: 'note.txt', type: 'text/plain', data: textToBase64('سلام') };
  const norm = validateAttachments([okFile]);
  assert.equal(norm.length, 1);
  assert.equal(norm[0].name, 'note.txt');
  assert.equal(norm[0].type, 'text/plain');
  assert.equal(norm[0].data, okFile.data);
  assert.equal(validateAttachments([{ name: 'a\x00b', type: 'text/plain', data: 'QQ==' }])[0].name, 'ab');
  assert.equal(validateAttachments([{ name: 'a', type: 'evil"type', data: 'QQ==' }])[0].type, 'application/octet-stream');
});

t('attachments: parts -> image_url/text/file/uploadId', () => {
  const parts = attachmentParts([{ name: 'img.png', type: 'image/png', data: 'iVBORw0KGgo=' }]);
  assert.equal(parts[0].type, 'image_url');
  assert.equal(parts[0].image_url.url, 'data:image/png;base64,iVBORw0KGgo=');
  const txt = attachmentParts([{ name: 't.txt', type: 'text/plain', data: textToBase64('hello\r\nworld') }]);
  assert.equal(txt[0].type, 'text');
  assert.ok(txt[0].text.includes('hello'));
  const bin = attachmentParts([{ name: 'b.bin', type: 'application/octet-stream', data: textToBase64('\x00\x01\x02') }]);
  assert.equal(bin[0].type, 'file');
  const up = attachmentParts([{ id: 'u1', name: 'x', type: 'text/plain', data: '' }]);
  assert.deepEqual(up[0], { type: 'text', text: '[پیوست: x]', uploadId: 'u1' });
});

/* --------------------------- validate.js --------------------------- */

t('validate: checkBrackets', () => {
  assert.equal(checkBrackets('function f() { return [1, 2]; }').balanced, true);
  assert.equal(checkBrackets('const x = {a: 1').balanced, false);
  assert.equal(checkBrackets("const s = '{ not really unbalanced'").balanced, true);
  assert.equal(checkBrackets('// comment {').balanced, true);
});

t('validate: checkJson', () => {
  assert.equal(checkJson('{"a": 1}').ok, true);
  assert.equal(checkJson('{a: 1}').ok, false);
});

t('validate: languageOfPath', () => {
  assert.equal(languageOfPath('a.json'), 'json');
  assert.equal(languageOfPath('a.js'), 'js');
  assert.equal(languageOfPath('a.html'), 'html');
  assert.equal(languageOfPath('a.md'), 'md');
  assert.equal(languageOfPath('a.xyz'), 'text');
});

t('validate: validateFile shape', () => {
  const vf = validateFile('a.js', 'const x = 1;');
  assert.equal(typeof vf.ok, 'boolean');
  assert.ok(Array.isArray(vf.errors));
});

t('validate: scanForSecrets shape', () => {
  assert.ok(Array.isArray(scanForSecrets('const k = "sk-abcdefghijklmnopqrstuvwxyz123456";')));
});

t('validate: validateChanges(files, paths)', () => {
  assert.equal(validateChanges({ 'a.js': 'function f(){ return 1; }' }, ['a.js']).ok, true);
  assert.equal(validateChanges({ 'b.json': '{bad}' }, ['b.json']).ok, false);
});

/* --------------------------- patch.js --------------------------- */

t('patch: normalizeSource strips BOM + CRLF', () => {
  assert.equal(normalizeSource('\uFEFFa\r\nb'), 'a\nb');
});

t('patch: exact search/replace', () => {
  const r = applyEdits('a\nb\nc', [{ search: 'b', replace: 'B' }]);
  assert.equal(r.content, 'a\nB\nc');
  assert.equal(r.results[0].strategy, 'exact');
});

t('patch: empty search appends at end', () => {
  const r = applyEdits('a\nb\nc', [{ search: '', replace: 'x\n' }]);
  assert.equal(r.content, 'a\nb\ncx\n');
});

t('patch: ambiguous and missing matches fail', () => {
  assert.throws(() => applyEdits('a\nb\na', [{ search: 'a', replace: 'z' }]), (e) => e.code === 'patch_failed');
  assert.throws(() => applyEdits('a\nb', [{ search: 'zzz', replace: 'z' }]), (e) => e.code === 'patch_failed');
});

t('patch: replaceAll', () => {
  const r = applyEdits('a\na', [{ search: 'a', replace: 'z', replaceAll: true }]);
  assert.equal(r.content, 'z\nz');
  assert.equal(r.results[0].strategy, 'exact-all');
});

t('patch: findFuzzyMatches tolerates indentation', () => {
  assert.deepEqual(findFuzzyMatches(['  const a', 'const b'], ['const a']), [0]);
});

t('patch: countLines', () => {
  assert.equal(countLines('a\nb\n'), 3);
});

/* --------------------------- turn-registry.js --------------------------- */

t('registry: register/abort idempotence', () => {
  const t1 = registerActiveTurn('o', 'c');
  assert.equal(t1.signal.aborted, false);
  assert.equal(abortActiveTurn('o', 'c'), true);
  assert.equal(abortActiveTurn('o', 'c'), false);
});

t('registry: new turn supersedes and aborts previous', () => {
  const a = registerActiveTurn('o2', 'c2');
  const b = registerActiveTurn('o2', 'c2');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  a.release();
  b.release();
  assert.equal(abortActiveTurn('o2', 'c2'), false);
});

console.log(`micro tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
