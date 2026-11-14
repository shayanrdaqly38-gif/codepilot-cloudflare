// Regression coverage for false "انجام شد" completions, cutoff fabrication,
// and server notices being attributed to the model in later turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rsaKeys, accessToken, fakeJwks, makeEnv, req, ctx } from './harness.mjs';
import * as auth from '../functions/api/auth.js';
import * as chat from '../functions/api/chat.js';
import * as stateApi from '../functions/api/state/index.js';
import { listMessages } from '../functions/_lib/store.js';
import {
  isBareCompletionClaim,
  isSmallTalk,
  turnHasConcreteEvidence,
  buildConcreteCompletionSummary
} from '../functions/_lib/agent-control.js';

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
function scriptedModel(script) {
  const original = globalThis.fetch;
  const calls = [];
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
    calls.push(JSON.parse(init.body));
    const next = script[Math.min(step, script.length - 1)];
    step += 1;
    const message = typeof next === 'function' ? next() : next.message;
    const finish = typeof next === 'object' && next.finish_reason ? next.finish_reason : 'stop';
    return new Response(JSON.stringify({ model: 'scripted', choices: [{ message, finish_reason: finish }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
async function setup() {
  const env = makeEnv(keys, { MODEL_BASE_URL: 'https://model.example/v1' });
  const authRes = await auth.onRequestGet(ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env));
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
  const created = await (await stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env))).json();
  await stateApi.onRequestPost(ctx(req('/api/state', {
    method: 'POST',
    body: { action: 'workspace', id: created.id, workspace: { files: { 'app.js': 'const x = 1;\n' }, active: 'app.js' } },
    headers: { Cookie: cookie }
  }), env));
  return { env, cookie, id: created.id };
}
async function send(env, cookie, id, message = 'کار را انجام بده') {
  const res = await chat.onRequestPost(ctx(req('/api/chat', {
    method: 'POST', headers: { Cookie: cookie },
    body: { conversationId: id, message, model: 'test-model', localRunner: false, maxSteps: 8 }
  }), env));
  assert.equal(res.status, 200);
  return sse(await res.text());
}

test('completion helpers distinguish bare claims from substantive answers', () => {
  assert.equal(isBareCompletionClaim('انجام شد.'), true);
  assert.equal(isBareCompletionClaim('Done!'), true);
  assert.equal(isBareCompletionClaim('فایل app.js را درست کردم و تست شد.'), false);
  assert.equal(isSmallTalk('سلام'), true);
  assert.equal(isSmallTalk('ادامه'), false);
  assert.equal(turnHasConcreteEvidence({ commands: [{ ok: true, mode: 'virtual' }] }), false);
  assert.equal(turnHasConcreteEvidence({ editCount: 1 }), true);
  assert.match(buildConcreteCompletionSummary({ touched: new Set(['app.js']), editCount: 1 }), /app\.js/);
});

test('a literal search that looks like a regex gets a retry hint instead of a silent false negative', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    { message: { role: 'assistant', content: '', tool_calls: [call('s1', 'search_code', { query: '#board|#next-round' })] } },
    { message: { role: 'assistant', content: 'الگو به‌صورت متنی جست‌وجو شده بود؛ باید با regex:true دوباره بررسی شود.' } }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const tool = events.find((e) => e.name === 'tool_result');
  assert.match(tool.data.result, /No matches/);
  assert.match(tool.data.result, /regex:true/);
});

test('a bare done after a no-match search is nudged until a real answer appears', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    { message: { role: 'assistant', content: '', tool_calls: [call('s1', 'search_code', { query: 'NOT_FOUND_SENTINEL' })] } },
    { message: { role: 'assistant', content: 'انجام شد.' } },
    { message: { role: 'assistant', content: 'جست‌وجو هیچ موردی پیدا نکرد؛ فایل app.js بررسی شد و تغییری لازم نبود.' } }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const done = events.at(-1).data;
  assert.equal(model.calls.length, 3);
  assert.ok(events.some((e) => e.name === 'status' && e.data.phase === 'completion_check'));
  assert.equal(done.interruptedReason, null);
  assert.match(done.content, /هیچ موردی پیدا نکرد/);
  const stored = await listMessages(env, id);
  assert.ok(!stored.some((m) => m.role === 'assistant' && m.content.trim() === 'انجام شد.'), 'the bare claim must not be persisted as model speech');
});

test('an empty length cutoff never fabricates انجام شد and saves no fake partial text', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    { message: { role: 'assistant', content: '', tool_calls: [call('s1', 'search_code', { query: 'NOT_FOUND_SENTINEL' })] } },
    { message: { role: 'assistant', content: '' }, finish_reason: 'length' }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const done = events.at(-1).data;
  assert.equal(done.content, '');
  assert.equal(done.interruptedReason, 'length_cutoff');
  assert.equal(done.checkpoint.partialTextChars, 0);
  assert.equal(done.checkpoint.partialTextTail, '');
  const stored = await listMessages(env, id);
  assert.ok(!stored.some((m) => m.role === 'assistant' && /انجام شد/.test(m.content || '')));
});

test('a stubborn bare done is rejected as unverified instead of shown as success', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([{ message: { role: 'assistant', content: 'انجام شد.' } }]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const done = events.at(-1).data;
  assert.equal(model.calls.length, 3, 'two bounded nudges, then an honest system assessment');
  assert.equal(done.interruptedReason, 'unverified_completion');
  assert.match(done.content, /\[ارزیابی سیستم\]/);
  assert.equal(done.checkpoint.partialTextChars, 0);
  const stored = await listMessages(env, id);
  assert.ok(!stored.some((m) => m.role === 'assistant' && m.content.trim() === 'انجام شد.'));
});

test('a bare done backed by a real edit is replaced with a concrete saved-work summary', async () => {
  const { env, cookie, id } = await setup();
  const model = scriptedModel([
    { message: { role: 'assistant', content: '', tool_calls: [call('w1', 'write_file', { path: 'app.js', content: 'const x = 2;\n' })] } },
    { message: { role: 'assistant', content: 'انجام شد.' } }
  ]);
  let events;
  try { events = await send(env, cookie, id); } finally { model.restore(); }
  const done = events.at(-1).data;
  assert.equal(model.calls.length, 2);
  assert.equal(done.interruptedReason, null);
  assert.match(done.content, /app\.js/);
  assert.match(done.content, /تغییرات ذخیره‌شده/);
  assert.deepEqual(done.touchedFiles, ['app.js']);
});
