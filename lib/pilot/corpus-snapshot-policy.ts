/** Private snapshot serializers shared by persistence and historical archive validation. */
import {
  canonicalPackage,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { exact, digest } from '../curriculum/story-package.ts';
import {
  safeCorpusJson,
  corpusId,
  normalizeCoverageIdentity,
} from './corpus-policy.ts';
import { fail } from './story-policy.ts';
import type {
  CorpusReason,
  CorpusClassification,
  CorpusSnapshotCounts,
} from '../curriculum/corpus-types.ts';
export const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const reasons: CorpusReason[] = [
  'FIXTURE',
  'PLACEHOLDER',
  'UNVERIFIED_SOURCE',
  'MISSING_LICENSE',
  'ALIAS',
  'DUPLICATE_IDENTITY',
  'INCOMPLETE_WORD_CONTEXT',
  'UNREVIEWED_CONTENT',
  'UNREVIEWED_AUDIO',
  'MISSING_PROMPT',
  'MISSING_ASSET',
  'UNSUPPORTED_RENDERER',
  'INVALID_PROOF',
  'STALE_EVIDENCE',
  'HISTORICAL_INSTALLATION',
  'WITHDRAWN',
  'OWNER_DECISION_PENDING',
  'PACKAGE_INELIGIBLE',
];
export const orderedReasons = (input: CorpusReason[]) =>
  reasons.filter((r) => input.includes(r));
export interface IntrinsicEligibility {
  schemaVersion: 'r6-target-eligibility-1';
  characterId: string;
  coverageIdentity: string;
  classification: CorpusClassification;
  identityKind: null | 'simplified' | 'alias';
  identityReview: null | {
    characterId: string;
    hanzi: string;
    kind: 'simplified' | 'alias';
    reviewRef: string;
  };
  machineValid: boolean;
  licensed: boolean;
  wordsComplete: boolean;
  contentReviewed: boolean;
  audioReviewed: boolean;
  promptsComplete: boolean;
  assetsComplete: boolean;
  proofValid: boolean;
  current: boolean;
  placeholder: boolean;
  realEligible: boolean;
  machineUsableVerification: boolean;
  reasonCodes: CorpusReason[];
}
export interface CoverageEligibility {
  schemaVersion: 'r6-eligibility-1';
  coverageIdentity: string;
  characterId: string;
  lessonVersion: string;
  contentDigest: string;
  sourceEvidenceId: string;
  classification: CorpusClassification;
  reviewId: string | null;
  reviewSequence: number | null;
  proofId: string | null;
  proofPolicyVersion: 'r6-corpus-proof-1' | null;
  assetInventoryDigest: string;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  requirementsDigest: string;
  eligible: boolean;
  reasonCodes: CorpusReason[];
}
export interface SnapshotDependency {
  targetIndex: 0 | 1;
  characterId: string;
  coverageIdentity: string;
  sourceEvidenceId: string;
  sourceEvidenceDigest: string;
  requirementsDigest: string;
  intrinsicEligibility: IntrinsicEligibility;
  intrinsicEligibilityDigest: string;
}
export interface PackageEligibility {
  schemaVersion: 'r6-package-eligibility-1';
  lessonVersion: string;
  contentDigest: string;
  adapterId: 'corpus-paired';
  adapterVersion: 'corpus-paired-v1';
  profileVersion: 'r6-paired-profile-1';
  lane: 'ordinary' | 'verification';
  review: null | { reviewId: string; reviewDigest: string };
  proof: null | {
    proofId: string;
    receiptDigest: string;
    issuerId: string;
    purpose: 'release' | 'candidate';
    issuedAt: string;
  };
  assetInventory: Record<string, unknown>;
  assetInventoryDigest: string;
  targets: SnapshotDependency[];
  realEligible: boolean;
  machineUsableVerification: boolean;
  packageEligible: boolean;
  reasonCodes: CorpusReason[];
}
export interface SnapshotTarget {
  memberOrdinal: number;
  targetIndex: 0 | 1;
  coverageIdentity: string;
  characterId: string;
  lessonVersion: string;
  contentDigest: string;
  sourceEvidenceId: string;
  sourceEvidenceDigest: string;
  reviewId: string | null;
  proofId: string | null;
  assetInventoryDigest: string;
  packageEligible: boolean;
  packageEligibilityDigest: string;
  eligibility: CoverageEligibility;
  eligibilityDigest: string;
  coverageStatus: 'included' | 'excluded';
  reasonCodes: CorpusReason[];
}
export interface SnapshotPackage {
  ordinal: number;
  lessonVersion: string;
  contentDigest: string;
  packageEligibility: PackageEligibility;
  packageEligibilityDigest: string;
  targets: SnapshotTarget[];
}
export interface SnapshotPlan {
  schemaVersion: 'r6-snapshot-plan-1';
  corpusVersion: string;
  corpusDigest: string;
  installationId: string;
  namespace: string | null;
  lane: 'ordinary' | 'verification';
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  evidenceEpoch: number;
  packages: SnapshotPackage[];
  releasedPackages: Array<{ lessonVersion: string; contentDigest: string }>;
  counts: CorpusSnapshotCounts;
}
export interface SnapshotCandidate {
  ordinal: number;
  lessonVersion: string;
  contentDigest: string;
  assetInventory: Record<string, unknown>;
  review: PackageEligibility['review'];
  reviewSequence: number | null;
  proof: PackageEligibility['proof'];
  targets: Array<Omit<SnapshotDependency, 'intrinsicEligibilityDigest'>>;
}
const intrinsicKeys = [
  'schemaVersion',
  'characterId',
  'coverageIdentity',
  'classification',
  'identityKind',
  'identityReview',
  'machineValid',
  'licensed',
  'wordsComplete',
  'contentReviewed',
  'audioReviewed',
  'promptsComplete',
  'assetsComplete',
  'proofValid',
  'current',
  'placeholder',
  'realEligible',
  'machineUsableVerification',
  'reasonCodes',
];
const positive = [
  'machineValid',
  'licensed',
  'wordsComplete',
  'contentReviewed',
  'audioReviewed',
  'promptsComplete',
  'assetsComplete',
  'proofValid',
  'current',
] as const;
function validReasons(v: unknown) {
  return (
    Array.isArray(v) &&
    v.every((x) => reasons.includes(x)) &&
    canonicalPackage(v) === canonicalPackage(orderedReasons(v))
  );
}
export function intrinsicReasons(
  t: Omit<
    IntrinsicEligibility,
    | 'schemaVersion'
    | 'realEligible'
    | 'machineUsableVerification'
    | 'reasonCodes'
  >,
): CorpusReason[] {
  const r: CorpusReason[] = [];
  if (t.classification === 'verification-fixture') r.push('FIXTURE');
  else if (t.classification !== 'real-source-reviewed')
    r.push('UNVERIFIED_SOURCE');
  if (t.placeholder) r.push('PLACEHOLDER');
  if (t.identityKind === 'alias') r.push('ALIAS');
  if (t.identityKind === null && t.classification === 'real-source-reviewed')
    r.push('UNVERIFIED_SOURCE');
  for (const [field, reason] of [
    ['licensed', 'MISSING_LICENSE'],
    ['wordsComplete', 'INCOMPLETE_WORD_CONTEXT'],
    ['contentReviewed', 'UNREVIEWED_CONTENT'],
    ['audioReviewed', 'UNREVIEWED_AUDIO'],
    ['promptsComplete', 'MISSING_PROMPT'],
    ['assetsComplete', 'MISSING_ASSET'],
    ['proofValid', 'INVALID_PROOF'],
    ['current', 'STALE_EVIDENCE'],
  ] as const)
    if (!t[field]) r.push(reason);
  return orderedReasons(r);
}
export function inspectIntrinsicEligibility(
  input: unknown,
): IntrinsicEligibility {
  const t = safeCorpusJson(input);
  if (
    !exact(t, intrinsicKeys) ||
    t.schemaVersion !== 'r6-target-eligibility-1' ||
    !corpusId(t.characterId) ||
    ![
      'verification-fixture',
      'unverified-draft',
      'real-source-reviewed',
    ].includes(String(t.classification)) ||
    !(
      t.identityKind === null ||
      t.identityKind === 'simplified' ||
      t.identityKind === 'alias'
    ) ||
    !positive.every((k) => typeof t[k] === 'boolean') ||
    !['placeholder', 'realEligible', 'machineUsableVerification'].every(
      (k) => typeof t[k] === 'boolean',
    ) ||
    !validReasons(t.reasonCodes)
  )
    fail('SNAPSHOT_INVALID', 400);
  normalizeCoverageIdentity(t.coverageIdentity);
  if (
    t.identityReview !== null &&
    (!exact(t.identityReview, ['characterId', 'hanzi', 'kind', 'reviewRef']) ||
      t.identityReview.characterId !== t.characterId ||
      t.identityReview.hanzi !== t.coverageIdentity ||
      t.identityReview.kind !== t.identityKind ||
      !corpusId(t.identityReview.reviewRef))
  )
    fail('SNAPSHOT_INVALID', 400);
  const v = t as unknown as IntrinsicEligibility,
    eligible =
      v.classification === 'real-source-reviewed' &&
      v.identityKind === 'simplified' &&
      v.identityReview !== null &&
      positive.every((k) => v[k]) &&
      !v.placeholder;
  if (
    v.realEligible !== eligible ||
    (v.machineUsableVerification &&
      (!v.machineValid || v.classification !== 'verification-fixture')) ||
    canonicalPackage(v.reasonCodes) !== canonicalPackage(intrinsicReasons(v))
  )
    fail('SNAPSHOT_INVALID', 400);
  return v;
}
export function inspectCoverageEligibility(
  input: unknown,
): CoverageEligibility {
  const v = safeCorpusJson(input);
  if (
    !exact(v, [
      'schemaVersion',
      'coverageIdentity',
      'characterId',
      'lessonVersion',
      'contentDigest',
      'sourceEvidenceId',
      'classification',
      'reviewId',
      'reviewSequence',
      'proofId',
      'proofPolicyVersion',
      'assetInventoryDigest',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'requirementsDigest',
      'eligible',
      'reasonCodes',
    ]) ||
    v.schemaVersion !== 'r6-eligibility-1' ||
    !['characterId', 'lessonVersion', 'sourceEvidenceId', 'candidateId'].every(
      (k) => corpusId(v[k]),
    ) ||
    ![
      'contentDigest',
      'assetInventoryDigest',
      'sourceDigest',
      'artifactDigest',
      'requirementsDigest',
    ].every((k) => digest(v[k])) ||
    ![
      'verification-fixture',
      'unverified-draft',
      'real-source-reviewed',
    ].includes(String(v.classification)) ||
    typeof v.eligible !== 'boolean' ||
    !validReasons(v.reasonCodes) ||
    !(
      (v.reviewId === null && v.reviewSequence === null) ||
      (corpusId(v.reviewId) &&
        Number.isSafeInteger(v.reviewSequence) &&
        Number(v.reviewSequence) > 0)
    ) ||
    !(
      (v.proofId === null && v.proofPolicyVersion === null) ||
      (corpusId(v.proofId) && v.proofPolicyVersion === 'r6-corpus-proof-1')
    )
  )
    fail('SNAPSHOT_INVALID', 400);
  normalizeCoverageIdentity(v.coverageIdentity);
  if (
    v.eligible &&
    (v.classification !== 'real-source-reviewed' ||
      v.reviewId === null ||
      v.proofId === null ||
      (v.reasonCodes as unknown[]).length !== 0)
  )
    fail('SNAPSHOT_INVALID', 400);
  return v as unknown as CoverageEligibility;
}
export function reviewBinding(row: Record<string, unknown>) {
  const keys = [
    'review_id',
    'lesson_version',
    'content_digest',
    'review_sequence',
    'previous_review_id',
    'decision',
    'reviewer_ref',
    'reviewed_at',
    'checklist_version',
    'checklist_json',
    'evidence_ref',
    'reason',
    'recorded_by_user_id',
    'recorded_at',
    'request_digest',
    'write_id',
    'test_run_id',
  ];
  if (!exact(row, keys)) fail('SNAPSHOT_INVALID', 400);
  return { schemaVersion: 'r6-review-binding-1', row: safeCorpusJson(row) };
}
export function assetInventory(
  document: Record<string, unknown>,
  contentDigest: string,
) {
  const targets = document.characters as Array<Record<string, unknown>>,
    story = document.pairedStory as Record<string, unknown>;
  return {
    schemaVersion: 'r6-asset-inventory-1',
    lessonVersion: document.lessonVersion,
    contentDigest,
    assets: document.assets,
    playback: story.playback,
    targets: targets.map((t, targetIndex) => ({
      targetIndex,
      characterId: t.characterId,
      assetIds: t.assets,
    })),
  };
}
export function inspectPackageEligibility(input: unknown): PackageEligibility {
  const v = safeCorpusJson(input);
  if (
    !exact(v, [
      'schemaVersion',
      'lessonVersion',
      'contentDigest',
      'adapterId',
      'adapterVersion',
      'profileVersion',
      'lane',
      'review',
      'proof',
      'assetInventory',
      'assetInventoryDigest',
      'targets',
      'realEligible',
      'machineUsableVerification',
      'packageEligible',
      'reasonCodes',
    ]) ||
    v.schemaVersion !== 'r6-package-eligibility-1' ||
    !corpusId(v.lessonVersion) ||
    !digest(v.contentDigest) ||
    v.adapterId !== 'corpus-paired' ||
    v.adapterVersion !== 'corpus-paired-v1' ||
    v.profileVersion !== 'r6-paired-profile-1' ||
    !['ordinary', 'verification'].includes(String(v.lane)) ||
    !Array.isArray(v.targets) ||
    v.targets.length !== 2 ||
    !digest(v.assetInventoryDigest) ||
    !validReasons(v.reasonCodes)
  )
    fail('SNAPSHOT_INVALID', 400);
  for (const [i, t] of v.targets.entries()) {
    if (
      !exact(t, [
        'targetIndex',
        'characterId',
        'coverageIdentity',
        'sourceEvidenceId',
        'sourceEvidenceDigest',
        'requirementsDigest',
        'intrinsicEligibility',
        'intrinsicEligibilityDigest',
      ]) ||
      t.targetIndex !== i ||
      !corpusId(t.characterId) ||
      !corpusId(t.sourceEvidenceId) ||
      ![
        'sourceEvidenceDigest',
        'requirementsDigest',
        'intrinsicEligibilityDigest',
      ].every((k) => digest(t[k]))
    )
      fail('SNAPSHOT_INVALID', 400);
    const intrinsic = inspectIntrinsicEligibility(t.intrinsicEligibility);
    if (
      intrinsic.characterId !== t.characterId ||
      intrinsic.coverageIdentity !== t.coverageIdentity
    )
      fail('SNAPSHOT_INVALID', 400);
  }
  if (v.targets[0].characterId === v.targets[1].characterId)
    fail('SNAPSHOT_INVALID', 400);
  if (
    v.review !== null &&
    (!exact(v.review, ['reviewId', 'reviewDigest']) ||
      !corpusId(v.review.reviewId) ||
      !digest(v.review.reviewDigest))
  )
    fail('SNAPSHOT_INVALID', 400);
  if (
    v.proof !== null &&
    (!exact(v.proof, [
      'proofId',
      'receiptDigest',
      'issuerId',
      'purpose',
      'issuedAt',
    ]) ||
      !corpusId(v.proof.proofId) ||
      !corpusId(v.proof.issuerId) ||
      !digest(v.proof.receiptDigest) ||
      !['candidate', 'release'].includes(String(v.proof.purpose)) ||
      typeof v.proof.issuedAt !== 'string' ||
      !Number.isFinite(Date.parse(v.proof.issuedAt)) ||
      new Date(v.proof.issuedAt).toISOString() !== v.proof.issuedAt)
  )
    fail('SNAPSHOT_INVALID', 400);
  const p = v as unknown as PackageEligibility,
    real =
      p.targets.every((t) => t.intrinsicEligibility.realEligible) &&
      p.review !== null &&
      p.proof?.purpose === 'release',
    machine =
      p.lane === 'verification' &&
      p.targets.every((t) => t.intrinsicEligibility.machineUsableVerification);
  if (
    p.realEligible !== real ||
    p.machineUsableVerification !== machine ||
    p.packageEligible !== (p.lane === 'ordinary' ? real : machine)
  )
    fail('SNAPSHOT_INVALID', 400);
  return p;
}
export async function buildSnapshotPlan(
  binding: Omit<
    SnapshotPlan,
    'schemaVersion' | 'packages' | 'releasedPackages' | 'counts'
  >,
  candidates: SnapshotCandidate[],
): Promise<SnapshotPlan> {
  const packages: SnapshotPackage[] = [],
    included = new Set<string>(),
    fixtures = new Set<string>();
  for (const c of [...candidates].sort((a, b) => a.ordinal - b.ordinal)) {
    const targets = await Promise.all(
        c.targets.map(async (t) => ({
          ...t,
          intrinsicEligibility: inspectIntrinsicEligibility(
            t.intrinsicEligibility,
          ),
          intrinsicEligibilityDigest: await H(t.intrinsicEligibility),
        })),
      ),
      real =
        targets.every((t) => t.intrinsicEligibility.realEligible) &&
        c.review !== null &&
        c.proof?.purpose === 'release',
      machine =
        binding.lane === 'verification' &&
        targets.every((t) => t.intrinsicEligibility.machineUsableVerification),
      usable = binding.lane === 'ordinary' ? real : machine;
    const p: PackageEligibility = {
      schemaVersion: 'r6-package-eligibility-1',
      lessonVersion: c.lessonVersion,
      contentDigest: c.contentDigest,
      adapterId: 'corpus-paired',
      adapterVersion: 'corpus-paired-v1',
      profileVersion: 'r6-paired-profile-1',
      lane: binding.lane,
      review: c.review,
      proof: c.proof,
      assetInventory: c.assetInventory,
      assetInventoryDigest: await H(c.assetInventory),
      targets,
      realEligible: real,
      machineUsableVerification: machine,
      packageEligible: usable,
      reasonCodes: orderedReasons(
        targets
          .flatMap((t) => t.intrinsicEligibility.reasonCodes)
          .concat(usable ? [] : ['PACKAGE_INELIGIBLE']),
      ),
    };
    const pd = await H(p),
      rows: SnapshotTarget[] = [];
    for (const t of targets) {
      if (t.intrinsicEligibility.classification === 'verification-fixture')
        fixtures.add(t.coverageIdentity);
      const duplicate = included.has(t.coverageIdentity),
        eligible = binding.lane === 'ordinary' && usable && !duplicate;
      if (eligible) included.add(t.coverageIdentity);
      const reasonCodes = orderedReasons(
        t.intrinsicEligibility.reasonCodes.concat(
          usable ? [] : ['PACKAGE_INELIGIBLE'],
          binding.lane === 'ordinary' && usable && duplicate
            ? ['DUPLICATE_IDENTITY']
            : [],
        ),
      );
      const e: CoverageEligibility = {
        schemaVersion: 'r6-eligibility-1',
        coverageIdentity: t.coverageIdentity,
        characterId: t.characterId,
        lessonVersion: c.lessonVersion,
        contentDigest: c.contentDigest,
        sourceEvidenceId: t.sourceEvidenceId,
        classification: t.intrinsicEligibility.classification,
        reviewId: c.review?.reviewId ?? null,
        reviewSequence: c.reviewSequence,
        proofId: c.proof?.proofId ?? null,
        proofPolicyVersion: c.proof ? 'r6-corpus-proof-1' : null,
        assetInventoryDigest: p.assetInventoryDigest,
        candidateId: binding.candidateId,
        sourceDigest: binding.sourceDigest,
        artifactDigest: binding.artifactDigest,
        requirementsDigest: t.requirementsDigest,
        eligible,
        reasonCodes,
      };
      rows.push({
        memberOrdinal: c.ordinal * 2 + t.targetIndex,
        targetIndex: t.targetIndex,
        coverageIdentity: t.coverageIdentity,
        characterId: t.characterId,
        lessonVersion: c.lessonVersion,
        contentDigest: c.contentDigest,
        sourceEvidenceId: t.sourceEvidenceId,
        sourceEvidenceDigest: t.sourceEvidenceDigest,
        reviewId: e.reviewId,
        proofId: e.proofId,
        assetInventoryDigest: p.assetInventoryDigest,
        packageEligible: usable,
        packageEligibilityDigest: pd,
        eligibility: e,
        eligibilityDigest: await H(e),
        coverageStatus: eligible ? 'included' : 'excluded',
        reasonCodes,
      });
    }
    packages.push({
      ordinal: c.ordinal,
      lessonVersion: c.lessonVersion,
      contentDigest: c.contentDigest,
      packageEligibility: p,
      packageEligibilityDigest: pd,
      targets: rows,
    });
  }
  const releasedPackages = packages
      .filter((p) => p.packageEligibility.packageEligible)
      .map((p) => ({
        lessonVersion: p.lessonVersion,
        contentDigest: p.contentDigest,
      })),
    plan: SnapshotPlan = {
      schemaVersion: 'r6-snapshot-plan-1',
      ...binding,
      packages,
      releasedPackages,
      counts: {
        candidatePackageCount: packages.length,
        targetCount: packages.length * 2,
        packageCount: releasedPackages.length,
        includedCharacterCount: included.size,
        excludedTargetCount: packages.length * 2 - included.size,
        fixtureCharacterCount: fixtures.size,
        verificationPackageCount:
          binding.lane === 'verification' ? releasedPackages.length : 0,
      },
    };
  return plan;
}
export async function inspectSnapshotPlan(
  input: unknown,
): Promise<SnapshotPlan> {
  let raw: unknown;
  try {
    raw = safeCorpusJson(input, SNAPSHOT_MAX_BYTES);
  } catch {
    fail('SNAPSHOT_TOO_LARGE', 400);
  }
  if (
    new TextEncoder().encode(canonicalPackage(raw)).length > SNAPSHOT_MAX_BYTES
  )
    fail('SNAPSHOT_TOO_LARGE', 400);
  if (
    !exact(raw, [
      'schemaVersion',
      'corpusVersion',
      'corpusDigest',
      'installationId',
      'namespace',
      'lane',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'buildId',
      'evidenceEpoch',
      'packages',
      'releasedPackages',
      'counts',
    ]) ||
    raw.schemaVersion !== 'r6-snapshot-plan-1' ||
    !['corpusVersion', 'installationId', 'candidateId', 'buildId'].every((k) =>
      corpusId(raw[k]),
    ) ||
    !['corpusDigest', 'sourceDigest', 'artifactDigest'].every((k) =>
      digest(raw[k]),
    ) ||
    !(raw.namespace === null || corpusId(raw.namespace)) ||
    !['ordinary', 'verification'].includes(String(raw.lane)) ||
    !Number.isSafeInteger(raw.evidenceEpoch) ||
    Number(raw.evidenceEpoch) < 0 ||
    !Array.isArray(raw.packages) ||
    raw.packages.length < 1 ||
    raw.packages.length > 5000
  )
    fail('SNAPSHOT_INVALID', 400);
  const plan = raw as unknown as SnapshotPlan,
    candidates: SnapshotCandidate[] = [];
  const versions = new Set<string>();
  for (const [i, p] of plan.packages.entries()) {
    if (
      !exact(p, [
        'ordinal',
        'lessonVersion',
        'contentDigest',
        'packageEligibility',
        'packageEligibilityDigest',
        'targets',
      ]) ||
      p.ordinal !== i ||
      !corpusId(p.lessonVersion) ||
      !digest(p.contentDigest) ||
      versions.has(p.lessonVersion) ||
      !Array.isArray(p.targets) ||
      p.targets.length !== 2
    )
      fail('SNAPSHOT_INVALID', 400);
    versions.add(p.lessonVersion);
    const e = inspectPackageEligibility(p.packageEligibility);
    if (
      e.lessonVersion !== p.lessonVersion ||
      e.contentDigest !== p.contentDigest ||
      e.lane !== plan.lane ||
      p.packageEligibilityDigest !== (await H(e)) ||
      e.assetInventoryDigest !== (await H(e.assetInventory))
    )
      fail('SNAPSHOT_INVALID', 400);
    for (const t of e.targets)
      if (t.intrinsicEligibilityDigest !== (await H(t.intrinsicEligibility)))
        fail('SNAPSHOT_INVALID', 400);
    for (const t of p.targets) inspectCoverageEligibility(t.eligibility);
    candidates.push({
      ordinal: i,
      lessonVersion: p.lessonVersion,
      contentDigest: p.contentDigest,
      assetInventory: e.assetInventory,
      review: e.review,
      reviewSequence: p.targets[0].eligibility.reviewSequence,
      proof: e.proof,
      targets: e.targets.map(
        ({ intrinsicEligibilityDigest: _digest, ...t }) => t,
      ),
    });
  }
  const {
    schemaVersion: _schema,
    packages: _packages,
    releasedPackages: _released,
    counts: _counts,
    ...binding
  } = plan;
  const recomputed = await buildSnapshotPlan(binding, candidates);
  if (canonicalPackage(recomputed) !== canonicalPackage(plan))
    fail('SNAPSHOT_INVALID', 400);
  return plan;
}
const scalarCompare = (a: string, b: string) => {
  const x = Array.from(a).map((c) => c.codePointAt(0)!),
    y = Array.from(b).map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
export async function snapshotDigests(plan: SnapshotPlan) {
  const rows = plan.packages.flatMap((p) => p.targets),
    sort = (a: SnapshotTarget, b: SnapshotTarget) =>
      scalarCompare(a.coverageIdentity, b.coverageIdentity) ||
      scalarCompare(a.characterId, b.characterId) ||
      scalarCompare(a.lessonVersion, b.lessonVersion) ||
      a.memberOrdinal - b.memberOrdinal;
  const included = rows
      .filter((t) => t.coverageStatus === 'included')
      .sort(sort)
      .map((t) => t.eligibility),
    excluded = rows
      .filter((t) => t.coverageStatus === 'excluded')
      .sort(sort)
      .map((t) => t.eligibility),
    planDigest = await H(plan);
  return {
    planDigest,
    expectedMemberDigest: await H({
      schemaVersion: 'r6-member-set-1',
      members: rows,
    }),
    releasedPackageDigest: await H({
      schemaVersion: 'r6-released-packages-1',
      packages: plan.releasedPackages,
    }),
    prospectiveDigest: await H({
      schemaVersion: 'r6-prospective-corpus-1',
      corpusVersion: plan.corpusVersion,
      corpusDigest: plan.corpusDigest,
      candidateId: plan.candidateId,
      sourceDigest: plan.sourceDigest,
      artifactDigest: plan.artifactDigest,
      releasedPackages: plan.releasedPackages,
      members: included,
    }),
    exclusionReportDigest: await H({
      schemaVersion: 'r6-exclusion-report-1',
      corpusVersion: plan.corpusVersion,
      corpusDigest: plan.corpusDigest,
      candidateId: plan.candidateId,
      sourceDigest: plan.sourceDigest,
      artifactDigest: plan.artifactDigest,
      planDigest,
      members: excluded,
    }),
  };
}
export function snapshotMemberFacts(plan: SnapshotPlan) {
  return plan.packages.flatMap((p) =>
    p.targets.map((t) => ({
      member_ordinal: t.memberOrdinal,
      target_index: t.targetIndex,
      coverage_identity: t.coverageIdentity,
      character_id: t.characterId,
      lesson_version: t.lessonVersion,
      content_digest: t.contentDigest,
      source_evidence_id: t.sourceEvidenceId,
      review_id: t.reviewId,
      proof_id: t.proofId,
      asset_inventory_digest: t.assetInventoryDigest,
      package_eligible: t.packageEligible ? 1 : 0,
      package_eligibility_json: canonicalPackage(p.packageEligibility),
      package_eligibility_digest: p.packageEligibilityDigest,
      coverage_status: t.coverageStatus,
      eligibility_json: canonicalPackage(t.eligibility),
      eligibility_digest: t.eligibilityDigest,
    })),
  );
}
export async function validateSnapshotRows(
  plan: SnapshotPlan,
  rows: Array<Record<string, unknown>>,
) {
  const expected = snapshotMemberFacts(await inspectSnapshotPlan(plan));
  if (rows.length !== expected.length) fail('SNAPSHOT_INCOMPLETE');
  const ordered = [...rows].sort(
    (a, b) => Number(a.member_ordinal) - Number(b.member_ordinal),
  );
  for (const [i, row] of ordered.entries())
    for (const [key, value] of Object.entries(expected[i]))
      if (row[key] !== value) fail('SNAPSHOT_INCOMPLETE');
  return await snapshotDigests(plan);
}
