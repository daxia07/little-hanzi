import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { hasCompleteCurriculumProvenance } from '../lib/curriculum/review.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { compileCorpusRuntime, createCorpusRun, applyCorpusAction, projectCorpusRun, validateCorpusRun } from '../lib/curriculum/corpus-runtime.ts';

const read = name => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const versions = Array.from({length:37},(_,i)=>`everyday-${String(i+1).padStart(2,'0')}-v1`);
const packages = () => versions.map(v=>read(`content/curriculum/everyday/${v}.json`));
const expected = read('tests/fixtures/curriculum/everyday/oracle.json').targets;

test('[C3-001/002] all 74 everyday targets match the literal word oracle and selected source readings', () => {
  const ps=packages(), chars=ps.flatMap(p=>p.characters);
  assert.equal(ps.length,37); assert.equal(chars.length,74);
  const draft=read('content/authoring/everyday-draft-v1.json');
  const evidence=read(draft.sourceEvidence);
  assert.equal(evidence.humanReviewed,false);
  assert.equal(evidence.compositionalPhraseCount,2);
  for(const [i,c] of chars.entries()) {
    assert.equal(c.hanzi,expected[i].hanzi);
    assert.deepEqual(c.wordAssociations.map(w=>w.text),expected[i].words);
    const authored=draft.lessons[Math.floor(i/2)].characters[i%2];
    assert.equal(authored.numberedPinyin,expected[i].numberedPinyin);
    assert.equal(c.readings[0].pinyin,authored.pinyin);
    for(const w of authored.words) {
      assert.ok(w.sentence.includes(w.text));
      const entry=evidence.entries.find(e=>e.simplified===w.text&&e.numberedPinyin===w.numberedPinyin);
      assert.ok(entry,'exact word reading requires an explicit evidence entry');
      if(entry.kind==='compositional-phrase') {
        assert.equal(entry.humanReviewed,false);
        assert.equal(entry.components.map(e=>e.simplified).join(''),w.text);
        assert.equal(entry.components.map(e=>e.numberedPinyin).join(' '),w.numberedPinyin);
      } else assert.equal(entry.kind,'dictionary-entry');
    }
  }
  for(const p of ps) {
    assert.deepEqual(validateCurriculumPackage(p),{ok:true,errors:[]});
    for(const c of p.characters) for(const w of c.wordAssociations) {
      const check=p.recognitionChecks.find(q=>q.characterId===c.characterId&&q.kind==='word-context'&&q.prompt.hanzi===w.text);
      const ordinal=['first','second','third','fourth'][w.text.indexOf(c.hanzi)];
      assert.ok(check.instructionEnglish.includes(`${ordinal} printed character`),'shared words must identify exactly which position to select');
    }
  }
  const broken=structuredClone(ps[0]);
  broken.characters[0].wordAssociations[0].context.hanzi='我们看书。';
  assert.equal(validateCurriculumPackage(broken).ok,false);
});

test('[C3-003/006] corpus v3 adds 37 packages without changing earlier bindings or frozen profile batches',async()=>{
  const old=inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v2.json'));
  const manifest=inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v3.json'));
  assert.equal(manifest.items.length,50);
  assert.deepEqual(manifest.items.slice(0,13),old.items);
  const seen=new Set();
  for(const [i,item] of manifest.items.entries()) {
    const dir=item.lessonVersion.startsWith('everyday-')?'everyday':item.lessonVersion.startsWith('nature-')?'nature':'corpus';
    const p=read(`content/curriculum/${dir}/${item.lessonVersion}.json`);
    assert.equal(item.contentDigest,await curriculumDigest(p));
    assert.equal(item.sequence,i+1);
    for(const c of p.characters) {assert.ok(!seen.has(c.hanzi));seen.add(c.hanzi);}
  }
  assert.equal(seen.size,100);
  assert.deepEqual(fs.readdirSync(new URL('../content/corpora/batches/',import.meta.url)).filter(n=>n.endsWith('.json')),['hanzi-starter-draft-batch-01-v1.json']);
  const batch=read('content/corpora/everyday-batches/hanzi-starter-draft-batch-03-v1.json');
  assert.equal(batch.items.length,37);assert.equal(batch.intendedScope,'draft');
  assert.ok(batch.items.every(i=>i.reviewerRefs.length===0));
  for(const p of packages()) {assert.equal(hasCompleteCurriculumProvenance(p),false);assert.deepEqual(p.pairedStory.playback.voices,[]);}
});

test('[C3-004] every exact audio consumer is covered once with pending status and no invented waveform',async()=>{
  const work=read('content/authoring/everyday-audio-worklist-v1.json');
  assert.equal(work.requests.length,368);
  assert.equal(work.requests.flatMap(r=>r.consumers).length,592);
  for(const p of packages()) {
    const digest=await curriculumDigest(p);
    for(const cue of p.pairedStory.playback.cues) {
      const matching=work.requests.filter(r=>r.consumers.some(c=>c.lessonVersion===p.lessonVersion&&c.cueId===cue.cueId));
      assert.equal(matching.length,1);
      const r=matching[0];assert.equal(r.contentDigest,digest);assert.equal(r.script,cue.transcript);
      assert.equal(r.audioSha256,null);assert.equal(r.renderStatus,'not-rendered');assert.equal(r.listeningStatus,'pending');assert.equal(r.deviceStatus,'pending');
    }
  }
});

test('[C3-005] all 111 unavailable-audio visits replay saved state without inventing independent answers', async () => {
  const now = '2026-10-08T00:00:00.000Z';
  for (const p of packages()) {
    const lesson = await compileCorpusRuntime(p);
    for (const phase of ['initial', 'review-24h', 'review-7d']) {
      let run = createCorpusRun(lesson, { runId: `everyday:${p.lessonVersion}:${phase}`, seed: 13, phase, now });
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

test('[C3-003/006] fixed authoring command reproduces exact packages and all digest bindings', () => {
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/build-everyday-draft.mjs', '--check'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
