// Streaming workspace search, recursive file listing, and multi-language symbol
// extraction with deterministic budgets, glob/ignore/binary handling, pagination,
// ReDoS protection, and honest unsupported-language reporting.

import { fail } from './util.js';

const MAX_RESULTS = 500;
const MAX_FILE_CHARS = 5_000_000;
const MAX_REGEX_LENGTH = 500;
const SCAN_TIME_BUDGET_MS = 1_500;
const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_LINES = 250_000;
const MAX_SCAN_CHARS = 16_000_000;
const MAX_REGEX_LINE_CHARS = 32_000;
const MAX_LIST_ENTRIES = 100_000;

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.cp-jobs'
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.pyc',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.sqlite', '.db'
]);

export const SUPPORTED_SYMBOL_LANGUAGES = Object.freeze({
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  css: ['.css', '.scss'],
  html: ['.html', '.htm'],
  shell: ['.sh', '.bash'],
  sql: ['.sql']
});

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------ glob & ignore ----------------------------- */

export function globToRegExp(rawPattern) {
  const pattern = String(rawPattern || '').trim().replace(/^\.\//, '');
  if (!pattern || pattern.length > 240) {
    fail('الگوی glob نامعتبر یا بیش از حد طولانی است.', 400, 'bad_glob');
  }
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close > i + 1) {
        const alts = pattern
          .slice(i + 1, close)
          .split(',')
          .map((part) => escapeRegExp(part.trim()))
          .filter(Boolean);
        out += alts.length ? `(?:${alts.join('|')})` : '\\{';
        i = close + 1;
      } else {
        out += '\\{';
        i += 1;
      }
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i + 1) {
        const inner = pattern.slice(i + 1, close).replace(/\\/g, '\\\\');
        out += `[${inner.startsWith('!') ? `^${inner.slice(1)}` : inner}]`;
        i = close + 1;
      } else {
        out += '\\[';
        i += 1;
      }
    } else {
      out += escapeRegExp(ch);
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out, 'i');
}

export function matchesGlob(filePath, pattern) {
  const clean = String(filePath || '').replace(/^\.\//, '');
  const raw = String(pattern || '').trim().replace(/^\.\//, '');
  if (!raw) return true;
  const rx = globToRegExp(raw);
  if (rx.test(clean)) return true;
  if (!raw.includes('/')) {
    const base = clean.includes('/') ? clean.slice(clean.lastIndexOf('/') + 1) : clean;
    return rx.test(base);
  }
  return false;
}

export function parseGitignore(content) {
  const rules = [];
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    let body = negated ? line.slice(1).trim() : line;
    if (!body) continue;
    const dirOnly = body.endsWith('/');
    if (dirOnly) body = body.slice(0, -1);
    const anchored = body.startsWith('/');
    if (anchored) body = body.slice(1);
    if (!body) continue;
    try {
      const targetPattern = dirOnly
        ? anchored
          ? `${body}/**`
          : `**/${body}/**`
        : anchored || body.includes('/')
          ? body
          : `**/${body}`;
      const directRx = globToRegExp(dirOnly ? body : targetPattern);
      const nestedRx = dirOnly ? globToRegExp(targetPattern) : null;
      rules.push({ negated, dirOnly, directRx, nestedRx, raw: body });
    } catch {
      // ignore malformed gitignore line
    }
  }
  return rules;
}

export function isIgnoredPath(filePath, gitignoreRules = []) {
  const clean = String(filePath || '').replace(/^\.\//, '');
  if (!clean) return false;
  const segments = clean.split('/');
  for (const seg of segments) {
    if (DEFAULT_IGNORED_DIRS.has(seg)) return true;
  }
  if (!gitignoreRules || !gitignoreRules.length) return false;
  let ignored = false;
  for (const rule of gitignoreRules) {
    const matched =
      rule.directRx.test(clean) ||
      (rule.nestedRx ? rule.nestedRx.test(clean) : false) ||
      (!rule.raw.includes('/') && segments.some((seg) => rule.directRx.test(seg)));
    if (matched) ignored = !rule.negated;
  }
  return ignored;
}

export function extensionOf(filePath) {
  const base = String(filePath || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

export function isBinaryFile(filePath, content = '') {
  const ext = extensionOf(filePath);
  if (ext && BINARY_EXTENSIONS.has(ext)) return true;
  const text = String(content ?? '');
  if (!text) return false;
  const sampleLen = Math.min(text.length, 4096);
  let controlCount = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) return true;
    if ((code < 9) || (code > 13 && code < 32)) controlCount += 1;
  }
  return sampleLen >= 32 && controlCount / sampleLen > 0.12;
}

function buildPathMatcher(pathFilter, glob, exclude) {
  const cleanFilter = String(pathFilter || '').trim();
  const cleanGlob = String(glob || '').trim();
  const excludeList = (Array.isArray(exclude) ? exclude : exclude ? [exclude] : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  const filterIsGlob = cleanFilter && /[*?[\]{}]/.test(cleanFilter);
  const filterRegex = cleanFilter && !filterIsGlob ? new RegExp(escapeRegExp(cleanFilter), 'i') : null;

  return (filePath) => {
    if (cleanGlob && !matchesGlob(filePath, cleanGlob)) return false;
    if (cleanFilter) {
      if (filterIsGlob) {
        if (!matchesGlob(filePath, cleanFilter)) return false;
      } else if (!filterRegex.test(filePath)) {
        return false;
      }
    }
    for (const ex of excludeList) {
      if (matchesGlob(filePath, ex)) return false;
    }
    return true;
  };
}

function parseOffsetCursor(offset, cursor) {
  if (Number.isFinite(Number(offset)) && Number(offset) >= 0) {
    return Math.floor(Number(offset));
  }
  if (typeof cursor === 'string' && cursor.trim()) {
    const m = /^offset:(\d+)$/i.exec(cursor.trim());
    if (m) return Number(m[1]);
    fail(`cursor نامعتبر است: "${cursor}". قالب مجاز: "offset:<number>".`, 400, 'bad_cursor');
  }
  return 0;
}

/* ------------------------------- safe regex ------------------------------- */

export function assertSafeRegexSource(source) {
  // JavaScript RegExp has no native per-match timeout. Reject known catastrophic
  // backtracking patterns before compiling; scan/time budgets bound the rest.
  if (
    /\\[1-9]/.test(source) || // backreferences
    /\((?:\?[:=!])?[^()]*[+*][^()]*\)\s*(?:[+*]|\{\d)/.test(source) || // nested quantifiers e.g. (a+)+
    /\((?:\?[:=!])?[^()]*\|[^()]*\)\s*(?:[+*]|\{\d)/.test(source) || // quantified alternation e.g. (a|aa)+
    /\(\?<[=!][^)]*[+*]/.test(source) || // unbounded lookbehind
    /\{\s*(?:\d{3,}|[2-9]\d{2,})\s*(?:,\s*\d*)?\s*\}/.test(source) || // huge quantifier repetition {200,}
    /(?:\.\*|\.\+)[^()]{0,20}(?:\.\*|\.\+)/.test(source) // overlapping greedy wildcards .*x.*y
  ) {
    fail(
      'این regex به‌دلیل خطر backtracking شدید یا هزینهٔ بالا مجاز نیست؛ از جست‌وجوی متنی یا الگوی ساده‌تر استفاده کنید.',
      400,
      'unsafe_regex'
    );
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

/** Stream lines from a large string without allocating `content.split('\n')`. */
export function* iterateLines(content) {
  const text = String(content ?? '');
  const len = text.length;
  let pos = 0;
  let lineNumber = 1;
  while (pos <= len) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const cleanEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    yield { lineNumber, text: text.slice(pos, cleanEnd), start: pos, end };
    if (nl === -1) break;
    pos = nl + 1;
    lineNumber += 1;
  }
}

function readNextLines(content, afterOffset, count, startLineNumber) {
  const out = [];
  if (count <= 0) return out;
  const len = content.length;
  let pos = afterOffset;
  let lineNum = startLineNumber;
  while (out.length < count && pos <= len) {
    const nl = content.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const cleanEnd = end > pos && content.charCodeAt(end - 1) === 13 ? end - 1 : end;
    out.push({ line: lineNum, text: content.slice(pos, cleanEnd) });
    if (nl === -1) break;
    pos = nl + 1;
    lineNum += 1;
  }
  return out;
}

function createSearchRunner(query, options = {}) {
  const {
    regex = false,
    caseSensitive = false,
    includeContext = undefined,
    contextLines = undefined,
    pathFilter = '',
    glob = '',
    exclude = [],
    includeIgnored = false,
    offset = undefined,
    cursor = undefined,
    limit = undefined,
    maxResults = 40,
    maxFileChars = MAX_FILE_CHARS,
    maxScanChars = MAX_SCAN_CHARS,
    maxScanLines = MAX_SCAN_LINES,
    maxScanFiles = MAX_SCAN_FILES,
    timeBudgetMs = SCAN_TIME_BUDGET_MS,
    gitignoreRules = []
  } = options;

  const pattern = toRegex(query, { regex, caseSensitive });
  const literal = regex ? '' : (caseSensitive ? String(query) : String(query).toLowerCase());
  const ctxCount = Math.max(0, Math.min(10, Number(contextLines ?? includeContext ?? 2) || 0));
  const pageOffset = parseOffsetCursor(offset, cursor);
  const pageLimit = Math.max(1, Math.min(Number(limit ?? maxResults) || 40, MAX_RESULTS));
  const matchPath = buildPathMatcher(pathFilter, glob, exclude);

  const started = Date.now();
  const pageResults = [];
  let totalMatched = 0;
  let hasMore = false;
  let filesScanned = 0;
  let scannedLines = 0;
  let scannedChars = 0;
  let truncated = false;
  let budgetStopped = false;
  let budgetExceeded = '';
  const skipped = {
    binary: { count: 0, sample: [] },
    ignored: { count: 0, sample: [] },
    tooLarge: { count: 0, sample: [] }
  };

  const recordSkipped = (bucket, path) => {
    skipped[bucket].count += 1;
    if (skipped[bucket].sample.length < 10) skipped[bucket].sample.push(path);
  };

  const checkBudget = () => {
    if (scannedChars >= maxScanChars) return 'chars';
    if (scannedLines >= maxScanLines) return 'lines';
    if (filesScanned >= maxScanFiles) return 'files';
    if (Date.now() - started > timeBudgetMs) return 'time';
    return '';
  };

  const scanFile = (path, rawContent) => {
    if (budgetStopped || hasMore) return false;
    if (!includeIgnored && isIgnoredPath(path, gitignoreRules)) {
      recordSkipped('ignored', path);
      return true;
    }
    if (!matchPath(path)) return true;

    const content = String(rawContent ?? '');
    if (!content) return true;
    if (content.length > maxFileChars) {
      recordSkipped('tooLarge', path);
      truncated = true;
      if (!budgetExceeded) budgetExceeded = 'file_size';
      return true;
    }
    if (isBinaryFile(path, content)) {
      recordSkipped('binary', path);
      return true;
    }

    const over = checkBudget();
    if (over) {
      truncated = true;
      budgetStopped = true;
      budgetExceeded = over;
      return false;
    }

    filesScanned += 1;
    scannedChars += content.length;

    const prevRing = [];
    for (const { lineNumber, text: line, end } of iterateLines(content)) {
      const checkMask = regex && line.length > 400 ? 3 : 31;
      if ((lineNumber & checkMask) === 0) {
        const lineOver = checkBudget();
        if (lineOver) {
          truncated = true;
          budgetStopped = true;
          budgetExceeded = lineOver;
          return false;
        }
      }
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
        } else {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
          if (match) {
            matchIndex = match.index;
            matchLength = Math.max(1, match[0].length);
          }
        }
      }

      if (matchIndex >= 0) {
        totalMatched += 1;
        if (totalMatched > pageOffset) {
          if (pageResults.length >= pageLimit) {
            hasMore = true;
            truncated = true;
            if (!budgetExceeded) budgetExceeded = 'results';
            return false;
          }
          const before = ctxCount > 0 ? prevRing.slice(-ctxCount) : [];
          const after =
            ctxCount > 0 && end < content.length
              ? readNextLines(content, end + 1, ctxCount, lineNumber + 1)
              : [];
          pageResults.push({
            path,
            line: lineNumber,
            column: matchIndex + 1,
            text: line,
            snippet: snippet(line, matchIndex, matchLength),
            before,
            after
          });
        }
      }

      if (ctxCount > 0) {
        prevRing.push({ line: lineNumber, text: line });
        if (prevRing.length > ctxCount) prevRing.shift();
      }
    }
    return true;
  };

  const finish = () => {
    const nextOffset = hasMore ? pageOffset + pageResults.length : null;
    return {
      results: pageResults,
      total: totalMatched,
      offset: pageOffset,
      limit: pageLimit,
      hasMore,
      nextOffset,
      nextCursor: nextOffset !== null ? `offset:${nextOffset}` : null,
      truncated: hasMore || truncated,
      filesScanned,
      scannedLines,
      scannedChars,
      budgetExceeded,
      skipped,
      query,
      regex,
      caseSensitive,
      contextLines: ctxCount
    };
  };

  return { scanFile, recordSkipped, finish };
}

/**
 * Search workspace files using a streaming line scanner (zero split('\n') arrays).
 */
export function searchWorkspace(files, query, options = {}) {
  const fileMap = files && typeof files === 'object' ? files : {};
  const gitignoreRules =
    options.gitignoreRules ||
    (typeof fileMap['.gitignore'] === 'string' ? parseGitignore(fileMap['.gitignore']) : []);
  const runner = createSearchRunner(query, { ...options, gitignoreRules });

  for (const path of Object.keys(fileMap).sort()) {
    const rawContent = fileMap[path];
    if (rawContent === null || rawContent === undefined) continue;
    const keepGoing = runner.scanFile(path, rawContent);
    if (!keepGoing) break;
  }

  if (options.lazyFiles && typeof options.lazyFiles === 'object') {
    for (const [lazyPath] of Object.entries(options.lazyFiles)) {
      runner.recordSkipped('tooLarge', lazyPath);
    }
  }

  return runner.finish();
}

/**
 * Async streaming search over any iterable / async iterable of `[path, content]`
 * entries (e.g. Node filesystem walker or chunked D1 reader).
 */
export async function searchWorkspaceStream(entries, query, options = {}) {
  const runner = createSearchRunner(query, options);
  for await (const entry of entries) {
    if (!entry) continue;
    const [path, content] = Array.isArray(entry) ? entry : [entry.path, entry.content];
    if (!path || content === null || content === undefined) continue;
    const keepGoing = runner.scanFile(String(path), content);
    if (!keepGoing) break;
  }
  return runner.finish();
}

function formatSkippedSummary(skipped) {
  if (!skipped) return '';
  const parts = [];
  if (skipped.binary?.count) parts.push(`${skipped.binary.count} binary`);
  if (skipped.ignored?.count) parts.push(`${skipped.ignored.count} ignored`);
  if (skipped.tooLarge?.count) parts.push(`${skipped.tooLarge.count} too-large`);
  return parts.length ? `Skipped: ${parts.join(', ')}.` : '';
}

export function formatSearchHits(search, { maxHits = 40, showContext = false } = {}) {
  const skipLine = formatSkippedSummary(search.skipped);
  if (!search.results.length) {
    if (search.truncated) {
      return [
        `No matches in the scanned portion for "${search.query}" (scan truncated: ${search.budgetExceeded || 'budget'}; ${search.filesScanned} files, ${search.scannedLines} lines). Narrow the query or path filter; this is not a full-workspace negative.`,
        skipLine
      ]
        .filter(Boolean)
        .join('\n');
    }
    return [`No matches for "${search.query}".`, skipLine].filter(Boolean).join('\n');
  }

  const shown = search.results.slice(0, maxHits);
  const lines = [];
  for (const hit of shown) {
    if (showContext && Array.isArray(hit.before)) {
      for (const b of hit.before) lines.push(`  ${hit.path}:${b.line}- ${b.text.slice(0, 180)}`);
    }
    lines.push(`${hit.path}:${hit.line}:${hit.column || 1}: ${hit.snippet}`);
    if (showContext && Array.isArray(hit.after)) {
      for (const a of hit.after) lines.push(`  ${hit.path}:${a.line}- ${a.text.slice(0, 180)}`);
    }
  }

  if (search.hasMore && search.nextOffset !== null) {
    lines.push(
      `… page offset ${search.offset}..${search.offset + shown.length - 1} (more matches available). Continue with offset: ${search.nextOffset} (cursor: "${search.nextCursor}").`
    );
  } else if (search.truncated || search.results.length > maxHits) {
    lines.push(
      `… results truncated (${search.total} matches scanned${search.budgetExceeded ? `, ${search.budgetExceeded} budget` : ''}). Narrow the query or paginate if needed.`
    );
  }
  if (skipLine) lines.push(skipLine);
  return lines.join('\n');
}

/* ------------------------------- list_files ------------------------------- */

function detectSymlinkLoop(startPath, symlinks) {
  if (!symlinks || typeof symlinks !== 'object') return false;
  const visited = new Set([startPath]);
  let cur = startPath;
  for (let depth = 0; depth < 32; depth += 1) {
    const next = symlinks[cur];
    if (!next) return false;
    const norm = String(next).replace(/^\.\//, '');
    if (visited.has(norm)) return true;
    visited.add(norm);
    cur = norm;
  }
  return true;
}

/**
 * Paginated, ignore-aware, symlink-loop-safe recursive file listing for
 * workspace snapshots.
 */
export function listWorkspaceFiles(workspace, options = {}) {
  const {
    pathPrefix = '',
    glob = '',
    exclude = [],
    maxDepth = null,
    includeIgnored = false,
    offset = undefined,
    cursor = undefined,
    limit = 100
  } = options || {};

  const filesMap = workspace?.files && typeof workspace.files === 'object' ? workspace.files : {};
  const lazyMap = workspace?.lazy && typeof workspace.lazy === 'object' ? workspace.lazy : {};
  const symlinks = workspace?.symlinks && typeof workspace.symlinks === 'object' ? workspace.symlinks : null;
  const gitignoreRules =
    typeof filesMap['.gitignore'] === 'string' ? parseGitignore(filesMap['.gitignore']) : [];

  const cleanPrefix = String(pathPrefix || '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const depthCap =
    maxDepth !== null &&
    maxDepth !== undefined &&
    maxDepth !== '' &&
    Number.isFinite(Number(maxDepth)) &&
    Number(maxDepth) >= 0
      ? Math.floor(Number(maxDepth))
      : null;
  const pageOffset = parseOffsetCursor(offset, cursor);
  const pageLimit = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const matchPath = buildPathMatcher('', glob, exclude);

  const allPaths = Object.keys(filesMap).sort((a, b) => a.localeCompare(b));
  const matched = [];
  let skippedIgnored = 0;
  let skippedSymlinkLoops = 0;
  let truncated = false;

  for (let i = 0; i < allPaths.length; i += 1) {
    if (i >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }
    const p = allPaths[i];
    if (symlinks && detectSymlinkLoop(p, symlinks)) {
      skippedSymlinkLoops += 1;
      continue;
    }
    const ignored = isIgnoredPath(p, gitignoreRules);
    if (!includeIgnored && ignored) {
      skippedIgnored += 1;
      continue;
    }
    if (cleanPrefix && p !== cleanPrefix && !p.startsWith(`${cleanPrefix}/`)) continue;
    const relative = cleanPrefix && p.startsWith(`${cleanPrefix}/`) ? p.slice(cleanPrefix.length + 1) : p;
    const depth = relative.split('/').length - 1;
    if (depthCap !== null && depth > depthCap) continue;
    if (!matchPath(p)) continue;

    const isLazy = filesMap[p] === null || Boolean(lazyMap[p]);
    const size = isLazy ? Number(lazyMap[p] || 0) : String(filesMap[p] ?? '').length;
    matched.push({ path: p, size, lazy: isLazy, depth, ignored });
  }

  const slice = matched.slice(pageOffset, pageOffset + pageLimit);
  const hasMore = pageOffset + slice.length < matched.length;
  const nextOffset = hasMore ? pageOffset + slice.length : null;

  return {
    files: slice,
    total: allPaths.length,
    matched: matched.length,
    offset: pageOffset,
    limit: pageLimit,
    hasMore,
    nextOffset,
    nextCursor: nextOffset !== null ? `offset:${nextOffset}` : null,
    skippedIgnored,
    skippedSymlinkLoops,
    truncated: truncated || hasMore
  };
}

export function formatFileList(listing) {
  if (!listing.files.length) {
    if (listing.matched > 0 && listing.offset >= listing.matched) {
      return `No files at offset ${listing.offset} (total matched: ${listing.matched}).`;
    }
    const notes = [];
    if (listing.skippedIgnored) notes.push(`${listing.skippedIgnored} ignored skipped`);
    if (listing.skippedSymlinkLoops) notes.push(`${listing.skippedSymlinkLoops} symlink loop(s) skipped`);
    return notes.length ? `(no matching files; ${notes.join(', ')})` : '(empty workspace)';
  }
  const lines = listing.files.map((item) =>
    item.lazy
      ? `${item.path} (${Math.round(item.size / 1000)}KB on disk — use read_file to load)`
      : `${item.path} (${item.size} chars)`
  );
  const footer = [];
  if (listing.hasMore && listing.nextOffset !== null) {
    footer.push(
      `… showing ${listing.offset + 1}-${listing.offset + listing.files.length} of ${listing.matched} files. Continue with offset: ${listing.nextOffset} (cursor: "${listing.nextCursor}").`
    );
  }
  if (listing.skippedIgnored) footer.push(`Ignored skipped: ${listing.skippedIgnored} (pass includeIgnored: true to show).`);
  if (listing.skippedSymlinkLoops) footer.push(`Symlink loops skipped: ${listing.skippedSymlinkLoops}.`);
  return [...lines, ...footer].join('\n');
}

/* --------------------------------- symbols -------------------------------- */

const SYMBOL_PATTERNS = {
  js: [
    { kind: 'function', rx: /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'function', rx: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g },
    { kind: 'class', rx: /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'interface', rx: /(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'type', rx: /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*=/g },
    { kind: 'enum', rx: /(?:^|\n)\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'symbol', rx: /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?[A-Za-z_$][\w$]*\s*\(/g }
  ],
  python: [
    { kind: 'function', rx: /(?:^|\n)[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g },
    { kind: 'class', rx: /(?:^|\n)[ \t]*class\s+([A-Za-z_]\w*)\s*[:(]/g }
  ],
  go: [
    { kind: 'function', rx: /(?:^|\n)func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*[([<]/g },
    { kind: 'type', rx: /(?:^|\n)type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/g }
  ],
  rust: [
    { kind: 'function', rx: /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/g },
    { kind: 'struct', rx: /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/g },
    { kind: 'enum', rx: /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/g },
    { kind: 'trait', rx: /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/g }
  ],
  css: [
    { kind: 'selector', rx: /(?:^|\n)\s*\.([A-Za-z_-][\w-]*)\s*[,{]/g },
    { kind: 'selector', rx: /(?:^|\n)\s*#([A-Za-z_-][\w-]*)\s*[,{]/g },
    { kind: 'keyframes', rx: /(?:^|\n)\s*@keyframes\s+([A-Za-z_-][\w-]*)/g }
  ],
  html: [
    { kind: 'anchor', rx: /\bid=["']([^"']+)["']/g },
    { kind: 'anchor', rx: /\bclass=["']([^"']+)["']/g }
  ],
  shell: [
    { kind: 'function', rx: /(?:^|\n)[ \t]*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/g },
    { kind: 'function', rx: /(?:^|\n)[ \t]*function\s+([A-Za-z_][\w-]*)\s*\{/g }
  ],
  sql: [
    { kind: 'table', rx: /(?:^|\n)\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|INDEX|TRIGGER|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w"`]+\.)?["`]?([A-Za-z_]\w*)["`]?/gi }
  ]
};

export function languageOf(path) {
  const ext = extensionOf(path);
  for (const [lang, exts] of Object.entries(SUPPORTED_SYMBOL_LANGUAGES)) {
    if (exts.includes(ext)) return lang;
  }
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

/**
 * Extract symbols across supported languages with deterministic scan budgets,
 * pagination, ignore/binary filtering, and explicit unsupported-file disclosure.
 */
export function listSymbols(files, options = {}) {
  const {
    query = '',
    path: exactPath = '',
    pathPrefix = '',
    pathFilter = '',
    glob = '',
    exclude = [],
    includeIgnored = false,
    offset = undefined,
    cursor = undefined,
    limit = 60,
    maxPerFile = 300,
    maxScanChars = MAX_SCAN_CHARS,
    maxScanFiles = MAX_SCAN_FILES,
    timeBudgetMs = SCAN_TIME_BUDGET_MS
  } = options || {};

  const fileMap = files && typeof files === 'object' ? files : {};
  const gitignoreRules =
    typeof fileMap['.gitignore'] === 'string' ? parseGitignore(fileMap['.gitignore']) : [];
  const cleanExact = String(exactPath || '').trim().replace(/^\.\//, '');
  const cleanPrefix = String(pathPrefix || '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const matchPath = buildPathMatcher(pathFilter, glob, exclude);
  const matchesTarget = (p) => {
    if (cleanExact && p !== cleanExact) return false;
    if (cleanPrefix && p !== cleanPrefix && !p.startsWith(`${cleanPrefix}/`)) return false;
    return matchPath(p);
  };
  const needle = String(query || '').toLowerCase();
  const pageOffset = parseOffsetCursor(offset, cursor);
  const pageLimit = Math.max(1, Math.min(Number(limit) || 60, 500));

  const allMatches = [];
  const unsupportedFiles = [];
  const skipped = {
    ignored: { count: 0, sample: [] },
    binary: { count: 0, sample: [] },
    tooLarge: { count: 0, sample: [] }
  };
  const recordSkipped = (bucket, p) => {
    skipped[bucket].count += 1;
    if (skipped[bucket].sample.length < 10) skipped[bucket].sample.push(p);
  };

  const started = Date.now();
  let scannedChars = 0;
  let scannedFiles = 0;
  let truncated = false;
  let budgetExceeded = '';

  for (const path of Object.keys(fileMap).sort((a, b) => a.localeCompare(b))) {
    const rawContent = fileMap[path];
    if (!includeIgnored && isIgnoredPath(path, gitignoreRules)) {
      recordSkipped('ignored', path);
      continue;
    }
    if (!matchesTarget(path)) continue;
    if (rawContent === null || rawContent === undefined) {
      recordSkipped('tooLarge', path);
      continue;
    }

    const content = String(rawContent);
    if (isBinaryFile(path, content)) {
      recordSkipped('binary', path);
      continue;
    }
    const language = languageOf(path);
    if (!language) {
      unsupportedFiles.push({ path, extension: extensionOf(path) || '(no extension)' });
      continue;
    }
    if (!content) continue;
    if (content.length > MAX_FILE_CHARS) {
      recordSkipped('tooLarge', path);
      truncated = true;
      if (!budgetExceeded) budgetExceeded = 'file_size';
      continue;
    }
    if (
      scannedFiles >= maxScanFiles ||
      scannedChars + content.length > maxScanChars ||
      Date.now() - started > timeBudgetMs
    ) {
      truncated = true;
      budgetExceeded =
        scannedFiles >= maxScanFiles
          ? 'files'
          : scannedChars + content.length > maxScanChars
            ? 'chars'
            : 'time';
      break;
    }

    scannedFiles += 1;
    scannedChars += content.length;
    const seen = new Set();
    const entries = [];
    let lineStarts = null;

    for (const { kind, rx } of SYMBOL_PATTERNS[language]) {
      rx.lastIndex = 0;
      let match;
      let matches = 0;
      while ((match = rx.exec(content))) {
        if ((++matches & 127) === 0 && Date.now() - started > timeBudgetMs) {
          truncated = true;
          budgetExceeded = 'time';
          break;
        }
        const name = match[1];
        if (!name || seen.has(name)) continue;
        if (needle && !name.toLowerCase().includes(needle) && !path.toLowerCase().includes(needle)) continue;
        if (!lineStarts) lineStarts = buildLineStarts(content);
        const line = lineNumberAt(lineStarts, match.index + (content[match.index] === '\n' ? 1 : 0));
        seen.add(name);
        entries.push({ name, line, kind });
        if (entries.length >= maxPerFile) break;
      }
      if (entries.length >= maxPerFile || truncated) break;
    }
    if (entries.length) {
      allMatches.push({
        path,
        language,
        symbols: entries.sort((a, b) => a.line - b.line)
      });
    }
  }

  const page = allMatches.slice(pageOffset, pageOffset + pageLimit);
  const hasMore = pageOffset + page.length < allMatches.length;
  const nextOffset = hasMore ? pageOffset + page.length : null;

  // Non-index metadata attached to the returned array for full backward compatibility.
  page.truncated = truncated || hasMore;
  page.budgetExceeded = budgetExceeded;
  page.totalFiles = allMatches.length;
  page.scannedFiles = scannedFiles;
  page.offset = pageOffset;
  page.limit = pageLimit;
  page.hasMore = hasMore;
  page.nextOffset = nextOffset;
  page.nextCursor = nextOffset !== null ? `offset:${nextOffset}` : null;
  page.unsupportedFiles = unsupportedFiles;
  page.skipped = skipped;
  page.supportedLanguages = Object.keys(SUPPORTED_SYMBOL_LANGUAGES);
  return page;
}

export function formatSymbols(symbols, { maxFiles = 20 } = {}) {
  const unsupported = Array.isArray(symbols?.unsupportedFiles) ? symbols.unsupportedFiles : [];
  const supportedLabel = Object.entries(SUPPORTED_SYMBOL_LANGUAGES)
    .map(([lang, exts]) => `${lang} (${exts.join(', ')})`)
    .join('; ');
  const skipLine = formatSkippedSummary(symbols?.skipped);

  if (!symbols.length) {
    if (symbols.truncated) {
      return `Symbol scan truncated before matches (${symbols.budgetExceeded || 'budget'}); narrow the query/path.`;
    }
    if (unsupported.length > 0 && (symbols.scannedFiles || 0) === 0) {
      const sample = unsupported
        .slice(0, 10)
        .map((u) => `${u.path} [${u.extension}]`)
        .join(', ');
      return [
        `Symbol extraction is NOT supported for the targeted file type(s): ${sample}${unsupported.length > 10 ? ` (+${unsupported.length - 10} more)` : ''}.`,
        `Supported languages: ${supportedLabel}.`,
        skipLine
      ]
        .filter(Boolean)
        .join('\n');
    }
    const notes = [`No symbols matched.`];
    if (unsupported.length > 0) {
      const exts = [...new Set(unsupported.map((u) => u.extension))].slice(0, 8).join(', ');
      notes.push(`Note: ${unsupported.length} file(s) with unsupported format(s) (${exts}) were not parsed for symbols.`);
    }
    if (skipLine) notes.push(skipLine);
    return notes.join('\n');
  }

  const shown = symbols.slice(0, maxFiles);
  const body = shown
    .map((file) => `${file.path} [${file.language || 'code'}]\n  ${file.symbols.map((s) => `${s.name}@${s.line}`).join(', ')}`)
    .join('\n');
  const footer = [];
  if (symbols.hasMore && symbols.nextOffset !== null) {
    footer.push(
      `… showing files ${symbols.offset + 1}-${symbols.offset + shown.length} of ${symbols.totalFiles}. Continue with offset: ${symbols.nextOffset} (cursor: "${symbols.nextCursor}").`
    );
  } else if (symbols.truncated) {
    footer.push(`… symbol scan truncated (${symbols.budgetExceeded || 'budget'}); narrow the query/path.`);
  }
  if (unsupported.length > 0) {
    const exts = [...new Set(unsupported.map((u) => u.extension))].slice(0, 8).join(', ');
    footer.push(`Unsupported for symbol extraction (${unsupported.length} file(s)): ${exts}.`);
  }
  if (skipLine) footer.push(skipLine);
  return [body, ...footer].join('\n');
}
