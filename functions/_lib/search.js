// Workspace search: literal, regex, and symbol lookups with line numbers.
// Budgets are deterministic (files/lines/chars) plus a short wall-clock guard.
// A partial scan is reported as partial, never as a definitive "No matches".

import { fail } from './util.js';

const MAX_RESULTS = 120;
const MAX_FILE_CHARS = 900_000;
const MAX_REGEX_LENGTH = 200;
const SCAN_TIME_BUDGET_MS = 10;
const MAX_SCAN_FILES = 200;
const MAX_SCAN_LINES = 30_000;
const MAX_SCAN_CHARS = 2_000_000;
const MAX_REGEX_LINE_CHARS = 4_000;

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSafeRegexSource(source) {
  // JavaScript RegExp has no per-match timeout. Reject the common catastrophic
  // shapes before compiling; the deterministic scan caps bound the rest.
  if (/\\[1-9]/.test(source) ||
      /\((?:\?[:=!])?[^()]*[+*][^()]*\)\s*(?:[+*]|\{\d)/.test(source) ||
      /\((?:\?[:=!])?[^()]*\|[^()]*\)\s*(?:[+*]|\{\d)/.test(source)) {
    fail('این regex به‌دلیل خطر backtracking شدید مجاز نیست؛ از جست‌وجوی متنی یا الگوی ساده‌تر استفاده کنید.', 400, 'unsafe_regex');
  }
}

function toRegex(query, { regex = false, caseSensitive = false } = {}) {
  const raw = String(query || '');
  if (!raw.trim()) fail('عبارت جست‌وجو خالی است.', 400, 'empty_query');
  if (raw.length > MAX_REGEX_LENGTH) fail('عبارت جست‌وجو بیش از حد طولانی است.', 400, 'query_too_long');
  const source = regex ? raw : escapeRegExp(raw);
  if (regex) assertSafeRegexSource(source);
  try {
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    fail('عبارت جست‌وجوی regex معتبر نیست.', 400, 'bad_regex');
  }
}

function snippet(line, matchStart, matchLength, width = 160) {
  const start = Math.max(0, Math.min(matchStart - width, line.length - width * 2));
  const end = Math.min(line.length, matchStart + matchLength + width);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return prefix + line.slice(Math.max(0, start), end) + suffix;
}

/**
 * Search files for a literal or regex query.
 * Returns { results, total, truncated, filesScanned, scannedLines, scannedChars, budgetExceeded }.
 */
export function searchWorkspace(files, query, options = {}) {
  const {
    regex = false,
    caseSensitive = false,
    includeContext = 2,
    pathFilter = '',
    maxResults = 40,
    maxScanChars = MAX_SCAN_CHARS,
    maxScanLines = MAX_SCAN_LINES,
    timeBudgetMs = SCAN_TIME_BUDGET_MS
  } = options;

  const pattern = toRegex(query, { regex, caseSensitive });
  const literal = regex ? '' : (caseSensitive ? String(query) : String(query).toLowerCase());
  const pathRegex = pathFilter ? new RegExp(escapeRegExp(pathFilter), 'i') : null;
  const results = [];
  const started = Date.now();
  let filesScanned = 0;
  let scannedLines = 0;
  let scannedChars = 0;
  let truncated = false;
  let budgetExceeded = '';

  const overBudget = () => {
    if (scannedChars >= maxScanChars) return 'chars';
    if (scannedLines >= maxScanLines) return 'lines';
    if (filesScanned >= MAX_SCAN_FILES) return 'files';
    if (Date.now() - started > timeBudgetMs) return 'time';
    return '';
  };

  for (const [path, rawContent] of Object.entries(files || {})) {
    if (pathRegex && !pathRegex.test(path)) continue;
    const content = String(rawContent ?? '');
    if (!content || content.length > MAX_FILE_CHARS) continue;
    budgetExceeded = overBudget();
    if (budgetExceeded) { truncated = true; break; }
    filesScanned += 1;
    scannedChars += content.length;
    const lines = content.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      if ((index & 63) === 0) {
        budgetExceeded = overBudget();
        if (budgetExceeded) { truncated = true; break; }
      }
      const line = lines[index];
      scannedLines += 1;
      let matchIndex = -1;
      let matchLength = 0;
      if (!regex) {
        const haystack = caseSensitive ? line : line.toLowerCase();
        matchIndex = haystack.indexOf(literal);
        matchLength = literal.length;
      } else {
        if (line.length > MAX_REGEX_LINE_CHARS) {
          truncated = true;
          budgetExceeded = 'regex_line';
          continue;
        }
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (!match) continue;
        matchIndex = match.index;
        matchLength = Math.max(1, match[0].length);
      }
      if (matchIndex < 0) continue;

      const before = [];
      const after = [];
      for (let k = Math.max(0, index - includeContext); k < index; k += 1) before.push({ line: k + 1, text: lines[k] });
      for (let k = index + 1; k <= Math.min(lines.length - 1, index + includeContext); k += 1) after.push({ line: k + 1, text: lines[k] });
      results.push({
        path,
        line: index + 1,
        column: matchIndex + 1,
        text: line,
        snippet: snippet(line, matchIndex, matchLength),
        before,
        after
      });
      if (results.length >= MAX_RESULTS) {
        truncated = true;
        budgetExceeded = 'results';
        break;
      }
    }
    if (truncated) break;
  }

  const limited = results.slice(0, Math.max(1, Math.min(Number(maxResults) || 40, MAX_RESULTS)));
  return {
    results: limited,
    total: results.length,
    truncated: results.length > limited.length || truncated,
    filesScanned,
    scannedLines,
    scannedChars,
    budgetExceeded,
    query,
    regex,
    caseSensitive
  };
}

export function formatSearchHits(search, { maxHits = 30 } = {}) {
  if (!search.results.length) {
    if (search.truncated) {
      return `No matches in the scanned portion for "${search.query}" (scan truncated: ${search.budgetExceeded || 'budget'}; ${search.filesScanned} files, ${search.scannedLines} lines). Narrow the query or path filter; this is not a full-workspace negative.`;
    }
    return `No matches for "${search.query}".`;
  }
  const lines = search.results.slice(0, maxHits).map((hit) => `${hit.path}:${hit.line}: ${hit.snippet}`);
  if (search.truncated || search.results.length > maxHits) {
    lines.push(`… results truncated (${search.total} matches scanned${search.budgetExceeded ? `, ${search.budgetExceeded} budget` : ''}). Narrow the query if needed.`);
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

/** Extract symbols with the same deterministic scan budget as search. */
export function listSymbols(files, { query = '', maxPerFile = 60 } = {}) {
  const needle = String(query || '').toLowerCase();
  const out = [];
  const started = Date.now();
  let scannedChars = 0;
  let scannedFiles = 0;
  let truncated = false;
  for (const [path, rawContent] of Object.entries(files || {})) {
    const language = languageOf(path);
    if (!language) continue;
    const content = String(rawContent ?? '');
    if (!content || content.length > MAX_FILE_CHARS) continue;
    if (scannedFiles >= MAX_SCAN_FILES || scannedChars + content.length > MAX_SCAN_CHARS || Date.now() - started > SCAN_TIME_BUDGET_MS) {
      truncated = true;
      break;
    }
    scannedFiles += 1;
    scannedChars += content.length;
    const seen = new Set();
    const entries = [];
    let lineStarts = null;
    for (const pattern of SYMBOL_PATTERNS[language]) {
      pattern.lastIndex = 0;
      let match;
      let matches = 0;
      while ((match = pattern.exec(content))) {
        if ((++matches & 127) === 0 && Date.now() - started > SCAN_TIME_BUDGET_MS) {
          truncated = true;
          break;
        }
        const name = match[1];
        if (!name || seen.has(name)) continue;
        if (needle && !name.toLowerCase().includes(needle) && !path.toLowerCase().includes(needle)) continue;
        if (!lineStarts) lineStarts = buildLineStarts(content);
        const line = lineNumberAt(lineStarts, match.index + (content[match.index] === '\n' ? 1 : 0));
        seen.add(name);
        entries.push({ name, line, kind: language === 'html' ? 'anchor' : 'symbol' });
        if (entries.length >= maxPerFile) break;
      }
      if (entries.length >= maxPerFile || truncated) break;
    }
    if (entries.length) out.push({ path, symbols: entries.sort((a, b) => a.line - b.line) });
  }
  // Non-index property: callers still receive an array, while the tool layer
  // can disclose that the symbol index is partial.
  out.truncated = truncated;
  return out;
}

export function formatSymbols(symbols, { maxFiles = 20 } = {}) {
  if (!symbols.length) return symbols.truncated ? 'Symbol scan truncated before matches; narrow the query/path.' : 'No symbols matched.';
  const body = symbols
    .slice(0, maxFiles)
    .map((file) => `${file.path}\n  ${file.symbols.map((s) => `${s.name}@${s.line}`).join(', ')}`)
    .join('\n');
  return symbols.truncated ? `${body}\n… symbol scan truncated; narrow the query/path.` : body;
}
