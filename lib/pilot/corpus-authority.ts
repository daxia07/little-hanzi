/** Current R6 authority. Stored history is never a fresh release grant. */
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { exact } from '../curriculum/story-package.ts';
import type {
  CorpusScope,
  CorpusReason,
  CorpusPublicationReceipt,
} from '../curriculum/corpus-types.ts';
import { fail } from './story-policy.ts';
import {
  safeCorpusJson,
  corpusId,
  corpusRequest,
  assertExactCorpusReplay,
  assertPublicationCAS,
} from './corpus-policy.ts';
import {
  corpusOne,
  corpusRows,
  corpusInstallation,
  corpusInstallationGuard,
  corpusActorGuard,
  requireCorpusActor,
  corpusNow,
  corpusISO,
  corpusNewId,
  sqlValue as q,
  type CorpusContext,
  type CorpusRow,
} from './corpus-db.ts';
import {
  registeredCorpus,
  loadCorpusPackage,
  currentCorpusSource,
} from './corpus-store.ts';
import { authenticateCorpusProof, verifyCorpusProof } from './corpus-proof.ts';
import { evaluateSnapshotCandidate } from './corpus-snapshot-facts.ts';
import {
  inspectPackageEligibility,
  type PackageEligibility,
  type SnapshotPlan,
  inspectSnapshotPlan,
} from './corpus-snapshot-policy.ts';
import { snapshotCandidates } from './corpus-snapshot-store.ts';
export interface CorpusAuthority {
  corpusVersion: string;
  corpusDigest: string;
  installationId: string;
  namespaceKey: string;
  releaseId: string;
  releaseRevision: number;
  status: 'released' | 'withdrawn';
  scope:
    | CorpusScope
    | {
        kind: 'verification';
        namespace: string;
        members: Array<{ parentId: string; childId: string }>;
      };
  snapshotId: string;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  buildId: string;
  evidenceEpoch: number;
  ownerDecisionId: string | null;
  configuration: string;
}
export interface CorpusPackageAuthority {
  lessonVersion: string;
  contentDigest: string;
  available: boolean;
  reasonCode: CorpusReason | null;
  eligibilityDigest: string;
  sourceIds: Array<{ id: string; digest: string }>;
  reviewId: string | null;
  proofId: string | null;
  soundReview: 'pending' | 'reviewed' | 'synthetic';
}
export const corpusAuthorityConfiguration = (c: CorpusContext) => {
  const trust = c.config.curriculumTrust,
    cap = c.corpus.capability;
  const issuers = (items: NonNullable<typeof trust>['issuers']) =>
    [...items]
      .sort((a, b) =>
        a.issuerId < b.issuerId ? -1 : a.issuerId > b.issuerId ? 1 : 0,
      )
      .map((i) => ({
        issuerId: i.issuerId,
        publicKeyJwk: i.publicKeyJwk,
        notBefore: i.notBefore,
        revokedAt: i.revokedAt,
        purpose: i.purpose,
      }));
  return json({
    trust: trust
      ? {
          candidateId: trust.candidateId,
          sourceDigest: trust.sourceDigest,
          artifactDigest: trust.artifactDigest,
          buildId: trust.buildId,
          issuers: issuers(trust.issuers),
          archiveIssuers: issuers(trust.archiveIssuers),
        }
      : null,
    candidateId: c.config.candidateId,
    capability: cap
      ? {
          installationId: cap.installationId,
          corpusVersion: cap.corpusVersion,
          corpusDigest: cap.corpusDigest,
          namespace: cap.namespace,
          parentIds: [...cap.parentIds].sort(),
          childIds: [...cap.childIds].sort(),
        }
      : null,
    ownerIds: [...c.corpus.ownerIds].sort(),
  });
};
export async function corpusEvidenceEpoch(c: CorpusContext) {
  const r = await corpusOne(
    c,
    'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
  );
  if (!r) fail('STORAGE_UNAVAILABLE', 503);
  return Number(r.revision);
}
export function normalizeCorpusScope(input: unknown): CorpusScope {
  const v = safeCorpusJson(input, 32000);
  if (exact(v, ['kind']) && v.kind === 'starter') return { kind: 'starter' };
  if (
    !exact(v, ['kind', 'members']) ||
    v.kind !== 'supervised-trial' ||
    !Array.isArray(v.members) ||
    !v.members.length ||
    v.members.length > 100
  )
    fail('INVALID_SCOPE', 400);
  const members = v.members
    .map((m) => {
      if (
        !exact(m, ['parentId', 'childId']) ||
        !corpusId(m.parentId) ||
        !corpusId(m.childId)
      )
        fail('INVALID_SCOPE', 400);
      return { parentId: m.parentId as string, childId: m.childId as string };
    })
    .sort((a, b) =>
      a.childId < b.childId
        ? -1
        : a.childId > b.childId
          ? 1
          : a.parentId < b.parentId
            ? -1
            : 1,
    );
  if (new Set(members.map((m) => m.childId)).size !== members.length)
    fail('INVALID_SCOPE', 400);
  return { kind: 'supervised-trial', members };
}
export function corpusMemberGuard(parentId: string, childId: string) {
  return `EXISTS(SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.parent_id=${q(parentId)} AND l.child_id=${q(childId)} AND p.role='parent' AND u.role='child' AND p.disabled=0 AND p.must_change_password=0 AND u.disabled=0 AND u.must_change_password=0)`;
}
export function corpusScopeGuard(scope: CorpusScope) {
  return scope.kind === 'starter'
    ? '1'
    : scope.members
        .map((m) => corpusMemberGuard(m.parentId, m.childId))
        .join(' AND ');
}
export async function requireCorpusMembers(
  c: CorpusContext,
  scope: CorpusScope,
  ownerParentId?: string,
) {
  if (scope.kind === 'starter') return;
  if (ownerParentId && scope.members.some((m) => m.parentId !== ownerParentId))
    fail('FORBIDDEN', 403);
  if (!(await corpusOne(c, `SELECT 1 AS ok WHERE ${corpusScopeGuard(scope)}`)))
    fail('FORBIDDEN', 403);
}
export async function readCurrentCorpusAuthority(
  c: CorpusContext,
  version: string,
): Promise<CorpusAuthority | null> {
  await requireCorpusActor(c);
  const install = await corpusInstallation(c);
  await registeredCorpus(c, version);
  const ns = c.config.testMode ? c.config.testRunId : 'ordinary';
  if (!ns) fail('STORAGE_UNAVAILABLE', 503);
  const r = await corpusOne(
    c,
    `SELECT p.*,json_extract(s.plan_json,'$.buildId') AS build_id,s.candidate_id,s.source_digest,s.artifact_digest FROM pilot_corpus_publication_state h JOIN pilot_corpus_publication p ON p.id=h.latest_publication_id JOIN pilot_corpus_snapshot s ON s.id=p.snapshot_id WHERE h.corpus_version=${q(version)} AND h.installation_id=${q(install)} AND h.namespace_key=${q(ns)}`,
  );
  if (!r) {
    await finalCorpusScope(c, install);
    return null;
  }
  const a: CorpusAuthority = {
    corpusVersion: version,
    corpusDigest: String(r.corpus_digest),
    installationId: install,
    namespaceKey: ns,
    releaseId: String(r.id),
    releaseRevision: Number(r.revision),
    status: r.status as CorpusAuthority['status'],
    scope: JSON.parse(String(r.scope_json)),
    snapshotId: String(r.snapshot_id),
    candidateId: String(r.candidate_id),
    sourceDigest: String(r.source_digest),
    artifactDigest: String(r.artifact_digest),
    buildId: String(r.build_id),
    evidenceEpoch: await corpusEvidenceEpoch(c),
    ownerDecisionId: r.owner_decision_id as string | null,
    configuration: corpusAuthorityConfiguration(c),
  };
  if (a.scope.kind === 'verification')
    await requireCorpusVerificationBinding(c, a);
  await requireCorpusAuthorityScope(c, a);
  return a;
}
export async function finalCorpusScope(
  c: CorpusContext,
  install: string,
  guard = '1',
) {
  if (
    !(await corpusOne(
      c,
      `SELECT 1 AS ok WHERE ${corpusActorGuard(c)} AND ${corpusInstallationGuard(install)} AND ${guard}`,
    ))
  )
    fail('UNAUTHORIZED', 401);
}
export async function requireCorpusAuthorityScope(
  c: CorpusContext,
  a: CorpusAuthority,
) {
  if (a.scope.kind === 'verification')
    await requireCorpusVerificationBinding(c, a);
  await finalCorpusScope(
    c,
    a.installationId,
    `EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE corpus_version=${q(a.corpusVersion)} AND installation_id=${q(a.installationId)} AND namespace_key=${q(a.namespaceKey)} AND revision=${a.releaseRevision} AND latest_publication_id=${q(a.releaseId)})${a.scope.kind === 'verification' ? ` AND ${corpusScopeGuard({ kind: 'supervised-trial', members: a.scope.members })}` : ''}`,
  );
  if (corpusAuthorityConfiguration(c) !== a.configuration)
    fail('PUBLICATION_STALE');
}
function corpusVerificationConfigured(c: CorpusContext, a: CorpusAuthority) {
  const cap = c.corpus.capability,
    trust = c.config.curriculumTrust;
  return !!(
    cap &&
    trust &&
    trust.candidateId === a.candidateId &&
    trust.sourceDigest === a.sourceDigest &&
    trust.artifactDigest === a.artifactDigest &&
    trust.buildId === a.buildId &&
    c.config.testMode &&
    c.config.testContentAllowed &&
    c.config.testRunId &&
    c.config.testToken &&
    c.config.candidateExplicitlyBound &&
    c.config.candidateId === a.candidateId &&
    c.corpus.fixtureBinding?.installationId === a.installationId &&
    c.corpus.fixtureBinding.mode === 'synthetic-only' &&
    cap.installationId === a.installationId &&
    cap.corpusVersion === a.corpusVersion &&
    cap.corpusDigest === a.corpusDigest &&
    cap.namespace === a.namespaceKey &&
    c.config.testRunId === cap.namespace &&
    a.scope.kind === 'verification' &&
    a.scope.namespace === cap.namespace &&
    a.scope.members.length === cap.childIds.length &&
    new Set(a.scope.members.map((m) => m.childId)).size ===
      cap.childIds.length &&
    a.scope.members.every(
      (m) =>
        cap.parentIds.includes(m.parentId) && cap.childIds.includes(m.childId),
    )
  );
}
export async function requireCorpusVerificationBinding(
  c: CorpusContext,
  a: CorpusAuthority,
) {
  if (!corpusVerificationConfigured(c, a) || a.scope.kind !== 'verification')
    fail('CAPABILITY_DENIED', 403);
  const members = a.scope.members;
  await requireCorpusMembers(c, { kind: 'supervised-trial', members });
  await finalCorpusScope(
    c,
    a.installationId,
    corpusScopeGuard({ kind: 'supervised-trial', members }),
  );
}
/** SQL narrows candidates only; signature/current-key validation remains mandatory. */
export function corpusEligiblePackageGuard(
  c: CorpusContext,
  a: CorpusAuthority,
  itemAlias: string,
) {
  if (!/^[a-z][a-z0-9_]*$/u.test(itemAlias)) fail('STORAGE_UNAVAILABLE', 503);
  if (a.status !== 'released') return '0';
  if (a.scope.kind === 'verification') {
    if (!corpusVerificationConfigured(c, a)) return '0';
    return `(SELECT count(*) FROM pilot_corpus_snapshot_member m JOIN pilot_corpus_source_evidence src ON src.id=m.source_evidence_id WHERE m.snapshot_id=${q(a.snapshotId)} AND m.lesson_version=${itemAlias}.lesson_version AND m.content_digest=${itemAlias}.content_digest AND m.package_eligible=1 AND src.classification='verification-fixture' AND src.installation_id=${q(a.installationId)} AND NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence nxt WHERE nxt.supersedes_id=src.id))=2`;
  }
  const trust = c.config.curriculumTrust;
  if (
    !trust ||
    trust.candidateId !== a.candidateId ||
    trust.sourceDigest !== a.sourceDigest ||
    trust.artifactDigest !== a.artifactDigest ||
    trust.buildId !== a.buildId
  )
    return '0';
  const issuers = trust.issuers
    .filter(
      (i) =>
        i.purpose === 'release' &&
        i.revokedAt === null &&
        i.notBefore <= corpusNow(c),
    )
    .map((i) => q(i.issuerId));
  if (!issuers.length) return '0';
  const v = `${itemAlias}.lesson_version`,
    dg = `${itemAlias}.content_digest`;
  return `(SELECT count(*) FROM pilot_corpus_snapshot_member m JOIN pilot_corpus_source_evidence src ON src.id=m.source_evidence_id JOIN pilot_curriculum_review rv ON rv.review_id=m.review_id JOIN pilot_corpus_proof_receipt pr ON pr.id=m.proof_id WHERE m.snapshot_id=${q(a.snapshotId)} AND m.lesson_version=${v} AND m.content_digest=${dg} AND m.package_eligible=1 AND src.installation_id=${q(a.installationId)} AND src.classification='real-source-reviewed' AND NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence nxt WHERE nxt.supersedes_id=src.id) AND rv.decision='approved' AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_review newer WHERE newer.lesson_version=rv.lesson_version AND newer.review_sequence>rv.review_sequence) AND pr.installation_id=${q(a.installationId)} AND pr.test_run_id IS NULL AND pr.issuer_id IN (${issuers.join(',')}) AND json_extract(pr.receipt_json,'$.candidateId')=${q(a.candidateId)} AND json_extract(pr.receipt_json,'$.sourceDigest')=${q(a.sourceDigest)} AND json_extract(pr.receipt_json,'$.artifactDigest')=${q(a.artifactDigest)} AND json_extract(pr.receipt_json,'$.buildId')=${q(a.buildId)})=2`;
}
export async function readCorpusPackageAuthority(
  c: CorpusContext,
  a: CorpusAuthority,
  version: string,
): Promise<CorpusPackageAuthority> {
  if (!corpusId(version)) fail('INVALID_REQUEST', 400);
  if (a.scope.kind === 'verification')
    await requireCorpusVerificationBinding(c, a);
  const rows = await corpusRows(
    c,
    `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(a.snapshotId)} AND lesson_version=${q(version)} ORDER BY target_index`,
  );
  const unavailable = (reason: CorpusReason): CorpusPackageAuthority => ({
    lessonVersion: version,
    contentDigest: String(rows[0]?.content_digest ?? ''),
    available: false,
    reasonCode: reason,
    eligibilityDigest: String(rows[0]?.package_eligibility_digest ?? ''),
    sourceIds: [],
    reviewId: null,
    proofId: null,
    soundReview: 'pending',
  });
  if (a.status !== 'released') {
    await requireCorpusAuthorityScope(c, a);
    return unavailable('WITHDRAWN');
  }
  if (rows.length !== 2 || rows.some((r) => r.package_eligible !== 1)) {
    await requireCorpusAuthorityScope(c, a);
    return unavailable('PACKAGE_INELIGIBLE');
  }
  const saved = inspectPackageEligibility(
    JSON.parse(String(rows[0].package_eligibility_json)),
  );
  if (saved.lane === 'verification')
    await requireCorpusVerificationBinding(c, a);
  const chars = await corpusRows(
      c,
      `SELECT * FROM pilot_corpus_character WHERE corpus_version=${q(a.corpusVersion)} AND lesson_version=${q(version)} ORDER BY target_index`,
    ),
    sources: CorpusRow[] = [];
  for (const ch of chars) {
    const s = await currentCorpusSource(c, String(ch.source_evidence_id));
    if (!s) fail('STORAGE_UNAVAILABLE', 503);
    ch.current_source_id = s.id;
    sources.push(s);
  }
  const rv = await corpusOne(
      c,
      `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(version)} ORDER BY review_sequence DESC LIMIT 1`,
    ),
    proofRow = saved.proof
      ? await corpusOne(
          c,
          `SELECT * FROM pilot_corpus_proof_receipt WHERE id=${q(saved.proof.proofId)}`,
        )
      : null,
    trust = c.config.curriculumTrust;
  const referencesCurrent =
    sources.length === 2 &&
    saved.targets.every((t) =>
      sources.some(
        (s) =>
          s.id === t.sourceEvidenceId &&
          s.evidence_digest === t.sourceEvidenceDigest &&
          s.installation_id === a.installationId,
      ),
    ) &&
    (rv?.review_id ?? null) === (saved.review?.reviewId ?? null);
  if (!referencesCurrent) {
    await requireCorpusAuthorityScope(c, a);
    return unavailable('STALE_EVIDENCE');
  }
  let proof: PackageEligibility['proof'] = null;
  if (proofRow && trust) {
    try {
      const corpus = await registeredCorpus(c, a.corpusVersion),
        members = (
          JSON.parse(String(corpus.manifest_json)).items as Array<{
            lessonVersion: string;
            contentDigest: string;
          }>
        ).map(({ lessonVersion, contentDigest }) => ({
          lessonVersion,
          contentDigest,
        })),
        verified = await authenticateCorpusProof(
          JSON.parse(String(proofRow.receipt_json)),
          proofRow.signature,
          trust,
          members,
          corpusNow(c),
          saved.lane === 'verification',
        );
      await verifyCorpusProof(
        verified.receipt,
        proofRow.signature,
        trust,
        {
          candidateId: a.candidateId,
          sourceDigest: a.sourceDigest,
          artifactDigest: a.artifactDigest,
          buildId: a.buildId,
          installationId: a.installationId,
          evidenceInstallationId:
            saved.lane === 'verification'
              ? a.installationId
              : verified.receipt.evidenceInstallationId,
          namespace:
            saved.lane === 'verification'
              ? a.namespaceKey
              : verified.receipt.namespace,
          corpusVersion: a.corpusVersion,
          corpusDigest: a.corpusDigest,
          lessonVersion: version,
          contentDigest: String(rows[0].content_digest),
          verification: saved.lane === 'verification',
          members,
        },
        corpusNow(c),
      );
      if (
        verified.receiptDigest === proofRow.receipt_digest &&
        proofRow.installation_id === a.installationId &&
        proofRow.test_run_id ===
          (saved.lane === 'verification' ? a.namespaceKey : null)
      )
        proof = {
          proofId: String(proofRow.id),
          receiptDigest: verified.receiptDigest,
          issuerId: verified.issuer.issuerId,
          purpose: verified.issuer.purpose,
          issuedAt: verified.receipt.issuedAt,
        };
    } catch {
      /* Missing current trust never grants release. */
    }
  }
  if ((saved.lane === 'ordinary' || saved.proof !== null) && proof === null) {
    await requireCorpusAuthorityScope(c, a);
    return unavailable('INVALID_PROOF');
  }
  const pkg = await loadCorpusPackage(c, version);
  const candidate = await evaluateSnapshotCandidate({
    ordinal: 0,
    document: pkg.document,
    contentDigest: String(rows[0].content_digest),
    characters: chars,
    sources,
    review: rv,
    proof,
    installationId: a.installationId,
    lane: saved.lane,
  });
  const sameSources = saved.targets.every((t) =>
    sources.some(
      (s) =>
        s.id === t.sourceEvidenceId &&
        s.evidence_digest === t.sourceEvidenceDigest,
    ),
  );
  const ok =
    candidate.targets.every((t) =>
      saved.lane === 'ordinary'
        ? t.intrinsicEligibility.realEligible
        : t.intrinsicEligibility.machineUsableVerification &&
          t.intrinsicEligibility.current,
    ) &&
    sameSources &&
    candidate.review?.reviewId === saved.review?.reviewId &&
    proof?.proofId === saved.proof?.proofId &&
    (await H(candidate.assetInventory)) === saved.assetInventoryDigest;
  if ((await corpusEvidenceEpoch(c)) !== a.evidenceEpoch)
    fail('PUBLICATION_STALE');
  await requireCorpusAuthorityScope(c, a);
  return {
    ...unavailable('STALE_EVIDENCE'),
    available: ok,
    reasonCode: ok ? null : 'STALE_EVIDENCE',
    sourceIds: sources.map((s) => ({
      id: String(s.id),
      digest: String(s.evidence_digest),
    })),
    reviewId: (rv?.review_id ?? null) as string | null,
    proofId: proof?.proofId ?? null,
    soundReview: ok
      ? saved.lane === 'verification'
        ? 'synthetic'
        : 'reviewed'
      : 'pending',
  };
}
export function corpusAuthorityGuard(
  c: CorpusContext,
  a: CorpusAuthority,
  packages: CorpusPackageAuthority[] = [],
) {
  return `${corpusActorGuard(c)} AND ${corpusInstallationGuard(a.installationId)} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${a.evidenceEpoch}) AND EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE corpus_version=${q(a.corpusVersion)} AND installation_id=${q(a.installationId)} AND namespace_key=${q(a.namespaceKey)} AND revision=${a.releaseRevision} AND latest_publication_id=${q(a.releaseId)}) AND ${a.status === 'released' && packages.every((p) => p.available) ? '1' : '0'}`;
}
export async function requireCorpusFamilyScope(
  c: CorpusContext,
  a: CorpusAuthority,
  childId: string,
) {
  if (!corpusId(childId)) fail('INVALID_REQUEST', 400);
  if (!['parent', 'child', 'teacher'].includes(c.user.role))
    fail('FORBIDDEN', 403);
  const links = await corpusRows(
      c,
      `SELECT l.parent_id,l.child_id,p.role AS parent_role,p.disabled AS parent_disabled,p.must_change_password AS parent_password,u.role AS child_role,u.disabled AS child_disabled,u.must_change_password AS child_password FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.child_id=${q(childId)} ORDER BY l.parent_id`,
    ),
    valid = links.filter(
      (l) =>
        l.parent_role === 'parent' &&
        l.child_role === 'child' &&
        l.parent_disabled === 0 &&
        l.parent_password === 0 &&
        l.child_disabled === 0 &&
        l.child_password === 0,
    );
  const grants = await corpusRows(
    c,
    `SELECT granting_parent_id FROM pilot_teacher_grant WHERE child_id=${q(childId)} AND teacher_id=${q(c.user.id)} ORDER BY granting_parent_id`,
  );
  const own =
    c.user.role === 'parent'
      ? valid.filter((l) => l.parent_id === c.user.id)
      : c.user.role === 'child' && c.user.id === childId
        ? valid
        : c.user.role === 'teacher'
          ? valid.filter((l) =>
              grants.some((g) => g.granting_parent_id === l.parent_id),
            )
          : [];
  if (!own.length) fail('NOT_FOUND', 404);
  const scope = a.scope;
  const permitted =
    scope.kind === 'starter'
      ? own
      : own.filter((l) =>
          scope.members.some(
            (m) => m.parentId === l.parent_id && m.childId === childId,
          ),
        );
  if (!permitted.length) fail('NOT_FOUND', 404);
  const linkGuard = permitted
    .map(
      (l) =>
        `${corpusMemberGuard(String(l.parent_id), childId)}${c.user.role === 'teacher' ? ` AND EXISTS(SELECT 1 FROM pilot_teacher_grant WHERE child_id=${q(childId)} AND teacher_id=${q(c.user.id)} AND granting_parent_id=${q(l.parent_id)})` : ''}`,
    )
    .join(' OR ');
  const authRevision = await H({
    role: c.user.role,
    links: permitted,
    grants,
    configuration: JSON.parse(a.configuration),
  });
  await requireCorpusAuthorityScope(c, a);
  await finalCorpusScope(c, a.installationId, `(${linkGuard})`);
  return { guard: `(${linkGuard})`, authRevision };
}
export function assertCorpusAuthorityConfiguration(
  c: CorpusContext,
  a: CorpusAuthority,
) {
  if (corpusAuthorityConfiguration(c) !== a.configuration)
    fail('PUBLICATION_STALE');
}
export async function currentCorpusSnapshotReady(
  c: CorpusContext,
  plan: SnapshotPlan,
) {
  if (!plan.releasedPackages.length) return false;
  const trust = c.config.curriculumTrust;
  if (
    !trust ||
    trust.candidateId !== plan.candidateId ||
    trust.sourceDigest !== plan.sourceDigest ||
    trust.artifactDigest !== plan.artifactDigest ||
    trust.buildId !== plan.buildId
  )
    return false;
  const candidates = await snapshotCandidates(c, plan.corpusVersion);
  return plan.releasedPackages.every((p) => {
    const candidate = candidates.find(
        (x) => x.lessonVersion === p.lessonVersion,
      ),
      saved = plan.packages.find(
        (x) => x.lessonVersion === p.lessonVersion,
      )!.packageEligibility;
    return (
      candidate &&
      candidate.contentDigest === p.contentDigest &&
      candidate.targets.every((t) => t.intrinsicEligibility.realEligible) &&
      candidate.targets.every((t) =>
        saved.targets.some(
          (v) =>
            v.sourceEvidenceId === t.sourceEvidenceId &&
            v.sourceEvidenceDigest === t.sourceEvidenceDigest,
        ),
      ) &&
      candidate.review?.reviewId === saved.review?.reviewId &&
      candidate.proof?.proofId === saved.proof?.proofId &&
      json(candidate.assetInventory) === json(saved.assetInventory)
    );
  });
}
export function corpusAuthorityIdentity(a: CorpusAuthority) {
  return {
    schemaVersion: 'r6-authority-1',
    corpusVersion: a.corpusVersion,
    corpusDigest: a.corpusDigest,
    installationId: a.installationId,
    namespaceKey: a.namespaceKey,
    releaseId: a.releaseId,
    releaseRevision: a.releaseRevision,
    snapshotId: a.snapshotId,
    candidateId: a.candidateId,
    sourceDigest: a.sourceDigest,
    artifactDigest: a.artifactDigest,
    buildId: a.buildId,
    scope: a.scope,
    ownerDecisionId: a.ownerDecisionId,
    configuration: JSON.parse(a.configuration),
  };
}
export async function corpusAuthorityDigest(a: CorpusAuthority) {
  return H(corpusAuthorityIdentity(a));
}
function publishingOwnerGuard(c: CorpusContext, o: CorpusRow) {
  return `${c.corpus.ownerIds.includes(String(o.actor_id)) ? '1' : '0'} AND EXISTS(SELECT 1 FROM pilot_auth_user u JOIN pilot_auth_session s ON s.user_id=u.id WHERE u.id=${q(o.actor_id)} AND s.id=${q(o.owner_session_id)} AND s.expires_at>${corpusNow(c)} AND u.role IN ('parent','operator') AND u.disabled=0 AND u.must_change_password=0 AND (u.role='operator' OR ${JSON.parse(String(o.scope_json)).kind === 'starter' ? '1' : JSON.parse(String(o.scope_json)).members.every((m: { parentId: string }) => m.parentId === o.actor_id) ? '1' : '0'}))`;
}
async function publicationReplay(
  c: CorpusContext,
  version: string,
  install: string,
  raw: Record<string, unknown>,
) {
  const envelope = corpusRequest(
      'publication',
      c.user.id,
      install,
      version,
      raw,
    ),
    old = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_publication WHERE actor_id=${q(c.user.id)} AND installation_id=${q(install)} AND corpus_version=${q(version)} AND request_id=${q(raw.requestId)}`,
    );
  if (old) {
    assertExactCorpusReplay(JSON.parse(String(old.request_json)), envelope);
    await finalCorpusScope(c, install);
    return {
      envelope,
      ack: JSON.parse(String(old.ack_json)) as CorpusPublicationReceipt,
    };
  }
  return { envelope, ack: null };
}
async function commitPublication(
  c: CorpusContext,
  version: string,
  raw: Record<string, unknown>,
  snapshot: CorpusRow,
  scope: CorpusScope,
  owner: CorpusRow,
  head: CorpusAuthority | null,
  envelope: unknown,
  epoch: number,
  configuration: string,
  status: 'released' | 'withdrawn',
) {
  const install = String(snapshot.installation_id),
    revision = (head?.releaseRevision ?? 0) + 1,
    scopeDigest = await H(scope),
    requestDigest = await H(envelope),
    at = corpusNow(c),
    id = corpusNewId('corpus-publication'),
    ack: CorpusPublicationReceipt = {
      requestId: raw.requestId as string,
      recordId: id,
      recordedAt: corpusISO(at),
      revision,
      corpusDigest: String(snapshot.corpus_digest),
      snapshotId: String(snapshot.id),
    },
    headCAS = head
      ? `EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE corpus_version=${q(version)} AND installation_id=${q(install)} AND namespace_key='ordinary' AND revision=${head.releaseRevision} AND latest_publication_id=${q(head.releaseId)})`
      : `NOT EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE corpus_version=${q(version)} AND installation_id=${q(install)} AND namespace_key='ordinary')`,
    base = `${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(install)} AND ${headCAS} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${epoch})`,
    positive =
      status === 'released'
        ? ` AND ${publishingOwnerGuard(c, owner)} AND ${corpusScopeGuard(scope)}`
        : '';
  const values = {
    id,
    corpus_version: version,
    corpus_digest: snapshot.corpus_digest,
    snapshot_id: snapshot.id,
    installation_id: install,
    namespace_key: 'ordinary',
    revision,
    predecessor_id: head?.releaseId ?? null,
    status,
    scope_kind: scope.kind,
    scope_json: json(scope),
    scope_digest: scopeDigest,
    owner_decision_id: owner.id,
    actor_id: c.user.id,
    request_id: raw.requestId,
    request_digest: requestDigest,
    request_json: json(envelope),
    ack_json: json(ack),
    created_at: at,
    test_run_id: null,
  };
  const inserted = `EXISTS(SELECT 1 FROM pilot_corpus_publication WHERE id=${q(id)})`,
    statements = [
      c.db.prepare(
        `INSERT INTO pilot_corpus_publication(${Object.keys(values).join(',')}) SELECT ${Object.values(values).map(q).join(',')} WHERE ${base}${positive}`,
      ),
    ];
  if (scope.kind === 'supervised-trial')
    for (const member of scope.members)
      statements.push(
        c.db.prepare(
          `INSERT INTO pilot_corpus_trial_member(publication_id,installation_id,parent_id,child_id) SELECT ${q(id)},${q(install)},${q(member.parentId)},${q(member.childId)} WHERE ${inserted}`,
        ),
      );
  if (head)
    statements.push(
      c.db.prepare(
        `UPDATE pilot_corpus_publication_state SET revision=${revision},latest_publication_id=${q(id)},updated_at=${at} WHERE corpus_version=${q(version)} AND installation_id=${q(install)} AND namespace_key='ordinary' AND revision=${head.releaseRevision} AND latest_publication_id=${q(head.releaseId)} AND ${inserted}`,
      ),
    );
  else
    statements.push(
      c.db.prepare(
        `INSERT INTO pilot_corpus_publication_state(corpus_version,installation_id,namespace_key,revision,latest_publication_id,updated_at) SELECT ${q(version)},${q(install)},'ordinary',${revision},${q(id)},${at} WHERE ${inserted}`,
      ),
    );
  const final = `${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(install)} AND EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE latest_publication_id=${q(id)} AND revision=${revision})${positive}`;
  statements.push(
    c.db.prepare(
      `INSERT INTO pilot_corpus_publication_audit(id,publication_id,actor_id,action,request_id,created_at) VALUES(${q(corpusNewId('corpus-audit'))},CASE WHEN ${final} THEN ${q(id)} ELSE NULL END,${q(c.user.id)},${q(status)},${q(raw.requestId)},${at})`,
    ),
  );
  if (configuration !== corpusAuthorityConfiguration(c))
    fail('PUBLICATION_STALE');
  try {
    const result = await c.db.batch(statements);
    if (result.some((r) => !r.success)) fail('STORAGE_UNAVAILABLE', 503);
  } catch {
    /* Read exact committed ACK after a lost response; otherwise unknown. */ const saved =
      await corpusOne(
        c,
        `SELECT * FROM pilot_corpus_publication WHERE actor_id=${q(c.user.id)} AND installation_id=${q(install)} AND corpus_version=${q(version)} AND request_id=${q(raw.requestId)}`,
      );
    await finalCorpusScope(c, install);
    if (!saved) fail('STORAGE_UNAVAILABLE', 503);
    assertExactCorpusReplay(JSON.parse(String(saved.request_json)), envelope);
    return JSON.parse(String(saved.ack_json));
  }
  const saved = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_publication WHERE actor_id=${q(c.user.id)} AND installation_id=${q(install)} AND corpus_version=${q(version)} AND request_id=${q(raw.requestId)}`,
  );
  await finalCorpusScope(c, install);
  if (!saved) fail('PUBLICATION_STALE');
  return JSON.parse(String(saved.ack_json));
}
export async function publishCorpus(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusPublicationReceipt> {
  await requireCorpusActor(c, 'operator');
  const install = await corpusInstallation(c),
    raw = safeCorpusJson(input, 64000);
  await registeredCorpus(c, version);
  if (
    !exact(raw, [
      'requestId',
      'snapshotId',
      'ownerDecisionId',
      'expectedRevision',
      'predecessorPublicationId',
    ]) ||
    !corpusId(raw.requestId) ||
    !corpusId(raw.snapshotId) ||
    !corpusId(raw.ownerDecisionId) ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    Number(raw.expectedRevision) < 0 ||
    (raw.predecessorPublicationId !== null &&
      !corpusId(raw.predecessorPublicationId))
  )
    fail('INVALID_REQUEST', 400);
  const replay = await publicationReplay(c, version, install, raw);
  if (replay.ack) return replay.ack;
  if (c.config.testMode) fail('VERIFICATION_FORBIDDEN', 403);
  const configuration = corpusAuthorityConfiguration(c),
    row = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_snapshot WHERE id=${q(raw.snapshotId)} AND corpus_version=${q(version)} AND installation_id=${q(install)} AND status='sealed' AND test_run_id IS NULL`,
    ),
    owner = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_owner_decision WHERE id=${q(raw.ownerDecisionId)}`,
    );
  if (
    !row ||
    !owner ||
    owner.snapshot_id !== row.id ||
    owner.installation_id !== install ||
    owner.decision !== 'accepted'
  )
    fail('PUBLICATION_INELIGIBLE');
  const plan = await inspectSnapshotPlan(JSON.parse(String(row.plan_json))),
    scope = normalizeCorpusScope(JSON.parse(String(owner.scope_json))),
    head = await readCurrentCorpusAuthority(c, version),
    epoch = await corpusEvidenceEpoch(c),
    trust = c.config.curriculumTrust;
  if (plan.lane !== 'ordinary') fail('VERIFICATION_FORBIDDEN', 403);
  if (
    !trust ||
    trust.candidateId !== plan.candidateId ||
    trust.sourceDigest !== plan.sourceDigest ||
    trust.artifactDigest !== plan.artifactDigest ||
    trust.buildId !== plan.buildId ||
    c.config.candidateId !== plan.candidateId
  )
    fail('PUBLICATION_STALE');
  if (
    !(await corpusOne(
      c,
      `SELECT 1 AS ok WHERE ${publishingOwnerGuard(c, owner)}`,
    ))
  )
    fail('FORBIDDEN', 403);
  await requireCorpusMembers(c, scope);
  const allCurrent = await currentCorpusSnapshotReady(c, plan);
  assertPublicationCAS({
    scope: scope.kind,
    includedCharacterCount: plan.counts.includedCharacterCount,
    expectedRevision: Number(raw.expectedRevision),
    currentRevision: head?.releaseRevision ?? 0,
    predecessorId: raw.predecessorPublicationId as string | null,
    currentHeadId: head?.releaseId ?? null,
    sealedEpoch: plan.evidenceEpoch,
    currentEpoch: epoch,
    ownerAccepted: true,
    allMembersCurrent: allCurrent,
  });
  // The release insert advances epoch itself. Subsequent authority uses fresh current facts, not sealed epoch equality.
  return commitPublication(
    c,
    version,
    raw,
    row,
    scope,
    owner,
    head,
    replay.envelope,
    epoch,
    configuration,
    'released',
  );
}
export async function withdrawCorpus(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusPublicationReceipt> {
  await requireCorpusActor(c, 'operator');
  const install = await corpusInstallation(c),
    raw = safeCorpusJson(input, 16000);
  await registeredCorpus(c, version);
  if (
    !exact(raw, [
      'requestId',
      'expectedRevision',
      'predecessorPublicationId',
    ]) ||
    !corpusId(raw.requestId) ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    Number(raw.expectedRevision) < 1 ||
    !corpusId(raw.predecessorPublicationId)
  )
    fail('INVALID_REQUEST', 400);
  const replay = await publicationReplay(c, version, install, raw);
  if (replay.ack) return replay.ack;
  if (c.config.testMode) fail('VERIFICATION_FORBIDDEN', 403);
  const head = await readCurrentCorpusAuthority(c, version);
  if (
    !head ||
    head.namespaceKey !== 'ordinary' ||
    head.scope.kind === 'verification' ||
    head.releaseRevision !== raw.expectedRevision ||
    head.releaseId !== raw.predecessorPublicationId
  )
    fail('PUBLICATION_STALE');
  const snapshot = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_snapshot WHERE id=${q(head.snapshotId)}`,
    ),
    owner = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_owner_decision WHERE id=${q(head.ownerDecisionId)}`,
    );
  if (!snapshot || !owner) fail('STORAGE_UNAVAILABLE', 503);
  return commitPublication(
    c,
    version,
    raw,
    snapshot,
    head.scope,
    owner,
    head,
    replay.envelope,
    await corpusEvidenceEpoch(c),
    corpusAuthorityConfiguration(c),
    'withdrawn',
  );
}
