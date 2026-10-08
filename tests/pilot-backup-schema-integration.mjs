import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../scripts/qa-helpers.mjs';
import { localD1 } from '../scripts/pilot-local-db.mjs';
import {
  backupPilot,
  pilotBackupFormatForCandidate,
  restorePilot,
} from '../scripts/pilot-backup.mjs';

const manifestFlag = process.argv.indexOf('--manifest');
const manifest = loadManifest(
  manifestFlag >= 0 ? process.argv[manifestFlag + 1] : null,
);
const format = pilotBackupFormatForCandidate(manifest);
if (!['pilot-admin-backup-2', 'pilot-admin-backup-3'].includes(format)) {
  throw new Error('This regression requires a v2 or v3 pilot candidate');
}

const reportDirectory = path.join(
  manifest.output,
  `pilot-backup-schema-${Date.now()}`,
);
fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });

const ownedRoots = [];
const configDirectories = [];
const startedAt = new Date().toISOString();

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function makeInstallation(label) {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `hanzi-backup-schema-${label}-`),
  );
  ownedRoots.push(work);
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'schema-regression\n', {
    mode: 0o600,
  });
  const state = path.join(work, 'state');
  fs.mkdirSync(state, { mode: 0o700 });
  const privateBackups = path.join(work, 'private-backups');
  fs.mkdirSync(privateBackups, { mode: 0o700 });

  const configDirectory = path.join(
    manifest.snapshot,
    '.qa-config',
    `backup-schema-${label}-${crypto.randomUUID()}`,
  );
  configDirectories.push(configDirectory);
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = path.join(configDirectory, 'wrangler.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      name: `hanzi-backup-schema-${label}-${crypto.randomUUID()}`,
      compatibility_date: '2026-09-25',
      d1_databases: [
        {
          binding: 'DB',
          database_name: `hanzi-backup-schema-${label}-${crypto.randomUUID()}`,
          database_id: '00000000-0000-4000-8000-000000000000',
        },
      ],
    }),
    { mode: 0o600 },
  );
  const installationManifest = {
    ...manifest,
    work,
    buildState: state,
  };
  const db = localD1(installationManifest, { configPath, state });
  db.migrate();
  return {
    db,
    state,
    configPath,
    privateBackups,
    manifest: installationManifest,
  };
}

function snapshot(db) {
  const objects = db.query(`
    SELECT type,name,tbl_name,sql
    FROM sqlite_master
    WHERE name GLOB 'pilot_*' OR tbl_name GLOB 'pilot_*'
    ORDER BY type,name;
  `)[0].results;
  const tableNames = objects
    .filter((row) => row.type === 'table')
    .map((row) => row.name);
  const tables = Object.fromEntries(
    tableNames.map((table) => {
      const values = db.query(`SELECT * FROM ${identifier(table)};`)[0].results;
      values.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
      return [table, values];
    }),
  );
  return {
    objects,
    tables,
    foreignKeys: db.query('PRAGMA foreign_key_check;')[0].results,
  };
}

function addUnexpectedView(db) {
  db.query('CREATE VIEW pilot_unexpected_schema_view AS SELECT 1 AS sentinel;');
}

function classifyFailure(error) {
  // Wrangler/D1 can echo SQL and local paths. Keep report output to a fixed,
  // non-sensitive category while retaining the raw database in the private
  // runner-owned tree for an operator who needs to inspect it.
  if (error?.code === 'BACKUP_VERSION_INCOMPATIBLE')
    return 'backup-version-incompatible';
  return 'operation-rejected';
}

async function run() {
  const source = makeInstallation('source');
  const destination = makeInstallation('destination');
  const validBackup = path.join(
    source.privateBackups,
    `empty-${crypto.randomUUID()}.json`,
  );
  const rejectedBackup = path.join(
    source.privateBackups,
    `unexpected-view-${crypto.randomUUID()}.json`,
  );

  // Establish the known-good envelope before adding the unexpected schema
  // object. This keeps the restore case independent of the backup rejection.
  await backupPilot({
    manifest: source.manifest,
    configPath: source.configPath,
    state: source.state,
    filePath: validBackup,
  });

  addUnexpectedView(source.db);
  let backupError;
  try {
    await backupPilot({
      manifest: source.manifest,
      configPath: source.configPath,
      state: source.state,
      filePath: rejectedBackup,
    });
  } catch (error) {
    backupError = error;
  }
  const backupRejected = backupError !== undefined;
  const backupFileCreated = fs.existsSync(rejectedBackup);

  addUnexpectedView(destination.db);
  const beforeRestore = snapshot(destination.db);
  let restoreError;
  try {
    await restorePilot({
      manifest: destination.manifest,
      configPath: destination.configPath,
      state: destination.state,
      filePath: validBackup,
    });
  } catch (error) {
    restoreError = error;
  }
  const afterRestore = snapshot(destination.db);
  const restoreRejected = restoreError !== undefined;
  const restoreUnchanged =
    JSON.stringify(beforeRestore) === JSON.stringify(afterRestore);

  return [
    {
      id: 'R-BACKUP-SCHEMA-VIEW-01',
      status: backupRejected && !backupFileCreated ? 'PASS' : 'FAIL',
      observed: backupRejected
        ? classifyFailure(backupError)
        : backupFileCreated
          ? 'backup-accepted-and-file-created'
          : 'backup-accepted',
    },
    {
      id: 'R-RESTORE-SCHEMA-VIEW-01',
      status: restoreRejected && restoreUnchanged ? 'PASS' : 'FAIL',
      observed: restoreRejected
        ? restoreUnchanged
          ? classifyFailure(restoreError)
          : 'restore-rejected-state-changed'
        : restoreUnchanged
          ? 'restore-accepted'
          : 'restore-accepted-state-changed',
    },
  ];
}

let cases;
let setupFailure = false;
try {
  cases = await run();
} catch {
  setupFailure = true;
  cases = [
    { id: 'R-BACKUP-SCHEMA-VIEW-01', status: 'BLOCKED' },
    { id: 'R-RESTORE-SCHEMA-VIEW-01', status: 'BLOCKED' },
  ];
} finally {
  for (const directory of configDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
}

const report = {
  candidateId: manifest.candidateId,
  format,
  startedAt,
  finishedAt: new Date().toISOString(),
  cases,
};
const reportPath = path.join(reportDirectory, 'results.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify(cases.map(({ id, status }) => ({ id, status }))));
if (setupFailure || cases.some((item) => item.status !== 'PASS'))
  process.exitCode = 1;
