// Independent real UI → Node HTTP → libSQL suite, pending frozen runtime execution.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connectOwnedChrome} from '../../scripts/owned-cdp.mjs';
import {prepareHTTP} from './http-harness.mjs';
import {browserSpeechFixture} from './speech-boundary.mjs';
import {ROUTES,FINAL_CLEAN,FINAL_HELPED,CORRECT} from './oracle.mjs';
if(!process.argv[2])throw Error('Frozen runtime handoff required');
const h=await prepareHTTP(process.argv[2]);await h.verifyIdentity();
const connection=await connectOwnedChrome(h.handoff.cdpURL),browser=connection.browser;
const base=new URL(h.handoff.baseURL);
const runLabel=process.env.R2_QA_RUN_LABEL||'independent-browser';assert(/^[a-z0-9-]+$/.test(runLabel));
const selected=new Set((process.env.R2_QA_CASES||'').split(',').filter(Boolean));
const output=path.join(h.handoff.output,runLabel);await mkdir(output,{recursive:true});
const report={candidate:h.manifest.candidateId,digest:h.manifest.digest,browser:browser.version(),spec:'r2-integration-1',speech:'Injected local Mandarin browser start/end/error/cancel; no real listening',results:[],pending:['Mandarin/content/audio review','Physical iPad','Motion fidelity/friendliness','Owner exact-build acceptance','Hosted Turso networking']};
async function scenario(name,ids,fn,options={}){
 if(selected.size&&!selected.has(name))return;
 const context=await browser.newContext({viewport:options.viewport||{width:1440,height:900},reducedMotion:options.reducedMotion||'no-preference'});context.setDefaultTimeout(8000);context.setDefaultNavigationTimeout(20000);
 await context.addInitScript(browserSpeechFixture);
 if(options.storageDenied)await context.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('QA storage denied','SecurityError');};});
 const activeBase=options.server==='ordinary'?new URL(h.handoff.ordinaryBaseURL):base;
 const page=await context.newPage(),requests=[],violations=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url());if(['data:','blob:'].includes(u.protocol))return route.continue();
  const api=u.pathname.startsWith('/api/');requests.push({method:r.method(),path:u.pathname});
  if(u.origin!==activeBase.origin||(api&&!u.pathname.startsWith('/api/preview/'))||!['GET','HEAD','POST'].includes(r.method())){violations.push({method:r.method(),path:u.pathname,origin:u.origin});return route.abort();}
  if(options.failSvg&&u.pathname.endsWith('mascot-layered.svg'))return route.fulfill({status:404,body:'QA missing vector'});
  if(options.malformedSvg&&u.pathname.endsWith('mascot-layered.svg'))return route.fulfill({status:200,contentType:'image/svg+xml',body:'<not-svg>invalid'});
  if(options.failRaster&&u.pathname.endsWith('capybara-welcome-v6.png'))return route.fulfill({status:404,body:'QA missing static'});
  return route.continue();
 });
 const main=()=>page.locator('main[data-step]');
 const control=name=>page.locator(`[data-control="${name}"]`);
 const at=step=>page.locator(`main[data-step="${step}"]`).waitFor();
 const saved=()=>page.locator('[data-save-state="saved"]').waitFor();
 const runId=()=>main().getAttribute('data-run-id');
 async function key(selector,key='Enter'){
  for(let i=0;i<100;i++){if(await page.evaluate(s=>document.activeElement?.matches(s),selector)){const f=await page.evaluate(()=>{const s=getComputedStyle(document.activeElement);return {style:s.outlineStyle,width:parseFloat(s.outlineWidth)};});assert(f.style!=='none'&&f.width>0,'Visible keyboard focus');await page.keyboard.press(key);return;}await page.keyboard.press('Tab');}
  throw Error(`Keyboard unreachable ${selector}`);
 }
 async function act(selector,{keyboard=false,keyName='Enter'}={}){
  const ack=page.waitForResponse(r=>r.request().method()==='POST'&&/\/api\/preview\/runs\/[^/]+\/actions$/.test(new URL(r.url()).pathname));
  if(keyboard)await key(selector,keyName);else await page.locator(selector).click();
  const response=await ack;assert.equal(response.status(),200);await saved();return response.json();
 }
 const next=keyboard=>act('main [data-control="continue"]',{keyboard});
 async function start(keyboard=false){
  const created=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/preview/runs');
  if(keyboard)await key('[data-control="create-run"]');else await control('create-run').click();
  const response=await created;assert.equal(response.status(),201);await at('welcome');await saved();
  assert(await control('continue').isDisabled(),'Explicit sound response required');
  if(keyboard){await key('[data-control="sound-check"]','Space');await key('[data-control="sound-heard"]','Space');}else{await control('sound-check').click();await control('sound-heard').click();}
  await next(keyboard);await at('familiarity');return runId();
 }
 async function cue(q,keyboard=false){
  const selector=`[data-question-id="${q}"] [data-control="cue"]`;
  const count=await page.evaluate(()=>window.__r2Speech.started.length);
  if(keyboard)await key(selector,'Space');else await page.locator(selector).click();
  await page.waitForFunction(n=>window.__r2Speech.started.length>n,count);
 }
 async function answer(q,c,keyboard=false){
  if(c==='audio-unavailable')return act('[data-control="unavailable"]',{keyboard});
  if(c.startsWith('audio-')){
   const selector=`[data-question-id="${q}"] [data-control="option-play"][data-option-id="${c}"]`;
   const n=await page.evaluate(()=>window.__r2Speech.started.length);if(keyboard)await key(selector,'Space');else await page.locator(selector).click();await page.waitForFunction(x=>window.__r2Speech.started.length>x,n);
  }else if(!q.startsWith('find-'))await cue(q,keyboard);
  return act(`[data-question-id="${q}"] [data-choice-id="${c}"]`,{keyboard});
 }
 async function familiarity(route,keyboard=false){
  for(const[q,c]of ROUTES[route].familiarity){await answer(q,c,keyboard);const v=await h.getRun(await runId());if(v.state.questionStatus!=='open')await next(keyboard);}
  await at('learn');const targets=new Map(),panels=[];
  while((await main().getAttribute('data-step'))==='learn'){
   const panel=page.locator('[data-learn-panel]');panels.push(await panel.getAttribute('data-learn-panel'));
   for(const item of await page.locator('[data-target][data-learning-mode]').all())targets.set(await item.getAttribute('data-target'),await item.getAttribute('data-learning-mode'));
   assert(panels.length<=2);await next(keyboard);
  }
  assert.deepEqual(panels,route==='familiar'?['reminder']:['learn-mu','learn-lin']);assert.deepEqual(Object.fromEntries(targets),ROUTES[route].modes);await at('build');
 }
 async function activities(keyboard=false){
  await act('[data-piece-id="mu-a"][data-slot="left"]',{keyboard,keyName:'Space'});assert(await control('continue').isDisabled());
  await act('[data-piece-id="mu-b"][data-slot="right"]',{keyboard,keyName:'Space'});await next(keyboard);
  for(const q of ['find-mu','find-lin']){await answer(q,CORRECT[q],keyboard);assert.match(await main().innerText(),/ordinary print/i);await next(keyboard);}
  await at('read');assert.match(await main().innerText(),/这是木头。/);await next(keyboard);assert.match(await main().innerText(),/小鸟住在树林里。/);await next(keyboard);await at('check');
 }
 async function finals(helped=false,keyboard=false){
  if(helped){await answer('check-mu-sound','lin',keyboard);await answer('check-mu-sound','ren',keyboard);}else await answer('check-mu-sound','mu',keyboard);await next(keyboard);
  await answer('check-lin-sound','lin',keyboard);await next(keyboard);
  if(helped)await act('[data-control="help"]',{keyboard});await answer('check-mu-reading','audio-mu',keyboard);await next(keyboard);
  await answer('check-lin-reading',helped?'audio-unavailable':'audio-lin',keyboard);await next(keyboard);await at('recap');await saved();
  const id=await runId();const v=await h.getRun(id);assert.deepEqual(v.recap.final,helped?FINAL_HELPED:FINAL_CLEAN);await readback(id);return v;
 }
 async function readback(id){const sql=await h.inspectRun(id);assert.equal(sql.status,200);const v=await h.getRun(id);assert.equal(sql.body.run.revision,v.revision);assert.deepEqual(JSON.parse(sql.body.run.state_json),v.state);assert.deepEqual(sql.body.events.map(e=>e.event_id),v.events.map(e=>e.eventId));return sql.body;}
 async function quiet(){
  assert.equal(await page.getByRole('complementary',{name:'Teaching companion'}).count(),0);assert.equal(await control('companion-performance').count(),0);
  assert.equal(await control('review-page').count(),0);assert.equal(await page.locator('[data-motion="playing"]').count(),0);
  const text=await page.locator('body').innerText();assert.doesNotMatch(text,/木头的木|树林的林|mù|lín|tree character|two trees|Expected categories/i);
  assert.equal(await page.locator('main img,main svg').count(),0);
 }
 try{
  await page.goto(new URL('/preview/shade-01',activeBase).href);await fn({page,context,main,control,at,saved,runId,key,act,next,start,cue,answer,familiarity,activities,finals,readback,quiet});
  assert.deepEqual(violations,[]);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,`${name}.png`),fullPage:true});
  report.results.push({name,ids,status:'PASS',requests});console.log(`${name}: PASS`);
 }catch(e){await page.screenshot({path:path.join(output,`${name}-failure.png`),fullPage:true}).catch(()=>{});report.results.push({name,ids,status:'FAIL',message:e.stack,requests,violations,errors});console.log(`${name}: FAIL ${e.message}`);}
 finally{await context.close();}
}
try{
 for(const route of Object.keys(ROUTES))await scenario(`route-${route}`,['R2-B01–04','R2-E-002','R2-E-003','R2-E-007'],async s=>{await s.start();await s.familiarity(route);await s.activities();const v=await s.finals();assert.deepEqual(v.recap.familiarity,{total:2,...ROUTES[route].firstLook,pending:0});});
 await scenario('route-helped',['R2-B05','R2-E-003'],async s=>{await s.start();await s.familiarity('new');await s.activities();await s.finals(true);});
 await scenario('keyboard-complete',['R2-B12','R2-E-013'],async s=>{await s.start(true);await s.familiarity('familiar',true);await s.activities(true);await s.finals(false,true);});
 await scenario('help-first-wrong-and-quiet',['R2-B06','R2-E-003','R2-E-008'],async s=>{await s.start();await s.familiarity('familiar');await s.activities();await s.quiet();await s.act('[data-control="help"]');await s.answer('check-mu-sound','lin');assert.equal((await h.getRun(await s.runId())).state.questionStatus,'open');await s.answer('check-mu-sound','ren');assert.equal((await h.getRun(await s.runId())).state.questionStatus,'demonstrated');await s.next();await s.quiet();await s.readback(await s.runId());});
 await scenario('mute-clears-readiness',['R2-B08','R2-E-004','R2-E-005'],async s=>{
  await s.start();await s.page.evaluate(()=>{window.__r2Speech.mode='hold';});await s.cue('fam-mu');assert(!(await s.page.locator('[data-choice-id="mu"]').isDisabled()));
  await s.control('mute').click();assert(await s.page.locator('[data-choice-id="mu"]').isDisabled());assert.equal(await s.page.evaluate(()=>window.__r2Speech.active.length),0);await s.answer('fam-mu','audio-unavailable');const v=await h.getRun(await s.runId());assert.equal(v.recap.familiarity.independentCorrect,0);assert.equal(v.recap.familiarity.unavailable,1);await s.next();await s.readback(await s.runId());
 });
 await scenario('late-audio-failure-append-and-stale',['R2-B07','R2-E-005','R2-E-012'],async s=>{
  await s.start();await s.familiarity('familiar');await s.activities();await s.page.evaluate(()=>{window.__r2Speech.mode='hold';});await s.answer('check-mu-sound','mu');
  const pending=s.page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.type==='audio-unavailable');
  await s.page.evaluate(()=>window.__r2Speech.fail(window.__r2Speech.utterances.length-1));assert.equal((await pending).status(),200);await s.saved();
  const id=await s.runId(),v=await h.getRun(id);assert.equal(v.state.questionStatus,'unavailable');assert.deepEqual(v.events.filter(e=>e.questionId==='check-mu-sound').map(e=>e.type),['answer','audio-unavailable']);await s.next();await s.answer('check-lin-sound','lin');const stale=await s.page.evaluate(()=>window.__r2Speech.utterances.length-1);await s.next();await s.page.evaluate(i=>window.__r2Speech.fail(i),stale);await s.page.evaluate(()=>{window.__r2Speech.mode='normal';});await s.answer('check-mu-reading','audio-mu');await s.next();await s.answer('check-lin-reading','audio-lin');await s.next();await s.at('recap');const done=await h.getRun(id);assert.deepEqual(done.recap.final,{total:4,independentCorrect:3,supported:0,unavailable:1,pending:0});await s.readback(id);
 });
 for(const mode of ['missing','remote','cantonese','throw','error','timeout'])await scenario(`audio-${mode}`,['R2-B08','R2-E-004','R2-E-011'],async s=>{await s.start();await s.page.evaluate(x=>{window.__r2Speech.mode=x;},mode);assert(await s.page.locator('[data-choice-id="mu"]').isDisabled());await s.control('cue').click();await s.page.locator('[data-audio-status="unavailable"]').waitFor({timeout:12000});assert(await s.page.locator('[data-choice-id="mu"]').isDisabled());await s.answer('fam-mu','audio-unavailable');assert.equal((await h.getRun(await s.runId())).state.questionStatus,'unavailable');await s.next();await s.quiet();await s.readback(await s.runId());});
 for(const fault of [{name:'vector404',failSvg:true},{name:'malformed-vector',malformedSvg:true},{name:'vector-and-static404',failSvg:true,failRaster:true}])await scenario(`art-${fault.name}`,['R2-B09','R2-E-011'],async s=>{await s.start();await s.familiarity('familiar');await s.page.locator('[data-motion="fallback"]').waitFor();if(fault.failRaster)assert.match(await s.page.getByRole('complementary',{name:'Teaching companion'}).innerText(),/Follow the activity instructions/);await s.activities();await s.quiet();},fault);
 await scenario('saved-panel-and-fresh-context',['R2-B10','R2-E-002','R2-E-009'],async s=>{
  await s.start();for(const[q,c]of ROUTES.new.familiarity){await s.answer(q,c);if((await h.getRun(await s.runId())).state.questionStatus!=='open')await s.next();}
  const id=await s.runId();await s.at('learn');assert.equal(await s.page.locator('[data-learn-panel]').getAttribute('data-learn-panel'),'learn-mu');await s.page.reload();await s.control('resume-run').click();await s.at('learn');assert.equal(await s.page.locator('[data-learn-panel]').getAttribute('data-learn-panel'),'learn-mu');await s.next();await s.page.reload();await s.control('resume-run').click();await s.at('learn');assert.equal(await s.page.locator('[data-learn-panel]').getAttribute('data-learn-panel'),'learn-lin');await s.readback(id);
  const isolated=await browser.newContext();try{const another=await isolated.newPage();another.setDefaultTimeout(8000);await another.goto(new URL('/preview/shade-01',base).href);await another.getByText('Saved stories for this version',{exact:true}).click();await another.locator(`[data-control="open-run"][data-run-id="${id}"]`).click();await another.locator('[data-learn-panel="learn-lin"]').waitFor();}finally{await isolated.close();}
 });
 await scenario('lost-response-real-commit-refresh',['R2-B10','R2-E-009','R2-E-010'],async s=>{
  await s.start();const id=await s.runId();await s.cue('fam-mu');let dropped=null;
  await s.context.route('**/api/preview/runs/*/actions',async r=>{if(!dropped&&r.request().postDataJSON()?.type==='answer'){dropped=r.request().postDataJSON();const actual=await r.fetch();assert.equal(actual.status(),200);await r.abort('failed');}else await r.continue();});
  await s.page.locator('[data-choice-id="mu"]').click();await s.page.locator('[data-save-state="pending"]').waitFor();assert(dropped);const committed=await h.getRun(id);assert.equal(committed.events.filter(e=>e.eventId===dropped.eventId).length,1);
  await s.page.reload();await s.control('resume-run').click();await s.page.locator('[data-save-state="pending"]').waitFor();
  const pending=await s.page.evaluate(run=>JSON.parse(localStorage.getItem(`little-hanzi:preview:forest-01:forest-01-v3:${run}:outbox`)||'[]'),id);assert.equal(pending.length,1);assert.equal(pending[0].eventId,dropped.eventId,'Recovered outbox retains exact lost-response event');
  await s.control('retry-save').click();await s.saved();const after=await h.getRun(id);assert.equal(after.events.filter(e=>e.eventId===dropped.eventId).length,1);assert.equal(after.revision,committed.revision);await s.readback(id);
 });
 await scenario('recap-readback-failure-retry-get-only', ['R2-B10','R2-E-009','R2-E-010'],async s=>{
  await s.start();await s.familiarity('familiar');await s.activities();
  for(const q of ['check-mu-sound','check-lin-sound','check-mu-reading']){await s.answer(q,CORRECT[q]);await s.next();}
  await s.answer('check-lin-reading','audio-lin');const id=await s.runId();let failed=false;
  await s.context.route(`**/api/preview/runs/${id}`,async route=>{if(!failed&&route.request().method()==='GET'){failed=true;return route.fulfill({status:503,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify({error:{code:'STORAGE_UNAVAILABLE',message:'QA named report readback interruption'}})});}return route.continue();});
  const ack=s.page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.type==='continue');await s.control('continue').click();assert.equal((await ack).status(),200);
  await s.page.locator('[data-save-state="readback-pending"]').waitFor();assert.equal(await s.page.locator('[data-evidence-group]').count(),0,'No report before authoritative completion readback');
  const before=await h.getRun(id);assert(before.state.completedAt);const observed=[];s.page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/preview/'))observed.push({method:r.method(),path:new URL(r.url()).pathname});});
  await s.control('retry-report').click();await s.saved();await s.page.locator('[data-evidence-group="final"]').waitFor();assert(observed.every(r=>r.method==='GET'),'Retry report cannot write answers');assert.deepEqual(await h.getRun(id),before);await s.readback(id);
 });
 await scenario('separate-delayed-review-browser', ['R2-B06','R2-B10','R2-E-008','R2-E-015'],async s=>{
  await s.start();await s.familiarity('familiar');await s.activities();const initial=await s.finals();const id=await s.runId();
  assert.equal((await h.request('POST',`/api/test/runs/${id}/clock`,{effectiveTime:initial.reviewAvailableAt})).status,200);
  await s.control('refresh-run').click();await s.control('start-review').waitFor();await s.act('[data-control="start-review"]');await s.at('delayed-review');await s.quiet();
  for(const q of ['review-mu-sound','review-lin-sound']){await s.answer(q,CORRECT[q]);await s.next();}
  await s.at('recap');await s.saved();const after=await h.getRun(id);assert.deepEqual(after.recap.final,initial.recap.final);assert.deepEqual(after.recap.delayed,{total:2,independentCorrect:2,supported:0,unavailable:0,pending:0});await s.readback(id);
 });
 await scenario('real-server-storage-fault-retry',['R2-B11','R2-E-010'],async s=>{
  await s.start();const id=await s.runId();await s.cue('fam-mu');const before=await h.getRun(id);let enabled=false;
  try{assert.equal((await h.request('POST','/api/test/fault',{operation:'storage',enabled:true})).status,200);enabled=true;await s.page.locator('[data-choice-id="mu"]').click();await s.page.locator('[data-save-state="pending"]').waitFor();assert.deepEqual(await h.getRun(id),before);}
  finally{if(enabled)await h.request('POST','/api/test/fault',{operation:'storage',enabled:false});}
  await s.control('retry-save').click();await s.saved();assert.equal((await h.getRun(id)).events.filter(e=>e.type==='answer'&&e.questionId==='fam-mu').length,1);await s.readback(id);
 });
 await scenario('stale-write-conflict-refetch', ['R2-B11','R2-E-010'],async s=>{
  await s.start();const id=await s.runId();await s.cue('fam-mu');const before=await h.getRun(id);assert.equal((await h.action(id,before,'hint',{questionId:'fam-mu'})).status,200);
  await s.page.locator('[data-choice-id="mu"]').click();await s.page.locator('[data-save-state="conflict"]').waitFor();
  assert.equal((await h.getRun(id)).events.filter(e=>e.type==='answer'&&e.questionId==='fam-mu').length,0,'No silently rebased answer');
  await s.control('accept-conflict').click();await s.saved();await s.answer('fam-mu','mu');assert.equal((await h.getRun(id)).recap.familiarity.supported,1);await s.readback(id);
 });
 await scenario('ordinary-pending-media-no-credit', ['R2-B08','R2-E-006'],async s=>{
  const id=await s.start();await s.cue('fam-mu');assert(await s.page.locator('[data-choice-id="mu"]').isDisabled(),'Pending ordinary review cannot be bypassed by speech start');
  await s.answer('fam-mu','audio-unavailable');const db=await h.inspectRun(id);assert.equal(db.status,200);const row=db.body.run;assert.equal(JSON.parse(row.state_json).soundReview,'pending');assert.deepEqual(db.body.events.filter(e=>e.question_id==='fam-mu').map(e=>e.type),['audio-unavailable']);
 },{server:'ordinary'});
 await scenario('browser-storage-denied',['R2-B11','R2-E-010'],async s=>{await s.start();assert.match(await s.page.locator('body').innerText(),/Browser recovery is unavailable.*Reload may lose an unsent action/s);await s.answer('fam-mu','mu');await s.next();await s.readback(await s.runId());},{storageDenied:true});
 for(const viewport of [{width:1440,height:900},{width:1024,height:768},{width:768,height:1024},{width:390,height:844}])await scenario(`targets-${viewport.width}x${viewport.height}`,['R2-B13','R2-E-013'],async s=>{
  await s.start();await s.familiarity('familiar');
  const errors=await s.page.evaluate(()=>[...document.querySelectorAll('button,input,select,a')].filter(e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return !e.disabled&&r.width&&r.height&&style.visibility!=='hidden'&&r.right>0&&r.bottom>0;}).flatMap(e=>{const r=(e.matches('input[type=checkbox],input[type=radio]')?e.closest('label')||e:e).getBoundingClientRect();return r.width<44||r.height<44||r.left<0||r.right>innerWidth?[{label:e.textContent||e.getAttribute('aria-label'),width:r.width,height:r.height,left:r.left,right:r.right}]:[];}));assert.deepEqual(errors,[]);await s.activities();await s.quiet();
 },{viewport});
 await scenario('review-manifest-and-v1-isolation', ['R2-B15','R2-E-001','R2-E-014','R2-E-016'],async s=>{
  const old=await h.createRun('forest-01-v1'),before=await h.getRun(old.runId);
  const oldKey='little-hanzi:forest:last-run';await s.page.evaluate(({key,id})=>localStorage.setItem(key,id),{key:oldKey,id:old.runId});
  await s.page.reload();assert.equal(await s.page.locator(`[data-control="open-run"][data-run-id="${old.runId}"]`).count(),0);await s.start();assert.equal(await s.page.evaluate(key=>localStorage.getItem(key),oldKey),old.runId);assert.deepEqual(await h.getRun(old.runId),before);
  await s.page.goto(new URL('/preview/shade-01/review',base).href);
  const inventory=JSON.parse(await s.page.locator('#story-review-manifest').innerText());
  const resource=await s.context.request.get(new URL('/story/forest-01-v3/review-manifest.json',base).href);assert.equal(resource.status(),200);assert.deepEqual(await resource.json(),inventory);
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
  const body={...inventory};delete body.digest;assert.equal(`sha256:${createHash('sha256').update(JSON.stringify(canonical(body)),'utf8').digest('hex')}`,inventory.digest);
  const text=JSON.stringify(inventory);assert.match(text,/forest-01-v3/);assert.match(text,/forest-story-preview-v1/);
  for(const transcript of ['你好','木头的木','树林的林','木头','树林','这是木头。','小鸟住在树林里。'])assert(text.includes(transcript),`Missing reviewed transcript inventory ${transcript}`);
  assert.match(await s.page.locator('body').innerText(),/pending/i);
  await s.page.goto(new URL(`/preview/forest-01?runId=${encodeURIComponent(old.runId)}`,base).href);await s.page.locator('[data-step-id="welcome"]').waitFor();assert.match(await s.page.locator('body').innerText(),/Build a little forest/);assert.deepEqual(await h.getRun(old.runId),before);
 });
 await scenario('rendered-css-contrast', ['R2-B13','R2-E-013'],async s=>{
  await s.start();await s.familiarity('familiar');
  const pairs=await s.page.evaluate(()=>{
   const parse=color=>{const n=color.match(/[\d.]+/g)?.map(Number)||[];return n.length>=3?{rgb:n.slice(0,3),alpha:n.length>3?n[3]:1}:null;};
   const bg=e=>{for(let node=e;node;node=node.parentElement){const color=parse(getComputedStyle(node).backgroundColor);if(color&&color.alpha===1)return color.rgb;}return [255,255,255];};
   return [...document.querySelectorAll('main h1,main h2,main p,main button,header a,[data-save-state]')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&!e.disabled&&getComputedStyle(e).visibility!=='hidden';}).map(e=>({text:e.textContent.trim().slice(0,60),foreground:parse(getComputedStyle(e).color)?.rgb,background:bg(e),fontSize:getComputedStyle(e).fontSize}));
  });
  const lum=rgb=>rgb.map(n=>{const s=n/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
  for(const p of pairs){assert(p.foreground);const a=lum(p.foreground),b=lum(p.background);p.ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert(p.ratio>=4.5,`Rendered CSS text contrast ${p.text}: ${p.ratio}`);}
  await writeFile(path.join(output,'rendered-contrast.json'),JSON.stringify({method:'Computed rendered CSS foreground and nearest opaque ancestor background, not pixel/gradient sampling or accessibility certification',pairs},null,2));
 });
 await scenario('served-client-answer-boundary',['R2-B15','R2-E-014'],async s=>{
  await s.start();await s.familiarity('familiar');await s.activities();
  const resources=await s.page.evaluate(()=>[...new Set([...document.scripts].map(x=>x.src).filter(Boolean).concat(performance.getEntriesByType('resource').map(x=>x.name).filter(x=>/\.m?js(?:\?|$)/.test(x))))]);
  assert(resources.length>0,'Actual served client JavaScript inventory');
  const payloads=[{url:s.page.url(),text:await s.page.content()}];
  for(const url of resources){assert.equal(new URL(url).origin,base.origin);const response=await s.context.request.get(url);assert.equal(response.status(),200);payloads.push({url,text:await response.text()});}
  const evidence=[];
  for(const payload of payloads){
   const decoded=payload.text.replace(/\\"/g,'"');
   // A generic schema label is not an answer. Reject literal authoritative
   // field/value associations and explicit question-ID keyed answer tables.
   const keyed=/(?:["']?(?:correctChoiceId|correctAnswer|answerKey)["']?)\s*:\s*["'](?:mu|lin|ren|audio-mu|audio-lin|audio-ren)["']/;
   assert(!keyed.test(decoded),`Authoritative answer value in served payload ${new URL(payload.url).pathname}`);
   for(const[q,answer]of Object.entries(CORRECT)){
    const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    assert(!new RegExp(`["']${escaped}["']\\s*:\\s*["']${answer}["']`).test(decoded),`Question-keyed answer table ${q}`);
   }
   evidence.push({path:new URL(payload.url).pathname,bytes:Buffer.byteLength(payload.text),sha256:createHash('sha256').update(payload.text).digest('hex')});
  }
  await writeFile(path.join(output,'served-client-boundary.json'),JSON.stringify({method:'Actual story DOM and all served script/module resource bodies; literal authoritative field/value and question-keyed table checks. Generic schema labels alone are not leaks; this is not a proof against arbitrary obfuscation.',payloads:evidence},null,2));
 });
 await scenario('zoom200-teaching-check-recap',['R2-B14','R2-E-013'],async s=>{
  await s.start();
  for(const[q,c]of ROUTES.familiar.familiarity){await s.answer(q,c);await s.next();}
  await s.at('learn');
  async function zoom(name){await s.page.evaluate(()=>{document.documentElement.style.zoom='2';});const ok=await s.page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth);assert(ok,`${name} CSS200% zoom overflow`);await s.page.screenshot({path:path.join(output,`zoom-${name}.png`),fullPage:true});await s.page.evaluate(()=>{document.documentElement.style.zoom='';});}
  await zoom('teaching');await s.next();await s.at('build');await s.activities();await zoom('quiet-check');await s.finals();await zoom('recap');
 });
 await scenario('reduced-motion-and-navigation',['R2-B07','R2-B14','R2-E-012'],async s=>{
  await s.start();await s.familiarity('familiar');await s.page.locator('[data-motion="rest"]').waitFor();await s.control('companion-performance').click();await s.page.locator('[data-motion="playing"]').waitFor();
  await s.page.evaluate(()=>{window.__r2MotionDelivered=false;matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{if(e.matches)window.__r2MotionDelivered=true;},{once:true});});await s.page.emulateMedia({reducedMotion:'reduce'});await s.page.waitForFunction(()=>window.__r2MotionDelivered);assert.equal(await s.page.locator('[data-motion="playing"]').count(),0);await s.activities();await s.quiet();await s.finals();
 });
}finally{
 try{await prepareHTTP(process.argv[2]);report.hashes='Source and generated artifact identities match before/after';}catch(e){report.results.push({name:'post-run-identity',status:'FAIL',message:e.message});}
 report.finishedAt=new Date().toISOString();report.runnerSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');report.zoomMethod='Chromium CSS layout zoom documentElement.style.zoom=2 at1440×900; not native browser setting or physical device';
 report.cdpHelperSha256=createHash('sha256').update(await readFile(new URL('../../scripts/owned-cdp.mjs',import.meta.url))).digest('hex');report.cdpOwnership=connection.metadata;report.environmentCorrection='Owned native CDP transport avoids attaching existing unresponsive pages; original two attachment timeouts retained. App candidate unchanged.';
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
 connection.disconnect();
}
// Close only owned contexts; never browser.close or existing user tabs.
process.exit(report.results.some(x=>x.status==='FAIL')?1:0);
