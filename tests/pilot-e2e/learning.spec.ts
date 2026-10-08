import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expect,
  request as requestFactory,
  test,
  type APIRequestContext,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';

import { installSpeechStub } from '../helpers/forest-ui';

const LESSON_VERSION = 'forest-01-v1';
const PILOT_ACTION_PATH =
  /\/api\/pilot\/children\/[^/]+\/runs\/[^/]+\/actions$/;
const ACCOUNT_KEYS = [
  'operator',
  'parentA',
  'parentB',
  'childA',
  'childB',
  'teacher',
  'otherTeacher',
] as const;

type AccountKey = (typeof ACCOUNT_KEYS)[number];

type PilotAccount = {
  id: string;
  username: string;
  password: string;
  name: string;
  role: 'operator' | 'parent' | 'child' | 'teacher';
};

type FixtureObject = Record<string, unknown>;

type PilotFixture = {
  candidateId: string;
  testRunId: string;
  baseURL: string;
  groups: Record<string, FixtureObject>;
};

type FixtureScenario = FixtureObject & {
  accounts?: Partial<Record<AccountKey, PilotAccount>>;
};

type ResolvedScenario = {
  fixture: PilotFixture;
  group: FixtureObject;
  scenario: FixtureScenario;
  accounts: Partial<Record<AccountKey, PilotAccount>>;
  baseURL: string;
};

type APIClient = {
  request: APIRequestContext;
  origin: string;
  account: PilotAccount;
  close: () => Promise<void>;
};

type RequestDecision = 'abort' | 'continue' | 'unavailable';

type RequestGate = {
  waitForFirst: () => Promise<void>;
  decide: (decision: RequestDecision) => Promise<void>;
  releaseHeld: (decision: RequestDecision) => Promise<void>;
  dispose: () => Promise<void>;
};

let syntheticIPCounter = 16;

function object(value: unknown): value is FixtureObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nextSyntheticIP(): string {
  const value = syntheticIPCounter;
  syntheticIPCounter = syntheticIPCounter >= 240 ? 16 : syntheticIPCounter + 1;
  return `198.51.100.${value}`;
}

function projectGroupName(testInfo: TestInfo): string {
  return testInfo.project.name;
}

function scenarioObject(group: FixtureObject, name: string): FixtureScenario {
  const value = group[name];
  return object(value) ? (value as FixtureScenario) : {};
}

function accountSource(
  group: FixtureObject,
  scenario: FixtureScenario,
): FixtureObject {
  const groupAccounts = object(group.accounts) ? group.accounts : {};
  const scenarioAccounts = object(scenario.accounts)
    ? scenario.accounts
    : scenario;
  return { ...groupAccounts, ...scenarioAccounts };
}

function requireAccount(
  accounts: Partial<Record<AccountKey, PilotAccount>>,
  key: AccountKey,
): PilotAccount {
  const account = accounts[key];
  if (
    !account ||
    typeof account.id !== 'string' ||
    typeof account.username !== 'string' ||
    typeof account.password !== 'string' ||
    typeof account.name !== 'string' ||
    typeof account.role !== 'string'
  ) {
    throw new Error(`pilot fixture account ${key} is unavailable`);
  }
  return account;
}

async function loadScenario(
  testInfo: TestInfo,
  name: string,
): Promise<ResolvedScenario> {
  const fixturePath = process.env.HANZI_PILOT_FIXTURES;
  if (!fixturePath) throw new Error('HANZI_PILOT_FIXTURES is required');

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(fixturePath), 'utf8'));
  } catch {
    throw new Error('pilot fixture file could not be read');
  }
  if (!object(parsed)) throw new Error('pilot fixture is not an object');
  const fixture = parsed as unknown as PilotFixture;
  if (
    typeof fixture.candidateId !== 'string' ||
    typeof fixture.testRunId !== 'string' ||
    typeof fixture.baseURL !== 'string' ||
    !object(fixture.groups)
  ) {
    throw new Error('pilot fixture envelope is invalid');
  }

  const group = fixture.groups[projectGroupName(testInfo)];
  if (!object(group))
    throw new Error(
      `pilot fixture group is missing for ${projectGroupName(testInfo)}`,
    );
  const scenario = scenarioObject(group, name);
  const source = accountSource(group, scenario);
  const accounts: Partial<Record<AccountKey, PilotAccount>> = {};
  for (const key of ACCOUNT_KEYS) {
    const value = source[key];
    if (object(value)) accounts[key] = value as unknown as PilotAccount;
  }
  return {
    fixture,
    group,
    scenario,
    accounts,
    baseURL: fixture.baseURL,
  };
}

async function createAPIClient(
  resolved: ResolvedScenario,
  account: PilotAccount,
  label: string,
): Promise<APIClient> {
  const origin = new URL(resolved.baseURL).origin;
  const request = await requestFactory.newContext({
    baseURL: resolved.baseURL,
    extraHTTPHeaders: {
      Accept: 'application/json',
      // The local auth limiter treats this as the ordinary proxy client IP.
      // It does not grant access or alter authorization.
      'CF-Connecting-IP': nextSyntheticIP(),
    },
  });
  try {
    const response = await request.post('/api/auth/sign-in/username', {
      data: { username: account.username, password: account.password },
      headers: { Origin: origin },
    });
    expect(response.status(), `${label} sign-in status`).toBe(200);
    return {
      request,
      origin,
      account,
      close: () => request.dispose(),
    };
  } catch (error) {
    await request.dispose();
    throw error;
  }
}

async function apiStatus(
  response: { status: () => number },
  expected: number,
  label: string,
): Promise<void> {
  expect(response.status(), label).toBe(expected);
}

async function jsonResponse<T>(
  response: { status: () => number; json: () => Promise<unknown> },
  expected: number,
  label: string,
): Promise<T> {
  await apiStatus(response, expected, label);
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function establishLink(
  operator: APIClient,
  parent: PilotAccount,
  child: PilotAccount,
): Promise<void> {
  const response = await operator.request.post('/api/pilot/links', {
    data: { parentId: parent.id, childId: child.id },
    headers: { Origin: operator.origin },
  });
  expect([200, 201]).toContain(response.status());
}

async function establishGrant(
  parent: APIClient,
  child: PilotAccount,
  teacher: PilotAccount,
): Promise<void> {
  const response = await parent.request.post('/api/pilot/grants', {
    data: { childId: child.id, teacherId: teacher.id },
    headers: { Origin: parent.origin },
  });
  expect([200, 201]).toContain(response.status());
}

async function saveAssignment(
  parent: APIClient,
  child: PilotAccount,
  nickname: string,
): Promise<void> {
  const onboarding = await parent.request.put(
    `/api/pilot/children/${encodeURIComponent(child.id)}/onboarding`,
    {
      data: { nickname, experience: 'new', audioReady: true },
      headers: { Origin: parent.origin },
    },
  );
  await apiStatus(onboarding, 200, 'onboarding setup');
  const assignment = await parent.request.post(
    `/api/pilot/children/${encodeURIComponent(child.id)}/assignments`,
    {
      data: { lessonVersion: LESSON_VERSION },
      headers: { Origin: parent.origin },
    },
  );
  expect([200, 201]).toContain(assignment.status());
}

async function setupRelations(
  resolved: ResolvedScenario,
  options: {
    secondFamily?: boolean;
    teacherGrant?: boolean;
    otherTeacherGrant?: boolean;
  } = {},
): Promise<void> {
  const operator = await createAPIClient(
    resolved,
    requireAccount(resolved.accounts, 'operator'),
    'operator setup',
  );
  const parentA = await createAPIClient(
    resolved,
    requireAccount(resolved.accounts, 'parentA'),
    'parent A setup',
  );
  const parentB = options.secondFamily
    ? await createAPIClient(
        resolved,
        requireAccount(resolved.accounts, 'parentB'),
        'parent B setup',
      )
    : null;
  try {
    await establishLink(
      operator,
      requireAccount(resolved.accounts, 'parentA'),
      requireAccount(resolved.accounts, 'childA'),
    );
    if (options.teacherGrant) {
      await establishGrant(
        parentA,
        requireAccount(resolved.accounts, 'childA'),
        requireAccount(resolved.accounts, 'teacher'),
      );
    }
    if (options.secondFamily && parentB) {
      await establishLink(
        operator,
        requireAccount(resolved.accounts, 'parentB'),
        requireAccount(resolved.accounts, 'childB'),
      );
      if (options.otherTeacherGrant) {
        await establishGrant(
          parentB,
          requireAccount(resolved.accounts, 'childB'),
          requireAccount(resolved.accounts, 'otherTeacher'),
        );
      }
    }
  } finally {
    await operator.close();
    await parentA.close();
    await parentB?.close();
  }
}

async function setupAssignments(
  resolved: ResolvedScenario,
  options: { childB?: boolean } = {},
): Promise<void> {
  const parentA = await createAPIClient(
    resolved,
    requireAccount(resolved.accounts, 'parentA'),
    'parent A assignment setup',
  );
  const parentB = options.childB
    ? await createAPIClient(
        resolved,
        requireAccount(resolved.accounts, 'parentB'),
        'parent B assignment setup',
      )
    : null;
  try {
    await saveAssignment(
      parentA,
      requireAccount(resolved.accounts, 'childA'),
      'A forest learner',
    );
    if (parentB)
      await saveAssignment(
        parentB,
        requireAccount(resolved.accounts, 'childB'),
        'B forest learner',
      );
  } finally {
    await parentA.close();
    await parentB?.close();
  }
}

async function preparePage(page: Page): Promise<void> {
  // Speech stubbing is an addInitScript boundary, so register it before the
  // first navigation. Learning requests remain real browser-to-Worker calls.
  await installSpeechStub(page);
  await page.context().setExtraHTTPHeaders({
    'CF-Connecting-IP': nextSyntheticIP(),
  });
}

async function signInUI(page: Page, account: PilotAccount): Promise<void> {
  await page.goto('/pilot');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(
    page.locator('nav[aria-label="Pilot navigation"]'),
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(`${account.name} ·`, 'i')),
  ).toBeVisible();
}

async function signOutUI(page: Page): Promise<void> {
  await page
    .locator('nav[aria-label="Pilot navigation"]')
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function returnToPilotHome(page: Page): Promise<void> {
  await page
    .locator('nav[aria-label="Child lesson navigation"]')
    .getByRole('link', { name: /Little Hanzi/i })
    .click();
  await expect(
    page.locator('section[data-role="child-learning"]'),
  ).toBeVisible();
}

async function saveAndAssignThroughUI(
  page: Page,
  child: PilotAccount,
): Promise<void> {
  const panel = page.locator('section[data-role="parent-learning"]');
  await expect(panel).toBeVisible();
  const childSelect = panel.locator('select[data-child-selector="true"]');
  await childSelect.selectOption(child.id);
  const form = panel.locator('form[data-onboarding-form="true"]');
  await expect(form).toBeVisible();
  await form.getByLabel('Nickname').fill('Forest learner');
  await form.getByLabel('Chinese-learning experience').selectOption('new');
  const audio = form.getByRole('checkbox', { name: 'Audio is ready' });
  if (!(await audio.isChecked())) await audio.check();
  await form.getByRole('button', { name: 'Save child plan' }).click();
  await expect(
    page.getByText('Child plan saved.', { exact: true }),
  ).toBeVisible();

  const assignment = panel.locator('[data-assignment-panel="true"]');
  const assign = assignment.getByRole('button', {
    name: 'Assign forest lesson',
  });
  if (await assign.count()) {
    await assign.click();
    await expect(
      page.getByText('The forest lesson is assigned to this child.', {
        exact: true,
      }),
    ).toBeVisible();
  }
  await expect(assignment.getByText('Assigned', { exact: true })).toBeVisible();
}

async function openChildLesson(page: Page): Promise<void> {
  const home = page.locator('section[data-role="child-learning"]');
  await expect(home).toBeVisible();
  await home.getByRole('button', { name: /^(Start|Continue) lesson$/ }).click();
  await expect(page.locator('[data-step-id]')).toBeVisible();
  const welcome = page.locator('[data-step-id="welcome"]');
  if (await welcome.count()) {
    await welcome
      .getByRole('button', { name: /^(Start|Continue) the lesson$/ })
      .click();
  }
  await expect(page.locator('main[data-run-id][data-step-id]')).toBeVisible();
}

function currentStage(page: Page) {
  return page.locator('main[data-run-id][data-step-id]').first();
}

function pilotActionResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      PILOT_ACTION_PATH.test(response.url()),
  );
}

async function waitSaved(page: Page): Promise<void> {
  await expect(page.locator('[data-status="saved"]')).toBeVisible();
}

async function continueLesson(page: Page): Promise<void> {
  const button = currentStage(page).getByRole('button', {
    name: /^(Continue|Continue to build|Continue to checks|Next panel)$/i,
  });
  await expect(button).toBeVisible();
  const response = pilotActionResponse(page);
  await button.click();
  expect((await response).ok()).toBe(true);
  await waitSaved(page);
}

async function answerPilot(
  page: Page,
  questionId: string,
  choiceId: string,
): Promise<void> {
  const question = page.locator(`[data-question-id="${questionId}"]`).first();
  await expect(question).toBeVisible();
  const choice = question.locator(`[data-choice-id="${choiceId}"]`).first();
  await expect(choice).toBeVisible();
  if (await choice.isDisabled()) {
    const option = choice.locator('..');
    if (choiceId.startsWith('audio-')) {
      await option
        .getByRole('button', { name: /^Listen to option \d+$/ })
        .click();
    } else {
      await question
        .getByRole('button', {
          name: /Play Mandarin word cue|Play question sound|Replay sound/i,
        })
        .first()
        .click();
    }
    await expect(choice).toBeEnabled();
  }
  const response = pilotActionResponse(page);
  await choice.click();
  expect((await response).ok()).toBe(true);
  await waitSaved(page);
}

async function answerReadingPilot(
  page: Page,
  questionId: string,
  choiceId: string,
): Promise<void> {
  const question = page.locator(`[data-question-id="${questionId}"]`).first();
  const choice = question.locator(`[data-choice-id="${choiceId}"]`).first();
  const option = choice.locator('..');
  await option.getByRole('button', { name: /^Listen to option \d+$/ }).click();
  await expect(choice).toBeEnabled();
  await answerPilot(page, questionId, choiceId);
}

async function advanceTo(page: Page, stepId: string): Promise<void> {
  for (let count = 0; count < 14; count += 1) {
    if (
      await page
        .locator(`main[data-step-id="${stepId}"]`)
        .isVisible()
        .catch(() => false)
    )
      return;
    await continueLesson(page);
  }
  await expect(page.locator(`main[data-step-id="${stepId}"]`)).toBeVisible();
}

async function completePilotLesson(page: Page): Promise<string> {
  await openChildLesson(page);
  const firstRun = await currentStage(page).getAttribute('data-run-id');
  expect(firstRun).toBeTruthy();

  await answerPilot(page, 'fam-mu', 'lin');
  await answerPilot(page, 'fam-mu', 'mu');
  await continueLesson(page);
  await answerPilot(page, 'fam-lin', 'mu');
  await answerPilot(page, 'fam-lin', 'lin');
  await continueLesson(page);
  await advanceTo(page, 'build');

  for (const [componentId, slot] of [
    ['mu-a', 'left'],
    ['mu-b', 'right'],
  ] as const) {
    const component = page.locator(`[data-component-id="${componentId}"]`);
    const target = page.locator(`[data-component-slot="${slot}"]`);
    await component.click();
    const response = pilotActionResponse(page);
    await target.click();
    expect((await response).ok()).toBe(true);
    await waitSaved(page);
  }
  await expect(page.getByText('林', { exact: true })).toBeVisible();
  await continueLesson(page);
  await answerPilot(page, 'find-mu', 'mu');
  await continueLesson(page);
  await answerPilot(page, 'find-lin', 'lin');
  await continueLesson(page);

  await expect(page.locator('[data-step-id="read"]')).toBeVisible();
  await continueLesson(page);
  await continueLesson(page);

  await answerPilot(page, 'check-mu-sound', 'mu');
  await continueLesson(page);
  await answerPilot(page, 'check-lin-sound', 'lin');
  await continueLesson(page);
  await answerReadingPilot(page, 'check-mu-reading', 'audio-mu');
  await continueLesson(page);
  await answerReadingPilot(page, 'check-lin-reading', 'audio-lin');
  await continueLesson(page);
  await expect(page.locator('main[data-step-id="recap"]')).toBeVisible();
  await expect(
    page.getByText('Small steps count.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/mastery|owner approval|answer key/i),
  ).toHaveCount(0);
  return firstRun!;
}

async function installActionGate(
  page: Page,
  predicate: (route: Route) => boolean,
  options: { holdAfterDecision?: boolean } = {},
): Promise<RequestGate> {
  let firstSeen = false;
  let holdSubsequent = false;
  let futureDecision: RequestDecision | null = null;
  const heldRoutes: Array<{
    route: Route;
    resolve: (decision: RequestDecision) => void;
  }> = [];
  let routeReady: () => void = () => undefined;
  let actionDone: () => void = () => undefined;
  let decide: (decision: RequestDecision) => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => {
    routeReady = resolveReady;
  });
  const settled = new Promise<void>((resolveDone) => {
    actionDone = resolveDone;
  });
  const decision = new Promise<RequestDecision>((resolveDecision) => {
    decide = resolveDecision;
  });
  const respond = async (route: Route, selected: RequestDecision) => {
    try {
      if (selected === 'abort') await route.abort();
      else if (selected === 'unavailable')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'STORAGE_UNAVAILABLE',
              message: 'learning service is temporarily unavailable',
            },
          }),
        });
      else await route.continue();
    } catch {
      // Navigation can cancel a held fetch before the test releases it.
    }
  };
  const handler = async (route: Route) => {
    if (!predicate(route)) {
      await route.continue();
      return;
    }
    if (!firstSeen) {
      firstSeen = true;
      routeReady();
      const selected = await decision;
      await respond(route, selected);
      holdSubsequent =
        Boolean(options.holdAfterDecision) && selected !== 'continue';
      actionDone();
      return;
    }
    if (holdSubsequent) {
      if (futureDecision) {
        await respond(route, futureDecision);
      } else {
        await new Promise<RequestDecision>((resolveDecision) => {
          heldRoutes.push({ route, resolve: resolveDecision });
        }).then((selected) => respond(route, selected));
      }
      return;
    }
    await route.continue();
  };
  await page.route('**/api/pilot/children/*/runs/*/actions', handler);
  const releaseHeld = async (selected: RequestDecision) => {
    futureDecision = selected;
    holdSubsequent = false;
    const pending = heldRoutes.splice(0);
    await Promise.all(
      pending.map(({ resolve }) => {
        resolve(selected);
        return Promise.resolve();
      }),
    );
  };
  return {
    waitForFirst: () => ready,
    decide: async (selected) => {
      decide(selected);
      await settled;
    },
    releaseHeld,
    dispose: async () => {
      await releaseHeld('abort');
      await page.unroute('**/api/pilot/children/*/runs/*/actions', handler);
    },
  };
}

async function installSignOutGate(page: Page): Promise<RequestGate> {
  let firstSeen = false;
  let routeReady: () => void = () => undefined;
  let actionDone: () => void = () => undefined;
  let decide: (decision: RequestDecision) => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => {
    routeReady = resolveReady;
  });
  const settled = new Promise<void>((resolveDone) => {
    actionDone = resolveDone;
  });
  const decision = new Promise<RequestDecision>((resolveDecision) => {
    decide = resolveDecision;
  });
  const handler = async (route: Route) => {
    if (!firstSeen) {
      firstSeen = true;
      routeReady();
      const selected = await decision;
      try {
        if (selected === 'abort') await route.abort();
        else await route.continue();
      } finally {
        actionDone();
      }
      return;
    }
    await route.continue();
  };
  await page.route('**/api/auth/sign-out', handler);
  return {
    waitForFirst: () => ready,
    decide: async (selected) => {
      decide(selected);
      await settled;
    },
    releaseHeld: async () => undefined,
    dispose: () => page.unroute('**/api/auth/sign-out', handler),
  };
}

function isTargetAnswer(
  route: Route,
  childId: string,
  runId?: string,
): boolean {
  const request = route.request();
  if (request.method() !== 'POST' || !PILOT_ACTION_PATH.test(request.url()))
    return false;
  if (!request.url().includes(`/children/${encodeURIComponent(childId)}/`))
    return false;
  if (runId && !request.url().includes(`/runs/${encodeURIComponent(runId)}/`))
    return false;
  try {
    const body = request.postDataJSON() as { type?: unknown };
    return body.type === 'answer';
  } catch {
    return false;
  }
}

async function getProgress(
  resolved: ResolvedScenario,
  account: PilotAccount,
  childId: string,
  label: string,
): Promise<{ request: APIClient; body: FixtureObject }> {
  const client = await createAPIClient(resolved, account, label);
  const response = await client.request.get(
    `/api/pilot/children/${encodeURIComponent(childId)}/progress`,
  );
  const body = await jsonResponse<FixtureObject>(
    response,
    200,
    `${label} progress`,
  );
  return { request: client, body };
}

function runProjection(body: FixtureObject): unknown {
  return Array.isArray(body.runs)
    ? body.runs.map((run) => {
        if (!object(run)) return run;
        const copy = { ...run };
        delete copy.updatedAt;
        delete copy.createdAt;
        return copy;
      })
    : [];
}

function forbiddenPublicKeys(value: unknown): string[] {
  const keys: string[] = [];
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!object(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      if (
        /password|hash|token|secret|email|mastery|correctChoice|answerKey/i.test(
          key,
        )
      )
        keys.push(key);
      visit(child);
    }
  };
  visit(value);
  return keys;
}

async function captureDesignScreen(
  page: Page,
  testInfo: TestInfo,
  name: string,
  masks: string[] = [],
): Promise<void> {
  const filename = `pilot-${testInfo.project.name}-${name}.png`;
  const maskSelectors = [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    ...masks,
  ];
  await page.screenshot({
    path: testInfo.outputPath(filename),
    animations: 'disabled',
    mask: maskSelectors.map((selector) => page.locator(selector)),
  });
}

async function assertCloudstep(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const nav = page.locator('nav[aria-label="Pilot navigation"]');
  await expect(nav).toBeVisible();
  const root = nav.locator('xpath=../..');
  const tokens = await root.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(
      [
        '--cs-ink',
        '--cs-muted',
        '--cs-blue',
        '--cs-blue-hover',
        '--cs-teal',
        '--cs-apricot',
        '--cs-sky',
        '--cs-canvas',
        '--cs-surface',
        '--cs-line',
        '--cs-control-line',
      ].map((name) => [name, style.getPropertyValue(name).trim()]),
    );
  });
  expect(tokens['--cs-ink']).toBe('#182c49');
  expect(tokens['--cs-blue']).toBe('#245bd6');
  expect(tokens['--cs-teal']).toBe('#117c72');
  expect(tokens['--cs-sky']).toBe('#eaf2ff');
  expect(tokens['--cs-canvas']).toBe('#f5f7fb');
  expect(tokens['--cs-line']).toBe('#d9e2ef');

  await page.keyboard.press('Tab');
  const focused = page.locator(':focus-visible').first();
  await expect(focused).toBeVisible();
  const focusStyle = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(focusStyle.style).toBe('solid');
  expect(focusStyle.width).toBe('3px');

  const controls = page.locator(
    'button:visible, a:visible, select:visible, textarea:visible, input:visible:not([type="checkbox"])',
  );
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const box = await controls.nth(index).boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  const checkboxLabels = page.locator(
    'label:has(input[type="checkbox"]):visible',
  );
  for (
    let index = 0;
    index < Math.min(await checkboxLabels.count(), 10);
    index += 1
  ) {
    const box = await checkboxLabels.nth(index).boundingBox();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  const motion = await root.evaluate((element) => {
    const candidate = element.querySelector('button, a, input, select');
    if (!candidate) return null;
    const style = getComputedStyle(candidate);
    return {
      animation: style.animationDuration,
      transition: style.transitionDuration,
    };
  });
  expect(motion).not.toBeNull();
  expect(motion?.animation).toMatch(/0(?:\.01)?ms|0s/);
  expect(motion?.transition).toMatch(/0(?:\.01)?ms|0s/);
}

test('[S2-AC-010][S2-AC-012][L-07a] recovers one interrupted authenticated answer after reload', async ({
  page,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'recovery');
  const parent = requireAccount(resolved.accounts, 'parentA');
  const child = requireAccount(resolved.accounts, 'childA');
  await preparePage(page);
  await setupRelations(resolved);
  await setupAssignments(resolved);

  await signInUI(page, child);
  await openChildLesson(page);
  const runId = await currentStage(page).getAttribute('data-run-id');
  expect(runId).toBeTruthy();
  const before = await getProgress(
    resolved,
    parent,
    child.id,
    'recovery baseline',
  );
  const runBefore = (before.body.runs as FixtureObject[]).find(
    (run) => run.runId === runId,
  );
  const eventCount = Array.isArray(runBefore?.events)
    ? runBefore.events.length
    : 0;
  await before.request.close();

  const gate = await installActionGate(
    page,
    (route) => isTargetAnswer(route, child.id, runId || undefined),
    { holdAfterDecision: true },
  );
  try {
    const question = page.locator('[data-question-id="fam-mu"]');
    await question
      .getByRole('button', { name: /Play Mandarin word cue/i })
      .click();
    await question.locator('[data-choice-id="lin"]').click();
    await gate.waitForFirst();
    await gate.decide('abort');
    await expect(page.locator('[data-status="error"]')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry save' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.locator('section[data-role="child-learning"]'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue lesson' }).click();
    await expect(page.locator('main[data-run-id][data-step-id]')).toBeVisible();
    await gate.releaseHeld('continue');
    await expect(
      page.locator('[data-status="pending"], [data-status="saved"]'),
    ).toBeVisible();
    await waitSaved(page);
  } finally {
    await gate.dispose();
  }

  const after = await getProgress(
    resolved,
    parent,
    child.id,
    'recovery result',
  );
  const runAfter = (after.body.runs as FixtureObject[]).find(
    (run) => run.runId === runId,
  );
  const events = Array.isArray(runAfter?.events) ? runAfter.events : [];
  expect(events.length).toBe(eventCount + 1);
  expect(
    events.filter((event) => object(event) && event.type === 'answer'),
  ).toHaveLength(1);
  expect(
    new Set(events.map((event) => (object(event) ? event.eventId : null))).size,
  ).toBe(events.length);
  await after.request.close();
});

test('[S2-AC-010][S2-AC-012][L-07b] clears child-A outbox and late response on account switch', async ({
  page,
  context,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'switch');
  const parent = requireAccount(resolved.accounts, 'parentA');
  const childA = requireAccount(resolved.accounts, 'childA');
  const childB = requireAccount(resolved.accounts, 'childB');
  await preparePage(page);
  await setupRelations(resolved, { secondFamily: true });
  await setupAssignments(resolved, { childB: true });

  await signInUI(page, childA);
  await openChildLesson(page);
  const runId = await currentStage(page).getAttribute('data-run-id');
  expect(runId).toBeTruthy();
  const before = await getProgress(
    resolved,
    parent,
    childA.id,
    'account switch baseline',
  );
  const baselineRun = (before.body.runs as FixtureObject[]).find(
    (item) => item.runId === runId,
  );
  const baselineEvents = Array.isArray(baselineRun?.events)
    ? baselineRun.events
    : [];
  await before.request.close();
  const gate = await installActionGate(
    page,
    (route) => isTargetAnswer(route, childA.id, runId || undefined),
    { holdAfterDecision: true },
  );
  try {
    const question = page.locator('[data-question-id="fam-mu"]');
    await question
      .getByRole('button', { name: /Play Mandarin word cue/i })
      .click();
    await question.locator('[data-choice-id="lin"]').click();
    await gate.waitForFirst();

    const switchPage = await context.newPage();
    await preparePage(switchPage);
    try {
      await switchPage.goto('/pilot');
      await expect(
        switchPage.locator('section[data-role="child-learning"]'),
      ).toBeVisible();
      await signOutUI(switchPage);
      await signInUI(switchPage, childB);
      await expect(
        switchPage.locator('section[data-role="child-learning"]'),
      ).toBeVisible();
      await expect(switchPage.locator(`text=${childA.name}`)).toHaveCount(0);
      await expect(switchPage.locator(`[data-run-id="${runId}"]`)).toHaveCount(
        0,
      );

      // Revalidate the still-open old tab after the shared cookie changes.
      // This exercises the real focus/pageshow session boundary instead of
      // proving only that a newly opened page starts clean.
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(
        page.getByText(new RegExp(`${childB.name} ·`, 'i')),
      ).toBeVisible();
      await expect(page.locator(`[data-run-id="${runId}"]`)).toHaveCount(0);

      await gate.decide('unavailable');
      await expect(switchPage.locator(`[data-run-id="${runId}"]`)).toHaveCount(
        0,
      );

      const parentRead = await getProgress(
        resolved,
        parent,
        childA.id,
        'account switch child A readback',
      );
      const run = (parentRead.body.runs as FixtureObject[]).find(
        (item) => item.runId === runId,
      );
      const events = Array.isArray(run?.events) ? run.events : [];
      expect(events).toHaveLength(baselineEvents.length);
      expect(
        events.map((event) => (object(event) ? event.eventId : null)),
      ).toEqual(
        baselineEvents.map((event) => (object(event) ? event.eventId : null)),
      );
      await gate.releaseHeld('abort');
      await parentRead.request.close();
    } finally {
      await switchPage.close();
    }
  } finally {
    await gate.dispose();
  }
});

test('[S2-AC-010][S2-AC-012][L-07c] keeps failed sign-out locked across reload and invalidates old session', async ({
  page,
  context,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'signout');
  const child = requireAccount(resolved.accounts, 'childA');
  await preparePage(page);
  await setupRelations(resolved);
  await setupAssignments(resolved);
  await signInUI(page, child);

  const oldCookie = (await context.cookies()).find((cookie) =>
    /session/i.test(cookie.name),
  );
  expect(oldCookie).toBeTruthy();
  const gate = await installSignOutGate(page);
  try {
    await page
      .locator('nav[aria-label="Pilot navigation"]')
      .getByRole('button', { name: 'Sign out' })
      .click();
    await gate.waitForFirst();
    await expect(
      page.getByRole('heading', { name: 'Finishing sign-out…' }),
    ).toBeVisible();
    await expect(page.locator('[data-role]')).toHaveCount(0);
    await gate.decide('abort');
    await expect(
      page.getByRole('heading', { name: 'Finish signing out' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry sign-out' }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      /Sign-out is not confirmed/i,
    );
  } finally {
    await gate.dispose();
  }

  const blockedGate = await installSignOutGate(page);
  try {
    await page.reload();
    await blockedGate.waitForFirst();
    await expect(
      page.getByRole('heading', { name: /Finish(ing)? sign-out/i }),
    ).toBeVisible();
    await expect(page.locator('[data-role]')).toHaveCount(0);
    await blockedGate.decide('abort');
    await expect(
      page.getByRole('heading', { name: 'Finish signing out' }),
    ).toBeVisible();
  } finally {
    await blockedGate.dispose();
  }

  const retry = page.getByRole('button', { name: 'Retry sign-out' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(/server confirmed sign-out/i)).toBeVisible();
  await expect(page.locator('[data-role]')).toHaveCount(0);

  const oldSession = await requestFactory.newContext({
    baseURL: resolved.baseURL,
    extraHTTPHeaders: {
      Accept: 'application/json',
      Cookie: `${oldCookie!.name}=${oldCookie!.value}`,
    },
  });
  try {
    const response = await oldSession.get('/api/pilot/me');
    await apiStatus(response, 401, 'revoked old session');
  } finally {
    await oldSession.dispose();
  }
});

test('[S2-AC-010][S2-AC-011][L-08] completes the owned lesson and exposes equal parent/teacher evidence', async ({
  page,
  browser,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'journey');
  const parent = requireAccount(resolved.accounts, 'parentA');
  const child = requireAccount(resolved.accounts, 'childA');
  const teacher = requireAccount(resolved.accounts, 'teacher');
  await preparePage(page);
  await setupRelations(resolved, { teacherGrant: true });

  await signInUI(page, parent);
  await saveAndAssignThroughUI(page, child);
  await signOutUI(page);

  await signInUI(page, child);
  const runId = await completePilotLesson(page);
  await returnToPilotHome(page);
  await signOutUI(page);

  const parentContext = await browser.newContext({
    baseURL: resolved.baseURL,
    viewport: testInfo.project.use.viewport,
    hasTouch: testInfo.project.use.hasTouch,
    isMobile: testInfo.project.use.isMobile,
  });
  const teacherContext = await browser.newContext({
    baseURL: resolved.baseURL,
    viewport: testInfo.project.use.viewport,
    hasTouch: testInfo.project.use.hasTouch,
    isMobile: testInfo.project.use.isMobile,
  });
  const parentPage = await parentContext.newPage();
  const teacherPage = await teacherContext.newPage();
  await preparePage(parentPage);
  await preparePage(teacherPage);
  try {
    await signInUI(parentPage, parent);
    const parentPanel = parentPage.locator(
      'section[data-role="parent-learning"]',
    );
    await expect(
      parentPanel.locator('[data-progress-panel="true"]'),
    ).toBeVisible();
    await expect(parentPanel.locator(`[data-run-id="${runId}"]`)).toBeVisible();
    await expect(
      parentPanel.locator('[data-evidence-limits="true"]'),
    ).toBeVisible();
    await expect(
      parentPage.getByRole('button', { name: 'Export record' }),
    ).toBeVisible();

    await signInUI(teacherPage, teacher);
    const teacherPanel = teacherPage.locator(
      'section[data-role="teacher-learning"]',
    );
    await expect(teacherPanel).toBeVisible();
    await expect(
      teacherPanel.locator(`[data-run-id="${runId}"]`),
    ).toBeVisible();
    await expect(
      teacherPanel.locator('[data-evidence-limits="true"]'),
    ).toBeVisible();
    await expect(
      teacherPanel.getByText('Read only', { exact: true }),
    ).toBeVisible();
    await expect(teacherPanel.locator('[data-onboarding-form]')).toHaveCount(0);
    await expect(
      teacherPanel.getByRole('button', { name: /Export record/i }),
    ).toHaveCount(0);
    await expect(teacherPanel.locator('[data-choice-id]')).toHaveCount(0);
    await expect(
      teacherPage.getByRole('button', {
        name: /Save child plan|Assign forest lesson|Start lesson|Continue lesson/i,
      }),
    ).toHaveCount(0);

    const parentRead = await getProgress(
      resolved,
      parent,
      child.id,
      'parent evidence',
    );
    const teacherRead = await getProgress(
      resolved,
      teacher,
      child.id,
      'teacher evidence',
    );
    expect(runProjection(teacherRead.body)).toEqual(
      runProjection(parentRead.body),
    );
    expect(teacherRead.body.evidenceLimits).toEqual(
      parentRead.body.evidenceLimits,
    );
    expect(forbiddenPublicKeys(parentRead.body)).toEqual([]);
    await parentRead.request.close();
    await teacherRead.request.close();

    const exportClient = await createAPIClient(
      resolved,
      parent,
      'parent export',
    );
    const exportResponse = await exportClient.request.get(
      `/api/pilot/children/${encodeURIComponent(child.id)}/export`,
    );
    const exported = await jsonResponse<FixtureObject>(
      exportResponse,
      200,
      'parent export',
    );
    expect(exportResponse.headers()['cache-control']).toContain('no-store');
    expect(exported.schemaVersion).toBe('pilot-learning-export-1');
    expect(forbiddenPublicKeys(exported)).toEqual([]);
    await exportClient.close();

    const teacherWrite = await createAPIClient(
      resolved,
      teacher,
      'teacher write denial',
    );
    const onboardingWrite = await teacherWrite.request.put(
      `/api/pilot/children/${encodeURIComponent(child.id)}/onboarding`,
      {
        data: { nickname: 'Should fail', experience: 'new', audioReady: true },
        headers: { Origin: teacherWrite.origin },
      },
    );
    await apiStatus(onboardingWrite, 403, 'teacher onboarding write');
    const teacherExport = await teacherWrite.request.get(
      `/api/pilot/children/${encodeURIComponent(child.id)}/export`,
    );
    await apiStatus(teacherExport, 403, 'teacher export');
    await teacherWrite.close();
  } finally {
    await parentContext.close();
    await teacherContext.close();
  }
});

test('[S2-AC-010][S2-AC-011][L-08-design] captures role screens and checks Cloudstep interactions', async ({
  page,
  browser,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'design');
  const parent = requireAccount(resolved.accounts, 'parentA');
  const child = requireAccount(resolved.accounts, 'childA');
  const teacher = requireAccount(resolved.accounts, 'teacher');
  const operator = requireAccount(resolved.accounts, 'operator');
  await preparePage(page);
  await setupRelations(resolved, { teacherGrant: true });

  await page.goto('/pilot');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await assertCloudstep(page);
  await captureDesignScreen(page, testInfo, 'signin', [
    'input[autocomplete="username"]',
    'input[type="password"]',
  ]);

  await page.getByLabel('Username').fill(parent.username);
  await page.getByLabel('Password').fill(parent.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(
    page.locator('section[data-role="parent-learning"]'),
  ).toBeVisible();
  await saveAndAssignThroughUI(page, child);
  await assertCloudstep(page);
  await captureDesignScreen(page, testInfo, 'parent-progress', [
    'input',
    'select',
  ]);
  await signOutUI(page);

  await signInUI(page, child);
  await openChildLesson(page);
  await assertCloudstep(page);
  await captureDesignScreen(page, testInfo, 'child-lesson');
  await returnToPilotHome(page);
  await signOutUI(page);

  const teacherContext = await browser.newContext({
    baseURL: resolved.baseURL,
    viewport: testInfo.project.use.viewport,
    hasTouch: testInfo.project.use.hasTouch,
    isMobile: testInfo.project.use.isMobile,
  });
  const operatorContext = await browser.newContext({
    baseURL: resolved.baseURL,
    viewport: testInfo.project.use.viewport,
    hasTouch: testInfo.project.use.hasTouch,
    isMobile: testInfo.project.use.isMobile,
  });
  const teacherPage = await teacherContext.newPage();
  const operatorPage = await operatorContext.newPage();
  await preparePage(teacherPage);
  await preparePage(operatorPage);
  try {
    await signInUI(teacherPage, teacher);
    await expect(
      teacherPage.locator('section[data-role="teacher-learning"]'),
    ).toBeVisible();
    await assertCloudstep(teacherPage);
    await captureDesignScreen(teacherPage, testInfo, 'teacher', [
      '[data-child-selector="true"]',
    ]);

    await signInUI(operatorPage, operator);
    await expect(
      operatorPage.getByRole('heading', { name: 'Account access desk.' }),
    ).toBeVisible();
    await expect(operatorPage.getByRole('table')).toBeVisible();
    await expect(operatorPage.getByLabel('One-time password')).toHaveValue('');
    await assertCloudstep(operatorPage);
    await captureDesignScreen(operatorPage, testInfo, 'operator', [
      'input[type="password"]',
      'table td:nth-child(2)',
    ]);
  } finally {
    await teacherContext.close();
    await operatorContext.close();
  }
});

test('[S2-AC-006][L-08-cleanup] removes an inactive family link from the operator UI and preserves parent grant cleanup', async ({
  page,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'cleanup');
  const operator = requireAccount(resolved.accounts, 'operator');
  const parentA = requireAccount(resolved.accounts, 'parentA');
  const parentB = requireAccount(resolved.accounts, 'parentB');
  const childA = requireAccount(resolved.accounts, 'childA');
  const childB = requireAccount(resolved.accounts, 'childB');
  const teacher = requireAccount(resolved.accounts, 'teacher');
  const otherTeacher = requireAccount(resolved.accounts, 'otherTeacher');
  await preparePage(page);
  await setupRelations(resolved, {
    secondFamily: true,
    teacherGrant: true,
    otherTeacherGrant: true,
  });

  const operatorAPI = await createAPIClient(
    resolved,
    operator,
    'cleanup operator',
  );
  try {
    const disableChild = await operatorAPI.request.post(
      `/api/pilot/accounts/${encodeURIComponent(childA.id)}/status`,
      { data: { disabled: true }, headers: { Origin: operatorAPI.origin } },
    );
    await apiStatus(disableChild, 200, 'disable child A');

    await signInUI(page, parentA);
    const parentGrant = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Teacher access' }),
    });
    await expect(
      parentGrant.getByText(/child account disabled/i),
    ).toBeVisible();
    const revoke = parentGrant.getByRole('button', { name: 'Revoke' });
    await expect(revoke).toBeEnabled();
    await revoke.click();
    await expect(
      page.getByText('Teacher access revoked.', { exact: true }),
    ).toBeVisible();
    await signOutUI(page);

    const teacherRead = await teacherReadStatus(
      resolved,
      teacher,
      childA.id,
      'teacher after inactive grant revoke',
    );
    expect(teacherRead).toBe(404);

    const disableChildB = await operatorAPI.request.post(
      `/api/pilot/accounts/${encodeURIComponent(childB.id)}/status`,
      { data: { disabled: true }, headers: { Origin: operatorAPI.origin } },
    );
    await apiStatus(disableChildB, 200, 'disable child B');
    await signInUI(page, operator);
    const linkForm = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Save link' }),
    });
    const parentSelect = linkForm.locator('select').nth(0);
    const childSelect = linkForm.locator('select').nth(1);
    await parentSelect.selectOption(parentB.id);
    await childSelect.selectOption(childB.id);
    await expect(childSelect.locator('option:checked')).toContainText(
      'Inactive',
    );
    await expect(
      linkForm.getByRole('button', { name: 'Save link' }),
    ).toBeDisabled();
    await expect(
      linkForm.getByRole('button', { name: 'Remove exact link' }),
    ).toBeEnabled();
    await linkForm.getByRole('button', { name: 'Remove exact link' }).click();
    await expect(
      page.getByText('The exact parent-child link was removed.', {
        exact: true,
      }),
    ).toBeVisible();

    const otherTeacherRead = await teacherReadStatus(
      resolved,
      otherTeacher,
      childB.id,
      'teacher after inactive link removal',
    );
    expect(otherTeacherRead).toBe(404);

    const disableParentB = await operatorAPI.request.post(
      `/api/pilot/accounts/${encodeURIComponent(parentB.id)}/status`,
      { data: { disabled: true }, headers: { Origin: operatorAPI.origin } },
    );
    await apiStatus(disableParentB, 200, 'disable parent B');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(
      parentSelect.locator(`option[value="${parentB.id}"]`),
    ).toContainText('Inactive');
    await expect(
      childSelect.locator(`option[value="${childA.id}"]`),
    ).toContainText('Inactive');
    await expect(
      childSelect.locator(`option[value="${childB.id}"]`),
    ).toContainText('Inactive');
  } finally {
    await operatorAPI.close();
  }
});

async function teacherReadStatus(
  resolved: ResolvedScenario,
  teacher: PilotAccount,
  childId: string,
  label: string,
): Promise<number> {
  const client = await createAPIClient(resolved, teacher, label);
  try {
    const response = await client.request.get(
      `/api/pilot/children/${encodeURIComponent(childId)}/progress`,
    );
    return response.status();
  } finally {
    await client.close();
  }
}
