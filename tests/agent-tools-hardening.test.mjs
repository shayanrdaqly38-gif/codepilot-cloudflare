import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyEdits,
  applyPatchTransaction,
  applyUnifiedDiff,
  hashContent
} from '../functions/_lib/patch.js';
import { buildSmartFileRead } from '../functions/_lib/token-optimizer.js';
import {
  formatFileList,
  formatSearchHits,
  formatSymbols,
  listSymbols,
  listWorkspaceFiles,
  searchWorkspace,
  searchWorkspaceStream
} from '../functions/_lib/search.js';
import { fetchExternalUrl, searchWeb } from '../functions/_lib/web.js';
import { composeImageWithSvgTextOverlay, detectTextRequestInPrompt, generateAndStoreImage } from '../functions/_lib/image.js';
import { runCommand, validateCommandCwd } from '../functions/_lib/sandbox.js';
import {
  analyzeUndoConflict,
  getVersion,
  recordVersion
} from '../functions/_lib/versions.js';
import * as versionsApi from '../functions/api/state/versions/index.js';
import * as imageByIdApi from '../functions/api/images/[id].js';
import * as runApi from '../functions/api/run.js';
import * as chatApi from '../functions/api/chat.js';
import * as stateApi from '../functions/api/state/index.js';
import * as authApi from '../functions/api/auth.js';
import { getConversation, hydrateConversationWorkspace } from '../functions/_lib/store.js';
import { accessToken, ctx, makeEnv, req, rsaKeys } from './harness.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const sharedKeys = rsaKeys();

function installHybridFetch(extraHandler = null) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [sharedKeys.jwk] }), { status: 200 });
    }
    if (extraHandler) {
      const handled = await extraHandler(url, init);
      if (handled !== undefined) return handled;
    }
    if (u.startsWith('http://127.0.0.1:') || u.startsWith('http://localhost:')) {
      return nativeFetch(url, init);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

installHybridFetch();

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

async function startTestRunner({ token = 'test-secret-token-9999', extraEnv = {} } = {}) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'cp-hardening-runner-'));
  const port = 34000 + Math.floor(Math.random() * 15000);
  const child = spawn(process.execPath, ['runner-kit/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CP_PORT: String(port),
      CP_HOST: '127.0.0.1',
      CP_TOKEN: token,
      CP_WORKDIR: workDir,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await nativeFetch(`${baseUrl}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* waiting */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!ready) {
    child.kill('SIGKILL');
    await rm(workDir, { recursive: true, force: true });
    throw new Error('runner-kit failed to start within 8s');
  }

  return {
    baseUrl,
    token,
    workDir,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => {
        child.once('exit', r);
        setTimeout(r, 2000);
      });
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function signInUser(env, email = 'hardening@example.com') {
  const jwt = accessToken(sharedKeys, { email, aud: 'aud-123' });
  const r = await authApi.onRequestPost(
    ctx(req('/api/auth', { method: 'POST', body: {}, headers: { 'Cf-Access-Jwt-Assertion': jwt } }), env)
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return {
    cookie,
    jwt,
    authHeaders: { cookie, 'Cf-Access-Jwt-Assertion': jwt },
    owner: body.user?.id || 'https://team.cloudflareaccess.com|user-1'
  };
}

/* ==========================================================================
 * 1. run_command (runner-kit async jobs, disconnect survival, cancel, timeout,
 *    large output pagination, cwd safety, permission preservation, redaction)
 * ========================================================================== */

test('1. run_command: async jobs lifecycle, client disconnect survival, paginated large output, safe cancel, timeout, cwd & secret protection', async () => {
  installHybridFetch();
  const runner = await startTestRunner({
    token: 'runner-super-secret-xyz123',
    extraEnv: { DEV_PROJECT_ENV: 'dev-grade-ok' }
  });
  try {
    const env = makeEnv(sharedKeys, {
      SANDBOX_URL: `${runner.baseUrl}/run`,
      SANDBOX_TOKEN: runner.token,
      MODEL_API_KEY: 'sk-supersecretmodelkey9876543210'
    });
    const workspace = { files: { 'src/hello.txt': 'initial\n' } };

    // 1a. Start async job that writes a file and completes after a brief delay,
    //     plus disconnect a polling client mid-flight to verify the job survives disconnect!
    const started = await runCommand(env, {
      action: 'start',
      command: 'sleep 0.35 && echo "job-done-marker" && echo "updated-by-job" > src/created.txt',
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(started.ok, true);
    assert.ok(started.jobId);
    assert.equal(started.running, true);
    assert.equal(started.persistence?.survivesClientDisconnect, true);
    assert.equal(started.persistence?.survivesForceStopOrReboot, false);

    // Simulate client disconnecting an HTTP request mid-flight via AbortController
    const disconnectAc = new AbortController();
    disconnectAc.abort();
    const abortedPoll = await runCommand(env, {
      action: 'status',
      jobId: started.jobId,
      externalSignal: disconnectAc.signal,
      conversationId: 'conv_async_1'
    });
    assert.equal(abortedPoll.mode, 'stopped');

    // Job must STILL survive and finish cleanly!
    let finalPoll = null;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      finalPoll = await runCommand(env, {
        action: 'status',
        jobId: started.jobId,
        workspace,
        conversationId: 'conv_async_1'
      });
      if (!finalPoll.running) break;
    }
    assert.equal(finalPoll.status, 'completed');
    assert.equal(finalPoll.exitCode, 0);
    assert.ok(finalPoll.durationMs >= 200);
    assert.match(finalPoll.output, /job-done-marker/);
    assert.equal(workspace.files['src/created.txt']?.trim(), 'updated-by-job');

    // 1b. Large output pagination (> 50KB stdout) with explicit truncation & continuation
    const bigRun = await runCommand(env, {
      command:
        'node -e "for (let i = 0; i < 1600; i++) console.log(\'LINE_\' + String(i).padStart(4, \'0\') + \'_\' + \'X\'.repeat(30))"',
      limit: 4000,
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(bigRun.ok, true);
    assert.ok(bigRun.jobId);
    assert.equal(bigRun.truncated, true);
    assert.equal(bigRun.hasMore, true);
    assert.match(bigRun.text, /OUTPUT TRUNCATED/);
    assert.match(bigRun.text, /offset:/);

    let fullStdout = '';
    let offset = 0;
    let pages = 0;
    while (pages < 40) {
      const page = await runCommand(env, {
        action: 'status',
        jobId: bigRun.jobId,
        stream: 'stdout',
        offset,
        limit: 4000,
        conversationId: 'conv_async_1'
      });
      assert.equal(page.ok, true);
      fullStdout += page.output;
      pages += 1;
      if (!page.hasMore) break;
      assert.ok(page.nextOffset > offset, 'nextOffset must strictly advance');
      offset = page.nextOffset;
    }
    assert.ok(pages >= 10, `expected >= 10 pages, got ${pages}`);
    assert.match(fullStdout, /LINE_0000_/);
    assert.match(fullStdout, /LINE_1599_/);

    // 1c. Safe cancellation kills ENTIRE process group (parent + spawned grandchild!)
    const pidFile = path.join(runner.workDir, 'sessions', 'conv_async_1', 'grandchild.pid');
    const longJob = await runCommand(env, {
      action: 'start',
      command: 'sleep 45 & echo $! > grandchild.pid && wait',
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(longJob.running, true);
    let grandchildPid = 0;
    for (let i = 0; i < 25; i += 1) {
      try {
        const raw = await readFile(pidFile, 'utf8');
        grandchildPid = Number(raw.trim());
        if (grandchildPid > 0) break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(grandchildPid > 0, 'grandchild PID should be recorded');

    const cancelled = await runCommand(env, {
      action: 'cancel',
      jobId: longJob.jobId,
      conversationId: 'conv_async_1'
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelled, true);

    await new Promise((r) => setTimeout(r, 150));
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') grandchildAlive = false;
    }
    assert.equal(grandchildAlive, false, 'grandchild process must be terminated on cancel');

    // 1d. Timeout enforcement preserves timedOut, exitCode=124, durationMs
    const timedOut = await runCommand(env, {
      command: 'sleep 10',
      timeoutMs: 600,
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.status, 'timed_out');
    assert.equal(timedOut.exitCode, 124);
    assert.ok(timedOut.durationMs >= 500);

    // 1e. Safe cwd validation + symlink escape blocking + permission preservation + secret redaction
    assert.equal(validateCommandCwd('../etc').ok, false);
    assert.equal(validateCommandCwd('/etc').ok, false);
    assert.equal(validateCommandCwd('src/sub').ok, true);

    const badCwd = await runCommand(env, {
      command: 'pwd',
      cwd: '../../etc',
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(badCwd.ok, false);
    assert.equal(badCwd.mode, 'blocked');

    // Symlink inside session pointing to os.tmpdir() must be blocked by runner's realpath cwd check
    const sessionDir = path.join(runner.workDir, 'sessions', 'conv_async_1');
    await symlink(os.tmpdir(), path.join(sessionDir, 'escape-link'));
    const escapeRes = await nativeFetch(`${runner.baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runner.token}` },
      body: JSON.stringify({ cmd: 'pwd', cwd: 'escape-link', session: 'conv_async_1' })
    });
    assert.equal(escapeRes.status, 400);

    // File permission preservation when incoming files overwrite an executable script
    const scriptPath = path.join(sessionDir, 'run.sh');
    await writeFile(scriptPath, '#!/bin/sh\necho v1\n', 'utf8');
    await chmod(scriptPath, 0o755);
    workspace.files['run.sh'] = '#!/bin/sh\necho v2\n';
    const permRun = await runCommand(env, {
      command: './run.sh',
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(permRun.ok, true);
    assert.match(permRun.stdout, /v2/);
    const afterMode = (await stat(scriptPath)).mode & 0o777;
    assert.equal(afterMode, 0o755, 'POSIX executable permissions must be preserved');

    // Secret protection: child process cannot read CP_TOKEN, developer's own env vars still work,
    // and echoed secrets are redacted in logs/output
    const secretProbe = await runCommand(env, {
      command:
        'echo "env_tok=$CP_TOKEN" && echo "dev_env=$DEV_PROJECT_ENV" && echo "Authorization: Bearer abcdefghijklmnop1234567890" && echo "Cookie: session=supersecretval"',
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(secretProbe.ok, true);
    assert.match(secretProbe.stdout, /env_tok=\s*$/m, 'CP_TOKEN must be stripped from child env');
    assert.match(secretProbe.stdout, /dev_env=dev-grade-ok/, 'developer env vars must remain available');
    assert.doesNotMatch(secretProbe.stdout, /runner-super-secret-xyz123/);
    assert.doesNotMatch(secretProbe.stdout, /abcdefghijklmnop1234567890/);
    assert.doesNotMatch(secretProbe.stdout, /supersecretval/);
    assert.match(secretProbe.stdout, /Bearer \[REDACTED\]/);
    assert.match(secretProbe.stdout, /Cookie: \[REDACTED\]/);

    // Command containing server secret is blocked before reaching runner
    const leakAttempt = await runCommand(env, {
      command: 'echo sk-supersecretmodelkey9876543210',
      workspace,
      conversationId: 'conv_async_1'
    });
    assert.equal(leakAttempt.ok, false);
    assert.equal(leakAttempt.mode, 'blocked');

    // Stateless virtual tier honestly reports unsupported for async jobs
    const statelessEnv = makeEnv(sharedKeys, { LINUX_RUNNER: 'off' });
    const unsupportedAsync = await runCommand(statelessEnv, {
      action: 'start',
      command: 'ls',
      workspace
    });
    assert.equal(unsupportedAsync.ok, false);
    assert.equal(unsupportedAsync.unsupported, true);
    assert.match(unsupportedAsync.text, /stateless|SANDBOX_URL/i);

    // /api/run HTTP endpoint exposes async start/status/list cleanly
    const { authHeaders } = await signInUser(env);
    const httpStart = await runApi.onRequestPost(
      ctx(
        req('/api/run', {
          method: 'POST',
          headers: authHeaders,
          body: { action: 'start', command: 'echo hi-http', workspace: { files: {} } }
        }),
        env
      )
    );
    assert.ok([200, 202].includes(httpStart.status));
    const httpData = await httpStart.json();
    assert.ok(httpData.jobId);
  } finally {
    await runner.stop();
  }
});

test('1b. runner-kit reports explicit Termux/Android force-stop limitation when TERMUX_VERSION is present', async () => {
  const runner = await startTestRunner({
    token: 'termux-tok-12345',
    extraEnv: { TERMUX_VERSION: '0.118.0' }
  });
  try {
    const res = await nativeFetch(`${runner.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${runner.token}` }
    });
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.runner, 'termux');
    assert.equal(info.persistence.environment, 'termux-android');
    assert.equal(info.persistence.survivesClientDisconnect, true);
    assert.equal(info.persistence.survivesForceStopOrReboot, false);
    assert.match(info.persistence.notice, /force-stop|low-memory killer|shutdown/i);
  } finally {
    await runner.stop();
  }
});

/* ==========================================================================
 * 2. apply_patch (unifiedDiff, conflict/ambiguity refusal, dryRun,
 *    transactional multi-file rollback, BOM/CRLF preservation)
 * ========================================================================== */

test('2. apply_patch: unifiedDiff, strict conflict/ambiguity refusal, dryRun, atomic multi-file rollback, and BOM/CRLF preservation', () => {
  // 2a. UTF-8 BOM + CRLF preservation
  const bomCrlf = '\uFEFFconst a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n';
  const expectedBeforeHash = hashContent(bomCrlf);
  const patched = applyEdits(bomCrlf, [{ search: 'const b = 2;', replace: 'const b = 200;\nconst b2 = 201;' }], {
    expectedHash: expectedBeforeHash
  });
  assert.ok(patched.content.startsWith('\uFEFF'), 'UTF-8 BOM must be preserved');
  assert.ok(patched.content.includes('const b = 200;\r\nconst b2 = 201;\r\n'), 'CRLF line endings must be preserved');
  assert.ok(!patched.content.replace(/\r\n/g, '').includes('\n'), 'must not mix LF into CRLF file');

  // 2b. External modification conflict (expectedHash mismatch) stops immediately
  assert.throws(
    () =>
      applyEdits(bomCrlf, [{ search: 'const a = 1;', replace: 'const a = 9;' }], {
        expectedHash: 'deadbeef00000000'
      }),
    (err) => err.code === 'patch_conflict'
  );

  // 2c. Ambiguous / non-unique match stops without guessing
  const dupContent = 'const x = 1;\nfoo();\nconst x = 1;\n';
  assert.throws(
    () => applyEdits(dupContent, [{ search: 'const x = 1;', replace: 'const x = 2;' }]),
    (err) => err.code === 'patch_failed' && /2 بار/.test(err.message)
  );

  // 2d. Unified diff application (valid context + rejection on bad context)
  const original = 'line1\nline2\nline3\nline4\nline5\n';
  const validPatch = [
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1,5 +1,5 @@',
    ' line1',
    '-line2',
    '+line2_edited',
    ' line3',
    ' line4',
    ' line5'
  ].join('\n');
  const diffApplied = applyUnifiedDiff(original, validPatch, { path: 'demo.txt' });
  assert.equal(diffApplied.content, 'line1\nline2_edited\nline3\nline4\nline5\n');
  assert.equal(diffApplied.stats.added, 1);
  assert.equal(diffApplied.stats.removed, 1);

  const badContextPatch = validPatch.replace(' line3', ' WRONG_CONTEXT');
  assert.throws(
    () => applyUnifiedDiff(original, badContextPatch, { path: 'demo.txt' }),
    (err) => err.code === 'patch_conflict' || err.code === 'patch_failed'
  );

  // 2e. Dry-run preview leaves files completely untouched
  const wsFiles = {
    'a.js': 'export const a = 1;\n',
    'b.js': 'export const b = 2;\n',
    'c.js': 'export const c = 3;\n'
  };
  const preview = applyPatchTransaction(
    wsFiles,
    [
      { path: 'a.js', edits: [{ search: 'a = 1', replace: 'a = 10' }] },
      { path: 'b.js', edits: [{ search: 'b = 2', replace: 'b = 20' }] }
    ],
    { dryRun: true }
  );
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.files.length, 2);
  assert.equal(wsFiles['a.js'], 'export const a = 1;\n');
  assert.equal(wsFiles['b.js'], 'export const b = 2;\n');

  // 2f. Transactional multi-file rollback: failure on file #3 leaves #1 and #2 untouched
  assert.throws(
    () =>
      applyPatchTransaction(wsFiles, [
        { path: 'a.js', edits: [{ search: 'a = 1', replace: 'a = 99' }] },
        { path: 'b.js', edits: [{ search: 'b = 2', replace: 'b = 88' }] },
        { path: 'c.js', edits: [{ search: 'DOES_NOT_EXIST', replace: 'x' }] }
      ]),
    (err) => err.extra?.rolledBack === true && err.extra?.failedPath === 'c.js'
  );
  assert.equal(wsFiles['a.js'], 'export const a = 1;\n', 'file #1 must be rolled back');
  assert.equal(wsFiles['b.js'], 'export const b = 2;\n', 'file #2 must be rolled back');

  // 2g. Successful atomic commit updates all files and reports detailed diffs
  const committed = applyPatchTransaction(wsFiles, [
    { path: 'a.js', edits: [{ search: 'a = 1', replace: 'a = 11' }] },
    { path: 'b.js', edits: [{ search: 'b = 2', replace: 'b = 22' }] }
  ]);
  assert.equal(committed.ok, true);
  assert.equal(wsFiles['a.js'], 'export const a = 11;\n');
  assert.equal(wsFiles['b.js'], 'export const b = 22;\n');
  assert.equal(committed.totalAdded, 2);
  assert.equal(committed.totalRemoved, 2);
});

/* ==========================================================================
 * 3. read_file (paginated large files, reliable line numbers, cursor,
 *    no duplicate lines across pages, long-line char pagination, invalid range)
 * ========================================================================== */

test('3. read_file: paginated large file with reliable line numbers, zero overlap across cursor pages, long-line char paging, and invalid range errors', () => {
  // 3a. Large 400-line file walked end-to-end with cursor + limit + withLineNumbers
  const lines = Array.from({ length: 400 }, (_, i) => `const line_${i + 1} = ${i + 1}; // payload`);
  const content = lines.join('\n');

  const seenLineNums = [];
  let cursor = 'L1';
  let pages = 0;
  while (cursor && pages < 20) {
    const page = buildSmartFileRead('src/big.js', content, {
      cursor,
      limit: 80,
      withLineNumbers: true,
      tokenSaver: 'max'
    });
    assert.equal(page.ok, true);
    assert.equal(page.mode, 'ranged');
    for (const row of page.text.split('\n')) {
      const m = /^\s*(\d+)\s*\|\s+const line_(\d+) =/.exec(row);
      if (m) {
        assert.equal(Number(m[1]), Number(m[2]), 'line number prefix must exactly match actual line');
        seenLineNums.push(Number(m[1]));
      }
    }
    cursor = page.meta.nextCursor || null;
    pages += 1;
  }
  assert.equal(seenLineNums.length, 400, 'must cover all 400 lines without dropping any');
  assert.equal(new Set(seenLineNums).size, 400, 'must never repeat a line across pages');
  assert.equal(pages, 5);

  // 3b. Invalid range errors are reported explicitly
  const zeroStart = buildSmartFileRead('src/big.js', content, { startLine: 0, endLine: 10 });
  assert.equal(zeroStart.ok, false);
  assert.equal(zeroStart.mode, 'error');
  assert.match(zeroStart.text, /invalid startLine/i);

  const reversedRange = buildSmartFileRead('src/big.js', content, { startLine: 50, endLine: 10 });
  assert.equal(reversedRange.ok, false);
  assert.match(reversedRange.text, /endLine must be >= startLine/i);

  const pastEof = buildSmartFileRead('src/big.js', content, { startLine: 500 });
  assert.equal(pastEof.ok, false);
  assert.match(pastEof.text, /out of bounds/i);

  // 3c. Single huge minified line paginated cleanly by charOffset + nextCursor (`L1:C...`)
  const minified = 'A'.repeat(2500) + 'B'.repeat(2500) + 'C'.repeat(2500);
  const chunks = [];
  let charCursor = null;
  let lastPage = null;
  for (let i = 0; i < 10; i += 1) {
    lastPage = buildSmartFileRead(
      'dist/min.js',
      minified,
      charCursor ? { cursor: charCursor, maxChars: 2500 } : { startLine: 1, endLine: 1, maxChars: 2500 }
    );
    assert.equal(lastPage.ok, true);
    assert.ok(lastPage.text.length <= 2500, 'each page must stay within maxChars ceiling');
    chunks.push(lastPage.text);
    charCursor = lastPage.meta.nextCursor || null;
    if (!charCursor) break;
  }
  assert.ok(chunks.length >= 4, '7500-char line with 2500 maxChars ceiling should span >= 4 chunks');
  assert.equal(lastPage.meta.truncated, false);
  assert.equal(lastPage.meta.nextCursor, undefined);
  const combinedText = chunks.join('\n');
  assert.match(combinedText, /A{100}/);
  assert.match(combinedText, /B{100}/);
  assert.match(combinedText, /C{100}/);

  // 3d. Explicit developer-grade large range (600 lines / 60KB) is honored without artificial 360-line clamp
  const devFile = Array.from({ length: 600 }, (_, i) => `export const item_${i + 1} = "${'z'.repeat(40)}";`).join('\n');
  const devRead = buildSmartFileRead('src/dev-large.js', devFile, {
    startLine: 1,
    limit: 600,
    maxChars: 60_000
  });
  assert.equal(devRead.ok, true);
  assert.equal(devRead.meta.truncated, false);
  assert.equal(devRead.meta.endLine, 600);
  assert.ok(devRead.text.length > 25_000);
});

/* ==========================================================================
 * 4. undo_edit (metadata, preview, group/batch rollback, conflict detection)
 * ========================================================================== */

test('4. undo_edit & /api/state/versions: preview before restore, batch group rollback, and post-edit conflict protection (409 unless force)', async () => {
  installHybridFetch();
  const env = makeEnv(sharedKeys);
  const { authHeaders, owner } = await signInUser(env);
  const convRes = await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        headers: authHeaders,
        body: {
          action: 'create',
          title: 'Undo Test',
          workspace: {
            files: { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n' }
          }
        }
      }),
      env
    )
  );
  const createdConv = await convRes.json();
  const conversation = { id: createdConv.id, workspace: { files: { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n' } } };

  // Record a multi-file batch simulating an atomic edit of a.js and b.js
  const batchId = 'batch_test_group_01';
  const vA = await recordVersion(env, owner, conversation, {
    path: 'a.js',
    content: 'const a = 1;\n',
    afterHash: hashContent('const a = 10;\n'),
    existed: true,
    batchId,
    reason: 'before-batch-patch',
    meta: { note: 'multi-file refactor' }
  });
  const vB = await recordVersion(env, owner, conversation, {
    path: 'b.js',
    content: 'const b = 2;\n',
    afterHash: hashContent('const b = 20;\n'),
    existed: true,
    batchId,
    reason: 'before-batch-patch'
  });

  // Verify metadata & batch listing via HTTP GET
  const batchGet = await versionsApi.onRequestGet(
    ctx(req(`/api/state/versions?batchId=${batchId}`, { headers: authHeaders }), env)
  );
  assert.equal(batchGet.status, 200);
  const batchBody = await batchGet.json();
  assert.equal(batchBody.versions.length, 2);
  assert.equal(batchBody.versions[0].batchId, batchId);

  // Update workspace to post-patch state (matches after_hash -> no conflict)
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        headers: authHeaders,
        body: {
          action: 'workspace',
          id: conversation.id,
          workspace: { files: { 'a.js': 'const a = 10;\n', 'b.js': 'const b = 20;\n' } }
        }
      }),
      env
    )
  );

  // Preview batch restore BEFORE applying (must NOT modify workspace)
  const previewRes = await versionsApi.onRequestPost(
    ctx(
      req('/api/state/versions', {
        method: 'POST',
        headers: authHeaders,
        body: { action: 'preview', batchId, conversationId: conversation.id }
      }),
      env
    )
  );
  assert.equal(previewRes.status, 200);
  const previewData = await previewRes.json();
  assert.equal(previewData.preview, true);
  assert.equal(previewData.hasConflicts, false);
  assert.equal(previewData.files.length, 2);

  // Now externally modify b.js after the batch edit -> creates a conflict!
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        headers: authHeaders,
        body: {
          action: 'workspace',
          id: conversation.id,
          workspace: { files: { 'a.js': 'const a = 10;\n', 'b.js': 'const b = 999; // manual edit\n' } }
        }
      }),
      env
    )
  );

  // Conflict check must block restore (HTTP 409) and leave BOTH files untouched!
  const conflictRes = await versionsApi.onRequestPost(
    ctx(
      req('/api/state/versions', {
        method: 'POST',
        headers: authHeaders,
        body: { action: 'restore', batchId, conversationId: conversation.id }
      }),
      env
    )
  );
  assert.equal(conflictRes.status, 409);
  const conflictPayload = await conflictRes.json();
  assert.equal(conflictPayload.code, 'undo_conflict');
  assert.equal(conflictPayload.details.conflicts.length, 1);
  assert.equal(conflictPayload.details.conflicts[0].path, 'b.js');

  // Verify a.js was NOT half-restored
  const midConv = await getConversation(env, owner, conversation.id);
  const midWs = await hydrateConversationWorkspace(env, midConv);
  assert.equal(midWs.files['a.js'], 'const a = 10;\n');
  assert.equal(midWs.files['b.js'], 'const b = 999; // manual edit\n');

  // Confirmed restore with force: true rolls back the entire batch atomically!
  const forceRes = await versionsApi.onRequestPost(
    ctx(
      req('/api/state/versions', {
        method: 'POST',
        headers: authHeaders,
        body: { action: 'restore', batchId, conversationId: conversation.id, force: true }
      }),
      env
    )
  );
  assert.equal(forceRes.status, 200);
  const forceData = await forceRes.json();
  assert.equal(forceData.files.length, 2);
  assert.equal(forceData.workspace.files['a.js'], 'const a = 1;\n');
  assert.equal(forceData.workspace.files['b.js'], 'const b = 2;\n');

  // Direct analyzeUndoConflict check
  const verA = await getVersion(env, owner, vA);
  const drift = analyzeUndoConflict(verA, 'const a = 777;\n', true);
  assert.equal(drift.hasConflict, true);
  assert.ok(vB);
});

/* ==========================================================================
 * 5. search_code (streaming large repo, glob/exclude/.gitignore/binary/size,
 *    ReDoS protection, contextLines, pagination)
 * ========================================================================== */

test('5. search_code: streaming search on large repo, glob/exclude/.gitignore/binary/size transparency, contextLines, ReDoS guard, and pagination', async () => {
  const files = {
    '.gitignore': 'ignored-dir/\n*.log\n',
    'ignored-dir/secret.js': 'const TARGET_TOKEN = "from ignored";\n',
    'debug.log': 'TARGET_TOKEN in log file\n',
    'node_modules/pkg/index.js': 'const TARGET_TOKEN = "from node_modules";\n',
    'src/blob.js': 'PNG\x00\x01TARGET_TOKEN\x00binary',
    'src/huge.js': 'TARGET_TOKEN\n' + 'x'.repeat(1_200_000),
    'src/app.js': 'line1\nconst TARGET_TOKEN = "primary";\nline3\n'
  };
  for (let i = 0; i < 65; i += 1) {
    files[`src/mod_${String(i).padStart(2, '0')}.js`] = `// module ${i}\nexport const val_${i} = "TARGET_TOKEN_${i}";\n// footer ${i}\n`;
  }

  // 5a. Glob + exclude + contextLines + skipped stats transparency (oversized file skipped without aborting rest of repo)
  const res = searchWorkspace(files, 'TARGET_TOKEN', {
    glob: 'src/**/*.js',
    exclude: 'src/mod_00.js',
    contextLines: 1,
    maxFileChars: 200_000,
    offset: 0,
    limit: 10
  });
  assert.equal(res.results.length, 10);
  assert.equal(res.hasMore, true);
  assert.equal(res.nextOffset, 10);
  assert.ok(res.skipped.ignored.count >= 3, `expected >= 3 ignored files, got ${res.skipped.ignored.count}`);
  assert.ok(res.skipped.binary.count >= 1, 'expected binary file skipped');
  assert.ok(res.skipped.tooLarge.count >= 1, 'expected oversized file skipped');
  assert.equal(res.results[0].path, 'src/app.js');
  assert.equal(res.results[0].line, 2);
  assert.ok(res.results[0].column >= 1);
  assert.equal(res.results[0].before.length, 1);
  assert.equal(res.results[0].after.length, 1);

  const formatted = formatSearchHits(res);
  assert.match(formatted, /Skipped:/);
  assert.match(formatted, /offset: 10/);

  // 5b. Pagination walks consecutive pages with zero duplicate hits
  const page2 = searchWorkspace(files, 'TARGET_TOKEN', {
    glob: 'src/**/*.js',
    exclude: 'src/mod_00.js',
    maxFileChars: 200_000,
    offset: res.nextOffset,
    limit: 10
  });
  assert.equal(page2.results.length, 10);
  const p1Paths = new Set(res.results.map((h) => `${h.path}:${h.line}`));
  for (const hit of page2.results) {
    assert.ok(!p1Paths.has(`${hit.path}:${hit.line}`), 'page 2 must not repeat page 1 hits');
  }

  // 5c. Streaming search over an async iterable of [path, content] entries stops early once limit is reached
  async function* lazyEntries() {
    for (const [p, c] of Object.entries(files)) {
      yield [p, c];
    }
  }
  const streamed = await searchWorkspaceStream(lazyEntries(), 'TARGET_TOKEN', {
    glob: 'src/*.js',
    limit: 5
  });
  assert.equal(streamed.results.length, 5);
  assert.equal(streamed.hasMore, true);

  // 5d. Catastrophic ReDoS pattern rejected
  assert.throws(
    () => searchWorkspace(files, '(a+)+$', { regex: true }),
    (err) => err.code === 'unsafe_regex'
  );
});

/* ==========================================================================
 * 6. web_search & fetch_url (HTTP errors, redirects, cross-origin auth strip,
 *    cookie/token non-leakage, timeouts, size caps, binary, SPA JS detection,
 *    optional browser adapter, per-source search reporting)
 * ========================================================================== */

test('6. web_search & fetch_url: HTTP errors, redirects, cross-origin auth stripping, size/timeout/binary reporting, JS-SPA detection + browser adapter, and per-source search attribution', async () => {
  const seenRequests = [];

  installHybridFetch(async (url, opts = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    seenRequests.push({ url: u, headers, method: opts.method || 'GET' });

    if (u === 'https://origin-a.example/start') {
      return new Response('', {
        status: 302,
        headers: { location: 'https://origin-b.example/final' }
      });
    }
    if (u === 'https://origin-b.example/final') {
      return new Response(
        '<html><head><title>Final Page</title></head><body><nav>Nav Noise</nav><main><h1>Article Heading</h1><p>Readable body paragraph.</p></main><script>alert(1)</script></body></html>',
        {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': 'sid=LEAKED_SESSION_COOKIE_12345; HttpOnly'
          }
        }
      );
    }
    if (u === 'https://api.example/private') {
      return new Response('Unauthorized: missing token', {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'text/plain' }
      });
    }
    if (u === 'https://cdn.example/file.pdf') {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' }
      });
    }
    if (u === 'https://cdn.example/huge.txt') {
      return new Response('H'.repeat(300_000), {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      });
    }
    if (u === 'https://spa.example/app') {
      return new Response(
        '<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div><noscript>Please enable JavaScript to run this app.</noscript><script src="/static/main.js"></script><script src="/static/chunk.js"></script></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (u === 'https://renderer.example/render') {
      return new Response(
        JSON.stringify({
          html: '<html><head><title>Rendered SPA</title></head><body><main>Hydrated dynamic dashboard data</main></body></html>'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u === 'https://slow.example/hang') {
      const err = new Error('The operation timed out');
      err.name = 'TimeoutError';
      throw err;
    }
    if (u.startsWith('https://html.duckduckgo.com/') || u.startsWith('https://api.duckduckgo.com/')) {
      return new Response('Service Unavailable', { status: 503 });
    }
    if (u.startsWith('https://en.wikipedia.org/')) {
      return new Response(
        JSON.stringify({
          query: {
            search: [{ title: 'Cloudflare Workers', snippet: 'Serverless <b>edge</b> runtime' }]
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://hn.algolia.com/')) {
      return new Response(
        JSON.stringify({
          hits: [{ title: 'Workers AI benchmarks', url: 'https://news.ycombinator.com/item?id=1', points: 140, num_comments: 30 }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return undefined;
  });

  try {
    const env = makeEnv(sharedKeys);

    // 6a. Cross-origin redirect MUST strip Authorization header and never leak Set-Cookie or caller token!
    const redirRes = await fetchExternalUrl(env, {
      url: 'https://origin-a.example/start',
      headers: {
        Authorization: 'Bearer caller-secret-token-999999',
        Cookie: 'session=should-be-blocked'
      }
    });
    assert.equal(redirRes.ok, true);
    assert.equal(redirRes.source.redirected, true);
    assert.equal(redirRes.source.finalUrl, 'https://origin-b.example/final');
    assert.equal(redirRes.source.redirects.length, 1);
    assert.match(redirRes.text, /Readable body paragraph/);
    assert.doesNotMatch(redirRes.text, /Nav Noise/);
    assert.doesNotMatch(redirRes.text, /alert\(1\)/);
    assert.doesNotMatch(redirRes.text, /LEAKED_SESSION_COOKIE_12345/);
    assert.doesNotMatch(redirRes.text, /caller-secret-token-999999/);
    assert.match(redirRes.contentType, /text\/html/);

    const firstHop = seenRequests.find((r) => r.url === 'https://origin-a.example/start');
    const secondHop = seenRequests.find((r) => r.url === 'https://origin-b.example/final');
    assert.equal(firstHop.headers.authorization, 'Bearer caller-secret-token-999999');
    assert.equal(firstHop.headers.cookie, undefined, 'Cookie header must be blocked');
    assert.equal(secondHop.headers.authorization, undefined, 'Authorization MUST be stripped across origins');

    // 6b. 401 reports authRequired explicitly and never bypasses auth
    const unauth = await fetchExternalUrl(env, { url: 'https://api.example/private' });
    assert.equal(unauth.ok, false);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.authRequired, true);
    assert.equal(unauth.httpError, true);
    assert.match(unauth.text, /authentication\/authorization required/i);

    // 6c. Binary payload reported cleanly with content type
    const bin = await fetchExternalUrl(env, { url: 'https://cdn.example/file.pdf' });
    assert.equal(bin.ok, true);
    assert.equal(bin.contentType, 'application/pdf');
    assert.match(bin.text, /Binary/i);

    // 6d. Size cap reports truncated & incomplete explicitly
    const huge = await fetchExternalUrl(env, { url: 'https://cdn.example/huge.txt', maxChars: 1500 });
    assert.equal(huge.ok, true);
    assert.equal(huge.truncated, true);
    assert.equal(huge.incomplete, true);
    assert.match(huge.text, /truncated/i);

    // 6e. Timeout reported explicitly
    const timed = await fetchExternalUrl(env, { url: 'https://slow.example/hang' });
    assert.equal(timed.ok, false);
    assert.equal(timed.errorType, 'timeout');
    assert.match(timed.text, /timed out/i);

    // 6f. JS-rendered SPA shell: without browser adapter reports honest limitation; with adapter renders hydrated DOM
    const spaNoBrowser = await fetchExternalUrl(env, { url: 'https://spa.example/app', renderJs: true });
    assert.equal(spaNoBrowser.jsRenderedLikely, true);
    assert.equal(spaNoBrowser.browserRenderingAvailable, false);
    assert.match(spaNoBrowser.text, /headless browser|JavaScript/i);

    const envWithBrowser = makeEnv(sharedKeys, { BROWSER_RENDERING_URL: 'https://renderer.example/render' });
    const spaRendered = await fetchExternalUrl(envWithBrowser, { url: 'https://spa.example/app', renderJs: true });
    assert.equal(spaRendered.ok, true);
    assert.equal(spaRendered.renderedWith, 'remote-browser-rendering');
    assert.match(spaRendered.text, /Hydrated dynamic dashboard data/);

    // 6g. web_search reports per-source attribution AND partial source failures transparently
    const searchRes = await searchWeb(env, { query: 'Cloudflare Workers', limit: 5 });
    assert.equal(searchRes.ok, true);
    assert.equal(searchRes.partial, true);
    assert.ok(searchRes.results.length >= 2);
    assert.equal(searchRes.sources.find((s) => s.name === 'duckduckgo-html')?.ok, false);
    assert.equal(searchRes.sources.find((s) => s.name === 'wikipedia-en')?.ok, true);
    assert.match(searchRes.text, /Source warnings:/);
    assert.match(searchRes.text, /duckduckgo-html/);
  } finally {
    installHybridFetch();
  }
});

/* ==========================================================================
 * 7. generate_image (honest text accuracy warning, post-generation RTL/Persian
 *    SVG text compositing, strict SVG CSP header, structured format/error info)
 * ========================================================================== */

test('7. generate_image: detects text requests honestly, composites RTL Persian SVG overlay with sandbox CSP, and reports format/dimensions/errors', async () => {
  installHybridFetch();
  const detText = detectTextRequestInPrompt('poster with Persian text "سلام دنیا" on dark background');
  assert.equal(detText.requestsText, true);
  assert.equal(detText.hasRtlText, true);
  const detNoText = detectTextRequestInPrompt('sunset over snowy mountains minimalist landscape');
  assert.equal(detNoText.requestsText, false);

  // Unit check of SVG RTL/Persian text overlay composition + XML escaping
  const fakeJpeg = new Uint8Array(128);
  fakeJpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01], 0);
  fakeJpeg[126] = 0xff;
  fakeJpeg[127] = 0xd9;
  const svgOverlay = composeImageWithSvgTextOverlay({
    bytes: fakeJpeg,
    mimeType: 'image/jpeg',
    width: 1024,
    height: 1024,
    overlayText: {
      text: 'سلام دنیا <کدپایلوت>\nتست راست‌به‌چپ & فونت',
      position: 'bottom',
      fontSize: 44
    }
  });
  assert.equal(svgOverlay.mimeType, 'image/svg+xml');
  assert.equal(svgOverlay.overlay.direction, 'rtl');
  assert.equal(svgOverlay.overlay.lines.length, 2);
  const svgStr = new TextDecoder().decode(svgOverlay.bytes);
  assert.match(svgStr, /direction="rtl"/);
  assert.match(svgStr, /xml:lang="fa"/);
  assert.match(svgStr, /unicode-bidi="plaintext"/);
  assert.match(svgStr, /Vazirmatn/);
  assert.match(svgStr, /&lt;کدپایلوت&gt;/);
  assert.match(svgStr, /&amp; فونت/);
  assert.doesNotMatch(svgStr, /<کدپایلوت>/);

  // Full end-to-end storage + HTTP serving with strict SVG sandbox CSP
  const env = makeEnv(sharedKeys, {
    AI: {
      async run() {
        return { image: Buffer.from(fakeJpeg).toString('base64') };
      }
    }
  });
  const { authHeaders, owner } = await signInUser(env);
  // Case A: Prompt requests Persian text WITHOUT overlayText -> must emit honest textAccuracyWarning
  const rawGen = await generateAndStoreImage(env, owner, {
    prompt: 'minimalist banner with typography text "سلام"',
    title: 'بنر خام',
    aspectRatio: '16:9'
  });
  assert.equal(rawGen.mimeType, 'image/jpeg');
  assert.ok(rawGen.textAccuracyWarning, 'must warn honestly about generative text accuracy when overlayText is absent');

  // Case B: Prompt WITH overlayText -> composites clean RTL SVG overlay + documents Workers limitation
  const stored = await generateAndStoreImage(env, owner, {
    prompt: 'minimalist banner with typography text "سلام"',
    title: 'بنر فارسی',
    aspectRatio: '16:9',
    overlayText: { text: 'سلام کدپایلوت', position: 'center' }
  });
  assert.equal(stored.mimeType, 'image/svg+xml');
  assert.equal(stored.overlayApplied, true);
  assert.equal(stored.width, 1344);
  assert.equal(stored.height, 768);
  assert.ok(stored.overlay?.limitationNote, 'must document Workers no-Canvas limitation honestly');

  const serveRes = await imageByIdApi.onRequestGet(
    ctx(req(`/api/images/${stored.id}?download=1`, { headers: authHeaders }), env, { id: stored.id })
  );
  assert.equal(serveRes.status, 200);
  assert.equal(serveRes.headers.get('content-type'), 'image/svg+xml');
  assert.match(serveRes.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.match(serveRes.headers.get('content-security-policy') || '', /sandbox/);
  assert.match(serveRes.headers.get('content-disposition') || '', /\.svg"/);

  // Structured error when all image engines fail
  const failingEnv = makeEnv(sharedKeys, { AI: null });
  installHybridFetch(async () => new Response('upstream unavailable', { status: 503 }));
  try {
    await assert.rejects(
      () => generateAndStoreImage(failingEnv, owner, { prompt: 'mountain lake at sunrise' }),
      (err) => err.code === 'image_generation_failed' && Array.isArray(err.extra?.attempts) && err.extra.attempts.length > 0
    );
  } finally {
    installHybridFetch();
  }
});

/* ==========================================================================
 * 8. list_files & list_symbols (large repo pagination, ignored paths, real
 *    OS symlink-loop & escape protection, 8 supported languages, explicit
 *    unsupported-language disclosure)
 * ========================================================================== */

test('8. list_files & list_symbols: paginated large repo, .gitignore/ignored filtering, real symlink-loop protection, multi-language symbols, and explicit unsupported-language disclosure', async () => {
  // 8a. Large repo pagination & ignored path handling in listWorkspaceFiles
  const workspace = {
    files: {
      '.gitignore': 'coverage/\n*.tmp\n',
      'coverage/report.html': '<h1>cov</h1>',
      'scratch.tmp': 'temp',
      'node_modules/a/index.js': 'export const nm = 1;',
      'src/app.ts': 'export interface User { id: string }\nexport async function fetchUser(id: string) { return id; }\n',
      'src/worker.py': 'class Pipeline:\n    pass\n\nasync def run_job(x):\n    return x\n',
      'src/main.go': 'type Server struct{}\nfunc (s *Server) Start() {}\n',
      'src/lib.rs': 'pub struct Engine {}\npub async fn execute() {}\n',
      'db/schema.sql': 'CREATE TABLE accounts (id TEXT);\nCREATE INDEX idx_acc ON accounts(id);\n',
      'legacy/App.java': 'public class App { public static void main(String[] args) {} }\n',
      'scripts/deploy.rb': 'def deploy; end\n'
    }
  };
  for (let i = 0; i < 120; i += 1) {
    workspace.files[`pkg/f_${String(i).padStart(3, '0')}.js`] = `export function fn_${i}() { return ${i}; }\n`;
  }

  const page1 = listWorkspaceFiles(workspace, { pathPrefix: 'pkg', offset: 0, limit: 25 });
  assert.equal(page1.files.length, 25);
  assert.equal(page1.matched, 120);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 25);
  assert.equal(page1.nextCursor, 'offset:25');
  assert.match(formatFileList(page1), /offset: 25/);

  const rootList = listWorkspaceFiles(workspace, { offset: 0, limit: 200 });
  assert.ok(rootList.skippedIgnored >= 3, 'must skip .gitignore and node_modules');
  assert.ok(!rootList.files.some((f) => f.path.startsWith('node_modules/') || f.path.startsWith('coverage/')));

  // 8b. Multi-language symbol extraction + pagination
  const symRes = listSymbols(workspace.files, { pathPrefix: 'src', limit: 20 });
  assert.ok(Array.isArray(symRes));
  const byPath = Object.fromEntries(symRes.map((entry) => [entry.path, entry.symbols.map((s) => `${s.kind}:${s.name}`)]));
  assert.ok(byPath['src/app.ts']?.includes('interface:User'));
  assert.ok(byPath['src/app.ts']?.includes('function:fetchUser'));
  assert.ok(byPath['src/worker.py']?.includes('class:Pipeline'));
  assert.ok(byPath['src/worker.py']?.includes('function:run_job'));
  assert.ok(byPath['src/main.go']?.includes('type:Server'));
  assert.ok(byPath['src/main.go']?.includes('function:Start'));
  assert.ok(byPath['src/lib.rs']?.includes('struct:Engine'));
  assert.ok(byPath['src/lib.rs']?.includes('function:execute'));

  const sqlSyms = listSymbols(workspace.files, { path: 'db/schema.sql' });
  assert.ok(sqlSyms[0]?.symbols.some((s) => s.name === 'accounts'));

  // 8c. Unsupported languages MUST NEVER return misleading empty output!
  const unsupportedOnly = listSymbols(
    { 'legacy/App.java': workspace.files['legacy/App.java'], 'scripts/deploy.rb': workspace.files['scripts/deploy.rb'] },
    {}
  );
  assert.equal(unsupportedOnly.length, 0);
  assert.equal(unsupportedOnly.unsupportedFiles.length, 2);
  const formattedUnsupported = formatSymbols(unsupportedOnly);
  assert.match(formattedUnsupported, /NOT supported/i);
  assert.match(formattedUnsupported, /App\.java/);
  assert.match(formattedUnsupported, /deploy\.rb/);
  assert.match(formattedUnsupported, /Supported languages:/);

  // 8d. Real filesystem symlink-loop & outside-root escape protection in runner-kit GET /files
  const runner = await startTestRunner({ token: 'symlink-test-tok-555' });
  try {
    const sessDir = path.join(runner.workDir, 'sessions', 'sym_sess');
    await mkdir(path.join(sessDir, 'a', 'b'), { recursive: true });
    await writeFile(path.join(sessDir, 'a', 'b', 'leaf.js'), 'export const ok = 1;\n', 'utf8');
    await mkdir(path.join(sessDir, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(sessDir, 'node_modules', 'dep', 'x.js'), 'x', 'utf8');
    // Symlink loop: a/b/loop -> ../../a
    await symlink(path.join(sessDir, 'a'), path.join(sessDir, 'a', 'b', 'loop'));
    // Symlink escaping workspace root -> os.tmpdir()
    await symlink(os.tmpdir(), path.join(sessDir, 'outside-escape'));

    const res = await nativeFetch(`${runner.baseUrl}/files?session=sym_sess&limit=50`, {
      headers: { Authorization: `Bearer ${runner.token}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.skippedSymlinkLoops, 1, 'must detect and skip symlink loop');
    assert.equal(data.skippedSymlinkEscapes, 1, 'must block symlink escaping workspace root');
    assert.ok(data.skippedIgnored >= 1, 'must skip node_modules');
    assert.ok(data.files.some((f) => f.path === 'a/b/leaf.js'));
  } finally {
    await runner.stop();
  }
});

/* ==========================================================================
 * 9. End-to-end /api/chat tool integration test verifying multi-file
 *    apply_patch + batch undo_edit conflict/force + read_file invalid range
 *    + list_symbols unsupported language through the real agent loop!
 * ========================================================================== */

test('9. End-to-end /api/chat: multi-file apply_patch (dryRun + commit), batch undo_edit conflict & force, invalid read_file range, and unsupported list_symbols', async () => {
  installHybridFetch();
  const env = makeEnv(sharedKeys, { MODEL_BASE_URL: 'https://model.example/v1' });
  const { authHeaders, owner } = await signInUser(env, 'e2e-hardening@example.com');
  const convRes = await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        headers: authHeaders,
        body: {
          action: 'create',
          title: 'E2E Tool Hardening',
          workspace: {
            files: {
              'a.js': 'export const a = 1;\n',
              'b.js': 'export const b = 2;\n',
              'App.java': 'class App {}\n'
            }
          }
        }
      }),
      env
    )
  );
  const createdConv = await convRes.json();
  const conversation = { id: createdConv.id };

  let step = 0;
  let capturedBatchId = '';

  installHybridFetch(async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    for (const msg of body.messages || []) {
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        const m = /batchId:\s*(batch_[a-f0-9]+)/.exec(msg.content);
        if (m) capturedBatchId = m[1];
      }
    }
    step += 1;

    const respondWithCalls = (calls) =>
      new Response(
        JSON.stringify({
          id: `chatcmpl-${step}`,
          model: 'test-model',
          choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: calls } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    if (step === 1) {
      return respondWithCalls([
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'a.js', startLine: 999 })
          }
        },
        {
          id: 'c2',
          type: 'function',
          function: {
            name: 'list_symbols',
            arguments: JSON.stringify({ path: 'App.java' })
          }
        },
        {
          id: 'c3',
          type: 'function',
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({
              dryRun: true,
              files: [
                { path: 'a.js', edits: [{ search: 'a = 1', replace: 'a = 10' }] },
                { path: 'b.js', edits: [{ search: 'b = 2', replace: 'b = 20' }] }
              ]
            })
          }
        }
      ]);
    }
    if (step === 2) {
      return respondWithCalls([
        {
          id: 'c4',
          type: 'function',
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({
              files: [
                { path: 'a.js', edits: [{ search: 'a = 1', replace: 'a = 10' }] },
                { path: 'b.js', edits: [{ search: 'b = 2', replace: 'b = 20' }] }
              ]
            })
          }
        }
      ]);
    }
    if (step === 3) {
      // Edit b.js again so rolling back capturedBatchId detects a post-edit conflict!
      return respondWithCalls([
        {
          id: 'c5',
          type: 'function',
          function: {
            name: 'apply_patch',
            arguments: JSON.stringify({
              path: 'b.js',
              edits: [{ search: 'b = 20', replace: 'b = 30' }]
            })
          }
        }
      ]);
    }
    if (step === 4) {
      return respondWithCalls([
        {
          id: 'c6',
          type: 'function',
          function: {
            name: 'undo_edit',
            arguments: JSON.stringify({ batchId: capturedBatchId })
          }
        }
      ]);
    }
    if (step === 5) {
      return respondWithCalls([
        {
          id: 'c7',
          type: 'function',
          function: {
            name: 'undo_edit',
            arguments: JSON.stringify({ batchId: capturedBatchId, force: true })
          }
        }
      ]);
    }
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${step}`,
        model: 'test-model',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'تمام آزمایش‌ها با موفقیت انجام و بازگردانی شدند.' } }]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  try {
    const res = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: authHeaders,
          body: { conversationId: conversation.id, message: 'تست ابزارهای ارتقایافته' }
        }),
        env
      )
    );
    assert.equal(res.status, 200);
    const events = await parseSse(res);
    const results = events.filter((e) => e.event === 'tool_result').map((e) => e.data);

    // c1: invalid range error
    const r1 = results.find((r) => r.id === 'c1');
    assert.equal(r1.ok, false);
    assert.match(r1.result, /out of bounds/i);

    // c2: unsupported symbol language explicitly stated
    const r2 = results.find((r) => r.id === 'c2');
    assert.equal(r2.ok, true);
    assert.match(r2.result, /NOT supported/i);

    // c3: dryRun preview succeeded without modifying files
    const r3 = results.find((r) => r.id === 'c3');
    assert.equal(r3.ok, true);
    assert.match(r3.result, /Dry-run preview succeeded/);

    // c4: transactional multi-file commit produced a batchId
    const r4 = results.find((r) => r.id === 'c4');
    assert.equal(r4.ok, true);
    assert.ok(capturedBatchId.startsWith('batch_'));

    // c6: conflict blocked blind overwrite
    const r6 = results.find((r) => r.id === 'c6');
    assert.equal(r6.ok, false);
    assert.match(r6.result, /Undo aborted/i);

    // c7: force: true restored both files to original state
    const r7 = results.find((r) => r.id === 'c7');
    assert.equal(r7.ok, true);
    assert.match(r7.result, /Batch rollback/);

    const finalConv = await getConversation(env, owner, conversation.id);
    const finalWs = await hydrateConversationWorkspace(env, finalConv);
    assert.equal(finalWs.files['a.js'], 'export const a = 1;\n');
    assert.equal(finalWs.files['b.js'], 'export const b = 2;\n');
  } finally {
    installHybridFetch();
  }
});
