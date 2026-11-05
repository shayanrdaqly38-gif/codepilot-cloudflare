// Real command execution — opt-in, and honest about its limits.
//
// Cloudflare Pages Functions cannot spawn processes. Real execution therefore
// lives in a Durable Object that wraps a Cloudflare Container (a real Linux
// sandbox). If that DO is not bound, `run_command` falls back to the virtual
// shell and says so explicitly: the model must never claim a command ran when
// only the virtual shell answered.
//
// Setup (optional, see SETUP.md):
//   wrangler.toml →
//     [[durable_objects.bindings]]
//     name = "SANDBOX"
//     class_name = "Sandbox"
//   plus a `[[containers]]` entry and the `Sandbox` export in the Worker.
//
// Protocol (both directions are JSON over HTTP):
//   POST /run  { cmd, cwd, timeoutMs, files } -> { ok, exitCode, stdout, stderr }
//   The container image mounts `files` into /workspace when provided.

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;

export function sandboxBinding(env) {
  const binding = env && env.SANDBOX;
  if (!binding) return null;
  if (typeof binding.fetch !== 'function' && typeof binding.idFromName !== 'function') return null;
  return binding;
}

export function sandboxEnabled(env) {
  return Boolean(sandboxBinding(env));
}

/** Fast, conservative classification of a command before it reaches a sandbox. */
export function classifyCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { allowed: false, reason: 'دستور خالی است' };
  if (text.length > 800) return { allowed: false, reason: 'دستور بیش از حد طولانی است' };

  const denied = [
    /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/,       // rm -rf /
    /\bmkfs\b/,
    /\bdd\s+.*of=\/dev\//,
    /:\(\)\s*\{.*\};\s*:/,                    // fork bomb
    /\bshutdown\b|\breboot\b|\bpoweroff\b/,
    /\bcurl\b.*\|\s*(ba)?sh/,                 // curl | sh
    /\bwget\b.*\|\s*(ba)?sh/,
    /\bchmod\s+(-R\s+)?777\s+\//,
    /\bnpm\s+publish\b/,
    /\bgit\s+push\s+--force/,
    />\s*\/etc\//,
    /\bssh-keygen\b.*-f\s*\//
  ];
  for (const pattern of denied) {
    if (pattern.test(text)) return { allowed: false, reason: 'این دستور در محیط اجرا مسدود است' };
  }
  return { allowed: true };
}

async function callSandbox(env, { cmd, cwd = '/workspace', timeoutMs = DEFAULT_TIMEOUT_MS, files = null }) {
  const binding = sandboxBinding(env);
  if (!binding) return null;

  let target;
  try {
    if (typeof binding.get === 'function' && typeof binding.idFromName === 'function') {
      // DurableObjectNamespace
      target = binding.get(binding.idFromName('codepilot-sandbox'));
    } else {
      target = binding;
    }
  } catch {
    return { ok: false, unavailable: true, error: 'اتصال به Sandbox برقرار نشد' };
  }

  const url = 'https://sandbox.internal/run';
  const body = JSON.stringify({ cmd, cwd, timeoutMs, files });
  const response = await target
    .fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
    )
    .catch(() => null);

  if (!response) return { ok: false, unavailable: true, error: 'Sandbox پاسخ نداد' };
  if (!response.ok) return { ok: false, unavailable: false, error: `Sandbox ${response.status}` };

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, unavailable: false, error: 'پاسخ Sandbox قابل خواندن نبود' };
  }
  return {
    ok: Boolean(data.ok),
    exitCode: Number.isFinite(data.exitCode) ? data.exitCode : 0,
    stdout: clampOutput(data.stdout),
    stderr: clampOutput(data.stderr),
    durationMs: Number.isFinite(data.durationMs) ? data.durationMs : null
  };
}

function clampOutput(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} کاراکتر دیگر بریده شد)`;
}

/**
 * Run a command for the agent.
 * Returns { mode: 'sandbox'|'virtual'|'blocked', ... } and a `text` field that is
 * what the model receives — it always states which mode ran.
 */
export async function runCommand(env, { command, workspace }) {
  const verdict = classifyCommand(command);
  if (!verdict.allowed) {
    return {
      mode: 'blocked',
      ok: false,
      text: `Command blocked: ${verdict.reason}. Nothing was executed.`
    };
  }

  const files = workspace?.files && typeof workspace.files === 'object' ? workspace.files : null;
  if (sandboxEnabled(env)) {
    const result = await callSandbox(env, { cmd: command, files });
    if (result && !result.unavailable) {
      const parts = [
        `Real sandbox execution (exit ${result.exitCode}${result.durationMs ? `, ${result.durationMs}ms` : ''})`,
        result.stdout ? `stdout:\n${result.stdout}` : 'stdout: (empty)',
        result.stderr ? `stderr:\n${result.stderr}` : ''
      ].filter(Boolean);
      return { mode: 'sandbox', ok: result.ok, exitCode: result.exitCode, text: parts.join('\n') };
    }
    // Bound but unreachable: be explicit rather than silently faking success.
    const fallback = virtualShell(workspace, command);
    return {
      mode: 'virtual',
      ok: false,
      text: [
        `Sandbox unavailable (${result?.error || 'no response'}).`,
        'Falling back to the VIRTUAL shell — this is NOT real execution.',
        fallback
      ].join('\n')
    };
  }

  return {
    mode: 'virtual',
    ok: true,
    text: ['Virtual shell (no real OS, no network, no subprocesses).', virtualShell(workspace, command)].join('\n')
  };
}

/* ------------------------------ virtual shell ----------------------------- */

/** The in-D1 workspace shell. Pure apart from mutating `workspace.files`. */
export function virtualShell(workspace, rawCommand) {
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
        '  help, pwd, ls, cat <file>, touch <file>, echo <text> > <file>, rm <file>, clear, preview',
        'There is no network, no OS access and no real subprocess here.'
      ].join('\n');
    case 'pwd':
      return '/workspace/project';
    case 'ls':
      return Object.keys(files).sort().join('  ') || '(empty)';
    case 'cat':
      return files[arg] === undefined ? `cat: file not found: ${arg}` : String(files[arg]);
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
