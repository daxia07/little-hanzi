import {
  isCorpusResource,
  corpusLearningContext,
  startCorpus,
  getCorpusRun,
  advanceCorpus,
} from './corpus-learning-store.ts';
import { approveCorpus } from './corpus-family-store.ts';
import {
  collectionPlacement,
  collectionLibrary,
  proposeCollection,
  approveCollection,
  collectionPlans,
  collectionPractice,
  startCollection,
  getCollectionRun,
  advanceCollection,
  submitCollectionProof,
  recordCollectionOwner,
  publishCollection,
  isCollectionResource,
  isCollectionPackage,
} from './collection-store.ts';
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import {
  compileStoryPackage,
  exact,
  digest,
  text,
  type CompiledStory,
} from '../curriculum/story-package.ts';
import {
  createInitialRun,
  applyAction,
  actionAck,
  deriveRecap,
  replayStoryRun,
  reviewAvailableAt,
  type StoryRun,
  type StoryLedgerEntry,
  type PlaybackPolicy,
} from '../curriculum/story-runtime.ts';
import { FOREST_STORY_LESSON, rotatedChoices } from '../preview/content.ts';
import { hasCompleteCurriculumProvenance } from '../curriculum/review.ts';
import type { LearningEvent, PreviewAction } from '../preview/types.ts';
import type {
  StoryView,
  StoryPlan,
  PlacementProposal,
  PracticeItem,
  SafeQuestion,
  StoryLesson,
} from '../curriculum/story-types.ts';
import type { PilotSessionContext } from './http.ts';
import {
  fail,
  StoryError,
  parseTrialScope,
  verifyProofReceipt,
  validReceipt,
  type TrialScope,
} from './story-policy.ts';
import {
  operationRequest,
  operationDigest,
  placementSource,
  publicationAck,
  startAck,
} from './story-identity.ts';
export type StoryContext = Pick<
  PilotSessionContext,
  'config' | 'db' | 'user' | 'session'
>;
type Row = Record<string, string | number | null>;
const VERSION = 'forest-01-v4';
const q = (v: unknown): string => {
  if (v === null) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return "'" + v.replaceAll("'", "''") + "'";
  fail('STORAGE_UNAVAILABLE', 503);
};
const id = (kind: string) => `${kind}-${crypto.randomUUID()}`;
const iso = (v: unknown) => new Date(Number(v)).toISOString();
function now(c: StoryContext): number {
  if (c.config.testMode && c.config.curriculumTestNow) {
    const n = Number(c.config.curriculumTestNow);
    if (!Number.isSafeInteger(n) || n < 0) fail('STORAGE_UNAVAILABLE', 503);
    return n;
  }
  return Date.now();
}
async function one(c: StoryContext, sql: string): Promise<Row | null> {
  try {
    return await c.db.prepare(sql).first<Row>();
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
async function rows(c: StoryContext, sql: string): Promise<Row[]> {
  try {
    return (await c.db.prepare(sql).all<Row>()).results ?? [];
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
async function batch(c: StoryContext, sql: string[]) {
  try {
    await c.db.batch(sql.map((s) => c.db.prepare(s)));
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
function insert(
  table: string,
  values: Record<string, unknown>,
  guard?: string,
) {
  const cols = Object.keys(values);
  return `INSERT INTO ${table}(${cols.join(',')}) ${guard ? `SELECT ${cols.map((k) => q(values[k])).join(',')} WHERE ${guard}` : `VALUES(${cols.map((k) => q(values[k])).join(',')})`}`;
}
function actorGuard(c: StoryContext, role?: string) {
  const sessionId = typeof c.session.id === 'string' ? c.session.id : '';
  return `EXISTS(SELECT 1 FROM pilot_auth_user u JOIN pilot_auth_session s ON s.user_id=u.id WHERE u.id=${q(c.user.id)} AND s.id=${q(sessionId)} AND s.expires_at>${now(c)} AND u.disabled=0 AND u.must_change_password=0 ${`AND u.role=${q(role ?? c.user.role)}`})`;
}
function parentGuard(c: StoryContext, childId: string) {
  return `${actorGuard(c, 'parent')} AND EXISTS(SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.parent_id=${q(c.user.id)} AND l.child_id=${q(childId)} AND u.role='child' AND u.disabled=0 AND u.must_change_password=0)`;
}
async function requireActor(c: StoryContext, role?: string) {
  if (role && c.user.role !== role) fail('FORBIDDEN', 403);
  if (!(await one(c, `SELECT 1 AS ok WHERE ${actorGuard(c, role)}`)))
    fail('UNAUTHORIZED', 401);
}
async function readable(c: StoryContext, childId: string) {
  await requireActor(c);
  const own = c.user.role === 'child' && c.user.id === childId;
  const parent =
    c.user.role === 'parent' &&
    !!(await one(
      c,
      `SELECT 1 FROM pilot_parent_child WHERE parent_id=${q(c.user.id)} AND child_id=${q(childId)}`,
    ));
  const teacher =
    c.user.role === 'teacher' &&
    !!(await one(
      c,
      `SELECT 1 FROM pilot_teacher_grant g JOIN pilot_parent_child l ON l.parent_id=g.granting_parent_id AND l.child_id=g.child_id JOIN pilot_auth_user p ON p.id=l.parent_id WHERE g.teacher_id=${q(c.user.id)} AND g.child_id=${q(childId)} AND p.disabled=0 AND p.must_change_password=0`,
    ));
  if (
    (!own && !parent && !teacher) ||
    !(await one(
      c,
      `SELECT 1 FROM pilot_auth_user WHERE id=${q(childId)} AND role='child' AND disabled=0 AND must_change_password=0`,
    ))
  )
    fail('NOT_FOUND', 404);
}
async function parent(c: StoryContext, childId: string) {
  await requireActor(c, 'parent');
  if (!(await one(c, `SELECT 1 WHERE ${parentGuard(c, childId)}`)))
    fail('NOT_FOUND', 404);
}
async function installation(c: StoryContext) {
  const r = await one(
    c,
    'SELECT installation_id FROM pilot_installation WHERE id=1',
  );
  if (!r || !text(r.installation_id, 240)) fail('STORAGE_UNAVAILABLE', 503);
  return r.installation_id;
}
async function lesson(
  c: StoryContext,
): Promise<{ row: Row; compiled: CompiledStory }> {
  const r = await one(
    c,
    `SELECT * FROM pilot_curriculum_package WHERE lesson_version='${VERSION}'`,
  );
  if (!r) fail('NOT_FOUND', 404);
  try {
    const p = JSON.parse(String(r.manifest_json));
    const compiled = await compileStoryPackage(p);
    if (
      canonicalPackage(p) !== r.manifest_json ||
      compiled.identity.contentDigest !== r.content_digest
    )
      fail('STORAGE_UNAVAILABLE', 503);
    return { row: r, compiled };
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
function capability(c: StoryContext, install: string, content: string) {
  const cap = c.config.storyCapability,
    trust = c.config.curriculumTrust;
  if (
    !c.config.pilotMode ||
    !c.config.testMode ||
    !c.config.testContentAllowed ||
    !c.config.testToken ||
    !c.config.testRunId ||
    !c.config.candidateExplicitlyBound ||
    !trust ||
    trust.candidateId !== c.config.candidateId ||
    !cap ||
    cap.installationId !== install ||
    cap.contentDigest !== content ||
    cap.namespace !== c.config.testRunId
  )
    return null;
  return cap;
}
async function latest(c: StoryContext) {
  const install = await installation(c);
  return one(
    c,
    `SELECT p.* FROM pilot_curriculum_publication_state s JOIN pilot_curriculum_publication p ON p.id=s.latest_publication_id WHERE s.installation_id=${q(install)} AND s.lesson_version='${VERSION}'`,
  );
}
async function members(
  c: StoryContext,
  pub: string,
): Promise<TrialScope['members']> {
  return (
    await rows(
      c,
      `SELECT child_id,parent_id,plan_scope FROM pilot_curriculum_trial_member WHERE publication_id=${q(pub)} ORDER BY child_id,parent_id`,
    )
  ).map((r) => ({
    childId: String(r.child_id),
    parentId: String(r.parent_id),
    planScope: VERSION,
  }));
}
async function available(
  c: StoryContext,
  p: Row | null,
  childId?: string,
): Promise<{
  available: boolean;
  reason: string | null;
  policy: PlaybackPolicy;
}> {
  const denied = (reason: string) => ({
    available: false,
    reason,
    policy: { soundReview: 'pending' as const },
  });
  if (!p) return denied('No approved lesson is available.');
  const current = await latest(c);
  if (!current || current.id !== p.id || p.status !== 'released')
    return denied('This lesson is no longer available.');
  const install = await installation(c);
  const bound = await lesson(c);
  if (
    p.installation_id !== install ||
    p.content_digest !== bound.compiled.identity.contentDigest ||
    p.candidate_id !== c.config.curriculumTrust?.candidateId ||
    p.artifact_digest !== c.config.curriculumTrust?.artifactDigest
  )
    return denied('This lesson needs a new release review.');
  const m = await members(c, String(p.id));
  try {
    await linkedMembers(c, m);
  } catch {
    return denied('This lesson’s family permission has changed.');
  }
  if (childId && !m.some((x) => x.childId === childId))
    return denied('This lesson is not assigned to this child.');
  if (p.scope_kind === 'verification') {
    const cap = capability(c, install, String(p.content_digest));
    if (
      !cap ||
      p.test_run_id !== cap.namespace ||
      bound.row.test_run_id !== cap.namespace ||
      m.some(
        (x) =>
          !cap.childIds.includes(x.childId) ||
          !cap.parentIds.includes(x.parentId),
      )
    )
      return denied('This verification lesson is unavailable.');
    return {
      available: true,
      reason: null,
      policy: { soundReview: 'synthetic' },
    };
  }
  if (p.test_run_id !== null || bound.row.test_run_id !== null)
    return denied('This lesson review is pending.');
  const review = await one(
    c,
    `SELECT * FROM pilot_curriculum_review WHERE lesson_version='${VERSION}' ORDER BY review_sequence DESC LIMIT 1`,
  );
  if (
    !review ||
    review.review_id !== p.review_id ||
    review.decision !== 'approved' ||
    review.test_run_id !== null ||
    review.content_digest !== p.content_digest
  )
    return denied('This lesson review has changed.');
  const proof = await one(
    c,
    `SELECT * FROM pilot_curriculum_proof_receipt WHERE id=${q(p.proof_id)}`,
  );
  const owner = await one(
    c,
    `SELECT * FROM pilot_curriculum_owner_decision WHERE id=${q(p.owner_decision_id)}`,
  );
  if (
    !proof ||
    !owner ||
    owner.test_run_id !== null ||
    owner.decision !== 'accepted' ||
    owner.scope_digest !== p.scope_digest ||
    owner.content_digest !== p.content_digest ||
    owner.candidate_id !== p.candidate_id ||
    owner.artifact_digest !== p.artifact_digest ||
    owner.target_installation_id !== install
  )
    return denied('This lesson approval is unavailable.');
  try {
    const result = await verifyProofReceipt(
      JSON.parse(String(proof.receipt_json)),
      proof.signature,
      c.config.curriculumTrust ?? null,
      { installationId: install, contentDigest: String(p.content_digest) },
      now(c),
    );
    if (
      result.issuer.purpose !== 'release' ||
      result.receiptDigest !== proof.receipt_digest
    )
      return denied('This lesson proof is unavailable.');
    if (
      !hasCompleteCurriculumProvenance(
        bound.compiled.package as unknown as Parameters<
          typeof hasCompleteCurriculumProvenance
        >[0],
      )
    )
      return denied('This lesson media review is pending.');
  } catch {
    return denied('This lesson proof is unavailable.');
  }
  return { available: true, reason: null, policy: { soundReview: 'reviewed' } };
}
function publicationGuard(c: StoryContext, p: Row) {
  let guard = `EXISTS(SELECT 1 FROM pilot_curriculum_publication_state s JOIN pilot_curriculum_publication p ON p.id=s.latest_publication_id WHERE s.installation_id=${q(p.installation_id)} AND s.lesson_version=${q(p.lesson_version)} AND p.id=${q(p.id)} AND p.status='released') AND EXISTS(SELECT 1 FROM pilot_installation WHERE id=1 AND installation_id=${q(p.installation_id)})`;
  if (p.scope_kind === 'supervised-trial')
    guard += ` AND EXISTS(SELECT 1 FROM pilot_curriculum_review r WHERE r.review_id=${q(p.review_id)} AND r.decision='approved' AND r.test_run_id IS NULL AND r.review_sequence=(SELECT MAX(review_sequence) FROM pilot_curriculum_review WHERE lesson_version=${q(p.lesson_version)}))`;
  return guard;
}
function childGuard(c: StoryContext, childId: string, p: Row) {
  return `${actorGuard(c, 'child')} AND ${q(c.user.id)}=${q(childId)} AND ${publicationGuard(c, p)} AND EXISTS(SELECT 1 FROM pilot_curriculum_trial_member m JOIN pilot_parent_child l ON l.child_id=m.child_id AND l.parent_id=m.parent_id JOIN pilot_auth_user u ON u.id=m.parent_id WHERE m.publication_id=${q(p.id)} AND m.child_id=${q(childId)} AND u.role='parent' AND u.disabled=0 AND u.must_change_password=0)`;
}
export async function submitStoryProof(c: StoryContext, input: unknown) {
  if (
    exact(input, ['receipt', 'signature']) &&
    input.receipt &&
    typeof input.receipt === 'object' &&
    'adapterId' in input.receipt &&
    input.receipt.adapterId === 'paired-story'
  )
    return submitCollectionProof(c, input);
  await requireActor(c, 'operator');
  if (!exact(input, ['receipt', 'signature'])) fail('INVALID_REQUEST', 400);
  const bound = await lesson(c),
    install = await installation(c);
  if (!validReceipt(input.receipt)) fail('PROOF_INVALID');
  const r = input.receipt;
  const previous = await one(
    c,
    `SELECT * FROM pilot_curriculum_proof_receipt WHERE id=${q(r.receiptId)}`,
  );
  if (previous) {
    if (
      previous.receipt_json !== canonicalPackage(r) ||
      previous.signature !== input.signature
    )
      fail('EVENT_CONFLICT');
    let eligible = false;
    try {
      await verifyProofReceipt(
        r,
        input.signature,
        c.config.curriculumTrust ?? null,
        {
          installationId: install,
          contentDigest: bound.compiled.identity.contentDigest,
          ...(c.config.testMode ? { namespace: c.config.testRunId ?? '' } : {}),
        },
        now(c),
      );
      eligible = true;
    } catch {}
    return {
      receiptId: r.receiptId,
      receiptDigest: String(previous.receipt_digest),
      eligible,
    };
  }
  if (bound.row.test_run_id !== (c.config.testMode ? c.config.testRunId : null))
    fail('PROOF_IDENTITY_MISMATCH');
  const checked = await verifyProofReceipt(
    r,
    input.signature,
    c.config.curriculumTrust ?? null,
    {
      installationId: install,
      contentDigest: bound.compiled.identity.contentDigest,
      ...(c.config.testMode ? { namespace: c.config.testRunId ?? '' } : {}),
    },
    now(c),
  );
  try {
    await batch(c, [
      insert(
        'pilot_curriculum_proof_receipt',
        {
          id: r.receiptId,
          issuer_id: r.issuerId,
          receipt_version: r.schemaVersion,
          receipt_digest: checked.receiptDigest,
          receipt_json: canonicalPackage(r),
          signature: input.signature,
          issued_at: r.issuedAt,
          accepted_at: now(c),
          namespace: r.namespace,
          accepted_issuer_json: canonicalPackage(checked.issuer),
        },
        actorGuard(c, 'operator'),
      ),
    ]);
  } catch {
    const raced = await one(
      c,
      `SELECT * FROM pilot_curriculum_proof_receipt WHERE id=${q(r.receiptId)}`,
    );
    if (!raced) fail('STORAGE_UNAVAILABLE', 503);
    if (
      raced.receipt_json !== canonicalPackage(r) ||
      raced.signature !== input.signature
    )
      fail('EVENT_CONFLICT');
  }
  if (
    !(await one(
      c,
      `SELECT id FROM pilot_curriculum_proof_receipt WHERE id=${q(r.receiptId)}`,
    ))
  )
    fail('UNAUTHORIZED', 401);
  return {
    receiptId: r.receiptId,
    receiptDigest: checked.receiptDigest,
    eligible: true,
  };
}
export async function recordStoryOwner(
  c: StoryContext,
  version: string,
  input: unknown,
) {
  if (await isCollectionPackage(c, version))
    return recordCollectionOwner(c, version, input);
  await requireActor(c, 'operator');
  if (version !== VERSION) fail('NOT_FOUND', 404);
  if (
    !exact(input, [
      'requestId',
      'contentDigest',
      'candidateId',
      'artifactDigest',
      'targetInstallationId',
      'scope',
      'ownerIdentity',
      'decision',
      'decidedAt',
      'evidenceRef',
    ]) ||
    !text(input.requestId, 120) ||
    !digest(input.contentDigest) ||
    !digest(input.artifactDigest) ||
    !text(input.candidateId, 120) ||
    !text(input.targetInstallationId, 240) ||
    !text(input.ownerIdentity, 240) ||
    !text(input.evidenceRef, 240) ||
    !['accepted', 'rejected'].includes(String(input.decision)) ||
    !Number.isSafeInteger(input.decidedAt) ||
    Number(input.decidedAt) < 0 ||
    Number(input.decidedAt) > now(c) + 300000
  )
    fail('INVALID_REQUEST', 400);
  const scope = parseTrialScope(input.scope),
    request = { ...input, scope };
  const install = await installation(c),
    bound = await lesson(c);
  if (
    input.contentDigest !== bound.compiled.identity.contentDigest ||
    input.targetInstallationId !== install ||
    input.candidateId !== c.config.curriculumTrust?.candidateId ||
    input.artifactDigest !== c.config.curriculumTrust?.artifactDigest
  )
    fail('RELEASE_IDENTITY_MISMATCH');
  if (
    bound.row.test_run_id !== (c.config.testMode ? c.config.testRunId : null) ||
    (c.config.testMode &&
      !capability(c, install, bound.compiled.identity.contentDigest))
  )
    fail('RELEASE_IDENTITY_MISMATCH');
  await linkedMembers(c, scope.members);
  const fingerprint = await operationDigest(
      'owner',
      c.user.id,
      install,
      version,
      request,
    ),
    previous = await one(
      c,
      `SELECT * FROM pilot_curriculum_owner_decision WHERE id=${q(input.requestId)}`,
    );
  if (previous) {
    if (previous.request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return { decisionId: previous.id, decision: previous.decision };
  }
  try {
    await batch(c, [
      insert(
        'pilot_curriculum_owner_decision',
        {
          id: input.requestId,
          lesson_version: version,
          content_digest: input.contentDigest,
          candidate_id: input.candidateId,
          artifact_digest: input.artifactDigest,
          target_installation_id: install,
          scope_digest: await curriculumDigest(scope),
          owner_identity: input.ownerIdentity,
          decision: input.decision,
          decided_at: input.decidedAt,
          evidence_ref: input.evidenceRef,
          recorded_by: c.user.id,
          test_run_id: c.config.testMode ? c.config.testRunId : null,
          request_json: canonicalPackage(
            operationRequest('owner', c.user.id, install, version, request),
          ),
          request_digest: fingerprint,
        },
        actorGuard(c, 'operator'),
      ),
    ]);
  } catch {
    const raced = await one(
      c,
      `SELECT * FROM pilot_curriculum_owner_decision WHERE id=${q(input.requestId)}`,
    );
    if (!raced) fail('STORAGE_UNAVAILABLE', 503);
    if (raced.request_digest !== fingerprint) fail('EVENT_CONFLICT');
  }
  if (
    !(await one(
      c,
      `SELECT id FROM pilot_curriculum_owner_decision WHERE id=${q(input.requestId)}`,
    ))
  ) {
    await requireActor(c, 'operator');
    fail('STORAGE_UNAVAILABLE', 503);
  }
  return { decisionId: input.requestId, decision: input.decision };
}
async function linkedMembers(c: StoryContext, m: TrialScope['members']) {
  for (const v of m)
    if (
      !(await one(
        c,
        `SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.parent_id=${q(v.parentId)} AND l.child_id=${q(v.childId)} AND p.role='parent' AND p.disabled=0 AND p.must_change_password=0 AND u.role='child' AND u.disabled=0 AND u.must_change_password=0`,
      ))
    )
      fail('RELEASE_SCOPE_INVALID');
}
export async function publishStory(
  c: StoryContext,
  version: string,
  input: unknown,
  bootstrap = false,
) {
  if (await isCollectionPackage(c, version))
    return publishCollection(c, version, input);
  await requireActor(c, 'operator');
  if (version !== VERSION) fail('NOT_FOUND', 404);
  if (
    !exact(input, [
      'requestId',
      'expectedRevision',
      'predecessorId',
      'contentDigest',
      'reviewId',
      'proofId',
      'ownerDecisionId',
      'status',
      'scope',
    ]) ||
    !text(input.requestId, 120) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0 ||
    !(input.predecessorId === null || text(input.predecessorId, 120)) ||
    !digest(input.contentDigest) ||
    ![input.reviewId, input.proofId, input.ownerDecisionId].every(
      (v) => v === null || text(v, 120),
    ) ||
    !['released', 'rejected', 'withdrawn'].includes(String(input.status))
  )
    fail('INVALID_REQUEST', 400);
  const scope = parseTrialScope(input.scope),
    request = { ...input, scope };
  const install = await installation(c),
    bound = await lesson(c),
    trust = c.config.curriculumTrust;
  const fingerprint = await operationDigest(
    'publication',
    c.user.id,
    install,
    version,
    request,
  );
  const previous = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE installation_id=${q(install)} AND request_id=${q(input.requestId)}`,
  );
  if (previous) {
    if (previous.request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return JSON.parse(String(previous.ack_json));
  }
  const head = await latest(c);
  if (
    Number(input.expectedRevision) !== Number(head?.generation ?? 0) ||
    input.predecessorId !== (head?.id ?? null)
  )
    fail('STALE_REVISION');
  if (input.contentDigest !== bound.compiled.identity.contentDigest)
    fail('RELEASE_IDENTITY_MISMATCH');
  const verification = !!capability(c, install, String(input.contentDigest));
  let reviewId = input.reviewId,
    proofId = input.proofId,
    ownerId = input.ownerDecisionId;
  if (input.status === 'released') {
    if (!trust) fail('RELEASE_UNAVAILABLE');
    await linkedMembers(c, scope.members);
    if (bootstrap) {
      if (!verification || head) fail('NOT_FOUND', 404);
      reviewId = null;
      proofId = null;
      ownerId = null;
    } else {
      if (!text(reviewId, 120) || !text(proofId, 120) || !text(ownerId, 120))
        fail('INVALID_REQUEST', 400);
      const review = await one(
          c,
          `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(version)} ORDER BY review_sequence DESC LIMIT 1`,
        ),
        proof = await one(
          c,
          `SELECT * FROM pilot_curriculum_proof_receipt WHERE id=${q(proofId)}`,
        ),
        owner = await one(
          c,
          `SELECT * FROM pilot_curriculum_owner_decision WHERE id=${q(ownerId)}`,
        );
      const namespace = verification ? c.config.testRunId : null;
      if (
        !review ||
        review.review_id !== reviewId ||
        review.decision !== 'approved' ||
        review.content_digest !== input.contentDigest ||
        review.test_run_id !== namespace ||
        bound.row.test_run_id !== namespace ||
        !proof ||
        !owner ||
        owner.decision !== 'accepted' ||
        owner.test_run_id !== namespace ||
        owner.scope_digest !== (await curriculumDigest(scope)) ||
        owner.content_digest !== input.contentDigest ||
        owner.candidate_id !== trust.candidateId ||
        owner.artifact_digest !== trust.artifactDigest ||
        owner.target_installation_id !== install
      )
        fail('RELEASE_PREREQUISITES');
      const result = await verifyProofReceipt(
        JSON.parse(String(proof.receipt_json)),
        proof.signature,
        trust,
        {
          installationId: install,
          contentDigest: String(input.contentDigest),
          ...(verification ? { namespace: c.config.testRunId ?? '' } : {}),
        },
        now(c),
      );
      if (
        result.issuer.purpose !== (verification ? 'candidate' : 'release') ||
        result.receiptDigest !== proof.receipt_digest
      )
        fail('RELEASE_PREREQUISITES');
      if (
        !verification &&
        !hasCompleteCurriculumProvenance(
          bound.compiled.package as unknown as Parameters<
            typeof hasCompleteCurriculumProvenance
          >[0],
        )
      )
        fail('RELEASE_PREREQUISITES');
    }
  } else {
    if (
      !head ||
      input.contentDigest !== head.content_digest ||
      reviewId !== head.review_id ||
      proofId !== head.proof_id ||
      ownerId !== head.owner_decision_id ||
      canonicalPackage(scope.members) !==
        canonicalPackage(await members(c, String(head.id)))
    )
      fail('RELEASE_IDENTITY_MISMATCH');
  }
  const generation = Number(input.expectedRevision) + 1,
    pubId = id('publication'),
    ack = publicationAck(pubId, generation, String(input.status)),
    at = now(c);
  const namespace =
    head && input.status !== 'released'
      ? head.test_run_id
      : verification
        ? c.config.testRunId
        : null;
  const scopeKind =
    head && input.status !== 'released'
      ? head.scope_kind
      : verification
        ? 'verification'
        : 'supervised-trial';
  let guard = `${actorGuard(c, 'operator')} AND EXISTS(SELECT 1 FROM pilot_installation WHERE id=1 AND installation_id=${q(install)}) AND ${head ? `EXISTS(SELECT 1 FROM pilot_curriculum_publication_state WHERE installation_id=${q(install)} AND lesson_version=${q(version)} AND revision=${q(input.expectedRevision)} AND latest_publication_id=${q(input.predecessorId)})` : `NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication_state WHERE installation_id=${q(install)} AND lesson_version=${q(version)})`}`;
  if (input.status === 'released')
    for (const m of scope.members)
      guard += ` AND EXISTS(SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.child_id=${q(m.childId)} AND l.parent_id=${q(m.parentId)} AND u.role='child' AND p.role='parent' AND u.disabled=0 AND u.must_change_password=0 AND p.disabled=0 AND p.must_change_password=0)`;
  if (input.status === 'released' && !bootstrap)
    guard += ` AND EXISTS(SELECT 1 FROM pilot_curriculum_review WHERE review_id=${q(reviewId)} AND decision='approved' AND review_sequence=(SELECT MAX(review_sequence) FROM pilot_curriculum_review WHERE lesson_version=${q(version)}))`;
  const statements = [
    insert(
      'pilot_curriculum_publication',
      {
        id: pubId,
        lesson_version: version,
        content_digest: input.contentDigest,
        generation,
        predecessor_id: head?.id ?? null,
        request_id: input.requestId,
        request_digest: fingerprint,
        request_json: canonicalPackage(
          operationRequest('publication', c.user.id, install, version, request),
        ),
        ack_json: canonicalPackage(ack),
        status: input.status,
        scope_kind: scopeKind,
        scope_digest: await curriculumDigest(scope),
        review_id: reviewId,
        proof_id: proofId,
        owner_decision_id: ownerId,
        candidate_id:
          head && input.status !== 'released'
            ? head.candidate_id
            : trust?.candidateId,
        artifact_digest:
          head && input.status !== 'released'
            ? head.artifact_digest
            : trust?.artifactDigest,
        installation_id: install,
        actor_id: c.user.id,
        created_at: at,
        test_run_id: namespace,
      },
      guard,
    ),
    ...scope.members.map((m) =>
      insert('pilot_curriculum_trial_member', {
        publication_id: pubId,
        child_id: m.childId,
        parent_id: m.parentId,
        plan_scope: m.planScope,
      }),
    ),
    `INSERT INTO pilot_curriculum_publication_state(installation_id,lesson_version,revision,latest_publication_id) VALUES(${q(install)},${q(version)},${generation},${q(pubId)}) ON CONFLICT(installation_id,lesson_version) DO UPDATE SET revision=excluded.revision,latest_publication_id=excluded.latest_publication_id`,
    insert('pilot_curriculum_publication_audit', {
      id: id('publication-audit'),
      publication_id: pubId,
      actor_id: c.user.id,
      action: input.status,
      request_id: input.requestId,
      created_at: at,
    }),
  ];
  try {
    await batch(c, statements);
  } catch {
    const raced = await one(
      c,
      `SELECT request_digest,ack_json FROM pilot_curriculum_publication WHERE installation_id=${q(install)} AND request_id=${q(input.requestId)}`,
    );
    if (raced) {
      if (raced.request_digest !== fingerprint) fail('EVENT_CONFLICT');
      return JSON.parse(String(raced.ack_json));
    }
    const current = await latest(c);
    if ((current?.id ?? null) !== (head?.id ?? null)) fail('STALE_REVISION');
    throw new StoryError('STORAGE_UNAVAILABLE', 503);
  }
  return ack;
}
export async function bootstrapStory(
  c: StoryContext,
  input: unknown,
  manifest: unknown,
) {
  await requireActor(c, 'operator');
  if (!exact(input, ['fixture']) || input.fixture !== 'family-story')
    fail('INVALID_REQUEST', 400);
  const compiled = await compileStoryPackage(manifest),
    install = await installation(c),
    cap = capability(c, install, compiled.identity.contentDigest);
  if (!cap) fail('NOT_FOUND', 404);
  const existing = await one(
    c,
    `SELECT * FROM pilot_curriculum_package WHERE lesson_version=${q(VERSION)}`,
  );
  if (existing) {
    if (
      existing.test_run_id !== cap.namespace ||
      existing.content_digest !== compiled.identity.contentDigest
    )
      fail('RELEASE_IDENTITY_MISMATCH');
  } else {
    const importId = id('story-import'),
      at = now(c);
    await batch(c, [
      insert(
        'pilot_curriculum_package',
        {
          lesson_version: VERSION,
          lesson_id: 'forest-01',
          content_digest: compiled.identity.contentDigest,
          canonicalization_version: 's3-json-1',
          manifest_json: canonicalPackage(manifest),
          import_id: importId,
          imported_by_user_id: c.user.id,
          imported_at: at,
          test_run_id: cap.namespace,
        },
        actorGuard(c, 'operator'),
      ),
      ...compiled.package.characters.map((character, index) =>
        insert('pilot_curriculum_character', {
          lesson_version: VERSION,
          character_id: character.characterId,
          hanzi: character.hanzi,
          character_index: index,
        }),
      ),
      insert('pilot_curriculum_audit', {
        id: id('curriculum-audit'),
        action: 'import',
        actor_user_id: c.user.id,
        lesson_version: VERSION,
        content_digest: compiled.identity.contentDigest,
        review_id: null,
        created_at: at,
      }),
      `UPDATE pilot_curriculum_registry_state SET revision=revision+1,updated_at=MAX(updated_at,${at}) WHERE id=1`,
    ]);
  }
  const m: TrialScope['members'] = [];
  for (const childId of cap.childIds) {
    const link = await one(
      c,
      `SELECT parent_id FROM pilot_parent_child WHERE child_id=${q(childId)} AND parent_id IN (${cap.parentIds.map(q).join(',')}) ORDER BY parent_id LIMIT 1`,
    );
    if (!link) fail('RELEASE_SCOPE_INVALID');
    m.push({ childId, parentId: String(link.parent_id), planScope: VERSION });
  }
  return publishStory(
    c,
    VERSION,
    {
      requestId: `bootstrap-${cap.namespace}`,
      expectedRevision: 0,
      predecessorId: null,
      contentDigest: compiled.identity.contentDigest,
      reviewId: null,
      proofId: null,
      ownerDecisionId: null,
      status: 'released',
      scope: { kind: 'supervised-trial', members: m },
    },
    true,
  );
}
function libraryItem(
  p: Row,
  assignmentId: string | null,
  status: { available: boolean; reason: string | null },
) {
  return {
    lessonVersion: VERSION,
    title: 'A shady place to read',
    contentDigest: String(p.content_digest),
    publicationId: String(p.id),
    generation: Number(p.generation),
    ...status,
    assignmentId,
  };
}
export async function storyLibrary(
  c: StoryContext,
  childId: string,
  collectionVersion?: string,
) {
  if (collectionVersion !== undefined)
    return collectionLibrary(c, childId, collectionVersion);
  await readable(c, childId);
  const p = await latest(c);
  if (!p) return { items: [] };
  const status = await available(c, p, childId);
  if (c.user.role === 'parent') {
    const m = await members(c, String(p.id));
    if (!m.some((v) => v.childId === childId && v.parentId === c.user.id))
      return { items: [] };
    return { items: [libraryItem(p, null, status)] };
  }
  const a = await rows(
    c,
    `SELECT a.*,p.generation,p.status FROM pilot_curriculum_assignment a JOIN pilot_curriculum_publication p ON p.id=a.publication_id WHERE a.child_id=${q(childId)} ORDER BY a.created_at`,
  );
  return {
    items: await Promise.all(
      a.map(async (r) =>
        libraryItem(
          { ...r, id: r.publication_id },
          String(r.id),
          await available(c, { ...r, id: r.publication_id }, childId),
        ),
      ),
    ),
  };
}
async function proposalInputs(
  c: StoryContext,
  childId: string,
  p: Row,
  at: number,
) {
  const setup = await one(
    c,
    `SELECT nickname,experience,audio_ready,updated_at,updated_by FROM pilot_onboarding WHERE child_id=${q(childId)}`,
  );
  if (!setup) fail('ONBOARDING_REQUIRED');
  const evidence = await rows(
    c,
    `SELECT e.run_id,e.event_id,e.sequence,e.result_json,e.server_at FROM pilot_curriculum_learning_event e JOIN pilot_curriculum_learning_run r ON r.id=e.run_id WHERE r.child_id=${q(childId)} AND r.installation_id=${q(p.installation_id)} ORDER BY e.run_id,e.sequence`,
  );
  return placementSource({
    childId,
    installationId: String(p.installation_id),
    onboardingDigest: await curriculumDigest(setup),
    evidenceDigest: await curriculumDigest(evidence),
    publicationId: String(p.id),
    contentDigest: String(p.content_digest),
    reason: evidence.length
      ? 'This starting suggestion uses saved practice and your setup. It does not establish mastery.'
      : 'This is a starting suggestion based on your setup. It does not establish mastery.',
    createdAt: at,
  });
}
function proposalDTO(r: Row): PlacementProposal {
  return {
    proposalId: String(r.id),
    childId: String(r.child_id),
    installationId: String(r.installation_id),
    lessonVersion: VERSION,
    contentDigest: String(r.content_digest),
    publicationId: String(r.publication_id),
    sourceDigest: String(r.source_digest),
    reason: JSON.parse(String(r.reason_json)).text,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
  };
}
export async function proposeStory(
  c: StoryContext,
  childId: string,
  input: unknown,
) {
  if (
    input &&
    typeof input === 'object' &&
    Object.hasOwn(input, 'collectionVersion')
  )
    return proposeCollection(c, childId, input);
  await parent(c, childId);
  if (!exact(input, ['lessonVersion']) || input.lessonVersion !== VERSION)
    fail('INVALID_REQUEST', 400);
  const p = await latest(c);
  if (!p || !(await available(c, p, childId)).available)
    fail('PLACEMENT_UNAVAILABLE');
  const membership = await members(c, String(p.id));
  if (
    !membership.some((v) => v.childId === childId && v.parentId === c.user.id)
  )
    fail('PLACEMENT_UNAVAILABLE');
  const source = await proposalInputs(c, childId, p, now(c));
  const recent = await one(
    c,
    `SELECT * FROM pilot_placement_proposal WHERE child_id=${q(childId)} AND installation_id=${q(source.installationId)} AND publication_id=${q(source.publicationId)} AND onboarding_digest=${q(source.onboardingDigest)} AND evidence_digest=${q(source.evidenceDigest)} AND expires_at>${now(c)} ORDER BY created_at DESC LIMIT 1`,
  );
  if (recent) return { proposal: proposalDTO(recent) };
  const proposalId = id('proposal');
  const r = {
    id: proposalId,
    child_id: childId,
    installation_id: source.installationId,
    policy_version: source.policyVersion,
    source_digest: await curriculumDigest(source),
    source_json: canonicalPackage(source),
    onboarding_digest: source.onboardingDigest,
    evidence_digest: source.evidenceDigest,
    publication_id: source.publicationId,
    lesson_version: VERSION,
    content_digest: source.contentDigest,
    reason_json: canonicalPackage({ text: source.reason }),
    created_at: source.createdAt,
    expires_at: source.createdAt + 86400000,
    test_run_id: p.test_run_id,
  };
  await batch(c, [
    insert(
      'pilot_placement_proposal',
      r,
      `${parentGuard(c, childId)} AND ${publicationGuard(c, p)}`,
    ),
  ]);
  if (
    !(await one(
      c,
      `SELECT id FROM pilot_placement_proposal WHERE id=${q(proposalId)}`,
    ))
  )
    fail('PLACEMENT_STALE');
  return { proposal: proposalDTO(r) };
}
export async function storyPlacement(
  c: StoryContext,
  childId: string,
  collectionVersion?: string,
) {
  if (collectionVersion !== undefined)
    return collectionPlacement(c, childId, collectionVersion);
  await readable(c, childId);
  const setup = await one(
    c,
    `SELECT 1 FROM pilot_onboarding WHERE child_id=${q(childId)}`,
  );
  const r = await one(
    c,
    `SELECT * FROM pilot_placement_proposal WHERE child_id=${q(childId)} AND installation_id=${q(await installation(c))} ORDER BY created_at DESC LIMIT 1`,
  );
  let reason: string | null = setup
    ? null
    : 'Prepare this child’s setup first.';
  if (r) {
    const p = await one(
      c,
      `SELECT * FROM pilot_curriculum_publication WHERE id=${q(r.publication_id)}`,
    );
    if (
      !p ||
      !(await available(c, p, childId)).available ||
      Number(r.expires_at) <= now(c) ||
      (await curriculumDigest(
        await proposalInputs(c, childId, p, Number(r.created_at)),
      )) !== r.source_digest
    )
      reason = 'This suggestion needs to be refreshed.';
  }
  return {
    setupComplete: !!setup,
    proposal: r ? proposalDTO(r) : null,
    reason,
  };
}
async function planDTO(c: StoryContext, r: Row): Promise<StoryPlan> {
  const items = await rows(
    c,
    `SELECT i.*,a.id AS assignment_id,p.generation FROM pilot_learning_plan_item i JOIN pilot_curriculum_assignment a ON a.plan_item_id=i.id JOIN pilot_curriculum_publication p ON p.id=i.publication_id WHERE i.plan_id=${q(r.id)} ORDER BY i.ordinal`,
  );
  const projected = await Promise.all(
    items.map(async (i) => ({
      ...libraryItem(
        { ...i, id: i.publication_id },
        String(i.assignment_id),
        await available(
          c,
          {
            ...(await one(
              c,
              `SELECT * FROM pilot_curriculum_publication WHERE id=${q(i.publication_id)}`,
            ))!,
          },
          String(r.child_id),
        ),
      ),
      planItemId: String(i.id),
      ordinal: 0 as const,
    })),
  );
  const active =
    projected.length === 1 &&
    (await assignmentActive(c, projected[0].assignmentId!, String(r.child_id)));
  return {
    planId: String(r.id),
    proposalId: String(r.proposal_id),
    childId: String(r.child_id),
    installationId: String(r.installation_id),
    approvedAt: iso(r.approved_at),
    available: active && projected[0].available,
    reason:
      projected.find((x) => !x.available)?.reason ??
      (!active ? 'A newer approved plan is available.' : null),
    items: projected as StoryPlan['items'],
  };
}
export async function storyPlans(
  c: StoryContext,
  childId: string,
  collectionVersion?: string,
) {
  if (collectionVersion !== undefined)
    return collectionPlans(c, childId, collectionVersion);
  await readable(c, childId);
  const history = await rows(
    c,
    `SELECT * FROM pilot_learning_plan WHERE child_id=${q(childId)} ORDER BY approved_at DESC,id DESC`,
  );
  const plans = await Promise.all(history.map((r) => planDTO(c, r)));
  const install = await installation(c);
  const current = plans.find((p) => p.installationId === install) ?? null;
  return { plan: current, history: plans };
}
export async function approveStory(
  c: StoryContext,
  childId: string,
  input: unknown,
) {
  if (
    exact(input, ['proposalId', 'sourceDigest']) &&
    typeof input.proposalId === 'string' &&
    (await isCorpusResource(c, 'proposal', input.proposalId))
  )
    return approveCorpus(corpusLearningContext(c), childId, input);
  if (
    exact(input, ['proposalId', 'sourceDigest']) &&
    typeof input.proposalId === 'string' &&
    (await isCollectionResource(c, 'proposal', input.proposalId))
  )
    return approveCollection(c, childId, input);
  await parent(c, childId);
  if (
    !exact(input, ['proposalId', 'sourceDigest']) ||
    !text(input.proposalId, 120) ||
    !digest(input.sourceDigest)
  )
    fail('INVALID_REQUEST', 400);
  const s = await one(
    c,
    `SELECT * FROM pilot_placement_proposal WHERE id=${q(input.proposalId)} AND child_id=${q(childId)} AND installation_id=${q(await installation(c))}`,
  );
  if (!s) fail('NOT_FOUND', 404);
  if (s.source_digest !== input.sourceDigest) fail('PLACEMENT_STALE');
  const existing = await one(
    c,
    `SELECT * FROM pilot_learning_plan WHERE proposal_id=${q(s.id)}`,
  );
  if (existing) return { plan: await planDTO(c, existing) };
  const p = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE id=${q(s.publication_id)}`,
  );
  if (
    !p ||
    !(await available(c, p, childId)).available ||
    Number(s.expires_at) <= now(c) ||
    (await curriculumDigest(
      await proposalInputs(c, childId, p, Number(s.created_at)),
    )) !== s.source_digest
  )
    fail('PLACEMENT_STALE');
  const m = await members(c, String(p.id));
  if (!m.some((v) => v.childId === childId && v.parentId === c.user.id))
    fail('PLACEMENT_STALE');
  const previousPlanCount = Number(
    (
      await one(
        c,
        `SELECT COUNT(*) AS n FROM pilot_learning_plan WHERE child_id=${q(childId)} AND installation_id=${q(s.installation_id)}`,
      )
    )?.n ?? 0,
  );
  const planId = id(`plan-${String(previousPlanCount + 1).padStart(16, '0')}`),
    itemId = id('plan-item'),
    assignmentId = id('assignment'),
    at = now(c);
  const r = {
    id: planId,
    proposal_id: s.id,
    child_id: childId,
    installation_id: s.installation_id,
    parent_id: c.user.id,
    policy_version: s.policy_version,
    source_digest: s.source_digest,
    approved_at: at,
    test_run_id: s.test_run_id,
  };
  const source = JSON.parse(String(s.source_json));
  const savedSetup = await one(
    c,
    `SELECT nickname,experience,audio_ready,updated_at,updated_by FROM pilot_onboarding WHERE child_id=${q(childId)}`,
  );
  if (
    !savedSetup ||
    (await curriculumDigest(savedSetup)) !== source.onboardingDigest
  )
    fail('PLACEMENT_STALE');
  const evidenceCount = Number(
    (
      await one(
        c,
        `SELECT COUNT(*) AS n FROM pilot_curriculum_learning_event e JOIN pilot_curriculum_learning_run r ON r.id=e.run_id WHERE r.child_id=${q(childId)} AND r.installation_id=${q(s.installation_id)}`,
      )
    )?.n ?? 0,
  );
  if (
    (await curriculumDigest(
      await proposalInputs(c, childId, p, Number(s.created_at)),
    )) !== s.source_digest
  )
    fail('PLACEMENT_STALE');
  const guard = `${parentGuard(c, childId)} AND ${publicationGuard(c, p)} AND EXISTS(SELECT 1 FROM pilot_placement_proposal WHERE id=${q(s.id)} AND expires_at>${at} AND source_digest=${q(input.sourceDigest)}) AND EXISTS(SELECT 1 FROM pilot_onboarding WHERE child_id=${q(childId)} AND ${Object.entries(
    savedSetup,
  )
    .map(([k, v]) => `${k} IS ${q(v)}`)
    .join(
      ' AND ',
    )}) AND (SELECT COUNT(*) FROM pilot_curriculum_learning_event e JOIN pilot_curriculum_learning_run r ON r.id=e.run_id WHERE r.child_id=${q(childId)} AND r.installation_id=${q(s.installation_id)})=${evidenceCount} AND (SELECT COUNT(*) FROM pilot_learning_plan WHERE child_id=${q(childId)} AND installation_id=${q(s.installation_id)})=${previousPlanCount}`;
  const statements = [
    insert('pilot_learning_plan', r, guard),
    insert('pilot_learning_plan_item', {
      id: itemId,
      plan_id: planId,
      child_id: childId,
      installation_id: s.installation_id,
      ordinal: 0,
      publication_id: s.publication_id,
      lesson_version: VERSION,
      content_digest: s.content_digest,
      reason_json: s.reason_json,
    }),
    insert('pilot_curriculum_assignment', {
      id: assignmentId,
      plan_item_id: itemId,
      child_id: childId,
      installation_id: s.installation_id,
      lesson_version: VERSION,
      content_digest: s.content_digest,
      publication_id: s.publication_id,
      created_at: at,
      test_run_id: s.test_run_id,
    }),
    insert('pilot_learning_schedule', {
      id: id('schedule'),
      assignment_id: assignmentId,
      child_id: childId,
      kind: 'initial',
      due_at: at,
      policy_version: 'r3-review-24h-1',
      created_at: at,
    }),
    insert('pilot_curriculum_learning_audit', {
      id: id('learning-audit'),
      run_id: null,
      plan_id: planId,
      actor_id: c.user.id,
      action: 'plan-approval',
      event_id: null,
      revision: null,
      created_at: at,
    }),
  ];
  try {
    await batch(c, statements);
  } catch {
    const raced = await one(
      c,
      `SELECT * FROM pilot_learning_plan WHERE proposal_id=${q(s.id)}`,
    );
    if (raced) return { plan: await planDTO(c, raced) };
    if (
      !(await available(c, p, childId)).available ||
      source.onboardingDigest !==
        (await curriculumDigest(
          await one(
            c,
            `SELECT nickname,experience,audio_ready,updated_at,updated_by FROM pilot_onboarding WHERE child_id=${q(childId)}`,
          ),
        ))
    )
      fail('PLACEMENT_STALE');
    fail('STORAGE_UNAVAILABLE', 503);
  }
  return { plan: await planDTO(c, r) };
}
interface RunSnapshot {
  row: Row;
  compiled: CompiledStory;
  run: StoryRun;
  ledger: StoryLedgerEntry[];
  events: LearningEvent[];
}
async function snapshot(c: StoryContext, runId: string): Promise<RunSnapshot> {
  const r = await one(
    c,
    `SELECT r.*,COALESCE((SELECT json_group_array(json_object('id',e.id,'event_id',e.event_id,'sequence',e.sequence,'expected_revision',e.expected_revision,'request_digest',e.request_digest,'action_json',e.action_json,'result_json',e.result_json,'server_at',e.server_at)) FROM (SELECT * FROM pilot_curriculum_learning_event WHERE run_id=r.id ORDER BY sequence) e),'[]') AS ledger_json,COALESCE((SELECT json_group_array(json_object('action',a.action,'revision',a.revision,'event_id',a.event_id,'actor_id',a.actor_id,'created_at',a.created_at)) FROM (SELECT * FROM pilot_curriculum_learning_audit WHERE run_id=r.id ORDER BY revision) a),'[]') AS audits_json FROM pilot_curriculum_learning_run r WHERE r.id=${q(runId)}`,
  );
  if (!r) fail('NOT_FOUND', 404);
  await readable(c, String(r.child_id));
  const bound = await lesson(c);
  try {
    const run = JSON.parse(String(r.run_json)) as StoryRun;
    if (
      canonicalPackage(run) !== r.run_json ||
      run.runId !== r.id ||
      run.revision !== Number(r.revision) ||
      run.seed !== Number(r.seed) ||
      Date.parse(run.createdAt) !== Number(r.created_at) ||
      Date.parse(run.updatedAt) !== Number(r.updated_at) ||
      run.contentDigest !== r.content_digest
    )
      fail('STORAGE_UNAVAILABLE', 503);
    const raw = JSON.parse(String(r.ledger_json)) as Row[];
    const ledger: StoryLedgerEntry[] = raw.map((e) => ({
      action: JSON.parse(String(e.action_json)),
      serverAt: iso(e.server_at),
      result: JSON.parse(String(e.result_json)),
    }));
    const audits = JSON.parse(String(r.audits_json)) as Row[];
    if (
      audits.length !== raw.length + 1 ||
      audits[0].action !== 'run-start' ||
      Number(audits[0].revision) !== 0 ||
      audits[0].actor_id !== r.child_id ||
      Number(audits[0].created_at) !== Number(r.created_at)
    )
      fail('STORAGE_UNAVAILABLE', 503);
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i],
        l = ledger[i],
        a = audits[i + 1];
      if (
        Number(e.sequence) !== i + 1 ||
        Number(e.expected_revision) !== i ||
        e.event_id !== l.action.eventId ||
        canonicalPackage(l.action) !== e.action_json ||
        canonicalPackage(l.result) !== e.result_json ||
        (await operationDigest(
          'action',
          String(r.child_id),
          String(r.installation_id),
          String(r.id),
          l.action,
        )) !== e.request_digest ||
        a.action !== 'run-action' ||
        a.event_id !== e.id ||
        Number(a.revision) !== i + 1 ||
        a.actor_id !== r.child_id ||
        Number(a.created_at) !== Number(e.server_at)
      )
        fail('STORAGE_UNAVAILABLE', 503);
      const p = await one(
        c,
        `SELECT scope_kind FROM pilot_curriculum_publication WHERE id=${q(r.publication_id)}`,
      );
      if (
        l.result.policy.soundReview !==
        (p?.scope_kind === 'verification' ? 'synthetic' : 'reviewed')
      )
        fail('STORAGE_UNAVAILABLE', 503);
    }
    replayStoryRun(bound.compiled, run, ledger);
    return {
      row: r,
      compiled: bound.compiled,
      run,
      ledger,
      events: ledger.map((e) => e.result.event),
    };
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
function safeQuestion(
  qn: (typeof FOREST_STORY_LESSON.questions)[number],
  hintLevel = 0,
  order?: string[],
): SafeQuestion {
  const {
    correctChoiceId: _key,
    hint,
    demonstration,
    ...safe
  } = structuredClone(qn);
  const ids = order ?? safe.choices.map((c) => c.id);
  return {
    ...safe,
    choices: ids.map((v) => safe.choices.find((c) => c.id === v)!),
    ...(hintLevel >= 1 ? { hint } : {}),
    ...(hintLevel >= 2 ? { demonstration } : {}),
  };
}
async function view(c: StoryContext, s: RunSnapshot): Promise<StoryView> {
  const p = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE id=${q(s.row.publication_id)}`,
  );
  const status = await available(c, p, String(s.row.child_id));
  const active = await assignmentActive(
    c,
    String(s.row.assignment_id),
    String(s.row.child_id),
  );
  if (!active) {
    status.available = false;
    status.reason = 'A newer approved plan is available.';
    status.policy.soundReview = 'pending';
  }
  const current = FOREST_STORY_LESSON.questions.find(
    (v) => v.id === s.run.state.questionId,
  );
  const old = deriveRecap(s.events);
  const group = (g: typeof old.final) => ({
    total: g.total,
    independent: g.independentCorrect,
    supported: g.supported,
    unavailable: g.unavailable,
    pending: g.pending,
  });
  const recap = {
    familiarity: group(old.familiarity),
    immediate: group(old.final),
    delayed: group(old.delayed),
    game: {
      total: 2,
      completed: old.sceneCompleted
        ? 2
        : s.events.filter(
            (e) =>
              e.stepId === 'find' &&
              ['correct', 'demonstrated', 'unavailable'].includes(e.outcome),
          ).length,
    },
    evidenceLimits: [
      'These responses do not establish mastery or fluency.',
      'Supported reading and games are separate from independent recognition.',
      'Delayed review is separate evidence.',
    ],
  };
  const safeLesson: StoryLesson = {
    lessonId: 'forest-01',
    lessonVersion: VERSION,
    title: 'A shady place to read',
    steps: FOREST_STORY_LESSON.steps,
    characters: FOREST_STORY_LESSON.characters,
    examples: FOREST_STORY_LESSON.examples,
    captions: FOREST_STORY_LESSON.captions,
    componentLayout: FOREST_STORY_LESSON.componentLayout,
    questions: FOREST_STORY_LESSON.questions.map((q) => safeQuestion(q)),
    playback: s.compiled.package.story.playback,
  };
  const due = reviewAvailableAt(s.run);
  return {
    schemaVersion: 'r3-story-view-1',
    runId: s.run.runId,
    assignmentId: String(s.row.assignment_id),
    lessonVersion: VERSION,
    contentDigest: s.run.contentDigest,
    adapterId: 'forest-story',
    adapterVersion: 'forest-story-v1',
    publicationId: String(s.row.publication_id),
    installationId: String(s.row.installation_id),
    childId: String(s.row.child_id),
    revision: s.run.revision,
    state: {
      ...s.run.state,
      learnPanel: s.run.state.learnPanel ?? null,
      soundReview: status.policy.soundReview,
    },
    question: current
      ? safeQuestion(
          current,
          s.run.state.hintLevel,
          rotatedChoices(current.id, s.run.seed, 'forest-01-v3'),
        )
      : null,
    lesson: safeLesson,
    events: s.events.map(
      ({ payload: _payload, result: _result, runId: _runId, ...e }) => e,
    ),
    recap,
    available: status.available,
    reason: status.reason,
    serverAt: iso(now(c)),
    createdAt: s.run.createdAt,
    updatedAt: s.run.updatedAt,
    reviewAvailableAt: due,
    reviewDue:
      !!due && !s.run.state.reviewCompletedAt && now(c) >= Date.parse(due),
  };
}
export async function getStoryRun(c: StoryContext, runId: string) {
  if (await isCorpusResource(c, 'run', runId))
    return getCorpusRun(corpusLearningContext(c), runId);
  if (await isCollectionResource(c, 'run', runId))
    return getCollectionRun(c, runId);
  return view(c, await snapshot(c, runId));
}
async function assignmentActive(
  c: StoryContext,
  assignmentId: string,
  childId: string,
) {
  const install = await installation(c);
  return !!(await one(
    c,
    `SELECT 1 FROM pilot_curriculum_assignment a JOIN pilot_learning_plan_item i ON i.id=a.plan_item_id JOIN pilot_learning_plan p ON p.id=i.plan_id WHERE a.id=${q(assignmentId)} AND a.child_id=${q(childId)} AND a.installation_id=${q(install)} AND p.id=(SELECT id FROM pilot_learning_plan WHERE child_id=${q(childId)} AND installation_id=${q(install)} ORDER BY approved_at DESC,id DESC LIMIT 1)`,
  ));
}
function assignmentGuard(
  assignmentId: string,
  childId: string,
  install: string,
) {
  return `EXISTS(SELECT 1 FROM pilot_curriculum_assignment a JOIN pilot_learning_plan_item i ON i.id=a.plan_item_id JOIN pilot_learning_plan p ON p.id=i.plan_id WHERE a.id=${q(assignmentId)} AND a.child_id=${q(childId)} AND a.installation_id=${q(install)} AND p.id=(SELECT id FROM pilot_learning_plan WHERE child_id=${q(childId)} AND installation_id=${q(install)} ORDER BY approved_at DESC,id DESC LIMIT 1))`;
}
export async function startStory(
  c: StoryContext,
  assignmentId: string,
  input: unknown,
) {
  if (await isCorpusResource(c, 'assignment', assignmentId))
    return startCorpus(corpusLearningContext(c), assignmentId, input);
  if (await isCollectionResource(c, 'assignment', assignmentId))
    return startCollection(c, assignmentId, input);
  await requireActor(c, 'child');
  if (!exact(input, ['requestId']) || !text(input.requestId, 120))
    fail('INVALID_REQUEST', 400);
  const a = await one(
    c,
    `SELECT * FROM pilot_curriculum_assignment WHERE id=${q(assignmentId)} AND child_id=${q(c.user.id)} AND installation_id=${q(await installation(c))}`,
  );
  if (!a) fail('NOT_FOUND', 404);
  const fingerprint = await operationDigest(
    'start',
    c.user.id,
    String(a.installation_id),
    assignmentId,
    input,
  );
  const original = await one(
    c,
    `SELECT * FROM pilot_curriculum_learning_run WHERE child_id=${q(c.user.id)} AND installation_id=${q(a.installation_id)} AND start_request_id=${q(input.requestId)}`,
  );
  if (original) {
    if (original.start_request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return JSON.parse(String(original.start_ack_json));
  }
  const p = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE id=${q(a.publication_id)}`,
  );
  if (
    !p ||
    !(await available(c, p, c.user.id)).available ||
    !(await assignmentActive(c, assignmentId, c.user.id))
  )
    fail('LESSON_UNAVAILABLE');
  const existing = await one(
    c,
    `SELECT id,revision FROM pilot_curriculum_learning_run WHERE assignment_id=${q(assignmentId)}`,
  );
  if (existing)
    return {
      runId: String(existing.id),
      assignmentId,
      lessonVersion: VERSION,
      revision: Number(existing.revision),
    };
  const bound = await lesson(c),
    seed = crypto.getRandomValues(new Uint32Array(1))[0],
    at = now(c),
    run = createInitialRun(bound.compiled, {
      runId: id('story-run'),
      seed,
      now: iso(at),
    }),
    ack = startAck(run.runId, assignmentId);
  const guard = `${childGuard(c, c.user.id, p)} AND ${assignmentGuard(assignmentId, c.user.id, String(a.installation_id))}`;
  try {
    await batch(c, [
      insert(
        'pilot_curriculum_learning_run',
        {
          id: run.runId,
          assignment_id: assignmentId,
          child_id: c.user.id,
          installation_id: a.installation_id,
          lesson_version: VERSION,
          content_digest: a.content_digest,
          publication_id: a.publication_id,
          adapter_id: 'forest-story',
          adapter_version: 'forest-story-v1',
          seed,
          start_request_id: input.requestId,
          start_request_digest: fingerprint,
          start_ack_json: canonicalPackage(ack),
          run_json: canonicalPackage(run),
          revision: 0,
          created_at: at,
          updated_at: at,
          test_run_id: a.test_run_id,
        },
        guard,
      ),
      insert('pilot_curriculum_learning_audit', {
        id: id('learning-audit'),
        run_id: run.runId,
        plan_id: null,
        actor_id: c.user.id,
        action: 'run-start',
        event_id: null,
        revision: 0,
        created_at: at,
      }),
    ]);
  } catch {
    const raced = await one(
      c,
      `SELECT * FROM pilot_curriculum_learning_run WHERE assignment_id=${q(assignmentId)}`,
    );
    if (raced) {
      if (
        raced.start_request_id === input.requestId &&
        raced.start_request_digest !== fingerprint
      )
        fail('EVENT_CONFLICT');
      return raced.start_request_id === input.requestId
        ? JSON.parse(String(raced.start_ack_json))
        : {
            runId: String(raced.id),
            assignmentId,
            lessonVersion: VERSION,
            revision: Number(raced.revision),
          };
    }
    if (
      !(await available(c, p, c.user.id)).available ||
      !(await assignmentActive(c, assignmentId, c.user.id))
    )
      fail('LESSON_UNAVAILABLE');
    fail('STORAGE_UNAVAILABLE', 503);
  }
  return ack;
}
export async function advanceStory(
  c: StoryContext,
  runId: string,
  input: unknown,
) {
  if (await isCorpusResource(c, 'run', runId))
    return advanceCorpus(corpusLearningContext(c), runId, input);
  if (await isCollectionResource(c, 'run', runId))
    return advanceCollection(c, runId, input);
  await requireActor(c, 'child');
  if (
    !exact(input, [
      'eventId',
      'expectedRevision',
      'stepId',
      'type',
      'payload',
    ]) ||
    !text(input.eventId, 120)
  )
    fail('INVALID_REQUEST', 400);
  const s = await snapshot(c, runId);
  if (s.row.child_id !== c.user.id) fail('NOT_FOUND', 404);
  const action = input as unknown as PreviewAction;
  const fingerprint = await operationDigest(
    'action',
    c.user.id,
    String(s.row.installation_id),
    runId,
    action,
  );
  const duplicate = await one(
    c,
    `SELECT request_digest,result_json FROM pilot_curriculum_learning_event WHERE run_id=${q(runId)} AND event_id=${q(action.eventId)}`,
  );
  if (duplicate) {
    if (duplicate.request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return {
      ack: JSON.parse(String(duplicate.result_json)).ack,
      replayed: true,
    };
  }
  const p = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE id=${q(s.row.publication_id)}`,
  );
  const status = await available(c, p, c.user.id);
  if (
    !p ||
    !status.available ||
    !(await assignmentActive(c, String(s.row.assignment_id), c.user.id))
  )
    fail('LESSON_UNAVAILABLE');
  const at = now(c),
    applied = applyAction(s.run, s.events, action, iso(at), status.policy);
  if (!applied.ok) fail(applied.error.code, applied.error.status);
  const ack = actionAck(applied, status.policy),
    eventId = id('story-event'),
    result = { event: applied.event, ack, policy: status.policy };
  const guard = `${childGuard(c, c.user.id, p)} AND ${assignmentGuard(String(s.row.assignment_id), c.user.id, String(s.row.installation_id))}`;
  const statements = [
    `UPDATE pilot_curriculum_learning_run SET run_json=${q(canonicalPackage(applied.run))},revision=${applied.run.revision},updated_at=${at} WHERE id=${q(runId)} AND revision=${s.run.revision} AND ${guard}`,
    insert(
      'pilot_curriculum_learning_event',
      {
        id: eventId,
        run_id: runId,
        event_id: action.eventId,
        sequence: applied.run.revision,
        request_digest: fingerprint,
        expected_revision: action.expectedRevision,
        action_json: canonicalPackage(action),
        result_json: canonicalPackage(result),
        server_at: at,
      },
      'changes()=1',
    ),
  ];
  if (!s.run.state.completedAt && applied.run.state.completedAt)
    statements.push(
      insert(
        'pilot_learning_schedule',
        {
          id: id('schedule'),
          assignment_id: s.row.assignment_id,
          child_id: c.user.id,
          kind: 'delayed-review',
          due_at: Date.parse(applied.run.state.completedAt) + 86400000,
          policy_version: 'r3-review-24h-1',
          created_at: at,
        },
        `EXISTS(SELECT 1 FROM pilot_curriculum_learning_event WHERE id=${q(eventId)})`,
      ),
    );
  statements.push(
    insert('pilot_curriculum_learning_audit', {
      id: id('learning-audit'),
      run_id: runId,
      plan_id: null,
      actor_id: c.user.id,
      action: 'run-action',
      event_id: eventId,
      revision: applied.run.revision,
      created_at: at,
    }),
  );
  try {
    await batch(c, statements);
  } catch {
    const raced = await one(
      c,
      `SELECT request_digest,result_json FROM pilot_curriculum_learning_event WHERE run_id=${q(runId)} AND event_id=${q(action.eventId)}`,
    );
    if (raced) {
      if (raced.request_digest !== fingerprint) fail('EVENT_CONFLICT');
      return { ack: JSON.parse(String(raced.result_json)).ack, replayed: true };
    }
    const changed = await one(
      c,
      `SELECT revision FROM pilot_curriculum_learning_run WHERE id=${q(runId)}`,
    );
    if (Number(changed?.revision) !== s.run.revision) fail('STALE_REVISION');
    if (!(await available(c, p, c.user.id)).available)
      fail('LESSON_UNAVAILABLE');
    fail('STORAGE_UNAVAILABLE', 503);
  }
  return { ack, replayed: false };
}
export async function storyPractice(
  c: StoryContext,
  childId: string,
  collectionVersion?: string,
) {
  if (collectionVersion !== undefined)
    return collectionPractice(c, childId, collectionVersion);
  await readable(c, childId);
  const schedule = await rows(
    c,
    `SELECT s.*,a.publication_id,a.installation_id,r.id AS run_id,r.run_json FROM pilot_learning_schedule s JOIN pilot_curriculum_assignment a ON a.id=s.assignment_id LEFT JOIN pilot_curriculum_learning_run r ON r.assignment_id=a.id WHERE s.child_id=${q(childId)} ORDER BY s.due_at,s.id`,
  );
  const items: PracticeItem[] = [];
  for (const s of schedule) {
    const run = s.run_json
      ? (JSON.parse(String(s.run_json)) as StoryRun)
      : null;
    if (
      (s.kind === 'initial' && run?.state.completedAt) ||
      (s.kind === 'delayed-review' && run?.state.reviewCompletedAt)
    )
      continue;
    const p = await one(
        c,
        `SELECT * FROM pilot_curriculum_publication WHERE id=${q(s.publication_id)}`,
      ),
      status = await available(c, p, childId),
      active = await assignmentActive(c, String(s.assignment_id), childId);
    items.push({
      assignmentId: String(s.assignment_id),
      runId: s.run_id ? String(s.run_id) : null,
      lessonVersion: VERSION,
      publicationId: String(s.publication_id),
      kind: s.kind as PracticeItem['kind'],
      dueAt: iso(s.due_at),
      available:
        status.available &&
        active &&
        (s.kind === 'initial' || Number(s.due_at) <= now(c)),
      reason:
        status.reason ??
        (!active
          ? 'A newer approved plan is available.'
          : s.kind === 'delayed-review' && Number(s.due_at) > now(c)
            ? 'Review is not due yet.'
            : null),
      stepId: run?.state.stepId ?? null,
    });
  }
  return { items };
}
export async function storyProgress(c: StoryContext, childId: string) {
  await readable(c, childId);
  const installed = await one(
    c,
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='pilot_curriculum_learning_run'",
  );
  if (Number(installed?.n) === 0)
    return {
      schemaVersion: 'r3-family-progress-1' as const,
      installationId: await installation(c),
      childId,
      plans: [],
      practice: [],
      runs: [],
      evidenceLimits: ['No ordinary curriculum plan has been approved.'],
    };
  const plans = await storyPlans(c, childId),
    practice = await storyPractice(c, childId),
    runRows = await rows(
      c,
      `SELECT id FROM pilot_curriculum_learning_run WHERE child_id=${q(childId)} ORDER BY created_at,id`,
    );
  return {
    schemaVersion: 'r3-family-progress-1' as const,
    installationId: await installation(c),
    childId,
    plans: plans.history,
    practice: practice.items,
    runs: await Promise.all(runRows.map((r) => getStoryRun(c, String(r.id)))),
    evidenceLimits: [
      'Synthetic verification is not actual child evidence or human acceptance.',
      'These responses do not establish mastery or fluency.',
    ],
  };
}
