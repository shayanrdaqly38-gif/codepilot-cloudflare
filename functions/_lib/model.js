// The single place that talks to the model provider.
// The API key stays in Cloudflare secrets and is never returned or logged.

import { fail, sleep, stripSecrets, envSecrets } from './util.js';

export const ALLOWED_TOOLS = new Set([
  'list_files',
  'read_file',
  'search_code',
  'list_symbols',
  'write_file',
  'apply_patch',
  'undo_edit',
  'run_command'
]);
const DEFAULT_TIMEOUT_MS = 90_000;

function endpoint(env) {
  const base = String(env.MODEL_BASE_URL || 'https://tooken.club/v1').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

/** Validate and normalize the tool definitions the browser may send. */
export function sanitizeTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) fail('تعریف ابزارها نامعتبر است.', 400, 'bad_tools');
  const out = [];
  const seen = new Set();
  for (const tool of tools.slice(0, 16)) {
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

/**
 * POST a Chat Completions request.
 * Retries once on 429/5xx/timeout; never exposes provider error bodies.
 */
export async function callModel(env, payload) {
  if (!env.MODEL_API_KEY) {
    fail('MODEL_API_KEY در Cloudflare Secrets تنظیم نشده است.', 503, 'model_key_missing');
  }
  const model = String(env.MODEL_NAME || 'gpt-4o-mini');
  const timeout = Math.min(Number(env.MODEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 120_000);
  const body = JSON.stringify({
    model,
    stream: false,
    temperature: payload.temperature ?? 0.3,
    ...(payload.max_tokens ? { max_tokens: payload.max_tokens } : {}),
    messages: payload.messages,
    ...(payload.tools && payload.tools.length ? { tools: payload.tools, tool_choice: payload.tool_choice || 'auto' } : {})
  });

  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(endpoint(env), {
        method: 'POST',
        // Cloudflare Workers rejects redirect:'error' outright (the fetch call
        // throws before leaving the isolate), so follow the edge-compatible
        // contract: manual, then treat any 3xx as a failure below.
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
      fail(
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'پاسخ مدل در زمان مجاز دریافت نشد. دوباره تلاش کنید.'
          : 'ارتباط با سرویس مدل برقرار نشد.',
        504,
        'model_unreachable'
      );
    }

    if (response.status >= 300 && response.status < 400) {
      // A redirect means the base URL is wrong or the provider moved; retrying
      // will not help, so fail with a precise message instead of a generic one.
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
      return {
        model: String(data.model || model),
        message: {
          role: 'assistant',
          content: typeof message.content === 'string' ? stripSecrets(message.content, envSecrets(env)) : '',
          tool_calls: normalizeToolCalls(message.tool_calls)
        },
        usage: {
          prompt_tokens: Number(data?.usage?.prompt_tokens) || 0,
          completion_tokens: Number(data?.usage?.completion_tokens) || 0
        }
      };
    }

    lastStatus = response.status;
    // Read and discard the body; provider diagnostics never reach the client.
    await response.text().catch(() => '');
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      const retryAfter = Number(response.headers.get('Retry-After') || 0);
      await sleep(Math.min(Math.max(retryAfter * 1000, 600), 4_000));
      continue;
    }
    break;
  }

  if (lastStatus === 401 || lastStatus === 403) {
    fail('کلید مدل پذیرفته نشد. مقدار MODEL_API_KEY را در Cloudflare بررسی کنید.', 502, 'model_auth');
  }
  if (lastStatus === 429) fail('سرویس مدل محدودیت نرخ اعمال کرد. کمی بعد تلاش کنید.', 429, 'model_rate_limited');
  fail(`سرویس مدل پاسخ نداد (کد ${lastStatus || 'شبکه'}).`, 502, 'model_failed');
}
