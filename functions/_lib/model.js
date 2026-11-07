// Universal OpenAI-compatible model client + automatic per-model capability &
// Reasoning Effort discovery engine.
//
// Works out-of-the-box with `https://tooken.club/v1`, OpenRouter, OpenAI,
// DeepSeek, LiteLLM, vLLM, Groq, or any custom `/v1` gateway, and automatically
// discovers exact `reasoning_effort` levels even for brand-new unseen models.

import { fail, sleep, stripSecrets, envSecrets } from './util.js';
import {
  MAX_PROVIDER_GATEWAYS,
  gatewayHealthId,
  isOpenRouterUrl,
  isTookenUrl,
  loadCachedProviderModels,
  loadDiscoveredSpecs,
  recordGatewayOutcome,
  saveCachedProviderModels,
  saveDiscoveredSpec
} from './provider.js';
import { applyPromptCacheBreakpoints } from './token-optimizer.js';

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
  'fetch_url',
  'generate_image'
]);

export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const FULL_TOOKEN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const STANDARD_EFFORTS = ['low', 'medium', 'high'];

// Curated baseline specs for `https://tooken.club/v1` when offline or before `/v1/models` responds.
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
    id: 'gpt-6-ember',
    title: 'GPT-6 Ember',
    subtitle: 'Balanced coding & general tasks',
    label: 'GPT-6 Ember — متعادل، دقیق و همه‌کاره',
    tier: 'balanced',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'gpt-6-luna',
    title: 'GPT-6 Luna',
    subtitle: 'Fast multimodal model with full reasoning control',
    label: 'GPT-6 Luna — سریع و چندوجهی با استدلال کامل',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'deepseek-v4.1-pro-1017',
    title: 'DeepSeek V4.1 Pro 1017',
    subtitle: 'Deep mathematical & algorithmic reasoning',
    label: 'DeepSeek V4.1 Pro — تفکر عمیق الگوریتمی و ریاضی',
    tier: 'reasoning',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'deepseek-v4.1-1017',
    title: 'DeepSeek V4.1 1017',
    subtitle: 'Fast software engineering & code editing',
    label: 'DeepSeek V4.1 — کدنویسی و ویرایش دقیق',
    tier: 'coding',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'deepseek-v4.1-flash-1017',
    title: 'DeepSeek V4.1 Flash 1017',
    subtitle: 'High-speed coding with full reasoning effort range',
    label: 'DeepSeek V4.1 Flash — پاسخ بسیار سریع با استدلال کامل',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'gemini-4-argon',
    title: 'Gemini 4 Argon',
    subtitle: '1M context analysis',
    label: 'Gemini 4 Argon — تحلیل زمینه‌های طولانی (۱M توکن)',
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
    id: 'gemini-3-8-pro',
    title: 'Gemini 3.8 Pro',
    subtitle: 'Multimodal & full-stack engineering',
    label: 'Gemini 3.8 Pro — چندوجهی و مهندسی وب',
    tier: 'balanced',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
    vision: true,
    tools: true,
    reasoningLevels: STANDARD_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'gemini-3-8-flash',
    title: 'Gemini 3.8 Flash',
    subtitle: 'Lightweight & fast responses',
    label: 'Gemini 3.8 Flash — سبک و کم‌تأخیر',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_768,
    vision: true,
    tools: true,
    reasoningLevels: STANDARD_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'grok-4.4',
    title: 'Grok 4.4',
    subtitle: 'Analytical problem solving & debugging',
    label: 'Grok 4.4 — تحلیل مستقیم و حل مسئله',
    tier: 'reasoning',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  },
  {
    id: 'grok-4.4-astra',
    title: 'Grok 4.4 Astra',
    subtitle: 'Fast code & shell assistant',
    label: 'Grok 4.4 Astra — نسخه سریع و چابک',
    tier: 'fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'low'
  },
  {
    id: 'kimi-k2.7-pro',
    title: 'Kimi K2.7 Pro',
    subtitle: 'Long-horizon agentic coding',
    label: 'Kimi K2.7 Pro — برنامه‌ریزی و کدنویسی چندمرحله‌ای',
    tier: 'reasoning',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'high'
  },
  {
    id: 'glm-5.2',
    title: 'GLM 5.2',
    subtitle: 'Multilingual & structured engineering',
    label: 'GLM 5.2 — چندزبانه و دقیق در ابزارها',
    tier: 'coding',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    vision: false,
    tools: true,
    reasoningLevels: FULL_TOOKEN_EFFORTS,
    defaultEffort: 'medium'
  }
];

const CATALOG_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
const MODEL_ID_RE = /^[a-zA-Z0-9._:@/-]{1,160}$/;
const EMBEDDING_FILTER_RE = /(?:^|[-_/:])(whisper|tts|dall-e|moderation|rerank|bge-|text-embedding|embedding)(?:$|[-_/:])/i;
const NON_REASONING_LEGACY_RE =
  /^(gpt-3\.5|gpt-4o|gpt-4-turbo|chatgpt-4o|claude-2|claude-3-(?:haiku|sonnet|opus)|claude-3-5-(?:haiku|sonnet)|llama-3\.[012]|mistral-(?:tiny|small|7b)|qwen2\.5-(?!.*qwq))/i;
const REASONING_FAMILY_RE =
  /(?:^|[-_/:])(o1|o3|o4|gpt-5|gpt-6|claude-(?:3-7|4|5|opus|sonnet|fable)|deepseek-(?:r1|reasoner|v4)|qwq|kimi-k2|grok-[34]|gemini-(?:2\.5|3|4)|glm-[45])/i;
const OPENROUTER_PRIORITY_RE =
  /^(?:@preset\/|openrouter\/|anthropic\/|openai\/|google\/|deepseek\/|qwen\/|x-ai\/|mistralai\/|meta-llama\/|moonshotai\/|z-ai\/|cohere\/)/i;
const OPENROUTER_FEATURED_RE =
  /^(?:openrouter\/auto|anthropic\/claude-(?:sonnet-4|opus-4|3\.7-sonnet|3\.5-sonnet)|openai\/(?:gpt-5|gpt-4\.1|gpt-4o|o3|o4-mini)|google\/gemini-(?:2\.5-pro|2\.5-flash|3)|deepseek\/deepseek-(?:chat|r1)|qwen\/qwen3-coder)/i;
const OPENROUTER_PREFERRED_DEFAULTS = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.7-sonnet',
  'openai/gpt-5',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'google/gemini-2.5-pro',
  'deepseek/deepseek-chat-v3-0324',
  'deepseek/deepseek-chat',
  'openrouter/auto'
];
const OPENROUTER_FALLBACK_IDS = [
  { id: 'openrouter/auto', name: 'OpenRouter Auto (Best Router)', context_length: 200_000, featured: true, pricingTier: 'auto' },
  { id: 'openrouter/free', name: 'OpenRouter Free Router (:free)', context_length: 128_000, featured: true, pricing: { prompt: '0', completion: '0' } },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context_length: 200_000, featured: true, pricingTier: 'paid' },
  { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', context_length: 200_000, featured: true, pricingTier: 'paid' },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1', context_length: 1_000_000, featured: true, pricingTier: 'paid' },
  { id: 'openai/o4-mini', name: 'OpenAI o4-mini', context_length: 200_000, featured: true, pricingTier: 'paid' },
  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', context_length: 1_000_000, featured: true, pricingTier: 'paid' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', context_length: 1_000_000, featured: true, pricingTier: 'paid' },
  { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', context_length: 128_000, featured: true, pricingTier: 'paid' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', context_length: 128_000, featured: true, pricingTier: 'paid' },
  { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder', context_length: 256_000, featured: true, pricingTier: 'paid' }
];
const DEFAULT_TIMEOUT_MS = 95_000;
const LIVE_MODELS_TTL_MS = 5 * 60 * 1000;

export function providerExtraHeaders(baseUrl) {
  if (isOpenRouterUrl(baseUrl)) {
    return {
      'HTTP-Referer': 'https://codepilot.pages.dev',
      'X-Title': 'CodePilot'
    };
  }
  return {};
}

export function pickSmartProviderDefaultModel(baseUrl, byId = null, explicitDefault = '') {
  const cleanExplicit = String(explicitDefault || '').trim();
  if (cleanExplicit && cleanExplicit !== 'claude-sonnet-5-5') return cleanExplicit;
  if (isTookenUrl(baseUrl)) return cleanExplicit || 'claude-sonnet-5-5';

  if (isOpenRouterUrl(baseUrl)) {
    if (byId && byId.size > 0) {
      for (const pref of OPENROUTER_PREFERRED_DEFAULTS) {
        if (byId.has(pref)) return pref;
      }
      for (const id of byId.keys()) {
        if (OPENROUTER_FEATURED_RE.test(id)) return id;
      }
      return byId.keys().next().value || 'openrouter/auto';
    }
    return 'openrouter/auto';
  }

  if (byId && byId.size > 0) {
    if (cleanExplicit && byId.has(cleanExplicit)) return cleanExplicit;
    if (byId.has('deepseek-v4.1-flash')) return 'deepseek-v4.1-flash';
    return byId.keys().next().value || cleanExplicit || 'gpt-4o';
  }
  return cleanExplicit || 'gpt-4o';
}

// Keyed by normalized base URL so switching providers never mixes model lists.
const liveModelsByEndpoint = new Map();
const liveQuotaByKey = new Map();
const latestRateLimitByEndpoint = new Map();
const QUOTA_TTL_MS = 60_000;

export function extractRateLimitHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const pickNum = (names) => {
    for (const name of names) {
      const raw = headers.get(name);
      if (raw !== null && raw !== undefined && raw !== '') {
        const num = Number(String(raw).trim());
        if (Number.isFinite(num) && num >= 0) return num;
      }
    }
    return null;
  };
  const remainingTokens = pickNum([
    'x-ratelimit-remaining-tokens',
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-input-tokens-remaining',
    'llm-provider-x-ratelimit-remaining-tokens',
    'x-remaining-tokens',
    'x-tokens-remaining',
    'x-quota-remaining'
  ]);
  const limitTokens = pickNum([
    'x-ratelimit-limit-tokens',
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-input-tokens-limit',
    'x-token-limit',
    'x-quota-limit'
  ]);
  const remainingRequests = pickNum([
    'x-ratelimit-remaining-requests',
    'anthropic-ratelimit-requests-remaining',
    'x-remaining-requests'
  ]);
  const resetTokens =
    headers.get('x-ratelimit-reset-tokens') || headers.get('anthropic-ratelimit-tokens-reset') || null;

  if (remainingTokens === null && limitTokens === null && remainingRequests === null) return null;
  return {
    remainingTokens,
    limitTokens,
    remainingRequests,
    resetTokens: resetTokens ? String(resetTokens).slice(0, 40) : null,
    at: Date.now()
  };
}

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    let cleaned = v.trim();
    if (!cleaned) return null;
    // Strip currency symbols and thousand-separator spaces/NBSPs (e.g. "4 850 000" or "142,50 ₽")
    cleaned = cleaned.replace(/[₽$€¥£\s\u00A0]/g, '');
    if (/^-?\d+,\d{1,6}$/.test(cleaned)) {
      cleaned = cleaned.replace(',', '.');
    } else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, '');
    }
    if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = toNum(v);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Extract strictly non-sensitive numeric/boolean/currency metrics (up to 4 levels deep)
 * so the UI can display exact provider numbers without ever exposing IDs, keys, or strings.
 */
function extractSafeMetrics(raw, depth = 0) {
  if (!raw || typeof raw !== 'object' || depth > 4) return null;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (count >= 40) break;
    if (/secret|password|hash|jwt|cookie|authorization/i.test(k)) continue;
    if (typeof v === 'boolean') {
      out[k] = v;
      count += 1;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
      count += 1;
    } else if (typeof v === 'string') {
      const trimmed = v.trim();
      if (/^(RUB|USD|EUR|CNY|GBP|USDT|KZT|BYN|TRY|AED|IRR|tokens|rub|usd)$/i.test(trimmed)) {
        out[k] = trimmed.toUpperCase();
        count += 1;
      } else if (!/id$/i.test(k)) {
        const n = toNum(trimmed);
        if (n !== null) {
          out[k] = n;
          count += 1;
        }
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 4) {
      const sub = extractSafeMetrics(v, depth + 1);
      if (sub && Object.keys(sub).length > 0) {
        out[k] = sub;
        count += 1;
      }
    } else if (Array.isArray(v) && depth < 3 && v.length > 0 && v[0] && typeof v[0] === 'object') {
      const arr = v.slice(0, 3).map((item) => extractSafeMetrics(item, depth + 1)).filter(Boolean);
      if (arr.length > 0) {
        out[k] = arr;
        count += 1;
      }
    }
  }
  return count > 0 ? out : null;
}

function parseProviderUsageObject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  const totalsObj =
    (obj.activity30d && typeof obj.activity30d === 'object' ? obj.activity30d : null) ||
    (obj.totals && typeof obj.totals === 'object' ? obj.totals : null) ||
    (obj.summary && typeof obj.summary === 'object' ? obj.summary : null) ||
    (obj.usage && typeof obj.usage === 'object' ? obj.usage : null);

  const promptTokens = firstNum(
    obj.prompt_tokens,
    obj.input_tokens,
    obj.inputTokens,
    obj.total_prompt_tokens,
    obj.total_input_tokens,
    totalsObj?.prompt_tokens,
    totalsObj?.input_tokens,
    totalsObj?.inputTokens
  );
  const completionTokens = firstNum(
    obj.completion_tokens,
    obj.output_tokens,
    obj.outputTokens,
    obj.total_completion_tokens,
    obj.total_output_tokens,
    totalsObj?.completion_tokens,
    totalsObj?.output_tokens,
    totalsObj?.outputTokens
  );
  const cacheReadTokens = firstNum(
    obj.cache_read_input_tokens,
    obj.cacheReadInputTokens,
    obj.cached_tokens,
    totalsObj?.cache_read_input_tokens,
    totalsObj?.cacheReadInputTokens,
    totalsObj?.cached_tokens
  );
  const reasoningTokens = firstNum(
    obj.reasoning_tokens,
    obj.total_reasoning_tokens,
    totalsObj?.reasoning_tokens,
    totalsObj?.reasoningTokens
  );
  const totalTokens = firstNum(
    obj.total_tokens,
    obj.totalTokens,
    obj.tokens_used,
    obj.used_tokens,
    obj.tokens,
    totalsObj?.total_tokens,
    totalsObj?.totalTokens,
    totalsObj?.tokens,
    promptTokens !== null || completionTokens !== null
      ? (promptTokens || 0) + (completionTokens || 0) + (reasoningTokens || 0)
      : null
  );
  const requests = firstNum(
    obj.requests,
    obj.total_requests,
    obj.request_count,
    obj.count,
    totalsObj?.requests,
    totalsObj?.modelRequests,
    totalsObj?.total_requests,
    totalsObj?.count
  );
  const totalCost = firstNum(
    obj.total_cost,
    obj.cost,
    obj.spent,
    obj.spend,
    obj.total_spent,
    obj.total_usage_usd,
    totalsObj?.total_cost,
    totalsObj?.cost,
    totalsObj?.spent,
    totalsObj?.spend
  );
  const currency =
    String(obj.currency || obj.billing?.currency || totalsObj?.currency || '').trim().toUpperCase() || null;

  if (totalTokens === null && requests === null && totalCost === null) return null;
  return {
    ...(totalTokens !== null ? { totalTokens: Math.round(totalTokens) } : {}),
    ...(promptTokens !== null ? { promptTokens: Math.round(promptTokens) } : {}),
    ...(completionTokens !== null ? { completionTokens: Math.round(completionTokens) } : {}),
    ...(cacheReadTokens !== null ? { cacheReadTokens: Math.round(cacheReadTokens) } : {}),
    ...(reasoningTokens !== null ? { reasoningTokens: Math.round(reasoningTokens) } : {}),
    ...(requests !== null ? { requests: Math.round(requests) } : {}),
    ...(totalCost !== null ? { totalCost: Number(totalCost.toFixed(6)) } : {}),
    ...(currency ? { currency } : {})
  };
}

function parseQuotaFromObject(raw, sourceLabel = 'provider', defaultCurrency = 'USD') {
  if (!raw || typeof raw !== 'object' || raw.error) return null;
  const obj = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  const info = obj.info && typeof obj.info === 'object' ? obj.info : obj;
  const balObj = obj.balance && typeof obj.balance === 'object' && !Array.isArray(obj.balance) ? obj.balance : null;
  const tokObj = obj.tokens && typeof obj.tokens === 'object' && !Array.isArray(obj.tokens) ? obj.tokens : null;
  const bonusObj = obj.bonus && typeof obj.bonus === 'object' && !Array.isArray(obj.bonus) ? obj.bonus : null;
  const keyObj =
    (obj.key && typeof obj.key === 'object' && !Array.isArray(obj.key) ? obj.key : null) ||
    (obj.api_key && typeof obj.api_key === 'object' && !Array.isArray(obj.api_key) ? obj.api_key : null);

  // 1. Explicit unlimited flag or huge sentinel limit (OneAPI / NewAPI)
  if (
    obj.unlimited_quota === true ||
    obj.is_unlimited === true ||
    obj.unlimited === true ||
    (toNum(obj.hard_limit_usd) !== null && toNum(obj.hard_limit_usd) >= 99_999_999)
  ) {
    return { supported: true, unlimited: true, source: sourceLabel };
  }

  // 1b. Zro by MoonMath (`/api/cli/status` — supports both nested `billing.*` and top-level `freeUsage`/`spendQuota`/`usagePacks`)
  if (
    (obj.billing && typeof obj.billing === 'object') ||
    (obj.freeUsage && typeof obj.freeUsage === 'object') ||
    (obj.spendQuota && typeof obj.spendQuota === 'object')
  ) {
    const b = obj.billing && typeof obj.billing === 'object' ? obj.billing : {};
    const cur = String(b.currency || obj.currency || defaultCurrency).trim().toUpperCase();
    const planObj = b.plan && typeof b.plan === 'object' ? b.plan : null;
    const planStrRaw =
      typeof obj.plan === 'string'
        ? obj.plan
        : typeof b.plan === 'string'
          ? b.plan
          : typeof planObj?.id === 'string'
            ? planObj.id
            : '';
    const planName = planStrRaw ? planStrRaw.trim().toLowerCase().slice(0, 32) : '';

    const packsObj =
      (b.usagePacks && typeof b.usagePacks === 'object' ? b.usagePacks : null) ||
      (obj.usagePacks && typeof obj.usagePacks === 'object' ? obj.usagePacks : null);
    const freeObj =
      (b.free && typeof b.free === 'object' ? b.free : null) ||
      (obj.freeUsage && typeof obj.freeUsage === 'object' ? obj.freeUsage : null);
    const spendObj = obj.spendQuota && typeof obj.spendQuota === 'object' ? obj.spendQuota : null;
    const act = obj.activity30d && typeof obj.activity30d === 'object' ? obj.activity30d : null;

    const freeRemPct = toNum(freeObj?.remainingPercent ?? freeObj?.remaining_percent);
    const freeResetsAt =
      typeof freeObj?.windowResetsAt === 'string'
        ? freeObj.windowResetsAt.slice(0, 40)
        : typeof freeObj?.resetsAt === 'string'
          ? freeObj.resetsAt.slice(0, 40)
          : null;

    const packsRem = toNum(packsObj?.remainingUsd ?? packsObj?.remaining);
    const spendRem = toNum(spendObj?.remainingUsd ?? spendObj?.remaining ?? planObj?.remaining);
    const explicitTotalRem = toNum(b.totalRemaining ?? b.total_remaining);
    const totalRem =
      explicitTotalRem !== null
        ? explicitTotalRem
        : spendRem !== null || packsRem !== null
          ? (spendRem || 0) + (packsRem || 0)
          : null;

    const planLim = toNum(spendObj?.limitUsd ?? planObj?.allowance ?? freeObj?.limitUsd) || 0;
    const packsLim = toNum(packsObj?.totalUsd ?? packsObj?.total) || 0;
    const totalLim = planLim + packsLim;

    const planUsed = toNum(spendObj?.usedUsd ?? planObj?.used ?? freeObj?.usedUsd) || 0;
    const packsUsed = toNum(packsObj?.usedUsd ?? packsObj?.used) || 0;
    const actSpend = toNum(act?.spend);
    const totalUsedMoney = planUsed + packsUsed > 0 ? planUsed + packsUsed : actSpend;
    const usedTok30d = firstNum(
      act?.totalTokens,
      act?.total_tokens,
      act && (toNum(act.inputTokens) !== null || toNum(act.outputTokens) !== null)
        ? (toNum(act.inputTokens) || 0) + (toNum(act.outputTokens) || 0)
        : null
    );

    if (totalRem !== null || freeRemPct !== null || planObj !== null || planName) {
      return {
        supported: true,
        unlimited: false,
        ...(planName ? { plan: planName } : {}),
        ...(freeRemPct !== null
          ? { remainingPercent: Math.max(0, Math.min(100, Number(freeRemPct.toFixed(1)))) }
          : {}),
        ...(freeResetsAt ? { windowResetsAt: freeResetsAt } : {}),
        ...(totalRem !== null && totalRem >= 0 ? { remainingBalance: Number(totalRem.toFixed(4)) } : {}),
        ...(packsRem !== null && packsRem > 0 ? { packsRemainingUsd: Number(packsRem.toFixed(4)) } : {}),
        ...(totalLim > 0 ? { limitBalance: Number(totalLim.toFixed(4)) } : {}),
        ...(totalUsedMoney !== null && totalUsedMoney >= 0
          ? { usedBalance: Number(totalUsedMoney.toFixed(4)) }
          : {}),
        ...(usedTok30d !== null && usedTok30d >= 0 ? { usedTokens: Math.floor(usedTok30d) } : {}),
        currency: cur || 'USD',
        source: sourceLabel
      };
    }
  }

  // 2. DeepSeek `/user/balance` format (`balance_infos: [{ currency, total_balance }]`)
  if (Array.isArray(obj.balance_infos) && obj.balance_infos.length > 0) {
    const b = obj.balance_infos.find((x) => x?.currency === 'USD') || obj.balance_infos[0];
    const bal = toNum(b?.total_balance);
    if (bal !== null) {
      return {
        supported: true,
        unlimited: false,
        remainingBalance: bal,
        currency: String(b.currency || defaultCurrency).toUpperCase(),
        source: sourceLabel
      };
    }
  }

  // 3. OpenRouter `/credits` (`total_credits`, `total_usage`) or `/key` (`limit`, `limit_remaining`, `usage`)
  const orTotalCredits = toNum(obj.total_credits);
  const orTotalUsage = toNum(obj.total_usage);
  if (orTotalCredits !== null && orTotalUsage !== null) {
    return {
      supported: true,
      unlimited: false,
      remainingBalance: Math.max(0, Number((orTotalCredits - orTotalUsage).toFixed(4))),
      limitBalance: orTotalCredits,
      usedBalance: orTotalUsage,
      currency: 'USD',
      source: sourceLabel
    };
  }
  if (obj.limit !== undefined && (toNum(obj.limit_remaining) !== null || obj.limit === null)) {
    const lr = toNum(obj.limit_remaining);
    const lim = toNum(obj.limit);
    const usg = toNum(obj.usage);
    if (obj.limit === null && usg !== null && obj.balance === undefined && obj.remaining_tokens === undefined) {
      return {
        supported: true,
        unlimited: true,
        usedBalance: usg,
        currency: 'USD',
        source: sourceLabel
      };
    }
    if (lr !== null) {
      return {
        supported: true,
        unlimited: false,
        remainingBalance: Math.max(0, Number(lr.toFixed(4))),
        ...(lim !== null ? { limitBalance: lim } : {}),
        ...(usg !== null ? { usedBalance: usg } : {}),
        currency: String(obj.currency || defaultCurrency).toUpperCase(),
        source: sourceLabel
      };
    }
  }

  // 4. LiteLLM `/key/info` (`max_budget`, `spend`)
  const maxBudget = toNum(info.max_budget);
  if (maxBudget !== null && maxBudget > 0) {
    const spend = toNum(info.spend) || 0;
    return {
      supported: true,
      unlimited: false,
      remainingBalance: Math.max(0, Number((maxBudget - spend).toFixed(4))),
      limitBalance: maxBudget,
      usedBalance: spend,
      currency: String(info.currency || defaultCurrency).toUpperCase(),
      source: sourceLabel
    };
  }

  // 5. NewAPI / OneAPI `/api/usage/token` (`total_granted`, `total_used`, `total_available`)
  const totalAvail = toNum(obj.total_available);
  const totalGranted = toNum(obj.total_granted);
  const totalUsed = toNum(obj.total_used);
  if (totalAvail !== null && totalAvail >= 0 && obj.balance === undefined && obj.bonus_tokens === undefined) {
    const isQuotaUnits = totalAvail >= 10_000 || (totalGranted !== null && totalGranted >= 10_000);
    if (isQuotaUnits) {
      return {
        supported: true,
        unlimited: false,
        remainingTokens: Math.floor(totalAvail),
        ...(totalGranted !== null ? { limitTokens: Math.floor(totalGranted) } : {}),
        ...(totalUsed !== null ? { usedTokens: Math.floor(totalUsed) } : {}),
        remainingBalance: Number((totalAvail / 500_000).toFixed(2)),
        currency: 'USD',
        source: sourceLabel
      };
    }
    return {
      supported: true,
      unlimited: false,
      remainingBalance: Number(totalAvail.toFixed(4)),
      ...(totalGranted !== null ? { limitBalance: totalGranted } : {}),
      ...(totalUsed !== null ? { usedBalance: totalUsed } : {}),
      currency: String(obj.currency || defaultCurrency).toUpperCase(),
      source: sourceLabel
    };
  }

  // 6. Tooken Club (`/v1/balance`) & universal token + monetary balance payloads
  // Extract BOTH token balance (e.g. bonus_tokens / remaining_tokens) AND monetary balance (e.g. RUB / USD)!
  const directRemTok = firstNum(
    obj.remaining_tokens,
    obj.tokens_remaining,
    obj.available_tokens,
    obj.tokens_available,
    obj.token_balance,
    obj.tokens_balance,
    obj.total_tokens_remaining,
    obj.left_tokens,
    obj.remain_tokens,
    obj.tokens_left,
    tokObj?.remaining,
    tokObj?.available,
    tokObj?.balance,
    balObj?.remaining_tokens,
    balObj?.tokens_remaining,
    balObj?.tokens,
    typeof obj.tokens !== 'object' ? obj.tokens : null
  );
  const bonusTok = firstNum(
    obj.bonus_tokens_remaining,
    obj.bonus_tokens_available,
    obj.bonus_tokens,
    obj.free_tokens_remaining,
    obj.free_tokens,
    tokObj?.bonus,
    bonusObj?.remaining,
    bonusObj?.available,
    bonusObj?.tokens
  );
  const paidTok = firstNum(obj.paid_tokens_remaining, obj.paid_tokens, tokObj?.paid);
  const limTok = firstNum(
    obj.token_limit,
    obj.tokens_limit,
    obj.max_tokens_quota,
    obj.total_tokens_limit,
    obj.granted_tokens,
    obj.initial_tokens,
    tokObj?.limit,
    tokObj?.granted,
    tokObj?.total,
    keyObj?.token_limit,
    keyObj?.tokens_limit
  );
  const usedTok = firstNum(
    obj.tokens_used,
    obj.used_tokens,
    obj.total_tokens_used,
    obj.spent_tokens,
    tokObj?.used,
    tokObj?.spent
  );

  let remTok = directRemTok;
  if (remTok === null && bonusTok !== null) {
    remTok = bonusTok + (paidTok && paidTok > 0 ? paidTok : 0);
  } else if (remTok === null && limTok !== null && limTok > 0 && usedTok !== null && usedTok >= 0) {
    remTok = Math.max(0, limTok - usedTok);
  }
  const keyRemTok = firstNum(obj.key_tokens_remaining, keyObj?.remaining_tokens, keyObj?.tokens_remaining);
  if (keyRemTok !== null && keyRemTok >= 0 && (remTok === null || keyRemTok < remTok)) {
    remTok = keyRemTok;
  }

  const detectedCurrency = String(
    obj.currency || balObj?.currency || keyObj?.currency || defaultCurrency
  )
    .trim()
    .toUpperCase();

  const spendableBal = firstNum(
    obj.available_balance,
    obj.spendable_balance,
    obj.effective_balance,
    balObj?.available,
    balObj?.spendable,
    obj.currency || balObj ? obj.available : null,
    obj.remaining_balance,
    obj.balance_remaining,
    obj.credit_balance,
    balObj?.remaining,
    balObj?.amount,
    balObj?.balance,
    typeof obj.balance !== 'object' ? obj.balance : null,
    obj.credits
  );
  const reservedBal = firstNum(
    obj.reserved_balance,
    obj.reserved,
    obj.hold_balance,
    obj.hold,
    balObj?.reserved,
    balObj?.hold
  );
  const limitBal = firstNum(
    obj.balance_limit,
    obj.credit_limit,
    obj.key_limit,
    balObj?.limit,
    keyObj?.limit,
    typeof obj.limit !== 'object' ? obj.limit : null
  );
  const usedBal = firstNum(
    obj.used_balance,
    obj.spent_balance,
    obj.spent,
    obj.total_spent,
    balObj?.used,
    balObj?.spent,
    keyObj?.spent,
    keyObj?.used
  );
  const keyRemBal = firstNum(obj.key_remaining, keyObj?.remaining, keyObj?.available);

  let effectiveBal = spendableBal;
  if (keyRemBal !== null && keyRemBal >= 0 && (effectiveBal === null || keyRemBal < effectiveBal)) {
    effectiveBal = keyRemBal;
  }

  if ((remTok !== null && remTok >= 0) || (effectiveBal !== null && effectiveBal >= 0)) {
    return {
      supported: true,
      unlimited: false,
      ...(remTok !== null && remTok >= 0 ? { remainingTokens: Math.floor(remTok) } : {}),
      ...(bonusTok !== null && bonusTok >= 0 ? { bonusTokens: Math.floor(bonusTok) } : {}),
      ...(limTok !== null && limTok > 0 ? { limitTokens: Math.floor(limTok) } : {}),
      ...(usedTok !== null && usedTok >= 0 ? { usedTokens: Math.floor(usedTok) } : {}),
      ...(effectiveBal !== null && effectiveBal >= 0 ? { remainingBalance: Number(effectiveBal.toFixed(4)) } : {}),
      ...(reservedBal !== null && reservedBal > 0 ? { reservedBalance: Number(reservedBal.toFixed(4)) } : {}),
      ...(limitBal !== null && limitBal > 0 ? { limitBalance: Number(limitBal.toFixed(4)) } : {}),
      ...(usedBal !== null && usedBal >= 0 ? { usedBalance: Number(usedBal.toFixed(4)) } : {}),
      currency: detectedCurrency || defaultCurrency,
      source: sourceLabel
    };
  }

  return null;
}

export function getCachedProviderQuota(env = {}) {
  const endpoint = modelEndpoint(env);
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const cacheKey = `${baseUrl}:${String(env.MODEL_API_KEY || '').slice(0, 10)}`;
  const cached = liveQuotaByKey.get(cacheKey);
  const rateLimit = latestRateLimitByEndpoint.get(baseUrl) || null;
  if (cached && cached.until > Date.now()) {
    return { ...cached.data, rateLimit };
  }
  return rateLimit ? { supported: false, rateLimit } : null;
}

/**
 * Query the active API provider's real remaining token / credit quota endpoints
 * (`tooken.club`, OneAPI/NewAPI, OpenRouter, DeepSeek, LiteLLM, OpenAI billing).
 */
export async function fetchProviderQuota(env, { force = false } = {}) {
  if (!env?.MODEL_API_KEY) {
    return { supported: false, reason: 'no_api_key', rateLimit: null };
  }
  const endpoint = modelEndpoint(env);
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const cacheKey = `${baseUrl}:${String(env.MODEL_API_KEY).slice(0, 10)}`;
  const rateLimit = latestRateLimitByEndpoint.get(baseUrl) || null;

  if (!force) {
    const cached = liveQuotaByKey.get(cacheKey);
    if (cached && cached.until > Date.now()) {
      return { ...cached.data, rateLimit };
    }
  }

  let originUrl = baseUrl;
  try {
    originUrl = new URL(baseUrl).origin;
  } catch {
    originUrl = baseUrl;
  }

  const headers = {
    Authorization: `Bearer ${env.MODEL_API_KEY}`,
    Accept: 'application/json',
    ...providerExtraHeaders(baseUrl)
  };
  const probes = [];
  const extractQuotaHeaders = (hdrs) => {
    if (!hdrs || typeof hdrs.forEach !== 'function') return null;
    const out = {};
    let found = 0;
    hdrs.forEach((val, key) => {
      const k = String(key).toLowerCase();
      if (/(?:token|quota|balance|credit|ratelimit|remain|limit)/i.test(k) && !/auth|cookie|key|id/i.test(k)) {
        const n = toNum(val);
        out[k] = n !== null ? n : String(val).slice(0, 32);
        found += 1;
      }
    });
    return found > 0 ? out : null;
  };
  const safeGetJson = async (url, label = '') => {
    const tag = label || (() => { try { return new URL(url).pathname; } catch { return url; } })();
    try {
      const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(8_000) });
      const qHeaders = extractQuotaHeaders(res.headers);
      const bodyJson = await res.json().catch(() => null);
      probes.push({
        path: tag,
        status: res.status,
        ...(bodyJson && typeof bodyJson === 'object'
          ? {
              topKeys: Object.keys(bodyJson).slice(0, 16),
              ...(bodyJson.data && typeof bodyJson.data === 'object' && !Array.isArray(bodyJson.data)
                ? { dataKeys: Object.keys(bodyJson.data).slice(0, 16) }
                : {}),
              ...(bodyJson.error && typeof bodyJson.error === 'object'
                ? {
                    errorCode: String(bodyJson.error.code || bodyJson.error.type || '').slice(0, 40),
                    errorOrigin: String(bodyJson.error.origin || '').slice(0, 24)
                  }
                : {})
            }
          : {}),
        ...(qHeaders ? { headers: qHeaders } : {})
      });
      if (!res.ok) return null;
      return bodyJson;
    } catch (err) {
      probes.push({ path: tag, status: 0, errorCode: String(err?.name || 'fetch_error').slice(0, 32) });
      return null;
    }
  };

  let result = null;
  let providerUsage = null;
  let rawMetrics = null;
  const lowerBase = baseUrl.toLowerCase();
  const hostName = (() => {
    try { return new URL(baseUrl).hostname; } catch { return 'provider'; }
  })();

  if (lowerBase.includes('openrouter.ai')) {
    const [creditsJson, keyJson] = await Promise.all([
      safeGetJson(`${baseUrl}/credits`, '/credits'),
      safeGetJson(`${baseUrl}/key`, '/key')
    ]);
    rawMetrics = extractSafeMetrics(creditsJson) || extractSafeMetrics(keyJson);
    result =
      parseQuotaFromObject(creditsJson, 'openrouter.ai/api/v1/credits', 'USD') ||
      parseQuotaFromObject(keyJson, 'openrouter.ai/api/v1/key', 'USD');
    // Respect stricter per-key cap if set on `/key`
    const keyParsed = parseQuotaFromObject(keyJson, 'openrouter.ai/api/v1/key', 'USD');
    if (result && keyParsed && !keyParsed.unlimited && typeof keyParsed.remainingBalance === 'number') {
      if (typeof result.remainingBalance !== 'number' || keyParsed.remainingBalance < result.remainingBalance) {
        result = keyParsed;
      }
    }
    const keyData = keyJson?.data && typeof keyJson.data === 'object' ? keyJson.data : keyJson;
    const isFreeTier =
      keyData?.is_free_tier === true ||
      (result && typeof result.limitBalance === 'number' && result.limitBalance < 10 && keyData?.is_free_tier !== false);
    if (isFreeTier) {
      if (!result) {
        result = {
          supported: true,
          unlimited: false,
          remainingBalance: 0,
          currency: 'USD',
          source: 'openrouter.ai/api/v1/key'
        };
      }
      result.isFreeTier = true;
      result.dailyRequestLimit = Number(keyData?.rate_limit?.requests_per_day) || 50;
    }
  } else if (lowerBase.includes('deepseek.com')) {
    const dsJson = await safeGetJson(`${originUrl}/user/balance`, '/user/balance');
    rawMetrics = extractSafeMetrics(dsJson);
    result = parseQuotaFromObject(dsJson, 'api.deepseek.com/user/balance', 'USD');
  } else if (lowerBase.includes('moonmath.ai')) {
    // Zro by MoonMath (`https://zro.moonmath.ai/api/cli/status`)
    const cliStatusJson = await safeGetJson(`${originUrl}/api/cli/status`, '/api/cli/status');
    rawMetrics = extractSafeMetrics(cliStatusJson);
    providerUsage = parseProviderUsageObject(cliStatusJson);
    result = parseQuotaFromObject(cliStatusJson, `${hostName}/api/cli/status`, 'USD');
  } else if (lowerBase.includes('tooken.club')) {
    // Native Tooken Club live balance & usage endpoints (`/v1/balance` + `/v1/usage`)
    const [v1BalanceJson, v1UsageJson] = await Promise.all([
      safeGetJson(`${baseUrl}/balance`, '/v1/balance'),
      safeGetJson(`${baseUrl}/usage`, '/v1/usage')
    ]);
    rawMetrics = extractSafeMetrics(v1BalanceJson) || extractSafeMetrics(v1UsageJson);
    providerUsage = parseProviderUsageObject(v1UsageJson);
    result = parseQuotaFromObject(v1BalanceJson, `${hostName}/v1/balance`, 'RUB');
    if (result && providerUsage && result.usedTokens === undefined && providerUsage.totalTokens !== undefined) {
      result.usedTokens = providerUsage.totalTokens;
    }
  } else {
    // Universal probe for OneAPI/NewAPI, LiteLLM, Zro-compatible `/api/cli/status`, Tooken-like `/v1/balance`, and OpenAI gateways
    const now = new Date();
    const start = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const end = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);

    const [
      cliStatusJson,
      v1BalanceJson,
      v1UsageJson,
      tokenUsageJson,
      subJson,
      billUsageJson,
      creditGrantsJson,
      keyInfoJson
    ] = await Promise.all([
      safeGetJson(`${originUrl}/api/cli/status`, '/api/cli/status'),
      safeGetJson(`${baseUrl}/balance`, '/v1/balance'),
      safeGetJson(`${baseUrl}/usage`, '/v1/usage'),
      safeGetJson(`${originUrl}/api/usage/token`, '/api/usage/token'),
      safeGetJson(`${baseUrl}/dashboard/billing/subscription`, '/dashboard/billing/subscription'),
      safeGetJson(`${baseUrl}/dashboard/billing/usage?start_date=${start}&end_date=${end}`, '/dashboard/billing/usage'),
      safeGetJson(`${baseUrl}/dashboard/billing/credit_grants`, '/dashboard/billing/credit_grants'),
      safeGetJson(`${originUrl}/key/info`, '/key/info')
    ]);

    providerUsage = parseProviderUsageObject(cliStatusJson) || parseProviderUsageObject(v1UsageJson);
    rawMetrics =
      extractSafeMetrics(cliStatusJson) ||
      extractSafeMetrics(v1BalanceJson) ||
      extractSafeMetrics(tokenUsageJson) ||
      extractSafeMetrics(subJson) ||
      extractSafeMetrics(creditGrantsJson) ||
      extractSafeMetrics(keyInfoJson);

    result =
      parseQuotaFromObject(cliStatusJson, `${hostName}/api/cli/status`, 'USD') ||
      parseQuotaFromObject(v1BalanceJson, `${hostName}/v1/balance`, 'USD') ||
      parseQuotaFromObject(tokenUsageJson, `${hostName}/api/usage/token`, 'USD');

    if (!result && subJson && typeof subJson === 'object' && !subJson.error) {
      const hardLim = toNum(subJson.hard_limit_usd);
      const billUsed = toNum(billUsageJson?.total_usage);
      if (subJson.unlimited_quota === true || (hardLim !== null && hardLim >= 99_999_999)) {
        result = {
          supported: true,
          unlimited: true,
          ...(billUsed !== null ? { usedBalance: Number((billUsed / 100).toFixed(4)), currency: 'USD' } : {}),
          source: `${hostName}/dashboard/billing/subscription`
        };
      } else if (hardLim !== null && hardLim > 0) {
        const usedUsd = billUsed !== null ? billUsed / 100 : 0;
        const remUsd = Math.max(0, Number((hardLim - usedUsd).toFixed(4)));
        result = {
          supported: true,
          unlimited: false,
          remainingBalance: remUsd,
          limitBalance: Number(hardLim.toFixed(4)),
          usedBalance: Number(usedUsd.toFixed(4)),
          currency: 'USD',
          source: `${hostName}/dashboard/billing/subscription`
        };
      } else {
        result = parseQuotaFromObject(subJson, `${hostName}/dashboard/billing/subscription`, 'USD');
      }
    }

    if (!result) {
      result =
        parseQuotaFromObject(creditGrantsJson, `${hostName}/dashboard/billing/credit_grants`, 'USD') ||
        parseQuotaFromObject(keyInfoJson, `${hostName}/key/info`, 'USD');
    }

    if (result && providerUsage && result.usedTokens === undefined && providerUsage.totalTokens !== undefined) {
      result.usedTokens = providerUsage.totalTokens;
    }
  }

  const rawFinal = result || { supported: false, unlimited: false, source: 'none' };
  const finalData = {
    ...rawFinal,
    ...(providerUsage ? { providerUsage } : {}),
    ...(rawMetrics ? { metrics: rawMetrics } : {}),
    ...(probes.length ? { probes } : {}),
    ...(typeof rawFinal.remainingBalance === 'number' && rawFinal.remainingUsd === undefined
      ? { remainingUsd: rawFinal.remainingBalance }
      : {}),
    ...(typeof rawFinal.limitBalance === 'number' && rawFinal.limitUsd === undefined
      ? { limitUsd: rawFinal.limitBalance }
      : {}),
    ...(typeof rawFinal.usedBalance === 'number' && rawFinal.usedUsd === undefined
      ? { usedUsd: rawFinal.usedBalance }
      : {})
  };
  liveQuotaByKey.set(cacheKey, {
    until: Date.now() + QUOTA_TTL_MS,
    data: finalData
  });
  return { ...finalData, rateLimit };
}

function normalizeEffortToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'off') return 'none';
  if (s === 'extra' || s === 'extra_high' || s === 'extra-high') return 'xhigh';
  return EFFORT_LEVELS.includes(s) ? s : null;
}

/**
 * Extract structured effort capability information from a `/v1/models` field.
 *
 * Crucial distinction:
 * - `kind: 'exact'` -> provider explicitly listed the allowed level names!
 * - `kind: 'none'`  -> provider explicitly declared reasoning is NOT supported!
 * - `kind: 'boolean_true'` -> provider only said `reasoning: true` without listing
 *   which enum strings are accepted (must NOT overwrite 7-level specs with 3 levels!).
 */
function extractEffortLevelsFromValue(val) {
  if (val === false || val === 0 || val === 'false' || val === 'unsupported' || val === 'disabled') {
    return { kind: 'none', levels: [], unconfirmed: false };
  }
  if (val === true) {
    return { kind: 'boolean_true', levels: [], unconfirmed: false };
  }
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === 'enabled' || lower === 'supported' || lower === 'yes') {
      return { kind: 'boolean_true', levels: [], unconfirmed: false };
    }
    const tokens = val
      .split(/[\s,;|·/]+/)
      .map(normalizeEffortToken)
      .filter(Boolean);
    if (tokens.length) {
      return {
        kind: 'exact',
        levels: EFFORT_LEVELS.filter((lvl) => tokens.includes(lvl)),
        unconfirmed: false
      };
    }
  }
  if (Array.isArray(val)) {
    const tokens = val
      .map((v) =>
        typeof v === 'string' ? normalizeEffortToken(v) : normalizeEffortToken(v?.id || v?.name || v?.level || v?.value)
      )
      .filter(Boolean);
    if (tokens.length) {
      return {
        kind: 'exact',
        levels: EFFORT_LEVELS.filter((lvl) => tokens.includes(lvl)),
        unconfirmed: false
      };
    }
    return { kind: 'none', levels: [], unconfirmed: false };
  }
  if (val && typeof val === 'object') {
    if (val.supported === false || val.enabled === false) {
      return { kind: 'none', levels: [], unconfirmed: false };
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
      if (parsed.kind !== 'unknown') {
        return { kind: parsed.kind, levels: parsed.levels, unconfirmed: unconfirmed || parsed.unconfirmed };
      }
    }
    if (val.supported === true || val.enabled === true || typeof val.max_tokens === 'number' || typeof val.budget_tokens === 'number') {
      return { kind: 'boolean_true', levels: [], unconfirmed };
    }
  }
  return { kind: 'unknown', levels: [], unconfirmed: false };
}

/**
 * Parse a validation error body from `/v1/chat/completions` to detect either:
 * - `{ type: 'unsupported', levels: [] }` when the model/gateway rejects `reasoning_effort` altogether
 * - `{ type: 'exact', levels: [...] }` when the gateway reports the exact allowed enum values
 * - `{ type: 'generic_effort_error' }` when `reasoning_effort` failed validation without listing values
 * - `{ type: 'unrelated' }` for auth / rate-limit / unrelated errors
 */
export function parseErrorReasoningSignal(rawErrorText, sentEffort = '') {
  const text = String(rawErrorText || '').slice(0, 6000);
  if (!text) return { type: 'unrelated' };

  // 1. Model / parameter explicitly does NOT support reasoning_effort
  if (
    /(?:unknown|unrecognized|unsupported|unexpected|extra|forbidden|disallowed)\s+(?:parameter|field|argument|key|input|property|option)s?[^a-z0-9]{0,24}reasoning_effort/i.test(
      text
    ) ||
    /reasoning_effort[^.\n]{0,80}(?:is\s+not\s+(?:supported|allowed|permitted|available|recognized)|not\s+supported\s+(?:by|for|on)|extra_forbidden|unrecognized)/i.test(
      text
    ) ||
    /(?:model|endpoint)[^.\n]{0,80}does\s+not\s+support\s+(?:reasoning|thinking|reasoning_effort|effort)/i.test(text) ||
    /(?:reasoning|thinking)\s+is\s+not\s+(?:supported|available|enabled)\s+(?:for|on|by)\s+this\s+model/i.test(text) ||
    /"code"\s*:\s*"(?:unknown_parameter|unsupported_parameter)"[\s\S]{0,160}reasoning_effort/i.test(text)
  ) {
    return { type: 'unsupported', levels: [] };
  }

  // 2. Enum validation message listing the allowed values (e.g. "expected one of 'low', 'medium', 'high'"
  //    or "Input should be 'none', 'minimal', 'low', 'medium', 'high', 'xhigh' or 'max'")
  const mentionsReasoning = /reasoning_effort|reasoning|effort|enum|invalid_value|literal_error/i.test(text);
  if (mentionsReasoning) {
    const cleanSent = String(sentEffort || '').toLowerCase();
    const found = new Set();

    // Quoted tokens first ('low', "xhigh", `max`)
    const quotedRe = /['"`]([a-z_-]{2,12})['"`]/gi;
    let m;
    while ((m = quotedRe.exec(text)) !== null) {
      const rawTok = m[1].toLowerCase();
      if (rawTok === cleanSent) continue;
      const norm = normalizeEffortToken(rawTok);
      if (norm) found.add(norm);
    }

    // Unquoted enum lists after keywords like `one of:`, `supported values:`, `allowed:`, `must be`, `should be`
    const listClauseRe =
      /(?:one\s+of|supported(?:\s+values|\s+efforts)?|allowed(?:\s+values)?|valid(?:\s+values|\s+options)?|expected|must\s+be|should\s+be|permitted|enum)\s*[:=]?\s*\[?([a-z0-9_,\s'"`|/·-]+)\]?/gi;
    while ((m = listClauseRe.exec(text)) !== null) {
      const parts = m[1].split(/[\s,;|/·'"`[\]]+/);
      for (const p of parts) {
        const low = p.toLowerCase();
        if (!low || low === 'or' || low === 'and' || low === cleanSent) continue;
        const norm = normalizeEffortToken(low);
        if (norm) found.add(norm);
      }
    }

    if (found.size >= 2 || (found.size === 1 && cleanSent === '__probe_levels__')) {
      return {
        type: 'exact',
        levels: EFFORT_LEVELS.filter((lvl) => found.has(lvl))
      };
    }

    if (/reasoning_effort/i.test(text)) {
      return { type: 'generic_effort_error' };
    }
  }

  return { type: 'unrelated' };
}

const EMPTY_OBJ = Object.freeze({});
const EMPTY_EFFORTS = Object.freeze([]);
const REASONING_DISABLED_PROVIDER = Object.freeze({
  supported: false,
  levels: EMPTY_EFFORTS,
  defaultEffort: null,
  unconfirmed: false,
  source: 'provider',
  needsDiscovery: false
});
const REASONING_STD_PROVISIONAL = Object.freeze({
  supported: true,
  levels: STANDARD_EFFORTS,
  defaultEffort: 'medium',
  unconfirmed: false,
  source: 'provisional',
  needsDiscovery: true
});

function isNonChatModelId(idLower) {
  if (
    idLower.includes('embedding') ||
    idLower.includes('whisper') ||
    idLower.includes('dall-e') ||
    idLower.includes('moderation') ||
    idLower.includes('rerank') ||
    idLower.includes('bge-')
  ) {
    return true;
  }
  return idLower.includes('tts') && /(?:^|[-_/:])tts(?:$|[-_/:])/.test(idLower);
}

function inferProvisionalLevels(idLower, { isTooken = true, booleanHint = null } = {}) {
  if (booleanHint === false) return EMPTY_EFFORTS;
  if (booleanHint !== true && NON_REASONING_LEGACY_RE.test(idLower)) {
    return EMPTY_EFFORTS;
  }
  if (isTooken) {
    if (idLower.startsWith('gemini-')) return STANDARD_EFFORTS;
    return FULL_TOOKEN_EFFORTS;
  }
  return STANDARD_EFFORTS;
}

function pickDefaultEffort(modelId, levels, preferred) {
  if (!levels || !levels.length) return null;
  if (preferred && levels.includes(preferred)) return preferred;
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('high')) return 'high';
  return levels[0];
}

function resolveItemEffortSignals(item, caps, arch) {
  // Fast O(1) skip for standard OpenRouter / OpenAI items that carry no explicit effort fields
  if (
    item.reasoning_efforts === undefined &&
    item.supported_reasoning_efforts === undefined &&
    item.reasoning_levels === undefined &&
    item.efforts === undefined &&
    item.reasoning === undefined &&
    item.thinking === undefined &&
    caps === EMPTY_OBJ &&
    arch.reasoning_efforts === undefined &&
    item.meta === undefined &&
    item.info === undefined
  ) {
    return null;
  }

  let exactLevels = null;
  let explicitDisabled = false;
  let booleanHint = null;
  let extractedUnconfirmed = false;

  const cands = [
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

  for (let i = 0; i < cands.length; i += 1) {
    const cand = cands[i];
    if (cand === undefined || cand === null) continue;
    const res = extractEffortLevelsFromValue(cand);
    if (res.kind === 'exact') {
      exactLevels = res.levels;
      extractedUnconfirmed = res.unconfirmed;
      break;
    }
    if (res.kind === 'none') {
      explicitDisabled = true;
      break;
    }
    if (res.kind === 'boolean_true' && booleanHint === null) {
      booleanHint = true;
      extractedUnconfirmed = res.unconfirmed;
    }
  }

  return { exactLevels, explicitDisabled, booleanHint, extractedUnconfirmed };
}

/**
 * Parse a raw model object returned by `GET /v1/models` (on `tooken.club`, OpenRouter,
 * OpenAI, LiteLLM, or any custom provider) and merge with D1 auto-discovered capabilities.
 * Zero-allocation hot path so ALL 450–1,000+ OpenRouter models parse well under Cloudflare's 10ms CPU cap.
 */
export function parseProviderModelItem(item, options = {}) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id || id.length > 160 || !MODEL_ID_RE.test(id)) {
    return null;
  }
  const idLower = id.toLowerCase();
  if (isNonChatModelId(idLower)) {
    return null;
  }

  const isTooken = options.isTooken !== undefined ? Boolean(options.isTooken) : true;
  const light = Boolean(options.light);
  const discovered = options.discoveredMap?.[id] || null;
  const base = isTooken ? CATALOG_BY_ID.get(id) : null;

  const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : EMPTY_OBJ;
  const limits = item.limits && typeof item.limits === 'object' ? item.limits : EMPTY_OBJ;
  const arch = item.architecture && typeof item.architecture === 'object' ? item.architecture : EMPTY_OBJ;
  const topProvider = item.top_provider && typeof item.top_provider === 'object' ? item.top_provider : EMPTY_OBJ;

  let hasSupportedParams = false;
  let spHasReasoning = false;
  let spHasTools = false;
  if (Array.isArray(item.supported_parameters) && item.supported_parameters.length > 0) {
    hasSupportedParams = true;
    for (let i = 0; i < item.supported_parameters.length; i += 1) {
      const p = String(item.supported_parameters[i] || '').toLowerCase();
      if (p === 'reasoning' || p === 'reasoning_effort' || p === 'include_reasoning' || p === 'thinking') {
        spHasReasoning = true;
      } else if (p === 'tools' || p === 'tool_choice') {
        spHasTools = true;
      }
    }
  }

  const signals = resolveItemEffortSignals(item, caps, arch);
  const exactLevels = signals ? signals.exactLevels : null;
  let explicitDisabled = signals ? signals.explicitDisabled : false;
  let booleanHint = signals ? signals.booleanHint : null;
  const extractedUnconfirmed = signals ? signals.extractedUnconfirmed : false;

  // OpenRouter / vLLM style `supported_parameters`:
  if (!exactLevels && !explicitDisabled && hasSupportedParams) {
    if (!spHasReasoning && booleanHint === null) {
      explicitDisabled = true;
    } else if (spHasReasoning && booleanHint === null) {
      booleanHint = true;
    }
  }

  const unconfirmedFlag =
    item.reasoning_confirmed === false ||
    item.reasoning_verified === false ||
    Boolean(item.reasoning_unconfirmed) ||
    caps.reasoning_confirmed === false ||
    Boolean(caps.reasoning_unconfirmed) ||
    extractedUnconfirmed ||
    (item.reasoning_confirmed === undefined && Boolean(base?.reasoningUnconfirmed));

  let levels = [];
  let source = 'inferred';
  let needsDiscovery = false;
  let unconfirmed = unconfirmedFlag;

  if (exactLevels !== null) {
    levels = exactLevels;
    source = 'provider';
    needsDiscovery = false;
  } else if (explicitDisabled) {
    levels = [];
    source = 'provider';
    needsDiscovery = false;
  } else if (discovered && Array.isArray(discovered.levels)) {
    levels = discovered.levels;
    source = 'discovered';
    needsDiscovery = false;
    unconfirmed = Boolean(discovered.unconfirmed);
  } else if (base?.reasoningLevels) {
    levels = [...base.reasoningLevels];
    source = 'catalog';
    needsDiscovery = false;
  } else if ((hasSupportedParams && spHasReasoning) || idLower.endsWith(':free') || idLower === 'openrouter/free') {
    // OpenRouter `/models` already supplies `supported_parameters` (or model is `:free` 50-req/day capped):
    // NEVER burn 2–8 live `POST /chat/completions` daily requests on background capability probing!
    levels = inferProvisionalLevels(idLower, { isTooken, booleanHint });
    source = hasSupportedParams ? 'provider' : 'provisional';
    needsDiscovery = false;
  } else {
    levels = inferProvisionalLevels(idLower, { isTooken, booleanHint });
    source = 'provisional';
    needsDiscovery = true;
  }

  const maxInputTokens =
    Number(
      item.max_input_tokens ??
        item.input_token_limit ??
        item.context_length ??
        item.context_window ??
        item.contextWindow ??
        topProvider.context_length ??
        limits.input ??
        limits.context ??
        limits.max_input_tokens
    ) ||
    base?.maxInputTokens ||
    null;

  const maxOutputTokens =
    Number(
      item.max_output_tokens ??
        item.maxOutputTokens ??
        item.max_output_length ??
        item.max_completion_tokens ??
        item.output_token_limit ??
        topProvider.max_completion_tokens ??
        limits.output ??
        limits.max_output_tokens
    ) ||
    base?.maxOutputTokens ||
    null;

  const modalityStr = typeof arch.modality === 'string' ? arch.modality.toLowerCase() : '';
  const visionRaw =
    item.vision ??
    item.supports_vision ??
    caps.vision ??
    (Array.isArray(item.input_modalities) ? item.input_modalities.includes('image') : undefined) ??
    (Array.isArray(item.modalities?.input) ? item.modalities.input.includes('image') : undefined) ??
    (Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : undefined) ??
    (modalityStr ? modalityStr.includes('image') : undefined);
  const vision = typeof visionRaw === 'boolean' ? visionRaw : (base?.vision ?? null);

  const toolsRaw =
    item.tools ??
    item.supports_tools ??
    item.function_calling ??
    caps.tools ??
    caps.function_calling ??
    (hasSupportedParams ? spHasTools : undefined);
  const tools = typeof toolsRaw === 'boolean' ? toolsRaw : (base?.tools ?? true);

  const preferredDefault = normalizeEffortToken(item.reasoning?.defaultLevel || item.default_effort) || base?.defaultEffort;
  const defaultEffort = pickDefaultEffort(id, levels, preferredDefault);
  const title =
    (typeof item.displayName === 'string' && item.displayName.trim()) ||
    (typeof item.name === 'string' && item.name.trim()) ||
    (typeof item.title === 'string' && item.title.trim()) ||
    (typeof item.display_name === 'string' && item.display_name.trim()) ||
    base?.title ||
    id;

  const isFeatured = Boolean(item.featured ?? base?.featured ?? (!isTooken && OPENROUTER_FEATURED_RE.test(idLower)));
  let subtitle = '';
  if (typeof item.description === 'string' && item.description) {
    if (light) {
      const nl = item.description.indexOf('\n');
      const cut = nl >= 0 && nl < 64 ? nl : 64;
      subtitle = item.description.slice(0, cut).trim();
    } else {
      subtitle = item.description.slice(0, 160).trim().slice(0, 120);
    }
  } else if (base?.subtitle) {
    subtitle = base.subtitle;
  }

  let reasoningObj;
  if (!unconfirmed && !preferredDefault && source === 'provider' && levels.length === 0) {
    reasoningObj = REASONING_DISABLED_PROVIDER;
  } else if (
    !unconfirmed &&
    !preferredDefault &&
    source === 'provisional' &&
    levels === STANDARD_EFFORTS &&
    defaultEffort === 'medium'
  ) {
    reasoningObj = REASONING_STD_PROVISIONAL;
  } else {
    reasoningObj = {
      supported: levels.length > 0,
      levels,
      defaultEffort,
      unconfirmed,
      source,
      needsDiscovery
    };
  }

  let pricingTier = typeof item.pricingTier === 'string' ? item.pricingTier : null;
  if (!pricingTier) {
    if (idLower.endsWith(':free') || idLower === 'openrouter/free') {
      pricingTier = 'free';
    } else if (idLower === 'openrouter/auto') {
      pricingTier = 'auto';
    } else if (item.pricing && typeof item.pricing === 'object') {
      const pPrompt = Number(item.pricing.prompt);
      const pComp = Number(item.pricing.completion);
      const hasPromptStr = item.pricing.prompt !== undefined && item.pricing.prompt !== null && String(item.pricing.prompt).trim() !== '';
      if (hasPromptStr && pPrompt === 0 && (Number.isNaN(pComp) || pComp === 0)) {
        pricingTier = 'free';
      } else if ((Number.isFinite(pPrompt) && pPrompt > 0) || (Number.isFinite(pComp) && pComp > 0)) {
        pricingTier = 'paid';
      }
    }
  }

  if (!base) {
    return {
      id,
      title,
      subtitle,
      label: title,
      tier: 'live',
      featured: isFeatured,
      pricingTier,
      maxInputTokens,
      maxOutputTokens,
      vision,
      tools,
      reasoning: reasoningObj
    };
  }

  return {
    ...base,
    id,
    title,
    subtitle,
    label: base.label || title,
    tier: base.tier || 'live',
    featured: isFeatured,
    pricingTier,
    maxInputTokens,
    maxOutputTokens,
    vision,
    tools,
    reasoning: reasoningObj
  };
}

/**
 * Return the model's Reasoning Effort specification, preferring D1-discovered or
 * live `/v1/models` metadata for the active `env`'s provider URL.
 */
export function getModelReasoningSpec(modelId, env = null) {
  const id = String(modelId || '').trim();
  if (!id) {
    return { supported: false, levels: [], defaultEffort: null, unconfirmed: false };
  }

  const endpoint = modelEndpoint(env || {});
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const isTooken = isTookenUrl(baseUrl);

  // 1. Live D1 discovered cache on `env`
  const discovered = env?._discoveredSpecs?.[id];
  if (discovered && Array.isArray(discovered.levels)) {
    return {
      supported: discovered.levels.length > 0,
      levels: discovered.levels,
      defaultEffort: pickDefaultEffort(id, discovered.levels),
      unconfirmed: Boolean(discovered.unconfirmed),
      source: 'discovered',
      needsDiscovery: false
    };
  }

  // 2. Live `/v1/models` cache for this exact baseUrl
  const cachedEndpoint = liveModelsByEndpoint.get(baseUrl);
  if (cachedEndpoint && cachedEndpoint.until > Date.now() && cachedEndpoint.byId.has(id)) {
    const liveItem = cachedEndpoint.byId.get(id);
    if (liveItem?.reasoning) return liveItem.reasoning;
  }

  // 3. Parse with provider context
  const parsed = parseProviderModelItem({ id }, { isTooken, discoveredMap: env?._discoveredSpecs });
  return parsed?.reasoning || { supported: false, levels: [], defaultEffort: null, unconfirmed: false };
}

/**
 * Normalize a requested effort (`none`..`max`, plus UI aliases `off`->`none` and `extra`->`xhigh`)
 * against the model's supported levels.
 */
export function normalizeReasoningEffort(rawEffort, modelId, legacyThinkingFlag, env = null) {
  const spec = getModelReasoningSpec(modelId, env);
  if (!spec.supported || !spec.levels.length) return null;

  let candidate = normalizeEffortToken(rawEffort);
  if (!candidate) {
    if (legacyThinkingFlag === false) candidate = 'none';
    else if (legacyThinkingFlag === true) candidate = spec.defaultEffort || 'medium';
    else return null;
  }

  if (spec.levels.includes(candidate)) return candidate;

  const targetIdx = EFFORT_LEVELS.indexOf(candidate);
  let best = spec.levels[0];
  let bestDist = Infinity;
  for (const allowed of spec.levels) {
    const dist = Math.abs(EFFORT_LEVELS.indexOf(allowed) - targetIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = allowed;
    }
  }
  return best;
}

/**
 * Build pure OpenAI-compatible wire variants for `reasoning_effort`.
 * Never injects synthetic `thinking.budget_tokens` or inflates `max_tokens`.
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

  if (effort === 'max' || effort === 'xhigh') {
    variants.push({ effort: 'high', params: { reasoning_effort: 'high', ...maxTokPart } });
  } else if (effort === 'minimal' || effort === 'none') {
    variants.push({ effort: 'low', params: { reasoning_effort: 'low', ...maxTokPart } });
  }
  variants.push({ effort: null, params: { temperature: baseTemp, ...maxTokPart } });
  return variants;
}

export function sanitizeModelId(value, env = {}) {
  const candidate = String(value || '').trim();
  if (candidate && MODEL_ID_RE.test(candidate)) return candidate;
  const baseUrl = modelEndpoint(env).replace(/\/chat\/completions$/, '');
  if (isOpenRouterUrl(baseUrl)) {
    return String(env?.MODEL_NAME || '').trim() || 'openrouter/auto';
  }
  return String(env.MODEL_NAME || 'claude-sonnet-5-5');
}

export function modelEndpoint(env = {}) {
  const base = String(env?.MODEL_BASE_URL || 'https://tooken.club/v1')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export function catalogModelsWithSpecs(env = {}) {
  const baseUrl = modelEndpoint(env).replace(/\/chat\/completions$/, '');
  const isTooken = isTookenUrl(baseUrl);
  if (isTooken) {
    return MODEL_CATALOG.map((item) =>
      parseProviderModelItem({ id: item.id }, { isTooken: true, discoveredMap: env?._discoveredSpecs })
    );
  }
  if (isOpenRouterUrl(baseUrl)) {
    return OPENROUTER_FALLBACK_IDS.map((item) =>
      parseProviderModelItem(item, { isTooken: false, discoveredMap: env?._discoveredSpecs })
    ).filter(Boolean);
  }
  return [];
}

function applyDiscoveredSpecsToList(list, discoveredMap) {
  if (!discoveredMap || !Object.keys(discoveredMap).length) return list;
  return list.map((m) => {
    const d = discoveredMap[m.id];
    if (d && m.reasoning?.source !== 'provider') {
      return {
        ...m,
        reasoning: {
          supported: d.levels.length > 0,
          levels: d.levels,
          defaultEffort: pickDefaultEffort(m.id, d.levels, m.reasoning?.defaultEffort),
          unconfirmed: Boolean(d.unconfirmed),
          source: 'discovered',
          needsDiscovery: false
        }
      };
    }
    return m;
  });
}

/**
 * Fetch full model objects from `{baseUrl}/models` and merge with D1 auto-discovered specs.
 * Engineered to stay under ~1.2ms CPU even on 450-model / 3.5 MB OpenRouter responses
 * so Cloudflare Workers never hit Error 1102 (HTTP 503 CPU limit).
 */
export async function fetchProviderModels(env, { force = false } = {}) {
  if (!env?.MODEL_API_KEY) fail('سرویس مدل پیکربندی نشده است.', 503, 'model_key_missing');
  const baseUrl = modelEndpoint(env).replace(/\/chat\/completions$/, '');
  const isTooken = isTookenUrl(baseUrl);
  const isOpenRouter = isOpenRouterUrl(baseUrl);
  const cacheEntry = liveModelsByEndpoint.get(baseUrl);

  if (!force && cacheEntry && cacheEntry.until > Date.now() && cacheEntry.list.length) {
    return applyDiscoveredSpecsToList(cacheEntry.list, env._discoveredSpecs);
  }

  if (!force && env?.DB) {
    const d1Cached = await loadCachedProviderModels(env, baseUrl).catch(() => null);
    if (Array.isArray(d1Cached) && d1Cached.length) {
      const byId = new Map(d1Cached.map((m) => [m.id, m]));
      liveModelsByEndpoint.set(baseUrl, {
        until: Date.now() + LIVE_MODELS_TTL_MS,
        byId,
        list: d1Cached
      });
      return applyDiscoveredSpecsToList(d1Cached, env._discoveredSpecs);
    }
  }

  let response;
  let cliModelsPromise = null;
  if (!isTooken && /moonmath\.ai/i.test(baseUrl)) {
    try {
      const originUrl = new URL(baseUrl).origin;
      cliModelsPromise = fetch(`${originUrl}/api/cli/models`, {
        headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000)
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    } catch {
      cliModelsPromise = null;
    }
  }

  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${env.MODEL_API_KEY}`,
        Accept: 'application/json',
        ...providerExtraHeaders(baseUrl)
      },
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

  const cliCatalog = cliModelsPromise ? await cliModelsPromise : null;
  const cliById = new Map();
  const cliOrderIds = [];
  if (typeof cliCatalog?.default === 'string' && cliCatalog.default) {
    cliOrderIds.push(cliCatalog.default);
  }
  if (Array.isArray(cliCatalog?.models)) {
    for (const cm of cliCatalog.models) {
      if (cm?.id) {
        cliById.set(cm.id, cm);
        cliById.set(`zro/${cm.id}`, cm);
        if (!cliOrderIds.includes(cm.id)) cliOrderIds.push(cm.id);
      }
    }
  }

  // Keep 100% of all provider models (OpenRouter ~450-600+ models) without dropping any model!
  // Use ultra-light parsing (`light: true`) on large catalogs so Worker CPU stays ~1ms for all 500+ models.
  const maxSafetyItems = Math.min(rawList.length, 2_000);
  const useLight = maxSafetyItems > 80;

  const byId = new Map();
  for (let i = 0; i < maxSafetyItems; i += 1) {
    const rawItem = rawList[i];
    const baseObj = typeof rawItem === 'string' ? { id: rawItem } : rawItem;
    const rich =
      baseObj?.id && cliById.has(baseObj.id)
        ? { ...cliById.get(baseObj.id), ...baseObj, id: baseObj.id, featured: !String(baseObj.id).startsWith('zro/') }
        : baseObj;
    const parsed = parseProviderModelItem(rich, {
      isTooken,
      light: useLight,
      discoveredMap: env._discoveredSpecs
    });
    if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
  }

  if (isOpenRouter && !byId.has('openrouter/auto')) {
    const autoItem = parseProviderModelItem(OPENROUTER_FALLBACK_IDS[0], {
      isTooken: false,
      light: true,
      discoveredMap: env._discoveredSpecs
    });
    if (autoItem) byId.set(autoItem.id, autoItem);
  }

  const ordered = [];
  const orderedIds = new Set();
  const pushOrdered = (m) => {
    if (m && !orderedIds.has(m.id)) {
      ordered.push(m);
      orderedIds.add(m.id);
    }
  };

  if (isTooken) {
    for (const cat of MODEL_CATALOG) {
      if (byId.has(cat.id)) pushOrdered(byId.get(cat.id));
    }
  } else if (isOpenRouter) {
    for (const pref of OPENROUTER_PREFERRED_DEFAULTS) {
      if (byId.has(pref)) pushOrdered(byId.get(pref));
    }
    for (const m of byId.values()) {
      if (m.featured) pushOrdered(m);
    }
    const priorityLabs = [];
    for (const m of byId.values()) {
      if (!orderedIds.has(m.id) && OPENROUTER_PRIORITY_RE.test(m.id)) {
        priorityLabs.push(m);
      }
    }
    priorityLabs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < priorityLabs.length; i += 1) {
      pushOrdered(priorityLabs[i]);
    }
  } else if (cliOrderIds.length) {
    for (const cid of cliOrderIds) {
      if (byId.has(cid)) pushOrdered(byId.get(cid));
    }
  } else if (byId.has('deepseek-v4.1-flash')) {
    pushOrdered(byId.get('deepseek-v4.1-flash'));
  }

  // Fast ASCII codepoint sort for ALL remaining models (avoids ICU `localeCompare` which burns ~7ms CPU on Workers!)
  const rest = [];
  for (const m of byId.values()) {
    if (!orderedIds.has(m.id)) rest.push(m);
  }
  rest.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const list = [...ordered, ...rest];

  liveModelsByEndpoint.set(baseUrl, {
    until: Date.now() + LIVE_MODELS_TTL_MS,
    byId,
    list
  });
  if (env?.DB) {
    await saveCachedProviderModels(env, baseUrl, list);
  }
  return list;
}

export async function listModels(env) {
  const models = await fetchProviderModels(env, { force: true });
  return models.map((m) => m.id);
}

async function probeSingleChatEffort(endpoint, apiKey, modelId, effortValue, maxTokens = 1, prompt = '1') {
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const bodyObj = {
    model: modelId,
    stream: false,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    ...(effortValue !== null ? { reasoning_effort: effortValue } : {})
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...providerExtraHeaders(baseUrl)
    },
    body: JSON.stringify(bodyObj)
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text };
}

/**
 * Automatically discover a model's genuine Reasoning Effort capabilities on ANY
 * OpenAI-compatible API (`tooken.club`, OpenRouter, OpenAI, DeepSeek, LiteLLM, etc.),
 * even for brand-new unseen models, and cache the result in D1.
 */
export async function discoverModelCapabilities(env, rawModelId, { force = false } = {}) {
  if (!env?.MODEL_API_KEY) {
    fail('MODEL_API_KEY تنظیم نشده است.', 503, 'model_key_missing');
  }
  const modelId = sanitizeModelId(rawModelId, env);
  const endpoint = modelEndpoint(env);
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const isTooken = isTookenUrl(baseUrl);

  if (!force && env._discoveredSpecs?.[modelId]) {
    const d = env._discoveredSpecs[modelId];
    return {
      model: modelId,
      supported: d.levels.length > 0,
      levels: d.levels,
      defaultEffort: pickDefaultEffort(modelId, d.levels),
      unconfirmed: Boolean(d.unconfirmed),
      source: 'discovered',
      via: d.via || 'cache',
      needsDiscovery: false
    };
  }

  // Step 1: Check single-model detail endpoint `GET {baseUrl}/models/{id}` (0 tokens)
  let detailBooleanHint = null;
  try {
    const detailRes = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}`, {
      headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000)
    });
    if (detailRes.ok) {
      const detailJson = await detailRes.json().catch(() => null);
      const rawObj = detailJson?.data && typeof detailJson.data === 'object' ? detailJson.data : detailJson;
      const parsed = parseProviderModelItem(rawObj, { isTooken, discoveredMap: {} });
      if (parsed?.reasoning?.source === 'provider') {
        const spec = {
          supported: parsed.reasoning.supported,
          levels: parsed.reasoning.levels,
          unconfirmed: parsed.reasoning.unconfirmed,
          via: 'model-metadata'
        };
        await saveDiscoveredSpec(env, baseUrl, modelId, spec).catch(() => {});
        if (env._discoveredSpecs) env._discoveredSpecs[modelId] = spec;
        return {
          model: modelId,
          ...spec,
          defaultEffort: pickDefaultEffort(modelId, spec.levels),
          source: 'provider',
          needsDiscovery: false
        };
      }
      if (rawObj?.reasoning === true || rawObj?.capabilities?.reasoning === true) {
        detailBooleanHint = true;
      }
    }
  } catch {
    // Detail endpoint is optional on many gateways; proceed to live schema probe.
  }

  // Step 2: Zero-token schema validation probe (`reasoning_effort: "__probe_levels__"`)
  let probeRes;
  try {
    probeRes = await probeSingleChatEffort(endpoint, env.MODEL_API_KEY, modelId, '__probe_levels__', 1, '1');
  } catch {
    fail('ارتباط با سرویس مدل برای بررسی قابلیت‌ها برقرار نشد.', 504, 'model_unreachable');
  }

  if (probeRes.status === 401 || probeRes.status === 403) {
    fail('کلید API توسط سرویس مدل پذیرفته نشد.', 502, 'model_auth');
  }
  if (probeRes.status === 404) {
    fail(`مدل «${modelId}» در این سرویس پیدا نشد.`, 404, 'model_not_found');
  }

  let discoveredSpec = null;

  if (probeRes.status === 400 || probeRes.status === 422) {
    const signal = parseErrorReasoningSignal(probeRes.text, '__probe_levels__');
    if (signal.type === 'unsupported') {
      discoveredSpec = { supported: false, levels: [], unconfirmed: false, via: 'schema-unsupported' };
    } else if (signal.type === 'exact') {
      discoveredSpec = { supported: true, levels: signal.levels, unconfirmed: false, via: 'schema-enum' };
    } else {
      // Gateway validates `reasoning_effort` (rejected `__probe_levels__` with 400),
      // so test all 7 candidate levels concurrently (`max_tokens: 1`) to see which exact subset returns 200!
      const results = await Promise.all(
        EFFORT_LEVELS.map(async (lvl) => {
          try {
            const r = await probeSingleChatEffort(endpoint, env.MODEL_API_KEY, modelId, lvl, 1, '1');
            return { lvl, ...r };
          } catch {
            return { lvl, ok: false, status: 0, text: '' };
          }
        })
      );

      // Check if any error response revealed exact enum or explicit unsupported
      for (const r of results) {
        if (!r.ok && (r.status === 400 || r.status === 422)) {
          const sig = parseErrorReasoningSignal(r.text, r.lvl);
          if (sig.type === 'unsupported') {
            discoveredSpec = { supported: false, levels: [], unconfirmed: false, via: 'parallel-unsupported' };
            break;
          }
          if (sig.type === 'exact') {
            discoveredSpec = { supported: true, levels: sig.levels, unconfirmed: false, via: 'parallel-enum' };
            break;
          }
        }
      }

      if (!discoveredSpec) {
        const accepted = results.filter((r) => r.ok).map((r) => r.lvl);
        discoveredSpec = {
          supported: accepted.length > 0,
          levels: accepted,
          unconfirmed: false,
          via: 'parallel-probe'
        };
      }
    }
  } else if (probeRes.ok) {
    // Gateway returned 200 even for `__probe_levels__` (permissive proxy that ignores unknown strings).
    // Verify whether the model actually emits reasoning tokens / reasoning content at `high`.
    const hasReasoningInBody = (rawTxt) => {
      try {
        const j = JSON.parse(rawTxt);
        const msg = j?.choices?.[0]?.message || {};
        const rTok = Number(j?.usage?.completion_tokens_details?.reasoning_tokens ?? j?.usage?.reasoning_tokens ?? 0);
        return Boolean(
          rTok > 0 ||
            msg.reasoning_content ||
            msg.reasoning ||
            msg.thinking ||
            (Array.isArray(msg.content) && msg.content.some((b) => b?.type === 'thinking' || b?.type === 'reasoning'))
        );
      } catch {
        return false;
      }
    };

    let reasoned = hasReasoningInBody(probeRes.text);
    if (!reasoned) {
      const highCheck = await probeSingleChatEffort(endpoint, env.MODEL_API_KEY, modelId, 'high', 24, '2+2=?').catch(
        () => null
      );
      if (highCheck?.ok && hasReasoningInBody(highCheck.text)) {
        reasoned = true;
      }
    }

    if (reasoned || detailBooleanHint === true) {
      const levels = isTooken
        ? CATALOG_BY_ID.get(modelId)?.reasoningLevels || [...FULL_TOOKEN_EFFORTS]
        : [...STANDARD_EFFORTS];
      discoveredSpec = {
        supported: true,
        levels: [...levels],
        unconfirmed: !reasoned,
        via: reasoned ? 'reasoning-verified' : 'metadata-hint'
      };
    } else {
      discoveredSpec = {
        supported: false,
        levels: [],
        unconfirmed: false,
        via: 'no-reasoning-output'
      };
    }
  } else {
    // Fallback if rate-limited (429) or transient upstream status during probe
    const fallbackSpec = getModelReasoningSpec(modelId, env);
    return {
      model: modelId,
      ...fallbackSpec,
      via: 'fallback',
      needsDiscovery: true
    };
  }

  await saveDiscoveredSpec(env, baseUrl, modelId, discoveredSpec).catch(() => {});
  if (env._discoveredSpecs) env._discoveredSpecs[modelId] = discoveredSpec;

  return {
    model: modelId,
    supported: discoveredSpec.supported,
    levels: discoveredSpec.levels,
    defaultEffort: pickDefaultEffort(modelId, discoveredSpec.levels),
    unconfirmed: Boolean(discoveredSpec.unconfirmed),
    source: 'discovered',
    via: discoveredSpec.via,
    needsDiscovery: false
  };
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
export function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const ids = new Set();
  for (const call of raw.slice(0, 8)) {
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

function extractSafeUpstreamError(errText, secrets = []) {
  if (!errText) return '';
  let msg = '';
  try {
    const parsed = JSON.parse(errText);
    msg =
      parsed?.error?.message ||
      parsed?.message ||
      (typeof parsed?.error === 'string' ? parsed.error : '') ||
      '';
  } catch {
    msg = '';
  }
  const clean = stripSecrets(String(msg || '').replace(/\s+/g, ' ').trim(), secrets).slice(0, 180);
  if (!clean || /^</.test(clean)) return '';
  return clean;
}

function classifyInlineProviderError(errObj, secrets = [], ctxInfo = {}) {
  if (!errObj) return null;
  const rawMsg =
    (typeof errObj === 'string' && errObj) ||
    errObj?.message ||
    errObj?.error?.message ||
    (typeof errObj?.error === 'string' && errObj.error) ||
    '';
  const rawCode = String(errObj?.code || errObj?.error?.code || errObj?.type || errObj?.error?.type || '').toLowerCase();
  const clean = stripSecrets(String(rawMsg || '').replace(/\s+/g, ' ').trim(), secrets).slice(0, 180);
  const combined = `${rawCode} ${clean}`.toLowerCase();

  if (
    rawCode === '404' ||
    /(not\s+a\s+valid\s+model|model.*(?:not[_\s-]*found|does\s+not\s+exist|unavailable|unknown|deprecated)|no\s+endpoints\s+found)/.test(
      combined
    )
  ) {
    const mName = ctxInfo?.model || 'انتخابی';
    return {
      status: 502,
      code: 'model_not_found',
      message: `🚫 مدل «${mName}» در درگاه فعلی وجود ندارد یا موقتاً در دسترس نیست (درگاه تغییر نکرد). لطفاً مدلی از فهرست همین درگاه انتخاب کنید.`
    };
  }

  if (/quota|insufficient|balance|credit|billing|exhausted|afford|اعتبار|سهمیه|موجودی/.test(combined)) {
    const mName = String(ctxInfo?.model || '');
    if (
      !ctxInfo?.hasPartialContent &&
      ((ctxInfo?.isOpenRouter && mName && !/(:free|^openrouter\/free)$/i.test(mName)) ||
        /(paid\s+model|requires\s+paid|upgrade.*plan.*model|pro\s+plan\s+required)/.test(combined))
    ) {
      return {
        status: 402,
        code: 'model_paid_required',
        message: `💳 مدل «${mName}» پولی است و حساب فعلی در این درگاه شارژ دلاری ندارد (درگاه تغییر نکرد). یک مدل رایگان (:free) انتخاب کنید یا حساب/درگاه مناسب را فعال کنید.`
      };
    }
    return {
      status: 402,
      code: 'model_quota_exhausted',
      message: `اعتبار یا توکن کلید API به پایان رسید${clean ? ` (${clean})` : ''}. کلید جدید را جایگزین کنید و بنویسید «ادامه» تا دقیقاً از همین نقطه ادامه یابد.`
    };
  }
  if (/invalid_api_key|unauthorized|authentication|permission_denied|forbidden|api key/.test(combined)) {
    return {
      status: 502,
      code: 'model_auth',
      message: `کلید API پذیرفته نشد${clean ? ` (${clean})` : ''}. از بخش ⌁ API کلید جدید وارد کنید و بنویسید «ادامه».`
    };
  }
  if (/rate_limit|too many requests|429|throttl/.test(combined)) {
    return {
      status: 429,
      code: 'model_rate_limited',
      message: `سهمیه‌ی لحظه‌ای سرویس مدل پر شد${clean ? ` (${clean})` : ''}. چند ثانیه صبر کنید یا کلید عوض کنید و بنویسید «ادامه».`
    };
  }
  return {
    status: 502,
    code: 'model_upstream',
    message: clean
      ? `خطای سرویس مدل در حین پاسخ: ${clean}`
      : 'سرویس مدل در میانه پاسخ خطا برگرداند.'
  };
}

function createSseAccumulator(onDelta) {
  let outModel = '';
  let finishReason = 'stop';
  let sawExplicitFinish = false;
  let sawDone = false;
  let contentAcc = '';
  let reasoningAcc = '';
  let usageObj = null;
  let sawFrame = false;
  let inlineError = null;
  const toolMap = new Map();

  const applyEventObj = (evt) => {
    if (!evt || typeof evt !== 'object') return;
    if (evt.error && !evt.choices?.length) {
      inlineError = evt.error;
      return;
    }
    sawFrame = true;
    if (evt.model) outModel = String(evt.model);
    if (evt.usage && typeof evt.usage === 'object') usageObj = evt.usage;
    const choice = evt?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finishReason = String(choice.finish_reason);
      sawExplicitFinish = true;
    }
    const d = choice.delta || choice.message || {};

    if (typeof d.content === 'string' && d.content) {
      contentAcc += d.content;
      if (typeof onDelta === 'function') {
        try { onDelta({ type: 'content', text: d.content }); } catch { /* ignore */ }
      }
    } else if (Array.isArray(d.content)) {
      for (const blk of d.content) {
        if (!blk) continue;
        if ((blk.type === 'thinking' || blk.type === 'reasoning') && typeof (blk.thinking || blk.text) === 'string') {
          const rt = String(blk.thinking || blk.text);
          reasoningAcc += rt;
          if (typeof onDelta === 'function') {
            try { onDelta({ type: 'reasoning', text: rt }); } catch { /* ignore */ }
          }
        } else if (typeof blk.text === 'string' && blk.text) {
          contentAcc += blk.text;
          if (typeof onDelta === 'function') {
            try { onDelta({ type: 'content', text: blk.text }); } catch { /* ignore */ }
          }
        }
      }
    }

    const rChunk =
      (typeof d.reasoning_content === 'string' && d.reasoning_content) ||
      (typeof d.reasoning === 'string' && d.reasoning) ||
      (typeof d.thinking === 'string' && d.thinking) ||
      '';
    if (rChunk) {
      reasoningAcc += rChunk;
      if (typeof onDelta === 'function') {
        try { onDelta({ type: 'reasoning', text: rChunk }); } catch { /* ignore */ }
      }
    }

    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = Number.isInteger(tc?.index) ? tc.index : toolMap.size;
        const prev = toolMap.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (typeof tc.id === 'string' && tc.id) prev.id = tc.id;
        if (typeof tc.function?.name === 'string' && tc.function.name) prev.function.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
          prev.function.arguments += tc.function.arguments;
        }
        toolMap.set(idx, prev);
        if (typeof onDelta === 'function') {
          try {
            onDelta({
              type: 'tool_delta',
              name: prev.function.name || 'tool',
              totalChars: prev.function.arguments.length
            });
          } catch { /* ignore */ }
        }
      }
    }
  };

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith('data:')) {
      const payloadStr = line.slice(5).trim();
      if (!payloadStr) return;
      if (payloadStr === '[DONE]') {
        sawDone = true;
        return;
      }
      try {
        applyEventObj(JSON.parse(payloadStr));
      } catch {
        /* ignore malformed partial keepalive frame */
      }
    }
  };

  const isComplete = () => sawDone;

  const snapshot = (rawStreamInterrupted = false) => {
    const toolCalls = [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    let hasTruncatedToolCall = false;
    for (const tc of toolCalls) {
      const rawArgs = String(tc?.function?.arguments || '').trim();
      if (!tc?.function?.name) {
        hasTruncatedToolCall = true;
        break;
      }
      if (rawArgs) {
        try {
          JSON.parse(rawArgs);
        } catch {
          hasTruncatedToolCall = true;
          break;
        }
      }
    }
    // If upstream already sent `[DONE]` or an explicit `finish_reason` (`stop`/`tool_calls`) with non-truncated tools,
    // a subsequent ungraceful TCP reset by the proxy is NOT a mid-stream cutoff!
    const completedCleanly =
      !inlineError &&
      !hasTruncatedToolCall &&
      (sawDone || (sawExplicitFinish && (finishReason === 'stop' || finishReason === 'tool_calls')));
    const streamInterrupted = Boolean(rawStreamInterrupted && !completedCleanly);
    return {
      sawFrame,
      sawDone,
      sawExplicitFinish,
      inlineError,
      streamInterrupted,
      hasTruncatedToolCall,
      rawContent: contentAcc,
      rawReasoning: reasoningAcc,
      rawToolCalls: toolCalls,
      data: {
        model: outModel,
        interrupted: streamInterrupted,
        choices: [
          {
            finish_reason: streamInterrupted ? 'interrupted' : finishReason,
            message: {
              role: 'assistant',
              content: contentAcc,
              ...(reasoningAcc ? { reasoning_content: reasoningAcc } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {})
            }
          }
        ],
        ...(usageObj ? { usage: usageObj } : {})
      }
    };
  };

  return { applyEventObj, handleLine, isComplete, snapshot };
}

function parseHybridTextPayload(rawText, onDelta) {
  const cleaned = String(rawText || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return { kind: 'empty', data: null };
  if (/^<!doctype\s+html|^<html\b/i.test(cleaned)) {
    return { kind: 'html', data: null };
  }

  // 1. Standard JSON object
  if (cleaned.startsWith('{')) {
    try {
      return { kind: 'json', data: JSON.parse(cleaned) };
    } catch {
      // Fall through: could be NDJSON (`{...}\n{...}`) or JSON followed by proxy trailer
    }
  }

  // 2. SSE frames (`data: {...}`) returned with non-SSE Content-Type
  if (/^data:\s*/m.test(cleaned)) {
    const acc = createSseAccumulator(onDelta);
    for (const line of cleaned.split(/\r?\n/)) acc.handleLine(line);
    const snap = acc.snapshot(false);
    if (snap.inlineError && !snap.sawFrame) return { kind: 'error_obj', error: snap.inlineError };
    if (snap.sawFrame) return { kind: 'sse', snap, data: snap.data };
  }

  // 3. NDJSON (newline-delimited JSON chunks)
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => l.startsWith('{'))) {
    const acc = createSseAccumulator(onDelta);
    for (const line of lines) {
      try { acc.applyEventObj(JSON.parse(line)); } catch { /* ignore */ }
    }
    const snap = acc.snapshot(false);
    if (snap.sawFrame) return { kind: 'ndjson', snap, data: snap.data };
  }

  // 4. JSON embedded inside proxy noise / stray prefix
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const extracted = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (extracted && typeof extracted === 'object') return { kind: 'json', data: extracted };
    } catch {
      /* ignore */
    }
  }

  return { kind: 'unreadable', data: null, preview: cleaned.slice(0, 120) };
}

async function consumeChatSseResponse(response, onDelta, signal = null) {
  const reader = response.body?.getReader?.();
  if (!reader) return { kind: 'empty', data: null };
  const dec = new TextDecoder();
  const acc = createSseAccumulator(onDelta);
  let buf = '';
  let rawFallback = '';
  let streamInterrupted = false;
  let streamErrObj = null;
  const onAbort = () => {
    streamInterrupted = true;
    try { reader.cancel(); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    let chunkReads = 0;
    while (true) {
      if (signal?.aborted) {
        streamInterrupted = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      chunkReads += 1;
      if (chunkReads % 16 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const chunkText = dec.decode(value, { stream: true });
      if (rawFallback.length < 96_000) rawFallback += chunkText;
      buf += chunkText;
      let nlIdx;
      while ((nlIdx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);
        acc.handleLine(line);
      }
      if (acc.isComplete()) {
        // Upstream sent `data: [DONE]` — stop immediately so proxies that keep sockets open or reset TCP never trigger false timeouts!
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
    if (!acc.isComplete()) buf += dec.decode();
  } catch (err) {
    streamInterrupted = true;
    streamErrObj = err;
  } finally {
    if (signal) {
      try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
    }
  }
  if (buf.trim()) acc.handleLine(buf);

  const snap = acc.snapshot(streamInterrupted);
  if (!snap.sawFrame && !snap.inlineError && rawFallback.trim()) {
    // Proxy set Content-Type: text/event-stream, but actually sent plain JSON or HTML!
    return parseHybridTextPayload(rawFallback, onDelta);
  }
  return {
    kind: 'sse',
    snap,
    data: snap.data,
    streamError: streamErrObj
  };
}

function isContextOverflowError(status, rawErrText = '') {
  if (status === 413) return true;
  if (status !== 400 && status !== 422) return false;
  return /context_length|maximum context|prompt is too long|input is too long|too many tokens|request_too_large|payload too large|string_above_max_length|exceed.*token|token.*limit|max_seq_len|context window|حجم پیام/i.test(
    String(rawErrText || '')
  );
}

function measureNonBinaryWireChars(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      total += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p?.text === 'string') total += p.text.length;
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += (tc?.function?.name?.length || 0) + (tc?.function?.arguments?.length || 0) + 32;
      }
    }
  }
  return total;
}

/**
 * Group messages into atomic units so an `assistant` message with `tool_calls`
 * is NEVER separated from its immediately following `role: 'tool'` results!
 */
function groupAtomicWireUnits(messages) {
  const units = [];
  for (let i = 0; i < (messages || []).length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const grp = [m];
      while (i + 1 < messages.length && messages[i + 1]?.role === 'tool') {
        i += 1;
        grp.push(messages[i]);
      }
      units.push(grp);
    } else {
      units.push([m]);
    }
  }
  return units;
}

function slimSingleMessage(msg, { argCap = 900, toolOutCap = 1400, proseCap = 6000, stripBinary = false } = {}) {
  if (!msg) return msg;
  let next = { ...msg };

  if (typeof next.content === 'string' && next.content.length > proseCap) {
    const head = Math.floor(proseCap * 0.7);
    const tail = Math.floor(proseCap * 0.22);
    const label = next.role === 'tool' ? 'خروجی ابزار' : 'متن';
    next.content = `${next.content.slice(0, head)}\n…[${label} برای رعایت سقف مدل فشرده شد (${next.content.length} کاراکتر)]…\n${next.content.slice(-tail)}`;
  } else if (Array.isArray(next.content)) {
    next.content = next.content.map((part) => {
      if (!part) return part;
      if (typeof part.text === 'string' && part.text.length > proseCap) {
        const head = Math.floor(proseCap * 0.7);
        const tail = Math.floor(proseCap * 0.22);
        return {
          ...part,
          text: `${part.text.slice(0, head)}\n…[متن فشرده شد (${part.text.length} کاراکتر)]…\n${part.text.slice(-tail)}`
        };
      }
      if (stripBinary && (part.type === 'image_url' || part.type === 'file' || part.type === 'input_audio')) {
        const fname = part.file?.filename || part.type || 'attachment';
        return { type: 'text', text: `[پیوست دودویی (${fname}) برای عبور از سقف حجم سرور خلاصه شد]` };
      }
      return part;
    });
  }

  if (Array.isArray(next.tool_calls) && next.tool_calls.length) {
    next.tool_calls = next.tool_calls.map((tc) => {
      const rawArgs = String(tc?.function?.arguments || '');
      if (rawArgs.length <= argCap) return tc;
      let targetPath = '';
      try {
        const parsed = JSON.parse(rawArgs);
        targetPath = parsed?.path || parsed?.url || parsed?.command?.slice?.(0, 60) || '';
      } catch {
        const m = rawArgs.match(/"path"\s*:\s*"([^"]+)"/);
        if (m) targetPath = m[1];
      }
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: JSON.stringify({
            ...(targetPath ? { path: targetPath } : {}),
            _compacted: true,
            _chars: rawArgs.length
          })
        }
      };
    });
  }

  if (next.role === 'tool' && typeof next.content === 'string' && next.content.length > toolOutCap) {
    const head = Math.floor(toolOutCap * 0.72);
    const tail = Math.floor(toolOutCap * 0.22);
    next.content = `${next.content.slice(0, head)}\n…[فشرده شد (${next.content.length} کاراکتر)]…\n${next.content.slice(-tail)}`;
  }

  return next;
}

/**
 * Progressive 3-level auto-compactor that shrinks oversized message arrays in-place
 * while strictly preserving `system` prompt, valid `assistant`->`tool` call pairing,
 * and the user's active goal so 413 / context_length_exceeded NEVER blocks execution!
 */
export function compactMessagesForRetry(messages, level = 1) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const hasSystem = messages[0]?.role === 'system';
  const sysMsg = hasSystem
    ? level >= 3
      ? slimSingleMessage(messages[0], { proseCap: 14_000 })
      : messages[0]
    : null;
  const rest = hasSystem ? messages.slice(1) : messages.slice();
  const units = groupAtomicWireUnits(rest);
  if (!units.length) return sysMsg ? [sysMsg] : [];

  if (level === 1) {
    // Level 1: Keep last 2 atomic units untouched; slim all earlier tool_calls/tool outputs/long prose,
    // and cap total middle units tightly so even pre-slimmed histories shrink deterministically on retry.
    const tailKeep = Math.min(2, units.length);
    const rawHeadUnits = units.slice(0, units.length - tailKeep);
    const cappedHeadSlice = rawHeadUnits.length > 4 ? rawHeadUnits.slice(-4) : rawHeadUnits;
    const headUnits = cappedHeadSlice.map((u) =>
      u.map((m) => slimSingleMessage(m, { argCap: 160, toolOutCap: 220, proseCap: 1400, stripBinary: true }))
    );
    const tailUnits = units.slice(units.length - tailKeep).map((u, idx, arr) =>
      idx === arr.length - 1 ? u : u.map((m) => slimSingleMessage(m, { argCap: 900, toolOutCap: 1800, proseCap: 8_000 }))
    );
    let budget = 85_000;
    const keptHead = [];
    for (let i = headUnits.length - 1; i >= 0; i -= 1) {
      const sz = JSON.stringify(headUnits[i]).length;
      if (budget - sz < 0 && keptHead.length > 0) break;
      budget -= sz;
      keptHead.unshift(headUnits[i]);
    }
    // Ensure first non-system message starts on `user`
    while (keptHead.length && keptHead[0][0]?.role !== 'user') keptHead.shift();
    const flat = [...keptHead.flat(), ...tailUnits.flat()];
    return sysMsg ? [sysMsg, ...flat] : flat;
  }

  if (level === 2) {
    // Level 2: Digest older turns into a single compact reference block + keep only latest user goal & last 2 units (~34k chars).
    const lastUserIdx = (() => {
      for (let i = units.length - 1; i >= 0; i -= 1) {
        if (units[i][0]?.role === 'user') return i;
      }
      return 0;
    })();
    const droppedGoals = [];
    for (let i = 0; i < lastUserIdx; i += 1) {
      const u0 = units[i][0];
      if (u0?.role === 'user' && typeof u0.content === 'string') {
        droppedGoals.push(u0.content.slice(0, 220));
      }
    }
    const activeSlice = units.slice(lastUserIdx);
    const keptActive =
      activeSlice.length <= 3
        ? activeSlice
        : [activeSlice[0], ...activeSlice.slice(-2)];
    const slimActive = keptActive.map((u, idx, arr) =>
      u.map((m) =>
        slimSingleMessage(m, {
          argCap: idx === arr.length - 1 ? 2400 : 500,
          toolOutCap: idx === arr.length - 1 ? 3000 : 900,
          proseCap: idx === 0 ? 18_000 : 6000,
          stripBinary: idx < arr.length - 1
        })
      )
    );
    const bridge = droppedGoals.length
      ? [
          { role: 'user', content: `[خلاصه خودکار پیام‌های پیشین برای عبور از سقف حجم]:\n- ${droppedGoals.slice(-6).join('\n- ')}` },
          { role: 'assistant', content: 'زمینه فشرده دریافت شد؛ ادامه می‌دهم.' }
        ]
      : [];
    const flat = [...bridge, ...slimActive.flat()];
    return sysMsg ? [sysMsg, ...flat] : flat;
  }

  // Level 3 (Emergency Ultra-Compact): Strip heavy binary Base64 blocks & cap even a giant single turn to ~24k chars!
  const lastUserIdx = (() => {
    for (let i = units.length - 1; i >= 0; i -= 1) {
      if (units[i][0]?.role === 'user') return i;
    }
    return Math.max(0, units.length - 1);
  })();
  const emergencyUnits =
    lastUserIdx === units.length - 1 ? [units[lastUserIdx]] : [units[lastUserIdx], units[units.length - 1]];
  const flat = emergencyUnits.flat().map((m) =>
    slimSingleMessage(m, { argCap: 600, toolOutCap: 1500, proseCap: 18_000, stripBinary: true })
  );
  return sysMsg ? [sysMsg, ...flat] : flat;
}

function computeRateLimitWaitMs(headers, attemptIdx, env) {
  const testOverride = Number(env?._rateLimitWaitMs);
  if (Number.isFinite(testOverride) && testOverride > 0) return testOverride;
  const retryAfterRaw = headers?.get?.('retry-after') || headers?.get?.('x-ratelimit-reset-requests') || '';
  const parsedSec = Number.parseFloat(String(retryAfterRaw).replace(/s$/i, ''));
  if (Number.isFinite(parsedSec) && parsedSec > 0) {
    return Math.min(Math.max(Math.ceil(parsedSec * 1000), 1200), 10_000);
  }
  const schedule = [2000, 4200, 7500];
  return schedule[Math.min(attemptIdx, schedule.length - 1)];
}

function extractGatewayHost(urlStr) {
  try {
    return new URL(String(urlStr || '')).hostname.toLowerCase();
  } catch {
    return String(urlStr || '').toLowerCase();
  }
}

const MODEL_SPECIFIC_NON_FAILOVER_CODES = new Set([
  'model_paid_required',
  'model_not_found',
  'model_unavailable',
  'model_rejected',
  'context_too_large'
]);

const FAILOVER_ELIGIBLE_CODES = new Set([
  'model_rate_limited',
  'model_quota_exhausted',
  'model_upstream',
  'model_auth',
  'model_timeout',
  'model_bad_response',
  'model_unreachable'
]);

const FAILOVER_ELIGIBLE_STATUSES = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

function isFailoverEligibleError(err) {
  if (!err) return false;
  if (err.code === 'turn_stopped' || err.code === 'subrequest_limit') return false;
  if (MODEL_SPECIFIC_NON_FAILOVER_CODES.has(err.code)) return false;
  if (err.partialContent) return false;
  return FAILOVER_ELIGIBLE_CODES.has(err.code) || FAILOVER_ELIGIBLE_STATUSES.has(Number(err.status));
}

function injectRuntimeModelIdentity(messages, { model, baseUrl, gatewaySlot = 1 } = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const first = messages[0];
  if (!first || first.role !== 'system' || typeof first.content !== 'string') return messages;
  if (!first.content.includes('You are CodePilot') || first.content.includes('## Verified Runtime AI Identity')) {
    return messages;
  }
  const host = extractGatewayHost(baseUrl) || String(baseUrl || '');
  const slotNum = Number(gatewaySlot) || 1;
  const identityNote =
    `\n\n## Verified Runtime AI Identity\n` +
    `- Active upstream LLM model ID on this call: \`${model}\` | Active gateway: درگاه ${slotNum} (\`${host}\`).\n` +
    `- IMPORTANT: "CodePilot" is ONLY the IDE/agent application name, NOT your AI model family. Whenever the user asks which AI, LLM, or model you are (e.g. «کدوم هوش مصنوعی هستی؟» / «واقعاً کدوم مدل هستی؟»), report your exact active model ID (\`${model}\`), its real AI creator/family, and active gateway (\`درگاه ${slotNum}: ${host}\`) honestly — even if earlier messages in this chat were generated by a different model.`;
  const next = messages.slice();
  next[0] = { ...first, content: first.content + identityNote };
  return next;
}

function buildOrderedGatewayChain(env) {
  let rawChain = [];
  if (Array.isArray(env?._gatewayChain) && env._gatewayChain.length > 0) {
    rawChain = env._gatewayChain.filter((g) => g && g.baseUrl && g.apiKey).slice(0, MAX_PROVIDER_GATEWAYS);
  } else {
    const primaryUrl = modelEndpoint(env).replace(/\/chat\/completions$/, '');
    const primaryKey = String(env?.MODEL_API_KEY || '').trim();
    if (primaryUrl && primaryKey) {
      rawChain.push({
        id: 'gw-1',
        slot: 1,
        label: 'درگاه ۱',
        baseUrl: primaryUrl,
        apiKey: primaryKey,
        apiKeyPool: Array.isArray(env?._apiKeyPool) && env._apiKeyPool.length > 1 ? env._apiKeyPool : [primaryKey],
        defaultModel: String(env?.MODEL_NAME || '')
      });
    }
    const fb = env?._fallbackProvider;
    if (fb && fb.baseUrl && fb.apiKey) {
      rawChain.push({
        id: fb.id || 'gw-2',
        slot: fb.slot || 2,
        label: fb.label || 'درگاه ۲',
        baseUrl: String(fb.baseUrl),
        apiKey: String(fb.apiKey),
        apiKeyPool: Array.isArray(fb.apiKeyPool) && fb.apiKeyPool.length > 1 ? fb.apiKeyPool : [String(fb.apiKey)],
        defaultModel: String(fb.defaultModel || '')
      });
    }
  }

  if (rawChain.length <= 1) {
    return { rawChain, ordered: rawChain };
  }

  const now = Date.now();
  const healthMap = env?._gatewayHealth && typeof env._gatewayHealth === 'object' ? env._gatewayHealth : {};
  const stickyId = env?._stickyGatewayId ? String(env._stickyGatewayId) : '';

  const stickyList = [];
  const healthyList = [];
  const cooledList = [];

  for (const gw of rawChain) {
    const hKey = gatewayHealthId(gw.slot || 1, gw.baseUrl, gw.id);
    const hEntry = healthMap[hKey] || null;
    const cooldownUntil = Number(hEntry?.cooldownUntil) || 0;
    const onCooldown = cooldownUntil > now;
    if (!onCooldown && stickyId && gw.id === stickyId) {
      stickyList.push(gw);
    } else if (!onCooldown) {
      healthyList.push(gw);
    } else {
      cooledList.push({ gw, cooldownUntil });
    }
  }

  // Sort cooled-down gateways by soonest expiry so if EVERY healthy gateway fails,
  // we still try the most-likely-recovered gateway as a final rescue!
  cooledList.sort((a, b) => a.cooldownUntil - b.cooldownUntil);

  const ordered = [
    ...stickyList,
    ...healthyList,
    ...cooledList.map((entry) => entry.gw)
  ];

  return { rawChain, ordered };
}

/**
 * POST a Chat Completions request using the model's genuine `reasoning_effort`,
 * with automatic runtime self-learning if a new/external model reports different
 * allowed `reasoning_effort` values, upstream SSE streaming in production so
 * large edits never hit non-streaming proxy timeouts, AND smart 10-gateway
 * automatic failover + health-aware gateway selection.
 */
export async function callModel(env, payload) {
  const { rawChain, ordered } = buildOrderedGatewayChain(env);

  // Single-gateway fast path (100% zero-overhead backward compatibility)
  if (ordered.length <= 1) {
    const singleGw = ordered[0] || null;
    try {
      const res = await callModelOnProvider(env, payload);
      if (singleGw && env?._owner) {
        await recordGatewayOutcome(env, env._owner, singleGw, { ok: true });
      }
      if (singleGw && env && typeof env === 'object') {
        env._activeGateway = { id: singleGw.id, slot: singleGw.slot, label: singleGw.label || '', baseUrl: singleGw.baseUrl };
      }
      return res;
    } catch (err) {
      if (singleGw && env?._owner && isFailoverEligibleError(err)) {
        await recordGatewayOutcome(env, env._owner, singleGw, {
          ok: false,
          status: err?.status,
          code: err?.code,
          isDailyQuota: Boolean(err?.isDailyQuota)
        });
      }
      throw err;
    }
  }

  // Multi-Gateway Smart Selection & Failover (درگاه ۱ تا ۱۰)
  const primaryHost = extractGatewayHost(rawChain[0]?.baseUrl || env?.MODEL_BASE_URL);
  let lastErr = null;

  // If Gateway #1 was already on quota/rate-limit cooldown and we jumped straight to a healthy working gateway:
  if (ordered[0].slot > 1 && !env?._notifiedAutoHealthySwitch) {
    if (env && typeof env === 'object') env._notifiedAutoHealthySwitch = true;
    try {
      payload?.onDelta?.({
        type: 'provider_failover',
        fromBaseUrl: rawChain[0]?.baseUrl || '',
        fromSlot: 1,
        toBaseUrl: ordered[0].baseUrl,
        slot: ordered[0].slot,
        label: ordered[0].label || '',
        totalGateways: rawChain.length,
        reason: 'cooldown_skip'
      });
    } catch { /* ignore */ }
  }

  for (let gIdx = 0; gIdx < ordered.length; gIdx += 1) {
    const gw = ordered[gIdx];
    const hasNextGateway = gIdx + 1 < ordered.length;
    const gwDiscovered =
      gw.slot === 1 && env?._discoveredSpecs
        ? env._discoveredSpecs
        : await loadDiscoveredSpecs(env, gw.baseUrl).catch(() => ({}));
    const isTooken = isTookenUrl(gw.baseUrl);
    const gwEnv = {
      ...env,
      MODEL_BASE_URL: gw.baseUrl,
      MODEL_API_KEY: gw.apiKey,
      MODEL_NAME: gw.defaultModel || '',
      MODEL_FALLBACK: gw.slot === 1 && isTooken ? env.MODEL_FALLBACK : 'off',
      _apiKeyPool: Array.isArray(gw.apiKeyPool) && gw.apiKeyPool.length > 1 ? gw.apiKeyPool : null,
      _fallbackProvider: null,
      _gatewaySlot: gw.slot || 1,
      _hasNextGateway: hasNextGateway,
      _isFallbackAttempt: gw.slot > 1,
      _discoveredSpecs: gwDiscovered
    };

    let gwModel;
    if (gw.slot === 1) {
      gwModel = payload?.model;
    } else if (gw.defaultModel) {
      gwModel = gw.defaultModel;
    } else if (extractGatewayHost(gw.baseUrl) === primaryHost) {
      gwModel = payload?.model;
    } else {
      gwModel = '';
    }

    try {
      const out = await callModelOnProvider(gwEnv, {
        ...payload,
        model: gwModel
      });
      if (env?._owner) {
        await recordGatewayOutcome(env, env._owner, gw, { ok: true });
      }
      if (env && typeof env === 'object') {
        env._stickyGatewayId = gw.id;
        env._activeGateway = {
          id: gw.id,
          slot: gw.slot,
          label: gw.label || `درگاه ${gw.slot}`,
          baseUrl: gw.baseUrl
        };
      }
      return out;
    } catch (err) {
      lastErr = err;
      if (err?.code === 'turn_stopped' || err?.code === 'subrequest_limit' || err?.partialContent) {
        throw err;
      }
      if (env && typeof env === 'object' && env._stickyGatewayId === gw.id) {
        env._stickyGatewayId = '';
      }
      if (env?._owner && isFailoverEligibleError(err)) {
        await recordGatewayOutcome(env, env._owner, gw, {
          ok: false,
          status: err?.status,
          code: err?.code,
          isDailyQuota: Boolean(err?.isDailyQuota)
        });
      }
      if (hasNextGateway && isFailoverEligibleError(err)) {
        const nextGw = ordered[gIdx + 1];
        try {
          payload?.onDelta?.({
            type: 'provider_failover',
            fromBaseUrl: gw.baseUrl,
            fromSlot: gw.slot,
            toBaseUrl: nextGw.baseUrl,
            slot: nextGw.slot,
            label: nextGw.label || '',
            totalGateways: rawChain.length,
            reason: err?.code || String(err?.status || 'failover')
          });
        } catch { /* ignore */ }
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error('هیچ‌کدام از درگاه‌های تعریف‌شده پاسخگو نبودند.');
}

async function callModelOnProvider(env, payload) {
  if (!env.MODEL_API_KEY) {
    fail('MODEL_API_KEY تنظیم نشده است. از بخش ⌁ API کلید سرویس خود را وارد کنید یا در Cloudflare Secrets قرار دهید.', 503, 'model_key_missing');
  }
  const primaryKeyPool =
    Array.isArray(env._apiKeyPool) && env._apiKeyPool.length > 1
      ? env._apiKeyPool
      : [env.MODEL_API_KEY];
  let activeKeyIdx = 0;
  const endpoint = modelEndpoint(env);
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const isTooken = isTookenUrl(baseUrl);
  const isOpenRouter = isOpenRouterUrl(baseUrl);
  let resolvedLiveDefault = '';
  if (!payload.model && !env.MODEL_NAME && !isTooken) {
    if (isOpenRouter) {
      const mem = liveModelsByEndpoint.get(baseUrl);
      if (mem?.byId?.size) {
        resolvedLiveDefault = pickSmartProviderDefaultModel(baseUrl, mem.byId);
      } else {
        const d1List = await loadCachedProviderModels(env, baseUrl).catch(() => null);
        if (Array.isArray(d1List) && d1List.length) {
          resolvedLiveDefault = pickSmartProviderDefaultModel(baseUrl, new Map(d1List.map((m) => [m.id, m])));
        } else {
          resolvedLiveDefault = 'openrouter/auto';
        }
      }
    } else {
      try {
        const liveModels = await fetchProviderModels(env);
        if (liveModels.length) {
          resolvedLiveDefault = pickSmartProviderDefaultModel(baseUrl, new Map(liveModels.map((m) => [m.id, m])));
        }
      } catch {
        resolvedLiveDefault = '';
      }
    }
  }
  const defaultModel =
    resolvedLiveDefault ||
    String(env.MODEL_NAME || (isOpenRouter ? 'openrouter/auto' : 'claude-sonnet-5-5'));
  const requestedModel = payload.model ? sanitizeModelId(payload.model, env) : defaultModel;
  const requestedEffort = normalizeReasoningEffort(payload.reasoningEffort, requestedModel, payload.thinking, env);
  const deepTimeout =
    requestedEffort === 'high' || requestedEffort === 'xhigh' || requestedEffort === 'max'
      ? 150_000
      : DEFAULT_TIMEOUT_MS;
  const requestedTimeout = Number(payload.timeoutMs) || 0;
  const timeout = Math.min(
    Math.max(Number(env.MODEL_TIMEOUT_MS) || deepTimeout, requestedTimeout),
    180_000
  );
  const allowFailover = Boolean(env.CF_PAGES) && env.MODEL_FALLBACK !== 'off' && isTooken;
  // Always stream upstream whenever `onDelta` is provided (such as `/api/chat`), regardless of `env.CF_PAGES`
  // (which Cloudflare Pages sets at build time, NOT at Functions runtime!), preventing 90-100s non-streaming 524 timeouts!
  const useUpstreamStream =
    payload.upstreamStream === true ||
    (payload.upstreamStream !== false && typeof payload.onDelta === 'function') ||
    (payload.upstreamStream !== false && /moonmath\.ai/i.test(baseUrl));
  const candidates = [requestedModel];
  if (allowFailover) {
    for (const candidate of FALLBACK_MODELS) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
      if (candidates.length >= 3) break;
    }
  }

  let activeMessages = payload.messages;
  // Pre-flight guard: if pure text + tool arguments exceed ~220k chars (~440 KB in UTF-8 Persian/JSON),
  // slim redundant historical tool payloads BEFORE hitting Nginx 512KB/1MB 413 walls (never strips latest image/file attachments).
  if (measureNonBinaryWireChars(activeMessages) > 220_000) {
    activeMessages = compactMessagesForRetry(activeMessages, 1);
    if (measureNonBinaryWireChars(activeMessages) > 220_000) {
      activeMessages = compactMessagesForRetry(activeMessages, 2);
    }
  }
  let downgradedOnce = false;
  let contextShrinkLevel = 0;
  let lastStatus = 0;
  let lastErrDetail = '';

  for (let cIndex = 0; cIndex < candidates.length; cIndex += 1) {
    const model = candidates[cIndex];
    const modelEffort =
      payload.reasoningEffort !== undefined || payload.thinking !== undefined
        ? normalizeReasoningEffort(payload.reasoningEffort, model, payload.thinking, env)
        : null;
    let wireVariants = buildReasoningWireVariants(model, modelEffort, payload);
    let variantIdx = 0;
    let netRetries = 0;
    let statusRetries = 0;
    let rateLimitRetries = 0;
    let forceNonStreamFallback = false;
    let omitStreamOptions = false;
    let omitCacheControl = false;
    const tokenSaverMode = payload.tokenSaver || env?._agentConfig?.tokenSaver || 'max';
    const gatewaySlot = Number(env?._gatewaySlot) || 1;

    while (variantIdx < wireVariants.length) {
      const currentVariant = wireVariants[variantIdx];
      const streamThisAttempt = useUpstreamStream && !forceNonStreamFallback;
      const identityMessages = injectRuntimeModelIdentity(activeMessages, {
        model,
        baseUrl,
        gatewaySlot
      });
      const cacheWrapped = omitCacheControl
        ? { messages: identityMessages, tools: payload.tools, injected: false }
        : applyPromptCacheBreakpoints(identityMessages, payload.tools, {
            baseUrl,
            model,
            tokenSaver: tokenSaverMode
          });
      const body = JSON.stringify({
        model,
        stream: streamThisAttempt,
        ...(streamThisAttempt && !omitStreamOptions ? { stream_options: { include_usage: true } } : {}),
        ...currentVariant.params,
        messages: cacheWrapped.messages,
        ...(cacheWrapped.tools && cacheWrapped.tools.length
          ? { tools: cacheWrapped.tools, tool_choice: payload.tool_choice || 'auto' }
          : {})
      });

      let response;
      try {
        if (payload.signal?.aborted) {
          const stopErr = new Error('اجرای پاسخ توسط کاربر متوقف شد.');
          stopErr.status = 499;
          stopErr.code = 'turn_stopped';
          throw stopErr;
        }
        if (env?._subreq && typeof env._subreq.count === 'number') {
          env._subreq.count += 1;
        }
        const combinedSignal = payload.signal
          ? AbortSignal.any([payload.signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout);
        response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'manual',
          signal: combinedSignal,
          headers: {
            Authorization: `Bearer ${primaryKeyPool[activeKeyIdx] || env.MODEL_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: streamThisAttempt ? 'text/event-stream, application/json' : 'application/json',
            ...providerExtraHeaders(baseUrl)
          },
          body
        });
      } catch (error) {
        lastStatus = 0;
        if (error?.code === 'turn_stopped' || payload.signal?.aborted) {
          const stopErr = new Error('اجرای پاسخ توسط کاربر متوقف شد.');
          stopErr.status = 499;
          stopErr.code = 'turn_stopped';
          throw stopErr;
        }
        if (/too many subrequests|subrequest limit/i.test(String(error?.message || ''))) {
          fail(
            'سقف درخواست‌های یک موج کلودفلر پر شد؛ موج بعدی در حال ادامه است.',
            503,
            'subrequest_limit'
          );
        }
        if (netRetries === 0 && cIndex === 0 && !env?._hasNextGateway) {
          netRetries += 1;
          await sleep(400);
          continue;
        }
        if (cIndex + 1 < candidates.length) break;
        fail(
          error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? 'پاسخ مدل طولانی شد و به سقف زمان مجاز رسید. پیشرفت ذخیره شد؛ بنویسید «ادامه» تا از همین نقطه ادامه یابد.'
            : 'ارتباط با سرویس مدل برقرار نشد. پیشرفت ذخیره شد؛ بنویسید «ادامه».',
          504,
          'model_unreachable'
        );
      }

      if (response.ok) {
        const secrets = envSecrets(env);
        const ct = String(response.headers?.get?.('content-type') || '').toLowerCase();
        let parsedOutcome;
        if (ct.includes('text/event-stream')) {
          parsedOutcome = await consumeChatSseResponse(response, payload.onDelta, payload.signal || null);
        } else {
          let rawBodyText = '';
          try {
            rawBodyText = await response.text();
            parsedOutcome = parseHybridTextPayload(rawBodyText, payload.onDelta);
          } catch {
            parsedOutcome = { kind: 'unreadable', data: null };
          }
        }

        const snap = parsedOutcome?.snap || null;
        const data = parsedOutcome?.data || null;

        if (payload.signal?.aborted) {
          const stopErr = new Error('اجرای پاسخ توسط کاربر متوقف شد.');
          stopErr.status = 499;
          stopErr.code = 'turn_stopped';
          if (snap?.rawContent) stopErr.partialContent = stripSecrets(snap.rawContent, secrets);
          if (snap?.rawReasoning) stopErr.partialReasoning = stripSecrets(snap.rawReasoning, secrets);
          if (snap?.rawToolCalls?.length) stopErr.partialToolCalls = snap.rawToolCalls;
          throw stopErr;
        }

        // 1. Inline error returned inside a 200 JSON or mid-SSE stream (e.g. quota exhausted mid-generation)
        const inlineErrRaw = snap?.inlineError || parsedOutcome?.error || (data?.error && !data?.choices?.length ? data.error : null);
        if (inlineErrRaw) {
          const classified = classifyInlineProviderError(inlineErrRaw, secrets, {
            isOpenRouter,
            model,
            baseUrl,
            hasPartialContent: Boolean(snap?.rawContent)
          });
          const err = new Error(classified.message);
          err.status = classified.status;
          err.code = classified.code;
          if (snap?.rawContent) err.partialContent = stripSecrets(snap.rawContent, secrets);
          if (snap?.rawReasoning) err.partialReasoning = stripSecrets(snap.rawReasoning, secrets);
          if (snap?.rawToolCalls?.length) err.partialToolCalls = snap.rawToolCalls;
          throw err;
        }

        // 2. Empty / HTML / unreadable gateway response before any output was produced -> auto-retry!
        if (!data || parsedOutcome.kind === 'empty' || parsedOutcome.kind === 'html' || parsedOutcome.kind === 'unreadable') {
          if (statusRetries === 0 && cIndex === 0) {
            statusRetries += 1;
            if (streamThisAttempt) forceNonStreamFallback = true;
            await sleep(450);
            continue;
          }
          if (cIndex + 1 < candidates.length) break;
          fail(
            parsedOutcome?.kind === 'html'
              ? 'درگاه سرویس مدل به جای JSON صفحه خطای وب (HTML/Timeout) برگرداند. آدرس/کلید API را بررسی کنید یا «ادامه» بزنید.'
              : 'پاسخ سرویس مدل ناقص یا غیرقابل‌خواندن بود. کلید/سهمیه API را بررسی کنید و بنویسید «ادامه» تا از همین نقطه ادامه یابد.',
            502,
            'model_bad_response'
          );
        }

        // 3. Mid-stream network drop: if no visible prose was emitted yet, auto-retry transparently before throwing!
        if (snap?.streamInterrupted) {
          const hasVisibleProse = Boolean(snap.rawContent?.trim());
          if (!hasVisibleProse && netRetries < 2 && cIndex === 0) {
            netRetries += 1;
            if (netRetries === 2 && streamThisAttempt) forceNonStreamFallback = true;
            await sleep(450 * netRetries);
            continue;
          }
          if (snap.hasTruncatedToolCall || !hasVisibleProse) {
            const err = new Error(
              'ارتباط استریم با سرویس مدل در میانه کار قطع شد. تمام مراحل قبلی ذخیره شد؛ بنویسید «ادامه» تا دقیقاً از همین نقطه ادامه یابد.'
            );
            err.status = 502;
            err.code = 'stream_interrupted';
            if (snap.rawContent) err.partialContent = stripSecrets(snap.rawContent, secrets);
            if (snap.rawReasoning) err.partialReasoning = stripSecrets(snap.rawReasoning, secrets);
            if (snap.rawToolCalls?.length) err.partialToolCalls = snap.rawToolCalls;
            throw err;
          }
        }

        const choice = data?.choices?.[0];
        const message = choice?.message;
        if (!message || typeof message !== 'object') {
          if (statusRetries === 0 && cIndex === 0) {
            statusRetries += 1;
            if (streamThisAttempt) forceNonStreamFallback = true;
            await sleep(450);
            continue;
          }
          fail('پاسخ مدل ساختار معتبری نداشت. دوباره تلاش کنید یا «ادامه» بزنید.', 502, 'model_empty');
        }

        const toolCalls = snap?.hasTruncatedToolCall ? [] : normalizeToolCalls(message.tool_calls);
        const { rawReasoning, rawContent } = extractReasoningAndText(message);
        const cleanContent = stripSecrets(rawContent, secrets);
        const cleanReasoning = rawReasoning ? stripSecrets(rawReasoning, secrets) : '';

        const reasoningTokens =
          Number(
            data?.usage?.completion_tokens_details?.reasoning_tokens ??
              data?.usage?.output_tokens_details?.reasoning_tokens ??
              data?.usage?.reasoning_tokens ??
              0
          ) || 0;

        const rateLimit = extractRateLimitHeaders(response.headers);
        if (rateLimit) {
          latestRateLimitByEndpoint.set(baseUrl, rateLimit);
        }

        const cachedTokens =
          Number(
            data?.usage?.prompt_tokens_details?.cached_tokens ??
              data?.usage?.input_tokens_details?.cached_tokens ??
              data?.usage?.cache_read_input_tokens ??
              data?.usage?.cached_tokens ??
              0
          ) || 0;

        const promptTok = Number(data?.usage?.prompt_tokens ?? data?.usage?.input_tokens) || 0;
        const rawCompletionTok = Number(data?.usage?.completion_tokens ?? data?.usage?.output_tokens) || 0;
        const rawTotalTok = Number(data?.usage?.total_tokens) || 0;
        // Prevent 2x double-counting of `reasoning_tokens`: in OpenAI / OpenRouter / DeepSeek / Gemini standard,
        // `completion_tokens` ALREADY includes `completion_tokens_details.reasoning_tokens` (`total_tokens === prompt + completion`).
        const reasoningAlreadyInCompletion =
          reasoningTokens > 0 &&
          rawCompletionTok >= reasoningTokens &&
          (rawTotalTok > 0
            ? Math.abs(rawTotalTok - (promptTok + rawCompletionTok)) <= Math.max(8, Math.floor(reasoningTokens * 0.15))
            : Boolean(data?.usage?.completion_tokens_details || data?.usage?.output_tokens_details));
        const visibleCompletionTok = reasoningAlreadyInCompletion
          ? Math.max(0, rawCompletionTok - reasoningTokens)
          : rawCompletionTok;
        const exactTotalTok =
          rawTotalTok > 0
            ? rawTotalTok
            : promptTok + visibleCompletionTok + reasoningTokens;

        return {
          model: String(data.model || model),
          requestedModel: model,
          finishReason: String(choice.finish_reason || 'stop'),
          interrupted: Boolean(data.interrupted || choice.finish_reason === 'interrupted'),
          reasoning: cleanReasoning,
          reasoningEffort: currentVariant.effort,
          rateLimit,
          message: {
            role: 'assistant',
            content: cleanContent,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
          },
          usage: {
            prompt_tokens: promptTok,
            completion_tokens: visibleCompletionTok,
            reasoning_tokens: reasoningTokens,
            cached_tokens: cachedTokens,
            total_tokens: exactTotalTok
          }
        };
      }

      const status = response.status;
      lastStatus = status;
      const errText = await response.text().catch(() => '');
      const safeDetail = extractSafeUpstreamError(errText, envSecrets(env));
      if (safeDetail) lastErrDetail = safeDetail;

      if (
        (status === 400 || status === 422) &&
        !omitCacheControl &&
        /cache_control|ephemeral/i.test(errText)
      ) {
        omitCacheControl = true;
        continue;
      }

      // Some OpenAI-compatible proxies (Anthropic/Gemini bridges, older OneAPI) reject `stream_options` with 400/422:
      if (
        (status === 400 || status === 422) &&
        streamThisAttempt &&
        !omitStreamOptions &&
        /stream_options|include_usage/i.test(errText)
      ) {
        omitStreamOptions = true;
        continue;
      }

      // Automatic 3-level self-compaction whenever upstream proxy/model returns 413 Payload Too Large or context_length_exceeded
      // (runs BEFORE reasoning_effort fallback so user's chosen Effort stays untouched!):
      if (isContextOverflowError(status, errText) && contextShrinkLevel < 3) {
        const beforeLen = JSON.stringify(activeMessages).length;
        while (contextShrinkLevel < 3) {
          contextShrinkLevel += 1;
          const candidateMsgs = compactMessagesForRetry(activeMessages, contextShrinkLevel);
          const afterLen = JSON.stringify(candidateMsgs).length;
          if (afterLen < beforeLen) {
            activeMessages = candidateMsgs;
            break;
          }
        }
        if (JSON.stringify(activeMessages).length < beforeLen) {
          continue;
        }
      }

      // Runtime self-learning & seamless fallback when a model rejects a reasoning_effort value
      if ((status === 400 || status === 422) && currentVariant.effort !== null) {
        const signal = parseErrorReasoningSignal(errText, currentVariant.effort);

        if (signal.type === 'unsupported') {
          const learned = { supported: false, levels: [], unconfirmed: false, via: 'runtime-learned' };
          if (env._discoveredSpecs) env._discoveredSpecs[model] = learned;
          await saveDiscoveredSpec(env, baseUrl, model, learned).catch(() => {});
          // Jump straight to the plain (no reasoning_effort) variant
          const plainIdx = wireVariants.findIndex((v) => v.effort === null);
          if (plainIdx > variantIdx) {
            variantIdx = plainIdx;
            continue;
          }
        } else if (signal.type === 'exact' && signal.levels.length) {
          const learned = { supported: true, levels: signal.levels, unconfirmed: false, via: 'runtime-learned' };
          if (env._discoveredSpecs) env._discoveredSpecs[model] = learned;
          await saveDiscoveredSpec(env, baseUrl, model, learned).catch(() => {});
          const bestAllowed = normalizeReasoningEffort(currentVariant.effort, model, undefined, {
            ...env,
            _discoveredSpecs: { ...(env._discoveredSpecs || {}), [model]: learned }
          });
          if (bestAllowed && bestAllowed !== currentVariant.effort) {
            wireVariants = [
              ...wireVariants.slice(0, variantIdx + 1),
              {
                effort: bestAllowed,
                params: {
                  reasoning_effort: bestAllowed,
                  ...(bestAllowed === 'none' ? { temperature: payload.temperature ?? 0.3 } : {}),
                  ...(Number(payload.max_tokens ?? payload.maxTokens)
                    ? { max_tokens: Number(payload.max_tokens ?? payload.maxTokens) }
                    : {})
                }
              },
              { effort: null, params: { temperature: payload.temperature ?? 0.3 } }
            ];
            variantIdx += 1;
            continue;
          }
        }

        if (variantIdx + 1 < wireVariants.length) {
          variantIdx += 1;
          continue;
        }
      }

      if ((status === 400 || status === 422 || status === 413 || status === 500 || status === 502 || status === 503) && !downgradedOnce) {
        const downgraded = downgradeUnsupportedFileParts(activeMessages);
        if (downgraded) {
          activeMessages = downgraded;
          downgradedOnce = true;
          continue;
        }
      }

      // Multi-Key Pool Instant Rotation: if current key hit 429 / 402 / 401 and another key exists in pool, rotate immediately with 0 wait!
      if ((status === 429 || status === 402 || status === 401 || status === 403) && activeKeyIdx + 1 < primaryKeyPool.length) {
        activeKeyIdx += 1;
        rateLimitRetries = 0;
        statusRetries = 0;
        continue;
      }

      const isDailyQuota429 =
        status === 429 &&
        /(free-models-per-day|requests[-_\s]*per[-_\s]*day|per[-_\s]*day|daily.*limit|quota.*exceeded|exceeded.*quota|add.*credits)/i.test(
          errText
        );

      // Smart multi-step 429 Rate-Limit backoff during live `/api/chat` streaming (`onDelta` active):
      // Skip backoff sleeps when `isDailyQuota429` OR when another backup gateway (`env._hasNextGateway`) is ready to take over immediately!
      if (status === 429 && !isDailyQuota429 && !env?._hasNextGateway && typeof payload.onDelta === 'function' && rateLimitRetries < 3 && cIndex === 0) {
        const waitMs = computeRateLimitWaitMs(response.headers, rateLimitRetries, env);
        rateLimitRetries += 1;
        try {
          payload.onDelta({ type: 'rate_limit_wait', waitMs, attempt: rateLimitRetries });
        } catch { /* ignore */ }
        await sleep(waitMs);
        continue;
      }

      if (
        !isDailyQuota429 &&
        !env?._hasNextGateway &&
        (status === 408 || status === 429 || status === 499 || status === 500 || status === 502 || status === 503 || status === 504) &&
        statusRetries === 0 &&
        rateLimitRetries === 0 &&
        cIndex === 0
      ) {
        statusRetries += 1;
        await sleep(status === 429 ? 900 : 500);
        continue;
      }

      if ((status === 404 || (status === 429 && !isDailyQuota429 && !env?._hasNextGateway) || status >= 500) && cIndex + 1 < candidates.length) {
        break;
      }

      if (status === 401 || status === 403) {
        fail(
          `کلید API مدل پذیرفته نشد${lastErrDetail ? ` (${lastErrDetail})` : ''}. از بخش ⌁ API کلید یا آدرس سرویس را بررسی کنید.`,
          502,
          'model_auth'
        );
      }
      if (status === 402) {
        const isPaidModelRejection =
          (isOpenRouter && !/(:free|^openrouter\/free)$/i.test(model)) ||
          /(paid\s+model|requires\s+paid|upgrade.*plan.*model|pro\s+plan\s+required|tier.*not\s+include|not\s+available\s+on\s+free)/i.test(
            errText
          );
        if (isPaidModelRejection) {
          fail(
            `💳 مدل «${model}» پولی است و حساب فعلی در این درگاه (${extractGatewayHost(baseUrl)}) شارژ یا اشتراک پولی برای آن ندارد (درگاه تغییر نکرد). یک مدل رایگان (:free) انتخاب کنید یا حساب/درگاه مناسب را فعال کنید.`,
            402,
            'model_paid_required'
          );
        }
        fail(
          `اعتبار یا سهمیه‌ی حساب/کلید در سرویس مدل تمام شده است${lastErrDetail ? ` (${lastErrDetail})` : ''}.`,
          402,
          'model_quota_exhausted'
        );
      }
      if (status === 404) {
        fail(
          `🚫 مدل یا مسیر «${model}» در درگاه فعلی (${extractGatewayHost(baseUrl)}) وجود ندارد یا در دسترس نیست (درگاه تغییر نکرد). لطفاً مدلی از فهرست همین درگاه انتخاب کنید.`,
          502,
          'model_not_found'
        );
      }
      if (status === 408 || status === 499) {
        fail('پاسخ مدل طولانی شد و ارتباط توسط درگاه بسته شد. دوباره تلاش کنید یا سطح تفکر را کمتر کنید.', 504, 'model_timeout');
      }
      if (status === 413) {
        fail('حجم پیام ارسالی بیش از سقف مدل است؛ از دستور /compact یا گفتگوی جدید استفاده کنید.', 413, 'context_too_large');
      }
      if (status === 429) {
        const rateErr = new Error(
          isDailyQuota429
            ? 'سقف ۵۰ درخواست روزانه این کلید در OpenRouter پر شده است. از بخش ⌁ API درگاه‌های پشتیبان (تا ۱۰ درگاه) یا چند کلید چرخشی اضافه کنید.'
            : 'سهمیه‌ی لحظه‌ای سرویس مدل پر شده است. چند ثانیه صبر کنید.'
        );
        rateErr.status = 429;
        rateErr.code = 'model_rate_limited';
        rateErr.isDailyQuota = isDailyQuota429;
        throw rateErr;
      }
      if (status >= 400 && status < 500) {
        if (
          /(not\s+a\s+valid\s+model|model.*(?:not[_\s-]*found|does\s+not\s+exist|unavailable|unknown|deprecated)|no\s+endpoints\s+found)/i.test(
            errText
          )
        ) {
          fail(
            `🚫 مدل «${model}» در درگاه فعلی (${extractGatewayHost(baseUrl)}) وجود ندارد یا در دسترس نیست (درگاه تغییر نکرد). لطفاً مدلی از فهرست همین درگاه انتخاب کنید.`,
            502,
            'model_not_found'
          );
        }
        fail(
          `درخواست توسط مدل رد شد${lastErrDetail ? `: ${lastErrDetail}` : ' (ناسازگاری پارامتر یا محتوا).'}` ,
          502,
          'model_rejected'
        );
      }
      break;
    }
  }

  fail(`سرویس مدل پاسخ معتبری نداد (کد ${lastStatus || 'نامشخص'}).`, 502, 'model_upstream');
}
