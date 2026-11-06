// Universal OpenAI-compatible model client + automatic per-model capability &
// Reasoning Effort discovery engine.
//
// Works out-of-the-box with `https://tooken.club/v1`, OpenRouter, OpenAI,
// DeepSeek, LiteLLM, vLLM, Groq, or any custom `/v1` gateway, and automatically
// discovers exact `reasoning_effort` levels even for brand-new unseen models.

import { fail, sleep, stripSecrets, envSecrets } from './util.js';
import { isTookenUrl, saveDiscoveredSpec } from './provider.js';

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
const MODEL_ID_RE = /^[a-zA-Z0-9._:/-]{1,120}$/;
const DEFAULT_TIMEOUT_MS = 95_000;
const LIVE_MODELS_TTL_MS = 5 * 60 * 1000;

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
    (obj.totals && typeof obj.totals === 'object' ? obj.totals : null) ||
    (obj.summary && typeof obj.summary === 'object' ? obj.summary : null) ||
    (obj.usage && typeof obj.usage === 'object' ? obj.usage : null);

  const promptTokens = firstNum(
    obj.prompt_tokens,
    obj.input_tokens,
    obj.total_prompt_tokens,
    obj.total_input_tokens,
    totalsObj?.prompt_tokens,
    totalsObj?.input_tokens
  );
  const completionTokens = firstNum(
    obj.completion_tokens,
    obj.output_tokens,
    obj.total_completion_tokens,
    obj.total_output_tokens,
    totalsObj?.completion_tokens,
    totalsObj?.output_tokens
  );
  const reasoningTokens = firstNum(
    obj.reasoning_tokens,
    obj.total_reasoning_tokens,
    totalsObj?.reasoning_tokens
  );
  const totalTokens = firstNum(
    obj.total_tokens,
    obj.tokens_used,
    obj.used_tokens,
    obj.tokens,
    totalsObj?.total_tokens,
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
    totalsObj?.total_requests,
    totalsObj?.count
  );
  const totalCost = firstNum(
    obj.total_cost,
    obj.cost,
    obj.spent,
    obj.total_spent,
    obj.total_usage_usd,
    totalsObj?.total_cost,
    totalsObj?.cost,
    totalsObj?.spent
  );
  const currency = String(obj.currency || totalsObj?.currency || '').trim().toUpperCase() || null;

  if (totalTokens === null && requests === null && totalCost === null) return null;
  return {
    ...(totalTokens !== null ? { totalTokens: Math.round(totalTokens) } : {}),
    ...(promptTokens !== null ? { promptTokens: Math.round(promptTokens) } : {}),
    ...(completionTokens !== null ? { completionTokens: Math.round(completionTokens) } : {}),
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
    Accept: 'application/json'
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
  } else if (lowerBase.includes('deepseek.com')) {
    const dsJson = await safeGetJson(`${originUrl}/user/balance`, '/user/balance');
    rawMetrics = extractSafeMetrics(dsJson);
    result = parseQuotaFromObject(dsJson, 'api.deepseek.com/user/balance', 'USD');
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
    // Universal probe for OneAPI/NewAPI, LiteLLM, Tooken-like `/v1/balance`, and OpenAI-compatible gateways
    const now = new Date();
    const start = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const end = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);

    const [v1BalanceJson, v1UsageJson, tokenUsageJson, subJson, billUsageJson, creditGrantsJson, keyInfoJson] =
      await Promise.all([
        safeGetJson(`${baseUrl}/balance`, '/v1/balance'),
        safeGetJson(`${baseUrl}/usage`, '/v1/usage'),
        safeGetJson(`${originUrl}/api/usage/token`, '/api/usage/token'),
        safeGetJson(`${baseUrl}/dashboard/billing/subscription`, '/dashboard/billing/subscription'),
        safeGetJson(`${baseUrl}/dashboard/billing/usage?start_date=${start}&end_date=${end}`, '/dashboard/billing/usage'),
        safeGetJson(`${baseUrl}/dashboard/billing/credit_grants`, '/dashboard/billing/credit_grants'),
        safeGetJson(`${originUrl}/key/info`, '/key/info')
      ]);

    providerUsage = parseProviderUsageObject(v1UsageJson);
    rawMetrics =
      extractSafeMetrics(v1BalanceJson) ||
      extractSafeMetrics(tokenUsageJson) ||
      extractSafeMetrics(subJson) ||
      extractSafeMetrics(creditGrantsJson) ||
      extractSafeMetrics(keyInfoJson);

    result =
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

function inferProvisionalLevels(modelId, { isTooken = true, booleanHint = null } = {}) {
  const s = String(modelId || '').toLowerCase();
  if (booleanHint === false) return [];
  if (
    /^(gpt-3\.5|gpt-4o|gpt-4-turbo|chatgpt-4o|claude-2|claude-3-(?:haiku|sonnet|opus)|claude-3-5-(?:haiku|sonnet)|llama-3\.[012]|mistral-(?:tiny|small|7b)|qwen2\.5-(?!.*qwq))/i.test(
      s
    ) &&
    booleanHint !== true
  ) {
    return [];
  }
  if (isTooken) {
    if (s.startsWith('gemini-')) return [...STANDARD_EFFORTS];
    return [...FULL_TOOKEN_EFFORTS];
  }
  // On external OpenAI-compatible providers (OpenRouter, OpenAI, DeepSeek, Groq, etc.),
  // start with standard 3 levels (`low`, `medium`, `high`) until live auto-discovery probes the exact enum.
  if (booleanHint === true || /(?:^|[-_/:])(o1|o3|o4|gpt-5|gpt-6|claude-(?:3-7|4|5|opus|sonnet|fable)|deepseek-(?:r1|reasoner|v4)|qwq|kimi-k2|grok-[34]|gemini-(?:2\.5|3|4)|glm-[45])/i.test(s)) {
    return [...STANDARD_EFFORTS];
  }
  return [...STANDARD_EFFORTS];
}

function pickDefaultEffort(modelId, levels, preferred) {
  if (!levels || !levels.length) return null;
  if (preferred && levels.includes(preferred)) return preferred;
  if (levels.includes('medium')) return 'medium';
  if (levels.includes('high')) return 'high';
  return levels[0];
}

/**
 * Parse a raw model object returned by `GET /v1/models` (on `tooken.club`, OpenRouter,
 * OpenAI, LiteLLM, or any custom provider) and merge with D1 auto-discovered capabilities.
 */
export function parseProviderModelItem(item, options = {}) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id || !MODEL_ID_RE.test(id) || /(?:^|[-_/:])(whisper|tts|dall-e|moderation|rerank|bge-|text-embedding|embedding)(?:$|[-_/:])/i.test(id)) {
    return null;
  }

  const isTooken = options.isTooken !== undefined ? Boolean(options.isTooken) : true;
  const discovered = options.discoveredMap?.[id] || null;
  const base = isTooken ? CATALOG_BY_ID.get(id) : null;

  const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
  const limits = item.limits && typeof item.limits === 'object' ? item.limits : {};
  const arch = item.architecture && typeof item.architecture === 'object' ? item.architecture : {};
  const topProvider = item.top_provider && typeof item.top_provider === 'object' ? item.top_provider : {};
  const supportedParams = Array.isArray(item.supported_parameters)
    ? item.supported_parameters.map((p) => String(p).toLowerCase())
    : null;

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

  let exactLevels = null;
  let explicitDisabled = false;
  let booleanHint = null;
  let extractedUnconfirmed = false;

  for (const cand of candidates) {
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

  // OpenRouter / vLLM style `supported_parameters`:
  if (!exactLevels && !explicitDisabled && supportedParams && supportedParams.length > 0) {
    const hasReasoningParam =
      supportedParams.includes('reasoning') ||
      supportedParams.includes('reasoning_effort') ||
      supportedParams.includes('include_reasoning') ||
      supportedParams.includes('thinking');
    if (!hasReasoningParam && booleanHint === null) {
      explicitDisabled = true;
    } else if (hasReasoningParam && booleanHint === null) {
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
  } else {
    levels = inferProvisionalLevels(id, { isTooken, booleanHint });
    source = 'provisional';
    needsDiscovery = true;
  }

  const maxInputTokens =
    Number(
      item.max_input_tokens ??
        item.input_token_limit ??
        item.context_length ??
        item.context_window ??
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
    (Array.isArray(arch.input_modalities) ? arch.input_modalities.includes('image') : undefined) ??
    (modalityStr ? modalityStr.includes('image') : undefined);
  const vision = typeof visionRaw === 'boolean' ? visionRaw : (base?.vision ?? null);

  const toolsRaw =
    item.tools ??
    item.supports_tools ??
    item.function_calling ??
    caps.tools ??
    caps.function_calling ??
    (supportedParams ? supportedParams.includes('tools') || supportedParams.includes('tool_choice') : undefined);
  const tools = typeof toolsRaw === 'boolean' ? toolsRaw : (base?.tools ?? true);

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
    subtitle:
      (typeof item.description === 'string' && item.description.trim().slice(0, 140)) ||
      base?.subtitle ||
      '',
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
      unconfirmed,
      source,
      needsDiscovery
    }
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
  return String(env?.MODEL_NAME || 'claude-sonnet-5-5');
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
  if (!isTooken) return [];
  return MODEL_CATALOG.map((item) =>
    parseProviderModelItem({ id: item.id }, { isTooken: true, discoveredMap: env?._discoveredSpecs })
  );
}

/**
 * Fetch full model objects from `{baseUrl}/models` and merge with D1 auto-discovered specs.
 */
export async function fetchProviderModels(env, { force = false } = {}) {
  if (!env?.MODEL_API_KEY) fail('سرویس مدل پیکربندی نشده است.', 503, 'model_key_missing');
  const baseUrl = modelEndpoint(env).replace(/\/chat\/completions$/, '');
  const isTooken = isTookenUrl(baseUrl);
  const cacheEntry = liveModelsByEndpoint.get(baseUrl);

  if (!force && cacheEntry && cacheEntry.until > Date.now() && cacheEntry.list.length) {
    // Re-apply latest D1 discovered specs onto cached items
    if (env._discoveredSpecs && Object.keys(env._discoveredSpecs).length) {
      return cacheEntry.list.map((m) => {
        const d = env._discoveredSpecs[m.id];
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
    return cacheEntry.list;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
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
    const parsed = parseProviderModelItem(typeof rawItem === 'string' ? { id: rawItem } : rawItem, {
      isTooken,
      discoveredMap: env._discoveredSpecs
    });
    if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, parsed);
  }

  const ordered = [];
  if (isTooken) {
    for (const cat of MODEL_CATALOG) {
      if (byId.has(cat.id)) ordered.push(byId.get(cat.id));
    }
  }
  const rest = [...byId.values()]
    .filter((m) => !ordered.some((o) => o.id === m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const list = [...ordered, ...rest];

  liveModelsByEndpoint.set(baseUrl, {
    until: Date.now() + LIVE_MODELS_TTL_MS,
    byId,
    list
  });
  return list;
}

export async function listModels(env) {
  const models = await fetchProviderModels(env, { force: true });
  return models.map((m) => m.id);
}

async function probeSingleChatEffort(endpoint, apiKey, modelId, effortValue, maxTokens = 1, prompt = '1') {
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
      Accept: 'application/json'
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

/**
 * POST a Chat Completions request using the model's genuine `reasoning_effort`,
 * with automatic runtime self-learning if a new/external model reports different
 * allowed `reasoning_effort` values.
 */
export async function callModel(env, payload) {
  if (!env.MODEL_API_KEY) {
    fail('MODEL_API_KEY تنظیم نشده است. از بخش ⌁ API کلید سرویس خود را وارد کنید یا در Cloudflare Secrets قرار دهید.', 503, 'model_key_missing');
  }
  const endpoint = modelEndpoint(env);
  const baseUrl = endpoint.replace(/\/chat\/completions$/, '');
  const defaultModel = String(env.MODEL_NAME || 'claude-sonnet-5-5');
  const requestedModel = payload.model ? sanitizeModelId(payload.model, env) : defaultModel;
  const requestedEffort = normalizeReasoningEffort(payload.reasoningEffort, requestedModel, payload.thinking, env);
  const deepTimeout =
    requestedEffort === 'high' || requestedEffort === 'xhigh' || requestedEffort === 'max'
      ? 150_000
      : DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(Number(env.MODEL_TIMEOUT_MS) || deepTimeout, 160_000);
  const allowFailover = Boolean(env.CF_PAGES) && env.MODEL_FALLBACK !== 'off' && isTookenUrl(baseUrl);
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
        ? normalizeReasoningEffort(payload.reasoningEffort, model, payload.thinking, env)
        : null;
    let wireVariants = buildReasoningWireVariants(model, modelEffort, payload);
    let variantIdx = 0;
    let netRetries = 0;
    let statusRetries = 0;

    while (variantIdx < wireVariants.length) {
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
        response = await fetch(endpoint, {
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
        if (netRetries === 0 && cIndex === 0) {
          netRetries += 1;
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

      if (response.ok) {
        let data;
        try {
          data = await response.json();
        } catch {
          fail('پاسخ مدل قابل خواندن نبود.', 502, 'model_bad_response');
        }
        const choice = data?.choices?.[0];
        const message = choice?.message;
        if (!message || typeof message !== 'object') {
          fail('پاسخ مدل ساختار معتبری نداشت.', 502, 'model_empty');
        }

        const secrets = envSecrets(env);
        const toolCalls = normalizeToolCalls(message.tool_calls);
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

        return {
          model: String(data.model || model),
          finishReason: String(choice.finish_reason || 'stop'),
          reasoning: cleanReasoning,
          reasoningEffort: currentVariant.effort,
          rateLimit,
          message: {
            role: 'assistant',
            content: cleanContent,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
          },
          usage: {
            prompt_tokens: Number(data?.usage?.prompt_tokens) || 0,
            completion_tokens: Number(data?.usage?.completion_tokens) || 0,
            reasoning_tokens: reasoningTokens
          }
        };
      }

      const status = response.status;
      lastStatus = status;

      // Runtime self-learning & seamless fallback when a model rejects a reasoning_effort value
      if ((status === 400 || status === 422) && currentVariant.effort !== null) {
        const errText = await response.text().catch(() => '');
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

      if ((status === 400 || status === 422 || status === 500 || status === 502 || status === 503) && !downgradedOnce) {
        const downgraded = downgradeUnsupportedFileParts(activeMessages);
        if (downgraded) {
          activeMessages = downgraded;
          downgradedOnce = true;
          continue;
        }
      }

      if ((status === 429 || status === 500 || status === 502 || status === 503 || status === 504) && statusRetries === 0 && cIndex === 0) {
        statusRetries += 1;
        await sleep(status === 429 ? 900 : 500);
        continue;
      }

      if ((status === 404 || status === 429 || status >= 500) && cIndex + 1 < candidates.length) {
        break;
      }

      if (status === 401 || status === 403) {
        fail('کلید API مدل پذیرفته نشد. از بخش ⌁ API کلید یا آدرس سرویس را بررسی کنید.', 502, 'model_auth');
      }
      if (status === 404) {
        fail(`مدل یا مسیر «${model}» در سرویس فعلی پیدا نشد (آدرس یا نام مدل را بررسی کنید).`, 502, 'model_not_found');
      }
      if (status === 413) {
        fail('حجم پیام ارسالی بیش از سقف مدل است؛ گفتگو را کوتاه‌تر کنید یا گفتگوی جدید بسازید.', 413, 'context_too_large');
      }
      if (status === 429) {
        fail('سهمیه‌ی سرویس مدل موقتاً پر شده است. چند ثانیه صبر کنید.', 429, 'model_rate_limited');
      }
      if (status >= 400 && status < 500) {
        fail('درخواست توسط مدل رد شد (ناسازگاری پارامتر یا محتوا).', 502, 'model_rejected');
      }
      break;
    }
  }

  fail(`سرویس مدل پاسخ معتبری نداد (کد ${lastStatus || 'نامشخص'}).`, 502, 'model_upstream');
}
