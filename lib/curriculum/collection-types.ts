/** Frozen R5 browser-only wire contract (r5-data-1). No imports, grading keys or private review data. */
export type CollectionPhase = 'initial' | 'review-24h' | 'review-7d';
export type CollectionStep =
  | 'welcome'
  | 'familiarity'
  | 'teach'
  | 'practice'
  | 'reader'
  | 'check'
  | 'recap';
export interface CollectionIdentity {
  collectionId: string;
  collectionVersion: string;
  collectionDigest: string;
}
export interface CollectionPackageIdentity extends CollectionIdentity {
  lessonId: string;
  lessonVersion: string;
  contentDigest: string;
  adapterId: 'paired-story';
  adapterVersion: 'paired-story-v1';
}
/** Full immutable server profile; never project its complete cue map to clients. */
export interface CollectionPlayback {
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
export interface CollectionSafePlayback {
  schemaVersion: 'r5-playback-1';
  kind: 'local-device' | 'recorded';
  voices: Array<{ name: string; lang: string; localService: true }>;
  fallback: 'unavailable';
  cues: CollectionPlayback['cues'];
}
export interface CollectionWelcomePanel {
  title: string;
  instructionEnglish: string;
}
export interface CollectionState {
  phase: CollectionPhase;
  stepId: CollectionStep;
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
export interface CollectionQuestion {
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
export interface CollectionTeachingPanel {
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
export interface CollectionReaderPanel {
  title: string;
  instructionEnglish: string;
  panelId: string;
  text: string;
  english: string;
  audioText: string;
  highlight: string;
}
export interface CollectionGroup {
  total: number;
  independent: number;
  supported: number;
  unavailable: number;
  pending: number;
  firstResponses: number;
  helpCount: number;
}
export interface CollectionRecap {
  phase: CollectionPhase;
  completedAt: string | null;
  familiarity: CollectionGroup;
  practice: CollectionGroup;
  check: CollectionGroup;
  evidenceLimits: string[];
}
export interface CollectionResult {
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
export interface CollectionAction {
  eventId: string;
  expectedRevision: number;
  occurrenceId: string | null;
  type: 'continue' | 'answer' | 'help' | 'audio-unavailable';
  payload: Record<string, unknown>;
}
export interface CollectionAck {
  eventId: string;
  revision: number;
  result: CollectionResult;
}
export interface CollectionEvent {
  eventId: string;
  sequence: number;
  occurrenceId: string | null;
  type: CollectionAction['type'];
  serverAt: string;
  result: CollectionResult;
  choiceId: string | null;
}
export interface CollectionRunView extends CollectionPackageIdentity {
  schemaVersion: 'r5-story-view-1';
  runId: string;
  assignmentId: string;
  scheduleId: string;
  publicationId: string;
  publicationGeneration: number;
  installationId: string;
  childId: string;
  revision: number;
  state: CollectionState;
  soundReview: 'pending' | 'reviewed' | 'synthetic';
  question: CollectionQuestion | null;
  welcomePanel: CollectionWelcomePanel | null;
  teachingPanel: CollectionTeachingPanel | null;
  readerPanel: CollectionReaderPanel | null;
  lesson: {
    title: string;
    targets: Array<{ characterId: string; hanzi: string }>;
    instructionsEnglish: {
      welcome: string;
      objective: string;
      completion: string;
      recovery: string;
    };
    playback: CollectionSafePlayback;
  };
  events: CollectionEvent[];
  recap: CollectionRecap;
  available: boolean;
  reason: string | null;
  canContinue: boolean;
  dueAt: string;
  serverAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface CollectionLibraryItem extends CollectionPackageIdentity {
  title: string;
  targets: Array<{ characterId: string; hanzi: string }>;
  trackId: string;
  sequence: number;
  publicationId: string | null;
  generation: number | null;
  available: boolean;
  reason: string | null;
  assignmentId: string | null;
  completed: boolean;
}
export interface CollectionProposal extends CollectionPackageIdentity {
  proposalId: string;
  childId: string;
  installationId: string;
  predecessorProposalId: string | null;
  selectionOrdinal: number;
  publicationId: string;
  generation: number;
  sourceDigest: string;
  reason: string;
  selectedByParent: boolean;
  createdAt: string;
  expiresAt: string;
}
export interface CollectionPlanItem extends CollectionLibraryItem {
  planItemId: string;
  ordinal: 0;
}
export interface CollectionPlan extends CollectionIdentity {
  planId: string;
  proposalId: string;
  childId: string;
  installationId: string;
  approvedAt: string;
  available: boolean;
  reason: string | null;
  items: CollectionPlanItem[];
}
export interface CollectionPracticeItem extends CollectionPackageIdentity {
  assignmentId: string;
  scheduleId: string;
  runId: string | null;
  publicationId: string;
  generation: number;
  kind: CollectionPhase;
  dueAt: string;
  available: boolean;
  reason: string | null;
  stepId: CollectionStep | null;
}
export type CollectionPrimary =
  | {
      kind: 'continue' | 'review' | 'next';
      assignmentId: string;
      scheduleId: string;
      runId: string | null;
    }
  | { kind: 'prepare'; assignmentId: null; scheduleId: null; runId: null };
export interface CollectionVisit extends CollectionPackageIdentity {
  assignmentId: string;
  scheduleId: string;
  runId: string | null;
  publicationId: string;
  phase: CollectionPhase;
  dueAt: string;
  completedAt: string | null;
  introducedTargets: string[];
  recap: CollectionRecap | null;
}
export interface CollectionProgress extends CollectionIdentity {
  schemaVersion: 'r5-family-progress-1';
  installationId: string;
  childId: string;
  plans: CollectionPlan[];
  practice: CollectionPracticeItem[];
  visits: CollectionVisit[];
  evidenceLimits: string[];
}
export interface CollectionProposalInput {
  collectionVersion: string;
  lessonVersion: string | null;
  predecessorProposalId: string | null;
  expectedSourceDigest: string | null;
}
export interface CollectionApproveInput {
  proposalId: string;
  sourceDigest: string;
}
export interface CollectionStartInput {
  requestId: string;
  scheduleId: string;
}
export interface CollectionStartAck {
  runId: string;
  assignmentId: string;
  scheduleId: string;
  lessonVersion: string;
  revision: 0;
}
export interface CollectionLibraryResponse {
  items: CollectionLibraryItem[];
}
export interface CollectionPlacementResponse {
  setupComplete: boolean;
  proposal: CollectionProposal | null;
  reason: string | null;
}
export interface CollectionProposalResponse {
  proposal: CollectionProposal;
}
export interface CollectionApproveResponse {
  plan: CollectionPlan;
}
export interface CollectionPlanResponse {
  plan: CollectionPlan | null;
  history: CollectionPlan[];
}
export interface CollectionPracticeResponse {
  items: CollectionPracticeItem[];
  primary: CollectionPrimary;
}
export interface CollectionActionResponse {
  ack: CollectionAck;
  replayed: boolean;
}
export interface CollectionMetadata extends CollectionIdentity {
  trackId: string;
  lessonCount: number;
  importedAt: string;
}
export interface CollectionMetadataResponse {
  items: CollectionMetadata[];
}
export interface CollectionImportResponse {
  collectionVersion: string;
  collectionDigest: string;
}
