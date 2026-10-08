import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertOwnedState } from './qa-helpers.mjs';
import { pilotMigrationFiles } from './readiness-worker-compat.mjs';

/** Administrative operations are local-only and require an owned state tree. */
export function localD1(manifest, { configPath, state, historicalSchema }) {
  const selectedFiles = pilotMigrationFiles(manifest, { historicalSchema });
  assertOwnedState(state);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].binding !== 'DB'
  ) {
    throw new Error('Pilot administration requires one explicit DB binding');
  }
  const work = fs.realpathSync(path.dirname(state));
  const configReal = fs.realpathSync(configPath);
  if (
    !configReal.startsWith(`${fs.realpathSync(manifest.snapshot)}${path.sep}`)
  ) {
    throw new Error('Config must belong to the frozen candidate');
  }
  const command = (args) => {
    const result = spawnSync(
      path.join(manifest.snapshot, 'node_modules/.bin/wrangler'),
      args,
      {
        cwd: manifest.snapshot,
        encoding: 'utf8',
        maxBuffer: 12_000_000,
        env: {
          ...process.env,
          CI: '1',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_WRITE_LOGS: 'false',
          WRANGLER_REGISTRY_PATH: path.join(work, 'registry'),
          WRANGLER_LOG_PATH: path.join(work, 'logs'),
        },
      },
    );
    // Wrangler can echo SQL in errors. Never forward it, since provisioning SQL
    // contains password hashes and audit data. The exit code is enough to stop.
    if (result.status !== 0)
      throw new Error(
        `Owned local D1 operation failed (exit ${result.status}); SQL output withheld`,
      );
    return result.stdout;
  };
  const query = (sql) => {
    const file = path.join(work, `pilot-sql-${crypto.randomUUID()}.sql`);
    fs.writeFileSync(file, sql, { mode: 0o600 });
    try {
      return JSON.parse(
        command([
          'd1',
          'execute',
          'DB',
          '--local',
          '--config',
          configPath,
          '--persist-to',
          state,
          '--file',
          file,
          '--json',
        ]),
      );
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  const migrate = () => {
    const sourceDirectory = path.join(manifest.snapshot, 'db/pilot-migrations');
    let directory = sourceDirectory;
    const files = selectedFiles;
    if (historicalSchema !== undefined) {
      directory = path.join(work, 'historical-r5-migrations');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        fs.realpathSync(directory) !== directory
      )
        throw new Error(
          'Historical migration directory must be owned regular storage',
        );
      const existing = fs.readdirSync(directory);
      if (existing.some((name) => !files.includes(name)))
        throw new Error('Unknown historical migration fixture file');
      for (const name of files) {
        const bytes = fs.readFileSync(path.join(sourceDirectory, name));
        const to = path.join(directory, name);
        if (
          fs.existsSync(to) &&
          (!fs.lstatSync(to).isFile() ||
            fs.lstatSync(to).isSymbolicLink() ||
            !fs.readFileSync(to).equals(bytes))
        )
          throw new Error('Historical migration fixture changed');
        if (!fs.existsSync(to))
          fs.writeFileSync(to, bytes, { mode: 0o600, flag: 'wx' });
      }
    }
    if (!files.length) throw new Error('Pilot migrations are missing');
    const checksums = files.map((name) => ({
      name,
      version: name.replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
      sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(directory, name)))
        .digest('hex'),
    }));
    query(
      'CREATE TABLE IF NOT EXISTS pilot_schema_history (version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);',
    );
    const recorded = query(
      'SELECT version, checksum FROM pilot_schema_history;',
    )[0].results;
    for (const previous of recorded) {
      if (
        !checksums.some(
          (file) =>
            file.version === previous.version &&
            file.sha256 === previous.checksum,
        )
      ) {
        throw new Error(
          'Previously applied pilot migration changed or is unknown',
        );
      }
    }
    const knownTables = query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pilot_d1_migrations';",
    )[0].results;
    if (knownTables.length) {
      const applied = query('SELECT name FROM pilot_d1_migrations;')[0].results;
      if (applied.some((row) => !files.includes(row.name)))
        throw new Error('Database has an unknown pilot migration');
      if (
        applied.some(
          (row) =>
            !recorded.some(
              (checksum) =>
                checksum.version ===
                checksums.find((file) => file.name === row.name)?.version,
            ),
        )
      ) {
        throw new Error(
          'Applied migration has no checksum; investigate interrupted migration before continuing',
        );
      }
    }
    const migrationConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const binding = migrationConfig.d1_databases[0];
    if (
      binding.migrations_dir !== directory ||
      binding.migrations_table !== 'pilot_d1_migrations'
    ) {
      binding.migrations_dir = directory;
      binding.migrations_table = 'pilot_d1_migrations';
      fs.writeFileSync(configPath, JSON.stringify(migrationConfig), {
        mode: 0o600,
      });
    }
    command([
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      configPath,
      '--persist-to',
      state,
    ]);
    const applied = query('SELECT name FROM pilot_d1_migrations;')[0].results;
    if (applied.length !== files.length)
      throw new Error('Not all pilot migrations were applied');
    const added = checksums.filter(
      (file) => !recorded.some((row) => row.version === file.version),
    );
    if (added.length)
      query(
        added
          .map(
            (file) =>
              `INSERT INTO pilot_schema_history(version,checksum,applied_at) VALUES(${sqlValue(file.version)},${sqlValue(file.sha256)},${Date.now()});`,
          )
          .join('\n'),
      );
    return checksums;
  };
  return { query, migrate };
}

export function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new Error('Unsupported SQL value');
  return `'${value.replaceAll("'", "''")}'`;
}
