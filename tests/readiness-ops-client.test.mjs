import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createPilotOpsClient,
  createOpsWrite,
  parseOpsView,
} from '../lib/pilot-ops-client.ts';
const me = {
  installationId: 'install-a',
  user: {
    id: 'operator-a',
    role: 'operator',
    name: 'Operator',
    username: 'operator',
    mustChangePassword: false,
  },
  children: [],
  capabilities: { manageAccounts: true },
};
const envelope = {
  schemaVersion: 'r4-ops-view-1',
  installationId: 'install-a',
  opsInstallationId: 'ops-a',
  buildId: 'build-a',
  serverAt: 10,
};
const receipt = {
  requestId: 'request-1',
  recordId: 'record-1',
  revision: 1,
  recordedAt: 10,
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test('[R4-E-002/010] role and child scope refuse before network', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response('{}');
  };
  const child = createPilotOpsClient(
    { ...me, user: { ...me.user, role: 'child' } },
    { fetcher },
  );
  await assert.rejects(child.status());
  const parent = createPilotOpsClient(
    {
      ...me,
      user: { ...me.user, role: 'parent' },
      children: [{ id: 'own', name: 'Own' }],
    },
    { fetcher },
  );
  await assert.rejects(
    parent.feedback('foreign', {
      requestId: 'request-1',
      runId: 'run-a',
      category: 'other',
      observed: 'Issue',
      expected: '',
    }),
  );
  assert.equal(calls, 0);
});
test('[R4-E-001/002] read transport preserves same-origin/no-store and sanitized unknown', async () => {
  let seen;
  const client = createPilotOpsClient(me, {
    fetcher: async (url, init) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          ...envelope,
          error: { code: 'OPS_UNAVAILABLE', message: 'privateSQLpassword' },
          status: { monitorState: 'unknown' },
        }),
        { status: 503 },
      );
    },
  });
  await assert.rejects(
    client.status(),
    (error) =>
      error.code === 'OPS_UNAVAILABLE' &&
      error.unknown === true &&
      !error.message.includes('privateSQL'),
  );
  assert.equal(seen.url, '/api/pilot/ops/status');
  assert.equal(seen.init.credentials, 'same-origin');
  assert.equal(seen.init.cache, 'no-store');
});
test('[R4-E-002/010] malformed/wrong-install readback cannot be presented', () => {
  assert.throws(() =>
    parseOpsView(
      {
        ...envelope,
        installationId: 'foreign',
        items: [],
        queueRevision: 1,
        nextCursor: null,
      },
      'queue',
      'install-a',
    ),
  );
  assert.throws(() =>
    parseOpsView(
      { ...envelope, items: [], queueRevision: '1', nextCursor: null },
      'queue',
      'install-a',
    ),
  );
  let reads = 0;
  const body = { ...envelope, items: [], queueRevision: 1, nextCursor: null };
  Object.defineProperty(body, 'buildId', {
    enumerable: true,
    get() {
      reads++;
      return 'private';
    },
  });
  assert.throws(() => parseOpsView(body, 'queue', 'install-a'));
  assert.equal(reads, 0);
});
test('[R4-E-003/010] lost write response retries exact identity/body without automatic resend', async () => {
  const calls = [];
  let fail = true;
  const controller = createOpsWrite({
    send: async (body) => {
      calls.push(body);
      if (fail) throw new Error('lost');
      return receipt;
    },
    read: async () => ({ known: true }),
  });
  const body = { requestId: 'request-1', observed: 'original' };
  await controller.submit(body);
  body.observed = 'edited';
  assert.equal(controller.snapshot().state, 'retry');
  assert.equal(calls.length, 1);
  fail = false;
  await controller.retry();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].observed, 'original');
  assert.equal(controller.snapshot().state, 'saved');
});
test('[R4-E-003/010] acknowledged write plus GET failure retries only readback', async () => {
  let writes = 0,
    reads = 0;
  const controller = createOpsWrite({
    send: async () => {
      writes++;
      return receipt;
    },
    read: async () => {
      reads++;
      if (reads === 1) throw new Error('offline');
      return 'known';
    },
  });
  await controller.submit({ requestId: 'request-1' });
  assert.equal(controller.snapshot().state, 'readback-pending');
  assert.deepEqual(controller.snapshot().receipt, receipt);
  await controller.retry();
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(controller.snapshot().state, 'saved');
});
test('[R4-E-003/010] conflict keeps draft and refresh never rebases/resends', async () => {
  let writes = 0;
  const controller = createOpsWrite({
    send: async () => {
      writes++;
      throw Object.assign(new Error('conflict'), {
        code: 'OPS_CONFLICT',
        status: 409,
      });
    },
    read: async () => ({ revision: 3 }),
  });
  await controller.submit({ requestId: 'request-1', expectedRevision: 1 });
  assert.equal(controller.snapshot().state, 'conflict');
  await controller.retry();
  assert.equal(writes, 1);
  assert.equal(controller.snapshot().state, 'conflict');
  assert.deepEqual(controller.snapshot().readback, { revision: 3 });
});
test('[R4-E-002/013] held write/readback cannot repopulate after account lock', async () => {
  const held = deferred();
  let reads = 0;
  const controller = createOpsWrite({
    send: () => held.promise,
    read: async () => {
      reads++;
      return 'secret';
    },
  });
  const pending = controller.submit({
    requestId: 'request-1',
    observed: 'private',
  });
  controller.lock();
  held.resolve(receipt);
  await pending;
  assert.equal(controller.snapshot().state, 'locked');
  assert.equal(controller.snapshot().receipt, null);
  assert.equal(controller.snapshot().readback, null);
  assert.equal(reads, 0);
  const heldRead = deferred();
  const second = createOpsWrite({
    send: async () => receipt,
    read: () => heldRead.promise,
  });
  const waiting = second.submit({ requestId: 'request-1' });
  await new Promise((resolve) => setImmediate(resolve));
  second.lock();
  heldRead.resolve('private');
  await waiting;
  assert.equal(second.snapshot().state, 'locked');
  assert.equal(second.snapshot().readback, null);
});
test('[R4-E-001/002] browser graph excludes server grading/archive/store modules', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const visited = new Set();
  function walk(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const code = fs.readFileSync(file, 'utf8');
    for (const match of code.matchAll(
      /(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s['"]([^'"]+)['"]/g,
    )) {
      if (match[1].startsWith('.'))
        walk(path.resolve(path.dirname(file), match[1]));
    }
  }
  walk(root + '/lib/pilot-ops-client.ts');
  for (const file of visited)
    assert(
      !/\/(?:ops-store|ops-archive|story-package|validate|content|reducer)\.ts$/.test(
        file,
      ),
      file,
    );
});

test('[R4-E-001/006] incomplete healthy status is refused rather than false green', () => {
  const status = {
    monitorState: 'healthy',
    targets: {
      dailyAtUtc: '02:00',
      dailyPoints: 7,
      weeklyPoints: 4,
      freshnessMs: 93600000,
      feedbackRetentionMs: 2592000000,
    },
    lastVerifiedBackupAt: null,
    lastBackupDataAt: null,
    backupAgeMs: null,
    lastMonitorAt: null,
    notification: 'unconfigured',
    jobs: [],
    alerts: [],
  };
  assert.throws(() =>
    parseOpsView({ ...envelope, status }, 'status', 'install-a'),
  );
});
test('[R4-E-002/010] detail response and ack must match the requested opaque record', async () => {
  const wrong = createPilotOpsClient(me, {
    fetcher: async () =>
      new Response(JSON.stringify({ ...receipt, recordId: 'different' })),
  });
  await assert.rejects(
    wrong.ack('record-1', { requestId: 'request-1', expectedRevision: 1 }),
    (e) => e.code === 'INVALID_RESPONSE',
  );
});

const observation = {
  kind: 'synthetic',
  participantLabel: 'Participant 1',
  candidateId: 'candidate-a',
  lessonVersion: 'forest-01-v4',
  contentDigest: 'sha256:' + 'a'.repeat(64),
  observedAt: 5,
  device: 'Synthetic Chrome',
  browser: 'Chrome',
  parentAgreementRef: 'synthetic-agreement',
  tasks: ['Start story'],
  completion: 'ended',
  savedRecapRef: null,
  adultHelp: '',
  interruptions: '',
  observedBehavior: 'Stopped',
  observerInterpretation: '',
  laterRecall: { status: 'not-run' },
};
const record = {
  id: 'record-1',
  kind: 'feedback',
  revision: 1,
  createdAt: 5,
  updatedAt: 5,
  candidateId: 'candidate-a',
  lessonId: 'forest-01',
  lessonVersion: 'forest-01-v4',
  contentDigest: 'sha256:' + 'a'.repeat(64),
  buildId: 'build-a',
  submissionBuildId: 'build-a',
  category: 'confusion',
  severity: 'normal',
  ownerRef: null,
  status: 'open',
  nextReviewAt: null,
  detailsRemoved: false,
  historical: false,
  readOnly: false,
};
test('[R4-E-002/010/011] all mutation paths carry exact inputs and direct immutable receipts', async () => {
  const calls = [];
  const api = createPilotOpsClient(me, {
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, init });
      return new Response(
        JSON.stringify({ ...receipt, requestId: body.requestId }),
      );
    },
  });
  await api.ack('record-1', { requestId: 'request-1', expectedRevision: 1 });
  await api.triage('record-1', {
    requestId: 'request-2',
    expectedRevision: 1,
    severity: 'normal',
    ownerRef: null,
    status: 'open',
    acIds: ['R4-E-010'],
    disposition: 'Pending retest',
    retestRef: null,
    nextReviewAt: null,
  });
  await api.observation({ requestId: 'request-3', observation });
  await api.correct('record-1', {
    requestId: 'request-4',
    expectedRevision: 1,
    observation,
    correctionReason: 'Corrected notes',
  });
  assert.deepEqual(
    calls.map((x) => x.url),
    [
      '/api/pilot/ops/alerts/record-1/ack',
      '/api/pilot/ops/feedback/record-1/triage',
      '/api/pilot/ops/observations',
      '/api/pilot/ops/observations/record-1/corrections',
    ],
  );
  assert.equal(calls[2].body.observation.savedRecapRef, null);
  assert.equal(calls[2].body.observation.completion, 'ended');
  for (const c of calls) {
    assert.equal(c.init.cache, 'no-store');
    assert.equal(c.init.credentials, 'same-origin');
    assert.equal(c.body.installationId, undefined);
    assert.equal(c.body.environment, undefined);
  }
});
test('[R4-E-002/010] bounded parent feedback and rejected privilege/body injection never call fetch', async () => {
  let calls = 0;
  const parent = createPilotOpsClient(
    {
      ...me,
      user: { ...me.user, role: 'parent' },
      children: [{ id: 'child-a', name: 'Own' }],
    },
    {
      fetcher: async (_url, init) => {
        calls++;
        return new Response(
          JSON.stringify({
            ...receipt,
            requestId: JSON.parse(init.body).requestId,
          }),
        );
      },
    },
  );
  const body = {
    requestId: 'request-1',
    runId: 'run-a',
    category: 'sound',
    observed: '木'.repeat(1000),
    expected: '',
  };
  assert.deepEqual(await parent.feedback('child-a', body), receipt);
  assert.equal(calls, 1);
  for (const mutation of [
    (b) => (b.observed += '木'),
    (b) => (b.installationId = 'foreign'),
    (b) => (b.requestId = 'bad:request'),
    (b) => (b.category = 'arbitrary'),
  ]) {
    const changed = structuredClone(body);
    mutation(changed);
    await assert.rejects(
      parent.feedback('child-a', changed),
      (e) => e.code === 'INVALID_REQUEST',
    );
  }
  await assert.rejects(parent.status(), (e) => e.status === 403);
  assert.equal(calls, 1);
});
test('[R4-E-002/010/012] expired/private malformed detail is refused and historical display stays read-only', () => {
  const detail = {
    ...record,
    childId: 'child-a',
    runId: 'run-a',
    runInstallationId: 'install-old',
    sourceRole: 'parent',
    observationKind: null,
    details: { observed: 'Issue', expected: '' },
    history: [],
    historyRevision: 1,
    nextCursor: null,
  };
  assert.deepEqual(
    parseOpsView({ ...envelope, record: detail }, 'detail', 'install-a').record,
    detail,
  );
  const expired = {
    ...detail,
    status: 'expired',
    detailsRemoved: true,
    readOnly: true,
    details: null,
  };
  assert.deepEqual(
    parseOpsView({ ...envelope, record: expired }, 'detail', 'install-a')
      .record,
    expired,
  );
  assert.throws(() =>
    parseOpsView(
      {
        ...envelope,
        record: {
          ...expired,
          details: { observed: 'must disappear', expected: '' },
        },
      },
      'detail',
      'install-a',
    ),
  );
  assert.throws(() =>
    parseOpsView(
      { ...envelope, record: { ...detail, historical: true, readOnly: false } },
      'detail',
      'install-a',
    ),
  );
  const historic = { ...detail, historical: true, readOnly: true };
  assert.deepEqual(
    parseOpsView({ ...envelope, record: historic }, 'detail', 'install-a')
      .record,
    historic,
  );
});
test('[R4-E-002/010] queue tokens and stale/conflict metadata are bounded and sanitized', async () => {
  const calls = [];
  const api = createPilotOpsClient(me, {
    fetcher: async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          ...envelope,
          error: { code: 'OPS_CURSOR_STALE', message: 'SQL secret' },
          refreshRequired: true,
        }),
        { status: 409 },
      );
    },
  });
  await assert.rejects(
    api.queue({
      status: 'all',
      kind: 'feedback',
      cursor: 'opaque_cursor',
      limit: 50,
    }),
    (e) =>
      e.code === 'OPS_CURSOR_STALE' &&
      e.refreshRequired &&
      !e.message.includes('SQL'),
  );
  assert.equal(
    calls[0],
    '/api/pilot/ops/feedback?status=all&kind=feedback&cursor=opaque_cursor&limit=50',
  );
  await assert.rejects(api.queue({ limit: 51 }));
  await assert.rejects(api.queue({ cursor: 'a'.repeat(2049) }));
  await assert.rejects(api.queue({ arbitrary: 'SQL' }));
  assert.equal(calls.length, 1);
});
test('[R4-E-003/010] conflict GET failure cannot discard or rebase; fresh read requires explicit new submit', async () => {
  let writes = 0,
    reads = 0;
  const bodies = [];
  const controller = createOpsWrite({
    send: async (body) => {
      writes++;
      bodies.push(body);
      if (writes === 1)
        throw Object.assign(new Error('stale'), { code: 'OPS_CONFLICT' });
      return { ...receipt, requestId: body.requestId };
    },
    read: async () => {
      reads++;
      if (reads === 1) throw new Error('offline');
      return { revision: 3 };
    },
  });
  await controller.submit({ requestId: 'request-1', expectedRevision: 1 });
  await controller.retry();
  controller.reset();
  assert.equal(controller.snapshot().state, 'conflict');
  assert.equal(writes, 1);
  await controller.retry();
  assert.equal(controller.snapshot().state, 'conflict');
  controller.reset();
  assert.equal(controller.snapshot().state, 'idle');
  await controller.submit({ requestId: 'request-2', expectedRevision: 3 });
  assert.equal(writes, 2);
  assert.deepEqual(bodies, [
    { requestId: 'request-1', expectedRevision: 1 },
    { requestId: 'request-2', expectedRevision: 3 },
  ]);
});
test('[R4-E-013] late response body after sign-out/reactivation refuses old identity', async () => {
  const held = deferred();
  const api = createPilotOpsClient(me, {
    fetcher: async () => ({ ok: true, status: 200, json: () => held.promise }),
  });
  const waiting = api.queue();
  await new Promise((resolve) => setImmediate(resolve));
  api.lock();
  api.activate();
  held.resolve({ ...envelope, items: [], queueRevision: 1, nextCursor: null });
  await assert.rejects(waiting, (e) => e.code === 'LOCKED');
  api.lock();
});
test('[R4-E-010] in-memory retry survives callback refresh without changing its request', async () => {
  const bodies = [];
  const controller = createOpsWrite({
    send: async (body) => {
      bodies.push(body);
      throw new Error('lost');
    },
    read: async () => null,
  });
  await controller.submit({ requestId: 'request-1', observed: 'original' });
  controller.configure(
    async (body) => {
      bodies.push(body);
      return receipt;
    },
    async () => ({ current: true }),
  );
  await controller.retry();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(controller.snapshot().state, 'saved');
  controller.lock();
});

test('[R4-E-010] definitively rejected input remains editable instead of trapping a retry', async () => {
  let calls = 0;
  const controller = createOpsWrite({
    send: async () => {
      calls++;
      throw Object.assign(new Error('invalid'), {
        status: 400,
        code: 'INVALID_REQUEST',
      });
    },
    read: async () => null,
  });
  await controller.submit({ requestId: 'request-1', observed: '' });
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(controller.snapshot().code, 'INVALID_REQUEST');
  await controller.retry();
  assert.equal(calls, 1);
});
test('[R4-E-002/013] auth denial locks remaining clients and queued private writes', async () => {
  const controller = createOpsWrite({
    send: async () => {
      throw new Error('offline');
    },
    read: async () => null,
  });
  await controller.submit({ requestId: 'request-1', observed: 'private' });
  let calls = 0;
  const api = createPilotOpsClient(me, {
    fetcher: async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'secret' } }),
        { status: 401 },
      );
    },
  });
  await assert.rejects(api.status());
  assert.equal(controller.snapshot().state, 'locked');
  await assert.rejects(api.status(), (e) => e.code === 'LOCKED');
  assert.equal(calls, 1);
});

test('[R4-E-010] oversized/non-JSON drafts emit editable errors without unhandled save', async () => {
  let writes = 0;
  const controller = createOpsWrite({
    send: async () => {
      writes++;
      return receipt;
    },
    read: async () => null,
  });
  const cyclic = { requestId: 'request-1' };
  cyclic.private = cyclic;
  await controller.submit(cyclic);
  assert.equal(controller.snapshot().state, 'idle');
  assert.equal(controller.snapshot().code, 'INVALID_REQUEST');
  assert.equal(writes, 0);
  controller.lock();
});
test('[R4-E-012/013] expired/changed history generation refuses held prior private data', async () => {
  const { createOpsReadGuard } = await import('../lib/pilot-ops-client.ts');
  const guard = createOpsReadGuard();
  guard.activate();
  const old = guard.begin();
  guard.lock();
  guard.activate();
  assert.equal(guard.current(old), false);
  const current = guard.begin();
  assert.equal(guard.current(current), true);
  guard.lock();
  assert.equal(guard.current(current), false);
});
