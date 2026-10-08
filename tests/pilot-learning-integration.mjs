/*
 * Sprint 2 authenticated learning HTTP probe.
 *
 * The runner supplies ordinary seeded accounts and disposable release/event
 * controls. This file deliberately keeps the lesson oracle in the reviewed
 * specification and sends only HTTP requests through the learner API.
 */

const LESSON_VERSION = 'forest-01-v1';
const LESSON_ID = 'forest-01';
const QUESTION_CHOICES = Object.freeze({
  'fam-mu': { correct: 'mu', wrong: 'lin' },
  'fam-lin': { correct: 'lin', wrong: 'mu' },
  'find-mu': { correct: 'mu', wrong: 'lin' },
  'find-lin': { correct: 'lin', wrong: 'mu' },
  'check-mu-sound': { correct: 'mu', wrong: 'lin' },
  'check-lin-sound': { correct: 'lin', wrong: 'mu' },
  'check-mu-reading': { correct: 'audio-mu', wrong: 'audio-lin' },
  'check-lin-reading': { correct: 'audio-lin', wrong: 'audio-mu' },
  'review-mu-sound': { correct: 'mu', wrong: 'lin' },
  'review-lin-sound': { correct: 'lin', wrong: 'mu' },
});

const JSON_HEADERS = { Accept: 'application/json' };
let nextSyntheticIP = 1;

function syntheticIP() {
  const value = nextSyntheticIP;
  nextSyntheticIP = (nextSyntheticIP % 240) + 1;
  return `198.51.100.${value}`;
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function requireNoStore(response, label) {
  requireCondition(
    /(?:^|,\s*)no-store(?:\s*,|$)/i.test(
      response.headers.get('cache-control') || '',
    ),
    `${label} did not send Cache-Control: no-store`,
  );
}

function requireSuccess(response, label) {
  requireCondition(
    response.status >= 200 && response.status < 300,
    `${label} returned HTTP ${response.status}`,
  );
}

function requireObject(body, label) {
  requireCondition(object(body), `${label} did not return a JSON object`);
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

async function errorBody(response) {
  const body = await jsonBody(response);
  const root = dataBody(body);
  return object(root.error) ? root.error : root;
}

async function requireError(response, status, code, label) {
  requireStatus(response, status, label);
  requireNoStore(response, label);
  const error = await errorBody(response);
  requireCondition(
    object(error) && error.code === code && typeof error.message === 'string',
    `${label} did not return ${code}`,
  );
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

function collectEntries(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectEntries(item, output));
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      output.push({ key, value: child });
      collectEntries(child, output);
    }
  }
  return output;
}

function requireSafeJSON(body, label) {
  requireObject(body, label);
  const forbidden = /(?:password|hash|token|secret|email)/i;
  const forbiddenValue = /@[^\s"']+\.invalid\b/i;
  requireCondition(
    !collectEntries(body).some(
      ({ key, value }) =>
        (forbidden.test(key) &&
          !(key === 'mustChangePassword' && typeof value === 'boolean')) ||
        (typeof value === 'string' && forbiddenValue.test(value)),
    ),
    `${label} returned a credential field`,
  );
}

function requireNoMastery(body, label) {
  requireCondition(
    !collectKeys(body).some((key) => /mastery|mastered/i.test(key)),
    `${label} returned a mastery claim`,
  );
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
  let message =
    error instanceof Error
      ? error.message
      : 'pilot learning integration assertion failed';
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

class CookieJar {
  #cookies = new Map();

  attach(headers) {
    if (!this.#cookies.size) return;
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
      if (!cookieValue) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]*)/g);
}

class PilotClient {
  constructor(baseURL, ipAddress = syntheticIP()) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.ipAddress = ipAddress;
    this.cookies = new CookieJar();
  }

  async request(
    path,
    { method = 'GET', body, origin = this.origin, headers = {} } = {},
  ) {
    const requestHeaders = new Headers({ ...JSON_HEADERS, ...headers });
    // This probe deliberately restarts its owned Worker. Avoid reusing a
    // connection from the prior process; assertions still execute once.
    requestHeaders.set('Connection', 'close');
    if (!requestHeaders.has('X-Forwarded-For'))
      requestHeaders.set('X-Forwarded-For', this.ipAddress);
    if (!requestHeaders.has('CF-Connecting-IP'))
      requestHeaders.set('CF-Connecting-IP', this.ipAddress);
    if (body !== undefined) {
      requestHeaders.set('Content-Type', 'application/json');
    }
    if (origin !== null) requestHeaders.set('Origin', origin);
    this.cookies.attach(requestHeaders);
    const request = { method, headers: requestHeaders, redirect: 'manual' };
    if (body !== undefined) request.body = JSON.stringify(body);
    const response = await fetch(`${this.baseURL}${path}`, request);
    this.cookies.store(response);
    return response;
  }
}

async function login(client, account, label) {
  const response = await client.request('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username: account.username, password: account.password },
  });
  requireSuccess(response, label);
  requireSafeJSON(await jsonBody(response), `${label} response`);
}

function childPath(childID, suffix = '') {
  return `/api/pilot/children/${encodeURIComponent(childID)}${suffix}`;
}

async function readOnboarding(
  client,
  childID,
  label,
  expectedStatus = 200,
  expectedCode = null,
) {
  const response = await client.request(childPath(childID, '/onboarding'));
  requireStatus(response, expectedStatus, `${label} onboarding read`);
  requireNoStore(response, `${label} onboarding read`);
  if (expectedStatus !== 200) {
    if (expectedCode) {
      const error = await errorBody(response);
      requireCondition(
        object(error) &&
          error.code === expectedCode &&
          typeof error.message === 'string',
        `${label} onboarding read did not return ${String(expectedCode)}`,
      );
    }
    return null;
  }
  const body = await jsonBody(response);
  requireSafeJSON(body, `${label} onboarding`);
  requireCondition(
    Object.hasOwn(body, 'onboarding'),
    `${label} omitted onboarding`,
  );
  return body;
}

async function readAssignments(client, childID, label, expectedStatus = 200) {
  const response = await client.request(childPath(childID, '/assignments'));
  requireStatus(response, expectedStatus, `${label} assignments read`);
  requireNoStore(response, `${label} assignments read`);
  if (expectedStatus !== 200) return null;
  const body = await jsonBody(response);
  requireSafeJSON(body, `${label} assignments`);
  requireCondition(
    Array.isArray(body.assignments) && Array.isArray(body.availableLessons),
    `${label} assignments omitted its lists`,
  );
  const lesson = body.availableLessons.find(
    (item) => object(item) && item.lessonVersion === LESSON_VERSION,
  );
  requireCondition(object(lesson), `${label} omitted the forest lesson`);
  requireCondition(
    lesson.lessonId === LESSON_ID &&
      typeof lesson.title === 'string' &&
      ['pending', 'approved', 'test-fixture'].includes(lesson.releaseState) &&
      typeof lesson.canAssign === 'boolean',
    `${label} forest release metadata is invalid`,
  );
  return { body, lesson };
}

async function readRun(client, childID, runID, label, expectedStatus = 200) {
  const response = await client.request(
    childPath(childID, `/runs/${encodeURIComponent(runID)}`),
  );
  requireStatus(response, expectedStatus, `${label} run read`);
  requireNoStore(response, `${label} run read`);
  if (expectedStatus !== 200) return null;
  const body = await jsonBody(response);
  requireSafeJSON(body, `${label} run`);
  requireCondition(
    body.runId === runID &&
      body.childId === childID &&
      body.lessonId === LESSON_ID &&
      body.lessonVersion === LESSON_VERSION &&
      Number.isInteger(body.revision) &&
      object(body.state),
    `${label} run projection is incomplete`,
  );
  requireNoMastery(body, `${label} run`);
  return body;
}

function actionEnvelope(eventId, run, type, payload, extra = {}) {
  return {
    eventId,
    expectedRevision: run.revision,
    stepId: run.state.stepId,
    type,
    payload,
    ...extra,
  };
}

async function runAction(
  client,
  childID,
  runID,
  request,
  label,
  expectedStatus = 200,
) {
  const response = await client.request(
    childPath(childID, `/runs/${encodeURIComponent(runID)}/actions`),
    { method: 'POST', body: request },
  );
  requireStatus(response, expectedStatus, label);
  requireNoStore(response, label);
  if (expectedStatus !== 200) return null;
  const body = await jsonBody(response);
  requireSafeJSON(body, `${label} response`);
  requireCondition(
    body.eventId === request.eventId &&
      object(body.result) &&
      object(body.state) &&
      body.revision === request.expectedRevision + 1,
    `${label} acknowledgement is incomplete`,
  );
  requireNoMastery(body, `${label} response`);
  return body;
}

function runIDsFromProgress(body) {
  return Array.isArray(body.runs)
    ? body.runs
        .filter((run) => object(run) && typeof run.runId === 'string')
        .map((run) => run.runId)
    : [];
}

function runIDFromRow(row) {
  if (!object(row)) return '';
  return typeof row.run_id === 'string'
    ? row.run_id
    : typeof row.runId === 'string'
      ? row.runId
      : typeof row.id === 'string'
        ? row.id
        : '';
}

function eventIDFromRow(row) {
  if (!object(row)) return '';
  return typeof row.event_id === 'string'
    ? row.event_id
    : typeof row.eventId === 'string'
      ? row.eventId
      : '';
}

function learningRows(snapshot, key) {
  requireObject(snapshot, 'learning inspection');
  requireCondition(
    Array.isArray(snapshot[key]),
    `learning inspection omitted ${key}`,
  );
  return snapshot[key];
}

function learningEventCount(snapshot, runID) {
  return learningRows(snapshot, 'events').filter(
    (row) => runIDFromRow(row) === runID,
  ).length;
}

function requireOwnedRun(snapshot, runID, childID) {
  const ownership = learningRows(snapshot, 'ownership').find(
    (row) =>
      runIDFromRow(row) === runID &&
      object(row) &&
      (row.child_id === childID || row.childId === childID),
  );
  requireCondition(
    Boolean(ownership),
    'learning inspection omitted run ownership',
  );
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
 * Run L-01 through L-06 against a fresh pilot Worker/D1 installation using
 * ordinary seeded credentials. Test controls are supplied as callbacks by the
 * disposable runner; they never become HTTP authentication shortcuts.
 */
export async function runPilotLearningIntegration({
  baseURL,
  accounts,
  restart,
  testRunId,
  setRelease,
  setTestContentAllowed,
  setLearningEventsAvailable,
  inspectLearning,
}) {
  const clients = new Map();
  const state = {
    linksReady: false,
    onboardingReady: false,
    releaseReady: false,
    assignmentReady: false,
    teacherGrantReady: false,
    runID: null,
    actionsReady: false,
    secrets: [],
  };
  const clientFor = (key) => {
    if (!clients.has(key)) clients.set(key, new PilotClient(baseURL));
    return clients.get(key);
  };
  const account = (key) => accountFor(accounts, key);
  const results = [];

  results.push(
    await runCase(
      'L-01-onboarding-and-family-boundary',
      async () => {
        const operator = clientFor('operator');
        const parentA = clientFor('parentA');
        const parentB = clientFor('parentB');
        const childA = clientFor('childA');
        const teacher = clientFor('teacher');
        await login(operator, account('operator'), 'operator sign-in');
        await login(parentA, account('parentA'), 'parent A sign-in');
        await login(parentB, account('parentB'), 'parent B sign-in');
        await login(childA, account('childA'), 'child A sign-in');
        await login(teacher, account('teacher'), 'teacher sign-in');

        for (const [parentKey, childKey] of [
          ['parentA', 'childA'],
          ['parentB', 'childB'],
        ]) {
          const link = await operator.request('/api/pilot/links', {
            method: 'POST',
            body: {
              parentId: account(parentKey).id,
              childId: account(childKey).id,
            },
          });
          requireSuccess(link, `${parentKey} child link`);
        }
        state.linksReady = true;

        const grant = await parentA.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: account('childA').id,
            teacherId: account('teacher').id,
          },
        });
        requireSuccess(grant, 'teacher grant for onboarding boundary');
        state.teacherGrantReady = true;

        const initial = await readOnboarding(
          parentA,
          account('childA').id,
          'parent A initial',
        );
        requireCondition(
          initial.onboarding === null,
          'new child has onboarding data',
        );

        const onboarding = {
          nickname: 'Mina',
          experience: 'new',
          audioReady: false,
        };
        const savedResponse = await parentA.request(
          childPath(account('childA').id, '/onboarding'),
          { method: 'PUT', body: onboarding },
        );
        requireStatus(savedResponse, 200, 'parent A onboarding save');
        requireNoStore(savedResponse, 'parent A onboarding save');
        const saved = await jsonBody(savedResponse);
        requireSafeJSON(saved, 'parent A onboarding save');
        requireCondition(
          object(saved.onboarding) &&
            saved.onboarding.nickname === onboarding.nickname &&
            saved.onboarding.experience === onboarding.experience &&
            saved.onboarding.audioReady === false &&
            typeof saved.onboarding.updatedAt === 'string' &&
            saved.onboarding.updatedBy === account('parentA').id,
          'onboarding save returned the wrong projection',
        );

        const reloaded = await readOnboarding(
          parentA,
          account('childA').id,
          'parent A reload',
        );
        requireCondition(
          reloaded.onboarding.nickname === onboarding.nickname &&
            reloaded.onboarding.experience === onboarding.experience &&
            reloaded.onboarding.audioReady === false,
          'onboarding did not persist',
        );

        const malformed = await parentA.request(
          childPath(account('childA').id, '/onboarding'),
          {
            method: 'PUT',
            body: { ...onboarding, school: 'must-not-persist' },
          },
        );
        await requireError(
          malformed,
          400,
          'INVALID_REQUEST',
          'malformed onboarding save',
        );
        const afterMalformed = await readOnboarding(
          parentA,
          account('childA').id,
          'onboarding after malformed save',
        );
        requireCondition(
          afterMalformed.onboarding.nickname === onboarding.nickname &&
            afterMalformed.onboarding.audioReady === false,
          'malformed onboarding save changed prior data',
        );

        const childWrite = await childA.request(
          childPath(account('childA').id, '/onboarding'),
          { method: 'PUT', body: onboarding },
        );
        await requireError(
          childWrite,
          403,
          'FORBIDDEN',
          'child onboarding write',
        );
        const teacherWrite = await teacher.request(
          childPath(account('childA').id, '/onboarding'),
          { method: 'PUT', body: onboarding },
        );
        await requireError(
          teacherWrite,
          403,
          'FORBIDDEN',
          'teacher onboarding write',
        );
        await readOnboarding(
          childA,
          account('childA').id,
          'child onboarding read',
          403,
          'FORBIDDEN',
        );
        await readOnboarding(
          teacher,
          account('childA').id,
          'teacher onboarding read',
          403,
          'FORBIDDEN',
        );
        await readOnboarding(
          parentB,
          account('childA').id,
          'family B onboarding read',
          404,
        );
        const familyBWrite = await parentB.request(
          childPath(account('childA').id, '/onboarding'),
          { method: 'PUT', body: onboarding },
        );
        await requireError(
          familyBWrite,
          404,
          'NOT_FOUND',
          'family B onboarding write',
        );
        state.onboardingReady = true;
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'L-02-release-and-assignment-gates',
      async () => {
        requireDependency(
          state.linksReady,
          'family links were not established',
        );
        requireDependency(
          typeof testRunId === 'string' && testRunId.length > 0,
          'test installation run ID was not provided',
        );
        const parentA = clientFor('parentA');
        const childA = clientFor('childA');
        await dependencyCall(
          setTestContentAllowed,
          'test-content guard disable',
          false,
        );
        await dependencyCall(setRelease, 'release reset', { kind: 'none' });

        const pending = await readAssignments(
          parentA,
          account('childA').id,
          'pending lesson',
        );
        requireCondition(
          pending.lesson.releaseState === 'pending' &&
            pending.lesson.canAssign === false,
          'unreleased forest lesson was assignable',
        );
        const malformed = await parentA.request(
          childPath(account('childA').id, '/assignments'),
          {
            method: 'POST',
            body: { lessonVersion: LESSON_VERSION, candidateId: testRunId },
          },
        );
        await requireError(
          malformed,
          400,
          'INVALID_REQUEST',
          'forged assignment approval fields',
        );
        const unassignedStart = await childA.request(
          childPath(account('childA').id, '/runs'),
          { method: 'POST', body: { lessonVersion: LESSON_VERSION } },
        );
        await requireError(
          unassignedStart,
          409,
          'ASSIGNMENT_REQUIRED',
          'child start before assignment',
        );
        const noRelease = await parentA.request(
          childPath(account('childA').id, '/assignments'),
          { method: 'POST', body: { lessonVersion: LESSON_VERSION } },
        );
        await requireError(
          noRelease,
          409,
          'LESSON_NOT_RELEASED',
          'assignment before release',
        );

        await dependencyCall(setRelease, 'synthetic release', {
          kind: 'test-fixture',
          testRunId,
        });
        const guarded = await readAssignments(
          parentA,
          account('childA').id,
          'guarded synthetic lesson',
        );
        requireCondition(
          guarded.lesson.releaseState === 'test-fixture' &&
            guarded.lesson.canAssign === false,
          'synthetic release bypassed the content guard',
        );
        const guardDenied = await parentA.request(
          childPath(account('childA').id, '/assignments'),
          { method: 'POST', body: { lessonVersion: LESSON_VERSION } },
        );
        await requireError(
          guardDenied,
          409,
          'LESSON_NOT_RELEASED',
          'assignment with disabled content guard',
        );

        await dependencyCall(
          setTestContentAllowed,
          'test-content guard enable',
          true,
        );
        const usable = await readAssignments(
          parentA,
          account('childA').id,
          'usable synthetic lesson',
        );
        requireCondition(
          usable.lesson.releaseState === 'test-fixture' &&
            usable.lesson.canAssign === true,
          'guarded synthetic release was not usable in the test installation',
        );
        const assignedResponse = await parentA.request(
          childPath(account('childA').id, '/assignments'),
          { method: 'POST', body: { lessonVersion: LESSON_VERSION } },
        );
        requireStatus(assignedResponse, 201, 'forest assignment creation');
        requireNoStore(assignedResponse, 'forest assignment creation');
        const assignedBody = await jsonBody(assignedResponse);
        requireSafeJSON(assignedBody, 'forest assignment creation');
        requireCondition(
          object(assignedBody.assignment) &&
            assignedBody.assignment.lessonId === LESSON_ID &&
            assignedBody.assignment.lessonVersion === LESSON_VERSION &&
            assignedBody.assignment.status === 'assigned' &&
            assignedBody.assignment.runId === null,
          'assignment creation returned the wrong projection',
        );
        const replayResponse = await parentA.request(
          childPath(account('childA').id, '/assignments'),
          { method: 'POST', body: { lessonVersion: LESSON_VERSION } },
        );
        requireStatus(replayResponse, 200, 'forest assignment replay');
        requireNoStore(replayResponse, 'forest assignment replay');
        const replayBody = await jsonBody(replayResponse);
        requireSafeJSON(replayBody, 'forest assignment replay');
        requireCondition(
          JSON.stringify(replayBody.assignment) ===
            JSON.stringify(assignedBody.assignment),
          'assignment replay returned a different assignment',
        );
        state.releaseReady = true;
        state.assignmentReady = true;
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'L-03-owned-run-and-write-boundary',
      async () => {
        requireDependency(
          state.assignmentReady,
          'forest assignment was not created',
        );
        requireDependency(
          state.teacherGrantReady,
          'teacher grant was not created',
        );
        const childA1 = new PilotClient(baseURL);
        const childA2 = new PilotClient(baseURL);
        await login(
          childA1,
          account('childA'),
          'child A concurrent sign-in one',
        );
        await login(
          childA2,
          account('childA'),
          'child A concurrent sign-in two',
        );
        const startBody = { lessonVersion: LESSON_VERSION };
        const starts = await Promise.all([
          childA1.request(childPath(account('childA').id, '/runs'), {
            method: 'POST',
            body: startBody,
          }),
          childA2.request(childPath(account('childA').id, '/runs'), {
            method: 'POST',
            body: startBody,
          }),
        ]);
        requireCondition(
          starts
            .map((response) => response.status)
            .sort((a, b) => a - b)
            .join(',') === '200,201',
          'concurrent starts did not produce one create and one replay',
        );
        starts.forEach((response) =>
          requireNoStore(response, 'owned run creation'),
        );
        const startBodies = await Promise.all(
          starts.map((response) => jsonBody(response)),
        );
        for (const body of startBodies)
          requireSafeJSON(body, 'owned run creation');
        requireCondition(
          startBodies.every(
            (body) =>
              body.runId &&
              body.childId === account('childA').id &&
              body.lessonId === LESSON_ID &&
              body.lessonVersion === LESSON_VERSION &&
              Number.isInteger(body.revision) &&
              object(body.state),
          ) && startBodies[0].runId === startBodies[1].runId,
          'concurrent starts created different or incomplete runs',
        );
        state.runID = startBodies[0].runId;
        const childA = clientFor('childA');
        const parentA = clientFor('parentA');
        const teacher = clientFor('teacher');
        const childB = new PilotClient(baseURL);
        await login(childB, account('childB'), 'child B sign-in');
        await readRun(
          parentA,
          account('childA').id,
          state.runID,
          'parent run read',
        );
        await readRun(
          teacher,
          account('childA').id,
          state.runID,
          'teacher run read',
        );
        const parentAction = await parentA.request(
          childPath(account('childA').id, `/runs/${state.runID}/actions`),
          {
            method: 'POST',
            body: {
              eventId: 'l03-parent-write',
              expectedRevision: 0,
              stepId: 'welcome',
              type: 'continue',
              payload: {},
            },
          },
        );
        await requireError(parentAction, 403, 'FORBIDDEN', 'parent run write');
        const teacherAction = await teacher.request(
          childPath(account('childA').id, `/runs/${state.runID}/actions`),
          {
            method: 'POST',
            body: {
              eventId: 'l03-teacher-write',
              expectedRevision: 0,
              stepId: 'welcome',
              type: 'continue',
              payload: {},
            },
          },
        );
        await requireError(
          teacherAction,
          403,
          'FORBIDDEN',
          'teacher run write',
        );
        const childBStart = await childB.request(
          childPath(account('childB').id, '/runs'),
          { method: 'POST', body: startBody },
        );
        await requireError(
          childBStart,
          409,
          'ASSIGNMENT_REQUIRED',
          'child B run claim',
        );
        await readRun(
          childB,
          account('childB').id,
          state.runID,
          'child B foreign run read',
          404,
        );
        const childBAction = await childB.request(
          childPath(account('childB').id, `/runs/${state.runID}/actions`),
          {
            method: 'POST',
            body: {
              eventId: 'l03-child-b-write',
              expectedRevision: 0,
              stepId: 'welcome',
              type: 'continue',
              payload: {},
            },
          },
        );
        await requireError(
          childBAction,
          404,
          'NOT_FOUND',
          'child B foreign run write',
        );
        requireCondition(
          childA.cookies !== childB.cookies,
          'test used shared learner cookies',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'L-04-server-scoring-and-replay',
      async () => {
        requireDependency(state.runID, 'owned run was not created');
        const childA = clientFor('childA');
        let current = await readRun(
          childA,
          account('childA').id,
          state.runID,
          'child run before scoring',
        );
        if (current.state.stepId === 'welcome') {
          const continued = await runAction(
            childA,
            account('childA').id,
            state.runID,
            actionEnvelope('l04-welcome', current, 'continue', {}),
            'welcome continue',
          );
          current = { ...current, ...continued, state: continued.state };
        }
        requireCondition(
          current.state.questionId === 'fam-mu' &&
            current.state.questionStatus === 'open',
          'scoring scenario did not reach fam-mu',
        );
        const forged = await childA.request(
          childPath(account('childA').id, `/runs/${state.runID}/actions`),
          {
            method: 'POST',
            body: actionEnvelope(
              'l04-forged-score',
              current,
              'answer',
              { questionId: 'fam-mu', choiceId: 'lin' },
              { correct: true },
            ),
          },
        );
        await requireError(
          forged,
          400,
          'INVALID_REQUEST',
          'forged scoring field',
        );
        const wrongRequest = actionEnvelope(
          'l04-wrong-fam-mu',
          current,
          'answer',
          { questionId: 'fam-mu', choiceId: QUESTION_CHOICES['fam-mu'].wrong },
        );
        const wrong = await runAction(
          childA,
          account('childA').id,
          state.runID,
          wrongRequest,
          'wrong familiarity answer',
        );
        requireCondition(
          wrong.result.outcome === 'incorrect' &&
            wrong.result.firstResponse === true &&
            wrong.result.assisted === false,
          'wrong answer was not server-scored as the first independent response',
        );
        current = { ...current, ...wrong, state: wrong.state };
        const hint = await runAction(
          childA,
          account('childA').id,
          state.runID,
          actionEnvelope('l04-hint-fam-mu', current, 'hint', {
            questionId: 'fam-mu',
          }),
          'familiarity hint',
        );
        requireCondition(
          hint.result.outcome === 'recorded' && hint.result.assisted === true,
          'hint was not recorded as assistance',
        );
        current = { ...current, ...hint, state: hint.state };
        const correct = await runAction(
          childA,
          account('childA').id,
          state.runID,
          actionEnvelope('l04-correct-fam-mu', current, 'answer', {
            questionId: 'fam-mu',
            choiceId: QUESTION_CHOICES['fam-mu'].correct,
          }),
          'assisted familiarity retry',
        );
        requireCondition(
          correct.result.outcome === 'correct' &&
            correct.result.firstResponse === false &&
            correct.result.assisted === true,
          'assisted retry was not server-scored correctly',
        );
        current = { ...current, ...correct, state: correct.state };
        const moved = await runAction(
          childA,
          account('childA').id,
          state.runID,
          actionEnvelope('l04-to-fam-lin', current, 'continue', {}),
          'continue to fam-lin',
        );
        current = { ...current, ...moved, state: moved.state };
        requireCondition(
          current.state.questionId === 'fam-lin' &&
            current.state.questionStatus === 'open',
          'scoring scenario did not reach fam-lin',
        );

        const hintRequest = actionEnvelope(
          'l04-concurrent-hint',
          current,
          'hint',
          { questionId: 'fam-lin' },
        );
        const answerRequest = actionEnvelope(
          'l04-concurrent-answer',
          current,
          'answer',
          {
            questionId: 'fam-lin',
            choiceId: QUESTION_CHOICES['fam-lin'].correct,
          },
        );
        const concurrent = await Promise.all([
          childA.request(
            childPath(account('childA').id, `/runs/${state.runID}/actions`),
            { method: 'POST', body: hintRequest },
          ),
          childA.request(
            childPath(account('childA').id, `/runs/${state.runID}/actions`),
            { method: 'POST', body: answerRequest },
          ),
        ]);
        requireCondition(
          concurrent
            .map((response) => response.status)
            .sort((a, b) => a - b)
            .join(',') === '200,409',
          'concurrent actions did not produce one acknowledgement and one conflict',
        );
        const winnerIndex = concurrent.findIndex(
          (response) => response.status === 200,
        );
        const loserIndex = 1 - winnerIndex;
        const winnerRequest = winnerIndex === 0 ? hintRequest : answerRequest;
        const winnerBody = await jsonBody(concurrent[winnerIndex]);
        requireSafeJSON(winnerBody, 'concurrent action acknowledgement');
        await requireError(
          concurrent[loserIndex],
          409,
          'STALE_REVISION',
          'concurrent action conflict',
        );
        const afterConcurrent = await readRun(
          childA,
          account('childA').id,
          state.runID,
          'run after concurrent actions',
        );
        requireCondition(
          afterConcurrent.revision === current.revision + 1 &&
            afterConcurrent.events.filter(
              (event) =>
                object(event) &&
                ['l04-concurrent-hint', 'l04-concurrent-answer'].includes(
                  event.eventId,
                ),
            ).length === 1,
          'concurrent actions changed more than one event',
        );
        const replay = await childA.request(
          childPath(account('childA').id, `/runs/${state.runID}/actions`),
          { method: 'POST', body: winnerRequest },
        );
        requireStatus(replay, 200, 'identical action replay');
        const replayBody = await jsonBody(replay);
        requireSafeJSON(replayBody, 'identical action replay');
        requireCondition(
          JSON.stringify(replayBody) === JSON.stringify(winnerBody),
          'identical action replay changed its acknowledgement',
        );
        const changedReplay = {
          ...winnerRequest,
          payload:
            winnerRequest.type === 'hint'
              ? {
                  questionId: 'fam-lin',
                  choiceId: QUESTION_CHOICES['fam-lin'].correct,
                }
              : { questionId: 'fam-lin' },
          type: winnerRequest.type === 'hint' ? 'answer' : 'hint',
        };
        const conflictingReplay = await childA.request(
          childPath(account('childA').id, `/runs/${state.runID}/actions`),
          { method: 'POST', body: changedReplay },
        );
        await requireError(
          conflictingReplay,
          409,
          'EVENT_CONFLICT',
          'changed event replay',
        );
        state.actionsReady = true;
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'L-05-evidence-revocation-and-export',
      async () => {
        requireDependency(
          state.actionsReady,
          'learning actions were not recorded',
        );
        requireDependency(state.runID, 'owned run was not created');
        const parentA = clientFor('parentA');
        const teacher = clientFor('teacher');
        const parentRun = await readRun(
          parentA,
          account('childA').id,
          state.runID,
          'parent evidence run',
        );
        const teacherRun = await readRun(
          teacher,
          account('childA').id,
          state.runID,
          'teacher evidence run',
        );
        requireCondition(
          JSON.stringify(parentRun.events) ===
            JSON.stringify(teacherRun.events) &&
            JSON.stringify(parentRun.recap) ===
              JSON.stringify(teacherRun.recap),
          'parent and teacher received different saved evidence',
        );
        const parentProgressResponse = await parentA.request(
          childPath(account('childA').id, '/progress'),
        );
        requireStatus(parentProgressResponse, 200, 'parent progress');
        requireNoStore(parentProgressResponse, 'parent progress');
        const parentProgress = await jsonBody(parentProgressResponse);
        requireSafeJSON(parentProgress, 'parent progress');
        requireNoMastery(parentProgress, 'parent progress');
        requireCondition(
          object(parentProgress.child) &&
            parentProgress.child.id === account('childA').id &&
            Array.isArray(parentProgress.assignments) &&
            Array.isArray(parentProgress.runs) &&
            object(parentProgress.evidenceLimits) &&
            runIDsFromProgress(parentProgress).includes(state.runID),
          'parent progress projection is incomplete',
        );
        const teacherProgressResponse = await teacher.request(
          childPath(account('childA').id, '/progress'),
        );
        requireStatus(teacherProgressResponse, 200, 'teacher progress');
        requireNoStore(teacherProgressResponse, 'teacher progress');
        const teacherProgress = await jsonBody(teacherProgressResponse);
        requireSafeJSON(teacherProgress, 'teacher progress');
        requireNoMastery(teacherProgress, 'teacher progress');
        requireCondition(
          runIDsFromProgress(teacherProgress).includes(state.runID),
          'teacher progress omitted the granted run',
        );
        const parentExportResponse = await parentA.request(
          childPath(account('childA').id, '/export'),
        );
        requireStatus(parentExportResponse, 200, 'parent learning export');
        requireNoStore(parentExportResponse, 'parent learning export');
        const parentExport = await jsonBody(parentExportResponse);
        requireSafeJSON(parentExport, 'parent learning export');
        requireNoMastery(parentExport, 'parent learning export');
        requireCondition(
          parentExport.schemaVersion === 'pilot-learning-export-1' &&
            typeof parentExport.exportedAt === 'string' &&
            parentExport.child?.id === account('childA').id &&
            Array.isArray(parentExport.assignments) &&
            Array.isArray(parentExport.runs),
          'parent export projection is incomplete',
        );
        const exportText = JSON.stringify(parentExport);
        requireCondition(
          !exportText.includes(account('childB').id) &&
            !collectKeys(parentExport).some((key) =>
              /session|audit/i.test(key),
            ),
          'parent export included another learner or restricted records',
        );
        const childExport = await clientFor('childA').request(
          childPath(account('childA').id, '/export'),
        );
        await requireError(
          childExport,
          403,
          'FORBIDDEN',
          'child export denial',
        );
        const teacherExport = await teacher.request(
          childPath(account('childA').id, '/export'),
        );
        await requireError(
          teacherExport,
          403,
          'FORBIDDEN',
          'teacher export denial',
        );
        const foreignExport = await clientFor('parentB').request(
          childPath(account('childA').id, '/export'),
        );
        const unknownExport = await clientFor('parentB').request(
          childPath('child-does-not-exist', '/export'),
        );
        requireStatus(foreignExport, 404, 'foreign parent export');
        requireStatus(unknownExport, 404, 'unknown child export');
        requireNoStore(foreignExport, 'foreign parent export');
        requireNoStore(unknownExport, 'unknown child export');
        const foreignError = await errorBody(foreignExport);
        const unknownError = await errorBody(unknownExport);
        requireCondition(
          object(foreignError) &&
            foreignError.code === 'NOT_FOUND' &&
            typeof foreignError.message === 'string' &&
            object(unknownError) &&
            unknownError.code === foreignError.code &&
            unknownError.message === foreignError.message,
          'foreign and unknown export errors were distinguishable',
        );

        const revoke = await parentA.request('/api/pilot/grants', {
          method: 'DELETE',
          body: {
            childId: account('childA').id,
            teacherId: account('teacher').id,
          },
        });
        requireSuccess(revoke, 'teacher grant revoke');
        await readRun(
          teacher,
          account('childA').id,
          state.runID,
          'revoked teacher evidence read',
          404,
        );
        const unlink = await clientFor('operator').request('/api/pilot/links', {
          method: 'DELETE',
          body: {
            parentId: account('parentA').id,
            childId: account('childA').id,
          },
        });
        requireSuccess(unlink, 'parent-child unlink after evidence read');
        await readRun(
          parentA,
          account('childA').id,
          state.runID,
          'unlinked parent evidence read',
          404,
        );
        const unlinkedExport = await parentA.request(
          childPath(account('childA').id, '/export'),
        );
        await requireError(
          unlinkedExport,
          404,
          'NOT_FOUND',
          'unlinked parent export',
        );
        state.teacherGrantReady = false;
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'L-06-restart-and-event-write-rollback',
      async () => {
        requireDependency(
          state.actionsReady,
          'learning actions were not recorded',
        );
        requireDependency(state.runID, 'owned run was not created');
        requireDependency(
          typeof inspectLearning === 'function',
          'learning inspection callback is required',
        );
        const childA = clientFor('childA');
        const beforeRestart = await readRun(
          childA,
          account('childA').id,
          state.runID,
          'child run before restart',
        );
        await dependencyCall(restart, 'learning Worker restart');
        const afterRestart = await readRun(
          childA,
          account('childA').id,
          state.runID,
          'child run after restart',
        );
        requireCondition(
          afterRestart.revision === beforeRestart.revision &&
            JSON.stringify(afterRestart.state) ===
              JSON.stringify(beforeRestart.state) &&
            JSON.stringify(afterRestart.events) ===
              JSON.stringify(beforeRestart.events),
          'restart changed acknowledged learning evidence',
        );
        const beforeFault = await dependencyCall(
          inspectLearning,
          'learning inspection before fault',
        );
        requireOwnedRun(beforeFault, state.runID, account('childA').id);
        const beforeEventCount = learningEventCount(beforeFault, state.runID);
        let request;
        if (
          afterRestart.state.questionStatus === 'open' &&
          typeof afterRestart.state.questionId === 'string'
        ) {
          const oracle = QUESTION_CHOICES[afterRestart.state.questionId];
          requireCondition(
            Boolean(oracle),
            'unknown question in owned run state',
          );
          request = actionEnvelope('l06-fault-answer', afterRestart, 'answer', {
            questionId: afterRestart.state.questionId,
            choiceId: oracle.correct,
          });
        } else {
          request = actionEnvelope(
            'l06-fault-continue',
            afterRestart,
            'continue',
            {},
          );
        }
        let faultEnabled = false;
        try {
          await dependencyCall(
            setLearningEventsAvailable,
            'learning event storage disable',
            false,
          );
          faultEnabled = true;
          const failed = await childA.request(
            childPath(account('childA').id, `/runs/${state.runID}/actions`),
            { method: 'POST', body: request },
          );
          await requireError(
            failed,
            503,
            'STORAGE_UNAVAILABLE',
            'event-write storage fault',
          );
          const duringFault = await readRun(
            childA,
            account('childA').id,
            state.runID,
            'run after failed event write',
          );
          requireCondition(
            duringFault.revision === afterRestart.revision &&
              JSON.stringify(duringFault.state) ===
                JSON.stringify(afterRestart.state) &&
              JSON.stringify(duringFault.events) ===
                JSON.stringify(afterRestart.events),
            'failed event write partially advanced the run',
          );
          const afterFailure = await dependencyCall(
            inspectLearning,
            'learning inspection after fault',
          );
          requireCondition(
            learningEventCount(afterFailure, state.runID) === beforeEventCount,
            'failed event write changed the event count',
          );
        } finally {
          if (faultEnabled) {
            await dependencyCall(
              setLearningEventsAvailable,
              'learning event storage restore',
              true,
            );
          }
        }
        const retried = await runAction(
          childA,
          account('childA').id,
          state.runID,
          request,
          'retried event after storage restore',
        );
        requireCondition(
          retried.eventId === request.eventId,
          'retried event acknowledgement used a different event ID',
        );
        const afterRetry = await dependencyCall(
          inspectLearning,
          'learning inspection after retry',
        );
        requireOwnedRun(afterRetry, state.runID, account('childA').id);
        requireCondition(
          learningEventCount(afterRetry, state.runID) ===
            beforeEventCount + 1 &&
            learningRows(afterRetry, 'events').some(
              (row) =>
                runIDFromRow(row) === state.runID &&
                eventIDFromRow(row) === request.eventId,
            ),
          'retried event did not create exactly one durable event',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  return results;
}
