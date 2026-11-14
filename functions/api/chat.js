// POST /api/chat — one autonomous agent turn, durably stored in D1.
//
// Flow:
//   1. Auth (Cloudflare Access → signed session cookie) + same-origin check + limits.
//   2. Persist the incoming user message BEFORE the model, so a failed or
//      interrupted turn is never lost and `seq` stays ordered.
//   3. Rebuild context from D1: rolling summary + recent window + long-term memory.
//   4. Run the model loop. Tools execute server-side:
//        think, list_files, read_file, search_code, list_symbols,
//        write_file, apply_patch, delete_file, undo_edit, file_history,
//        run_command (real Linux container / sandbox / virtual),
//        web_search (live multi-source internet search),
//        fetch_url (live HTTP/API client with SSRF protection)
//      Every edit is validated, diffed, snapshotted and reported back.
//   5. Persist the whole assistant/tool group before streaming `done`.

import { route } from '../_lib/api.js';
import {
  buildCheckpointResumeDirective,
  clearTurnCheckpoint,
  extractPartialToolTarget,
  isResumePrompt,
  loadTurnCheckpoint,
  saveTurnCheckpoint
} from '../_lib/checkpoint.js';
import {
  DEFAULT_AGENT_CONFIG,
  isTookenUrl,
  normalizeAgentConfig,
  resolveEffectiveEnv,
  resolvePowerExecutionPlan
} from '../_lib/provider.js';
import { resolveUploadRefs, hydrateUploadParts } from '../_lib/uploads.js';
import {
  callModel,
  fetchProviderModels,
  getModelReasoningSpec,
  normalizeReasoningEffort,
  sanitizeModelId,
  sanitizeTools
} from '../_lib/model.js';
import {
  buildSystemPrompt,
  buildWorkingContext,
  compactToolResult,
  repairToolGroups,
  slimHistoricalToolPayloads,
  toWire
} from '../_lib/memory.js';
import {
  appendMessages,
  conversationView,
  deriveTitle,
  getConversation,
  hydrateConversationWorkspace,
  isSafePath,
  listMemories,
  listMessages,
  loadWorkspaceFile,
  messageStats,
  normalizeWorkspaceMode,
  persistConversationWorkspace,
  recordUsage,
  safeWorkspace,
  workspaceLimits
} from '../_lib/store.js';
import { registerActiveTurn } from '../_lib/turn-registry.js';
import {
  admitTurnRequest,
  heartbeatTurn,
  startTurnHeartbeat,
  releaseTurn
} from '../_lib/active-turn.js';
import { clearTurnCheckpointForTurn } from '../_lib/checkpoint.js';
import { BUILD_VERSION } from '../_lib/build.js';
import { envSecrets, fail, json, redactSecrets, sha256Hex, stripSecrets } from '../_lib/util.js';
import { enforceChatLimits } from '../_lib/limits.js';
import { applyEdits, diffSummary, unifiedDiff } from '../_lib/patch.js';
import { formatSearchHits, formatSymbols, listSymbols, searchWorkspace } from '../_lib/search.js';
import { validateFile } from '../_lib/validate.js';
import {
  applyRunnerFileChanges,
  classifyCommand,
  formatRealResult,
  linuxRunnerEnabled,
  runCommand,
  sandboxEnabled
} from '../_lib/sandbox.js';
import { getVersion, listVersions, recordVersion } from '../_lib/versions.js';
import { fetchExternalUrl, searchWeb } from '../_lib/web.js';
import { generateAndStoreImage } from '../_lib/image.js';
import {
  buildPatchFailureContext,
  buildRequestSaverWorkspacePack,
  buildSmartFileRead,
  extractMentionedFileContext,
  isCacheDiscountedEndpoint,
  isRpdLimitedTurn,
  pruneInTurnWireMessages,
  resolveAdaptiveStepEffort,
  VALID_TOKEN_SAVER_MODES
} from '../_lib/token-optimizer.js';

import { MAX_MESSAGE_CHARS } from '../_lib/limits.js';

const MAX_CONTENT = MAX_MESSAGE_CHARS;
const MAX_FILE_CHARS = 900_000;
const MAX_TOOL_LOOPS_PER_FILE = 12;
// Normal ("arena") mode: bigger single writes are fine because storage is
// chunked; editing files larger than this in place would risk isolate memory.
const NORMAL_MAX_FILE_CHARS = 32_000_000;
const NORMAL_MAX_EDITABLE_BYTES = 24_000_000;
const NORMAL_READ_SLICE_BYTES = 2_000_000;
const utf8Encoder = new TextEncoder();
const utf8Bytes = (s) => utf8Encoder.encode(String(s ?? '')).byteLength;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'think',
      description: 'Scratchpad before complex architecture (skip if native reasoning active).',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string' },
          plan: { type: 'string' }
        },
        required: ['thought'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List workspace paths & sizes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file (`startLine`/`endLine` or `query` jump for large files).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
          query: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search files (`regex: true` optional).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          regex: { type: 'boolean' },
          caseSensitive: { type: 'boolean' },
          pathFilter: { type: 'string' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_symbols',
      description: 'List functions, classes, CSS/HTML symbols.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Patch existing file with unique `search`/`replace` blocks.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string' },
                replace: { type: 'string' },
                replaceAll: { type: 'boolean' }
              },
              required: ['search', 'replace'],
              additionalProperties: false
            }
          }
        },
        required: ['path', 'edits'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create new file or full rewrite.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete file (versioned).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undo_edit',
      description: 'Restore previous file version.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          versionId: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_history',
      description: 'List file versions.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run shell command in workspace.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search live web.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch public URL or REST API.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' },
          maxChars: { type: 'number' }
        },
        required: ['url'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate image (50–90w English `prompt` + Persian `title`).',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          title: { type: 'string' },
          aspectRatio: {
            type: 'string',
            enum: ['1:1', '16:9', '9:16', '4:3', '3:4']
          },
          style: {
            type: 'string',
            enum: [
              'auto',
              'photorealistic',
              'cinematic',
              'digital-art',
              'logo-icon',
              'ui-mockup',
              '3d-render',
              'anime',
              'pixel-art'
            ]
          },
          seed: { type: 'number' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    }
  }
];

/* ------------------------------- streaming -------------------------------- */

function sseStream() {
  const encoder = new TextEncoder();
  let controller;
  let closed = false;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
    }
  });
  // Keep Cloudflare Edge, VPN/proxy tunnels, and mobile NATs alive during deep reasoning & large tool writes:
  const heartbeat = setInterval(() => {
    if (closed || !controller) {
      clearInterval(heartbeat);
      return;
    }
    try {
      controller.enqueue(encoder.encode(': keepalive\n\n'));
    } catch {
      closed = true;
      clearInterval(heartbeat);
    }
  }, 5000);
  if (typeof heartbeat?.unref === 'function') heartbeat.unref();

  const send = (event, data) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      closed = true;
      clearInterval(heartbeat);
    }
  };
  const close = () => {
    closed = true;
    clearInterval(heartbeat);
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  };
  return { stream, send, close };
}

/* ------------------------------ path helpers ------------------------------ */

const SAFE_PATH = /^[\w./[\]-]{1,200}$/;

function assertSafePath(path) {
  const value = String(path || '');
  if (!SAFE_PATH.test(value) || !isSafePath(value)) {
    fail('مسیر فایل نامعتبر یا ناامن است.', 400, 'bad_path');
  }
  return value;
}

function fileIndex(workspace) {
  return Object.keys(workspace.files || {}).sort();
}

/** Load a lazy (not-yet-hydrated) workspace file into memory on demand.
 *  `slice` caps how many bytes may be pulled for bounded reads. Returns
 *  { content, truncated, bytes } or null when the file cannot be loaded. */
async function ensureFileLoaded(env, conversation, workspace, path, { slice = 0, forEdit = false } = {}) {
  if (workspace.files?.[path] !== null) return { content: workspace.files?.[path] };
  const lazyBytes = Number(workspace.lazy?.[path] || 0);
  if (forEdit && lazyBytes > NORMAL_MAX_EDITABLE_BYTES) {
    return {
      tooLargeToEdit: true,
      bytes: lazyBytes
    };
  }
  const loaded = await loadWorkspaceFile(env, conversation, path, { maxBytes: slice > 0 ? slice : 0 }).catch(() => null);
  if (!loaded) return { loadFailed: true };
  if (slice > 0 && loaded.bytes > slice) {
    // Keep the placeholder lazy; give the caller a bounded slice only.
    return { content: loaded.content, truncated: true, bytes: loaded.bytes };
  }
  workspace.files[path] = loaded.content;
  if (workspace.lazy) delete workspace.lazy[path];
  return { content: loaded.content, bytes: loaded.bytes };
}

/** Files actually present in memory as strings (lazy nulls excluded). */
function loadedFilesMap(workspace) {
  if (!workspace.lazy || !Object.keys(workspace.lazy).length) return workspace.files || {};
  const out = {};
  for (const [p, v] of Object.entries(workspace.files || {})) {
    if (typeof v === 'string') out[p] = v;
  }
  return out;
}

function computeTurnDiff(before, after, path) {
  const diff = unifiedDiff(before, after, { path });
  const stats = diff ? diffSummary(diff.split('\n')) : { added: 0, removed: 0 };
  return { diff, stats };
}

function estimateMessagesTextChars(messages) {
  let total = 0;
  for (const m of messages) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      total += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part) continue;
        if (typeof part.text === 'string') total += part.text.length;
        else total += 1200; // image_url / multimodal block token overhead without counting raw Base64
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += (tc?.function?.name?.length || 0) + (tc?.function?.arguments?.length || 0) + 32;
      }
    }
  }
  return total;
}

/* --------------------------------- tools ---------------------------------- */

/**
 * Execute one tool call. Mutates `workspace` and fills `turn` with everything the
 * UI needs (edits, deletions, validation, diffs, thinking).
 * `signal` (when provided) is the turn-level abort signal: it is forwarded to
 * external tools (web_search / fetch_url / run_command) so a user stop cancels
 * in-flight tool work immediately instead of waiting for a network timeout.
 */
async function executeTool({ env, effectiveEnv, owner, conversation, name, args, workspace, turn, send, signal }) {
  if (!args || typeof args !== 'object') return { text: 'Error: invalid arguments', ok: false };

  switch (name) {
    case 'think': {
      const thought = String(args.thought || '').trim();
      const plan = String(args.plan || '').trim();
      const maxThoughtChars = turn?.thinkToolLimit || 6000;
      if (thought && send) {
        send('thinking', {
          thought: redactSecrets(thought, envSecrets(env)).slice(0, maxThoughtChars),
          plan: plan ? redactSecrets(plan, envSecrets(env)).slice(0, Math.round(maxThoughtChars / 2)) : ''
        });
      }
      return {
        ok: true,
        text: plan ? `Thought recorded. Plan:\n${plan.slice(0, 2500)}` : 'Thought recorded. Proceed with execution.'
      };
    }

    case 'list_files': {
      const files = workspace.files || {};
      const lazy = workspace.lazy || {};
      const lines = Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) =>
          lazy[path]
            ? `${path} (${Math.round(lazy[path] / 1000)}KB on disk — use read_file to load)`
            : `${path} (${String(content).length} chars)`
        );
      return {
        ok: true,
        text: lines.length ? lines.join('\n') : '(empty workspace)'
      };
    }

    case 'read_file': {
      const path = String(args.path || '');
      if (workspace.files?.[path] === undefined) {
        const available = fileIndex(workspace).slice(0, 50).join(', ');
        return { ok: false, text: `Error: file not found: ${path}. Available: ${available || '(none)'}` };
      }
      if (workspace.files[path] === null) {
        // Lazy large file: pull a bounded slice from D1 instead of the whole thing.
        const loaded = await ensureFileLoaded(env, conversation, workspace, path, { slice: NORMAL_READ_SLICE_BYTES });
        if (loaded.loadFailed) {
          return { ok: false, text: `Error: could not load ${path} from storage.` };
        }
        if (loaded.tooLargeToEdit) {
          return {
            ok: false,
            text: `Error: ${path} is ${Math.round(loaded.bytes / 1_000_000)}MB — too large to read at once. Read it in parts with run_command (head/tail/grep) or recreate it in smaller pieces.`
          };
        }
        const smart = buildSmartFileRead(path, String(loaded.content || ''), {
          startLine: args.startLine,
          endLine: args.endLine,
          query: args.query,
          tokenSaver: turn.tokenSaver || 'max'
        });
        if (smart.savedChars > 0) {
          turn.savedChars = (turn.savedChars || 0) + smart.savedChars;
        }
        return {
          ok: true,
          text: loaded.truncated
            ? `${smart.text}\n\n[TRUNCATED: showing the first ${Math.round(NORMAL_READ_SLICE_BYTES / 1000)}KB of a ${Math.round(loaded.bytes / 1000)}KB file — ask for specific sections with run_command/grep.]`
            : smart.text
        };
      }
      const smart = buildSmartFileRead(path, String(workspace.files[path]), {
        startLine: args.startLine,
        endLine: args.endLine,
        query: args.query,
        tokenSaver: turn.tokenSaver || 'max'
      });
      if (smart.savedChars > 0) {
        turn.savedChars = (turn.savedChars || 0) + smart.savedChars;
      }
      return { ok: true, text: smart.text };
    }

    case 'search_code': {
      const result = searchWorkspace(loadedFilesMap(workspace), args.query, {
        regex: Boolean(args.regex),
        caseSensitive: Boolean(args.caseSensitive),
        pathFilter: String(args.pathFilter || '')
      });
      const lazyCount = Object.keys(workspace.lazy || {}).length;
      const lazyNote = lazyCount
        ? `\n(${lazyCount} very large file(s) were skipped by search — use read_file on them directly.)`
        : '';
      return { ok: true, text: formatSearchHits(result) + lazyNote };
    }

    case 'list_symbols': {
      const symbols = listSymbols(loadedFilesMap(workspace), { query: String(args.query || '') });
      return { ok: true, text: formatSymbols(symbols) };
    }

    case 'apply_patch': {
      const path = assertSafePath(args.path);
      if (workspace.files[path] === undefined) {
        return { ok: false, text: `Error: file not found: ${path}. Use write_file to create it.` };
      }
      if (workspace.files[path] === null) {
        const loaded = await ensureFileLoaded(env, conversation, workspace, path, { forEdit: true });
        if (loaded.loadFailed) return { ok: false, text: `Error: could not load ${path} from storage.` };
        if (loaded.tooLargeToEdit) {
          return {
            ok: false,
            text: `Error: ${path} is ${Math.round(loaded.bytes / 1_000_000)}MB — too large to patch in place. Recreate it via write_file in smaller pieces or edit it with run_command.`
          };
        }
      }
      const before = String(workspace.files[path]);
      let applied;
      try {
        applied = applyEdits(before, args.edits);
      } catch (error) {
        if ((turn.tokenSaver || 'max') !== 'off') {
          turn.savedChars = (turn.savedChars || 0) + 3200;
          return {
            ok: false,
            text: buildPatchFailureContext(path, before, args.edits, error.message)
          };
        }
        return { ok: false, text: `Patch rejected: ${error.message}` };
      }
      if (applied.content === before) {
        return { ok: false, text: 'Patch rejected: the replacement text is identical to the original.' };
      }
      const previousVersionId = await recordVersion(env, owner, conversation, {
        path,
        content: before,
        reason: 'before-patch'
      });
      workspace.files[path] = applied.content;
      workspace.active = path;
      turn.deleted.delete(path);

      const { diff, stats } = computeTurnDiff(before, applied.content, path);
      const validation = validateFile(path, applied.content);
      turn.diffs.push({ path, diff, added: stats.added, removed: stats.removed });
      turn.validation.push({ path, ...validation });
      turn.touched.add(path);
      turn.editCount += 1;
      if (turn.editCount > (turn.maxFileEdits || MAX_TOOL_LOOPS_PER_FILE * 6)) {
        return { ok: false, text: 'Too many edits in one turn. Stop and summarize what you changed.' };
      }

      const strategy = applied.results.map((r) => r.strategy).join(',');
      return {
        ok: true,
        text: [
          `Patched ${path} (${applied.results.length} block(s), match: ${strategy}).`,
          `+${stats.added} −${stats.removed} lines.`,
          validation.ok ? 'Validation: OK.' : `Validation: ${validation.errors.join(' | ')}`,
          `Previous version saved as ${previousVersionId} (undo_edit can restore it).`
        ].join(' ')
      };
    }

    case 'write_file': {
      const path = assertSafePath(args.path);
      const content = String(args.content ?? '');
      const convMode = normalizeWorkspaceMode(conversation?.mode);
      const maxChars = convMode === 'normal' ? NORMAL_MAX_FILE_CHARS : MAX_FILE_CHARS;
      if (content.length > maxChars) {
        return {
          ok: false,
          text:
            convMode === 'normal'
              ? `Error: file too large (max ${Math.round(NORMAL_MAX_FILE_CHARS / 1_000_000)}M chars per write in this workspace).`
              : 'Error: file too large (max 900k chars).'
        };
      }
      const existed = workspace.files[path] !== undefined;
      if (workspace.files[path] === null) {
        const loaded = await ensureFileLoaded(env, conversation, workspace, path, { forEdit: true });
        if (loaded.loadFailed) return { ok: false, text: `Error: could not load ${path} from storage.` };
        if (loaded.tooLargeToEdit) {
          return {
            ok: false,
            text: `Error: ${path} is ${Math.round(loaded.bytes / 1_000_000)}MB — rewriting it wholesale is disabled to protect memory. Delete it first, then write the new content in parts.`
          };
        }
      }
      const before = existed ? String(workspace.files[path]) : '';
      if (existed && before === content) return { ok: false, text: 'No change: content is identical.' };
      if (convMode === 'normal') {
        // Real 1GB workspace ceiling, checked BEFORE the write lands.
        const limits = workspaceLimits(env).normal;
        const projected =
          (workspace.totalBytes || 0) - (existed ? utf8Bytes(before) : 0) + utf8Bytes(content);
        if (projected > limits.maxTotalBytes) {
          return {
            ok: false,
            text: `Error: this write would push the workspace past its ${Math.round(limits.maxTotalBytes / 1_000_000_000)}GB cap (projected ${Math.round(projected / 1_000_000)}MB). Delete or shrink other files first.`
          };
        }
        workspace.totalBytes = projected;
      }
      await recordVersion(env, owner, conversation, {
        path,
        content: before,
        reason: existed ? 'before-write' : 'created'
      });
      workspace.files[path] = content;
      workspace.active = path;
      turn.deleted.delete(path);

      const { diff, stats } = computeTurnDiff(before, content, path);
      const validation = validateFile(path, content);
      turn.diffs.push({ path, diff, added: stats.added, removed: stats.removed });
      turn.validation.push({ path, ...validation });
      turn.touched.add(path);
      turn.editCount += 1;

      return {
        ok: true,
        text: [
          `${existed ? 'Rewrote' : 'Created'} ${path} (${content.length} chars, +${stats.added} −${stats.removed}).`,
          validation.ok ? 'Validation: OK.' : `Validation: ${validation.errors.join(' | ')}`
        ].join(' ')
      };
    }

    case 'delete_file': {
      const path = assertSafePath(args.path);
      if (workspace.files[path] === undefined) {
        return { ok: false, text: `Error: file not found: ${path}.` };
      }
      if (workspace.files[path] === null) {
        const loaded = await ensureFileLoaded(env, conversation, workspace, path, { forEdit: true });
        if (loaded.loadFailed) return { ok: false, text: `Error: could not load ${path} from storage.` };
        if (loaded.tooLargeToEdit) {
          // Huge file: freeing it is the whole point — but a >900KB snapshot
          // cannot be versioned in one D1 row, so undo is simply unavailable.
          delete workspace.files[path];
          if (workspace.lazy) delete workspace.lazy[path];
          if (workspace.active === path) {
            workspace.active = Object.keys(workspace.files)[0] || '';
          }
          turn.diffs.push({ path, diff: `--- a/${path}\n+++ /dev/null`, added: 0, removed: 0 });
          turn.deleted.add(path);
          turn.touched.delete(path);
          turn.workspaceChanged = true;
          turn.editCount += 1;
          return {
            ok: true,
            text: `Deleted ${path} (large file, ~${Math.round(loaded.bytes / 1_000_000)}MB freed). Note: undo is not available for files this large.`
          };
        }
      }
      const before = String(workspace.files[path]);
      const versionId = await recordVersion(env, owner, conversation, {
        path,
        content: before,
        reason: 'before-delete'
      });
      delete workspace.files[path];
      if (workspace.active === path) {
        workspace.active = Object.keys(workspace.files)[0] || '';
      }
      if (normalizeWorkspaceMode(conversation?.mode) === 'normal') {
        workspace.totalBytes = Math.max(0, (workspace.totalBytes || 0) - utf8Bytes(before));
      }
      const { diff, stats } = computeTurnDiff(before, '', path);
      turn.diffs.push({ path, diff, added: stats.added, removed: stats.removed });
      turn.deleted.add(path);
      turn.touched.delete(path);
      turn.workspaceChanged = true;
      turn.editCount += 1;
      return {
        ok: true,
        text: `Deleted ${path} (−${stats.removed} lines). Snapshot saved as ${versionId} (undo_edit can restore it).`
      };
    }

    case 'undo_edit': {
      const path = assertSafePath(args.path);
      let target = null;
      if (args.versionId) {
        const version = await getVersion(env, owner, String(args.versionId));
        if (version.path !== path) return { ok: false, text: 'Error: that version belongs to another file.' };
        target = version;
      } else {
        const versions = await listVersions(env, owner, path, { project: null, limit: 1 });
        target = versions[0] ? await getVersion(env, owner, versions[0].id) : null;
      }
      if (!target) return { ok: false, text: `No saved version for ${path}.` };

      const lazyCurrent = workspace.files[path] === null;
      const current = lazyCurrent ? '' : String(workspace.files[path] ?? '');
      if (workspace.files[path] !== undefined && !lazyCurrent && target.content === current) {
        return { ok: false, text: 'Already at that version.' };
      }
      if (!lazyCurrent) {
        await recordVersion(env, owner, conversation, { path, content: current, reason: 'before-undo' });
      }
      workspace.files[path] = target.content;
      workspace.active = path;
      turn.deleted.delete(path);

      const { diff, stats } = computeTurnDiff(current, target.content, path);
      const validation = validateFile(path, target.content);
      turn.diffs.push({ path, diff, added: stats.added, removed: stats.removed });
      turn.validation.push({ path, ...validation });
      turn.touched.add(path);
      return {
        ok: true,
        text: `Restored ${path} to version ${target.id} (${new Date(target.created_at).toISOString()}). +${stats.added} −${stats.removed}.`
      };
    }

    case 'file_history': {
      const path = assertSafePath(args.path);
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const rows = await listVersions(env, owner, path, { project: null, limit });
      if (!rows.length) {
        return {
          ok: false,
          text: `No history for ${path}. ${
            workspace.files[path] === undefined ? 'That file does not exist in the workspace.' : 'It has never been edited.'
          }`
        };
      }
      const lines = rows.map((row, index) => {
        const when = new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19);
        const size = row.size === undefined ? '?' : `${row.size} chars`;
        return `${index + 1}. ${row.id} · ${when}Z · ${row.reason} · ${row.created_by} · ${size}`;
      });
      return {
        ok: true,
        text: `History for ${path} (newest first):\n${lines.join('\n')}\nUse undo_edit with a versionId to restore one.`
      };
    }

    case 'run_command': {
      const result = await runCommand(effectiveEnv || env, {
        command: String(args.command || ''),
        workspace,
        externalSignal: signal,
        conversationId: conversation.id
      });
      turn.commands.push({ command: String(args.command || ''), mode: result.mode, ok: result.ok });
      if (result.mode === 'virtual' && result.ok) turn.touched.add('(shell)');
      if (Array.isArray(result.touchedFiles)) {
        for (const p of result.touchedFiles) {
          turn.touched.add(p);
          turn.workspaceChanged = true;
          send('live_file', {
            path: p,
            deleted: false,
            content: String(workspace.files[p] || ''),
            step: 0,
            editCount: turn.editCount
          });
        }
      }
      if (Array.isArray(result.deletedFiles)) {
        for (const p of result.deletedFiles) {
          turn.deleted.add(p);
          turn.workspaceChanged = true;
          send('live_file', { path: p, deleted: true, content: '', step: 0, editCount: turn.editCount });
        }
      }
      return { ok: result.ok, text: result.text };
    }

    case 'web_search': {
      return searchWeb(env, { query: String(args.query || ''), limit: args.limit, externalSignal: signal });
    }

    case 'fetch_url': {
      return fetchExternalUrl(env, {
        url: String(args.url || ''),
        method: args.method,
        headers: args.headers,
        body: args.body,
        maxChars: args.maxChars,
        externalSignal: signal
      });
    }

    case 'generate_image': {
      const image = await generateAndStoreImage(effectiveEnv || env, owner, {
        prompt: String(args.prompt || ''),
        title: String(args.title || ''),
        aspectRatio: String(args.aspectRatio || '1:1'),
        style: String(args.style || 'auto'),
        seed: Number.isInteger(args.seed) ? args.seed : undefined,
        conversationId: conversation?.id || '',
        externalSignal: signal
      });
      if (Array.isArray(turn?.generatedImages)) {
        turn.generatedImages.push(image);
      }
      if (send) {
        send('generated_image', image);
      }
      const cleanAlt = (image.title || 'Generated Image').replace(/[\[\]\r\n]/g, ' ').trim();
      return {
        ok: true,
        text:
          `Image generated successfully!\n` +
          `- URL: ${image.url}\n` +
          `- Download URL: ${image.downloadUrl}\n` +
          `- Resolution: ${image.width}x${image.height} (${image.aspectRatio})\n` +
          `- Engine: ${image.modelLabel || image.engine}\n` +
          `- Markdown to include in your reply: ![${cleanAlt}](${image.url})`
      };
    }

    default:
      return { ok: false, text: `Error: unknown tool ${name}` };
  }
}

/* -------------------------------- handler -------------------------------- */

export async function onRequestPost(context) {
  const { request, env } = context;
  const waitUntilFn = typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : null;
  return route(
    request,
    env,
    async ({ identity, data, setCookie, waitUntil }) => {
      const conversationId = String(data?.conversationId || '');
      const rawText = typeof data?.message === 'string' ? data.message.trim() : '';
      const hasAttachmentRefs = Array.isArray(data?.attachments) && data.attachments.length > 0;
      if (!rawText && !hasAttachmentRefs) fail('متن پیام خالی است.', 400, 'empty_message');
      if (rawText.length > MAX_CONTENT) fail('پیام بیش از حد طولانی است.', 413, 'too_large');
      const conversation = await getConversation(env, identity.owner, conversationId);
      const clientRequestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
      if (clientRequestId && !/^[A-Za-z0-9_-]{8,80}$/.test(clientRequestId)) fail('شناسه درخواست معتبر نیست.', 400, 'bad_request_id');
      const requestId = clientRequestId || `srv-${crypto.randomUUID()}`;
      // Fingerprint the semantic payload, not multi-MB attachment bytes. A
      // reused request id with different text/model/attachments is a conflict.
      const payloadHash = await sha256Hex(JSON.stringify({
        conversationId: conversation.id,
        message: rawText,
        attachments: (Array.isArray(data?.attachments) ? data.attachments : []).map((a) => ({
          id: a?.id || a?.uploadId || '', name: a?.name || '', type: a?.type || '', size: a?.size || 0
        })),
        model: data?.model || '',
        reasoningEffort: data?.reasoningEffort || '',
        thinking: data?.thinking,
        agentMode: data?.agentMode || '',
        networkAccess: data?.networkAccess,
        shellAccess: data?.shellAccess,
        tokenSaver: data?.tokenSaver || '',
        localRunner: data?.localRunner,
        resumeCheckpoint: data?.resumeCheckpoint === true,
        silentAutoResume: data?.silentAutoResume === true,
        resumeTurnId: data?.resumeTurnId || '',
        localExecResults: Array.isArray(data?.localExecResults) ? data.localExecResults.map((r) => r?.callId || '') : []
      }));
      const admission = await admitTurnRequest(env, identity.owner, conversation.id, { requestId, payloadHash });
      if (admission.status === 'conflict') fail('این شناسه درخواست قبلاً برای محتوای دیگری استفاده شده است.', 409, 'request_id_conflict');
      if (admission.status === 'active') {
        fail('این گفتگو یک نوبت فعال دارد؛ به همان نوبت متصل شوید.', 409, 'turn_active', {
          turnId: admission.current?.turnId || '',
          requestId: admission.current?.requestId || requestId,
          turnActive: true,
          state: admission.current?.state || 'running'
        });
      }
      if (admission.status === 'replay') {
        let outcome = {};
        try { outcome = JSON.parse(admission.record?.outcome || '{}'); } catch { /* ignore */ }
        return json({
          ok: true,
          replayed: true,
          requestId,
          turnId: String(admission.record?.turn_id || ''),
          state: String(admission.record?.state || 'completed'),
          ...outcome
        }, 200, { 'X-Request-Replayed': '1', 'X-Turn-Id': String(admission.record?.turn_id || ''), 'X-Request-Id': requestId });
      }
      const turnId = admission.turnId;
      let runnerStarted = false;
      try {
      const preloadedWaveCkpt = await loadTurnCheckpoint(env, identity.owner, conversation.id).catch(() => null);
      const isWaveContinuation = Boolean(
        data?.silentAutoResume === true &&
          preloadedWaveCkpt?.active &&
          (!preloadedWaveCkpt.turnId || !data?.resumeTurnId || preloadedWaveCkpt.turnId === data.resumeTurnId) &&
          (preloadedWaveCkpt?.reason === 'wave_continue' || preloadedWaveCkpt?.reason === 'local_exec_continue')
      );
      if (data?.silentAutoResume === true && !isWaveContinuation && data?.resumeCheckpoint !== true) {
        fail('نقطه ادامه معتبر نیست؛ وضعیت گفتگو را دوباره بارگذاری کنید.', 409, 'checkpoint_stale');
      }
      if (!isWaveContinuation) {
        await enforceChatLimits(env, identity.owner);
      }

      const attachments = await resolveUploadRefs(env, identity.owner, data?.attachments);
      const userText = rawText || (attachments.length ? 'فایل‌های پیوست را بررسی کن.' : '');
      if (!userText) fail('متن پیام خالی است.', 400, 'empty_message');

      const effectiveEnv = await resolveEffectiveEnv(env, identity.owner);
      const subreqTracker = { count: 1 };
      effectiveEnv._subreq = subreqTracker;
      const incomingPower =
        data?.powerProfile && typeof data.powerProfile === 'object' ? data.powerProfile : {};
      const incomingMarathon = data?.marathon && typeof data.marathon === 'object' ? data.marathon : null;
      const marathonIsLive = Boolean(incomingMarathon?.active && !incomingMarathon?.paused);
      const requestedAgentMode = data?.agentMode;
      // Prevent mode contradiction: an active Marathon run requires write/patch/shell capability unless user explicitly ran `/plan` or `/suggest` without marathon
      const effectiveRequestedMode =
        marathonIsLive && (requestedAgentMode === 'plan' || requestedAgentMode === 'suggest')
          ? 'full-auto'
          : requestedAgentMode;

      const agentConfig = normalizeAgentConfig(
        {
          ...(effectiveEnv._agentConfig || DEFAULT_AGENT_CONFIG),
          ...(effectiveRequestedMode ? { mode: effectiveRequestedMode } : {}),
          ...(typeof data?.networkAccess === 'boolean' ? { networkAccess: data.networkAccess } : {}),
          ...(typeof data?.shellAccess === 'boolean' ? { shellAccess: data.shellAccess } : {}),
          ...(VALID_TOKEN_SAVER_MODES.includes(data?.tokenSaver) ? { tokenSaver: data.tokenSaver } : {}),
          ...(data?.temperature !== undefined ? { temperature: data.temperature } : {}),
          ...(data?.maxSteps !== undefined ? { maxSteps: data.maxSteps } : {}),
          ...(data?.contextBudget !== undefined ? { contextBudget: data.contextBudget } : {}),
          ...(incomingPower.workStamina ? { workStamina: incomingPower.workStamina } : {}),
          ...(incomingPower.detailThinking ? { detailThinking: incomingPower.detailThinking } : {}),
          ...(incomingPower.ambitionLevel ? { ambitionLevel: incomingPower.ambitionLevel } : {}),
          ...(incomingPower.humanSensitivity ? { humanSensitivity: incomingPower.humanSensitivity } : {}),
          ...(data?.workStamina ? { workStamina: data.workStamina } : {}),
          ...(data?.detailThinking ? { detailThinking: data.detailThinking } : {}),
          ...(data?.ambitionLevel ? { ambitionLevel: data.ambitionLevel } : {}),
          ...(data?.humanSensitivity ? { humanSensitivity: data.humanSensitivity } : {}),
          ...(incomingMarathon ? { marathon: incomingMarathon } : {})
        },
        effectiveEnv._agentConfig || DEFAULT_AGENT_CONFIG
      );

      let selectedModel = data?.model ? sanitizeModelId(data.model, effectiveEnv) : undefined;
      if (!selectedModel && !effectiveEnv.MODEL_NAME && !isTookenUrl(effectiveEnv.MODEL_BASE_URL)) {
        try {
          const liveModels = await fetchProviderModels(effectiveEnv);
          if (liveModels.length) selectedModel = liveModels[0].id;
        } catch {
          selectedModel = undefined;
        }
      }
      const effectiveModelId = selectedModel || String(effectiveEnv.MODEL_NAME || 'claude-sonnet-5-5');
      const reasoningSpec = getModelReasoningSpec(effectiveModelId, effectiveEnv);
      const reasoningEffort = normalizeReasoningEffort(
        data?.reasoningEffort,
        effectiveModelId,
        data?.thinking,
        effectiveEnv
      );
      const thinking = Boolean(reasoningEffort && reasoningEffort !== 'none');
      const powerPlan = resolvePowerExecutionPlan(agentConfig, reasoningEffort);
      const maxSteps = powerPlan.maxSteps;
      if (data?.contextBudget !== undefined && agentConfig.contextBudget) {
        effectiveEnv.CONTEXT_BUDGET_TOKENS = String(agentConfig.contextBudget);
      }
      // Keep automatic stamina-boosted floor lean (<= 32k tokens) unless the user explicitly configured a higher contextBudget:
      const cappedPowerContextBudget = Math.min(powerPlan.contextBudget, 32_000);
      if (
        agentConfig.workStamina &&
        agentConfig.workStamina !== 'medium' &&
        agentConfig.workStamina !== 'low' &&
        cappedPowerContextBudget > (Number(effectiveEnv.CONTEXT_BUDGET_TOKENS) || 0)
      ) {
        effectiveEnv.CONTEXT_BUDGET_TOKENS = String(cappedPowerContextBudget);
      }

      const rpdSaverActive = isRpdLimitedTurn({
        tokenSaver: agentConfig.tokenSaver || 'max',
        baseUrl: effectiveEnv.MODEL_BASE_URL,
        model: effectiveModelId
      });
      effectiveEnv._rpdSaverActive = rpdSaverActive;

      const MUTATING_TOOL_NAMES = new Set(['write_file', 'apply_patch', 'delete_file', 'undo_edit']);
      const NET_TOOL_NAMES = new Set(['web_search', 'fetch_url']);
      const baseTools = data.tools === undefined ? TOOLS : sanitizeTools(data.tools);
      const tools = baseTools.filter((t) => {
        const fnName = t?.function?.name;
        if (rpdSaverActive && fnName === 'think') {
          return false;
        }
        if ((agentConfig.mode === 'plan' || agentConfig.mode === 'suggest') && MUTATING_TOOL_NAMES.has(fnName)) {
          return false;
        }
        if ((agentConfig.mode === 'plan' || agentConfig.mode === 'suggest' || !agentConfig.shellAccess) && fnName === 'run_command') {
          return false;
        }
        if (!agentConfig.networkAccess && NET_TOOL_NAMES.has(fnName)) {
          return false;
        }
        return true;
      });

      const { count } = await messageStats(env, conversation.id);
      if (count === 0) {
        await env.DB.prepare('UPDATE conversations SET title=? WHERE id=? AND owner=?')
          .bind(deriveTitle([{ role: 'user', content: userText }]), conversation.id, identity.owner)
          .run();
      }

      const existingCheckpointPreload = await loadTurnCheckpoint(env, identity.owner, conversation.id).catch(() => null);
      if (data?.silentAutoResume === true && existingCheckpointPreload?.active) {
        const ck = existingCheckpointPreload;
        if (ck.reason === 'user_stopped' || (ck.turnId && data?.resumeTurnId && ck.turnId !== data.resumeTurnId)) {
          fail('نقطه ادامه متعلق به نوبت دیگری است یا توسط کاربر متوقف شده؛ ادامه خودکار مجاز نیست.', 409, 'checkpoint_stale');
        }
      }
      const isSilentAutoResume = Boolean(data?.silentAutoResume === true && existingCheckpointPreload?.active);

      // 1. Persist the user turn first (durability over speed), unless this is a silent background VPN-blip reconnect.
      if (!isSilentAutoResume) {
        await appendMessages(env, conversation, [
          { role: 'user', content: redactSecrets(userText, envSecrets(effectiveEnv)), attachments, created_at: Date.now() }
        ]);
      }

      let workspace;
      try {
        workspace = await hydrateConversationWorkspace(env, conversation);
      } catch {
        workspace = safeWorkspace({});
      }
      const tokenSaver = agentConfig.tokenSaver || 'max';
      effectiveEnv._agentConfig = agentConfig;
      const turn = {
        diffs: [],
        validation: [],
        commands: [],
        generatedImages: [],
        touched: new Set(),
        deleted: new Set(),
        workspaceChanged: false,
        editCount: 0,
        savedChars: 0,
        tokenSaver,
        maxFileEdits: powerPlan.maxFileEdits,
        thinkToolLimit: powerPlan.thinkToolLimit
      };

      const useLocalTermuxBridge = Boolean(
        data?.localRunner !== false &&
          (data?.localRunner === true || effectiveEnv._sandboxMode === 'local-termux') &&
          agentConfig.shellAccess
      );
      const localTermuxInfo =
        data?.localTermuxInfo && typeof data.localTermuxInfo === 'object' ? data.localTermuxInfo : null;
      const linux = linuxRunnerEnabled(effectiveEnv) || useLocalTermuxBridge;
      const sb = sandboxEnabled(env);
      const turnReg = registerActiveTurn(identity.owner, conversation.id, turnId);
      const stopHeartbeat = startTurnHeartbeat(env, identity.owner, conversation.id, turnId, turnReg.controller);
      // Headless turns: a client disconnect (page refresh, app close, mobile
      // backgrounding) must NOT kill the turn. The turn keeps running under
      // waitUntil, persists everything to D1 incrementally, and the user
      // re-attaches via polling (/api/state/conversations/:id → turnActive).
      // Only an explicit stop (/api/chat/stop) aborts turnReg.
      let headless = false;
      if (request?.signal) {
        if (request.signal.aborted) {
          headless = true;
        } else {
          request.signal.addEventListener('abort', () => { headless = true; }, { once: true });
        }
      }
      const { stream, send, close } = sseStream();
      const headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
        'X-CodePilot-Build': BUILD_VERSION,
        'X-Turn-Id': turnId,
        'X-Request-Id': requestId
      };
      if (setCookie) headers['Set-Cookie'] = setCookie;

      const newMessages = [];
      // Incremental persistence: messages are flushed to D1 at every step
      // boundary so (a) polling clients watch live progress, and (b) nothing
      // is lost if the isolate is evicted mid-turn. Final flushes only append
      // the not-yet-persisted tail to avoid double-writes.
      let persistedMsgCount = 0;
      const flushNewMessagesTail = async () => {
        if (newMessages.length <= persistedMsgCount) return;
        const tail = newMessages.slice(persistedMsgCount);
        const repaired = repairToolGroups(tail);
        if (repaired.length) {
          await appendMessages(env, conversation, repaired);
          await env.DB.prepare('UPDATE conversations SET last_message_at=?, updated_at=? WHERE id=? AND owner=?')
            .bind(Date.now(), Date.now(), conversation.id, identity.owner)
            .run();
        }
        persistedMsgCount += tail.length;
      };
      let finalText = '';
      let usedModel = '';
      let requestedModelUsed = selectedModel || '';
      let appliedEffort = reasoningEffort;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalReasoningTokens = 0;
      let totalCachedTokens = 0;
      let lastPromptTokens = 0;
      let latestRateLimit = null;
      let steps = 0;
      let stepStreamedContent = '';
      let stepStreamedReasoning = '';
      let healedTextCarry = '';
      let autoHealCount = 0;
      const MAX_AUTO_HEALS = 3;
      let turnInterruptedReason = '';
      let pendingLocalExecPayload = null;
      const completedToolsLog = [];
      let existingCheckpoint = existingCheckpointPreload;
      let resumingFromCheckpoint = false;
      let terminalState = 'error';
      let terminalOutcome = { code: 'chat_failed', resumable: true };

      const turnRunner = (async () => {
        try {
          resumingFromCheckpoint = Boolean(
            existingCheckpoint && (isSilentAutoResume || data?.resumeCheckpoint === true || isResumePrompt(userText))
          );
          if (existingCheckpoint && !resumingFromCheckpoint) {
            await clearTurnCheckpoint(env, identity.owner, conversation.id).catch(() => {});
            existingCheckpoint = null;
          }

          // Stitch results returned by the browser's Local Termux Bridge (`127.0.0.1:8787`) right into D1 history before continuing!
          if (
            resumingFromCheckpoint &&
            existingCheckpoint?.pendingLocalExec &&
            Array.isArray(data?.localExecResults)
          ) {
            const ple = existingCheckpoint.pendingLocalExec;
            const byCallId = new Map(
              data.localExecResults
                .filter((r) => r && typeof r.callId === 'string')
                .map((r) => [r.callId, r])
            );
            const secrets = envSecrets(effectiveEnv);
            const resolvedToolMsgs = Array.isArray(ple.completedToolResults) ? [...ple.completedToolResults] : [];

            for (const item of Array.isArray(ple.pendingCommands) ? ple.pendingCommands : []) {
              const r = byCallId.get(item.callId) || {
                ok: false,
                exitCode: 1,
                stdout: '',
                stderr: 'No response returned from local Termux bridge.'
              };
              const syncInfo = applyRunnerFileChanges(workspace, r, secrets);
              for (const p of syncInfo.touchedFiles) {
                turn.touched.add(p);
                turn.workspaceChanged = true;
                send('live_file', {
                  path: p,
                  deleted: false,
                  content: String(workspace.files[p] || ''),
                  step: existingCheckpoint.completedSteps || 1,
                  editCount: turn.editCount
                });
              }
              for (const p of syncInfo.deletedFiles) {
                turn.deleted.add(p);
                turn.workspaceChanged = true;
                send('live_file', {
                  path: p,
                  deleted: true,
                  content: '',
                  step: existingCheckpoint.completedSteps || 1,
                  editCount: turn.editCount
                });
              }

              const label =
                r.runner === 'fallback-cloud'
                  ? 'Real Linux container execution (cloud fallback — local Termux offline)'
                  : 'Real Local Termux execution (127.0.0.1 device bridge)';
              const formatted = formatRealResult(label, {
                exitCode: Number.isFinite(Number(r.exitCode)) ? Number(r.exitCode) : r.ok ? 0 : 1,
                durationMs: Number.isFinite(Number(r.durationMs)) ? Number(r.durationMs) : null,
                stdout: redactSecrets(String(r.stdout ?? '').slice(0, 24_000), secrets),
                stderr: redactSecrets(String(r.stderr ?? '').slice(0, 24_000), secrets)
              });
              turn.commands.push({ command: item.command, mode: 'local-termux', ok: Boolean(r.ok) });
              if (r.ok) {
                completedToolsLog.push(`run_command(${String(item.command || '').slice(0, 40)})`);
              }
              const toolMsg = {
                role: 'tool',
                tool_call_id: item.callId,
                content: compactToolResult(stripSecrets(formatted, secrets)),
                created_at: Date.now()
              };
              resolvedToolMsgs.push(toolMsg);
              send('tool_result', {
                id: item.callId,
                name: 'run_command',
                ok: Boolean(r.ok),
                step: existingCheckpoint.completedSteps || 1,
                result: toolMsg.content.slice(0, 4000)
              });
            }

            if (ple.assistantMsg) {
              const repairedLocalGroup = repairToolGroups([ple.assistantMsg, ...resolvedToolMsgs]);
              if (repairedLocalGroup.length) {
                await appendMessages(env, conversation, repairedLocalGroup);
              }
            }
            if (turn.workspaceChanged) {
              await persistConversationWorkspace(env, identity.owner, conversation.id, workspace, {
              touched: [...turn.touched],
              deleted: [...turn.deleted]
            }).catch(() => {});
            }
            existingCheckpoint = {
              ...existingCheckpoint,
              pendingLocalExec: null,
              skipResumeDirective: true
            };
          }

          send('status', {
            phase: resumingFromCheckpoint ? 'resuming' : 'thinking',
            turnId,
            requestId,
            build: BUILD_VERSION,
            sandbox: sb,
            linuxRunner: linux,
            reasoningEffort,
            reasoningSupported: reasoningSpec.supported,
            maxSteps,
            powerProfile: powerPlan.axes,
            ...(resumingFromCheckpoint
              ? {
                  resumedFrom: {
                    completedSteps: existingCheckpoint.completedSteps || 0,
                    touchedFiles: existingCheckpoint.touchedFiles || []
                  }
                }
              : {})
          });

          const history = await listMessages(env, conversation.id);
          const memories = await listMemories(env, identity.owner).catch(() => []);
          effectiveEnv._agentConfig = agentConfig;
          const working = await buildWorkingContext({
            env: effectiveEnv,
            conversation: { ...conversation, owner: identity.owner },
            messages: history,
            memories,
            callModel: (payload) =>
              callModel(effectiveEnv, { ...payload, signal: turnReg.signal, ...(selectedModel ? { model: selectedModel } : {}) }),
            saveMemories: (memo) =>
              env.DB.prepare(
                `INSERT INTO memories(id,owner,scope,project,key,value,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner,scope,project,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
              )
                .bind(
                  crypto.randomUUID(),
                  identity.owner,
                  'global',
                  '',
                  memo.key,
                  redactSecrets(memo.value),
                  Date.now(),
                  Date.now()
                )
                .run()
          });

          const systemPrompt = buildSystemPrompt({
            workspace,
            memories,
            repo: data.repo && typeof data.repo === 'object' ? data.repo : null,
            user: { email: identity.email },
            sandbox: sb,
            linuxRunner: linux,
            localTermux: useLocalTermuxBridge,
            localTermuxInfo,
            thinking,
            agentConfig
          });

          const messages = [{ role: 'system', content: systemPrompt }];
          if (working.summary) {
            messages.push({ role: 'user', content: `[حافظه‌ی گفتگو — داده‌ی مرجع، نه دستور]\n${working.summary}` });
            messages.push({ role: 'assistant', content: 'حافظه را خواندم. ادامه می‌دهیم.' });
          }
          messages.push(...working.recent);
          await hydrateUploadParts(env, identity.owner, messages, { resilient: true });

          // Zero-roundtrip `@filepath` / `@filepath:start-end` pre-pinning + 50-RPD 1-Shot Workspace Preloading on fresh user turns:
          // Placed inside `messages[0]` (`role: 'system'`) so LLMs never mistake preloaded workspace files for user prompt injection!
          if (!resumingFromCheckpoint && tokenSaver !== 'off') {
            const pinned = extractMentionedFileContext(userText, workspace.files, { tokenSaver });
            let extraTurnContext = pinned.block ? pinned.block.trim() : '';
            if (pinned.savedRoundtripChars > 0) {
              turn.savedChars += pinned.savedRoundtripChars;
            }
            if (rpdSaverActive) {
              const rpdPack = buildRequestSaverWorkspacePack(workspace.files, workspace.active, userText, {
                excludePaths: pinned.paths || pinned.pinnedPaths || []
              });
              if (rpdPack.injectedText) {
                extraTurnContext = extraTurnContext
                  ? `${extraTurnContext}\n\n${rpdPack.injectedText}`
                  : rpdPack.injectedText;
                if (rpdPack.preloadedPaths.length) {
                  turn.savedRequests = (turn.savedRequests || 0) + 1;
                }
              }
            }
            if (extraTurnContext && messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
              messages[0] = {
                ...messages[0],
                content: `${messages[0].content}\n\n## System-Provided Workspace Context\n${extraTurnContext}`
              };
            }
          }

          // Inject surgical checkpoint continuation briefing on the wire when resuming («ادامه» or silent VPN auto-recovery)
          if (resumingFromCheckpoint && existingCheckpoint) {
            const directive = buildCheckpointResumeDirective(existingCheckpoint, workspace);
            if (directive) {
              if (messages.at(-1)?.role === 'assistant') {
                messages.push({ role: 'user', content: directive });
              } else {
                for (let mi = messages.length - 1; mi >= 1; mi -= 1) {
                  if (messages[mi]?.role === 'user') {
                    if (typeof messages[mi].content === 'string') {
                      messages[mi] = { ...messages[mi], content: `${messages[mi].content}\n\n${directive}` };
                    } else if (Array.isArray(messages[mi].content)) {
                      messages[mi] = {
                        ...messages[mi],
                        content: [...messages[mi].content, { type: 'text', text: `\n\n${directive}` }]
                      };
                    }
                    break;
                  }
                }
              }
            }
          }

          let autoRepairAttempts = 0;
          let hitWaveBoundary = false;
          let lastStepInfo = null;
          const MUTATING_LIVE_SET = new Set(['write_file', 'apply_patch', 'delete_file', 'undo_edit']);
          const EXTERNAL_FETCH_TOOLS = new Set(['run_command', 'web_search', 'fetch_url', 'generate_image']);
          const safeWaveSteps = Math.max(2, Math.min(Number(effectiveEnv.WAVE_STEP_BUDGET) || 24, 34));
          const safeSubreqCap = Math.max(4, Math.min(Number(effectiveEnv.WAVE_SUBREQ_BUDGET) || 34, 42));
          const priorCompletedSteps = resumingFromCheckpoint ? Number(existingCheckpoint?.completedSteps) || 0 : 0;
          const remainingTotalSteps = Math.max(4, maxSteps - priorCompletedSteps);
          const waveMaxSteps = Math.min(remainingTotalSteps, safeWaveSteps);

          while (steps < waveMaxSteps) {
            if (turnReg.signal.aborted) {
              const stopErr = new Error('اجرای پاسخ توسط کاربر متوقف شد.');
              stopErr.status = 499;
              stopErr.code = 'turn_stopped';
              throw stopErr;
            }
            // Cross-isolate stop + fenced liveness heartbeat at every step.
            const leaseCheck = await heartbeatTurn(env, identity.owner, conversation.id, turnId);
            if (leaseCheck.stopped || turnReg.signal.aborted) {
              const stopErr = new Error('اجرای پاسخ توسط کاربر متوقف شد.');
              stopErr.status = 499;
              stopErr.code = 'turn_stopped';
              throw stopErr;
            }
            if (leaseCheck.lost) {
              const lostErr = new Error('مالکیت این نوبت از دست رفت؛ اجرای موازی متوقف شد.');
              lostErr.status = 409;
              lostErr.code = 'turn_lease_lost';
              throw lostErr;
            }
            // Everything from previous steps forms complete tool groups by
            // now — persist it so progress is visible to polling clients.
            if (steps > 0) {
              await flushNewMessagesTail().catch(() => {});
            }
            if (steps > 0 && subreqTracker.count >= safeSubreqCap) {
              hitWaveBoundary = true;
              break;
            }
            steps += 1;
            stepStreamedContent = '';
            stepStreamedReasoning = '';
            // Provider-Aware Dual Strategy:
            // - On Cache-Discounted Gateways (`openrouter.ai`, direct Anthropic/OpenAI/DeepSeek): stay 100% append-only (< 140k chars) for 90% cache-read discount!
            // - On Raw-Token-Quota Gateways (`tooken.club`, etc.): immediately compact persisted `write_file`/`apply_patch` args & stale/old reads on steps >= 2 so raw tokens aren't re-billed!
            const cacheDiscounted = isCacheDiscountedEndpoint(effectiveEnv.MODEL_BASE_URL);
            if (steps >= 2 && tokenSaver !== 'off') {
              const pruned = pruneInTurnWireMessages(messages.slice(1), {
                tokenSaver,
                cacheDiscounted
              });
              if (pruned.savedChars > 0) {
                turn.savedChars += pruned.savedChars;
                messages.splice(1, messages.length - 1, ...pruned.messages);
              }
            }
            if (estimateMessagesTextChars(messages) > 140_000) {
              if (tokenSaver !== 'off' && cacheDiscounted) {
                const pruned = pruneInTurnWireMessages(messages.slice(1), { tokenSaver, force: true });
                if (pruned.savedChars > 0) {
                  turn.savedChars += pruned.savedChars;
                  messages.splice(1, messages.length - 1, ...pruned.messages);
                }
              }
              if (estimateMessagesTextChars(messages) > 140_000) {
                const beforeChars = estimateMessagesTextChars(messages);
                const slimmedInFlight = slimHistoricalToolPayloads(messages.slice(1), { keepVerbatimTail: 4 });
                messages.splice(1, messages.length - 1, ...slimmedInFlight);
                turn.savedChars += Math.max(0, beforeChars - estimateMessagesTextChars(messages));
              }
            }
            if (estimateMessagesTextChars(messages) > Math.min(powerPlan.maxTurnInputChars, 210_000)) {
              const beforeChars = estimateMessagesTextChars(messages);
              const tighterInFlight = slimHistoricalToolPayloads(messages.slice(1), { keepVerbatimTail: 2 });
              messages.splice(1, messages.length - 1, ...tighterInFlight);
              turn.savedChars += Math.max(0, beforeChars - estimateMessagesTextChars(messages));
            }

            const stepEffort = resolveAdaptiveStepEffort({
              baseEffort: reasoningEffort,
              step: steps,
              userText,
              lastStepInfo,
              isAutoRepair: autoRepairAttempts > 0,
              tokenSaver,
              supportedLevels: reasoningSpec.levels
            });

            let deltaChars = 0;
            let lastToolDeltaPing = 0;
            send('status', {
              phase: steps > 1 ? 'working' : (resumingFromCheckpoint ? 'resuming' : 'thinking'),
              step: priorCompletedSteps + steps,
              waveStep: steps,
              maxSteps
            });
            let result;
            try {
              result = await callModel(effectiveEnv, {
                ...(selectedModel ? { model: selectedModel } : {}),
                ...(stepEffort !== null ? { reasoningEffort: stepEffort } : {}),
                tokenSaver,
                temperature: agentConfig.temperature ?? 0.25,
                timeoutMs: powerPlan.timeoutMs,
                signal: turnReg.signal,
                messages,
                tools,
                onDelta: (chunk) => {
                  if (chunk?.type === 'provider_failover') {
                    send('status', {
                      phase: 'provider_failover',
                      toBaseUrl: chunk.toBaseUrl || '',
                      fromBaseUrl: chunk.fromBaseUrl || '',
                      slot: chunk.slot || 2,
                      fromSlot: chunk.fromSlot || 1,
                      label: chunk.label || '',
                      totalGateways: chunk.totalGateways || 2,
                      reason: chunk.reason || 'failover',
                      step: priorCompletedSteps + steps,
                      maxSteps
                    });
                    return;
                  }
                  if (chunk?.type === 'rate_limit_wait') {
                    send('status', {
                      phase: 'rate_limit_wait',
                      waitMs: chunk.waitMs || 2500,
                      attempt: chunk.attempt || 1,
                      step: priorCompletedSteps + steps,
                      maxSteps
                    });
                    return;
                  }
                  if (chunk?.type === 'tool_delta') {
                    const nowMs = Date.now();
                    if (nowMs - lastToolDeltaPing >= 1200) {
                      lastToolDeltaPing = nowMs;
                      send('status', {
                        phase: 'tool_streaming',
                        toolName: chunk.name || 'tool',
                        chars: chunk.totalChars || 0,
                        step: priorCompletedSteps + steps,
                        maxSteps
                      });
                    }
                    return;
                  }
                  if (!chunk?.text) return;
                  deltaChars += chunk.text.length;
                  if (chunk.type === 'content') {
                    stepStreamedContent += chunk.text;
                    send('delta', { text: chunk.text, step: priorCompletedSteps + steps });
                  } else if (chunk.type === 'reasoning') {
                    stepStreamedReasoning += chunk.text;
                    if (deltaChars <= powerPlan.thinkingDeltaLimit) {
                      send('thinking_delta', { text: chunk.text, step: priorCompletedSteps + steps });
                    }
                  }
                }
              });
            } catch (stepErr) {
              if (stepErr?.code === 'subrequest_limit') {
                steps = Math.max(0, steps - 1);
                hitWaveBoundary = true;
                break;
              }
              // Seamless Server-Side Auto-Heal when an upstream SSE socket resets mid-stream!
              if (stepErr?.code === 'stream_interrupted' && !turnReg.signal.aborted && autoHealCount < MAX_AUTO_HEALS) {
                autoHealCount += 1;
                const partialPiece = String(stepErr.partialContent || stepStreamedContent || '');
                send('status', { phase: 'auto-heal', attempt: autoHealCount, step: steps, maxSteps });
                if (partialPiece) {
                  healedTextCarry += partialPiece;
                  messages.push({ role: 'assistant', content: partialPiece });
                  messages.push({
                    role: 'user',
                    content:
                      '[ادامه‌ی خودکار سیستم پس از نوسان استریم: متن بالا تا همین کاراکتر به کاربر نمایش داده شد. بدون تکرار هیچ کلمه‌ای از متن قبلی، دقیقاً از کاراکتر/جمله یا ابزار بعدی ادامه بده و کار را کامل کن.]'
                  });
                } else {
                  steps = Math.max(0, steps - 1);
                }
                await new Promise((r) => setTimeout(r, 450 * autoHealCount));
                continue;
              }
              throw stepErr;
            }
            usedModel = result.model;
            if (!requestedModelUsed && result.requestedModel) {
              requestedModelUsed = result.requestedModel;
            }
            if (result.reasoningEffort !== undefined) appliedEffort = result.reasoningEffort;
            if (result.rateLimit) latestRateLimit = result.rateLimit;
            const stepPromptTokens = Number(result.usage?.prompt_tokens) || 0;
            const stepCompletionTokens = Number(result.usage?.completion_tokens) || 0;
            const stepReasoningTokens = Number(result.usage?.reasoning_tokens) || 0;
            const stepCachedTokens = Number(result.usage?.cached_tokens) || 0;
            if (stepPromptTokens > 0) lastPromptTokens = stepPromptTokens;
            totalPromptTokens += stepPromptTokens;
            totalCompletionTokens += stepCompletionTokens;
            totalReasoningTokens += stepReasoningTokens;
            totalCachedTokens += stepCachedTokens;

            if (result.reasoning || stepReasoningTokens > 0) {
              send('thinking', {
                thought: result.reasoning ? result.reasoning.slice(0, 10_000) : '',
                plan: '',
                native: true,
                encrypted: !result.reasoning && stepReasoningTokens > 0,
                effort: appliedEffort || reasoningEffort || 'medium',
                reasoningTokens: stepReasoningTokens
              });
            }
            const assistant = result.message;

            if (assistant.tool_calls?.length) {
              const combinedToolProse = healedTextCarry + (assistant.content || '');
              healedTextCarry = '';
              const stored = {
                role: 'assistant',
                content: combinedToolProse,
                ...(result.reasoning ? { reasoning: result.reasoning.slice(0, 10_000) } : {}),
                ...(appliedEffort && appliedEffort !== 'none' ? { reasoning_effort: appliedEffort } : {}),
                ...(stepReasoningTokens > 0 ? { reasoning_tokens: stepReasoningTokens } : {}),
                tool_calls: assistant.tool_calls,
                created_at: Date.now()
              };

              send('tool', {
                step: steps,
                maxSteps,
                calls: assistant.tool_calls.map((call) => ({
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments
                }))
              });

              const secretsForStep = envSecrets(effectiveEnv);
              const localEligibleIds = new Set();
              if (useLocalTermuxBridge) {
                for (const call of assistant.tool_calls) {
                  if (call?.function?.name !== 'run_command') continue;
                  let parsedArgs = {};
                  try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch { parsedArgs = {}; }
                  const cmdStr = String(parsedArgs.command || '').trim();
                  const verdict = classifyCommand(cmdStr);
                  const leaksSecret = secretsForStep.some((s) => s && cmdStr.includes(s));
                  if (verdict.allowed && !leaksSecret) {
                    localEligibleIds.add(call.id);
                  }
                }
              }

              if (localEligibleIds.size > 0) {
                let stepMutatedWorkspace = false;
                const stepCompletedToolResults = [];
                const pendingCommands = [];

                for (const call of assistant.tool_calls) {
                  let args = {};
                  try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
                  if (localEligibleIds.has(call.id)) {
                    pendingCommands.push({
                      callId: call.id,
                      command: String(args.command || '').trim()
                    });
                    continue;
                  }
                  let outcome;
                  if (EXTERNAL_FETCH_TOOLS.has(call.function.name)) {
                    subreqTracker.count += 1;
                  }
                  try {
                    outcome = await executeTool({
                      env,
                      effectiveEnv,
                      owner: identity.owner,
                      conversation,
                      name: call.function.name,
                      args,
                      workspace,
                      turn,
                      send,
                      signal: turnReg.signal
                    });
                  } catch (error) {
                    outcome = { ok: false, text: `Error: ${error?.message || 'tool failed'}` };
                  }
                  if (outcome.ok) {
                    const argHint =
                      args?.path ||
                      args?.title?.slice(0, 40) ||
                      args?.prompt?.slice(0, 40) ||
                      args?.command?.slice(0, 40) ||
                      args?.query?.slice(0, 40) ||
                      '';
                    completedToolsLog.push(argHint ? `${call.function.name}(${argHint})` : call.function.name);
                  }
                  const toolResult = {
                    role: 'tool',
                    tool_call_id: call.id,
                    content: compactToolResult(stripSecrets(outcome.text, secretsForStep)),
                    created_at: Date.now()
                  };
                  stepCompletedToolResults.push(toolResult);
                  send('tool_result', {
                    id: call.id,
                    name: call.function.name,
                    ok: outcome.ok,
                    step: steps,
                    result: toolResult.content.slice(0, 4000)
                  });
                  if (outcome.ok && MUTATING_LIVE_SET.has(call.function.name) && args?.path) {
                    stepMutatedWorkspace = true;
                    const p = String(args.path);
                    const deleted = workspace.files[p] === undefined;
                    send('live_file', {
                      path: p,
                      deleted,
                      content: deleted ? '' : String(workspace.files[p] || ''),
                      step: steps,
                      editCount: turn.editCount
                    });
                  }
                }

                if (stepMutatedWorkspace) {
                  await persistConversationWorkspace(env, identity.owner, conversation.id, workspace, {
              touched: [...turn.touched],
              deleted: [...turn.deleted]
            }).catch(() => {});
                }

                pendingLocalExecPayload = {
                  assistantMsg: stored,
                  completedToolResults: stepCompletedToolResults,
                  pendingCommands
                };
                turnInterruptedReason = 'local_exec_continue';
                send('local_exec', {
                  step: priorCompletedSteps + steps,
                  maxSteps,
                  commands: pendingCommands
                });
                break;
              }

              newMessages.push(stored);
              messages.push(toWire(stored));

              let stepMutatedWorkspace = false;
              let stepHadError = false;
              const stepOnlyListing = assistant.tool_calls.every(
                (c) => c?.function?.name === 'list_files' || c?.function?.name === 'list_symbols'
              );
              const stepDidMutateOrTest = assistant.tool_calls.some(
                (c) => MUTATING_LIVE_SET.has(c?.function?.name) || c?.function?.name === 'run_command'
              );
              for (const call of assistant.tool_calls) {
                let args = {};
                try {
                  args = JSON.parse(call.function.arguments || '{}');
                } catch {
                  args = {};
                }
                let outcome;
                if (EXTERNAL_FETCH_TOOLS.has(call.function.name)) {
                  subreqTracker.count += 1;
                }
                try {
                  outcome = await executeTool({
                    env,
                    effectiveEnv,
                    owner: identity.owner,
                    conversation,
                    name: call.function.name,
                    args,
                    workspace,
                    turn,
                    send,
                    signal: turnReg.signal
                  });
                } catch (error) {
                  outcome = { ok: false, text: `Error: ${error?.message || 'tool failed'}` };
                }
                if (!outcome.ok) {
                  stepHadError = true;
                } else {
                  const argHint =
                    args?.path ||
                    args?.title?.slice(0, 40) ||
                    args?.prompt?.slice(0, 40) ||
                    args?.command?.slice(0, 40) ||
                    args?.query?.slice(0, 40) ||
                    '';
                  completedToolsLog.push(argHint ? `${call.function.name}(${argHint})` : call.function.name);
                }
                const toolResult = {
                  role: 'tool',
                  tool_call_id: call.id,
                  content: compactToolResult(stripSecrets(outcome.text, envSecrets(env))),
                  created_at: Date.now()
                };
                newMessages.push(toolResult);
                messages.push(toWire(toolResult));
                send('tool_result', {
                  id: call.id,
                  name: call.function.name,
                  ok: outcome.ok,
                  step: steps,
                  result: toolResult.content.slice(0, 4000)
                });

                // Stream live file updates to the UI & mark for immediate D1 flush!
                if (outcome.ok && MUTATING_LIVE_SET.has(call.function.name) && args?.path) {
                  stepMutatedWorkspace = true;
                  const p = String(args.path);
                  const deleted = workspace.files[p] === undefined;
                  send('live_file', {
                    path: p,
                    deleted,
                    content: deleted ? '' : String(workspace.files[p] || ''),
                    step: steps,
                    editCount: turn.editCount
                  });
                }
              }

              // Persist workspace to D1 immediately after every mutating step so zero file edits can ever be lost!
              if (stepMutatedWorkspace) {
                await persistConversationWorkspace(env, identity.owner, conversation.id, workspace, {
              touched: [...turn.touched],
              deleted: [...turn.deleted]
            }).catch(() => {});
              }
              let hasAnyValidationError = false;
              for (const p of turn.touched) {
                if (p.startsWith('(') || workspace.files[p] === undefined) continue;
                const check = validateFile(p, String(workspace.files[p]));
                if (!check.ok && check.errors?.length) {
                  hasAnyValidationError = true;
                  break;
                }
              }
              lastStepInfo = {
                hadError: stepHadError,
                hadValidationError: hasAnyValidationError,
                onlyListing: !stepHadError && stepOnlyListing,
                justVerifiedClean: !stepHadError && !hasAnyValidationError && stepDidMutateOrTest
              };

              // 50-Req/Day 1-Shot Fast-Finish: when RPD Request-Saver is active and all tool calls in this step
              // were clean file mutations (`Validation: OK.`, zero errors, no pending read/search/shell calls),
              // finish immediately without burning a 2nd upstream API request just to say "Done!"
              const stepOnlyMutatingEdits =
                assistant.tool_calls.length > 0 &&
                assistant.tool_calls.every((c) => MUTATING_LIVE_SET.has(c?.function?.name));
              if (
                rpdSaverActive &&
                stepOnlyMutatingEdits &&
                stepMutatedWorkspace &&
                !stepHadError &&
                !hasAnyValidationError &&
                !agentConfig?.marathon?.active
              ) {
                healedTextCarry = '';
                const existingProse = combinedToolProse.trim();
                if (existingProse) {
                  finalText = existingProse;
                } else {
                  const summaryLines = [...turn.touched]
                    .filter((p) => !p.startsWith('('))
                    .map((p) => (turn.deleted.has(p) ? `• حذف \`${p}\`` : `• بروزرسانی و اعتبارسنجی \`${p}\``));
                  const autoSummary = `✔ تغییرات در ۱ درخواست اعمال شد (صرفه‌جویی در سقف ۵۰ درخواست روزانه):\n${summaryLines.join('\n')}`;
                  send('delta', { text: autoSummary, step: priorCompletedSteps + steps });
                  finalText = autoSummary;
                }
                stepStreamedContent = '';
                turn.savedRequests = (turn.savedRequests || 0) + 1;
                const fastGw = effectiveEnv._activeGateway || {
                  slot: 1,
                  baseUrl: effectiveEnv.MODEL_BASE_URL || 'https://tooken.club/v1'
                };
                newMessages.push({
                  role: 'assistant',
                  content: finalText,
                  ...(usedModel ? { actual_model: usedModel } : {}),
                  ...(requestedModelUsed ? { requested_model: requestedModelUsed } : {}),
                  gateway_info: fastGw,
                  created_at: Date.now()
                });
                messages.push({ role: 'assistant', content: finalText });
                send('assistant', {
                  content: finalText,
                  interrupted: false,
                  actualModel: usedModel,
                  requestedModel: requestedModelUsed,
                  activeGateway: fastGw
                });
                break;
              }
              continue;
            }

            // Seamless Server-Side Auto-Heal when stream cuts off cleanly or hits max_tokens (`length`):
            if ((result.interrupted || result.finishReason === 'length') && autoHealCount < MAX_AUTO_HEALS && steps < maxSteps) {
              autoHealCount += 1;
              const piece = String(assistant.content || '');
              if (piece) {
                healedTextCarry += piece;
                messages.push({ role: 'assistant', content: piece });
                messages.push({
                  role: 'user',
                  content:
                    '[ادامه‌ی خودکار بدون وقفه: متن بالا تا نقطه برش نمایش داده شد. بدون تکرار هیچ بخشی از متن قبلی، دقیقاً از کلمه/خط بعدی ادامه بده تا پاسخ یا کد کامل شود.]'
                });
                send('status', { phase: 'auto-heal', attempt: autoHealCount, step: steps, maxSteps });
                continue;
              }
            }

            if (result.interrupted) {
              turnInterruptedReason = 'stream_cutoff';
            } else if (result.finishReason === 'length') {
              turnInterruptedReason = 'length_cutoff';
            }

            const stitchedProse = healedTextCarry + String(assistant.content || '');
            // Autonomous Self-Repair Gate when boosted Power Engine is active (skip if stream itself cut off):
            if (!turnInterruptedReason && powerPlan.autoRepairValidation && autoRepairAttempts < 2 && steps < maxSteps) {
              const brokenFiles = [];
              for (const p of turn.touched) {
                if (p.startsWith('(') || workspace.files[p] === undefined) continue;
                const check = validateFile(p, String(workspace.files[p]));
                if (!check.ok && check.errors?.length) {
                  brokenFiles.push(`${p}: ${check.errors.join(' | ')}`);
                }
              }
              if (brokenFiles.length > 0) {
                autoRepairAttempts += 1;
                healedTextCarry = '';
                const interim = stitchedProse.trim();
                if (interim) messages.push({ role: 'assistant', content: interim });
                messages.push({
                  role: 'user',
                  content: `[کنترل کیفیت خودکار موتور قدرت]: پیش از پایان کار، فایل‌های زیر هنوز خطای اعتبارسنجی دارند. لطفاً همین الان با apply_patch یا write_file آن‌ها را اصلاح و بررسی کن:\n${brokenFiles.join('\n')}`
                });
                send('status', { phase: 'auto-repair', step: steps, brokenFiles: brokenFiles.length });
                continue;
              }
            }

            healedTextCarry = '';
            let missingImgMarkdown = '';
            if (Array.isArray(turn.generatedImages) && turn.generatedImages.length > 0) {
              const missingCards = turn.generatedImages.filter((img) => !stitchedProse.includes(img.url));
              if (missingCards.length > 0) {
                missingImgMarkdown =
                  missingCards
                    .map((img) => `![${(img.title || 'تصویر تولیدشده').replace(/[\[\]\r\n]/g, ' ').trim()}](${img.url})`)
                    .join('\n\n') + '\n\n';
              }
            }
            finalText = (missingImgMarkdown + stitchedProse.trim()).trim() || 'انجام شد.';
            stepStreamedContent = '';
            const turnActiveGw = effectiveEnv._activeGateway || {
              slot: 1,
              baseUrl: effectiveEnv.MODEL_BASE_URL || 'https://tooken.club/v1'
            };
            newMessages.push({
              role: 'assistant',
              content: finalText,
              ...(usedModel ? { actual_model: usedModel } : {}),
              ...(requestedModelUsed ? { requested_model: requestedModelUsed } : {}),
              gateway_info: turnActiveGw,
              ...(result.reasoning ? { reasoning: result.reasoning.slice(0, 10_000) } : {}),
              ...(appliedEffort && appliedEffort !== 'none' ? { reasoning_effort: appliedEffort } : {}),
              ...(stepReasoningTokens > 0 ? { reasoning_tokens: stepReasoningTokens } : {}),
              created_at: Date.now()
            });
            messages.push({ role: 'assistant', content: finalText });
            send('assistant', {
              content: finalText,
              interrupted: Boolean(turnInterruptedReason),
              actualModel: usedModel,
              requestedModel: requestedModelUsed,
              activeGateway: turnActiveGw
            });
            break;
          }

          let isWaveHandoff = false;
          const isLocalExecHandoff = Boolean(turnInterruptedReason === 'local_exec_continue' && pendingLocalExecPayload);
          const cumulativeStepsNow = priorCompletedSteps + steps;
          const nextWaveNumber = (Number(existingCheckpoint?.waveNumber) || 0) + 1;

          if (!finalText && !isLocalExecHandoff) {
            if ((hitWaveBoundary || (newMessages.length > 0 && steps >= waveMaxSteps)) && cumulativeStepsNow < maxSteps) {
              // Clean Multi-Wave Handoff BEFORE Cloudflare Workers' 50-subrequest limit!
              isWaveHandoff = true;
              turnInterruptedReason = 'wave_continue';
            } else if (newMessages.length > 0) {
              turnInterruptedReason = 'step_limit';
              finalText = 'به سقف مراحل این نوبت رسیدم و تمام فایل‌ها و تغییرات تا همین نقطه ذخیره شدند. بنویسید «ادامه» تا دقیقاً از مرحله‌ی بعدی ادامه دهم.';
            } else {
              finalText = 'پاسخی دریافت نشد. دوباره تلاش کنید.';
            }
            if (finalText && !newMessages.some((m) => m.role === 'assistant' && m.content === finalText)) {
              newMessages.push({ role: 'assistant', content: finalText, created_at: Date.now() });
            }
          }

          await flushNewMessagesTail();

          const hasWorkspaceChanges = turn.touched.size > 0 || turn.deleted.size > 0 || turn.workspaceChanged;
          const stats = await messageStats(env, conversation.id);
          if (hasWorkspaceChanges) {
            await persistConversationWorkspace(env, identity.owner, conversation.id, workspace, {
              touched: [...turn.touched],
              deleted: [...turn.deleted]
            });
          }

          let savedCheckpoint = null;
          const touchedList = [...turn.touched].filter((p) => !p.startsWith('('));
          if (turnInterruptedReason) {
            savedCheckpoint = await saveTurnCheckpoint(env, identity.owner, conversation.id, {
              turnId,
              prevCheckpoint: resumingFromCheckpoint ? existingCheckpoint : null,
              originalGoal: userText,
              reason: turnInterruptedReason,
              waveNumber: isWaveHandoff ? nextWaveNumber : undefined,
              stepsCompleted: steps,
              touchedFiles: touchedList,
              deletedFiles: [...turn.deleted],
              completedTools: completedToolsLog,
              pendingLocalExec: isLocalExecHandoff ? pendingLocalExecPayload : null,
              partialContent:
                isWaveHandoff || isLocalExecHandoff || turnInterruptedReason === 'step_limit' ? '' : finalText
            }).catch(() => null);
          } else if (resumingFromCheckpoint || existingCheckpoint) {
            await clearTurnCheckpointForTurn(env, identity.owner, conversation.id, turnId).catch(() => {});
          }

          const outputChars = newMessages.reduce(
            (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
            0
          );
          const totalInputChars = estimateMessagesTextChars(messages);
          await recordUsage(env, identity.owner, {
            inputChars: totalInputChars,
            outputChars,
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            reasoningTokens: totalReasoningTokens
          });
          await env.DB.prepare(
            'UPDATE conversations SET last_model=?, message_count=?, last_message_at=?, updated_at=? WHERE id=? AND owner=?'
          )
            .bind(usedModel, stats.count, Date.now(), Date.now(), conversation.id, identity.owner)
            .run();

          const marathonGoalDone = Boolean(
            agentConfig.marathon?.active && /\[MARATHON_COMPLETE\]/i.test(String(finalText || ''))
          );
          const displayFinalText = marathonGoalDone
            ? String(finalText || '').replace(/\s*\[MARATHON_COMPLETE\]\s*/gi, '\n\n🏁 **ماراتن به هدف نهایی رسید.**').trim()
            : finalText;

          const latest = await getConversation(env, identity.owner, conversation.id);
          const validation = turn.validation.filter((entry) => !entry.ok || entry.warnings.length);
          const effectiveContextTokens = lastPromptTokens > 0 ? lastPromptTokens : Math.ceil(totalInputChars / 2);
          const structuralSavedTokens =
            tokenSaver === 'off' ? 0 : Math.round((turn.savedChars || 0) / 3.4);
          const cacheDiscountTokens = Math.round(totalCachedTokens * 0.85);
          const savedTokensEstimate = structuralSavedTokens + cacheDiscountTokens;
          const totalUsedTokens = totalPromptTokens + totalCompletionTokens + totalReasoningTokens;
          const effectiveBilledTokens = Math.max(0, totalUsedTokens - cacheDiscountTokens);
          const baselineTokens = Math.max(1, effectiveBilledTokens + savedTokensEstimate);
          const savingsPercent =
            savedTokensEstimate > 0
              ? Math.min(96, Math.round((savedTokensEstimate / baselineTokens) * 100))
              : 0;
          const normCompareModel = (val) =>
            String(val || '')
              .trim()
              .toLowerCase()
              .replace(/:free$/, '')
              .replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
          const normReq = normCompareModel(requestedModelUsed);
          const normAct = normCompareModel(usedModel);
          const modelMismatch = Boolean(
            normReq &&
              normAct &&
              normReq !== normAct &&
              !normAct.endsWith(`/${normReq}`) &&
              !normReq.endsWith(`/${normAct}`) &&
              !normAct.startsWith(`${normReq}-`)
          );
          const finalActiveGw = effectiveEnv._activeGateway || {
            slot: 1,
            baseUrl: effectiveEnv.MODEL_BASE_URL || 'https://tooken.club/v1'
          };
          terminalState = 'completed';
          terminalOutcome = {
            resumable: Boolean(savedCheckpoint),
            waveContinue: isWaveHandoff,
            localExecContinue: isLocalExecHandoff,
            interruptedReason: isWaveHandoff || isLocalExecHandoff ? null : turnInterruptedReason || null
          };
          send('done', {
            turnId,
            requestId,
            build: BUILD_VERSION,
            content: displayFinalText,
            marathonCompleted: marathonGoalDone,
            model: usedModel,
            actualModel: usedModel,
            requestedModel: requestedModelUsed,
            modelMismatch,
            activeGateway: finalActiveGw,
            reasoningEffort: appliedEffort,
            reasoningTokens: totalReasoningTokens,
            turnTokens: {
              prompt: totalPromptTokens,
              completion: totalCompletionTokens,
              reasoning: totalReasoningTokens,
              cached: totalCachedTokens,
              effectiveBilled: effectiveBilledTokens,
              savedEstimate: savedTokensEstimate,
              savingsPercent,
              total: totalUsedTokens,
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              reasoningTokens: totalReasoningTokens,
              cachedTokens: totalCachedTokens,
              effectiveBilledTokens,
              savedTokensEstimate,
              requestsUsed: steps,
              savedRequests: turn.savedRequests || 0,
              rpdSaverActive,
              totalTokens: totalUsedTokens
            },
            ...(latestRateLimit ? { rateLimit: latestRateLimit } : {}),
            modelReasoning: getModelReasoningSpec(effectiveModelId, effectiveEnv),
            conversation: conversationView(latest),
            touchedFiles: touchedList,
            deletedFiles: [...turn.deleted],
            workspaceDirty: hasWorkspaceChanges,
            workspace: hasWorkspaceChanges ? workspace : undefined,
            diffs: turn.diffs.map((d) => ({
              path: d.path,
              added: d.added,
              removed: d.removed,
              diff: d.diff.slice(0, 60_000)
            })),
            validation,
            commands: turn.commands,
            steps,
            cumulativeSteps: cumulativeStepsNow,
            maxSteps,
            waveContinue: isWaveHandoff,
            waveNumber: isWaveHandoff ? nextWaveNumber : undefined,
            localExecContinue: isLocalExecHandoff,
            pendingLocalCommands: isLocalExecHandoff ? pendingLocalExecPayload.pendingCommands : undefined,
            powerProfile: powerPlan.axes,
            interrupted: Boolean(turnInterruptedReason && !isWaveHandoff && !isLocalExecHandoff),
            interruptedReason: isWaveHandoff || isLocalExecHandoff ? null : turnInterruptedReason || null,
            resumable: Boolean(savedCheckpoint),
            checkpoint: savedCheckpoint,
            resumedFromCheckpoint: resumingFromCheckpoint,
            sandbox: sb,
            linuxRunner: linux,
            context: {
              summaryUntil: working.summaryUntil,
              recentMessages: working.recent.length,
              estimatedTokens: effectiveContextTokens
            }
          });

          // No server-side self-POST: a disconnected client re-attaches to this
          // lease or resumes the saved checkpoint explicitly. Chaining fetches
          // here used to overlap the next turn and hit Workers self-invocation
          // limits while making Stop/quota behavior unpredictable.
        } catch (error) {
          const partialContent = stripSecrets(
            String((healedTextCarry || '') + (error?.partialContent || stepStreamedContent || '')).trim(),
            envSecrets(effectiveEnv)
          );
          const partialReasoning = stripSecrets(
            String(error?.partialReasoning || stepStreamedReasoning || '').trim(),
            envSecrets(effectiveEnv)
          );
          const interruptedToolCall = extractPartialToolTarget(error?.partialToolCalls);
          const touchedList = [...turn.touched].filter((p) => !p.startsWith('('));
          const hasChanges = touchedList.length > 0 || turn.deleted.size > 0 || turn.workspaceChanged;
          const errCode = String(error?.code || 'chat_failed');
          const errMsg = error?.status ? error.message : 'خطا در پردازش درخواست. پیشرفت ذخیره شد؛ بنویسید «ادامه».';
          const reason =
            errCode === 'turn_stopped'
              ? 'user_stopped'
              : errCode === 'model_quota_exhausted'
                ? 'quota_exhausted'
                : errCode === 'model_auth'
                  ? 'auth_failed'
                  : errCode === 'model_rate_limited'
                    ? 'rate_limited'
                    : errCode === 'subrequest_limit'
                      ? 'wave_continue'
                      : errCode === 'stream_interrupted' || errCode === 'model_bad_response'
                        ? 'stream_cutoff'
                        : errCode === 'model_timeout' || errCode === 'model_unreachable'
                          ? 'timeout'
                          : 'error';

          terminalState = errCode === 'turn_stopped' ? 'stopped' : 'error';
          terminalOutcome = { code: errCode, reason, resumable: true, retryAfterMs: Number(error?.retryAfterMs || 0) };
          let savedCheckpoint = null;
          try {
            // Persist complete groups from the not-yet-flushed tail (earlier
            // steps were already flushed incrementally — never re-append them).
            await flushNewMessagesTail().catch(() => {});
            const effectiveStoppedText =
              partialContent ||
              (errCode === 'turn_stopped' && partialReasoning ? '⏹ *(تولید پاسخ در مرحلهٔ استدلال توسط کاربر متوقف شد)*' : '');
            if (effectiveStoppedText) {
              await appendMessages(env, conversation, [
                {
                  role: 'assistant',
                  content: effectiveStoppedText,
                  ...(partialReasoning ? { reasoning: partialReasoning.slice(0, 10_000) } : {}),
                  created_at: Date.now()
                }
              ]);
              const statsNow = await messageStats(env, conversation.id);
              await env.DB.prepare('UPDATE conversations SET message_count=?, last_message_at=?, updated_at=? WHERE id=? AND owner=?')
                .bind(statsNow.count, Date.now(), Date.now(), conversation.id, identity.owner)
                .run();
            }
            if (hasChanges) {
              await persistConversationWorkspace(env, identity.owner, conversation.id, workspace, {
              touched: [...turn.touched],
              deleted: [...turn.deleted]
            });
            }
            savedCheckpoint = await saveTurnCheckpoint(env, identity.owner, conversation.id, {
              turnId,
              prevCheckpoint: resumingFromCheckpoint ? existingCheckpoint : null,
              originalGoal: userText,
              reason,
              errorCode: errCode,
              errorMessage: errMsg,
              stepsCompleted: Math.max(0, steps - 1),
              touchedFiles: touchedList,
              deletedFiles: [...turn.deleted],
              completedTools: completedToolsLog,
              interruptedToolCall,
              partialContent
            });
          } catch {
            // Persisting the error report matters more than this best effort.
          }

          if (errCode === 'turn_stopped') {
            send('stopped', {
              turnId,
              requestId,
              build: BUILD_VERSION,
              code: 'turn_stopped',
              reason: 'user_stopped',
              message: errMsg,
              resumable: true,
              partialContent,
              savedFiles: touchedList,
              deletedFiles: [...turn.deleted],
              workspace: hasChanges ? workspace : undefined,
              checkpoint: savedCheckpoint
            });
          } else {
            send('error', {
              turnId,
              requestId,
              build: BUILD_VERSION,
              error: errMsg,
              code: errCode,
              reason,
              retryAfterMs: Number(error?.retryAfterMs || 0),
              resumable: true,
              partialContent,
              savedFiles: touchedList,
              deletedFiles: [...turn.deleted],
              workspace: hasChanges ? workspace : undefined,
              checkpoint: savedCheckpoint,
              partial: newMessages.length > 0 || Boolean(partialContent)
            });
          }
        } finally {
          stopHeartbeat();
          turnReg.release();
          await releaseTurn(env, identity.owner, conversation.id, turnId, terminalState, terminalOutcome);
          close();
        }
      })();
      runnerStarted = true;
      if (typeof waitUntil === 'function') {
        try { waitUntil(turnRunner); } catch { /* ignore */ }
      }

      return new Response(stream, { status: 200, headers });
      } catch (error) {
        if (!runnerStarted) {
          await releaseTurn(env, identity.owner, conversation.id, turnId, 'error', {
            code: error?.code || 'chat_setup_failed',
            message: error?.status ? error.message : 'خطا در آماده‌سازی نوبت.',
            resumable: false
          });
        }
        throw error;
      }
    },
    // 20 MB of files expands to ~26.7 MB in Base64; leave room for message metadata.
    { write: true, body: 28_000_000, waitUntil: waitUntilFn }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response(JSON.stringify({ error: 'متد پشتیبانی نمی‌شود.' }), {
    status: 405,
    headers: { Allow: 'POST', 'Content-Type': 'application/json' }
  });
}
