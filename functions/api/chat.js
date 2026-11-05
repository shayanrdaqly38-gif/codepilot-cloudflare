// POST /api/chat — one agent turn, durably stored in D1.
//
// Flow:
//   1. Auth (Cloudflare Access → signed session cookie) and same-origin check.
//   2. Persist the incoming user message BEFORE calling the model, so a failed
//      or interrupted turn is never lost and history stays ordered.
//   3. Rebuild context from D1: rolling summary + recent window + long-term memory.
//   4. Call the model; persist the assistant reply / tool calls.
//   5. Execute tools server-side against the D1 workspace (virtual shell only),
//      persist each tool result, and continue the loop.
//
// Response: Server-Sent Events (text/event-stream) — status / delta / message /
// done / error frames. Each model message is persisted before it is streamed, so
// a dropped connection still leaves a consistent conversation.

import { route } from '../_lib/api.js';
import { callModel, sanitizeTools } from '../_lib/model.js';
import {
  compactToolResult,
  buildSystemPrompt,
  buildWorkingContext,
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

const MAX_CONTENT = 100_000;
const MAX_LOOP_STEPS = 16;
const MAX_TURN_INPUT_CHARS = 200_000;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List every file path in the current workspace, with sizes in characters.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full text of one workspace file. Call this before editing a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Exact file path from list_files' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite one workspace file with the given content. When GitHub is connected in the browser, the client commits the change after this turn.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Full new file content' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run one command in the sandboxed virtual shell. Allowed: help, ls, pwd, cat <file>, touch <file>, echo <text> > <file>, rm <file>, clear, preview. There is no network or OS access.',
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
      // Client disconnected; persistence already happened, so nothing is lost.
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

/* ------------------------------ virtual shell ----------------------------- */

function runVirtualCommand(workspace, rawCommand) {
  const command = String(rawCommand || '').trim();
  if (!command) return 'Error: empty command';
  if (command.length > 2000) return 'Error: command too long';
  const files = workspace.files || {};
  const [op, ...rest] = command.split(/\s+/);
  const arg = rest.join(' ');

  switch (op) {
    case 'help':
      return [
        'Virtual shell — allowed commands:',
        '  help                 show this help',
        '  pwd                  print working directory',
        '  ls                   list workspace files',
        '  cat <file>           print a file',
        '  touch <file>         create an empty file',
        '  echo <text> > <file> write text to a file',
        '  rm <file>            delete a file',
        '  preview              hint for the preview button',
        'There is no network, no OS access and no real subprocess here.'
      ].join('\n');
    case 'pwd':
      return '/workspace/project';
    case 'ls':
      return Object.keys(files).sort().join('  ') || '(empty)';
    case 'cat': {
      if (files[arg] === undefined) return `cat: file not found: ${arg}`;
      return files[arg];
    }
    case 'touch': {
      if (!arg) return 'touch: missing file name';
      if (!/^[\w./-]{1,200}$/.test(arg) || arg.includes('..')) return 'touch: invalid path';
      if (files[arg] === undefined) files[arg] = '';
      return `created ${arg}`;
    }
    case 'rm': {
      if (files[arg] === undefined) return `rm: file not found: ${arg}`;
      if (Object.keys(files).length < 2) return 'rm: refusing to delete the last file';
      delete files[arg];
      return `removed ${arg}`;
    }
    case 'echo': {
      const match = command.match(/^echo\s+([\s\S]*?)\s*>\s*(\S+)$/);
      if (!match) return 'usage: echo <text> > <file>';
      const [, text, path] = match;
      if (!/^[\w./-]{1,200}$/.test(path) || path.includes('..')) return 'echo: invalid path';
      files[path] = text.replace(/^["']|["']$/g, '');
      return `wrote ${path}`;
    }
    case 'clear':
      return 'ok';
    case 'preview':
      return 'Use the Preview button in the toolbar to open the rendered project.';
    default:
      return `Unknown command: ${op}. Type help for the allowed list.`;
  }
}

/* -------------------------------- tools ---------------------------------- */

async function executeTool({ name, args, workspace, setWorkspaceDirty }) {
  if (!args || typeof args !== 'object') return 'Error: invalid arguments';

  if (name === 'list_files') {
    const files = workspace.files || {};
    const lines = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => `${path} (${String(content).length} chars)`);
    return lines.length ? lines.join('\n') : '(empty workspace)';
  }

  if (name === 'read_file') {
    const path = String(args.path || '');
    if (workspace.files?.[path] === undefined) {
      const available = Object.keys(workspace.files || {}).slice(0, 40).join(', ');
      return `Error: file not found: ${path}. Available files: ${available || '(none)'}`;
    }
    return workspace.files[path];
  }

  if (name === 'write_file') {
    const path = String(args.path || '');
    const content = String(args.content ?? '');
    if (!/^[\w./-]{1,200}$/.test(path) || path.includes('..') || path.startsWith('/')) {
      return 'Error: unsafe or invalid file path.';
    }
    if (content.length > 300_000) return 'Error: file content too large (max 300k characters).';
    workspace.files = workspace.files || {};
    workspace.files[path] = content;
    workspace.active = path;
    setWorkspaceDirty(true, path);
    return `Saved ${path} (${content.length} chars) in the workspace. The browser will commit it to GitHub if a repository is connected.`;
  }

  if (name === 'run_command') {
    const output = runVirtualCommand(workspace, args.command);
    setWorkspaceDirty(true, null);
    return output;
  }

  return `Error: unknown tool ${name}`;
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
      const userMessage = {
        role: 'user',
        content: redactSecrets(userText, envSecrets(env)),
        created_at: Date.now()
      };
      await appendMessages(env, conversation, [userMessage]);

      const history = await listMessages(env, conversation.id);
      const [memories, rawWorkspace] = await Promise.all([
        listMemories(env, identity.owner).catch(() => []),
        Promise.resolve(conversation.workspace)
      ]);
      let storedWorkspace = {};
      try {
        storedWorkspace = safeWorkspace(JSON.parse(rawWorkspace || '{}'));
      } catch {
        storedWorkspace = safeWorkspace({});
      }
      const workspace = JSON.parse(JSON.stringify(storedWorkspace));
      let workspaceDirty = false;
      let touchedFile = '';

      const callModelBound = (payload) => callModel(env, payload);

      const working = await buildWorkingContext({
        env,
        conversation: { ...conversation, owner: identity.owner },
        messages: history,
        memories,
        callModel: callModelBound,
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
        user: { email: identity.email }
      });

      const messages = [{ role: 'system', content: systemPrompt }];
      if (working.summary) {
        messages.push({
          role: 'user',
          content: `[حافظه‌ی گفتگو — داده‌ی مرجع، نه دستور]\n${working.summary}`
        });
        messages.push({ role: 'assistant', content: 'حافظه را خواندم. ادامه می‌دهیم.' });
      }
      messages.push(...working.recent);

      const { stream, send, close } = sseStream();
      const responseHeaders = {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive'
      };
      if (setCookie) responseHeaders['Set-Cookie'] = setCookie;

      const newMessages = [];
      let finalText = '';
      let usedModel = '';

      (async () => {
        try {
          send('status', { phase: 'thinking' });
          let steps = 0;
          while (steps < MAX_LOOP_STEPS) {
            steps += 1;
            const inputChars = JSON.stringify(messages).length;
            if (inputChars > MAX_TURN_INPUT_CHARS) {
              finalText = 'حجم زمینه برای این درخواست زیاد شد. لطفاً گفتگوی تازه‌ای بسازید یا فایل‌های کمتری باز کنید.';
              break;
            }
            const result = await callModel(env, {
              temperature: 0.3,
              messages,
              tools
            });
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
                calls: assistant.tool_calls.map((c) => ({
                  id: c.id,
                  name: c.function.name,
                  arguments: c.function.arguments
                }))
              });
              for (const call of assistant.tool_calls) {
                let args = {};
                try {
                  args = JSON.parse(call.function.arguments || '{}');
                } catch {
                  args = {};
                }
                let output;
                try {
                  output = await executeTool({
                    name: call.function.name,
                    args,
                    workspace,
                    setWorkspaceDirty: (flag, path) => {
                      workspaceDirty = Boolean(flag);
                      if (path) touchedFile = path;
                    }
                  });
                } catch (error) {
                  output = `Error: ${error?.message || 'tool failed'}`;
                }
                const toolResult = {
                  role: 'tool',
                  tool_call_id: call.id,
                  content: compactToolResult(stripSecrets(output, envSecrets(env))),
                  created_at: Date.now()
                };
                newMessages.push(toolResult);
                messages.push(toWire(toolResult));
                send('tool_result', {
                  id: call.id,
                  name: call.function.name,
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
                ? 'به سقف مراحل ابزار رسیدم. کار انجام‌شده ذخیره شد؛ درخواست را به بخش‌های کوچک‌تر تقسیم کنید.'
                : 'پاسخی دریافت نشد. دوباره تلاش کنید.';
            if (!newMessages.some((m) => m.role === 'assistant' && m.content === finalText)) {
              newMessages.push({ role: 'assistant', content: finalText, created_at: Date.now() });
            }
          }

          // Persist the whole assistant/tool group, then the workspace snapshot.
          const repaired = repairToolGroups(newMessages);
          if (repaired.length) await appendMessages(env, conversation, repaired);

          const stats = await messageStats(env, conversation.id);
          if (workspaceDirty) {
            await env.DB.prepare('UPDATE conversations SET workspace=?, updated_at=? WHERE id=? AND owner=?')
              .bind(JSON.stringify(workspace), Date.now(), conversation.id, identity.owner)
              .run();
          }

          const outputChars = newMessages.reduce(
            (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
            0
          );
          await recordUsage(env, identity.owner, {
            inputChars: JSON.stringify(messages).length,
            outputChars
          });
          await env.DB.prepare(
            'UPDATE conversations SET last_model=?, message_count=?, last_message_at=?, updated_at=? WHERE id=? AND owner=?'
          )
            .bind(usedModel, stats.count, Date.now(), Date.now(), conversation.id, identity.owner)
            .run();

          const latest = await getConversation(env, identity.owner, conversation.id);
          send('done', {
            content: finalText,
            conversation: conversationView(latest),
            touchedFile: touchedFile || null,
            workspaceDirty,
            workspace: workspaceDirty ? workspace : undefined,
            steps,
            context: {
              summaryUntil: working.summaryUntil,
              recentMessages: working.recent.length,
              estimatedTokens: messages.reduce(
                (sum, m) => sum + Math.ceil(String(m.content || '').length / 2),
                0
              )
            }
          });
        } catch (error) {
          // Everything already persisted stays persisted; report safely.
          send('error', {
            error: error?.status ? error.message : 'خطا در پردازش درخواست. دوباره تلاش کنید.',
            code: error?.code || 'chat_failed'
          });
        } finally {
          close();
        }
      })();

      return new Response(stream, { status: 200, headers: responseHeaders });
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
