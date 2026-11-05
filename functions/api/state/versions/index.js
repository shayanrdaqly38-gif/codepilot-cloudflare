// GET /api/state/versions?path=app.js&limit=20
//   → version history for one file (no content, just metadata)
// POST /api/state/versions { action: "restore", conversationId, path, versionId }
//   → restore a file from history inside a conversation's workspace
//
// The diff of a restored file is returned so the UI can commit/refresh.

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { fail } from '../../../_lib/util.js';
import { conversationView, getConversation, safeWorkspace } from '../../../_lib/store.js';
import { getVersion, listVersions, recentPaths, recordVersion } from '../../../_lib/versions.js';
import { diffStats, diffLines, truncateDiff, unifiedDiff } from '../../../_lib/patch.js';
import { validateFile } from '../../../_lib/validate.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const path = url.searchParams.get('path');
    if (!path) {
      const recent = await recentPaths(env, identity.owner, { limit: Number(url.searchParams.get('limit') || 30) });
      return {
        ok: true,
        files: recent.map((row) => ({
          path: row.path,
          project: row.project,
          versions: row.versions,
          lastAt: row.last_at
        }))
      };
    }
    const versions = await listVersions(env, identity.owner, path, {
      project: url.searchParams.has('project') ? url.searchParams.get('project') : null,
      limit: Number(url.searchParams.get('limit') || 30)
    });
    return {
      ok: true,
      path,
      versions: versions.map((row) => ({
        id: row.id,
        reason: row.reason,
        createdBy: row.created_by,
        createdAt: row.created_at,
        size: row.size,
        conversationId: row.conversation_id
      }))
    };
  });
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      if (String(data?.action || '') !== 'restore') fail('دستور ناشناخته است.', 400, 'unknown_action');
      const conversation = await getConversation(env, identity.owner, String(data.conversationId || ''));
      const path = String(data.path || '');
      const version = await getVersion(env, identity.owner, String(data.versionId || ''));
      if (version.path !== path) fail('این نسخه متعلق به فایل دیگری است.', 400, 'bad_version');

      const workspace = safeWorkspace(JSON.parse(conversation.workspace || '{}'));
      const before = String(workspace.files[path] ?? '');
      if (before === version.content) fail('فایل همین حالا در همین نسخه است.', 409, 'no_change');

      await recordVersion(env, identity.owner, conversation, { path, content: before, reason: 'before-restore' });
      workspace.files[path] = version.content;
      workspace.active = path;

      await env.DB.prepare('UPDATE conversations SET workspace=?, updated_at=?, revision=revision+1 WHERE id=? AND owner=?')
        .bind(JSON.stringify(workspace), Date.now(), conversation.id, identity.owner)
        .run();

      const diff = unifiedDiff(before, version.content, { path });
      const stats = diffStats(diffLines(before, version.content));
      const latest = await getConversation(env, identity.owner, conversation.id);
      return {
        ok: true,
        path,
        workspace,
        added: stats.added,
        removed: stats.removed,
        diff: truncateDiff(diff, 400),
        validation: validateFile(path, version.content),
        conversation: conversationView(latest)
      };
    },
    { write: true, body: 64_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST');
}
