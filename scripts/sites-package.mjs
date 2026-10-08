import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';

const JOURNAL_VERSION = '7';
const JOURNAL_DIALECT = 'sqlite';
const JOURNAL_EPOCH = 1_700_000_000_000;
const BREAKPOINT = '--> statement-breakpoint';
const SOURCE_MIGRATION_PATTERN = /^(\d{4})-(.+)\.sql$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_.]+$/;
const D1_TABLE = 'pilot_d1_migrations';
const SCHEMA_TABLE = 'pilot_schema_history';

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function quoteSql(value) {
  if (typeof value !== 'string') fail('SQL value must be a string');
  return `'${value.replaceAll("'", "''")}'`;
}

function readUtf8(file) {
  const bytes = fs.readFileSync(file);
  try {
    return {
      bytes,
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    fail(`Migration is not valid UTF-8: ${path.basename(file)}`);
  }
}

function splitCompleteStatements(source, label) {
  const helper = [
    'import json, sqlite3, sys',
    'source = sys.stdin.read()',
    'statements = []',
    'start = 0',
    'for index, character in enumerate(source):',
    "    if character != ';':",
    '        continue',
    '    candidate = source[start:index + 1]',
    '    if sqlite3.complete_statement(candidate):',
    '        statements.append(candidate)',
    '        start = index + 1',
    'tail = source[start:]',
    'if tail.strip():',
    '    if not sqlite3.complete_statement(tail):',
    '        raise SystemExit(2)',
    '    statements.append(tail)',
    'print(json.dumps(statements, ensure_ascii=False))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', helper], {
    input: source,
    encoding: 'utf8',
    maxBuffer: 20_000_000,
  });
  if (result.error?.code === 'ENOENT')
    fail('python3 is required to package pilot migrations');
  if (result.status !== 0)
    fail(`Migration has incomplete SQL statements: ${label}`);
  let statements;
  try {
    statements = JSON.parse(result.stdout);
  } catch {
    fail(`Migration statement parser failed: ${label}`);
  }
  if (
    !Array.isArray(statements) ||
    statements.some((statement) => typeof statement !== 'string')
  ) {
    fail(`Migration statement parser returned invalid data: ${label}`);
  }
  return statements;
}

function renderStatements(statements) {
  return statements
    .map((statement, index) => {
      const suffix = index === statements.length - 1 ? '' : `\n${BREAKPOINT}\n`;
      return `${statement}${suffix}`;
    })
    .join('');
}

function migrationVersion(index, description) {
  return `pilot-${description}-${String(index).padStart(4, '0')}`;
}

function migrationTag(index, description) {
  return `${String(index).padStart(4, '0')}_pilot_${description.replaceAll('-', '_')}_${String(index).padStart(4, '0')}`;
}

function readSourceMigrations(root) {
  const sourceDirectory = path.join(root, 'db', 'pilot-migrations');
  if (!fs.existsSync(sourceDirectory))
    fail('Pilot migration directory is missing');
  const names = fs
    .readdirSync(sourceDirectory)
    .filter((name) => SOURCE_MIGRATION_PATTERN.test(name))
    .sort();
  const supported = [
    '0000-auth.sql',
    '0001-data.sql',
    '0002-learning.sql',
    '0003-curriculum.sql',
    '0004-curriculum-runtime.sql',
    '0005-family-story.sql',
    '0006-collection-learning.sql',
    '0007-corpus-learning.sql',
  ];
  if (
    ![5, 6, 7, 8].includes(names.length) ||
    names.some((name, index) => name !== supported[index])
  )
    fail('Expected an exact supported pilot migration sequence');
  return names.map((sourceName, index) => {
    const match = SOURCE_MIGRATION_PATTERN.exec(sourceName);
    if (!match || Number(match[1]) !== index)
      fail('Pilot migration numbering is not contiguous');
    const sourcePath = path.join(sourceDirectory, sourceName);
    const { bytes, text } = readUtf8(sourcePath);
    const description = match[2];
    const sourceSha256 = crypto
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    const statements = splitCompleteStatements(text, sourceName);
    if (!statements.length) fail(`Pilot migration is empty: ${sourceName}`);
    return {
      index,
      sourceName,
      sourcePath,
      sourceSha256,
      description,
      version: migrationVersion(index, description),
      tag: migrationTag(index, description),
      statements,
    };
  });
}

function validateInitialFamily(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail('Initial family input must be an object');
  const expected = [
    'childName',
    'childUsername',
    'parentName',
    'parentUsername',
    'password',
  ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected.sort()[index])
  ) {
    fail('Initial family input has unexpected fields');
  }
  const cleanUsername = (field) => {
    const username = value[field];
    if (
      typeof username !== 'string' ||
      !USERNAME_PATTERN.test(username) ||
      username.length < 3 ||
      username.length > 30
    ) {
      fail(`Initial family ${field} is invalid`);
    }
    return username.toLowerCase();
  };
  const cleanName = (field) => {
    const name = value[field];
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 120)
      fail(`Initial family ${field} is invalid`);
    return name.trim();
  };
  const parentUsername = cleanUsername('parentUsername');
  const childUsername = cleanUsername('childUsername');
  if (parentUsername === childUsername)
    fail('Initial family usernames must be distinct');
  const password = value.password;
  if (
    typeof password !== 'string' ||
    password.length < 4 ||
    password.length > 128
  ) {
    fail('Initial family password is invalid');
  }
  return {
    parentUsername,
    parentName: cleanName('parentName'),
    childUsername,
    childName: cleanName('childName'),
    password,
  };
}

function privateId() {
  return crypto.randomUUID();
}

function d1MigrationRecord(migration) {
  return {
    name: migration.sourceName,
    version: migration.version,
    checksum: migration.sourceSha256,
  };
}

function bookkeepingStatements(migrations, currentIndex) {
  const statements = [
    `INSERT OR IGNORE INTO ${D1_TABLE}(name) VALUES(${quoteSql(migrations[currentIndex].sourceName)});`,
  ];
  if (currentIndex < 1) return statements;
  statements.push(
    ...migrations
      .slice(0, currentIndex + 1)
      .map(
        (migration) =>
          `INSERT OR IGNORE INTO ${SCHEMA_TABLE}(version,checksum,applied_at) VALUES(${quoteSql(migration.version)},${quoteSql(migration.sourceSha256)},CAST(strftime('%s','now') AS INTEGER) * 1000);`,
      ),
  );
  return statements;
}

function d1TableStatement() {
  return `CREATE TABLE IF NOT EXISTS ${D1_TABLE}(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
}

function ensureOutputDirectory(outputDirectory) {
  const drizzleDirectory = path.join(outputDirectory, '.openai', 'drizzle');
  fs.rmSync(drizzleDirectory, { recursive: true, force: true });
  const metaDirectory = path.join(drizzleDirectory, 'meta');
  fs.mkdirSync(metaDirectory, {
    recursive: true,
    mode: 0o700,
  });
  fs.chmodSync(path.join(outputDirectory, '.openai'), 0o700);
  fs.chmodSync(drizzleDirectory, 0o700);
  fs.chmodSync(metaDirectory, 0o700);
  return drizzleDirectory;
}

function writePrivateFile(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
}

function journalEntry(migration, index) {
  return {
    idx: index,
    version: '6',
    when: JOURNAL_EPOCH + index,
    tag: migration.tag,
    breakpoints: true,
  };
}

function buildInitialFamilyStatements(family) {
  const parentId = privateId();
  const childId = privateId();
  const parentAccountId = privateId();
  const childAccountId = privateId();
  const parentAuditId = privateId();
  const childAuditId = privateId();
  const linkAuditId = privateId();
  const parentHashPromise = hashPassword(family.password);
  const childHashPromise = hashPassword(family.password);
  return Promise.all([parentHashPromise, childHashPromise]).then(
    ([parentHash, childHash]) => {
      const now = Date.now();
      const values = [
        [
          parentId,
          family.parentName,
          `${parentId}@accounts.invalid`,
          family.parentUsername,
          'parent',
          parentHash,
        ],
        [
          childId,
          family.childName,
          `${childId}@accounts.invalid`,
          family.childUsername,
          'child',
          childHash,
        ],
      ];
      const guard = [
        `CREATE TABLE IF NOT EXISTS pilot_initial_family_guard(marker INTEGER PRIMARY KEY CHECK(marker=1));`,
        `CREATE TRIGGER IF NOT EXISTS pilot_initial_family_empty_guard BEFORE INSERT ON pilot_initial_family_guard WHEN EXISTS(SELECT 1 FROM pilot_auth_user) BEGIN SELECT RAISE(ABORT,'INITIAL_FAMILY_REQUIRES_EMPTY_DATABASE'); END;`,
        `INSERT INTO pilot_initial_family_guard(marker) VALUES(1);`,
        `DROP TRIGGER pilot_initial_family_empty_guard;`,
        `DROP TABLE pilot_initial_family_guard;`,
      ];
      const users = values
        .map(
          ([id, name, email, username, role]) =>
            `(${quoteSql(id)},${quoteSql(name)},${quoteSql(email)},0,${now},${now},${quoteSql(username)},${quoteSql(username)},${quoteSql(role)},0,0)`,
        )
        .join(',');
      const accounts = values
        .map(
          ([id], index) =>
            `(${quoteSql(index === 0 ? parentAccountId : childAccountId)},${quoteSql(id)},'credential',${quoteSql(id)},${quoteSql(values[index][5])},${now},${now})`,
        )
        .join(',');
      const audits = [
        `(${quoteSql(parentAuditId)},'local-provision',NULL,${quoteSql(parentId)},'${JSON.stringify({ role: 'parent' })}',${now})`,
        `(${quoteSql(childAuditId)},'local-provision',NULL,${quoteSql(childId)},'${JSON.stringify({ role: 'child' })}',${now})`,
        `(${quoteSql(linkAuditId)},'local-provision-link',${quoteSql(parentId)},${quoteSql(childId)},'${JSON.stringify({ relation: 'parent-child' })}',${now})`,
      ].join(',');
      return [
        ...guard,
        `INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES${users};`,
        `INSERT INTO pilot_auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES${accounts};`,
        `INSERT INTO pilot_parent_child(parent_id,child_id,created_at,created_by) VALUES(${quoteSql(parentId)},${quoteSql(childId)},${now},${quoteSql(parentId)});`,
        `INSERT INTO pilot_account_audit(id,action,actor_user_id,target_user_id,metadata,created_at) VALUES${audits};`,
      ];
    },
  );
}

function manifestFor(migrations, includeInitial) {
  return {
    format: 'little-hanzi-pilot-sites-migrations-1',
    sourceDirectory: 'db/pilot-migrations',
    migrations: migrations.map((migration) => ({
      index: migration.index,
      sourceName: migration.sourceName,
      version: migration.version,
      checksum: migration.sourceSha256,
      generatedName: `${migration.tag}.sql`,
      sourceStatementCount: migration.statements.length,
    })),
    bookkeeping: {
      d1Table: D1_TABLE,
      schemaTable: SCHEMA_TABLE,
      d1Rows: migrations.map(d1MigrationRecord),
      schemaRows: migrations.map(d1MigrationRecord),
    },
    initialFamily: includeInitial
      ? { migration: `${migrations.at(-1).tag}.sql`, accountCount: 2 }
      : null,
  };
}

/**
 * Build the private Sites migration package under `<outputDirectory>/.openai/drizzle`.
 * Source migrations are read byte-for-byte for their checksums and remain untouched.
 * `initialFamily` is intentionally accepted only in memory or from the CLI stdin path.
 */
export async function buildSitesMigrations({
  root = process.cwd(),
  outputDirectory = path.join(root, 'dist'),
  initialFamily,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outputDirectory);
  const family = validateInitialFamily(initialFamily);
  const migrations = readSourceMigrations(resolvedRoot);
  const drizzleDirectory = ensureOutputDirectory(resolvedOutput);
  const journalEntries = [];
  const initialStatements = family
    ? await buildInitialFamilyStatements(family)
    : [];
  for (const migration of migrations) {
    const generatedName = `${migration.tag}.sql`;
    const extraStatements =
      migration.index === migrations.length - 1 ? initialStatements : [];
    writePrivateFile(
      path.join(drizzleDirectory, generatedName),
      renderStatements([
        ...(migration.index === 0 ? [d1TableStatement()] : []),
        ...migration.statements,
        ...bookkeepingStatements(migrations, migration.index),
        ...extraStatements,
      ]),
    );
    journalEntries.push(journalEntry(migration, migration.index));
  }
  writePrivateFile(
    path.join(drizzleDirectory, 'meta', '_journal.json'),
    `${JSON.stringify({ version: JOURNAL_VERSION, dialect: JOURNAL_DIALECT, entries: journalEntries }, null, 2)}\n`,
  );
  const manifest = manifestFor(migrations, !!family);
  writePrivateFile(
    path.join(drizzleDirectory, 'meta', 'pilot-migrations.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    outputDirectory: resolvedOutput,
    drizzleDirectory,
    migrationCount: journalEntries.length,
    sourceMigrations: migrations.map((migration) => migration.sourceName),
    initialFamilyProvisioned: !!family,
    manifest,
  };
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
  return value;
}

async function runCli(argv) {
  const root = argumentValue(argv, '--root') ?? process.cwd();
  const output = argumentValue(argv, '--output') ?? path.join(root, 'dist');
  const initialFlag = argv.includes('--initial-family-stdin');
  const unexpected = argv.filter(
    (value, index) =>
      value.startsWith('--') &&
      !['--root', '--output', '--initial-family-stdin'].includes(value) &&
      argv[index - 1] !== '--root' &&
      argv[index - 1] !== '--output',
  );
  if (unexpected.length) fail('Unknown sites package option');
  let initialFamily;
  if (initialFlag) {
    let input;
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      fail('Initial family stdin is not valid JSON');
    }
    initialFamily = input;
  }
  const result = await buildSitesMigrations({
    root,
    outputDirectory: output,
    initialFamily,
  });
  process.stdout.write(
    `${JSON.stringify({
      outputDirectory: result.outputDirectory,
      drizzleDirectory: result.drizzleDirectory,
      migrationCount: result.migrationCount,
      sourceMigrations: result.sourceMigrations,
      initialFamilyProvisioned: result.initialFamilyProvisioned,
    })}\n`,
  );
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Sites package failed'}\n`,
    );
    process.exitCode = 1;
  });
}
