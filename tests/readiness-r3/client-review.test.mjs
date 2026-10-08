// Isolated dependency-boundary probe; not real HTTP/browser evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createStorySession} from '../../lib/pilot-story-client.ts';
await test('locked child controller refuses held conflict readback and later submissions',async()=>{
 const scope={installationId:'qa-install',accountId:'qa-child',childId:'qa-child',publicationId:'qa-publication',contentDigest:'sha256:'+'a'.repeat(64),assignmentId:'qa-assignment'};
 const view={...scope,schemaVersion:'r3-story-view-1',runId:'qa-run',lessonVersion:'forest-01-v4',adapterId:'forest-story',adapterVersion:'forest-story-v1',available:true,revision:0,state:{phase:'initial',stepId:'welcome',questionId:null,questionStatus:null,learnPanel:null,soundReview:'synthetic',attempts:0,hintLevel:0,assisted:false,placedComponents:{left:null,right:null},introPlan:null,readPanel:null,completedAt:null,reviewCompletedAt:null},lesson:{lessonVersion:'forest-01-v4',playback:{}},events:[],recap:{}};
 let release;const held=new Promise(resolve=>{release=resolve;});let reads=0,writes=0;
 const session=createStorySession({scope,verifyIdentity:async()=>true,recovery:{available:()=>true,read:()=>[],write:()=>true,remember:()=>true,lastRun:()=>null},transport:{createRun:async()=>view,getRun:async()=>++reads===1?view:held,sendAction:async()=>{writes++;throw {status:409};}}});
 await session.open(view.runId);const action=session.submit('continue');await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);session.lock();release({...view,revision:2});await action;
 assert.equal(session.snapshot().run,null);assert.equal(session.snapshot().status,'locked');assert.equal(session.snapshot().conflictReady,false);assert.equal(await session.submit('continue'),false);assert.equal(writes,1);
});
