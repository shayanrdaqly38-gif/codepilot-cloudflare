// Backend regressions for the 2026-11-09 audit findings:
//
//   1. GET /api/state returned only 200 conversations while the quota allowed
//      300 — the newest 100 chats became unreachable, and the archive drawer
//      had no way to list what archiving hid.
//   2. message bodies were not searchable at all.
//   3. an explicit maxSteps below the stamina floor was silently raised
//      (8 -> 60), so "keep this turn short" was impossible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const { resolvePowerExecutionPlan } = await import(`${root}/_lib/provider.js`);
const { publicLimits } = await import(`${root}/_lib/store.js`);

const keys = rsaKeys();
fakeJwks(keys);
const env = makeEnv();
const cookie = (
  await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  )
)
  .headers.get('Set-Cookie')
  .split(';')[0];

const post = async (body) =>
  stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body, headers: { Cookie: cookie } }), env));
const get = async (qs = '') =>
  (await stateApi.onRequestGet(ctx(req('/api/state' + qs, { headers: { Cookie: cookie } }), env))).json();

test('quota allows 300 conversations and the sidebar receives all of them', async () => {
  const ids = [];
  for (let i = 0; i < 300; i += 1) {
    const res = await post({ action: 'create', title: `c${i}`, mode: 'developer' });
    const body = await res.json();
    if (body.id) ids.push(body.id);
  }
  assert.equal(ids.length, 300, 'the 300th conversation must still be creatable');

  const list = await get();
  assert.equal(
    list.conversations.length,
    300,
    'GET /api/state must return every conversation the quota allows (was capped at 200)'
  );

  const overflow = await post({ action: 'create', title: 'overflow', mode: 'developer' });
  assert.equal(overflow.status, 409);
  assert.equal((await overflow.json()).code, 'quota');
});

test('archiving hides a conversation, lists it separately, and frees quota', async () => {
  const before = await get();
  const target = before.conversations[0];

  await post({ action: 'flags', id: target.id, archived: true });

  const live = await get();
  assert.equal(live.conversations.length, 299, 'archived chats must leave the live list');
  assert.ok(!live.conversations.some((c) => c.id === target.id), 'the archived chat must be gone from the sidebar');

  const drawer = await get('?archived=1');
  assert.equal(drawer.archived?.length, 1, 'the archive drawer must list it');
  assert.ok(!drawer.conversations?.length, 'the archive payload must not repeat the live list');

  const created = await post({ action: 'create', title: 'after archive', mode: 'developer' });
  assert.equal(created.status, 200, 'freeing a slot must allow a new conversation');

  await post({ action: 'flags', id: target.id, archived: false });
  const restored = await get();
  assert.ok(restored.conversations.some((c) => c.id === target.id), 'un-archiving must bring it back');
});

test('message bodies are searchable across conversations', async () => {
  const { conversations } = await get();
  const target = conversations[0];
  await post({
    action: 'append',
    id: target.id,
    messages: [
      { role: 'user', content: 'این عبارت یکتاست: زبرا-ققنوس', seq: 0, created_at: Date.now() },
      { role: 'assistant', content: 'باشه', seq: 1, created_at: Date.now() }
    ]
  });

  const found = await (await post({ action: 'search-conversations', query: 'زبرا-ققنوس' })).json();
  assert.equal(found.results?.length, 1, 'the match must be found');
  assert.equal(found.results[0].conversationId, target.id);
  assert.match(found.results[0].snippet, /زبرا-ققنوس/, 'the snippet must contain the hit');

  const tooShort = await post({ action: 'search-conversations', query: 'x' });
  assert.equal(tooShort.status, 400, 'queries under 2 chars must be rejected');

  const missing = await (await post({ action: 'search-conversations', query: 'چیزی-که-نیست' })).json();
  assert.deepEqual(missing.results, [], 'a miss must return an empty list, not an error');

  // LIKE wildcards typed by the user must be treated literally.
  const wildcard = await (await post({ action: 'search-conversations', query: '%%' })).json();
  assert.deepEqual(wildcard.results, [], '% must not behave as a wildcard');
});

test('an explicit maxSteps below the stamina floor is honoured', async () => {
  const cases = [
    ['medium', 8, 8],
    ['hard', 8, 8],
    ['max', 8, 8],
    ['ultra-code', 30, 30],
    ['ultra-code', 300, 300]
  ];
  for (const [workStamina, requested, expected] of cases) {
    const plan = resolvePowerExecutionPlan({ maxSteps: requested, workStamina }, null);
    assert.equal(
      plan.maxSteps,
      expected,
      `stamina=${workStamina} maxSteps=${requested} must stay ${expected} (was raised to the floor)`
    );
  }

  // Without an explicit cap the stamina floor still applies.
  const auto = resolvePowerExecutionPlan({ workStamina: 'ultra-code' }, null);
  assert.ok(auto.maxSteps >= 80, 'the stamina floor must still boost automatic turns');

  // Marathon still lifts a deliberately short turn so a goal can finish.
  const marathon = resolvePowerExecutionPlan(
    { maxSteps: 10, workStamina: 'low', marathon: { active: true, paused: false } },
    null
  );
  assert.ok(marathon.maxSteps >= 36, 'an active marathon must keep its minimum headroom');
});

test('public limits are reported to the client', async () => {
  const limits = publicLimits();
  assert.equal(limits.maxConversations, 300);
  assert.equal(limits.maxMessagesPerConversation, 4000);
  assert.equal(limits.maxTitleChars, 120);
});
