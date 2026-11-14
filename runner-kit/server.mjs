#!/usr/bin/env node
// CodePilot Universal Linux & Termux Runner (Zero Dependencies, Node >= 18)
// Supports:
//   - Method 2: 24/7 Cloud Container (Docker / Render / Fly / VPS / Cloudflare Tunnel)
//   - Method 3: Direct Local Android Termux Bridge (127.0.0.1:8787 with Chrome Private Network Access CORS)
//
// Features:
//   - Synchronous `/run` (backward compatible) AND async persistent `/jobs` lifecycle
//     (create, status + paginated log reading, safe process-group cancellation, list).
//   - Detached POSIX process groups: jobs survive HTTP client disconnect while the
//     runner process stays alive, and timeout/cancel cleanly terminates child trees.
//     (Honest caveat: on Android/Termux, OS force-stop, LMK, or reboot still kills processes.)
//   - Strict `cwd` path-escape & symlink-escape validation, secret redaction in logs/output,
//     sanitized child environment (CP_TOKEN/SANDBOX_TOKEN never exposed to child shells),
//     file permission preservation, and symlink-loop-safe `/files` listing.

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';

const IS_TERMUX = Boolean(process.env.TERMUX_VERSION || String(process.env.PREFIX || '').includes('com.termux'));
const PORT = Number(process.env.CP_PORT || process.env.PORT || (IS_TERMUX ? 8787 : 7860));
const HOST = process.env.CP_HOST || process.env.HOST || (IS_TERMUX ? '127.0.0.1' : '0.0.0.0');
const TOKEN = String(process.env.CP_TOKEN || process.env.SANDBOX_TOKEN || '').trim();
const WORKSPACE_ROOT = path.resolve(
  process.env.CP_WORKDIR || path.join(os.homedir(), 'codepilot-workspace')
);

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 128_000;
const MAX_JOB_LOG_BYTES = 32 * 1024 * 1024; // per stream (stdout / stderr / combined)
const MAX_STORED_JOBS = 250;
const MAX_SYNC_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SYNC_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_SYNC_FILES = 250;
const MAX_LIST_ENTRIES = 100_000;
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.npm',
  'dist',
  'build',
  'target',
  '.cp-jobs'
]);

// Strip ONLY the runner bridge's own auth secrets from child process env so
// the developer's own CLI/project env vars (e.g. local dev tokens/DB creds)
// keep working seamlessly. Outputs/logs still redact accidental secret leaks.
const RUNNER_INTERNAL_ENV_KEY_RE = /^(?:CP_TOKEN|SANDBOX_TOKEN|SESSION_SECRET)$/i;

const SECRET_PATTERNS = [
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\btc_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]'],
  [/\b(set-cookie|cookie|x-api-key|proxy-authorization)(\s*:\s*)([^\r\n]{4,})/gi, '$1$2[REDACTED]'],
  [/\b(authorization)(\s*:\s*)(?:(Bearer|Basic|Token)\s+)?([^\r\n]{4,})/gi, (_, h, sep, scheme) => (scheme ? `${h}${sep}${scheme} [REDACTED]` : `${h}${sep}[REDACTED]`)],
  [/\b(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|auth[_-]?token|private[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"',;}\]]{6,})/gi, '$1$2[REDACTED]']
];

await mkdir(WORKSPACE_ROOT, { recursive: true });

function persistenceMetadata() {
  return IS_TERMUX
    ? {
        environment: 'termux-android',
        survivesClientDisconnect: true,
        survivesForceStopOrReboot: false,
        notice:
          'Async jobs survive HTTP/client disconnects while Termux remains running, but Android force-stop, OS low-memory killer (LMK), or device shutdown will terminate running jobs.'
      }
    : {
        environment: 'cloud-linux',
        survivesClientDisconnect: true,
        survivesForceStopOrReboot: false,
        notice:
          'Async jobs run in detached process groups and survive HTTP/client disconnects while the runner process remains alive; container restart or host shutdown terminates active processes.'
      };
}

function redactRunnerText(value) {
  let text = String(value ?? '');
  if (!text) return '';
  if (TOKEN && TOKEN.length >= 6) {
    text = text.split(TOKEN).join('[REDACTED]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function buildSafeChildEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (RUNNER_INTERNAL_ENV_KEY_RE.test(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  out.HOME = os.homedir();
  out.TERM = 'xterm-256color';
  return out;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-CP-Token, Access-Control-Request-Private-Network'
  );
  // Required by Chromium / Android Chrome for HTTPS -> http://127.0.0.1 Private Network Access
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(req, res, status, payload) {
  setCorsHeaders(req, res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function verifyAuth(req) {
  if (!TOKEN) return true;
  const authHeader = String(req.headers.authorization || '').trim();
  const altHeader = String(req.headers['x-cp-token'] || '').trim();
  const candidate = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : altHeader;
  if (!candidate) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isSafeRelPath(rel, root = WORKSPACE_ROOT) {
  if (typeof rel !== 'string' || !rel || rel.length > 220) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || IGNORED_DIRS.has(p))) return false;
  const resolved = path.resolve(root, rel);
  return resolved.startsWith(root + path.sep);
}

/**
 * Validate and resolve an optional `cwd` inside `workDir`.
 * Rejects path traversal (`..`), NUL bytes, backslashes, absolute paths outside
 * `/workspace`, and symlinks whose realpath escapes `workDir`.
 */
async function resolveSafeCwd(workDir, rawCwd) {
  const input = String(rawCwd ?? '').trim();
  const realRoot = await realpath(workDir);
  if (!input || input === '.' || input === '/workspace' || input === '/workspace/') {
    return { ok: true, dir: realRoot, rel: '.' };
  }
  if (input.includes('\0') || input.includes('\\') || input.length > 240) {
    return { ok: false, error: 'مسیر cwd نامعتبر است.' };
  }
  let rel = input;
  if (rel.startsWith('/workspace/')) {
    rel = rel.slice('/workspace/'.length);
  } else if (rel.startsWith('/')) {
    return { ok: false, error: 'مسیر مطلق cwd خارج از workspace مجاز نیست.' };
  }
  rel = rel.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel === '.') return { ok: true, dir: realRoot, rel: '.' };
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    return { ok: false, error: 'پیمایش مسیر (..) در cwd مجاز نیست.' };
  }
  const candidate = path.resolve(realRoot, rel);
  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
    return { ok: false, error: 'مسیر cwd از ریشه workspace خارج است.' };
  }
  let resolvedReal;
  try {
    resolvedReal = await realpath(candidate);
  } catch {
    return { ok: false, error: `پوشه cwd پیدا نشد: ${rel}` };
  }
  if (resolvedReal !== realRoot && !resolvedReal.startsWith(realRoot + path.sep)) {
    return { ok: false, error: 'symlink مسیر cwd به خارج از workspace اشاره می‌کند و مسدود شد.' };
  }
  const st = await stat(resolvedReal).catch(() => null);
  if (!st || !st.isDirectory()) {
    return { ok: false, error: `مسیر cwd یک پوشه معتبر نیست: ${rel}` };
  }
  return { ok: true, dir: resolvedReal, rel };
}

// Per-conversation isolated workspaces: parallel CodePilot chats each get
// their own directory so simultaneous `run_command`s never trample each
// other's files. No `session` → the shared root (backward compatible).
const SESSIONS_ROOT = path.join(WORKSPACE_ROOT, 'sessions');
const ADOPT_MARKER = '.cp-legacy-adopted';

function sessionWorkdir(session) {
  const raw = String(session || '').trim();
  if (!raw || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return WORKSPACE_ROOT;
  return path.join(SESSIONS_ROOT, raw);
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Merge-move `fromDir` into `toDir`, never overwriting existing files. */
async function mergeMoveDir(fromDir, toDir) {
  let entries = [];
  try {
    entries = await readdir(fromDir, { withFileTypes: true });
  } catch {
    return;
  }
  await mkdir(toDir, { recursive: true });
  for (const entry of entries) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await mergeMoveDir(from, to);
      await rm(from, { recursive: true, force: true }).catch(() => {});
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (await pathExists(to)) continue;
      await rename(from, to).catch(() => {});
    }
  }
}

async function adoptLegacyRoot(sessionDir) {
  try {
    const marker = path.join(WORKSPACE_ROOT, ADOPT_MARKER);
    if (await pathExists(marker)) return;
    let entries = [];
    try {
      entries = await readdir(WORKSPACE_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    const legacy = entries.filter((e) => e.name !== 'sessions' && e.name !== ADOPT_MARKER && e.name !== '.cp-jobs');
    await mkdir(sessionDir, { recursive: true });
    if (legacy.length) {
      for (const entry of legacy) {
        const from = path.join(WORKSPACE_ROOT, entry.name);
        const to = path.join(sessionDir, entry.name);
        if (entry.isDirectory()) {
          await mergeMoveDir(from, to);
          await rm(from, { recursive: true, force: true }).catch(() => {});
        } else if (!(await pathExists(to))) {
          await rename(from, to).catch(() => {});
        }
      }
      console.log(`[runner] adopted legacy workspace into ${sessionDir}`);
    }
    await writeFile(marker, `adopted by ${path.basename(sessionDir)} at ${new Date().toISOString()}\n`, 'utf8');
  } catch {
    /* adoption is best-effort — never break command execution */
  }
}

/** Write incoming workspace files while preserving existing file permissions. */
async function syncIncomingFiles(workDir, filesObj) {
  if (!filesObj || typeof filesObj !== 'object') return;
  for (const [rel, content] of Object.entries(filesObj)) {
    if (!isSafeRelPath(rel, workDir)) continue;
    const full = path.resolve(workDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    let existingMode = null;
    try {
      const st = await lstat(full);
      if (st.isSymbolicLink()) continue; // never overwrite through symlinks
      if (st.isFile()) existingMode = st.mode & 0o777;
    } catch {
      // new file
    }
    await writeFile(full, String(content ?? ''), 'utf8');
    if (existingMode !== null) {
      await chmod(full, existingMode).catch(() => {});
    }
  }
}

async function snapshotTextFiles(
  dir,
  relPrefix = '',
  out = new Map(),
  budget = { files: 0, bytes: 0 },
  visitedRealDirs = new Set()
) {
  if (budget.files >= MAX_SYNC_FILES || budget.bytes >= MAX_SYNC_TOTAL_BYTES) return out;
  let realDir;
  try {
    realDir = await realpath(dir);
  } catch {
    return out;
  }
  if (visitedRealDirs.has(realDir)) return out;
  visitedRealDirs.add(realDir);

  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (budget.files >= MAX_SYNC_FILES || budget.bytes >= MAX_SYNC_TOTAL_BYTES) break;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await snapshotTextFiles(full, rel, out, budget, visitedRealDirs);
    } else if (entry.isFile()) {
      try {
        const st = await stat(full);
        if (st.size > MAX_SYNC_FILE_BYTES) continue;
        const buf = await readFile(full);
        if (buf.subarray(0, 4096).includes(0)) continue;
        const text = buf.toString('utf8');
        out.set(rel, text);
        budget.files += 1;
        budget.bytes += buf.byteLength;
      } catch {
        // ignore transient files
      }
    }
  }
  return out;
}

/**
 * Recursive filesystem listing with explicit symlink-loop protection, root-escape
 * blocking, ignored-directory filtering, depth cap, and pagination.
 */
async function listDirectoryFiles(workDir, options = {}) {
  const {
    pathPrefix = '',
    maxDepth = null,
    includeIgnored = false,
    offset = 0,
    limit = 100
  } = options;

  const realRoot = await realpath(workDir);
  let startDir = realRoot;
  const cleanPrefix = String(pathPrefix || '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleanPrefix) {
    const check = await resolveSafeCwd(workDir, cleanPrefix);
    if (!check.ok) return { ok: false, error: check.error };
    startDir = check.dir;
  }

  const depthCap =
    maxDepth !== null &&
    maxDepth !== undefined &&
    maxDepth !== '' &&
    Number.isFinite(Number(maxDepth)) &&
    Number(maxDepth) >= 0
      ? Math.floor(Number(maxDepth))
      : null;
  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 200), 2000));

  const matched = [];
  let skippedIgnored = 0;
  let skippedSymlinkLoops = 0;
  let skippedSymlinkEscapes = 0;
  let truncated = false;

  async function walk(dir, relPrefix, depth, ancestorRealPaths) {
    if (matched.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (matched.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (!includeIgnored && IGNORED_DIRS.has(entry.name)) {
        skippedIgnored += 1;
        continue;
      }
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let targetReal;
        try {
          targetReal = await realpath(full);
        } catch {
          // broken symlink
          continue;
        }
        if (targetReal !== realRoot && !targetReal.startsWith(realRoot + path.sep)) {
          skippedSymlinkEscapes += 1;
          continue;
        }
        const targetStat = await stat(targetReal).catch(() => null);
        if (!targetStat) continue;
        if (targetStat.isDirectory()) {
          if (ancestorRealPaths.has(targetReal)) {
            skippedSymlinkLoops += 1;
            continue;
          }
          if (depthCap === null || depth < depthCap) {
            const nextAncestors = new Set(ancestorRealPaths);
            nextAncestors.add(targetReal);
            await walk(targetReal, rel, depth + 1, nextAncestors);
          }
        } else if (targetStat.isFile()) {
          matched.push({ path: rel, size: targetStat.size, symlink: true, depth });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (depthCap === null || depth < depthCap) {
          const dirReal = await realpath(full).catch(() => full);
          if (ancestorRealPaths.has(dirReal)) {
            skippedSymlinkLoops += 1;
            continue;
          }
          const nextAncestors = new Set(ancestorRealPaths);
          nextAncestors.add(dirReal);
          await walk(full, rel, depth + 1, nextAncestors);
        }
      } else if (entry.isFile()) {
        const st = await stat(full).catch(() => null);
        matched.push({ path: rel, size: st ? st.size : 0, symlink: false, depth });
      }
    }
  }

  await walk(startDir, cleanPrefix, 0, new Set([realRoot, startDir]));

  const slice = matched.slice(pageOffset, pageOffset + pageLimit);
  const hasMore = pageOffset + slice.length < matched.length;
  const nextOffset = hasMore ? pageOffset + slice.length : null;
  return {
    ok: true,
    files: slice,
    matched: matched.length,
    offset: pageOffset,
    limit: pageLimit,
    hasMore,
    nextOffset,
    nextCursor: nextOffset !== null ? `offset:${nextOffset}` : null,
    skippedIgnored,
    skippedSymlinkLoops,
    skippedSymlinkEscapes,
    truncated: truncated || hasMore
  };
}

function detectShell() {
  if (process.env.SHELL) return process.env.SHELL;
  if (IS_TERMUX && process.env.PREFIX) return path.join(process.env.PREFIX, 'bin', 'bash');
  return '/bin/bash';
}

/* ----------------------------- async job engine --------------------------- */

const jobs = new Map();

function killProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    // Negative PID sends signal to the entire detached POSIX process group.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already exited */
    }
  }
}

async function readLogSlice(filePath, offset = 0, limit = MAX_OUTPUT_CHARS) {
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const safeLimit = Math.max(256, Math.min(Math.floor(Number(limit) || 16_000), MAX_OUTPUT_CHARS));
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return { chunk: '', offset: safeOffset, nextOffset: safeOffset, totalBytes: 0, hasMore: false };
  }
  const totalBytes = st.size;
  if (safeOffset >= totalBytes || totalBytes === 0) {
    return { chunk: '', offset: safeOffset, nextOffset: safeOffset, totalBytes, hasMore: false };
  }
  const toRead = Math.min(safeLimit, totalBytes - safeOffset);
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, safeOffset);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const nextOffset = safeOffset + bytesRead;
    return {
      chunk,
      offset: safeOffset,
      nextOffset,
      totalBytes,
      hasMore: nextOffset < totalBytes
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

async function pruneOldJobs() {
  if (jobs.size <= MAX_STORED_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt || a.startedAt) - (b.finishedAt || b.startedAt));
  while (jobs.size > MAX_STORED_JOBS && finished.length > 0) {
    const oldest = finished.shift();
    if (!oldest) break;
    jobs.delete(oldest.jobId);
    if (oldest.jobDir) {
      await rm(oldest.jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function startJob({ cmd, workDir, cwdDir, cwdRel, session, timeoutMs, beforeMap }) {
  const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
  const jobDir = path.join(workDir, '.cp-jobs', jobId);
  await mkdir(jobDir, { recursive: true });

  const stdoutPath = path.join(jobDir, 'stdout.log');
  const stderrPath = path.join(jobDir, 'stderr.log');
  const combinedPath = path.join(jobDir, 'combined.log');
  const metaPath = path.join(jobDir, 'meta.json');

  const stdoutStream = createWriteStream(stdoutPath, { flags: 'a' });
  const stderrStream = createWriteStream(stderrPath, { flags: 'a' });
  const combinedStream = createWriteStream(combinedPath, { flags: 'a' });

  const shell = detectShell();
  const startedAt = Date.now();
  const redactedCmd = redactRunnerText(cmd).slice(0, 400);

  let resolveDone;
  const donePromise = new Promise((r) => {
    resolveDone = r;
  });

  const job = {
    jobId,
    session: String(session || ''),
    cmdPreview: redactedCmd,
    cwd: cwdRel,
    workDir,
    jobDir,
    stdoutPath,
    stderrPath,
    combinedPath,
    metaPath,
    status: 'running',
    pid: null,
    pgid: null,
    startedAt,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    error: '',
    stdoutBytesWritten: 0,
    stderrBytesWritten: 0,
    combinedBytesWritten: 0,
    totalStdoutBytes: 0,
    totalStderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    combinedTruncated: false,
    changedFiles: {},
    deletedFiles: [],
    timeoutMs,
    timer: null,
    killEscalationTimer: null,
    donePromise,
    child: null
  };

  jobs.set(jobId, job);

  const persistMeta = async () => {
    const payload = {
      jobId: job.jobId,
      session: job.session,
      cmdPreview: job.cmdPreview,
      cwd: job.cwd,
      status: job.status,
      pid: job.pid,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      exitCode: job.exitCode,
      signal: job.signal,
      timedOut: job.timedOut,
      cancelled: job.cancelled,
      error: job.error,
      totalStdoutBytes: job.totalStdoutBytes,
      totalStderrBytes: job.totalStderrBytes,
      stdoutTruncated: job.stdoutTruncated,
      stderrTruncated: job.stderrTruncated
    };
    await writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8').catch(() => {});
  };

  const appendToStream = (stream, rawChunk, kind) => {
    const clean = redactRunnerText(rawChunk.toString('utf8'));
    const buf = Buffer.from(clean, 'utf8');
    if (kind === 'stdout') {
      job.totalStdoutBytes += buf.byteLength;
      if (job.stdoutBytesWritten < MAX_JOB_LOG_BYTES) {
        const allow = Math.min(buf.byteLength, MAX_JOB_LOG_BYTES - job.stdoutBytesWritten);
        stream.write(buf.subarray(0, allow));
        job.stdoutBytesWritten += allow;
        if (allow < buf.byteLength) job.stdoutTruncated = true;
      } else {
        job.stdoutTruncated = true;
      }
    } else {
      job.totalStderrBytes += buf.byteLength;
      if (job.stderrBytesWritten < MAX_JOB_LOG_BYTES) {
        const allow = Math.min(buf.byteLength, MAX_JOB_LOG_BYTES - job.stderrBytesWritten);
        stream.write(buf.subarray(0, allow));
        job.stderrBytesWritten += allow;
        if (allow < buf.byteLength) job.stderrTruncated = true;
      } else {
        job.stderrTruncated = true;
      }
    }
    if (job.combinedBytesWritten < MAX_JOB_LOG_BYTES) {
      const allow = Math.min(buf.byteLength, MAX_JOB_LOG_BYTES - job.combinedBytesWritten);
      combinedStream.write(buf.subarray(0, allow));
      job.combinedBytesWritten += allow;
      if (allow < buf.byteLength) job.combinedTruncated = true;
    } else {
      job.combinedTruncated = true;
    }
  };

  let finalized = false;
  const finalize = async ({ exitCode, signal, errorMsg = '' }) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(job.timer);
    clearTimeout(job.killEscalationTimer);
    job.timer = null;
    job.killEscalationTimer = null;

    if (job.timedOut) {
      const note = Buffer.from(`\n[Timed out after ${Math.round(timeoutMs / 1000)}s]\n`, 'utf8');
      if (job.stderrBytesWritten < MAX_JOB_LOG_BYTES) stderrStream.write(note);
      if (job.combinedBytesWritten < MAX_JOB_LOG_BYTES) combinedStream.write(note);
    } else if (job.cancelled) {
      const note = Buffer.from('\n[Job cancelled safely]\n', 'utf8');
      if (job.stderrBytesWritten < MAX_JOB_LOG_BYTES) stderrStream.write(note);
      if (job.combinedBytesWritten < MAX_JOB_LOG_BYTES) combinedStream.write(note);
    } else if (errorMsg) {
      const note = Buffer.from(`\n${redactRunnerText(errorMsg)}\n`, 'utf8');
      if (job.stderrBytesWritten < MAX_JOB_LOG_BYTES) stderrStream.write(note);
      if (job.combinedBytesWritten < MAX_JOB_LOG_BYTES) combinedStream.write(note);
    }

    await Promise.all([
      new Promise((r) => stdoutStream.end(r)),
      new Promise((r) => stderrStream.end(r)),
      new Promise((r) => combinedStream.end(r))
    ]);

    job.finishedAt = Date.now();
    job.durationMs = job.finishedAt - job.startedAt;
    job.signal = signal || null;
    if (errorMsg) job.error = redactRunnerText(errorMsg);
    if (job.cancelled) {
      job.status = 'cancelled';
      job.exitCode = typeof exitCode === 'number' ? exitCode : 130;
    } else if (job.timedOut) {
      job.status = 'timed_out';
      job.exitCode = 124;
    } else if (errorMsg) {
      job.status = 'failed';
      job.exitCode = typeof exitCode === 'number' ? exitCode : 1;
    } else {
      job.exitCode = typeof exitCode === 'number' ? exitCode : 1;
      job.status = job.exitCode === 0 ? 'completed' : 'failed';
    }

    // Compute workspace file diffs once the command has finished.
    try {
      const afterMap = await snapshotTextFiles(workDir);
      const changedFiles = {};
      const deletedFiles = [];
      for (const [rel, text] of afterMap.entries()) {
        if (!beforeMap.has(rel) || beforeMap.get(rel) !== text) {
          changedFiles[rel] = text;
        }
      }
      for (const rel of beforeMap.keys()) {
        if (!afterMap.has(rel)) deletedFiles.push(rel);
      }
      job.changedFiles = changedFiles;
      job.deletedFiles = deletedFiles;
    } catch {
      // keep empty diffs on transient FS error
    }

    await persistMeta();
    pruneOldJobs().catch(() => {});
    resolveDone(job);
  };

  const child = spawn(shell, ['-c', cmd], {
    cwd: cwdDir,
    env: buildSafeChildEnv(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  job.child = child;
  job.pid = child.pid || null;
  job.pgid = child.pid || null;
  await persistMeta();

  job.timer = setTimeout(() => {
    if (finalized) return;
    job.timedOut = true;
    killProcessGroup(job.pgid, 'SIGTERM');
    job.killEscalationTimer = setTimeout(() => {
      if (!finalized) killProcessGroup(job.pgid, 'SIGKILL');
    }, 1500);
    if (typeof job.killEscalationTimer.unref === 'function') job.killEscalationTimer.unref();
  }, timeoutMs);
  if (typeof job.timer.unref === 'function') job.timer.unref();

  child.stdout.on('data', (chunk) => appendToStream(stdoutStream, chunk, 'stdout'));
  child.stderr.on('data', (chunk) => appendToStream(stderrStream, chunk, 'stderr'));
  child.on('error', (err) => {
    finalize({ exitCode: 1, signal: null, errorMsg: err?.message || 'spawn error' });
  });
  child.on('close', (code, signal) => {
    finalize({ exitCode: code, signal });
  });

  return job;
}

async function cancelJob(job) {
  if (!job) return null;
  if (job.status !== 'running') return job;
  job.cancelled = true;
  killProcessGroup(job.pgid, 'SIGTERM');
  job.killEscalationTimer = setTimeout(() => {
    if (job.status === 'running') killProcessGroup(job.pgid, 'SIGKILL');
  }, 1200);
  if (typeof job.killEscalationTimer.unref === 'function') job.killEscalationTimer.unref();
  await Promise.race([job.donePromise, new Promise((r) => setTimeout(r, 2500))]);
  return job;
}

async function formatJobResponse(job, { stream = 'combined', offset = 0, limit = 16_000, includeBothStreams = false } = {}) {
  const safeStream = stream === 'stdout' || stream === 'stderr' ? stream : 'combined';
  const targetPath =
    safeStream === 'stdout' ? job.stdoutPath : safeStream === 'stderr' ? job.stderrPath : job.combinedPath;
  const page = await readLogSlice(targetPath, offset, limit);
  const running = job.status === 'running';
  const base = {
    ok: running ? true : job.exitCode === 0 && !job.timedOut && !job.cancelled && !job.error,
    runner: IS_TERMUX ? 'termux' : 'cloud-linux',
    jobId: job.jobId,
    session: job.session,
    status: job.status,
    running,
    pid: job.pid,
    cwd: job.cwd,
    cmdPreview: job.cmdPreview,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs ?? Date.now() - job.startedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    cancelled: job.cancelled,
    error: job.error || null,
    stream: safeStream,
    offset: page.offset,
    limit: Math.max(256, Math.min(Math.floor(Number(limit) || 16_000), MAX_OUTPUT_CHARS)),
    nextOffset: page.nextOffset,
    totalBytes: page.totalBytes,
    hasMore: page.hasMore,
    truncated:
      page.hasMore ||
      (safeStream === 'stdout'
        ? job.stdoutTruncated
        : safeStream === 'stderr'
          ? job.stderrTruncated
          : job.combinedTruncated),
    output: page.chunk,
    totalStdoutBytes: job.totalStdoutBytes,
    totalStderrBytes: job.totalStderrBytes,
    stdoutTruncated: job.stdoutTruncated,
    stderrTruncated: job.stderrTruncated,
    changedFiles: running ? {} : job.changedFiles,
    deletedFiles: running ? [] : job.deletedFiles,
    persistence: persistenceMetadata()
  };

  if (includeBothStreams) {
    const outPage = await readLogSlice(job.stdoutPath, offset, limit);
    const errPage = await readLogSlice(job.stderrPath, 0, limit);
    base.stdout = outPage.chunk;
    base.stderr = errPage.chunk;
    base.stdoutHasMore = outPage.hasMore;
    base.stdoutNextOffset = outPage.nextOffset;
    base.stderrHasMore = errPage.hasMore;
    base.stderrNextOffset = errPage.nextOffset;
    base.stdoutTruncated = job.stdoutTruncated || outPage.hasMore;
    base.stderrTruncated = job.stderrTruncated || errPage.hasMore;
  }
  return base;
}

async function readRequestJson(req, res) {
  let raw = '';
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        sendJson(req, res, 413, { ok: false, error: 'حجم درخواست بیش از حد مجاز است.' });
        return null;
      }
      raw += chunk.toString('utf8');
    }
  } catch {
    sendJson(req, res, 400, { ok: false, error: 'خطا در دریافت بدنه درخواست.' });
    return null;
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    sendJson(req, res, 400, { ok: false, error: 'قالب JSON معتبر نیست.' });
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    const requiresAuth = pathname === '/health' && Boolean(TOKEN);
    if (requiresAuth && !verifyAuth(req)) {
      return sendJson(req, res, 401, { ok: false, error: 'توکن امنیتی رانر نادرست است (401).' });
    }
    return sendJson(req, res, 200, {
      ok: true,
      service: 'codepilot-runner',
      version: '2.4.0',
      runner: IS_TERMUX ? 'termux' : 'cloud-linux',
      sessions: true,
      jobs: true,
      files: true,
      authRequired: Boolean(TOKEN),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      node: process.version,
      shell: detectShell(),
      persistence: persistenceMetadata()
    });
  }

  // All mutating / job / file endpoints require auth when TOKEN is set.
  if (!verifyAuth(req)) {
    return sendJson(req, res, 401, { ok: false, error: 'توکن امنیتی رانر نادرست است (401).' });
  }

  // GET /files — symlink-loop-safe recursive filesystem listing
  if (req.method === 'GET' && pathname === '/files') {
    const session = urlObj.searchParams.get('session') || '';
    const workDir = sessionWorkdir(session);
    await mkdir(workDir, { recursive: true });
    const listing = await listDirectoryFiles(workDir, {
      pathPrefix: urlObj.searchParams.get('pathPrefix') || '',
      maxDepth: urlObj.searchParams.has('maxDepth') ? Number(urlObj.searchParams.get('maxDepth')) : null,
      includeIgnored: urlObj.searchParams.get('includeIgnored') === '1' || urlObj.searchParams.get('includeIgnored') === 'true',
      offset: Number(urlObj.searchParams.get('offset') || 0),
      limit: Number(urlObj.searchParams.get('limit') || 100)
    });
    if (!listing.ok) return sendJson(req, res, 400, listing);
    return sendJson(req, res, 200, listing);
  }

  // GET /jobs — list active & recent jobs
  if (req.method === 'GET' && pathname === '/jobs') {
    const sessionFilter = urlObj.searchParams.get('session');
    const items = [...jobs.values()]
      .filter((j) => (sessionFilter ? j.session === sessionFilter : true))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map((j) => ({
        jobId: j.jobId,
        session: j.session,
        status: j.status,
        running: j.status === 'running',
        cwd: j.cwd,
        cmdPreview: j.cmdPreview,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        durationMs: j.durationMs ?? Date.now() - j.startedAt,
        exitCode: j.exitCode,
        timedOut: j.timedOut,
        cancelled: j.cancelled,
        totalStdoutBytes: j.totalStdoutBytes,
        totalStderrBytes: j.totalStderrBytes
      }));
    return sendJson(req, res, 200, {
      ok: true,
      runner: IS_TERMUX ? 'termux' : 'cloud-linux',
      jobs: items,
      persistence: persistenceMetadata()
    });
  }

  // GET /jobs/:id — job status & paginated output
  const jobMatch = /^\/jobs\/([A-Za-z0-9_-]{6,64})$/.exec(pathname);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(req, res, 404, { ok: false, error: 'شناسه job پیدا نشد.' });
    const sessionFilter = urlObj.searchParams.get('session');
    if (sessionFilter && job.session && job.session !== sessionFilter) {
      return sendJson(req, res, 404, { ok: false, error: 'شناسه job در این نشست پیدا نشد.' });
    }
    const payload = await formatJobResponse(job, {
      stream: urlObj.searchParams.get('stream') || 'combined',
      offset: Number(urlObj.searchParams.get('offset') || 0),
      limit: Number(urlObj.searchParams.get('limit') || 16_000),
      includeBothStreams: urlObj.searchParams.get('both') === '1'
    });
    return sendJson(req, res, 200, payload);
  }

  // POST /jobs/:id/cancel OR DELETE /jobs/:id — cancel job safely
  const cancelMatch = /^\/jobs\/([A-Za-z0-9_-]{6,64})\/cancel$/.exec(pathname);
  if ((req.method === 'POST' && cancelMatch) || (req.method === 'DELETE' && jobMatch)) {
    const id = cancelMatch ? cancelMatch[1] : jobMatch[1];
    const job = jobs.get(id);
    if (!job) return sendJson(req, res, 404, { ok: false, error: 'شناسه job پیدا نشد.' });
    await cancelJob(job);
    const payload = await formatJobResponse(job, { stream: 'combined', offset: 0, limit: 8_000 });
    return sendJson(req, res, 200, payload);
  }

  // POST /jobs OR POST /run OR POST /
  if (req.method === 'POST' && (pathname === '/' || pathname === '/run' || pathname === '/jobs')) {
    const body = await readRequestJson(req, res);
    if (!body) return;

    const cmd = String(body.cmd || body.command || '').trim();
    if (!cmd) {
      return sendJson(req, res, 400, { ok: false, error: 'دستور خالی است.' });
    }

    const workDir = sessionWorkdir(body.session);
    if (workDir !== WORKSPACE_ROOT) {
      await adoptLegacyRoot(workDir);
    }
    await mkdir(workDir, { recursive: true });
    await syncIncomingFiles(workDir, body.files);

    const cwdCheck = await resolveSafeCwd(workDir, body.cwd);
    if (!cwdCheck.ok) {
      return sendJson(req, res, 400, { ok: false, error: cwdCheck.error });
    }

    const isAsyncRoute = pathname === '/jobs' || body.async === true || body.mode === 'async';
    const maxTimeout = isAsyncRoute ? 3_600_000 : 300_000;
    const defaultTimeout = isAsyncRoute ? 300_000 : 60_000;
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || defaultTimeout, 500), maxTimeout);
    const outputLimit = Math.max(256, Math.min(Number(body.limit) || MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS));
    const outputOffset = Math.max(0, Math.floor(Number(body.offset) || 0));

    const beforeMap = await snapshotTextFiles(workDir);
    const job = await startJob({
      cmd,
      workDir,
      cwdDir: cwdCheck.dir,
      cwdRel: cwdCheck.rel,
      session: body.session || '',
      timeoutMs,
      beforeMap
    });

    if (isAsyncRoute) {
      const waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), 30_000);
      if (waitMs > 0) {
        await Promise.race([job.donePromise, new Promise((r) => setTimeout(r, waitMs))]);
      }
      const payload = await formatJobResponse(job, {
        stream: body.stream || 'combined',
        offset: outputOffset,
        limit: outputLimit,
        includeBothStreams: true
      });
      return sendJson(req, res, job.status === 'running' ? 202 : 200, payload);
    }

    // Optional waitMs promotion for `/run`: if command takes longer than waitMs,
    // promote seamlessly to async job instead of blocking/timing out the client!
    const promoteWaitMs = Number(body.waitMs);
    if (Number.isFinite(promoteWaitMs) && promoteWaitMs >= 100 && promoteWaitMs < timeoutMs) {
      await Promise.race([job.donePromise, new Promise((r) => setTimeout(r, promoteWaitMs))]);
      if (job.status === 'running') {
        const payload = await formatJobResponse(job, {
          stream: body.stream || 'combined',
          offset: outputOffset,
          limit: outputLimit,
          includeBothStreams: true
        });
        return sendJson(req, res, 202, { ...payload, promoted: true });
      }
    } else {
      await job.donePromise;
    }

    const payload = await formatJobResponse(job, {
      stream: body.stream || 'combined',
      offset: outputOffset,
      limit: outputLimit,
      includeBothStreams: true
    });
    return sendJson(req, res, 200, payload);
  }

  return sendJson(req, res, 404, { ok: false, error: 'Not found' });
});

function shutdownCleanly() {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.cancelled = true;
      killProcessGroup(job.pgid, 'SIGTERM');
      setTimeout(() => killProcessGroup(job.pgid, 'SIGKILL'), 600).unref?.();
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on('SIGTERM', shutdownCleanly);
process.on('SIGINT', shutdownCleanly);

server.listen(PORT, HOST, () => {
  console.log(`\n✅ CodePilot Runner (${IS_TERMUX ? 'Android Termux' : 'Cloud Linux'}) active!`);
  console.log(`   Listening : http://${HOST}:${PORT}`);
  console.log(`   Workspace : ${WORKSPACE_ROOT}`);
  console.log(`   Auth      : ${TOKEN ? 'Protected (Bearer token active)' : 'WARNING: No CP_TOKEN set'}\n`);
});
