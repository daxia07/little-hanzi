import test from 'node:test';
import assert from 'node:assert/strict';
import { withCorpusFixture } from './helpers/corpus-store-fixture.mjs';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../lib/pilot/corpus-store.ts';
import {
  readCorpusCatalog,
  proposeCorpus,
  approveCorpus,
} from '../lib/pilot/corpus-family-store.ts';
const d = 'sha256:' + 'a'.repeat(64);
async function registered(f) {
  const c = f.context();
  for (const item of f.manifest.items)
    await recordCorpusSource(c, f.manifest.corpusVersion, {
      requestId: 'family-source-' + item.lessonVersion,
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      classification: 'unverified-draft',
      sourceRefs: ['SYNTHETIC'],
      licenseRefs: ['SYNTHETIC'],
      reviewRefs: [],
      identityReviews: [],
      predecessorEvidenceId: null,
      expectedEvidenceDigest: null,
    });
  await registerCorpusBatch(c, f.manifest.corpusVersion, {
    requestId: 'family-batch',
    batch: f.batch,
  });
  await registerCorpus(c, { corpus: f.manifest });
}
const code = (expected) => (error) => error.code === expected;
test('R6 direct-store catalog forbids operator and unrelated family access on actual fresh libSQL', async () => {
  await withCorpusFixture(async (f) => {
    await registered(f);
    await assert.rejects(
      () =>
        readCorpusCatalog(f.context(), 'r6-child', f.manifest.corpusVersion),
      code('FORBIDDEN'),
    );
    await assert.rejects(
      () =>
        readCorpusCatalog(
          f.context('r6-parent'),
          'foreign-child',
          f.manifest.corpusVersion,
        ),
      code('NOT_FOUND'),
    );
    await assert.rejects(
      () =>
        readCorpusCatalog(
          f.context('r6-teacher'),
          'r6-child',
          f.manifest.corpusVersion,
        ),
      code('NOT_FOUND'),
    );
  });
});
test('R6 ordinary pending fixture catalog is truly empty and never emits package checks/source narratives', async () => {
  await withCorpusFixture(async (f) => {
    await registered(f);
    const page = await readCorpusCatalog(
      f.context('r6-parent'),
      'r6-child',
      f.manifest.corpusVersion,
    );
    assert.equal(page.schemaVersion, 'r6-catalog-1');
    assert.equal(page.corpusDigest, await f.packageDigest(f.manifest));
    assert.equal(page.releaseRevision, 0);
    assert.deepEqual(page.items, []);
    assert.equal(page.nextCursor, null);
    assert.equal(JSON.stringify(page).includes('correctChoiceId'), false);
    assert.equal(JSON.stringify(page).includes('evidence_json'), false);
  });
});
test('R6 direct-store query refusal does not accept malformed bounds or fake opaque cursors', async () => {
  await withCorpusFixture(async (f) => {
    await registered(f);
    for (const paging of [
      { limit: 0 },
      { limit: 51 },
      { q: '木'.repeat(81) },
      { cursor: 'c1.fake' },
    ])
      await assert.rejects(() =>
        readCorpusCatalog(
          f.context('r6-parent'),
          'r6-child',
          f.manifest.corpusVersion,
          paging,
        ),
      );
  });
});
test('R6 selection/approval remains parent-only and cannot create assignment facts from a normal pending fixture', async () => {
  await withCorpusFixture(async (f) => {
    await registered(f);
    const input = {
      corpusVersion: f.manifest.corpusVersion,
      selection: null,
      predecessorProposalId: null,
      expectedSourceDigest: null,
    };
    for (const id of ['r6-op', 'r6-child', 'r6-teacher'])
      await assert.rejects(
        () => proposeCorpus(f.context(id), 'r6-child', input),
        code('FORBIDDEN'),
      );
    for (const id of ['r6-op', 'r6-child', 'r6-teacher'])
      await assert.rejects(
        () =>
          approveCorpus(f.context(id), 'r6-child', {
            proposalId: 'unknown',
            sourceDigest: d,
          }),
        code('FORBIDDEN'),
      );
    await assert.rejects(() =>
      proposeCorpus(f.context('r6-parent'), 'r6-child', input),
    );
    for (const table of [
      'pilot_corpus_proposal',
      'pilot_corpus_plan',
      'pilot_corpus_plan_item',
      'pilot_corpus_assignment',
      'pilot_corpus_schedule',
      'pilot_corpus_learning_audit',
    ])
      assert.equal(
        Number(
          (await f.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]
            .n,
        ),
        0,
      );
  });
});
