-- Frozen pilot-ops-schema-1; r4-data-1, 27 September 2026.
-- Separate operations database only; never a learning-database migration.
PRAGMA foreign_keys = ON;

CREATE TABLE ops_schema_history (
  version INTEGER PRIMARY KEY CHECK (version = 0),
  name TEXT NOT NULL CHECK (name = '0000_ops.sql'),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
);
CREATE TABLE ops_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL,
  learning_installation_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = 'pilot-ops-schema-1'),
  queue_revision INTEGER NOT NULL DEFAULT 0 CHECK (queue_revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE ops_job (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('backup','monitor','retention','reconcile')),
  utc_slot TEXT NOT NULL,
  objects_json TEXT NOT NULL CHECK (json_valid(objects_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('running','uncertain','succeeded','failed')),
  attempt_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  lease_until INTEGER,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at INTEGER,
  error_code TEXT,
  latest_event_id TEXT NOT NULL,
  UNIQUE (environment,installation_id,ops_installation_id,kind,utc_slot),
  UNIQUE (id,environment,installation_id,ops_installation_id),
  CHECK (lease_until IS NULL OR lease_until >= started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((status = 'running' AND lease_until IS NOT NULL AND ended_at IS NULL)
    OR (status = 'uncertain' AND lease_until IS NULL AND ended_at IS NULL)
    OR (status IN ('succeeded','failed') AND lease_until IS NULL AND ended_at IS NOT NULL)),
  FOREIGN KEY (latest_event_id,id,revision,environment,installation_id,ops_installation_id)
    REFERENCES ops_job_event(id,job_id,sequence,environment,installation_id,ops_installation_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE ops_job_event (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  previous_event_id TEXT,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('acquired','uncertain','archive-verified','completed','failed','reconciled','archive-deleted')),
  status_after TEXT NOT NULL CHECK (status_after IN ('running','uncertain','succeeded','failed')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest,1,7) = 'sha256:'),
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (job_id,sequence),
  UNIQUE (id,job_id,sequence,environment,installation_id,ops_installation_id),
  UNIQUE (id,job_id,environment,installation_id,ops_installation_id),
  CHECK ((sequence = 1 AND previous_event_id IS NULL) OR (sequence > 1 AND previous_event_id IS NOT NULL)),
  FOREIGN KEY (job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job(id,environment,installation_id,ops_installation_id),
  FOREIGN KEY (previous_event_id,job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job_event(id,job_id,environment,installation_id,ops_installation_id)
);
CREATE TABLE ops_archive (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('learning','operations')),
  format TEXT NOT NULL CHECK (format IN ('pilot-admin-backup-4','pilot-ops-backup-1')),
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
  CHECK ((kind = 'learning' AND format = 'pilot-admin-backup-4') OR (kind = 'operations' AND format = 'pilot-ops-backup-1')),
  FOREIGN KEY (job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job(id,environment,installation_id,ops_installation_id),
  FOREIGN KEY (verification_event_id,job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job_event(id,job_id,environment,installation_id,ops_installation_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE ops_alert_event (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  previous_event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('opened','reopened','acknowledged','resolved','notification-delivered','notification-failed')),
  status_after TEXT NOT NULL CHECK (status_after IN ('open','acknowledged','resolved')),
  code TEXT NOT NULL CHECK (code IN ('OPS_BACKUP_FAILED','OPS_PROBE_FAILED','OPS_BACKUP_STALE','OPS_MONITOR_UNKNOWN','OPS_NOTIFICATION_FAILED','OPS_RETENTION_FAILED')),
  job_id TEXT,
  actor_user_id TEXT,
  request_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest,1,7) = 'sha256:'),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (alert_id,sequence),
  UNIQUE (environment,installation_id,ops_installation_id,actor_key,request_id),
  UNIQUE (id,alert_id,environment,installation_id,ops_installation_id),
  CHECK ((sequence = 1 AND previous_event_id IS NULL) OR (sequence > 1 AND previous_event_id IS NOT NULL)),
  CHECK ((sequence = 1 AND kind = 'opened') OR (sequence > 1 AND kind <> 'opened')),
  FOREIGN KEY (job_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_job(id,environment,installation_id,ops_installation_id),
  FOREIGN KEY (previous_event_id,alert_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_alert_event(id,alert_id,environment,installation_id,ops_installation_id)
);
CREATE TABLE ops_feedback (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feedback','observation')),
  submission_build_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('parent','operator')),
  actor_key TEXT NOT NULL,
  operator_user_id TEXT,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest,1,7) = 'sha256:'),
  request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  child_id TEXT,
  run_id TEXT,
  run_installation_id TEXT,
  candidate_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 71 AND substr(content_digest,1,7) = 'sha256:'),
  category TEXT CHECK (category IN ('confusion','sound','saving','access','other')),
  observation_kind TEXT CHECK (observation_kind IN ('actual','synthetic')),
  observed_at INTEGER CHECK (observed_at IS NULL OR observed_at >= 0),
  private_json TEXT CHECK (private_json IS NULL OR json_valid(private_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 2592000000),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  severity TEXT NOT NULL CHECK (severity IN ('blocking','high','normal','low')),
  owner_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','in-progress','awaiting-review','resolved','expired')),
  next_review_at INTEGER CHECK (next_review_at IS NULL OR next_review_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  details_removed_at INTEGER,
  latest_event_id TEXT NOT NULL,
  redaction_event_id TEXT,
  UNIQUE (environment,installation_id,ops_installation_id,actor_key,request_id),
  UNIQUE (id,environment,installation_id,ops_installation_id),
  CHECK ((kind = 'feedback' AND source_role = 'parent' AND child_id IS NOT NULL AND run_id IS NOT NULL AND run_installation_id IS NOT NULL AND category IS NOT NULL AND observation_kind IS NULL AND observed_at IS NULL AND operator_user_id IS NULL)
    OR (kind = 'observation' AND source_role = 'operator' AND child_id IS NULL AND run_id IS NULL AND run_installation_id IS NULL AND category IS NULL AND observation_kind IS NOT NULL AND observed_at IS NOT NULL AND operator_user_id IS NOT NULL)),
  CHECK ((details_removed_at IS NULL AND status <> 'expired' AND private_json IS NOT NULL AND request_json IS NOT NULL AND redaction_event_id IS NULL)
    OR (details_removed_at IS NOT NULL AND details_removed_at >= expires_at AND status = 'expired' AND private_json IS NULL AND request_json IS NULL AND owner_ref IS NULL AND next_review_at IS NULL AND redaction_event_id IS NOT NULL AND redaction_event_id = latest_event_id)),
  FOREIGN KEY (latest_event_id,id,revision,environment,installation_id,ops_installation_id)
    REFERENCES ops_feedback_event(id,record_id,sequence,environment,installation_id,ops_installation_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE ops_feedback_event (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  ops_installation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  previous_event_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('submitted','triaged','corrected','redacted')),
  actor_user_id TEXT,
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest,1,7) = 'sha256:'),
  request_json TEXT CHECK (request_json IS NULL OR json_valid(request_json)),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  private_json TEXT CHECK (private_json IS NULL OR json_valid(private_json)),
  redacted_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (record_id,sequence),
  UNIQUE (environment,installation_id,ops_installation_id,actor_key,request_id),
  UNIQUE (id,record_id,sequence,environment,installation_id,ops_installation_id),
  UNIQUE (id,record_id,environment,installation_id,ops_installation_id),
  CHECK ((sequence = 1 AND previous_event_id IS NULL AND kind = 'submitted') OR (sequence > 1 AND previous_event_id IS NOT NULL AND kind <> 'submitted')),
  CHECK ((redacted_at IS NULL AND kind <> 'redacted' AND request_json IS NOT NULL AND private_json IS NOT NULL)
    OR (redacted_at IS NOT NULL AND request_json IS NULL AND private_json IS NULL)),
  FOREIGN KEY (record_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_feedback(id,environment,installation_id,ops_installation_id),
  FOREIGN KEY (previous_event_id,record_id,environment,installation_id,ops_installation_id)
    REFERENCES ops_feedback_event(id,record_id,environment,installation_id,ops_installation_id)
);

CREATE INDEX ops_job_current ON ops_job(environment,installation_id,ops_installation_id,status,started_at,id);
CREATE INDEX ops_archive_points ON ops_archive(environment,installation_id,ops_installation_id,kind,verified_at,id);
CREATE INDEX ops_alert_latest ON ops_alert_event(environment,installation_id,ops_installation_id,alert_id,sequence DESC);
CREATE UNIQUE INDEX ops_alert_condition ON ops_alert_event(environment,installation_id,ops_installation_id,code) WHERE kind='opened';
CREATE INDEX ops_feedback_queue ON ops_feedback(environment,installation_id,ops_installation_id,status,kind,created_at,id);
CREATE INDEX ops_feedback_expiry ON ops_feedback(details_removed_at,expires_at,id);

CREATE TRIGGER ops_job_event_chain BEFORE INSERT ON ops_job_event WHEN NEW.sequence > 1 BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ops_job_event WHERE id=NEW.previous_event_id AND job_id=NEW.job_id AND sequence=NEW.sequence-1 AND created_at<=NEW.created_at)
    THEN RAISE(ABORT,'OPS_EVENT_CHAIN') END;
END;
CREATE TRIGGER ops_alert_event_chain BEFORE INSERT ON ops_alert_event WHEN NEW.sequence > 1 BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ops_alert_event WHERE id=NEW.previous_event_id AND alert_id=NEW.alert_id AND code=NEW.code AND sequence=NEW.sequence-1 AND created_at<=NEW.created_at)
    THEN RAISE(ABORT,'OPS_EVENT_CHAIN') END;
END;
CREATE TRIGGER ops_feedback_event_chain BEFORE INSERT ON ops_feedback_event WHEN NEW.sequence > 1 BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ops_feedback_event WHERE id=NEW.previous_event_id AND record_id=NEW.record_id AND sequence=NEW.sequence-1 AND created_at<=NEW.created_at)
    THEN RAISE(ABORT,'OPS_EVENT_CHAIN') END;
END;
CREATE TRIGGER ops_feedback_redaction_insert BEFORE INSERT ON ops_feedback_event WHEN NEW.kind='redacted' BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ops_feedback WHERE id=NEW.record_id AND status='expired' AND details_removed_at=NEW.redacted_at AND latest_event_id=NEW.id AND expires_at<=NEW.created_at)
    THEN RAISE(ABORT,'OPS_REDACTION_INVALID') END;
END;
CREATE TRIGGER ops_feedback_expired_final_event BEFORE INSERT ON ops_feedback_event WHEN NEW.kind<>'redacted' BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM ops_feedback WHERE id=NEW.record_id AND status='expired' AND revision=NEW.sequence)
    THEN RAISE(ABORT,'OPS_REDACTION_INVALID') END;
END;
CREATE TRIGGER ops_feedback_expired_projection BEFORE UPDATE ON ops_feedback WHEN NEW.status='expired' BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM ops_feedback_event WHERE id=NEW.latest_event_id AND kind<>'redacted')
    THEN RAISE(ABORT,'OPS_REDACTION_INVALID') END;
END;
CREATE TRIGGER ops_feedback_queue_insert AFTER INSERT ON ops_feedback BEGIN
  UPDATE ops_installation SET queue_revision=queue_revision+1 WHERE id=1;
END;
CREATE TRIGGER ops_feedback_queue_update AFTER UPDATE ON ops_feedback BEGIN
  UPDATE ops_installation SET queue_revision=queue_revision+1 WHERE id=1;
END;

-- Immutable facts. The only private-history UPDATE exception is expiry redaction.
CREATE TRIGGER ops_schema_history_no_update BEFORE UPDATE ON ops_schema_history BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_schema_history_no_delete BEFORE DELETE ON ops_schema_history BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_installation_no_delete BEFORE DELETE ON ops_installation BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_installation_identity BEFORE UPDATE ON ops_installation WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.environment IS NOT OLD.environment OR NEW.learning_installation_id IS NOT OLD.learning_installation_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.created_at IS NOT OLD.created_at OR NEW.queue_revision<OLD.queue_revision BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_job_no_delete BEFORE DELETE ON ops_job BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_job_identity BEFORE UPDATE ON ops_job WHEN NEW.id IS NOT OLD.id OR NEW.environment IS NOT OLD.environment OR NEW.installation_id IS NOT OLD.installation_id OR NEW.ops_installation_id IS NOT OLD.ops_installation_id OR NEW.build_id IS NOT OLD.build_id OR NEW.kind IS NOT OLD.kind OR NEW.utc_slot IS NOT OLD.utc_slot OR NEW.objects_json IS NOT OLD.objects_json OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_job_event_no_update BEFORE UPDATE ON ops_job_event BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_job_event_no_delete BEFORE DELETE ON ops_job_event BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_archive_no_update BEFORE UPDATE ON ops_archive BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_archive_no_delete BEFORE DELETE ON ops_archive BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_alert_event_no_update BEFORE UPDATE ON ops_alert_event BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_alert_event_no_delete BEFORE DELETE ON ops_alert_event BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_feedback_no_delete BEFORE DELETE ON ops_feedback BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_feedback_identity BEFORE UPDATE ON ops_feedback WHEN NEW.id IS NOT OLD.id OR NEW.environment IS NOT OLD.environment OR NEW.installation_id IS NOT OLD.installation_id OR NEW.ops_installation_id IS NOT OLD.ops_installation_id OR NEW.build_id IS NOT OLD.build_id OR NEW.kind IS NOT OLD.kind OR NEW.submission_build_id IS NOT OLD.submission_build_id OR NEW.source_role IS NOT OLD.source_role OR NEW.actor_key IS NOT OLD.actor_key OR NEW.operator_user_id IS NOT OLD.operator_user_id OR NEW.request_id IS NOT OLD.request_id OR NEW.request_digest IS NOT OLD.request_digest OR NEW.receipt_json IS NOT OLD.receipt_json OR NEW.child_id IS NOT OLD.child_id OR NEW.run_id IS NOT OLD.run_id OR NEW.run_installation_id IS NOT OLD.run_installation_id OR NEW.candidate_id IS NOT OLD.candidate_id OR NEW.lesson_id IS NOT OLD.lesson_id OR NEW.lesson_version IS NOT OLD.lesson_version OR NEW.content_digest IS NOT OLD.content_digest OR NEW.category IS NOT OLD.category OR NEW.observation_kind IS NOT OLD.observation_kind OR NEW.observed_at IS NOT OLD.observed_at OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at OR NEW.revision<>OLD.revision+1 OR OLD.details_removed_at IS NOT NULL OR NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_feedback_private_update BEFORE UPDATE ON ops_feedback WHEN (NEW.request_json IS NOT OLD.request_json OR NEW.private_json IS NOT OLD.private_json) AND NOT (NEW.request_json IS NULL AND NEW.private_json IS NULL AND OLD.details_removed_at IS NULL AND NEW.details_removed_at>=OLD.expires_at AND NEW.status='expired') BEGIN SELECT RAISE(ABORT,'OPS_REDACTION_INVALID'); END;
CREATE TRIGGER ops_feedback_event_no_delete BEFORE DELETE ON ops_feedback_event BEGIN SELECT RAISE(ABORT,'OPS_IMMUTABLE'); END;
CREATE TRIGGER ops_feedback_event_redaction BEFORE UPDATE ON ops_feedback_event BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.record_id IS NOT OLD.record_id OR NEW.environment IS NOT OLD.environment OR NEW.installation_id IS NOT OLD.installation_id OR NEW.ops_installation_id IS NOT OLD.ops_installation_id OR NEW.sequence IS NOT OLD.sequence OR NEW.previous_event_id IS NOT OLD.previous_event_id OR NEW.kind IS NOT OLD.kind OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.request_id IS NOT OLD.request_id OR NEW.request_digest IS NOT OLD.request_digest OR NEW.receipt_json IS NOT OLD.receipt_json OR NEW.public_json IS NOT OLD.public_json OR NEW.created_at IS NOT OLD.created_at OR OLD.redacted_at IS NOT NULL OR NEW.request_json IS NOT NULL OR NEW.private_json IS NOT NULL OR NEW.redacted_at IS NULL OR NOT EXISTS (SELECT 1 FROM ops_feedback WHERE id=NEW.record_id AND details_removed_at=NEW.redacted_at AND details_removed_at>=expires_at AND status='expired')
    THEN RAISE(ABORT,'OPS_REDACTION_INVALID') END;
END;
