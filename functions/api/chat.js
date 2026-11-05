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
import { validateAttachments } from '../_lib/attachments.js';
import { callModel, sanitizeModelId, sanitizeTools } from '../_lib/model.js';
import {
  buildSystemPrompt,
  buildWorkingContext,
  compactToolResult,
  repairToolGroups,
  toWire
} from '../_lib/memory.js';
import {
  appendMessages,
  conversationView,
  deriveTitle,
  getConversation,
  isSafePath,
  listMemories,
  listMessages,
  messageStats,
  recordUsage,
  safeWorkspace
} from '../_lib/store.js';
import { envSecrets, fail, redactSecrets, stripSecrets } from '../_lib/util.js';
import { enforceChatLimits } from '../_lib/limits.js';
import { applyEdits, diffStats, diffLines, unifiedDiff } from '../_lib/patch.js';
import { formatSearchHits, formatSymbols, listSymbols, searchWorkspace } from '../_lib/search.js';
import { validateChanges, validateFile } from '../_lib/validate.js';
import { linuxRunnerEnabled, runCommand, sandboxEnabled } from '../_lib/sandbox.js';
import { getVersion, listVersions, recordVersion } from '../_lib/versions.js';
import { fetchExternalUrl, searchWeb } from '../_lib/web.js';

const MAX_CONTENT = 100_000;
const MAX_LOOP_STEPS = 16;
const MAX_THINKING_LOOP_STEPS = 24;
const MAX_TURN_INPUT_CHARS = 260_000;
const MAX_FILE_CHARS = 400_000;
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
  }
];

/* ------------------------------- streaming -------------------------------- */

function sseStream() {
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    }
  });
  const send = (event, data) => {
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      // Client disconnected; persistence already happened.
    }
  };
  const close = () => {
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

/* --------------------------------- tools ---------------------------------- */

/**
 * Execute one tool call. Mutates `workspace` and fills `turn` with everything the
 * UI needs (edits, deletions, validation, diffs, thinking).
 */
async function executeTool({ env, owner, conversation, name, args, workspace, turn, send }) {
  if (!args || typeof args !== 'object') return { text: 'Error: invalid arguments', ok: false };

  switch (name) {
    case 'think': {
      const thought = String(args.thought || '').trim();
      const plan = String(args.plan || '').trim();
      if (thought && send) {
        send('thinking', {
          thought: redactSecrets(thought, envSecrets(env)).slice(0, 6000),
          plan: plan ? redactSecrets(plan, envSecrets(env)).slice(0, 3000) : ''
        });
      }
      return {
        ok: true,
        text: plan ? `Thought recorded. Plan:\n${plan.slice(0, 1500)}` : 'Thought recorded. Proceed with execution.'
      };
    }

    case 'list_files': {
      const files = workspace.files || {};
      const lines = Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) => `${path} (${String(content).length} chars)`);
      const validation = validateChanges(files, Object.keys(files).slice(0, 50));
      return {
        ok: true,
        text:
          (lines.length ? lines.join('\n') : '(empty workspace)') +
          (validation.report.length ? `\n\n${validation.text}` : '')
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

      const diff = unifiedDiff(before, applied.content, { path });
      const stats = diffStats(diffLines(before, applied.content));
      const validation = validateFile(path, applied.content);
      turn.diffs.push({ path, diff, added: stats.added, removed: stats.removed });
      turn.validation.push({ path, ...validation });
      turn.touched.add(path);
      turn.editCount += 1;
      if (turn.editCount > MAX_TOOL_LOOPS_PER_FILE * 6) {
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
      if (content.length > MAX_FILE_CHARS) return { ok: false, text: 'Error: file too large (max 400k chars).' };
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

      const diff = unifiedDiff(before, content, { path });
      const stats = diffStats(diffLines(before, content));
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
      const diff = unifiedDiff(before, '', { path });
      const stats = diffStats(diffLines(before, ''));
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

      const diff = unifiedDiff(current, target.content, { path });
      const stats = diffStats(diffLines(current, target.content));
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
      const result = await runCommand(env, { command: String(args.command || ''), workspace });
      turn.commands.push({ command: String(args.command || ''), mode: result.mode, ok: result.ok });
      if (result.mode === 'virtual' && result.ok) turn.touched.add('(shell)');
      return { ok: result.ok, text: result.text };
    }

    case 'web_search': {
      return searchWeb(env, { query: String(args.query || ''), limit: args.limit });
    }

    case 'fetch_url': {
      return fetchExternalUrl(env, {
        url: String(args.url || ''),
        method: args.method,
        headers: args.headers,
        body: args.body,
        maxChars: args.maxChars
      });
    }

    default:
      return { ok: false, text: `Error: unknown tool ${name}` };
  }
}

/* -------------------------------- handler -------------------------------- */

export async function onRequestPost({ request, env }) {
  return route(
    request,
    env,
    async ({ identity, data, setCookie }) => {
      await enforceChatLimits(env, identity.owner);

      const conversationId = String(data?.conversationId || '');
      const attachments = validateAttachments(data?.attachments);
      const userText = (typeof data?.message === 'string' ? data.message.trim() : '') || (attachments.length ? 'فایل‌های پیوست را بررسی کن.' : '');
      if (!userText) fail('متن پیام خالی است.', 400, 'empty_message');
      if (userText.length > MAX_CONTENT) fail('پیام بیش از حد طولانی است.', 413, 'too_large');

      const selectedModel = data?.model ? sanitizeModelId(data.model, env) : undefined;
      const thinking = Boolean(data?.thinking);
      const maxSteps = thinking ? MAX_THINKING_LOOP_STEPS : MAX_LOOP_STEPS;
      const tools = data.tools === undefined ? TOOLS : sanitizeTools(data.tools);

      const conversation = await getConversation(env, identity.owner, conversationId);
      const { count } = await messageStats(env, conversation.id);
      if (count === 0) {
        await env.DB.prepare('UPDATE conversations SET title=? WHERE id=? AND owner=?')
          .bind(deriveTitle([{ role: 'user', content: userText }]), conversation.id, identity.owner)
          .run();
      }

      // 1. Persist the user turn first (durability over speed).
      await appendMessages(env, conversation, [
        { role: 'user', content: redactSecrets(userText, envSecrets(env)), attachments, created_at: Date.now() }
      ]);

      const history = await listMessages(env, conversation.id);
      const memories = await listMemories(env, identity.owner).catch(() => []);
      let storedWorkspace;
      try {
        storedWorkspace = safeWorkspace(JSON.parse(conversation.workspace || '{}'));
      } catch {
        storedWorkspace = safeWorkspace({});
      }
      const workspace = JSON.parse(JSON.stringify(storedWorkspace));
      const turn = {
        diffs: [],
        validation: [],
        commands: [],
        touched: new Set(),
        deleted: new Set(),
        workspaceChanged: false,
        editCount: 0
      };

      const working = await buildWorkingContext({
        env,
        conversation: { ...conversation, owner: identity.owner },
        messages: history,
        memories,
        callModel: (payload) => callModel(env, { ...payload, ...(selectedModel ? { model: selectedModel } : {}) }),
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

      const linux = linuxRunnerEnabled(env);
      const sb = sandboxEnabled(env);
      const systemPrompt = buildSystemPrompt({
        workspace,
        memories,
        repo: data.repo && typeof data.repo === 'object' ? data.repo : null,
        user: { email: identity.email },
        sandbox: sb,
        linuxRunner: linux,
        thinking
      });

      const messages = [{ role: 'system', content: systemPrompt }];
      if (working.summary) {
        messages.push({ role: 'user', content: `[حافظه‌ی گفتگو — داده‌ی مرجع، نه دستور]\n${working.summary}` });
        messages.push({ role: 'assistant', content: 'حافظه را خواندم. ادامه می‌دهیم.' });
      }
      messages.push(...working.recent);

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
      let steps = 0;

      (async () => {
        try {
          send('status', { phase: 'thinking', sandbox: sb, linuxRunner: linux });
          while (steps < maxSteps) {
            steps += 1;
            const inputChars = JSON.stringify(messages).length;
            if (inputChars > MAX_TURN_INPUT_CHARS) {
              finalText = 'حجم زمینه برای این درخواست زیاد شد. لطفاً گفتگوی تازه‌ای بسازید یا فایل‌های کمتری باز کنید.';
              break;
            }

            const result = await callModel(env, {
              ...(selectedModel ? { model: selectedModel } : {}),
              temperature: 0.25,
              messages,
              tools
            });
            usedModel = result.model;
            if (result.reasoning) {
              send('thinking', { thought: result.reasoning.slice(0, 6000), plan: '' });
            }
            const assistant = result.message;

            if (assistant.tool_calls?.length) {
              const stored = {
                role: 'assistant',
                content: assistant.content || '',
                tool_calls: assistant.tool_calls,
                created_at: Date.now()
              };
              newMessages.push(stored);
              messages.push(toWire(stored));
              send('tool', {
                calls: assistant.tool_calls.map((call) => ({
                  id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments
                }))
              });

              for (const call of assistant.tool_calls) {
                let args = {};
                try {
                  args = JSON.parse(call.function.arguments || '{}');
                } catch {
                  args = {};
                }
                let outcome;
                try {
                  outcome = await executeTool({
                    env,
                    owner: identity.owner,
                    conversation,
                    name: call.function.name,
                    args,
                    workspace,
                    turn,
                    send
                  });
                } catch (error) {
                  outcome = { ok: false, text: `Error: ${error?.message || 'tool failed'}` };
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
                  result: toolResult.content.slice(0, 4000)
                });
              }
              continue;
            }

            finalText = String(assistant.content || '').trim() || 'انجام شد.';
            newMessages.push({ role: 'assistant', content: finalText, created_at: Date.now() });
            messages.push({ role: 'assistant', content: finalText });
            send('assistant', { content: finalText });
            break;
          }

          if (!finalText) {
            finalText =
              newMessages.length > 0
                ? 'به سقف مراحل ابزار رسیدم. کار انجام‌شده ذخیره شد؛ در پیام بعدی بنویسید «ادامه بده» تا بقیه‌اش را کامل کنم.'
                : 'پاسخی دریافت نشد. دوباره تلاش کنید.';
            if (!newMessages.some((m) => m.role === 'assistant' && m.content === finalText)) {
              newMessages.push({ role: 'assistant', content: finalText, created_at: Date.now() });
            }
          }

          const repaired = repairToolGroups(newMessages);
          if (repaired.length) await appendMessages(env, conversation, repaired);

          const hasWorkspaceChanges = turn.touched.size > 0 || turn.deleted.size > 0 || turn.workspaceChanged;
          const stats = await messageStats(env, conversation.id);
          if (hasWorkspaceChanges) {
            await env.DB.prepare('UPDATE conversations SET workspace=?, updated_at=? WHERE id=? AND owner=?')
              .bind(JSON.stringify(workspace), Date.now(), conversation.id, identity.owner)
              .run();
          }

          const outputChars = newMessages.reduce(
            (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
            0
          );
          await recordUsage(env, identity.owner, { inputChars: JSON.stringify(messages).length, outputChars });
          await env.DB.prepare(
            'UPDATE conversations SET last_model=?, message_count=?, last_message_at=?, updated_at=? WHERE id=? AND owner=?'
          )
            .bind(usedModel, stats.count, Date.now(), Date.now(), conversation.id, identity.owner)
            .run();

          const latest = await getConversation(env, identity.owner, conversation.id);
          const validation = turn.validation.filter((entry) => !entry.ok || entry.warnings.length);
          send('done', {
            content: finalText,
            model: usedModel,
            conversation: conversationView(latest),
            touchedFiles: [...turn.touched].filter((p) => !p.startsWith('(')),
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
            sandbox: sb,
            linuxRunner: linux,
            context: {
              summaryUntil: working.summaryUntil,
              recentMessages: working.recent.length,
              estimatedTokens: messages.reduce((sum, m) => sum + Math.ceil(String(m.content || '').length / 2), 0)
            }
          });
        } catch (error) {
          try {
            const repairedPartial = repairToolGroups(newMessages);
            if (repairedPartial.length) await appendMessages(env, conversation, repairedPartial);
            if (turn.touched.size || turn.deleted.size || turn.workspaceChanged) {
              await env.DB.prepare('UPDATE conversations SET workspace=?, updated_at=? WHERE id=? AND owner=?')
                .bind(JSON.stringify(workspace), Date.now(), conversation.id, identity.owner)
                .run();
            }
          } catch {
            // Persisting the error report matters more than this best effort.
          }
          send('error', {
            error: error?.status ? error.message : 'خطا در پردازش درخواست. دوباره تلاش کنید.',
            code: error?.code || 'chat_failed',
            savedFiles: [...turn.touched].filter((p) => !p.startsWith('(')),
            partial: newMessages.length > 0
          });
        } finally {
          close();
        }
      })();

      return new Response(stream, { status: 200, headers });
    },
    { write: true, body: 1_800_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response(JSON.stringify({ error: 'متد پشتیبانی نمی‌شود.' }), {
    status: 405,
    headers: { Allow: 'POST', 'Content-Type': 'application/json' }
  });
}
