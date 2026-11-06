// Per-owner rate limiting backed by D1.
// Two windows: a short burst guard and a daily ceiling, so a runaway agent loop
// cannot burn the model budget overnight.

import { db } from './store.js';
import { fail } from './util.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

function envInt(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Fixed-window counter: increment and return the new count for that bucket. */
async function bump(env, bucket, windowMs) {
  const database = await db(env);
  const now = Date.now();
  const resetAt = now + windowMs;
  // D1/SQLite: run the upsert, then read the row back. RETURNING works on D1 but
  // reading it explicitly keeps this portable and easier to reason about.
  await database
    .prepare(
      `INSERT INTO rate_limits(bucket,count,reset_at) VALUES(?,1,?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END`
    )
    .bind(bucket, resetAt, now, now)
    .run();
  const row = await database
    .prepare('SELECT count, reset_at FROM rate_limits WHERE bucket=?')
    .bind(bucket)
    .first();
  return row || { count: 1, reset_at: resetAt };
}

/**
 * Throw a 429 when the owner exceeds the configured limits.
 * Limits are deliberately generous for interactive use.
 */
export async function enforceChatLimits(env, owner) {
  // Schema is guaranteed by the caller (route()).
  const perMinute = envInt(env, 'CHAT_LIMIT_PER_MINUTE', 30);
  const perDay = envInt(env, 'CHAT_LIMIT_PER_DAY', 1200);
  const minuteKey = `chat:m:${owner}:${Math.floor(Date.now() / MINUTE)}`;
  const dayKey = `chat:d:${owner}:${new Date().toISOString().slice(0, 10)}`;

  const [minute, day] = await Promise.all([
    bump(env, minuteKey, MINUTE),
    bump(env, dayKey, DAY)
  ]);

  if (Number(minute.count) > perMinute) {
    fail('تعداد درخواست‌ها در دقیقه زیاد است؛ چند لحظه صبر کنید.', 429, 'rate_limited');
  }
  if (Number(day.count) > perDay) {
    fail('سقف روزانه‌ی درخواست‌های مدل پر شده است. فردا دوباره تلاش کنید یا سقف را در Cloudflare بالا ببرید.', 429, 'daily_quota');
  }
  return { minute: Number(minute.count), day: Number(day.count), perMinute, perDay };
}
