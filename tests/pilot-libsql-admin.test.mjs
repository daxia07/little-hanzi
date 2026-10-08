import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyPassword } from 'better-auth/crypto';
import { createClient } from '@libsql/client/node';

import { applyLibsqlMigrations } from '../scripts/pilot-libsql-admin.mjs';
import { legacyPilotRoot } from './helpers/legacy-pilot-root.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT = legacyPilotRoot(PROJECT_ROOT);

async function withDatabase(callback) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'little-hanzi-libsql-admin-'),
  );
  const client = createClient({
    url: `file:${path.join(directory, 'pilot.sqlite')}`,
  });
  try {
    return await callback({ client, directory });
  } finally {
    await Promise.resolve(client.close?.());
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function rows(client, sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows;
}

const FAMILY = {
  parentUsername: 'parent_test',
  parentName: 'Parent Test',
  childUsername: 'child_test',
  childName: 'Child Test',
  password: 'seed',
};

await test('[V-AC-003] applies all unchanged pilot migrations to a fresh libSQL file', async () => {
  await withDatabase(async ({ client }) => {
    const result = await applyLibsqlMigrations({ client, root: ROOT });
    assert.equal(result.status, 'applied');
    assert.equal(result.migrationCount, 5);
    assert.deepEqual(
      (
        await rows(client, 'SELECT name FROM pilot_d1_migrations ORDER BY id')
      ).map((row) => row.name),
      [
        '0000-auth.sql',
        '0001-data.sql',
        '0002-learning.sql',
        '0003-curriculum.sql',
        '0004-curriculum-runtime.sql',
      ],
    );
    assert.equal(
      (
        await rows(client, 'SELECT COUNT(*) AS count FROM pilot_schema_history')
      )[0].count,
      5,
    );
    assert.equal(
      (await rows(client, 'SELECT COUNT(*) AS count FROM pilot_auth_user'))[0]
        .count,
      0,
    );
    assert.equal(
      (
        await rows(
          client,
          'SELECT COUNT(*) AS count FROM pilot_learning_release',
        )
      )[0].count,
      0,
    );
  });
});

await test('[V-AC-003] repeats without provisioning and preserves existing data', async () => {
  await withDatabase(async ({ client }) => {
    await applyLibsqlMigrations({ client, root: ROOT });
    await client.execute({
      sql: 'UPDATE pilot_installation SET installation_id=? WHERE id=1',
      args: ['preserved-installation'],
    });
    const result = await applyLibsqlMigrations({ client, root: ROOT });
    assert.equal(result.status, 'unchanged');
    assert.equal(
      (
        await rows(
          client,
          'SELECT installation_id FROM pilot_installation WHERE id=1',
        )
      )[0].installation_id,
      'preserved-installation',
    );
  });
});

await test('[V-AC-003] provisions exactly one linked parent and child with maintained hashes', async () => {
  await withDatabase(async ({ client }) => {
    const result = await applyLibsqlMigrations({
      client,
      root: ROOT,
      initialFamily: FAMILY,
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.initialFamilyProvisioned, true);
    const users = await rows(
      client,
      'SELECT id,username,name,role,must_change_password,disabled FROM pilot_auth_user ORDER BY username',
    );
    assert.deepEqual(
      users.map(({ username, name, role, must_change_password, disabled }) => ({
        username,
        name,
        role,
        must_change_password,
        disabled,
      })),
      [
        {
          username: 'child_test',
          name: 'Child Test',
          role: 'child',
          must_change_password: 0,
          disabled: 0,
        },
        {
          username: 'parent_test',
          name: 'Parent Test',
          role: 'parent',
          must_change_password: 0,
          disabled: 0,
        },
      ],
    );
    const accounts = await rows(
      client,
      'SELECT username,password FROM pilot_auth_user JOIN pilot_auth_account ON pilot_auth_account.user_id=pilot_auth_user.id ORDER BY username',
    );
    assert.equal(accounts.length, 2);
    for (const account of accounts)
      assert.equal(
        await verifyPassword({
          hash: account.password,
          password: FAMILY.password,
        }),
        true,
      );
    assert.deepEqual(
      await rows(
        client,
        'SELECT p.username AS parent,c.username AS child FROM pilot_parent_child link JOIN pilot_auth_user p ON p.id=link.parent_id JOIN pilot_auth_user c ON c.id=link.child_id',
      ),
      [{ parent: 'parent_test', child: 'child_test' }],
    );
    assert.equal(
      (await rows(client, 'SELECT COUNT(*) AS count FROM pilot_onboarding'))[0]
        .count,
      0,
    );
    assert.equal(
      (
        await rows(
          client,
          'SELECT COUNT(*) AS count FROM pilot_learning_release',
        )
      )[0].count,
      0,
    );
  });
});

await test('[V-AC-003] refuses checksum drift before any pending write', async () => {
  await withDatabase(async ({ client }) => {
    await applyLibsqlMigrations({ client, root: ROOT });
    await client.execute({
      sql: "UPDATE pilot_schema_history SET checksum='wrong' WHERE version='pilot-auth-0000'",
      args: [],
    });
    await assert.rejects(
      applyLibsqlMigrations({ client, root: ROOT }),
      /MIGRATION_HISTORY_DRIFT|checksum/i,
    );
    assert.equal(
      (await rows(client, 'SELECT COUNT(*) AS count FROM pilot_auth_user'))[0]
        .count,
      0,
    );
  });
});

await test('[V-AC-003] refuses initial family input on an already migrated account database', async () => {
  await withDatabase(async ({ client }) => {
    await applyLibsqlMigrations({ client, root: ROOT });
    await client.execute({
      sql: 'INSERT INTO pilot_auth_user(id,name,email,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,?,?,?,?,?,?,?)',
      args: [
        'existing',
        'Existing',
        'existing@accounts.invalid',
        1,
        1,
        'existing',
        'existing',
        'parent',
        0,
        0,
      ],
    });
    await assert.rejects(
      applyLibsqlMigrations({ client, root: ROOT, initialFamily: FAMILY }),
      /INITIAL_FAMILY_REQUIRES_(FRESH|EMPTY)_DATABASE|account/i,
    );
    assert.deepEqual(
      (
        await rows(
          client,
          'SELECT id,username FROM pilot_auth_user ORDER BY id',
        )
      ).map((row) => [row.id, row.username]),
      [['existing', 'existing']],
    );
  });
});

await test('[V-AC-003] refuses an unrelated table before creating any pilot schema', async () => {
  await withDatabase(async ({ client }) => {
    await client.execute({
      sql: 'CREATE TABLE unrelated (id INTEGER PRIMARY KEY)',
      args: [],
    });
    await assert.rejects(
      applyLibsqlMigrations({ client, root: ROOT }),
      /UNKNOWN_SCHEMA_OBJECT|unrelated/i,
    );
    assert.equal(
      (
        await rows(
          client,
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='pilot_auth_user'",
        )
      )[0].count,
      0,
    );
  });
});

await test('[V-AC-002] rolls back every migration statement when the atomic write batch fails', async () => {
  await withDatabase(async ({ client }) => {
    let mode;
    const failingClient = {
      execute: client.execute.bind(client),
      async batch(statements, requestedMode) {
        mode = requestedMode;
        const changed = [...statements];
        changed[changed.length - 1] = { sql: 'THIS IS NOT SQL', args: [] };
        return client.batch(changed, requestedMode);
      },
    };
    await assert.rejects(
      applyLibsqlMigrations({ client: failingClient, root: ROOT }),
      /syntax|SQL|near/i,
    );
    assert.equal(mode, 'write');
    assert.equal(
      (
        await rows(
          client,
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='pilot_auth_user'",
        )
      )[0].count,
      0,
    );
    assert.equal(
      (
        await rows(
          client,
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name='pilot_d1_migrations'",
        )
      )[0].count,
      0,
    );
  });
});

await test('[V-AC-003] CLI accepts the database URL and private family JSON without exposing the password', async () => {
  const candidateRoot = PROJECT_ROOT;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'little-hanzi-libsql-cli-'),
  );
  const databaseUrl = `file:${path.join(directory, 'pilot.sqlite')}`;
  const script = path.join(candidateRoot, 'scripts', 'pilot-libsql-admin.mjs');
  try {
    const first = spawnSync(
      process.execPath,
      [script, '--root', ROOT, '--url', databaseUrl, '--initial-family-stdin'],
      {
        cwd: candidateRoot,
        input: JSON.stringify(FAMILY),
        encoding: 'utf8',
        maxBuffer: 20_000_000,
      },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.includes(FAMILY.password), false);
    assert.equal(first.stderr.includes(FAMILY.password), false);
    assert.equal(JSON.parse(first.stdout).initialFamilyProvisioned, true);

    const repeat = spawnSync(
      process.execPath,
      [script, '--root', ROOT, '--url', databaseUrl],
      { cwd: candidateRoot, encoding: 'utf8', maxBuffer: 20_000_000 },
    );
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).status, 'unchanged');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
