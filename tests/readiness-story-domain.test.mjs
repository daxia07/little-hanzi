import test from 'node:test';
import assert from 'node:assert/strict';
import * as content from '../lib/preview/content.ts';
import {
  createInitialRun,
  applyAction,
  deriveRecap,
  actionAck,
} from '../lib/preview/domain.ts';
import { createFixture } from '../lib/preview/fixtures.ts';
const now = '2026-09-25T00:00:00.000Z';
function harness(input = {}) {
  let run = createInitialRun({
    runId: 'r2-domain',
    seed: 17,
    now,
    lessonVersion: 'forest-01-v3',
    synthetic: true,
    testRunId: 'r2-domain-tests',
    ...input,
  });
  const events = [];
  let n = 0;
  return {
    get run() {
      return run;
    },
    events,
    try(type, payload = {}, time = now) {
      return applyAction(
        run,
        events,
        {
          eventId: `test-${++n}`,
          expectedRevision: run.revision,
          stepId: run.state.stepId,
          type,
          payload,
        },
        time,
      );
    },
    send(type, payload = {}, time = now) {
      const result = this.try(type, payload, time);
      assert.equal(result.ok, true, result.error?.message);
      run = result.run;
      events.push(result.event);
      return result;
    },
    answer(id, choice) {
      return this.send('answer', { questionId: id, choiceId: choice });
    },
    next() {
      return this.send('continue');
    },
  };
}
function learn(h, mode = 'familiar') {
  h.next();
  if (mode === 'new') {
    h.answer('fam-mu', 'lin');
    h.answer('fam-mu', 'mu');
  } else h.answer('fam-mu', 'mu');
  h.next();
  if (mode !== 'familiar') {
    h.answer('fam-lin', 'mu');
    h.answer('fam-lin', 'lin');
  } else h.answer('fam-lin', 'lin');
  h.next();
}
function toChecks(h, mode = 'familiar') {
  learn(h, mode);
  while (h.run.state.stepId === 'learn') h.next();
  h.send('place-component', { componentId: 'mu-a', slot: 'left' });
  h.send('place-component', { componentId: 'mu-b', slot: 'right' });
  h.next();
  h.answer('find-mu', 'mu');
  h.next();
  h.answer('find-lin', 'lin');
  h.next();
  h.next();
  h.next();
}
test('[R2-E-001] V3 selection is additive, V1 state/ack structure stays unchanged, unknown version fails', () => {
  const old = createInitialRun({ runId: 'old', seed: 17, now });
  assert.equal(old.lessonVersion, 'forest-01-v1');
  assert.equal(Object.hasOwn(old.state, 'learnPanel'), false);
  assert.equal(Object.hasOwn(old.state, 'soundReview'), false);
  const h = harness();
  assert.equal(h.run.lessonVersion, 'forest-01-v3');
  assert.equal(h.run.state.learnPanel, null);
  assert.equal(h.run.state.soundReview, 'synthetic');
  assert.throws(
    () =>
      createInitialRun({
        runId: 'unknown',
        seed: 17,
        now,
        lessonVersion: 'forest-01-v99',
      }),
    (e) => e.code === 'INVALID_REQUEST',
  );
  const ack = actionAck(h.next());
  assert.equal(ack.lessonVersion, 'forest-01-v3');
  const oldh = harness({ lessonVersion: 'forest-01-v1' });
  assert.equal(Object.hasOwn(actionAck(oldh.next()), 'lessonVersion'), false);
});
test('[R2-E-001/006] unreviewed ordinary sound and forged eligibility cannot receive sound answers', () => {
  for (const input of [
    { synthetic: false, testRunId: null },
    { synthetic: true, testRunId: null },
    { synthetic: true, testRunId: ' ' },
    { synthetic: false, testRunId: 'test', soundReview: 'synthetic' },
  ]) {
    const h = harness(input);
    assert.equal(h.run.state.soundReview, 'pending');
    h.next();
    const result = h.try('answer', { questionId: 'fam-mu', choiceId: 'mu' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_TRANSITION');
    assert.equal(h.run.revision, 1);
    h.send('audio-unavailable', { questionId: 'fam-mu' });
    assert.equal(deriveRecap(h.events).familiarity.unavailable, 1);
  }
});
test('[R2-E-002] actual familiarity gives one combined reminder or two persisted target panels', () => {
  const familiar = harness();
  learn(familiar);
  assert.equal(familiar.run.state.learnPanel, 'reminder');
  familiar.next();
  assert.equal(familiar.run.state.stepId, 'build');
  assert.equal(familiar.run.state.learnPanel, null);
  for (const mode of ['new', 'mixed']) {
    const h = harness();
    learn(h, mode);
    assert.equal(h.run.state.learnPanel, 'learn-mu');
    const persisted = JSON.parse(JSON.stringify(h.run));
    assert.equal(persisted.state.learnPanel, 'learn-mu');
    h.next();
    assert.equal(h.run.state.stepId, 'learn');
    assert.equal(h.run.state.learnPanel, 'learn-lin');
    h.next();
    assert.equal(h.run.state.stepId, 'build');
    assert.equal(h.run.state.learnPanel, null);
    assert.equal(h.run.state.introPlan.mode, mode === 'new' ? 'full' : 'mixed');
  }
});
test('[R2-E-002/005] late unavailable wins over independent familiarity for routing without deleting answer', () => {
  const h = harness();
  h.next();
  h.answer('fam-mu', 'mu');
  h.send('audio-unavailable', { questionId: 'fam-mu' });
  assert.equal(
    h.events.find((e) => e.type === 'answer').payload.choiceId,
    'mu',
  );
  assert.equal(h.events.find((e) => e.type === 'answer').firstResponse, true);
  h.next();
  h.answer('fam-lin', 'lin');
  h.next();
  assert.deepEqual(h.run.state.introPlan, {
    mode: 'mixed',
    full: ['mu'],
    reminder: ['lin'],
  });
  assert.equal(h.run.state.learnPanel, 'learn-mu');
});
test('[R2-E-003] requested assistance does not consume wrong retry and first wrong records prior help', () => {
  const h = harness();
  h.next();
  h.send('hint', { questionId: 'fam-mu' });
  h.send('hint', { questionId: 'fam-mu' });
  const first = h.answer('fam-mu', 'lin');
  assert.equal(first.result.assisted, true);
  assert.equal(first.result.firstResponse, true);
  assert.equal(h.run.state.questionStatus, 'open');
  assert.equal(h.run.state.hintLevel, 1);
  h.answer('fam-mu', 'ren');
  assert.equal(h.run.state.questionStatus, 'demonstrated');
  assert.equal(h.run.state.hintLevel, 2);
  const v1 = harness({ lessonVersion: 'forest-01-v1' });
  v1.next();
  v1.send('hint', { questionId: 'fam-mu' });
  assert.equal(v1.answer('fam-mu', 'lin').result.assisted, false);
});
test('[R2-E-005] unavailable after answer/demonstration commits once, never reopens, stale question fails; V1 unchanged', () => {
  for (const demonstrated of [false, true]) {
    const h = harness();
    h.next();
    if (demonstrated) {
      h.answer('fam-mu', 'lin');
      h.answer('fam-mu', 'ren');
    } else h.answer('fam-mu', 'mu');
    h.send('audio-unavailable', { questionId: 'fam-mu' });
    const count = h.events.length;
    assert.equal(
      h.try('audio-unavailable', { questionId: 'fam-mu' }).ok,
      false,
    );
    assert.equal(
      h.try('answer', { questionId: 'fam-mu', choiceId: 'mu' }).ok,
      false,
    );
    assert.equal(h.events.length, count);
    h.next();
    assert.equal(
      h.try('audio-unavailable', { questionId: 'fam-mu' }).ok,
      false,
    );
    assert.equal(h.run.state.questionId, 'fam-lin');
  }
  const old = harness({ lessonVersion: 'forest-01-v1' });
  old.next();
  old.answer('fam-mu', 'mu');
  assert.equal(
    old.try('audio-unavailable', { questionId: 'fam-mu' }).ok,
    false,
  );
});
test('[R2-E-003/006] needs-help exact final categories; ordinary sound unavailable leaves visual Find playable', () => {
  const h = harness();
  toChecks(h, 'new');
  h.answer('check-mu-sound', 'lin');
  h.answer('check-mu-sound', 'ren');
  h.next();
  h.answer('check-lin-sound', 'lin');
  h.next();
  h.send('hint', { questionId: 'check-mu-reading' });
  h.answer('check-mu-reading', 'audio-mu');
  h.next();
  h.send('audio-unavailable', { questionId: 'check-lin-reading' });
  h.next();
  assert.deepEqual(deriveRecap(h.events).final, {
    total: 4,
    independentCorrect: 1,
    supported: 2,
    unavailable: 1,
    pending: 0,
  });
  const ordinary = harness({ synthetic: false, testRunId: null });
  ordinary.next();
  ordinary.send('audio-unavailable', { questionId: 'fam-mu' });
  ordinary.next();
  ordinary.send('audio-unavailable', { questionId: 'fam-lin' });
  ordinary.next();
  while (ordinary.run.state.stepId === 'learn') ordinary.next();
  ordinary.send('place-component', { componentId: 'mu-a', slot: 'left' });
  ordinary.send('place-component', { componentId: 'mu-b', slot: 'right' });
  ordinary.next();
  assert.equal(ordinary.answer('find-mu', 'mu').result.outcome, 'correct');
  assert.equal(deriveRecap(ordinary.events).final.independentCorrect, 0);
});
test('[R2-E-009/010] stale revision and forged score/media fields fail without altering source run/events', () => {
  const h = harness();
  h.next();
  const before = JSON.stringify(h.run);
  const stale = applyAction(
    h.run,
    h.events,
    {
      eventId: 'stale',
      expectedRevision: 0,
      stepId: 'familiarity',
      type: 'answer',
      payload: { questionId: 'fam-mu', choiceId: 'mu' },
    },
    now,
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_REVISION');
  for (const field of ['soundReview', 'correct']) {
    const result = h.try('answer', {
      questionId: 'fam-mu',
      choiceId: 'mu',
      [field]: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_REQUEST');
  }
  assert.equal(JSON.stringify(h.run), before);
  assert.equal(h.events.length, 1);
});
test('[R2-E-015] 24h delayed review is separate and completed V3 cannot restart', () => {
  const h = harness();
  toChecks(h);
  for (const [id, answer] of [
    ['check-mu-sound', 'mu'],
    ['check-lin-sound', 'lin'],
    ['check-mu-reading', 'audio-mu'],
    ['check-lin-reading', 'audio-lin'],
  ]) {
    h.answer(id, answer);
    h.next();
  }
  const initial = deriveRecap(h.events).final;
  assert.equal(
    h.try('start-review', {}, '2026-09-25T23:59:59.999Z').error.code,
    'REVIEW_NOT_DUE',
  );
  h.send('start-review', {}, '2026-09-26T00:00:00.000Z');
  h.send(
    'answer',
    { questionId: 'review-mu-sound', choiceId: 'mu' },
    '2026-09-26T00:00:00.000Z',
  );
  h.send('continue', {}, '2026-09-26T00:00:00.000Z');
  h.send(
    'answer',
    { questionId: 'review-lin-sound', choiceId: 'lin' },
    '2026-09-26T00:00:00.000Z',
  );
  h.send('continue', {}, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(deriveRecap(h.events).final, initial);
  assert.equal(deriveRecap(h.events).delayed.independentCorrect, 2);
  assert.equal(h.try('start-review', {}, '2026-09-26T01:00:00.000Z').ok, false);
});
test('[R2-E-001] unchanged question oracle and V1 content; safe V3 metadata has no answer keys', () => {
  assert.ok(content.FOREST_STORY_LESSON);
  assert.equal(content.FOREST_STORY_LESSON.title, 'A shady place to read');
  assert.equal(content.FOREST_LESSON.title, 'Build a Little Forest');
  assert.deepEqual(
    content.FOREST_STORY_LESSON.questions,
    content.FOREST_LESSON.questions,
  );
  assert.equal(
    JSON.stringify(content.PUBLIC_FOREST_STORY_LESSON).includes(
      'correctChoiceId',
    ),
    false,
  );
  assert.equal(
    content.lessonForVersion('forest-01-v3').lessonVersion,
    'forest-01-v3',
  );
  assert.throws(() => content.lessonForVersion('forest-01-v2'));
});

async function databaseTest(callback) {
  const { createClient } = await import('@libsql/client');
  const { createLibsqlD1Database } =
    await import('../lib/platform/libsql-d1.ts');
  const { D1PreviewStore } = await import('../lib/preview/store.ts');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'r2-backend-unit-'));
  const client = createClient({ url: `file:${path.join(dir, 'fresh.db')}` });
  const db = createLibsqlD1Database(client);
  const make = (namespace = { synthetic: true, testRunId: 'r2-store-tests' }) =>
    new D1PreviewStore(db, { namespace, now: () => now });
  try {
    await callback({ client, make, dir });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test('[R2-E-001/002] V3 fixtures traverse both saved intro panels while omitted version remains V1', () =>
  databaseTest(async ({ make }) => {
    const store = make();
    const v3 = await createFixture(store, 'new-reader', 17, 'forest-01-v3');
    const view = await store.getView(v3.runIds[0]);
    assert.equal(view.lessonVersion, 'forest-01-v3');
    assert.equal(view.state.stepId, 'recap');
    assert.equal(view.state.learnPanel, null);
    assert.equal(view.events.filter((e) => e.stepId === 'learn').length, 2);
    assert.equal(view.recap.final.independentCorrect, 4);
    const original = await createFixture(store, 'new-reader', 17);
    const old = await store.getView(original.runIds[0]);
    assert.equal(old.lessonVersion, 'forest-01-v1');
    assert.equal(Object.hasOwn(old.state, 'learnPanel'), false);
    assert.equal(old.events.filter((e) => e.stepId === 'learn').length, 1);
    await assert.rejects(
      createFixture(store, 'new-reader', 17, 'forest-01-v99'),
    );
  }));
test('[R2-E-009/010/016] real fresh embedded libSQL store retains V3 version, replay and namespace/fault boundaries', () =>
  databaseTest(async ({ make }) => {
    const store = make();
    const run = await store.createRun({
      runId: 'stored-story',
      seed: 17,
      now,
      lessonVersion: 'forest-01-v3',
    });
    assert.equal(run.lessonVersion, 'forest-01-v3');
    const a = {
      eventId: 'same-action',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: {},
    };
    const ack = await store.applyAction(run.runId, a);
    assert.deepEqual(await make().applyAction(run.runId, a), ack);
    assert.equal((await make().getView(run.runId)).events.length, 1);
    assert.equal(
      await make({ synthetic: true, testRunId: 'another-test' }).getRun(
        run.runId,
      ),
      null,
    );
    await assert.rejects(
      store.applyAction(run.runId, { ...a, payload: { forged: true } }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await store.setStorageFault(true);
    await assert.rejects(
      store.applyAction(run.runId, {
        eventId: 'faulted',
        expectedRevision: 1,
        stepId: 'familiarity',
        type: 'audio-unavailable',
        payload: { questionId: 'fam-mu' },
      }),
      (e) => e.code === 'STORAGE_UNAVAILABLE',
    );
    await store.setStorageFault(false);
    assert.equal((await store.getView(run.runId)).events.length, 1);
    const ordinary = make({ synthetic: false, testRunId: null });
    await assert.rejects(
      ordinary.createRun({
        runId: 'forged-synthetic',
        seed: 17,
        now,
        lessonVersion: 'forest-01-v3',
        synthetic: true,
        testRunId: 'r2-store-tests',
      }),
      (e) => e.code === 'INVALID_REQUEST',
    );
  }));

test('[R2-E-001] additive V3 content passes the version-aware lesson validator', () => {
  assert.equal(
    content.validateForestLesson(content.FOREST_STORY_LESSON).ok,
    true,
  );
});
