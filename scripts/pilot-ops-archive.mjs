/** Private R4 archive primitives. This module is never imported by browser code. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ARCHIVE_PLAINTEXT = 10 * 1024 * 1024;
export const MAX_ARCHIVE_ENVELOPE = 15 * 1024 * 1024;
export const MAX_CORPUS_ARCHIVE_PLAINTEXT = 128 * 1024 * 1024;
export const MAX_CORPUS_ARCHIVE_ENVELOPE = 172 * 1024 * 1024;
const limits = (format) =>
  format === 'pilot-admin-backup-6'
    ? {
        plaintext: MAX_CORPUS_ARCHIVE_PLAINTEXT,
        envelope: MAX_CORPUS_ARCHIVE_ENVELOPE,
      }
    : { plaintext: MAX_ARCHIVE_PLAINTEXT, envelope: MAX_ARCHIVE_ENVELOPE };
const FORMAT = 'pilot-encrypted-archive-1';
const META_KEYS = [
  'payloadFormat',
  'archiveId',
  'environment',
  'sourceInstallationId',
  'opsInstallationId',
  'candidateId',
  'sourceDigest',
  'artifactDigest',
  'schemaDigest',
  'plaintextDigest',
  'createdAt',
  'keyId',
];
export const archiveDigest = (bytes) =>
  'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const digestShape = (s) =>
  typeof s === 'string' && /^sha256:[0-9a-f]{64}$/.test(s);
const opaque = (s) =>
  typeof s === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(s);
const integer = (n) =>
  Number.isSafeInteger(n) && n >= 0 && n <= 253402300799999;
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const canonical = (value) =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          value[key] && typeof value[key] === 'object'
            ? JSON.parse(canonical(value[key]))
            : value[key],
        ]),
    ),
  );
export function opsArchiveError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function fail(code) {
  throw opsArchiveError(code);
}
function validateMetadata(value) {
  if (
    !exact(value, META_KEYS) ||
    ![
      'pilot-admin-backup-4',
      'pilot-admin-backup-5',
      'pilot-admin-backup-6',
      'pilot-ops-backup-1',
      'pilot-ops-backup-2',
      'pilot-ops-backup-3',
    ].includes(value.payloadFormat) ||
    ![
      'archiveId',
      'environment',
      'sourceInstallationId',
      'opsInstallationId',
      'candidateId',
      'keyId',
    ].every((k) => opaque(value[k])) ||
    ![
      'sourceDigest',
      'artifactDigest',
      'schemaDigest',
      'plaintextDigest',
    ].every((k) => digestShape(value[k])) ||
    !integer(value.createdAt)
  )
    fail('OPS_ARCHIVE_METADATA');
}
function keyBytes(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('OPS_ARCHIVE_KEY');
  return key;
}
function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    fail('OPS_ARCHIVE_ENCODING');
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.toString('base64url') !== value ||
    (length !== undefined && bytes.length !== length)
  )
    fail('OPS_ARCHIVE_ENCODING');
  return bytes;
}
function aad(metadata) {
  return Buffer.from(canonical({ format: FORMAT, metadata }));
}

export function sealArchive({ bytes, metadata, key }) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > limits(metadata?.payloadFormat).plaintext
  )
    fail('OPS_ARCHIVE_SIZE');
  if (
    !exact(
      metadata,
      META_KEYS.filter((k) => k !== 'plaintextDigest'),
    )
  )
    fail('OPS_ARCHIVE_METADATA');
  const bound = { ...metadata, plaintextDigest: archiveDigest(bytes) };
  validateMetadata(bound);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad(bound));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    format: FORMAT,
    metadata: bound,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

/** Authentication is necessary; callers must also validate the decrypted domain payload. */
export function openArchive({ envelope, keys, expected }) {
  if (
    !exact(envelope, ['format', 'metadata', 'nonce', 'ciphertext', 'tag']) ||
    envelope.format !== FORMAT
  )
    fail('OPS_ARCHIVE_FORMAT');
  validateMetadata(envelope.metadata);
  const maximum = limits(envelope.metadata.payloadFormat);
  if (Buffer.byteLength(JSON.stringify(envelope)) > maximum.envelope)
    fail('OPS_ARCHIVE_SIZE');
  if (
    !exact(expected, [
      'environment',
      'sourceInstallationId',
      'opsInstallationId',
    ]) ||
    Object.entries(expected).some(
      ([k, v]) => !opaque(v) || envelope.metadata[k] !== v,
    )
  )
    fail('OPS_ARCHIVE_SCOPE');
  if (!(keys instanceof Map) || !keys.has(envelope.metadata.keyId))
    fail('OPS_ARCHIVE_KEY');
  const key = keyBytes(keys.get(envelope.metadata.keyId));
  const nonce = decode(envelope.nonce, 12),
    tag = decode(envelope.tag, 16),
    ciphertext = decode(envelope.ciphertext);
  if (ciphertext.length > maximum.plaintext) fail('OPS_ARCHIVE_SIZE');
  let bytes;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(envelope.metadata));
    decipher.setAuthTag(tag);
    bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail('OPS_ARCHIVE_AUTH');
  }
  if (!bytes.length || bytes.length > maximum.plaintext)
    fail('OPS_ARCHIVE_SIZE');
  if (archiveDigest(bytes) !== envelope.metadata.plaintextDigest)
    fail('OPS_ARCHIVE_DIGEST');
  return { bytes, metadata: structuredClone(envelope.metadata) };
}

function owned(stat, permission) {
  return (
    (stat.mode & 0o777) === permission &&
    (!process.getuid || stat.uid === process.getuid())
  );
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export function privateDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (
      !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory ||
      fs.realpathSync(directory) !== directory ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !owned(stat, 0o700)
    )
      fail('OPS_PRIVATE_DIRECTORY');
    return stat;
  } catch {
    fail('OPS_PRIVATE_DIRECTORY');
  }
}
export function readPrivateFile(file, maximum = MAX_ARCHIVE_ENVELOPE) {
  let fd;
  try {
    if (
      !path.isAbsolute(file) ||
      path.normalize(file) !== file ||
      fs.realpathSync(file) !== file
    )
      fail('OPS_PRIVATE_FILE');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !owned(before, 0o600) ||
      before.size > maximum
    )
      fail('OPS_PRIVATE_FILE');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      !sameFile(before, after) ||
      !sameFile(after, current) ||
      current.isSymbolicLink() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size ||
      !owned(current, 0o600)
    )
      fail('OPS_PRIVATE_FILE');
    return bytes;
  } catch {
    fail('OPS_PRIVATE_FILE');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The object store does not authenticate or validate domain payloads. Above the
// historical generic-object bound, it admits only a structurally named V6
// envelope. openArchive and the selected source adapter still validate both
// cryptographic and semantic format bindings before recovery effects.
function admitStoredObject(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > MAX_CORPUS_ARCHIVE_ENVELOPE
  )
    fail('OPS_OBJECT_SIZE');
  if (bytes.length <= MAX_ARCHIVE_ENVELOPE) return;
  try {
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (
      !exact(envelope, ['format', 'metadata', 'nonce', 'ciphertext', 'tag']) ||
      envelope.format !== FORMAT ||
      envelope.metadata?.payloadFormat !== 'pilot-admin-backup-6' ||
      typeof envelope.nonce !== 'string' ||
      typeof envelope.ciphertext !== 'string' ||
      typeof envelope.tag !== 'string'
    )
      fail('OPS_OBJECT_SIZE');
    validateMetadata(envelope.metadata);
  } catch {
    fail('OPS_OBJECT_SIZE');
  }
}

export class PrivateArchiveStore {
  constructor(root) {
    this.root = root;
    this.identity = privateDirectory(root);
  }
  check() {
    if (!sameFile(this.identity, privateDirectory(this.root)))
      fail('OPS_PRIVATE_DIRECTORY');
  }
  file(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id))
      fail('OPS_OBJECT_ID');
    return path.join(this.root, id + '.hanzi');
  }
  put(id, bytes) {
    this.check();
    const file = this.file(id);
    admitStoredObject(bytes);
    let fd;
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      this.check();
      if (
        !stat.isFile() ||
        !owned(stat, 0o600) ||
        !sameFile(stat, fs.lstatSync(file))
      )
        fail('OPS_OBJECT_CHANGED');
    } catch (e) {
      if (e?.code === 'EEXIST') fail('OPS_OBJECT_EXISTS');
      if (typeof e?.code === 'string' && e.code.startsWith('OPS_')) throw e;
      fail('OPS_OBJECT_UNAVAILABLE');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const actual = this.get(id);
    if (!actual || !actual.equals(bytes)) fail('OPS_OBJECT_CHANGED');
    return { digest: archiveDigest(actual), byteSize: actual.length };
  }
  get(id) {
    this.check();
    const file = this.file(id);
    try {
      fs.lstatSync(file);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        this.check();
        return null;
      }
      fail('OPS_OBJECT_UNAVAILABLE');
    }
    let bytes;
    try {
      bytes = readPrivateFile(file, MAX_CORPUS_ARCHIVE_ENVELOPE);
      admitStoredObject(bytes);
    } catch {
      fail('OPS_OBJECT_UNSAFE');
    }
    this.check();
    return bytes;
  }
  delete(id, expectedDigest) {
    if (!digestShape(expectedDigest)) fail('OPS_OBJECT_CHANGED');
    this.check();
    const file = this.file(id);
    let before;
    try {
      before = fs.lstatSync(file);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        this.check();
        return { deleted: false, absent: true };
      }
      fail('OPS_OBJECT_UNAVAILABLE');
    }
    if (!before.isFile() || before.isSymbolicLink() || !owned(before, 0o600))
      fail('OPS_OBJECT_UNSAFE');
    let bytes;
    try {
      bytes = this.get(id);
    } catch {
      fail('OPS_OBJECT_CHANGED');
    }
    if (
      !bytes ||
      archiveDigest(bytes) !== expectedDigest ||
      !sameFile(before, fs.lstatSync(file))
    )
      fail('OPS_OBJECT_CHANGED');
    // Move the exact candidate out of its externally addressable name before
    // removing it. A replacement discovered after rename is preserved/restored.
    const quarantine = fs.mkdtempSync(path.join(this.root, '.ops-delete-'));
    fs.chmodSync(quarantine, 0o700);
    const isolated = path.join(quarantine, 'object.hanzi');
    try {
      fs.renameSync(file, isolated);
      const moved = fs.lstatSync(isolated);
      if (
        !sameFile(before, moved) ||
        archiveDigest(
          readPrivateFile(isolated, MAX_CORPUS_ARCHIVE_ENVELOPE),
        ) !== expectedDigest
      )
        fail('OPS_OBJECT_CHANGED');
      this.check();
      fs.unlinkSync(isolated);
      fs.rmdirSync(quarantine);
    } catch {
      // link is exclusive: never overwrite a newer pathname while putting an
      // unrelated moved object back. If restoration races, retain quarantine.
      try {
        fs.linkSync(isolated, file);
        fs.unlinkSync(isolated);
      } catch {}
      try {
        fs.rmdirSync(quarantine);
      } catch {}
      fail('OPS_OBJECT_CHANGED');
    }
    this.check();
    if (this.get(id) !== null) fail('OPS_OBJECT_CHANGED');
    return { deleted: true, absent: true };
  }
}

export function dailySlot(now) {
  if (!integer(now)) fail('OPS_TIME_INVALID');
  return Math.floor((now - 2 * 3600000) / 86400000) * 86400000 + 2 * 3600000;
}
export function retentionPoints(points) {
  if (
    !Array.isArray(points) ||
    points.length > 10000 ||
    new Set(points.map((p) => p.id)).size !== points.length ||
    points.some(
      (p) =>
        !opaque(p.id) ||
        !integer(p.slot) ||
        p.slot !== dailySlot(p.slot) ||
        typeof p.verified !== 'boolean',
    )
  )
    fail('OPS_RETENTION_INPUT');
  const order = (a, b) => b.slot - a.slot || b.id.localeCompare(a.id);
  const verified = points.filter((p) => p.verified).sort(order);
  const distinct = (values) => [
    ...new Map(values.map((p) => [p.slot, p])).values(),
  ];
  const daily = distinct(verified).slice(0, 7);
  const weekly = distinct(
    verified.filter((p) => new Date(p.slot).getUTCDay() === 0),
  ).slice(0, 4);
  const keep = new Set([...daily, ...weekly].map((p) => p.id));
  if (verified[0]) keep.add(verified[0].id);
  return {
    keep: [...keep],
    delete: verified.filter((p) => !keep.has(p.id)).map((p) => p.id),
    quarantine: points.filter((p) => !p.verified).map((p) => p.id),
  };
}
export function backupHealth({ now, dataAt, monitor }) {
  if (
    !integer(now) ||
    (dataAt !== null && (!integer(dataAt) || dataAt > now)) ||
    !['healthy', 'unknown', 'failed'].includes(monitor)
  )
    fail('OPS_TIME_INVALID');
  const ageMs = dataAt === null ? null : now - dataAt;
  return {
    state:
      monitor === 'unknown'
        ? 'unknown'
        : monitor === 'failed'
          ? 'failed'
          : dataAt === null
            ? 'missing'
            : ageMs > 26 * 3600000
              ? 'stale'
              : 'healthy',
    ageMs,
  };
}
