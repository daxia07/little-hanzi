import test from 'node:test';
import assert from 'node:assert/strict';
import { clearPendingSignOut, clearPilotPrivateState, hasPendingSignOut, markPendingSignOut } from '../lib/pilot-client.ts';

function storage(entries = []) {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('[S2-AC-008] pilot cleanup preserves an unfinished sign-out and unrelated family recovery', () => {
  const previous = globalThis.window;
  const local = storage([
    ['little-hanzi:pilot:account-a:outbox', 'synthetic pending action'],
    ['little-hanzi:forest:last-run', 'existing-owner-preview'],
  ]);
  const session = storage([['little-hanzi:pilot:account-a:projection', 'synthetic projection']]);
  globalThis.window = { localStorage: local, sessionStorage: session };
  try {
    assert.equal(markPendingSignOut(), true);
    assert.equal(clearPilotPrivateState(), true);
    assert.equal(local.getItem('little-hanzi:pilot:account-a:outbox'), null);
    assert.equal(session.getItem('little-hanzi:pilot:account-a:projection'), null);
    assert.equal(hasPendingSignOut(), true);
    assert.equal(local.getItem('little-hanzi:forest:last-run'), 'existing-owner-preview');
    assert.equal(clearPendingSignOut(), true);
    assert.equal(hasPendingSignOut(), false);
    assert.equal(local.getItem('little-hanzi:forest:last-run'), 'existing-owner-preview');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('[S2-AC-012] denied browser storage cannot report successful private-state cleanup', () => {
  const previous = globalThis.window;
  globalThis.window = {
    get localStorage() { throw new Error('Synthetic storage denial'); },
    get sessionStorage() { throw new Error('Synthetic storage denial'); },
  };
  try {
    assert.equal(markPendingSignOut(), false);
    assert.equal(clearPilotPrivateState(), false);
    assert.equal(clearPendingSignOut(), false);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
