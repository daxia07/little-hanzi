import { inspectJson } from '../curriculum/json.ts';
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import { exact, digest, text } from '../curriculum/story-package.ts';
import {
  compilePairedRuntime,
  createPairedRun,
  applyPairedAction,
  projectPairedRun,
  validatePairedRun,
  type CompiledPairedLesson,
} from '../curriculum/paired-runtime.ts';
import type { PairedRun } from '../curriculum/paired-types.ts';
import { hasCompleteCurriculumProvenance } from '../curriculum/review.ts';
import type { PilotSessionContext } from './http.ts';
import { fail, StoryError } from './story-policy.ts';
import {
  parseCollectionScope,
  verifyCollectionProof,
  validCollectionReceipt,
  validateCollectionManifest,
  validateCollectionPackages,
  collectionRequest,
  collectionSeed,
  type TrialScope,
} from './collection-policy.ts';
import {
  operationRequest,
  operationDigest,
  publicationAck,
} from './story-identity.ts';
import type {
  CollectionRunView,
  CollectionLibraryItem,
  CollectionProposal,
  CollectionPlan,
  CollectionPracticeItem,
  CollectionProgress,
} from '../curriculum/collection-types.ts';
export type CollectionContext = Pick<
  PilotSessionContext,
  'config' | 'db' | 'user' | 'session'
>;
type Row = Record<string, string | number | null>;
const q = (v: unknown): string => {
  if (v === null) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return "'" + v.replaceAll("'", "''") + "'";
  fail('STORAGE_UNAVAILABLE', 503);
};
const id = (kind: string) => `${kind}-${crypto.randomUUID()}`;
const iso = (v: unknown) => new Date(Number(v)).toISOString();
function now(c: CollectionContext): number {
  if (c.config.testMode && c.config.curriculumTestNow) {
    const n = Number(c.config.curriculumTestNow);
    if (!Number.isSafeInteger(n) || n < 0) fail('STORAGE_UNAVAILABLE', 503);
    return n;
  }
  return Date.now();
}
async function one(c: CollectionContext, sql: string): Promise<Row | null> {
  try {
    return await c.db.prepare(sql).first<Row>();
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
async function rows(c: CollectionContext, sql: string): Promise<Row[]> {
  try {
    return (await c.db.prepare(sql).all<Row>()).results ?? [];
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
async function batch(c: CollectionContext, sql: string[]) {
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
function actorGuard(c: CollectionContext, role?: string) {
  const sessionId = typeof c.session.id === 'string' ? c.session.id : '';
  return `EXISTS(SELECT 1 FROM pilot_auth_user u JOIN pilot_auth_session s ON s.user_id=u.id WHERE u.id=${q(c.user.id)} AND s.id=${q(sessionId)} AND s.expires_at>${now(c)} AND u.disabled=0 AND u.must_change_password=0 ${`AND u.role=${q(role ?? c.user.role)}`})`;
}
function parentGuard(c: CollectionContext, childId: string) {
  return `${actorGuard(c, 'parent')} AND EXISTS(SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.parent_id=${q(c.user.id)} AND l.child_id=${q(childId)} AND u.role='child' AND u.disabled=0 AND u.must_change_password=0)`;
}
async function requireActor(c: CollectionContext, role?: string) {
  if (role && c.user.role !== role) fail('FORBIDDEN', 403);
  if (!(await one(c, `SELECT 1 AS ok WHERE ${actorGuard(c, role)}`)))
    fail('UNAUTHORIZED', 401);
}
async function readable(c: CollectionContext, childId: string) {
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
      `SELECT 1 FROM pilot_teacher_grant g JOIN pilot_parent_child l ON l.parent_id=g.granting_parent_id AND l.child_id=g.child_id JOIN pilot_auth_user p ON p.id=l.parent_id WHERE g.teacher_id=${q(c.user.id)} AND g.child_id=${q(childId)} AND p.role='parent' AND p.disabled=0 AND p.must_change_password=0`,
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
async function parent(c: CollectionContext, childId: string) {
  await requireActor(c, 'parent');
  if (!(await one(c, `SELECT 1 WHERE ${parentGuard(c, childId)}`)))
    fail('NOT_FOUND', 404);
}
async function installation(c: CollectionContext) {
  const r = await one(
    c,
    'SELECT installation_id FROM pilot_installation WHERE id=1',
  );
  if (!r || !text(r.installation_id, 240)) fail('STORAGE_UNAVAILABLE', 503);
  return r.installation_id;
}
async function lesson(
  c: CollectionContext,
  version: string,
): Promise<{
  row: Row;
  compiled: CompiledPairedLesson;
  package: Record<string, unknown>;
}> {
  if (!/^path-(?:0[1-9]|10)-v[1-9][0-9]*$/.test(version))
    fail('NOT_FOUND', 404);
  const r = await one(
    c,
    `SELECT * FROM pilot_curriculum_package WHERE lesson_version=${q(version)}`,
  );
  if (!r) fail('NOT_FOUND', 404);
  try {
    const p = JSON.parse(String(r.manifest_json));
    const compiled = await compilePairedRuntime(p);
    if (
      canonicalPackage(p) !== r.manifest_json ||
      compiled.identity.contentDigest !== r.content_digest
    )
      fail('STORAGE_UNAVAILABLE', 503);
    return { row: r, compiled, package: p };
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
async function capability(
  c: CollectionContext,
  install: string,
  content: string,
) {
  const cap = c.config.collectionCapability,
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
    cap.namespace !== c.config.testRunId
  )
    return null;
  if (
    !(await one(
      c,
      `SELECT 1 FROM pilot_collection_item i JOIN pilot_collection x ON x.collection_version=i.collection_version WHERE i.collection_version=${q(cap.collectionVersion)} AND i.collection_digest=${q(cap.collectionDigest)} AND x.collection_digest=${q(cap.collectionDigest)} AND i.content_digest=${q(content)}`,
    ))
  )
    return null;
  return cap;
}
async function latest(c: CollectionContext, version: string) {
  const install = await installation(c);
  return one(
    c,
    `SELECT p.* FROM pilot_curriculum_publication_state s JOIN pilot_curriculum_publication p ON p.id=s.latest_publication_id WHERE s.installation_id=${q(install)} AND s.lesson_version=${q(version)}`,
  );
}
async function members(
  c: CollectionContext,
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
    planScope: String(r.plan_scope),
  }));
}
async function available(
  c: CollectionContext,
  p: Row | null,
  childId?: string,
): Promise<{
  available: boolean;
  reason: string | null;
  policy: { soundReview: 'pending' | 'reviewed' | 'synthetic' };
}> {
  const denied = (reason: string) => ({
    available: false,
    reason,
    policy: { soundReview: 'pending' as const },
  });
  if (!p) return denied('No approved lesson is available.');
  const current = await latest(c, String(p.lesson_version));
  if (!current || current.id !== p.id || p.status !== 'released')
    return denied('This lesson is no longer available.');
  const install = await installation(c);
  const bound = await lesson(c, String(p.lesson_version));
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
  if (m.some((x) => x.planScope !== p.lesson_version))
    return denied('This lesson scope does not match its package.');
  if (childId && !m.some((x) => x.childId === childId))
    return denied('This lesson is not assigned to this child.');
  if (p.scope_kind === 'verification') {
    const cap = await capability(c, install, String(p.content_digest));
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
    `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(p.lesson_version)} ORDER BY review_sequence DESC LIMIT 1`,
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
    const result = await verifyCollectionProof(
      JSON.parse(String(proof.receipt_json)),
      proof.signature,
      c.config.curriculumTrust ?? null,
      {
        installationId: install,
        contentDigest: String(p.content_digest),
        lessonVersion: String(p.lesson_version),
      },
      now(c),
    );
    if (
      result.issuer.purpose !== 'release' ||
      result.receiptDigest !== proof.receipt_digest
    )
      return denied('This lesson proof is unavailable.');
    if (
      !hasCompleteCurriculumProvenance(
        bound.package as unknown as Parameters<
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
function publicationGuard(c: CollectionContext, p: Row) {
  let guard = `EXISTS(SELECT 1 FROM pilot_curriculum_publication_state s JOIN pilot_curriculum_publication p ON p.id=s.latest_publication_id WHERE s.installation_id=${q(p.installation_id)} AND s.lesson_version=${q(p.lesson_version)} AND p.id=${q(p.id)} AND p.status='released') AND EXISTS(SELECT 1 FROM pilot_installation WHERE id=1 AND installation_id=${q(p.installation_id)})`;
  if (p.scope_kind === 'supervised-trial')
    guard += ` AND EXISTS(SELECT 1 FROM pilot_curriculum_review r WHERE r.review_id=${q(p.review_id)} AND r.decision='approved' AND r.test_run_id IS NULL AND r.review_sequence=(SELECT MAX(review_sequence) FROM pilot_curriculum_review WHERE lesson_version=${q(p.lesson_version)}))`;
  return guard;
}
function childGuard(c: CollectionContext, childId: string, p: Row) {
  return `${actorGuard(c, 'child')} AND ${q(c.user.id)}=${q(childId)} AND ${publicationGuard(c, p)} AND EXISTS(SELECT 1 FROM pilot_curriculum_trial_member m JOIN pilot_parent_child l ON l.child_id=m.child_id AND l.parent_id=m.parent_id JOIN pilot_auth_user u ON u.id=m.parent_id WHERE m.publication_id=${q(p.id)} AND m.child_id=${q(childId)} AND u.role='parent' AND u.disabled=0 AND u.must_change_password=0)`;
}
export async function submitCollectionProof(
  c: CollectionContext,
  input: unknown,
) {
  input = plainInput(input);

  await requireActor(c, 'operator');
  if (!exact(input, ['receipt', 'signature'])) fail('INVALID_REQUEST', 400);
  if (!validCollectionReceipt(input.receipt)) fail('PROOF_INVALID');
  const version = input.receipt.lessonVersion;
  const bound = await lesson(c, version),
    install = await installation(c);
  if (!validCollectionReceipt(input.receipt)) fail('PROOF_INVALID');
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
      await verifyCollectionProof(
        r,
        input.signature,
        c.config.curriculumTrust ?? null,
        {
          installationId: install,
          contentDigest: bound.compiled.identity.contentDigest,
          lessonVersion: version,
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
  const checked = await verifyCollectionProof(
    r,
    input.signature,
    c.config.curriculumTrust ?? null,
    {
      installationId: install,
      contentDigest: bound.compiled.identity.contentDigest,
      lessonVersion: version,
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
export async function recordCollectionOwner(
  c: CollectionContext,
  version: string,
  input: unknown,
) {
  input = plainInput(input);

  await requireActor(c, 'operator');
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
  const scope = parseCollectionScope(input.scope, version),
    request = { ...input, scope };
  const install = await installation(c),
    bound = await lesson(c, version);
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
      !(await capability(c, install, bound.compiled.identity.contentDigest)))
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
async function linkedMembers(c: CollectionContext, m: TrialScope['members']) {
  for (const v of m)
    if (
      !(await one(
        c,
        `SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.parent_id=${q(v.parentId)} AND l.child_id=${q(v.childId)} AND p.role='parent' AND p.disabled=0 AND p.must_change_password=0 AND u.role='child' AND u.disabled=0 AND u.must_change_password=0`,
      ))
    )
      fail('RELEASE_SCOPE_INVALID');
}
export async function publishCollection(
  c: CollectionContext,
  version: string,
  input: unknown,
  bootstrap = false,
) {
  input = plainInput(input);

  await requireActor(c, 'operator');
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
  const scope = parseCollectionScope(input.scope, version),
    request = { ...input, scope };
  const install = await installation(c),
    bound = await lesson(c, version),
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
  const head = await latest(c, version);
  if (
    Number(input.expectedRevision) !== Number(head?.generation ?? 0) ||
    input.predecessorId !== (head?.id ?? null)
  )
    fail('STALE_REVISION');
  if (input.contentDigest !== bound.compiled.identity.contentDigest)
    fail('RELEASE_IDENTITY_MISMATCH');
  const verification = !!(await capability(
    c,
    install,
    String(input.contentDigest),
  ));
  let reviewId = input.reviewId,
    proofId = input.proofId,
    ownerId = input.ownerDecisionId;
  if (input.status === 'released') {
    if (!trust) fail('RELEASE_UNAVAILABLE');
    await linkedMembers(c, scope.members);
    if (bootstrap) {
      const cap = await capability(c, install, String(input.contentDigest));
      if (
        !cap ||
        scope.members.some(
          (m) =>
            !cap.childIds.includes(m.childId) ||
            !cap.parentIds.includes(m.parentId),
        )
      )
        fail('RELEASE_SCOPE_INVALID');
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
      const result = await verifyCollectionProof(
        JSON.parse(String(proof.receipt_json)),
        proof.signature,
        trust,
        {
          installationId: install,
          contentDigest: String(input.contentDigest),
          lessonVersion: version,
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
          bound.package as unknown as Parameters<
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
    const current = await latest(c, version);
    if ((current?.id ?? null) !== (head?.id ?? null)) fail('STALE_REVISION');
    throw new StoryError('STORAGE_UNAVAILABLE', 503);
  }
  return ack;
}
async function registered(c: CollectionContext, version: string) {
  if (!text(version, 80)) fail('INVALID_REQUEST', 400);
  const r = await one(
    c,
    `SELECT * FROM pilot_collection WHERE collection_version=${q(version)}`,
  );
  if (!r) fail('INVALID_REQUEST', 400);
  const manifest = validateCollectionManifest(
    JSON.parse(String(r.manifest_json)),
  );
  if (
    canonicalPackage(manifest) !== r.manifest_json ||
    (await curriculumDigest(manifest)) !== r.collection_digest
  )
    fail('STORAGE_UNAVAILABLE', 503);
  const items = await rows(
    c,
    `SELECT * FROM pilot_collection_item WHERE collection_version=${q(version)} ORDER BY ordinal`,
  );
  if (
    items.length !== 10 ||
    items.some(
      (x, i) =>
        x.lesson_version !== manifest.items[i].lessonVersion ||
        x.content_digest !== manifest.items[i].contentDigest ||
        Number(x.sequence) !== i + 1 ||
        x.collection_digest !== r.collection_digest ||
        x.prerequisites_json !== '[]',
    )
  )
    fail('STORAGE_UNAVAILABLE', 503);
  await validateCollectionPackages(
    manifest,
    await Promise.all(
      manifest.items.map(
        async (entry) => (await lesson(c, entry.lessonVersion)).package,
      ),
    ),
  );
  return { row: r, manifest, items };
}
function collectionIdentity(x: Row) {
  return {
    collectionId: String(x.collection_id),
    collectionVersion: String(x.collection_version),
    collectionDigest: String(x.collection_digest),
  };
}
export async function importCollection(c: CollectionContext, input: unknown) {
  input = plainInput(input);
  await requireActor(c, 'operator');
  if (!exact(input, ['collection'])) fail('INVALID_REQUEST', 400);
  const manifest = validateCollectionManifest(input.collection),
    fingerprint = await curriculumDigest(manifest),
    existing = await one(
      c,
      `SELECT * FROM pilot_collection WHERE collection_version=${q(manifest.collectionVersion)}`,
    );
  if (existing) {
    if (existing.collection_digest !== fingerprint) fail('COLLECTION_CONFLICT');
    await registered(c, manifest.collectionVersion);
    return {
      collectionVersion: manifest.collectionVersion,
      collectionDigest: fingerprint,
    };
  }
  await validateCollectionPackages(
    manifest,
    await Promise.all(
      manifest.items.map(
        async (entry) => (await lesson(c, entry.lessonVersion)).package,
      ),
    ),
  );
  const bindings = [];
  for (const entry of manifest.items) {
    const l = await lesson(c, entry.lessonVersion);
    if (l.compiled.identity.contentDigest !== entry.contentDigest)
      fail('COLLECTION_IDENTITY_MISMATCH');
    bindings.push(
      `EXISTS(SELECT 1 FROM pilot_curriculum_package WHERE lesson_version=${q(entry.lessonVersion)} AND content_digest=${q(entry.contentDigest)})`,
    );
  }
  const at = now(c);
  await batch(c, [
    insert(
      'pilot_collection',
      {
        collection_version: manifest.collectionVersion,
        collection_id: manifest.collectionId,
        collection_digest: fingerprint,
        canonicalization_version: manifest.canonicalizationVersion,
        manifest_json: canonicalPackage(manifest),
        imported_by: c.user.id,
        imported_at: at,
      },
      `${actorGuard(c, 'operator')} AND ${bindings.join(' AND ')}`,
    ),
    ...manifest.items.map((x) =>
      insert('pilot_collection_item', {
        collection_version: manifest.collectionVersion,
        collection_digest: fingerprint,
        ordinal: x.sequence - 1,
        lesson_version: x.lessonVersion,
        content_digest: x.contentDigest,
        track_id: manifest.trackId,
        sequence: x.sequence,
        prerequisites_json: canonicalPackage(x.introductionPrerequisites),
      }),
    ),
  ]);
  return {
    collectionVersion: manifest.collectionVersion,
    collectionDigest: fingerprint,
  };
}
export async function listCollections(c: CollectionContext) {
  await requireActor(c, 'operator');
  return {
    items: await Promise.all(
      (
        await rows(
          c,
          'SELECT * FROM pilot_collection ORDER BY imported_at DESC,collection_version LIMIT 100',
        )
      ).map(async (r) => {
        const x = await registered(c, String(r.collection_version));
        return {
          ...collectionIdentity(r),
          trackId: x.manifest.trackId,
          lessonCount: x.items.length,
          importedAt: iso(r.imported_at),
        };
      }),
    ),
  };
}
async function libraryItem(
  c: CollectionContext,
  reg: Awaited<ReturnType<typeof registered>>,
  entry: Row,
  p: Row | null,
  assignment: Row | null,
): Promise<CollectionLibraryItem> {
  const l = await lesson(c, String(entry.lesson_version)),
    status = await available(
      c,
      p,
      assignment ? String(assignment.child_id) : undefined,
    );
  const pkg = l.package as unknown as {
    title: string;
    characters: Array<{ characterId: string; hanzi: string }>;
  };
  return {
    ...collectionIdentity(reg.row),
    ...l.compiled.identity,
    title: pkg.title,
    targets: pkg.characters.map((x) => ({
      characterId: x.characterId,
      hanzi: x.hanzi,
    })),
    trackId: String(entry.track_id),
    sequence: Number(entry.sequence),
    publicationId: p ? String(p.id) : null,
    generation: p ? Number(p.generation) : null,
    available: status.available,
    reason: status.reason,
    assignmentId: assignment ? String(assignment.id) : null,
    completed: !!(
      assignment &&
      (await one(
        c,
        `SELECT 1 FROM pilot_collection_run WHERE assignment_id=${q(assignment.id)} AND phase='initial' AND completed_at IS NOT NULL`,
      ))
    ),
  };
}
export async function collectionLibrary(
  c: CollectionContext,
  childId: string,
  version: string,
) {
  await readable(c, childId);
  const reg = await registered(c, version),
    items: CollectionLibraryItem[] = [];
  for (const entry of reg.items) {
    const history = await rows(
      c,
      `SELECT * FROM pilot_collection_assignment WHERE child_id=${q(childId)} AND collection_version=${q(version)} ORDER BY created_at,id`,
    );
    const assignments = history.filter(
      (x) => x.lesson_version === entry.lesson_version,
    );
    if (c.user.role === 'parent') {
      const p = await latest(c, String(entry.lesson_version)),
        status = await available(c, p, childId),
        m = p ? await members(c, String(p.id)) : [];
      if (
        status.available &&
        m.some((x) => x.childId === childId && x.parentId === c.user.id)
      )
        items.push(
          await libraryItem(c, reg, entry, p, assignments.at(-1) ?? null),
        );
    }
    for (const a of assignments) {
      if (
        c.user.role === 'parent' &&
        items.some((x) => x.assignmentId === a.id)
      )
        continue;
      const p = await one(
        c,
        `SELECT * FROM pilot_curriculum_publication WHERE id=${q(a.publication_id)}`,
      );
      items.push(await libraryItem(c, reg, entry, p, a));
    }
  }
  return { items };
}
async function currentProposal(
  c: CollectionContext,
  childId: string,
  version: string,
) {
  return one(
    c,
    `SELECT * FROM pilot_collection_proposal WHERE child_id=${q(childId)} AND installation_id=${q(await installation(c))} AND collection_version=${q(version)} ORDER BY selection_ordinal DESC LIMIT 1`,
  );
}
async function sourceFacts(
  c: CollectionContext,
  childId: string,
  reg: Awaited<ReturnType<typeof registered>>,
) {
  const install = await installation(c),
    onboarding = await one(
      c,
      `SELECT nickname,experience,audio_ready,updated_at,updated_by FROM pilot_onboarding WHERE child_id=${q(childId)}`,
    );
  if (!onboarding) fail('ONBOARDING_REQUIRED');
  const legacyEvents = await rows(
      c,
      `SELECT e.run_id,e.event_id,e.sequence,e.result_json,e.server_at FROM pilot_curriculum_learning_event e JOIN pilot_curriculum_learning_run r ON r.id=e.run_id WHERE r.child_id=${q(childId)} AND r.installation_id=${q(install)} ORDER BY e.run_id,e.sequence`,
    ),
    events = await rows(
      c,
      `SELECT e.run_id,e.event_id,e.sequence,e.result_json,e.server_at FROM pilot_collection_event e JOIN pilot_collection_run r ON r.id=e.run_id WHERE r.child_id=${q(childId)} AND r.installation_id=${q(install)} ORDER BY e.run_id,e.sequence`,
    ),
    completion = await rows(
      c,
      `SELECT id,assignment_id,phase,completed_at,revision FROM pilot_collection_run WHERE child_id=${q(childId)} AND installation_id=${q(install)} ORDER BY id`,
    ),
    publications = [];
  for (const entry of reg.items) {
    const p = await latest(c, String(entry.lesson_version)),
      review = await one(
        c,
        `SELECT review_id,review_sequence,decision,content_digest,test_run_id FROM pilot_curriculum_review WHERE lesson_version=${q(entry.lesson_version)} ORDER BY review_sequence DESC LIMIT 1`,
      );
    publications.push({
      lessonVersion: entry.lesson_version,
      contentDigest: entry.content_digest,
      head: p,
      review,
      members: p ? await members(c, String(p.id)) : [],
      eligible: (await available(c, p, childId)).available,
    });
  }
  const revision = await one(
    c,
    'SELECT revision FROM pilot_curriculum_registry_state WHERE id=1',
  );
  return {
    install,
    onboarding,
    evidence: { legacyEvents, events, completion },
    publications,
    registryRevision: Number(revision?.revision ?? 0),
    onboardingDigest: await curriculumDigest(onboarding),
    evidenceDigest: await curriculumDigest({
      legacyEvents,
      events,
      completion,
    }),
    publicationDigest: await curriculumDigest({
      publications,
      registryRevision: Number(revision?.revision ?? 0),
    }),
  };
}
async function makeSource(
  c: CollectionContext,
  childId: string,
  reg: Awaited<ReturnType<typeof registered>>,
  p: Row,
  selection: {
    ordinal: number;
    predecessorId: string | null;
    predecessorSource: string | null;
    selected: boolean;
    actorId: string;
    at: number;
  },
) {
  const facts = await sourceFacts(c, childId, reg),
    reason = selection.selected
      ? 'You chose this eligible starting lesson. Saved responses and setup do not establish mastery.'
      : 'This is the lowest-sequence eligible unfinished lesson. Familiarity checks will guide each introduction; setup does not establish mastery.';
  return {
    facts,
    source: {
      schemaVersion: 'r5-placement-source-1',
      policyVersion: 'r5-placement-1',
      childId,
      installationId: facts.install,
      collectionVersion: reg.row.collection_version,
      collectionDigest: reg.row.collection_digest,
      actorId: selection.actorId,
      selectionOrdinal: selection.ordinal,
      predecessorProposalId: selection.predecessorId,
      predecessorSourceDigest: selection.predecessorSource,
      lessonVersion: p.lesson_version,
      contentDigest: p.content_digest,
      publicationId: p.id,
      generation: Number(p.generation),
      selectedByParent: selection.selected,
      onboardingDigest: facts.onboardingDigest,
      evidenceDigest: facts.evidenceDigest,
      publicationDigest: facts.publicationDigest,
      reason,
      createdAt: selection.at,
    },
  };
}
function sourceGuard(
  c: CollectionContext,
  childId: string,
  reg: Awaited<ReturnType<typeof registered>>,
  facts: Awaited<ReturnType<typeof sourceFacts>>,
) {
  let guard = `EXISTS(SELECT 1 FROM pilot_installation WHERE id=1 AND installation_id=${q(facts.install)}) AND EXISTS(SELECT 1 FROM pilot_collection WHERE collection_version=${q(reg.row.collection_version)} AND collection_digest=${q(reg.row.collection_digest)}) AND EXISTS(SELECT 1 FROM pilot_onboarding WHERE child_id=${q(childId)} AND nickname=${q(facts.onboarding.nickname)} AND experience=${q(facts.onboarding.experience)} AND audio_ready=${q(facts.onboarding.audio_ready)} AND updated_at=${q(facts.onboarding.updated_at)} AND updated_by=${q(facts.onboarding.updated_by)}) AND EXISTS(SELECT 1 FROM pilot_curriculum_registry_state WHERE id=1 AND revision=${facts.registryRevision})`;
  const eventFacts = [
    [
      'pilot_curriculum_learning_event',
      'pilot_curriculum_learning_run',
      facts.evidence.legacyEvents,
    ],
    ['pilot_collection_event', 'pilot_collection_run', facts.evidence.events],
  ] as const;
  for (const [table, runs, ev] of eventFacts)
    guard += ` AND (SELECT count(*) FROM ${table} e JOIN ${runs} r ON r.id=e.run_id WHERE r.child_id=${q(childId)} AND r.installation_id=${q(facts.install)})=${ev.length}`;
  for (const snapshot of facts.publications) {
    const p = snapshot.head;
    if (p)
      guard += ` AND EXISTS(SELECT 1 FROM pilot_curriculum_publication_state WHERE installation_id=${q(facts.install)} AND lesson_version=${q(snapshot.lessonVersion)} AND latest_publication_id=${q(p.id)} AND revision=${q(p.generation)})`;
    else
      guard += ` AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_publication_state WHERE installation_id=${q(facts.install)} AND lesson_version=${q(snapshot.lessonVersion)})`;
    if (snapshot.review)
      guard += ` AND EXISTS(SELECT 1 FROM pilot_curriculum_review WHERE review_id=${q(snapshot.review.review_id)} AND review_sequence=(SELECT MAX(review_sequence) FROM pilot_curriculum_review WHERE lesson_version=${q(snapshot.lessonVersion)}))`;
    else
      guard += ` AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_review WHERE lesson_version=${q(snapshot.lessonVersion)})`;
  }
  return guard;
}
function proposalDTO(
  reg: Awaited<ReturnType<typeof registered>>,
  r: Row,
): CollectionProposal {
  return {
    ...collectionIdentity(reg.row),
    lessonId: String(r.lesson_version).replace(/-v\d+$/, ''),
    lessonVersion: String(r.lesson_version),
    contentDigest: String(r.content_digest),
    adapterId: 'paired-story',
    adapterVersion: 'paired-story-v1',
    proposalId: String(r.id),
    childId: String(r.child_id),
    installationId: String(r.installation_id),
    predecessorProposalId:
      r.predecessor_id === null ? null : String(r.predecessor_id),
    selectionOrdinal: Number(r.selection_ordinal),
    publicationId: String(r.publication_id),
    generation: Number(JSON.parse(String(r.source_json)).generation),
    sourceDigest: String(r.source_digest),
    reason: JSON.parse(String(r.reason_json)).text,
    selectedByParent: r.selected_by_parent === 1,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
  };
}
export async function proposeCollection(
  c: CollectionContext,
  childId: string,
  input: unknown,
) {
  input = plainInput(input);
  await parent(c, childId);
  if (
    !exact(input, [
      'collectionVersion',
      'lessonVersion',
      'predecessorProposalId',
      'expectedSourceDigest',
    ]) ||
    !text(input.collectionVersion, 80) ||
    !(input.lessonVersion === null || text(input.lessonVersion, 80)) ||
    !(
      input.predecessorProposalId === null ||
      text(input.predecessorProposalId, 120)
    ) ||
    !(input.expectedSourceDigest === null || digest(input.expectedSourceDigest))
  )
    fail('INVALID_REQUEST', 400);
  const reg = await registered(c, input.collectionVersion),
    current = await currentProposal(c, childId, input.collectionVersion),
    install = await installation(c),
    request = collectionRequest('proposal', c.user.id, install, childId, input),
    fingerprint = await curriculumDigest(request);
  if (
    current &&
    current.request_digest === fingerprint &&
    Number(current.expires_at) > now(c)
  ) {
    const p = await one(
      c,
      `SELECT * FROM pilot_curriculum_publication WHERE id=${q(current.publication_id)}`,
    );
    if (p) {
      const next = await makeSource(c, childId, reg, p, {
        ordinal: Number(current.selection_ordinal),
        predecessorId: current.predecessor_id as string | null,
        predecessorSource: current.predecessor_source_digest as string | null,
        selected: current.selected_by_parent === 1,
        actorId: String(current.actor_id),
        at: Number(current.created_at),
      });
      if (
        (await curriculumDigest(next.source)) === current.source_digest &&
        (await available(c, p, childId)).available
      )
        return { proposal: proposalDTO(reg, current) };
    }
  }
  if (
    input.predecessorProposalId !== (current?.id ?? null) ||
    input.expectedSourceDigest !== (current?.source_digest ?? null)
  )
    fail('PLACEMENT_STALE');
  const choices = (
    await collectionLibrary(c, childId, input.collectionVersion)
  ).items.filter((x) => x.available && !x.completed);
  const chosen =
    input.lessonVersion === null
      ? choices[0]
      : choices.find((x) => x.lessonVersion === input.lessonVersion);
  if (!chosen || !chosen.publicationId) fail('PLACEMENT_UNAVAILABLE');
  const p = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE id=${q(chosen.publicationId)}`,
  );
  if (!p) fail('PLACEMENT_UNAVAILABLE');
  const at = now(c),
    { source, facts } = await makeSource(c, childId, reg, p, {
      ordinal: Number(current?.selection_ordinal ?? 0) + 1,
      predecessorId: current ? String(current.id) : null,
      predecessorSource: current ? String(current.source_digest) : null,
      selected: input.lessonVersion !== null,
      actorId: c.user.id,
      at,
    });
  if (
    current &&
    current.lesson_version === chosen.lessonVersion &&
    Number(current.expires_at) > at
  ) {
    const old = JSON.parse(String(current.source_json));
    if (
      old.onboardingDigest === source.onboardingDigest &&
      old.evidenceDigest === source.evidenceDigest &&
      old.publicationDigest === source.publicationDigest
    )
      return { proposal: proposalDTO(reg, current) };
  }
  const proposalId = id('collection-proposal'),
    r = {
      id: proposalId,
      child_id: childId,
      installation_id: install,
      collection_version: reg.row.collection_version,
      collection_digest: reg.row.collection_digest,
      selection_ordinal: source.selectionOrdinal,
      predecessor_id: source.predecessorProposalId,
      predecessor_source_digest: source.predecessorSourceDigest,
      selected_by_parent: source.selectedByParent ? 1 : 0,
      actor_id: c.user.id,
      policy_version: source.policyVersion,
      source_digest: await curriculumDigest(source),
      source_json: canonicalPackage(source),
      onboarding_digest: source.onboardingDigest,
      evidence_digest: source.evidenceDigest,
      publication_digest: source.publicationDigest,
      publication_id: p.id,
      lesson_version: p.lesson_version,
      content_digest: p.content_digest,
      reason_json: canonicalPackage({ text: source.reason }),
      request_json: canonicalPackage(request),
      request_digest: fingerprint,
      created_at: at,
      expires_at: at + 86400000,
      test_run_id: p.test_run_id,
    };
  const selectionGuard = current
    ? `NOT EXISTS(SELECT 1 FROM pilot_collection_proposal WHERE predecessor_id=${q(current.id)})`
    : `NOT EXISTS(SELECT 1 FROM pilot_collection_proposal WHERE child_id=${q(childId)} AND installation_id=${q(install)} AND collection_version=${q(reg.row.collection_version)})`;
  await batch(c, [
    insert(
      'pilot_collection_proposal',
      r,
      `${parentGuard(c, childId)} AND ${publicationGuard(c, p)} AND ${sourceGuard(c, childId, reg, facts)} AND ${selectionGuard}`,
    ),
  ]);
  if (
    !(await one(
      c,
      `SELECT 1 FROM pilot_collection_proposal WHERE id=${q(proposalId)}`,
    ))
  )
    fail('PLACEMENT_STALE');
  return { proposal: proposalDTO(reg, r) };
}
async function proposalCurrent(
  c: CollectionContext,
  r: Row,
  reg: Awaited<ReturnType<typeof registered>>,
) {
  const p = await one(
      c,
      `SELECT * FROM pilot_curriculum_publication WHERE id=${q(r.publication_id)}`,
    ),
    current = await currentProposal(
      c,
      String(r.child_id),
      String(r.collection_version),
    );
  if (
    !p ||
    current?.id !== r.id ||
    Number(r.expires_at) <= now(c) ||
    (await available(c, p, String(r.child_id))).available !== true
  )
    return null;
  const result = await makeSource(c, String(r.child_id), reg, p, {
    ordinal: Number(r.selection_ordinal),
    predecessorId: r.predecessor_id as string | null,
    predecessorSource: r.predecessor_source_digest as string | null,
    selected: r.selected_by_parent === 1,
    actorId: String(r.actor_id),
    at: Number(r.created_at),
  });
  return (await curriculumDigest(result.source)) === r.source_digest
    ? { ...result, p }
    : null;
}
export async function collectionPlacement(
  c: CollectionContext,
  childId: string,
  version: string,
) {
  await readable(c, childId);
  const reg = await registered(c, version),
    r = await currentProposal(c, childId, version),
    setup = !!(await one(
      c,
      `SELECT 1 FROM pilot_onboarding WHERE child_id=${q(childId)}`,
    ));
  return {
    setupComplete: setup,
    proposal: r ? proposalDTO(reg, r) : null,
    reason: !setup
      ? 'Prepare this child’s setup first.'
      : r && !(await proposalCurrent(c, r, reg))
        ? 'This suggestion needs to be refreshed.'
        : null,
  };
}
async function planDTO(c: CollectionContext, r: Row): Promise<CollectionPlan> {
  const reg = await registered(c, String(r.collection_version)),
    items = [];
  for (const item of await rows(
    c,
    `SELECT * FROM pilot_collection_plan_item WHERE plan_id=${q(r.id)} ORDER BY ordinal`,
  )) {
    const entry = reg.items.find(
      (x) => x.lesson_version === item.lesson_version,
    );
    if (!entry) fail('STORAGE_UNAVAILABLE', 503);
    const assignment = await one(
        c,
        `SELECT * FROM pilot_collection_assignment WHERE plan_item_id=${q(item.id)}`,
      ),
      p = await one(
        c,
        `SELECT * FROM pilot_curriculum_publication WHERE id=${q(item.publication_id)}`,
      );
    items.push({
      ...(await libraryItem(c, reg, entry, p, assignment)),
      planItemId: String(item.id),
      ordinal: 0 as const,
    });
  }
  return {
    ...collectionIdentity(reg.row),
    planId: String(r.id),
    proposalId: String(r.proposal_id),
    childId: String(r.child_id),
    installationId: String(r.installation_id),
    approvedAt: iso(r.approved_at),
    available: items.every((x) => x.available),
    reason: items.find((x) => !x.available)?.reason ?? null,
    items,
  };
}
export async function collectionPlans(
  c: CollectionContext,
  childId: string,
  version: string,
) {
  await readable(c, childId);
  await registered(c, version);
  const install = await installation(c),
    namespace = c.config.testMode ? c.config.testRunId : null;
  // Proposal ordinals order committed selections within each immutable scope.
  // Keep restored scopes as history before the current installation's chain.
  const history = await Promise.all(
    (
      await rows(
        c,
        `SELECT p.* FROM pilot_collection_plan p JOIN pilot_collection_proposal s ON s.id=p.proposal_id WHERE p.child_id=${q(childId)} AND p.collection_version=${q(version)} ORDER BY CASE WHEN p.installation_id=${q(install)} AND p.test_run_id IS ${q(namespace)} THEN 1 ELSE 0 END,p.installation_id,p.test_run_id,s.selection_ordinal,p.id`,
      )
    ).map((r) => planDTO(c, r)),
  );
  return { plan: history.at(-1) ?? null, history };
}
export async function approveCollection(
  c: CollectionContext,
  childId: string,
  input: unknown,
) {
  input = plainInput(input);
  await parent(c, childId);
  if (
    !exact(input, ['proposalId', 'sourceDigest']) ||
    !text(input.proposalId, 120) ||
    !digest(input.sourceDigest)
  )
    fail('INVALID_REQUEST', 400);
  const install = await installation(c),
    r = await one(
      c,
      `SELECT * FROM pilot_collection_proposal WHERE id=${q(input.proposalId)} AND child_id=${q(childId)} AND installation_id=${q(install)}`,
    );
  if (!r) fail('NOT_FOUND', 404);
  if (r.source_digest !== input.sourceDigest) fail('PLACEMENT_STALE');
  const request = collectionRequest(
      'approval',
      c.user.id,
      install,
      childId,
      input,
    ),
    fingerprint = await curriculumDigest(request),
    existing = await one(
      c,
      `SELECT * FROM pilot_collection_plan WHERE proposal_id=${q(r.id)}`,
    );
  if (existing) {
    if (existing.request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return { plan: await planDTO(c, existing) };
  }
  const reg = await registered(c, String(r.collection_version)),
    fresh = await proposalCurrent(c, r, reg);
  if (!fresh) fail('PLACEMENT_STALE');
  const membership = await members(c, String(fresh.p.id));
  if (
    !membership.some((x) => x.childId === childId && x.parentId === c.user.id)
  )
    fail('PLACEMENT_STALE');
  const at = now(c),
    planId = id('collection-plan'),
    itemId = id('collection-item'),
    assignmentId = id('collection-assignment'),
    plan = {
      id: planId,
      proposal_id: r.id,
      child_id: childId,
      installation_id: install,
      collection_version: r.collection_version,
      collection_digest: r.collection_digest,
      parent_id: c.user.id,
      policy_version: 'r5-placement-1',
      source_digest: r.source_digest,
      request_json: canonicalPackage(request),
      request_digest: fingerprint,
      ack_json: canonicalPackage({
        planId,
        proposalId: r.id,
        sourceDigest: r.source_digest,
        approvedAt: iso(at),
      }),
      approved_at: at,
      test_run_id: r.test_run_id,
    },
    guard = `${parentGuard(c, childId)} AND ${publicationGuard(c, fresh.p)} AND ${sourceGuard(c, childId, reg, fresh.facts)} AND NOT EXISTS(SELECT 1 FROM pilot_collection_proposal WHERE predecessor_id=${q(r.id)}) AND ${at}<${Number(r.expires_at)}`;
  try {
    await batch(c, [
      insert('pilot_collection_plan', plan, guard),
      insert('pilot_collection_plan_item', {
        id: itemId,
        plan_id: planId,
        child_id: childId,
        installation_id: install,
        collection_version: r.collection_version,
        collection_digest: r.collection_digest,
        ordinal: 0,
        publication_id: r.publication_id,
        lesson_version: r.lesson_version,
        content_digest: r.content_digest,
        reason_json: r.reason_json,
      }),
      insert('pilot_collection_assignment', {
        id: assignmentId,
        plan_item_id: itemId,
        child_id: childId,
        installation_id: install,
        collection_version: r.collection_version,
        collection_digest: r.collection_digest,
        lesson_version: r.lesson_version,
        content_digest: r.content_digest,
        publication_id: r.publication_id,
        created_at: at,
        test_run_id: r.test_run_id,
      }),
      insert('pilot_collection_schedule', {
        id: id('collection-schedule'),
        assignment_id: assignmentId,
        child_id: childId,
        installation_id: install,
        kind: 'initial',
        due_at: at,
        policy_version: 'r5-review-24h-7d-1',
        initial_run_id: null,
        completion_event_id: null,
        initial_completed_at: null,
        created_at: at,
      }),
      insert('pilot_collection_learning_audit', {
        id: id('collection-audit'),
        run_id: null,
        plan_id: planId,
        actor_id: c.user.id,
        action: 'plan-approval',
        event_id: null,
        revision: null,
        created_at: at,
      }),
    ]);
  } catch (error) {
    await parent(c, childId);
    const raced = await one(
      c,
      `SELECT * FROM pilot_collection_plan WHERE proposal_id=${q(r.id)}`,
    );
    if (raced) {
      if (raced.request_digest !== fingerprint) fail('EVENT_CONFLICT');
      return { plan: await planDTO(c, raced) };
    }
    if (!(await proposalCurrent(c, r, reg))) fail('PLACEMENT_STALE');
    throw error;
  }
  return { plan: await planDTO(c, plan) };
}
async function runSnapshot(c: CollectionContext, runId: string) {
  const r = await one(
    c,
    `SELECT * FROM pilot_collection_run WHERE id=${q(runId)}`,
  );
  if (!r) fail('NOT_FOUND', 404);
  await readable(c, String(r.child_id));
  const l = await lesson(c, String(r.lesson_version)),
    run = validatePairedRun(l.compiled, JSON.parse(String(r.run_json)));
  if (
    run.runId !== r.id ||
    run.identity.contentDigest !== r.content_digest ||
    run.revision !== Number(r.revision) ||
    run.createdAt !== iso(r.created_at) ||
    run.updatedAt !== iso(r.updated_at) ||
    run.state.phase !== r.phase ||
    run.seed !== collectionSeed(String(r.assignment_id)) ||
    run.state.completedAt !==
      (r.completed_at === null ? null : iso(r.completed_at))
  )
    fail('STORAGE_UNAVAILABLE', 503);
  const ledger = await rows(
    c,
    `SELECT * FROM pilot_collection_event WHERE run_id=${q(r.id)} ORDER BY sequence`,
  );
  if (ledger.length !== run.events.length) fail('STORAGE_UNAVAILABLE', 503);
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i],
      stored = JSON.parse(String(e.result_json)),
      fact = run.events[i];
    if (
      canonicalPackage(stored.event) !== canonicalPackage(fact) ||
      canonicalPackage(fact.action) !== e.action_json ||
      fact.eventId !== e.event_id ||
      fact.sequence !== Number(e.sequence) ||
      Date.parse(fact.serverTime) !== Number(e.server_at) ||
      stored.policy.soundReview !== fact.soundReview ||
      stored.policy.publicationId !== r.publication_id ||
      stored.ack.eventId !== fact.eventId ||
      stored.ack.revision !== fact.sequence ||
      canonicalPackage(stored.ack.result) !== canonicalPackage(fact.result)
    )
      fail('STORAGE_UNAVAILABLE', 503);
  }
  const schedule = await one(
      c,
      `SELECT * FROM pilot_collection_schedule WHERE id=${q(r.schedule_id)}`,
    ),
    p = await one(
      c,
      `SELECT * FROM pilot_curriculum_publication WHERE id=${q(r.publication_id)}`,
    ),
    reg = await registered(c, String(r.collection_version));
  if (!schedule || !p || reg.row.collection_digest !== r.collection_digest)
    fail('STORAGE_UNAVAILABLE', 503);
  return { r, l, run, ledger, schedule, p, reg };
}
export async function getCollectionRun(
  c: CollectionContext,
  runId: string,
): Promise<CollectionRunView> {
  const s = await runSnapshot(c, runId),
    status = await available(c, s.p, String(s.r.child_id)),
    projection = projectPairedRun(s.l.compiled, s.run, status.policy);
  return {
    ...projection,
    ...collectionIdentity(s.reg.row),
    ...s.l.compiled.identity,
    schemaVersion: 'r5-story-view-1',
    runId: String(s.r.id),
    assignmentId: String(s.r.assignment_id),
    scheduleId: String(s.r.schedule_id),
    publicationId: String(s.p.id),
    publicationGeneration: Number(s.p.generation),
    installationId: String(s.r.installation_id),
    childId: String(s.r.child_id),
    revision: s.run.revision,
    state: s.run.state,
    soundReview: status.policy.soundReview,
    available: status.available,
    reason: status.reason,
    dueAt: iso(s.schedule.due_at),
    serverAt: iso(now(c)),
    createdAt: s.run.createdAt,
    updatedAt: s.run.updatedAt,
  };
}
export async function startCollection(
  c: CollectionContext,
  assignmentId: string,
  input: unknown,
) {
  input = plainInput(input);
  await requireActor(c, 'child');
  if (
    !exact(input, ['requestId', 'scheduleId']) ||
    !text(input.requestId, 120) ||
    !text(input.scheduleId, 120)
  )
    fail('INVALID_REQUEST', 400);
  const install = await installation(c),
    a = await one(
      c,
      `SELECT * FROM pilot_collection_assignment WHERE id=${q(assignmentId)} AND child_id=${q(c.user.id)} AND installation_id=${q(install)}`,
    );
  if (!a) fail('NOT_FOUND', 404);
  await readable(c, String(a.child_id));
  const schedule = await one(
    c,
    `SELECT * FROM pilot_collection_schedule WHERE id=${q(input.scheduleId)} AND assignment_id=${q(a.id)} AND child_id=${q(c.user.id)} AND installation_id=${q(install)}`,
  );
  if (!schedule) fail('NOT_FOUND', 404);
  const request = collectionRequest(
      'start',
      c.user.id,
      install,
      assignmentId,
      input,
    ),
    fingerprint = await curriculumDigest(request),
    prior = await one(
      c,
      `SELECT * FROM pilot_collection_run WHERE child_id=${q(c.user.id)} AND installation_id=${q(install)} AND start_request_id=${q(input.requestId)}`,
    );
  if (prior) {
    if (prior.start_request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return JSON.parse(String(prior.start_ack_json));
  }
  const opened = await one(
    c,
    `SELECT * FROM pilot_collection_run WHERE schedule_id=${q(schedule.id)}`,
  );
  if (opened) return JSON.parse(String(opened.start_ack_json));
  const p = await one(
    c,
    `SELECT * FROM pilot_curriculum_publication WHERE id=${q(a.publication_id)}`,
  );
  if (!p || (await available(c, p, c.user.id)).available !== true)
    fail('LESSON_UNAVAILABLE');
  const at = now(c);
  if (at < Number(schedule.due_at)) fail('REVIEW_NOT_DUE');
  const l = await lesson(c, String(a.lesson_version)),
    runId = id('collection-run'),
    run = createPairedRun(l.compiled, {
      runId,
      seed: collectionSeed(assignmentId),
      phase: schedule.kind as PairedRun['state']['phase'],
      now: at,
    }),
    ack = {
      runId,
      assignmentId,
      scheduleId: String(schedule.id),
      lessonVersion: String(a.lesson_version),
      revision: 0 as const,
    };
  await batch(c, [
    insert(
      'pilot_collection_run',
      {
        id: runId,
        assignment_id: a.id,
        schedule_id: schedule.id,
        child_id: a.child_id,
        installation_id: install,
        collection_version: a.collection_version,
        collection_digest: a.collection_digest,
        lesson_version: a.lesson_version,
        content_digest: a.content_digest,
        publication_id: a.publication_id,
        adapter_id: 'paired-story',
        adapter_version: 'paired-story-v1',
        phase: schedule.kind,
        seed: run.seed,
        start_request_id: input.requestId,
        start_request_json: canonicalPackage(request),
        start_request_digest: fingerprint,
        start_ack_json: canonicalPackage(ack),
        run_json: canonicalPackage(run),
        revision: 0,
        completed_at: null,
        created_at: at,
        updated_at: at,
        test_run_id: a.test_run_id,
      },
      `${childGuard(c, c.user.id, p)} AND ${Number(schedule.due_at)}<=${now(c)} AND EXISTS(SELECT 1 FROM pilot_collection WHERE collection_version=${q(a.collection_version)} AND collection_digest=${q(a.collection_digest)})`,
    ),
    insert('pilot_collection_learning_audit', {
      id: id('collection-audit'),
      run_id: runId,
      plan_id: null,
      actor_id: c.user.id,
      action: 'run-start',
      event_id: null,
      revision: 0,
      created_at: at,
    }),
  ]);
  return ack;
}
export async function advanceCollection(
  c: CollectionContext,
  runId: string,
  input: unknown,
) {
  input = plainInput(input);
  await requireActor(c, 'child');
  const s = await runSnapshot(c, runId);
  if (s.r.child_id !== c.user.id) fail('NOT_FOUND', 404);
  const install = await installation(c);
  if (s.r.installation_id !== install) fail('LESSON_UNAVAILABLE');
  if (
    !exact(input, [
      'eventId',
      'expectedRevision',
      'occurrenceId',
      'type',
      'payload',
    ]) ||
    !text(input.eventId, 120) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    !(input.occurrenceId === null || text(input.occurrenceId, 200))
  )
    fail('INVALID_REQUEST', 400);
  const fingerprint = await curriculumDigest(
      collectionRequest('action', c.user.id, install, runId, input),
    ),
    duplicate = s.ledger.find((x) => x.event_id === input.eventId);
  if (duplicate) {
    if (duplicate.request_digest !== fingerprint) fail('EVENT_CONFLICT');
    return {
      ack: JSON.parse(String(duplicate.result_json)).ack,
      replayed: true,
    };
  }
  if (input.expectedRevision !== s.run.revision) fail('STALE_REVISION');
  const status = await available(c, s.p, c.user.id);
  if (!status.available) fail('LESSON_UNAVAILABLE');
  const at = now(c);
  let result;
  try {
    result = applyPairedAction(s.l.compiled, s.run, input, {
      now: at,
      ...status.policy,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error)
      fail(
        String(error.code),
        String(error.code) === 'INVALID_REQUEST' ? 400 : 409,
      );
    throw error;
  }
  const policy = {
      soundReview: status.policy.soundReview,
      publicationId: String(s.p.id),
      generation: Number(s.p.generation),
      reviewId: s.p.review_id,
      scopeKind: s.p.scope_kind,
      candidateId: s.p.candidate_id,
    },
    eventId = id('collection-event'),
    guard = `${childGuard(c, c.user.id, s.p)} AND EXISTS(SELECT 1 FROM pilot_collection_run WHERE id=${q(runId)} AND revision=${s.run.revision})`;
  const statements = [
    insert(
      'pilot_collection_event',
      {
        id: eventId,
        run_id: runId,
        event_id: result.event.eventId,
        sequence: result.event.sequence,
        expected_revision: s.run.revision,
        request_digest: fingerprint,
        action_json: canonicalPackage(input),
        result_json: canonicalPackage({
          event: result.event,
          ack: result.ack,
          policy,
        }),
        server_at: at,
      },
      guard,
    ),
    `UPDATE pilot_collection_run SET run_json=${q(canonicalPackage(result.run))},revision=${result.run.revision},updated_at=${at},completed_at=${q(result.run.state.completedAt === null ? null : Date.parse(result.run.state.completedAt))} WHERE id=${q(runId)} AND revision=${s.run.revision} AND EXISTS(SELECT 1 FROM pilot_collection_event WHERE id=${q(eventId)})`,
  ];
  if (
    s.run.state.phase === 'initial' &&
    s.run.state.completedAt === null &&
    result.run.state.completedAt !== null
  )
    for (const [kind, delay] of [
      ['review-24h', 86400000],
      ['review-7d', 604800000],
    ] as const)
      statements.push(
        insert('pilot_collection_schedule', {
          id: id('collection-schedule'),
          assignment_id: s.r.assignment_id,
          child_id: c.user.id,
          installation_id: install,
          kind,
          due_at: at + delay,
          policy_version: 'r5-review-24h-7d-1',
          initial_run_id: runId,
          completion_event_id: eventId,
          initial_completed_at: at,
          created_at: at,
        }),
      );
  statements.push(
    insert('pilot_collection_learning_audit', {
      id: id('collection-audit'),
      run_id: runId,
      plan_id: null,
      actor_id: c.user.id,
      action: 'run-action',
      event_id: eventId,
      revision: result.run.revision,
      created_at: at,
    }),
  );
  try {
    await batch(c, statements);
  } catch (error) {
    const retry = await one(
      c,
      `SELECT * FROM pilot_collection_event WHERE run_id=${q(runId)} AND event_id=${q(input.eventId)}`,
    );
    if (retry) {
      if (retry.request_digest !== fingerprint) fail('EVENT_CONFLICT');
      return { ack: JSON.parse(String(retry.result_json)).ack, replayed: true };
    }
    const row = await one(
      c,
      `SELECT revision FROM pilot_collection_run WHERE id=${q(runId)}`,
    );
    if (Number(row?.revision) !== s.run.revision) fail('STALE_REVISION');
    throw error;
  }
  return { ack: result.ack, replayed: false };
}
export async function collectionPractice(
  c: CollectionContext,
  childId: string,
  version: string,
) {
  await readable(c, childId);
  const reg = await registered(c, version),
    items: CollectionPracticeItem[] = [];
  for (const s of await rows(
    c,
    `SELECT s.*,a.collection_version,a.collection_digest,a.lesson_version,a.content_digest,a.publication_id,r.id AS run_id,r.run_json,r.completed_at FROM pilot_collection_schedule s JOIN pilot_collection_assignment a ON a.id=s.assignment_id LEFT JOIN pilot_collection_run r ON r.schedule_id=s.id WHERE s.child_id=${q(childId)} AND a.collection_version=${q(version)} ORDER BY s.due_at,s.id`,
  )) {
    if (s.completed_at !== null) continue;
    const p = await one(
        c,
        `SELECT * FROM pilot_curriculum_publication WHERE id=${q(s.publication_id)}`,
      ),
      status = await available(c, p, childId),
      run = s.run_json ? (JSON.parse(String(s.run_json)) as PairedRun) : null;
    items.push({
      ...collectionIdentity(reg.row),
      lessonId: String(s.lesson_version).replace(/-v\d+$/, ''),
      lessonVersion: String(s.lesson_version),
      contentDigest: String(s.content_digest),
      adapterId: 'paired-story',
      adapterVersion: 'paired-story-v1',
      assignmentId: String(s.assignment_id),
      scheduleId: String(s.id),
      runId: s.run_id ? String(s.run_id) : null,
      publicationId: String(s.publication_id),
      generation: Number(p?.generation ?? 0),
      kind: s.kind as CollectionPracticeItem['kind'],
      dueAt: iso(s.due_at),
      available: status.available && Number(s.due_at) <= now(c),
      reason:
        status.reason ??
        (Number(s.due_at) > now(c) ? 'Review is not due yet.' : null),
      stepId: run?.state.stepId ?? null,
    });
  }
  const incomplete = items.filter((x) => x.available && x.runId),
    due = items.filter((x) => x.available && x.kind !== 'initial'),
    next = items.filter((x) => x.available && x.kind === 'initial' && !x.runId);
  const selected = incomplete[0] ?? due[0] ?? next[0];
  return {
    items,
    primary: selected
      ? {
          kind: incomplete.includes(selected)
            ? ('continue' as const)
            : selected.kind === 'initial'
              ? ('next' as const)
              : ('review' as const),
          assignmentId: selected.assignmentId,
          scheduleId: selected.scheduleId,
          runId: selected.runId,
        }
      : {
          kind: 'prepare' as const,
          assignmentId: null,
          scheduleId: null,
          runId: null,
        },
  };
}
export async function collectionProgress(
  c: CollectionContext,
  childId: string,
): Promise<CollectionProgress[]> {
  await readable(c, childId);
  if (
    !(await one(
      c,
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pilot_collection_plan'",
    ))
  )
    return [];
  const versions = await rows(
      c,
      `SELECT DISTINCT collection_version FROM pilot_collection_plan WHERE child_id=${q(childId)} ORDER BY collection_version`,
    ),
    result: CollectionProgress[] = [];
  for (const v of versions) {
    const version = String(v.collection_version),
      reg = await registered(c, version),
      plans = await collectionPlans(c, childId, version),
      practice = await collectionPractice(c, childId, version),
      visits = [];
    for (const s of await rows(
      c,
      `SELECT s.*,a.collection_version,a.collection_digest,a.lesson_version,a.content_digest,a.publication_id,r.id AS run_id FROM pilot_collection_schedule s JOIN pilot_collection_assignment a ON a.id=s.assignment_id LEFT JOIN pilot_collection_run r ON r.schedule_id=s.id WHERE s.child_id=${q(childId)} AND a.collection_version=${q(version)} ORDER BY s.due_at,s.id`,
    )) {
      const run = s.run_id ? await getCollectionRun(c, String(s.run_id)) : null;
      visits.push({
        ...collectionIdentity(reg.row),
        lessonId: String(s.lesson_version).replace(/-v\d+$/, ''),
        lessonVersion: String(s.lesson_version),
        contentDigest: String(s.content_digest),
        adapterId: 'paired-story' as const,
        adapterVersion: 'paired-story-v1' as const,
        assignmentId: String(s.assignment_id),
        scheduleId: String(s.id),
        runId: run?.runId ?? null,
        publicationId: String(s.publication_id),
        phase: s.kind as CollectionPracticeItem['kind'],
        dueAt: iso(s.due_at),
        completedAt: run?.state.completedAt ?? null,
        introducedTargets:
          run?.state.phase === 'initial' && run.state.targetRoutes
            ? run.state.targetRoutes.map((x) => x.characterId)
            : [],
        recap: run?.recap ?? null,
      });
    }
    result.push({
      ...collectionIdentity(reg.row),
      schemaVersion: 'r5-family-progress-1',
      installationId: await installation(c),
      childId,
      plans: plans.history,
      practice: practice.items,
      visits,
      evidenceLimits: [
        'These saved responses do not establish mastery or fluency.',
        'Missing visits provide no evidence.',
        'Synthetic verification is not actual child evidence or human acceptance.',
      ],
    });
  }
  return result;
}

export async function isCollectionResource(
  c: CollectionContext,
  kind: 'proposal' | 'assignment' | 'run',
  resourceId: string,
) {
  const table = `pilot_collection_${kind}`;
  if (
    !(await one(
      c,
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=${q(table)}`,
    ))
  )
    return false;
  return !!(await one(c, `SELECT 1 FROM ${table} WHERE id=${q(resourceId)}`));
}
export async function isCollectionPackage(
  c: CollectionContext,
  version: string,
) {
  const p = await one(
    c,
    `SELECT manifest_json FROM pilot_curriculum_package WHERE lesson_version=${q(version)}`,
  );
  if (!p) return false;
  const parsed = JSON.parse(String(p.manifest_json));
  return parsed?.renderer?.adapterId === 'paired-story';
}

function plainInput(input: unknown): unknown {
  const r = inspectJson(input);
  if (r.errors.length) fail('INVALID_REQUEST', 400);
  return r.value;
}
/** Server-only closed candidate bootstrap. HTTP wrapper, if supplied, must use fixed source assets. */
export async function bootstrapCollection(
  c: CollectionContext,
  document: unknown,
  packages: readonly unknown[],
) {
  await requireActor(c, 'operator');
  const checked = await validateCollectionPackages(document, packages),
    fingerprint = await curriculumDigest(checked.manifest),
    install = await installation(c),
    cap = c.config.collectionCapability,
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
    cap.collectionVersion !== checked.manifest.collectionVersion ||
    cap.collectionDigest !== fingerprint ||
    cap.namespace !== c.config.testRunId
  )
    fail('NOT_FOUND', 404);
  const { importCurriculumPackage } = await import('./curriculum.ts');
  for (const p of packages)
    await importCurriculumPackage(c as PilotSessionContext, { package: p });
  await importCollection(c, { collection: checked.manifest });
  const publications = [];
  for (const entry of checked.manifest.items) {
    const membership: TrialScope['members'] = [];
    for (const childId of cap.childIds) {
      const link = await one(
        c,
        `SELECT parent_id FROM pilot_parent_child WHERE child_id=${q(childId)} AND parent_id IN (${cap.parentIds.map(q).join(',')}) ORDER BY parent_id LIMIT 1`,
      );
      if (!link) fail('RELEASE_SCOPE_INVALID');
      membership.push({
        childId,
        parentId: String(link.parent_id),
        planScope: entry.lessonVersion,
      });
    }
    const existing = await latest(c, entry.lessonVersion);
    if (existing) {
      if (
        existing.test_run_id !== cap.namespace ||
        existing.content_digest !== entry.contentDigest
      )
        fail('RELEASE_IDENTITY_MISMATCH');
      publications.push(JSON.parse(String(existing.ack_json)));
    } else
      publications.push(
        await publishCollection(
          c,
          entry.lessonVersion,
          {
            requestId: `bootstrap-${cap.namespace}-${entry.lessonVersion}`,
            expectedRevision: 0,
            predecessorId: null,
            contentDigest: entry.contentDigest,
            reviewId: null,
            proofId: null,
            ownerDecisionId: null,
            status: 'released',
            scope: { kind: 'supervised-trial', members: membership },
          },
          true,
        ),
      );
  }
  return {
    collectionVersion: checked.manifest.collectionVersion,
    collectionDigest: fingerprint,
    publications,
  };
}
