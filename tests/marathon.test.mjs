import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentConfig, resolvePowerExecutionPlan } from '../functions/_lib/provider.js';
import { buildSystemPrompt } from '../functions/_lib/memory.js';
import { onRequestGet as authGet } from '../functions/api/auth.js';
import { onRequestPost as statePost } from '../functions/api/state/index.js';
import { onRequestPost as chatPost } from '../functions/api/chat.js';
import { makeD1, req, ctx } from './harness.mjs';

const base = {
  workspace: { files: {} },
  memories: [],
  repo: {},
  user: {}
};

test('marathon default config is inactive with full v2 fields', () => {
  const c = normalizeAgentConfig({});
  assert.equal(c.marathon.active, false);
  assert.equal(c.marathon.paused, false);
  assert.equal(c.marathon.maxCycles, 30);
  assert.equal(c.marathon.cycle, 0);
  assert.equal(c.marathon.conversationId, '');
});

test('marathon normalization clamps durationH, maxCycles, cycle, paused, and conversationId', () => {
  const longGoal = 'x'.repeat(900);
  const c = normalizeAgentConfig({
    marathon: {
      active: true,
      paused: true,
      goal: longGoal,
      durationH: '0.5',
      startedAt: 123456,
      maxCycles: 500,
      cycle: 4,
      conversationId: 'conv-abc-123'
    }
  });
  assert.equal(c.marathon.active, true);
  assert.equal(c.marathon.paused, true);
  assert.equal(c.marathon.durationH, 0.5);
  assert.equal(c.marathon.startedAt, 123456);
  assert.equal(c.marathon.maxCycles, 120);
  assert.equal(c.marathon.cycle, 4);
  assert.equal(c.marathon.conversationId, 'conv-abc-123');
  assert.ok(c.marathon.goal.length <= 600);
});

test('resolvePowerExecutionPlan boosts steps, file edits, and auto-repair only when marathon is active and unpaused', () => {
  const normal = resolvePowerExecutionPlan(normalizeAgentConfig({ mode: 'auto-edit' }));
  const liveMara = resolvePowerExecutionPlan(
    normalizeAgentConfig({ mode: 'auto-edit', marathon: { active: true, paused: false } })
  );
  const pausedMara = resolvePowerExecutionPlan(
    normalizeAgentConfig({ mode: 'auto-edit', marathon: { active: true, paused: true } })
  );

  assert.ok(liveMara.maxSteps >= 36, `expected >=36 steps, got ${liveMara.maxSteps}`);
  assert.ok(liveMara.maxFileEdits >= 140, `expected >=140 maxFileEdits, got ${liveMara.maxFileEdits}`);
  assert.equal(liveMara.autoRepairValidation, true);
  assert.equal(pausedMara.maxSteps, normal.maxSteps);
});

test('buildSystemPrompt injects marathon directive when active and suppresses it when paused or off', () => {
  const offPrompt = buildSystemPrompt({
    ...base,
    agentConfig: { marathon: { active: false } }
  });
  assert.ok(!offPrompt.includes('MARATHON MODE IS ACTIVE'));

  const pausedPrompt = buildSystemPrompt({
    ...base,
    agentConfig: { marathon: { active: true, paused: true, goal: 'تست مکث' } }
  });
  assert.ok(!pausedPrompt.includes('MARATHON MODE IS ACTIVE'));

  const onPrompt = buildSystemPrompt({
    ...base,
    agentConfig: {
      marathon: {
        active: true,
        paused: false,
        goal: 'بهبود بازی دوز',
        durationH: 2,
        startedAt: Date.now(),
        cycle: 4,
        maxCycles: 50
      }
    }
  });
  assert.ok(onPrompt.includes('MARATHON MODE IS ACTIVE'));
  assert.ok(onPrompt.includes('بهبود بازی دوز'));
  assert.ok(onPrompt.includes('2 ساعت'));
  assert.ok(onPrompt.includes('چرخه 4 از سقف 50'));
  assert.ok(onPrompt.includes('[MARATHON_COMPLETE]'));

  const halfHourPrompt = buildSystemPrompt({
    ...base,
    agentConfig: {
      marathon: { active: true, goal: 'سریع', durationH: 0.5 }
    }
  });
  assert.ok(halfHourPrompt.includes('30 دقیقه'));
});

test('/api/chat auto-upgrades plan mode during live marathon and emits marathonCompleted on [MARATHON_COMPLETE]', async () => {
  const env = {
    DB: makeD1(),
    DEV_ACCESS_EMAIL: 'dev@example.com',
    SESSION_SECRET: 'x'.repeat(48),
    MODEL_API_KEY: 'sk-test-key-0123456789abcdefghij'
  };
  const authRes = await authGet(ctx(req('/api/auth'), env));
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
  const created = await (
    await statePost(ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env))
  ).json();

  const originalFetch = globalThis.fetch;
  let capturedTools = null;
  globalThis.fetch = async (_url, init) => {
    const parsed = JSON.parse(init.body);
    capturedTools = parsed.tools || [];
    const sseBody =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'همه اهداف انجام شد.\n[MARATHON_COMPLETE]' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      `data: [DONE]\n\n`;
    return new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  try {
    const request = req('/api/chat', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        conversationId: created.id,
        message: 'شروع ماراتن',
        agentMode: 'plan',
        marathon: {
          active: true,
          paused: false,
          goal: 'تکمیل پروژه',
          durationH: 1,
          cycle: 2,
          maxCycles: 20,
          conversationId: created.id
        }
      }
    });
    const res = await chatPost(ctx(request, env));
    assert.equal(res.status, 200);
    const rawSse = await res.text();
    const events = rawSse
      .split('\n\n')
      .map((block) => {
        const ev = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const dt = block.match(/^data:\s*(.+)$/m)?.[1]?.trim();
        return ev && dt ? { event: ev, data: JSON.parse(dt) } : null;
      })
      .filter(Boolean);
    const doneEv = events.find((e) => e.event === 'done');
    assert.ok(doneEv, 'expected done SSE event');
    assert.equal(doneEv.data.marathonCompleted, true);
    assert.ok(!doneEv.data.content.includes('[MARATHON_COMPLETE]'));
    assert.ok(doneEv.data.content.includes('ماراتن به هدف نهایی رسید'));
    const toolNames = capturedTools.map((t) => t.function?.name);
    assert.ok(toolNames.includes('write_file'), 'plan mode should auto-upgrade to full-auto during active marathon');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
