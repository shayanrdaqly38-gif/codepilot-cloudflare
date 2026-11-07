// GET  /api/config — non-secret runtime configuration + live models for the UI.
// POST /api/config — save or reset per-user custom OpenAI-compatible API provider
//                    (Base URL + AES-GCM encrypted API Key + optional Default Model)
//                    and immediately hydrate its live `/v1/models` list.

import { route, methodNotAllowed } from '../_lib/api.js';
import { sandboxEnabled, linuxRunnerEnabled, realExecutionMode } from '../_lib/sandbox.js';
import {
  catalogModelsWithSpecs,
  fetchProviderModels,
  getModelReasoningSpec,
  parseProviderModelItem,
  pickSmartProviderDefaultModel
} from '../_lib/model.js';
import {
  getUserAgentConfig,
  getUserProviderSummary,
  getUserSandboxSummary,
  isOpenRouterUrl,
  isTookenUrl,
  loadCachedProviderModels,
  resolveEffectiveEnv,
  saveUserAgentConfig,
  saveUserProviderConfig,
  saveUserSandboxConfig
} from '../_lib/provider.js';

async function buildModelsPayload(effectiveEnv, { force = false, skipRemote = false } = {}) {
  const baseUrl = String(effectiveEnv.MODEL_BASE_URL || 'https://tooken.club/v1');
  const isTooken = isTookenUrl(baseUrl);
  const isOpenRouter = isOpenRouterUrl(baseUrl);
  const byId = new Map(catalogModelsWithSpecs(effectiveEnv).map((m) => [m.id, m]));
  let modelsSource = byId.size > 0 ? 'catalog' : 'empty';

  if (skipRemote) {
    const cached = await loadCachedProviderModels(effectiveEnv, baseUrl).catch(() => null);
    if (Array.isArray(cached) && cached.length) {
      modelsSource = 'cache';
      if (!isTooken) byId.clear();
      for (const item of cached) byId.set(item.id, item);
    }
  } else if (effectiveEnv.MODEL_API_KEY && (effectiveEnv.CF_PAGES || effectiveEnv._customProvider || force)) {
    try {
      const live = await fetchProviderModels(effectiveEnv, { force });
      if (live.length) {
        modelsSource = 'remote';
        if (!isTooken) byId.clear();
        for (const item of live) byId.set(item.id, item);
      }
    } catch {
      // Non-fatal during initial bootstrap or save; user still gets saved key + fallback catalog.
    }
  }

  let defaultModel = String(effectiveEnv.MODEL_NAME || '').trim();
  if (!isTooken && (!defaultModel || (byId.size > 0 && !byId.has(defaultModel) && defaultModel === 'claude-sonnet-5-5'))) {
    defaultModel = pickSmartProviderDefaultModel(baseUrl, byId, defaultModel);
  }
  if (!defaultModel) defaultModel = isOpenRouter ? 'openrouter/auto' : 'claude-sonnet-5-5';

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
    const sb = sandboxEnabled(env);
    const [effectiveEnv, provider, agentConfig, sandboxConfig] = await Promise.all([
      resolveEffectiveEnv(env, identity.owner),
      getUserProviderSummary(env, identity.owner),
      getUserAgentConfig(env, identity.owner),
      getUserSandboxSummary(env, identity.owner)
    ]);
    const linux = linuxRunnerEnabled(effectiveEnv);
    // Avoid downloading multi-MB aggregator `/models` lists synchronously during cold boot on OpenRouter;
    // serve D1-cached or curated OpenRouter models immediately (<1ms CPU) and hydrate live models via `/api/models`.
    const skipBootRemote = isOpenRouterUrl(effectiveEnv.MODEL_BASE_URL);
    const { defaultModel, modelsSource, models } = await buildModelsPayload(effectiveEnv, {
      skipRemote: skipBootRemote
    });

    return {
      ok: true,
      auth: identity.via === 'dev-fallback' ? 'dev-fallback' : 'cloudflare-access',
      singleTenant: identity.via === 'dev-fallback',
      storage: 'd1',
      user: { email: identity.email, name: identity.name },
      provider,
      agentConfig,
      sandboxConfig,
      model: defaultModel,
      modelReasoning: getModelReasoningSpec(defaultModel, effectiveEnv),
      modelsSource,
      models,
      contextBudgetTokens: Number(effectiveEnv.CONTEXT_BUDGET_TOKENS || env.CONTEXT_BUDGET_TOKENS) || 24000,
      sandbox: sb,
      linuxRunner: linux,
      workersAi: Boolean(env?.AI && typeof env.AI.run === 'function'),
      executionMode: sandboxConfig.mode === 'local-termux' ? 'local-termux' : realExecutionMode(effectiveEnv),
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
        imageGeneration: true,
        deepThinking: true,
        reasoningEffort: true,
        autoCapabilityDiscovery: true,
        customProvider: true,
        modelPicker: true,
        codexModes: true,
        slashCommands: true,
        agentsMd: true,
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
      let agentConfig;
      if (data?.agentConfig && typeof data.agentConfig === 'object') {
        agentConfig = await saveUserAgentConfig(env, identity.owner, data.agentConfig);
      }
      let sandboxConfig;
      if (data?.sandboxConfig && typeof data.sandboxConfig === 'object') {
        sandboxConfig = await saveUserSandboxConfig(env, identity.owner, data.sandboxConfig);
      }
      const touchesProvider =
        data?.reset !== undefined ||
        data?.baseUrl !== undefined ||
        data?.apiKey !== undefined ||
        data?.clearKey !== undefined ||
        data?.defaultModel !== undefined;

      if (!touchesProvider && (agentConfig || sandboxConfig)) {
        const [provider, effEnv, finalAgentCfg, finalSandboxCfg] = await Promise.all([
          getUserProviderSummary(env, identity.owner),
          resolveEffectiveEnv(env, identity.owner),
          agentConfig ? Promise.resolve(agentConfig) : getUserAgentConfig(env, identity.owner),
          sandboxConfig ? Promise.resolve(sandboxConfig) : getUserSandboxSummary(env, identity.owner)
        ]);
        return {
          ok: true,
          provider,
          agentConfig: finalAgentCfg,
          sandboxConfig: finalSandboxCfg,
          executionMode:
            finalSandboxCfg.mode === 'local-termux' ? 'local-termux' : realExecutionMode(effEnv),
          contextBudgetTokens: finalAgentCfg.contextBudget
        };
      }

      const provider = await saveUserProviderConfig(env, identity.owner, {
        reset: Boolean(data?.reset),
        baseUrl: data?.baseUrl,
        apiKey: data?.apiKey,
        clearKey: Boolean(data?.clearKey),
        defaultModel: data?.defaultModel
      });
      if (!agentConfig) {
        agentConfig = await getUserAgentConfig(env, identity.owner);
      }
      if (!sandboxConfig) {
        sandboxConfig = await getUserSandboxSummary(env, identity.owner);
      }
      const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);
      const skipModels = Boolean(data?.skipModels);
      const { defaultModel, modelsSource, models } = await buildModelsPayload(effectiveEnv, {
        force: !skipModels,
        skipRemote: skipModels
      });

      return {
        ok: true,
        provider,
        agentConfig,
        sandboxConfig,
        executionMode:
          sandboxConfig.mode === 'local-termux' ? 'local-termux' : realExecutionMode(effectiveEnv),
        model: defaultModel,
        modelReasoning: getModelReasoningSpec(defaultModel, effectiveEnv),
        modelsSource,
        modelsDeferred: skipModels,
        models
      };
    },
    { write: true, body: 24_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
