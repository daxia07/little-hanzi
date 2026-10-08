/** Current facts and original snapshot/group intersections, never saved-count authority. */
import {
  canonicalPackage,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import type {
  CorpusCoverageResponse,
  CorpusCoverageItem,
} from '../curriculum/corpus-types.ts';
import { deriveCorpusCoverage, type PackageFacts } from './corpus-policy.ts';
import {
  issueCorpusCursor,
  readCorpusCursor,
  type CorpusCursorBinding,
} from './corpus-cursor.ts';
import { fail } from './story-policy.ts';
import {
  registeredCorpus,
  loadCorpusPackage,
  currentCorpusSource,
} from './corpus-store.ts';
import {
  corpusRows,
  corpusOne,
  corpusInstallation,
  corpusNamespace,
  requireCorpusActor,
  corpusNow,
  corpusISO,
  sqlValue as q,
  type CorpusContext,
} from './corpus-db.ts';
import { snapshotCandidates } from './corpus-snapshot-store.ts';
import { evaluateSnapshotCandidate } from './corpus-snapshot-facts.ts';
import {
  inspectSnapshotPlan,
  type SnapshotCandidate,
} from './corpus-snapshot-policy.ts';
import {
  corpusAuthorityConfiguration,
  readCurrentCorpusAuthority,
  readCorpusPackageAuthority,
  corpusAuthorityGuard,
  finalCorpusScope,
} from './corpus-authority.ts';
async function proofless(
  c: CorpusContext,
  version: string,
  installationId: string,
): Promise<SnapshotCandidate[]> {
  const items = await corpusRows(
      c,
      `SELECT * FROM pilot_corpus_item WHERE corpus_version=${q(version)} ORDER BY ordinal`,
    ),
    result: SnapshotCandidate[] = [];
  for (const item of items) {
    const pkg = await loadCorpusPackage(c, String(item.lesson_version)),
      characters = await corpusRows(
        c,
        `SELECT * FROM pilot_corpus_character WHERE corpus_version=${q(version)} AND lesson_version=${q(item.lesson_version)} ORDER BY target_index`,
      ),
      sources = [];
    for (const ch of characters) {
      const source = await currentCorpusSource(
        c,
        String(ch.source_evidence_id),
      );
      if (!source) fail('STORAGE_UNAVAILABLE', 503);
      ch.current_source_id = source.id;
      sources.push(source);
    }
    const review = await corpusOne(
      c,
      `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(item.lesson_version)} ORDER BY review_sequence DESC LIMIT 1`,
    );
    result.push(
      await evaluateSnapshotCandidate({
        ordinal: Number(item.ordinal),
        document: pkg.document,
        contentDigest: String(item.content_digest),
        characters,
        sources,
        review,
        proof: null,
        installationId,
        lane: 'ordinary',
      }),
    );
  }
  return result;
}
export async function corpusCoverage(
  c: CorpusContext,
  version: string,
  input: { limit?: unknown; cursor?: unknown } = {},
): Promise<CorpusCoverageResponse> {
  await requireCorpusActor(c, 'operator');
  const corpus = await registeredCorpus(c, version),
    installation = await corpusInstallation(c),
    configuration = corpusAuthorityConfiguration(c),
    limit = input.limit === undefined ? 20 : parsePageLimit(input.limit),
    epoch = await corpusOne(
      c,
      'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
    ),
    trust = c.config.curriculumTrust,
    lane = c.config.testMode ? 'verification' : 'ordinary';
  if (!epoch || !c.config.secret) fail('STORAGE_UNAVAILABLE', 503);
  const trusted = !!trust && trust.candidateId === c.config.candidateId,
    candidates = trusted
      ? await snapshotCandidates(c, version)
      : await proofless(c, version, installation),
    saved = trusted
      ? await corpusOne(
          c,
          `SELECT * FROM pilot_corpus_snapshot WHERE corpus_version=${q(version)} AND corpus_digest=${q(corpus.corpus_digest)} AND installation_id=${q(installation)} AND test_run_id IS ${q(corpusNamespace(c))} AND status='sealed' AND candidate_id=${q(trust!.candidateId)} AND source_digest=${q(trust!.sourceDigest)} AND artifact_digest=${q(trust!.artifactDigest)} AND json_extract(plan_json,'$.buildId')=${q(trust!.buildId)} ORDER BY sealed_at DESC,id DESC LIMIT 1`,
        )
      : null,
    plan = saved
      ? await inspectSnapshotPlan(JSON.parse(String(saved.plan_json)))
      : null,
    head = await corpusOne(
      c,
      `SELECT p.*,s.expected_included_count FROM pilot_corpus_publication_state h JOIN pilot_corpus_publication p ON p.id=h.latest_publication_id JOIN pilot_corpus_snapshot s ON s.id=p.snapshot_id WHERE h.corpus_version=${q(version)} AND h.installation_id=${q(installation)} AND h.namespace_key=${q(corpusNamespace(c) ?? 'ordinary')}`,
    );
  const binding: CorpusCursorBinding = {
    kind: 'coverage',
    actorId: c.user.id,
    sessionId: String(c.session.id),
    authRevision: await H(configuration),
    installationId: installation,
    resourceId: version,
    corpusVersion: version,
    corpusDigest: String(corpus.corpus_digest),
    buildId: trust?.buildId ?? '',
    releaseRevision: Number(head?.revision ?? 0),
    evidenceEpoch: Number(epoch.revision),
    q: String(saved?.id ?? ''),
    limit,
  };
  let after = -1;
  if (input.cursor !== undefined) {
    const previous = await readCorpusCursor(
      c.config.secret,
      input.cursor,
      binding,
      corpusNow(c),
    );
    if (previous.last.length !== 1 || !/^\d{1,5}$/u.test(previous.last[0]))
      fail('CURSOR_INVALID', 400);
    after = Number(previous.last[0]);
  }
  const prospective = new Set<string>(),
    trial = new Set<string>(),
    committed = new Set<string>(),
    currentGroup = new Set<string>(),
    facts: PackageFacts[] = candidates.map((p) => ({
      ordinal: p.ordinal,
      lessonVersion: p.lessonVersion,
      contentDigest: p.contentDigest,
      targets: p.targets.map((t) => ({
        ...t.intrinsicEligibility,
        hanzi: t.coverageIdentity,
      })),
      prospective: false,
      trial: false,
      committed: false,
    })),
    result = deriveCorpusCoverage(facts);
  for (const p of candidates) {
    const old = plan?.packages.find(
      (x) =>
        x.lessonVersion === p.lessonVersion &&
        x.contentDigest === p.contentDigest,
    );
    if (
      !old ||
      !plan!.releasedPackages.some(
        (x) =>
          x.lessonVersion === p.lessonVersion &&
          x.contentDigest === p.contentDigest,
      ) ||
      !p.targets.every((t) => t.intrinsicEligibility.realEligible)
    )
      continue;
    const currentAssetDigest = await H(p.assetInventory);
    const bound =
      p.targets.every((t) =>
        old.targets.some(
          (v) =>
            v.sourceEvidenceId === t.sourceEvidenceId &&
            v.sourceEvidenceDigest === t.sourceEvidenceDigest &&
            v.assetInventoryDigest === currentAssetDigest,
        ),
      ) &&
      old.packageEligibility.review?.reviewId === p.review?.reviewId &&
      old.packageEligibility.proof?.proofId === p.proof?.proofId &&
      canonicalPackage(old.packageEligibility.assetInventory) ===
        canonicalPackage(p.assetInventory);
    if (bound)
      for (const t of old.targets.filter(
        (t) => t.coverageStatus === 'included',
      ))
        prospective.add(t.coverageIdentity);
  }
  let a: Awaited<ReturnType<typeof readCurrentCorpusAuthority>> = null;
  if (trusted && head?.status === 'released')
    a = await readCurrentCorpusAuthority(c, version);
  if (a)
    for (const p of candidates) {
      const current = await readCorpusPackageAuthority(c, a, p.lessonVersion);
      if (!current.available) continue;
      for (const t of p.targets) {
        currentGroup.add(t.coverageIdentity);
        if (t.intrinsicEligibility.realEligible) {
          if (a.scope.kind === 'starter') committed.add(t.coverageIdentity);
          if (a.scope.kind === 'supervised-trial')
            trial.add(t.coverageIdentity);
        }
      }
    }
  result.counts.prospectiveStarter = prospective.size;
  result.counts.supervisedTrial = trial.size;
  result.counts.committedStarter = committed.size;
  const members: CorpusCoverageItem[] = result.members.map((m) => {
      const p = candidates.find((p) => p.lessonVersion === m.lessonVersion)!,
        t = p.targets.find((t) => t.characterId === m.characterId)!;
      return {
        coverageIdentity: m.coverageIdentity,
        characterId: m.characterId,
        lessonVersion: m.lessonVersion,
        contentDigest: p.contentDigest,
        classification: t.intrinsicEligibility.classification,
        eligible: m.eligible,
        reasonCodes: m.reasonCodes,
        evidenceRefs: [
          t.sourceEvidenceId,
          ...(p.review ? [p.review.reviewId] : []),
          ...(p.proof ? [p.proof.proofId] : []),
        ],
      };
    }),
    page = members.slice(after + 1, after + 1 + limit),
    end = after + page.length,
    response: CorpusCoverageResponse = {
      schemaVersion: 'r6-coverage-1',
      corpusVersion: version,
      corpusDigest: String(corpus.corpus_digest),
      dataAt: corpusISO(corpusNow(c)),
      lane,
      fixtureCharacterCount: result.fixtureCharacterCount,
      verificationPackageCount: result.verificationPackageCount,
      counts: result.counts,
      snapshot: saved
        ? {
            snapshotId: String(saved.id),
            digest: String(saved.plan_digest),
            includedCharacterCount: Number(saved.expected_included_count),
            excludedTargetCount: Number(saved.expected_exclusion_count),
            packageCount: Number(saved.expected_package_count),
            createdAt: corpusISO(saved.created_at),
          }
        : null,
      release: head
        ? {
            releaseId: String(head.id),
            revision: Number(head.revision),
            status: head.status as 'released' | 'withdrawn',
            snapshotCharacterCount: Number(head.expected_included_count),
            currentEligibleCharacterCount: currentGroup.size,
          }
        : null,
      items: page,
      nextCursor:
        end < members.length - 1
          ? await issueCorpusCursor(
              c.config.secret,
              binding,
              [String(end)],
              corpusNow(c),
            )
          : null,
    };
  if (configuration !== corpusAuthorityConfiguration(c)) fail('CURSOR_STALE');
  if ((await corpusInstallation(c)) !== installation) fail('UNAUTHORIZED', 401);
  await finalCorpusScope(
    c,
    installation,
    `EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${epoch.revision})${a ? ` AND ${corpusAuthorityGuard(c, a)}` : ''}`,
  );
  return response;
}
export function parsePageLimit(v: unknown): number {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^\d{1,2}$/u.test(v)))
    fail('INVALID_QUERY', 400);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) fail('INVALID_QUERY', 400);
  return n;
}
