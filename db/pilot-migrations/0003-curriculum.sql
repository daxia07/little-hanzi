PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_curriculum_registry_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id=1),
  revision INTEGER NOT NULL CHECK (revision>=0),
  updated_at INTEGER NOT NULL CHECK (updated_at>=0)
);
INSERT OR IGNORE INTO pilot_curriculum_registry_state(id,revision,updated_at) VALUES(1,0,0);

CREATE TABLE IF NOT EXISTS pilot_curriculum_package (
  lesson_version TEXT PRIMARY KEY NOT NULL,
  lesson_id TEXT NOT NULL,
  content_digest TEXT NOT NULL UNIQUE CHECK (length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  canonicalization_version TEXT NOT NULL CHECK (canonicalization_version='s3-json-1'),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  import_id TEXT NOT NULL UNIQUE,
  imported_by_user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  imported_at INTEGER NOT NULL CHECK (imported_at>=0),
  test_run_id TEXT,
  UNIQUE (lesson_version, content_digest)
);

CREATE TABLE IF NOT EXISTS pilot_curriculum_character (
  lesson_version TEXT NOT NULL REFERENCES pilot_curriculum_package(lesson_version) ON DELETE RESTRICT,
  character_id TEXT NOT NULL,
  hanzi TEXT NOT NULL,
  character_index INTEGER NOT NULL CHECK (character_index>=0),
  PRIMARY KEY (lesson_version, character_id),
  UNIQUE (lesson_version, hanzi),
  UNIQUE (lesson_version, character_index)
);
CREATE INDEX IF NOT EXISTS pilot_curriculum_character_identity_idx ON pilot_curriculum_character(character_id);

CREATE TABLE IF NOT EXISTS pilot_curriculum_review (
  review_id TEXT PRIMARY KEY NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  review_sequence INTEGER NOT NULL CHECK (review_sequence>=1),
  previous_review_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reviewer_ref TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL CHECK (reviewed_at>=0),
  checklist_version TEXT NOT NULL CHECK (checklist_version='hanzi-review-1'),
  checklist_json TEXT NOT NULL CHECK (json_valid(checklist_json)),
  evidence_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_by_user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  recorded_at INTEGER NOT NULL CHECK (recorded_at>=0),
  request_digest TEXT NOT NULL CHECK (length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
  write_id TEXT NOT NULL UNIQUE,
  test_run_id TEXT,
  UNIQUE (lesson_version, review_sequence),
  UNIQUE (review_id, lesson_version),
  FOREIGN KEY (lesson_version, content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest) ON DELETE RESTRICT,
  FOREIGN KEY (previous_review_id, lesson_version) REFERENCES pilot_curriculum_review(review_id,lesson_version) ON DELETE RESTRICT,
  CHECK ((review_sequence=1 AND previous_review_id IS NULL) OR (review_sequence>1 AND previous_review_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS pilot_curriculum_audit (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('import','review')),
  actor_user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE RESTRICT,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  review_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  FOREIGN KEY (lesson_version, content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest) ON DELETE RESTRICT,
  FOREIGN KEY (review_id, lesson_version) REFERENCES pilot_curriculum_review(review_id,lesson_version) ON DELETE RESTRICT,
  CHECK ((action='import' AND review_id IS NULL) OR (action='review' AND review_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS pilot_curriculum_import_audit_unique ON pilot_curriculum_audit(lesson_version) WHERE action='import';
CREATE UNIQUE INDEX IF NOT EXISTS pilot_curriculum_review_audit_unique ON pilot_curriculum_audit(review_id) WHERE action='review';

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_character_identity
BEFORE INSERT ON pilot_curriculum_character
WHEN EXISTS (SELECT 1 FROM pilot_curriculum_character WHERE character_id=NEW.character_id AND hanzi<>NEW.hanzi)
BEGIN SELECT RAISE(ABORT,'CURRICULUM_CHARACTER_IDENTITY'); END;

CREATE TRIGGER IF NOT EXISTS pilot_curriculum_package_no_update BEFORE UPDATE ON pilot_curriculum_package
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_package_no_delete BEFORE DELETE ON pilot_curriculum_package
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_character_no_update BEFORE UPDATE ON pilot_curriculum_character
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_character_no_delete BEFORE DELETE ON pilot_curriculum_character
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_review_no_update BEFORE UPDATE ON pilot_curriculum_review
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_review_no_delete BEFORE DELETE ON pilot_curriculum_review
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_audit_no_update BEFORE UPDATE ON pilot_curriculum_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
CREATE TRIGGER IF NOT EXISTS pilot_curriculum_audit_no_delete BEFORE DELETE ON pilot_curriculum_audit
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;
