import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FOREST_LESSON } from '../lib/preview/content.ts';
import { collectionSchemaSource } from '../scripts/pilot-collection-schema.mjs';
import {
  collectionTableNames,
  validatePilotCollectionBackup,
  validateCollectionRows,
} from '../scripts/pilot-collection-backup.mjs';
import { validatePilotStoryBackup } from '../scripts/pilot-backup.mjs';

const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const source = collectionSchemaSource();
  const tables = Object.fromEntries(
    collectionTableNames().map((name) => [name, []]),
  );
  tables.pilot_curriculum_registry_state = [
    { id: 1, revision: 0, updated_at: 0 },
  ];
  return {
    format: 'pilot-admin-backup-5',
    createdAt: '2026-09-27T00:00:00.000Z',
    candidateId: 'qa-collection-backup',
    sourceInstallationId: 'qa-collection-source',
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
      curriculum: {},
    },
    tables,
  };
}

test('[R5-E-012] v5 validates the exact fresh45-table envelope and v4 refuses its format', async () => {
  const payload = fixture();
  const saved = await validatePilotCollectionBackup(payload);
  assert.equal(Object.keys(saved.tables).length, 45);
  await assert.rejects(
    () => validatePilotStoryBackup(payload),
    (e) => e.code === 'BACKUP_STORY_INVALID',
  );
});

test('[R5-E-012] unknown tables, private auth rows, changed schema and malformed collection facts fail closed', async () => {
  const changes = [
    (p) => {
      p.tables.unknown = [];
    },
    (p) => {
      p.tables.pilot_auth_session = [];
    },
    (p) => {
      p.schema[0].sql += ' invalid';
      p.schemaDigest = hash(p.schema);
    },
    (p) => {
      p.tables.pilot_collection.push({ collection_version: 'forged' });
    },
    (p) => {
      p.migrations[6].name = '0006-unknown.sql';
    },
  ];
  for (const change of changes) {
    const payload = fixture();
    change(payload);
    assert.throws(
      () => validateCollectionRows(payload),
      (e) => e.code === 'BACKUP_COLLECTION_INVALID',
    );
  }
});

test('[R5-E-012] archive preflight never invokes caller getters', () => {
  const payload = fixture();
  let touched = false;
  Object.defineProperty(payload, 'tables', {
    enumerable: true,
    get() {
      touched = true;
      return {};
    },
  });
  assert.throws(
    () => validateCollectionRows(payload),
    (e) => e.code === 'BACKUP_COLLECTION_INVALID',
  );
  assert.equal(touched, false);
});
