import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_TOKEN_SAVER_MODES,
  isCacheDiscountedEndpoint,
  isRpdLimitedTurn,
  buildRequestSaverWorkspacePack,
  buildSmartFileRead,
  buildPatchFailureContext,
  pruneInTurnWireMessages,
  resolveAdaptiveStepEffort,
  applyPromptCacheBreakpoints
} from '../functions/_lib/token-optimizer.js';
import { normalizeAgentConfig, saveUserProviderConfig, resolveEffectiveEnv } from '../functions/_lib/provider.js';
import { buildWorkingContext, buildSystemPrompt } from '../functions/_lib/memory.js';
import { callModel, parseProviderModelItem } from '../functions/_lib/model.js';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';
import * as authApi from '../functions/api/auth.js';
import * as configApi from '../functions/api/config.js';
import * as modelsApi from '../functions/api/models.js';
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
  assert.deepEqual(VALID_TOKEN_SAVER_MODES, ['off', 'balanced', 'max', 'rpd']);
  assert.equal(normalizeAgentConfig({}).tokenSaver, 'max');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'invalid' }).tokenSaver, 'max');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'balanced' }).tokenSaver, 'balanced');
  assert.equal(normalizeAgentConfig({ tokenSaver: 'rpd' }).tokenSaver, 'rpd');
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

test('OpenRouter 50-Req/Day Suite: 0-probe metadata, 1-shot fast-finish edit, multi-key pool rotation, and seamless failover to zro.moonmath.ai', async () => {
  fakeJwks(sharedKeys);
  const env = makeEnv(sharedKeys);
  const origFetch = globalThis.fetch;

  // 1. OpenRouter models with `supported_parameters` or `:free` NEVER set `needsDiscovery: true` (0 wasted background requests!)
  const orFree = parseProviderModelItem(
    { id: 'deepseek/deepseek-r1:free', supported_parameters: ['tools', 'reasoning'] },
    { isTooken: false }
  );
  assert.equal(orFree.reasoning.needsDiscovery, false);
  assert.equal(isRpdLimitedTurn({ tokenSaver: 'max', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free' }), true);
  assert.equal(isRpdLimitedTurn({ tokenSaver: 'rpd', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' }), true);

  const pack = buildRequestSaverWorkspacePack(
    { 'index.html': '<h1>Old</h1>\n', 'app.js': 'console.log(1);\n' },
    'index.html',
    'تگ h1 را در index.html تغییر بده'
  );
  assert.ok(pack.preloadedPaths.includes('index.html'));
  assert.match(pack.injectedText, /50-REQ\/DAY ULTRA-BATCH MODE/);

  try {
    const authRes = await authApi.onRequestGet(
      ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), env)
    );
    const cookie = authRes.headers.get('Set-Cookie').split(';')[0];

    // Configure Primary = OpenRouter (2 rotating keys!) + Backup Auto-Failover = Zro (`https://zro.moonmath.ai/v1`) via real `/api/config`
    const cfgRes = await (
      await configApi.onRequestPost(
        ctx(
          req('/api/config', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: {
              baseUrl: 'https://openrouter.ai/api/v1',
              apiKey: 'sk-or-v1-keyA11111111, sk-or-v1-keyB22222222',
              defaultModel: 'qwen/qwen3-coder:free',
              fallbackBaseUrl: 'https://zro.moonmath.ai/v1',
              fallbackApiKey: 'zro_backup_key_99999999',
              fallbackModel: 'deepseek-v4.1-flash',
              skipModels: true
            }
          }),
          env
        )
      )
    ).json();
    const summary = cfgRes.provider;
    assert.equal(summary.keyCount, 2);
    assert.equal(summary.fallbackActive, true);
    assert.equal(summary.fallbackBaseUrl, 'https://zro.moonmath.ai/v1');

    const created = await (
      await stateApi.onRequestPost(
        ctx(req('/api/state', { method: 'POST', body: { action: 'create', title: '50 RPD' }, headers: { Cookie: cookie } }), env)
      )
    ).json();

    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            action: 'workspace',
            id: created.id,
            workspace: {
              files: { 'index.html': '<!doctype html><html><body><h1>سلام</h1></body></html>' },
              active: 'index.html'
            }
          }
        }),
        env
      )
    );

    const jwksFetch = globalThis.fetch;
    const seenCalls = [];
    let scenario = 'one_shot_key_rotate';

    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
      const authHeader = init?.headers?.Authorization || '';
      const bodyObj = init?.body ? JSON.parse(init.body) : {};
      seenCalls.push({ url: u, auth: authHeader, model: bodyObj.model, toolsCount: bodyObj.tools?.length || 0 });

      if (scenario === 'one_shot_key_rotate') {
        // Key A exhausted its 50/day cap -> instant rotation to Key B!
        if (authHeader === 'Bearer sk-or-v1-keyA11111111') {
          return new Response(
            JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day.' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }
        assert.equal(authHeader, 'Bearer sk-or-v1-keyB22222222');
        // Verify `think` tool was stripped & `index.html` was preloaded in Request #1!
        assert.equal(bodyObj.tools.some((t) => t.function.name === 'think'), false);
        assert.match(JSON.stringify(bodyObj.messages), /Preloaded: index\.html/);

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'عنوان صفحه به خوش آمدید تغییر یافت.',
                  tool_calls: [
                    {
                      id: 'tc_patch_h1',
                      type: 'function',
                      function: {
                        name: 'apply_patch',
                        arguments: JSON.stringify({
                          path: 'index.html',
                          edits: [{ search: '<h1>سلام</h1>', replace: '<h1>خوش آمدید</h1>' }]
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 450, completion_tokens: 60, total_tokens: 510 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Scenario 2: BOTH OpenRouter keys exhausted 50/day -> Seamless auto-failover to Zro (`zro.moonmath.ai/v1`)!
      if (u.includes('openrouter.ai')) {
        return new Response(
          JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day.' } }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      assert.equal(u, 'https://zro.moonmath.ai/v1/chat/completions');
      assert.equal(authHeader, 'Bearer zro_backup_key_99999999');
      assert.equal(bodyObj.model, 'deepseek-v4.1-flash');
      const sse = [
        'data: ' + JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ delta: { content: 'پاسخ بدون وقفه از درگاه پشتیبان Zro!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 25, total_tokens: 225 } }),
        'data: [DONE]',
        ''
      ].join('\n\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    // Run Scenario 1: Key A 429 -> instant Key B rotation + 1-Shot Fast-Finish (NO 2nd post-edit request!)
    const res1 = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            conversationId: created.id,
            message: 'متن h1 را به خوش آمدید تغییر بده',
            model: 'qwen/qwen3-coder:free'
          }
        }),
        env
      )
    );
    const evts1 = await parseSse(res1);
    const done1 = evts1.find((e) => e.event === 'done');
    assert.ok(done1);
    assert.equal(done1.data.turnTokens.requestsUsed, 1, 'Must complete entire file patch in 1 single step (no 2nd post-edit request)!');
    assert.equal(seenCalls.filter((c) => c.auth.includes('keyB')).length, 1, 'Key B called only ONCE total!');

    // Run Scenario 2: Both OpenRouter keys 429 -> Seamless auto-failover to Zro!
    seenCalls.length = 0;
    scenario = 'failover_to_zro';
    const res2 = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            conversationId: created.id,
            message: 'وضیعت پروژه چطور است؟',
            model: 'qwen/qwen3-coder:free'
          }
        }),
        env
      )
    );
    const evts2 = await parseSse(res2);
    const failoverStatus = evts2.find((e) => e.event === 'status' && e.data.phase === 'provider_failover');
    const done2 = evts2.find((e) => e.event === 'done');
    assert.ok(failoverStatus, 'Must emit provider_failover status event');
    assert.equal(failoverStatus.data.toBaseUrl, 'https://zro.moonmath.ai/v1');
    assert.ok(done2);
    assert.match(done2.data.content, /درگاه پشتیبان Zro/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('10-Gateway Smart Pool (درگاه ۱ تا ۱۰): saves up to 10 encrypted gateways, preserves keys on edit, auto-finds working gateway #5 when 1..4 hit quota/limits, and remembers healthy gateway on next turn', async () => {
  const origFetch = globalThis.fetch;
  fakeJwks(sharedKeys);
  const jwksFetch = globalThis.fetch;
  const env = makeEnv(sharedKeys);

  const authRes = await authApi.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), env)
  );
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];

  // 1. Reject > 10 gateways cleanly
  const elevenFallbacks = Array.from({ length: 10 }, (_, idx) => ({
    baseUrl: `https://gw${idx + 2}.example.com/v1`,
    apiKey: `key_gw_${idx + 2}_12345678`
  }));
  const tooManyRes = await configApi.onRequestPost(
    ctx(
      req('/api/config', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-gw1-11112222',
          fallbacks: elevenFallbacks,
          skipModels: true
        }
      }),
      env
    )
  );
  assert.equal(tooManyRes.status, 400, 'More than 10 total gateways must return 400');

  // 2. Configure ALL 10 Gateways (Gateway 1 + Gateways 2..10)
  const nineBackups = [
    { label: 'OR #2', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-gw2-22223333', defaultModel: 'qwen/qwen3-coder:free' },
    { label: 'Paid Exhausted', baseUrl: 'https://gw3.example.com/v1', apiKey: 'sk-gw3-33334444', defaultModel: 'coder-v3' },
    { label: 'Expired Key', baseUrl: 'https://gw4.example.com/v1', apiKey: 'sk-gw4-44445555', defaultModel: 'coder-v4' },
    { label: 'Zro Healthy #5', baseUrl: 'https://zro.moonmath.ai/v1', apiKey: 'zro_gw5_healthy_9999', defaultModel: 'deepseek-v4.1-flash' },
    { label: 'GW 6', baseUrl: 'https://gw6.example.com/v1', apiKey: 'sk-gw6-66667777', defaultModel: 'model-6' },
    { label: 'GW 7', baseUrl: 'https://gw7.example.com/v1', apiKey: 'sk-gw7-77778888', defaultModel: 'model-7' },
    { label: 'GW 8', baseUrl: 'https://gw8.example.com/v1', apiKey: 'sk-gw8-88889999', defaultModel: 'model-8' },
    { label: 'GW 9', baseUrl: 'https://gw9.example.com/v1', apiKey: 'sk-gw9-99990000', defaultModel: 'model-9' },
    { label: 'GW 10', baseUrl: 'https://gw10.example.com/v1', apiKey: 'sk-gw10-00001111', defaultModel: 'model-10' }
  ];

  const cfgRes = await configApi.onRequestPost(
    ctx(
      req('/api/config', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-gw1-11112222',
          defaultModel: 'qwen/qwen3-coder:free',
          fallbacks: nineBackups,
          skipModels: true
        }
      }),
      env
    )
  );
  assert.equal(cfgRes.status, 200);
  const cfgBody = await cfgRes.json();
  assert.equal(cfgBody.provider.maxGateways, 10);
  assert.equal(cfgBody.provider.gateways.length, 10, 'All 10 gateways must be stored');
  assert.equal(cfgBody.provider.activeGatewayCount, 10, 'All 10 gateways must be active');

  // 3. Re-save with blank `apiKey: ""` on Gateways 2..10 (simulating UI edit of labels) -> encrypted keys MUST be preserved!
  const editRes = await configApi.onRequestPost(
    ctx(
      req('/api/config', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: '',
          defaultModel: 'qwen/qwen3-coder:free',
          fallbacks: cfgBody.provider.fallbacks.map((fb, idx) => ({
            id: fb.id,
            label: idx === 3 ? 'Zro Working Gateway #5' : fb.label,
            baseUrl: fb.baseUrl,
            apiKey: '',
            defaultModel: fb.defaultModel
          })),
          skipModels: true
        }
      }),
      env
    )
  );
  const editBody = await editRes.json();
  assert.equal(editBody.provider.activeGatewayCount, 10, 'Encrypted keys for all 10 gateways must survive blank password re-save');
  assert.equal(editBody.provider.fallbacks[3].label, 'Zro Working Gateway #5');

  const created = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
    )
  ).json();

  const seenUrls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/cdn-cgi/access/certs')) return jwksFetch(url, init);
    const authHeader = String(init?.headers?.Authorization || init?.headers?.authorization || '');
    seenUrls.push({ url: u, auth: authHeader });

    // Gateway 1 & 2 (OpenRouter accounts #1 & #2): 50 RPD daily limit!
    if (u.includes('openrouter.ai/api/v1/chat/completions')) {
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day.', code: 429 } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Gateway 3: 402 Quota Exhausted
    if (u.includes('gw3.example.com/v1/chat/completions')) {
      return new Response(
        JSON.stringify({ error: { message: 'Insufficient balance / quota exhausted' } }),
        { status: 402, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Gateway 4: 401 Invalid API Key
    if (u.includes('gw4.example.com/v1/chat/completions')) {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid API key' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Gateway 5 (Zro): WORKS!
    if (u.includes('zro.moonmath.ai/v1/chat/completions')) {
      assert.equal(authHeader, 'Bearer zro_gw5_healthy_9999');
      const sse = [
        `data: ${JSON.stringify({
          id: 'gw5-ok',
          model: 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'پاسخ سالم از درگاه ۵ (Zro) دریافت شد!' }, finish_reason: null }]
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'gw5-ok',
          model: 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 180, completion_tokens: 20, total_tokens: 200 }
        })}\n\n`,
        'data: [DONE]\n\n'
      ].join('');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('unexpected gateway', { status: 500 });
  };

  try {
    // Turn 1: Gateways 1, 2, 3, 4 fail -> automatically walks chain and succeeds on Gateway #5!
    const turn1Res = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'تست انتخاب خودکار درگاه سالم', model: 'qwen/qwen3-coder:free' }
        }),
        env
      )
    );
    const turn1Evts = await parseSse(turn1Res);
    const turn1Done = turn1Evts.find((e) => e.event === 'done');
    assert.ok(turn1Done, 'Turn 1 must succeed via Gateway #5');
    assert.match(turn1Done.data.content, /درگاه ۵/);
    assert.equal(turn1Done.data.activeGateway?.slot, 5, 'Active gateway slot must be 5');
    assert.equal(seenUrls.length, 5, 'Must try Gateways 1..4 once each with 0 retry waste and succeed on Gateway 5');

    // Turn 2 (Next message right after): Gateways 1..4 are now on cooldown, so Gateway #5 MUST be selected IMMEDIATELY on try #1!
    seenUrls.length = 0;
    const turn2Res = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'پیام دوم بدون اتلاف درخواست روی درگاه‌های سوخته', model: 'qwen/qwen3-coder:free' }
        }),
        env
      )
    );
    const turn2Evts = await parseSse(turn2Res);
    const turn2Done = turn2Evts.find((e) => e.event === 'done');
    assert.ok(turn2Done, 'Turn 2 must succeed immediately');
    assert.equal(
      seenUrls.length,
      1,
      'Smart health memory must skip dead Gateways 1..4 and hit working Gateway #5 on the VERY FIRST HTTP request!'
    );
    assert.match(seenUrls[0].url, /zro\.moonmath\.ai/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('True Runtime Model Identity + Honest Verified actualModel + Paid/Unavailable Guard (Zero Pointless Gateway Switch)', async () => {
  const origFetch = globalThis.fetch;
  fakeJwks(sharedKeys);
  const jwksFetch = globalThis.fetch;
  const env = makeEnv(sharedKeys);

  const authRes = await authApi.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(sharedKeys) } }), env)
  );
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];

  // Configure Gateway 1 (OpenRouter Free Account) + Gateway 2 (Zro Backup)
  const cfgRes = await configApi.onRequestPost(
    ctx(
      req('/api/config', {
        method: 'POST',
        headers: { Cookie: cookie },
        body: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-free-account-11112222',
          defaultModel: 'qwen/qwen3-coder:free',
          fallbacks: [
            {
              label: 'Zro Backup',
              baseUrl: 'https://zro.moonmath.ai/v1',
              apiKey: 'zro_backup_key_99990000',
              defaultModel: 'deepseek-v4.1-flash'
            }
          ],
          skipModels: true
        }
      }),
      env
    )
  );
  assert.equal(cfgRes.status, 200);

  const created = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
    )
  ).json();

  const upstreamCalls = [];
  let proxyFakeFreeSubstitution = false;
  let simulateOpenRouter429 = false;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('cdn-cgi/access/certs')) return jwksFetch(url, init);

    if (u.includes('openrouter.ai/api/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', pricing: { prompt: '0', completion: '0' } },
            { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4', pricing: { prompt: '0.000015', completion: '0.000075' } }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (u.includes('/chat/completions')) {
      const body = JSON.parse(String(init.body || '{}'));
      const sysText = typeof body.messages?.[0]?.content === 'string'
        ? body.messages[0].content
        : JSON.stringify(body.messages?.[0]?.content || '');
      upstreamCalls.push({ url: u, model: body.model, sysText });

      if (u.includes('openrouter.ai')) {
        if (simulateOpenRouter429) {
          return new Response(
            JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day.', code: 429 } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Paid model selected on free OpenRouter -> 402 Insufficient credits
        if (body.model === 'anthropic/claude-opus-4') {
          return new Response(
            JSON.stringify({ error: { message: 'This request requires more credits, or fewer max_tokens.', code: 402 } }),
            { status: 402, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Non-existent / unavailable model -> 404 No endpoints found
        if (body.model === 'claude-opus-5-5') {
          return new Response(
            JSON.stringify({ error: { message: 'No endpoints found for claude-opus-5-5.', code: 404 } }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Upstream router returns a DIFFERENT model than requested (e.g. openrouter/auto -> meta-llama/llama-3.3-70b-instruct:free)
        const returnedModel = proxyFakeFreeSubstitution ? 'meta-llama/llama-3.3-70b-instruct:free' : body.model;
        const sse =
          `data: ${JSON.stringify({
            id: 'id-check-1',
            model: returnedModel,
            choices: [{ index: 0, delta: { content: `من مدل واقعی ${returnedModel} در درگاه ۱ هستم.` }, finish_reason: null }]
          })}\n\n` +
          `data: ${JSON.stringify({
            id: 'id-check-1',
            model: returnedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
          })}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      if (u.includes('zro.moonmath.ai')) {
        const sse =
          `data: ${JSON.stringify({
            id: 'id-zro-1',
            model: body.model,
            choices: [{ index: 0, delta: { content: `پاسخ از درگاه ۲ با مدل ${body.model}` }, finish_reason: null }]
          })}\n\n` +
          `data: ${JSON.stringify({
            id: 'id-zro-1',
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 90, completion_tokens: 18, total_tokens: 108 }
          })}\n\n` +
          `data: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
    }
    return new Response('unexpected fetch: ' + u, { status: 500 });
  };

  try {
    // 1. Catalog tags Free vs Paid models (`pricingTier: 'free' | 'paid'`)
    const modelsRes = await modelsApi.onRequestGet(ctx(req('/api/models?refresh=1', { headers: { Cookie: cookie } }), env));
    const modelsJson = await modelsRes.json();
    const freeItem = modelsJson.models.find((m) => m.id === 'qwen/qwen3-coder:free');
    const paidItem = modelsJson.models.find((m) => m.id === 'anthropic/claude-opus-4');
    assert.equal(freeItem?.pricingTier, 'free', 'Free OpenRouter model must have pricingTier="free"');
    assert.equal(paidItem?.pricingTier, 'paid', 'Paid OpenRouter model must have pricingTier="paid"');

    // 2. Selecting PAID model (`anthropic/claude-opus-4`) on free OpenRouter:
    //    MUST report `model_paid_required` AND MUST NOT switch to Gateway 2 (`zro.moonmath.ai`) or cooldown Gateway 1!
    upstreamCalls.length = 0;
    const paidRes = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'سلام', model: 'anthropic/claude-opus-4' }
        }),
        env
      )
    );
    const paidEvts = await parseSse(paidRes);
    const paidErr = paidEvts.find((e) => e.event === 'error');
    assert.ok(paidErr, 'Paid model without credits must emit an explicit SSE error');
    assert.equal(paidErr.data.code, 'model_paid_required');
    assert.match(paidErr.data.error, /پولی است/);
    assert.match(paidErr.data.error, /درگاه تغییر نکرد/);
    assert.equal(upstreamCalls.length, 1, 'Must NOT switch to Gateway 2 or retry pointlessly when model is paid!');
    assert.match(upstreamCalls[0].url, /openrouter\.ai/);

    // 3. Selecting UNAVAILABLE / NON-EXISTENT model (`claude-opus-5-5` on OpenRouter -> 404):
    //    MUST NOT silently substitute `qwen/qwen3-coder:free` AND MUST NOT switch to Gateway 2!
    upstreamCalls.length = 0;
    const missingRes = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'کدوم هوش مصنوعی هستی؟', model: 'claude-opus-5-5' }
        }),
        env
      )
    );
    const missingEvts = await parseSse(missingRes);
    const missingErr = missingEvts.find((e) => e.event === 'error');
    assert.ok(missingErr, 'Unavailable model must emit an explicit SSE error instead of silently running a free model!');
    assert.equal(missingErr.data.code, 'model_not_found');
    assert.match(missingErr.data.error, /وجود ندارد یا در دسترس نیست/);
    assert.match(missingErr.data.error, /درگاه تغییر نکرد/);
    assert.equal(upstreamCalls.length, 1, 'Must NOT silently retry defaultModel or switch to Gateway 2 on 404!');

    // 4. Gateway 1 is STILL healthy (not put on cooldown by paid/unavailable errors!) and injects exact Runtime AI Identity:
    upstreamCalls.length = 0;
    const freeRes = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'الان واقعاً کدوم مدل هوش مصنوعی هستی؟', model: 'qwen/qwen3-coder:free' }
        }),
        env
      )
    );
    const freeEvts = await parseSse(freeRes);
    const freeDone = freeEvts.find((e) => e.event === 'done');
    assert.ok(freeDone, 'Free model on Gateway 1 succeeds immediately because Gateway 1 was never cooled down');
    assert.equal(upstreamCalls.length, 1);
    assert.match(upstreamCalls[0].url, /openrouter\.ai/, 'Gateway 1 remained active and healthy');
    assert.match(upstreamCalls[0].sysText, /## Verified Runtime AI Identity/);
    assert.match(upstreamCalls[0].sysText, /qwen\/qwen3-coder:free/, 'System prompt tells AI its exact active model ID');
    assert.match(upstreamCalls[0].sysText, /درگاه 1 \(`openrouter\.ai`\)/, 'System prompt tells AI its exact active gateway');
    assert.equal(freeDone.data.actualModel, 'qwen/qwen3-coder:free');
    assert.equal(freeDone.data.requestedModel, 'qwen/qwen3-coder:free');
    assert.equal(freeDone.data.modelMismatch, false);

    // 5. Honest Server-Verified Model Mismatch Detection: if upstream proxy/router runs a different free model than requested,
    //    `done` SSE and persisted D1 history expose `actualModel`, `requestedModel`, and `modelMismatch: true`!
    proxyFakeFreeSubstitution = true;
    upstreamCalls.length = 0;
    const mismatchRes = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'تست تطبیق مدل واقعی سرور', model: 'openrouter/auto' }
        }),
        env
      )
    );
    const mismatchEvts = await parseSse(mismatchRes);
    const mismatchDone = mismatchEvts.find((e) => e.event === 'done');
    assert.ok(mismatchDone);
    assert.equal(mismatchDone.data.requestedModel, 'openrouter/auto');
    assert.equal(mismatchDone.data.actualModel, 'meta-llama/llama-3.3-70b-instruct:free');
    assert.equal(mismatchDone.data.modelMismatch, true, 'Flags mismatch whenever upstream executes a different model than selected');

    // 6. Real 429 Daily Quota on Gateway 1 STILL fails over seamlessly to Gateway 2 AND updates Runtime AI Identity to Gateway 2's model!
    proxyFakeFreeSubstitution = false;
    simulateOpenRouter429 = true;
    upstreamCalls.length = 0;
    const failoverRes = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: created.id, message: 'کدوم مدل هستی؟', model: 'qwen/qwen3-coder:free' }
        }),
        env
      )
    );
    const failoverEvts = await parseSse(failoverRes);
    const failoverDone = failoverEvts.find((e) => e.event === 'done');
    assert.ok(failoverDone, 'Genuine 429 daily quota still fails over automatically to Gateway 2');
    assert.equal(upstreamCalls.length, 2);
    assert.match(upstreamCalls[1].url, /zro\.moonmath\.ai/);
    assert.match(upstreamCalls[1].sysText, /deepseek-v4\.1-flash/, 'After failover, AI runtime identity updates to Gateway 2 model!');
    assert.match(upstreamCalls[1].sysText, /درگاه 2 \(`zro\.moonmath\.ai`\)/);
    assert.equal(failoverDone.data.actualModel, 'deepseek-v4.1-flash');
    assert.equal(failoverDone.data.modelMismatch, true, 'Alerts user that Gateway 2 answered with deepseek-v4.1-flash instead of qwen');
  } finally {
    globalThis.fetch = origFetch;
  }
});


