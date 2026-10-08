/*
 * Sprint 3 authenticated curriculum-runtime HTTP probe.
 *
 * This module deliberately uses ordinary Better Auth sessions and the public
 * HTTP routes. The runtime fixture controls are runner-owned callbacks; this
 * probe never writes D1 state directly and never uses a test token as login.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';

const SOURCE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);
const DAY = 86_400_000;
const JSON_HEADERS = {
  Accept: 'application/json',
  // The runner deliberately restarts the Worker between cases. Closing each
  // local HTTP connection prevents undici from reusing a socket to the old
  // listener after that controlled restart.
  Connection: 'close',
};
let nextIP = 1;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireStatus(response, expected, label) {
  const wanted = Array.isArray(expected) ? expected : [expected];
  requireCondition(
    wanted.includes(response.status),
    `${label} returned HTTP ${response.status}`,
  );
}

function requireNoStore(response, label) {
  requireCondition(
    /(?:^|,\s*)no-store(?:\s*,|$)/i.test(
      response.headers.get('cache-control') || '',
    ),
    `${label} did not send Cache-Control: no-store`,
  );
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function dataBody(body) {
  return object(body?.data) ? body.data : body;
}

async function errorBody(response) {
  const body = dataBody(await jsonBody(response));
  return object(body?.error) ? body.error : body;
}

async function requireError(response, status, code, label, forbidden = []) {
  requireStatus(response, status, label);
  requireNoStore(response, label);
  const body = await errorBody(response);
  requireCondition(
    object(body) && body.code === code && typeof body.message === 'string',
    `${label} did not return ${code}`,
  );
  for (const value of forbidden) {
    if (typeof value === 'string' && value.length > 0)
      requireCondition(
        !body.message.includes(value),
        `${label} leaked private text`,
      );
  }
  requireCondition(
    !/(answerKey|correctChoiceId|manifest|sqlite|sql)/i.test(body.message),
    `${label} exposed private error text`,
  );
  return body;
}

function requireKeys(value, expected, label) {
  requireCondition(object(value), `${label} is not a JSON object`);
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const wanted = [...expected].sort((a, b) => a.localeCompare(b));
  requireCondition(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} returned an unexpected response shape`,
  );
}

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(Buffer.from(canonical(value), 'utf8'))
    .digest('hex')}`;
}

function runtimeFixture() {
  const value = clone(SOURCE);
  const [welcome, familiarity, teach, practice, final, recap] = value.steps;
  value.steps = [
    { ...welcome, kind: 'familiarity', recognitionCheckIds: [] },
    {
      ...familiarity,
      kind: 'familiarity',
      recognitionCheckIds: ['check-mu-word', 'check-lin-word'],
    },
    {
      ...teach,
      kind: 'teach',
      recognitionCheckIds: ['check-mu-print', 'check-lin-print'],
    },
    {
      ...practice,
      kind: 'practice',
      recognitionCheckIds: ['check-mu-word', 'check-lin-word'],
    },
    {
      ...final,
      kind: 'plain-print-check',
      recognitionCheckIds: ['check-mu-print', 'check-lin-print'],
    },
    { ...recap, kind: 'recap', recognitionCheckIds: [] },
  ];
  return value;
}

function checkFor(fixture, checkId) {
  const check = fixture.recognitionChecks.find(
    (candidate) => candidate.checkId === checkId,
  );
  requireCondition(check, `fixture check ${checkId} is unavailable`);
  return check;
}

function correctChoice(fixture, checkId) {
  return checkFor(fixture, checkId).correctChoiceId;
}

function wrongChoice(fixture, checkId) {
  const check = checkFor(fixture, checkId);
  return check.choices.find(
    (choice) => choice.choiceId !== check.correctChoiceId,
  ).choiceId;
}

function rowValue(row, ...names) {
  if (!object(row)) return undefined;
  for (const name of names) {
    if (Object.hasOwn(row, name)) return row[name];
  }
  return undefined;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function snapshotDigest(snapshot) {
  return JSON.stringify(
    stable({
      runs: snapshot?.runs,
      events: snapshot?.events,
      audit: snapshot?.audit,
      legacyCounts: snapshot?.legacyCounts,
      registryRevision: snapshot?.registryRevision,
      installationId: snapshot?.installationId,
    }),
  );
}

function requireInspection(snapshot, label) {
  requireCondition(object(snapshot), `${label} did not return an object`);
  for (const key of [
    'runs',
    'events',
    'audit',
    'legacyCounts',
    'registryRevision',
    'installationId',
  ]) {
    requireCondition(
      key === 'legacyCounts' ||
        key === 'registryRevision' ||
        key === 'installationId'
        ? Object.hasOwn(snapshot, key)
        : Array.isArray(snapshot[key]),
      `${label} omitted ${key}`,
    );
  }
  return snapshot;
}

function accountFor(accounts, key) {
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
  let message = error instanceof Error ? error.message : 'runtime probe failed';
  const privateValues = [
    ...Object.values(accounts || {}).flatMap((account) =>
      object(account) ? [account.id, account.username, account.password] : [],
    ),
    ...secrets,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const value of privateValues)
    message = message.split(value).join('[redacted]');
  return message.replace(
    /(password|token|secret|hash|email)[^\s]*/gi,
    '[redacted]',
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

function splitSetCookie(value) {
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]*)/g) : [];
}

class CookieJar {
  #cookies = new Map();

  attach(headers) {
    if (this.#cookies.size === 0) return;
    headers.set(
      'Cookie',
      [...this.#cookies.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    );
  }

  store(response) {
    const values =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : splitSetCookie(response.headers.get('set-cookie') || '');
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (cookieValue) this.#cookies.set(name, cookieValue);
      else this.#cookies.delete(name);
    }
  }
}

class PilotClient {
  constructor(baseURL) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    const ip = nextIP;
    nextIP = (nextIP % 240) + 1;
    this.ip = `198.51.100.${ip}`;
    this.cookies = new CookieJar();
  }

  async request(
    path,
    { method = 'GET', body, rawBody, origin = this.origin, headers = {} } = {},
  ) {
    const requestHeaders = new Headers({ ...JSON_HEADERS, ...headers });
    requestHeaders.set('X-Forwarded-For', this.ip);
    requestHeaders.set('CF-Connecting-IP', this.ip);
    if (body !== undefined || rawBody !== undefined)
      requestHeaders.set('Content-Type', 'application/json');
    if (origin !== null) requestHeaders.set('Origin', origin);
    this.cookies.attach(requestHeaders);
    const request = { method, headers: requestHeaders, redirect: 'manual' };
    if (rawBody !== undefined) request.body = rawBody;
    else if (body !== undefined) request.body = JSON.stringify(body);
    let response;
    try {
      response = await fetch(`${this.baseURL}${path}`, request);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : null;
      const label =
        cause && typeof cause.name === 'string' ? cause.name : 'FetchError';
      const code =
        cause && typeof cause.code === 'string' ? cause.code : 'UNKNOWN';
      throw new Error(`network request failed [${label}/${code}]`);
    }
    this.cookies.store(response);
    return response;
  }
}

async function login(client, account, label) {
  const response = await client.request('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username: account.username, password: account.password },
  });
  requireStatus(response, 200, label);
  requireNoStore(response, label);
  const body = dataBody(await jsonBody(response));
  requireCondition(object(body), `${label} returned no JSON object`);
  requireCondition(
    !Object.keys(body).some((key) =>
      /password|hash|token|secret|email/i.test(key),
    ),
    `${label} returned a credential field`,
  );
}

function pathFor(version, suffix = '') {
  return `/api/pilot/curriculum/${encodeURIComponent(version)}${suffix}`;
}

function runtimePath(childId, runId, suffix = '') {
  return `/api/pilot/children/${encodeURIComponent(childId)}/curriculum-verifications/${encodeURIComponent(runId)}${suffix}`;
}

async function importPackage(client, packageValue, label) {
  const response = await client.request('/api/pilot/curriculum', {
    method: 'POST',
    body: { package: packageValue },
  });
  requireStatus(response, [200, 201], label);
  requireNoStore(response, label);
  return dataBody(await jsonBody(response));
}

async function createVerification(client, version, input, label) {
  const response = await client.request(
    pathFor(version, '/runtime-verifications'),
    {
      method: 'POST',
      body: input,
    },
  );
  requireStatus(response, [200, 201], label);
  requireNoStore(response, label);
  return { response, body: dataBody(await jsonBody(response)) };
}

async function getRun(
  client,
  childId,
  runId,
  label,
  expected = 200,
  expectedCode = null,
) {
  const response = await client.request(runtimePath(childId, runId));
  if (expected !== 200) {
    const code =
      expectedCode ??
      (expected === 401
        ? 'UNAUTHORIZED'
        : expected === 403
          ? 'FORBIDDEN'
          : 'NOT_FOUND');
    await requireError(response, expected, code, label);
    return null;
  }
  requireStatus(response, 200, label);
  requireNoStore(response, label);
  const body = dataBody(await jsonBody(response));
  requireKeys(body, ['childId', 'purpose', 'run', 'schemaVersion'], label);
  return body;
}

async function getProgress(client, childId, runId, label, expected = 200) {
  const response = await client.request(
    runtimePath(childId, runId, '/progress'),
  );
  if (expected !== 200) {
    await requireError(
      response,
      expected,
      expected === 403 ? 'FORBIDDEN' : 'NOT_FOUND',
      label,
    );
    return null;
  }
  requireStatus(response, 200, label);
  requireNoStore(response, label);
  const body = dataBody(await jsonBody(response));
  requireKeys(body, ['childId', 'progress', 'purpose', 'schemaVersion'], label);
  return body;
}

async function postAction(
  client,
  childId,
  runId,
  action,
  label,
  expected = 200,
) {
  const response = await client.request(
    runtimePath(childId, runId, '/actions'),
    {
      method: 'POST',
      body: action,
    },
  );
  if (expected !== 200) {
    await requireError(
      response,
      expected,
      expected === 503 ? 'STORAGE_UNAVAILABLE' : 'INVALID_TRANSITION',
      label,
    );
    return null;
  }
  requireStatus(response, 200, label);
  requireNoStore(response, label);
  const body = dataBody(await jsonBody(response));
  requireKeys(body, ['ack', 'replayed', 'schemaVersion'], label);
  requireCondition(
    body.schemaVersion === 's3-runtime-action-1',
    `${label} schema mismatch`,
  );
  requireKeys(body.ack, ['eventId', 'result', 'revision'], `${label} ack`);
  requireKeys(
    body.ack.result,
    ['assisted', 'firstResponse', 'outcome'],
    `${label} result`,
  );
  requireCondition(
    !Object.hasOwn(body.ack.result, 'score'),
    `${label} exposed a score`,
  );
  return body;
}

function assertSafe(value, label) {
  const forbidden =
    /^(answerKey|correctAnswer|correctChoiceId|evidenceRef|manifest|provenance|reviewerRef|source|targetCharacter|event|events|state)$/i;
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!object(node)) return;
    for (const [key, child] of Object.entries(node)) {
      requireCondition(!forbidden.test(key), `${label} exposed ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function assertIsoOrNull(value, label) {
  requireCondition(
    value === null ||
      (typeof value === 'string' && !Number.isNaN(Date.parse(value))),
    `${label} is not an ISO timestamp or null`,
  );
}

function assertRunView(body, label) {
  requireCondition(
    body.schemaVersion === 's3-runtime-http-1',
    `${label} schema mismatch`,
  );
  requireCondition(
    body.purpose === 'test-verification',
    `${label} purpose mismatch`,
  );
  requireCondition(
    typeof body.childId === 'string',
    `${label} child ID missing`,
  );
  requireKeys(
    body.run,
    [
      'canContinue',
      'canStartReview',
      'completion',
      'identity',
      'phase',
      'question',
      'revision',
      'runId',
      'schemaVersion',
      'step',
      'teaching',
    ],
    `${label} run`,
  );
  for (const key of [
    'initialCompletedAt',
    'reviewAvailableAt',
    'reviewCompletedAt',
  ])
    assertIsoOrNull(body.run.completion[key], `${label} ${key}`);
  assertSafe(body.run, label);
}

function assertProgress(body, label) {
  requireCondition(
    body.schemaVersion === 's3-runtime-progress-1',
    `${label} schema mismatch`,
  );
  requireCondition(
    body.purpose === 'test-verification',
    `${label} purpose mismatch`,
  );
  requireKeys(
    body.progress,
    [
      'characters',
      'completion',
      'evidenceLimits',
      'groups',
      'identity',
      'runId',
      'schemaVersion',
    ],
    `${label} progress`,
  );
  for (const key of [
    'initialCompletedAt',
    'reviewAvailableAt',
    'reviewCompletedAt',
  ])
    assertIsoOrNull(body.progress.completion[key], `${label} ${key}`);
  assertSafe(body.progress, label);
}

async function ensureRelationships(baseURL, accounts) {
  const operator = new PilotClient(baseURL);
  const parent = new PilotClient(baseURL);
  await login(
    operator,
    accountFor(accounts, 'operator'),
    'operator relationship login',
  );
  await login(
    parent,
    accountFor(accounts, 'parentA'),
    'parent relationship login',
  );
  const link = await operator.request('/api/pilot/links', {
    method: 'POST',
    body: { parentId: accounts.parentA.id, childId: accounts.childA.id },
  });
  requireStatus(link, [200, 201, 409], 'runtime parent-child link');
  requireNoStore(link, 'runtime parent-child link');
  const grant = await parent.request('/api/pilot/grants', {
    method: 'POST',
    body: { childId: accounts.childA.id, teacherId: accounts.teacher.id },
  });
  requireStatus(grant, [200, 201, 409], 'runtime teacher grant');
  requireNoStore(grant, 'runtime teacher grant');
}

async function runCase(id, action, accounts, secrets = []) {
  try {
    await action();
    return { id, status: 'PASS' };
  } catch (error) {
    return {
      id,
      status: error instanceof DependencyBlockedError ? 'BLOCKED' : 'FAIL',
      detail: sanitizeMessage(error, accounts, secrets),
    };
  }
}

export async function runPilotCurriculumRuntimeIntegration({
  baseURL,
  accounts,
  restart,
  runtimeFixtures,
}) {
  const fixture = runtimeFixture();
  const contentDigest = digest(fixture);
  const version = fixture.lessonVersion;
  const state = {
    imported: false,
    primaryRun: null,
    childBRun: null,
    primaryCompletion: null,
    primaryChild: accountFor(accounts, 'childA'),
    secrets: [contentDigest],
  };
  const clients = new Map();
  const clientFor = (key) => {
    if (!clients.has(key)) clients.set(key, new PilotClient(baseURL));
    return clients.get(key);
  };
  const account = (key) => accountFor(accounts, key);
  const inspect = () =>
    dependencyCall(runtimeFixtures?.inspect, 'runtime inspection');
  const results = [];

  results.push(
    await runCase(
      'C-H01-access-and-isolation',
      async () => {
        requireDependency(
          typeof baseURL === 'string' && baseURL.length > 0,
          'base URL',
        );
        const anonymous = new PilotClient(baseURL);
        const anonymousCreate = await anonymous.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            body: {
              requestId: 'h01-anonymous',
              contentDigest,
              childId: account('childA').id,
            },
            headers: { 'X-Hanzi-Test-Token': 'arbitrary-debug-header' },
          },
        );
        await requireError(
          anonymousCreate,
          401,
          'UNAUTHORIZED',
          'anonymous runtime create',
        );

        const operator = clientFor('operator');
        const parent = clientFor('parentA');
        const teacher = clientFor('teacher');
        const child = clientFor('childA');
        await login(operator, account('operator'), 'runtime operator login');
        await login(parent, account('parentA'), 'runtime parent login');
        await login(teacher, account('teacher'), 'runtime teacher login');
        await login(child, account('childA'), 'runtime child login');
        const createInput = {
          requestId: 'h01-role-matrix',
          contentDigest,
          childId: account('childA').id,
        };
        for (const [label, client] of [
          ['parent', parent],
          ['teacher', teacher],
          ['child', child],
        ]) {
          const response = await client.request(
            pathFor(version, '/runtime-verifications'),
            {
              method: 'POST',
              body: createInput,
            },
          );
          await requireError(
            response,
            403,
            'FORBIDDEN',
            `${label} cannot create`,
          );
        }
        const missingOrigin = await operator.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            origin: null,
            body: { ...createInput, requestId: 'h01-missing-origin' },
          },
        );
        await requireError(
          missingOrigin,
          403,
          'FORBIDDEN',
          'missing Origin create',
        );

        const before = requireInspection(await inspect(), 'H01 before guards');
        for (const [name, setGuard, value] of [
          ['test-content', runtimeFixtures?.setTestContentAllowed, false],
          ['candidate', runtimeFixtures?.setCandidateBound, false],
        ]) {
          requireDependency(
            typeof setGuard === 'function',
            `${name} guard callback`,
          );
          await dependencyCall(setGuard, `${name} guard disable`, value);
          try {
            const response = await operator.request(
              pathFor(version, '/runtime-verifications'),
              {
                method: 'POST',
                body: { ...createInput, requestId: `h01-${name}` },
              },
            );
            await requireError(
              response,
              404,
              'NOT_FOUND',
              `${name} guard denial`,
            );
          } finally {
            await dependencyCall(setGuard, `${name} guard restore`, true);
          }
        }
        await dependencyCall(
          runtimeFixtures?.setFixtureRunId,
          'foreign test-run selection',
          'foreign',
        );
        try {
          const response = await operator.request(
            pathFor(version, '/runtime-verifications'),
            {
              method: 'POST',
              body: { ...createInput, requestId: 'h01-foreign-test-run' },
            },
          );
          await requireError(
            response,
            404,
            'NOT_FOUND',
            'foreign test-run denial',
          );
        } finally {
          await dependencyCall(
            runtimeFixtures?.setFixtureRunId,
            'test-run selection restore',
            'own',
          );
        }
        requireCondition(
          snapshotDigest(before) ===
            snapshotDigest(
              requireInspection(await inspect(), 'H01 after guards'),
            ),
          'guard denials changed runtime or legacy rows',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-H02-immutable-create-and-replay',
      async () => {
        const operator = clientFor('operator');
        await login(operator, account('operator'), 'H02 operator login');
        await dependencyCall(
          runtimeFixtures?.setTestContentAllowed,
          'test-content enable',
          true,
        );
        await dependencyCall(
          runtimeFixtures?.setCandidateBound,
          'candidate enable',
          true,
        );
        await dependencyCall(
          runtimeFixtures?.setFixtureRunId,
          'test-run selection',
          'own',
        );
        const imported = await importPackage(
          operator,
          fixture,
          'runtime fixture import',
        );
        requireCondition(
          imported.created === true || imported.created === false,
          'runtime import omitted created',
        );
        state.imported = true;
        const request = {
          requestId: 'h02-create-primary',
          contentDigest,
          childId: account('childA').id,
        };
        const created = await createVerification(
          operator,
          version,
          request,
          'primary runtime create',
        );
        requireStatus(created.response, 201, 'primary runtime create');
        requireKeys(
          created.body,
          [
            'childId',
            'createdAt',
            'identity',
            'purpose',
            'runId',
            'schemaVersion',
          ],
          'primary runtime create',
        );
        requireCondition(
          created.body.schemaVersion === 's3-runtime-verification-1',
          'create schema mismatch',
        );
        requireCondition(
          created.body.purpose === 'test-verification',
          'create purpose mismatch',
        );
        requireCondition(
          created.body.childId === account('childA').id,
          'create child mismatch',
        );
        requireCondition(
          typeof created.body.createdAt === 'string' &&
            !Number.isNaN(Date.parse(created.body.createdAt)),
          'create time is not ISO',
        );
        requireKeys(
          created.body.identity,
          [
            'adapterId',
            'adapterVersion',
            'contentDigest',
            'lessonId',
            'lessonVersion',
          ],
          'create identity',
        );
        requireCondition(
          created.body.identity.contentDigest === contentDigest,
          'server digest differs from independent digest',
        );
        state.primaryRun = created.body;
        const first = clone(created.body);
        const replay = await createVerification(
          operator,
          version,
          request,
          'exact create replay',
        );
        requireStatus(replay.response, 200, 'exact create replay');
        requireCondition(
          JSON.stringify(replay.body) === JSON.stringify(first),
          'exact create replay changed metadata',
        );

        const concurrentRequest = {
          requestId: 'h02-create-concurrent',
          contentDigest,
          childId: account('childA').id,
        };
        const concurrentClients = [
          new PilotClient(baseURL),
          new PilotClient(baseURL),
        ];
        await Promise.all(
          concurrentClients.map((client, index) =>
            login(
              client,
              account('operator'),
              `H02 concurrent operator ${index}`,
            ),
          ),
        );
        const concurrent = await Promise.all(
          concurrentClients.map((client) =>
            createVerification(
              client,
              version,
              concurrentRequest,
              'concurrent create',
            ),
          ),
        );
        requireCondition(
          concurrent
            .map((item) => item.response.status)
            .sort((a, b) => a - b)
            .join(',') === '200,201',
          'concurrent create did not produce one create and one replay',
        );
        requireCondition(
          concurrent[0].body.runId === concurrent[1].body.runId,
          'concurrent create made two runs',
        );

        const conflict = await operator.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            body: { ...request, childId: account('childB').id },
          },
        );
        await requireError(
          conflict,
          409,
          'EVENT_CONFLICT',
          'changed request replay',
        );
        const wrongDigest = await operator.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            body: {
              ...request,
              requestId: 'h02-wrong-digest',
              contentDigest: `sha256:${'0'.repeat(64)}`,
            },
          },
        );
        await requireError(
          wrongDigest,
          409,
          'RUNTIME_IDENTITY_MISMATCH',
          'wrong runtime digest',
        );
        const unknown = await operator.request(
          pathFor('forest-unknown-runtime', '/runtime-verifications'),
          {
            method: 'POST',
            body: { ...request, requestId: 'h02-unknown-package' },
          },
        );
        await requireError(
          unknown,
          404,
          'NOT_FOUND',
          'unknown runtime package',
        );
        const unsupportedPackage = clone(fixture);
        unsupportedPackage.lessonVersion = 'forest-unsupported-runtime';
        unsupportedPackage.renderer.adapterId = 'unknown-scripted-adapter';
        await importPackage(
          operator,
          unsupportedPackage,
          'unsupported adapter import',
        );
        const unsupported = await operator.request(
          pathFor(unsupportedPackage.lessonVersion, '/runtime-verifications'),
          {
            method: 'POST',
            body: {
              requestId: 'h02-unsupported-adapter',
              contentDigest: digest(unsupportedPackage),
              childId: account('childA').id,
            },
          },
        );
        await requireError(
          unsupported,
          409,
          'RUNTIME_ADAPTER_UNAVAILABLE',
          'unsupported adapter',
        );
        const extraField = await operator.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            body: { ...request, requestId: 'h02-extra-field', extra: true },
          },
        );
        await requireError(
          extraField,
          400,
          'INVALID_REQUEST',
          'extra create field',
        );
        const malformedJSON = await operator.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            rawBody: '{',
          },
        );
        await requireError(
          malformedJSON,
          400,
          'INVALID_REQUEST',
          'malformed runtime create JSON',
        );
        const snapshot = requireInspection(
          await inspect(),
          'H02 runtime inspection',
        );
        requireCondition(
          snapshot.runs.length === 2 &&
            snapshot.events.length === 0 &&
            snapshot.audit.length === 2,
          'denied create requests left runtime rows or events',
        );
        requireCondition(
          snapshot.runs.every((row) =>
            ['h02-create-primary', 'h02-create-concurrent'].includes(
              rowValue(row, 'request_id', 'requestId'),
            ),
          ),
          'runtime rows do not match the two accepted request IDs',
        );
        requireCondition(
          snapshot.audit.every((row) =>
            ['create'].includes(rowValue(row, 'action')),
          ),
          'create-only runtime audit rows were not retained',
        );
        const primaryRow = snapshot.runs.find(
          (row) => rowValue(row, 'run_id', 'runId') === state.primaryRun.runId,
        );
        requireCondition(object(primaryRow), 'primary runtime row missing');
        requireCondition(
          Number(rowValue(primaryRow, 'revision')) === 0,
          'new runtime revision was not zero',
        );
        requireCondition(
          typeof rowValue(primaryRow, 'run_json', 'runJson') === 'string',
          'full run JSON was not retained',
        );
        const storedRun = JSON.parse(
          rowValue(primaryRow, 'run_json', 'runJson'),
        );
        requireCondition(
          Number.isInteger(storedRun.seed) &&
            Number.isInteger(storedRun.createdAt) &&
            Number.isInteger(storedRun.updatedAt),
          'server-generated seed or clock was not retained in run JSON',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-H03-lesson-and-progress',
      async () => {
        requireDependency(
          state.imported && object(state.primaryRun),
          'primary runtime run',
        );
        await ensureRelationships(baseURL, accounts);
        const child = new PilotClient(baseURL);
        const parent = new PilotClient(baseURL);
        const teacher = new PilotClient(baseURL);
        const operator = new PilotClient(baseURL);
        await login(child, account('childA'), 'H03 child login');
        await login(parent, account('parentA'), 'H03 parent login');
        await login(teacher, account('teacher'), 'H03 teacher login');
        await login(operator, account('operator'), 'H03 operator login');
        const runId = state.primaryRun.runId;
        const viewBody = await getRun(
          child,
          account('childA').id,
          runId,
          'initial runtime view',
        );
        assertRunView(viewBody, 'initial runtime view');
        requireCondition(
          viewBody.run.question === null,
          'initial passive runtime view has a question',
        );
        let run = viewBody.run;
        const send = async (input, label) => {
          const response = await postAction(
            child,
            account('childA').id,
            runId,
            input,
            label,
          );
          run = (
            await getRun(child, account('childA').id, runId, `${label} reload`)
          ).run;
          return response;
        };
        await send(
          {
            eventId: 'h03-intro',
            expectedRevision: run.revision,
            occurrenceId: null,
            type: 'continue',
            payload: {},
          },
          'intro continue',
        );
        let question = run.question;
        requireCondition(
          question?.occurrenceId === 'initial:1:0',
          'familiarity occurrence order changed',
        );
        const firstWrong = await send(
          {
            eventId: 'h03-fam-wrong',
            expectedRevision: run.revision,
            occurrenceId: question.occurrenceId,
            type: 'answer',
            payload: { choiceId: wrongChoice(fixture, question.checkId) },
          },
          'first wrong answer',
        );
        requireCondition(
          firstWrong.ack.result.outcome === 'incorrect' &&
            firstWrong.ack.result.firstResponse === true &&
            firstWrong.ack.result.assisted === false,
          'first wrong response semantics changed',
        );
        const hinted = await send(
          {
            eventId: 'h03-fam-hint',
            expectedRevision: run.revision,
            occurrenceId: run.question.occurrenceId,
            type: 'hint',
            payload: {},
          },
          'explicit hint',
        );
        requireCondition(
          hinted.ack.result.outcome === 'recorded' &&
            hinted.ack.result.firstResponse === false &&
            hinted.ack.result.assisted === true,
          'hint response semantics changed',
        );
        const corrected = await send(
          {
            eventId: 'h03-fam-corrected',
            expectedRevision: run.revision,
            occurrenceId: run.question.occurrenceId,
            type: 'answer',
            payload: {
              choiceId: correctChoice(fixture, run.question.checkId),
            },
          },
          'corrected answer',
        );
        requireCondition(
          corrected.ack.result.outcome === 'correct' &&
            corrected.ack.result.firstResponse === false &&
            corrected.ack.result.assisted === true,
          'corrected response semantics changed',
        );
        await send(
          {
            eventId: 'h03-fam-next',
            expectedRevision: run.revision,
            occurrenceId: run.question.occurrenceId,
            type: 'continue',
            payload: {},
          },
          'familiarity next',
        );
        question = run.question;
        const unavailable = await send(
          {
            eventId: 'h03-fam-unavailable',
            expectedRevision: run.revision,
            occurrenceId: question.occurrenceId,
            type: 'audio-unavailable',
            payload: {},
          },
          'unavailable audio',
        );
        requireCondition(
          unavailable.ack.result.outcome === 'unavailable' &&
            unavailable.ack.result.firstResponse === true,
          'unavailable audio was scored',
        );
        await send(
          {
            eventId: 'h03-to-teach',
            expectedRevision: run.revision,
            occurrenceId: run.question?.occurrenceId ?? null,
            type: 'continue',
            payload: {},
          },
          'teach transition',
        );
        requireCondition(
          run.question === null && run.step.kind === 'teach',
          'teach panel was not passive',
        );
        await send(
          {
            eventId: 'h03-to-practice',
            expectedRevision: run.revision,
            occurrenceId: null,
            type: 'continue',
            payload: {},
          },
          'practice transition',
        );
        question = run.question;
        await send(
          {
            eventId: 'h03-practice-mu',
            expectedRevision: run.revision,
            occurrenceId: question.occurrenceId,
            type: 'answer',
            payload: { choiceId: correctChoice(fixture, question.checkId) },
          },
          'practice first answer',
        );
        await send(
          {
            eventId: 'h03-practice-next',
            expectedRevision: run.revision,
            occurrenceId: run.question.occurrenceId,
            type: 'continue',
            payload: {},
          },
          'practice next',
        );
        question = run.question;
        await send(
          {
            eventId: 'h03-practice-lin',
            expectedRevision: run.revision,
            occurrenceId: question.occurrenceId,
            type: 'answer',
            payload: { choiceId: correctChoice(fixture, question.checkId) },
          },
          'practice second answer',
        );
        await send(
          {
            eventId: 'h03-final',
            expectedRevision: run.revision,
            occurrenceId: run.question?.occurrenceId ?? null,
            type: 'continue',
            payload: {},
          },
          'final transition',
        );
        question = run.question;
        await send(
          {
            eventId: 'h03-final-mu',
            expectedRevision: run.revision,
            occurrenceId: question.occurrenceId,
            type: 'answer',
            payload: { choiceId: correctChoice(fixture, question.checkId) },
          },
          'final first answer',
        );
        await send(
          {
            eventId: 'h03-final-next',
            expectedRevision: run.revision,
            occurrenceId: run.question.occurrenceId,
            type: 'continue',
            payload: {},
          },
          'final next',
        );
        question = run.question;
        await send(
          {
            eventId: 'h03-final-lin',
            expectedRevision: run.revision,
            occurrenceId: question.occurrenceId,
            type: 'answer',
            payload: { choiceId: correctChoice(fixture, question.checkId) },
          },
          'final second answer',
        );
        await send(
          {
            eventId: 'h03-recap',
            expectedRevision: run.revision,
            occurrenceId: run.question?.occurrenceId ?? null,
            type: 'continue',
            payload: {},
          },
          'initial recap',
        );
        state.primaryCompletion = run.completion;
        const progress = await getProgress(
          child,
          account('childA').id,
          runId,
          'child runtime progress',
        );
        assertProgress(progress, 'child runtime progress');
        requireCondition(
          progress.progress.groups.familiarity.supported === 1 &&
            progress.progress.groups.familiarity.unavailable === 1,
          'familiarity evidence groups are wrong',
        );
        requireCondition(
          progress.progress.groups.practice.independentCorrect === 2 &&
            progress.progress.groups.final.independentCorrect === 2,
          'practice/final evidence groups are wrong',
        );
        assertRunView(
          await getRun(
            child,
            account('childA').id,
            runId,
            'completed runtime view',
          ),
          'completed runtime view',
        );
        await getRun(
          parent,
          account('childA').id,
          runId,
          'parent lesson denial',
          403,
        );
        await getRun(
          teacher,
          account('childA').id,
          runId,
          'teacher lesson denial',
          403,
        );
        assertProgress(
          await getProgress(
            parent,
            account('childA').id,
            runId,
            'parent scoped progress',
          ),
          'parent scoped progress',
        );
        assertProgress(
          await getProgress(
            teacher,
            account('childA').id,
            runId,
            'teacher scoped progress',
          ),
          'teacher scoped progress',
        );
        await getProgress(
          operator,
          account('childA').id,
          runId,
          'operator progress denial',
          404,
        );
        const legacy = await parent.request(
          `/api/pilot/children/${encodeURIComponent(account('childA').id)}/progress`,
        );
        requireStatus(legacy, 200, 'legacy progress');
        requireNoStore(legacy, 'legacy progress');
        const legacyBody = dataBody(await jsonBody(legacy));
        requireCondition(
          !Object.hasOwn(legacyBody, 'verificationRuns') &&
            !Object.hasOwn(legacyBody, 'curriculumVerifications'),
          'legacy progress exposed runtime rows',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-H04-concurrency-and-failure',
      async () => {
        requireDependency(state.imported, 'runtime package import');
        const operator = clientFor('operator');
        const childAccount = account('childA');
        const created = await createVerification(
          operator,
          version,
          {
            requestId: 'h04-concurrency-run',
            contentDigest,
            childId: childAccount.id,
          },
          'H04 concurrency run',
        );
        requireStatus(created.response, 201, 'H04 concurrency run');
        const runId = created.body.runId;
        const children = [new PilotClient(baseURL), new PilotClient(baseURL)];
        await Promise.all(
          children.map((client, index) =>
            login(client, childAccount, `H04 child ${index}`),
          ),
        );
        const intro = {
          eventId: 'h04-intro',
          expectedRevision: 0,
          occurrenceId: null,
          type: 'continue',
          payload: {},
        };
        const beforeSame = requireInspection(
          await inspect(),
          'H04 before same-event concurrency',
        );
        const sameResponses = await Promise.all(
          children.map((client) =>
            client.request(runtimePath(childAccount.id, runId, '/actions'), {
              method: 'POST',
              body: intro,
            }),
          ),
        );
        requireCondition(
          sameResponses.every((response) => response.status === 200),
          'same concurrent action did not return HTTP 200',
        );
        const sameBodies = await Promise.all(
          sameResponses.map(async (response, index) => {
            requireNoStore(response, `same concurrent action ${index + 1}`);
            const body = dataBody(await jsonBody(response));
            requireKeys(
              body,
              ['ack', 'replayed', 'schemaVersion'],
              `same concurrent action ${index + 1}`,
            );
            return body;
          }),
        );
        requireCondition(
          sameBodies.some((item) => item.replayed === false) &&
            sameBodies.some((item) => item.replayed === true),
          'same concurrent action did not produce one replay',
        );
        requireCondition(
          JSON.stringify(stable(sameBodies[0].ack)) ===
            JSON.stringify(stable(sameBodies[1].ack)),
          'same concurrent action acknowledgements differ',
        );
        const afterSame = requireInspection(
          await inspect(),
          'H04 after same-event concurrency',
        );
        const sameEvents = afterSame.events.filter(
          (row) => rowValue(row, 'run_id', 'runId') === runId,
        );
        const sameAudit = afterSame.audit.filter(
          (row) => rowValue(row, 'run_id', 'runId') === runId,
        );
        requireCondition(
          sameEvents.length === 1 && sameAudit.length === 2,
          'same concurrent action persisted duplicate event or audit rows',
        );
        requireCondition(
          snapshotDigest(beforeSame) !== snapshotDigest(afterSame),
          'same concurrent action made no persisted change',
        );
        for (const kind of ['time', 'sequence', 'result']) {
          await dependencyCall(
            runtimeFixtures?.setEventCorruption,
            `event corruption enable ${kind}`,
            runId,
            kind,
          );
          try {
            const corrupted = requireInspection(
              await inspect(),
              `H04 corrupted ${kind} inspection`,
            );
            const corruptedView = await children[0].request(
              runtimePath(childAccount.id, runId),
            );
            await requireError(
              corruptedView,
              503,
              'STORAGE_UNAVAILABLE',
              `H04 corrupted ${kind} lesson read`,
            );
            const corruptedProgress = await children[0].request(
              runtimePath(childAccount.id, runId, '/progress'),
            );
            await requireError(
              corruptedProgress,
              503,
              'STORAGE_UNAVAILABLE',
              `H04 corrupted ${kind} progress read`,
            );
            const corruptedReplay = await children[0].request(
              runtimePath(childAccount.id, runId, '/actions'),
              { method: 'POST', body: intro },
            );
            await requireError(
              corruptedReplay,
              503,
              'STORAGE_UNAVAILABLE',
              `H04 corrupted ${kind} exact replay`,
            );
            requireCondition(
              snapshotDigest(corrupted) ===
                snapshotDigest(
                  requireInspection(
                    await inspect(),
                    `H04 corrupted ${kind} after rejection`,
                  ),
                ),
              `corrupted ${kind} requests changed rows`,
            );
          } finally {
            await dependencyCall(
              runtimeFixtures?.setEventCorruption,
              `event corruption restore ${kind}`,
              runId,
              null,
            );
          }
          requireCondition(
            snapshotDigest(afterSame) ===
              snapshotDigest(
                requireInspection(
                  await inspect(),
                  `H04 restored ${kind} inspection`,
                ),
              ),
            `event corruption ${kind} did not restore baseline rows`,
          );
        }
        await getRun(
          children[0],
          childAccount.id,
          runId,
          'H04 restored normal view',
        );
        const malformedAction = await children[0].request(
          runtimePath(childAccount.id, runId, '/actions'),
          { method: 'POST', rawBody: '{' },
        );
        await requireError(
          malformedAction,
          400,
          'INVALID_REQUEST',
          'H04 malformed action JSON',
        );
        const unknownActionField = await children[0].request(
          runtimePath(childAccount.id, runId, '/actions'),
          {
            method: 'POST',
            body: { ...intro, extra: true },
          },
        );
        await requireError(
          unknownActionField,
          400,
          'INVALID_REQUEST',
          'H04 unknown action field',
        );
        const resumed = await getRun(
          children[0],
          childAccount.id,
          runId,
          'H04 concurrent resume',
        );
        const question = resumed.run.question;
        const competing = [
          {
            eventId: 'h04-answer',
            expectedRevision: resumed.run.revision,
            occurrenceId: question.occurrenceId,
            type: 'answer',
            payload: { choiceId: wrongChoice(fixture, question.checkId) },
          },
          {
            eventId: 'h04-hint',
            expectedRevision: resumed.run.revision,
            occurrenceId: question.occurrenceId,
            type: 'hint',
            payload: {},
          },
        ];
        const competitorResponses = await Promise.all(
          competing.map((input, index) =>
            children[index].request(
              runtimePath(childAccount.id, runId, '/actions'),
              {
                method: 'POST',
                body: input,
              },
            ),
          ),
        );
        requireCondition(
          competitorResponses
            .map((response) => response.status)
            .sort((a, b) => a - b)
            .join(',') === '200,409',
          'competing event IDs did not yield exactly one winner and one stale response',
        );
        const loserIndex = competitorResponses[0].status === 409 ? 0 : 1;
        await requireError(
          competitorResponses[loserIndex],
          409,
          'STALE_REVISION',
          'competing stale action',
        );
        const winnerIndex = loserIndex === 0 ? 1 : 0;
        requireNoStore(competitorResponses[winnerIndex], 'competing winner');
        const winnerBody = dataBody(
          await jsonBody(competitorResponses[winnerIndex]),
        );
        requireKeys(
          winnerBody,
          ['ack', 'replayed', 'schemaVersion'],
          'competing winner',
        );
        requireKeys(
          winnerBody.ack,
          ['eventId', 'result', 'revision'],
          'competing winner ack',
        );
        requireCondition(
          winnerBody.replayed === false,
          'competing winner was unexpectedly replayed',
        );
        const acceptedInput = competing[winnerIndex];
        const conflict = await children[0].request(
          runtimePath(childAccount.id, runId, '/actions'),
          {
            method: 'POST',
            body: { ...acceptedInput, type: 'continue', payload: {} },
          },
        );
        await requireError(
          conflict,
          409,
          'EVENT_CONFLICT',
          'changed action replay',
        );

        const faultRun = await createVerification(
          operator,
          version,
          {
            requestId: 'h04-fault-run',
            contentDigest,
            childId: childAccount.id,
          },
          'H04 fault run',
        );
        requireStatus(faultRun.response, 201, 'H04 fault run');
        const faultRunId = faultRun.body.runId;
        const beforeEventFault = requireInspection(
          await inspect(),
          'H04 before event fault',
        );
        await dependencyCall(
          runtimeFixtures?.setWriteFault,
          'event fault enable',
          'event',
        );
        try {
          const failedEvent = await children[0].request(
            runtimePath(childAccount.id, faultRunId, '/actions'),
            {
              method: 'POST',
              body: {
                eventId: 'h04-event-fault',
                expectedRevision: 0,
                occurrenceId: null,
                type: 'continue',
                payload: {},
              },
            },
          );
          await requireError(
            failedEvent,
            503,
            'STORAGE_UNAVAILABLE',
            'event fault rollback',
          );
          requireCondition(
            snapshotDigest(beforeEventFault) ===
              snapshotDigest(
                requireInspection(await inspect(), 'H04 after event fault'),
              ),
            'event fault committed partial rows',
          );
        } finally {
          await dependencyCall(
            runtimeFixtures?.setWriteFault,
            'event fault restore',
            null,
          );
        }
        await postAction(
          children[0],
          childAccount.id,
          faultRunId,
          {
            eventId: 'h04-event-fault',
            expectedRevision: 0,
            occurrenceId: null,
            type: 'continue',
            payload: {},
          },
          'event fault retry',
        );
        const beforeAuditFault = requireInspection(
          await inspect(),
          'H04 before audit fault',
        );
        await dependencyCall(
          runtimeFixtures?.setWriteFault,
          'audit fault enable',
          'audit',
        );
        try {
          const faultView = await getRun(
            children[0],
            childAccount.id,
            faultRunId,
            'H04 audit fault view',
          );
          const failedAudit = await children[0].request(
            runtimePath(childAccount.id, faultRunId, '/actions'),
            {
              method: 'POST',
              body: {
                eventId: 'h04-audit-fault',
                expectedRevision: faultView.run.revision,
                occurrenceId: faultView.run.question.occurrenceId,
                type: 'hint',
                payload: {},
              },
            },
          );
          await requireError(
            failedAudit,
            503,
            'STORAGE_UNAVAILABLE',
            'audit fault rollback',
          );
          requireCondition(
            snapshotDigest(beforeAuditFault) ===
              snapshotDigest(
                requireInspection(await inspect(), 'H04 after audit fault'),
              ),
            'audit fault committed partial rows',
          );
        } finally {
          await dependencyCall(
            runtimeFixtures?.setWriteFault,
            'audit fault restore',
            null,
          );
        }
        const retryView = await getRun(
          children[0],
          childAccount.id,
          faultRunId,
          'H04 audit retry view',
        );
        await postAction(
          children[0],
          childAccount.id,
          faultRunId,
          {
            eventId: 'h04-audit-fault',
            expectedRevision: retryView.run.revision,
            occurrenceId: retryView.run.question.occurrenceId,
            type: 'hint',
            payload: {},
          },
          'audit fault retry',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-H05-fresh-authorization',
      async () => {
        requireDependency(
          state.imported && object(state.primaryRun),
          'primary runtime run',
        );
        const child = new PilotClient(baseURL);
        const parentB = new PilotClient(baseURL);
        const otherTeacher = new PilotClient(baseURL);
        const operator = clientFor('operator');
        await login(child, account('childA'), 'H05 child login');
        await login(parentB, account('parentB'), 'H05 unrelated parent login');
        await login(
          otherTeacher,
          account('otherTeacher'),
          'H05 unrelated teacher login',
        );
        await getRun(
          child,
          account('childA').id,
          state.primaryRun.runId,
          'H05 child access',
        );
        await getRun(
          child,
          account('childB').id,
          state.primaryRun.runId,
          'H05 foreign child route',
          404,
        );
        await getProgress(
          parentB,
          account('childA').id,
          state.primaryRun.runId,
          'H05 unrelated parent',
          404,
        );
        await getProgress(
          otherTeacher,
          account('childA').id,
          state.primaryRun.runId,
          'H05 unrelated teacher',
          404,
        );
        await getRun(
          parentB,
          account('childA').id,
          state.primaryRun.runId,
          'H05 unrelated parent lesson',
          404,
        );
        await getRun(
          otherTeacher,
          account('childA').id,
          state.primaryRun.runId,
          'H05 unrelated teacher lesson',
          404,
        );
        const foreignAction = await child.request(
          runtimePath(account('childB').id, state.primaryRun.runId, '/actions'),
          {
            method: 'POST',
            body: {
              eventId: 'h05-foreign-action',
              expectedRevision: 0,
              occurrenceId: null,
              type: 'continue',
              payload: {},
            },
          },
        );
        await requireError(
          foreignAction,
          404,
          'NOT_FOUND',
          'H05 foreign child action',
        );
        const parentA = new PilotClient(baseURL);
        const teacher = new PilotClient(baseURL);
        await login(parentA, account('parentA'), 'H05 parent login');
        await login(teacher, account('teacher'), 'H05 teacher login');
        for (const [label, client] of [
          ['H05 linked parent action', parentA],
          ['H05 linked teacher action', teacher],
        ]) {
          const deniedAction = await client.request(
            runtimePath(
              account('childA').id,
              state.primaryRun.runId,
              '/actions',
            ),
            {
              method: 'POST',
              body: {
                eventId: 'h03-intro',
                expectedRevision: 0,
                occurrenceId: null,
                type: 'continue',
                payload: {},
              },
            },
          );
          await requireError(deniedAction, 403, 'FORBIDDEN', label);
        }
        const ownRevoke = await parentA.request('/api/pilot/grants', {
          method: 'DELETE',
          body: {
            childId: account('childA').id,
            teacherId: account('teacher').id,
          },
        });
        requireStatus(ownRevoke, [200, 404], 'H05 teacher revoke');
        await getProgress(
          teacher,
          account('childA').id,
          state.primaryRun.runId,
          'H05 revoked teacher',
          404,
        );
        const restoreGrant = await parentA.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: account('childA').id,
            teacherId: account('teacher').id,
          },
        });
        requireStatus(
          restoreGrant,
          [200, 201, 409],
          'H05 teacher grant restore',
        );
        const restoredTeacherProgress = await getProgress(
          teacher,
          account('childA').id,
          state.primaryRun.runId,
          'H05 restored teacher',
        );
        assertProgress(restoredTeacherProgress, 'H05 restored teacher');

        const beforeDisabledAction = requireInspection(
          await inspect(),
          'H05 before disabled exact action',
        );
        const disable = await operator.request(
          `/api/pilot/accounts/${encodeURIComponent(account('childA').id)}/status`,
          { method: 'POST', body: { disabled: true } },
        );
        requireStatus(disable, [200, 201], 'H05 disable child');
        try {
          await getRun(
            child,
            account('childA').id,
            state.primaryRun.runId,
            'H05 disabled child read',
            401,
          );
          const disabledAction = await child.request(
            runtimePath(
              account('childA').id,
              state.primaryRun.runId,
              '/actions',
            ),
            {
              method: 'POST',
              body: {
                eventId: 'h03-intro',
                expectedRevision: 0,
                occurrenceId: null,
                type: 'continue',
                payload: {},
              },
            },
          );
          await requireError(
            disabledAction,
            401,
            'UNAUTHORIZED',
            'H05 disabled child exact action',
          );
          await getProgress(
            parentA,
            account('childA').id,
            state.primaryRun.runId,
            'H05 disabled parent progress',
            404,
          );
          await getProgress(
            teacher,
            account('childA').id,
            state.primaryRun.runId,
            'H05 disabled teacher progress',
            404,
          );
          const disabledCreate = await operator.request(
            pathFor(version, '/runtime-verifications'),
            {
              method: 'POST',
              body: {
                requestId: 'h02-create-primary',
                contentDigest,
                childId: account('childA').id,
              },
            },
          );
          await requireError(
            disabledCreate,
            404,
            'NOT_FOUND',
            'H05 disabled child exact create retry',
          );
          requireCondition(
            snapshotDigest(beforeDisabledAction) ===
              snapshotDigest(
                requireInspection(
                  await inspect(),
                  'H05 after disabled denials',
                ),
              ),
            'disabled child denials changed runtime rows',
          );
        } finally {
          const enable = await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(account('childA').id)}/status`,
            { method: 'POST', body: { disabled: false } },
          );
          requireStatus(enable, [200, 201], 'H05 enable child');
        }
        const childB = new PilotClient(baseURL);
        await login(childB, account('childB'), 'H05 childB login');
        const childBRun = await createVerification(
          operator,
          version,
          {
            requestId: 'h05-child-b-run',
            contentDigest,
            childId: account('childB').id,
          },
          'H05 childB run',
        );
        requireStatus(childBRun.response, 201, 'H05 childB run');
        state.childBRun = childBRun.body;
        const childBIntroAction = {
          eventId: 'h05-child-b-intro',
          expectedRevision: 0,
          occurrenceId: null,
          type: 'continue',
          payload: {},
        };
        await postAction(
          childB,
          account('childB').id,
          state.childBRun.runId,
          childBIntroAction,
          'H05 childB accepted action',
        );
        const beforeChildBReset = requireInspection(
          await inspect(),
          'H05 before childB reset',
        );
        const resetPassword = `Runtime-reset-${Date.now()}`;
        state.secrets.push(resetPassword);
        const reset = await operator.request(
          `/api/pilot/accounts/${encodeURIComponent(account('childB').id)}/reset`,
          { method: 'POST', body: { password: resetPassword } },
        );
        requireStatus(reset, [200, 201], 'H05 childB reset');
        const oldSessionAction = await childB.request(
          runtimePath(account('childB').id, state.childBRun.runId, '/actions'),
          { method: 'POST', body: childBIntroAction },
        );
        await requireError(
          oldSessionAction,
          401,
          'UNAUTHORIZED',
          'H05 reset old-session exact action',
        );
        await getRun(
          childB,
          account('childB').id,
          state.childBRun.runId,
          'H05 reset old session',
          401,
        );
        const forced = new PilotClient(baseURL);
        await login(
          forced,
          { ...account('childB'), password: resetPassword },
          'H05 forced-change login',
        );
        await getRun(
          forced,
          account('childB').id,
          state.childBRun.runId,
          'H05 forced-change read',
          403,
          'PASSWORD_CHANGE_REQUIRED',
        );
        const forcedAction = await forced.request(
          runtimePath(account('childB').id, state.childBRun.runId, '/actions'),
          { method: 'POST', body: childBIntroAction },
        );
        await requireError(
          forcedAction,
          403,
          'PASSWORD_CHANGE_REQUIRED',
          'H05 forced-change exact action',
        );
        const changedPassword = `Runtime-changed-${Date.now()}`;
        state.secrets.push(changedPassword);
        const change = await forced.request('/api/auth/change-password', {
          method: 'POST',
          body: {
            currentPassword: resetPassword,
            newPassword: changedPassword,
            revokeOtherSessions: true,
          },
        });
        requireStatus(change, 200, 'H05 forced-change completion');
        const restored = new PilotClient(baseURL);
        await login(
          restored,
          { ...account('childB'), password: changedPassword },
          'H05 restored childB login',
        );
        await getRun(
          restored,
          account('childB').id,
          state.childBRun.runId,
          'H05 restored childB read',
        );
        requireCondition(
          snapshotDigest(beforeChildBReset) ===
            snapshotDigest(
              requireInspection(await inspect(), 'H05 after childB reset'),
            ),
          'childB password recovery changed runtime rows or history',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-H06-durable-resume-and-due-review',
      async () => {
        requireDependency(
          state.imported && object(state.primaryRun),
          'primary runtime run',
        );
        const child = new PilotClient(baseURL);
        await login(child, account('childA'), 'H06 child login');
        const beforeRestart = await getRun(
          child,
          account('childA').id,
          state.primaryRun.runId,
          'H06 before restart',
        );
        const initialCompletion =
          beforeRestart.run.completion.initialCompletedAt;
        requireCondition(
          typeof initialCompletion === 'string',
          'H06 initial completion timestamp missing',
        );
        await dependencyCall(restart, 'runtime Worker restart');
        const afterRestart = await getRun(
          child,
          account('childA').id,
          state.primaryRun.runId,
          'H06 after restart',
        );
        requireCondition(
          JSON.stringify(afterRestart.run) ===
            JSON.stringify(beforeRestart.run),
          'safe runtime view changed across restart',
        );
        const completedMs = Date.parse(initialCompletion);
        requireCondition(
          Number.isFinite(completedMs),
          'H06 completion timestamp is invalid',
        );
        await dependencyCall(
          runtimeFixtures?.setClock,
          'runtime clock before due',
          completedMs + DAY - 1,
        );
        try {
          const early = await child.request(
            runtimePath(
              account('childA').id,
              state.primaryRun.runId,
              '/actions',
            ),
            {
              method: 'POST',
              body: {
                eventId: 'h06-review-start',
                expectedRevision: beforeRestart.run.revision,
                occurrenceId: null,
                type: 'start-review',
                payload: {},
              },
            },
          );
          await requireError(early, 409, 'REVIEW_NOT_DUE', 'H06 early review');
          await dependencyCall(
            runtimeFixtures?.setClock,
            'runtime clock at due',
            completedMs + DAY,
          );
          const due = await postAction(
            child,
            account('childA').id,
            state.primaryRun.runId,
            {
              eventId: 'h06-review-start',
              expectedRevision: beforeRestart.run.revision,
              occurrenceId: null,
              type: 'start-review',
              payload: {},
            },
            'H06 due review',
          );
          requireCondition(
            due.replayed === false,
            'H06 due review unexpectedly replayed',
          );
          const delayed = await getRun(
            child,
            account('childA').id,
            state.primaryRun.runId,
            'H06 delayed view',
          );
          requireCondition(
            delayed.run.phase === 'delayed' &&
              delayed.run.step.kind === 'delayed-review',
            'H06 delayed phase missing',
          );
          const replay = await postAction(
            child,
            account('childA').id,
            state.primaryRun.runId,
            {
              eventId: 'h06-review-start',
              expectedRevision: beforeRestart.run.revision,
              occurrenceId: null,
              type: 'start-review',
              payload: {},
            },
            'H06 exact review replay',
          );
          requireCondition(
            replay.replayed === true,
            'H06 exact review replay was not marked replayed',
          );
          let run = delayed.run;
          const send = async (input, label) => {
            const response = await postAction(
              child,
              account('childA').id,
              state.primaryRun.runId,
              input,
              label,
            );
            run = (
              await getRun(
                child,
                account('childA').id,
                state.primaryRun.runId,
                `${label} reload`,
              )
            ).run;
            return response;
          };
          const delayedQuestion = run.question;
          await send(
            {
              eventId: 'h06-delayed-unavailable',
              expectedRevision: run.revision,
              occurrenceId: delayedQuestion.occurrenceId,
              type: 'audio-unavailable',
              payload: {},
            },
            'H06 delayed unavailable',
          );
          await send(
            {
              eventId: 'h06-delayed-next',
              expectedRevision: run.revision,
              occurrenceId: run.question.occurrenceId,
              type: 'continue',
              payload: {},
            },
            'H06 delayed next',
          );
          await send(
            {
              eventId: 'h06-delayed-correct',
              expectedRevision: run.revision,
              occurrenceId: run.question.occurrenceId,
              type: 'answer',
              payload: {
                choiceId: correctChoice(fixture, run.question.checkId),
              },
            },
            'H06 delayed correct',
          );
          await send(
            {
              eventId: 'h06-delayed-complete',
              expectedRevision: run.revision,
              occurrenceId: run.question?.occurrenceId ?? null,
              type: 'continue',
              payload: {},
            },
            'H06 delayed completion',
          );
          requireCondition(
            run.phase === 'delayed' &&
              run.question === null &&
              run.step.kind === 'recap',
            'H06 delayed recap missing',
          );
          const repeated = await child.request(
            runtimePath(
              account('childA').id,
              state.primaryRun.runId,
              '/actions',
            ),
            {
              method: 'POST',
              body: {
                eventId: 'h06-repeat-complete',
                expectedRevision: run.revision,
                occurrenceId: null,
                type: 'continue',
                payload: {},
              },
            },
          );
          await requireError(
            repeated,
            409,
            'INVALID_TRANSITION',
            'H06 repeated completion',
          );
          const progress = await getProgress(
            child,
            account('childA').id,
            state.primaryRun.runId,
            'H06 delayed progress',
          );
          assertProgress(progress, 'H06 delayed progress');
          requireCondition(
            progress.progress.groups.delayed.unavailable === 1 &&
              progress.progress.groups.delayed.independentCorrect === 1,
            'H06 delayed evidence was merged or scored incorrectly',
          );
        } finally {
          await dependencyCall(
            runtimeFixtures?.setClock,
            'runtime clock restore',
            null,
          );
        }
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-H07-installation-and-namespace-history',
      async () => {
        requireDependency(
          state.imported && object(state.primaryRun),
          'primary runtime run',
        );
        const child = new PilotClient(baseURL);
        const operator = clientFor('operator');
        await login(child, account('childA'), 'H07 child login');
        await login(operator, account('operator'), 'H07 operator login');
        const before = requireInspection(
          await inspect(),
          'H07 before binding changes',
        );
        await dependencyCall(
          runtimeFixtures?.setCandidateBound,
          'H07 candidate disable',
          false,
        );
        try {
          await getRun(
            child,
            account('childA').id,
            state.primaryRun.runId,
            'H07 candidate binding denial',
            404,
          );
        } finally {
          await dependencyCall(
            runtimeFixtures?.setCandidateBound,
            'H07 candidate restore',
            true,
          );
        }
        await dependencyCall(
          runtimeFixtures?.setFixtureRunId,
          'H07 foreign run selection',
          'foreign',
        );
        try {
          await getRun(
            child,
            account('childA').id,
            state.primaryRun.runId,
            'H07 test-run binding denial',
            404,
          );
        } finally {
          await dependencyCall(
            runtimeFixtures?.setFixtureRunId,
            'H07 test-run restore',
            'own',
          );
        }
        const rotated = await dependencyCall(
          runtimeFixtures?.rotateInstallation,
          'H07 installation rotation',
        );
        requireCondition(
          typeof rotated === 'string' && rotated.length > 0,
          'H07 rotation did not return a new installation ID',
        );
        await getRun(
          child,
          account('childA').id,
          state.primaryRun.runId,
          'H07 historical run read after rotation',
          404,
        );
        const staleAction = await child.request(
          runtimePath(account('childA').id, state.primaryRun.runId, '/actions'),
          {
            method: 'POST',
            body: {
              eventId: 'h07-old-installation-action',
              expectedRevision: state.primaryRun.revision,
              occurrenceId: null,
              type: 'continue',
              payload: {},
            },
          },
        );
        await requireError(
          staleAction,
          404,
          'NOT_FOUND',
          'H07 historical action after rotation',
        );
        await getProgress(
          child,
          account('childA').id,
          state.primaryRun.runId,
          'H07 historical progress after rotation',
          404,
        );
        const afterRotation = requireInspection(
          await inspect(),
          'H07 after rotation',
        );
        for (const key of ['runs', 'events', 'audit']) {
          requireCondition(
            JSON.stringify(stable(afterRotation[key])) ===
              JSON.stringify(stable(before[key])),
            `installation rotation changed historical ${key}`,
          );
        }
        requireCondition(
          afterRotation.runs.length === before.runs.length,
          'installation rotation deleted historical runs',
        );
        requireCondition(
          JSON.stringify(stable(afterRotation.legacyCounts)) ===
            JSON.stringify(stable(before.legacyCounts)),
          'installation rotation changed legacy data',
        );
        const oldRequest = await operator.request(
          pathFor(version, '/runtime-verifications'),
          {
            method: 'POST',
            body: {
              requestId: 'h02-create-primary',
              contentDigest,
              childId: account('childA').id,
            },
          },
        );
        await requireError(
          oldRequest,
          409,
          'EVENT_CONFLICT',
          'H07 historical request ID reuse',
        );
        const fresh = await createVerification(
          operator,
          version,
          {
            requestId: 'h07-current-installation',
            contentDigest,
            childId: account('childA').id,
          },
          'H07 new installation run',
        );
        requireStatus(fresh.response, 201, 'H07 new installation run');
        const final = requireInspection(
          await inspect(),
          'H07 final inspection',
        );
        requireCondition(
          final.runs.length === before.runs.length + 1,
          'current installation did not create a fresh run',
        );
        requireCondition(
          JSON.stringify(stable(final.legacyCounts)) ===
            JSON.stringify(stable(before.legacyCounts)),
          'runtime verification changed legacy counts',
        );
        requireCondition(
          final.registryRevision === before.registryRevision,
          'runtime verification changed registry revision',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  try {
    if (typeof runtimeFixtures?.setWriteFault === 'function')
      await runtimeFixtures.setWriteFault(null);
    if (typeof runtimeFixtures?.setClock === 'function')
      await runtimeFixtures.setClock(null);
    if (typeof runtimeFixtures?.setCandidateBound === 'function')
      await runtimeFixtures.setCandidateBound(true);
    if (typeof runtimeFixtures?.setFixtureRunId === 'function')
      await runtimeFixtures.setFixtureRunId('own');
    if (typeof runtimeFixtures?.setTestContentAllowed === 'function')
      await runtimeFixtures.setTestContentAllowed(true);
  } catch {
    // Scenario failures remain the useful evidence; cleanup is runner-owned.
  }
  return results;
}
