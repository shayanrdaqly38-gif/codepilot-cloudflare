// GET /api/config — non-secret runtime configuration for the UI.
// Never returns MODEL_API_KEY or any other secret.

import { route, methodNotAllowed } from '../_lib/api.js';
import { sandboxEnabled } from '../_lib/sandbox.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity }) => ({
    ok: true,
    auth: 'cloudflare-access',
    storage: 'd1',
    user: { email: identity.email, name: identity.name },
    model: String(env.MODEL_NAME || 'gpt-4o-mini'),
    contextBudgetTokens: Number(env.CONTEXT_BUDGET_TOKENS) || 24000,
    sandbox: sandboxEnabled(env),
    features: {
      memory: true,
      sync: true,
      streaming: true,
      workspaceSnapshots: true,
      patchEdits: true,
      search: true,
      validation: true,
      versionHistory: true,
      realShell: sandboxEnabled(env)
    }
  }));
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return methodNotAllowed('GET');
}
