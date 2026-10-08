/** Dedicated R6 receipt verifier; old receipt versions and parsers are untouched. */
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import { exact, digest, text } from '../curriculum/story-package.ts';
import { fail, validIssuer } from './story-policy.ts';
import type { CurriculumTrust } from './story-policy.ts';
import { corpusId, safeCorpusJson } from './corpus-policy.ts';
export const CORPUS_MEMBER_CHECKS = [
  'profile-source-assets',
  'familiarity-routes',
  'recognition-context',
  'delayed-replay',
  'safe-projection',
];
export const CORPUS_FAMILY_SCENARIOS = [
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
export interface CorpusProofMember {
  lessonVersion: string;
  contentDigest: string;
}
export interface CorpusProofReceipt {
  schemaVersion: 'r6-proof-receipt-1';
  policyVersion: 'r6-corpus-proof-1';
  receiptId: string;
  issuerId: string;
  issuedAt: string;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  corpusVersion: string;
  corpusDigest: string;
  lessonVersion: string;
  contentDigest: string;
  canonicalizationVersion: 's3-json-1';
  adapterId: 'corpus-paired';
  adapterVersion: 'corpus-paired-v1';
  profileVersion: 'r6-paired-profile-1';
  evidenceInstallationId: string;
  targetInstallationId: string;
  namespace: string;
  syntheticOnly: true;
  runnerManifestDigest: string;
  memberReportDigest: string;
  memberChecks: Array<{ id: string; outcome: 'PASS'; evidenceDigest: string }>;
  familyEvidence: {
    reportDigest: string;
    representatives: CorpusProofMember[];
    scenarios: Array<
      CorpusProofMember & {
        id: string;
        outcome: 'PASS';
        evidenceDigest: string;
      }
    >;
  };
}
export function corpusRepresentatives(
  members: CorpusProofMember[],
): CorpusProofMember[] {
  if (members.length < 1 || members.length > 5000) fail('PROOF_INVALID', 400);
  return [
    ...new Set([0, Math.floor((members.length - 1) / 2), members.length - 1]),
  ].map((i) => members[i]);
}
function iso(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v
  );
}
export function inspectCorpusProof(
  input: unknown,
  members: CorpusProofMember[],
): CorpusProofReceipt {
  const v = safeCorpusJson(input, 128 * 1024);
  if (
    !exact(v, [
      'schemaVersion',
      'policyVersion',
      'receiptId',
      'issuerId',
      'issuedAt',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'buildId',
      'corpusVersion',
      'corpusDigest',
      'lessonVersion',
      'contentDigest',
      'canonicalizationVersion',
      'adapterId',
      'adapterVersion',
      'profileVersion',
      'evidenceInstallationId',
      'targetInstallationId',
      'namespace',
      'syntheticOnly',
      'runnerManifestDigest',
      'memberReportDigest',
      'memberChecks',
      'familyEvidence',
    ]) ||
    v.schemaVersion !== 'r6-proof-receipt-1' ||
    v.policyVersion !== 'r6-corpus-proof-1' ||
    v.canonicalizationVersion !== 's3-json-1' ||
    v.adapterId !== 'corpus-paired' ||
    v.adapterVersion !== 'corpus-paired-v1' ||
    v.profileVersion !== 'r6-paired-profile-1' ||
    v.syntheticOnly !== true ||
    !iso(v.issuedAt)
  )
    fail('PROOF_INVALID', 400);
  for (const key of [
    'receiptId',
    'issuerId',
    'candidateId',
    'buildId',
    'corpusVersion',
    'lessonVersion',
    'namespace',
  ])
    if (!corpusId(v[key])) fail('PROOF_INVALID', 400);
  for (const key of [
    'sourceDigest',
    'artifactDigest',
    'corpusDigest',
    'contentDigest',
    'runnerManifestDigest',
    'memberReportDigest',
  ])
    if (!digest(v[key])) fail('PROOF_INVALID', 400);
  for (const key of ['evidenceInstallationId', 'targetInstallationId'])
    if (!text(v[key], 240)) fail('PROOF_INVALID', 400);
  if (
    !members.some(
      (m) =>
        m.lessonVersion === v.lessonVersion &&
        m.contentDigest === v.contentDigest,
    )
  )
    fail('PROOF_IDENTITY_MISMATCH');
  if (
    !Array.isArray(v.memberChecks) ||
    v.memberChecks.length !== CORPUS_MEMBER_CHECKS.length ||
    !v.memberChecks.every(
      (c) =>
        exact(c, ['id', 'outcome', 'evidenceDigest']) &&
        CORPUS_MEMBER_CHECKS.includes(String(c.id)) &&
        c.outcome === 'PASS' &&
        digest(c.evidenceDigest),
    ) ||
    new Set(v.memberChecks.map((c) => c.id)).size !==
      CORPUS_MEMBER_CHECKS.length
  )
    fail('PROOF_INVALID', 400);
  const reps = corpusRepresentatives(members);
  if (
    !exact(v.familyEvidence, [
      'reportDigest',
      'representatives',
      'scenarios',
    ]) ||
    !digest(v.familyEvidence.reportDigest) ||
    canonicalPackage(v.familyEvidence.representatives) !==
      canonicalPackage(reps) ||
    !Array.isArray(v.familyEvidence.scenarios) ||
    v.familyEvidence.scenarios.length !==
      reps.length * CORPUS_FAMILY_SCENARIOS.length
  )
    fail('PROOF_INVALID', 400);
  const keys = new Set<string>();
  for (const s of v.familyEvidence.scenarios) {
    if (
      !exact(s, [
        'lessonVersion',
        'contentDigest',
        'id',
        'outcome',
        'evidenceDigest',
      ]) ||
      !reps.some(
        (r) =>
          r.lessonVersion === s.lessonVersion &&
          r.contentDigest === s.contentDigest,
      ) ||
      !CORPUS_FAMILY_SCENARIOS.includes(String(s.id)) ||
      s.outcome !== 'PASS' ||
      !digest(s.evidenceDigest)
    )
      fail('PROOF_INVALID', 400);
    const key = canonicalPackage([s.lessonVersion, s.contentDigest, s.id]);
    if (keys.has(key)) fail('PROOF_INVALID', 400);
    keys.add(key);
  }
  return v as unknown as CorpusProofReceipt;
}
export interface CorpusProofExpected extends CorpusProofMember {
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  installationId: string;
  evidenceInstallationId: string;
  corpusVersion: string;
  corpusDigest: string;
  namespace: string;
  verification: boolean;
  members: CorpusProofMember[];
}
export async function verifyCorpusProof(
  input: unknown,
  signature: unknown,
  trust: CurriculumTrust | null,
  expected: CorpusProofExpected,
  now: number,
  historical = false,
): Promise<{
  receipt: CorpusProofReceipt;
  receiptDigest: string;
  issuer: NonNullable<CurriculumTrust>['issuers'][number];
}> {
  const receipt = inspectCorpusProof(input, expected.members);
  if (
    !trust ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    fail('PROOF_INVALID', 400);
  const issuer = (historical ? trust.archiveIssuers : trust.issuers).find(
      (i) => i.issuerId === receipt.issuerId,
    ),
    at = Date.parse(receipt.issuedAt);
  if (
    !issuer ||
    !validIssuer(issuer) ||
    at < issuer.notBefore ||
    at > now + 300000 ||
    (!historical && issuer.revokedAt !== null) ||
    (historical && issuer.revokedAt !== null && at >= issuer.revokedAt)
  )
    fail('PROOF_UNTRUSTED');
  if (issuer.purpose === 'candidate' && !expected.verification)
    fail('PROOF_UNTRUSTED');
  if (
    (!historical &&
      (receipt.candidateId !== trust.candidateId ||
        receipt.sourceDigest !== trust.sourceDigest ||
        receipt.artifactDigest !== trust.artifactDigest ||
        receipt.buildId !== trust.buildId)) ||
    receipt.candidateId !== expected.candidateId ||
    receipt.sourceDigest !== expected.sourceDigest ||
    receipt.artifactDigest !== expected.artifactDigest ||
    receipt.buildId !== expected.buildId ||
    receipt.targetInstallationId !== expected.installationId ||
    receipt.evidenceInstallationId !== expected.evidenceInstallationId ||
    receipt.namespace !== expected.namespace ||
    receipt.corpusVersion !== expected.corpusVersion ||
    receipt.corpusDigest !== expected.corpusDigest ||
    receipt.lessonVersion !== expected.lessonVersion ||
    receipt.contentDigest !== expected.contentDigest
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
        new TextEncoder().encode(canonicalPackage(receipt)),
      ))
    )
      fail('PROOF_UNTRUSTED');
  } catch {
    fail('PROOF_UNTRUSTED');
  }
  return { receipt, receiptDigest: await curriculumDigest(receipt), issuer };
}

/** Authenticate signed origin before accepting it as attribution; target bindings are a separate check. */
export async function authenticateCorpusProof(
  input: unknown,
  signature: unknown,
  trust: CurriculumTrust | null,
  members: CorpusProofMember[],
  now: number,
  verification = false,
) {
  const receipt = inspectCorpusProof(input, members);
  if (
    !trust ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/u.test(signature) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    fail('PROOF_INVALID', 400);
  const issuer = trust.issuers.find((i) => i.issuerId === receipt.issuerId),
    at = Date.parse(receipt.issuedAt);
  if (
    !issuer ||
    !validIssuer(issuer) ||
    at < issuer.notBefore ||
    at > now + 300000 ||
    issuer.revokedAt !== null ||
    (issuer.purpose === 'candidate' && !verification)
  )
    fail('PROOF_UNTRUSTED');
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
        new TextEncoder().encode(canonicalPackage(receipt)),
      ))
    )
      fail('PROOF_UNTRUSTED');
  } catch {
    fail('PROOF_UNTRUSTED');
  }
  return { receipt, receiptDigest: await curriculumDigest(receipt), issuer };
}
