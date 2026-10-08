/** Independent current owner/group direct-store checks; genuine approval NOT RUN. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCorpusFixture } from '../helpers/corpus-store-fixture.mjs';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../../lib/pilot/corpus-store.ts';
import {
  beginCorpusSnapshot,
  appendCorpusSnapshotChunk,
  sealCorpusSnapshot,
} from '../../lib/pilot/corpus-snapshot-store.ts';
import {
  readCorpusOwnerItem,
  readCorpusOwnerReview,
  decideCorpusOwner,
} from '../../lib/pilot/corpus-owner-store.ts';
import {
  readCurrentCorpusAuthority,
  readCorpusPackageAuthority,
  publishCorpus,
} from '../../lib/pilot/corpus-authority.ts';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../../scripts/readiness-corpus-bootstrap.mjs';
const hash = 'sha256:' + 'd'.repeat(64),
  trust = {
    candidateId: 'r6-author',
    sourceDigest: hash,
    artifactDigest: hash,
    buildId: 'r6-author',
    issuers: [],
    archiveIssuers: [],
  };
async function pending(fn) {
  await withCorpusFixture(
    async (f) => {
      const c = f.context(),
        v = f.manifest.corpusVersion;
      for (const i of f.manifest.items)
        await recordCorpusSource(c, v, {
          requestId: 'independent-source-' + i.lessonVersion,
          lessonVersion: i.lessonVersion,
          contentDigest: i.contentDigest,
          classification: 'unverified-draft',
          sourceRefs: ['SYNTHETIC-NOT-REVIEWED'],
          licenseRefs: ['SYNTHETIC'],
          reviewRefs: [],
          identityReviews: [],
          predecessorEvidenceId: null,
          expectedEvidenceDigest: null,
        });
      await registerCorpusBatch(c, v, {
        requestId: 'independent-batch',
        batch: f.batch,
      });
      await registerCorpus(c, { corpus: f.manifest });
      const b = await beginCorpusSnapshot(c, v, {
        requestId: 'independent-begin',
      });
      await appendCorpusSnapshotChunk(c, v, b.snapshotId, {
        requestId: 'independent-chunk',
        packages: f.manifest.items.map(({ lessonVersion, contentDigest }) => ({
          lessonVersion,
          contentDigest,
        })),
      });
      const row = (
        await f.client.execute({
          sql: 'SELECT * FROM pilot_corpus_snapshot WHERE id=?',
          args: [b.snapshotId],
        })
      ).rows[0];
      await sealCorpusSnapshot(c, v, b.snapshotId, {
        requestId: 'independent-seal',
        expectedPlanDigest: row.plan_digest,
      });
      await fn(f, v, b.snapshotId, JSON.parse(row.plan_json));
    },
    { trust: structuredClone(trust) },
  );
}
async function decisions(f) {
  return Number(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pilot_corpus_owner_decision',
      )
    ).rows[0].n,
  );
}
function body(plan, id, decision = 'rejected') {
  return {
    requestId: id,
    snapshotId: plan.snapshotId,
    corpusDigest: plan.corpusDigest,
    candidateId: plan.candidateId,
    sourceDigest: plan.sourceDigest,
    artifactDigest: plan.artifactDigest,
    scope: {
      kind: 'supervised-trial',
      members: [{ parentId: 'r6-parent', childId: 'r6-child' }],
    },
    decision,
  };
}

test(
  'OA01 configured owner only sees full actual bounded material; default-deny owner list',
  { timeout: 120000 },
  async () =>
    pending(async (f, v, id) => {
      const owner = f.context('r6-parent');
      for (const actor of ['r6-op', 'r6-child', 'r6-teacher'])
        await assert.rejects(
          () =>
            readCorpusOwnerItem(
              f.context(actor),
              v,
              id,
              f.manifest.items[0].lessonVersion,
            ),
          (e) => e.code === 'FORBIDDEN' && e.status === 403,
        );
      const item = await readCorpusOwnerItem(
        owner,
        v,
        id,
        f.manifest.items[0].lessonVersion,
      );
      assert.deepEqual(
        item.targets.map((t) => t.hanzi),
        ['木', '林'],
      );
      assert.equal(item.targets.length, 2);
      assert.equal(item.readers.length, 4);
      assert.equal(item.prompts.length, 10);
      assert.equal(
        item.prompts.reduce((n, p) => n + p.phases.length, 0),
        12,
      );
      assert.ok(
        item.prompts.every(
          (p) =>
            typeof p.expectedAnswerHanzi === 'string' &&
            p.expectedAnswerHanzi.length > 0,
        ),
      );
      assert.ok(!JSON.stringify(item).includes('correctChoiceId'));
      const review = await readCorpusOwnerReview(owner, v, {
        snapshotId: id,
        limit: 20,
      });
      assert.ok(review.items.length <= 20);
      owner.corpus.ownerIds = [];
      await assert.rejects(
        () => readCorpusOwnerReview(owner, v, { snapshotId: id }),
        (e) => e.code === 'FORBIDDEN',
      );
      assert.equal(await decisions(f), 0);
    }),
);

test(
  'OA02 ordinary pending fixture permits attributed rejection/replay but never accepted release',
  { timeout: 120000 },
  async () =>
    pending(async (f, v, id, plan) => {
      plan.snapshotId = id;
      const owner = f.context('r6-parent'),
        request = body(plan, 'independent-reject');
      const ack = await decideCorpusOwner(owner, v, request);
      assert.deepEqual(await decideCorpusOwner(owner, v, request), ack);
      assert.equal(await decisions(f), 1);
      await assert.rejects(
        () => decideCorpusOwner(owner, v, { ...request, decision: 'accepted' }),
        (e) => e.code === 'REQUEST_CONFLICT' && e.status === 409,
      );
      await assert.rejects(
        () =>
          decideCorpusOwner(
            owner,
            v,
            body(plan, 'independent-accept', 'accepted'),
          ),
        (e) => e.code === 'PUBLICATION_INELIGIBLE',
      );
      assert.equal(await decisions(f), 1);
      await f.client.execute(
        "DELETE FROM pilot_auth_session WHERE id='session-r6-parent'",
      );
      await assert.rejects(
        () => decideCorpusOwner(owner, v, request),
        (e) => e.code === 'FORBIDDEN',
      );
      assert.equal(await decisions(f), 1);
    }),
);

test(
  'OA03 fixed owned verification group survives own epoch; selected correction does not remove unrelated package',
  { timeout: 120000 },
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const ack = await bootstrapOwnedCorpus(f.handle),
        v = f.manifest.corpusVersion,
        parent = f.context('r6-parent'),
        a = await readCurrentCorpusAuthority(parent, v),
        first = f.manifest.items[0],
        other = f.manifest.items[1];
      assert.equal(a.releaseId, ack.recordId);
      const p = await readCorpusPackageAuthority(
        parent,
        a,
        first.lessonVersion,
      );
      assert.equal(p.available, true);
      assert.equal(p.soundReview, 'synthetic');
      const source = (
        await f.client.execute({
          sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE id=?',
          args: [p.sourceIds[0].id],
        })
      ).rows[0];
      await recordCorpusSource(f.context(), v, {
        requestId: 'independent-selected-correction',
        lessonVersion: first.lessonVersion,
        contentDigest: first.contentDigest,
        classification: 'unverified-draft',
        sourceRefs: ['SYNTHETIC-CORRECTION'],
        licenseRefs: ['SYNTHETIC'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: source.id,
        expectedEvidenceDigest: source.evidence_digest,
      });
      const current = await readCurrentCorpusAuthority(parent, v);
      assert.equal(current.releaseId, ack.recordId);
      assert.equal(
        (await readCorpusPackageAuthority(parent, current, first.lessonVersion))
          .available,
        false,
      );
      assert.equal(
        (await readCorpusPackageAuthority(parent, current, other.lessonVersion))
          .available,
        true,
      );
    }),
);

test(
  'OA04 normal route store cannot create verification; withdrawal preserves old ACK without reactivation',
  { timeout: 120000 },
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const ack = await bootstrapOwnedCorpus(f.handle),
        v = f.manifest.corpusVersion;
      await assert.rejects(
        () =>
          publishCorpus(f.context(), v, {
            requestId: 'independent-normal-verification',
            snapshotId: ack.snapshotId,
            ownerDecisionId: 'not-owner-acceptance',
            expectedRevision: 1,
            predecessorPublicationId: ack.recordId,
          }),
        (e) => e.code === 'VERIFICATION_FORBIDDEN' && e.status === 403,
      );
      const withdrawn = await withdrawOwnedCorpus(f.handle, {
        requestId: 'independent-withdraw',
        expectedRevision: 1,
        predecessorPublicationId: ack.recordId,
      });
      assert.deepEqual(await bootstrapOwnedCorpus(f.handle), ack);
      const current = await readCurrentCorpusAuthority(
        f.context('r6-parent'),
        v,
      );
      assert.equal(current.releaseId, withdrawn.recordId);
      assert.equal(current.status, 'withdrawn');
      assert.equal(
        (
          await readCorpusPackageAuthority(
            f.context('r6-parent'),
            current,
            f.manifest.items[0].lessonVersion,
          )
        ).available,
        false,
      );
    }),
);
