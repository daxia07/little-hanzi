// Independent real crypto/file probes. No application/DB/service execution.
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
} from '../../scripts/pilot-ops-archive.mjs';
const sha = (b) =>
  'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const sorted = (v) =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])]),
        )
      : v;
const metadata = () => ({
  payloadFormat: 'pilot-ops-backup-1',
  archiveId: 'qa-independent',
  environment: 'qa-only',
  sourceInstallationId: 'learning-qa',
  opsInstallationId: 'ops-qa',
  candidateId: 'r4-qa',
  sourceDigest: 'sha256:' + '1'.repeat(64),
  artifactDigest: 'sha256:' + '2'.repeat(64),
  schemaDigest: 'sha256:' + '3'.repeat(64),
  createdAt: Date.UTC(2026, 8, 27, 2),
  keyId: 'ephemeral-qa',
});
const expected = {
  environment: 'qa-only',
  sourceInstallationId: 'learning-qa',
  opsInstallationId: 'ops-qa',
};
function independentSeal(bytes, key, meta) {
  const nonce = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: 16,
    });
  cipher.setAAD(
    Buffer.from(
      JSON.stringify(
        sorted({ format: 'pilot-encrypted-archive-1', metadata: meta }),
      ),
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    format: 'pilot-encrypted-archive-1',
    metadata: meta,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}
test('AQ01 independent AES-GCM opens emitted bytes using literal frozen AAD', () => {
  const key = crypto.randomBytes(32),
    bytes = Buffer.from('{"qa":true}');
  const e = sealArchive({ bytes, metadata: metadata(), key });
  const d = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(e.nonce, 'base64url'),
    { authTagLength: 16 },
  );
  d.setAAD(
    Buffer.from(
      JSON.stringify(
        sorted({ format: 'pilot-encrypted-archive-1', metadata: e.metadata }),
      ),
    ),
  );
  d.setAuthTag(Buffer.from(e.tag, 'base64url'));
  assert.deepEqual(
    Buffer.concat([
      d.update(Buffer.from(e.ciphertext, 'base64url')),
      d.final(),
    ]),
    bytes,
  );
  assert.equal(e.metadata.plaintextDigest, sha(bytes));
  assert.deepEqual(
    Object.keys(e).sort(),
    ['format', 'metadata', 'nonce', 'ciphertext', 'tag'].sort(),
  );
});
test('AQ02 valid authentication cannot hide a false plaintext digest', () => {
  const key = crypto.randomBytes(32),
    bytes = Buffer.from('{"qa":true}'),
    keys = new Map([['ephemeral-qa', key]]);
  const valid = independentSeal(bytes, key, {
    ...metadata(),
    plaintextDigest: sha(bytes),
  });
  assert.deepEqual(
    openArchive({ envelope: valid, keys, expected }).bytes,
    bytes,
  );
  const wrong = independentSeal(bytes, key, {
    ...metadata(),
    plaintextDigest: 'sha256:' + '0'.repeat(64),
  });
  assert.throws(() => openArchive({ envelope: wrong, keys, expected }), {
    code: 'OPS_ARCHIVE_DIGEST',
  });
});
test('AQ03 secure read refuses a real hard-linked archive', () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-r4-independent-'),
  );
  fs.chmodSync(root, 0o700);
  try {
    const store = new PrivateArchiveStore(root);
    store.put('original', Buffer.from('synthetic ciphertext'));
    fs.linkSync(
      path.join(root, 'original.hanzi'),
      path.join(root, 'alias.hanzi'),
    );
    assert.throws(() => store.get('original'), { code: 'OPS_OBJECT_UNSAFE' });
    assert.throws(() => store.get('alias'), { code: 'OPS_OBJECT_UNSAFE' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('AQ04 digest-bound deletion refuses an object replaced after secure read', () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-r4-independent-'),
  );
  fs.chmodSync(root, 0o700);
  const originalStat = fs.lstatSync;
  let replaced = false;
  try {
    const store = new PrivateArchiveStore(root),
      oldBytes = Buffer.from('verified object A'),
      newBytes = Buffer.from('unrelated object B');
    const saved = store.put('target', oldBytes),
      target = path.join(root, 'target.hanzi'),
      replacement = path.join(root, 'replacement.hanzi');
    fs.writeFileSync(replacement, newBytes, { mode: 0o600 });
    let fileStats = 0;
    fs.lstatSync = function (file, ...args) {
      if (file === target && ++fileStats === 3) {
        fs.renameSync(replacement, target);
        replaced = true;
      }
      return originalStat.call(fs, file, ...args);
    };
    let failure;
    try {
      store.delete('target', saved.digest);
    } catch (error) {
      failure = error;
    }
    assert.equal(replaced, true, 'Actual replacement barrier must execute');
    assert.equal(
      failure?.code,
      'OPS_OBJECT_CHANGED',
      'Changed identity must refuse deletion',
    );
    assert.deepEqual(
      fs.readFileSync(target),
      newBytes,
      'Replacement must not be removed as the old verified object',
    );
  } finally {
    fs.lstatSync = originalStat;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
