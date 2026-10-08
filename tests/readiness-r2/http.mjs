// Independent real HTTP/libSQL suite; executable only with lead's frozen runtime handoff.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {prepareHTTP} from './http-harness.mjs';
import {VERSION,CORRECT,ROUTES,FINAL_CLEAN,FINAL_HELPED} from './oracle.mjs';
const handoffFile=process.argv[2];if(!handoffFile)throw Error('Frozen runtime handoff required; no default family URL');
const h=await prepareHTTP(handoffFile);await h.verifyIdentity();
const suiteStartedAt=new Date().toISOString();
const output=path.join(h.handoff.output,'independent-http');await mkdir(output,{recursive:true});
const report={candidateId:h.manifest.candidateId,sourceDigest:h.manifest.digest,integration:'r2-integration-1',runtime:'Real Node handler and local libSQL sqld',sqldVersion:h.handoff.sqldVersion,startedAt:suiteStartedAt,results:[],limitations:['No real Mandarin/audio/device/owner evidence','Review manifest rendering and compiled client answer-leak checks handled separately by browser suite','Hosted Turso networking/recovery not exercised']};
const runs=[];
const error=(r,status,code)=>{assert.equal(r.status,status);assert.equal(r.body.error?.code,code);};
const fresh=async(version=VERSION)=>{const r=await h.createRun(version);runs.push(r.runId);return r.runId;};
const get=id=>h.getRun(id);
async function send(id,type,payload={}){const before=await get(id),r=await h.action(id,before,type,payload);assert.equal(r.status,200);return r;}
const cont=id=>send(id,'continue');
const answer=(id,q,c)=>send(id,'answer',{questionId:q,choiceId:c});
async function db(id){const r=await h.inspectRun(id);assert.equal(r.status,200);assert(r.body.run);const view=await get(id);assert.equal(r.body.run.lesson_version,view.lessonVersion);assert.equal(r.body.run.revision,view.revision);assert.deepEqual(JSON.parse(r.body.run.state_json),view.state);assert.deepEqual(r.body.events.map(e=>e.event_id),view.events.map(e=>e.eventId));return r.body;}
async function familiar(id,route){await cont(id);for(const [q,c]of ROUTES[route].familiarity){const before=await get(id);assert.equal(before.state.questionId,q);await answer(id,q,c);if((await get(id)).state.questionStatus!=='open')await cont(id);}const v=await get(id);assert.equal(v.state.learnPanel,route==='familiar'?'reminder':'learn-mu');return v;}
async function toChecks(id,route='familiar'){
 await familiar(id,route);const panels=[];
 while((await get(id)).state.stepId==='learn'){panels.push((await get(id)).state.learnPanel);await cont(id);}
 assert.deepEqual(panels,route==='familiar'?['reminder']:['learn-mu','learn-lin']);
 await send(id,'place-component',{componentId:'mu-a',slot:'left'});await send(id,'place-component',{componentId:'mu-b',slot:'right'});await cont(id);
 for(const q of ['find-mu','find-lin']){await answer(id,q,CORRECT[q]);await cont(id);}
 await cont(id);await cont(id);assert.equal((await get(id)).state.questionId,'check-mu-sound');
}
async function finish(id,helped=false){
 if(helped){await answer(id,'check-mu-sound','lin');await answer(id,'check-mu-sound','ren');}else await answer(id,'check-mu-sound','mu');await cont(id);
 await answer(id,'check-lin-sound','lin');await cont(id);
 if(helped)await send(id,'hint',{questionId:'check-mu-reading'});
 await answer(id,'check-mu-reading','audio-mu');await cont(id);
 if(helped)await send(id,'audio-unavailable',{questionId:'check-lin-reading'});else await answer(id,'check-lin-reading','audio-lin');await cont(id);
 for(let n=0;n<4;n++){const v=await get(id);if(v.state.completedAt)break;await cont(id);}
 const v=await get(id);assert(v.state.completedAt);assert.deepEqual(v.recap.final,helped?FINAL_HELPED:FINAL_CLEAN);return v;
}
async function unchanged(id,before){const after=await get(id);assert.deepEqual(after,before);await db(id);}
async function test(id,acs,fn){try{const evidence=await fn();report.results.push({id,acs,status:'PASS',evidence});console.log(`${id}: PASS`);}catch(e){report.results.push({id,acs,status:'FAIL',message:e.stack});console.log(`${id}: FAIL ${e.message}`);}}
try{
 await test('R2-I01',['R2-AC-001','R2-E-001'],async()=>{
  const v1=await fresh('forest-01-v1'),old=await get(v1);assert(!Object.hasOwn(old.state,'soundReview'));assert(!Object.hasOwn(old.state,'learnPanel'));
  const v3=await fresh(),newer=await get(v3);assert.equal(newer.lessonVersion,VERSION);assert.equal(newer.state.soundReview,'synthetic');assert.equal(newer.state.learnPanel,null);
  for(const body of [{lessonId:'forest-01',lessonVersion:'unknown'},{lessonId:'forest-01',lessonVersion:VERSION,soundReview:'synthetic'},{lessonId:'forest-01',lessonVersion:VERSION,synthetic:true}])error(await h.request('POST','/api/preview/runs',body),400,'INVALID_REQUEST');
  const forbiddenKeys=(value)=>{if(Array.isArray(value))return value.flatMap(forbiddenKeys);if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>[k,...forbiddenKeys(v)]);return [];};assert(!forbiddenKeys(newer).some(k=>['correctChoiceId','correctAnswer','answerKey'].includes(k)), 'Server learner projection leaks answer key');
  await unchanged(v1,old);await db(v3);return {v1VersionPreserved:true,v3AdditiveState:true,unknownAndClientNamespaceRejected:true};
 });
 await test('R2-I01-feedback-decision',['R2-AC-001','R2-E-001'],async()=>{
  const v1=await fresh('forest-01-v1'),v3=await fresh();
  const endpoint=version=>`/api/preview/lessons/${version}/decision`;
  const oldDecision=await h.request('GET',endpoint('forest-01-v1'));assert.equal(oldDecision.status,200);
  const ordinaryBefore=await h.request('GET',endpoint(VERSION),undefined,{server:'ordinaryBaseURL',privateHeader:false});assert.equal(ordinaryBefore.status,200);assert.equal(ordinaryBefore.body.status,'draft');
  const oldFeedback={feedbackId:`qa-v1-${randomUUID()}`,stepId:'welcome',category:'clarity',text:'TEST ONLY: retained V1 feedback wire check',source:'reviewer'};
  const oldRecord=await h.request('POST',`/api/preview/runs/${v1}/feedback`,oldFeedback);assert.equal(oldRecord.status,201);assert.equal(oldRecord.body.lessonVersion,'forest-01-v1');const oldView=await get(v1);
  const feedback={feedbackId:`qa-v3-${randomUUID()}`,stepId:'welcome',category:'clarity',text:'TEST ONLY: synthetic V3 feedback wire check; no owner acceptance',source:'reviewer'};
  const posted=await h.request('POST',`/api/preview/runs/${v3}/feedback`,feedback);assert.equal(posted.status,201);assert.equal(posted.body.runId,v3);assert.equal(posted.body.lessonVersion,VERSION);assert.deepEqual((await get(v3)).feedback,[posted.body]);
  assert.deepEqual(await h.request('POST',`/api/preview/runs/${v3}/feedback`,feedback),posted);
  error(await h.request('POST',`/api/preview/runs/${v3}/feedback`,{...feedback,text:'TEST ONLY: conflicting feedback'}),409,'EVENT_CONFLICT');
  error(await h.request('POST',`/api/preview/runs/${v3}/feedback`,feedback,{server:'ordinaryBaseURL',privateHeader:false}),404,'NOT_FOUND');
  const decision={status:'approved',reviewerLabel:'SYNTHETIC QA ONLY — not the owner',notes:'TEST ONLY: wire mechanics; this is not human acceptance or release authorization',candidateId:h.manifest.candidateId};
  error(await h.request('POST',endpoint(VERSION),{...decision,candidateId:'qa-mismatched-candidate'}),409,'EVENT_CONFLICT');
  for(const method of ['GET','POST'])error(await h.request(method,endpoint('unknown'),method==='POST'?decision:undefined),400,'INVALID_REQUEST');
  const saved=await h.request('POST',endpoint(VERSION),decision);assert.equal(saved.status,201);assert.equal(saved.body.lessonVersion,VERSION);assert.equal(saved.body.candidateId,h.manifest.candidateId);assert.equal(saved.body.decision.synthetic,true);assert.equal(saved.body.decision.lessonVersion,VERSION);assert.equal(saved.body.decision.candidateId,h.manifest.candidateId);
  const read=await h.request('GET',endpoint(VERSION));assert.equal(read.status,200);assert.equal(read.body.status,'approved');assert(read.body.history.some(d=>d.decisionId===saved.body.decision.decisionId&&d.synthetic));
  assert.deepEqual(await h.request('GET',endpoint(VERSION),undefined,{server:'ordinaryBaseURL',privateHeader:false}),ordinaryBefore);
  assert.deepEqual(await h.request('GET',endpoint('forest-01-v1')),oldDecision);assert.deepEqual(await get(v1),oldView);await db(v1);await db(v3);
  return {v3FeedbackAndDecisionVersionPreserved:true,syntheticDecisionOnly:true,ordinaryDecision:'draft',v1Unchanged:true,unknownVersionAndCandidateMismatchRejected:true};
 });
 for(const route of Object.keys(ROUTES))await test(`R2-I02-${route}`,['R2-AC-002','R2-E-002','R2-E-003','R2-E-007'],async()=>{
  const id=await fresh();await toChecks(id,route);const v=await finish(id);assert.deepEqual(v.recap.familiarity,{total:2,...ROUTES[route].firstLook,pending:0});
  for(const q of ['fam-mu','fam-lin']){const choices=ROUTES[route].familiarity.filter(x=>x[0]===q).map(x=>x[1]);const events=v.events.filter(e=>e.type==='answer'&&e.questionId===q);assert.deepEqual(events.map(e=>e.payload.choiceId),choices);assert.equal(events[0].firstResponse,true);assert(events.slice(1).every(e=>!e.firstResponse));}
  const rows=await db(id);return {route,final:v.recap.final,eventCount:rows.events.length};
 });
 await test('R2-I02-helped',['R2-AC-002','R2-E-003'],async()=>{const id=await fresh();await toChecks(id,'new');const v=await finish(id,true);await db(id);return {final:v.recap.final};});
 await test('R2-I03',['R2-AC-002','R2-E-003'],async()=>{
  const id=await fresh();await toChecks(id);await send(id,'hint',{questionId:'check-mu-sound'});
  const first=await answer(id,'check-mu-sound','lin');assert.equal(first.body.result.outcome,'incorrect');assert.equal(first.body.result.assisted,true);assert.equal((await get(id)).state.questionStatus,'open');
  const second=await answer(id,'check-mu-sound','ren');assert.equal(second.body.result.outcome,'demonstrated');const v=await get(id);assert.equal(v.events.filter(e=>e.type==='answer'&&e.questionId==='check-mu-sound').length,2);await db(id);return {helpDidNotConsumeWrongAttempt:true};
 });
 await test('R2-I04',['R2-AC-004','R2-E-007'],async()=>{
  const id=await fresh();await familiar(id,'familiar');await cont(id);let v=await get(id);error(await h.action(id,v,'continue',{}),409,'INVALID_TRANSITION');await unchanged(id,v);
  await send(id,'place-component',{componentId:'mu-a',slot:'left'});v=await get(id);
  error(await h.action(id,v,'continue',{}),409,'INVALID_TRANSITION');
  for(const payload of [{componentId:'mu-a',slot:'right'},{componentId:'mu-b',slot:'left'}]){assert.equal((await h.action(id,v,'place-component',payload)).status,409);await unchanged(id,v);}
  await send(id,'place-component',{componentId:'mu-b',slot:'right'});await cont(id);assert.equal((await get(id)).state.stepId,'find');await db(id);return {incompleteAndOccupiedRejected:true};
 });
 await test('R2-I05',['R2-AC-002','R2-E-009'],async()=>{
  const id=await fresh();await cont(id);const v=await get(id),envelope={eventId:randomUUID(),expectedRevision:v.revision,stepId:v.state.stepId,type:'answer',payload:{questionId:'fam-mu',choiceId:'mu'}};
  const first=await h.request('POST',`/api/preview/runs/${id}/actions`,envelope);assert.equal(first.status,200);await cont(id);const later=await get(id);
  const replay=await h.request('POST',`/api/preview/runs/${id}/actions`,envelope);assert.deepEqual(replay,first);
  error(await h.request('POST',`/api/preview/runs/${id}/actions`,{...envelope,payload:{questionId:'fam-mu',choiceId:'lin'}}),409,'EVENT_CONFLICT');
  await unchanged(id,later);const rows=await db(id);assert.equal(rows.events.filter(e=>e.event_id===envelope.eventId).length,1);return {oneEventAfterReplay:true};
 });
 await test('R2-I06',['R2-AC-002','R2-E-010'],async()=>{
  const id=await fresh();await cont(id);const v=await get(id);const responses=await Promise.all([h.action(id,v,'answer',{questionId:'fam-mu',choiceId:'mu'}),h.action(id,v,'hint',{questionId:'fam-mu'})]);
  assert.deepEqual(responses.map(r=>r.status).sort((a,b)=>a-b),[200,409]);error(responses.find(r=>r.status===409),409,'STALE_REVISION');assert.equal((await get(id)).revision,v.revision+1);
  const after=await get(id);error(await h.request('POST',`/api/preview/runs/${id}/actions`,{eventId:randomUUID(),expectedRevision:after.revision,stepId:after.state.stepId,type:'answer',payload:{questionId:after.state.questionId,choiceId:'mu'},correct:true}),400,'INVALID_REQUEST');await unchanged(id,after);return {oneConcurrentTransition:true};
 });
 await test('R2-I07',['R2-AC-002','R2-AC-003','R2-E-009','R2-E-010'],async()=>{
  const id=await fresh();await cont(id);const v=await get(id),eventId=randomUUID();let enabled=false;
  try{assert.equal((await h.request('POST','/api/test/fault',{operation:'storage',enabled:true})).status,200);enabled=true;error(await h.action(id,v,'answer',{questionId:'fam-mu',choiceId:'mu'},eventId),503,'STORAGE_UNAVAILABLE');}
  finally{if(enabled)assert.equal((await h.request('POST','/api/test/fault',{operation:'storage',enabled:false})).status,200);}
  await unchanged(id,v);const r=await h.action(id,v,'answer',{questionId:'fam-mu',choiceId:'mu'},eventId);assert.equal(r.status,200);const replay=await h.action(id,v,'answer',{questionId:'fam-mu',choiceId:'mu'},eventId);assert.deepEqual(replay,r);await db(id);return {faultAtomic:true,exactRetryOnce:true,lostResponseBrowserCase:'NOT RUN here; browser transport drops after actual commit'};
 });
 await test('R2-I08',['R2-AC-001','R2-AC-002','R2-E-001','R2-E-002','R2-E-009','R2-E-016'],async()=>{
  const fixture=await h.request('POST','/api/test/fixtures',{scenario:'legacy-and-two-runs',seed:17});assert.equal(fixture.status,201);runs.push(...fixture.body.runIds);
  const old=await get(fixture.body.runIds[0]);assert.equal(old.lessonVersion,'forest-01-v1');const legacy=await h.inspectLegacy(fixture.body.legacyProfile);assert.equal(legacy.status,200);
  const id=await fresh();await familiar(id,'new');const first=await get(id);assert.equal(first.state.learnPanel,'learn-mu');assert.equal((await h.restart('all')).status,200);await h.verifyIdentity();await unchanged(id,first);
  await cont(id);const second=await get(id);assert.equal(second.state.learnPanel,'learn-lin');assert.equal((await h.restart('app')).status,200);await h.verifyIdentity();await unchanged(id,second);
  await unchanged(fixture.body.runIds[0],old);assert.deepEqual(await h.inspectLegacy(fixture.body.legacyProfile),legacy);
  assert.equal((await h.request('DELETE',`/api/test/runs/${id}`)).status,200);await unchanged(fixture.body.runIds[0],old);return {bothPanelsPersisted:true,v1AndLegacyUnchanged:true};
 });
 await test('R2-I09',['R2-AC-002','R2-E-015'],async()=>{
  const id=await fresh();await toChecks(id);const done=await finish(id),initial=done.recap.final;const early=await h.action(id,done,'start-review',{});error(early,409,'REVIEW_NOT_DUE');
  assert.equal((await h.request('POST',`/api/test/runs/${id}/clock`,{effectiveTime:done.reviewAvailableAt})).status,200);await send(id,'start-review');
  for(const q of ['review-mu-sound','review-lin-sound']){await answer(id,q,CORRECT[q]);await cont(id);}
  const after=await get(id);assert.deepEqual(after.recap.final,initial);assert.deepEqual(after.recap.delayed,{total:2,independentCorrect:2,supported:0,unavailable:0,pending:0});
  const count=after.events.length;const repeated=await h.action(id,after,'start-review',{});assert([200,409].includes(repeated.status));assert.equal((await get(id)).events.length,count);await db(id);return {separateDueEvidence:true};
 });
 await test('R2-I10',['R2-AC-001','R2-AC-002','R2-E-016'],async()=>{
  error(await h.request('GET','/api/test/identity',undefined,{privateHeader:false}),403,'FORBIDDEN');
  for(const server of ['ordinaryBaseURL','pilotGuardBaseURL']){
   const r=await h.request('GET','/api/test/identity',undefined,{server});assert.equal(r.status,404);
   assert.equal((await h.request('POST','/api/test/fixtures',{scenario:'new-reader',seed:17},{server})).status,404);
  }
  assert.equal((await h.request('GET','/api/preview/runs',undefined,{server:'pilotGuardBaseURL'})).status,404);
  assert.equal((await h.request('DELETE','/api/test/runs/foreign-run-id')).status,403);
  const control=await h.request('POST','/inspect',{kind:'run',runId:'x'},{server:'controlURL',control:true,privateHeader:false});assert.equal(control.status,403);
  return {ordinaryAndPilotTestGuardDenied:true};
 });
 await test('R2-I11',['R2-AC-001','R2-AC-002','R2-AC-003','R2-E-005','R2-E-006'],async()=>{
  const ordinary=await h.request('POST','/api/preview/runs',{lessonId:'forest-01',lessonVersion:VERSION},{server:'ordinaryBaseURL',privateHeader:false});assert.equal(ordinary.status,201);const id=ordinary.body.runId;assert.equal(ordinary.body.state.soundReview,'pending');
  const ordinaryGet=async()=>{const r=await h.request('GET',`/api/preview/runs/${id}`,undefined,{server:'ordinaryBaseURL',privateHeader:false});assert.equal(r.status,200);return r.body;};
  let v=await ordinaryGet();const r=await h.request('POST',`/api/preview/runs/${id}/actions`,{eventId:randomUUID(),expectedRevision:v.revision,stepId:v.state.stepId,type:'continue',payload:{}},{server:'ordinaryBaseURL',privateHeader:false});assert.equal(r.status,200);v=await ordinaryGet();
  error(await h.request('POST',`/api/preview/runs/${id}/actions`,{eventId:randomUUID(),expectedRevision:v.revision,stepId:v.state.stepId,type:'answer',payload:{questionId:'fam-mu',choiceId:'mu'}},{server:'ordinaryBaseURL',privateHeader:false}),409,'INVALID_TRANSITION');
  assert.deepEqual(await ordinaryGet(),v);
  const v1=await fresh('forest-01-v1');await cont(v1);await answer(v1,'fam-mu','mu');const historical=await get(v1);error(await h.action(v1,historical,'audio-unavailable',{questionId:'fam-mu'}),409,'INVALID_TRANSITION');await unchanged(v1,historical);
  const synthetic=await fresh();await cont(synthetic);await answer(synthetic,'fam-mu','mu');await send(synthetic,'audio-unavailable',{questionId:'fam-mu'});const unavailable=await get(synthetic);assert.equal(unavailable.state.questionStatus,'unavailable');assert.deepEqual(unavailable.events.filter(e=>e.questionId==='fam-mu').map(e=>e.type),['answer','audio-unavailable']);assert.equal(unavailable.recap.familiarity.independentCorrect,0);
  error(await h.action(synthetic,unavailable,'audio-unavailable',{questionId:'fam-mu'}),409,'INVALID_TRANSITION');error(await h.action(synthetic,unavailable,'answer',{questionId:'fam-mu',choiceId:'mu'}),409,'INVALID_TRANSITION');await cont(synthetic);const moved=await get(synthetic);error(await h.action(synthetic,moved,'audio-unavailable',{questionId:'fam-mu'}),409,'INVALID_TRANSITION');await unchanged(synthetic,moved);await db(synthetic);return {ordinaryPendingNoCredit:true,appendOnlyCurrentFailure:true,committedUnavailableNotReopened:true,stalePreviousQuestionRejected:true};
 });
}finally{
 // Retain all synthetic evidence; lead runner owns process/database cleanup.
 try{await prepareHTTP(handoffFile);report.hashes='Source and generated artifact identities match before/after';}catch(e){report.results.push({id:'post-run-identity',status:'FAIL',message:e.message});}
 report.finishedAt=new Date().toISOString();report.runCount=runs.length;
 report.runnerSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
}
if(report.results.some(r=>r.status==='FAIL'))process.exitCode=1;
