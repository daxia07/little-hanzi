/*
 * Browser client for the additive forest preview API.
 *
 * This module deliberately contains no correctness key. The server owns the
 * lesson manifest and scores the choiceId in an action envelope. The browser
 * only knows the reviewed labels it needs to make the activity usable.
 */

import { selectMandarinVoice } from '@/lib/preview/audio';

export const FOREST_LESSON_ID = 'forest-01' as const;
export const FOREST_LESSON_VERSION = 'forest-01-v1' as const;

export type ForestPhase = 'initial' | 'delayed';
export type ForestQuestionStatus = 'open' | 'answered' | 'demonstrated' | 'unavailable' | null;
export type ForestActionType =
  | 'answer'
  | 'hint'
  | 'place-component'
  | 'continue'
  | 'audio-unavailable'
  | 'start-review';

export interface ForestState {
  phase: ForestPhase;
  stepId: string;
  questionId: string | null;
  questionStatus: ForestQuestionStatus;
  placedComponents: unknown;
  completedAt: string | null;
  reviewCompletedAt: string | null;
  [key: string]: unknown;
}

export interface ForestEvent {
  eventId: string;
  runId?: string;
  phase?: ForestPhase;
  stepId?: string;
  questionId?: string | null;
  type?: string;
  action?: string;
  payload?: Record<string, unknown>;
  answer?: string;
  firstResponse?: boolean;
  assisted?: boolean;
  result?: string | { outcome?: unknown; [key: string]: unknown };
  outcome?: string;
  sequence?: number;
  serverTime?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface ForestRecapGroup {
  total: number;
  independentCorrect: number;
  supported: number;
  unavailable: number;
  pending: number;
  [key: string]: unknown;
}

export interface ForestRecap {
  familiarity?: ForestRecapGroup;
  final?: ForestRecapGroup;
  delayed?: ForestRecapGroup;
  buildCompleted?: boolean;
  sceneCompleted?: boolean;
  [key: string]: unknown;
}

export interface ForestFeedback {
  feedbackId: string;
  runId?: string;
  lessonVersion?: string;
  stepId: string | null;
  category: 'clarity' | 'pacing' | 'difficulty' | 'mascot' | 'reporting' | 'other';
  text: string;
  source: 'reviewer' | 'child';
  createdAt?: string;
  [key: string]: unknown;
}

export interface ForestRun {
  runId: string;
  lessonId: string;
  lessonVersion: string;
  seed: number;
  state: ForestState;
  revision: number;
  events: ForestEvent[];
  recap: ForestRecap;
  feedback: ForestFeedback[];
  reviewAvailableAt: string | null;
  reviewDue?: boolean;
  syntheticScenarioId?: string | null;
  [key: string]: unknown;
}

export interface ForestActionResult {
  outcome: string;
  firstResponse?: boolean;
  assisted?: boolean;
  [key: string]: unknown;
}

export interface ForestActionResponse {
  eventId: string;
  result: ForestActionResult;
  state: ForestState;
  revision: number;
  [key: string]: unknown;
}

export interface ForestDecision {
  lessonVersion: string;
  candidateId: string;
  status: 'draft' | 'changes-requested' | 'approved';
  history: Array<{
    status: string;
    reviewerLabel?: string;
    notes?: string;
    candidateId?: string;
    createdAt?: string;
    synthetic?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface ForestApiErrorShape {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export class ForestApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, body: unknown, fallback = 'The forest preview could not be saved.') {
    const record = body && typeof body === 'object' ? (body as { error?: ForestApiErrorShape }) : {};
    const error = record.error;
    super(typeof error?.message === 'string' ? error.message : fallback);
    this.name = 'ForestApiError';
    this.status = status;
    this.code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    this.body = body;
  }
}

function getBrowserCryptoId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `forest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newForestId() {
  return getBrowserCryptoId();
}

function parseJson(response: Response) {
  return response
    .json()
    .catch(() => ({ error: { code: 'INVALID_RESPONSE', message: 'The preview returned an unreadable response.' } }));
}

async function forestRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const body = await parseJson(response);
  if (!response.ok) throw new ForestApiError(response.status, body);
  return body as T;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function normalizeState(input: unknown): ForestState {
  const state = input && typeof input === 'object' ? (input as Partial<ForestState>) : {};
  return {
    phase: state.phase === 'delayed' ? 'delayed' : 'initial',
    stepId: typeof state.stepId === 'string' ? state.stepId : 'welcome',
    questionId: typeof state.questionId === 'string' ? state.questionId : null,
    questionStatus:
      state.questionStatus === 'open' ||
      state.questionStatus === 'answered' ||
      state.questionStatus === 'demonstrated' ||
      state.questionStatus === 'unavailable'
        ? state.questionStatus
        : null,
    placedComponents: state.placedComponents ?? [],
    completedAt: typeof state.completedAt === 'string' ? state.completedAt : null,
    reviewCompletedAt: typeof state.reviewCompletedAt === 'string' ? state.reviewCompletedAt : null,
    ...state,
  };
}

export function normalizeForestRun(input: unknown): ForestRun {
  const run = input && typeof input === 'object' ? (input as Partial<ForestRun> & { completedAt?: string | null; phase?: ForestPhase; stepId?: string }) : {};
  const rawState = run.state && typeof run.state === 'object' ? run.state : {
    phase: run.phase,
    stepId: run.stepId,
    completedAt: run.completedAt,
  };
  return {
    ...run,
    runId: typeof run.runId === 'string' ? run.runId : '',
    lessonId: typeof run.lessonId === 'string' ? run.lessonId : FOREST_LESSON_ID,
    lessonVersion: typeof run.lessonVersion === 'string' ? run.lessonVersion : FOREST_LESSON_VERSION,
    seed: typeof run.seed === 'number' ? run.seed >>> 0 : 0,
    state: normalizeState(rawState),
    revision: typeof run.revision === 'number' ? run.revision : 0,
    events: Array.isArray(run.events) ? (run.events as ForestEvent[]) : [],
    recap: run.recap && typeof run.recap === 'object' ? (run.recap as ForestRecap) : {},
    feedback: Array.isArray(run.feedback) ? (run.feedback as ForestFeedback[]) : [],
    reviewAvailableAt: typeof run.reviewAvailableAt === 'string' ? run.reviewAvailableAt : null,
    reviewDue: typeof run.reviewDue === 'boolean' ? run.reviewDue : undefined,
  };
}

export async function createForestRun() {
  const response = await forestRequest<ForestRun>('/api/preview/runs', json({ lessonId: FOREST_LESSON_ID, lessonVersion: FOREST_LESSON_VERSION }));
  return normalizeForestRun(response);
}

export async function listForestRuns() {
  const response = await forestRequest<{ runs?: unknown[] }>('/api/preview/runs');
  return (Array.isArray(response.runs) ? response.runs : []).map(normalizeForestRun);
}

export async function getForestRun(runId: string) {
  const response = await forestRequest<ForestRun>(`/api/preview/runs/${encodeURIComponent(runId)}`);
  return normalizeForestRun(response);
}

export async function sendForestAction(
  runId: string,
  expectedRevision: number,
  stepId: string,
  type: ForestActionType,
  payload: Record<string, unknown> = {},
  eventId = newForestId(),
) {
  const response = await forestRequest<ForestActionResponse>(
    `/api/preview/runs/${encodeURIComponent(runId)}/actions`,
    json({ eventId, expectedRevision, stepId, type, payload }),
  );
  return {
    ...response,
    state: normalizeState(response.state),
  };
}

export async function sendForestFeedback(
  runId: string,
  value: Omit<ForestFeedback, 'runId' | 'lessonVersion' | 'createdAt'> & { source?: 'reviewer' | 'child' },
) {
  return forestRequest<ForestFeedback>(
    `/api/preview/runs/${encodeURIComponent(runId)}/feedback`,
    json({
      feedbackId: value.feedbackId || newForestId(),
      stepId: value.stepId ?? null,
      category: value.category,
      text: value.text,
      source: value.source || 'reviewer',
    }),
  );
}

export async function getForestDecision(version = FOREST_LESSON_VERSION) {
  return forestRequest<ForestDecision>(`/api/preview/lessons/${encodeURIComponent(version)}/decision`);
}

export async function sendForestDecision(
  version: string,
  value: { status: 'changes-requested' | 'approved'; reviewerLabel: string; notes: string; candidateId: string },
) {
  return forestRequest<ForestDecision>(`/api/preview/lessons/${encodeURIComponent(version)}/decision`, json(value));
}

export interface ForestPendingAction {
  runId: string;
  lessonVersion: string;
  eventId: string;
  expectedRevision: number;
  stepId: string;
  type: ForestActionType;
  payload: Record<string, unknown>;
  createdAt: string;
}

function recoveryKey(runId: string, version: string = FOREST_LESSON_VERSION) {
  return `little-hanzi:preview:${FOREST_LESSON_ID}:${version}:${runId}:outbox`;
}

export function forestRecoveryAvailable() {
  if (typeof window === 'undefined') return false;
  try {
    const key = `little-hanzi:preview:storage-probe:${newForestId()}`;
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function readForestOutbox(runId: string, version: string = FOREST_LESSON_VERSION): ForestPendingAction[] {
  if (typeof window === 'undefined') return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(recoveryKey(runId, version)) || '[]');
    return Array.isArray(value) ? value.filter((item): item is ForestPendingAction =>
      Boolean(item && typeof item === 'object' && item.runId === runId && item.lessonVersion === version &&
        typeof item.eventId === 'string' && Number.isInteger(item.expectedRevision) && item.expectedRevision >= 0 &&
        typeof item.stepId === 'string' && ['answer', 'hint', 'place-component', 'continue', 'audio-unavailable', 'start-review'].includes(item.type) &&
        item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload))) : [];
  } catch {
    return [];
  }
}

export function writeForestOutbox(runId: string, actions: ForestPendingAction[], version: string = FOREST_LESSON_VERSION) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(recoveryKey(runId, version), JSON.stringify(actions));
    return true;
  } catch {
    return false;
  }
}

export function clearForestOutbox(runId: string, version: string = FOREST_LESSON_VERSION) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(recoveryKey(runId, version));
  } catch {
    // Storage can be unavailable in private browsing. The caller shows the
    // limitation in the UI; there is no safe fallback that pretends recovery.
  }
}

export type ForestSpeechResult = 'started' | 'unavailable' | 'failed';
export type ForestSpeechAdapter = (text: string, options: { onStart: () => void; onEnd: () => void; onError: () => void }) => ForestSpeechResult | Promise<ForestSpeechResult>;

let speechAdapter: ForestSpeechAdapter | null = null;

/** Test-only named boundary; production uses the device speech synthesizer. */
export function setForestSpeechAdapter(adapter: ForestSpeechAdapter | null) {
  speechAdapter = adapter;
}

function defaultSpeech(text: string, options: { onStart: () => void; onEnd: () => void; onError: () => void }): ForestSpeechResult {
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return 'unavailable';
  const voices = window.speechSynthesis.getVoices();
  const mandarin = selectMandarinVoice(voices);
  if (!mandarin) return 'unavailable';
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  if (mandarin) utterance.voice = mandarin;
  utterance.onstart = options.onStart;
  utterance.onend = options.onEnd;
  utterance.onerror = options.onError;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return 'started';
  } catch {
    return 'failed';
  }
}

export async function speakForest(text: string, options: { onStart?: () => void; onEnd?: () => void; onError?: () => void } = {}): Promise<ForestSpeechResult> {
  let started = false;
  const hooks = {
    onStart: () => {
      started = true;
      options.onStart?.();
    },
    onEnd: () => options.onEnd?.(),
    onError: () => options.onError?.(),
  };
  const result = await (speechAdapter ? speechAdapter(text, hooks) : defaultSpeech(text, hooks));
  if (result === 'started' && !started && !speechAdapter) {
    // Some browsers schedule onstart after speak(). Returning started here is
    // intentional: the callback remains the gating signal for answer controls.
    return result;
  }
  return result;
}

export function stopForestSpeech() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Stable client-side display labels; these are not a scoring key. */
export const FOREST_LABELS: Readonly<Record<string, string>> = {
  mu: '木',
  lin: '林',
  ren: '人',
  da: '大',
};

export const FOREST_AUDIO_TEXT: Readonly<Record<string, string>> = {
  welcome: '欢迎来到小小汉字。今天，我们一起造一片小森林。',
  'fam-mu': '木头的木。',
  'fam-lin': '树林的林。',
  'check-mu-sound': '木头的木。',
  'check-lin-sound': '树林的林。',
  'check-mu-reading': '木。',
  'check-lin-reading': '林。',
  'review-mu-sound': '木头的木。',
  'review-lin-sound': '树林的林。',
  wood: '木头。',
  grove: '树林。',
  'read-wood': '这是木头。',
  'read-grove': '小鸟住在树林里。',
};

export const FOREST_HELP: Readonly<Record<string, { hint: string; demonstration: string }>> = {
  'fam-mu': { hint: 'Listen for 木头 and look for the tree character.', demonstration: '木 means wood or tree.' },
  'fam-lin': { hint: 'Listen for 树林 and look for the two-tree character.', demonstration: '林 shows two 木 trees together.' },
  'find-mu': { hint: 'Look for the single 木 tree.', demonstration: 'This ordinary character is 木.' },
  'find-lin': { hint: 'Look for the character made from two 木 trees.', demonstration: 'These two 木 components make 林.' },
  'check-mu-sound': { hint: 'Listen for 木头 and look for the tree character.', demonstration: '木 means wood or tree.' },
  'check-lin-sound': { hint: 'Listen for 树林 and look for the two-tree character.', demonstration: '林 shows two 木 trees together.' },
  'check-mu-reading': { hint: 'Listen again for the reading used with 木头.', demonstration: 'Listen to the reading for 木, then choose the matching sound.' },
  'check-lin-reading': { hint: 'Listen again for the reading used with 树林.', demonstration: 'Listen to the reading for 林, then choose the matching sound.' },
  'review-mu-sound': { hint: 'Listen for 木头 and look for the tree character.', demonstration: '木 means wood or tree.' },
  'review-lin-sound': { hint: 'Listen for 树林 and look for the two-tree character.', demonstration: '林 shows two 木 trees together.' },
};

export const FOREST_CHOICE_IDS: Readonly<Record<string, readonly string[]>> = {
  'fam-mu': ['mu', 'lin', 'ren'],
  'fam-lin': ['lin', 'mu', 'da'],
  'find-mu': ['mu', 'lin', 'ren', 'da'],
  'find-lin': ['mu', 'lin', 'ren', 'da'],
  'check-mu-sound': ['mu', 'lin', 'ren'],
  'check-lin-sound': ['lin', 'mu', 'da'],
  'check-mu-reading': ['audio-mu', 'audio-lin', 'audio-ren'],
  'check-lin-reading': ['audio-lin', 'audio-mu', 'audio-da'],
  'review-mu-sound': ['mu', 'lin', 'ren'],
  'review-lin-sound': ['lin', 'mu', 'da'],
};

export function forestChoiceLabel(choiceId: string) {
  if (choiceId.startsWith('audio-')) return `Listen to option ${choiceId === 'audio-mu' ? '1' : choiceId === 'audio-lin' ? '2' : '3'}`;
  return FOREST_LABELS[choiceId] || choiceId;
}

export function rotateForestChoices(questionId: string, seed: number) {
  const base = FOREST_CHOICE_IDS[questionId] || [];
  if (!base.length) return [];
  const ordinal = ['fam-mu', 'fam-lin', 'find-mu', 'find-lin', 'check-mu-sound', 'check-lin-sound', 'check-mu-reading', 'check-lin-reading', 'review-mu-sound', 'review-lin-sound'].indexOf(questionId);
  const amount = ((seed >>> 0) + Math.max(0, ordinal)) % base.length;
  return [...base.slice(amount), ...base.slice(0, amount)];
}
