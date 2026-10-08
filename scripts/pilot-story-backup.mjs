import crypto from 'node:crypto';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { compileStoryPackage } from '../lib/curriculum/story-package.ts';
import { replayStoryRun } from '../lib/curriculum/story-runtime.ts';

// Exact additive 0005 export allowlist. Auth sessions, runtime capabilities and keys are excluded.
export const STORY_COLUMNS = {
  pilot_curriculum_proof_receipt: [
    'id',
    'issuer_id',
    'receipt_version',
    'receipt_digest',
    'receipt_json',
    'signature',
    'issued_at',
    'accepted_at',
    'namespace',
    'accepted_issuer_json',
  ],
  pilot_curriculum_owner_decision: [
    'id',
    'lesson_version',
    'content_digest',
    'candidate_id',
    'artifact_digest',
    'target_installation_id',
    'scope_digest',
    'owner_identity',
    'decision',
    'decided_at',
    'evidence_ref',
    'recorded_by',
    'test_run_id',
    'request_json',
    'request_digest',
  ],
  pilot_curriculum_publication: [
    'id',
    'lesson_version',
    'content_digest',
    'generation',
    'predecessor_id',
    'request_id',
    'request_digest',
    'request_json',
    'ack_json',
    'status',
    'scope_kind',
    'scope_digest',
    'review_id',
    'proof_id',
    'owner_decision_id',
    'candidate_id',
    'artifact_digest',
    'installation_id',
    'actor_id',
    'created_at',
    'test_run_id',
  ],
  pilot_curriculum_trial_member: [
    'publication_id',
    'child_id',
    'parent_id',
    'plan_scope',
  ],
  pilot_curriculum_publication_state: [
    'installation_id',
    'lesson_version',
    'revision',
    'latest_publication_id',
  ],
  pilot_curriculum_publication_audit: [
    'id',
    'publication_id',
    'actor_id',
    'action',
    'request_id',
    'created_at',
  ],
  pilot_placement_proposal: [
    'id',
    'child_id',
    'installation_id',
    'policy_version',
    'source_digest',
    'source_json',
    'onboarding_digest',
    'evidence_digest',
    'publication_id',
    'lesson_version',
    'content_digest',
    'reason_json',
    'created_at',
    'expires_at',
    'test_run_id',
  ],
  pilot_learning_plan: [
    'id',
    'proposal_id',
    'child_id',
    'installation_id',
    'parent_id',
    'policy_version',
    'source_digest',
    'approved_at',
    'test_run_id',
  ],
  pilot_learning_plan_item: [
    'id',
    'plan_id',
    'child_id',
    'installation_id',
    'ordinal',
    'publication_id',
    'lesson_version',
    'content_digest',
    'reason_json',
  ],
  pilot_curriculum_assignment: [
    'id',
    'plan_item_id',
    'child_id',
    'installation_id',
    'lesson_version',
    'content_digest',
    'publication_id',
    'created_at',
    'test_run_id',
  ],
  pilot_learning_schedule: [
    'id',
    'assignment_id',
    'child_id',
    'kind',
    'due_at',
    'policy_version',
    'created_at',
  ],
  pilot_curriculum_learning_run: [
    'id',
    'assignment_id',
    'child_id',
    'installation_id',
    'lesson_version',
    'content_digest',
    'publication_id',
    'adapter_id',
    'adapter_version',
    'seed',
    'start_request_id',
    'start_request_digest',
    'start_ack_json',
    'run_json',
    'revision',
    'created_at',
    'updated_at',
    'test_run_id',
  ],
  pilot_curriculum_learning_event: [
    'id',
    'run_id',
    'event_id',
    'sequence',
    'request_digest',
    'expected_revision',
    'action_json',
    'result_json',
    'server_at',
  ],
  pilot_curriculum_learning_audit: [
    'id',
    'run_id',
    'plan_id',
    'actor_id',
    'action',
    'event_id',
    'revision',
    'created_at',
  ],
};
export const STORY_TABLES = Object.keys(STORY_COLUMNS);
export const STORY_TRIGGERS = [
  'pilot_curriculum_proof_receipt_no_update',
  'pilot_curriculum_proof_receipt_no_delete',
  'pilot_curriculum_owner_decision_no_update',
  'pilot_curriculum_owner_decision_no_delete',
  'pilot_curriculum_publication_no_update',
  'pilot_curriculum_publication_no_delete',
  'pilot_curriculum_trial_member_no_update',
  'pilot_curriculum_trial_member_no_delete',
  'pilot_curriculum_publication_audit_no_update',
  'pilot_curriculum_publication_audit_no_delete',
  'pilot_placement_proposal_no_update',
  'pilot_placement_proposal_no_delete',
  'pilot_learning_plan_no_update',
  'pilot_learning_plan_no_delete',
  'pilot_learning_plan_item_no_update',
  'pilot_learning_plan_item_no_delete',
  'pilot_curriculum_assignment_no_update',
  'pilot_curriculum_assignment_no_delete',
  'pilot_learning_schedule_no_update',
  'pilot_learning_schedule_no_delete',
  'pilot_curriculum_learning_run_no_update',
  'pilot_curriculum_learning_run_no_delete',
  'pilot_curriculum_learning_event_no_update',
  'pilot_curriculum_learning_event_no_delete',
  'pilot_curriculum_learning_audit_no_update',
  'pilot_curriculum_learning_audit_no_delete',
  'pilot_learning_plan_binding',
  'pilot_learning_plan_item_binding',
  'pilot_placement_proposal_namespace',
  'pilot_curriculum_assignment_namespace',
  'pilot_curriculum_learning_run_namespace',
  'pilot_curriculum_publication_state_binding_insert',
  'pilot_curriculum_publication_state_binding_update',
];
export const STORY_INDEXES = [
  'pilot_curriculum_trial_member_lookup_idx',
  'pilot_learning_plan_lookup_idx',
  'pilot_curriculum_assignment_lookup_idx',
  'pilot_curriculum_learning_run_lookup_idx',
  'pilot_curriculum_learning_event_lookup_idx',
  'pilot_placement_proposal_lookup_idx',
];

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_CLOCK = 8_640_000_000_000_000;
const INTEGERS = new Set([
  'issued_at',
  'accepted_at',
  'decided_at',
  'generation',
  'revision',
  'created_at',
  'expires_at',
  'approved_at',
  'ordinal',
  'due_at',
  'seed',
  'updated_at',
  'sequence',
  'expected_revision',
  'server_at',
]);
const NULLABLE = {
  pilot_curriculum_owner_decision: ['test_run_id'],
  pilot_curriculum_publication: [
    'predecessor_id',
    'review_id',
    'proof_id',
    'owner_decision_id',
    'test_run_id',
  ],
  pilot_placement_proposal: ['test_run_id'],
  pilot_learning_plan: ['test_run_id'],
  pilot_curriculum_assignment: ['test_run_id'],
  pilot_curriculum_learning_run: ['test_run_id'],
  pilot_curriculum_learning_audit: [
    'run_id',
    'plan_id',
    'event_id',
    'revision',
  ],
};
const REQUIRED_SCENARIOS = [
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
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value) =>
  typeof value === 'string' && value.length > 0 && value.isWellFormed();
const integer = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_CLOCK;
const hash = (value) =>
  `sha256:${crypto.createHash('sha256').update(canonicalPackage(value)).digest('hex')}`;
const same = (left, right) =>
  canonicalPackage(left) === canonicalPackage(right);
const key = (...values) => JSON.stringify(values);
export function storyBackupInvalid() {
  const error = new Error(
    'Pilot backup: BACKUP_STORY_INVALID: family story history validation failed',
  );
  error.code = 'BACKUP_STORY_INVALID';
  throw error;
}

export function historicalStoryInstallationIds(payload) {
  const identities = new Set([payload.sourceInstallationId]);
  for (const table of [
    'pilot_curriculum_publication',
    'pilot_placement_proposal',
    'pilot_learning_plan',
    'pilot_learning_plan_item',
    'pilot_curriculum_assignment',
    'pilot_curriculum_learning_run',
    'pilot_curriculum_runtime_run',
  ]) {
    for (const row of payload.tables[table] || [])
      identities.add(row.installation_id);
  }
  for (const row of payload.tables.pilot_curriculum_owner_decision || [])
    identities.add(row.target_installation_id);
  for (const row of payload.tables.pilot_curriculum_proof_receipt || []) {
    const receipt = JSON.parse(row.receipt_json);
    identities.add(receipt.targetInstallationId);
    identities.add(receipt.evidenceInstallationId);
  }
  return identities;
}
function check(condition) {
  if (!condition) storyBackupInvalid();
}
function json(value) {
  try {
    const parsed = JSON.parse(value);
    check(canonicalPackage(parsed) === value);
    return parsed;
  } catch {
    storyBackupInvalid();
  }
}
function unique(set, value) {
  check(!set.has(value));
  set.add(value);
}
function map(rows, column = 'id') {
  const result = new Map();
  for (const row of rows) {
    check(!result.has(row[column]));
    result.set(row[column], row);
  }
  return result;
}
function operation(kind, actorId, installationId, resourceId, request) {
  return {
    schemaVersion: `r3-${kind}-request-1`,
    actorId,
    installationId,
    resourceId,
    request,
  };
}
function match(left, right, columns) {
  check(right && columns.every((column) => left[column] === right[column]));
}
function validScope(scope) {
  check(
    exact(scope, ['kind', 'members']) &&
      scope.kind === 'supervised-trial' &&
      Array.isArray(scope.members) &&
      scope.members.length > 0 &&
      scope.members.length <= 100,
  );
  const children = new Set();
  for (const member of scope.members) {
    check(
      exact(member, ['childId', 'parentId', 'planScope']) &&
        text(member.childId) &&
        text(member.parentId) &&
        member.planScope === 'forest-01-v4',
    );
    unique(children, member.childId);
  }
  check(
    same(
      scope.members,
      [...scope.members].sort(
        (a, b) =>
          a.childId.localeCompare(b.childId) ||
          a.parentId.localeCompare(b.parentId),
      ),
    ),
  );
  return scope;
}
function request(row, kind, actorId, installationId, resourceId, fields) {
  const envelope = json(row.request_json);
  check(
    exact(envelope, [
      'schemaVersion',
      'actorId',
      'installationId',
      'resourceId',
      'request',
    ]) && exact(envelope.request, fields),
  );
  check(
    same(
      envelope,
      operation(kind, actorId, installationId, resourceId, envelope.request),
    ) && row.request_digest === hash(envelope),
  );
  return envelope.request;
}
function checkReceipt(row) {
  const receipt = json(row.receipt_json);
  check(
    exact(receipt, [
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
    ]),
  );
  check(
    receipt.schemaVersion === 'r3-proof-receipt-1' &&
      receipt.schemaVersion === row.receipt_version &&
      receipt.receiptId === row.id &&
      receipt.issuerId === row.issuer_id &&
      receipt.issuedAt === row.issued_at &&
      receipt.namespace === row.namespace &&
      receipt.syntheticOnly === true,
  );
  check(
    receipt.lessonVersion === 'forest-01-v4' &&
      receipt.canonicalizationVersion === 's3-json-1' &&
      receipt.adapterId === 'forest-story' &&
      receipt.adapterVersion === 'forest-story-v1',
  );
  check(
    [
      'receiptId',
      'issuerId',
      'candidateId',
      'buildId',
      'evidenceInstallationId',
      'targetInstallationId',
      'namespace',
    ].every((name) => text(receipt[name])) &&
      ['sourceDigest', 'artifactDigest', 'contentDigest', 'reportDigest'].every(
        (name) => DIGEST.test(receipt[name]),
      ),
  );
  check(
    integer(receipt.issuedAt) &&
      receipt.issuedAt <= row.accepted_at + 300000 &&
      hash(receipt) === row.receipt_digest &&
      /^[A-Za-z0-9_-]{86}$/u.test(row.signature),
  );
  check(
    Array.isArray(receipt.scenarios) &&
      receipt.scenarios.length === REQUIRED_SCENARIOS.length,
  );
  const scenarios = new Set();
  for (const scenario of receipt.scenarios) {
    check(
      exact(scenario, ['id', 'outcome', 'evidenceDigest']) &&
        REQUIRED_SCENARIOS.includes(scenario.id) &&
        scenario.outcome === 'PASS' &&
        DIGEST.test(scenario.evidenceDigest),
    );
    unique(scenarios, scenario.id);
  }
  const issuer = json(row.accepted_issuer_json);
  check(
    exact(issuer, [
      'issuerId',
      'publicKeyJwk',
      'notBefore',
      'revokedAt',
      'purpose',
    ]) &&
      issuer.issuerId === row.issuer_id &&
      integer(issuer.notBefore) &&
      issuer.notBefore <= receipt.issuedAt &&
      issuer.revokedAt === null &&
      ['release', 'candidate'].includes(issuer.purpose),
  );
  check(
    object(issuer.publicKeyJwk) &&
      issuer.publicKeyJwk.kty === 'OKP' &&
      issuer.publicKeyJwk.crv === 'Ed25519' &&
      text(issuer.publicKeyJwk.x) &&
      !Object.hasOwn(issuer.publicKeyJwk, 'd'),
  );
  return { row, receipt, issuer };
}

/** Checks captured historical facts, never present-day release eligibility. */
export function validateStoryRows(payload) {
  const tables = payload.tables;
  for (const table of STORY_TABLES) {
    check(Array.isArray(tables[table]));
    for (const row of tables[table]) {
      check(exact(row, STORY_COLUMNS[table]));
      for (const [name, value] of Object.entries(row)) {
        if (value === null) {
          check(NULLABLE[table]?.includes(name));
          continue;
        }
        check(INTEGERS.has(name) ? integer(value) : text(value));
        if (name.endsWith('_digest')) check(DIGEST.test(value));
        if (name.endsWith('_json')) json(value);
      }
    }
  }
  const users = map(tables.pilot_auth_user);
  const packages = map(tables.pilot_curriculum_package, 'lesson_version');
  const reviews = map(tables.pilot_curriculum_review, 'review_id');
  const proofs = map(tables.pilot_curriculum_proof_receipt);
  const decisions = map(tables.pilot_curriculum_owner_decision);
  const publications = map(tables.pilot_curriculum_publication);
  const proposals = map(tables.pilot_placement_proposal);
  const plans = map(tables.pilot_learning_plan);
  const items = map(tables.pilot_learning_plan_item);
  const assignments = map(tables.pilot_curriculum_assignment);
  const runs = map(tables.pilot_curriculum_learning_run);
  const userRole = (id, role) => users.get(id)?.role === role;
  const receipts = [...proofs.values()].map(checkReceipt);
  const receiptById = new Map(receipts.map((entry) => [entry.row.id, entry]));
  const proofDigests = new Set();
  for (const entry of receipts) unique(proofDigests, entry.row.receipt_digest);
  for (const row of decisions.values()) {
    check(
      userRole(row.recorded_by, 'operator') &&
        ['accepted', 'rejected'].includes(row.decision),
    );
    check(
      packages.get(row.lesson_version)?.content_digest === row.content_digest,
    );
    const body = request(
      row,
      'owner',
      row.recorded_by,
      row.target_installation_id,
      row.lesson_version,
      [
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
      ],
    );
    check(
      body.requestId === row.id &&
        body.contentDigest === row.content_digest &&
        body.candidateId === row.candidate_id &&
        body.artifactDigest === row.artifact_digest &&
        body.targetInstallationId === row.target_installation_id &&
        body.ownerIdentity === row.owner_identity &&
        body.decision === row.decision &&
        body.decidedAt === row.decided_at &&
        body.evidenceRef === row.evidence_ref &&
        hash(validScope(body.scope)) === row.scope_digest,
    );
    check(packages.get(row.lesson_version).test_run_id === row.test_run_id);
  }
  const members = new Map(),
    memberKeys = new Set();
  for (const row of tables.pilot_curriculum_trial_member) {
    const publication = publications.get(row.publication_id);
    check(
      publication &&
        userRole(row.child_id, 'child') &&
        userRole(row.parent_id, 'parent') &&
        row.plan_scope === publication.lesson_version,
    );
    unique(memberKeys, key(row.publication_id, row.child_id));
    const list = members.get(row.publication_id) || [];
    list.push(row);
    members.set(row.publication_id, list);
  }
  const chains = new Map(),
    publicationRequests = new Set(),
    activeUntil = new Map(),
    proofUses = [];
  const publicationAudits = map(
    tables.pilot_curriculum_publication_audit,
    'publication_id',
  );
  map(tables.pilot_curriculum_publication_audit);
  for (const row of publications.values()) {
    const pkg = packages.get(row.lesson_version);
    check(
      pkg?.content_digest === row.content_digest &&
        row.lesson_version === 'forest-01-v4' &&
        pkg.test_run_id === row.test_run_id &&
        userRole(row.actor_id, 'operator') &&
        row.generation >= 1 &&
        ['released', 'rejected', 'withdrawn'].includes(row.status),
    );
    check(
      row.scope_kind ===
        (row.test_run_id === null ? 'supervised-trial' : 'verification'),
    );
    const body = request(
      row,
      'publication',
      row.actor_id,
      row.installation_id,
      row.lesson_version,
      [
        'requestId',
        'expectedRevision',
        'predecessorId',
        'contentDigest',
        'reviewId',
        'proofId',
        'ownerDecisionId',
        'status',
        'scope',
      ],
    );
    check(
      body.requestId === row.request_id &&
        body.expectedRevision === row.generation - 1 &&
        body.predecessorId === row.predecessor_id &&
        body.contentDigest === row.content_digest &&
        body.reviewId === row.review_id &&
        body.proofId === row.proof_id &&
        body.ownerDecisionId === row.owner_decision_id &&
        body.status === row.status,
    );
    check(hash(validScope(body.scope)) === row.scope_digest);
    const expectedMembers = [...(members.get(row.id) || [])]
      .sort(
        (a, b) =>
          a.child_id.localeCompare(b.child_id) ||
          a.parent_id.localeCompare(b.parent_id),
      )
      .map((member) => ({
        childId: member.child_id,
        parentId: member.parent_id,
        planScope: member.plan_scope,
      }));
    check(same(body.scope.members, expectedMembers));
    check(
      same(json(row.ack_json), {
        publicationId: row.id,
        generation: row.generation,
        revision: row.generation,
        status: row.status,
      }),
    );
    unique(publicationRequests, key(row.installation_id, row.request_id));
    const audit = publicationAudits.get(row.id);
    check(
      audit &&
        audit.actor_id === row.actor_id &&
        audit.action === row.status &&
        audit.request_id === row.request_id &&
        audit.created_at === row.created_at,
    );
    const review = row.review_id === null ? null : reviews.get(row.review_id);
    const proof = row.proof_id === null ? null : receiptById.get(row.proof_id);
    const owner =
      row.owner_decision_id === null
        ? null
        : decisions.get(row.owner_decision_id);
    if (row.scope_kind === 'supervised-trial')
      check(review && proof && owner && proof.issuer.purpose === 'release');
    if (row.review_id !== null)
      check(
        review &&
          review.lesson_version === row.lesson_version &&
          review.content_digest === row.content_digest &&
          review.test_run_id === row.test_run_id &&
          review.decision === 'approved' &&
          integer(review.recorded_at) &&
          review.recorded_at <= row.created_at,
      );
    if (row.proof_id !== null)
      check(
        proof &&
          proof.receipt.lessonVersion === row.lesson_version &&
          proof.receipt.contentDigest === row.content_digest &&
          proof.receipt.targetInstallationId === row.installation_id &&
          proof.receipt.candidateId === row.candidate_id &&
          proof.receipt.artifactDigest === row.artifact_digest &&
          proof.row.accepted_at <= row.created_at &&
          (row.test_run_id === null ||
            proof.receipt.namespace === row.test_run_id),
      );
    if (row.owner_decision_id !== null)
      check(
        owner &&
          owner.decision === 'accepted' &&
          owner.lesson_version === row.lesson_version &&
          owner.content_digest === row.content_digest &&
          owner.candidate_id === row.candidate_id &&
          owner.artifact_digest === row.artifact_digest &&
          owner.target_installation_id === row.installation_id &&
          owner.scope_digest === row.scope_digest &&
          owner.test_run_id === row.test_run_id &&
          owner.decided_at <= row.created_at,
      );
    const chainKey = key(row.installation_id, row.lesson_version);
    const chain = chains.get(chainKey) || [];
    chain.push(row);
    chains.set(chainKey, chain);
  }
  check(publicationAudits.size === publications.size);
  const heads = new Map();
  for (const row of tables.pilot_curriculum_publication_state) {
    const identity = key(row.installation_id, row.lesson_version);
    check(!heads.has(identity));
    heads.set(identity, row);
  }
  check(heads.size === chains.size);
  for (const [chainKey, chain] of chains) {
    chain.sort((a, b) => a.generation - b.generation);
    for (let index = 0; index < chain.length; index++) {
      const current = chain[index],
        previous = chain[index - 1];
      check(
        current.generation === index + 1 &&
          current.predecessor_id === (previous?.id ?? null),
      );
      check(
        previous
          ? current.created_at >= previous.created_at
          : current.status === 'released',
      );
      if (current.status !== 'released') {
        check(previous);
        match(current, previous, [
          'content_digest',
          'scope_kind',
          'scope_digest',
          'review_id',
          'proof_id',
          'owner_decision_id',
          'candidate_id',
          'artifact_digest',
          'test_run_id',
        ]);
      }
      const laterReview =
        current.review_id === null
          ? null
          : [...reviews.values()].find(
              (review) => review.previous_review_id === current.review_id,
            );
      activeUntil.set(
        current.id,
        Math.min(
          chain[index + 1]?.created_at ?? Infinity,
          laterReview?.recorded_at ?? Infinity,
        ),
      );
    }
    const head = heads.get(chainKey),
      latest = chain.at(-1);
    check(
      head?.latest_publication_id === latest.id &&
        head.revision === latest.generation,
    );
  }
  const validAt = (publicationId, at) => {
    const publication = publications.get(publicationId);
    // Millisecond ties cannot order two distinct committed operations. The live
    // write predicate supplies that ordering; strictly later history is impossible.
    check(
      publication?.status === 'released' &&
        at >= publication.created_at &&
        at <= activeUntil.get(publicationId),
    );
    if (publication.proof_id !== null)
      proofUses.push({ proofId: publication.proof_id, at });
  };
  for (const publication of publications.values())
    if (publication.status === 'released')
      validAt(publication.id, publication.created_at);
  const proposalSources = new Set();
  for (const row of proposals.values()) {
    const pub = publications.get(row.publication_id);
    match(row, pub, [
      'installation_id',
      'lesson_version',
      'content_digest',
      'test_run_id',
    ]);
    check(
      pub.status === 'released' &&
        userRole(row.child_id, 'child') &&
        members
          .get(pub.id)
          ?.some((member) => member.child_id === row.child_id) &&
        row.created_at >= pub.created_at,
    );
    validAt(pub.id, row.created_at);
    check(
      row.policy_version === 'r3-placement-1' &&
        row.expires_at === row.created_at + 86400000,
    );
    const source = json(row.source_json);
    check(
      exact(source, [
        'schemaVersion',
        'childId',
        'installationId',
        'policyVersion',
        'onboardingDigest',
        'evidenceDigest',
        'publicationId',
        'lessonVersion',
        'contentDigest',
        'reason',
        'createdAt',
      ]),
    );
    check(
      same(source, {
        schemaVersion: 'r3-placement-source-1',
        childId: row.child_id,
        installationId: row.installation_id,
        policyVersion: row.policy_version,
        onboardingDigest: row.onboarding_digest,
        evidenceDigest: row.evidence_digest,
        publicationId: row.publication_id,
        lessonVersion: row.lesson_version,
        contentDigest: row.content_digest,
        reason: source.reason,
        createdAt: row.created_at,
      }) &&
        text(source.reason) &&
        hash(source) === row.source_digest,
    );
    check(same(json(row.reason_json), { text: source.reason }));
    unique(
      proposalSources,
      key(row.child_id, row.installation_id, row.source_digest),
    );
  }
  const approvedProposals = new Set(),
    itemPlans = new Set(),
    assignmentItems = new Set();
  for (const row of plans.values()) {
    const proposal = proposals.get(row.proposal_id);
    match(row, proposal, [
      'child_id',
      'installation_id',
      'policy_version',
      'source_digest',
      'test_run_id',
    ]);
    check(
      userRole(row.parent_id, 'parent') &&
        row.approved_at >= proposal.created_at &&
        row.approved_at < proposal.expires_at &&
        members
          .get(proposal.publication_id)
          ?.some(
            (member) =>
              member.child_id === row.child_id &&
              member.parent_id === row.parent_id,
          ),
    );
    validAt(proposal.publication_id, row.approved_at);
    unique(approvedProposals, row.proposal_id);
  }
  for (const row of items.values()) {
    const plan = plans.get(row.plan_id);
    match(row, plan, ['child_id', 'installation_id']);
    const proposal = proposals.get(plan.proposal_id);
    match(row, proposal, [
      'publication_id',
      'lesson_version',
      'content_digest',
      'reason_json',
    ]);
    check(row.ordinal === 0);
    unique(itemPlans, row.plan_id);
  }
  check(itemPlans.size === plans.size);
  for (const row of assignments.values()) {
    const item = items.get(row.plan_item_id);
    match(row, item, [
      'child_id',
      'installation_id',
      'lesson_version',
      'content_digest',
      'publication_id',
    ]);
    const plan = plans.get(item.plan_id);
    check(
      row.created_at === plan.approved_at &&
        row.test_run_id === plan.test_run_id,
    );
    unique(assignmentItems, row.plan_item_id);
  }
  check(assignmentItems.size === items.size);
  const schedules = new Map();
  map(tables.pilot_learning_schedule);
  for (const row of tables.pilot_learning_schedule) {
    const assignment = assignments.get(row.assignment_id);
    check(
      assignment &&
        assignment.child_id === row.child_id &&
        ['initial', 'delayed-review'].includes(row.kind) &&
        row.policy_version === 'r3-review-24h-1',
    );
    const identity = key(row.assignment_id, row.kind);
    check(!schedules.has(identity));
    schedules.set(identity, row);
    if (row.kind === 'initial')
      check(
        row.due_at === assignment.created_at &&
          row.created_at === assignment.created_at,
      );
  }
  for (const row of assignments.values())
    check(schedules.has(key(row.id, 'initial')));
  const assignmentRuns = new Set(),
    starts = new Set(),
    entries = new Map();
  for (const row of runs.values()) {
    const assignment = assignments.get(row.assignment_id);
    match(row, assignment, [
      'child_id',
      'installation_id',
      'lesson_version',
      'content_digest',
      'publication_id',
      'test_run_id',
    ]);
    check(
      row.seed <= 0xffffffff &&
        row.adapter_id === 'forest-story' &&
        row.adapter_version === 'forest-story-v1' &&
        row.created_at >= assignment.created_at &&
        row.updated_at >= row.created_at,
    );
    validAt(row.publication_id, row.created_at);
    unique(assignmentRuns, row.assignment_id);
    unique(
      starts,
      key(row.child_id, row.installation_id, row.start_request_id),
    );
    check(
      row.start_request_digest ===
        hash(
          operation(
            'start',
            row.child_id,
            row.installation_id,
            row.assignment_id,
            { requestId: row.start_request_id },
          ),
        ),
    );
    check(
      same(json(row.start_ack_json), {
        runId: row.id,
        assignmentId: row.assignment_id,
        lessonVersion: 'forest-01-v4',
        revision: 0,
      }),
    );
    const run = json(row.run_json);
    check(
      run.runId === row.id &&
        run.lessonVersion === row.lesson_version &&
        run.contentDigest === row.content_digest &&
        run.adapterId === row.adapter_id &&
        run.adapterVersion === row.adapter_version &&
        run.seed === row.seed &&
        run.revision === row.revision &&
        run.createdAt === new Date(row.created_at).toISOString() &&
        run.updatedAt === new Date(row.updated_at).toISOString(),
    );
    entries.set(row.id, {
      row,
      run,
      manifest: JSON.parse(packages.get(row.lesson_version).manifest_json),
      ledger: [],
      eventIds: new Set(),
      events: [],
      audits: [],
    });
  }
  const eventRows = map(tables.pilot_curriculum_learning_event);
  for (const row of eventRows.values()) {
    const saved = entries.get(row.run_id);
    check(
      saved && row.sequence >= 1 && row.expected_revision === row.sequence - 1,
    );
    validAt(saved.row.publication_id, row.server_at);
    unique(saved.eventIds, row.event_id);
    const action = json(row.action_json),
      result = json(row.result_json);
    check(
      exact(action, [
        'eventId',
        'expectedRevision',
        'stepId',
        'type',
        'payload',
      ]) &&
        action.eventId === row.event_id &&
        action.expectedRevision === row.expected_revision,
    );
    check(
      row.request_digest ===
        hash(
          operation(
            'action',
            saved.row.child_id,
            saved.row.installation_id,
            row.run_id,
            action,
          ),
        ),
    );
    check(
      exact(result, ['event', 'ack', 'policy']) &&
        exact(result.policy, ['soundReview']),
    );
    check(
      result.policy.soundReview ===
        (saved.row.test_run_id === null ? 'reviewed' : 'synthetic'),
    );
    check(
      result.event.eventId === row.event_id &&
        result.event.runId === row.run_id &&
        result.event.sequence === row.sequence &&
        result.event.serverTime === new Date(row.server_at).toISOString(),
    );
    saved.events.push(row);
    saved.ledger.push({
      action,
      result,
      serverAt: new Date(row.server_at).toISOString(),
    });
  }
  const approvedAudits = new Set();
  map(tables.pilot_curriculum_learning_audit);
  for (const row of tables.pilot_curriculum_learning_audit) {
    if (row.action === 'plan-approval') {
      const plan = plans.get(row.plan_id);
      check(
        plan &&
          row.run_id === null &&
          row.event_id === null &&
          row.revision === null &&
          row.actor_id === plan.parent_id &&
          row.created_at === plan.approved_at,
      );
      unique(approvedAudits, row.plan_id);
    } else {
      const saved = entries.get(row.run_id);
      check(
        saved &&
          row.plan_id === null &&
          row.actor_id === saved.row.child_id &&
          ['run-start', 'run-action'].includes(row.action),
      );
      saved.audits.push(row);
    }
  }
  check(approvedAudits.size === plans.size);
  for (const saved of entries.values()) {
    const { row, run, events, audits, ledger } = saved;
    events.sort((a, b) => a.sequence - b.sequence);
    audits.sort((a, b) => a.revision - b.revision);
    ledger.sort(
      (a, b) => a.action.expectedRevision - b.action.expectedRevision,
    );
    check(events.length === row.revision && audits.length === row.revision + 1);
    check(
      audits[0]?.action === 'run-start' &&
        audits[0].event_id === null &&
        audits[0].revision === 0 &&
        audits[0].created_at === row.created_at,
    );
    for (let index = 0; index < events.length; index++) {
      const event = events[index],
        audit = audits[index + 1];
      check(
        event.sequence === index + 1 &&
          event.server_at >= (events[index - 1]?.server_at ?? row.created_at),
      );
      check(
        audit.action === 'run-action' &&
          audit.revision === index + 1 &&
          audit.event_id === event.id &&
          audit.created_at === event.server_at,
      );
    }
    const later = schedules.get(key(row.assignment_id, 'delayed-review'));
    if (run.state.completedAt === null) check(!later);
    else
      check(
        later &&
          later.created_at === Date.parse(run.state.completedAt) &&
          later.due_at === later.created_at + 86400000,
      );
  }
  for (const schedule of schedules.values())
    if (schedule.kind === 'delayed-review')
      check(assignmentRuns.has(schedule.assignment_id));
  return { receipts, entries: [...entries.values()], proofUses };
}

export async function validateStorySemantics(saved, archiveIssuers) {
  try {
    check(Array.isArray(archiveIssuers));
    const archive = map(archiveIssuers, 'issuerId');
    for (const { row, receipt, issuer } of saved.receipts) {
      const trusted = archive.get(issuer.issuerId);
      // Public keys in the backup never create trust. Later revocation preserves history.
      check(
        trusted &&
          trusted.issuerId === issuer.issuerId &&
          trusted.purpose === issuer.purpose &&
          trusted.notBefore === issuer.notBefore &&
          same(trusted.publicKeyJwk, issuer.publicKeyJwk) &&
          !Object.hasOwn(trusted.publicKeyJwk, 'd'),
      );
      check(
        trusted.revokedAt === null ||
          (integer(trusted.revokedAt) &&
            trusted.revokedAt >= trusted.notBefore &&
            receipt.issuedAt < trusted.revokedAt &&
            row.accepted_at < trusted.revokedAt),
      );
      if (trusted.revokedAt !== null)
        check(
          saved.proofUses
            .filter((use) => use.proofId === row.id)
            .every((use) => use.at <= trusted.revokedAt),
        );
      const publicKey = crypto.createPublicKey({
        key: trusted.publicKeyJwk,
        format: 'jwk',
      });
      check(
        crypto.verify(
          null,
          Buffer.from(canonicalPackage(receipt)),
          publicKey,
          Buffer.from(row.signature, 'base64url'),
        ),
      );
    }
    const compiled = new Map();
    for (const { row, run, manifest, ledger } of saved.entries) {
      if (!compiled.has(row.content_digest))
        compiled.set(row.content_digest, await compileStoryPackage(manifest));
      const lesson = compiled.get(row.content_digest);
      check(lesson.identity.contentDigest === row.content_digest);
      replayStoryRun(lesson, run, ledger);
    }
  } catch {
    storyBackupInvalid();
  }
}
