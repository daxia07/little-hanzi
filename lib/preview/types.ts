/** Browser-safe and server-safe types for the forest preview contract. */

export type LessonId = 'forest-01';
export type LessonVersion = 'forest-01-v1' | 'forest-01-v3';
export type Phase = 'initial' | 'delayed';
export type QuestionStatus =
  | 'open'
  | 'answered'
  | 'demonstrated'
  | 'unavailable'
  | null;
export type Outcome =
  | 'correct'
  | 'incorrect'
  | 'demonstrated'
  | 'unavailable'
  | 'recorded';

export type PreviewStep =
  | 'welcome'
  | 'familiarity'
  | 'learn'
  | 'build'
  | 'find'
  | 'read'
  | 'check'
  | 'recap'
  | 'delayed-review';

export type ActionType =
  | 'answer'
  | 'hint'
  | 'place-component'
  | 'continue'
  | 'audio-unavailable'
  | 'start-review';

export type FeedbackCategory =
  | 'clarity'
  | 'pacing'
  | 'difficulty'
  | 'mascot'
  | 'reporting'
  | 'other';
export type FeedbackSource = 'reviewer' | 'child';
export type DecisionStatus = 'draft' | 'changes-requested' | 'approved';

export interface ForestCharacter {
  id: 'mu' | 'lin' | 'ren' | 'da';
  hanzi: string;
  pinyin: string;
  raw: string;
  meaning: string;
  word: string;
}

export interface ForestChoice {
  id: string;
  label: string;
  audioText?: string;
}

export interface ForestQuestion {
  id: string;
  ordinal: number;
  stepId: PreviewStep;
  characterId: 'mu' | 'lin';
  prompt: string;
  cueText: string;
  kind: 'sound-to-print' | 'print-to-audio' | 'scene';
  choices: ForestChoice[];
  correctChoiceId: string;
  soundDependent: boolean;
  hint: string;
  demonstration: string;
}

export interface ForestAsset {
  id: string;
  kind: 'illustration' | 'audio' | 'glyph' | 'font';
  source: string;
  license: string;
  sourceChecked: boolean;
  reviewStatus: 'pending-owner' | 'mechanically-checked' | 'approved';
}

export interface ForestLessonDefinition {
  lessonId: LessonId;
  lessonVersion: LessonVersion;
  title: string;
  tutor: { kind: 'scripted'; description: string };
  characters: ForestCharacter[];
  examples: Array<{ text: string; meaning: string; audioText: string }>;
  steps: PreviewStep[];
  questions: ForestQuestion[];
  assets: ForestAsset[];
  captions: Array<{
    id: string;
    text: string;
    highlight: 'mu' | 'lin';
    narration: string;
  }>;
  componentLayout: {
    glyph: string;
    left: string;
    right: string;
    proportions: string;
  };
}

export interface IntroPlan {
  mode: 'full' | 'reminder' | 'mixed';
  full: Array<'mu' | 'lin'>;
  reminder: Array<'mu' | 'lin'>;
}

export interface PreviewState {
  phase: Phase;
  stepId: PreviewStep;
  questionId: string | null;
  questionStatus: QuestionStatus;
  attempts: number;
  hintLevel: number;
  assisted: boolean;
  placedComponents: {
    left: 'mu-a' | 'mu-b' | null;
    right: 'mu-a' | 'mu-b' | null;
  };
  introPlan: IntroPlan | null;
  readPanel: 'read-wood' | 'read-grove' | null;
  completedAt: string | null;
  reviewCompletedAt: string | null;
  /** V3-only persisted presentation; absent from historical V1 JSON. */
  learnPanel?: null | 'learn-mu' | 'learn-lin' | 'reminder';
  /** Server-owned synthetic mechanics eligibility; human media review stays pending. */
  soundReview?: 'pending' | 'synthetic';
}

export interface PreviewRun {
  runId: string;
  lessonId: LessonId;
  lessonVersion: LessonVersion;
  seed: number;
  revision: number;
  state: PreviewState;
  createdAt: string;
  updatedAt: string;
  synthetic: boolean;
  testRunId: string | null;
  scenario: string | null;
  effectiveTime: string;
}

export interface PreviewAction {
  eventId: string;
  expectedRevision: number;
  stepId: PreviewStep;
  type: ActionType;
  payload: Record<string, unknown>;
}

export interface PreviewResult {
  outcome: Outcome;
  firstResponse: boolean;
  assisted: boolean;
}

export interface LearningEvent {
  eventId: string;
  runId: string;
  sequence: number;
  phase: Phase;
  stepId: PreviewStep;
  questionId: string | null;
  type: ActionType;
  payload: Record<string, unknown>;
  serverTime: string;
  firstResponse: boolean;
  assisted: boolean;
  outcome: Outcome;
  /** The server response is retained for exact idempotent replay. */
  result: PreviewResult;
}

export interface RecapGroup {
  total: number;
  independentCorrect: number;
  supported: number;
  unavailable: number;
  pending: number;
}

export interface PreviewRecap {
  familiarity: RecapGroup;
  final: RecapGroup;
  delayed: RecapGroup;
  buildCompleted: boolean;
  sceneCompleted: boolean;
}

export interface PreviewFeedback {
  feedbackId: string;
  runId: string;
  lessonVersion: LessonVersion;
  stepId: PreviewStep | null;
  category: FeedbackCategory;
  text: string;
  source: FeedbackSource;
  createdAt: string;
}

export interface ReviewDecision {
  decisionId: string;
  lessonVersion: LessonVersion;
  status: Exclude<DecisionStatus, 'draft'>;
  reviewerLabel: string;
  notes: string;
  candidateId: string;
  createdAt: string;
  synthetic: boolean;
}

export interface DecisionView {
  lessonVersion: LessonVersion;
  candidateId: string;
  status: DecisionStatus;
  history: ReviewDecision[];
}

export interface ActionAck {
  /** V3 acks carry version explicitly; V1 ack JSON remains unchanged. */
  lessonVersion?: LessonVersion;
  eventId: string;
  result: PreviewResult;
  state: PreviewState;
  revision: number;
}

export interface RunView extends PreviewRun {
  events: LearningEvent[];
  recap: PreviewRecap;
  feedback: PreviewFeedback[];
  reviewAvailableAt: string | null;
  reviewDue: boolean;
}

export interface DomainErrorShape {
  code:
    | 'INVALID_REQUEST'
    | 'NOT_FOUND'
    | 'STALE_REVISION'
    | 'EVENT_CONFLICT'
    | 'INVALID_TRANSITION'
    | 'REVIEW_NOT_DUE'
    | 'STORAGE_UNAVAILABLE';
  message: string;
  status: 400 | 404 | 409 | 503;
}
