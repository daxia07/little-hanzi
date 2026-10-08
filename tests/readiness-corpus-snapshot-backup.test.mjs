import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import { corpusRequest } from '../lib/pilot/corpus-policy.ts';
import { evaluateSnapshotCandidate } from '../lib/pilot/corpus-snapshot-facts.ts';
import {
  buildSnapshotPlan,
  snapshotDigests,
  snapshotMemberFacts,
  inspectSnapshotPlan,
  intrinsicReasons,
} from '../lib/pilot/corpus-snapshot-policy.ts';
import { validateCorpusSnapshotFacts } from '../scripts/pilot-corpus-snapshot-backup.mjs';

// Stage-unit fixtures: these maps stand in for already validated registry/signature stages.
// Real pending package bytes are compiled; no service, database, issuer or acceptance is simulated.
const d = 'sha256:' + 'a'.repeat(64),
  at = 1000,
  actor = 'historical-operator';
async function fixture(options = {}) {
  const registry = {
      corpora: new Map(),
      sources: new Map(),
      packages: new Map(),
      documents: new Map(),
    },
    proofs = new Map();
  const tables = {
    pilot_auth_user: [{ id: actor, role: 'child', disabled: 1 }],
    pilot_curriculum_review: [],
    pilot_corpus_item: [],
    pilot_corpus_character: [],
    pilot_corpus_snapshot: [],
    pilot_corpus_snapshot_member: [],
  };
  const binding = {
    corpusVersion: 'historical-corpus',
    corpusDigest: d,
    installationId: 'old-install',
    namespace: options.verification ? 'verification-origin' : null,
    lane: options.verification ? 'verification' : 'ordinary',
    candidateId: 'old-candidate',
    sourceDigest: d,
    artifactDigest: d,
    buildId: 'old-build',
    evidenceEpoch: 47,
  };
  registry.corpora.set(binding.corpusVersion, {
    corpus_digest: d,
    imported_at: 0,
  });
  const candidates = [];
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    const document = JSON.parse(
        fs.readFileSync(
          new URL(
            `../content/curriculum/corpus/corpus-path-0${ordinal + 1}-v1.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ),
      contentDigest = await H(
        options.positive ? preparePositiveModel(document) : document,
      ),
      version = document.lessonVersion;
    registry.documents.set(version, document);
    registry.packages.set(version, {
      content_digest: contentDigest,
      imported_at: 0,
    });
    const classification = options.verification
      ? 'verification-fixture'
      : options.positive
        ? 'real-source-reviewed'
        : 'unverified-draft';
    const evidence = {
        lessonVersion: version,
        contentDigest,
        classification,
        sourceRefs: options.positive ? ['SYNTHETIC-MODEL-source'] : [],
        licenseRefs: options.positive ? ['SYNTHETIC-MODEL-license'] : [],
        identityReviews: options.positive
          ? document.characters.map((c) => ({
              characterId: c.characterId,
              hanzi: c.hanzi,
              kind: 'simplified',
              reviewRef: 'review-' + ordinal,
            }))
          : [],
      },
      source = {
        id: 'source-' + ordinal,
        lesson_version: version,
        content_digest: contentDigest,
        installation_id: 'old-install',
        created_at: 0,
        classification,
        evidence_json: json(evidence),
        evidence_digest: await H(evidence),
      };
    registry.sources.set(source.id, source);
    const chars = document.characters.map((c, target_index) => ({
      corpus_version: binding.corpusVersion,
      lesson_version: version,
      content_digest: contentDigest,
      character_id: c.characterId,
      target_index,
      requirements_digest: d,
      source_evidence_id: source.id,
      current_source_id: source.id,
    }));
    tables.pilot_corpus_character.push(...chars);
    tables.pilot_corpus_item.push({
      corpus_version: binding.corpusVersion,
      ordinal,
      lesson_version: version,
      content_digest: contentDigest,
    });
    let proof = null;
    if (options.proof) {
      const proofId = 'proof-' + ordinal,
        receipt = {
          candidateId: binding.candidateId,
          sourceDigest: d,
          artifactDigest: d,
          buildId: binding.buildId,
          targetInstallationId: binding.installationId,
          evidenceInstallationId: 'other-evidence-install',
          namespace: 'signed-origin',
          issuedAt: new Date(0).toISOString(),
        };
      const row = {
        id: proofId,
        corpus_version: binding.corpusVersion,
        corpus_digest: d,
        lesson_version: version,
        content_digest: contentDigest,
        installation_id: binding.installationId,
        received_at: 0,
        issued_at: 0,
        test_run_id: null,
        receipt_digest: d,
        namespace: receipt.namespace,
      };
      proofs.set(proofId, {
        row,
        receipt,
        issuer: {
          issuerId: 'archive-release-issuer',
          purpose: 'release',
          revokedAt: null,
        },
      });
      proof = {
        proofId,
        receiptDigest: d,
        issuerId: 'archive-release-issuer',
        purpose: 'release',
        issuedAt: receipt.issuedAt,
      };
    }
    const review = options.positive
      ? {
          review_id: 'review-' + ordinal,
          lesson_version: version,
          content_digest: contentDigest,
          review_sequence: 1,
          previous_review_id: null,
          decision: 'approved',
          reviewer_ref: 'SYNTHETIC-MODEL-reviewer',
          reviewed_at: 300000,
          checklist_version: 's3-content-review-1',
          checklist_json: json({ deviceAudio: true, content: true }),
          evidence_ref: 'SYNTHETIC-MODEL-evidence',
          reason: null,
          recorded_by_user_id: actor,
          recorded_at: 0,
          request_digest: d,
          write_id: 'review-write-' + ordinal,
          test_run_id: null,
        }
      : null;
    if (review) tables.pilot_curriculum_review.push(review);
    candidates.push(
      await evaluateSnapshotCandidate({
        ordinal,
        document,
        contentDigest,
        characters: chars,
        sources: [source],
        review,
        proof,
        installationId: binding.installationId,
        lane: binding.lane,
      }),
    );
  }
  const plan = await buildSnapshotPlan(binding, candidates),
    digests = await snapshotDigests(plan),
    id = 'historical-snapshot';
  const request = corpusRequest(
    'snapshot',
    actor,
    binding.installationId,
    binding.corpusVersion,
    { requestId: 'begin-original' },
  );
  const row = {
    id,
    corpus_version: binding.corpusVersion,
    corpus_digest: d,
    installation_id: binding.installationId,
    candidate_id: binding.candidateId,
    source_digest: d,
    artifact_digest: d,
    evidence_epoch: 47,
    plan_json: json(plan),
    plan_digest: digests.planDigest,
    expected_member_digest: digests.expectedMemberDigest,
    expected_included_count: plan.counts.includedCharacterCount,
    expected_exclusion_count: plan.counts.excludedTargetCount,
    expected_package_count: plan.counts.packageCount,
    released_package_digest: digests.releasedPackageDigest,
    status: 'sealed',
    created_by: actor,
    request_id: 'begin-original',
    request_json: json(request),
    request_digest: await H(request),
    ack_json: json({
      requestId: 'begin-original',
      snapshotId: id,
      status: 'building',
      recordedAt: new Date(at).toISOString(),
      packageCount: 2,
      targetCount: 4,
    }),
    created_at: at,
    test_run_id: binding.namespace,
  };
  for (const p of plan.packages) {
    const chunkRequestId = 'chunk-' + p.ordinal,
      chunkRequest = corpusRequest(
        'snapshot-chunk',
        actor,
        binding.installationId,
        id,
        {
          requestId: chunkRequestId,
          packages: [
            { lessonVersion: p.lessonVersion, contentDigest: p.contentDigest },
          ],
        },
      );
    tables.pilot_corpus_snapshot_member.push(
      ...snapshotMemberFacts(plan)
        .filter((m) => m.lesson_version === p.lessonVersion)
        .map((m) => ({
          snapshot_id: id,
          ...m,
          chunk_request_id: chunkRequestId,
          chunk_request_json: json(chunkRequest),
          chunk_digest: null,
          chunk_ack_json: json({
            requestId: chunkRequestId,
            snapshotId: id,
            packageCount: 1,
            targetRowCount: 2,
            recordedAt: new Date(at + 1).toISOString(),
          }),
          chunk_recorded_at: at + 1,
        })),
    );
    for (const m of tables.pilot_corpus_snapshot_member.filter(
      (m) => m.chunk_request_id === chunkRequestId,
    ))
      m.chunk_digest = await H(chunkRequest);
  }
  const seal = corpusRequest(
    'snapshot-seal',
    actor,
    binding.installationId,
    id,
    { requestId: 'seal-original', expectedPlanDigest: digests.planDigest },
  );
  Object.assign(row, {
    seal_request_id: 'seal-original',
    seal_request_json: json(seal),
    seal_request_digest: await H(seal),
    seal_ack_json: json({
      requestId: 'seal-original',
      snapshotId: id,
      status: 'sealed',
      prospectiveDigest: digests.prospectiveDigest,
      packageCount: plan.counts.packageCount,
      includedCharacterCount: plan.counts.includedCharacterCount,
      excludedTargetCount: plan.counts.excludedTargetCount,
      recordedAt: new Date(at + 2).toISOString(),
    }),
    sealed_at: at + 2,
  });
  tables.pilot_corpus_snapshot.push(row);
  return {
    payload: { tables },
    registry,
    proofs,
    plan,
    digests,
    candidates,
    binding,
  };
}
const validate = (f) =>
  validateCorpusSnapshotFacts(f.payload, {
    registry: f.registry,
    proofs: f.proofs,
  });
test('historical references and original begin ACK survive later disabled actor/current role and installation changes', async () => {
  const f = await fixture(),
    before = json(f.payload),
    result = await validate(f);
  assert.equal(result.get('historical-snapshot').plan.evidenceEpoch, 47);
  assert.equal(
    result.get('historical-snapshot').digests.exclusionReportDigest,
    f.digests.exclusionReportDigest,
  );
  assert.equal(json(f.payload), before);
});
test('header and original immutable ACK/digest/scope cannot be rewritten', async () => {
  for (const mutate of [
    (r) => r.expected_package_count++,
    (r) => r.evidence_epoch++,
    (r) => (r.request_digest = d),
    (r) => (r.ack_json = json({ ...JSON.parse(r.ack_json), status: 'sealed' })),
    (r) =>
      (r.request_json = json({
        ...JSON.parse(r.request_json),
        installationId: 'new-install',
      })),
  ]) {
    const f = await fixture();
    mutate(f.payload.tables.pilot_corpus_snapshot[0]);
    await assert.rejects(() => validate(f));
  }
});
test('sealed member sets refuse incomplete, extra, orphan and mismatched coverage facts', async () => {
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push({ ...rows[0] }),
    (rows) => (rows[0].snapshot_id = 'orphan'),
    (rows) => (rows[0].coverage_identity = '字'),
    (rows) => (rows[0].source_evidence_id = 'missing'),
  ]) {
    const f = await fixture();
    mutate(f.payload.tables.pilot_corpus_snapshot_member);
    await assert.rejects(() => validate(f));
  }
});
test('chunk body, actor grouping, exact target closure and original receipt chronology are checked', async () => {
  for (const mutate of [
    (rows) =>
      (rows[0].chunk_ack_json = json({
        ...JSON.parse(rows[0].chunk_ack_json),
        targetRowCount: 1,
      })),
    (rows) => (rows[0].chunk_recorded_at = 999),
    (rows) => (rows[0].chunk_digest = d),
    (rows) => (rows[0].chunk_request_id = 'different'),
    (rows) =>
      (rows[0].chunk_request_json = json({
        ...JSON.parse(rows[0].chunk_request_json),
        actorId: 'missing-actor',
      })),
  ]) {
    const f = await fixture();
    mutate(f.payload.tables.pilot_corpus_snapshot_member);
    await assert.rejects(() => validate(f));
  }
});
test('seal exact request, timestamp and prospective digest are independently checked', async () => {
  for (const mutate of [
    (r) => (r.sealed_at = 999),
    (r) => (r.seal_request_digest = d),
    (r) =>
      (r.seal_ack_json = json({
        ...JSON.parse(r.seal_ack_json),
        prospectiveDigest: d,
      })),
    (r) => (r.status = 'building'),
  ]) {
    const f = await fixture();
    mutate(f.payload.tables.pilot_corpus_snapshot[0]);
    await assert.rejects(() => validate(f));
  }
});
test('historical package/source dependencies must exist before original preparation', async () => {
  for (const mutate of [
    (f) => f.registry.sources.clear(),
    (f) => (f.registry.sources.values().next().value.created_at = 1001),
    (f) => (f.registry.packages.values().next().value.imported_at = 1001),
    (f) => f.payload.tables.pilot_corpus_item.pop(),
  ]) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(() => validate(f));
  }
});
test('saved eligibility hashes cannot substitute for original source facts', async () => {
  const f = await fixture();
  f.registry.sources.values().next().value.installation_id =
    'different-install';
  await assert.rejects(() => validate(f));
});
test('building snapshots permit whole committed chunks but never partial package chunks or seal receipts', async () => {
  const f = await fixture(),
    r = f.payload.tables.pilot_corpus_snapshot[0];
  r.status = 'building';
  for (const k of [
    'seal_request_id',
    'seal_request_json',
    'seal_request_digest',
    'seal_ack_json',
    'sealed_at',
  ])
    r[k] = null;
  f.payload.tables.pilot_corpus_snapshot_member =
    f.payload.tables.pilot_corpus_snapshot_member.slice(0, 2);
  assert.equal((await validate(f)).size, 1);
  f.payload.tables.pilot_corpus_snapshot_member.pop();
  await assert.rejects(() => validate(f));
});

test('ordinary historical release proof retains evidence namespace rather than null ordinary plan namespace', async () => {
  const f = await fixture({ proof: true });
  assert.equal((await validate(f)).size, 1);
  for (const mutate of [
    (p) => p.proofs.clear(),
    (p) => (p.proofs.values().next().value.receipt.buildId = 'foreign-build'),
    (p) => (p.proofs.values().next().value.row.received_at = 1001),
    (p) => (p.proofs.values().next().value.issuer.purpose = 'candidate'),
    (p) =>
      (p.proofs.values().next().value.receipt.targetInstallationId =
        'foreign-target'),
  ]) {
    const changed = await fixture({ proof: true });
    mutate(changed);
    await assert.rejects(() => validate(changed));
  }
});
test('verification historical rows stay excluded from real readiness while preserving machine package counts', async () => {
  const f = await fixture({ verification: true }),
    result = await validate(f),
    saved = result.get('historical-snapshot');
  assert.equal(saved.plan.counts.includedCharacterCount, 0);
  assert.equal(saved.plan.counts.verificationPackageCount, 2);
  assert.equal(saved.plan.releasedPackages.length, 2);
  assert.equal(
    saved.members.every((m) => m.coverage_status === 'excluded'),
    true,
  );
});
test('later source successors and changed current character heads do not rewrite historical references', async () => {
  const f = await fixture(),
    old = f.registry.sources.values().next().value;
  f.registry.sources.set('later-successor', {
    ...old,
    id: 'later-successor',
    supersedes_id: old.id,
    created_at: 2000,
  });
  for (const c of f.payload.tables.pilot_corpus_character)
    c.current_source_id = 'later-successor';
  assert.equal((await validate(f)).size, 1);
});

async function replacePlan(f, plan) {
  const row = f.payload.tables.pilot_corpus_snapshot[0],
    digests = await snapshotDigests(plan);
  Object.assign(row, {
    plan_json: json(plan),
    plan_digest: digests.planDigest,
    expected_member_digest: digests.expectedMemberDigest,
    released_package_digest: digests.releasedPackageDigest,
    expected_included_count: plan.counts.includedCharacterCount,
    expected_exclusion_count: plan.counts.excludedTargetCount,
    expected_package_count: plan.counts.packageCount,
  });
  for (const member of f.payload.tables.pilot_corpus_snapshot_member)
    Object.assign(
      member,
      snapshotMemberFacts(plan).find(
        (m) => m.member_ordinal === member.member_ordinal,
      ),
    );
  const seal = JSON.parse(row.seal_request_json);
  seal.request.expectedPlanDigest = digests.planDigest;
  row.seal_request_json = json(seal);
  row.seal_request_digest = await H(seal);
  row.seal_ack_json = json({
    ...JSON.parse(row.seal_ack_json),
    prospectiveDigest: digests.prospectiveDigest,
  });
}
test('structurally valid rehashed eligibility cannot manufacture licensed source or missing review', async () => {
  for (const change of [
    (f) => {
      const t = f.candidates[0].targets[0].intrinsicEligibility;
      t.licensed = true;
      t.reasonCodes = intrinsicReasons(t);
    },
    (f) => {
      f.candidates[0].review = { reviewId: 'missing-review', reviewDigest: d };
      f.candidates[0].reviewSequence = 1;
    },
  ]) {
    const f = await fixture();
    change(f);
    const forged = await buildSnapshotPlan(f.binding, f.candidates);
    await inspectSnapshotPlan(forged);
    await replacePlan(f, forged);
    await assert.rejects(() => validate(f));
  }
});
test('issuer revocation after preparation preserves history; revocation before preparation cannot justify snapshot proof', async () => {
  const f = await fixture({ proof: true });
  for (const p of f.proofs.values()) p.issuer.revokedAt = 2000;
  assert.equal((await validate(f)).size, 1);
  f.proofs.values().next().value.issuer.revokedAt = 1001;
  await assert.rejects(() => validate(f));
});

// This branch tests already-authenticated stage premises, not real source/human acceptance.
function preparePositiveModel(document) {
  for (const asset of document.assets) {
    asset.sourceChecked = true;
    asset.sourceCheckStatus = 'mechanically-checked';
  }
  document.pairedStory.playback.voices = [
    { name: 'SYNTHETIC-MODEL-voice', lang: 'zh-CN', localService: true },
  ];
  return document;
}
test('positive model history refuses source/review changes before seal; equal-timestamp later history is not guessed', async () => {
  for (const kind of ['source', 'review']) {
    const f = await fixture({ positive: true, proof: true });
    assert.equal(f.plan.counts.includedCharacterCount, 4);
    assert.equal((await validate(f)).size, 1);
    const boundary = f.payload.tables.pilot_corpus_snapshot[0].sealed_at;
    if (kind === 'source') {
      const original = f.registry.sources.values().next().value;
      f.registry.sources.set('successor', {
        ...original,
        id: 'successor',
        supersedes_id: original.id,
        created_at: boundary,
      });
    } else {
      const original = f.payload.tables.pilot_curriculum_review[0];
      f.payload.tables.pilot_curriculum_review.push({
        ...original,
        review_id: 'later-review',
        review_sequence: 2,
        recorded_at: boundary,
      });
    }
    assert.equal((await validate(f)).size, 1);
    if (kind === 'source')
      f.registry.sources.get('successor').created_at = boundary - 1;
    else
      f.payload.tables.pilot_curriculum_review.at(-1).recorded_at =
        boundary - 1;
    await assert.rejects(() => validate(f));
  }
});
