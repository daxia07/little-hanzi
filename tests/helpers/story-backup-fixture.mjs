import fs from 'node:fs';
import crypto from 'node:crypto';
import { canonicalPackage } from '../../lib/curriculum/digest.ts';
import { compileStoryPackage } from '../../lib/curriculum/story-package.ts';
import {
  createInitialRun,
  applyAction,
  actionAck,
} from '../../lib/curriculum/story-runtime.ts';
import { STORY_COLUMNS } from '../../scripts/pilot-story-backup.mjs';

const json = canonicalPackage;
const hash = (value) =>
  `sha256:${crypto.createHash('sha256').update(json(value)).digest('hex')}`;
const operation = (kind, actorId, resourceId, request) => ({
  schemaVersion: `r3-${kind}-request-1`,
  actorId,
  installationId: 'install-source',
  resourceId,
  request,
});

/** Pure, synthetic validator fixture; not a database or human acceptance fixture. */
export async function storyBackupFixture() {
  const now = 1_790_000_000_000,
    version = 'forest-01-v4',
    namespace = 'story-backup-fixture';
  const pkg = JSON.parse(
    fs.readFileSync(
      new URL('../../content/curriculum/forest-01-v4.json', import.meta.url),
      'utf8',
    ),
  );
  const compiled = await compileStoryPackage(pkg),
    contentDigest = compiled.identity.contentDigest;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const issuer = {
    issuerId: 'synthetic-issuer',
    publicKeyJwk: publicKey.export({ format: 'jwk' }),
    notBefore: now - 1000,
    revokedAt: null,
    purpose: 'candidate',
  };
  const scope = {
    kind: 'supervised-trial',
    members: [{ childId: 'child', parentId: 'parent', planScope: version }],
  };
  const receipt = {
    schemaVersion: 'r3-proof-receipt-1',
    receiptId: 'proof',
    issuerId: issuer.issuerId,
    issuedAt: now,
    candidateId: 'candidate',
    sourceDigest: hash('source'),
    artifactDigest: hash('artifact'),
    buildId: 'build',
    lessonVersion: version,
    contentDigest,
    canonicalizationVersion: 's3-json-1',
    adapterId: 'forest-story',
    adapterVersion: 'forest-story-v1',
    evidenceInstallationId: 'install-evidence',
    targetInstallationId: 'install-source',
    namespace,
    syntheticOnly: true,
    scenarios: [
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
    ].map((id) => ({ id, outcome: 'PASS', evidenceDigest: hash(id) })),
    reportDigest: hash('report'),
  };
  const tables = Object.fromEntries(
    Object.keys(STORY_COLUMNS).map((name) => [name, []]),
  );
  tables.pilot_auth_user = [
    { id: 'operator', role: 'operator' },
    { id: 'parent', role: 'parent' },
    { id: 'child', role: 'child' },
  ];
  tables.pilot_curriculum_package = [
    {
      lesson_version: version,
      content_digest: contentDigest,
      manifest_json: json(pkg),
      test_run_id: namespace,
    },
  ];
  tables.pilot_curriculum_review = [
    {
      review_id: 'review',
      lesson_version: version,
      content_digest: contentDigest,
      test_run_id: namespace,
      decision: 'approved',
      recorded_at: now,
      previous_review_id: null,
    },
  ];
  tables.pilot_curriculum_proof_receipt.push({
    id: 'proof',
    issuer_id: issuer.issuerId,
    receipt_version: receipt.schemaVersion,
    receipt_digest: hash(receipt),
    receipt_json: json(receipt),
    signature: crypto
      .sign(null, Buffer.from(json(receipt)), privateKey)
      .toString('base64url'),
    issued_at: now,
    accepted_at: now,
    namespace,
    accepted_issuer_json: json(issuer),
  });
  const ownerBody = {
    requestId: 'owner',
    contentDigest,
    candidateId: 'candidate',
    artifactDigest: receipt.artifactDigest,
    targetInstallationId: 'install-source',
    scope,
    ownerIdentity: 'Synthetic owner fixture',
    decision: 'accepted',
    decidedAt: now,
    evidenceRef: 'synthetic:owner',
  };
  const ownerRequest = operation('owner', 'operator', version, ownerBody);
  tables.pilot_curriculum_owner_decision.push({
    id: 'owner',
    lesson_version: version,
    content_digest: contentDigest,
    candidate_id: 'candidate',
    artifact_digest: receipt.artifactDigest,
    target_installation_id: 'install-source',
    scope_digest: hash(scope),
    owner_identity: ownerBody.ownerIdentity,
    decision: 'accepted',
    decided_at: now,
    evidence_ref: ownerBody.evidenceRef,
    recorded_by: 'operator',
    test_run_id: namespace,
    request_json: json(ownerRequest),
    request_digest: hash(ownerRequest),
  });
  const publicationBody = {
    requestId: 'publish',
    expectedRevision: 0,
    predecessorId: null,
    contentDigest,
    reviewId: 'review',
    proofId: 'proof',
    ownerDecisionId: 'owner',
    status: 'released',
    scope,
  };
  const publicationRequest = operation(
    'publication',
    'operator',
    version,
    publicationBody,
  );
  tables.pilot_curriculum_publication.push({
    id: 'publication',
    lesson_version: version,
    content_digest: contentDigest,
    generation: 1,
    predecessor_id: null,
    request_id: 'publish',
    request_digest: hash(publicationRequest),
    request_json: json(publicationRequest),
    ack_json: json({
      publicationId: 'publication',
      generation: 1,
      revision: 1,
      status: 'released',
    }),
    status: 'released',
    scope_kind: 'verification',
    scope_digest: hash(scope),
    review_id: 'review',
    proof_id: 'proof',
    owner_decision_id: 'owner',
    candidate_id: 'candidate',
    artifact_digest: receipt.artifactDigest,
    installation_id: 'install-source',
    actor_id: 'operator',
    created_at: now,
    test_run_id: namespace,
  });
  tables.pilot_curriculum_trial_member.push({
    publication_id: 'publication',
    child_id: 'child',
    parent_id: 'parent',
    plan_scope: version,
  });
  tables.pilot_curriculum_publication_state.push({
    installation_id: 'install-source',
    lesson_version: version,
    revision: 1,
    latest_publication_id: 'publication',
  });
  tables.pilot_curriculum_publication_audit.push({
    id: 'publish-audit',
    publication_id: 'publication',
    actor_id: 'operator',
    action: 'released',
    request_id: 'publish',
    created_at: now,
  });
  const source = {
    schemaVersion: 'r3-placement-source-1',
    childId: 'child',
    installationId: 'install-source',
    policyVersion: 'r3-placement-1',
    onboardingDigest: hash('setup'),
    evidenceDigest: hash('evidence'),
    publicationId: 'publication',
    lessonVersion: version,
    contentDigest,
    reason: 'A starting suggestion.',
    createdAt: now,
  };
  tables.pilot_placement_proposal.push({
    id: 'proposal',
    child_id: 'child',
    installation_id: 'install-source',
    policy_version: source.policyVersion,
    source_digest: hash(source),
    source_json: json(source),
    onboarding_digest: source.onboardingDigest,
    evidence_digest: source.evidenceDigest,
    publication_id: 'publication',
    lesson_version: version,
    content_digest: contentDigest,
    reason_json: json({ text: source.reason }),
    created_at: now,
    expires_at: now + 86400000,
    test_run_id: namespace,
  });
  tables.pilot_learning_plan.push({
    id: 'plan',
    proposal_id: 'proposal',
    child_id: 'child',
    installation_id: 'install-source',
    parent_id: 'parent',
    policy_version: source.policyVersion,
    source_digest: hash(source),
    approved_at: now,
    test_run_id: namespace,
  });
  tables.pilot_learning_plan_item.push({
    id: 'item',
    plan_id: 'plan',
    child_id: 'child',
    installation_id: 'install-source',
    ordinal: 0,
    publication_id: 'publication',
    lesson_version: version,
    content_digest: contentDigest,
    reason_json: json({ text: source.reason }),
  });
  tables.pilot_curriculum_assignment.push({
    id: 'assignment',
    plan_item_id: 'item',
    child_id: 'child',
    installation_id: 'install-source',
    lesson_version: version,
    content_digest: contentDigest,
    publication_id: 'publication',
    created_at: now,
    test_run_id: namespace,
  });
  tables.pilot_learning_schedule.push({
    id: 'initial',
    assignment_id: 'assignment',
    child_id: 'child',
    kind: 'initial',
    due_at: now,
    policy_version: 'r3-review-24h-1',
    created_at: now,
  });
  const started = createInitialRun(compiled, {
    runId: 'run',
    seed: 42,
    now: new Date(now).toISOString(),
  });
  const action = {
    eventId: 'event',
    expectedRevision: 0,
    stepId: 'welcome',
    type: 'continue',
    payload: {},
  };
  const policy = { soundReview: 'synthetic' },
    result = applyAction(
      started,
      [],
      action,
      new Date(now + 1).toISOString(),
      policy,
    );
  if (!result.ok) throw result.error;
  tables.pilot_curriculum_learning_run.push({
    id: 'run',
    assignment_id: 'assignment',
    child_id: 'child',
    installation_id: 'install-source',
    lesson_version: version,
    content_digest: contentDigest,
    publication_id: 'publication',
    adapter_id: 'forest-story',
    adapter_version: 'forest-story-v1',
    seed: 42,
    start_request_id: 'start',
    start_request_digest: hash(
      operation('start', 'child', 'assignment', { requestId: 'start' }),
    ),
    start_ack_json: json({
      runId: 'run',
      assignmentId: 'assignment',
      lessonVersion: version,
      revision: 0,
    }),
    run_json: json(result.run),
    revision: 1,
    created_at: now,
    updated_at: now + 1,
    test_run_id: namespace,
  });
  tables.pilot_curriculum_learning_event.push({
    id: 'event-row',
    run_id: 'run',
    event_id: action.eventId,
    sequence: 1,
    request_digest: hash(operation('action', 'child', 'run', action)),
    expected_revision: 0,
    action_json: json(action),
    result_json: json({
      event: result.event,
      ack: actionAck(result, policy),
      policy,
    }),
    server_at: now + 1,
  });
  tables.pilot_curriculum_learning_audit.push(
    {
      id: 'plan-audit',
      run_id: null,
      plan_id: 'plan',
      actor_id: 'parent',
      action: 'plan-approval',
      event_id: null,
      revision: null,
      created_at: now,
    },
    {
      id: 'start-audit',
      run_id: 'run',
      plan_id: null,
      actor_id: 'child',
      action: 'run-start',
      event_id: null,
      revision: 0,
      created_at: now,
    },
    {
      id: 'action-audit',
      run_id: 'run',
      plan_id: null,
      actor_id: 'child',
      action: 'run-action',
      event_id: 'event-row',
      revision: 1,
      created_at: now + 1,
    },
  );
  return { payload: { tables }, archiveIssuers: [issuer] };
}
