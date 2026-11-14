// Real command execution — multi-tier, async-job capable, paginated, and 100% honest about which tier ran.
//
// Execution tiers (highest priority first):
//   1. `env.SANDBOX` Durable Object (Cloudflare Container persistent Linux VM — external binding).
//   2. `env.SANDBOX_URL` custom remote runner (`runner-kit/server.mjs` over HTTPS — supports full
//      async `/jobs` lifecycle: start, paginated status/output, safe process-group cancel, list).
//   3. Isolated Podman Linux Container (`wandbox.org` stateless single-shot Linux container).
//   4. In-memory virtual shell fallback (`mode: 'virtual'`), always labelled explicitly.

import { clamp, envSecrets, redactCode, redactSecrets } from './util.js';

const DEFAULT_TIMEOUT_MS = 85_000;
const DEFAULT_OUTPUT_CHARS = 32_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_MOUNT_FILES = 70;
const MAX_MOUNT_TOTAL_CHARS = 350_000;
const MAX_REMOTE_MOUNT_FILES = 250;
const MAX_REMOTE_MOUNT_TOTAL_CHARS = 4_000_000;
const WANDBOX_ENDPOINT = 'https://wandbox.org/api/compile.json';

function mergeTimeoutSignal(timeoutMs, externalSignal) {
  if (!externalSignal) return AbortSignal.timeout(timeoutMs);
  if (externalSignal.aborted) return externalSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), externalSignal]);
  }
  return AbortSignal.timeout(timeoutMs);
}

function isCancelled(externalSignal) {
  return Boolean(externalSignal?.aborted);
}

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

/** Validate `cwd` so commands cannot escape the workspace root. */
export function validateCommandCwd(rawCwd) {
  if (rawCwd === undefined || rawCwd === null || rawCwd === '') {
    return { ok: true, cwd: '/workspace', rel: '' };
  }
  const value = String(rawCwd).trim();
  if (!value || value === '.' || value === '/workspace' || value === '/workspace/') {
    return { ok: true, cwd: '/workspace', rel: '' };
  }
  if (value.length > 220 || value.includes('\0') || value.includes('\\')) {
    return { ok: false, reason: 'مسیر اجرای دستور (cwd) کاراکتر نامعتبر دارد.' };
  }
  let rel = value;
  if (rel.startsWith('/workspace/')) {
    rel = rel.slice('/workspace/'.length);
  } else if (rel.startsWith('/')) {
    return { ok: false, reason: 'مسیر مطلق cwd خارج از /workspace مجاز نیست.' };
  }
  rel = rel.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return { ok: true, cwd: '/workspace', rel: '' };
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    return { ok: false, reason: 'پیمایش مسیر (..) در cwd مجاز نیست.' };
  }
  if (!/^[\w./[\]-]{1,220}$/.test(rel)) {
    return { ok: false, reason: 'مسیر cwd دارای کاراکترهای غیرمجاز است.' };
  }
  return { ok: true, cwd: `/workspace/${rel}`, rel };
}

/** Fast, conservative classification of a command before it reaches a runner. */
export function classifyCommand(command) {
  const text = String(command || '').trim();
  if (!text) return { allowed: false, reason: 'دستور خالی است' };
  if (text.length > 32_000) return { allowed: false, reason: 'دستور بیش از حد طولانی است' };

  // Block ONLY genuinely catastrophic host-destroying patterns; leave normal
  // developer workflows (git, npm, python, docker, build/test scripts) unrestricted.
  const denied = [
    /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/,       // rm -rf /
    /\bmkfs\b/,
    /\bdd\s+.*of=\/dev\//,
    /:\(\)\s*\{.*\};\s*:/,                    // fork bomb
    /\bshutdown\b|\breboot\b|\bpoweroff\b/,
    /\bcurl\b.*\|\s*(ba)?sh/,                 // curl | sh
    /\bwget\b.*\|\s*(ba)?sh/,
    /\bchmod\s+(-R\s+)?777\s+\//,
    />\s*\/etc\//,
    /\bssh-keygen\b.*-f\s*\//
  ];
  for (const pattern of denied) {
    if (pattern.test(text)) return { allowed: false, reason: 'این دستور در محیط اجرا مسدود است' };
  }
  return { allowed: true };
}

/** Paginate and bound command output with explicit truncation metadata. */
export function paginateOutput(value, { offset = 0, limit = MAX_OUTPUT_CHARS } = {}) {
  const text = String(value ?? '');
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const safeLimit = clamp(Math.floor(Number(limit) || MAX_OUTPUT_CHARS), 256, MAX_OUTPUT_CHARS);
  const totalChars = text.length;
  if (safeOffset >= totalChars) {
    return {
      chunk: '',
      offset: safeOffset,
      nextOffset: totalChars,
      totalChars,
      hasMore: false,
      truncated: false,
      remainingChars: 0
    };
  }
  const chunk = text.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + chunk.length;
  const remainingChars = Math.max(0, totalChars - nextOffset);
  const hasMore = remainingChars > 0;
  return {
    chunk,
    offset: safeOffset,
    nextOffset,
    totalChars,
    hasMore,
    truncated: hasMore,
    remainingChars
  };
}

function runnerBaseUrl(env) {
  const endpoint = String(env?.SANDBOX_URL || '').trim().replace(/\/+$/, '');
  if (!endpoint) return '';
  return endpoint.endsWith('/run') ? endpoint.slice(0, -4) : endpoint;
}

function runnerHeaders(env, hasJsonBody = false) {
  const headers = { Accept: 'application/json' };
  if (hasJsonBody) headers['Content-Type'] = 'application/json';
  if (env?.SANDBOX_TOKEN) headers.Authorization = `Bearer ${env.SANDBOX_TOKEN}`;
  return headers;
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
  const secrets = envSecrets(env || {});
  const rawStdout = redactSecrets(String(data.stdout ?? ''), secrets);
  const rawStderr = redactSecrets(String(data.stderr ?? ''), secrets);
  const outPage = paginateOutput(rawStdout);
  const errPage = paginateOutput(rawStderr);
  return {
    ok: Boolean(data.ok),
    exitCode: Number.isFinite(data.exitCode) ? data.exitCode : 0,
    stdout: outPage.chunk,
    stderr: errPage.chunk,
    stdoutTruncated: outPage.truncated,
    stderrTruncated: errPage.truncated,
    totalStdoutChars: outPage.totalChars,
    totalStderrChars: errPage.totalChars,
    durationMs: Number.isFinite(data.durationMs) ? data.durationMs : null
  };
}

function sanitizeFilesMapForRunner(rawFiles, secrets) {
  if (!rawFiles || typeof rawFiles !== 'object') return null;
  const out = {};
  let count = 0;
  let totalChars = 0;
  for (const [path, rawContent] of Object.entries(rawFiles)) {
    if (count >= MAX_REMOTE_MOUNT_FILES) break;
    if (typeof path !== 'string' || !path || path.length > 200) continue;
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) continue;
    if (/^(\.env|\.dev\.vars|.*\.pem|.*\.key|id_rsa)/i.test(path)) continue;
    const clean = redactCode(String(rawContent ?? ''), secrets);
    if (totalChars + clean.length > MAX_REMOTE_MOUNT_TOTAL_CHARS) continue;
    totalChars += clean.length;
    count += 1;
    out[path] = clean;
  }
  return out;
}

export function applyRunnerFileChanges(workspace, payload = {}, secrets = []) {
  const touchedFiles = [];
  const deletedFiles = [];
  if (!workspace || typeof workspace !== 'object') return { touchedFiles, deletedFiles };
  if (!workspace.files || typeof workspace.files !== 'object') workspace.files = {};

  if (payload?.changedFiles && typeof payload.changedFiles === 'object') {
    let syncedCount = 0;
    for (const [rel, rawContent] of Object.entries(payload.changedFiles)) {
      if (syncedCount >= MAX_REMOTE_MOUNT_FILES) break;
      if (typeof rel !== 'string' || !rel || rel.length > 200) continue;
      if (rel.startsWith('/') || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) continue;
      if (!/^[\w./[\]-]{1,200}$/.test(rel)) continue;
      if (/^(\.env|\.dev\.vars|.*\.pem|.*\.key|id_rsa)/i.test(rel)) continue;
      const clean = redactSecrets(String(rawContent ?? '').slice(0, 4_000_000), secrets);
      if (workspace.files[rel] !== clean) {
        workspace.files[rel] = clean;
        touchedFiles.push(rel);
        syncedCount += 1;
      }
    }
  }

  if (Array.isArray(payload?.deletedFiles)) {
    for (const rel of payload.deletedFiles.slice(0, MAX_REMOTE_MOUNT_FILES)) {
      if (typeof rel !== 'string' || !rel || rel.length > 200) continue;
      if (workspace.files[rel] !== undefined) {
        delete workspace.files[rel];
        deletedFiles.push(rel);
      }
    }
  }

  return { touchedFiles, deletedFiles };
}

async function callCustomRunner(
  env,
  {
    cmd,
    cwd = '/workspace',
    files,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitMs = undefined,
    asyncMode = false,
    offset = 0,
    limit = MAX_OUTPUT_CHARS,
    stream = 'combined',
    externalSignal = null,
    session = ''
  }
) {
  const endpoint = String(env?.SANDBOX_URL || '').trim();
  if (!endpoint) return null;
  const secrets = envSecrets(env || {});
  if (secrets.some((s) => s && cmd.includes(s))) {
    return { ok: false, unavailable: false, exitCode: 1, stdout: '', stderr: 'Blocked: command contains a server secret.' };
  }
  const safeFiles = sanitizeFilesMapForRunner(files, secrets);
  const started = Date.now();
  const targetUrl = asyncMode ? `${runnerBaseUrl(env)}/jobs` : endpoint;
  const requestTimeout = asyncMode
    ? Math.min(Math.max((Number(waitMs) || 0) + 15_000, 15_000), 60_000)
    : Math.min(timeoutMs + 10_000, 315_000);

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: runnerHeaders(env, true),
      redirect: 'manual',
      signal: mergeTimeoutSignal(requestTimeout, externalSignal),
      body: JSON.stringify({
        cmd,
        cwd,
        timeoutMs,
        ...(Number.isFinite(Number(waitMs)) ? { waitMs: Number(waitMs) } : {}),
        ...(asyncMode ? { async: true } : {}),
        offset: Math.max(0, Math.floor(Number(offset) || 0)),
        limit: clamp(Number(limit) || MAX_OUTPUT_CHARS, 256, MAX_OUTPUT_CHARS),
        stream,
        files: safeFiles,
        session
      })
    });
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      error: redactSecrets(error?.message || 'remote runner unreachable', secrets)
    };
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let errMsg = `Runner HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error) errMsg = String(parsed.error);
    } catch { /* ignore */ }
    return {
      ok: false,
      unavailable: response.status >= 500 || response.status === 404,
      status: response.status,
      error: redactSecrets(errMsg, secrets)
    };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, unavailable: true, error: 'invalid JSON from remote runner' };
  }

  const rawStdout = redactSecrets(String(data.stdout ?? ''), secrets);
  const rawStderr = redactSecrets(String(data.stderr ?? ''), secrets);
  const outPage = paginateOutput(rawStdout, { offset: 0, limit });
  const errPage = paginateOutput(rawStderr, { offset: 0, limit });

  return {
    ok: Boolean(data.ok ?? data.exitCode === 0),
    runner: typeof data.runner === 'string' ? data.runner : 'remote',
    jobId: typeof data.jobId === 'string' ? data.jobId : null,
    status: typeof data.status === 'string' ? data.status : data.exitCode === 0 ? 'completed' : 'failed',
    running: Boolean(data.running || data.status === 'running'),
    promoted: Boolean(data.promoted),
    timedOut: Boolean(data.timedOut),
    cancelled: Boolean(data.cancelled),
    exitCode: data.exitCode === null ? null : Number.isFinite(Number(data.exitCode)) ? Number(data.exitCode) : 0,
    signal: data.signal || null,
    error: data.error ? redactSecrets(String(data.error), secrets) : null,
    stdout: outPage.chunk,
    stderr: errPage.chunk,
    output: data.output !== undefined ? redactSecrets(String(data.output), secrets) : undefined,
    stream: data.stream || stream,
    offset: Number.isFinite(Number(data.offset)) ? Number(data.offset) : 0,
    nextOffset: Number.isFinite(Number(data.nextOffset)) ? Number(data.nextOffset) : outPage.nextOffset,
    hasMore: Boolean(data.hasMore || data.stdoutHasMore || outPage.hasMore),
    stdoutTruncated: Boolean(data.stdoutTruncated || outPage.truncated),
    stderrTruncated: Boolean(data.stderrTruncated || errPage.truncated),
    truncated: Boolean(data.truncated || data.stdoutTruncated || data.stderrTruncated || outPage.truncated || errPage.truncated),
    totalStdoutChars: Number.isFinite(Number(data.totalStdoutBytes)) ? Number(data.totalStdoutBytes) : outPage.totalChars,
    totalStderrChars: Number.isFinite(Number(data.totalStderrBytes)) ? Number(data.totalStderrBytes) : errPage.totalChars,
    durationMs: Number.isFinite(Number(data.durationMs)) ? Number(data.durationMs) : Date.now() - started,
    persistence: data.persistence && typeof data.persistence === 'object' ? data.persistence : null,
    changedFiles: data.changedFiles && typeof data.changedFiles === 'object' ? data.changedFiles : null,
    deletedFiles: Array.isArray(data.deletedFiles) ? data.deletedFiles : null
  };
}

/** Query status & paginated output of an async remote runner job. */
export async function getCommandJob(
  env,
  { jobId, stream = 'combined', offset = 0, limit = 16_000, session = '', workspace = null, externalSignal = null } = {}
) {
  if (isCancelled(externalSignal)) {
    return { mode: 'stopped', ok: false, exitCode: 130, text: 'Cancelled by user.' };
  }
  const cleanId = String(jobId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(cleanId)) {
    return { mode: 'error', ok: false, error: 'شناسه job معتبر نیست.', text: 'Error: invalid jobId.' };
  }
  const base = runnerBaseUrl(env);
  if (!base) {
    return {
      mode: realExecutionMode(env),
      ok: false,
      unsupported: true,
      text: 'Async job status is unavailable: no stateful runner (`SANDBOX_URL`) is configured. Wandbox and the virtual shell are single-shot stateless runtimes.'
    };
  }
  const secrets = envSecrets(env || {});
  const safeStream = stream === 'stdout' || stream === 'stderr' ? stream : 'combined';
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const safeLimit = clamp(Number(limit) || 16_000, 256, MAX_OUTPUT_CHARS);
  const qs = new URLSearchParams({
    stream: safeStream,
    offset: String(safeOffset),
    limit: String(safeLimit),
    both: '1',
    ...(session ? { session } : {})
  });

  let response;
  try {
    response = await fetch(`${base}/jobs/${encodeURIComponent(cleanId)}?${qs.toString()}`, {
      method: 'GET',
      headers: runnerHeaders(env, false),
      redirect: 'manual',
      signal: mergeTimeoutSignal(15_000, externalSignal)
    });
  } catch (err) {
    return {
      mode: 'remote-sandbox',
      ok: false,
      error: redactSecrets(err?.message || 'runner unreachable', secrets),
      text: `Error polling job ${cleanId}: ${redactSecrets(err?.message || 'runner unreachable', secrets)}`
    };
  }
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let msg = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error) msg = String(parsed.error);
    } catch { /* ignore */ }
    return {
      mode: 'remote-sandbox',
      ok: false,
      status: response.status,
      error: redactSecrets(msg, secrets),
      text: `Job ${cleanId} lookup failed (${redactSecrets(msg, secrets)}).`
    };
  }

  const data = await response.json();
  const syncInfo = !data.running && workspace ? applyRunnerFileChanges(workspace, data, secrets) : { touchedFiles: [], deletedFiles: [] };
  const chunk = redactSecrets(String(data.output ?? ''), secrets);
  const payload = {
    mode: 'remote-sandbox',
    runner: data.runner || 'remote',
    ok: Boolean(data.ok),
    jobId: data.jobId || cleanId,
    status: data.status || 'unknown',
    running: Boolean(data.running),
    exitCode: data.exitCode,
    signal: data.signal || null,
    timedOut: Boolean(data.timedOut),
    cancelled: Boolean(data.cancelled),
    error: data.error ? redactSecrets(String(data.error), secrets) : null,
    durationMs: data.durationMs ?? null,
    stream: safeStream,
    offset: Number(data.offset ?? safeOffset),
    nextOffset: Number(data.nextOffset ?? safeOffset),
    totalBytes: Number(data.totalBytes ?? 0),
    hasMore: Boolean(data.hasMore),
    truncated: Boolean(data.truncated),
    output: chunk,
    stdout: redactSecrets(String(data.stdout ?? ''), secrets),
    stderr: redactSecrets(String(data.stderr ?? ''), secrets),
    stdoutTruncated: Boolean(data.stdoutTruncated),
    stderrTruncated: Boolean(data.stderrTruncated),
    persistence: data.persistence || null,
    touchedFiles: syncInfo.touchedFiles,
    deletedFiles: syncInfo.deletedFiles
  };
  payload.text = formatJobResult(payload);
  return payload;
}

/** Safely cancel a running async remote runner job (kills entire process group). */
export async function cancelCommandJob(env, { jobId, session = '', externalSignal = null } = {}) {
  if (isCancelled(externalSignal)) {
    return { mode: 'stopped', ok: false, exitCode: 130, text: 'Cancelled by user.' };
  }
  const cleanId = String(jobId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(cleanId)) {
    return { mode: 'error', ok: false, error: 'شناسه job معتبر نیست.', text: 'Error: invalid jobId.' };
  }
  const base = runnerBaseUrl(env);
  if (!base) {
    return {
      mode: realExecutionMode(env),
      ok: false,
      unsupported: true,
      text: 'Async job cancellation is unavailable: no stateful runner (`SANDBOX_URL`) is configured.'
    };
  }
  const secrets = envSecrets(env || {});
  try {
    const res = await fetch(`${base}/jobs/${encodeURIComponent(cleanId)}/cancel`, {
      method: 'POST',
      headers: runnerHeaders(env, true),
      redirect: 'manual',
      signal: mergeTimeoutSignal(12_000, externalSignal),
      body: JSON.stringify({ session })
    });
    if (!res.ok) {
      return { mode: 'remote-sandbox', ok: false, text: `Cancel failed for job ${cleanId} (HTTP ${res.status}).` };
    }
    const data = await res.json();
    const out = {
      mode: 'remote-sandbox',
      runner: data.runner || 'remote',
      ok: true,
      jobId: data.jobId || cleanId,
      status: data.status || 'cancelled',
      running: Boolean(data.running),
      cancelled: Boolean(data.cancelled),
      exitCode: data.exitCode ?? 130,
      durationMs: data.durationMs ?? null,
      output: redactSecrets(String(data.output ?? ''), secrets),
      persistence: data.persistence || null
    };
    out.text = formatJobResult(out);
    return out;
  } catch (err) {
    return {
      mode: 'remote-sandbox',
      ok: false,
      text: `Cancel failed for job ${cleanId}: ${redactSecrets(err?.message || 'network error', secrets)}`
    };
  }
}

/** List jobs on the remote runner. */
export async function listCommandJobs(env, { session = '', externalSignal = null } = {}) {
  if (isCancelled(externalSignal)) {
    return { mode: 'stopped', ok: false, jobs: [], text: 'Cancelled by user.' };
  }
  const base = runnerBaseUrl(env);
  if (!base) {
    return {
      mode: realExecutionMode(env),
      ok: false,
      unsupported: true,
      jobs: [],
      text: 'Job listing is unavailable: no stateful runner (`SANDBOX_URL`) is configured.'
    };
  }
  const secrets = envSecrets(env || {});
  const qs = session ? `?session=${encodeURIComponent(session)}` : '';
  try {
    const res = await fetch(`${base}/jobs${qs}`, {
      method: 'GET',
      headers: runnerHeaders(env, false),
      redirect: 'manual',
      signal: mergeTimeoutSignal(10_000, externalSignal)
    });
    if (!res.ok) {
      return { mode: 'remote-sandbox', ok: false, jobs: [], text: `Job list failed (HTTP ${res.status}).` };
    }
    const data = await res.json();
    const list = Array.isArray(data.jobs) ? data.jobs : [];
    const lines = list.length
      ? list.map(
          (j) =>
            `${j.jobId} · ${j.status}${j.exitCode !== null && j.exitCode !== undefined ? ` (exit ${j.exitCode})` : ''} · ${j.durationMs ?? 0}ms · ${redactSecrets(j.cmdPreview || '', secrets)}`
        )
      : ['(no jobs recorded)'];
    return {
      mode: 'remote-sandbox',
      ok: true,
      jobs: list,
      persistence: data.persistence || null,
      text: `Runner jobs (${list.length}):\n${lines.join('\n')}`
    };
  } catch (err) {
    return {
      mode: 'remote-sandbox',
      ok: false,
      jobs: [],
      text: `Job list failed: ${redactSecrets(err?.message || 'network error', secrets)}`
    };
  }
}

export async function probeCustomRunner(env, { overrideUrl = '', overrideToken = '' } = {}) {
  const base = String(overrideUrl || env?.SANDBOX_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    return { ok: false, error: 'هیچ آدرس سرور سندباکسی تنظیم نشده است.' };
  }
  const token = String(overrideToken || env?.SANDBOX_TOKEN || '').trim();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const started = Date.now();
  try {
    const healthUrl = base.endsWith('/run') ? `${base.slice(0, -4)}/health` : `${base}/health`;
    const res = await fetch(healthUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000)
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: 'توکن امنیتی رانر نادرست است (401 Unauthorized).' };
    }
    if (res.ok) {
      const info = await res.json().catch(() => null);
      if (info && typeof info === 'object' && info.ok !== false) {
        return {
          ok: true,
          latencyMs: Date.now() - started,
          runner: info.runner || 'cloud-linux',
          jobs: Boolean(info.jobs),
          platform: info.platform || 'linux',
          arch: info.arch || '',
          node: info.node || '',
          shell: info.shell || '',
          persistence: info.persistence || null
        };
      }
    }
  } catch {
    // Fall through to POST probe for minimal custom webhook runners without GET /health
  }

  try {
    const postRes = await fetch(base, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ cmd: 'uname -srm && node -v 2>/dev/null || echo ok', cwd: '/workspace', timeoutMs: 8000, files: {} })
    });
    if (postRes.status === 401 || postRes.status === 403) {
      return { ok: false, status: postRes.status, error: 'توکن امنیتی رانر نادرست است (401 Unauthorized).' };
    }
    if (!postRes.ok) {
      return { ok: false, status: postRes.status, error: `سرور کد HTTP ${postRes.status} برگرداند.` };
    }
    const data = await postRes.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'پاسخ سرور JSON معتبر نیست.' };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      runner: data.runner || 'remote-runner',
      stdout: String(data.stdout || '').trim().slice(0, 160)
    };
  } catch (err) {
    return { ok: false, error: `اتصال برقرار نشد: ${err?.message || 'خطای شبکه'}` };
  }
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

async function callLinuxContainer(env, { cmd, cwdRel = '', files, timeoutMs = DEFAULT_TIMEOUT_MS, offset = 0, limit = MAX_OUTPUT_CHARS, externalSignal = null }) {
  const secrets = envSecrets(env || {});
  if (secrets.some((s) => s && cmd.includes(s))) {
    return { ok: false, unavailable: false, exitCode: 1, stdout: '', stderr: 'Blocked: command contains a server secret.' };
  }

  const codes = mountSafeFiles(files, secrets);
  const safeCdLine = cwdRel ? `cd -- '${cwdRel.replace(/'/g, "'\\''")}' || exit 1` : '';
  const wrappedScript = [
    '{',
    'for __cp_d in /opt/wandbox/nodejs-20*/bin /opt/wandbox/cpython-3.14*/bin /opt/wandbox/cpython-3.13*/bin /opt/wandbox/gcc-13*/bin /opt/wandbox/go-1.23*/bin /opt/wandbox/rust-1.7*/bin /opt/wandbox/sqlite-3*/bin; do',
    '  [ -d "$__cp_d" ] && PATH="$__cp_d:$PATH"',
    'done',
    'export PATH',
    'rm -f ./prog.sh 2>/dev/null || true',
    safeCdLine,
    cmd,
    '}'
  ]
    .filter(Boolean)
    .join('\n');

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
      signal: mergeTimeoutSignal(timeoutMs, externalSignal),
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
      timedOut: error?.name === 'TimeoutError' || (error?.name === 'AbortError' && !isCancelled(externalSignal)),
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
  const rawStdout = redactSecrets(String(data.program_output || data.compiler_output || ''), secrets);
  const errParts = [data.compiler_error, data.program_error, signal ? `Signal: ${signal}` : '']
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const rawStderr = redactSecrets(errParts.join('\n'), secrets);

  const outPage = paginateOutput(rawStdout, { offset, limit });
  const errPage = paginateOutput(rawStderr, { offset: 0, limit });

  return {
    ok: exitCode === 0 && !signal,
    unavailable: false,
    exitCode,
    signal: signal || null,
    stdout: outPage.chunk,
    stderr: errPage.chunk,
    stdoutTruncated: outPage.truncated,
    stderrTruncated: errPage.truncated,
    truncated: outPage.truncated || errPage.truncated,
    offset: outPage.offset,
    nextOffset: outPage.nextOffset,
    hasMore: outPage.hasMore,
    totalStdoutChars: outPage.totalChars,
    totalStderrChars: errPage.totalChars,
    durationMs: Date.now() - started
  };
}

export function formatJobResult(job) {
  const header = [
    `Async job ${job.jobId} · status: ${job.status}`,
    job.exitCode !== null && job.exitCode !== undefined ? `exit ${job.exitCode}` : null,
    job.signal ? `signal ${job.signal}` : null,
    job.durationMs !== null && job.durationMs !== undefined ? `${job.durationMs}ms` : null
  ]
    .filter(Boolean)
    .join(' · ');

  const parts = [header];
  if (job.error) parts.push(`error: ${job.error}`);
  if (job.output) {
    parts.push(`${job.stream || 'combined'} [offset ${job.offset ?? 0}..${job.nextOffset ?? 0} / ${job.totalBytes ?? job.output.length} bytes]:\n${job.output}`);
  } else if (!job.running) {
    parts.push(`${job.stream || 'combined'}: (empty at offset ${job.offset ?? 0})`);
  }
  if (job.hasMore || job.truncated) {
    parts.push(
      `[OUTPUT TRUNCATED: more output available. Continue with run_command({ action: "status", jobId: "${job.jobId}", stream: "${job.stream || 'combined'}", offset: ${job.nextOffset ?? 0} }).]`
    );
  }
  if (job.running) {
    parts.push(
      `[Job is still running. Poll with run_command({ action: "status", jobId: "${job.jobId}", offset: ${job.nextOffset ?? 0} }) or cancel with run_command({ action: "cancel", jobId: "${job.jobId}" }).]`
    );
  }
  if (job.persistence?.notice) {
    parts.push(`Persistence: ${job.persistence.notice}`);
  }
  return parts.join('\n');
}

export function formatRealResult(label, result) {
  const statusTag = result.status && result.status !== 'completed' && result.status !== 'failed' ? `, status: ${result.status}` : '';
  const exitText = result.exitCode === null || result.exitCode === undefined ? 'running' : `exit ${result.exitCode}`;
  const parts = [
    `${label} (${exitText}${result.durationMs ? `, ${result.durationMs}ms` : ''}${statusTag}${result.jobId ? `, jobId: ${result.jobId}` : ''})`,
    result.stdout ? `stdout:\n${result.stdout}` : 'stdout: (empty)',
    result.stderr ? `stderr:\n${result.stderr}` : ''
  ].filter(Boolean);

  if (result.stdoutTruncated || result.stderrTruncated || result.truncated) {
    if (result.jobId) {
      parts.push(
        `[OUTPUT TRUNCATED: stdout ${result.stdout?.length || 0}/${result.totalStdoutChars ?? '?'} chars. Continue reading full log with run_command({ action: "status", jobId: "${result.jobId}", stream: "stdout", offset: ${result.nextOffset ?? (result.stdout?.length || 0)} }).]`
      );
    } else {
      parts.push(
        `[OUTPUT TRUNCATED: showing ${result.stdout?.length || 0} of ${result.totalStdoutChars ?? '?'} stdout chars. Re-run with a narrower filter (head/tail/grep) or pass offset/limit.]`
      );
    }
  }
  if (result.running && result.jobId) {
    parts.push(
      `[Command promoted to async job ${result.jobId}. Poll with action: "status", jobId: "${result.jobId}", offset: ${result.nextOffset ?? 0} or cancel with action: "cancel".]`
    );
  }
  if (result.persistence?.notice && (result.running || result.promoted)) {
    parts.push(`Persistence: ${result.persistence.notice}`);
  }
  return parts.join('\n');
}

/**
 * Run a command or manage an async command job.
 * Supports `action`: 'run' (default) | 'start' | 'status' | 'poll' | 'cancel' | 'list'.
 */
export async function runCommand(
  env,
  {
    command = '',
    action = 'run',
    jobId = '',
    cwd = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitMs = undefined,
    async: asyncFlag = false,
    stream = 'combined',
    offset = 0,
    limit = MAX_OUTPUT_CHARS,
    workspace,
    externalSignal,
    conversationId = ''
  }
) {
  if (isCancelled(externalSignal)) {
    return {
      mode: 'stopped',
      ok: false,
      exitCode: 130,
      stdout: '',
      stderr: 'Cancelled by user.',
      text: 'Cancelled by user.'
    };
  }

  const session = String(conversationId || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);

  const normalizedAction = String(action || 'run').trim().toLowerCase();
  if (normalizedAction === 'status' || normalizedAction === 'poll') {
    return getCommandJob(env, { jobId, stream, offset, limit, session, workspace, externalSignal });
  }
  if (normalizedAction === 'cancel') {
    return cancelCommandJob(env, { jobId, session, externalSignal });
  }
  if (normalizedAction === 'list') {
    return listCommandJobs(env, { session, externalSignal });
  }

  const cwdCheck = validateCommandCwd(cwd);
  if (!cwdCheck.ok) {
    return {
      mode: 'blocked',
      ok: false,
      exitCode: 126,
      stdout: '',
      stderr: cwdCheck.reason,
      text: `Invalid cwd: ${cwdCheck.reason}. Nothing was executed.`
    };
  }

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

  const secrets = envSecrets(env || {});
  if (secrets.some((s) => s && String(command).includes(s))) {
    return {
      mode: 'blocked',
      ok: false,
      exitCode: 126,
      stdout: '',
      stderr: 'Blocked: command contains a server secret.',
      text: 'Command blocked: server secrets must never appear in commands or logs.'
    };
  }

  const files = workspace?.files && typeof workspace.files === 'object' ? workspace.files : null;
  const wantAsync = normalizedAction === 'start' || Boolean(asyncFlag);
  const safeTimeout = clamp(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 500, wantAsync ? 3_600_000 : 300_000);

  if (wantAsync) {
    if (!env?.SANDBOX_URL) {
      return {
        mode: realExecutionMode(env),
        ok: false,
        unsupported: true,
        exitCode: 1,
        stdout: '',
        stderr: 'Async background jobs require a configured stateful runner (SANDBOX_URL / runner-kit).',
        text: 'Async job start unavailable: current execution tier is stateless (Wandbox / virtual shell) and cannot host persistent background jobs. Configure SANDBOX_URL (runner-kit) for real async jobs.'
      };
    }
    const started = await callCustomRunner(env, {
      cmd: command,
      cwd: cwdCheck.cwd,
      files,
      timeoutMs: safeTimeout,
      waitMs,
      asyncMode: true,
      offset,
      limit,
      stream,
      externalSignal,
      session
    });
    if (!started || started.unavailable) {
      return {
        mode: 'remote-sandbox',
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: started?.error || 'remote runner unavailable',
        text: `Failed to start async job on remote runner: ${started?.error || 'unavailable'}.`
      };
    }
    const syncInfo = !started.running ? applyRunnerFileChanges(workspace, started, secrets) : { touchedFiles: [], deletedFiles: [] };
    const payload = {
      mode: 'remote-sandbox',
      runner: started.runner,
      ok: started.ok,
      jobId: started.jobId,
      status: started.status,
      running: started.running,
      exitCode: started.exitCode,
      signal: started.signal,
      timedOut: started.timedOut,
      cancelled: started.cancelled,
      error: started.error,
      durationMs: started.durationMs,
      stream: started.stream,
      offset: started.offset,
      nextOffset: started.nextOffset,
      hasMore: started.hasMore,
      truncated: started.truncated,
      output: started.output ?? started.stdout ?? '',
      stdout: started.stdout,
      stderr: started.stderr,
      stdoutTruncated: started.stdoutTruncated,
      stderrTruncated: started.stderrTruncated,
      persistence: started.persistence,
      touchedFiles: syncInfo.touchedFiles,
      deletedFiles: syncInfo.deletedFiles
    };
    payload.text = formatJobResult(payload);
    return payload;
  }

  // Tier 1: Bound Cloudflare Container Durable Object
  if (sandboxEnabled(env)) {
    const result = await callSandbox(env, { cmd: command, cwd: cwdCheck.cwd, timeoutMs: safeTimeout, files });
    if (result && !result.unavailable) {
      return {
        mode: 'sandbox',
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        truncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
        totalStdoutChars: result.totalStdoutChars,
        totalStderrChars: result.totalStderrChars,
        durationMs: result.durationMs,
        text: formatRealResult('Real sandbox execution', result)
      };
    }
    if (!linuxRunnerEnabled(env)) {
      const fallback = virtualShell(workspace, command, { cwdRel: cwdCheck.rel });
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

  // Tier 2: Custom remote sandbox URL (`runner-kit/server.mjs`)
  if (env?.SANDBOX_URL) {
    const remote = await callCustomRunner(env, {
      cmd: command,
      cwd: cwdCheck.cwd,
      files,
      timeoutMs: safeTimeout,
      waitMs,
      asyncMode: false,
      offset,
      limit,
      stream,
      externalSignal,
      session
    });
    if (remote && !remote.unavailable) {
      const syncInfo = !remote.running ? applyRunnerFileChanges(workspace, remote, secrets) : { touchedFiles: [], deletedFiles: [] };
      const label =
        remote.runner === 'termux'
          ? 'Real Termux execution (remote tunnel)'
          : 'Real remote Linux execution';
      return {
        mode: 'remote-sandbox',
        runner: remote.runner || 'remote',
        ok: remote.ok,
        jobId: remote.jobId,
        status: remote.status,
        running: remote.running,
        promoted: remote.promoted,
        timedOut: remote.timedOut,
        cancelled: remote.cancelled,
        exitCode: remote.exitCode,
        signal: remote.signal,
        error: remote.error,
        stdout: remote.stdout,
        stderr: remote.stderr,
        stdoutTruncated: remote.stdoutTruncated,
        stderrTruncated: remote.stderrTruncated,
        truncated: remote.truncated,
        offset: remote.offset,
        nextOffset: remote.nextOffset,
        hasMore: remote.hasMore,
        totalStdoutChars: remote.totalStdoutChars,
        totalStderrChars: remote.totalStderrChars,
        durationMs: remote.durationMs,
        persistence: remote.persistence,
        touchedFiles: syncInfo.touchedFiles,
        deletedFiles: syncInfo.deletedFiles,
        text: formatRealResult(label, remote)
      };
    }
  }

  // Tier 3: Isolated Podman Linux Container (Wandbox stateless)
  if (linuxRunnerEnabled(env)) {
    const linux = await callLinuxContainer(env, {
      cmd: command,
      cwdRel: cwdCheck.rel,
      files,
      timeoutMs: safeTimeout,
      offset,
      limit,
      externalSignal
    });
    if (linux && !linux.unavailable) {
      return {
        mode: 'linux-container',
        ok: linux.ok,
        exitCode: linux.exitCode,
        signal: linux.signal,
        stdout: linux.stdout,
        stderr: linux.stderr,
        stdoutTruncated: linux.stdoutTruncated,
        stderrTruncated: linux.stderrTruncated,
        truncated: linux.truncated,
        offset: linux.offset,
        nextOffset: linux.nextOffset,
        hasMore: linux.hasMore,
        totalStdoutChars: linux.totalStdoutChars,
        totalStderrChars: linux.totalStderrChars,
        durationMs: linux.durationMs,
        text: formatRealResult(
          'Real Linux OS container execution (isolated Podman container; workspace mounted read-copy)',
          linux
        )
      };
    }
    const fallback = virtualShell(workspace, command, { cwdRel: cwdCheck.rel });
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

  const rawVOut = redactSecrets(virtualShell(workspace, command, { cwdRel: cwdCheck.rel }), secrets);
  const vPage = paginateOutput(rawVOut, { offset, limit });
  const truncNote = vPage.truncated
    ? `\n[OUTPUT TRUNCATED: showing ${vPage.chunk.length} of ${vPage.totalChars} chars. Continue with offset: ${vPage.nextOffset}.]`
    : '';
  return {
    mode: 'virtual',
    ok: true,
    exitCode: 0,
    stdout: vPage.chunk,
    stderr: '',
    stdoutTruncated: vPage.truncated,
    truncated: vPage.truncated,
    offset: vPage.offset,
    nextOffset: vPage.nextOffset,
    hasMore: vPage.hasMore,
    totalStdoutChars: vPage.totalChars,
    text: ['Virtual shell (no real OS, no network, no subprocesses).', vPage.chunk + truncNote].join('\n')
  };
}

/* ------------------------------ virtual shell ----------------------------- */

/** The in-D1 workspace shell. Pure apart from mutating `workspace.files`. */
export function virtualShell(workspace, rawCommand, { cwdRel = '' } = {}) {
  const command = String(rawCommand || '').trim();
  if (!command) return 'Error: empty command';
  if (command.length > 2000) return 'Error: command too long';
  const files = workspace.files || {};
  const [op, ...rest] = command.split(/\s+/);
  const arg = rest.join(' ');
  const resolveVirtualPath = (p) => (cwdRel && p && !p.startsWith(`${cwdRel}/`) ? `${cwdRel}/${p}` : p);

  switch (op) {
    case 'help':
      return [
        'Virtual shell — allowed commands:',
        '  help, pwd, ls, cat <file>, touch <file>, echo <text> > <file>, rm <file>, clear, preview',
        'There is no network, no OS access and no real subprocess here.'
      ].join('\n');
    case 'pwd':
      return cwdRel ? `/workspace/project/${cwdRel}` : '/workspace/project';
    case 'ls': {
      const keys = Object.keys(files).sort();
      const filtered = cwdRel ? keys.filter((k) => k.startsWith(`${cwdRel}/`)).map((k) => k.slice(cwdRel.length + 1)) : keys;
      return filtered.join('  ') || '(empty)';
    }
    case 'cat': {
      const target = resolveVirtualPath(arg);
      return files[target] === undefined ? `cat: file not found: ${target}` : String(files[target]);
    }
    case 'touch': {
      if (!arg) return 'touch: missing file name';
      const target = resolveVirtualPath(arg);
      if (!/^[\w./[\]-]{1,200}$/.test(target) || target.includes('..')) return 'touch: invalid path';
      if (files[target] === undefined) files[target] = '';
      return `created ${target}`;
    }
    case 'rm': {
      const target = resolveVirtualPath(arg);
      if (files[target] === undefined) return `rm: file not found: ${target}`;
      delete files[target];
      return `removed ${target}`;
    }
    case 'echo': {
      const match = command.match(/^echo\s+([\s\S]*?)\s*>\s*(\S+)$/);
      if (!match) return 'usage: echo <text> > <file>';
      const [, text, rawPath] = match;
      const target = resolveVirtualPath(rawPath);
      if (!/^[\w./[\]-]{1,200}$/.test(target) || target.includes('..')) return 'echo: invalid path';
      files[target] = text.replace(/^["']|["']$/g, '');
      return `wrote ${target}`;
    }
    case 'clear':
      return 'ok';
    case 'preview':
      return 'Use the Preview button in the toolbar to open the rendered project.';
    default:
      return `Unknown command: ${op}. Type help for the allowed list.`;
  }
}
