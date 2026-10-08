/** Historical snapshot stage, after closed row, registry and signature validation.
 * Never consults live heads, sessions, current roles or the destination epoch.
 */
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import { corpusId, corpusRequest } from '../lib/pilot/corpus-policy.ts';
import { evaluateSnapshotCandidate } from '../lib/pilot/corpus-snapshot-facts.ts';
import {
  buildSnapshotPlan,
  inspectSnapshotPlan,
  snapshotDigests,
  snapshotMemberFacts,
  validateSnapshotRows,
} from '../lib/pilot/corpus-snapshot-policy.ts';
const check = (value) => {
  if (!value) throw new Error('BACKUP_CORPUS_INVALID');
};
const same = (a, b) => json(a) === json(b);
const key = (...values) => json(values);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exact = (value, fields) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(order), [...fields].sort(order));
const parsed = (value) => {
  const result = JSON.parse(value);
  check(json(result) === value);
  return result;
};
const iso = (at) => {
  check(Number.isSafeInteger(at) && at >= 0);
  return new Date(at).toISOString();
};
function keyed(rows, field) {
  const result = new Map();
  for (const row of rows) {
    check(!result.has(row[field]));
    result.set(row[field], row);
  }
  return result;
}
async function request(raw, digest, operation, installation, resource, users) {
  const envelope = parsed(raw);
  check(
    exact(envelope, [
      'schemaVersion',
      'actorId',
      'installationId',
      'resourceId',
      'request',
    ]) && users.has(envelope.actorId),
  );
  check(
    same(
      envelope,
      corpusRequest(
        operation,
        envelope.actorId,
        installation,
        resource,
        envelope.request,
      ),
    ) && (await H(envelope)) === digest,
  );
  check(corpusId(envelope.request.requestId));
  return envelope;
}
async function rebuild(plan, row, payload, registry, proofs) {
  const cutoff = row.status === 'sealed' ? row.sealed_at : row.created_at;
  const corpus = registry.corpora.get(plan.corpusVersion);
  check(
    corpus?.corpus_digest === plan.corpusDigest &&
      corpus.imported_at <= row.created_at,
  );
  const items = payload.tables.pilot_corpus_item
    .filter((i) => i.corpus_version === plan.corpusVersion)
    .sort((a, b) => a.ordinal - b.ordinal);
  check(items.length === plan.packages.length);
  const reviews = keyed(payload.tables.pilot_curriculum_review, 'review_id'),
    candidates = [];
  for (const [i, p] of plan.packages.entries()) {
    const item = items[i],
      pkg = registry.packages.get(p.lessonVersion),
      document = registry.documents.get(p.lessonVersion);
    check(
      item.ordinal === i &&
        item.lesson_version === p.lessonVersion &&
        item.content_digest === p.contentDigest &&
        pkg?.content_digest === p.contentDigest &&
        pkg.imported_at <= row.created_at &&
        document,
    );
    const review = p.packageEligibility.review
      ? reviews.get(p.packageEligibility.review.reviewId)
      : null;
    if (p.packageEligibility.review)
      check(
        review &&
          review.lesson_version === p.lessonVersion &&
          review.content_digest === p.contentDigest &&
          review.recorded_at <= row.created_at,
      );
    if (p.packageEligibility.realEligible && review)
      check(
        !payload.tables.pilot_curriculum_review.some(
          (other) =>
            other.lesson_version === p.lessonVersion &&
            other.review_sequence > review.review_sequence &&
            other.recorded_at < cutoff,
        ),
      );
    let proof = null;
    if (p.packageEligibility.proof) {
      const v = proofs.get(p.packageEligibility.proof.proofId),
        r = v?.row,
        receipt = v?.receipt;
      check(
        r &&
          receipt &&
          r.corpus_version === plan.corpusVersion &&
          r.corpus_digest === plan.corpusDigest &&
          r.lesson_version === p.lessonVersion &&
          r.content_digest === p.contentDigest &&
          r.installation_id === plan.installationId &&
          r.received_at <= row.created_at,
      );
      check(
        receipt.candidateId === plan.candidateId &&
          receipt.sourceDigest === plan.sourceDigest &&
          receipt.artifactDigest === plan.artifactDigest &&
          receipt.buildId === plan.buildId &&
          receipt.targetInstallationId === plan.installationId &&
          receipt.namespace === r.namespace &&
          (v.issuer.revokedAt === null || cutoff < v.issuer.revokedAt),
      );
      check(
        plan.lane === 'ordinary'
          ? r.test_run_id === null && v.issuer.purpose === 'release'
          : r.test_run_id === plan.namespace &&
              receipt.namespace === plan.namespace &&
              receipt.evidenceInstallationId === plan.installationId,
      );
      proof = {
        proofId: r.id,
        receiptDigest: r.receipt_digest,
        issuerId: v.issuer.issuerId,
        purpose: v.issuer.purpose,
        issuedAt: receipt.issuedAt,
      };
    }
    const chars = payload.tables.pilot_corpus_character.filter(
        (c) =>
          c.corpus_version === plan.corpusVersion &&
          c.lesson_version === p.lessonVersion,
      ),
      sources = [];
    check(chars.length === 2);
    const historicalChars = [];
    for (const target of p.packageEligibility.targets) {
      const ch = chars.find(
          (c) =>
            c.target_index === target.targetIndex &&
            c.character_id === target.characterId &&
            c.content_digest === p.contentDigest,
        ),
        source = registry.sources.get(target.sourceEvidenceId);
      check(
        ch &&
          source &&
          source.lesson_version === p.lessonVersion &&
          source.content_digest === p.contentDigest &&
          source.created_at <= row.created_at,
      );
      if (target.intrinsicEligibility.realEligible)
        check(
          ![...registry.sources.values()].some(
            (other) =>
              other.supersedes_id === source.id && other.created_at < cutoff,
          ),
        );
      let root = source;
      const visited = new Set();
      while (root.supersedes_id) {
        check(!visited.has(root.id));
        visited.add(root.id);
        root = registry.sources.get(root.supersedes_id);
        check(root);
      }
      check(root.id === ch.source_evidence_id);
      historicalChars.push({ ...ch, current_source_id: source.id });
      sources.push(source);
    }
    candidates.push(
      await evaluateSnapshotCandidate({
        ordinal: i,
        document,
        contentDigest: p.contentDigest,
        characters: historicalChars,
        sources,
        review,
        proof,
        installationId: plan.installationId,
        lane: plan.lane,
      }),
    );
  }
  const {
    schemaVersion: _schema,
    packages: _packages,
    releasedPackages: _released,
    counts: _counts,
    ...binding
  } = plan;
  check(same(plan, await buildSnapshotPlan(binding, candidates)));
}
/** Maps are authenticated stage outputs, not caller-supplied eligibility assertions. */
export async function validateCorpusSnapshotFacts(
  payload,
  { registry, proofs },
) {
  check(registry && proofs instanceof Map);
  const tables = payload.tables,
    users = new Set(tables.pilot_auth_user.map((u) => u.id)),
    snapshots = keyed(tables.pilot_corpus_snapshot, 'id'),
    result = new Map(),
    beginRequests = new Set();
  const membersBySnapshot = new Map();
  for (const member of tables.pilot_corpus_snapshot_member) {
    check(snapshots.has(member.snapshot_id));
    const list = membersBySnapshot.get(member.snapshot_id) ?? [];
    list.push(member);
    membersBySnapshot.set(member.snapshot_id, list);
  }
  for (const row of snapshots.values()) {
    check(corpusId(row.id) && users.has(row.created_by));
    iso(row.created_at);
    const plan = await inspectSnapshotPlan(parsed(row.plan_json));
    check(
      plan.corpusVersion === row.corpus_version &&
        plan.corpusDigest === row.corpus_digest &&
        plan.installationId === row.installation_id &&
        plan.candidateId === row.candidate_id &&
        plan.sourceDigest === row.source_digest &&
        plan.artifactDigest === row.artifact_digest &&
        plan.evidenceEpoch === row.evidence_epoch,
    );
    check(
      plan.lane === 'ordinary'
        ? row.test_run_id === null && plan.namespace === null
        : plan.namespace !== null && row.test_run_id === plan.namespace,
    );
    await rebuild(plan, row, payload, registry, proofs);
    const digests = await snapshotDigests(plan);
    for (const [column, value] of Object.entries({
      plan_digest: digests.planDigest,
      expected_member_digest: digests.expectedMemberDigest,
      released_package_digest: digests.releasedPackageDigest,
      expected_included_count: plan.counts.includedCharacterCount,
      expected_exclusion_count: plan.counts.excludedTargetCount,
      expected_package_count: plan.counts.packageCount,
    }))
      check(row[column] === value);
    const begin = await request(
      row.request_json,
      row.request_digest,
      'snapshot',
      plan.installationId,
      plan.corpusVersion,
      users,
    );
    check(
      begin.actorId === row.created_by &&
        exact(begin.request, ['requestId']) &&
        begin.request.requestId === row.request_id,
    );
    const beginKey = key(
      begin.actorId,
      plan.installationId,
      plan.corpusVersion,
      row.request_id,
    );
    check(!beginRequests.has(beginKey));
    beginRequests.add(beginKey);
    check(
      same(parsed(row.ack_json), {
        requestId: row.request_id,
        snapshotId: row.id,
        status: 'building',
        recordedAt: iso(row.created_at),
        packageCount: plan.counts.candidatePackageCount,
        targetCount: plan.counts.targetCount,
      }),
    );
    const members = membersBySnapshot.get(row.id) ?? [],
      expected = new Map(
        snapshotMemberFacts(plan).map((m) => [m.member_ordinal, m]),
      ),
      seen = new Set(),
      chunks = new Map();
    for (const member of members) {
      const fact = expected.get(member.member_ordinal);
      check(fact && !seen.has(member.member_ordinal));
      seen.add(member.member_ordinal);
      for (const [column, value] of Object.entries(fact))
        check(member[column] === value);
      const envelope = await request(
        member.chunk_request_json,
        member.chunk_digest,
        'snapshot-chunk',
        plan.installationId,
        row.id,
        users,
      );
      check(
        exact(envelope.request, ['requestId', 'packages']) &&
          envelope.request.requestId === member.chunk_request_id &&
          Array.isArray(envelope.request.packages) &&
          envelope.request.packages.length >= 1 &&
          envelope.request.packages.length <= 50,
      );
      const chunkKey = key(envelope.actorId, member.chunk_request_id),
        chunk = chunks.get(chunkKey) ?? { envelope, rows: [] };
      check(same(envelope, chunk.envelope));
      chunk.rows.push(member);
      chunks.set(chunkKey, chunk);
      check(member.chunk_recorded_at >= row.created_at);
      iso(member.chunk_recorded_at);
    }
    for (const { envelope, rows } of chunks.values()) {
      const selected = new Set();
      for (const p of envelope.request.packages) {
        check(
          exact(p, ['lessonVersion', 'contentDigest']) &&
            !selected.has(p.lessonVersion) &&
            plan.packages.some(
              (v) =>
                v.lessonVersion === p.lessonVersion &&
                v.contentDigest === p.contentDigest,
            ),
        );
        selected.add(p.lessonVersion);
      }
      const first = rows[0],
        selectedFacts = [...expected.values()].filter((m) =>
          selected.has(m.lesson_version),
        );
      check(
        rows.length === selectedFacts.length &&
          rows.every((m) => selected.has(m.lesson_version)),
      );
      for (const m of rows)
        check(
          m.chunk_request_json === first.chunk_request_json &&
            m.chunk_digest === first.chunk_digest &&
            m.chunk_ack_json === first.chunk_ack_json &&
            m.chunk_recorded_at === first.chunk_recorded_at,
        );
      check(
        same(parsed(first.chunk_ack_json), {
          requestId: envelope.request.requestId,
          snapshotId: row.id,
          packageCount: selected.size,
          targetRowCount: selected.size * 2,
          recordedAt: iso(first.chunk_recorded_at),
        }),
      );
    }
    if (row.status === 'building') {
      for (const column of [
        'seal_request_id',
        'seal_request_json',
        'seal_request_digest',
        'seal_ack_json',
        'sealed_at',
      ])
        check(row[column] === null);
    } else {
      check(
        row.status === 'sealed' &&
          row.sealed_at >= row.created_at &&
          members.every((m) => m.chunk_recorded_at <= row.sealed_at),
      );
      await validateSnapshotRows(plan, members);
      const seal = await request(
        row.seal_request_json,
        row.seal_request_digest,
        'snapshot-seal',
        plan.installationId,
        row.id,
        users,
      );
      check(
        exact(seal.request, ['requestId', 'expectedPlanDigest']) &&
          seal.request.requestId === row.seal_request_id &&
          seal.request.expectedPlanDigest === digests.planDigest,
      );
      check(
        same(parsed(row.seal_ack_json), {
          requestId: row.seal_request_id,
          snapshotId: row.id,
          status: 'sealed',
          prospectiveDigest: digests.prospectiveDigest,
          packageCount: plan.counts.packageCount,
          includedCharacterCount: plan.counts.includedCharacterCount,
          excludedTargetCount: plan.counts.excludedTargetCount,
          recordedAt: iso(row.sealed_at),
        }),
      );
    }
    result.set(row.id, { row, plan, digests, members });
  }
  return result;
}
