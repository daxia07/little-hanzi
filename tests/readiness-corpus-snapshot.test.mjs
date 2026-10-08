import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectCoverageEligibility,
  buildSnapshotPlan,
  inspectSnapshotPlan,
  snapshotDigests,
  validateSnapshotRows,
  snapshotMemberFacts,
  intrinsicReasons,
} from '../lib/pilot/corpus-snapshot-policy.ts';
const d = 'sha256:' + 'a'.repeat(64);
const binding = {
  corpusVersion: 'synthetic-corpus',
  corpusDigest: d,
  installationId: 'synthetic-install',
  namespace: null,
  lane: 'ordinary',
  candidateId: 'synthetic-candidate',
  sourceDigest: d,
  artifactDigest: d,
  buildId: 'synthetic-build',
  evidenceEpoch: 1,
};
const eligible = {
  schemaVersion: 'r6-eligibility-1',
  coverageIdentity: '木',
  characterId: 'mu',
  lessonVersion: 'synthetic-lesson',
  contentDigest: d,
  sourceEvidenceId: 'synthetic-source',
  classification: 'real-source-reviewed',
  reviewId: 'synthetic-review',
  reviewSequence: 1,
  proofId: 'synthetic-proof',
  proofPolicyVersion: 'r6-corpus-proof-1',
  assetInventoryDigest: d,
  candidateId: 'synthetic-candidate',
  sourceDigest: d,
  artifactDigest: d,
  requirementsDigest: d,
  eligible: true,
  reasonCodes: [],
};
test('SC01 persisted coverage inspector rejects fixture or missing-review positive claims', () => {
  assert.throws(
    () =>
      inspectCoverageEligibility({
        ...eligible,
        classification: 'verification-fixture',
      }),
    /SNAPSHOT_INVALID/,
  );
  assert.throws(
    () =>
      inspectCoverageEligibility({
        ...eligible,
        reviewId: null,
        reviewSequence: null,
      }),
    /SNAPSHOT_INVALID/,
  );
});
function candidate(ordinal = 0, alias = false) {
  return {
    ordinal,
    lessonVersion: 'synthetic-lesson-' + ordinal,
    contentDigest: d,
    assetInventory: { schemaVersion: 'r6-asset-inventory-1', synthetic: true },
    review: { reviewId: 'synthetic-review', reviewDigest: d },
    reviewSequence: 1,
    proof: {
      proofId: 'synthetic-proof',
      receiptDigest: d,
      issuerId: 'synthetic-issuer',
      purpose: 'release',
      issuedAt: '2026-09-27T00:00:00.000Z',
    },
    targets: ['木', '林'].map((hanzi, index) => {
      const characterId = 'target-' + ordinal + '-' + index,
        kind = alias && index === 1 ? 'alias' : 'simplified';
      const t = {
        characterId,
        coverageIdentity: hanzi,
        classification: 'real-source-reviewed',
        identityKind: kind,
        identityReview: {
          characterId,
          hanzi,
          kind,
          reviewRef: 'synthetic-review',
        },
        machineValid: true,
        licensed: true,
        wordsComplete: true,
        contentReviewed: true,
        audioReviewed: true,
        promptsComplete: true,
        assetsComplete: true,
        proofValid: true,
        current: true,
        placeholder: false,
      };
      return {
        targetIndex: index,
        characterId,
        coverageIdentity: hanzi,
        sourceEvidenceId: 'synthetic-source-' + ordinal,
        sourceEvidenceDigest: d,
        requirementsDigest: d,
        intrinsicEligibility: {
          schemaVersion: 'r6-target-eligibility-1',
          ...t,
          realEligible: kind === 'simplified',
          machineUsableVerification: false,
          reasonCodes: intrinsicReasons(t),
        },
      };
    }),
  };
}
test('SC01/02 full companion closure precedes deterministic dedup and all hashes bind saved facts', async () => {
  const first = candidate(0, true),
    second = candidate(1);
  const plan = await buildSnapshotPlan(binding, [second, first]);
  assert.equal(plan.counts.includedCharacterCount, 2);
  assert.equal(plan.counts.packageCount, 1);
  assert.equal(
    plan.packages[0].targets.every((t) => t.coverageStatus === 'excluded'),
    true,
  );
  assert.equal(
    plan.packages[1].targets.every((t) => t.coverageStatus === 'included'),
    true,
  );
  assert.equal(
    canonicalPackage(await inspectSnapshotPlan(plan)),
    canonicalPackage(plan),
  );
  const digest = await snapshotDigests(plan);
  const rows = snapshotMemberFacts(plan);
  assert.deepEqual(await validateSnapshotRows(plan, rows), digest);
  await assert.rejects(
    validateSnapshotRows(
      plan,
      rows.map((r, i) =>
        i === 0 ? { ...r, eligibility_digest: 'sha256:' + 'b'.repeat(64) } : r,
      ),
    ),
    /SNAPSHOT_INCOMPLETE/,
  );
  const forged = structuredClone(plan);
  forged.counts.includedCharacterCount = 1600;
  await assert.rejects(inspectSnapshotPlan(forged), /SNAPSHOT_INVALID/);
});
import { withCorpusFixture } from './helpers/corpus-store-fixture.mjs';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../lib/pilot/corpus-store.ts';
import { ingestCorpusProof } from '../lib/pilot/corpus-proof-store.ts';
import {
  beginCorpusSnapshot,
  appendCorpusSnapshotChunk,
  sealCorpusSnapshot,
  readCorpusSnapshot,
  readCorpusSnapshotMembers,
} from '../lib/pilot/corpus-snapshot-store.ts';
import {
  CORPUS_MEMBER_CHECKS,
  CORPUS_FAMILY_SCENARIOS,
  corpusRepresentatives,
} from '../lib/pilot/corpus-proof.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
async function trustFixture() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]),
    issuer = {
      issuerId: 'synthetic-author-issuer',
      publicKeyJwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
      notBefore: 0,
      revokedAt: null,
      purpose: 'release',
    };
  return {
    keys,
    trust: {
      candidateId: 'r6-author',
      sourceDigest: d,
      artifactDigest: d,
      buildId: 'synthetic-build',
      issuers: [issuer],
      archiveIssuers: [issuer],
    },
  };
}
async function registered(f) {
  const c = f.context(),
    v = f.manifest.corpusVersion;
  for (const item of f.manifest.items)
    await recordCorpusSource(c, v, {
      requestId: 'source-' + item.lessonVersion,
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      classification: 'unverified-draft',
      sourceRefs: ['synthetic-pending'],
      licenseRefs: ['synthetic-pending'],
      reviewRefs: [],
      identityReviews: [],
      predecessorEvidenceId: null,
      expectedEvidenceDigest: null,
    });
  await registerCorpusBatch(c, v, {
    requestId: 'synthetic-batch',
    batch: f.batch,
  });
  return await registerCorpus(c, { corpus: f.manifest });
}
async function signedReceipt(f, key, corpusDigest, changes = {}) {
  const members = f.manifest.items.map(({ lessonVersion, contentDigest }) => ({
      lessonVersion,
      contentDigest,
    })),
    representatives = corpusRepresentatives(members),
    receipt = {
      schemaVersion: 'r6-proof-receipt-1',
      policyVersion: 'r6-corpus-proof-1',
      receiptId: 'synthetic-proof-row',
      issuerId: 'synthetic-author-issuer',
      issuedAt: new Date().toISOString(),
      candidateId: 'r6-author',
      sourceDigest: d,
      artifactDigest: d,
      buildId: 'synthetic-build',
      corpusVersion: f.manifest.corpusVersion,
      corpusDigest,
      ...members[0],
      canonicalizationVersion: 's3-json-1',
      adapterId: 'corpus-paired',
      adapterVersion: 'corpus-paired-v1',
      profileVersion: 'r6-paired-profile-1',
      evidenceInstallationId: 'different-authenticated-synthetic-origin',
      targetInstallationId: 'r6-author-install',
      namespace: 'synthetic-signed-origin',
      syntheticOnly: true,
      runnerManifestDigest: d,
      memberReportDigest: d,
      memberChecks: CORPUS_MEMBER_CHECKS.map((id) => ({
        id,
        outcome: 'PASS',
        evidenceDigest: d,
      })),
      familyEvidence: {
        reportDigest: d,
        representatives,
        scenarios: representatives.flatMap((m) =>
          CORPUS_FAMILY_SCENARIOS.map((id) => ({
            ...m,
            id,
            outcome: 'PASS',
            evidenceDigest: d,
          })),
        ),
      },
      ...changes,
    };
  const bytes = await crypto.subtle.sign(
    'Ed25519',
    key,
    new TextEncoder().encode(canonicalPackage(receipt)),
  );
  return { receipt, signature: Buffer.from(bytes).toString('base64url') };
}
test('SC04 ordinary signed origin is saved only after signature and independently bound target; replay creates no epoch', async () => {
  const { keys, trust } = await trustFixture();
  await withCorpusFixture(
    async (f) => {
      const ack = await registered(f),
        body = await signedReceipt(f, keys.privateKey, ack.corpusDigest),
        c = f.context(),
        v = f.manifest.corpusVersion;
      const result = await ingestCorpusProof(c, v, body);
      assert.equal(result.receiptId, body.receipt.receiptId);
      const e = (
        await f.client.execute(
          'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
        )
      ).rows[0].revision;
      f.config.curriculumTrust = { ...trust, issuers: [] };
      assert.deepEqual(await ingestCorpusProof(c, v, body), result);
      assert.equal(
        (
          await f.client.execute(
            'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
          )
        ).rows[0].revision,
        e,
      );
      f.config.curriculumTrust = trust;
      await assert.rejects(
        ingestCorpusProof(
          c,
          v,
          await signedReceipt(f, keys.privateKey, ack.corpusDigest, {
            receiptId: 'wrong-target',
            targetInstallationId: 'foreign-install',
          }),
        ),
        /PROOF_IDENTITY_MISMATCH/,
      );
      const tampered = structuredClone(body);
      tampered.receipt.receiptId = 'forged-origin';
      tampered.receipt.evidenceInstallationId = 'forged';
      await assert.rejects(
        ingestCorpusProof(c, v, tampered),
        /PROOF_UNTRUSTED/,
      );
    },
    { trust },
  );
});
test('SC01–03 actual pending-fixture begin/chunks/seal preserve original receipts, real-zero counts and paged exclusions', async () => {
  const { trust } = await trustFixture();
  await withCorpusFixture(
    async (f) => {
      await registered(f);
      const c = f.context(),
        v = f.manifest.corpusVersion,
        begin = await beginCorpusSnapshot(c, v, { requestId: 'begin' }),
        id = begin.snapshotId;
      assert.equal(begin.status, 'building');
      assert.equal(begin.packageCount, 10);
      const detail = await readCorpusSnapshot(c, v, id);
      assert.equal(detail.counts.includedCharacterCount, 0);
      assert.equal(detail.counts.fixtureCharacterCount, 20);
      await assert.rejects(
        sealCorpusSnapshot(c, v, id, {
          requestId: 'seal',
          expectedPlanDigest: detail.planDigest,
        }),
        /SNAPSHOT_INCOMPLETE/,
      );
      const body = {
          requestId: 'chunk-a',
          packages: f.manifest.items
            .slice(0, 5)
            .map(({ lessonVersion, contentDigest }) => ({
              lessonVersion,
              contentDigest,
            })),
        },
        first = await appendCorpusSnapshotChunk(c, v, id, body);
      assert.deepEqual(await appendCorpusSnapshotChunk(c, v, id, body), first);
      await assert.rejects(
        appendCorpusSnapshotChunk(c, v, id, {
          ...body,
          packages: f.manifest.items
            .slice(5)
            .map(({ lessonVersion, contentDigest }) => ({
              lessonVersion,
              contentDigest,
            })),
        }),
        /EVENT_CONFLICT|REQUEST_CONFLICT/,
      );
      await appendCorpusSnapshotChunk(c, v, id, {
        requestId: 'chunk-b',
        packages: f.manifest.items
          .slice(5)
          .map(({ lessonVersion, contentDigest }) => ({
            lessonVersion,
            contentDigest,
          })),
      });
      const sealBody = {
          requestId: 'seal',
          expectedPlanDigest: detail.planDigest,
        },
        seal = await sealCorpusSnapshot(c, v, id, sealBody);
      assert.equal(seal.packageCount, 0);
      assert.equal(seal.excludedTargetCount, 20);
      assert.deepEqual(
        await beginCorpusSnapshot(c, v, { requestId: 'begin' }),
        begin,
      );
      assert.deepEqual(await sealCorpusSnapshot(c, v, id, sealBody), seal);
      const page = await readCorpusSnapshotMembers(c, v, id, {
        status: 'excluded',
        limit: 7,
      });
      assert.equal(page.items.length, 7);
      assert.ok(page.nextCursor);
      assert.equal((await readCorpusSnapshot(c, v, id)).status, 'sealed');
    },
    { trust },
  );
});
function bounded(p, ms = 5000) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('HELD_TIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
test('SC03 concurrent different-request overlap refuses whole second chunk without partial history', async () => {
  const { trust } = await trustFixture();
  let hold = false,
    arrive,
    release;
  const arrived = new Promise((r) => (arrive = r)),
    gate = new Promise((r) => (release = r));
  await withCorpusFixture(
    async (f) => {
      await registered(f);
      const c = f.context(),
        v = f.manifest.corpusVersion,
        begin = await beginCorpusSnapshot(c, v, {
          requestId: 'concurrent-begin',
        }),
        packages = f.manifest.items
          .slice(0, 2)
          .map(({ lessonVersion, contentDigest }) => ({
            lessonVersion,
            contentDigest,
          }));
      hold = true;
      const waiting = appendCorpusSnapshotChunk(c, v, begin.snapshotId, {
        requestId: 'held-two',
        packages,
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await bounded(arrived);
        await appendCorpusSnapshotChunk(c, v, begin.snapshotId, {
          requestId: 'first-one',
          packages: packages.slice(0, 1),
        });
      } finally {
        release();
      }
      const outcome = await bounded(waiting);
      assert.match(String(outcome.error), /CHUNK_CONFLICT/);
      const count = await f.client.execute({
        sql: 'SELECT count(*) AS n FROM pilot_corpus_snapshot_member WHERE snapshot_id=? AND chunk_request_id=?',
        args: [begin.snapshotId, 'held-two'],
      });
      assert.equal(
        count.rows[0].n,
        0,
        'a rejected overlapping chunk must not leave B-only history',
      );
    },
    {
      trust,
      instrumentClient(client) {
        const batch = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          if (
            hold &&
            statements.some((s) =>
              s.sql.includes('INSERT INTO pilot_corpus_snapshot_member'),
            )
          ) {
            hold = false;
            arrive();
            await gate;
          }
          return batch(statements, ...args);
        };
      },
    },
  );
});

test('SC06 private UTF8 bound and copied-adapter refusal precede snapshot effects', async () => {
  await assert.rejects(
    inspectSnapshotPlan({ padding: 'x'.repeat(32 * 1024 * 1024) }),
    /SNAPSHOT_TOO_LARGE/,
  );
  const { trust } = await trustFixture();
  await withCorpusFixture(
    async (f) => {
      await registered(f);
      const c = f.context();
      await assert.rejects(
        beginCorpusSnapshot(
          { ...c, db: Object.create(c.db) },
          f.manifest.corpusVersion,
          { requestId: 'unsupported' },
        ),
        /SNAPSHOT_BACKEND_UNSUPPORTED/,
      );
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_snapshot',
          )
        ).rows[0].n,
        0,
      );
    },
    { trust },
  );
});
test('SC03 actual final constraint rolls back whole chunk; lost acknowledgement exact retry preserves committed rows', async () => {
  const { trust } = await trustFixture();
  let fault = false,
    lost = false;
  await withCorpusFixture(
    async (f) => {
      await registered(f);
      const c = f.context(),
        v = f.manifest.corpusVersion,
        begin = await beginCorpusSnapshot(c, v, { requestId: 'fault-begin' }),
        body = {
          requestId: 'fault-chunk',
          packages: f.manifest.items
            .slice(0, 2)
            .map(({ lessonVersion, contentDigest }) => ({
              lessonVersion,
              contentDigest,
            })),
        };
      fault = true;
      await assert.rejects(
        appendCorpusSnapshotChunk(c, v, begin.snapshotId, body),
        /STORAGE_UNAVAILABLE/,
      );
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_snapshot_member',
          )
        ).rows[0].n,
        0,
      );
      lost = true;
      await assert.rejects(
        appendCorpusSnapshotChunk(c, v, begin.snapshotId, body),
        /STORAGE_UNAVAILABLE/,
      );
      const ack = await appendCorpusSnapshotChunk(c, v, begin.snapshotId, body);
      assert.equal(ack.targetRowCount, 4);
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_snapshot_member',
          )
        ).rows[0].n,
        4,
      );
    },
    {
      trust,
      instrumentClient(client) {
        const batch = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          const isChunk = statements.some((s) =>
            s.sql.includes('INSERT INTO pilot_corpus_snapshot_member'),
          );
          if (isChunk && fault) {
            fault = false;
            return batch(
              [
                ...statements,
                {
                  sql: 'INSERT INTO pilot_installation SELECT * FROM pilot_installation',
                  args: [],
                },
              ],
              ...args,
            );
          }
          const result = await batch(statements, ...args);
          if (isChunk && lost) {
            lost = false;
            throw Error('SYNTHETIC_LOST_ACK');
          }
          return result;
        };
      },
    },
  );
});
test('SC03 paged member read rechecks current authority after held final epoch read', async () => {
  const { trust } = await trustFixture();
  let arm = false,
    sawRows = false,
    revoked = false;
  await withCorpusFixture(
    async (f) => {
      await registered(f);
      const c = f.context(),
        v = f.manifest.corpusVersion,
        begin = await beginCorpusSnapshot(c, v, { requestId: 'read-begin' });
      await appendCorpusSnapshotChunk(c, v, begin.snapshotId, {
        requestId: 'read-chunk',
        packages: f.manifest.items.map(({ lessonVersion, contentDigest }) => ({
          lessonVersion,
          contentDigest,
        })),
      });
      arm = true;
      await assert.rejects(
        readCorpusSnapshotMembers(c, v, begin.snapshotId, {
          status: 'excluded',
          limit: 7,
        }),
        /UNAUTHORIZED/,
      );
      assert.equal(revoked, true);
    },
    {
      trust,
      instrumentClient(client) {
        const execute = client.execute.bind(client);
        client.execute = async (statement, ...args) => {
          const result = await execute(statement, ...args),
            sql = typeof statement === 'string' ? statement : statement.sql;
          if (arm && sql.includes('SELECT * FROM pilot_corpus_snapshot_member'))
            sawRows = true;
          if (
            arm &&
            sawRows &&
            sql ===
              'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1'
          ) {
            arm = false;
            revoked = true;
            await execute(
              "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-op'",
            );
          }
          return result;
        };
      },
    },
  );
});
test('snapshot operation time follows facts committed before the captured preparation epoch', async () => {
  const { trust } = await trustFixture();
  let mutate = null,
    arm = false;
  await withCorpusFixture(
    async (f) => {
      await registered(f);
      const c = f.context(),
        v = f.manifest.corpusVersion,
        item = f.manifest.items[0],
        old = (
          await f.client.execute({
            sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE lesson_version=?',
            args: [item.lessonVersion],
          })
        ).rows[0];
      mutate = async () => {
        await new Promise((r) => setTimeout(r, 20));
        await recordCorpusSource(c, v, {
          requestId: 'late-before-epoch',
          lessonVersion: item.lessonVersion,
          contentDigest: item.contentDigest,
          classification: 'unverified-draft',
          sourceRefs: ['synthetic-pending'],
          licenseRefs: ['synthetic-pending'],
          reviewRefs: [],
          identityReviews: [],
          predecessorEvidenceId: old.id,
          expectedEvidenceDigest: old.evidence_digest,
        });
      };
      arm = true;
      const begin = await beginCorpusSnapshot(c, v, {
          requestId: 'chronology-begin',
        }),
        header = (
          await f.client.execute({
            sql: 'SELECT created_at FROM pilot_corpus_snapshot WHERE id=?',
            args: [begin.snapshotId],
          })
        ).rows[0],
        source = (
          await f.client.execute(
            "SELECT created_at FROM pilot_corpus_source_evidence WHERE request_id='late-before-epoch'",
          )
        ).rows[0];
      assert.ok(
        header.created_at >= source.created_at,
        'a saved plan cannot precede one of its source dependencies',
      );
    },
    {
      trust,
      instrumentClient(client) {
        const execute = client.execute.bind(client);
        client.execute = async (statement, ...args) => {
          const sql = typeof statement === 'string' ? statement : statement.sql;
          if (
            arm &&
            sql ===
              'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1'
          ) {
            arm = false;
            await mutate();
          }
          return execute(statement, ...args);
        };
      },
    },
  );
});
