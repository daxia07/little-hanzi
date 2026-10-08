/** R6 import-free public DTO contract, r6-data-2. Current-only playback; no server policy imports. */
export type CorpusPhase = 'initial' | 'review-24h' | 'review-7d';
export type CorpusStep =
  | 'welcome'
  | 'familiarity'
  | 'teach'
  | 'practice'
  | 'reader'
  | 'check'
  | 'recap';
export interface CorpusIdentity {
  corpusId: string;
  corpusVersion: string;
  corpusDigest: string;
}
export interface CorpusPackageIdentity extends CorpusIdentity {
  lessonId: string;
  lessonVersion: string;
  contentDigest: string;
  adapterId: 'corpus-paired';
  adapterVersion: 'corpus-paired-v1';
}
/** Cue shape only. Runtime projection restricts these to the current panel, maximum three. */
interface CurrentCorpusPlaybackShape {
  schemaVersion: 'r5-playback-1';
  kind: 'local-device' | 'recorded';
  voices: Array<{ name: string; lang: string; localService: true }>;
  fallback: 'unavailable';
  cues: Array<{
    cueId: string;
    readingId: string | null;
    wordId: string | null;
    checkId: string | null;
    transcript: string;
    assetId: string;
    assetUrl: string | null;
    assetDigest: string | null;
  }>;
}
/** Safe projection: only cues required by the current panel/question, maximum three. */
export interface CorpusSafePlayback {
  schemaVersion: 'r5-playback-1';
  kind: 'local-device' | 'recorded';
  voices: Array<{ name: string; lang: string; localService: true }>;
  fallback: 'unavailable';
  cues: CurrentCorpusPlaybackShape['cues'];
}
export interface CorpusWelcomePanel {
  title: string;
  instructionEnglish: string;
}
export interface CorpusState {
  phase: CorpusPhase;
  stepId: CorpusStep;
  panelIndex: number;
  questionIndex: number;
  questionStatus: 'open' | 'answered' | 'demonstrated' | 'unavailable' | null;
  attempts: number;
  hintLevel: 0 | 1 | 2;
  assisted: boolean;
  targetRoutes: Array<{
    characterId: string;
    mode: 'full' | 'reminder';
  }> | null;
  completedAt: string | null;
}
export interface CorpusQuestion {
  occurrenceId: string;
  characterId: string;
  checkId: string;
  kind: 'plain-print' | 'word-context';
  instructionEnglish: string;
  promptEnglish: string;
  audioText: string;
  requiresAudio: boolean;
  status: 'open' | 'answered' | 'demonstrated' | 'unavailable';
  attempts: number;
  assisted: boolean;
  hintLevel: 0 | 1 | 2;
  choices: Array<{ choiceId: string; hanzi: string }>;
  hintEnglish: string | null;
  demonstrationEnglish: string | null;
}
export interface CorpusTeachingPanel {
  panelId: string;
  characterId: string;
  hanzi: string;
  mode: 'full' | 'reminder';
  instructionEnglish: string;
  hintEnglish: string;
  demonstrationEnglish: string;
  readings: Array<{ readingId: string; pinyin: string; audioText: string }>;
  meanings: string[];
  words: Array<{
    wordId: string;
    text: string;
    pinyin: string;
    english: string;
    context: { hanzi: string; english: string };
  }>;
}
export interface CorpusReaderPanel {
  title: string;
  instructionEnglish: string;
  panelId: string;
  text: string;
  english: string;
  audioText: string;
  highlight: string;
}
export interface CorpusGroup {
  total: number;
  independent: number;
  supported: number;
  unavailable: number;
  pending: number;
  firstResponses: number;
  helpCount: number;
}
export interface CorpusRecap {
  phase: CorpusPhase;
  completedAt: string | null;
  familiarity: CorpusGroup;
  practice: CorpusGroup;
  check: CorpusGroup;
  evidenceLimits: string[];
}
export interface CorpusResult {
  outcome:
    | 'continued'
    | 'incorrect'
    | 'correct'
    | 'hint'
    | 'demonstrated'
    | 'unavailable'
    | 'completed';
  firstResponse: boolean;
  assisted: boolean;
}
export interface CorpusAction {
  eventId: string;
  expectedRevision: number;
  occurrenceId: string | null;
  type: 'continue' | 'answer' | 'help' | 'audio-unavailable';
  payload: Record<string, unknown>;
}
export interface CorpusAck {
  eventId: string;
  revision: number;
  result: CorpusResult;
}
export interface CorpusEvent {
  eventId: string;
  sequence: number;
  occurrenceId: string | null;
  type: CorpusAction['type'];
  serverAt: string;
  result: CorpusResult;
  choiceId: string | null;
}
export interface CorpusRunView extends CorpusPackageIdentity {
  schemaVersion: 'r6-story-view-1';
  runId: string;
  assignmentId: string;
  scheduleId: string;
  releaseId: string;
  releaseRevision: number;
  installationId: string;
  childId: string;
  revision: number;
  state: CorpusState;
  soundReview: 'pending' | 'reviewed' | 'synthetic';
  question: CorpusQuestion | null;
  welcomePanel: CorpusWelcomePanel | null;
  teachingPanel: CorpusTeachingPanel | null;
  readerPanel: CorpusReaderPanel | null;
  lesson: {
    title: string;
    targets: Array<{ characterId: string; hanzi: string }>;
    instructionsEnglish: {
      welcome: string;
      objective: string;
      completion: string;
      recovery: string;
    };
    playback: CorpusSafePlayback;
  };
  events: CorpusEvent[];
  recap: CorpusRecap;
  available: boolean;
  reason: string | null;
  canContinue: boolean;
  dueAt: string;
  serverAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface CorpusLibraryItem extends CorpusPackageIdentity {
  title: string;
  targets: Array<{ characterId: string; hanzi: string }>;
  trackId: string;
  sequence: number;
  releaseId: string | null;
  releaseRevision: number | null;
  available: boolean;
  reason: string | null;
  assignmentId: string | null;
  completed: boolean;
}
export interface CorpusProposal extends CorpusPackageIdentity {
  title: string;
  targets: Array<{ characterId: string; hanzi: string }>;
  proposalId: string;
  childId: string;
  installationId: string;
  predecessorProposalId: string | null;
  selectionOrdinal: number;
  releaseId: string;
  releaseRevision: number;
  sourceDigest: string;
  reason: string;
  selectedByParent: boolean;
  createdAt: string;
  expiresAt: string;
}
export interface CorpusPlanItem extends CorpusLibraryItem {
  planItemId: string;
  ordinal: 0;
}
export interface CorpusPlan extends CorpusIdentity {
  planId: string;
  proposalId: string;
  childId: string;
  installationId: string;
  approvedAt: string;
  available: boolean;
  reason: string | null;
  items: CorpusPlanItem[];
}
export interface CorpusPracticeItem extends CorpusPackageIdentity {
  title: string;
  targets: Array<{ characterId: string; hanzi: string }>;
  installationId: string;
  assignmentId: string;
  scheduleId: string;
  runId: string | null;
  releaseId: string;
  releaseRevision: number;
  kind: CorpusPhase;
  dueAt: string;
  available: boolean;
  reason: string | null;
  stepId: CorpusStep | null;
}
export type CorpusPrimary =
  | {
      kind: 'continue' | 'review' | 'next';
      assignmentId: string;
      scheduleId: string;
      runId: string | null;
    }
  | { kind: 'prepare'; assignmentId: null; scheduleId: null; runId: null };
export interface CorpusVisit extends CorpusPackageIdentity {
  title: string;
  targets: Array<{ characterId: string; hanzi: string }>;
  installationId: string;
  assignmentId: string;
  scheduleId: string;
  runId: string | null;
  releaseId: string;
  phase: CorpusPhase;
  dueAt: string;
  completedAt: string | null;
  introducedTargets: string[];
  recap: CorpusRecap | null;
}
export interface CorpusProgress extends CorpusIdentity {
  schemaVersion: 'r6-family-progress-1';
  installationId: string;
  childId: string;
  plans: CorpusPlan[];
  practice: CorpusPracticeItem[];
  visits: CorpusVisit[];
  evidenceLimits: string[];
}

export type CorpusClassification =
  | 'verification-fixture'
  | 'unverified-draft'
  | 'real-source-reviewed';
export type CorpusReason =
  | 'FIXTURE'
  | 'PLACEHOLDER'
  | 'UNVERIFIED_SOURCE'
  | 'MISSING_LICENSE'
  | 'ALIAS'
  | 'DUPLICATE_IDENTITY'
  | 'INCOMPLETE_WORD_CONTEXT'
  | 'UNREVIEWED_CONTENT'
  | 'UNREVIEWED_AUDIO'
  | 'MISSING_PROMPT'
  | 'MISSING_ASSET'
  | 'UNSUPPORTED_RENDERER'
  | 'INVALID_PROOF'
  | 'STALE_EVIDENCE'
  | 'HISTORICAL_INSTALLATION'
  | 'WITHDRAWN'
  | 'OWNER_DECISION_PENDING'
  | 'PACKAGE_INELIGIBLE';
export interface CorpusCounts {
  fixture: number;
  machineValidDraft: number;
  reviewedReady: number;
  supervisedTrial: number;
  prospectiveStarter: number;
  committedStarter: number;
}
export interface CorpusCatalogItem {
  lessonVersion: string;
  contentDigest: string;
  adapterId: 'corpus-paired';
  adapterVersion: 'corpus-paired-v1';
  title: string;
  targets: Array<{ characterId: string; hanzi: string }>;
  words: Array<{ text: string; english: string }>;
  trackId: string;
  sequence: number;
  releaseId: string;
  releaseRevision: number;
  available: boolean;
  reasonCode: CorpusReason | null;
}
export interface CorpusCatalogResponse {
  schemaVersion: 'r6-catalog-1';
  corpusVersion: string;
  corpusDigest: string;
  releaseRevision: number;
  items: CorpusCatalogItem[];
  nextCursor: string | null;
}
export interface CorpusCoverageItem {
  coverageIdentity: string;
  characterId: string;
  lessonVersion: string;
  contentDigest: string;
  classification: CorpusClassification;
  eligible: boolean;
  reasonCodes: CorpusReason[];
  evidenceRefs: string[];
}
export interface CorpusCoverageResponse {
  schemaVersion: 'r6-coverage-1';
  lane: 'ordinary' | 'verification';
  fixtureCharacterCount: number;
  verificationPackageCount: number;
  corpusVersion: string;
  corpusDigest: string;
  dataAt: string;
  counts: CorpusCounts;
  snapshot: null | {
    snapshotId: string;
    digest: string;
    includedCharacterCount: number;
    excludedTargetCount: number;
    packageCount: number;
    createdAt: string;
  };
  release: null | {
    releaseId: string;
    revision: number;
    status: 'released' | 'withdrawn';
    snapshotCharacterCount: number;
    currentEligibleCharacterCount: number;
  };
  items: CorpusCoverageItem[];
  nextCursor: string | null;
}
export type CorpusScope =
  | { kind: 'starter' }
  | {
      kind: 'supervised-trial';
      members: Array<{ parentId: string; childId: string }>;
    };
export interface CorpusOwnerReviewResponse {
  schemaVersion: 'r6-owner-review-1';
  snapshotId: string;
  corpusVersion: string;
  corpusDigest: string;
  prospectiveDigest: string;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  dataAt: string;
  counts: CorpusCounts;
  permittedScopes: Array<{
    scope: CorpusScope;
    scopeDigest: string;
    available: boolean;
    reasonCode: CorpusReason | null;
  }>;
  items: CorpusCoverageItem[];
  nextCursor: string | null;
}
export interface CorpusOwnerItemResponse {
  schemaVersion: 'r6-owner-item-1';
  snapshotId: string;
  lessonVersion: string;
  contentDigest: string;
  title: string;
  targets: Array<{
    characterId: string;
    hanzi: string;
    meanings: string[];
    readings: Array<{ pinyin: string; audioText: string }>;
    words: Array<{
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
  readers: Array<{
    title: string;
    instructionEnglish: string;
    text: string;
    english: string;
  }>;
  prompts: Array<{
    phases: CorpusPhase[];
    stepId: 'familiarity' | 'practice' | 'check';
    instructionEnglish: string;
    promptEnglish: string;
    audioText: string;
    expectedAnswerHanzi: string;
  }>;
  playback: {
    kind: 'local-device' | 'recorded';
    voices: Array<{ name: string; lang: string; localService: true }>;
    assets: Array<{
      assetId: string;
      url: string | null;
      digest: string | null;
      transcript: string;
      reviewRef: string;
    }>;
  };
  imageRefs: Array<{
    assetId: string;
    url: string;
    digest: string;
    licenseRef: string;
  }>;
  evidenceRefs: {
    source: string[];
    contentReview: string[];
    audioReview: string[];
    proof: string[];
    assetInventory: string[];
  };
}
export interface CorpusProposalInput {
  corpusVersion: string;
  selection: null | {
    lessonVersion: string;
    contentDigest: string;
    releaseId: string;
    releaseRevision: number;
  };
  predecessorProposalId: string | null;
  expectedSourceDigest: string | null;
}
export interface CorpusApproveInput {
  proposalId: string;
  sourceDigest: string;
}
export interface CorpusStartInput {
  requestId: string;
  scheduleId: string;
}
export interface CorpusReceipt {
  requestId: string;
  recordId: string;
  recordedAt: string;
}
export interface CorpusPublicationReceipt extends CorpusReceipt {
  revision: number;
  corpusDigest: string;
  snapshotId: string;
}
export interface CorpusBatchResponse {
  schemaVersion: 'r6-batch-1';
  batchId: string;
  batchVersion: string;
  manifestDigest: string;
  recordedAt: string;
  items: Array<{
    lessonVersion: string;
    contentDigest: string;
    state: 'accepted' | 'rejected';
    errors: Array<{ fieldId: string; code: string }>;
  }>;
}
export interface CorpusActionResponse {
  ack: CorpusAck;
  replayed: boolean;
}

export interface CorpusMetadata {
  corpusId: string;
  corpusVersion: string;
  corpusDigest: string;
  policyVersion: 'r6-corpus-policy-1';
  packageCount: number;
  importedAt: string;
}
export interface CorpusMetadataResponse {
  schemaVersion: 'r6-corpora-1';
  items: CorpusMetadata[];
  nextCursor: string | null;
}

export interface CorpusProofSaved {
  receiptId: string;
  receiptDigest: string;
  lessonVersion: string;
  contentDigest: string;
  receivedAt: string;
}
export interface CorpusSnapshotCounts {
  candidatePackageCount: number;
  targetCount: number;
  packageCount: number;
  includedCharacterCount: number;
  excludedTargetCount: number;
  fixtureCharacterCount: number;
  verificationPackageCount: number;
}
export interface CorpusSnapshotBeginReceipt {
  requestId: string;
  snapshotId: string;
  status: 'building';
  recordedAt: string;
  packageCount: number;
  targetCount: number;
}
export interface CorpusSnapshotChunkReceipt {
  requestId: string;
  snapshotId: string;
  packageCount: number;
  targetRowCount: number;
  recordedAt: string;
}
export interface CorpusSnapshotSealReceipt {
  requestId: string;
  snapshotId: string;
  status: 'sealed';
  prospectiveDigest: string;
  packageCount: number;
  includedCharacterCount: number;
  excludedTargetCount: number;
  recordedAt: string;
}
export interface CorpusSnapshotResponse {
  schemaVersion: 'r6-snapshot-1';
  snapshotId: string;
  corpusVersion: string;
  corpusDigest: string;
  status: 'building' | 'sealed';
  lane: 'ordinary' | 'verification';
  candidateId: string;
  buildId: string;
  planDigest: string;
  prospectiveDigest: string | null;
  exclusionReportDigest: string | null;
  createdAt: string;
  sealedAt: string | null;
  counts: CorpusSnapshotCounts;
}
export interface CorpusSnapshotMembersResponse {
  schemaVersion: 'r6-snapshot-members-1';
  snapshotId: string;
  status: 'included' | 'excluded';
  items: CorpusCoverageItem[];
  nextCursor: string | null;
}

export interface CorpusPlacementResponse {
  setupComplete: boolean;
  proposal: CorpusProposal | null;
  reason: string | null;
}
export interface CorpusProposalResponse {
  proposal: CorpusProposal;
}
export interface CorpusPlanResponse {
  plan: CorpusPlan | null;
  history: CorpusPlan[];
}
export interface CorpusApproveResponse {
  plan: CorpusPlan;
}
export interface CorpusPracticeResponse {
  items: CorpusPracticeItem[];
  primary: CorpusPrimary;
}
