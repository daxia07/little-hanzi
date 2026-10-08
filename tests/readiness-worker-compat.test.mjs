import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import {
  legacyPreviewSentinelVersion,
  assertPilotCompatibilityManifest,
} from '../scripts/readiness-worker-compat.mjs';
import { restoreFormatProfile } from '../scripts/pilot-restore-harness.mjs';
import { assertLegacyRestoreSnapshot } from './pilot-restore-integration.mjs';

test('legacy suite uses preserved V1 sentinel without relabeling the frozen R3 candidate', () => {
  const manifest = Object.freeze({
    candidateId: 'r3-build',
    phase: 'r3',
    specVersion: 'r3-spec-2',
    integrationVersion: 'r3-integration-1',
    lessonVersion: 'forest-01-v4',
  });
  assert.equal(legacyPreviewSentinelVersion(manifest), 'forest-01-v1');
  assert.equal(manifest.lessonVersion, 'forest-01-v4');
  assert.equal(manifest.specVersion, 'r3-spec-2');
  assert.equal(
    legacyPreviewSentinelVersion({
      specVersion: 'r2-spec-2',
      lessonVersion: 'forest-01-v3',
    }),
    'forest-01-v3',
  );
});
test('R4 retains its own identity while exercising the preserved Worker pilot', () => {
  const manifest = Object.freeze({
    phase: 'r4',
    specVersion: 'r4-spec-2',
    integrationVersion: 'r4-integration-1',
    lessonVersion: 'forest-01-v4',
  });
  assert.equal(assertPilotCompatibilityManifest(manifest), true);
  assert.equal(legacyPreviewSentinelVersion(manifest), 'forest-01-v1');
  assert.equal(manifest.phase, 'r4');
  assert.throws(() =>
    assertPilotCompatibilityManifest({ ...manifest, specVersion: 'r3-spec-2' }),
  );
});
test('legacy V4 backup oracle refuses missing sixth migration or populated story rows', () => {
  const tables = Object.fromEntries(
    restoreFormatProfile('pilot-admin-backup-4').tables.map((t) => [t, []]),
  );
  const names = [
    '0000-auth.sql',
    '0001-data.sql',
    '0002-learning.sql',
    '0003-curriculum.sql',
    '0004-curriculum-runtime.sql',
    '0005-family-story.sql',
  ];
  const snapshot = {
    tables,
    migrations: names.map((name) => ({ name, sha256: 'a'.repeat(64) })),
  };
  assert.equal(
    assertLegacyRestoreSnapshot(snapshot, 'pilot-admin-backup-4'),
    true,
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      { ...snapshot, migrations: snapshot.migrations.slice(0, 5) },
      'pilot-admin-backup-4',
    ),
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      {
        ...snapshot,
        tables: { ...tables, pilot_learning_plan: [{ id: 'unexpected' }] },
      },
      'pilot-admin-backup-4',
    ),
  );
});
test('pilot compatibility accepts exactly frozen S2 or fully identified R3', () => {
  assert.doesNotThrow(() =>
    assertPilotCompatibilityManifest({
      specVersion: 's2-spec-1',
      lessonVersion: 'forest-01-v1',
    }),
  );
  assert.doesNotThrow(() =>
    assertPilotCompatibilityManifest({
      phase: 'r3',
      specVersion: 'r3-spec-2',
      integrationVersion: 'r3-integration-1',
      lessonVersion: 'forest-01-v4',
    }),
  );
  for (const bad of [
    { specVersion: 'r3-spec-3' },
    { specVersion: 'r3-spec-2', lessonVersion: 'forest-01-v1' },
    {
      phase: 'r3',
      specVersion: 'r3-spec-2',
      integrationVersion: 'r3-integration-0',
      lessonVersion: 'forest-01-v4',
    },
  ])
    assert.throws(() => assertPilotCompatibilityManifest(bad));
});
test('V4 restore profile adds exact fourteen story tables and retains all prior schema profiles', () => {
  const v3 = restoreFormatProfile('pilot-admin-backup-3');
  const v4 = restoreFormatProfile('pilot-admin-backup-4');
  assert.equal(v3.tables.length, 21);
  assert.equal(v4.tables.length, 35);
  assert.deepEqual(
    v4.tables.filter((t) => !v3.tables.includes(t)).sort(),
    [
      'pilot_curriculum_proof_receipt',
      'pilot_curriculum_owner_decision',
      'pilot_curriculum_publication',
      'pilot_curriculum_trial_member',
      'pilot_curriculum_publication_state',
      'pilot_curriculum_publication_audit',
      'pilot_placement_proposal',
      'pilot_learning_plan',
      'pilot_learning_plan_item',
      'pilot_curriculum_assignment',
      'pilot_learning_schedule',
      'pilot_curriculum_learning_run',
      'pilot_curriculum_learning_event',
      'pilot_curriculum_learning_audit',
    ].sort(),
  );
  assert.equal(v4.curriculum, true);
  assert.equal(v4.runtime, true);
  assert.equal(v4.story, true);
  assert.equal(restoreFormatProfile('pilot-admin-backup-1').tables.length, 13);
  assert.equal(restoreFormatProfile('pilot-admin-backup-2').tables.length, 18);
  assert.throws(() => restoreFormatProfile('pilot-admin-backup-6'));
});

test('[R5-E-012] frozen R5 identity selects legacy V1 sentinel without relabeling; mixed/future identities refuse', () => {
  const manifest = Object.freeze({
    candidateId: 'r5-build',
    phase: 'r5',
    specVersion: 'r5-spec-2',
    integrationVersion: 'r5-integration-1',
    lessonVersion: 'little-hanzi-path-1-v1',
  });
  assert.equal(assertPilotCompatibilityManifest(manifest), true);
  assert.equal(legacyPreviewSentinelVersion(manifest), 'forest-01-v1');
  assert.equal(manifest.lessonVersion, 'little-hanzi-path-1-v1');
  for (const bad of [
    { ...manifest, phase: 'r6' },
    { ...manifest, specVersion: 'r5-spec-1' },
    { ...manifest, integrationVersion: 'r4-integration-1' },
    { ...manifest, lessonVersion: 'forest-01-v4' },
    { ...manifest, lessonVersion: 'little-hanzi-path-1-v2' },
  ])
    assert.throws(() => assertPilotCompatibilityManifest(bad));
});
test('[R5-E-012] exact V5 profile includes45/7 and legacy oracle rejects missing/future/populated collection boundaries', () => {
  const profile = restoreFormatProfile('pilot-admin-backup-5');
  assert.equal(profile.tables.length, 45);
  assert.equal(new Set(profile.tables).size, 45);
  assert.equal(profile.collection, true);
  assert.equal(profile.story, true);
  assert.equal(profile.runtime, true);
  assert.equal(profile.curriculum, true);
  const tables = Object.fromEntries(profile.tables.map((t) => [t, []]));
  const migrations = [
    '0000-auth.sql',
    '0001-data.sql',
    '0002-learning.sql',
    '0003-curriculum.sql',
    '0004-curriculum-runtime.sql',
    '0005-family-story.sql',
    '0006-collection-learning.sql',
  ].map((name) => ({ name, sha256: 'a'.repeat(64) }));
  const snapshot = { tables, migrations };
  assert.equal(
    assertLegacyRestoreSnapshot(snapshot, 'pilot-admin-backup-5'),
    true,
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      { ...snapshot, migrations: migrations.slice(0, 6) },
      'pilot-admin-backup-5',
    ),
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      {
        ...snapshot,
        migrations: [
          ...migrations,
          { name: '0007-future.sql', sha256: 'a'.repeat(64) },
        ],
      },
      'pilot-admin-backup-5',
    ),
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      {
        ...snapshot,
        tables: {
          ...tables,
          pilot_collection: [{ collection_version: 'unexpected' }],
        },
      },
      'pilot-admin-backup-5',
    ),
  );
  assert.throws(() => restoreFormatProfile('pilot-admin-backup-6'));
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      {
        tables: Object.fromEntries(
          restoreFormatProfile('pilot-admin-backup-1').tables.map((t) => [
            t,
            [],
          ]),
        ),
      },
      'pilot-admin-backup-6',
    ),
  );
});

test('[R5-E-012] unknown readiness phase cannot masquerade as preserved S2 and V5 inspection requires all fifty physical schema tables', () => {
  assert.throws(() =>
    assertPilotCompatibilityManifest({
      phase: 'r6',
      specVersion: 's2-spec-1',
      lessonVersion: 'forest-01-v1',
    }),
  );
  const profile = restoreFormatProfile('pilot-admin-backup-5');
  const names = [
    '0000-auth.sql',
    '0001-data.sql',
    '0002-learning.sql',
    '0003-curriculum.sql',
    '0004-curriculum-runtime.sql',
    '0005-family-story.sql',
    '0006-collection-learning.sql',
  ];
  const snapshot = {
    tables: Object.fromEntries(profile.tables.map((t) => [t, []])),
    migrations: {
      applied: names.map((name) => ({ name })),
      history: names.map((name) => ({
        version: name.replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
        checksum: 'a'.repeat(64),
      })),
    },
    schemaObjects: [
      ...profile.tables,
      'pilot_installation',
      'pilot_auth_session',
      'pilot_auth_verification',
      'pilot_schema_history',
      'pilot_d1_migrations',
    ].map((name) => ({ type: 'table', name })),
    foreignKeyViolations: [],
  };
  assert.equal(snapshot.schemaObjects.length, 50);
  assert.equal(
    assertLegacyRestoreSnapshot(snapshot, 'pilot-admin-backup-5'),
    true,
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      { ...snapshot, schemaObjects: snapshot.schemaObjects.slice(0, 49) },
      'pilot-admin-backup-5',
    ),
  );
  assert.throws(() =>
    assertLegacyRestoreSnapshot(
      { ...snapshot, foreignKeyViolations: [{ table: 'pilot_collection' }] },
      'pilot-admin-backup-5',
    ),
  );
});

await test('R6 legacy D1 schema selection is explicit and retains exact candidate identity', async () => {
  const api = await import('../scripts/readiness-worker-compat.mjs');
  const { pilotBackupFormatForCandidate, backupPilot } =
    await import('../scripts/pilot-backup.mjs');
  const { localD1 } = await import('../scripts/pilot-local-db.mjs');
  const manifest = Object.freeze({
    phase: 'r6',
    specVersion: 'r6-spec-2',
    integrationVersion: 'r6-integration-1',
    lessonVersion: 'hanzi-starter-draft-v1',
    candidateId: 'r6-exact',
    snapshot: path.resolve(import.meta.dirname, '..'),
  });
  const before = JSON.stringify(manifest);
  assert.throws(() => api.assertPilotCompatibilityManifest(manifest));
  assert.equal(
    api.assertPilotCompatibilityManifest(manifest, { historicalSchema: 'r5' }),
    true,
  );
  assert.equal(
    api.pilotMigrationFiles(manifest, { historicalSchema: 'r5' }).length,
    7,
  );
  assert.equal(api.pilotMigrationFiles(manifest).length, 8);
  assert.equal(
    pilotBackupFormatForCandidate(manifest, { historicalSchema: 'r5' }),
    'pilot-admin-backup-5',
  );
  assert.equal(pilotBackupFormatForCandidate(manifest), 'pilot-admin-backup-6');
  await assert.rejects(
    () =>
      backupPilot({
        manifest,
        configPath: 'never-read',
        state: 'never-read',
        filePath: 'never-write',
      }),
    (e) => e.code === 'BACKUP_BACKEND_UNSUPPORTED',
  );
  for (const value of ['r4', 'r6', '', null])
    assert.throws(() =>
      api.pilotMigrationFiles(manifest, { historicalSchema: value }),
    );
  for (const changed of [
    { phase: 'r5' },
    { integrationVersion: 'r6-integration-2' },
    { lessonVersion: 'little-hanzi-path-1-v1' },
  ])
    assert.throws(() =>
      api.pilotMigrationFiles(
        { ...manifest, ...changed },
        { historicalSchema: 'r5' },
      ),
    );
  assert.throws(
    () =>
      localD1(
        { ...manifest, phase: 'r5' },
        {
          historicalSchema: 'r5',
          state: 'never-read',
          configPath: 'never-read',
        },
      ),
    /historical|compatibility/i,
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hanzi-legacy-selection-'),
  );
  fs.writeFileSync(
    path.join(root, '.hanzi-qa-owned'),
    'historical schema refusal test',
  );
  try {
    fs.cpSync(
      path.join(manifest.snapshot, 'db/pilot-migrations'),
      path.join(root, 'db/pilot-migrations'),
      { recursive: true },
    );
    const selected = { ...manifest, snapshot: root };
    assert.equal(
      api.pilotMigrationFiles(selected, { historicalSchema: 'r5' }).length,
      7,
    );
    fs.writeFileSync(
      path.join(root, 'db/pilot-migrations/0008-unknown.sql'),
      'SELECT 1;',
    );
    assert.throws(
      () => api.pilotMigrationFiles(selected, { historicalSchema: 'r5' }),
      /exact known/,
    );
    fs.rmSync(path.join(root, 'db/pilot-migrations/0008-unknown.sql'));
    fs.rmSync(path.join(root, 'db/pilot-migrations/0007-corpus-learning.sql'));
    assert.throws(
      () => api.pilotMigrationFiles(selected, { historicalSchema: 'r5' }),
      /exact known/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(JSON.stringify(manifest), before);
});
