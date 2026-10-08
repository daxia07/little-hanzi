/** Import-free paired renderer types. Private package keys are server-only. */
export type PairedPhase = 'initial' | 'review-24h' | 'review-7d';
export type PairedStep =
  | 'welcome'
  | 'familiarity'
  | 'teach'
  | 'practice'
  | 'reader'
  | 'check'
  | 'recap';
export type PairedSound = 'pending' | 'reviewed' | 'synthetic';
export interface PairedCue {
  cueId: string;
  readingId: string | null;
  wordId: string | null;
  checkId: string | null;
  transcript: string;
  assetId: string;
  assetUrl: string | null;
  assetDigest: string | null;
}
export interface PairedPlayback {
  schemaVersion: 'r5-playback-1';
  kind: 'local-device' | 'recorded';
  voices: Array<{ name: string; lang: string; localService: true }>;
  fallback: 'unavailable';
  cues: PairedCue[];
}
export interface PairedTarget {
  characterId: string;
  readingId: string;
  familiarityCheckId: string;
  practice: Array<{ wordId: string; checkId: string }>;
  immediateCheckId: string;
  reviewCheckId: string;
}
export interface PairedProfile {
  schemaVersion: 'r5-paired-story-1';
  welcome: { title: string; instructionEnglish: string };
  targets: PairedTarget[];
  reader: { title: string; instructionEnglish: string; wordIds: string[] };
  playback: PairedPlayback;
}
export interface PairedCharacter {
  characterId: string;
  hanzi: string;
  readings: Array<{ readingId: string; pinyin: string; audioText: string }>;
  meanings: Array<{ english: string }>;
  wordAssociations: Array<{
    wordId: string;
    text: string;
    pinyin: string;
    english: string;
    readingId: string;
    context: { hanzi: string; english: string; targetCharacter: string };
  }>;
  teaching: {
    instructionEnglish: string;
    hintEnglish: string;
    demonstrationEnglish: string;
    recognitionCheckId: string;
    delayedReview: {
      promptId: string;
      instructionEnglish: string;
      cueEnglish: string;
      recognitionCheckId: string;
    };
  };
  assets: string[];
}
export interface PairedCheck {
  checkId: string;
  characterId: string;
  kind: 'plain-print' | 'word-context';
  instructionEnglish: string;
  prompt: { english: string; hanzi: string };
  choices: Array<{ choiceId: string; hanzi: string }>;
  correctChoiceId: string;
}
export interface PairedPackage {
  lessonId: string;
  lessonVersion: string;
  title: string;
  instructionsEnglish: {
    welcome: string;
    objective: string;
    completion: string;
    recovery: string;
  };
  renderer: {
    adapterId: string;
    adapterVersion: string;
    capabilities: string[];
  };
  characters: PairedCharacter[];
  recognitionChecks: PairedCheck[];
  steps: Array<{
    stepId: string;
    kind: string;
    instructionEnglish: string;
    recognitionCheckIds: string[];
  }>;
  assets: Array<{ assetId: string; kind: string }>;
  pairedStory: PairedProfile;
}
export interface PairedIdentity {
  lessonId: string;
  lessonVersion: string;
  contentDigest: string;
  adapterId: 'paired-story';
  adapterVersion: 'paired-story-v1';
}
export interface PairedState {
  phase: PairedPhase;
  stepId: PairedStep;
  panelIndex: number;
  questionIndex: number;
  questionStatus: null | 'open' | 'answered' | 'demonstrated' | 'unavailable';
  attempts: number;
  hintLevel: 0 | 1 | 2;
  assisted: boolean;
  targetRoutes: null | Array<{
    characterId: string;
    mode: 'full' | 'reminder';
  }>;
  completedAt: string | null;
}
export interface PairedAction {
  eventId: string;
  expectedRevision: number;
  occurrenceId: string | null;
  type: 'continue' | 'answer' | 'help' | 'audio-unavailable';
  payload: Record<string, unknown>;
}
export interface PairedResult {
  outcome:
    | 'continued'
    | 'hint'
    | 'completed'
    | 'correct'
    | 'incorrect'
    | 'demonstrated'
    | 'unavailable';
  firstResponse: boolean;
  assisted: boolean;
}
export interface PairedAck {
  eventId: string;
  revision: number;
  result: PairedResult;
}
export interface PairedEvent {
  eventId: string;
  sequence: number;
  phase: PairedPhase;
  stepId: PairedStep;
  occurrenceId: string | null;
  checkId: string | null;
  characterId: string | null;
  serverTime: string;
  soundReview: PairedSound;
  action: PairedAction;
  result: PairedResult;
}
export interface PairedRun {
  schemaVersion: 'r5-paired-run-1';
  runId: string;
  identity: PairedIdentity;
  seed: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  state: PairedState;
  events: PairedEvent[];
}
export interface PairedGroup {
  total: number;
  independent: number;
  supported: number;
  unavailable: number;
  pending: number;
  firstResponses: Array<{
    occurrenceId: string;
    characterId: string;
    correct: boolean;
    assisted: boolean;
  }>;
  helpCount: number;
}
export interface PairedRecap {
  phase: PairedPhase;
  familiarity: PairedGroup;
  practice: PairedGroup;
  immediate: PairedGroup;
  review: PairedGroup;
  completedAt: string | null;
  evidenceLimits: string[];
}
