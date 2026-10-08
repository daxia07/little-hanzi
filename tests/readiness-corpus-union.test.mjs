import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { collectionSchemaSource } from '../scripts/pilot-collection-schema.mjs';
import {
  collectionTableNames,
  validatePilotCollectionBackup,
} from '../scripts/pilot-collection-backup.mjs';
import * as legacy from '../scripts/pilot-backup.mjs';
import {
  archiveHash,
  mixedCorpusRegistryArchive,
  ownedCorpusArchiveSource,
} from './helpers/corpus-archive-fixture.mjs';

const owned = ownedCorpusArchiveSource();
after(owned.close);
function previousFormat(value) {
  const source = collectionSchemaSource();
  return {
    ...value,
    format: 'pilot-admin-backup-5',
    migrations: source.migrations,
    schema: source.schema,
    schemaDigest: archiveHash(source.schema),
    tables: Object.fromEntries(
      collectionTableNames().map((name) => [name, value.tables[name]]),
    ),
  };
}
const validate =
  process.env.CORPUS_UNION_BASELINE === 'legacy'
    ? (value) => validatePilotCollectionBackup(previousFormat(value))
    : (value) =>
        legacy.validateCorpusRegistryAndLegacyHistory(value, {
          source: owned.source,
        });

test('[R6-E-013/015] explicit V6 union preserves complete mixed registry, rejected review and audits', async () => {
  const value = mixedCorpusRegistryArchive(owned.source),
    original = JSON.stringify(value);
  const result = await validate(value);
  assert.equal(JSON.stringify(result), original);
  assert.equal(result.tables.pilot_curriculum_package.length, 3);
  assert.equal(result.tables.pilot_curriculum_audit.length, 4);
  assert.equal(result.tables.pilot_curriculum_registry_state[0].revision, 4);
  assert.equal(result.tables.pilot_curriculum_review[0].decision, 'rejected');
  assert.notEqual(result, value);
  assert.equal(JSON.stringify(value), original);
});

test('[R6-E-013] every shared registry relationship stays checked with R6 present', async () => {
  const mutations = [
    (p) => {
      p.tables.pilot_curriculum_audit.pop();
      p.tables.pilot_curriculum_registry_state[0].revision--;
    },
    (p) => {
      p.tables.pilot_curriculum_review[0].content_digest =
        p.tables.pilot_curriculum_package[0].content_digest;
    },
    (p) => {
      p.tables.pilot_curriculum_review[0].review_sequence = 2;
    },
    (p) => {
      p.tables.pilot_curriculum_character.at(-1).hanzi = '水';
    },
    (p) => {
      p.tables.pilot_curriculum_audit.at(-1).actor_user_id = 'unknown';
    },
    (p) => {
      p.tables.pilot_curriculum_registry_state[0].revision--;
    },
    (p) => {
      p.tables.pilot_curriculum_audit.push({
        ...p.tables.pilot_curriculum_audit[0],
        id: 'duplicate-import',
      });
      p.tables.pilot_curriculum_registry_state[0].revision++;
    },
    (p) => {
      p.tables.pilot_collection_item.push({
        lesson_version: 'corpus-path-01-v1',
      });
    },
  ];
  for (const change of mutations) {
    const value = structuredClone(mixedCorpusRegistryArchive(owned.source));
    change(value);
    await assert.rejects(() => validate(value));
  }
});

test('[R6-E-015] unchanged V5 parser remains strict even with caller opt-in flags', async () => {
  const value = previousFormat(mixedCorpusRegistryArchive(owned.source));
  await assert.rejects(
    () =>
      validatePilotCollectionBackup(value, {
        allowCorpus: true,
        corpusBoundary: true,
      }),
    { code: 'BACKUP_COLLECTION_INVALID' },
  );
  await assert.rejects(() => validate(value));
});

test('[R6-E-013] union preflight copies before async work and refuses getters without invoking them', async () => {
  const value = mixedCorpusRegistryArchive(owned.source);
  let touched = false;
  Object.defineProperty(value, 'tables', {
    enumerable: true,
    get() {
      touched = true;
      return {};
    },
  });
  await assert.rejects(() => validate(value));
  if (process.env.CORPUS_UNION_BASELINE !== 'legacy')
    assert.equal(touched, false);
  const mutable = mixedCorpusRegistryArchive(owned.source),
    original = JSON.stringify(mutable);
  const pending = validate(mutable);
  mutable.tables.pilot_curriculum_review[0].reason =
    'Caller mutated after invocation';
  assert.equal(JSON.stringify(await pending), original);
});
