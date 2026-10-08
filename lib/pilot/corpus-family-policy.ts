/** Closed R6 parent request inspection; private source shapes are finalized separately. */
import { safeCorpusJson, corpusId } from './corpus-policy.ts';
import { exact, digest, text } from '../curriculum/story-package.ts';
import { curriculumDigest } from '../curriculum/digest.ts';
import { fail, validIssuer } from './story-policy.ts';
import type {
  CorpusProposalInput,
  CorpusApproveInput,
} from '../curriculum/corpus-types.ts';
export function inspectCorpusProposalInput(
  input: unknown,
): CorpusProposalInput {
  const value = safeCorpusJson(input, 8000);
  if (
    !exact(value, [
      'corpusVersion',
      'selection',
      'predecessorProposalId',
      'expectedSourceDigest',
    ]) ||
    !corpusId(value.corpusVersion) ||
    !(
      value.predecessorProposalId === null ||
      corpusId(value.predecessorProposalId)
    ) ||
    !(value.expectedSourceDigest === null || digest(value.expectedSourceDigest))
  )
    fail('INVALID_REQUEST', 400);
  if (value.selection !== null) {
    const selection = value.selection;
    if (
      !exact(selection, [
        'lessonVersion',
        'contentDigest',
        'releaseId',
        'releaseRevision',
      ]) ||
      !corpusId(selection.lessonVersion) ||
      !digest(selection.contentDigest) ||
      !corpusId(selection.releaseId) ||
      !Number.isSafeInteger(selection.releaseRevision) ||
      Number(selection.releaseRevision) < 1
    )
      fail('INVALID_REQUEST', 400);
  }
  return value as unknown as CorpusProposalInput;
}
export function inspectCorpusApprovalInput(input: unknown): CorpusApproveInput {
  const value = safeCorpusJson(input, 8000);
  if (
    !exact(value, ['proposalId', 'sourceDigest']) ||
    !corpusId(value.proposalId) ||
    !digest(value.sourceDigest)
  )
    fail('INVALID_REQUEST', 400);
  return value as unknown as CorpusApproveInput;
}

/** Historical attribution only: embedded issuer settings never grant current/archive trust. */
export async function inspectCorpusPlacementSource(input: unknown) {
  const s = safeCorpusJson(input, 200000);
  const keys = [
    'schemaVersion',
    'policyVersion',
    'actorId',
    'childId',
    'installationId',
    'corpusVersion',
    'corpusDigest',
    'namespace',
    'selectionOrdinal',
    'predecessorProposalId',
    'predecessorSourceDigest',
    'selection',
    'evidenceEpoch',
    'packageEligibilityDigest',
    'authority',
    'authorityDigest',
    'onboardingDigest',
    'evidenceDigest',
    'selectedByParent',
    'reason',
    'createdAt',
  ];
  const integer = (v: unknown, min = 0) =>
    Number.isSafeInteger(v) && Number(v) >= min;
  if (
    !exact(s, keys) ||
    s.schemaVersion !== 'r6-placement-source-1' ||
    s.policyVersion !== 'r6-placement-1' ||
    !text(s.installationId, 240) ||
    !String(s.installationId).isWellFormed() ||
    !['actorId', 'childId', 'corpusVersion'].every((k) => corpusId(s[k])) ||
    ![
      'corpusDigest',
      'packageEligibilityDigest',
      'authorityDigest',
      'onboardingDigest',
      'evidenceDigest',
    ].every((k) => digest(s[k])) ||
    !(s.namespace === null || corpusId(s.namespace)) ||
    !integer(s.selectionOrdinal, 1) ||
    !integer(s.evidenceEpoch) ||
    !integer(s.createdAt) ||
    typeof s.selectedByParent !== 'boolean'
  )
    fail('INVALID_REQUEST', 400);
  if (
    s.selectionOrdinal === 1
      ? s.predecessorProposalId !== null || s.predecessorSourceDigest !== null
      : !corpusId(s.predecessorProposalId) || !digest(s.predecessorSourceDigest)
  )
    fail('INVALID_REQUEST', 400);
  inspectCorpusProposalInput({
    corpusVersion: s.corpusVersion,
    selection: s.selection,
    predecessorProposalId: s.predecessorProposalId,
    expectedSourceDigest: s.predecessorSourceDigest,
  });
  const a = await inspectCorpusAuthorityIdentity(s.authority, {
    installationId: s.installationId,
    corpusVersion: s.corpusVersion,
    corpusDigest: s.corpusDigest,
    namespace: s.namespace,
    selection: s.selection,
  });
  const expectedReason = s.selectedByParent
    ? 'You chose this available story. Saved setup and responses do not establish mastery.'
    : 'This is the first available unfinished story. Familiarity checks will guide the introduction.';
  if (
    s.reason !== expectedReason ||
    (await curriculumDigest(a)) !== s.authorityDigest
  )
    fail('INVALID_REQUEST', 400);
  return s;
}
export function inspectCorpusPlacementReason(input: unknown) {
  const v = safeCorpusJson(input, 1000);
  if (
    !exact(v, ['schemaVersion', 'text', 'selectedByParent']) ||
    v.schemaVersion !== 'r6-placement-reason-1' ||
    typeof v.selectedByParent !== 'boolean' ||
    v.text !==
      (v.selectedByParent
        ? 'You chose this available story. Saved setup and responses do not establish mastery.'
        : 'This is the first available unfinished story. Familiarity checks will guide the introduction.')
  )
    fail('INVALID_REQUEST', 400);
  return v;
}
export function inspectCorpusApprovalAck(input: unknown) {
  const v = safeCorpusJson(input, 2000);
  if (
    !exact(v, ['planId', 'proposalId', 'sourceDigest', 'approvedAt']) ||
    !corpusId(v.planId) ||
    !corpusId(v.proposalId) ||
    !digest(v.sourceDigest) ||
    typeof v.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.approvedAt)) ||
    new Date(v.approvedAt).toISOString() !== v.approvedAt
  )
    fail('INVALID_REQUEST', 400);
  return v;
}

/** Exclusive SQLite BINARY bound for a valid Unicode scalar prefix. */
export function corpusPrefixUpperBound(prefix: string): string | null {
  if (typeof prefix !== 'string' || !prefix || !prefix.isWellFormed())
    fail('INVALID_QUERY', 400);
  const scalars = Array.from(prefix);
  for (let i = scalars.length - 1; i >= 0; i--) {
    const point = scalars[i].codePointAt(0)!;
    if (point === 0x10ffff) continue;
    const next = point === 0xd7ff ? 0xe000 : point + 1;
    return scalars.slice(0, i).join('') + String.fromCodePoint(next);
  }
  // No finite successor: every string at or above an all-maximum prefix extends it.
  return null;
}

export async function inspectCorpusAuthorityIdentity(
  input: unknown,
  s: {
    installationId: unknown;
    corpusVersion: unknown;
    corpusDigest: unknown;
    namespace: unknown;
    selection: unknown;
  },
) {
  const integer = (v: unknown, min = 0) =>
    Number.isSafeInteger(v) && Number(v) >= min;
  const sortedIds = (v: unknown, max: number) =>
    Array.isArray(v) &&
    v.length <= max &&
    v.every(corpusId) &&
    new Set(v).size === v.length &&
    v.every((id, i) => i === 0 || v[i - 1] < id);
  const a = safeCorpusJson(input, 200000);
  if (
    !exact(a, [
      'schemaVersion',
      'corpusVersion',
      'corpusDigest',
      'installationId',
      'namespaceKey',
      'releaseId',
      'releaseRevision',
      'snapshotId',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'buildId',
      'scope',
      'ownerDecisionId',
      'configuration',
    ]) ||
    a.schemaVersion !== 'r6-authority-1' ||
    !text(a.installationId, 240) ||
    !String(a.installationId).isWellFormed() ||
    ![
      'corpusVersion',
      'namespaceKey',
      'releaseId',
      'snapshotId',
      'candidateId',
      'buildId',
    ].every((k) => corpusId(a[k])) ||
    !['corpusDigest', 'sourceDigest', 'artifactDigest'].every((k) =>
      digest(a[k]),
    ) ||
    !integer(a.releaseRevision, 1) ||
    !(a.ownerDecisionId === null || corpusId(a.ownerDecisionId))
  )
    fail('INVALID_REQUEST', 400);
  const scope = a.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope))
    fail('INVALID_REQUEST', 400);
  const kind = (scope as Record<string, unknown>).kind;
  if (kind === 'starter') {
    if (!exact(scope, ['kind']) || !corpusId(a.ownerDecisionId))
      fail('INVALID_REQUEST', 400);
  } else {
    if (
      !exact(
        scope,
        kind === 'verification'
          ? ['kind', 'namespace', 'members']
          : ['kind', 'members'],
      ) ||
      !['verification', 'supervised-trial'].includes(String(kind)) ||
      !Array.isArray(scope.members) ||
      scope.members.length < 1 ||
      scope.members.length > 100 ||
      scope.members.some(
        (m) =>
          !exact(m, ['parentId', 'childId']) ||
          !corpusId(m.parentId) ||
          !corpusId(m.childId),
      )
    )
      fail('INVALID_REQUEST', 400);
    if (
      new Set(scope.members.map((m) => m.childId)).size !== scope.members.length
    )
      fail('INVALID_REQUEST', 400);
    const tuples = scope.members.map((m) => `${m.childId}\0${m.parentId}`);
    if (tuples.some((v, i) => i > 0 && tuples[i - 1] >= v))
      fail('INVALID_REQUEST', 400);
    if (
      (kind === 'verification' &&
        (scope.namespace !== s.namespace || a.ownerDecisionId !== null)) ||
      (kind === 'supervised-trial' && !corpusId(a.ownerDecisionId))
    )
      fail('INVALID_REQUEST', 400);
  }
  const config = a.configuration;
  if (
    !exact(config, ['trust', 'candidateId', 'capability', 'ownerIds']) ||
    !corpusId(config.candidateId) ||
    !sortedIds(config.ownerIds, 20)
  )
    fail('INVALID_REQUEST', 400);
  const trust = config.trust;
  if (trust !== null) {
    if (
      !exact(trust, [
        'candidateId',
        'sourceDigest',
        'artifactDigest',
        'buildId',
        'issuers',
        'archiveIssuers',
      ]) ||
      trust.candidateId !== a.candidateId ||
      trust.sourceDigest !== a.sourceDigest ||
      trust.artifactDigest !== a.artifactDigest ||
      trust.buildId !== a.buildId
    )
      fail('INVALID_REQUEST', 400);
    for (const name of ['issuers', 'archiveIssuers']) {
      const list = trust[name];
      if (!Array.isArray(list)) fail('INVALID_REQUEST', 400);
      let last = '';
      for (const i of list) {
        if (!validIssuer(i) || i.issuerId <= last) fail('INVALID_REQUEST', 400);
        last = i.issuerId;
      }
    }
  }
  const cap = config.capability;
  if (
    cap !== null &&
    (!exact(cap, [
      'installationId',
      'corpusVersion',
      'corpusDigest',
      'namespace',
      'parentIds',
      'childIds',
    ]) ||
      cap.installationId !== s.installationId ||
      cap.corpusVersion !== s.corpusVersion ||
      cap.corpusDigest !== s.corpusDigest ||
      cap.namespace !== s.namespace ||
      !sortedIds(cap.parentIds, 100) ||
      (cap.parentIds as unknown[]).length === 0 ||
      !sortedIds(cap.childIds, 100) ||
      (cap.childIds as unknown[]).length === 0)
  )
    fail('INVALID_REQUEST', 400);
  // Persisted positive authority cannot omit the actual configured release lane.
  if (trust === null || (kind === 'verification' ? cap === null : cap !== null))
    fail('INVALID_REQUEST', 400);
  if (kind === 'verification') {
    const binding = cap as { parentIds: string[]; childIds: string[] };
    const members = (
      scope as { members: Array<{ parentId: string; childId: string }> }
    ).members;
    if (
      members.some(
        (m) =>
          !binding.parentIds.includes(m.parentId) ||
          !binding.childIds.includes(m.childId),
      )
    )
      fail('INVALID_REQUEST', 400);
  }
  const selection = s.selection as Record<string, unknown>;
  if (
    a.corpusVersion !== s.corpusVersion ||
    a.corpusDigest !== s.corpusDigest ||
    a.installationId !== s.installationId ||
    a.namespaceKey !== (s.namespace ?? 'ordinary') ||
    a.releaseId !== selection.releaseId ||
    a.releaseRevision !== selection.releaseRevision ||
    config.candidateId !== a.candidateId
  )
    fail('INVALID_REQUEST', 400);
  return a;
}
