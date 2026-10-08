import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expect,
  request as requestFactory,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

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

type ResolvedScenario = {
  baseURL: string;
  accounts: Record<AccountKey, PilotAccount>;
};

type APIClient = {
  request: APIRequestContext;
  origin: string;
  close: () => Promise<void>;
};

let syntheticIPCounter = 70;

function object(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nextSyntheticIP() {
  const value = syntheticIPCounter;
  syntheticIPCounter = syntheticIPCounter >= 240 ? 70 : syntheticIPCounter + 1;
  return `198.51.100.${value}`;
}

function accountFrom(value: unknown, key: AccountKey): PilotAccount {
  if (!object(value))
    throw new Error(`pilot fixture account ${key} is missing`);
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
    throw new Error(`pilot fixture account ${key} is invalid`);
  }
  return {
    id: value.id,
    username: value.username,
    password: value.password,
    name: value.name,
    role,
  };
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
  if (!object(parsed) || !object(parsed.groups))
    throw new Error('pilot fixture envelope is invalid');

  const fixture = parsed as unknown as FixtureEnvelope;
  if (
    typeof fixture.candidateId !== 'string' ||
    typeof fixture.testRunId !== 'string' ||
    typeof fixture.baseURL !== 'string'
  ) {
    throw new Error('pilot fixture metadata is invalid');
  }
  const group = fixture.groups[testInfo.project.name];
  if (!object(group))
    throw new Error(
      `pilot fixture group is missing for ${testInfo.project.name}`,
    );
  const scenario = group[name];
  if (!object(scenario))
    throw new Error(`pilot fixture scenario ${name} is missing`);
  const source = object(scenario.accounts) ? scenario.accounts : scenario;
  const accounts = {} as Record<AccountKey, PilotAccount>;
  for (const key of ACCOUNT_KEYS) accounts[key] = accountFrom(source[key], key);
  return { baseURL: fixture.baseURL, accounts };
}

async function preparePage(page: Page) {
  await page.context().setExtraHTTPHeaders({
    'CF-Connecting-IP': nextSyntheticIP(),
  });
}

function browserContextOptions(testInfo: TestInfo, baseURL: string) {
  const { viewport, hasTouch, isMobile } = testInfo.project.use;
  return { baseURL, viewport, hasTouch, isMobile };
}

async function signInUI(page: Page, account: PilotAccount) {
  await page.goto('/pilot');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(
    page.locator('nav[aria-label="Pilot navigation"]'),
  ).toBeVisible();
  await expect(
    page.getByText(`${account.name} ·`, { exact: false }),
  ).toBeVisible();
}

async function signInExpectPasswordChange(
  page: Page,
  account: PilotAccount,
  password = account.password,
) {
  await page.goto('/pilot');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(
    page.getByRole('heading', {
      name: `Choose a private password, ${account.name}.`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('section[data-role]')).toHaveCount(0);
}

async function signOutUI(page: Page) {
  await page
    .locator('nav[aria-label="Pilot navigation"]')
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
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
      'CF-Connecting-IP': nextSyntheticIP(),
    },
  });
  try {
    const response = await request.post('/api/auth/sign-in/username', {
      data: { username: account.username, password: account.password },
      headers: { Origin: origin },
    });
    expect(response.status(), `${label} sign-in status`).toBe(200);
    return { request, origin, close: () => request.dispose() };
  } catch (error) {
    await request.dispose();
    throw error;
  }
}

async function establishLink(
  resolved: ResolvedScenario,
  parent: PilotAccount,
  child: PilotAccount,
) {
  const operator = await createAPIClient(
    resolved,
    resolved.accounts.operator,
    'operator link setup',
  );
  try {
    const response = await operator.request.post('/api/pilot/links', {
      data: { parentId: parent.id, childId: child.id },
      headers: { Origin: operator.origin },
    });
    expect([200, 201]).toContain(response.status());
  } finally {
    await operator.close();
  }
}

async function teacherReadStatus(
  resolved: ResolvedScenario,
  teacher: PilotAccount,
  childId: string,
) {
  const client = await createAPIClient(resolved, teacher, 'teacher read check');
  try {
    const response = await client.request.get(
      `/api/pilot/children/${encodeURIComponent(childId)}/progress`,
    );
    return response.status();
  } finally {
    await client.close();
  }
}

function accountRow(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name }).last();
}

function issueForm(page: Page) {
  return page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: /^Issue account/ }) })
    .first();
}

test('[S2-AC-003][E-account-password] requires first password change before home and rejects the old password', async ({
  page,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'password');
  const child = resolved.accounts.childA;
  const replacementPassword = resolved.accounts.childB.password;
  await preparePage(page);

  await signInExpectPasswordChange(page, child);
  await expect(
    page.getByRole('heading', { name: 'Your learning' }),
  ).toHaveCount(0);
  await page
    .getByLabel('Current password', { exact: true })
    .fill(child.password);
  await page
    .getByLabel('New password', { exact: true })
    .fill(replacementPassword);
  await page
    .getByLabel('Repeat new password', { exact: true })
    .fill(replacementPassword);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(
    page.getByText('Password changed. Your invited account is ready.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator('section[data-role="child-learning"]'),
  ).toBeVisible();

  await signOutUI(page);
  await page.getByLabel('Username', { exact: true }).fill(child.username);
  await page.getByLabel('Password', { exact: true }).fill(child.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Your username or password was not accepted.',
  );
  await expect(page.locator('section[data-role]')).toHaveCount(0);

  await page.getByLabel('Password', { exact: true }).fill(replacementPassword);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(
    page.locator('section[data-role="child-learning"]'),
  ).toBeVisible();
  await signOutUI(page);
});

test('[S2-AC-001][S2-AC-002][S2-AC-003][S2-AC-005][E-account-operator] issues, resets and disables an account through the operator UI', async ({
  page,
  browser,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'accounts');
  const operator = resolved.accounts.operator;
  const issuedPassword = resolved.accounts.childA.password;
  const resetPassword = resolved.accounts.childB.password;
  const issuedUsername = `i.${resolved.accounts.childA.username}`;
  const issuedName = 'Synthetic issued child';
  await preparePage(page);
  await signInUI(page, operator);
  await expect(
    page.getByRole('heading', { name: 'Account access desk.' }),
  ).toBeVisible();

  const issue = issueForm(page);
  await issue.getByLabel('Username').fill(issuedUsername);
  await issue.getByLabel('Display name').fill(issuedName);
  await issue.getByLabel('Role').selectOption('child');
  await issue.getByLabel('One-time password').fill(issuedPassword);
  await issue.getByRole('button', { name: /^Issue account/ }).click();
  await expect(
    page.getByText(
      'Account issued. Share the username and one-time password through your private operator process.',
      { exact: true },
    ),
  ).toBeVisible();

  const issuedRow = accountRow(page, issuedName);
  await expect(issuedRow).toBeVisible();
  await expect(issuedRow).toContainText(issuedUsername);
  await expect(issuedRow).not.toContainText(/@[^\s]+\.invalid/);

  const childContext = await browser.newContext(
    browserContextOptions(testInfo, resolved.baseURL),
  );
  const childPage = await childContext.newPage();
  await preparePage(childPage);
  try {
    const issuedAccount = {
      id: 'issued-account',
      username: issuedUsername,
      password: issuedPassword,
      name: issuedName,
      role: 'child' as const,
    };
    await signInExpectPasswordChange(childPage, issuedAccount);

    await issuedRow.getByRole('button', { name: /^Reset$/ }).click();
    await issuedRow
      .getByPlaceholder('New one-time password')
      .fill(resetPassword);
    await issuedRow.getByRole('button', { name: 'Save reset' }).click();
    await expect(
      page.getByText(
        `${issuedName} must choose a new password at next sign-in.`,
        { exact: true },
      ),
    ).toBeVisible();

    // Reset revokes the first session. The page must return to sign-in before
    // the reset credential is accepted, rather than retaining the old view.
    await childPage.reload();
    await expect(
      childPage.getByRole('heading', { name: 'Sign in' }),
    ).toBeVisible();
    await signInExpectPasswordChange(childPage, issuedAccount, resetPassword);

    const currentRow = accountRow(page, issuedName);
    await currentRow.getByRole('button', { name: 'Disable' }).click();
    await expect(
      page.getByText(`${issuedName} is disabled and signed out.`, {
        exact: true,
      }),
    ).toBeVisible();
    const disabledRow = accountRow(page, issuedName);
    await expect(
      disabledRow.getByText('Disabled', { exact: true }),
    ).toBeVisible();

    // Disablement revokes the still-open reset session. A reload must not
    // restore the password-change screen or an operator-issued learner view.
    await childPage.reload();
    await expect(
      childPage.getByRole('heading', { name: 'Sign in' }),
    ).toBeVisible();
    await expect(childPage.locator('section[data-role]')).toHaveCount(0);
  } finally {
    await childContext.close();
  }
});

test('[S2-AC-004][S2-AC-006][E-account-grant] grants and revokes teacher access through the parent UI', async ({
  page,
  browser,
}, testInfo) => {
  const resolved = await loadScenario(testInfo, 'grant');
  const parent = resolved.accounts.parentA;
  const child = resolved.accounts.childA;
  const teacher = resolved.accounts.teacher;
  await preparePage(page);
  await establishLink(resolved, parent, child);

  await signInUI(page, parent);
  const parentGrant = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Teacher access' }),
  });
  await expect(parentGrant).toBeVisible();
  await parentGrant.getByLabel('Teacher ID').fill(teacher.id);
  await parentGrant.getByRole('button', { name: 'Grant read access' }).click();
  await expect(
    parentGrant.getByText('Teacher access granted for this child.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    parentGrant.getByRole('button', { name: 'Revoke' }),
  ).toBeVisible();

  const teacherContext = await browser.newContext(
    browserContextOptions(testInfo, resolved.baseURL),
  );
  const teacherPage = await teacherContext.newPage();
  await preparePage(teacherPage);
  try {
    await signInUI(teacherPage, teacher);
    const teacherPanel = teacherPage.locator(
      'section[data-role="teacher-learning"]',
    );
    await expect(teacherPanel).toBeVisible();
    await expect(
      teacherPanel.locator('select[data-child-selector="true"] option'),
    ).toContainText(child.name);

    await parentGrant.getByRole('button', { name: 'Revoke' }).click();
    await expect(
      parentGrant.getByText('Teacher access revoked.', { exact: true }),
    ).toBeVisible();

    // The teacher session remains valid, but the next identity/read projection
    // must remove the child and the server must deny the learner read.
    await teacherPage.reload();
    await expect(
      teacherPage.getByText(
        'No learners have been shared with this teacher yet.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      teacherPage.locator(
        'section[data-role="teacher-learning"] select[data-child-selector="true"] option',
      ),
    ).toHaveCount(0);
    expect(await teacherReadStatus(resolved, teacher, child.id)).toBe(404);
  } finally {
    await teacherContext.close();
  }
});
