import { randomUUID } from 'node:crypto';

import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type TestInfo,
} from '@playwright/test';

export const LESSON_ID = 'forest-01';
export const LESSON_VERSION = 'forest-01-v1';
export const SEED = 17;
export const INITIAL_TIME = '2026-09-25T00:00:00.000Z';
export const TEST_TOKEN_HEADER = 'X-Hanzi-Test-Token';

export const CORRECT_CHOICES = {
  'fam-mu': 'mu',
  'fam-lin': 'lin',
  'find-mu': 'mu',
  'find-lin': 'lin',
  'check-mu-sound': 'mu',
  'check-lin-sound': 'lin',
  'check-mu-reading': 'audio-mu',
  'check-lin-reading': 'audio-lin',
  'review-mu-sound': 'mu',
  'review-lin-sound': 'lin',
} as const;

export type QuestionId = keyof typeof CORRECT_CHOICES;
export type FixtureScenario =
  | 'new-reader'
  | 'familiar-reader'
  | 'mixed-reader'
  | 'needs-help'
  | 'in-progress'
  | 'completed-not-due'
  | 'review-due'
  | 'legacy-and-two-runs';

export type ActionType =
  | 'answer'
  | 'hint'
  | 'place-component'
  | 'continue'
  | 'audio-unavailable'
  | 'start-review';

export interface RunState {
  phase: 'initial' | 'delayed';
  stepId: string;
  questionId: string | null;
  questionStatus: 'open' | 'answered' | 'demonstrated' | 'unavailable' | null;
  placedComponents:
    | { left: string | null; right: string | null }
    | Array<{ componentId?: string; slot?: string }>;
  completedAt: string | null;
  reviewCompletedAt: string | null;
}

export interface LearningEvent {
  eventId: string;
  runId: string;
  phase: string;
  stepId: string;
  questionId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  sequence: number;
  firstResponse?: boolean | null;
  assisted?: boolean;
  outcome?: string;
  result?:
    | string
    | { outcome?: string; firstResponse?: boolean | null; assisted?: boolean };
}

export interface RecapGroup {
  total: number;
  independentCorrect: number;
  supported: number;
  unavailable: number;
  pending: number;
}

export interface RunSnapshot {
  runId: string;
  lessonId: string;
  lessonVersion: string;
  seed: number;
  state: RunState;
  revision: number;
  events: LearningEvent[];
  recap: {
    familiarity?: RecapGroup;
    final?: RecapGroup;
    delayed?: RecapGroup;
    [key: string]: unknown;
  };
  feedback: Array<Record<string, unknown>>;
  reviewAvailableAt: string | null;
}

export interface RunCreated {
  runId: string;
  lessonId: string;
  lessonVersion: string;
  seed: number;
  state: RunState;
  revision: number;
}

export interface FixtureResponse {
  scenario: FixtureScenario;
  seed: number;
  runIds: string[];
  labels?: string[];
  legacyProfile?: string;
  lessonVersion?: string;
  candidateId?: string;
}

export interface ActionResult {
  eventId: string;
  result: {
    outcome:
      | 'correct'
      | 'incorrect'
      | 'demonstrated'
      | 'unavailable'
      | 'recorded';
    firstResponse: boolean | null;
    assisted: boolean;
  };
  state: RunState;
  revision: number;
}

export interface ActionRequest {
  eventId: string;
  expectedRevision: number;
  stepId: string;
  type: ActionType;
  payload: Record<string, unknown>;
}

export interface ForestFixtures {
  forest: ForestHarness;
}

export const forestTest = base.extend<ForestFixtures>({
  forest: async ({ request }, fulfill, testInfo) => {
    const harness = new ForestHarness(request, testInfo);
    await harness.verifyIdentity();
    await fulfill(harness);
    await harness.cleanup();
  },
});

export { expect };

function token(): string {
  const value = process.env.HANZI_TEST_TOKEN;
  if (!value)
    throw new Error('HANZI_TEST_TOKEN is required for Sprint 1 tests');
  return value;
}

function controlHeaders(value = token()): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    [TEST_TOKEN_HEADER]: value,
  };
}

export function noStore(response: APIResponse): void {
  expect(response.headers()['cache-control']).toContain('no-store');
}

export function eventOutcome(event: LearningEvent): string | undefined {
  if (event.outcome) return event.outcome;
  return typeof event.result === 'string'
    ? event.result
    : event.result?.outcome;
}

export async function json<T>(response: APIResponse): Promise<T> {
  return (await response.json()) as T;
}

export async function errorBody(
  response: APIResponse,
): Promise<{ error?: { code?: string; message?: string } }> {
  return json(response);
}

export async function expectError(
  response: APIResponse,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status()).toBe(status);
  noStore(response);
  const body = await errorBody(response);
  expect(body.error?.code).toBe(code);
}

export class ForestHarness {
  readonly createdRuns = new Set<string>();
  private readonly prefix: string;

  constructor(
    readonly api: APIRequestContext,
    private readonly testInfo: TestInfo,
  ) {
    this.prefix = `${testInfo.project.name}-${testInfo.testId.slice(0, 12)}`;
  }

  async verifyIdentity(): Promise<Record<string, unknown>> {
    const response = await this.control('GET', '/api/test/identity');
    expect(response.status()).toBe(200);
    noStore(response);
    const body = await json<Record<string, unknown>>(response);
    expect(body.testMode).toBe(true);
    expect(body.testRunId).toEqual(expect.any(String));
    expect(body.candidateId).toEqual(expect.any(String));
    expect(body.isolatedStorage ?? body.isolatedStorageMarker).toBe(true);
    expect(body.storageMarker ?? body.isolatedStorageMarker).toEqual(
      expect.any(String),
    );
    expect(JSON.stringify(body)).not.toContain(token());
    return body;
  }

  async fixture(
    scenario: FixtureScenario,
    seed = SEED,
  ): Promise<{ body: FixtureResponse; response: APIResponse }> {
    const response = await this.control('POST', '/api/test/fixtures', {
      scenario,
      seed,
    });
    expect([200, 201]).toContain(response.status());
    noStore(response);
    const body = await json<FixtureResponse>(response);
    expect(body.scenario).toBe(scenario);
    expect(body.seed).toBe(seed);
    expect(Array.isArray(body.runIds)).toBe(true);
    expect(body.runIds.length).toBeGreaterThan(0);
    for (const runId of body.runIds) this.createdRuns.add(runId);
    return { body, response };
  }

  async createRun(
    lessonVersion = LESSON_VERSION,
  ): Promise<{ body: RunCreated; response: APIResponse }> {
    const response = await this.preview('POST', '/api/preview/runs', {
      lessonId: LESSON_ID,
      lessonVersion,
    });
    expect(response.status()).toBe(201);
    noStore(response);
    const body = await json<RunCreated>(response);
    expect(body.runId).toEqual(expect.any(String));
    expect(body.lessonId).toBe(LESSON_ID);
    expect(body.lessonVersion).toBe(lessonVersion);
    expect(body.seed).toEqual(expect.any(Number));
    expect(body.revision).toBe(0);
    this.createdRuns.add(body.runId);
    return { body, response };
  }

  async listRuns(): Promise<{
    body: { runs: Array<Record<string, unknown>> };
    response: APIResponse;
  }> {
    const response = await this.preview('GET', '/api/preview/runs');
    expect(response.status()).toBe(200);
    noStore(response);
    const body = await json<{ runs: Array<Record<string, unknown>> }>(response);
    expect(Array.isArray(body.runs)).toBe(true);
    return { body, response };
  }

  async getRun(
    runId: string,
  ): Promise<{ body: RunSnapshot; response: APIResponse }> {
    const response = await this.preview(
      'GET',
      `/api/preview/runs/${encodeURIComponent(runId)}`,
    );
    expect(response.status()).toBe(200);
    noStore(response);
    const body = await json<RunSnapshot>(response);
    expect(body.runId).toBe(runId);
    expect(body.lessonId).toBe(LESSON_ID);
    expect(body.state).toBeTruthy();
    return { body, response };
  }

  async action(
    runId: string,
    type: ActionType,
    payload: Record<string, unknown>,
    stepId?: string,
    eventId?: string,
  ): Promise<{
    body: ActionResult;
    response: APIResponse;
    request: ActionRequest;
  }> {
    const current = await this.getRun(runId);
    const request: ActionRequest = {
      eventId: eventId ?? `${this.prefix}-${randomUUID()}`,
      expectedRevision: current.body.revision,
      stepId: stepId ?? current.body.state.stepId,
      type,
      payload,
    };
    const response = await this.preview(
      'POST',
      `/api/preview/runs/${encodeURIComponent(runId)}/actions`,
      request,
    );
    expect(response.status()).toBe(200);
    noStore(response);
    const body = await json<ActionResult>(response);
    expect(body.eventId).toBe(request.eventId);
    expect(body.revision).toBeGreaterThanOrEqual(request.expectedRevision);
    return { body, response, request };
  }

  async actionAt(
    runId: string,
    request: ActionRequest,
  ): Promise<{ body: ActionResult; response: APIResponse }> {
    const response = await this.preview(
      'POST',
      `/api/preview/runs/${encodeURIComponent(runId)}/actions`,
      request,
    );
    expect(response.status()).toBe(200);
    noStore(response);
    return { body: await json<ActionResult>(response), response };
  }

  async setClock(
    runId: string,
    effectiveTime: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.control(
      'POST',
      `/api/test/runs/${encodeURIComponent(runId)}/clock`,
      { effectiveTime },
    );
    expect(response.status()).toBe(200);
    noStore(response);
    const body = await json<Record<string, unknown>>(response);
    expect(body.effectiveTime).toBe(effectiveTime);
    return body;
  }

  async resetRun(runId: string): Promise<APIResponse> {
    const response = await this.control(
      'DELETE',
      `/api/test/runs/${encodeURIComponent(runId)}`,
    );
    expect([200, 204]).toContain(response.status());
    noStore(response);
    this.createdRuns.delete(runId);
    return response;
  }

  async control(
    method: string,
    path: string,
    data?: unknown,
    tokenValue = token(),
  ): Promise<APIResponse> {
    return this.api.fetch(path, {
      method,
      data,
      headers: controlHeaders(tokenValue),
    });
  }

  async preview(
    method: string,
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<APIResponse> {
    return this.api.fetch(path, {
      method,
      data,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        [TEST_TOKEN_HEADER]: token(),
        ...headers,
      },
    });
  }

  async raw(
    method: string,
    path: string,
    data?: unknown,
    headers: Record<string, string> = {},
  ): Promise<APIResponse> {
    return this.api.fetch(path, {
      method,
      data,
      headers: { accept: 'application/json', ...headers },
    });
  }

  async cleanup(): Promise<void> {
    for (const runId of this.createdRuns) {
      try {
        const response = await this.control(
          'DELETE',
          `/api/test/runs/${encodeURIComponent(runId)}`,
        );
        if ([200, 204, 404].includes(response.status()))
          this.createdRuns.delete(runId);
      } catch {
        // The runner retains failure state and artifacts; cleanup cannot hide the test result.
      }
    }
  }

  async advanceToQuestion(
    runId: string,
    target: QuestionId,
    options: { familiarity?: 'new' | 'familiar' | 'mixed' } = {},
  ): Promise<RunSnapshot> {
    const familiarity = options.familiarity ?? 'familiar';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const snapshot = (await this.getRun(runId)).body;
      if (
        snapshot.state.questionId === target &&
        snapshot.state.questionStatus === 'open'
      )
        return snapshot;

      const questionId = snapshot.state.questionId;
      if (snapshot.state.questionStatus === 'open' && questionId) {
        const choice = this.choiceForQuestion(questionId, familiarity);
        await this.action(runId, 'answer', { questionId, choiceId: choice });
        continue;
      }

      if (snapshot.state.stepId === 'build') {
        const placed = snapshot.state.placedComponents;
        const left = Array.isArray(placed)
          ? (placed.find((entry) => entry.slot === 'left')?.componentId ?? null)
          : placed.left;
        const right = Array.isArray(placed)
          ? (placed.find((entry) => entry.slot === 'right')?.componentId ??
            null)
          : placed.right;
        if (left !== 'mu-a' && right !== 'mu-a') {
          await this.action(runId, 'place-component', {
            componentId: 'mu-a',
            slot: 'left',
          });
        } else if (left !== 'mu-b' && right !== 'mu-b') {
          await this.action(runId, 'place-component', {
            componentId: 'mu-b',
            slot: 'right',
          });
        } else {
          await this.action(runId, 'continue', {});
        }
        continue;
      }

      await this.action(runId, 'continue', {});
    }
    throw new Error(`Timed out advancing ${runId} to ${target}`);
  }

  async finishQuestion(
    runId: string,
    questionId: QuestionId,
    choiceId = CORRECT_CHOICES[questionId],
  ): Promise<void> {
    const snapshot = await this.advanceToQuestion(runId, questionId);
    await this.action(
      runId,
      'answer',
      { questionId, choiceId },
      snapshot.state.stepId,
    );
    const after = (await this.getRun(runId)).body;
    if (
      after.state.questionStatus !== null &&
      after.state.questionStatus !== 'open'
    ) {
      await this.action(runId, 'continue', {});
    }
  }

  async completeCanonicalInitial(
    runId: string,
    mode: 'new-reader' | 'familiar-reader' | 'mixed-reader' = 'familiar-reader',
  ): Promise<RunSnapshot> {
    const familiarity: Record<string, string[]> = {
      'new-reader': ['lin', 'mu', 'mu', 'lin'],
      'familiar-reader': ['mu', 'lin'],
      'mixed-reader': ['mu', 'mu', 'lin'],
    };
    const choices = familiarity[mode];
    const first = await this.advanceToQuestion(runId, 'fam-mu');
    await this.action(
      runId,
      'answer',
      { questionId: 'fam-mu', choiceId: choices[0] },
      first.state.stepId,
    );
    let state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});
    const second = await this.advanceToQuestion(runId, 'fam-lin', {
      familiarity: 'new',
    });
    await this.action(
      runId,
      'answer',
      {
        questionId: 'fam-lin',
        choiceId: choices[mode === 'familiar-reader' ? 1 : 1],
      },
      second.state.stepId,
    );
    state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});
    for (const questionId of [
      'check-mu-sound',
      'check-lin-sound',
      'check-mu-reading',
      'check-lin-reading',
    ] as const) {
      await this.finishQuestion(runId, questionId);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      state = (await this.getRun(runId)).body;
      if (state.state.completedAt) return state;
      if (state.state.questionStatus === 'open' && state.state.questionId) {
        await this.action(runId, 'answer', {
          questionId: state.state.questionId,
          choiceId: CORRECT_CHOICES[state.state.questionId as QuestionId],
        });
      } else {
        await this.action(runId, 'continue', {});
      }
    }
    return (await this.getRun(runId)).body;
  }

  async completeNeedsHelp(runId: string): Promise<RunSnapshot> {
    const first = await this.advanceToQuestion(runId, 'fam-mu');
    await this.action(
      runId,
      'answer',
      { questionId: 'fam-mu', choiceId: 'lin' },
      first.state.stepId,
    );
    let state = (await this.getRun(runId)).body;
    if (state.state.questionStatus === 'open')
      await this.action(runId, 'answer', {
        questionId: 'fam-mu',
        choiceId: 'mu',
      });
    state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});
    const second = await this.advanceToQuestion(runId, 'fam-lin', {
      familiarity: 'new',
    });
    await this.action(
      runId,
      'answer',
      { questionId: 'fam-lin', choiceId: 'mu' },
      second.state.stepId,
    );
    state = (await this.getRun(runId)).body;
    if (state.state.questionStatus === 'open')
      await this.action(runId, 'answer', {
        questionId: 'fam-lin',
        choiceId: 'lin',
      });
    state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});

    const firstFinal = await this.advanceToQuestion(runId, 'check-mu-sound');
    await this.action(
      runId,
      'answer',
      { questionId: 'check-mu-sound', choiceId: 'lin' },
      firstFinal.state.stepId,
    );
    state = (await this.getRun(runId)).body;
    if (state.state.questionStatus === 'open')
      await this.action(runId, 'answer', {
        questionId: 'check-mu-sound',
        choiceId: 'ren',
      });
    state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});
    await this.finishQuestion(runId, 'check-lin-sound');
    const hinted = await this.advanceToQuestion(runId, 'check-mu-reading');
    await this.action(
      runId,
      'hint',
      { questionId: 'check-mu-reading' },
      hinted.state.stepId,
    );
    await this.action(runId, 'answer', {
      questionId: 'check-mu-reading',
      choiceId: 'audio-mu',
    });
    state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});
    const unavailable = await this.advanceToQuestion(
      runId,
      'check-lin-reading',
    );
    await this.action(
      runId,
      'audio-unavailable',
      { questionId: 'check-lin-reading' },
      unavailable.state.stepId,
    );
    state = (await this.getRun(runId)).body;
    if (
      state.state.questionStatus !== null &&
      state.state.questionStatus !== 'open'
    )
      await this.action(runId, 'continue', {});
    for (let attempt = 0; attempt < 12; attempt += 1) {
      state = (await this.getRun(runId)).body;
      if (state.state.completedAt) return state;
      await this.action(runId, 'continue', {});
    }
    return (await this.getRun(runId)).body;
  }

  private choiceForQuestion(
    questionId: string,
    familiarity: 'new' | 'familiar' | 'mixed',
  ): string {
    if (questionId === 'fam-mu') return familiarity === 'new' ? 'lin' : 'mu';
    if (questionId === 'fam-lin') return familiarity === 'new' ? 'mu' : 'lin';
    return CORRECT_CHOICES[questionId as QuestionId] ?? 'mu';
  }

  private async previewRequest(
    method: string,
    path: string,
    data?: unknown,
  ): Promise<APIResponse> {
    return this.api.fetch(path, {
      method,
      data,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        [TEST_TOKEN_HEADER]: token(),
      },
    });
  }
}
