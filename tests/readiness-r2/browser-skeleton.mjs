// Test descriptors only until frozen integration/public-controls handoff.
// Real CDP suite must retain API and libSQL readback; no whole-app interception.
export const browserCases = Object.freeze([
 {id:'R2-B01',route:'new',final:[4,0,0]},
 {id:'R2-B02',route:'mixed-mu',final:[4,0,0]},
 {id:'R2-B03',route:'mixed-lin',final:[4,0,0]},
 {id:'R2-B04',route:'familiar',final:[4,0,0],shorter:true},
 {id:'R2-B05',route:'helped',final:[1,2,1]},
 {id:'R2-B06',probe:'loaded performances and whole-learner quiet suppression'},
 {id:'R2-B07',probe:'start/answer/error/current and stale callback timeline'},
 {id:'R2-B08',probe:'required audio faults and reviewed eligibility'},
 {id:'R2-B09',probe:'layered/static/malformed asset fallback'},
 {id:'R2-B10',probe:'real save/reload/fresh-context and response lost after actual commit'},
 {id:'R2-B11',probe:'storage denied, real server fault, conflicts and repeated retries'},
 {id:'R2-B12',probe:'complete keyboard path'},
 {id:'R2-B13',probe:'targets, contrast, tablet both orientations'},
 {id:'R2-B14',probe:'200% layout zoom and reduced motion'},
 {id:'R2-B15',probe:'v1/six-character/test-guard regressions'},
]);
export function requireBrowserHandoff(manifest){
 if(!manifest.sourceDigest||!manifest.controls||!manifest.controlURL||!manifest.integrationVersion)
  throw Error('BLOCKED: frozen candidate, public controls, SQL readback and integration contract are required');
 return browserCases;
}
