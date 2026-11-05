import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const chat = await import(`${root}/api/chat.js`);
const oneConv = await import(`${root}/api/state/conversations/[id].js`);
const memory = await import(`${root}/_lib/memory.js`);

const keys = rsaKeys();
fakeJwks(keys);
const env = makeEnv(keys);
env.CONTEXT_BUDGET_TOKENS = '1200';

let cookie;
let conversationId;
const modelCalls = [];

// ---- fake model provider -------------------------------------------------
function installModel({ script }) {
  const original = globalThis.fetch;
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    if (!String(url).includes('/chat/completions')) throw new Error('unexpected fetch ' + url);
    assert.equal(init.headers.Authorization, `Bearer ${env.MODEL_API_KEY}`);
    const payload = JSON.parse(init.body);
    modelCalls.push(payload);
    const next = script[Math.min(step, script.length - 1)];
    step += 1;
    const message = typeof next === 'function' ? next(payload) : next;
    return new Response(
      JSON.stringify({ model: 'fake-model', choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  return () => { globalThis.fetch = original; };
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

async function send(text) {
  const res = await chat.onRequestPost(
    ctx(
      req('/api/chat', {
        method: 'POST',
        body: { conversationId, message: text },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  assert.equal(res.status, 200, await res.clone().text());
  return parseSse(res);
}

test('plain answer is streamed and persisted', async () => {
  await signIn();
  const restore = installModel({ script: [{ role: 'assistant', content: 'سلام! فایل‌ها را می‌خوانم.' }] });
  try {
    const events = await send('سلام');
    assert.equal(events.at(-1).name, 'done');
    assert.ok(events.some((e) => e.name === 'assistant'));
    assert.equal(events.at(-1).data.conversation.messageCount, 2);
  } finally {
    restore();
  }
  const data = await (
    await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${conversationId}`, { headers: { Cookie: cookie } }), env, { id: conversationId }))
  ).json();
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[0].content, 'سلام');
  assert.equal(data.messages[1].content, 'سلام! فایل‌ها را می‌خوانم.');
});

test('tool loop: write_file → tool result → final answer, workspace persisted', async () => {
  const restore = installModel({
    script: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>CodePilot</h1>' }) }
          }
        ]
      },
      { role: 'assistant', content: 'فایل index.html ساخته شد.' }
    ]
  });
  try {
    const events = await send('یک index.html بساز');
    const names = events.map((e) => e.name);
    assert.ok(names.includes('tool'), names.join(','));
    assert.ok(names.includes('tool_result'));
    const done = events.at(-1);
    assert.equal(done.name, 'done');
    assert.deepEqual(done.data.touchedFiles, ['index.html']);
    assert.equal(done.data.workspace.files['index.html'], '<h1>CodePilot</h1>');
  } finally {
    restore();
  }

  const stored = await (
    await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${conversationId}`, { headers: { Cookie: cookie } }), env, { id: conversationId }))
  ).json();
  const roles = stored.messages.map((m) => m.role);
  // user, assistant(tool_call), tool, assistant
  assert.deepEqual(roles.slice(-4), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(stored.workspace.files['index.html'], '<h1>CodePilot</h1>');

  // The follow-up request must replay a valid assistant/tool group.
  const store = modelCalls.at(-1);
  const wire = store.messages.filter((m) => m.role !== 'system');
  const callIndex = wire.findIndex((m) => m.tool_calls);
  assert.ok(callIndex >= 0);
  assert.equal(wire[callIndex + 1].role, 'tool');
  assert.equal(wire[callIndex + 1].tool_call_id, 'call_1');
});

test('credentials in tool output and user text never reach the model unredacted', async () => {
  const restore = installModel({
    script: [
      { role: 'assistant', content: 'ok' }
    ]
  });
  try {
    await send('کلید من sk-abcdefghijklmnopqrstuvwxyz123456 است، آن را ذخیره نکن');
    const payload = modelCalls.at(-1);
    const flat = JSON.stringify(payload.messages);
    assert.ok(!flat.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'secret leaked to model');
    // Assert the *set*, not the count: adding a tool must not break the security
    // test, but removing one silently would.
    const expectedTools = [
      'list_files',
      'read_file',
      'search_code',
      'list_symbols',
      'write_file',
      'apply_patch',
      'undo_edit',
      'file_history',
      'run_command'
    ];
    const names = (payload.tools || []).map((t) => t.function.name).sort();
    assert.deepEqual(names, [...expectedTools].sort());
    assert.ok(
      payload.tools.every((t) => Object.keys(t.function.parameters.properties || {}).length >= 0)
    );
  } finally {
    restore();
  }
});

test('long conversation is summarized, not truncated blindly', async () => {
  // Seed a history long enough to need compression at the 1200-token test budget.
  const filler = 'این یک پیام طولانی برای پر کردن زمینه است. '.repeat(40);
  const seed = [];
  for (let i = 0; i < 12; i += 1) {
    seed.push({ role: 'user', content: `پیام ${i}: ${filler}`, created_at: Date.now() + i * 2 });
    seed.push({ role: 'assistant', content: `پاسخ ${i}: ${filler}`, created_at: Date.now() + i * 2 + 1 });
  }
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: { action: 'append', id: conversationId, messages: seed },
        headers: { Cookie: cookie }
      }),
      env
    )
  );

  const restore = installModel({
    script: [
      // summarizer
      {
        role: 'assistant',
        content: JSON.stringify({
          summary: 'کاربر می‌خواهد یک صفحه فرود ساخته شود؛ فایل index.html ساخته شد.',
          memo: [{ key: 'goal', value: 'landing page' }]
        })
      },
      { role: 'assistant', content: 'ادامه می‌دهیم.' }
    ]
  });
  try {
    await send('حالا رنگ دکمه را عوض کن');
  } finally {
    restore();
  }

  const stored = await (
    await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${conversationId}`, { headers: { Cookie: cookie } }), env, { id: conversationId }))
  ).json();
  assert.ok(stored.conversation.summaryUntil > 0, 'summary_until was not advanced');
  assert.ok(stored.conversation.summary.length > 10);

  const finalCall = modelCalls.at(-1);
  assert.ok(
    finalCall.messages.some((m) => typeof m.content === 'string' && m.content.includes('حافظه‌ی گفتگو')),
    'summary was not injected into the model context'
  );
  // Tool groups must stay ordered: every tool message follows its assistant call.
  for (let i = 0; i < finalCall.messages.length; i += 1) {
    if (finalCall.messages[i].role === 'tool') {
      assert.ok(i > 0 && finalCall.messages[i - 1].role === 'assistant' || finalCall.messages[i - 1].role === 'tool');
    }
  }

  const memories = await (
    await (await import(`${root}/api/state/memory/index.js`)).onRequestGet(
      ctx(req('/api/state/memory', { headers: { Cookie: cookie } }), env)
    )
  ).json();
  assert.ok(memories.memory.some((m) => m.key === 'goal'), 'memo was not saved to long-term memory');
});

test('repairToolGroups drops dangling calls and orphan results', () => {
  const repaired = memory.repairToolGroups([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'user', content: 'b' },
    { role: 'tool', tool_call_id: 'call_orphan', content: 'x' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_y', content: '[]' }
  ]);
  assert.deepEqual(repaired.map((m) => m.role), ['user', 'user', 'assistant', 'tool']);
  assert.equal(repaired.at(-1).tool_call_id, 'call_y');
});

test('model failure returns a safe SSE error and keeps the user message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    return new Response('{"error":{"message":"bad key sk-live-abcdefghijklmnop","type":"auth"}}', { status: 401 });
  };
  try {
    const events = await send('این پیام باید ذخیره بماند');
    const errorEvent = events.find((e) => e.name === 'error');
    assert.ok(errorEvent, JSON.stringify(events));
    assert.ok(!JSON.stringify(errorEvent).includes('sk-live'), 'provider secret leaked');
  } finally {
    globalThis.fetch = original;
  }
  const stored = await (
    await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${conversationId}`, { headers: { Cookie: cookie } }), env, { id: conversationId }))
  ).json();
  assert.ok(stored.messages.some((m) => m.content.includes('این پیام باید ذخیره بماند')));
});

test('rate limits stop a runaway loop', async () => {
  const envLimits = makeEnv(keys);
  envLimits.CHAT_LIMIT_PER_MINUTE = '2';
  envLimits.CHAT_LIMIT_PER_DAY = '100';
  const { enforceChatLimits } = await import(`${root}/_lib/limits.js`);
  const { ensureSchema } = await import(`${root}/_lib/schema.js`);
  await ensureSchema(envLimits);
  await enforceChatLimits(envLimits, 'owner-a');
  await enforceChatLimits(envLimits, 'owner-a');
  await assert.rejects(() => enforceChatLimits(envLimits, 'owner-a'), (error) => error.status === 429);
  // Another owner is unaffected.
  await enforceChatLimits(envLimits, 'owner-b');
});
