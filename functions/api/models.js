// GET  /api/models — returns all available models from the active API provider's `/v1/models`
//                    with real capabilities & D1 auto-discovered `reasoning_effort` levels.
// POST /api/models — automatically probes & discovers the genuine `reasoning_effort` levels
//                    supported by any model (including brand-new unseen models on any API)
//                    and caches them in D1.

import { route, methodNotAllowed } from '../_lib/api.js';
import {
  catalogModelsWithSpecs,
  discoverModelCapabilities,
  fetchProviderModels,
  parseProviderModelItem,
  pickSmartProviderDefaultModel
} from '../_lib/model.js';
import { isOpenRouterUrl, isTookenUrl, resolveEffectiveEnv } from '../_lib/provider.js';
import { fail } from '../_lib/util.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);
    const baseUrl = String(effectiveEnv.MODEL_BASE_URL || 'https://tooken.club/v1');
    const isTooken = isTookenUrl(baseUrl);
    const isOpenRouter = isOpenRouterUrl(baseUrl);
    const force = url.searchParams.get('refresh') === '1';
    const byId = new Map(catalogModelsWithSpecs(effectiveEnv).map((m) => [m.id, m]));

    let source = byId.size > 0 ? 'catalog' : 'empty';
    let liveError = null;
    let resolvedBaseUrl = baseUrl;
    try {
      const liveList = await fetchProviderModels(effectiveEnv, { force });
      if (liveList.length) {
        source = 'remote';
        if (!isTooken) byId.clear();
        for (const item of liveList) {
          byId.set(item.id, item);
        }
      }
    } catch (err) {
      liveError = err?.message || null;
      // If Gateway 1 failed and backup gateways (2..10) exist, automatically load models from the first working gateway!
      const backups = Array.isArray(effectiveEnv._gatewayChain) ? effectiveEnv._gatewayChain.slice(1) : [];
      for (const gw of backups) {
        try {
          const gwEnv = {
            ...effectiveEnv,
            MODEL_BASE_URL: gw.baseUrl,
            MODEL_API_KEY: gw.apiKey,
            MODEL_NAME: gw.defaultModel || ''
          };
          const fbList = await fetchProviderModels(gwEnv, { force });
          if (fbList.length) {
            source = 'remote';
            liveError = null;
            resolvedBaseUrl = gw.baseUrl;
            byId.clear();
            for (const item of fbList) byId.set(item.id, item);
            break;
          }
        } catch {
          // Try next gateway
        }
      }
    }

    const finalIsTooken = isTookenUrl(resolvedBaseUrl);
    const finalIsOpenRouter = isOpenRouterUrl(resolvedBaseUrl);
    let defaultModel = String(effectiveEnv.MODEL_NAME || '').trim();
    if (!finalIsTooken && (!defaultModel || (byId.size > 0 && !byId.has(defaultModel) && defaultModel === 'claude-sonnet-5-5'))) {
      defaultModel = pickSmartProviderDefaultModel(resolvedBaseUrl, byId, defaultModel);
    }
    if (!defaultModel) defaultModel = finalIsOpenRouter ? 'openrouter/auto' : 'claude-sonnet-5-5';

    if (defaultModel && !byId.has(defaultModel)) {
      const parsedDefault = parseProviderModelItem(
        { id: defaultModel },
        { isTooken: finalIsTooken, discoveredMap: effectiveEnv._discoveredSpecs }
      );
      if (parsedDefault) byId.set(defaultModel, parsedDefault);
    }

    return {
      ok: true,
      defaultModel,
      baseUrl: resolvedBaseUrl || 'https://tooken.club/v1',
      source,
      ...(liveError && source !== 'remote' ? { warning: liveError } : {}),
      models: [...byId.values()]
    };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const modelId = typeof data?.model === 'string' ? data.model.trim() : '';
      if (!modelId) fail('شناسه‌ی مدل ارسال نشده است.', 400, 'missing_model');
      const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);
      const discovered = await discoverModelCapabilities(effectiveEnv, modelId, {
        force: Boolean(data?.force)
      });
      return {
        ok: true,
        model: discovered.model,
        reasoning: discovered
      };
    },
    { write: true, body: 16_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
