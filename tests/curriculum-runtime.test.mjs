import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  resolveServerRendererAdapter,
  compileCurriculumRuntime,
  createCurriculumRun,
  applyCurriculumAction,
  projectCurriculumRun,
  projectCurriculumProgress,
} from '../lib/curriculum/runtime.ts';

const BASE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);
const NOW = 1_000_000;
const DAY = 86_400_000;
const ADAPTER = {
  adapterId: 'forest-scripted',
  adapterVersion: 'forest-scripted-v1',
  capabilities: [
    'selection-v1',
    'recognition-v1',
    'delayed-review-v1',
    'progress-export-v1',
  ],
};

function clone(value) {
  return structuredClone(value);
}

function runtimePackage() {
  const value = clone(BASE);
  const [welcome, familiarity, teach, practice, final, recap] = value.steps;
  value.steps = [
    { ...welcome, kind: 'familiarity', recognitionCheckIds: [] },
    {
      ...familiarity,
      kind: 'familiarity',
      recognitionCheckIds: ['check-mu-word', 'check-lin-word'],
    },
    {
      ...teach,
      kind: 'teach',
      recognitionCheckIds: ['check-mu-print', 'check-lin-print'],
    },
    {
      ...practice,
      kind: 'practice',
      recognitionCheckIds: ['check-mu-word', 'check-lin-word'],
    },
    {
      ...final,
      kind: 'plain-print-check',
      recognitionCheckIds: ['check-mu-print', 'check-lin-print'],
    },
    { ...recap, kind: 'recap', recognitionCheckIds: [] },
  ];
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonical(value), 'utf8')
    .digest('hex')}`;
}

function variantPackage() {
  let serialized = JSON.stringify(runtimePackage());
  for (const [from, to] of [
    ['forest-01-v2', 'orchard-09-v1'],
    ['forest-01', 'orchard-09'],
    ['char-mu', 'char-ben'],
    ['char-lin', 'char-sen'],
    ['reading-mu', 'reading-ben'],
    ['reading-lin', 'reading-sen'],
    ['word-mu', 'word-ben'],
    ['word-lin', 'word-sen'],
    ['check-mu', 'check-ben'],
    ['check-lin', 'check-sen'],
    ['choice-mu', 'choice-ben'],
    ['choice-lin', 'choice-sen'],
    ['prompt-mu', 'prompt-ben'],
    ['prompt-lin', 'prompt-sen'],
    ['asset-glyph-mu', 'asset-glyph-ben'],
    ['asset-glyph-lin', 'asset-glyph-sen'],
    ['forest', 'orchard'],
    ['木', '本'],
    ['林', '森'],
  ])
    serialized = serialized.replaceAll(from, to);
  const value = JSON.parse(serialized);
  value.renderer = clone(BASE.renderer);
  for (const step of value.steps) {
    if (step.recognitionCheckIds.length > 1) step.recognitionCheckIds.reverse();
  }
  return value;
}

function checkFor(packageValue, checkId) {
  const check = packageValue.recognitionChecks.find(
    (candidate) => candidate.checkId === checkId,
  );
  assert.ok(check, `missing check ${checkId}`);
  return check;
}

function correctChoice(packageValue, checkId) {
  return checkFor(packageValue, checkId).correctChoiceId;
}

function wrongChoice(packageValue, checkId) {
  const check = checkFor(packageValue, checkId);
  return check.choices.find(
    (choice) => choice.choiceId !== check.correctChoiceId,
  ).choiceId;
}

function assertCode(error, expected, forbidden = []) {
  assert.equal(error?.code, expected, error?.message);
  assert.equal(typeof error?.message, 'string');
  for (const value of forbidden)
    assert.doesNotMatch(error.message, new RegExp(value, 'u'));
  return true;
}

function throwsCode(action, expected, forbidden = []) {
  assert.throws(action, (error) => assertCode(error, expected, forbidden));
}

async function rejectsCode(action, expected, forbidden = []) {
  await assert.rejects(action, (error) =>
    assertCode(error, expected, forbidden),
  );
}

function freshRun(lesson, runId = 'runtime-run-a', seed = 17, now = NOW) {
  return createCurriculumRun(lesson, { runId, seed, now });
}

function actionInput(eventId, run, view, type, payload = {}) {
  return {
    eventId,
    expectedRevision: run.revision,
    occurrenceId: view.question?.occurrenceId ?? null,
    type,
    payload,
  };
}

function assertProjectionShape(view) {
  assert.deepEqual(Object.keys(view).sort(), [
    'canContinue',
    'canStartReview',
    'completion',
    'identity',
    'phase',
    'question',
    'revision',
    'runId',
    'schemaVersion',
    'step',
    'teaching',
  ]);
  assert.equal(view.schemaVersion, 's3-runtime-1');
  assert.equal(typeof view.runId, 'string');
  assert.equal(typeof view.revision, 'number');
  assert.ok(view.identity?.contentDigest.startsWith('sha256:'));
  assert.equal(typeof view.step.stepId, 'string');
  assert.equal(typeof view.step.kind, 'string');
  assert.equal(typeof view.step.instructionEnglish, 'string');
  assert.deepEqual(Object.keys(view.completion).sort(), [
    'initialCompletedAt',
    'reviewAvailableAt',
    'reviewCompletedAt',
    'reviewPolicyVersion',
  ]);
}

function assertSafeProjection(value) {
  const forbidden = new Set([
    'answerKey',
    'correctAnswer',
    'correctChoiceId',
    'evidenceRef',
    'license',
    'manifest',
    'provenance',
    'reviewerRef',
    'source',
    'targetCharacter',
  ]);
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbidden.has(key), false, `projection leaked ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function assertQuestion(question, packageValue) {
  assert.ok(question);
  assert.deepEqual(Object.keys(question).sort(), [
    'attempts',
    'audioText',
    'checkId',
    'choices',
    'demonstrationEnglish',
    'hintEnglish',
    'instructionEnglish',
    'kind',
    'occurrenceId',
    'promptEnglish',
    'questionStatus',
    'requiresAudio',
  ]);
  assert.equal(question.requiresAudio, true);
  assert.equal(typeof question.audioText, 'string');
  assert.equal(typeof question.promptEnglish, 'string');
  assert.equal(typeof question.instructionEnglish, 'string');
  assert.equal(
    question.audioText,
    checkFor(packageValue, question.checkId).prompt.hanzi,
  );
  assert.deepEqual(
    new Set(question.choices.map((choice) => choice.choiceId)),
    new Set(
      checkFor(packageValue, question.checkId).choices.map(
        (choice) => choice.choiceId,
      ),
    ),
  );
  for (const choice of question.choices)
    assert.deepEqual(Object.keys(choice).sort(), ['choiceId', 'hanzi']);
}

function accept(lesson, run, events, input, now) {
  const originalRun = clone(run);
  const originalEvents = clone(events);
  const originalInput = clone(input);
  const sourceView = projectCurriculumRun(lesson, run, events, run.updatedAt);
  const result = applyCurriculumAction(lesson, run, events, input, now);
  assert.deepEqual(run, originalRun);
  assert.deepEqual(events, originalEvents);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(Object.keys(result).sort(), [
    'ack',
    'event',
    'replayed',
    'run',
  ]);
  assert.equal(result.replayed, false);
  assert.equal(result.run.revision, run.revision + 1);
  assert.equal(result.event.sequence, result.run.revision);
  assert.equal(result.event.eventId, input.eventId);
  assert.equal(result.event.phase, sourceView.phase);
  assert.equal(result.event.stepId, sourceView.step.stepId);
  assert.equal(
    result.event.occurrenceId,
    sourceView.question?.occurrenceId ?? null,
  );
  assert.equal(result.event.checkId, sourceView.question?.checkId ?? null);
  assert.deepEqual(result.event.action, input);
  assert.deepEqual(result.event.ack, result.ack);
  assert.deepEqual(result.ack, {
    eventId: input.eventId,
    revision: result.run.revision,
    result: result.event.result,
  });
  assert.deepEqual(Object.keys(result.event.result).sort(), [
    'assisted',
    'firstResponse',
    'outcome',
  ]);
  if (input.type === 'continue' || input.type === 'start-review') {
    assert.deepEqual(result.event.result, {
      outcome: 'recorded',
      firstResponse: false,
      assisted: false,
    });
  }
  events.push(result.event);
  return result;
}

function continueAction(lesson, run, events, eventId, now) {
  const view = projectCurriculumRun(lesson, run, events, run.updatedAt);
  return accept(
    lesson,
    run,
    events,
    actionInput(eventId, run, view, 'continue'),
    now,
  ).run;
}

function answerAction(lesson, run, events, eventId, choiceId, now) {
  const view = projectCurriculumRun(lesson, run, events, run.updatedAt);
  return accept(
    lesson,
    run,
    events,
    actionInput(eventId, run, view, 'answer', { choiceId }),
    now,
  );
}

function answerCorrect(lesson, run, events, packageValue, eventId, now) {
  return answerAction(
    lesson,
    run,
    events,
    eventId,
    correctChoice(
      packageValue,
      projectCurriculumRun(lesson, run, events, run.updatedAt).question.checkId,
    ),
    now,
  );
}

function answerWrong(lesson, run, events, packageValue, eventId, now) {
  return answerAction(
    lesson,
    run,
    events,
    eventId,
    wrongChoice(
      packageValue,
      projectCurriculumRun(lesson, run, events, run.updatedAt).question.checkId,
    ),
    now,
  );
}

function audioUnavailable(lesson, run, events, eventId, now) {
  const view = projectCurriculumRun(lesson, run, events, run.updatedAt);
  return accept(
    lesson,
    run,
    events,
    actionInput(eventId, run, view, 'audio-unavailable'),
    now,
  );
}

function continueToPractice(lesson, packageValue, run, events, clock) {
  run = continueAction(lesson, run, events, 'to-familiarity', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'familiarity-mu',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'familiarity-next', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'familiarity-lin',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'to-teach', ++clock.value);
  run = continueAction(lesson, run, events, 'to-practice', ++clock.value);
  return run;
}

test('[S3-AC-002][C-RUNTIME-01] catalog, package binding, canonical identity and immutable compilation', async () => {
  const packageValue = runtimePackage();
  const adapter = resolveServerRendererAdapter(
    ADAPTER.adapterId,
    ADAPTER.adapterVersion,
  );
  assert.ok(adapter);
  assert.equal(adapter.adapterId, ADAPTER.adapterId);
  assert.equal(adapter.adapterVersion, ADAPTER.adapterVersion);
  assert.deepEqual(adapter.capabilities, ADAPTER.capabilities);
  assert.equal(
    resolveServerRendererAdapter('unknown-adapter', ADAPTER.adapterVersion),
    null,
  );
  assert.equal(
    resolveServerRendererAdapter(ADAPTER.adapterId, 'unknown-version'),
    null,
  );

  const lesson = await compileCurriculumRuntime(clone(packageValue));
  assert.deepEqual(lesson.identity, {
    lessonId: packageValue.lessonId,
    lessonVersion: packageValue.lessonVersion,
    contentDigest: digest(packageValue),
    adapterId: ADAPTER.adapterId,
    adapterVersion: ADAPTER.adapterVersion,
  });
  assert.equal(Object.isFrozen(lesson.identity), true);
  assert.equal(Object.isFrozen(lesson), true);

  const variant = variantPackage();
  const otherLesson = await compileCurriculumRuntime(clone(variant));
  assert.equal(otherLesson.identity.lessonId, 'orchard-09');
  assert.equal(otherLesson.identity.lessonVersion, 'orchard-09-v1');
  assert.notEqual(
    otherLesson.identity.contentDigest,
    lesson.identity.contentDigest,
  );
  assert.notEqual(otherLesson.identity.adapterId, undefined);

  const unknownAdapter = clone(packageValue);
  unknownAdapter.renderer.adapterId = 'uninstalled-scripted';
  await rejectsCode(
    () => compileCurriculumRuntime(unknownAdapter),
    'RUNTIME_ADAPTER_UNAVAILABLE',
  );
  const unknownVersion = clone(packageValue);
  unknownVersion.renderer.adapterVersion = 'forest-scripted-v99';
  await rejectsCode(
    () => compileCurriculumRuntime(unknownVersion),
    'RUNTIME_ADAPTER_UNAVAILABLE',
  );
  const reserved = clone(packageValue);
  reserved.lessonVersion = 'forest-01-v1';
  await rejectsCode(
    () => compileCurriculumRuntime(reserved),
    'RUNTIME_PACKAGE_UNSUPPORTED',
  );
  const unsupportedProfile = clone(packageValue);
  unsupportedProfile.steps.reverse();
  await rejectsCode(
    () => compileCurriculumRuntime(unsupportedProfile),
    'RUNTIME_PACKAGE_UNSUPPORTED',
  );

  const changing = clone(packageValue);
  const compiling = compileCurriculumRuntime(changing);
  changing.title = 'mutated after compile call';
  changing.characters[0].hanzi = '本';
  const captured = await compiling;
  assert.equal(captured.identity.contentDigest, digest(packageValue));
  const accessor = clone(packageValue);
  Object.defineProperty(accessor, 'title', {
    enumerable: true,
    get() {
      throw new Error('runtime must inspect descriptors');
    },
  });
  await rejectsCode(
    () => compileCurriculumRuntime(accessor),
    'INVALID_PACKAGE',
  );
});

test('[S3-AC-002][C-RUNTIME-02] fresh run and safe deterministic projections retain authored order', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  const run = freshRun(lesson, 'projection-run', 17);
  const events = [];
  const before = clone(packageValue);
  let view = projectCurriculumRun(lesson, run, events, NOW);
  assertProjectionShape(view);
  assert.equal(view.step.stepId, 'step-welcome');
  assert.equal(view.step.kind, 'familiarity');
  assert.equal(view.question, null);
  assert.equal(run.state.questionIndex, 0);
  assert.equal(run.state.questionStatus, null);
  assert.equal(view.canContinue, true);
  assert.equal(view.canStartReview, false);
  assert.deepEqual(view.teaching, []);
  assertSafeProjection(view);

  const advanced = continueAction(
    lesson,
    run,
    events,
    'welcome-continue',
    NOW + 1,
  );
  view = projectCurriculumRun(lesson, advanced, events, NOW + 1);
  assertProjectionShape(view);
  assert.equal(view.step.stepId, 'step-familiarity');
  assert.equal(view.question.occurrenceId, 'initial:1:0');
  assert.equal(view.question.checkId, 'check-mu-word');
  assertQuestion(view.question, packageValue);
  assertSafeProjection(view);
  const sameSeedRun = freshRun(lesson, 'projection-run-2', 17);
  const sameSeedEvents = [];
  const sameSeed = continueAction(
    lesson,
    sameSeedRun,
    sameSeedEvents,
    'welcome-continue',
    NOW + 1,
  );
  const sameView = projectCurriculumRun(
    lesson,
    sameSeed,
    sameSeedEvents,
    NOW + 1,
  );
  assert.deepEqual(view.question.choices, sameView.question.choices);
  const choiceOrders = new Set();
  for (const [index, seed] of [1, 2, 3, 987654321].entries()) {
    const otherSeedRun = freshRun(lesson, `projection-run-${index + 3}`, seed);
    const otherSeedEvents = [];
    const otherSeed = continueAction(
      lesson,
      otherSeedRun,
      otherSeedEvents,
      'welcome-continue',
      NOW + 1,
    );
    const otherView = projectCurriculumRun(
      lesson,
      otherSeed,
      otherSeedEvents,
      NOW + 1,
    );
    choiceOrders.add(JSON.stringify(otherView.question.choices));
  }
  assert.ok(choiceOrders.size > 1);
  assert.deepEqual(packageValue, before);
});

test('[S3-AC-009][C-RUNTIME-03] reducer records first response, assistance, demonstration and unavailable audio', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  const run = freshRun(lesson, 'reducer-run');
  const events = [];
  const clock = { value: NOW };
  let current = continueToPractice(lesson, packageValue, run, events, clock);

  let result = accept(
    lesson,
    current,
    events,
    actionInput(
      'practice-hint',
      current,
      projectCurriculumRun(lesson, current, events, current.updatedAt),
      'hint',
    ),
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'recorded',
    firstResponse: false,
    assisted: true,
  });
  current = result.run;
  result = answerWrong(
    lesson,
    current,
    events,
    packageValue,
    'practice-mu-wrong',
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'incorrect',
    firstResponse: true,
    assisted: true,
  });
  current = result.run;
  result = answerCorrect(
    lesson,
    current,
    events,
    packageValue,
    'practice-mu-corrected',
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'correct',
    firstResponse: false,
    assisted: true,
  });
  current = result.run;
  current = continueAction(
    lesson,
    current,
    events,
    'practice-next',
    ++clock.value,
  );
  result = answerWrong(
    lesson,
    current,
    events,
    packageValue,
    'practice-lin-wrong-1',
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'incorrect',
    firstResponse: true,
    assisted: false,
  });
  current = result.run;
  result = answerWrong(
    lesson,
    current,
    events,
    packageValue,
    'practice-lin-wrong-2',
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'demonstrated',
    firstResponse: false,
    assisted: true,
  });
  current = result.run;
  const demonstrated = projectCurriculumRun(
    lesson,
    current,
    events,
    current.updatedAt,
  );
  assert.equal(typeof demonstrated.question.demonstrationEnglish, 'string');
  current = continueAction(lesson, current, events, 'to-final', ++clock.value);
  result = audioUnavailable(
    lesson,
    current,
    events,
    'final-audio-unavailable',
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'unavailable',
    firstResponse: true,
    assisted: false,
  });
  current = result.run;
  current = continueAction(
    lesson,
    current,
    events,
    'final-next',
    ++clock.value,
  );
  result = answerCorrect(
    lesson,
    current,
    events,
    packageValue,
    'final-correct',
    ++clock.value,
  );
  assert.deepEqual(result.event.result, {
    outcome: 'correct',
    firstResponse: true,
    assisted: false,
  });
  current = result.run;
  current = continueAction(
    lesson,
    current,
    events,
    'enter-recap',
    ++clock.value,
  );
  const recap = projectCurriculumRun(
    lesson,
    current,
    events,
    current.updatedAt,
  );
  assert.equal(recap.step.kind, 'recap');
  assert.equal(recap.question, null);
});

test('[S3-AC-009][C-RUNTIME-04] strict action ledger rejects malformed, stale, wrong and conflicting actions', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  let run = freshRun(lesson, 'strict-run');
  const events = [];
  const malformed = {
    eventId: 'private-sentinel',
    expectedRevision: 0,
    occurrenceId: null,
    type: 'continue',
    payload: {},
    extra: true,
  };
  const beforeRun = clone(run);
  throwsCode(
    () => applyCurriculumAction(lesson, run, events, malformed, NOW + 1),
    'INVALID_REQUEST',
    ['private-sentinel'],
  );
  assert.deepEqual(run, beforeRun);
  assert.deepEqual(events, []);
  run = continueAction(lesson, run, events, 'strict-welcome', NOW + 1);
  const view = projectCurriculumRun(lesson, run, events, NOW + 1);
  const wrongOccurrence = actionInput('wrong-occurrence', run, view, 'answer', {
    choiceId: correctChoice(packageValue, view.question.checkId),
  });
  wrongOccurrence.occurrenceId = 'initial:99:0';
  throwsCode(
    () => applyCurriculumAction(lesson, run, events, wrongOccurrence, NOW + 2),
    'INVALID_TRANSITION',
  );
  const invalidChoice = actionInput('invalid-choice', run, view, 'answer', {
    choiceId: 'choice-does-not-exist',
  });
  throwsCode(
    () => applyCurriculumAction(lesson, run, events, invalidChoice, NOW + 2),
    'INVALID_REQUEST',
    ['choice-does-not-exist'],
  );
  const stale = actionInput('stale-revision', run, view, 'hint');
  stale.expectedRevision = 0;
  throwsCode(
    () => applyCurriculumAction(lesson, run, events, stale, NOW + 2),
    'STALE_REVISION',
  );
  const accepted = accept(
    lesson,
    run,
    events,
    actionInput('exact-replay', run, view, 'hint'),
    NOW + 2,
  );
  run = accepted.run;
  run = answerWrong(
    lesson,
    run,
    events,
    packageValue,
    'after-replay-target',
    NOW + 3,
  ).run;
  const replayBefore = clone(run);
  const replay = applyCurriculumAction(
    lesson,
    run,
    events,
    { ...accepted.event.action },
    NOW + 4,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.run, replayBefore);
  assert.deepEqual(replay.event, accepted.event);
  assert.deepEqual(replay.ack, accepted.ack);
  assert.equal(events.length, 3);
  const conflict = { ...accepted.event.action, type: 'continue' };
  throwsCode(
    () => applyCurriculumAction(lesson, run, events, conflict, NOW + 4),
    'EVENT_CONFLICT',
  );
  assert.equal(events.length, 3);
});

test('[S3-AC-009][C-RUNTIME-05] teaching evidence, group counts and non-forest identities stay scoped', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  let run = freshRun(lesson, 'progress-run');
  const events = [];
  const clock = { value: NOW };
  run = continueAction(lesson, run, events, 'to-familiarity', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'fam-mu',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'familiarity-next', ++clock.value);
  run = audioUnavailable(
    lesson,
    run,
    events,
    'fam-lin-unavailable',
    ++clock.value,
  ).run;
  const unavailable = events.at(-1);
  assert.equal(unavailable.type, 'audio-unavailable');
  assert.equal(unavailable.result.outcome, 'unavailable');
  assert.equal(unavailable.result.firstResponse, true);
  run = continueAction(lesson, run, events, 'to-teach', ++clock.value);
  const teachingView = projectCurriculumRun(lesson, run, events, clock.value);
  assert.equal(teachingView.step.kind, 'teach');
  assert.equal(teachingView.question, null);
  assert.equal(teachingView.teaching.length, 2);
  for (const teaching of teachingView.teaching) {
    assert.deepEqual(Object.keys(teaching).sort(), [
      'characterId',
      'demonstrationEnglish',
      'hanzi',
      'instructionEnglish',
      'introduction',
      'meanings',
      'readings',
      'words',
    ]);
    assert.ok(teaching.readings.length >= 1);
    assert.ok(teaching.meanings.length >= 1);
    assert.ok(teaching.words.length >= 2);
  }
  const muTeaching = teachingView.teaching.find(
    (item) => item.characterId === 'char-mu',
  );
  const linTeaching = teachingView.teaching.find(
    (item) => item.characterId === 'char-lin',
  );
  assert.equal(muTeaching.introduction, 'reminder');
  assert.equal(linTeaching.introduction, 'full');
  let progress = projectCurriculumProgress(lesson, run, events);
  assert.deepEqual(Object.keys(progress).sort(), [
    'characters',
    'completion',
    'evidenceLimits',
    'groups',
    'identity',
    'runId',
    'schemaVersion',
  ]);
  assert.deepEqual(progress.groups.familiarity, {
    total: 2,
    independentCorrect: 1,
    supported: 0,
    unavailable: 1,
    pending: 0,
  });
  assertSafeProjection(progress);
  assert.ok(
    Object.values(progress.evidenceLimits).every(
      (value) => typeof value === 'string',
    ),
  );

  run = continueAction(lesson, run, events, 'to-practice', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'practice-mu',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'practice-next', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'practice-lin',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'to-final', ++clock.value);
  run = audioUnavailable(
    lesson,
    run,
    events,
    'final-mu-unavailable',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'final-next', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'final-lin',
    ++clock.value,
  ).run;
  progress = projectCurriculumProgress(lesson, run, events);
  assert.equal(progress.groups.practice.independentCorrect, 2);
  assert.equal(progress.groups.final.unavailable, 1);
  assert.equal(progress.groups.final.independentCorrect, 1);
  assert.equal(progress.groups.familiarity.unavailable, 1);
  assert.ok(progress.characters.every((character) => character.groups));

  const otherPackage = variantPackage();
  const otherLesson = await compileCurriculumRuntime(otherPackage);
  const otherRun = freshRun(otherLesson, 'other-content-run', 17);
  const otherEvents = [];
  const otherNext = continueAction(
    otherLesson,
    otherRun,
    otherEvents,
    'other-welcome',
    NOW + 1,
  );
  const otherView = projectCurriculumRun(
    otherLesson,
    otherNext,
    otherEvents,
    NOW + 1,
  );
  assert.ok(
    otherView.question.choices.some((choice) =>
      ['本', '森'].includes(choice.hanzi),
    ),
  );
  assert.equal(
    otherView.question.choices.some((choice) =>
      ['木', '林'].includes(choice.hanzi),
    ),
    false,
  );
  assert.equal(otherView.question.occurrenceId, 'initial:1:0');
});

test('[S3-AC-009][C-RUNTIME-06] completion delay, exact due boundary and delayed recap are server-clocked', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  let run = freshRun(lesson, 'delayed-run');
  const events = [];
  const clock = { value: NOW };
  run = continueAction(lesson, run, events, 'to-familiarity', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'fam-mu',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'familiarity-next', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'fam-lin',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'to-teach', ++clock.value);
  run = continueAction(lesson, run, events, 'to-practice', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'practice-mu',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'practice-next', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'practice-lin',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'to-final', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'final-mu',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'final-next', ++clock.value);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'final-lin',
    ++clock.value,
  ).run;
  run = continueAction(lesson, run, events, 'to-recap', ++clock.value);
  const initial = projectCurriculumRun(lesson, run, events, clock.value);
  assert.equal(initial.step.kind, 'recap');
  assert.equal(run.state.questionIndex, 0);
  assert.equal(run.state.questionStatus, null);
  assert.equal(initial.completion.initialCompletedAt, clock.value);
  assert.equal(initial.completion.reviewAvailableAt, clock.value + DAY);
  assert.equal(initial.canStartReview, false);
  const early = actionInput('early-review', run, initial, 'start-review');
  throwsCode(
    () =>
      applyCurriculumAction(lesson, run, events, early, clock.value + DAY - 1),
    'REVIEW_NOT_DUE',
  );
  const due = accept(
    lesson,
    run,
    events,
    actionInput('start-review', run, initial, 'start-review'),
    clock.value + DAY,
  );
  run = due.run;
  let delayed = projectCurriculumRun(lesson, run, events, clock.value + DAY);
  assert.equal(delayed.phase, 'delayed');
  assert.equal(delayed.step.kind, 'delayed-review');
  assert.equal(
    delayed.question.kind,
    checkFor(packageValue, delayed.question.checkId).kind,
  );
  assert.equal(delayed.question.occurrenceId, 'delayed:0');
  assert.equal(
    delayed.question.promptEnglish,
    packageValue.characters[0].teaching.delayedReview.cueEnglish,
  );
  assert.equal(run.state.questionIndex, 0);
  assert.equal(run.state.questionStatus, 'open');
  assert.match(delayed.question.instructionEnglish, /later|again|review/i);
  const delayedTime = clock.value + DAY + 1;
  run = audioUnavailable(lesson, run, events, 'delayed-audio', delayedTime).run;
  assert.equal(events.at(-1).result.outcome, 'unavailable');
  run = continueAction(lesson, run, events, 'delayed-next', delayedTime + 1);
  run = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'delayed-correct',
    delayedTime + 2,
  ).run;
  run = continueAction(
    lesson,
    run,
    events,
    'delayed-complete',
    delayedTime + 3,
  );
  delayed = projectCurriculumRun(lesson, run, events, delayedTime + 3);
  assert.equal(delayed.step.stepId, '$delayed-recap');
  assert.equal(delayed.step.kind, 'recap');
  assert.equal(delayed.question, null);
  assert.equal(run.state.questionIndex, packageValue.characters.length);
  assert.equal(run.state.questionStatus, null);
  assert.equal(delayed.completion.reviewCompletedAt, delayedTime + 3);
  assert.equal(delayed.canStartReview, false);
  throwsCode(
    () =>
      applyCurriculumAction(
        lesson,
        run,
        events,
        actionInput('repeat-review', run, delayed, 'start-review'),
        delayedTime + 4,
      ),
    'INVALID_TRANSITION',
  );
  assert.deepEqual(
    projectCurriculumProgress(lesson, run, events),
    projectCurriculumProgress(lesson, run, events),
  );
});

test('[S3-AC-009][C-RUNTIME-08] automatic help after an unhinted error remains assistance on retry', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  const events = [];
  let run = continueAction(lesson, freshRun(lesson), events, 'begin', NOW + 1);
  const wrong = answerWrong(
    lesson,
    run,
    events,
    packageValue,
    'unhinted-error',
    NOW + 2,
  );
  assert.deepEqual(wrong.event.result, {
    outcome: 'incorrect',
    firstResponse: true,
    assisted: false,
  });
  run = wrong.run;
  assert.equal(run.state.assisted, true);
  assert.equal(
    projectCurriculumProgress(lesson, run, events).groups.familiarity.pending,
    2,
  );
  const retry = answerCorrect(
    lesson,
    run,
    events,
    packageValue,
    'correct-retry',
    NOW + 3,
  );
  assert.deepEqual(retry.event.result, {
    outcome: 'correct',
    firstResponse: false,
    assisted: true,
  });
  assert.equal(
    projectCurriculumProgress(lesson, retry.run, events).groups.familiarity
      .supported,
    1,
  );
});

test('[S3-AC-002][C-RUNTIME-09] teaching meanings are plain English strings from the package', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  const events = [];
  let run = continueAction(lesson, freshRun(lesson), events, 'begin', NOW + 1);
  for (let index = 0; index < 2; index += 1) {
    run = audioUnavailable(
      lesson,
      run,
      events,
      `unavailable-${index}`,
      NOW + 2 + index * 2,
    ).run;
    run = continueAction(
      lesson,
      run,
      events,
      `next-${index}`,
      NOW + 3 + index * 2,
    );
  }
  const teaching = projectCurriculumRun(
    lesson,
    run,
    events,
    run.updatedAt,
  ).teaching;
  assert.equal(teaching.length, packageValue.characters.length);
  for (const row of teaching) {
    const character = packageValue.characters.find(
      (item) => item.characterId === row.characterId,
    );
    assert.deepEqual(
      row.meanings,
      character.meanings.map((meaning) => meaning.english),
    );
  }
});

test('[S3-AC-009][C-RUNTIME-10] unsafe action descriptors are rejected without running caller code', async () => {
  const lesson = await compileCurriculumRuntime(runtimePackage());
  const run = freshRun(lesson);
  const events = [];
  const action = actionInput(
    'unsafe-action',
    run,
    projectCurriculumRun(lesson, run, events, NOW),
    'continue',
  );
  let reads = 0;
  Object.defineProperty(action, 'payload', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('private caller text');
    },
  });
  throwsCode(
    () => applyCurriculumAction(lesson, run, events, action, NOW + 1),
    'INVALID_REQUEST',
    ['private caller text'],
  );
  assert.equal(reads, 0);
  assert.equal(run.revision, 0);
  assert.deepEqual(events, []);
});

test('[S3-AC-009][C-RUNTIME-07] identity, clocks, stored ledgers and malformed positions fail closed', async () => {
  const packageValue = runtimePackage();
  const lesson = await compileCurriculumRuntime(packageValue);
  const otherLesson = await compileCurriculumRuntime(variantPackage());
  throwsCode(
    () => createCurriculumRun(lesson, { runId: 'bad-clock', seed: 1, now: -1 }),
    'INVALID_REQUEST',
  );
  throwsCode(
    () =>
      createCurriculumRun(lesson, {
        runId: 'clock-overflow',
        seed: 1,
        now: 8_640_000_000_000_001,
      }),
    'INVALID_REQUEST',
  );
  throwsCode(
    () =>
      createCurriculumRun(lesson, {
        runId: 'bad-seed',
        seed: 2 ** 32,
        now: NOW,
      }),
    'INVALID_REQUEST',
  );
  throwsCode(
    () => createCurriculumRun(lesson, { runId: 'bad-id!', seed: 1, now: NOW }),
    'INVALID_REQUEST',
  );

  const run = freshRun(lesson, 'state-run');
  const events = [];
  assertRuntimeIdentityMismatch(lesson, otherLesson, run, events);
  const malformedPosition = clone(run);
  malformedPosition.state.stepIndex = 999;
  throwsCode(
    () => projectCurriculumRun(lesson, malformedPosition, events, NOW),
    'RUNTIME_STATE_INVALID',
  );
  const countMismatch = clone(run);
  countMismatch.revision = 1;
  throwsCode(
    () => projectCurriculumRun(lesson, countMismatch, events, NOW),
    'RUNTIME_STATE_INVALID',
  );
  const advanced = continueAction(
    lesson,
    run,
    events,
    'state-continue',
    NOW + 1,
  );
  const event = events[0];
  const forged = clone(event);
  forged.result.outcome = 'correct';
  forged.ack.result.outcome = 'correct';
  throwsCode(
    () => projectCurriculumRun(lesson, advanced, [forged], NOW + 1),
    'RUNTIME_STATE_INVALID',
  );
  const completionForged = clone(advanced);
  completionForged.state.initialCompletedAt = NOW;
  throwsCode(
    () => projectCurriculumRun(lesson, completionForged, [event], NOW + 1),
    'RUNTIME_STATE_INVALID',
  );
  const gap = clone(event);
  gap.sequence = 2;
  const gapRun = clone(advanced);
  gapRun.revision = 1;
  throwsCode(
    () => projectCurriculumRun(lesson, gapRun, [gap], NOW + 1),
    'RUNTIME_STATE_INVALID',
  );
  const duplicateRun = clone(advanced);
  duplicateRun.revision = 2;
  const duplicate = clone(event);
  duplicate.sequence = 2;
  throwsCode(
    () =>
      projectCurriculumRun(lesson, duplicateRun, [event, duplicate], NOW + 1),
    'RUNTIME_STATE_INVALID',
  );
  const foreign = clone(event);
  foreign.runId = 'foreign-run';
  throwsCode(
    () => projectCurriculumRun(lesson, advanced, [foreign], NOW + 1),
    'RUNTIME_STATE_INVALID',
  );
  const badClock = clone(advanced);
  badClock.updatedAt = badClock.createdAt - 1;
  throwsCode(
    () => projectCurriculumRun(lesson, badClock, [event], NOW + 1),
    'RUNTIME_STATE_INVALID',
  );
});

function assertRuntimeIdentityMismatch(lesson, otherLesson, run, events) {
  throwsCode(
    () => projectCurriculumRun(otherLesson, run, events, NOW),
    'RUNTIME_IDENTITY_MISMATCH',
  );
  throwsCode(
    () =>
      applyCurriculumAction(
        otherLesson,
        run,
        events,
        {
          eventId: 'foreign-identity',
          expectedRevision: run.revision,
          occurrenceId: null,
          type: 'continue',
          payload: {},
        },
        NOW + 1,
      ),
    'RUNTIME_IDENTITY_MISMATCH',
  );
}
