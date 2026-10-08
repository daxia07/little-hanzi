import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import {
  validatePilotCollectionBackup,
  collectionTableNames,
} from '../scripts/pilot-collection-backup.mjs';
import { collectionSchemaSource } from '../scripts/pilot-collection-schema.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';

const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function registryArchive(file) {
  const p = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
  const digest =
    'sha256:' +
    crypto.createHash('sha256').update(canonicalPackage(p)).digest('hex');
  const source = collectionSchemaSource();
  const tables = Object.fromEntries(
    collectionTableNames().map((name) => [name, []]),
  );
  tables.pilot_auth_user = [
    {
      id: 'synthetic-operator',
      name: 'Synthetic operator',
      email: 'operator@fixture.invalid',
      email_verified: 0,
      image: null,
      created_at: 0,
      updated_at: 0,
      username: 'synthetic_operator',
      display_username: 'synthetic_operator',
      role: 'operator',
      must_change_password: 0,
      disabled: 0,
    },
  ];
  tables.pilot_curriculum_registry_state = [
    { id: 1, revision: 1, updated_at: 0 },
  ];
  tables.pilot_curriculum_package = [
    {
      lesson_version: p.lessonVersion,
      lesson_id: p.lessonId,
      content_digest: digest,
      canonicalization_version: 's3-json-1',
      manifest_json: canonicalPackage(p),
      import_id: 'synthetic-import',
      imported_by_user_id: 'synthetic-operator',
      imported_at: 0,
      test_run_id: 'synthetic-boundary',
    },
  ];
  tables.pilot_curriculum_character = p.characters.map((c, i) => ({
    lesson_version: p.lessonVersion,
    character_id: c.characterId,
    hanzi: c.hanzi,
    character_index: i,
  }));
  tables.pilot_curriculum_audit = [
    {
      id: 'synthetic-import-audit',
      action: 'import',
      actor_user_id: 'synthetic-operator',
      lesson_version: p.lessonVersion,
      content_digest: digest,
      review_id: null,
      created_at: 0,
    },
  ];
  return {
    format: 'pilot-admin-backup-5',
    createdAt: '2026-09-27T00:00:00.000Z',
    candidateId: 'synthetic-legacy-boundary',
    sourceInstallationId: 'synthetic-source',
    migrations: source.migrations,
    schemaDigest: hash(source.schema),
    schema: source.schema,
    contentIdentities: {
      legacy: {
        'forest-01-v1': {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest: hash(FOREST_LESSON),
        },
      },
      curriculum: {
        [p.lessonVersion]: {
          lessonId: p.lessonId,
          canonicalizationVersion: 's3-json-1',
          digest,
        },
      },
    },
    tables,
  };
}

test('[R6-E-015] V5 retains a canonical R5 package with its complete registry audit', async () => {
  const archive = registryArchive(
    '../content/curriculum/collection/path-01-v1.json',
  );
  const original = JSON.stringify(archive);
  const accepted = await validatePilotCollectionBackup(archive);
  assert.equal(
    accepted.tables.pilot_curriculum_package[0].lesson_version,
    'path-01-v1',
  );
  assert.equal(JSON.stringify(archive), original);
});

test('[R6-E-013][R6-E-015] a structurally valid R6 package cannot enter an unchanged V5 archive', async () => {
  const archive = registryArchive(
    '../content/curriculum/corpus/corpus-path-01-v1.json',
  );
  assert.equal(archive.tables.pilot_curriculum_registry_state[0].revision, 1);
  assert.equal(archive.tables.pilot_curriculum_audit.length, 1);
  await assert.rejects(validatePilotCollectionBackup(archive), {
    code: 'BACKUP_COLLECTION_INVALID',
  });
});
