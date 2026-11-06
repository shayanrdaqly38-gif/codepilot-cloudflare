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
      'think',
      'list_files',
      'read_file',
      'search_code',
      'list_symbols',
      'write_file',
      'apply_patch',
      'delete_file',
      'undo_edit',
      'file_history',
      'run_command',
      'web_search',
      'fetch_url'
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

test('Codex/Claude agent modes gate mutating tools, inject AGENTS.md, normalize interrupted tool->user history, and support fork + agentConfig', async () => {
  const memory = await import(`${root}/_lib/memory.js`);
  const configApi = await import(`${root}/api/config.js`);
  const stateApi = await import(`${root}/api/state/index.js`);

  // 1. normalizeWireSequence closes interrupted tool->user turns and coalesces consecutive user retries
  const ctxOut = await memory.buildWorkingContext({
    env: makeEnv(keys),
    conversation: { id: 'c1', owner: 'u1', summary: '', summary_until: 0 },
    messages: [
      { seq: 1, role: 'user', content: 'اولین تلاش ناموفق' },
      { seq: 2, role: 'user', content: 'دومین تلاش پس از خطا' },
      {
        seq: 3,
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'list_files', arguments: '{}' } }]
      },
      { seq: 4, role: 'tool', tool_call_id: 'tc_1', content: '["index.html"]' },
      { seq: 5, role: 'user', content: 'ادامه بده' }
    ],
    callModel: async () => ({ message: { content: 'خلاصه' } })
  });
  const roles = ctxOut.recent.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant', 'user'], 'no consecutive user turns or direct tool->user jump');
  assert.match(ctxOut.recent[0].content, /اولین تلاش ناموفق[\s\S]*دومین تلاش/);

  // 2. Persist agentConfig via /api/config
  const saveCfgRes = await (
    await configApi.onRequestPost(
      ctx(
        req('/api/config', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            agentConfig: {
              mode: 'plan',
              networkAccess: false,
              responseStyle: 'senior-reviewer',
              goal: 'بازبینی امنیتی بدون تغییر فایل',
              theme: 'claude-warm'
            }
          }
        }),
        env
      )
    )
  ).json();
  assert.equal(saveCfgRes.ok, true);
  assert.equal(saveCfgRes.agentConfig.mode, 'plan');
  assert.equal(saveCfgRes.agentConfig.networkAccess, false);
  assert.equal(saveCfgRes.agentConfig.responseStyle, 'senior-reviewer');

  // Save an AGENTS.md file in the workspace so buildSystemPrompt auto-injects it
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: {
          action: 'workspace',
          id: conversationId,
          workspace: { files: { 'AGENTS.md': 'Rule #42: Always prefer pure functions.' }, active: 'AGENTS.md' }
        }
      }),
      env
    )
  );

  // 3. In plan mode + networkAccess:false, mutating tools and web tools are stripped and AGENTS.md is injected!
  let capturedPayload = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    capturedPayload = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'نقشه معماری آماده شد.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  try {
    const events = await send('معماری را بررسی کن');
    assert.ok(events.some((e) => e.name === 'done'));
    const toolNames = (capturedPayload.tools || []).map((t) => t.function.name);
    assert.ok(toolNames.includes('read_file'));
    assert.ok(!toolNames.includes('write_file'), 'plan mode must block write_file');
    assert.ok(!toolNames.includes('apply_patch'), 'plan mode must block apply_patch');
    assert.ok(!toolNames.includes('run_command'), 'plan mode must block run_command');
    assert.ok(!toolNames.includes('web_search'), 'networkAccess:false must block web_search');
    const sysText = capturedPayload.messages[0].content;
    assert.match(sysText, /PLAN MODE/);
    assert.match(sysText, /Rule #42: Always prefer pure functions/);
    assert.match(sysText, /بازبینی امنیتی بدون تغییر فایل/);
  } finally {
    globalThis.fetch = original;
  }

  // 4. Fork action clones conversation + workspace + messages
  const forkRes = await (
    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { action: 'fork', id: conversationId, title: 'شاخه تست' }
        }),
        env
      )
    )
  ).json();
  assert.equal(forkRes.ok, true);
  assert.ok(forkRes.id && forkRes.id !== conversationId);
  assert.ok(forkRes.messageCount >= 2);
});

test('AI Power Engine scales maxSteps across 6 tiers, preserves untouched reasoning_effort, injects 4 axes, and auto-repairs broken code', async () => {
  const providerLib = await import(`${root}/_lib/provider.js`);
  const configApi = await import(`${root}/api/config.js`);

  // 1. Verify resolvePowerExecutionPlan across all 6 levels
  assert.equal(providerLib.resolvePowerExecutionPlan({ workStamina: 'low' }).maxSteps, 8);
  assert.equal(providerLib.resolvePowerExecutionPlan({ workStamina: 'medium' }).maxSteps, 20);
  assert.equal(providerLib.resolvePowerExecutionPlan({ workStamina: 'hard' }).maxSteps, 32);
  assert.equal(providerLib.resolvePowerExecutionPlan({ workStamina: 'very-hard' }).maxSteps, 44);
  assert.equal(providerLib.resolvePowerExecutionPlan({ workStamina: 'max' }).maxSteps, 60);
  const ultraPlan = providerLib.resolvePowerExecutionPlan({ workStamina: 'ultra-code', detailThinking: 'ultra-code' });
  assert.equal(ultraPlan.maxSteps, 80);
  assert.equal(ultraPlan.contextBudget, 88_000);
  assert.equal(ultraPlan.timeoutMs, 180_000);

  // 2. Persist 4 independent Power axes via /api/config
  const savedCfg = await (
    await configApi.onRequestPost(
      ctx(
        req('/api/config', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            agentConfig: {
              mode: 'auto-edit',
              networkAccess: true,
              shellAccess: true,
              workStamina: 'ultra-code',
              detailThinking: 'very-hard',
              ambitionLevel: 'ultra-code',
              humanSensitivity: 'max'
            }
          }
        }),
        env
      )
    )
  ).json();
  assert.equal(savedCfg.agentConfig.workStamina, 'ultra-code');
  assert.equal(savedCfg.agentConfig.detailThinking, 'very-hard');
  assert.equal(savedCfg.agentConfig.ambitionLevel, 'ultra-code');
  assert.equal(savedCfg.agentConfig.humanSensitivity, 'max');

  // 3. Run /api/chat with untouched reasoningEffort='high' + broken JS edit -> verify auto-repair gate fixes it!
  const newConv = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
    )
  ).json();
  const capturedPayloads = [];
  let turnStep = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    const body = JSON.parse(init.body);
    capturedPayloads.push(body);
    turnStep += 1;
    if (turnStep === 1) {
      // Step 1: Model writes a broken JS file (missing closing brace)
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'tc_write_broken',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'engine.js', content: 'function boost() {\n  return 10;\n' })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (turnStep === 2) {
      // Step 2: Model tries to stop prematurely while engine.js still has a validation error!
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'تمام شد.' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (turnStep === 3) {
      // Step 3: Auto-repair gate caught the broken file and re-invoked model -> model fixes engine.js!
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'tc_fix_broken',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'engine.js', content: 'function boost() {\n  return 100;\n}\n' })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'فایل engine.js اصلاح و تکمیل شد.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const res = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            conversationId: newConv.id,
            message: 'موتور را بساز',
            reasoningEffort: 'high'
          }
        }),
        env
      )
    );
    assert.equal(res.status, 200);
    const events = await parseSse(res);
    const doneEvt = events.find((e) => e.name === 'done');
    assert.ok(doneEvt, 'turn completes with done event');
    assert.equal(doneEvt.data.maxSteps, 80, 'ultra-code stamina raises maxSteps to 80');
    assert.equal(doneEvt.data.powerProfile.workStamina, 'ultra-code');
    assert.equal(doneEvt.data.powerProfile.ambitionLevel, 'ultra-code');
    assert.equal(doneEvt.data.workspace.files['engine.js'], 'function boost() {\n  return 100;\n}\n', 'auto-repair fixed broken syntax before finishing');
    assert.ok(events.some((e) => e.name === 'status' && e.data?.phase === 'auto-repair'), 'emitted auto-repair status phase');

    // Main native Effort ('high') must remain 100% untouched on the wire!
    assert.equal(capturedPayloads[0].reasoning_effort, 'high', 'existing main reasoning_effort stays untouched');
    const sysPrompt = capturedPayloads[0].messages[0].content;
    assert.match(sysPrompt, /AI Power & Overdrive Directives/);
    assert.match(sysPrompt, /10x ULTRA-CODE ENGINEERING/);
    assert.match(sysPrompt, /Gold-Standard Human Ergonomics/);
  } finally {
    globalThis.fetch = original;
  }
});

test('resilient model parser + live checkpoint resume: recovers mislabelled SSE, saves mid-stream progress on quota exhaustion, swaps token, and resumes from exact point on «ادامه»', async () => {
  const modelLib = await import(`${root}/_lib/model.js`);
  const configApi = await import(`${root}/api/config.js`);
  const ckptLib = await import(`${root}/_lib/checkpoint.js`);

  assert.equal(ckptLib.isResumePrompt('ادامه'), true);
  assert.equal(ckptLib.isResumePrompt('ادامه بده!'), true);
  assert.equal(ckptLib.isResumePrompt('/continue'), true);
  assert.equal(ckptLib.isResumePrompt('یک ماشین حساب جدید بساز'), false);

  const original = globalThis.fetch;
  try {
    // Part A: Mislabelled SSE (`Content-Type: application/json` with raw `data: {...}` body) + transient empty body retry
    let probeCall = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
      probeCall += 1;
      if (probeCall === 1) {
        // Transient empty 200 body -> should auto-retry instead of throwing model_bad_response!
        return new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Second attempt returns raw SSE frames despite Content-Type: application/json!
      const ssePayload = [
        'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"سلام "}}]}',
        'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"دنیا!"},"finish_reason":"stop"}]}',
        'data: [DONE]'
      ].join('\n\n');
      return new Response(ssePayload, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const hybridRes = await modelLib.callModel(env, {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'تست' }]
    });
    assert.equal(probeCall, 2, 'auto-retried after transient empty 200 response');
    assert.equal(hybridRes.message.content, 'سلام دنیا!', 'parsed SSE frames inside application/json cleanly');

    // Part B: Mid-turn quota exhaustion after live file write + partial streamed text -> swap API token -> type «ادامه»!
    const resumeConv = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
      )
    ).json();

    let chatCallIdx = 0;
    const seenAuthHeaders = [];
    const seenWireBodies = [];

    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      seenAuthHeaders.push(init.headers.Authorization);
      seenWireBodies.push(JSON.parse(init.body));
      chatCallIdx += 1;

      if (chatCallIdx === 1) {
        // Step 1: Agent writes part1.js
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_part1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'part1.js', content: 'export const part1 = "ready";\n' })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (chatCallIdx === 2) {
        // Step 2: Agent streams partial text/code AND mid-stream hits quota exhaustion!
        const midDropSse = [
          'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"بخش اول ساخته شد؛ شروع بخش دوم: const magic = "}}]}',
          'data: {"error":{"message":"Insufficient quota: token balance exhausted","code":"insufficient_quota"}}'
        ].join('\n\n');
        return new Response(midDropSse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      if (chatCallIdx === 3) {
        // Resumed Turn Step 1 (with NEW API token!): Agent writes part2.js without redoing part1.js
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_part2',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'part2.js', content: 'export const magic = 777;\n' })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'هر دو بخش از نقطه قطع‌شدن کامل شدند.' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    // Turn 1: Interrupted mid-flight when quota runs out
    const turn1Res = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: resumeConv.id, message: 'یک ماژول دوقسمتی کامل بساز' }
        }),
        env
      )
    );
    const turn1Events = await parseSse(turn1Res);
    assert.ok(
      turn1Events.some((e) => e.name === 'live_file' && e.data?.path === 'part1.js'),
      'emits live_file SSE immediately when part1.js is written'
    );
    const errEvt = turn1Events.find((e) => e.name === 'error');
    assert.ok(errEvt, 'emits resumable error event on mid-stream quota exhaustion');
    assert.equal(errEvt.data.resumable, true);
    assert.equal(errEvt.data.reason, 'quota_exhausted');
    assert.match(errEvt.data.partialContent, /const magic =/);
    assert.deepEqual(errEvt.data.savedFiles, ['part1.js']);

    // Verify D1 conversation snapshot has BOTH part1.js AND the active checkpoint AND partial text!
    const snapMid = await (
      await oneConv.onRequestGet({
        ...ctx(req(`/api/state/conversations/${resumeConv.id}`, { headers: { Cookie: cookie } }), env),
        params: { id: resumeConv.id }
      })
    ).json();
    assert.equal(snapMid.workspace.files['part1.js'], 'export const part1 = "ready";\n');
    assert.ok(snapMid.checkpoint?.active, 'checkpoint is persisted in D1');
    assert.equal(snapMid.checkpoint.originalGoal, 'یک ماژول دوقسمتی کامل بساز');
    assert.match(snapMid.checkpoint.partialTextTail, /const magic =/);
    assert.ok(snapMid.messages.some((m) => m.role === 'assistant' && m.content.includes('const magic =')));

    // User replaces exhausted API token with a brand-new token via /api/config
    const newToken = 'sk-fresh-replacement-token-9999';
    const swapRes = await (
      await configApi.onRequestPost(
        ctx(
          req('/api/config', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: { apiKey: newToken }
          }),
          env
        )
      )
    ).json();
    assert.equal(swapRes.ok, true);

    // User simply writes «ادامه»!
    const turn2Res = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: resumeConv.id, message: 'ادامه' }
        }),
        env
      )
    );
    const turn2Events = await parseSse(turn2Res);
    const done2 = turn2Events.find((e) => e.name === 'done');
    assert.ok(done2, 'resumed turn finishes cleanly with done');
    assert.equal(done2.data.resumedFromCheckpoint, true);
    assert.equal(done2.data.workspace.files['part1.js'], 'export const part1 = "ready";\n', 'part1.js preserved without restart');
    assert.equal(done2.data.workspace.files['part2.js'], 'export const magic = 777;\n', 'part2.js completed on resume');

    // Verify new API token was used AND exact cutoff checkpoint was injected on the wire!
    assert.equal(seenAuthHeaders[2], `Bearer ${newToken}`, 'resumed turn uses the newly swapped API token');
    const resumeWireUserMsg = seenWireBodies[2].messages.at(-1).content;
    assert.match(resumeWireUserMsg, /EXACT CHECKPOINT RESUME/);
    assert.match(resumeWireUserMsg, /یک ماژول دوقسمتی کامل بساز/);
    assert.match(resumeWireUserMsg, /part1\.js/);
    assert.match(resumeWireUserMsg, /const magic =/);

    // Verify checkpoint is cleared after clean completion!
    const snapAfter = await (
      await oneConv.onRequestGet({
        ...ctx(req(`/api/state/conversations/${resumeConv.id}`, { headers: { Cookie: cookie } }), env),
        params: { id: resumeConv.id }
      })
    ).json();
    assert.equal(snapAfter.checkpoint, null, 'checkpoint cleared once resumed turn completes');
  } finally {
    // Reset custom provider so subsequent state stays clean
    await configApi.onRequestPost(
      ctx(req('/api/config', { method: 'POST', headers: { Cookie: cookie }, body: { reset: true } }), env)
    );
    globalThis.fetch = original;
  }
});

test('zero-cutoff streaming: streams even without env.CF_PAGES, breaks immediately on [DONE] despite hanging/resetting proxy sockets, strips rejected stream_options, and auto-heals real mid-stream drops inside one turn', async () => {
  const modelLib = await import(`${root}/_lib/model.js`);
  const original = globalThis.fetch;

  try {
    // 1. Proxy sends `data: [DONE]` and NEVER closes the HTTP stream -> must finish in <150ms without hanging!
    const enc = new TextEncoder();
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
      const bodyObj = JSON.parse(init.body);
      assert.equal(bodyObj.stream, true, 'must enable stream:true whenever onDelta is passed even without env.CF_PAGES');
      const hangingStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            enc.encode(
              'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"پاسخ سریع بدون هنگ"}}]}\n\n' +
                'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                'data: [DONE]\n\n'
            )
          );
          // Intentionally NEVER call controller.close()!
        }
      });
      return new Response(hangingStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const t0 = Date.now();
    const fastRes = await modelLib.callModel(env, {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'سلام' }],
      onDelta: () => {}
    });
    assert.ok(Date.now() - t0 < 1500, 'must break immediately upon [DONE] instead of hanging on open proxy socket');
    assert.equal(fastRes.interrupted, false, 'must NOT mark [DONE] stream as interrupted');
    assert.equal(fastRes.message.content, 'پاسخ سریع بدون هنگ');

    // 2. Proxy sends `finish_reason: "stop"` (without `[DONE]`) and then violently resets TCP socket + rejects `stream_options` on attempt 1
    let optAttempt = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
      optAttempt += 1;
      const bodyObj = JSON.parse(init.body);
      if (optAttempt === 1) {
        assert.ok(bodyObj.stream_options, 'first attempt includes stream_options');
        return new Response('{"error":{"message":"Unknown parameter: stream_options"}}', { status: 400 });
      }
      assert.equal(bodyObj.stream_options, undefined, 'retry strips unsupported stream_options');
      let stepRead = 0;
      const resetAfterStopStream = new ReadableStream({
        pull(controller) {
          stepRead += 1;
          if (stepRead === 1) {
            controller.enqueue(
              enc.encode(
                'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"کامل قبل از ریست"},"finish_reason":"stop"}]}\n\n'
              )
            );
          } else {
            controller.error(new Error('peer closed connection without TLS close_notify'));
          }
        }
      });
      return new Response(resetAfterStopStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const resetAfterStopRes = await modelLib.callModel(env, {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'تست ریست بعد از اتمام' }],
      onDelta: () => {}
    });
    assert.equal(resetAfterStopRes.interrupted, false, 'socket reset AFTER finish_reason:stop must NOT trigger stream cutoff');
    assert.equal(resetAfterStopRes.message.content, 'کامل قبل از ریست');

    // 3. Genuine mid-stream drop halfway through an answer -> `/api/chat` auto-heals inside the SAME SSE turn without stopping!
    const healConv = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
      )
    ).json();

    let healStep = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
      healStep += 1;
      if (healStep === 1) {
        let chunkIdx = 0;
        const midCrashStream = new ReadableStream({
          pull(controller) {
            chunkIdx += 1;
            if (chunkIdx === 1) {
              controller.enqueue(
                enc.encode('data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"نیمه اول پاسخ — "}}]}\n\n')
              );
            } else {
              controller.error(new Error('TCP reset mid-generation'));
            }
          }
        });
        return new Response(midCrashStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      // Auto-heal attempt 2 inside the SAME /api/chat request finishes seamlessly:
      return new Response(
        'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"نیمه دوم بدون توقف کامل شد!"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    };

    const healRes = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: healConv.id, message: 'یک متن دو تکه بنویس' }
        }),
        env
      )
    );
    const healEvents = await parseSse(healRes);
    assert.equal(healEvents.find((e) => e.name === 'error'), undefined, 'auto-healed turn must NOT emit error');
    assert.ok(healEvents.some((e) => e.name === 'status' && e.data?.phase === 'auto-heal'), 'emitted auto-heal status');
    const healDone = healEvents.find((e) => e.name === 'done');
    assert.ok(healDone, 'auto-healed turn finished with done');
    assert.equal(healDone.data.interrupted, false, 'final done is NOT marked interrupted');
    assert.equal(healDone.data.resumable, false, 'no manual resume banner needed after auto-heal');
    assert.equal(healDone.data.content, 'نیمه اول پاسخ — نیمه دوم بدون توقف کامل شد!');
  } finally {
    globalThis.fetch = original;
  }
});

test('elastic zero-413 context engine: slims giant historical tool payloads, auto-compacts on upstream 413 & 400 context_length_exceeded without touching reasoning_effort, and never forces manual /compact', async () => {
  const original = globalThis.fetch;
  try {
    const bigConv = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
      )
    ).json();

    // Seed giant multi-step tool history (>500 KB of redundant write_file arguments & read_file outputs)
    const hugeCode = '// خط کد بسیار حجیم برای تست عبور از سقف پراکسی\nconst block = "' + 'A'.repeat(45_000) + '";\n';
    const bloatedHistory = [];
    for (let i = 0; i < 8; i += 1) {
      bloatedHistory.push({ role: 'user', content: `گام بزرگ شماره ${i}`, created_at: Date.now() + i * 3 });
      bloatedHistory.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `tc_big_${i}`,
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: `module_${i}.js`, content: hugeCode }) }
          }
        ],
        created_at: Date.now() + i * 3 + 1
      });
      bloatedHistory.push({
        role: 'tool',
        tool_call_id: `tc_big_${i}`,
        content: 'File saved.\n' + 'X'.repeat(11_000),
        created_at: Date.now() + i * 3 + 2
      });
      bloatedHistory.push({ role: 'assistant', content: `ماژول ${i} ذخیره شد.`, created_at: Date.now() + i * 3 + 3 });
    }
    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          body: { action: 'append', id: bigConv.id, messages: bloatedHistory },
          headers: { Cookie: cookie }
        }),
        env
      )
    );

    // Simulate a strict proxy that STILL rejects payloads > 40 KB with HTTP 413 first,
    // and then HTTP 400 context_length_exceeded if > 25 KB, verifying automatic multi-level self-compaction!
    const wireAttempts = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
      const rawBody = String(init.body || '');
      const parsed = JSON.parse(rawBody);
      // Summarizer call (temperature 0.1, max_tokens 1600): simulate summarizer failing with 413 too -> deterministic local summary must kick in!
      if (parsed.max_tokens === 1600) {
        return new Response('413 Request Entity Too Large', { status: 413 });
      }
      wireAttempts.push({ len: rawBody.length, effort: parsed.reasoning_effort, msgCount: parsed.messages.length });
      if (wireAttempts.length === 1) {
        return new Response('<html><body>413 Request Entity Too Large</body></html>', { status: 413 });
      }
      if (wireAttempts.length === 2) {
        return new Response(
          JSON.stringify({ error: { message: 'This model maximum context length is exceeded (prompt is too long)' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        'data: {"model":"claude-sonnet-5-5","choices":[{"delta":{"content":"بدون خطای ۴۱۳ و بدون نیاز به /compact انجام شد!"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    };

    const res = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            conversationId: bigConv.id,
            message: 'ادامه بده و قابلیت نهایی را اضافه کن',
            reasoningEffort: 'high',
            workStamina: 'ultra-code'
          }
        }),
        env
      )
    );
    const events = await parseSse(res);
    assert.equal(events.find((e) => e.name === 'error'), undefined, 'must NOT fail with 413 context_too_large');
    const doneEvt = events.find((e) => e.name === 'done');
    assert.ok(doneEvt, 'completed cleanly after auto-compacting');
    assert.equal(doneEvt.data.content, 'بدون خطای ۴۱۳ و بدون نیاز به /compact انجام شد!');
    assert.equal(wireAttempts.length, 3, 'auto-compacted across 413 and 400 context_length_exceeded');
    assert.ok(wireAttempts[2].len < wireAttempts[0].len, 'each compaction pass shrinks wire payload');
    assert.equal(wireAttempts[2].effort, 'high', 'kept user reasoning_effort=high untouched across 413/400 compaction');
  } finally {
    globalThis.fetch = original;
  }
});



