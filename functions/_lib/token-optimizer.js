// Hyper-Efficiency & Precision Token Engine for CodePilot:
//   1. Smart Structural Code Map for large files (replaces blind 12k truncation with exact line-numbered AST/landmark outlines)
//   2. Surgical `apply_patch` failure recovery (injects exact surrounding file lines so retries succeed in 1 shot)
//   3. Stale-snapshot invalidation + prefix-cache-friendly epoch pruning inside multi-step loops
//   4. Zero-roundtrip `@filepath` / `@filepath:start-end` pre-pinning
//   5. Adaptive per-step Reasoning Effort (100% full power on Step 1, architecture & debugging; zero wasted spin on trivial steps)
//   6. Multi-provider Prompt Cache breakpoint injection (`cache_control: { type: 'ephemeral' }`)

export const VALID_TOKEN_SAVER_MODES = ['off', 'balanced', 'max'];

const FULL_READ_CHAR_LIMIT = 11_200;
const MAX_RANGED_LINES = 320;
const LANDMARK_CAP = 72;

const STRUCTURAL_PATTERNS = [
  // JS / TS / MJS functions, classes, exports, routes
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*case\s+['"`]([^'"`]{1,60})['"`]\s*:/,
  // HTML / SPA landmarks
  /^\s*<(style|script|header|main|nav|aside|footer)\b[^>]*>/i,
  /^\s*<\/(style|script)>/i,
  /<(?:div|section|aside|nav|dialog)\b[^>]*\bid=["']([^"']{2,60})["'][^>]*>/i,
  // Python / Go / Rust / C-like
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
  // CSS major media/root/section comments & Markdown headings
  /^\s*(@media\b[^{]{1,80})\{/,
  /^\s*(#{1,3}\s+.{2,80})$/
];

function extractStructuralOutline(lines, maxItems = LANDMARK_CAP) {
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
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
  // Evenly sample across the entire file so head, middle, and tail landmarks are all visible!
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

function formatNumberedSlice(lines, fromIdx, toIdx) {
  const out = [];
  for (let i = fromIdx; i < toIdx; i += 1) {
    out.push(`${i + 1}\t${lines[i]}`);
  }
  return out.join('\n');
}

/**
 * High-precision file reader:
 * - Small/medium files (<= 11.2k chars): returned 100% verbatim.
 * - Explicit `startLine`/`endLine`: returns exact numbered lines (capped cleanly at 320 lines per slice so lines never get chopped mid-character).
 * - Large files (> 11.2k chars) without line range: returns a complete Structural Symbol & Landmark Map with exact line numbers across the ENTIRE file + numbered head & tail!
 */
export function buildSmartFileRead(path, rawContent, { startLine, endLine, tokenSaver = 'max' } = {}) {
  const content = String(rawContent ?? '');
  const hasRange = Number.isFinite(Number(startLine)) || Number.isFinite(Number(endLine));

  if (hasRange) {
    const lines = content.split('\n');
    const from = Math.max(0, (Number.isFinite(Number(startLine)) ? Math.floor(Number(startLine)) : 1) - 1);
    const requestedTo = Number.isFinite(Number(endLine)) ? Math.floor(Number(endLine)) : from + MAX_RANGED_LINES;
    const cappedTo = Math.min(lines.length, Math.max(from + 1, Math.min(requestedTo, from + MAX_RANGED_LINES)));
    const slice = formatNumberedSlice(lines, from, cappedTo);
    const moreHint =
      cappedTo < Math.min(lines.length, requestedTo) || (!Number.isFinite(Number(endLine)) && cappedTo < lines.length)
        ? `\n[Showing lines ${from + 1}-${cappedTo} of ${lines.length}. Call read_file({ path: "${path}", startLine: ${cappedTo + 1}, endLine: ${Math.min(lines.length, cappedTo + MAX_RANGED_LINES)} }) for next lines.]`
        : '';
    const text = `Lines ${from + 1}-${cappedTo} of ${lines.length} in ${path}:\n${slice}${moreHint}`;
    const savedChars = Math.max(0, content.length - text.length);
    return { text, savedChars, mode: 'ranged' };
  }

  if (tokenSaver === 'off' || content.length <= FULL_READ_CHAR_LIMIT) {
    return { text: content, savedChars: 0, mode: 'full' };
  }

  const lines = content.split('\n');
  const headCount = Math.min(72, lines.length);
  const tailCount = lines.length > 110 ? Math.min(24, lines.length - headCount) : 0;
  const outline = extractStructuralOutline(lines, LANDMARK_CAP);

  const sections = [
    `[Smart Structural Map of ${path} — ${lines.length} lines (${content.length} chars). Call read_file({ path: "${path}", startLine, endLine }) to read any exact section before patching.]`,
    '',
    `--- Head (Lines 1-${headCount}) ---`,
    formatNumberedSlice(lines, 0, headCount)
  ];

  if (outline.length) {
    sections.push(
      '',
      `--- Structural Landmarks Across Entire File (${outline.length} anchors) ---`,
      outline.map((h) => `L${h.line}: ${h.text}`).join('\n')
    );
  }

  if (tailCount > 0) {
    const tailStart = lines.length - tailCount;
    sections.push(
      '',
      `--- Tail (Lines ${tailStart + 1}-${lines.length}) ---`,
      formatNumberedSlice(lines, tailStart, lines.length)
    );
  }

  const text = sections.join('\n');
  const savedChars = Math.max(0, content.length - text.length);
  return { text, savedChars, mode: 'outline' };
}

/**
 * When `apply_patch` fails to match, find the closest lines in `fileContent`
 * and return their exact numbered context so the model succeeds in 1 shot on the next step
 * without wasting 2–3 extra `search_code` + `read_file` steps!
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

    // Pick the longest/most specific line from the search block
    const sorted = [...candidateLines].sort((a, b) => b.length - a.length);
    const anchor = sorted[0];
    const anchorTokens = (anchor.match(/[A-Za-z_$][\w$]{2,}/g) || []).slice(0, 8);

    const matchedLineNums = [];
    for (let i = 0; i < fileLines.length; i += 1) {
      const fl = fileLines[i].trim();
      if (!fl) continue;
      if (fl.includes(anchor) || anchor.includes(fl) && fl.length >= 12) {
        matchedLineNums.push(i);
        if (matchedLineNums.length >= 2) break;
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

    for (const center of matchedLineNums.slice(0, 2)) {
      const from = Math.max(0, center - 8);
      const to = Math.min(fileLines.length, center + 12);
      snippets.push(
        `Actual lines ${from + 1}-${to} in ${path}:\n${formatNumberedSlice(fileLines, from, to)}`
      );
    }
  }

  if (!snippets.length) return baseMsg;
  return `${baseMsg}\n\n[Auto-Context Recovery — exact current lines in ${path} so you can retry apply_patch immediately without extra read_file calls]:\n${snippets.join('\n---\n').slice(0, 4500)}`;
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
 * Prefix-Cache-Friendly + Accuracy-Boosting In-Turn Wire Pruner:
 * 1. Invalidates stale `read_file` outputs for files that were edited in a LATER step (prevents stale-line hallucinations AND frees tokens).
 * 2. Deduplicates identical `read_file` / `list_files` / `list_symbols` calls repeated later in the turn.
 * 3. Compacts giant older `write_file` / `apply_patch` arguments and tool dumps in clean epochs once older uncompacted tool chars cross threshold.
 */
export function pruneInTurnWireMessages(wireMessages, { tokenSaver = 'max' } = {}) {
  if (tokenSaver === 'off' || !Array.isArray(wireMessages) || wireMessages.length < 5) {
    return { messages: wireMessages, savedChars: 0 };
  }

  // Locate assistant->tool exchange groups
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

  // Pass 1 (Newest -> Oldest): Track mutated files & duplicate read/list signatures
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
          const replacement = `[Stale read_file(${args.path}) superseded by a later edit in this turn (${tContent.length} chars freed). Call read_file if fresh post-edit lines are needed.]`;
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

      // Register mutations & read signatures as we walk backward toward older steps
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
        if (name === 'read_file' && args.path && mutatedLater.has(String(args.path))) {
          // Do not mark post-mutation signature as valid for pre-mutation reads (already handled by mutatedLater)
        }
      }
    }
  }

  // Pass 2: Epoch Compaction of older groups (keep last 2 groups 100% verbatim; compact older groups once uncompacted tool chars cross threshold)
  const keepTailGroups = 2;
  if (groups.length > keepTailGroups) {
    const olderGroups = groups.slice(0, groups.length - keepTailGroups);
    const epochThreshold = tokenSaver === 'max' ? 14_000 : 26_000;
    let olderUncompactedChars = 0;

    for (const grp of olderGroups) {
      const aMsg = out[grp.assistantIdx];
      for (const tc of aMsg.tool_calls || []) {
        const rawArgs = String(tc?.function?.arguments || '');
        if (rawArgs.length > 850 && !rawArgs.includes('"_compacted_step":true')) {
          olderUncompactedChars += rawArgs.length;
        }
      }
      for (const ti of grp.toolIndices) {
        const tc = String(out[ti]?.content || '');
        if (tc.length > 1500 && !tc.includes('فشرده شد')) {
          olderUncompactedChars += tc.length;
        }
      }
    }

    if (olderUncompactedChars >= epochThreshold) {
      for (const grp of olderGroups) {
        const aMsg = out[grp.assistantIdx];
        let callsChanged = false;
        const nextCalls = (aMsg.tool_calls || []).map((tc) => {
          const rawArgs = String(tc?.function?.arguments || '');
          if (rawArgs.length <= 850 || rawArgs.includes('"_compacted_step":true')) return tc;
          callsChanged = true;
          const parsed = safeParseJson(rawArgs);
          const compactJson = JSON.stringify({
            ...(parsed.path ? { path: parsed.path } : {}),
            ...(parsed.command ? { command: String(parsed.command).slice(0, 90) } : {}),
            _compacted_step: true,
            _original_chars: rawArgs.length,
            _note: 'Applied to workspace; call read_file if latest lines are needed.'
          });
          savedChars += Math.max(0, rawArgs.length - compactJson.length);
          return {
            ...tc,
            function: {
              ...tc.function,
              arguments: compactJson
            }
          };
        });
        if (callsChanged) {
          out[grp.assistantIdx] = { ...aMsg, tool_calls: nextCalls };
        }

        for (const ti of grp.toolIndices) {
          const tm = out[ti];
          const tc = String(tm?.content || '');
          if (tc.length > 1500 && !tc.includes('فشرده شد') && !tc.startsWith('[Stale ') && !tc.startsWith('[Duplicate ')) {
            const compacted = `${tc.slice(0, 750)}\n…[خروجی گام قبلی فشرده شد (${tc.length} کاراکتر) — در صورت نیاز read_file با بازه خطوط صدا بزنید]…\n${tc.slice(-300)}`;
            savedChars += Math.max(0, tc.length - compacted.length);
            out[ti] = { ...tm, content: compacted };
          }
        }
      }
    }
  }

  return { messages: out, savedChars };
}

/**
 * Zero-Roundtrip `@filepath` / `@filepath:start-end` Pre-Pinner:
 * Injects referenced workspace files (or their structural outline if huge) directly on Step 1
 * so the model skips an entire extra LLM round-trip!
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
  const MAX_PREPIN_CHARS = 9_200;

  let match;
  while ((match = regex.exec(userText)) !== null) {
    const rawCandidate = match[1].replace(/[.,;]+$/, '');
    const filePath = workspaceFiles[rawCandidate] !== undefined ? rawCandidate : match[1];
    if (!filePath || seen.has(filePath) || workspaceFiles[filePath] === undefined) continue;
    seen.add(filePath);
    const startLine = match[2] ? Number(match[2]) : undefined;
    const endLine = match[3] ? Number(match[3]) : startLine ? startLine + 90 : undefined;

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
    block: `\n\n[محتوای مستقیم فایل‌های اشاره‌شده با @ — بدون نیاز به فراخوانی مجدد read_file روی همین بخش]:\n${blocks.join('\n\n')}`,
    paths,
    savedRoundtripChars: 3_600 * paths.length
  };
}

/**
 * Adaptive Per-Step Reasoning Effort:
 * - Preserves 100% full `baseEffort` on Step 1 (architecture & planning) and on ANY error / patch-rejection / validation-failure / auto-repair step!
 * - Steps down expensive `max`/`xhigh`/`high` reasoning spin on purely mechanical steps (e.g. post-`list_files` lookup or writing a 2-line closing confirmation after all edits & tests already passed cleanly).
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

  // Boost low -> medium automatically during auto-repair of broken syntax!
  if (isAutoRepair || lastStepInfo?.hadError || lastStepInfo?.hadValidationError) {
    if (baseEffort === 'low' && levels.includes('medium')) return 'medium';
    return baseEffort;
  }

  // Step 1 ALWAYS runs at 100% of the user's chosen Effort!
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

  // Case 1: Previous step ONLY listed files/symbols and succeeded with 0 errors
  if (lastStepInfo.onlyListing) {
    return tokenSaver === 'max'
      ? pickSupported(['low', 'minimal', 'medium'])
      : pickSupported(['medium', 'low']);
  }

  // Case 2: Previous step applied edits/commands AND every validation & command passed 100% cleanly
  if (lastStepInfo.justVerifiedClean) {
    return tokenSaver === 'max'
      ? pickSupported(['low', 'medium'])
      : pickSupported(['medium']);
  }

  return baseEffort;
}

/**
 * Inject explicit `cache_control: { type: 'ephemeral' }` breakpoints for Anthropic Claude & Google Gemini
 * on OpenRouter (activating 75%–90%-off Cached Input reads!), while leaving OpenAI / DeepSeek / Qwen / Tooken
 * plain strings intact for their automatic byte-identical prefix KV-caching.
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

  // Breakpoint 1: System prompt (largest static block)
  if (nextMessages[0]?.role === 'system' && typeof nextMessages[0].content === 'string' && nextMessages[0].content.length >= 400) {
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

  // Breakpoint 2: Stable prefix tail (2 messages back from tip so multi-step agent loops hit cache on every new step!)
  const pivotIdx = nextMessages.length >= 4 ? nextMessages.length - 3 : nextMessages.length - 1;
  if (pivotIdx >= 1 && breakpointsUsed < 3) {
    const target = nextMessages[pivotIdx];
    if (target && (target.role === 'user' || target.role === 'assistant') && typeof target.content === 'string' && target.content.length > 0) {
      nextMessages[pivotIdx] = {
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
    }
  }

  // Breakpoint 3: Last tool schema
  let nextTools = tools;
  if (Array.isArray(tools) && tools.length > 0 && breakpointsUsed < 4) {
    nextTools = tools.map((t, idx) =>
      idx === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
    );
  }

  return { messages: nextMessages, tools: nextTools, injected: breakpointsUsed > 0 };
}
