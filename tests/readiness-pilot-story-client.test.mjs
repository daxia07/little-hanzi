import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPilotStoryRecovery,
  createPilotStoryTransport,
  createScopeGuard,
  normalizeStoryRun,
} from '../lib/pilot-story-client.ts';
const scope = {
  installationId: 'install',
  accountId: 'bing',
  childId: 'bing',
  publicationId: 'pub',
  contentDigest: 'sha256:' + 'a'.repeat(64),
  assignmentId: 'assignment',
};
const state = {
  phase: 'initial',
  stepId: 'welcome',
  questionId: null,
  questionStatus: null,
  learnPanel: null,
  soundReview: 'reviewed',
  attempts: 0,
  hintLevel: 0,
  assisted: false,
  placedComponents: { left: null, right: null },
  introPlan: null,
  readPanel: null,
  completedAt: null,
  reviewCompletedAt: null,
};
const run = {
  schemaVersion: 'r3-story-view-1',
  runId: 'r',
  lessonId: 'forest-01',
  lessonVersion: 'forest-01-v4',
  adapterId: 'forest-story',
  adapterVersion: 'forest-story-v1',
  ...scope,
  seed: 0,
  revision: 0,
  state,
  lesson: {
    lessonId: 'forest-01',
    lessonVersion: 'forest-01-v4',
    playback: {
      schemaVersion: 'r3-playback-1',
      kind: 'local-device',
      voices: [{ name: 'Tingting', lang: 'zh-CN', localService: true }],
      fallback: 'unavailable',
      cues: [
        {
          id: 'greeting',
          transcript: '你好',
          assetUrl: null,
          assetDigest: null,
        },
      ],
    },
  },
  events: [],
  recap: {},
  available: true,
  reason: null,
  reviewDue: false,
  reviewAvailableAt: null,
};
const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
    m,
  };
};
test('ordinary transport uses assignment start and exact request, never preview', async () => {
  const calls = [];
  const t = createPilotStoryTransport(scope, {
    verifyIdentity: async () => true,
    request: async (path, init) => {
      calls.push([path, init]);
      return { ok: true, status: 200, json: async () => run };
    },
    id: () => 'stable-start',
  });
  await t.createRun();
  await t.createRun();
  assert.equal(
    calls[0][0],
    '/api/pilot/curriculum/assignments/assignment/start',
  );
  assert.deepEqual(JSON.parse(calls[0][1].body), { requestId: 'stable-start' });
  assert.equal(calls[2][1].body, calls[0][1].body);
  assert.equal(calls[1][0], '/api/pilot/curriculum/learning-runs/r');
  assert.equal(calls[1][1].method, 'GET');
  assert.equal(calls[0][1].cache, 'no-store');
});
test('outbox binds account child installation publication version and run', () => {
  const s = storage();
  const a = createPilotStoryRecovery(scope, s);
  const pending = {
    runId: 'r',
    lessonVersion: 'forest-01-v4',
    eventId: 'evt',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
    createdAt: 'now',
  };
  assert.equal(a.write('r', [pending]), true);
  assert.equal(a.read('r').length, 1);
  for (const field of [
    'accountId',
    'childId',
    'installationId',
    'publicationId',
  ]) {
    assert.deepEqual(
      createPilotStoryRecovery({ ...scope, [field]: 'other' }, s).read('r'),
      [],
    );
  }
  assert.ok([...s.m.keys()][0].includes('forest-01-v4'));
});
test('safe ordinary run accepts reviewed without pretending synthetic and rejects foreign identity', () => {
  assert.equal(normalizeStoryRun(run, scope).state.soundReview, 'reviewed');
  assert.throws(() => normalizeStoryRun({ ...run, childId: 'other' }, scope));
  assert.throws(() =>
    normalizeStoryRun({ ...run, lessonVersion: 'forest-01-v3' }, scope),
  );
  assert.throws(() =>
    normalizeStoryRun({ ...run, adapterVersion: 'other' }, scope),
  );
});
test('late parent response is rejected after child scope changes or destroy', () => {
  const g = createScopeGuard('child-a');
  const a = g.capture();
  assert.equal(g.current(a), true);
  g.change('child-b');
  assert.equal(g.current(a), false);
  const b = g.capture();
  g.destroy();
  assert.equal(g.current(b), false);
});
test('changed identity prevents ordinary action transport before request', async () => {
  let count = 0;
  const t = createPilotStoryTransport(scope, {
    verifyIdentity: async () => false,
    request: async () => {
      count++;
      throw Error('should not request');
    },
  });
  await assert.rejects(
    t.sendAction('r', {
      eventId: 'e',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: {},
    }),
  );
  assert.equal(count, 0);
});
import { createStorySession } from '../lib/pilot-story-client.ts';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function harness(overrides = {}) {
  const s = storage();
  const recovery = createPilotStoryRecovery(scope, s);
  let value = structuredClone(run);
  const sent = [];
  const transport = {
    createRun: async () => value,
    getRun: async () => value,
    sendAction: async (_, a) => {
      sent.push(a);
      value = { ...value, revision: value.revision + 1 };
      return {
        eventId: a.eventId,
        lessonVersion: 'forest-01-v4',
        revision: value.revision,
        state: value.state,
        result: { outcome: 'continued' },
      };
    },
    ...overrides,
  };
  return {
    session: createStorySession({
      scope,
      recovery,
      transport,
      verifyIdentity: async () => true,
      id: () => 'evt',
    }),
    recovery,
    sent,
    get: () => value,
    set: (v) => {
      value = v;
    },
  };
}
test('late start response after controller destroy cannot resurrect prior user state', async () => {
  const d = deferred();
  const h = harness({ createRun: () => d.promise });
  const pending = h.session.create();
  await new Promise((r) => setImmediate(r));
  h.session.destroy();
  d.resolve(run);
  await pending;
  assert.equal(h.session.snapshot().run, null);
});
test('lost action response retains identical event through new controller authenticated GET', async () => {
  let lose = true;
  const h = harness({
    sendAction: async (_, a) => {
      h.sent.push(a);
      if (lose) {
        lose = false;
        throw Error('lost');
      }
      return {
        eventId: a.eventId,
        lessonVersion: 'forest-01-v4',
        revision: 1,
        state,
        result: { outcome: 'continued' },
      };
    },
  });
  await h.session.open('r');
  await h.session.submit('continue');
  assert.equal(h.session.snapshot().status, 'pending');
  await h.session.retry();
  assert.deepEqual(h.sent[0], h.sent[1]);
  assert.equal(h.session.snapshot().status, 'saved');
});
test('withdrawn history is readable but cannot submit or retry recovered answers', async () => {
  const h = harness();
  await h.session.open('r');
  h.set({ ...run, available: false, reason: 'withdrawn' });
  await h.session.refresh();
  assert.equal(h.session.snapshot().status, 'unavailable');
  assert.equal(await h.session.submit('continue'), false);
  assert.equal(h.sent.length, 0);
});
test('acknowledged completion plus report failure retries GET without action duplication', async () => {
  let fail = false,
    count = 0;
  const done = {
    ...state,
    stepId: 'recap',
    completedAt: '2026-09-27T00:00:00Z',
  };
  const h = harness({
    getRun: async () => {
      if (fail) throw Error('readoutage');
      return {
        ...run,
        state: done,
        revision: 1,
        recap: { buildCompleted: true },
      };
    },
    sendAction: async (_, a) => {
      count++;
      fail = true;
      return {
        eventId: a.eventId,
        lessonVersion: 'forest-01-v4',
        revision: 1,
        state: done,
        result: { outcome: 'complete' },
      };
    },
  });
  await h.session.open('r');
  await h.session.submit('continue');
  assert.equal(h.session.snapshot().status, 'readback-pending');
  assert.equal(h.session.snapshot().reportReady, false);
  assert.equal(h.session.snapshot().pending.length, 0);
  fail = false;
  await h.session.retry();
  assert.equal(count, 1);
  assert.equal(h.session.snapshot().reportReady, true);
});
import {
  registerPilotStoryController,
  lockPilotStoryControllers,
} from '../lib/pilot-story-client.ts';
test('shared-device lock synchronously stops prior controller and suppresses pending retry', async () => {
  const h = harness({
    sendAction: async () => {
      throw Error('offline');
    },
  });
  await h.session.open('r');
  await h.session.submit('continue');
  let stopped = false;
  const unregister = registerPilotStoryController(() => {
    stopped = true;
    h.session.lock();
  });
  lockPilotStoryControllers();
  assert.equal(stopped, true);
  assert.equal(h.session.snapshot().status, 'locked');
  assert.equal(h.session.snapshot().run, null);
  await h.session.retry();
  assert.equal(h.sent.length, 0);
  unregister();
});
test('original start identity survives new recovery instance while another publication has a different identity', () => {
  const s = storage();
  const first = createPilotStoryRecovery(scope, s).startRequestId();
  assert.equal(createPilotStoryRecovery(scope, s).startRequestId(), first);
  assert.notEqual(
    createPilotStoryRecovery(
      { ...scope, publicationId: 'pub-next' },
      s,
    ).startRequestId(),
    first,
  );
});
test('child GET reconciliation occurs before old outbox is exposed to retry', async () => {
  const d = deferred(),
    s = storage(),
    recovery = createPilotStoryRecovery(scope, s);
  recovery.write('r', [
    {
      runId: 'r',
      lessonVersion: 'forest-01-v4',
      eventId: 'e',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: {},
      createdAt: 'now',
    },
  ]);
  let sent = 0;
  const session = createStorySession({
    scope,
    recovery,
    verifyIdentity: async () => true,
    transport: {
      createRun: async () => run,
      getRun: () => d.promise,
      sendAction: async () => {
        sent++;
        throw Error('should not send');
      },
    },
  });
  const opening = session.open('r');
  await new Promise((r) => setImmediate(r));
  assert.equal(session.snapshot().run, null);
  assert.deepEqual(session.snapshot().pending, []);
  await session.retry();
  assert.equal(sent, 0);
  d.resolve(run);
  await opening;
  assert.equal(session.snapshot().pending[0].eventId, 'e');
  assert.equal(sent, 0);
});
test('new parent operation invalidates an older response even within the same child scope', () => {
  const guard = createScopeGuard('child-a');
  guard.activate();
  const earlier = guard.begin();
  assert.equal(guard.current(earlier), true);
  const latest = guard.begin();
  assert.equal(guard.current(earlier), false);
  assert.equal(guard.current(latest), true);
  guard.destroy();
  guard.activate();
  assert.equal(guard.current(latest), false);
});
test('held conflict GET cannot repopulate old child after synchronous sign-out lock', async () => {
  const d = deferred();
  let reads = 0;
  const h = harness({
    getRun: async () => (++reads === 1 ? run : d.promise),
    sendAction: async () => {
      throw { status: 409, code: 'STALE_REVISION' };
    },
  });
  await h.session.open('r');
  const write = h.session.submit('continue');
  await new Promise((r) => setImmediate(r));
  h.session.lock();
  d.resolve({ ...run, revision: 1 });
  await write;
  assert.equal(h.session.snapshot().run, null);
  assert.equal(h.session.snapshot().status, 'locked');
  assert.equal(h.session.snapshot().conflictReady, false);
});
