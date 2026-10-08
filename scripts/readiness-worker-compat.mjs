import fs from 'node:fs';
import path from 'node:path';
import {
  collectionSchemaSource,
  COLLECTION_MIGRATIONS,
} from './pilot-collection-schema.mjs';

/** Explicit legacy Worker regression selection; immutable candidate identities stay intact. */
export function assertPilotCompatibilityManifest(
  manifest,
  { historicalSchema } = {},
) {
  if (historicalSchema !== undefined) {
    if (
      historicalSchema !== 'r5' ||
      manifest?.phase !== 'r6' ||
      manifest.specVersion !== 'r6-spec-2' ||
      manifest.integrationVersion !== 'r6-integration-1' ||
      manifest.lessonVersion !== 'hanzi-starter-draft-v1'
    )
      throw new Error(
        'Historical compatibility requires exact R6 identity and historicalSchema r5',
      );
    return true;
  }
  if (
    manifest?.phase === undefined &&
    manifest?.specVersion === 's2-spec-1' &&
    manifest.lessonVersion === 'forest-01-v1'
  )
    return true;
  if (
    ['r3', 'r4'].includes(manifest?.phase) &&
    manifest.specVersion === `${manifest.phase}-spec-2` &&
    manifest.integrationVersion === `${manifest.phase}-integration-1` &&
    manifest.lessonVersion === 'forest-01-v4'
  )
    return true;
  if (
    manifest?.phase === 'r5' &&
    manifest.specVersion === 'r5-spec-2' &&
    manifest.integrationVersion === 'r5-integration-1' &&
    manifest.lessonVersion === 'little-hanzi-path-1-v1'
  )
    return true;
  throw new Error(
    'Pilot compatibility requires frozen S2/V1 or complete R3/R4/V4 or R5/collection identities',
  );
}
export function legacyPreviewSentinelVersion(manifest) {
  if (
    ['r3-spec-2', 'r4-spec-2', 'r5-spec-2', 'r6-spec-2'].includes(
      manifest?.specVersion,
    )
  ) {
    assertPilotCompatibilityManifest(
      manifest,
      manifest.phase === 'r6' ? { historicalSchema: 'r5' } : {},
    );
    return 'forest-01-v1';
  }
  if (
    ['s1-spec-2', 's2-spec-1', 'r2-spec-2'].includes(manifest?.specVersion) &&
    ['forest-01-v1', 'forest-01-v3'].includes(manifest.lessonVersion)
  )
    return manifest.lessonVersion;
  throw new Error('Unknown frozen legacy Worker regression identity');
}

/** Closed schema tooling selector; candidate/artifact identity is never replaced. */
export function pilotMigrationFiles(manifest, { historicalSchema } = {}) {
  if (historicalSchema !== undefined)
    assertPilotCompatibilityManifest(manifest, { historicalSchema });
  const directory = path.join(manifest.snapshot, 'db/pilot-migrations');
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^\d+-.+\.sql$/.test(name))
    .sort();
  if (historicalSchema !== undefined) {
    const expected = [...COLLECTION_MIGRATIONS, '0007-corpus-learning.sql'];
    if (JSON.stringify(files) !== JSON.stringify(expected))
      throw new Error(
        'Historical schema requires exact known eight-migration source',
      );
    collectionSchemaSource(manifest.snapshot);
    return [...COLLECTION_MIGRATIONS];
  }
  return files;
}
