// Precise, validated, format-preserving, transactional file editing.
//
// Capabilities:
//   1. detectFileFormatting() / restoreFileFormatting() — preserves UTF-8 BOM
//      and original newline style (\r\n, \r, \n) instead of silently rewriting.
//   2. applyEdits() — search/replace patching with optional `expectedHash`
//      conflict guard and `strict` mode (disables fuzzy fallback). Ambiguous or
//      absent matches always fail clearly without guessing.
//   3. parseUnifiedDiff() / applyUnifiedDiff() — strict context-verified unified
//      diff patching; stops with `patch_conflict` when context is missing,
//      drifted ambiguously, or file hash does not match.
//   4. applyPatchTransaction() — all-or-nothing multi-file patching with
//      `dryRun` preview and automatic rollback on any failure.
//   5. unifiedDiff() — allocation-safe line diff used for tool results, SSE
//      streams, dry-run previews, and version history.
//
// Everything is pure (no I/O) which keeps it trivially testable.

import { fail } from './util.js';

const MAX_EDITS_PER_FILE = 200;
const MAX_FILES_PER_TRANSACTION = 150;
const MAX_SEARCH_CHARS = 500_000;
const MAX_CONTENT_CHARS = 10_000_000;
const MAX_DIFF_LINES = 40_000;

/** Normalize newlines and drop a UTF-8 BOM. */
export function normalizeSource(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Detect BOM and dominant line-ending style so patches never clobber them. */
export function detectFileFormatting(raw) {
  const s = String(raw ?? '');
  const hasBom = s.startsWith('\uFEFF');
  const body = hasBom ? s.slice(1) : s;
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charCodeAt(i);
    if (ch === 13) {
      if (body.charCodeAt(i + 1) === 10) {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    } else if (ch === 10) {
      lf += 1;
    }
  }
  let eol = '\n';
  if (crlf > lf && crlf >= cr) eol = '\r\n';
  else if (cr > lf && cr > crlf) eol = '\r';
  const hasTrailingNewline = body.endsWith('\n') || body.endsWith('\r');
  return {
    hasBom,
    eol,
    eolName: eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF',
    hasTrailingNewline
  };
}

/** Restore detected BOM and newline convention to LF-normalized content. */
export function restoreFileFormatting(normalizedContent, formatting) {
  const text = String(normalizedContent ?? '');
  if (!formatting) return text;
  const eol = formatting.eol === '\r\n' || formatting.eol === '\r' ? formatting.eol : '\n';
  const withEol = eol === '\n' ? text : text.replace(/\n/g, eol);
  return formatting.hasBom ? `\uFEFF${withEol}` : withEol;
}

/** Fast deterministic dual-lane content hash for conflict detection. */
export function hashContent(text) {
  const s = String(text ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + ((i & 0xff) << 1);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${s.length}:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/* --------------------------------- errors --------------------------------- */

function editError(index, message, extra = {}) {
  fail(`ویرایش شماره ${index + 1}: ${message}`, 422, 'patch_failed', extra);
}

function assertExpectedHash(rawSource, expectedHash, path = '') {
  if (!expectedHash) return;
  const actualHash = hashContent(rawSource);
  const normalizedActual = hashContent(normalizeSource(rawSource));
  if (expectedHash !== actualHash && expectedHash !== normalizedActual) {
    fail(
      `تعارض نسخه${path ? ` در ${path}` : ''}: فایل پس از آخرین خواندن تغییر کرده است (expected ${expectedHash}, actual ${actualHash}). فایل را دوباره بخوانید.`,
      409,
      'patch_conflict',
      { path, expectedHash, actualHash }
    );
  }
}

/* ------------------------------- validation ------------------------------- */

export function validateEdits(edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    fail('حداقل یک ویرایش لازم است.', 400, 'bad_patch');
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    fail(`حداکثر ${MAX_EDITS_PER_FILE} ویرایش در هر فراخوانی مجاز است.`, 413, 'bad_patch');
  }
  return edits.map((edit, index) => {
    if (!edit || typeof edit !== 'object') editError(index, 'قالب ویرایش نامعتبر است.');
    const search = normalizeSource(edit.search ?? '');
    const replace = normalizeSource(edit.replace ?? '');
    if (search.length > MAX_SEARCH_CHARS || replace.length > MAX_CONTENT_CHARS) {
      editError(index, 'بخش جست‌وجو یا جایگزینی بیش از حد بزرگ است.');
    }
    if (!search && !replace) editError(index, 'هر دو بخش خالی هستند.');
    return {
      index,
      search,
      replace,
      replaceAll: Boolean(edit.replaceAll)
    };
  });
}

/* ------------------------------ fuzzy matching ---------------------------- */

const normalizeLine = (line) => line.replace(/\s+/g, ' ').trim();

/**
 * Find a block of lines whose normalized text equals the normalized search.
 * Returns every matching start index (0-based) in `lines`.
 */
export function findFuzzyMatches(lines, searchLines) {
  const target = searchLines.map(normalizeLine);
  // Refuse matching pure blank/whitespace search blocks fuzzily to avoid blind guesses.
  if (target.every((t) => t === '')) return [];
  const matches = [];
  const limit = lines.length - target.length;
  for (let start = 0; start <= limit; start += 1) {
    let ok = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (normalizeLine(lines[start + offset]) !== target[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(start);
  }
  return matches;
}

function findExactLineOffsets(haystack, needle) {
  const lineNumbers = [];
  if (!needle) return lineNumbers;
  let from = 0;
  while (lineNumbers.length < 10) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    let line = 1;
    for (let i = 0; i < idx; i += 1) {
      if (haystack.charCodeAt(i) === 10) line += 1;
    }
    lineNumbers.push(line);
    from = idx + needle.length;
  }
  return lineNumbers;
}

function leadingIndent(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : '';
}

/** Re-indent replacement lines so they sit at the indentation of the match. */
function reindent(replace, matchIndent, searchIndent) {
  if (!replace || matchIndent === searchIndent) return replace;
  return replace
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      if (searchIndent && line.startsWith(searchIndent)) {
        return matchIndent + line.slice(searchIndent.length);
      }
      return matchIndent + line;
    })
    .join('\n');
}

/* ------------------------------- applyEdits ------------------------------- */

/**
 * Apply search/replace edits to `source`, preserving original BOM & EOL.
 * Returns { content, results, formatting, beforeHash, afterHash, diff, stats }.
 * Throws 409 (`patch_conflict`) on hash mismatch or 422 (`patch_failed`) when a
 * block is missing or ambiguous.
 */
export function applyEdits(source, edits, options = {}) {
  const { strict = false, expectedHash = '', path = 'file', maxContentChars = MAX_CONTENT_CHARS } = options || {};
  const rawSource = String(source ?? '');
  assertExpectedHash(rawSource, expectedHash, path);

  const formatting = detectFileFormatting(rawSource);
  const beforeHash = hashContent(rawSource);
  const validated = validateEdits(edits);
  const beforeNormalized = normalizeSource(rawSource);
  let content = beforeNormalized;
  const results = [];

  for (const edit of validated) {
    if (content.length > maxContentChars) {
      editError(edit.index, 'فایل بیش از حد بزرگ شد؛ عملیات متوقف شد.');
    }

    // 1. Creating or appending to a file.
    if (!edit.search) {
      content = content + edit.replace;
      results.push({ index: edit.index, strategy: 'append', replacedLines: countLines(edit.replace) });
      continue;
    }

    const hits = countOccurrences(content, edit.search);
    if (hits === 1) {
      content = content.replace(edit.search, () => edit.replace);
      results.push({ index: edit.index, strategy: 'exact', replacedLines: countLines(edit.replace) });
      continue;
    }
    if (hits > 1) {
      if (edit.replaceAll) {
        content = content.split(edit.search).join(edit.replace);
        results.push({ index: edit.index, strategy: 'exact-all', replacedLines: hits * countLines(edit.replace) });
        continue;
      }
      const linesAt = findExactLineOffsets(content, edit.search);
      editError(
        edit.index,
        `متن جست‌وجو ${hits} بار در فایل تکرار شده است (خطوط ${linesAt.join('، ')}). بخش بزرگ‌تری از کد را با زمینه‌ی یکتا انتخاب کنید.`,
        { hits, lines: linesAt }
      );
    }

    if (strict) {
      editError(
        edit.index,
        'تطبیق دقیق در حالت strict پیدا نشد (حدس زدن غیرفعال است). فایل را دوباره بخوانید و context دقیق بفرستید.',
        { strict: true }
      );
    }

    // 2. Fuzzy line-level match (indentation / trailing whitespace drift).
    const lines = content.split('\n');
    const searchLines = edit.search.split('\n');
    const matches = findFuzzyMatches(lines, searchLines);
    if (matches.length === 1) {
      const start = matches[0];
      const end = start + searchLines.length;
      const matchIndent = leadingIndent(lines[start] || '');
      const searchIndent = leadingIndent(searchLines[0] || '');
      const replacement = reindent(edit.replace, matchIndent, searchIndent);
      const replacementLines = replacement === '' ? [] : replacement.split('\n');
      const next = [...lines.slice(0, start), ...replacementLines, ...lines.slice(end)];
      content = next.join('\n');
      results.push({ index: edit.index, strategy: 'fuzzy', replacedLines: replacementLines.length, line: start + 1 });
      continue;
    }
    if (matches.length > 1) {
      const linesAt = matches.slice(0, 10).map((m) => m + 1);
      editError(
        edit.index,
        `با نادیده‌گرفتن فاصله‌ها، ${matches.length} جایگاه منطبق پیدا شد (خطوط ${linesAt.join('، ')})؛ زمینه‌ی یکتاتر بدهید.`,
        { hits: matches.length, lines: linesAt }
      );
    }
    editError(edit.index, 'متن جست‌وجو در فایل پیدا نشد. فایل را دوباره بخوانید و متن دقیق را بفرستید.');
  }

  const restored = restoreFileFormatting(content, formatting);
  if (restored.length > maxContentChars) {
    fail('محتوای نهایی فایل بیش از حد بزرگ است.', 413, 'too_large');
  }
  const diff = unifiedDiff(beforeNormalized, content, { path });
  const stats = diff ? diffSummary(diff.split('\n')) : { added: 0, removed: 0 };
  return {
    content: restored,
    results,
    formatting,
    beforeHash,
    afterHash: hashContent(restored),
    diff,
    stats
  };
}

/* ----------------------------- unified diff apply ------------------------- */

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/**
 * Parse a standard unified diff into validated hunks.
 * Rejects malformed headers or invalid hunk line prefixes without guessing.
 */
export function parseUnifiedDiff(diffText) {
  const normalized = normalizeSource(diffText);
  if (!normalized.trim()) {
    fail('متن diff خالی است.', 400, 'bad_patch');
  }
  const lines = normalized.split('\n');
  const hunks = [];
  let i = 0;

  // Skip optional git/diff file headers before first hunk.
  while (i < lines.length && !HUNK_HEADER_RE.test(lines[i])) {
    const line = lines[i];
    if (
      line === '' ||
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ')
    ) {
      i += 1;
      continue;
    }
    fail(`قالب unified diff نامعتبر است (خط ${i + 1}: "${line.slice(0, 80)}").`, 400, 'bad_patch');
  }

  while (i < lines.length) {
    const headerMatch = HUNK_HEADER_RE.exec(lines[i]);
    if (!headerMatch) {
      if (lines[i] === '') {
        i += 1;
        continue;
      }
      fail(`هدر hunk نامعتبر در خط ${i + 1} از diff.`, 400, 'bad_patch');
    }

    const oldStart = Number(headerMatch[1]);
    const oldCount = headerMatch[2] === undefined ? 1 : Number(headerMatch[2]);
    const newStart = Number(headerMatch[3]);
    const newCount = headerMatch[4] === undefined ? 1 : Number(headerMatch[4]);
    const header = lines[i];
    i += 1;

    const hunkLines = [];
    let actualOld = 0;
    let actualNew = 0;
    let noNewlineOld = false;
    let noNewlineNew = false;

    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i])) {
      const rawLine = lines[i];
      if (rawLine.startsWith('\\ No newline at end of file')) {
        const prev = hunkLines[hunkLines.length - 1];
        if (prev?.type === 'remove') noNewlineOld = true;
        else if (prev?.type === 'add') noNewlineNew = true;
        else {
          noNewlineOld = true;
          noNewlineNew = true;
        }
        i += 1;
        continue;
      }
      if (rawLine === '' && actualOld >= oldCount && actualNew >= newCount) {
        i += 1;
        break;
      }
      const prefix = rawLine[0];
      if (prefix === ' ') {
        hunkLines.push({ type: 'context', text: rawLine.slice(1) });
        actualOld += 1;
        actualNew += 1;
      } else if (prefix === '-') {
        hunkLines.push({ type: 'remove', text: rawLine.slice(1) });
        actualOld += 1;
      } else if (prefix === '+') {
        hunkLines.push({ type: 'add', text: rawLine.slice(1) });
        actualNew += 1;
      } else {
        fail(`خط نامعتبر در hunk (${header}) در خط ${i + 1} diff: باید با فاصله، + یا - شروع شود.`, 400, 'bad_patch');
      }
      i += 1;
    }

    if (actualOld !== oldCount || actualNew !== newCount) {
      fail(
        `تعداد خطوط در ${header} با بدنه diff همخوان نیست (انتظار -${oldCount}/+${newCount}، دریافت -${actualOld}/+${actualNew}).`,
        400,
        'bad_patch'
      );
    }
    hunks.push({ header, oldStart, oldCount, newStart, newCount, lines: hunkLines, noNewlineOld, noNewlineNew });
  }

  if (!hunks.length) {
    fail('هیچ hunk معتبری در diff پیدا نشد.', 400, 'bad_patch');
  }
  return hunks;
}

function linesEqualAt(fileLines, startIdx, expectedLines) {
  if (startIdx < 0 || startIdx + expectedLines.length > fileLines.length) return false;
  for (let k = 0; k < expectedLines.length; k += 1) {
    if (fileLines[startIdx + k] !== expectedLines[k]) return false;
  }
  return true;
}

/**
 * Apply a unified diff to `source` using strict context verification.
 * Never guesses when context is missing or matches more than one location.
 */
export function applyUnifiedDiff(source, diffText, options = {}) {
  const { expectedHash = '', path = 'file', maxContentChars = MAX_CONTENT_CHARS } = options || {};
  const rawSource = String(source ?? '');
  assertExpectedHash(rawSource, expectedHash, path);

  const formatting = detectFileFormatting(rawSource);
  const beforeHash = hashContent(rawSource);
  const hunks = parseUnifiedDiff(diffText);
  const beforeNormalized = normalizeSource(rawSource);
  const hadTrailingNewline = beforeNormalized.endsWith('\n');
  let fileLines = beforeNormalized === '' ? [] : (hadTrailingNewline ? beforeNormalized.slice(0, -1) : beforeNormalized).split('\n');

  let lineDelta = 0;
  let trailingNewline = hadTrailingNewline;
  const results = [];

  for (let hIdx = 0; hIdx < hunks.length; hIdx += 1) {
    const hunk = hunks[hIdx];
    const expectedOld = hunk.lines.filter((l) => l.type !== 'add').map((l) => l.text);
    const replacement = hunk.lines.filter((l) => l.type !== 'remove').map((l) => l.text);

    const targetStart = Math.max(0, hunk.oldStart - 1 + lineDelta);
    let applyIdx = -1;
    let strategy = 'unified-exact';

    if (expectedOld.length === 0) {
      // Pure insertion hunk (e.g. empty file or @@ -0,0 +1,N @@)
      applyIdx = hunk.oldStart === 0 ? 0 : Math.min(fileLines.length, targetStart);
    } else if (linesEqualAt(fileLines, targetStart, expectedOld)) {
      applyIdx = targetStart;
    } else {
      // Check if context matches uniquely elsewhere (line-number drift only, strict text match)
      const exactMatches = [];
      for (let pos = 0; pos <= fileLines.length - expectedOld.length; pos += 1) {
        if (linesEqualAt(fileLines, pos, expectedOld)) exactMatches.push(pos);
      }
      if (exactMatches.length === 1) {
        applyIdx = exactMatches[0];
        strategy = 'unified-relocated';
      } else if (exactMatches.length > 1) {
        fail(
          `تعارض در hunk #${hIdx + 1} (${hunk.header}) برای ${path}: context در ${exactMatches.length} محل مختلف پیدا شد (خطوط ${exactMatches.map((m) => m + 1).join('، ')}). بدون حدس‌زدن متوقف شد.`,
          409,
          'patch_conflict',
          { path, hunk: hunk.header, lines: exactMatches.map((m) => m + 1) }
        );
      } else {
        fail(
          `تعارض در hunk #${hIdx + 1} (${hunk.header}) برای ${path}: خطوط context در فایل فعلی منطبق نیستند. فایل احتمالاً تغییر کرده است؛ دوباره بخوانید.`,
          409,
          'patch_conflict',
          { path, hunk: hunk.header, expectedStart: hunk.oldStart }
        );
      }
    }

    fileLines = [
      ...fileLines.slice(0, applyIdx),
      ...replacement,
      ...fileLines.slice(applyIdx + expectedOld.length)
    ];
    lineDelta += replacement.length - expectedOld.length;

    if (hIdx === hunks.length - 1) {
      if (hunk.noNewlineNew) trailingNewline = false;
      else if (hunk.noNewlineOld && !hunk.noNewlineNew) trailingNewline = true;
    }

    results.push({
      index: hIdx,
      header: hunk.header,
      strategy,
      line: applyIdx + 1,
      removedLines: expectedOld.length,
      addedLines: replacement.length
    });
  }

  let afterNormalized = fileLines.join('\n');
  if (afterNormalized.length > 0 && trailingNewline) afterNormalized += '\n';

  const restored = restoreFileFormatting(afterNormalized, formatting);
  if (restored.length > maxContentChars) {
    fail('محتوای نهایی فایل بیش از حد بزرگ است.', 413, 'too_large');
  }
  const diff = unifiedDiff(beforeNormalized, afterNormalized, { path });
  const stats = diff ? diffSummary(diff.split('\n')) : { added: 0, removed: 0 };
  return {
    content: restored,
    results,
    hunksApplied: hunks.length,
    formatting,
    beforeHash,
    afterHash: hashContent(restored),
    diff,
    stats
  };
}

/* ------------------------ transactional multi-file ------------------------ */

/**
 * Apply single- or multi-file patches atomically.
 * All files are validated and patched in a staged buffer first; if any file
 * fails (missing, conflict, ambiguous, invalid diff, unchanged, oversized),
 * nothing is committed to `filesMap`.
 */
export function applyPatchTransaction(filesMap, operations, options = {}) {
  const { dryRun = false, strict = false, maxContentChars = MAX_CONTENT_CHARS } = options || {};
  if (!filesMap || typeof filesMap !== 'object') {
    fail('نقشه فایل‌های workspace نامعتبر است.', 400, 'bad_patch');
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    fail('حداقل یک عملیات پچ لازم است.', 400, 'bad_patch');
  }
  if (operations.length > MAX_FILES_PER_TRANSACTION) {
    fail(`حداکثر ${MAX_FILES_PER_TRANSACTION} فایل در یک تراکنش پچ مجاز است.`, 413, 'bad_patch');
  }

  const staged = {};
  const originalMap = {};
  const planned = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    if (!op || typeof op !== 'object') {
      fail(`عملیات شماره ${i + 1} نامعتبر است.`, 400, 'bad_patch', { failedIndex: i, rolledBack: true });
    }
    const path = String(op.path || '');
    if (!path) {
      fail(`عملیات شماره ${i + 1}: مسیر فایل مشخص نشده است.`, 400, 'bad_patch', { failedIndex: i, rolledBack: true });
    }
    const hasStaged = Object.prototype.hasOwnProperty.call(staged, path);
    if (!hasStaged && filesMap[path] === undefined) {
      fail(`فایل پیدا نشد: ${path}. کل تراکنش بدون تغییر لغو شد.`, 404, 'file_not_found', {
        failedIndex: i,
        failedPath: path,
        rolledBack: true
      });
    }
    const current = hasStaged ? staged[path] : String(filesMap[path]);
    if (!hasStaged) originalMap[path] = current;

    let outcome;
    try {
      const unifiedDiffText =
        typeof op.unifiedDiff === 'string' && op.unifiedDiff.trim()
          ? op.unifiedDiff
          : typeof op.diff === 'string' && op.diff.trim()
            ? op.diff
            : '';
      if (unifiedDiffText) {
        outcome = applyUnifiedDiff(current, unifiedDiffText, {
          path,
          expectedHash: op.expectedHash || '',
          maxContentChars
        });
      } else if (Array.isArray(op.edits) && op.edits.length > 0) {
        outcome = applyEdits(current, op.edits, {
          path,
          strict: op.strict !== undefined ? Boolean(op.strict) : strict,
          expectedHash: op.expectedHash || '',
          maxContentChars
        });
      } else {
        fail(`عملیات برای ${path} باید شامل edits یا diff معتبر باشد.`, 400, 'bad_patch');
      }
    } catch (error) {
      const code = error?.code || 'patch_failed';
      const status = error?.status || 422;
      fail(
        `تراکنش پچ در فایل ${path} متوقف و rollback شد: ${error?.message || 'خطا در اعمال پچ'}`,
        status,
        code,
        {
          ...(error?.extra || {}),
          failedIndex: i,
          failedPath: path,
          rolledBack: true
        }
      );
    }

    if (outcome.content === current) {
      fail(`پچ برای ${path} هیچ تغییری ایجاد نکرد؛ کل تراکنش لغو شد.`, 422, 'patch_noop', {
        failedIndex: i,
        failedPath: path,
        rolledBack: true
      });
    }

    staged[path] = outcome.content;
    totalAdded += outcome.stats.added;
    totalRemoved += outcome.stats.removed;
    planned.push({
      path,
      before: current,
      after: outcome.content,
      beforeHash: outcome.beforeHash,
      afterHash: outcome.afterHash,
      diff: outcome.diff,
      stats: outcome.stats,
      results: outcome.results,
      formatting: outcome.formatting
    });
  }

  // Merge multiple operations on the same file into final per-file summary while preserving order.
  const finalByPath = new Map();
  for (const entry of planned) {
    const origBefore = originalMap[entry.path];
    const diff = unifiedDiff(origBefore, entry.after, { path: entry.path });
    const stats = diff ? diffSummary(diff.split('\n')) : { added: 0, removed: 0 };
    const mergedResults = [...(finalByPath.get(entry.path)?.results || []), ...entry.results];
    finalByPath.set(entry.path, {
      path: entry.path,
      before: origBefore,
      after: entry.after,
      changed: entry.after !== origBefore,
      beforeHash: hashContent(origBefore),
      afterHash: entry.afterHash,
      diff,
      stats,
      results: mergedResults,
      blocks: mergedResults.length,
      strategies: mergedResults.map((r) => r.strategy || 'exact'),
      formatting: entry.formatting,
      eol: entry.formatting?.eol === '\r\n' ? 'CRLF' : entry.formatting?.eol === '\r' ? 'CR' : 'LF',
      hadBom: Boolean(entry.formatting?.hasBom)
    });
  }

  const finalFiles = [...finalByPath.values()];

  if (!dryRun) {
    const rollbackSnapshot = {};
    try {
      for (const f of finalFiles) {
        rollbackSnapshot[f.path] = filesMap[f.path];
        filesMap[f.path] = f.after;
      }
    } catch (err) {
      for (const [p, prev] of Object.entries(rollbackSnapshot)) {
        if (prev === undefined) delete filesMap[p];
        else filesMap[p] = prev;
      }
      fail(`خطا هنگام ثبت تغییرات؛ کل تراکنش rollback شد: ${err?.message || 'write_error'}`, 500, 'patch_rollback', {
        rolledBack: true
      });
    }
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    files: finalFiles,
    reports: finalFiles,
    totalAdded: finalFiles.reduce((s, f) => s + f.stats.added, 0),
    totalRemoved: finalFiles.reduce((s, f) => s + f.stats.removed, 0)
  };
}

export function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + needle.length;
    if (count > 1_000) break;
  }
  return count;
}

/* ------------------------------ unified diff ------------------------------ */

/**
 * Line diff with an LCS table. Inputs are capped so a pathological file cannot
 * blow up the request: beyond the cap we fall back to a coarse summary.
 */
export function diffLines(before, after) {
  const a = normalizeSource(before).split('\n');
  const b = normalizeSource(after).split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return coarseDiff(a, b);
  }

  // Trim common prefix / suffix first: huge speedup for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const ops = lcsDiff(midA, midB);

  /** @type {{type:'equal'|'add'|'remove', text:string}[]} */
  const result = [];
  for (let i = 0; i < start; i += 1) result.push({ type: 'equal', text: a[i] });
  for (const op of ops) result.push(op);
  for (let i = endA + 1; i < a.length; i += 1) result.push({ type: 'equal', text: a[i] });
  return result;
}

function coarseDiff(a, b) {
  const result = [];
  const maxPrefix = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= prefix && endB >= prefix && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  for (let i = 0; i < prefix; i += 1) result.push({ type: 'equal', text: a[i] });
  for (let i = prefix; i <= endA; i += 1) result.push({ type: 'remove', text: a[i] });
  for (let i = prefix; i <= endB; i += 1) result.push({ type: 'add', text: b[i] });
  for (let i = endA + 1; i < a.length; i += 1) result.push({ type: 'equal', text: a[i] });
  return result;
}

function lcsDiff(a, b) {
  // Keep DP well under Cloudflare Workers Free 10 ms CPU ceiling (<=120k cells => <0.35ms).
  const n = a.length;
  const m = b.length;
  if (n * m > 120_000) return coarseDiff(a, b);
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ type: 'remove', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', text: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return ops;
}

export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    if (op.type === 'remove') removed += 1;
  }
  return { added, removed };
}

/**
 * Render a unified diff with `context` lines around each change.
 * Hunk headers use 1-based line numbers like `git diff`.
 */
export function unifiedDiff(before, after, { path = 'file', context = 3 } = {}) {
  const ops = diffLines(before, after);
  if (!ops.some((op) => op.type !== 'equal')) return '';

  // Group into hunks.
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.type === 'equal') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) {
      keep[k] = 1;
    }
  });

  const out = [`--- a/${path}`, `+++ b/${path}`];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) {
      if (ops[index].type !== 'add') oldLine += 1;
      if (ops[index].type !== 'remove') newLine += 1;
      index += 1;
      continue;
    }
    const hunkStartOld = oldLine;
    const hunkStartNew = newLine;
    const body = [];
    while (index < ops.length && keep[index]) {
      const op = ops[index];
      if (op.type === 'equal') {
        body.push(` ${op.text}`);
        oldLine += 1;
        newLine += 1;
      } else if (op.type === 'remove') {
        body.push(`-${op.text}`);
        oldLine += 1;
      } else {
        body.push(`+${op.text}`);
        newLine += 1;
      }
      index += 1;
    }
    const oldCount = body.filter((line) => !line.startsWith('+')).length;
    const newCount = body.filter((line) => !line.startsWith('-')).length;
    out.push(`@@ -${hunkStartOld},${oldCount} +${hunkStartNew},${newCount} @@`);
    out.push(...body);
  }
  return out.join('\n');
}

/** Compact "3 files changed, +42 −7" summary. */
export function diffSummary(lines) {
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return { added, removed };
}

/** Cap diff text so a big rewrite cannot flood the chat or the model context. */
export function truncateDiff(diff, maxLines = 220) {
  if (!diff) return '';
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  const head = lines.slice(0, Math.floor(maxLines * 0.7));
  const tail = lines.slice(-Math.floor(maxLines * 0.3));
  return [...head, `… (${lines.length - maxLines} خط دیگر) …`, ...tail].join('\n');
}
