// Tool-level tests: apply_patch, search, symbols, validation, undo, versions,
// sandbox fallback. These run the real /api/chat loop with a scripted model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const stateApi = await import(`${root}/api/state/index.js`);
const chat = await import(`${root}/api/chat.js`);
const oneConv = await import(`${root}/api/state/conversations/[id].js`);
const versionsApi = await import(`${root}/api/state/versions/index.js`);
const patch = await import(`${root}/_lib/patch.js`);
const search = await import(`${root}/_lib/search.js`);
const validate = await import(`${root}/_lib/validate.js`);
const sandbox = await import(`${root}/_lib/sandbox.js`);

const keys = rsaKeys();
fakeJwks(keys);

/* ------------------------------- pure units ------------------------------- */

test('applyEdits: exact, fuzzy, replaceAll, ambiguity and failure modes', () => {
  const exact = patch.applyEdits('a\nb\nc', [{ search: 'b', replace: 'B' }]);
  assert.equal(exact.content, 'a\nB\nc');
  assert.equal(exact.results[0].strategy, 'exact');

  // Indentation drift: file uses a tab, the model sent spaces.
  const fuzzy = patch.applyEdits('function x() {\n\treturn 1;\n}', [{ search: '  return 1;', replace: '  return 2;' }]);
  assert.equal(fuzzy.content, 'function x() {\n\treturn 2;\n}');
  assert.equal(fuzzy.results[0].strategy, 'fuzzy');

  // A literal substring inside a deeper indent is still an exact hit.
  const substring = patch.applyEdits('function x() {\n      return 1;\n}', [{ search: '  return 1;', replace: '  return 2;' }]);
  assert.equal(substring.results[0].strategy, 'exact');

  const all = patch.applyEdits('x\nx', [{ search: 'x', replace: 'y', replaceAll: true }]);
  assert.equal(all.content, 'y\ny');

  assert.throws(() => patch.applyEdits('x\nx', [{ search: 'x', replace: 'y' }]), (e) => e.code === 'patch_failed');
  assert.throws(() => patch.applyEdits('abc', [{ search: 'zzz', replace: 'q' }]), (e) => e.code === 'patch_failed');
  assert.throws(() => patch.applyEdits('abc', []), (e) => e.status === 400);
  assert.throws(() => patch.applyEdits('abc', [{ search: 'a', replace: 'b' }, { search: 'q', replace: 'r' }]), (e) =>
    /ویرایش شماره 2/.test(e.message)
  );
});

test('unifiedDiff has git-style hunks and correct counts', () => {
  const before = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n';
  const after = 'l1\nl2\nl3 changed\nl4\nl5\nl6\nl7\nl8\n';
  const diff = patch.unifiedDiff(before, after, { path: 'src.js' });
  assert.match(diff, /^--- a\/src\.js/m);
  assert.match(diff, /^\+\+\+ b\/src\.js/m);
  assert.match(diff, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);
  const stats = patch.diffStats(patch.diffLines(before, after));
  assert.deepEqual(stats, { added: 2, removed: 1 });
  assert.equal(patch.unifiedDiff('same', 'same'), '');
});

test('searchWorkspace finds literals, regex and respects path filters', () => {
  const files = {
    'app.js': 'const a = 1;\nfunction hello() {}\n',
    'style.css': '.hello { color: red; }\n',
    'notes.md': 'nothing here\n'
  };
  const literal = search.searchWorkspace(files, 'hello');
  assert.equal(literal.results.length, 2);
  assert.deepEqual(literal.results.map((r) => r.path).sort(), ['app.js', 'style.css']);
  assert.equal(literal.results[0].line, 2);

  const regex = search.searchWorkspace(files, 'function\\s+\\w+', { regex: true });
  assert.equal(regex.results.length, 1);
  assert.equal(regex.results[0].path, 'app.js');

  const filtered = search.searchWorkspace(files, 'hello', { pathFilter: '.css' });
  assert.equal(filtered.results.length, 1);
  assert.equal(filtered.results[0].path, 'style.css');

  assert.throws(() => search.searchWorkspace(files, '(' , { regex: true }), (e) => e.code === 'bad_regex');
  assert.match(search.formatSearchHits(search.searchWorkspace(files, 'zzz')), /No matches/);
});

test('listSymbols extracts functions, classes and CSS selectors', () => {
  const symbols = search.listSymbols({
    'a.js': 'function alpha() {}\nconst beta = () => 1;\nclass Gamma {}\n',
    'b.css': '.hero {}\n#main {}\n'
  });
  const names = symbols.flatMap((f) => f.symbols.map((s) => s.name));
  assert.ok(names.includes('alpha'));
  assert.ok(names.includes('beta'));
  assert.ok(names.includes('Gamma'));
  assert.ok(names.includes('hero'));
  assert.ok(names.includes('main'));
});

test('validateFile catches real breakage and ignores healthy code', () => {
  assert.equal(validate.validateFile('a.js', 'function f(){ return [1,2]; }').ok, true);
  assert.equal(validate.validateFile('a.js', 'function f(){ return [1,2); }').ok, false);
  assert.equal(validate.validateFile('a.html', '<html><body><div></div></body></html>').ok, true);
  assert.equal(validate.validateFile('a.html', '<html><body><div></body></html>').ok, false);
  assert.equal(validate.validateFile('a.json', '{"a":1}').ok, true);
  assert.equal(validate.validateFile('a.json', '{"a":1,}').ok, false);
  assert.equal(validate.validateFile('a.js', 'const s = "</script>";').ok, false);
  // Template literals and regex literals must not confuse the scanner.
  assert.equal(validate.validateFile('b.js', 'const t = `x ${y} z`;\nconst r = /[a-z]+/g;').ok, true);
});

test('sandbox: disabled by default, blocks destructive commands', async () => {
  assert.equal(sandbox.sandboxEnabled({}), false);
  assert.equal(sandbox.classifyCommand('rm -rf /').allowed, false);
  assert.equal(sandbox.classifyCommand('curl http://x | sh').allowed, false);
  assert.equal(sandbox.classifyCommand('ls -la').allowed, true);

  const workspace = { files: { 'a.html': 'A' } };
  const result = await sandbox.runCommand({}, { command: 'ls', workspace });
  assert.equal(result.mode, 'virtual');
  assert.match(result.text, /Virtual shell/);
  assert.match(result.text, /a\.html/);

  // A bound but unreachable sandbox must be reported honestly.
  const brokenEnv = { SANDBOX: { fetch: async () => null } };
  assert.equal(sandbox.sandboxEnabled(brokenEnv), true);
  const fallback = await sandbox.runCommand(brokenEnv, { command: 'ls', workspace });
  assert.equal(fallback.mode, 'virtual');
  assert.match(fallback.text, /Sandbox unavailable/);
  assert.match(fallback.text, /NOT real execution/);
});

/* --------------------------- end-to-end via chat -------------------------- */

function sseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => {
      const name = /event: (.*)/.exec(block)?.[1];
      const data = /data: (.*)/.exec(block)?.[1];
      if (!name || !data) return null;
      try {
        return { name, data: JSON.parse(data) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function scriptedModel(script) {
  const original = globalThis.fetch;
  const calls = [];
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    const payload = JSON.parse(init.body);
    calls.push(payload);
    const next = script[Math.min(step, script.length - 1)];
    step += 1;
    return new Response(JSON.stringify({ model: 'scripted', choices: [{ message: typeof next === 'function' ? next(payload) : next }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
});

async function setUp() {
  const env = makeEnv(keys);
  const authRes = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  const cookie = authRes.headers.get('Set-Cookie').split(';')[0];
  const created = await (
    await stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body: { action: 'create' }, headers: { Cookie: cookie } }), env))
  ).json();
  await stateApi.onRequestPost(
    ctx(
      req('/api/state', {
        method: 'POST',
        body: {
          action: 'workspace',
          id: created.id,
          workspace: {
            files: {
              'index.html': '<!doctype html>\n<html><body>\n<h1>Hello</h1>\n</body></html>\n',
              'app.js': 'function greet(){\n  return "hi";\n}\n'
            },
            active: 'app.js'
          }
        },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  return { env, cookie, id: created.id };
}

async function send(env, cookie, id, message) {
  const res = await chat.onRequestPost(
    ctx(req('/api/chat', { method: 'POST', body: { conversationId: id, message }, headers: { Cookie: cookie } }), env)
  );
  assert.equal(res.status, 200);
  return sseEvents(await res.text());
}

test('apply_patch edits a file, streams a diff, and creates a restorable version', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'apply_patch', {
      path: 'app.js',
      edits: [{ search: '  return "hi";', replace: '  return "hello world";' }]
    }),
    { role: 'assistant', content: 'متن بازگشتی را تغییر دادم.' }
  ]);
  let events;
  try {
    events = await send(env, cookie, id, 'متن greet را عوض کن');
  } finally {
    model.restore();
  }

  const done = events.at(-1);
  assert.equal(done.name, 'done');
  assert.deepEqual(done.data.touchedFiles, ['app.js']);
  assert.equal(done.data.workspace.files['app.js'].includes('hello world'), true);
  assert.equal(done.data.diffs.length, 1);
  assert.match(done.data.diffs[0].diff, /-  return "hi";/);
  assert.match(done.data.diffs[0].diff, /\+  return "hello world";/);
  assert.equal(done.data.diffs[0].added, 1);
  assert.deepEqual(done.data.validation, []);

  // The version row must exist and restore the original text.
  const versions = await (
    await versionsApi.onRequestGet(ctx(req('/api/state/versions?path=app.js', { headers: { Cookie: cookie } }), env))
  ).json();
  assert.ok(versions.versions.length >= 1);

  const restore = await (
    await versionsApi.onRequestPost(
      ctx(
        req('/api/state/versions', {
          method: 'POST',
          body: { action: 'restore', conversationId: id, path: 'app.js', versionId: versions.versions[0].id },
          headers: { Cookie: cookie }
        }),
        env
      )
    )
  ).json();
  assert.equal(restore.ok, true);
  assert.equal(restore.workspace.files['app.js'].includes('return "hi"'), true);
});

test('a rejected patch leaves the workspace untouched and tells the model why', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'apply_patch', { path: 'app.js', edits: [{ search: 'this text does not exist', replace: 'x' }] }),
    { role: 'assistant', content: 'نتوانستم.' }
  ]);
  let events;
  try {
    events = await send(env, cookie, id, 'یک ویرایش ناموجود');
  } finally {
    model.restore();
  }
  const toolResult = events.find((e) => e.name === 'tool_result');
  assert.equal(toolResult.data.ok, false);
  assert.match(toolResult.data.result, /not found|پیدا نشد/);
  const done = events.at(-1);
  assert.deepEqual(done.data.touchedFiles, []);
  assert.equal(done.data.workspace, undefined);

  const stored = await (
    await oneConv.onRequestGet(
      ctx(req(`/api/state/conversations/${id}`, { headers: { Cookie: cookie } }), env, { id })
    )
  ).json();
  assert.equal(stored.workspace.files['app.js'], 'function greet(){\n  return "hi";\n}\n');
});

test('search_code and list_symbols feed the model without extra reads', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'search_code', { query: 'Hello' }),
    toolCall('c2', 'list_symbols', {}),
    { role: 'assistant', content: 'پیدا شد.' }
  ]);
  let events;
  try {
    events = await send(env, cookie, id, 'کجا Hello هست؟');
  } finally {
    model.restore();
  }
  const results = events.filter((e) => e.name === 'tool_result');
  assert.equal(results.length, 2);
  assert.match(results[0].data.result, /index\.html:3/);
  assert.match(results[1].data.result, /greet@1/);
});

test('write_file reports validation errors back to the model', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'write_file', { path: 'broken.js', content: 'function f(){\n  return (1;\n}\n' }),
    { role: 'assistant', content: 'فایل را ساختم ولی اعتبارسنجی هشدار داد.' }
  ]);
  let events;
  try {
    events = await send(env, cookie, id, 'یک فایل بساز');
  } finally {
    model.restore();
  }
  const toolResult = events.find((e) => e.name === 'tool_result');
  assert.match(toolResult.data.result, /Validation:/);
  const done = events.at(-1);
  assert.equal(done.data.validation.length, 1);
  assert.equal(done.data.validation[0].path, 'broken.js');
  assert.ok(!done.data.validation[0].ok);
});

test('undo_edit restores the previous file content inside one turn', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'write_file', { path: 'app.js', content: 'const changed = true;\n' }),
    toolCall('c2', 'undo_edit', { path: 'app.js' }),
    { role: 'assistant', content: 'برگشت.' }
  ]);
  let events;
  try {
    events = await send(env, cookie, id, 'تغییر بده و برگردان');
  } finally {
    model.restore();
  }
  const done = events.at(-1);
  assert.match(done.data.workspace.files['app.js'], /return "hi"/);
  assert.ok(done.data.diffs.length >= 2);
});

test('run_command reports virtual mode explicitly and never fakes a sandbox', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'run_command', { command: 'ls' }),
    { role: 'assistant', content: 'فایل‌ها را لیست کردم (شل مجازی).' }
  ]);
  let events;
  try {
    events = await send(env, cookie, id, 'فایل‌ها را لیست کن');
  } finally {
    model.restore();
  }
  const toolResult = events.find((e) => e.name === 'tool_result');
  assert.match(toolResult.data.result, /Virtual shell/);
  const done = events.at(-1);
  assert.equal(done.data.sandbox, false);
  assert.equal(done.data.commands[0].mode, 'virtual');
  assert.deepEqual(done.data.touchedFiles, []);
});

test('a model failure after a successful edit keeps the edit and the partial group', async () => {
  const { env, cookie, id } = await setUp();
  const original = globalThis.fetch;
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    step += 1;
    if (step === 1) {
      return new Response(
        JSON.stringify({
          model: 'scripted',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'app.js', content: 'const kept = 1;\n' })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{"error":"boom"}', { status: 500 });
  };

  let events;
  try {
    events = await send(env, cookie, id, 'بنویس و بعد خطا بده');
  } finally {
    globalThis.fetch = original;
  }

  const errorEvent = events.find((e) => e.name === 'error');
  assert.ok(errorEvent, JSON.stringify(events.map((e) => e.name)));
  assert.deepEqual(errorEvent.data.savedFiles, ['app.js']);
  assert.equal(errorEvent.data.partial, true);

  const stored = await (
    await oneConv.onRequestGet(ctx(req(`/api/state/conversations/${id}`, { headers: { Cookie: cookie } }), env, { id }))
  ).json();
  assert.equal(stored.workspace.files['app.js'], 'const kept = 1;\n');
  const roles = stored.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-3), ['user', 'assistant', 'tool']);
});

test('search endpoint is owner-scoped and rejects a foreign conversation', async () => {
  const searchApi = await import(`${root}/api/state/search/index.js`);
  const { env, cookie, id } = await setUp();
  const ok = await (
    await searchApi.onRequestPost(
      ctx(req('/api/state/search', { method: 'POST', body: { conversationId: id, query: 'greet' }, headers: { Cookie: cookie } }), env)
    )
  ).json();
  assert.equal(ok.results.length, 1);
  assert.equal(ok.results[0].path, 'app.js');

  // Second user: must not see the first user's files.
  const other = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys, { sub: 'user-2', email: 'second@example.com' }) } }), env)
  );
  const otherCookie = other.headers.get('Set-Cookie').split(';')[0];
  const denied = await searchApi.onRequestPost(
    ctx(req('/api/state/search', { method: 'POST', body: { conversationId: id, query: 'greet' }, headers: { Cookie: otherCookie } }), env)
  );
  assert.equal(denied.status, 404);
});

test('version restore rejects a version from another file and another owner', async () => {
  const { env, cookie, id } = await setUp();
  const model = scriptedModel([
    toolCall('c1', 'write_file', { path: 'app.js', content: 'const a = 1;\n' }),
    { role: 'assistant', content: 'ok' }
  ]);
  try {
    await send(env, cookie, id, 'بنویس');
  } finally {
    model.restore();
  }
  const versions = await (
    await versionsApi.onRequestGet(ctx(req('/api/state/versions?path=app.js', { headers: { Cookie: cookie } }), env))
  ).json();
  assert.ok(versions.versions.length >= 1);
  const versionId = versions.versions[0].id;

  const wrongPath = await versionsApi.onRequestPost(
    ctx(
      req('/api/state/versions', {
        method: 'POST',
        body: { action: 'restore', conversationId: id, path: 'index.html', versionId },
        headers: { Cookie: cookie }
      }),
      env
    )
  );
  assert.equal(wrongPath.status, 400);

  const other = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys, { sub: 'user-3', email: 'third@example.com' }) } }), env)
  );
  const otherCookie = other.headers.get('Set-Cookie').split(';')[0];
  const denied = await versionsApi.onRequestPost(
    ctx(
      req('/api/state/versions', {
        method: 'POST',
        body: { action: 'restore', conversationId: id, path: 'app.js', versionId },
        headers: { Cookie: otherCookie }
      }),
      env
    )
  );
  assert.ok([403, 404].includes(denied.status), String(denied.status));
});

test('creating a file records a base version and produces a real diff', async () => {
  // Regression: write_file on a *new* path used to skip recordVersion and emit an
  // empty diff, so the UI showed no changes and creating a file was not undoable.
  const lib = await import(`${root}/_lib/versions.js`);
  const env = makeEnv(keys);
  const owner = 'owner@example.com';
  const conv = { id: 'conv-1', workspace: '{}' };

  const id = await lib.recordVersion(env, owner, conv, { path: 'new.js', content: '', reason: 'created' });
  assert.ok(id, 'a base version id must be returned');

  const list = await lib.listVersions(env, owner, 'new.js', { project: '' });
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'created');
  assert.equal(list[0].size, 0);

  // And a diff against an empty original is a real, non-empty patch.
  const diff = patch.unifiedDiff('', 'a\nb\n', { path: 'new.js' });
  assert.match(diff, /^--- a\/new\.js/m);
  assert.match(diff, /^\+b$/m);
});

test('model base URL is normalized and 4xx failures are explained', async () => {
  const model = await import(`${root}/_lib/model.js`);
  const suffix = '/chat/completions';
  for (const base of [
    'https://tooken.club/v1',
    'https://tooken.club/v1/',
    'https://tooken.club/v1/chat/completions',
    ' https://tooken.club/v1/// '
  ]) {
    assert.equal(model.modelEndpoint({ MODEL_BASE_URL: base }), 'https://tooken.club/v1' + suffix);
  }
  // The provider the user actually has must stay the default.
  assert.equal(model.modelEndpoint({}), 'https://tooken.club/v1' + suffix);

  // A wrong path or model must not surface as "unexpected server error".
  const cases = [
    [404, 'model_not_found'],
    [400, 'model_rejected'],
    [401, 'model_auth'],
    [429, 'model_rate_limited']
  ];
  for (const [status, code] of cases) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status });
    try {
      await assert.rejects(
        () => model.callModel({ MODEL_API_KEY: 'key-123456789012', MODEL_NAME: 'm' }, { messages: [{ role: 'user', content: 'hi' }] }),
        (error) => error.code === code,
        `status ${status} should map to ${code}`
      );
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('file_history reports saved versions and refuses unknown files', async () => {
  const { makeEnv } = await import('./harness.mjs');
  const env = makeEnv(keys);
  const owner = 'owner@example.com';
  const lib = await import(`${root}/_lib/versions.js`);
  const conv = { id: 'conv-h', workspace: '{}' };

  await lib.recordVersion(env, owner, conv, { path: 'a.js', content: 'one', reason: 'created' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await lib.recordVersion(env, owner, conv, { path: 'a.js', content: 'two', reason: 'before-write' });

  const rows = await lib.listVersions(env, owner, 'a.js', { project: null, limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reason, 'before-write', 'newest first');
  assert.equal(rows[1].reason, 'created');
  assert.ok(rows.every((r) => typeof r.size === 'number'));

  // Path traversal is rejected by the shared guard before touching the database.
  const store = await import(`${root}/_lib/store.js`);
  assert.equal(store.isSafePath('../../etc/passwd'), false);
  assert.equal(store.isSafePath('a.js'), true);
});

test('every tool the agent advertises is allowed through by the model layer', async () => {
  // Regression: a tool declared in TOOLS but missing from ALLOWED_TOOLS was
  // silently dropped by normalizeToolCalls, so the model called it and the
  // server answered with an empty turn ("انجام شد.") instead of running it.
  const model = await import(`${root}/_lib/model.js`);
  for (const tool of chat.TOOLS) {
    assert.ok(
      model.ALLOWED_TOOLS.has(tool.function.name),
      `${tool.function.name} is advertised but not allowed`
    );
  }
  // ...and the reverse: no allow-listed name is missing from TOOLS.
  const declared = new Set(chat.TOOLS.map((t) => t.function.name));
  for (const name of model.ALLOWED_TOOLS) {
    assert.ok(declared.has(name), `${name} is allowed but never offered to the model`);
  }

  // A call to a tool that is genuinely not on the list is still stripped.
  const payload = model.normalizeToolCalls([
    { id: 'x', type: 'function', function: { name: 'curl_secrets', arguments: '{}' } }
  ]);
  assert.deepEqual(payload, []);
});

test('validateFile validates shipped index.html with zero errors and handles raw-text <script>/<style> + tc_live_ secrets', async () => {
  const { readFileSync } = await import('node:fs');
  const realHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const realCheck = validate.validateFile('index.html', realHtml);
  assert.equal(realCheck.ok, true, `index.html failed validation: ${realCheck.errors.join(' | ')}`);
  assert.deepEqual(realCheck.errors, []);

  // JS string containing `<script>` inside a `<script>` block must NOT confuse the HTML tag matcher.
  const tricky = '<!doctype html><html><body><script>const x = "<script><div>";</script></body></html>';
  assert.equal(validate.validateFile('tricky.html', tricky).ok, true);

  // `tc_live_...` secrets are flagged by validateFile AND redacted by redactSecrets.
  const util = await import(`${root}/_lib/util.js`);
  const fakeKey = 'tc_live_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4';
  const secCheck = validate.validateFile('cfg.js', `const k = "${fakeKey}";`);
  assert.equal(secCheck.secrets.length, 1);
  assert.ok(secCheck.warnings.length >= 1);
  assert.ok(!util.redactSecrets(`my key is ${fakeKey}`).includes(fakeKey));
});

test('SSRF protection blocks private/loopback/metadata/redirect targets and fetch_url + web_search work cleanly', async () => {
  const web = await import(`${root}/_lib/web.js`);
  const blockedUrls = [
    'http://127.0.0.1/admin',
    'http://localhost:8788/api/state',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/',
    'http://172.20.0.1/',
    'http://100.64.0.1/',
    'http://[::1]:8080/',
    'http://[fd00::1]/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://metadata.google.internal/',
    'http://db.local/',
    'ftp://example.com/file',
    'https://user:pass@example.com/secret'
  ];
  for (const bad of blockedUrls) {
    assert.throws(() => web.assertSafeExternalUrl(bad), `expected SSRF block for ${bad}`);
  }
  assert.equal(web.assertSafeExternalUrl('https://api.github.com/zen').hostname, 'api.github.com');

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s === 'https://example.com/redirect-ssrf') {
      return new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    if (s === 'https://example.com/page') {
      return new Response(
        '<html><head><title>Test Doc</title><style>body{color:red}</style></head><body><h1>Hello World</h1><script>evil()</script><p>Live data 42.</p></body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    if (s.includes('html.duckduckgo.com')) {
      return new Response(
        '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fworkers%2F">Cloudflare Workers Docs</a><a class="result__snippet">Build serverless apps on the edge.</a></div>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    }
    return new Response(JSON.stringify({ hits: [], query: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const ssrfRedirect = await web.fetchExternalUrl({}, { url: 'https://example.com/redirect-ssrf' });
    assert.equal(ssrfRedirect.ok, false);
    assert.match(ssrfRedirect.text, /مسدود|داخلی/);

    const page = await web.fetchExternalUrl({}, { url: 'https://example.com/page' });
    assert.equal(page.ok, true);
    assert.match(page.text, /Title: Test Doc/);
    assert.match(page.text, /Hello World/);
    assert.ok(!page.text.includes('evil()'));

    const search = await web.searchWeb({}, { query: 'cloudflare workers', limit: 5 });
    assert.equal(search.ok, true);
    assert.match(search.text, /https:\/\/developers\.cloudflare\.com\/workers\//);
  } finally {
    globalThis.fetch = original;
  }
});

test('real Linux container execution & /api/run mount redacted workspace files and report exit codes honestly', async () => {
  const runApi = await import(`${root}/api/run.js`);
  const { env, cookie, id } = await setUp();
  const linuxEnv = { ...env, CF_PAGES: '1' };
  assert.equal(sandbox.linuxRunnerEnabled(linuxEnv), true);
  assert.equal(sandbox.realExecutionMode(linuxEnv), 'linux-container');

  let capturedPayload = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('wandbox.org/api/compile.json')) {
      capturedPayload = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          status: '0',
          program_output: 'Linux wandbox 6.8.0 x86_64 GNU/Linux\nv20.11.0\n',
          program_error: ''
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return original(url, init);
  };
  try {
    const fakeSecret = 'tc_live_' + 'z9y8x7w6v5u4t3s2r1q0p9o8n7m6';
    const res = await runApi.onRequestPost(
      ctx(
        req('/api/run', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: {
            command: 'uname -a && node -v',
            conversationId: id,
            workspace: {
              files: { 'app.js': `console.log("${fakeSecret}")` },
              active: 'app.js'
            }
          }
        }),
        linuxEnv
      )
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'linux-container');
    assert.match(body.stdout, /Linux wandbox/);
    assert.ok(capturedPayload, 'wandbox container API was not called');
    assert.equal(capturedPayload.compiler, 'bash');
    assert.ok(!JSON.stringify(capturedPayload).includes(fakeSecret), 'secret leaked into Linux container mount');
  } finally {
    globalThis.fetch = original;
  }
});

test('chat supports dynamic [id].js paths, delete_file + undo_edit restoration, custom model selection, and thinking SSE', async () => {
  const { env, cookie, id } = await setUp();
  const modelsApi = await import(`${root}/api/models.js`);
  const modelsRes = await (await modelsApi.onRequestGet(ctx(req('/api/models', { headers: { Cookie: cookie } }), env))).json();
  assert.ok(modelsRes.models.some((m) => m.id === 'claude-opus-5-5'));
  assert.ok(modelsRes.models.some((m) => m.id === 'gpt-6.1-sol'));

  const dynPath = 'functions/api/items/[id].js';
  const model = scriptedModel([
    toolCall('t0', 'think', { thought: 'We need a dynamic route file, then test deleting it.', plan: '1. write_file\n2. delete_file' }),
    toolCall('t1', 'write_file', { path: dynPath, content: 'export async function onRequest() { return new Response("ok"); }\n' }),
    { role: 'assistant', content: 'مسیر پویا ساخته شد.' }
  ]);
  let turn1;
  try {
    const res = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: { conversationId: id, message: 'فایل پویا بساز', model: 'claude-opus-5-5', thinking: true }
        }),
        env
      )
    );
    const text = await res.text();
    assert.match(text, /event: thinking/, 'thinking SSE event missing');
    const doneMatch = text.match(/event: done\ndata: ([^\n]+)/);
    turn1 = JSON.parse(doneMatch[1]);
    assert.equal(model.calls[0].model, 'claude-opus-5-5');
    assert.ok(turn1.touchedFiles.includes(dynPath));
    assert.ok(turn1.workspace.files[dynPath]);
  } finally {
    model.restore();
  }

  // Delete the dynamic file and verify `deletedFiles` is reported, then restore via `undo_edit`.
  const model2 = scriptedModel([
    toolCall('d1', 'delete_file', { path: dynPath }),
    { role: 'assistant', content: 'حذف شد.' }
  ]);
  try {
    const turn2 = await send(env, cookie, id, 'فایل پویا را حذف کن');
    const done2 = turn2.find((e) => e.name === 'done').data;
    assert.ok(done2.deletedFiles.includes(dynPath));
    assert.equal(done2.workspace.files[dynPath], undefined);
  } finally {
    model2.restore();
  }

  const model3 = scriptedModel([
    toolCall('u1', 'undo_edit', { path: dynPath }),
    { role: 'assistant', content: 'بازگردانی شد.' }
  ]);
  try {
    const turn3 = await send(env, cookie, id, 'برگردان');
    const done3 = turn3.find((e) => e.name === 'done').data;
    assert.ok(done3.workspace.files[dynPath]?.includes('onRequest'));
  } finally {
    model3.restore();
  }
});
