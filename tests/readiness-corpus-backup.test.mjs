import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  corpusSchemaSource,
  CORPUS_MIGRATIONS,
} from '../scripts/pilot-corpus-schema.mjs';
import { collectionTableNames } from '../scripts/pilot-collection-backup.mjs';
import { CORPUS_TABLES } from '../scripts/pilot-corpus-columns.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r6-backup-source-')),
);
fs.writeFileSync(
  path.join(root, '.qa-owned'),
  'synthetic source-only archive tests\n',
);
fs.mkdirSync(path.join(root, 'db/pilot-migrations'), { recursive: true });
for (const name of CORPUS_MIGRATIONS) {
  const origin =
    name.startsWith('0007-') && !fs.existsSync(`db/pilot-migrations/${name}`)
      ? 'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql'
      : `db/pilot-migrations/${name}`;
  fs.copyFileSync(origin, path.join(root, 'db/pilot-migrations', name));
}
after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = corpusSchemaSource(root);
const hash = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const baseline = process.env.CORPUS_ARCHIVE_BASELINE === 'collection';
const archiveReader = await import(
  baseline
    ? '../scripts/pilot-collection-backup.mjs'
    : '../scripts/pilot-corpus-backup.mjs'
);
const validateRows = baseline
  ? archiveReader.validateCollectionRows
  : archiveReader.validateCorpusRows;
function fixture() {
  const tables = Object.fromEntries(
    [...collectionTableNames(), ...CORPUS_TABLES].map((name) => [name, []]),
  );
  tables.pilot_curriculum_registry_state = [
    { id: 1, revision: 0, updated_at: 0 },
  ];
  return {
    format: 'pilot-admin-backup-6',
    createdAt: '2026-09-27T00:00:00.000Z',
    candidateId: 'qa-corpus-backup',
    sourceInstallationId: 'qa-corpus-source',
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
test('[R6-E-013] V6 accepts the exact67-table structural envelope without dropping old facts', () => {
  const input = fixture();
  const result = validateRows(input, source);
  assert.equal(Object.keys(result.tables).length, 67);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), input);
});
test('[R6-E-013/015] V6 refuses old format, unknown table, fresh epoch/session rows and changed source schema', () => {
  for (const change of [
    (p) => {
      p.format = 'pilot-admin-backup-5';
    },
    (p) => {
      p.tables.unknown = [];
    },
    (p) => {
      p.tables.pilot_corpus_evidence_epoch = [
        { id: 1, revision: 1, updated_at: 0 },
      ];
    },
    (p) => {
      p.tables.pilot_auth_session = [];
    },
    (p) => {
      p.schema[0].sql += ' changed';
      p.schemaDigest = hash(p.schema);
    },
    (p) => {
      p.migrations[7].name = '0007-unknown.sql';
    },
  ]) {
    const value = structuredClone(fixture());
    change(value);
    assert.throws(() => validateRows(value, source));
  }
});
test('[R6-E-013] preflight rejects accessors before reading their value', () => {
  const value = fixture();
  let touched = false;
  Object.defineProperty(value, 'tables', {
    enumerable: true,
    get() {
      touched = true;
      return {};
    },
  });
  assert.throws(() => validateRows(value, source));
  assert.equal(touched, false);
});
