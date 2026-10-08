// Preparation only. Runtime handoff is required; never default to a family service.
import assert from 'node:assert/strict';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {LESSON,VERSION} from './oracle.mjs';

export async function prepareHTTP(handoffPath){
 const handoff=JSON.parse(await readFile(handoffPath,'utf8'));
 const manifest=JSON.parse(await readFile(handoff.manifest,'utf8'));
 assert.equal(manifest.specVersion,'r2-spec-2');assert.equal(manifest.integrationVersion,'r2-integration-1');
 assert.equal(manifest.lessonVersion,VERSION);assert.equal(handoff.lessonVersion,VERSION);
 assert.equal(handoff.candidateId,manifest.candidateId);assert.equal(handoff.sourceDigest,manifest.digest);
 assert.equal(handoff.snapshot,manifest.snapshot);assert.equal(handoff.testRunId,`${manifest.runId}-node`);
 assert.equal(handoff.sentinelSurvivedAppAndDatabaseRestart,true);assert.equal(handoff.sentinelRemoved,true);
 assert.match(handoff.sqldVersion,/0\.24\.32/);
 const work=await realpath(manifest.work),temporary=await realpath(os.tmpdir());
 assert.equal(work,manifest.work);assert(work.startsWith(`${temporary}${path.sep}`));assert(path.basename(work).startsWith('hanzi-node-'));
 assert.equal(await readFile(path.join(work,'.hanzi-qa-owned'),'utf8'),manifest.runId);
 const snapshot=await realpath(manifest.snapshot);assert.equal(snapshot,path.join(work,'candidate'));
 const state=await realpath(handoff.state);assert.equal(state,handoff.state);assert.equal(path.dirname(state),work);assert(path.basename(state).startsWith('libsql-'));
 assert.equal(manifest.nodeEntry,path.join(snapshot,'.output','server','index.mjs'));
 assert.equal(await realpath(manifest.nodeEntry),manifest.nodeEntry,'Node entry must not escape through a symlink');
 const digest=createHash('sha256');assert(Array.isArray(manifest.files)&&manifest.files.length>0);
 for(const file of manifest.files){
  assert(typeof file==='string'&&!path.isAbsolute(file)&&!file.split('/').some(p=>!p||p==='.'||p==='..'));
  const location=path.join(snapshot,file);assert.equal(await realpath(location),location,'Source symlink rejected');
  const content=await readFile(location);assert.equal(createHash('sha256').update(content).digest('hex'),manifest.fileHashes[file],file);
  digest.update(file).update('\0').update(content).update('\0');
 }
 assert.equal(digest.digest('hex'),manifest.digest);
 const artifact=createHash('sha256');assert(Array.isArray(manifest.artifactFiles)&&manifest.artifactFiles.includes('.output/server/index.mjs'));
 for(const file of manifest.artifactFiles){assert((file.startsWith('.output/')||file==='.openai/hosting.json')&&!file.split('/').includes('..'));if(file==='.openai/hosting.json')assert.deepEqual(JSON.parse(await readFile(path.join(snapshot,file),'utf8')),{d1:'DB',r2:null,project_id:'isolated-readiness-candidate'});const location=path.join(snapshot,file);assert.equal(await realpath(location),location);artifact.update(file).update('\0').update(await readFile(location)).update('\0');}
 assert.equal(artifact.digest('hex'),manifest.artifactDigest,'Built Node artifact identity');
 const urls={};for(const name of ['baseURL','ordinaryBaseURL','pilotGuardBaseURL','controlURL']){
  const u=new URL(handoff[name]);assert.equal(u.protocol,'http:');assert(['127.0.0.1','localhost','[::1]'].includes(u.hostname));urls[name]=u;
 }
 assert.equal(handoff.cdpURL,'http://127.0.0.1:9222');
 const tokenFile=await realpath(handoff.tokenFile);assert.equal(tokenFile,handoff.tokenFile);assert.equal(path.dirname(tokenFile),work);
 assert.equal((await stat(tokenFile)).mode&0o077,0,'Private token file requires restricted permissions');
 const {token}=JSON.parse(await readFile(tokenFile,'utf8'));assert(typeof token==='string'&&token.length>=32);
 let verified=false;
 async function request(method,endpoint,body,{privateHeader=true,server='baseURL',control=false}={}){
  if(method!=='GET')assert(verified,'Identity verification required before writes/control');
  assert(Object.hasOwn(urls,server));assert(endpoint.startsWith(control?'/':'/api/'));
  const headers={accept:'application/json'};if(body!==undefined)headers['content-type']='application/json';if(privateHeader)headers['X-Hanzi-Test-Token']=token;
  const init={method,headers,signal:AbortSignal.timeout(control&&endpoint==='/restart'?50000:25000)};
  if(body!==undefined){assert(!['GET','HEAD'].includes(method),'Read requests cannot have a body');init.body=JSON.stringify(body);}
  const response=await fetch(new URL(endpoint,urls[server]),init);
  assert.match(response.headers.get('cache-control')||'',/(?:^|,\s*)no-store(?:\s*,|$)/i,'Sensitive API response needs no-store');
  let data;try{data=await response.json();}catch{throw Error(`Non-JSON API response at ${endpoint}`);}
  // Never log private headers/token or full private identity/database connection data.
  return {status:response.status,body:data};
 }
 async function verifyIdentity(){
  const r=await request('GET','/api/test/identity');assert.equal(r.status,200);
  assert.equal(r.body.testMode,true);assert.equal(r.body.testRunId,handoff.testRunId);
  assert.equal(r.body.candidateId,handoff.candidateId);assert.equal(r.body.isolatedStorage,true);
  assert.equal(r.body.storageMarker,`preview-test:${handoff.testRunId}`);verified=true;
 }
 return {manifest,handoff,verifyIdentity,request,
  async createRun(version=VERSION){const r=await request('POST','/api/preview/runs',{lessonId:LESSON,lessonVersion:version});assert.equal(r.status,201);return r.body;},
  async getRun(id){const r=await request('GET',`/api/preview/runs/${encodeURIComponent(id)}`);assert.equal(r.status,200);return r.body;},
  async action(id,snapshot,type,payload,eventId=randomUUID()){
   return request('POST',`/api/preview/runs/${encodeURIComponent(id)}/actions`,{eventId,expectedRevision:snapshot.revision,stepId:snapshot.state.stepId,type,payload});
  },
  async inspectRun(runId){return request('POST','/inspect',{kind:'run',runId},{server:'controlURL',control:true});},
  async inspectLegacy(profile){assert(profile.startsWith('qa-legacy-'));return request('POST','/inspect',{kind:'legacy',profile},{server:'controlURL',control:true});},
  async restart(service){assert(['app','database','all'].includes(service));return request('POST','/restart',{service},{server:'controlURL',control:true});},
 };
}
