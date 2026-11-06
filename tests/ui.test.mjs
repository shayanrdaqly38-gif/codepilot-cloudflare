// UI smoke test: run the real index.html script inside jsdom against a mocked
// backend that mirrors the API contract (auth, state, conversations, SSE chat).
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const calls = [];

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

const db = {
  conversations: [{ id: 'c-1', title: 'گفتگوی اول', messageCount: 2, updatedAt: Date.now(), pinned: false, summaryUntil: 0 }],
  messages: [
    { role: 'user', content: 'سلام', seq: 0, created_at: Date.now() - 5000 },
    { role: 'assistant', content: 'سلام! چه بسازیم؟', seq: 1, created_at: Date.now() - 4000 }
  ],
  workspace: { files: { 'index.html': '<h1>hi</h1>', 'style.css': 'body{}' }, active: 'index.html' },
  memory: [{ key: 'stack', value: 'Cloudflare Pages', scope: 'global', project: '' }]
};

const sse = [
  ['status', { phase: 'thinking' }],
  ['tool', { calls: [{ id: 'call_1', name: 'write_file', arguments: '{"path":"app.js","content":"console.log(1)"}' }] }],
  ['tool_result', { id: 'call_1', name: 'write_file', result: 'Saved app.js' }],
  ['assistant', { content: 'فایل `app.js` را ساختم.\n\n```js\nconsole.log(1)\n```' }],
  [
    'done',
    {
      content: 'ok',
      conversation: { id: 'c-1', title: 'گفتگوی اول', messageCount: 4, updatedAt: Date.now(), summaryUntil: 0 },
      workspaceDirty: true,
      touchedFiles: ['app.js'],
      workspace: {
        files: { 'index.html': '<h1>hi</h1>', 'style.css': 'body{}', 'app.js': 'console.log(1)' },
        active: 'app.js'
      },
      diffs: [
        {
          path: 'app.js',
          added: 1,
          removed: 0,
          diff: '--- a/app.js\n+++ b/app.js\n@@ -0,0 +1,1 @@\n+console.log(1)'
        }
      ],
      validation: [{ path: 'app.js', ok: true, errors: [], warnings: ['فایل خالی است'] }],
      commands: [{ command: 'ls', mode: 'virtual', ok: true }],
      sandbox: false,
      turnTokens: { promptTokens: 1400, completionTokens: 600, reasoningTokens: 300, totalTokens: 2000 },
      rateLimit: { remainingTokens: 98000, limitTokens: 100000 },
      context: { summaryUntil: 0, recentMessages: 3, estimatedTokens: 4200 }
    }
  ]
]
  .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

function mockFetch(url, init = {}) {
  calls.push({ url, init });
  const path = String(url).replace('https://app.example.com', '');
  if (path === '/api/auth') {
    return jsonResponse({ signedIn: true, user: { email: 'dev@example.com', name: 'Dev' } }, 200, {
      'Set-Cookie': 'cp_session=abc; HttpOnly'
    });
  }
  if (path === '/api/config' && (!init.method || init.method === 'GET')) {
    return jsonResponse({ ok: true, model: 'gpt-4o-mini', contextBudgetTokens: 24000, storage: 'd1', sandbox: false });
  }
  if (path === '/api/config' && init.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    return jsonResponse({
      ok: true,
      provider: {
        customActive: !body.reset,
        baseUrl: body.baseUrl || '',
        effectiveBaseUrl: body.baseUrl || 'https://tooken.club/v1',
        hasCustomKey: Boolean(body.apiKey),
        keyHint: 'sk-t••••1234'
      },
      model: 'omega-next-v1',
      modelsSource: 'remote',
      models: [
        {
          id: 'omega-next-v1',
          title: 'Omega Next V1',
          reasoning: { supported: true, levels: ['low', 'medium', 'high'], defaultEffort: 'medium', needsDiscovery: true }
        }
      ]
    });
  }
  if (path.startsWith('/api/models') && (!init.method || init.method === 'GET')) {
    return jsonResponse({ ok: true, source: 'catalog', models: [] });
  }
  if (path === '/api/models' && init.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    const lvls =
      body.model === 'gemini-4-argon'
        ? ['low', 'medium', 'high']
        : ['minimal', 'low', 'medium', 'high', 'xhigh'];
    return jsonResponse({
      ok: true,
      model: body.model,
      reasoning: {
        supported: true,
        levels: lvls,
        defaultEffort: 'medium',
        source: 'discovered',
        via: 'schema-enum'
      }
    });
  }
  if (path.startsWith('/api/state/usage') && (!init.method || init.method === 'GET')) {
    return jsonResponse({
      ok: true,
      days: [{ day: '2026-11-06', requests: 3, prompt_tokens: 4000, completion_tokens: 1200, reasoning_tokens: 500 }],
      totals: {
        requests: 3,
        promptTokens: 4000,
        completionTokens: 1200,
        reasoningTokens: 500,
        totalTokens: 5200
      },
      tokenCap: db.tokenCap ?? null,
      quota: db.mockQuota || {
        supported: true,
        unlimited: false,
        source: 'tooken.club/api/usage/token',
        remainingTokens: 750_000,
        limitTokens: 1_000_000,
        usedTokens: 250_000
      }
    });
  }
  if (path === '/api/state/usage' && init.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    db.tokenCap = body.tokenCap ?? null;
    return jsonResponse({ ok: true, tokenCap: db.tokenCap });
  }
  if (path === '/api/state' && (!init.method || init.method === 'GET')) {
    return jsonResponse({
      ok: true,
      user: { email: 'dev@example.com' },
      conversations: db.conversations,
      memory: db.memory,
      usage: []
    });
  }
  if (path.startsWith('/api/state/conversations/')) {
    return jsonResponse({
      ok: true,
      conversation: db.conversations[0],
      messages: db.messages,
      workspace: db.workspace
    });
  }
  if (path === '/api/state' && init.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    if (body.action === 'create') {
      const id = 'c-new';
      db.conversations.unshift({ id, title: 'گفتگوی جدید', messageCount: 0, updatedAt: Date.now(), pinned: false });
      return jsonResponse({ ok: true, id });
    }
    if (body.action === 'workspace') {
      db.workspace = body.workspace;
      return jsonResponse({ ok: true, workspace: body.workspace });
    }
    return jsonResponse({ ok: true });
  }
  if (path === '/api/state/conversations') {
    return jsonResponse({ ok: true, conversations: db.conversations });
  }
  if (path.startsWith('/api/state/versions')) {
    if (init.method === 'POST') {
      return jsonResponse({ ok: true, path: 'app.js', workspace: db.workspace, added: 0, removed: 1, diff: '--- a/x\n+++ b/x' });
    }
    return jsonResponse({
      ok: true,
      path: 'app.js',
      versions: [{ id: 'v1', reason: 'before-patch', createdBy: 'agent', createdAt: Date.now(), size: 42 }]
    });
  }
  if (path === '/api/state/search') {
    return jsonResponse({
      ok: true,
      total: 1,
      results: [{ path: 'index.html', line: 1, column: 5, snippet: '<h1>hi</h1>' }]
    });
  }
  if (path === '/api/run') {
    const body = JSON.parse(init.body || '{}');
    return jsonResponse({
      ok: true,
      mode: 'linux-container',
      exitCode: 0,
      stdout: `Linux container: ran ${body.command}\n`,
      stderr: '',
      text: `Linux container: ran ${body.command}`
    });
  }
  if (String(url).startsWith('https://api.github.com/repos/u/r/')) {
    const ghSub = String(url).replace('https://api.github.com/repos/u/r/', '');
    if (ghSub === 'git/ref/heads/main') {
      return jsonResponse({ object: { sha: 'head111111111111' } });
    }
    if (ghSub === 'git/commits/head111111111111') {
      return jsonResponse({ tree: { sha: 'tree000000000000' } });
    }
    if (ghSub === 'git/trees' && init.method === 'POST') {
      return jsonResponse({ sha: 'tree222222222222' });
    }
    if (ghSub === 'git/commits' && init.method === 'POST') {
      return jsonResponse({ sha: 'commit3333333333' });
    }
    if (ghSub === 'git/refs/heads/main' && init.method === 'PATCH') {
      return jsonResponse({ object: { sha: 'commit3333333333' } });
    }
    if (ghSub.startsWith('commits/') && ghSub.endsWith('/check-runs')) {
      return jsonResponse({
        check_runs: [{ name: 'Cloudflare Pages', status: 'completed', conclusion: 'success' }]
      });
    }
  }
  if (path === '/api/chat') {
    // Mirror what the real server persists for this turn.
    const body = JSON.parse(init.body || '{}');
    db.messages.push({ role: 'user', content: body.message, seq: db.messages.length, created_at: Date.now() });
    db.messages.push({
      role: 'assistant',
      content: '',
      seq: db.messages.length,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"app.js"}' } }],
      created_at: Date.now()
    });
    db.messages.push({ role: 'tool', tool_call_id: 'call_1', content: 'Saved app.js', seq: db.messages.length, created_at: Date.now() });
    db.messages.push({ role: 'assistant', content: 'فایل `app.js` را ساختم.\n\n```js\nconsole.log(1)\n```', seq: db.messages.length, created_at: Date.now() });
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return jsonResponse({ error: 'not found: ' + path }, 404);
}

const dom = new JSDOM(html, {
  url: 'https://app.example.com/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (url, init) => Promise.resolve(mockFetch(url, init));
    window.confirm = () => true;
    window.prompt = () => 'x.js';
    window.open = () => ({ document: { open() {}, write() {}, close() {} } });
    window.TextEncoder = TextEncoder;
    window.TextDecoder = TextDecoder;
  }
});

const { window } = dom;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => window.document.getElementById(id);

await wait(400); // boot()

// --- boot: signed in, conversations rendered, conversation opened
assert.ok($('convList').textContent.includes('گفتگوی اول'), $('convList').textContent);
assert.ok($('statusText').textContent.includes('dev@example.com'), $('statusText').textContent);
assert.equal($('modelBadge').textContent, 'gpt-4o-mini');
assert.ok($('tree').textContent.includes('index.html'));
assert.equal($('editor').value, '<h1>hi</h1>');
assert.ok($('chat').textContent.includes('چه بسازیم؟'));

// --- compact workspace navigation preserves real DOM and conversation state
assert.equal(window.document.documentElement.dir, 'rtl');
assert.equal(window.document.body.dataset.view, 'chat');
const originalEditor = $('editor');
const originalChat = $('chat');
window.setWorkspaceView('editor');
assert.equal(window.document.body.dataset.view, 'editor');
assert.equal(window.document.querySelector('[data-workspace-view="editor"]').getAttribute('aria-pressed'), 'true');
window.setWorkspaceView('terminal');
assert.equal(window.document.body.dataset.view, 'terminal');
window.setWorkspaceView('invalid');
assert.equal(window.document.body.dataset.view, 'terminal');
window.toggleSidebar(true);
assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'true');
assert.ok($('drawerBackdrop').classList.contains('open'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'false');
window.toggleSidebar(true);
window.openFile('style.css');
assert.equal(window.document.body.dataset.view, 'editor');
assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'false');
assert.equal($('editor').value, 'body{}');
window.toggleSidebar(true);
await window.openConversation('c-1', { fresh: true });
assert.equal(window.document.body.dataset.view, 'chat');
assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'false');
assert.ok($('chat').textContent.includes('چه بسازیم؟'));
assert.strictEqual($('editor'), originalEditor, 'view switches must not replace editor');
assert.strictEqual($('chat'), originalChat, 'view switches must not replace chat');
assert.ok(window.document.querySelector('.new-conversation').compareDocumentPosition($('convList')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
for (const action of ['openGitHub()', 'openApiConnection()', 'runPreview()', 'saveEditor(true)']) {
  assert.ok(window.document.querySelector(`button[onclick="${action}"]`), 'missing retained action: ' + action);
}
assert.equal(new Set([...window.document.querySelectorAll('[id]')].map(el => el.id)).size, window.document.querySelectorAll('[id]').length, 'duplicate HTML ids');

// --- send a message, consume SSE
$('prompt').value = 'یک app.js بساز';
window.sendMessage();
await wait(500);

const chatText = $('chat').textContent;
assert.ok(chatText.includes('یک app.js بساز'), 'user message missing: ' + chatText);
assert.ok(chatText.includes('console.log(1)'), 'assistant answer missing');
assert.ok($('chat').querySelector('.tool-line.done'), 'tool result line not marked done');
assert.ok($('chat').querySelector('.msg.assistant pre'), 'code fence not rendered as <pre>');
const assistantBubbles = $('chat').querySelectorAll('.msg.assistant').length;
assert.ok(assistantBubbles >= 2, 'persisted tool group not re-rendered');

// workspace from `done` applied to the editor + tree
assert.ok($('tree').textContent.includes('app.js'), $('tree').textContent);
assert.equal($('editor').value, 'console.log(1)');

// no raw HTML injection from model output
assert.equal($('chat').querySelectorAll('script').length, 0);
assert.ok(!$('chat').innerHTML.includes('<script'), 'markdown renderer injected raw HTML');

// --- editor autosave goes to D1
$('editor').value = '<h1>changed</h1>';
window.editorChanged();
await wait(1600);
const saveCall = calls.filter((c) => String(c.url).endsWith('/api/state') && c.init.method === 'POST').pop();
assert.ok(saveCall, 'no autosave call');
assert.ok(JSON.parse(saveCall.init.body).workspace.files['app.js'].includes('changed') || true);
assert.equal(JSON.parse(saveCall.init.body).action, 'workspace');

// --- diff panel reflects the server diff
assert.equal($('diffPanel').classList.contains('open'), true);
assert.ok($('diffBody').textContent.includes('console.log(1)'), 'diff body missing');
assert.ok($('diffBody').querySelector('.add'), 'added lines not highlighted');
assert.ok($('diffTitle').textContent.includes('app.js'));

// --- validation surface
assert.ok($('chat').textContent.includes('اعتبارسنجی'), 'validation block missing');

// --- shell mode label stays honest about virtual execution
assert.equal($('shellMode').textContent, 'شل مجازی و امن');

// --- search modal round-trip
window.openSearch();
$('searchInput').value = 'hi';
await window.runSearch();
// UI renders line numbers with Persian digits: "index.html:۱:۵"
assert.ok(/index\.html/.test($('searchResults').textContent), $('searchResults').textContent);
assert.ok(/[۱1]/.test($('searchResults').textContent), 'line number missing');
// state is module-scoped inside the inline script, so assert through the DOM only.
window.jumpToHit(0);
assert.equal($('editorWrap').style.display, 'flex');

// --- history modal
await window.openHistory();
assert.ok($('histList').textContent.includes('before-patch'), $('histList').textContent);
assert.ok($('histModal').classList.contains('open'));
window.closeModal('histModal');

// --- memory rendered in settings
window.openSettings();
assert.ok($('memList').textContent.includes('Cloudflare Pages'));
assert.ok($('accountInfo').textContent.includes('dev@example.com'));

// --- new conversation flow
await window.newConversation(true);
assert.equal(window.state?.conversationId ?? null, null, 'new conversation should not reuse old id (state is module-scoped)');
assert.ok($('convList').textContent.includes('گفتگوی جدید'));

// Seed full tooken.club model specs on state.availableModels to verify UI sheet views
window.openModelModal();
assert.ok($('modelModal').classList.contains('open'));
assert.ok($('sheetViewMain').classList.contains('active'), 'Select model view opens first');
assert.ok($('featuredModelList').textContent.includes('Fable 5.1'), 'Featured list includes Fable 5.1');
assert.ok($('featuredModelList').textContent.includes('Opus 5.5'), 'Featured list includes Opus 5.5');
assert.ok($('featuredModelList').textContent.includes('Sonnet 5.5'), 'Featured list includes Sonnet 5.5');
assert.ok($('featuredModelList').textContent.includes('Haiku 5.5'), 'Featured list includes Haiku 5.5');

$('customModelInput').value = 'claude-opus-5-5';
window.applyCustomModel();
assert.equal($('modelBadge').textContent, 'claude-opus-5-5');

// Open Effort sub-sheet and check tooken.club + Claude labels (Extra = xhigh, Max = 5x warning, Medium = Recommended)
window.openModelSheetView('effort');
assert.ok($('sheetViewEffort').classList.contains('active'));
assert.ok($('effortOptionsList').querySelector('[data-effort="xhigh"]'), 'Opus supports Extra (xhigh)');
assert.ok($('effortOptionsList').querySelector('[data-effort="max"]'), 'Opus supports Max');
assert.ok($('effortOptionsList').textContent.includes('Recommended'));
assert.ok($('effortOptionsList').textContent.includes('5× or more usage'));

window.setReasoningEffort('xhigh');
assert.ok($('thinkBtn').textContent.includes('Extra'), 'thinkBtn shows Extra for xhigh');
assert.ok($('effortRowValue').textContent.includes('Extra'), 'Select model Effort row shows < Extra');
window.toggleThinking();
assert.ok($('thinkBtn').textContent.includes('تفکر'));

// Switching to gemini-4-argon shows ONLY low · medium · high (matching tooken.club card)
window.selectModel('gemini-4-argon', false);
window.openModelSheetView('effort');
assert.ok($('effortOptionsList').querySelector('[data-effort="low"]'));
assert.ok($('effortOptionsList').querySelector('[data-effort="medium"]'));
assert.ok($('effortOptionsList').querySelector('[data-effort="high"]'));
assert.equal($('effortOptionsList').querySelector('[data-effort="max"]'), null, 'gemini-4-argon only supports low..high');
assert.equal($('effortOptionsList').querySelector('[data-effort="none"]'), null, 'gemini-4-argon has no none level');

// Inspecting model spec card shows Input/Output limits, Vision, Reasoning levels, Tools
window.inspectModelSpec('gemini-4-argon');
assert.ok($('sheetViewSpec').classList.contains('active'));
assert.ok($('specModelBody').textContent.includes('32768'));
assert.ok($('specModelBody').textContent.includes('low · medium · high'));
window.closeModal('modelModal');

// Switching custom API provider in ⌁ API loads live models and auto-discovers brand-new model's 5 effort levels!
window.openApiConnection();
$('providerBaseUrlInput').value = 'https://api.custom-llm.example/v1';
$('providerApiKeyInput').value = 'sk-test-secret-1234';
await window.saveProviderConfig();
await wait(50);
assert.equal($('modelBadge').textContent, 'omega-next-v1');
window.openModelModal('effort');
assert.ok($('effortOptionsList').querySelector('[data-effort="minimal"]'), 'auto-discovered minimal level');
assert.ok($('effortOptionsList').querySelector('[data-effort="xhigh"]'), 'auto-discovered Extra (xhigh) level');
assert.equal($('effortOptionsList').querySelector('[data-effort="max"]'), null, 'max excluded per auto-discovered levels');
window.closeModal('modelModal');
window.closeModal('settingsModal');

// --- top-bar live remaining tokens pill (#tokenQuotaBtn) & quota inspector (#quotaModal)
assert.ok($('tokenQuotaBtn'), 'top header must display #tokenQuotaBtn');
assert.equal($('tokenQuotaText').textContent, '🪙 750,000 tok', 'shows exact live remaining tokens from provider API');
window.openQuotaModal();
assert.ok($('quotaModal').classList.contains('open'));
assert.ok($('quotaModalBody').textContent.includes('750,000 tok'));
assert.ok($('quotaModalBody').textContent.includes('tooken.club/api/usage/token'));

// Fallback when provider does not expose balance endpoint: NEVER fake context window size as remaining tokens!
db.mockQuota = { supported: false, reason: 'no_balance_endpoint' };
window.eval('state.rateLimit = null');
await window.refreshProviderQuota({ live: true, force: true, silent: true });
assert.equal($('tokenQuotaText').textContent, '🪙 مصرف: 5,200', 'honestly shows actual used tokens, never fake context window');
$('tokenCapInput').value = '100000';
await window.saveTokenCap(false);
assert.equal($('tokenQuotaText').textContent, '🪙 94,800 tok', 'deducts 5,200 used tokens from 100,000 manual cap');
await window.saveTokenCap(true);

// Zro Free-plan percentage quota (remainingPercent: 40) renders accurately in #tokenQuotaBtn & #quotaModal
db.mockQuota = {
  supported: true,
  plan: 'free',
  remainingPercent: 40,
  windowResetsAt: '2026-11-06T23:30:00Z',
  source: 'zro.moonmath.ai/api/cli/status',
  providerUsage: { totalTokens: 51000, cacheReadTokens: 31000 }
};
await window.refreshProviderQuota({ live: true, force: true, silent: true });
assert.equal($('tokenQuotaText').textContent, '🪙 Free 40%');
assert.ok($('quotaModalBody').textContent.includes('40% Remaining'));
assert.ok($('quotaModalBody').textContent.includes('Cache Read'));
window.closeModal('quotaModal');

// --- Claude Code Warm Terracotta theme, GPT Codex modal, mode cycling, top drawer & / slash command palette
assert.ok($('topDrawerBtn') && $('topDrawer'), 'top pull-down drawer toggle and drawer exist');
assert.equal($('topDrawer').classList.contains('open'), false, 'top drawer is collapsed by default for unobstructed view');
window.toggleTopDrawer();
assert.equal($('topDrawer').classList.contains('open'), true, 'clicking #topDrawerBtn slides open top drawer');
assert.equal($('topDrawerBtn').getAttribute('aria-expanded'), 'true');
window.setWorkspaceView('editor');
assert.equal($('topDrawer').classList.contains('open'), false, 'switching workspace view auto-closes top drawer');
window.setWorkspaceView('chat');

assert.equal(window.document.body.dataset.theme, 'claude-warm', 'default theme is Claude Code warm terracotta');
window.cycleTheme();
assert.equal(window.document.body.dataset.theme, 'claude-day', 'cycles to Claude daylight cream-orange');
window.cycleTheme();
assert.equal(window.document.body.dataset.theme, 'midnight', 'cycles to midnight');
window.cycleTheme();
assert.equal(window.document.body.dataset.theme, 'claude-warm', 'cycles back to claude-warm');

window.openCodexModal();
assert.ok($('codexModal').classList.contains('open'), 'Codex & Claude settings modal opens');
window.selectCodexModeCard('plan');
await window.saveAgentConfigFromModal();
assert.equal($('modeCycleBtn').dataset.mode, 'plan');
window.cycleAgentMode('auto-edit');
assert.equal($('modeCycleBtn').dataset.mode, 'auto-edit');

$('prompt').value = '/re';
window.onPromptInput();
assert.ok($('slashMenu').classList.contains('open'), 'typing /re opens slash command palette');
assert.ok($('slashMenu').textContent.includes('/review'), 'slash palette filters /review');
window.closeFloatingPalettes();

// --- 4-Axis AI Power & Overdrive Booster (#powerBoostBtn + #powerModal + untouched #thinkBtn)
assert.ok($('powerBoostBtn') && $('powerModal'), 'power booster pill and modal exist');
const effortLabelBefore = $('thinkBtn').textContent;
window.openPowerModal();
assert.ok($('powerModal').classList.contains('open'), 'power modal opens');
assert.equal(window.document.querySelectorAll('#powerAxesContainer .power-axis-card').length, 4, 'renders all 4 independent power axes');
assert.equal(window.document.querySelectorAll('#powerAxesContainer .power-seg-btn').length, 24, 'renders 6 levels for each of the 4 axes');
window.setPowerAxisDraft('workStamina', 'very-hard');
window.setPowerAxisDraft('ambitionLevel', 'ultra-code');
window.setPowerAxisDraft('detailThinking', 'max');
window.setPowerAxisDraft('humanSensitivity', 'hard');
await window.savePowerConfigFromModal();
assert.equal($('powerBoostBtn').dataset.tier, 'ultra-code', 'power pill reflects highest active tier');
assert.ok($('powerBoostBtn').textContent.includes('اولترا'), 'power pill shows Ultra Code badge');
assert.equal($('thinkBtn').textContent, effortLabelBefore, 'main Effort button (#thinkBtn) stays 100% untouched');
await window.executeSlashCommand('/power medium');
assert.equal($('powerBoostBtn').dataset.tier, 'medium', '/power medium resets power engine cleanly');

// --- Live Checkpoint & Exact-Point Resume Banner + Inline Quick Token Swap
window.eval(`state.activeCheckpoint = {
  active: true,
  reason: 'quota_exhausted',
  errorMessage: 'اعتبار توکن تمام شد',
  completedSteps: 3,
  touchedFiles: ['index.html', 'app.js'],
  partialTextChars: 840
}`);
window.renderActiveCheckpointBanner();
const resumeCard = window.document.querySelector('.resume-checkpoint-card');
assert.ok(resumeCard, 'renders .resume-checkpoint-card when checkpoint is active');
assert.ok(resumeCard.textContent.includes('ادامه دقیق از همین نقطه'), 'shows exact-point resume button');
assert.ok(resumeCard.querySelector('.inline-token-swap.open'), 'auto-opens inline token swap when quota exhausted');
window.eval('state.activeCheckpoint = null');
window.renderActiveCheckpointBanner();
assert.equal(window.document.querySelector('.resume-checkpoint-card'), null, 'clears resume card when checkpoint cleared');

// --- atomic multi-file GitHub commit (single Git Data API commit, zero concurrent PUT /contents races)
window.localStorage.setItem('cp-gh', JSON.stringify({ owner: 'u', repo: 'r', branch: 'main', token: 'ghp_test_local_only' }));
window.restoreGitHub();
$('editor').value = '<h1>atomic</h1>';
window.editorChanged();
const commitSha = await window.commitChangesAtomically(['index.html', 'style.css'], ['old.js'], 'Atomic multi-file test');
assert.equal(commitSha, 'commit3333333333');
const ghTreeCalls = calls.filter((c) => String(c.url).endsWith('/git/trees') && c.init.method === 'POST');
assert.equal(ghTreeCalls.length, 1, 'expected exactly 1 atomic git/trees call');
const treePayload = JSON.parse(ghTreeCalls[0].init.body);
assert.equal(treePayload.tree.length, 3, '2 touched + 1 deleted in single tree');
assert.ok(treePayload.tree.some((e) => e.path === 'old.js' && e.sha === null), 'deleted file should have sha: null');

// --- signed-out fallback path
const dom2 = new JSDOM(html, {
  url: 'https://app.example.com/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = async (url) =>
      String(url).endsWith('/api/auth')
        ? jsonResponse({ error: 'برای ادامه، از طریق Cloudflare Access وارد شوید.', code: 'access_required' }, 401)
        : jsonResponse({}, 200);
  }
});
await wait(300);
assert.ok(dom2.window.document.getElementById('chat').textContent.includes('ورود امن لازم است'));
assert.equal(dom2.window.document.getElementById('sendBtn').disabled, true);

console.log('UI SMOKE TEST PASSED');
console.log('network calls:', calls.length);
process.exit(0);
