/** Deterministic dependency projection; proof metadata must already be signature-authenticated. */
import {
  canonicalPackage,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { compileCorpusRuntime } from '../curriculum/corpus-runtime.ts';
import type { CorpusClassification } from '../curriculum/corpus-types.ts';
import { fail } from './story-policy.ts';
import {
  assetInventory,
  reviewBinding,
  intrinsicReasons,
  type SnapshotCandidate,
  type IntrinsicEligibility,
  type PackageEligibility,
} from './corpus-snapshot-policy.ts';
export interface SnapshotReferences {
  ordinal: number;
  document: Record<string, unknown>;
  contentDigest: string;
  characters: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  review: Record<string, unknown> | null;
  proof: PackageEligibility['proof'];
  installationId: string;
  lane: 'ordinary' | 'verification';
}
export async function evaluateSnapshotCandidate(
  refs: SnapshotReferences,
): Promise<SnapshotCandidate> {
  const compiled = await compileCorpusRuntime(refs.document);
  if (compiled.identity.contentDigest !== refs.contentDigest)
    fail('SNAPSHOT_INVALID', 400);
  const version = compiled.identity.lessonVersion,
    characters = refs.document.characters as Array<Record<string, unknown>>,
    assets = refs.document.assets as Array<Record<string, unknown>>,
    playback = (refs.document.pairedStory as Record<string, unknown>)
      .playback as Record<string, unknown>,
    review = refs.review,
    approved =
      review?.decision === 'approved' &&
      review.content_digest === refs.contentDigest &&
      review.test_run_id === null;
  const checklist = review ? JSON.parse(String(review.checklist_json)) : {};
  const reviewed =
      approved && Object.values(checklist).every((v) => v === true),
    assetComplete = assets.every(
      (a) =>
        a.sourceChecked === true &&
        a.sourceCheckStatus === 'mechanically-checked',
    ),
    audioComplete =
      reviewed &&
      checklist.deviceAudio === true &&
      (playback.kind === 'recorded' ||
        (playback.kind === 'local-device' &&
          Array.isArray(playback.voices) &&
          playback.voices.length > 0));
  const inventory = assetInventory(refs.document, refs.contentDigest),
    targets: SnapshotCandidate['targets'] = [];
  for (const [targetIndex, t] of characters.entries()) {
    const character = refs.characters.find(
        (r) =>
          r.target_index === targetIndex &&
          r.character_id === t.characterId &&
          r.lesson_version === version &&
          r.content_digest === refs.contentDigest,
      ),
      source = refs.sources.find((r) => r.id === character?.current_source_id);
    if (!character || !source) fail('SNAPSHOT_INVALID', 400);
    const sourceFacts = JSON.parse(String(source.evidence_json));
    if (
      canonicalPackage(sourceFacts) !== source.evidence_json ||
      (await H(sourceFacts)) !== source.evidence_digest ||
      sourceFacts.lessonVersion !== version ||
      sourceFacts.contentDigest !== refs.contentDigest ||
      sourceFacts.classification !== source.classification
    )
      fail('SNAPSHOT_INVALID', 400);
    const identities = Array.isArray(sourceFacts.identityReviews)
        ? (sourceFacts.identityReviews as Array<Record<string, unknown>>)
        : [],
      identity = identities.find(
        (i) =>
          i.characterId === t.characterId &&
          i.hanzi === t.hanzi &&
          i.reviewRef === review?.review_id,
      ),
      classification = source.classification as CorpusClassification;
    const base = {
      characterId: String(t.characterId),
      coverageIdentity: String(t.hanzi),
      classification,
      identityKind:
        identity?.kind === 'simplified'
          ? ('simplified' as const)
          : identity?.kind === 'alias'
            ? ('alias' as const)
            : null,
      identityReview: identity
        ? {
            characterId: String(identity.characterId),
            hanzi: String(identity.hanzi),
            kind: identity.kind as 'simplified' | 'alias',
            reviewRef: String(identity.reviewRef),
          }
        : null,
      machineValid: true,
      licensed:
        Array.isArray(sourceFacts.sourceRefs) &&
        sourceFacts.sourceRefs.length > 0 &&
        Array.isArray(sourceFacts.licenseRefs) &&
        sourceFacts.licenseRefs.length > 0,
      wordsComplete: true,
      contentReviewed: reviewed,
      audioReviewed: audioComplete,
      promptsComplete: true,
      assetsComplete: assetComplete,
      proofValid: refs.proof !== null,
      current: source.installation_id === refs.installationId,
      placeholder: false,
    };
    const intrinsic: IntrinsicEligibility = {
      schemaVersion: 'r6-target-eligibility-1',
      ...base,
      realEligible:
        classification === 'real-source-reviewed' &&
        base.identityKind === 'simplified' &&
        base.identityReview !== null &&
        base.licensed &&
        base.contentReviewed &&
        base.audioReviewed &&
        base.assetsComplete &&
        base.proofValid &&
        base.current,
      machineUsableVerification:
        refs.lane === 'verification' &&
        classification === 'verification-fixture',
      reasonCodes: intrinsicReasons(base),
    };
    targets.push({
      targetIndex: targetIndex as 0 | 1,
      characterId: base.characterId,
      coverageIdentity: base.coverageIdentity,
      sourceEvidenceId: String(source.id),
      sourceEvidenceDigest: String(source.evidence_digest),
      requirementsDigest: String(character.requirements_digest),
      intrinsicEligibility: intrinsic,
    });
  }
  return {
    ordinal: refs.ordinal,
    lessonVersion: version,
    contentDigest: refs.contentDigest,
    assetInventory: inventory,
    review: review
      ? {
          reviewId: String(review.review_id),
          reviewDigest: await H(reviewBinding(review)),
        }
      : null,
    reviewSequence: review ? Number(review.review_sequence) : null,
    proof: refs.proof,
    targets,
  };
}
