import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
} from '../../scripts/readiness-corpus-bootstrap.mjs';
import * as entry from '../../lib/pilot/corpus-entry-store.ts';
import { corpusCoverage } from '../../lib/pilot/corpus-coverage.ts';
import { recordCorpusSource } from '../../lib/pilot/corpus-store.ts';
import {
  proposeCorpus,
  approveCorpus,
} from '../../lib/pilot/corpus-family-store.ts';
import { saveOnboarding } from '../../lib/pilot/learning.ts';
const options = { timeout: 60000 };
const rejectStatus = (status) => (e) => e.status === status;
async function counts(f) {
  const rows = (
    await f.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
  ).rows;
  const result = {};
  for (const { name } of rows)
    result[name] = (
      await f.client.execute('SELECT count(*) n FROM ' + name)
    ).rows[0].n;
  return result;
}
async function assign(f, r) {
  await saveOnboarding(
    f.db,
    'r6-parent',
    'r6-child',
    {
      nickname: 'Independent entry fixture',
      experience: 'new',
      audioReady: true,
    },
    Date.now(),
  );
  const item = f.manifest.items[0];
  const { proposal } = await proposeCorpus(f.context('r6-parent'), 'r6-child', {
    corpusVersion: f.manifest.corpusVersion,
    selection: {
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      releaseId: r.recordId,
      releaseRevision: r.revision,
    },
    predecessorProposalId: null,
    expectedSourceDigest: null,
  });
  return approveCorpus(f.context('r6-parent'), 'r6-child', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
}
test(
  'EC01 actual role exclusion and discovery never creates plans',
  options,
  () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const release = await bootstrapOwnedCorpus(f.handle),
        before = await counts(f);
      const parent = await entry.discoverChildCorpora(
        f.context('r6-parent'),
        'r6-child',
      );
      assert.equal(parent.items.length, 1);
      assert.equal(parent.items[0].available, true);
      assert.deepEqual(
        (await entry.discoverChildCorpora(f.context('r6-child'), 'r6-child'))
          .items,
        [],
      );
      await assert.rejects(
        () => entry.discoverChildCorpora(f.context('r6-parent-2'), 'r6-child'),
        rejectStatus(404),
      );
      await assert.rejects(
        () => entry.discoverChildCorpora(f.context('r6-teacher'), 'r6-child'),
        rejectStatus(404),
      );
      assert.deepEqual(await counts(f), before);
      await assign(f, release);
      assert.equal(
        (await entry.discoverChildCorpora(f.context('r6-child'), 'r6-child'))
          .items[0].corpusVersion,
        f.manifest.corpusVersion,
      );
    }),
);
test(
  'EC04 configured empty owner, unconfigured denial and current role checks',
  options,
  () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const yes = await entry.discoverCorpusOwner(f.context('r6-parent'));
      assert.equal(yes.allowed, true);
      assert.deepEqual(yes.items, []);
      const c = {
        ...f.context('r6-parent'),
        corpus: { ...f.corpus, ownerIds: [] },
      };
      const no = await entry.discoverCorpusOwner(c);
      assert.equal(no.allowed, false);
      assert.deepEqual(no.items, []);
      assert.equal(no.nextCursor, null);
      await assert.rejects(
        () => entry.discoverCorpusOwner(f.context('r6-child')),
        rejectStatus(403),
      );
      await f.client.execute(
        "UPDATE pilot_auth_user SET disabled=1 WHERE id='r6-parent'",
      );
      await assert.rejects(
        () => entry.discoverCorpusOwner(c),
        rejectStatus(401),
      );
    }),
);
test(
  'EC06 saved snapshot pages/head immutable readbacks and cursor tamper',
  options,
  () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const r = await bootstrapOwnedCorpus(f.handle),
        v = f.manifest.corpusVersion,
        c = f.context('r6-op'),
        before = await counts(f);
      const items = [];
      let cursor;
      do {
        const p = await entry.readCorpusSnapshotPackages(c, v, r.snapshotId, {
          limit: 3,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...p.items);
        cursor = p.nextCursor;
      } while (cursor);
      assert.equal(items.length, 10);
      assert.equal(new Set(items.map((x) => x.lessonVersion)).size, 10);
      assert(items.every((x) => x.chunked));
      assert(!JSON.stringify(items).includes('packageEligibility'));
      const h = await entry.readCorpusPublicationHead(c, v),
        p = await entry.readCorpusPublication(c, v, r.recordId);
      assert.equal(h.publication.receipt.recordId, r.recordId);
      assert.equal(p.receipt.recordId, r.recordId);
      await assert.rejects(
        () => entry.readCorpusPublicationHead(f.context('r6-parent'), v),
        rejectStatus(403),
      );
      const first = await entry.readCorpusSnapshotPackages(c, v, r.snapshotId, {
        limit: 3,
      });
      await assert.rejects(
        () =>
          entry.readCorpusSnapshotPackages(c, v, r.snapshotId, {
            limit: 3,
            cursor: first.nextCursor + 'x',
          }),
        (e) => e.code === 'CURSOR_INVALID',
      );
      assert.deepEqual(await counts(f), before);
    }),
);
test(
  'EC05 actual current fixture correction intersects historical snapshot without real counts',
  options,
  () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const r = await bootstrapOwnedCorpus(f.handle),
        v = f.manifest.corpusVersion,
        c = f.context('r6-op');
      const initial = await corpusCoverage(c, v);
      assert.equal(initial.fixtureCharacterCount, 20);
      assert.equal(initial.verificationPackageCount, 10);
      assert.equal(initial.release.currentEligibleCharacterCount, 20);
      assert.equal(initial.snapshot.snapshotId, r.snapshotId);
      for (const n of [
        'reviewedReady',
        'prospectiveStarter',
        'committedStarter',
      ])
        assert.equal(initial.counts[n], 0);
      const noTrust = await corpusCoverage(
        { ...c, config: { ...c.config, curriculumTrust: null } },
        v,
      );
      assert.equal(noTrust.snapshot, null);
      assert.equal(noTrust.counts.reviewedReady, 0);
      const s = (
        await f.client.execute(
          'SELECT * FROM pilot_corpus_source_evidence ORDER BY id LIMIT 1',
        )
      ).rows[0];
      await recordCorpusSource(c, v, {
        requestId: 'independent-source-correction',
        lessonVersion: s.lesson_version,
        contentDigest: s.content_digest,
        classification: 'unverified-draft',
        sourceRefs: ['synthetic-independent-source'],
        licenseRefs: ['synthetic-independent-license'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: s.id,
        expectedEvidenceDigest: s.evidence_digest,
      });
      const after = await corpusCoverage(c, v);
      assert.equal(after.snapshot.snapshotId, r.snapshotId);
      assert.equal(after.release.currentEligibleCharacterCount, 18);
      assert.equal(after.counts.reviewedReady, 0);
    }),
);
test(
  'EC07 readonly batch validation/readback no saved mutation and exact binding errors',
  options,
  () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const row = (
        await f.client.execute('SELECT * FROM pilot_corpus_batch LIMIT 1')
      ).rows[0];
      const batch = JSON.parse(row.manifest_json),
        c = f.context('r6-op'),
        v = f.manifest.corpusVersion,
        before = await counts(f);
      const result = await entry.validateCorpusBatch(c, v, { batch });
      assert(result.items.every((x) => x.state === 'accepted'));
      assert(!Object.hasOwn(result, 'receipt'));
      assert(!Object.hasOwn(result, 'recordedAt'));
      const wrong = structuredClone(batch);
      wrong.items[0].contentDigest = 'sha256:' + 'f'.repeat(64);
      const invalid = await entry.validateCorpusBatch(c, v, { batch: wrong });
      assert.equal(invalid.items[0].state, 'rejected');
      assert(
        invalid.items[0].errors.some((x) => x.fieldId === 'contentDigest'),
      );
      await entry.readCorpusBatch(c, v, row.id);
      assert.deepEqual(await counts(f), before);
    }),
);
test(
  'EC03 empty owner final SQL boundary refuses actual late session revocation',
  options,
  async () => {
    let active = false,
      fired = 0;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const c = {
          ...f.context('r6-parent'),
          corpus: { ...f.corpus, ownerIds: [] },
        };
        active = true;
        await assert.rejects(
          () => entry.discoverCorpusOwner(c),
          rejectStatus(401),
        );
        assert.equal(fired, 1);
      },
      {
        instrumentClient(client) {
          const real = client.execute.bind(client);
          client.execute = async (s, ...args) => {
            const sql = typeof s === 'string' ? s : s.sql;
            if (
              active &&
              sql.startsWith('SELECT 1 AS ok WHERE') &&
              sql.includes('pilot_installation')
            ) {
              active = false;
              fired++;
              await real(
                "DELETE FROM pilot_auth_session WHERE id='session-r6-parent'",
              );
            }
            return real(s, ...args);
          };
        },
      },
    );
  },
);
