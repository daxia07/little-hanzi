import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCorpusCatalog } from '../lib/pilot-corpus-client.ts';
const digest = 'sha256:' + 'a'.repeat(64);
const item = {
  lessonVersion: 'corpus-path-01-v1',
  contentDigest: digest,
  adapterId: 'corpus-paired',
  adapterVersion: 'corpus-paired-v1',
  title: 'A forest story',
  targets: [
    { characterId: 'tree', hanzi: '木' },
    { characterId: 'forest', hanzi: '林' },
  ],
  words: [{ text: '树林', english: 'woods' }],
  trackId: 'path',
  sequence: 1,
  releaseId: 'release',
  releaseRevision: 3,
  available: true,
  reasonCode: null,
};
const page = () => ({
  schemaVersion: 'r6-catalog-1',
  corpusVersion: 'corpus-v1',
  corpusDigest: digest,
  releaseRevision: 3,
  items: [structuredClone(item)],
  nextCursor: null,
});
test('catalog preserves original identity and bounded display metadata', () =>
  assert.equal(
    normalizeCorpusCatalog(page(), 'corpus-v1').items[0].targets[0].hanzi,
    '木',
  ));
test('catalog rejects private scoring fields, future cues and unknown envelope keys', () => {
  for (const key of ['correctChoiceId', 'playback', 'reviewerNotes']) {
    const p = page();
    p.items[0][key] = 'private';
    assert.throws(() => normalizeCorpusCatalog(p, 'corpus-v1'));
  }
});
test('catalog refuses foreign corpus and inconsistent release metadata', () => {
  assert.throws(() => normalizeCorpusCatalog(page(), 'other'));
  const p = page();
  p.items[0].releaseRevision = 2;
  assert.throws(() => normalizeCorpusCatalog(p, 'corpus-v1'));
});
test('catalog strictly respects requested page limit and opaque cursor bound', () => {
  const p = page();
  p.items = Array.from({ length: 21 }, () => structuredClone(item));
  assert.throws(() => normalizeCorpusCatalog(p, 'corpus-v1', 20));
  const q = page();
  q.nextCursor = 'x'.repeat(4097);
  assert.throws(() => normalizeCorpusCatalog(q, 'corpus-v1'));
});
test('catalog refuses accessor input without reading it', () => {
  let reads = 0;
  const p = page();
  Object.defineProperty(p, 'items', {
    enumerable: true,
    get() {
      reads++;
      return [];
    },
  });
  assert.throws(() => normalizeCorpusCatalog(p, 'corpus-v1'));
  assert.equal(reads, 0);
});
import { createCorpusCatalog } from '../lib/pilot-corpus-client.ts';
const scope = {
  accountId: 'parent-a',
  installationId: 'installation-a',
  childId: 'child-a',
  corpusVersion: 'corpus-v1',
};
const hold = () => {
  let resolve;
  return {
    promise: new Promise((r) => (resolve = r)),
    release: (v) => resolve(v),
  };
};
test('held catalog from old child/account cannot survive lock', async () => {
  const held = hold();
  let count = 0;
  const c = createCorpusCatalog({
    scope,
    verify: async () => true,
    request: async () => {
      count++;
      return held.promise;
    },
  });
  const loading = c.load();
  while (!count) await new Promise((r) => setImmediate(r));
  c.lock();
  held.release(page());
  await loading;
  assert.equal(c.snapshot().status, 'locked');
  assert.equal(c.snapshot().page, null);
  assert.equal(c.select(item.lessonVersion), null);
});
test('explicit search clears selection and stale cursor only offers first-page recovery', async () => {
  let calls = 0;
  const c = createCorpusCatalog({
    scope,
    verify: async () => true,
    request: async () => {
      calls++;
      if (calls === 2) throw { status: 409, code: 'CURSOR_STALE' };
      const p = page();
      p.nextCursor = 'c1.opaque';
      return p;
    },
  });
  await c.load();
  assert.equal(c.select(item.lessonVersion).selection.releaseRevision, 3);
  await c.next();
  assert.equal(c.snapshot().status, 'stale');
  assert.equal(c.snapshot().selected, null);
  assert.equal(c.snapshot().page, null);
  assert.equal(c.snapshot().previous, false);
  assert.equal(calls, 2);
  await c.first();
  assert.equal(c.snapshot().status, 'ready');
  assert.equal(c.snapshot().previous, false);
});
test('search normalizes safe Unicode and uses scoped encoded URL; no automatic mutation', async () => {
  let path, options;
  const c = createCorpusCatalog({
    scope: { ...scope, childId: 'child/a' },
    verify: async (s) => s.accountId === scope.accountId,
    request: async (p, o) => {
      path = p;
      options = o;
      return page();
    },
  });
  await c.search('  Forest   木  ', 50);
  const url = new URL(path, 'http://local');
  assert.equal(url.pathname, '/api/pilot/children/child%2Fa/catalog');
  assert.equal(url.searchParams.get('q'), 'Forest 木');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(options.method, undefined);
  const before = path;
  await c.search('木'.repeat(81));
  assert.equal(path, before);
});
test('later search wins over held old query and foreign/revoked pages clear prior items', async () => {
  const held = hold();
  let requests = 0;
  const c = createCorpusCatalog({
    scope,
    verify: async () => true,
    request: async () => {
      requests++;
      if (requests === 1) return held.promise;
      if (requests === 3) throw { status: 403, code: 'FORBIDDEN' };
      return page();
    },
  });
  const old = c.search('old');
  while (!requests) await new Promise((r) => setImmediate(r));
  await c.search('new');
  held.release({ ...page(), items: [] });
  await old;
  assert.equal(c.snapshot().query, 'new');
  assert.equal(c.snapshot().page.items.length, 1);
  await c.search('revoked');
  assert.equal(c.snapshot().status, 'unavailable');
  assert.equal(c.snapshot().page, null);
});
test('[CF01] failed next-page retry repeats exact opaque cursor without phantom back history', async () => {
  const requests = [];
  let fail = true;
  const c = createCorpusCatalog({
    scope,
    verify: async () => true,
    request: async (path) => {
      const cursor = new URL(path, 'http://local').searchParams.get('cursor');
      requests.push(cursor);
      if (cursor === 'c1.page2' && fail) {
        fail = false;
        throw { status: 503, code: 'STORAGE_UNAVAILABLE' };
      }
      const p = page();
      p.nextCursor = cursor === null ? 'c1.page2' : null;
      return p;
    },
  });
  await c.load();
  await c.next();
  assert.equal(c.snapshot().status, 'error');
  await c.retry();
  assert.deepEqual(requests, [null, 'c1.page2', 'c1.page2']);
  assert.equal(c.snapshot().previous, true);
  await c.previous();
  assert.deepEqual(requests, [null, 'c1.page2', 'c1.page2', null]);
  assert.equal(c.snapshot().previous, false);
});
test('[CF01] failed previous-page retry repeats exact prior cursor and commits history once', async () => {
  const requests = [];
  let fail = false;
  const c = createCorpusCatalog({
    scope,
    verify: async () => true,
    request: async (path) => {
      const cursor = new URL(path, 'http://local').searchParams.get('cursor');
      requests.push(cursor);
      if (cursor === null && fail) {
        fail = false;
        throw { status: 503, code: 'STORAGE_UNAVAILABLE' };
      }
      const p = page();
      p.nextCursor = cursor === null ? 'c1.page2' : null;
      return p;
    },
  });
  await c.load();
  await c.next();
  fail = true;
  await c.previous();
  assert.equal(c.snapshot().status, 'error');
  await c.retry();
  assert.deepEqual(requests, [null, 'c1.page2', null, null]);
  assert.equal(c.snapshot().previous, false);
  await c.next();
  assert.equal(c.snapshot().previous, true);
  await c.previous();
  assert.equal(c.snapshot().previous, false);
});
