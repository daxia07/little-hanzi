PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_curriculum_proof_receipt (
  id TEXT PRIMARY KEY NOT NULL,
  issuer_id TEXT NOT NULL,
  receipt_version TEXT NOT NULL CHECK(receipt_version='r3-proof-receipt-1'),
  receipt_digest TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  signature TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK(issued_at>=0),
  accepted_at INTEGER NOT NULL CHECK(accepted_at>=0),
  namespace TEXT NOT NULL,
  accepted_issuer_json TEXT NOT NULL CHECK(json_valid(accepted_issuer_json))
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_proof_receipt_no_update
BEFORE UPDATE ON pilot_curriculum_proof_receipt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_proof_receipt_no_delete
BEFORE DELETE ON pilot_curriculum_proof_receipt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_owner_decision (
  id TEXT PRIMARY KEY NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  target_installation_id TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  owner_identity TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
  decided_at INTEGER NOT NULL CHECK(decided_at>=0),
  evidence_ref TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES pilot_auth_user(id),
  test_run_id TEXT,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL,
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_owner_decision_no_update
BEFORE UPDATE ON pilot_curriculum_owner_decision
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_owner_decision_no_delete
BEFORE DELETE ON pilot_curriculum_owner_decision
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_publication (
  id TEXT PRIMARY KEY NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=1),
  predecessor_id TEXT REFERENCES pilot_curriculum_publication(id),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  status TEXT NOT NULL CHECK(status IN ('released','rejected','withdrawn')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('supervised-trial','verification')),
  scope_digest TEXT NOT NULL,
  review_id TEXT REFERENCES pilot_curriculum_review(review_id),
  proof_id TEXT REFERENCES pilot_curriculum_proof_receipt(id),
  owner_decision_id TEXT REFERENCES pilot_curriculum_owner_decision(id),
  candidate_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  UNIQUE(installation_id,lesson_version,generation),
  UNIQUE(installation_id,request_id),
  UNIQUE(id,lesson_version,content_digest,installation_id),
  CHECK((scope_kind='verification' AND test_run_id IS NOT NULL) OR (scope_kind='supervised-trial' AND test_run_id IS NULL AND review_id IS NOT NULL AND proof_id IS NOT NULL AND owner_decision_id IS NOT NULL)),
  CHECK((generation=1 AND predecessor_id IS NULL AND status='released') OR (generation>1 AND predecessor_id IS NOT NULL)),
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_publication_no_update
BEFORE UPDATE ON pilot_curriculum_publication
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_publication_no_delete
BEFORE DELETE ON pilot_curriculum_publication
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_trial_member (
  publication_id TEXT NOT NULL REFERENCES pilot_curriculum_publication(id),
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  plan_scope TEXT NOT NULL,
  PRIMARY KEY(publication_id,child_id)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_trial_member_no_update
BEFORE UPDATE ON pilot_curriculum_trial_member
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_trial_member_no_delete
BEFORE DELETE ON pilot_curriculum_trial_member
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_publication_state (
  installation_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  latest_publication_id TEXT NOT NULL REFERENCES pilot_curriculum_publication(id),
  PRIMARY KEY(installation_id,lesson_version)
);

CREATE TABLE IF NOT EXISTS pilot_curriculum_publication_audit (
  id TEXT PRIMARY KEY NOT NULL,
  publication_id TEXT NOT NULL UNIQUE REFERENCES pilot_curriculum_publication(id),
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  action TEXT NOT NULL CHECK(action IN ('released','rejected','withdrawn')),
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_publication_audit_no_update
BEFORE UPDATE ON pilot_curriculum_publication_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_publication_audit_no_delete
BEFORE DELETE ON pilot_curriculum_publication_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_placement_proposal (
  id TEXT PRIMARY KEY NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(policy_version='r3-placement-1'),
  source_digest TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  onboarding_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at=created_at+86400000),
  test_run_id TEXT,
  UNIQUE(child_id,installation_id,source_digest),
  UNIQUE(id,child_id,installation_id),
  FOREIGN KEY(publication_id,lesson_version,content_digest,installation_id) REFERENCES pilot_curriculum_publication(id,lesson_version,content_digest,installation_id)
);

CREATE TRIGGER IF NOT EXISTS pilot_placement_proposal_no_update
BEFORE UPDATE ON pilot_placement_proposal
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_placement_proposal_no_delete
BEFORE DELETE ON pilot_placement_proposal
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_learning_plan (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  policy_version TEXT NOT NULL CHECK(policy_version='r3-placement-1'),
  source_digest TEXT NOT NULL,
  approved_at INTEGER NOT NULL CHECK(approved_at>=0),
  test_run_id TEXT,
  UNIQUE(id,child_id,installation_id),
  FOREIGN KEY(proposal_id,child_id,installation_id) REFERENCES pilot_placement_proposal(id,child_id,installation_id)
);

CREATE TRIGGER IF NOT EXISTS pilot_learning_plan_no_update
BEFORE UPDATE ON pilot_learning_plan
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_learning_plan_no_delete
BEFORE DELETE ON pilot_learning_plan
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_learning_plan_item (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal=0),
  publication_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  UNIQUE(plan_id,ordinal),
  UNIQUE(id,child_id,installation_id,publication_id,lesson_version,content_digest),
  FOREIGN KEY(plan_id,child_id,installation_id) REFERENCES pilot_learning_plan(id,child_id,installation_id),
  FOREIGN KEY(publication_id,lesson_version,content_digest,installation_id) REFERENCES pilot_curriculum_publication(id,lesson_version,content_digest,installation_id)
);

CREATE TRIGGER IF NOT EXISTS pilot_learning_plan_item_no_update
BEFORE UPDATE ON pilot_learning_plan_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_learning_plan_item_no_delete
BEFORE DELETE ON pilot_learning_plan_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_assignment (
  id TEXT PRIMARY KEY NOT NULL,
  plan_item_id TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  UNIQUE(id,child_id,installation_id,publication_id,lesson_version,content_digest),
  UNIQUE(id,child_id),
  FOREIGN KEY(plan_item_id,child_id,installation_id,publication_id,lesson_version,content_digest) REFERENCES pilot_learning_plan_item(id,child_id,installation_id,publication_id,lesson_version,content_digest)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_assignment_no_update
BEFORE UPDATE ON pilot_curriculum_assignment
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_assignment_no_delete
BEFORE DELETE ON pilot_curriculum_assignment
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_learning_schedule (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  kind TEXT NOT NULL CHECK(kind IN ('initial','delayed-review')),
  due_at INTEGER NOT NULL CHECK(due_at>=0),
  policy_version TEXT NOT NULL CHECK(policy_version='r3-review-24h-1'),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(assignment_id,kind),
  FOREIGN KEY(assignment_id,child_id) REFERENCES pilot_curriculum_assignment(id,child_id)
);

CREATE TRIGGER IF NOT EXISTS pilot_learning_schedule_no_update
BEFORE UPDATE ON pilot_learning_schedule
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_learning_schedule_no_delete
BEFORE DELETE ON pilot_learning_schedule
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_learning_run (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL CHECK(adapter_id='forest-story'),
  adapter_version TEXT NOT NULL CHECK(adapter_version='forest-story-v1'),
  seed INTEGER NOT NULL CHECK(seed>=0 AND seed<=4294967295),
  start_request_id TEXT NOT NULL,
  start_request_digest TEXT NOT NULL,
  start_ack_json TEXT NOT NULL CHECK(json_valid(start_ack_json)),
  run_json TEXT NOT NULL CHECK(json_valid(run_json)),
  revision INTEGER NOT NULL CHECK(revision>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  test_run_id TEXT,
  UNIQUE(child_id,installation_id,start_request_id),
  FOREIGN KEY(assignment_id,child_id,installation_id,publication_id,lesson_version,content_digest) REFERENCES pilot_curriculum_assignment(id,child_id,installation_id,publication_id,lesson_version,content_digest)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_run_no_update
BEFORE UPDATE ON pilot_curriculum_learning_run
WHEN NEW.id IS NOT OLD.id
  OR NEW.assignment_id IS NOT OLD.assignment_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.lesson_version IS NOT OLD.lesson_version
  OR NEW.content_digest IS NOT OLD.content_digest
  OR NEW.publication_id IS NOT OLD.publication_id
  OR NEW.adapter_id IS NOT OLD.adapter_id
  OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.seed IS NOT OLD.seed
  OR NEW.start_request_id IS NOT OLD.start_request_id
  OR NEW.start_request_digest IS NOT OLD.start_request_digest
  OR NEW.start_ack_json IS NOT OLD.start_ack_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.test_run_id IS NOT OLD.test_run_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_run_no_delete
BEFORE DELETE ON pilot_curriculum_learning_run
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_learning_event (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES pilot_curriculum_learning_run(id),
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  request_digest TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision=sequence-1),
  action_json TEXT NOT NULL CHECK(json_valid(action_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  server_at INTEGER NOT NULL CHECK(server_at>=0),
  UNIQUE(run_id,event_id),
  UNIQUE(run_id,sequence),
  UNIQUE(id,run_id)
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_event_no_update
BEFORE UPDATE ON pilot_curriculum_learning_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_event_no_delete
BEFORE DELETE ON pilot_curriculum_learning_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TABLE IF NOT EXISTS pilot_curriculum_learning_audit (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT REFERENCES pilot_curriculum_learning_run(id),
  plan_id TEXT REFERENCES pilot_learning_plan(id),
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  action TEXT NOT NULL CHECK(action IN ('plan-approval','run-start','run-action')),
  event_id TEXT,
  revision INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(run_id,revision),
  UNIQUE(plan_id),
  FOREIGN KEY(event_id,run_id) REFERENCES pilot_curriculum_learning_event(id,run_id),
  CHECK((action='plan-approval' AND plan_id IS NOT NULL AND run_id IS NULL AND event_id IS NULL AND revision IS NULL) OR (action='run-start' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NULL AND revision=0) OR (action='run-action' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NOT NULL AND revision>=1))
);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_audit_no_update
BEFORE UPDATE ON pilot_curriculum_learning_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_audit_no_delete
BEFORE DELETE ON pilot_curriculum_learning_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R3_FACT'); END;

CREATE INDEX IF NOT EXISTS pilot_curriculum_trial_member_lookup_idx ON pilot_curriculum_trial_member(child_id);
CREATE INDEX IF NOT EXISTS pilot_learning_plan_lookup_idx ON pilot_learning_plan(child_id,approved_at);
CREATE INDEX IF NOT EXISTS pilot_curriculum_assignment_lookup_idx ON pilot_curriculum_assignment(child_id);
CREATE INDEX IF NOT EXISTS pilot_curriculum_learning_run_lookup_idx ON pilot_curriculum_learning_run(child_id);
CREATE INDEX IF NOT EXISTS pilot_curriculum_learning_event_lookup_idx ON pilot_curriculum_learning_event(run_id);
CREATE INDEX IF NOT EXISTS pilot_placement_proposal_lookup_idx ON pilot_placement_proposal(child_id);

CREATE TRIGGER IF NOT EXISTS pilot_learning_plan_binding
BEFORE INSERT ON pilot_learning_plan
WHEN NOT EXISTS(SELECT 1 FROM pilot_placement_proposal p WHERE p.id=NEW.proposal_id AND p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.source_digest=NEW.source_digest AND p.policy_version=NEW.policy_version AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R3_PLAN_BINDING'); END;
CREATE TRIGGER IF NOT EXISTS pilot_learning_plan_item_binding
BEFORE INSERT ON pilot_learning_plan_item
WHEN NOT EXISTS(SELECT 1 FROM pilot_learning_plan p JOIN pilot_placement_proposal s ON s.id=p.proposal_id WHERE p.id=NEW.plan_id AND p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND s.publication_id=NEW.publication_id AND s.lesson_version=NEW.lesson_version AND s.content_digest=NEW.content_digest AND s.reason_json=NEW.reason_json)
BEGIN SELECT RAISE(ABORT,'R3_PLAN_ITEM_BINDING'); END;
CREATE TRIGGER IF NOT EXISTS pilot_placement_proposal_namespace
BEFORE INSERT ON pilot_placement_proposal
WHEN NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication p WHERE p.id=NEW.publication_id AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R3_NAMESPACE'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_assignment_namespace
BEFORE INSERT ON pilot_curriculum_assignment
WHEN NOT EXISTS(SELECT 1 FROM pilot_learning_plan_item i JOIN pilot_learning_plan p ON p.id=i.plan_id WHERE i.id=NEW.plan_item_id AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R3_NAMESPACE'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_learning_run_namespace
BEFORE INSERT ON pilot_curriculum_learning_run
WHEN NOT EXISTS(SELECT 1 FROM pilot_curriculum_assignment a WHERE a.id=NEW.assignment_id AND a.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R3_NAMESPACE'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_publication_state_binding_insert
BEFORE INSERT ON pilot_curriculum_publication_state
WHEN NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication p WHERE p.id=NEW.latest_publication_id AND p.installation_id=NEW.installation_id AND p.lesson_version=NEW.lesson_version AND p.generation=NEW.revision)
BEGIN SELECT RAISE(ABORT,'R3_PUBLICATION_HEAD'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_publication_state_binding_update
BEFORE UPDATE ON pilot_curriculum_publication_state
WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.lesson_version IS NOT OLD.lesson_version OR NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication p WHERE p.id=NEW.latest_publication_id AND p.installation_id=NEW.installation_id AND p.lesson_version=NEW.lesson_version AND p.generation=NEW.revision)
BEGIN SELECT RAISE(ABORT,'R3_PUBLICATION_HEAD'); END;
