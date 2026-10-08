import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyNodeManifest, bounded } from './readiness-node-runner.mjs';
import {
  PILOT_V4_COLUMNS,
  PILOT_V4_TABLES,
  PILOT_V4_SCHEMA_TABLES,
  readPilotBackup,
  validatePilotStoryBackup,
} from './pilot-backup.mjs';
import { assertStorySchema, storySchemaSource } from './pilot-story-schema.mjs';
import { historicalStoryInstallationIds } from './pilot-story-backup.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const rows = (result) =>
  result.rows.map((row) => Object.fromEntries(Object.entries(row)));
const statement = (sql, args = []) => ({ sql, args });
const compare = (a, b) => String(a).localeCompare(String(b));
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function clientShape(client) {
  if (
    !client ||
    typeof client.execute !== 'function' ||
    typeof client.batch !== 'function'
  )
    fail('OWNED_LIBSQL_CLIENT_REQUIRED');
}
const boundedBatch = (client, statements, mode) =>
  bounded(client.batch(statements, mode), 30000, 'Story backup database batch');

/** Only the runner/operator supplies a live owned client and explicit identity. */
export async function captureStoryLibsql(client, installationId) {
  clientShape(client);
  if (typeof installationId !== 'string' || !installationId)
    fail('INSTALLATION_ID_REQUIRED');
  const queries = [
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND sql IS NOT NULL ORDER BY name",
    'SELECT id,installation_id FROM pilot_installation',
    'SELECT version,checksum FROM pilot_schema_history ORDER BY version',
    'SELECT name FROM pilot_d1_migrations ORDER BY id',
    'PRAGMA foreign_key_check',
    'SELECT COUNT(*) AS n FROM pilot_auth_session',
    'SELECT COUNT(*) AS n FROM pilot_auth_verification',
    ...PILOT_V4_TABLES.map(
      (table) =>
        `SELECT ${PILOT_V4_COLUMNS[table].map(ident).join(',')} FROM ${ident(table)}`,
    ),
  ];
  const result = await boundedBatch(
    client,
    queries.map((sql) => statement(sql)),
    'read',
  );
  if (result.length !== queries.length) fail('BACKUP_SNAPSHOT_INCOMPLETE');
  const objects = rows(result[0]);
  const supported = new Set([
    ...PILOT_V4_SCHEMA_TABLES,
    'pilot_schema_history',
    'pilot_d1_migrations',
  ]);
  if (
    objects.some(
      (row) =>
        row.type === 'view' ||
        (!supported.has(row.tbl_name) &&
          !/^(?:sqlite_|libsql_)/.test(row.tbl_name)),
    )
  )
    fail('BACKUP_UNKNOWN_SCHEMA');
  const installation = rows(result[1]);
  if (
    installation.length !== 1 ||
    installation[0].id !== 1 ||
    installation[0].installation_id !== installationId
  )
    fail('BACKUP_INSTALLATION_MISMATCH');
  if (rows(result[4]).length) fail('BACKUP_FOREIGN_KEY_INVALID');
  return {
    installationId,
    schema: objects.filter((row) =>
      PILOT_V4_SCHEMA_TABLES.includes(row.tbl_name),
    ),
    schemaHistory: rows(result[2]),
    migrationHistory: rows(result[3]),
    sessionCount: Number(rows(result[5])[0]?.n),
    verificationCount: Number(rows(result[6])[0]?.n),
    tables: Object.fromEntries(
      PILOT_V4_TABLES.map((table, index) => [table, rows(result[index + 7])]),
    ),
  };
}

function checkSchema(snapshot, source) {
  assertStorySchema(
    { migrations: source.migrations, schema: snapshot.schema },
    source,
  );
  const history = source.migrations
    .map((row) => ({ version: row.version, checksum: row.sha256 }))
    .sort((a, b) => compare(a.version, b.version));
  if (
    JSON.stringify(snapshot.schemaHistory) !== JSON.stringify(history) ||
    JSON.stringify(snapshot.migrationHistory) !==
      JSON.stringify(source.migrations.map((row) => ({ name: row.name })))
  )
    fail('BACKUP_MIGRATION_MISMATCH');
}

async function identities(sourceRoot, tables) {
  const { FOREST_LESSON } = await import(
    pathToFileURL(path.join(sourceRoot, 'lib/preview/content.ts')).href
  );
  return {
    legacy: {
      'forest-01-v1': {
        lessonId: 'forest-01',
        algorithm: 's2-json-stringify-sha256-v1',
        digest: hash(FOREST_LESSON),
      },
    },
    curriculum: Object.fromEntries(
      tables.pilot_curriculum_package.map((row) => [
        row.lesson_version,
        {
          lessonId: row.lesson_id,
          canonicalizationVersion: row.canonicalization_version,
          digest: row.content_digest,
        },
      ]),
    ),
  };
}
function privateOutput(manifest, filePath) {
  const directory = path.join(manifest.work, 'private-backups');
  if (
    !path.isAbsolute(filePath || '') ||
    path.dirname(filePath) !== directory ||
    path.resolve(filePath) !== filePath
  )
    fail('PRIVATE_BACKUP_PATH_REQUIRED');
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    fail('PRIVATE_BACKUP_DIRECTORY_REQUIRED');
}
const tableDigest = (tables) =>
  hash(
    PILOT_V4_TABLES.map((table) => [
      table,
      tables[table]
        .map((row) =>
          JSON.stringify(PILOT_V4_COLUMNS[table].map((column) => row[column])),
        )
        .sort(compare),
    ]),
  );
const metadata = (payload, checksum, installationId, commit = 'confirmed') => ({
  format: payload.format,
  sha256: checksum,
  installationId,
  commit,
  counts: Object.fromEntries(
    PILOT_V4_TABLES.map((table) => [table, payload.tables[table].length]),
  ),
});

export async function createStoryBackupPayload({
  sourceRoot,
  candidateId,
  client,
  installationId,
  archiveIssuers = [],
  createdAtMs = Date.now(),
}) {
  if (
    ![candidateId, installationId].every(
      (value) =>
        typeof value === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(value),
    ) ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    createdAtMs > 253402300799999
  )
    fail('BACKUP_IDENTITY_REQUIRED');
  assertSourceRoot(sourceRoot);
  const source = storySchemaSource(sourceRoot);
  const snapshot = await captureStoryLibsql(client, installationId);
  checkSchema(snapshot, source);
  const payload = {
    format: 'pilot-admin-backup-4',
    createdAt: new Date(createdAtMs).toISOString(),
    candidateId,
    sourceInstallationId: installationId,
    migrations: source.migrations,
    schemaDigest: hash(snapshot.schema),
    schema: snapshot.schema,
    contentIdentities: await identities(sourceRoot, snapshot.tables),
    tables: snapshot.tables,
  };
  await validatePilotStoryBackup(payload, { archiveIssuers });
  const checksum = hash(payload),
    serialized = JSON.stringify({ payload, sha256: checksum });
  if (Buffer.byteLength(serialized) > MAX_BYTES) fail('BACKUP_SIZE_LIMIT');
  return { payload, sha256: checksum };
}

function assertSourceRoot(sourceRoot) {
  if (
    typeof sourceRoot !== 'string' ||
    !path.isAbsolute(sourceRoot) ||
    path.normalize(sourceRoot) !== sourceRoot ||
    fs.realpathSync(sourceRoot) !== sourceRoot
  )
    fail('BACKUP_SOURCE_ROOT_REQUIRED');
}

export async function backupStoryLibsql({
  manifest,
  client,
  installationId,
  archiveIssuers = [],
  filePath,
}) {
  verifyNodeManifest(manifest, { built: true });
  const archive = await createStoryBackupPayload({
    sourceRoot: manifest.snapshot,
    candidateId: manifest.candidateId,
    client,
    installationId,
    archiveIssuers,
  });
  privateOutput(manifest, filePath);
  fs.writeFileSync(filePath, JSON.stringify(archive), {
    mode: 0o600,
    flag: 'wx',
  });
  return metadata(archive.payload, archive.sha256, installationId);
}

/** Private reusable validation; no destination query or fabricated QA manifest. */
export async function validateStoryBackupEnvelope({
  archive,
  sourceRoot,
  archiveIssuers = [],
}) {
  if (
    !archive ||
    typeof archive !== 'object' ||
    Array.isArray(archive) ||
    Object.keys(archive).length !== 2 ||
    !Object.hasOwn(archive, 'payload') ||
    typeof archive.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    archive.sha256 !== hash(archive.payload)
  )
    fail('BACKUP_CHECKSUM_INVALID');
  if (Buffer.byteLength(JSON.stringify(archive)) > MAX_BYTES)
    fail('BACKUP_SIZE_LIMIT');
  const { payload } = archive;
  if (payload?.format !== 'pilot-admin-backup-4')
    fail('BACKUP_VERSION_INCOMPATIBLE');
  assertSourceRoot(sourceRoot);
  const source = storySchemaSource(sourceRoot);
  assertStorySchema(payload, source);
  await validatePilotStoryBackup(payload, { archiveIssuers });
  if (
    JSON.stringify(payload.contentIdentities.legacy) !==
    JSON.stringify((await identities(sourceRoot, payload.tables)).legacy)
  )
    fail('BACKUP_LEGACY_IDENTITY_MISMATCH');
  return source;
}

export function assertFreshStorySnapshot(snapshot, source) {
  const historical = historicalStoryInstallationIds(source);
  if (
    !snapshot.installationId ||
    historical.has(snapshot.installationId) ||
    snapshot.sessionCount !== 0 ||
    snapshot.verificationCount !== 0
  )
    fail('RESTORE_DESTINATION_NOT_FRESH');
  for (const table of PILOT_V4_TABLES) {
    const values = snapshot.tables[table];
    if (!Array.isArray(values)) fail('RESTORE_DESTINATION_NOT_FRESH');
    if (table === 'pilot_curriculum_registry_state') {
      if (
        JSON.stringify(values) !==
        JSON.stringify([{ id: 1, revision: 0, updated_at: 0 }])
      )
        fail('RESTORE_DESTINATION_NOT_FRESH');
    } else if (values.length !== 0) fail('RESTORE_DESTINATION_NOT_FRESH');
  }
}

function restoreStatements(payload, installationId) {
  const freshness = [
    ...PILOT_V4_TABLES.filter(
      (table) => table !== 'pilot_curriculum_registry_state',
    ),
    'pilot_auth_session',
    'pilot_auth_verification',
  ];
  const count = freshness
    .map((table) => `(SELECT COUNT(*) FROM ${ident(table)})`)
    .join('+');
  const state = payload.tables.pilot_curriculum_registry_state[0];
  const statements = [
    statement(
      'CREATE TABLE pilot_story_restore_guard(ok INTEGER NOT NULL CHECK(ok=1))',
    ),
    statement(
      `INSERT INTO pilot_story_restore_guard SELECT CASE WHEN (${count})=0 AND (SELECT COUNT(*) FROM pilot_curriculum_registry_state WHERE id=1 AND revision=0 AND updated_at=0)=1 AND (SELECT COUNT(*) FROM pilot_installation)=1 AND (SELECT installation_id FROM pilot_installation WHERE id=1)=? THEN 1 ELSE 0 END`,
      [installationId],
    ),
    statement(
      'UPDATE pilot_curriculum_registry_state SET revision=?,updated_at=? WHERE id=1 AND revision=0 AND updated_at=0',
      [state.revision, state.updated_at],
    ),
  ];
  for (const table of PILOT_V4_TABLES) {
    if (table === 'pilot_curriculum_registry_state') continue;
    const columns = PILOT_V4_COLUMNS[table];
    let values = payload.tables[table];
    if (table === 'pilot_curriculum_review')
      values = [...values].sort(
        (a, b) =>
          compare(a.lesson_version, b.lesson_version) ||
          a.review_sequence - b.review_sequence,
      );
    if (table === 'pilot_curriculum_publication')
      values = [...values].sort(
        (a, b) =>
          compare(a.installation_id, b.installation_id) ||
          compare(a.lesson_version, b.lesson_version) ||
          a.generation - b.generation,
      );
    for (const row of values)
      statements.push(
        statement(
          `INSERT INTO ${ident(table)}(${columns.map(ident).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          columns.map((column) => row[column]),
        ),
      );
  }
  statements.push(statement('DROP TABLE pilot_story_restore_guard'));
  return statements;
}

export async function restoreStoryLibsql(
  { manifest, client, installationId, archiveIssuers = [], filePath },
  { decorateClient } = {},
) {
  verifyNodeManifest(manifest, { built: true });
  return restoreStoryBackupPayload(
    {
      sourceRoot: manifest.snapshot,
      client,
      installationId,
      archiveIssuers,
      archive: readPilotBackup(filePath),
    },
    { decorateClient },
  );
}

export async function restoreStoryBackupPayload(
  { sourceRoot, client, installationId, archiveIssuers = [], archive },
  { decorateClient } = {},
) {
  // Every source validation runs before even querying the destination.
  const source = await validateStoryBackupEnvelope({
    archive,
    sourceRoot,
    archiveIssuers,
  });
  const { payload, sha256 } = archive;
  const before = await captureStoryLibsql(client, installationId);
  checkSchema(before, source);
  assertFreshStorySnapshot(before, payload);
  const writer = decorateClient ? decorateClient(client) : client;
  clientShape(writer);
  let uncertain = false,
    writeSettled = false,
    writeError = null;
  const writing = Promise.resolve()
    .then(() =>
      writer.batch(restoreStatements(payload, installationId), 'write'),
    )
    .then(
      (result) => {
        writeSettled = true;
        return result;
      },
      (error) => {
        writeSettled = true;
        writeError = error;
        throw error;
      },
    );
  try {
    await bounded(writing, 30000, 'Story restore write');
  } catch {
    uncertain = true;
  }
  try {
    // Probe the real destination even when the decorated transport lost its ack.
    const after = await captureStoryLibsql(client, installationId);
    checkSchema(after, source);
    if (
      tableDigest(after.tables) !== tableDigest(payload.tables) ||
      after.sessionCount !== 0 ||
      after.verificationCount !== 0
    ) {
      if (uncertain) {
        try {
          assertFreshStorySnapshot(after, payload);
        } catch {
          fail('RESTORE_UNCONFIRMED');
        }
        // A timeout or transport rejection does not cancel a remote write.
        // A fresh probe is conclusive only after an atomic SQL engine refusal.
        const engineRejected =
          writeSettled &&
          typeof writeError?.code === 'string' &&
          /^(?:SQL_PARSE_ERROR|SQL_INPUT_ERROR|SQLITE_(?:ERROR|CONSTRAINT(?:_[A-Z_]+)?))$/.test(
            writeError.code,
          );
        fail(engineRejected ? 'RESTORE_NOT_COMMITTED' : 'RESTORE_UNCONFIRMED');
      }
      fail('RESTORE_UNCONFIRMED');
    }
    await validatePilotStoryBackup(
      { ...payload, tables: after.tables },
      { archiveIssuers },
    );
    return metadata(
      payload,
      sha256,
      installationId,
      uncertain ? 'confirmed-after-uncertainty' : 'confirmed',
    );
  } catch (error) {
    if (error?.code === 'RESTORE_NOT_COMMITTED') throw error;
    fail('RESTORE_UNCONFIRMED');
  }
}
