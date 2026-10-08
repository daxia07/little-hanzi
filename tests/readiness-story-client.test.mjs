import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStorySession,
  createStoryRecovery,
  STORY_VERSION,
  normalizeStoryRun,
} from '../lib/story-client.ts';
const makeRun = (revision = 0, status = 'open') => ({
  runId: 'synthetic-story',
  lessonId: 'forest-01',
  lessonVersion: STORY_VERSION,
  seed: 17,
  revision,
  state: {
    phase: 'initial',
    stepId: 'check',
    questionId: 'check-mu-sound',
    questionStatus: status,
    soundReview: 'synthetic',
    learnPanel: null,
    attempts: 0,
    hintLevel: 0,
    assisted: false,
    placedComponents: { left: null, right: null },
    introPlan: null,
    readPanel: null,
    completedAt: null,
    reviewCompletedAt: null,
  },
  events: [],
  recap: {},
  reviewAvailableAt: null,
  reviewDue: false,
});
function setup(options = {}) {
  const data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const recovery = createStoryRecovery(storage);
  let run = makeRun();
  const sent = [];
  const transport = {
    async createRun() {
      return run;
    },
    async getRun() {
      return run;
    },
    async listRuns() {
      return [];
    },
    async sendAction(id, action) {
      sent.push(structuredClone(action));
      if (options.fail?.()) throw Error('lost response');
      if (options.send) return options.send(action);
      run = {
        ...run,
        revision: run.revision + 1,
        state: {
          ...run.state,
          questionStatus:
            action.type === 'audio-unavailable' ? 'unavailable' : 'answered',
        },
      };
      return {
        eventId: action.eventId,
        lessonVersion: STORY_VERSION,
        state: run.state,
        revision: run.revision,
        result: {
          outcome:
            action.type === 'audio-unavailable' ? 'unavailable' : 'correct',
        },
      };
    },
  };
  const session = createStorySession({
    transport,
    recovery,
    id: () => `event-${sent.length}-${data.size}`,
  });
  return {
    session,
    recovery,
    transport,
    data,
    sent,
    get run() {
      return run;
    },
    set run(r) {
      run = r;
    },
  };
}
test('wrong-version runs are refused without reading or deleting V1 recovery', () => {
  assert.throws(
    () => normalizeStoryRun({ ...makeRun(), lessonVersion: 'forest-01-v1' }),
    /version/i,
  );
  const f = setup();
  f.data.set('little-hanzi:forest:last-run', 'legacy');
  assert.equal(f.recovery.lastRun(), null);
  assert.equal(f.data.get('little-hanzi:forest:last-run'), 'legacy');
});
test('pending envelope survives lost response and exact retry uses same event and revision', async () => {
  let fail = true;
  const f = setup({ fail: () => fail });
  await f.session.open('synthetic-story');
  await f.session.submit('answer', {
    questionId: 'check-mu-sound',
    choiceId: 'mu',
  });
  assert.equal(f.session.snapshot().status, 'pending');
  const first = f.sent[0];
  assert.deepEqual(f.recovery.read('synthetic-story'), [first]);
  fail = false;
  await f.session.retry();
  assert.deepEqual(f.sent[1], first);
  assert.equal(f.session.snapshot().status, 'saved');
  assert.deepEqual(f.recovery.read('synthetic-story'), []);
});
test('late required failure queues unavailable behind in-flight answer and blocks continue', async () => {
  let release;
  const f = setup({
    send: (a) =>
      new Promise((r) => {
        release = () =>
          r({
            eventId: a.eventId,
            lessonVersion: STORY_VERSION,
            revision: 1,
            state: { ...makeRun().state, questionStatus: 'answered' },
            result: { outcome: 'correct' },
          });
      }),
  });
  await f.session.open('synthetic-story');
  const answer = f.session.submit('answer', {
    questionId: 'check-mu-sound',
    choiceId: 'mu',
  });
  assert.equal(f.session.snapshot().status, 'saving');
  f.session.failRequiredAudio('check-mu-sound');
  assert.equal(f.session.snapshot().pending.length, 2);
  assert.equal(f.session.canContinue(), false);
  const queued = f.session.snapshot().pending[1];
  assert.equal(queued.type, 'audio-unavailable');
  assert.equal(queued.expectedRevision, 1);
  f.transport.sendAction = async (_id, a) => ({
    eventId: a.eventId,
    lessonVersion: STORY_VERSION,
    revision: 2,
    state: { ...makeRun().state, questionStatus: 'unavailable' },
    result: { outcome: 'unavailable' },
  });
  release();
  await answer;
  assert.equal(f.sent.length, 1);
  assert.equal(f.session.snapshot().run.state.questionStatus, 'unavailable');
  assert.equal(f.session.canContinue(), true);
});
test('failure for an old question cannot enqueue unavailable; committed unavailable never reopens', async () => {
  const f = setup();
  await f.session.open('synthetic-story');
  f.session.failRequiredAudio('fam-mu');
  assert.equal(f.session.snapshot().pending.length, 0);
  await f.session.submit('audio-unavailable', { questionId: 'check-mu-sound' });
  f.session.failRequiredAudio('check-mu-sound');
  assert.equal(f.session.snapshot().pending.length, 0);
  assert.equal(f.session.snapshot().run.state.questionStatus, 'unavailable');
});
test('stale conflicts refetch saved state and require explicit acknowledgement without answer rebase', async () => {
  const f = setup({
    send: async () => {
      throw Object.assign(Error('changed'), {
        status: 409,
        code: 'STALE_REVISION',
      });
    },
  });
  await f.session.open('synthetic-story');
  f.run = {
    ...makeRun(4),
    state: { ...makeRun().state, questionId: 'check-lin-sound' },
  };
  await f.session.submit('answer', {
    questionId: 'check-mu-sound',
    choiceId: 'mu',
  });
  assert.equal(f.session.snapshot().status, 'conflict');
  assert.equal(f.session.snapshot().run.revision, 4);
  assert.equal(f.session.canContinue(), false);
  assert.equal(f.sent.length, 1);
  f.session.acceptConflict();
  assert.equal(f.session.snapshot().status, 'saved');
  assert.equal(f.sent.length, 1);
});
test('blocked storage explains reload risk while keeping unsent action in memory', async () => {
  const f = setup({ fail: () => true });
  f.recovery.write = () => false;
  await f.session.open('synthetic-story');
  await f.session.submit('hint', { questionId: 'check-mu-sound' });
  assert.equal(f.session.snapshot().storageAvailable, false);
  assert.equal(f.session.snapshot().pending.length, 1);
  assert.match(f.session.snapshot().notice, /reload/i);
});
test('refresh reads saved panel and recovers only the current version/run outbox', async () => {
  const f = setup({ fail: () => true });
  await f.session.open('synthetic-story');
  await f.session.submit('hint', { questionId: 'check-mu-sound' });
  const second = createStorySession({
    transport: f.transport,
    recovery: f.recovery,
  });
  await second.open('synthetic-story');
  assert.equal(second.snapshot().pending[0].eventId, f.sent[0].eventId);
  assert.equal(second.snapshot().status, 'pending');
  f.run = {
    ...makeRun(),
    state: {
      ...makeRun().state,
      stepId: 'learn',
      questionId: null,
      learnPanel: 'learn-lin',
    },
  };
  assert.equal(normalizeStoryRun(f.run).state.learnPanel, 'learn-lin');
});

test('lost-response replay does not replace newer server projection with an old ack', async () => {
  const f = setup();
  await f.session.open('synthetic-story');
  const queued = {
    runId: 'synthetic-story',
    lessonVersion: STORY_VERSION,
    eventId: 'old-committed-event',
    expectedRevision: 0,
    stepId: 'check',
    type: 'answer',
    payload: { questionId: 'check-mu-sound', choiceId: 'mu' },
    createdAt: '2026-09-26T00:00:00Z',
  };
  f.recovery.write('synthetic-story', [queued]);
  f.run = {
    ...makeRun(4),
    state: { ...makeRun().state, questionId: 'check-lin-sound' },
  };
  f.transport.sendAction = async () => ({
    eventId: queued.eventId,
    lessonVersion: STORY_VERSION,
    revision: 1,
    state: { ...makeRun().state, questionStatus: 'answered' },
    result: { outcome: 'correct' },
  });
  await f.session.open('synthetic-story');
  await f.session.retry();
  assert.equal(f.session.snapshot().pending.length, 0);
  assert.equal(f.session.snapshot().run.revision, 4);
  assert.equal(f.session.snapshot().run.state.questionId, 'check-lin-sound');
});
test('refresh while an action is pending never silently discards exact recoverable input', async () => {
  const f = setup({ fail: () => true });
  await f.session.open('synthetic-story');
  await f.session.submit('hint', { questionId: 'check-mu-sound' });
  const event = f.session.snapshot().pending[0];
  await f.session.refresh();
  assert.deepEqual(f.session.snapshot().pending[0], event);
  assert.equal(f.session.snapshot().status, 'pending');
});

test('lost committed answer reload and late failure retain duplicate identity and exact successor revision', async () => {
  const f = setup();
  const old = {
    runId: 'synthetic-story',
    lessonVersion: STORY_VERSION,
    eventId: 'lost-answer',
    expectedRevision: 1,
    stepId: 'check',
    type: 'answer',
    payload: { questionId: 'check-mu-sound', choiceId: 'mu' },
    createdAt: '2026-09-26T00:00:00Z',
  };
  f.recovery.write('synthetic-story', [old]);
  f.run = { ...makeRun(2, 'answered') };
  const sent = [];
  f.transport.sendAction = async (_id, a) => {
    sent.push(structuredClone(a));
    if (a.type === 'answer')
      return {
        eventId: a.eventId,
        lessonVersion: STORY_VERSION,
        revision: 2,
        state: makeRun(2, 'answered').state,
        result: { outcome: 'correct' },
      };
    assert.equal(a.expectedRevision, 2);
    return {
      eventId: a.eventId,
      lessonVersion: STORY_VERSION,
      revision: 3,
      state: makeRun(3, 'unavailable').state,
      result: { outcome: 'unavailable' },
    };
  };
  await f.session.open('synthetic-story');
  f.session.failRequiredAudio('check-mu-sound');
  await f.session.retry();
  assert.deepEqual(sent[0], old);
  assert.equal(sent[1].type, 'audio-unavailable');
  assert.equal(sent[1].expectedRevision, 2);
  assert.equal(f.session.snapshot().run.state.questionStatus, 'unavailable');
  assert.equal(f.session.snapshot().status, 'saved');
});
test('late required audio failure also commits unavailable after a saved first wrong answer', async () => {
  const f = setup();
  f.run = {
    ...makeRun(1),
    state: { ...makeRun().state, attempts: 1, hintLevel: 1, assisted: true },
  };
  await f.session.open('synthetic-story');
  f.session.failRequiredAudio('check-mu-sound');
  await f.session.retry();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'audio-unavailable');
  assert.equal(f.session.snapshot().run.state.questionStatus, 'unavailable');
});

test('run normalization does not carry unknown answer-key fields into safe client state', () => {
  const raw = makeRun();
  raw.state.correctChoiceId = 'mu';
  raw.state.internalAnswerKey = { x: 'mu' };
  raw.correctChoiceId = 'mu';
  const safe = normalizeStoryRun(raw);
  assert.equal('correctChoiceId' in safe, false);
  assert.equal('correctChoiceId' in safe.state, false);
  assert.equal('internalAnswerKey' in safe.state, false);
});

test('opening with blocked last-run storage immediately reports reload risk', async () => {
  const recovery = createStoryRecovery({
    getItem: () => null,
    setItem: () => {
      throw Error('blocked');
    },
    removeItem() {},
  });
  const transport = {
    getRun: async () => makeRun(),
    createRun: async () => makeRun(),
    sendAction: async () => {
      throw Error('not used');
    },
  };
  const session = createStorySession({ transport, recovery });
  await session.open('synthetic-story');
  assert.equal(session.snapshot().storageAvailable, false);
  assert.match(session.snapshot().notice, /reload/i);
});

test('conflict plus failed saved-state GET cannot discard unsent input until retry GET succeeds', async () => {
  const f = setup({
    send: async () => {
      throw Object.assign(Error('stale'), {
        status: 409,
        code: 'STALE_REVISION',
      });
    },
  });
  await f.session.open('synthetic-story');
  let getFails = true;
  f.transport.getRun = async () => {
    if (getFails) throw Error('offline read');
    return {
      ...makeRun(8),
      state: { ...makeRun().state, questionId: 'check-lin-sound' },
    };
  };
  await f.session.submit('answer', {
    questionId: 'check-mu-sound',
    choiceId: 'mu',
  });
  assert.equal(f.session.snapshot().conflictReady, false);
  f.session.acceptConflict();
  assert.equal(f.session.snapshot().status, 'conflict');
  assert.equal(f.session.snapshot().pending.length, 1);
  getFails = false;
  await f.session.refresh();
  assert.equal(f.session.snapshot().conflictReady, true);
  f.session.acceptConflict();
  assert.equal(f.session.snapshot().run.revision, 8);
  assert.equal(f.session.snapshot().status, 'saved');
  assert.equal(f.sent.length, 1);
});
test('confirmed completion with report GET failure retains saved action and retries GET without resending', async () => {
  const f = setup();
  await f.session.open('synthetic-story');
  let gets = 0,
    failGet = true;
  f.transport.sendAction = async (_id, a) => {
    f.sent.push(a);
    f.run = {
      ...makeRun(1),
      state: {
        ...makeRun().state,
        stepId: 'recap',
        questionId: null,
        questionStatus: null,
        completedAt: '2026-09-26T00:00:00Z',
      },
      recap: {
        final: {
          total: 4,
          independentCorrect: 4,
          supported: 0,
          unavailable: 0,
          pending: 0,
        },
      },
    };
    return {
      eventId: a.eventId,
      lessonVersion: STORY_VERSION,
      revision: 1,
      state: f.run.state,
      result: { outcome: 'recorded' },
    };
  };
  f.transport.getRun = async () => {
    gets++;
    if (failGet) throw Error('read offline');
    return f.run;
  };
  await f.session.submit('continue');
  assert.equal(f.session.snapshot().status, 'readback-pending');
  assert.equal(f.session.snapshot().reportReady, false);
  assert.equal(f.session.snapshot().pending.length, 0);
  assert.match(f.session.snapshot().notice, /saved/i);
  assert.equal(f.session.canContinue(), false);
  failGet = false;
  await f.session.retry();
  assert.equal(f.sent.length, 1);
  assert.equal(gets, 2);
  assert.equal(f.session.snapshot().reportReady, true);
  assert.equal(f.session.snapshot().run.recap.final.independentCorrect, 4);
});
