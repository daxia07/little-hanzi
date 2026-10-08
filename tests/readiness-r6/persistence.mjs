/** Independent direct-store integration, NOT HTTP or executed coordinator proof. */
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 120000 }, fn);
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withCorpusFixture } from '../helpers/corpus-store-fixture.mjs';
import {
  canonicalPackage,
  curriculumDigest,
} from '../../lib/curriculum/digest.ts';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../../lib/pilot/corpus-store.ts';
import { ingestCorpusProof } from '../../lib/pilot/corpus-proof-store.ts';
import {
  beginCorpusSnapshot,
  appendCorpusSnapshotChunk,
  sealCorpusSnapshot,
  readCorpusSnapshot,
} from '../../lib/pilot/corpus-snapshot-store.ts';
import { inspectSnapshotPlan } from '../../lib/pilot/corpus-snapshot-policy.ts';

const hash = 'sha256:' + 'c'.repeat(64);
const pair = await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
]);
const trust = {
  candidateId: 'r6-author',
  sourceDigest: hash,
  artifactDigest: hash,
  buildId: 'r6-author',
  issuers: [
    {
      issuerId: 'independent-synthetic-release',
      purpose: 'release',
      notBefore: 0,
      revokedAt: null,
      publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    },
  ],
  archiveIssuers: [],
};
const memberIds = [
  'profile-source-assets',
  'familiarity-routes',
  'recognition-context',
  'delayed-replay',
  'safe-projection',
];
const familyIds = [
  'selection',
  'approval',
  'recognition',
  'help',
  'audio-unavailable',
  'restart',
  'duplicate-conflict',
  'review-24h',
  'review-7d',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
async function prepared(fn, instrumentClient) {
  await withCorpusFixture(
    async (f) => {
      const c = f.context(),
        version = f.manifest.corpusVersion;
      for (const item of f.manifest.items)
        await recordCorpusSource(c, version, {
          requestId: 'independent-source-' + item.lessonVersion,
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
      await registerCorpusBatch(c, version, {
        requestId: 'independent-batch',
        batch: f.batch,
      });
      await registerCorpus(c, { corpus: f.manifest });
      await fn(f, c, version);
    },
    { trust: structuredClone(trust), instrumentClient },
  );
}
async function counts(f) {
  const result = {};
  for (const table of [
    'pilot_corpus_proof_receipt',
    'pilot_corpus_snapshot',
    'pilot_corpus_snapshot_member',
  ])
    result[table] = Number(
      (await f.client.execute('SELECT count(*) AS n FROM ' + table)).rows[0].n,
    );
  result.epoch = Number(
    (
      await f.client.execute(
        'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
      )
    ).rows[0].revision,
  );
  return result;
}
async function signed(f, id, target = 'r6-author-install') {
  const members = f.manifest.items.map(({ lessonVersion, contentDigest }) => ({
    lessonVersion,
    contentDigest,
  }));
  const reps = [
    ...new Set([0, Math.floor((members.length - 1) / 2), members.length - 1]),
  ].map((i) => members[i]);
  // Deliberately synthetic signed claims: these inputs do not certify execution.
  const receipt = {
    schemaVersion: 'r6-proof-receipt-1',
    policyVersion: 'r6-corpus-proof-1',
    receiptId: id,
    issuerId: trust.issuers[0].issuerId,
    issuedAt: new Date().toISOString(),
    candidateId: trust.candidateId,
    sourceDigest: hash,
    artifactDigest: hash,
    buildId: trust.buildId,
    corpusVersion: f.manifest.corpusVersion,
    corpusDigest: await curriculumDigest(f.manifest),
    ...members[0],
    canonicalizationVersion: 's3-json-1',
    adapterId: 'corpus-paired',
    adapterVersion: 'corpus-paired-v1',
    profileVersion: 'r6-paired-profile-1',
    evidenceInstallationId: 'independent-synthetic-evidence',
    targetInstallationId: target,
    namespace: 'independent-synthetic-only',
    syntheticOnly: true,
    runnerManifestDigest: hash,
    memberReportDigest: hash,
    memberChecks: memberIds.map((id) => ({
      id,
      outcome: 'PASS',
      evidenceDigest: hash,
    })),
    familyEvidence: {
      reportDigest: hash,
      representatives: reps,
      scenarios: reps.flatMap((r) =>
        familyIds.map((id) => ({
          ...r,
          id,
          outcome: 'PASS',
          evidenceDigest: hash,
        })),
      ),
    },
  };
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(canonicalPackage(receipt)),
    ),
  ).toString('base64url');
  return { receipt, signature };
}
function faultHarness() {
  let armed = null,
    fired = 0;
  return {
    get fired() {
      return fired;
    },
    arm(fn) {
      armed = fn;
    },
    async install(client) {
      const original = client.batch.bind(client);
      client.batch = async (statements, mode) => {
        if (
          armed &&
          statements.some((s) =>
            String(s.sql).includes('pilot_corpus_snapshot'),
          )
        ) {
          const fn = armed;
          armed = null;
          fired += 1;
          return await fn(statements, mode, original);
        }
        return original(statements, mode);
      };
    },
  };
}

void test('SP01 signed distinct origin accepted; wrong target has zero durable effects', async () =>
  prepared(async (f, c, v) => {
    const input = await signed(f, 'sp01');
    await ingestCorpusProof(c, v, input);
    const row = (
      await f.client.execute(
        "SELECT receipt_json FROM pilot_corpus_proof_receipt WHERE id='sp01'",
      )
    ).rows[0];
    assert.equal(
      JSON.parse(row.receipt_json).evidenceInstallationId,
      'independent-synthetic-evidence',
    );
    const before = await counts(f);
    const wrong = await signed(f, 'sp01-wrong', 'foreign-target');
    await assert.rejects(() => ingestCorpusProof(c, v, wrong));
    assert.deepEqual(await counts(f), before);
  }));

void test('SP02 exact proof replay does not advance epoch; revoked session denies replay', async () =>
  prepared(async (f, c, v) => {
    const input = await signed(f, 'sp02');
    const ack = await ingestCorpusProof(c, v, input),
      before = await counts(f);
    assert.deepEqual(await ingestCorpusProof(c, v, input), ack);
    assert.deepEqual(await counts(f), before);
    const changed = structuredClone(input);
    changed.receipt.namespace = 'changed-synthetic-body';
    changed.signature = Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        new TextEncoder().encode(canonicalPackage(changed.receipt)),
      ),
    ).toString('base64url');
    await assert.rejects(
      () => ingestCorpusProof(c, v, changed),
      (e) => e.code === 'PROOF_CONFLICT' && e.status === 409,
    );
    assert.deepEqual(await counts(f), before);
    await f.client.execute(
      "DELETE FROM pilot_auth_session WHERE id='session-r6-op'",
    );
    await assert.rejects(
      () => ingestCorpusProof(c, v, input),
      (e) => e.code === 'UNAUTHORIZED' && e.status === 401,
    );
    assert.deepEqual(await counts(f), before);
  }));

void test('SP03 concurrent disjoint changed chunks share only one original receipt', async () =>
  prepared(async (f, c, v) => {
    const b = await beginCorpusSnapshot(c, v, { requestId: 'sp03' });
    const requests = f.manifest.items.slice(0, 2).map((i) => ({
      requestId: 'same-chunk',
      packages: [
        { lessonVersion: i.lessonVersion, contentDigest: i.contentDigest },
      ],
    }));
    const results = await Promise.allSettled(
      requests.map((r) => appendCorpusSnapshotChunk(c, v, b.snapshotId, r)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const winner = results.findIndex((r) => r.status === 'fulfilled'),
      rows = (
        await f.client.execute({
          sql: 'SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=?',
          args: [b.snapshotId],
        })
      ).rows;
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.chunk_request_json)).size, 1);
    assert.equal(
      rows[0].lesson_version,
      requests[winner].packages[0].lessonVersion,
    );
    assert.deepEqual(
      await appendCorpusSnapshotChunk(c, v, b.snapshotId, requests[winner]),
      results[winner].value,
    );
  }));

void test('SP04 begin receipt stays building after seal; current GET and seal ACK differ', async () =>
  prepared(async (f, c, v) => {
    const request = { requestId: 'sp04' },
      b = await beginCorpusSnapshot(c, v, request);
    await appendCorpusSnapshotChunk(c, v, b.snapshotId, {
      requestId: 'sp04-chunk',
      packages: f.manifest.items.map(({ lessonVersion, contentDigest }) => ({
        lessonVersion,
        contentDigest,
      })),
    });
    const row = (
        await f.client.execute({
          sql: 'SELECT plan_digest,ack_json FROM pilot_corpus_snapshot WHERE id=?',
          args: [b.snapshotId],
        })
      ).rows[0],
      seal = { requestId: 'sp04-seal', expectedPlanDigest: row.plan_digest };
    const ack = await sealCorpusSnapshot(c, v, b.snapshotId, seal);
    assert.equal(ack.status, 'sealed');
    assert.deepEqual(await beginCorpusSnapshot(c, v, request), b);
    assert.deepEqual(await sealCorpusSnapshot(c, v, b.snapshotId, seal), ack);
    assert.equal(
      (await readCorpusSnapshot(c, v, b.snapshotId)).status,
      'sealed',
    );
    const savedRow = (
      await f.client.execute({
        sql: 'SELECT ack_json FROM pilot_corpus_snapshot WHERE id=?',
        args: [b.snapshotId],
      })
    ).rows[0];
    assert.equal(savedRow.ack_json, row.ack_json);
    assert.equal(JSON.parse(savedRow.ack_json).status, 'building');
  }));

for (const mutation of ['epoch', 'session', 'installation'])
  void test('SP05 late ' + mutation + ' prevents snapshot effects', async () => {
    const h = faultHarness();
    await prepared(
      async (f, c, v) => {
        const before = await counts(f);
        h.arm(async (statements, mode, original) => {
          if (mutation === 'epoch')
            await f.client.execute(
              'UPDATE pilot_corpus_evidence_epoch SET revision=revision+1 WHERE id=1',
            );
          if (mutation === 'session')
            await f.client.execute(
              "DELETE FROM pilot_auth_session WHERE id='session-r6-op'",
            );
          if (mutation === 'installation')
            await f.client.execute(
              "UPDATE pilot_installation SET installation_id='other-current' WHERE id=1",
            );
          return original(statements, mode);
        });
        await assert.rejects(
          () => beginCorpusSnapshot(c, v, { requestId: 'sp05-' + mutation }),
          (e) =>
            mutation === 'epoch'
              ? e.code === 'SNAPSHOT_STALE' && e.status === 409
              : e.code === 'UNAUTHORIZED' && e.status === 401,
        );
        assert.equal(h.fired, 1);
        const after = await counts(f);
        for (const key of [
          'pilot_corpus_proof_receipt',
          'pilot_corpus_snapshot',
          'pilot_corpus_snapshot_member',
        ])
          assert.equal(after[key], before[key]);
      },
      (client) => h.install(client),
    );
  });

void test('SP06 terminal real SQL constraint rolls back all chunk rows', async (t) => {
  let engineCode;
  const h = faultHarness();
  await prepared(
    async (f, c, v) => {
      const b = await beginCorpusSnapshot(c, v, { requestId: 'sp06' }),
        before = await counts(f);
      h.arm(async (statements, mode, original) => {
        try {
          return await original(
            [
              ...statements,
              {
                sql: 'INSERT INTO pilot_installation SELECT * FROM pilot_installation WHERE id=1',
                args: [],
              },
            ],
            mode,
          );
        } catch (error) {
          engineCode = typeof error.code === 'string' ? error.code : null;
          throw error;
        }
      });
      await assert.rejects(
        () =>
          appendCorpusSnapshotChunk(c, v, b.snapshotId, {
            requestId: 'sp06-chunk',
            packages: f.manifest.items
              .slice(0, 2)
              .map(({ lessonVersion, contentDigest }) => ({
                lessonVersion,
                contentDigest,
              })),
          }),
        (e) => e.code === 'STORAGE_UNAVAILABLE' && e.status === 503,
      );
      assert.equal(h.fired, 1);
      assert.ok(
        typeof engineCode === 'string' &&
          engineCode.startsWith('SQLITE_CONSTRAINT'),
      );
      t.diagnostic(JSON.stringify({ engineConstraintCode: engineCode }));
      assert.deepEqual(await counts(f), before);
    },
    (client) => h.install(client),
  );
});

void test('SP07 copied adapter cannot grant storage capability or create rows', async () =>
  prepared(async (f, c, v) => {
    const before = await counts(f);
    await assert.rejects(
      () =>
        beginCorpusSnapshot({ ...c, db: { ...c.db } }, v, {
          requestId: 'sp07',
        }),
      /SNAPSHOT_BACKEND_UNSUPPORTED/,
    );
    assert.deepEqual(await counts(f), before);
  }));

void test('SP08 inspector byte refusal only; oversized valid domain store case NOT RUN', async () => {
  await assert.rejects(
    () => inspectSnapshotPlan({ syntheticOversize: 'x'.repeat(33554433) }),
    /SNAPSHOT_TOO_LARGE/,
  );
});

for (const mutation of ['trust', 'build', 'capability'])
  void test(
    'SP05 pre-dispatch ' + mutation + ' config change refuses preparation',
    async () => {
      let armed = false,
        fired = 0,
        change;
      await prepared(
        async (f, c, v) => {
          const before = await counts(f);
          change = () => {
            if (mutation === 'trust')
              c.config.curriculumTrust.issuers[0].revokedAt = Date.now();
            if (mutation === 'build') c.config.candidateId = 'other-build';
            if (mutation === 'capability')
              c.corpus.capability = { syntheticChanged: true };
          };
          armed = true;
          await assert.rejects(
            () =>
              beginCorpusSnapshot(c, v, {
                requestId: 'sp05-config-' + mutation,
              }),
            (e) => e.code === 'SNAPSHOT_STALE' && e.status === 409,
          );
          assert.equal(fired, 1);
          assert.deepEqual(await counts(f), before);
        },
        (client) => {
          const execute = client.execute.bind(client);
          client.execute = async (statement) => {
            const result = await execute(statement);
            if (
              armed &&
              String(
                typeof statement === 'string' ? statement : statement.sql,
              ).includes('pilot_corpus_item')
            ) {
              armed = false;
              fired += 1;
              change();
            }
            return result;
          };
        },
      );
    },
  );

void test('SP03 overlapping different chunks refuse the whole later batch', async () => {
  const h = faultHarness();
  await prepared(
    async (f, c, v) => {
      const b = await beginCorpusSnapshot(c, v, { requestId: 'sp03-overlap' }),
        packages = f.manifest.items
          .slice(0, 2)
          .map(({ lessonVersion, contentDigest }) => ({
            lessonVersion,
            contentDigest,
          }));
      let release, reached;
      const reachedPromise = new Promise((r) => {
        reached = r;
      });
      h.arm(async (statements, mode, original) => {
        await new Promise((r) => {
          release = r;
          reached();
        });
        return original(statements, mode);
      });
      const later = appendCorpusSnapshotChunk(c, v, b.snapshotId, {
        requestId: 'overlap-later',
        packages,
      });
      try {
        await Promise.race([
          reachedPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('HELD_BATCH_NOT_REACHED')),
              10000,
            ),
          ),
        ]);
        await appendCorpusSnapshotChunk(c, v, b.snapshotId, {
          requestId: 'overlap-first',
          packages: [packages[0]],
        });
        const before = (
          await f.client.execute({
            sql: 'SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=? ORDER BY member_ordinal',
            args: [b.snapshotId],
          })
        ).rows;
        release();
        await assert.rejects(() => later);
        const after = (
          await f.client.execute({
            sql: 'SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=? ORDER BY member_ordinal',
            args: [b.snapshotId],
          })
        ).rows;
        assert.deepEqual(after, before);
      } finally {
        release?.();
        await later.catch(() => {});
      }
    },
    (client) => h.install(client),
  );
});
