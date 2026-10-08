import path from 'node:path';
import { COLLECTION_MIGRATIONS } from './pilot-collection-schema.mjs';
import {
  migrationSchemaSource,
  assertStorySchema,
} from './pilot-story-schema.mjs';

export const CORPUS_MIGRATIONS = [
  ...COLLECTION_MIGRATIONS,
  '0007-corpus-learning.sql',
];
export function corpusSchemaSource(
  root = path.resolve(import.meta.dirname, '..'),
) {
  return migrationSchemaSource(root, CORPUS_MIGRATIONS);
}
export function assertCorpusSchema(payload, source = corpusSchemaSource()) {
  return assertStorySchema(payload, source);
}
