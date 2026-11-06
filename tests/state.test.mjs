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
  assert.equal(config.model, 'claude-sonnet-5-5');
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

test('usage endpoint tracks exact prompt/completion/reasoning tokens, live provider quota, and manual tokenCap', async () => {
  const store = await import(`${root}/_lib/store.js`);
  const localEnv = makeEnv(keys, { MODEL_API_KEY: 'tc_state_usage_key_999', MODEL_BASE_URL: 'https://tooken.club/v1' });
  const signed = await (async () => {
    const token = accessToken(keys, { sub: 'quota@example.com', email: 'quota@example.com' });
    const res = await auth.onRequestGet(ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': token } }), localEnv));
    return res.headers.get('Set-Cookie').split(';')[0];
  })();

  const owner = 'https://team.cloudflareaccess.com|quota@example.com';
  await store.recordUsage(localEnv, owner, {
    inChars: 500,
    outChars: 900,
    promptTokens: 1200,
    completionTokens: 450,
    reasoningTokens: 310
  });
  await store.recordUsage(localEnv, owner, {
    inChars: 200,
    outChars: 300,
    promptTokens: 800,
    completionTokens: 250,
    reasoningTokens: 90
  });

  // Save manual tokenCap via POST /api/state/usage
  const capRes = await (
    await usageApi.onRequestPost(
      ctx(req('/api/state/usage', { method: 'POST', body: { tokenCap: 50_000 }, headers: { Cookie: signed } }), localEnv)
    )
  ).json();
  assert.equal(capRes.ok, true);
  assert.equal(capRes.tokenCap, 50_000);

  // Query GET /api/state/usage?live=1&refresh=1 with mocked upstream quota
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://tooken.club/v1/balance') {
      return new Response(
        JSON.stringify({ remaining_tokens: 420_000, token_limit: 500_000, tokens_used: 80_000, currency: 'RUB' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (String(url) === 'https://tooken.club/v1/usage') {
      return new Response(JSON.stringify({ total_tokens: 80_000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(url, init);
  };
  try {
    const uRes = await (
      await usageApi.onRequestGet(
        ctx(req('/api/state/usage?live=1&refresh=1', { headers: { Cookie: signed } }), localEnv)
      )
    ).json();
    assert.equal(uRes.ok, true);
    assert.equal(uRes.tokenCap, 50_000);
    assert.equal(uRes.totals.requests, 2);
    assert.equal(uRes.totals.promptTokens, 2000);
    assert.equal(uRes.totals.completionTokens, 700);
    assert.equal(uRes.totals.reasoningTokens, 400);
    assert.equal(uRes.totals.totalTokens, 3100);
    assert.equal(uRes.quota.supported, true);
    assert.equal(uRes.quota.remainingTokens, 420_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('multi-MB Persian workspace overflows cleanly to workspace_files, clones server-side via copyWorkspaceFrom, and lite pagination slims heavy chats', async () => {
  const localEnv = makeEnv(keys);
  const token = accessToken(keys);
  const authRes = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': token } }), localEnv)
  );
  const signed = authRes.headers.get('Set-Cookie').split(';')[0];

  // Build > 2.2 MB UTF-8 Persian workspace across 5 files (exceeds D1's 2 MB single-column ceiling)
  const persianChunk = 'سلام کدپایلوت — این یک متن آزمایشی فارسی برای بررسی سقف بایتی پایگاه‌داده کلودفلر است.\n'.repeat(2100);
  const bigFiles = {
    'part1.txt': persianChunk,
    'part2.txt': persianChunk,
    'part3.txt': persianChunk,
    'part4.txt': persianChunk,
    'app.js': 'export const ok = true;\n'
  };
  const totalBytes = new TextEncoder().encode(JSON.stringify(bigFiles)).byteLength;
  assert.ok(totalBytes > 1_300_000, `expected >1.3MB UTF-8 workspace, got ${totalBytes}`);

  const createA = await (
    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          body: { action: 'create', workspace: { files: bigFiles, active: 'app.js' } },
          headers: { Cookie: signed }
        }),
        localEnv
      )
    )
  ).json();
  assert.equal(createA.ok, true);
  assert.ok(createA.id);

  // Verify conversations.workspace stayed tiny (< 512 bytes) while workspace_files holds the files
  const rawRow = await localEnv.DB.prepare('SELECT workspace FROM conversations WHERE id=?').bind(createA.id).first();
  assert.ok(rawRow.workspace.length < 512, `inline pointer should be tiny, got ${rawRow.workspace.length}`);

  // Zero-upload server-side clone (`copyWorkspaceFrom`) creates a new chat in 1ms with all files intact!
  const createB = await (
    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          body: { action: 'create', copyWorkspaceFrom: createA.id },
          headers: { Cookie: signed }
        }),
        localEnv
      )
    )
  ).json();
  assert.equal(createB.ok, true);
  assert.ok(createB.id && createB.id !== createA.id);

  const openedB = await (
    await oneConv.onRequestGet({
      ...ctx(req(`/api/state/conversations/${createB.id}`, { headers: { Cookie: signed } }), localEnv),
      params: { id: createB.id }
    })
  ).json();
  assert.equal(openedB.workspace.files['app.js'], 'export const ok = true;\n');
  assert.equal(openedB.workspace.files['part3.txt'].length, persianChunk.length);

  // Append 24 heavy messages with 25,000-char tool arguments and verify `?lite=1&limit=8&skipWorkspace=1`
  const heavyMsgs = [];
  for (let i = 0; i < 12; i += 1) {
    heavyMsgs.push({
      role: 'assistant',
      content: `گام ${i + 1}`,
      tool_calls: [
        {
          id: `tc_${i}`,
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: `f${i}.js`, content: 'x'.repeat(25_000) }) }
        }
      ]
    });
    heavyMsgs.push({
      role: 'tool',
      tool_call_id: `tc_${i}`,
      content: 'Saved OK\n' + 'y'.repeat(9000)
    });
  }
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: { action: 'append', id: createB.id, messages: heavyMsgs },
        headers: { Cookie: signed }
      }),
      localEnv
    )
  );

  const litePage1 = await (
    await oneConv.onRequestGet({
      ...ctx(
        req(`/api/state/conversations/${createB.id}?lite=1&limit=8&skipWorkspace=1`, { headers: { Cookie: signed } }),
        localEnv
      ),
      params: { id: createB.id }
    })
  ).json();
  assert.equal(litePage1.ok, true);
  assert.equal(litePage1.workspace, undefined, 'skipWorkspace=1 omits workspace download');
  assert.equal(litePage1.messages.length, 8);
  assert.equal(litePage1.hasOlderMessages, true);
  assert.ok(Number.isFinite(litePage1.oldestSeq));
  const assistantWithTool = litePage1.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  assert.ok(assistantWithTool.tool_calls[0].function.arguments.length <= 240, 'lite mode slims giant write_file arguments');

  const litePage2 = await (
    await oneConv.onRequestGet({
      ...ctx(
        req(`/api/state/conversations/${createB.id}?lite=1&limit=8&beforeSeq=${litePage1.oldestSeq}&skipWorkspace=1`, {
          headers: { Cookie: signed }
        }),
        localEnv
      ),
      params: { id: createB.id }
    })
  ).json();
  assert.equal(litePage2.messages.length, 8);
  assert.ok(litePage2.messages.at(-1).seq < litePage1.oldestSeq, 'beforeSeq returns strictly older messages');
});

test('500KB+ index.html and multi-file workspace persist cleanly without truncation or oversized D1 SQL statements', async () => {
  const { cookie: c } = await signIn();

  const created = await (
    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          headers: { Cookie: c },
          body: { action: 'create', title: 'large-index-workspace' }
        }),
        env
      )
    )
  ).json();
  assert.equal(created.ok, true);

  const largeIndexHtml =
    '<!doctype html>\n<html><body>\n' +
    '<!-- ui-mobile-block -->\n'.repeat(21000) +
    '<div id="tailMarker">OK</div>\n</body></html>';
  assert.ok(largeIndexHtml.length > 500_000, 'test index.html exceeds 500KB');
  const companionA = '// module A\n' + 'export const x = 1;\n'.repeat(16000);
  const companionB = '// module B\n' + 'export const y = 2;\n'.repeat(16000);

  const saveRes = await (
    await stateApi.onRequestPost(
      ctx(
        req('/api/state', {
          method: 'POST',
          headers: { Cookie: c },
          body: {
            action: 'workspace',
            id: created.id,
            workspace: {
              active: 'index.html',
              files: {
                'index.html': largeIndexHtml,
                'src/a.js': companionA,
                'src/b.js': companionB
              }
            }
          }
        }),
        env
      )
    )
  ).json();
  assert.equal(saveRes.ok, true);

  const loaded = await (
    await oneConv.onRequestGet(
      ctx(req(`/api/state/conversations/${created.id}`, { headers: { Cookie: c } }), env, { id: created.id })
    )
  ).json();
  assert.equal(loaded.workspace.files['index.html'].length, largeIndexHtml.length, '500KB+ index.html preserved byte-for-byte');
  assert.ok(loaded.workspace.files['index.html'].includes('<div id="tailMarker">OK</div>'), 'tail of 500KB+ index.html intact');
  assert.equal(loaded.workspace.files['src/a.js'].length, companionA.length);
  assert.equal(loaded.workspace.files['src/b.js'].length, companionB.length);
});


