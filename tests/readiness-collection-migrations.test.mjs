import { legacyCollectionRoot } from './helpers/legacy-pilot-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pilotBackupFormatForCandidate } from '../scripts/pilot-backup.mjs';
import { buildSitesMigrations } from '../scripts/sites-package.mjs';

const project = path.resolve(import.meta.dirname, '..');
const names = [
  '0000-auth.sql',
  '0001-data.sql',
  '0002-learning.sql',
  '0003-curriculum.sql',
  '0004-curriculum-runtime.sql',
  '0005-family-story.sql',
  '0006-collection-learning.sql',
];

test('[R5-E-012] the explicit seven-migration format is v5; six remains v4 and unknown successors refuse', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hanzi-collection-format-'),
  );
  const directory = path.join(root, 'db/pilot-migrations');
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (const name of names.slice(0, 6))
      fs.copyFileSync(
        path.join(project, 'db/pilot-migrations', name),
        path.join(directory, name),
      );
    assert.equal(
      pilotBackupFormatForCandidate({ snapshot: root }),
      'pilot-admin-backup-4',
    );
    fs.copyFileSync(
      path.join(project, 'db/pilot-migrations', names[6]),
      path.join(directory, names[6]),
    );
    assert.equal(
      pilotBackupFormatForCandidate({ snapshot: root }),
      'pilot-admin-backup-5',
    );
    fs.writeFileSync(path.join(directory, '0007-unknown.sql'), 'SELECT 1;');
    assert.throws(
      () => pilotBackupFormatForCandidate({ snapshot: root }),
      (error) => error.code === 'BACKUP_VERSION_INCOMPATIBLE',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('[R5-E-012] the additive packaged migration retains old bookkeeping and adds ten collection tables', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-collection-schema-'),
  );
  try {
    const packaged = await buildSitesMigrations({
      root: legacyCollectionRoot(project),
      outputDirectory: directory,
    });
    assert.equal(packaged.migrationCount, 7);
    assert.deepEqual(packaged.sourceMigrations, names);
    const statements = fs
      .readdirSync(packaged.drizzleDirectory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()
      .flatMap((name) =>
        fs
          .readFileSync(path.join(packaged.drizzleDirectory, name), 'utf8')
          .split('--> statement-breakpoint'),
      );
    const checked = spawnSync(
      'python3',
      [
        '-c',
        [
          'import sqlite3,json,sys',
          'db=sqlite3.connect(":memory:")',
          'db.execute("BEGIN")',
          'for statement in json.load(sys.stdin): db.execute(statement)',
          'db.commit()',
          'print(json.dumps({"migrations":db.execute("SELECT count(*) FROM pilot_d1_migrations").fetchone()[0],"foreignKeys":db.execute("PRAGMA foreign_key_check").fetchall(),"tables":db.execute("SELECT name FROM sqlite_master WHERE type=\'table\' AND name LIKE \'pilot_%\'").fetchall(),"collections":db.execute("SELECT name FROM sqlite_master WHERE type=\'table\' AND name LIKE \'pilot_collection%\'").fetchall()}))',
          'db.close()',
        ].join('\n'),
      ],
      { input: JSON.stringify(statements), encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(checked.status, 0, checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.equal(result.migrations, 7);
    assert.equal(result.tables.length, 50);
    assert.equal(result.collections.length, 10);
    assert.deepEqual(result.foreignKeys, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
