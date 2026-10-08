import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { request as requestFactory } from '@playwright/test';

import {
  CORRECT_CHOICES,
  eventOutcome,
  INITIAL_TIME,
  LESSON_ID,
  LESSON_VERSION,
  SEED,
  TEST_TOKEN_HEADER,
  expect,
  expectError,
  forestTest as test,
  json,
  noStore,
  type ActionRequest,
} from '../helpers/forest-contract';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

test('[S1-AC-012][I-01] creates, lists and reads a run while rejecting invalid content', async ({
  forest,
}) => {
  const created = await forest.createRun();
  expect(created.body.state.phase).toBe('initial');
  expect(created.body.state.stepId).toBe('welcome');

  const initialRead = (await forest.getRun(created.body.runId)).body;
  expect(initialRead.events).toEqual([]);

  const listed = await forest.listRuns();
  expect(listed.body.runs.some((run) => run.runId === created.body.runId)).toBe(
    true,
  );

  const unknownVersion = await forest.preview('POST', '/api/preview/runs', {
    lessonId: LESSON_ID,
    lessonVersion: 'forest-01-does-not-exist',
  });
  await expectError(unknownVersion, 400, 'INVALID_REQUEST');

  const malformedAction = await forest.preview(
    'POST',
    `/api/preview/runs/${created.body.runId}/actions`,
    {
      eventId: 'malformed-action',
      expectedRevision: created.body.revision,
      stepId: 'welcome',
      type: 'answer',
      payload: { questionId: 'not-a-question' },
    },
  );
  await expectError(malformedAction, 400, 'INVALID_REQUEST');

  const outOfStep = await forest.preview(
    'POST',
    `/api/preview/runs/${created.body.runId}/actions`,
    {
      eventId: 'out-of-step-continue',
      expectedRevision: created.body.revision,
      stepId: 'familiarity',
      type: 'continue',
      payload: {},
    },
  );
  await expectError(outOfStep, 409, 'INVALID_TRANSITION');

  const missing = await forest.preview(
    'GET',
    '/api/preview/runs/does-not-exist',
  );
  await expectError(missing, 404, 'NOT_FOUND');

  const unchanged = (await forest.getRun(created.body.runId)).body;
  expect(unchanged.revision).toBe(created.body.revision);
  expect(unchanged.events).toHaveLength(0);
});

test('[S1-AC-004][S1-AC-012][I-02] derives grading and preserves the wrong-to-demonstration evidence', async ({
  forest,
}) => {
  const { body: created } = await forest.createRun();
  const runId = created.runId;
  const question = await forest.advanceToQuestion(runId, 'check-mu-sound', {
    familiarity: 'new',
  });

  const forged = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/actions`,
    {
      eventId: 'forged-score',
      expectedRevision: question.revision,
      stepId: question.state.stepId,
      type: 'answer',
      payload: { questionId: 'check-mu-sound', choiceId: 'lin' },
      correct: true,
    },
  );
  await expectError(forged, 400, 'INVALID_REQUEST');

  const wrong = await forest.action(runId, 'answer', {
    questionId: 'check-mu-sound',
    choiceId: 'lin',
  });
  expect(wrong.body.result.outcome).toBe('incorrect');

  const demonstrated = await forest.action(runId, 'answer', {
    questionId: 'check-mu-sound',
    choiceId: 'ren',
  });
  expect(demonstrated.body.result.outcome).toBe('demonstrated');
  expect(demonstrated.body.result.assisted).toBe(true);

  const saved = (await forest.getRun(runId)).body;
  const events = saved.events.filter(
    (event) => event.questionId === 'check-mu-sound',
  );
  expect(events.map(eventOutcome)).toEqual(
    expect.arrayContaining(['incorrect', 'demonstrated']),
  );
  expect(events.filter((event) => event.type === 'answer')).toHaveLength(2);
  expect(saved.state.questionStatus).toBe('demonstrated');
});

test('[S1-AC-013][I-03] replays an event idempotently and rejects changed reuse', async ({
  forest,
}) => {
  const { body: created } = await forest.createRun();
  const runId = created.runId;
  const current = await forest.advanceToQuestion(runId, 'fam-mu');
  const request: ActionRequest = {
    eventId: 'replay-stability-event',
    expectedRevision: current.revision,
    stepId: current.state.stepId,
    type: 'answer',
    payload: { questionId: 'fam-mu', choiceId: 'mu' },
  };

  const first = await forest.actionAt(runId, request);
  await forest.action(runId, 'continue', {});
  const replay = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/actions`,
    request,
  );
  expect(replay.status()).toBe(200);
  noStore(replay);
  expect(await json(replay)).toEqual(first.body);

  const changed = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/actions`,
    {
      ...request,
      payload: { questionId: 'fam-mu', choiceId: 'lin' },
    },
  );
  await expectError(changed, 409, 'EVENT_CONFLICT');

  const saved = (await forest.getRun(runId)).body;
  expect(
    saved.events.filter((event) => event.eventId === request.eventId),
  ).toHaveLength(1);
});

test('[S1-AC-014][I-04] allows one concurrent transition and conflicts the other', async ({
  forest,
}) => {
  const { body: fixture } = await forest.fixture('in-progress');
  const runId = fixture.runIds[0];
  const current = (await forest.getRun(runId)).body;
  const questionId = current.state.questionId ?? 'check-lin-sound';
  const base: Omit<ActionRequest, 'eventId' | 'type' | 'payload'> = {
    expectedRevision: current.revision,
    stepId: current.state.stepId,
  };
  const hint: ActionRequest = {
    ...base,
    eventId: 'concurrent-hint',
    type: 'hint',
    payload: { questionId },
  };
  const answer: ActionRequest = {
    ...base,
    eventId: 'concurrent-answer',
    type: 'answer',
    payload: {
      questionId,
      choiceId:
        CORRECT_CHOICES[questionId as keyof typeof CORRECT_CHOICES] ?? 'lin',
    },
  };

  const responses = await Promise.all([
    forest.preview('POST', `/api/preview/runs/${runId}/actions`, hint),
    forest.preview('POST', `/api/preview/runs/${runId}/actions`, answer),
  ]);
  expect(
    responses.map((response) => response.status()).sort((a, b) => a - b),
  ).toEqual([200, 409]);
  for (const response of responses) noStore(response);
  const conflict = responses.find((response) => response.status() === 409);
  expect(conflict).toBeTruthy();
  await expectError(conflict!, 409, 'STALE_REVISION');

  const saved = (await forest.getRun(runId)).body;
  expect(saved.revision).toBe(current.revision + 1);
  expect(
    saved.events.filter((event) =>
      ['concurrent-hint', 'concurrent-answer'].includes(event.eventId),
    ),
  ).toHaveLength(1);
});

test('[S1-AC-017][I-05] persists feedback and keeps synthetic decision history tied to a build', async ({
  forest,
}) => {
  const { body: created } = await forest.createRun();
  const runId = created.runId;
  const feedback = {
    feedbackId: 'feedback-i05',
    stepId: 'learn',
    category: 'clarity',
    text: 'The reminder was clear in this synthetic review.',
    source: 'reviewer',
  };
  const savedFeedback = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/feedback`,
    feedback,
  );
  expect(savedFeedback.status()).toBe(201);
  noStore(savedFeedback);
  expect((await json<Record<string, unknown>>(savedFeedback)).feedbackId).toBe(
    feedback.feedbackId,
  );

  const replayFeedback = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/feedback`,
    feedback,
  );
  expect([200, 201]).toContain(replayFeedback.status());
  noStore(replayFeedback);
  const conflictingFeedback = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/feedback`,
    {
      ...feedback,
      text: 'Changed reuse must conflict.',
    },
  );
  await expectError(conflictingFeedback, 409, 'EVENT_CONFLICT');

  const identityResponse = await forest.control('GET', '/api/test/identity');
  const identity = await json<{ candidateId: string }>(identityResponse);
  const decisionPath = `/api/preview/lessons/${LESSON_VERSION}/decision`;
  const initialDecision = await forest.preview('GET', decisionPath);
  expect(initialDecision.status()).toBe(200);
  noStore(initialDecision);
  expect((await json<{ status: string }>(initialDecision)).status).toBe(
    'draft',
  );

  for (const status of ['changes-requested', 'approved'] as const) {
    const decision = await forest.preview('POST', decisionPath, {
      status,
      reviewerLabel: 'synthetic-tester',
      notes: `Synthetic ${status} for I-05`,
      candidateId: identity.candidateId,
    });
    expect([200, 201]).toContain(decision.status());
    noStore(decision);
  }
  const currentDecision = await forest.preview('GET', decisionPath);
  expect(currentDecision.status()).toBe(200);
  noStore(currentDecision);
  const decisionBody = await json<{ status: string; history: unknown[] }>(
    currentDecision,
  );
  expect(decisionBody.status).toBe('approved');
  expect(decisionBody.history.length).toBeGreaterThanOrEqual(2);

  const wrongBuild = await forest.preview('POST', decisionPath, {
    status: 'approved',
    reviewerLabel: 'synthetic-tester',
    notes: 'Wrong candidate must not approve the running build.',
    candidateId: 'candidate-does-not-match',
  });
  expect([400, 403, 409]).toContain(wrongBuild.status());
  noStore(wrongBuild);
});

test('[S1-AC-011][I-06] resets only the selected synthetic run', async ({
  forest,
}) => {
  const { body: fixture } = await forest.fixture('legacy-and-two-runs');
  expect(fixture.runIds).toHaveLength(2);
  expect(fixture.legacyProfile).toEqual(expect.any(String));
  const [selectedRun, untouchedRun] = fixture.runIds;
  const untouchedBefore = (await forest.getRun(untouchedRun)).body;
  const legacyBefore = await forest.preview(
    'GET',
    `/api/state?profile=${encodeURIComponent(fixture.legacyProfile!)}`,
  );
  expect(legacyBefore.status()).toBe(200);
  noStore(legacyBefore);
  const legacyBody = await json(legacyBefore);

  const selectedBefore = (await forest.getRun(selectedRun)).body;
  await forest.action(selectedRun, 'hint', {
    questionId: selectedBefore.state.questionId ?? 'check-lin-sound',
  });
  await forest.resetRun(selectedRun);
  const selectedAfterReset = await forest.preview(
    'GET',
    `/api/preview/runs/${selectedRun}`,
  );
  await expectError(selectedAfterReset, 404, 'NOT_FOUND');

  const untouchedAfter = (await forest.getRun(untouchedRun)).body;
  expect(untouchedAfter).toEqual(untouchedBefore);
  const legacyAfter = await forest.preview(
    'GET',
    `/api/state?profile=${encodeURIComponent(fixture.legacyProfile!)}`,
  );
  expect(legacyAfter.status()).toBe(200);
  noStore(legacyAfter);
  expect(await json(legacyAfter)).toEqual(legacyBody);
});

test('[S1-AC-010][I-07] restarts the owned Worker and reads the same D1 state', async ({
  forest,
}) => {
  const restartURL = process.env.HANZI_CONTROL_URL;
  if (!restartURL)
    throw new Error(
      'BLOCKED: lead runner must provide HANZI_CONTROL_URL for owned-process restart',
    );
  const { body: fixture } = await forest.fixture('in-progress');
  const runId = fixture.runIds[0];
  const before = (await forest.getRun(runId)).body;
  await forest.action(runId, 'hint', {
    questionId: before.state.questionId ?? 'check-lin-sound',
  });
  const saved = (await forest.getRun(runId)).body;

  const response = await fetch(`${restartURL.replace(/\/$/, '')}/restart`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      [TEST_TOKEN_HEADER]: process.env.HANZI_TEST_TOKEN!,
    },
  });
  expect(response.status).toBe(200);
  const after = (await forest.getRun(runId)).body;
  expect(after.state).toEqual(saved.state);
  expect(after.events).toEqual(saved.events);
});

test('[S1-AC-015][I-08] returns 503 for an injected D1 failure without advancing state', async ({
  forest,
}) => {
  if (!process.env.HANZI_TEST_FAULTS)
    throw new Error(
      'BLOCKED: lead runner must expose HANZI_TEST_FAULTS for I-08',
    );
  const { body: fixture } = await forest.fixture('in-progress');
  const runId = fixture.runIds[0];
  const current = (await forest.getRun(runId)).body;
  const questionId = current.state.questionId ?? 'check-lin-sound';
  const request: ActionRequest = {
    eventId: 'storage-fault-answer',
    expectedRevision: current.revision,
    stepId: current.state.stepId,
    type: 'answer',
    payload: {
      questionId,
      choiceId:
        CORRECT_CHOICES[questionId as keyof typeof CORRECT_CHOICES] ?? 'lin',
    },
  };

  let faultEnabled = false;
  try {
    const enabled = await forest.control('POST', '/api/test/fault', {
      operation: 'storage',
      enabled: true,
    });
    expect(enabled.status()).toBe(200);
    faultEnabled = true;
    const failed = await forest.preview(
      'POST',
      `/api/preview/runs/${runId}/actions`,
      request,
    );
    await expectError(failed, 503, 'STORAGE_UNAVAILABLE');
    const disabled = await forest.control('POST', '/api/test/fault', {
      operation: 'storage',
      enabled: false,
    });
    expect(disabled.status()).toBe(200);
    faultEnabled = false;
    const unchanged = (await forest.getRun(runId)).body;
    expect(unchanged.revision).toBe(current.revision);
    expect(unchanged.events).toEqual(current.events);
  } finally {
    if (faultEnabled) {
      const disabled = await forest.control('POST', '/api/test/fault', {
        operation: 'storage',
        enabled: false,
      });
      expect(disabled.status()).toBe(200);
    }
  }
  const retried = await forest.actionAt(runId, request);
  expect(retried.body.eventId).toBe(request.eventId);
});

test('[S1-AC-018][I-09] gates delayed review at the due time and keeps clock scope per run', async ({
  forest,
}) => {
  const { body: beforeFixture } = await forest.fixture('completed-not-due');
  const runId = beforeFixture.runIds[0];
  const before = (await forest.getRun(runId)).body;
  const { body: otherFixture } = await forest.fixture('completed-not-due');
  const otherRunId = otherFixture.runIds[0];
  const otherBefore = (await forest.getRun(otherRunId)).body;
  const due =
    before.reviewAvailableAt ??
    new Date(Date.parse(INITIAL_TIME) + DAY_MS).toISOString();
  const earlyRequest: ActionRequest = {
    eventId: 'early-review-attempt',
    expectedRevision: before.revision,
    stepId: before.state.stepId,
    type: 'start-review',
    payload: {},
  };
  const early = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/actions`,
    earlyRequest,
  );
  await expectError(early, 409, 'REVIEW_NOT_DUE');

  await forest.setClock(runId, due);
  const startRequest: ActionRequest = {
    ...earlyRequest,
    eventId: 'due-review-start',
  };
  const started = await forest.actionAt(runId, startRequest);
  expect(started.body.state.phase).toBe('delayed');
  const replay = await forest.preview(
    'POST',
    `/api/preview/runs/${runId}/actions`,
    startRequest,
  );
  expect(replay.status()).toBe(200);
  noStore(replay);
  expect(await json(replay)).toEqual(started.body);

  await forest.finishQuestion(runId, 'review-mu-sound');
  await forest.finishQuestion(runId, 'review-lin-sound');
  const completed = (await forest.getRun(runId)).body;
  expect(completed.recap.delayed).toMatchObject({
    total: 2,
    independentCorrect: 2,
    supported: 0,
    unavailable: 0,
    pending: 0,
  });

  const otherAfter = (await forest.getRun(otherRunId)).body;
  expect(otherBefore.reviewAvailableAt).not.toBeNull();
  expect(otherAfter).toEqual(otherBefore);
});

test('[S1-AC-019][I-10] fails closed for test controls outside test mode or without the token', async ({
  forest,
}) => {
  const ordinaryBaseURL = process.env.HANZI_ORDINARY_BASE_URL;
  if (!ordinaryBaseURL)
    throw new Error(
      'BLOCKED: lead runner must provide HANZI_ORDINARY_BASE_URL for I-10',
    );
  const mutationRequests: Array<{
    method: string;
    path: string;
    data?: Record<string, unknown>;
  }> = [
    {
      method: 'POST',
      path: '/api/test/fixtures',
      data: { scenario: 'new-reader', seed: SEED },
    },
    {
      method: 'POST',
      path: '/api/test/runs/foreign-run-id/clock',
      data: { effectiveTime: INITIAL_TIME },
    },
    { method: 'DELETE', path: '/api/test/runs/foreign-run-id' },
    {
      method: 'POST',
      path: '/api/test/fault',
      data: { operation: 'storage', enabled: true },
    },
  ];

  const missingIdentity = await forest.raw('GET', '/api/test/identity');
  await expectError(missingIdentity, 403, 'FORBIDDEN');
  const wrongIdentity = await forest.control(
    'GET',
    '/api/test/identity',
    undefined,
    'wrong-test-token',
  );
  await expectError(wrongIdentity, 403, 'FORBIDDEN');

  for (const mutation of mutationRequests) {
    const missing = await forest.raw(
      mutation.method,
      mutation.path,
      mutation.data,
    );
    await expectError(missing, 403, 'FORBIDDEN');
    const wrong = await forest.control(
      mutation.method,
      mutation.path,
      mutation.data,
      'wrong-test-token',
    );
    await expectError(wrong, 403, 'FORBIDDEN');
  }

  const foreignReset = await forest.control(
    'DELETE',
    '/api/test/runs/foreign-run-id',
  );
  await expectError(foreignReset, 403, 'FORBIDDEN');

  const ordinary = await requestFactory.newContext({
    baseURL: ordinaryBaseURL,
  });
  try {
    const identity = await ordinary.get('/api/test/identity', {
      headers: { accept: 'application/json' },
    });
    expect(identity.status()).toBe(404);
    noStore(identity);
    const desk = await ordinary.get('/preview/test');
    expect(desk.status()).toBe(404);
    for (const mutation of mutationRequests) {
      const response = await ordinary.fetch(mutation.path, {
        method: mutation.method,
        data: mutation.data,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
      });
      expect(response.status()).toBe(404);
      noStore(response);
    }
  } finally {
    await ordinary.dispose();
  }
});

test('[S1-AC-011][S1-AC-020][I-11] runs the existing legacy smoke against the owned candidate', async ({
  forest,
}, testInfo) => {
  const { body: fixture } = await forest.fixture('legacy-and-two-runs');
  const before = await forest.preview(
    'GET',
    `/api/state?profile=${encodeURIComponent(fixture.legacyProfile!)}`,
  );
  expect(before.status()).toBe(200);
  noStore(before);
  const beforeBody = await json(before);
  const baseURL = testInfo.project.use.baseURL ?? process.env.HANZI_BASE_URL;
  expect(baseURL).toBeTruthy();
  const script =
    process.env.HANZI_SMOKE_SCRIPT ??
    resolve(process.cwd(), 'tests/lan_smoke.py');
  const result = await execFileAsync(
    process.env.PYTHON ?? 'python3',
    [script],
    {
      cwd: process.cwd(),
      timeout: 60_000,
      env: {
        ...process.env,
        HANZI_BASE_URL: baseURL,
        HANZI_REQUIRE_RESTART_PROBE: '0',
      },
    },
  );
  expect(result.stdout).toContain('"result": "passed"');
  const after = await forest.preview(
    'GET',
    `/api/state?profile=${encodeURIComponent(fixture.legacyProfile!)}`,
  );
  expect(after.status()).toBe(200);
  noStore(after);
  expect(await json(after)).toEqual(beforeBody);
});

test('[S1-AC-004][S1-AC-007][S1-AC-016][I-12] reports independent, supported and unavailable evidence separately', async ({
  forest,
}) => {
  const { body: fixture } = await forest.fixture('needs-help');
  const runId = fixture.runIds[0];
  const saved = (await forest.getRun(runId)).body;

  expect(saved.recap.familiarity).toMatchObject({
    total: 2,
    independentCorrect: 0,
    supported: 2,
    unavailable: 0,
    pending: 0,
  });
  expect(saved.recap.final).toMatchObject({
    total: 4,
    independentCorrect: 1,
    supported: 2,
    unavailable: 1,
    pending: 0,
  });
  const firstFinal = saved.events.filter(
    (event) => event.questionId === 'check-mu-sound',
  );
  expect(firstFinal.filter((event) => event.type === 'answer')).toHaveLength(2);
  expect(firstFinal.map(eventOutcome)).toEqual(
    expect.arrayContaining(['incorrect', 'demonstrated']),
  );
  const hinted = saved.events.filter(
    (event) => event.questionId === 'check-mu-reading',
  );
  expect(hinted.some((event) => event.type === 'hint')).toBe(true);
  expect(hinted.some((event) => event.assisted === true)).toBe(true);
  const unavailable = saved.events.filter(
    (event) => event.questionId === 'check-lin-reading',
  );
  expect(
    unavailable.some((event) => eventOutcome(event) === 'unavailable'),
  ).toBe(true);
  expect(JSON.stringify(saved.recap).toLowerCase()).not.toContain('mastery');
});
