import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { hasCompleteCurriculumProvenance } from '../lib/curriculum/review.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { compileCorpusRuntime, createCorpusRun, applyCorpusAction, projectCorpusRun, validateCorpusRun } from '../lib/curriculum/corpus-runtime.ts';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const versions = ['nature-01-v1', 'nature-02-v1', 'nature-03-v1'];
const packages = () => versions.map(v => read(`content/curriculum/nature/${v}.json`));
const expected = [
  ['鸟', 'niǎo', ['小鸟', '飞鸟']], ['花', 'huā', ['花园', '花朵']],
  ['草', 'cǎo', ['草地', '草原']], ['树', 'shù', ['树木', '树林']],
  ['虫', 'chóng', ['虫子', '昆虫']], ['石', 'shí', ['石头', '石子']],
];

test('[C2-002] new draft batches leave the frozen historical corpus fixture file set intact', () => {
  const historicalBatches = fs.readdirSync(new URL('../content/corpora/batches/', import.meta.url))
    .filter(name => name.endsWith('.json')).sort();
  assert.deepEqual(historicalBatches, ['hanzi-starter-draft-batch-01-v1.json']);
});

test('[C1-001/002] six new literal targets have real words, supported contexts and linked paired checks', () => {
  const ps = packages();
  assert.equal(ps.length, 3);
  const chars = ps.flatMap(p => p.characters);
  assert.equal(new Set(chars.map(c => c.hanzi)).size, 6);
  for (const [i, c] of chars.entries()) {
    assert.equal(c.hanzi, expected[i][0]);
    assert.equal(c.readings[0].pinyin, expected[i][1]);
    assert.deepEqual(c.wordAssociations.map(w => w.text), expected[i][2]);
    for (const w of c.wordAssociations) assert.ok(w.context.hanzi.includes(w.text));
  }
  for (const p of ps) assert.deepEqual(validateCurriculumPackage(p), { ok: true, errors: [] });
  const broken = structuredClone(ps[0]);
  broken.characters[0].wordAssociations[0].context.hanzi = '我们一起看书。';
  assert.equal(validateCurriculumPackage(broken).ok, false, 'a missing target word cannot become valid coverage');
});

test('[C1-003/005] additive v2 binds all 13 immutable packages; every new package retains pending authority', async () => {
  const original = read('content/corpora/hanzi-starter-draft-v1.json');
  const manifest = inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v2.json'));
  assert.equal(manifest.items.length, 13);
  assert.deepEqual(manifest.items.slice(0, 10), inspectCorpusManifest(original).items);
  const seen = new Set();
  for (const item of manifest.items) {
    const dir = item.lessonVersion.startsWith('nature-') ? 'nature' : 'corpus';
    const p = read(`content/curriculum/${dir}/${item.lessonVersion}.json`);
    assert.equal(item.contentDigest, await curriculumDigest(p));
    p.characters.forEach(c => { assert.ok(!seen.has(c.hanzi)); seen.add(c.hanzi); });
  }
  assert.equal(seen.size, 26);
  for (const p of packages()) {
    assert.equal(hasCompleteCurriculumProvenance(p), false);
    assert.deepEqual(p.pairedStory.playback.voices, []);
    assert.ok(p.assets.every(a => a.sourceChecked === false));
  }
  const batch = read('content/corpora/nature-batches/hanzi-starter-draft-batch-02-v1.json');
  assert.equal(batch.intendedScope, 'draft');
  assert.deepEqual(batch.items.map(i => i.lessonVersion), versions);
  assert.ok(batch.items.every(i => i.reviewerRefs.length === 0));
});

test('[C1-004] thirty pending render requests bind every one of the 48 exact consumers', async () => {
  const qa = read('content/authoring/nature-audio-worklist-v1.json');
  assert.equal(qa.requests.length, 30);
  assert.equal(new Set(qa.requests.map(r => r.requestId)).size, 30);
  const consumers = qa.requests.flatMap(r => r.consumers);
  assert.equal(consumers.length, 48);
  assert.equal(new Set(consumers.map(c => `${c.lessonVersion}:${c.cueId}`)).size, 48);
  for (const p of packages()) {
    const digest = await curriculumDigest(p);
    for (const cue of p.pairedStory.playback.cues) {
      const matches = qa.requests.filter(r => r.consumers.some(c => c.lessonVersion === p.lessonVersion && c.cueId === cue.cueId));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].script, cue.transcript);
      assert.equal(matches[0].contentDigest, digest);
    }
  }
  assert.ok(qa.requests.every(r => r.renderStatus === 'not-rendered' && r.listeningStatus === 'pending' && r.deviceStatus === 'pending' && r.audioSha256 === null));
});

test('[C1-002/004] nine unavailable-audio visits replay saved state without inventing independent answers', async () => {
  const now = '2026-10-08T00:00:00.000Z';
  for (const p of packages()) {
    const lesson = await compileCorpusRuntime(p);
    for (const phase of ['initial', 'review-24h', 'review-7d']) {
      let run = createCorpusRun(lesson, { runId: `nature:${p.lessonVersion}:${phase}`, seed: 13, phase, now });
      let n = 0;
      while (run.state.stepId !== 'recap' && ++n < 80) {
        const view = projectCorpusRun(lesson, run, { soundReview: 'pending' });
        run = applyCorpusAction(lesson, run, {
          eventId: `event:${n}`, expectedRevision: run.revision,
          occurrenceId: view.question?.occurrenceId ?? null,
          type: view.question && !view.canContinue ? 'audio-unavailable' : 'continue', payload: {},
        }, { now, soundReview: 'pending' }).run;
      }
      assert.equal(run.state.stepId, 'recap');
      const view = projectCorpusRun(lesson, run, { soundReview: 'pending' });
      assert.equal(view.recap.check.unavailable, 2);
      assert.equal(view.recap.check.independent, 0);
      assert.equal(view.lesson.playback.cues.length, 0);
      assert.equal(validateCorpusRun(lesson, JSON.parse(JSON.stringify(run))).revision, run.revision);
    }
  }
});

test('[C1-003/004] fixed authoring command reproduces exact packages and all digest bindings', () => {
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/build-nature-draft.mjs', '--check'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
