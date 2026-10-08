import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSitesMigrations } from './sites-package.mjs';

const BREAKPOINT = '--> statement-breakpoint';
const SOURCE_MIGRATIONS = [
  '0000-auth.sql',
  '0001-data.sql',
  '0002-learning.sql',
  '0003-curriculum.sql',
  '0004-curriculum-runtime.sql',
  '0005-family-story.sql',
  '0006-collection-learning.sql',
  '0007-corpus-learning.sql',
];
const INTERNAL_NAME = /^sqlite_/i;
const MIGRATION_FILE_PATTERN = /^\d{4}_.*\.sql$/;

function fail(message) {
  throw new Error(message);
}

function clientMethods(value) {
  if (!value || typeof value !== 'object') fail('LIBSQL_CLIENT_REQUIRED');
  if (
    typeof value.execute !== 'function' ||
    typeof value.batch !== 'function'
  ) {
    fail('LIBSQL_CLIENT_REQUIRED');
  }
  return value;
}

function statement(sql, args = []) {
  return { sql, args };
}

async function execute(client, sql, args = []) {
  return client.execute(statement(sql, args));
}

function resultRows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function rowValue(row, name, index) {
  if (
    row &&
    typeof row === 'object' &&
    Object.prototype.hasOwnProperty.call(row, name)
  )
    return row[name];
  return row?.[index];
}

function sqlIdentifier(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeSql(sql) {
  return String(sql ?? '')
    .replaceAll(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
    .trim()
    .toLowerCase();
}

function expectedSchemaObjects(drizzleDirectory) {
  const expected = new Map();
  const names = fs
    .readdirSync(drizzleDirectory)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();
  for (const name of names) {
    const source = fs.readFileSync(path.join(drizzleDirectory, name), 'utf8');
    for (const part of source.split(BREAKPOINT)) {
      const match = part.match(
        /\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?(?=\s|\()/i,
      );
      if (!match) continue;
      const type = match[1].toLowerCase();
      const objectName = match[2];
      expected.set(`${type}:${objectName}`, normalizeSql(part));
    }
  }
  if (
    !expected.has('table:pilot_auth_user') ||
    !expected.has('table:pilot_d1_migrations')
  ) {
    fail('PILOT_SCHEMA_PACKAGE_INVALID');
  }
  return expected;
}

function existingSchemaObjects(rows) {
  const objects = new Map();
  for (const row of rows) {
    const name = sqlIdentifier(rowValue(row, 'name', 0));
    const type = sqlIdentifier(rowValue(row, 'type', 1)).toLowerCase();
    const sql = rowValue(row, 'sql', 2);
    if (!name || INTERNAL_NAME.test(name) || name.startsWith('libsql_'))
      continue;
    objects.set(`${type}:${name}`, normalizeSql(sql));
  }
  return objects;
}

function compareSchema(expected, actual) {
  for (const name of actual.keys()) {
    if (!expected.has(name)) fail(`UNKNOWN_SCHEMA_OBJECT:${name}`);
  }
  for (const [name, sql] of expected) {
    if (!actual.has(name)) fail(`SCHEMA_INCOMPLETE:${name}`);
    if (actual.get(name) !== sql) fail(`SCHEMA_DRIFT:${name}`);
  }
}

function expectedLedger(manifest) {
  const migrations = manifest?.migrations;
  const bookkeeping = manifest?.bookkeeping;
  if (
    !Array.isArray(migrations) ||
    ![5, 6, 7, 8].includes(migrations.length) ||
    migrations.some(
      (migration, index) => migration.sourceName !== SOURCE_MIGRATIONS[index],
    ) ||
    !bookkeeping
  ) {
    fail('PILOT_SCHEMA_PACKAGE_INVALID');
  }
  const names = migrations.map((migration) => migration.sourceName);
  const versions = migrations.map((migration) => migration.version);
  const checksums = migrations.map((migration) => migration.checksum);
  if (
    new Set(names).size !== names.length ||
    new Set(versions).size !== versions.length
  ) {
    fail('PILOT_SCHEMA_PACKAGE_INVALID');
  }
  return {
    d1: names,
    schema: versions
      .map((version, index) => ({ version, checksum: checksums[index] }))
      .sort((left, right) => left.version.localeCompare(right.version)),
  };
}

function rowsMatch(expected, actual, fields) {
  if (expected.length !== actual.length) return false;
  return expected.every((item, index) =>
    fields.every(
      (field, fieldIndex) =>
        rowValue(actual[index], field, fieldIndex) === item[field],
    ),
  );
}

async function inspectInstallation(
  client,
  manifest,
  drizzleDirectory,
  initialFamily,
) {
  const expected = expectedSchemaObjects(drizzleDirectory);
  const ledger = expectedLedger(manifest);
  const schemaResult = await execute(
    client,
    "SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY name",
  );
  const actual = existingSchemaObjects(resultRows(schemaResult));
  if (actual.size === 0) return { status: 'fresh', ledger };
  compareSchema(expected, actual);

  const d1RowsResult = await execute(
    client,
    'SELECT name FROM pilot_d1_migrations ORDER BY id',
  );
  const schemaRowsResult = await execute(
    client,
    'SELECT version,checksum FROM pilot_schema_history ORDER BY version',
  );
  const d1Rows = resultRows(d1RowsResult);
  const schemaRows = resultRows(schemaRowsResult);
  if (
    !rowsMatch(
      ledger.d1.map((name) => ({ name })),
      d1Rows,
      ['name'],
    ) ||
    !rowsMatch(ledger.schema, schemaRows, ['version', 'checksum'])
  ) {
    fail('MIGRATION_HISTORY_DRIFT');
  }
  if (initialFamily) {
    const accountRows = await execute(
      client,
      'SELECT COUNT(*) AS count FROM pilot_auth_user',
    );
    const count = Number(rowValue(resultRows(accountRows)[0], 'count', 0) ?? 0);
    fail(
      count > 0
        ? 'INITIAL_FAMILY_REQUIRES_EMPTY_DATABASE'
        : 'INITIAL_FAMILY_REQUIRES_FRESH_DATABASE',
    );
  }
  return { status: 'unchanged', ledger };
}

function readMigrationStatements(drizzleDirectory) {
  return fs
    .readdirSync(drizzleDirectory)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort()
    .flatMap((name) =>
      fs
        .readFileSync(path.join(drizzleDirectory, name), 'utf8')
        .split(BREAKPOINT)
        .map((sql) => sql.trim())
        .filter(Boolean),
    );
}

async function buildPackage(root, outputDirectory, initialFamily) {
  return buildSitesMigrations({ root, outputDirectory, initialFamily });
}

/**
 * Apply the unchanged pilot migrations through one atomic libSQL write batch.
 * The optional initial family is accepted only when the target is entirely fresh.
 */
export async function applyLibsqlMigrations({
  client: rawClient,
  root = process.cwd(),
  initialFamily,
} = {}) {
  const client = clientMethods(rawClient);
  const resolvedRoot = path.resolve(root);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'little-hanzi-libsql-admin-'),
  );
  try {
    const basePackage = await buildPackage(
      resolvedRoot,
      path.join(temporaryDirectory, 'base'),
    );
    const inspection = await inspectInstallation(
      client,
      basePackage.manifest,
      basePackage.drizzleDirectory,
      initialFamily,
    );
    if (inspection.status === 'unchanged') {
      return {
        status: 'unchanged',
        migrationCount: basePackage.manifest.migrations.length,
        sourceMigrations: basePackage.sourceMigrations,
        initialFamilyProvisioned: false,
        checksums: basePackage.manifest.migrations.map(
          (migration) => migration.checksum,
        ),
      };
    }
    const packageResult = initialFamily
      ? await buildPackage(
          resolvedRoot,
          path.join(temporaryDirectory, 'initial'),
          initialFamily,
        )
      : basePackage;
    const statements = readMigrationStatements(
      packageResult.drizzleDirectory,
    ).map((sql) => statement(sql));
    if (!statements.length) fail('PILOT_SCHEMA_PACKAGE_INVALID');
    await client.batch(statements, 'write');
    return {
      status: 'applied',
      migrationCount: basePackage.manifest.migrations.length,
      sourceMigrations: packageResult.sourceMigrations,
      initialFamilyProvisioned: !!initialFamily,
      checksums: packageResult.manifest.migrations.map(
        (migration) => migration.checksum,
      ),
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag}_REQUIRES_VALUE`);
  return value;
}

async function loadLibsqlClient() {
  try {
    return await import('@libsql/client/node');
  } catch {
    fail('LIBSQL_CLIENT_UNAVAILABLE');
  }
}

async function runCli(argv) {
  const root = argumentValue(argv, '--root') ?? process.cwd();
  const url = argumentValue(argv, '--url') ?? process.env.HANZI_DATABASE_URL;
  if (!url) fail('DATABASE_URL_REQUIRED');
  const initialFlag = argv.includes('--initial-family-stdin');
  const allowed = new Set(['--root', '--url', '--initial-family-stdin']);
  const unknown = argv.filter(
    (value, index) =>
      value.startsWith('--') &&
      !allowed.has(value) &&
      argv[index - 1] !== '--root' &&
      argv[index - 1] !== '--url',
  );
  if (unknown.length) fail('UNKNOWN_OPTION');
  let initialFamily;
  if (initialFlag) {
    try {
      initialFamily = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      fail('INITIAL_FAMILY_JSON_INVALID');
    }
  }
  const { createClient } = await loadLibsqlClient();
  const client = createClient({
    url,
    authToken: process.env.HANZI_DATABASE_AUTH_TOKEN,
    intMode: 'number',
  });
  try {
    const result = await applyLibsqlMigrations({ client, root, initialFamily });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await Promise.resolve(client.close?.());
  }
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'LIBSQL_ADMIN_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
}
