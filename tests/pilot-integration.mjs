import { signOutPilot } from '../lib/pilot-client.ts';

/*
 * Sprint 2 ordinary-credential integration probe.
 *
 * The runner starts a fresh pilot Worker/D1 database and seeds the accounts
 * passed to runPilotIntegration. This file deliberately uses fetch and a
 * small cookie jar instead of application clients so the checks exercise the
 * HTTP boundary, session cookies, and server authorization directly.
 */

const JSON_HEADERS = { Accept: 'application/json' };
let nextSyntheticIP = 1;

function syntheticIP() {
  const value = nextSyntheticIP;
  nextSyntheticIP = (nextSyntheticIP % 240) + 1;
  return `198.51.100.${value}`;
}

class CookieJar {
  #cookies = new Map();

  headerValue() {
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  attach(headers) {
    const value = this.headerValue();
    if (value) headers.set('Cookie', value);
  }

  store(response) {
    const values = responseSetCookies(response);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!cookieValue) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
  }
}

function responseSetCookies(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : splitSetCookie(response.headers.get('set-cookie') || '');
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]*)/g);
}

function requireSessionCookieFlags(response, label) {
  const cookies = responseSetCookies(response);
  const sessionCookie =
    cookies.find((value) => /(?:session|auth)/i.test(value.split('=', 1)[0])) ||
    cookies[0];
  requireCondition(
    Boolean(sessionCookie),
    `${label} did not set a session cookie`,
  );
  requireCondition(
    /;\s*httponly(?:;|$)/i.test(sessionCookie),
    `${label} cookie is not HttpOnly`,
  );
  requireCondition(
    /;\s*samesite=lax(?:;|$)/i.test(sessionCookie),
    `${label} cookie SameSite is not Lax`,
  );
  requireCondition(
    /;\s*path=\/(?:;|$)/i.test(sessionCookie),
    `${label} cookie Path is not /`,
  );
}

class DependencyBlockedError extends Error {
  constructor(message) {
    super(`BLOCKED: ${message}`);
    this.name = 'DependencyBlockedError';
  }
}

function requireDependency(condition, message) {
  if (!condition) throw new DependencyBlockedError(message);
}

async function dependencyCall(callback, label, ...args) {
  requireDependency(
    typeof callback === 'function',
    `${label} callback is required`,
  );
  try {
    return await callback(...args);
  } catch {
    throw new DependencyBlockedError(`${label} callback failed`);
  }
}

class PilotClient {
  constructor(baseURL, ipAddress = syntheticIP()) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.ipAddress = ipAddress;
    this.cookies = new CookieJar();
  }

  cookieHeader() {
    return this.cookies.headerValue();
  }

  async request(
    path,
    { method = 'GET', body, origin = this.origin, headers = {} } = {},
  ) {
    const requestHeaders = new Headers({ ...JSON_HEADERS, ...headers });
    // The local pilot runner has no reverse proxy, so Better Auth would place
    // every request in one localhost rate-limit bucket. These TEST-NET-2
    // addresses model separate synthetic clients for the HTTP matrix; they do
    // not affect authentication or authorization decisions.
    if (!requestHeaders.has('X-Forwarded-For'))
      requestHeaders.set('X-Forwarded-For', this.ipAddress);
    if (!requestHeaders.has('CF-Connecting-IP'))
      requestHeaders.set('CF-Connecting-IP', this.ipAddress);
    if (body !== undefined) {
      requestHeaders.set('Content-Type', 'application/json');
    }
    if (origin !== null) requestHeaders.set('Origin', origin);
    this.cookies.attach(requestHeaders);
    const request = {
      method,
      headers: requestHeaders,
      redirect: 'manual',
    };
    if (body !== undefined) request.body = JSON.stringify(body);
    const response = await fetch(`${this.baseURL}${path}`, request);
    this.cookies.store(response);
    return response;
  }
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dataBody(body) {
  if (!object(body)) return {};
  return object(body.data) ? body.data : body;
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function errorMessage(response) {
  const body = await jsonBody(response);
  if (!object(body)) return '';
  const error = object(body.error) ? body.error : body;
  return typeof error.message === 'string' ? error.message : '';
}

async function requirePilotError(response, status, code, label) {
  requireStatus(response, status, label);
  const body = await jsonBody(response);
  const root = dataBody(body);
  const error = object(root.error) ? root.error : root;
  requireCondition(
    object(error) && error.code === code && typeof error.message === 'string',
    `${label} did not return ${code}`,
  );
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireStatus(response, expected, label) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  requireCondition(
    statuses.includes(response.status),
    `${label} returned HTTP ${response.status}`,
  );
}

function requireSuccess(response, label) {
  requireCondition(
    response.status >= 200 && response.status < 300,
    `${label} returned HTTP ${response.status}`,
  );
}

function requireDenied(response, label) {
  requireCondition(
    [401, 403, 404].includes(response.status),
    `${label} was not denied (HTTP ${response.status})`,
  );
}

function collectStrings(value, key = '') {
  const output = [];
  if (typeof value === 'string') output.push({ key, value });
  else if (Array.isArray(value))
    value.forEach((item) => output.push(...collectStrings(item, key)));
  else if (object(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      output.push(...collectStrings(childValue, childKey));
    }
  }
  return output;
}

function requireSafePilotJSON(body, label) {
  requireCondition(
    body !== null && object(body),
    `${label} did not return a JSON object`,
  );
  const forbiddenKey = /(?:password|hash|token|secret|email)/i;
  const forbiddenValue = /@[^\s"']+\.invalid\b/i;
  for (const { key, value } of collectStrings(body)) {
    requireCondition(
      key === 'mustChangePassword' || !forbiddenKey.test(key),
      `${label} returned a credential field`,
    );
    requireCondition(
      !forbiddenValue.test(value),
      `${label} returned an internal email`,
    );
  }
}

function unwrapAccountID(body) {
  const root = dataBody(body);
  const candidates = [root, root.account, root.user, root.data];
  for (const candidate of candidates) {
    if (object(candidate) && typeof candidate.id === 'string' && candidate.id)
      return candidate.id;
  }
  return '';
}

function accountRows(body) {
  const root = dataBody(body);
  if (Array.isArray(root.accounts)) return root.accounts;
  if (Array.isArray(body)) return body;
  return [];
}

function childIDs(body) {
  const root = dataBody(body);
  return Array.isArray(root.children)
    ? root.children
        .filter((child) => object(child) && typeof child.id === 'string')
        .map((child) => child.id)
    : [];
}

function grantRows(body) {
  const root = dataBody(body);
  return Array.isArray(root.grants) ? root.grants.filter(object) : [];
}

function collectKeys(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, output));
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectKeys(child, output);
    }
  }
  return output;
}

function requireAuditEvidence(rows, expected, secrets) {
  requireCondition(
    Array.isArray(rows) && rows.length > 0,
    'audit query returned no rows',
  );
  const forbiddenKey = /(?:password|hash|token|secret)/i;
  for (const row of rows) {
    requireCondition(object(row), 'audit query returned a malformed row');
    for (const key of [
      'id',
      'action',
      'actor_user_id',
      'target_user_id',
      'metadata',
      'created_at',
    ]) {
      requireCondition(
        Object.hasOwn(row, key),
        'audit row omitted required fields',
      );
    }
    requireCondition(
      typeof row.action === 'string' && row.action.length > 0,
      'audit row omitted action',
    );
    requireCondition(
      typeof row.target_user_id === 'string' && row.target_user_id.length > 0,
      'audit row omitted target',
    );
    requireCondition(
      typeof row.metadata === 'string',
      'audit row metadata is not serialized JSON',
    );
    let metadata;
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      throw new Error('audit row metadata is invalid JSON');
    }
    requireCondition(
      !collectKeys(metadata).some((key) => forbiddenKey.test(key)),
      'audit metadata contains a credential key',
    );
    const serialized = JSON.stringify(row);
    for (const secret of secrets) {
      requireCondition(
        typeof secret !== 'string' || !secret || !serialized.includes(secret),
        'audit row contains a plaintext secret',
      );
    }
  }
  for (const item of expected) {
    const match = rows.find(
      (row) =>
        row.action === item.action &&
        row.actor_user_id === item.actor &&
        row.target_user_id === item.target,
    );
    requireCondition(
      Boolean(match),
      `audit action ${item.action} omitted its actor or target`,
    );
  }
}

function userRecord(body) {
  const root = dataBody(body);
  return object(root.user) ? root.user : {};
}

function makeUsername() {
  return `s2qa${Date.now().toString(36).slice(-10)}`.slice(0, 30);
}

function makePassword(suffix = '') {
  return `PilotQA-${Date.now().toString(36)}-${suffix || 'reset'}-x`;
}

function accountValue(accounts, key) {
  const account = accounts?.[key];
  requireCondition(
    object(account) &&
      typeof account.id === 'string' &&
      typeof account.username === 'string' &&
      typeof account.password === 'string',
    `seed account ${key} is unavailable`,
  );
  return account;
}

function sanitizeMessage(error, accounts, secrets = []) {
  let message =
    error instanceof Error
      ? error.message
      : 'pilot integration assertion failed';
  const values = [
    ...Object.values(accounts || {}).flatMap((account) =>
      object(account) ? [account.id, account.username, account.password] : [],
    ),
    ...secrets,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const value of values) message = message.split(value).join('[redacted]');
  return message.replace(
    /(password|token|secret|hash|email)[^\s]*/gi,
    '[redacted]',
  );
}

async function login(
  client,
  account,
  { checkCookie = false, label = 'username sign-in' } = {},
) {
  const response = await client.request('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username: account.username, password: account.password },
  });
  requireSuccess(response, label);
  if (checkCookie) requireSessionCookieFlags(response, label);
  requireSafePilotJSON(await jsonBody(response), `${label} response`);
  return response;
}

async function readMe(client, label) {
  const response = await client.request('/api/pilot/me');
  requireStatus(response, 200, `${label} GET /api/pilot/me`);
  const body = await jsonBody(response);
  requireSafePilotJSON(body, `${label} /api/pilot/me`);
  const user = userRecord(body);
  requireCondition(
    typeof user.id === 'string' && typeof user.role === 'string',
    `${label} me response omitted safe user identity`,
  );
  return { body, user };
}

async function readChild(client, childID, label, expectedStatus = 200) {
  const response = await client.request(
    `/api/pilot/children/${encodeURIComponent(childID)}`,
  );
  requireStatus(response, expectedStatus, `${label} GET child`);
  if (expectedStatus === 200)
    requireSafePilotJSON(await jsonBody(response), `${label} child response`);
  return response;
}

async function runCase(id, action, accounts, secrets = []) {
  try {
    await action();
    return { id, status: 'PASS' };
  } catch (error) {
    return {
      id,
      status: error instanceof DependencyBlockedError ? 'BLOCKED' : 'FAIL',
      message: sanitizeMessage(error, accounts, secrets),
    };
  }
}

/**
 * Run the Sprint 2 ordinary-account HTTP matrix against a fresh pilot Worker.
 * The callback returns one result per independent acceptance slice so the
 * runner can retain useful evidence even when a later slice is blocked by an
 * earlier backend defect.
 */
export async function runPilotIntegration({
  baseURL,
  accounts,
  restart,
  testToken,
  expireSessions,
  inspectAudit,
  setAuditAvailable,
}) {
  const clients = new Map();
  const state = {
    temporary: null,
    temporaryClient: null,
    relationshipsReady: false,
    seedSessionsReady: false,
    operatorReady: false,
    invalidCredentials: null,
    faultAccount: null,
    temporarySecrets: [],
  };
  const clientFor = (key) => {
    if (!clients.has(key)) clients.set(key, new PilotClient(baseURL));
    return clients.get(key);
  };
  const accountFor = (key) => accountValue(accounts, key);
  const results = [];

  results.push(
    await runCase(
      'S2-AC-001-anonymous-auth',
      async () => {
        const anonymous = new PilotClient(baseURL);
        for (const [path, label] of [
          ['/api/pilot/me', 'anonymous me'],
          ['/api/pilot/accounts', 'anonymous accounts'],
          [
            `/api/pilot/children/${encodeURIComponent(accountFor('childA').id)}`,
            'anonymous child',
          ],
        ]) {
          const response = await anonymous.request(path);
          requireStatus(response, 401, label);
        }
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-001-auth-allowlist-and-uniform-errors',
      async () => {
        const anonymous = new PilotClient(baseURL);
        const disallowed = [
          ['POST', '/api/auth/sign-up/username'],
          ['POST', '/api/auth/sign-up/email'],
          ['POST', '/api/auth/sign-in/email'],
          ['GET', '/api/auth/sign-out'],
          ['GET', '/api/auth/sign-in/username'],
          ['GET', '/api/auth/is-username-available'],
        ];
        for (const [method, path] of disallowed) {
          const response = await anonymous.request(path, {
            method,
            body: method === 'POST' ? {} : undefined,
          });
          requireStatus(response, 404, `unneeded auth route ${method} ${path}`);
        }

        const known = accountFor('operator');
        const wrong = await anonymous.request('/api/auth/sign-in/username', {
          method: 'POST',
          body: { username: known.username, password: makePassword('wrong') },
        });
        const unknown = await anonymous.request('/api/auth/sign-in/username', {
          method: 'POST',
          body: {
            username: `unknown${Date.now().toString(36)}`,
            password: makePassword('wrong'),
          },
        });
        requireStatus(wrong, 401, 'known username with wrong password');
        requireStatus(unknown, 401, 'unknown username');
        const wrongMessage = await errorMessage(wrong);
        const unknownMessage = await errorMessage(unknown);
        requireCondition(
          Boolean(wrongMessage) && wrongMessage === unknownMessage,
          'invalid username and password errors are not uniform',
        );
        state.invalidCredentials = {
          status: wrong.status,
          message: wrongMessage,
        };
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-002-sign-in-rate-limit',
      async () => {
        const rateLimited = new PilotClient(baseURL);
        const account = accountFor('operator');
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          const response = await rateLimited.request(
            '/api/auth/sign-in/username',
            {
              method: 'POST',
              body: {
                username: account.username,
                password: makePassword(`rate-${attempt}`),
              },
            },
          );
          requireStatus(
            response,
            401,
            `rate-limit preflight attempt ${attempt}`,
          );
        }
        const limited = await rateLimited.request(
          '/api/auth/sign-in/username',
          {
            method: 'POST',
            body: {
              username: account.username,
              password: makePassword('rate-limit'),
            },
          },
        );
        requireStatus(limited, 429, 'single synthetic client rate limit');
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-003-public-json-safety',
      async () => {
        const operator = clientFor('operator');
        await login(operator, accountFor('operator'));
        state.operatorReady = true;
        const me = await operator.request('/api/pilot/me');
        requireStatus(me, 200, 'operator me');
        requireSafePilotJSON(await jsonBody(me), 'operator me');
        const list = await operator.request('/api/pilot/accounts');
        requireStatus(list, 200, 'operator account list');
        const body = await jsonBody(list);
        requireSafePilotJSON(body, 'operator account list');
        requireCondition(
          accountRows(body).every(
            (row) =>
              object(row) &&
              typeof row.id === 'string' &&
              typeof row.username === 'string',
          ),
          'account list omitted safe metadata',
        );
        const session = await operator.request('/api/auth/get-session');
        requireStatus(session, 200, 'operator session');
        requireSafePilotJSON(await jsonBody(session), 'operator session');
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-002-origin-rejection',
      async () => {
        const operator = clientFor('operator');
        const username = makeUsername();
        const response = await operator.request('/api/pilot/accounts', {
          method: 'POST',
          origin: 'https://origin-not-configured.invalid',
          body: {
            username,
            name: 'Rejected Origin Account',
            password: makePassword('origin'),
            role: 'child',
          },
        });
        requireDenied(response, 'wrong-origin account issuance');
        const list = await operator.request('/api/pilot/accounts');
        const rows = accountRows(await jsonBody(list));
        requireCondition(
          !rows.some((row) => object(row) && row.username === username),
          'wrong-origin mutation created an account',
        );
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-001-initial-roles-and-password-state',
      async () => {
        for (const key of [
          'operator',
          'parentA',
          'parentB',
          'childA',
          'childB',
          'teacher',
          'otherTeacher',
        ]) {
          const client = clientFor(key);
          await login(client, accountFor(key));
          const { user } = await readMe(client, key);
          requireCondition(
            user.id === accountFor(key).id,
            `${key} session identity mismatch`,
          );
          requireCondition(
            user.role === expectedRole(key),
            `${key} role mismatch`,
          );
          requireCondition(
            user.mustChangePassword === false,
            `${key} unexpectedly requires a password change`,
          );
        }
        state.seedSessionsReady = true;
        state.operatorReady = true;
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-005-operator-provisioning-and-links',
      async () => {
        const operator = clientFor('operator');
        const temporary = {
          username: makeUsername(),
          password: makePassword('issued'),
          resetPassword: makePassword('reset'),
          name: 'Temporary QA Child',
          role: 'child',
        };
        state.temporarySecrets.push(
          temporary.username,
          temporary.password,
          temporary.resetPassword,
        );
        const issued = await operator.request('/api/pilot/accounts', {
          method: 'POST',
          body: {
            username: temporary.username,
            name: temporary.name,
            password: temporary.password,
            role: temporary.role,
          },
        });
        requireStatus(issued, [200, 201], 'operator account issue');
        const issuedBody = await jsonBody(issued);
        requireSafePilotJSON(issuedBody, 'issued account');
        const temporaryID = unwrapAccountID(issuedBody);
        requireCondition(
          Boolean(temporaryID),
          'issued account omitted its opaque ID',
        );
        state.temporary = { ...temporary, id: temporaryID };

        const duplicate = await operator.request('/api/pilot/accounts', {
          method: 'POST',
          body: {
            username: temporary.username,
            name: temporary.name,
            password: temporary.password,
            role: temporary.role,
          },
        });
        requireCondition(
          [400, 409].includes(duplicate.status),
          'duplicate account issuance was accepted',
        );
        const duplicateList = await operator.request('/api/pilot/accounts');
        const duplicateRows = accountRows(await jsonBody(duplicateList));
        requireCondition(
          duplicateRows.filter(
            (row) => object(row) && row.username === temporary.username,
          ).length === 1,
          'duplicate issuance left partial account state',
        );
        requireCondition(
          findAccount(issuedBody)?.mustChangePassword === true,
          'issued password did not require first-login change',
        );

        for (const [parentKey, childKey] of [
          ['parentA', 'childA'],
          ['parentB', 'childB'],
        ]) {
          const link = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: {
              parentId: accountFor(parentKey).id,
              childId: accountFor(childKey).id,
            },
          });
          requireSuccess(link, `${parentKey} link`);
          const replay = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: {
              parentId: accountFor(parentKey).id,
              childId: accountFor(childKey).id,
            },
          });
          requireSuccess(replay, `${parentKey} idempotent link`);
        }
        state.relationshipsReady = true;
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-005-operator-only-mutations',
      async () => {
        requireDependency(
          Boolean(state.temporary?.id),
          'temporary account was not provisioned',
        );
        const parent = clientFor('parentA');
        const deniedIssue = await parent.request('/api/pilot/accounts', {
          method: 'POST',
          body: {
            username: makeUsername(),
            name: 'Should Not Exist',
            password: makePassword('denied'),
            role: 'operator',
          },
        });
        requireDenied(deniedIssue, 'parent account issuance');
        const deniedLink = await parent.request('/api/pilot/links', {
          method: 'POST',
          body: {
            parentId: accountFor('parentA').id,
            childId: accountFor('childB').id,
          },
        });
        requireDenied(deniedLink, 'parent operator link');
        const deniedReset = await parent.request(
          `/api/pilot/accounts/${encodeURIComponent(state.temporary.id)}/reset`,
          {
            method: 'POST',
            body: { password: makePassword('denied-reset') },
          },
        );
        requireDenied(deniedReset, 'parent account reset');
        const deniedStatus = await parent.request(
          `/api/pilot/accounts/${encodeURIComponent(state.temporary.id)}/status`,
          {
            method: 'POST',
            body: { disabled: true },
          },
        );
        requireDenied(deniedStatus, 'parent account status');
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-004-child-parent-teacher-authorization',
      async () => {
        requireDependency(
          state.relationshipsReady,
          'parent-child relationships were not provisioned',
        );
        const childA = clientFor('childA');
        const parentA = clientFor('parentA');
        const parentB = clientFor('parentB');
        const teacher = clientFor('teacher');
        const otherTeacher = clientFor('otherTeacher');

        const childMe = await readMe(childA, 'childA');
        requireCondition(
          childMe.user.id === accountFor('childA').id &&
            childMe.user.role === 'child',
          'child self identity is incorrect',
        );
        requireCondition(
          childIDs(childMe.body).length === 1 &&
            childIDs(childMe.body)[0] === accountFor('childA').id,
          'child does not see only self',
        );
        await readChild(childA, accountFor('childA').id, 'child self');
        await readChild(
          childA,
          accountFor('childB').id,
          'child cross-family',
          404,
        );

        await readChild(parentA, accountFor('childA').id, 'linked parent');
        await readChild(
          parentA,
          accountFor('childB').id,
          'parent cross-family',
          404,
        );
        await readChild(
          parentB,
          accountFor('childB').id,
          'second linked parent',
        );
        await readChild(
          parentB,
          accountFor('childA').id,
          'second parent cross-family',
          404,
        );

        const forged = await parentA.request(
          `/api/pilot/children/${encodeURIComponent(accountFor('childB').id)}?profile=${encodeURIComponent(accountFor('childA').id)}&role=operator`,
        );
        requireStatus(forged, 404, 'profile/role query spoof');

        const parentGrant = await parentA.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: accountFor('childA').id,
            teacherId: accountFor('teacher').id,
          },
        });
        requireSuccess(parentGrant, 'linked parent teacher grant');
        const parentAfterGrant = await readMe(parentA, 'parent grant reload');
        const parentGrants = grantRows(parentAfterGrant.body);
        requireCondition(
          parentGrants.length === 1 &&
            parentGrants[0].childId === accountFor('childA').id &&
            parentGrants[0].teacherId === accountFor('teacher').id &&
            parentGrants[0].grantedBy === accountFor('parentA').id,
          'parent grant reload omitted its owned grant record',
        );
        const teacherMe = await readMe(teacher, 'granted teacher');
        requireCondition(
          childIDs(teacherMe.body).includes(accountFor('childA').id),
          'teacher me omitted granted child',
        );
        await readChild(teacher, accountFor('childA').id, 'granted teacher');
        const otherMe = await readMe(otherTeacher, 'ungranted teacher');
        requireCondition(
          !childIDs(otherMe.body).includes(accountFor('childA').id),
          'ungranted teacher sees child',
        );
        await readChild(
          otherTeacher,
          accountFor('childA').id,
          'ungranted teacher',
          404,
        );

        const wrongParentGrant = await parentB.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: accountFor('childA').id,
            teacherId: accountFor('otherTeacher').id,
          },
        });
        requireDenied(wrongParentGrant, 'unlinked parent teacher grant');

        const operator = clientFor('operator');
        const secondParentLink = await operator.request('/api/pilot/links', {
          method: 'POST',
          body: {
            parentId: accountFor('parentB').id,
            childId: accountFor('childA').id,
          },
        });
        requireSuccess(secondParentLink, 'second parent link');
        const secondParentGrant = await parentB.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: accountFor('childA').id,
            teacherId: accountFor('otherTeacher').id,
          },
        });
        requireSuccess(secondParentGrant, 'second parent teacher grant');
        const parentAWithTwoOwners = await readMe(
          parentA,
          'parent grant ownership reload',
        );
        const parentAOwnedGrants = grantRows(parentAWithTwoOwners.body);
        requireCondition(
          parentAOwnedGrants.length === 1 &&
            parentAOwnedGrants.every(
              (grant) => grant.grantedBy === accountFor('parentA').id,
            ) &&
            !parentAOwnedGrants.some(
              (grant) => grant.teacherId === accountFor('otherTeacher').id,
            ),
          "parent grant list included another parent's record",
        );
        const parentBWithGrant = await readMe(
          parentB,
          'second parent grant reload',
        );
        const parentBOwnedGrants = grantRows(parentBWithGrant.body);
        requireCondition(
          parentBOwnedGrants.length === 1 &&
            parentBOwnedGrants[0].childId === accountFor('childA').id &&
            parentBOwnedGrants[0].teacherId === accountFor('otherTeacher').id &&
            parentBOwnedGrants[0].grantedBy === accountFor('parentB').id,
          'second parent grant record was not scoped to its owner',
        );
        await readChild(
          otherTeacher,
          accountFor('childA').id,
          'second parent granted teacher',
        );

        const revoke = await parentA.request('/api/pilot/grants', {
          method: 'DELETE',
          body: {
            childId: accountFor('childA').id,
            teacherId: accountFor('teacher').id,
          },
        });
        requireSuccess(revoke, 'parent teacher revoke');
        await readChild(
          teacher,
          accountFor('childA').id,
          'teacher after grant revoke',
          404,
        );
        const teacherAfterRevoke = await readMe(
          teacher,
          'teacher after grant revoke',
        );
        requireCondition(
          !childIDs(teacherAfterRevoke.body).includes(accountFor('childA').id),
          'revoked teacher grant remained effective',
        );
        const parentAfterRevoke = await readMe(
          parentA,
          'parent grant revoke reload',
        );
        requireCondition(
          !grantRows(parentAfterRevoke.body).some(
            (grant) => grant.teacherId === accountFor('teacher').id,
          ),
          'revoked parent grant remained in the owner list',
        );
        await readChild(
          otherTeacher,
          accountFor('childA').id,
          'other parent grant after first parent revoke',
        );

        const grantAgain = await parentA.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: accountFor('childA').id,
            teacherId: accountFor('teacher').id,
          },
        });
        requireSuccess(grantAgain, 'teacher grant before unlink');
        const unlink = await operator.request('/api/pilot/links', {
          method: 'DELETE',
          body: {
            parentId: accountFor('parentA').id,
            childId: accountFor('childA').id,
          },
        });
        requireSuccess(unlink, 'operator unlink');
        await readChild(
          parentA,
          accountFor('childA').id,
          'parent after unlink',
          404,
        );
        await readChild(
          teacher,
          accountFor('childA').id,
          'teacher after parent unlink',
          404,
        );
        const teacherAfterUnlink = await readMe(
          teacher,
          'teacher after parent unlink',
        );
        requireCondition(
          !childIDs(teacherAfterUnlink.body).includes(accountFor('childA').id),
          'orphaned teacher grant remained effective',
        );
        const parentAfterUnlink = await readMe(
          parentA,
          'parent grant unlink reload',
        );
        requireCondition(
          grantRows(parentAfterUnlink.body).length === 0,
          'unlinked parent retained a grant record',
        );
        await readChild(
          otherTeacher,
          accountFor('childA').id,
          'other parent teacher after first parent unlink',
        );
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-003-reset-change-and-session-revocation',
      async () => {
        requireDependency(
          Boolean(state.temporary?.id),
          'temporary account was not provisioned',
        );
        const temporary = state.temporary;
        const temporaryClient = new PilotClient(baseURL);
        await login(temporaryClient, temporary);
        const beforeChange = await readMe(
          temporaryClient,
          'issued temporary child',
        );
        requireCondition(
          beforeChange.user.mustChangePassword === true,
          'issued account did not require password change',
        );
        const blockedBeforeChange = await readChild(
          temporaryClient,
          temporary.id,
          'issued account ordinary access',
          403,
        );
        requireStatus(
          blockedBeforeChange,
          403,
          'issued account mandatory password gate',
        );

        const changedPassword = makePassword('changed');
        state.temporarySecrets.push(changedPassword);
        const change = await temporaryClient.request(
          '/api/auth/change-password',
          {
            method: 'POST',
            body: {
              currentPassword: temporary.password,
              newPassword: changedPassword,
              revokeOtherSessions: true,
            },
          },
        );
        requireSuccess(change, 'first password change');
        const changedMe = await readMe(
          temporaryClient,
          'changed temporary child',
        );
        requireCondition(
          changedMe.user.mustChangePassword === false,
          'password change did not clear mandatory-change state',
        );

        const oldPasswordClient = new PilotClient(baseURL);
        const oldPassword = await oldPasswordClient.request(
          '/api/auth/sign-in/username',
          {
            method: 'POST',
            body: {
              username: temporary.username,
              password: temporary.password,
            },
          },
        );
        requireStatus(oldPassword, 401, 'old issued password after change');

        const resetPassword = temporary.resetPassword;
        const reset = await clientFor('operator').request(
          `/api/pilot/accounts/${encodeURIComponent(temporary.id)}/reset`,
          {
            method: 'POST',
            body: { password: resetPassword },
          },
        );
        requireSuccess(reset, 'operator password reset');
        requireStatus(
          await temporaryClient.request('/api/pilot/me'),
          401,
          'pre-reset session after reset',
        );
        requireStatus(
          await oldPasswordClient.request('/api/auth/sign-in/username', {
            method: 'POST',
            body: { username: temporary.username, password: changedPassword },
          }),
          401,
          'pre-reset password after reset',
        );

        const resetClient = new PilotClient(baseURL);
        await login(resetClient, { ...temporary, password: resetPassword });
        const resetMe = await readMe(resetClient, 'reset temporary child');
        requireCondition(
          resetMe.user.mustChangePassword === true,
          'reset password did not require change',
        );
        state.temporary.password = resetPassword;
        state.temporaryClient = resetClient;
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-002-disabled-account-denial',
      async () => {
        requireDependency(
          Boolean(state.temporary?.id),
          'temporary account was not provisioned',
        );
        requireDependency(
          Boolean(state.temporaryClient),
          'reset account session was not established',
        );
        const operator = clientFor('operator');
        const disabled = await operator.request(
          `/api/pilot/accounts/${encodeURIComponent(state.temporary.id)}/status`,
          {
            method: 'POST',
            body: { disabled: true },
          },
        );
        requireSuccess(disabled, 'operator disable account');
        const disabledSignIn = await new PilotClient(baseURL).request(
          '/api/auth/sign-in/username',
          {
            method: 'POST',
            body: {
              username: state.temporary.username,
              password: state.temporary.password,
            },
          },
        );
        requireStatus(disabledSignIn, 401, 'disabled account sign-in');
        const disabledMessage = await errorMessage(disabledSignIn);
        requireDependency(
          state.invalidCredentials,
          'invalid-credential baseline was not established',
        );
        requireCondition(
          disabledMessage === state.invalidCredentials.message,
          'disabled account error message was not uniform',
        );
        requireStatus(
          await state.temporaryClient.request('/api/pilot/me'),
          401,
          'disabled account session after disable',
        );
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-008-restart-persistence',
      async () => {
        requireDependency(
          Boolean(state.temporary?.id),
          'temporary account was not provisioned',
        );
        await dependencyCall(restart, 'worker restart');
        const operator = clientFor('operator');
        const { user } = await readMe(operator, 'operator after restart');
        requireCondition(
          user.role === 'operator',
          'operator session did not survive restart',
        );
        const list = await operator.request('/api/pilot/accounts');
        requireStatus(list, 200, 'account list after restart');
        const rows = accountRows(await jsonBody(list));
        const temporaryRow = rows.find(
          (row) => object(row) && row.id === state.temporary?.id,
        );
        requireCondition(
          object(temporaryRow) && temporaryRow.disabled === true,
          'disabled account state did not persist',
        );
        await readChild(
          clientFor('teacher'),
          accountFor('childA').id,
          'teacher after restart unlink',
          404,
        );
        await readChild(
          clientFor('parentA'),
          accountFor('childA').id,
          'parent after restart unlink',
          404,
        );
        await readChild(
          clientFor('parentB'),
          accountFor('childA').id,
          'second parent after restart',
        );
        await readChild(
          clientFor('otherTeacher'),
          accountFor('childA').id,
          'other parent teacher after restart',
        );
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-009-pilot-route-closure',
      async () => {
        requireDependency(
          typeof testToken === 'string' && testToken.length > 0,
          'configured test token was not provided',
        );
        const pilot = new PilotClient(baseURL);
        const closureRequests = [
          { method: 'GET', path: '/api/state?profile=family' },
          { method: 'GET', path: '/api/preview/lessons/forest-01-v1/decision' },
          {
            method: 'POST',
            path: '/api/preview/lessons/forest-01-v1/decision',
            body: {
              status: 'changes-requested',
              reviewerLabel: 'pilot closure',
              notes: 'synthetic closure probe',
              candidateId: 'closure-candidate',
            },
          },
          { method: 'GET', path: '/api/preview/runs' },
          { method: 'GET', path: '/api/preview/runs/opaque-closure-run' },
          {
            method: 'POST',
            path: '/api/preview/runs/opaque-closure-run/actions',
            body: {
              eventId: 'closure-event',
              expectedRevision: 0,
              stepId: 'welcome',
              type: 'continue',
              payload: {},
            },
          },
          {
            method: 'POST',
            path: '/api/preview/runs/opaque-closure-run/feedback',
            body: {
              feedbackId: 'closure-feedback',
              stepId: null,
              category: 'other',
              text: 'synthetic closure probe',
              source: 'reviewer',
            },
          },
          { method: 'GET', path: '/api/test/identity' },
          {
            method: 'POST',
            path: '/api/test/fixtures',
            body: { scenario: 'new-reader', seed: 17 },
          },
          {
            method: 'POST',
            path: '/api/test/fault',
            body: { operation: 'storage', enabled: false },
          },
          { method: 'DELETE', path: '/api/test/runs/opaque-closure-run' },
          {
            method: 'POST',
            path: '/api/test/runs/opaque-closure-run/clock',
            body: { at: new Date().toISOString() },
          },
          { method: 'GET', path: '/preview/test' },
        ];
        for (const request of closureRequests) {
          for (const entry of [
            { label: 'anonymous', headers: {} },
            {
              label: 'configured test token',
              headers: { 'X-Hanzi-Test-Token': testToken },
            },
          ]) {
            requireStatus(
              await pilot.request(request.path, {
                method: request.method,
                body: request.body,
                headers: entry.headers,
              }),
              404,
              `pilot route closure ${entry.label} ${request.method} ${request.path}`,
            );
          }
        }
      },
      accounts,
      [...state.temporarySecrets, testToken],
    ),
  );

  results.push(
    await runCase(
      'S2-AC-006-parent-retains-disabled-teacher-grant',
      async () => {
        requireDependency(
          state.operatorReady,
          'operator session was not established',
        );
        const operator = clientFor('operator');
        const parentA = clientFor('parentA');
        const teacher = accountFor('teacher');
        let linked = false;
        let granted = false;
        let disabled = false;
        try {
          const link = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: {
              parentId: accountFor('parentA').id,
              childId: accountFor('childA').id,
            },
          });
          requireSuccess(link, 'disabled-teacher parent link');
          linked = true;
          const grant = await parentA.request('/api/pilot/grants', {
            method: 'POST',
            body: { childId: accountFor('childA').id, teacherId: teacher.id },
          });
          requireSuccess(grant, 'disabled-teacher grant');
          granted = true;
          const disable = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(teacher.id)}/status`,
            {
              method: 'POST',
              body: { disabled: true },
            },
          );
          requireSuccess(disable, 'disable granted teacher');
          disabled = true;
          const parentView = await readMe(
            parentA,
            'parent with disabled teacher grant',
          );
          const rows = grantRows(parentView.body);
          const retained = rows.find(
            (row) =>
              row.childId === accountFor('childA').id &&
              row.teacherId === teacher.id,
          );
          requireCondition(
            object(retained) &&
              retained.grantedBy === accountFor('parentA').id &&
              retained.teacherDisabled === true,
            'parent grant list hid its disabled teacher grant',
          );
          const revoke = await parentA.request('/api/pilot/grants', {
            method: 'DELETE',
            body: { childId: accountFor('childA').id, teacherId: teacher.id },
          });
          requireSuccess(revoke, 'revoke disabled teacher grant');
          granted = false;
          const enable = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(teacher.id)}/status`,
            {
              method: 'POST',
              body: { disabled: false },
            },
          );
          requireSuccess(enable, 're-enable teacher');
          disabled = false;
          const freshTeacher = new PilotClient(baseURL);
          await login(freshTeacher, teacher, {
            label: 're-enabled teacher sign-in',
          });
          await readChild(
            freshTeacher,
            accountFor('childA').id,
            'revoked disabled-teacher grant',
            404,
          );
        } finally {
          if (disabled) {
            try {
              await operator.request(
                `/api/pilot/accounts/${encodeURIComponent(teacher.id)}/status`,
                { method: 'POST', body: { disabled: false } },
              );
            } catch {
              /* cleanup */
            }
          }
          if (granted) {
            try {
              await parentA.request('/api/pilot/grants', {
                method: 'DELETE',
                body: {
                  childId: accountFor('childA').id,
                  teacherId: teacher.id,
                },
              });
            } catch {
              /* cleanup */
            }
          }
          if (linked) {
            try {
              await operator.request('/api/pilot/links', {
                method: 'DELETE',
                body: {
                  parentId: accountFor('parentA').id,
                  childId: accountFor('childA').id,
                },
              });
            } catch {
              /* cleanup */
            }
          }
        }
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-002-cookie-signout-and-session-expiry',
      async () => {
        requireDependency(
          state.seedSessionsReady,
          'seeded sessions were not established',
        );
        const signOutClient = new PilotClient(baseURL);
        await login(signOutClient, accountFor('operator'), {
          checkCookie: true,
          label: 'cookie flag sign-in',
        });
        const capturedCookie = signOutClient.cookieHeader();
        requireCondition(
          Boolean(capturedCookie),
          'sign-in did not produce a replayable session cookie',
        );
        const signOut = await signOutClient.request('/api/auth/sign-out', {
          method: 'POST',
          body: {},
        });
        requireStatus(signOut, 200, 'sign-out');
        requireSafePilotJSON(await jsonBody(signOut), 'sign-out response');
        requireStatus(
          await signOutClient.request('/api/pilot/me'),
          401,
          'signed-out session',
        );
        const replay = new PilotClient(baseURL);
        requireStatus(
          await replay.request('/api/pilot/me', {
            headers: { Cookie: capturedCookie },
          }),
          401,
          'replayed pre-sign-out session',
        );

        const productionClient = new PilotClient(baseURL);
        await login(productionClient, accountFor('operator'), {
          label: 'production-client sign-in',
        });
        const productionCookie = productionClient.cookieHeader();
        requireCondition(
          Boolean(productionCookie),
          'production-client sign-in did not produce a session cookie',
        );
        const nativeFetch = globalThis.fetch;
        const origin = new URL(baseURL).origin;
        let productionSignOutResponse = null;
        let productionSignOutBody = null;
        try {
          globalThis.fetch = async (input, init = {}) => {
            const inputURL =
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : object(input) && typeof input.url === 'string'
                    ? input.url
                    : '';
            requireCondition(
              Boolean(inputURL),
              'production sign-out used an unsupported fetch input',
            );
            const target = new URL(inputURL, baseURL);
            const headers = new Headers(init.headers);
            headers.set('Origin', origin);
            headers.set('Cookie', productionCookie);
            const response = await nativeFetch(target, { ...init, headers });
            if (target.pathname === '/api/auth/sign-out') {
              productionSignOutResponse = response;
              productionSignOutBody = await response
                .clone()
                .json()
                .catch(() => null);
            }
            return response;
          };
          await signOutPilot();
        } finally {
          globalThis.fetch = nativeFetch;
        }
        requireCondition(
          productionSignOutResponse !== null,
          'production sign-out did not reach the Worker',
        );
        requireStatus(
          productionSignOutResponse,
          200,
          'production-client sign-out',
        );
        requireSafePilotJSON(
          productionSignOutBody,
          'production-client sign-out response',
        );
        const productionReplay = await nativeFetch(
          new URL('/api/pilot/me', baseURL),
          {
            headers: {
              Accept: 'application/json',
              Cookie: productionCookie,
              Origin: origin,
            },
            cache: 'no-store',
          },
        );
        requireStatus(
          productionReplay,
          401,
          'replayed production-client session',
        );

        await dependencyCall(
          expireSessions,
          'session expiry',
          accountFor('childB').id,
        );
        requireStatus(
          await clientFor('childB').request('/api/pilot/me'),
          401,
          'expired seeded child session',
        );
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-002-rate-limit-persists-after-restart',
      async () => {
        const rateLimited = new PilotClient(baseURL);
        const account = accountFor('operator');
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          const response = await rateLimited.request(
            '/api/auth/sign-in/username',
            {
              method: 'POST',
              body: {
                username: account.username,
                password: makePassword(`restart-rate-${attempt}`),
              },
            },
          );
          requireStatus(
            response,
            401,
            `restart rate-limit preflight attempt ${attempt}`,
          );
        }
        requireStatus(
          await rateLimited.request('/api/auth/sign-in/username', {
            method: 'POST',
            body: {
              username: account.username,
              password: makePassword('restart-rate-limit'),
            },
          }),
          429,
          'rate limit before restart',
        );
        await dependencyCall(restart, 'rate-limit persistence restart');
        requireStatus(
          await rateLimited.request('/api/auth/sign-in/username', {
            method: 'POST',
            body: {
              username: account.username,
              password: makePassword('restart-rate-after'),
            },
          }),
          429,
          'rate limit after immediate restart',
        );
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-005-audit-atomicity-and-secret-safety',
      async () => {
        requireDependency(
          state.operatorReady,
          'operator session was not established',
        );
        requireDependency(
          Boolean(state.temporary?.id),
          'temporary account was not provisioned',
        );
        requireDependency(
          typeof inspectAudit === 'function',
          'audit inspection callback is required',
        );
        requireDependency(
          typeof setAuditAvailable === 'function',
          'audit availability callback is required',
        );
        const operator = clientFor('operator');
        const faultAccount = {
          username: makeUsername(),
          password: makePassword('audit-fault'),
          name: 'Audit Fault Child',
          role: 'child',
        };
        state.temporarySecrets.push(
          faultAccount.username,
          faultAccount.password,
        );
        try {
          await dependencyCall(
            setAuditAvailable,
            'audit storage disable',
            false,
          );
          const failed = await operator.request('/api/pilot/accounts', {
            method: 'POST',
            body: faultAccount,
          });
          requireStatus(
            failed,
            503,
            'account issue with unavailable audit storage',
          );
          const afterFailure = await operator.request('/api/pilot/accounts');
          requireStatus(afterFailure, 200, 'account list after failed issue');
          const rows = accountRows(await jsonBody(afterFailure));
          requireCondition(
            !rows.some(
              (row) => object(row) && row.username === faultAccount.username,
            ),
            'failed audit write left a user row',
          );
        } finally {
          await dependencyCall(
            setAuditAvailable,
            'audit storage restore',
            true,
          );
        }

        const restored = await operator.request('/api/pilot/accounts', {
          method: 'POST',
          body: faultAccount,
        });
        requireStatus(
          restored,
          201,
          'account issue after audit storage restore',
        );
        const restoredBody = await jsonBody(restored);
        requireSafePilotJSON(restoredBody, 'restored account issue');
        const faultID = unwrapAccountID(restoredBody);
        requireCondition(
          Boolean(faultID),
          'restored account issue omitted its ID',
        );
        state.faultAccount = { ...faultAccount, id: faultID };
        const restoredList = await operator.request('/api/pilot/accounts');
        requireStatus(restoredList, 200, 'account list after restored issue');
        const restoredRows = accountRows(await jsonBody(restoredList));
        requireCondition(
          restoredRows.filter(
            (row) => object(row) && row.username === faultAccount.username,
          ).length === 1,
          'restored issue did not leave exactly one account',
        );

        const auditRows = await dependencyCall(
          inspectAudit,
          'audit inspection',
        );
        requireAuditEvidence(
          auditRows,
          [
            {
              action: 'account.issue',
              actor: accountFor('operator').id,
              target: state.temporary.id,
            },
            {
              action: 'account.password-reset',
              actor: accountFor('operator').id,
              target: state.temporary.id,
            },
            {
              action: 'account.disable',
              actor: accountFor('operator').id,
              target: state.temporary.id,
            },
            {
              action: 'account.issue',
              actor: accountFor('operator').id,
              target: faultID,
            },
          ],
          [
            ...Object.values(accounts).flatMap((account) =>
              object(account) ? [account.password] : [],
            ),
            ...state.temporarySecrets.filter(
              (secret) =>
                secret !== state.temporary?.username &&
                secret !== state.faultAccount?.username,
            ),
          ],
        );
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  results.push(
    await runCase(
      'S2-AC-006-disabled-target-grant-and-link-cleanup',
      async () => {
        requireDependency(
          state.operatorReady,
          'operator session was not established',
        );
        const operator = clientFor('operator');
        const parentA = clientFor('parentA');
        const parentB = clientFor('parentB');
        const teacher = accountFor('teacher');
        const otherTeacher = accountFor('otherTeacher');
        const child = accountFor('childA');
        let parentBForCleanup = parentB;
        let parentALink = false;
        let parentAGrant = false;
        let parentBLink = false;
        let childDisabled = false;
        let parentBDisabled = false;
        let teacherDisabled = false;
        const cleanup = async (request) => {
          try {
            await request();
          } catch {
            /* cleanup */
          }
        };
        try {
          const linkA = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: { parentId: accountFor('parentA').id, childId: child.id },
          });
          requireSuccess(linkA, 'disabled-child parent A link');
          parentALink = true;
          const linkB = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: { parentId: accountFor('parentB').id, childId: child.id },
          });
          requireSuccess(linkB, 'disabled-child parent B link');
          parentBLink = true;
          const grantA = await parentA.request('/api/pilot/grants', {
            method: 'POST',
            body: { childId: child.id, teacherId: teacher.id },
          });
          requireSuccess(grantA, 'disabled-child parent A grant');
          parentAGrant = true;
          const grantB = await parentB.request('/api/pilot/grants', {
            method: 'POST',
            body: { childId: child.id, teacherId: otherTeacher.id },
          });
          requireSuccess(grantB, 'disabled-child parent B grant');

          const disableChild = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(child.id)}/status`,
            { method: 'POST', body: { disabled: true } },
          );
          requireSuccess(disableChild, 'disable linked child');
          childDisabled = true;
          const parentAView = await readMe(
            parentA,
            'parent A disabled-child grant projection',
          );
          const parentAGrantRow = grantRows(parentAView.body).find(
            (row) => row.childId === child.id && row.teacherId === teacher.id,
          );
          requireCondition(
            object(parentAGrantRow) &&
              parentAGrantRow.grantedBy === accountFor('parentA').id &&
              parentAGrantRow.childDisabled === true &&
              parentAGrantRow.teacherDisabled === false,
            'parent A lost disabled-child grant ownership or flags',
          );
          const parentBView = await readMe(
            parentB,
            'parent B disabled-child grant projection',
          );
          const parentBGrantRow = grantRows(parentBView.body).find(
            (row) =>
              row.childId === child.id && row.teacherId === otherTeacher.id,
          );
          requireCondition(
            object(parentBGrantRow) &&
              parentBGrantRow.grantedBy === accountFor('parentB').id &&
              parentBGrantRow.childDisabled === true,
            'other parent grant disappeared when child was disabled',
          );

          const revokeA = await parentA.request('/api/pilot/grants', {
            method: 'DELETE',
            body: { childId: child.id, teacherId: teacher.id },
          });
          requireSuccess(revokeA, 'revoke own grant for disabled child');
          parentAGrant = false;
          const parentBAfterRevoke = await readMe(
            parentB,
            'other parent grant after parent A revoke',
          );
          requireCondition(
            grantRows(parentBAfterRevoke.body).some(
              (row) =>
                row.childId === child.id && row.teacherId === otherTeacher.id,
            ),
            'revoking parent A grant removed the other parent grant',
          );

          const unlinkDisabledChild = await operator.request(
            '/api/pilot/links',
            {
              method: 'DELETE',
              body: { parentId: accountFor('parentA').id, childId: child.id },
            },
          );
          requireSuccess(unlinkDisabledChild, 'unlink disabled child');
          parentALink = false;
          const disableParentB = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(accountFor('parentB').id)}/status`,
            { method: 'POST', body: { disabled: true } },
          );
          requireSuccess(disableParentB, 'disable linked parent');
          parentBDisabled = true;
          const unlinkDisabledParent = await operator.request(
            '/api/pilot/links',
            {
              method: 'DELETE',
              body: { parentId: accountFor('parentB').id, childId: child.id },
            },
          );
          requireSuccess(unlinkDisabledParent, 'unlink disabled parent');
          parentBLink = false;

          const inactiveParentLink = await operator.request(
            '/api/pilot/links',
            {
              method: 'POST',
              body: { parentId: accountFor('parentB').id, childId: child.id },
            },
          );
          await requirePilotError(
            inactiveParentLink,
            400,
            'INVALID_REQUEST',
            'link creation for disabled parent and child',
          );
          const inactiveChildLink = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: { parentId: accountFor('parentA').id, childId: child.id },
          });
          await requirePilotError(
            inactiveChildLink,
            400,
            'INVALID_REQUEST',
            'link creation for disabled child',
          );
          const inactiveChildGrant = await parentA.request(
            '/api/pilot/grants',
            {
              method: 'POST',
              body: { childId: child.id, teacherId: teacher.id },
            },
          );
          await requirePilotError(
            inactiveChildGrant,
            400,
            'INVALID_REQUEST',
            'grant creation for disabled child',
          );

          const enableChild = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(child.id)}/status`,
            { method: 'POST', body: { disabled: false } },
          );
          requireSuccess(enableChild, 're-enable child for teacher rejection');
          childDisabled = false;
          const relinkA = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: { parentId: accountFor('parentA').id, childId: child.id },
          });
          requireSuccess(relinkA, 'relink enabled child');
          parentALink = true;
          const disableTeacher = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(teacher.id)}/status`,
            { method: 'POST', body: { disabled: true } },
          );
          requireSuccess(disableTeacher, 'disable granted teacher target');
          teacherDisabled = true;
          const inactiveTeacherGrant = await parentA.request(
            '/api/pilot/grants',
            {
              method: 'POST',
              body: { childId: child.id, teacherId: teacher.id },
            },
          );
          await requirePilotError(
            inactiveTeacherGrant,
            400,
            'INVALID_REQUEST',
            'grant creation for disabled teacher',
          );
        } finally {
          if (teacherDisabled) {
            await cleanup(async () => {
              const response = await operator.request(
                `/api/pilot/accounts/${encodeURIComponent(teacher.id)}/status`,
                { method: 'POST', body: { disabled: false } },
              );
              requireSuccess(response, 'cleanup teacher re-enable');
            });
          }
          if (childDisabled) {
            await cleanup(async () => {
              const response = await operator.request(
                `/api/pilot/accounts/${encodeURIComponent(child.id)}/status`,
                { method: 'POST', body: { disabled: false } },
              );
              requireSuccess(response, 'cleanup child re-enable');
            });
          }
          if (parentBDisabled) {
            await cleanup(async () => {
              const response = await operator.request(
                `/api/pilot/accounts/${encodeURIComponent(accountFor('parentB').id)}/status`,
                { method: 'POST', body: { disabled: false } },
              );
              requireSuccess(response, 'cleanup parent B re-enable');
            });
            parentBDisabled = false;
            parentBForCleanup = new PilotClient(baseURL);
            await cleanup(async () => {
              await login(
                parentBForCleanup,
                accountFor('parentB'),
                'cleanup parent B sign-in',
              );
            });
          }
          if (parentAGrant) {
            await cleanup(async () => {
              const response = await parentA.request('/api/pilot/grants', {
                method: 'DELETE',
                body: { childId: child.id, teacherId: teacher.id },
              });
              requireSuccess(response, 'cleanup parent A grant revoke');
            });
          }
          if (parentALink) {
            await cleanup(async () => {
              const response = await operator.request('/api/pilot/links', {
                method: 'DELETE',
                body: { parentId: accountFor('parentA').id, childId: child.id },
              });
              requireSuccess(response, 'cleanup parent A unlink');
            });
          }
          if (!parentBLink) {
            await cleanup(async () => {
              const response = await operator.request('/api/pilot/links', {
                method: 'POST',
                body: { parentId: accountFor('parentB').id, childId: child.id },
              });
              requireSuccess(response, 'cleanup parent B relink');
              parentBLink = true;
            });
          }
          await cleanup(async () => {
            const response = await parentBForCleanup.request(
              '/api/pilot/grants',
              {
                method: 'POST',
                body: { childId: child.id, teacherId: otherTeacher.id },
              },
            );
            requireSuccess(response, 'cleanup parent B grant');
          });
        }
      },
      accounts,
      state.temporarySecrets,
    ),
  );

  return results;
}

function expectedRole(key) {
  if (key === 'parentA' || key === 'parentB') return 'parent';
  if (key === 'teacher' || key === 'otherTeacher') return 'teacher';
  if (key === 'childA' || key === 'childB') return 'child';
  if (key === 'operator') return 'operator';
  return '';
}

function findAccount(body) {
  const root = dataBody(body);
  if (object(root.account)) return root.account;
  if (object(root.user)) return root.user;
  if (typeof root.id === 'string') return root;
  return null;
}
