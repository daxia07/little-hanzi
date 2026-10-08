import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withCollectionFixture } from './helpers/collection-store-fixture.mjs';
import {
  approveCollection,
  bootstrapCollection,
  collectionPlans,
  proposeCollection,
} from '../lib/pilot/collection-store.ts';
async function approveNext(e, lessonVersion, previous = null) {
  const { proposal } = await proposeCollection(e.parent, 'c', {
    collectionVersion: e.manifest.collectionVersion,
    lessonVersion,
    predecessorProposalId: previous?.proposalId ?? null,
    expectedSourceDigest: previous?.sourceDigest ?? null,
  });
  const { plan } = await approveCollection(e.parent, 'c', {
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
  });
  return { proposal, plan };
}
test('[R5-E-003/004/005] same-clock approvals follow committed selection order and old replay does not promote history', async () => {
  await withCollectionFixture(async (e) => {
    let generated = 0;
    const generator = mock.method(globalThis.crypto, 'randomUUID', () => {
      generated++;
      return `${generated <= 5 ? 'ffffffff' : '00000000'}-0000-4000-8000-${String(generated).padStart(12, '0')}`;
    });
    try {
      const first = await approveNext(e, 'path-01-v1');
      const second = await approveNext(e, 'path-02-v1', first.proposal);
      assert.equal(first.plan.approvedAt, second.plan.approvedAt);
      assert(
        first.plan.planId > second.plan.planId,
        'fixture deliberately reverses UUID lexical order',
      );
      const result = await collectionPlans(
        e.parent,
        'c',
        e.manifest.collectionVersion,
      );
      assert.equal(result.plan.planId, second.plan.planId);
      assert.deepEqual(
        result.history.map((p) => p.planId),
        [first.plan.planId, second.plan.planId],
      );
      const replay = await approveCollection(e.parent, 'c', {
        proposalId: first.proposal.proposalId,
        sourceDigest: first.proposal.sourceDigest,
      });
      assert.equal(replay.plan.planId, first.plan.planId);
      const after = await collectionPlans(
        e.parent,
        'c',
        e.manifest.collectionVersion,
      );
      assert.equal(after.plan.planId, second.plan.planId);
      assert.deepEqual(
        after.history.map((p) => p.planId),
        [first.plan.planId, second.plan.planId],
      );
    } finally {
      generator.mock.restore();
    }
  });
});
test('[R5-E-003/004/005] historical higher selection ordinal cannot hide current installation plan', async () => {
  await withCollectionFixture(async (e) => {
    let generated = 0,
      currentChain = false;
    const generator = mock.method(
      globalThis.crypto,
      'randomUUID',
      () =>
        `${currentChain ? '00000000' : 'ffffffff'}-0000-4000-8000-${String(++generated).padStart(12, '0')}`,
    );
    try {
      const first = await approveNext(e, 'path-01-v1');
      const historical = await approveNext(e, 'path-02-v1', first.proposal);
      await e.client.execute(
        "UPDATE pilot_installation SET installation_id='r5-current-install' WHERE id=1",
      );
      e.config.collectionCapability.installationId = 'r5-current-install';
      const packages = e.manifest.items.map((item) =>
        JSON.parse(
          fs.readFileSync(
            new URL(
              '../content/curriculum/collection/' +
                item.lessonVersion +
                '.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      await bootstrapCollection(e.operator, e.manifest, packages);
      currentChain = true;
      const current = await approveNext(e, 'path-03-v1');
      assert(historical.plan.planId > current.plan.planId);
      assert.equal(current.proposal.selectionOrdinal, 1);
      assert.equal(historical.proposal.selectionOrdinal, 2);
      const result = await collectionPlans(
        e.parent,
        'c',
        e.manifest.collectionVersion,
      );
      assert.equal(result.plan.planId, current.plan.planId);
      assert.deepEqual(
        result.history.map((p) => p.planId),
        [first.plan.planId, historical.plan.planId, current.plan.planId],
      );
    } finally {
      generator.mock.restore();
    }
  });
});
