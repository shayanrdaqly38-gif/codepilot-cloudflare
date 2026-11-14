// D1-backed, fenced registry of in-flight turns.
//
// A conversation has at most one live lease. Every admission gets a fresh
// turn_id; heartbeats, Stop and finalization are conditional on that id. The
// lease is renewed by a timer while a model/tool call is in flight, not only at
// agent-step boundaries. Terminal rows are retained for duplicate/status reads.

import { db } from './store.js';

export const TURN_LEASE_MS = 45_000;
export const TURN_HEARTBEAT_MS = 10_000;
const LIVE_STATES = new Set(['running', 'stopping']);
const TERMINAL_STATES = new Set(['completed', 'stopped', 'error']);

export function newTurnId() {
  return crypto.randomUUID();
}

function live(row, now = Date.now()) {
  return Boolean(row && LIVE_STATES.has(String(row.state)) && Number(row.lease_expires_at) > now);
}

/** Atomically acquire a conversation lease. Never supersedes a live turn or a Stop tombstone. */
export async function acquireTurn(env, owner, conversationId, { turnId = newTurnId(), requestId = '' } = {}) {
  const database = await db(env);
  const now = Date.now();
  const result = await database
    .prepare(
      `INSERT INTO active_turns
         (conversation_id, owner, turn_id, request_id, started_at, updated_at, lease_expires_at, stop_requested, state)
       SELECT ?, ?, ?, ?, ?, ?, ?, 0, 'running'
       WHERE NOT EXISTS (
         SELECT 1 FROM turn_requests WHERE owner=? AND request_id=? AND stop_requested=1
       )
       ON CONFLICT(conversation_id) DO UPDATE SET
         owner=excluded.owner,
         turn_id=excluded.turn_id,
         request_id=excluded.request_id,
         started_at=excluded.started_at,
         updated_at=excluded.updated_at,
         lease_expires_at=excluded.lease_expires_at,
         stop_requested=0,
         state='running'
       WHERE active_turns.owner=excluded.owner
         AND (active_turns.state NOT IN ('running','stopping') OR active_turns.lease_expires_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM turn_requests WHERE owner=excluded.owner AND request_id=excluded.request_id AND stop_requested=1
         )`
    )
    .bind(String(conversationId), String(owner), turnId, String(requestId), now, now, now + TURN_LEASE_MS,
      String(owner), String(requestId), now)
    .run();
  if (Number(result?.meta?.changes) > 0) return { acquired: true, turnId };
  const tombstone = requestId
    ? await database.prepare('SELECT stop_requested FROM turn_requests WHERE owner=? AND request_id=?')
      .bind(String(owner), String(requestId)).first()
    : null;
  if (Number(tombstone?.stop_requested)) return { acquired: false, cancelled: true, turnId, requestId };
  const current = await getTurnStatus(env, owner, conversationId);
  return { acquired: false, turnId, current };
}

// Backwards-compatible helper for older tests/callers.
export async function markTurnActive(env, owner, conversationId, options = {}) {
  return acquireTurn(env, owner, conversationId, options);
}

export async function getTurnStatus(env, owner, conversationId) {
  try {
    const database = await db(env);
    const row = await database
      .prepare(
        `SELECT conversation_id, turn_id, request_id, started_at, updated_at, lease_expires_at, stop_requested, state
         FROM active_turns WHERE conversation_id=? AND owner=?`
      )
      .bind(String(conversationId), String(owner))
      .first();
    if (!row) return null;
    return {
      conversationId: String(row.conversation_id),
      turnId: String(row.turn_id || ''),
      requestId: String(row.request_id || ''),
      startedAt: Number(row.started_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      leaseExpiresAt: Number(row.lease_expires_at) || 0,
      stopRequested: Boolean(Number(row.stop_requested)),
      state: String(row.state || ''),
      active: live(row)
    };
  } catch {
    return null;
  }
}

/** Renew only a live, unfenced, un-stopped lease. */
export async function heartbeatTurn(env, owner, conversationId, turnId) {
  const database = await db(env);
  const now = Date.now();
  const result = await database
    .prepare(
      `UPDATE active_turns SET updated_at=?, lease_expires_at=?
       WHERE conversation_id=? AND owner=? AND turn_id=? AND state='running'
         AND stop_requested=0 AND lease_expires_at>?`
    )
    .bind(now, now + TURN_LEASE_MS, String(conversationId), String(owner), String(turnId), now)
    .run();
  if (Number(result?.meta?.changes) > 0) return { ok: true, stopped: false, lost: false };
  const current = await database
    .prepare('SELECT turn_id, state, stop_requested, lease_expires_at FROM active_turns WHERE conversation_id=? AND owner=?')
    .bind(String(conversationId), String(owner))
    .first();
  if (current && String(current.turn_id) === String(turnId) &&
      (Number(current.stop_requested) || String(current.state) === 'stopping')) {
    return { ok: true, stopped: true, lost: false };
  }
  return { ok: false, stopped: false, lost: true };
}

export async function heartbeatTurnActive(env, owner, conversationId, turnId = '') {
  let id = turnId;
  if (!id) id = (await getTurnStatus(env, owner, conversationId))?.turnId || '';
  if (!id) return false;
  const result = await heartbeatTurn(env, owner, conversationId, id);
  return Boolean(result.stopped);
}

/** Timer-backed liveness. Aborts the local runner on Stop or loss of ownership. */
export function startTurnHeartbeat(env, owner, conversationId, turnId, controller) {
  let running = false;
  const tick = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const result = await heartbeatTurn(env, owner, conversationId, turnId);
      if (controller.signal.aborted) return;
      if (result.stopped) {
        controller.abort(Object.assign(new Error('اجرای پاسخ توسط کاربر متوقف شد.'), { code: 'turn_stopped' }));
      } else if (result.lost) {
        controller.abort(Object.assign(new Error('مالکیت این نوبت از دست رفت.'), { code: 'turn_lease_lost' }));
      }
    } catch {
      // A transient D1 error does not authorize a new owner; the lease still
      // expires server-side. The next tick retries the fenced heartbeat.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TURN_HEARTBEAT_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  tick();
  return () => clearInterval(timer);
}

/** Terminal transition, fenced by turn_id. Also settles the idempotency ledger. */
export async function releaseTurn(env, owner, conversationId, turnId, state = 'completed', outcome = {}) {
  const safeState = TERMINAL_STATES.has(state) ? state : 'completed';
  try {
    const database = await db(env);
    const now = Date.now();
    const safeOutcome = JSON.stringify(outcome && typeof outcome === 'object' ? outcome : {}).slice(0, 12_000);
    await database.batch([
      database.prepare(
        `UPDATE active_turns SET state=?, lease_expires_at=0, updated_at=?
         WHERE conversation_id=? AND owner=? AND turn_id=?`
      ).bind(safeState, now, String(conversationId), String(owner), String(turnId)),
      database.prepare(
        `UPDATE turn_requests SET state=?, outcome=?, updated_at=?
         WHERE owner=? AND conversation_id=? AND turn_id=?`
      ).bind(safeState, safeOutcome, now, String(owner), String(conversationId), String(turnId))
    ]);
  } catch {
    // The lease still expires; finalization is best-effort after a hard exit.
  }
}

// Legacy cleanup helper. New chat code uses releaseTurn(..., turnId).
export async function clearTurnActive(env, owner, conversationId, turnId = '') {
  try {
    const database = await db(env);
    const sql = turnId
      ? 'DELETE FROM active_turns WHERE conversation_id=? AND owner=? AND turn_id=?'
      : 'DELETE FROM active_turns WHERE conversation_id=? AND owner=?';
    const stmt = database.prepare(sql);
    await (turnId
      ? stmt.bind(String(conversationId), String(owner), String(turnId))
      : stmt.bind(String(conversationId), String(owner))).run();
  } catch { /* best effort */ }
}

/** Durable Stop. Never refreshes updated_at/lease_expires_at. */
export async function requestTurnStop(env, owner, conversationId, { turnId = '', requestId = '' } = {}) {
  const database = await db(env);
  const current = await getTurnStatus(env, owner, conversationId);
  let target = turnId;
  if (target && current?.turnId !== target) {
    return { ok: true, requested: false, settled: false, stale: true, turnId: current?.turnId || '', state: current?.state || 'idle' };
  }
  if (!target) {
    if (current?.active && (!requestId || current.requestId === requestId)) target = current.turnId;
    else if (current && !current.active && (!requestId || current.requestId === requestId)) {
      return { ok: true, requested: false, settled: true, turnId: current.turnId, state: current.state };
    }
  }
  if (target) {
    const result = await database
      .prepare(
        `UPDATE active_turns SET stop_requested=1, state='stopping'
         WHERE conversation_id=? AND owner=? AND turn_id=? AND state IN ('running','stopping') AND lease_expires_at>?`
      )
      .bind(String(conversationId), String(owner), String(target), Date.now())
      .run();
    if (Number(result?.meta?.changes) > 0) {
      if (current?.requestId) {
        await database.prepare(
          `UPDATE turn_requests SET stop_requested=1, updated_at=? WHERE owner=? AND request_id=? AND turn_id=?`
        ).bind(Date.now(), String(owner), current.requestId, String(target)).run().catch(() => {});
      }
      return { ok: true, requested: true, settled: false, turnId: String(target), state: 'stopping' };
    }
  }
  if (requestId) {
    await database
      .prepare(
        `INSERT INTO turn_requests(owner, request_id, conversation_id, turn_id, payload_hash, stop_requested, created_at, updated_at, state)
         VALUES (?, ?, ?, '', '', 1, ?, ?, 'stopping')
         ON CONFLICT(owner, request_id) DO UPDATE SET stop_requested=1, updated_at=excluded.updated_at
         WHERE turn_requests.conversation_id=excluded.conversation_id`
      )
      .bind(String(owner), String(requestId), String(conversationId), Date.now(), Date.now())
      .run();
    return { ok: true, requested: true, settled: false, pending: true, requestId, state: 'stopping' };
  }
  return { ok: true, requested: false, settled: true, turnId: target || '', state: 'idle' };
}

export async function isTurnActive(env, owner, conversationId) {
  const status = await getTurnStatus(env, owner, conversationId);
  return Boolean(status?.active);
}

export async function activeTurnConversations(env, owner) {
  try {
    const database = await db(env);
    const rows = (
      await database
        .prepare(
          `SELECT conversation_id, started_at FROM active_turns
           WHERE owner=? AND state IN ('running','stopping') AND lease_expires_at>?`
        )
        .bind(String(owner), Date.now())
        .all()
    ).results || [];
    const map = {};
    for (const row of rows) map[String(row.conversation_id)] = Number(row.started_at) || 0;
    return map;
  } catch {
    return {};
  }
}

export { clearTurnCheckpointForTurn } from './checkpoint.js';

/**
 * Idempotent admission. Returns one of:
 *   { status:'acquired', turnId }
 *   { status:'active', current }
 *   { status:'replay', record }
 * A retry of a settled request never re-enters the model loop.
 */
export async function admitTurnRequest(env, owner, conversationId, { requestId, payloadHash = '' } = {}) {
  const database = await db(env);
  // Bounded retention cleanup; the ledger is for transport retries/recovery,
  // not permanent history. Seven days matches the checkpoint TTL.
  await database.prepare(
    `DELETE FROM turn_requests WHERE rowid IN (
       SELECT rowid FROM turn_requests WHERE owner=? AND created_at<? LIMIT 200
     )`
  ).bind(String(owner), Date.now() - 7 * 24 * 60 * 60 * 1000).run().catch(() => {});
  const existing = await database
    .prepare('SELECT * FROM turn_requests WHERE owner=? AND request_id=?')
    .bind(String(owner), String(requestId))
    .first();
  if (existing) {
    if (String(existing.conversation_id) !== String(conversationId) ||
        (existing.payload_hash && payloadHash && String(existing.payload_hash) !== String(payloadHash))) {
      return { status: 'conflict' };
    }
    if (Number(existing.stop_requested)) {
      return { status: 'replay', record: { ...existing, state: 'stopped', outcome: '{"code":"turn_stopped","resumable":true}' } };
    }
    if (TERMINAL_STATES.has(String(existing.state))) return { status: 'replay', record: existing };
    const current = await getTurnStatus(env, owner, conversationId);
    if (current?.active && current.turnId === String(existing.turn_id)) return { status: 'active', current };
    // The Worker died before finalizing. Expose the expired lease as an error;
    // do not silently spend another model call under the same request id.
    const outcome = { code: 'turn_lease_expired', resumable: true };
    await releaseTurn(env, owner, conversationId, String(existing.turn_id), 'error', outcome);
    return { status: 'replay', record: { ...existing, state: 'error', outcome: JSON.stringify(outcome) } };
  }
  const turnId = newTurnId();
  const lease = await acquireTurn(env, owner, conversationId, { turnId, requestId });
  if (lease.cancelled) return { status: 'replay', record: { state: 'stopped', turn_id: '', outcome: '{"code":"turn_stopped","resumable":true}' } };
  if (!lease.acquired) return { status: 'active', current: lease.current };
  const now = Date.now();
  await database.prepare(
    `INSERT INTO turn_requests(owner, request_id, conversation_id, turn_id, payload_hash, stop_requested, created_at, updated_at, state)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'running')
     ON CONFLICT(owner, request_id) DO NOTHING`
  ).bind(String(owner), String(requestId), String(conversationId), turnId, String(payloadHash), now, now).run();
  const settled = await database.prepare('SELECT * FROM turn_requests WHERE owner=? AND request_id=?')
    .bind(String(owner), String(requestId)).first();
  if (Number(settled?.stop_requested)) {
    await releaseTurn(env, owner, conversationId, turnId, 'stopped', { code: 'turn_stopped', resumable: true });
    return { status: 'replay', record: { ...settled, state: 'stopped', outcome: '{"code":"turn_stopped","resumable":true}' } };
  }
  return { status: 'acquired', turnId };
}
