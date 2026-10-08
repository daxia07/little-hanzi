import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';

type AccountRole = 'operator' | 'parent' | 'child' | 'teacher';

type PilotAccount = {
  id: string;
  username: string;
  password: string;
  name: string;
  role: AccountRole;
};

type RecordValue = Record<string, unknown>;

type FixtureEnvelope = {
  candidateId: string;
  testRunId: string;
  baseURL: string;
  groups: Record<string, unknown>;
};

function object(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function account(value: unknown, key: string): PilotAccount {
  if (!object(value)) throw new Error(`pilot account ${key} is unavailable`);
  const role = value.role;
  if (
    typeof value.id !== 'string' ||
    typeof value.username !== 'string' ||
    typeof value.password !== 'string' ||
    typeof value.name !== 'string' ||
    (role !== 'operator' &&
      role !== 'parent' &&
      role !== 'child' &&
      role !== 'teacher')
  ) {
    throw new Error(`pilot account ${key} is invalid`);
  }
  return {
    id: value.id,
    username: value.username,
    password: value.password,
    name: value.name,
    role,
  };
}

async function loadScenario(testInfo: TestInfo, name: string) {
  const fixturePath = process.env.HANZI_PILOT_FIXTURES;
  if (!fixturePath) throw new Error('HANZI_PILOT_FIXTURES is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fixturePath, 'utf8'));
  } catch {
    throw new Error('pilot browser fixture could not be read');
  }
  if (!object(parsed) || !object(parsed.groups))
    throw new Error('pilot browser fixture envelope is invalid');
  const fixture = parsed as unknown as FixtureEnvelope;
  const group = fixture.groups[testInfo.project.name];
  if (!object(group))
    throw new Error(
      `pilot fixture group is missing for ${testInfo.project.name}`,
    );
  const scenario = group[name];
  if (!object(scenario))
    throw new Error(`pilot fixture scenario ${name} is missing`);
  const source = object(scenario.accounts) ? scenario.accounts : scenario;
  return {
    fixture,
    baseURL: fixture.baseURL,
    operator: account(source.operator, 'operator'),
    parentA: account(source.parentA, 'parentA'),
  };
}

let syntheticIP = 112;

async function preparePage(page: Page) {
  await page.context().setExtraHTTPHeaders({
    'CF-Connecting-IP': `198.51.100.${syntheticIP++}`,
  });
}

async function signIn(page: Page, user: PilotAccount) {
  await page.goto('/pilot');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(
    page.locator('nav[aria-label="Pilot navigation"]'),
  ).toBeVisible();
  await expect(
    page.getByText(`${user.name} ·`, { exact: false }),
  ).toBeVisible();
}

async function signOut(page: Page) {
  await page
    .locator('nav[aria-label="Pilot navigation"]')
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

function versionFor(testInfo: TestInfo, scenario: string): string {
  const project = testInfo.project.name.replace(/^pilot-/, '');
  return `forest-01-v2-rd-${project}-${scenario}`;
}

async function fixtureFor(testInfo: TestInfo, scenario: string) {
  const fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/curriculum/forest-01-v2.json', import.meta.url),
      'utf8',
    ),
  ) as RecordValue;
  const version = versionFor(testInfo, scenario);
  fixture.lessonVersion = version;
  fixture.title = `Synthetic review desk ${scenario}`;
  return { fixture, version };
}

function desk(page: Page) {
  return page.locator('section[aria-labelledby="review-desk-title"]');
}

function packageRow(page: Page, version: string) {
  return desk(page).getByRole('button').filter({ hasText: version }).first();
}

async function importFixture(
  page: Page,
  testInfo: TestInfo,
  scenario: string,
): Promise<string> {
  const { fixture, version } = await fixtureFor(testInfo, scenario);
  const reviewDesk = desk(page);
  await expect(reviewDesk).toBeVisible();
  await reviewDesk.getByLabel('Package JSON').fill(JSON.stringify(fixture));
  await reviewDesk.getByRole('button', { name: 'Import package' }).click();
  await expect(
    page.getByText(
      'Package imported. Content review and release remain separate.',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(packageRow(page, version)).toContainText(version);
  await expect(
    page.getByText('Exact package inspection', { exact: true }),
  ).toBeVisible();
  return version;
}

async function fillReview(
  page: Page,
  values: { reason: string; evidence: string; reviewer?: string },
) {
  await page.getByLabel('Decision', { exact: true }).selectOption('rejected');
  await page
    .getByLabel('Reviewer reference', { exact: true })
    .fill(values.reviewer ?? 'Synthetic browser reviewer');
  await page
    .getByLabel('Decision time (UTC)', { exact: true })
    .fill('2026-09-25T05:20');
  await page
    .getByLabel('Evidence reference', { exact: true })
    .fill(values.evidence);
  await page
    .getByLabel('Reason or correction note', { exact: true })
    .fill(values.reason);
}

function reviewHistory(page: Page) {
  return page.locator('section[aria-labelledby="review-history-title"]');
}

function requestHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

test('[S3-RD-AC-002][S3-RD-AC-003][S3-RD-AC-008][E-review-import] imports and inspects an exact synthetic package without release claims', async ({
  page,
}, testInfo) => {
  const scenario = await loadScenario(testInfo, 'journey');
  await preparePage(page);
  await signIn(page, scenario.operator);

  const version = await importFixture(page, testInfo, 'journey');
  const row = packageRow(page, version);
  await expect(row).toContainText('Test fixture');
  await expect(
    page.getByText(
      'This package and its reviews are excluded from trusted coverage.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Trusted release proof is unavailable.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('No review decision has been recorded.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('木', { exact: true })).toBeVisible();
  await expect(page.getByText('林', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/learner-selectable|owner approval|released lesson/i),
  ).toHaveCount(0);
});

test('[S3-RD-AC-004][S3-RD-AC-005][S3-RD-AC-008][E-review-correction] records an explicit rejection and appends a correction without editing history', async ({
  page,
}, testInfo) => {
  const scenario = await loadScenario(testInfo, 'cleanup');
  await preparePage(page);
  await signIn(page, scenario.operator);
  await importFixture(page, testInfo, 'cleanup');

  await fillReview(page, {
    evidence: 'synthetic-browser/rejection-1',
    reason: 'Synthetic fixture rejection before a correction.',
  });
  await page.getByRole('button', { name: 'Record review decision' }).click();
  await expect(
    page.getByText('Review decision saved. This does not release the lesson.', {
      exact: true,
    }),
  ).toBeVisible();
  const history = reviewHistory(page);
  await expect(history.locator('article')).toHaveCount(1);
  await expect(
    history.getByText('Rejected review decision', { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText('Synthetic fixture rejection before a correction.', {
      exact: true,
    }),
  ).toBeVisible();

  await fillReview(page, {
    evidence: 'synthetic-browser/rejection-2',
    reason: 'Synthetic correction keeps the package outside release.',
  });
  await page.getByRole('button', { name: 'Record review decision' }).click();
  await expect(history.locator('article')).toHaveCount(2);
  await expect(history.getByText('Review 1', { exact: true })).toBeVisible();
  await expect(history.getByText('Review 2', { exact: true })).toBeVisible();
  await expect(
    history.getByText('Synthetic fixture rejection before a correction.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    history.getByText(
      'Synthetic correction keeps the package outside release.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /edit|delete/i })).toHaveCount(
    0,
  );
});

test('[S3-RD-AC-006][E-review-retry] retries a post-response network loss with the exact saved request body', async ({
  page,
}, testInfo) => {
  const scenario = await loadScenario(testInfo, 'recovery');
  await preparePage(page);
  await signIn(page, scenario.operator);
  await importFixture(page, testInfo, 'recovery');
  await fillReview(page, {
    evidence: 'synthetic-browser/retry',
    reason: 'Synthetic rejection used to verify exact retry handling.',
  });

  const reviewRoute = '**/api/pilot/curriculum/*/reviews';
  let first = true;
  const requestHashes: string[] = [];
  const upstreamStatuses: number[] = [];
  const routeHandler = async (route: Route) => {
    const body = route.request().postData() ?? '';
    requestHashes.push(requestHash(body));
    if (first) {
      first = false;
      const upstream = await route.fetch();
      upstreamStatuses.push(upstream.status());
      // The Worker has completed the write. Hide only the response from the
      // browser so the controller must use its frozen body on retry.
      await route.abort('connectionclosed');
      return;
    }
    await route.continue();
  };
  await page.route(reviewRoute, routeHandler);
  try {
    await page.getByRole('button', { name: 'Record review decision' }).click();
    await expect(
      page.getByRole('button', { name: 'Retry saved review' }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('could not be reached');

    await page.getByRole('button', { name: 'Retry saved review' }).click();
    await expect(
      page.getByText('This exact review decision was already saved.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(reviewHistory(page).locator('article')).toHaveCount(1);
  } finally {
    await page.unroute(reviewRoute, routeHandler);
  }
  expect(upstreamStatuses[0]).toBe(201);
  expect(requestHashes).toHaveLength(2);
  expect(requestHashes[1]).toBe(requestHashes[0]);
});

test('[S3-RD-AC-006][S3-RD-AC-007][E-review-focus] preserves an in-memory draft through same-context focus revalidation', async ({
  page,
}, testInfo) => {
  const scenario = await loadScenario(testInfo, 'signout');
  await preparePage(page);
  await signIn(page, scenario.operator);
  await importFixture(page, testInfo, 'signout');
  const privateReason = 'Synthetic in-memory correction note';
  const privateEvidence = 'synthetic-browser/focus-draft';
  await fillReview(page, { evidence: privateEvidence, reason: privateReason });

  const meResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith('/api/pilot/me'),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await meResponse).status()).toBe(200);
  await expect(
    page.getByLabel('Reason or correction note', { exact: true }),
  ).toHaveValue(privateReason);
  await expect(
    page.getByLabel('Evidence reference', { exact: true }),
  ).toHaveValue(privateEvidence);
  const stored = await page.evaluate(() =>
    [...Object.values(localStorage), ...Object.values(sessionStorage)].join(
      '\n',
    ),
  );
  expect(stored).not.toContain(privateReason);
  expect(stored).not.toContain(privateEvidence);
});

test('[S3-RD-AC-006][S3-RD-AC-007][E-review-switch] clears private review state after the browser switches to another ordinary account', async ({
  page,
}, testInfo) => {
  const scenario = await loadScenario(testInfo, 'switch');
  await preparePage(page);
  await signIn(page, scenario.operator);
  await importFixture(page, testInfo, 'switch');
  const privateReason = 'Synthetic private draft cleared on account switch';
  await fillReview(page, {
    evidence: 'synthetic-browser/account-switch',
    reason: privateReason,
  });

  await signOut(page);
  await expect(page.getByText(privateReason, { exact: true })).toHaveCount(0);
  await signIn(page, scenario.parentA);
  await expect(page.getByRole('heading', { name: 'Review desk.' })).toHaveCount(
    0,
  );
  await expect(page.getByText(privateReason, { exact: true })).toHaveCount(0);
});

test('[S3-RD-AC-009][E-review-design] keeps the review desk keyboard-visible, touch-sized and reduced-motion safe at desktop and tablet widths', async ({
  page,
}, testInfo) => {
  const scenario = await loadScenario(testInfo, 'design');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await preparePage(page);
  await signIn(page, scenario.operator);
  await importFixture(page, testInfo, 'design');

  const reviewDesk = desk(page);
  const decision = page.getByLabel('Decision', { exact: true });
  if (testInfo.project.name === 'pilot-webkit') await decision.tap();
  await decision.focus();
  await expect(decision).toBeFocused();
  const focusStyle = await decision.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focusStyle.outlineStyle).toBe('solid');
  expect(focusStyle.outlineWidth).toBe('3px');
  await page.keyboard.press('Tab');
  await expect(
    page.getByLabel('Reviewer reference', { exact: true }),
  ).toBeFocused();

  const action = page.getByRole('button', { name: 'Record review decision' });
  const box = await action.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  const motion = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animation: style.animationDuration,
      transition: style.transitionDuration,
    };
  });
  expect(motion.animation).toBe('0s');
  expect(motion.transition).toBe('0s');

  const layout = reviewDesk.locator('[class*="reviewDeskLayout"]').first();
  const columns = await layout.evaluate(
    (element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(columns).toBe(testInfo.project.name === 'pilot-webkit' ? 1 : 2);

  await page.screenshot({
    path: testInfo.outputPath(`curriculum-review-${testInfo.project.name}.png`),
    animations: 'disabled',
    mask: [page.locator('input[type="password"]')],
  });
});
