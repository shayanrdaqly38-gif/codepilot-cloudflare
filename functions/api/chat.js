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
  messageStats,
  persistConversationWorkspace,
  recordUsage,
  safeWorkspace
} from '../_lib/store.js';
import { registerActiveTurn } from '../_lib/turn-registry.js';
import { envSecrets, fail, redactSecrets, stripSecrets } from '../_lib/util.js';
import { enforceChatLimits } from '../_lib/limits.js';
import { applyEdits, diffSummary, unifiedDiff } from '../_lib/patch.js';
import { formatSearchHits, formatSymbols, listSymbols, searchWorkspace } from '../_lib/search.js';
import { validateFile } from '../_lib/validate.js';
import { linuxRunnerEnabled, runCommand, sandboxEnabled } from '../_lib/sandbox.js';
import { getVersion, listVersions, recordVersion } from '../_lib/versions.js';
import { fetchExternalUrl, searchWeb } from '../_lib/web.js';
import { generateAndStoreImage } from '../_lib/image.js';

const MAX_CONTENT = 100_000;
const MAX_LOOP_STEPS = 16;
const MAX_THINKING_LOOP_STEPS = 24;
const MAX_TURN_INPUT_CHARS = 260_000;
const MAX_FILE_CHARS = 900_000;
const MAX_TOOL_LOOPS_PER_FILE = 12;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'think',
      description:
        'Record structured chain-of-thought reasoning, architectural analysis, edge cases, and a step-by-step plan before complex edits or debugging. Side-effect free.',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: 'Deep analysis of the problem, constraints, and edge cases' },
          plan: { type: 'string', description: 'Concrete ordered steps to execute and verify (optional)' }
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
      description: 'List every file path in the workspace with its size in characters.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a workspace file. Use `startLine`/`endLine` for large files. Always read before editing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Exact path from list_files' },
          startLine: { type: 'number', description: '1-based first line (optional)' },
          endLine: { type: 'number', description: '1-based last line, inclusive (optional)' }
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
      description:
        'Search all files. `query` is a literal string unless `regex` is true. Returns path:line hits with context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          regex: { type: 'boolean' },
          caseSensitive: { type: 'boolean' },
          pathFilter: { type: 'string', description: 'Only search files whose path contains this' }
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
      description: 'List functions, classes, CSS selectors or HTML ids/classes per file. Optional `query` filter.',
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
      description:
        'Edit an existing file with search/replace blocks. `search` must match uniquely (read the file first). Whitespace drift is tolerated, but ambiguous matches fail. Prefer this over write_file for existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: 'Exact existing text, including indentation' },
                replace: { type: 'string', description: 'Replacement text (empty deletes the block)' },
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
      description:
        'Create a new file, or fully replace one when a whole-file rewrite is genuinely simpler than a patch.',
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
      description:
        'Delete an obsolete file from the workspace (and from GitHub on commit). Saves a restorable version first.',
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
      description: 'Restore a file to its previous version. Call without `versionId` to undo the last edit or deletion.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          versionId: { type: 'string', description: 'Optional id from the edit history' }
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
      description:
        'List saved versions of a file (newest first) with reason, author and size. Use it before undoing or when the user asks what changed to a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'number', description: 'Max entries to return (default 10, max 25)' }
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
      description:
        'Execute a Bash / Linux command (bash, node, python3, gcc, go, rustc, sqlite3, grep, etc.) in a real isolated Linux OS container with workspace files mounted, or fall back to the virtual shell if offline. Always states which mode ran.',
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
      description:
        'Search the live internet for current news, documentation, prices, packages, or real-time facts. Follow up with `fetch_url` on relevant links for full content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords (English or Persian)' },
          limit: { type: 'number', description: 'Max results (default 8, max 15)' }
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
      description:
        'Fetch any public web page (converted to clean readable text) or call any public HTTP/JSON REST API (GET, POST, PUT, PATCH, DELETE).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full https:// or http:// URL' },
          method: { type: 'string', description: 'HTTP method (default GET)' },
          headers: { type: 'object', description: 'Optional request headers' },
          body: { type: 'string', description: 'Optional request body (JSON string or text for POST/PUT/PATCH)' },
          maxChars: { type: 'number', description: 'Max characters to return (default 16000, max 40000)' }
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
      description:
        'Generate a studio-grade high-resolution image (powered for free by Cloudflare Workers AI FLUX.1 / Phoenix + unlimited FLUX failover) and display it directly in chat. Always write `prompt` in vivid, detailed ENGLISH (50–120 words covering subject, composition, lighting, textures, and color palette) even when the user writes in Persian.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Rich, detailed English visual prompt describing subject, composition, lighting, camera/art direction, textures, and mood.'
          },
          title: {
            type: 'string',
            description: 'Short human-friendly title/caption (in Persian if user speaks Persian).'
          },
          aspectRatio: {
            type: 'string',
            enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
            description: 'Image aspect ratio (1:1 square, 16:9 widescreen, 9:16 mobile vertical, 4:3, 3:4).'
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
            ],
            description: 'Studio art-direction preset (default: auto).'
          },
          seed: {
            type: 'number',
            description: 'Optional integer seed for reproducible variations.'
          }
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
      const lines = Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) => `${path} (${String(content).length} chars)`);
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
      const content = String(workspace.files[path]);
      const start = Number(args.startLine);
      const end = Number(args.endLine);
      if (Number.isFinite(start) || Number.isFinite(end)) {
        const lines = content.split('\n');
        const from = Math.max(0, (Number.isFinite(start) ? start : 1) - 1);
        const to = Math.min(lines.length, Number.isFinite(end) ? end : lines.length);
        const slice = lines
          .slice(from, to)
          .map((line, index) => `${from + index + 1}\t${line}`)
          .join('\n');
        return { ok: true, text: `Lines ${from + 1}-${to} of ${lines.length} in ${path}:\n${slice}` };
      }
      return { ok: true, text: content };
    }

    case 'search_code': {
      const result = searchWorkspace(workspace.files, args.query, {
        regex: Boolean(args.regex),
        caseSensitive: Boolean(args.caseSensitive),
        pathFilter: String(args.pathFilter || '')
      });
      return { ok: true, text: formatSearchHits(result) };
    }

    case 'list_symbols': {
      const symbols = listSymbols(workspace.files, { query: String(args.query || '') });
      return { ok: true, text: formatSymbols(symbols) };
    }

    case 'apply_patch': {
      const path = assertSafePath(args.path);
      if (workspace.files[path] === undefined) {
        return { ok: false, text: `Error: file not found: ${path}. Use write_file to create it.` };
      }
      const before = String(workspace.files[path]);
      let applied;
      try {
        applied = applyEdits(before, args.edits);
      } catch (error) {
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
      if (content.length > MAX_FILE_CHARS) return { ok: false, text: 'Error: file too large (max 900k chars).' };
      const existed = workspace.files[path] !== undefined;
      const before = existed ? String(workspace.files[path]) : '';
      if (existed && before === content) return { ok: false, text: 'No change: content is identical.' };
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
      if (Object.keys(workspace.files).length < 2) {
        return { ok: false, text: 'Error: refusing to delete the last remaining file in the workspace.' };
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

      const current = String(workspace.files[path] ?? '');
      if (workspace.files[path] !== undefined && target.content === current) {
        return { ok: false, text: 'Already at that version.' };
      }
      await recordVersion(env, owner, conversation, { path, content: current, reason: 'before-undo' });
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
      const result = await runCommand(env, { command: String(args.command || ''), workspace, externalSignal: signal });
      turn.commands.push({ command: String(args.command || ''), mode: result.mode, ok: result.ok });
      if (result.mode === 'virtual' && result.ok) turn.touched.add('(shell)');
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
      const preloadedWaveCkpt = conversationId
        ? await loadTurnCheckpoint(env, identity.owner, conversationId).catch(() => null)
        : null;
      const isWaveContinuation = Boolean(
        data?.silentAutoResume === true && preloadedWaveCkpt?.active && preloadedWaveCkpt?.reason === 'wave_continue'
      );
      if (!isWaveContinuation) {
        await enforceChatLimits(env, identity.owner);
      }

      const attachments = await resolveUploadRefs(env, identity.owner, data?.attachments);
      const userText = (typeof data?.message === 'string' ? data.message.trim() : '') || (attachments.length ? 'فایل‌های پیوست را بررسی کن.' : '');
      if (!userText) fail('متن پیام خالی است.', 400, 'empty_message');
      if (userText.length > MAX_CONTENT) fail('پیام بیش از حد طولانی است.', 413, 'too_large');

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
          ...(data?.temperature !== undefined ? { temperature: data.temperature } : {}),
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
      // Keep active rolling window lean (<= 32k tokens) even in Ultra-Code mode so Persian UTF-8 + JSON tool calls
      // never trip reverse-proxy 512KB/1MB HTTP 413 limits; older turns summarize into durable rolling memory automatically!
      const cappedPowerContextBudget = Math.min(powerPlan.contextBudget, 32_000);
      if (
        agentConfig.workStamina &&
        agentConfig.workStamina !== 'medium' &&
        agentConfig.workStamina !== 'low' &&
        cappedPowerContextBudget > (Number(effectiveEnv.CONTEXT_BUDGET_TOKENS) || 0)
      ) {
        effectiveEnv.CONTEXT_BUDGET_TOKENS = String(cappedPowerContextBudget);
      }

      const MUTATING_TOOL_NAMES = new Set(['write_file', 'apply_patch', 'delete_file', 'undo_edit']);
      const NET_TOOL_NAMES = new Set(['web_search', 'fetch_url']);
      const baseTools = data.tools === undefined ? TOOLS : sanitizeTools(data.tools);
      const tools = baseTools.filter((t) => {
        const fnName = t?.function?.name;
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

      const conversation = await getConversation(env, identity.owner, conversationId);
      const { count } = await messageStats(env, conversation.id);
      if (count === 0) {
        await env.DB.prepare('UPDATE conversations SET title=? WHERE id=? AND owner=?')
          .bind(deriveTitle([{ role: 'user', content: userText }]), conversation.id, identity.owner)
          .run();
      }

      const existingCheckpointPreload = await loadTurnCheckpoint(env, identity.owner, conversation.id).catch(() => null);
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
      const turn = {
        diffs: [],
        validation: [],
        commands: [],
        generatedImages: [],
        touched: new Set(),
        deleted: new Set(),
        workspaceChanged: false,
        editCount: 0,
        maxFileEdits: powerPlan.maxFileEdits,
        thinkToolLimit: powerPlan.thinkToolLimit
      };

      const linux = linuxRunnerEnabled(env);
      const sb = sandboxEnabled(env);
      const turnReg = registerActiveTurn(identity.owner, conversation.id);
      if (request?.signal) {
        if (request.signal.aborted) {
          turnReg.controller.abort();
        } else {
          request.signal.addEventListener('abort', () => turnReg.controller.abort(), { once: true });
        }
      }

      const { stream, send, close } = sseStream();
      const headers = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive'
      };
      if (setCookie) headers['Set-Cookie'] = setCookie;

      const newMessages = [];
      let finalText = '';
      let usedModel = '';
      let appliedEffort = reasoningEffort;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalReasoningTokens = 0;
      let lastPromptTokens = 0;
      let latestRateLimit = null;
      let steps = 0;
      let stepStreamedContent = '';
      let stepStreamedReasoning = '';
      let healedTextCarry = '';
      let autoHealCount = 0;
      const MAX_AUTO_HEALS = 3;
      let turnInterruptedReason = '';
      const completedToolsLog = [];
      let existingCheckpoint = existingCheckpointPreload;
      let resumingFromCheckpoint = false;

      const turnRunner = (async () => {
        try {
          resumingFromCheckpoint = Boolean(
            existingCheckpoint && (isSilentAutoResume || data?.resumeCheckpoint === true || isResumePrompt(userText))
          );
          if (existingCheckpoint && !resumingFromCheckpoint) {
            await clearTurnCheckpoint(env, identity.owner, conversation.id).catch(() => {});
            existingCheckpoint = null;
          }

          send('status', {
            phase: resumingFromCheckpoint ? 'resuming' : 'thinking',
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
          const working = await buildWorkingContext({
            env: effectiveEnv,
            conversation: { ...conversation, owner: identity.owner },
            messages: history,
            memories,
            callModel: (payload) =>
              callModel(effectiveEnv, { ...payload, ...(selectedModel ? { model: selectedModel } : {}) }),
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
            if (steps > 0 && subreqTracker.count >= safeSubreqCap) {
              hitWaveBoundary = true;
              break;
            }
            steps += 1;
            stepStreamedContent = '';
            stepStreamedReasoning = '';
            // Live in-flight compaction: instead of EVER stopping on `maxTurnInputChars`, slim older steps'
            // redundant `write_file`/`apply_patch`/`read_file` payloads on the fly so 80-step marathons never hit a ceiling!
            if (steps > 3 || estimateMessagesTextChars(messages) > 140_000) {
              const slimmedInFlight = slimHistoricalToolPayloads(messages.slice(1), { keepVerbatimTail: 6 });
              messages.splice(1, messages.length - 1, ...slimmedInFlight);
            }
            if (estimateMessagesTextChars(messages) > Math.min(powerPlan.maxTurnInputChars, 210_000)) {
              const tighterInFlight = slimHistoricalToolPayloads(messages.slice(1), { keepVerbatimTail: 2 });
              messages.splice(1, messages.length - 1, ...tighterInFlight);
            }

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
                ...(reasoningEffort !== null ? { reasoningEffort } : {}),
                temperature: agentConfig.temperature ?? 0.25,
                timeoutMs: powerPlan.timeoutMs,
                signal: turnReg.signal,
                messages,
                tools,
                onDelta: (chunk) => {
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
            if (result.reasoningEffort !== undefined) appliedEffort = result.reasoningEffort;
            if (result.rateLimit) latestRateLimit = result.rateLimit;
            const stepPromptTokens = Number(result.usage?.prompt_tokens) || 0;
            const stepCompletionTokens = Number(result.usage?.completion_tokens) || 0;
            const stepReasoningTokens = Number(result.usage?.reasoning_tokens) || 0;
            if (stepPromptTokens > 0) lastPromptTokens = stepPromptTokens;
            totalPromptTokens += stepPromptTokens;
            totalCompletionTokens += stepCompletionTokens;
            totalReasoningTokens += stepReasoningTokens;

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
              newMessages.push(stored);
              messages.push(toWire(stored));
              send('tool', {
                step: steps,
                maxSteps,
                calls: assistant.tool_calls.map((call) => ({
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments
                }))
              });

              let stepMutatedWorkspace = false;
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
                await persistConversationWorkspace(env, identity.owner, conversation.id, workspace).catch(() => {});
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
            newMessages.push({
              role: 'assistant',
              content: finalText,
              ...(result.reasoning ? { reasoning: result.reasoning.slice(0, 10_000) } : {}),
              ...(appliedEffort && appliedEffort !== 'none' ? { reasoning_effort: appliedEffort } : {}),
              ...(stepReasoningTokens > 0 ? { reasoning_tokens: stepReasoningTokens } : {}),
              created_at: Date.now()
            });
            messages.push({ role: 'assistant', content: finalText });
            send('assistant', { content: finalText, interrupted: Boolean(turnInterruptedReason) });
            break;
          }

          let isWaveHandoff = false;
          const cumulativeStepsNow = priorCompletedSteps + steps;
          const nextWaveNumber = (Number(existingCheckpoint?.waveNumber) || 0) + 1;

          if (!finalText) {
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

          const repaired = repairToolGroups(newMessages);
          if (repaired.length) await appendMessages(env, conversation, repaired);

          const hasWorkspaceChanges = turn.touched.size > 0 || turn.deleted.size > 0 || turn.workspaceChanged;
          const stats = await messageStats(env, conversation.id);
          if (hasWorkspaceChanges) {
            await persistConversationWorkspace(env, identity.owner, conversation.id, workspace);
          }

          let savedCheckpoint = null;
          const touchedList = [...turn.touched].filter((p) => !p.startsWith('('));
          if (turnInterruptedReason) {
            savedCheckpoint = await saveTurnCheckpoint(env, identity.owner, conversation.id, {
              prevCheckpoint: resumingFromCheckpoint ? existingCheckpoint : null,
              originalGoal: userText,
              reason: turnInterruptedReason,
              waveNumber: isWaveHandoff ? nextWaveNumber : undefined,
              stepsCompleted: steps,
              touchedFiles: touchedList,
              deletedFiles: [...turn.deleted],
              completedTools: completedToolsLog,
              partialContent: isWaveHandoff || turnInterruptedReason === 'step_limit' ? '' : finalText
            }).catch(() => null);
          } else if (resumingFromCheckpoint || existingCheckpoint) {
            await clearTurnCheckpoint(env, identity.owner, conversation.id).catch(() => {});
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
          send('done', {
            content: displayFinalText,
            marathonCompleted: marathonGoalDone,
            model: usedModel,
            reasoningEffort: appliedEffort,
            reasoningTokens: totalReasoningTokens,
            turnTokens: {
              prompt: totalPromptTokens,
              completion: totalCompletionTokens,
              reasoning: totalReasoningTokens,
              total: totalPromptTokens + totalCompletionTokens + totalReasoningTokens,
              promptTokens: totalPromptTokens,
              completionTokens: totalCompletionTokens,
              reasoningTokens: totalReasoningTokens,
              totalTokens: totalPromptTokens + totalCompletionTokens + totalReasoningTokens
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
            powerProfile: powerPlan.axes,
            interrupted: Boolean(turnInterruptedReason && !isWaveHandoff),
            interruptedReason: isWaveHandoff ? null : turnInterruptedReason || null,
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

          let savedCheckpoint = null;
          try {
            const repairedPartial = repairToolGroups(newMessages);
            if (partialContent) {
              repairedPartial.push({
                role: 'assistant',
                content: partialContent,
                ...(partialReasoning ? { reasoning: partialReasoning.slice(0, 10_000) } : {}),
                created_at: Date.now()
              });
            }
            if (repairedPartial.length) {
              await appendMessages(env, conversation, repairedPartial);
              const statsNow = await messageStats(env, conversation.id);
              await env.DB.prepare('UPDATE conversations SET message_count=?, last_message_at=?, updated_at=? WHERE id=? AND owner=?')
                .bind(statsNow.count, Date.now(), Date.now(), conversation.id, identity.owner)
                .run();
            }
            if (hasChanges) {
              await persistConversationWorkspace(env, identity.owner, conversation.id, workspace);
            }
            savedCheckpoint = await saveTurnCheckpoint(env, identity.owner, conversation.id, {
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
              error: errMsg,
              code: errCode,
              reason,
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
          turnReg.release();
          close();
        }
      })();
      if (typeof waitUntil === 'function') {
        try { waitUntil(turnRunner); } catch { /* ignore */ }
      }

      return new Response(stream, { status: 200, headers });
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
