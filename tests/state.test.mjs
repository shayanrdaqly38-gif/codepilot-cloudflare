import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const convApi = await import(`${root}/api/state/conversations/index.js`);
const oneConv = await import(`${root}/api/state/conversations/[id].js`);
const memoryApi = await import(`${root}/api/state/memory/index.js`);
const usageApi = await import(`${root}/api/state/usage.js`);
const configApi = await import(`${root}/api/config.js`);

const keys = rsaKeys();
let env;
let cookie;

before(() => {
  fakeJwks(keys);
  env = makeEnv(keys);
});

async function signIn(overrides = {}) {
  const token = accessToken(keys, overrides);
  const request = req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': token } });
  const res = await auth.onRequestGet(ctx(request, env));
  assert.equal(res.status, 200, await res.clone().text());
  const setCookie = res.headers.get('Set-Cookie');
  return { body: await res.json(), cookie: setCookie ? setCookie.split(';')[0] : null };
}

test('rejects anonymous requests', async () => {
  const res = await auth.onRequestGet(ctx(req('/api/auth'), env));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, 'access_required');
});

test('rejects a forged Access token', async () => {
  const res = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } }), env)
  );
  assert.equal(res.status, 401);
});

test('rejects a token signed for another audience', async () => {
  const token = accessToken(keys, { aud: 'other-aud' });
  const res = await auth.onRequestGet(ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  assert.equal(res.status, 401);
});

test('signs in, sets HttpOnly session cookie, and reports the user', async () => {
  const { body, cookie: c } = await signIn();
  assert.equal(body.signedIn, true);
  assert.equal(body.user.email, 'dev@example.com');
  cookie = c;
  assert.match(cookie, /^cp_session=/);
});

test('session cookie alone authenticates later requests', async () => {
  const request = req('/api/state', { headers: { Cookie: cookie } });
  const res = await stateApi.onRequestGet(ctx(request, env));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.conversations));
});

test('wrong-origin POST is rejected', async () => {
  const request = req('/api/state', {
    method: 'POST',
    body: { action: 'create' },
    headers: { Cookie: cookie, Origin: 'https://evil.example' }
  });
  const res = await stateApi.onRequestPost(ctx(request, env));
  assert.equal(res.status, 403);
});

test('conversation lifecycle + isolation between users', async () => {
  const createRes = await stateApi.onRequestPost(
    ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
  );
  const created = await createRes.json();
  assert.equal(createRes.status, 200, JSON.stringify(created));
  assert.ok(created.id);

  const listRes = await convApi.onRequestGet(ctx(req('/api/state/conversations', { headers: { Cookie: cookie } }), env));
  const list = await listRes.json();
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].id, created.id);

  // A second user must not read it.
  const other = await signIn({ sub: 'user-2', email: 'other@example.com' });
  const denied = await oneConv.onRequestGet(
    ctx(req(`/api/state/conversations/${created.id}`, { headers: { Cookie: other.cookie } }), env, { id: created.id })
  );
  assert.equal(denied.status, 404);
});

test('append, read, workspace save and summary round-trip', async () => {
  const listRes = await convApi.onRequestGet(ctx(req('/api/state/conversations', { headers: { Cookie: cookie } }), env));
  const { conversations } = await listRes.json();
  const id = conversations[0].id;

  const appendRes = await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: {
          action: 'append',
          id,
          messages: [
            { role: 'user', content: 'سلام، فایل index.html را بررسی کن', created_at: 1700000000000 },
            { role: 'assistant', content: 'حتماً، اول فایل‌ها را می‌خوانم.', created_at: 1700000001000 }
          ]
        },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  const appended = await appendRes.json();
  assert.equal(appendRes.status, 200, JSON.stringify(appended));
  assert.equal(appended.messageCount, 2);

  const wsRes = await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: { action: 'workspace', id, workspace: { files: { 'index.html': '<h1>hi</h1>' }, active: 'index.html' } },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  assert.equal(wsRes.status, 200);

  const one = await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${id}`, { headers: { Cookie: cookie } }), env, { id }));
  const data = await one.json();
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[0].role, 'user');
  assert.equal(data.workspace.files['index.html'], '<h1>hi</h1>');
  assert.match(data.conversation.title, /بررسی/);
});

test('secrets are redacted from stored messages and memory', async () => {
  const memRes = await memoryApi.onRequestPost(
    ctx(
      req('/api/state/memory', {
        method: 'POST',
        body: { action: 'upsert', key: 'token', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  const mem = await memRes.json();
  assert.ok(!mem.memory.value.includes('ghp_'), mem.memory.value);

  const listRes = await convApi.onRequestGet(ctx(req('/api/state/conversations', { headers: { Cookie: cookie } }), env));
  const { conversations } = await listRes.json();
  const id = conversations[0].id;
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: {
          action: 'append',
          id,
          messages: [{ role: 'user', content: 'api_key = "super-secret-value-123"', created_at: Date.now() }]
        },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  const one = await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${id}`, { headers: { Cookie: cookie } }), env, { id }));
  const data = await one.json();
  const stored = data.messages.map((m) => m.content).join('\n');
  assert.ok(!stored.includes('super-secret-value-123'), stored);
});

test('usage and config endpoints respond', async () => {
  const usage = await (await usageApi.onRequestGet(ctx(req('/api/state/usage', { headers: { Cookie: cookie } }), env))).json();
  assert.ok(Array.isArray(usage.days));
  const config = await (await configApi.onRequestGet(ctx(req('/api/config', { headers: { Cookie: cookie } }), env))).json();
  assert.equal(config.storage, 'd1');
  assert.equal(config.model, 'gpt-4o-mini');
  assert.ok(!JSON.stringify(config).includes('sk-test'));
});

test('export and delete-all work and are owner-scoped', async () => {
  const exported = await (
    await stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body: { action: 'export' }, headers: { Cookie: cookie } }), env))
  ).json();
  assert.ok(exported.conversations.length >= 1);
  assert.ok(exported.memory.length >= 1);

  const del = await (
    await stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body: { action: 'delete-all' }, headers: { Cookie: cookie } }), env))
  ).json();
  assert.ok(del.deletedConversations >= 1);

  const after = await (await stateApi.onRequestGet(ctx(req('/api/state', { headers: { Cookie: cookie } }), env))).json();
  assert.equal(after.conversations.length, 0);
  assert.equal(after.memory.length, 0);
});

test('a missing D1 binding returns a precise 503, not a generic 500', async () => {
  const env = makeEnv(keys);
  delete env.DB;
  const res = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'db_missing');
  assert.match(body.error, /DB/);
});

test('a turn that appends many messages does not use a compound SELECT', async () => {
  // Regression: appendMessages used `INSERT ... SELECT ? UNION ALL SELECT ? ...`,
  // which D1 rejects with "too many terms in compound SELECT" once a turn stores
  // more than a handful of messages. A normal agent turn with tool calls appends
  // 7+, so every such turn ended in chat_failed *after* the tools had already
  // modified the workspace -- the work was done but the reply was an error.
  //
  // The harness enforces D1's compound-SELECT ceiling, so the old query shape
  // throws here instead of only in production.
  const store = await import(`${root}/_lib/store.js`);
  const localEnv = makeEnv(keys);
  const owner = 'many@example.com';
  const convId = await store.createConversation(localEnv, owner, {});
  const conv = await store.getConversation(localEnv, owner, convId);

  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `message ${i}`,
    created_at: Date.now() + i
  }));

  const result = await store.appendMessages(localEnv, conv, messages);
  assert.equal(result.inserted, 30);
  assert.equal(result.nextSeq, 30);

  const rows = await localEnv.DB.prepare('SELECT seq FROM messages WHERE conversation_id=? ORDER BY seq')
    .bind(conv.id)
    .all();
  assert.equal(rows.results.length, 30);
  assert.deepEqual(rows.results.map((r) => r.seq), Array.from({ length: 30 }, (_, i) => i + 1));
});
