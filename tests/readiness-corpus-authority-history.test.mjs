import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  prepareOwnedCorpus,
  publishOwnedCorpus,
  withdrawOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  ownedCorpusArchiveSource,
  archiveHash,
  corpusDigest,
} from './helpers/corpus-archive-fixture.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import * as archive from '../scripts/pilot-corpus-backup.mjs';

const owned = ownedCorpusArchiveSource();
after(owned.close);
let saved;
await withOwnedCorpusFixture('draft-corpus', async (f) => {
  const first = await bootstrapOwnedCorpus(f.handle);
  const withdrawn = await withdrawOwnedCorpus(f.handle, {
    requestId: 'history-withdraw',
    expectedRevision: 1,
    predecessorPublicationId: first.recordId,
  });
  const prepared = await prepareOwnedCorpus(f.handle);
  await publishOwnedCorpus(f.handle, {
    requestId: 'history-new-generation',
    snapshotId: prepared.snapshotId,
    expectedRevision: 2,
    predecessorPublicationId: withdrawn.recordId,
  });
  // Historical validation must preserve facts after current installation/auth changes.
  await f.client.execute(
    "UPDATE pilot_installation SET installation_id='fresh-after-groups' WHERE id=1",
  );
  await f.client.execute(
    "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-op'",
  );
  const tables = {};
  for (const [table, columns] of Object.entries(archive.corpusColumns())) {
    tables[table] = (
      await f.client.execute(`SELECT ${columns.join(',')} FROM ${table}`)
    ).rows.map((r) => Object.fromEntries(columns.map((k) => [k, r[k]])));
  }
  saved = {
    format: 'pilot-admin-backup-6',
    createdAt: new Date().toISOString(),
    candidateId: f.config.candidateId,
    sourceInstallationId: 'fresh-after-groups',
    migrations: owned.source.migrations,
    schemaDigest: archiveHash(owned.source.schema),
    schema: owned.source.schema,
    contentIdentities: {
      legacy: {
        'forest-01-v1': {
          lessonId: 'forest-01',
          algorithm: 's2-json-stringify-sha256-v1',
          digest: archiveHash(FOREST_LESSON),
        },
      },
      curriculum: Object.fromEntries(
        tables.pilot_curriculum_package.map((r) => [
          r.lesson_version,
          {
            lessonId: r.lesson_id,
            canonicalizationVersion: r.canonicalization_version,
            digest: r.content_digest,
          },
        ]),
      ),
    },
    tables,
  };
});
const validate = (p) =>
  process.env.CORPUS_AUTHORITY_HISTORY_BASELINE === 'snapshot'
    ? archive.validateCorpusSnapshotHistory(p, { source: owned.source })
    : archive.validateCorpusAuthorityHistory(p, { source: owned.source });

test('[R6-E-008/013] actual verification release, withdrawal and new generation retain original historical groups', async () => {
  const bytes = JSON.stringify(saved),
    result = await validate(saved);
  assert.equal(JSON.stringify(result), bytes);
  assert.equal(result.tables.pilot_corpus_publication.length, 3);
  assert.equal(result.tables.pilot_corpus_snapshot.length, 2);
  assert.equal(result.tables.pilot_corpus_snapshot_member.length, 40);
  assert.equal(result.tables.pilot_corpus_publication_audit.length, 3);
  for (const p of result.tables.pilot_corpus_publication) {
    assert.equal(p.scope_kind, 'verification');
    assert.equal(p.owner_decision_id, null);
    assert.notEqual(p.installation_id, 'fresh-after-groups');
  }
  for (const s of result.tables.pilot_corpus_snapshot)
    assert.equal(s.expected_included_count, 0);
});
test('[R6-E-008/013] full authority chain refuses missing audit, missing scope and invented heads', async () => {
  for (const mutate of [
    (p) => p.tables.pilot_corpus_publication_audit.pop(),
    (p) => p.tables.pilot_corpus_trial_member.pop(),
    (p) => {
      p.tables.pilot_corpus_publication_state[0].revision = 1;
    },
    (p) => {
      p.tables.pilot_corpus_publication[2].predecessor_id =
        p.tables.pilot_corpus_publication[0].id;
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-007/008/013] historical receipts cannot be rewritten or relabeled as ordinary starter authority', async () => {
  for (const mutate of [
    (p) => {
      const row = p.tables.pilot_corpus_publication[0],
        ack = JSON.parse(row.ack_json);
      ack.revision = 99;
      row.ack_json = canonicalPackage(ack);
    },
    (p) => {
      const row = p.tables.pilot_corpus_publication[0];
      row.scope_kind = 'starter';
      row.scope_json = canonicalPackage({ kind: 'starter' });
      row.scope_digest = corpusDigest({ kind: 'starter' });
      row.namespace_key = 'ordinary';
      row.test_run_id = null;
    },
    (p) => {
      const row = p.tables.pilot_corpus_publication[0],
        scope = JSON.parse(row.scope_json);
      scope.members[0].parentId = 'r6-parent-2';
      row.scope_json = canonicalPackage(scope);
      row.scope_digest = corpusDigest(scope);
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
