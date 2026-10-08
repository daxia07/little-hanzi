import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  sealArchive,
  openArchive,
  MAX_ARCHIVE_PLAINTEXT,
  MAX_CORPUS_ARCHIVE_PLAINTEXT,
  MAX_ARCHIVE_ENVELOPE,
  MAX_CORPUS_ARCHIVE_ENVELOPE,
} from '../../scripts/pilot-ops-archive.mjs';
const key = crypto.randomBytes(32),
  keys = new Map([['qa-key', key]]),
  expected = {
    environment: 'synthetic',
    sourceInstallationId: 'qa-source',
    opsInstallationId: 'qa-ops',
  };
const metadata = {
  ...expected,
  archiveId: 'qa-archive',
  candidateId: 'qa-build',
  sourceDigest: 'sha256:' + '1'.repeat(64),
  artifactDigest: 'sha256:' + '2'.repeat(64),
  schemaDigest: 'sha256:' + '3'.repeat(64),
  createdAt: Date.now(),
  keyId: 'qa-key',
  payloadFormat: 'pilot-admin-backup-6',
};
assert.equal(MAX_ARCHIVE_PLAINTEXT, 10 * 1024 * 1024);
assert.equal(MAX_ARCHIVE_ENVELOPE, 15 * 1024 * 1024);
assert.equal(MAX_CORPUS_ARCHIVE_PLAINTEXT, 128 * 1024 * 1024);
assert.equal(MAX_CORPUS_ARCHIVE_ENVELOPE, 172 * 1024 * 1024);
const bytes = Buffer.alloc(MAX_ARCHIVE_PLAINTEXT + 1, 97);
const envelope = sealArchive({ bytes, metadata, key });
assert.deepEqual(openArchive({ envelope, keys, expected }).bytes, bytes);
for (const format of [
  'pilot-admin-backup-4',
  'pilot-admin-backup-5',
  'pilot-ops-backup-3',
  'pilot-admin-backup-7',
])
  assert.throws(
    () =>
      sealArchive({
        bytes,
        metadata: { ...metadata, payloadFormat: format },
        key,
      }),
    { code: 'OPS_ARCHIVE_SIZE' },
  );
assert.throws(() => openArchive({ envelope, keys: new Map(), expected }), {
  code: 'OPS_ARCHIVE_KEY',
});
const bad = structuredClone(envelope),
  tag = Buffer.from(bad.tag, 'base64url');
tag[0] ^= 1;
bad.tag = tag.toString('base64url');
assert.throws(() => openArchive({ envelope: bad, keys, expected }), {
  code: 'OPS_ARCHIVE_AUTH',
});
fs.writeFileSync(
  process.argv[2],
  JSON.stringify(
    {
      id: 'AC606-crypto',
      outcome: 'PASS',
      actualBytes: bytes.length,
      v6RoundTrip: true,
      oldAndOpsPlusOneRefused: 4,
      wrongKeyRefused: true,
      tagRefused: true,
      limits: '128/172 constants checked; exact V6 maximum allocation NOT RUN',
    },
    null,
    2,
  ),
);
