// GPT-like «توقف»: end-to-end test for the stop endpoint against a hung upstream
// model stream. The turn registers an AbortController; POST /api/chat/stop
// aborts it; the turn finalizes with a `stopped` SSE event + durable checkpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const chat = await import(`${root}/api/chat.js`);
const stopApi = await import(`${root}/api/chat/stop.js`);

const keys = rsaKeys();
fakeJwks(keys);
const env = makeEnv(keys);
env.CONTEXT_BUDGET_TOKENS = '1200';

let cookie;
let conversationId;

async function signIn() {
  const res = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  cookie = res.headers.get('Set-Cookie').split(';')[0];
  const created = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
    )
  ).json();
  conversationId = created.id;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Hanging upstream SSE: emits one delta, then stays open with keepalives until
// the worker's request signal aborts (which closes the body — real providers
// drop the TCP socket the same way).
function installHangingModel() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    if (!String(url).includes('/chat/completions')) throw new Error('unexpected fetch ' + url);
    const signal = init?.signal || null;
    const encoder = new TextEncoder();
    calls += 1;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n'));
        if (signal) {
          signal.addEventListener('abort', () => {
            try { controller.close(); } catch { /* already closed */ }
          }, { once: true });
        }
      },
      pull(controller) {
        // Keep the socket open: only keepalive frames, never [DONE].
        controller.enqueue(encoder.encode(': kb\n\n'));
      }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { restore: () => { globalThis.fetch = original; }, calls: () => calls };
}

async function parseSse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const name = /event: (.*)/.exec(block)?.[1];
    const data = /data: (.*)/.exec(block)?.[1];
    if (name && data) events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

test('stop endpoint aborts an in-flight turn and streams a "stopped" event', async () => {
  const hanging = installHangingModel();
  try {
    await signIn();

    // Fire the turn without awaiting — it streams for as long as the model hangs.
    const turnPromise = chat.onRequestPost(
      ctx(req('/api/chat', { method: 'POST', body: { conversationId, message: 'سلام' }, headers: { Cookie: cookie } }), env)
    );

    // Wait until the model call started (registry populated).
    for (let i = 0; i < 40 && hanging.calls() === 0; i += 1) await sleep(50);

    assert.ok(hanging.calls() > 0, 'model call should have started before stop');

    const stopRes = await stopApi.onRequest(
      ctx(req('/api/chat/stop', { method: 'POST', body: { id: conversationId }, headers: { Cookie: cookie } }), env)
    );
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    assert.equal(stopJson.ok, true);
    assert.equal(stopJson.stopped, true, 'stop should abort the active turn');

    const sseRes = await Promise.race([
      turnPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('turn did not finalize in time')), 8000))
    ]);
    assert.equal(sseRes.status, 200);
    const events = await parseSse(sseRes);
    const stopped = events.find((e) => e.name === 'stopped');
    assert.ok(stopped, 'should receive a stopped SSE event');
    assert.equal(stopped.data.code, 'turn_stopped');
    assert.equal(stopped.data.reason, 'user_stopped');
    assert.equal(stopped.data.resumable, true);
    assert.ok(String(stopped.data.partialContent || '').includes('part'), 'partial content should be preserved');
  } finally {
    hanging.restore();
  }
});

test('stop endpoint is idempotent and validates input', async () => {
  await signIn();
  const missing = await stopApi.onRequest(ctx(req('/api/chat/stop', { method: 'POST', body: {}, headers: { Cookie: cookie } }), env));
  assert.equal(missing.status, 400);
  const idle = await stopApi.onRequest(ctx(req('/api/chat/stop', { method: 'POST', body: { id: conversationId }, headers: { Cookie: cookie } }), env));
  const json = await idle.json();
  assert.equal(json.ok, true);
  assert.equal(json.stopped, false, 'no active turn → stopped:false (idempotent)');
});
