// POST /api/run — execute a command from the interactive workspace terminal
// using the same authenticated, rate-limited Linux container / sandbox pipeline
// that the agent's `run_command` tool uses.

import { route, methodNotAllowed } from '../_lib/api.js';
import { enforceChatLimits } from '../_lib/limits.js';
import { cleanCredentialInput, normalizeSandboxUrl, resolveEffectiveEnv } from '../_lib/provider.js';
import { probeCustomRunner, runCommand } from '../_lib/sandbox.js';
import {
  safeWorkspace,
  getConversation,
  hydrateConversationWorkspace,
  persistConversationWorkspace
} from '../_lib/store.js';
import { fail } from '../_lib/util.js';

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);

      if (data?.action === 'probe') {
        const overrideUrl = data?.url ? normalizeSandboxUrl(data.url) : '';
        const overrideToken =
          typeof data?.token === 'string'
            ? cleanCredentialInput(data.token).replace(/^bearer\s+/i, '').trim()
            : '';
        return probeCustomRunner(effectiveEnv, { overrideUrl, overrideToken });
      }

      await enforceChatLimits(env, identity.owner);
      const command = typeof data?.command === 'string' ? data.command.trim() : '';
      if (!command) fail('دستور خالی است.', 400, 'empty_command');

      let workspace = { files: {} };
      let conv = null;
      if (data?.workspace && typeof data.workspace === 'object') {
        workspace = safeWorkspace(data.workspace);
      } else if (data?.conversationId) {
        conv = await getConversation(env, identity.owner, String(data.conversationId));
        workspace = await hydrateConversationWorkspace(env, conv);
      }

      const result = await runCommand(effectiveEnv, { command, workspace });
      const touchedFiles = Array.isArray(result.touchedFiles) ? result.touchedFiles : [];
      const deletedFiles = Array.isArray(result.deletedFiles) ? result.deletedFiles : [];
      if (data?.conversationId && (touchedFiles.length > 0 || deletedFiles.length > 0)) {
        await persistConversationWorkspace(env, identity.owner, String(data.conversationId), workspace, {
          touched: touchedFiles,
          deleted: deletedFiles
        }).catch(() => {});
      }

      const changedFiles = {};
      for (const p of touchedFiles) {
        if (workspace.files[p] !== undefined) changedFiles[p] = workspace.files[p];
      }

      return {
        ok: result.ok,
        mode: result.mode,
        runner: result.runner || null,
        exitCode: result.exitCode ?? (result.ok ? 0 : 1),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        durationMs: result.durationMs ?? null,
        changedFiles: touchedFiles.length ? changedFiles : undefined,
        deletedFiles: deletedFiles.length ? deletedFiles : undefined,
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
