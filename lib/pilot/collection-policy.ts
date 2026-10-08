import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import { digest, exact, text } from '../curriculum/story-package.ts';
import {
  fail,
  validIssuer,
  type Issuer,
  type CurriculumTrust,
} from './story-policy.ts';
import { inspectJson } from '../curriculum/json.ts';
export interface ProofReceipt {
  schemaVersion: 'r3-proof-receipt-1';
  receiptId: string;
  issuerId: string;
  issuedAt: number;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  lessonVersion: string;
  contentDigest: string;
  canonicalizationVersion: 's3-json-1';
  adapterId: 'paired-story';
  adapterVersion: 'paired-story-v1';
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
  'review-24h',
  'review-7d',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
export interface CollectionCapability {
  installationId: string;
  collectionVersion: string;
  collectionDigest: string;
  namespace: string;
  childIds: string[];
  parentIds: string[];
}
export function parseCollectionCapability(
  input: unknown,
): CollectionCapability | null {
  const { value: v, errors } = inspectJson(input);
  if (
    errors.length ||
    !exact(v, [
      'installationId',
      'collectionVersion',
      'collectionDigest',
      'namespace',
      'childIds',
      'parentIds',
    ]) ||
    !text(v.installationId, 240) ||
    !text(v.collectionVersion, 80) ||
    !/^little-hanzi-path-1-v[1-9][0-9]*$/.test(String(v.collectionVersion)) ||
    !digest(v.collectionDigest) ||
    !text(v.namespace, 240) ||
    ![v.childIds, v.parentIds].every(
      (a) =>
        Array.isArray(a) &&
        a.length > 0 &&
        a.length <= 100 &&
        a.every((x) => text(x, 120)) &&
        new Set(a).size === a.length,
    )
  )
    return null;
  return v as unknown as CollectionCapability;
}
export function collectionRequest(
  kind: 'proposal' | 'approval' | 'start' | 'action',
  actorId: string,
  installationId: string,
  resourceId: string,
  request: unknown,
) {
  return {
    schemaVersion: `r5-${kind}-request-1`,
    actorId,
    installationId,
    resourceId,
    request,
  };
}
export function collectionSeed(assignmentId: string): number {
  let seed = 2166136261;
  for (let i = 0; i < assignmentId.length; i++)
    seed = Math.imul(seed ^ assignmentId.charCodeAt(i), 16777619);
  return seed >>> 0;
}
export function validateCollectionManifest(input: unknown) {
  const { value: v, errors } = inspectJson(input);
  if (
    errors.length ||
    !exact(v, [
      'schemaVersion',
      'collectionId',
      'collectionVersion',
      'canonicalizationVersion',
      'trackId',
      'items',
    ]) ||
    v.schemaVersion !== 'r5-collection-1' ||
    v.canonicalizationVersion !== 's3-json-1' ||
    ![v.collectionId, v.collectionVersion, v.trackId].every(
      (x) => text(x, 80) && /^[a-z0-9][a-z0-9._-]*$/.test(x),
    ) ||
    !Array.isArray(v.items) ||
    v.items.length !== 10 ||
    !v.items.every(
      (x, i) =>
        exact(x, [
          'lessonVersion',
          'contentDigest',
          'sequence',
          'introductionPrerequisites',
        ]) &&
        text(x.lessonVersion, 80) &&
        /^[a-z0-9][a-z0-9._-]*$/.test(x.lessonVersion) &&
        digest(x.contentDigest) &&
        x.sequence === i + 1 &&
        Array.isArray(x.introductionPrerequisites) &&
        x.introductionPrerequisites.length === 0,
    ) ||
    new Set(v.items.map((x) => x.lessonVersion)).size !== 10
  )
    fail('INVALID_COLLECTION', 400);
  return v as unknown as {
    schemaVersion: 'r5-collection-1';
    collectionId: string;
    collectionVersion: string;
    canonicalizationVersion: 's3-json-1';
    trackId: string;
    items: Array<{
      lessonVersion: string;
      contentDigest: string;
      sequence: number;
      introductionPrerequisites: string[];
    }>;
  };
}
export function validCollectionReceipt(v: unknown): v is ProofReceipt {
  const inspected = inspectJson(v);
  if (inspected.errors.length) return false;
  v = inspected.value;
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
    !text(v.lessonVersion, 80) ||
    !/^path-(?:0[1-9]|10)-v[1-9][0-9]*$/.test(String(v.lessonVersion)) ||
    v.canonicalizationVersion !== 's3-json-1' ||
    v.adapterId !== 'paired-story' ||
    v.adapterVersion !== 'paired-story-v1' ||
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
export async function verifyCollectionProof(
  value: unknown,
  signature: unknown,
  trust: CurriculumTrust | null,
  expected: {
    installationId: string;
    contentDigest: string;
    lessonVersion: string;
    namespace?: string;
  },
  now: number,
  historical = false,
): Promise<{ receipt: ProofReceipt; issuer: Issuer; receiptDigest: string }> {
  if (
    !validCollectionReceipt(value) ||
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
    (!historical && issuer.revokedAt !== null) ||
    (historical &&
      issuer.revokedAt !== null &&
      value.issuedAt >= issuer.revokedAt)
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
    value.lessonVersion !== expected.lessonVersion ||
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
    planScope: string;
  }>;
}
export function parseCollectionScope(v: unknown, version: string): TrialScope {
  const checked = inspectJson(v);
  if (checked.errors.length) fail('INVALID_REQUEST', 400);
  v = checked.value;
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
        m.planScope === version,
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
/** Exact frozen R5 collection coverage; future collection profiles need a separate versioned policy. */
export async function validateCollectionPackages(
  document: unknown,
  packages: readonly unknown[],
) {
  const manifest = validateCollectionManifest(document);
  if (
    manifest.collectionId !== 'little-hanzi-path-1' ||
    !/^little-hanzi-path-1-v[1-9][0-9]*$/.test(manifest.collectionVersion) ||
    manifest.trackId !== 'everyday-hanzi' ||
    packages.length !== 10
  )
    fail('INVALID_COLLECTION', 400);
  const pairs = [
      '木林',
      '日月',
      '人口',
      '山水',
      '大小',
      '上下',
      '田土',
      '火雨',
      '手目',
      '门车',
    ],
    targets: string[] = [];
  const { compilePairedRuntime } =
    await import('../curriculum/paired-runtime.ts');
  const compiled = [];
  for (let i = 0; i < 10; i++) {
    const inspected = inspectJson(packages[i]);
    if (inspected.errors.length) fail('INVALID_COLLECTION', 400);
    const pkg = inspected.value as Record<string, unknown>,
      entry = manifest.items[i],
      lesson = await compilePairedRuntime(pkg),
      prefix = `path-${String(i + 1).padStart(2, '0')}`;
    if (
      lesson.identity.lessonId !== prefix ||
      !new RegExp(`^${prefix}-v[1-9][0-9]*$`).test(entry.lessonVersion) ||
      lesson.identity.lessonVersion !== entry.lessonVersion ||
      lesson.identity.contentDigest !== entry.contentDigest
    )
      fail('COLLECTION_IDENTITY_MISMATCH', 400);
    const chars = pkg.characters as Array<{ hanzi: string }>;
    if (chars.map((x) => x.hanzi).join('') !== pairs[i])
      fail('COLLECTION_TARGET_MISMATCH', 400);
    targets.push(...chars.map((x) => x.hanzi));
    compiled.push(lesson);
  }
  if (new Set(targets).size !== 20) fail('COLLECTION_TARGET_MISMATCH', 400);
  return { manifest, compiled };
}
