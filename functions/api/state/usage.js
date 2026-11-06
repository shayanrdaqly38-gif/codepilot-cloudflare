// GET  /api/state/usage — per-day token & request counters + live provider quota / remaining tokens.
// POST /api/state/usage — save or clear optional manual token cap for providers without billing APIs.

import { route, methodNotAllowed } from '../../_lib/api.js';
import { getUsage } from '../../_lib/store.js';
import { fetchProviderQuota, getCachedProviderQuota } from '../../_lib/model.js';
import { getUserTokenCap, resolveEffectiveEnv, saveUserTokenCap } from '../../_lib/provider.js';

function summarizeDays(days) {
  const mapped = days.map((d) => {
    const promptTokens = Number(d.prompt_tokens) || 0;
    const completionTokens = Number(d.completion_tokens) || 0;
    const reasoningTokens = Number(d.reasoning_tokens) || 0;
    return {
      day: d.day,
      requests: d.requests || 0,
      inputChars: d.input_chars || 0,
      outputChars: d.output_chars || 0,
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens: promptTokens + completionTokens + reasoningTokens
    };
  });

  const totals = mapped.reduce(
    (acc, day) => ({
      requests: acc.requests + day.requests,
      inputChars: acc.inputChars + day.inputChars,
      outputChars: acc.outputChars + day.outputChars,
      promptTokens: acc.promptTokens + day.promptTokens,
      completionTokens: acc.completionTokens + day.completionTokens,
      reasoningTokens: acc.reasoningTokens + day.reasoningTokens,
      totalTokens: acc.totalTokens + day.totalTokens
    }),
    {
      requests: 0,
      inputChars: 0,
      outputChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    }
  );

  return { mapped, totals };
}

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const [days, tokenCap, effectiveEnv] = await Promise.all([
      getUsage(env, identity.owner),
      getUserTokenCap(env, identity.owner),
      resolveEffectiveEnv(env, identity.owner)
    ]);
    const { mapped, totals } = summarizeDays(days);

    const live = url.searchParams.get('live') === '1';
    const force = url.searchParams.get('refresh') === '1';
    const quota = live
      ? await fetchProviderQuota(effectiveEnv, { force }).catch(() => getCachedProviderQuota(effectiveEnv))
      : getCachedProviderQuota(effectiveEnv);

    return {
      ok: true,
      days: mapped,
      totals,
      tokenCap,
      quota: quota || { supported: false, rateLimit: null }
    };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const tokenCap = await saveUserTokenCap(env, identity.owner, data?.tokenCap);
      const days = await getUsage(env, identity.owner);
      const { mapped, totals } = summarizeDays(days);
      return {
        ok: true,
        tokenCap,
        days: mapped,
        totals
      };
    },
    { write: true, body: 8_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
