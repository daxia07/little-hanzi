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
  dailySlot,
  retentionPoints,
  backupHealth,
} from '../scripts/pilot-ops-archive.mjs';

const key = Buffer.alloc(32, 7);
const data = Buffer.from(JSON.stringify({ synthetic: 'private QA text' }));
const metadata = () => ({
  payloadFormat: 'pilot-admin-backup-4',
  archiveId: 'archive-test-1',
  environment: 'isolated-qa',
  sourceInstallationId: 'learning-test-1',
  opsInstallationId: 'ops-test-1',
  candidateId: 'readiness-r4-test',
  sourceDigest: 'sha256:' + '1'.repeat(64),
  artifactDigest: 'sha256:' + '2'.repeat(64),
  schemaDigest: 'sha256:' + '3'.repeat(64),
  createdAt: Date.UTC(2026, 8, 20, 2),
  keyId: 'qa-key-1',
});
const keys = new Map([['qa-key-1', key]]);
const expected = {
  environment: 'isolated-qa',
  sourceInstallationId: 'learning-test-1',
  opsInstallationId: 'ops-test-1',
};

test('[R4-E-005] real AEAD roundtrip binds metadata, plaintext and a fresh nonce', () => {
  const first = sealArchive({ bytes: data, metadata: metadata(), key });
  const second = sealArchive({ bytes: data, metadata: metadata(), key });
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(Buffer.from(first.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(first.tag, 'base64url').length, 16);
  assert(!JSON.stringify(first).includes('private QA text'));
  assert.deepEqual(
    openArchive({ envelope: first, keys, expected }).bytes,
    data,
  );
  for (const change of [
    (e) => {
      e.metadata.candidateId = 'different-build';
    },
    (e) => {
      e.metadata.plaintextDigest = 'sha256:' + '0'.repeat(64);
    },
    (e) => {
      e.metadata.schemaDigest = 'sha256:' + '0'.repeat(64);
    },
    (e) => {
      e.tag = Buffer.alloc(16).toString('base64url');
    },
    (e) => {
      e.ciphertext = Buffer.alloc(data.length).toString('base64url');
    },
    (e) => {
      e.metadata.extra = true;
    },
    (e) => {
      e.ciphertext += '=';
    },
  ]) {
    const value = structuredClone(first);
    change(value);
    assert.throws(
      () => openArchive({ envelope: value, keys, expected }),
      /OPS_ARCHIVE_/,
    );
  }
  assert.throws(
    () =>
      openArchive({
        envelope: first,
        keys,
        expected: { ...expected, environment: 'another' },
      }),
    /OPS_ARCHIVE_SCOPE/,
  );
  assert.throws(
    () =>
      sealArchive({
        bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
        metadata: metadata(),
        key,
      }),
    /OPS_ARCHIVE_SIZE/,
  );
});

test('[R4-E-005][R4-E-008] rotation keeps old-key recovery explicit and rejects unknown or wrong keys', () => {
  const envelope = sealArchive({ bytes: data, metadata: metadata(), key });
  assert.throws(
    () => openArchive({ envelope, keys: new Map(), expected }),
    /OPS_ARCHIVE_KEY/,
  );
  assert.throws(
    () =>
      openArchive({
        envelope,
        keys: new Map([['qa-key-1', crypto.randomBytes(32)]]),
        expected,
      }),
    /OPS_ARCHIVE_AUTH/,
  );
  const rotated = new Map([...keys, ['qa-key-2', crypto.randomBytes(32)]]);
  assert.deepEqual(
    openArchive({ envelope, keys: rotated, expected }).bytes,
    data,
  );
  assert.throws(
    () =>
      sealArchive({ bytes: data, metadata: metadata(), key: Buffer.alloc(16) }),
    /OPS_ARCHIVE_KEY/,
  );
});

test('[R4-E-005][R4-E-007] actual private files are immutable, verified on read and removed only by exact identity', () => {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-ops-archive-test-'),
  );
  fs.chmodSync(work, 0o700);
  try {
    const root = path.join(work, 'objects');
    fs.mkdirSync(root, { mode: 0o700 });
    const store = new PrivateArchiveStore(root);
    const bytes = Buffer.from(
      JSON.stringify(sealArchive({ bytes: data, metadata: metadata(), key })),
    );
    const saved = store.put('qa-object-1', bytes);
    assert.equal(
      fs.statSync(path.join(root, 'qa-object-1.hanzi')).mode & 0o777,
      0o600,
    );
    assert.deepEqual(store.get('qa-object-1'), bytes);
    assert.throws(() => store.put('qa-object-1', bytes), /OPS_OBJECT_EXISTS/);
    assert.throws(() => store.get('../outside'), /OPS_OBJECT_ID/);
    assert.throws(
      () => store.delete('qa-object-1', 'sha256:' + '0'.repeat(64)),
      /OPS_OBJECT_CHANGED/,
    );
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep', { mode: 0o600 });
    store.delete('qa-object-1', saved.digest);
    assert.equal(store.get('qa-object-1'), null);
    assert.equal(
      fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'),
      'keep',
    );
    fs.symlinkSync(
      path.join(root, 'unrelated.txt'),
      path.join(root, 'qa-link.hanzi'),
    );
    assert.throws(() => store.get('qa-link'), /OPS_OBJECT_/);
    fs.chmodSync(root, 0o755);
    assert.throws(() => new PrivateArchiveStore(root), /OPS_PRIVATE_/);
    const linked = path.join(work, 'linked');
    fs.symlinkSync(root, linked);
    assert.throws(() => new PrivateArchiveStore(linked), /OPS_PRIVATE_/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[R4-E-007] seven daily/four Sunday weekly points form a union and never sweep unknown objects', () => {
  const base = Date.UTC(2026, 7, 30, 2);
  const points = Array.from({ length: 30 }, (_, n) => ({
    id: 'point-' + String(n).padStart(2, '0'),
    slot: base + n * 86400000,
    verified: true,
  }));
  const result = retentionPoints([
    ...points,
    { id: 'unknown', slot: base + 31 * 86400000, verified: false },
  ]);
  const expectedKeep = [
    'point-07',
    'point-14',
    'point-21',
    'point-23',
    'point-24',
    'point-25',
    'point-26',
    'point-27',
    'point-28',
    'point-29',
  ];
  assert.deepEqual(
    [...result.keep].sort((a, b) => a.localeCompare(b)),
    expectedKeep,
  );
  assert(!result.delete.includes('unknown'));
  assert(result.quarantine.includes('unknown'));
  assert.deepEqual(retentionPoints([points[0]]).delete, []);
  assert.equal(
    dailySlot(Date.UTC(2026, 8, 27, 1, 59, 59, 999)),
    Date.UTC(2026, 8, 26, 2),
  );
  assert.equal(dailySlot(Date.UTC(2026, 8, 27, 2)), Date.UTC(2026, 8, 27, 2));
});

test('[R4-E-001][R4-E-006] freshness uses captured data, exact26h boundary and unknown monitor state', () => {
  const dataAt = Date.UTC(2026, 8, 26, 2);
  assert.equal(
    backupHealth({ now: dataAt + 26 * 3600000, dataAt, monitor: 'healthy' })
      .state,
    'healthy',
  );
  assert.equal(
    backupHealth({ now: dataAt + 26 * 3600000 + 1, dataAt, monitor: 'healthy' })
      .state,
    'stale',
  );
  assert.equal(
    backupHealth({ now: dataAt, dataAt: null, monitor: 'healthy' }).state,
    'missing',
  );
  assert.equal(
    backupHealth({ now: dataAt, dataAt, monitor: 'unknown' }).state,
    'unknown',
  );
  assert.equal(
    backupHealth({ now: dataAt, dataAt, monitor: 'failed' }).state,
    'failed',
  );
});
