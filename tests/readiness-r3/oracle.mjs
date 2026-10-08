// Independent frozen contract oracle. Never imports product scoring/schema code.
export const CONTRACT={spec:'r3-spec-2',integration:'r3-integration-1',lesson:'forest-01-v4',state:'r3-story-run-1',adapterId:'forest-story',adapterVersion:'forest-story-v1',canonicalization:'s3-json-1'};
export const ANSWERS=Object.freeze({'fam-mu':'mu','fam-lin':'lin','find-mu':'mu','find-lin':'lin','check-mu-sound':'mu','check-lin-sound':'lin','check-mu-reading':'audio-mu','check-lin-reading':'audio-lin','review-mu-sound':'mu','review-lin-sound':'lin'});
export const ROUTES=Object.freeze({
 new:{familiarity:[['fam-mu','lin'],['fam-mu','mu'],['fam-lin','mu'],['fam-lin','lin']],panels:['learn-mu','learn-lin'],modes:{mu:'introduction',lin:'introduction'},first:{independentCorrect:0,supported:2,unavailable:0}},
 'mixed-mu':{familiarity:[['fam-mu','mu'],['fam-lin','mu'],['fam-lin','lin']],panels:['learn-mu','learn-lin'],modes:{mu:'reminder',lin:'introduction'},first:{independentCorrect:1,supported:1,unavailable:0}},
 'mixed-lin':{familiarity:[['fam-mu','lin'],['fam-mu','mu'],['fam-lin','lin']],panels:['learn-mu','learn-lin'],modes:{mu:'introduction',lin:'reminder'},first:{independentCorrect:1,supported:1,unavailable:0}},
 familiar:{familiarity:[['fam-mu','mu'],['fam-lin','lin']],panels:['reminder'],modes:{mu:'reminder',lin:'reminder'},first:{independentCorrect:2,supported:0,unavailable:0}},
});
export const CLEAN_FINAL=Object.freeze({total:4,independentCorrect:4,supported:0,unavailable:0,pending:0});
export const HELPED_FINAL=Object.freeze({total:4,independentCorrect:1,supported:2,unavailable:1,pending:0});
export const CLEAN_DELAYED=Object.freeze({total:2,independentCorrect:2,supported:0,unavailable:0,pending:0});
export const DAY_MS=86400000;
export const REQUIRED_SCENARIOS=Object.freeze(['selection','approval','recognition','help','audio-unavailable','restart','duplicate-conflict','delayed-review','progress-export','recovery','ownership','browser-family']);
export const RECEIPT_FIELDS=Object.freeze(['schemaVersion','receiptId','issuerId','issuedAt','candidateId','sourceDigest','artifactDigest','buildId','lessonVersion','contentDigest','canonicalizationVersion','adapterId','adapterVersion','evidenceInstallationId','targetInstallationId','namespace','syntheticOnly','scenarios','reportDigest']);
export const V4_TABLES=Object.freeze([
 'pilot_auth_user','pilot_auth_account','pilot_auth_rate_limit','pilot_parent_child','pilot_teacher_grant','pilot_account_audit','pilot_onboarding','pilot_assignment','pilot_run_ownership','pilot_learning_release','pilot_learning_run','pilot_learning_event','pilot_learning_audit',
 'pilot_curriculum_registry_state','pilot_curriculum_package','pilot_curriculum_character','pilot_curriculum_review','pilot_curriculum_audit','pilot_curriculum_runtime_run','pilot_curriculum_runtime_event','pilot_curriculum_runtime_audit',
 'pilot_curriculum_proof_receipt','pilot_curriculum_owner_decision','pilot_curriculum_publication','pilot_curriculum_trial_member','pilot_curriculum_publication_state','pilot_curriculum_publication_audit','pilot_placement_proposal','pilot_learning_plan','pilot_learning_plan_item','pilot_curriculum_assignment','pilot_learning_schedule','pilot_curriculum_learning_run','pilot_curriculum_learning_event','pilot_curriculum_learning_audit',
]);
