// تست حالت ماراتن (کار مستمر): نرمال‌سازی پیکربندی + تزریق پرامپت سیستمی.
// پوشش: normalizeAgentConfig/marathon (اعتبارسنجی و سقف‌ها) و buildSystemPrompt
// (بخش «MARATHON MODE IS ACTIVE» فقط وقتی فعال و متوقف‌نشده تزریق می‌شود).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentConfig, resolvePowerExecutionPlan } from '../functions/_lib/provider.js';
import { buildSystemPrompt } from '../functions/_lib/memory.js';

const basePromptInput = {
  workspace: { files: {}, active: '' },
  memories: [],
  repo: null,
  user: { email: 'dev@example.com' },
  sandbox: false,
  linuxRunner: false,
  agentConfig: null
};

test('normalizeAgentConfig keeps marathon defaults off and sane', () => {
  const cfg = normalizeAgentConfig({});
  assert.equal(cfg.marathon.active, false, 'marathon is inactive by default');
  assert.equal(cfg.marathon.paused, false);
  assert.equal(cfg.marathon.goal, '');
  assert.equal(cfg.marathon.durationH, 0);
  assert.equal(cfg.marathon.maxCycles, 30, 'default cycle cap is 30');
  assert.equal(cfg.marathon.cycle, 0);
  assert.equal(cfg.marathon.conversationId, '');
});

test('normalizeAgentConfig clamps marathon goal length, duration and cycle caps', () => {
  const cfg = normalizeAgentConfig({
    marathon: {
      active: true,
      goal: 'x'.repeat(900),
      durationH: 999,
      maxCycles: 9999,
      cycle: 5,
      startedAt: 1730000000000,
      conversationId: '  c-1  '
    }
  });
  assert.equal(cfg.marathon.active, true);
  assert.equal(cfg.marathon.goal.length, 600, 'goal is truncated to 600 chars');
  assert.equal(cfg.marathon.durationH, 24, 'durationH is clamped to at most 24');
  assert.equal(cfg.marathon.maxCycles, 120, 'maxCycles is clamped to at most 120');
  assert.equal(cfg.marathon.cycle, 5);
  assert.equal(cfg.marathon.startedAt, 1730000000000);
  assert.equal(cfg.marathon.conversationId, 'c-1', 'conversationId is trimmed');
});

test('normalizeAgentConfig rejects non-numeric/garbage marathon fields', () => {
  const cfg = normalizeAgentConfig({
    marathon: { active: 'yes', durationH: 'abc', maxCycles: -3, cycle: -1, goal: 42 }
  });
  assert.equal(cfg.marathon.active, false, 'non-boolean active coerces to false');
  assert.equal(cfg.marathon.durationH, 0, 'garbage durationH falls back to 0');
  assert.equal(cfg.marathon.maxCycles, 30, 'invalid maxCycles falls back to the default');
  assert.equal(cfg.marathon.cycle, 0);
  assert.equal(cfg.marathon.goal, '', 'non-string goal falls back to empty');
});

test('buildSystemPrompt injects MARATHON MODE only when active and not paused', () => {
  const goal = 'تقویت محیط توسعه CodePilot';
  const active = buildSystemPrompt({
    ...basePromptInput,
    agentConfig: normalizeAgentConfig({ marathon: { active: true, goal, durationH: 3, maxCycles: 10, cycle: 2 } })
  });
  assert.match(active, /MARATHON MODE IS ACTIVE/);
  assert.match(active, new RegExp(goal));
  assert.match(active, /3 ساعت/);
  assert.match(active, /چرخه 2 از سقف 10/);
  assert.match(active, /\[MARATHON_COMPLETE\]/);

  const paused = buildSystemPrompt({
    ...basePromptInput,
    agentConfig: normalizeAgentConfig({ marathon: { active: true, paused: true, goal } })
  });
  assert.doesNotMatch(paused, /MARATHON MODE IS ACTIVE/, 'paused marathon injects nothing');

  const inactive = buildSystemPrompt({ ...basePromptInput, agentConfig: normalizeAgentConfig({}) });
  assert.doesNotMatch(inactive, /MARATHON MODE IS ACTIVE/, 'inactive marathon injects nothing');
});

test('buildSystemPrompt labels unlimited and minute-scale marathon budgets in Persian', () => {
  const unlimited = buildSystemPrompt({
    ...basePromptInput,
    agentConfig: normalizeAgentConfig({ marathon: { active: true, durationH: 0 } })
  });
  assert.match(unlimited, /بی‌محدودیت/);

  const minutes = buildSystemPrompt({
    ...basePromptInput,
    agentConfig: normalizeAgentConfig({ marathon: { active: true, durationH: 0.5 } })
  });
  assert.match(minutes, /30 دقیقه/);
});

test('resolvePowerExecutionPlan raises budgets while marathon is active', () => {
  const idle = resolvePowerExecutionPlan(normalizeAgentConfig({}));
  const running = resolvePowerExecutionPlan(
    normalizeAgentConfig({ marathon: { active: true, goal: 'g' } })
  );
  assert.ok(running.maxSteps > idle.maxSteps, 'marathon unlocks more autonomous steps');
  assert.ok(
    running.maxFileEdits >= 140,
    'marathon guarantees a high file-edit ceiling for long unattended runs'
  );
});
