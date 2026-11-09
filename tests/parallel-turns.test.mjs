// Parallel & resilient turns:
//   1. active_turns D1 registry lifecycle (cross-isolate visibility + stop flag)
//   2. a client disconnect mid-turn must NOT kill the turn — it finishes
//      headlessly under waitUntil and persists the FULL reply
//   3. incremental per-step flushes must never duplicate messages
//   4. turnActive is exposed through the conversation list + detail endpoints
//   5. /api/chat/stop sets the durable stop flag even from another isolate
//   6. runner-kit sessions: parallel chats get isolated Termux workspaces

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { rsaKeys, accessToken, fakeJwks, makeEnv, req, ctx } from './harness.mjs';
import * as auth from '../functions/api/auth.js';
import * as chat from '../functions/api/chat.js';
import * as stopApi from '../functions/api/chat/stop.js';
import * as stateApi from '../functions/api/state/index.js';
import * as convListApi from '../functions/api/state/conversations/index.js';
import * as convDetailApi from '../functions/api/state/conversations/[id].js';
import {
  markTurnActive,
  heartbeatTurnActive,
  clearTurnActive,
  requestTurnStop,
  isTurnActive,
  activeTurnConversations
} from '../functions/_lib/active-turn.js';
import { listMessages } from '../functions/_lib/store.js';

const realFetch = globalThis.fetch; // capture BEFORE fakeJwks swaps it
const keys = rsaKeys();
fakeJwks(keys);
const OWNER = 'https://team.cloudflareaccess.com|user-1';

function sseEvents(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const name = block.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}');
      return { name, data };
    });
}

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
});

async function setUp() {
  const env = makeEnv(keys);
  const authRes = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
  const created = await (
    await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env)
    )
  ).json();
  return { env, cookie, id: created.id };
}

/* ------------------------- 1. active_turns registry ---------------------- */

test('active_turns registry: mark → heartbeat → stop request → clear', async () => {
  const env = makeEnv(keys);
  assert.equal(await isTurnActive(env, OWNER, 'conv-x'), false, 'nothing active initially');

  await markTurnActive(env, OWNER, 'conv-x');
  assert.equal(await isTurnActive(env, OWNER, 'conv-x'), true, 'marked active');

  let map = await activeTurnConversations(env, OWNER);
  assert.equal(map['conv-x'] > 0, true, 'listed in owner active map');

  assert.equal(await heartbeatTurnActive(env, OWNER, 'conv-x'), false, 'no stop requested yet');

  await requestTurnStop(env, OWNER, 'conv-x');
  assert.equal(
    await heartbeatTurnActive(env, OWNER, 'conv-x'),
    true,
    'heartbeat observes the durable stop request'
  );

  // Other-owner isolation: a foreign owner neither sees nor stops our turn.
  assert.equal(await heartbeatTurnActive(env, 'https://other|user-2', 'conv-x'), false);

  await clearTurnActive(env, OWNER, 'conv-x');
  assert.equal(await isTurnActive(env, OWNER, 'conv-x'), false, 'cleared');
  map = await activeTurnConversations(env, OWNER);
  assert.equal(map['conv-x'], undefined, 'gone from owner map');
});

/* ------------------- 2. disconnect must NOT stop the turn ---------------- */

test('a mid-turn client disconnect (refresh/close) keeps the turn running headlessly to completion', async () => {
  const { env, cookie, id } = await setUp();
  const original = globalThis.fetch;
  let modelCalls = 0;
  let releaseSecondCall;
  const gate = new Promise((resolve) => { releaseSecondCall = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    modelCalls += 1;
    if (modelCalls === 1) {
      return new Response(
        JSON.stringify({ model: 'scripted', choices: [{ message: toolCall('c1', 'write_file', { path: 'notes.txt', content: 'headless survives' }) }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    await gate; // hold the final answer until AFTER the client is gone
    return new Response(
      JSON.stringify({ model: 'scripted', choices: [{ message: { role: 'assistant', content: 'پاسخ کامل پس از قطع شدن کاربر.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const ctrl = new AbortController();
  const request = new Request('https://app.example.com/api/chat', {
    method: 'POST',
    headers: {
      Origin: 'https://app.example.com',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({ conversationId: id, message: 'چیزی بنویس که طول بکشد' }),
    signal: ctrl.signal
  });

  const res = await chat.onRequestPost(ctx(request, env));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type') || '', /text\/event-stream/);

  // The turn is now visibly active to any other isolate/client.
  assert.equal(await isTurnActive(env, OWNER, id), true, 'turn marked active in D1');

  // Client refreshes the page: stream reader dies, request signal aborts.
  const reader = res.body.getReader();
  await reader.read();
  ctrl.abort();
  try { await reader.cancel(); } catch { /* already closed */ }

  // …and only NOW the model gets to answer. The turn must still finish.
  releaseSecondCall();

  const deadline = Date.now() + 15_000;
  let finalSaved = false;
  while (Date.now() < deadline) {
    const msgs = await listMessages(env, id);
    if (msgs.some((m) => m.role === 'assistant' && String(m.content).includes('پاسخ کامل پس از قطع'))) {
      finalSaved = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(finalSaved, true, 'full reply persisted despite the client being gone');

  const msgs = await listMessages(env, id);
  assert.ok(msgs.some((m) => m.role === 'tool'), 'tool result persisted');
  assert.equal(await isTurnActive(env, OWNER, id), false, 'active_turns row cleaned up after turn end');
  globalThis.fetch = original;
});

/* --------------- 3. incremental flushes must not duplicate --------------- */

test('multi-step turns persist every message exactly once (step flush + final flush)', async () => {
  const { env, cookie, id } = await setUp();
  const original = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    modelCalls += 1;
    if (modelCalls === 1) {
      return new Response(
        JSON.stringify({ model: 'scripted', choices: [{ message: toolCall('c1', 'write_file', { path: 'a.txt', content: 'A' }) }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (modelCalls === 2) {
      return new Response(
        JSON.stringify({ model: 'scripted', choices: [{ message: toolCall('c2', 'write_file', { path: 'b.txt', content: 'B' }) }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ model: 'scripted', choices: [{ message: { role: 'assistant', content: 'دو فایل ساخته شد.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const res = await chat.onRequestPost(
      ctx(req('/api/chat', { method: 'POST', body: { conversationId: id, message: 'دو فایل بساز' }, headers: { Cookie: cookie } }), env)
    );
    assert.equal(res.status, 200);
    const events = sseEvents(await res.text());
    assert.equal(events.at(-1).name, 'done');
  } finally {
    globalThis.fetch = original;
  }

  const msgs = await listMessages(env, id);
  const countContent = (needle) =>
    msgs.filter((m) => String(m.content).includes(needle)).length;
  assert.equal(countContent('دو فایل ساخته شد.'), 1, 'final assistant text exactly once');
  const toolResults = msgs.filter((m) => m.role === 'tool');
  assert.equal(toolResults.length, 2, 'both tool results persisted');
  const toolIds = new Set(toolResults.map((m) => m.tool_call_id));
  assert.equal(toolIds.size, 2, 'no duplicated tool results');
});

/* -------------------- 4. turnActive in list + detail --------------------- */

test('conversation list and detail expose turnActive for running turns', async () => {
  const { env, cookie, id } = await setUp();
  await markTurnActive(env, OWNER, id);

  const list = await (
    await convListApi.onRequestGet(ctx(req('/api/state/conversations', { headers: { Cookie: cookie } }), env))
  ).json();
  const listed = list.conversations.find((c) => c.id === id);
  assert.equal(listed.turnActive, true, 'list row carries turnActive');

  const detail = await (
    await convDetailApi.onRequestGet(
      ctx(req(`/api/state/conversations/${id}`, { headers: { Cookie: cookie } }), env, { id })
    )
  ).json();
  assert.equal(detail.turnActive, true, 'detail response carries turnActive');

  await clearTurnActive(env, OWNER, id);
  const list2 = await (
    await convListApi.onRequestGet(ctx(req('/api/state/conversations', { headers: { Cookie: cookie } }), env))
  ).json();
  assert.equal(list2.conversations.find((c) => c.id === id).turnActive, undefined, 'flag gone after clear');
});

/* ------------------- 5. stop flag works across isolates ------------------ */

test('POST /api/chat/stop sets the durable stop flag even when the turn runs in another isolate', async () => {
  const { env, cookie, id } = await setUp();
  await markTurnActive(env, OWNER, id);
  const res = await stopApi.onRequestPost(
    ctx(req('/api/chat/stop', { method: 'POST', body: { id }, headers: { Cookie: cookie } }), env)
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  // No in-isolate registry entry here (simulates another isolate) — the
  // durable flag is what the running turn will observe at its next step.
  assert.equal(await heartbeatTurnActive(env, OWNER, id), true, 'stop request visible in D1');
});

/* ------------------- 6. runner-kit session isolation --------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = path.resolve(__dirname, '../runner-kit/server.mjs');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

test('runner-kit sessions: parallel chats execute in isolated workspaces and never collide', async () => {
  const port = await getFreePort();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'cp-sessions-test-'));
  const child = spawn(process.execPath, [RUNNER_SCRIPT], {
    env: { ...process.env, CP_HOST: '127.0.0.1', CP_PORT: String(port), CP_WORKDIR: workDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      try {
        const res = await realFetch(`${baseUrl}/health`);
        if (res.ok) ready = true;
      } catch { /* boot */ }
      if (!ready) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, 'runner booted');
    const health = await (await realFetch(`${baseUrl}/health`)).json();
    assert.equal(health.sessions, true, 'runner advertises session support');

    const run = (body) =>
      realFetch(`${baseUrl}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then((r) => r.json());

    // Two parallel chats, each writing its own file in its own session dir.
    const a = await run({ cmd: 'echo chat-a > a.txt && ls', session: 'conv-aaa' });
    const b = await run({ cmd: 'echo chat-b > b.txt && ls', session: 'conv-bbb' });
    assert.equal(a.ok, true, 'session A command succeeded');
    assert.equal(b.ok, true, 'session B command succeeded');
    assert.match(a.stdout, /a\.txt/, 'session A sees only its own file');
    assert.doesNotMatch(a.stdout, /b\.txt/, 'session B file invisible in session A');
    assert.match(b.stdout, /b\.txt/, 'session B sees only its own file');
    assert.doesNotMatch(b.stdout, /a\.txt/, 'session A file invisible in session B');

    // changedFiles sync back per session (so each chat syncs only its own work).
    assert.ok(a.changedFiles && 'a.txt' in a.changedFiles, 'session A change reported');
    assert.ok(b.changedFiles && 'b.txt' in b.changedFiles, 'session B change reported');
    assert.equal('a.txt' in (b.changedFiles || {}), false, 'no cross-session leak');

    // No session → legacy shared root, untouched by the sessions above.
    const root = await run({ cmd: 'ls' });
    assert.doesNotMatch(root.stdout, /a\.txt|b\.txt/, 'session files never leak into the default workspace');
    assert.equal((root.changedFiles && Object.keys(root.changedFiles).length) || 0, 0, 'default workspace unchanged');
  } finally {
    child.kill('SIGKILL');
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('runner-kit upgrade: first sessioned run adopts the legacy shared workspace (files never "disappear")', async () => {
  const port = await getFreePort();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'cp-adopt-test-'));
  // Simulate a PRE-sessions runner: the conversation's whole life ran in the
  // shared root (git repo, node_modules, dotfiles, loose files).
  await mkdir(path.join(workDir, 'myproject', '.git'), { recursive: true });
  await mkdir(path.join(workDir, 'node_modules', 'somepkg'), { recursive: true });
  await writeFile(path.join(workDir, 'myproject', 'app.js'), 'console.log("legacy");\n');
  await writeFile(path.join(workDir, 'myproject', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(workDir, 'node_modules', 'somepkg', 'index.js'), 'module.exports = 1;\n');
  await writeFile(path.join(workDir, 'notes.txt'), 'legacy top-level file\n');
  await writeFile(path.join(workDir, '.env'), 'SECRET=1\n');

  const child = spawn(process.execPath, [RUNNER_SCRIPT], {
    env: { ...process.env, CP_HOST: '127.0.0.1', CP_PORT: String(port), CP_WORKDIR: workDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      try {
        const res = await realFetch(`${baseUrl}/health`);
        if (res.ok) ready = true;
      } catch { /* boot */ }
      if (!ready) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, 'runner booted');

    const run = (body) =>
      realFetch(`${baseUrl}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then((r) => r.json());

    // The upgrading conversation runs first — D1 sends a NEWER copy of a file
    // that also exists in the legacy root. Adoption must move the legacy tree
    // in without clobbering the fresher D1-synced version.
    const first = await run({
      cmd: 'ls -A && cat myproject/app.js',
      session: 'conv-old',
      files: { 'myproject/app.js': 'console.log("NEWER from D1");\n' }
    });
    assert.equal(first.ok, true, 'first sessioned command succeeded');
    assert.match(first.stdout, /myproject/, 'legacy project dir visible after adoption');
    assert.match(first.stdout, /notes\.txt/, 'legacy top-level file visible after adoption');
    assert.match(first.stdout, /\.env/, 'legacy dotfile visible after adoption');
    assert.match(first.stdout, /NEWER from D1/, 'D1-synced (newer) file wins over legacy copy');

    const sessionDir = path.join(workDir, 'sessions', 'conv-old');
    assert.equal(
      await readFile(path.join(sessionDir, 'notes.txt'), 'utf8'),
      'legacy top-level file\n',
      'legacy file physically moved into the session dir'
    );
    assert.ok(
      await stat(path.join(sessionDir, 'node_modules', 'somepkg', 'index.js')).then(() => true).catch(() => false),
      'node_modules adopted too (ignored-by-sync but part of the environment)'
    );
    assert.ok(
      await stat(path.join(sessionDir, 'myproject', '.git', 'HEAD')).then(() => true).catch(() => false),
      '.git history adopted'
    );
    assert.equal(
      await readFile(path.join(sessionDir, 'myproject', 'app.js'), 'utf8'),
      'console.log("NEWER from D1");\n',
      'session keeps the newer D1 copy, not the clobbered legacy one'
    );

    // The legacy root is now retired: only sessions/ + the marker remain.
    const rootEntries = (await readdir(workDir)).sort();
    assert.deepEqual(rootEntries, ['.cp-legacy-adopted', 'sessions'], 'shared root retired after adoption');

    // A second conversation must NOT inherit the legacy work (adoption is one-time).
    const second = await run({ cmd: 'ls -A', session: 'conv-new' });
    assert.doesNotMatch(second.stdout, /myproject|notes\.txt/, 'later sessions start clean');
  } finally {
    child.kill('SIGKILL');
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});
