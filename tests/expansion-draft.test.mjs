import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertContextConsistentWords } from '../scripts/build-paired-draft.mjs';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { hasCompleteCurriculumProvenance } from '../lib/curriculum/review.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { inspectCorpusBatch } from '../lib/pilot/corpus-store.ts';
import { compileCorpusRuntime, createCorpusRun, applyCorpusAction, projectCorpusRun, validateCorpusRun } from '../lib/curriculum/corpus-runtime.ts';

const read = p => JSON.parse(fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8'));
const versions=Array.from({length:140},(_,i)=>`expansion-${String(i+1).padStart(3,'0')}-v1`);
const packages=()=>versions.map(v=>read(`content/curriculum/expansion/${v}.json`));

test('[C4-001] word-level neutral-tone changes cannot silently inherit a different selected target reading',()=>{
  assert.throws(()=>assertContextConsistentWords({hanzi:'在',numberedPinyin:'zai4',words:[{text:'自在',numberedPinyin:'zi4 zai5'}]}),/neutral tones/);
  assert.throws(()=>assertContextConsistentWords({hanzi:'友',numberedPinyin:'you3',words:[{text:'朋友',numberedPinyin:'peng2 you5'}]}),/neutral tones/);
  assert.doesNotThrow(()=>assertContextConsistentWords({hanzi:'友',numberedPinyin:'you3',words:[{text:'好友',numberedPinyin:'hao3 you3'}]}));
});

test('[C4-001/002] all 280 additions have context-consistent lexical evidence and usable distinct word examples',()=>{
  const draft=read('content/authoring/expansion-draft-v1.json');
  const source=read(draft.sourceEvidence);assert.equal(source.humanReviewed,false);
  const roster=read('content/authoring/expansion-target-roster-v1.json');
  const authored=draft.lessons.flatMap(l=>l.characters);assert.equal(authored.length,280);
  assert.deepEqual(authored.map(c=>c.hanzi).sort(),roster.targets.slice(20).sort());
  const oracle=read('tests/fixtures/curriculum/expansion/oracle.json');
  for(const c of authored) {
    const expected=oracle.targets.find(t=>t.hanzi===c.hanzi);assert.ok(expected);
    assert.equal(c.numberedPinyin,expected.numberedPinyin);assert.deepEqual(c.words.map(w=>w.text),expected.words);
    assert.equal(new Set(c.words.map(w=>w.text)).size,2);
    assert.ok(c.hint.includes(c.hanzi),'printed-shape hint must name its actual target');
    assert.match(c.hint,/Find|Notice|Compare|Follow/,'hint must direct attention to a printed feature');
    for(const w of c.words) {
      assert.ok(w.sentence.includes(w.text));
      assert.match(w.translation,/^[A-Z].+[.!?]$/,'reader English must be an authored complete sentence');
      assert.doesNotMatch(w.translation,/one's|\{(?:word|english)\}/,'dictionary placeholders cannot become reader text');
      assert.equal(w.numberedPinyin.split(' ')[w.text.indexOf(c.hanzi)],c.numberedPinyin);
      const e=source.entries.find(e=>e.simplified===w.text&&e.numberedPinyin===w.numberedPinyin);assert.ok(e);
      if(e.kind==='compositional-phrase') {
        assert.equal(e.humanReviewed,false);assert.equal(e.components.map(c=>c.simplified).join(''),w.text);
        assert.equal(e.components.map(c=>c.numberedPinyin).join(' '),w.numberedPinyin);
      } else {assert.equal(e.kind,'dictionary-entry');assert.ok(e.glosses.length);}
    }
  }
  for(const p of packages()) {
    assert.deepEqual(validateCurriculumPackage(p),{ok:true,errors:[]});assert.equal(hasCompleteCurriculumProvenance(p),false);
    for(const c of p.characters) for(const w of c.wordAssociations) {
      const q=p.recognitionChecks.find(q=>q.characterId===c.characterId&&q.kind==='word-context'&&q.prompt.hanzi===w.text);
      assert.ok(q.instructionEnglish.includes(`${['first','second','third','fourth'][w.text.indexOf(c.hanzi)]} printed character`));
    }
  }
});

test('[C4-003] 400 distinct targets preserve prior 60 bindings and immutable package bytes',async()=>{
  const before=inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v4.json'));
  const after=inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v5.json'));
  assert.equal(after.items.length,200);assert.deepEqual(after.items.slice(0,60),before.items);
  const frozen=read('tests/fixtures/curriculum/expansion/previous-package-bytes.json');assert.equal(frozen.files.length,60);
  for(const file of frozen.files) {
    assert.equal(createHash('sha256').update(fs.readFileSync(new URL(`../${file.path}`,import.meta.url))).digest('hex'),file.sha256);
  }
  const identities=new Set();
  for(const [i,item] of after.items.entries()) {
    const dir=item.lessonVersion.startsWith('expansion-')?'expansion':item.lessonVersion.startsWith('people-')?'people':item.lessonVersion.startsWith('everyday-')?'everyday':item.lessonVersion.startsWith('nature-')?'nature':'corpus';
    const p=read(`content/curriculum/${dir}/${item.lessonVersion}.json`);
    assert.equal(item.contentDigest,await curriculumDigest(p));assert.equal(item.sequence,i+1);
    for(const c of p.characters){assert.ok(!identities.has(c.hanzi));identities.add(c.hanzi);}
  }
  assert.equal(identities.size,400);
  const batches=['01','02','03'].map(n=>inspectCorpusBatch(read(`content/corpora/expansion-batches/hanzi-starter-draft-batch-05-${n}-v1.json`)));
  assert.deepEqual(batches.map(b=>b.items.length),[50,50,40]);
  for(const b of batches) {
    assert.equal(b.intendedScope,'draft');assert.ok(b.items.every(i=>i.reviewerRefs.length===0));
    assert.ok(b.items.every(i=>after.items.find(m=>m.lessonVersion===i.lessonVersion)?.batchId===b.batchId));
  }
  const tooLarge=structuredClone(batches[0]);tooLarge.items.push(batches[1].items[0]);
  assert.throws(()=>inspectCorpusBatch(tooLarge),/INVALID_BATCH/);
  assert.deepEqual(fs.readdirSync(new URL('../content/corpora/batches/',import.meta.url)).filter(n=>n.endsWith('.json')),['hanzi-starter-draft-batch-01-v1.json']);
});

test('[C4-004] every new audio consumer has one exact pending script and no manufactured recording',async()=>{
  const work=read('content/authoring/expansion-audio-worklist-v1.json');
  assert.equal(work.requests.flatMap(r=>r.consumers).length,2240);const consumers=new Set();
  for(const r of work.requests) for(const c of r.consumers) {
    const key=`${c.lessonVersion}/${c.cueId}`;assert.ok(!consumers.has(key));consumers.add(key);
  }
  for(const p of packages()) {
    assert.deepEqual(p.pairedStory.playback.voices,[]);const digest=await curriculumDigest(p);
    for(const cue of p.pairedStory.playback.cues) {
      const matching=work.requests.filter(r=>r.consumers.some(c=>c.lessonVersion===p.lessonVersion&&c.cueId===cue.cueId));
      assert.equal(matching.length,1);const r=matching[0];assert.equal(r.script,cue.transcript);assert.equal(r.contentDigest,digest);
      assert.equal(r.renderStatus,'not-rendered');assert.equal(r.audioSha256,null);assert.equal(cue.assetUrl,null);assert.equal(cue.assetDigest,null);
      assert.equal(r.listeningStatus,'pending');assert.equal(r.deviceStatus,'pending');
    }
  }
});

test('[C4-005] all 420 initial and delayed unavailable-audio visits preserve state without independent credit',async()=>{
  const now='2026-10-08T00:00:00.000Z';
  for(const p of packages()) {
    const lesson=await compileCorpusRuntime(p);
    for(const phase of ['initial','review-24h','review-7d']) {
      let run=createCorpusRun(lesson,{runId:`expansion:${p.lessonVersion}:${phase}`,seed:13,phase,now}),n=0;
      while(run.state.stepId!=='recap'&&++n<80) {
        const view=projectCorpusRun(lesson,run,{soundReview:'pending'});
        run=applyCorpusAction(lesson,run,{eventId:`event:${n}`,expectedRevision:run.revision,occurrenceId:view.question?.occurrenceId??null,
          type:view.question&&!view.canContinue?'audio-unavailable':'continue',payload:{}},{now,soundReview:'pending'}).run;
      }
      assert.equal(run.state.stepId,'recap');const view=projectCorpusRun(lesson,run,{soundReview:'pending'});
      assert.equal(view.recap.check.unavailable,2);assert.equal(view.recap.check.independent,0);assert.equal(view.lesson.playback.cues.length,0);
      assert.equal(validateCorpusRun(lesson,JSON.parse(JSON.stringify(run))).revision,run.revision);
    }
  }
});

test('[C4-006] fixed command reproduces exact new packages and all bindings',()=>{
  execFileSync(process.execPath,['--experimental-strip-types','scripts/build-expansion-draft.mjs','--check']);
});
