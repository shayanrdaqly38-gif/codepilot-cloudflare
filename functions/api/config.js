// GET  /api/config — non-secret runtime configuration + live models for the UI.
// POST /api/config — save or reset per-user custom OpenAI-compatible API provider
//                    (Base URL + AES-GCM encrypted API Key + optional Default Model)
//                    and immediately hydrate its live `/v1/models` list.

import { route, methodNotAllowed } from '../_lib/api.js';
import { sandboxEnabled, linuxRunnerEnabled, realExecutionMode } from '../_lib/sandbox.js';
import { catalogModelsWithSpecs, fetchProviderModels, getModelReasoningSpec, parseProviderModelItem } from '../_lib/model.js';
import {
  getUserProviderSummary,
  isTookenUrl,
  resolveEffectiveEnv,
  saveUserProviderConfig
} from '../_lib/provider.js';

async function buildModelsPayload(effectiveEnv, { force = false } = {}) {
  const isTooken = isTookenUrl(effectiveEnv.MODEL_BASE_URL);
  const byId = new Map(catalogModelsWithSpecs(effectiveEnv).map((m) => [m.id, m]));
  let modelsSource = isTooken ? 'catalog' : 'empty';

  if (effectiveEnv.MODEL_API_KEY && (effectiveEnv.CF_PAGES || effectiveEnv._customProvider || force)) {
    try {
      const live = await fetchProviderModels(effectiveEnv, { force });
      if (live.length) {
        modelsSource = 'remote';
        if (!isTooken) byId.clear();
        for (const item of live) byId.set(item.id, item);
      }
    } catch {
      // Non-fatal during initial bootstrap; user can inspect diagnostics in ⌁ API.
    }
  }

  let defaultModel = String(effectiveEnv.MODEL_NAME || '').trim();
  if (!isTooken && (!defaultModel || (byId.size > 0 && !byId.has(defaultModel) && defaultModel === 'claude-sonnet-5-5'))) {
    defaultModel = byId.keys().next().value || defaultModel || 'gpt-4o';
  }
  if (!defaultModel) defaultModel = 'claude-sonnet-5-5';

  if (byId.size === 0 && defaultModel) {
    const fallbackItem = parseProviderModelItem(
      { id: defaultModel },
      { isTooken, discoveredMap: effectiveEnv._discoveredSpecs }
    );
    if (fallbackItem) byId.set(defaultModel, fallbackItem);
  }

  return {
    defaultModel,
    modelsSource,
    models: [...byId.values()]
  };
}

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity }) => {
    const linux = linuxRunnerEnabled(env);
    const sb = sandboxEnabled(env);
    const [effectiveEnv, provider] = await Promise.all([
      resolveEffectiveEnv(env, identity.owner),
      getUserProviderSummary(env, identity.owner)
    ]);
    const { defaultModel, modelsSource, models } = await buildModelsPayload(effectiveEnv);

    return {
      ok: true,
      auth: identity.via === 'dev-fallback' ? 'dev-fallback' : 'cloudflare-access',
      singleTenant: identity.via === 'dev-fallback',
      storage: 'd1',
      user: { email: identity.email, name: identity.name },
      provider,
      model: defaultModel,
      modelReasoning: getModelReasoningSpec(defaultModel, effectiveEnv),
      modelsSource,
      models,
      contextBudgetTokens: Number(env.CONTEXT_BUDGET_TOKENS) || 24000,
      sandbox: sb,
      linuxRunner: linux,
      executionMode: realExecutionMode(env),
      features: {
        memory: true,
        sync: true,
        streaming: true,
        workspaceSnapshots: true,
        patchEdits: true,
        search: true,
        validation: true,
        versionHistory: true,
        realShell: sb || linux,
        linuxRunner: linux,
        webSearch: true,
        urlFetch: true,
        deepThinking: true,
        reasoningEffort: true,
        autoCapabilityDiscovery: true,
        customProvider: true,
        modelPicker: true,
        realLogin: identity.via !== 'dev-fallback'
      }
    };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const provider = await saveUserProviderConfig(env, identity.owner, {
        reset: Boolean(data?.reset),
        baseUrl: data?.baseUrl,
        apiKey: data?.apiKey,
        clearKey: Boolean(data?.clearKey),
        defaultModel: data?.defaultModel
      });
      const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);
      const { defaultModel, modelsSource, models } = await buildModelsPayload(effectiveEnv, { force: true });

      return {
        ok: true,
        provider,
        model: defaultModel,
        modelReasoning: getModelReasoningSpec(defaultModel, effectiveEnv),
        modelsSource,
        models
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
