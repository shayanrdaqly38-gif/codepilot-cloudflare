// Cloudflare Access verification + a signed first-party session cookie.
//
// Trust chain:
//   1. Cloudflare Access sits in front of the whole site and injects
//      `Cf-Access-Jwt-Assertion` for every authenticated request.
//   2. We verify that RS256 JWT against the team's cached JWKS.
//   3. We then mint our own short-lived HMAC session cookie so the browser
//      never has to re-verify Access on every fetch and so the API works
//      consistently from every device on the same team account.
//
// The GitHub token stored client-side is only ever a repo credential; it is
// never accepted as proof of identity here.

import {
  b64urlDecode,
  b64urlDecodeText,
  fail,
  sha256Hex,
  toHex
} from './util.js';

const JWKS_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE = 'cp_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

let jwksCache = null;

function accessDomain(env) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || '')
    .trim()
    .replace(/^https:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) {
    fail(
      'ورود امن پیکربندی نشده است: ACCESS_TEAM_DOMAIN باید مقدار <team>.cloudflareaccess.com باشد.',
      503,
      'access_unconfigured'
    );
  }
  if (!env.ACCESS_AUD) {
    fail('ورود امن پیکربندی نشده است: ACCESS_AUD تنظیم نشده.', 503, 'access_unconfigured');
  }
  return domain;
}

function accessAllowEmails(env) {
  return String(env.ACCESS_ALLOWED_EMAILS || '')
    .split(/[,\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function sessionSecret(env) {
  const raw = String(env.SESSION_SECRET || '').trim();
  if (raw.length < 32) {
    fail(
      'SESSION_SECRET تنظیم نشده یا کوتاه است (حداقل ۳۲ کاراکتر). با دستور openssl rand -base64 32 بسازید.',
      503,
      'session_secret_missing'
    );
  }
  return raw;
}

async function loadJwks(domain, force = false) {
  const fresh = jwksCache && jwksCache.domain === domain && jwksCache.until > Date.now();
  if (fresh && !force) return jwksCache.keys;
  const response = await fetch(`https://${domain}/cdn-cgi/access/certs`, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!response.ok) fail('دریافت کلیدهای Cloudflare Access ناموفق بود.', 503, 'jwks_unavailable');
  const data = await response.json();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (!keys.length) fail('کلید Cloudflare Access در دسترس نیست.', 503, 'jwks_unavailable');
  jwksCache = { domain, keys, until: Date.now() + JWKS_TTL_MS };
  return keys;
}

async function verifyAccessToken(token, env) {
  const domain = accessDomain(env);
  if (!token || token.length > 16000) fail('ورود از طریق Cloudflare Access لازم است.', 401, 'access_required');

  const parts = String(token).split('.');
  if (parts.length !== 3) fail('توکن Access نامعتبر است.', 401, 'invalid_access_token');

  let header;
  let claims;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]));
    claims = JSON.parse(b64urlDecodeText(parts[1]));
  } catch {
    fail('توکن Access نامعتبر است.', 401, 'invalid_access_token');
  }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    fail('الگوریتم توکن Access پشتیبانی نمی‌شود.', 401, 'invalid_access_token');
  }

  let keys = await loadJwks(domain);
  let jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) {
    keys = await loadJwks(domain, true);
    jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  }
  if (!jwk) fail('کلید امضای Access پیدا نشد.', 401, 'invalid_access_token');

  let signatureOk = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    signatureOk = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) fail('امضای توکن Access معتبر نیست.', 401, 'invalid_access_token');

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const valid =
    claims.iss === `https://${domain}` &&
    audiences.includes(env.ACCESS_AUD) &&
    Number.isFinite(claims.exp) &&
    claims.exp > now &&
    (!claims.nbf || claims.nbf <= now + 30) &&
    (!claims.iat || claims.iat <= now + 120) &&
    typeof claims.sub === 'string' &&
    claims.sub.length > 0;
  if (!valid) fail('نشست Access منقضی یا نامعتبر است. دوباره وارد شوید.', 401, 'invalid_access_token');

  const email = String(claims.email || '').toLowerCase();
  const allow = accessAllowEmails(env);
  if (allow.length && !allow.includes(email)) {
    fail('این حساب اجازه‌ی دسترسی به این محیط را ندارد.', 403, 'email_not_allowed');
  }

  const identity = {
    owner: `${claims.iss}|${claims.sub}`,
    email,
    name: String(claims.name || claims.email || ''),
    exp: claims.exp,
    via: 'cloudflare-access'
  };

  // Bind the session to the Access token so a re-issued token rotates sessions.
  identity.tokenHash = (await sha256Hex(token)).slice(0, 32);
  return identity;
}

/* ------------------------------------------------------------------ *
 * HMAC session cookie
 * ------------------------------------------------------------------ */

async function hmacKey(env) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function cookieValue(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

async function signSession(payload, env) {
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const key = await hmacKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${toHex(new Uint8Array(signature))}`;
}

async function verifySession(value, env) {
  if (!value || value.length > 4096) return null;
  const [body, signature] = String(value).split('.');
  if (!body || !signature) return null;
  try {
    const key = await hmacKey(env);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const given = new Uint8Array(signature.match(/.{2}/g)?.map((h) => parseInt(h, 16)) || []);
    if (expected.length !== given.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ given[i];
    if (diff !== 0) return null;
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    );
    const payload = JSON.parse(decoded);
    if (!payload || payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.owner !== 'string' || !payload.owner) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAge, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/**
 * Resolve the caller. Prefers a valid first-party session cookie and falls
 * back to a fresh Cloudflare Access assertion (which also refreshes the cookie).
 * Returns { identity, setCookie } — setCookie is null when nothing changed.
 */
export async function authenticate(request, env) {
  const session = await verifySession(cookieValue(request, SESSION_COOKIE), env).catch(() => null);
  if (session) {
    return {
      identity: {
        owner: String(session.owner),
        email: String(session.email || ''),
        name: String(session.name || ''),
        via: 'session'
      },
      setCookie: null
    };
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    fail('برای ادامه، از طریق Cloudflare Access وارد شوید.', 401, 'access_required');
  }
  const identity = await verifyAccessToken(token, env);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    owner: identity.owner,
    email: identity.email,
    name: identity.name,
    via: identity.via,
    iat: now,
    exp: Math.min(now + SESSION_TTL_SECONDS, identity.exp || now + SESSION_TTL_SECONDS)
  };
  if (payload.exp <= now) fail('نشست Access منقضی شده است.', 401, 'access_expired');
  const cookie = await signSession(payload, env);
  return {
    identity: { owner: identity.owner, email: identity.email, name: identity.name, via: identity.via },
    setCookie: sessionCookie(cookie, payload.exp - now, request)
  };
}

export function clearSessionCookie(request) {
  return sessionCookie('', 0, request);
}

export function sessionCookieName() {
  return SESSION_COOKIE;
}
