/** Private operations capture/restore; no HTTP route and no fabricated QA manifest. */
import crypto from 'node:crypto';
import {
  OPS_TABLES,
  OPS_DOMAIN_TABLES,
  OPS_COLUMNS,
} from '../lib/pilot/ops-schema.ts';
import { opsSchemaSource, assertOpsSchema } from './pilot-ops-schema.mjs';
import { bounded } from './readiness-node-runner.mjs';
import {
  opsArchiveError,
  MAX_ARCHIVE_PLAINTEXT,
} from './pilot-ops-archive.mjs';

const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw opsArchiveError(code);
};
const ident = (v) => '"' + v.replaceAll('"', '""') + '"';
const rowObjects = (result) =>
  result.rows.map((row) => Object.fromEntries(Object.entries(row)));
const stmt = (sql, args = []) => ({ sql, args });
const validId = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
const scopeValid = (s) =>
  s &&
  ['environment', 'installationId', 'opsInstallationId'].every((k) =>
    validId(s[k]),
  );
const batch = (client, sql, mode = 'read') =>
  bounded(client.batch(sql, mode), 30000, 'Operations database batch');

export async function initializeOpsLibsql({
  client,
  sourceRoot,
  scope,
  now = Date.now(),
  version,
}) {
  if (!scopeValid(scope) || !Number.isSafeInteger(now) || now < 0)
    fail('OPS_SCOPE_INVALID');
  const source = opsSchemaSource(sourceRoot, { version });
  const existing = await client.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
  );
  if (existing.rows.length) fail('OPS_INITIALIZE_NOT_EMPTY');
  const statements = [
    stmt('CREATE TABLE ops_init_guard(ok INTEGER NOT NULL CHECK(ok=1))'),
    stmt(
      "INSERT INTO ops_init_guard SELECT CASE WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name<>'ops_init_guard')=0 THEN 1 ELSE 0 END",
    ),
    ...source.statements
      .filter((s) => !/^\s*(?:--[^\n]*\n\s*)*PRAGMA\b/i.test(s))
      .map((sql) => stmt(sql)),
    ...source.migrations.map((m) =>
      stmt(
        'INSERT INTO ops_schema_history(version,name,checksum,applied_at) VALUES(?,?,?,?)',
        [m.version, m.name, m.sha256, now],
      ),
    ),
    stmt(
      'INSERT INTO ops_installation(id,installation_id,environment,learning_installation_id,schema_version,queue_revision,created_at) VALUES(1,?,?,?,?,0,?)',
      [
        scope.opsInstallationId,
        scope.environment,
        scope.installationId,
        `pilot-ops-schema-${source.version}`,
        now,
      ],
    ),
    stmt('DROP TABLE ops_init_guard'),
  ];
  await batch(client, statements, 'write');
  const actual = await captureOpsLibsql({ client, sourceRoot, scope });
  return {
    ...scope,
    tables: OPS_TABLES.length,
    schemaDigest: hash(actual.schema),
  };
}

export async function captureOpsLibsql({ client, sourceRoot, scope }) {
  if (!scopeValid(scope)) fail('OPS_SCOPE_INVALID');
  const installed = await client.execute(
    'SELECT schema_version FROM ops_installation WHERE id=1',
  );
  const schemaVersion = installed.rows[0]?.schema_version;
  const version =
    schemaVersion === 'pilot-ops-schema-1'
      ? 1
      : schemaVersion === 'pilot-ops-schema-2'
        ? 2
        : schemaVersion === 'pilot-ops-schema-3'
          ? 3
          : 0;
  if (!version) fail('OPS_INSTALLATION_MISMATCH');
  const source = opsSchemaSource(sourceRoot, { version });
  const queries = [
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND sql IS NOT NULL ORDER BY name",
    'PRAGMA foreign_key_check',
    ...OPS_TABLES.map(
      (table) =>
        `SELECT ${OPS_COLUMNS[table].map(ident).join(',')} FROM ${ident(table)}`,
    ),
  ];
  const results = await batch(
    client,
    queries.map((sql) => stmt(sql)),
  );
  if (results.length !== queries.length) fail('OPS_CAPTURE_INCOMPLETE');
  const objects = rowObjects(results[0]);
  if (
    objects.some(
      (s) =>
        s.type === 'view' ||
        (!OPS_TABLES.includes(s.tbl_name) &&
          !/^(?:sqlite_|libsql_)/.test(s.tbl_name)),
    )
  )
    fail('OPS_SCHEMA_MISMATCH');
  const schema = objects.filter((s) => OPS_TABLES.includes(s.tbl_name));
  assertOpsSchema({ schema, migrations: source.migrations }, source);
  if (results[1].rows.length) fail('OPS_FOREIGN_KEY_INVALID');
  const tables = Object.fromEntries(
    OPS_TABLES.map((table, i) => [table, rowObjects(results[i + 2])]),
  );
  const install = tables.ops_installation;
  if (
    install.length !== 1 ||
    install[0].id !== 1 ||
    install[0].installation_id !== scope.opsInstallationId ||
    install[0].learning_installation_id !== scope.installationId ||
    install[0].environment !== scope.environment ||
    install[0].schema_version !== `pilot-ops-schema-${source.version}`
  )
    fail('OPS_INSTALLATION_MISMATCH');
  const ledger = tables.ops_schema_history;
  if (
    ledger.length !== source.migrations.length ||
    source.migrations.some(
      (m) =>
        !ledger.some(
          (r) =>
            r.version === m.version &&
            r.name === m.name &&
            r.checksum === m.sha256,
        ),
    )
  )
    fail('OPS_MIGRATION_MISMATCH');

  return {
    schema,
    tables,
    migrations: source.migrations,
    format: source.format,
  };
}

export async function validateOpsBackupEnvelope({ archive, sourceRoot }) {
  if (
    !archive ||
    typeof archive !== 'object' ||
    Array.isArray(archive) ||
    Object.keys(archive).length !== 2 ||
    !Object.hasOwn(archive, 'payload') ||
    !/^[a-f0-9]{64}$/.test(archive.sha256 || '') ||
    archive.sha256 !== hash(archive.payload)
  )
    fail('OPS_ARCHIVE_CHECKSUM');
  if (Buffer.byteLength(JSON.stringify(archive)) > MAX_ARCHIVE_PLAINTEXT)
    fail('OPS_ARCHIVE_SIZE');
  const version =
    archive.payload?.format === 'pilot-ops-backup-1'
      ? 1
      : archive.payload?.format === 'pilot-ops-backup-2'
        ? 2
        : archive.payload?.format === 'pilot-ops-backup-3'
          ? 3
          : 0;
  const source = opsSchemaSource(sourceRoot, { version });
  assertOpsSchema(archive.payload, source);
  const { validateOpsArchive } = await import('../lib/pilot/ops-archive.ts');
  await validateOpsArchive(archive.payload, { source });
  return source;
}

export async function createOpsBackupPayload({
  client,
  sourceRoot,
  scope,
  buildId,
  now = Date.now(),
}) {
  if (
    !scopeValid(scope) ||
    !validId(buildId) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 253402300799999
  )
    fail('OPS_SCOPE_INVALID');
  const snapshot = await captureOpsLibsql({ client, sourceRoot, scope });
  const payload = {
    format: snapshot.format,
    createdAt: new Date(now).toISOString(),
    sourceOpsInstallationId: scope.opsInstallationId,
    sourceInstallationId: scope.installationId,
    environment: scope.environment,
    buildId,
    migrations: snapshot.migrations,
    schemaDigest: hash(snapshot.schema),
    schema: snapshot.schema,
    tables: snapshot.tables,
  };
  const archive = { payload, sha256: hash(payload) };
  await validateOpsBackupEnvelope({ archive, sourceRoot });
  return archive;
}

export function assertFreshOpsSnapshot(snapshot, archive, scope) {
  if (!scopeValid(scope)) fail('OPS_RESTORE_NOT_FRESH');
  const historical = new Set([archive.sourceOpsInstallationId]);
  for (const table of OPS_DOMAIN_TABLES)
    for (const row of archive.tables[table])
      historical.add(row.ops_installation_id);
  const installation = snapshot.tables.ops_installation;
  if (
    historical.has(scope.opsInstallationId) ||
    installation.length !== 1 ||
    installation[0].id !== 1 ||
    installation[0].installation_id !== scope.opsInstallationId ||
    installation[0].learning_installation_id !== scope.installationId ||
    installation[0].environment !== scope.environment ||
    installation[0].queue_revision !== 0 ||
    OPS_DOMAIN_TABLES.some(
      (table) =>
        !Array.isArray(snapshot.tables[table]) ||
        snapshot.tables[table].length !== 0,
    )
  )
    fail('OPS_RESTORE_NOT_FRESH');
}

const domainDigest = (tables) =>
  hash(
    OPS_DOMAIN_TABLES.map((table) => [
      table,
      tables[table]
        .map((row) => JSON.stringify(OPS_COLUMNS[table].map((c) => row[c])))
        .sort((a, b) => a.localeCompare(b)),
    ]),
  );
function restoreStatements(payload, scope) {
  const count = OPS_DOMAIN_TABLES.map(
    (t) => `(SELECT COUNT(*) FROM ${ident(t)})`,
  ).join('+');
  // The envelope was already validated against the closed schema1/schema2/schema3 source.
  // Recheck the exact ledger inside the write transaction, with one bound triple
  // per known migration; HTTP libSQL rejects excess positional arguments.
  const migrationGuards = payload.migrations
    .map(
      () =>
        '(SELECT COUNT(*) FROM ops_schema_history WHERE version=? AND name=? AND checksum=?)=1',
    )
    .join(' AND ');
  const statements = [
    stmt('CREATE TABLE ops_restore_guard(ok INTEGER NOT NULL CHECK(ok=1))'),
    stmt(
      `INSERT INTO ops_restore_guard SELECT CASE WHEN (${count})=0 AND (SELECT COUNT(*) FROM ops_installation WHERE id=1 AND installation_id=? AND learning_installation_id=? AND environment=? AND schema_version=? AND queue_revision=0)=1 AND (SELECT COUNT(*) FROM ops_schema_history)=? AND ${migrationGuards} THEN 1 ELSE 0 END`,
      [
        scope.opsInstallationId,
        scope.installationId,
        scope.environment,
        `pilot-ops-schema-${payload.migrations.length}`,
        payload.migrations.length,
        ...payload.migrations.flatMap((m) => [m.version, m.name, m.sha256]),
      ],
    ),
  ];
  for (const table of [
    'ops_job',
    'ops_feedback',
    'ops_job_event',
    'ops_feedback_event',
    'ops_archive',
    'ops_alert_event',
  ]) {
    const values = [...payload.tables[table]];
    if (table.endsWith('_event'))
      values.sort(
        (a, b) =>
          String(a.job_id ?? a.record_id ?? a.alert_id).localeCompare(
            String(b.job_id ?? b.record_id ?? b.alert_id),
          ) || a.sequence - b.sequence,
      );
    const columns = OPS_COLUMNS[table];
    for (const row of values)
      statements.push(
        stmt(
          `INSERT INTO ${ident(table)}(${columns.map(ident).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          columns.map((c) => row[c]),
        ),
      );
  }
  statements.push(stmt('DROP TABLE ops_restore_guard'));
  return statements;
}

export async function restoreOpsLibsql(
  { client, sourceRoot, archive, scope },
  { decorateClient } = {},
) {
  // Source checks precede any destination query, including readiness inspection.
  await validateOpsBackupEnvelope({ archive, sourceRoot });
  const before = await captureOpsLibsql({ client, sourceRoot, scope });
  if (before.format !== archive.payload.format) fail('OPS_SCHEMA_MISMATCH');
  assertFreshOpsSnapshot(before, archive.payload, scope);
  const writer = decorateClient ? decorateClient(client) : client;
  let uncertain = false,
    settled = false,
    writeError;
  const writing = Promise.resolve()
    .then(() =>
      writer.batch(restoreStatements(archive.payload, scope), 'write'),
    )
    .then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        writeError = error;
        throw error;
      },
    );
  try {
    await bounded(writing, 30000, 'Operations restore write');
  } catch {
    uncertain = true;
  }
  try {
    const after = await captureOpsLibsql({ client, sourceRoot, scope });
    if (domainDigest(after.tables) !== domainDigest(archive.payload.tables)) {
      if (uncertain) {
        assertFreshOpsSnapshot(after, archive.payload, scope);
        const engineRejected =
          settled &&
          typeof writeError?.code === 'string' &&
          /^(?:SQL_PARSE_ERROR|SQL_INPUT_ERROR|SQLITE_(?:ERROR|CONSTRAINT(?:_[A-Z_]+)?))$/.test(
            writeError.code,
          );
        fail(
          engineRejected
            ? 'OPS_RESTORE_NOT_COMMITTED'
            : 'OPS_RESTORE_UNCONFIRMED',
        );
      }
      fail('OPS_RESTORE_UNCONFIRMED');
    }
    // Validate retained historical tables with the fresh destination bookkeeping.
    const now = Math.max(Date.parse(archive.payload.createdAt), Date.now());
    const verified = {
      ...archive.payload,
      createdAt: new Date(now).toISOString(),
      sourceOpsInstallationId: scope.opsInstallationId,
      sourceInstallationId: scope.installationId,
      environment: scope.environment,
      schema: after.schema,
      schemaDigest: hash(after.schema),
      tables: after.tables,
    };
    const { validateOpsArchive } = await import('../lib/pilot/ops-archive.ts');
    await validateOpsArchive(verified);
    return {
      format: archive.payload.format,
      ...scope,
      commit: uncertain ? 'confirmed-after-uncertainty' : 'confirmed',
      sha256: archive.sha256,
      counts: Object.fromEntries(
        OPS_DOMAIN_TABLES.map((table) => [table, after.tables[table].length]),
      ),
    };
  } catch (error) {
    if (error?.code === 'OPS_RESTORE_NOT_COMMITTED') throw error;
    fail('OPS_RESTORE_UNCONFIRMED');
  }
}

/** Exact additive migration on an already verified schema1/schema2 installation. No live/automatic upgrade. */
export async function migrateOpsLibsql({
  client,
  sourceRoot,
  scope,
  now = Date.now(),
  version = 2,
}) {
  if (!Number.isSafeInteger(now) || now < 0) fail('OPS_SCOPE_INVALID');
  const before = await captureOpsLibsql({ client, sourceRoot, scope });
  if (![2, 3].includes(version)) fail('OPS_MIGRATION_MISMATCH');
  const source = opsSchemaSource(sourceRoot, { version });
  if (version === 3 && before.format === source.format)
    return { format: before.format, scope };
  if (before.format !== `pilot-ops-backup-${version - 1}`)
    fail('OPS_MIGRATION_MISMATCH');
  const migration = source.migrations[version - 1];
  await batch(
    client,
    [
      ...source.upgradeStatements.map((sql) => stmt(sql)),
      stmt(
        'INSERT INTO ops_schema_history(version,name,checksum,applied_at) VALUES(?,?,?,?)',
        [migration.version, migration.name, migration.sha256, now],
      ),
    ],
    'write',
  );
  const after = await captureOpsLibsql({ client, sourceRoot, scope });
  if (
    domainDigest(before.tables) !== domainDigest(after.tables) ||
    before.tables.ops_installation[0].queue_revision !==
      after.tables.ops_installation[0].queue_revision
  )
    fail('OPS_MIGRATION_UNCONFIRMED');
  return { format: after.format, scope };
}
