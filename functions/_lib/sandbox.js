// Real command execution — multi-tier and 100% honest about which tier ran.
//
// Execution tiers (highest priority first):
//   1. `env.SANDBOX` Durable Object (Cloudflare Container persistent Linux VM).
//   2. `env.SANDBOX_URL` custom remote runner webhook (JSON over HTTPS).
//   3. Isolated Podman Linux Container (`wandbox.org` real Linux OS container
//      with Bash 5.2, Node.js 20, Python 3.14, GCC 13, Go 1.23, Rust, SQLite,
//      OpenSSL, and GNU coreutils). Active automatically on Cloudflare Pages
//      (`env.CF_PAGES === '1'`) or when `env.LINUX_RUNNER === 'wandbox'`, unless
//      `env.LINUX_RUNNER === 'off'`.
//   4. In-memory virtual shell fallback (`mode: 'virtual'`), always labelled
//      explicitly so the model never mistakes virtual output for real OS output.

import { envSecrets, redactCode, redactSecrets } from './util.js';

const DEFAULT_TIMEOUT_MS = 22_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_MOUNT_FILES = 70;
const MAX_MOUNT_TOTAL_CHARS = 350_000;
const WANDBOX_ENDPOINT = 'https://wandbox.org/api/compile.json';

export function sandboxBinding(env) {
  const binding = env && env.SANDBOX;
  if (!binding) return null;
  if (typeof binding.fetch !== 'function' && typeof binding.idFromName !== 'function') return null;
  return binding;
}

export function sandboxEnabled(env) {
  return Boolean(sandboxBinding(env));
}

export function linuxRunnerEnabled(env) {
  if (!env || typeof env !== 'object') return false;
  const flag = String(env.LINUX_RUNNER || '').trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0' || flag === 'disabled') return false;
  if (flag === 'wandbox' || flag === 'on' || flag === 'true' || flag === '1') return true;
  if (env.SANDBOX_URL) return true;
  return Boolean(env.CF_PAGES);
}

export function realExecutionMode(env) {
  if (sandboxEnabled(env)) return 'sandbox';
  if (env?.SANDBOX_URL) return 'remote-sandbox';
  if (linuxRunnerEnabled(env)) return 'linux-container';
  return 'virtual';
}

/** Fast, conservative classification of a command before it reaches a runner. */
export function classifyCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { allowed: false, reason: 'دستور خالی است' };
  if (text.length > 8000) return { allowed: false, reason: 'دستور بیش از حد طولانی است' };

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

async function callCustomRunner(env, { cmd, files, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const endpoint = String(env?.SANDBOX_URL || '').trim();
  if (!endpoint) return null;
  const started = Date.now();
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (env.SANDBOX_TOKEN) headers.Authorization = `Bearer ${env.SANDBOX_TOKEN}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ cmd, cwd: '/workspace', timeoutMs, files })
    });
  } catch (error) {
    return { ok: false, unavailable: true, error: error?.message || 'remote runner unreachable' };
  }
  if (!response.ok) return { ok: false, unavailable: true, error: `Runner HTTP ${response.status}` };
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, unavailable: true, error: 'invalid JSON from remote runner' };
  }
  return {
    ok: Boolean(data.ok ?? data.exitCode === 0),
    exitCode: Number.isFinite(data.exitCode) ? data.exitCode : 0,
    stdout: clampOutput(data.stdout),
    stderr: clampOutput(data.stderr),
    durationMs: Number.isFinite(data.durationMs) ? data.durationMs : Date.now() - started
  };
}

function mountSafeFiles(rawFiles, secrets) {
  if (!rawFiles || typeof rawFiles !== 'object') return [];
  const entries = [];
  let totalChars = 0;
  for (const [path, rawContent] of Object.entries(rawFiles)) {
    if (entries.length >= MAX_MOUNT_FILES) break;
    if (typeof path !== 'string' || !path || path.length > 200) continue;
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) continue;
    if (path === 'prog.sh' || /^(\.env|\.dev\.vars|.*\.pem|.*\.key|id_rsa)/i.test(path)) continue;
    const clean = redactCode(String(rawContent ?? ''), secrets);
    if (totalChars + clean.length > MAX_MOUNT_TOTAL_CHARS) continue;
    totalChars += clean.length;
    entries.push({ file: path, code: clean });
  }
  return entries;
}

/**
 * Execute `cmd` inside a real isolated Linux container (Podman `wandbox-runner`
 * with workspace files mounted into the working directory).
 */
async function callLinuxContainer(env, { cmd, files, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const secrets = envSecrets(env || {});
  if (secrets.some((s) => s && cmd.includes(s))) {
    return { ok: false, unavailable: false, exitCode: 1, stdout: '', stderr: 'Blocked: command contains a server secret.' };
  }

  const codes = mountSafeFiles(files, secrets);
  // Wrap in `{ ... }` so GNU Bash parses the entire script into memory before
  // unlinking `./prog.sh`, and add the container's Node/Python/GCC/Go/Rust/SQLite
  // toolchains to PATH automatically.
  const wrappedScript = [
    '{',
    'for __cp_d in /opt/wandbox/nodejs-20*/bin /opt/wandbox/cpython-3.14*/bin /opt/wandbox/cpython-3.13*/bin /opt/wandbox/gcc-13*/bin /opt/wandbox/go-1.23*/bin /opt/wandbox/rust-1.7*/bin /opt/wandbox/sqlite-3*/bin; do',
    '  [ -d "$__cp_d" ] && PATH="$__cp_d:$PATH"',
    'done',
    'export PATH',
    'rm -f ./prog.sh 2>/dev/null || true',
    cmd,
    '}'
  ].join('\n');

  const endpoint = String(env?.WANDBOX_URL || WANDBOX_ENDPOINT).trim();
  const started = Date.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'CodePilot-LinuxRunner/2.2'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        compiler: 'bash',
        code: wrappedScript,
        codes,
        save: false
      })
    });
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : error?.message || 'network error'
    };
  }

  if (!response.ok) {
    await response.text().catch(() => '');
    return { ok: false, unavailable: true, error: `HTTP ${response.status}` };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, unavailable: true, error: 'invalid JSON' };
  }

  const hasStatus = data.status !== undefined && data.status !== null && String(data.status) !== '';
  const exitCode = hasStatus && Number.isFinite(Number(data.status)) ? Number(data.status) : data.signal ? 137 : 0;
  const signal = String(data.signal || '').trim();
  const stdout = clampOutput(redactSecrets(String(data.program_output || data.compiler_output || ''), secrets));
  const errParts = [data.compiler_error, data.program_error, signal ? `Signal: ${signal}` : '']
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const stderr = clampOutput(redactSecrets(errParts.join('\n'), secrets));

  return {
    ok: exitCode === 0 && !signal,
    unavailable: false,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started
  };
}

function clampOutput(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} کاراکتر دیگر بریده شد)`;
}

function formatRealResult(label, result) {
  const parts = [
    `${label} (exit ${result.exitCode}${result.durationMs ? `, ${result.durationMs}ms` : ''})`,
    result.stdout ? `stdout:\n${result.stdout}` : 'stdout: (empty)',
    result.stderr ? `stderr:\n${result.stderr}` : ''
  ].filter(Boolean);
  return parts.join('\n');
}

/**
 * Run a command for the agent or interactive terminal.
 * Returns { mode: 'sandbox'|'remote-sandbox'|'linux-container'|'virtual'|'blocked', ... }
 * and a `text` field that always states honestly which mode ran.
 */
export async function runCommand(env, { command, workspace }) {
  const verdict = classifyCommand(command);
  if (!verdict.allowed) {
    return {
      mode: 'blocked',
      ok: false,
      exitCode: 126,
      stdout: '',
      stderr: verdict.reason,
      text: `Command blocked: ${verdict.reason}. Nothing was executed.`
    };
  }

  const files = workspace?.files && typeof workspace.files === 'object' ? workspace.files : null;

  // Tier 1: Bound Cloudflare Container Durable Object
  if (sandboxEnabled(env)) {
    const result = await callSandbox(env, { cmd: command, files });
    if (result && !result.unavailable) {
      return {
        mode: 'sandbox',
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        text: formatRealResult('Real sandbox execution', result)
      };
    }
    if (!linuxRunnerEnabled(env)) {
      const fallback = virtualShell(workspace, command);
      return {
        mode: 'virtual',
        ok: false,
        exitCode: 1,
        stdout: fallback,
        stderr: result?.error || 'no response',
        text: [
          `Sandbox unavailable (${result?.error || 'no response'}).`,
          'Falling back to the VIRTUAL shell — this is NOT real execution.',
          fallback
        ].join('\n')
      };
    }
  }

  // Tier 2: Custom remote sandbox URL (if configured)
  if (env?.SANDBOX_URL) {
    const remote = await callCustomRunner(env, { cmd: command, files });
    if (remote && !remote.unavailable) {
      return {
        mode: 'remote-sandbox',
        ok: remote.ok,
        exitCode: remote.exitCode,
        stdout: remote.stdout,
        stderr: remote.stderr,
        durationMs: remote.durationMs,
        text: formatRealResult('Real remote Linux execution', remote)
      };
    }
  }

  // Tier 3: Isolated Podman Linux Container (Bash 5.2 + Node 20 + Python 3.14 + GCC + Go + Rust)
  if (linuxRunnerEnabled(env)) {
    const linux = await callLinuxContainer(env, { cmd: command, files });
    if (linux && !linux.unavailable) {
      return {
        mode: 'linux-container',
        ok: linux.ok,
        exitCode: linux.exitCode,
        stdout: linux.stdout,
        stderr: linux.stderr,
        durationMs: linux.durationMs,
        text: formatRealResult(
          'Real Linux OS container execution (isolated Podman container; workspace mounted read-copy)',
          linux
        )
      };
    }
    const fallback = virtualShell(workspace, command);
    return {
      mode: 'virtual',
      ok: false,
      exitCode: 1,
      stdout: fallback,
      stderr: linux?.error || 'no response',
      text: [
        `Linux container unavailable (${linux?.error || 'no response'}).`,
        'Falling back to the VIRTUAL shell — this is NOT real execution.',
        fallback
      ].join('\n')
    };
  }

  const vOut = virtualShell(workspace, command);
  return {
    mode: 'virtual',
    ok: true,
    exitCode: 0,
    stdout: vOut,
    stderr: '',
    text: ['Virtual shell (no real OS, no network, no subprocesses).', vOut].join('\n')
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
      if (!/^[\w./[\]-]{1,200}$/.test(arg) || arg.includes('..')) return 'touch: invalid path';
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
      if (!/^[\w./[\]-]{1,200}$/.test(path) || path.includes('..')) return 'echo: invalid path';
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
