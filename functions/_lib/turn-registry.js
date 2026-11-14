// In-isolate registry of active `/api/chat` AbortControllers keyed by
// `${owner}|${conversationId}`. Entries carry the D1 turn_id so a Stop aimed at
// an old turn cannot abort a replacement that happens to share the conversation.

const activeTurns = new Map();

function turnKey(owner, conversationId) {
  return `${String(owner || '')}|${String(conversationId || '')}`;
}

export function registerActiveTurn(owner, conversationId, turnId = '') {
  const key = turnKey(owner, conversationId);
  const prev = activeTurns.get(key);
  // D1 admission prevents overlapping live leases. If a previous local entry
  // still exists here, its lease expired/was superseded; abort it defensively.
  if (prev && !prev.controller.signal.aborted) {
    try {
      prev.controller.abort(Object.assign(new Error('Turn lease superseded'), { code: 'turn_lease_lost' }));
    } catch { /* ignore */ }
  }
  const controller = new AbortController();
  const entry = { controller, turnId: String(turnId || ''), startedAt: Date.now() };
  activeTurns.set(key, entry);
  return {
    controller,
    signal: controller.signal,
    turnId: entry.turnId,
    release() {
      if (activeTurns.get(key) === entry) activeTurns.delete(key);
    }
  };
}

export function abortActiveTurn(owner, conversationId, turnId = '') {
  const key = turnKey(owner, conversationId);
  const entry = activeTurns.get(key);
  if (!entry) return false;
  if (turnId && entry.turnId && String(turnId) !== entry.turnId) return false;
  if (entry.controller.signal.aborted) {
    activeTurns.delete(key);
    return false;
  }
  try {
    entry.controller.abort(Object.assign(new Error('Stopped by user'), { code: 'turn_stopped' }));
  } catch { /* ignore */ }
  activeTurns.delete(key);
  return true;
}
