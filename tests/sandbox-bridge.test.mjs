import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { rsaKeys, accessToken, makeEnv, req, ctx } from './harness.mjs';
import * as configApi from '../functions/api/config.js';
import * as runApi from '../functions/api/run.js';
import * as chatApi from '../functions/api/chat.js';
import * as stateApi from '../functions/api/state/index.js';
import * as convDetailApi from '../functions/api/state/conversations/[id].js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = path.resolve(__dirname, '../runner-kit/server.mjs');
const realFetch = globalThis.fetch;

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

async function startLiveRunner(token) {
  const port = await getFreePort();
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'cp-runner-test-'));
  const child = spawn(process.execPath, [RUNNER_SCRIPT], {
    env: {
      ...process.env,
      CP_HOST: '127.0.0.1',
      CP_PORT: String(port),
      CP_TOKEN: token,
      CP_WORKDIR: workDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await realFetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // wait for server boot
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!ready) {
    child.kill('SIGKILL');
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('runner-kit/server.mjs failed to start');
  }

  return {
    port,
    baseUrl,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 1000);
      });
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function parseSSEText(raw) {
  const events = [];
  for (const chunk of String(raw || '').split('\n\n')) {
    let event = 'message';
    let dataStr = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) continue;
    try {
      events.push({ event, data: JSON.parse(dataStr) });
    } catch {
      // ignore malformed
    }
  }
  return events;
}

test('runner-kit/server.mjs: enforces Bearer auth, supports Android Chrome PNA CORS, executes shell, and returns bidirectional file diffs', async () => {
  const token = 'cp_live_runner_secret_12345';
  const runner = await startLiveRunner(token);
  try {
    // 1. Preflight Private Network Access (HTTPS Cloudflare Pages -> http://127.0.0.1:8787)
    const preflight = await realFetch(`${runner.baseUrl}/run`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://codepilot.pages.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://codepilot.pages.dev');
    assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'), 'true');

    // 2. Unauthenticated requests rejected
    const unauth = await realFetch(`${runner.baseUrl}/health`);
    assert.equal(unauth.status, 401);

    // 3. Authenticated /health
    const healthRes = await realFetch(`${runner.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.ok(health.node.startsWith('v'));

    // 4. Execute command that modifies hello.txt, creates sub/gen.json, and deletes legacy.txt
    const runRes = await realFetch(`${runner.baseUrl}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cmd: `node -e "const fs=require('fs'); fs.mkdirSync('sub',{recursive:true}); fs.writeFileSync('sub/gen.json', JSON.stringify({sum: 21*2})); fs.writeFileSync('hello.txt', 'updated!'); fs.unlinkSync('legacy.txt'); console.log('RUNNER_OK');"`,
        files: {
          'hello.txt': 'initial',
          'keep.txt': 'untouched',
          'legacy.txt': 'remove-me',
          '../escape.txt': 'blocked'
        }
      })
    });
    assert.equal(runRes.status, 200);
    const out = await runRes.json();
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /RUNNER_OK/);
    assert.deepEqual(out.changedFiles, {
      'hello.txt': 'updated!',
      'sub/gen.json': '{"sum":42}'
    });
    assert.deepEqual(out.deletedFiles, ['legacy.txt']);
  } finally {
    await runner.stop();
  }
});

test('Method 2 (24/7 Cloud Sandbox) & Method 3 (Direct Local Termux 127.0.0.1 Bridge): encrypted D1 config, SSRF guards, live /api/run probe, and bidirectional AI agent run_command loop', async () => {
  const keys = rsaKeys();
  const jwt = accessToken(keys);
  const authHdr = { 'Cf-Access-Jwt-Assertion': jwt };
  const cloudToken = 'cp_hf_space_token_998877';
  const runner = await startLiveRunner(cloudToken);
  const env = makeEnv(keys);

  let modelStep = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [keys.jwk] }), { status: 200 });
    }
    // Proxy simulated public HTTPS Hugging Face Space URL directly to our live local runner-kit server!
    if (u.startsWith('https://demo-runner.hf.space')) {
      const target = u.replace('https://demo-runner.hf.space', runner.baseUrl);
      return realFetch(target, init);
    }
    if (u.includes('/chat/completions')) {
      modelStep += 1;
      const body = JSON.parse(init.body || '{}');
      if (modelStep === 1) {
        // Method 2 turn: model invokes run_command on 24/7 Cloud Runner
        return new Response(
          JSON.stringify({
            id: 'cmpl-m2-1',
            model: 'claude-sonnet-5-5',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_cloud_1',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({
                          command: `node -e "require('fs').writeFileSync('cloud-built.txt', 'built-in-hf-docker'); console.log('HF_DOCKER_OK')"`
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (modelStep === 2) {
        const lastTool = body.messages.filter((m) => m.role === 'tool').at(-1);
        assert.match(lastTool.content, /HF_DOCKER_OK/, 'model received stdout from 24/7 cloud runner');
        return new Response(
          JSON.stringify({
            id: 'cmpl-m2-2',
            model: 'claude-sonnet-5-5',
            choices: [{ message: { role: 'assistant', content: 'اجرا روی سرور ۲۴ ساعته انجام شد.' }, finish_reason: 'stop' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (modelStep === 3) {
        // Method 3 turn (Wave 1): model writes a script AND calls run_command for Local Termux Bridge
        return new Response(
          JSON.stringify({
            id: 'cmpl-m3-1',
            model: 'claude-sonnet-5-5',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_write_local',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'calc.js',
                          content: `const fs = require('fs');\nfs.writeFileSync('termux-out.txt', '7*6=' + (7*6));\nconsole.log('TERMUX_EXEC_42');\n`
                        })
                      }
                    },
                    {
                      id: 'call_termux_1',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({ command: 'node calc.js' })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (modelStep === 4) {
        // Method 3 turn (Wave 2 after browser ran command on 127.0.0.1:8787)
        const lastTool = body.messages.filter((m) => m.role === 'tool').at(-1);
        assert.match(lastTool.content, /Real Local Termux execution/, 'tool result labeled as Local Termux execution');
        assert.match(lastTool.content, /TERMUX_EXEC_42/, 'model received real Termux stdout');
        return new Response(
          JSON.stringify({
            id: 'cmpl-m3-2',
            model: 'claude-sonnet-5-5',
            choices: [{ message: { role: 'assistant', content: 'نتیجه از Termux گوشی شما دریافت شد: ۴۲' }, finish_reason: 'stop' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error('unexpected model step ' + modelStep);
    }
    throw new Error('unexpected fetch: ' + u);
  };

  try {
    // A. SSRF guard: cloud-url rejects loopback/private IPs; local-termux rejects non-loopback hosts
    const badCloudRes = await configApi.onRequestPost(
      ctx(
        req('/api/config', {
          method: 'POST',
          headers: authHdr,
          body: { sandboxConfig: { mode: 'cloud-url', cloudUrl: 'http://127.0.0.1:8787' } }
        }),
        env
      )
    );
    assert.equal(badCloudRes.status, 400);

    const badLocalRes = await configApi.onRequestPost(
      ctx(
        req('/api/config', {
          method: 'POST',
          headers: authHdr,
          body: { sandboxConfig: { mode: 'local-termux', localUrl: 'http://evil.example.com:8787' } }
        }),
        env
      )
    );
    assert.equal(badLocalRes.status, 400);

    // B. Save Method 2 (24/7 Cloud Sandbox) config with AES-GCM encrypted token
    const saveCloudRes = await configApi.onRequestPost(
      ctx(
        req('/api/config', {
          method: 'POST',
          headers: authHdr,
          body: {
            sandboxConfig: {
              mode: 'cloud-url',
              cloudUrl: 'https://demo-runner.hf.space/',
              cloudToken
            }
          }
        }),
        env
      )
    );
    assert.equal(saveCloudRes.status, 200);
    const savedCloud = await saveCloudRes.json();
    assert.equal(savedCloud.sandboxConfig.mode, 'cloud-url');
    assert.equal(savedCloud.sandboxConfig.cloudUrl, 'https://demo-runner.hf.space');
    assert.equal(savedCloud.sandboxConfig.hasCloudToken, true);
    assert.equal(savedCloud.executionMode, 'remote-sandbox');
    assert.ok(!JSON.stringify(savedCloud).includes(cloudToken), 'raw cloud token is never exposed in response');

    // Probe Cloud Runner via /api/run { action: 'probe' }
    const probeRes = await runApi.onRequestPost(
      ctx(req('/api/run', { method: 'POST', headers: authHdr, body: { action: 'probe' } }), env)
    );
    const probeData = await probeRes.json();
    assert.equal(probeData.ok, true);
    assert.ok(probeData.node.startsWith('v'));

    // Create a conversation & run Method 2 AI turn (server -> HF Docker runner -> workspace file sync)
    const createRes = await stateApi.onRequestPost(
      ctx(req('/api/state', { method: 'POST', headers: authHdr, body: { action: 'create', title: 'Sandbox Test' } }), env)
    );
    const createdConv = await createRes.json();
    const convId = createdConv.id || createdConv.conversation?.id;

    const chatM2Res = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: authHdr,
          body: { conversationId: convId, message: 'روی سرور ابری یک فایل بساز', shellAccess: true }
        }),
        env
      )
    );
    assert.equal(chatM2Res.status, 200);
    const m2Events = parseSSEText(await chatM2Res.text());
    const m2Done = m2Events.find((e) => e.event === 'done')?.data;
    assert.ok(m2Done, 'Method 2 turn completed');
    assert.equal(m2Done.workspace.files['cloud-built.txt'], 'built-in-hf-docker');
    assert.ok(m2Events.some((e) => e.event === 'live_file' && e.data.path === 'cloud-built.txt'));

    // C. Switch to Method 3 (Direct Local Termux Bridge) & run multi-wave local_exec handoff!
    const saveLocalRes = await configApi.onRequestPost(
      ctx(
        req('/api/config', {
          method: 'POST',
          headers: authHdr,
          body: { sandboxConfig: { mode: 'local-termux', localUrl: `http://127.0.0.1:${runner.port}` } }
        }),
        env
      )
    );
    assert.equal((await saveLocalRes.json()).executionMode, 'local-termux');

    // Wave 1: Chat request with `localRunner: true` -> executes `write_file('calc.js')` & hands off `run_command('node calc.js')`
    const chatM3Wave1 = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: authHdr,
          body: {
            conversationId: convId,
            message: 'اسکریپت calc.js را بنویس و روی Termux اجرا کن',
            shellAccess: true,
            localRunner: true
          }
        }),
        env
      )
    );
    const m3Wave1Events = parseSSEText(await chatM3Wave1.text());
    const localExecEv = m3Wave1Events.find((e) => e.event === 'local_exec')?.data;
    const wave1Done = m3Wave1Events.find((e) => e.event === 'done')?.data;
    assert.ok(localExecEv, 'emitted local_exec SSE event');
    assert.equal(wave1Done.localExecContinue, true);
    assert.equal(wave1Done.interrupted, false);
    assert.equal(wave1Done.pendingLocalCommands.length, 1);
    assert.equal(wave1Done.pendingLocalCommands[0].command, 'node calc.js');
    assert.ok(wave1Done.workspace.files['calc.js'].includes('TERMUX_EXEC_42'), 'calc.js already written before local exec');

    // Simulate Android Chrome calling `http://127.0.0.1:<port>/run` directly with workspace files!
    const cmdPending = wave1Done.pendingLocalCommands[0];
    const termuxHttpRes = await realFetch(`${runner.baseUrl}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloudToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cmd: cmdPending.command,
        files: wave1Done.workspace.files
      })
    });
    const termuxPayload = await termuxHttpRes.json();
    assert.equal(termuxPayload.ok, true);
    assert.equal(termuxPayload.changedFiles['termux-out.txt'], '7*6=42');

    // Wave 2: Resume `/api/chat` with `localExecResults` -> syncs `termux-out.txt` into D1 & completes AI turn!
    const chatM3Wave2 = await chatApi.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: authHdr,
          body: {
            conversationId: convId,
            message: 'ادامه',
            resumeCheckpoint: true,
            silentAutoResume: true,
            shellAccess: true,
            localRunner: true,
            localExecResults: [
              {
                callId: cmdPending.callId,
                ok: termuxPayload.ok,
                runner: 'local-termux',
                exitCode: termuxPayload.exitCode,
                durationMs: termuxPayload.durationMs,
                stdout: termuxPayload.stdout,
                stderr: termuxPayload.stderr,
                changedFiles: termuxPayload.changedFiles,
                deletedFiles: termuxPayload.deletedFiles
              }
            ]
          }
        }),
        env
      )
    );
    const m3Wave2Events = parseSSEText(await chatM3Wave2.text());
    const wave2Done = m3Wave2Events.find((e) => e.event === 'done')?.data;
    assert.ok(wave2Done, 'Wave 2 finished cleanly');
    assert.equal(wave2Done.localExecContinue, false);
    assert.match(wave2Done.content, /۴۲/);
    assert.equal(wave2Done.workspace.files['termux-out.txt'], '7*6=42', 'file created inside Termux synced back to D1 workspace');

    // Verify conversation checkpoint is cleared and messages are intact in D1
    const detailRes = await convDetailApi.onRequestGet(
      ctx(req(`/api/state/conversations/${convId}`, { headers: authHdr }), env, { id: convId })
    );
    const detail = await detailRes.json();
    assert.equal(detail.checkpoint, null);
    assert.equal(detail.workspace.files['termux-out.txt'], '7*6=42');
  } finally {
    globalThis.fetch = realFetch;
    await runner.stop();
  }
});
