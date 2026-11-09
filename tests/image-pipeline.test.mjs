// Image pipeline regression suite.
//
// The user's acceptance criteria, in order:
//   دریافت پرامپت ← تقویت پرامپت ← تولید تصویر ← مشاهده ← تایید
//   ← ذخیره ← دانلود ← ارسال ← مالکیت کاربر
//
// Every one of those nine stages is asserted here, at the layer where it can
// actually break: the build prompt, the chat tool wiring, the delivery route,
// the workspace writer, and the DOM markup that drives the UI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');

const harness = await import(new URL('./harness.mjs', import.meta.url).pathname);
const memory = await import(`${root}/_lib/memory.js`);
const chat = await import(`${root}/api/chat.js`);
const store = await import(`${root}/_lib/store.js`);

const { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } = harness;

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const owner = 'https://team.cloudflareaccess.com|user-1';

/**
 * Signed-in env + cookie, the way every real request arrives.
 * The Access handshake only sets a cookie the first time, so sign in once and
 * hand the same cookie to every later call — exactly like a browser does.
 */
let session = null;
async function signedIn() {
  if (session) return session;
  const keys = rsaKeys();
  fakeJwks(keys);
  const env = makeEnv();
  const auth = await import(`${root}/api/auth.js`);
  const res = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  const cookie = (res.headers.get('Set-Cookie') || '').split(';')[0];
  assert.ok(cookie, 'test bootstrap failed: no session cookie was issued');
  const stateApi = await import(`${root}/api/state/index.js`);
  const post = async (body) =>
    stateApi.onRequestPost(ctx(req('/api/state', { method: 'POST', body, headers: { Cookie: cookie } }), env));
  session = { env, cookie, post };
  return session;
}

/* ------------------------------ stage 1+7 -------------------------------- */

test('the system prompt forbids a capability excuse and points at the tool', () => {
  const prompt = memory.buildSystemPrompt({
    files: { 'src/app.js': 'const a = 1;\n' },
    activeFile: 'src/app.js'
  });

  // The exact failure the user reported.
  assert.ok(/NEVER say you cannot/i.test(prompt), 'prompt must forbid "I cannot"');
  assert.ok(/generate_image/.test(prompt), 'prompt must name the tool');
  assert.ok(/OWN/.test(prompt), 'prompt must state tool ownership');
  assert.ok(/api\/images/.test(prompt), 'prompt must show how to embed the image');

  // It has to stay small: this prompt rides on EVERY step of EVERY turn.
  assert.ok(prompt.length < 1350, `compact prompt must stay under 1350 chars, got ${prompt.length}`);
});

test('an image request is never answered with "ZERO tool calls" alone', () => {
  const prompt = memory.buildSystemPrompt({ files: {}, activeFile: '' });
  const rule1 = prompt.split('\n').find((line) => /^1\./.test(line)) || '';
  assert.ok(/UNLESS/i.test(rule1), 'rule 1 must carry an exception for image/web/file work');
});

/* -------------------------------- stage 3 -------------------------------- */

test('generate_image is wired end to end: schema, allowance, handler', async () => {
  const tool = chat.TOOLS.find((t) => t.function?.name === 'generate_image');
  assert.ok(tool, 'generate_image must be in the TOOLS schema');
  assert.ok(tool.function.description.length > 20, 'tool needs a real description');
  assert.deepEqual(tool.function.parameters.required, ['prompt']);
  assert.ok(tool.function.parameters.properties.saveTo, 'saveTo must exist so images can become project files');

  const model = await import(`${root}/_lib/model.js`);
  assert.ok(model.ALLOWED_TOOLS.has('generate_image'), 'model allowlist must include the tool');
});

test('the tool payload stays inside its token budget', () => {
  const size = JSON.stringify(chat.TOOLS).length;
  assert.ok(size < 4200, `TOOLS JSON must stay under 4200 chars, got ${size}`);
});

/* -------------------------------- stage 2 -------------------------------- */

test('POST /api/images/enhance returns a prompt without needing an image run', async () => {
  const { env, cookie } = await signedIn();
  const enhance = await import(`${root}/api/images/enhance.js`);
  const call = (body) =>
    enhance.onRequestPost(
      ctx(req('/api/images/enhance', { method: 'POST', body, headers: { Cookie: cookie } }), env)
    );

  const res = await call({ prompt: 'یک تانک' });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.original, 'یک تانک');
  assert.ok(json.prompt.length >= 'یک تانک'.length, 'enhancement may never shorten the prompt');

  const empty = await call({ prompt: '   ' });
  assert.equal(empty.status, 400, 'an empty prompt is a client error');
});

/* -------------------------------- stage 4 -------------------------------- */

test('a stored image is served for viewing AND for download', async () => {
  const { env, cookie } = await signedIn();
  const image = await import(`${root}/_lib/image.js`);
  const bytes = Buffer.from(PNG_1X1.split(',')[1], 'base64');
  const fakeAi = { ...env, AI: { run: async () => ({ image: bytes.toString('base64') }) } };

  const stored = await image.generateAndStoreImage(fakeAi, owner, {
    prompt: 'a tank',
    title: 'تانک',
    aspectRatio: '1:1',
    style: 'auto',
    conversationId: 'c-image'
  });
  assert.ok(stored?.id && stored?.url, 'generation must return an id and a url');

  const route = await import(`${root}/api/images/[id].js`);
  const get = (path) => route.onRequestGet(ctx(req(path, { headers: { Cookie: cookie } }), env, { id: stored.id }));

  const view = await get(stored.url);
  assert.equal(view.status, 200, 'viewing must work');
  assert.match(view.headers.get('Content-Type'), /^image\//);
  const delivered = new Uint8Array(await view.arrayBuffer());
  assert.equal(delivered[0], 0x89, 'the real PNG bytes must come back (not a JSON stub)');

  const download = await get(`${stored.url}?download=1`);
  assert.equal(download.status, 200, 'downloading must work');
  assert.match(download.headers.get('Content-Disposition') || '', /^attachment/);
});

/* -------------------------------- stage 6 -------------------------------- */

test('POST /api/state write-file stores a real image file and marks it active', async () => {
  const { env, cookie, post } = await signedIn();
  const created = await (await post({ action: 'create', title: 'تصویر', mode: 'developer' })).json();

  const written = await (
    await post({ action: 'write-file', id: created.id, path: 'assets/tank.png', content: PNG_1X1 })
  ).json();
  assert.equal(written.ok, true);
  assert.equal(written.path, 'assets/tank.png');
  assert.ok(written.bytes > 0);

  // Read it back the same way the editor does.
  const route = await import(`${root}/api/state/conversations/[id].js`);
  const conv = await (
    await route.onRequestGet(
      ctx(req(`/api/state/conversations/${created.id}`, { headers: { Cookie: cookie } }), env, { id: created.id })
    )
  ).json();

  assert.equal(conv.workspace.files['assets/tank.png'], PNG_1X1, 'the exact bytes must round-trip');
  assert.equal(conv.workspace.active, 'assets/tank.png', 'the saved image becomes the active file');

  // Rejections that must stay rejections.
  const noPath = await post({ action: 'write-file', id: created.id, content: PNG_1X1 });
  assert.equal(noPath.status, 400);
  const noBody = await post({ action: 'write-file', id: created.id, path: 'assets/x.png' });
  assert.equal(noBody.status, 400);
});

test('workspace saving survives the safety filter (data: URLs are legal files)', () => {
  const saved = store.safeWorkspace({ files: { 'assets/tank.png': PNG_1X1 }, active: 'assets/tank.png' }, {
    mode: 'developer'
  });
  assert.equal(saved.files['assets/tank.png'], PNG_1X1);
  assert.equal(saved.active, 'assets/tank.png');
});

/* ----------------------------- stages 5,7,8,9 ----------------------------- */

test('the UI exposes all nine pipeline stages in order', () => {
  const stages = Array.from(html.matchAll(/data-stage="([a-z]+)"/g)).map((m) => m[1]);
  const pipeline = stages.slice(0, 9);
  assert.deepEqual(
    pipeline,
    ['prompt', 'enhance', 'generate', 'view', 'approve', 'save', 'download', 'send', 'toolbox'],
    'the pipeline must render exactly these nine stages, in this order'
  );
});

test('every pipeline action the user clicks is actually defined and wired', () => {
  // Buttons the user actually clicks.
  const buttons = [
    'startImagePipeline',
    'imgPipeApprove',
    'imgPipeSave',
    'imgPipeSendToChat',
    'imgPipeRegenerate',
    'imgPipeZoom',
    'imgPipeMarkDownloaded'
  ];
  for (const fn of buttons) {
    assert.match(html, new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`), `${fn} must be defined`);
    assert.match(html, new RegExp(`onclick="${fn}\\(`), `${fn} must be reachable from a button`);
  }

  // Helpers that buttons call internally.
  const helpers = ['saveGeneratedImageToWorkspace', 'imgPipeSetStage', 'imgPipeReset', 'imgPipeGenerate'];
  for (const fn of helpers) {
    assert.match(html, new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`), `${fn} must be defined`);
    assert.match(html, new RegExp(`${fn}\\(`), `${fn} must actually be called`);
  }
});

test('approval gates saving and sending, so nothing is written by accident', () => {
  const save = html.slice(html.indexOf('async function imgPipeSave'));
  const send = html.slice(html.indexOf('async function imgPipeSendToChat'));
  assert.match(save.slice(0, 400), /if \(!imgPipe\.approved\)/, 'save must require approval');
  assert.match(send.slice(0, 400), /if \(!imgPipe\.approved\)/, 'send must require approval');
});

test('the sent image carries a reference the model can act on', () => {
  const send = html.slice(html.indexOf('async function imgPipeSendToChat'));
  const body = send.slice(0, 1400);
  assert.match(body, /!\[\$\{title\}\]\(\$\{url\}\)/, 'the message must embed the real image markdown');
  assert.match(body, /مرجع/, 'the message must ask the model to treat it as a reference');
});

test('a generated image card always offers download, project-save and zoom', () => {
  const card = html.slice(html.indexOf('function renderGeneratedImageCardHtml'));
  const slice = card.slice(0, 1200);
  assert.match(slice, /\?download=1/, 'download link');
  assert.match(slice, /save-gen-img/, 'save-into-project button');
  assert.match(slice, /zoom-gen-img/, 'zoom button');
  assert.match(slice, /copy-img-url/, 'copy-link button');
});

/* ------------------------ the reported bug, end to end -------------------- */

test('a model that REFUSES an image request still returns a real image', async () => {
  // Reproduces the exact user-reported failure: the user asks for a picture,
  // the model answers «امکان ساختن تصویر ندارم» without calling the tool.
  // The turn must not hand that refusal back — it must still deliver an image.
  const { env, cookie, post } = await signedIn();
  const created = await (await post({ action: 'create', title: 'تصویر می‌خواهم', mode: 'developer' })).json();

  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  // Workers AI binding that succeeds — the rescue path has a real engine to use.
  env.AI = { run: async () => ({ image: Buffer.from(png).toString('base64') }) };

  const original = globalThis.fetch;
  let sawImageRequest = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    if (!String(url).includes('/chat/completions')) {
      // Any image relay call is a legitimate part of the cascade.
      return original(url, init);
    }
    const body = JSON.parse(init.body || '{}');
    const wire = JSON.stringify(body);
    if (/generate_image|MANDATORY/.test(wire)) sawImageRequest = true;
    // The model refuses, calling NO tools — the original bug.
    const refusal = 'متأسفانه امکان ساختن تصویر ندارم.';
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: refusal } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    const res = await chat.onRequestPost(
      ctx(
        req('/api/chat', {
          method: 'POST',
          body: { conversationId: created.id, message: 'یک تصویر از تانک بساز' },
          headers: { Cookie: cookie }
        }),
        env
      )
    );
    assert.equal(res.status, 200);
    const text = await res.text();

    // The directive really reached the model.
    assert.ok(sawImageRequest, 'the mandatory image directive must be sent to the model');

    // A refusal alone is not an acceptable answer any more.
    const sentences = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join(' ');
    assert.ok(
      /api\/images\/[A-Za-z0-9_-]+/.test(sentences),
      'the turn must deliver a real image URL, not just the refusal'
    );
    assert.ok(
      !/^متأسفانه امکان ساختن تصویر ندارم\.$/.test(sentences.trim()),
      'a bare capability refusal must never be the final answer'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('ordinary messages never trigger an image run', async () => {
  // The rescue must be surgical: talking ABOUT a picture is not asking for one.
  const { env, cookie, post } = await signedIn();
  const created = await (await post({ action: 'create', title: 'گفتگو', mode: 'developer' })).json();

  let imageRuns = 0;
  env.AI = {
    run: async () => {
      imageRuns += 1;
      throw new Error('images must not be generated for this message');
    }
  };

  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/cdn-cgi/access/certs')) return original(url, init);
    if (!String(url).includes('/chat/completions')) throw new Error('unexpected fetch ' + url);
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'این تصویر یک تانک است.' } }] })}\n\n` +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const harmless = ['این تصویر را توضیح بده', 'عکس را از پروژه حذف کن', 'سلام، حالت چطوره؟'];
  try {
    for (const message of harmless) {
      // eslint-disable-next-line no-await-in-loop
      const res = await chat.onRequestPost(
        ctx(req('/api/chat', { method: 'POST', body: { conversationId: created.id, message }, headers: { Cookie: cookie } }), env)
      );
      assert.equal(res.status, 200);
      assert.ok(!/generated_image/.test(await res.text()), `"${message}" must not produce an image`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(imageRuns, 0, 'no image engine should ever be touched');
});

test('the toolbox offers real actions, not decoration', () => {
  const tools = Array.from(html.matchAll(/data-tool="([a-z-]+)"/g)).map((m) => m[1]);

  // Everything the user asked for after approval: use it, save it, do anything.
  const required = ['copy-link', 'copy-md', 'copy-html', 'copy-css', 'insert-file', 'open-tab', 'share', 'variant', 'reference', 'delete'];
  for (const tool of required) {
    assert.ok(tools.includes(tool), `toolbox must expose "${tool}"`);
  }
  assert.ok(tools.length >= 10, `toolbox should be rich, got ${tools.length} actions`);

  // Each tool id must be handled in the switch, otherwise the button is dead.
  const start = html.indexOf('async function imgPipeTool');
  const end = html.indexOf('async function submitDirectStudioImage', start);
  const body = html.slice(start, end);
  for (const tool of required) {
    assert.match(body, new RegExp(`case '${tool}'`), `"${tool}" must have a handler`);
  }

  // Destructive tools must confirm first.
  const del = body.slice(body.indexOf("case 'delete'"));
  assert.match(del.slice(0, 300), /confirm\(/, 'delete must ask before destroying the image');
});

test('every toolbox action requires an approved image', () => {
  const start = html.indexOf('async function imgPipeTool');
  const guard = html.slice(start, start + 500);
  assert.match(guard, /if \(!img\?\.url\)/, 'needs an image');
  assert.match(guard, /if \(!imgPipe\.approved\)/, 'needs approval');
});
