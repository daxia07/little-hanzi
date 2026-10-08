import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import { digest, exact, record, text } from '../curriculum/story-package.ts';
export interface Issuer {
  issuerId: string;
  publicKeyJwk: JsonWebKey;
  notBefore: number;
  revokedAt: number | null;
  purpose: 'release' | 'candidate';
}
export interface CurriculumTrust {
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  issuers: Issuer[];
  archiveIssuers: Issuer[];
}
export interface StoryCapability {
  installationId: string;
  contentDigest: string;
  namespace: string;
  childIds: string[];
  parentIds: string[];
}
export interface ProofReceipt {
  schemaVersion: 'r3-proof-receipt-1';
  receiptId: string;
  issuerId: string;
  issuedAt: number;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  lessonVersion: 'forest-01-v4';
  contentDigest: string;
  canonicalizationVersion: 's3-json-1';
  adapterId: 'forest-story';
  adapterVersion: 'forest-story-v1';
  evidenceInstallationId: string;
  targetInstallationId: string;
  namespace: string;
  syntheticOnly: boolean;
  scenarios: Array<{ id: string; outcome: 'PASS'; evidenceDigest: string }>;
  reportDigest: string;
}
export const REQUIRED_SCENARIOS = [
  'selection',
  'approval',
  'recognition',
  'help',
  'audio-unavailable',
  'restart',
  'duplicate-conflict',
  'delayed-review',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
export class StoryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = 'StoryError';
  }
}
export function fail(code: string, status = 409): never {
  throw new StoryError(code, status);
}
export function validIssuer(v: unknown): v is Issuer {
  return (
    exact(v, [
      'issuerId',
      'publicKeyJwk',
      'notBefore',
      'revokedAt',
      'purpose',
    ]) &&
    text(v.issuerId, 120) &&
    record(v.publicKeyJwk) &&
    v.publicKeyJwk.kty === 'OKP' &&
    v.publicKeyJwk.crv === 'Ed25519' &&
    text(v.publicKeyJwk.x, 100) &&
    !Object.hasOwn(v.publicKeyJwk, 'd') &&
    Number.isSafeInteger(v.notBefore) &&
    Number(v.notBefore) >= 0 &&
    (v.revokedAt === null ||
      (Number.isSafeInteger(v.revokedAt) &&
        Number(v.revokedAt) >= Number(v.notBefore))) &&
    (v.purpose === 'release' || v.purpose === 'candidate')
  );
}
export function parseTrust(v: unknown): CurriculumTrust | null {
  if (
    !exact(v, [
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'buildId',
      'issuers',
      'archiveIssuers',
    ]) ||
    !text(v.candidateId, 120) ||
    !text(v.buildId, 120) ||
    !digest(v.sourceDigest) ||
    !digest(v.artifactDigest) ||
    !Array.isArray(v.issuers) ||
    !Array.isArray(v.archiveIssuers) ||
    !v.issuers.every(validIssuer) ||
    !v.archiveIssuers.every(validIssuer) ||
    new Set(v.issuers.map((i) => i.issuerId)).size !== v.issuers.length ||
    new Set(v.archiveIssuers.map((i) => i.issuerId)).size !==
      v.archiveIssuers.length
  )
    return null;
  return v as unknown as CurriculumTrust;
}
export function parseCapability(v: unknown): StoryCapability | null {
  if (
    !exact(v, [
      'installationId',
      'contentDigest',
      'namespace',
      'childIds',
      'parentIds',
    ]) ||
    !text(v.installationId, 240) ||
    !digest(v.contentDigest) ||
    !text(v.namespace, 120) ||
    ![v.childIds, v.parentIds].every(
      (a) =>
        Array.isArray(a) &&
        a.length > 0 &&
        a.every((i) => text(i, 120)) &&
        new Set(a).size === a.length,
    )
  )
    return null;
  return v as unknown as StoryCapability;
}
export function validReceipt(v: unknown): v is ProofReceipt {
  if (
    !exact(v, [
      'schemaVersion',
      'receiptId',
      'issuerId',
      'issuedAt',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'buildId',
      'lessonVersion',
      'contentDigest',
      'canonicalizationVersion',
      'adapterId',
      'adapterVersion',
      'evidenceInstallationId',
      'targetInstallationId',
      'namespace',
      'syntheticOnly',
      'scenarios',
      'reportDigest',
    ]) ||
    v.schemaVersion !== 'r3-proof-receipt-1' ||
    v.lessonVersion !== 'forest-01-v4' ||
    v.canonicalizationVersion !== 's3-json-1' ||
    v.adapterId !== 'forest-story' ||
    v.adapterVersion !== 'forest-story-v1' ||
    !Number.isSafeInteger(v.issuedAt) ||
    Number(v.issuedAt) < 0 ||
    v.syntheticOnly !== true
  )
    return false;
  if (
    ![
      'receiptId',
      'issuerId',
      'candidateId',
      'buildId',
      'evidenceInstallationId',
      'targetInstallationId',
      'namespace',
    ].every((k) => text(v[k], 240)) ||
    !['sourceDigest', 'artifactDigest', 'contentDigest', 'reportDigest'].every(
      (k) => digest(v[k]),
    ) ||
    !Array.isArray(v.scenarios) ||
    v.scenarios.length !== REQUIRED_SCENARIOS.length
  )
    return false;
  return (
    v.scenarios.every(
      (s) =>
        exact(s, ['id', 'outcome', 'evidenceDigest']) &&
        typeof s.id === 'string' &&
        REQUIRED_SCENARIOS.includes(s.id) &&
        s.outcome === 'PASS' &&
        digest(s.evidenceDigest),
    ) &&
    new Set(v.scenarios.map((s) => s.id)).size === REQUIRED_SCENARIOS.length
  );
}
export async function verifyProofReceipt(
  value: unknown,
  signature: unknown,
  trust: CurriculumTrust | null,
  expected: {
    installationId: string;
    contentDigest: string;
    namespace?: string;
  },
  now: number,
  historical = false,
): Promise<{ receipt: ProofReceipt; issuer: Issuer; receiptDigest: string }> {
  if (
    !validReceipt(value) ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
    !trust
  )
    fail('PROOF_INVALID');
  const issuer = (historical ? trust.archiveIssuers : trust.issuers).find(
    (i) => i.issuerId === value.issuerId,
  );
  if (
    !issuer ||
    !validIssuer(issuer) ||
    value.issuedAt < issuer.notBefore ||
    value.issuedAt > now + 300000 ||
    (!historical && issuer.revokedAt !== null)
  )
    fail('PROOF_UNTRUSTED');
  if (
    (!historical &&
      (value.candidateId !== trust.candidateId ||
        value.sourceDigest !== trust.sourceDigest ||
        value.artifactDigest !== trust.artifactDigest ||
        value.buildId !== trust.buildId)) ||
    value.targetInstallationId !== expected.installationId ||
    value.contentDigest !== expected.contentDigest ||
    (expected.namespace !== undefined &&
      value.namespace !== expected.namespace) ||
    (issuer.purpose === 'candidate' && expected.namespace === undefined)
  )
    fail('PROOF_IDENTITY_MISMATCH');
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      issuer.publicKeyJwk,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const bytes = Uint8Array.from(
      atob(signature.replaceAll('-', '+').replaceAll('_', '/')),
      (c) => c.charCodeAt(0),
    );
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        key,
        bytes,
        new TextEncoder().encode(canonicalPackage(value)),
      ))
    )
      fail('PROOF_UNTRUSTED');
  } catch {
    fail('PROOF_UNTRUSTED');
  }
  return {
    receipt: value,
    issuer,
    receiptDigest: await curriculumDigest(value),
  };
}
export interface TrialScope {
  kind: 'supervised-trial';
  members: Array<{
    childId: string;
    parentId: string;
    planScope: 'forest-01-v4';
  }>;
}
export function parseTrialScope(v: unknown): TrialScope {
  if (
    !exact(v, ['kind', 'members']) ||
    v.kind !== 'supervised-trial' ||
    !Array.isArray(v.members) ||
    v.members.length === 0 ||
    v.members.length > 100 ||
    !v.members.every(
      (m) =>
        exact(m, ['childId', 'parentId', 'planScope']) &&
        text(m.childId, 120) &&
        text(m.parentId, 120) &&
        m.planScope === 'forest-01-v4',
    ) ||
    new Set(v.members.map((m) => m.childId)).size !== v.members.length
  )
    fail('INVALID_REQUEST', 400);
  return {
    kind: 'supervised-trial',
    members: [...v.members].sort(
      (a, b) =>
        a.childId.localeCompare(b.childId) ||
        a.parentId.localeCompare(b.parentId),
    ),
  };
}
