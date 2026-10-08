import {
  CORRECT_CHOICES,
  INITIAL_TIME,
  TEST_TOKEN_HEADER,
  expect,
  forestTest as test,
} from '../helpers/forest-contract';
import type { Page } from '@playwright/test';
import {
  answerChoice,
  answerFamiliarity,
  advanceUntil,
  completeBuildByDrag,
  completeBuildByKeyboard,
  completeBuildByTap,
  completeNewReader,
  continueLesson,
  finishOrdinaryRead,
  installSpeechStub,
  openForestRun,
  playRequiredAudio,
  question,
  speechCalls,
  startLesson,
  step,
} from '../helpers/forest-ui';

const DAY_MS = 24 * 60 * 60 * 1000;

test('[S1-AC-002][S1-AC-006][S1-AC-022][E-01] completes the unfamiliar learner journey with a scripted tutor', async ({
  page,
  forest,
}) => {
  await installSpeechStub(page);
  const { body: created } = await forest.createRun();
  const runId = created.runId;
  const productRequests: string[] = [];
  page.on('request', (request) => productRequests.push(request.url()));

  await openForestRun(page, runId);
  await completeNewReader(page, created.seed);
  expect(
    productRequests.some((url) =>
      /openai|chat\/completions|microphone|mediaDevices/i.test(url),
    ),
  ).toBe(false);
  const calls = await speechCalls(page);
  expect(calls.some((call) => /木|林|木头|树林/.test(call.text))).toBe(true);

  await page.goto(
    `/preview/forest-01/review?runId=${encodeURIComponent(runId)}`,
  );
  await expect(page.getByText(/scripted/i)).toBeVisible();
  await expect(page.getByText(/木|林/).first()).toBeVisible();
});

for (const mode of ['familiar-reader', 'mixed-reader'] as const) {
  test(`[S1-AC-003][E-02] ${mode} route keeps the tutor branch explicit`, async ({
    page,
    forest,
  }) => {
    await installSpeechStub(page);
    const { body: created } = await forest.createRun();
    await openForestRun(page, created.runId);
    await startLesson(page);
    await answerFamiliarity(page, mode);
    if (mode === 'familiar-reader')
      await expect(
        page.getByText(/reminder|remember|quick review/i),
      ).toBeVisible();
    else
      await expect(
        page.getByText(/look a little closer|meet .* new way|guide is here/i),
      ).toBeVisible();
    await expect(
      page.getByText(/mastery|you know this forever|perfect score/i),
    ).toHaveCount(0);
  });
}

test('[S1-AC-004][E-03] exposes the reviewed clue and demonstration after repeated errors', async ({
  page,
  forest,
}) => {
  await installSpeechStub(page);
  const { body: created } = await forest.createRun();
  await openForestRun(page, created.runId);
  await startLesson(page);
  await answerFamiliarity(page, 'new-reader');
  await advanceUntil(page, 'build');
  await completeBuildByTap(page);
  await continueLesson(page);
  await answerChoice(page, 'find-mu', 'mu');
  await continueLesson(page);
  await answerChoice(page, 'find-lin', 'lin');
  await continueLesson(page);
  await finishOrdinaryRead(page);

  await answerChoice(page, 'check-mu-sound', 'lin');
  await expect(page.getByText(/clue|look again|wood/i)).toBeVisible();
  await answerChoice(page, 'check-mu-sound', 'ren');
  await expect(
    page.getByText(/demonstrat|let's do it together|supported/i),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /continue|next|done/i }).first(),
  ).toBeVisible();
});

test('[S1-AC-005][S1-AC-009][E-04] completes the component game by drag, touch and keyboard across orientations', async ({
  page,
  forest,
}) => {
  const first = await forest.createRun();
  await installSpeechStub(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openForestRun(page, first.body.runId);
  await startLesson(page);
  await answerFamiliarity(page, 'familiar-reader');
  await advanceUntil(page, 'build');
  await completeBuildByDrag(page);
  await expect(page.getByText('林', { exact: true })).toBeVisible();

  const second = await forest.createRun();
  await page.setViewportSize({ width: 820, height: 1180 });
  await openForestRun(page, second.body.runId);
  await startLesson(page);
  await answerFamiliarity(page, 'familiar-reader');
  await advanceUntil(page, 'build');
  await completeBuildByTap(page);

  const third = await forest.createRun();
  await page.setViewportSize({ width: 1180, height: 820 });
  await openForestRun(page, third.body.runId);
  await startLesson(page);
  await answerFamiliarity(page, 'familiar-reader');
  await advanceUntil(page, 'build');
  await completeBuildByKeyboard(page);
  await expect(page.locator('[data-component-slot="right"]')).toBeFocused();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(
    page.getByRole('button', { name: /continue|next/i }).first(),
  ).toBeVisible();
  const essentialControls = page.getByRole('button');
  const count = await essentialControls.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < Math.min(count, 10); i += 1) {
    const box = await essentialControls.nth(i).boundingBox();
    if (box) expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test('[S1-AC-010][E-05] reloads and resumes an explicit run in a fresh browser context', async ({
  page,
  browser,
  forest,
}, testInfo) => {
  await installSpeechStub(page);
  const { body: fixture } = await forest.fixture('in-progress');
  const runId = fixture.runIds[0];
  await openForestRun(page, runId);
  await page.reload();
  await expect(step(page, 'check')).toBeVisible();
  const saved = (await forest.getRun(runId)).body;
  expect(saved.events.length).toBeGreaterThan(0);

  const baseURL = testInfo.project.use.baseURL;
  const context = await browser.newContext({ baseURL });
  const fresh = await context.newPage();
  try {
    await installSpeechStub(fresh);
    await openForestRun(fresh, runId);
    await expect(
      fresh.locator(`[data-step-id="${saved.state.stepId}"]`),
    ).toBeVisible();
    const after = (await forest.getRun(runId)).body;
    expect(after.events).toHaveLength(saved.events.length);
  } finally {
    await context.close();
  }
});

test('[S1-AC-007][S1-AC-016][E-06] shows mixed recap evidence without written pinyin in assisted print-to-audio checks', async ({
  page,
  forest,
}) => {
  await installSpeechStub(page);
  const { body: created } = await forest.createRun();
  const runId = created.runId;
  await openForestRun(page, runId);
  await startLesson(page);
  await answerFamiliarity(page, 'new-reader');
  await advanceUntil(page, 'build');
  await completeBuildByTap(page);
  await continueLesson(page);
  await answerChoice(page, 'find-mu', 'mu');
  await continueLesson(page);
  await answerChoice(page, 'find-lin', 'lin');
  await continueLesson(page);
  await finishOrdinaryRead(page);
  await answerChoice(page, 'check-mu-sound', 'lin');
  await answerChoice(page, 'check-mu-sound', 'ren');
  await continueLesson(page);
  await answerChoice(page, 'check-lin-sound', 'lin');
  await continueLesson(page);
  await answerChoice(page, 'check-mu-reading', 'audio-lin', created.seed);
  await answerChoice(page, 'check-mu-reading', 'audio-ren', created.seed);
  const assistedReading = question(page, 'check-mu-reading');
  await expect(assistedReading.getByText(/look together/i)).toBeVisible();
  await expect(assistedReading).not.toContainText(/mù|lín|rén|dà/);
  await continueLesson(page);
  await playRequiredAudio(page, 'check-lin-reading');
  await expect(
    page.getByRole('button', { name: /unavailable|continue without audio/i }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /unavailable|continue without audio/i })
    .click();
  await continueLesson(page);
  for (let i = 0; i < 8; i += 1) {
    if (await page.getByText(/saved|complete|finished/i).count()) break;
    await continueLesson(page);
  }
  await page.goto(
    `/preview/forest-01/review?runId=${encodeURIComponent(runId)}`,
  );
  await expect(page.getByText(/independent.*1|1.*independent/i)).toBeVisible();
  await expect(page.getByText(/supported.*2|2.*supported/i)).toBeVisible();
  await expect(page.getByText(/unavailable.*1|1.*unavailable/i)).toBeVisible();
  await expect(page.getByText(/mastery|diagnosis|permanent/i)).toHaveCount(0);
});

test('[S1-AC-008][E-07] gates sound tasks, supports replay/mute and continues on speech failure or missing voice', async ({
  page,
  browser,
  forest,
}, testInfo) => {
  await installSpeechStub(page, 'success');
  const success = await forest.createRun();
  await openForestRun(page, success.body.runId);
  await startLesson(page);
  await answerFamiliarity(page, 'familiar-reader');
  await advanceUntil(page, 'check');
  await answerChoice(page, 'check-mu-sound', 'mu', success.body.seed);
  const replay = page.getByRole('button', {
    name: /replay sound|play question sound/i,
  });
  await expect(replay).toBeVisible();
  await replay.click();
  await page.getByRole('button', { name: /mute/i }).click();
  await replay.click();
  await expect(page.getByText(/muted/i)).toBeVisible();
  await page.getByRole('button', { name: /unmute/i }).click();
  await continueLesson(page);
  await answerChoice(page, 'check-lin-sound', 'lin', success.body.seed);
  await continueLesson(page);
  await playRequiredAudio(page, 'check-mu-reading');
  await answerChoice(page, 'check-mu-reading', 'audio-mu', success.body.seed);

  const failureContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const failurePage = await failureContext.newPage();
  try {
    await installSpeechStub(failurePage, 'failure');
    const { body: failureFixture } = await forest.fixture('in-progress');
    await openForestRun(failurePage, failureFixture.runIds[0]);
    await playRequiredAudio(failurePage, 'check-lin-sound');
    await expect(
      failurePage.getByText(/unavailable|try again|continue without audio/i),
    ).toBeVisible();
    await failurePage
      .getByRole('button', { name: /sound unavailable/i })
      .click();
    await expect(
      failurePage.getByRole('button', { name: /continue/i }).first(),
    ).toBeVisible();
  } finally {
    await failureContext.close();
  }

  const noVoiceContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const noVoicePage = await noVoiceContext.newPage();
  try {
    await installSpeechStub(noVoicePage, 'no-voice');
    const { body: noVoiceFixture } = await forest.fixture('in-progress');
    await openForestRun(noVoicePage, noVoiceFixture.runIds[0]);
    await playRequiredAudio(noVoicePage, 'check-lin-sound');
    await expect(
      noVoicePage.getByText(/no Mandarin voice|sound unavailable/i),
    ).toBeVisible();
    await noVoicePage
      .getByRole('button', { name: /sound unavailable/i })
      .click();
    await expect(
      noVoicePage.getByRole('button', { name: /continue/i }).first(),
    ).toBeVisible();
  } finally {
    await noVoiceContext.close();
  }
});

test('[S1-AC-011][S1-AC-019][E-08] scopes run recovery and reset to the selected synthetic run', async ({
  page,
  browser,
  forest,
}, testInfo) => {
  const testToken = process.env.HANZI_TEST_TOKEN;
  if (!testToken)
    throw new Error('BLOCKED: HANZI_TEST_TOKEN is required for E-08 test desk');
  await installSpeechStub(page);
  const { body: fixture } = await forest.fixture('legacy-and-two-runs');
  const [firstRun, secondRun] = fixture.runIds;
  const firstBefore = (await forest.getRun(firstRun)).body;
  const secondBefore = (await forest.getRun(secondRun)).body;
  await openForestRun(page, firstRun);
  await expect(page.locator(`[data-run-id="${firstRun}"]`)).toBeVisible();
  await openForestRun(page, secondRun);
  await expect(page.locator(`[data-run-id="${secondRun}"]`)).toBeVisible();

  const noStorageContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const noStoragePage = await noStorageContext.newPage();
  try {
    await noStoragePage.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: false,
        get: () => {
          throw new DOMException('Storage disabled', 'SecurityError');
        },
      });
    });
    await installSpeechStub(noStoragePage);
    await expectNoImplicitRunSelection(noStoragePage, [firstRun, secondRun]);
    await expect(
      noStoragePage.getByText(
        /browser storage|recovery.*unavailable|cannot recover/i,
      ),
    ).toBeVisible();
  } finally {
    await noStorageContext.close();
  }

  const deskContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    extraHTTPHeaders: { [TEST_TOKEN_HEADER]: testToken },
  });
  let deskRunId: string | undefined;
  try {
    const deskPage = await deskContext.newPage();
    await deskPage.goto('/preview/test');
    await expect(
      deskPage.getByRole('heading', { name: /preview test desk/i }),
    ).toBeVisible();
    await expect(deskPage.getByText(/test controls unlocked/i)).toBeVisible();

    const fixtureResponse = deskPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/test/fixtures'),
    );
    await deskPage.getByRole('button', { name: /create fixture/i }).click();
    const createdResponse = await fixtureResponse;
    expect(createdResponse.status()).toBe(201);
    const createdBody = (await createdResponse.json()) as {
      runIds?: unknown;
    };
    if (
      !Array.isArray(createdBody.runIds) ||
      typeof createdBody.runIds[0] !== 'string'
    )
      throw new Error('E-08 fixture desk response did not include a run ID');
    deskRunId = createdBody.runIds[0];
    forest.createdRuns.add(deskRunId);

    const deskRow = deskPage
      .locator('[class*="testRunItem"]')
      .filter({ hasText: deskRunId });
    await expect(deskRow).toBeVisible();
    await expect(deskPage.getByText(/created 1 synthetic run/i)).toBeVisible();
    expect((await forest.getRun(deskRunId)).body.runId).toBe(deskRunId);

    const resetResponse = deskPage.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response
          .url()
          .endsWith(`/api/test/runs/${encodeURIComponent(deskRunId!)}`),
    );
    await deskRow.getByRole('button', { name: /reset/i }).click();
    const reset = await resetResponse;
    expect([200, 204]).toContain(reset.status());
    await expect(
      deskPage.locator('[class*="testRunItem"]').filter({ hasText: deskRunId }),
    ).toHaveCount(0);
    await expect(
      deskPage.getByText(/selected synthetic run reset/i),
    ).toBeVisible();
  } finally {
    await deskContext.close();
  }

  const second = (await forest.getRun(secondRun)).body;
  const first = (await forest.getRun(firstRun)).body;
  expect(second).toEqual(secondBefore);
  expect(first).toEqual(firstBefore);
  const firstGone = await forest.preview(
    'GET',
    `/api/preview/runs/${deskRunId}`,
  );
  expect(firstGone.status()).toBe(404);
});

test('[S1-AC-014][E-09] recovers a two-tab revision conflict without losing acknowledged work', async ({
  page,
  browser,
  forest,
}, testInfo) => {
  await installSpeechStub(page);
  const { body: fixture } = await forest.fixture('in-progress');
  const runId = fixture.runIds[0];
  await openForestRun(page, runId);
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const second = await context.newPage();
  try {
    await installSpeechStub(second);
    await openForestRun(second, runId);
    const questionId =
      (await forest.getRun(runId)).body.state.questionId ?? 'check-lin-sound';
    await answerChoice(
      page,
      questionId,
      CORRECT_CHOICES[questionId as keyof typeof CORRECT_CHOICES] ?? 'lin',
    );
    await answerChoice(
      second,
      questionId,
      CORRECT_CHOICES[questionId as keyof typeof CORRECT_CHOICES] ?? 'lin',
      undefined,
      { expectSuccess: false },
    );
    await expect(
      second.getByText(/updated|refresh|another tab|conflict|already saved/i),
    ).toBeVisible();
    const saved = (await forest.getRun(runId)).body;
    expect(saved.events.length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('[S1-AC-015][E-10] exposes pending recovery when saving is interrupted and reports storage limits', async ({
  page,
  browser,
  forest,
}, testInfo) => {
  await installSpeechStub(page);
  const { body: fixture } = await forest.fixture('in-progress');
  const runId = fixture.runIds[0];
  await openForestRun(page, runId);
  let interrupted = true;
  await page.route('**/api/preview/runs/*/actions', async (route) => {
    if (interrupted) {
      interrupted = false;
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  const questionId =
    (await forest.getRun(runId)).body.state.questionId ?? 'check-lin-sound';
  await playRequiredAudio(page, questionId);
  const failedAction = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      request.method() === 'POST' &&
      /\/api\/preview\/runs\/[^/]+\/actions$/.test(request.url()),
  });
  const choice = question(page, questionId).locator(
    `[data-choice-id="${CORRECT_CHOICES[questionId as keyof typeof CORRECT_CHOICES] ?? 'lin'}"]`,
  );
  await expect(choice).toBeEnabled();
  await choice.click();
  await failedAction;
  await expect(
    page.getByText(/pending|could not save|retry|offline/i),
  ).toBeVisible();
  await page.unroute('**/api/preview/runs/*/actions');
  const beforeRetry = (await forest.getRun(runId)).body;
  const retryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/preview\/runs\/[^/]+\/actions$/.test(response.url()),
  );
  await page.reload();
  expect((await retryResponse).ok()).toBe(true);
  await expect(
    page.locator(`[data-question-id="${questionId}"]`),
  ).toBeVisible();
  const afterRetry = (await forest.getRun(runId)).body;
  expect(afterRetry.events.length).toBe(beforeRetry.events.length + 1);

  const { body: secondFixture } = await forest.fixture('in-progress');
  const secondRunId = secondFixture.runIds[0];
  const noStorageContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const noStoragePage = await noStorageContext.newPage();
  try {
    await noStoragePage.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: false,
        get: () => {
          throw new DOMException('Storage disabled', 'SecurityError');
        },
      });
    });
    await installSpeechStub(noStoragePage);
    await expectNoImplicitRunSelection(noStoragePage, [runId, secondRunId]);
    await expect(
      noStoragePage.getByText(
        /browser storage|recovery.*unavailable|cannot recover/i,
      ),
    ).toBeVisible();
  } finally {
    await noStorageContext.close();
  }
});

test('[S1-AC-017][E-11] records reviewer feedback and keeps synthetic approval version-specific', async ({
  page,
  forest,
}) => {
  const { body: fixture } = await forest.fixture('familiar-reader');
  const runId = fixture.runIds[0];
  await page.goto(
    `/preview/forest-01/review?runId=${encodeURIComponent(runId)}`,
  );
  await expect(page.getByText(/review|evidence/i).first()).toBeVisible();
  const feedback = page.getByRole('textbox', { name: /observation/i });
  await feedback.fill('Synthetic clarity feedback for E-11.');
  await page
    .getByRole('button', { name: /submit feedback|save feedback/i })
    .click();
  await expect(page.getByText(/feedback saved|saved/i)).toBeVisible();
  await page.getByRole('button', { name: /request changes/i }).click();
  await expect(page.getByText(/changes requested/i)).toBeVisible();
  await page.getByRole('button', { name: /approve/i }).click();
  await expect(page.getByText(/synthetic|approved/i)).toBeVisible();

  const decision = await forest.preview(
    'GET',
    '/api/preview/lessons/forest-01-v1/decision',
  );
  expect(decision.status()).toBe(200);
  const wrongBuild = await forest.preview(
    'POST',
    '/api/preview/lessons/forest-01-v1/decision',
    {
      status: 'approved',
      reviewerLabel: 'synthetic-tester',
      notes: 'A different candidate build must not inherit approval.',
      candidateId: 'candidate-from-another-build',
    },
  );
  expect(wrongBuild.status()).toBe(409);
  await page.reload();
  await expect(
    page.getByText(/candidate decision|synthetic approval/i).first(),
  ).toBeVisible();
});

test('[S1-AC-018][E-12] opens only the due delayed review and keeps its evidence separate', async ({
  page,
  forest,
}) => {
  await installSpeechStub(page);
  const { body: fixture } = await forest.fixture('review-due');
  const runId = fixture.runIds[0];
  await forest.setClock(
    runId,
    new Date(Date.parse(INITIAL_TIME) + DAY_MS).toISOString(),
  );
  await openForestRun(page, runId);
  await expect(
    page.getByRole('button', { name: /review|revisit|come back/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: /review|revisit|come back/i }).click();
  await answerChoice(page, 'review-mu-sound', 'mu');
  await continueLesson(page);
  await answerChoice(page, 'review-lin-sound', 'lin');
  await continueLesson(page);
  await expect(page.getByText(/later review|delayed|saved/i)).toBeVisible();
  const saved = (await forest.getRun(runId)).body;
  expect(saved.recap.delayed).toMatchObject({
    total: 2,
    independentCorrect: 2,
  });
  expect(saved.recap.final).toMatchObject({ total: 4 });
});

test('[S1-AC-020][E-13] preserves the existing six-character lesson and parent view', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(
    page.getByText(/今天，认识这些字|开始今天的学习/i).first(),
  ).toBeVisible();
  for (const character of ['一', '二', '三', '大', '小', '人']) {
    await expect(
      page.getByText(character, { exact: true }).first(),
    ).toBeVisible();
  }
  const profile = `qa-e13-${Date.now()}`;
  const response = await request.get(`/api/state?profile=${profile}`);
  expect(response.status()).toBe(200);
  const state = await response.json();
  expect(state.settings).toBeTruthy();
  await page.getByRole('button', { name: /开始今天的学习/i }).click();
  await expect(
    page.getByText(/听发音|手指写字|拼音练习/i).first(),
  ).toBeVisible();
});

test('[S1-AC-023][E-14] captures Clear ascent states and verifies tokens, focus, controls and reduced motion', async ({
  page,
  forest,
}, testInfo) => {
  await installSpeechStub(page);
  const desktop = { name: 'desktop', width: 1280, height: 900 };
  const tablet = { name: 'tablet', width: 820, height: 1180 };
  const { body: created } = await forest.createRun();
  const runId = created.runId;

  for (const viewport of [desktop, tablet]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await openForestRun(page, runId);
    await expect(page.locator('[data-step-id="welcome"]')).toBeVisible();
    await assertForestTokens(page);
    await assertResponsiveViewport(page);
    await assertPrimaryControl(page, /start the lesson/i);
    await capture(page, testInfo, `e14-${viewport.name}-welcome`);
  }

  await page.setViewportSize({ width: tablet.width, height: tablet.height });
  await openForestRun(page, runId);
  await assertFocusRing(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await assertReducedMotion(page);
  await startLesson(page);
  await answerFamiliarity(page, 'familiar-reader');
  await advanceUntil(page, 'build');
  await completeBuildByTap(page);
  await continueLesson(page);
  await answerChoice(page, 'find-mu', 'mu');
  await continueLesson(page);
  await answerChoice(page, 'find-lin', 'lin');
  await continueLesson(page);
  await finishOrdinaryRead(page);
  await expect(step(page, 'check')).toBeVisible();
  await assertResponsiveViewport(page);
  await capture(page, testInfo, 'e14-tablet-check');

  await page.setViewportSize({ width: desktop.width, height: desktop.height });
  await page.reload();
  await expect(step(page, 'check')).toBeVisible();
  await assertForestTokens(page);
  await assertResponsiveViewport(page);
  await capture(page, testInfo, 'e14-desktop-check');

  const { body: reviewFixture } = await forest.fixture('familiar-reader');
  for (const viewport of [desktop, tablet]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto(
      `/preview/forest-01/review?runId=${encodeURIComponent(reviewFixture.runIds[0])}`,
    );
    await expect(
      page.getByRole('heading', { name: /evidence for this run/i }),
    ).toBeVisible();
    await assertForestTokens(page);
    await assertResponsiveViewport(page);
    await capture(page, testInfo, `e14-${viewport.name}-review`);
  }
});

async function expectNoImplicitRunSelection(
  page: Page,
  existingRunIds: string[],
): Promise<void> {
  await page.goto('/preview/forest-01');
  await expect(page.locator('[data-step-id]').first()).toBeVisible();
  const visibleRunIds = await page
    .locator('[data-run-id]')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute('data-run-id'))
        .filter((runId): runId is string => Boolean(runId)),
    );
  expect(visibleRunIds.some((runId) => existingRunIds.includes(runId))).toBe(
    false,
  );
}

async function capture(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  name: string,
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
  });
}

async function assertForestTokens(page: Page): Promise<void> {
  const styles = await page.evaluate(() => {
    const anchor =
      document.querySelector('[data-step-id]') ||
      document.querySelector('main') ||
      document.body;
    const computed = getComputedStyle(anchor);
    return {
      ink: computed.getPropertyValue('--cs-ink').trim(),
      muted: computed.getPropertyValue('--cs-muted').trim(),
      blue: computed.getPropertyValue('--cs-blue').trim(),
      blueHover: computed.getPropertyValue('--cs-blue-hover').trim(),
      teal: computed.getPropertyValue('--cs-teal').trim(),
      apricot: computed.getPropertyValue('--cs-apricot').trim(),
      sky: computed.getPropertyValue('--cs-sky').trim(),
      canvas: computed.getPropertyValue('--cs-canvas').trim(),
      surface: computed.getPropertyValue('--cs-white').trim(),
      line: computed.getPropertyValue('--cs-line').trim(),
      controlLine: computed.getPropertyValue('--cs-control-line').trim(),
      focus: computed.getPropertyValue('--cs-focus').trim(),
      fontFamily: computed.fontFamily,
    };
  });
  expect(styles).toMatchObject({
    ink: '#182c49',
    muted: '#53647b',
    blue: '#245bd6',
    blueHover: '#1945aa',
    teal: '#117c72',
    apricot: '#f4b58a',
    sky: '#eaf2ff',
    canvas: '#f5f7fb',
    surface: '#ffffff',
    line: '#d9e2ef',
    controlLine: '#7e8fa7',
    focus: '#245bd6',
  });
  expect(styles.fontFamily).toContain('Avenir Next');
}

async function assertResponsiveViewport(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
}

async function assertPrimaryControl(page: Page, name: RegExp): Promise<void> {
  const control = page.getByRole('button', { name }).first();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function assertFocusRing(page: Page): Promise<void> {
  const parentLink = page.getByRole('link', {
    name: 'Parent / reviewer',
    exact: true,
  });
  const start = page.getByRole('button', { name: /start the lesson/i }).first();
  await parentLink.focus();
  await page.keyboard.press('Tab');
  const focus = await start.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      active: document.activeElement === element,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
    };
  });
  expect(focus.active).toBe(true);
  expect(focus.outlineStyle).toBe('solid');
  expect(focus.outlineWidth).toBe('3px');
  expect(focus.outlineColor).toBe('rgb(36, 91, 214)');
}

async function assertReducedMotion(page: Page): Promise<void> {
  const transition = await page
    .getByRole('button', { name: /start the lesson/i })
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  const seconds = Number.parseFloat(transition);
  expect(seconds).toBeLessThanOrEqual(0.01);
}
