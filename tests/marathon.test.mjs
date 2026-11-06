import assert from 'node:assert/strict';
import { normalizeAgentConfig } from '../functions/_lib/provider.js';
import { buildSystemPrompt } from '../functions/_lib/memory.js';

const base = {
  workspace: { files: {} },
  memories: [],
  repo: {},
  user: {}
};

// 1) پیش‌فرض: ماراتن خاموش
{
  const c = normalizeAgentConfig({});
  assert.equal(c.marathon.active, false, 'default off');
}

// 2) نرمال‌سازی فیلدهای ماراتن
{
  const longGoal = 'x'.repeat(900);
  const c = normalizeAgentConfig({
    marathon: { active: true, goal: longGoal, durationH: '3', startedAt: 123456 }
  });
  assert.equal(c.marathon.active, true);
  assert.equal(c.marathon.durationH, 3);
  assert.equal(c.marathon.startedAt, 123456);
  assert.ok(c.marathon.goal.length <= 600, 'goal truncation');
}

// 3) سیستم‌پرامپت: تزریق فقط هنگام فعال بودن
{
  const offPrompt = buildSystemPrompt({
    ...base,
    agentConfig: { marathon: { active: false } }
  });
  assert.ok(!offPrompt.includes('MARATHON MODE IS ACTIVE'), 'inactive no directive');

  const onPrompt = buildSystemPrompt({
    ...base,
    agentConfig: {
      marathon: {
        active: true,
        goal: 'بهبود بازی دوز',
        durationH: 2,
        startedAt: Date.now()
      }
    }
  });
  assert.ok(onPrompt.includes('MARATHON MODE IS ACTIVE'), 'active has directive');
  assert.ok(onPrompt.includes('بهبود بازی دوز'), 'goal included');
  assert.ok(onPrompt.includes('2 ساعت'), 'duration included');
}

console.log('marathon tests: ALL PASS');
