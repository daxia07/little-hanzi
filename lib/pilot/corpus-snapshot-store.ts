/** Ordinary Node/libSQL snapshots; no owner, publication or verification bootstrap. */
import {
  canonicalPackage,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { exact, digest } from '../curriculum/story-package.ts';
import { isLibsqlD1Database } from '../platform/libsql-d1.ts';
import type {
  CorpusSnapshotBeginReceipt,
  CorpusSnapshotChunkReceipt,
  CorpusSnapshotSealReceipt,
  CorpusSnapshotResponse,
  CorpusSnapshotMembersResponse,
} from '../curriculum/corpus-types.ts';
import {
  safeCorpusJson,
  corpusId,
  corpusRequest,
  inspectCorpusChunk,
  assertExactCorpusReplay,
} from './corpus-policy.ts';
import {
  buildSnapshotPlan,
  inspectSnapshotPlan,
  snapshotDigests,
  snapshotMemberFacts,
  validateSnapshotRows,
  type SnapshotPlan,
  type SnapshotCandidate,
  type PackageEligibility,
} from './corpus-snapshot-policy.ts';
import { evaluateSnapshotCandidate } from './corpus-snapshot-facts.ts';
import { authenticateCorpusProof, verifyCorpusProof } from './corpus-proof.ts';
import {
  issueCorpusCursor,
  readCorpusCursor,
  type CorpusCursorBinding,
} from './corpus-cursor.ts';
import {
  registeredCorpus,
  loadCorpusPackage,
  currentCorpusSource,
} from './corpus-store.ts';
import { parsePageLimit } from './corpus-coverage.ts';
import {
  corpusOne,
  corpusRows,
  corpusInstallation,
  requireCorpusActor,
  requireCorpusScope,
  corpusNow,
  corpusISO,
  corpusNewId,
  corpusActorGuard,
  corpusInstallationGuard,
  sqlValue as q,
  type CorpusContext,
  type CorpusRow,
} from './corpus-db.ts';
import { fail } from './story-policy.ts';
function backend(c: CorpusContext) {
  if (!isLibsqlD1Database(c.db)) fail('SNAPSHOT_BACKEND_UNSUPPORTED', 503);
}
async function scope(c: CorpusContext, version: string) {
  await requireCorpusActor(c, 'operator');
  backend(c);
  const installation = await corpusInstallation(c),
    corpus = await registeredCorpus(c, version);
  return { installation, corpus };
}
async function epoch(c: CorpusContext) {
  const e = await corpusOne(
    c,
    'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
  );
  if (!e || !Number.isSafeInteger(e.revision)) fail('STORAGE_UNAVAILABLE', 503);
  return Number(e.revision);
}
async function snapshot(c: CorpusContext, version: string, id: string) {
  if (!corpusId(id)) fail('INVALID_REQUEST', 400);
  const { installation } = await scope(c, version),
    row = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_snapshot WHERE id=${q(id)} AND corpus_version=${q(version)} AND installation_id=${q(installation)}`,
    );
  if (!row) fail('NOT_FOUND', 404);
  return row;
}
function trustBytes(c: CorpusContext) {
  return canonicalPackage({
    trust: c.config.curriculumTrust ?? null,
    candidateId: c.config.candidateId,
    capability: c.corpus.capability,
  });
}
async function post(c: CorpusContext, installation: string) {
  await requireCorpusScope(c, installation);
}

function preparedGuard(c: CorpusContext, plan: SnapshotPlan) {
  return `${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(plan.installationId)} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${plan.evidenceEpoch})`;
}
async function write(
  c: CorpusContext,
  statements: D1PreparedStatement[],
  configuration: string,
) {
  if (configuration !== trustBytes(c)) fail('SNAPSHOT_STALE');
  try {
    const result = await c.db.batch(statements);
    if (result.some((r) => !r.success)) fail('STORAGE_UNAVAILABLE', 503);
  } catch {
    fail('STORAGE_UNAVAILABLE', 503);
  }
}
export async function snapshotCandidates(
  c: CorpusContext,
  version: string,
): Promise<SnapshotCandidate[]> {
  const installation = await corpusInstallation(c),
    corpus = await registeredCorpus(c, version),
    trust = c.config.curriculumTrust;
  if (!trust || trust.candidateId !== c.config.candidateId)
    fail('STORAGE_UNAVAILABLE', 503);
  const items = await corpusRows(
      c,
      `SELECT * FROM pilot_corpus_item WHERE corpus_version=${q(version)} ORDER BY ordinal`,
    ),
    members = items.map((i) => ({
      lessonVersion: String(i.lesson_version),
      contentDigest: String(i.content_digest),
    })),
    result: SnapshotCandidate[] = [];
  for (const item of items) {
    const pkg = await loadCorpusPackage(c, String(item.lesson_version)),
      chars = await corpusRows(
        c,
        `SELECT * FROM pilot_corpus_character WHERE corpus_version=${q(version)} AND lesson_version=${q(item.lesson_version)} ORDER BY target_index`,
      ),
      sources: CorpusRow[] = [];
    for (const ch of chars) {
      const current = await currentCorpusSource(
        c,
        String(ch.source_evidence_id),
      );
      if (!current) fail('STORAGE_UNAVAILABLE', 503);
      ch.current_source_id = current.id;
      sources.push(current);
    }
    const review = await corpusOne(
        c,
        `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(item.lesson_version)} ORDER BY review_sequence DESC LIMIT 1`,
      ),
      proofs = await corpusRows(
        c,
        `SELECT * FROM pilot_corpus_proof_receipt WHERE corpus_version=${q(version)} AND lesson_version=${q(item.lesson_version)} AND installation_id=${q(installation)} AND test_run_id IS NULL ORDER BY received_at DESC,id`,
      );
    let proof: PackageEligibility['proof'] = null;
    for (const row of proofs) {
      try {
        const auth = await authenticateCorpusProof(
          JSON.parse(String(row.receipt_json)),
          row.signature,
          trust,
          members,
          corpusNow(c),
        );
        await verifyCorpusProof(
          auth.receipt,
          row.signature,
          trust,
          {
            candidateId: trust.candidateId,
            sourceDigest: trust.sourceDigest,
            artifactDigest: trust.artifactDigest,
            buildId: trust.buildId,
            installationId: installation,
            evidenceInstallationId: auth.receipt.evidenceInstallationId,
            corpusVersion: version,
            corpusDigest: String(corpus.corpus_digest),
            namespace: auth.receipt.namespace,
            verification: false,
            members,
            lessonVersion: String(item.lesson_version),
            contentDigest: String(item.content_digest),
          },
          corpusNow(c),
        );
        if (
          auth.receiptDigest !== row.receipt_digest ||
          auth.receipt.issuerId !== row.issuer_id
        )
          continue;
        proof = {
          proofId: String(row.id),
          receiptDigest: auth.receiptDigest,
          issuerId: auth.issuer.issuerId,
          purpose: auth.issuer.purpose,
          issuedAt: auth.receipt.issuedAt,
        };
        break;
      } catch {
        /* A stale/untrusted proof excludes readiness; it cannot upgrade source. */
      }
    }
    result.push(
      await evaluateSnapshotCandidate({
        ordinal: Number(item.ordinal),
        document: pkg.document,
        contentDigest: String(item.content_digest),
        characters: chars,
        sources,
        review,
        proof,
        installationId: installation,
        lane: 'ordinary',
      }),
    );
  }
  return result;
}
async function planFor(
  c: CorpusContext,
  version: string,
  evidenceEpoch: number,
): Promise<SnapshotPlan> {
  const installation = await corpusInstallation(c),
    corpus = await registeredCorpus(c, version),
    trust = c.config.curriculumTrust;
  if (!trust || trust.candidateId !== c.config.candidateId || c.config.testMode)
    fail('STORAGE_UNAVAILABLE', 503);
  return await inspectSnapshotPlan(
    await buildSnapshotPlan(
      {
        corpusVersion: version,
        corpusDigest: String(corpus.corpus_digest),
        installationId: installation,
        namespace: null,
        lane: 'ordinary',
        candidateId: trust.candidateId,
        sourceDigest: trust.sourceDigest,
        artifactDigest: trust.artifactDigest,
        buildId: trust.buildId,
        evidenceEpoch,
      },
      await snapshotCandidates(c, version),
    ),
  );
}
async function currentPlan(c: CorpusContext, version: string, row: CorpusRow) {
  const plan = await inspectSnapshotPlan(JSON.parse(String(row.plan_json)));
  if ((await epoch(c)) !== plan.evidenceEpoch) fail('SNAPSHOT_STALE');
  const rebuilt = await planFor(c, version, plan.evidenceEpoch);
  if (canonicalPackage(plan) !== canonicalPackage(rebuilt))
    fail('SNAPSHOT_STALE');
  return plan;
}
export async function beginCorpusSnapshot(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusSnapshotBeginReceipt> {
  const { installation } = await scope(c, version),
    raw = safeCorpusJson(input);
  if (!exact(raw, ['requestId']) || !corpusId(raw.requestId))
    fail('INVALID_REQUEST', 400);
  const envelope = corpusRequest(
      'snapshot',
      c.user.id,
      installation,
      version,
      raw,
    ),
    old = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_snapshot WHERE created_by=${q(c.user.id)} AND installation_id=${q(installation)} AND corpus_version=${q(version)} AND request_id=${q(raw.requestId)}`,
    );
  if (old) {
    assertExactCorpusReplay(JSON.parse(String(old.request_json)), envelope);
    await post(c, installation);
    return JSON.parse(String(old.ack_json));
  }
  const configuration = trustBytes(c),
    preparedEpoch = await epoch(c),
    plan = await planFor(c, version, preparedEpoch),
    digests = await snapshotDigests(plan),
    at = corpusNow(c),
    id = corpusNewId('snapshot'),
    ack: CorpusSnapshotBeginReceipt = {
      requestId: raw.requestId,
      snapshotId: id,
      status: 'building',
      recordedAt: corpusISO(at),
      packageCount: plan.counts.candidatePackageCount,
      targetCount: plan.counts.targetCount,
    };
  if (configuration !== trustBytes(c)) fail('SNAPSHOT_STALE');
  const values = [
    id,
    version,
    plan.corpusDigest,
    installation,
    plan.candidateId,
    plan.sourceDigest,
    plan.artifactDigest,
    preparedEpoch,
    canonicalPackage(plan),
    digests.planDigest,
    digests.expectedMemberDigest,
    plan.counts.includedCharacterCount,
    plan.counts.excludedTargetCount,
    plan.counts.packageCount,
    digests.releasedPackageDigest,
    'building',
    c.user.id,
    raw.requestId,
    canonicalPackage(envelope),
    await H(envelope),
    canonicalPackage(ack),
    at,
    null,
  ];
  await write(
    c,
    [
      c.db
        .prepare(
          `INSERT INTO pilot_corpus_snapshot(id,corpus_version,corpus_digest,installation_id,candidate_id,source_digest,artifact_digest,evidence_epoch,plan_json,plan_digest,expected_member_digest,expected_included_count,expected_exclusion_count,expected_package_count,released_package_digest,status,created_by,request_id,request_json,request_digest,ack_json,created_at,test_run_id) SELECT ${values.map(() => '?').join(',')} WHERE ${preparedGuard(c, plan)}`,
        )
        .bind(...values),
    ],
    configuration,
  );
  const stored = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_snapshot WHERE created_by=${q(c.user.id)} AND installation_id=${q(installation)} AND corpus_version=${q(version)} AND request_id=${q(raw.requestId)}`,
  );
  await post(c, installation);
  if (!stored) fail('SNAPSHOT_STALE');
  assertExactCorpusReplay(JSON.parse(String(stored.request_json)), envelope);
  return JSON.parse(String(stored.ack_json));
}
async function chunkPrior(c: CorpusContext, id: string, requestId: string) {
  return corpusOne(
    c,
    `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND chunk_request_id=${q(requestId)} AND json_extract(chunk_request_json,'$.actorId')=${q(c.user.id)} ORDER BY member_ordinal LIMIT 1`,
  );
}
export async function appendCorpusSnapshotChunk(
  c: CorpusContext,
  version: string,
  id: string,
  input: unknown,
): Promise<CorpusSnapshotChunkReceipt> {
  const row = await snapshot(c, version, id),
    initial = await inspectSnapshotPlan(JSON.parse(String(row.plan_json))),
    raw = inspectCorpusChunk(
      input,
      initial.packages.map((p) => ({
        lessonVersion: p.lessonVersion,
        contentDigest: p.contentDigest,
      })),
    ),
    envelope = corpusRequest(
      'snapshot-chunk',
      c.user.id,
      initial.installationId,
      id,
      raw,
    ),
    prior = await chunkPrior(c, id, raw.requestId);
  if (prior) {
    assertExactCorpusReplay(
      JSON.parse(String(prior.chunk_request_json)),
      envelope,
    );
    await post(c, initial.installationId);
    return JSON.parse(String(prior.chunk_ack_json));
  }
  if (row.status !== 'building') fail('SNAPSHOT_CONFLICT');
  const configuration = trustBytes(c),
    plan = await currentPlan(c, version, row),
    selected = new Set(raw.packages.map((p) => p.lessonVersion)),
    existing = await corpusRows(
      c,
      `SELECT lesson_version FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)}`,
    );
  if (existing.some((r) => selected.has(String(r.lesson_version))))
    fail('CHUNK_CONFLICT');
  const at = corpusNow(c),
    ack: CorpusSnapshotChunkReceipt = {
      requestId: raw.requestId,
      snapshotId: id,
      packageCount: selected.size,
      targetRowCount: selected.size * 2,
      recordedAt: corpusISO(at),
    },
    requestJson = canonicalPackage(envelope),
    requestDigest = await H(envelope);
  if (configuration !== trustBytes(c)) fail('SNAPSHOT_STALE');
  const guard = `${preparedGuard(c, plan)} AND EXISTS(SELECT 1 FROM pilot_corpus_snapshot WHERE id=${q(id)} AND status='building') AND NOT EXISTS(SELECT 1 FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND chunk_request_id=${q(raw.requestId)} AND json_extract(chunk_request_json,'$.actorId')=${q(c.user.id)} AND json_extract(chunk_request_json,'$.installationId')=${q(plan.installationId)} AND (chunk_digest!=${q(requestDigest)} OR chunk_request_json!=${q(requestJson)})) AND NOT EXISTS(SELECT 1 FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND lesson_version IN (${[...selected].map(q).join(',')}) AND (chunk_digest!=${q(requestDigest)} OR chunk_request_json!=${q(requestJson)}))`;
  const statements = snapshotMemberFacts(plan)
    .filter((m) => selected.has(m.lesson_version))
    .map((m) => {
      const values = {
          snapshot_id: id,
          ...m,
          chunk_request_id: raw.requestId,
          chunk_request_json: requestJson,
          chunk_digest: requestDigest,
          chunk_ack_json: canonicalPackage(ack),
          chunk_recorded_at: at,
        },
        columns = Object.keys(values),
        args = Object.values(values);
      return c.db
        .prepare(
          `INSERT INTO pilot_corpus_snapshot_member(${columns.join(',')}) SELECT ${args.map(() => '?').join(',')} WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND member_ordinal=${m.member_ordinal})`,
        )
        .bind(...args);
    });
  await write(c, statements, configuration);
  const saved = await chunkPrior(c, id, raw.requestId);
  await post(c, plan.installationId);
  if (!saved) {
    const occupied = await corpusOne(
      c,
      `SELECT 1 AS ok FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND lesson_version IN (${[...selected].map(q).join(',')}) LIMIT 1`,
    );
    if (occupied) fail('CHUNK_CONFLICT');
    fail('SNAPSHOT_STALE');
  }
  assertExactCorpusReplay(
    JSON.parse(String(saved.chunk_request_json)),
    envelope,
  );
  const persisted = await corpusRows(
    c,
    `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND chunk_request_id=${q(raw.requestId)} AND chunk_request_json=${q(requestJson)}`,
  );
  if (persisted.length !== selected.size * 2) fail('CHUNK_CONFLICT');
  await post(c, plan.installationId);
  return JSON.parse(String(saved.chunk_ack_json));
}
export async function sealCorpusSnapshot(
  c: CorpusContext,
  version: string,
  id: string,
  input: unknown,
): Promise<CorpusSnapshotSealReceipt> {
  const row = await snapshot(c, version, id),
    raw = safeCorpusJson(input);
  if (
    !exact(raw, ['requestId', 'expectedPlanDigest']) ||
    !corpusId(raw.requestId) ||
    !digest(raw.expectedPlanDigest)
  )
    fail('INVALID_REQUEST', 400);
  const envelope = corpusRequest(
    'snapshot-seal',
    c.user.id,
    String(row.installation_id),
    id,
    raw,
  );
  if (row.status === 'sealed') {
    assertExactCorpusReplay(
      JSON.parse(String(row.seal_request_json)),
      envelope,
    );
    await post(c, String(row.installation_id));
    return JSON.parse(String(row.seal_ack_json));
  }
  if (raw.expectedPlanDigest !== row.plan_digest) fail('SNAPSHOT_STALE');
  const configuration = trustBytes(c),
    plan = await currentPlan(c, version, row),
    members = await corpusRows(
      c,
      `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} ORDER BY member_ordinal`,
    ),
    digests = await validateSnapshotRows(plan, members);
  if (
    digests.planDigest !== row.plan_digest ||
    digests.expectedMemberDigest !== row.expected_member_digest ||
    digests.releasedPackageDigest !== row.released_package_digest
  )
    fail('SNAPSHOT_INCOMPLETE');
  const at = corpusNow(c),
    ack: CorpusSnapshotSealReceipt = {
      requestId: raw.requestId,
      snapshotId: id,
      status: 'sealed',
      prospectiveDigest: digests.prospectiveDigest,
      packageCount: plan.counts.packageCount,
      includedCharacterCount: plan.counts.includedCharacterCount,
      excludedTargetCount: plan.counts.excludedTargetCount,
      recordedAt: corpusISO(at),
    };
  if (configuration !== trustBytes(c)) fail('SNAPSHOT_STALE');
  await write(
    c,
    [
      c.db
        .prepare(
          `UPDATE pilot_corpus_snapshot SET status='sealed',seal_request_id=?,seal_request_json=?,seal_request_digest=?,seal_ack_json=?,sealed_at=? WHERE id=? AND status='building' AND ${preparedGuard(c, plan)}`,
        )
        .bind(
          raw.requestId,
          canonicalPackage(envelope),
          await H(envelope),
          canonicalPackage(ack),
          at,
          id,
        ),
    ],
    configuration,
  );
  const saved = await snapshot(c, version, id);
  await post(c, plan.installationId);
  if (saved.status !== 'sealed') fail('SNAPSHOT_STALE');
  assertExactCorpusReplay(
    JSON.parse(String(saved.seal_request_json)),
    envelope,
  );
  return JSON.parse(String(saved.seal_ack_json));
}
export async function readCorpusSnapshot(
  c: CorpusContext,
  version: string,
  id: string,
): Promise<CorpusSnapshotResponse> {
  const row = await snapshot(c, version, id),
    plan = await inspectSnapshotPlan(JSON.parse(String(row.plan_json))),
    digests = await snapshotDigests(plan);
  await post(c, plan.installationId);
  return {
    schemaVersion: 'r6-snapshot-1',
    snapshotId: id,
    corpusVersion: version,
    corpusDigest: plan.corpusDigest,
    status: row.status as 'building' | 'sealed',
    lane: plan.lane,
    candidateId: plan.candidateId,
    buildId: plan.buildId,
    planDigest: digests.planDigest,
    prospectiveDigest:
      row.status === 'sealed' ? digests.prospectiveDigest : null,
    exclusionReportDigest:
      row.status === 'sealed' ? digests.exclusionReportDigest : null,
    createdAt: corpusISO(row.created_at),
    sealedAt: row.sealed_at === null ? null : corpusISO(row.sealed_at),
    counts: plan.counts,
  };
}
export async function readCorpusSnapshotMembers(
  c: CorpusContext,
  version: string,
  id: string,
  input: { status?: unknown; limit?: unknown; cursor?: unknown } = {},
): Promise<CorpusSnapshotMembersResponse> {
  const row = await snapshot(c, version, id),
    plan = await inspectSnapshotPlan(JSON.parse(String(row.plan_json))),
    status = input.status ?? 'excluded';
  if (status !== 'included' && status !== 'excluded')
    fail('INVALID_QUERY', 400);
  const limit = input.limit === undefined ? 20 : parsePageLimit(input.limit),
    now = corpusNow(c),
    e = await epoch(c);
  if (!c.config.secret) fail('STORAGE_UNAVAILABLE', 503);
  const binding: CorpusCursorBinding = {
    kind: 'snapshot-members',
    actorId: c.user.id,
    sessionId: String(c.session.id),
    authRevision: c.user.role,
    installationId: plan.installationId,
    resourceId: id,
    corpusVersion: version,
    corpusDigest: plan.corpusDigest,
    buildId: plan.buildId,
    releaseRevision: 0,
    evidenceEpoch: e,
    q: status,
    limit,
  };
  let after = -1;
  if (input.cursor !== undefined) {
    const token = await readCorpusCursor(
      c.config.secret,
      input.cursor,
      binding,
      now,
    );
    if (token.last.length !== 1 || !/^\d{1,5}$/u.test(token.last[0]))
      fail('CURSOR_INVALID', 400);
    after = Number(token.last[0]);
  }
  const rows = await corpusRows(
      c,
      `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(id)} AND coverage_status=${q(status)} AND member_ordinal>${after} ORDER BY member_ordinal LIMIT ${limit + 1}`,
    ),
    page = rows.slice(0, limit);
  await post(c, plan.installationId);
  if ((await epoch(c)) !== e) fail('CURSOR_STALE');
  const nextCursor =
    rows.length > limit
      ? await issueCorpusCursor(
          c.config.secret,
          binding,
          [String(page.at(-1)!.member_ordinal)],
          now,
        )
      : null;
  await post(c, plan.installationId);
  return {
    schemaVersion: 'r6-snapshot-members-1',
    snapshotId: id,
    status,
    items: page.map((r) => {
      const eligibility = JSON.parse(String(r.eligibility_json));
      return {
        coverageIdentity: String(r.coverage_identity),
        characterId: String(r.character_id),
        lessonVersion: String(r.lesson_version),
        contentDigest: String(r.content_digest),
        classification: eligibility.classification,
        eligible: eligibility.eligible,
        reasonCodes: eligibility.reasonCodes,
        evidenceRefs: [
          String(r.source_evidence_id),
          ...(r.review_id ? [String(r.review_id)] : []),
          ...(r.proof_id ? [String(r.proof_id)] : []),
        ],
      };
    }),
    nextCursor,
  };
}
