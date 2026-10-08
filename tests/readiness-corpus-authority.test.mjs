import test from 'node:test';
import assert from 'node:assert/strict';
import { withCorpusFixture } from './helpers/corpus-store-fixture.mjs';
import {
  readCorpusOwnerReview,
  readCorpusOwnerItem,
  decideCorpusOwner,
} from '../lib/pilot/corpus-owner-store.ts';
import {
  readCurrentCorpusAuthority,
  publishCorpus,
  withdrawCorpus,
} from '../lib/pilot/corpus-authority.ts';
import {
  registerCorpus,
  recordCorpusSource,
  registerCorpusBatch,
} from '../lib/pilot/corpus-store.ts';
import {
  beginCorpusSnapshot,
  appendCorpusSnapshotChunk,
  sealCorpusSnapshot,
} from '../lib/pilot/corpus-snapshot-store.ts';
import {
  canonicalPackage,
  curriculumDigest,
} from '../lib/curriculum/digest.ts';
import {
  normalizeCorpusOwnerItem,
  normalizeCorpusOwnerReview,
} from '../lib/pilot-corpus-owner-client.ts';
const d = 'sha256:' + 'a'.repeat(64);
const trust = {
  candidateId: 'r6-author',
  sourceDigest: d,
  artifactDigest: d,
  buildId: 'synthetic-build',
  issuers: [],
  archiveIssuers: [],
};
async function sealed(f) {
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
  const b = await beginCorpusSnapshot(c, v, { requestId: 'begin' });
  await appendCorpusSnapshotChunk(c, v, b.snapshotId, {
    requestId: 'chunk',
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
    requestId: 'seal',
    expectedPlanDigest: row.plan_digest,
  });
  return { v, snapshotId: b.snapshotId, row, plan: JSON.parse(row.plan_json) };
}
function decision(s, decision = 'rejected') {
  return {
    requestId: 'owner-reject',
    snapshotId: s.snapshotId,
    corpusDigest: s.row.corpus_digest,
    candidateId: s.row.candidate_id,
    sourceDigest: s.row.source_digest,
    artifactDigest: s.row.artifact_digest,
    scope: {
      kind: 'supervised-trial',
      members: [{ parentId: 'r6-parent', childId: 'r6-child' }],
    },
    decision,
  };
}
test('E007 protected owner reads reject unconfigured operator and child before exposing snapshot curriculum', async () => {
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f);
      await assert.rejects(
        () =>
          readCorpusOwnerReview(f.context(), s.v, { snapshotId: s.snapshotId }),
        (e) => e.status === 403,
      );
      await assert.rejects(
        () =>
          readCorpusOwnerItem(
            f.context('r6-child'),
            s.v,
            s.snapshotId,
            f.manifest.items[0].lessonVersion,
          ),
        (e) => e.status === 403,
      );
    },
    { trust },
  );
});
test('E007 configured parent receives bounded exact owner display including expected answers, no raw grading map or private narrative', async () => {
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f),
        c = f.context('r6-parent'),
        view = await readCorpusOwnerReview(c, s.v, {
          snapshotId: s.snapshotId,
          limit: 3,
        });
      assert.equal(view.items.length, 3);
      assert.ok(view.nextCursor);
      assert.equal(view.counts.reviewedReady, 0);
      const item = await readCorpusOwnerItem(
        c,
        s.v,
        s.snapshotId,
        f.manifest.items[0].lessonVersion,
      );
      assert.equal(item.prompts.length, 10);
      assert.equal(item.targets.length, 2);
      assert.ok(item.prompts.every((p) => p.expectedAnswerHanzi));
      assert.equal(canonicalPackage(item).includes('correctChoiceId'), false);
      assert.equal(item.evidenceRefs.proof.length, 0);
      assert.equal(
        normalizeCorpusOwnerReview(view, s.v, s.snapshotId, 3).items.length,
        3,
      );
      assert.equal(
        normalizeCorpusOwnerItem(
          item,
          s.snapshotId,
          item.lessonVersion,
          item.contentDigest,
        ).prompts.length,
        10,
      );
    },
    { trust },
  );
});
test('E007 rejected owner receipt is immutable exact replay, accepted fixture scope is refused and current owner authorization remains mandatory', async () => {
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f),
        c = f.context('r6-parent'),
        body = decision(s);
      const ack = await decideCorpusOwner(c, s.v, body);
      assert.deepEqual(await decideCorpusOwner(c, s.v, body), ack);
      await assert.rejects(
        () => decideCorpusOwner(c, s.v, { ...body, decision: 'accepted' }),
        (e) => e.status === 409,
      );
      await assert.rejects(
        () =>
          decideCorpusOwner(c, s.v, {
            ...body,
            requestId: 'positive',
            decision: 'accepted',
          }),
        (e) => e.code === 'PUBLICATION_INELIGIBLE',
      );
      c.corpus.ownerIds = [];
      await assert.rejects(
        () => decideCorpusOwner(c, s.v, body),
        (e) => e.status === 403,
      );
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_owner_decision',
          )
        ).rows[0].n,
        1,
      );
    },
    { trust },
  );
});
test('E008 pending fixture snapshot and rejected decision cannot create any group, head or publication audit', async () => {
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f),
        owner = await decideCorpusOwner(
          f.context('r6-parent'),
          s.v,
          decision(s),
        );
      await assert.rejects(
        () =>
          publishCorpus(f.context(), s.v, {
            requestId: 'publish',
            snapshotId: s.snapshotId,
            ownerDecisionId: owner.recordId,
            expectedRevision: 0,
            predecessorPublicationId: null,
          }),
        (e) => e.code === 'PUBLICATION_INELIGIBLE',
      );
      assert.equal(await readCurrentCorpusAuthority(f.context(), s.v), null);
      for (const table of [
        'pilot_corpus_publication',
        'pilot_corpus_publication_state',
        'pilot_corpus_publication_audit',
      ])
        assert.equal(
          (await f.client.execute('SELECT count(*) AS n FROM ' + table)).rows[0]
            .n,
          0,
        );
      await assert.rejects(
        () =>
          withdrawCorpus(f.context(), s.v, {
            requestId: 'withdraw',
            expectedRevision: 0,
            predecessorPublicationId: null,
          }),
        (e) => e.status === 400,
      );
    },
    { trust },
  );
});
test('E007 owner final SQL predicate refuses session/link revocation with zero decision effects', async () => {
  let arm = false,
    fire = false;
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f);
      arm = true;
      await assert.rejects(
        () => decideCorpusOwner(f.context('r6-parent'), s.v, decision(s)),
        (e) => e.status === 403 || e.status === 409,
      );
      assert.equal(fire, true);
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_owner_decision',
          )
        ).rows[0].n,
        0,
      );
    },
    {
      trust,
      instrumentClient(client) {
        const batch = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          const sql = statements
            .map((s) => (typeof s === 'string' ? s : s.sql))
            .join('\n');
          if (arm && sql.includes('INSERT INTO pilot_corpus_owner_decision')) {
            arm = false;
            fire = true;
            await client.execute(
              "DELETE FROM pilot_parent_child WHERE parent_id='r6-parent'",
            );
          }
          return batch(statements, ...args);
        };
      },
    },
  );
});
test('E007 owner decision terminal constraint failure rolls back immutable receipt and row', async () => {
  let arm = false,
    fire = false;
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f);
      arm = true;
      await assert.rejects(
        () => decideCorpusOwner(f.context('r6-parent'), s.v, decision(s)),
        (e) => e.status === 503,
      );
      assert.equal(fire, true);
      assert.equal(
        (
          await f.client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_owner_decision',
          )
        ).rows[0].n,
        0,
      );
    },
    {
      trust,
      instrumentClient(client) {
        const batch = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          const sql = statements
            .map((s) => (typeof s === 'string' ? s : s.sql))
            .join('\n');
          if (arm && sql.includes('INSERT INTO pilot_corpus_owner_decision')) {
            arm = false;
            fire = true;
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
          return batch(statements, ...args);
        };
      },
    },
  );
});
test('E007 protected read revocation during member SELECT and changed build never emit owner curriculum', async () => {
  let arm = false,
    fire = false;
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f);
      arm = true;
      await assert.rejects(
        () =>
          readCorpusOwnerReview(f.context('r6-parent'), s.v, {
            snapshotId: s.snapshotId,
          }),
        (e) => e.status === 403,
      );
      assert.equal(fire, true);
      await f.client.execute(
        "UPDATE pilot_auth_user SET disabled=0 WHERE id='r6-parent'",
      );
      f.config.curriculumTrust = { ...trust, buildId: 'changed-build' };
      await assert.rejects(
        () =>
          readCorpusOwnerItem(
            f.context('r6-parent'),
            s.v,
            s.snapshotId,
            f.manifest.items[0].lessonVersion,
          ),
        (e) => e.code === 'SNAPSHOT_STALE',
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
            sql.includes('SELECT * FROM pilot_corpus_snapshot_member')
          ) {
            arm = false;
            fire = true;
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
test('E007 exact rejected replay skips later snapshot freshness but remains scoped, and foreign parent trial is denied', async () => {
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f),
        c = f.context('r6-parent'),
        body = decision(s),
        ack = await decideCorpusOwner(c, s.v, body);
      await recordCorpusSource(f.context(), s.v, {
        requestId: 'later-source',
        lessonVersion: f.manifest.items[0].lessonVersion,
        contentDigest: f.manifest.items[0].contentDigest,
        classification: 'unverified-draft',
        sourceRefs: ['synthetic-pending'],
        licenseRefs: ['synthetic-pending'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: s.plan.packages[0].targets[0].sourceEvidenceId,
        expectedEvidenceDigest:
          s.plan.packages[0].targets[0].sourceEvidenceDigest,
      });
      assert.deepEqual(await decideCorpusOwner(c, s.v, body), ack);
      await assert.rejects(
        () =>
          decideCorpusOwner(c, s.v, { ...body, requestId: 'new-after-epoch' }),
        (e) => e.code === 'SNAPSHOT_STALE',
      );
      await assert.rejects(
        () =>
          decideCorpusOwner(c, s.v, {
            ...body,
            requestId: 'foreign',
            scope: {
              kind: 'supervised-trial',
              members: [{ parentId: 'r6-other', childId: 'r6-child' }],
            },
          }),
        (e) => e.status === 403 || e.status === 409,
      );
    },
    { trust },
  );
});
test('E007 protected trial-scope paging refuses a link removed during the member read', async () => {
  let arm = false,
    fire = false;
  await withCorpusFixture(
    async (f) => {
      const s = await sealed(f);
      arm = true;
      await assert.rejects(
        () =>
          readCorpusOwnerReview(f.context('r6-parent'), s.v, {
            snapshotId: s.snapshotId,
          }),
        (e) => e.status === 403 || e.status === 409,
      );
      assert.equal(fire, true);
    },
    {
      trust,
      instrumentClient(client) {
        const execute = client.execute.bind(client);
        client.execute = async (statement, ...args) => {
          const sql = typeof statement === 'string' ? statement : statement.sql;
          if (
            arm &&
            sql.includes('SELECT * FROM pilot_corpus_snapshot_member')
          ) {
            arm = false;
            fire = true;
            await execute(
              "DELETE FROM pilot_parent_child WHERE parent_id='r6-parent'",
            );
          }
          return execute(statement, ...args);
        };
      },
    },
  );
});
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import {
  readCorpusPackageAuthority,
  corpusAuthorityGuard,
  corpusAuthorityIdentity,
  corpusAuthorityDigest,
} from '../lib/pilot/corpus-authority.ts';
test('E008 closed factory verification authority survives its own release epoch and never becomes real readiness', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const ack = await bootstrapOwnedCorpus(f.handle),
      c = f.context('r6-parent'),
      v = f.manifest.corpusVersion,
      a = await readCurrentCorpusAuthority(c, v);
    assert.equal(a.releaseId, ack.recordId);
    assert.equal(a.status, 'released');
    assert.equal(a.scope.kind, 'verification');
    const row = (
      await f.client.execute({
        sql: 'SELECT evidence_epoch,expected_included_count FROM pilot_corpus_snapshot WHERE id=?',
        args: [a.snapshotId],
      })
    ).rows[0];
    assert.ok(a.evidenceEpoch > row.evidence_epoch);
    assert.equal(row.expected_included_count, 0);
    const p = await readCorpusPackageAuthority(
      c,
      a,
      f.manifest.items[0].lessonVersion,
    );
    assert.equal(p.available, true);
    assert.equal(p.soundReview, 'synthetic');
    assert.equal(
      (
        await f.db
          .prepare('SELECT 1 AS ok WHERE ' + corpusAuthorityGuard(c, a, [p]))
          .first()
      ).ok,
      1,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_owner_decision',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_curriculum_review',
        )
      ).rows[0].n,
      0,
    );
    const identity = corpusAuthorityIdentity(a);
    assert.equal(identity.schemaVersion, 'r6-authority-1');
    assert.equal(JSON.stringify(identity).includes('session-'), false);
    assert.equal(
      await corpusAuthorityDigest(a),
      await curriculumDigest(identity),
    );
  });
});
test('E009 current selected package requires both unchanged source targets; unrelated correction does not withdraw remaining group members', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const c = f.context('r6-op'),
      v = f.manifest.corpusVersion,
      a = await readCurrentCorpusAuthority(c, v),
      first = f.manifest.items[0],
      other = f.manifest.items[1],
      pkg = await readCorpusPackageAuthority(c, a, first.lessonVersion),
      source = (
        await f.client.execute({
          sql: 'SELECT * FROM pilot_corpus_source_evidence WHERE id=?',
          args: [pkg.sourceIds[0].id],
        })
      ).rows[0];
    await recordCorpusSource(c, v, {
      requestId: 'source-correction',
      lessonVersion: first.lessonVersion,
      contentDigest: first.contentDigest,
      classification: 'unverified-draft',
      sourceRefs: ['synthetic-pending'],
      licenseRefs: ['synthetic-pending'],
      reviewRefs: [],
      identityReviews: [],
      predecessorEvidenceId: source.id,
      expectedEvidenceDigest: source.evidence_digest,
    });
    const current = await readCurrentCorpusAuthority(f.context('r6-parent'), v);
    assert.equal(current.releaseId, a.releaseId);
    assert.equal(
      (
        await readCorpusPackageAuthority(
          f.context('r6-parent'),
          current,
          first.lessonVersion,
        )
      ).available,
      false,
    );
    assert.equal(
      (
        await readCorpusPackageAuthority(
          f.context('r6-parent'),
          current,
          other.lessonVersion,
        )
      ).available,
      true,
    );
  });
});
test('E008 withdrawal advances single head while old ACK stays historical; normal routes cannot publish verification or bypass current build', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const ack = await bootstrapOwnedCorpus(f.handle),
      v = f.manifest.corpusVersion,
      a = await readCurrentCorpusAuthority(f.context('r6-parent'), v);
    await assert.rejects(
      () =>
        publishCorpus(f.context('r6-op'), v, {
          requestId: 'normal-publish',
          snapshotId: ack.snapshotId,
          ownerDecisionId: 'not-an-owner-record',
          expectedRevision: 1,
          predecessorPublicationId: ack.recordId,
        }),
      (e) => e.code === 'VERIFICATION_FORBIDDEN',
    );
    f.config.curriculumTrust.buildId = 'changed-build';
    await assert.rejects(
      () => readCurrentCorpusAuthority(f.context('r6-parent'), v),
      (e) => e.code === 'CAPABILITY_DENIED',
    );
    f.config.curriculumTrust.buildId = a.buildId;
    const withdrawn = await withdrawOwnedCorpus(f.handle, {
      requestId: 'withdraw-owned',
      expectedRevision: 1,
      predecessorPublicationId: ack.recordId,
    });
    const current = await readCurrentCorpusAuthority(f.context('r6-parent'), v);
    assert.equal(current.releaseRevision, 2);
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
    assert.equal(
      await f.db
        .prepare(
          'SELECT 1 AS ok WHERE ' +
            corpusAuthorityGuard(f.context('r6-parent'), current),
        )
        .first(),
      null,
    );
  });
});
