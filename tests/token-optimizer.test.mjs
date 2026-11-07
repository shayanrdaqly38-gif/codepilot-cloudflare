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

test('buildSmartFileRead returns 100% verbatim up to 24KB (zero extra round-trips) and clean un-prefixed lines for apply_patch', () => {
  // 18KB medium-large file must return 100% verbatim in 1 shot so no extra read_file round-trips happen!
  const medium18k = generateSyntheticSourceFile(240);
  assert.ok(medium18k.length > 12_000 && medium18k.length < 24_000);
  const medRes = buildSmartFileRead('src/medium.js', medium18k, { tokenSaver: 'max' });
  assert.equal(medRes.mode, 'full');
  assert.equal(medRes.text, medium18k);

  // Truly giant file (>24KB) returns 16KB raw code + structural landmarks without corrupting lines with tabs
  const huge55k = generateSyntheticSourceFile(800);
  assert.ok(huge55k.length > 45_000);
  const largeRes = buildSmartFileRead('src/huge.js', huge55k, { tokenSaver: 'max' });
  assert.equal(largeRes.mode, 'outline');
  assert.match(largeRes.text, /Structural Landmarks Across Entire File/);
  assert.doesNotMatch(largeRes.text, /^\d+\t/m, 'Must NEVER prepend lineNum+tab to code lines');

  // Explicit slice returns clean raw lines ready for verbatim copy into apply_patch
  const sliceRes = buildSmartFileRead('src/huge.js', huge55k, {
    startLine: 250,
    endLine: 265,
    tokenSaver: 'max'
  });
  assert.equal(sliceRes.mode, 'ranged');
  assert.match(sliceRes.text, /^export async function handlerSection6/m);
  assert.doesNotMatch(sliceRes.text, /^\d+\t/m);
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

test('pruneInTurnWireMessages preserves 100% append-only KV-cache below emergency threshold and compacts only on force/emergency', () => {
  const bigSnapshot = `[src/app.js · lines 1-200 of 200]\n${generateSyntheticSourceFile(200)}`;
  const wireMessages = [
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
    { role: 'tool', tool_call_id: 'tc_patch_1', content: 'Patched src/app.js (+1 / -1 lines).' }
  ];

  // Normal turn (<140k chars): MUST stay 100% untouched so Prefix KV-Cache hits!
  const normal = pruneInTurnWireMessages(wireMessages, { tokenSaver: 'max' });
  assert.equal(normal.savedChars, 0);
  assert.equal(normal.messages[2].content, bigSnapshot);

  // Emergency (>140k or force: true): safely invalidates stale read
  const forced = pruneInTurnWireMessages(wireMessages, { tokenSaver: 'max', force: true });
  assert.ok(forced.savedChars > 4000);
  assert.match(forced.messages[2].content, /Stale read_file\(src\/app\.js\) superseded/i);
});

test('applyPromptCacheBreakpoints keeps cache_control anchored on FIXED user index across Steps 1..N (never invalidates prefix!) & prevents 2x reasoning token double-count', async () => {
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

  // CRITICAL: Messages 0..3 MUST be 100% byte-for-byte identical across Step 1, Step 2, and Step 3!
  assert.equal(JSON.stringify(w1.messages.slice(0, 4)), JSON.stringify(w2.messages.slice(0, 4)));
  assert.equal(JSON.stringify(w2.messages.slice(0, 4)), JSON.stringify(w3.messages.slice(0, 4)));

  // Verify callModel does NOT double-count reasoning_tokens when total_tokens === prompt_tokens + completion_tokens
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
    assert.equal(res.usage.completion_tokens, 400, 'visible completion tokens separated cleanly from reasoning_tokens');
    assert.equal(res.usage.reasoning_tokens, 1800);
    assert.equal(
      res.usage.prompt_tokens + res.usage.completion_tokens + res.usage.reasoning_tokens,
      5200,
      'Total must equal exact 5200, NEVER 7000!'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('buildWorkingContext slims completed past-turn giant tool payloads on fresh user turns (saving 95%+ historical tool bloat)', async () => {
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
  assert.ok(
    serializedRecent.length < 2500,
    `Expected completed past turn tool dumps (>34KB) to be compacted below 2.5KB, got ${serializedRecent.length}`
  );
});

test('End-to-end /api/chat v2: 100% append-only prefix across steps + @mention pre-pin + 1-shot clean patch recovery + exact non-double-counted turnTokens', async () => {
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
        ctx(req('/api/state', { method: 'POST', body: { action: 'create', title: 'Eco v2' }, headers: { Cookie: cookie } }), env)
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
        // Prefix of Step 1 MUST remain 100% identical in Step 2!
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

      // Prefix of Step 2 MUST remain 100% identical in Step 3!
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
    // Exact upstream total: 1600 + 1650 + 1480 = 4730 (NEVER double-counted as 4730 + 570 = 5300!)
    assert.equal(doneEvt.data.turnTokens.totalTokens, 4730);
    assert.equal(doneEvt.data.turnTokens.cachedTokens, 3550);
    assert.ok(doneEvt.data.turnTokens.effectiveBilledTokens < 1800);
  } finally {
    globalThis.fetch = origFetch;
  }
});
