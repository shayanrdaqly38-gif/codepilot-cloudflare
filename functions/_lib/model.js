// The single place that talks to the model provider (https://tooken.club/v1).
// Reads live model capabilities & reasoning effort levels directly from `/v1/models`,
// and sends genuine `reasoning_effort` values (`none`..`max`) without synthetic token budgets.

import { fail, sleep, stripSecrets, envSecrets } from './util.js';

export const ALLOWED_TOOLS = new Set([
  'think',
  'list_files',
  'read_file',
  'search_code',
  'list_symbols',
  'write_file',
  'apply_patch',
  'delete_file',
  'undo_edit',
  'file_history',
  'run_command',
  'web_search',
  'fetch_url'
]);

export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const FULL_TOOKEN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const STANDARD_EFFORTS = ['low', 'medium', 'high'];

export const MODEL_CATALOG = [
  {
    id: 'claude-fable-5-1',
    title: 'Fable 5.1',
    badge: 'Pro, Max, or Ultra',
    subtitle: 'For your toughest challenges',
    label: 'Claude Fable 5.1 — برای سخت‌ترین چالش‌ها و معماری سنگین',
    tier: 'flagship',
    featured: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'claude-opus-5-5',
    title: 'Opus 5.5',
    badge: 'Pro',
    subtitle: 'For complex work and everyday tasks',
    label: 'Claude Opus 5.5 — برای کارهای پیچیده و مهندسی کد',
    tier: 'flagship',
    featured: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'claude-sonnet-5-5',
    title: 'Sonnet 5.5',
    subtitle: 'Most efficient for simpler tasks',
    label: 'Claude Sonnet 5.5 — سریع، بهینه و متعادل (پیش‌فرض)',
    tier: 'balanced',
    featured: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'claude-haiku-5-5',
    title: 'Haiku 5.5',
    subtitle: 'Fastest for quick answers',
    label: 'Claude Haiku 5.5 — سریع‌ترین برای پاسخ‌های فوری',
    tier: 'fast',
    featured: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'gpt-6.1-sol',
    title: 'GPT-6.1 Sol',
    subtitle: 'Flagship reasoning & software engineering',
    label: 'GPT-6.1 Sol — پرچم‌دار استدلال و کدنویسی',
    tier: 'flagship',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'deepseek-v4-pro',
    title: 'DeepSeek V4 Pro',
    subtitle: 'Deep algorithmic reasoning',
    label: 'DeepSeek V4 Pro — تخصصی الگوریتم و تفکر عمیق',
    tier: 'reasoning',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    title: 'DeepSeek V4.1 Flash 1017',
    subtitle: 'Fast coding with full reasoning control',
    label: 'DeepSeek V4.1 Flash — سریع با پشتیبانی کامل استدلال',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'gpt-6-luna',
    title: 'GPT-6 Luna',
    subtitle: 'Fast multimodal with full reasoning levels',
    label: 'GPT-6 Luna — چندوجهی سریع با سطوح کامل استدلال',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'gpt-6-astra',
    title: 'GPT-6 Astra',
    subtitle: 'Lightweight & responsive',
    label: 'GPT-6 Astra — سبک و پرسرعت',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'gpt-6.1-terra',
    title: 'GPT-6.1 Terra',
    subtitle: 'Balanced software architecture',
    label: 'GPT-6.1 Terra — مهندسی نرم‌افزار پیشرفته',
    tier: 'balanced',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'gemini-4-argon',
    title: 'Gemini 4 Argon',
    subtitle: '1M context window',
    label: 'Gemini 4 Argon — زمینه ۱ میلیون توکن',
    tier: 'flagship',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_768,
    vision: false,
    tools: true,
    reasoningLevels: STANDARD_EFFORTS,
    reasoningUnconfirmed: true,
    defaultEffort: 'medium'
  },
  {
    id: 'gemini-3-8-flash',
    title: 'Gemini 3.8 Flash',
    subtitle: 'High-speed responses',
    label: 'Gemini 3.8 Flash — بسیار سریع',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    vision: true,
    tools: true,
    reasoningLevels: STANDARD_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'grok-4.7',
    title: 'Grok 4.7',
    subtitle: 'Deep analysis & problem solving',
    label: 'Grok 4.7 — تحلیل عمیق و حل مسئله',
    tier: 'flagship',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'kimi-k3.1-pro',
    title: 'Kimi K3.1 Pro',
    subtitle: 'Large repository comprehension',
    label: 'Kimi K3.1 Pro — تحلیل پروژه‌های بزرگ',
    tier: 'reasoning',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'glm-5.3',
    title: 'GLM 5.3',
    subtitle: 'Accurate coding & tool use',
    label: 'GLM 5.3 — کدنویسی و ابزارخوانی دقیق',
    tier: 'balanced',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'glm-5.3-flash',
    title: 'GLM 5.3 Flash',
    subtitle: 'Fast & economical',
    label: 'GLM 5.3 Flash — سریع و اقتصادی',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'claude-opus-4-5',
    title: 'Claude Opus 4.5',
    subtitle: 'Previous Opus generation',
    label: 'Claude Opus 4.5 — نسخه پایدار کلود اپوس',
    tier: 'balanced',
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  }
];

const CATALOG_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
const MODEL_ID_RE = /^[a-zA-Z0-9._:/-]{1,120}$/;
const DEFAULT_TIMEOUT_MS = 95_000;
const LIVE_MODELS_TTL_MS = 5 * 60 * 1000;

let liveModelsCache = { key: '', until: 0, byId: new Map(), list: [] };

function normalizeEffortToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'off') return 'none';
  if (s === 'extra' || s === 'extra_high' || s === 'extra-high') return 'xhigh';
  return EFFORT_LEVELS.includes(s) ? s : null;
}

function extractEffortLevelsFromValue(val) {
  if (val === false || val === 0 || val === 'false' || val === 'unsupported' || val === 'disabled') {
    return { explicit: true, levels: [], unconfirmed: false };
  }
  if (typeof val === 'string') {
    const tokens = val
      .split(/[\s,;|·/]+/)
      .map(normalizeEffortToken)
      .filter(Boolean);
    if (tokens.length) {
      return {
        explicit: true,
        levels: EFFORT_LEVELS.filter((lvl) => tokens.includes(lvl)),
        unconfirmed: false
      };
    }
  }
  if (Array.isArray(val)) {
    const tokens = val.map((v) => (typeof v === 'string' ? normalizeEffortToken(v) : normalizeEffortToken(v?.id || v?.name || v?.level))).filter(Boolean);
    return {
      explicit: true,
      levels: EFFORT_LEVELS.filter((lvl) => tokens.includes(lvl)),
      unconfirmed: false
    };
  }
  if (val && typeof val === 'object') {
    if (val.supported === false || val.enabled === false) {
      return { explicit: true, levels: [], unconfirmed: false };
    }
    const unconfirmed = val.confirmed === false || val.verified === false || Boolean(val.unconfirmed);
    const sub =
      val.levels ??
      val.efforts ??
      val.values ??
      val.modes ??
      val.supported_efforts ??
      val.reasoning_efforts ??
      val.options;
    if (sub !== undefined) {
      const parsed = extractEffortLevelsFromValue(sub);
      return { explicit: true, levels: parsed.levels, unconfirmed: unconfirmed || parsed.unconfirmed };
    }
    if (val.supported === true || val.enabled === true) {
      return { explicit: true, levels: STANDARD_EFFORTS, unconfirmed };
    }
  }
  if (val === true) {
    return { explicit: true, levels: STANDARD_EFFORTS, unconfirmed: false };
  }
  return { explicit: false, levels: [], unconfirmed: false };
}

/**
 * Parse a raw model object returned by `GET https://tooken.club/v1/models`
 * so the app always uses each model's real provider-reported capabilities.
 */
export function parseProviderModelItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id || !MODEL_ID_RE.test(id) || /image|whisper|tts|embedding|moderation|rerank/i.test(id)) return null;

  const base = CATALOG_BY_ID.get(id);
  const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
  const limits = item.limits && typeof item.limits === 'object' ? item.limits : {};
  const arch = item.architecture && typeof item.architecture === 'object' ? item.architecture : {};

  const candidates = [
    item.reasoning_efforts,
    item.supported_reasoning_efforts,
    item.reasoning_levels,
    item.efforts,
    item.reasoning,
    item.thinking,
    caps.reasoning_efforts,
    caps.reasoning_levels,
    caps.reasoning,
    caps.effort,
    arch.reasoning_efforts,
    item.meta?.reasoning,
    item.info?.reasoning
  ];

  let parsedReasoning = null;
  for (const cand of candidates) {
    if (cand === undefined || cand === null) continue;
    const res = extractEffortLevelsFromValue(cand);
    if (res.explicit) {
      parsedReasoning = res;
      break;
    }
  }

  const unconfirmedFlag =
    item.reasoning_confirmed === false ||
    item.reasoning_verified === false ||
    Boolean(item.reasoning_unconfirmed) ||
    caps.reasoning_confirmed === false ||
    Boolean(caps.reasoning_unconfirmed) ||
    Boolean(parsedReasoning?.unconfirmed) ||
    (item.reasoning_confirmed === undefined && Boolean(base?.reasoningUnconfirmed));

  const maxInputTokens =
    Number(
      item.max_input_tokens ??
        item.input_token_limit ??
        item.context_length ??
        item.context_window ??
        limits.input ??
        limits.context ??
        limits.max_input_tokens
    ) ||
    base?.maxInputTokens ||
    null;

  const maxOutputTokens =
    Number(
      item.max_output_tokens ??
        item.max_completion_tokens ??
        item.output_token_limit ??
        limits.output ??
        limits.max_output_tokens
    ) ||
    base?.maxOutputTokens ||
    null;

  const visionRaw =
    item.vision ??
    item.supports_vision ??
    caps.vision ??
    (Array.isArray(item.input_modalities) ? item.input_modalities.includes('image') : undefined) ??
    (Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : undefined);
  const vision = typeof visionRaw === 'boolean' ? visionRaw : (base?.vision ?? null);

  const toolsRaw =
    item.tools ??
    item.supports_tools ??
    item.function_calling ??
    caps.tools ??
    caps.function_calling ??
    (Array.isArray(item.supported_parameters) ? item.supported_parameters.includes('tools') : undefined);
  const tools = typeof toolsRaw === 'boolean' ? toolsRaw : (base?.tools ?? true);

  const levels = parsedReasoning
    ? parsedReasoning.levels
    : base?.reasoningLevels
      ? [...base.reasoningLevels]
      : inferFallbackLevels(id);

  const defaultEffort = pickDefaultEffort(id, levels, base?.defaultEffort);
  const title =
    (typeof item.name === 'string' && item.name.trim()) ||
    (typeof item.title === 'string' && item.title.trim()) ||
    (typeof item.display_name === 'string' && item.display_name.trim()) ||
    base?.title ||
    id;

  return {
    ...(base || {}),
    id,
    title,
    label: base?.label || title,
    tier: base?.tier || 'live',
    featured: Boolean(base?.featured),
    maxInputTokens,
    maxOutputTokens,
    vision,
    tools,
    reasoning: {
      supported: levels.length > 0,
      levels,
      defaultEffort,
      unconfirmed: parsedReasoning ? unconfirmedFlag : Boolean(base?.reasoningUnconfirmed),
      source: parsedReasoning ? 'provider' : base ? 'catalog' : 'inferred'
    }
  };
}

function inferFallbackLevels(modelId) {
  const s = String(modelId || '').toLowerCase();
  if (/^(gpt-3\.5|gpt-4o|claude-2|claude-3-(?:haiku|sonnet|opus))/.test(s)) return [];
  if (s.startsWith('gemini-')) return [...STANDARD_EFFORTS];
  return [...FULL_TOOKEN_EFFORTS];
}

function pickDefaultEffort(modelId, levels, preferred) {
  if (!levels || !levels.length) return null;
  if (preferred && levels.includes(preferred)) return preferred;
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('high')) return 'high';
  return levels[0];
}

/**
 * Return the model's Reasoning Effort specification, preferring live `/v1/models`
 * metadata cached from `tooken.club` when available.
 */
export function getModelReasoningSpec(modelId) {
  const id = String(modelId || '').trim();
  if (!id) {
    return { supported: false, levels: [], defaultEffort: null, unconfirmed: false };
  }
  const live = liveModelsCache.byId.get(id);
  if (live?.reasoning) return live.reasoning;

  const cat = CATALOG_BY_ID.get(id);
  if (cat) {
    const levels = [...(cat.reasoningLevels || [])];
    return {
      supported: levels.length > 0,
      levels,
      defaultEffort: pickDefaultEffort(id, levels, cat.defaultEffort),
      unconfirmed: Boolean(cat.reasoningUnconfirmed),
      source: 'catalog'
    };
  }

  const levels = inferFallbackLevels(id);
  return {
    supported: levels.length > 0,
    levels,
    defaultEffort: pickDefaultEffort(id, levels),
    unconfirmed: false,
    source: 'inferred'
  };
}

/**
 * Normalize a requested effort against the model's supported `tooken.club` levels.
 * Returns one of `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`,
 * or `null` when no effort should be sent on the wire.
 */
export function normalizeReasoningEffort(value, modelId, legacyThinking = undefined) {
  const spec = getModelReasoningSpec(modelId);
  if (!spec.supported || !spec.levels.length) return null;

  if (value === undefined || value === null || value === '') {
    if (legacyThinking === undefined) return null;
    if (!legacyThinking) return spec.levels.includes('none') ? 'none' : null;
    return spec.defaultEffort || 'medium';
  }

  const normalized = normalizeEffortToken(value);
  if (!normalized) return spec.defaultEffort;
  if (spec.levels.includes(normalized)) return normalized;

  // Clamp gracefully to the closest supported level for this model (e.g. gemini-4-argon: low/medium/high).
  const targetIdx = EFFORT_LEVELS.indexOf(normalized);
  let best = spec.levels[0];
  let bestDist = Infinity;
  for (const candidate of spec.levels) {
    const dist = Math.abs(EFFORT_LEVELS.indexOf(candidate) - targetIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/**
 * Build wire parameter candidates for `https://tooken.club/v1/chat/completions`.
 * Sends pure `reasoning_effort` directly — no fake `budget_tokens` or `max_tokens` overrides,
 * because `tooken.club` manages each model's separate reasoning token pool natively.
 */
export function buildReasoningWireVariants(modelId, effort, payload = {}) {
  const baseTemp = payload.temperature ?? 0.3;
  const explicitMaxTokens = Number(payload.max_tokens ?? payload.maxTokens) || 0;
  const maxTokPart = explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {};

  if (!effort) {
    return [{ effort: null, params: { temperature: baseTemp, ...maxTokPart } }];
  }

  const variants = [
    {
      effort,
      params: {
        reasoning_effort: effort,
        ...(effort === 'none' ? { temperature: baseTemp } : {}),
        ...maxTokPart
      }
    }
  ];

  // If an upstream channel hasn't enabled extended enum values (`xhigh`/`max`/`minimal`/`none`),
  // step down to standard 3-level `high`/`low`, then plain request without failing the turn.
  if (effort === 'max' || effort === 'xhigh') {
    variants.push({ effort: 'high', params: { reasoning_effort: 'high', ...maxTokPart } });
  } else if (effort === 'minimal') {
    variants.push({ effort: 'low', params: { reasoning_effort: 'low', ...maxTokPart } });
  }
  variants.push({ effort: null, params: { temperature: baseTemp, ...maxTokPart } });
  return variants;
}

export function sanitizeModelId(value, env) {
  const candidate = String(value || '').trim();
  if (candidate && MODEL_ID_RE.test(candidate)) return candidate;
  return String(env.MODEL_NAME || 'claude-sonnet-5-5');
}

export function modelEndpoint(env) {
  const base = String(env.MODEL_BASE_URL || 'https://tooken.club/v1')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export function catalogModelsWithSpecs() {
  return MODEL_CATALOG.map((item) => parseProviderModelItem({ id: item.id }));
}

/**
 * Fetch full model objects from `/v1/models` and merge with catalog metadata.
 */
export async function fetchProviderModels(env, { force = false } = {}) {
  if (!env.MODEL_API_KEY) fail('سرویس مدل پیکربندی نشده است.', 503, 'model_key_missing');
  const cacheKey = `${modelEndpoint(env)}:${String(env.MODEL_API_KEY).slice(0, 8)}`;
  if (!force && liveModelsCache.key === cacheKey && liveModelsCache.until > Date.now() && liveModelsCache.list.length) {
    return liveModelsCache.list;
  }

  let response;
  try {
    response = await fetch(modelEndpoint(env).replace(/\/chat\/completions$/, '/models'), {
      headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    fail('دریافت فهرست مدل‌ها ممکن نشد.', 502, 'models_unreachable');
  }
  if (!response.ok) fail('سرویس، فهرست مدل‌ها را ارائه نکرد.', 502, 'models_unavailable');
  let data;
  try {
    data = await response.json();
  } catch {
    fail('فهرست مدل‌ها نامعتبر است.', 502, 'models_bad_response');
  }
  const rawList = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
  if (!rawList) fail('فهرست مدل‌ها نامعتبر است.', 502, 'models_bad_response');

  const byId = new Map();
  for (const rawItem of rawList.slice(0, 600)) {
    const parsed = parseProviderModelItem(typeof rawItem === 'string' ? { id: rawItem } : rawItem);
    if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
  }

  // Keep featured order first for models present on the provider, then alphabetical.
  const ordered = [];
  for (const cat of MODEL_CATALOG) {
    if (byId.has(cat.id)) ordered.push(byId.get(cat.id));
  }
  const rest = [...byId.values()]
    .filter((m) => !MODEL_CATALOG.some((c) => c.id === m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const list = [...ordered, ...rest];

  liveModelsCache = {
    key: cacheKey,
    until: Date.now() + LIVE_MODELS_TTL_MS,
    byId,
    list
  };
  return list;
}

export async function listModels(env) {
  const models = await fetchProviderModels(env, { force: true });
  return models.map((m) => m.id);
}

/** Validate and normalize the tool definitions the browser may send. */
export function sanitizeTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) fail('تعریف ابزارها نامعتبر است.', 400, 'bad_tools');
  const out = [];
  const seen = new Set();
  for (const tool of tools.slice(0, 24)) {
    const fn = tool && tool.function;
    if (!fn || typeof fn.name !== 'string' || !ALLOWED_TOOLS.has(fn.name) || seen.has(fn.name)) {
      fail('ابزار ناشناخته یا تکراری است.', 400, 'bad_tools');
    }
    seen.add(fn.name);
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: String(fn.description || '').slice(0, 1000),
        parameters:
          fn.parameters && typeof fn.parameters === 'object'
            ? JSON.parse(JSON.stringify(fn.parameters))
            : { type: 'object', properties: {} }
      }
    });
  }
  return out;
}

/** Rebuild a tool call the model returned into a shape we can persist safely. */
export function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  const ids = new Set();
  for (const call of calls.slice(0, 20)) {
    const name = call?.function?.name;
    if (!ALLOWED_TOOLS.has(name)) continue;
    let id = typeof call.id === 'string' && /^[\w-]{1,128}$/.test(call.id) ? call.id : `call_${crypto.randomUUID()}`;
    while (ids.has(id)) id = `call_${crypto.randomUUID()}`;
    ids.add(id);
    let args = call.function.arguments;
    if (typeof args !== 'string') args = JSON.stringify(args ?? {});
    out.push({ id, type: 'function', function: { name, arguments: args.slice(0, 40_000) } });
  }
  return out;
}

const FALLBACK_MODELS = ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-haiku-5-5'];

function downgradeUnsupportedFileParts(messages) {
  if (!Array.isArray(messages)) return null;
  let changed = false;
  const next = messages.map((msg) => {
    if (!Array.isArray(msg?.content)) return msg;
    let msgChanged = false;
    const parts = msg.content.map((part) => {
      if (part && part.type === 'file') {
        changed = true;
        msgChanged = true;
        const name = part.file?.filename || 'attachment';
        return { type: 'text', text: `[فایل باینری پیوست‌شده: ${name}]` };
      }
      return part;
    });
    return msgChanged ? { ...msg, content: parts } : msg;
  });
  return changed ? next : null;
}

function extractReasoningAndText(message) {
  const reasoningParts = [];
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    reasoningParts.push(message.reasoning_content.trim());
  } else if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    reasoningParts.push(message.reasoning.trim());
  }

  if (typeof message.thinking === 'string' && message.thinking.trim()) {
    reasoningParts.push(message.thinking.trim());
  } else if (Array.isArray(message.thinking)) {
    for (const item of message.thinking) {
      if (typeof item?.thinking === 'string' && item.thinking.trim()) reasoningParts.push(item.thinking.trim());
    }
  } else if (typeof message.thinking?.thinking === 'string' && message.thinking.thinking.trim()) {
    reasoningParts.push(message.thinking.thinking.trim());
  }

  let contentText = '';
  if (typeof message.content === 'string') {
    contentText = message.content;
  } else if (Array.isArray(message.content)) {
    const textChunks = [];
    for (const block of message.content) {
      if (!block) continue;
      if ((block.type === 'thinking' || block.type === 'reasoning') && typeof (block.thinking || block.text) === 'string') {
        reasoningParts.push(String(block.thinking || block.text).trim());
      } else if (typeof block.text === 'string') {
        textChunks.push(block.text);
      }
    }
    contentText = textChunks.join('');
  }

  return {
    rawReasoning: [...new Set(reasoningParts)].join('\n\n'),
    rawContent: contentText
  };
}

/**
 * POST a Chat Completions request to `https://tooken.club/v1/chat/completions`
 * using the model's genuine `reasoning_effort` (`none`..`max`).
 */
export async function callModel(env, payload) {
  if (!env.MODEL_API_KEY) {
    fail('MODEL_API_KEY در Cloudflare Secrets تنظیم نشده است.', 503, 'model_key_missing');
  }
  const defaultModel = String(env.MODEL_NAME || 'claude-sonnet-5-5');
  const requestedModel = payload.model ? sanitizeModelId(payload.model, env) : defaultModel;
  const requestedEffort = normalizeReasoningEffort(payload.reasoningEffort, requestedModel, payload.thinking);
  const deepTimeout =
    requestedEffort === 'high' || requestedEffort === 'xhigh' || requestedEffort === 'max'
      ? 150_000
      : DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(Number(env.MODEL_TIMEOUT_MS) || deepTimeout, 160_000);
  const allowFailover = Boolean(env.CF_PAGES) && env.MODEL_FALLBACK !== 'off';
  const candidates = [requestedModel];
  if (allowFailover) {
    for (const candidate of FALLBACK_MODELS) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
      if (candidates.length >= 3) break;
    }
  }

  let activeMessages = payload.messages;
  let downgradedOnce = false;
  let lastStatus = 0;

  for (let cIndex = 0; cIndex < candidates.length; cIndex += 1) {
    const model = candidates[cIndex];
    const modelEffort =
      payload.reasoningEffort !== undefined || payload.thinking !== undefined
        ? normalizeReasoningEffort(payload.reasoningEffort, model, payload.thinking)
        : null;
    const wireVariants = buildReasoningWireVariants(model, modelEffort, payload);
    let variantIdx = 0;
    const maxAttempts = cIndex === 0 ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const currentVariant = wireVariants[variantIdx];
      const body = JSON.stringify({
        model,
        stream: false,
        ...currentVariant.params,
        messages: activeMessages,
        ...(payload.tools && payload.tools.length
          ? { tools: payload.tools, tool_choice: payload.tool_choice || 'auto' }
          : {})
      });

      let response;
      try {
        response = await fetch(modelEndpoint(env), {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
          headers: {
            Authorization: `Bearer ${env.MODEL_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body
        });
      } catch (error) {
        lastStatus = 0;
        if (attempt === 0) {
          await sleep(400);
          continue;
        }
        if (cIndex + 1 < candidates.length) break;
        fail(
          error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? 'پاسخ مدل در زمان مجاز دریافت نشد. دوباره تلاش کنید.'
            : 'ارتباط با سرویس مدل برقرار نشد.',
          504,
          'model_unreachable'
        );
      }

      if (response.status >= 300 && response.status < 400) {
        fail(
          'آدرس سرویس مدل ریدایرکت می‌شود. MODEL_BASE_URL را بررسی کنید (باید دقیقاً به /v1 اشاره کند).',
          502,
          'model_redirect'
        );
      }

      if (response.ok) {
        let data;
        try {
          data = await response.json();
        } catch {
          fail('پاسخ سرویس مدل قابل خواندن نبود.', 502, 'model_bad_response');
        }
        const message = data?.choices?.[0]?.message;
        if (!message || typeof message !== 'object') {
          fail('ساختار پاسخ مدل با Chat Completions سازگار نیست.', 502, 'model_bad_response');
        }
        const secrets = envSecrets(env);
        const { rawReasoning, rawContent } = extractReasoningAndText(message);
        const reasoningTokens =
          Number(
            data?.usage?.completion_tokens_details?.reasoning_tokens ??
              data?.usage?.reasoning_tokens ??
              data?.usage?.thinking_tokens
          ) || 0;

        return {
          model: String(data.model || model),
          reasoning: rawReasoning ? stripSecrets(rawReasoning, secrets) : '',
          reasoningEffort: currentVariant.effort,
          message: {
            role: 'assistant',
            content: rawContent ? stripSecrets(rawContent, secrets) : '',
            tool_calls: normalizeToolCalls(message.tool_calls)
          },
          usage: {
            prompt_tokens: Number(data?.usage?.prompt_tokens) || 0,
            completion_tokens: Number(data?.usage?.completion_tokens) || 0,
            reasoning_tokens: reasoningTokens
          }
        };
      }

      lastStatus = response.status;
      await response.text().catch(() => '');

      if (!downgradedOnce && [400, 422, 500, 502, 503].includes(response.status)) {
        const stripped = downgradeUnsupportedFileParts(activeMessages);
        if (stripped) {
          activeMessages = stripped;
          downgradedOnce = true;
          attempt -= 1;
          continue;
        }
      }

      if ((response.status === 400 || response.status === 422) && variantIdx + 1 < wireVariants.length) {
        variantIdx += 1;
        attempt -= 1;
        continue;
      }

      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const retryAfter = Number(response.headers.get('Retry-After') || 0);
        await sleep(Math.min(Math.max(retryAfter * 1000, 600), 4_000));
        continue;
      }
      break;
    }

    if (lastStatus !== 0 && lastStatus < 500) break;
  }

  if (lastStatus === 401 || lastStatus === 403) {
    fail('کلید مدل پذیرفته نشد. مقدار MODEL_API_KEY را در Cloudflare بررسی کنید.', 502, 'model_auth');
  }
  if (lastStatus === 429) fail('سرویس مدل محدودیت نرخ اعمال کرد. کمی بعد تلاش کنید.', 429, 'model_rate_limited');
  if (lastStatus === 404) {
    fail(
      'مسیر سرویس مدل پیدا نشد (404). MODEL_BASE_URL باید فقط دامنه + /v1 باشد، بدون /chat/completions.',
      502,
      'model_not_found'
    );
  }
  if (lastStatus === 400 || lastStatus === 422) {
    fail(
      `سرویس مدل درخواست را نپذیرفت (کد ${lastStatus}). احتمالاً مدل «${requestedModel}» روی این سرویس فعال نیست یا از ابزارها پشتیبانی نمی‌کند؛ مدل دیگری انتخاب کنید.`,
      502,
      'model_rejected'
    );
  }
  fail(
    `سرویس ارائه‌دهنده‌ی هوش مصنوعی موقتاً در دسترس نیست (کد ${lastStatus || 'شبکه'}). چند ثانیه بعد تلاش کنید یا از دکمه‌ی «✦ مدل» مدل دیگری انتخاب کنید.`,
    502,
    'model_failed'
  );
}
