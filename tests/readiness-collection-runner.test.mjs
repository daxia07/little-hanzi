import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessPhase } from '../scripts/readiness-node-runner.mjs';
test('[R5-E-012] collection candidate identity is explicit and unknown future phases remain refused', () => {
  assert.deepEqual(readinessPhase('r5'), {
    specVersion: 'r5-spec-2',
    integrationVersion: 'r5-integration-1',
    lessonVersion: 'little-hanzi-path-1-v1',
  });
  assert.throws(() => readinessPhase('r7'), /Unsupported readiness phase/);
  assert.equal(readinessPhase('r3').lessonVersion, 'forest-01-v4');
});

const { validateCollectionControl } =
  await import('../scripts/readiness-collection-node-runner.mjs');
test('[R5-E-012] private collection controls expose only bounded inspections, never arbitrary SQL or paths', () => {
  for (const body of [
    { kind: 'counts' },
    { kind: 'assignment', assignmentId: 'owned-assignment' },
    { kind: 'run', runId: 'owned-run' },
  ])
    assert.equal(validateCollectionControl('/inspect', body), true);
  for (const [route, body] of [
    ['/sql', { sql: 'SELECT 1' }],
    ['/inspect', { kind: 'counts', token: 'extra' }],
    ['/inspect', { kind: 'run', runId: '../private' }],
    ['/import', { path: '/tmp/package.json' }],
  ])
    assert.throws(
      () => validateCollectionControl(route, body),
      /Invalid collection runner control/,
    );
});

test('[R5-P-001/002] positive controls bind only a fixed package and explicit ordinary target; proof never accepts caller reports', async () => {
  assert.equal(
    validateCollectionControl(
      '/verify-and-sign',
      { suite: 'collection', lessonVersion: 'path-01-v1' },
      'positive-collection',
    ),
    true,
  );
  assert.equal(
    validateCollectionControl(
      '/inspect',
      { kind: 'counts', target: 'ordinary' },
      'positive-collection',
    ),
    true,
  );
  for (const [route, body, profile] of [
    [
      '/verify-and-sign',
      { suite: 'collection', lessonVersion: 'path-11-v1' },
      'positive-collection',
    ],
    [
      '/verify-and-sign',
      {
        suite: 'collection',
        lessonVersion: 'path-01-v1',
        report: { pass: true },
      },
      'positive-collection',
    ],
    ['/inspect', { kind: 'counts', target: 'ordinary' }, 'draft-collection'],
    ['/inspect', { kind: 'counts', target: 'foreign' }, 'positive-collection'],
  ])
    assert.throws(() => validateCollectionControl(route, body, profile));
});

test('[R5-P-001] closed collection profile rejects unknown paths before candidate or owned processes are opened', async () => {
  const { collectionProfile } =
    await import('../scripts/readiness-collection-profiles.mjs');
  const { serveStoryNodeCandidate } =
    await import('../scripts/readiness-story-node-runner.mjs');
  assert.deepEqual(collectionProfile(), {
    name: 'draft-collection',
    manifestPath: 'content/collections/little-hanzi-path-1-v1.json',
    packageDirectory: 'content/curriculum/collection',
  });
  assert.deepEqual(collectionProfile('positive-collection'), {
    name: 'positive-collection',
    manifestPath:
      'tests/fixtures/curriculum/collection-positive/collection.json',
    packageDirectory: 'tests/fixtures/curriculum/collection-positive',
  });
  assert.ok(Object.isFrozen(collectionProfile('positive-collection')));
  for (const name of [
    '../private',
    'production',
    {},
    null,
    'positive-publication',
  ])
    assert.throws(() => collectionProfile(name), /COLLECTION_PROFILE_INVALID/);
  await assert.rejects(
    serveStoryNodeCandidate('/does-not-exist', {
      collectionFactory: async () => {},
      collectionProfileName: '../private',
    }),
    /COLLECTION_PROFILE_INVALID/,
  );
  await assert.rejects(
    serveStoryNodeCandidate('/does-not-exist', {
      collectionProfileName: 'positive-collection',
    }),
    /Collection profile requires its runner/,
  );
});

test('[R5-P-002] fixed per-package children isolate seven-day proofs without expanding the default story fixture', async () => {
  const { syntheticStoryAccounts } =
    await import('../scripts/readiness-story-node-runner.mjs');
  const ordinary = syntheticStoryAccounts('owned-synthetic');
  assert.equal(ordinary.length, 7);
  const expanded = syntheticStoryAccounts('owned-synthetic', {
    collection: true,
  });
  assert.equal(expanded.length, 17);
  for (let i = 1; i <= 10; i++) {
    const label = `collection-child-${String(i).padStart(2, '0')}`;
    const child = expanded.find((a) => a.label === label);
    assert.ok(child);
    assert.equal(child.role, 'child');
    assert.match(child.username, /^[a-zA-Z0-9_.]+$/);
    assert.equal(child.id, `qa-story-${label}`);
  }
  assert.equal(new Set(expanded.map((a) => a.id)).size, 17);
});
