// D1-backed registry of in-flight turns.
//
// The in-isolate `turn-registry.js` gives instant aborts while the request
// lives in the same isolate, but a headless turn (client disconnected, the
// turn kept alive via waitUntil) must also be visible to *other* isolates —
// and stoppable by them. This module is that shared, durable view.
//
// Lifecycle:
//   markTurnActive()    on turn start
//   heartbeatTurnActive() every step (also picks up stop requests)
//   clearTurnActive()   in the finally block, always
//   requestTurnStop()   from /api/chat/stop (works from any isolate)

import { db } from './store.js';

const STALE_MS = 15 * 60 * 1000; // turns far older than maxSteps are zombies

export async function markTurnActive(env, owner, conversationId) {
  const now = Date.now();
  try {
    const database = await db(env);
    await database
      .prepare(
        'INSERT INTO active_turns (conversation_id, owner, started_at, updated_at, stop_requested) ' +
          'VALUES (?, ?, ?, ?, 0) ' +
          'ON CONFLICT(conversation_id) DO UPDATE SET owner=excluded.owner, started_at=excluded.started_at, updated_at=excluded.updated_at, stop_requested=0'
      )
      .bind(String(conversationId), String(owner), now, now)
      .run();
  } catch {
    /* schema not ready / D1 hiccup — the turn still works, just less visible */
  }
}

/** Heartbeat + stop-request probe. Returns true when a stop was requested. */
export async function heartbeatTurnActive(env, owner, conversationId) {
  try {
    const database = await db(env);
    await database
      .prepare('UPDATE active_turns SET updated_at=? WHERE conversation_id=? AND owner=?')
      .bind(Date.now(), String(conversationId), String(owner))
      .run();
    const row = await database
      .prepare('SELECT stop_requested FROM active_turns WHERE conversation_id=? AND owner=?')
      .bind(String(conversationId), String(owner))
      .first();
    return Boolean(row && Number(row.stop_requested) > 0);
  } catch {
    return false;
  }
}

export async function clearTurnActive(env, owner, conversationId) {
  try {
    const database = await db(env);
    await database
      .prepare('DELETE FROM active_turns WHERE conversation_id=? AND owner=?')
      .bind(String(conversationId), String(owner))
      .run();
  } catch {
    /* best effort */
  }
}

/** Ask a running turn (any isolate) to stop gracefully at the next step. */
export async function requestTurnStop(env, owner, conversationId) {
  try {
    const database = await db(env);
    await database
      .prepare('UPDATE active_turns SET stop_requested=1, updated_at=? WHERE conversation_id=? AND owner=?')
      .bind(Date.now(), String(conversationId), String(owner))
      .run();
  } catch {
    /* best effort — the in-isolate registry abort is the fast path anyway */
  }
}

/** Single-conversation probe: is a live (non-stale) turn running here? */
export async function isTurnActive(env, owner, conversationId) {
  try {
    const database = await db(env);
    const row = await database
      .prepare('SELECT updated_at FROM active_turns WHERE conversation_id=? AND owner=?')
      .bind(String(conversationId), String(owner))
      .first();
    return Boolean(row && Number(row.updated_at) > Date.now() - STALE_MS);
  } catch {
    return false;
  }
}

/** Conversations with an in-flight (non-stale) turn for this owner. */
export async function activeTurnConversations(env, owner) {
  try {
    const database = await db(env);
    const rows =
      (
        await database
          .prepare(
            'SELECT conversation_id, started_at FROM active_turns WHERE owner=? AND updated_at > ?'
          )
          .bind(String(owner), Date.now() - STALE_MS)
          .all()
      ).results || [];
    const map = {};
    for (const row of rows) map[String(row.conversation_id)] = Number(row.started_at) || 0;
    return map;
  } catch {
    return {};
  }
}
