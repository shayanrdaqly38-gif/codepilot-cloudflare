// Shared outbound model-call budget. This counts HTTP attempts, not /api/chat
// POSTs: retries, key-pool rotations, fallback models, summaries and health
// probes all pass through the same reservation path in model.js.
//
// D1 is the authority across isolates. The reservation is one atomic
// INSERT ... SELECT: rolling 60s starts + unexpired in-flight leases + cooldown
// are checked together. A denied reservation never reaches fetch().

import { db } from './store.js';
import { sha256Hex } from './util.js';

const MINUTE = 60_000;
const DEFAULT_PER_MINUTE = 20;
const DEFAULT_MAX_INFLIGHT = 4;

function envInt(env, name, fallback, max) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

export function providerBudgetConfig(env) {
  return {
    perMinute: envInt(env, 'MODEL_CALLS_PER_MINUTE', DEFAULT_PER_MINUTE, 600),
    maxInflight: envInt(env, 'PROVIDER_MAX_INFLIGHT', DEFAULT_MAX_INFLIGHT, 20)
  };
}

export async function providerBucketForCredential(apiKey) {
  // Scope by credential, not owner or gateway URL: two app users / two URLs
  // backed by the same provider key still share that key's real quota.
  const digest = await sha256Hex(String(apiKey || ''));
  return `provider:${digest.slice(0, 32)}`;
}

export function parseRetryAfterMs(headers, now = Date.now()) {
  const raw = String(headers?.get?.('retry-after') || headers?.get?.('x-ratelimit-reset-requests') || '').trim();
  if (!raw) return 0;
  const seconds = Number(raw.replace(/s$/i, ''));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// Isolate-local fallback only for unit/dev callers without a D1 binding.
// Production chat always has DB; cross-isolate enforcement uses D1 below.
const localBudgets = new Map();

async function reserveLocal(bucket, config, leaseMs) {
  const now = Date.now();
  let state = localBudgets.get(bucket);
  if (!state) {
    state = { starts: [], inflight: new Map(), cooldownUntil: 0 };
    localBudgets.set(bucket, state);
  }
  state.starts = state.starts.filter((t) => now - t < MINUTE);
  for (const [id, expires] of state.inflight) if (expires <= now) state.inflight.delete(id);
  const retryAfterMs = Math.max(
    state.cooldownUntil - now,
    state.starts.length >= config.perMinute ? state.starts[0] + MINUTE - now : 0,
    state.inflight.size >= config.maxInflight ? Math.min(...state.inflight.values()) - now : 0
  );
  if (retryAfterMs > 0) return { allowed: false, bucket, retryAfterMs: Math.max(1, retryAfterMs) };
  const callId = crypto.randomUUID();
  state.starts.push(now);
  state.inflight.set(callId, now + leaseMs);
  return {
    allowed: true,
    bucket,
    callId,
    release: async () => { state.inflight.delete(callId); }
  };
}

export async function reserveProviderCall(env, { apiKey, timeoutMs = 180_000, signal } = {}) {
  const key = String(apiKey || env?.MODEL_API_KEY || '');
  const bucket = await providerBucketForCredential(key);
  const config = providerBudgetConfig(env);
  const leaseMs = Math.min(Math.max(Number(timeoutMs) || 180_000, 1_000) + 5_000, 190_000);
  if (signal?.aborted) return { allowed: false, bucket, aborted: true, retryAfterMs: 0 };
  if (!env?.DB) return reserveLocal(bucket, config, leaseMs);

  const database = await db(env);
  const now = Date.now();
  const callId = crypto.randomUUID();
  // Bounded cleanup: old rows are irrelevant to the rolling minute. The index
  // on (bucket, started_at) keeps this proportional to recent attempts.
  await database.prepare('DELETE FROM provider_calls WHERE bucket=? AND started_at<?')
    .bind(bucket, now - MINUTE).run();
  const result = await database
    .prepare(
      `INSERT INTO provider_calls(call_id, bucket, started_at, expires_at, state)
       SELECT ?, ?, ?, ?, 'running'
       WHERE (SELECT COUNT(*) FROM provider_calls WHERE bucket=? AND started_at>?) < ?
         AND (SELECT COUNT(*) FROM provider_calls WHERE bucket=? AND state='running' AND expires_at>?) < ?
         AND (SELECT COALESCE(MAX(cooldown_until),0) FROM provider_limits WHERE bucket=?) <= ?`
    )
    .bind(callId, bucket, now, now + leaseMs,
      bucket, now - MINUTE, config.perMinute,
      bucket, now, config.maxInflight,
      bucket, now)
    .run();
  if (Number(result?.meta?.changes) > 0) {
    let released = false;
    return {
      allowed: true,
      bucket,
      callId,
      release: async () => {
        if (released) return;
        released = true;
        await database.prepare("UPDATE provider_calls SET state='released' WHERE call_id=? AND state='running'")
          .bind(callId).run().catch(() => {});
      }
    };
  }
  const [cooldown, oldest, inflight] = await Promise.all([
    database.prepare('SELECT cooldown_until FROM provider_limits WHERE bucket=?').bind(bucket).first(),
    database.prepare('SELECT started_at FROM provider_calls WHERE bucket=? AND started_at>? ORDER BY started_at ASC LIMIT 1')
      .bind(bucket, now - MINUTE).first(),
    database.prepare("SELECT MIN(expires_at) AS expires_at FROM provider_calls WHERE bucket=? AND state='running' AND expires_at>?")
      .bind(bucket, now).first()
  ]);
  const count = await database.prepare('SELECT COUNT(*) AS n FROM provider_calls WHERE bucket=? AND started_at>?')
    .bind(bucket, now - MINUTE).first();
  const running = await database.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE bucket=? AND state='running' AND expires_at>?")
    .bind(bucket, now).first();
  const retryAfterMs = Math.max(
    Number(cooldown?.cooldown_until || 0) - now,
    Number(count?.n || 0) >= config.perMinute && oldest ? Number(oldest.started_at) + MINUTE - now : 0,
    Number(running?.n || 0) >= config.maxInflight && inflight?.expires_at ? Number(inflight.expires_at) - now : 0,
    1
  );
  return { allowed: false, bucket, retryAfterMs };
}

export async function recordProviderCooldown(env, bucket, retryAfterMs) {
  const ms = Math.max(0, Math.min(Number(retryAfterMs) || 0, 24 * 60 * 60 * 1000));
  if (!ms) return;
  const until = Date.now() + ms;
  if (!env?.DB) {
    const state = localBudgets.get(bucket);
    if (state) state.cooldownUntil = Math.max(state.cooldownUntil, until);
    return;
  }
  const database = await db(env);
  await database.prepare(
    `INSERT INTO provider_limits(bucket, cooldown_until) VALUES(?, ?)
     ON CONFLICT(bucket) DO UPDATE SET cooldown_until=MAX(provider_limits.cooldown_until, excluded.cooldown_until)`
  ).bind(bucket, until).run();
}
