// POST /api/chat — one agent turn, durably stored in D1.
//
// Flow:
//   1. Auth (Cloudflare Access → signed session cookie) + same-origin check + limits.
//   2. Persist the incoming user message BEFORE the model, so a failed or
//      interrupted turn is never lost and `seq` stays ordered.
//   3. Rebuild context from D1: rolling summary + recent window + long-term memory.
//   4. Run the model loop. Tools execute server-side on the D1 workspace:
//        list_files, read_file, search_code, list_symbols,
//        write_file, apply_patch, undo_edit, run_command
//      Every edit is validated, diffed, snapshotted and reported back.
//   5. Persist the whole assistant/tool group before streaming `done`.
//
// Response: Server-Sent Events — status / tool / tool_result / message /
// edit / validation / done / error. Every model message is persisted before it
// is streamed, so a dropped connection still leaves a consistent conversation.

import { route } from '../_lib/api.js';
import { callModel, sanitizeTools } from '../_lib/model.js';
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
import { runCommand, sandboxEnabled } from '../_lib/sandbox.js';
import { getVersion, listVersions, recordVersion } from '../_lib/versions.js';

const MAX_CONTENT = 100_000;
const MAX_LOOP_STEPS = 16;
const MAX_TURN_INPUT_CHARS = 200_000;
const MAX_FILE_CHARS = 400_000;
const MAX_TOOL_LOOPS_PER_FILE = 12;

export const TOOLS = [
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
        'Edit an existing file with search/replace blocks. `search` must match exactly one place (read the file first). Whitespace drift is tolerated, but ambiguous matches fail. Prefer this over write_file for existing files.',
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
      name: 'undo_edit',
      description: 'Restore a file to its previous version. Call without `versionId` to undo the last edit.',
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
      name: 'run_command',
      description:
        'Run a shell command. If a real sandbox is configured it executes there; otherwise a safe virtual shell handles help/pwd/ls/cat/touch/echo/rm. The result always states which mode ran.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
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

const SAFE_PATH = /^[\w./-]{1,200}$/;

function assertSafePath(path) {
  const value = String(path || '');
  if (!SAFE_PATH.test(value) || value.includes('..') || value.startsWith('/') || value.startsWith('.git/')) {
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
 * UI needs (edits, validation, diffs).
 */
async function executeTool({ env, owner, conversation, name, args, workspace, turn }) {
  if (!args || typeof args !== 'object') return { text: 'Error: invalid arguments', ok: false };

  switch (name) {
    case 'list_files': {
      const files = workspace.files || {};
      const lines = Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) => `${path} (${String(content).length} chars)`);
      const validation = validateChanges(files, Object.keys(files).slice(0, 40));
      return {
        ok: true,
        text: (lines.length ? lines.join('\n') : '(empty workspace)') +
          (validation.report.length ? `\n\n${validation.text}` : '')
      };
    }

    case 'read_file': {
      const path = String(args.path || '');
      if (workspace.files?.[path] === undefined) {
        const available = fileIndex(workspace).slice(0, 40).join(', ');
        return { ok: false, text: `Error: file not found: ${path}. Available: ${available || '(none)'}` };
      }
      const content = String(workspace.files[path]);
      const start = Number(args.startLine);
      const end = Number(args.endLine);
      if (Number.isFinite(start) || Number.isFinite(end)) {
        const lines = content.split('\n');
        const from = Math.max(0, (Number.isFinite(start) ? start : 1) - 1);
        const to = Math.min(lines.length, Number.isFinite(end) ? end : lines.length);
        const slice = lines.slice(from, to).map((line, index) => `${from + index + 1}\t${line}`).join('\n');
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
        // A failed patch must never change the workspace.
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
      if (existed) {
        await recordVersion(env, owner, conversation, { path, content: before, reason: 'before-write' });
      }
      workspace.files[path] = content;
      workspace.active = path;

      const diff = existed ? unifiedDiff(before, content, { path }) : '';
      const stats = existed ? diffStats(diffLines(before, content)) : { added: content.split('\n').length, removed: 0 };
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
      if (target.content === current) return { ok: false, text: 'Already at that version.' };
      await recordVersion(env, owner, conversation, { path, content: current, reason: 'before-undo' });
      workspace.files[path] = target.content;
      workspace.active = path;

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

    case 'run_command': {
      const result = await runCommand(env, { command: String(args.command || ''), workspace });
      turn.commands.push({ command: String(args.command || ''), mode: result.mode, ok: result.ok });
      if (result.mode === 'virtual' && result.ok) turn.touched.add('(shell)');
      return { ok: result.ok, text: result.text };
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
      const userText = typeof data?.message === 'string' ? data.message.trim() : '';
      if (!userText) fail('متن پیام خالی است.', 400, 'empty_message');
      if (userText.length > MAX_CONTENT) fail('پیام بیش از حد طولانی است.', 413, 'too_large');

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
        { role: 'user', content: redactSecrets(userText, envSecrets(env)), created_at: Date.now() }
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
        editCount: 0
      };

      const working = await buildWorkingContext({
        env,
        conversation: { ...conversation, owner: identity.owner },
        messages: history,
        memories,
        callModel: (payload) => callModel(env, payload),
        saveMemories: (memo) =>
          env.DB.prepare(
            `INSERT INTO memories(id,owner,scope,project,key,value,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(owner,scope,project,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
          )
            .bind(crypto.randomUUID(), identity.owner, 'global', '', memo.key, redactSecrets(memo.value), Date.now(), Date.now())
            .run()
      });

      const systemPrompt = buildSystemPrompt({
        workspace,
        memories,
        repo: data.repo && typeof data.repo === 'object' ? data.repo : null,
        user: { email: identity.email },
        sandbox: sandboxEnabled(env)
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
          send('status', { phase: 'thinking', sandbox: sandboxEnabled(env) });
          while (steps < MAX_LOOP_STEPS) {
            steps += 1;
            const inputChars = JSON.stringify(messages).length;
            if (inputChars > MAX_TURN_INPUT_CHARS) {
              finalText = 'حجم زمینه برای این درخواست زیاد شد. لطفاً گفتگوی تازه‌ای بسازید یا فایل‌های کمتری باز کنید.';
              break;
            }

            const result = await callModel(env, { temperature: 0.3, messages, tools });
            usedModel = result.model;
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
                    turn
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
            // Stream the prose immediately so the user is not waiting on `done`.
            send('assistant', { content: finalText });
            break;
          }

          if (!finalText) {
            finalText =
              newMessages.length > 0
                ? 'به سقف مراحل ابزار رسیدم. کار انجام‌شده ذخیره شد؛ درخواست را به بخش‌های کوچک‌تر تقسیم کنید.'
                : 'پاسخی دریافت نشد. دوباره تلاش کنید.';
            if (!newMessages.some((m) => m.role === 'assistant' && m.content === finalText)) {
              newMessages.push({ role: 'assistant', content: finalText, created_at: Date.now() });
            }
          }

          // Persist the assistant/tool group, then the workspace snapshot.
          const repaired = repairToolGroups(newMessages);
          if (repaired.length) await appendMessages(env, conversation, repaired);

          const stats = await messageStats(env, conversation.id);
          if (turn.touched.size) {
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
            conversation: conversationView(latest),
            touchedFiles: [...turn.touched].filter((p) => !p.startsWith('(')),
            workspaceDirty: turn.touched.size > 0,
            workspace: turn.touched.size ? workspace : undefined,
            diffs: turn.diffs.map((d) => ({ path: d.path, added: d.added, removed: d.removed, diff: d.diff.slice(0, 60_000) })),
            validation,
            commands: turn.commands,
            steps,
            sandbox: sandboxEnabled(env),
            context: {
              summaryUntil: working.summaryUntil,
              recentMessages: working.recent.length,
              estimatedTokens: messages.reduce((sum, m) => sum + Math.ceil(String(m.content || '').length / 2), 0)
            }
          });
        } catch (error) {
          // Durability on failure: keep the files that were already edited and
          // the assistant/tool messages that are already complete, so a dropped
          // model call cannot silently discard work the user saw in the diff.
          try {
            const repairedPartial = repairToolGroups(newMessages);
            if (repairedPartial.length) await appendMessages(env, conversation, repairedPartial);
            if (turn.touched.size) {
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
    { write: true, body: 1_400_000 }
  );
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return new Response(JSON.stringify({ error: 'متد پشتیبانی نمی‌شود.' }), {
    status: 405,
    headers: { Allow: 'POST', 'Content-Type': 'application/json' }
  });
}
