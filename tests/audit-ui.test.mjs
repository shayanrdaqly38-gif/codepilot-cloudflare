// Regression suite for the 2026-11-09 audit findings.
//
// Every scenario here reproduces a bug that actually shipped and was confirmed
// with a probe, so a future refactor that silently reintroduces it fails CI:
//
//   1. sidebar listed only 200 of the 300 conversations the quota allows
//   2. `resumable` error with a null checkpoint stranded the user (no card)
//   3. a turn rejected with 4xx left a phantom user message in local state
//   4. an empty reply had no retry affordance
//   5. the user's maxSteps was overridden by workStamina
//   6. archive was implemented server-side but unreachable from the UI
//   7. message bodies were not searchable
//
// Each scenario boots a FRESH jsdom — the app keeps module-scoped state.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const LIMITS = {
  maxConversations: 300,
  maxMessagesPerConversation: 4000,
  maxTitleChars: 120,
  maxMessageChars: 100000,
  perMinute: 30,
  perDay: 1200
};

/** Boot one isolated copy of the app against a mocked backend. */
function bootApp({ chat = null, chatStatus = 200, archived = [], postHandler = null } = {}) {
  const posts = [];
  const db = {
    conversations: [{ id: 'c-1', title: 'گفتگوی ۱', messageCount: 1, updatedAt: Date.now(), pinned: false }],
    messages: [{ role: 'assistant', content: 'پاسخ قبلی', seq: 0, created_at: Date.now() }],
    workspace: { files: {}, active: '' }
  };

  function mockFetch(url, init = {}) {
    const path = String(url).replace('https://app.example.com', '');
    if (path === '/api/auth') return jsonResponse({ signedIn: true, user: { email: 'dev@example.com' } });
    if (path === '/api/config') {
      return jsonResponse({ ok: true, model: 'gpt-4o-mini', contextBudgetTokens: 24000, limits: LIMITS });
    }
    if (path === '/api/state?archived=1') {
      return jsonResponse({ ok: true, archived, conversations: [] });
    }
    if (path === '/api/state' && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      posts.push(body);
      if (postHandler) {
        const custom = postHandler(body);
        if (custom) return custom;
      }
      if (body.action === 'create') return jsonResponse({ ok: true, id: 'c-1' });
      return jsonResponse({ ok: true });
    }
    if (path === '/api/state') {
      return jsonResponse({ ok: true, conversations: db.conversations, memory: [], usage: {} });
    }
    if (path.startsWith('/api/state/conversations/')) {
      const id = /conversations\/([^?]+)/.exec(path)[1];
      return jsonResponse({
        ok: true,
        conversation: { id, title: 'گفتگوی ۱', summaryUntil: 0 },
        messages: db.messages,
        hasOlderMessages: false,
        oldestSeq: 0,
        workspace: db.workspace,
        checkpoint: null
      });
    }
    if (path === '/api/chat') {
      const body = JSON.parse(init.body || '{}');
      db.messages.push({ role: 'user', content: body.message, seq: db.messages.length, created_at: Date.now() });
      if (chatStatus >= 400) {
        return jsonResponse({ ok: false, error: 'پیام بیش از حد طولانی است.', code: 'too_large' }, chatStatus);
      }
      const payload = chat || '';
      // Mirror the real server: partial content is persisted BEFORE the error frame.
      const partial = /"partialContent":"([^"]*)"/.exec(payload);
      if (partial) {
        db.messages.push({ role: 'assistant', content: partial[1], seq: db.messages.length, created_at: Date.now() });
      }
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return jsonResponse({ ok: true });
  }

  const dom = new JSDOM(html, {
    url: 'https://app.example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, init) => Promise.resolve(mockFetch(url, init));
      window.confirm = () => true;
      window.prompt = () => 'نام جدید';
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
    }
  });
  return { window: dom.window, posts, db };
}

/* ------------------------------- scenarios ------------------------------- */

/** 2 + 3: a resumable failure must always leave a resume card behind. */
async function resumableWithoutCheckpointStillOffersResume() {
  const payload =
    sseFrame('assistant', { content: 'نیمه‌کاره' }) +
    sseFrame('error', {
      error: 'ارتباط قطع شد',
      code: 'stream_interrupted',
      resumable: true,
      partialContent: 'نیمه‌کاره',
      checkpoint: null
    });
  const { window } = bootApp({ chat: payload });
  await wait(700);
  await window.openConversation('c-1');
  await wait(250);
  window.document.getElementById('prompt').value = 'کار';
  await window.sendMessage();
  await wait(1400);

  const card = window.document.querySelector('.resume-checkpoint-card');
  assert.ok(card, 'a resumable error with checkpoint:null must still render a resume card');
  assert.match(card.textContent, /ادامه/, 'the card must tell the user how to continue');
  assert.match(
    window.document.getElementById('chat').textContent,
    /نیمه‌کاره/,
    'the partial answer must survive the reload that follows a resumable stop'
  );
  window.close();
}

/** 3: a 4xx rejection must not leave a phantom message in local state. */
async function rejectedTurnLeavesNoPhantomMessage() {
  const { window } = bootApp({ chatStatus: 413 });
  await wait(700);
  await window.openConversation('c-1');
  await wait(250);
  const before = window.document.querySelectorAll('#chat .msg.user').length;
  window.document.getElementById('prompt').value = 'پیامی که رد می‌شود';
  await window.sendMessage();
  await wait(1200);

  assert.equal(
    window.document.querySelectorAll('#chat .msg.user').length,
    before,
    'a message the server rejected must be removed from the transcript'
  );
  assert.match(
    window.document.getElementById('chat').textContent,
    /خطا/,
    'the user still needs to see why the turn failed'
  );
  window.close();
}

/** 4: an empty completion must offer a retry instead of a dead end. */
async function emptyReplyOffersRetry() {
  const { window } = bootApp({
    chat: sseFrame('done', { content: '', conversation: { id: 'c-1', summaryUntil: 0 } })
  });
  await wait(700);
  await window.openConversation('c-1');
  await wait(250);
  window.document.getElementById('prompt').value = 'کار';
  await window.sendMessage();
  await wait(1200);

  const retry = [...window.document.getElementById('chat').querySelectorAll('button')].find((b) =>
    /تلاش دوباره/.test(b.textContent)
  );
  assert.ok(retry, 'an empty reply must expose a "try again" button');
  window.close();
}

/** 6: the composer cap comes from the server and is enforced before sending. */
async function oversizedMessageIsStoppedLocally() {
  const { window } = bootApp({
    chat: sseFrame('done', { content: 'ok', conversation: { id: 'c-1', summaryUntil: 0 } })
  });
  await wait(700);
  await window.openConversation('c-1');
  await wait(250);

  const prompt = window.document.getElementById('prompt');
  assert.equal(prompt.maxLength, LIMITS.maxMessageChars, 'maxlength must come from GET /api/config');

  // Programmatic assignment bypasses maxlength (browsers behave the same), so
  // sendMessage() itself has to refuse the request.
  prompt.value = 'x'.repeat(LIMITS.maxMessageChars + 1);
  await window.sendMessage();
  await wait(500);

  assert.equal(
    window.document.querySelectorAll('#chat .msg.user').length,
    0,
    'an over-limit message must never be added to the transcript'
  );
  assert.ok(prompt.value.length > 0, 'the user must keep their text so they can trim it');
  window.close();
}

/** 7: archived conversations must be reachable and restorable from the sidebar. */
async function archivedConversationsAreReachable() {
  const archived = [{ id: 'old-1', title: 'گفتگوی آرشیوی', messageCount: 5, updatedAt: Date.now(), archived: true }];
  const { window, posts } = bootApp({ archived });
  await wait(800);

  assert.match(
    window.document.getElementById('convCount').textContent,
    /۳۰۰/,
    'the sidebar must show the server-reported conversation cap'
  );

  const row = window.document.querySelector('#convList .conv');
  assert.ok(row?.querySelector('[data-act="archive"]'), 'every row needs an archive action');

  await row.querySelector('[data-act="archive"]').click();
  await wait(400);
  assert.ok(
    posts.some((p) => p.action === 'flags' && p.archived === true),
    'archiving must persist through the flags action'
  );

  const toggle = window.document.getElementById('convArchivedToggle');
  toggle.click();
  await wait(600);
  assert.match(
    window.document.getElementById('convList').textContent,
    /گفتگوی آرشیوی/,
    'the archive drawer must list archived conversations'
  );

  const unarchive = [...window.document.querySelectorAll('#convList button')].find((b) =>
    /بازگردانی/.test(b.textContent)
  );
  assert.ok(unarchive, 'an archived conversation must be restorable');
  await unarchive.click();
  await wait(400);
  assert.ok(
    posts.some((p) => p.action === 'flags' && p.archived === false),
    'restoring must clear the archived flag'
  );
  window.close();
}

/** 7: searching message bodies (not just titles) must be wired to the UI. */
async function conversationSearchFindsMessageBodies() {
  const { window } = bootApp({
    postHandler: (body) => {
      if (body.action !== 'search-conversations') return null;
      return jsonResponse({
        ok: true,
        results: [{ conversationId: 'c-1', title: 'گفتگوی هدف', snippet: '…زبرا-ققنوس…', seq: 3 }]
      });
    }
  });
  await wait(800);

  const input = window.document.getElementById('convSearch');
  assert.ok(input, 'the sidebar needs a conversation search box');
  input.value = 'ققنوس';
  input.dispatchEvent(new window.Event('input'));
  await wait(700);

  const box = window.document.getElementById('convSearchResults');
  assert.notEqual(box.style.display, 'none', 'results must be visible after a search');
  assert.match(box.textContent, /گفتگوی هدف/, 'matching conversations must be listed');
  window.close();
}

/* --------------------------------- runner -------------------------------- */
const scenarios = [
  ['resumable error without checkpoint still offers resume', resumableWithoutCheckpointStillOffersResume],
  ['rejected turn leaves no phantom message', rejectedTurnLeavesNoPhantomMessage],
  ['empty reply offers retry', emptyReplyOffersRetry],
  ['oversized message is stopped locally', oversizedMessageIsStoppedLocally],
  ['archived conversations are reachable', archivedConversationsAreReachable],
  ['conversation search finds message bodies', conversationSearchFindsMessageBodies]
];

let failed = 0;
for (const [name, run] of scenarios) {
  try {
    await run();
    console.log('  ok   ' + name);
  } catch (error) {
    failed += 1;
    console.error('  FAIL ' + name + '\n       ' + error.message);
  }
}

if (failed) {
  console.error(`\nAUDIT UI REGRESSION FAILED (${failed} scenario(s))`);
  process.exit(1);
}
console.log('AUDIT UI REGRESSION PASSED');
process.exit(0);
