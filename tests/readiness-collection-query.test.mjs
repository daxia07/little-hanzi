import test from 'node:test';
import assert from 'node:assert/strict';
import { withCollectionFixture } from './helpers/collection-store-fixture.mjs';
import {
  collectionLibrary,
  collectionPlacement,
  collectionPlans,
  collectionPractice,
} from '../lib/pilot/collection-store.ts';

test('[R5-E-003][R5-HTTP-01] unknown collection selectors are invalid input while foreign children remain hidden', async () => {
  await withCollectionFixture(async (e) => {
    for (const read of [
      collectionLibrary,
      collectionPlacement,
      collectionPlans,
      collectionPractice,
    ]) {
      await assert.rejects(
        () => read(e.parent, 'c', 'unknown'),
        (error) => error.code === 'INVALID_REQUEST' && error.status === 400,
      );
      await assert.rejects(
        () => read(e.parent, 'c2', e.manifest.collectionVersion),
        (error) => error.code === 'NOT_FOUND' && error.status === 404,
      );
    }
    const catalog = await collectionLibrary(
      e.parent,
      'c',
      e.manifest.collectionVersion,
    );
    assert.equal(catalog.items.length, 10);
    const assignments = await e.client.execute(
      'SELECT COUNT(*) AS n FROM pilot_collection_assignment',
    );
    assert.equal(assignments.rows[0].n, 0);
  });
});
