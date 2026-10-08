import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorpusPlanController } from '../lib/pilot-corpus-client.ts';
const scope = {
  accountId: 'parent',
  installationId: 'install',
  childId: 'child',
  corpusVersion: 'corpus-v1',
};
const d = 'sha256:' + 'a'.repeat(64),
  body = () => ({
    corpusVersion: 'corpus-v1',
    selection: {
      lessonVersion: 'lesson',
      contentDigest: d,
      releaseId: 'release',
      releaseRevision: 1,
    },
    predecessorProposalId: null,
    expectedSourceDigest: null,
  });
const read = () => ({
  setupComplete: true,
  proposal: null,
  reason: null,
  plan: null,
  history: [],
});
const deferred = () => {
  let resolve;
  return {
    promise: new Promise((r) => (resolve = r)),
    resolve: (v) => resolve(v),
  };
};
const error = (status, code) =>
  Object.assign(new Error(code), { status, code });
test('unknown proposal write retains exact original choice/body and Retry resends it rather than reading it away', async () => {
  const writes = [];
  let failed = true;
  const c = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => read(),
      propose: async (b) => {
        writes.push(JSON.stringify(b));
        if (failed) {
          failed = false;
          throw error(503, 'UNCONFIRMED');
        }
        return { proposal: null };
      },
      approve: async () => ({ plan: null }),
    },
  });
  await c.load();
  const b = body();
  await c.propose(b);
  assert.equal(c.snapshot().status, 'pending');
  b.selection.lessonVersion = 'later-choice';
  await c.retry();
  assert.equal(writes.length, 2);
  assert.equal(writes[0], writes[1]);
  assert.equal(c.snapshot().status, 'saved');
});
test('known proposal ACK plus failed readback retries GET only and retains safe proposal display', async () => {
  let reads = 0,
    writes = 0;
  const saved = { title: 'Saved story', reason: 'Original safe reason' };
  const c = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => {
        reads++;
        if (reads === 2) throw error(503, 'STORAGE_UNAVAILABLE');
        return { ...read(), proposal: reads > 2 ? saved : null };
      },
      propose: async () => {
        writes++;
        return { proposal: saved };
      },
      approve: async () => ({ plan: null }),
    },
  });
  await c.load();
  await c.propose(body());
  assert.equal(c.snapshot().status, 'readback-pending');
  assert.equal(c.snapshot().proposal.title, saved.title);
  await c.retry();
  assert.equal(writes, 1);
  assert.equal(reads, 3);
  assert.equal(c.snapshot().status, 'saved');
});
test('conflict cannot discard pending choice until actual saved GET succeeds, then explicit acceptance never resends', async () => {
  let failed = true,
    writes = 0;
  const c = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => {
        if (failed) throw error(503, 'STORAGE_UNAVAILABLE');
        return read();
      },
      propose: async () => {
        writes++;
        throw error(409, 'PLACEMENT_STALE');
      },
      approve: async () => ({ plan: null }),
    },
  });
  await c.propose(body());
  assert.equal(c.snapshot().status, 'conflict');
  await c.refreshConflict();
  assert.equal(c.acceptConflict(), false);
  assert.ok(c.snapshot().pending);
  failed = false;
  await c.refreshConflict();
  assert.equal(c.snapshot().conflictReady, true);
  assert.equal(c.acceptConflict(), true);
  assert.equal(writes, 1);
  assert.equal(c.snapshot().pending, null);
});
test('held saved read/ACK cannot repopulate the controller after account lock and clears private choice', async () => {
  const held = deferred();
  const c = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => read(),
      propose: async () => held.promise,
      approve: async () => ({ plan: null }),
    },
  });
  await c.load();
  const saving = c.propose(body());
  await new Promise((r) => setImmediate(r));
  c.lock();
  held.resolve({ proposal: { title: 'Old private child choice' } });
  await saving;
  assert.equal(c.snapshot().status, 'locked');
  assert.equal(c.snapshot().proposal, null);
  assert.equal(c.snapshot().pending, null);
});
test('fresh identity refusal blocks calls and role/foreign denial clears all child material', async () => {
  let allowed = false,
    writes = 0;
  const c = createCorpusPlanController({
    scope,
    verify: async () => allowed,
    api: {
      read: async () => read(),
      propose: async () => {
        writes++;
        throw error(404, 'NOT_FOUND');
      },
      approve: async () => ({ plan: null }),
    },
  });
  await c.propose(body());
  assert.equal(writes, 0);
  assert.equal(c.snapshot().status, 'locked');
  allowed = true;
  const other = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => read(),
      propose: async () => {
        throw error(403, 'FORBIDDEN');
      },
      approve: async () => ({ plan: null }),
    },
  });
  await other.propose(body());
  assert.equal(other.snapshot().status, 'locked');
  assert.equal(other.snapshot().pending, null);
});

test('a pending unknown write cannot be replaced by another choice or erased by a generic reload', async () => {
  let writes = 0,
    reads = 0;
  const c = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => {
        reads++;
        return read();
      },
      propose: async () => {
        writes++;
        throw error(503, 'UNCONFIRMED');
      },
      approve: async () => ({ plan: null }),
    },
  });
  await c.load();
  await c.propose(body());
  await c.propose({ ...body(), selection: null });
  await c.load();
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(c.snapshot().status, 'pending');
  assert.equal(c.snapshot().pending.body.selection.lessonVersion, 'lesson');
});
test('held conflict read after sign-out cannot install saved child material or enable stale acceptance', async () => {
  const held = deferred();
  const c = createCorpusPlanController({
    scope,
    verify: async () => true,
    api: {
      read: async () => held.promise,
      propose: async () => {
        throw error(409, 'PLACEMENT_STALE');
      },
      approve: async () => ({ plan: null }),
    },
  });
  await c.propose(body());
  const fetching = c.refreshConflict();
  await new Promise((r) => setImmediate(r));
  c.lock();
  held.resolve({ ...read(), proposal: { title: 'Old child' } });
  await fetching;
  assert.equal(c.snapshot().proposal, null);
  assert.equal(c.snapshot().conflictReady, false);
  assert.equal(c.acceptConflict(), false);
});
