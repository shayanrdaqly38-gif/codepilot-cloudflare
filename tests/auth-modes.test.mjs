// Auth modes: Cloudflare Access (default) and the single-tenant fallback.
// The fallback must work without Access but stay loud and mutually exclusive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accessToken, fakeJwks, makeEnv, req, ctx, rsaKeys } from './harness.mjs';

const root = new URL('../functions/', import.meta.url).pathname.replace(/\/$/, '');
const auth = await import(`${root}/api/auth.js`);
const config = await import(`${root}/api/config.js`);
const stateApi = await import(`${root}/api/state/index.js`);

const keys = rsaKeys();
fakeJwks(keys);

function envWith(overrides) {
  const env = makeEnv(keys);
  delete env.ACCESS_TEAM_DOMAIN;
  delete env.ACCESS_AUD;
  return Object.assign(env, overrides);
}

test('without Access and without DEV_ACCESS_EMAIL: 401 + clear code', async () => {
  const env = envWith({});
  const res = await auth.onRequestGet(ctx(req('/api/auth'), env));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'access_required');
});

test('DEV_ACCESS_EMAIL unlocks a single-tenant session and warns loudly', async () => {
  const env = envWith({ DEV_ACCESS_EMAIL: 'owner@example.com' });
  const res = await auth.onRequestGet(ctx(req('/api/auth'), env));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.signedIn, true);
  assert.equal(body.auth, 'dev-fallback');
  assert.equal(body.user.email, 'owner@example.com');
  assert.match(body.warning, /بدون ورود واقعی/);

  const cookie = res.headers.get('Set-Cookie').split(';')[0];
  const state = await (await stateApi.onRequestGet(ctx(req('/api/state', { headers: { Cookie: cookie } }), env))).json();
  assert.equal(state.ok, true);

  const cfg = await (await config.onRequestGet(ctx(req('/api/config', { headers: { Cookie: cookie } }), env))).json();
  assert.equal(cfg.auth, 'dev-fallback');
  assert.equal(cfg.singleTenant, true);
  assert.equal(cfg.features.realLogin, false);
});

test('the fallback is a fixed identity, so no other account can appear', async () => {
  const env = envWith({ DEV_ACCESS_EMAIL: 'owner@example.com' });
  const first = await auth.onRequestGet(ctx(req('/api/auth'), env));
  const second = await auth.onRequestGet(ctx(req('/api/auth'), env));
  assert.equal((await first.json()).user.email, 'owner@example.com');
  assert.equal((await second.json()).user.email, 'owner@example.com');
  // A forged/foreign Access token must fail in this mode: it cannot silently
  // upgrade the caller to a different identity.
  const forged = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  assert.equal(forged.status, 503);
  const body = await forged.json();
  assert.ok(['access_unconfigured', 'auth_conflict'].includes(body.code), body.code);
});

test('half-configured Access (domain set) is an explicit conflict, not a silent fallback', async () => {
  const env = envWith({ DEV_ACCESS_EMAIL: 'owner@example.com', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' });
  const res = await auth.onRequestGet(ctx(req('/api/auth'), env));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'auth_conflict');
});

test('with Access configured, the fallback is never used', async () => {
  const env = makeEnv(keys);
  env.DEV_ACCESS_EMAIL = 'owner@example.com';
  const res = await auth.onRequestGet(ctx(req('/api/auth'), env));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'auth_conflict');

  // Removing the fallback restores normal Access auth.
  delete env.DEV_ACCESS_EMAIL;
  const ok = await auth.onRequestGet(
    ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.auth, 'cloudflare-access');
  assert.equal(body.warning, null);
});

test('health endpoint reports exactly which setting is missing', async () => {
  const health = await import(`${root}/api/health.js`);
  const { makeD1 } = await import('./harness.mjs');

  // 1. Nothing configured: not ok, and both Access vars are named.
  let res = await health.onRequestGet({
    request: new Request('https://x/api/health'),
    env: { DB: makeD1(), SESSION_SECRET: 'x'.repeat(40), MODEL_API_KEY: 'k' }
  });
  let body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.authMode, 'unconfigured');
  assert.deepEqual(body.missing, ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']);

  // 2. A domain pasted as a URL with a trailing slash must be normalized, not rejected.
  res = await health.onRequestGet({
    request: new Request('https://x/api/health'),
    env: {
      DB: makeD1(),
      ACCESS_TEAM_DOMAIN: 'https://myteam.cloudflareaccess.com/',
      ACCESS_AUD: 'aud',
      SESSION_SECRET: 'x'.repeat(40),
      MODEL_API_KEY: 'k'
    }
  });
  body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.authMode, 'cloudflare-access');
  assert.equal(body.checks.ACCESS_TEAM_DOMAIN.ok, true);

  // 3. Single-tenant mode is a valid deployment, but the warning is present.
  res = await health.onRequestGet({
    request: new Request('https://x/api/health'),
    env: { DB: makeD1(), DEV_ACCESS_EMAIL: 'me@example.com', SESSION_SECRET: 'x'.repeat(40), MODEL_API_KEY: 'k' }
  });
  body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.authMode, 'dev-fallback');
  assert.match(body.modeWarning, /تک‌کاربره/);

  // 4. A short session secret is a failure with a precise hint.
  res = await health.onRequestGet({
    request: new Request('https://x/api/health'),
    env: {
      DB: makeD1(),
      ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com',
      ACCESS_AUD: 'aud',
      SESSION_SECRET: 'short',
      MODEL_API_KEY: 'k'
    }
  });
  body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.checks.SESSION_SECRET.ok, false);
  assert.match(body.checks.SESSION_SECRET.hint, /۳۲|32/);
});

test('the signed-out screen can explain itself instead of dead-ending', async () => {
  // A user who cannot sign in must be able to find out *why* without shell access.
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /runDiagnostics/);
  assert.match(html, /health: '\/api\/health'/);
  assert.match(html, /عیب‌یابی تنظیمات/);
  // The banner must not promise real login when the server says it is single-tenant.
  assert.match(html, /حالت تک‌کاربره/);
});

test('no fetch in functions/ uses a redirect mode the Workers runtime rejects', async () => {
  // Regression guard: `redirect: 'error'` is not implemented at the edge. It
  // throws before the request is sent, so the bug shows up as a generic 500 —
  // exactly how both the model call and the Access JWKS fetch were broken.
  const { readdir } = await import('node:fs/promises');
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  await walk(new URL('../functions/', import.meta.url).pathname);
  assert.ok(files.length > 5, 'expected to scan the function sources');

  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // Ignore prose in comments: only executable code should be judged.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    if (/redirect:\s*['"]error['"]/.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('an unreachable Access certs endpoint is a clear 503, not a 500', async () => {
  // The JWKS fetch is the first thing a real Access login does. If the network
  // or DNS fails there, the user must see "temporarily unavailable", not an
  // opaque internal error.
  const env = makeEnv(keys);
  env.ACCESS_TEAM_DOMAIN = 'nonexistent-team.cloudflareaccess.com';
  env.ACCESS_AUD = 'aud';
  delete env.DEV_ACCESS_EMAIL;

  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  try {
    const res = await auth.onRequestGet(
      ctx(req('/api/auth', { headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) } }), env)
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'jwks_unreachable');
    assert.match(body.error, /Access|کلید/);
  } finally {
    globalThis.fetch = original;
  }
});

test('health?probe=1 reports whether the model itself works', async () => {
  const health = await import(`${root}/api/health.js`);
  const { makeD1 } = await import('./harness.mjs');
  const env = {
    DB: makeD1(),
    ACCESS_TEAM_DOMAIN: 'myteam.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    SESSION_SECRET: 'x'.repeat(40),
    MODEL_API_KEY: 'sk-test-1234567890',
    MODEL_NAME: 'test-model'
  };
  const original = globalThis.fetch;

  // 1. Anonymous: the probe refuses, and must not call the provider.
  // Only the model endpoint is intercepted; the JWKS mock must keep working.
  let called = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/chat/completions')) {
      called += 1;
      return new Response('nope', { status: 500 });
    }
    return original(input);
  };
  let res = await health.onRequestGet({ request: new Request('https://x/api/health?probe=1'), env });
  let body = await res.json();
  assert.equal(body.probe.ok, false);
  assert.match(body.probe.error, /وارد/);
  assert.equal(called, 0, 'an anonymous probe must not spend the provider quota');

  // 2. Signed in but the provider rejects the key: the probe explains it.
  // Reuse the module-level key pair: the JWKS cache is keyed by team domain, so
  // a fresh key set for the same domain would not be picked up.
  const signedEnv = { ...makeEnv(keys), DB: makeD1() };
  delete signedEnv.DEV_ACCESS_EMAIL;
  globalThis.fetch = async (input) =>
    String(input).includes('/chat/completions') ? new Response('nope', { status: 401 }) : original(input);
  res = await health.onRequestGet({
    request: new Request('https://x/api/health?probe=1', {
      headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) }
    }),
    env: signedEnv
  });
  body = await res.json();
  assert.equal(body.probe.ok, false);
  assert.equal(body.probe.code, 'model_auth');
  assert.match(body.probe.endpoint, /\/chat\/completions$/);

  // 3. Working provider: the probe passes and reports latency.
  globalThis.fetch = async (input) =>
    String(input).includes('/chat/completions')
      ? new Response(
          JSON.stringify({ model: 'test-model', choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      : original(input);
  res = await health.onRequestGet({
    request: new Request('https://x/api/health?probe=1', {
      headers: { 'Cf-Access-Jwt-Assertion': accessToken(keys) }
    }),
    env: signedEnv
  });
  body = await res.json();
  assert.equal(body.probe.ok, true, JSON.stringify(body.probe));
  assert.equal(body.probe.model, 'test-model');
  assert.equal(typeof body.probe.latencyMs, 'number');

  globalThis.fetch = original;
});

test('health.ok is true for a working single-tenant deployment', async () => {
  const health = await import(`${root}/api/health.js`);
  const { makeD1 } = await import('./harness.mjs');
  const res = await health.onRequestGet({
    request: new Request('https://x/api/health'),
    env: { DB: makeD1(), DEV_ACCESS_EMAIL: 'me@example.com', SESSION_SECRET: 'x'.repeat(40), MODEL_API_KEY: 'k' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, JSON.stringify(body.missing));
  assert.match(body.modeWarning, /تک‌کاربره/);
});

test('health.ok is false when D1 is missing (nothing can be saved)', async () => {
  const health = await import(`${root}/api/health.js`);
  const res = await health.onRequestGet({
    request: new Request('https://x/api/health'),
    env: { DEV_ACCESS_EMAIL: 'me@example.com', SESSION_SECRET: 'x'.repeat(40), MODEL_API_KEY: 'k' }
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.missing, ['DB']);
  assert.match(body.checks.DB.hint, /DB/);
});

test('the UI stops the composer when storage is unreachable', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /function showStorageFailure/);
  assert.match(html, /db_missing/);
  // It must not fall through to "ready" after a storage failure.
  assert.match(html, /showStorageFailure\(error\);\s*return;/);
});
