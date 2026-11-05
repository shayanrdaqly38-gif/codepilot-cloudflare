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
