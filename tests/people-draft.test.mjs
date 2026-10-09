import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertDistinctPairedReadings } from '../scripts/build-paired-draft.mjs';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { hasCompleteCurriculumProvenance } from '../lib/curriculum/review.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { compileCorpusRuntime, createCorpusRun, applyCorpusAction, projectCorpusRun, validateCorpusRun } from '../lib/curriculum/corpus-runtime.ts';

const read = name => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const versions = Array.from({length:10},(_,i)=>`people-${String(i+1).padStart(2,'0')}-v1`);
const packages = () => versions.map(v=>read(`content/curriculum/people/${v}.json`));
// Literal examples frozen from the authoring contract, not the generator answer key.
const expected = [
  ['我','wo3','我们','自我'],['他','ta1','他人','其他'],['你','ni3','你好','你们'],
  ['她','ta1','她们','她自己'],['它','ta1','它们','它自己'],['们','men5','我们','他们'],
  ['的','de5','我的','你的'],['是','shi4','可是','于是'],['有','you3','有用','所有'],
  ['不','bu4','不会','不行'],['在','zai4','现在','在场'],['这','zhe4','这个','这样'],
  ['那','na4','那个','那样'],['哪','na3','哪里','哪个'],['谁','shei2','谁知','谁的'],
  ['什','shen2','什么','为什么'],['么','me5','那么','怎么'],['怎','zen3','怎么','怎样'],
  ['为','wei4','因为','为了'],['和','he2','和平','和好'],
];

test('[C4-001] ambiguous homophone sound checks are refused before authoring',()=>{
  assert.throws(()=>assertDistinctPairedReadings([
    {hanzi:'他',numberedPinyin:'ta1'},{hanzi:'她',numberedPinyin:'ta1'},
  ]),/distinct selected readings/);
  for(const lesson of read('content/authoring/people-draft-v1.json').lessons) {
    assert.doesNotThrow(()=>assertDistinctPairedReadings(lesson.characters));
  }
});

test('[C4-001/002] exact target words retain original contexts and context-consistent selected readings',()=>{
  const draft=read('content/authoring/people-draft-v1.json');
  const source=read(draft.sourceEvidence);assert.equal(source.humanReviewed,false);
  assert.equal(source.dictionaryEntryCount,53);assert.equal(source.compositionalPhraseCount,5);
  const chars=draft.lessons.flatMap(p=>p.characters);assert.equal(chars.length,20);
  for(const [i,c] of chars.entries()) {
    assert.deepEqual([c.hanzi,c.numberedPinyin,...c.words.map(w=>w.text)],expected[i]);
    for(const w of c.words) {
      assert.ok(w.sentence.includes(w.text));assert.ok(w.translation.length>10);
      assert.equal(w.numberedPinyin.split(' ')[w.text.indexOf(c.hanzi)],c.numberedPinyin);
      const e=source.entries.find(e=>e.simplified===w.text&&e.numberedPinyin===w.numberedPinyin);
      assert.ok(e);
      if(e.kind==='compositional-phrase') {
        assert.equal(e.humanReviewed,false);assert.equal(e.components.map(c=>c.simplified).join(''),w.text);
        assert.equal(e.components.map(c=>c.numberedPinyin).join(' '),w.numberedPinyin);
        assert.ok(e.components.every(c=>c.kind==='dictionary-entry'));
      } else {assert.equal(e.kind,'dictionary-entry');assert.ok(e.glosses.length);}
    }
  }
  for(const p of packages()) {
    assert.deepEqual(validateCurriculumPackage(p),{ok:true,errors:[]});
    assert.equal(hasCompleteCurriculumProvenance(p),false);
    for(const c of p.characters) for(const w of c.wordAssociations) {
      const q=p.recognitionChecks.find(q=>q.characterId===c.characterId&&q.kind==='word-context'&&q.prompt.hanzi===w.text);
      assert.ok(q.instructionEnglish.includes(`${['first','second','third','fourth'][w.text.indexOf(c.hanzi)]} printed character`));
    }
  }
  const broken=structuredClone(packages()[0]);broken.characters[0].wordAssociations[0].context.hanzi='请坐。';
  assert.equal(validateCurriculumPackage(broken).ok,false);
});

test('[C4-003] 120 distinct targets preserve the earlier 50 package bindings and frozen profile corpus',async()=>{
  const old=inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v3.json'));
  const m=inspectCorpusManifest(read('content/corpora/hanzi-starter-draft-v4.json'));
  assert.equal(m.items.length,60);assert.deepEqual(m.items.slice(0,50),old.items);
  const seen=new Set();
  for(const [i,item] of m.items.entries()) {
    const dir=item.lessonVersion.startsWith('people-')?'people':item.lessonVersion.startsWith('everyday-')?'everyday':item.lessonVersion.startsWith('nature-')?'nature':'corpus';
    const p=read(`content/curriculum/${dir}/${item.lessonVersion}.json`);
    assert.equal(item.contentDigest,await curriculumDigest(p));assert.equal(item.sequence,i+1);
    for(const c of p.characters){assert.ok(!seen.has(c.hanzi));seen.add(c.hanzi);}
  }
  assert.equal(seen.size,120);
  const b=read('content/corpora/people-batches/hanzi-starter-draft-batch-04-v1.json');
  assert.equal(b.items.length,10);assert.equal(b.intendedScope,'draft');
  assert.ok(b.items.every(i=>i.reviewerRefs.length===0));
  assert.deepEqual(fs.readdirSync(new URL('../content/corpora/batches/',import.meta.url)).filter(n=>n.endsWith('.json')),['hanzi-starter-draft-batch-01-v1.json']);
});

test('[C4-004] 160 exact audio consumers map once to 99 pending scripts with no invented waveform',async()=>{
  const work=read('content/authoring/people-audio-worklist-v1.json');
  assert.equal(work.requests.length,99);assert.equal(work.requests.flatMap(r=>r.consumers).length,160);
  const consumers=new Set();
  for(const r of work.requests) for(const c of r.consumers) {
    const key=`${c.lessonVersion}/${c.cueId}`;assert.ok(!consumers.has(key));consumers.add(key);
  }
  for(const p of packages()) {
    assert.deepEqual(p.pairedStory.playback.voices,[]);const digest=await curriculumDigest(p);
    for(const cue of p.pairedStory.playback.cues) {
      const matches=work.requests.filter(r=>r.consumers.some(c=>c.lessonVersion===p.lessonVersion&&c.cueId===cue.cueId));
      assert.equal(matches.length,1);const r=matches[0];
      assert.equal(r.script,cue.transcript);assert.equal(r.contentDigest,digest);
      assert.equal(r.renderStatus,'not-rendered');assert.equal(r.audioSha256,null);
      assert.equal(r.listeningStatus,'pending');assert.equal(r.deviceStatus,'pending');
      assert.equal(cue.assetUrl,null);assert.equal(cue.assetDigest,null);
    }
  }
});

test('[C4-005] all 30 unavailable-audio visits preserve state with zero independent answer credit',async()=>{
  const now='2026-10-08T00:00:00.000Z';
  for(const p of packages()) {
    const lesson=await compileCorpusRuntime(p);
    for(const phase of ['initial','review-24h','review-7d']) {
      let run=createCorpusRun(lesson,{runId:`people:${p.lessonVersion}:${phase}`,seed:13,phase,now});let n=0;
      while(run.state.stepId!=='recap'&&++n<80) {
        const view=projectCorpusRun(lesson,run,{soundReview:'pending'});
        run=applyCorpusAction(lesson,run,{eventId:`event:${n}`,expectedRevision:run.revision,
          occurrenceId:view.question?.occurrenceId??null,type:view.question&&!view.canContinue?'audio-unavailable':'continue',payload:{}},{now,soundReview:'pending'}).run;
      }
      assert.equal(run.state.stepId,'recap');const view=projectCorpusRun(lesson,run,{soundReview:'pending'});
      assert.equal(view.recap.check.unavailable,2);assert.equal(view.recap.check.independent,0);
      assert.equal(view.lesson.playback.cues.length,0);
      assert.equal(validateCorpusRun(lesson,JSON.parse(JSON.stringify(run))).revision,run.revision);
    }
  }
});

test('[C4-006] fixed command reproduces exact generated packages and digest bindings',()=>{
  execFileSync(process.execPath,['--experimental-strip-types','scripts/build-people-draft.mjs','--check']);
});
