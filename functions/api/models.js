// GET /api/models — returns available models for the picker UI, combining any
// live `/v1/models` response from the provider with the curated catalog.

import { route, methodNotAllowed } from '../_lib/api.js';
import { MODEL_CATALOG, listModels } from '../_lib/model.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async () => {
    const defaultModel = String(env.MODEL_NAME || 'claude-sonnet-5-5');
    const byId = new Map(MODEL_CATALOG.map((item) => [item.id, { ...item }]));
    if (!byId.has(defaultModel)) {
      byId.set(defaultModel, { id: defaultModel, label: `${defaultModel} (تنظیم سرور)`, tier: 'custom' });
    }

    let source = 'catalog';
    try {
      const liveIds = await listModels(env);
      if (liveIds.length) {
        source = 'live';
        for (const id of liveIds) {
          if (!byId.has(id)) {
            byId.set(id, { id, label: id, tier: 'live' });
          }
        }
      }
    } catch {
      // Provider may not expose GET /v1/models; curated catalog still works.
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
