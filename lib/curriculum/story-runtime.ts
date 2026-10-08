/** Strict ordinary story adapter. Historical preview wrappers remain untouched. */
import type {
  DomainErrorShape,
  IntroPlan,
  LearningEvent,
  PreviewAction,
  PreviewRecap,
  PreviewResult,
  PreviewState,
  RecapGroup,
} from '../preview/types.ts';

import { FOREST_STORY_LESSON as FOREST_LESSON } from '../preview/content.ts';
import type { CompiledStory } from './story-package.ts';
import { canonicalPackage } from './digest.ts';
import type { StoryAck } from './story-types.ts';
export interface StoryRun {
  schemaVersion: 'r3-story-run-1';
  runId: string;
  lessonId: 'forest-01';
  lessonVersion: 'forest-01-v4';
  contentDigest: string;
  adapterId: 'forest-story';
  adapterVersion: 'forest-story-v1';
  seed: number;
  revision: number;
  state: Omit<PreviewState, 'soundReview'>;
  createdAt: string;
  updatedAt: string;
}
type PreviewRun = StoryRun;
export interface PlaybackPolicy {
  soundReview: 'pending' | 'reviewed' | 'synthetic';
}
const isLessonVersion = (value: unknown) => value === 'forest-01-v4';
function question(id: string, _version?: string) {
  return FOREST_LESSON.questions.find((q) => q.id === id);
}
function rotatedChoices(id: string, seed: number, _version?: string) {
  const q = question(id);
  if (!q) return [];
  const shift = ((seed >>> 0) + q.ordinal) % q.choices.length;
  const ids = q.choices.map((c) => c.id);
  return ids.slice(shift).concat(ids.slice(0, shift));
}
const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_IDS = new Set(FOREST_LESSON.steps);
const ACTION_TYPES = new Set([
  'answer',
  'hint',
  'place-component',
  'continue',
  'audio-unavailable',
  'start-review',
]);
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;

export class PreviewDomainError extends Error implements DomainErrorShape {
  readonly code: DomainErrorShape['code'];
  readonly status: DomainErrorShape['status'];

  constructor(
    code: DomainErrorShape['code'],
    message: string,
    status: DomainErrorShape['status'],
  ) {
    super(message);
    this.name = 'PreviewDomainError';
    this.code = code;
    this.status = status;
  }
}

export function error(
  code: DomainErrorShape['code'],
  message: string,
): PreviewDomainError {
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'STORAGE_UNAVAILABLE'
        ? 503
        : code === 'INVALID_REQUEST'
          ? 400
          : 409;
  return new PreviewDomainError(code, message, status);
}

export function dueAt(completedAt: string): string {
  const time = Date.parse(completedAt);
  if (!Number.isFinite(time))
    throw error('INVALID_REQUEST', 'completedAt must be an ISO date');
  return new Date(time + DAY_MS).toISOString();
}

export function isReviewDue(completedAt: string | null, now: string): boolean {
  return !!completedAt && Date.parse(now) >= Date.parse(dueAt(completedAt));
}

export function createInitialRun(
  lesson: CompiledStory,
  input: { runId: string; seed: number; now: string },
): StoryRun {
  if (
    !EVENT_ID_PATTERN.test(input.runId) ||
    !Number.isInteger(input.seed) ||
    input.seed < 0 ||
    input.seed > 0xffffffff ||
    !Number.isFinite(Date.parse(input.now))
  )
    throw error('INVALID_REQUEST', 'invalid run identity');
  return {
    schemaVersion: 'r3-story-run-1',
    runId: input.runId,
    lessonId: 'forest-01',
    ...lesson.identity,
    seed: input.seed,
    revision: 0,
    state: {
      phase: 'initial',
      stepId: 'welcome',
      questionId: null,
      questionStatus: null,
      attempts: 0,
      hintLevel: 0,
      assisted: false,
      placedComponents: { left: null, right: null },
      introPlan: null,
      readPanel: null,
      learnPanel: null,
      completedAt: null,
      reviewCompletedAt: null,
    },
    createdAt: new Date(input.now).toISOString(),
    updatedAt: new Date(input.now).toISOString(),
  };
}

export type ApplySuccess = {
  ok: true;
  run: PreviewRun;
  event: LearningEvent;
  result: PreviewResult;
};
export type ApplyFailure = { ok: false; error: PreviewDomainError };
export type ApplyResult = ApplySuccess | ApplyFailure;

function failure(exception: PreviewDomainError): ApplyFailure {
  return { ok: false, error: exception };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected.slice().sort()[index])
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validStep(value: unknown): value is PreviewState['stepId'] {
  return (
    typeof value === 'string' && STEP_IDS.has(value as PreviewState['stepId'])
  );
}

function validateActionShape(action: PreviewAction): PreviewDomainError | null {
  if (
    !object(action) ||
    !EVENT_ID_PATTERN.test(action.eventId) ||
    !Number.isInteger(action.expectedRevision) ||
    action.expectedRevision < 0 ||
    !validStep(action.stepId) ||
    !ACTION_TYPES.has(action.type) ||
    !object(action.payload)
  ) {
    return error('INVALID_REQUEST', 'action envelope is invalid');
  }
  const payload = action.payload;
  const expected =
    action.type === 'answer'
      ? ['choiceId', 'questionId']
      : action.type === 'hint' || action.type === 'audio-unavailable'
        ? ['questionId']
        : action.type === 'place-component'
          ? ['componentId', 'slot']
          : [];
  if (!exactKeys(payload, expected))
    return error('INVALID_REQUEST', 'action payload contains unknown fields');
  if (
    action.type === 'answer' &&
    (typeof payload.questionId !== 'string' ||
      typeof payload.choiceId !== 'string')
  )
    return error('INVALID_REQUEST', 'answer requires questionId and choiceId');
  if (
    (action.type === 'hint' || action.type === 'audio-unavailable') &&
    typeof payload.questionId !== 'string'
  )
    return error('INVALID_REQUEST', 'questionId is required');
  if (
    action.type === 'place-component' &&
    (typeof payload.componentId !== 'string' ||
      !['left', 'right'].includes(String(payload.slot)))
  )
    return error('INVALID_REQUEST', 'component placement is invalid');
  return null;
}

function resetQuestion(state: PreviewState, questionId: string): void {
  state.questionId = questionId;
  state.questionStatus = 'open';
  state.attempts = 0;
  state.hintLevel = 0;
  state.assisted = false;
}

function terminal(status: PreviewState['questionStatus']): boolean {
  return (
    status === 'answered' ||
    status === 'demonstrated' ||
    status === 'unavailable'
  );
}

function introPlan(
  events: LearningEvent[],
  unavailablePrecedence = false,
): IntroPlan {
  const first = new Map<string, LearningEvent>();
  for (const event of events) {
    if (event.type !== 'answer' && event.type !== 'audio-unavailable') continue;
    if (
      !event.questionId ||
      !event.questionId.startsWith('fam-') ||
      first.has(event.questionId)
    )
      continue;
    first.set(event.questionId, event);
  }
  const familiar: Array<'mu' | 'lin'> = [];
  const needsTeaching: Array<'mu' | 'lin'> = [];
  for (const id of ['fam-mu', 'fam-lin'] as const) {
    const event = first.get(id);
    const character = id === 'fam-mu' ? 'mu' : 'lin';
    if (
      (!unavailablePrecedence ||
        !events.some(
          (item) => item.questionId === id && item.outcome === 'unavailable',
        )) &&
      event?.outcome === 'correct' &&
      event.result.firstResponse &&
      !event.result.assisted
    )
      familiar.push(character);
    else needsTeaching.push(character);
  }
  return familiar.length === 2
    ? { mode: 'reminder', full: [], reminder: ['mu', 'lin'] }
    : needsTeaching.length === 2
      ? { mode: 'full', full: ['mu', 'lin'], reminder: [] }
      : { mode: 'mixed', full: needsTeaching, reminder: familiar };
}

function makeEvent(
  run: PreviewRun,
  action: PreviewAction,
  result: PreviewResult,
  now: string,
  sequence: number,
): LearningEvent {
  return {
    eventId: action.eventId,
    runId: run.runId,
    sequence,
    phase: run.state.phase,
    stepId: run.state.stepId,
    questionId: run.state.questionId,
    type: action.type,
    payload: structuredClone(action.payload),
    serverTime: new Date(now).toISOString(),
    firstResponse: result.firstResponse,
    assisted: result.assisted,
    outcome: result.outcome,
    result,
  };
}

function cloneRun(run: PreviewRun): PreviewRun {
  return structuredClone(run);
}

function commit(
  run: PreviewRun,
  events: LearningEvent[],
  action: PreviewAction,
  result: PreviewResult,
  now: string,
): ApplySuccess {
  const next = cloneRun(run);
  next.revision += 1;
  next.updatedAt = new Date(now).toISOString();
  const event = makeEvent(next, action, result, now, events.length + 1);
  return { ok: true, run: next, event, result };
}

function currentQuestionOrError(
  run: PreviewRun,
  questionId: string,
): ReturnType<typeof question> {
  if (run.state.questionId !== questionId)
    throw error('INVALID_TRANSITION', 'action is for a different question');
  const item = question(questionId, run.lessonVersion);
  if (
    !item ||
    item.stepId !== run.state.stepId ||
    (run.state.phase === 'delayed' && !questionId.startsWith('review-'))
  )
    throw error('INVALID_REQUEST', 'unknown question');
  return item;
}

export function applyAction(
  run: PreviewRun,
  events: LearningEvent[],
  action: PreviewAction,
  now: string,
  policy: PlaybackPolicy = { soundReview: 'pending' },
): ApplyResult {
  try {
    if (!isLessonVersion(run.lessonVersion))
      return failure(error('INVALID_REQUEST', 'lesson version is unsupported'));
    const story = run.lessonVersion === 'forest-01-v4';
    const shapeError = validateActionShape(action);
    if (shapeError) return failure(shapeError);
    if (action.expectedRevision !== run.revision)
      return failure(error('STALE_REVISION', 'the run revision is stale'));
    if (action.stepId !== run.state.stepId)
      return failure(error('INVALID_TRANSITION', 'action is out of step'));
    if (
      !Number.isFinite(Date.parse(now)) ||
      Date.parse(now) < Date.parse(run.updatedAt)
    )
      return failure(error('INVALID_REQUEST', 'server time is invalid'));
    const next = cloneRun(run);
    const payload = action.payload;
    let result: PreviewResult = {
      outcome: 'recorded',
      firstResponse: false,
      assisted: false,
    };

    if (action.type === 'continue') {
      if (!exactKeys(payload, []))
        return failure(
          error('INVALID_REQUEST', 'continue payload must be empty'),
        );
      const state = next.state;
      if (state.stepId === 'welcome') {
        state.stepId = 'familiarity';
        resetQuestion(state, 'fam-mu');
      } else if (state.stepId === 'familiarity') {
        if (!state.questionId || !terminal(state.questionStatus))
          return failure(
            error(
              'INVALID_TRANSITION',
              'answer the current familiarity question first',
            ),
          );
        if (state.questionId === 'fam-mu') resetQuestion(state, 'fam-lin');
        else {
          state.stepId = 'learn';
          state.questionId = null;
          state.questionStatus = null;
          state.attempts = 0;
          state.hintLevel = 0;
          state.assisted = false;
          state.introPlan = introPlan(events, story);
          if (story)
            state.learnPanel =
              state.introPlan.mode === 'reminder' ? 'reminder' : 'learn-mu';
        }
      } else if (state.stepId === 'learn') {
        if (story && state.learnPanel === 'learn-mu') {
          state.learnPanel = 'learn-lin';
          const committed = commit(run, events, action, result, now);
          committed.run.state = state;
          return committed;
        }
        if (
          story &&
          state.learnPanel !== 'learn-lin' &&
          state.learnPanel !== 'reminder'
        )
          return failure(
            error('INVALID_TRANSITION', 'saved learn panel is invalid'),
          );
        if (story) state.learnPanel = null;
        state.stepId = 'build';
        state.questionId = null;
        state.questionStatus = null;
        state.placedComponents = { left: null, right: null };
      } else if (state.stepId === 'build') {
        if (
          state.placedComponents.left === null ||
          state.placedComponents.right === null
        )
          return failure(
            error(
              'INVALID_TRANSITION',
              'both 木 components must be placed first',
            ),
          );
        state.stepId = 'find';
        resetQuestion(state, 'find-mu');
      } else if (state.stepId === 'find') {
        if (!state.questionId || !terminal(state.questionStatus))
          return failure(
            error('INVALID_TRANSITION', 'complete the scene search first'),
          );
        if (state.questionId === 'find-mu') resetQuestion(state, 'find-lin');
        else {
          state.stepId = 'read';
          state.questionId = null;
          state.questionStatus = null;
          state.attempts = 0;
          state.hintLevel = 0;
          state.assisted = false;
          state.readPanel = 'read-wood';
        }
      } else if (state.stepId === 'read') {
        if (state.readPanel === 'read-wood') state.readPanel = 'read-grove';
        else {
          state.stepId = 'check';
          state.readPanel = null;
          resetQuestion(state, 'check-mu-sound');
        }
      } else if (state.stepId === 'check') {
        if (!state.questionId || !terminal(state.questionStatus))
          return failure(
            error('INVALID_TRANSITION', 'complete the current check first'),
          );
        const nextQuestion: Record<string, string | null> = {
          'check-mu-sound': 'check-lin-sound',
          'check-lin-sound': 'check-mu-reading',
          'check-mu-reading': 'check-lin-reading',
          'check-lin-reading': null,
        };
        const id = nextQuestion[state.questionId];
        if (id) resetQuestion(state, id);
        else {
          state.stepId = 'recap';
          state.questionId = null;
          state.questionStatus = null;
          state.attempts = 0;
          state.hintLevel = 0;
          state.assisted = false;
          state.completedAt ??= new Date(now).toISOString();
        }
      } else if (state.stepId === 'delayed-review') {
        if (!state.questionId || !terminal(state.questionStatus))
          return failure(
            error(
              'INVALID_TRANSITION',
              'complete the current review question first',
            ),
          );
        if (state.questionId === 'review-mu-sound')
          resetQuestion(state, 'review-lin-sound');
        else {
          state.stepId = 'recap';
          state.questionId = null;
          state.questionStatus = null;
          state.attempts = 0;
          state.hintLevel = 0;
          state.assisted = false;
          state.reviewCompletedAt ??= new Date(now).toISOString();
        }
      } else {
        return failure(
          error('INVALID_TRANSITION', 'this screen cannot continue'),
        );
      }
      next.revision = run.revision;
      const committed = commit(run, events, action, result, now);
      committed.run.state = next.state;
      return committed;
    }

    if (action.type === 'start-review') {
      if (!exactKeys(payload, []))
        return failure(
          error('INVALID_REQUEST', 'start-review payload must be empty'),
        );
      if (next.state.phase === 'delayed' || next.state.reviewCompletedAt) {
        if (story)
          return failure(
            error('INVALID_TRANSITION', 'later review has already started'),
          );
        const committed = commit(run, events, action, result, now);
        committed.run.state = next.state;
        return committed;
      }
      if (
        next.state.phase !== 'initial' ||
        next.state.stepId !== 'recap' ||
        !next.state.completedAt
      )
        return failure(
          error('INVALID_TRANSITION', 'the initial lesson is not complete'),
        );
      if (!isReviewDue(next.state.completedAt, now))
        return failure(
          error('REVIEW_NOT_DUE', 'the delayed review is not due yet'),
        );
      next.state.phase = 'delayed';
      next.state.stepId = 'delayed-review';
      resetQuestion(next.state, 'review-mu-sound');
      const committed = commit(run, events, action, result, now);
      committed.run.state = next.state;
      return committed;
    }

    if (action.type === 'place-component') {
      if (next.state.stepId !== 'build')
        return failure(
          error(
            'INVALID_TRANSITION',
            'component placement is only available in build',
          ),
        );
      const componentId = payload.componentId;
      const slot = payload.slot;
      if (componentId !== 'mu-a' && componentId !== 'mu-b')
        return failure(error('INVALID_REQUEST', 'unknown component'));
      if (slot !== 'left' && slot !== 'right')
        return failure(error('INVALID_REQUEST', 'unknown component slot'));
      if (
        next.state.placedComponents.left === componentId ||
        next.state.placedComponents.right === componentId
      )
        return failure(
          error('INVALID_TRANSITION', 'component has already been placed'),
        );
      if (next.state.placedComponents[slot] !== null)
        return failure(error('INVALID_TRANSITION', 'slot is occupied'));
      next.state.placedComponents[slot] = componentId;
      const committed = commit(run, events, action, result, now);
      committed.run.state = next.state;
      return committed;
    }

    const questionId =
      typeof payload.questionId === 'string' ? payload.questionId : null;
    if (!questionId)
      return failure(error('INVALID_REQUEST', 'questionId is required'));
    let item;
    try {
      item = currentQuestionOrError(next, questionId);
    } catch (caught) {
      return failure(
        caught instanceof PreviewDomainError
          ? caught
          : error('INVALID_REQUEST', 'unknown question'),
      );
    }
    if (!item) return failure(error('INVALID_REQUEST', 'unknown question'));

    if (action.type === 'answer') {
      if (next.state.questionStatus !== 'open')
        return failure(
          error('INVALID_TRANSITION', 'question is already finished'),
        );
      if (story && item.soundDependent && policy.soundReview === 'pending')
        return failure(
          error(
            'INVALID_TRANSITION',
            'required Mandarin audio is pending attributed review',
          ),
        );
      const choiceId = payload.choiceId;
      if (
        typeof choiceId !== 'string' ||
        !rotatedChoices(item.id, next.seed, next.lessonVersion).includes(
          choiceId,
        )
      )
        return failure(
          error('INVALID_REQUEST', 'choice is not part of this question'),
        );
      const firstResponse = next.state.attempts === 0;
      const assisted = next.state.assisted;
      next.state.attempts += 1;
      if (choiceId === item.correctChoiceId) {
        next.state.questionStatus = 'answered';
        result = { outcome: 'correct', firstResponse, assisted };
      } else if (next.state.attempts >= 2) {
        next.state.questionStatus = 'demonstrated';
        next.state.hintLevel = Math.max(2, next.state.hintLevel);
        next.state.assisted = true;
        result = { outcome: 'demonstrated', firstResponse, assisted: true };
      } else {
        next.state.hintLevel = Math.max(1, next.state.hintLevel);
        next.state.assisted = true;
        result = {
          outcome: 'incorrect',
          firstResponse,
          assisted: story ? assisted : false,
        };
      }
    } else if (action.type === 'hint') {
      if (next.state.questionStatus !== 'open')
        return failure(
          error(
            'INVALID_TRANSITION',
            'hint is unavailable after the question is finished',
          ),
        );
      if (next.state.hintLevel >= 2)
        return failure(
          error(
            'INVALID_TRANSITION',
            'all reviewed help has already been shown',
          ),
        );
      next.state.hintLevel = story ? 1 : next.state.hintLevel + 1;
      next.state.assisted = true;
      result = { outcome: 'recorded', firstResponse: false, assisted: true };
    } else if (action.type === 'audio-unavailable') {
      if (
        story
          ? !['open', 'answered', 'demonstrated'].includes(
              String(next.state.questionStatus),
            )
          : next.state.questionStatus !== 'open'
      )
        return failure(
          error('INVALID_TRANSITION', 'question is already finished'),
        );
      if (!item.soundDependent)
        return failure(
          error(
            'INVALID_TRANSITION',
            'audio is not required for this activity',
          ),
        );
      const firstResponse = next.state.attempts === 0;
      next.state.questionStatus = 'unavailable';
      result = {
        outcome: 'unavailable',
        firstResponse,
        assisted: next.state.assisted,
      };
    } else {
      return failure(
        error('INVALID_TRANSITION', 'action is not valid for a question'),
      );
    }
    const committed = commit(run, events, action, result, now);
    committed.run.state = next.state;
    return committed;
  } catch (caught) {
    return failure(
      caught instanceof PreviewDomainError
        ? caught
        : error('INVALID_REQUEST', 'action could not be applied'),
    );
  }
}

function emptyGroup(total: number): RecapGroup {
  return {
    total,
    independentCorrect: 0,
    supported: 0,
    unavailable: 0,
    pending: total,
  };
}

function classifyQuestion(
  events: LearningEvent[],
  questionId: string,
): 'independent' | 'supported' | 'unavailable' | 'pending' {
  const relevant = events.filter((event) => event.questionId === questionId);
  if (relevant.some((event) => event.outcome === 'unavailable'))
    return 'unavailable';
  const terminalEvent = [...relevant]
    .reverse()
    .find(
      (event) =>
        event.type === 'answer' &&
        ['correct', 'demonstrated'].includes(event.outcome),
    );
  if (!terminalEvent) return 'pending';
  if (
    terminalEvent.outcome === 'demonstrated' ||
    terminalEvent.assisted ||
    relevant.some((event) => event.type === 'hint')
  )
    return 'supported';
  return 'independent';
}

function fillGroup(events: LearningEvent[], ids: string[]): RecapGroup {
  const group = emptyGroup(ids.length);
  for (const id of ids) {
    const category = classifyQuestion(events, id);
    if (category === 'independent') {
      group.independentCorrect += 1;
      group.pending -= 1;
    }
    if (category === 'supported') {
      group.supported += 1;
      group.pending -= 1;
    }
    if (category === 'unavailable') {
      group.unavailable += 1;
      group.pending -= 1;
    }
  }
  return group;
}

export function deriveRecap(events: LearningEvent[]): PreviewRecap {
  return {
    familiarity: fillGroup(events, ['fam-mu', 'fam-lin']),
    final: fillGroup(events, [
      'check-mu-sound',
      'check-lin-sound',
      'check-mu-reading',
      'check-lin-reading',
    ]),
    delayed: fillGroup(events, ['review-mu-sound', 'review-lin-sound']),
    buildCompleted:
      events.filter((event) => event.type === 'place-component').length >= 2,
    sceneCompleted: ['find-mu', 'find-lin'].every(
      (id) => classifyQuestion(events, id) !== 'pending',
    ),
  };
}

export function reviewAvailableAt(run: PreviewRun): string | null {
  return run.state.completedAt ? dueAt(run.state.completedAt) : null;
}

export function actionAck(
  result: ApplySuccess,
  policy: PlaybackPolicy,
): StoryAck {
  return {
    lessonVersion: 'forest-01-v4',
    eventId: result.event.eventId,
    result: result.result,
    state: {
      ...result.run.state,
      learnPanel: result.run.state.learnPanel ?? null,
      soundReview: policy.soundReview,
    },
    revision: result.run.revision,
  };
}
export interface StoryLedgerEntry {
  action: PreviewAction;
  serverAt: string;
  result: { event: LearningEvent; ack: StoryAck; policy: PlaybackPolicy };
}
export function replayStoryRun(
  lesson: CompiledStory,
  run: StoryRun,
  ledger: StoryLedgerEntry[],
): StoryRun {
  if (
    run.schemaVersion !== 'r3-story-run-1' ||
    run.lessonVersion !== lesson.identity.lessonVersion ||
    run.contentDigest !== lesson.identity.contentDigest ||
    run.adapterId !== lesson.identity.adapterId ||
    run.adapterVersion !== lesson.identity.adapterVersion ||
    ledger.length !== run.revision
  )
    throw error('STORAGE_UNAVAILABLE', 'invalid stored story identity');
  let current = createInitialRun(lesson, {
    runId: run.runId,
    seed: run.seed,
    now: run.createdAt,
  });
  const events: LearningEvent[] = [];
  const ids = new Set<string>();
  for (const entry of ledger) {
    if (
      !entry ||
      !entry.result ||
      !['pending', 'reviewed', 'synthetic'].includes(
        entry.result.policy?.soundReview,
      ) ||
      ids.has(entry.action.eventId)
    )
      throw error('STORAGE_UNAVAILABLE', 'invalid stored story event');
    ids.add(entry.action.eventId);
    const applied = applyAction(
      current,
      events,
      entry.action,
      entry.serverAt,
      entry.result.policy,
    );
    if (
      !applied.ok ||
      canonicalPackage(applied.event) !==
        canonicalPackage(entry.result.event) ||
      canonicalPackage(actionAck(applied, entry.result.policy)) !==
        canonicalPackage(entry.result.ack)
    )
      throw error('STORAGE_UNAVAILABLE', 'invalid story replay');
    current = applied.run;
    events.push(applied.event);
  }
  if (canonicalPackage(current) !== canonicalPackage(run))
    throw error('STORAGE_UNAVAILABLE', 'invalid story projection');
  return current;
}
