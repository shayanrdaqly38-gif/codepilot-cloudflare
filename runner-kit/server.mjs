#!/usr/bin/env node
// CodePilot Universal Linux & Termux Runner (Zero Dependencies, Node >= 18)
// Supports:
//   - Method 2: 24/7 Cloud Container (Hugging Face Spaces Docker on 0.0.0.0:7860, Render, Fly, VPS, Cloudflare Tunnel)
//   - Method 3: Direct Local Android Termux Bridge (127.0.0.1:8787 with Chrome Private Network Access CORS)

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

const IS_TERMUX = Boolean(process.env.TERMUX_VERSION || String(process.env.PREFIX || '').includes('com.termux'));
const PORT = Number(process.env.CP_PORT || process.env.PORT || (IS_TERMUX ? 8787 : 7860));
const HOST = process.env.CP_HOST || process.env.HOST || (IS_TERMUX ? '127.0.0.1' : '0.0.0.0');
const TOKEN = String(process.env.CP_TOKEN || process.env.SANDBOX_TOKEN || '').trim();
const WORKSPACE_ROOT = path.resolve(
  process.env.CP_WORKDIR || path.join(os.homedir(), 'codepilot-workspace')
);

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 48_000;
const MAX_SYNC_FILE_BYTES = 512 * 1024;
const MAX_SYNC_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SYNC_FILES = 60;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.npm', 'dist', 'build', 'target']);

await mkdir(WORKSPACE_ROOT, { recursive: true });

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

// Per-conversation isolated workspaces: parallel CodePilot chats each get
// their own directory so simultaneous `run_command`s never trample each
// other's files. No `session` → the shared root (backward compatible).
const SESSIONS_ROOT = path.join(WORKSPACE_ROOT, 'sessions');

// One-time migration marker: before per-conversation sessions existed, every
// command ran directly in WORKSPACE_ROOT. When the runner is upgraded, an
// existing conversation would suddenly land in a brand-new EMPTY session dir
// and "lose" its on-disk work (git clones, node_modules, binaries...).
// `adoptLegacyRoot()` moves that shared-root content into the first session
// that executes after the upgrade — exactly once, never clobbering files the
// session already has (D1-synced copies are newer).
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
      if (await pathExists(to)) continue; // keep the (newer) session copy
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
    const legacy = entries.filter((e) => e.name !== 'sessions' && e.name !== ADOPT_MARKER);
    await mkdir(sessionDir, { recursive: true });
    if (legacy.length) {
      for (const entry of legacy) {
        const from = path.join(WORKSPACE_ROOT, entry.name);
        const to = path.join(sessionDir, entry.name);
        if (entry.isDirectory()) {
          await mergeMoveDir(from, to);
          await rm(from, { recursive: true, force: true }).catch(() => {});
        } else if (!(await pathExists(to))) {
          // keep the (newer) session copy when both exist
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


async function snapshotTextFiles(dir, relPrefix = '', out = new Map(), budget = { files: 0, bytes: 0 }) {
  if (budget.files >= MAX_SYNC_FILES || budget.bytes >= MAX_SYNC_TOTAL_BYTES) return out;
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
      await snapshotTextFiles(full, rel, out, budget);
    } else if (entry.isFile()) {
      try {
        const st = await stat(full);
        if (st.size > MAX_SYNC_FILE_BYTES) continue;
        const buf = await readFile(full);
        // Skip binary files (NUL byte in first 4KB)
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

function detectShell() {
  if (process.env.SHELL) return process.env.SHELL;
  if (IS_TERMUX && process.env.PREFIX) return path.join(process.env.PREFIX, 'bin', 'bash');
  return '/bin/bash';
}

function execShellCommand(cmd, timeoutMs, cwd = WORKSPACE_ROOT) {
  return new Promise((resolve) => {
    const shell = detectShell();
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const child = spawn(shell, ['-c', cmd], {
      cwd,
      env: { ...process.env, HOME: os.homedir(), TERM: 'xterm-256color' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr + '\n' + (err?.message || 'spawn error')).trim().slice(0, MAX_OUTPUT_CHARS),
        durationMs: Date.now() - started
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        stderr = `${stderr}\n[Timed out after ${Math.round(timeoutMs / 1000)}s]`.trim();
      }
      resolve({
        exitCode: typeof code === 'number' ? code : killedByTimeout ? 124 : 1,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        durationMs: Date.now() - started
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    return res.end();
  }

  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/health')) {
    const requiresAuth = urlObj.pathname === '/health' && Boolean(TOKEN);
    if (requiresAuth && !verifyAuth(req)) {
      return sendJson(req, res, 401, { ok: false, error: 'توکن امنیتی رانر نادرست است (401).' });
    }
    return sendJson(req, res, 200, {
      ok: true,
      service: 'codepilot-runner',
      version: '2.3.1',
      runner: IS_TERMUX ? 'termux' : 'cloud-linux',
      sessions: true,
      authRequired: Boolean(TOKEN),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      node: process.version,
      shell: detectShell()
    });
  }

  if (req.method === 'POST' && (urlObj.pathname === '/' || urlObj.pathname === '/run')) {
    if (!verifyAuth(req)) {
      return sendJson(req, res, 401, { ok: false, error: 'توکن امنیتی رانر نادرست است (401).' });
    }

    let raw = '';
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          return sendJson(req, res, 413, { ok: false, error: 'حجم درخواست بیش از حد مجاز است.' });
        }
        raw += chunk.toString('utf8');
      }
    } catch {
      return sendJson(req, res, 400, { ok: false, error: 'خطا در دریافت بدنه درخواست.' });
    }

    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return sendJson(req, res, 400, { ok: false, error: 'قالب JSON معتبر نیست.' });
    }

    const cmd = String(body.cmd || body.command || '').trim();
    if (!cmd) {
      return sendJson(req, res, 400, { ok: false, error: 'دستور خالی است.' });
    }

    // Isolated per-conversation workspace (parallel chats never collide).
    const workDir = sessionWorkdir(body.session);
    // First sessioned run after an upgrade adopts the pre-sessions shared
    // workspace (one-time, marker-guarded, never clobbers D1-synced files).
    if (workDir !== WORKSPACE_ROOT) {
      await adoptLegacyRoot(workDir);
    }
    await mkdir(workDir, { recursive: true });
    if (body.files && typeof body.files === 'object') {
      for (const [rel, content] of Object.entries(body.files)) {
        if (!isSafeRelPath(rel, workDir)) continue;
        const full = path.resolve(workDir, rel);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, String(content ?? ''), 'utf8');
      }
    }

    const beforeMap = await snapshotTextFiles(workDir);
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 30_000, 2_000), 90_000);
    const execRes = await execShellCommand(cmd, timeoutMs, workDir);
    const afterMap = await snapshotTextFiles(workDir);

    const changedFiles = {};
    const deletedFiles = [];
    for (const [rel, text] of afterMap.entries()) {
      if (!beforeMap.has(rel) || beforeMap.get(rel) !== text) {
        changedFiles[rel] = text;
      }
    }
    for (const rel of beforeMap.keys()) {
      if (!afterMap.has(rel)) {
        deletedFiles.push(rel);
      }
    }

    return sendJson(req, res, 200, {
      ok: execRes.exitCode === 0,
      runner: IS_TERMUX ? 'termux' : 'cloud-linux',
      exitCode: execRes.exitCode,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      durationMs: execRes.durationMs,
      changedFiles,
      deletedFiles
    });
  }

  return sendJson(req, res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`\n✅ CodePilot Runner (${IS_TERMUX ? 'Android Termux' : 'Cloud Linux'}) active!`);
  console.log(`   Listening : http://${HOST}:${PORT}`);
  console.log(`   Workspace : ${WORKSPACE_ROOT}`);
  console.log(`   Auth      : ${TOKEN ? 'Protected (Bearer token active)' : 'WARNING: No CP_TOKEN set'}\n`);
});
