/** Pure R6 policy. Inputs named facts are trusted server observations, never browser authority. */
import { inspectJson } from '../curriculum/json.ts';
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import { exact, digest, text } from '../curriculum/story-package.ts';
import { fail } from './story-policy.ts';
import type {
  CorpusClassification,
  CorpusCounts,
  CorpusReason,
} from '../curriculum/corpus-types.ts';

export const CORPUS_POLICY = 'r6-corpus-policy-1';
export const STARTER_MINIMUM = 1600;
export interface CorpusManifest {
  schemaVersion: 'r6-corpus-1';
  corpusId: string;
  corpusVersion: string;
  canonicalizationVersion: 's3-json-1';
  policyVersion: 'r6-corpus-policy-1';
  items: Array<{
    lessonVersion: string;
    contentDigest: string;
    batchId: string;
    trackId: string;
    sequence: number;
  }>;
}
export function safeCorpusJson(
  input: unknown,
  maxBytes = 2 * 1024 * 1024,
): unknown {
  const checked = inspectJson(input);
  if (
    checked.errors.length ||
    new TextEncoder().encode(JSON.stringify(checked.value)).length > maxBytes
  )
    fail('INVALID_REQUEST', 400);
  return checked.value;
}
export function corpusId(v: unknown): v is string {
  return text(v, 120) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v);
}
export function normalizeCoverageIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value !== value.normalize('NFC') ||
    !/^\p{Script=Han}$/u.test(value)
  )
    fail('INVALID_IDENTITY', 400);
  return value;
}
export function inspectCorpusManifest(input: unknown): CorpusManifest {
  const v = safeCorpusJson(input);
  if (
    !exact(v, [
      'schemaVersion',
      'corpusId',
      'corpusVersion',
      'canonicalizationVersion',
      'policyVersion',
      'items',
    ]) ||
    v.schemaVersion !== 'r6-corpus-1' ||
    v.canonicalizationVersion !== 's3-json-1' ||
    v.policyVersion !== CORPUS_POLICY ||
    !corpusId(v.corpusId) ||
    !corpusId(v.corpusVersion) ||
    !Array.isArray(v.items) ||
    v.items.length < 1 ||
    v.items.length > 5000
  )
    fail('INVALID_CORPUS', 400);
  const identities = new Set<string>();
  for (const item of v.items) {
    if (
      !exact(item, [
        'lessonVersion',
        'contentDigest',
        'batchId',
        'trackId',
        'sequence',
      ]) ||
      !corpusId(item.lessonVersion) ||
      !digest(item.contentDigest) ||
      !corpusId(item.batchId) ||
      !corpusId(item.trackId) ||
      !Number.isSafeInteger(item.sequence) ||
      Number(item.sequence) < 1 ||
      Number(item.sequence) > 1000000 ||
      identities.has(item.lessonVersion)
    )
      fail('INVALID_CORPUS', 400);
    identities.add(item.lessonVersion);
  }
  return v as unknown as CorpusManifest;
}
/** Trusted display indexing uses profile field bounds, independently of user-query limits. */
export function corpusIndexTokens(
  input: unknown,
  maxScalars: number = 240,
): string[] {
  if (
    typeof input !== 'string' ||
    !input.isWellFormed() ||
    !Number.isInteger(maxScalars) ||
    maxScalars < 1 ||
    maxScalars > 240 ||
    Array.from(input).length > maxScalars
  )
    fail('INVALID_PACKAGE', 400);
  return (
    input
      .normalize('NFC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLowerCase()
      .match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{M}])+/gu) ?? []
  );
}
export function normalizeCorpusSearch(
  input: unknown,
  limit: unknown = 20,
): { q: string; tokens: string[]; limit: number } {
  if (
    typeof input !== 'string' ||
    !input.isWellFormed() ||
    Array.from(input).length > 80 ||
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 50
  )
    fail('INVALID_QUERY', 400);
  const q = input.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const tokens = corpusIndexTokens(q, 80);
  return { q, tokens, limit: Number(limit) };
}
export function corpusSearchMatches(
  tokens: string[],
  indexedTerms: string[],
): boolean {
  return tokens.every((t) => indexedTerms.some((term) => term.startsWith(t)));
}
export interface SourceHead {
  id: string;
  lineageId: string;
  ordinal: number;
  digest: string;
  classification: CorpusClassification;
  lessonVersion: string;
  contentDigest: string;
}
export interface SourceRequest {
  requestId: string;
  lessonVersion: string;
  contentDigest: string;
  classification: 'unverified-draft' | 'real-source-reviewed';
  sourceRefs: string[];
  licenseRefs: string[];
  reviewRefs: string[];
  identityReviews: Array<{
    characterId: string;
    hanzi: string;
    kind: 'simplified' | 'alias';
    reviewRef: string;
  }>;
  predecessorEvidenceId: string | null;
  expectedEvidenceDigest: string | null;
}
function refs(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= 20 &&
    v.every(corpusId) &&
    new Set(v).size === v.length
  );
}
export function inspectSourceRequest(
  input: unknown,
  targets: Array<{ characterId: string; hanzi: string }>,
  approvedReviewRefs: string[],
): SourceRequest {
  const v = safeCorpusJson(input);
  if (
    !exact(v, [
      'requestId',
      'lessonVersion',
      'contentDigest',
      'classification',
      'sourceRefs',
      'licenseRefs',
      'reviewRefs',
      'identityReviews',
      'predecessorEvidenceId',
      'expectedEvidenceDigest',
    ]) ||
    !corpusId(v.requestId) ||
    !corpusId(v.lessonVersion) ||
    !digest(v.contentDigest) ||
    !['unverified-draft', 'real-source-reviewed'].includes(
      String(v.classification),
    ) ||
    !refs(v.sourceRefs) ||
    !refs(v.licenseRefs) ||
    !refs(v.reviewRefs) ||
    !Array.isArray(v.identityReviews) ||
    v.identityReviews.length > 2 ||
    (v.predecessorEvidenceId !== null && !corpusId(v.predecessorEvidenceId)) ||
    (v.expectedEvidenceDigest !== null && !digest(v.expectedEvidenceDigest))
  )
    fail('INVALID_SOURCE', 400);
  const seen = new Set<string>();
  for (const r of v.identityReviews) {
    if (
      !exact(r, ['characterId', 'hanzi', 'kind', 'reviewRef']) ||
      !corpusId(r.characterId) ||
      !corpusId(r.reviewRef) ||
      !['simplified', 'alias'].includes(String(r.kind)) ||
      !targets.some(
        (t) => t.characterId === r.characterId && t.hanzi === r.hanzi,
      ) ||
      seen.has(r.characterId) ||
      !v.reviewRefs.includes(r.reviewRef) ||
      !approvedReviewRefs.includes(r.reviewRef)
    )
      fail('INVALID_SOURCE', 400);
    normalizeCoverageIdentity(r.hanzi);
    seen.add(r.characterId);
  }
  if (
    v.classification === 'real-source-reviewed' &&
    (targets.length !== 2 ||
      seen.size !== 2 ||
      v.sourceRefs.length === 0 ||
      v.licenseRefs.length === 0 ||
      v.reviewRefs.length === 0)
  )
    fail('SOURCE_REVIEW_REQUIRED', 400);
  return v as unknown as SourceRequest;
}
export function assertSourceSuccessor(
  request: SourceRequest,
  head: SourceHead | null,
  fixtureInstallation: boolean,
): {
  classification: CorpusClassification;
  ordinal: number;
  lineageId: string | null;
} {
  if (
    head
      ? request.predecessorEvidenceId !== head.id ||
        request.expectedEvidenceDigest !== head.digest ||
        request.lessonVersion !== head.lessonVersion ||
        request.contentDigest !== head.contentDigest
      : request.predecessorEvidenceId !== null ||
        request.expectedEvidenceDigest !== null
  )
    fail('SOURCE_STALE');
  return {
    classification:
      fixtureInstallation || head?.classification === 'verification-fixture'
        ? 'verification-fixture'
        : request.classification,
    ordinal: (head?.ordinal ?? 0) + 1,
    lineageId: head?.lineageId ?? null,
  };
}
export interface TargetFacts {
  characterId: string;
  hanzi: string;
  classification: CorpusClassification;
  identityKind: 'simplified' | 'alias' | null;
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
}
export interface PackageFacts {
  /** Immutable corpus ordinal; callers must resolve this from the registered corpus. */
  ordinal: number;
  /** Bound sealed prospective membership, not merely reviewed eligibility. */
  prospective: boolean;
  lessonVersion: string;
  contentDigest: string;
  targets: TargetFacts[];
  trial: boolean;
  committed: boolean;
}
export function deriveCorpusCoverage(packages: PackageFacts[]): {
  counts: CorpusCounts;
  releasedPackages: Array<{ lessonVersion: string; contentDigest: string }>;
  members: Array<{
    lessonVersion: string;
    characterId: string;
    coverageIdentity: string;
    eligible: boolean;
    reasonCodes: CorpusReason[];
  }>;
  fixtureCharacterCount: number;
  verificationPackageCount: number;
} {
  const categories = {
    fixture: new Set<string>(),
    machineValidDraft: new Set<string>(),
    reviewedReady: new Set<string>(),
    supervisedTrial: new Set<string>(),
    prospectiveStarter: new Set<string>(),
    committedStarter: new Set<string>(),
  };
  const members: ReturnType<typeof deriveCorpusCoverage>['members'] = [],
    releasedPackages: ReturnType<
      typeof deriveCorpusCoverage
    >['releasedPackages'] = [];
  let verificationPackageCount = 0;
  for (const p of [...packages].sort((a, b) => a.ordinal - b.ordinal)) {
    const reasons = p.targets.map((t) => {
      const r: CorpusReason[] = [];
      normalizeCoverageIdentity(t.hanzi);
      if (t.classification === 'verification-fixture') r.push('FIXTURE');
      else if (t.classification !== 'real-source-reviewed')
        r.push('UNVERIFIED_SOURCE');
      if (t.identityKind === 'alias') r.push('ALIAS');
      else if (t.identityKind !== 'simplified') r.push('UNVERIFIED_SOURCE');
      if (t.placeholder) r.push('PLACEHOLDER');
      if (!t.licensed) r.push('MISSING_LICENSE');
      if (!t.wordsComplete) r.push('INCOMPLETE_WORD_CONTEXT');
      if (!t.contentReviewed) r.push('UNREVIEWED_CONTENT');
      if (!t.audioReviewed) r.push('UNREVIEWED_AUDIO');
      if (!t.promptsComplete) r.push('MISSING_PROMPT');
      if (!t.assetsComplete) r.push('MISSING_ASSET');
      if (!t.proofValid) r.push('INVALID_PROOF');
      if (!t.current) r.push('STALE_EVIDENCE');
      if (!t.machineValid) r.push('UNSUPPORTED_RENDERER');
      return [...new Set(r)];
    });
    const complete =
      p.targets.length === 2 && reasons.every((r) => r.length === 0);
    if (
      p.targets.length === 2 &&
      p.targets.every(
        (t) => t.machineValid && t.classification === 'verification-fixture',
      )
    )
      verificationPackageCount++;
    if (complete)
      releasedPackages.push({
        lessonVersion: p.lessonVersion,
        contentDigest: p.contentDigest,
      });
    p.targets.forEach((t, i) => {
      if (t.classification === 'verification-fixture')
        categories.fixture.add(t.hanzi);
      if (t.machineValid && t.classification !== 'verification-fixture')
        categories.machineValidDraft.add(t.hanzi);
      const r = [...reasons[i]];
      if (!complete) r.push('PACKAGE_INELIGIBLE');
      const duplicate = categories.reviewedReady.has(t.hanzi);
      if (complete) {
        categories.reviewedReady.add(t.hanzi);
        if (p.prospective) categories.prospectiveStarter.add(t.hanzi);
        if (p.trial) categories.supervisedTrial.add(t.hanzi);
        if (p.committed) categories.committedStarter.add(t.hanzi);
        if (duplicate) r.push('DUPLICATE_IDENTITY');
      }
      members.push({
        lessonVersion: p.lessonVersion,
        characterId: t.characterId,
        coverageIdentity: t.hanzi,
        eligible: complete && !duplicate,
        reasonCodes: [...new Set(r)],
      });
    });
  }
  const counts = Object.fromEntries(
    Object.entries(categories).map(([k, v]) => [k, v.size]),
  ) as unknown as CorpusCounts;
  return {
    counts,
    releasedPackages,
    members,
    fixtureCharacterCount: categories.fixture.size,
    verificationPackageCount,
  };
}
export function assertPublicationCAS(facts: {
  scope: 'starter' | 'supervised-trial' | 'verification';
  includedCharacterCount: number;
  expectedRevision: number;
  currentRevision: number;
  predecessorId: string | null;
  currentHeadId: string | null;
  sealedEpoch: number;
  currentEpoch: number;
  ownerAccepted: boolean;
  allMembersCurrent: boolean;
}): void {
  if (facts.scope === 'verification') fail('VERIFICATION_FORBIDDEN', 403);
  if (
    facts.expectedRevision !== facts.currentRevision ||
    facts.predecessorId !== facts.currentHeadId ||
    facts.sealedEpoch !== facts.currentEpoch
  )
    fail('PUBLICATION_STALE');
  if (!facts.ownerAccepted || !facts.allMembersCurrent)
    fail('PUBLICATION_INELIGIBLE');
  if (
    facts.scope === 'starter' &&
    facts.includedCharacterCount < STARTER_MINIMUM
  )
    fail('STARTER_THRESHOLD');
}
/** Resolve per requested package; unrelated package evidence does not withdraw this one. */
export function currentCorpusPackageAvailable(facts: {
  isCurrentHead: boolean;
  scopePermitted: boolean;
  packageCurrent: boolean;
}): boolean {
  return facts.isCurrentHead && facts.scopePermitted && facts.packageCurrent;
}
export function parseCorpusCapability(input: unknown): null | {
  installationId: string;
  corpusVersion: string;
  corpusDigest: string;
  namespace: string;
  parentIds: string[];
  childIds: string[];
} {
  if (input === undefined || input === null || input === '') return null;
  let v: unknown;
  try {
    v = safeCorpusJson(typeof input === 'string' ? JSON.parse(input) : input);
  } catch {
    return null;
  }
  if (
    !exact(v, [
      'installationId',
      'corpusVersion',
      'corpusDigest',
      'namespace',
      'parentIds',
      'childIds',
    ]) ||
    !text(v.installationId, 240) ||
    !corpusId(v.corpusVersion) ||
    !digest(v.corpusDigest) ||
    !corpusId(v.namespace)
  )
    return null;
  for (const key of ['parentIds', 'childIds'])
    if (
      !Array.isArray(v[key]) ||
      v[key].length === 0 ||
      v[key].length > 100 ||
      !v[key].every(corpusId) ||
      new Set(v[key]).size !== v[key].length
    )
      return null;
  return v as ReturnType<typeof parseCorpusCapability>;
}
export function authorizeCorpusOwner(
  ownerIds: string[],
  actor: {
    id: string;
    role: string;
    enabled: boolean;
    sessionExpiresAt: number;
  },
  now: number,
): boolean {
  return (
    ownerIds.includes(actor.id) &&
    ['parent', 'operator'].includes(actor.role) &&
    actor.enabled &&
    actor.sessionExpiresAt > now
  );
}
export function corpusRequest(
  operation: string,
  actorId: string,
  installationId: string,
  resourceId: string,
  request: unknown,
): unknown {
  if (
    ![
      'source-evidence',
      'batch',
      'snapshot',
      'snapshot-chunk',
      'snapshot-seal',
      'owner-decision',
      'publication',
      'proposal',
      'approval',
      'start',
      'action',
    ].includes(operation) ||
    !corpusId(actorId) ||
    !text(installationId, 240) ||
    !corpusId(resourceId)
  )
    fail('INVALID_REQUEST', 400);
  return {
    schemaVersion: `r6-${operation}-request-1`,
    actorId,
    installationId,
    resourceId,
    request: safeCorpusJson(request),
  };
}
export async function corpusRequestDigest(
  operation: string,
  actorId: string,
  installationId: string,
  resourceId: string,
  request: unknown,
): Promise<string> {
  return curriculumDigest(
    corpusRequest(operation, actorId, installationId, resourceId, request),
  );
}
export function assertExactCorpusReplay(
  original: unknown,
  current: unknown,
): void {
  if (canonicalPackage(original) !== canonicalPackage(current))
    fail('REQUEST_CONFLICT');
}

export function parseCorpusOwnerIds(input: unknown): string[] {
  if (input === undefined || input === null || input === '') return [];
  let value: unknown;
  try {
    value = safeCorpusJson(
      typeof input === 'string' ? JSON.parse(input) : input,
      4096,
    );
  } catch {
    fail('OWNER_CONFIG_INVALID', 503);
  }
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    !value.every(corpusId) ||
    new Set(value).size !== value.length
  )
    fail('OWNER_CONFIG_INVALID', 503);
  return value;
}
export function parseCorpusFixtureBinding(
  input: unknown,
  installationId: string,
): null | {
  schemaVersion: 'r6-fixture-binding-1';
  installationId: string;
  mode: 'synthetic-only';
} {
  if (input === undefined || input === null || input === '') return null;
  let v: unknown;
  try {
    v = safeCorpusJson(
      typeof input === 'string' ? JSON.parse(input) : input,
      4096,
    );
  } catch {
    fail('FIXTURE_BINDING_INVALID', 503);
  }
  if (
    !exact(v, ['schemaVersion', 'installationId', 'mode']) ||
    v.schemaVersion !== 'r6-fixture-binding-1' ||
    v.mode !== 'synthetic-only' ||
    v.installationId !== installationId
  )
    fail('FIXTURE_BINDING_INVALID', 503);
  return v as unknown as NonNullable<
    ReturnType<typeof parseCorpusFixtureBinding>
  >;
}
export function validateCorpusCapability(
  capability: ReturnType<typeof parseCorpusCapability>,
  context: {
    installationId: string;
    corpusVersion: string;
    corpusDigest: string;
    namespace: string;
    candidateId: string | null;
    testMode: boolean;
    testContent: boolean;
    tokenBound: boolean;
    freshOwnedInstallation: boolean;
    currentParentIds: string[];
    currentChildIds: string[];
    currentLinkedPairs: Array<{ parentId: string; childId: string }>;
  },
): void {
  if (
    !capability ||
    !context.candidateId ||
    !context.testMode ||
    !context.testContent ||
    !context.tokenBound ||
    !context.freshOwnedInstallation ||
    capability.installationId !== context.installationId ||
    capability.corpusVersion !== context.corpusVersion ||
    capability.corpusDigest !== context.corpusDigest ||
    capability.namespace !== context.namespace ||
    !capability.parentIds.every((p) => context.currentParentIds.includes(p)) ||
    !capability.childIds.every(
      (c) =>
        context.currentChildIds.includes(c) &&
        context.currentLinkedPairs.some(
          (pair) =>
            pair.childId === c && capability.parentIds.includes(pair.parentId),
        ),
    )
  )
    fail('CAPABILITY_DENIED', 403);
}
export function inspectCorpusChunk(
  input: unknown,
  planned: Array<{ lessonVersion: string; contentDigest: string }>,
): {
  requestId: string;
  packages: Array<{ lessonVersion: string; contentDigest: string }>;
} {
  const v = safeCorpusJson(input, 16384);
  if (
    !exact(v, ['requestId', 'packages']) ||
    !corpusId(v.requestId) ||
    !Array.isArray(v.packages) ||
    v.packages.length === 0 ||
    v.packages.length > 50
  )
    fail('INVALID_CHUNK', 400);
  const seen = new Set<string>();
  for (const p of v.packages) {
    if (
      !exact(p, ['lessonVersion', 'contentDigest']) ||
      !planned.some(
        (item) =>
          item.lessonVersion === p.lessonVersion &&
          item.contentDigest === p.contentDigest,
      ) ||
      seen.has(String(p.lessonVersion))
    )
      fail('INVALID_CHUNK', 400);
    seen.add(String(p.lessonVersion));
  }
  return v as unknown as ReturnType<typeof inspectCorpusChunk>;
}
export function validateSnapshotSeal(facts: {
  expectedPlanDigest: string;
  actualPlanDigest: string;
  preparedEpoch: number;
  currentEpoch: number;
  expectedTargetKeys: string[];
  persistedTargetKeys: string[];
  expectedMemberDigest: string;
  actualMemberDigest: string;
  expectedReleasedPackageDigest: string;
  actualReleasedPackageDigest: string;
}): void {
  if (
    facts.expectedPlanDigest !== facts.actualPlanDigest ||
    facts.preparedEpoch !== facts.currentEpoch
  )
    fail('SNAPSHOT_STALE');
  const expected = [...facts.expectedTargetKeys].sort(),
    actual = [...facts.persistedTargetKeys].sort();
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    canonicalPackage(expected) !== canonicalPackage(actual) ||
    facts.expectedMemberDigest !== facts.actualMemberDigest ||
    facts.expectedReleasedPackageDigest !== facts.actualReleasedPackageDigest
  )
    fail('SNAPSHOT_INCOMPLETE');
}
