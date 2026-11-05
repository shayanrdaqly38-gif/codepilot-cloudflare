// Local test harness: real SQLite (node:sqlite) behind a D1-compatible shim,
// plus a fake Cloudflare Access JWKS so the real auth code path runs.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...binds) { return new Stmt(this.sql, binds); }
    _run() {
      const prepared = db.prepare(this.sql);
      const isSelect = /^\s*(select|pragma|with)/i.test(this.sql);
      if (isSelect) {
        const results = prepared.all(...this.binds);
        return { results, meta: { changes: 0, rows_read: results.length } };
      }
      const info = prepared.run(...this.binds);
      return { results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this._run(); }
    async all() { return this._run(); }
    async first() { return this._run().results[0] ?? null; }
  }

  return {
    prepare: (sql) => new Stmt(sql),
    async batch(statements) { return statements.map((s) => s._run()); },
    _db: db
  };
}

export function rsaKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';
  return {
    kid,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
    sign(payload) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
      return `${header}.${body}.${sig}`;
    }
  };
}

export function accessToken(keys, { sub = 'user-1', email = 'dev@example.com', aud = 'aud-123', domain = 'team.cloudflareaccess.com', expOffset = 600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return keys.sign({ sub, email, aud: [aud], iss: `https://${domain}`, iat: now, exp: now + expOffset, type: 'app' });
}

export function fakeJwks(keys) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [keys.jwk] }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
}

export function makeEnv(keys, overrides = {}) {
  return {
    DB: makeD1(),
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-123',
    SESSION_SECRET: 'x'.repeat(48),
    MODEL_API_KEY: 'sk-test-key-0123456789abcdefghij',
    ...overrides
  };
}

export function req(url, { method = 'GET', body, headers = {} } = {}) {
  return new Request(`https://app.example.com${url}`, {
    method,
    headers: {
      Origin: 'https://app.example.com',
      'Sec-Fetch-Site': 'same-origin',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

export function ctx(request, env, params = {}) {
  return { request, env, params, waitUntil() {}, next: async () => new Response('asset') };
}
