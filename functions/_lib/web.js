// Live internet access & public API client for the agent.
//
// Runs on the Cloudflare Workers runtime:
//   - Never uses `redirect: 'error'` (unsupported on Workers); follows up to 4
//     redirects manually and re-validates every hop against SSRF rules.
//   - Never forwards Cloudflare secrets, cookies, or internal metadata hosts.
//   - Streams response bytes with a hard ceiling so a huge file cannot exhaust
//     isolate memory.
//   - Accepts an optional `externalSignal` (user stop / turn abort) on every
//     outbound call and cancels immediately when it fires, so stopping a turn
//     mid-tool never waits for a network timeout.

import { clamp, envSecrets, fail, redactSecrets, truncate } from './util.js';

const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 400_000;
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

/**
 * Combine an optional external abort signal (e.g. a user-initiated stop that
 * aborts the whole agent turn) with a hard per-request timeout. When the
 * external signal is already aborted, it is returned as-is so callers can
 * short-circuit before any network I/O. Falls back to the plain timeout on
 * runtimes without AbortSignal.any.
 */
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

  // Pure integer or hex IP obfuscation (e.g. http://2130706433 or http://0x7f000001)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    fail('آدرس IP عددی مبهم مسدود است.', 400, 'ssrf_blocked');
  }

  // IPv4 literal check
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

  // IPv6 literal check
  if (host.includes(':')) {
    const lower = host.toLowerCase();
    if (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('::ffff:')
    ) {
      fail('دسترسی به آدرس IPv6 محلی/خصوصی مسدود است.', 400, 'ssrf_blocked');
    }
  }

  return parsed;
}

async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
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
  return truncated ? `${text}\n… [پاسخ در مرز ${maxBytes} بایت بریده شد]` : text;
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

/** Convert raw HTML into clean, high-signal readable text for the model. */
export function htmlToReadableText(html) {
  const source = String(html || '');
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    source.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);

  let body = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
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

function sanitizeOutboundHeaders(rawHeaders, secrets) {
  const out = {
    'User-Agent': 'CodePilot-Agent/2.2 (+https://codepilot-cloudflare.pages.dev)',
    Accept: 'application/json, text/html, text/plain, application/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'fa,en-US;q=0.9,en;q=0.8'
  };
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders).slice(0, 20)) {
      const name = String(k || '').trim();
      const lower = name.toLowerCase();
      if (!/^[a-zA-Z0-9-]+$/.test(name)) continue;
      if (BLOCKED_REQUEST_HEADERS.has(lower) || lower.startsWith('cf-')) continue;
      const val = String(v ?? '').slice(0, 1000);
      if (secrets.some((s) => s && val.includes(s))) continue;
      out[name] = val;
    }
  }
  return out;
}

/**
 * Fetch any public web page or REST/JSON API safely.
 */
export async function fetchExternalUrl(
  env,
  { url, method = 'GET', headers = null, body = null, maxChars = 16_000, externalSignal = null } = {}
) {
  const secrets = envSecrets(env || {});
  const upperMethod = String(method || 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(upperMethod)) {
    return { ok: false, text: `Error: unsupported HTTP method ${upperMethod}.` };
  }

  let currentUrl;
  try {
    currentUrl = assertSafeExternalUrl(url);
  } catch (error) {
    return { ok: false, text: `Blocked URL: ${error.message}` };
  }

  if (secrets.some((s) => s && currentUrl.href.includes(s))) {
    return { ok: false, text: 'Blocked: server secrets cannot be sent to external URLs.' };
  }

  if (isCancelled(externalSignal)) {
    return { ok: false, text: 'Cancelled by user.' };
  }

  const outboundHeaders = sanitizeOutboundHeaders(headers, secrets);
  let requestBody;
  if (body !== undefined && body !== null && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (requestBody.length > 100_000) {
      return { ok: false, text: 'Error: request body too large (max 100 KB).' };
    }
    if (secrets.some((s) => s && requestBody.includes(s))) {
      return { ok: false, text: 'Blocked: server secrets cannot be sent in request body.' };
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

  while (hops <= MAX_REDIRECTS) {
    try {
      response = await fetch(currentUrl.href, {
        method: activeMethod,
        headers: outboundHeaders,
        body: activeMethod === 'GET' || activeMethod === 'HEAD' ? undefined : activeBody,
        redirect: 'manual',
        signal: mergeTimeoutSignal(FETCH_TIMEOUT_MS, externalSignal)
      });
    } catch (error) {
      return {
        ok: false,
        text:
          error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? `Request timed out after ${FETCH_TIMEOUT_MS}ms (${currentUrl.href}).`
            : `Network error fetching ${currentUrl.href}: ${error?.message || 'unreachable'}`
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        return { ok: false, text: `Redirect (${response.status}) without Location header from ${currentUrl.href}.` };
      }
      if (hops === MAX_REDIRECTS) {
        return { ok: false, text: `Too many redirects (>${MAX_REDIRECTS}) fetching ${url}.` };
      }
      try {
        const resolved = new URL(location, currentUrl.href);
        currentUrl = assertSafeExternalUrl(resolved.href);
      } catch (error) {
        return { ok: false, text: `Redirect blocked: ${error.message}` };
      }
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
  const rawText = activeMethod === 'HEAD' ? '' : await readBoundedText(response);
  const limit = clamp(Number(maxChars) || 16_000, 500, 40_000);

  let formatted = rawText;
  if (contentType.includes('application/json')) {
    try {
      formatted = JSON.stringify(JSON.parse(rawText), null, 2);
    } catch {
      formatted = rawText;
    }
  } else if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    formatted = htmlToReadableText(rawText);
  }

  const safeBody = truncate(redactSecrets(formatted, secrets), limit);
  const ok = response.status >= 200 && response.status < 400;
  return {
    ok,
    status: response.status,
    url: currentUrl.href,
    text: [
      `HTTP ${response.status} · ${currentUrl.href}`,
      contentType ? `Content-Type: ${contentType}` : null,
      '',
      safeBody || '(empty body)'
    ]
      .filter((line) => line !== null)
      .join('\n')
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
    if (title) items.push({ title, url, snippet, source: 'web' });
    if (items.length >= 12) break;
  }
  return items;
}

async function searchDuckDuckGoHtml(query, externalSignal = null) {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(endpoint, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
      Accept: 'text/html',
      'Accept-Language': 'fa,en-US;q=0.9,en;q=0.8'
    },
    redirect: 'manual',
    signal: mergeTimeoutSignal(7_500, externalSignal)
  });
  if (!res.ok) return [];
  const html = await readBoundedText(res, 250_000);
  return parseDdgHtml(html);
}

async function searchDuckDuckGoInstant(query, externalSignal = null) {
  const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'CodePilot-Agent/2.2' },
    redirect: 'manual',
    signal: mergeTimeoutSignal(6_000, externalSignal)
  });
  if (!res.ok) return [];
  const data = await res.json();
  const out = [];
  if (data?.AbstractText && data?.AbstractURL) {
    out.push({
      title: String(data.Heading || query),
      url: String(data.AbstractURL),
      snippet: String(data.AbstractText).slice(0, 400),
      source: 'instant'
    });
  }
  for (const topic of (data?.RelatedTopics || []).slice(0, 5)) {
    if (topic?.Text && topic?.FirstURL) {
      out.push({
        title: String(topic.Text).split(' - ')[0].slice(0, 120),
        url: String(topic.FirstURL),
        snippet: String(topic.Text).slice(0, 320),
        source: 'instant'
      });
    }
  }
  return out;
}

async function searchWikipedia(query, lang = 'en', externalSignal = null) {
  const host = lang === 'fa' ? 'fa.wikipedia.org' : 'en.wikipedia.org';
  const endpoint = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=4&utf8=1&format=json`;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'CodePilot-Agent/2.2 (Cloudflare Pages)' },
    redirect: 'manual',
    signal: mergeTimeoutSignal(6_000, externalSignal)
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.query?.search || []).map((entry) => ({
    title: `${entry.title} (${lang === 'fa' ? 'ویکی‌پدیا' : 'Wikipedia'})`,
    url: `https://${host}/wiki/${encodeURIComponent(String(entry.title).replace(/ /g, '_'))}`,
    snippet: decodeHtmlEntities(String(entry.snippet || '').replace(/<[^>]+>/g, '')).trim(),
    source: `wikipedia-${lang}`
  }));
}

async function searchHackerNews(query, externalSignal = null) {
  const endpoint = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=4`;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'CodePilot-Agent/2.2' },
    redirect: 'manual',
    signal: mergeTimeoutSignal(6_000, externalSignal)
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.hits || [])
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
      source: 'hn'
    }));
}

/**
 * Federated live internet search across organic web, Wikipedia (FA/EN),
 * DuckDuckGo Instant Answers, and Hacker News Algolia.
 */
export async function searchWeb(env, { query, limit = 8, externalSignal = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, results: [], text: 'Error: search query is empty.' };
  if (q.length > 400) return { ok: false, results: [], text: 'Error: search query is too long.' };

  const secrets = envSecrets(env || {});
  if (secrets.some((s) => s && q.includes(s))) {
    return { ok: false, results: [], text: 'Blocked: query contains a server secret.' };
  }

  if (isCancelled(externalSignal)) {
    return { ok: false, results: [], text: 'Cancelled by user.' };
  }

  const capped = clamp(Number(limit) || 8, 1, 15);
  const hasPersian = /[\u0600-\u06FF]/.test(q);

  const tasks = [
    searchDuckDuckGoHtml(q, externalSignal),
    searchDuckDuckGoInstant(q, externalSignal),
    ...(hasPersian
      ? [searchWikipedia(q, 'fa', externalSignal), searchWikipedia(q, 'en', externalSignal)]
      : [searchWikipedia(q, 'en', externalSignal)]),
    searchHackerNews(q, externalSignal)
  ];

  const settled = await Promise.allSettled(tasks);
  const merged = [];
  const seen = new Set();

  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled' || !Array.isArray(outcome.value)) continue;
    for (const item of outcome.value) {
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
        source: item.source
      });
      if (merged.length >= capped) break;
    }
    if (merged.length >= capped) break;
  }

  if (!merged.length) {
    return {
      ok: true,
      results: [],
      text: `No search hits returned for "${q}". Try broader English/Persian keywords or call fetch_url directly on a known URL or API.`
    };
  }

  const lines = merged.map(
    (item, idx) =>
      `${idx + 1}. ${item.title}\n   URL: ${item.url}${item.snippet ? `\n   ${item.snippet}` : ''}`
  );
  return {
    ok: true,
    results: merged,
    text: [
      `Live search results for "${q}" (${merged.length} hits):`,
      '',
      ...lines,
      '',
      'Tip: Call fetch_url on any URL above to read its full content or query a JSON API directly.'
    ].join('\n')
  };
}
