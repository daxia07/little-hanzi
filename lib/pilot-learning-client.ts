import {
  FOREST_LESSON_VERSION,
  ForestActionResponse,
  ForestPendingAction,
  ForestRun,
  normalizeForestRun,
  newForestId,
} from '@/lib/forest-client';
import {
  getPilotMe,
  getPilotSession,
  hasPendingSignOut,
} from '@/lib/pilot-client';
import type {
  ForestLessonTransport,
  ForestRecoveryScope,
  ForestRecoveryStore,
} from '@/lib/forest-transport';

export type PilotOnboardingExperience = 'new' | 'some' | 'confident' | 'unsure';

export interface PilotOnboarding {
  nickname: string;
  experience: PilotOnboardingExperience;
  audioReady: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface PilotAssignment {
  lessonId: string;
  lessonVersion: string;
  title: string;
  status: 'assigned';
  createdAt: string;
  runId: string | null;
}

export interface PilotAvailableLesson {
  lessonId: string;
  lessonVersion: string;
  title: string;
  releaseState: 'pending' | 'approved' | 'test-fixture';
  canAssign: boolean;
}

export interface PilotAssignments {
  assignments: PilotAssignment[];
  availableLessons: PilotAvailableLesson[];
}

export interface PilotEvidenceLimits {
  completion?: string;
  assistance?: string;
  audio?: string;
  review?: string;
  [key: string]: unknown;
}

export interface PilotProgress {
  child: { id: string; name: string };
  assignments: PilotAssignment[];
  runs: Array<ForestRun & { childId?: string }>;
  evidenceLimits: PilotEvidenceLimits;
}

export interface PilotLearningExport extends PilotProgress {
  schemaVersion: 'pilot-learning-export-1';
  exportedAt: string;
  onboarding: PilotOnboarding | null;
}

export interface PilotLearningContext {
  installationId: string;
  accountId: string;
  childId: string;
  lessonVersion?: string;
}

export class PilotLearningApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = 'PilotLearningApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return object(value) ? value : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function errorMessage(status: number, code: string, message: unknown): string {
  if (code === 'ONBOARDING_REQUIRED')
    return 'Complete the short child plan before assigning this lesson.';
  if (code === 'LESSON_NOT_RELEASED')
    return 'This lesson is not available for this pilot installation yet.';
  if (code === 'ASSIGNMENT_REQUIRED')
    return 'A parent must assign this lesson before it can start.';
  if (code === 'NOT_FOUND' || status === 404)
    return 'This child learning record is no longer available.';
  if (status === 403)
    return 'This account can view the record but cannot change it.';
  if (status === 401)
    return 'Your invited session has ended. Sign in again to continue.';
  if (status === 409)
    return typeof message === 'string'
      ? message
      : 'This learning record changed. Refresh and try again.';
  if (status >= 500)
    return 'The learning service is temporarily unavailable. Please retry.';
  return typeof message === 'string'
    ? message
    : 'The learning request could not be completed. Please retry.';
}

async function parseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const body = await parseBody(response);
  if (!response.ok) {
    const root = record(body);
    const nested = record(root.error);
    const code = stringValue(
      nested.code || root.code,
      'PILOT_LEARNING_REQUEST_FAILED',
    );
    throw new PilotLearningApiError(
      response.status,
      code,
      errorMessage(response.status, code, nested.message || root.message),
      body,
    );
  }
  return body as T;
}

function json(value: unknown, method = 'POST'): RequestInit {
  return { method, body: JSON.stringify(value) };
}

function childPath(childId: string, suffix: string): string {
  return `/api/pilot/children/${encodeURIComponent(childId)}${suffix}`;
}

function normalizeOnboarding(value: unknown): PilotOnboarding | null {
  const item = record(value);
  const experience = item.experience;
  if (
    typeof item.nickname !== 'string' ||
    (experience !== 'new' &&
      experience !== 'some' &&
      experience !== 'confident' &&
      experience !== 'unsure') ||
    typeof item.audioReady !== 'boolean'
  ) {
    return null;
  }
  return {
    nickname: item.nickname,
    experience,
    audioReady: item.audioReady,
    updatedAt: stringValue(item.updatedAt) || undefined,
    updatedBy: stringValue(item.updatedBy) || undefined,
  };
}

function normalizeAssignment(value: unknown): PilotAssignment | null {
  const item = record(value);
  if (
    typeof item.lessonId !== 'string' ||
    typeof item.lessonVersion !== 'string' ||
    typeof item.title !== 'string' ||
    item.status !== 'assigned' ||
    typeof item.createdAt !== 'string'
  )
    return null;
  return {
    lessonId: item.lessonId,
    lessonVersion: item.lessonVersion,
    title: item.title,
    status: 'assigned',
    createdAt: item.createdAt,
    runId: typeof item.runId === 'string' ? item.runId : null,
  };
}

function normalizeAvailableLesson(value: unknown): PilotAvailableLesson | null {
  const item = record(value);
  const releaseState = item.releaseState;
  if (
    typeof item.lessonId !== 'string' ||
    typeof item.lessonVersion !== 'string' ||
    typeof item.title !== 'string' ||
    (releaseState !== 'pending' &&
      releaseState !== 'approved' &&
      releaseState !== 'test-fixture') ||
    typeof item.canAssign !== 'boolean'
  )
    return null;
  return {
    lessonId: item.lessonId,
    lessonVersion: item.lessonVersion,
    title: item.title,
    releaseState,
    canAssign: item.canAssign,
  };
}

export async function ensurePilotLearningSession(
  context: PilotLearningContext,
): Promise<void> {
  if (hasPendingSignOut()) {
    throw new PilotLearningApiError(
      401,
      'PENDING_SIGN_OUT',
      'Finish signing out before opening another learning record.',
    );
  }
  const session = await getPilotSession();
  if (!session || session.user.id !== context.accountId) {
    throw new PilotLearningApiError(
      401,
      'SESSION_CHANGED',
      'Your invited session changed. Sign in again to continue.',
    );
  }
  const me = await getPilotMe();
  if (
    me.user.id !== context.accountId ||
    me.installationId !== context.installationId
  ) {
    throw new PilotLearningApiError(
      401,
      'INSTALLATION_CHANGED',
      'This learning record belongs to another pilot installation. Sign in again to continue.',
    );
  }
}

function scopeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function pilotRecoveryKey(
  context: PilotLearningContext,
  scope: ForestRecoveryScope,
): string {
  const lessonVersion = context.lessonVersion || FOREST_LESSON_VERSION;
  return `little-hanzi:pilot:${scopeKeyPart(context.installationId)}:${scopeKeyPart(context.accountId)}:${scopeKeyPart(context.childId)}:${scopeKeyPart(lessonVersion)}:${scopeKeyPart(scope.runId)}:outbox`;
}

function validPendingAction(
  value: unknown,
  scope: ForestRecoveryScope,
  lessonVersion: string,
): value is ForestPendingAction {
  const item = record(value);
  return (
    item.runId === scope.runId &&
    item.lessonVersion === lessonVersion &&
    typeof item.eventId === 'string' &&
    Number.isInteger(item.expectedRevision) &&
    Number(item.expectedRevision) >= 0 &&
    typeof item.stepId === 'string' &&
    [
      'answer',
      'hint',
      'place-component',
      'continue',
      'audio-unavailable',
      'start-review',
    ].includes(String(item.type)) &&
    object(item.payload) &&
    typeof item.createdAt === 'string'
  );
}

export function createPilotRecoveryStore(
  context: PilotLearningContext,
): ForestRecoveryStore {
  const lessonVersion = context.lessonVersion || FOREST_LESSON_VERSION;
  return {
    available() {
      if (typeof window === 'undefined') return false;
      try {
        const key = `little-hanzi:pilot:storage-probe:${newForestId()}`;
        window.localStorage.setItem(key, '1');
        window.localStorage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    read(scope) {
      if (typeof window === 'undefined') return [];
      try {
        const raw = window.localStorage.getItem(
          pilotRecoveryKey(context, scope),
        );
        const value: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(value)
          ? value.filter((item): item is ForestPendingAction =>
              validPendingAction(item, scope, lessonVersion),
            )
          : [];
      } catch {
        return [];
      }
    },
    write(scope, actions) {
      if (typeof window === 'undefined') return false;
      if (
        actions.some((item) => !validPendingAction(item, scope, lessonVersion))
      )
        return false;
      try {
        window.localStorage.setItem(
          pilotRecoveryKey(context, scope),
          JSON.stringify(actions),
        );
        return true;
      } catch {
        return false;
      }
    },
    clear(scope) {
      if (typeof window === 'undefined') return false;
      try {
        window.localStorage.removeItem(pilotRecoveryKey(context, scope));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createPilotForestTransport(
  context: PilotLearningContext,
): ForestLessonTransport {
  const version = context.lessonVersion || FOREST_LESSON_VERSION;
  return {
    async ensureSession() {
      await ensurePilotLearningSession(context);
    },
    async createRun() {
      await ensurePilotLearningSession(context);
      const value = await request<unknown>(
        childPath(context.childId, '/runs'),
        json({ lessonVersion: version }),
      );
      return normalizeForestRun(value);
    },
    async getRun(runId) {
      await ensurePilotLearningSession(context);
      const value = await request<unknown>(
        childPath(context.childId, `/runs/${encodeURIComponent(runId)}`),
      );
      return normalizeForestRun(value);
    },
    async sendAction(runId, expectedRevision, stepId, type, payload, eventId) {
      await ensurePilotLearningSession(context);
      const value = await request<ForestActionResponse>(
        childPath(
          context.childId,
          `/runs/${encodeURIComponent(runId)}/actions`,
        ),
        json({ eventId, expectedRevision, stepId, type, payload }),
      );
      return {
        ...value,
        state: normalizeForestRun({ state: value.state }).state,
      };
    },
  };
}

export async function getPilotOnboarding(
  childId: string,
): Promise<PilotOnboarding | null> {
  const body = await request<unknown>(childPath(childId, '/onboarding'));
  return normalizeOnboarding(record(body).onboarding);
}

export async function savePilotOnboarding(
  childId: string,
  input: {
    nickname: string;
    experience: PilotOnboardingExperience;
    audioReady: boolean;
  },
): Promise<PilotOnboarding> {
  const body = await request<unknown>(
    childPath(childId, '/onboarding'),
    json(input, 'PUT'),
  );
  const onboarding = normalizeOnboarding(record(body).onboarding);
  if (!onboarding)
    throw new PilotLearningApiError(
      500,
      'INVALID_RESPONSE',
      'The saved child plan could not be read.',
    );
  return onboarding;
}

export async function getPilotAssignments(
  childId: string,
): Promise<PilotAssignments> {
  const body = record(
    await request<unknown>(childPath(childId, '/assignments')),
  );
  const assignments = Array.isArray(body.assignments)
    ? body.assignments
        .map(normalizeAssignment)
        .filter((item): item is PilotAssignment => Boolean(item))
    : [];
  const availableLessons = Array.isArray(body.availableLessons)
    ? body.availableLessons
        .map(normalizeAvailableLesson)
        .filter((item): item is PilotAvailableLesson => Boolean(item))
    : [];
  return { assignments, availableLessons };
}

export async function assignPilotLesson(
  childId: string,
  lessonVersion = FOREST_LESSON_VERSION,
): Promise<PilotAssignment> {
  const body = record(
    await request<unknown>(
      childPath(childId, '/assignments'),
      json({ lessonVersion }),
    ),
  );
  const assignment = normalizeAssignment(body.assignment);
  if (!assignment)
    throw new PilotLearningApiError(
      500,
      'INVALID_RESPONSE',
      'The assignment response could not be read.',
    );
  return assignment;
}

export async function getPilotProgress(
  childId: string,
): Promise<PilotProgress> {
  const body = record(await request<unknown>(childPath(childId, '/progress')));
  const child = record(body.child);
  const runs = Array.isArray(body.runs)
    ? body.runs.map((item) => {
        const run = normalizeForestRun(item);
        const childIdValue = stringValue(record(item).childId) || undefined;
        return childIdValue ? { ...run, childId: childIdValue } : run;
      })
    : [];
  const assignments = Array.isArray(body.assignments)
    ? body.assignments
        .map(normalizeAssignment)
        .filter((item): item is PilotAssignment => Boolean(item))
    : [];
  return {
    child: {
      id: stringValue(child.id, childId),
      name: stringValue(child.name, 'Learner'),
    },
    assignments,
    runs,
    evidenceLimits: object(body.evidenceLimits) ? body.evidenceLimits : {},
  };
}

export async function getPilotLearningExport(
  childId: string,
): Promise<PilotLearningExport> {
  const body = record(await request<unknown>(childPath(childId, '/export')));
  const progress = await normalizeProgressBody(body, childId);
  return {
    schemaVersion: 'pilot-learning-export-1',
    exportedAt: stringValue(body.exportedAt, new Date().toISOString()),
    onboarding: normalizeOnboarding(body.onboarding),
    ...progress,
  };
}

async function normalizeProgressBody(
  body: Record<string, unknown>,
  childId: string,
): Promise<PilotProgress> {
  const child = record(body.child);
  const runs = Array.isArray(body.runs)
    ? body.runs.map((item) => {
        const run = normalizeForestRun(item);
        const childIdValue = stringValue(record(item).childId) || undefined;
        return childIdValue ? { ...run, childId: childIdValue } : run;
      })
    : [];
  const assignments = Array.isArray(body.assignments)
    ? body.assignments
        .map(normalizeAssignment)
        .filter((item): item is PilotAssignment => Boolean(item))
    : [];
  return {
    child: {
      id: stringValue(child.id, childId),
      name: stringValue(child.name, 'Learner'),
    },
    assignments,
    runs,
    evidenceLimits: object(body.evidenceLimits) ? body.evidenceLimits : {},
  };
}
