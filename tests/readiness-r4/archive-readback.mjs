// Independent AES-GCM read of actual private runner files; no product crypto import.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const digest = (bytes) =>
  'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [
          k,
          value[k] && typeof value[k] === 'object'
            ? JSON.parse(canonical(value[k]))
            : value[k],
        ]),
    ),
  );
async function privateBytes(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o600);
  const handle = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    assert.equal(opened.ino, stat.ino);
    assert.equal(opened.dev, stat.dev);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function verifyPair(handoff, control, jobId) {
  const ops = handoff.operations;
  const readback = await control('/archive-readback', { jobId });
  assert.equal(readback.status, 200);
  assert.equal(readback.body.jobId, jobId);
  assert.equal(readback.body.archives.length, 2);
  assert.deepEqual(readback.body.archives.map((a) => a.kind).sort(), [
    'learning',
    'operations',
  ]);
  const root = await fs.realpath(ops.archiveRoot);
  const rootStat = await fs.lstat(root);
  assert(rootStat.isDirectory() && rootStat.uid === process.getuid());
  assert.equal(rootStat.mode & 0o777, 0o700);
  const ring = JSON.parse(
    (await privateBytes(ops.keyRingFile)).toString('utf8'),
  );
  assert.equal(ring.format, 'pilot-ops-keys-1');
  const summaries = [];
  for (const item of readback.body.archives) {
    assert(/^[A-Za-z0-9:_-]{1,120}$/.test(item.objectRef));
    const bytes = await privateBytes(
      path.join(root, item.objectRef + '.hanzi'),
    );
    assert(bytes.length <= 15 * 1024 * 1024);
    assert.equal(digest(bytes), item.ciphertextDigest);
    const envelope = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ['format', 'metadata', 'nonce', 'ciphertext', 'tag'].sort(),
    );
    assert.equal(envelope.format, 'pilot-encrypted-archive-1');
    const meta = envelope.metadata;
    assert.equal(meta.archiveId, item.id);
    assert.equal(meta.candidateId, handoff.candidateId);
    assert.equal(meta.sourceDigest, handoff.sourceDigest);
    assert.equal(meta.artifactDigest, handoff.artifactDigest);
    assert.equal(meta.sourceInstallationId, ops.learningInstallationId);
    assert.equal(meta.opsInstallationId, ops.opsInstallationId);
    const entry = ring.keys.find((k) => k.id === meta.keyId);
    assert(entry, 'Private ring must hold actual archive key');
    const decode = (value, length) => {
      const b = Buffer.from(value, 'base64url');
      assert.equal(b.toString('base64url'), value);
      if (length) assert.equal(b.length, length);
      return b;
    };
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      decode(entry.value, 32),
      decode(envelope.nonce, 12),
    );
    decipher.setAAD(
      Buffer.from(canonical({ format: envelope.format, metadata: meta })),
    );
    decipher.setAuthTag(decode(envelope.tag, 16));
    const plain = Buffer.concat([
      decipher.update(decode(envelope.ciphertext)),
      decipher.final(),
    ]);
    assert(plain.length <= 10 * 1024 * 1024);
    assert.equal(digest(plain), meta.plaintextDigest);
    const archive = JSON.parse(plain.toString('utf8'));
    assert.equal(archive.payload.format, meta.payloadFormat);
    assert.equal(
      archive.payload.sourceInstallationId,
      meta.sourceInstallationId,
    );
    assert.equal(
      Object.keys(archive.payload.tables).length,
      item.kind === 'learning' ? 35 : 8,
    );
    assert(
      !plain.includes(Buffer.from(entry.value)),
      'Private key must not occur in plaintext',
    );
    summaries.push({
      kind: item.kind,
      archiveId: item.id,
      ciphertextDigest: digest(bytes),
      plaintextDigest: digest(plain),
      tableCount: Object.keys(archive.payload.tables).length,
    });
  }
  return {
    method:
      'Actual loopback readback plus independent Node AES-256-GCM/private-file verification',
    objects: summaries,
  };
}
