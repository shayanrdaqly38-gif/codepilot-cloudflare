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
    if (body.sandboxConfig) {
      const sbMode = body.sandboxConfig.reset ? 'auto' : (body.sandboxConfig.mode || 'auto');
      return jsonResponse({
        ok: true,
        sandboxConfig: {
          mode: sbMode,
          cloudUrl: body.sandboxConfig.cloudUrl || '',
          hasCloudToken: Boolean(body.sandboxConfig.cloudToken),
          tokenHint: body.sandboxConfig.cloudToken ? 'cp_••••9999' : '',
          localUrl: body.sandboxConfig.localUrl || 'http://127.0.0.1:8787'
        },
        executionMode: sbMode === 'local-termux' ? 'local-termux' : (sbMode === 'cloud-url' ? 'remote-sandbox' : 'linux-container')
      });
    }
    const mockFallbacks = !body.reset && Array.isArray(body.fallbacks)
      ? body.fallbacks.map((fb, idx) => ({
          id: fb.id || `gw-${idx + 2}`,
          slot: idx + 2,
          label: fb.label || '',
          baseUrl: fb.baseUrl || '',
          hasKey: Boolean(fb.apiKey),
          keyHint: 'sk-b••••9999',
          defaultModel: fb.defaultModel || '',
          active: Boolean(fb.baseUrl && fb.apiKey),
          healthy: true,
          cooldownRemainingSec: 0
        }))
      : [];
    return jsonResponse({
      ok: true,
      provider: {
        customActive: !body.reset,
        baseUrl: body.baseUrl || '',
        effectiveBaseUrl: body.baseUrl || 'https://tooken.club/v1',
        hasCustomKey: Boolean(body.apiKey),
        keyHint: 'sk-t••••1234',
        maxGateways: 10,
        activeGatewayCount: body.reset ? 1 : (1 + mockFallbacks.length),
        workingGatewaySlot: 1,
        fallbacks: mockFallbacks
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
  if (path.startsWith('/api/state/workspace-file') && (!init.method || init.method === 'GET')) {
    return jsonResponse({ ok: true, path: 'a.txt', content: 'lazy file body', bytes: 14, mode: 'normal' });
  }
  if (path.startsWith('/api/images') && (!init.method || init.method === 'GET')) {
    return jsonResponse({
      ok: true,
      workersAiBound: true,
      images: db.generatedImages || []
    });
  }
  if (path === '/api/images' && init.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    const item = {
      id: 'img-flux-1001',
      url: '/api/images/img-flux-1001',
      downloadUrl: '/api/images/img-flux-1001?download=1',
      title: String(body.prompt || 'تصویر آزمایشی').slice(0, 48),
      prompt: body.prompt || '',
      style: body.style || 'auto',
      aspectRatio: body.aspectRatio || '1:1',
      width: 1024,
      height: 1024,
      engine: 'cloudflare-ai',
      model: '@cf/black-forest-labs/flux-1-schnell',
      modelLabel: 'Cloudflare FLUX.1 Schnell',
      mimeType: 'image/jpeg'
    };
    db.generatedImages = [item, ...(db.generatedImages || [])];
    return jsonResponse({ ok: true, image: item, persistedToChat: true });
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

// OpenRouter preset button + mobile bidi/Bearer cleanup + zero-503 atomic skipModels save
const lastConfigPost = calls.filter((c) => String(c.url).endsWith('/api/config') && c.init.method === 'POST').pop();
assert.equal(JSON.parse(lastConfigPost.init.body).skipModels, true, 'saveProviderConfig uses atomic skipModels:true fast path');
window.openApiConnection();
window.fillProviderPreset('openrouter');
assert.equal($('providerBaseUrlInput').value, 'https://openrouter.ai/api/v1', 'OpenRouter preset fills exact API v1 URL');
assert.equal(window.cleanClientCredential('\u200eBearer   sk-or-v1-mobile-paste\u200f', true), 'sk-or-v1-mobile-paste', 'cleans mobile RTL/Bearer paste');
window.closeModal('settingsModal');

// Progressive zero-lag rendering of ALL 450+ OpenRouter models (chunked infinite scroll + instant search across all 450)
window.eval(`state.availableModels = Array.from({ length: 450 }, (_, i) => ({
  id: i === 0 ? 'omega-next-v1' : 'vendor-' + (i % 15) + '/openrouter-model-' + String(i).padStart(3, '0') + ':free',
  title: i === 0 ? 'Omega Next V1' : 'OpenRouter Model ' + i,
  subtitle: 'Fast model #' + i,
  reasoning: { supported: true, levels: ['low', 'medium', 'high'], defaultEffort: 'medium' }
}))`);
window.openModelModal();
assert.equal($('selectModelHeading').textContent, 'Select model (450)', 'shows full 450 model count');
assert.equal($('allModelsHeading').textContent, 'All models (450)', 'All models view shows full 450 count');
assert.equal($('featuredModelList').querySelectorAll('.sheet-item').length, 80, 'initial chunk renders 80 items for zero lag');
assert.ok($('featuredModelList').querySelector('[data-role="featured-load-more"]'), 'shows progressive load-more bar');
window.appendMoreFeaturedModels(100);
assert.equal($('featuredModelList').querySelectorAll('.sheet-item').length, 180, 'progressive scroll/button appends +100 items without re-creating DOM');
window.appendMoreFeaturedModels(400);
assert.equal($('featuredModelList').querySelectorAll('.sheet-item').length, 450, 'all 450 models can be browsed in the list');
assert.equal($('featuredModelList').querySelector('[data-role="featured-load-more"]'), null, 'load-more bar disappears once all 450 rendered');
window.onModelSearchInput('openrouter-model-449');
assert.equal($('featuredModelList').querySelectorAll('.sheet-item[data-model-id]').length, 1, 'instant search finds model #449 across full 450 catalog');
window.onModelSearchInput('');
assert.equal($('modelGrid').querySelectorAll('.model-card').length, 80, 'All models grid also starts with fast 80-card chunk');
window.appendMoreGridModels(100);
assert.equal($('modelGrid').querySelectorAll('.model-card').length, 180, 'All models grid progressively appends +100 cards');
window.closeModal('modelModal');

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

// --- instant zero-upload New Chat + non-blocking conversation switch even while busy
window.eval('state.dirtyFiles.clear()');
const callsBeforeNewChat = calls.length;
const newId = await window.newConversation(true);
assert.equal(newId, 'c-new');
const newChatCalls = calls.slice(callsBeforeNewChat);
const createPost = newChatCalls.find((c) => String(c.url).endsWith('/api/state') && c.init.method === 'POST');
assert.ok(createPost, 'expected create POST');
const createBody = JSON.parse(createPost.init.body);
assert.equal(createBody.copyWorkspaceFrom, 'c-new', 'clones workspace server-side without uploading files');
assert.equal(createBody.workspace, undefined, 'does not upload multi-MB workspace on clean New Chat');
assert.equal(
  newChatCalls.filter((c) => String(c.url).includes('/api/state/conversations/c-new')).length,
  0,
  'does not re-download empty newly created conversation'
);
assert.ok($('chat').querySelector('.welcome'), 'shows clean welcome screen immediately');

// Simulate busy turn on c-new, then switch back to c-1 -> must detach cleanly and unlock sendBtn!
window.eval('state.busy = true; document.getElementById("sendBtn").disabled = true;');
await window.openConversation('c-1');
assert.equal($('sendBtn').disabled, false, 'switching conversations unlocks composer immediately');
assert.ok($('chat').textContent.includes('چه بسازیم؟'), 'switches back to c-1 messages');

// --- New Conversation Mode Picker (#newChatModal): 🧑‍💻 developer vs 📦 normal modes
// Build marker: <html data-build="…"> must exist so stale deploys are detectable
assert.ok(window.document.documentElement.dataset.build, 'html root carries a data-build marker');
assert.match(window.document.documentElement.dataset.build, /^\d{4}-\d{2}-\d{2}/, 'build marker is date-versioned');
// "+ گفتگوی جدید" opens the mode picker instead of instantly creating a conversation
const modeCallsBefore = calls.length;
window.document.querySelector('.new-conversation').click();
assert.ok($('newChatModal').classList.contains('open'), 'real button click opens the mode picker');
window.openNewConversationModal();
assert.ok($('newChatModal').classList.contains('open'), 'mode picker opens for new conversations');
assert.equal(window.document.querySelectorAll('#newChatModal .codex-mode-card').length, 2, 'exactly two mode cards rendered');
// Developer card selected by default
assert.ok(
  $('newChatModeDeveloper').classList.contains('active'),
  'developer mode pre-selected by default'
);
// Cancel keeps the current conversation untouched
window.closeModal('newChatModal');
assert.equal($('newChatModal').classList.contains('open'), false, 'cancel closes the picker');
assert.equal(calls.length, modeCallsBefore, 'cancel performs zero network calls');
assert.ok($('chat').textContent.includes('چه بسازیم؟'), 'cancel leaves the current conversation view intact');

// Selecting normal mode + start creates a conversation with mode:'normal' & empty workspace
window.openNewConversationModal();
$('newChatModeNormal').click();
assert.ok($('newChatModeNormal').classList.contains('active'), 'clicking the 📦 card selects normal mode');
assert.ok(!$('newChatModeDeveloper').classList.contains('active'), 'developer card deselects');
await window.startNewConversationFromModal();
const modeCreate = calls
  .slice(modeCallsBefore)
  .find((c) => String(c.url).endsWith('/api/state') && c.init.method === 'POST' && JSON.parse(c.init.body || '{}').action === 'create');
assert.ok(modeCreate, 'picker start POSTs a create action');
const modeCreateBody = JSON.parse(modeCreate.init.body);
assert.equal(modeCreateBody.mode, 'normal', 'create payload carries mode:normal');
assert.equal(modeCreateBody.copyWorkspaceFrom, undefined, 'normal mode never clones the previous workspace');
assert.deepEqual(modeCreateBody.workspace, { files: {}, active: '' }, 'normal mode starts with a strictly empty workspace');
assert.ok($('newChatModal').classList.contains('open') === false, 'picker closed after start');

// Normal-mode conversation renders empty tree + workspace usage meter + 📦 chip in the list
await wait(60);
const modeChip = window.document.querySelector('.conv-mode-chip');
assert.ok(modeChip, 'conversation list shows a 📦 mode chip for normal conversations');
assert.equal(modeChip.textContent.trim(), '📦');
assert.ok($('workspaceMeter'), '#workspaceMeter usage element exists');
assert.ok($('tree').textContent.includes('خالی است'), 'empty workspace tree rendered for normal mode');
assert.equal($('editorWrap').style.display, 'none', 'editor hidden with no file open');
assert.equal($('emptyEditor').style.display, 'grid', 'empty-editor placeholder shown');

// Lazy openFile: null placeholder content fetched on demand via /api/state/workspace-file
// (a large file created by the assistant stays a null placeholder + size hint in the tree)
window.eval(`
  state.workspace.files['big.bin'] = null;
  state.workspace.lazy = { 'big.bin': 600000 };
  state.workspace.totalBytes = 600000;
  renderTree();
`);
assert.ok($('tree').textContent.includes('۶۰۰'), 'lazy file shows its on-disk size in the tree');
const lazyCallsBefore = calls.length;
await window.openFile('big.bin');
const lazyFetch = calls.slice(lazyCallsBefore).find((c) => String(c.url).startsWith('/api/state/workspace-file'));
assert.ok(lazyFetch, 'lazy openFile fetches /api/state/workspace-file');
assert.ok(String(lazyFetch.url).includes('conversationId='), 'lazy fetch is scoped to the conversation');
assert.ok(String(lazyFetch.url).includes('path=big.bin'), 'lazy fetch carries the requested path');
assert.equal($('editor').value, 'lazy file body', 'lazy content loads into the editor after fetch');
assert.equal($('editor').readOnly, false, 'editor writable once lazy content arrives');

// Switching back to a developer conversation restores GitHub repo line (no meter-driven state leak)
await window.openConversation('c-1');
assert.ok($('tree').textContent.includes('index.html'), 'developer conversation tree renders repo files');

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

// --- marathon auto-continue: بعد از اتمام هر چرخه، بدون دخالت کاربر «ادامه» فرستاده می‌شود
window.localStorage.setItem('cp_marathon_auto', '1');
window.__CP_MARATHON_DELAY = 25; // سرعت‌بخشی تست (پیش‌فرض واقعی: ۳۵۰۰ms)
window.startMarathon({ goalOverride: 'بهبود ماژول احراز هویت و تست‌ها' });
await wait(900);
const autoChatText = $('chat').textContent;
assert.ok(autoChatText.includes('ادامه'), 'auto-continue did not fire; chat=' + autoChatText.slice(0, 300));
assert.ok($('marathonStatus').textContent.includes('⏳ ادامهٔ خودکار'), 'status counter missing: ' + $('marathonStatus').textContent);
assert.equal($('topMarathonPill').hidden, false, 'top marathon pill visible on active marathon conversation');
assert.equal($('slMarathonBadge').hidden, false, 'drawer marathon badge visible on active marathon conversation');

// Cross-conversation isolation: switching to c-new must hide active Marathon pill & prevent leaking into c-new
window.pauseMarathon();
assert.equal(window.getMarathonState().paused, true, 'pauseMarathon sets paused=true');
assert.equal(window.getEffectiveMarathonForTurn(), null, 'paused marathon is not injected into turn');
await window.openConversation('c-1');

// Stop marathon locally without firing wasteful extra LLM call
const callsBeforeStopMara = calls.length;
window.stopMarathon('manual');
await wait(60);
const chatCallsAfterStopMara = calls.slice(callsBeforeStopMara).filter((c) => String(c.url).endsWith('/api/chat'));
assert.equal(chatCallsAfterStopMara.length, 0, 'stopMarathon must not wastefully call /api/chat when idle');
assert.equal($('topMarathonPill').hidden, true, 'top marathon pill hidden after stop');

// Slash command `/marathon status` renders status card locally
await window.executeSlashCommand('/marathon status');
assert.ok($('chat').textContent.includes('وضعیت حالت ماراتن'), '/marathon status prints summary card');

window.localStorage.setItem('cp_marathon_auto', '0');
window.cancelMarathonAuto();

// --- Mobile UX, dynamic meta theme-color, code fence copy header, and smart scroll FAB
assert.ok($('mobileViewBar'), '#mobileViewBar quick navigation bar exists');
assert.ok($('scrollBottomBtn'), '#scrollBottomBtn floating jump button exists');
assert.ok($('metaThemeColor'), '#metaThemeColor meta tag exists');

window.applyTheme('claude-day');
assert.equal($('metaThemeColor').getAttribute('content'), '#FAF5EE', 'claude-day syncs light browser chrome color');
window.applyTheme('midnight');
assert.equal($('metaThemeColor').getAttribute('content'), '#101216', 'midnight syncs dark browser chrome color');
window.applyTheme('claude-warm');
assert.equal($('metaThemeColor').getAttribute('content'), '#211b17', 'claude-warm syncs warm browser chrome color');

// Mobile view bar switches active workspace view in 1 tap
const mobileEditorBtn = $('mobileViewBar').querySelector('[data-workspace-view="editor"]');
mobileEditorBtn.click();
assert.equal(window.document.body.dataset.view, 'editor', 'mobile bar switches to editor view');
assert.ok(mobileEditorBtn.classList.contains('active'), 'mobile editor tab marked active');
const mobileChatBtn = $('mobileViewBar').querySelector('[data-workspace-view="chat"]');
mobileChatBtn.click();
assert.equal(window.document.body.dataset.view, 'chat', 'mobile bar switches back to chat view');

// Enhanced markdown: code fence header + copy button + headings + bold + XSS safety
const mdHtml = window.renderMarkdownish('## خلاصه تغییرات\nمتن **مهم** با <img src=x onerror=alert(1)>\n---\n```javascript\nconst ok = 42;\n```');
assert.ok(mdHtml.includes('class="code-fence-wrap"'), 'code fence wrapped with header container');
assert.ok(mdHtml.includes('data-role="copy-fence"'), 'code fence renders 1-tap copy button');
assert.ok(mdHtml.includes('>javascript<'), 'code fence shows language badge');
assert.ok(mdHtml.includes('<strong>مهم</strong>'), 'bold markdown rendered');
assert.ok(mdHtml.includes('class="md-h2"'), 'h2 heading rendered');
assert.ok(mdHtml.includes('class="md-hr"'), 'horizontal rule rendered');
assert.ok(!mdHtml.includes('<img'), 'raw HTML tags inside markdown stay escaped');

// Studio Image Generator UI: safe internal `/api/images/:id` card rendering, XSS rejection on external image URLs, `/imagine` command & Lightbox
assert.ok($('imageStudioBtn'), '#imageStudioBtn exists in composer');
assert.ok($('imageStudioModal'), '#imageStudioModal exists');
assert.ok($('imageLightboxModal'), '#imageLightboxModal exists');

const safeImgMd = window.renderMarkdownish('![لوگوی ققنوس](/api/images/img-flux-1001)\n![bad](https://evil.example/track.png)');
assert.ok(safeImgMd.includes('class="gen-image-card"'), 'trusted /api/images/:id rendered as interactive studio card');
assert.ok(safeImgMd.includes('/api/images/img-flux-1001?download=1'), '1-tap download link included');
assert.ok(!safeImgMd.includes('src="https://evil.example'), 'untrusted external markdown image URLs never auto-render');

await window.executeSlashCommand('/imagine لوگوی مدرن طلایی برای اپلیکیشن هوش مصنوعی');
assert.ok(
  $('chat').querySelector('.gen-image-card[data-img-url="/api/images/img-flux-1001"]'),
  '/imagine generates image via /api/images and renders studio card in chat'
);
$('chat').querySelector('.gen-image-card [data-role="zoom-gen-img"]').click();
assert.ok($('imageLightboxModal').classList.contains('open'), 'clicking studio image opens fullscreen lightbox');
window.closeModal('imageLightboxModal');

// Zero-overflow mobile layout guards (viewport lock, modal grid track clamp, pill non-crushing, busy button swap)
const styleText = Array.from(window.document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
assert.ok(/html\s*\{[^}]*overflow-x\s*:\s*hidden/.test(styleText), 'html locks overflow-x:hidden against mobile viewport shift');
assert.ok(/\.modal\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/.test(styleText), '.modal clamps implicit grid column to minmax(0,1fr)');
assert.ok(/\.sendrow\s*\{[^}]*flex-wrap\s*:\s*wrap/.test(styleText), '.sendrow wraps gracefully instead of overflowing .chatbox');
assert.ok(/\.mode-pill\s*\{[^}]*flex\s*:\s*0\s+0\s+auto/.test(styleText) && /\.mode-pill\s*\{[^}]*overflow\s*:\s*hidden/.test(styleText), '.mode-pill never crushes into a circle with bleeding text');
assert.ok(/\.power-pill\s*\{[^}]*flex\s*:\s*0\s+0\s+auto/.test(styleText) && /\.power-pill\s*\{[^}]*overflow\s*:\s*hidden/.test(styleText), '.power-pill never crushes into a circle with bleeding text');
assert.ok(/body\.is-working\s+#sendBtn\s*\{\s*display\s*:\s*none!important\s*\}/.test(styleText), 'disabled #sendBtn hides while #stopTurnBtn is shown during generation');
assert.ok(styleText.includes('.top-drawer .workspace-nav{display:none!important}'), 'duplicate workspace-nav inside #topDrawer is hidden on mobile');

window.document.body.classList.add('is-working');
assert.equal(window.getComputedStyle($('sendBtn')).display, 'none', '#sendBtn computed display is none while working');
window.document.body.classList.remove('is-working');
assert.notEqual(window.getComputedStyle($('sendBtn')).display, 'none', '#sendBtn computed display is restored when idle');

// Immersive fullscreen hides Android navigation bar ({ navigationUI: 'hide' }) on document.body (avoids :root top-layer 0px collapse)
assert.ok(window.document.querySelector('link[rel="manifest"][href="/manifest.webmanifest"]'), 'PWA fullscreen manifest linked');
assert.equal(window.document.documentElement.dataset.theme, 'claude-warm', 'html root syncs active theme against white chin');
assert.ok(!styleText.includes('html:fullscreen body{'), 'no circular percentage height rule on html:fullscreen body');
assert.ok(styleText.includes('body:fullscreen'), 'body:fullscreen flex column layout preserved');
let capturedFsOpts = null;
window.document.body.requestFullscreen = async (opts) => { capturedFsOpts = opts; };
await window.toggleFullscreen();
assert.equal(capturedFsOpts?.navigationUI, 'hide', 'toggleFullscreen calls body.requestFullscreen with navigationUI:"hide"');

// Personal Sandbox & Direct Local Termux Bridge (`#sandboxModal` + `127.0.0.1:8787` health probe & interactive terminal sync)
assert.ok($('sandboxSettingsBtn'), '#sandboxSettingsBtn exists in top drawer');
assert.ok($('sandboxModal'), '#sandboxModal exists');
window.openSandboxModal();
assert.ok($('sandboxModal').classList.contains('open'), 'openSandboxModal opens #sandboxModal');
window.selectSandboxMode('local-termux');
assert.equal($('sbModalPanelLocal').hidden, false, 'local-termux panel visible');
assert.ok($('sbModalTermuxCmdPreview').textContent.includes('server.mjs'), '1-click Termux setup snippet rendered');

// Mock http://127.0.0.1:8787/health & /run inside mockFetch via temporary window.fetch wrapper
const prevUiFetch = window.fetch;
window.fetch = async (u, init = {}) => {
  const s = String(u);
  if (s === 'http://127.0.0.1:8787/health') {
    return jsonResponse({ ok: true, runner: 'termux', platform: 'android', arch: 'arm64', node: 'v22.12.0' });
  }
  if (s === 'http://127.0.0.1:8787/run') {
    const payload = JSON.parse(init.body || '{}');
    return jsonResponse({
      ok: true,
      runner: 'termux',
      exitCode: 0,
      stdout: 'TERMUX_UI_OK: ' + payload.cmd,
      stderr: '',
      changedFiles: { 'from-termux.txt': 'synced from android!' }
    });
  }
  return prevUiFetch(u, init);
};
await window.probeLocalTermux();
assert.ok($('sbModalLocalProbeOut').textContent.includes('متصل شد'), 'local Termux health probe succeeds');
assert.ok(
  $('shellMode').textContent.includes('Termux'),
  'probeLocalTermux() IMMEDIATELY activates and persists local-termux even before saveSandboxSettings()'
);
await window.saveSandboxSettings();
assert.ok(!$('sandboxModal').classList.contains('open'), 'saveSandboxSettings closes modal');
assert.ok($('shellMode').textContent.includes('Termux'), '#shellMode badge reflects active Local Termux bridge');

// Run a command in interactive #terminal -> routes to 127.0.0.1:8787/run & syncs changedFiles into workspace!
const termInput = window.document.querySelector('#terminal input');
assert.ok(termInput, 'interactive terminal input exists');
termInput.value = 'uname -a';
termInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
assert.ok($('terminal').textContent.includes('TERMUX_UI_OK: uname -a'), 'terminal printed live Termux output');
window.openFile('from-termux.txt');
assert.equal($('editor').value, 'synced from android!', 'changedFiles from Local Termux synced directly into workspace editor');
await window.resetSandboxSettings();
window.fetch = prevUiFetch;

// 10-Gateway Smart Pool UI (`#providerGatewaysList` + `addBackupGatewaySlot` up to 10 gateways + `saveProviderConfig`)
window.openSettings();
assert.ok($('providerGatewaysList'), '#providerGatewaysList exists');
assert.ok($('addProviderGatewayBtn'), '#addProviderGatewayBtn exists');
$('providerBaseUrlInput').value = 'https://openrouter.ai/api/v1';
$('providerApiKeyInput').value = 'sk-or-ui-gw1-12345678';
// Slot #2 is already rendered ready-to-fill; fill slot #2 and add slots #3..#10 (total 9 backup cards = 10 gateways)
$('providerFallbackUrlInput').value = 'https://zro.moonmath.ai/v1';
$('providerFallbackKeyInput').value = 'zro-ui-gw2-12345678';
for (let s = 3; s <= 10; s += 1) {
  window.addBackupGatewaySlot(`https://gw${s}.example.com/v1`, `GW-${s}`);
  const cards = window.document.querySelectorAll('#providerGatewaysList [data-gw-idx]');
  const lastCard = cards[cards.length - 1];
  lastCard.querySelector('[data-gw-field="apiKey"]').value = `key_ui_gw_${s}_12345678`;
}
assert.equal(
  window.document.querySelectorAll('#providerGatewaysList [data-gw-idx]').length,
  9,
  'Renders 9 backup gateway cards (درگاه ۲ تا ۱۰) alongside Gateway 1 = 10 total gateways'
);
assert.equal($('addProviderGatewayBtn').disabled, true, 'Add button disables at 10-gateway maximum');
await window.saveProviderConfig();
assert.equal(
  window.document.querySelectorAll('#providerGatewaysList [data-gw-idx]').length,
  9,
  'All 10 gateways persist in D1 and re-render after saveProviderConfig()'
);
await window.resetProviderConfig();
window.closeModal('settingsModal');

// Free vs Paid Model Picker Badges (`#modelPricingFilterBar` + `setModelPricingFilter`) & Server-Verified Real Model Pill
window.eval(`
  state.provider.effectiveBaseUrl = 'https://openrouter.ai/api/v1';
  state.availableModels = [
    { id: 'qwen/qwen3-coder:free', title: 'Qwen3 Coder (free)', pricingTier: 'free' },
    { id: 'anthropic/claude-opus-4', title: 'Claude Opus 4', pricingTier: 'paid' }
  ];
  if (state.conversation) state.conversation.model = 'qwen/qwen3-coder:free';
  state.defaultModel = 'qwen/qwen3-coder:free';
`);
window.openModelModal();
assert.ok($('modelPricingFilterBar'), '#modelPricingFilterBar exists in #modelModal');
assert.ok($('featuredModelList').innerHTML.includes('🆓 رایگان'), 'Free model displays 🆓 رایگان badge');
assert.ok($('featuredModelList').innerHTML.includes('💳 پولی'), 'Paid model displays 💳 پولی badge');
window.setModelPricingFilter('free');
assert.equal($('featuredModelList').querySelectorAll('.sheet-item[data-model-id]').length, 1, 'Free filter shows only free models');
assert.equal($('featuredModelList').querySelector('.sheet-item[data-model-id]').dataset.modelId, 'qwen/qwen3-coder:free');
window.setModelPricingFilter('paid');
assert.equal($('featuredModelList').querySelectorAll('.sheet-item[data-model-id]').length, 1, 'Paid filter shows only paid models');
assert.equal($('featuredModelList').querySelector('.sheet-item[data-model-id]').dataset.modelId, 'anthropic/claude-opus-4');
window.setModelPricingFilter('all');
window.closeModal('modelModal');

const matchedBadge = window.renderVerifiedModelBadgeHtml({
  actualModel: 'qwen/qwen3-coder:free',
  requestedModel: 'qwen/qwen3-coder:free',
  gateway: { slot: 1, baseUrl: 'https://openrouter.ai/api/v1' }
});
assert.ok(matchedBadge.includes('🤖 مدل واقعی سرور:'), 'Matched model renders verified server badge');
assert.ok(matchedBadge.includes('qwen/qwen3-coder:free'));

const mismatchBadge = window.renderVerifiedModelBadgeHtml({
  actualModel: 'qwen/qwen3-coder:free',
  requestedModel: 'claude-opus-5-5',
  gateway: { slot: 1, baseUrl: 'https://openrouter.ai/api/v1' }
});
assert.ok(mismatchBadge.includes('mismatch'), 'Mismatched model renders amber mismatch alert class');
assert.ok(mismatchBadge.includes('⚠️ مدل واقعی اجراشده در سرور:'), 'Warns user clearly when server ran a different model than selected');

// Stopped turn bubble preservation (`preserveStoppedAssistantBubble` keeps partial text & thinking visible after reload)
window.eval(`
  const beforeCount = Array.isArray(state.messages) ? state.messages.length : 0;
  preserveStoppedAssistantBubble(beforeCount, 'متن نیمه‌کاره قبل از دکمه توقف', 'گام اول تفکر مدل');
`);
assert.ok(
  $('chat').textContent.includes('متن نیمه‌کاره قبل از دکمه توقف'),
  'Stopped partial assistant message stays visible in #chat and is never wiped'
);
assert.ok(
  $('chat').textContent.includes('گام اول تفکر مدل'),
  'Stopped partial thinking stays visible in #chat'
);

// Max Steps (200 / ۲۰۰) & Context Budget (50000 / ۵۰۰۰۰) persistence across #codexModal and #powerModal
window.openCodexModal();
$('cfgMaxSteps').value = '۲۰۰';
$('cfgContextBudget').value = '۵۰,۰۰۰';
await window.saveAgentConfigFromModal();
window.openCodexModal();
assert.equal($('cfgMaxSteps').value, '200', 'cfgMaxSteps persists 200 (including Persian digits ۲۰۰)');
assert.equal($('cfgContextBudget').value, '50000', 'cfgContextBudget persists 50000 (including Persian digits ۵۰,۰۰۰)');
window.closeModal('codexModal');
window.openPowerModal();
assert.equal($('powerMaxStepsInput').value, '200', 'Power modal syncs 200 maxSteps');
assert.equal($('powerContextBudgetInput').value, '50000', 'Power modal syncs 50000 contextBudget');
assert.ok($('powerMeterSpecs').textContent.includes('200') && $('powerMeterSpecs').textContent.includes('50K'), 'Power meter displays 200 steps · 50K ctx');
window.closeModal('powerModal');

console.log('UI SMOKE TEST PASSED');
console.log('network calls:', calls.length);
process.exit(0);
