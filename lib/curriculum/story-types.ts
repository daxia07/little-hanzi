/** Browser-safe ordinary story wire types. No grading keys or private release references. */
export const STORY_VERSION = 'forest-01-v4' as const;
export type StoryStep =
  | 'welcome'
  | 'familiarity'
  | 'learn'
  | 'build'
  | 'find'
  | 'read'
  | 'check'
  | 'recap'
  | 'delayed-review';
export interface StoryState {
  phase: 'initial' | 'delayed';
  stepId: StoryStep;
  questionId: string | null;
  questionStatus: 'open' | 'answered' | 'demonstrated' | 'unavailable' | null;
  attempts: number;
  hintLevel: number;
  assisted: boolean;
  placedComponents: {
    left: 'mu-a' | 'mu-b' | null;
    right: 'mu-a' | 'mu-b' | null;
  };
  introPlan: {
    mode: 'full' | 'reminder' | 'mixed';
    full: Array<'mu' | 'lin'>;
    reminder: Array<'mu' | 'lin'>;
  } | null;
  learnPanel: 'learn-mu' | 'learn-lin' | 'reminder' | null;
  readPanel: 'read-wood' | 'read-grove' | null;
  completedAt: string | null;
  reviewCompletedAt: string | null;
  soundReview: 'pending' | 'reviewed' | 'synthetic';
}
export interface StoryAction {
  eventId: string;
  expectedRevision: number;
  stepId: StoryStep;
  type:
    | 'continue'
    | 'answer'
    | 'hint'
    | 'place-component'
    | 'audio-unavailable'
    | 'start-review';
  payload: Record<string, unknown>;
}
export interface StoryResult {
  outcome: string;
  firstResponse: boolean;
  assisted: boolean;
}
export interface StoryAck {
  eventId: string;
  lessonVersion: typeof STORY_VERSION;
  state: StoryState;
  revision: number;
  result: StoryResult;
}
export interface StoryEvent {
  eventId: string;
  sequence: number;
  phase: 'initial' | 'delayed';
  stepId: StoryStep;
  questionId: string | null;
  type: StoryAction['type'];
  serverTime: string;
  firstResponse: boolean;
  assisted: boolean;
  outcome: string;
}
export interface StoryGroup {
  total: number;
  independent: number;
  supported: number;
  unavailable: number;
  pending: number;
}
export interface StoryRecap {
  familiarity: StoryGroup;
  immediate: StoryGroup;
  delayed: StoryGroup;
  game: { total: number; completed: number };
  evidenceLimits: string[];
}
export interface PlaybackCue {
  id: string;
  transcript: string;
  source: string;
  license: string;
  assetUrl: string | null;
  assetDigest: string | null;
}
export interface PlaybackProfile {
  schemaVersion: 'r3-playback-1';
  kind: 'local-device' | 'recorded';
  voices: Array<{ name: string; lang: string; localService: true }>;
  fallback: 'unavailable';
  cues: PlaybackCue[];
}
export interface SafeQuestion {
  id: string;
  ordinal: number;
  stepId: StoryStep;
  characterId: 'mu' | 'lin';
  prompt: string;
  cueText: string;
  kind: 'sound-to-print' | 'print-to-audio' | 'scene';
  soundDependent: boolean;
  choices: Array<{ id: string; label: string; audioText?: string }>;
  hint?: string;
  demonstration?: string;
}
export interface StoryLesson {
  lessonId: 'forest-01';
  lessonVersion: typeof STORY_VERSION;
  title: string;
  steps: StoryStep[];
  characters: Array<{
    id: string;
    hanzi: string;
    pinyin: string;
    raw: string;
    meaning: string;
    word: string;
  }>;
  examples: Array<{ text: string; meaning: string; audioText: string }>;
  captions: Array<{
    id: string;
    text: string;
    highlight: string;
    narration: string;
  }>;
  componentLayout: {
    glyph: string;
    left: string;
    right: string;
    proportions: string;
  };
  questions: SafeQuestion[];
  playback: PlaybackProfile;
}
export interface StoryView {
  schemaVersion: 'r3-story-view-1';
  runId: string;
  assignmentId: string;
  lessonVersion: typeof STORY_VERSION;
  contentDigest: string;
  adapterId: 'forest-story';
  adapterVersion: 'forest-story-v1';
  publicationId: string;
  installationId: string;
  childId: string;
  revision: number;
  state: StoryState;
  question: SafeQuestion | null;
  lesson: StoryLesson;
  events: StoryEvent[];
  recap: StoryRecap;
  available: boolean;
  reason: string | null;
  serverAt: string;
  createdAt: string;
  updatedAt: string;
  reviewAvailableAt: string | null;
  reviewDue: boolean;
}
export interface LibraryItem {
  lessonVersion: typeof STORY_VERSION;
  title: string;
  contentDigest: string;
  publicationId: string;
  generation: number;
  available: boolean;
  reason: string | null;
  assignmentId: string | null;
}
export interface PlacementProposal {
  proposalId: string;
  childId: string;
  installationId: string;
  lessonVersion: typeof STORY_VERSION;
  contentDigest: string;
  publicationId: string;
  sourceDigest: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
}
export interface PlanItem extends LibraryItem {
  planItemId: string;
  ordinal: 0;
}
export interface StoryPlan {
  planId: string;
  proposalId: string;
  childId: string;
  installationId: string;
  approvedAt: string;
  available: boolean;
  reason: string | null;
  items: PlanItem[];
}
export interface PracticeItem {
  assignmentId: string;
  runId: string | null;
  lessonVersion: typeof STORY_VERSION;
  publicationId: string;
  kind: 'initial' | 'delayed-review';
  dueAt: string;
  available: boolean;
  reason: string | null;
  stepId: StoryStep | null;
}
export interface CurriculumProgress {
  schemaVersion: 'r3-family-progress-1';
  installationId: string;
  childId: string;
  plans: StoryPlan[];
  practice: PracticeItem[];
  runs: StoryView[];
  evidenceLimits: string[];
}
// Library: {items:LibraryItem[]}; placement GET: {setupComplete:boolean,proposal:PlacementProposal|null,reason:string|null};
// Proposal POST: {proposal:PlacementProposal}; approval POST: {plan:StoryPlan}; plan GET: {plan:StoryPlan|null,history:StoryPlan[]};
// Practice GET: {items:PracticeItem[]}; start POST: {runId,assignmentId,lessonVersion,revision}; action POST: {ack:StoryAck,replayed:boolean};
// Existing S2 progress/export retain all old fields and add curriculum:CurriculumProgress.
