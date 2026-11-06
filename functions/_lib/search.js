// Workspace search: literal, regex, and symbol lookups with line numbers.
//
// The whole workspace lives in D1 as JSON, so search runs in memory. That is
// fine up to a few hundred files (the hard cap); every query is bounded so a
// pathological regex cannot stall a request.

import { fail } from './util.js';

const MAX_RESULTS = 120;
const MAX_FILE_CHARS = 900_000;
const MAX_REGEX_LENGTH = 200;
const REGEX_TIME_BUDGET_MS = 40;

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRegex(query, { regex = false, caseSensitive = false } = {}) {
  const raw = String(query || '');
  if (!raw.trim()) fail('عبارت جست‌وجو خالی است.', 400, 'empty_query');
  if (raw.length > MAX_REGEX_LENGTH) fail('عبارت جست‌وجو بیش از حد طولانی است.', 400, 'query_too_long');
  const source = regex ? raw : escapeRegExp(raw);
  try {
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    fail('عبارت جست‌وجوی regex معتبر نیست.', 400, 'bad_regex');
  }
}

/** Keep a match snippet centred on the hit. */
function snippet(line, matchStart, matchLength, width = 160) {
  const text = line.length > width * 2 ? line : line;
  const start = Math.max(0, Math.min(matchStart - width, text.length - width * 2));
  const end = Math.min(text.length, matchStart + matchLength + width);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(Math.max(0, start), end) + suffix;
}

/**
 * Search every file for a literal or regex query.
 * Returns { results, total, truncated, filesScanned }.
 */
export function searchWorkspace(files, query, options = {}) {
  const {
    regex = false,
    caseSensitive = false,
    includeContext = 2,
    pathFilter = '',
    maxResults = 40
  } = options;

  const pattern = toRegex(query, { regex, caseSensitive });
  const pathRegex = pathFilter ? new RegExp(escapeRegExp(pathFilter), 'i') : null;
  const results = [];
  const started = Date.now();
  let filesScanned = 0;
  let timedOut = false;

  for (const [path, rawContent] of Object.entries(files || {})) {
    if (pathRegex && !pathRegex.test(path)) continue;
    const content = String(rawContent ?? '');
    if (!content || content.length > MAX_FILE_CHARS) continue;
    filesScanned += 1;
    const lines = content.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (!match) continue;

      const before = [];
      const after = [];
      for (let k = Math.max(0, index - includeContext); k < index; k += 1) {
        before.push({ line: k + 1, text: lines[k] });
      }
      for (let k = index + 1; k <= Math.min(lines.length - 1, index + includeContext); k += 1) {
        after.push({ line: k + 1, text: lines[k] });
      }
      results.push({
        path,
        line: index + 1,
        column: match.index + 1,
        text: line,
        snippet: snippet(line, match.index, Math.max(1, match[0].length)),
        before,
        after
      });

      if (results.length >= MAX_RESULTS) {
        timedOut = true;
        break;
      }
      if (Date.now() - started > REGEX_TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }
    }
    if (timedOut) break;
  }

  const limited = results.slice(0, maxResults);
  return {
    results: limited,
    total: results.length,
    truncated: results.length > limited.length || timedOut,
    filesScanned,
    query,
    regex,
    caseSensitive
  };
}

/** Format search hits compactly for the model (avoids flooding context). */
export function formatSearchHits(search, { maxHits = 30 } = {}) {
  if (!search.results.length) return `No matches for "${search.query}".`;
  const lines = search.results.slice(0, maxHits).map((hit) => `${hit.path}:${hit.line}: ${hit.snippet}`);
  if (search.truncated || search.results.length > maxHits) {
    lines.push(`… results truncated (${search.total} matches scanned). Narrow the query if needed.`);
  }
  return lines.join('\n');
}

/* --------------------------------- symbols -------------------------------- */

const SYMBOL_PATTERNS = {
  js: [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?[A-Za-z_$][\w$]*\s*\(/g
  ],
  css: [/(?:^|\n)\s*\.([A-Za-z_-][\w-]*)\s*[,{]/g, /(?:^|\n)\s*#([A-Za-z_-][\w-]*)\s*[,{]/g],
  html: [/\bid=["']([^"']+)["']/g, /\bclass=["']([^"']+)["']/g]
};

function languageOf(path) {
  if (/\.(m?js|jsx|ts|tsx)$/i.test(path)) return 'js';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.html?$/i.test(path)) return 'html';
  return null;
}

function buildLineStarts(content) {
  const starts = [0];
  let idx = content.indexOf('\n');
  while (idx !== -1) {
    starts.push(idx + 1);
    idx = content.indexOf('\n', idx + 1);
  }
  return starts;
}

function lineNumberAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1;
}

/** Extract top-level-ish symbols with line numbers, grouped by file. */
export function listSymbols(files, { query = '', maxPerFile = 60 } = {}) {
  const needle = String(query || '').toLowerCase();
  const out = [];
  for (const [path, rawContent] of Object.entries(files || {})) {
    const language = languageOf(path);
    if (!language) continue;
    const content = String(rawContent ?? '');
    if (!content || content.length > MAX_FILE_CHARS) continue;
    const seen = new Set();
    const entries = [];
    let lineStarts = null;
    for (const pattern of SYMBOL_PATTERNS[language]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content))) {
        const name = match[1];
        if (!name || seen.has(name)) continue;
        if (needle && !name.toLowerCase().includes(needle) && !path.toLowerCase().includes(needle)) continue;
        if (!lineStarts) lineStarts = buildLineStarts(content);
        const line = lineNumberAt(lineStarts, match.index + (content[match.index] === '\n' ? 1 : 0));
        seen.add(name);
        entries.push({ name, line, kind: language === 'html' ? 'anchor' : 'symbol' });
        if (entries.length >= maxPerFile) break;
      }
      if (entries.length >= maxPerFile) break;
    }
    if (entries.length) out.push({ path, symbols: entries.sort((a, b) => a.line - b.line) });
  }
  return out;
}

export function formatSymbols(symbols, { maxFiles = 20 } = {}) {
  if (!symbols.length) return 'No symbols matched.';
  return symbols
    .slice(0, maxFiles)
    .map((file) => `${file.path}\n  ${file.symbols.map((s) => `${s.name}@${s.line}`).join(', ')}`)
    .join('\n');
}
