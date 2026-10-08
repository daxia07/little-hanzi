import path from 'node:path';
import {
  STORY_MIGRATIONS,
  migrationSchemaSource,
  assertStorySchema,
} from './pilot-story-schema.mjs';

export const COLLECTION_MIGRATIONS = [
  ...STORY_MIGRATIONS,
  '0006-collection-learning.sql',
];

export function collectionSchemaSource(
  root = path.resolve(import.meta.dirname, '..'),
) {
  return migrationSchemaSource(root, COLLECTION_MIGRATIONS, {
    knownSuccessors: ['0007-corpus-learning.sql'],
  });
}

export function assertCollectionSchema(
  payload,
  source = collectionSchemaSource(),
) {
  return assertStorySchema(payload, source);
}
