import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  discoverChildCorpora,
  discoverCorpusOwner,
  readCorpusPublicationHead,
  readCorpusSnapshotPackages,
} from '../lib/pilot/corpus-entry-store.ts';
import {
  proposeCorpus,
  approveCorpus,
} from '../lib/pilot/corpus-family-store.ts';
import { saveOnboarding } from '../lib/pilot/learning.ts';
async function assign(f, release) {
  const at = Date.now();
  f.config.curriculumTestNow = String(at);
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    { nickname: 'Synthetic', experience: 'new', audioReady: true },
    at,
  );
  const item = f.manifest.items[0];
  const { proposal } = await proposeCorpus(f.context('r6-parent'), 'r6-child', {
    corpusVersion: f.manifest.corpusVersion,
    selection: {
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      releaseId: release.recordId,
      releaseRevision: release.revision,
    },
    predecessorProposalId: null,
    expectedSourceDigest: null,
  });
  return approveCorpus(f.context('r6-parent'), 'r6-child', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
}
test('discovery is parent eligible, child assigned only; default GET never mutates', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const release = await bootstrapOwnedCorpus(f.handle);
    assert.equal(
      (await discoverChildCorpora(f.context('r6-parent'), 'r6-child')).items
        .length,
      1,
    );
    assert.deepEqual(
      (await discoverChildCorpora(f.context('r6-child'), 'r6-child')).items,
      [],
    );
    assert.equal(
      (await f.client.execute('SELECT count(*) n FROM pilot_corpus_proposal'))
        .rows[0].n,
      0,
    );
    await assign(f, release);
    const page = await discoverChildCorpora(f.context('r6-child'), 'r6-child', {
      limit: 1,
    });
    assert.equal(page.items[0].corpusVersion, f.manifest.corpusVersion);
    assert.equal(page.items[0].available, true);
    assert.equal(
      (await f.client.execute('SELECT count(*) n FROM pilot_corpus_proposal'))
        .rows[0].n,
      1,
    );
  }));
test('unconfigured owner entry reveals no material; child denied; late revoked empty read denied', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const c = f.context('r6-parent');
    c.corpus.ownerIds = [];
    const page = await discoverCorpusOwner(c);
    assert.equal(page.allowed, false);
    assert.deepEqual(page.items, []);
    assert.equal(page.nextCursor, null);
    await assert.rejects(
      () => discoverCorpusOwner(f.context('r6-child')),
      (e) => e.status === 403,
    );
    await f.client.execute(
      "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-parent'",
    );
    await assert.rejects(
      () => discoverCorpusOwner(f.context('r6-parent')),
      (e) => e.status === 401,
    );
  }));
test('operator original publication readback and bounded snapshot package identities omit private plan', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const release = await bootstrapOwnedCorpus(f.handle),
      c = f.context('r6-op');
    const head = await readCorpusPublicationHead(c, f.manifest.corpusVersion);
    assert.equal(head.publication.receipt.recordId, release.recordId);
    assert.equal(head.publication.scope.kind, 'verification');
    const page = await readCorpusSnapshotPackages(
      c,
      f.manifest.corpusVersion,
      release.snapshotId,
      { limit: 2 },
    );
    assert.equal(page.items.length, 2);
    assert.ok(page.items.every((x) => x.chunked));
    assert.equal(typeof page.nextCursor, 'string');
    assert.ok(!JSON.stringify(page).includes('packageEligibility'));
    await assert.rejects(
      () =>
        readCorpusPublicationHead(
          f.context('r6-parent'),
          f.manifest.corpusVersion,
        ),
      (e) => e.status === 403,
    );
  }));

test('current verification coverage identifies persisted snapshot/head but never counts fixtures as real release', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { corpusCoverage } = await import('../lib/pilot/corpus-coverage.ts');
    const release = await bootstrapOwnedCorpus(f.handle),
      c = f.context('r6-op');
    const coverage = await corpusCoverage(c, f.manifest.corpusVersion, {
      limit: 2,
    });
    assert.equal(coverage.lane, 'verification');
    assert.equal(coverage.fixtureCharacterCount, 20);
    assert.equal(coverage.verificationPackageCount, 10);
    assert.equal(coverage.snapshot.snapshotId, release.snapshotId);
    assert.equal(coverage.release.releaseId, release.recordId);
    assert.equal(coverage.release.currentEligibleCharacterCount, 20);
    assert.equal(coverage.counts.reviewedReady, 0);
    assert.equal(coverage.counts.prospectiveStarter, 0);
    assert.equal(coverage.counts.committedStarter, 0);
    const pending = f.context('r6-op');
    pending.config = { ...pending.config, curriculumTrust: null };
    const noTrust = await corpusCoverage(pending, f.manifest.corpusVersion);
    assert.equal(noTrust.snapshot, null);
    assert.equal(noTrust.fixtureCharacterCount, 20);
    assert.equal(noTrust.counts.reviewedReady, 0);
  }));

test(
  'controlled candidate-window model resumes51st after50 strict denials over ten-item real SQL fixture',
  { timeout: 15000 },
  async () => {
    let active = false,
      denied = 0,
      inspected = 0,
      baseRow;
    const sqlQueries = [];
    const actualRowCounts = [];
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const release = await bootstrapOwnedCorpus(f.handle);
        active = true;
        const c = f.context('r6-parent'),
          first = await discoverChildCorpora(c, 'r6-child', { limit: 1 });
        assert.deepEqual(first.items, []);
        assert.equal(denied, 50);
        assert.equal(inspected, 50);
        assert.equal(typeof first.nextCursor, 'string');
        const second = await discoverChildCorpora(c, 'r6-child', {
          limit: 1,
          cursor: first.nextCursor,
        });
        assert.equal(second.items.length, 1);
        assert.equal(second.items[0].available, true);
        assert.equal(inspected, 51);
        assert.equal(sqlQueries.length, 2);
        assert.ok(sqlQueries[1].includes(')>('));
        assert.equal(actualRowCounts[0], 10);
        assert.equal(actualRowCounts[1], 0);
        active = false;
        await assign(f, release);
        await assert.rejects(
          () =>
            discoverChildCorpora(c, 'r6-child', {
              limit: 1,
              cursor: first.nextCursor,
            }),
          (e) => e.code === 'CURSOR_STALE',
        );
        assert.equal(
          (await f.client.execute('SELECT count(*) n FROM pilot_corpus_item'))
            .rows[0].n,
          10,
        );
      },
      {
        instrumentClient(client) {
          const execute = client.execute.bind(client);
          client.execute = async (statement, ...args) => {
            const sql =
              typeof statement === 'string' ? statement : statement.sql;
            const result = await execute(statement, ...args);
            if (
              active &&
              sql.startsWith('SELECT item.* FROM pilot_corpus_item item WHERE')
            ) {
              sqlQueries.push(sql);
              actualRowCounts.push(result.rows.length);
              baseRow ??= result.rows[0];
              // Explicit virtual candidate-window boundary model. These are NOT51 stored packages.
              const rows = Array.from({ length: 51 }, (_, i) => {
                const row = Array.from(baseRow);
                row[result.columns.indexOf('sequence')] = i + 1;
                return row;
              });
              return {
                ...result,
                rows: sqlQueries.length === 1 ? rows : rows.slice(50),
              };
            }
            if (
              active &&
              sql.startsWith(
                'SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=',
              ) &&
              sql.includes('AND lesson_version=')
            ) {
              inspected++;
              if (denied < 50) {
                denied++;
                return { ...result, rows: [] };
              }
            }
            return result;
          };
        },
      },
    );
  },
);
test('batch validation is bounded read-only and saved batch GET retains original report', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { validateCorpusBatch, readCorpusBatch } =
      await import('../lib/pilot/corpus-entry-store.ts');
    const row = (
        await f.client.execute('SELECT * FROM pilot_corpus_batch LIMIT 1')
      ).rows[0],
      batch = JSON.parse(row.manifest_json),
      c = f.context('r6-op');
    const before = (
      await f.client.execute('SELECT count(*) n FROM pilot_corpus_batch')
    ).rows[0].n;
    const validation = await validateCorpusBatch(c, f.manifest.corpusVersion, {
      batch,
    });
    assert.ok(validation.items.every((i) => i.state === 'accepted'));
    assert.equal(
      (await f.client.execute('SELECT count(*) n FROM pilot_corpus_batch'))
        .rows[0].n,
      before,
    );
    const bad = structuredClone(batch);
    bad.items[0].contentDigest = 'sha256:' + '0'.repeat(64);
    const rejected = await validateCorpusBatch(c, f.manifest.corpusVersion, {
      batch: bad,
    });
    assert.equal(rejected.items[0].state, 'rejected');
    assert.deepEqual(rejected.items[0].errors, [
      { fieldId: 'contentDigest', code: 'BATCH_BINDING' },
    ]);
    const saved = await readCorpusBatch(c, f.manifest.corpusVersion, row.id);
    assert.deepEqual(saved, JSON.parse(row.result_json));
    await assert.rejects(
      () => readCorpusBatch(c, 'foreign-corpus', row.id),
      (e) => e.status === 404,
    );
  }));
test('current coverage source correction excludes only chosen package while keeping historical snapshot reference', async () =>
  withOwnedCorpusFixture('draft-corpus', async (f) => {
    const { corpusCoverage } = await import('../lib/pilot/corpus-coverage.ts');
    const { recordCorpusSource } = await import('../lib/pilot/corpus-store.ts');
    const release = await bootstrapOwnedCorpus(f.handle),
      c = f.context('r6-op'),
      source = (
        await f.client.execute(
          'SELECT * FROM pilot_corpus_source_evidence LIMIT 1',
        )
      ).rows[0];
    await recordCorpusSource(c, f.manifest.corpusVersion, {
      requestId: 'correct-one',
      lessonVersion: source.lesson_version,
      contentDigest: source.content_digest,
      classification: 'unverified-draft',
      sourceRefs: ['synthetic-pending-source'],
      licenseRefs: ['synthetic-pending-license'],
      reviewRefs: [],
      identityReviews: [],
      predecessorEvidenceId: source.id,
      expectedEvidenceDigest: source.evidence_digest,
    });
    const current = await corpusCoverage(c, f.manifest.corpusVersion);
    assert.equal(current.snapshot.snapshotId, release.snapshotId);
    assert.equal(current.snapshot.includedCharacterCount, 0);
    assert.equal(current.release.currentEligibleCharacterCount, 18);
    assert.equal(current.counts.committedStarter, 0);
  }));
test('empty owner response refuses actor revocation at final actual SQL read', async () => {
  let active = false,
    fired = 0;
  await withOwnedCorpusFixture(
    'draft-corpus',
    async (f) => {
      const c = f.context('r6-parent');
      c.corpus.ownerIds = [];
      active = true;
      await assert.rejects(
        () => discoverCorpusOwner(c),
        (e) => e.status === 401,
      );
      assert.equal(fired, 1);
    },
    {
      instrumentClient(client) {
        const execute = client.execute.bind(client);
        client.execute = async (statement, ...args) => {
          const sql = typeof statement === 'string' ? statement : statement.sql;
          if (
            active &&
            sql.startsWith('SELECT 1 AS ok WHERE') &&
            sql.includes('pilot_installation')
          ) {
            active = false;
            fired++;
            await execute(
              "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-parent'",
            );
          }
          return execute(statement, ...args);
        };
      },
    },
  );
});

test('ordinary owner entry sealing fingerprint stales prior cursor without inventing accepted decisions', async () => {
  const { withCorpusFixture } =
    await import('./helpers/corpus-store-fixture.mjs');
  const { recordCorpusSource, registerCorpusBatch, registerCorpus } =
    await import('../lib/pilot/corpus-store.ts');
  const { beginCorpusSnapshot, appendCorpusSnapshotChunk, sealCorpusSnapshot } =
    await import('../lib/pilot/corpus-snapshot-store.ts');
  const digest = 'sha256:' + 'a'.repeat(64),
    trust = {
      candidateId: 'r6-author',
      sourceDigest: digest,
      artifactDigest: digest,
      buildId: 'synthetic-build',
      issuers: [],
      archiveIssuers: [],
    };
  await withCorpusFixture(
    async (f) => {
      const c = f.context(),
        v = f.manifest.corpusVersion;
      for (const item of f.manifest.items)
        await recordCorpusSource(c, v, {
          requestId: 'src-' + item.lessonVersion,
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
      await registerCorpusBatch(c, v, { requestId: 'batch', batch: f.batch });
      await registerCorpus(c, { corpus: f.manifest });
      async function seal(n) {
        const b = await beginCorpusSnapshot(c, v, { requestId: 'begin-' + n });
        await appendCorpusSnapshotChunk(c, v, b.snapshotId, {
          requestId: 'chunk-' + n,
          packages: f.manifest.items.map(
            ({ lessonVersion, contentDigest }) => ({
              lessonVersion,
              contentDigest,
            }),
          ),
        });
        const row = (
          await f.client.execute({
            sql: 'SELECT plan_digest FROM pilot_corpus_snapshot WHERE id=?',
            args: [b.snapshotId],
          })
        ).rows[0];
        return sealCorpusSnapshot(c, v, b.snapshotId, {
          requestId: 'seal-' + n,
          expectedPlanDigest: row.plan_digest,
        });
      }
      await seal(1);
      await seal(2);
      const owner = f.context('r6-parent'),
        page = await discoverCorpusOwner(owner, { limit: 1 });
      assert.equal(page.allowed, true);
      assert.equal(page.items.length, 1);
      assert.equal(typeof page.nextCursor, 'string');
      const before = (
        await f.client.execute(
          'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
        )
      ).rows[0].revision;
      await seal(3);
      assert.equal(
        (
          await f.client.execute(
            'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
          )
        ).rows[0].revision,
        before,
      );
      await assert.rejects(
        () => discoverCorpusOwner(owner, { limit: 1, cursor: page.nextCursor }),
        (e) => e.code === 'CURSOR_STALE',
      );
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) n FROM pilot_corpus_owner_decision',
          )
        ).rows[0].n,
        0,
      );
      const { decideCorpusOwner } =
        await import('../lib/pilot/corpus-owner-store.ts');
      const { readCorpusDecision, readCorpusOwnerDecisions } =
        await import('../lib/pilot/corpus-entry-store.ts');
      const snap = (
        await f.client.execute(
          'SELECT * FROM pilot_corpus_snapshot ORDER BY sealed_at DESC,id DESC LIMIT 1',
        )
      ).rows[0];
      const receipt = await decideCorpusOwner(owner, v, {
        requestId: 'pending-rejected',
        snapshotId: snap.id,
        corpusDigest: snap.corpus_digest,
        candidateId: snap.candidate_id,
        sourceDigest: snap.source_digest,
        artifactDigest: snap.artifact_digest,
        scope: {
          kind: 'supervised-trial',
          members: [{ parentId: 'r6-parent', childId: 'r6-child' }],
        },
        decision: 'rejected',
      });
      const safe = await readCorpusDecision(c, v, receipt.recordId);
      assert.deepEqual(safe.receipt, receipt);
      assert.equal(safe.decision, 'rejected');
      assert.equal(safe.snapshotId, snap.id);
      assert.ok(!JSON.stringify(safe).includes('owner_session_id'));
      assert.deepEqual(
        await readCorpusDecision(owner, v, receipt.recordId),
        safe,
      );
      assert.equal(
        (await readCorpusOwnerDecisions(c, v, snap.id)).items.length,
        1,
      );
      await assert.rejects(
        () => readCorpusDecision(f.context('r6-child'), v, receipt.recordId),
        (e) => e.status === 403,
      );
    },
    { trust },
  );
});
