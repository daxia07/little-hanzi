/** V4 ordinary family boundary. No scoring, server content imports or transport fallback. */
export const STORY_VERSION = 'forest-01-v4' as const;
export type StoryActionType =
  | 'answer'
  | 'hint'
  | 'place-component'
  | 'continue'
  | 'audio-unavailable'
  | 'start-review';
import type {
  StoryState,
  StoryView,
  StoryEvent,
  StoryGroup,
  StoryAction,
  StoryAck,
} from './curriculum/story-types.ts';
export type { StoryState, StoryEvent, StoryGroup, StoryAction, StoryAck };
export type StoryRun = StoryView;
export interface PilotStoryScope {
  installationId: string;
  accountId: string;
  childId: string;
  publicationId: string;
  contentDigest: string;
  assignmentId: string;
}
export interface StoryPending extends StoryAction {
  runId: string;
  lessonVersion: typeof STORY_VERSION;
  createdAt: string;
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
  | 'error'
  | 'locked'
  | 'unavailable';
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
export function normalizeStoryRun(
  value: unknown,
  scope: PilotStoryScope,
): StoryRun {
  const r = value as Partial<StoryRun> | null;
  if (
    !r ||
    r.schemaVersion !== 'r3-story-view-1' ||
    r.lessonVersion !== STORY_VERSION ||
    r.adapterId !== 'forest-story' ||
    r.adapterVersion !== 'forest-story-v1' ||
    r.installationId !== scope.installationId ||
    r.childId !== scope.childId ||
    r.publicationId !== scope.publicationId ||
    r.contentDigest !== scope.contentDigest ||
    r.assignmentId !== scope.assignmentId ||
    typeof r.available !== 'boolean'
  )
    throw new StoryApiError(
      401,
      'IDENTITY_CHANGED',
      'This learning record belongs to another account or plan.',
    );
  if (
    !r.runId ||
    !Number.isInteger(r.revision) ||
    !r.state ||
    !['pending', 'synthetic', 'reviewed'].includes(r.state.soundReview) ||
    !r.lesson ||
    r.lesson.lessonVersion !== STORY_VERSION ||
    !r.lesson.playback
  )
    throw new Error('The story service returned an invalid ordinary run.');
  return {
    schemaVersion: 'r3-story-view-1',
    runId: r.runId,
    assignmentId: r.assignmentId,
    lessonVersion: STORY_VERSION,
    contentDigest: r.contentDigest,
    adapterId: 'forest-story',
    adapterVersion: 'forest-story-v1',
    publicationId: r.publicationId,
    installationId: r.installationId,
    childId: r.childId,
    revision: r.revision!,
    state: safeState(r.state),
    question: r.question ?? null,
    lesson: r.lesson,
    events: r.events ?? [],
    recap: r.recap!,
    available: r.available,
    reason: r.reason ?? null,
    serverAt: r.serverAt ?? '',
    createdAt: r.createdAt ?? '',
    updatedAt: r.updatedAt ?? '',
    reviewAvailableAt: r.reviewAvailableAt ?? null,
    reviewDue: r.reviewDue === true,
  };
}
export function createScopeGuard(initial: string) {
  let scope = initial,
    epoch = 0,
    dead = false;
  return {
    activate: () => {
      dead = false;
      epoch++;
    },
    begin: () => {
      epoch++;
      return { scope, epoch };
    },
    capture: () => ({ scope, epoch }),
    current: (token: { scope: string; epoch: number }) =>
      !dead && token.scope === scope && token.epoch === epoch,
    change: (next: string) => {
      if (next !== scope) {
        scope = next;
        epoch++;
      }
    },
    destroy: () => {
      dead = true;
      epoch++;
    },
  };
}
export function pilotStoryRecoveryPrefix(scope: PilotStoryScope) {
  return `little-hanzi:pilot:story:${[scope.installationId, scope.accountId, scope.childId, STORY_VERSION, scope.publicationId, scope.assignmentId].map(encodeURIComponent).join(':')}`;
}
export function createPilotStoryRecovery(
  scope: PilotStoryScope,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
): StoryRecovery & { startRequestId: () => string } {
  let supported = storage !== null;
  const prefix = pilotStoryRecoveryPrefix(scope);
  const identity = JSON.stringify(scope);
  let startId: string | undefined;
  const readValue = (key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      supported = false;
      return null;
    }
  };
  const writeValue = (key: string, value: string) => {
    try {
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch {
      supported = false;
      return false;
    }
  };
  return {
    available: () => supported,
    lastRun: () => readValue(`${prefix}:last-run`),
    remember: (runId) => writeValue(`${prefix}:last-run`, runId),
    startRequestId: () => {
      if (!startId) {
        startId = readValue(`${prefix}:start-request`) ?? crypto.randomUUID();
        writeValue(`${prefix}:start-request`, startId);
      }
      return startId;
    },
    read(runId) {
      try {
        const envelope = JSON.parse(
          readValue(`${prefix}:${encodeURIComponent(runId)}:outbox`) ?? 'null',
        );
        if (
          !envelope ||
          envelope.identity !== identity ||
          !Array.isArray(envelope.actions)
        )
          return [];
        return envelope.actions.filter(
          (a: StoryPending) =>
            a &&
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
        );
      } catch {
        supported = false;
        return [];
      }
    },
    write: (runId, actions) =>
      writeValue(
        `${prefix}:${encodeURIComponent(runId)}:outbox`,
        JSON.stringify({ identity, actions }),
      ),
  };
}
export function createPilotStoryTransport(
  scope: PilotStoryScope,
  {
    request = fetch,
    verifyIdentity,
    id = () => crypto.randomUUID(),
  }: {
    request?: typeof fetch;
    verifyIdentity: () => Promise<boolean>;
    id?: () => string;
  },
): StoryTransport {
  let startId: string | undefined;
  async function call(path: string, body?: unknown) {
    if (!(await verifyIdentity()))
      throw new StoryApiError(
        401,
        'IDENTITY_CHANGED',
        'Your account changed. Sign in again.',
      );
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
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (value as { error?: { code?: string } })?.error;
      throw new StoryApiError(
        response.status,
        error?.code ?? 'REQUEST_FAILED',
        response.status === 409
          ? 'The saved plan or story changed. Refresh before continuing.'
          : response.status >= 500
            ? 'The learning service is unavailable. Retry.'
            : 'This learning record is unavailable for your account.',
      );
    }
    return value;
  }
  return {
    createRun: async () => {
      startId ??= id();
      const started = (await call(
        `/api/pilot/curriculum/assignments/${encodeURIComponent(scope.assignmentId)}/start`,
        { requestId: startId },
      )) as { runId: string; assignmentId: string; lessonVersion: string };
      if (
        started.assignmentId !== scope.assignmentId ||
        started.lessonVersion !== STORY_VERSION ||
        typeof started.runId !== 'string'
      )
        throw new Error('Invalid saved start response.');
      return call(
        `/api/pilot/curriculum/learning-runs/${encodeURIComponent(started.runId)}`,
      );
    },
    getRun: (runId) =>
      call(`/api/pilot/curriculum/learning-runs/${encodeURIComponent(runId)}`),
    sendAction: async (runId, a) =>
      (
        (await call(
          `/api/pilot/curriculum/learning-runs/${encodeURIComponent(runId)}/actions`,
          {
            eventId: a.eventId,
            expectedRevision: a.expectedRevision,
            stepId: a.stepId,
            type: a.type,
            payload: a.payload,
          },
        )) as { ack: StoryAck }
      ).ack,
  };
}

export function createStorySession({
  transport,
  recovery,
  scope,
  verifyIdentity,
  onChange = () => {},
  id = () => crypto.randomUUID(),
}: {
  transport: StoryTransport;
  recovery: StoryRecovery;
  scope: PilotStoryScope;
  verifyIdentity: () => Promise<boolean>;
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
  function lock() {
    dead = true;
    generation++;
    run = null;
    pending = [];
    status = 'locked';
    notice = 'Your account changed. Sign in again to continue.';
    onChange(snapshot());
  }
  async function verify() {
    if (dead) return false;
    try {
      const valid = await verifyIdentity();
      if (dead) return false;
      if (!valid) {
        lock();
        return false;
      }
      return true;
    } catch {
      if (!dead) {
        status = pending.length ? 'pending' : 'error';
        notice = 'Your session could not be checked. Retry before continuing.';
        emit();
      }
      return false;
    }
  }
  async function open(runId: string) {
    if (!(await verify())) return;
    if (running)
      throw new Error(
        'Finish or retry the pending save before opening another story.',
      );
    const memoryPending = run?.runId === runId ? [...pending] : [];
    const token = ++generation;
    status = 'loading';
    emit();
    try {
      const next = normalizeStoryRun(await transport.getRun(runId), scope);
      if (dead || token !== generation) return;
      run = next;
      pending = memoryPending.length
        ? memoryPending
        : recovery.read(next.runId);
      reportReady = true;
      conflictReady = false;
      recovery.remember(next.runId);
      storageAvailable = recovery.available();
      status = !run.available
        ? 'unavailable'
        : pending.length
          ? 'pending'
          : 'saved';
      notice = !run.available
        ? (run.reason ?? 'This story is no longer available.')
        : pending.length
          ? 'An unsent action is ready to retry with its original identity.'
          : storageAvailable
            ? ''
            : storageNotice;
      lastOutcome = null;
      emit();
    } catch (error) {
      if (dead || token !== generation) return;
      if (
        [401, 403, 404].includes((error as { status?: number }).status ?? 0)
      ) {
        lock();
        return;
      }
      status = 'error';
      notice =
        error instanceof Error
          ? error.message
          : 'The saved story could not be opened.';
      emit();
    }
  }
  async function create() {
    if (!(await verify())) return;
    if (running || pending.length)
      throw new Error(
        'Finish or retry the pending save before starting another story.',
      );
    const token = ++generation;
    status = 'loading';
    emit();
    try {
      const next = normalizeStoryRun(await transport.createRun(), scope);
      if (dead || token !== generation) return;
      run = next;
      recovery.remember(next.runId);
      storageAvailable = recovery.available();
      pending = [];
      reportReady = true;
      conflictReady = false;
      status = next.available ? 'saved' : 'unavailable';
      notice = next.available
        ? storageAvailable
          ? ''
          : storageNotice
        : (next.reason ?? 'This lesson is no longer available.');
      emit();
    } catch (error) {
      if (dead || token !== generation) return;
      if (
        [401, 403, 404].includes((error as { status?: number }).status ?? 0)
      ) {
        lock();
        return;
      }
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
    if (
      !run ||
      !run.available ||
      dead ||
      !pending.length ||
      status === 'conflict'
    )
      return;
    const token = generation;
    status = 'saving';
    notice = storageAvailable ? 'Saving this action…' : storageNotice;
    emit();
    running = (async () => {
      while (run && pending.length && !dead && token === generation) {
        const action = pending[0];
        try {
          if (!(await verify()) || !run.available) return;
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
          const http = (error as { status?: number }).status;
          if (http === 401 || http === 403 || http === 404) {
            lock();
            return;
          }
          if (http === 409) {
            status = 'conflict';
            conflictReady = false;
            notice =
              'This action was not applied. Read the saved step, then choose Continue from saved state. Your unsent input is retained until then.';
            try {
              const fresh = normalizeStoryRun(
                await transport.getRun(run.runId),
                scope,
              );
              if (dead || token !== generation) return;
              run = fresh;
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
        await readSavedReport();
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
      const fresh = normalizeStoryRun(await transport.getRun(runId), scope);
      if (dead || token !== generation) return;
      run = fresh;
      reportReady = true;
      status = fresh.available ? 'saved' : 'unavailable';
      notice = storageAvailable ? 'Saved report loaded.' : storageNotice;
      emit();
    } catch (error) {
      if (dead || token !== generation) return;
      if (
        [401, 403, 404].includes((error as { status?: number }).status ?? 0)
      ) {
        lock();
        return;
      }
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
      const fresh = normalizeStoryRun(await transport.getRun(runId), scope);
      if (dead || token !== generation) return;
      run = fresh;
      reportReady = true;
      conflictReady = true;
      notice =
        'The latest saved step is ready. Choose Continue from saved state; the unsent action will not be resubmitted.';
      emit();
    } catch (error) {
      if (dead || token !== generation) return;
      if (
        [401, 403, 404].includes((error as { status?: number }).status ?? 0)
      ) {
        lock();
        return;
      }
      notice =
        'The latest saved step could not be loaded. Refresh before continuing; your unsent input is retained.';
      emit();
    }
  }
  async function submit(
    type: StoryActionType,
    payload: Record<string, unknown> = {},
  ) {
    if (!run || !run.available || pending.length || status !== 'saved' || dead)
      return false;
    enqueue(type, payload);
    await drain();
    return status === 'saved';
  }
  function failRequiredAudio(questionId: string) {
    if (
      !run ||
      !run.available ||
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
      if (status !== 'conflict' || !run || !run.available || !conflictReady)
        return;
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
      run.available &&
      status === 'saved' &&
      !pending.length &&
      (!run.state.questionId || run.state.questionStatus !== 'open'),
    lock,
    destroy() {
      dead = true;
      generation++;
    },
  };
}

import {
  getPilotMe,
  hasPendingSignOut,
  pilotRequest,
  type PilotMe,
} from './pilot-client.ts';
import type {
  LibraryItem,
  PlacementProposal,
  StoryPlan,
  PracticeItem,
  CurriculumProgress,
} from './curriculum/story-types.ts';
export async function ensurePilotStoryIdentity(
  scope: Pick<PilotStoryScope, 'accountId' | 'installationId' | 'childId'>,
) {
  if (hasPendingSignOut()) return false;
  const me = await getPilotMe();
  return (
    !hasPendingSignOut() &&
    me.user.id === scope.accountId &&
    me.installationId === scope.installationId &&
    !me.user.mustChangePassword &&
    me.user.role === 'child' &&
    me.user.id === scope.childId
  );
}
export function createFamilyStoryClient(me: PilotMe, request = pilotRequest) {
  const childPath = (child: string, suffix: string) =>
    `/api/pilot/children/${encodeURIComponent(child)}${suffix}`;
  async function call<T>(
    child: string,
    suffix: string,
    body?: unknown,
    method = 'POST',
  ): Promise<T> {
    if (hasPendingSignOut())
      throw new StoryApiError(401, 'SESSION_CHANGED', 'Finish signing out.');
    const current = await getPilotMe();
    if (
      current.user.id !== me.user.id ||
      current.installationId !== me.installationId ||
      current.user.mustChangePassword
    )
      throw new StoryApiError(
        401,
        'SESSION_CHANGED',
        'Your account changed. Sign in again.',
      );
    return request<T>(
      childPath(child, suffix),
      body === undefined ? {} : { method, body: JSON.stringify(body) },
    );
  }
  return {
    onboarding: (child: string) =>
      call<{
        onboarding: {
          nickname: string;
          experience: 'new' | 'some' | 'confident' | 'unsure';
          audioReady: boolean;
        } | null;
      }>(child, '/onboarding'),
    saveSetup: (
      child: string,
      value: {
        nickname: string;
        experience: 'new' | 'some' | 'confident' | 'unsure';
        audioReady: boolean;
      },
    ) => call(child, '/onboarding', value, 'PUT'),
    library: (child: string) =>
      call<{ items: LibraryItem[] }>(child, '/library'),
    placement: (child: string) =>
      call<{
        setupComplete: boolean;
        proposal: PlacementProposal | null;
        reason: string | null;
      }>(child, '/placement'),
    propose: (child: string) =>
      call<{ proposal: PlacementProposal }>(child, '/placement/proposals', {
        lessonVersion: STORY_VERSION,
      }),
    approve: (child: string, proposal: PlacementProposal) =>
      call<{ plan: StoryPlan }>(child, '/placement/approve', {
        proposalId: proposal.proposalId,
        sourceDigest: proposal.sourceDigest,
      }),
    plan: (child: string) =>
      call<{ plan: StoryPlan | null; history: StoryPlan[] }>(child, '/plan'),
    practice: (child: string) =>
      call<{ items: PracticeItem[] }>(child, '/practice'),
    progress: (child: string) =>
      call<{ curriculum?: CurriculumProgress }>(child, '/progress'),
    export: (child: string) =>
      call<{ curriculum?: CurriculumProgress }>(child, '/export'),
  };
}
export function localStoryDate(value: string | null) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Not scheduled'
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}
const activeControllers = new Set<() => void>();
export function registerPilotStoryController(stop: () => void) {
  activeControllers.add(stop);
  return () => {
    activeControllers.delete(stop);
  };
}
export function lockPilotStoryControllers() {
  for (const stop of activeControllers) stop();
  activeControllers.clear();
}
