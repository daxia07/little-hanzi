import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildSitesMigrations } from '../scripts/sites-package.mjs';
import { STORY_MIGRATIONS } from '../scripts/pilot-story-schema.mjs';
import { legacyStoryRoot } from './helpers/legacy-pilot-root.mjs';

test('[R3-E-017] six-migration package applies unchanged bookkeeping and all fourteen new tables', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-story-schema-'),
  );
  try {
    const result = await buildSitesMigrations({
      root: legacyStoryRoot(path.resolve(import.meta.dirname, '..')),
      outputDirectory: directory,
    });
    assert.equal(result.migrationCount, 6);
    assert.deepEqual(result.sourceMigrations, STORY_MIGRATIONS);
    const statements = fs
      .readdirSync(result.drizzleDirectory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()
      .flatMap((name) =>
        fs
          .readFileSync(path.join(result.drizzleDirectory, name), 'utf8')
          .split('--> statement-breakpoint'),
      );
    const applied = spawnSync(
      'python3',
      [
        '-c',
        [
          'import sqlite3,json,sys',
          'db=sqlite3.connect(sys.argv[1])',
          'db.execute("BEGIN")',
          'for statement in json.load(sys.stdin): db.execute(statement)',
          'db.commit()',
          'print(json.dumps({"migrations":db.execute("SELECT count(*) FROM pilot_d1_migrations").fetchone()[0],"foreignKeys":db.execute("PRAGMA foreign_key_check").fetchall(),"tables":db.execute("SELECT name FROM sqlite_master WHERE type=\'table\' AND name LIKE \'pilot_%\'").fetchall()}))',
          'db.close()',
        ].join('\n'),
        path.join(directory, 'fresh.sqlite'),
      ],
      { input: JSON.stringify(statements), encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(applied.status, 0, applied.stderr);
    const evidence = JSON.parse(applied.stdout);
    assert.equal(evidence.migrations, 6);
    assert.deepEqual(evidence.foreignKeys, []);
    assert.equal(evidence.tables.length, 40);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
