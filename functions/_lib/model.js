// The single place that talks to the model provider.
// The API key stays in Cloudflare secrets and is never returned or logged.

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

export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

export const EFFORT_BUDGET_TOKENS = {
  off: 0,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 31_999
};

export const MODEL_CATALOG = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — قوی‌ترین استدلال و معماری کد', tier: 'flagship' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — سریع، دقیق و متعادل (پیش‌فرض)', tier: 'balanced' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol — پرچم‌دار استدلال و کدنویسی', tier: 'flagship' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — تخصصی الگوریتم و تفکر عمیق', tier: 'reasoning' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon — زمینه طولانی و چندمنظوره', tier: 'flagship' },
  { id: 'grok-4.7', label: 'Grok 4.7 — تحلیل عمیق و حل مسئله', tier: 'flagship' },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra — مهندسی نرم‌افزار پیشرفته', tier: 'balanced' },
  { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro — تحلیل پروژه‌های بزرگ', tier: 'reasoning' },
  { id: 'glm-5.3', label: 'GLM 5.3 — کدنویسی و ابزارخوانی دقیق', tier: 'balanced' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5 — نسخه پایدار کلود اپوس', tier: 'balanced' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 — خلاق و روان', tier: 'balanced' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna — پاسخ‌گویی سریع و هوشمند', tier: 'fast' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra — سبک و پرسرعت', tier: 'fast' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — فوق‌سریع و کم‌هزینه', tier: 'fast' },
  { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash — سریع برای ویرایش‌های کوتاه', tier: 'fast' },
  { id: 'gemini-3-8-flash', label: 'Gemini 3.8 Flash — بسیار سریع', tier: 'fast' },
  { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash — سریع و اقتصادی', tier: 'fast' }
];

const MODEL_ID_RE = /^[a-zA-Z0-9._:/-]{1,120}$/;
const DEFAULT_TIMEOUT_MS = 95_000;

function detectModelFamily(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('claude')) return 'anthropic';
  if (/^(gpt|o1|o3|o4|chatgpt)/.test(s) || s.includes('/gpt') || s.includes('/o3') || s.includes('/o4')) return 'openai';
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('grok')) return 'xai';
  if (s.includes('kimi') || s.includes('moonshot')) return 'kimi';
  if (s.includes('glm')) return 'glm';
  return 'other';
}

/**
 * Return the model's genuine native Reasoning Effort capability profile
 * (Claude Code–style levels: off / low / medium / high / max).
 */
export function getModelReasoningSpec(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  const family = detectModelFamily(id);

  // Fast / lightweight non-reasoning models: do NOT pretend they have Reasoning Effort.
  if (
    !id ||
    /(?:^|[-_/:])(flash|mini|lite|nano|haiku|luna|astra|instant|turbo)(?:$|[-_/:0-9])/.test(id) ||
    /^(gpt-3\.5|gpt-4o|claude-3-(?:haiku|sonnet|opus)|claude-2)/.test(id)
  ) {
    return {
      supported: false,
      family,
      levels: [],
      defaultEffort: 'off',
      budgets: EFFORT_BUDGET_TOKENS
    };
  }

  // Flagship & dedicated reasoning models unlock `max` (32k thinking budget / xhigh), just like Opus in Claude Code.
  const unlocksMax =
    /(?:opus|gpt-6\.1-sol|o1|o3|o4|deepseek-.*(?:pro|r1|reasoner)|kimi-.*(?:pro|thinking)|gemini-4-argon|gemini-.*pro|grok-4|qwq)/.test(
      id
    );

  const defaultEffort = /(?:deepseek-.*(?:pro|r1|reasoner)|kimi-.*(?:pro|thinking)|^o[134]|opus-5)/.test(id)
    ? 'high'
    : 'medium';

  return {
    supported: true,
    family,
    levels: unlocksMax ? ['off', 'low', 'medium', 'high', 'max'] : ['off', 'low', 'medium', 'high'],
    defaultEffort,
    budgets: EFFORT_BUDGET_TOKENS
  };
}

/**
 * Sanitize a requested reasoning effort against what `modelId` actually supports.
 * Returns `'off' | 'low' | 'medium' | 'high' | 'max'`, or `null` when no effort control was requested.
 */
export function normalizeReasoningEffort(value, modelId, legacyThinking = undefined) {
  const spec = getModelReasoningSpec(modelId);
  if (value === undefined || value === null || value === '') {
    if (legacyThinking === undefined) return null;
    if (!legacyThinking || !spec.supported) return 'off';
    return spec.defaultEffort;
  }
  const clean = String(value).trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(clean)) return spec.supported ? spec.defaultEffort : 'off';
  if (!spec.supported) return 'off';
  if (clean === 'max' && !spec.levels.includes('max')) return 'high';
  return clean;
}

/**
 * Build ordered native wire-parameter variants for `/v1/chat/completions`.
 * Variant 0 sends the richest model-native parameters (`reasoning_effort` + `thinking.budget_tokens`
 * with Anthropic/OpenAI temperature rules respected); if a strict proxy schema rejects Variant 0
 * with 400/422, `callModel` seamlessly steps down to Variant 1 (standard `reasoning_effort`) and Variant 2.
 */
export function buildReasoningWireVariants(modelId, effort, payload = {}) {
  const baseTemp = payload.temperature ?? 0.3;
  const explicitMaxTokens = Number(payload.max_tokens) || 0;
  const spec = getModelReasoningSpec(modelId);

  if (!effort || !spec.supported) {
    return [
      {
        effort: null,
        params: {
          temperature: baseTemp,
          ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
        }
      }
    ];
  }

  if (effort === 'off') {
    const plain = {
      effort: 'off',
      params: {
        temperature: baseTemp,
        ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
      }
    };
    if (['anthropic', 'deepseek', 'glm', 'kimi'].includes(spec.family)) {
      return [
        {
          effort: 'off',
          params: {
            temperature: baseTemp,
            thinking: { type: 'disabled' },
            ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
          }
        },
        plain
      ];
    }
    return [plain];
  }

  const budget = EFFORT_BUDGET_TOKENS[effort] || EFFORT_BUDGET_TOKENS.medium;
  const standardEffort = effort === 'max' ? 'high' : effort;
  const variants = [];

  if (spec.family === 'anthropic') {
    // Anthropic native rule: when extended thinking is enabled, custom temperature != 1 is invalid,
    // and max_tokens must exceed budget_tokens.
    const minMaxTokens = Math.max(explicitMaxTokens, budget + 8_192);
    variants.push({
      effort,
      params: {
        reasoning_effort: standardEffort,
        thinking: { type: 'enabled', budget_tokens: budget },
        max_tokens: minMaxTokens
      }
    });
    variants.push({
      effort,
      params: {
        reasoning_effort: standardEffort,
        ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
      }
    });
  } else if (spec.family === 'openai') {
    // OpenAI o-series / GPT-6.1 reasoning models reject non-1 temperature; `max` maps to native `xhigh` then `high`.
    const openAiEffort = effort === 'max' ? 'xhigh' : effort;
    variants.push({
      effort,
      params: {
        reasoning_effort: openAiEffort,
        ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
      }
    });
    if (openAiEffort !== standardEffort) {
      variants.push({
        effort: 'high',
        params: {
          reasoning_effort: standardEffort,
          ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
        }
      });
    }
  } else if (['deepseek', 'glm', 'kimi'].includes(spec.family)) {
    variants.push({
      effort,
      params: {
        reasoning_effort: standardEffort,
        thinking: { type: 'enabled', budget_tokens: budget },
        ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
      }
    });
    variants.push({
      effort,
      params: {
        reasoning_effort: standardEffort,
        ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
      }
    });
  } else {
    // Gemini, xAI Grok, and OpenAI-compatible reasoning endpoints
    variants.push({
      effort,
      params: {
        reasoning_effort: standardEffort,
        ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
      }
    });
  }

  // Final safety fallback if a specific upstream channel does not accept reasoning params at all.
  variants.push({
    effort: null,
    params: {
      temperature: baseTemp,
      ...(explicitMaxTokens ? { max_tokens: explicitMaxTokens } : {})
    }
  });

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

export async function listModels(env) {
  if (!env.MODEL_API_KEY) fail('سرویس مدل پیکربندی نشده است.', 503, 'model_key_missing');
  let response;
  try {
    response = await fetch(modelEndpoint(env).replace(/\/chat\/completions$/, '/models'), {
      headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
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
  if (!Array.isArray(data?.data)) fail('فهرست مدل‌ها نامعتبر است.', 502, 'models_bad_response');
  return [
    ...new Set(
      data.data
        .map((item) => item?.id)
        .filter((id) => typeof id === 'string' && MODEL_ID_RE.test(id) && !/image|whisper|tts|embedding/i.test(id))
    )
  ]
    .sort()
    .slice(0, 500);
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
 * POST a Chat Completions request with genuine native model `reasoning_effort` / `thinking.budget_tokens`,
 * automatic proxy schema negotiation, binary part downgrade, and CF_PAGES 5xx model failover.
 */
export async function callModel(env, payload) {
  if (!env.MODEL_API_KEY) {
    fail('MODEL_API_KEY در Cloudflare Secrets تنظیم نشده است.', 503, 'model_key_missing');
  }
  const defaultModel = String(env.MODEL_NAME || 'claude-sonnet-5-5');
  const requestedModel = payload.model ? sanitizeModelId(payload.model, env) : defaultModel;
  const requestedEffort = normalizeReasoningEffort(payload.reasoningEffort, requestedModel, payload.thinking);
  const deepTimeout = requestedEffort === 'high' || requestedEffort === 'max' ? 145_000 : DEFAULT_TIMEOUT_MS;
  const timeout = Math.min(Number(env.MODEL_TIMEOUT_MS) || deepTimeout, 150_000);
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

      // If the upstream gateway rejected a richer native reasoning schema (400/422),
      // immediately step down to the next standard reasoning parameter variant without delay.
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

    // Only fail over to another model on upstream 5xx / network errors, never on 401/403/404.
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
