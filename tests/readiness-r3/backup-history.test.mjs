// Independent narrow refusal probes. Pure author fixture is a starting ledger,
// not real DB/recovery/review evidence; independent mutations exercise validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {storyBackupFixture} from '../helpers/story-backup-fixture.mjs';
import {validateStoryRows,validateStorySemantics} from '../../scripts/pilot-story-backup.mjs';
import {canonical} from './receipt-cases.mjs';
const json=v=>JSON.stringify(canonical(v));
const digest=v=>`sha256:${createHash('sha256').update(json(v)).digest('hex')}`;
const invalid=e=>e.code==='BACKUP_STORY_INVALID';
function appendWithdrawal(t,at){
 const old=t.pilot_curriculum_publication[0],row=structuredClone(old),op=JSON.parse(row.request_json);Object.assign(op.request,{requestId:'qa-withdraw',expectedRevision:1,predecessorId:old.id,status:'withdrawn'});
 Object.assign(row,{id:'qa-withdrawn',generation:2,predecessor_id:old.id,request_id:'qa-withdraw',request_json:json(op),request_digest:digest(op),ack_json:json({publicationId:'qa-withdrawn',generation:2,revision:2,status:'withdrawn'}),status:'withdrawn',created_at:at});t.pilot_curriculum_publication.push(row);
 t.pilot_curriculum_trial_member.push({...t.pilot_curriculum_trial_member[0],publication_id:row.id});Object.assign(t.pilot_curriculum_publication_state[0],{revision:2,latest_publication_id:row.id});t.pilot_curriculum_publication_audit.push({id:'qa-withdraw-audit',publication_id:row.id,actor_id:row.actor_id,action:'withdrawn',request_id:row.request_id,created_at:at});
}
function moveAfterBoundary(t,phase,at){
 const p=t.pilot_placement_proposal[0],plan=t.pilot_learning_plan[0],run=t.pilot_curriculum_learning_run[0];
 if(phase==='proposal'){const source=JSON.parse(p.source_json);source.createdAt=at;Object.assign(p,{created_at:at,expires_at:at+86400000,source_json:json(source),source_digest:digest(source)});plan.source_digest=p.source_digest;}
 if(['proposal','approval'].includes(phase)){plan.approved_at=at;t.pilot_curriculum_assignment[0].created_at=at;Object.assign(t.pilot_learning_schedule[0],{created_at:at,due_at:at});t.pilot_curriculum_learning_audit.find(a=>a.action==='plan-approval').created_at=at;}
 if(phase!=='event'){run.created_at=at;const state=JSON.parse(run.run_json);state.createdAt=new Date(at).toISOString();run.run_json=json(state);t.pilot_curriculum_learning_audit.find(a=>a.action==='run-start').created_at=at;}
 const event=t.pilot_curriculum_learning_event[0],eventAt=phase==='event'?at:at+1,result=JSON.parse(event.result_json),state=JSON.parse(run.run_json);event.server_at=eventAt;result.event.serverTime=new Date(eventAt).toISOString();result.ack.state=state.state;state.updatedAt=new Date(eventAt).toISOString();run.updated_at=eventAt;run.run_json=json(state);event.result_json=json(result);t.pilot_curriculum_learning_audit.find(a=>a.action==='run-action').created_at=eventAt;
}
await test('archive later revocation preserves prior receipt; revocation before issue/accept refuses',async()=>{
 const f=await storyBackupFixture(),saved=validateStoryRows(f.payload),at=f.payload.tables.pilot_curriculum_proof_receipt[0].accepted_at;
 await validateStorySemantics(saved,f.archiveIssuers.map(i=>({...i,revokedAt:at+1})));
 await assert.rejects(()=>validateStorySemantics(saved,f.archiveIssuers.map(i=>({...i,revokedAt:at-1}))),invalid);
});
await test('receipt issued before revocation but accepted afterward refuses',async()=>{
 const f=await storyBackupFixture(),saved=validateStoryRows(f.payload),at=saved.receipts[0].row.accepted_at;saved.receipts[0].row.accepted_at=at+2;
 await assert.rejects(()=>validateStorySemantics(saved,f.archiveIssuers.map(i=>({...i,revokedAt:at+1}))),invalid);
});
await test('equal-millisecond event and next generation remains historically possible',async()=>{
 const f=await storyBackupFixture(),t=f.payload.tables;appendWithdrawal(t,t.pilot_curriculum_learning_event[0].server_at);assert.doesNotThrow(()=>validateStoryRows(f.payload));
});
for(const phase of ['proposal','approval','start','event'])await test(`obsolete generation refuses ${phase} strictly after boundary`,async()=>{
 const f=await storyBackupFixture(),t=f.payload.tables,at=t.pilot_curriculum_publication[0].created_at;appendWithdrawal(t,at);moveAfterBoundary(t,phase,at+2);assert.throws(()=>validateStoryRows(f.payload),invalid);
});
await test('later current-review rejection refuses new event after review boundary',async()=>{
 const f=await storyBackupFixture(),t=f.payload.tables,at=t.pilot_curriculum_publication[0].created_at;Object.assign(t.pilot_curriculum_review[0],{recorded_at:at,previous_review_id:null});t.pilot_curriculum_review.push({...t.pilot_curriculum_review[0],review_id:'qa-rejected-review',decision:'rejected',recorded_at:at,previous_review_id:'review'});assert.throws(()=>validateStoryRows(f.payload),invalid);
});
