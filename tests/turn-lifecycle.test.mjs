// Regression coverage for the stop -> duplicate POST -> overlapping recovery
// chain. Uses the real D1 shim and HTTP handlers, not replacement business logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rsaKeys, accessToken, fakeJwks, makeEnv, req, ctx } from './harness.mjs';
import * as auth from '../functions/api/auth.js';
import * as chat from '../functions/api/chat.js';
import * as stopApi from '../functions/api/chat/stop.js';
import * as stateApi from '../functions/api/state/index.js';
import * as detailApi from '../functions/api/state/conversations/[id].js';
import { ensureSchema, SCHEMA_VERSION } from '../functions/_lib/schema.js';
import {
  acquireTurn, releaseTurn, heartbeatTurn, getTurnStatus, requestTurnStop,
  isTurnActive, TURN_LEASE_MS, clearTurnCheckpointForTurn
} from '../functions/_lib/active-turn.js';
import { reserveProviderCall, providerBudgetConfig } from '../functions/_lib/provider-budget.js';
import { callModel } from '../functions/_lib/model.js';
import { saveTurnCheckpoint } from '../functions/_lib/checkpoint.js';
import { listMessages } from '../functions/_lib/store.js';
import { searchWorkspace, formatSearchHits, listSymbols } from '../functions/_lib/search.js';

const keys = rsaKeys();
const jwksFetch = globalThis.fetch;
fakeJwks(keys);
const OWNER = 'https://team.cloudflareaccess.com|user-1';

async function setup(overrides = {}) {
  const env = makeEnv(keys, { MODEL_BASE_URL: 'https://model.example/v1', ...overrides });
  const authResponse = await auth.onRequestGet(ctx(req('/api/auth', {
    headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) }
  }), env));
  const cookie = authResponse.headers.get('Set-Cookie').split(';')[0];
  const created = await (await stateApi.onRequestPost(ctx(req('/api/state', {
    method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie }
  }), env))).json();
  return { env, cookie, id: created.id };
}

function context(request, env) {
  const tasks = [];
  return { ...ctx(request, env), tasks, waitUntil(p) { tasks.push(Promise.resolve(p)); } };
}
function chatRequest(cookie, id, body = {}) {
  return req('/api/chat', { method: 'POST', headers: { Cookie: cookie }, body: {
    conversationId: id, message: 'یک فایل کوچک بساز', model: 'test-model', localRunner: false, ...body
  } });
}
function sse(text) {
  return text.split('\n\n').filter((x) => x.startsWith('event:')).map((block) => ({
    name: block.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}')
  }));
}
function reply(content = 'انجام شد') {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

test('workspace search has a deterministic scan budget and never calls a partial scan a full negative', () => {
  const files = {};
  for (let i = 0; i < 240; i++) files[`src/file-${i}.js`] = 'NO_MATCH_SENTINEL\n'.repeat(6000);
  const result = searchWorkspace(files, 'needle-that-does-not-exist', { maxScanLines: 500, maxScanChars: 100_000 });
  assert.equal(result.truncated, true);
  assert.ok(result.scannedLines <= 600, 'line budget is checked between lines, not only after matches');
  assert.ok(result.budgetExceeded);
  assert.match(formatSearchHits(result), /scanned portion|truncated/i);
  assert.doesNotMatch(formatSearchHits(result), /^No matches for/);
  const symbols = listSymbols(files, { query: 'needle' });
  assert.equal(symbols.truncated, true);
  assert.throws(() => searchWorkspace({ 'a.js': 'aaaaaaaaaaaaaaaaaaaa!' }, '(a+)+$', { regex: true }), (e) => e.code === 'unsafe_regex');
});

// These assertions intentionally describe the new invariants, not the old
// "overwrite this conversation row" implementation.
test('turn lease rejects overlap, fences old cleanup, and expires without a Stop heartbeat extension', async () => {
  const env = makeEnv(keys);
  await ensureSchema(env);
  const a = await acquireTurn(env, OWNER, 'fence', { turnId: 'turn-a', requestId: 'request-a' });
  assert.equal(a.acquired, true);
  const b = await acquireTurn(env, OWNER, 'fence', { turnId: 'turn-b' });
  assert.equal(b.acquired, false, 'a live lease cannot be overwritten');
  assert.equal(b.current.turnId, 'turn-a');
  const stopping = await requestTurnStop(env, OWNER, 'fence', { turnId: 'turn-a' });
  assert.equal(stopping.requested, true);
  const before = await getTurnStatus(env, OWNER, 'fence');
  assert.equal(await heartbeatTurn(env, OWNER, 'fence', 'turn-a').then((x) => x.stopped), true);
  const after = await getTurnStatus(env, OWNER, 'fence');
  assert.equal(after.leaseExpiresAt, before.leaseExpiresAt, 'Stop must not extend a zombie lease');
  await env.DB.prepare('UPDATE active_turns SET lease_expires_at=? WHERE conversation_id=?')
    .bind(Date.now() - 1, 'fence').run();
  const c = await acquireTurn(env, OWNER, 'fence', { turnId: 'turn-c', requestId: 'request-c' });
  assert.equal(c.acquired, true);
  assert.equal((await heartbeatTurn(env, OWNER, 'fence', 'turn-a')).lost, true);
  await releaseTurn(env, OWNER, 'fence', 'turn-a', 'stopped');
  assert.equal((await getTurnStatus(env, OWNER, 'fence')).turnId, 'turn-c');
  assert.equal(await isTurnActive(env, OWNER, 'fence'), true, 'old cleanup cannot deactivate new work');
  assert.ok(TURN_LEASE_MS <= 60_000);
  const stoppedNew = await requestTurnStop(env, OWNER, 'fence', { turnId: 'turn-a' });
  assert.equal(stoppedNew.requested, false, 'a stale Stop cannot target the replacement');
});

test('Stop can fence a request that has not yet admitted its Worker turn', async () => {
  const env = makeEnv(keys);
  await ensureSchema(env);
  await requestTurnStop(env, OWNER, 'pending', { requestId: 'request-before-admission' });
  const blocked = await acquireTurn(env, OWNER, 'pending', { requestId: 'request-before-admission' });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.cancelled, true);
});

test('legacy D1 v10 rows migrate without becoming live leases', async () => {
  const env = makeEnv(keys);
  const original = globalThis.fetch;
  try {
    env.DB._db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES('schema_version','10');
      CREATE TABLE active_turns(conversation_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stop_requested INTEGER NOT NULL DEFAULT 0);
      INSERT INTO active_turns VALUES('old','${OWNER}',1,9999999999999,1);`);
    await ensureSchema(env);
    assert.equal(await isTurnActive(env, OWNER, 'old'), false);
    assert.equal((await env.DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first()).value, String(SCHEMA_VERSION));
  } finally { globalThis.fetch = original; }
});

test('provider budget is shared, bounded, atomic, and scoped to the actual API-key credential', async () => {
  const env = makeEnv(keys, { MODEL_CALLS_PER_MINUTE: '2', PROVIDER_MAX_INFLIGHT: '3' });
  await ensureSchema(env);
  const first = { ...env, MODEL_API_KEY: 'key-a', MODEL_BASE_URL: 'https://one.example/v1' };
  const otherIsolate = { ...env, MODEL_API_KEY: 'key-a', MODEL_BASE_URL: 'https://two.example/v1' };
  const otherKey = { ...env, MODEL_API_KEY: 'key-b', MODEL_BASE_URL: 'https://one.example/v1' };
  const a = await reserveProviderCall(first);
  assert.equal(a.allowed, true);
  const b = await reserveProviderCall(otherIsolate);
  assert.equal(b.allowed, true);
  const blocked = await reserveProviderCall(first);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
  assert.equal((await reserveProviderCall(otherKey)).allowed, true, 'different keys have separate provider quotas');
  await a.release();
  await a.release();
  await b.release();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE bucket=? AND state='running'").bind(a.bucket).first();
  assert.equal(row.n, 0, 'release is idempotent and fenced');
  assert.equal(providerBudgetConfig(env).perMinute, 2);
});

test('callModel charges every actual HTTP attempt including 429 retries, never clamps Retry-After down', async () => {
  const env = makeEnv(keys, { MODEL_BASE_URL: 'https://model.example/v1', MODEL_CALLS_PER_MINUTE: '20' });
  await ensureSchema(env);
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) attempts.push(String(url));
    return new Response('{"error":{"message":"rate limit"}}', {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' }
    });
  };
  try {
    await assert.rejects(callModel(env, { messages: [{ role: 'user', content: 'test' }] }), (error) => {
      assert.equal(error.code, 'model_rate_limited');
      assert.ok(error.retryAfterMs >= 59_000);
      return true;
    });
    assert.equal(attempts.length, 1, 'a 60-second Retry-After cannot be retried inside this request');
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE bucket LIKE 'provider:%'").first();
    assert.equal(row.n, 1);
  } finally { globalThis.fetch = original; }
});

test('the same chat requestId persists the user once and never starts overlapping model work', async () => {
  const { env, cookie, id } = await setup();
  const original = globalThis.fetch;
  let calls = 0;
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
    calls += 1;
    await gate;
    return reply();
  };
  const c1 = context(chatRequest(cookie, id, { requestId: 'same-request' }), env);
  const c2 = context(chatRequest(cookie, id, { requestId: 'same-request' }), env);
  try {
    const first = await chat.onRequestPost(c1);
    assert.equal(first.status, 200);
    // Wait for admission before issuing the transport retry.
    for (let n = 0; n < 100 && !(await isTurnActive(env, OWNER, id)); n++) await new Promise((r) => setTimeout(r, 5));
    const second = await chat.onRequestPost(c2);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, 'turn_active');
    assert.equal(calls, 1);
    assert.equal((await listMessages(env, id)).filter((m) => m.role === 'user').length, 1);
    unblock();
    await Promise.allSettled(c1.tasks);
    const events = sse(await first.text());
    assert.equal(events.at(-1).name, 'done');
    assert.ok(events[0].data.turnId);
    assert.equal(events[0].data.requestId, 'same-request');
    const duplicate = await chat.onRequestPost(context(chatRequest(cookie, id, { requestId: 'same-request' }), env));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.headers.get('X-Request-Replayed'), '1');
    assert.equal(calls, 1, 'a settled retry returns status, not another model call');
    assert.equal((await listMessages(env, id)).filter((m) => m.role === 'user').length, 1);
  } finally { unblock(); globalThis.fetch = original; }
});

test('reusing a requestId with different content is a conflict, not a second user row', async () => {
  const { env, cookie, id } = await setup();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
    return reply();
  };
  try {
    const first = await chat.onRequestPost(context(chatRequest(cookie, id, { requestId: 'conflict-request', message: 'اول' }), env));
    await first.text();
    const second = await chat.onRequestPost(context(chatRequest(cookie, id, { requestId: 'conflict-request', message: 'دوم' }), env));
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, 'request_id_conflict');
    assert.equal((await listMessages(env, id)).filter((m) => m.role === 'user').length, 1);
  } finally { globalThis.fetch = original; }
});

test('silent recovery cannot resume a user-stopped or foreign checkpoint', async () => {
  const { env, cookie, id } = await setup();
  await saveTurnCheckpoint(env, OWNER, id, { turnId: 'old-turn', reason: 'user_stopped', originalGoal: 'کار' });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
    calls += 1;
    return reply();
  };
  try {
    const res = await chat.onRequestPost(context(chatRequest(cookie, id, {
      requestId: 'stale-resume-request', message: 'ادامه', silentAutoResume: true, resumeCheckpoint: true, resumeTurnId: 'old-turn'
    }), env));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'checkpoint_stale');
    assert.equal(calls, 0);
    assert.equal(await isTurnActive(env, OWNER, id), false, 'rejected setup releases the lease');
  } finally { globalThis.fetch = original; }
});

test('Stop API reports accepted separately from stopped and returns the fenced turn id', async () => {
  const { env, cookie, id } = await setup();
  const lease = await acquireTurn(env, OWNER, id, { turnId: 'remote-turn', requestId: 'remote-request' });
  assert.equal(lease.acquired, true);
  const response = await stopApi.onRequestPost(ctx(req('/api/chat/stop', {
    method: 'POST', headers: { Cookie: cookie }, body: { id, turnId: 'remote-turn', requestId: 'remote-request' }
  }), env));
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.stopped, false, 'cross-isolate acceptance is not evidence of a stopped Worker');
  assert.equal(body.turnId, 'remote-turn');
  assert.equal(body.state, 'stopping');
  const detail = await (await detailApi.onRequestGet(ctx(req(`/api/state/conversations/${id}?lite=1`, {
    headers: { Cookie: cookie }
  }), env, { id }))).json();
  assert.equal(detail.turnActive, true);
  assert.equal(detail.turn.turnId, 'remote-turn');
  assert.equal(detail.turn.stopRequested, true);
  await releaseTurn(env, OWNER, id, 'remote-turn', 'stopped');
  await clearTurnCheckpointForTurn(env, OWNER, id, 'remote-turn');
  assert.equal(await isTurnActive(env, OWNER, id), false);
});
