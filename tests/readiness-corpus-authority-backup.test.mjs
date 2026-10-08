import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import { corpusRequest } from '../lib/pilot/corpus-policy.ts';
import { validateCorpusAuthorityFacts as validate } from '../scripts/pilot-corpus-authority-backup.mjs';
// Controlled stage-unit premises. Supplied dependency maps represent prior validated
// stages; these are not real consent, human review or signed publication evidence.
const d = 'sha256:' + 'a'.repeat(64);
async function model() {
  const plan = {
    corpusVersion: 'corpus-v1',
    corpusDigest: d,
    installationId: 'old-install',
    namespace: null,
    lane: 'ordinary',
    candidateId: 'candidate',
    sourceDigest: d,
    artifactDigest: d,
    buildId: 'build',
    packages: [],
    releasedPackages: [],
    counts: { includedCharacterCount: 0 },
  };
  const scope = { kind: 'starter' };
  const body = {
    requestId: 'request',
    snapshotId: 'snapshot',
    corpusDigest: d,
    candidateId: 'candidate',
    sourceDigest: d,
    artifactDigest: d,
    scope,
    decision: 'rejected',
  };
  const request = corpusRequest(
    'owner-decision',
    'owner',
    'old-install',
    'corpus-v1',
    body,
  );
  const row = {
    id: 'decision',
    snapshot_id: 'snapshot',
    corpus_digest: d,
    installation_id: 'old-install',
    candidate_id: 'candidate',
    source_digest: d,
    artifact_digest: d,
    scope_json: json(scope),
    scope_digest: await H(scope),
    decision: 'rejected',
    actor_id: 'owner',
    owner_session_id: 'original-expired-session',
    request_id: 'request',
    request_json: json(request),
    request_digest: await H(request),
    ack_json: json({
      requestId: 'request',
      recordId: 'decision',
      recordedAt: new Date(2000).toISOString(),
    }),
    decided_at: 2000,
    test_run_id: null,
  };
  const payload = {
    tables: {
      pilot_auth_user: [{ id: 'owner', role: 'child', disabled: 1 }],
      pilot_corpus_owner_decision: [row],
      pilot_corpus_publication: [],
      pilot_corpus_publication_state: [],
      pilot_corpus_publication_audit: [],
      pilot_corpus_trial_member: [],
      pilot_curriculum_review: [],
    },
  };
  return {
    payload,
    deps: {
      registry: { sources: new Map() },
      proofs: new Map(),
      snapshots: new Map([
        [
          'snapshot',
          {
            row: {
              id: 'snapshot',
              status: 'sealed',
              created_at: 1000,
              sealed_at: 1500,
            },
            plan,
          },
        ],
      ]),
    },
    row,
    plan,
  };
}
test('original rejected pending decision survives current role/session changes', async () => {
  const f = await model();
  const r = await validate(f.payload, f.deps);
  assert.equal(r.owners.size, 1);
});
for (const [name, change] of [
  [
    'changed owner request digest',
    (f) => {
      f.row.request_digest = d;
    },
  ],
  [
    'changed scope digest',
    (f) => {
      f.row.scope_digest = d;
    },
  ],
  [
    'forged immutable ack',
    (f) => {
      f.row.ack_json = json({
        requestId: 'request',
        recordId: 'other',
        recordedAt: new Date(2000).toISOString(),
      });
    },
  ],
  [
    'decision before seal',
    (f) => {
      f.row.decided_at = 1400;
    },
  ],
  [
    'pending accepted starter',
    (f) => {
      f.row.decision = 'accepted';
      const r = JSON.parse(f.row.request_json);
      r.request.decision = 'accepted';
      f.row.request_json = json(r);
      return H(r).then((h) => {
        f.row.request_digest = h;
      });
    },
  ],
  [
    'missing historical actor',
    (f) => {
      f.payload.tables.pilot_auth_user = [];
    },
  ],
])
  test(name, async () => {
    const f = await model();
    await change(f);
    await assert.rejects(validate(f.payload, f.deps), /BACKUP_CORPUS_INVALID/);
  });
async function groupModel({ ordinary = false } = {}) {
  const f = await model();
  const p = f.plan;
  p.lane = ordinary ? 'ordinary' : 'verification';
  p.namespace = ordinary ? null : 'verification-origin';
  p.counts.includedCharacterCount = 2;
  const eligibility = {
    targets: [
      { sourceEvidenceId: 'source-a' },
      { sourceEvidenceId: 'source-b' },
    ],
    realEligible: ordinary,
    machineUsableVerification: !ordinary,
    review: ordinary ? { reviewId: 'review' } : null,
    proof: ordinary ? { proofId: 'proof' } : null,
  };
  p.packages = [
    {
      lessonVersion: 'lesson-v1',
      contentDigest: d,
      packageEligibility: eligibility,
    },
  ];
  p.releasedPackages = [{ lessonVersion: 'lesson-v1', contentDigest: d }];
  for (const id of ['source-a', 'source-b'])
    f.deps.registry.sources.set(id, {
      id,
      created_at: 500,
      supersedes_id: null,
    });
  if (ordinary) {
    f.payload.tables.pilot_curriculum_review = [
      {
        review_id: 'review',
        lesson_version: 'lesson-v1',
        review_sequence: 1,
        recorded_at: 600,
      },
    ];
    f.deps.proofs.set('proof', {
      row: { received_at: 700 },
      issuer: { revokedAt: null },
    });
  }
  f.payload.tables.pilot_auth_user.push(
    { id: 'parent', role: 'teacher', disabled: 1 },
    { id: 'child', role: 'operator', disabled: 1 },
  );
  const sc = ordinary
    ? {
        kind: 'supervised-trial',
        members: [{ parentId: 'parent', childId: 'child' }],
      }
    : {
        kind: 'verification',
        namespace: p.namespace,
        members: [{ parentId: 'parent', childId: 'child' }],
      };
  if (ordinary) {
    const o = f.row;
    o.decision = 'accepted';
    o.scope_json = json(sc);
    o.scope_digest = await H(sc);
    const r = JSON.parse(o.request_json);
    r.request.scope = sc;
    r.request.decision = 'accepted';
    o.request_json = json(r);
    o.request_digest = await H(r);
  } else f.payload.tables.pilot_corpus_owner_decision = [];
  async function generation(id, revision, status, at, predecessor) {
    const body = {
      requestId: 'request-' + id,
      ...(status === 'released'
        ? {
            snapshotId: 'snapshot',
            ownerDecisionId: ordinary ? 'decision' : null,
          }
        : {}),
      expectedRevision: revision - 1,
      predecessorPublicationId: predecessor,
    };
    const e = corpusRequest(
      'publication',
      'owner',
      'old-install',
      'corpus-v1',
      body,
    );
    const row = {
      id,
      corpus_version: 'corpus-v1',
      corpus_digest: d,
      snapshot_id: 'snapshot',
      installation_id: 'old-install',
      namespace_key: ordinary ? 'ordinary' : p.namespace,
      revision,
      predecessor_id: predecessor,
      status,
      scope_kind: sc.kind,
      scope_json: json(sc),
      scope_digest: await H(sc),
      owner_decision_id: ordinary ? 'decision' : null,
      actor_id: 'owner',
      request_id: body.requestId,
      request_json: json(e),
      request_digest: await H(e),
      ack_json: json({
        requestId: body.requestId,
        recordId: id,
        recordedAt: new Date(at).toISOString(),
        revision,
        corpusDigest: d,
        snapshotId: 'snapshot',
      }),
      created_at: at,
      test_run_id: ordinary ? null : p.namespace,
    };
    f.payload.tables.pilot_corpus_publication.push(row);
    f.payload.tables.pilot_corpus_trial_member.push({
      publication_id: id,
      installation_id: 'old-install',
      parent_id: 'parent',
      child_id: 'child',
    });
    f.payload.tables.pilot_corpus_publication_audit.push({
      id: 'audit-' + id,
      publication_id: id,
      actor_id: 'owner',
      action: status,
      request_id: body.requestId,
      created_at: at,
    });
    f.payload.tables.pilot_corpus_publication_state = [
      {
        corpus_version: 'corpus-v1',
        installation_id: 'old-install',
        namespace_key: row.namespace_key,
        revision,
        latest_publication_id: id,
        updated_at: at,
      },
    ];
    return row;
  }
  f.generation = generation;
  await generation('first', 1, 'released', 2100, null);
  return f;
}
test('historical verification chain retains original scope, and equality does not invent ordering', async () => {
  const f = await groupModel();
  await f.generation('second', 2, 'withdrawn', 2200, 'first');
  await f.generation('third', 3, 'released', 2300, 'second');
  const r = await validate(f.payload, f.deps);
  assert.equal(r.publications.size, 3);
  assert.equal(r.heads.size, 1);
  assert.equal(r.validAt('first', 2199, 'child', 'parent', 'lesson-v1'), true);
  assert.equal(r.validAt('first', 2200, 'child', 'parent', 'lesson-v1'), true);
  assert.equal(r.validAt('first', 2201, 'child', 'parent', 'lesson-v1'), false);
  assert.equal(r.validAt('third', 2400, 'child', 'wrong', 'lesson-v1'), false);
  assert.equal(r.validAt('third', 2400, 'child', 'parent', 'unknown'), false);
});
test('positive ordinary stage premise validates attribution, not current disabled roles', async () => {
  const f = await groupModel({ ordinary: true });
  const r = await validate(f.payload, f.deps);
  assert.equal(r.owners.size, 1);
  assert.equal(r.validAt('first', 2100, 'child', 'parent', 'lesson-v1'), true);
});
test('strictly later source correction affects selected package at historical cutoff', async () => {
  const f = await groupModel();
  f.deps.registry.sources.set('new', {
    id: 'new',
    supersedes_id: 'source-b',
    created_at: 2200,
  });
  const r = await validate(f.payload, f.deps);
  assert.equal(r.validAt('first', 2200, 'child', 'parent', 'lesson-v1'), true);
  assert.equal(r.validAt('first', 2201, 'child', 'parent', 'lesson-v1'), false);
});
test('proof effective revocation at publication refuses; later revocation preserves earlier group', async () => {
  const f = await groupModel({ ordinary: true });
  f.deps.proofs.get('proof').issuer.revokedAt = 2200;
  const r = await validate(f.payload, f.deps);
  assert.equal(r.validAt('first', 2199, 'child', 'parent', 'lesson-v1'), true);
  assert.equal(r.validAt('first', 2200, 'child', 'parent', 'lesson-v1'), false);
  f.deps.proofs.get('proof').issuer.revokedAt = 2100;
  await assert.rejects(validate(f.payload, f.deps), /BACKUP_CORPUS_INVALID/);
});
for (const [name, mutate] of [
  [
    'missing audit',
    (f) => f.payload.tables.pilot_corpus_publication_audit.pop(),
  ],
  [
    'missing exact trial pair',
    (f) => f.payload.tables.pilot_corpus_trial_member.pop(),
  ],
  [
    'orphan head',
    (f) => {
      f.payload.tables.pilot_corpus_publication_state[0].latest_publication_id =
        'other';
    },
  ],
  [
    'scope kind differs from immutable scope',
    (f) => {
      f.payload.tables.pilot_corpus_publication[0].scope_kind = 'starter';
    },
  ],
  [
    'second target missing',
    (f) => {
      f.deps.registry.sources.delete('source-b');
    },
  ],
  [
    'later review already accepted before publication',
    (f) => {
      f.payload.tables.pilot_curriculum_review.push({
        review_id: 'newreview',
        lesson_version: 'lesson-v1',
        review_sequence: 2,
        recorded_at: 2050,
      });
    },
  ],
])
  test(name, async () => {
    const f = await groupModel({ ordinary: true });
    mutate(f);
    await assert.rejects(validate(f.payload, f.deps), /BACKUP_CORPUS_INVALID/);
  });
test('canonical uppercase/lowercase member IDs retain backend codepoint order', async () => {
  const f = await groupModel();
  const row = f.payload.tables.pilot_corpus_publication[0];
  const members = [
    { parentId: 'A-parent', childId: 'A-child' },
    { parentId: 'a-parent', childId: 'a-child' },
  ];
  const sc = { kind: 'verification', namespace: f.plan.namespace, members };
  row.scope_json = json(sc);
  row.scope_digest = await H(sc);
  f.payload.tables.pilot_corpus_trial_member = members.map((m) => ({
    publication_id: row.id,
    installation_id: row.installation_id,
    parent_id: m.parentId,
    child_id: m.childId,
  }));
  f.payload.tables.pilot_auth_user.push(
    ...members.flatMap((m) => [{ id: m.parentId }, { id: m.childId }]),
  );
  const r = await validate(f.payload, f.deps);
  assert.deepEqual(
    JSON.parse(JSON.stringify(r.publications.get(row.id).scope.members)),
    members,
  );
  assert.equal(
    r.validAt(row.id, 2100, 'A-child', 'A-parent', 'lesson-v1'),
    true,
  );
});
