// Marathon mode UI regressions — covering the side effects the smoke test never
// touches: cycle-cap enforcement across a reload, cross-conversation safety,
// pausing on navigation away, and cleaning up stale state after a run finishes.
//
// Every scenario boots a FRESH jsdom, because marathon state lives in
// localStorage and boot-time behaviour is part of what we assert.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Boot one isolated copy of the app against a mocked backend. */
function bootApp({ seed = null, auto = null, delayMs = 5 } = {}) {
  const sent = [];
  const db = {
    conversations: [
      { id: 'c-1', title: 'گفتگوی ۱', messageCount: 1, updatedAt: Date.now(), pinned: false },
      { id: 'c-2', title: 'گفتگوی ۲', messageCount: 1, updatedAt: Date.now(), pinned: false }
    ],
    messages: [{ role: 'assistant', content: 'ok', seq: 0, created_at: Date.now() }],
    workspace: { files: {}, active: '' }
  };

  function mockFetch(url, init = {}) {
    const path = String(url).replace('https://app.example.com', '');
    if (path === '/api/auth') return jsonResponse({ signedIn: true, user: { email: 'dev@example.com' } });
    if (path === '/api/config' && (!init.method || init.method === 'GET')) {
      return jsonResponse({ ok: true, model: 'gpt-4o-mini', contextBudgetTokens: 24000, storage: 'd1' });
    }
    if (path === '/api/state' && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      if (body.action === 'create') return jsonResponse({ ok: true, id: 'c-new' });
      return jsonResponse({ ok: true });
    }
    if (path === '/api/state') {
      return jsonResponse({ ok: true, conversations: db.conversations, memory: [], usage: {} });
    }
    if (path.startsWith('/api/state/conversations/')) {
      const id = path.split('/')[4].split('?')[0];
      return jsonResponse({
        ok: true,
        conversation: { id, title: 'گفتگو', summaryUntil: 0 },
        messages: db.messages,
        hasOlderMessages: false,
        oldestSeq: 0,
        workspace: db.workspace
      });
    }
    if (path === '/api/chat') {
      const body = JSON.parse(init.body || '{}');
      sent.push(body.marathon?.cycle);
      return new Response(
        sseFrame('assistant', { content: 'ok' }) +
          sseFrame('done', {
            content: 'ok',
            conversation: { id: body.conversationId, title: 'گفتگو', summaryUntil: 0 },
            marathonCompleted: false
          }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    if (path === '/api/chat/stop') return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  }

  const dom = new JSDOM(html, {
    url: 'https://app.example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, init) => Promise.resolve(mockFetch(url, init));
      window.confirm = () => true;
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.open = () => ({ document: { open() {}, write() {}, close() {} } });
      window.__CP_MARATHON_DELAY = delayMs;
      if (seed) window.localStorage.setItem('cp-marathon-v1', JSON.stringify(seed));
      if (auto !== null) window.localStorage.setItem('cp_marathon_auto', auto);
    }
  });
  return { window: dom.window, sent };
}

const seedRun = (over = {}) => ({
  active: true,
  paused: false,
  goal: 'بهبود پروژه',
  durationH: 0,
  startedAt: Date.now(),
  maxCycles: 10,
  cycle: 8,
  conversationId: 'c-1',
  totalSteps: 0,
  touchedFiles: [],
  ...over
});

/* ------------------------------------------------------------------------- */
/* 1. The cycle cap must be enforced against the PERSISTED cycle, so a page   */
/*    reload cannot hand a finished marathon a whole new budget.              */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({ seed: seedRun({ cycle: 8, maxCycles: 10 }), auto: '1' });
  await wait(500);

  for (let i = 0; i < 6; i += 1) {
    app.window.eval(`
      state.messages = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'done' }];
      state.busy = false;
      state.chatAbortController = null;
      scheduleMarathonAutoContinue();
    `);
    await wait(120);
  }

  const sentCycles = app.sent.map(Number).filter(Number.isFinite);
  assert.ok(sentCycles.length > 0, 'auto-continue actually fired (guards the assertions below)');
  assert.ok(
    Math.max(...sentCycles) <= 10,
    `auto-continue must never exceed maxCycles=10; sent ${JSON.stringify(app.sent)}`
  );
  assert.equal(app.window.eval('getMarathonState().active'), false, 'marathon stops itself at the cycle cap');
  app.window.close();
}

/* ------------------------------------------------------------------------- */
/* 2. Leaving the marathon's conversation while IDLE pauses it, and it stays   */
/*    resumable (active still true).                                           */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({ seed: seedRun({ conversationId: 'c-1', cycle: 3 }), auto: '0' });
  await wait(500);
  assert.equal(app.window.eval('state.conversationId'), 'c-1', 'boot opened the marathon conversation');

  await app.window.openConversation('c-2');
  await wait(250);

  const st = app.window.eval('getMarathonState()');
  assert.equal(st.paused, true, 'navigating out of the marathon conversation pauses it');
  assert.equal(st.active, true, 'paused, not killed — it can be resumed');
  app.window.close();
}

/* ------------------------------------------------------------------------- */
/* 3. Booting into a conversation must NOT count as "leaving" and pause it.    */
/*    (Regression guard: a naive nav-pause fired at boot, when               */
/*    state.conversationId is still null, silently pausing every marathon.)   */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({ seed: seedRun({ conversationId: 'c-1' }), auto: '0' });
  await wait(700);
  const st = app.window.eval('getMarathonState()');
  assert.equal(st.paused, false, 'opening the app does not pause a perfectly healthy marathon');
  assert.equal(st.active, true);
  app.window.close();
}

/* ------------------------------------------------------------------------- */
/* 4. Starting a marathon in ANOTHER conversation asks first, and cancelling   */
/*    leaves the old run completely intact.                                    */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({ seed: null, auto: '0' });
  await wait(500);
  await app.window.openConversation('c-1');
  await wait(150);
  app.window.eval(
    "persistMarathon({ active:true, paused:false, goal:'هدف یک', conversationId:'c-1', maxCycles:30, cycle:7, startedAt:Date.now() })"
  );
  // Put the user in the other conversation without triggering the nav-pause
  // (this models "the marathon is registered elsewhere", e.g. a second tab).
  app.window.eval("state.conversationId = 'c-2'");

  let asked = 0;
  app.window.confirm = () => {
    asked += 1;
    return false; // user declines the replacement
  };

  const before = app.window.eval('getMarathonState()');
  app.window.startMarathon({ goalOverride: 'هدف دو' });
  await wait(120);

  const after = app.window.eval('getMarathonState()');
  assert.equal(asked, 1, 'replacing another conversation\'s marathon asks exactly one confirmation');
  assert.equal(after.goal, before.goal, 'declining keeps the original goal');
  assert.equal(after.cycle, before.cycle, 'declining keeps the original cycle counter');
  assert.equal(after.active, true, 'declining keeps the original run alive');
  app.window.close();
}

/* ------------------------------------------------------------------------- */
/* 5. Accepting starts a genuinely fresh run (cycle 1, zeroed counters).       */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({ seed: null, auto: '0' });
  await wait(500);
  await app.window.openConversation('c-1');
  await wait(150);
  app.window.eval(
    "persistMarathon({ active:true, paused:false, goal:'هدف یک', conversationId:'c-1', maxCycles:30, cycle:7, totalSteps: 40, startedAt:Date.now() })"
  );
  app.window.eval("state.conversationId = 'c-2'");
  app.window.confirm = () => true;

  app.window.startMarathon({ goalOverride: 'هدف دو' });
  const st = app.window.eval('getMarathonState()'); // read before auto-continue can move it
  assert.equal(st.goal, 'هدف دو', 'accepted replacement uses the new goal');
  assert.equal(st.cycle, 1, 'accepted replacement restarts at cycle 1');
  assert.equal(st.totalSteps, 0, 'accepted replacement zeroes the previous counters');
  await wait(200);
  app.window.close();
}

/* ------------------------------------------------------------------------- */
/* 6. Stopping a run clears its counters so the next marathon starts clean.    */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({
    seed: seedRun({ cycle: 4, maxCycles: 5, totalSteps: 40, touchedFiles: ['a.js', 'b.js'] }),
    auto: '0'
  });
  await wait(500);
  app.window.stopMarathon('max-cycles');
  await wait(120);

  const st = app.window.eval('getMarathonState()');
  assert.equal(st.active, false, 'stopped');
  assert.equal(st.totalSteps, 0, 'stale totalSteps cleared');
  assert.deepEqual(Array.from(st.touchedFiles), [], 'stale touchedFiles cleared');
  assert.equal(st.goal, '', 'stale goal cleared');
  app.window.close();
}

/* ------------------------------------------------------------------------- */
/* 7. The button label must not promise a "move" that does not happen.         */
/* ------------------------------------------------------------------------- */
{
  const app = bootApp({ seed: seedRun({ conversationId: 'c-1' }), auto: '0' });
  await wait(500);
  await app.window.openConversation('c-2');
  await wait(250);
  const label = app.window.document.getElementById('marathonStart').textContent;
  assert.ok(!label.includes('انتقال'), `button must not claim to move the marathon; got: ${label}`);
  assert.ok(label.includes('شروع'), 'button still offers to start a marathon');
  app.window.close();
}

console.log('MARATHON UI TEST PASSED');
process.exit(0);
