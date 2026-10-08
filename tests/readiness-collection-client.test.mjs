import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createCollectionRecovery,
  collectionRecoveryKey,
  createCollectionSession,
  createCollectionTransport,
  normalizeCollectionRun,
} from '../lib/pilot-collection-client.ts';
import {
  compilePairedRuntime,
  createPairedRun,
  projectPairedRun,
} from '../lib/curriculum/paired-runtime.ts';
const NOW = '2026-09-27T00:00:00.000Z';
const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      '../content/curriculum/collection/path-02-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const lesson = await compilePairedRuntime(manifest);
const digest = 'sha256:' + 'a'.repeat(64);
const scope = {
  ...lesson.identity,
  collectionId: 'little-hanzi-path-1',
  collectionVersion: 'little-hanzi-path-1-v1',
  collectionDigest: digest,
  installationId: 'installation-test',
  accountId: 'child-test',
  childId: 'child-test',
  assignmentId: 'assignment-test',
  scheduleId: 'schedule-test',
  publicationId: 'publication-test',
};
function view(revision = 0) {
  const pure = projectPairedRun(
    lesson,
    createPairedRun(lesson, {
      runId: 'run-test',
      seed: 1,
      phase: 'review-24h',
      now: NOW,
    }),
    { soundReview: 'synthetic' },
  );
  return {
    ...pure,
    collectionId: scope.collectionId,
    collectionVersion: scope.collectionVersion,
    collectionDigest: digest,
    installationId: scope.installationId,
    childId: scope.childId,
    assignmentId: scope.assignmentId,
    scheduleId: scope.scheduleId,
    publicationId: scope.publicationId,
    publicationGeneration: 1,
    revision,
    events: Array.from({ length: revision }, (_, i) => ({
      eventId: `saved-${i}`,
      sequence: i + 1,
      occurrenceId: pure.question.occurrenceId,
      type: 'answer',
      serverAt: NOW,
      result: { outcome: 'correct', firstResponse: true, assisted: false },
      choiceId: 'a',
    })),
    available: true,
    reason: null,
    dueAt: NOW,
    serverAt: NOW,
  };
}
const memory = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    data,
  };
};
function harness({
  get = async () => view(),
  send = async (_id, a) => ({
    eventId: a.eventId,
    revision: a.expectedRevision + 1,
    result: { outcome: 'correct', firstResponse: true, assisted: false },
  }),
  verify = async () => true,
  storage = memory(),
} = {}) {
  let next = 0;
  const recovery = createCollectionRecovery(
    scope,
    storage,
    () => `start-${++next}`,
  );
  const controller = createCollectionSession({
    scope,
    recovery,
    transport: { start: get, get, send },
    verify,
    id: () => `event-${++next}`,
  });
  return { controller, recovery, storage };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test('recovery scope is canonical regardless of object insertion order, isolated for schedule/account/digest', () => {
  const reversed = Object.fromEntries(Object.entries(scope).reverse());
  assert.equal(collectionRecoveryKey(scope), collectionRecoveryKey(reversed));
  for (const k of ['accountId', 'scheduleId', 'contentDigest'])
    assert.notEqual(
      collectionRecoveryKey(scope),
      collectionRecoveryKey({ ...scope, [k]: 'other' }),
    );
});
test('lock clears memory and persisted own outbox before a different account uses device', async () => {
  const h = harness({
    send: async () => {
      throw new Error('lost');
    },
  });
  await h.controller.load('run-test');
  await h.controller.submit('answer', { choiceId: 'choice' });
  assert.equal(h.controller.snapshot().pending.length, 1);
  h.controller.lock();
  assert.equal(h.controller.snapshot().run, null);
  assert.deepEqual(h.recovery.read('run-test'), []);
});
test('current question decoder rejects future cue maps, private grading and mismatched identity without invoking getters', () => {
  const v = view();
  assert.equal(normalizeCollectionRun(v, scope).question.choices.length, 4);
  for (const mutate of [
    (r) =>
      r.lesson.playback.cues.push({
        ...r.lesson.playback.cues[0],
        checkId: 'future',
      }),
    (r) => (r.question.correctChoiceId = 'a'),
    (r) => (r.childId = 'foreign'),
  ]) {
    const n = structuredClone(v);
    mutate(n);
    assert.throws(() => normalizeCollectionRun(n, scope));
  }
  let calls = 0;
  const n = structuredClone(v);
  Object.defineProperty(n.question, 'correctChoiceId', {
    enumerable: true,
    get() {
      calls++;
      return 'a';
    },
  });
  assert.throws(() => normalizeCollectionRun(n, scope));
  assert.equal(calls, 0);
});
test('ordinary transport sends exact schedule-bound start and preserves start identity after lost outcome', async () => {
  const calls = [];
  let fail = true;
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/start')) {
      if (fail) {
        fail = false;
        throw new Error('lost');
      }
      return {
        runId: 'run-test',
        assignmentId: scope.assignmentId,
        scheduleId: scope.scheduleId,
        lessonVersion: scope.lessonVersion,
        revision: 0,
      };
    }
    return view();
  };
  const t = createCollectionTransport(scope, {
    request,
    verify: async () => true,
    startId: () => 'stable-start',
  });
  await assert.rejects(t.start());
  await t.start();
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    requestId: 'stable-start',
    scheduleId: scope.scheduleId,
  });
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(
    calls.every(
      (c) =>
        c.options.cache === 'no-store' &&
        c.options.credentials === 'same-origin',
    ),
    true,
  );
  assert.equal(
    calls.some((c) => c.path.includes('/preview/')),
    false,
  );
});
test('known start ack and failed readback retries GET only', async () => {
  let posts = 0,
    gets = 0;
  const t = createCollectionTransport(scope, {
    verify: async () => true,
    startId: () => 'stable',
    request: async (path) => {
      if (path.endsWith('/start')) {
        posts++;
        return {
          runId: 'run-test',
          assignmentId: scope.assignmentId,
          scheduleId: scope.scheduleId,
          lessonVersion: scope.lessonVersion,
          revision: 0,
        };
      }
      if (++gets === 1) throw new Error('get offline');
      return view();
    },
  });
  await assert.rejects(t.start());
  await t.start();
  assert.equal(posts, 1);
  assert.equal(gets, 2);
});
test('confirmed action plus failed GET stays readback-pending and retries GET only', async () => {
  let gets = 0,
    sends = 0;
  const h = harness({
    get: async () => {
      if (++gets === 2) throw new Error('readback lost');
      return view(gets > 2 ? 1 : 0);
    },
    send: async (_id, a) => {
      sends++;
      return {
        eventId: a.eventId,
        revision: 1,
        result: { outcome: 'correct', firstResponse: true, assisted: false },
      };
    },
  });
  await h.controller.load('run-test');
  await h.controller.submit('answer', { choiceId: 'a' });
  assert.equal(h.controller.snapshot().status, 'readback-pending');
  assert.equal(h.controller.snapshot().reportReady, false);
  assert.equal(h.controller.snapshot().pending.length, 0);
  await h.controller.retry();
  assert.equal(sends, 1);
  assert.equal(h.controller.snapshot().status, 'saved');
});
test('held same-question readback after ack still queues and saves late audio unavailable before navigation', async () => {
  const hold = deferred();
  let gets = 0;
  const sent = [];
  const h = harness({
    get: async () => (++gets === 2 ? hold.promise : view(gets > 2 ? 2 : 0)),
    send: async (_id, a) => {
      sent.push(a);
      return {
        eventId: a.eventId,
        revision: a.expectedRevision + 1,
        result: {
          outcome: a.type === 'answer' ? 'correct' : 'unavailable',
          firstResponse: a.type === 'answer',
          assisted: a.type !== 'answer',
        },
      };
    },
  });
  await h.controller.load('run-test');
  const occurrence = h.controller.snapshot().run.question.occurrenceId;
  const save = h.controller.submit('answer', { choiceId: 'a' });
  while (gets < 2) await new Promise((r) => setImmediate(r));
  h.controller.failAudio(occurrence);
  assert.equal(h.controller.canNavigate(), false);
  hold.resolve(view(1));
  await save;
  assert.deepEqual(
    sent.map((a) => a.type),
    ['answer', 'audio-unavailable'],
  );
  assert.equal(sent[1].expectedRevision, 1);
});
test('lost committed answer response, reload ahead snapshot, late failure replays exact answer then successor revision', async () => {
  const storage = memory(),
    first = harness({
      storage,
      send: async () => {
        throw new Error('lost');
      },
    });
  await first.controller.load('run-test');
  await first.controller.submit('answer', { choiceId: 'a' });
  const pending = first.controller.snapshot().pending[0].action;
  const sent = [];
  const h = harness({
    storage,
    get: async () => view(1),
    send: async (_id, a) => {
      sent.push(a);
      return {
        eventId: a.eventId,
        revision: a.expectedRevision + 1,
        result: {
          outcome: 'unavailable',
          firstResponse: false,
          assisted: true,
        },
      };
    },
  });
  await h.controller.load('run-test');
  h.controller.failAudio(h.controller.snapshot().run.question.occurrenceId);
  await h.controller.retry();
  assert.equal(JSON.stringify(sent[0]), JSON.stringify(pending));
  assert.equal(sent[1].expectedRevision, pending.expectedRevision + 1);
});
test('409 plus failed saved-state GET preserves input and cannot accept until explicit fresh GET', async () => {
  let gets = 0;
  const h = harness({
    get: async () => {
      if (++gets === 2) throw new Error('offline');
      return view();
    },
    send: async () => {
      throw Object.assign(new Error('stale'), { status: 409 });
    },
  });
  await h.controller.load('run-test');
  await h.controller.submit('help');
  assert.equal(h.controller.snapshot().status, 'conflict');
  assert.equal(h.controller.acceptConflict(), false);
  assert.equal(h.controller.snapshot().pending.length, 1);
  await h.controller.refreshConflict();
  assert.equal(h.controller.acceptConflict(), true);
  assert.equal(h.controller.snapshot().pending.length, 0);
});
test('held conflict GET after lock cannot repopulate old account', async () => {
  const hold = deferred();
  let gets = 0;
  const h = harness({
    get: async () => (++gets === 2 ? hold.promise : view()),
    send: async () => {
      throw Object.assign(new Error('stale'), { status: 409 });
    },
  });
  await h.controller.load('run-test');
  const saving = h.controller.submit('help');
  while (gets < 2) await new Promise((r) => setImmediate(r));
  h.controller.lock();
  hold.resolve(view());
  await saving;
  assert.equal(h.controller.snapshot().run, null);
  assert.equal(h.controller.snapshot().status, 'locked');
});
test('R5-E-007 refreshing a previously readable conflict disables acceptance and retains the exact input', async () => {
  const hold = deferred();
  let gets = 0;
  const h = harness({
    get: async () => (++gets === 3 ? hold.promise : view(gets > 1 ? 1 : 0)),
    send: async () => {
      throw Object.assign(new Error('stale'), { status: 409 });
    },
  });
  await h.controller.load('run-test');
  await h.controller.submit('help');
  const input = h.controller.snapshot().pending;
  assert.equal(h.controller.snapshot().conflictReady, true);
  const refreshing = h.controller.refreshConflict();
  assert.equal(h.controller.snapshot().conflictReady, false);
  assert.equal(h.controller.snapshot().reportReady, false);
  assert.equal(h.controller.acceptConflict(), false);
  assert.deepEqual(h.controller.snapshot().pending, input);
  hold.resolve(view(2));
  await refreshing;
  assert.equal(h.controller.acceptConflict(), true);
  assert.equal(h.controller.snapshot().run.revision, 2);
  assert.deepEqual(h.controller.snapshot().pending, []);
});
test('R5-E-007 an older conflict refresh cannot rewind a later accepted saved state', async () => {
  const older = deferred(),
    newer = deferred();
  let gets = 0;
  const h = harness({
    get: async () => {
      gets++;
      return gets === 3
        ? older.promise
        : gets === 4
          ? newer.promise
          : view(gets > 1 ? 1 : 0);
    },
    send: async () => {
      throw Object.assign(new Error('stale'), { status: 409 });
    },
  });
  await h.controller.load('run-test');
  await h.controller.submit('help');
  const first = h.controller.refreshConflict();
  while (gets < 3) await new Promise((r) => setImmediate(r));
  const second = h.controller.refreshConflict();
  while (gets < 4) await new Promise((r) => setImmediate(r));
  newer.resolve(view(3));
  await second;
  assert.equal(h.controller.acceptConflict(), true);
  older.resolve(view(2));
  await first;
  assert.equal(h.controller.snapshot().status, 'saved');
  assert.equal(h.controller.snapshot().run.revision, 3);
  assert.deepEqual(h.controller.snapshot().pending, []);
});
test('normal component destruction preserves exact unsent recovery; sign-out lock removes it', async () => {
  const h = harness({
    send: async () => {
      throw new Error('lost');
    },
  });
  await h.controller.load('run-test');
  await h.controller.submit('help');
  const expected = h.controller.snapshot().pending;
  h.controller.destroy();
  assert.equal(
    JSON.stringify(h.recovery.read('run-test')),
    JSON.stringify(expected),
  );
});
test('safe current cue must match the declared audio text and counts must remain internally consistent', () => {
  const a = structuredClone(view());
  a.lesson.playback.cues[0].transcript = 'unrelated future sentence';
  assert.throws(() => normalizeCollectionRun(a, scope));
  const b = structuredClone(view());
  b.question.choices[1].choiceId = b.question.choices[0].choiceId;
  assert.throws(() => normalizeCollectionRun(b, scope));
  const c = structuredClone(view());
  c.recap.check.independent = 10;
  assert.throws(() => normalizeCollectionRun(c, scope));
});

test('parent wire refuses a held response after identity changes and always names explicit collection selector', async () => {
  const { createCollectionClient } =
    await import('../lib/pilot-collection-client.ts');
  const hold = deferred(),
    calls = [];
  let current = true;
  const me = {
    installationId: scope.installationId,
    user: { id: 'parent-test', role: 'parent', mustChangePassword: false },
    children: [{ id: scope.childId }],
  };
  const api = createCollectionClient(me, {
    verify: async () => current,
    request: async (path) => {
      calls.push(path);
      return hold.promise;
    },
  });
  const result = api.library(scope.childId);
  await new Promise((r) => setImmediate(r));
  current = false;
  hold.resolve({ items: [] });
  await assert.rejects(result, /could not be loaded/);
  assert.equal(
    calls[0],
    '/api/pilot/children/child-test/library?collectionVersion=little-hanzi-path-1-v1',
  );
});
test('parent verification is given current child scope before and after a response', async () => {
  const { createCollectionClient } =
    await import('../lib/pilot-collection-client.ts');
  let count = 0;
  const children = [];
  const api = createCollectionClient(
    {
      user: { id: 'parent', role: 'parent', mustChangePassword: false },
      installationId: scope.installationId,
      children: [{ id: scope.childId }],
    },
    {
      verify: async (child) => {
        children.push(child);
        return ++count === 1 || child === undefined;
      },
      request: async () => ({ items: [] }),
    },
  );
  await assert.rejects(api.library(scope.childId));
  assert.deepEqual(children, [scope.childId, scope.childId]);
});
