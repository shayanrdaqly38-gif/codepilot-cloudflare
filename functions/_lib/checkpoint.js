// Durable turn checkpoints stored in Cloudflare D1 (`meta` table) so that if a
// turn is interrupted mid-flight (API token/quota exhausted, upstream SSE cutoff,
// timeout, output length cap, or step ceiling), ZERO progress is lost:
//   - Completed tool edits stay saved in `conversations.workspace`.
//   - Streamed partial prose/code up to the exact cutoff character is saved in `messages`.
//   - When the user swaps in a fresh API token and writes «ادامه» (or clicks Resume),
//     the agent resumes from the EXACT cutoff point without restarting from step 1.

import { ensureSchema } from './schema.js';
import { envSecrets, redactSecrets, sha256Hex, truncate } from './util.js';

const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const RESUME_EXACT_PHRASES = new Set([
  'ادامه',
  'ادامه بده',
  'ادامش بده',
  'ادامه اش بده',
  'ادامه کار',
  'ادامه کد',
  'ادامه لطفا',
  'لطفا ادامه بده',
  'بقیه',
  'بقیه اش',
  'بقیه ش',
  'بقیه کار',
  'کامل کن',
  'کاملش کن',
  'تمام کن',
  'تمامش کن',
  'تمومش کن',
  'از ادامه',
  'از همونجا ادامه بده',
  'از همانجا ادامه بده',
  'از جایی که قطع شد',
  'از جایی که قطع شد ادامه بده',
  'continue',
  'resume',
  'keep going',
  'go on',
  'finish it',
  '/continue',
  '/resume'
]);

export function normalizeResumeInput(rawText) {
  return String(rawText || '')
    .replace(/[\u200c\u200f\u200e]/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[.!؟?،,;:'"«»()[\]{}_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Detect whether the user's message is asking to continue/resume an interrupted turn.
 */
export function isResumePrompt(rawText) {
  const norm = normalizeResumeInput(rawText);
  if (!norm || norm.length > 90) return false;
  if (RESUME_EXACT_PHRASES.has(norm)) return true;
  if (/^(?:\/continue|\/resume)\b/.test(norm)) return true;
  if (/^(?:ادامه|بقیه|continue|resume)(?:\s+(?:بده|بدید|لطفا|کار|کد|از\s+.*|همین.*|همان.*|please|from\s+.*))?$/.test(norm)) {
    return true;
  }
  return false;
}

async function ckptMetaKey(owner, conversationId) {
  const digest = await sha256Hex(`${owner}:${conversationId}`);
  return `ckpt:${digest.slice(0, 28)}`;
}

/**
 * Extract the target file/command/query from an incomplete/truncated tool call
 * if the upstream stream dropped while streaming `function.arguments`.
 */
export function extractPartialToolTarget(rawToolCalls) {
  if (!Array.isArray(rawToolCalls) || !rawToolCalls.length) return null;
  const last = rawToolCalls[rawToolCalls.length - 1];
  const name = String(last?.function?.name || '').trim();
  const argsRaw = String(last?.function?.arguments || '');
  if (!name) return null;

  let targetPath = '';
  const pathMatch = argsRaw.match(/"path"\s*:\s*"([^"\\]{1,200})"/);
  const cmdMatch = argsRaw.match(/"command"\s*:\s*"([^"\\]{1,140})"/);
  const queryMatch = argsRaw.match(/"query"\s*:\s*"([^"\\]{1,140})"/);
  if (pathMatch) targetPath = pathMatch[1];
  else if (cmdMatch) targetPath = cmdMatch[1];
  else if (queryMatch) targetPath = queryMatch[1];

  return {
    name: name.slice(0, 64),
    targetPath: targetPath.slice(0, 200),
    argsChars: argsRaw.length
  };
}

export async function loadTurnCheckpoint(env, owner, conversationId) {
  if (!env?.DB || !owner || !conversationId) return null;
  await ensureSchema(env);
  const key = await ckptMetaKey(owner, conversationId);
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || !parsed.active) return null;
    if (parsed.interruptedAt && Date.now() - parsed.interruptedAt > CHECKPOINT_TTL_MS) {
      await clearTurnCheckpoint(env, owner, conversationId).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveTurnCheckpoint(env, owner, conversationId, data = {}) {
  if (!env?.DB || !owner || !conversationId) return null;
  await ensureSchema(env);
  const key = await ckptMetaKey(owner, conversationId);
  const secrets = envSecrets(env);
  const prev = data.prevCheckpoint && typeof data.prevCheckpoint === 'object' ? data.prevCheckpoint : null;

  const mergedTouched = [
    ...new Set([
      ...(Array.isArray(prev?.touchedFiles) ? prev.touchedFiles : []),
      ...(Array.isArray(data.touchedFiles) ? data.touchedFiles : [])
    ])
  ]
    .filter((p) => typeof p === 'string' && p && !p.startsWith('('))
    .slice(0, 80);

  const mergedDeleted = [
    ...new Set([
      ...(Array.isArray(prev?.deletedFiles) ? prev.deletedFiles : []),
      ...(Array.isArray(data.deletedFiles) ? data.deletedFiles : [])
    ])
  ]
    .filter((p) => typeof p === 'string' && p)
    .slice(0, 40);

  const mergedTools = [
    ...(Array.isArray(prev?.completedTools) ? prev.completedTools : []),
    ...(Array.isArray(data.completedTools) ? data.completedTools : [])
  ].slice(-30);

  const partialRaw = typeof data.partialContent === 'string' ? redactSecrets(data.partialContent, secrets) : '';
  const record = {
    active: true,
    turnId: String(data.turnId || prev?.turnId || '').slice(0, 80),
    originalGoal: truncate(
      redactSecrets(String(prev?.originalGoal || data.originalGoal || '').trim(), secrets),
      2_500
    ),
    interruptedAt: Date.now(),
    reason: String(data.reason || 'interrupted').slice(0, 48),
    errorCode: String(data.errorCode || '').slice(0, 48),
    errorMessage: truncate(redactSecrets(String(data.errorMessage || ''), secrets), 320),
    completedSteps: (Number(prev?.completedSteps) || 0) + (Number(data.stepsCompleted) || 0),
    waveNumber: Number(data.waveNumber) || (Number(prev?.waveNumber) || 0),
    resumeCount: (Number(prev?.resumeCount) || 0) + (prev ? 1 : 0),
    touchedFiles: mergedTouched,
    deletedFiles: mergedDeleted,
    completedTools: mergedTools,
    interruptedToolCall: data.interruptedToolCall || null,
    pendingLocalExec: data.pendingLocalExec || null,
    partialTextTail: partialRaw ? partialRaw.slice(-1_400) : '',
    partialTextChars: partialRaw ? partialRaw.length : 0
  };

  if (record.turnId) {
    const lease = await env.DB.prepare('SELECT turn_id FROM active_turns WHERE conversation_id=? AND owner=?')
      .bind(String(conversationId), String(owner)).first();
    if (lease?.turn_id && String(lease.turn_id) !== record.turnId) return null;
  }
  await env.DB.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  )
    .bind(key, JSON.stringify(record))
    .run();

  return record;
}

export async function clearTurnCheckpoint(env, owner, conversationId) {
  if (!env?.DB || !owner || !conversationId) return;
  await ensureSchema(env);
  const key = await ckptMetaKey(owner, conversationId);
  await env.DB.prepare('DELETE FROM meta WHERE key=?').bind(key).run();
}

/** A stale runner may not delete a checkpoint belonging to a newer turn. */
export async function clearTurnCheckpointForTurn(env, owner, conversationId, turnId) {
  if (!env?.DB || !owner || !conversationId || !turnId) return false;
  await ensureSchema(env);
  const key = await ckptMetaKey(owner, conversationId);
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(key).first();
  if (!row?.value) return true;
  let parsed = null;
  try { parsed = JSON.parse(row.value); } catch { /* malformed legacy row */ }
  const lease = await env.DB.prepare('SELECT turn_id FROM active_turns WHERE conversation_id=? AND owner=?')
    .bind(String(conversationId), String(owner)).first();
  // The caller may clear when it owns the current/final lease, even if the
  // stored checkpoint was written by the previous wave it is resuming.
  const ownsLease = String(lease?.turn_id || '') === String(turnId);
  if (parsed?.turnId && parsed.turnId !== turnId && !ownsLease) return false;
  await env.DB.prepare('DELETE FROM meta WHERE key=?').bind(key).run();
  return true;
}

/**
 * Build an authoritative wire-level continuation briefing injected when the user
 * writes «ادامه» after an interruption or API token swap.
 */
export function buildCheckpointResumeDirective(ckpt, workspace) {
  if (!ckpt || typeof ckpt !== 'object' || ckpt.skipResumeDirective) return '';
  const files = workspace?.files || {};
  const savedFilesSummary = (ckpt.touchedFiles || [])
    .map((p) => (files[p] !== undefined ? `${p} (${String(files[p]).length} chars — saved)` : `${p}`))
    .join(', ');

  const lines = [
    '[EXACT CHECKPOINT RESUME — ادامه دقیق از نقطه قطع‌شدن]',
    `- هدف اصلی در حال اجرا (Original Task): ${ckpt.originalGoal || '(طبق پیام‌های قبلی گفتگو)'}`,
    `- علت توقف قبلی: ${ckpt.reason || 'interrupted'}${ckpt.errorMessage ? ` (${ckpt.errorMessage})` : ''}`,
    `- گام‌های انجام‌شده تا این لحظه: ${ckpt.completedSteps || 0} گام`
  ];

  if (savedFilesSummary) {
    lines.push(`- فایل‌های ساخته‌شده/ویرایش‌شده که هم‌اکنون در Workspace ذخیره‌اند: ${savedFilesSummary}`);
  }
  if (Array.isArray(ckpt.completedTools) && ckpt.completedTools.length) {
    lines.push(`- عملیات‌های تکمیل‌شده قبلی: ${ckpt.completedTools.join(' → ')}`);
  }
  if (ckpt.interruptedToolCall?.name) {
    const t = ckpt.interruptedToolCall;
    lines.push(
      `- عملیات ناتمام در لحظه قطع‌شدن: ابزار \`${t.name}\`${t.targetPath ? ` روی «${t.targetPath}»` : ''} وسط استریم قطع شد و اجرا نشد. ابتدا وضعیت فعلی فایل‌ها را در صورت نیاز با \`read_file\` ببین و دقیقاً از همین مرحله ادامه بده.`
    );
  }
  if (ckpt.partialTextTail) {
    lines.push(
      `- متن/کد قبلی تا ${ckpt.partialTextChars} کاراکتر نوشته شد و دقیقاً در انتهای قطعه زیر قطع شد:`,
      '<cutoff_point>',
      ckpt.partialTextTail,
      '</cutoff_point>',
      '- دستور قطعی برای ادامه متن: هرگز از اول شروع نکن، سلام و مقدمه ننویس و بخش‌های قبلی را تکرار نکن! دقیقاً از کاراکتر/خط بعدیِ پس از `</cutoff_point>` ادامه بده و کار را کامل کن.'
    );
  } else {
    lines.push(
      '- دستور قطعی برای ادامه کار: هرگز کار را از اول شروع نکن و فایل‌هایی را که کامل و سالم ذخیره شده‌اند بی‌دلیل بازنویسی نکن! دقیقاً از مرحله‌ی بعدیِ باقی‌مانده کار را ادامه بده تا هدف اصلی ۱۰۰٪ کامل شود.'
    );
  }

  return lines.join('\n');
}
