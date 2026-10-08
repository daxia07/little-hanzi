import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { withCorpusFixture } from './helpers/corpus-store-fixture.mjs';
import {
  ownedCorpusArchiveSource,
  archiveHash,
  corpusDigest,
  corpusArchiveFromClient,
} from './helpers/corpus-archive-fixture.mjs';
import { FOREST_LESSON } from '../lib/preview/content.ts';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../lib/pilot/corpus-store.ts';
import * as archive from '../scripts/pilot-corpus-backup.mjs';
import { validateCorpusRegistryAndLegacyHistory } from '../scripts/pilot-backup.mjs';
import { canonicalPackage } from '../lib/curriculum/digest.ts';

const owned = ownedCorpusArchiveSource();
after(owned.close);
let saved;
await withCorpusFixture(async (f) => {
  const c = f.context();
  const requests = f.manifest.items.map((i) => ({
    requestId: 'archive-source-' + i.lessonVersion,
    lessonVersion: i.lessonVersion,
    contentDigest: i.contentDigest,
    classification: 'unverified-draft',
    sourceRefs: ['synthetic-source'],
    licenseRefs: ['synthetic-license'],
    reviewRefs: [],
    identityReviews: [],
    predecessorEvidenceId: null,
    expectedEvidenceDigest: null,
  }));
  for (const request of requests)
    await recordCorpusSource(c, f.manifest.corpusVersion, request);
  const first = (
    await f.client.execute(
      'SELECT * FROM pilot_corpus_source_evidence ORDER BY created_at,id LIMIT 1',
    )
  ).rows[0];
  await recordCorpusSource(c, f.manifest.corpusVersion, {
    ...requests.find((r) => r.lessonVersion === first.lesson_version),
    requestId: 'archive-source-successor',
    predecessorEvidenceId: first.id,
    expectedEvidenceDigest: first.evidence_digest,
    sourceRefs: ['synthetic-corrected-source'],
  });
  await registerCorpusBatch(c, f.manifest.corpusVersion, {
    requestId: 'archive-batch',
    batch: f.batch,
  });
  await registerCorpus(c, { corpus: f.manifest });
  const tables = {};
  for (const [table, columns] of Object.entries(archive.corpusColumns())) {
    tables[table] = (
      await f.client.execute(`SELECT ${columns.join(',')} FROM ${table}`)
    ).rows.map((r) => Object.fromEntries(columns.map((key) => [key, r[key]])));
  }
  saved = {
    format: 'pilot-admin-backup-6',
    createdAt: new Date().toISOString(),
    candidateId: 'r6-author',
    sourceInstallationId: 'r6-author-install',
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
const validate =
  process.env.CORPUS_REGISTRY_BASELINE === 'legacy-union'
    ? (p) => validateCorpusRegistryAndLegacyHistory(p, { source: owned.source })
    : (p) => archive.validateCorpusRegistryHistory(p, { source: owned.source });

test('[R6-E-001/013] actual source and batch history retain a valid 240-character original installation', async () => {
  await withCorpusFixture(async (f) => {
    const installationId = 'I'.repeat(240),
      c = f.context();
    await f.client.execute({
      sql: 'UPDATE pilot_installation SET installation_id=? WHERE id=1',
      args: [installationId],
    });
    c.corpus.fixtureBinding.installationId = installationId;
    for (const item of f.manifest.items)
      await recordCorpusSource(c, f.manifest.corpusVersion, {
        requestId: 'long-install-' + item.lessonVersion,
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        classification: 'unverified-draft',
        sourceRefs: ['synthetic-source'],
        licenseRefs: ['synthetic-license'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: null,
        expectedEvidenceDigest: null,
      });
    await registerCorpusBatch(c, f.manifest.corpusVersion, {
      requestId: 'long-install-batch',
      batch: f.batch,
    });
    await registerCorpus(c, { corpus: f.manifest });
    const payload = await corpusArchiveFromClient(f.client, owned.source, {
      installationId,
      candidateId: 'r6-author',
    });
    assert(
      payload.tables.pilot_corpus_source_evidence.every(
        (row) => row.installation_id === installationId,
      ),
    );
    assert.equal(
      payload.tables.pilot_corpus_batch[0].installation_id,
      installationId,
    );
    const validated = await validate(payload);
    assert.equal(JSON.stringify(validated), JSON.stringify(payload));
  });
});

test('[R6-E-002/013] real fresh libSQL source, batch and corpus facts survive exact historical validation', async () => {
  const before = JSON.stringify(saved),
    result = await validate(saved);
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.tables.pilot_corpus_source_evidence.length, 11);
  assert.equal(result.tables.pilot_corpus_character.length, 20);
  assert.equal(result.tables.pilot_corpus_item.length, 10);
});
test('[R6-E-002/013] source chain cannot branch, promote fixtures or rewrite original acknowledgments', async () => {
  const changes = [
    (p) => {
      p.tables.pilot_corpus_source_evidence.find(
        (r) => r.source_ordinal === 2,
      ).classification = 'real-source-reviewed';
    },
    (p) => {
      p.tables.pilot_corpus_source_evidence.find(
        (r) => r.source_ordinal === 2,
      ).supersedes_id = p.tables.pilot_corpus_source_evidence.find(
        (r) =>
          r.source_ordinal === 1 &&
          r.lesson_version !==
            p.tables.pilot_corpus_source_evidence.find(
              (s) => s.source_ordinal === 2,
            ).lesson_version,
      ).id;
    },
    (p) => {
      const row = p.tables.pilot_corpus_source_evidence[0];
      const ack = JSON.parse(row.ack_json);
      ack.recordId = 'unrelated';
      row.ack_json = canonicalPackage(ack);
    },
    (p) => {
      const row = p.tables.pilot_corpus_source_evidence[0];
      const req = JSON.parse(row.request_json);
      req.resourceId = '';
      row.request_json = canonicalPackage(req);
      row.request_digest = corpusDigest(req);
    },
  ];
  for (const change of changes) {
    const p = structuredClone(saved);
    change(p);
    await assert.rejects(() => validate(p));
  }
});
test('[R6-E-001/013] accepted batch must bind its actual package, original receipt and complete result', async () => {
  const changes = [
    (p) => {
      const row = p.tables.pilot_corpus_batch[0],
        b = JSON.parse(row.manifest_json);
      b.items[0].contentDigest = b.items[1].contentDigest;
      row.manifest_json = canonicalPackage(b);
      row.manifest_digest = corpusDigest(b);
    },
    (p) => {
      const row = p.tables.pilot_corpus_batch[0],
        result = JSON.parse(row.result_json);
      result.items.pop();
      row.result_json = canonicalPackage(result);
    },
    (p) => {
      const row = p.tables.pilot_corpus_batch[0],
        ack = JSON.parse(row.ack_json);
      ack.recordedAt = new Date(row.created_at + 1).toISOString();
      row.ack_json = canonicalPackage(ack);
    },
  ];
  for (const change of changes) {
    const p = structuredClone(saved);
    change(p);
    await assert.rejects(() => validate(p));
  }
});
test('[R6-E-003/009/013] exact corpus item/search/target metadata cannot silently lose or invent a binding', async () => {
  const changes = [
    (p) => {
      p.tables.pilot_corpus_item[0].sequence++;
    },
    (p) => {
      p.tables.pilot_corpus_character[0].source_evidence_id =
        p.tables.pilot_corpus_source_evidence.find(
          (r) => r.source_ordinal === 2,
        ).id;
    },
    (p) => {
      p.tables.pilot_corpus_character[0].coverage_identity = '错';
    },
    (p) => {
      const r = p.tables.pilot_corpus_character[0],
        v = JSON.parse(r.requirements_json);
      v.wordIds.pop();
      r.requirements_json = canonicalPackage(v);
      r.requirements_digest = corpusDigest(v);
    },
    (p) => {
      p.tables.pilot_corpus_search_term.pop();
    },
    (p) => {
      p.tables.pilot_corpus_search_term.push({
        ...p.tables.pilot_corpus_search_term[0],
        term: 'invented-term',
      });
    },
    (p) => {
      p.tables.pilot_corpus_item.push({
        ...p.tables.pilot_corpus_item[0],
        ordinal: 99,
      });
    },
  ];
  for (const change of changes) {
    const p = structuredClone(saved);
    change(p);
    await assert.rejects(() => validate(p));
  }
});
