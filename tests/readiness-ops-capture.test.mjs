import test from 'node:test';
import assert from 'node:assert/strict';
import * as backup from '../scripts/pilot-story-libsql-backup.mjs';

test('[R4-E-005][R4-E-008] private capture has explicit identity without inventing a QA manifest', async () => {
  assert.equal(typeof backup.createStoryBackupPayload, 'function');
  let queries = 0;
  const client = {
    execute() {
      queries++;
    },
    batch() {
      queries++;
    },
  };
  await assert.rejects(
    () =>
      backup.createStoryBackupPayload({
        client,
        installationId: '',
        candidateId: 'test',
        sourceRoot: process.cwd(),
      }),
    /IDENTITY/,
  );
  assert.equal(queries, 0);
});

test('[R4-E-008] corrupt in-memory archive refuses before destination access; QA file wrapper still requires a real manifest', async () => {
  assert.equal(typeof backup.restoreStoryBackupPayload, 'function');
  let queries = 0;
  const client = {
    execute() {
      queries++;
    },
    batch() {
      queries++;
    },
  };
  await assert.rejects(
    () =>
      backup.restoreStoryBackupPayload({
        client,
        installationId: 'new-install',
        sourceRoot: process.cwd(),
        archive: { payload: {}, sha256: '0'.repeat(64) },
      }),
    /CHECKSUM/,
  );
  assert.equal(queries, 0);
  await assert.rejects(
    () =>
      backup.backupStoryLibsql({
        manifest: { snapshot: process.cwd() },
        client,
        installationId: 'test',
        filePath: '/private/tmp/must-not-write.json',
      }),
    /owned runner/,
  );
  assert.equal(queries, 0);
});
