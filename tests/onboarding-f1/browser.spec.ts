import {
  chromium,
  expect,
  test as base,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { connectOwnedChrome } from '../../scripts/owned-cdp.mjs';

import {
  account,
  installSpeechBoundary,
  loadHandoff,
  speechCalls,
  type F1Account,
  type F1Handoff,
} from './support';
import { ANSWERS, CLEAN_FINAL, ROUTES } from '../readiness-r3/oracle.mjs';

type F1Fixtures = {
  f1Context: BrowserContext;
  f1Page: Page;
};
type F1WorkerFixtures = { f1Browser: Browser };

const test = base.extend<F1Fixtures, F1WorkerFixtures>({
  f1Browser: [
    async ({ browserName }, provide, workerInfo) => {
      void browserName;
      const endpoint = process.env.HANZI_F1_CDP;
      if (endpoint) {
        if (workerInfo.project.name === 'webkit')
          throw new Error(
            'HANZI_F1_CDP uses authorized Chromium; run only --project=chromium',
          );
        const connection = await connectOwnedChrome(endpoint);
        try {
          await provide(connection.browser);
        } finally {
          connection.disconnect();
        }
        return;
      }
      const browserType =
        workerInfo.project.name === 'webkit' ? webkit : chromium;
      const browser = await browserType.launch();
      try {
        await provide(browser);
      } finally {
        await browser.close();
      }
    },
    { scope: 'worker' },
  ],
  f1Context: async ({ f1Browser }, provide, testInfo) => {
    const tablet = testInfo.project.name === 'webkit';
    const context = await f1Browser.newContext({
      viewport: tablet
        ? { width: 820, height: 1180 }
        : { width: 1280, height: 900 },
      hasTouch: tablet,
      isMobile: tablet,
    });
    try {
      await provide(context);
    } finally {
      await context.close();
    }
  },
  f1Page: async ({ f1Context }, provide) => {
    const page = await f1Context.newPage();
    await provide(page);
  },
});

test.describe.configure({ mode: 'serial' });

let handoff: F1Handoff;

test.beforeAll(() => {
  handoff = loadHandoff();
});

function pair(testInfo: TestInfo): { parent: F1Account; child: F1Account } {
  return testInfo.project.name === 'webkit'
    ? {
        parent: account(handoff, 'parent-b'),
        child: account(handoff, 'child-b'),
      }
    : {
        parent: account(handoff, 'parent-a'),
        child: account(handoff, 'child-a2'),
      };
}

async function visibleAmong(
  page: Page,
  candidates: Locator[],
  label: string,
): Promise<Locator> {
  for (const candidate of candidates) {
    if ((await candidate.count()) && (await candidate.first().isVisible()))
      return candidate.first();
  }
  throw new Error(`F1 browser control is missing: ${label}`);
}

function routeURL(path: string): string {
  return new URL(path, handoff.baseURL).toString();
}

type EvidenceCounts = Record<
  'independent' | 'supported' | 'unavailable' | 'pending',
  string
>;

async function evidenceCounts(
  root: { locator(selector: string): Locator },
  groupSelector: string,
): Promise<EvidenceCounts> {
  const group = root.locator(groupSelector);
  const categories = [
    'independent',
    'supported',
    'unavailable',
    'pending',
  ] as const;
  return Object.fromEntries(
    await Promise.all(
      categories.map(async (category) => [
        category,
        (await group.locator(`[data-category="${category}"]`).innerText()).trim(),
      ]),
    ),
  ) as EvidenceCounts;
}

async function signInUI(page: Page, selected: F1Account): Promise<void> {
  await page.goto(routeURL('/pilot/first-story'));
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(selected.username);
  await page.getByLabel('Password', { exact: true }).fill(selected.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.locator('nav[aria-label="Pilot navigation"]')).toBeVisible();
  await expect(page).toHaveURL(/\/pilot\/first-story/);
}

async function selectParentChild(page: Page, child: F1Account): Promise<void> {
  const storyChild = page.locator('[data-control="story-child"]');
  await expect(storyChild).toBeVisible();
  await storyChild.selectOption({ label: child.name });
  await expect(
    page.locator('[data-role="parent-story-plan"] [data-child-id]').first(),
  ).toHaveAttribute('data-child-id', child.id);

  const progressChild = page.locator('[data-control="progress-child"]');
  await expect(progressChild).toBeVisible();
  await progressChild.selectOption({ label: child.name });
  await expect(
    page.locator('[data-role="ordinary-story-progress"] [data-child-id]').first(),
  ).toHaveAttribute('data-child-id', child.id);
}

function actionResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/pilot\/curriculum\/(?:assignments\/[^/]+\/start|learning-runs\/[^/]+\/actions)$/.test(
        response.url(),
      ),
  );
}

async function clickSavedAction(page: Page, control: Locator): Promise<void> {
  const responsePromise = actionResponse(page);
  await control.click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
}

async function answerQuestion(
  page: Page,
  questionId: string,
  choiceId: string,
): Promise<void> {
  const question = page.locator(`[data-question-id="${questionId}"]`);
  await expect(question).toBeVisible();
  if (choiceId.startsWith('audio-')) {
    await question
      .locator(`[data-control="option-play"][data-option-id="${choiceId}"]`)
      .click();
  } else if (!questionId.startsWith('find-')) {
    await question.locator('[data-control="cue"]').click();
  }
  const choice = question.locator(`[data-choice-id="${choiceId}"]`);
  await expect(choice).toBeEnabled();
  await clickSavedAction(page, choice);
}

async function setupAndApprove(
  page: Page,
  child: F1Account,
  testInfo: TestInfo,
): Promise<void> {
  const nickname = page.locator('[data-control="story-nickname"]');
  await expect(nickname).toHaveValue(child.name);
  const experience = page.locator('[data-control="story-experience"]');
  await expect(experience).toHaveValue('unsure');

  const saveRequests: string[] = [];
  const requestListener = (request: { method(): string; url(): string }) => {
    if (
      request.method() === 'PUT' &&
      /\/api\/pilot\/children\/[^/]+\/onboarding$/.test(request.url())
    )
      saveRequests.push(request.url());
  };
  page.on('request', requestListener);
  const play = await visibleAmong(
    page,
    [
      page.locator('[data-control="sound-check"]'),
      page.getByRole('button', { name: /play.*(?:Mandarin )?sound|sound check|try the sound/i }),
      page.getByRole('button', { name: /listen.*sample|play.*sample/i }),
    ],
    'parent sound check',
  );
  const heard = await visibleAmong(
    page,
    [
      page.getByRole('button', { name: /I heard|heard it|sound is working/i }),
    ],
    'parent heard confirmation',
  );
  await expect(heard).toBeDisabled();
  await play.click();
  await expect(heard).toBeEnabled();
  const calls = await speechCalls(page);
  expect(calls.some((call) => call.lang === 'zh-CN' && call.text.length > 0)).toBe(true);
  expect(saveRequests).toHaveLength(0);
  await heard.click();
  expect(saveRequests).toHaveLength(0);

  const save = page.locator('[data-control="save-setup"]');
  await expect(save).toBeEnabled();
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      /\/api\/pilot\/children\/[^/]+\/onboarding$/.test(response.url()),
  );
  await save.click();
  expect((await saveResponse).status()).toBe(200);
  await expect(page.locator('[data-plan-save-state="saved"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('parent-setup-saved.png'),
    fullPage: true,
  });
  page.off('request', requestListener);

  const proposal = page.locator('[data-control="request-proposal"]');
  await expect(proposal).toBeEnabled();
  const proposalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/pilot\/children\/[^/]+\/placement\/proposals$/.test(response.url()),
  );
  await proposal.click();
  expect((await proposalResponse).status()).toBe(200);
  const approve = page.locator('[data-control="approve-plan"]');
  await expect(approve).toBeVisible();
  const approveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/pilot\/children\/[^/]+\/placement\/approve$/.test(response.url()),
  );
  await approve.click();
  expect((await approveResponse).status()).toBe(200);
  await expect(page.getByText(/starting plan approved/i)).toBeVisible();
}

async function completeChildStory(
  page: Page,
  testInfo: TestInfo,
): Promise<{ runId: string; immediate: EvidenceCounts }> {
  const start = page.getByRole('button', { name: /^(start|continue) story$/i }).first();
  await expect(start).toBeVisible();
  const startResponse = actionResponse(page);
  await start.click();
  expect((await startResponse).status()).toBe(200);
  const story = page.locator('[data-run-id]').first();
  await expect(story).toBeVisible();
  const runId = await story.getAttribute('data-run-id');
  expect(runId).toBeTruthy();

  const soundCheck = page.locator('[data-control="sound-check"]');
  if (await soundCheck.count()) {
    await soundCheck.click();
    const heard = page.locator('[data-control="sound-heard"]');
    await expect(heard).toBeEnabled();
    await heard.click();
    await clickSavedAction(page, page.locator('[data-control="continue"]').first());
  }

  // Reopen the child home after the welcome save and resume the same server run.
  await page.reload();
  const resume = page.getByRole('button', { name: /^(start|continue) story$/i }).first();
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page.locator(`[data-run-id="${runId}"]`)).toBeVisible();

  let teachingCaptured = false;
  let quietCaptured = false;
  const next = () =>
    clickSavedAction(page, page.locator('[data-control="continue"]').first());
  for (const familiarityPair of ROUTES.familiar.familiarity) {
    const questionId = familiarityPair[0]!;
    const choiceId = familiarityPair[1]!;
    await answerQuestion(page, questionId, choiceId);
    await next();
  }
  await expect(page.locator('[data-learn-panel="reminder"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('child-teaching.png'),
    fullPage: true,
  });
  teachingCaptured = true;
  await next();

  await clickSavedAction(
    page,
    page.locator('[data-piece-id="mu-a"][data-slot="left"]'),
  );
  await expect(
    page.locator('[data-control="continue"]').first(),
  ).toBeDisabled();
  await clickSavedAction(
    page,
    page.locator('[data-piece-id="mu-b"][data-slot="right"]'),
  );
  await next();

  for (const questionId of ['find-mu', 'find-lin'] as const) {
    await answerQuestion(page, questionId, ANSWERS[questionId]);
    await next();
  }
  await next();
  await next();
  await page.screenshot({
    path: testInfo.outputPath('child-quiet-check.png'),
    fullPage: true,
  });
  quietCaptured = true;
  for (const questionId of [
    'check-mu-sound',
    'check-lin-sound',
    'check-mu-reading',
    'check-lin-reading',
  ] as const) {
    await answerQuestion(page, questionId, ANSWERS[questionId]);
    await next();
  }
  await expect(page.locator('[data-step="recap"]')).toBeVisible();
  await expect(page.getByText(/small steps count/i)).toBeVisible();
  const immediate = page.locator('[data-evidence-group="immediate"]');
  await expect(immediate.locator('[data-category="independent"]')).toHaveText(
    String(CLEAN_FINAL.independentCorrect),
  );
  await expect(immediate.locator('[data-category="supported"]')).toHaveText(
    String(CLEAN_FINAL.supported),
  );
  await expect(immediate.locator('[data-category="unavailable"]')).toHaveText(
    String(CLEAN_FINAL.unavailable),
  );
  await expect(immediate.locator('[data-category="pending"]')).toHaveText(
    String(CLEAN_FINAL.pending),
  );
  const immediateCounts = await evidenceCounts(
    page,
    '[data-evidence-group="immediate"]',
  );
  expect(teachingCaptured).toBe(true);
  expect(quietCaptured).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('child-recap.png'),
    fullPage: true,
  });
  return { runId: runId!, immediate: immediateCounts };
}

test('[F1-001][F1-002][F1-003][F1-005] parent owns the focused first-story setup and hands over to the child', async ({
  f1Page: page,
  f1Context,
}, testInfo) => {
  const selected = pair(testInfo);
  await installSpeechBoundary(page, 'started');
  await signInUI(page, selected.parent);
  await selectParentChild(page, selected.child);

  await expect(page.getByText(selected.child.name, { exact: true })).toBeVisible();
  await expect(page.locator('[data-pilot-legacy-layout]')).toHaveCount(0);
  await expect(
    page.getByText(/learning path|your stories|account access desk|pilot operations/i),
  ).toHaveCount(0);
  await setupAndApprove(page, selected.child, testInfo);

  const handover = page.locator('[data-control="handover-signout"]');
  await expect(handover).toBeVisible();
  await handover.click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const childPage = await f1Context.newPage();
  await childPage.emulateMedia({ reducedMotion: 'reduce' });
  await installSpeechBoundary(childPage, 'started');
  try {
    await signInUI(childPage, selected.child);
    await expect(childPage.locator('[data-control="save-setup"]')).toHaveCount(0);
    await expect(childPage.locator('[data-control="approve-plan"]')).toHaveCount(0);
    await expect(
      childPage.getByText(/learning path|your stories|account access desk|pilot operations/i),
    ).toHaveCount(0);
    const storyRoot = childPage.locator('[data-story-version]').first();
    const completed = await completeChildStory(childPage, testInfo);
    const runId = completed.runId;
    await expect(storyRoot).toHaveAttribute('data-reduced-motion', 'true');
    expect(runId).toMatch(/^story-run-/);

    const visibleButtons = childPage.locator('button:visible');
    const count = Math.min(await visibleButtons.count(), 10);
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const box = await visibleButtons.nth(index).boundingBox();
      if (box) {
        expect(box.width, `button ${index} width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `button ${index} height`).toBeGreaterThanOrEqual(44);
      }
    }
    const focusable = childPage.locator('[data-control="story-home"]');
    await focusable.focus();
    expect(await childPage.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');

    await signInUI(page, selected.parent);
    await selectParentChild(page, selected.child);
    const parentRun = page.locator(
      `[data-role="ordinary-story-progress"] [data-story-run-id="${runId}"]`,
    );
    await expect(parentRun).toBeVisible();
    const parentImmediate = await evidenceCounts(
      parentRun,
      '[data-evidence-group="immediate"]',
    );
    expect(parentImmediate).toEqual(completed.immediate);
  } finally {
    await childPage.close();
  }
});

test('[F1-002] no local Mandarin voice offers an explicit unavailable response without saving playback as readiness', async ({
  f1Context,
}, testInfo) => {
  const selected = pair(testInfo);
  const page = await f1Context.newPage();
  await installSpeechBoundary(page, 'no-voice');
  try {
    await signInUI(page, selected.parent);
    const editSetup = page.locator('[data-control="edit-setup"]');
    const setupControl = page.locator(
      '[data-control="sound-check"], [data-control="edit-setup"]',
    ).first();
    await expect(setupControl).toBeVisible();
    if (await editSetup.isVisible()) await editSetup.click();
    await expect(page.locator('[data-control="sound-check"]')).toBeVisible();
    const play = await visibleAmong(
      page,
      [
        page.locator('[data-control="sound-check"]'),
        page.getByRole('button', { name: /play.*(?:Mandarin )?sound|sound check|try the sound/i }),
        page.getByRole('button', { name: /listen.*sample|play.*sample/i }),
      ],
      'no-voice parent sound check',
    );
    const heard = await visibleAmong(
      page,
      [page.getByRole('button', { name: /I heard|heard it|sound is working/i })],
      'no-voice heard confirmation',
    );
    await play.click();
    await expect(heard).toBeDisabled();
    const unavailable = await visibleAmong(
      page,
      [
        page.getByRole('button', {
          name: /sound (isn’t|isn't) working|sound unavailable|can't hear/i,
        }),
      ],
      'no-voice unavailable response',
    );
    await unavailable.click();
    await expect(unavailable).toHaveAttribute('aria-pressed', 'true');
    expect(await speechCalls(page)).toHaveLength(0);
    await expect(page.locator('[data-control="save-setup"]')).toBeEnabled();
  } finally {
    await page.close();
  }
});
