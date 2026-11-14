// POST /api/run — execute a command or manage an async runner job from the
// interactive workspace terminal using the same authenticated, rate-limited
// pipeline that the agent's `run_command` tool uses.

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
      const action = String(data?.action || 'run').trim().toLowerCase();

      if (action === 'probe') {
        const overrideUrl = data?.url ? normalizeSandboxUrl(data.url) : '';
        const overrideToken =
          typeof data?.token === 'string'
            ? cleanCredentialInput(data.token).replace(/^bearer\s+/i, '').trim()
            : '';
        return probeCustomRunner(effectiveEnv, { overrideUrl, overrideToken });
      }

      await enforceChatLimits(env, identity.owner);
      const command = typeof data?.command === 'string' ? data.command.trim() : '';
      const needsCommand = action === 'run' || action === 'start';
      if (needsCommand && !command) fail('دستور خالی است.', 400, 'empty_command');

      let workspace = { files: {} };
      let conv = null;
      if (data?.workspace && typeof data.workspace === 'object') {
        workspace = safeWorkspace(data.workspace);
      } else if (data?.conversationId) {
        conv = await getConversation(env, identity.owner, String(data.conversationId));
        workspace = await hydrateConversationWorkspace(env, conv);
      }

      const result = await runCommand(effectiveEnv, {
        command,
        action,
        jobId: typeof data?.jobId === 'string' ? data.jobId : '',
        cwd: typeof data?.cwd === 'string' ? data.cwd : '',
        timeoutMs: data?.timeoutMs,
        waitMs: data?.waitMs,
        async: Boolean(data?.async),
        stream: typeof data?.stream === 'string' ? data.stream : 'combined',
        offset: data?.offset,
        limit: data?.limit,
        workspace,
        conversationId: data?.conversationId
      });

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
        jobId: result.jobId || null,
        status: result.status || null,
        running: Boolean(result.running),
        promoted: Boolean(result.promoted),
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.cancelled),
        unsupported: Boolean(result.unsupported),
        exitCode: result.exitCode ?? (result.running ? null : result.ok ? 0 : 1),
        signal: result.signal || null,
        error: result.error || null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        output: result.output,
        stream: result.stream,
        offset: result.offset,
        nextOffset: result.nextOffset,
        hasMore: Boolean(result.hasMore),
        truncated: Boolean(result.truncated),
        stdoutTruncated: Boolean(result.stdoutTruncated),
        stderrTruncated: Boolean(result.stderrTruncated),
        totalStdoutChars: result.totalStdoutChars,
        totalStderrChars: result.totalStderrChars,
        durationMs: result.durationMs ?? null,
        persistence: result.persistence || null,
        jobs: result.jobs,
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
