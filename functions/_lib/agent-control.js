// Per-turn execution governor: prevents tool thrash / agentic livelock without
// replacing the model loop. It is deterministic, in-memory, and scoped to one
// fenced turn. It never persists workspace content and never blocks a genuine
// new read after a mutation.

const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_code', 'list_symbols', 'file_history']);
const MUTATING_TOOLS = new Set(['write_file', 'apply_patch', 'delete_file', 'undo_edit']);
const EXTERNAL_TOOLS = new Set(['web_search', 'fetch_url', 'run_command', 'generate_image']);
const MAX_RANGED_LINES = 360;

const STAMINA_READ_BUDGET = {
  low: 4,
  medium: 6,
  hard: 8,
  'very-hard': 10,
  max: 12,
  'ultra-code': 16
};

const STAMINA_THINK_BUDGET = {
  low: 1,
  medium: 2,
  hard: 2,
  'very-hard': 3,
  max: 3,
  'ultra-code': 4
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function fingerprintContent(text) {
  // FNV-1a 32-bit + length. Collision-resistant enough for a single turn's
  // duplicate ledger; never used for security or persistence.
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

function toolSignature(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'read_file':
      return `read:${a.path || ''}:${a.startLine || ''}:${a.endLine || ''}:${String(a.query || '').trim()}`;
    case 'search_code':
      return `search:${String(a.query || '').trim()}:${Boolean(a.regex)}:${Boolean(a.caseSensitive)}:${a.pathFilter || ''}`;
    case 'list_symbols':
      return `symbols:${String(a.query || '').trim()}`;
    case 'list_files':
      return 'list_files';
    case 'file_history':
      return `history:${a.path || ''}:${a.limit || ''}`;
    case 'web_search':
      return `web:${String(a.query || '').trim()}:${a.limit || ''}`;
    case 'fetch_url':
      return `fetch:${String(a.method || 'GET').toUpperCase()}:${a.url || ''}:${fingerprintContent(stableStringify(a.headers || {}))}:${fingerprintContent(String(a.body || ''))}`;
    case 'run_command':
      return `cmd:${String(a.command || '').trim()}`;
    case 'think':
      return `think:${fingerprintContent(String(a.thought || ''))}:${fingerprintContent(String(a.plan || ''))}`;
    default:
      return `${name}:${fingerprintContent(stableStringify(a))}`;
  }
}

function normalizeRange(startLine, endLine, totalLines) {
  const total = Math.max(1, Number(totalLines) || 1);
  const start = Math.max(1, Math.min(total, Math.floor(Number(startLine) || 1)));
  const fallbackEnd = Math.min(total, start + MAX_RANGED_LINES - 1);
  const end = Math.max(start, Math.min(total, Math.floor(Number(endLine) || fallbackEnd)));
  return [start, end];
}

function mergeRanges(ranges) {
  const sorted = (ranges || [])
    .filter((r) => Array.isArray(r) && r.length === 2)
    .map(([a, b]) => [Math.max(1, Math.floor(a)), Math.max(1, Math.floor(b))])
    .filter(([a, b]) => b >= a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractRanges(covered, start, end) {
  const missing = [];
  let cursor = start;
  for (const [a, b] of mergeRanges(covered)) {
    if (b < cursor) continue;
    if (a > end) break;
    if (a > cursor) missing.push([cursor, Math.min(end, a - 1)]);
    cursor = Math.max(cursor, b + 1);
    if (cursor > end) break;
  }
  if (cursor <= end) missing.push([cursor, end]);
  return missing.filter(([a, b]) => b >= a);
}

function fullyCovered(ranges, start, end) {
  return subtractRanges(ranges, start, end).length === 0;
}

export function createAgentControl({ powerProfile = {}, maxSteps = 20, originalGoal = '', marathonActive = false } = {}) {
  const stamina = powerProfile.workStamina || 'medium';
  const maxReadsPerFile = STAMINA_READ_BUDGET[stamina] || STAMINA_READ_BUDGET.medium;
  const maxThinkCalls = STAMINA_THINK_BUDGET[stamina] || STAMINA_THINK_BUDGET.medium;
  const noProgressLimit = marathonActive ? 3 : 2;

  const state = {
    revision: 0,
    step: 0,
    stepProgress: false,
    consecutiveNoProgress: 0,
    toolCalls: 0,
    executedCalls: 0,
    duplicatesSuppressed: 0,
    coveredReadsSuppressed: 0,
    adjustedReads: 0,
    thinkCalls: 0,
    thinkSuppressed: 0,
    readCallsByFile: new Map(),
    coverageByFile: new Map(),
    seen: new Map(),
    failedMutations: new Map(),
    progressEvents: 0,
    controlStop: null,
    originalGoal: String(originalGoal || '').slice(0, 600)
  };

  function seenKey(name, args) {
    return `${state.revision}:${toolSignature(name, args)}`;
  }

  function suppress(reason, text, extra = {}) {
    state.duplicatesSuppressed += 1;
    return { suppress: true, ok: true, reason, text, ...extra };
  }

  function invalidateWorkspace() {
    state.revision += 1;
    state.coverageByFile.clear();
    state.readCallsByFile.clear();
    state.seen.clear();
    state.failedMutations.clear();
  }

  function beforeTool(name, args = {}, context = {}) {
    const step = Number(context.step) || state.step;
    const workspace = context.workspace || null;
    state.toolCalls += 1;
    const sig = toolSignature(name, args);
    const key = seenKey(name, args);

    if (name === 'think') {
      if (state.seen.has(key)) {
        state.thinkSuppressed += 1;
        return suppress('duplicate_think', '[Duplicate think suppressed: this exact thought/plan was already recorded. Move to a concrete read, edit, verification, or final answer.]');
      }
      if (state.thinkCalls >= maxThinkCalls) {
        state.thinkSuppressed += 1;
        return suppress('think_budget', `[Think budget reached (${maxThinkCalls} for this turn). Do not keep deliberating in circles; use the evidence already collected to make the targeted edit, verify it, or finish with the blocker.]`);
      }
      return { suppress: false };
    }

    if (READ_ONLY_TOOLS.has(name)) {
      if (state.seen.has(key)) {
        const prior = state.seen.get(key);
        return suppress('duplicate_read', `[Duplicate ${name} suppressed: identical output was already returned at step ${prior.step} and the workspace has not changed since. Use the earlier result, request a genuinely different range/query, or act on the evidence.]`, { cachedStep: prior.step });
      }
      if (name === 'read_file' && args.path) {
        const path = String(args.path);
        const reads = state.readCallsByFile.get(path) || 0;
        if (reads >= maxReadsPerFile) {
          return suppress('read_budget', `[Read budget reached for ${path}: ${reads} reads this turn without an intervening edit. Stop re-scanning; use search_code/list_symbols for a new question, make the targeted edit, or report the exact blocker.]`);
        }
        if ((args.startLine || args.endLine) && !args.query) {
          const coverage = state.coverageByFile.get(path);
          const current = workspace?.files?.[path];
          const currentHash = typeof current === 'string' ? fingerprintContent(current) : null;
          if (coverage?.revision === state.revision && (!coverage.hash || !currentHash || coverage.hash === currentHash)) {
            const [start, end] = normalizeRange(args.startLine, args.endLine, coverage.totalLines);
            const missing = subtractRanges(coverage.ranges, start, end);
            if (!missing.length) {
              state.coveredReadsSuppressed += 1;
              return suppress('covered_read', `[Covered read_file suppressed: lines ${start}-${end} of ${path} were already returned in this turn and the file has not changed. Use the earlier excerpt or edit it; do not re-read the same range.]`);
            }
            if (missing.length !== 1 || missing[0][0] !== start || missing[0][1] !== end) {
              state.adjustedReads += 1;
              return {
                suppress: false,
                adjusted: true,
                args: { ...args, startLine: missing[0][0], endLine: missing[0][1] },
                skippedRanges: mergeRanges(coverage.ranges).filter(([a, b]) => a <= end && b >= start)
              };
            }
          }
        }
      }
      return { suppress: false };
    }

    if (MUTATING_TOOLS.has(name)) {
      const failedKey = `${state.revision}:${sig}`;
      if (state.failedMutations.has(failedKey)) {
        return suppress('repeat_failed_mutation', `[Repeated identical ${name} suppressed: this exact edit already failed against the current file. Change the search/replace target using the failure context, or report the blocker instead of retrying unchanged.]`);
      }
      if (state.seen.has(key)) {
        const prior = state.seen.get(key);
        return suppress('duplicate_mutation', `[Duplicate ${name} suppressed: identical arguments already ran at step ${prior.step}. If the file still needs work, use a different target or verify the current state.]`);
      }
      return { suppress: false };
    }

    if (name === 'web_search' || (name === 'fetch_url' && String(args.method || 'GET').toUpperCase() === 'GET')) {
      if (state.seen.has(key)) {
        const prior = state.seen.get(key);
        return suppress('duplicate_external', `[Duplicate ${name} suppressed: identical request already ran at step ${prior.step}. Reuse that result or ask a different question.]`);
      }
    }

    return { suppress: false };
  }

  function afterTool(name, args = {}, outcome = {}, step = state.step, { workspaceChanged = false } = {}) {
    const ok = Boolean(outcome.ok);
    const sig = toolSignature(name, args);
    const key = seenKey(name, args);
    let progress = false;
    let reason = 'no_progress';

    if (ok && !outcome.controlled) {
      state.executedCalls += 1;
      if (MUTATING_TOOLS.has(name)) {
        invalidateWorkspace();
        progress = true;
        reason = 'mutation';
      } else if (name === 'run_command') {
        if (workspaceChanged || outcome.workspaceChanged) {
          invalidateWorkspace();
          progress = true;
          reason = 'shell_mutation';
        } else if (!state.seen.has(key)) {
          progress = true;
          reason = 'verification';
        }
      } else if (name === 'read_file') {
        const path = String(args.path || '');
        state.readCallsByFile.set(path, (state.readCallsByFile.get(path) || 0) + 1);
        const meta = outcome.meta || {};
        const ranges = Array.isArray(meta.ranges) ? meta.ranges : [];
        if (path && ranges.length) {
          const prev = state.coverageByFile.get(path);
          const base = prev?.revision === state.revision ? prev : { revision: state.revision, totalLines: meta.totalLines || 1, ranges: [], hash: meta.hash || null };
          base.totalLines = Math.max(base.totalLines || 1, Number(meta.totalLines) || 1);
          base.hash = meta.hash || base.hash || null;
          base.ranges = mergeRanges([...base.ranges, ...ranges]);
          state.coverageByFile.set(path, base);
        }
        progress = true;
        reason = 'new_read';
      } else if (READ_ONLY_TOOLS.has(name) || EXTERNAL_TOOLS.has(name)) {
        progress = true;
        reason = name === 'generate_image' ? 'artifact' : 'new_evidence';
      } else if (name === 'think') {
        state.thinkCalls += 1;
        progress = false;
        reason = 'meta_work';
      }
    } else if (!ok && MUTATING_TOOLS.has(name)) {
      state.failedMutations.set(`${state.revision}:${sig}`, step);
    }

    if (ok && !outcome.controlled) {
      state.seen.set(key, { step, ok });
    }
    if (progress) {
      state.progressEvents += 1;
      state.stepProgress = true;
    }
    return { progress, reason };
  }

  function beginStep(step) {
    state.step = step;
    state.stepProgress = false;
  }

  function endStep(step) {
    state.step = step;
    if (state.stepProgress) {
      state.consecutiveNoProgress = 0;
    } else {
      state.consecutiveNoProgress += 1;
    }
    if (!state.controlStop && state.consecutiveNoProgress >= noProgressLimit) {
      state.controlStop = {
        reason: 'no_progress',
        step,
        consecutiveNoProgress: state.consecutiveNoProgress,
        duplicatesSuppressed: state.duplicatesSuppressed,
        thinkSuppressed: state.thinkSuppressed
      };
    }
    return {
      progress: state.stepProgress,
      consecutiveNoProgress: state.consecutiveNoProgress,
      stopReason: state.controlStop?.reason || null,
      controlStop: state.controlStop
    };
  }

  function snapshot() {
    return {
      revision: state.revision,
      toolCalls: state.toolCalls,
      executedCalls: state.executedCalls,
      duplicatesSuppressed: state.duplicatesSuppressed,
      coveredReadsSuppressed: state.coveredReadsSuppressed,
      adjustedReads: state.adjustedReads,
      thinkCalls: state.thinkCalls,
      thinkSuppressed: state.thinkSuppressed,
      progressEvents: state.progressEvents,
      consecutiveNoProgress: state.consecutiveNoProgress,
      controlStop: state.controlStop,
      readsByFile: Object.fromEntries(state.readCallsByFile),
      coverageByFile: Object.fromEntries(
        [...state.coverageByFile.entries()].map(([p, c]) => [p, { totalLines: c.totalLines, ranges: c.ranges, hash: c.hash }])
      ),
      maxReadsPerFile,
      maxThinkCalls,
      noProgressLimit
    };
  }

  return { beforeTool, afterTool, beginStep, endStep, snapshot, invalidateWorkspace };
}

export function buildControlStopMessage(controlStop, { touchedFiles = [], deletedFiles = [] } = {}) {
  const changed = [...new Set([...(touchedFiles || []), ...(deletedFiles || [])])].filter((p) => p && !p.startsWith('('));
  const lines = [];
  lines.push('⏹ اجرای خودکار را متوقف کردم چون چند گام پیاپی پیشرفت تازه‌ای نداشتند (تکرار ابزار، فکرکردن بدون اقدام، یا ویرایش بی‌نتیجه).');
  lines.push('این توقف برای جلوگیری از مصرف بی‌نتیجهٔ درخواست‌ها و سهمیه است؛ خطای سرور نیست.');
  if (changed.length) {
    lines.push(`تغییرات ذخیره‌شده تا این نقطه: ${changed.slice(0, 12).map((p) => `\`${p}\``).join('، ')}${changed.length > 12 ? ' و چند فایل دیگر' : ''}.`);
  } else {
    lines.push('هیچ فایل جدیدی در این گام‌ها تغییر نکرد.');
  }
  if (controlStop?.duplicatesSuppressed) {
    lines.push(`${controlStop.duplicatesSuppressed} فراخوانی تکراری/بی‌اثر مهار شد.`);
  }
  lines.push('برای ادامه، دقیقاً بگو کدام فایل/بخش را تغییر دهم، چه خطایی را بررسی کنم، یا چه معیار پایانی مدنظرت است.');
  return lines.join('\n\n');
}
