// Mutations are designed independently; the frozen runner will sign disposable
// test receipts only after real suites execute. No uploaded PASS report is signed.
import {REQUIRED_SCENARIOS} from './oracle.mjs';
export function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
export function receiptNegativeCases(valid,now){
 const clone=()=>structuredClone(valid);
 const changed=(field,value)=>({...clone(),[field]:value});
 return [
  {id:'unknown-issuer',receipt:changed('issuerId','qa-unknown-issuer')},
  {id:'future-time',receipt:changed('issuedAt',now+300001)},
  {id:'wrong-purpose',trustMutation:'candidate issuer against ordinary target'},
  {id:'revoked-issuer',trustMutation:'revokedAt before current acceptance'},
  {id:'before-notBefore',trustMutation:'notBefore after issuedAt'},
  ...['candidateId','sourceDigest','artifactDigest','buildId','lessonVersion','contentDigest','canonicalizationVersion','adapterId','adapterVersion','targetInstallationId','namespace','reportDigest'].map(field=>({id:`mismatch-${field}`,receipt:changed(field,field.endsWith('Digest')?'sha256:'+'0'.repeat(64):'qa-mismatch')})),
  {id:'omitted-required',receipt:{...clone(),scenarios:valid.scenarios.filter(s=>s.id!==REQUIRED_SCENARIOS[0])}},
  {id:'unknown-scenario',receipt:{...clone(),scenarios:[...valid.scenarios,{id:'qa-unknown',outcome:'PASS',evidenceDigest:'sha256:'+'0'.repeat(64)}]}},
  {id:'duplicate-scenario',receipt:{...clone(),scenarios:[...valid.scenarios,valid.scenarios[0]]}},
  {id:'failed-scenario',receipt:{...clone(),scenarios:valid.scenarios.map((s,i)=>i? s:{...s,outcome:'FAIL'})}},
  {id:'malformed-signature',signature:'not-an-ed25519-signature'},
  {id:'tampered-signed-bytes',unsignedMutation:'reportDigest after signing'},
  {id:'extra-field',receipt:{...clone(),callerPassed:true}},
 ];
}
