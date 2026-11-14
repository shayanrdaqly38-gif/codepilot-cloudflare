// GET  /api/state/versions?path=app.js&limit=20  → per-file version history with metadata
// GET  /api/state/versions?batchId=...           → all snapshots in a multi-file batch
// GET  /api/state/versions?batches=1             → recent multi-file/single-file edit batches
// POST /api/state/versions { action: "preview" | "restore", conversationId, path?, versionId?, batchId?, force?, expectedCurrentHash? }
//   → preview diff & conflict check, or perform safe (group or single-file) restore

import { route, methodNotAllowed } from '../../../_lib/api.js';
import { fail } from '../../../_lib/util.js';
import {
  conversationView,
  getConversation,
  hydrateConversationWorkspace,
  persistConversationWorkspace
} from '../../../_lib/store.js';
import {
  analyzeUndoConflict,
  deleteBatchVersions,
  getVersion,
  listBatchVersions,
  listRecentBatches,
  listVersions,
  recentPaths,
  recordVersion
} from '../../../_lib/versions.js';
import { diffStats, diffLines, truncateDiff, unifiedDiff } from '../../../_lib/patch.js';
import { validateFile } from '../../../_lib/validate.js';

export async function onRequestGet({ request, env }) {
  return route(request, env, async ({ identity, url }) => {
    const batchId = url.searchParams.get('batchId');
    if (batchId) {
      const items = await listBatchVersions(env, identity.owner, batchId);
      return {
        ok: true,
        batchId,
        versions: items.map((row) => ({
          id: row.id,
          path: row.path,
          reason: row.reason,
          createdBy: row.created_by,
          createdAt: row.created_at,
          size: String(row.content || '').length,
          conversationId: row.conversation_id,
          batchId: row.batch_id || '',
          contentHash: row.content_hash || '',
          afterHash: row.after_hash || '',
          existed: Boolean(row.existed),
          meta: row.metaObj || {}
        }))
      };
    }
    if (url.searchParams.get('batches') === '1') {
      const batches = await listRecentBatches(env, identity.owner, {
        conversationId: url.searchParams.get('conversationId') || '',
        limit: Number(url.searchParams.get('limit') || 20)
      });
      return { ok: true, batches };
    }
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
        conversationId: row.conversation_id,
        batchId: row.batch_id || '',
        contentHash: row.content_hash || '',
        afterHash: row.after_hash || '',
        existed: Boolean(row.existed),
        meta: row.metaObj || {}
      }))
    };
  });
}

function resolveExpectedHashForPath(expectedCurrentHash, path) {
  if (!expectedCurrentHash) return '';
  if (typeof expectedCurrentHash === 'string') return expectedCurrentHash;
  if (typeof expectedCurrentHash === 'object' && expectedCurrentHash[path]) {
    return String(expectedCurrentHash[path]);
  }
  return '';
}

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data }) => {
      const action = String(data?.action || '');
      if (action !== 'restore' && action !== 'preview') {
        fail('دستور ناشناخته است.', 400, 'unknown_action');
      }
      const conversation = await getConversation(env, identity.owner, String(data.conversationId || ''));
      const workspace = await hydrateConversationWorkspace(env, conversation);

      let targets = [];
      const batchId = typeof data?.batchId === 'string' ? data.batchId.trim() : '';
      if (batchId) {
        targets = await listBatchVersions(env, identity.owner, batchId);
      } else {
        const path = String(data.path || '');
        const version = await getVersion(env, identity.owner, String(data.versionId || ''));
        if (version.path !== path) fail('این نسخه متعلق به فایل دیگری است.', 400, 'bad_version');
        targets = [version];
      }

      const plan = targets.map((version) => {
        const p = version.path;
        const currentExists = workspace.files[p] !== undefined;
        const before = currentExists ? String(workspace.files[p] ?? '') : '';
        const analysis = analyzeUndoConflict(version, before, currentExists);
        const targetContent = analysis.targetExists ? String(version.content ?? '') : '';
        const diff = unifiedDiff(before, targetContent, { path: p });
        const stats = diffStats(diffLines(before, targetContent));
        return {
          version,
          path: p,
          before,
          currentExists,
          targetExists: analysis.targetExists,
          targetContent,
          analysis,
          diff: truncateDiff(diff, 400),
          added: stats.added,
          removed: stats.removed,
          validation: analysis.targetExists ? validateFile(p, targetContent) : { ok: true, errors: [], warnings: [] }
        };
      });

      const conflicts = plan
        .filter((item) => {
          if (!item.analysis.hasConflict) return false;
          const confirmedHash = resolveExpectedHashForPath(data?.expectedCurrentHash, item.path);
          return !(data?.force === true || (confirmedHash && confirmedHash === item.analysis.currentHash));
        })
        .map((item) => ({
          path: item.path,
          versionId: item.version.id,
          reason: item.analysis.conflictReason,
          currentHash: item.analysis.currentHash,
          expectedAfterHash: item.analysis.expectedAfterHash,
          targetHash: item.analysis.targetHash,
          diff: item.diff
        }));

      if (action === 'preview') {
        return {
          ok: true,
          preview: true,
          batchId: batchId || plan[0]?.version.batch_id || '',
          hasConflicts: conflicts.length > 0,
          conflicts,
          files: plan.map((item) => ({
            path: item.path,
            versionId: item.version.id,
            reason: item.version.reason,
            createdBy: item.version.created_by,
            createdAt: item.version.created_at,
            alreadyAtTarget: item.analysis.alreadyAtTarget,
            hasConflict: item.analysis.hasConflict,
            conflictReason: item.analysis.conflictReason,
            currentHash: item.analysis.currentHash,
            expectedAfterHash: item.analysis.expectedAfterHash,
            targetHash: item.analysis.targetHash,
            willDelete: !item.targetExists,
            added: item.added,
            removed: item.removed,
            diff: item.diff,
            validation: item.validation
          }))
        };
      }

      if (plan.every((item) => item.analysis.alreadyAtTarget)) {
        fail('فایل همین حالا در همین نسخه است.', 409, 'no_change');
      }

      if (conflicts.length > 0) {
        fail(
          'تعارض در بازگردانی: یک یا چند فایل پس از این نسخه دوباره تغییر کرده‌اند. ابتدا پیش‌نمایش (preview) را بررسی کنید و سپس با force: true یا expectedCurrentHash تأیید کنید.',
          409,
          'undo_conflict',
          { conflicts }
        );
      }

      // Transactional restore with rollback on failure
      const rollbackFiles = {};
      const rollbackActive = workspace.active;
      const undoBatchId = crypto.randomUUID();
      const touched = [];
      const deleted = [];
      try {
        for (const item of plan) {
          if (item.analysis.alreadyAtTarget) continue;
          rollbackFiles[item.path] = workspace.files[item.path];
          await recordVersion(env, identity.owner, conversation, {
            path: item.path,
            content: item.before,
            existed: item.currentExists,
            afterContent: item.targetExists ? item.targetContent : null,
            reason: 'before-restore',
            batchId: undoBatchId
          });
          if (item.targetExists) {
            workspace.files[item.path] = item.targetContent;
            workspace.active = item.path;
            touched.push(item.path);
          } else {
            delete workspace.files[item.path];
            if (workspace.active === item.path) {
              workspace.active = Object.keys(workspace.files)[0] || '';
            }
            deleted.push(item.path);
          }
        }
        await persistConversationWorkspace(env, identity.owner, conversation.id, workspace, {
          bumpRevision: true,
          touched,
          deleted
        });
      } catch (err) {
        for (const [p, prev] of Object.entries(rollbackFiles)) {
          if (prev === undefined) delete workspace.files[p];
          else workspace.files[p] = prev;
        }
        workspace.active = rollbackActive;
        await deleteBatchVersions(env, identity.owner, undoBatchId);
        throw err;
      }

      const latest = await getConversation(env, identity.owner, conversation.id);
      const first = plan[0];
      return {
        ok: true,
        path: first.path,
        batchId: batchId || first.version.batch_id || '',
        undoBatchId,
        workspace,
        added: plan.reduce((s, x) => s + x.added, 0),
        removed: plan.reduce((s, x) => s + x.removed, 0),
        diff: first.diff,
        files: plan.map((item) => ({
          path: item.path,
          versionId: item.version.id,
          deleted: !item.targetExists,
          added: item.added,
          removed: item.removed,
          diff: item.diff,
          validation: item.validation
        })),
        validation: first.validation,
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
