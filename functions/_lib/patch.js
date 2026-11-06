// Precise, validated file editing.
//
// Two things live here:
//   1. applyEdits()  — apply exact search/replace blocks to a file. Exact match
//      first; if that fails, a line-level fuzzy match that tolerates indentation
//      and trailing-whitespace drift. Ambiguous or absent matches are errors, so
//      the model can never silently rewrite the wrong block.
//   2. unifiedDiff() — a small, allocation-safe line diff used for the tool
//      result, the SSE stream, and the version history UI.
//
// Everything is pure (no I/O) which keeps it trivially testable.

import { fail } from './util.js';

const MAX_EDITS_PER_FILE = 60;
const MAX_SEARCH_CHARS = 120_000;
const MAX_CONTENT_CHARS = 900_000;
const MAX_DIFF_LINES = 12_000;

/** Normalize newlines and drop a UTF-8 BOM. */
export function normalizeSource(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/* --------------------------------- errors --------------------------------- */

function editError(index, message, extra = {}) {
  fail(`ویرایش شماره ${index + 1}: ${message}`, 422, 'patch_failed', extra);
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
 * Apply search/replace edits to `source`.
 * Returns { content, results: [{index, strategy, replacedLines}] }.
 * Throws a 422 HttpError when a block is missing or ambiguous.
 */
export function applyEdits(source, edits) {
  const validated = validateEdits(edits);
  let content = normalizeSource(source);
  const results = [];

  for (const edit of validated) {
    if (content.length > MAX_CONTENT_CHARS) {
      editError(edit.index, 'فایل بیش از حد بزرگ شد؛ عملیات متوقف شد.');
    }

    // 1. Creating or emptying a file.
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
      editError(
        edit.index,
        `متن جست‌وجو ${hits} بار در فایل تکرار شده است. بخش بزرگ‌تری از کد را با زمینه‌ی یکتا انتخاب کنید.`
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
      results.push({ index: edit.index, strategy: 'fuzzy', replacedLines: replacementLines.length });
      continue;
    }
    if (matches.length > 1) {
      editError(
        edit.index,
        `با نادیده‌گرفتن فاصله‌ها، ${matches.length} جایگاه منطبق پیدا شد؛ زمینه‌ی یکنواتر بدهید.`
      );
    }
    editError(edit.index, 'متن جست‌وجو در فایل پیدا نشد. فایل را دوباره بخوانید و متن دقیق را بفرستید.');
  }

  if (content.length > MAX_CONTENT_CHARS) {
    fail('محتوای نهایی فایل بیش از حد بزرگ است.', 413, 'too_large');
  }
  return { content, results };
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
