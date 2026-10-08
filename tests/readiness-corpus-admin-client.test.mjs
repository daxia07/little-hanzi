import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCorpusAdminMutation,
  normalizeCorpusBatchValidation,
  normalizeCorpusPublicationHead,
  createCorpusAdminApi,
} from '../lib/pilot-corpus-admin-client.ts';
const error = (status, code) =>
  Object.assign(new Error(code), { status, code });
const op = () => ({ kind: 'begin', body: { requestId: 'original-id' } });
test('unknown admin save retries the same immutable body; a draft change cannot rebase it', async () => {
  const writes = [];
  let failed = true;
  const c = createCorpusAdminMutation({
    verify: async () => true,
    send: async (o) => {
      writes.push(JSON.stringify(o));
      if (failed) {
        failed = false;
        throw error(503, 'UNCONFIRMED');
      }
      return { snapshotId: 's' };
    },
    read: async () => ({ status: 'building' }),
  });
  const original = op();
  await c.perform(original);
  original.body.requestId = 'changed';
  assert.equal(c.snapshot().status, 'pending');
  await c.retry();
  assert.equal(writes[0], writes[1]);
  assert.equal(c.snapshot().status, 'saved');
});
test('known admin ACK and failed readback retry GET only; ACK remains immutable attribution', async () => {
  let sends = 0,
    reads = 0;
  const c = createCorpusAdminMutation({
    verify: async () => true,
    send: async () => {
      sends++;
      return { snapshotId: 's', status: 'building' };
    },
    read: async () => {
      reads++;
      if (reads === 1) throw error(503, 'STORAGE_UNAVAILABLE');
      return { status: 'sealed' };
    },
  });
  await c.perform(op());
  assert.equal(c.snapshot().status, 'readback-pending');
  await c.retry();
  assert.equal(sends, 1);
  assert.equal(c.snapshot().ack.status, 'building');
  assert.equal(c.snapshot().readback.status, 'sealed');
});
test('held operator ACK cannot reopen after lock; identity refusal sends nothing', async () => {
  let release,
    calls = 0;
  const held = new Promise((r) => (release = r));
  const c = createCorpusAdminMutation({
    verify: async () => true,
    send: async () => {
      calls++;
      return held;
    },
    read: async () => ({}),
  });
  const saving = c.perform(op());
  await new Promise((r) => setImmediate(r));
  c.lock();
  release({ snapshotId: 'private' });
  await saving;
  assert.equal(c.snapshot().status, 'locked');
  assert.equal(c.snapshot().ack, null);
  const denied = createCorpusAdminMutation({
    verify: async () => false,
    send: async () => {
      calls++;
      return {};
    },
    read: async () => ({}),
  });
  await denied.perform(op());
  assert.equal(calls, 1);
});
test('stale publication conflict cannot be retried or accepted before current GET, and never rebases write', async () => {
  let writes = 0,
    fail = true;
  const c = createCorpusAdminMutation({
    verify: async () => true,
    send: async () => {
      writes++;
      throw error(409, 'PUBLICATION_STALE');
    },
    read: async () => {
      if (fail) throw error(503, 'STORAGE_UNAVAILABLE');
      return { publication: null };
    },
  });
  await c.perform({
    kind: 'publish',
    body: { expectedRevision: 1, requestId: 'x' },
  });
  assert.equal(c.snapshot().status, 'conflict');
  assert.equal(c.acceptConflict(), false);
  await c.retry();
  assert.equal(writes, 1);
  await c.refreshConflict();
  assert.equal(c.acceptConflict(), false);
  fail = false;
  await c.refreshConflict();
  assert.equal(c.acceptConflict(), true);
  assert.equal(writes, 1);
});
test('pure validation cannot masquerade as saved batch and private material is not accepted in publication head', () => {
  const response = {
    schemaVersion: 'r6-batch-validation-1',
    batchId: 'batch',
    batchVersion: 'v1',
    manifestDigest: 'sha256:' + 'a'.repeat(64),
    checkedAt: '2026-09-27T00:00:00.000Z',
    items: [
      {
        lessonVersion: 'lesson',
        contentDigest: 'sha256:' + 'b'.repeat(64),
        state: 'accepted',
        errors: [],
      },
    ],
  };
  assert.equal(
    normalizeCorpusBatchValidation(response).checkedAt,
    response.checkedAt,
  );
  assert.throws(() =>
    normalizeCorpusBatchValidation({
      ...response,
      recordedAt: response.checkedAt,
    }),
  );
  assert.throws(() =>
    normalizeCorpusPublicationHead({
      publication: null,
      correctChoiceId: 'key',
    }),
  );
});
test('family account cannot issue an operator request', async () => {
  const calls = [];
  const parent = createCorpusAdminApi(
    { user: { id: 'p', role: 'parent' }, installationId: 'i' },
    'corpus-v1',
    {
      verify: async () => true,
      request: async () => {
        calls.push('bad');
        return {};
      },
    },
  );
  await assert.rejects(parent.head(), (e) => e.status === 403);
  assert.equal(calls.length, 0);
});
test('operator refuses malformed mutation before POST and refuses a foreign request ACK', async () => {
  let calls = 0;
  const api = createCorpusAdminApi(
    { user: { id: 'op', role: 'operator' }, installationId: 'i' },
    'corpus-v1',
    {
      verify: async () => true,
      request: async () => {
        calls++;
        return {
          requestId: 'foreign',
          snapshotId: 's',
          status: 'building',
          recordedAt: '2026-09-27T00:00:00.000Z',
          packageCount: 1,
          targetCount: 2,
        };
      },
    },
  );
  await assert.rejects(
    api.send({ kind: 'begin', body: { requestId: 'ours', extra: true } }),
    (e) => e.status === 400,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    api.send({ kind: 'begin', body: { requestId: 'ours' } }),
    (e) => e.code === 'INVALID_ACK',
  );
  assert.equal(calls, 1);
});
test('bounded batch drafts above half a megabyte retain original retry without a smaller incidental clone bound', async () => {
  let writes = 0;
  const c = createCorpusAdminMutation({
    verify: async () => true,
    send: async () => {
      writes++;
      if (writes === 1) throw error(503, 'UNCONFIRMED');
      return { batchId: 'saved' };
    },
    read: async () => ({ batchId: 'saved' }),
  });
  await c.perform({
    kind: 'batch',
    body: { requestId: 'large', batch: { note: 'a'.repeat(600000) } },
  });
  assert.equal(c.snapshot().status, 'pending');
  await c.retry();
  assert.equal(writes, 2);
  assert.equal(c.snapshot().status, 'saved');
});
test('validation denial locks and clears private draft; unrelated transient failure retains editable draft', async () => {
  const { createCorpusAdminValidation } =
    await import('../lib/pilot-corpus-admin-client.ts');
  let deny = true,
    locks = 0;
  const c = createCorpusAdminValidation({
    verify: async () => true,
    validate: async () => {
      throw error(deny ? 403 : 503, deny ? 'FORBIDDEN' : 'STORAGE_UNAVAILABLE');
    },
    onLock: () => locks++,
  });
  c.setInput('{"private":"draft"}');
  await c.check();
  assert.equal(c.snapshot().status, 'locked');
  assert.equal(c.snapshot().input, '');
  assert.equal(c.snapshot().report, null);
  assert.equal(locks, 1);
  deny = false;
  const transient = createCorpusAdminValidation({
    verify: async () => true,
    validate: async () => {
      throw error(503, 'STORAGE_UNAVAILABLE');
    },
  });
  transient.setInput('{"private":"draft"}');
  await transient.check();
  assert.equal(transient.snapshot().input, '{"private":"draft"}');
  assert.equal(transient.snapshot().status, 'error');
});
test('batch ACK/readback and corpus registration refuse a different declared resource', async () => {
  const d = 'sha256:' + 'a'.repeat(64),
    batch = {
      schemaVersion: 'r6-batch-1',
      batchId: 'foreign',
      batchVersion: 'v1',
      manifestDigest: d,
      recordedAt: '2026-09-27T00:00:00.000Z',
      items: [
        {
          lessonVersion: 'lesson',
          contentDigest: d,
          state: 'accepted',
          errors: [],
        },
      ],
    };
  const me = { user: { id: 'op', role: 'operator' }, installationId: 'i' };
  const api = createCorpusAdminApi(me, 'v1', {
    verify: async () => true,
    request: async (path) =>
      path === '/api/pilot/corpora'
        ? { corpusVersion: 'foreign', corpusDigest: d }
        : path.endsWith('/validate')
          ? {
              schemaVersion: 'r6-batch-validation-1',
              batchId: batch.batchId,
              batchVersion: batch.batchVersion,
              manifestDigest: d,
              checkedAt: batch.recordedAt,
              items: batch.items,
            }
          : batch,
  });
  const operation = {
    kind: 'batch',
    body: { requestId: 'r', batch: { batchId: 'ours', batchVersion: 'v1' } },
  };
  await assert.rejects(
    api.validate(operation.body.batch),
    (e) => e.code === 'INVALID_ACK',
  );
  await assert.rejects(api.send(operation), (e) => e.code === 'INVALID_ACK');
  await assert.rejects(
    api.read(operation, { batchId: 'ours' }),
    (e) => e.code === 'INVALID_ACK',
  );
  await assert.rejects(
    api.send({ kind: 'register', body: { corpus: { corpusVersion: 'ours' } } }),
    (e) => e.code === 'INVALID_ACK',
  );
});
