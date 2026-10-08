/** Pure server learning envelopes; no browser-supplied authority or clock. */
import type { CorpusAction } from '../curriculum/corpus-types.ts';
import { corpusId, safeCorpusJson } from './corpus-policy.ts';
import { exact, digest } from '../curriculum/story-package.ts';
import { fail } from './story-policy.ts';
import { curriculumDigest } from '../curriculum/digest.ts';
import { inspectCorpusAuthorityIdentity } from './corpus-family-policy.ts';
export function corpusSeed(assignmentId: string): number {
  let seed = 2166136261;
  for (let i = 0; i < assignmentId.length; i++)
    seed = Math.imul(seed ^ assignmentId.charCodeAt(i), 16777619);
  return seed >>> 0;
}
export function inspectCorpusStartInput(input: unknown) {
  const v = safeCorpusJson(input, 8000);
  if (
    !exact(v, ['requestId', 'scheduleId']) ||
    !corpusId(v.requestId) ||
    !corpusId(v.scheduleId)
  )
    fail('INVALID_REQUEST', 400);
  return v as { requestId: string; scheduleId: string };
}
export function inspectCorpusAction(input: unknown): CorpusAction {
  const v = safeCorpusJson(input, 8000);
  if (
    !exact(v, [
      'eventId',
      'expectedRevision',
      'occurrenceId',
      'type',
      'payload',
    ]) ||
    !corpusId(v.eventId) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    Number(v.expectedRevision) < 0 ||
    !(
      v.occurrenceId === null ||
      (typeof v.occurrenceId === 'string' && v.occurrenceId.length <= 200)
    ) ||
    !['continue', 'answer', 'help', 'audio-unavailable'].includes(
      String(v.type),
    ) ||
    (v.type === 'answer'
      ? !exact(v.payload, ['choiceId']) || !corpusId(v.payload.choiceId)
      : !exact(v.payload, []))
  )
    fail('INVALID_REQUEST', 400);
  return v as unknown as CorpusAction;
}

export async function inspectCorpusEventPolicy(input: unknown) {
  const v = safeCorpusJson(input, 200000);
  if (
    !exact(v, [
      'soundReview',
      'authority',
      'authorityDigest',
      'packageEligibilityDigest',
      'reviewId',
      'proofId',
    ]) ||
    !['pending', 'reviewed', 'synthetic'].includes(String(v.soundReview)) ||
    !digest(v.authorityDigest) ||
    !digest(v.packageEligibilityDigest) ||
    !(v.reviewId === null || corpusId(v.reviewId)) ||
    !(v.proofId === null || corpusId(v.proofId)) ||
    !v.authority ||
    typeof v.authority !== 'object' ||
    Array.isArray(v.authority)
  )
    fail('INVALID_REQUEST', 400);
  const raw = v.authority as Record<string, unknown>,
    a = await inspectCorpusAuthorityIdentity(raw, {
      installationId: raw.installationId,
      corpusVersion: raw.corpusVersion,
      corpusDigest: raw.corpusDigest,
      namespace: raw.namespaceKey === 'ordinary' ? null : raw.namespaceKey,
      selection: {
        releaseId: raw.releaseId,
        releaseRevision: raw.releaseRevision,
      },
    });
  if (
    (await curriculumDigest(a)) !== v.authorityDigest ||
    ((a.scope as { kind: string }).kind === 'verification'
      ? v.soundReview === 'reviewed'
      : v.soundReview !== 'reviewed')
  )
    fail('INVALID_REQUEST', 400);
  return {
    soundReview: v.soundReview as 'pending' | 'reviewed' | 'synthetic',
    authority: a,
    authorityDigest: v.authorityDigest as string,
    packageEligibilityDigest: v.packageEligibilityDigest as string,
    reviewId: v.reviewId as string | null,
    proofId: v.proofId as string | null,
  };
}

/** Selectors never override a stored assignment/run/proposal adapter. */
export function inspectCorpusLearningQuery(
  params: URLSearchParams,
  operation: string,
) {
  if (params.has('corpusVersion') && params.has('collectionVersion'))
    fail('INVALID_REQUEST', 400);
  if (!params.has('corpusVersion')) {
    if (
      ['run', 'action', 'start', 'approve'].includes(operation) &&
      params.has('collectionVersion')
    )
      fail('INVALID_REQUEST', 400);
    return undefined;
  }
  const values = params.getAll('corpusVersion');
  if (
    !['placement', 'plan', 'practice'].includes(operation) ||
    values.length !== 1 ||
    [...params.keys()].some((k) => k !== 'corpusVersion') ||
    !corpusId(values[0])
  )
    fail('INVALID_REQUEST', 400);
  return values[0];
}
