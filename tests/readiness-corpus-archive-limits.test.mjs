import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sealArchive,
  openArchive,
  PrivateArchiveStore,
} from '../scripts/pilot-ops-archive.mjs';

const MiB = 1024 * 1024;
const key = crypto.randomBytes(32);
const metadata = (payloadFormat) => ({
  payloadFormat,
  archiveId: 'qa-corpus-archive',
  environment: 'qa-corpus',
  sourceInstallationId: 'qa-source',
  opsInstallationId: 'qa-ops',
  candidateId: 'qa-corpus-candidate',
  sourceDigest: 'sha256:' + '1'.repeat(64),
  artifactDigest: 'sha256:' + '2'.repeat(64),
  schemaDigest: 'sha256:' + '3'.repeat(64),
  createdAt: 1790474400000,
  keyId: 'qa-key',
});
const expected = {
  environment: 'qa-corpus',
  sourceInstallationId: 'qa-source',
  opsInstallationId: 'qa-ops',
};
const open = (envelope) =>
  openArchive({ envelope, keys: new Map([['qa-key', key]]), expected });

test('[R6-E-013] V6 encrypts and authenticates an exact128MiB payload', () => {
  const bytes = Buffer.alloc(128 * MiB, 0x61);
  const envelope = sealArchive({
    bytes,
    metadata: metadata('pilot-admin-backup-6'),
    key,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 172 * MiB);
  assert.ok(open(envelope).bytes.equals(bytes));
});

test('[R6-E-013] V6 refuses one byte over128MiB before encryption', () => {
  assert.throws(
    () =>
      sealArchive({
        bytes: Buffer.alloc(128 * MiB + 1),
        metadata: metadata('pilot-admin-backup-6'),
        key,
      }),
    (e) => e.code === 'OPS_ARCHIVE_SIZE',
  );
});

test('[R6-E-013/015] old learning and all operations retain10MiB and unknown formats fail', () => {
  const oversized = Buffer.alloc(10 * MiB + 1);
  for (const format of [
    'pilot-admin-backup-4',
    'pilot-admin-backup-5',
    'pilot-ops-backup-1',
    'pilot-ops-backup-2',
    'pilot-ops-backup-3',
  ]) {
    assert.throws(
      () => sealArchive({ bytes: oversized, metadata: metadata(format), key }),
      (e) => e.code === 'OPS_ARCHIVE_SIZE',
      format,
    );
  }
  assert.throws(
    () =>
      sealArchive({
        bytes: Buffer.from('x'),
        metadata: metadata('pilot-admin-backup-7'),
        key,
      }),
    (e) => e.code === 'OPS_ARCHIVE_METADATA',
  );
});

test('[R6-E-013] claimed format cannot change authenticated metadata', () => {
  const envelope = sealArchive({
    bytes: Buffer.from('opaque domain bytes'),
    metadata: metadata('pilot-admin-backup-6'),
    key,
  });
  const changed = structuredClone(envelope);
  changed.metadata.payloadFormat = 'pilot-admin-backup-5';
  assert.throws(
    () => open(changed),
    (e) => e.code === 'OPS_ARCHIVE_AUTH',
  );
});

test('[R6-E-013] private store admits larger V6 envelopes but refuses untyped oversized objects without effects', () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r6-archive-limits-')),
  );
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(
    path.join(directory, '.qa-owned'),
    'synthetic archive limit test\n',
    { mode: 0o600 },
  );
  try {
    const store = new PrivateArchiveStore(directory);
    const envelope = sealArchive({
      bytes: Buffer.alloc(12 * MiB, 0x61),
      metadata: metadata('pilot-admin-backup-6'),
      key,
    });
    const serialized = Buffer.from(JSON.stringify(envelope));
    assert.ok(serialized.length > 15 * MiB);
    store.put('qa-corpus', serialized);
    assert.ok(store.get('qa-corpus').equals(serialized));
    assert.throws(
      () => store.put('qa-untyped', Buffer.alloc(15 * MiB + 1)),
      (e) => e.code === 'OPS_OBJECT_SIZE',
    );
    assert.equal(
      fs.existsSync(path.join(directory, 'qa-untyped.hanzi')),
      false,
    );
    const digest =
      'sha256:' + crypto.createHash('sha256').update(serialized).digest('hex');
    assert.deepEqual(store.delete('qa-corpus', digest), {
      deleted: true,
      absent: true,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
