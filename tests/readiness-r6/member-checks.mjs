// Pure member evidence only: real family HTTP/browser/database checks are separate.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MEMBER_CHECK_IDS,
  digest,
  canonical,
  inspectLiteralOracle,
  literalChoice,
} from './oracle.mjs';

const PHASES = ['initial', 'review-24h', 'review-7d'];
const NOW = 1790467200000;
const FORBIDDEN = new Set([
  'correctChoiceId',
  'correctAnswer',
  'recognitionChecks',
  'pairedStory',
]);
function noGrader(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(
      !FORBIDDEN.has(key),
      'Private grader/profile leaked in safe projection: ' + key,
    );
    noGrader(child);
  }
}
function checkIdentity(value, oracle) {
  assert.equal(value.lessonVersion, oracle.lessonVersion);
  assert.equal(value.contentDigest, oracle.contentDigest);
  assert.equal(value.adapterId, 'corpus-paired');
  assert.equal(value.adapterVersion, 'corpus-paired-v1');
}
async function checkCandidateAssets(pkg, root, files) {
  assert(Array.isArray(files));
  const cues = pkg.pairedStory.playback.cues;
  const referenced = new Map();
  for (const cue of cues) {
    assert(pkg.assets.some((a) => a.assetId === cue.assetId));
    if (cue.assetUrl !== null) {
      assert.match(cue.assetDigest, /^sha256:[a-f0-9]{64}$/);
      if (referenced.has(cue.assetUrl))
        assert.equal(referenced.get(cue.assetUrl), cue.assetDigest);
      referenced.set(cue.assetUrl, cue.assetDigest);
    } else assert.equal(cue.assetDigest, null);
  }
  let byteCount = 0;
  for (const [url, expected] of referenced) {
    assert(
      root,
      'Referenced candidate asset bytes require explicit frozen root',
    );
    const matches = files.filter((f) => f.url === url);
    assert.equal(
      matches.length,
      1,
      'Referenced URL must bind exactly one frozen candidate file',
    );
    const file = matches[0];
    assert.equal(file.sha256, expected);
    assert(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
    const absoluteRoot = await realpath(root);
    const candidateFile = path.resolve(absoluteRoot, file.path);
    assert(candidateFile.startsWith(absoluteRoot + path.sep));
    assert.equal(
      await realpath(candidateFile),
      candidateFile,
      'No symlink asset substitution',
    );
    const bytes = await readFile(candidateFile);
    assert.equal(
      'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      expected,
    );
    byteCount += bytes.length;
  }
  if (!referenced.size)
    assert.equal(pkg.pairedStory.playback.kind, 'local-device');
  return {
    referencedFileCount: referenced.size,
    byteCount,
    deviceProvidedBytesMeasured: false,
  };
}

export async function runMemberChecks({
  packageInput,
  oracle: suppliedOracle,
  engine,
  candidateRoot,
  assetFiles = [],
}) {
  const oracle = inspectLiteralOracle(suppliedOracle);
  for (const name of [
    'compileCorpusRuntime',
    'createCorpusRun',
    'applyCorpusAction',
    'projectCorpusRun',
    'validateCorpusRun',
  ]) {
    assert.equal(
      typeof engine?.[name],
      'function',
      'Actual frozen R6 engine export required: ' + name,
    );
  }
  const results = [];
  let lesson;
  const traces = [],
    positions = new Map();
  async function check(id, fn) {
    try {
      results.push({ id, outcome: 'PASS', evidence: await fn() });
    } catch (error) {
      results.push({ id, outcome: 'FAIL', error: error.message });
    }
  }
  await check(MEMBER_CHECK_IDS[0], async () => {
    assert.equal(
      digest(packageInput),
      oracle.contentDigest,
      'Original canonical package bytes differ from literal oracle',
    );
    assert.equal(packageInput.lessonVersion, oracle.lessonVersion);
    assert.equal(packageInput.renderer.adapterId, 'corpus-paired');
    assert.equal(packageInput.renderer.adapterVersion, 'corpus-paired-v1');
    lesson = await engine.compileCorpusRuntime(packageInput);
    checkIdentity(lesson.identity, oracle);
    assert.deepEqual(
      lesson.targetIds,
      oracle.targets.map((t) => t.characterId),
    );
    for (const target of oracle.targets) {
      const character = packageInput.characters.find(
        (c) => c.characterId === target.characterId,
      );
      assert.equal(character.hanzi, target.hanzi);
      assert(
        character.readings.some(
          (r) =>
            r.readingId === target.reading.readingId &&
            r.pinyin === target.reading.pinyin &&
            r.audioText === target.reading.audioText,
        ),
      );
      for (const word of target.words) {
        const actual = character.wordAssociations.find(
          (w) => w.wordId === word.wordId,
        );
        assert(actual);
        ['text', 'pinyin', 'english'].forEach((k) =>
          assert.equal(actual[k], word[k]),
        );
        assert.equal(actual.context.hanzi, word.context.hanzi);
        assert.equal(actual.context.english, word.context.english);
      }
    }
    assert.deepEqual(
      new Set(packageInput.recognitionChecks.map((c) => c.checkId)),
      new Set(oracle.checks.map((c) => c.checkId)),
    );
    for (const asset of packageInput.assets) {
      for (const key of ['source', 'license', 'evidenceRef'])
        assert.equal(
          typeof asset[key] === 'string' && asset[key].trim().length > 0,
          true,
        );
    }
    return {
      originalIdentity: lesson.identity,
      targets: oracle.targets.map((t) => t.hanzi),
      assets: await checkCandidateAssets(
        packageInput,
        candidateRoot,
        assetFiles,
      ),
      humanReviewEstablished: false,
    };
  });
  if (!lesson || results[0].outcome !== 'PASS') {
    for (const id of MEMBER_CHECK_IDS.slice(1))
      results.push({
        id,
        outcome: 'BLOCKED',
        error: 'Profile/source/assets prerequisite failed',
      });
    return {
      schemaVersion: 'r6-member-check-report-1',
      lessonVersion: oracle.lessonVersion,
      contentDigest: oracle.contentDigest,
      results,
    };
  }
  let runNumber = 0;
  function journey(
    phase,
    familiarity = ['correct', 'correct'],
    incorrectFirst = false,
  ) {
    const phaseNow =
      NOW +
      (phase === 'review-24h'
        ? 86400000
        : phase === 'review-7d'
          ? 604800000
          : 0);
    let run = engine.createCorpusRun(lesson, {
      runId: 'qa-member-' + ++runNumber,
      seed: 0,
      phase,
      now: phaseNow,
    });
    const frames = [],
      answers = [],
      checks = new Set();
    function view() {
      const projected = engine.projectCorpusRun(lesson, run, {
        soundReview: 'synthetic',
      });
      checkIdentity(projected, oracle);
      assert.equal(projected.schemaVersion, 'r6-story-view-1');
      frames.push(structuredClone(projected));
      return projected;
    }
    function action(type, payload = {}) {
      const v = view();
      const previous = structuredClone(run.events);
      const result = engine.applyCorpusAction(
        lesson,
        run,
        {
          eventId: 'qa-action-' + runNumber + '-' + (run.revision + 1),
          expectedRevision: run.revision,
          occurrenceId: v.question?.occurrenceId ?? null,
          type,
          payload,
        },
        { now: phaseNow + run.revision + 1, soundReview: 'synthetic' },
      );
      run = result.run;
      assert.deepEqual(
        canonical(run.events.slice(0, previous.length)),
        canonical(previous),
        'Earlier first/help facts rewritten',
      );
      assert.equal(result.ack.revision, run.revision);
      return result;
    }
    for (let iteration = 0; iteration < 100; iteration++) {
      const v = view();
      if (run.state.completedAt) {
        const trace = {
          phase,
          familiarity,
          frames,
          answers,
          checks: [...checks],
          run: structuredClone(run),
        };
        traces.push(trace);
        return trace;
      }
      if (!v.question || v.question.status !== 'open') {
        action('continue');
        continue;
      }
      const q = v.question,
        choice = literalChoice(q, oracle);
      checks.add(q.checkId);
      if (run.state.stepId === 'check')
        positions.set(
          phase + ':' + q.characterId,
          q.choices.findIndex((c) => c.choiceId === choice.choiceId),
        );
      const index = oracle.targets.findIndex(
        (t) => t.characterId === q.characterId,
      );
      const mode =
        run.state.stepId === 'familiarity' ? familiarity[index] : 'correct';
      if (mode === 'unavailable') {
        action('audio-unavailable');
        continue;
      }
      if (mode === 'help') action('help');
      if (mode === 'wrong' || incorrectFirst) {
        const wrong = q.choices.find((c) => c.hanzi !== choice.hanzi);
        const bad = action('answer', { choiceId: wrong.choiceId });
        assert.equal(bad.ack.result.outcome, 'incorrect');
        assert.equal(bad.ack.result.firstResponse, true);
        answers.push({
          checkId: q.checkId,
          expected: 'incorrect',
          result: bad.ack.result,
        });
      }
      const good = action('answer', { choiceId: choice.choiceId });
      assert.equal(good.ack.result.outcome, 'correct');
      assert.equal(
        good.ack.result.firstResponse,
        !(mode === 'wrong' || incorrectFirst),
      );
      assert.equal(
        good.ack.result.assisted,
        mode === 'help' || mode === 'wrong' || incorrectFirst,
      );
      answers.push({
        checkId: q.checkId,
        expected: 'correct',
        result: good.ack.result,
      });
    }
    assert.fail('Member pure journey exceeded bounded100 transitions');
  }
  await check(MEMBER_CHECK_IDS[1], () => {
    const modes = [
      ['correct', 'correct'],
      ['help', 'help'],
      ['unavailable', 'unavailable'],
      ['correct', 'help'],
      ['help', 'correct'],
      ['wrong', 'wrong'],
    ];
    const routes = [];
    for (const mode of modes) {
      const t = journey('initial', mode),
        teaching = t.frames.find((f) => f.state.stepId === 'teach');
      assert(teaching);
      const expected = oracle.targets.map((target, i) => ({
        characterId: target.characterId,
        mode: mode[i] === 'correct' ? 'reminder' : 'full',
      }));
      assert.deepEqual(teaching.state.targetRoutes, expected);
      const facts = t.run.events.filter((e) => e.stepId === 'familiarity');
      for (let i = 0; i < 2; i++) {
        const targetFacts = facts.filter(
          (e) => e.characterId === oracle.targets[i].characterId,
        );
        assert(
          mode[i] === 'unavailable'
            ? targetFacts.some((e) => e.result.outcome === 'unavailable')
            : targetFacts.some((e) => e.result.firstResponse),
        );
        if (mode[i] === 'help')
          assert(targetFacts.some((e) => e.action.type === 'help'));
      }
      routes.push({
        familiarity: mode,
        expectedRoutes: expected,
        firstFacts: facts
          .filter((e) => e.action.type !== 'continue')
          .map((e) => ({
            characterId: e.characterId,
            type: e.action.type,
            result: e.result,
          })),
      });
    }
    return { pureRuns: modes.length, routes };
  });
  let grading;
  await check(MEMBER_CHECK_IDS[2], () => {
    grading = PHASES.map((phase) =>
      journey(phase, ['correct', 'correct'], true),
    );
    assert.deepEqual(
      new Set(grading.flatMap((t) => t.checks)),
      new Set(oracle.checks.map((c) => c.checkId)),
    );
    for (const check of oracle.checks) {
      const answers = grading
        .flatMap((t) => t.answers)
        .filter((a) => a.checkId === check.checkId);
      assert(
        answers.some((a) => a.expected === 'incorrect') &&
          answers.some((a) => a.expected === 'correct'),
      );
    }
    return {
      declaredTemplatesExercised: oracle.checks.length,
      phaseOccurrences: grading.map((t) => ({
        phase: t.phase,
        occurrences: t.checks.length,
      })),
      literalExpectedPrints: oracle.checks.map((c) => ({
        checkId: c.checkId,
        hanzi: c.expectedHanzi,
        prompt: c.promptHanzi,
      })),
    };
  });
  await check(MEMBER_CHECK_IDS[3], () => {
    assert(grading, 'Recognition phase execution prerequisite absent');
    const initial = structuredClone(grading[0].run);
    for (const t of grading)
      assert.equal(
        canonical(engine.validateCorpusRun(lesson, t.run)),
        canonical(t.run),
      );
    assert.equal(canonical(grading[0].run), canonical(initial));
    for (const target of oracle.targets)
      assert.equal(
        new Set(
          PHASES.map((phase) =>
            positions.get(phase + ':' + target.characterId),
          ),
        ).size,
        3,
        'Print position must rotate between initial/24h/7d',
      );
    const modified = structuredClone(grading[1].run);
    modified.events[0].result.outcome = 'correct';
    assert.throws(
      () => engine.validateCorpusRun(lesson, modified),
      'Forged delayed first result must fail replay',
    );
    return {
      phases: PHASES,
      replayedRunCount: grading.length,
      initialFactsUnchanged: true,
      durableSchedulesTested: false,
    };
  });
  await check(MEMBER_CHECK_IDS[4], () => {
    assert(
      results.find((r) => r.id === MEMBER_CHECK_IDS[1])?.outcome === 'PASS',
    );
    assert(
      results.find((r) => r.id === MEMBER_CHECK_IDS[2])?.outcome === 'PASS',
    );
    let frameCount = 0;
    for (const t of traces)
      for (const v of t.frames) {
        frameCount++;
        noGrader(v);
        const cues = v.lesson.playback.cues;
        assert(cues.length <= 3);
        if (v.question) {
          assert.equal(v.teachingPanel, null);
          assert.equal(v.readerPanel, null);
          assert.equal(cues.length, 1);
          assert.equal(cues[0].checkId, v.question.checkId);
          literalChoice(v.question, oracle);
        } else if (v.teachingPanel) {
          const target = oracle.targets.find(
            (c) => c.characterId === v.teachingPanel.characterId,
          );
          assert(target);
          assert.equal(v.teachingPanel.hanzi, target.hanzi);
          assert.equal(cues.length, 3);
          assert.equal(
            cues.filter((c) => c.readingId === target.reading.readingId).length,
            1,
          );
          const wordChecks = oracle.checks.filter(
            (c) =>
              c.characterId === target.characterId && c.kind === 'word-context',
          );
          assert.deepEqual(
            new Set(
              cues.filter((c) => c.checkId !== null).map((c) => c.checkId),
            ),
            new Set(wordChecks.map((c) => c.checkId)),
          );
        } else if (v.readerPanel) {
          assert.equal(cues.length, 1);
          assert(
            oracle.targets
              .flatMap((t) => t.words)
              .some(
                (w) =>
                  w.wordId === cues[0].wordId &&
                  w.text === v.readerPanel.highlight &&
                  w.context.hanzi === v.readerPanel.text,
              ),
          );
        } else
          assert.equal(
            cues.length,
            0,
            'Welcome/recap must not ship future cues',
          );
      }
    return {
      visitedProjectionCount: frameCount,
      pureRunCount: traces.length,
      phases: [...new Set(traces.map((t) => t.phase))],
      futureCueMapAbsent: true,
      actualBrowserBundleTested: false,
    };
  });
  return {
    schemaVersion: 'r6-member-check-report-1',
    lessonVersion: oracle.lessonVersion,
    contentDigest: oracle.contentDigest,
    results,
    limitations: [
      'Pure-engine and actual referenced-file checks only; no service/browser/SQL/scheduling or human review claim.',
      'Device speech/font bytes and pronunciation quality are not measured.',
      'Representative family and global integration proofs remain separate.',
    ],
  };
}
