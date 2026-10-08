/** V3 browser boundary. No scoring, server content imports or transport fallback. */
export const STORY_VERSION = 'forest-01-v3' as const;
export type StoryActionType =
  | 'answer'
  | 'hint'
  | 'place-component'
  | 'continue'
  | 'audio-unavailable'
  | 'start-review';
export interface StoryState {
  phase: 'initial' | 'delayed';
  stepId: string;
  questionId: string | null;
  questionStatus: 'open' | 'answered' | 'demonstrated' | 'unavailable' | null;
  learnPanel: 'learn-mu' | 'learn-lin' | 'reminder' | null;
  soundReview: 'pending' | 'synthetic';
  attempts: number;
  hintLevel: number;
  assisted: boolean;
  placedComponents: {
    left: 'mu-a' | 'mu-b' | null;
    right: 'mu-a' | 'mu-b' | null;
  };
  introPlan: { mode: string; full: string[]; reminder: string[] } | null;
  readPanel: 'read-wood' | 'read-grove' | null;
  completedAt: string | null;
  reviewCompletedAt: string | null;
}
export interface StoryEvent {
  eventId: string;
  questionId: string | null;
  stepId: string;
  phase: string;
  type: string;
  payload: Record<string, unknown>;
  firstResponse: boolean;
  assisted: boolean;
  outcome: string;
  sequence: number;
  serverTime: string;
}
export interface StoryGroup {
  total: number;
  independentCorrect: number;
  supported: number;
  unavailable: number;
  pending: number;
}
export interface StoryRun {
  runId: string;
  lessonId: 'forest-01';
  lessonVersion: typeof STORY_VERSION;
  seed: number;
  revision: number;
  state: StoryState;
  events: StoryEvent[];
  recap: {
    familiarity?: StoryGroup;
    final?: StoryGroup;
    delayed?: StoryGroup;
    buildCompleted?: boolean;
    sceneCompleted?: boolean;
  };
  reviewAvailableAt: string | null;
  reviewDue: boolean;
  synthetic?: boolean;
}
export interface StoryAction {
  eventId: string;
  expectedRevision: number;
  stepId: string;
  type: StoryActionType;
  payload: Record<string, unknown>;
}
export interface StoryPending extends StoryAction {
  runId: string;
  lessonVersion: typeof STORY_VERSION;
  createdAt: string;
}
export interface StoryAck {
  eventId: string;
  lessonVersion: typeof STORY_VERSION;
  state: StoryState;
  revision: number;
  result: { outcome: string; firstResponse?: boolean; assisted?: boolean };
}
export interface StoryRunListItem {
  runId: string;
  lessonVersion: string;
  stepId: string;
  revision: number;
  completedAt: string | null;
  latestActivity: string;
}
export interface StoryTransport {
  createRun: () => Promise<unknown>;
  getRun: (runId: string) => Promise<unknown>;
  listRuns?: () => Promise<StoryRunListItem[]>;
  sendAction: (runId: string, action: StoryAction) => Promise<StoryAck>;
}
export interface StoryRecovery {
  available: () => boolean;
  lastRun: () => string | null;
  remember: (runId: string) => boolean;
  read: (runId: string) => StoryPending[];
  write: (runId: string, actions: StoryPending[]) => boolean;
}
export type StorySaveStatus =
  | 'idle'
  | 'loading'
  | 'saved'
  | 'saving'
  | 'pending'
  | 'conflict'
  | 'readback-pending'
  | 'error';
export interface StorySnapshot {
  run: StoryRun | null;
  pending: StoryPending[];
  status: StorySaveStatus;
  notice: string;
  storageAvailable: boolean;
  lastOutcome: string | null;
  reportReady: boolean;
  conflictReady: boolean;
}
export class StoryApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StoryApiError';
    this.status = status;
    this.code = code;
  }
}
function safeState(state: StoryState): StoryState {
  return {
    phase: state.phase,
    stepId: state.stepId,
    questionId: state.questionId,
    questionStatus: state.questionStatus,
    learnPanel: state.learnPanel,
    soundReview: state.soundReview,
    attempts: state.attempts,
    hintLevel: state.hintLevel,
    assisted: state.assisted,
    placedComponents: {
      left: state.placedComponents.left,
      right: state.placedComponents.right,
    },
    introPlan: state.introPlan
      ? {
          mode: state.introPlan.mode,
          full: [...state.introPlan.full],
          reminder: [...state.introPlan.reminder],
        }
      : null,
    readPanel: state.readPanel,
    completedAt: state.completedAt,
    reviewCompletedAt: state.reviewCompletedAt,
  };
}
export function normalizeStoryRun(value: unknown): StoryRun {
  const r = value as Partial<StoryRun> | null;
  if (!r || r.lessonId !== 'forest-01' || r.lessonVersion !== STORY_VERSION)
    throw new Error(
      'This story version is not supported. Older runs are preserved.',
    );
  if (
    !r.runId ||
    !Number.isInteger(r.revision) ||
    !Number.isInteger(r.seed) ||
    !r.state ||
    !['pending', 'synthetic'].includes(r.state.soundReview)
  )
    throw new Error('The story service returned an invalid run.');
  // Whitelist public fields rather than carrying unknown server metadata into the UI.
  return {
    runId: r.runId,
    lessonId: 'forest-01',
    lessonVersion: STORY_VERSION,
    seed: r.seed!,
    revision: r.revision!,
    state: safeState(r.state),
    events: Array.isArray(r.events) ? r.events : [],
    recap: r.recap ?? {},
    reviewAvailableAt: r.reviewAvailableAt ?? null,
    reviewDue: r.reviewDue === true,
    synthetic: r.synthetic === true,
  };
}
const prefix = `little-hanzi:preview:forest-01:${STORY_VERSION}`;
export function storyRecoveryKey(runId: string) {
  return `${prefix}:${runId}:outbox`;
}
export function createStoryRecovery(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): StoryRecovery {
  let supported = storage !== null;
  function readValue(key: string) {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      supported = false;
      return null;
    }
  }
  function writeValue(key: string, value: string) {
    try {
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch {
      supported = false;
      return false;
    }
  }
  return {
    available: () => supported,
    lastRun: () => readValue(`${prefix}:last-run`),
    remember: (runId) => writeValue(`${prefix}:last-run`, runId),
    read(runId) {
      try {
        const value: unknown = JSON.parse(
          readValue(storyRecoveryKey(runId)) ?? '[]',
        );
        return Array.isArray(value)
          ? value.filter(
              (a): a is StoryPending =>
                !!a &&
                a.runId === runId &&
                a.lessonVersion === STORY_VERSION &&
                typeof a.eventId === 'string' &&
                Number.isInteger(a.expectedRevision) &&
                a.expectedRevision >= 0 &&
                typeof a.stepId === 'string' &&
                [
                  'answer',
                  'hint',
                  'place-component',
                  'continue',
                  'audio-unavailable',
                  'start-review',
                ].includes(a.type) &&
                a.payload &&
                typeof a.payload === 'object' &&
                !Array.isArray(a.payload),
            )
          : [];
      } catch {
        supported = false;
        return [];
      }
    },
    write: (runId, actions) =>
      writeValue(storyRecoveryKey(runId), JSON.stringify(actions)),
  };
}
export function createPreviewStoryTransport(
  request: typeof fetch = fetch,
): StoryTransport {
  async function call(path: string, body?: unknown): Promise<unknown> {
    const response = await request(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json().catch(() => {
      throw new StoryApiError(
        response.status,
        'INVALID_RESPONSE',
        'The story service returned an unreadable response.',
      );
    });
    if (!response.ok) {
      const error = (value as { error?: { code?: string; message?: string } })
        ?.error;
      throw new StoryApiError(
        response.status,
        error?.code ?? 'UNKNOWN',
        error?.message ?? 'The story could not be saved.',
      );
    }
    return value;
  }
  return {
    createRun: () =>
      call('/api/preview/runs', {
        lessonId: 'forest-01',
        lessonVersion: STORY_VERSION,
      }),
    getRun: (runId) => call(`/api/preview/runs/${encodeURIComponent(runId)}`),
    listRuns: async () => {
      const result = (await call('/api/preview/runs')) as {
        runs?: StoryRunListItem[];
      };
      return (result.runs ?? []).filter(
        (r) => r.lessonVersion === STORY_VERSION,
      );
    },
    sendAction: async (runId, action) =>
      call(`/api/preview/runs/${encodeURIComponent(runId)}/actions`, {
        eventId: action.eventId,
        expectedRevision: action.expectedRevision,
        stepId: action.stepId,
        type: action.type,
        payload: action.payload,
      }) as Promise<StoryAck>,
  };
}
export function createStorySession({
  transport,
  recovery,
  onChange = () => {},
  id = () => crypto.randomUUID(),
}: {
  transport: StoryTransport;
  recovery: StoryRecovery;
  onChange?: (snapshot: StorySnapshot) => void;
  id?: () => string;
}) {
  let run: StoryRun | null = null,
    pending: StoryPending[] = [],
    status: StorySaveStatus = 'idle',
    notice = '',
    lastOutcome: string | null = null,
    reportReady = true,
    conflictReady = false;
  let storageAvailable = recovery.available(),
    running: Promise<void> | null = null,
    dead = false,
    generation = 0;
  const snapshot = (): StorySnapshot => ({
    run,
    pending: [...pending],
    status,
    notice,
    storageAvailable,
    lastOutcome,
    reportReady,
    conflictReady,
  });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  const storageNotice =
    'Browser recovery is unavailable. Reload may lose an unsent action. Keep this page open and retry.';
  function persist() {
    if (run && !recovery.write(run.runId, pending)) {
      storageAvailable = false;
      notice = storageNotice;
    } else storageAvailable = recovery.available();
  }
  async function open(runId: string) {
    if (running)
      throw new Error(
        'Finish or retry the pending save before opening another story.',
      );
    const memoryPending = run?.runId === runId ? [...pending] : [];
    const token = ++generation;
    status = 'loading';
    emit();
    try {
      const next = normalizeStoryRun(await transport.getRun(runId));
      if (dead || token !== generation) return;
      run = next;
      pending = memoryPending.length
        ? memoryPending
        : recovery.read(next.runId);
      reportReady = true;
      conflictReady = false;
      recovery.remember(next.runId);
      storageAvailable = recovery.available();
      status = pending.length ? 'pending' : 'saved';
      notice = pending.length
        ? 'An unsent action is ready to retry with its original identity.'
        : storageAvailable
          ? ''
          : storageNotice;
      lastOutcome = null;
      emit();
    } catch (error) {
      if (dead || token !== generation) return;
      status = 'error';
      notice =
        error instanceof Error
          ? error.message
          : 'The saved story could not be opened.';
      emit();
    }
  }
  async function create() {
    if (running || pending.length)
      throw new Error(
        'Finish or retry the pending save before starting another story.',
      );
    status = 'loading';
    emit();
    try {
      const next = normalizeStoryRun(await transport.createRun());
      run = next;
      recovery.remember(next.runId);
      storageAvailable = recovery.available();
      pending = [];
      reportReady = true;
      conflictReady = false;
      status = 'saved';
      notice = storageAvailable ? '' : storageNotice;
      emit();
    } catch (error) {
      status = 'error';
      notice =
        error instanceof Error
          ? error.message
          : 'The story could not be started.';
      emit();
    }
  }
  function enqueue(type: StoryActionType, payload: Record<string, unknown>) {
    if (!run) return;
    pending.push({
      runId: run.runId,
      lessonVersion: STORY_VERSION,
      eventId: id(),
      expectedRevision: pending.length
        ? pending[pending.length - 1].expectedRevision + 1
        : run.revision,
      stepId: run.state.stepId,
      type,
      payload: structuredClone(payload),
      createdAt: new Date().toISOString(),
    });
    persist();
  }
  async function drain() {
    if (running) return running;
    if (!run || !pending.length || status === 'conflict') return;
    const token = generation;
    status = 'saving';
    notice = storageAvailable ? 'Saving this action…' : storageNotice;
    emit();
    running = (async () => {
      while (run && pending.length && !dead && token === generation) {
        const action = pending[0];
        try {
          const ack = await transport.sendAction(run.runId, action);
          if (dead || token !== generation) return;
          if (
            ack.eventId !== action.eventId ||
            ack.lessonVersion !== STORY_VERSION ||
            !Number.isInteger(ack.revision)
          )
            throw new Error(
              'The story service returned an invalid save acknowledgement.',
            );
          run = {
            ...run,
            ...(ack.revision >= run.revision
              ? { state: safeState(ack.state), revision: ack.revision }
              : {}),
          };
          reportReady = false;
          lastOutcome = ack.result.outcome;
          pending.shift();
          persist();
          emit();
        } catch (error) {
          if (dead || token !== generation) return;
          const code = (error as { code?: string }).code,
            http = (error as { status?: number }).status;
          if (
            http === 409 &&
            ['STALE_REVISION', 'EVENT_CONFLICT', 'INVALID_TRANSITION'].includes(
              code ?? '',
            )
          ) {
            status = 'conflict';
            conflictReady = false;
            notice =
              'This action was not applied. Read the saved step, then choose Continue from saved state. Your unsent input is retained until then.';
            try {
              run = normalizeStoryRun(await transport.getRun(run.runId));
              conflictReady = true;
              reportReady = true;
            } catch {
              notice +=
                ' The latest saved step could not be fetched; refresh before continuing.';
            }
            emit();
            return;
          }
          status = 'pending';
          notice = storageAvailable
            ? 'Not saved yet. Your original action is retained. Check the connection and retry save.'
            : storageNotice;
          emit();
          return;
        }
      }
      if (!dead && token === generation) {
        if (run?.state.stepId === 'recap') {
          await readSavedReport();
          return;
        }
        status = 'saved';
        notice = storageAvailable ? 'Saved.' : storageNotice;
        emit();
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  }
  async function readSavedReport() {
    if (!run || dead) return;
    const runId = run.runId,
      token = generation;
    status = 'loading';
    notice = 'Your action is saved. Loading the saved report…';
    reportReady = false;
    emit();
    try {
      const fresh = normalizeStoryRun(await transport.getRun(runId));
      if (dead || token !== generation) return;
      run = fresh;
      reportReady = true;
      status = 'saved';
      notice = storageAvailable ? 'Saved report loaded.' : storageNotice;
      emit();
    } catch {
      if (dead || token !== generation) return;
      status = 'readback-pending';
      notice =
        'Your action is saved. The latest report could not be loaded. Retry the saved report; your answer will not be submitted again.';
      emit();
    }
  }
  async function refreshConflict() {
    if (!run || dead) return;
    const runId = run.runId,
      token = generation;
    conflictReady = false;
    emit();
    try {
      const fresh = normalizeStoryRun(await transport.getRun(runId));
      if (dead || token !== generation) return;
      run = fresh;
      reportReady = true;
      conflictReady = true;
      notice =
        'The latest saved step is ready. Choose Continue from saved state; the unsent action will not be resubmitted.';
      emit();
    } catch {
      if (dead || token !== generation) return;
      notice =
        'The latest saved step could not be loaded. Refresh before continuing; your unsent input is retained.';
      emit();
    }
  }
  async function submit(
    type: StoryActionType,
    payload: Record<string, unknown> = {},
  ) {
    if (!run || pending.length || status !== 'saved' || dead) return false;
    enqueue(type, payload);
    await drain();
    return status === 'saved';
  }
  function failRequiredAudio(questionId: string) {
    if (
      !run ||
      dead ||
      run.state.questionId !== questionId ||
      run.state.questionStatus === 'unavailable' ||
      pending.some(
        (a) =>
          a.type === 'audio-unavailable' && a.payload.questionId === questionId,
      )
    )
      return;
    const answered =
      run.state.attempts > 0 ||
      run.state.questionStatus === 'answered' ||
      run.state.questionStatus === 'demonstrated' ||
      pending.some(
        (a) => a.type === 'answer' && a.payload.questionId === questionId,
      );
    if (!answered) return;
    enqueue('audio-unavailable', { questionId });
    status = 'saving';
    notice =
      'Sound stopped. Saving this question as unavailable before continuing.';
    emit();
    void drain();
  }
  return {
    snapshot,
    open,
    create,
    submit,
    failRequiredAudio,
    retry: () => (status === 'readback-pending' ? readSavedReport() : drain()),
    async refresh() {
      if (!run) return;
      if (status === 'conflict') {
        await refreshConflict();
        return;
      }
      if (status === 'readback-pending') {
        await readSavedReport();
        return;
      }
      await open(run.runId);
    },
    acceptConflict() {
      if (status !== 'conflict' || !run || !conflictReady) return;
      pending = [];
      persist();
      status = 'saved';
      notice =
        'Continue from the saved step. The unsent action was not resubmitted.';
      lastOutcome = null;
      emit();
    },
    canContinue: () =>
      !!run &&
      status === 'saved' &&
      !pending.length &&
      (!run.state.questionId || run.state.questionStatus !== 'open'),
    destroy() {
      dead = true;
      generation++;
    },
  };
}
