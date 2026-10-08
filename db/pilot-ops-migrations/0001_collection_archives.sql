-- Frozen r5-operations-1; isolated implementation/QA authorized, no production migration.
-- Apply all statements plus the exact version-1 checksum ledger insert atomically.
-- No foreign-key disabling: neither rebuilt table has inbound foreign keys.
CREATE TABLE ops_collection_migration_guard (ok INTEGER NOT NULL CHECK (ok=1));
INSERT INTO ops_collection_migration_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM ops_schema_history)=1 AND
  (SELECT COUNT(*) FROM ops_schema_history WHERE version=0 AND name='0000_ops.sql' AND checksum='26aa0f39b7b8cc7c06e8351f4d1b98d42f35425553db216cbfe5859cd49d429a')=1 AND
  (SELECT COUNT(*) FROM ops_installation WHERE id=1 AND schema_version='pilot-ops-schema-1')=1
THEN 1 ELSE 0 END;
CREATE TABLE ops_archive_next (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('learning','operations')),
  format TEXT NOT NULL CHECK (format IN ('pilot-admin-backup-4','pilot-admin-backup-5','pilot-ops-backup-1','pilot-ops-backup-2')),
  object_ref TEXT NOT NULL,
  key_id TEXT NOT NULL,
  plaintext_digest TEXT NOT NULL CHECK (length(plaintext_digest) = 71 AND substr(plaintext_digest,1,7) = 'sha256:'),
  ciphertext_digest TEXT NOT NULL CHECK (length(ciphertext_digest) = 71 AND substr(ciphertext_digest,1,7) = 'sha256:'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  data_at INTEGER NOT NULL CHECK (data_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= data_at),
  verified_at INTEGER NOT NULL CHECK (verified_at >= created_at),
  daily_slot TEXT NOT NULL,
  weekly_slot TEXT,
  verification_event_id TEXT NOT NULL,
  UNIQUE (job_id,attempt_id,kind),
  UNIQUE (environment,ops_installation_id,object_ref),
  UNIQUE (id,environment,installation_id,ops_installation_id),
  CHECK ((kind = 'learning' AND format IN ('pilot-admin-backup-4','pilot-admin-backup-5')) OR (kind = 'operations' AND format IN ('pilot-ops-backup-1','pilot-ops-backup-2'))),
  FOREIGN KEY (job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job(id,environment,installation_id,ops_installation_id),
  FOREIGN KEY (verification_event_id,job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job_event(id,job_id,environment,installation_id,ops_installation_id)
    DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO ops_archive_next (id,job_id,attempt_id,environment,installation_id,ops_installation_id,build_id,kind,format,object_ref,key_id,plaintext_digest,ciphertext_digest,byte_size,data_at,created_at,verified_at,daily_slot,weekly_slot,verification_event_id) SELECT id,job_id,attempt_id,environment,installation_id,ops_installation_id,build_id,kind,format,object_ref,key_id,plaintext_digest,ciphertext_digest,byte_size,data_at,created_at,verified_at,daily_slot,weekly_slot,verification_event_id FROM ops_archive;
DROP TRIGGER ops_archive_no_update;
DROP TRIGGER ops_archive_no_delete;
DROP INDEX ops_archive_points;
DROP TABLE ops_archive;
ALTER TABLE ops_archive_next RENAME TO ops_archive;
CREATE TABLE ops_installation_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL,
  learning_installation_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = 'pilot-ops-schema-2'),
  queue_revision INTEGER NOT NULL DEFAULT 0 CHECK (queue_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
INSERT INTO ops_installation_next SELECT id,installation_id,environment,learning_installation_id,'pilot-ops-schema-2',queue_revision,created_at FROM ops_installation;
DROP TRIGGER ops_installation_no_delete;
DROP TRIGGER ops_installation_identity;
DROP TRIGGER ops_feedback_queue_insert;
DROP TRIGGER ops_feedback_queue_update;
DROP TABLE ops_installation;
ALTER TABLE ops_installation_next RENAME TO ops_installation;
CREATE TRIGGER ops_feedback_queue_insert AFTER INSERT ON ops_feedback BEGIN
  UPDATE ops_installation SET queue_revision=queue_revision+1 WHERE id=1;
END;
CREATE TRIGGER ops_feedback_queue_update AFTER UPDATE ON ops_feedback BEGIN
  UPDATE ops_installation SET queue_revision=queue_revision+1 WHERE id=1;
END;
CREATE INDEX ops_archive_points ON ops_archive(environment,installation_id,ops_installation_id,kind,verified_at,id);
CREATE TRIGGER ops_installation_no_delete BEFORE DELETE ON ops_installation BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_installation_identity BEFORE UPDATE ON ops_installation WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.environment IS NOT OLD.environment OR NEW.learning_installation_id IS NOT OLD.learning_installation_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.created_at IS NOT OLD.created_at OR NEW.queue_revision<OLD.queue_revision BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_archive_no_update BEFORE UPDATE ON ops_archive BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_archive_no_delete BEFORE DELETE ON ops_archive BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TABLE ops_schema_history_next (
  version INTEGER PRIMARY KEY CHECK (version IN (0,1)),
  name TEXT NOT NULL CHECK ((version=0 AND name='0000_ops.sql') OR (version=1 AND name='0001_collection_archives.sql')),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
);
INSERT INTO ops_schema_history_next SELECT version,name,checksum,applied_at FROM ops_schema_history;
DROP TRIGGER ops_schema_history_no_update;
DROP TRIGGER ops_schema_history_no_delete;
DROP TABLE ops_schema_history;
ALTER TABLE ops_schema_history_next RENAME TO ops_schema_history;
CREATE TRIGGER ops_schema_history_no_update BEFORE UPDATE ON ops_schema_history BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_schema_history_no_delete BEFORE DELETE ON ops_schema_history BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
DROP TABLE ops_collection_migration_guard;
