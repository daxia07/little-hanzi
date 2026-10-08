/** Pure review contract shared by HTTP writes and historical recovery. */
export interface CurriculumReviewInput {
  requestId: string;
  contentDigest: string;
  previousReviewId: string | null;
  decision: 'approved' | 'rejected';
  reviewerRef: string;
  reviewedAt: number;
  checklistVersion: 'hanzi-review-1';
  checklist: Record<string, boolean>;
  evidenceRef: string;
  reason: string;
}

const CHECKLIST = [
  'scriptAndGlyphs',
  'mandarinAndReadings',
  'wordContexts',
  'teachingAndChecks',
  'ageSuitability',
  'sourcesAndLicenses',
  'deviceAudio',
];
const KEYS = [
  'requestId',
  'contentDigest',
  'previousReviewId',
  'decision',
  'reviewerRef',
  'reviewedAt',
  'checklistVersion',
  'checklist',
  'evidenceRef',
  'reason',
];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function text(value: unknown, max: number): boolean {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    value.trim() === value &&
    value.length > 0 &&
    Array.from(value).length <= max
  );
}

export function isCurriculumReviewInput(
  value: unknown,
  now: number,
): value is CurriculumReviewInput {
  return (
    exact(value, KEYS) &&
    typeof value.requestId === 'string' &&
    SLUG.test(value.requestId) &&
    typeof value.contentDigest === 'string' &&
    DIGEST.test(value.contentDigest) &&
    (value.previousReviewId === null ||
      (typeof value.previousReviewId === 'string' &&
        SLUG.test(value.previousReviewId))) &&
    (value.decision === 'approved' || value.decision === 'rejected') &&
    text(value.reviewerRef, 120) &&
    Number.isSafeInteger(value.reviewedAt) &&
    Number(value.reviewedAt) >= 0 &&
    Number(value.reviewedAt) <= now + 300_000 &&
    value.checklistVersion === 'hanzi-review-1' &&
    exact(value.checklist, CHECKLIST) &&
    Object.values(value.checklist).every((v) => typeof v === 'boolean') &&
    text(value.evidenceRef, 240) &&
    text(value.reason, 240) &&
    (value.decision !== 'approved' ||
      Object.values(value.checklist).every((v) => v === true))
  );
}

interface ProvenancePackage {
  assets: Array<{
    assetId: string;
    kind: string;
    sourceChecked: boolean;
    sourceCheckStatus: string;
  }>;
  characters: Array<{
    assets: string[];
    readings: Array<{ provenance: { sourceChecked: boolean } }>;
    meanings: Array<{ provenance: { sourceChecked: boolean } }>;
    wordAssociations: Array<{ provenance: { sourceChecked: boolean } }>;
  }>;
}
/** Call only after validateCurriculumPackage accepts the complete manifest. */
export function hasCompleteCurriculumProvenance(
  manifest: ProvenancePackage,
): boolean {
  return (
    manifest.assets.every(
      (asset) =>
        asset.sourceChecked &&
        asset.sourceCheckStatus === 'mechanically-checked',
    ) &&
    manifest.characters.every(
      (character) =>
        [
          ...character.readings,
          ...character.meanings,
          ...character.wordAssociations,
        ].every((item) => item.provenance.sourceChecked) &&
        ['glyph', 'font', 'audio'].every((kind) =>
          manifest.assets.some(
            (asset) =>
              asset.kind === kind && character.assets.includes(asset.assetId),
          ),
        ),
    )
  );
}

export function curriculumReviewRequest(
  lessonVersion: string,
  actorUserId: string,
  testRunId: string | null,
  input: CurriculumReviewInput,
) {
  return {
    schemaVersion: 's3-review-request-1',
    lessonVersion,
    actorUserId,
    testRunId,
    input,
  };
}
