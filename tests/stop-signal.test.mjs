// Stop-signal propagation: when a turn is aborted (user stop / superseded by a
// newer turn), every external tool (web_search, fetch_url, run_command) must
// cancel immediately — never waiting for its own network timeout — and the
// in-isolate turn registry must stay exactly consistent.
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerActiveTurn, abortActiveTurn } from '../functions/_lib/turn-registry.js';
import { fetchExternalUrl, searchWeb } from '../functions/_lib/web.js';
import { runCommand } from '../functions/_lib/sandbox.js';

test('turn registry: register supersedes a previous live turn (aborts it)', () => {
  const first = registerActiveTurn('owner-1', 'conv-1');
  assert.equal(first.signal.aborted, false, 'first turn starts alive');

  const second = registerActiveTurn('owner-1', 'conv-1');
  assert.equal(first.signal.aborted, true, 'first turn aborted by newer turn');
  assert.equal(second.signal.aborted, false, 'second turn is the live one');

  // Aborting the live turn reports `stopped: true` exactly once.
  const stopped = abortActiveTurn('owner-1', 'conv-1');
  assert.equal(stopped, true);
  assert.equal(second.signal.aborted, true);

  // A second stop finds no live turn → reports false (idempotent).
  const stoppedAgain = abortActiveTurn('owner-1', 'conv-1');
  assert.equal(stoppedAgain, false);

  // Releasing an already-removed entry is a no-op.
  second.release();
});

test('turn registry: independent owners/conversations do not interfere', () => {
  const a = registerActiveTurn('owner-a', 'conv-1');
  const b = registerActiveTurn('owner-b', 'conv-1');
  const c = registerActiveTurn('owner-a', 'conv-2');
  assert.equal(a.signal.aborted, false);
  assert.equal(b.signal.aborted, false);
  assert.equal(c.signal.aborted, false);
  abortActiveTurn('owner-a', 'conv-1');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false, 'other owner unaffected');
  assert.equal(c.signal.aborted, false, 'other conversation unaffected');
});

test('fetch_url: pre-aborted signal cancels before any network traffic', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must never be touched');
  };
  try {
    const controller = new AbortController();
    controller.abort();
    const out = await fetchExternalUrl({}, { url: 'https://example.com', externalSignal: controller.signal });
    assert.equal(out.ok, false);
    assert.match(out.text, /Cancelled by user/);
    assert.equal(fetchCalls, 0, 'no fetch call happened');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch_url: pre-aborted signal wins even over blocked/malformed inputs', async () => {
  const controller = new AbortController();
  controller.abort();
  // Even an empty URL must not reach the network — cancellation is checked first.
  const out = await fetchExternalUrl({}, { url: '', externalSignal: controller.signal });
  assert.equal(out.ok, false);
  assert.match(out.text, /Cancelled by user/);
});

test('web_search: pre-aborted signal cancels with zero search requests', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must never be touched');
  };
  try {
    const controller = new AbortController();
    controller.abort();
    const out = await searchWeb({}, { query: 'test query', externalSignal: controller.signal });
    assert.equal(out.ok, false);
    assert.deepEqual(out.results, []);
    assert.match(out.text, /Cancelled by user/);
    assert.equal(fetchCalls, 0, 'no search request happened');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('web_search: pre-aborted signal cancels before validation can reject', async () => {
  const controller = new AbortController();
  controller.abort();
  const out = await searchWeb({}, { query: '', externalSignal: controller.signal });
  assert.equal(out.ok, false);
  assert.match(out.text, /Cancelled by user/);
});

test('run_command: pre-aborted signal never dispatches to any runner tier', async () => {
  const controller = new AbortController();
  controller.abort();
  const out = await runCommand({}, { command: 'echo hi', workspace: {}, externalSignal: controller.signal });
  assert.equal(out.mode, 'stopped');
  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 130);
  assert.match(out.text, /Cancelled by user/);
});

test('run_command: normal command still works when no external signal is given', async () => {
  const out = await runCommand({}, { command: 'echo hi', workspace: {} });
  assert.equal(out.mode, 'virtual');
  assert.equal(out.ok, true);
});
