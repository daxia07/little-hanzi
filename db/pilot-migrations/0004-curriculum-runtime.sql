PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_curriculum_runtime_run (
  run_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  test_run_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose='test-verification'),
  created_by_user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  run_json TEXT NOT NULL CHECK (json_valid(run_json)),
  revision INTEGER NOT NULL CHECK (revision>=0),
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  updated_at INTEGER NOT NULL CHECK (updated_at>=created_at),
  FOREIGN KEY (lesson_version, content_digest)
    REFERENCES pilot_curriculum_package(lesson_version, content_digest) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS pilot_curriculum_runtime_event (
  run_id TEXT NOT NULL REFERENCES pilot_curriculum_runtime_run(run_id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence>=1),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  PRIMARY KEY (run_id, event_id),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS pilot_curriculum_runtime_event_run_idx
  ON pilot_curriculum_runtime_event(run_id);

CREATE TABLE IF NOT EXISTS pilot_curriculum_runtime_audit (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES pilot_curriculum_runtime_run(run_id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create','action')),
  event_id TEXT,
  revision INTEGER NOT NULL CHECK (revision>=0),
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  UNIQUE (run_id, revision),
  FOREIGN KEY (run_id, event_id)
    REFERENCES pilot_curriculum_runtime_event(run_id, event_id) ON DELETE RESTRICT,
  CHECK (
    (action='create' AND event_id IS NULL AND revision=0) OR
    (action='action' AND event_id IS NOT NULL AND revision>=1)
  )
);
CREATE INDEX IF NOT EXISTS pilot_curriculum_runtime_audit_run_idx
  ON pilot_curriculum_runtime_audit(run_id);

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_runtime_run_no_identity_update
BEFORE UPDATE ON pilot_curriculum_runtime_run
WHEN NEW.run_id IS NOT OLD.run_id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.child_id IS NOT OLD.child_id
  OR NEW.lesson_version IS NOT OLD.lesson_version
  OR NEW.content_digest IS NOT OLD.content_digest
  OR NEW.adapter_id IS NOT OLD.adapter_id
  OR NEW.adapter_version IS NOT OLD.adapter_version
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.candidate_id IS NOT OLD.candidate_id
  OR NEW.test_run_id IS NOT OLD.test_run_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_RUN'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_runtime_run_no_delete
BEFORE DELETE ON pilot_curriculum_runtime_run
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_RUN'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_runtime_event_no_update
BEFORE UPDATE ON pilot_curriculum_runtime_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_runtime_event_no_delete
BEFORE DELETE ON pilot_curriculum_runtime_event
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_runtime_audit_no_update
BEFORE UPDATE ON pilot_curriculum_runtime_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_AUDIT'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_runtime_audit_no_delete
BEFORE DELETE ON pilot_curriculum_runtime_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_AUDIT'); END;
