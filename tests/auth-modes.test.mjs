// Auth modes: Cloudflare Access (default) and the single-tenant fallback.
// The fallback must work without Access but stay loud and mutually exclusive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
