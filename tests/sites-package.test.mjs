import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { verifyPassword } from 'better-auth/crypto';
import { buildSitesMigrations } from '../scripts/sites-package.mjs';
import { legacyPilotRoot } from './helpers/legacy-pilot-root.mjs';

const PROJECT_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ROOT = legacyPilotRoot(PROJECT_ROOT);
const BREAKPOINT = '--> statement-breakpoint';

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'little-hanzi-sites-package-'));
}

function packagePaths(directory) {
  const drizzle = path.join(directory, '.openai', 'drizzle');
  return {
    drizzle,
    journal: path.join(drizzle, 'meta', '_journal.json'),
    manifest: path.join(drizzle, 'meta', 'pilot-migrations.json'),
  };
}

function migrationFiles(drizzle) {
  return fs
    .readdirSync(drizzle)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function executeMigrations(database, migrations) {
  const helper = [
    'import json, sqlite3, sys',
    'connection = sqlite3.connect(sys.argv[1])',
    'try:',
    '    for migration in json.load(sys.stdin):',
    '        connection.execute("BEGIN")',
    '        for statement in migration:',
    '            connection.execute(statement)',
    '        connection.commit()',
    'except sqlite3.Error:',
    '    connection.rollback()',
    '    raise SystemExit(1)',
    'finally:',
    '    connection.close()',
  ].join('\n');
  return spawnSync('python3', ['-c', helper, database], {
    input: JSON.stringify(migrations),
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
}

function sqlite(directory, sql) {
  const database = path.join(directory, `${crypto.randomUUID()}.sqlite`);
  const migrations = (Array.isArray(sql) ? sql : [sql]).map((migration) =>
    Array.isArray(migration) ? migration : [migration],
  );
  const result = executeMigrations(database, migrations);
  assert.equal(
    result.status,
    0,
    'Each packaged SQL unit must execute separately',
  );
  return { database };
}

function sqliteExpectFailure(directory, database, sql) {
  const statements = Array.isArray(sql) ? sql : [sql];
  const result = executeMigrations(database, [statements]);
  assert.notEqual(result.status, 0, 'the existing-account guard must fail');
  assert.deepEqual(
    query(
      directory,
      database,
      "SELECT name FROM sqlite_master WHERE name LIKE 'pilot_initial_family%';",
    ),
    [],
    'Guard DDL rolls back with a failed migration',
  );
  return result;
}

function query(directory, database, sql) {
  const result = spawnSync('sqlite3', ['-batch', '-json', database], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function packageScripts(paths) {
  return migrationFiles(paths.drizzle).map((name) =>
    fs.readFileSync(path.join(paths.drizzle, name), 'utf8').split(BREAKPOINT),
  );
}

test('[H-AC-002] builds a reproducible Drizzle journal from all five pilot migrations', async () => {
  const first = temporaryDirectory();
  const second = temporaryDirectory();
  const firstResult = await buildSitesMigrations({
    root: ROOT,
    outputDirectory: first,
  });
  await buildSitesMigrations({
    root: ROOT,
    outputDirectory: second,
  });
  const firstPaths = packagePaths(first);
  const secondPaths = packagePaths(second);

  assert.equal(firstResult.migrationCount, 5);
  assert.deepEqual(migrationFiles(firstPaths.drizzle), [
    '0000_pilot_auth_0000.sql',
    '0001_pilot_data_0001.sql',
    '0002_pilot_learning_0002.sql',
    '0003_pilot_curriculum_0003.sql',
    '0004_pilot_curriculum_runtime_0004.sql',
  ]);
  const journal = JSON.parse(fs.readFileSync(firstPaths.journal, 'utf8'));
  assert.deepEqual(journal, {
    version: '7',
    dialect: 'sqlite',
    entries: [
      {
        idx: 0,
        version: '6',
        when: 1700000000000,
        tag: '0000_pilot_auth_0000',
        breakpoints: true,
      },
      {
        idx: 1,
        version: '6',
        when: 1700000000001,
        tag: '0001_pilot_data_0001',
        breakpoints: true,
      },
      {
        idx: 2,
        version: '6',
        when: 1700000000002,
        tag: '0002_pilot_learning_0002',
        breakpoints: true,
      },
      {
        idx: 3,
        version: '6',
        when: 1700000000003,
        tag: '0003_pilot_curriculum_0003',
        breakpoints: true,
      },
      {
        idx: 4,
        version: '6',
        when: 1700000000004,
        tag: '0004_pilot_curriculum_runtime_0004',
        breakpoints: true,
      },
    ],
  });
  const manifest = JSON.parse(fs.readFileSync(firstPaths.manifest, 'utf8'));
  assert.deepEqual(
    manifest.migrations.map(({ sourceName, version }) => ({
      sourceName,
      version,
    })),
    [
      { sourceName: '0000-auth.sql', version: 'pilot-auth-0000' },
      { sourceName: '0001-data.sql', version: 'pilot-data-0001' },
      { sourceName: '0002-learning.sql', version: 'pilot-learning-0002' },
      { sourceName: '0003-curriculum.sql', version: 'pilot-curriculum-0003' },
      {
        sourceName: '0004-curriculum-runtime.sql',
        version: 'pilot-curriculum-runtime-0004',
      },
    ],
  );
  assert.equal(manifest.bookkeeping.d1Table, 'pilot_d1_migrations');
  assert.equal(manifest.bookkeeping.schemaTable, 'pilot_schema_history');
  assert.equal(manifest.bookkeeping.d1Rows.length, 5);
  assert.equal(manifest.bookkeeping.schemaRows.length, 5);
  assert.deepEqual(
    fs.readdirSync(path.join(firstPaths.drizzle, 'meta')).sort(),
    ['_journal.json', 'pilot-migrations.json'],
  );

  for (const name of migrationFiles(firstPaths.drizzle)) {
    const text = fs.readFileSync(path.join(firstPaths.drizzle, name), 'utf8');
    assert.match(text, /--> statement-breakpoint/);
    assert.ok(text.includes('CREATE TABLE'), name);
  }
  assert.deepEqual(
    migrationFiles(firstPaths.drizzle).map((name) =>
      fs.readFileSync(path.join(firstPaths.drizzle, name)),
    ),
    migrationFiles(secondPaths.drizzle).map((name) =>
      fs.readFileSync(path.join(secondPaths.drizzle, name)),
    ),
    'without initial data, package bytes should be reproducible',
  );
  assert.equal(
    fs
      .readFileSync(
        path.join(ROOT, 'db/pilot-migrations/0004-curriculum-runtime.sql'),
        'utf8',
      )
      .includes(BREAKPOINT),
    false,
  );
});

test('[H-AC-002] executes complete generated statements, including trigger bodies, and records both ledgers', async () => {
  const directory = temporaryDirectory();
  await buildSitesMigrations({ root: ROOT, outputDirectory: directory });
  const paths = packagePaths(directory);
  const { database } = sqlite(directory, packageScripts(paths));
  const objects = query(
    directory,
    database,
    `
    SELECT 'table' AS kind, name FROM sqlite_master WHERE type='table' AND name LIKE 'pilot_%'
    UNION ALL
    SELECT 'trigger' AS kind, name FROM sqlite_master WHERE type='trigger' AND name LIKE 'pilot_curriculum_runtime_%'
    ORDER BY kind, name;
  `,
  );
  assert.ok(objects.some((row) => row.name === 'pilot_curriculum_runtime_run'));
  assert.ok(
    objects.some(
      (row) => row.name === 'pilot_curriculum_runtime_run_no_identity_update',
    ),
  );
  const history = query(
    directory,
    database,
    'SELECT version, checksum FROM pilot_schema_history ORDER BY version;',
  );
  assert.equal(history.length, 5);
  const applied = query(
    directory,
    database,
    'SELECT name FROM pilot_d1_migrations ORDER BY id;',
  );
  assert.equal(applied.length, 5);
});

test('[H-AC-003] creates exactly one linked parent and child with Better Auth hashes in a private migration', async () => {
  const directory = temporaryDirectory();
  const family = {
    parentUsername: 'parent_test',
    parentName: 'Parent Test',
    childUsername: 'child_test',
    childName: 'Child Test',
    password: 'seed',
  };
  const result = await buildSitesMigrations({
    root: ROOT,
    outputDirectory: directory,
    initialFamily: family,
  });
  const paths = packagePaths(directory);
  assert.equal(result.migrationCount, 5);
  const initialFile = path.join(
    paths.drizzle,
    '0004_pilot_curriculum_runtime_0004.sql',
  );
  const initialSql = fs.readFileSync(initialFile, 'utf8');
  assert.equal(initialSql.includes(family.password), false);
  assert.equal(JSON.stringify(result).includes(family.password), false);
  const { database } = sqlite(directory, packageScripts(paths));
  const users = query(
    directory,
    database,
    `
    SELECT id, username, name, role, must_change_password, disabled FROM pilot_auth_user ORDER BY username;
  `,
  );
  assert.deepEqual(
    users.map(({ username, role, must_change_password, disabled }) => ({
      username,
      role,
      must_change_password,
      disabled,
    })),
    [
      {
        username: 'child_test',
        role: 'child',
        must_change_password: 0,
        disabled: 0,
      },
      {
        username: 'parent_test',
        role: 'parent',
        must_change_password: 0,
        disabled: 0,
      },
    ],
  );
  assert.equal(users.length, 2);
  const hashes = query(
    directory,
    database,
    'SELECT username, password FROM pilot_auth_user JOIN pilot_auth_account ON pilot_auth_account.user_id = pilot_auth_user.id ORDER BY username;',
  );
  assert.equal(hashes.length, 2);
  for (const row of hashes)
    assert.equal(
      await verifyPassword({ hash: row.password, password: family.password }),
      true,
    );
  const links = query(
    directory,
    database,
    'SELECT p.username AS parent, c.username AS child FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user c ON c.id=l.child_id;',
  );
  assert.deepEqual(links, [{ parent: 'parent_test', child: 'child_test' }]);
  assert.equal(
    query(
      directory,
      database,
      'SELECT COUNT(*) AS count FROM pilot_onboarding;',
    )[0].count,
    0,
  );
  assert.equal(
    query(
      directory,
      database,
      'SELECT COUNT(*) AS count FROM pilot_learning_release;',
    )[0].count,
    0,
  );
});

test('[H-AC-003] refuses initial provisioning over an existing account database before adding users', async () => {
  const directory = temporaryDirectory();
  const family = {
    parentUsername: 'parent_test',
    parentName: 'Parent Test',
    childUsername: 'child_test',
    childName: 'Child Test',
    password: 'seed',
  };
  await buildSitesMigrations({ root: ROOT, outputDirectory: directory });
  const paths = packagePaths(directory);
  const { database } = sqlite(directory, [
    ...packageScripts(paths),
    `INSERT INTO pilot_auth_user(id,name,email,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES ('existing','Existing','existing@accounts.invalid',1,1,'existing','existing','parent',0,0);`,
  ]);
  const initialDirectory = temporaryDirectory();
  await buildSitesMigrations({
    root: ROOT,
    outputDirectory: initialDirectory,
    initialFamily: family,
  });
  const initial = fs.readFileSync(
    path.join(
      packagePaths(initialDirectory).drizzle,
      '0004_pilot_curriculum_runtime_0004.sql',
    ),
    'utf8',
  );
  sqliteExpectFailure(directory, database, initial.split(BREAKPOINT));
  assert.equal(
    query(
      directory,
      database,
      'SELECT COUNT(*) AS count FROM pilot_auth_user;',
    )[0].count,
    1,
  );
  assert.equal(
    query(
      directory,
      database,
      'SELECT COUNT(*) AS count FROM pilot_parent_child;',
    )[0].count,
    0,
  );
});

test('[H-AC-002] CLI reads private initial-family JSON from stdin and prints metadata only', async () => {
  const directory = temporaryDirectory();
  const result = spawnSync(
    process.execPath,
    ['scripts/sites-package.mjs', '--root', ROOT, '--output', directory],
    { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 20_000_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    outputDirectory: directory,
    drizzleDirectory: path.join(directory, '.openai', 'drizzle'),
    migrationCount: 5,
    sourceMigrations: [
      '0000-auth.sql',
      '0001-data.sql',
      '0002-learning.sql',
      '0003-curriculum.sql',
      '0004-curriculum-runtime.sql',
    ],
    initialFamilyProvisioned: false,
  });

  const privateDirectory = temporaryDirectory();
  const family = {
    parentUsername: 'parent_test',
    parentName: 'Parent Test',
    childUsername: 'child_test',
    childName: 'Child Test',
    password: 'seed',
  };
  const privateResult = spawnSync(
    process.execPath,
    [
      'scripts/sites-package.mjs',
      '--root',
      ROOT,
      '--output',
      privateDirectory,
      '--initial-family-stdin',
    ],
    {
      cwd: PROJECT_ROOT,
      input: JSON.stringify(family),
      encoding: 'utf8',
      maxBuffer: 20_000_000,
    },
  );
  assert.equal(privateResult.status, 0, privateResult.stderr);
  assert.equal(privateResult.stdout.includes(family.password), false);
  assert.equal(JSON.parse(privateResult.stdout).initialFamilyProvisioned, true);
  assert.equal(
    fs
      .readFileSync(
        path.join(
          privateDirectory,
          '.openai',
          'drizzle',
          '0004_pilot_curriculum_runtime_0004.sql',
        ),
        'utf8',
      )
      .includes(family.password),
    false,
  );
});
