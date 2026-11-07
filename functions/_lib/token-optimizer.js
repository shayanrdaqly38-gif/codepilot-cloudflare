// Hyper-Efficiency & Precision Token Engine v2 for CodePilot:
//   1. 100% Append-Only Prefix KV-Cache Preservation (never mutates mid-turn history unless emergency >140k ceiling)
//   2. Fixed Turn-Anchor Prompt Cache Breakpoints on OpenRouter Claude/Gemini (writes cache ONCE on Step 1; 90% cache read on Steps 2..N)
//   3. Zero-Extra-Roundtrip File Reader (full verbatim read up to 24KB with raw un-prefixed lines so `apply_patch` never fails or re-reads)
//   4. Clean Raw-Line 1-Shot `apply_patch` Failure Recovery (exact copy-paste lines without tab/line-number corruption)
//   5. Zero-Roundtrip `@filepath` / `@filepath:start-end` Pre-Pinning
//   6. Adaptive Per-Step Reasoning Effort (100% full power on Step 1 & errors; smart step-down on routine/closing steps)

export const VALID_TOKEN_SAVER_MODES = ['off', 'balanced', 'max'];

const FULL_READ_CHAR_LIMIT = 24_000;
const HUGE_HEAD_CHAR_BUDGET = 16_000;
const MAX_RANGED_LINES = 400;
const LANDMARK_CAP = 60;

const STRUCTURAL_PATTERNS = [
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*case\s+['"`]([^'"`]{1,60})['"`]\s*:/,
  /^\s*<(style|script|header|main|nav|aside|footer)\b[^>]*>/i,
  /^\s*<\/(style|script)>/i,
  /<(?:div|section|aside|nav|dialog)\b[^>]*\bid=["']([^"']{2,60})["'][^>]*>/i,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  /^\s*(@media\b[^{]{1,80})\{/,
  /^\s*(#{1,3}\s+.{2,80})$/
];

function extractStructuralOutline(lines, fromLineIdx = 0, maxItems = LANDMARK_CAP) {
  const hits = [];
  for (let i = Math.max(0, fromLineIdx); i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw || raw.length > 260) continue;
    for (const rx of STRUCTURAL_PATTERNS) {
      if (rx.test(raw)) {
        hits.push({ line: i + 1, text: raw.trim().slice(0, 110) });
        break;
      }
    }
  }
  if (hits.length <= maxItems) return hits;
  const sampled = [];
  const step = (hits.length - 1) / (maxItems - 1);
  let lastIdx = -1;
  for (let k = 0; k < maxItems; k += 1) {
    const idx = Math.round(k * step);
    if (idx !== lastIdx && hits[idx]) {
      sampled.push(hits[idx]);
      lastIdx = idx;
    }
  }
  return sampled;
}

/**
 * Zero-Extra-Roundtrip File Reader:
 * - Files <= 24,000 chars (~95% of all source files): returned 100% verbatim in ONE shot with ZERO extra round-trips!
 * - Explicit `startLine`/`endLine`: returns 100% CLEAN RAW LINES (never prepends `lineNum\t` so `apply_patch` matches on first try!).
 * - Truly giant files (> 24,000 chars, e.g. 445KB `index.html`) read without line range: returns first ~16,000 chars of clean raw lines
 *   PLUS a Structural Landmark Map of the remaining lines so the model has exact line numbers without blind truncation!
 */
export function buildSmartFileRead(path, rawContent, { startLine, endLine, tokenSaver = 'max' } = {}) {
  const content = String(rawContent ?? '');
  const hasRange = Number.isFinite(Number(startLine)) || Number.isFinite(Number(endLine));

  if (hasRange) {
    const lines = content.split('\n');
    const from = Math.max(0, (Number.isFinite(Number(startLine)) ? Math.floor(Number(startLine)) : 1) - 1);
    const requestedTo = Number.isFinite(Number(endLine)) ? Math.floor(Number(endLine)) : from + MAX_RANGED_LINES;
    const cappedTo = Math.min(lines.length, Math.max(from + 1, Math.min(requestedTo, from + MAX_RANGED_LINES)));
    const slice = lines.slice(from, cappedTo).join('\n');
    const moreHint =
      cappedTo < Math.min(lines.length, requestedTo) || (!Number.isFinite(Number(endLine)) && cappedTo < lines.length)
        ? `\n[Showing lines ${from + 1}-${cappedTo} of ${lines.length}. Pass startLine: ${cappedTo + 1}, endLine: ${Math.min(lines.length, cappedTo + MAX_RANGED_LINES)} if needed.]`
        : '';
    const text = `Lines ${from + 1}-${cappedTo} of ${lines.length} in ${path}:\n${slice}${moreHint}`;
    const savedChars = Math.max(0, content.length - text.length);
    return { text, savedChars, mode: 'ranged' };
  }

  if (tokenSaver === 'off' || content.length <= FULL_READ_CHAR_LIMIT) {
    return { text: content, savedChars: 0, mode: 'full' };
  }

  const lines = content.split('\n');
  let headEndIdx = 0;
  let usedHeadChars = 0;
  while (headEndIdx < lines.length && usedHeadChars + lines[headEndIdx].length + 1 <= HUGE_HEAD_CHAR_BUDGET) {
    usedHeadChars += lines[headEndIdx].length + 1;
    headEndIdx += 1;
  }
  if (headEndIdx === 0) headEndIdx = 1;

  const outline = extractStructuralOutline(lines, 0, LANDMARK_CAP);
  const sections = [
    `[Smart Structural Map of ${path} — ${lines.length} lines (${content.length} chars). Lines 1-${headEndIdx} shown verbatim below; pass startLine/endLine to read_file for deeper sections.]`,
    `Lines 1-${headEndIdx} of ${lines.length} in ${path}:`,
    lines.slice(0, headEndIdx).join('\n')
  ];

  if (outline.length) {
    sections.push(
      '',
      `--- Structural Landmarks Across Entire File (${outline.length} anchors) ---`,
      outline.map((h) => `L${h.line}: ${h.text}`).join('\n')
    );
  }

  const text = sections.join('\n');
  const savedChars = Math.max(0, content.length - text.length);
  return { text, savedChars, mode: 'outline' };
}

/**
 * 1-Shot `apply_patch` Failure Recovery:
 * Returns CLEAN, UNMODIFIED raw lines (no `lineNum\t` prefix!) around the fuzzy match
 * so the model copies the exact string into `search` and succeeds immediately without extra `read_file` calls.
 */
export function buildPatchFailureContext(path, fileContent, edits, errorMessage) {
  const baseMsg = `Patch rejected: ${errorMessage}`;
  if (!fileContent || !Array.isArray(edits) || !edits.length) return baseMsg;

  const fileLines = String(fileContent).split('\n');
  const snippets = [];

  for (const edit of edits.slice(0, 2)) {
    const searchRaw = typeof edit?.search === 'string' ? edit.search : '';
    if (!searchRaw.trim()) continue;
    const candidateLines = searchRaw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 6 && !/^[{};()[\]]+$/.test(l));
    if (!candidateLines.length) continue;

    const sorted = [...candidateLines].sort((a, b) => b.length - a.length);
    const anchor = sorted[0];
    const anchorTokens = (anchor.match(/[A-Za-z_$][\w$]{2,}/g) || []).slice(0, 8);

    const matchedLineNums = [];
    for (let i = 0; i < fileLines.length; i += 1) {
      const fl = fileLines[i].trim();
      if (!fl) continue;
      if (fl.includes(anchor) || (anchor.includes(fl) && fl.length >= 12)) {
        matchedLineNums.push(i);
        if (matchedLineNums.length >= 1) break;
      }
    }

    if (!matchedLineNums.length && anchorTokens.length >= 2) {
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < fileLines.length; i += 1) {
        const fl = fileLines[i];
        let score = 0;
        for (const tok of anchorTokens) {
          if (fl.includes(tok)) score += 1;
        }
        if (score > bestScore && score >= 2) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) matchedLineNums.push(bestIdx);
    }

    for (const center of matchedLineNums.slice(0, 1)) {
      const from = Math.max(0, center - 6);
      const to = Math.min(fileLines.length, center + 10);
      snippets.push(
        `--- Exact raw lines ${from + 1}-${to} in ${path} (copy verbatim into search) ---\n${fileLines.slice(from, to).join('\n')}`
      );
    }
  }

  if (!snippets.length) return baseMsg;
  return `${baseMsg}\n\n[Auto-Context Recovery — retry apply_patch directly using these exact raw lines without calling read_file]:\n${snippets.join('\n').slice(0, 2200)}`;
}

const MUTATING_TOOL_NAMES = new Set(['write_file', 'apply_patch', 'delete_file', 'undo_edit']);

function safeParseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/**
 * Emergency-Only Epoch Wire Pruner:
 * CRITICAL CACHE RULE: During normal multi-step turns (< 140k chars), NEVER mutate earlier messages in `wireMessages`!
 * Mutating middle messages breaks Prefix KV-Caching across steps and causes the entire prompt to be re-billed at 100% price.
 * This function runs ONLY when `force === true` or total wire chars cross `emergencyThresholdChars` (default 140,000) to prevent HTTP 413.
 */
export function pruneInTurnWireMessages(
  wireMessages,
  { tokenSaver = 'max', force = false, emergencyThresholdChars = 140_000 } = {}
) {
  if (tokenSaver === 'off' || !Array.isArray(wireMessages) || wireMessages.length < 5) {
    return { messages: wireMessages, savedChars: 0 };
  }

  if (!force) {
    let totalChars = 0;
    for (const m of wireMessages) {
      if (!m) continue;
      if (typeof m.content === 'string') totalChars += m.content.length;
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) totalChars += (tc?.function?.arguments?.length || 0) + 24;
      }
    }
    if (totalChars < emergencyThresholdChars) {
      return { messages: wireMessages, savedChars: 0 };
    }
  }

  const groups = [];
  for (let i = 0; i < wireMessages.length; i += 1) {
    const m = wireMessages[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const toolIndices = [];
      let j = i + 1;
      while (j < wireMessages.length && wireMessages[j]?.role === 'tool') {
        toolIndices.push(j);
        j += 1;
      }
      groups.push({ assistantIdx: i, toolIndices });
      i = j - 1;
    }
  }

  if (groups.length < 2) {
    return { messages: wireMessages, savedChars: 0 };
  }

  const out = wireMessages.slice();
  let savedChars = 0;
  const mutatedLater = new Set();
  const seenSignaturesLater = new Set();

  for (let gIdx = groups.length - 1; gIdx >= 0; gIdx -= 1) {
    const grp = groups[gIdx];
    const aMsg = out[grp.assistantIdx];
    const toolByCallId = new Map();
    for (const ti of grp.toolIndices) {
      const tm = out[ti];
      if (tm?.tool_call_id) toolByCallId.set(tm.tool_call_id, { idx: ti, msg: tm });
    }
    const isLatestGroup = gIdx === groups.length - 1;

    for (const call of aMsg.tool_calls || []) {
      const name = call?.function?.name || '';
      const args = safeParseJson(call?.function?.arguments);
      const tEntry = toolByCallId.get(call.id);
      const tContent = String(tEntry?.msg?.content || '');
      const failed = /^(Error:|Patch rejected:|Validation:.*error)/i.test(tContent);

      if (!isLatestGroup && tEntry && tContent.length > 260 && !tContent.startsWith('[Stale ') && !tContent.startsWith('[Duplicate ')) {
        if (name === 'read_file' && args.path && mutatedLater.has(String(args.path))) {
          const replacement = `[Stale read_file(${args.path}) superseded by a later edit in this turn (${tContent.length} chars freed).]`;
          savedChars += Math.max(0, tContent.length - replacement.length);
          out[tEntry.idx] = { ...tEntry.msg, content: replacement };
        } else if (name === 'read_file' || name === 'list_files' || name === 'list_symbols') {
          const sig =
            name === 'read_file'
              ? `read:${args.path || ''}:${args.startLine || ''}:${args.endLine || ''}`
              : name === 'list_symbols'
                ? `sym:${args.query || ''}`
                : 'list_files';
          if (seenSignaturesLater.has(sig)) {
            const replacement = `[Duplicate ${name} output identical to a newer step (${tContent.length} chars deduplicated).]`;
            savedChars += Math.max(0, tContent.length - replacement.length);
            out[tEntry.idx] = { ...tEntry.msg, content: replacement };
          }
        }
      }

      if (MUTATING_TOOL_NAMES.has(name) && args.path && !failed) {
        mutatedLater.add(String(args.path));
      }
      if (!failed && (name === 'read_file' || name === 'list_files' || name === 'list_symbols')) {
        const sig =
          name === 'read_file'
            ? `read:${args.path || ''}:${args.startLine || ''}:${args.endLine || ''}`
            : name === 'list_symbols'
              ? `sym:${args.query || ''}`
              : 'list_files';
        seenSignaturesLater.add(sig);
      }
    }
  }

  return { messages: out, savedChars };
}

/**
 * Zero-Roundtrip `@filepath` / `@filepath:start-end` Pre-Pinner:
 * Injects explicitly @-mentioned workspace files on Step 1 so the model skips an extra `read_file` round-trip.
 */
export function extractMentionedFileContext(userText, workspaceFiles, { tokenSaver = 'max' } = {}) {
  if (tokenSaver === 'off' || typeof userText !== 'string' || !workspaceFiles || typeof workspaceFiles !== 'object') {
    return { block: '', paths: [], savedRoundtripChars: 0 };
  }
  const regex = /(?:^|[\s(«"'`])@([A-Za-z0-9_./-]+)(?::(\d+)(?:-(\d+))?)?/g;
  const seen = new Set();
  const blocks = [];
  const paths = [];
  let totalChars = 0;
  const MAX_PREPIN_CHARS = 12_000;

  let match;
  while ((match = regex.exec(userText)) !== null) {
    const rawCandidate = match[1].replace(/[.,;]+$/, '');
    const filePath = workspaceFiles[rawCandidate] !== undefined ? rawCandidate : match[1];
    if (!filePath || seen.has(filePath) || workspaceFiles[filePath] === undefined) continue;
    seen.add(filePath);
    const startLine = match[2] ? Number(match[2]) : undefined;
    const endLine = match[3] ? Number(match[3]) : startLine ? startLine + 100 : undefined;

    const smart = buildSmartFileRead(filePath, workspaceFiles[filePath], {
      startLine,
      endLine,
      tokenSaver: 'max'
    });
    if (totalChars + smart.text.length > MAX_PREPIN_CHARS) break;
    totalChars += smart.text.length;
    paths.push(filePath);
    blocks.push(`<referenced_file path="${filePath}">\n${smart.text}\n</referenced_file>`);
    if (paths.length >= 3) break;
  }

  if (!blocks.length) return { block: '', paths: [], savedRoundtripChars: 0 };
  return {
    block: `\n\n[فایل‌های اشاره‌شده با @ — بدون نیاز به فراخوانی مجدد read_file]:\n${blocks.join('\n\n')}`,
    paths,
    savedRoundtripChars: 3_600 * paths.length
  };
}

/**
 * Adaptive Per-Step Reasoning Effort:
 * - Preserves 100% full `baseEffort` on Step 1 (architecture & planning) and on ANY error / patch-rejection / validation-failure / auto-repair!
 * - Steps down excessive spin on purely mechanical steps or clean closing confirmations.
 */
export function resolveAdaptiveStepEffort({
  baseEffort,
  step = 1,
  lastStepInfo = null,
  isAutoRepair = false,
  tokenSaver = 'max',
  supportedLevels = []
}) {
  if (!baseEffort || baseEffort === 'none' || tokenSaver === 'off') {
    return baseEffort;
  }
  const levels = Array.isArray(supportedLevels) ? supportedLevels : [];

  if (isAutoRepair || lastStepInfo?.hadError || lastStepInfo?.hadValidationError) {
    if (baseEffort === 'low' && levels.includes('medium')) return 'medium';
    return baseEffort;
  }

  if (step <= 1 || !lastStepInfo) {
    return baseEffort;
  }

  const pickSupported = (preferred) => {
    for (const candidate of preferred) {
      if (!levels.length || levels.includes(candidate)) return candidate;
    }
    return baseEffort;
  };

  const highTiers = new Set(['high', 'xhigh', 'max']);
  if (!highTiers.has(baseEffort)) {
    return baseEffort;
  }

  if (lastStepInfo.onlyListing) {
    return tokenSaver === 'max'
      ? pickSupported(['low', 'minimal', 'medium'])
      : pickSupported(['medium', 'low']);
  }

  if (lastStepInfo.justVerifiedClean) {
    return tokenSaver === 'max'
      ? pickSupported(['low', 'medium'])
      : pickSupported(['medium']);
  }

  // On clean intermediate read/search steps, step down ultra-expensive `max`/`xhigh` by 1 notch to `high`
  if (tokenSaver === 'max' && (baseEffort === 'max' || baseEffort === 'xhigh')) {
    return pickSupported(['high', baseEffort]);
  }

  return baseEffort;
}

/**
 * FIXED-ANCHOR Prompt Cache Breakpoints for Anthropic Claude & Google Gemini on OpenRouter:
 * - NEVER uses a moving `messages.length - 3` index (which strips `cache_control` on the next step, invalidating the cache and charging +25% cache-write on every step!).
 * - Instead anchors strictly on:
 *   1) Last `tools` schema
 *   2) `messages[0]` (`system` prompt, if >= 1200 chars)
 *   3) The FIXED User Turn Anchor (`anchorUserIdx`) — constant across ALL tool steps 1..N of a turn!
 */
export function applyPromptCacheBreakpoints(messages, tools, { baseUrl = '', model = '', tokenSaver = 'max' } = {}) {
  if (
    tokenSaver === 'off' ||
    !Array.isArray(messages) ||
    !messages.length ||
    !/openrouter\.ai/i.test(String(baseUrl || '')) ||
    !/(?:^|\/)(?:anthropic|google|claude|gemini)/i.test(String(model || ''))
  ) {
    return { messages, tools, injected: false };
  }

  const nextMessages = messages.map((m) => ({ ...m }));
  let breakpointsUsed = 0;

  // Breakpoint 1: Last tool schema (sits at very start of prompt prefix)
  let nextTools = tools;
  if (Array.isArray(tools) && tools.length > 0) {
    nextTools = tools.map((t, idx) =>
      idx === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
    );
    breakpointsUsed += 1;
  }

  // Breakpoint 2: System prompt (must be >= 1200 chars to meet minimum cacheable token threshold)
  if (
    nextMessages[0]?.role === 'system' &&
    typeof nextMessages[0].content === 'string' &&
    nextMessages[0].content.length >= 1200
  ) {
    nextMessages[0] = {
      ...nextMessages[0],
      content: [
        {
          type: 'text',
          text: nextMessages[0].content,
          cache_control: { type: 'ephemeral' }
        }
      ]
    };
    breakpointsUsed += 1;
  }

  // Breakpoint 3: FIXED Turn-Entry User Message (index NEVER changes across Step 1, Step 2, ..., Step N!)
  let anchorUserIdx = -1;
  for (let i = nextMessages.length - 1; i >= 1; i -= 1) {
    const m = nextMessages[i];
    if (m?.role === 'user') {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (!txt.startsWith('[ادامه‌ی خودکار') && !txt.startsWith('[کنترل کیفیت خودکار')) {
        anchorUserIdx = i;
        break;
      }
    }
  }

  if (anchorUserIdx >= 1) {
    const target = nextMessages[anchorUserIdx];
    if (typeof target.content === 'string' && target.content.length > 0) {
      nextMessages[anchorUserIdx] = {
        ...target,
        content: [
          {
            type: 'text',
            text: target.content,
            cache_control: { type: 'ephemeral' }
          }
        ]
      };
      breakpointsUsed += 1;
    } else if (Array.isArray(target.content) && target.content.length > 0) {
      const clonedParts = target.content.map((p, idx) =>
        idx === target.content.length - 1 ? { ...p, cache_control: { type: 'ephemeral' } } : p
      );
      nextMessages[anchorUserIdx] = { ...target, content: clonedParts };
      breakpointsUsed += 1;
    }
  }

  // Breakpoint 4 (Optional Fixed Epoch): Only if turn exceeds 4 full tool rounds after anchorUserIdx,
  // place ONE fixed checkpoint at anchorUserIdx + 8 (never moves for Steps 5..9).
  const fixedEpochIdx = anchorUserIdx >= 1 ? anchorUserIdx + 8 : -1;
  if (fixedEpochIdx > 0 && fixedEpochIdx < nextMessages.length - 1 && breakpointsUsed < 4) {
    const epMsg = nextMessages[fixedEpochIdx];
    if (epMsg?.role === 'tool' && typeof epMsg.content === 'string' && epMsg.content.length > 0) {
      nextMessages[fixedEpochIdx] = {
        ...epMsg,
        content: [
          {
            type: 'text',
            text: epMsg.content,
            cache_control: { type: 'ephemeral' }
          }
        ]
      };
      breakpointsUsed += 1;
    }
  }

  return { messages: nextMessages, tools: nextTools, injected: breakpointsUsed > 0 };
}
