import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalPackage } from '../../lib/curriculum/digest.ts';
import { curriculumReviewRequest } from '../../lib/curriculum/review.ts';
import { FOREST_LESSON } from '../../lib/preview/content.ts';
import {
  CORPUS_MIGRATIONS,
  corpusSchemaSource,
} from '../../scripts/pilot-corpus-schema.mjs';
import {
  corpusTableNames,
  corpusColumns,
} from '../../scripts/pilot-corpus-backup.mjs';

export const archiveHash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const corpusDigest = (value) =>
  'sha256:' +
  crypto.createHash('sha256').update(canonicalPackage(value)).digest('hex');

/** Explicit safe-column in-memory test input; not a shipped capture/restore API. */
export async function corpusArchiveFromClient(
  client,
  source,
  { installationId, candidateId, createdAt = new Date().toISOString() },
) {
  const tables = {};
  for (const [table, columns] of Object.entries(corpusColumns())) {
    tables[table] = (
      await client.execute(`SELECT ${columns.join(',')} FROM ${table}`)
    ).rows.map((row) =>
      Object.fromEntries(columns.map((key) => [key, row[key]])),
    );
  }
  return {
    format: 'pilot-admin-backup-6',
    createdAt,
    candidateId,
    sourceInstallationId: installationId,
    migrations: source.migrations,
    schemaDigest: archiveHash(source.schema),
    schema: source.schema,
    contentIdentities: {
      legacy: {
        'forest-01-v1': {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest: archiveHash(FOREST_LESSON),
        },
      },
      curriculum: Object.fromEntries(
        tables.pilot_curriculum_package.map((row) => [
          row.lesson_version,
          {
            lessonId: row.lesson_id,
            canonicalizationVersion: row.canonicalization_version,
            digest: row.content_digest,
          },
        ]),
      ),
    },
    tables,
  };
}

export function ownedCorpusArchiveSource() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r6-union-source-')),
  );
  fs.writeFileSync(
    path.join(root, '.qa-owned'),
    'synthetic archive source only\n',
  );
  fs.mkdirSync(path.join(root, 'db/pilot-migrations'), { recursive: true });
  for (const name of CORPUS_MIGRATIONS) {
    const origin =
      name.startsWith('0007-') && !fs.existsSync(`db/pilot-migrations/${name}`)
        ? 'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql'
        : `db/pilot-migrations/${name}`;
    fs.copyFileSync(origin, path.join(root, 'db/pilot-migrations', name));
  }
  return {
    source: corpusSchemaSource(root),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Synthetic registry history with unchanged old, R5 and R6 identities and a rejected R6 review. */
export function mixedCorpusRegistryArchive(source) {
  const tables = Object.fromEntries(
    corpusTableNames().map((name) => [name, []]),
  );
  const user = 'synthetic-union-operator',
    namespace = 'synthetic-union';
  tables.pilot_auth_user = [
    {
      id: user,
      name: 'Synthetic operator',
      email: 'union@fixture.invalid',
      email_verified: 0,
      image: null,
      created_at: 0,
      updated_at: 0,
      username: user,
      display_username: user,
      role: 'operator',
      must_change_password: 0,
      disabled: 0,
    },
  ];
  const identities = {};
  for (const [index, file] of [
    'forest-01-v4.json',
    'collection/path-01-v1.json',
    'corpus/corpus-path-01-v1.json',
  ].entries()) {
    const p = JSON.parse(
      fs.readFileSync(
        new URL('../../content/curriculum/' + file, import.meta.url),
        'utf8',
      ),
    );
    const digest = corpusDigest(p);
    tables.pilot_curriculum_package.push({
      lesson_version: p.lessonVersion,
      lesson_id: p.lessonId,
      content_digest: digest,
      canonicalization_version: 's3-json-1',
      manifest_json: canonicalPackage(p),
      import_id: `synthetic-import-${index}`,
      imported_by_user_id: user,
      imported_at: 0,
      test_run_id: namespace,
    });
    tables.pilot_curriculum_character.push(
      ...p.characters.map((c, i) => ({
        lesson_version: p.lessonVersion,
        character_id: c.characterId,
        hanzi: c.hanzi,
        character_index: i,
      })),
    );
    tables.pilot_curriculum_audit.push({
      id: `synthetic-import-audit-${index}`,
      action: 'import',
      actor_user_id: user,
      lesson_version: p.lessonVersion,
      content_digest: digest,
      review_id: null,
      created_at: 0,
    });
    identities[p.lessonVersion] = {
      lessonId: p.lessonId,
      canonicalizationVersion: 's3-json-1',
      digest,
    };
  }
  const p = tables.pilot_curriculum_package[2];
  const review = {
    requestId: 'synthetic-review',
    contentDigest: p.content_digest,
    previousReviewId: null,
    decision: 'rejected',
    reviewerRef: 'synthetic-reviewer',
    reviewedAt: 0,
    checklistVersion: 'hanzi-review-1',
    checklist: Object.fromEntries(
      [
        'scriptAndGlyphs',
        'mandarinAndReadings',
        'wordContexts',
        'teachingAndChecks',
        'ageSuitability',
        'sourcesAndLicenses',
        'deviceAudio',
      ].map((key) => [key, false]),
    ),
    evidenceRef: 'synthetic-only',
    reason: 'Synthetic test; human review remains pending.',
  };
  tables.pilot_curriculum_review.push({
    review_id: 'synthetic-review',
    write_id: 'synthetic-review-write',
    lesson_version: p.lesson_version,
    content_digest: p.content_digest,
    previous_review_id: null,
    review_sequence: 1,
    decision: review.decision,
    reviewer_ref: review.reviewerRef,
    reviewed_at: 0,
    checklist_version: review.checklistVersion,
    checklist_json: canonicalPackage(review.checklist),
    evidence_ref: review.evidenceRef,
    reason: review.reason,
    recorded_by_user_id: user,
    recorded_at: 0,
    request_digest: corpusDigest(
      curriculumReviewRequest(p.lesson_version, user, namespace, review),
    ),
    test_run_id: namespace,
  });
  tables.pilot_curriculum_audit.push({
    id: 'synthetic-review-audit',
    action: 'review',
    actor_user_id: user,
    lesson_version: p.lesson_version,
    content_digest: p.content_digest,
    review_id: 'synthetic-review',
    created_at: 0,
  });
  tables.pilot_curriculum_registry_state = [
    { id: 1, revision: 4, updated_at: 0 },
  ];
  return {
    format: 'pilot-admin-backup-6',
    createdAt: '2026-09-27T00:00:00.000Z',
    candidateId: 'synthetic-union-candidate',
    sourceInstallationId: 'synthetic-union-source',
    migrations: source.migrations,
    schemaDigest: archiveHash(source.schema),
    schema: source.schema,
    contentIdentities: {
      legacy: {
        'forest-01-v1': {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest: archiveHash(FOREST_LESSON),
        },
      },
      curriculum: identities,
    },
    tables,
  };
}
