import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOREST_LESSON,
  validateForestLesson,
  rotatedChoices,
} from '../lib/preview/content.ts';
import {
  createInitialRun,
  applyAction,
  deriveRecap,
  dueAt,
} from '../lib/preview/domain.ts';
import {
  canSubmitSoundAnswer,
  classifyPlayback,
  selectMandarinVoice,
} from '../lib/preview/audio.ts';

test('[S1-AC-001][U-01] forest manifest validates reviewed targets and rejects missing assets', () => {
  assert.equal(validateForestLesson(FOREST_LESSON).ok, true);
  const incomplete = structuredClone(FOREST_LESSON);
  incomplete.assets = [];
  assert.equal(validateForestLesson(incomplete).ok, false);
});

test('[S1-AC-001][U-01] deterministic choice rotation follows the run seed', () => {
  assert.deepEqual(rotatedChoices('fam-mu', 17), ['ren', 'mu', 'lin']);
  assert.deepEqual(rotatedChoices('review-lin-sound', 17), ['da', 'lin', 'mu']);
});

test('[S1-AC-002][U-02] first responses produce full, short, and mixed introduction plans', () => {
  const run = createInitialRun({
    runId: 'r',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  let current = run;
  const events = [];
  const step = (action) => {
    const result = applyAction(
      current,
      events,
      action,
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true);
    current = result.run;
    events.push(result.event);
  };
  step({
    eventId: 'e1',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
  });
  step({
    eventId: 'e2',
    expectedRevision: 1,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-mu', choiceId: 'mu' },
  });
  step({
    eventId: 'e3',
    expectedRevision: 2,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  step({
    eventId: 'e4',
    expectedRevision: 3,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'lin' },
  });
  step({
    eventId: 'e5',
    expectedRevision: 4,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  assert.equal(current.state.stepId, 'learn');
  assert.deepEqual(current.state.introPlan, {
    mode: 'reminder',
    full: [],
    reminder: ['mu', 'lin'],
  });

  const mixed = createInitialRun({
    runId: 'm',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const mixedEvents = [];
  let mixedRun = mixed;
  const mixedStep = (action) => {
    const result = applyAction(
      mixedRun,
      mixedEvents,
      action,
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true);
    mixedRun = result.run;
    mixedEvents.push(result.event);
  };
  mixedStep({
    eventId: 'm1',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
  });
  mixedStep({
    eventId: 'm2',
    expectedRevision: 1,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-mu', choiceId: 'mu' },
  });
  mixedStep({
    eventId: 'm3',
    expectedRevision: 2,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  mixedStep({
    eventId: 'm4',
    expectedRevision: 3,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'mu' },
  });
  mixedStep({
    eventId: 'm5',
    expectedRevision: 4,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'lin' },
  });
  mixedStep({
    eventId: 'm6',
    expectedRevision: 5,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  assert.deepEqual(mixedRun.state.introPlan, {
    mode: 'mixed',
    full: ['lin'],
    reminder: ['mu'],
  });

  const full = createInitialRun({
    runId: 'f',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const fullEvents = [];
  let fullRun = full;
  const fullStep = (action) => {
    const result = applyAction(
      fullRun,
      fullEvents,
      action,
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true);
    fullRun = result.run;
    fullEvents.push(result.event);
  };
  fullStep({
    eventId: 'f1',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
  });
  fullStep({
    eventId: 'f2',
    expectedRevision: 1,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-mu', choiceId: 'ren' },
  });
  fullStep({
    eventId: 'f3',
    expectedRevision: 2,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-mu', choiceId: 'lin' },
  });
  fullStep({
    eventId: 'f4',
    expectedRevision: 3,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  fullStep({
    eventId: 'f5',
    expectedRevision: 4,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'mu' },
  });
  fullStep({
    eventId: 'f6',
    expectedRevision: 5,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'da' },
  });
  fullStep({
    eventId: 'f7',
    expectedRevision: 6,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  assert.deepEqual(fullRun.state.introPlan, {
    mode: 'full',
    full: ['mu', 'lin'],
    reminder: [],
  });

  const unavailable = createInitialRun({
    runId: 'u',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const unavailableEvents = [];
  let unavailableRun = unavailable;
  const unavailableStep = (action) => {
    const result = applyAction(
      unavailableRun,
      unavailableEvents,
      action,
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true);
    unavailableRun = result.run;
    unavailableEvents.push(result.event);
  };
  unavailableStep({
    eventId: 'u1',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
  });
  unavailableStep({
    eventId: 'u2',
    expectedRevision: 1,
    stepId: 'familiarity',
    type: 'audio-unavailable',
    payload: { questionId: 'fam-mu' },
  });
  unavailableStep({
    eventId: 'u3',
    expectedRevision: 2,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  unavailableStep({
    eventId: 'u4',
    expectedRevision: 3,
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'lin' },
  });
  unavailableStep({
    eventId: 'u5',
    expectedRevision: 4,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  assert.deepEqual(unavailableRun.state.introPlan, {
    mode: 'mixed',
    full: ['mu'],
    reminder: ['lin'],
  });

  const allUnavailable = createInitialRun({
    runId: 'ua',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const allUnavailableEvents = [];
  let allUnavailableRun = allUnavailable;
  const allUnavailableStep = (action) => {
    const result = applyAction(
      allUnavailableRun,
      allUnavailableEvents,
      action,
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true);
    allUnavailableRun = result.run;
    allUnavailableEvents.push(result.event);
  };
  allUnavailableStep({
    eventId: 'ua1',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
  });
  allUnavailableStep({
    eventId: 'ua2',
    expectedRevision: 1,
    stepId: 'familiarity',
    type: 'audio-unavailable',
    payload: { questionId: 'fam-mu' },
  });
  allUnavailableStep({
    eventId: 'ua3',
    expectedRevision: 2,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  allUnavailableStep({
    eventId: 'ua4',
    expectedRevision: 3,
    stepId: 'familiarity',
    type: 'audio-unavailable',
    payload: { questionId: 'fam-lin' },
  });
  allUnavailableStep({
    eventId: 'ua5',
    expectedRevision: 4,
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  assert.deepEqual(allUnavailableRun.state.introPlan, {
    mode: 'full',
    full: ['mu', 'lin'],
    reminder: [],
  });
});

test('[S1-AC-003][S1-AC-004][U-02] an assisted first familiarity answer selects the full introduction', () => {
  let run = createInitialRun({
    runId: 'assisted-intro',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const events = [];
  const step = (action) => {
    const result = applyAction(
      run,
      events,
      { ...action, expectedRevision: run.revision },
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true, result.error?.message);
    run = result.run;
    events.push(result.event);
    return result;
  };

  step({ eventId: 'ai-1', stepId: 'welcome', type: 'continue', payload: {} });
  step({
    eventId: 'ai-2',
    stepId: 'familiarity',
    type: 'hint',
    payload: { questionId: 'fam-mu' },
  });
  const assistedAnswer = step({
    eventId: 'ai-3',
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-mu', choiceId: 'mu' },
  });
  assert.deepEqual(assistedAnswer.result, {
    outcome: 'correct',
    firstResponse: true,
    assisted: true,
  });
  step({
    eventId: 'ai-4',
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });
  step({
    eventId: 'ai-5',
    stepId: 'familiarity',
    type: 'answer',
    payload: { questionId: 'fam-lin', choiceId: 'lin' },
  });
  step({
    eventId: 'ai-6',
    stepId: 'familiarity',
    type: 'continue',
    payload: {},
  });

  assert.deepEqual(run.state.introPlan, {
    mode: 'mixed',
    full: ['mu'],
    reminder: ['lin'],
  });
});

test('[S1-AC-004][U-03] first wrong answer stays visible and retry is supported', () => {
  let run = createInitialRun({
    runId: 'r',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const events = [];
  const go = (action, expectedRevision) => {
    const result = applyAction(
      run,
      events,
      { ...action, expectedRevision },
      '2026-09-25T00:00:01.000Z',
    );
    assert.equal(result.ok, true);
    run = result.run;
    events.push(result.event);
    return result;
  };
  go({ eventId: 'a', stepId: 'welcome', type: 'continue', payload: {} }, 0);
  const wrong = go(
    {
      eventId: 'b',
      stepId: 'familiarity',
      type: 'answer',
      payload: { questionId: 'fam-mu', choiceId: 'lin' },
    },
    1,
  );
  assert.deepEqual(wrong.result, {
    outcome: 'incorrect',
    firstResponse: true,
    assisted: false,
  });
  const right = go(
    {
      eventId: 'c',
      stepId: 'familiarity',
      type: 'answer',
      payload: { questionId: 'fam-mu', choiceId: 'mu' },
    },
    2,
  );
  assert.deepEqual(right.result, {
    outcome: 'correct',
    firstResponse: false,
    assisted: true,
  });
  assert.equal(run.state.questionStatus, 'answered');
  const recap = deriveRecap(events);
  assert.deepEqual(recap.familiarity, {
    total: 2,
    independentCorrect: 0,
    supported: 1,
    unavailable: 0,
    pending: 1,
  });
});

test('[S1-AC-007][U-03] game events do not count as reading evidence and forged score fields are rejected', () => {
  const run = createInitialRun({
    runId: 'r',
    seed: 17,
    now: '2026-09-25T00:00:00.000Z',
  });
  const result = applyAction(
    run,
    [],
    {
      eventId: 'e',
      expectedRevision: 0,
      stepId: 'welcome',
      type: 'continue',
      payload: { correct: true },
    },
    '2026-09-25T00:00:01.000Z',
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REQUEST');

  const gameEvents = [
    {
      eventId: 'p1',
      runId: 'r',
      sequence: 1,
      phase: 'initial',
      stepId: 'build',
      questionId: null,
      type: 'place-component',
      payload: { componentId: 'mu-a', slot: 'left' },
      serverTime: '2026-09-25T00:00:00.000Z',
      firstResponse: false,
      assisted: false,
      outcome: 'recorded',
      result: { outcome: 'recorded', firstResponse: false, assisted: false },
    },
    {
      eventId: 'p2',
      runId: 'r',
      sequence: 2,
      phase: 'initial',
      stepId: 'build',
      questionId: null,
      type: 'place-component',
      payload: { componentId: 'mu-b', slot: 'right' },
      serverTime: '2026-09-25T00:00:01.000Z',
      firstResponse: false,
      assisted: false,
      outcome: 'recorded',
      result: { outcome: 'recorded', firstResponse: false, assisted: false },
    },
    {
      eventId: 'p3',
      runId: 'r',
      sequence: 3,
      phase: 'initial',
      stepId: 'find',
      questionId: 'find-mu',
      type: 'answer',
      payload: { questionId: 'find-mu', choiceId: 'mu' },
      serverTime: '2026-09-25T00:00:02.000Z',
      firstResponse: true,
      assisted: false,
      outcome: 'correct',
      result: { outcome: 'correct', firstResponse: true, assisted: false },
    },
    {
      eventId: 'p4',
      runId: 'r',
      sequence: 4,
      phase: 'initial',
      stepId: 'find',
      questionId: 'find-lin',
      type: 'answer',
      payload: { questionId: 'find-lin', choiceId: 'lin' },
      serverTime: '2026-09-25T00:00:03.000Z',
      firstResponse: true,
      assisted: false,
      outcome: 'correct',
      result: { outcome: 'correct', firstResponse: true, assisted: false },
    },
  ];
  const gameRecap = deriveRecap(gameEvents);
  assert.equal(gameRecap.buildCompleted, true);
  assert.equal(gameRecap.sceneCompleted, true);
  assert.deepEqual(gameRecap.familiarity, {
    total: 2,
    independentCorrect: 0,
    supported: 0,
    unavailable: 0,
    pending: 2,
  });
  assert.deepEqual(gameRecap.final, {
    total: 4,
    independentCorrect: 0,
    supported: 0,
    unavailable: 0,
    pending: 4,
  });
});

test('[S1-AC-018][U-05] due time is exactly 24 hours and delayed evidence is separate', () => {
  const completed = '2026-09-25T00:00:00.000Z';
  assert.equal(dueAt(completed), '2026-09-26T00:00:00.000Z');
  const run = createInitialRun({ runId: 'r', seed: 17, now: completed });
  run.state.completedAt = completed;
  assert.equal(run.state.reviewCompletedAt, null);
  assert.equal(
    new Date(dueAt(run.state.completedAt)).getTime() -
      new Date(completed).getTime(),
    24 * 60 * 60 * 1000,
  );

  const events = [];
  let current = createInitialRun({ runId: 'due', seed: 17, now: completed });
  let sequence = 0;
  const step = (type, stepId, payload, now = completed) => {
    sequence += 1;
    const result = applyAction(
      current,
      events,
      {
        eventId: `d${sequence}`,
        expectedRevision: current.revision,
        stepId,
        type,
        payload,
      },
      now,
    );
    assert.equal(result.ok, true, result.error?.message);
    current = result.run;
    events.push(result.event);
  };
  const answer = (
    questionId,
    choiceId,
    stepId = current.state.stepId,
    now = completed,
  ) => step('answer', stepId, { questionId, choiceId }, now);
  const next = (now = completed) =>
    step('continue', current.state.stepId, {}, now);
  next();
  answer('fam-mu', 'mu');
  next();
  answer('fam-lin', 'lin');
  next();
  next();
  step('place-component', 'build', { componentId: 'mu-a', slot: 'left' });
  step('place-component', 'build', { componentId: 'mu-b', slot: 'right' });
  next();
  answer('find-mu', 'mu');
  next();
  answer('find-lin', 'lin');
  next();
  next();
  next();
  answer('check-mu-sound', 'mu');
  next();
  answer('check-lin-sound', 'lin');
  next();
  answer('check-mu-reading', 'audio-mu');
  next();
  answer('check-lin-reading', 'audio-lin');
  next();
  assert.equal(current.state.stepId, 'recap');
  const before = applyAction(
    current,
    events,
    {
      eventId: 'before',
      expectedRevision: current.revision,
      stepId: 'recap',
      type: 'start-review',
      payload: {},
    },
    '2026-09-25T23:59:59.999Z',
  );
  assert.equal(before.ok, false);
  assert.equal(before.error.code, 'REVIEW_NOT_DUE');
  step('start-review', 'recap', {}, '2026-09-26T00:00:00.000Z');
  answer('review-mu-sound', 'mu', 'delayed-review', '2026-09-26T00:00:00.000Z');
  next('2026-09-26T00:00:00.000Z');
  answer(
    'review-lin-sound',
    'lin',
    'delayed-review',
    '2026-09-26T00:00:00.000Z',
  );
  next('2026-09-26T00:00:00.000Z');
  assert.equal(current.state.reviewCompletedAt, '2026-09-26T00:00:00.000Z');
  const after = deriveRecap(events);
  assert.deepEqual(after.final, {
    total: 4,
    independentCorrect: 4,
    supported: 0,
    unavailable: 0,
    pending: 0,
  });
  assert.deepEqual(after.delayed, {
    total: 2,
    independentCorrect: 2,
    supported: 0,
    unavailable: 0,
    pending: 0,
  });
  const repeat = applyAction(
    current,
    events,
    {
      eventId: 'repeat',
      expectedRevision: current.revision,
      stepId: 'recap',
      type: 'start-review',
      payload: {},
    },
    '2026-09-26T00:00:01.000Z',
  );
  assert.equal(repeat.ok, true);
  assert.deepEqual(
    deriveRecap([...events, repeat.event]).delayed,
    after.delayed,
  );
});

test('[S1-AC-008][U-04] speech policy gates answers and reports unavailable without claiming quality', () => {
  const voice = selectMandarinVoice([
    { lang: 'en-US', name: 'English' },
    { lang: 'zh-TW', name: 'Mandarin fallback' },
    { lang: 'zh-CN', name: 'Mandarin local', localService: true },
  ]);
  assert.equal(voice?.lang, 'zh-CN');
  assert.equal(
    classifyPlayback({ started: false, voiceAvailable: false }),
    'unavailable',
  );
  assert.equal(
    classifyPlayback({ started: false, voiceAvailable: true, error: true }),
    'failed',
  );
  assert.equal(canSubmitSoundAnswer({ playback: 'started' }), true);
  assert.equal(canSubmitSoundAnswer({ playback: 'unavailable' }), false);
});

test('[S1-AC-008][U-04] speech selection rejects Cantonese and unknown language tags', () => {
  assert.equal(
    selectMandarinVoice([
      { lang: 'zh-HK', name: 'Cantonese' },
      { lang: 'yue-HK', name: 'Yue' },
    ]),
    null,
  );
  assert.equal(
    selectMandarinVoice([
      { lang: 'zh-XX', name: 'Unknown Chinese' },
      { lang: 'en-US', name: 'English' },
    ]),
    null,
  );
  assert.equal(
    selectMandarinVoice([{ lang: 'cmn-SG', name: 'Mandarin' }])?.lang,
    'cmn-SG',
  );
});
