import { legacyCollectionRoot } from './helpers/legacy-pilot-root.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { applyLibsqlMigrations } from '../scripts/pilot-libsql-admin.mjs';
import { createCollectionBackupPayload } from '../scripts/pilot-collection-libsql-backup.mjs';
import { readPilotBackup } from '../scripts/pilot-backup.mjs';

test('[R5-E-012] public administrative reader accepts real V5 capture and refuses malformed collection rows/checksum before restore', async () => {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r5-d1-boundary-')),
  );
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'r5-d1-boundary');
  const client = createClient({ url: 'file:' + path.join(work, 'source.db') });
  try {
    const root = legacyCollectionRoot(
      fs.realpathSync(fileURLToPath(new URL('../', import.meta.url))),
    );
    await applyLibsqlMigrations({ client, root });
    const installationId = (
      await client.execute('SELECT installation_id FROM pilot_installation')
    ).rows[0].installation_id;
    const archive = await createCollectionBackupPayload({
      sourceRoot: root,
      candidateId: 'r5-d1-boundary',
      client,
      installationId,
    });
    fs.mkdirSync(path.join(work, 'private-backups'), { mode: 0o700 });
    const file = path.join(work, 'private-backups', 'archive.json');
    const write = (value) =>
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    write(archive);
    assert.deepEqual(readPilotBackup(file), archive);
    const bad = structuredClone(archive);
    bad.payload.tables.pilot_collection.push({ id: 'invalid' });
    bad.sha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(bad.payload))
      .digest('hex');
    write(bad);
    assert.throws(
      () => readPilotBackup(file),
      (e) => e.code === 'BACKUP_COLLECTION_INVALID',
    );
    write({ ...archive, sha256: '0'.repeat(64) });
    assert.throws(() => readPilotBackup(file), /checksum/);
  } finally {
    client.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
