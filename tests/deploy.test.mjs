// Deploy-safety tests.
//
// A failed Cloudflare Pages deploy is silent in the worst possible way: the
// dashboard shows a red mark, but production keeps serving the *previous*
// successful build. That is exactly how a site can show the same error message
// for hours no matter what you push.
//
// The two ways to break a Pages deploy from this repo are configuration, not
// code: a placeholder D1 id, and a bad TOML/route layout. Both are asserted
// here so a mistake is caught before it reaches Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const repo = new URL('../', import.meta.url).pathname;

test('wrangler.toml has no placeholder values that break `pages deploy`', async () => {
  const toml = await readFile(`${repo}wrangler.toml`, 'utf8');

  // An active (uncommented) database_id placeholder makes the deploy fail.
  const active = toml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(
    !/database_id\s*=\s*"REPLACE/i.test(active),
    'an active database_id placeholder breaks the Pages deploy — bind D1 in the dashboard instead'
  );
  assert.ok(!/REPLACE_WITH/i.test(active), 'active REPLACE_WITH placeholder found in wrangler.toml');

  // The output directory must stay the repo root: Pages serves index.html and
  // bundles functions/ from here.
  assert.match(active, /^\s*pages_build_output_dir\s*=\s*"\."/m);
  assert.match(active, /^\s*name\s*=\s*"codepilot-cloudflare"/m);

  // Any D1 block that IS present must be complete, never half-filled.
  if (/\[\[d1_databases\]\]/.test(active)) {
    assert.match(active, /binding\s*=\s*"DB"/);
    assert.match(active, /database_id\s*=\s*"[0-9a-f-]{36}"/i);
  }
});

test('no secrets are committed to configuration files', async () => {
  for (const file of ['wrangler.toml', 'package.json', '.dev.vars.example']) {
    const text = await readFile(`${repo}${file}`, 'utf8').catch(() => '');
    assert.ok(
      !/sk-[A-Za-z0-9_-]{20,}/.test(text),
      `${file} contains what looks like a live API key`
    );
    assert.ok(
      !/MODEL_API_KEY\s*=\s*"[^"]{8,}"/.test(text),
      `${file} assigns a non-empty MODEL_API_KEY — secrets belong in Cloudflare, not in git`
    );
  }
});

test('every route module exports an onRequest handler', async () => {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  await walk(`${repo}functions/api`);

  assert.ok(files.length >= 9, `expected the api surface, found ${files.length} files`);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.match(
      source,
      /export (async function onRequest|const onRequest|function onRequest)/,
      `${file.replace(repo, '')} has no exported onRequest handler, so its route would 404`
    );
  }
});

test('package.json build entry point matches what Cloudflare runs', async () => {
  const pkg = JSON.parse(await readFile(`${repo}package.json`, 'utf8'));
  const scripts = pkg.scripts || {};
  // Pages runs `npm run build` when a build command is configured. With no
  // bundler, the repo must either omit it or make it a no-op — never a script
  // that does not exist, and never one that deletes the output directory.
  if ('build' in scripts) {
    assert.doesNotMatch(scripts.build, /\brm\s+-rf\b/, 'the build script must not delete the output directory');
  }
  // A Pages project without a build command still needs the static entry point.
  const index = await readFile(`${repo}index.html`, 'utf8');
  assert.match(index, /<html/i);
});

test('the shipped code can never emit the old hard-coded Access error', async () => {
  // "Access is not configured." was milestone-1 code that hard-required a
  // Cloudflare Access setup and dead-ended every user. The current code must
  // answer with a Persian, actionable error (or fall back to single-tenant),
  // never that sentence.
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  await walk(`${repo}functions`);

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // Comments may explain the old bug; only executable strings matter.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.ok(
      !code.includes('Access is not configured'),
      `${file.replace(repo, '')} still emits the milestone-1 dead-end message`
    );
  }

  // The replacement must exist and be actionable.
  const auth = await readFile(`${repo}functions/_lib/auth.js`, 'utf8');
  assert.match(auth, /access_required/);
  assert.match(auth, /DEV_ACCESS_EMAIL|devFallback/);
});

test('check-deploy.sh distinguishes a live build from a stale one', async () => {
  // The script is the user's only way to tell "my code is wrong" apart from
  // "Cloudflare never deployed it" without dashboard access.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const script = `${repo}scripts/check-deploy.sh`;

  const http = await import('node:http');
  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ ok: true, authMode: 'dev-fallback', missing: [] }));
    }
    response.writeHead(404);
    response.end('Access is not configured.');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const live = await run('bash', [script, `http://127.0.0.1:${port}`]);
    assert.equal(live.code ?? 0, 0);
    assert.match(live.stdout, /new code is live/);
  } finally {
    server.close();
  }

  // A server without the health endpoint must be reported as stale, not as
  // "unexpected response" — that was the exact situation the user was in.
  const stale = http.createServer((request, response) => {
    response.writeHead(404);
    response.end('Access is not configured.');
  });
  await new Promise((resolve) => stale.listen(0, '127.0.0.1', resolve));
  const stalePort = stale.address().port;
  try {
    await assert.rejects(
      () => run('bash', [script, `http://127.0.0.1:${stalePort}`]),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stdout, /STALE BUILD/);
        return true;
      }
    );
  } finally {
    stale.close();
  }
});

test('wrangler.toml declares no [vars], so the dashboard stays editable', async () => {
  // Cloudflare locks any variable name declared in [vars]: the dashboard then
  // rejects edits for it and only allows Secrets. That turned "change the model
  // name" into a code change plus a redeploy, and left non-technical users stuck
  // with a row they could see but not edit.
  const toml = await readFile(`${repo}wrangler.toml`, 'utf8');
  const active = toml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  assert.ok(!/^\s*\[vars\]/m.test(active), 'wrangler.toml must not declare [vars]');

  // Every optional setting must still have a safe default in code, otherwise
  // removing [vars] would break a fresh deploy.
  const model = await readFile(`${repo}functions/_lib/model.js`, 'utf8');
  assert.match(model, /MODEL_NAME\s*\|\|\s*'/, 'MODEL_NAME needs a code default');
  assert.match(model, /MODEL_BASE_URL\s*\|\|\s*'https:\/\/tooken\.club\/v1'/, 'base URL needs a default');

  const auth = await readFile(`${repo}functions/_lib/auth.js`, 'utf8');
  assert.match(auth, /DEV_ACCESS_EMAIL\s*\|\|\s*''/, 'DEV_ACCESS_EMAIL needs a default');
  assert.match(auth, /ACCESS_ALLOWED_EMAILS\s*\|\|\s*''/, 'ACCESS_ALLOWED_EMAILS needs a default');

  const memory = await readFile(`${repo}functions/_lib/memory.js`, 'utf8');
  assert.match(memory, /CONTEXT_BUDGET_TOKENS\)\s*\|\|\s*/, 'budget needs a default');
});

test('the default model exists in the provider catalog', async () => {
  // tooken.club does not serve gpt-4o-mini. A fresh deployment with everything
  // else configured correctly used to fail with model_not_found purely because
  // of the default, so the default must be a model the provider actually lists.
  const source = await readFile(new URL('../functions/_lib/model.js', import.meta.url), 'utf8');
  const match = source.match(/env\.MODEL_NAME \|\| '([^']+)'/);
  assert.ok(match, 'model.js must declare a MODEL_NAME default');
  const fallback = match[1];

  assert.notEqual(fallback, 'gpt-4o-mini', 'gpt-4o-mini is not in the provider catalog');

  const catalog = [
    'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-terra',
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1',
    'claude-opus-4-5', 'deepseek-v4.1-flash-1017', 'deepseek-v4-pro', 'kimi-k3.1-pro',
    'glm-5.3-flash', 'glm-5.3', 'gemini-3-8-flash', 'gemini-4-argon', 'grok-4.7',
    'gpt-image-2.5-sunburst'
  ];
  assert.ok(catalog.includes(fallback), `default model "${fallback}" is not in the catalog`);
});
