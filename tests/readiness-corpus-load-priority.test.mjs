import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorpusLoadPriority } from '../lib/pilot-corpus-load-priority.ts';
test('background reads stay pending through held entry and catalog, then start once', async () => {
  const gate = createCorpusLoadPriority();
  const reads = [];
  const startBackground = () => {
    if (gate.snapshot() === 'released' && !reads.length) reads.push('progress');
  };
  gate.subscribe(startBackground);
  startBackground();
  await Promise.resolve();
  assert.deepEqual(reads, []);
  gate.entry('loading', false);
  gate.entry('ready', true);
  assert.equal(gate.snapshot(), 'catalog');
  assert.deepEqual(reads, []);
  gate.catalog('loading');
  await Promise.resolve();
  assert.deepEqual(reads, []);
  gate.catalog('ready');
  assert.deepEqual(reads, ['progress']);
  gate.catalog('ready');
  assert.deepEqual(reads, ['progress']);
});
test('empty, unavailable and terminal errors release authorized legacy history', () => {
  for (const status of ['ready', 'error', 'stale', 'unavailable']) {
    const gate = createCorpusLoadPriority();
    gate.entry(status, false);
    assert.equal(gate.snapshot(), 'released');
  }
  for (const status of ['ready', 'error', 'stale', 'unavailable']) {
    const gate = createCorpusLoadPriority();
    gate.entry('ready', true);
    gate.catalog(status);
    assert.equal(gate.snapshot(), 'released');
  }
});
test('revoked scope and destroyed account/child generations cannot unlock background reads', () => {
  const previous = createCorpusLoadPriority();
  previous.entry('ready', true);
  const late = () => previous.catalog('ready');
  previous.destroy();
  const current = createCorpusLoadPriority();
  late();
  assert.equal(current.snapshot(), 'entry');
  current.entry('locked', false);
  current.entry('ready', true);
  current.catalog('ready');
  assert.equal(current.snapshot(), 'locked');
  const released = createCorpusLoadPriority();
  released.entry('ready', false);
  released.lock();
  released.catalog('ready');
  assert.equal(released.snapshot(), 'locked');
});
test('current entry or catalog denial overrides released background work, while disposed denials are inert', () => {
  for (const kind of ['entry', 'catalog']) {
    const gate = createCorpusLoadPriority();
    gate.entry('ready', false);
    assert.equal(gate.snapshot(), 'released');
    if (kind === 'entry') gate.entry('locked', false);
    else gate.catalog('locked');
    assert.equal(gate.snapshot(), 'locked');
    gate.entry('ready', true);
    gate.catalog('ready');
    assert.equal(gate.snapshot(), 'locked');
    const disposed = createCorpusLoadPriority();
    disposed.entry('ready', false);
    disposed.destroy();
    if (kind === 'entry') disposed.entry('locked', false);
    else disposed.catalog('locked');
    assert.equal(disposed.snapshot(), 'released');
  }
});
