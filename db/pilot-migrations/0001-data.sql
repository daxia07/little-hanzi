PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_schema_history (
  version TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pilot_parent_child (
  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS pilot_parent_child_child_idx ON pilot_parent_child(child_id);

CREATE TABLE IF NOT EXISTS pilot_teacher_grant (
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  granting_parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (child_id, teacher_id, granting_parent_id),
  FOREIGN KEY (granting_parent_id, child_id)
    REFERENCES pilot_parent_child(parent_id, child_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pilot_teacher_grant_teacher_idx ON pilot_teacher_grant(teacher_id);

CREATE TABLE IF NOT EXISTS pilot_account_audit (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES pilot_auth_user(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES pilot_auth_user(id) ON DELETE SET NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_account_audit_target_idx ON pilot_account_audit(target_user_id);
CREATE INDEX IF NOT EXISTS pilot_account_audit_actor_idx ON pilot_account_audit(actor_user_id);

CREATE TABLE IF NOT EXISTS pilot_onboarding (
  child_id TEXT PRIMARY KEY NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  experience TEXT NOT NULL,
  audio_ready INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS pilot_assignment (
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  lesson_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  PRIMARY KEY (child_id, lesson_version)
);

CREATE TABLE IF NOT EXISTS pilot_run_ownership (
  run_id TEXT PRIMARY KEY NOT NULL,
  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  lesson_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_run_ownership_child_idx ON pilot_run_ownership(child_id);
