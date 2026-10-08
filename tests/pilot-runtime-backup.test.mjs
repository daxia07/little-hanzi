import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_PACKAGE = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/curriculum/forest-01-v2.json'),
    'utf8',
  ),
);

function runtimePackage(value) {
  const packageValue = structuredClone(value);
  const [welcome, familiarity, teach, practice, final, recap] =
    packageValue.steps;
  packageValue.steps = [
    { ...welcome, kind: 'familiarity', recognitionCheckIds: [] },
    {
      ...familiarity,
      kind: 'familiarity',
      recognitionCheckIds: ['check-mu-word', 'check-lin-word'],
    },
    {
      ...teach,
      kind: 'teach',
      recognitionCheckIds: ['check-mu-print', 'check-lin-print'],
    },
    {
      ...practice,
      kind: 'practice',
      recognitionCheckIds: ['check-mu-word', 'check-lin-word'],
    },
    {
      ...final,
      kind: 'plain-print-check',
      recognitionCheckIds: ['check-mu-print', 'check-lin-print'],
    },
    { ...recap, kind: 'recap', recognitionCheckIds: [] },
  ];
  return packageValue;
}

const PACKAGE = runtimePackage(BASE_PACKAGE);
const NOW = 1_790_000_000_000;
const PRIVATE_PASSWORD = 'runtime-backup-private-password';
const PRIVATE_REVIEWER = 'runtime-backup-private-reviewer';
const PRIVATE_EVIDENCE = 'runtime-backup-private-evidence';
const PRIVATE_REASON = 'runtime-backup-private-reason';
const CANDIDATE_ID = 'runtime-backup-candidate';
const TEST_RUN_ID = 'runtime-backup-test-run';
const SOURCE_INSTALLATION_ID = 'runtime-install-current';
const HEX = 'a'.repeat(64);

const LEGACY_COLUMNS = {
  pilot_auth_user: [
    'id',
    'name',
    'email',
    'email_verified',
    'image',
    'created_at',
    'updated_at',
    'username',
    'display_username',
    'role',
    'must_change_password',
    'disabled',
  ],
  pilot_auth_account: [
    'id',
    'account_id',
    'provider_id',
    'user_id',
    'password',
    'created_at',
    'updated_at',
  ],
  pilot_auth_rate_limit: ['id', 'key', 'count', 'last_request'],
  pilot_parent_child: ['parent_id', 'child_id', 'created_at', 'created_by'],
  pilot_teacher_grant: [
    'child_id',
    'teacher_id',
    'granting_parent_id',
    'created_at',
  ],
  pilot_account_audit: [
    'id',
    'action',
    'actor_user_id',
    'target_user_id',
    'metadata',
    'created_at',
  ],
  pilot_onboarding: [
    'child_id',
    'nickname',
    'experience',
    'audio_ready',
    'updated_at',
    'updated_by',
  ],
  pilot_assignment: [
    'child_id',
    'lesson_version',
    'status',
    'created_at',
    'created_by',
  ],
  pilot_run_ownership: ['run_id', 'child_id', 'lesson_version', 'created_at'],
  pilot_learning_release: [
    'lesson_version',
    'release_kind',
    'content_digest',
    'reviewer_label',
    'evidence_ref',
    'candidate_id',
    'test_run_id',
    'released_at',
  ],
  pilot_learning_run: [
    'run_id',
    'seed',
    'state_json',
    'revision',
    'created_at',
    'updated_at',
  ],
  pilot_learning_event: [
    'run_id',
    'event_id',
    'sequence',
    'phase',
    'step_id',
    'question_id',
    'type',
    'payload_json',
    'action_json',
    'server_time',
    'first_response',
    'assisted',
    'outcome',
    'ack_json',
  ],
  pilot_learning_audit: [
    'id',
    'action',
    'actor_user_id',
    'child_id',
    'metadata',
    'created_at',
  ],
  pilot_curriculum_registry_state: ['id', 'revision', 'updated_at'],
  pilot_curriculum_package: [
    'lesson_version',
    'lesson_id',
    'content_digest',
    'canonicalization_version',
    'manifest_json',
    'import_id',
    'imported_by_user_id',
    'imported_at',
    'test_run_id',
  ],
  pilot_curriculum_character: [
    'lesson_version',
    'character_id',
    'hanzi',
    'character_index',
  ],
  pilot_curriculum_review: [
    'review_id',
    'lesson_version',
    'content_digest',
    'review_sequence',
    'previous_review_id',
    'decision',
    'reviewer_ref',
    'reviewed_at',
    'checklist_version',
    'checklist_json',
    'evidence_ref',
    'reason',
    'recorded_by_user_id',
    'recorded_at',
    'request_digest',
    'write_id',
    'test_run_id',
  ],
  pilot_curriculum_audit: [
    'id',
    'action',
    'actor_user_id',
    'lesson_version',
    'content_digest',
    'review_id',
    'created_at',
  ],
};

const RUNTIME_COLUMNS = {
  pilot_curriculum_runtime_run: [
    'run_id',
    'request_id',
    'request_digest',
    'child_id',
    'lesson_version',
    'content_digest',
    'adapter_id',
    'adapter_version',
    'installation_id',
    'candidate_id',
    'test_run_id',
    'purpose',
    'created_by_user_id',
    'run_json',
    'revision',
    'created_at',
    'updated_at',
  ],
  pilot_curriculum_runtime_event: [
    'run_id',
    'event_id',
    'sequence',
    'event_json',
    'created_at',
  ],
  pilot_curriculum_runtime_audit: [
    'id',
    'run_id',
    'actor_user_id',
    'action',
    'event_id',
    'revision',
    'created_at',
  ],
};

const SCHEMA_ONLY_COLUMNS = {
  pilot_auth_session: [
    'id',
    'expires_at',
    'token',
    'created_at',
    'updated_at',
    'ip_address',
    'user_agent',
    'user_id',
  ],
  pilot_auth_verification: [
    'id',
    'identifier',
    'value',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  pilot_installation: ['id', 'installation_id', 'created_at'],
};

const DATA_COLUMNS = { ...LEGACY_COLUMNS, ...RUNTIME_COLUMNS };
const DATA_TABLES = Object.keys(DATA_COLUMNS);
const V2_TABLES = Object.keys(LEGACY_COLUMNS);
const RUNTIME_TRIGGER_NAMES = [
  'pilot_curriculum_runtime_run_no_identity_update',
  'pilot_curriculum_runtime_run_no_delete',
  'pilot_curriculum_runtime_event_no_update',
  'pilot_curriculum_runtime_event_no_delete',
  'pilot_curriculum_runtime_audit_no_update',
  'pilot_curriculum_runtime_audit_no_delete',
];

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function curriculumDigest(value) {
  return `sha256:${hash(canonical(value))}`;
}

function migrations() {
  return [
    '0000-auth.sql',
    '0001-data.sql',
    '0002-learning.sql',
    '0003-curriculum.sql',
    '0004-curriculum-runtime.sql',
  ].map((name) => ({
    name,
    version: name.replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
    sha256: hash(fs.readFileSync(path.join(ROOT, 'db/pilot-migrations', name))),
  }));
}

function schemaDescriptors(tableNames = DATA_TABLES) {
  const allowedTables = new Set([
    ...tableNames,
    ...Object.keys(SCHEMA_ONLY_COLUMNS),
  ]);
  const tableDescriptors = [
    ...tableNames,
    ...Object.keys(SCHEMA_ONLY_COLUMNS),
  ].map((name) => ({
    type: 'table',
    name,
    tbl_name: name,
    sql: `CREATE TABLE ${name} (${(
      DATA_COLUMNS[name] || SCHEMA_ONLY_COLUMNS[name]
    ).join(',')})`,
  }));
  const indexes = [
    ['pilot_auth_account_user_idx', 'pilot_auth_account'],
    ['pilot_auth_session_user_idx', 'pilot_auth_session'],
    ['pilot_auth_verification_identifier_idx', 'pilot_auth_verification'],
    ['pilot_parent_child_child_idx', 'pilot_parent_child'],
    ['pilot_teacher_grant_teacher_idx', 'pilot_teacher_grant'],
    ['pilot_account_audit_target_idx', 'pilot_account_audit'],
    ['pilot_account_audit_actor_idx', 'pilot_account_audit'],
    ['pilot_run_ownership_child_idx', 'pilot_run_ownership'],
    ['pilot_run_ownership_child_lesson_unique', 'pilot_run_ownership'],
    ['pilot_learning_event_run_idx', 'pilot_learning_event'],
    ['pilot_learning_audit_actor_idx', 'pilot_learning_audit'],
    ['pilot_learning_audit_child_idx', 'pilot_learning_audit'],
    ['pilot_curriculum_character_identity_idx', 'pilot_curriculum_character'],
    ['pilot_curriculum_import_audit_unique', 'pilot_curriculum_audit'],
    ['pilot_curriculum_package_version_digest', 'pilot_curriculum_package'],
    ['pilot_curriculum_review_audit_unique', 'pilot_curriculum_audit'],
    ['pilot_curriculum_review_sequence', 'pilot_curriculum_review'],
    [
      'pilot_curriculum_runtime_event_run_idx',
      'pilot_curriculum_runtime_event',
    ],
    [
      'pilot_curriculum_runtime_audit_run_idx',
      'pilot_curriculum_runtime_audit',
    ],
  ]
    .filter(([, tbl_name]) => allowedTables.has(tbl_name))
    .map(([name, tbl_name]) => ({
      type: 'index',
      name,
      tbl_name,
      sql: `CREATE INDEX ${name} ON ${tbl_name} (...)`,
    }));
  const baseTriggers = [
    ['pilot_curriculum_character_identity', 'pilot_curriculum_character'],
    ['pilot_curriculum_package_no_update', 'pilot_curriculum_package'],
    ['pilot_curriculum_package_no_delete', 'pilot_curriculum_package'],
    ['pilot_curriculum_character_no_update', 'pilot_curriculum_character'],
    ['pilot_curriculum_character_no_delete', 'pilot_curriculum_character'],
    ['pilot_curriculum_review_no_update', 'pilot_curriculum_review'],
    ['pilot_curriculum_review_no_delete', 'pilot_curriculum_review'],
    ['pilot_curriculum_audit_no_update', 'pilot_curriculum_audit'],
    ['pilot_curriculum_audit_no_delete', 'pilot_curriculum_audit'],
  ].filter(([, tbl_name]) => allowedTables.has(tbl_name));
  const runtimeTriggers = tableNames.includes('pilot_curriculum_runtime_run')
    ? RUNTIME_TRIGGER_NAMES.map((name) => [
        name,
        name.includes('_run_')
          ? 'pilot_curriculum_runtime_run'
          : name.includes('_event_')
            ? 'pilot_curriculum_runtime_event'
            : 'pilot_curriculum_runtime_audit',
      ])
    : [];
  const triggers = [...baseTriggers, ...runtimeTriggers].map(
    ([name, tbl_name]) => ({
      type: 'trigger',
      name,
      tbl_name,
      sql: `CREATE TRIGGER ${name} ...`,
    }),
  );
  return [...tableDescriptors, ...indexes, ...triggers].sort((a, b) =>
    `${a.type}\0${a.name}`.localeCompare(`${b.type}\0${b.name}`),
  );
}

const SCHEMA = schemaDescriptors();

function correctChoice(checkId) {
  const check = PACKAGE.recognitionChecks.find(
    (item) => item.checkId === checkId,
  );
  if (!check) throw new Error(`fixture check ${checkId} is missing`);
  return check.correctChoiceId;
}

function requestDigest({ requestId, childId, installationId }) {
  return curriculumDigest({
    schemaVersion: 's3-runtime-http-request-1',
    lessonVersion: PACKAGE.lessonVersion,
    request: {
      requestId,
      contentDigest: curriculumDigest(PACKAGE),
      childId,
    },
    actorUserId: 'operator-history',
    installationId,
    candidateId: CANDIDATE_ID,
    testRunId: TEST_RUN_ID,
  });
}

const RUNTIME = await import('../lib/curriculum/runtime.ts');
const LESSON = await RUNTIME.compileCurriculumRuntime(PACKAGE);
const CONTENT_DIGEST = LESSON.identity.contentDigest;

function actionInput(run, view, eventId, type, payload = {}) {
  return {
    eventId,
    expectedRevision: run.revision,
    occurrenceId: view.question?.occurrenceId ?? null,
    type,
    payload,
  };
}

function makeHistory({ runId, seed, installationId, childId, mode }) {
  let run = RUNTIME.createCurriculumRun(LESSON, {
    runId,
    seed,
    now: NOW,
  });
  const events = [];
  let clock = NOW;
  let eventNumber = 0;
  const commit = (type, payload = {}) => {
    const view = RUNTIME.projectCurriculumRun(LESSON, run, events, clock);
    const input = actionInput(
      run,
      view,
      `${runId}-event-${++eventNumber}`,
      type,
      payload,
    );
    const result = RUNTIME.applyCurriculumAction(
      LESSON,
      run,
      events,
      input,
      ++clock,
    );
    run = result.run;
    events.push(result.event);
  };

  if (mode !== 'zero') {
    if (mode === 'partial') {
      commit('continue');
      const view = RUNTIME.projectCurriculumRun(LESSON, run, events, clock);
      commit('answer', { choiceId: correctChoice(view.question.checkId) });
    } else {
      while (run.state.initialCompletedAt === null) {
        const view = RUNTIME.projectCurriculumRun(LESSON, run, events, clock);
        if (view.question?.questionStatus === 'open')
          commit('answer', {
            choiceId: correctChoice(view.question.checkId),
          });
        else commit('continue');
      }
      if (mode === 'delayed') {
        clock = Math.max(clock, run.state.reviewAvailableAt);
        commit('start-review');
        while (run.state.reviewCompletedAt === null) {
          const view = RUNTIME.projectCurriculumRun(LESSON, run, events, clock);
          if (view.question?.questionStatus === 'open')
            commit('answer', {
              choiceId: correctChoice(view.question.checkId),
            });
          else commit('continue');
        }
      }
    }
  }

  const rows = {
    run: {
      run_id: runId,
      request_id: `${runId}-request`,
      request_digest: requestDigest({
        requestId: `${runId}-request`,
        childId,
        installationId,
      }),
      child_id: childId,
      lesson_version: PACKAGE.lessonVersion,
      content_digest: CONTENT_DIGEST,
      adapter_id: run.identity.adapterId,
      adapter_version: run.identity.adapterVersion,
      installation_id: installationId,
      candidate_id: CANDIDATE_ID,
      test_run_id: TEST_RUN_ID,
      purpose: 'test-verification',
      created_by_user_id: 'operator-history',
      run_json: canonical(run),
      revision: run.revision,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
    },
    events: events.map((event) => ({
      run_id: runId,
      event_id: event.eventId,
      sequence: event.sequence,
      event_json: canonical(event),
      created_at: event.serverTime,
    })),
    audits: [
      {
        id: `${runId}-audit-create`,
        run_id: runId,
        actor_user_id: 'operator-history',
        action: 'create',
        event_id: null,
        revision: 0,
        created_at: run.createdAt,
      },
      ...events.map((event) => ({
        id: `${runId}-audit-${event.sequence}`,
        run_id: runId,
        actor_user_id: childId,
        action: 'action',
        event_id: event.eventId,
        revision: event.sequence,
        created_at: event.serverTime,
      })),
    ],
  };
  return rows;
}

function baseRows() {
  const users = [
    ['operator-history', 'operator', 1],
    ['child-zero', 'child', 1],
    ['child-partial', 'child', 1],
    ['child-complete', 'child', 1],
    ['child-delayed', 'child', 1],
  ];
  const userRows = users.map(([id, role, disabled]) => ({
    id,
    name: `Historical ${role} ${id}`,
    email: `${id}@fixture.invalid`,
    email_verified: 0,
    image: null,
    created_at: NOW - 20_000,
    updated_at: NOW - 10_000,
    username: id,
    display_username: id,
    role,
    must_change_password: disabled,
    disabled,
  }));
  const accountRows = users.map(([id]) => ({
    id: `account-${id}`,
    account_id: id,
    provider_id: 'credential',
    user_id: id,
    password: `${PRIVATE_PASSWORD}-${id}`,
    created_at: NOW - 20_000,
    updated_at: NOW - 10_000,
  }));
  return {
    pilot_auth_user: userRows,
    pilot_auth_account: accountRows,
    pilot_auth_rate_limit: [],
    pilot_parent_child: [],
    pilot_teacher_grant: [],
    pilot_account_audit: [],
    pilot_onboarding: [],
    pilot_assignment: [],
    pilot_run_ownership: [],
    pilot_learning_release: [
      {
        lesson_version: 'forest-01-v1',
        release_kind: 'test-fixture',
        content_digest: HEX,
        reviewer_label: 'synthetic fixture',
        evidence_ref: 'synthetic-fixture-evidence',
        candidate_id: CANDIDATE_ID,
        test_run_id: TEST_RUN_ID,
        released_at: NOW - 5_000,
      },
    ],
    pilot_learning_run: [],
    pilot_learning_event: [],
    pilot_learning_audit: [],
    pilot_curriculum_registry_state: [{ id: 1, revision: 1, updated_at: NOW }],
    pilot_curriculum_package: [
      {
        lesson_version: PACKAGE.lessonVersion,
        lesson_id: PACKAGE.lessonId,
        content_digest: CONTENT_DIGEST,
        canonicalization_version: PACKAGE.canonicalizationVersion,
        manifest_json: canonical(PACKAGE),
        import_id: 'runtime-backup-package-import',
        imported_by_user_id: 'operator-history',
        imported_at: NOW,
        test_run_id: TEST_RUN_ID,
      },
    ],
    pilot_curriculum_character: PACKAGE.characters.map(
      ({ characterId, hanzi }, characterIndex) => ({
        lesson_version: PACKAGE.lessonVersion,
        character_id: characterId,
        hanzi,
        character_index: characterIndex,
      }),
    ),
    pilot_curriculum_review: [],
    pilot_curriculum_audit: [
      {
        id: 'runtime-backup-package-audit',
        action: 'import',
        actor_user_id: 'operator-history',
        lesson_version: PACKAGE.lessonVersion,
        content_digest: CONTENT_DIGEST,
        review_id: null,
        created_at: NOW,
      },
    ],
    pilot_curriculum_runtime_run: [],
    pilot_curriculum_runtime_event: [],
    pilot_curriculum_runtime_audit: [],
  };
}

function makePayload() {
  const tables = baseRows();
  const histories = [
    makeHistory({
      runId: 'runtime-zero',
      seed: 17,
      installationId: SOURCE_INSTALLATION_ID,
      childId: 'child-zero',
      mode: 'zero',
    }),
    makeHistory({
      runId: 'runtime-partial',
      seed: 23,
      installationId: 'runtime-install-old-a',
      childId: 'child-partial',
      mode: 'partial',
    }),
    makeHistory({
      runId: 'runtime-complete',
      seed: 29,
      installationId: 'runtime-install-old-b',
      childId: 'child-complete',
      mode: 'complete',
    }),
    makeHistory({
      runId: 'runtime-delayed',
      seed: 31,
      installationId: 'runtime-install-old-c',
      childId: 'child-delayed',
      mode: 'delayed',
    }),
  ];
  for (const history of histories) {
    tables.pilot_curriculum_runtime_run.push(history.run);
    tables.pilot_curriculum_runtime_event.push(...history.events);
    tables.pilot_curriculum_runtime_audit.push(...history.audits);
  }
  return {
    format: 'pilot-admin-backup-3',
    createdAt: new Date(NOW + 1_000).toISOString(),
    candidateId: CANDIDATE_ID,
    sourceInstallationId: SOURCE_INSTALLATION_ID,
    migrations: migrations(),
    schemaDigest: hash(SCHEMA),
    schema: clone(SCHEMA),
    contentIdentities: {
      legacy: {
        'forest-01-v1': {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest: HEX,
        },
      },
      curriculum: {
        [PACKAGE.lessonVersion]: {
          lessonId: PACKAGE.lessonId,
          canonicalizationVersion: PACKAGE.canonicalizationVersion,
          digest: CONTENT_DIGEST,
        },
      },
    },
    tables,
  };
}

const BASE_PAYLOAD = makePayload();

async function loadBackupModule() {
  try {
    return await import('../scripts/pilot-backup.mjs');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND')
      throw new Error('scripts/pilot-backup.mjs is unavailable');
    throw error;
  }
}

function validator(backupModule, label) {
  assert.equal(
    typeof backupModule.validatePilotRuntimeBackup,
    'function',
    `${label}: validatePilotRuntimeBackup export is unavailable`,
  );
  return backupModule.validatePilotRuntimeBackup;
}

async function validate(backupModule, payload, label) {
  return validator(backupModule, label)(payload);
}

async function assertRuntimeInvalid(backupModule, payload, label) {
  await assert.rejects(
    async () => validate(backupModule, payload, label),
    (error) => {
      assert.equal(error?.code, 'BACKUP_RUNTIME_INVALID', label);
      assert.doesNotMatch(
        String(error?.message || error),
        /password|hash|token|secret|reviewer|evidence|answerKey/i,
      );
      for (const privateValue of [
        PRIVATE_PASSWORD,
        PRIVATE_REVIEWER,
        PRIVATE_EVIDENCE,
        PRIVATE_REASON,
      ])
        assert.doesNotMatch(
          String(error?.message || error),
          new RegExp(privateValue),
        );
      return true;
    },
    label,
  );
}

function envelope(payload) {
  return { payload, sha256: hash(payload) };
}

function privateTree() {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-runtime-backup-'),
  );
  fs.writeFileSync(path.join(root, '.hanzi-qa-owned'), 'owned\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const privateBackups = path.join(root, 'private-backups');
  fs.mkdirSync(privateBackups, { mode: 0o700 });
  return { root, privateBackups };
}

function writeEnvelope(filePath, value, mode = 0o600) {
  fs.writeFileSync(filePath, JSON.stringify(value), { mode, flag: 'wx' });
  fs.chmodSync(filePath, mode);
  return filePath;
}

async function assertReadRejected(action, label) {
  await assert.rejects(
    async () => action(),
    (error) => {
      assert.doesNotMatch(
        String(error?.message || error),
        /password|hash|token|secret|reviewer|evidence/i,
        label,
      );
      for (const privateValue of [
        PRIVATE_PASSWORD,
        PRIVATE_REVIEWER,
        PRIVATE_EVIDENCE,
        PRIVATE_REASON,
      ])
        assert.doesNotMatch(
          String(error?.message || error),
          new RegExp(privateValue),
          label,
        );
      return true;
    },
  );
}

function v1Payload() {
  const tables = Object.fromEntries(V1_TABLES.map((name) => [name, []]));
  const schema = schemaDescriptors(V1_TABLES);
  return {
    format: 'pilot-admin-backup-1',
    createdAt: new Date(NOW).toISOString(),
    candidateId: CANDIDATE_ID,
    sourceInstallationId: SOURCE_INSTALLATION_ID,
    migrations: migrations().slice(0, 3),
    schema,
    schemaDigest: hash(schema),
    contentVersions: { 'forest-01-v1': HEX },
    tables,
  };
}

function v2Payload() {
  const payload = clone(BASE_PAYLOAD);
  payload.format = 'pilot-admin-backup-2';
  payload.migrations = migrations().slice(0, 4);
  payload.schema = schemaDescriptors(V2_TABLES);
  payload.schemaDigest = hash(payload.schema);
  payload.tables = Object.fromEntries(
    V2_TABLES.map((name) => [name, clone(BASE_PAYLOAD.tables[name])]),
  );
  payload.tables.pilot_run_ownership = [];
  delete payload.tables.pilot_curriculum_runtime_run;
  delete payload.tables.pilot_curriculum_runtime_event;
  delete payload.tables.pilot_curriculum_runtime_audit;
  return payload;
}

const V1_TABLES = Object.keys(LEGACY_COLUMNS).slice(0, 13);

test('[S3-AC-011][R-BACKUP-00] exposes the v3 reader and semantic validator without importing private data', async () => {
  const backupModule = await loadBackupModule();
  assert.equal(typeof backupModule.readPilotBackup, 'function');
  assert.equal(typeof backupModule.validatePilotRuntimeBackup, 'function');
  assert.equal(typeof backupModule.backupPilot, 'function');
  assert.equal(typeof backupModule.restorePilot, 'function');
});

test('[S3-AC-011][R-BACKUP-01] accepts zero-event, partial, completed and delayed histories with disabled historical actors', async () => {
  const backupModule = await loadBackupModule();
  await validate(backupModule, clone(BASE_PAYLOAD), 'valid v3 history');
  const runs = BASE_PAYLOAD.tables.pilot_curriculum_runtime_run;
  assert.equal(Object.keys(BASE_PAYLOAD.tables).length, 21);
  assert.equal(
    BASE_PAYLOAD.schema.filter(
      (item) =>
        item.type === 'trigger' && RUNTIME_TRIGGER_NAMES.includes(item.name),
    ).length,
    6,
  );
  assert.equal(runs.length, 4);
  assert.ok(runs.some((row) => row.revision === 0));
  assert.ok(runs.some((row) => row.revision > 0));
  assert.ok(
    runs.some(
      (row) => JSON.parse(row.run_json).state.reviewCompletedAt !== null,
    ),
  );
  assert.equal(
    BASE_PAYLOAD.tables.pilot_auth_user.every((row) => row.disabled === 1),
    true,
  );
  assert.equal(new Set(runs.map((row) => row.installation_id)).size, 4);
});

test('[S3-AC-011][R-BACKUP-02] accepts reordered table, event and audit arrays', async () => {
  const backupModule = await loadBackupModule();
  const payload = clone(BASE_PAYLOAD);
  for (const rows of Object.values(payload.tables)) rows.reverse();
  await validate(backupModule, payload, 'reordered v3 history');
});

test('[S3-AC-011][R-BACKUP-03] accepts a recomputed checksum around a valid v3 payload', async () => {
  const backupModule = await loadBackupModule();
  const value = envelope(clone(BASE_PAYLOAD));
  assert.equal(value.sha256, hash(value.payload));
  await validate(backupModule, value.payload, 'recomputed valid checksum');
});

test('[S3-AC-011][R-BACKUP-04] rejects changed run identity, revision, binding, actor and fingerprint', async () => {
  const backupModule = await loadBackupModule();
  const mutations = [
    [
      'run identity',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.run_json = row.run_json.replace(
          'runtime-partial',
          'runtime-forged',
        );
      },
    ],
    [
      'run revision',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.revision += 1;
      },
    ],
    [
      'request fingerprint',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.request_digest = curriculumDigest({ forged: true });
      },
    ],
    [
      'historical actor',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.created_by_user_id = 'child-zero';
      },
    ],
    [
      'historical installation binding',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.installation_id = 'runtime-install-forged';
      },
    ],
    [
      'candidate binding',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.candidate_id = 'other-candidate';
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const payload = clone(BASE_PAYLOAD);
    mutate(payload);
    const checked = envelope(payload);
    assert.equal(checked.sha256, hash(checked.payload));
    await assertRuntimeInvalid(
      backupModule,
      checked.payload,
      `forged ${String(label)}`,
    );
  }
});

test('[S3-AC-011][R-BACKUP-05] rejects forged state, result and acknowledgement JSON after checksum recomputation', async () => {
  const backupModule = await loadBackupModule();
  const mutations = [
    [
      'state',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        const run = JSON.parse(row.run_json);
        run.state.attempts += 1;
        row.run_json = canonical(run);
      },
    ],
    [
      'result',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        const event = JSON.parse(row.event_json);
        event.result.outcome = 'correct';
        row.event_json = canonical(event);
      },
    ],
    [
      'ack',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        const event = JSON.parse(row.event_json);
        event.ack.revision += 1;
        row.event_json = canonical(event);
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const payload = clone(BASE_PAYLOAD);
    mutate(payload);
    const checked = envelope(payload);
    assert.equal(checked.sha256, hash(checked.payload));
    await assertRuntimeInvalid(
      backupModule,
      checked.payload,
      `forged ${String(label)}`,
    );
  }
});

test('[S3-AC-011][R-BACKUP-06] rejects duplicate, missing, orphan and non-contiguous runtime rows', async () => {
  const backupModule = await loadBackupModule();
  const mutations = [
    [
      'duplicate event ID',
      (payload) => {
        const rows = payload.tables.pilot_curriculum_runtime_event;
        rows.push(clone(rows.find((row) => row.run_id === 'runtime-partial')));
      },
    ],
    [
      'missing event',
      (payload) => {
        const rows = payload.tables.pilot_curriculum_runtime_event;
        rows.splice(
          rows.findIndex((row) => row.run_id === 'runtime-partial'),
          1,
        );
      },
    ],
    [
      'orphan event',
      (payload) => {
        payload.tables.pilot_curriculum_runtime_event.push({
          run_id: 'runtime-missing',
          event_id: 'orphan-event',
          sequence: 1,
          event_json: '{}',
          created_at: NOW,
        });
      },
    ],
    [
      'non-contiguous sequence',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-delayed',
        );
        row.sequence = 99;
      },
    ],
    [
      'duplicate audit revision',
      (payload) => {
        const rows = payload.tables.pilot_curriculum_runtime_audit;
        const row = rows.find(
          (item) =>
            item.run_id === 'runtime-partial' && item.action === 'action',
        );
        rows.push({ ...clone(row), id: 'duplicate-audit-id' });
      },
    ],
    [
      'orphan audit',
      (payload) => {
        payload.tables.pilot_curriculum_runtime_audit.push({
          id: 'orphan-audit',
          run_id: 'runtime-missing',
          actor_user_id: 'child-partial',
          action: 'action',
          event_id: 'orphan-event',
          revision: 1,
          created_at: NOW,
        });
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const payload = clone(BASE_PAYLOAD);
    mutate(payload);
    await assertRuntimeInvalid(backupModule, payload, label);
  }
});

test('[S3-AC-011][R-BACKUP-07] rejects unknown, duplicate or incomplete schema and data table boundaries', async () => {
  const backupModule = await loadBackupModule();
  const mutations = [
    [
      'missing runtime trigger',
      (payload) => {
        payload.schema = payload.schema.filter(
          (item) => item.name !== RUNTIME_TRIGGER_NAMES[0],
        );
        payload.schemaDigest = hash(payload.schema);
      },
    ],
    [
      'duplicate schema descriptor',
      (payload) => {
        payload.schema.push(clone(payload.schema[0]));
        payload.schemaDigest = hash(payload.schema);
      },
    ],
    [
      'unknown schema table',
      (payload) => {
        payload.schema.push({
          type: 'table',
          name: 'pilot_unknown_runtime_table',
          tbl_name: 'pilot_unknown_runtime_table',
          sql: 'CREATE TABLE pilot_unknown_runtime_table (id)',
        });
        payload.schemaDigest = hash(payload.schema);
      },
    ],
    [
      'missing runtime table',
      (payload) => {
        delete payload.tables.pilot_curriculum_runtime_event;
      },
    ],
    [
      'extra data table',
      (payload) => {
        payload.tables.pilot_runtime_extra = [];
      },
    ],
    [
      'future migration',
      (payload) => {
        payload.migrations.push({
          name: '0005-future.sql',
          version: 'pilot-future-0005',
          sha256: HEX,
        });
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const payload = clone(BASE_PAYLOAD);
    mutate(payload);
    await assertRuntimeInvalid(backupModule, payload, label);
  }
});

test('[S3-AC-011][R-BACKUP-08] rejects forged row columns, type drift and inconsistent counts', async () => {
  const backupModule = await loadBackupModule();
  const mutations = [
    [
      'extra event field',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.extra = 'forged';
      },
    ],
    [
      'event timestamp type drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.created_at = String(row.created_at);
      },
    ],
    [
      'run count drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.revision += 2;
      },
    ],
    [
      'audit count drift',
      (payload) => {
        payload.tables.pilot_curriculum_runtime_audit.pop();
      },
    ],
    [
      'event SQL sequence drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        const event = JSON.parse(row.event_json);
        event.sequence += 2;
        row.event_json = canonical(event);
      },
    ],
    [
      'event SQL time drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.created_at += 1;
      },
    ],
    [
      'audit relation drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_audit.find(
          (item) =>
            item.run_id === 'runtime-partial' && item.action === 'action',
        );
        row.event_id = 'missing-event';
      },
    ],
    [
      'audit actor drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_audit.find(
          (item) =>
            item.run_id === 'runtime-partial' && item.action === 'action',
        );
        row.actor_user_id = 'child-zero';
      },
    ],
    [
      'audit time drift',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_audit.find(
          (item) =>
            item.run_id === 'runtime-partial' && item.action === 'action',
        );
        row.created_at += 1;
      },
    ],
    [
      'malformed run JSON',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_run.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.run_json = '{';
      },
    ],
    [
      'malformed event JSON',
      (payload) => {
        const row = payload.tables.pilot_curriculum_runtime_event.find(
          (item) => item.run_id === 'runtime-partial',
        );
        row.event_json = '{';
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const payload = clone(BASE_PAYLOAD);
    mutate(payload);
    await assertRuntimeInvalid(backupModule, payload, label);
  }
});

test('[S3-AC-011][R-BACKUP-09] retains v1 and v2 readers', async () => {
  const backupModule = await loadBackupModule();
  const tree = privateTree();
  try {
    const v1File = writeEnvelope(
      path.join(tree.privateBackups, 'legacy-v1.json'),
      envelope(v1Payload()),
    );
    const v1 = await backupModule.readPilotBackup(v1File);
    assert.equal(v1.payload.format, 'pilot-admin-backup-1');

    const v2File = writeEnvelope(
      path.join(tree.privateBackups, 'legacy-v2.json'),
      envelope(v2Payload()),
    );
    const v2 = await backupModule.readPilotBackup(v2File);
    assert.equal(v2.payload.format, 'pilot-admin-backup-2');
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('[S3-AC-011][R-BACKUP-10] parses a valid v3 envelope after the legacy readers', async () => {
  const backupModule = await loadBackupModule();
  const tree = privateTree();
  try {
    const v3File = writeEnvelope(
      path.join(tree.privateBackups, 'runtime-v3.json'),
      envelope(clone(BASE_PAYLOAD)),
    );
    const v3 = await backupModule.readPilotBackup(v3File);
    assert.equal(v3.payload.format, 'pilot-admin-backup-3');
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('[S3-AC-011][R-BACKUP-11] keeps private path, mode and symlink controls for v3 backups', async () => {
  const backupModule = await loadBackupModule();
  const tree = privateTree();
  const outside = path.join(tree.root, 'outside.json');
  try {
    await assertReadRejected(
      () =>
        backupModule.readPilotBackup(
          writeEnvelope(outside, envelope(v1Payload())),
        ),
      'outside private directory',
    );

    const wrongMode = path.join(tree.privateBackups, 'wrong-mode.json');
    writeEnvelope(wrongMode, envelope(v1Payload()), 0o644);
    await assertReadRejected(
      () => backupModule.readPilotBackup(wrongMode),
      'non-owner mode',
    );

    const target = path.join(tree.privateBackups, 'target.json');
    writeEnvelope(target, envelope(v1Payload()));
    const symlink = path.join(tree.privateBackups, 'symlink.json');
    fs.symlinkSync(target, symlink);
    await assertReadRejected(
      () => backupModule.readPilotBackup(symlink),
      'symlink backup',
    );
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});
