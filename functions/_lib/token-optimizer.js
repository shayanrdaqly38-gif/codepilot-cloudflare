// Hyper-Efficiency & Precision Token Engine v3 for CodePilot:
//   1. Provider-Aware Dual Strategy:
//      - Raw-Token-Quota Gateways (`tooken.club`, OneAPI/NewAPI packs): aggressive in-turn compaction of persisted `write_file`/`apply_patch` args, stale pre-edit reads & older tool dumps (cuts raw prompt_tokens 65%–90%!)
//      - Cache-Discounted Gateways (`openrouter.ai`, direct Anthropic/OpenAI/DeepSeek): 100% append-only prefix + fixed turn-anchor `cache_control` breakpoints (90% cache-read discount, zero cache-write thrashing)
//   2. Focused File Reader (`query` jump + 15KB clean raw full read + Structural Landmark Map for giant files; zero `\t` line corruption)
//   3. Clean Raw-Line 1-Shot `apply_patch` Failure Recovery
//   4. Zero-Roundtrip `@filepath` / `@filepath:start-end` Pre-Pinning
//   5. Smart Conversational & Step-Level Reasoning Effort Governor (100% full power on Step 1 coding & all errors; eliminates wasted thinking spin on routine steps & greetings)

export const VALID_TOKEN_SAVER_MODES = ['off', 'balanced', 'max', 'rpd'];

const FULL_READ_CHAR_LIMIT = 15_000;
const HUGE_HEAD_CHAR_BUDGET = 10_500;
const MAX_RANGED_LINES = 360;
const LANDMARK_CAP = 56;

const TRIVIAL_CHAT_RE =
  /^(?:(?:سلام|درود|خوبی|چطوری|چه خبر|مرسی|ممنون|سپاس|تشکر|خسته نباشی|خسته نباشید|اوکی|باشه|حله|عالی|دمت گرم|hi|hello|hey|thanks|thank you|ok|okay|cool|nice)[.!؟?،,\s]*){1,3}$/i;

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

/**
 * Returns true when the upstream endpoint discounts cached prefix tokens (OpenRouter, direct Anthropic/OpenAI/DeepSeek).
 * Returns false for raw-token-pack gateways (like `tooken.club`, `moonmath.ai`) that deduct raw `prompt_tokens` 1:1 from user balance.
 */
export function isCacheDiscountedEndpoint(baseUrl = '') {
  const u = String(baseUrl || '').toLowerCase();
  return /openrouter\.ai|api\.anthropic\.com|api\.openai\.com|api\.deepseek\.com|generativelanguage\.googleapis\.com/.test(u);
}

function extractStructuralOutline(lines, fromLineIdx = 0, maxItems = LANDMARK_CAP) {
  const hits = [];
  for (let i = Math.max(0, fromLineIdx); i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw || raw.length > 260) continue;
    for (const rx of STRUCTURAL_PATTERNS) {
      if (rx.test(raw)) {
        hits.push({ line: i + 1, text: raw.trim().slice(0, 105) });
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
 * High-Precision, Low-Token File Reader:
 * - Optional `query`: jumps straight to ±55 clean raw lines around the first match in 1 call (saves a whole `search_code` round-trip!).
 * - Explicit `startLine`/`endLine`: returns clean raw lines (NO `lineNum\t` prefix!) so `apply_patch` matches verbatim on try #1.
 * - Files <= 15,000 chars (~90% of modules): returned 100% verbatim in 1 shot.
 * - Giant files (> 15,000 chars, e.g. 445KB `index.html`) without range: returns ~10.5KB clean raw head + full-file Structural Landmark Map.
 */
export function buildSmartFileRead(path, rawContent, { startLine, endLine, query, tokenSaver = 'max' } = {}) {
  const content = String(rawContent ?? '');
  const hasRange = Number.isFinite(Number(startLine)) || Number.isFinite(Number(endLine));
  const cleanQuery = typeof query === 'string' ? query.trim() : '';

  if (cleanQuery && !hasRange) {
    const lines = content.split('\n');
    const needle = cleanQuery.toLowerCase();
    const hitIndices = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        hitIndices.push(i);
        if (hitIndices.length >= 2) break;
      }
    }
    if (hitIndices.length > 0) {
      const blocks = hitIndices.map((center) => {
        const from = Math.max(0, center - 45);
        const to = Math.min(lines.length, center + 65);
        return `Lines ${from + 1}-${to} of ${lines.length} in ${path} (around "${cleanQuery}"):\n${lines.slice(from, to).join('\n')}`;
      });
      const text = blocks.join('\n\n---\n\n');
      return { text, savedChars: Math.max(0, content.length - text.length), mode: 'query' };
    }
  }

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

  const limit = tokenSaver === 'balanced' ? 22_000 : FULL_READ_CHAR_LIMIT;
  if (tokenSaver === 'off' || content.length <= limit) {
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
    `[Smart Structural Map of ${path} — ${lines.length} lines (${content.length} chars). Lines 1-${headEndIdx} shown verbatim; pass startLine/endLine or query to read_file for deeper sections.]`,
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
 * Emits clean, raw, un-prefixed lines around the fuzzy target so retry succeeds immediately without `read_file`.
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
  return `${baseMsg}\n\n[Auto-Context Recovery — retry apply_patch directly using these exact raw lines without calling read_file]:\n${snippets.join('\n').slice(0, 2000)}`;
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
 * Provider-Aware In-Turn Wire Pruner:
 * - On Cache-Discounted Endpoints (`cacheDiscounted: true`, e.g. OpenRouter): stays 100% append-only unless `force` or `>= 140k` chars so 90% cache-read discount stays locked!
 * - On Raw-Token-Quota Endpoints (`cacheDiscounted: false`, e.g. `tooken.club` where every raw prompt_token is deducted 1:1 from quota!):
 *   1) Immediately compacts already-persisted `write_file`/`apply_patch` arguments (> 500 chars) from earlier steps so 30KB code writes aren't re-billed on every subsequent step!
 *   2) Invalidates stale `read_file` snapshots after that file was modified in a later step, and deduplicates repeated reads.
 *   3) Compacts giant tool outputs (> 1,400 chars) that are >= 2 steps old while keeping the latest step 100% verbatim!
 */
export function pruneInTurnWireMessages(
  wireMessages,
  {
    tokenSaver = 'max',
    cacheDiscounted = false,
    force = false,
    emergencyThresholdChars = 140_000
  } = {}
) {
  if (tokenSaver === 'off' || !Array.isArray(wireMessages) || wireMessages.length < 4) {
    return { messages: wireMessages, savedChars: 0 };
  }

  let totalChars = 0;
  let lastRealUserIdx = -1;
  for (let i = 0; i < wireMessages.length; i += 1) {
    const m = wireMessages[i];
    if (!m) continue;
    if (typeof m.content === 'string') totalChars += m.content.length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) totalChars += (tc?.function?.arguments?.length || 0) + 24;
    }
    if (m.role === 'user') {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (!txt.startsWith('[ادامه‌ی خودکار') && !txt.startsWith('[کنترل کیفیت خودکار')) {
        lastRealUserIdx = i;
      }
    }
  }
  const isEmergency = force || totalChars >= emergencyThresholdChars;

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

  if (groups.length < 1) {
    return { messages: wireMessages, savedChars: 0 };
  }

  const out = wireMessages.slice();
  let savedChars = 0;
  const mutatedLater = new Set();
  const seenSignaturesLater = new Set();

  for (let gIdx = groups.length - 1; gIdx >= 0; gIdx -= 1) {
    const grp = groups[gIdx];
    // On cache-discounted gateways (OpenRouter), NEVER mutate anything at or before `lastRealUserIdx` unless emergency!
    if (cacheDiscounted && !isEmergency && grp.assistantIdx <= lastRealUserIdx) {
      continue;
    }
    const stepsFromTip = groups.length - 1 - gIdx; // 0 = latest completed tool group, 1 = 1 step ago, 2+ = 2+ steps ago
    const aMsg = out[grp.assistantIdx];
    const toolByCallId = new Map();
    for (const ti of grp.toolIndices) {
      const tm = out[ti];
      if (tm?.tool_call_id) toolByCallId.set(tm.tool_call_id, { idx: ti, msg: tm });
    }

    let callsChanged = false;
    const writeArgThreshold = cacheDiscounted && !isEmergency ? 1800 : 550;
    const staleOutThreshold = cacheDiscounted && !isEmergency ? 4500 : 260;

    const nextCalls = (aMsg.tool_calls || []).map((call) => {
      const name = call?.function?.name || '';
      const rawArgs = String(call?.function?.arguments || '');
      const args = safeParseJson(rawArgs);
      const tEntry = toolByCallId.get(call.id);
      const tContent = String(tEntry?.msg?.content || '');
      const failed = /^(Error:|Patch rejected:|Validation:.*error)/i.test(tContent);

      // 1. Once a mutating tool (`write_file` / `apply_patch`) succeeded, its giant file content is ALREADY saved in `workspace.files`.
      // Even on OpenRouter, post-anchor tool calls sit AFTER `cache_control` #3 and would be re-billed 100% uncached on every remaining step!
      const isCleanPersistedWrite =
        !failed &&
        (name === 'write_file' || name === 'apply_patch') &&
        rawArgs.length > writeArgThreshold &&
        !rawArgs.includes('"_persisted":true') &&
        (stepsFromTip >= 1 || (name === 'write_file' && rawArgs.length > 1800 && tContent.includes('Validation: OK.')));

      if (isCleanPersistedWrite) {
        const compactArgs = JSON.stringify({
          ...(args.path ? { path: args.path } : {}),
          _persisted: true,
          _chars: rawArgs.length
        });
        if (compactArgs.length < rawArgs.length) {
          savedChars += rawArgs.length - compactArgs.length;
          callsChanged = true;
          call = { ...call, function: { ...call.function, arguments: compactArgs } };
        }
      }

      // 2. Stale pre-edit `read_file` invalidation + duplicate read deduplication + >=2-step-old large output slimming
      if (stepsFromTip >= 1 && tEntry && tContent.length > staleOutThreshold && !tContent.startsWith('[Stale ') && !tContent.startsWith('[Duplicate ') && !tContent.includes('…[فشرده')) {
        if (name === 'read_file' && args.path && mutatedLater.has(String(args.path))) {
          const replacement = `[Stale read_file(${args.path}) superseded by a later edit in this turn (${tContent.length} chars freed).]`;
          savedChars += Math.max(0, tContent.length - replacement.length);
          out[tEntry.idx] = { ...tEntry.msg, content: replacement };
        } else if (name === 'read_file' || name === 'list_files' || name === 'list_symbols') {
          const sig =
            name === 'read_file'
              ? `read:${args.path || ''}:${args.startLine || ''}:${args.endLine || ''}:${args.query || ''}`
              : name === 'list_symbols'
                ? `sym:${args.query || ''}`
                : 'list_files';
          if (seenSignaturesLater.has(sig)) {
            const replacement = `[Duplicate ${name} output identical to a newer step (${tContent.length} chars deduplicated).]`;
            savedChars += Math.max(0, tContent.length - replacement.length);
            out[tEntry.idx] = { ...tEntry.msg, content: replacement };
          } else if ((!cacheDiscounted || isEmergency) && tokenSaver === 'max' && stepsFromTip >= 2 && tContent.length > 1400) {
            const slimmed = `${tContent.slice(0, 440)}\n…[فشرده شد (${tContent.length} کاراکتر)]…\n${tContent.slice(-180)}`;
            savedChars += Math.max(0, tContent.length - slimmed.length);
            out[tEntry.idx] = { ...tEntry.msg, content: slimmed };
          }
        } else if ((!cacheDiscounted || isEmergency) && tokenSaver === 'max' && stepsFromTip >= 2 && tContent.length > 1400) {
          const slimmed = `${tContent.slice(0, 440)}\n…[فشرده شد (${tContent.length} کاراکتر)]…\n${tContent.slice(-180)}`;
          savedChars += Math.max(0, tContent.length - slimmed.length);
          out[tEntry.idx] = { ...tEntry.msg, content: slimmed };
        }
      }

      if (MUTATING_TOOL_NAMES.has(name) && args.path && !failed) {
        mutatedLater.add(String(args.path));
      }
      if (!failed && (name === 'read_file' || name === 'list_files' || name === 'list_symbols')) {
        const sig =
          name === 'read_file'
            ? `read:${args.path || ''}:${args.startLine || ''}:${args.endLine || ''}:${args.query || ''}`
            : name === 'list_symbols'
              ? `sym:${args.query || ''}`
              : 'list_files';
        seenSignaturesLater.add(sig);
      }

      return call;
    });

    if (callsChanged) {
      out[grp.assistantIdx] = { ...aMsg, tool_calls: nextCalls };
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
  const MAX_PREPIN_CHARS = 10_000;

  let match;
  while ((match = regex.exec(userText)) !== null) {
    const rawCandidate = match[1].replace(/[.,;]+$/, '');
    const filePath = workspaceFiles[rawCandidate] !== undefined ? rawCandidate : match[1];
    if (!filePath || seen.has(filePath) || workspaceFiles[filePath] === undefined) continue;
    seen.add(filePath);
    const startLine = match[2] ? Number(match[2]) : undefined;
    const endLine = match[3] ? Number(match[3]) : startLine ? startLine + 95 : undefined;

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
    block: `\n\n[فایل اشاره‌شده با @ — بدون نیاز به read_file مجدد]:\n${blocks.join('\n\n')}`,
    paths,
    savedRoundtripChars: 3_600 * paths.length
  };
}

/**
 * Smart Conversational & Step-Level Reasoning Effort Governor:
 * - Step 1 on real coding/analysis prompts & ALL error / patch-rejection / validation-failure / auto-repair steps: 100% full `baseEffort`!
 * - Pure short greetings ("سلام", "مرسی", "ok"): steps down to `'low'`/`'minimal'` so greetings don't burn 4,000 thinking tokens!
 * - Routine Step 2+ execution after Step 1 already planned architecture (with 0 errors): steps down `'max'`/`'xhigh'`/`'high'` to `'medium'` (and `'low'` on pure listing or verified-clean closing summary), cutting reasoning spin by 65%–85%!
 */
export function resolveAdaptiveStepEffort({
  baseEffort,
  step = 1,
  userText = '',
  lastStepInfo = null,
  isAutoRepair = false,
  tokenSaver = 'max',
  supportedLevels = []
}) {
  if (!baseEffort || baseEffort === 'none' || tokenSaver === 'off') {
    return baseEffort;
  }
  const levels = Array.isArray(supportedLevels) ? supportedLevels : [];

  const pickSupported = (preferred) => {
    for (const candidate of preferred) {
      if (!levels.length || levels.includes(candidate)) return candidate;
    }
    return baseEffort;
  };

  if (isAutoRepair || lastStepInfo?.hadError || lastStepInfo?.hadValidationError) {
    if (baseEffort === 'low' && levels.includes('medium')) return 'medium';
    return baseEffort;
  }

  // Pure 1-2 word greeting/acknowledgment on Step 1: avoid burning thousands of reasoning tokens on "سلام"!
  if (step === 1 && tokenSaver === 'max' && typeof userText === 'string') {
    const trimmed = userText.trim();
    if (trimmed.length > 0 && trimmed.length <= 28 && TRIVIAL_CHAT_RE.test(trimmed)) {
      return pickSupported(['minimal', 'low', baseEffort]);
    }
  }

  if (step <= 1 || !lastStepInfo) {
    return baseEffort;
  }

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

  // Step 2+ clean intermediate execution (e.g. applying planned patch after clean read_file):
  // Step 1 already ran at full `baseEffort`; stepping down to `medium` (in `max` saver) saves thousands of output reasoning tokens per step!
  if (tokenSaver === 'max') {
    return pickSupported(['medium', 'high', baseEffort]);
  }
  if (tokenSaver === 'balanced' && (baseEffort === 'max' || baseEffort === 'xhigh')) {
    return pickSupported(['high', baseEffort]);
  }

  return baseEffort;
}

/**
 * FIXED-ANCHOR Prompt Cache Breakpoints for Anthropic Claude & Google Gemini on OpenRouter:
 * Anchors strictly on (1) last `tools` schema, (2) `messages[0]` system prompt, and (3) FIXED turn-entry user index.
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

  let nextTools = tools;
  if (Array.isArray(tools) && tools.length > 0) {
    nextTools = tools.map((t, idx) =>
      idx === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
    );
    breakpointsUsed += 1;
  }

  if (
    nextMessages[0]?.role === 'system' &&
    typeof nextMessages[0].content === 'string' &&
    nextMessages[0].content.length >= 600
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

/**
 * Detects whether the current turn should optimize primarily for **minimum HTTP API requests**
 * (OpenRouter 50 requests/day `:free` cap or explicit `'rpd'` Request-Saver mode).
 */
export function isRpdLimitedTurn({ tokenSaver = 'max', baseUrl = '', model = '' } = {}) {
  if (tokenSaver === 'rpd') return true;
  if (tokenSaver === 'off') return false;
  const m = String(model || '').trim().toLowerCase();
  if (!m) return false;
  if (m.endsWith(':free') || m === 'openrouter/free') return true;
  return false;
}

/**
 * Preloads the active & relevant workspace files directly into Step 1 when RPD Request-Saver
 * is active (and not a pure greeting), eliminating `list_files` + `read_file` tool round-trips
 * so coding tasks finish in **1 single API request** instead of 4–7 requests!
 */
export function buildRequestSaverWorkspacePack(
  workspaceFiles,
  activeFile = '',
  userText = '',
  { excludePaths = [], maxTotalChars = 26_000, maxPerFileChars = 13_000 } = {}
) {
  const trimmedUser = String(userText || '').trim();
  if (trimmedUser && trimmedUser.length <= 36 && TRIVIAL_CHAT_RE.test(trimmedUser)) {
    return { injectedText: '', preloadedPaths: [] };
  }

  const filesObj = workspaceFiles && typeof workspaceFiles === 'object' ? workspaceFiles : {};
  const excluded = new Set(Array.isArray(excludePaths) ? excludePaths : []);
  const allPaths = Object.keys(filesObj).filter((p) => !excluded.has(p) && typeof filesObj[p] === 'string');

  const lowerPrompt = trimmedUser.toLowerCase();
  const scored = allPaths.map((p) => {
    let score = 0;
    const baseName = p.split('/').pop()?.toLowerCase() || '';
    if (p === activeFile) score += 100;
    if (baseName && lowerPrompt.includes(baseName)) score += 80;
    if (p.length <= 24 && lowerPrompt.includes(p.toLowerCase())) score += 90;
    if (/\.(html|js|mjs|ts|tsx|jsx|css|py|json)$/i.test(p)) score += 15;
    score -= Math.min(12, Math.floor(filesObj[p].length / 5000));
    return { path: p, score, len: filesObj[p].length };
  });
  scored.sort((a, b) => b.score - a.score || a.len - b.len);

  let usedChars = 0;
  const preloadedPaths = [];
  const blocks = [];

  for (const item of scored) {
    if (blocks.length >= 6 || usedChars >= maxTotalChars) break;
    const raw = String(filesObj[item.path] || '');
    if (!raw.trim()) continue;
    const remain = maxTotalChars - usedChars;
    if (remain < 500) break;
    const cap = Math.min(maxPerFileChars, remain);
    if (raw.length <= cap) {
      blocks.push(`[Preloaded: ${item.path} (${raw.length} chars — complete raw file)]\n${raw}`);
      usedChars += raw.length;
      preloadedPaths.push(item.path);
    } else if (item.score >= 80 && cap >= 2500) {
      const smart = buildSmartFileRead(item.path, raw, { tokenSaver: 'max' });
      const clipped = smart.text.slice(0, cap);
      blocks.push(`[Preloaded: ${item.path} (head + landmark map of ${raw.length} chars)]\n${clipped}`);
      usedChars += clipped.length;
      preloadedPaths.push(item.path);
    }
  }

  const directive =
    '[⚡ 50-REQ/DAY ULTRA-BATCH MODE: Minimize API round-trips! ' +
    (preloadedPaths.length
      ? `Files (${preloadedPaths.join(', ')}) are ALREADY preloaded below by the system — DO NOT call list_files or read_file on them. `
      : 'Do NOT call think. ') +
    'If the user asks for code changes, execute ALL write_file/apply_patch edits together in ONE single parallel batch AND include your brief Persian explanation in `content` in the SAME response!]';

  return {
    injectedText: blocks.length ? `${directive}\n\n${blocks.join('\n\n')}` : directive,
    preloadedPaths
  };
}

