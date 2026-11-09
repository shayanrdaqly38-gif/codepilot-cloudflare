// Workspace modes: developer (GitHub-linked, legacy caps) vs normal ("arena":
// independent, real 1GB ceiling, chunked storage that never hits D1's ~1MB row
// cap, lazy hydration for huge files, per-conversation mode independence).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';
import {
  createConversation,
  deleteConversation,
  getConversation,
  hydrateConversationWorkspace,
  loadWorkspaceFile,
  normalizeWorkspaceMode,
  persistConversationWorkspace,
  safeWorkspace,
  workspaceLimits
} from '../functions/_lib/store.js';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const workspaceFileApi = await import(`${root}/api/state/workspace-file.js`);

const OWNER = 'https://team.cloudflareaccess.com|user-1';
let keys;
let env;
let cookie;

before(() => {
  keys = rsaKeys();
  fakeJwks(keys);
  env = makeEnv();
});

after(() => {
  globalThis.fetch = undefined;
});

async function signIn(overrides = {}) {
  const token = accessToken(keys, overrides);
  const res = await auth.onRequestGet(ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('Set-Cookie');
  return setCookie ? setCookie.split(';')[0] : null;
}

test('normalizeWorkspaceMode only admits developer|normal', () => {
  assert.equal(normalizeWorkspaceMode('normal'), 'normal');
  assert.equal(normalizeWorkspaceMode('developer'), 'developer');
  assert.equal(normalizeWorkspaceMode('arena'), 'developer');
  assert.equal(normalizeWorkspaceMode(undefined), 'developer');
  assert.equal(normalizeWorkspaceMode(42), 'developer');
});

test('workspaceLimits defaults to a real 1GB normal ceiling and honours WORKSPACE_MAX_BYTES', () => {
  assert.equal(workspaceLimits(null).normal.maxTotalBytes, 1_000_000_000);
  assert.equal(workspaceLimits({ WORKSPACE_MAX_BYTES: '3000000' }).normal.maxTotalBytes, 3_000_000);
  // Out-of-range tuning values fall back to the default instead of breaking.
  assert.equal(workspaceLimits({ WORKSPACE_MAX_BYTES: '10' }).normal.maxTotalBytes, 1_000_000_000);
});

test('safeWorkspace: normal mode keeps big files and null placeholders, developer mode drops them', () => {
  const big = 'x'.repeat(1_200_000); // 1.2MB — over the developer per-file cap
  const normal = safeWorkspace({ files: { 'big.txt': big, 'lazy.bin': null, 'ok.txt': 'hello' } }, { mode: 'normal' });
  assert.equal(normal.files['big.txt'], big, 'normal mode accepts >1MB files');
  assert.equal(normal.files['lazy.bin'], null, 'null placeholders pass through (keep server copy)');
  assert.equal(normal.files['ok.txt'], 'hello');
  assert.equal(normal.repo, null, 'normal mode never carries a GitHub repo pointer');

  const dev = safeWorkspace({ files: { 'big.txt': big, 'ok.txt': 'hello' } });
  assert.equal(dev.files['big.txt'], undefined, 'developer mode still drops oversized files');
  assert.equal(dev.files['ok.txt'], 'hello');
});

test('create API stores mode per conversation and forks inherit it', async () => {
  cookie ??= await signIn();
  const res = await stateApi.onRequestPost(
    ctx(req('/api/state', { method: 'POST', body: { action: 'create', mode: 'normal' }, headers: { Cookie: cookie } }), env)
  );
  const created = await res.json();
  assert.equal(res.status, 200);
  const conv = await getConversation(env, OWNER, created.id);
  assert.equal(conv.mode, 'normal');

  const forkRes = await stateApi.onRequestPost(
    ctx(req('/api/state', { method: 'POST', body: { action: 'fork', id: created.id }, headers: { Cookie: cookie } }), env)
  );
  const forked = await forkRes.json();
  assert.equal(forkRes.status, 200);
  const forkConv = await getConversation(env, OWNER, forked.id);
  assert.equal(forkConv.mode, 'normal', 'fork keeps the source mode');

  const devRes = await stateApi.onRequestPost(
    ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
  );
  const devCreated = await devRes.json();
  const devConv = await getConversation(env, OWNER, devCreated.id);
  assert.equal(devConv.mode, 'developer', 'mode defaults to developer');
});

test('a 2.5MB file round-trips through chunked storage without hitting the 1MB row cap', async () => {
  cookie ??= await signIn();
  const id = await createConversation(env, OWNER, { mode: 'normal' });
  const conv = await getConversation(env, OWNER, id);

  // Mix of ASCII and multi-byte content to exercise byte-aware chunking.
  const big = ('🚀 سلام دنیا — '.repeat(40_000) + 'a'.repeat(900_000)).slice(0, 2_500_000);
  await persistConversationWorkspace(env, OWNER, id, { files: { 'big.bin': big, 'small.txt': 'ok' }, active: 'big.bin' });

  const fileRow = await env.DB
    .prepare('SELECT content, bytes, chunked FROM workspace_files WHERE conversation_id=? AND path=?')
    .bind(id, 'big.bin')
    .first();
  assert.equal(fileRow.chunked, 1, 'big file is marked chunked');
  assert.equal(fileRow.content, '', 'inline content column stays empty for chunked files');
  assert.equal(Number(fileRow.bytes), Buffer.byteLength(big, 'utf8'), 'bytes column records the exact size');

  const chunkRows = await env.DB
    .prepare('SELECT part, length(data) AS chars, data FROM workspace_file_chunks WHERE conversation_id=? AND path=? ORDER BY part ASC')
    .bind(id, 'big.bin')
    .all();
  assert.ok(chunkRows.results.length >= 3, '2.5MB file splits into several chunks');
  const lastPart = chunkRows.results.length - 1;
  for (const row of chunkRows.results) {
    const bytes = Buffer.byteLength(row.data, 'utf8');
    assert.ok(bytes <= 700_000, `chunk part ${row.part} is ${bytes} bytes — must stay under the ~1MB D1 row cap`);
    if (row.part !== lastPart) {
      assert.ok(bytes > 100_000, `chunk part ${row.part} is not wastefully small`);
    }
  }
  // Chunks are contiguous and lossless.
  const reassembled = chunkRows.results.map((r) => r.data).join('');
  assert.equal(reassembled, big);

  const hydrated = await hydrateConversationWorkspace(env, await getConversation(env, OWNER, id));
  assert.equal(hydrated.mode, 'normal');
  assert.equal(hydrated.files['big.bin'], big, 'hydrate reassembles chunks into the identical content');
  assert.equal(hydrated.files['small.txt'], 'ok');

  const single = await loadWorkspaceFile(env, conv, 'big.bin');
  assert.equal(single.content, big, 'loadWorkspaceFile also reassembles identically');
  assert.equal(single.bytes, Buffer.byteLength(big, 'utf8'));
});

test('huge workspaces hydrate lazily: over-budget files become null placeholders with sizes', async () => {
  const id = await createConversation(env, OWNER, { mode: 'normal' });
  const a = 'A'.repeat(600_000);
  const b = 'B'.repeat(600_000);
  // 1.2MB total → external storage; hydrating with a 700KB budget makes
  // b.txt lazy while a.txt still loads.
  await persistConversationWorkspace(env, OWNER, id, { files: { 'a.txt': a, 'b.txt': b }, active: 'a.txt' });
  const conv = await getConversation(env, OWNER, id);

  const hydrated = await hydrateConversationWorkspace(env, conv, { byteBudget: 700_000 });
  assert.equal(hydrated.files['a.txt'], a, 'first file fits the budget and loads');
  assert.equal(hydrated.files['b.txt'], null, 'second file exceeds the budget and stays lazy');
  assert.equal(hydrated.lazy['b.txt'], 600_000, 'lazy map carries the on-disk size');
  assert.equal(hydrated.totalBytes, 1_200_000, 'totalBytes counts every file, lazy or not');

  const loaded = await loadWorkspaceFile(env, conv, 'b.txt');
  assert.equal(loaded.content, b, 'lazy file loads on demand');

  const truncated = await loadWorkspaceFile(env, conv, 'b.txt', { maxBytes: 100_000 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.content, 'B'.repeat(100_000));
});

test('the 1GB cap is really enforced (via WORKSPACE_MAX_BYTES tuning) on both persist paths', async () => {
  const smallEnv = makeEnv(keys, { WORKSPACE_MAX_BYTES: '2000000' }); // 2MB ceiling for the test
  const id = await createConversation(smallEnv, OWNER, { mode: 'normal' });

  // Full persist path: total over the cap → 413.
  await assert.rejects(
    () => persistConversationWorkspace(smallEnv, OWNER, id, { files: { 'x.bin': 'x'.repeat(2_100_000) } }),
    (err) => err.status === 413 && err.code === 'too_large'
  );

  // Incremental persist path: existing 1.2MB + a touched 1MB file → projected over the cap.
  await persistConversationWorkspace(smallEnv, OWNER, id, { files: { 'base.bin': 'x'.repeat(1_200_000) } });
  await assert.rejects(
    () =>
      persistConversationWorkspace(smallEnv, OWNER, id, { files: { 'base.bin': 'x'.repeat(1_200_000), 'add.bin': 'y'.repeat(1_000_000) } }, {
        touched: ['add.bin'],
        deleted: []
      }),
    (err) => err.status === 413 && err.code === 'too_large'
  );

  // Just under the cap passes.
  await persistConversationWorkspace(smallEnv, OWNER, id, { files: { 'base.bin': 'x'.repeat(1_200_000), 'add.bin': 'y'.repeat(700_000) } }, {
    touched: ['add.bin'],
    deleted: []
  });
  const hydrated = await hydrateConversationWorkspace(smallEnv, await getConversation(smallEnv, OWNER, id));
  assert.equal(hydrated.files['add.bin'], 'y'.repeat(700_000));
});

test('null placeholders in a client workspace save never wipe the stored files (merge semantics)', async () => {
  const id = await createConversation(env, OWNER, { mode: 'normal' });
  const content = 'z'.repeat(1_500_000);
  await persistConversationWorkspace(env, OWNER, id, { files: { 'keep.bin': content, 'edit.txt': 'v1' } });

  // The UI only lazily loaded keep.bin (null) and edited edit.txt.
  await persistConversationWorkspace(env, OWNER, id, {
    files: { 'keep.bin': null, 'edit.txt': 'v2' },
    active: 'edit.txt'
  });

  const hydrated = await hydrateConversationWorkspace(env, await getConversation(env, OWNER, id));
  assert.equal(hydrated.files['keep.bin'], content, 'lazy file survived the full save untouched');
  assert.equal(hydrated.files['edit.txt'], 'v2', 'edited file took the new value');
});

test('fork clones chunk rows so a big arena file survives /fork', async () => {
  const id = await createConversation(env, OWNER, { mode: 'normal' });
  const big = 'q'.repeat(1_800_000);
  await persistConversationWorkspace(env, OWNER, id, { files: { 'huge.bin': big } });

  const forkId = await createConversation(env, OWNER, { mode: 'normal', copyWorkspaceFrom: id });
  const forkConv = await getConversation(env, OWNER, forkId);
  const forked = await hydrateConversationWorkspace(env, forkConv);
  assert.equal(forked.files['huge.bin'], big, 'chunked content is cloned byte-for-byte');

  const chunks = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM workspace_file_chunks WHERE conversation_id=?')
    .bind(forkId)
    .first();
  assert.ok(chunks.n >= 2, 'the fork owns real chunk rows, not references');
});

test('deleting a conversation removes its chunks too', async () => {
  const id = await createConversation(env, OWNER, { mode: 'normal' });
  await persistConversationWorkspace(env, OWNER, id, { files: { 'huge.bin': 'w'.repeat(1_600_000) } });
  const before = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM workspace_file_chunks WHERE conversation_id=?')
    .bind(id)
    .first();
  assert.ok(before.n >= 1);
  await deleteConversation(env, OWNER, id);
  const after = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM workspace_file_chunks WHERE conversation_id=?')
    .bind(id)
    .first();
  assert.equal(after.n, 0);
});

test('/api/state/workspace-file serves a lazy file owner-scoped and 404s strangers', async () => {
  cookie ??= await signIn();
  const createRes = await stateApi.onRequestPost(
    ctx(req('/api/state', { method: 'POST', body: { action: 'create', mode: 'normal' }, headers: { Cookie: cookie } }), env)
  );
  const { id } = await createRes.json();
  await persistConversationWorkspace(env, OWNER, id, { files: { 'doc.txt': 'محتوای فایل', 'lazy.bin': 'L'.repeat(1_200_000) } });

  const url = `/api/state/workspace-file?conversationId=${encodeURIComponent(id)}&path=${encodeURIComponent('lazy.bin')}`;
  const mine = await workspaceFileApi.onRequestGet(ctx(req(url, { headers: { Cookie: cookie } }), env));
  assert.equal(mine.status, 200);
  const body = await mine.json();
  assert.equal(body.ok, true);
  assert.equal(body.content, 'L'.repeat(1_200_000));
  assert.equal(body.mode, 'normal');

  const strangerCookie = await signIn({ sub: 'user-2', email: 'other@example.com' });
  const denied = await workspaceFileApi.onRequestGet(ctx(req(url, { headers: { Cookie: strangerCookie } }), env));
  assert.equal(denied.status, 404, 'another user cannot read the file, not even its existence');

  const missing = await workspaceFileApi.onRequestGet(
    ctx(req(`/api/state/workspace-file?conversationId=${encodeURIComponent(id)}&path=nope.txt`, { headers: { Cookie: cookie } }), env)
  );
  assert.equal(missing.status, 404);
});

test('developer conversations keep their legacy caps and never grow chunked storage', async () => {
  const id = await createConversation(env, OWNER, { mode: 'developer' });
  const big = 'd'.repeat(1_000_000); // > 900K chars → dropped by developer limits
  await persistConversationWorkspace(env, OWNER, id, { files: { 'big.txt': big, 'ok.txt': 'fine' } });
  const hydrated = await hydrateConversationWorkspace(env, await getConversation(env, OWNER, id));
  assert.equal(hydrated.files['big.txt'], undefined, 'legacy per-file cap still applies in developer mode');
  assert.equal(hydrated.files['ok.txt'], 'fine');
  assert.equal(hydrated.mode, 'developer');
});

/* ---------------- new-conversation regressions (cross-mode clone) --------- */

test('cloning a NORMAL workspace into a DEVELOPER chat re-validates against developer caps', async () => {
  // Regression: the server-side "zero-upload clone" used to copy raw rows
  // regardless of mode, so a 1.5MB arena file landed in a developer
  // conversation whose per-file ceiling is 900K and whose total cap is 8M chars.
  const arenaId = await createConversation(env, OWNER, {
    mode: 'normal',
    workspace: { files: { 'huge.bin': 'y'.repeat(1_500_000), 'ok.txt': 'hello' }, active: 'ok.txt' }
  });
  const devId = await createConversation(env, OWNER, { mode: 'developer', copyWorkspaceFrom: arenaId });

  const devRow = await getConversation(env, OWNER, devId);
  assert.equal(devRow.mode, 'developer');
  const hydrated = await hydrateConversationWorkspace(env, devRow);
  assert.equal(hydrated.files['huge.bin'], undefined, 'oversized arena file must not bypass the developer cap');
  assert.equal(hydrated.files['ok.txt'], 'hello', 'files that fit are still carried over');
  assert.equal(hydrated.repo, null);
});

test('cloning a DEVELOPER workspace into a NORMAL chat never leaks the GitHub repo pointer', async () => {
  const devId = await createConversation(env, OWNER, {
    mode: 'developer',
    workspace: {
      files: { 'a.js': 'console.log(1)' },
      active: 'a.js',
      repo: { owner: 'shayanrdaqly38-gif', repo: 'codepilot-cloudflare', branch: 'main' }
    }
  });
  const arenaId = await createConversation(env, OWNER, { mode: 'normal', copyWorkspaceFrom: devId });
  const hydrated = await hydrateConversationWorkspace(env, await getConversation(env, OWNER, arenaId));
  assert.equal(hydrated.mode, 'normal');
  assert.equal(hydrated.files['a.js'], 'console.log(1)');
  assert.equal(hydrated.repo, null, 'normal mode is GitHub-free even when cloned from a developer chat');
});

test('same-mode clone still takes the fast raw-copy path (large arena files survive)', async () => {
  const src = await createConversation(env, OWNER, {
    mode: 'normal',
    workspace: { files: { 'big.bin': 'q'.repeat(2_000_000), 'small.txt': 'hi' }, active: 'big.bin' }
  });
  const clone = await createConversation(env, OWNER, { mode: 'normal', copyWorkspaceFrom: src });
  const hydrated = await hydrateConversationWorkspace(env, await getConversation(env, OWNER, clone));
  assert.equal((hydrated.files['big.bin'] || '').length, 2_000_000, 'chunked files are cloned byte-for-byte');
  assert.equal(hydrated.files['small.txt'], 'hi');
});

test('archived conversations do not count toward the per-user quota (no way out of that trap in the UI)', async () => {
  const quotaOwner = 'https://team.cloudflareaccess.com|quota-user';
  const now = Date.now();
  // 301 archived rows: invisible in the sidebar (list defaults to archived=0)
  // and un-archiveable from the UI.
  for (let i = 0; i < 301; i += 1) {
    await env.DB.prepare(
      `INSERT INTO conversations(id,owner,title,created_at,updated_at,workspace,archived,mode)
       VALUES(?,?,?,?,?,?,?,?)`
    )
      .bind(`q-arch-${i}`, quotaOwner, `old ${i}`, now, now - i, '{}', 1, 'developer')
      .run();
  }
  const id = await createConversation(env, quotaOwner, { mode: 'developer' });
  assert.ok(id, 'a new conversation can still be created when only archived rows fill the table');

  // …while the ceiling still genuinely applies to live conversations.
  for (let i = 0; i < 300; i += 1) {
    await env.DB.prepare(
      `INSERT INTO conversations(id,owner,title,created_at,updated_at,workspace,archived,mode)
       VALUES(?,?,?,?,?,?,?,?)`
    )
      .bind(`q-live-${i}`, quotaOwner, `live ${i}`, now, now - i, '{}', 0, 'developer')
      .run();
  }
  await assert.rejects(() => createConversation(env, quotaOwner, { mode: 'developer' }), (error) => {
    assert.equal(error.code, 'quota');
    return true;
  });
});
