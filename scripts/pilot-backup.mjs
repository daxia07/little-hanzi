import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertOwnedState, loadManifest } from './qa-helpers.mjs';
import { localD1, sqlValue } from './pilot-local-db.mjs';
import { pilotMigrationFiles } from './readiness-worker-compat.mjs';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import {
  RUNTIME_COLUMNS,
  RUNTIME_TABLES,
  RUNTIME_TRIGGERS,
  runtimeBackupInvalid,
  validateRuntimeRows,
  validateRuntimeSemantics,
} from './pilot-runtime-backup.mjs';
import {
  curriculumReviewRequest,
  hasCompleteCurriculumProvenance,
  isCurriculumReviewInput,
} from '../lib/curriculum/review.ts';
import {
  STORY_COLUMNS,
  STORY_TABLES,
  STORY_TRIGGERS,
  STORY_INDEXES,
  validateStoryRows,
  validateStorySemantics,
  storyBackupInvalid,
  historicalStoryInstallationIds,
} from './pilot-story-backup.mjs';
import { assertStorySchema, storySchemaSource } from './pilot-story-schema.mjs';

import {
  collectionTableNames,
  collectionSchemaTables,
  collectionColumns,
  collectionRestoreRows,
  historicalCollectionInstallationIds,
  validateCollectionRows,
  validatePilotCollectionBackup,
  collectionLegacyPayload,
  validateCollectionHistory,
} from './pilot-collection-backup.mjs';
import {
  validateCorpusRows,
  corpusBackupInvalid,
} from './pilot-corpus-backup.mjs';

const FORMAT = 'pilot-admin-backup-1';
const FORMAT_V2 = 'pilot-admin-backup-2';
const FORMAT_V3 = 'pilot-admin-backup-3';
const FORMAT_V4 = 'pilot-admin-backup-4';
const FORMAT_V5 = 'pilot-admin-backup-5';
const FORMAT_V6 = 'pilot-admin-backup-6';
const MAX_BYTES = 10 * 1024 * 1024;
// Only the explicit, inspected V6 union boundary can supply this private token.
// No old public parser accepts a flag that widens its supported registry.
const CORPUS_REGISTRY_BOUNDARY = Symbol('inspected-v6-registry');
// Order also defines the restore's foreign-key ordering. Token-bearing account
// columns are deliberately absent, even though they exist in Better Auth's schema.
const COLUMNS = {
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
};
const TABLES = Object.keys(COLUMNS);
const CURRICULUM_COLUMNS = {
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
const CURRICULUM_TABLES = Object.keys(CURRICULUM_COLUMNS);
const V2_TABLES = [...TABLES, ...CURRICULUM_TABLES];
const V2_OMITTED = [
  'pilot_auth_session',
  'pilot_auth_verification',
  'pilot_installation',
  'pilot_schema_history',
  'pilot_d1_migrations',
];
const V2_KNOWN = [...V2_TABLES, ...V2_OMITTED];
const V2_SCHEMA_TABLES = V2_KNOWN.filter(
  (table) => !['pilot_schema_history', 'pilot_d1_migrations'].includes(table),
);
const V2_KNOWN_SCHEMA_TABLES = new Set(V2_SCHEMA_TABLES);
const V3_TABLES = [...V2_TABLES, ...RUNTIME_TABLES];
const V3_KNOWN = [...V3_TABLES, ...V2_OMITTED];
const V3_SCHEMA_TABLES = [...V2_SCHEMA_TABLES, ...RUNTIME_TABLES];
const V4_TABLES = [...V3_TABLES, ...STORY_TABLES];
const V4_KNOWN = [...V4_TABLES, ...V2_OMITTED];
const V4_SCHEMA_TABLES = [...V3_SCHEMA_TABLES, ...STORY_TABLES];
export const PILOT_V4_COLUMNS = {
  ...COLUMNS,
  ...CURRICULUM_COLUMNS,
  ...RUNTIME_COLUMNS,
  ...STORY_COLUMNS,
};
export const PILOT_V4_TABLES = V4_TABLES;
export const PILOT_V4_SCHEMA_TABLES = V4_SCHEMA_TABLES;
const V2_JSON_COLUMNS = new Set([
  'metadata',
  'state_json',
  'payload_json',
  'action_json',
  'ack_json',
  'manifest_json',
  'checklist_json',
]);
const OMITTED = [
  'pilot_auth_session',
  'pilot_auth_verification',
  'pilot_installation',
  'pilot_schema_history',
  'pilot_d1_migrations',
];
const KNOWN = [...TABLES, ...OMITTED];
const INTEGER_COLUMNS = new Set([
  'email_verified',
  'created_at',
  'updated_at',
  'must_change_password',
  'disabled',
  'count',
  'last_request',
  'audio_ready',
  'released_at',
  'seed',
  'revision',
  'sequence',
  'server_time',
  'first_response',
  'assisted',
]);
const V2_INTEGER_COLUMNS = new Set([
  ...INTEGER_COLUMNS,
  'revision',
  'updated_at',
  'imported_at',
  'character_index',
  'review_sequence',
  'reviewed_at',
  'recorded_at',
]);
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const fail = (reason, code) => {
  const error = new Error(`Pilot backup: ${code ? `${code}: ` : ''}${reason}`);
  if (code) error.code = code;
  throw error;
};
const plain = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a.localeCompare(b);
const exact = (value, keys) =>
  plain(value) &&
  Object.keys(value).sort(compare).join('|') ===
    [...keys].sort(compare).join('|');
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const rows = (db, sql) => db.query(sql)[0].results;
// Encode text as UTF-8 bytes, avoiding SQL parser ambiguity for embedded NULs.
const restoreValue = (value) =>
  typeof value === 'string'
    ? `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`
    : sqlValue(value);
function tableDigest(tables) {
  return hash(
    TABLES.map((table) => [
      table,
      tables[table]
        .map((row) =>
          JSON.stringify(COLUMNS[table].map((column) => row[column])),
        )
        .sort(compare),
    ]),
  );
}

function columnsFor(table) {
  return (
    COLUMNS[table] ||
    CURRICULUM_COLUMNS[table] ||
    RUNTIME_COLUMNS[table] ||
    STORY_COLUMNS[table] ||
    collectionColumns()[table]
  );
}

function tableDigestFor(tables, tableNames) {
  return hash(
    tableNames.map((table) => [
      table,
      tables[table]
        .map((row) =>
          JSON.stringify(columnsFor(table).map((column) => row[column])),
        )
        .sort(compare),
    ]),
  );
}

function privateDirectory(directory) {
  if (
    !path.isAbsolute(directory) ||
    fs.realpathSync(directory) !== path.resolve(directory) ||
    path.basename(directory) !== 'private-backups'
  )
    fail('use an absolute private backup directory without symlinks');
  const work = path.dirname(directory);
  if (
    !path.basename(work).startsWith('hanzi-') ||
    !fs.existsSync(path.join(work, '.hanzi-qa-owned'))
  )
    fail('backup directory must belong to an owned local installation');
  const info = fs.statSync(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    fail('backup directory requires owner-only permissions');
}

function backupPath(filePath, manifest) {
  if (
    !filePath ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath
  )
    fail('an explicit absolute backup file is required');
  const directory = path.dirname(filePath);
  if (manifest) {
    assertOwnedState(manifest.buildState);
    if (
      directory !== path.join(fs.realpathSync(manifest.work), 'private-backups')
    )
      fail(
        'write backups only inside the selected installation private-backups directory',
      );
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  }
  privateDirectory(directory);
  return filePath;
}

function validatePayload(payload) {
  if (
    !exact(payload, [
      'format',
      'createdAt',
      'candidateId',
      'sourceInstallationId',
      'migrations',
      'schemaDigest',
      'schema',
      'contentVersions',
      'tables',
    ]) ||
    payload.format !== FORMAT ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    typeof payload.candidateId !== 'string' ||
    !payload.candidateId ||
    typeof payload.sourceInstallationId !== 'string' ||
    !payload.sourceInstallationId
  )
    fail('unsupported backup envelope');
  if (
    !Array.isArray(payload.migrations) ||
    !payload.migrations.length ||
    payload.migrations.some(
      (item) =>
        !exact(item, ['name', 'version', 'sha256']) ||
        !/^\d+-.+\.sql$/.test(item.name) ||
        typeof item.version !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.sha256),
    )
  )
    fail('invalid migration history');
  if (
    !Array.isArray(payload.schema) ||
    !payload.schema.length ||
    payload.schema.some(
      (item) =>
        !exact(item, ['type', 'name', 'tbl_name', 'sql']) ||
        !['table', 'index', 'trigger'].includes(item.type) ||
        !KNOWN.includes(item.tbl_name) ||
        typeof item.name !== 'string' ||
        typeof item.sql !== 'string',
    ) ||
    payload.schemaDigest !== hash(payload.schema)
  )
    fail('schema digest is invalid');
  if (
    !exact(payload.contentVersions, ['forest-01-v1']) ||
    !/^[a-f0-9]{64}$/.test(payload.contentVersions['forest-01-v1'])
  )
    fail('unsupported content versions');
  if (!exact(payload.tables, TABLES)) fail('unsupported backup table set');
  for (const table of TABLES) {
    if (!Array.isArray(payload.tables[table])) fail('invalid table rows');
    for (const row of payload.tables[table]) {
      if (!exact(row, COLUMNS[table])) fail('unsupported backup columns');
      for (const [column, value] of Object.entries(row)) {
        if (
          value !== null &&
          (INTEGER_COLUMNS.has(column)
            ? !Number.isSafeInteger(value)
            : typeof value !== 'string')
        )
          fail('unsupported database value type');
        if (typeof value === 'string' && !value.isWellFormed())
          fail('unsupported text encoding');
        if (column.endsWith('_json') || column === 'metadata') {
          try {
            JSON.parse(value);
          } catch {
            fail('malformed serialized JSON');
          }
          if (typeof value !== 'string') fail('malformed serialized JSON');
        }
      }
    }
  }
  if (
    payload.tables.pilot_auth_account.some(
      (row) => row.provider_id !== 'credential',
    )
  )
    fail('unsupported account provider');
  for (const table of [
    'pilot_assignment',
    'pilot_run_ownership',
    'pilot_learning_release',
  ]) {
    if (
      payload.tables[table].some(
        (row) => !Object.hasOwn(payload.contentVersions, row.lesson_version),
      )
    )
      fail('unsupported stored lesson version');
  }
  if (
    payload.tables.pilot_learning_release.some(
      (row) =>
        !/^[a-f0-9]{64}$/.test(row.content_digest) ||
        row.content_digest !== payload.contentVersions[row.lesson_version],
    )
  )
    fail('release evidence differs from supported content');
}

const V2_NULLABLE_COLUMNS = {
  pilot_auth_user: new Set(['image', 'username', 'display_username']),
  pilot_auth_account: new Set(['password']),
  pilot_account_audit: new Set(['actor_user_id', 'target_user_id']),
  pilot_learning_release: new Set(['test_run_id']),
  pilot_learning_event: new Set(['question_id']),
  pilot_learning_audit: new Set(['actor_user_id', 'child_id']),
  pilot_curriculum_package: new Set(['test_run_id']),
  pilot_curriculum_review: new Set(['previous_review_id', 'test_run_id']),
  pilot_curriculum_audit: new Set(['review_id']),
};
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const curriculumDigest = (value) => `sha256:${hash(canonicalPackage(value))}`;

function assertV2String(value, reason = 'invalid curriculum text') {
  if (typeof value !== 'string' || !value || !value.isWellFormed())
    fail(reason);
  return value;
}

function assertV2ExactObject(
  value,
  keys,
  reason = 'unsupported curriculum fields',
) {
  if (!exact(value, keys)) fail(reason);
}

function assertV2Id(value, max = 64) {
  assertV2String(value);
  if (value.length > max || !/^[a-z0-9][a-z0-9._-]*$/.test(value))
    fail('invalid curriculum identity');
}

function validateV2RowTypes(payload) {
  for (const table of V2_TABLES) {
    if (!Array.isArray(payload.tables[table]))
      fail('invalid curriculum table rows');
    const columns = CURRICULUM_COLUMNS[table] || COLUMNS[table];
    for (const row of payload.tables[table]) {
      if (!exact(row, columns)) fail('unsupported curriculum columns');
      for (const [column, value] of Object.entries(row)) {
        if (value === null) {
          if (!V2_NULLABLE_COLUMNS[table]?.has(column))
            fail(`invalid null database value in ${table}.${column}`);
          continue;
        }
        const integer =
          V2_INTEGER_COLUMNS.has(column) ||
          (table === 'pilot_curriculum_registry_state' && column === 'id');
        if (integer ? !Number.isSafeInteger(value) : typeof value !== 'string')
          fail(`unsupported database value type in ${table}.${column}`);
        if (typeof value === 'string' && !value.isWellFormed())
          fail('unsupported text encoding');
        if (V2_JSON_COLUMNS.has(column)) {
          try {
            JSON.parse(value);
          } catch {
            fail('malformed serialized JSON');
          }
        }
      }
    }
  }
}

function identityMaps(payload) {
  const identities = payload.contentIdentities;
  assertV2ExactObject(
    identities,
    ['legacy', 'curriculum'],
    'invalid content identities',
  );
  if (!plain(identities.legacy) || !plain(identities.curriculum))
    fail('invalid content identities');
  for (const [version, identity] of Object.entries(identities.legacy)) {
    assertV2Id(version, 80);
    assertV2ExactObject(identity, ['lessonId', 'algorithm', 'digest']);
    assertV2Id(identity.lessonId);
    if (
      identity.algorithm !== 's2-json-stringify-sha256-v1' ||
      !/^[a-f0-9]{64}$/.test(identity.digest)
    )
      fail('invalid legacy content identity');
  }
  for (const [version, identity] of Object.entries(identities.curriculum)) {
    assertV2Id(version, 80);
    assertV2ExactObject(identity, [
      'lessonId',
      'canonicalizationVersion',
      'digest',
    ]);
    assertV2Id(identity.lessonId);
    if (
      identity.canonicalizationVersion !== 's3-json-1' ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.digest)
    )
      fail('invalid curriculum content identity');
  }
  return identities;
}

function reviewInputFromRow(row) {
  let checklist;
  try {
    checklist = JSON.parse(row.checklist_json);
  } catch {
    fail('malformed review checklist');
  }
  return {
    requestId: row.review_id,
    contentDigest: row.content_digest,
    previousReviewId: row.previous_review_id,
    decision: row.decision,
    reviewerRef: row.reviewer_ref,
    reviewedAt: row.reviewed_at,
    checklistVersion: row.checklist_version,
    checklist,
    evidenceRef: row.evidence_ref,
    reason: row.reason,
  };
}

function validateV2Payload(payload, boundary) {
  if (
    !exact(payload, [
      'format',
      'createdAt',
      'candidateId',
      'sourceInstallationId',
      'migrations',
      'schemaDigest',
      'schema',
      'contentIdentities',
      'tables',
    ]) ||
    payload.format !== FORMAT_V2 ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    typeof payload.candidateId !== 'string' ||
    !payload.candidateId ||
    typeof payload.sourceInstallationId !== 'string' ||
    !payload.sourceInstallationId
  )
    fail('unsupported backup envelope');
  if (
    !Array.isArray(payload.migrations) ||
    payload.migrations.length !== 4 ||
    payload.migrations.some(
      (item) =>
        !exact(item, ['name', 'version', 'sha256']) ||
        !/^\d+-.+\.sql$/.test(item.name) ||
        typeof item.version !== 'string' ||
        !item.version ||
        !/^[a-f0-9]{64}$/.test(item.sha256),
    ) ||
    new Set(payload.migrations.map((item) => item.name)).size !== 4 ||
    new Set(payload.migrations.map((item) => item.version)).size !== 4
  )
    fail('invalid migration history');
  if (
    !Array.isArray(payload.schema) ||
    !payload.schema.length ||
    payload.schema.some(
      (item) =>
        !exact(item, ['type', 'name', 'tbl_name', 'sql']) ||
        !['table', 'index', 'trigger'].includes(item.type) ||
        !V2_KNOWN_SCHEMA_TABLES.has(item.tbl_name) ||
        typeof item.name !== 'string' ||
        typeof item.sql !== 'string',
    ) ||
    payload.schemaDigest !== hash(payload.schema)
  )
    fail('schema digest is invalid');
  identityMaps(payload);
  if (!exact(payload.tables, V2_TABLES)) fail('unsupported backup table set');
  validateV2RowTypes(payload);
  const identities = payload.contentIdentities;
  if (
    !identities.legacy['forest-01-v1'] ||
    identities.legacy['forest-01-v1'].lessonId !== 'forest-01'
  )
    fail('unsupported legacy content identity');
  if (
    payload.tables.pilot_auth_account.some(
      (row) => row.provider_id !== 'credential',
    )
  )
    fail('unsupported account provider');
  const users = new Set(payload.tables.pilot_auth_user.map((row) => row.id));
  const packages = new Map();
  const packageImportIds = new Set();
  const packageDigests = new Set();
  const legacyVersions = new Set(Object.keys(identities.legacy));
  const curriculumVersions = new Set(Object.keys(identities.curriculum));
  for (const version of legacyVersions)
    if (curriculumVersions.has(version))
      fail('content identity namespace collision');
  for (const row of payload.tables.pilot_curriculum_package) {
    if (
      !PACKAGE_ID.test(row.lesson_version) ||
      packages.has(row.lesson_version)
    )
      fail('invalid curriculum package identity');
    if (
      packageImportIds.has(row.import_id) ||
      packageDigests.has(row.content_digest)
    )
      fail('duplicate curriculum package identity');
    let manifest;
    try {
      manifest = JSON.parse(row.manifest_json);
    } catch {
      fail('malformed curriculum manifest');
    }
    const manifestValidation = validateCurriculumPackage(manifest);
    if (!manifestValidation.ok) {
      const issue = manifestValidation.errors[0];
      fail(
        `invalid curriculum manifest${issue ? `: ${issue.path} ${issue.code}` : ''}`,
      );
    }
    // V2–V5 retain their historical registry boundary. The V6 union must
    // validate corpus authority/history explicitly, never enter via a newly
    // supported package in the shared application validator.
    if (
      manifest.renderer.adapterId === 'corpus-paired' &&
      boundary !== CORPUS_REGISTRY_BOUNDARY
    )
      fail('corpus packages require the version 6 archive boundary');
    if (
      manifest.lessonVersion !== row.lesson_version ||
      manifest.lessonId !== row.lesson_id ||
      row.canonicalization_version !== 's3-json-1' ||
      curriculumDigest(manifest) !== row.content_digest
    )
      fail('curriculum package digest differs from manifest');
    if (canonicalPackage(manifest) !== row.manifest_json)
      fail('curriculum manifest is not canonical');
    if (
      !identities.curriculum[row.lesson_version] ||
      identities.curriculum[row.lesson_version].lessonId !== row.lesson_id ||
      identities.curriculum[row.lesson_version].digest !== row.content_digest
    )
      fail('curriculum identity differs from package');
    if (!users.has(row.imported_by_user_id))
      fail('unknown curriculum importer');
    if (row.test_run_id !== null && !row.test_run_id)
      fail('invalid fixture origin');
    packageImportIds.add(row.import_id);
    packageDigests.add(row.content_digest);
    packages.set(row.lesson_version, { row, manifest });
  }
  if (Object.keys(identities.curriculum).length !== packages.size)
    fail('curriculum identity/package mismatch');
  for (const version of Object.keys(identities.curriculum))
    if (!packages.has(version)) fail('curriculum identity/package mismatch');
  for (const table of ['pilot_assignment', 'pilot_run_ownership']) {
    if (
      payload.tables[table].some(
        (row) => !identities.legacy[row.lesson_version],
      )
    )
      fail('unsupported stored lesson version');
  }
  for (const row of payload.tables.pilot_learning_release) {
    const identity = identities.legacy[row.lesson_version];
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(row.content_digest) ||
      row.content_digest !== identity.digest
    )
      fail('release evidence differs from supported content');
  }
  const characterRows = new Map();
  for (const row of payload.tables.pilot_curriculum_character) {
    if (!packages.has(row.lesson_version))
      fail('curriculum character index has no package');
    const key = `${row.lesson_version}\u0000${row.character_id}`;
    if (characterRows.has(key)) fail('duplicate curriculum character index');
    characterRows.set(key, row);
  }
  const stableCharacters = new Map();
  for (const [version, packageInfo] of packages) {
    const expected = packageInfo.manifest.characters;
    const seenIndexes = new Set();
    for (let index = 0; index < expected.length; index += 1) {
      const character = expected[index];
      const row = characterRows.get(`${version}\u0000${character.characterId}`);
      if (
        !row ||
        row.character_index !== index ||
        row.hanzi !== character.hanzi ||
        seenIndexes.has(row.character_index)
      )
        fail('curriculum character index differs from manifest');
      seenIndexes.add(row.character_index);
      const stable = stableCharacters.get(character.characterId);
      if (stable && stable !== character.hanzi)
        fail('stable curriculum character identity conflict');
      stableCharacters.set(character.characterId, character.hanzi);
    }
    if (
      seenIndexes.size !== expected.length ||
      payload.tables.pilot_curriculum_character.filter(
        (row) => row.lesson_version === version,
      ).length !== expected.length
    )
      fail('curriculum character index differs from manifest');
  }
  const reviews = new Map();
  const writeIds = new Set();
  for (const row of payload.tables.pilot_curriculum_review) {
    const packageInfo = packages.get(row.lesson_version);
    if (
      !packageInfo ||
      row.content_digest !== packageInfo.row.content_digest ||
      !Number.isSafeInteger(row.review_sequence) ||
      row.review_sequence < 1 ||
      reviews.has(row.review_id) ||
      writeIds.has(row.write_id) ||
      !users.has(row.recorded_by_user_id)
    )
      fail('invalid curriculum review chain');
    const input = reviewInputFromRow(row);
    if (
      !isCurriculumReviewInput(input, Number.MAX_SAFE_INTEGER) ||
      !assertV2String(row.request_digest, 'invalid review history') ||
      !assertV2String(row.write_id, 'invalid review history') ||
      !Number.isSafeInteger(row.recorded_at) ||
      row.recorded_at < 0 ||
      row.reviewed_at > row.recorded_at + 300000
    )
      fail('invalid review history');
    if (row.decision === 'approved') {
      if (!hasCompleteCurriculumProvenance(packageInfo.manifest))
        fail('approved review checklist or provenance is incomplete');
    }
    const expectedFingerprint = curriculumDigest(
      curriculumReviewRequest(
        row.lesson_version,
        row.recorded_by_user_id,
        row.test_run_id,
        input,
      ),
    );
    if (row.request_digest !== expectedFingerprint)
      fail('review request fingerprint differs');
    if (
      (packageInfo.row.test_run_id === null) !== (row.test_run_id === null) ||
      (row.test_run_id !== null &&
        row.test_run_id !== packageInfo.row.test_run_id)
    )
      fail('fixture origin differs');
    reviews.set(row.review_id, row);
    writeIds.add(row.write_id);
  }
  const reviewsByVersion = new Map();
  for (const row of reviews.values()) {
    const list = reviewsByVersion.get(row.lesson_version) || [];
    list.push(row);
    reviewsByVersion.set(row.lesson_version, list);
  }
  for (const [version, list] of reviewsByVersion) {
    list.sort((a, b) => a.review_sequence - b.review_sequence);
    for (let index = 0; index < list.length; index += 1) {
      const row = list[index];
      if (
        row.review_sequence !== index + 1 ||
        (index === 0
          ? row.previous_review_id !== null
          : row.previous_review_id !== list[index - 1].review_id)
      )
        fail('invalid curriculum review chain');
    }
    if (!packages.has(version)) fail('invalid curriculum review package');
  }
  const audits = payload.tables.pilot_curriculum_audit;
  const auditImports = new Map();
  const auditReviews = new Map();
  const auditIds = new Set();
  for (const row of audits) {
    if (auditIds.has(row.id)) fail('duplicate curriculum audit identity');
    auditIds.add(row.id);
    if (!users.has(row.actor_user_id) || !packages.has(row.lesson_version))
      fail('invalid curriculum audit relation');
    const packageInfo = packages.get(row.lesson_version);
    if (row.content_digest !== packageInfo.row.content_digest)
      fail('invalid curriculum audit relation');
    if (row.action === 'import') {
      if (row.review_id !== null || auditImports.has(row.lesson_version))
        fail('invalid curriculum import audit');
      if (
        row.actor_user_id !== packageInfo.row.imported_by_user_id ||
        row.created_at !== packageInfo.row.imported_at
      )
        fail('invalid curriculum import audit');
      auditImports.set(row.lesson_version, row);
    } else if (row.action === 'review') {
      const review = reviews.get(row.review_id);
      if (
        !review ||
        review.lesson_version !== row.lesson_version ||
        review.content_digest !== row.content_digest ||
        auditReviews.has(row.review_id) ||
        row.actor_user_id !== review.recorded_by_user_id ||
        row.created_at !== review.recorded_at
      )
        fail('invalid curriculum review audit');
      auditReviews.set(row.review_id, row);
    } else {
      fail('invalid curriculum audit action');
    }
  }
  if (
    auditImports.size !== packages.size ||
    auditReviews.size !== reviews.size ||
    payload.tables.pilot_curriculum_registry_state.length !== 1
  )
    fail('invalid curriculum audit history');
  const state = payload.tables.pilot_curriculum_registry_state[0];
  if (state.id !== 1 || state.revision !== audits.length || state.revision < 0)
    fail('invalid curriculum registry revision');
  const maxTime = Math.max(
    0,
    ...payload.tables.pilot_curriculum_package.map((row) => row.imported_at),
    ...payload.tables.pilot_curriculum_review.map((row) => row.recorded_at),
    ...audits.map((row) => row.created_at),
  );
  if (state.updated_at < maxTime) fail('invalid curriculum registry clock');
}

function validateV3Payload(payload, boundary) {
  try {
    const validText = (value) =>
      typeof value === 'string' && value.length > 0 && value.isWellFormed();
    const requireValid = (condition) => {
      if (!condition) runtimeBackupInvalid();
    };
    requireValid(
      exact(payload, [
        'format',
        'createdAt',
        'candidateId',
        'sourceInstallationId',
        'migrations',
        'schemaDigest',
        'schema',
        'contentIdentities',
        'tables',
      ]) &&
        payload.format === FORMAT_V3 &&
        validText(payload.createdAt) &&
        Number.isFinite(Date.parse(payload.createdAt)) &&
        new Date(payload.createdAt).toISOString() === payload.createdAt &&
        validText(payload.candidateId) &&
        validText(payload.sourceInstallationId),
    );
    requireValid(
      Array.isArray(payload.migrations) &&
        payload.migrations.every(
          (item) =>
            exact(item, ['name', 'version', 'sha256']) &&
            /^[a-f0-9]{64}$/.test(item.sha256),
        ),
    );
    requireValid(backupFormatForMigrations(payload.migrations) === FORMAT_V3);
    requireValid(
      Array.isArray(payload.schema) &&
        payload.schemaDigest === hash(payload.schema),
    );
    const objects = new Set();
    for (const item of payload.schema) {
      requireValid(
        exact(item, ['type', 'name', 'tbl_name', 'sql']) &&
          ['table', 'index', 'trigger'].includes(item.type) &&
          V3_SCHEMA_TABLES.includes(item.tbl_name) &&
          validText(item.name) &&
          validText(item.sql),
      );
      const key = JSON.stringify([item.type, item.name]);
      requireValid(!objects.has(key));
      objects.add(key);
    }
    for (const table of V3_SCHEMA_TABLES)
      requireValid(
        payload.schema.filter(
          (item) =>
            item.type === 'table' &&
            item.name === table &&
            item.tbl_name === table,
        ).length === 1,
      );
    requireValid(
      payload.schema.filter((item) => item.type === 'table').length ===
        V3_SCHEMA_TABLES.length,
    );
    for (const name of RUNTIME_TRIGGERS)
      requireValid(
        payload.schema.some(
          (item) =>
            item.type === 'trigger' &&
            item.name === name &&
            name.startsWith(item.tbl_name + '_') &&
            RUNTIME_TABLES.includes(item.tbl_name),
        ),
      );
    requireValid(exact(payload.tables, V3_TABLES));
    // The original v3 shape is checked before applying the unchanged v2 rules
    // to an exact projection. Neither older parser accepts new format fields.
    const baseSchema = payload.schema.filter((item) =>
      V2_KNOWN_SCHEMA_TABLES.has(item.tbl_name),
    );
    validateV2Payload(
      {
        ...payload,
        format: FORMAT_V2,
        migrations: payload.migrations.slice(0, 4),
        schema: baseSchema,
        schemaDigest: hash(baseSchema),
        tables: Object.fromEntries(
          V2_TABLES.map((table) => [table, payload.tables[table]]),
        ),
      },
      boundary,
    );
    return validateRuntimeRows(payload);
  } catch {
    runtimeBackupInvalid();
  }
}

export async function validatePilotRuntimeBackup(payload) {
  const entries = validateV3Payload(payload);
  await validateRuntimeSemantics(entries);
}

function validateV4Payload(payload, boundary) {
  try {
    const check = (condition) => {
      if (!condition) storyBackupInvalid();
    };
    check(
      exact(payload, [
        'format',
        'createdAt',
        'candidateId',
        'sourceInstallationId',
        'migrations',
        'schemaDigest',
        'schema',
        'contentIdentities',
        'tables',
      ]),
    );
    check(
      payload.format === FORMAT_V4 &&
        backupFormatForMigrations(payload.migrations) === FORMAT_V4,
    );
    assertStorySchema(payload);
    check(
      exact(payload.tables, V4_TABLES) &&
        Array.isArray(payload.schema) &&
        payload.schemaDigest === hash(payload.schema),
    );
    const objects = new Set();
    for (const item of payload.schema) {
      check(
        exact(item, ['type', 'name', 'tbl_name', 'sql']) &&
          ['table', 'index', 'trigger'].includes(item.type) &&
          V4_SCHEMA_TABLES.includes(item.tbl_name) &&
          typeof item.sql === 'string' &&
          item.sql.length > 0,
      );
      const key = `${item.type}:${item.name}`;
      check(!objects.has(key));
      objects.add(key);
    }
    for (const table of V4_SCHEMA_TABLES)
      check(
        payload.schema.filter(
          (item) =>
            item.type === 'table' &&
            item.name === table &&
            item.tbl_name === table,
        ).length === 1,
      );
    check(
      payload.schema.filter((item) => item.type === 'table').length ===
        V4_SCHEMA_TABLES.length,
    );
    for (const [type, names] of [
      ['trigger', STORY_TRIGGERS],
      ['index', STORY_INDEXES],
    ]) {
      for (const name of names)
        check(
          payload.schema.some(
            (item) =>
              item.type === type &&
              item.name === name &&
              STORY_TABLES.includes(item.tbl_name),
          ),
        );
    }
    const baseSchema = payload.schema.filter((item) =>
      V3_SCHEMA_TABLES.includes(item.tbl_name),
    );
    const runtime = validateV3Payload(
      {
        ...payload,
        format: FORMAT_V3,
        migrations: payload.migrations.slice(0, 5),
        schema: baseSchema,
        schemaDigest: hash(baseSchema),
        tables: Object.fromEntries(
          V3_TABLES.map((table) => [table, payload.tables[table]]),
        ),
      },
      boundary,
    );
    const story = validateStoryRows(payload);
    return { runtime, story };
  } catch {
    storyBackupInvalid();
  }
}

export async function validatePilotStoryBackup(
  payload,
  { archiveIssuers = [] } = {},
) {
  // Capture validated copies before asynchronous replay or key verification.
  const snapshot = structuredClone(payload);
  const { runtime, story } = validateV4Payload(snapshot);
  await validateRuntimeSemantics(runtime);
  await validateStorySemantics(story, structuredClone(archiveIssuers));
}

/** Validate all shared registry and old learning/authority facts inside V6.
 * This is one stage, not complete corpus validation or permission to restore.
 * The returned copy retains every original row and audit; only validator routing
 * projects old authority arrays and exact old schema objects. */
export async function validateCorpusRegistryAndLegacyHistory(
  input,
  { archiveIssuers = [], source } = {},
) {
  try {
    const payload = validateCorpusRows(input, source);
    const issuers = structuredClone(archiveIssuers);
    const corpusVersions = new Set(
      payload.tables.pilot_curriculum_package
        .filter(
          (row) =>
            JSON.parse(row.manifest_json).renderer?.adapterId ===
            'corpus-paired',
        )
        .map((row) => row.lesson_version),
    );
    const shared = new Set([
      'pilot_curriculum_package',
      'pilot_curriculum_character',
      'pilot_curriculum_review',
      'pilot_curriculum_audit',
    ]);
    for (const name of collectionTableNames()) {
      if (
        !shared.has(name) &&
        payload.tables[name].some((row) =>
          corpusVersions.has(row.lesson_version),
        )
      )
        corpusBackupInvalid();
    }
    const oldSource = storySchemaSource();
    const keys = new Set(
      oldSource.schema.map((row) => `${row.type}:${row.name}`),
    );
    const schema = payload.schema.filter((row) =>
      keys.has(`${row.type}:${row.name}`),
    );
    const legacy = {
      ...collectionLegacyPayload(payload),
      schema,
      schemaDigest: hash(schema),
    };
    const { runtime, story } = validateV4Payload(
      legacy,
      CORPUS_REGISTRY_BOUNDARY,
    );
    await validateRuntimeSemantics(runtime);
    await validateStorySemantics(story, issuers);
    await validateCollectionHistory(payload, { archiveIssuers: issuers });
    return payload;
  } catch {
    corpusBackupInvalid();
  }
}

export function readPilotBackup(filePath) {
  backupPath(filePath);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())
    )
      fail('backup file requires owner-only permissions');
    if (info.size > MAX_BYTES) fail('backup exceeds the 10 MiB local limit');
    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch {
      fail('backup is not valid JSON');
    }
    if (
      !exact(envelope, ['payload', 'sha256']) ||
      !/^[a-f0-9]{64}$/.test(envelope.sha256) ||
      envelope.sha256 !== hash(envelope.payload)
    )
      fail('backup checksum is invalid');
    if (envelope.payload?.format === FORMAT_V5)
      validateCollectionRows(envelope.payload);
    else if (envelope.payload?.format === FORMAT_V4)
      validateV4Payload(envelope.payload);
    else if (envelope.payload?.format === FORMAT_V3)
      validateV3Payload(envelope.payload);
    else if (envelope.payload?.format === FORMAT_V2)
      validateV2Payload(envelope.payload);
    else validatePayload(envelope.payload);
    return envelope;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function migrationsFor(manifest, { historicalSchema } = {}) {
  const directory = path.join(manifest.snapshot, 'db/pilot-migrations');
  return pilotMigrationFiles(manifest, { historicalSchema }).map((name) => ({
    name,
    version: name.replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(directory, name)))
      .digest('hex'),
  }));
}

function inspectSchema(db) {
  const names = rows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table';",
  ).map((row) => row.name);
  if (names.some((name) => name.startsWith('pilot_') && !KNOWN.includes(name)))
    fail('unknown pilot schema table');
  if (KNOWN.some((name) => !names.includes(name)))
    fail('pilot migrations are incomplete');
  return rows(
    db,
    `SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE tbl_name IN (${KNOWN.filter(
      (name) => !['pilot_schema_history', 'pilot_d1_migrations'].includes(name),
    )
      .map(sqlValue)
      .join(',')})
      AND sql IS NOT NULL AND type IN ('table','index','trigger') ORDER BY type,name;`,
  );
}

function inspectSchemaV2(db, format = FORMAT_V2) {
  const known =
    format === FORMAT_V5
      ? [...collectionTableNames(), ...V2_OMITTED]
      : format === FORMAT_V4
        ? V4_KNOWN
        : format === FORMAT_V3
          ? V3_KNOWN
          : V2_KNOWN;
  const schemaTables =
    format === FORMAT_V5
      ? collectionSchemaTables()
      : format === FORMAT_V4
        ? V4_SCHEMA_TABLES
        : format === FORMAT_V3
          ? V3_SCHEMA_TABLES
          : V2_SCHEMA_TABLES;
  const objects = rows(
    db,
    "SELECT type,name FROM sqlite_master WHERE type IN ('table','view');",
  );
  if (objects.some((item) => item.type === 'view'))
    fail('database views are unsupported');
  const names = objects.map((row) => row.name);
  if (names.some((name) => name.startsWith('pilot_') && !known.includes(name)))
    fail('unknown pilot schema table');
  if (known.some((name) => !names.includes(name)))
    fail('pilot migrations are incomplete');
  return rows(
    db,
    `SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE tbl_name IN (${schemaTables.map(sqlValue).join(',')})
      AND sql IS NOT NULL AND type IN ('table','index','trigger') ORDER BY name;`,
  );
}

function checkMigrationHistory(db, migrations) {
  const recorded = rows(
    db,
    'SELECT version,checksum FROM pilot_schema_history ORDER BY version;',
  );
  const applied = rows(
    db,
    'SELECT name FROM pilot_d1_migrations ORDER BY name;',
  );
  if (
    recorded.length !== migrations.length ||
    applied.length !== migrations.length ||
    migrations.some(
      (item) =>
        !recorded.some(
          (row) => row.version === item.version && row.checksum === item.sha256,
        ) || !applied.some((row) => row.name === item.name),
    )
  )
    fail('migration history differs from the frozen candidate');
}

async function contentFor(manifest) {
  const { FOREST_LESSON } = await import(
    pathToFileURL(path.join(manifest.snapshot, 'lib/preview/content.ts'))
  );
  return { 'forest-01-v1': hash(FOREST_LESSON) };
}

function backupFormatForMigrations(migrations) {
  const v1 = ['0000-auth.sql', '0001-data.sql', '0002-learning.sql'];
  const v2 = [...v1, '0003-curriculum.sql'];
  const v3 = [...v2, '0004-curriculum-runtime.sql'];
  const v4 = [...v3, '0005-family-story.sql'];
  const v5 = [...v4, '0006-collection-learning.sql'];
  const v6 = [...v5, '0007-corpus-learning.sql'];
  const matches = (names) =>
    migrations.length === names.length &&
    migrations.every(
      (item, index) =>
        item.name === names[index] &&
        item.version ===
          names[index].replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
    );
  if (matches(v1)) return FORMAT;
  if (matches(v2)) return FORMAT_V2;
  if (matches(v3)) return FORMAT_V3;
  if (matches(v4)) return FORMAT_V4;
  if (matches(v5)) return FORMAT_V5;
  if (matches(v6)) return FORMAT_V6;
  fail(
    'backup version incompatible with candidate',
    'BACKUP_VERSION_INCOMPATIBLE',
  );
}

export function pilotBackupFormatForCandidate(manifest, options) {
  return backupFormatForMigrations(migrationsFor(manifest, options));
}

async function contentIdentitiesForV2(manifest, tables) {
  const legacy = await contentFor(manifest);
  const curriculum = {};
  for (const row of tables.pilot_curriculum_package) {
    let packageManifest;
    try {
      packageManifest = JSON.parse(row.manifest_json);
    } catch {
      fail('malformed curriculum manifest');
    }
    curriculum[row.lesson_version] = {
      lessonId: row.lesson_id,
      canonicalizationVersion: row.canonicalization_version,
      digest: row.content_digest,
    };
    if (packageManifest.lessonVersion !== row.lesson_version)
      fail('curriculum package version differs from manifest');
  }
  return {
    legacy: Object.fromEntries(
      Object.entries(legacy).map(([lessonVersion, digest]) => [
        lessonVersion,
        {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest,
        },
      ]),
    ),
    curriculum,
  };
}

function capture(db) {
  // All table subqueries belong to one SQLite SELECT, so they observe one
  // database snapshot even if an ordinary learning request commits concurrently.
  const values = TABLES.flatMap((table) => {
    const columns = COLUMNS[table];
    const object = `json_object(${columns.flatMap((column) => [sqlValue(column), ident(column)]).join(',')})`;
    const ordered = `SELECT ${columns.map(ident).join(',')} FROM ${ident(table)} ORDER BY ${columns.map(ident).join(',')}`;
    return [
      sqlValue(table),
      `json((SELECT json_group_array(${object}) FROM (${ordered})))`,
    ];
  });
  values.push(
    "'installationId'",
    '(SELECT installation_id FROM pilot_installation WHERE id=1)',
  );
  const captured = JSON.parse(
    rows(db, `SELECT json_object(${values.join(',')}) AS snapshot;`)[0]
      .snapshot,
  );
  const { installationId, ...tables } = captured;
  return { installationId, tables };
}

function captureV2(db, tableNames = V2_TABLES) {
  const values = tableNames.flatMap((table) => {
    const columns = columnsFor(table);
    const object = `json_object(${columns.flatMap((column) => [sqlValue(column), ident(column)]).join(',')})`;
    const ordered = `SELECT ${columns.map(ident).join(',')} FROM ${ident(table)} ORDER BY ${columns.map(ident).join(',')}`;
    return [
      sqlValue(table),
      `json((SELECT json_group_array(${object}) FROM (${ordered})))`,
    ];
  });
  values.push(
    "'installationId'",
    '(SELECT installation_id FROM pilot_installation WHERE id=1)',
  );
  const captured = JSON.parse(
    rows(db, `SELECT json_object(${values.join(',')}) AS snapshot;`)[0]
      .snapshot,
  );
  const { installationId, ...tables } = captured;
  return { installationId, tables };
}

function metadata(payload, checksum, installationId) {
  return {
    format: FORMAT,
    sha256: checksum,
    installationId,
    counts: Object.fromEntries(
      TABLES.map((table) => [table, payload.tables[table].length]),
    ),
  };
}

function metadataFor(payload, checksum, installationId, tableNames) {
  return {
    format: payload.format,
    sha256: checksum,
    installationId,
    counts: Object.fromEntries(
      tableNames.map((table) => [table, payload.tables[table].length]),
    ),
  };
}

export async function backupPilot({
  manifest,
  configPath,
  state,
  filePath,
  archiveIssuers = [],
  historicalSchema,
}) {
  const migrations = migrationsFor(manifest, { historicalSchema });
  const format = backupFormatForMigrations(migrations);
  if (format === FORMAT_V6)
    fail(
      'corpus recovery requires the owned Node/libSQL adapter',
      'BACKUP_BACKEND_UNSUPPORTED',
    );
  backupPath(filePath, manifest);
  const db = localD1(manifest, { configPath, state, historicalSchema });
  checkMigrationHistory(db, migrations);
  if (
    format === FORMAT_V2 ||
    format === FORMAT_V3 ||
    format === FORMAT_V4 ||
    format === FORMAT_V5
  ) {
    const tableNames =
      format === FORMAT_V5
        ? collectionTableNames()
        : format === FORMAT_V4
          ? V4_TABLES
          : format === FORMAT_V3
            ? V3_TABLES
            : V2_TABLES;
    const schema = inspectSchemaV2(db, format);
    if (rows(db, 'PRAGMA foreign_key_check;').length)
      fail('source foreign-key integrity check failed');
    const captured = captureV2(db, tableNames);
    const payload = {
      format,
      createdAt: new Date().toISOString(),
      candidateId: manifest.candidateId,
      sourceInstallationId: captured.installationId,
      migrations,
      schemaDigest: hash(schema),
      schema,
      contentIdentities: await contentIdentitiesForV2(
        manifest,
        captured.tables,
      ),
      tables: captured.tables,
    };
    if (format === FORMAT_V5)
      await validatePilotCollectionBackup(payload, { archiveIssuers });
    else if (format === FORMAT_V4)
      await validatePilotStoryBackup(payload, { archiveIssuers });
    else if (format === FORMAT_V3) await validatePilotRuntimeBackup(payload);
    else validateV2Payload(payload);
    const checksum = hash(payload);
    const serialized = JSON.stringify({ payload, sha256: checksum });
    if (Buffer.byteLength(serialized) > MAX_BYTES)
      fail('backup exceeds the 10 MiB local limit');
    fs.writeFileSync(filePath, serialized, { mode: 0o600, flag: 'wx' });
    return metadataFor(payload, checksum, captured.installationId, tableNames);
  }
  const schema = inspectSchema(db);
  if (rows(db, 'PRAGMA foreign_key_check;').length)
    fail('source foreign-key integrity check failed');
  const captured = capture(db);
  const payload = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    candidateId: manifest.candidateId,
    sourceInstallationId: captured.installationId,
    migrations,
    schemaDigest: hash(schema),
    schema,
    contentVersions: await contentFor(manifest),
    tables: captured.tables,
  };
  validatePayload(payload);
  const sha256 = hash(payload);
  const serialized = JSON.stringify({ payload, sha256 });
  if (Buffer.byteLength(serialized) > MAX_BYTES)
    fail('backup exceeds the 10 MiB local limit');
  fs.writeFileSync(filePath, serialized, { mode: 0o600, flag: 'wx' });
  return metadata(payload, sha256, captured.installationId);
}

function assertFresh(db) {
  const tables = rows(
    db,
    "SELECT name FROM sqlite_master WHERE type='table';",
  ).map((row) => row.name);
  const internal = new Set(['sqlite_sequence', '_cf_METADATA']);
  if (tables.some((table) => !KNOWN.includes(table) && !internal.has(table)))
    fail('destination contains unrelated tables');
  for (const table of [
    ...TABLES,
    'pilot_auth_session',
    'pilot_auth_verification',
  ]) {
    if (
      tables.includes(table) &&
      rows(db, `SELECT COUNT(*) AS n FROM ${ident(table)};`)[0].n !== 0
    )
      fail('destination must be fresh; existing data will not be replaced');
  }
}

function assertFreshV2(db, requireSchema = false, format = FORMAT_V2) {
  const known =
    format === FORMAT_V5
      ? [...collectionTableNames(), ...V2_OMITTED]
      : format === FORMAT_V4
        ? V4_KNOWN
        : format === FORMAT_V3
          ? V3_KNOWN
          : V2_KNOWN;
  const dataTables =
    format === FORMAT_V5
      ? collectionTableNames()
      : format === FORMAT_V4
        ? V4_TABLES
        : format === FORMAT_V3
          ? V3_TABLES
          : V2_TABLES;
  const objects = rows(
    db,
    "SELECT type,name FROM sqlite_master WHERE type IN ('table','view');",
  );
  if (objects.some((item) => item.type === 'view'))
    fail('database views are unsupported');
  const tables = objects.map((row) => row.name);
  const internal = new Set(['sqlite_sequence', '_cf_METADATA']);
  if (
    tables.some((table) => table.startsWith('pilot_') && !known.includes(table))
  )
    fail('destination contains an unsupported pilot table');
  if (requireSchema && known.some((table) => !tables.includes(table)))
    fail('pilot migrations are incomplete');
  if (tables.some((table) => !known.includes(table) && !internal.has(table)))
    fail('destination contains unrelated tables');
  for (const table of [
    ...dataTables.filter((name) => name !== 'pilot_curriculum_registry_state'),
    'pilot_auth_session',
    'pilot_auth_verification',
  ]) {
    if (
      tables.includes(table) &&
      rows(db, `SELECT COUNT(*) AS n FROM ${ident(table)};`)[0].n !== 0
    )
      fail('destination must be fresh; existing data will not be replaced');
  }
  if (tables.includes('pilot_curriculum_registry_state')) {
    const stateRows = rows(
      db,
      'SELECT id,revision,updated_at FROM pilot_curriculum_registry_state;',
    );
    if (
      stateRows.length !== 1 ||
      stateRows[0].id !== 1 ||
      stateRows[0].revision !== 0 ||
      stateRows[0].updated_at !== 0
    )
      fail('destination registry state is not the fresh baseline');
  }
}

function insertStatements(table, tableRows) {
  const columns = columnsFor(table);
  return tableRows.map(
    (row) =>
      `INSERT INTO ${ident(table)}(${columns.map(ident).join(',')}) VALUES(${columns.map((column) => restoreValue(row[column])).join(',')});`,
  );
}

function countExpression(tableNames) {
  return tableNames
    .map((table) => `(SELECT COUNT(*) FROM ${ident(table)})`)
    .join('+');
}

async function restorePilotRegistry(
  {
    manifest,
    configPath,
    state,
    decorateDatabase,
    archiveIssuers = [],
    historicalSchema,
  },
  envelope,
) {
  const { payload, sha256 } = envelope;
  const format = payload.format;
  const tableNames =
    format === FORMAT_V5
      ? collectionTableNames()
      : format === FORMAT_V4
        ? V4_TABLES
        : format === FORMAT_V3
          ? V3_TABLES
          : V2_TABLES;
  const migrations = migrationsFor(manifest, { historicalSchema });
  if (backupFormatForMigrations(migrations) !== format)
    fail(
      'backup version incompatible with candidate',
      'BACKUP_VERSION_INCOMPATIBLE',
    );
  if (JSON.stringify(payload.migrations) !== JSON.stringify(migrations))
    fail('backup migrations differ from the frozen candidate');
  const expectedLegacy = await contentFor(manifest);
  const actualLegacy = Object.fromEntries(
    Object.entries(payload.contentIdentities.legacy).map(
      ([version, identity]) => [version, identity.digest],
    ),
  );
  if (canonicalPackage(actualLegacy) !== canonicalPackage(expectedLegacy))
    fail('backup content differs from the frozen candidate');
  const db = localD1(manifest, { configPath, state, historicalSchema });
  assertFreshV2(db, false, format);
  db.migrate();
  assertFreshV2(db, true, format);
  const schema = inspectSchemaV2(db, format);
  if (hash(schema) !== payload.schemaDigest)
    fail('destination schema differs from the backup');
  const installationRows = rows(
    db,
    'SELECT id,installation_id FROM pilot_installation ORDER BY id;',
  );
  const destinationId = installationRows[0]?.installation_id;
  if (
    installationRows.length !== 1 ||
    installationRows[0]?.id !== 1 ||
    typeof destinationId !== 'string' ||
    !destinationId ||
    destinationId === payload.sourceInstallationId ||
    ((format === FORMAT_V3 || format === FORMAT_V4 || format === FORMAT_V5) &&
      payload.tables.pilot_curriculum_runtime_run.some(
        (run) => run.installation_id === destinationId,
      )) ||
    (format === FORMAT_V4 &&
      historicalStoryInstallationIds(payload).has(destinationId)) ||
    (format === FORMAT_V5 &&
      historicalCollectionInstallationIds(payload).has(destinationId))
  )
    fail('restore requires a different installation');
  const freshnessTables = [
    ...tableNames.filter((name) => name !== 'pilot_curriculum_registry_state'),
    'pilot_auth_session',
    'pilot_auth_verification',
  ];
  const count = countExpression(freshnessTables);
  const sourceState = payload.tables.pilot_curriculum_registry_state[0];
  const statements = [
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE pilot_restore_guard (ok INTEGER NOT NULL CHECK(ok=1));',
    `INSERT INTO pilot_restore_guard SELECT CASE WHEN (${count})=0 AND (SELECT COUNT(*) FROM pilot_curriculum_registry_state WHERE id=1 AND revision=0 AND updated_at=0)=1 AND (SELECT COUNT(*) FROM pilot_installation)=1 AND (SELECT installation_id FROM pilot_installation WHERE id=1)=${restoreValue(destinationId)} THEN 1 ELSE 0 END;`,
    `UPDATE pilot_curriculum_registry_state SET revision=${restoreValue(sourceState.revision)},updated_at=${restoreValue(sourceState.updated_at)} WHERE id=1 AND revision=0 AND updated_at=0;`,
  ];
  if (format === FORMAT_V5) {
    for (const { table, row } of collectionRestoreRows(payload))
      statements.push(...insertStatements(table, [row]));
  } else {
    for (const table of TABLES)
      statements.push(...insertStatements(table, payload.tables[table]));
    for (const table of [
      'pilot_curriculum_package',
      'pilot_curriculum_character',
    ])
      statements.push(...insertStatements(table, payload.tables[table]));
    statements.push(
      ...insertStatements(
        'pilot_curriculum_review',
        [...payload.tables.pilot_curriculum_review].sort(
          (left, right) =>
            left.lesson_version.localeCompare(right.lesson_version) ||
            left.review_sequence - right.review_sequence,
        ),
      ),
    );
    statements.push(
      ...insertStatements(
        'pilot_curriculum_audit',
        payload.tables.pilot_curriculum_audit,
      ),
    );
    if (format === FORMAT_V3 || format === FORMAT_V4) {
      statements.push(
        ...insertStatements(
          'pilot_curriculum_runtime_run',
          payload.tables.pilot_curriculum_runtime_run,
        ),
      );
      statements.push(
        ...insertStatements(
          'pilot_curriculum_runtime_event',
          [...payload.tables.pilot_curriculum_runtime_event].sort(
            (left, right) =>
              compare(left.run_id, right.run_id) ||
              left.sequence - right.sequence,
          ),
        ),
      );
      statements.push(
        ...insertStatements(
          'pilot_curriculum_runtime_audit',
          [...payload.tables.pilot_curriculum_runtime_audit].sort(
            (left, right) =>
              compare(left.run_id, right.run_id) ||
              left.revision - right.revision,
          ),
        ),
      );
    }
    if (format === FORMAT_V4) {
      for (const table of STORY_TABLES) {
        let values = payload.tables[table];
        if (table === 'pilot_curriculum_publication')
          values = [...values].sort(
            (a, b) =>
              compare(a.installation_id, b.installation_id) ||
              compare(a.lesson_version, b.lesson_version) ||
              a.generation - b.generation,
          );
        if (table === 'pilot_curriculum_learning_event')
          values = [...values].sort(
            (a, b) => compare(a.run_id, b.run_id) || a.sequence - b.sequence,
          );
        statements.push(...insertStatements(table, values));
      }
    }
  }
  statements.push('DROP TABLE pilot_restore_guard;');
  const targetDb = decorateDatabase ? decorateDatabase(db) : db;
  let uncertain = false;
  if (format === FORMAT_V4 || format === FORMAT_V5) {
    try {
      targetDb.query(statements.join('\n'));
    } catch {
      uncertain = true;
    }
  } else targetDb.query(statements.join('\n'));
  const verificationDb =
    format === FORMAT_V4 || format === FORMAT_V5 ? db : targetDb;
  try {
    const restored = captureV2(verificationDb, tableNames);
    if (
      tableDigestFor(restored.tables, tableNames) !==
        tableDigestFor(payload.tables, tableNames) ||
      restored.installationId !== destinationId ||
      rows(verificationDb, 'PRAGMA foreign_key_check;').length ||
      rows(verificationDb, 'SELECT COUNT(*) AS n FROM pilot_auth_session;')[0]
        .n !== 0 ||
      rows(
        verificationDb,
        'SELECT COUNT(*) AS n FROM pilot_auth_verification;',
      )[0].n !== 0
    )
      fail('restored evidence verification failed');
    if (format === FORMAT_V5)
      await validatePilotCollectionBackup(
        { ...payload, tables: restored.tables },
        { archiveIssuers },
      );
    else if (format === FORMAT_V4)
      await validatePilotStoryBackup(
        { ...payload, tables: restored.tables },
        { archiveIssuers },
      );
    else if (format === FORMAT_V3)
      await validatePilotRuntimeBackup({ ...payload, tables: restored.tables });
    else validateV2Payload({ ...payload, tables: restored.tables });
  } catch (error) {
    if (error?.code === 'RESTORE_UNCONFIRMED') throw error;
    fail(
      'post-commit verification could not confirm restore',
      'RESTORE_UNCONFIRMED',
    );
  }
  const restoredMetadata = metadataFor(
    payload,
    sha256,
    destinationId,
    tableNames,
  );
  return format === FORMAT_V4 || format === FORMAT_V5
    ? {
        ...restoredMetadata,
        commit: uncertain ? 'confirmed-after-uncertainty' : 'confirmed',
      }
    : restoredMetadata;
}

export async function restorePilot(
  {
    manifest,
    configPath,
    state,
    filePath,
    archiveIssuers = [],
    historicalSchema,
  },
  { decorateDatabase } = {},
) {
  const migrations = migrationsFor(manifest, { historicalSchema });
  const format = backupFormatForMigrations(migrations);
  if (format === FORMAT_V6)
    fail(
      'corpus recovery requires the owned Node/libSQL adapter',
      'BACKUP_BACKEND_UNSUPPORTED',
    );
  const { payload, sha256 } = readPilotBackup(filePath);
  if (payload.format !== format)
    fail(
      'backup version incompatible with candidate',
      'BACKUP_VERSION_INCOMPATIBLE',
    );
  if (format === FORMAT_V5)
    await validatePilotCollectionBackup(payload, { archiveIssuers });
  else if (format === FORMAT_V4)
    await validatePilotStoryBackup(payload, { archiveIssuers });
  else if (format === FORMAT_V3) await validatePilotRuntimeBackup(payload);
  if (format !== FORMAT)
    return restorePilotRegistry(
      {
        manifest,
        configPath,
        state,
        decorateDatabase,
        archiveIssuers,
        historicalSchema,
      },
      { payload, sha256 },
    );
  if (JSON.stringify(payload.migrations) !== JSON.stringify(migrations))
    fail('backup migrations differ from the frozen candidate');
  if (
    JSON.stringify(payload.contentVersions) !==
    JSON.stringify(await contentFor(manifest))
  )
    fail('backup content differs from the frozen candidate');
  const db = localD1(manifest, { configPath, state, historicalSchema });
  assertFresh(db);
  db.migrate();
  if (hash(inspectSchema(db)) !== payload.schemaDigest)
    fail('destination schema differs from the backup');
  const destinationId = rows(
    db,
    'SELECT installation_id FROM pilot_installation WHERE id=1;',
  )[0]?.installation_id;
  if (!destinationId || destinationId === payload.sourceInstallationId)
    fail('restore requires a different installation');
  const count = [...TABLES, 'pilot_auth_session', 'pilot_auth_verification']
    .map((table) => `(SELECT COUNT(*) FROM ${ident(table)})`)
    .join('+');
  const statements = [
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE pilot_restore_guard (ok INTEGER NOT NULL CHECK(ok=1));',
    `INSERT INTO pilot_restore_guard SELECT CASE WHEN (${count})=0 THEN 1 ELSE 0 END;`,
  ];
  for (const table of TABLES) {
    const columns = COLUMNS[table];
    for (const row of payload.tables[table])
      statements.push(
        `INSERT INTO ${ident(table)}(${columns.map(ident).join(',')}) VALUES(${columns.map((column) => restoreValue(row[column])).join(',')});`,
      );
  }
  statements.push('DROP TABLE pilot_restore_guard;');
  db.query(statements.join('\n'));
  const restored = capture(db);
  if (
    tableDigest(restored.tables) !== tableDigest(payload.tables) ||
    restored.installationId !== destinationId ||
    rows(db, 'PRAGMA foreign_key_check;').length ||
    rows(db, 'SELECT COUNT(*) AS n FROM pilot_auth_session;')[0].n !== 0 ||
    rows(db, 'SELECT COUNT(*) AS n FROM pilot_auth_verification;')[0].n !== 0
  )
    fail('restored evidence verification failed');
  return metadata(payload, sha256, destinationId);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  try {
    const operation = process.argv[2];
    if (!['backup', 'restore'].includes(operation))
      fail('choose backup or restore');
    const manifest = loadManifest(option('--manifest'));
    const input = {
      manifest,
      configPath: option('--config'),
      state: option('--state'),
      filePath: option('--file'),
    };
    const result = await (operation === 'backup'
      ? backupPilot(input)
      : restorePilot(input));
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      'Pilot backup/restore refused or failed. Check the selected owned paths, private file permissions, candidate versions and fresh destination; no private data is printed.',
    );
    process.exitCode = 1;
  }
}
