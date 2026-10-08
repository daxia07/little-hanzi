/** Private CLI admission. Never imported by browser code. */
import crypto from 'node:crypto';
import {
  readPrivateFile,
  privateDirectory,
  opsArchiveError,
} from './pilot-ops-archive.mjs';
import { verifyNodeManifest } from './readiness-node-runner.mjs';
const fail = () => {
  throw opsArchiveError('OPS_CONFIG_INVALID');
};
const opaque = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const configKeys = [
  'format',
  'environment',
  'localSynthetic',
  'installationId',
  'opsInstallationId',
  'manifestPath',
  'learningURL',
  'operationsURL',
  'healthURL',
  'learningTokenFile',
  'operationsTokenFile',
  'keyFiles',
  'activeKeyId',
  'archiveIssuersFile',
  'archiveRoot',
];
function jsonFile(file) {
  return JSON.parse(readPrivateFile(file, 1024 * 1024).toString('utf8'));
}
function checkedURL(value, local, health = false) {
  if (typeof value !== 'string' || value.length > 2048) fail();
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) fail();
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:') {
    if (!local || !loopback || !url.port) fail();
  } else if (
    !['https:', ...(health ? [] : ['libsql:'])].includes(url.protocol) ||
    loopback
  )
    fail();
  if (!health && url.pathname !== '/') fail();
  if (health && url.pathname !== '/api/pilot/health') fail();
  return url.href;
}
function tokenFile(file) {
  const value = readPrivateFile(file, 16384).toString('utf8').trim();
  if (!value || value.length > 8192) fail();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) fail();
  }
  return value;
}

export function loadOpsConfig(
  file,
  { environment = process.env, verifyManifest = verifyNodeManifest } = {},
) {
  const keys = new Map();
  try {
    const c = jsonFile(file);
    if (
      !exact(c, configKeys) ||
      c.format !== 'pilot-ops-config-1' ||
      !['synthetic', 'staging', 'pilot'].includes(c.environment) ||
      typeof c.localSynthetic !== 'boolean' ||
      !opaque(c.installationId) ||
      !opaque(c.opsInstallationId) ||
      c.installationId === c.opsInstallationId ||
      !opaque(c.activeKeyId)
    )
      fail();
    if (
      environment.NODE_ENV === 'production' ||
      environment.VERCEL !== undefined ||
      environment.VERCEL_ENV !== undefined ||
      (c.localSynthetic && c.environment !== 'synthetic')
    )
      fail();
    const learningURL = checkedURL(c.learningURL, c.localSynthetic),
      operationsURL = checkedURL(c.operationsURL, c.localSynthetic),
      healthURL = checkedURL(c.healthURL, c.localSynthetic, true);
    if (learningURL === operationsURL) fail();
    privateDirectory(c.archiveRoot);
    const manifest = verifyManifest(jsonFile(c.manifestPath), { built: true });
    if (
      manifest.phase !== 'r4' ||
      !opaque(manifest.candidateId) ||
      typeof manifest.snapshot !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.digest) ||
      !/^[0-9a-f]{64}$/.test(manifest.artifactDigest)
    )
      fail();
    if (
      !c.keyFiles ||
      typeof c.keyFiles !== 'object' ||
      Array.isArray(c.keyFiles) ||
      Object.keys(c.keyFiles).length < 1 ||
      Object.keys(c.keyFiles).length > 16
    )
      fail();
    for (const [keyId, keyFile] of Object.entries(c.keyFiles)) {
      if (!opaque(keyId)) fail();
      const bytes = readPrivateFile(keyFile, 32);
      if (bytes.length !== 32) fail();
      keys.set(keyId, bytes);
    }
    if (!keys.has(c.activeKeyId)) fail();
    const archiveIssuers = jsonFile(c.archiveIssuersFile);
    if (!Array.isArray(archiveIssuers) || archiveIssuers.length > 32) fail();
    const issuerIds = new Set();
    for (const issuer of archiveIssuers) {
      if (
        !exact(issuer, [
          'issuerId',
          'publicKeyJwk',
          'purpose',
          'revokedAt',
          'notBefore',
        ]) ||
        !opaque(issuer.issuerId) ||
        issuerIds.has(issuer.issuerId) ||
        !['release', 'candidate'].includes(issuer.purpose) ||
        !(
          issuer.revokedAt === null ||
          (Number.isSafeInteger(issuer.revokedAt) && issuer.revokedAt >= 0)
        ) ||
        !Number.isSafeInteger(issuer.notBefore) ||
        issuer.notBefore < 0 ||
        !exact(issuer.publicKeyJwk, ['kty', 'crv', 'x']) ||
        issuer.publicKeyJwk.kty !== 'OKP' ||
        issuer.publicKeyJwk.crv !== 'Ed25519' ||
        typeof issuer.publicKeyJwk.x !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(issuer.publicKeyJwk.x) ||
        Buffer.from(issuer.publicKeyJwk.x, 'base64url').toString(
          'base64url',
        ) !== issuer.publicKeyJwk.x
      )
        fail();
      crypto.createPublicKey({ key: issuer.publicKeyJwk, format: 'jwk' });
      issuerIds.add(issuer.issuerId);
    }
    const loaded = {
      sourceRoot: manifest.snapshot,
      scope: {
        environment: c.environment,
        installationId: c.installationId,
        opsInstallationId: c.opsInstallationId,
      },
      learningURL,
      operationsURL,
      healthURL,
      learningToken: tokenFile(c.learningTokenFile),
      operationsToken: tokenFile(c.operationsTokenFile),
      keys,
      activeKeyId: c.activeKeyId,
      archiveIssuers,
      archiveRoot: c.archiveRoot,
      build: () => ({
        candidateId: manifest.candidateId,
        sourceDigest: 'sha256:' + manifest.digest,
        artifactDigest: 'sha256:' + manifest.artifactDigest,
      }),
    };
    loaded.dispose = () => {
      for (const bytes of keys.values()) bytes.fill(0);
      keys.clear();
      loaded.learningToken = '';
      loaded.operationsToken = '';
    };
    return loaded;
  } catch {
    for (const bytes of keys.values()) bytes.fill(0);
    keys.clear();
    fail();
  }
}
