-- DRAFT r6-data-2 / r6-proof-1. Exact source review/checksum approval required BEFORE any execution.

-- Add23 tables,22 historical domain tables plus fresh evidence epoch. Old0000-0006 unchanged.

PRAGMA foreign_keys = ON;



CREATE TABLE IF NOT EXISTS pilot_corpus_proof_receipt (
  id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  issuer_id TEXT NOT NULL,
  receipt_version TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=71 AND substr(receipt_digest,1,7)='sha256:' AND substr(receipt_digest,8) NOT GLOB '*[^0-9a-f]*'),
  signature TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK(issued_at>=0),
  received_by TEXT NOT NULL,
  received_at INTEGER NOT NULL CHECK(received_at>=0),
  installation_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(id,corpus_version,lesson_version,content_digest),
  CHECK(receipt_version='r6-proof-receipt-1'),
  CHECK(COALESCE(json_extract(receipt_json,'$.schemaVersion')=receipt_version AND json_extract(receipt_json,'$.policyVersion')='r6-corpus-proof-1' AND json_type(receipt_json,'$.syntheticOnly')='true',0)),
  CHECK(COALESCE(json_extract(receipt_json,'$.receiptId')=id AND json_extract(receipt_json,'$.issuerId')=issuer_id AND json_extract(receipt_json,'$.namespace')=namespace,0)),
  CHECK(COALESCE(json_extract(receipt_json,'$.corpusVersion')=corpus_version AND json_extract(receipt_json,'$.corpusDigest')=corpus_digest AND json_extract(receipt_json,'$.lessonVersion')=lesson_version AND json_extract(receipt_json,'$.contentDigest')=content_digest AND json_extract(receipt_json,'$.targetInstallationId')=installation_id,0)),
  FOREIGN KEY(corpus_version,corpus_digest) REFERENCES pilot_corpus(corpus_version,corpus_digest),
  FOREIGN KEY(corpus_version,lesson_version,content_digest) REFERENCES pilot_corpus_item(corpus_version,lesson_version,content_digest),
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest),
  FOREIGN KEY(received_by) REFERENCES pilot_auth_user(id)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_source_evidence (
  id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  classification TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  supersedes_id TEXT,
  source_ordinal INTEGER NOT NULL CHECK(source_ordinal>=0),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71 AND substr(source_digest,1,7)='sha256:' AND substr(source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'),
  attribution_json TEXT NOT NULL CHECK(json_valid(attribution_json)),
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(id,lesson_version,content_digest),
  UNIQUE(id,lesson_version,content_digest,lineage_id),
  UNIQUE(lesson_version,content_digest,evidence_digest),
  UNIQUE(lineage_id,source_ordinal),
  UNIQUE(supersedes_id),
  CHECK(COALESCE(json_type(request_json,'$.resourceId')='text' AND length(json_extract(request_json,'$.resourceId')) BETWEEN 1 AND 120,0)),
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest),
  FOREIGN KEY(supersedes_id,lesson_version,content_digest,lineage_id) REFERENCES pilot_corpus_source_evidence(id,lesson_version,content_digest,lineage_id),
  CHECK(classification IN ('verification-fixture','unverified-draft','real-source-reviewed')),
  CHECK((source_ordinal=1 AND supersedes_id IS NULL AND lineage_id=id) OR (source_ordinal>1 AND supersedes_id IS NOT NULL))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_batch (
  id TEXT NOT NULL,
  batch_version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=71 AND substr(manifest_digest,1,7)='sha256:' AND substr(manifest_digest,8) NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(batch_version),
  CHECK(COALESCE(json_type(request_json,'$.resourceId')='text' AND length(json_extract(request_json,'$.resourceId')) BETWEEN 1 AND 120,0))
);


CREATE TABLE IF NOT EXISTS pilot_corpus (
  corpus_version TEXT NOT NULL,
  corpus_id TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  policy_version TEXT NOT NULL,
  imported_by TEXT NOT NULL REFERENCES pilot_auth_user(id),
  imported_at INTEGER NOT NULL CHECK(imported_at>=0),
  PRIMARY KEY(corpus_version),
  UNIQUE(corpus_version,corpus_digest),
  CHECK(policy_version='r6-corpus-policy-1')
);


CREATE TABLE IF NOT EXISTS pilot_corpus_item (
  corpus_version TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  batch_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  title TEXT NOT NULL,
  display_json TEXT NOT NULL CHECK(json_valid(display_json)),
  search_digest TEXT NOT NULL CHECK(length(search_digest)=71 AND substr(search_digest,1,7)='sha256:' AND substr(search_digest,8) NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(corpus_version,ordinal),
  UNIQUE(corpus_version,lesson_version,content_digest),
  UNIQUE(corpus_version,lesson_version),
  FOREIGN KEY(corpus_version) REFERENCES pilot_corpus(corpus_version),
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest),
  FOREIGN KEY(batch_id) REFERENCES pilot_corpus_batch(id),
  CHECK(adapter_id='corpus-paired' AND adapter_version='corpus-paired-v1'),
  CHECK(ordinal BETWEEN 0 AND 999999 AND sequence BETWEEN 1 AND 1000000)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_character (
  corpus_version TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  character_id TEXT NOT NULL,
  target_index INTEGER NOT NULL CHECK(target_index>=0),
  coverage_identity TEXT NOT NULL,
  identity_version TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  requirements_digest TEXT NOT NULL CHECK(length(requirements_digest)=71 AND substr(requirements_digest,1,7)='sha256:' AND substr(requirements_digest,8) NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(corpus_version,lesson_version,target_index),
  UNIQUE(corpus_version,lesson_version,content_digest,character_id,target_index),
  FOREIGN KEY(corpus_version,lesson_version,content_digest) REFERENCES pilot_corpus_item(corpus_version,lesson_version,content_digest),
  FOREIGN KEY(lesson_version,character_id) REFERENCES pilot_curriculum_character(lesson_version,character_id),
  FOREIGN KEY(source_evidence_id,lesson_version,content_digest) REFERENCES pilot_corpus_source_evidence(id,lesson_version,content_digest),
  CHECK(target_index IN (0,1)),
  CHECK(identity_version='r6-coverage-identity-1')
);


CREATE TABLE IF NOT EXISTS pilot_corpus_search_term (
  corpus_version TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  term TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY(corpus_version,lesson_version,term,kind),
  FOREIGN KEY(corpus_version,lesson_version,content_digest) REFERENCES pilot_corpus_item(corpus_version,lesson_version,content_digest),
  CHECK(kind IN ('hanzi','title-english','word-hanzi','word-english'))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_snapshot (
  id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  installation_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71 AND substr(source_digest,1,7)='sha256:' AND substr(source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  artifact_digest TEXT NOT NULL CHECK(length(artifact_digest)=71 AND substr(artifact_digest,1,7)='sha256:' AND substr(artifact_digest,8) NOT GLOB '*[^0-9a-f]*'),
  evidence_epoch INTEGER NOT NULL CHECK(evidence_epoch>=0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  plan_digest TEXT NOT NULL CHECK(length(plan_digest)=71 AND substr(plan_digest,1,7)='sha256:' AND substr(plan_digest,8) NOT GLOB '*[^0-9a-f]*'),
  expected_member_digest TEXT NOT NULL CHECK(length(expected_member_digest)=71 AND substr(expected_member_digest,1,7)='sha256:' AND substr(expected_member_digest,8) NOT GLOB '*[^0-9a-f]*'),
  expected_included_count INTEGER NOT NULL CHECK(expected_included_count>=0),
  expected_exclusion_count INTEGER NOT NULL CHECK(expected_exclusion_count>=0),
  expected_package_count INTEGER NOT NULL CHECK(expected_package_count>=0),
  released_package_digest TEXT NOT NULL CHECK(length(released_package_digest)=71 AND substr(released_package_digest,1,7)='sha256:' AND substr(released_package_digest,8) NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES pilot_auth_user(id),
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  seal_request_id TEXT,
  seal_request_json TEXT CHECK(json_valid(seal_request_json)),
  seal_request_digest TEXT CHECK(length(seal_request_digest)=71 AND substr(seal_request_digest,1,7)='sha256:' AND substr(seal_request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  seal_ack_json TEXT CHECK(json_valid(seal_ack_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  sealed_at INTEGER CHECK(sealed_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(id,corpus_version,corpus_digest,installation_id,candidate_id,source_digest,artifact_digest),
  UNIQUE(created_by,installation_id,corpus_version,request_id),
  CHECK(COALESCE(json_extract(request_json,'$.resourceId')=corpus_version,0)),
  FOREIGN KEY(corpus_version,corpus_digest) REFERENCES pilot_corpus(corpus_version,corpus_digest),
  CHECK(status IN ('building','sealed')),
  CHECK(expected_included_count<=10000 AND expected_exclusion_count<=10000 AND expected_package_count<=5000),
  CHECK((status='building' AND sealed_at IS NULL AND seal_request_id IS NULL AND seal_request_json IS NULL AND seal_request_digest IS NULL AND seal_ack_json IS NULL) OR (status='sealed' AND sealed_at>=created_at AND seal_request_id IS NOT NULL AND seal_request_json IS NOT NULL AND seal_request_digest IS NOT NULL AND seal_ack_json IS NOT NULL)),
  UNIQUE(id,corpus_digest,installation_id,candidate_id,source_digest,artifact_digest)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_snapshot_member (
  snapshot_id TEXT NOT NULL,
  member_ordinal INTEGER NOT NULL CHECK(member_ordinal>=0),
  target_index INTEGER NOT NULL CHECK(target_index>=0),
  coverage_identity TEXT NOT NULL,
  character_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  source_evidence_id TEXT NOT NULL,
  review_id TEXT,
  proof_id TEXT,
  asset_inventory_digest TEXT NOT NULL CHECK(length(asset_inventory_digest)=71 AND substr(asset_inventory_digest,1,7)='sha256:' AND substr(asset_inventory_digest,8) NOT GLOB '*[^0-9a-f]*'),
  package_eligible INTEGER NOT NULL CHECK(package_eligible>=0),
  package_eligibility_json TEXT NOT NULL CHECK(json_valid(package_eligibility_json)),
  package_eligibility_digest TEXT NOT NULL CHECK(length(package_eligibility_digest)=71 AND substr(package_eligibility_digest,1,7)='sha256:' AND substr(package_eligibility_digest,8) NOT GLOB '*[^0-9a-f]*'),
  coverage_status TEXT NOT NULL,
  eligibility_json TEXT NOT NULL CHECK(json_valid(eligibility_json)),
  eligibility_digest TEXT NOT NULL CHECK(length(eligibility_digest)=71 AND substr(eligibility_digest,1,7)='sha256:' AND substr(eligibility_digest,8) NOT GLOB '*[^0-9a-f]*'),
  chunk_request_id TEXT NOT NULL,
  chunk_request_json TEXT NOT NULL CHECK(json_valid(chunk_request_json)),
  chunk_digest TEXT NOT NULL CHECK(length(chunk_digest)=71 AND substr(chunk_digest,1,7)='sha256:' AND substr(chunk_digest,8) NOT GLOB '*[^0-9a-f]*'),
  chunk_ack_json TEXT NOT NULL CHECK(json_valid(chunk_ack_json)),
  chunk_recorded_at INTEGER NOT NULL CHECK(chunk_recorded_at>=0),
  PRIMARY KEY(snapshot_id,member_ordinal),
  UNIQUE(snapshot_id,lesson_version,target_index),
  FOREIGN KEY(snapshot_id) REFERENCES pilot_corpus_snapshot(id),
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest),
  FOREIGN KEY(source_evidence_id,lesson_version,content_digest) REFERENCES pilot_corpus_source_evidence(id,lesson_version,content_digest),
  FOREIGN KEY(review_id) REFERENCES pilot_curriculum_review(review_id),
  FOREIGN KEY(proof_id) REFERENCES pilot_corpus_proof_receipt(id),
  CHECK(target_index IN (0,1) AND member_ordinal BETWEEN 0 AND 9999),
  CHECK(package_eligible IN (0,1) AND coverage_status IN ('included','excluded')),
  CHECK(coverage_status!='included' OR package_eligible=1)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_owner_decision (
  id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  installation_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71 AND substr(source_digest,1,7)='sha256:' AND substr(source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  artifact_digest TEXT NOT NULL CHECK(length(artifact_digest)=71 AND substr(artifact_digest,1,7)='sha256:' AND substr(artifact_digest,8) NOT GLOB '*[^0-9a-f]*'),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  scope_digest TEXT NOT NULL CHECK(length(scope_digest)=71 AND substr(scope_digest,1,7)='sha256:' AND substr(scope_digest,8) NOT GLOB '*[^0-9a-f]*'),
  decision TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  owner_session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  decided_at INTEGER NOT NULL CHECK(decided_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  CHECK(COALESCE(json_type(request_json,'$.resourceId')='text' AND length(json_extract(request_json,'$.resourceId')) BETWEEN 1 AND 120,0)),
  UNIQUE(id,snapshot_id,corpus_digest,installation_id,candidate_id,source_digest,artifact_digest),
  FOREIGN KEY(snapshot_id,corpus_digest,installation_id,candidate_id,source_digest,artifact_digest) REFERENCES pilot_corpus_snapshot(id,corpus_digest,installation_id,candidate_id,source_digest,artifact_digest),
  CHECK(decision IN ('accepted','rejected'))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_publication (
  id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  snapshot_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  namespace_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=0),
  predecessor_id TEXT,
  status TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  scope_digest TEXT NOT NULL CHECK(length(scope_digest)=71 AND substr(scope_digest,1,7)='sha256:' AND substr(scope_digest,8) NOT GLOB '*[^0-9a-f]*'),
  owner_decision_id TEXT,
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(corpus_version,installation_id,namespace_key,revision),
  UNIQUE(id,corpus_version,corpus_digest,installation_id,namespace_key,revision),
  UNIQUE(id,corpus_version,corpus_digest,installation_id),
  UNIQUE(actor_id,installation_id,corpus_version,request_id),
  CHECK(COALESCE(json_extract(request_json,'$.resourceId')=corpus_version,0)),
  FOREIGN KEY(corpus_version,corpus_digest) REFERENCES pilot_corpus(corpus_version,corpus_digest),
  FOREIGN KEY(snapshot_id) REFERENCES pilot_corpus_snapshot(id),
  FOREIGN KEY(owner_decision_id) REFERENCES pilot_corpus_owner_decision(id),
  FOREIGN KEY(predecessor_id) REFERENCES pilot_corpus_publication(id),
  CHECK(status IN ('released','withdrawn') AND scope_kind IN ('starter','supervised-trial','verification')),
  CHECK(revision>=1),
  CHECK((revision=1 AND predecessor_id IS NULL) OR (revision>1 AND predecessor_id IS NOT NULL)),
  CHECK((scope_kind='verification' AND test_run_id IS NOT NULL AND namespace_key=test_run_id AND owner_decision_id IS NULL) OR (scope_kind!='verification' AND test_run_id IS NULL AND namespace_key='ordinary' AND owner_decision_id IS NOT NULL)),
  UNIQUE(id,corpus_version,installation_id,namespace_key,revision)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_publication_state (
  corpus_version TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  namespace_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=0),
  latest_publication_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(corpus_version,installation_id,namespace_key),
  FOREIGN KEY(latest_publication_id,corpus_version,installation_id,namespace_key,revision) REFERENCES pilot_corpus_publication(id,corpus_version,installation_id,namespace_key,revision),
  CHECK(revision>=1)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_trial_member (
  publication_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  PRIMARY KEY(publication_id,child_id),
  FOREIGN KEY(publication_id) REFERENCES pilot_corpus_publication(id),
  FOREIGN KEY(parent_id) REFERENCES pilot_auth_user(id),
  FOREIGN KEY(child_id) REFERENCES pilot_auth_user(id)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_publication_audit (
  id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  action TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(id),
  UNIQUE(publication_id),
  FOREIGN KEY(publication_id) REFERENCES pilot_corpus_publication(id),
  CHECK(action IN ('released','withdrawn'))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_evidence_epoch (
  id INTEGER NOT NULL CHECK(id>=0),
  revision INTEGER NOT NULL CHECK(revision>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(id),
  CHECK(id=1)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_proposal (
  id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  policy_version TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  selection_ordinal INTEGER NOT NULL CHECK(selection_ordinal>=0),
  predecessor_id TEXT,
  predecessor_source_digest TEXT CHECK(length(predecessor_source_digest)=71 AND substr(predecessor_source_digest,1,7)='sha256:' AND substr(predecessor_source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71 AND substr(source_digest,1,7)='sha256:' AND substr(source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(id,child_id,installation_id,corpus_version,corpus_digest,source_digest),
  UNIQUE(id,child_id,installation_id,corpus_version,corpus_digest),
  UNIQUE(predecessor_id),
  FOREIGN KEY(corpus_version,corpus_digest) REFERENCES pilot_corpus(corpus_version,corpus_digest),
  FOREIGN KEY(predecessor_id,child_id,installation_id,corpus_version,corpus_digest) REFERENCES pilot_corpus_proposal(id,child_id,installation_id,corpus_version,corpus_digest),
  CHECK(policy_version='r6-placement-1' AND selection_ordinal>=1 AND expires_at=created_at+86400000),
  CHECK((selection_ordinal=1 AND predecessor_id IS NULL AND predecessor_source_digest IS NULL) OR (selection_ordinal>1 AND predecessor_id IS NOT NULL AND predecessor_source_digest IS NOT NULL))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_plan (
  id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  policy_version TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71 AND substr(source_digest,1,7)='sha256:' AND substr(source_digest,8) NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  approved_at INTEGER NOT NULL CHECK(approved_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(proposal_id),
  UNIQUE(id,child_id,installation_id,corpus_version,corpus_digest),
  FOREIGN KEY(proposal_id,child_id,installation_id,corpus_version,corpus_digest,source_digest) REFERENCES pilot_corpus_proposal(id,child_id,installation_id,corpus_version,corpus_digest,source_digest),
  CHECK(policy_version='r6-placement-1')
);


CREATE TABLE IF NOT EXISTS pilot_corpus_plan_item (
  id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  publication_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  PRIMARY KEY(id),
  UNIQUE(plan_id,ordinal),
  UNIQUE(id,child_id,installation_id,corpus_version,corpus_digest,publication_id,lesson_version,content_digest),
  FOREIGN KEY(plan_id,child_id,installation_id,corpus_version,corpus_digest) REFERENCES pilot_corpus_plan(id,child_id,installation_id,corpus_version,corpus_digest),
  FOREIGN KEY(corpus_version,lesson_version,content_digest) REFERENCES pilot_corpus_item(corpus_version,lesson_version,content_digest),
  FOREIGN KEY(publication_id,corpus_version,corpus_digest,installation_id) REFERENCES pilot_corpus_publication(id,corpus_version,corpus_digest,installation_id),
  CHECK(ordinal=0)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_assignment (
  id TEXT NOT NULL,
  plan_item_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  publication_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(plan_item_id),
  UNIQUE(id,child_id,installation_id),
  UNIQUE(id,child_id,installation_id,corpus_version,corpus_digest,publication_id,lesson_version,content_digest),
  FOREIGN KEY(plan_item_id,child_id,installation_id,corpus_version,corpus_digest,publication_id,lesson_version,content_digest) REFERENCES pilot_corpus_plan_item(id,child_id,installation_id,corpus_version,corpus_digest,publication_id,lesson_version,content_digest)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_schedule (
  id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL CHECK(due_at>=0),
  policy_version TEXT NOT NULL,
  initial_run_id TEXT,
  completion_event_id TEXT,
  initial_completed_at INTEGER CHECK(initial_completed_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(id),
  UNIQUE(assignment_id,kind),
  UNIQUE(id,assignment_id,child_id,installation_id),
  FOREIGN KEY(assignment_id,child_id,installation_id) REFERENCES pilot_corpus_assignment(id,child_id,installation_id),
  FOREIGN KEY(completion_event_id,initial_run_id) REFERENCES pilot_corpus_event(id,run_id),
  CHECK(kind IN ('initial','review-24h','review-7d') AND policy_version='r6-review-24h-7d-1'),
  CHECK((kind='initial' AND initial_run_id IS NULL AND completion_event_id IS NULL AND initial_completed_at IS NULL AND due_at=created_at) OR (kind='review-24h' AND initial_run_id IS NOT NULL AND completion_event_id IS NOT NULL AND initial_completed_at IS NOT NULL AND created_at=initial_completed_at AND due_at=initial_completed_at+86400000) OR (kind='review-7d' AND initial_run_id IS NOT NULL AND completion_event_id IS NOT NULL AND initial_completed_at IS NOT NULL AND created_at=initial_completed_at AND due_at=initial_completed_at+604800000))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_run (
  id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  corpus_version TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=71 AND substr(corpus_digest,1,7)='sha256:' AND substr(corpus_digest,8) NOT GLOB '*[^0-9a-f]*'),
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  publication_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  phase TEXT NOT NULL,
  seed INTEGER NOT NULL CHECK(seed>=0),
  start_request_id TEXT NOT NULL,
  start_request_json TEXT NOT NULL CHECK(json_valid(start_request_json)),
  start_request_digest TEXT NOT NULL CHECK(length(start_request_digest)=71 AND substr(start_request_digest,1,7)='sha256:' AND substr(start_request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  start_ack_json TEXT NOT NULL CHECK(json_valid(start_ack_json)),
  run_json TEXT NOT NULL CHECK(json_valid(run_json)),
  revision INTEGER NOT NULL CHECK(revision>=0),
  completed_at INTEGER CHECK(completed_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  test_run_id TEXT,
  PRIMARY KEY(id),
  UNIQUE(schedule_id),
  UNIQUE(child_id,installation_id,assignment_id,start_request_id),
  FOREIGN KEY(schedule_id,assignment_id,child_id,installation_id) REFERENCES pilot_corpus_schedule(id,assignment_id,child_id,installation_id),
  FOREIGN KEY(assignment_id,child_id,installation_id,corpus_version,corpus_digest,publication_id,lesson_version,content_digest) REFERENCES pilot_corpus_assignment(id,child_id,installation_id,corpus_version,corpus_digest,publication_id,lesson_version,content_digest),
  CHECK(adapter_id='corpus-paired' AND adapter_version='corpus-paired-v1'),
  CHECK(phase IN ('initial','review-24h','review-7d') AND seed BETWEEN 0 AND 4294967295),
  CHECK(updated_at>=created_at AND (completed_at IS NULL OR completed_at>=created_at))
);


CREATE TABLE IF NOT EXISTS pilot_corpus_event (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  action_json TEXT NOT NULL CHECK(json_valid(action_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  server_at INTEGER NOT NULL CHECK(server_at>=0),
  PRIMARY KEY(id),
  UNIQUE(run_id,event_id),
  UNIQUE(run_id,sequence),
  UNIQUE(id,run_id),
  FOREIGN KEY(run_id) REFERENCES pilot_corpus_run(id),
  CHECK(sequence>=1 AND expected_revision=sequence-1)
);


CREATE TABLE IF NOT EXISTS pilot_corpus_learning_audit (
  id TEXT NOT NULL,
  run_id TEXT,
  plan_id TEXT,
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  action TEXT NOT NULL,
  event_id TEXT,
  revision INTEGER CHECK(revision>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(id),
  UNIQUE(run_id,revision),
  UNIQUE(plan_id),
  FOREIGN KEY(run_id) REFERENCES pilot_corpus_run(id),
  FOREIGN KEY(plan_id) REFERENCES pilot_corpus_plan(id),
  FOREIGN KEY(event_id,run_id) REFERENCES pilot_corpus_event(id,run_id),
  CHECK((action='plan-approval' AND plan_id IS NOT NULL AND run_id IS NULL AND event_id IS NULL AND revision IS NULL) OR (action='run-start' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NULL AND revision=0) OR (action='run-action' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NOT NULL AND revision>=1))
);


CREATE TRIGGER IF NOT EXISTS pilot_corpus_proof_receipt_no_update BEFORE UPDATE ON pilot_corpus_proof_receipt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_proof_receipt_no_delete BEFORE DELETE ON pilot_corpus_proof_receipt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_source_evidence_no_update BEFORE UPDATE ON pilot_corpus_source_evidence
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_source_evidence_no_delete BEFORE DELETE ON pilot_corpus_source_evidence
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_batch_no_update BEFORE UPDATE ON pilot_corpus_batch
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_batch_no_delete BEFORE DELETE ON pilot_corpus_batch
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_no_update BEFORE UPDATE ON pilot_corpus
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_no_delete BEFORE DELETE ON pilot_corpus
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_item_no_update BEFORE UPDATE ON pilot_corpus_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_item_no_delete BEFORE DELETE ON pilot_corpus_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_character_no_update BEFORE UPDATE ON pilot_corpus_character
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_character_no_delete BEFORE DELETE ON pilot_corpus_character
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_search_term_no_update BEFORE UPDATE ON pilot_corpus_search_term
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_search_term_no_delete BEFORE DELETE ON pilot_corpus_search_term
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_no_delete BEFORE DELETE ON pilot_corpus_snapshot
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_member_no_update BEFORE UPDATE ON pilot_corpus_snapshot_member
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_member_no_delete BEFORE DELETE ON pilot_corpus_snapshot_member
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_owner_decision_no_update BEFORE UPDATE ON pilot_corpus_owner_decision
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_owner_decision_no_delete BEFORE DELETE ON pilot_corpus_owner_decision
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_no_update BEFORE UPDATE ON pilot_corpus_publication
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_no_delete BEFORE DELETE ON pilot_corpus_publication
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_state_no_delete BEFORE DELETE ON pilot_corpus_publication_state
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_trial_member_no_update BEFORE UPDATE ON pilot_corpus_trial_member
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_trial_member_no_delete BEFORE DELETE ON pilot_corpus_trial_member
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_audit_no_update BEFORE UPDATE ON pilot_corpus_publication_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_audit_no_delete BEFORE DELETE ON pilot_corpus_publication_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_evidence_epoch_no_delete BEFORE DELETE ON pilot_corpus_evidence_epoch
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_proposal_no_update BEFORE UPDATE ON pilot_corpus_proposal
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_proposal_no_delete BEFORE DELETE ON pilot_corpus_proposal
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_plan_no_update BEFORE UPDATE ON pilot_corpus_plan
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_plan_no_delete BEFORE DELETE ON pilot_corpus_plan
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_plan_item_no_update BEFORE UPDATE ON pilot_corpus_plan_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_plan_item_no_delete BEFORE DELETE ON pilot_corpus_plan_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_assignment_no_update BEFORE UPDATE ON pilot_corpus_assignment
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_assignment_no_delete BEFORE DELETE ON pilot_corpus_assignment
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_schedule_no_update BEFORE UPDATE ON pilot_corpus_schedule
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_schedule_no_delete BEFORE DELETE ON pilot_corpus_schedule
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_run_no_delete BEFORE DELETE ON pilot_corpus_run
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_event_no_update BEFORE UPDATE ON pilot_corpus_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_event_no_delete BEFORE DELETE ON pilot_corpus_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_learning_audit_no_update BEFORE UPDATE ON pilot_corpus_learning_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_learning_audit_no_delete BEFORE DELETE ON pilot_corpus_learning_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_run_identity BEFORE UPDATE ON pilot_corpus_run
WHEN NEW.id IS NOT OLD.id OR
  NEW.assignment_id IS NOT OLD.assignment_id OR
  NEW.schedule_id IS NOT OLD.schedule_id OR
  NEW.child_id IS NOT OLD.child_id OR
  NEW.installation_id IS NOT OLD.installation_id OR
  NEW.corpus_version IS NOT OLD.corpus_version OR
  NEW.corpus_digest IS NOT OLD.corpus_digest OR
  NEW.lesson_version IS NOT OLD.lesson_version OR
  NEW.content_digest IS NOT OLD.content_digest OR
  NEW.publication_id IS NOT OLD.publication_id OR
  NEW.adapter_id IS NOT OLD.adapter_id OR
  NEW.adapter_version IS NOT OLD.adapter_version OR
  NEW.phase IS NOT OLD.phase OR
  NEW.seed IS NOT OLD.seed OR
  NEW.start_request_id IS NOT OLD.start_request_id OR
  NEW.start_request_json IS NOT OLD.start_request_json OR
  NEW.start_request_digest IS NOT OLD.start_request_digest OR
  NEW.start_ack_json IS NOT OLD.start_ack_json OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.test_run_id IS NOT OLD.test_run_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_identity BEFORE UPDATE ON pilot_corpus_snapshot
WHEN NEW.id IS NOT OLD.id OR
  NEW.corpus_version IS NOT OLD.corpus_version OR
  NEW.corpus_digest IS NOT OLD.corpus_digest OR
  NEW.installation_id IS NOT OLD.installation_id OR
  NEW.candidate_id IS NOT OLD.candidate_id OR
  NEW.source_digest IS NOT OLD.source_digest OR
  NEW.artifact_digest IS NOT OLD.artifact_digest OR
  NEW.evidence_epoch IS NOT OLD.evidence_epoch OR
  NEW.plan_json IS NOT OLD.plan_json OR
  NEW.plan_digest IS NOT OLD.plan_digest OR
  NEW.expected_member_digest IS NOT OLD.expected_member_digest OR
  NEW.expected_included_count IS NOT OLD.expected_included_count OR
  NEW.expected_exclusion_count IS NOT OLD.expected_exclusion_count OR
  NEW.expected_package_count IS NOT OLD.expected_package_count OR
  NEW.released_package_digest IS NOT OLD.released_package_digest OR
  NEW.created_by IS NOT OLD.created_by OR
  NEW.request_id IS NOT OLD.request_id OR
  NEW.request_json IS NOT OLD.request_json OR
  NEW.request_digest IS NOT OLD.request_digest OR
  NEW.ack_json IS NOT OLD.ack_json OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.test_run_id IS NOT OLD.test_run_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R6_FACT'); END;


CREATE UNIQUE INDEX IF NOT EXISTS pilot_corpus_source_root_idx ON pilot_corpus_source_evidence(lesson_version,content_digest,installation_id) WHERE supersedes_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pilot_corpus_snapshot_coverage_idx ON pilot_corpus_snapshot_member(snapshot_id,coverage_identity) WHERE coverage_status='included';

CREATE UNIQUE INDEX IF NOT EXISTS pilot_corpus_proposal_chain_idx ON pilot_corpus_proposal(child_id,installation_id,corpus_version,coalesce(test_run_id,'ordinary'),selection_ordinal);

CREATE INDEX IF NOT EXISTS pilot_corpus_character_identity_idx ON pilot_corpus_character(coverage_identity,source_evidence_id);

CREATE INDEX IF NOT EXISTS pilot_corpus_search_idx ON pilot_corpus_search_term(corpus_version,term,lesson_version,kind);

CREATE INDEX IF NOT EXISTS pilot_corpus_item_order_idx ON pilot_corpus_item(corpus_version,track_id,sequence,lesson_version);

CREATE INDEX IF NOT EXISTS pilot_corpus_snapshot_state_idx ON pilot_corpus_snapshot(corpus_version,status,evidence_epoch);

CREATE INDEX IF NOT EXISTS pilot_corpus_assignment_child_idx ON pilot_corpus_assignment(child_id,installation_id,lesson_version);

CREATE INDEX IF NOT EXISTS pilot_corpus_schedule_due_idx ON pilot_corpus_schedule(child_id,installation_id,kind,due_at,id);

CREATE INDEX IF NOT EXISTS pilot_corpus_run_scope_idx ON pilot_corpus_run(child_id,installation_id,assignment_id,phase);

INSERT INTO pilot_corpus_evidence_epoch(id,revision,updated_at) VALUES(1,0,0);

CREATE TRIGGER IF NOT EXISTS pilot_corpus_schedule_completion
BEFORE INSERT ON pilot_corpus_schedule
WHEN (NEW.kind='initial' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_assignment a WHERE a.id=NEW.assignment_id AND a.created_at=NEW.created_at)) OR (NEW.kind!='initial' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_run r JOIN pilot_corpus_event e ON e.run_id=r.id WHERE r.id=NEW.initial_run_id AND r.assignment_id=NEW.assignment_id AND r.child_id=NEW.child_id AND r.installation_id=NEW.installation_id AND r.phase='initial' AND r.completed_at=NEW.initial_completed_at AND e.id=NEW.completion_event_id AND e.server_at=NEW.initial_completed_at AND json_extract(e.result_json,'$.ack.result.outcome')='completed'))
BEGIN SELECT RAISE(ABORT,'R6_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_run_projection
BEFORE UPDATE ON pilot_corpus_run
WHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR NOT EXISTS(SELECT 1 FROM pilot_corpus_event e WHERE e.run_id=OLD.id AND e.sequence=NEW.revision AND e.server_at=NEW.updated_at)
  OR (NEW.completed_at IS NOT OLD.completed_at AND (NEW.completed_at!=NEW.updated_at OR NOT EXISTS(SELECT 1 FROM pilot_corpus_event e WHERE e.run_id=OLD.id AND e.sequence=NEW.revision AND json_extract(e.result_json,'$.ack.result.outcome')='completed')))
BEGIN SELECT RAISE(ABORT,'R6_PROJECTION'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_audit_binding
BEFORE INSERT ON pilot_corpus_learning_audit
WHEN (NEW.action='plan-approval' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_plan p WHERE p.id=NEW.plan_id AND p.parent_id=NEW.actor_id AND p.approved_at=NEW.created_at))
  OR (NEW.action='run-start' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_run r WHERE r.id=NEW.run_id AND r.child_id=NEW.actor_id AND r.created_at=NEW.created_at))
  OR (NEW.action='run-action' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_run r JOIN pilot_corpus_event e ON e.run_id=r.id WHERE r.id=NEW.run_id AND r.child_id=NEW.actor_id AND e.id=NEW.event_id AND e.sequence=NEW.revision AND e.server_at=NEW.created_at))
BEGIN SELECT RAISE(ABORT,'R6_AUDIT_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_run_binding
BEFORE INSERT ON pilot_corpus_run
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_schedule s JOIN pilot_corpus_assignment a ON a.id=s.assignment_id WHERE s.id=NEW.schedule_id AND s.kind=NEW.phase AND a.test_run_id IS NEW.test_run_id AND NEW.created_at>=s.due_at)
BEGIN SELECT RAISE(ABORT,'R6_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_assignment_namespace
BEFORE INSERT ON pilot_corpus_assignment
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_plan_item i JOIN pilot_corpus_plan p ON p.id=i.plan_id WHERE i.id=NEW.plan_item_id AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R6_BINDING'); END;

-- Source chain advances by immutable logical ordinal, never clock or random ID.
CREATE TRIGGER IF NOT EXISTS pilot_corpus_source_successor BEFORE INSERT ON pilot_corpus_source_evidence
WHEN NEW.source_ordinal>1 AND NOT EXISTS(
  SELECT 1 FROM pilot_corpus_source_evidence p WHERE p.id=NEW.supersedes_id
    AND p.lineage_id=NEW.lineage_id AND p.lesson_version=NEW.lesson_version AND p.content_digest=NEW.content_digest
    AND p.source_ordinal=NEW.source_ordinal-1
    AND NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence n WHERE n.supersedes_id=p.id)
    AND (p.classification!='verification-fixture' OR NEW.classification='verification-fixture')
    AND json_extract(NEW.request_json,'$.request.expectedEvidenceDigest')=p.evidence_digest
)
BEGIN SELECT RAISE(ABORT,'R6_SOURCE_STALE'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_character_source_root BEFORE INSERT ON pilot_corpus_character
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence s WHERE s.id=NEW.source_evidence_id AND s.source_ordinal=1 AND s.lesson_version=NEW.lesson_version AND s.content_digest=NEW.content_digest)
BEGIN SELECT RAISE(ABORT,'R6_SOURCE_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_member_binding BEFORE INSERT ON pilot_corpus_snapshot_member
WHEN NOT EXISTS(
 SELECT 1 FROM pilot_corpus_snapshot s JOIN pilot_corpus_character c
 ON c.corpus_version=s.corpus_version AND c.lesson_version=NEW.lesson_version AND c.content_digest=NEW.content_digest AND c.target_index=NEW.target_index
 JOIN pilot_corpus_source_evidence root ON root.id=c.source_evidence_id
 JOIN pilot_corpus_source_evidence source ON source.id=NEW.source_evidence_id AND source.lineage_id=root.lineage_id
 WHERE s.id=NEW.snapshot_id AND s.status='building' AND EXISTS(SELECT 1 FROM pilot_installation WHERE id=1) AND (s.installation_id!=(SELECT installation_id FROM pilot_installation WHERE id=1) OR s.evidence_epoch=(SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1)) AND c.character_id=NEW.character_id AND c.coverage_identity=NEW.coverage_identity
 AND (s.installation_id!=(SELECT installation_id FROM pilot_installation WHERE id=1) OR NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence later WHERE later.supersedes_id=source.id))
 AND (json_extract(s.plan_json,'$.lane')='verification' OR NEW.package_eligible=0 OR (NEW.review_id IS NOT NULL AND NEW.proof_id IS NOT NULL))
 AND (NEW.review_id IS NULL OR EXISTS(SELECT 1 FROM pilot_curriculum_review r WHERE r.review_id=NEW.review_id AND r.lesson_version=NEW.lesson_version AND r.content_digest=NEW.content_digest))
 AND (NEW.proof_id IS NULL OR EXISTS(SELECT 1 FROM pilot_corpus_proof_receipt p WHERE p.id=NEW.proof_id AND p.corpus_version=s.corpus_version AND p.corpus_digest=s.corpus_digest AND p.lesson_version=NEW.lesson_version AND p.content_digest=NEW.content_digest AND p.installation_id=s.installation_id AND p.test_run_id IS s.test_run_id AND (json_extract(s.plan_json,'$.lane')!='verification' OR p.namespace=s.test_run_id)))
)
BEGIN SELECT RAISE(ABORT,'R6_SNAPSHOT_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_seal BEFORE UPDATE ON pilot_corpus_snapshot
WHEN OLD.status!='building' OR NEW.status!='sealed'
 OR NOT EXISTS(SELECT 1 FROM pilot_installation WHERE id=1)
 OR (NEW.installation_id=(SELECT installation_id FROM pilot_installation WHERE id=1) AND NEW.evidence_epoch!=(SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1))
 OR NEW.expected_included_count!=(SELECT count(*) FROM pilot_corpus_snapshot_member m WHERE m.snapshot_id=OLD.id AND m.coverage_status='included')
 OR NEW.expected_exclusion_count!=(SELECT count(*) FROM pilot_corpus_snapshot_member m WHERE m.snapshot_id=OLD.id AND m.coverage_status='excluded')
 OR NEW.expected_package_count!=(SELECT count(DISTINCT lesson_version) FROM pilot_corpus_snapshot_member m WHERE m.snapshot_id=OLD.id AND m.package_eligible=1)
 OR EXISTS(SELECT 1 FROM pilot_corpus_snapshot_member m WHERE m.snapshot_id=OLD.id GROUP BY lesson_version HAVING count(*)!=2 OR min(package_eligible)!=max(package_eligible) OR min(package_eligibility_digest)!=max(package_eligibility_digest))
BEGIN SELECT RAISE(ABORT,'R6_SNAPSHOT_INCOMPLETE'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_binding BEFORE INSERT ON pilot_corpus_publication
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_snapshot s WHERE s.id=NEW.snapshot_id AND s.corpus_version=NEW.corpus_version AND s.corpus_digest=NEW.corpus_digest AND s.installation_id=NEW.installation_id AND s.status='sealed')
 OR (NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM pilot_corpus_publication p WHERE p.id=NEW.predecessor_id AND p.corpus_version=NEW.corpus_version AND p.corpus_digest=NEW.corpus_digest AND p.installation_id=NEW.installation_id AND p.namespace_key=NEW.namespace_key AND p.revision=NEW.revision-1))
 OR (NEW.scope_kind!='verification' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_owner_decision o JOIN pilot_corpus_snapshot s ON s.id=o.snapshot_id WHERE o.id=NEW.owner_decision_id AND o.snapshot_id=NEW.snapshot_id AND o.corpus_digest=NEW.corpus_digest AND o.installation_id=NEW.installation_id AND o.candidate_id=s.candidate_id AND o.source_digest=s.source_digest AND o.artifact_digest=s.artifact_digest AND o.scope_json=NEW.scope_json AND o.scope_digest=NEW.scope_digest AND o.decision='accepted'))
 OR (NEW.scope_kind='starter' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_snapshot s WHERE s.id=NEW.snapshot_id AND s.expected_included_count>=1600 AND json_extract(s.plan_json,'$.lane')='ordinary'))
BEGIN SELECT RAISE(ABORT,'R6_GROUP_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_state_insert BEFORE INSERT ON pilot_corpus_publication_state
WHEN NEW.revision!=1
BEGIN SELECT RAISE(ABORT,'R6_HEAD_CAS'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_state_update BEFORE UPDATE ON pilot_corpus_publication_state
WHEN NEW.corpus_version IS NOT OLD.corpus_version OR NEW.installation_id IS NOT OLD.installation_id OR NEW.namespace_key IS NOT OLD.namespace_key OR NEW.revision!=OLD.revision+1
 OR NOT EXISTS(SELECT 1 FROM pilot_corpus_publication p WHERE p.id=NEW.latest_publication_id AND p.predecessor_id=OLD.latest_publication_id AND p.created_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'R6_HEAD_CAS'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_trial_member_binding BEFORE INSERT ON pilot_corpus_trial_member
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_publication p WHERE p.id=NEW.publication_id AND p.installation_id=NEW.installation_id AND p.scope_kind IN ('supervised-trial','verification'))
BEGIN SELECT RAISE(ABORT,'R6_SCOPE_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_publication_audit_binding BEFORE INSERT ON pilot_corpus_publication_audit
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_publication p WHERE p.id=NEW.publication_id AND p.actor_id=NEW.actor_id AND p.status=NEW.action AND p.request_id=NEW.request_id AND p.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'R6_AUDIT_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_proposal_predecessor BEFORE INSERT ON pilot_corpus_proposal
WHEN (NEW.selection_ordinal=1 AND EXISTS(SELECT 1 FROM pilot_corpus_proposal p WHERE p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.corpus_version=NEW.corpus_version AND p.test_run_id IS NEW.test_run_id))
 OR (NEW.selection_ordinal>1 AND NOT EXISTS(SELECT 1 FROM pilot_corpus_proposal p WHERE p.id=NEW.predecessor_id AND p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.corpus_version=NEW.corpus_version AND p.test_run_id IS NEW.test_run_id AND p.selection_ordinal=NEW.selection_ordinal-1 AND p.source_digest=NEW.predecessor_source_digest AND NOT EXISTS(SELECT 1 FROM pilot_corpus_proposal n WHERE n.predecessor_id=p.id)))
BEGIN SELECT RAISE(ABORT,'R6_PROPOSAL_STALE'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_plan_namespace BEFORE INSERT ON pilot_corpus_plan
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_proposal p WHERE p.id=NEW.proposal_id AND p.parent_id=NEW.parent_id AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R6_PLAN_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_plan_item_binding BEFORE INSERT ON pilot_corpus_plan_item
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_plan p JOIN pilot_corpus_proposal s ON s.id=p.proposal_id
 WHERE p.id=NEW.plan_id AND json_extract(s.source_json,'$.selection.lessonVersion')=NEW.lesson_version
 AND json_extract(s.source_json,'$.selection.contentDigest')=NEW.content_digest AND json_extract(s.source_json,'$.selection.releaseId')=NEW.publication_id)
 OR NOT EXISTS(SELECT 1 FROM pilot_corpus_publication p JOIN pilot_corpus_snapshot_member m ON m.snapshot_id=p.snapshot_id
 WHERE p.id=NEW.publication_id AND m.lesson_version=NEW.lesson_version AND m.content_digest=NEW.content_digest AND m.package_eligible=1
 GROUP BY p.id HAVING count(*)=2)
BEGIN SELECT RAISE(ABORT,'R6_PLAN_ITEM_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_run_initial BEFORE INSERT ON pilot_corpus_run
WHEN NEW.revision!=0 OR NEW.completed_at IS NOT NULL OR NEW.updated_at!=NEW.created_at
 OR EXISTS(SELECT 1 FROM pilot_corpus_run r WHERE r.assignment_id=NEW.assignment_id AND r.seed!=NEW.seed)
BEGIN SELECT RAISE(ABORT,'R6_INITIAL_PROJECTION'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_event_order BEFORE INSERT ON pilot_corpus_event
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_run r WHERE r.id=NEW.run_id AND r.revision=NEW.expected_revision AND NEW.server_at>=r.updated_at)
BEGIN SELECT RAISE(ABORT,'R6_EVENT_ORDER'); END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_epoch_update BEFORE UPDATE ON pilot_corpus_evidence_epoch
WHEN NEW.id IS NOT OLD.id OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'R6_EPOCH_CAS'); END;

-- These new triggers affect only R6 evidence freshness; old table SQL/history is unchanged.
CREATE TRIGGER IF NOT EXISTS pilot_corpus_source_epoch AFTER INSERT ON pilot_corpus_source_evidence
BEGIN UPDATE pilot_corpus_evidence_epoch SET revision=revision+1,updated_at=max(updated_at,NEW.created_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS pilot_corpus_proof_epoch AFTER INSERT ON pilot_corpus_proof_receipt
BEGIN UPDATE pilot_corpus_evidence_epoch SET revision=revision+1,updated_at=max(updated_at,NEW.received_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS pilot_corpus_release_epoch AFTER INSERT ON pilot_corpus_publication
BEGIN UPDATE pilot_corpus_evidence_epoch SET revision=revision+1,updated_at=max(updated_at,NEW.created_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS pilot_corpus_registry_epoch AFTER INSERT ON pilot_curriculum_package
WHEN json_extract(NEW.manifest_json,'$.renderer.adapterId')='corpus-paired'
BEGIN UPDATE pilot_corpus_evidence_epoch SET revision=revision+1,updated_at=max(updated_at,NEW.imported_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS pilot_corpus_review_epoch AFTER INSERT ON pilot_curriculum_review
WHEN EXISTS(SELECT 1 FROM pilot_curriculum_package p WHERE p.lesson_version=NEW.lesson_version AND json_extract(p.manifest_json,'$.renderer.adapterId')='corpus-paired')
BEGIN UPDATE pilot_corpus_evidence_epoch SET revision=revision+1,updated_at=max(updated_at,NEW.reviewed_at) WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS pilot_corpus_snapshot_initial BEFORE INSERT ON pilot_corpus_snapshot
WHEN NEW.status!='building' OR NEW.sealed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'R6_SNAPSHOT_INITIAL'); END;

CREATE UNIQUE INDEX IF NOT EXISTS pilot_corpus_source_evidence_request_scope_idx ON pilot_corpus_source_evidence(actor_id,installation_id,json_extract(request_json,'$.resourceId'),request_id);
CREATE UNIQUE INDEX IF NOT EXISTS pilot_corpus_batch_request_scope_idx ON pilot_corpus_batch(actor_id,installation_id,json_extract(request_json,'$.resourceId'),request_id);
CREATE UNIQUE INDEX IF NOT EXISTS pilot_corpus_owner_decision_request_scope_idx ON pilot_corpus_owner_decision(actor_id,installation_id,json_extract(request_json,'$.resourceId'),request_id);
CREATE TRIGGER IF NOT EXISTS pilot_corpus_owner_resource BEFORE INSERT ON pilot_corpus_owner_decision
WHEN NOT EXISTS(SELECT 1 FROM pilot_corpus_snapshot s WHERE s.id=NEW.snapshot_id AND json_extract(NEW.request_json,'$.resourceId')=s.corpus_version)
BEGIN SELECT RAISE(ABORT,'R6_REQUEST_SCOPE'); END;
