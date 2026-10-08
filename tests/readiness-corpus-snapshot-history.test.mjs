import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { withCorpusFixture } from './helpers/corpus-store-fixture.mjs';
import {
  ownedCorpusArchiveSource,
  archiveHash,
  corpusDigest,
} from './helpers/corpus-archive-fixture.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../lib/pilot/corpus-store.ts';
import {
  beginCorpusSnapshot,
  appendCorpusSnapshotChunk,
  sealCorpusSnapshot,
  readCorpusSnapshot,
} from '../lib/pilot/corpus-snapshot-store.ts';
import * as archive from '../scripts/pilot-corpus-backup.mjs';
import { canonicalPackage } from '../lib/curriculum/digest.ts';

const owned = ownedCorpusArchiveSource();
after(owned.close);
const d = 'sha256:' + 'a'.repeat(64);
let saved, buildingId, sealedId;
await withCorpusFixture(
  async (f) => {
    const c = f.context(),
      version = f.manifest.corpusVersion;
    for (const item of f.manifest.items) {
      await recordCorpusSource(c, version, {
        requestId: 'snapshot-history-source-' + item.lessonVersion,
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        classification: 'unverified-draft',
        sourceRefs: ['SYNTHETIC-NOT-REVIEWED'],
        licenseRefs: ['SYNTHETIC'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: null,
        expectedEvidenceDigest: null,
      });
    }
    await registerCorpusBatch(c, version, {
      requestId: 'snapshot-history-batch',
      batch: f.batch,
    });
    await registerCorpus(c, { corpus: f.manifest });
    const packages = f.manifest.items.map(
      ({ lessonVersion, contentDigest }) => ({ lessonVersion, contentDigest }),
    );
    const building = await beginCorpusSnapshot(c, version, {
      requestId: 'snapshot-history-building',
    });
    buildingId = building.snapshotId;
    await appendCorpusSnapshotChunk(c, version, buildingId, {
      requestId: 'snapshot-history-partial',
      packages: packages.slice(0, 2),
    });
    const sealed = await beginCorpusSnapshot(c, version, {
      requestId: 'snapshot-history-sealed',
    });
    sealedId = sealed.snapshotId;
    await appendCorpusSnapshotChunk(c, version, sealedId, {
      requestId: 'snapshot-history-complete',
      packages,
    });
    const current = await readCorpusSnapshot(c, version, sealedId);
    await sealCorpusSnapshot(c, version, sealedId, {
      requestId: 'snapshot-history-seal',
      expectedPlanDigest: current.planDigest,
    });
    // Historical validation must preserve the original facts after installation/actor changes.
    await f.client.execute(
      "UPDATE pilot_installation SET installation_id='fresh-after-snapshot' WHERE id=1",
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
      candidateId: 'r6-author',
      sourceInstallationId: 'fresh-after-snapshot',
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
  },
  {
    trust: {
      candidateId: 'r6-author',
      sourceDigest: d,
      artifactDigest: d,
      buildId: 'r6-author',
      issuers: [],
      archiveIssuers: [],
    },
  },
);

const validate =
  process.env.CORPUS_SNAPSHOT_HISTORY_BASELINE === 'proof'
    ? (p) => archive.validateCorpusProofHistory(p, { source: owned.source })
    : (p) => archive.validateCorpusSnapshotHistory(p, { source: owned.source });

test('[R6-E-003/013] actual libSQL building and sealed snapshots retain complete historical union', async () => {
  const bytes = JSON.stringify(saved),
    result = await validate(saved);
  assert.equal(JSON.stringify(result), bytes);
  assert.equal(result.tables.pilot_corpus_snapshot.length, 2);
  assert.equal(result.tables.pilot_corpus_snapshot_member.length, 24);
  for (const row of result.tables.pilot_corpus_snapshot) {
    assert.equal(row.installation_id, 'r6-author-install');
    assert.equal(row.expected_included_count, 0);
    assert.equal(row.expected_package_count, 0);
  }
});

test('[R6-E-003/013] full chain rejects missing sealed members and partial or orphan chunks', async () => {
  for (const mutate of [
    (p) => {
      const index = p.tables.pilot_corpus_snapshot_member.findIndex(
        (r) => r.snapshot_id === sealedId,
      );
      p.tables.pilot_corpus_snapshot_member.splice(index, 1);
    },
    (p) => {
      const index = p.tables.pilot_corpus_snapshot_member.findIndex(
        (r) => r.snapshot_id === buildingId,
      );
      p.tables.pilot_corpus_snapshot_member.splice(index, 1);
    },
    (p) => {
      p.tables.pilot_corpus_snapshot_member[0].snapshot_id = 'unknown-snapshot';
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});

test('[R6-E-003/013] full chain rejects rewritten receipts or coverage despite canonical replacement hashes', async () => {
  for (const mutate of [
    (p) => {
      const row = p.tables.pilot_corpus_snapshot.find(
          (r) => r.id === buildingId,
        ),
        ack = JSON.parse(row.ack_json);
      ack.status = 'sealed';
      row.ack_json = canonicalPackage(ack);
    },
    (p) => {
      const row = p.tables.pilot_corpus_snapshot.find((r) => r.id === sealedId),
        ack = JSON.parse(row.seal_ack_json);
      ack.includedCharacterCount = 1600;
      row.seal_ack_json = canonicalPackage(ack);
    },
    (p) => {
      const row = p.tables.pilot_corpus_snapshot_member[0],
        eligibility = JSON.parse(row.eligibility_json);
      eligibility.eligible = true;
      row.eligibility_json = canonicalPackage(eligibility);
      row.eligibility_digest = corpusDigest(eligibility);
    },
  ]) {
    const p = structuredClone(saved);
    mutate(p);
    await assert.rejects(() => validate(p), /BACKUP_CORPUS_INVALID/);
  }
});
