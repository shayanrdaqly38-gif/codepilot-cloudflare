import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_TOKEN_SAVER_MODES,
  buildSmartFileRead,
  buildPatchFailureContext,
  pruneInTurnWireMessages,
  extractMentionedFileContext,
  resolveAdaptiveStepEffort,
  applyPromptCacheBreakpoints
} from '../functions/_lib/token-optimizer.js';
import { normalizeAgentConfig } from '../functions/_lib/provider.js';
import { buildWorkingContext, buildSystemPrompt, currentClockLine } from '../functions/_lib/memory.js';
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

test('normalizeAgentConfig defaults tokenSaver safely to max and validates allowed modes', () => {
  assert.deepEqual(VALID_TOKEN_SAVER_MODES, ['off', 'balanced', 'max']);
  assert.equal(normalizeAgentConfig({}).tokenSaver, 'max');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'invalid' }).tokenSaver, 'max');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'balanced' }).tokenSaver, 'balanced');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'off' }).tokenSaver, 'off');
});

test('buildSmartFileRead returns full content for small files and Structural Landmark Map for huge files', () => {
  const small = ['const a = 1;', 'export function greet() {', '  return a;', '}'].join('\n');
  const smallRes = buildSmartFileRead('src/small.js', small, { tokenSaver: 'max' });
  assert.equal(smallRes.mode, 'full');
  assert.equal(smallRes.text, small);

  const large = generateSyntheticSourceFile(800);
  const largeRes = buildSmartFileRead('src/huge.js', large, { tokenSaver: 'max' });
  assert.equal(largeRes.mode, 'outline');
  assert.match(largeRes.text, /Structural Landmarks Across Entire File/);
  assert.match(largeRes.text, /handlerSection1/);
  assert.match(largeRes.text, /handlerSection10/);
  assert.ok(
    largeRes.savedChars > large.length * 0.65,
    `Expected >65% char reduction on 800-line unwindowed read, got savedChars=${largeRes.savedChars} / ${large.length}`
  );

  // Explicit slice returns exact requested lines with line numbers
  const sliceRes = buildSmartFileRead('src/huge.js', large, {
    startLine: 250,
    endLine: 265,
    tokenSaver: 'max'
  });
  assert.equal(sliceRes.mode, 'ranged');
  assert.match(sliceRes.text, /handlerSection6/);
  assert.doesNotMatch(sliceRes.text, /handlerSection1\(/);
});

test('buildPatchFailureContext locates fuzzy anchor and emits exact numbered lines for 1-shot patch recovery', () => {
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
  assert.match(ctxText, /for \(const item of items\) \{/);
  assert.match(ctxText, /subtotal \+= item\.price \* item\.qty;/);
});

test('pruneInTurnWireMessages invalidates stale read_file snapshots after edits and deduplicates repeated reads', () => {
  const bigSnapshot = `[src/app.js · lines 1-200 of 200]\n${generateSyntheticSourceFile(200)}`;
  const wireMessages = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'Fix handlerSection1 in src/app.js' },
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
          id: 'tc_patch_1',
          type: 'function',
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({ path: 'src/app.js', edits: [{ search: 'a', replace: 'b' }] })
          }
        }
      ]
    },
    { role: 'tool', tool_call_id: 'tc_patch_1', content: 'Patched src/app.js (+1 / -1 lines).' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_list', type: 'function', function: { name: 'list_files', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'tc_list', content: 'src/app.js (8200 chars)' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tc_list_2', type: 'function', function: { name: 'list_symbols', arguments: '{"path":"src/app.js"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'tc_list_2', content: 'handlerSection1' }
  ];

  const pruned = pruneInTurnWireMessages(wireMessages, { tokenSaver: 'max' });
  assert.ok(pruned.savedChars > 4000, `Expected massive char savings from stale read invalidation, got ${pruned.savedChars}`);
  assert.match(pruned.messages[3].content, /Stale read_file\(src\/app\.js\) superseded/i);
});

test('extractMentionedFileContext pre-pins @filepath and @filepath:start-end slices cleanly', () => {
  const files = {
    'src/utils.js': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n',
    'src/large.js': generateSyntheticSourceFile(300)
  };
  const pinned = extractMentionedFileContext(
    'Please check @src/utils.js and lines @src/large.js:100-112 for the bug',
    files,
    { tokenSaver: 'max' }
  );
  assert.deepEqual(pinned.paths, ['src/utils.js', 'src/large.js']);
  assert.match(pinned.block, /<referenced_file path="src\/utils\.js">/);
  assert.match(pinned.block, /export const add/);
  assert.match(pinned.block, /handlerSection3/);
});

test('resolveAdaptiveStepEffort preserves 100% power on Step 1 & errors while stepping down trivial/closing steps', () => {
  assert.equal(
    resolveAdaptiveStepEffort({ baseEffort: 'xhigh', step: 1, tokenSaver: 'max' }),
    'xhigh'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'xhigh',
      step: 4,
      tokenSaver: 'max',
      lastStepInfo: { hadError: true, onlyListing: false }
    }),
    'xhigh'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'high',
      step: 3,
      tokenSaver: 'max',
      isAutoRepair: true,
      lastStepInfo: { onlyListing: true }
    }),
    'high'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'xhigh',
      step: 2,
      tokenSaver: 'max',
      lastStepInfo: { onlyListing: true, hadError: false, hadValidationError: false }
    }),
    'low'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'xhigh',
      step: 3,
      tokenSaver: 'max',
      lastStepInfo: { justVerifiedClean: true, hadError: false, hadValidationError: false }
    }),
    'low'
  );
  assert.equal(
    resolveAdaptiveStepEffort({
      baseEffort: 'xhigh',
      step: 2,
      tokenSaver: 'off',
      lastStepInfo: { onlyListing: true }
    }),
    'xhigh'
  );
});

test('applyPromptCacheBreakpoints & callModel inject OpenRouter cache_control, parse cached_tokens, and auto-fallback on 400', async () => {
  const untouched = applyPromptCacheBreakpoints(
    [{ role: 'system', content: 'Sys prompt '.repeat(60) }, { role: 'user', content: 'Hi' }],
    [{ type: 'function', function: { name: 'think', description: 'plan' } }],
    { baseUrl: 'https://api.tooken.club/v1', model: 'claude-sonnet-5-5', tokenSaver: 'max' }
  );
  assert.equal(untouched.injected, false);
  assert.equal(typeof untouched.messages[0].content, 'string');

  let callCount = 0;
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      callCount += 1;
      const body = JSON.parse(init.body);
      if (callCount === 1) {
        assert.ok(Array.isArray(body.messages[0].content));
        assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' });
        assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral' });
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Cached hello!' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 4200,
              completion_tokens: 45,
              total_tokens: 4245,
              prompt_tokens_details: { cached_tokens: 3900 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (callCount === 2) {
        assert.ok(Array.isArray(body.messages[0].content));
        return new Response(
          JSON.stringify({ error: { message: 'Unknown field cache_control in message content' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      assert.equal(typeof body.messages[0].content, 'string');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Fallback ok!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const env = {
      MODEL_BASE_URL: 'https://openrouter.ai/api/v1',
      MODEL_API_KEY: 'sk-or-test',
      _agentConfig: { tokenSaver: 'max' }
    };
    const res1 = await callModel(env, {
      model: 'anthropic/claude-sonnet-4',
      messages: [
        { role: 'system', content: 'Long stable system prompt '.repeat(80) },
        { role: 'user', content: 'Hello' }
      ],
      tools: [{ type: 'function', function: { name: 'think', description: 'plan' } }]
    });
    assert.equal(res1.message.content, 'Cached hello!');
    assert.equal(res1.usage.cached_tokens, 3900);

    const res2 = await callModel(env, {
      model: 'anthropic/claude-sonnet-4',
      messages: [
        { role: 'system', content: 'Long stable system prompt '.repeat(80) },
        { role: 'user', content: 'Fallback check' }
      ],
      tools: [{ type: 'function', function: { name: 'think', description: 'plan' } }]
    });
    assert.equal(res2.message.content, 'Fallback ok!');
    assert.equal(callCount, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('buildSystemPrompt is 100% byte-identical across shuffled workspace keys within the same day for prefix cache hits', () => {
  const wsA = { files: { 'z.js': '1', 'a.js': '2', 'm/index.js': '3' }, active: 'a.js' };
  const wsB = { files: { 'm/index.js': '3', 'z.js': '1', 'a.js': '2' }, active: 'a.js' };
  const pA = buildSystemPrompt({ workspace: wsA, memories: [] });
  const pB = buildSystemPrompt({ workspace: wsB, memories: [] });
  assert.equal(pA, pB);
  assert.doesNotMatch(currentClockLine(), /\d{2}:\d{2}:\d{2}/);
});

test('buildWorkingContext uses Cloudflare Workers AI for zero-API-token rolling summarization when env.AI is bound', async () => {
  let workersAiCalled = 0;
  let paidModelCalled = 0;
  fakeJwks(sharedKeys);
  const baseEnv = makeEnv(sharedKeys);
  const origFetch = globalThis.fetch;

  try {
    const authRes = await authApi.onRequestGet(
      ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), baseEnv)
    );
    const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
    const created = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), baseEnv)
      )
    ).json();

    globalThis.fetch = async () => {
      paidModelCalled += 1;
      throw new Error('Paid API should NOT be called when Workers AI succeeds');
    };

    const env = {
      ...baseEnv,
      CONTEXT_BUDGET_TOKENS: '1500',
      _agentConfig: { tokenSaver: 'max' },
      AI: {
        async run(modelName) {
          workersAiCalled += 1;
          assert.equal(modelName, '@cf/meta/llama-3.1-8b-instruct');
          return {
            response: JSON.stringify({
              summary: 'Refactored auth module and verified all JWT routes.',
              memo: [{ scope: 'project', key: 'auth_token', value: 'Use Ed25519 tokens' }]
            })
          };
        }
      }
    };

    const messages = [];
    for (let i = 0; i < 20; i += 1) {
      messages.push({
        seq: i + 1,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${i}: ${'Detailed engineering discussion and code changes '.repeat(35)}`
      });
    }

    const result = await buildWorkingContext({
      env,
      conversation: { id: created.id, owner: 'dev@example.com', summary: '', summary_until: 0 },
      messages,
      callModel: async () => {
        paidModelCalled += 1;
        throw new Error('Should not call paid model');
      }
    });

    assert.equal(workersAiCalled, 1);
    assert.equal(paidModelCalled, 0);
    assert.match(result.summary, /Refactored auth module/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('End-to-end /api/chat Hyper-Efficiency loop: @mention pre-pin + smart read + 1-shot patch recovery + adaptive effort + turnTokens telemetry', async () => {
  fakeJwks(sharedKeys);
  const env = makeEnv(sharedKeys);
  const origFetch = globalThis.fetch;

  try {
    const authRes = await authApi.onRequestGet(
      ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), env)
    );
    const cookie = authRes.headers.get('Set-Cookie').split(';')[0];

    const created = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create', title: 'Eco Benchmark' }, headers: { Cookie: cookie } }), env)
      )
    ).json();

    const hugeFile = generateSyntheticSourceFile(650);
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
              files: {
                'src/huge.js': hugeFile,
                'src/pricing.js': targetFile
              },
              active: 'src/pricing.js'
            }
          }
        }),
        env
      )
    );

    const jwksFetch = globalThis.fetch;
    let stepNum = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
      stepNum += 1;
      const payload = JSON.parse(init.body);

      if (stepNum === 1) {
        const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
        assert.match(lastUser.content, /<referenced_file path="src\/pricing\.js">/);
        assert.match(lastUser.content, /computeDiscount/);

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_read_huge',
                      type: 'function',
                      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/huge.js' }) }
                    },
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
              prompt_tokens: 1800,
              completion_tokens: 90,
              total_tokens: 1890,
              prompt_tokens_details: { cached_tokens: 1450 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (stepNum === 2) {
        // Step 2 preserves full reasoning_effort='high' because Step 1 had a patch failure!
        assert.equal(payload.reasoning_effort, 'high');
        const hugeReadMsg = payload.messages.find((m) => m.tool_call_id === 'call_read_huge');
        assert.match(hugeReadMsg.content, /Smart Structural Map of src\/huge\.js/);
        const patchToolMsg = payload.messages.find((m) => m.tool_call_id === 'call_bad_patch');
        assert.match(patchToolMsg.content, /Auto-Context Recovery/);
        assert.match(patchToolMsg.content, /price \* 0\.8;/);

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
              prompt_tokens: 2100,
              completion_tokens: 75,
              total_tokens: 2175,
              prompt_tokens_details: { cached_tokens: 1750 }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Step 3: Clean edit verified -> adaptive effort steps down cleanly for closing summary!
      assert.equal(payload.reasoning_effort, 'low');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'Updated gold discount to 25% off cleanly.' },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 2150,
            completion_tokens: 30,
            total_tokens: 2180,
            prompt_tokens_details: { cached_tokens: 1980 }
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
            message: 'Update gold tier discount in @src/pricing.js and inspect src/huge.js',
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
    assert.ok(doneEvt, 'Expected SSE done event');
    assert.equal(doneEvt.data.turnTokens.cachedTokens, 1450 + 1750 + 1980);
    assert.ok(
      doneEvt.data.turnTokens.savedTokensEstimate > 4500,
      `Expected >4500 saved tokens estimate, got ${doneEvt.data.turnTokens.savedTokensEstimate}`
    );
    assert.ok(
      doneEvt.data.turnTokens.savingsPercent >= 40,
      `Expected >=40% explicit savedTokensEstimate percent, got ${doneEvt.data.turnTokens.savingsPercent}%`
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
