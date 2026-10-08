import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';

export function pairedFixture() {
  const p = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
      'utf8',
    ),
  );
  p.lessonId = 'synthetic-pair';
  p.lessonVersion = 'synthetic-pair-v1';
  p.renderer.adapterId = 'paired-story';
  p.renderer.adapterVersion = 'paired-story-v1';
  // Literal non-Forest targets: synthetic mechanics only, not reviewed teaching.
  const serialized = JSON.stringify(p)
    .replaceAll('木', '日')
    .replaceAll('林', '月');
  const v = JSON.parse(serialized);
  v.recognitionChecks = [];
  const targets = v.characters.map((c, i) => {
    const ids = [
      'familiar',
      'practice-one',
      'practice-two',
      'immediate',
      'review',
    ].map((k) => `${k}-${i}`);
    ids.forEach((checkId, j) =>
      v.recognitionChecks.push({
        checkId,
        characterId: c.characterId,
        kind: j === 1 || j === 2 ? 'word-context' : 'plain-print',
        instructionEnglish: 'Listen and choose.',
        prompt: {
          english: 'Choose the printed character.',
          hanzi: j === 1 || j === 2 ? c.wordAssociations[j - 1].text : c.hanzi,
        },
        choices: ['日', '月', '山', '水'].map((hanzi, n) => ({
          choiceId: `choice-${i}-${j}-${n}`,
          hanzi,
        })),
        correctChoiceId: `choice-${i}-${j}-${i}`,
      }),
    );
    c.teaching.recognitionCheckId = ids[3];
    c.teaching.delayedReview.recognitionCheckId = ids[4];
    return {
      characterId: c.characterId,
      readingId: c.readings[0].readingId,
      familiarityCheckId: ids[0],
      practice: c.wordAssociations.map((w, j) => ({
        wordId: w.wordId,
        checkId: ids[j + 1],
      })),
      immediateCheckId: ids[3],
      reviewCheckId: ids[4],
    };
  });
  v.steps = [
    'familiarity',
    'teach',
    'practice',
    'plain-print-check',
    'recap',
  ].map((kind, i) => ({
    stepId: `panel-${i}`,
    kind,
    instructionEnglish: 'Take one small step.',
    recognitionCheckIds:
      i === 0
        ? targets.map((t) => t.familiarityCheckId)
        : i === 2
          ? targets.flatMap((t) => t.practice.map((w) => w.checkId))
          : i === 3
            ? targets.map((t) => t.immediateCheckId)
            : [],
  }));
  const assetId = v.assets.find((a) => a.kind === 'audio').assetId;
  const cue = (ref, transcript) => ({
    cueId: `cue-${Object.values(ref).find(Boolean)}`,
    readingId: null,
    wordId: null,
    checkId: null,
    ...ref,
    transcript,
    assetId,
    assetUrl: null,
    assetDigest: null,
  });
  v.pairedStory = {
    schemaVersion: 'r5-paired-story-1',
    welcome: {
      title: 'Two small discoveries',
      instructionEnglish: 'Let’s explore.',
    },
    targets,
    reader: {
      title: 'Read together',
      instructionEnglish: 'Listen and follow.',
      wordIds: v.characters.flatMap((c) =>
        c.wordAssociations.map((w) => w.wordId),
      ),
    },
    playback: {
      schemaVersion: 'r5-playback-1',
      kind: 'local-device',
      voices: [],
      fallback: 'unavailable',
      cues: [
        ...v.characters.map((c) =>
          cue({ readingId: c.readings[0].readingId }, c.readings[0].audioText),
        ),
        ...v.characters.flatMap((c) =>
          c.wordAssociations.map((w) =>
            cue({ wordId: w.wordId }, w.context.hanzi),
          ),
        ),
        ...v.recognitionChecks.map((c) =>
          cue({ checkId: c.checkId }, c.prompt.hanzi),
        ),
      ],
    },
  };
  return v;
}
test('generic paired non-Forest profile is accepted without Forest answer reuse', () => {
  const p = pairedFixture();
  assert.deepEqual(validateCurriculumPackage(p), { ok: true, errors: [] });
});
test('paired profile refuses ambiguous cue roles and unknown renderer', () => {
  const p = pairedFixture();
  p.pairedStory.playback.cues[0].wordId = p.pairedStory.reader.wordIds[0];
  assert.equal(validateCurriculumPackage(p).ok, false);
  const v = pairedFixture();
  v.renderer.adapterVersion = 'paired-story-v99';
  assert.equal(validateCurriculumPackage(v).ok, false);
});

import {
  compilePairedRuntime,
  createPairedRun,
  applyPairedAction,
  projectPairedRun,
  validatePairedRun,
} from '../lib/curriculum/paired-runtime.ts';
const NOW = '2026-09-27T00:00:00.000Z';
async function harness(phase = 'initial') {
  const lesson = await compilePairedRuntime(pairedFixture());
  let run = createPairedRun(lesson, {
    runId: 'run:test',
    seed: 7,
    phase,
    now: NOW,
  });
  let counter = 0;
  const view = () =>
    projectPairedRun(lesson, run, { soundReview: 'synthetic' });
  const act = (type, payload = {}, policy = 'synthetic') => {
    const a = {
      eventId: `event:${++counter}`,
      expectedRevision: run.revision,
      occurrenceId: view().question?.occurrenceId ?? null,
      type,
      payload,
    };
    const result = applyPairedAction(lesson, run, a, {
      now: NOW,
      soundReview: policy,
    });
    run = result.run;
    return result;
  };
  return {
    lesson,
    view,
    act,
    get run() {
      return run;
    },
    set run(v) {
      run = v;
    },
  };
}
function seek(h, step) {
  let n = 0;
  while (h.run.state.stepId !== step && n++ < 80) {
    const v = h.view();
    if (v.question && !v.canContinue) h.act('audio-unavailable');
    else h.act('continue');
  }
  assert.equal(h.run.state.stepId, step);
}
test('actual target first responses produce mixed reminders, never parent confidence', async () => {
  const h = await harness();
  h.act('continue');
  h.act('answer', { choiceId: 'choice-0-0-0' });
  h.act('continue');
  h.act('audio-unavailable');
  h.act('continue');
  assert.deepEqual(
    h.run.state.targetRoutes.map((r) => r.mode),
    ['reminder', 'full'],
  );
  assert.equal(h.view().teachingPanel.mode, 'reminder');
  h.act('continue');
  assert.equal(h.view().teachingPanel.mode, 'full');
});
test('initial, 24h and 7d use separate runs and distinct literal target positions', async () => {
  const positions = [];
  for (const phase of ['initial', 'review-24h', 'review-7d']) {
    const h = await harness(phase);
    seek(h, 'check');
    positions.push(
      h.view().question.choices.findIndex((c) => c.hanzi === '日'),
    );
    assert.equal(h.run.state.phase, phase);
  }
  assert.equal(new Set(positions).size, 3);
});
test('Help never increments wrong count, first wrong remains open; second wrong demonstrates', async () => {
  const h = await harness();
  h.act('continue');
  h.act('help');
  assert.equal(h.run.state.attempts, 0);
  const answer = h.act('answer', { choiceId: 'choice-0-0-1' });
  assert.equal(answer.ack.result.firstResponse, true);
  assert.equal(answer.ack.result.assisted, true);
  assert.equal(h.run.state.questionStatus, 'open');
  h.act('answer', { choiceId: 'choice-0-0-1' });
  assert.equal(h.run.state.questionStatus, 'demonstrated');
  assert.equal(h.run.state.attempts, 2);
  assert.equal(h.view().recap.familiarity.helpCount, 1);
});
test('helped first correct answer is supported, never a reminder', async () => {
  const h = await harness();
  h.act('continue');
  h.act('help');
  h.act('answer', { choiceId: 'choice-0-0-0' });
  assert.equal(h.view().recap.familiarity.independent, 0);
  assert.equal(h.view().recap.familiarity.supported, 1);
  h.act('continue');
  h.act('audio-unavailable');
  h.act('continue');
  assert.equal(h.run.state.targetRoutes[0].mode, 'full');
});
test('late same-occurrence audio failure preserves first answer but removes independent credit and cannot reopen', async () => {
  const h = await harness('review-24h');
  h.act('answer', { choiceId: 'choice-0-4-0' });
  const original = structuredClone(h.run.events[0]);
  assert.equal(h.view().recap.check.independent, 1);
  h.act('audio-unavailable');
  assert.equal(JSON.stringify(h.run.events[0]), JSON.stringify(original));
  assert.equal(h.view().recap.check.unavailable, 1);
  assert.equal(h.view().recap.check.independent, 0);
  assert.equal(h.view().recap.check.firstResponses, 1);
  assert.equal(h.run.state.questionStatus, 'unavailable');
  assert.throws(
    () => h.act('answer', { choiceId: 'choice-0-4-0' }),
    /INVALID_TRANSITION/,
  );
  assert.throws(() => h.act('audio-unavailable'), /INVALID_TRANSITION/);
});
test('ordinary pending sound blocks scored answers and permits unavailable completion', async () => {
  const h = await harness('review-7d');
  assert.throws(
    () => h.act('answer', { choiceId: 'choice-0-4-0' }, 'pending'),
    /INVALID_TRANSITION/,
  );
  h.act('audio-unavailable', {}, 'pending');
  h.act('continue');
  h.act('audio-unavailable', {}, 'pending');
  const end = h.act('continue');
  assert.equal(end.ack.result.outcome, 'completed');
  assert.equal(h.run.state.completedAt, NOW);
  assert.equal(h.view().recap.check.unavailable, 2);
  assert.equal(h.view().canContinue, false);
});
test('current-question projection strips private scoring, future checks and provenance', async () => {
  const h = await harness();
  h.act('continue');
  const v = h.view(),
    serialized = JSON.stringify(v);
  assert.equal(v.teachingPanel, null);
  assert.equal(v.readerPanel, null);
  assert.equal(v.question.choices.length, 4);
  for (const token of [
    'correctChoiceId',
    'recognitionChecks',
    'sourceChecked',
    'privateKey',
  ])
    assert.equal(serialized.includes(token), false);
  assert.equal(Object.hasOwn(h.lesson, 'recognitionChecks'), false);
  assert.equal(Object.isFrozen(h.lesson.identity), true);
});
test('safe teaching and reader contain original supported content; practice is not immediate score', async () => {
  const h = await harness();
  seek(h, 'teach');
  assert.equal(h.view().teachingPanel.words.length, 2);
  seek(h, 'reader');
  assert.equal(
    h.view().readerPanel.text,
    pairedFixture().characters[0].wordAssociations[0].context.hanzi,
  );
  assert.equal(
    h.view().readerPanel.highlight,
    pairedFixture().characters[0].wordAssociations[0].text,
  );
  assert.equal(h.view().recap.check.independent, 0);
  assert.equal(h.view().recap.practice.unavailable, 4);
});
test('exact old event replay returns old ack without duplicate event; changed payload refuses', async () => {
  const h = await harness();
  const result = h.act('continue');
  h.act('audio-unavailable');
  const retry = applyPairedAction(h.lesson, h.run, result.event.action, {
    now: NOW,
    soundReview: 'pending',
  });
  assert.equal(retry.replayed, true);
  assert.equal(retry.ack.revision, 1);
  assert.equal(retry.run.revision, 2);
  assert.equal(retry.run.events.length, 2);
  assert.throws(
    () =>
      applyPairedAction(
        h.lesson,
        h.run,
        { ...result.event.action, type: 'help' },
        { now: NOW, soundReview: 'synthetic' },
      ),
    /EVENT_CONFLICT/,
  );
});
test('stale revision, another occurrence, caller grading and caller time cannot enter action', async () => {
  const h = await harness();
  h.act('continue');
  const a = {
    eventId: 'bad',
    expectedRevision: 0,
    occurrenceId: h.view().question.occurrenceId,
    type: 'help',
    payload: {},
  };
  assert.throws(
    () =>
      applyPairedAction(h.lesson, h.run, a, {
        now: NOW,
        soundReview: 'synthetic',
      }),
    /STALE_REVISION/,
  );
  assert.throws(
    () =>
      applyPairedAction(
        h.lesson,
        h.run,
        { ...a, expectedRevision: 1, occurrenceId: 'other' },
        { now: NOW, soundReview: 'synthetic' },
      ),
    /INVALID_TRANSITION/,
  );
  for (const key of ['score', 'now', 'soundReview'])
    assert.throws(
      () =>
        applyPairedAction(
          h.lesson,
          h.run,
          { ...a, expectedRevision: 1, [key]: 1 },
          { now: NOW, soundReview: 'synthetic' },
        ),
      /INVALID_REQUEST/,
    );
});
test('saved reducer state/facts must replay exactly; no client can forge completed or a result', async () => {
  const h = await harness();
  h.act('continue');
  const forged = structuredClone(h.run);
  forged.state.completedAt = NOW;
  assert.throws(
    () => validatePairedRun(h.lesson, forged),
    /RUNTIME_STATE_INVALID/,
  );
  const f = structuredClone(h.run);
  f.events[0].result.outcome = 'correct';
  assert.throws(() => validatePairedRun(h.lesson, f), /RUNTIME_STATE_INVALID/);
  const p = pairedFixture();
  p.lessonVersion = 'another-version';
  const another = await compilePairedRuntime(p);
  assert.throws(
    () => validatePairedRun(another, h.run),
    /RUNTIME_IDENTITY_MISMATCH/,
  );
});
test('profile bounded JSON refuses getters, wrong sentence role, missing cues and wrong phase choice family', () => {
  const p = pairedFixture();
  let gets = 0;
  Object.defineProperty(p.pairedStory.welcome, 'title', {
    enumerable: true,
    get() {
      gets++;
      return 'Bad';
    },
  });
  assert.equal(validateCurriculumPackage(p).ok, false);
  assert.equal(gets, 0);
  for (const mutate of [
    (v) => v.pairedStory.playback.cues.pop(),
    (v) =>
      (v.pairedStory.playback.cues.find((c) => c.wordId).transcript = '日'),
    (v) => v.recognitionChecks[1].choices.reverse(),
    (v) =>
      v.pairedStory.playback.voices.push({
        name: 'remote',
        lang: 'zh-CN',
        localService: false,
      }),
  ]) {
    const v = pairedFixture();
    mutate(v);
    assert.equal(validateCurriculumPackage(v).ok, false);
  }
});
test('safe playback projects only current cue; welcome/recap never expose future material', async () => {
  const h = await harness();
  assert.equal(h.view().lesson.playback.cues.length, 0);
  h.act('continue');
  assert.equal(h.view().lesson.playback.cues.length, 1);
  assert.equal(h.view().lesson.playback.cues[0].checkId, 'familiar-0');
  seek(h, 'teach');
  assert.equal(h.view().lesson.playback.cues.length, 3);
  assert.equal(
    h.view().lesson.playback.cues.some((c) => c.wordId !== null),
    false,
  );
  seek(h, 'reader');
  assert.equal(h.view().lesson.playback.cues.length, 1);
  assert.equal(
    h.view().lesson.playback.cues[0].wordId,
    h.view().readerPanel.panelId.replace('reader-', ''),
  );
  seek(h, 'recap');
  assert.equal(h.view().lesson.playback.cues.length, 0);
});
test('all ten actual authored draft pairs mechanically compile and complete three separate unavailable visits without fake approval', async () => {
  const dir = new URL('../content/curriculum/collection/', import.meta.url);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^path-\d+-v1.json$/.test(f))
    .sort();
  assert.equal(files.length, 10);
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
    const lesson = await compilePairedRuntime(p);
    assert.equal(p.characters.length, 2);
    assert.deepEqual(p.pairedStory.playback.voices, []);
    for (const phase of ['initial', 'review-24h', 'review-7d']) {
      let r = createPairedRun(lesson, {
        runId: `run:${f.replace('.json', '')}:${phase}`,
        seed: 13,
        phase,
        now: NOW,
      });
      let n = 0;
      while (r.state.stepId !== 'recap' && n++ < 80) {
        const v = projectPairedRun(lesson, r, { soundReview: 'pending' });
        const a = {
          eventId: `event:${n}`,
          expectedRevision: r.revision,
          occurrenceId: v.question?.occurrenceId ?? null,
          type: v.question && !v.canContinue ? 'audio-unavailable' : 'continue',
          payload: {},
        };
        r = applyPairedAction(lesson, r, a, {
          now: NOW,
          soundReview: 'pending',
        }).run;
      }
      assert.equal(r.state.stepId, 'recap');
      assert.equal(r.state.completedAt, NOW);
      const v = projectPairedRun(lesson, r, { soundReview: 'pending' });
      assert.equal(v.recap.check.unavailable, 2);
      assert.equal(v.recap.check.independent, 0);
      assert.equal(v.lesson.playback.cues.length, 0);
      assert.equal(
        validatePairedRun(lesson, JSON.parse(JSON.stringify(r))).revision,
        r.revision,
      );
    }
  }
});
test('server epoch-ms injection normalizes exact ISO persisted clocks and rejects fractional clocks', async () => {
  const l = await compilePairedRuntime(pairedFixture());
  const r = createPairedRun(l, {
    runId: 'numeric:clock',
    seed: 0,
    phase: 'initial',
    now: Date.parse(NOW),
  });
  assert.equal(r.createdAt, NOW);
  const a = {
    eventId: 'numeric:event',
    expectedRevision: 0,
    occurrenceId: null,
    type: 'continue',
    payload: {},
  };
  const result = applyPairedAction(l, r, a, {
    now: Date.parse(NOW) + 1,
    soundReview: 'pending',
  });
  assert.equal(result.event.serverTime, '2026-09-27T00:00:00.001Z');
  assert.throws(
    () =>
      createPairedRun(l, {
        runId: 'bad:clock',
        seed: 0,
        phase: 'initial',
        now: 1.5,
      }),
    /INVALID_REQUEST/,
  );
});
test('first requested Help after a wrong answer still gives a clue; only second Help demonstrates', async () => {
  const h = await harness();
  h.act('continue');
  h.act('answer', { choiceId: 'choice-0-0-1' });
  assert.equal(h.run.state.questionStatus, 'open');
  h.act('help');
  assert.equal(h.run.state.questionStatus, 'open');
  assert.equal(h.run.state.attempts, 1);
  h.act('help');
  assert.equal(h.run.state.questionStatus, 'demonstrated');
  assert.equal(h.run.state.attempts, 1);
});
