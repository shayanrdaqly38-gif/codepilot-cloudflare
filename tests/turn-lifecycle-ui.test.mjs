// UI regressions for the verified Stop / 503 / early-EOF chain.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers }
});
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function boot({ turnActive = false, checkpoint = null, chatResponse, stopResponse } = {}) {
  const sent = [];
  const detail = {
    ok: true,
    conversation: { id: 'c-1', title: 'گفتگو', summaryUntil: 0, ...(turnActive ? { turnActive: true } : {}) },
    messages: [{ role: 'assistant', content: 'ok', seq: 1 }],
    workspace: { files: {}, active: '' },
    checkpoint,
    turnActive,
    turn: turnActive ? { turnId: 'turn-remote-1', requestId: 'request-remote-1', active: true, state: 'running', stopRequested: false } : null
  };
  const dom = new JSDOM(html, {
    url: 'https://app.example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.fetch = (url, init = {}) => {
        const path = String(url).replace('https://app.example.com', '');
        if (path === '/api/auth') return Promise.resolve(json({ signedIn: true, user: { email: 'dev@example.com' } }));
        if (path === '/api/config') return Promise.resolve(json({ ok: true, model: 'test-model', contextBudgetTokens: 24000 }));
        if (path === '/api/state') return Promise.resolve(json({ ok: true, conversations: [{ id: 'c-1', title: 'گفتگو', updatedAt: Date.now() }], memory: [], usage: {} }));
        if (path.startsWith('/api/state/conversations/')) {
          sent.push({ kind: 'detail', path });
          return Promise.resolve(json(detail));
        }
        if (path === '/api/chat') {
          sent.push({ kind: 'chat', body: JSON.parse(init.body || '{}') });
          return Promise.resolve(chatResponse ? chatResponse() : new Response(
            frame('status', { turnId: 'turn-remote-1', requestId: 'request-remote-1', phase: 'thinking' }) + frame('done', { content: 'ok', turnId: 'turn-remote-1' }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          ));
        }
        if (path === '/api/chat/stop') {
          sent.push({ kind: 'stop', body: JSON.parse(init.body || '{}'), signal: init.signal });
          return stopResponse ? stopResponse(init) : Promise.resolve(json({ ok: true, accepted: true, stopped: false, state: 'stopping', turnId: 'turn-remote-1' }));
        }
        return Promise.resolve(json({ ok: true }));
      };
    }
  });
  return { window: dom.window, sent, detail };
}

async function ready(app) {
  for (let i = 0; i < 100; i++) {
    if (app.window.eval('state.ready')) return;
    await wait(20);
  }
  throw new Error('app did not boot');
}

// 1. A hung Stop request must time out, unlock the composer, and never claim
//    that the server stopped when the HTTP request never answered.
{
  const app = boot({
    turnActive: true,
    stopResponse: (init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })
  });
  await ready(app);
  await wait(100);
  assert.equal(app.window.eval('state.busy'), true);
  const stopping = app.window.stopCurrentTurn();
  await wait(50);
  assert.equal(app.sent.filter((x) => x.kind === 'stop').length, 1);
  assert.equal(app.sent.find((x) => x.kind === 'stop').body.turnId, 'turn-remote-1');
  assert.ok(app.sent.find((x) => x.kind === 'stop').signal, 'Stop request carries an AbortSignal');
  await stopping;
  assert.equal(app.window.eval('state.busy'), false, 'bounded Stop unlocks the view');
  assert.equal(app.window.document.body.classList.contains('is-working'), false);
  assert.equal(app.window.document.getElementById('stopTurnBtn').hidden, true);
  assert.equal(app.window.document.getElementById('sendBtn').disabled, false);
  assert.ok(!app.window.document.getElementById('toast').textContent.includes('متوقف شد و پیشرفت ذخیره گردید'),
    'a failed/timeout Stop must not report confirmed success');
  app.window.close();
}

// 2. A raw edge 503 is not permission to POST the same user message again.
{
  const app = boot({
    chatResponse: () => new Response('<html>edge 503</html>', {
      status: 503, headers: { 'Content-Type': 'text/html', 'cf-ray': 'ray-test-123' }
    })
  });
  await ready(app);
  await app.window.sendMessage('پیام یک‌بارمصرف');
  await wait(1200);
  const posts = app.sent.filter((x) => x.kind === 'chat');
  assert.equal(posts.length, 1, 'no blind 503 re-POST');
  assert.ok(posts[0].body.requestId, 'chat carries a stable request id');
  assert.equal(app.window.eval('state.busy'), false);
  assert.ok(app.window.document.getElementById('chat').textContent.includes('503'));
  app.window.close();
}

// 3. Early SSE EOF re-attaches to the still-live server lease; it does not
//    silently start a second model turn while the first is active.
{
  const app = boot({
    turnActive: false,
    chatResponse: () => new Response(frame('status', { turnId: 'turn-live-1', requestId: 'request-live-1', phase: 'thinking' }), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' }
    })
  });
  await ready(app);
  // The first chat started a server lease; subsequent detail polls report it.
  const originalChatCount = () => app.sent.filter((x) => x.kind === 'chat').length;
  app.window.eval("state.busy = false;");
  const sendPromise = app.window.sendMessage('کار طولانی');
  await wait(80);
  app.detail.turnActive = true;
  app.detail.turn = { turnId: 'turn-live-1', requestId: 'request-live-1', active: true, state: 'running', stopRequested: false };
  app.detail.conversation.turnActive = true;
  await sendPromise;
  await wait(3000);
  assert.equal(originalChatCount(), 1, 'early EOF must not silentAutoResume over a live lease');
  assert.ok(app.sent.some((x) => x.kind === 'detail'), 'client re-attaches by polling D1 state');
  assert.equal(app.window.eval('state.busy'), true, 'live server lease keeps the working surface');
  app.detail.turnActive = false;
  app.detail.conversation.turnActive = false;
  app.detail.turn = { turnId: 'turn-live-1', active: false, state: 'completed' };
  await wait(3000);
  assert.equal(app.window.eval('state.busy'), false, 'poller frees the composer when the lease settles');
  app.window.close();
}

console.log('TURN LIFECYCLE UI REGRESSION PASSED');
process.exit(0);
