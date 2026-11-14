// Behavioral regressions for the per-turn execution governor, structured reads,
// and no-progress livelock guard. These run the real /api/chat handler against
// the D1 shim and a scripted upstream model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rsaKeys, accessToken, fakeJwks, makeEnv, req, ctx } from './harness.mjs';
import * as auth from '../functions/api/auth.js';
import * as chat from '../functions/api/chat.js';
import * as stateApi from '../functions/api/state/index.js';
import { createAgentControl, buildControlStopMessage } from '../functions/_lib/agent-control.js';
import { buildSmartFileRead } from '../functions/_lib/token-optimizer.js';
import { compactToolResult, buildSystemPrompt } from '../functions/_lib/memory.js';

const keys = rsaKeys();
const jwksFetch = globalThis.fetch;
fakeJwks(keys);

function sse(text) {
  return text.split('\n\n').filter((x) => x.startsWith('event:')).map((block) => ({
    name: block.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}')
  }));
}
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function toolStep(...calls) {
  return { role: 'assistant', content: '', tool_calls: calls };
}
function scriptedModel(script) {
  const original = globalThis.fetch;
  const calls = [];
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
    const payload = JSON.parse(init.body);
    calls.push(payload);
    const next = script[Math.min(step, script.length - 1)];
    step += 1;
    return new Response(JSON.stringify({ model: 'scripted', choices: [{ message: typeof next === 'function' ? next(payload) : next }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
async function setup(files = {}) {
  const env = makeEnv(keys, { MODEL_BASE_URL: 'https://model.example/v1' });
  const authRes = await auth.onRequestGet(ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env));
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
  const created = await (await stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env))).json();
  const lines = Array.from({ length: 220 }, (_, i) => `L${String(i + 1).padStart(3, '0')} payload line ${i + 1}`);
  await stateApi.onRequestPost(ctx(req('/api/state', {
    method: 'POST',
    body: { action: 'workspace', id: created.id, workspace: { files: { 'a.txt': lines.join('\n'), 'b.txt': 'beta file\n', 'app.js': 'const x = 1;\n', ...files }, active: 'a.txt' } },
    headers: { Cookie: cookie }
  }), env));
  return { env, cookie, id: created.id };
}
async function send(env, cookie, id, body = {}) {
  const res = await chat.onRequestPost(ctx(req('/api/chat', {
    method: 'POST', headers: { Cookie: cookie },
    body: { conversationId: id, message: 'کار را انجام بده', model: 'test-model', localRunner: false, maxSteps: 8, ...body }
  }), env));
  assert.equal(res.status, 200);
  return sse(await res.text());
}

test('governor suppresses duplicate reads, adjusts overlapping ranges, and invalidates after mutation', () => {
  const ctl = createAgentControl({ powerProfile: { workStamina: 'medium' }, maxSteps: 8 });
  const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const ws = { files: { 'a.txt': content } };
  ctl.beginStep(1);
  assert.equal(ctl.beforeTool('read_file', { path: 'a.txt', startLine: 1, endLine: 80 }, { workspace: ws }).suppress, false);
  ctl.afterTool('read_file', { path: 'a.txt', startLine: 1, endLine: 80 }, { ok: true, meta: { ranges: [[1, 80]], totalLines: 200 } }, 1);
  ctl.endStep(1);

  ctl.beginStep(2);
  const dup = ctl.beforeTool('read_file', { path: 'a.txt', startLine: 1, endLine: 80 }, { workspace: ws });
  assert.equal(dup.suppress, true);
  assert.equal(dup.reason, 'duplicate_read');
  const overlap = ctl.beforeTool('read_file', { path: 'a.txt', startLine: 50, endLine: 120 }, { workspace: ws });
  assert.equal(overlap.suppress, false);
  assert.equal(overlap.adjusted, true);
  assert.deepEqual([overlap.args.startLine, overlap.args.endLine], [81, 120]);
  ctl.afterTool('read_file', overlap.args, { ok: true, meta: { ranges: [[81, 120]], totalLines: 200 } }, 2);
  assert.equal(ctl.endStep(2).progress, true);

  ctl.beginStep(3);
  ctl.afterTool('write_file', { path: 'a.txt', content: 'new' }, { ok: true }, 3);
  ctl.endStep(3);
  ctl.beginStep(4);
  const afterEdit = ctl.beforeTool('read_file', { path: 'a.txt', startLine: 1, endLine: 80 }, { workspace: { files: { 'a.txt': 'new' } } });
  assert.equal(afterEdit.suppress, false, 'a genuine post-edit read must not be cached away');
  assert.ok(ctl.snapshot().duplicatesSuppressed >= 1);
  assert.ok(buildControlStopMessage({ duplicatesSuppressed: 2 }, { touchedFiles: ['a.txt'] }).includes('a.txt'));
});

test('governor stops zero-progress think/meta loops and repeated failed mutations', () => {
  const ctl = createAgentControl({ powerProfile: { workStamina: 'medium' }, maxSteps: 8 });
  ctl.beginStep(1);
  ctl.afterTool('think', { thought: 'plan' }, { ok: true }, 1);
  assert.equal(ctl.endStep(1).stopReason, null);
  ctl.beginStep(2);
  const dupThink = ctl.beforeTool('think', { thought: 'plan' }, {});
  assert.equal(dupThink.suppress, true);
  ctl.afterTool('think', { thought: 'plan' }, { ok: true, controlled: true }, 2);
  assert.equal(ctl.endStep(2).stopReason, 'no_progress');

  const edits = createAgentControl({ powerProfile: { workStamina: 'medium' }, maxSteps: 8 });
  const args = { path: 'app.js', edits: [{ search: 'const x = 1;', replace: 'const x = 1;' }] };
  edits.beginStep(1);
  edits.afterTool('apply_patch', args, { ok: false, text: 'identical' }, 1);
  edits.endStep(1);
  edits.beginStep(2);
  assert.equal(edits.beforeTool('apply_patch', args, {}).reason, 'repeat_failed_mutation');
  edits.afterTool('apply_patch', args, { ok: true, controlled: true }, 2);
  assert.equal(edits.endStep(2).stopReason, 'no_progress');
});

test('smart reads stay inside the wire budget and report exact omitted/next ranges', () => {
  const longLineFile = Array.from({ length: 500 }, (_, i) => `L${i + 1} ${'x'.repeat(90)}`).join('\n');
  const ranged = buildSmartFileRead('big.txt', longLineFile, { startLine: 1, endLine: 360, tokenSaver: 'max' });
  assert.ok(ranged.text.length <= 15_500);
  assert.equal(ranged.meta.truncated, true);
  assert.ok(ranged.meta.ranges[0][0] === 1);
  assert.ok(ranged.meta.ranges[0][1] < 360);
  assert.ok(ranged.meta.nextRange.startLine > ranged.meta.ranges[0][1]);
  const packed = compactToolResult({ text: ranged.text, meta: ranged.meta });
  assert.ok(packed.length <= 16_000);
  assert.match(packed, /\[tool-meta\]/);
  assert.match(packed, /nextRange/);
  assert.match(packed, /truncated/i);

  const medium = Array.from({ length: 175 }, (_, i) => `const computedValue_${i} = Number(req?.value || 0) + ${i}; // processing step ${i}`).join('\n');
  assert.ok(medium.length > 12_000 && medium.length < 15_000);
  assert.equal(compactToolResult(medium), medium, 'the old 12k dead zone must not silently cut a full smart read');
  const genericCut = compactToolResult('x'.repeat(20_000));
  assert.ok(genericCut.length <= 16_000);
  assert.match(genericCut, /Output truncated/);
});

test('real chat turn never re-executes an unchanged duplicate read and stops the spin', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    toolStep(call('r1', 'read_file', { path: 'a.txt' })),
    toolStep(call('r2', 'read_file', { path: 'a.txt' })),
    toolStep(call('r3', 'read_file', { path: 'a.txt' })),
    toolStep(call('r4', 'read_file', { path: 'a.txt' })),
    { role: 'assistant', content: 'تمام' }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const done = events.at(-1).data;
  const results = events.filter((e) => e.name === 'tool_result');
  assert.equal(model.calls.length, 3, 'the guard must stop before burning the whole step budget');
  assert.equal(done.interruptedReason, 'no_progress');
  assert.equal(done.resumable, false);
  assert.equal(done.agentControl.executedCalls, 1);
  assert.ok(done.agentControl.duplicatesSuppressed >= 2);
  assert.match(results[0].data.result, /L001/);
  assert.match(results[1].data.result, /Duplicate read_file suppressed/);
  assert.match(done.content, /پیشرفت تازه/);
  assert.ok(JSON.stringify(model.calls[2]).includes('L001'), 'pruning must keep the original evidence, not dedupe it against a guard notice');
});

test('overlapping read_file returns only the uncovered range on the wire', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    toolStep(call('r1', 'read_file', { path: 'a.txt', startLine: 1, endLine: 80 })),
    toolStep(call('r2', 'read_file', { path: 'a.txt', startLine: 50, endLine: 120 })),
    { role: 'assistant', content: 'خواندم' }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const results = events.filter((e) => e.name === 'tool_result');
  assert.match(results[1].data.result, /Lines 81-120/);
  assert.doesNotMatch(results[1].data.result, /L050 /);
  assert.match(results[1].data.result, /L081/);
  assert.equal(events.at(-1).data.agentControl.adjustedReads, 1);
});

test('a mixed read/write/read step keeps order and re-reads after a real mutation', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    { role: 'assistant', content: '', tool_calls: [
      call('m1', 'read_file', { path: 'app.js' }),
      call('m2', 'write_file', { path: 'app.js', content: 'const x = 2;\n' }),
      call('m3', 'read_file', { path: 'app.js' })
    ] },
    { role: 'assistant', content: 'انجام شد' }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const results = events.filter((e) => e.name === 'tool_result');
  assert.deepEqual(results.map((r) => r.data.id), ['m1', 'm2', 'm3']);
  assert.match(results[0].data.result, /const x = 1;/);
  assert.match(results[2].data.result, /const x = 2;/);
  assert.doesNotMatch(results[2].data.result, /Duplicate/);
  assert.deepEqual(events.at(-1).data.touchedFiles, ['app.js']);
});

test('independent reads in one model step are batched without losing order or duplicate protection', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    toolStep(call('b1', 'read_file', { path: 'a.txt', startLine: 1, endLine: 20 }), call('b2', 'read_file', { path: 'b.txt' }), call('b3', 'read_file', { path: 'a.txt', startLine: 1, endLine: 20 })),
    { role: 'assistant', content: 'خواندم' }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const results = events.filter((e) => e.name === 'tool_result');
  assert.deepEqual(results.map((r) => r.data.id), ['b1', 'b2', 'b3']);
  assert.match(results[1].data.result, /beta file/);
  assert.match(results[2].data.result, /Duplicate read_file suppressed/);
  const done = events.at(-1).data;
  assert.equal(model.calls.length, 2);
  assert.equal(done.agentControl.executedCalls, 2);
  assert.equal(done.agentControl.duplicatesSuppressed, 1);
  assert.equal(done.interruptedReason, null);
});

test('power directives stay ambitious but evidence-bound instead of demanding endless meta-work', () => {
  const prompt = buildSystemPrompt({
    workspace: { files: { 'app.js': 'x' } },
    agentConfig: { workStamina: 'ultra-code', detailThinking: 'ultra-code', ambitionLevel: 'ultra-code', humanSensitivity: 'ultra-code', goal: 'فقط دکمه ذخیره را درست کن' }
  });
  assert.match(prompt, /فقط دکمه ذخیره/);
  assert.doesNotMatch(prompt, /Never stop partway|Think deeply and thoroughly about EVERY tiny detail/i);
  assert.match(prompt, /concrete|evidence|verified/i);
});
