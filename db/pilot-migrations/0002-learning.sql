PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_installation (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  installation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO pilot_installation(id, installation_id, created_at)
VALUES(1, lower(hex(randomblob(16))), CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS pilot_learning_release (
  lesson_version TEXT PRIMARY KEY NOT NULL,
  release_kind TEXT NOT NULL CHECK (release_kind IN ('owner-approved', 'test-fixture')),
  content_digest TEXT NOT NULL,
  reviewer_label TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  test_run_id TEXT,
  released_at INTEGER NOT NULL,
  CHECK (
    (release_kind = 'owner-approved' AND test_run_id IS NULL) OR
    (release_kind = 'test-fixture' AND test_run_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS pilot_run_ownership_child_lesson_unique
  ON pilot_run_ownership(child_id, lesson_version);

CREATE TABLE IF NOT EXISTS pilot_learning_run (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES pilot_run_ownership(run_id) ON DELETE CASCADE,
  seed INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pilot_learning_event (
  run_id TEXT NOT NULL REFERENCES pilot_learning_run(run_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  phase TEXT NOT NULL,
  step_id TEXT NOT NULL,
  question_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  server_time INTEGER NOT NULL,
  first_response INTEGER NOT NULL,
  assisted INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  PRIMARY KEY (run_id, event_id),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS pilot_learning_event_run_idx ON pilot_learning_event(run_id);

CREATE TABLE IF NOT EXISTS pilot_learning_audit (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES pilot_auth_user(id) ON DELETE SET NULL,
  child_id TEXT REFERENCES pilot_auth_user(id) ON DELETE SET NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_learning_audit_actor_idx ON pilot_learning_audit(actor_user_id);
CREATE INDEX IF NOT EXISTS pilot_learning_audit_child_idx ON pilot_learning_audit(child_id);
