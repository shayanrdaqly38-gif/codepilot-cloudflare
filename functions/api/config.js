// GET /api/config — non-secret runtime configuration for the UI.
// Never returns MODEL_API_KEY or any other secret.

import { route, methodNotAllowed } from '../_lib/api.js';
import { sandboxEnabled, linuxRunnerEnabled, realExecutionMode } from '../_lib/sandbox.js';
import { catalogModelsWithSpecs, fetchProviderModels, getModelReasoningSpec } from '../_lib/model.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity }) => {
    const linux = linuxRunnerEnabled(env);
    const sb = sandboxEnabled(env);
    const defaultModel = String(env.MODEL_NAME || 'claude-sonnet-5-5');

    // On live Cloudflare Pages, opportunistically hydrate live `/v1/models` capabilities
    // (cached for 5 minutes) so the UI immediately gets `tooken.club`'s exact per-model specs.
    const byId = new Map(catalogModelsWithSpecs().map((m) => [m.id, m]));
    let modelsSource = 'catalog';
    if (env.CF_PAGES && env.MODEL_API_KEY) {
      try {
        const live = await fetchProviderModels(env);
        if (live.length) {
          modelsSource = 'remote';
          for (const item of live) byId.set(item.id, item);
        }
      } catch {
        // Non-fatal: curated catalog stays ready.
      }
    }

    return {
      ok: true,
      auth: identity.via === 'dev-fallback' ? 'dev-fallback' : 'cloudflare-access',
      singleTenant: identity.via === 'dev-fallback',
      storage: 'd1',
      user: { email: identity.email, name: identity.name },
      model: defaultModel,
      modelReasoning: getModelReasoningSpec(defaultModel),
      modelsSource,
      models: [...byId.values()],
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
        modelPicker: true,
        realLogin: identity.via !== 'dev-fallback'
      }
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
