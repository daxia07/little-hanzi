import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storySchemaSource } from '../scripts/pilot-story-schema.mjs';
import { collectionSchemaSource } from '../scripts/pilot-collection-schema.mjs';
import {
  corpusSchemaSource,
  CORPUS_MIGRATIONS,
} from '../scripts/pilot-corpus-schema.mjs';

function tree() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r6-schema-prefix-')),
  );
  fs.writeFileSync(
    path.join(root, '.qa-owned'),
    'synthetic source prefix only\n',
  );
  const dir = path.join(root, 'db/pilot-migrations');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of CORPUS_MIGRATIONS)
    fs.copyFileSync(
      name.startsWith('0007-') && !fs.existsSync(`db/pilot-migrations/${name}`)
        ? 'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql'
        : `db/pilot-migrations/${name}`,
      path.join(dir, name),
    );
  return {
    root,
    dir,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
test('[R6-E-013/015] eight-file source retains exact historical6/7 prefixes and explicit new8', () => {
  const owned = tree();
  try {
    assert.deepEqual(
      storySchemaSource(owned.root).migrations,
      storySchemaSource().migrations,
    );
    assert.deepEqual(
      collectionSchemaSource(owned.root).migrations,
      collectionSchemaSource().migrations,
    );
    assert.equal(corpusSchemaSource(owned.root).migrations.length, 8);
  } finally {
    owned.close();
  }
});
test('[R6-E-013/015] unknown successor and broken known prefix fail every source dispatcher', () => {
  const owned = tree();
  try {
    fs.writeFileSync(path.join(owned.dir, '0008-unknown.sql'), '-- unknown\n');
    for (const read of [
      storySchemaSource,
      collectionSchemaSource,
      corpusSchemaSource,
    ])
      assert.throws(() => read(owned.root), /BACKUP_VERSION_INCOMPATIBLE/);
    fs.rmSync(path.join(owned.dir, '0008-unknown.sql'));
    fs.renameSync(
      path.join(owned.dir, '0006-collection-learning.sql'),
      path.join(owned.dir, '0006-unknown.sql'),
    );
    for (const read of [
      storySchemaSource,
      collectionSchemaSource,
      corpusSchemaSource,
    ])
      assert.throws(() => read(owned.root), /BACKUP_VERSION_INCOMPATIBLE/);
  } finally {
    owned.close();
  }
});
