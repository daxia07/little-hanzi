import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupPilot, restorePilot } from '../scripts/pilot-backup.mjs';

test('[S3-AC-011][C-H-BACKUP] unknown future schema refuses backup formats before filesystem/database setup', async () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-backup-boundary-'),
  );
  try {
    fs.writeFileSync(
      path.join(root, '.hanzi-qa-owned'),
      'synthetic-backup-boundary',
    );
    const snapshot = path.join(root, 'candidate');
    const migrations = path.join(snapshot, 'db/pilot-migrations');
    fs.mkdirSync(migrations, { recursive: true });
    for (const name of [
      '0000-auth.sql',
      '0001-data.sql',
      '0002-learning.sql',
      '0003-curriculum.sql',
      '0004-curriculum-runtime.sql',
    ]) {
      fs.copyFileSync(
        new URL(`../db/pilot-migrations/${name}`, import.meta.url),
        path.join(migrations, name),
      );
    }
    fs.writeFileSync(
      path.join(migrations, '0005-future-schema.sql'),
      '-- synthetic future schema marker\nSELECT 1;\n',
    );
    const directory = path.join(root, 'private-backups');
    const state = path.join(root, 'state');
    fs.mkdirSync(state);
    const target = {
      manifest: {
        snapshot,
        work: root,
        buildState: state,
        candidateId: 'boundary-fixture',
      },
      state,
      configPath: path.join(snapshot, 'deliberately-absent-config.json'),
      filePath: path.join(directory, 'backup.json'),
    };
    await assert.rejects(
      () => backupPilot(target),
      (error) => error.code === 'BACKUP_VERSION_INCOMPATIBLE',
    );
    await assert.rejects(
      () => restorePilot(target),
      (error) => error.code === 'BACKUP_VERSION_INCOMPATIBLE',
    );
    assert.equal(
      fs.existsSync(directory),
      false,
      'unsupported format created backup filesystem state',
    );
    assert.deepEqual(
      fs.readdirSync(state),
      [],
      'unsupported format touched database state',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
