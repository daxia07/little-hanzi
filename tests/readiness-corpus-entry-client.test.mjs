import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCorpusEntryApi,
  createCorpusEntryPager,
  normalizeCorpusFamilyEntry,
  normalizeCorpusOwnerEntry,
} from '../lib/pilot-corpus-entry-client.ts';
const d = 'sha256:' + 'a'.repeat(64),
  scope = {
    accountId: 'parent',
    role: 'parent',
    installationId: 'install',
    childId: 'child',
  },
  item = {
    corpusId: 'corpus',
    corpusVersion: 'corpus-v1',
    corpusDigest: d,
    title: 'A forest story',
    targets: [
      { characterId: 'a', hanzi: '木' },
      { characterId: 'b', hanzi: '林' },
    ],
    available: true,
    reasonCode: null,
  };
const page = (items = [item], nextCursor = null) => ({
  schemaVersion: 'r6-family-corpora-1',
  childId: 'child',
  installationId: 'install',
  items,
  nextCursor,
});
const error = (status, code) =>
  Object.assign(new Error(code), { status, code });
test('read-only default context is selected once; paging never replaces it or posts a proposal', async () => {
  const calls = [];
  const api = createCorpusEntryApi(
    { user: { id: 'parent', role: 'parent' }, installationId: 'install' },
    {
      verify: async () => true,
      request: async (path, opts) => {
        calls.push({ path, opts });
        return calls.length === 1
          ? page([item], 'opaque-next')
          : page([{ ...item, corpusVersion: 'corpus-v2' }]);
      },
    },
  );
  const c = createCorpusEntryPager({
    read: (cursor) => api.family('child', cursor),
    verify: async () => true,
    keyOf: (i) => i.corpusVersion,
    defaultFirst: true,
  });
  await c.load();
  assert.equal(c.snapshot().selected.corpusVersion, 'corpus-v1');
  await c.next();
  assert.equal(c.snapshot().selected.corpusVersion, 'corpus-v1');
  assert.ok(calls.every((c) => c.opts.method === undefined));
});
test('held old child page cannot return after lock and failed identity makes no request', async () => {
  let release,
    calls = 0;
  const held = new Promise((r) => (release = r));
  const c = createCorpusEntryPager({
    read: async () => {
      calls++;
      return held;
    },
    verify: async () => true,
    keyOf: (i) => i.corpusVersion,
    defaultFirst: true,
  });
  const loading = c.load();
  await new Promise((r) => setImmediate(r));
  c.lock();
  release(page());
  await loading;
  assert.equal(c.snapshot().status, 'locked');
  assert.equal(c.snapshot().selected, null);
  const denied = createCorpusEntryPager({
    read: async () => {
      calls++;
      return page();
    },
    verify: async () => false,
    keyOf: (i) => i.corpusVersion,
  });
  await denied.load();
  assert.equal(calls, 1);
  assert.equal(denied.snapshot().status, 'locked');
});
test('partial empty pages preserve explicit Next; failed next retry repeats cursor and commits history only once', async () => {
  const seen = [];
  let fail = true;
  const c = createCorpusEntryPager({
    read: async (cursor) => {
      seen.push(cursor);
      if (cursor === 'next' && fail) {
        fail = false;
        throw error(503, 'STORAGE_UNAVAILABLE');
      }
      return cursor ? page([item]) : page([], 'next');
    },
    verify: async () => true,
    keyOf: (i) => i.corpusVersion,
    defaultFirst: true,
  });
  await c.load();
  assert.equal(c.snapshot().selected, null);
  assert.equal(c.snapshot().page.nextCursor, 'next');
  await c.next();
  assert.equal(c.snapshot().previous, false);
  await c.retry();
  assert.deepEqual(seen, [null, 'next', 'next']);
  assert.equal(c.snapshot().previous, true);
  await c.previous();
  assert.equal(seen.at(-1), null);
});
test('stale entry cannot retain selected corpus or silently skip to first page', async () => {
  let calls = 0;
  const c = createCorpusEntryPager({
    read: async () => {
      calls++;
      if (calls > 1) throw error(409, 'CURSOR_STALE');
      return page([item], 'next');
    },
    verify: async () => true,
    keyOf: (i) => i.corpusVersion,
    defaultFirst: true,
  });
  await c.load();
  await c.next();
  assert.equal(c.snapshot().status, 'stale');
  assert.equal(c.snapshot().selected, null);
  await c.retry();
  assert.equal(calls, 2);
});
test('owner false reveals no material and malformed/foreign/private index data refuses without getters', () => {
  const owner = {
    schemaVersion: 'r6-owner-entry-1',
    installationId: 'install',
    allowed: false,
    items: [],
    nextCursor: null,
  };
  assert.equal(normalizeCorpusOwnerEntry(owner, scope).allowed, false);
  assert.throws(() =>
    normalizeCorpusOwnerEntry({ ...owner, items: [item] }, scope),
  );
  assert.throws(() =>
    normalizeCorpusFamilyEntry({ ...page(), childId: 'foreign' }, scope),
  );
  assert.throws(() =>
    normalizeCorpusFamilyEntry(
      page([{ ...item, correctChoiceId: 'key' }]),
      scope,
    ),
  );
  let reads = 0;
  const bad = { ...item };
  Object.defineProperty(bad, 'title', {
    enumerable: true,
    get() {
      reads++;
      return 'secret';
    },
  });
  assert.throws(() => normalizeCorpusFamilyEntry(page([bad]), scope));
  assert.equal(reads, 0);
});
