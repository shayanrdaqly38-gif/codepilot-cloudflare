import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_TOKEN_SAVER_MODES,
  isCacheDiscountedEndpoint,
  buildSmartFileRead,
  buildPatchFailureContext,
  pruneInTurnWireMessages,
  resolveAdaptiveStepEffort,
  applyPromptCacheBreakpoints
} from '../functions/_lib/token-optimizer.js';
import { normalizeAgentConfig } from '../functions/_lib/provider.js';
import { buildWorkingContext, buildSystemPrompt } from '../functions/_lib/memory.js';
import { callModel } from '../functions/_lib/model.js';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';
import * as authApi from '../functions/api/auth.js';
import * as stateApi from '../functions/api/state/index.js';
import * as chatApi from '../functions/api/chat.js';

const sharedKeys = rsaKeys();
fakeJwks(sharedKeys);

async function parseSse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const name = /event: (.*)/.exec(block)?.[1];
    const data = /data: (.*)/.exec(block)?.[1];
    if (name && data) events.push({ event: name, data: JSON.parse(data) });
  }
  return events;
}

function generateSyntheticSourceFile(lineCount = 700) {
  const lines = [];
  for (let i = 1; i <= lineCount; i += 1) {
    if (i % 50 === 1) {
      lines.push(`export async function handlerSection${Math.ceil(i / 50)}(req, ctx) {`);
    } else if (i % 50 === 0) {
      lines.push('  return { ok: true };\n}');
    } else {
      lines.push(`  const computedValue_${i} = Number(req?.value || 0) + ${i}; // processing step ${i}`);
    }
  }
  return lines.join('\n');
}

test('normalizeAgentConfig & isCacheDiscountedEndpoint classify openrouter.ai vs zro.moonmath.ai & tooken.club', () => {
  assert.deepEqual(VALID_TOKEN_SAVER_MODES, ['off', 'balanced', 'max']);
  assert.equal(normalizeAgentConfig({}).tokenSaver, 'max');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'invalid' }).tokenSaver, 'max');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'balanced' }).tokenSaver, 'balanced');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'off' }).tokenSaver, 'off');

  assert.equal(isCacheDiscountedEndpoint('https://openrouter.ai/api/v1'), true);
  assert.equal(isCacheDiscountedEndpoint('https://api.anthropic.com/v1'), true);
  assert.equal(isCacheDiscountedEndpoint('https://api.openai.com/v1'), true);
  assert.equal(isCacheDiscountedEndpoint('https://zro.moonmath.ai/v1'), false);
  assert.equal(isCacheDiscountedEndpoint('https://api.tooken.club/v1'), false);
});

test('Compressed TOOLS schema & buildSystemPrompt cut fixed per-step wire overhead dramatically', () => {
  const toolsJson = JSON.stringify(chatApi.TOOLS);
  assert.equal(chatApi.TOOLS.length, 14);
  assert.ok(toolsJson.length < 4200, `Expected TOOLS JSON < 4200 chars (down from 5424), got ${toolsJson.length}`);
  const readTool = chatApi.TOOLS.find((t) => t.function.name === 'read_file');
  assert.ok(readTool.function.parameters.properties.query, 'read_file must support query jump');

  const sys = buildSystemPrompt({
    files: { 'src/app.js': 'const a = 1;\n', 'index.html': '<h1>Hi</h1>\n' },
    activeFile: 'src/app.js'
  });
  assert.ok(sys.length > 300 && sys.length < 1350, `Expected compact system prompt < 1350 chars, got ${sys.length}`);
});

test('buildSmartFileRead supports 15KB full read, 1-shot query jump, and tab-free landmark slices', () => {
  const medium12k = generateSyntheticSourceFile(175);
  assert.ok(medium12k.length > 9_000 && medium12k.length < 15_000);
  const medRes = buildSmartFileRead('src/medium.js', medium12k, { tokenSaver: 'max' });
  assert.equal(medRes.mode, 'full');
  assert.equal(medRes.text, medium12k);

  const huge55k = generateSyntheticSourceFile(800);
  assert.ok(huge55k.length > 45_000);
  const largeRes = buildSmartFileRead('src/huge.js', huge55k, { tokenSaver: 'max' });
  assert.equal(largeRes.mode, 'outline');
  assert.match(largeRes.text, /Structural Landmarks Across Entire File/);
  assert.doesNotMatch(largeRes.text, /^\d+\t/m, 'Must NEVER prepend lineNum+tab to code lines');

  // Direct 1-call query jump into middle of 55KB file!
  const queryRes = buildSmartFileRead('src/huge.js', huge55k, {
    query: 'handlerSection10',
    tokenSaver: 'max'
  });
  assert.equal(queryRes.mode, 'query');
  assert.match(queryRes.text, /^export async function handlerSection10/m);
  assert.doesNotMatch(queryRes.text, /^\d+\t/m);
  assert.ok(queryRes.savedChars > 35_000);
});

test('buildPatchFailureContext returns clean copy-paste-exact lines with zero tab prefixes', () => {
  const content = [
    'import { readConfig } from "./cfg.js";',
    '',
    'export function calculateTotal(items, taxRate = 0.09) {',
    '  let subtotal = 0;',
    '  for (const item of items) {',
    '    subtotal += item.price * item.qty;',
    '  }',
    '  const tax = subtotal * taxRate;',
    '  return Math.round((subtotal + tax) * 100) / 100;',
    '}'
  ].join('\n');

  const ctxText = buildPatchFailureContext(
    'src/billing.js',
    content,
    [{ search: '  for (const item of items) {\n    subtotal += item.cost * item.qty;\n  }', replace: '' }],
    'Search block not found'
  );

  assert.match(ctxText, /Auto-Context Recovery/);
  assert.match(ctxText, /^ {4}subtotal \+= item\.price \* item\.qty;$/m);
  assert.doesNotMatch(ctxText, /^\d+\t/m);
});

test('resolveAdaptiveStepEffort steps down greetings on Step 1 & clean Step 2+ while keeping full Step 1 coding power', () => {
  const levels = ['low', 'medium', 'high'];
  assert.equal(
    resolveAdaptiveStepEffort({ baseEffort: 'high', step: 1, userText: 'سلام خوبی؟', tokenSaver: 'max', supportedLevels: levels }),
    'low'
  );
  assert.equal(
    resolveAdaptiveStepEffort({ baseEffort: 'high', step: 1, userText: 'موتور بازی را بساز', tokenSaver: 'max', supportedLevels: levels }),
    'high'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'high',
      step: 2,
      userText: 'موتور بازی را بساز',
      lastStepInfo: { hadError: false, justVerifiedClean: false },
      tokenSaver: 'max',
      supportedLevels: levels
    }),
    'medium'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'high',
      step: 2,
      userText: 'موتور بازی را بساز',
      lastStepInfo: { hadError: true },
      tokenSaver: 'max',
      supportedLevels: levels
    }),
    'high'
  );
});

test('pruneInTurnWireMessages: aggressive compaction on zro.moonmath.ai vs prefix-safe post-anchor giant-write stripping on openrouter.ai', () => {
  const bigSnapshot = `[src/app.js · lines 1-200 of 200]\n${generateSyntheticSourceFile(200)}`;
  const giantWriteContent = generateSyntheticSourceFile(220);
  const wireMessages = [
    { role: 'user', content: 'Rewrite src/app.js' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_read_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'tc_read_1', content: bigSnapshot },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'tc_write_1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/app.js', content: giantWriteContent })
          }
        }
      ]
    },
    { role: 'tool', tool_call_id: 'tc_write_1', content: 'Wrote src/app.js (15200 chars, 220 lines). Validation: OK.' }
  ];

  // On zro.moonmath.ai (cacheDiscounted: false): strips both giant write_file args AND stale pre-edit read_file!
  const moonmath = pruneInTurnWireMessages(wireMessages, { tokenSaver: 'max', cacheDiscounted: false });
  assert.ok(moonmath.savedChars > 24_000);
  assert.match(moonmath.messages[2].content, /Stale read_file\(src\/app\.js\) superseded/i);
  assert.match(moonmath.messages[3].tool_calls[0].function.arguments, /"_persisted":true/);

  // On openrouter.ai (cacheDiscounted: true): keeps user prefix 100% untouched AND strips giant post-anchor uncached write_file + >4.5KB stale read!
  const openrouter = pruneInTurnWireMessages(wireMessages, { tokenSaver: 'max', cacheDiscounted: true });
  assert.equal(openrouter.messages[0].content, 'Rewrite src/app.js');
  assert.match(openrouter.messages[3].tool_calls[0].function.arguments, /"_persisted":true/);
  assert.match(openrouter.messages[2].content, /Stale read_file\(src\/app\.js\) superseded/i);
});

test('applyPromptCacheBreakpoints keeps cache_control anchored on FIXED user index across Steps 1..N & prevents 2x reasoning token double-count', async () => {
  const sys = 'Long stable system prompt '.repeat(80);
  const step1Msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Current turn user goal' }
  ];
  const step2Msgs = [
    ...step1Msgs,
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'app.js' }
  ];
  const step3Msgs = [
    ...step2Msgs,
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"app.js"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'const x = 1;' }
  ];

  const tools = [{ type: 'function', function: { name: 'list_files', description: 'list' } }];
  const w1 = applyPromptCacheBreakpoints(step1Msgs, tools, { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' });
  const w2 = applyPromptCacheBreakpoints(step2Msgs, tools, { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' });
  const w3 = applyPromptCacheBreakpoints(step3Msgs, tools, { baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4' });

  assert.equal(JSON.stringify(w1.messages.slice(0, 4)), JSON.stringify(w2.messages.slice(0, 4)));
  assert.equal(JSON.stringify(w2.messages.slice(0, 4)), JSON.stringify(w3.messages.slice(0, 4)));

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Done!' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 2200,
            total_tokens: 5200,
            prompt_tokens_details: { cached_tokens: 2700 },
            completion_tokens_details: { reasoning_tokens: 1800 }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const res = await callModel(
      { MODEL_BASE_URL: 'https://openrouter.ai/api/v1', MODEL_API_KEY: 'sk-or-test' },
      { model: 'anthropic/claude-sonnet-4', messages: step1Msgs, tools }
    );
    assert.equal(res.usage.prompt_tokens, 3000);
    assert.equal(res.usage.completion_tokens, 400);
    assert.equal(res.usage.reasoning_tokens, 1800);
    assert.equal(res.usage.prompt_tokens + res.usage.completion_tokens + res.usage.reasoning_tokens, 5200);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('buildWorkingContext slims completed past-turn giant tool payloads on fresh user turns', async () => {
  fakeJwks(sharedKeys);
  const env = { ...makeEnv(sharedKeys), _agentConfig: { tokenSaver: 'max' } };
  const authRes = await authApi.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), env)
  );
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
  const created = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
    )
  ).json();

  const giantWriteArgs = JSON.stringify({ path: 'big.js', content: 'const x = 1;\n'.repeat(1500) });
  const giantReadOutput = 'line of file\n'.repeat(1200);
  const messages = [
    { seq: 1, role: 'user', content: 'Build big.js' },
    {
      seq: 2,
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'write_file', arguments: giantWriteArgs } }]
    },
    { seq: 3, role: 'tool', tool_call_id: 'tc1', content: giantReadOutput },
    { seq: 4, role: 'assistant', content: 'big.js created.' },
    { seq: 5, role: 'user', content: 'Now change button color' }
  ];

  const ctxOut = await buildWorkingContext({
    env,
    conversation: { id: created.id, owner: 'dev@example.com', summary: '', summary_until: 0 },
    messages,
    callModel: async () => ({ content: '' })
  });

  const serializedRecent = JSON.stringify(ctxOut.recent);
  assert.ok(serializedRecent.length < 1800, `Expected slimmed history < 1.8KB, got ${serializedRecent.length}`);
});

test('End-to-end /api/chat Hyper-Eco v3 on OpenRouter + zro.moonmath.ai: prefix stability, in-turn write stripping, 1-shot patch recovery & exact turnTokens', async () => {
  fakeJwks(sharedKeys);
  const env = makeEnv(sharedKeys, { MODEL_BASE_URL: 'https://openrouter.ai/api/v1' });
  const origFetch = globalThis.fetch;

  try {
    const authRes = await authApi.onRequestGet(
      ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), env)
    );
    const cookie = authRes.headers.get('Set-Cookie').split(';')[0];

    const created = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create', title: 'Eco v3' }, headers: { Cookie: cookie } }), env)
      )
    ).json();

    const targetFile = [
      'export function computeDiscount(price, tier) {',
      '  if (tier === "gold") return price * 0.8;',
      '  return price;',
      '}'
    ].join('\n');

    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            action: 'workspace',
            id: created.id,
            workspace: {
              files: { 'src/pricing.js': targetFile },
              active: 'src/pricing.js'
            }
          }
        }),
        env
      )
    );

    const jwksFetch = globalThis.fetch;
    const wireSnapshots = [];
    let stepNum = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
      stepNum += 1;
      const payload = JSON.parse(init.body);
      wireSnapshots.push(payload.messages);

      if (stepNum === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_bad_patch',
                      type: 'function',
                      function: {
                        name: 'apply_patch',
                        arguments: JSON.stringify({
                          path: 'src/pricing.js',
                          edits: [
                            {
                              search: '  if (tier === "gold") return price * 0.85;',
                              replace: '  if (tier === "gold") return price * 0.75;'
                            }
                          ]
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 400,
              total_tokens: 1600,
              prompt_tokens_details: { cached_tokens: 1000 },
              completion_tokens_details: { reasoning_tokens: 320 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (stepNum === 2) {
        assert.equal(JSON.stringify(wireSnapshots[0]), JSON.stringify(payload.messages.slice(0, wireSnapshots[0].length)));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_good_patch',
                      type: 'function',
                      function: {
                        name: 'apply_patch',
                        arguments: JSON.stringify({
                          path: 'src/pricing.js',
                          edits: [
                            {
                              search: '  if (tier === "gold") return price * 0.8;',
                              replace: '  if (tier === "gold") return price * 0.75;'
                            }
                          ]
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: {
              prompt_tokens: 1350,
              completion_tokens: 300,
              total_tokens: 1650,
              prompt_tokens_details: { cached_tokens: 1200 },
              completion_tokens_details: { reasoning_tokens: 220 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      assert.equal(JSON.stringify(wireSnapshots[1]), JSON.stringify(payload.messages.slice(0, wireSnapshots[1].length)));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'تخفیف طلایی به ۲۵٪ تغییر یافت.' },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 1400,
            completion_tokens: 80,
            total_tokens: 1480,
            prompt_tokens_details: { cached_tokens: 1350 },
            completion_tokens_details: { reasoning_tokens: 30 }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            conversationId: created.id,
            message: 'تخفیف طلایی را در @src/pricing.js به ۲۵٪ تغییر بده',
            reasoningEffort: 'high',
            tokenSaver: 'max'
          }
        }),
        env
      )
    );
    assert.equal(res.status, 200);
    const events = await parseSse(res);
    const doneEvt = events.find((e) => e.event === 'done');
    assert.ok(doneEvt);
    assert.equal(doneEvt.data.turnTokens.totalTokens, 4730);
    assert.equal(doneEvt.data.turnTokens.cachedTokens, 3550);
    assert.ok(doneEvt.data.turnTokens.effectiveBilledTokens < 1800);
  } finally {
    globalThis.fetch = origFetch;
  }
});
