import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const PILOT_AUTH_TABLES = [
  'pilot_auth_user',
  'pilot_auth_session',
  'pilot_auth_account',
  'pilot_auth_verification',
  'pilot_auth_rate_limit',
] as const;

export const PILOT_DATA_TABLES = [
  'pilot_schema_history',
  'pilot_parent_child',
  'pilot_teacher_grant',
  'pilot_account_audit',
  'pilot_onboarding',
  'pilot_assignment',
  'pilot_run_ownership',
  'pilot_installation',
  'pilot_learning_release',
  'pilot_learning_run',
  'pilot_learning_event',
  'pilot_learning_audit',
  'pilot_curriculum_registry_state',
  'pilot_curriculum_package',
  'pilot_curriculum_character',
  'pilot_curriculum_review',
  'pilot_curriculum_audit',
  'pilot_curriculum_runtime_run',
  'pilot_curriculum_runtime_event',
  'pilot_curriculum_runtime_audit',
] as const;

export const PILOT_MIGRATION_VERSIONS = [
  'pilot-auth-0000',
  'pilot-data-0001',
  'pilot-learning-0002',
  'pilot-curriculum-0003',
  'pilot-curriculum-runtime-0004',
] as const;

export const pilotAuthUser = sqliteTable(
  'pilot_auth_user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' })
      .notNull()
      .default(false),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    username: text('username'),
    displayUsername: text('display_username'),
    role: text('role').notNull().default('child'),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' })
      .notNull()
      .default(true),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    uniqueIndex('pilot_auth_user_email_unique').on(table.email),
    uniqueIndex('pilot_auth_user_username_unique').on(table.username),
  ],
);

export const pilotAuthSession = sqliteTable(
  'pilot_auth_session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('pilot_auth_session_token_unique').on(table.token),
    index('pilot_auth_session_user_idx').on(table.userId),
  ],
);

export const pilotAuthAccount = sqliteTable(
  'pilot_auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('pilot_auth_account_user_idx').on(table.userId)],
);

export const pilotAuthVerification = sqliteTable(
  'pilot_auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('pilot_auth_verification_identifier_idx').on(table.identifier),
  ],
);

export const pilotAuthRateLimit = sqliteTable(
  'pilot_auth_rate_limit',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: integer('last_request').notNull(),
  },
  (table) => [uniqueIndex('pilot_auth_rate_limit_key_unique').on(table.key)],
);

export const pilotParentChild = sqliteTable(
  'pilot_parent_child',
  {
    parentId: text('parent_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    childId: text('child_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.parentId, table.childId] }),
    index('pilot_parent_child_child_idx').on(table.childId),
  ],
);

export const pilotTeacherGrant = sqliteTable(
  'pilot_teacher_grant',
  {
    childId: text('child_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    teacherId: text('teacher_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    grantingParentId: text('granting_parent_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.childId, table.teacherId, table.grantingParentId],
    }),
    foreignKey({
      columns: [table.grantingParentId, table.childId],
      foreignColumns: [pilotParentChild.parentId, pilotParentChild.childId],
      name: 'pilot_teacher_grant_link_fk',
    }).onDelete('cascade'),
    index('pilot_teacher_grant_teacher_idx').on(table.teacherId),
  ],
);

export const pilotAccountAudit = sqliteTable(
  'pilot_account_audit',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    actorUserId: text('actor_user_id').references(() => pilotAuthUser.id, {
      onDelete: 'set null',
    }),
    targetUserId: text('target_user_id').references(() => pilotAuthUser.id, {
      onDelete: 'set null',
    }),
    metadata: text('metadata').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('pilot_account_audit_target_idx').on(table.targetUserId),
    index('pilot_account_audit_actor_idx').on(table.actorUserId),
  ],
);

export const pilotOnboarding = sqliteTable('pilot_onboarding', {
  childId: text('child_id')
    .primaryKey()
    .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
  nickname: text('nickname').notNull(),
  experience: text('experience').notNull(),
  audioReady: integer('audio_ready', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  updatedBy: text('updated_by')
    .notNull()
    .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
});

export const pilotAssignment = sqliteTable(
  'pilot_assignment',
  {
    childId: text('child_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    lessonVersion: text('lesson_version').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.childId, table.lessonVersion] })],
);

export const pilotRunOwnership = sqliteTable(
  'pilot_run_ownership',
  {
    runId: text('run_id').primaryKey(),
    childId: text('child_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'cascade' }),
    lessonVersion: text('lesson_version').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('pilot_run_ownership_child_idx').on(table.childId),
    uniqueIndex('pilot_run_ownership_child_lesson_unique').on(
      table.childId,
      table.lessonVersion,
    ),
  ],
);

export const pilotInstallation = sqliteTable(
  'pilot_installation',
  {
    id: integer('id').primaryKey(),
    installationId: text('installation_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('pilot_installation_id_unique').on(table.installationId),
  ],
);

export const pilotLearningRelease = sqliteTable('pilot_learning_release', {
  lessonVersion: text('lesson_version').primaryKey(),
  releaseKind: text('release_kind').notNull(),
  contentDigest: text('content_digest').notNull(),
  reviewerLabel: text('reviewer_label').notNull(),
  evidenceRef: text('evidence_ref').notNull(),
  candidateId: text('candidate_id').notNull(),
  testRunId: text('test_run_id'),
  releasedAt: integer('released_at', { mode: 'timestamp_ms' }).notNull(),
});

export const pilotLearningRun = sqliteTable('pilot_learning_run', {
  runId: text('run_id')
    .primaryKey()
    .references(() => pilotRunOwnership.runId, { onDelete: 'cascade' }),
  seed: integer('seed').notNull(),
  stateJson: text('state_json').notNull(),
  revision: integer('revision').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const pilotLearningEvent = sqliteTable(
  'pilot_learning_event',
  {
    runId: text('run_id')
      .notNull()
      .references(() => pilotLearningRun.runId, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    sequence: integer('sequence').notNull(),
    phase: text('phase').notNull(),
    stepId: text('step_id').notNull(),
    questionId: text('question_id'),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    actionJson: text('action_json').notNull(),
    serverTime: integer('server_time', { mode: 'timestamp_ms' }).notNull(),
    firstResponse: integer('first_response', { mode: 'boolean' }).notNull(),
    assisted: integer('assisted', { mode: 'boolean' }).notNull(),
    outcome: text('outcome').notNull(),
    ackJson: text('ack_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.eventId] }),
    uniqueIndex('pilot_learning_event_run_sequence_unique').on(
      table.runId,
      table.sequence,
    ),
    index('pilot_learning_event_run_idx').on(table.runId),
  ],
);

export const pilotLearningAudit = sqliteTable(
  'pilot_learning_audit',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    actorUserId: text('actor_user_id').references(() => pilotAuthUser.id, {
      onDelete: 'set null',
    }),
    childId: text('child_id').references(() => pilotAuthUser.id, {
      onDelete: 'set null',
    }),
    metadata: text('metadata').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('pilot_learning_audit_actor_idx').on(table.actorUserId),
    index('pilot_learning_audit_child_idx').on(table.childId),
  ],
);

export const pilotCurriculumRegistryState = sqliteTable(
  'pilot_curriculum_registry_state',
  {
    id: integer('id').primaryKey(),
    revision: integer('revision').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
);

export const pilotCurriculumPackage = sqliteTable(
  'pilot_curriculum_package',
  {
    lessonVersion: text('lesson_version').primaryKey(),
    lessonId: text('lesson_id').notNull(),
    contentDigest: text('content_digest').notNull().unique(),
    canonicalizationVersion: text('canonicalization_version').notNull(),
    manifestJson: text('manifest_json').notNull(),
    importId: text('import_id').notNull().unique(),
    importedByUserId: text('imported_by_user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
    importedAt: integer('imported_at').notNull(),
    testRunId: text('test_run_id'),
  },
  (table) => [
    uniqueIndex('pilot_curriculum_package_version_digest').on(
      table.lessonVersion,
      table.contentDigest,
    ),
  ],
);

export const pilotCurriculumCharacter = sqliteTable(
  'pilot_curriculum_character',
  {
    lessonVersion: text('lesson_version')
      .notNull()
      .references(() => pilotCurriculumPackage.lessonVersion, {
        onDelete: 'restrict',
      }),
    characterId: text('character_id').notNull(),
    hanzi: text('hanzi').notNull(),
    characterIndex: integer('character_index').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.lessonVersion, table.characterId] }),
    uniqueIndex('pilot_curriculum_character_hanzi').on(
      table.lessonVersion,
      table.hanzi,
    ),
    uniqueIndex('pilot_curriculum_character_index').on(
      table.lessonVersion,
      table.characterIndex,
    ),
    index('pilot_curriculum_character_identity_idx').on(table.characterId),
  ],
);

export const pilotCurriculumReview = sqliteTable(
  'pilot_curriculum_review',
  {
    reviewId: text('review_id').primaryKey(),
    lessonVersion: text('lesson_version').notNull(),
    contentDigest: text('content_digest').notNull(),
    reviewSequence: integer('review_sequence').notNull(),
    previousReviewId: text('previous_review_id'),
    decision: text('decision').notNull(),
    reviewerRef: text('reviewer_ref').notNull(),
    reviewedAt: integer('reviewed_at').notNull(),
    checklistVersion: text('checklist_version').notNull(),
    checklistJson: text('checklist_json').notNull(),
    evidenceRef: text('evidence_ref').notNull(),
    reason: text('reason').notNull(),
    recordedByUserId: text('recorded_by_user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
    recordedAt: integer('recorded_at').notNull(),
    requestDigest: text('request_digest').notNull(),
    writeId: text('write_id').notNull().unique(),
    testRunId: text('test_run_id'),
  },
  (table) => [
    uniqueIndex('pilot_curriculum_review_sequence').on(
      table.lessonVersion,
      table.reviewSequence,
    ),
    uniqueIndex('pilot_curriculum_review_identity').on(
      table.reviewId,
      table.lessonVersion,
    ),
    foreignKey({
      columns: [table.lessonVersion, table.contentDigest],
      foreignColumns: [
        pilotCurriculumPackage.lessonVersion,
        pilotCurriculumPackage.contentDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.previousReviewId, table.lessonVersion],
      foreignColumns: [table.reviewId, table.lessonVersion],
    }).onDelete('restrict'),
  ],
);

export const pilotCurriculumAudit = sqliteTable(
  'pilot_curriculum_audit',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
    lessonVersion: text('lesson_version').notNull(),
    contentDigest: text('content_digest').notNull(),
    reviewId: text('review_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.lessonVersion, table.contentDigest],
      foreignColumns: [
        pilotCurriculumPackage.lessonVersion,
        pilotCurriculumPackage.contentDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.reviewId, table.lessonVersion],
      foreignColumns: [
        pilotCurriculumReview.reviewId,
        pilotCurriculumReview.lessonVersion,
      ],
    }).onDelete('restrict'),
  ],
);

export const pilotCurriculumRuntimeRun = sqliteTable(
  'pilot_curriculum_runtime_run',
  {
    runId: text('run_id').primaryKey(),
    requestId: text('request_id').notNull().unique(),
    requestDigest: text('request_digest').notNull(),
    childId: text('child_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
    lessonVersion: text('lesson_version').notNull(),
    contentDigest: text('content_digest').notNull(),
    adapterId: text('adapter_id').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    installationId: text('installation_id').notNull(),
    candidateId: text('candidate_id').notNull(),
    testRunId: text('test_run_id').notNull(),
    purpose: text('purpose').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
    runJson: text('run_json').notNull(),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.lessonVersion, table.contentDigest],
      foreignColumns: [
        pilotCurriculumPackage.lessonVersion,
        pilotCurriculumPackage.contentDigest,
      ],
      name: 'pilot_curriculum_runtime_run_package_fk',
    }).onDelete('restrict'),
    uniqueIndex('pilot_curriculum_runtime_run_request_unique').on(
      table.requestId,
    ),
  ],
);

export const pilotCurriculumRuntimeEvent = sqliteTable(
  'pilot_curriculum_runtime_event',
  {
    runId: text('run_id')
      .notNull()
      .references(() => pilotCurriculumRuntimeRun.runId, {
        onDelete: 'restrict',
      }),
    eventId: text('event_id').notNull(),
    sequence: integer('sequence').notNull(),
    eventJson: text('event_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.eventId] }),
    uniqueIndex('pilot_curriculum_runtime_event_sequence_unique').on(
      table.runId,
      table.sequence,
    ),
    index('pilot_curriculum_runtime_event_run_idx').on(table.runId),
  ],
);

export const pilotCurriculumRuntimeAudit = sqliteTable(
  'pilot_curriculum_runtime_audit',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => pilotCurriculumRuntimeRun.runId, {
        onDelete: 'restrict',
      }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => pilotAuthUser.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    eventId: text('event_id'),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('pilot_curriculum_runtime_audit_revision_unique').on(
      table.runId,
      table.revision,
    ),
    foreignKey({
      columns: [table.runId, table.eventId],
      foreignColumns: [
        pilotCurriculumRuntimeEvent.runId,
        pilotCurriculumRuntimeEvent.eventId,
      ],
      name: 'pilot_curriculum_runtime_audit_event_fk',
    }).onDelete('restrict'),
    index('pilot_curriculum_runtime_audit_run_idx').on(table.runId),
  ],
);

export const pilotAuthSchema = {
  user: pilotAuthUser,
  session: pilotAuthSession,
  account: pilotAuthAccount,
  verification: pilotAuthVerification,
  rateLimit: pilotAuthRateLimit,
};

export const pilotDataSchema = {
  parentChild: pilotParentChild,
  teacherGrant: pilotTeacherGrant,
  accountAudit: pilotAccountAudit,
  onboarding: pilotOnboarding,
  assignment: pilotAssignment,
  runOwnership: pilotRunOwnership,
  installation: pilotInstallation,
  learningRelease: pilotLearningRelease,
  learningRun: pilotLearningRun,
  learningEvent: pilotLearningEvent,
  learningAudit: pilotLearningAudit,
  curriculumRegistryState: pilotCurriculumRegistryState,
  curriculumPackage: pilotCurriculumPackage,
  curriculumCharacter: pilotCurriculumCharacter,
  curriculumReview: pilotCurriculumReview,
  curriculumAudit: pilotCurriculumAudit,
  curriculumRuntimeRun: pilotCurriculumRuntimeRun,
  curriculumRuntimeEvent: pilotCurriculumRuntimeEvent,
  curriculumRuntimeAudit: pilotCurriculumRuntimeAudit,
};

export const PILOT_AUTH_MODEL_NAMES = {
  user: 'pilot_auth_user',
  session: 'pilot_auth_session',
  account: 'pilot_auth_account',
  verification: 'pilot_auth_verification',
  rateLimit: 'pilot_auth_rate_limit',
} as const;

export const PILOT_AUTH_MIGRATION_SQL = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pilot_auth_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  username TEXT UNIQUE,
  display_username TEXT,
  role TEXT NOT NULL DEFAULT 'child',
  must_change_password INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pilot_auth_session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pilot_auth_session_user_idx ON pilot_auth_session(user_id);

CREATE TABLE IF NOT EXISTS pilot_auth_account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES pilot_auth_user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_auth_account_user_idx ON pilot_auth_account(user_id);

CREATE TABLE IF NOT EXISTS pilot_auth_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pilot_auth_verification_identifier_idx ON pilot_auth_verification(identifier);

CREATE TABLE IF NOT EXISTS pilot_auth_rate_limit (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);`;

export const PILOT_DATA_MIGRATION_SQL = `PRAGMA foreign_keys = ON;

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
CREATE INDEX IF NOT EXISTS pilot_run_ownership_child_idx ON pilot_run_ownership(child_id);`;

export const PILOT_LEARNING_MIGRATION_SQL = `PRAGMA foreign_keys = ON;

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
CREATE INDEX IF NOT EXISTS pilot_learning_audit_child_idx ON pilot_learning_audit(child_id);`;

export const PILOT_CURRICULUM_MIGRATION_SQL = `PRAGMA foreign_keys = ON;

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
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM'); END;`;

export const PILOT_CURRICULUM_RUNTIME_MIGRATION_SQL = `PRAGMA foreign_keys = ON;

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
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CURRICULUM_RUNTIME_AUDIT'); END;`;

/** Additive R3 boundary; historical migration SQL constants above are unchanged. */
export const PILOT_FAMILY_STORY_MIGRATION_SQL = `PRAGMA foreign_keys = ON;

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
`;

export const PILOT_COLLECTION_MIGRATION_SQL =
  "-- Frozen r5-data-1 additive schema. Isolated QA authorized; production migration is a separate release action.\nPRAGMA foreign_keys = ON;\n\nCREATE TABLE IF NOT EXISTS pilot_collection (\n  collection_version TEXT PRIMARY KEY NOT NULL,\n  collection_id TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  canonicalization_version TEXT NOT NULL CHECK(canonicalization_version='s3-json-1'),\n  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),\n  imported_by TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  imported_at INTEGER NOT NULL CHECK(imported_at>=0),\n  UNIQUE(collection_version,collection_digest)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_item (\n  collection_version TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<=999999),\n  lesson_version TEXT NOT NULL,\n  content_digest TEXT NOT NULL,\n  track_id TEXT NOT NULL,\n  sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=1000000),\n  prerequisites_json TEXT NOT NULL CHECK(json_valid(prerequisites_json) AND json_type(prerequisites_json)='array'),\n  PRIMARY KEY(collection_version,ordinal),\n  UNIQUE(collection_version,lesson_version),\n  UNIQUE(collection_version,sequence),\n  UNIQUE(collection_version,collection_digest,lesson_version,content_digest),\n  FOREIGN KEY(collection_version,collection_digest) REFERENCES pilot_collection(collection_version,collection_digest),\n  FOREIGN KEY(lesson_version,content_digest) REFERENCES pilot_curriculum_package(lesson_version,content_digest)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_proposal (\n  id TEXT PRIMARY KEY NOT NULL,\n  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  installation_id TEXT NOT NULL,\n  collection_version TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  selection_ordinal INTEGER NOT NULL CHECK(selection_ordinal>=1),\n  predecessor_id TEXT UNIQUE,\n  predecessor_source_digest TEXT,\n  selected_by_parent INTEGER NOT NULL CHECK(selected_by_parent IN (0,1)),\n  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  policy_version TEXT NOT NULL CHECK(policy_version='r5-placement-1'),\n  source_digest TEXT NOT NULL,\n  source_json TEXT NOT NULL CHECK(json_valid(source_json)),\n  onboarding_digest TEXT NOT NULL,\n  evidence_digest TEXT NOT NULL,\n  publication_digest TEXT NOT NULL,\n  publication_id TEXT NOT NULL,\n  lesson_version TEXT NOT NULL,\n  content_digest TEXT NOT NULL,\n  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),\n  request_json TEXT NOT NULL CHECK(json_valid(request_json)),\n  request_digest TEXT NOT NULL,\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  expires_at INTEGER NOT NULL CHECK(expires_at=created_at+86400000),\n  test_run_id TEXT,\n  UNIQUE(child_id,installation_id,collection_version,selection_ordinal),\n  UNIQUE(id,child_id,installation_id,collection_version,collection_digest),\n  CHECK((selection_ordinal=1 AND predecessor_id IS NULL AND predecessor_source_digest IS NULL) OR (selection_ordinal>1 AND predecessor_id IS NOT NULL AND predecessor_source_digest IS NOT NULL)),\n  FOREIGN KEY(predecessor_id,child_id,installation_id,collection_version,collection_digest) REFERENCES pilot_collection_proposal(id,child_id,installation_id,collection_version,collection_digest),\n  FOREIGN KEY(collection_version,collection_digest,lesson_version,content_digest) REFERENCES pilot_collection_item(collection_version,collection_digest,lesson_version,content_digest),\n  FOREIGN KEY(publication_id,lesson_version,content_digest,installation_id) REFERENCES pilot_curriculum_publication(id,lesson_version,content_digest,installation_id)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_plan (\n  id TEXT PRIMARY KEY NOT NULL,\n  proposal_id TEXT NOT NULL UNIQUE,\n  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  installation_id TEXT NOT NULL,\n  collection_version TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  parent_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  policy_version TEXT NOT NULL CHECK(policy_version='r5-placement-1'),\n  source_digest TEXT NOT NULL,\n  request_json TEXT NOT NULL CHECK(json_valid(request_json)),\n  request_digest TEXT NOT NULL,\n  ack_json TEXT NOT NULL CHECK(json_valid(ack_json)),\n  approved_at INTEGER NOT NULL CHECK(approved_at>=0),\n  test_run_id TEXT,\n  UNIQUE(id,child_id,installation_id,collection_version,collection_digest),\n  FOREIGN KEY(proposal_id,child_id,installation_id,collection_version,collection_digest) REFERENCES pilot_collection_proposal(id,child_id,installation_id,collection_version,collection_digest)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_plan_item (\n  id TEXT PRIMARY KEY NOT NULL,\n  plan_id TEXT NOT NULL,\n  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  installation_id TEXT NOT NULL,\n  collection_version TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  ordinal INTEGER NOT NULL CHECK(ordinal=0),\n  publication_id TEXT NOT NULL,\n  lesson_version TEXT NOT NULL,\n  content_digest TEXT NOT NULL,\n  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),\n  UNIQUE(plan_id,ordinal),\n  UNIQUE(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest),\n  FOREIGN KEY(plan_id,child_id,installation_id,collection_version,collection_digest) REFERENCES pilot_collection_plan(id,child_id,installation_id,collection_version,collection_digest),\n  FOREIGN KEY(collection_version,collection_digest,lesson_version,content_digest) REFERENCES pilot_collection_item(collection_version,collection_digest,lesson_version,content_digest),\n  FOREIGN KEY(publication_id,lesson_version,content_digest,installation_id) REFERENCES pilot_curriculum_publication(id,lesson_version,content_digest,installation_id)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_assignment (\n  id TEXT PRIMARY KEY NOT NULL,\n  plan_item_id TEXT NOT NULL UNIQUE,\n  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  installation_id TEXT NOT NULL,\n  collection_version TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  lesson_version TEXT NOT NULL,\n  content_digest TEXT NOT NULL,\n  publication_id TEXT NOT NULL,\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  test_run_id TEXT,\n  UNIQUE(id,child_id,installation_id),\n  UNIQUE(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest),\n  FOREIGN KEY(plan_item_id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest) REFERENCES pilot_collection_plan_item(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_schedule (\n  id TEXT PRIMARY KEY NOT NULL,\n  assignment_id TEXT NOT NULL,\n  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  installation_id TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK(kind IN ('initial','review-24h','review-7d')),\n  due_at INTEGER NOT NULL CHECK(due_at>=0),\n  policy_version TEXT NOT NULL CHECK(policy_version='r5-review-24h-7d-1'),\n  initial_run_id TEXT,\n  completion_event_id TEXT,\n  initial_completed_at INTEGER,\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  UNIQUE(assignment_id,kind),\n  UNIQUE(id,assignment_id,child_id,installation_id),\n  CHECK((kind='initial' AND initial_run_id IS NULL AND completion_event_id IS NULL AND initial_completed_at IS NULL AND due_at=created_at) OR (kind='review-24h' AND initial_run_id IS NOT NULL AND completion_event_id IS NOT NULL AND initial_completed_at IS NOT NULL AND created_at=initial_completed_at AND due_at=initial_completed_at+86400000) OR (kind='review-7d' AND initial_run_id IS NOT NULL AND completion_event_id IS NOT NULL AND initial_completed_at IS NOT NULL AND created_at=initial_completed_at AND due_at=initial_completed_at+604800000)),\n  FOREIGN KEY(assignment_id,child_id,installation_id) REFERENCES pilot_collection_assignment(id,child_id,installation_id),\n  FOREIGN KEY(completion_event_id,initial_run_id) REFERENCES pilot_collection_event(id,run_id)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_run (\n  id TEXT PRIMARY KEY NOT NULL,\n  assignment_id TEXT NOT NULL,\n  schedule_id TEXT NOT NULL UNIQUE,\n  child_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  installation_id TEXT NOT NULL,\n  collection_version TEXT NOT NULL,\n  collection_digest TEXT NOT NULL,\n  lesson_version TEXT NOT NULL,\n  content_digest TEXT NOT NULL,\n  publication_id TEXT NOT NULL,\n  adapter_id TEXT NOT NULL CHECK(adapter_id='paired-story'),\n  adapter_version TEXT NOT NULL CHECK(adapter_version='paired-story-v1'),\n  phase TEXT NOT NULL CHECK(phase IN ('initial','review-24h','review-7d')),\n  seed INTEGER NOT NULL CHECK(seed>=0 AND seed<=4294967295),\n  start_request_id TEXT NOT NULL,\n  start_request_json TEXT NOT NULL CHECK(json_valid(start_request_json)),\n  start_request_digest TEXT NOT NULL,\n  start_ack_json TEXT NOT NULL CHECK(json_valid(start_ack_json)),\n  run_json TEXT NOT NULL CHECK(json_valid(run_json)),\n  revision INTEGER NOT NULL CHECK(revision>=0),\n  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=created_at),\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),\n  test_run_id TEXT,\n  UNIQUE(child_id,installation_id,start_request_id),\n  FOREIGN KEY(schedule_id,assignment_id,child_id,installation_id) REFERENCES pilot_collection_schedule(id,assignment_id,child_id,installation_id),\n  FOREIGN KEY(assignment_id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest) REFERENCES pilot_collection_assignment(id,child_id,installation_id,collection_version,collection_digest,publication_id,lesson_version,content_digest)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_event (\n  id TEXT PRIMARY KEY NOT NULL,\n  run_id TEXT NOT NULL REFERENCES pilot_collection_run(id),\n  event_id TEXT NOT NULL,\n  sequence INTEGER NOT NULL CHECK(sequence>=1),\n  expected_revision INTEGER NOT NULL CHECK(expected_revision=sequence-1),\n  request_digest TEXT NOT NULL,\n  action_json TEXT NOT NULL CHECK(json_valid(action_json)),\n  result_json TEXT NOT NULL CHECK(json_valid(result_json)),\n  server_at INTEGER NOT NULL CHECK(server_at>=0),\n  UNIQUE(run_id,event_id),\n  UNIQUE(run_id,sequence),\n  UNIQUE(id,run_id)\n);\n\nCREATE TABLE IF NOT EXISTS pilot_collection_learning_audit (\n  id TEXT PRIMARY KEY NOT NULL,\n  run_id TEXT REFERENCES pilot_collection_run(id),\n  plan_id TEXT REFERENCES pilot_collection_plan(id),\n  actor_id TEXT NOT NULL REFERENCES pilot_auth_user(id),\n  action TEXT NOT NULL CHECK(action IN ('plan-approval','run-start','run-action')),\n  event_id TEXT,\n  revision INTEGER,\n  created_at INTEGER NOT NULL CHECK(created_at>=0),\n  UNIQUE(run_id,revision),\n  UNIQUE(plan_id),\n  FOREIGN KEY(event_id,run_id) REFERENCES pilot_collection_event(id,run_id),\n  CHECK((action='plan-approval' AND plan_id IS NOT NULL AND run_id IS NULL AND event_id IS NULL AND revision IS NULL) OR (action='run-start' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NULL AND revision=0) OR (action='run-action' AND run_id IS NOT NULL AND plan_id IS NULL AND event_id IS NOT NULL AND revision>=1))\n);\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_no_update\nBEFORE UPDATE ON pilot_collection\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_no_delete\nBEFORE DELETE ON pilot_collection\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_item_no_update\nBEFORE UPDATE ON pilot_collection_item\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_item_no_delete\nBEFORE DELETE ON pilot_collection_item\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_no_update\nBEFORE UPDATE ON pilot_collection_proposal\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_no_delete\nBEFORE DELETE ON pilot_collection_proposal\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_plan_no_update\nBEFORE UPDATE ON pilot_collection_plan\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_plan_no_delete\nBEFORE DELETE ON pilot_collection_plan\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_plan_item_no_update\nBEFORE UPDATE ON pilot_collection_plan_item\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_plan_item_no_delete\nBEFORE DELETE ON pilot_collection_plan_item\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_assignment_no_update\nBEFORE UPDATE ON pilot_collection_assignment\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_assignment_no_delete\nBEFORE DELETE ON pilot_collection_assignment\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_schedule_no_update\nBEFORE UPDATE ON pilot_collection_schedule\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_schedule_no_delete\nBEFORE DELETE ON pilot_collection_schedule\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_event_no_update\nBEFORE UPDATE ON pilot_collection_event\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_event_no_delete\nBEFORE DELETE ON pilot_collection_event\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_learning_audit_no_update\nBEFORE UPDATE ON pilot_collection_learning_audit\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_learning_audit_no_delete\nBEFORE DELETE ON pilot_collection_learning_audit\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_run_identity\nBEFORE UPDATE ON pilot_collection_run\nWHEN NEW.id IS NOT OLD.id\n  OR NEW.assignment_id IS NOT OLD.assignment_id\n  OR NEW.schedule_id IS NOT OLD.schedule_id\n  OR NEW.child_id IS NOT OLD.child_id\n  OR NEW.installation_id IS NOT OLD.installation_id\n  OR NEW.collection_version IS NOT OLD.collection_version\n  OR NEW.collection_digest IS NOT OLD.collection_digest\n  OR NEW.lesson_version IS NOT OLD.lesson_version\n  OR NEW.content_digest IS NOT OLD.content_digest\n  OR NEW.publication_id IS NOT OLD.publication_id\n  OR NEW.adapter_id IS NOT OLD.adapter_id\n  OR NEW.adapter_version IS NOT OLD.adapter_version\n  OR NEW.phase IS NOT OLD.phase\n  OR NEW.seed IS NOT OLD.seed\n  OR NEW.start_request_id IS NOT OLD.start_request_id\n  OR NEW.start_request_json IS NOT OLD.start_request_json\n  OR NEW.start_request_digest IS NOT OLD.start_request_digest\n  OR NEW.start_ack_json IS NOT OLD.start_ack_json\n  OR NEW.created_at IS NOT OLD.created_at\n  OR NEW.test_run_id IS NOT OLD.test_run_id\n  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_run_no_delete\nBEFORE DELETE ON pilot_collection_run\nBEGIN SELECT RAISE(ABORT,'IMMUTABLE_R5_FACT'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_predecessor\nBEFORE INSERT ON pilot_collection_proposal\nWHEN (NEW.selection_ordinal=1 AND EXISTS(SELECT 1 FROM pilot_collection_proposal p WHERE p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.collection_version=NEW.collection_version)) OR (NEW.selection_ordinal>1 AND NOT EXISTS(SELECT 1 FROM pilot_collection_proposal p WHERE p.id=NEW.predecessor_id AND p.source_digest=NEW.predecessor_source_digest AND p.selection_ordinal=NEW.selection_ordinal-1 AND p.child_id=NEW.child_id AND p.installation_id=NEW.installation_id AND p.collection_version=NEW.collection_version AND NOT EXISTS(SELECT 1 FROM pilot_collection_proposal n WHERE n.predecessor_id=p.id)))\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_proposal_namespace\nBEFORE INSERT ON pilot_collection_proposal\nWHEN NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication p WHERE p.id=NEW.publication_id AND p.test_run_id IS NEW.test_run_id)\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_plan_binding\nBEFORE INSERT ON pilot_collection_plan\nWHEN NOT EXISTS(SELECT 1 FROM pilot_collection_proposal p WHERE p.id=NEW.proposal_id AND p.source_digest=NEW.source_digest AND p.policy_version=NEW.policy_version AND p.test_run_id IS NEW.test_run_id)\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_plan_item_binding\nBEFORE INSERT ON pilot_collection_plan_item\nWHEN NOT EXISTS(SELECT 1 FROM pilot_collection_plan p JOIN pilot_collection_proposal s ON s.id=p.proposal_id WHERE p.id=NEW.plan_id AND s.publication_id=NEW.publication_id AND s.lesson_version=NEW.lesson_version AND s.content_digest=NEW.content_digest AND s.reason_json=NEW.reason_json)\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_assignment_namespace\nBEFORE INSERT ON pilot_collection_assignment\nWHEN NOT EXISTS(SELECT 1 FROM pilot_collection_plan_item i JOIN pilot_collection_plan p ON p.id=i.plan_id WHERE i.id=NEW.plan_item_id AND p.test_run_id IS NEW.test_run_id)\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_run_binding\nBEFORE INSERT ON pilot_collection_run\nWHEN NOT EXISTS(SELECT 1 FROM pilot_collection_schedule s JOIN pilot_collection_assignment a ON a.id=s.assignment_id WHERE s.id=NEW.schedule_id AND s.kind=NEW.phase AND a.test_run_id IS NEW.test_run_id AND NEW.created_at>=s.due_at)\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_schedule_completion\nBEFORE INSERT ON pilot_collection_schedule\nWHEN (NEW.kind='initial' AND NOT EXISTS(SELECT 1 FROM pilot_collection_assignment a WHERE a.id=NEW.assignment_id AND a.created_at=NEW.created_at)) OR (NEW.kind!='initial' AND NOT EXISTS(SELECT 1 FROM pilot_collection_run r JOIN pilot_collection_event e ON e.run_id=r.id WHERE r.id=NEW.initial_run_id AND r.assignment_id=NEW.assignment_id AND r.child_id=NEW.child_id AND r.installation_id=NEW.installation_id AND r.phase='initial' AND r.completed_at=NEW.initial_completed_at AND e.id=NEW.completion_event_id AND e.server_at=NEW.initial_completed_at AND json_extract(e.result_json,'$.ack.result.outcome')='completed'))\nBEGIN SELECT RAISE(ABORT,'R5_BINDING'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_run_projection\nBEFORE UPDATE ON pilot_collection_run\nWHEN NEW.revision!=OLD.revision+1 OR NEW.updated_at<OLD.updated_at\n  OR NOT EXISTS(SELECT 1 FROM pilot_collection_event e WHERE e.run_id=OLD.id AND e.sequence=NEW.revision AND e.server_at=NEW.updated_at)\n  OR (NEW.completed_at IS NOT OLD.completed_at AND (NEW.completed_at!=NEW.updated_at OR NOT EXISTS(SELECT 1 FROM pilot_collection_event e WHERE e.run_id=OLD.id AND e.sequence=NEW.revision AND json_extract(e.result_json,'$.ack.result.outcome')='completed')))\nBEGIN SELECT RAISE(ABORT,'R5_PROJECTION'); END;\n\nCREATE TRIGGER IF NOT EXISTS pilot_collection_audit_binding\nBEFORE INSERT ON pilot_collection_learning_audit\nWHEN (NEW.action='plan-approval' AND NOT EXISTS(SELECT 1 FROM pilot_collection_plan p WHERE p.id=NEW.plan_id AND p.parent_id=NEW.actor_id AND p.approved_at=NEW.created_at))\n  OR (NEW.action='run-start' AND NOT EXISTS(SELECT 1 FROM pilot_collection_run r WHERE r.id=NEW.run_id AND r.child_id=NEW.actor_id AND r.created_at=NEW.created_at))\n  OR (NEW.action='run-action' AND NOT EXISTS(SELECT 1 FROM pilot_collection_run r JOIN pilot_collection_event e ON e.run_id=r.id WHERE r.id=NEW.run_id AND r.child_id=NEW.actor_id AND e.id=NEW.event_id AND e.sequence=NEW.revision AND e.server_at=NEW.created_at))\nBEGIN SELECT RAISE(ABORT,'R5_AUDIT_BINDING'); END;\n\nCREATE INDEX IF NOT EXISTS pilot_collection_proposal_lookup_idx ON pilot_collection_proposal(child_id,installation_id,collection_version,selection_ordinal);\nCREATE INDEX IF NOT EXISTS pilot_collection_plan_lookup_idx ON pilot_collection_plan(child_id,installation_id,approved_at);\nCREATE INDEX IF NOT EXISTS pilot_collection_assignment_lookup_idx ON pilot_collection_assignment(child_id,installation_id);\nCREATE INDEX IF NOT EXISTS pilot_collection_schedule_due_idx ON pilot_collection_schedule(child_id,installation_id,due_at);\nCREATE INDEX IF NOT EXISTS pilot_collection_run_lookup_idx ON pilot_collection_run(child_id,installation_id,created_at);\n";
