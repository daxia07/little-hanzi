/** Protected configured-owner material and decisions; never public catalog data. */
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { exact, digest } from '../curriculum/story-package.ts';
import type {
  CorpusOwnerReviewResponse,
  CorpusOwnerItemResponse,
  CorpusScope,
  CorpusReceipt,
  CorpusCounts,
} from '../curriculum/corpus-types.ts';
import { fail } from './story-policy.ts';
import {
  safeCorpusJson,
  corpusId,
  corpusRequest,
  assertExactCorpusReplay,
} from './corpus-policy.ts';
import {
  corpusOne,
  corpusRows,
  corpusInstallation,
  corpusInstallationGuard,
  corpusActorGuard,
  corpusNow,
  corpusISO,
  corpusNewId,
  corpusInsert,
  sqlValue as q,
  type CorpusContext,
} from './corpus-db.ts';
import { registeredCorpus, loadCorpusPackage } from './corpus-store.ts';
import {
  inspectSnapshotPlan,
  snapshotDigests,
} from './corpus-snapshot-policy.ts';
import { parsePageLimit } from './corpus-coverage.ts';
import {
  issueCorpusCursor,
  readCorpusCursor,
  type CorpusCursorBinding,
} from './corpus-cursor.ts';
import {
  corpusAuthorityConfiguration,
  corpusEvidenceEpoch,
  normalizeCorpusScope,
  corpusScopeGuard,
  requireCorpusMembers,
  currentCorpusSnapshotReady,
} from './corpus-authority.ts';
export function corpusOwnerGuard(c: CorpusContext) {
  return `${corpusActorGuard(c)} AND ${['parent', 'operator'].includes(c.user.role) && c.corpus.ownerIds.includes(c.user.id) ? '1' : '0'}`;
}
async function ownerPost(
  c: CorpusContext,
  install: string,
  config?: string,
  scopeGuard = '1',
) {
  if (
    !(await corpusOne(
      c,
      `SELECT 1 AS ok WHERE ${corpusOwnerGuard(c)} AND ${corpusInstallationGuard(install)} AND (${scopeGuard})`,
    ))
  )
    fail('FORBIDDEN', 403);
  if (config !== undefined && corpusAuthorityConfiguration(c) !== config)
    fail('PUBLICATION_STALE');
}
export async function loadCorpusOwnerSnapshot(
  c: CorpusContext,
  version: string,
  id: string,
) {
  const install = await corpusInstallation(c);
  await ownerPost(c, install);
  await registeredCorpus(c, version);
  if (!corpusId(id)) fail('INVALID_REQUEST', 400);
  const row = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_snapshot WHERE id=${q(id)} AND corpus_version=${q(version)} AND installation_id=${q(install)} AND test_run_id IS NULL`,
  );
  if (!row) fail('NOT_FOUND', 404);
  if (row.status !== 'sealed') fail('SNAPSHOT_INCOMPLETE');
  const plan = await inspectSnapshotPlan(JSON.parse(String(row.plan_json))),
    digests = await snapshotDigests(plan),
    trust = c.config.curriculumTrust;
  if (
    plan.lane !== 'ordinary' ||
    !trust ||
    trust.candidateId !== plan.candidateId ||
    trust.sourceDigest !== plan.sourceDigest ||
    trust.artifactDigest !== plan.artifactDigest ||
    trust.buildId !== plan.buildId ||
    c.config.candidateId !== plan.candidateId
  )
    fail('SNAPSHOT_STALE');
  if ((await corpusEvidenceEpoch(c)) !== plan.evidenceEpoch)
    fail('SNAPSHOT_STALE');
  const configuration = corpusAuthorityConfiguration(c);
  await ownerPost(c, install, configuration);
  return { row, plan, digests, configuration };
}
async function permitted(
  c: CorpusContext,
  plan: Awaited<ReturnType<typeof loadCorpusOwnerSnapshot>>['plan'],
) {
  const links = await corpusRows(
    c,
    `SELECT l.parent_id,l.child_id FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE p.role='parent' AND u.role='child' AND p.disabled=0 AND p.must_change_password=0 AND u.disabled=0 AND u.must_change_password=0 ${c.user.role === 'parent' ? `AND p.id=${q(c.user.id)}` : ''} ORDER BY l.child_id,l.parent_id LIMIT 101`,
  );
  if (links.length > 100) fail('SCOPE_TOO_LARGE', 409);
  const scopes: CorpusScope[] = [
    { kind: 'starter' },
    ...links.map((l) => ({
      kind: 'supervised-trial' as const,
      members: [{ parentId: String(l.parent_id), childId: String(l.child_id) }],
    })),
  ];
  if (
    links.length > 1 &&
    new Set(links.map((l) => l.child_id)).size === links.length
  )
    scopes.push({
      kind: 'supervised-trial',
      members: links.map((l) => ({
        parentId: String(l.parent_id),
        childId: String(l.child_id),
      })),
    });
  const current =
    (await corpusEvidenceEpoch(c)) === plan.evidenceEpoch &&
    (plan.counts.packageCount === 0 ||
      (await currentCorpusSnapshotReady(c, plan)));
  return Promise.all(
    scopes.map(async (scope) => ({
      scope,
      scopeDigest: await H(scope),
      available:
        current &&
        (scope.kind === 'starter'
          ? plan.counts.includedCharacterCount >= 1600
          : plan.counts.packageCount > 0),
      reasonCode: !current
        ? ('STALE_EVIDENCE' as const)
        : scope.kind === 'starter' && plan.counts.includedCharacterCount < 1600
          ? ('OWNER_DECISION_PENDING' as const)
          : plan.counts.packageCount === 0
            ? ('PACKAGE_INELIGIBLE' as const)
            : null,
    })),
  );
}
export async function readCorpusOwnerReview(
  c: CorpusContext,
  version: string,
  input: { snapshotId?: unknown; limit?: unknown; cursor?: unknown },
): Promise<CorpusOwnerReviewResponse> {
  if (!corpusId(input.snapshotId)) fail('INVALID_QUERY', 400);
  const { row, plan, digests, configuration } = await loadCorpusOwnerSnapshot(
      c,
      version,
      input.snapshotId,
    ),
    limit = input.limit === undefined ? 20 : parsePageLimit(input.limit),
    e = await corpusEvidenceEpoch(c),
    now = corpusNow(c),
    scopes = await permitted(c, plan);
  const binding: CorpusCursorBinding = {
    kind: 'owner-review',
    actorId: c.user.id,
    sessionId: String(c.session.id),
    authRevision: await H({ role: c.user.role, configuration, scopes }),
    installationId: plan.installationId,
    resourceId: String(row.id),
    corpusVersion: version,
    corpusDigest: plan.corpusDigest,
    buildId: plan.buildId,
    releaseRevision: 0,
    evidenceEpoch: e,
    q: '',
    limit,
  };
  let after = -1;
  if (input.cursor !== undefined) {
    const v = await readCorpusCursor(
      c.config.secret!,
      input.cursor,
      binding,
      now,
    );
    if (v.last.length !== 1 || !/^\d{1,5}$/u.test(v.last[0]))
      fail('CURSOR_INVALID', 400);
    after = Number(v.last[0]);
  }
  const rows = await corpusRows(
      c,
      `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(row.id)} AND member_ordinal>${after} ORDER BY member_ordinal LIMIT ${limit + 1}`,
    ),
    page = rows.slice(0, limit),
    nextCursor =
      rows.length > limit
        ? await issueCorpusCursor(
            c.config.secret!,
            binding,
            [String(page.at(-1)!.member_ordinal)],
            now,
          )
        : null;
  if ((await corpusEvidenceEpoch(c)) !== e) fail('CURSOR_STALE');
  await ownerPost(
    c,
    plan.installationId,
    configuration,
    scopes.map((s) => corpusScopeGuard(s.scope)).join(' AND '),
  );
  const counts: CorpusCounts = {
    fixture: plan.counts.fixtureCharacterCount,
    machineValidDraft: new Set(
      plan.packages.flatMap((p) =>
        p.packageEligibility.targets
          .filter(
            (t) =>
              t.intrinsicEligibility.machineValid &&
              t.intrinsicEligibility.classification === 'unverified-draft',
          )
          .map((t) => t.coverageIdentity),
      ),
    ).size,
    reviewedReady:
      e === plan.evidenceEpoch && scopes.some((s) => s.available)
        ? plan.counts.includedCharacterCount
        : 0,
    supervisedTrial: 0,
    prospectiveStarter:
      e === plan.evidenceEpoch && scopes.some((s) => s.available)
        ? plan.counts.includedCharacterCount
        : 0,
    committedStarter: 0,
  };
  return {
    schemaVersion: 'r6-owner-review-1',
    snapshotId: String(row.id),
    corpusVersion: version,
    corpusDigest: plan.corpusDigest,
    prospectiveDigest: digests.prospectiveDigest,
    candidateId: plan.candidateId,
    sourceDigest: plan.sourceDigest,
    artifactDigest: plan.artifactDigest,
    dataAt: corpusISO(now),
    counts,
    permittedScopes: scopes,
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
interface OwnerDocument {
  title: string;
  characters: Array<{
    characterId: string;
    hanzi: string;
    meanings: Array<{ english: string }>;
    readings: Array<{ pinyin: string; audioText: string }>;
    wordAssociations: Array<{
      wordId: string;
      text: string;
      pinyin: string;
      english: string;
      context: { hanzi: string; english: string };
    }>;
    teaching: {
      instructionEnglish: string;
      hintEnglish: string;
      demonstrationEnglish: string;
    };
  }>;
  recognitionChecks: Array<{
    checkId: string;
    instructionEnglish: string;
    prompt: { english: string };
    choices: Array<{ choiceId: string; hanzi: string }>;
    correctChoiceId: string;
  }>;
  assets: Array<{
    assetId: string;
    kind: string;
    evidenceRef: string;
    license: string;
    url?: string;
    digest?: string;
  }>;
  pairedStory: {
    targets: Array<{
      familiarityCheckId: string;
      practice: Array<{ checkId: string }>;
      immediateCheckId: string;
      reviewCheckId: string;
    }>;
    reader: { title: string; instructionEnglish: string; wordIds: string[] };
    playback: {
      kind: 'local-device' | 'recorded';
      voices: CorpusOwnerItemResponse['playback']['voices'];
      cues: Array<{
        checkId: string | null;
        assetId: string;
        assetUrl: string | null;
        assetDigest: string | null;
        transcript: string;
      }>;
    };
  };
}
export async function readCorpusOwnerItem(
  c: CorpusContext,
  version: string,
  id: string,
  lessonVersion: string,
): Promise<CorpusOwnerItemResponse> {
  const { plan, configuration } = await loadCorpusOwnerSnapshot(c, version, id),
    selected = plan.packages.find((p) => p.lessonVersion === lessonVersion);
  if (!selected) fail('NOT_FOUND', 404);
  const loaded = await loadCorpusPackage(c, lessonVersion),
    doc = loaded.document as unknown as OwnerDocument;
  if (loaded.row.content_digest !== selected.contentDigest)
    fail('SNAPSHOT_STALE');
  const targets = doc.characters.map((t) => ({
      characterId: t.characterId,
      hanzi: t.hanzi,
      meanings: t.meanings.map((m) => m.english),
      readings: t.readings.map(({ pinyin, audioText }) => ({
        pinyin,
        audioText,
      })),
      words: t.wordAssociations.map(({ text, pinyin, english, context }) => ({
        text,
        pinyin,
        english,
        context: { hanzi: context.hanzi, english: context.english },
      })),
      teaching: {
        instructionEnglish: t.teaching.instructionEnglish,
        hintEnglish: t.teaching.hintEnglish,
        demonstrationEnglish: t.teaching.demonstrationEnglish,
      },
    })),
    words = doc.characters.flatMap((t) => t.wordAssociations),
    readers = doc.pairedStory.reader.wordIds.map((w) => {
      const word = words.find((x) => x.wordId === w)!;
      return {
        title: doc.pairedStory.reader.title,
        instructionEnglish: doc.pairedStory.reader.instructionEnglish,
        text: word.context.hanzi,
        english: word.context.english,
      };
    });
  const prompts = doc.recognitionChecks.map((check) => {
    const target = doc.pairedStory.targets.find((t) =>
      [
        t.familiarityCheckId,
        t.immediateCheckId,
        t.reviewCheckId,
        ...t.practice.map((p) => p.checkId),
      ].includes(check.checkId),
    )!;
    const review = target.reviewCheckId === check.checkId;
    return {
      phases: review
        ? ['review-24h' as const, 'review-7d' as const]
        : ['initial' as const],
      stepId:
        target.familiarityCheckId === check.checkId
          ? ('familiarity' as const)
          : target.practice.some((p) => p.checkId === check.checkId)
            ? ('practice' as const)
            : ('check' as const),
      instructionEnglish: check.instructionEnglish,
      promptEnglish: check.prompt.english,
      audioText: doc.pairedStory.playback.cues.find(
        (cue) => cue.checkId === check.checkId,
      )!.transcript,
      expectedAnswerHanzi: check.choices.find(
        (choice) => choice.choiceId === check.correctChoiceId,
      )!.hanzi,
    };
  });
  const pe = selected.packageEligibility,
    result: CorpusOwnerItemResponse = {
      schemaVersion: 'r6-owner-item-1',
      snapshotId: id,
      lessonVersion,
      contentDigest: selected.contentDigest,
      title: doc.title,
      targets,
      readers,
      prompts,
      playback: {
        kind: doc.pairedStory.playback.kind,
        voices: doc.pairedStory.playback.voices,
        assets: doc.pairedStory.playback.cues.map((cue) => ({
          assetId: cue.assetId,
          url: cue.assetUrl,
          digest: cue.assetDigest,
          transcript: cue.transcript,
          reviewRef: pe.review?.reviewId ?? 'pending',
        })),
      },
      imageRefs: doc.assets
        .filter((a) => a.kind === 'image' && a.url && a.digest)
        .map((a) => ({
          assetId: a.assetId,
          url: a.url!,
          digest: a.digest!,
          licenseRef: a.evidenceRef,
        })),
      evidenceRefs: {
        source: [...new Set(pe.targets.map((t) => t.sourceEvidenceId))],
        contentReview: pe.review ? [pe.review.reviewId] : [],
        audioReview: pe.review ? [pe.review.reviewId] : [],
        proof: pe.proof ? [pe.proof.proofId] : [],
        assetInventory: [pe.assetInventoryDigest],
      },
    };
  if ((await corpusEvidenceEpoch(c)) !== plan.evidenceEpoch)
    fail('SNAPSHOT_STALE');
  await ownerPost(c, plan.installationId, configuration);
  return result;
}
export async function decideCorpusOwner(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusReceipt> {
  const install = await corpusInstallation(c);
  await ownerPost(c, install);
  const raw = safeCorpusJson(input, 64000);
  if (
    !exact(raw, [
      'requestId',
      'snapshotId',
      'corpusDigest',
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'scope',
      'decision',
    ]) ||
    !corpusId(raw.requestId) ||
    !corpusId(raw.snapshotId) ||
    !digest(raw.corpusDigest) ||
    !corpusId(raw.candidateId) ||
    !digest(raw.sourceDigest) ||
    !digest(raw.artifactDigest) ||
    !['accepted', 'rejected'].includes(String(raw.decision))
  )
    fail('INVALID_REQUEST', 400);
  const scope = normalizeCorpusScope(raw.scope),
    envelope = corpusRequest(
      'owner-decision',
      c.user.id,
      install,
      version,
      raw,
    ),
    old = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_owner_decision WHERE actor_id=${q(c.user.id)} AND installation_id=${q(install)} AND json_extract(request_json,'$.resourceId')=${q(version)} AND request_id=${q(raw.requestId)}`,
    );
  if (old) {
    assertExactCorpusReplay(JSON.parse(String(old.request_json)), envelope);
    await ownerPost(c, install);
    return JSON.parse(String(old.ack_json));
  }
  const { row, plan, configuration } = await loadCorpusOwnerSnapshot(
    c,
    version,
    raw.snapshotId as string,
  );
  if (
    raw.corpusDigest !== plan.corpusDigest ||
    raw.candidateId !== plan.candidateId ||
    raw.sourceDigest !== plan.sourceDigest ||
    raw.artifactDigest !== plan.artifactDigest
  )
    fail('SNAPSHOT_STALE');
  await requireCorpusMembers(
    c,
    scope,
    c.user.role === 'parent' ? c.user.id : undefined,
  );
  const e = await corpusEvidenceEpoch(c);
  if (e !== plan.evidenceEpoch) fail('SNAPSHOT_STALE');
  if (
    raw.decision === 'accepted' &&
    (plan.counts.packageCount === 0 ||
      (scope.kind === 'starter' && plan.counts.includedCharacterCount < 1600))
  )
    fail('PUBLICATION_INELIGIBLE');
  if (
    raw.decision === 'accepted' &&
    !(await currentCorpusSnapshotReady(c, plan))
  )
    fail('PUBLICATION_INELIGIBLE');
  const requestDigest = await H(envelope),
    scopeDigest = await H(scope),
    at = corpusNow(c),
    id = corpusNewId('corpus-owner'),
    ack = {
      requestId: raw.requestId as string,
      recordId: id,
      recordedAt: corpusISO(at),
    },
    guard = `${corpusOwnerGuard(c)} AND ${corpusInstallationGuard(install)} AND ${corpusScopeGuard(scope)} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${e})`;
  if (configuration !== corpusAuthorityConfiguration(c))
    fail('PUBLICATION_STALE');
  try {
    await c.db.batch([
      c.db.prepare(
        corpusInsert(
          'pilot_corpus_owner_decision',
          {
            id,
            snapshot_id: row.id,
            corpus_digest: plan.corpusDigest,
            installation_id: install,
            candidate_id: plan.candidateId,
            source_digest: plan.sourceDigest,
            artifact_digest: plan.artifactDigest,
            scope_json: json(scope),
            scope_digest: scopeDigest,
            decision: raw.decision,
            actor_id: c.user.id,
            owner_session_id: c.session.id,
            request_id: raw.requestId,
            request_digest: requestDigest,
            request_json: json(envelope),
            ack_json: json(ack),
            decided_at: at,
            test_run_id: null,
          },
          guard,
        ),
      ),
    ]);
  } catch {
    const confirmed = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_owner_decision WHERE actor_id=${q(c.user.id)} AND installation_id=${q(install)} AND json_extract(request_json,'$.resourceId')=${q(version)} AND request_id=${q(raw.requestId)}`,
    );
    await ownerPost(c, install);
    if (!confirmed) fail('STORAGE_UNAVAILABLE', 503);
    assertExactCorpusReplay(
      JSON.parse(String(confirmed.request_json)),
      envelope,
    );
    return JSON.parse(String(confirmed.ack_json));
  }
  const saved = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_owner_decision WHERE actor_id=${q(c.user.id)} AND installation_id=${q(install)} AND json_extract(request_json,'$.resourceId')=${q(version)} AND request_id=${q(raw.requestId)}`,
  );
  await ownerPost(c, install, configuration);
  if (!saved) fail('PUBLICATION_STALE');
  assertExactCorpusReplay(JSON.parse(String(saved.request_json)), envelope);
  return JSON.parse(String(saved.ack_json));
}
