// POST /api/run — execute a command from the interactive workspace terminal
// using the same authenticated, rate-limited Linux container / sandbox pipeline
// that the agent's `run_command` tool uses.

import { route, methodNotAllowed } from '../_lib/api.js';
import { enforceChatLimits } from '../_lib/limits.js';
import { runCommand } from '../_lib/sandbox.js';
import { safeWorkspace, getConversation, hydrateConversationWorkspace } from '../_lib/store.js';
import { fail } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      await enforceChatLimits(env, identity.owner);
      const command = typeof data?.command === 'string' ? data.command.trim() : '';
      if (!command) fail('دستور خالی است.', 400, 'empty_command');

      let workspace = { files: {} };
      if (data?.workspace && typeof data.workspace === 'object') {
        workspace = safeWorkspace(data.workspace);
      } else if (data?.conversationId) {
        const conv = await getConversation(env, identity.owner, String(data.conversationId));
        workspace = await hydrateConversationWorkspace(env, conv);
      }

      const result = await runCommand(env, { command, workspace });
      return {
        ok: result.ok,
        mode: result.mode,
        exitCode: result.exitCode ?? (result.ok ? 0 : 1),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        durationMs: result.durationMs ?? null,
        text: result.text
      };
    },
    { write: true, body: 1_900_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('POST');
}
