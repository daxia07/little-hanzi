import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runner from '../scripts/readiness-story-node-runner.mjs';

test('[F1-003] owned story runtime installs only its known historical schema without changing source', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-f1-prefix-'));
  const source = path.join(work, 'source');
  const directory = path.join(source, 'db/pilot-migrations');
  fs.mkdirSync(directory, { recursive: true });
  const original = path.resolve(import.meta.dirname, '../db/pilot-migrations');
  for (const name of fs.readdirSync(original))
    fs.copyFileSync(path.join(original, name), path.join(directory, name));
  const before = fs.readdirSync(directory).sort();
  try {
    const target = path.join(work, 'staged');
    runner.stageStoryMigrationSource(source, target, 'r3');
    assert.deepEqual(
      fs.readdirSync(path.join(target, 'db/pilot-migrations')).sort(),
      before.slice(0, 6),
    );
    for (const name of before.slice(0, 6))
      assert.deepEqual(
        fs.readFileSync(path.join(directory, name)),
        fs.readFileSync(path.join(target, 'db/pilot-migrations', name)),
      );
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
    assert.throws(() => runner.stageStoryMigrationSource(source, target, 'r3'));
    fs.writeFileSync(
      path.join(directory, '0008-unknown.sql'),
      'CREATE TABLE unknown(id);',
    );
    assert.throws(
      () =>
        runner.stageStoryMigrationSource(
          source,
          path.join(work, 'unknown'),
          'r3',
        ),
      /BACKUP_VERSION_INCOMPATIBLE/,
    );
    assert.equal(fs.existsSync(path.join(work, 'unknown')), false);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
