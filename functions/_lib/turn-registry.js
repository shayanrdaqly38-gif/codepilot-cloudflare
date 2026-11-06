// In-isolate registry of active `/api/chat` AbortControllers keyed by `${owner}|${conversationId}`.
// Enables instant `POST /api/chat/stop` (including when switching chats on mobile).

const activeTurns = new Map();

function turnKey(owner, conversationId) {
  return `${String(owner || '')}|${String(conversationId || '')}`;
}

export function registerActiveTurn(owner, conversationId) {
  const key = turnKey(owner, conversationId);
  const prev = activeTurns.get(key);
  if (prev && !prev.controller.signal.aborted) {
    try {
      prev.controller.abort(new DOMException('Superseded by newer turn', 'AbortError'));
    } catch {
      /* ignore */
    }
  }
  const controller = new AbortController();
  const entry = { controller, startedAt: Date.now() };
  activeTurns.set(key, entry);
  return {
    controller,
    signal: controller.signal,
    release() {
      if (activeTurns.get(key) === entry) {
        activeTurns.delete(key);
      }
    }
  };
}

export function abortActiveTurn(owner, conversationId) {
  const key = turnKey(owner, conversationId);
  const entry = activeTurns.get(key);
  if (!entry || entry.controller.signal.aborted) {
    activeTurns.delete(key);
    return false;
  }
  try {
    entry.controller.abort(new DOMException('Stopped by user', 'AbortError'));
  } catch {
    /* ignore */
  }
  activeTurns.delete(key);
  return true;
}
