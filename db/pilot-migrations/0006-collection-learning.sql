-- Frozen r5-data-1 additive schema. Isolated QA authorized; production migration is a separate release action.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_collection (
  collection_version TEXT PRIMARY KEY NOT NULL,
  collection_id TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  canonicalization_version TEXT NOT NULL CHECK(canonicalization_version='s3-json-1'),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  imported_by TEXT NOT NULL REFERENCES pilot_auth_user(id),
  imported_at INTEGER NOT NULL CHECK(imported_at>=0),
  UNIQUE(collection_version,collection_digest)
);

CREATE TABLE IF NOT EXISTS pilot_collection_item (
  collection_version TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<=999999),
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  track_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=1000000),
  prerequisites_json TEXT NOT NULL CHECK(json_valid(prerequisites_json) AND json_type(prerequisites_json)='array'),
  PRIMARY KEY(collection_version,ordinal),
  UNIQUE(collection_version,lesson_version),
  UNIQUE(collection_version,sequence),
  UNIQUE(collection_version,collection_digest,lesson_version,content_digest),
  FOREIGN KEY(collection_version,collection_digest) REFERENCES pilot_collection(collection_version,collection_digest),
  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest)
);

CREATE TABLE IF NOT EXISTS pilot_collection_proposal (
  id TEXT PRIMARY KEY NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  collection_version TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  selection_ordinal INTEGER NOT NULL CHECK(selection_ordinal>=1),
  predecessor_id TEXT UNIQUE,
  predecessor_source_digest TEXT,
  selected_by_parent INTEGER NOT NULL CHECK(selected_by_parent IN (0,1)),
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  policy_version TEXT NOT NULL CHECK(policy_version='r5-placement-1'),
  source_digest TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  onboarding_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  publication_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at=created_at+86400000),
  test_run_id TEXT,
  UNIQUE(child_id,installation_id,collection_version,selection_ordinal),
  UNIQUE(id,child_id,installation_id,collection_version,collection_digest),
  CHECK((selection_ordinal=1 AND predecessor_id IS NULL AND predecessor_source_digest IS NULL) OR (selection_ordinal>1 AND predecessor_id IS NOT NULL AND predecessor_source_digest IS NOT NULL)),
  FOREIGN KEY(predecessor_id,child_id,installation_id,collection_version,collection_digest) REFERENCES pilot_collection_proposal(id,child_id,installation_id,collection_version,collection_digest),
  FOREIGN KEY(collection_version,collection_digest,lesson_version,content_digest) REFERENCES pilot_collection_item(collection_version,collection_digest,lesson_version,content_digest),
  FOREIGN KEY(publication_id,lesson_version,content_digest,installation_id) REFERENCES pilot_curriculum_publication(id,lesson_version,content_digest,installation_id)
);

CREATE TABLE IF NOT EXISTS pilot_collection_plan (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  collection_version TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  policy_version TEXT NOT NULL CHECK(policy_version='r5-placement-1'),
  source_digest TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  request_digest TEXT NOT NULL,
  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),
  approved_at INTEGER NOT NULL CHECK(approved_at>=0),
  test_run_id TEXT,
  UNIQUE(id,child_id,installation_id,collection_version,collection_digest),
  FOREIGN KEY(proposal_id,child_id,installation_id,collection_version,collection_digest) REFERENCES pilot_collection_proposal(id,child_id,installation_id,collection_version,collection_digest)
);

CREATE TABLE IF NOT EXISTS pilot_collection_plan_item (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  collection_version TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal=0),
  publication_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  UNIQUE(plan_id,ordinal),
  UNIQUE(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest),
  FOREIGN KEY(plan_id,child_id,installation_id,collection_version,collection_digest) REFERENCES pilot_collection_plan(id,child_id,installation_id,collection_version,collection_digest),
  FOREIGN KEY(collection_version,collection_digest,lesson_version,content_digest) REFERENCES pilot_collection_item(collection_version,collection_digest,lesson_version,content_digest),
  FOREIGN KEY(publication_id,lesson_version,content_digest,installation_id) REFERENCES pilot_curriculum_publication(id,lesson_version,content_digest,installation_id)
);

CREATE TABLE IF NOT EXISTS pilot_collection_assignment (
  id TEXT PRIMARY KEY NOT NULL,
  plan_item_id TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  collection_version TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  test_run_id TEXT,
  UNIQUE(id,child_id,installation_id),
  UNIQUE(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest),
  FOREIGN KEY(plan_item_id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest) REFERENCES pilot_collection_plan_item(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest)
);

CREATE TABLE IF NOT EXISTS pilot_collection_schedule (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('initial','review-24h','review-7d')),
  due_at INTEGER NOT NULL CHECK(due_at>=0),
  policy_version TEXT NOT NULL CHECK(policy_version='r5-review-24h-7d-1'),
  initial_run_id TEXT,
  completion_event_id TEXT,
  initial_completed_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(assignment_id,kind),
  UNIQUE(id,assignment_id,child_id,installation_id),
  CHECK((kind='initial' AND initial_run_id IS NULL AND completion_event_id IS NULL AND initial_completed_at IS NULL AND due_at=created_at) OR (kind='review-24h' AND initial_run_id IS NOT NULL AND completion_event_id IS NOT NULL AND initial_completed_at IS NOT NULL AND created_at=initial_completed_at AND due_at=initial_completed_at+86400000) OR (kind='review-7d' AND initial_run_id IS NOT NULL AND completion_event_id IS NOT NULL AND initial_completed_at IS NOT NULL AND created_at=initial_completed_at AND due_at=initial_completed_at+604800000)),
  FOREIGN KEY(assignment_id,child_id,installation_id) REFERENCES pilot_collection_assignment(id,child_id,installation_id),
  FOREIGN KEY(completion_event_id,initial_run_id) REFERENCES pilot_collection_event(id,run_id)
);

CREATE TABLE IF NOT EXISTS pilot_collection_run (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  installation_id TEXT NOT NULL,
  collection_version TEXT NOT NULL,
  collection_digest TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL CHECK(adapter_id='paired-story'),
  adapter_version TEXT NOT NULL CHECK(adapter_version='paired-story-v1'),
  phase TEXT NOT NULL CHECK(phase IN ('initial','review-24h','review-7d')),
  seed INTEGER NOT NULL CHECK(seed>=0 AND seed<=4294967295),
  start_request_id TEXT NOT NULL,
  start_request_json TEXT NOT NULL CHECK(json_valid(start_request_json)),
  start_request_digest TEXT NOT NULL,
  start_ack_json TEXT NOT NULL CHECK(json_valid(start_ack_json)),
  run_json TEXT NOT NULL CHECK(json_valid(run_json)),
  revision INTEGER NOT NULL CHECK(revision>=0),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=created_at),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  test_run_id TEXT,
  UNIQUE(child_id,installation_id,start_request_id),
  FOREIGN KEY(schedule_id,assignment_id,child_id,installation_id) REFERENCES pilot_collection_schedule(id,assignment_id,child_id,installation_id),
  FOREIGN KEY(assignment_id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest) REFERENCES pilot_collection_assignment(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest)
);

CREATE TABLE IF NOT EXISTS pilot_collection_event (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES pilot_collection_run(id),
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  expected_revision INTEGER NOT NULL CHECK(expected_revision=sequence-1),
  request_digest TEXT NOT NULL,
  action_json TEXT NOT NULL CHECK(json_valid(action_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  server_at INTEGER NOT NULL CHECK(server_at>=0),
  UNIQUE(run_id,event_id),
  UNIQUE(run_id,sequence),
  UNIQUE(id,run_id)
);

CREATE TABLE IF NOT EXISTS pilot_collection_learning_audit (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT REFERENCES pilot_collection_run(id),
  plan_id TEXT REFERENCES pilot_collection_plan(id),
  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),
  action TEXT NOT NULL CHECK(action IN ('plan-approval','run-start','run-action')),
  event_id TEXT,
  revision INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  UNIQUE(run_id,revision),
  UNIQUE(plan_id),
  FOREIGN KEY(event_id,run_id) REFERENCES pilot_collection_event(id,run_id),
  CHECK((action='plan-approval' AND plan_id IS NOT NULL AND run_id IS NULL AND event_id IS NULL AND revision IS NULL) OR (action='run-start' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NULL AND revision=0) OR (action='run-action' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NOT NULL AND revision>=1))
);

CREATE TRIGGER IF NOT EXISTS pilot_collection_no_update
BEFORE UPDATE ON pilot_collection
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_no_delete
BEFORE DELETE ON pilot_collection
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_item_no_update
BEFORE UPDATE ON pilot_collection_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_item_no_delete
BEFORE DELETE ON pilot_collection_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_no_update
BEFORE UPDATE ON pilot_collection_proposal
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_no_delete
BEFORE DELETE ON pilot_collection_proposal
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_plan_no_update
BEFORE UPDATE ON pilot_collection_plan
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_plan_no_delete
BEFORE DELETE ON pilot_collection_plan
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_plan_item_no_update
BEFORE UPDATE ON pilot_collection_plan_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_plan_item_no_delete
BEFORE DELETE ON pilot_collection_plan_item
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_assignment_no_update
BEFORE UPDATE ON pilot_collection_assignment
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_assignment_no_delete
BEFORE DELETE ON pilot_collection_assignment
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_schedule_no_update
BEFORE UPDATE ON pilot_collection_schedule
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_schedule_no_delete
BEFORE DELETE ON pilot_collection_schedule
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_event_no_update
BEFORE UPDATE ON pilot_collection_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_event_no_delete
BEFORE DELETE ON pilot_collection_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_learning_audit_no_update
BEFORE UPDATE ON pilot_collection_learning_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_learning_audit_no_delete
BEFORE DELETE ON pilot_collection_learning_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_run_identity
BEFORE UPDATE ON pilot_collection_run
WHEN NEW.id IS NOT OLD.id
  OR NEW.assignment_id IS NOT OLD.assignment_id
  OR NEW.schedule_id IS NOT OLD.schedule_id
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.collection_version IS NOT OLD.collection_version
  OR NEW.collection_digest IS NOT OLD.collection_digest
  OR NEW.lesson_version IS NOT OLD.lesson_version
  OR NEW.content_digest IS NOT OLD.content_digest
  OR NEW.publication_id IS NOT OLD.publication_id
  OR NEW.adapter_id IS NOT OLD.adapter_id
  OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.phase IS NOT OLD.phase
  OR NEW.seed IS NOT OLD.seed
  OR NEW.start_request_id IS NOT OLD.start_request_id
  OR NEW.start_request_json IS NOT OLD.start_request_json
  OR NEW.start_request_digest IS NOT OLD.start_request_digest
  OR NEW.start_ack_json IS NOT OLD.start_ack_json
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.test_run_id IS NOT OLD.test_run_id
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_run_no_delete
BEFORE DELETE ON pilot_collection_run
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_predecessor
BEFORE INSERT ON pilot_collection_proposal
WHEN (NEW.selection_ordinal=1 AND EXISTS(SELECT 1 FROM pilot_collection_proposal p WHERE p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.collection_version=NEW.collection_version)) OR (NEW.selection_ordinal>1 AND NOT EXISTS(SELECT 1 FROM pilot_collection_proposal p WHERE p.id=NEW.predecessor_id AND p.source_digest=NEW.predecessor_source_digest AND p.selection_ordinal=NEW.selection_ordinal-1 AND p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.collection_version=NEW.collection_version AND NOT EXISTS(SELECT 1 FROM pilot_collection_proposal n WHERE n.predecessor_id=p.id)))
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_namespace
BEFORE INSERT ON pilot_collection_proposal
WHEN NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication p WHERE p.id=NEW.publication_id AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_plan_binding
BEFORE INSERT ON pilot_collection_plan
WHEN NOT EXISTS(SELECT 1 FROM pilot_collection_proposal p WHERE p.id=NEW.proposal_id AND p.source_digest=NEW.source_digest AND p.policy_version=NEW.policy_version AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_plan_item_binding
BEFORE INSERT ON pilot_collection_plan_item
WHEN NOT EXISTS(SELECT 1 FROM pilot_collection_plan p JOIN pilot_collection_proposal s ON s.id=p.proposal_id WHERE p.id=NEW.plan_id AND s.publication_id=NEW.publication_id AND s.lesson_version=NEW.lesson_version AND s.content_digest=NEW.content_digest AND s.reason_json=NEW.reason_json)
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_assignment_namespace
BEFORE INSERT ON pilot_collection_assignment
WHEN NOT EXISTS(SELECT 1 FROM pilot_collection_plan_item i JOIN pilot_collection_plan p ON p.id=i.plan_id WHERE i.id=NEW.plan_item_id AND p.test_run_id IS NEW.test_run_id)
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_run_binding
BEFORE INSERT ON pilot_collection_run
WHEN NOT EXISTS(SELECT 1 FROM pilot_collection_schedule s JOIN pilot_collection_assignment a ON a.id=s.assignment_id WHERE s.id=NEW.schedule_id AND s.kind=NEW.phase AND a.test_run_id IS NEW.test_run_id AND NEW.created_at>=s.due_at)
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_schedule_completion
BEFORE INSERT ON pilot_collection_schedule
WHEN (NEW.kind='initial' AND NOT EXISTS(SELECT 1 FROM pilot_collection_assignment a WHERE a.id=NEW.assignment_id AND a.created_at=NEW.created_at)) OR (NEW.kind!='initial' AND NOT EXISTS(SELECT 1 FROM pilot_collection_run r JOIN pilot_collection_event e ON e.run_id=r.id WHERE r.id=NEW.initial_run_id AND r.assignment_id=NEW.assignment_id AND r.child_id=NEW.child_id AND r.installation_id=NEW.installation_id AND r.phase='initial' AND r.completed_at=NEW.initial_completed_at AND e.id=NEW.completion_event_id AND e.server_at=NEW.initial_completed_at AND json_extract(e.result_json,'$.ack.result.outcome')='completed'))
BEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_run_projection
BEFORE UPDATE ON pilot_collection_run
WHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR NOT EXISTS(SELECT 1 FROM pilot_collection_event e WHERE e.run_id=OLD.id AND e.sequence=NEW.revision AND e.server_at=NEW.updated_at)
  OR (NEW.completed_at IS NOT OLD.completed_at AND (NEW.completed_at!=NEW.updated_at OR NOT EXISTS(SELECT 1 FROM pilot_collection_event e WHERE e.run_id=OLD.id AND e.sequence=NEW.revision AND json_extract(e.result_json,'$.ack.result.outcome')='completed')))
BEGIN SELECT RAISE(ABORT,'R5_PROJECTION'); END;

CREATE TRIGGER IF NOT EXISTS pilot_collection_audit_binding
BEFORE INSERT ON pilot_collection_learning_audit
WHEN (NEW.action='plan-approval' AND NOT EXISTS(SELECT 1 FROM pilot_collection_plan p WHERE p.id=NEW.plan_id AND p.parent_id=NEW.actor_id AND p.approved_at=NEW.created_at))
  OR (NEW.action='run-start' AND NOT EXISTS(SELECT 1 FROM pilot_collection_run r WHERE r.id=NEW.run_id AND r.child_id=NEW.actor_id AND r.created_at=NEW.created_at))
  OR (NEW.action='run-action' AND NOT EXISTS(SELECT 1 FROM pilot_collection_run r JOIN pilot_collection_event e ON e.run_id=r.id WHERE r.id=NEW.run_id AND r.child_id=NEW.actor_id AND e.id=NEW.event_id AND e.sequence=NEW.revision AND e.server_at=NEW.created_at))
BEGIN SELECT RAISE(ABORT,'R5_AUDIT_BINDING'); END;

CREATE INDEX IF NOT EXISTS pilot_collection_proposal_lookup_idx ON pilot_collection_proposal(child_id,installation_id,collection_version,selection_ordinal);
CREATE INDEX IF NOT EXISTS pilot_collection_plan_lookup_idx ON pilot_collection_plan(child_id,installation_id,approved_at);
CREATE INDEX IF NOT EXISTS pilot_collection_assignment_lookup_idx ON pilot_collection_assignment(child_id,installation_id);
CREATE INDEX IF NOT EXISTS pilot_collection_schedule_due_idx ON pilot_collection_schedule(child_id,installation_id,due_at);
CREATE INDEX IF NOT EXISTS pilot_collection_run_lookup_idx ON pilot_collection_run(child_id,installation_id,created_at);
