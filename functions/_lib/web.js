// Live internet access & public API client for the agent.
//
// Runs on the Cloudflare Workers runtime:
//   - Follows up to MAX_REDIRECTS manually, re-validating every hop against SSRF
//     rules and stripping Authorization / API-key headers on cross-origin hops.
//   - Never forwards Cloudflare secrets, cookies, or internal metadata hosts.
//   - Never bypasses authentication or echoes caller tokens/cookies in responses.
//   - Streams response bytes with a hard ceiling and explicitly reports HTTP
//     errors, redirects, timeouts, size caps, binary payloads, and incomplete reads.
//   - Detects JS-rendered SPA shells and routes to an optional headless browser
//     adapter (`env.BROWSER` or `env.BROWSER_RENDERING_URL`) when configured,
//     or honestly reports the static-fetch limitation when unavailable.

import { clamp, envSecrets, fail, redactSecrets, truncate } from './util.js';

const MAX_REDIRECTS = 10;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_REQUEST_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'cf-connecting-ip',
  'x-forwarded-for'
]);
const SENSITIVE_OUTBOUND_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token'
]);

function mergeTimeoutSignal(timeoutMs, externalSignal) {
  if (!externalSignal) return AbortSignal.timeout(timeoutMs);
  if (externalSignal.aborted) return externalSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), externalSignal]);
  }
  return AbortSignal.timeout(timeoutMs);
}

function isCancelled(externalSignal) {
  return Boolean(externalSignal && externalSignal.aborted);
}

/**
 * Validate that `rawUrl` points to a public internet HTTP(S) endpoint and never
 * to loopback, RFC1918 private networks, cloud metadata IPs, or internal names.
 */
export function assertSafeExternalUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw || raw.length > 2048) {
    fail('آدرس اینترنتی نامعتبر است.', 400, 'bad_url');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('قالب آدرس اینترنتی نامعتبر است (باید با https:// یا http:// شروع شود).', 400, 'bad_url');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('فقط پروتکل‌های http و https مجاز هستند.', 400, 'bad_url');
  }
  if (parsed.username || parsed.password) {
    fail('ارسال نام کاربری یا رمز در آدرس مجاز نیست.', 400, 'bad_url');
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host) fail('نام میزبان خالی است.', 400, 'bad_url');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa') ||
    host === 'metadata.google.internal' ||
    host === 'sandbox.internal'
  ) {
    fail('دسترسی به میزبان‌های محلی و داخلی مسدود است.', 400, 'ssrf_blocked');
  }

  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    fail('آدرس IP عددی مبهم مسدود است.', 400, 'ssrf_blocked');
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) fail('آدرس IPv4 نامعتبر است.', 400, 'bad_url');
    const [a, b] = octets;
    const isPrivate =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
    if (isPrivate) {
      fail('دسترسی به شبکه‌های خصوصی و متادیتا مسدود است.', 400, 'ssrf_blocked');
    }
  }

  if (host.includes(':')) {
    const lower = host.toLowerCase();
    if (
      lower === '::' ||
      lower === '::1' ||
      /^fe[89ab][0-9a-f]:/.test(lower) ||
      /^fe[c-f][0-9a-f]:/.test(lower) ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff') ||
      lower.startsWith('::ffff:')
    ) {
      fail('دسترسی به آدرس IPv6 محلی/خصوصی مسدود است.', 400, 'ssrf_blocked');
    }
  }

  return parsed;
}

export function isBinaryContentType(contentType = '') {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!ct) return false;
  if (ct.startsWith('image/') && ct !== 'image/svg+xml') return true;
  if (ct.startsWith('audio/') || ct.startsWith('video/') || ct.startsWith('font/')) return true;
  return (
    ct === 'application/pdf' ||
    ct === 'application/octet-stream' ||
    ct === 'application/zip' ||
    ct === 'application/gzip' ||
    ct === 'application/wasm' ||
    ct === 'application/x-tar'
  );
}

/**
 * Stream response bytes up to `maxBytes` and return accurate completeness info.
 */
async function readBoundedBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredRaw = response.headers?.get?.('Content-Length');
  const declaredBytes = declaredRaw !== null && declaredRaw !== '' && Number.isFinite(Number(declaredRaw))
    ? Number(declaredRaw)
    : null;

  if (!response.body) {
    return {
      text: '',
      bytesRead: 0,
      declaredBytes,
      truncated: false,
      incomplete: Boolean(declaredBytes && declaredBytes > 0),
      streamError: ''
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  let streamError = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
        total = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    streamError = String(err?.message || 'stream interrupted');
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  const contentEncoding = (response.headers?.get?.('Content-Encoding') || '').toLowerCase();
  const shortRead =
    !truncated &&
    !contentEncoding &&
    declaredBytes !== null &&
    declaredBytes > 0 &&
    total < declaredBytes;

  return {
    text,
    bytesRead: total,
    declaredBytes,
    truncated,
    incomplete: Boolean(truncated || shortRead || streamError),
    streamError
  };
}

export function decodeHtmlEntities(input) {
  return String(input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d{1,7});/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
}

function extractMainOrBody(html) {
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch && mainMatch[1].replace(/<[^>]+>/g, '').trim().length >= 20) {
    return mainMatch[1];
  }
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].replace(/<[^>]+>/g, '').trim().length >= 20) {
    return articleMatch[1];
  }
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

/** Convert raw HTML into clean, high-signal readable text for the model. */
export function htmlToReadableText(html) {
  const source = String(html || '');
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);

  const focused = extractMainOrBody(source);
  let body = focused
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|template|head|nav|aside|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\`\`\`\n${inner.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n\n${'#'.repeat(Number(level))} ${inner}\n`)
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|blockquote|pre|ul|ol|table|header|main)>/gi, '\n')
    .replace(/<a\b[^>]*href=["'](https?:\/\/[^"'\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = decodeHtmlEntities(label.replace(/<[^>]+>/g, '')).trim();
      return cleanLabel ? `${cleanLabel} (${href})` : href;
    })
    .replace(/<[^>]+>/g, ' ');

  body = decodeHtmlEntities(body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const header = [];
  if (titleMatch?.[1]) header.push(`Title: ${decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ')).trim()}`);
  if (descMatch?.[1]) header.push(`Description: ${decodeHtmlEntities(descMatch[1]).trim()}`);
  return [...header, header.length ? '' : null, body].filter((v) => v !== null).join('\n');
}

/**
 * Heuristic check for empty SPA / client-side JS shells where static HTML fetch
 * cannot see the real rendered page content.
 */
export function detectJsRenderedHtml(rawHtml, extractedText = '') {
  const html = String(rawHtml || '');
  if (!html) return false;
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  if (scriptCount === 0) return false;

  const hasAppRoot =
    /<div\b[^>]*\bid=["'](?:root|app|__next|__nuxt|svelte|ember-application)["'][^>]*>\s*<\/div>/i.test(html) ||
    /\b(?:data-reactroot|ng-app|id="__NEXT_DATA__")/i.test(html);
  const hasEnableJsNoscript =
    /<noscript\b[^>]*>[\s\S]*?(?:enable\s+javascript|javascript\s+(?:is\s+)?required|requires?\s+javascript|جاوااسکریپت)[\s\S]*?<\/noscript>/i.test(
      html
    );

  // Strip Title:/Description: header lines when measuring real body text length.
  const bodyOnly = String(extractedText || '')
    .split('\n')
    .filter((line) => !line.startsWith('Title:') && !line.startsWith('Description:'))
    .join('\n')
    .trim();

  if (hasEnableJsNoscript && bodyOnly.length < 240) return true;
  if (hasAppRoot && bodyOnly.length < 160) return true;
  if (scriptCount >= 4 && html.length > 1500 && bodyOnly.length < 80) return true;
  return false;
}

export function browserRenderingConfigured(env) {
  return Boolean(
    (env?.BROWSER && typeof env.BROWSER.fetch === 'function') ||
      (typeof env?.BROWSER_RENDERING_URL === 'string' && env.BROWSER_RENDERING_URL.trim())
  );
}

/**
 * Optional headless-browser rendering adapter:
 *   1. `env.BROWSER` binding (Cloudflare Browser Rendering service binding)
 *   2. `env.BROWSER_RENDERING_URL` configured HTTPS rendering endpoint
 * Never pretends JS rendering works when neither is configured.
 */
export async function renderWithHeadlessBrowser(
  env,
  targetUrl,
  { timeoutMs = FETCH_TIMEOUT_MS, externalSignal = null, secrets = [] } = {}
) {
  if (isCancelled(externalSignal)) {
    return { ok: false, available: true, errorType: 'cancelled', error: 'Cancelled by user.' };
  }
  const safeUrl = assertSafeExternalUrl(targetUrl);

  if (env?.BROWSER && typeof env.BROWSER.fetch === 'function') {
    try {
      const res = await env.BROWSER.fetch(
        new Request('https://browser.internal/content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/html' },
          body: JSON.stringify({ url: safeUrl.href, timeoutMs }),
          signal: mergeTimeoutSignal(timeoutMs, externalSignal)
        })
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, available: true, errorType: 'browser_http_error', status: res.status, error: `Browser binding HTTP ${res.status}` };
      }
      const ct = (res.headers.get('Content-Type') || '').toLowerCase();
      const body = await readBoundedBody(res, MAX_RESPONSE_BYTES);
      let html = body.text;
      if (ct.includes('application/json')) {
        try {
          const parsed = JSON.parse(body.text);
          html = String(parsed.html || parsed.content || parsed.result || '');
        } catch {
          // keep raw
        }
      }
      return {
        ok: Boolean(html),
        available: true,
        engine: 'cloudflare-browser-binding',
        html,
        bytesRead: body.bytesRead,
        truncated: body.truncated,
        incomplete: body.incomplete
      };
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || (err?.name === 'AbortError' && !isCancelled(externalSignal));
      return {
        ok: false,
        available: true,
        errorType: isCancelled(externalSignal) ? 'cancelled' : timedOut ? 'timeout' : 'browser_error',
        error: redactSecrets(err?.message || 'browser binding failed', secrets)
      };
    }
  }

  const endpointRaw = String(env?.BROWSER_RENDERING_URL || '').trim();
  if (endpointRaw) {
    let endpoint;
    try {
      endpoint = assertSafeExternalUrl(endpointRaw);
    } catch (err) {
      return { ok: false, available: false, errorType: 'bad_browser_endpoint', error: err.message };
    }
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/html' };
    const token = String(env?.BROWSER_RENDERING_TOKEN || env?.CF_BROWSER_RENDERING_TOKEN || '').trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(endpoint.href, {
        method: 'POST',
        headers,
        redirect: 'manual',
        signal: mergeTimeoutSignal(timeoutMs, externalSignal),
        body: JSON.stringify({ url: safeUrl.href, timeoutMs })
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return {
          ok: false,
          available: true,
          errorType: 'browser_http_error',
          status: res.status,
          error: `Browser rendering endpoint returned HTTP ${res.status}`
        };
      }
      const ct = (res.headers.get('Content-Type') || '').toLowerCase();
      const body = await readBoundedBody(res, MAX_RESPONSE_BYTES);
      let html = body.text;
      if (ct.includes('application/json')) {
        try {
          const parsed = JSON.parse(body.text);
          html = String(parsed.html || parsed.content || parsed.result || '');
        } catch {
          // keep raw
        }
      }
      return {
        ok: Boolean(html),
        available: true,
        engine: 'remote-browser-rendering',
        html,
        bytesRead: body.bytesRead,
        truncated: body.truncated,
        incomplete: body.incomplete
      };
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || (err?.name === 'AbortError' && !isCancelled(externalSignal));
      return {
        ok: false,
        available: true,
        errorType: isCancelled(externalSignal) ? 'cancelled' : timedOut ? 'timeout' : 'browser_error',
        error: redactSecrets(err?.message || 'browser rendering failed', secrets)
      };
    }
  }

  return {
    ok: false,
    available: false,
    errorType: 'no_headless_browser',
    error: 'No headless browser backend (env.BROWSER or BROWSER_RENDERING_URL) is configured in this runtime.'
  };
}

function sanitizeOutboundHeaders(rawHeaders, serverSecrets) {
  const out = {
    'User-Agent': 'CodePilot-Agent/2.2 (+https://codepilot-cloudflare.pages.dev)',
    Accept: 'application/json, text/html, text/plain, application/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'fa,en-US;q=0.9,en;q=0.8'
  };
  const callerSecrets = [];
  const blockedHeaders = [];
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders).slice(0, 20)) {
      const name = String(k || '').trim();
      const lower = name.toLowerCase();
      if (!/^[a-zA-Z0-9-]+$/.test(name)) continue;
      if (BLOCKED_REQUEST_HEADERS.has(lower) || lower.startsWith('cf-')) {
        blockedHeaders.push(lower);
        continue;
      }
      const val = String(v ?? '').slice(0, 1000);
      if (serverSecrets.some((s) => s && val.includes(s))) continue;
      if (SENSITIVE_OUTBOUND_HEADERS.has(lower) && val.length >= 6) {
        callerSecrets.push(val);
        const strippedBearer = val.replace(/^bearer\s+/i, '').trim();
        if (strippedBearer.length >= 6) callerSecrets.push(strippedBearer);
      }
      out[name] = val;
    }
  }
  return { headers: out, callerSecrets, blockedHeaders };
}

function stripCrossOriginAuthHeaders(headers) {
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_OUTBOUND_HEADERS.has(key.toLowerCase())) {
      delete headers[key];
    }
  }
}

/**
 * Fetch any public web page or REST/JSON API safely.
 */
export async function fetchExternalUrl(
  env,
  {
    url,
    method = 'GET',
    headers = null,
    body = null,
    maxChars = 16_000,
    maxBytes = MAX_RESPONSE_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
    renderJs = 'auto',
    externalSignal = null
  } = {}
) {
  if (isCancelled(externalSignal)) {
    return { ok: false, errorType: 'cancelled', text: 'Cancelled by user.' };
  }
  const serverSecrets = envSecrets(env || {});
  const upperMethod = String(method || 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(upperMethod)) {
    return { ok: false, errorType: 'bad_method', text: `Error: unsupported HTTP method ${upperMethod}.` };
  }

  let requestedUrl;
  let currentUrl;
  try {
    requestedUrl = assertSafeExternalUrl(url);
    currentUrl = requestedUrl;
  } catch (error) {
    return { ok: false, errorType: error?.code || 'bad_url', text: `Blocked URL: ${error.message}` };
  }

  if (serverSecrets.some((s) => s && currentUrl.href.includes(s))) {
    return { ok: false, errorType: 'secret_blocked', text: 'Blocked: server secrets cannot be sent to external URLs.' };
  }

  if (isCancelled(externalSignal)) {
    return { ok: false, errorType: 'cancelled', text: 'Cancelled by user.' };
  }

  const effectiveTimeoutMs = clamp(Number(timeoutMs) || FETCH_TIMEOUT_MS, 500, 60_000);
  const effectiveMaxBytes = clamp(Number(maxBytes) || MAX_RESPONSE_BYTES, 1_024, MAX_RESPONSE_BYTES);
  const { headers: outboundHeaders, callerSecrets, blockedHeaders } = sanitizeOutboundHeaders(headers, serverSecrets);
  const allRedactSecrets = [...serverSecrets, ...callerSecrets];

  let requestBody;
  if (body !== undefined && body !== null && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (requestBody.length > 1_000_000) {
      return { ok: false, errorType: 'body_too_large', text: 'Error: request body too large (max 1 MB).' };
    }
    if (serverSecrets.some((s) => s && requestBody.includes(s))) {
      return { ok: false, errorType: 'secret_blocked', text: 'Blocked: server secrets cannot be sent in request body.' };
    }
    if (!Object.keys(outboundHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      outboundHeaders['Content-Type'] =
        typeof body === 'object' || requestBody.trim().startsWith('{') ? 'application/json' : 'text/plain;charset=utf-8';
    }
  }

  let response = null;
  let hops = 0;
  let activeMethod = upperMethod;
  let activeBody = requestBody;
  const redirects = [];

  while (hops <= MAX_REDIRECTS) {
    try {
      response = await fetch(currentUrl.href, {
        method: activeMethod,
        headers: outboundHeaders,
        body: activeMethod === 'GET' || activeMethod === 'HEAD' ? undefined : activeBody,
        redirect: 'manual',
        signal: mergeTimeoutSignal(effectiveTimeoutMs, externalSignal)
      });
    } catch (error) {
      if (isCancelled(externalSignal)) {
        return { ok: false, errorType: 'cancelled', redirects, text: 'Cancelled by user.' };
      }
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return {
        ok: false,
        errorType: timedOut ? 'timeout' : 'network',
        timedOut,
        redirects,
        url: currentUrl.href,
        text: timedOut
          ? `Request timed out after ${effectiveTimeoutMs}ms (${currentUrl.href}).`
          : `Network error fetching ${currentUrl.href}: ${redactSecrets(error?.message || 'unreachable', allRedactSecrets)}`
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        return {
          ok: false,
          errorType: 'redirect_no_location',
          status: response.status,
          redirects,
          url: currentUrl.href,
          text: `Redirect (${response.status}) without Location header from ${currentUrl.href}.`
        };
      }
      if (hops === MAX_REDIRECTS) {
        return {
          ok: false,
          errorType: 'too_many_redirects',
          status: response.status,
          redirects,
          url: currentUrl.href,
          text: `Too many redirects (>${MAX_REDIRECTS}) fetching ${url}.`
        };
      }
      let nextUrl;
      try {
        const resolved = new URL(location, currentUrl.href);
        nextUrl = assertSafeExternalUrl(resolved.href);
      } catch (error) {
        return {
          ok: false,
          errorType: error?.code || 'redirect_blocked',
          status: response.status,
          redirects,
          url: currentUrl.href,
          text: `Redirect blocked: ${error.message}`
        };
      }
      redirects.push({ hop: hops + 1, status: response.status, from: currentUrl.href, to: nextUrl.href });
      // Never leak Authorization / API keys across origins on redirect!
      if (nextUrl.origin !== currentUrl.origin) {
        stripCrossOriginAuthHeaders(outboundHeaders);
      }
      currentUrl = nextUrl;
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        activeMethod = 'GET';
        activeBody = undefined;
      }
      hops += 1;
      continue;
    }
    break;
  }

  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  const retryAfter = response.headers.get('Retry-After') || null;
  const httpOk = response.status >= 200 && response.status < 400;
  const authRequired = response.status === 401 || response.status === 403;
  const isBinary = isBinaryContentType(contentType);

  if (isBinary) {
    const declaredRaw = response.headers.get('Content-Length');
    const declaredBytes = declaredRaw && Number.isFinite(Number(declaredRaw)) ? Number(declaredRaw) : null;
    await response.body?.cancel().catch(() => {});
    const metaLines = [
      `HTTP ${response.status} · ${currentUrl.href}`,
      `Content-Type: ${contentType} (binary payload — not decoded as text)`,
      declaredBytes !== null ? `Content-Length: ${declaredBytes} bytes` : null,
      redirects.length ? `Redirects (${redirects.length}): ${redirects.map((r) => `${r.status} ${r.from} -> ${r.to}`).join(' ; ')}` : null
    ].filter(Boolean);
    return {
      ok: httpOk,
      status: response.status,
      httpError: !httpOk,
      authRequired,
      binary: true,
      contentType,
      url: currentUrl.href,
      source: {
        requestedUrl: requestedUrl.href,
        finalUrl: currentUrl.href,
        host: currentUrl.hostname,
        redirected: redirects.length > 0,
        redirects
      },
      declaredBytes,
      bytesRead: 0,
      truncated: false,
      incomplete: false,
      text: metaLines.join('\n')
    };
  }

  const bodyResult = activeMethod === 'HEAD'
    ? { text: '', bytesRead: 0, declaredBytes: null, truncated: false, incomplete: false, streamError: '' }
    : await readBoundedBody(response, effectiveMaxBytes);

  const limit = clamp(Number(maxChars) || 16_000, 500, 100_000);
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
  const isJson = contentType.includes('application/json') || contentType.includes('+json');

  let rawText = bodyResult.text;
  let formatted = rawText;
  let renderedWith = 'http-static';
  let jsRenderedLikely = false;
  let browserRenderingAvailable = browserRenderingConfigured(env);
  let browserNotice = '';
  let jsonParseIncomplete = false;

  if (isJson) {
    try {
      formatted = JSON.stringify(JSON.parse(rawText), null, 2);
    } catch {
      formatted = rawText;
      if (bodyResult.incomplete) jsonParseIncomplete = true;
    }
  } else if (isHtml) {
    formatted = htmlToReadableText(rawText);
    jsRenderedLikely = detectJsRenderedHtml(rawText, formatted);
    const wantBrowser =
      httpOk &&
      activeMethod === 'GET' &&
      (renderJs === true || renderJs === 'always' || (renderJs !== false && renderJs !== 'never' && jsRenderedLikely));
    if (wantBrowser) {
      const rendered = await renderWithHeadlessBrowser(env, currentUrl.href, {
        timeoutMs: effectiveTimeoutMs,
        externalSignal,
        secrets: allRedactSecrets
      });
      if (rendered.ok && rendered.html) {
        formatted = htmlToReadableText(rendered.html);
        renderedWith = rendered.engine;
        jsRenderedLikely = false;
      } else if (!rendered.available) {
        browserNotice =
          'Note: This page appears to require JavaScript rendering, and no headless browser backend (env.BROWSER or BROWSER_RENDERING_URL) is configured in this Cloudflare Workers runtime.';
      } else {
        browserNotice = `Note: Headless browser rendering attempted (${rendered.errorType || 'error'}): ${rendered.error || 'failed'}; falling back to static HTML.`;
      }
    }
  }

  const redacted = redactSecrets(formatted, allRedactSecrets);
  const charTruncated = redacted.length > limit;
  const safeBody = charTruncated ? truncate(redacted, limit) : redacted;
  const truncated = Boolean(bodyResult.truncated || charTruncated);
  const incomplete = Boolean(bodyResult.incomplete || charTruncated || jsonParseIncomplete);

  const truncationNotes = [];
  if (bodyResult.truncated) {
    truncationNotes.push(`Response body exceeded ${effectiveMaxBytes} byte limit (${bodyResult.bytesRead} bytes read${bodyResult.declaredBytes ? ` of ${bodyResult.declaredBytes}` : ''}).`);
  }
  if (bodyResult.streamError) {
    truncationNotes.push(`Incomplete stream: ${redactSecrets(bodyResult.streamError, allRedactSecrets)}.`);
  } else if (bodyResult.incomplete && !bodyResult.truncated) {
    truncationNotes.push(`Incomplete response: received ${bodyResult.bytesRead} of ${bodyResult.declaredBytes} declared bytes.`);
  }
  if (charTruncated) {
    truncationNotes.push(`Output truncated to ${limit} chars (of ${redacted.length} chars).`);
  }
  if (authRequired) {
    truncationNotes.push(`HTTP ${response.status} authentication/authorization required. Authentication is not bypassed; supply authorized credentials if permitted.`);
  }
  if (retryAfter) {
    truncationNotes.push(`Retry-After: ${retryAfter}`);
  }
  if (blockedHeaders.length) {
    truncationNotes.push(`Blocked restricted request headers (not sent): ${blockedHeaders.join(', ')}.`);
  }
  if (browserNotice) {
    truncationNotes.push(browserNotice);
  }

  const headerLines = [
    `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} · ${currentUrl.href}`,
    contentType ? `Content-Type: ${contentType}` : null,
    `Source: ${currentUrl.hostname} (${renderedWith})`,
    redirects.length
      ? `Redirects (${redirects.length}): ${redirects.map((r) => `${r.status} ${r.from} -> ${r.to}`).join(' ; ')}`
      : null,
    truncationNotes.length ? truncationNotes.join(' ') : null,
    '',
    safeBody || '(empty body)'
  ].filter((line) => line !== null);

  return {
    ok: httpOk,
    status: response.status,
    statusText: response.statusText || '',
    httpError: !httpOk,
    errorType: !httpOk ? 'http_error' : incomplete ? 'incomplete_content' : '',
    authRequired,
    retryAfter,
    url: currentUrl.href,
    contentType,
    renderedWith,
    jsRenderedLikely,
    browserRenderingAvailable,
    bytesRead: bodyResult.bytesRead,
    declaredBytes: bodyResult.declaredBytes,
    truncated,
    incomplete,
    truncatedReason: bodyResult.streamError
      ? 'stream_error'
      : bodyResult.truncated
        ? 'max_bytes'
        : bodyResult.incomplete
          ? 'incomplete_content_length'
          : charTruncated
            ? 'max_chars'
            : '',
    source: {
      requestedUrl: requestedUrl.href,
      finalUrl: currentUrl.href,
      host: currentUrl.hostname,
      redirected: redirects.length > 0,
      redirects
    },
    text: headerLines.join('\n')
  };
}

/* ------------------------------- web search ------------------------------- */

function unwrapDdgUrl(rawHref) {
  const href = decodeHtmlEntities(rawHref || '').trim();
  if (!href) return '';
  try {
    const resolved = href.startsWith('//') ? `https:${href}` : href.startsWith('/') ? `https://duckduckgo.com${href}` : href;
    const parsed = new URL(resolved);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    if (parsed.hostname.endsWith('duckduckgo.com')) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function parseDdgHtml(html) {
  const src = String(html || '');
  const items = [];
  const anchorRegex = /<a\b([^>]*\bclass=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(src))) {
    const attrs = match[1];
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const url = unwrapDdgUrl(hrefMatch[1]);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const after = src.slice(match.index + match[0].length, match.index + match[0].length + 2200);
    const snippetMatch = after.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i);
    const snippet = snippetMatch
      ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
      : '';
    if (title) items.push({ title, url, snippet, source: 'duckduckgo-html', contentType: 'text/html' });
    if (items.length >= 12) break;
  }
  return items;
}

async function runSearchProvider(name, fn) {
  try {
    const res = await fn();
    return { name, ok: true, status: res.status || 200, items: res.items || [], truncated: Boolean(res.truncated), error: '' };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      name,
      ok: false,
      status: Number(err?.status) || 0,
      timedOut,
      items: [],
      truncated: false,
      error: timedOut ? 'timeout' : String(err?.message || 'provider failed').slice(0, 140)
    };
  }
}

async function searchDuckDuckGoHtml(query, externalSignal = null, timeoutMs = 7_500) {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(endpoint, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      Accept: 'text/html',
      'Accept-Language': 'fa,en-US;q=0.9,en;q=0.8'
    },
    redirect: 'manual',
    signal: mergeTimeoutSignal(timeoutMs, externalSignal)
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const body = await readBoundedBody(res, 250_000);
  return { status: res.status, items: parseDdgHtml(body.text), truncated: body.truncated };
}

async function searchDuckDuckGoInstant(query, externalSignal = null, timeoutMs = 6_000) {
  const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'CodePilot-Agent/2.2' },
    redirect: 'manual',
    signal: mergeTimeoutSignal(timeoutMs, externalSignal)
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const out = [];
  if (data?.AbstractText && data?.AbstractURL) {
    out.push({
      title: String(data.Heading || query),
      url: String(data.AbstractURL),
      snippet: String(data.AbstractText).slice(0, 400),
      source: 'duckduckgo-instant',
      contentType: 'application/json'
    });
  }
  for (const topic of (data?.RelatedTopics || []).slice(0, 5)) {
    if (topic?.Text && topic?.FirstURL) {
      out.push({
        title: String(topic.Text).split(' - ')[0].slice(0, 120),
        url: String(topic.FirstURL),
        snippet: String(topic.Text).slice(0, 320),
        source: 'duckduckgo-instant',
        contentType: 'application/json'
      });
    }
  }
  return { status: res.status, items: out };
}

async function searchWikipedia(query, lang = 'en', externalSignal = null, timeoutMs = 6_000) {
  const host = lang === 'fa' ? 'fa.wikipedia.org' : 'en.wikipedia.org';
  const endpoint = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=4&utf8=1&format=json`;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'CodePilot-Agent/2.2 (Cloudflare Pages)' },
    redirect: 'manual',
    signal: mergeTimeoutSignal(timeoutMs, externalSignal)
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const items = (data?.query?.search || []).map((entry) => ({
    title: `${entry.title} (${lang === 'fa' ? 'ویکی‌پدیا' : 'Wikipedia'})`,
    url: `https://${host}/wiki/${encodeURIComponent(String(entry.title).replace(/ /g, '_'))}`,
    snippet: decodeHtmlEntities(String(entry.snippet || '').replace(/<[^>]+>/g, '')).trim(),
    source: `wikipedia-${lang}`,
    contentType: 'application/json'
  }));
  return { status: res.status, items };
}

async function searchHackerNews(query, externalSignal = null, timeoutMs = 6_000) {
  const endpoint = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=4`;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'CodePilot-Agent/2.2' },
    redirect: 'manual',
    signal: mergeTimeoutSignal(timeoutMs, externalSignal)
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const items = (data?.hits || [])
    .filter((hit) => hit?.title && (hit?.url || hit?.objectID))
    .map((hit) => ({
      title: String(hit.title),
      url: String(hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`),
      snippet: [
        hit.created_at ? `Date: ${String(hit.created_at).slice(0, 10)}` : '',
        hit.points ? `${hit.points} pts` : '',
        hit.story_text ? decodeHtmlEntities(String(hit.story_text).replace(/<[^>]+>/g, '')).slice(0, 220) : ''
      ]
        .filter(Boolean)
        .join(' · '),
      source: 'hackernews',
      contentType: 'application/json'
    }));
  return { status: res.status, items };
}

/**
 * Federated live internet search across organic web, Wikipedia (FA/EN),
 * DuckDuckGo Instant Answers, and Hacker News Algolia, with explicit per-source
 * attribution and failure/timeout disclosure.
 */
export async function searchWeb(env, { query, limit = 8, timeoutMs = 12_000, externalSignal = null } = {}) {
  if (isCancelled(externalSignal)) {
    return { ok: false, results: [], sources: [], text: 'Cancelled by user.' };
  }
  const q = String(query || '').trim();
  if (!q) return { ok: false, results: [], sources: [], text: 'Error: search query is empty.' };
  if (q.length > 400) return { ok: false, results: [], sources: [], text: 'Error: search query is too long.' };

  const secrets = envSecrets(env || {});
  if (secrets.some((s) => s && q.includes(s))) {
    return { ok: false, results: [], sources: [], text: 'Blocked: query contains a server secret.' };
  }

  if (isCancelled(externalSignal)) {
    return { ok: false, results: [], sources: [], text: 'Cancelled by user.' };
  }

  const capped = clamp(Number(limit) || 8, 1, 15);
  const perSourceTimeout = clamp(Number(timeoutMs) || 7_500, 1_000, 15_000);
  const hasPersian = /[\u0600-\u06FF]/.test(q);

  const tasks = [
    runSearchProvider('duckduckgo-html', () => searchDuckDuckGoHtml(q, externalSignal, perSourceTimeout)),
    runSearchProvider('duckduckgo-instant', () => searchDuckDuckGoInstant(q, externalSignal, perSourceTimeout)),
    ...(hasPersian
      ? [
          runSearchProvider('wikipedia-fa', () => searchWikipedia(q, 'fa', externalSignal, perSourceTimeout)),
          runSearchProvider('wikipedia-en', () => searchWikipedia(q, 'en', externalSignal, perSourceTimeout))
        ]
      : [runSearchProvider('wikipedia-en', () => searchWikipedia(q, 'en', externalSignal, perSourceTimeout))]),
    runSearchProvider('hackernews', () => searchHackerNews(q, externalSignal, perSourceTimeout))
  ];

  const outcomes = await Promise.all(tasks);
  const merged = [];
  const seen = new Set();
  const sources = [];
  const sourceErrors = [];

  for (const outcome of outcomes) {
    sources.push({
      name: outcome.name,
      ok: outcome.ok,
      status: outcome.status,
      count: outcome.items.length,
      timedOut: Boolean(outcome.timedOut),
      truncated: Boolean(outcome.truncated),
      error: outcome.error ? redactSecrets(outcome.error, secrets) : ''
    });
    if (!outcome.ok) {
      sourceErrors.push(`${outcome.name}: ${redactSecrets(outcome.error || `HTTP ${outcome.status}`, secrets)}`);
      continue;
    }
    for (const item of outcome.items) {
      if (!item?.url || !item?.title) continue;
      const key = item.url.replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      try {
        assertSafeExternalUrl(item.url);
      } catch {
        continue;
      }
      seen.add(key);
      merged.push({
        title: redactSecrets(item.title, secrets).slice(0, 200),
        url: item.url,
        snippet: redactSecrets(item.snippet || '', secrets).slice(0, 420),
        source: item.source,
        contentType: item.contentType || 'text/html'
      });
      if (merged.length >= capped) break;
    }
  }

  const allFailed = sources.length > 0 && sources.every((s) => !s.ok);
  const partial = sourceErrors.length > 0 && !allFailed;

  if (allFailed) {
    return {
      ok: false,
      partial: false,
      results: [],
      sources,
      sourceErrors,
      text: `Web search failed across all sources for "${q}". Errors: ${sourceErrors.join(' ; ')}`
    };
  }

  if (!merged.length) {
    return {
      ok: true,
      partial,
      results: [],
      sources,
      sourceErrors,
      text: [
        `No search hits returned for "${q}". Try broader English/Persian keywords or call fetch_url directly on a known URL or API.`,
        sourceErrors.length ? `Partial search warning — some sources failed: ${sourceErrors.join(' ; ')}` : null
      ]
        .filter(Boolean)
        .join('\n')
    };
  }

  const lines = merged.map(
    (item, idx) =>
      `${idx + 1}. ${item.title} [source: ${item.source}]\n   URL: ${item.url}${item.snippet ? `\n   ${item.snippet}` : ''}`
  );
  return {
    ok: true,
    partial,
    results: merged,
    sources,
    sourceErrors,
    text: [
      `Live search results for "${q}" (${merged.length} hits${partial ? ', partial — some sources failed' : ''}):`,
      sourceErrors.length ? `Source warnings: ${sourceErrors.join(' ; ')}` : null,
      '',
      ...lines,
      '',
      'Tip: Call fetch_url on any URL above to read its full content or query a JSON API directly.'
    ]
      .filter((l) => l !== null)
      .join('\n')
  };
}
