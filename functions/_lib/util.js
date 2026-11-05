// Small runtime helpers shared by every Pages Function.
// Runs on the Cloudflare Workers runtime: Web APIs only (no Node built-ins).

const textEncoder = new TextEncoder();

export class HttpError extends Error {
  constructor(message, status = 400, code = 'bad_request', extra = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

export function fail(message, status = 400, code = 'bad_request', extra = null) {
  throw new HttpError(message, status, code, extra);
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cf-Access-Jwt-Assertion'
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

/** Convert any thrown value into a safe JSON error response. */
export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json(
      { error: error.message, code: error.code, ...(error.extra ? { details: error.extra } : {}) },
      error.status
    );
  }
  // Never leak provider internals or stack traces to the browser.
  console.error('unhandled', error && error.name ? error.name : 'Error');
  return json(
    { error: 'خطای غیرمنتظره در سرور رخ داد. دوباره تلاش کنید.', code: 'internal' },
    500
  );
}

export async function readJson(request, maxBytes = 1_600_000) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    fail('بدنه‌ی درخواست باید JSON باشد.', 415, 'bad_content_type');
  }
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) fail('درخواست بیش از حد بزرگ است.', 413, 'too_large');
  const text = await request.text();
  if (text.length > maxBytes) fail('درخواست بیش از حد بزرگ است.', 413, 'too_large');
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('JSON نامعتبر است.', 400, 'bad_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('JSON نامعتبر است.', 400, 'bad_json');
  return parsed;
}

/**
 * Same-origin + CSRF gate. Cloudflare Access already blocks anonymous users,
 * but a page on another origin could still make a credentialed request if the
 * browser sends the Access cookie. Reject anything that is not our own origin.
 */
export function assertSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');

  if (site && site !== 'same-origin' && site !== 'none') {
    fail('درخواست از مبدأ دیگر رد شد.', 403, 'cross_origin');
  }
  if (origin && origin !== url.origin) {
    fail('درخواست cross-origin رد شد.', 403, 'cross_origin');
  }
  const method = request.method.toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  if (!origin && !isRead && site !== 'none') {
    // Browsers always send Origin on cross-origin / non-GET fetches. If it is
    // missing and this is not a scripted same-origin request, be conservative.
    const siteMissing = !site;
    if (siteMissing) fail('درخواست بدون مبدأ تأییدشده رد شد.', 403, 'cross_origin');
  }
}

/* ------------------------------------------------------------------ *
 * Crypto / base64 helpers
 * ------------------------------------------------------------------ */

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? textEncoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function b64urlDecode(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    fail('توکن ورود نامعتبر است.', 401, 'invalid_session');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function b64urlDecodeText(input) {
  return new TextDecoder().decode(b64urlDecode(input));
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function textToBase64(text) {
  return bytesToBase64(textEncoder.encode(String(text)));
}

export function base64ToText(value) {
  const binary = atob(String(value).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------ *
 * Secret handling
 * ------------------------------------------------------------------ */

// High-confidence credential shapes. These are safe to apply to code files
// because they match provider token formats, not ordinary assignments.
const HARD_SECRET_PATTERNS = [
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]']
];

// Additional heuristic for prose / chat content: `api_key = "..."`, `password: ...`
const ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|ghToken|github[_-]?token|auth[_-]?token|private[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"',;}\]]{6,})/gi;

/** Redact credentials from free text before it is stored or sent to a model. */
export function redactSecrets(value, extraSecrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 12) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  for (const [pattern, replacement] of HARD_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(ASSIGNMENT_PATTERN, '$1$2[REDACTED]');
  return text;
}

/** Redact only token-shaped values (used for stored source files). */
export function redactCode(value, extraSecrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 12) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  for (const [pattern, replacement] of HARD_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

const PRIVATE_KEY_NAMES =
  /^(apiKey|api_key|apikey|ghToken|githubToken|github_token|token|accessToken|access_token|refreshToken|refresh_token|authorization|password|passwordHash|clientSecret|client_secret|privateKey|private_key|secret|cookie|session)$/i;

/** Recursively drop credential-looking keys and redact values. */
export function stripSecrets(value, extraSecrets = [], depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return redactSecrets(value, extraSecrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => stripSecrets(v, extraSecrets, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (PRIVATE_KEY_NAMES.test(key)) continue;
      out[key] = stripSecrets(val, extraSecrets, depth + 1);
    }
    return out;
  }
  return null;
}

export function envSecrets(env) {
  return [env.MODEL_API_KEY].filter((v) => typeof v === 'string' && v.length >= 12);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function safeInt(value, fallback = 0) {
  return Number.isSafeInteger(value) ? value : fallback;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 20))}\n… [بریده شد]`;
}

/** Cheap token estimate: Latin runs ~4 chars/token, Persian ~2 chars/token. */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let ascii = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) < 128) ascii += 1;
  const nonAscii = s.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 2);
}

export function normalizeBaseUrl(raw, fallback = 'https://tooken.club/v1') {
  const value = String(raw || '').trim() || fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'https:') return fallback;
  return url.href.replace(/\/+$/, '');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
