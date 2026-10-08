import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import * as paired from '../lib/curriculum/paired-runtime.ts';
import {
  compileCorpusRuntime,
  createCorpusRun,
  applyCorpusAction,
  validateCorpusRun,
  projectCorpusRun,
} from '../lib/curriculum/corpus-runtime.ts';
const NOW = '2026-09-27T02:00:00.000Z';
export function corpusFixture() {
  const p = JSON.parse(
    fs.readFileSync(
      new URL(
        '../content/curriculum/collection/path-01-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  p.lessonId = 'synthetic-corpus-pair';
  p.lessonVersion = 'synthetic-corpus-pair-v1';
  p.renderer.adapterId = 'corpus-paired';
  p.renderer.adapterVersion = 'corpus-paired-v1';
  return p; // Original pending teaching bytes; synthetic mechanics, no human claims.
}
async function harness(phase = 'initial', seed = 7) {
  const lesson = await compileCorpusRuntime(corpusFixture());
  let run = createCorpusRun(lesson, {
      runId: 'corpus:test',
      phase,
      seed,
      now: NOW,
    }),
    counter = 0;
  const view = () =>
    projectCorpusRun(lesson, run, { soundReview: 'synthetic' });
  const act = (type, payload = {}, soundReview = 'synthetic') => {
    const result = applyCorpusAction(
      lesson,
      run,
      {
        eventId: 'corpus-event:' + ++counter,
        expectedRevision: run.revision,
        occurrenceId: view().question?.occurrenceId ?? null,
        type,
        payload,
      },
      { now: NOW, soundReview },
    );
    run = result.run;
    return result;
  };
  const answer = () => {
    const q = view().question;
    const printed =
      q.characterId === corpusFixture().characters[0].characterId ? '木' : '林';
    const selected = q.choices.find((c) => c.hanzi === printed);
    assert(selected);
    return act('answer', { choiceId: selected.choiceId });
  };
  const seek = (step) => {
    let count = 0;
    while (run.state.stepId !== step) {
      assert(++count < 60);
      if (view().question && !view().canContinue) act('audio-unavailable');
      else act('continue');
    }
  };
  return {
    lesson,
    view,
    act,
    answer,
    seek,
    get run() {
      return run;
    },
  };
}
test('R6 accepts fixed shared shape and preserves ORIGINAL package digest/version/adapter', async () => {
  const p = corpusFixture();
  assert.deepEqual(validateCurriculumPackage(p), { ok: true, errors: [] });
  const lesson = await compileCorpusRuntime(p);
  assert.deepEqual(lesson.identity, {
    lessonId: p.lessonId,
    lessonVersion: p.lessonVersion,
    contentDigest: await curriculumDigest(p),
    adapterId: 'corpus-paired',
    adapterVersion: 'corpus-paired-v1',
  });
  const run = createCorpusRun(lesson, {
    runId: 'identity',
    seed: 1,
    phase: 'initial',
    now: NOW,
  });
  assert.equal(run.schemaVersion, 'r6-corpus-run-1');
  assert.equal(
    projectCorpusRun(lesson, run, { soundReview: 'pending' }).schemaVersion,
    'r6-story-view-1',
  );
  assert.equal(JSON.stringify(run.identity), JSON.stringify(lesson.identity));
  assert(Object.isFrozen(lesson.identity));
  const rewritten = structuredClone(p);
  rewritten.renderer.adapterId = 'paired-story';
  rewritten.renderer.adapterVersion = 'paired-story-v1';
  assert.notEqual(
    lesson.identity.contentDigest,
    await curriculumDigest(rewritten),
  );
  await assert.rejects(() => paired.compilePairedRuntime(p), /INVALID_PACKAGE/);
  await assert.rejects(
    () => compileCorpusRuntime(rewritten),
    /INVALID_PACKAGE/,
  );
});
test('profile dispatch inspects before dereference and rejects unknown versions/ambiguous cue roles', () => {
  let called = 0;
  const bad = corpusFixture();
  Object.defineProperty(bad, 'renderer', {
    get() {
      called++;
      throw Error('accessor');
    },
  });
  assert.equal(validateCurriculumPackage(bad).ok, false);
  assert.equal(called, 0);
  for (const mutation of [
    (p) => (p.renderer.adapterVersion = 'corpus-paired-v99'),
    (p) => (p.pairedStory.schemaVersion = 'r6-paired-profile-1'),
    (p) => {
      p.pairedStory.playback.cues[0].readingId =
        p.characters[0].readings[0].readingId;
      p.pairedStory.playback.cues[0].checkId = p.recognitionChecks[0].checkId;
    },
  ]) {
    const p = corpusFixture();
    mutation(p);
    assert.equal(validateCurriculumPackage(p).ok, false);
  }
});
test('familiarity independent first facts produce reminder; helped first facts remain full', async () => {
  const h = await harness();
  h.act('continue');
  h.answer();
  h.act('continue');
  h.act('help');
  assert.equal(h.run.state.attempts, 0);
  h.answer();
  h.act('continue');
  assert.deepEqual(
    h.run.state.targetRoutes.map((t) => t.mode),
    ['reminder', 'full'],
  );
  assert.equal(h.view().recap.familiarity.independent, 1);
  assert.equal(h.view().recap.familiarity.supported, 1);
  assert.equal(h.view().recap.familiarity.firstResponses, 2);
  assert.equal(h.view().recap.familiarity.helpCount, 1);
  assert.equal(h.view().teachingPanel.mode, 'reminder');
  assert.equal(h.view().lesson.playback.cues.length, 3);
  h.act('continue');
  assert.equal(h.view().teachingPanel.mode, 'full');
});
test('quiet questions expose only current cue; pending audio cannot score and unavailable closes once', async () => {
  const h = await harness('review-24h');
  const v = h.view();
  assert.equal(v.lesson.playback.cues.length, 1);
  assert.equal(v.lesson.playback.cues[0].checkId, v.question.checkId);
  assert.equal(v.teachingPanel, null);
  assert.equal(v.readerPanel, null);
  assert.equal(v.question.hintEnglish, null);
  assert.equal(v.question.demonstrationEnglish, null);
  for (const key of [
    'correctChoiceId',
    'recognitionChecks',
    'sourceChecked',
    'privateKey',
  ])
    assert(!JSON.stringify(v).includes(key));
  const selected = v.question.choices.find((c) => c.hanzi === '木');
  assert.throws(
    () => h.act('answer', { choiceId: selected.choiceId }, 'pending'),
    /INVALID_TRANSITION/,
  );
  h.act('audio-unavailable', {}, 'pending');
  assert.equal(h.run.state.questionStatus, 'unavailable');
  assert.throws(() => h.act('audio-unavailable'), /INVALID_TRANSITION/);
  assert.throws(() => h.answer(), /INVALID_TRANSITION/);
});
test('Help is separate from first wrong; first wrong stays open and second wrong demonstrates', async () => {
  const h = await harness('review-7d');
  h.act('help');
  const wrong = h
    .view()
    .question.choices.find((c) => c.hanzi !== '木').choiceId;
  const first = h.act('answer', { choiceId: wrong });
  assert.equal(first.ack.result.firstResponse, true);
  assert.equal(first.ack.result.assisted, true);
  assert.equal(h.run.state.questionStatus, 'open');
  h.act('answer', { choiceId: wrong });
  assert.equal(h.run.state.attempts, 2);
  assert.equal(h.run.state.questionStatus, 'demonstrated');
  assert(h.view().question.demonstrationEnglish);
  assert.equal(h.view().recap.check.firstResponses, 1);
});
test('late same-question failure preserves original first answer and exact retry; stale occurrence never writes', async () => {
  const h = await harness('review-24h');
  const first = h.answer(),
    original = structuredClone(first.event);
  h.act('audio-unavailable');
  assert.equal(JSON.stringify(h.run.events[0]), JSON.stringify(original));
  assert.equal(h.view().recap.check.independent, 0);
  assert.equal(h.view().recap.check.unavailable, 1);
  assert.equal(h.view().recap.check.firstResponses, 1);
  const replay = applyCorpusAction(h.lesson, h.run, first.event.action, {
    now: NOW,
    soundReview: 'pending',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.ack.revision, 1);
  assert.equal(replay.run.revision, 2);
  assert.throws(
    () =>
      applyCorpusAction(
        h.lesson,
        h.run,
        { ...first.event.action, payload: { choiceId: 'changed' } },
        { now: NOW, soundReview: 'synthetic' },
      ),
    /EVENT_CONFLICT/,
  );
  h.act('continue');
  assert.throws(
    () =>
      applyCorpusAction(
        h.lesson,
        h.run,
        {
          ...first.event.action,
          eventId: 'late',
          type: 'audio-unavailable',
          payload: {},
          expectedRevision: h.run.revision,
        },
        { now: NOW, soundReview: 'synthetic' },
      ),
    /INVALID_TRANSITION/,
  );
});
test('initial/24h/7d use separate original identities, distinct positions and replayable completed facts', async () => {
  const positions = [],
    firstFacts = [];
  for (const phase of ['initial', 'review-24h', 'review-7d']) {
    const h = await harness(phase);
    h.seek('check');
    positions.push(
      h.view().question.choices.findIndex((c) => c.hanzi === '木'),
    );
    while (h.run.state.stepId !== 'recap') {
      if (h.view().question && !h.view().canContinue) h.answer();
      else h.act('continue');
    }
    assert.equal(
      JSON.stringify(validateCorpusRun(h.lesson, h.run)),
      JSON.stringify(h.run),
    );
    assert.equal(h.view().recap.check.independent, 2);
    assert.equal(h.view().recap.phase, phase);
    assert.equal(h.view().canContinue, false);
    assert.equal(h.view().lesson.playback.cues.length, 0);
    firstFacts.push(structuredClone(h.run));
  }
  assert.equal(new Set(positions).size, 3);
  assert.equal(firstFacts[0].state.phase, 'initial');
  assert.equal(firstFacts[0].identity.adapterId, 'corpus-paired');
});
test('strict replay refuses forged identity/result, caller policy and cross-wrapper compiled objects', async () => {
  const h = await harness();
  h.act('continue');
  const forged = structuredClone(h.run);
  forged.identity.adapterId = 'paired-story';
  assert.throws(
    () => validateCorpusRun(h.lesson, forged),
    /RUNTIME_IDENTITY_MISMATCH/,
  );
  const result = structuredClone(h.run);
  result.events[0].result.outcome = 'correct';
  assert.throws(
    () => validateCorpusRun(h.lesson, result),
    /RUNTIME_STATE_INVALID/,
  );
  for (const key of ['score', 'now', 'soundReview'])
    assert.throws(
      () =>
        applyCorpusAction(
          h.lesson,
          h.run,
          {
            eventId: 'bad',
            expectedRevision: h.run.revision,
            occurrenceId: h.view().question.occurrenceId,
            type: 'help',
            payload: {},
            [key]: 1,
          },
          { now: NOW, soundReview: 'synthetic' },
        ),
      /INVALID_REQUEST/,
    );
  const old = structuredClone(corpusFixture());
  old.renderer.adapterId = 'paired-story';
  old.renderer.adapterVersion = 'paired-story-v1';
  const oldLesson = await paired.compilePairedRuntime(old);
  assert.throws(
    () =>
      createCorpusRun(oldLesson, {
        runId: 'cross',
        seed: 1,
        phase: 'initial',
        now: NOW,
      }),
    /INVALID_PACKAGE/,
  );
  assert.throws(
    () =>
      paired.createPairedRun(h.lesson, {
        runId: 'cross',
        seed: 1,
        phase: 'initial',
        now: NOW,
      }),
    /INVALID_PACKAGE/,
  );
});

test('fixed draft and first/middle/last stress packages compile their exact original R6 bytes', async () => {
  const files = [
    ...Array.from(
      { length: 10 },
      (_, i) =>
        `../content/curriculum/corpus/corpus-path-${String(i + 1).padStart(2, '0')}-v1.json`,
    ),
    ...[1, 400, 800].map(
      (i) =>
        `./fixtures/curriculum/corpus-stress/packages/corpus-stress-${String(i).padStart(4, '0')}-v1.json`,
    ),
  ];
  for (const name of files) {
    const p = JSON.parse(
      fs.readFileSync(new URL(name, import.meta.url), 'utf8'),
    );
    const l = await compileCorpusRuntime(p);
    assert.equal(l.identity.contentDigest, await curriculumDigest(p));
    assert.equal(l.identity.lessonVersion, p.lessonVersion);
    assert.equal(l.identity.adapterId, 'corpus-paired');
    await assert.rejects(
      () => paired.compilePairedRuntime(p),
      /INVALID_PACKAGE/,
    );
  }
});
