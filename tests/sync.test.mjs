import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const oneConv = await import(`${root}/api/state/conversations/[id].js`);
const convList = await import(`${root}/api/state/conversations/index.js`);

const keys = rsaKeys();
fakeJwks(keys);

async function signInCookie(env, { email = 'dev@example.com', sub = 'user-1' } = {}) {
  const res = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys, { email, sub }) } }), env)
  );
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.get('Set-Cookie').split(';')[0];
}

test('same account on two devices sees the same conversation and files', async () => {
  const env = makeEnv(keys);
  const laptop = await signInCookie(env);
  const phone = await signInCookie(env);

  const created = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: laptop } }), env)
    )
  ).json();

  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: {
          action: 'append',
          id: created.id,
          messages: [{ role: 'user', content: 'روی لپ‌تاپ نوشتم', created_at: Date.now() }]
        },
        headers: { Cookie: laptop }
      }),
      env
    )
  );
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: { action: 'workspace', id: created.id, workspace: { files: { 'a.html': 'A' }, active: 'a.html' } },
        headers: { Cookie: laptop }
      }),
      env
    )
  );

  const list = await (await convList.onRequestGet(ctx(req('/api/state/conversations', { headers: { Cookie: phone } }), env))).json();
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].id, created.id);

  const res = await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${created.id}`, { headers: { Cookie: phone } }), env, { id: created.id }));
  assert.equal(res.status, 200);
  const opened = await res.json();
  assert.equal(opened.messages.at(-1).content, 'روی لپ‌تاپ نوشتم');
  assert.equal(opened.workspace.files['a.html'], 'A');
});

test('a different account gets its own empty space', async () => {
  const env = makeEnv(keys);
  await signInCookie(env);
  const stranger = await signInCookie(env, { email: 'stranger@example.com', sub: 'user-9' });
  const data = await (await stateApi.onRequestGet(ctx(req('/api/state', { headers: { Cookie: stranger } }), env))).json();
  assert.equal(data.conversations.length, 0);
  assert.equal(data.memory.length, 0);
});

test('prototype schema (v1) upgrades in place and keeps rows', async () => {
  const env = makeEnv(keys);
  const raw = env.DB._db;
  raw.exec(
    `CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, write_token TEXT, workspace TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '', summary_until INTEGER NOT NULL DEFAULT 0)`
  );
  raw.exec(
    `CREATE TABLE messages (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(conversation_id, seq))`
  );
  raw
    .prepare('INSERT INTO conversations(id,owner,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('c-old', 'https://team.cloudflareaccess.com|user-1', 'قدیمی', 1, 2);
  raw
    .prepare('INSERT INTO messages(conversation_id,seq,created_at,body) VALUES(?,?,?,?)')
    .run('c-old', 0, 3, JSON.stringify({ role: 'user', content: 'پیام قدیمی' }));

  const cookie = await signInCookie(env);
  const res = await oneConv.onRequestGet(
    ctx(req('/api/state/conversations/c-old', { headers: { Cookie: cookie } }), env, { id: 'c-old' })
  );
  const body = await res.clone().text();
  assert.equal(res.status, 200, body);
  const opened = JSON.parse(body);
  assert.equal(opened.messages[0].content, 'پیام قدیمی');
  assert.equal(opened.conversation.title, 'قدیمی');

  const columns = env.DB._db.prepare('PRAGMA table_info(conversations)').all().map((r) => r.name);
  for (const expected of ['pinned', 'archived', 'summary_updated_at', 'message_count', 'last_message_at', 'last_model']) {
    assert.ok(columns.includes(expected), `missing migrated column ${expected}`);
  }
  // The users table must exist after migration too.
  const tables = env.DB._db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('memories'));
});
