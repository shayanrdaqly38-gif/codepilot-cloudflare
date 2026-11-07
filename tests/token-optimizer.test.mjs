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
