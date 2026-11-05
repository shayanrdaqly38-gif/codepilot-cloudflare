// GET /api/models — returns available models & their genuine provider-reported
// capabilities (vision, tools, input/output limits, and exact reasoning_effort levels)
// from `https://tooken.club/v1/models`, merged with curated fallback metadata.

import { route, methodNotAllowed } from '../_lib/api.js';
import { catalogModelsWithSpecs, fetchProviderModels, parseProviderModelItem } from '../_lib/model.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ url }) => {
    const defaultModel = String(env.MODEL_NAME || 'claude-sonnet-5-5');
    const force = url.searchParams.get('refresh') === '1';
    const byId = new Map(catalogModelsWithSpecs().map((m) => [m.id, m]));

    let source = 'catalog';
    try {
      const liveList = await fetchProviderModels(env, { force });
      if (liveList.length) {
        source = 'remote';
        for (const item of liveList) {
          byId.set(item.id, item);
        }
      }
    } catch {
      // Provider may not expose GET /v1/models in offline/unit-test environments.
    }

    if (!byId.has(defaultModel)) {
      const parsedDefault = parseProviderModelItem({ id: defaultModel });
      if (parsedDefault) byId.set(defaultModel, parsedDefault);
    }

    return {
      ok: true,
      defaultModel,
      source,
      models: [...byId.values()]
    };
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
