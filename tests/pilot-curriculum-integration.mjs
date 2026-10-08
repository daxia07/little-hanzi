/*
 * Sprint 3 registry foundation HTTP probe.
 *
 * The runner supplies a fresh Worker/D1 installation and ordinary seeded
 * accounts. Registry fixture controls are callbacks owned by the runner; the
 * probe never talks to D1 or uses a test token as an authentication bypass.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);
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

function requireObject(body, label) {
  requireCondition(object(body), `${label} did not return a JSON object`);
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function dataBody(body) {
  if (!object(body)) return {};
  return object(body.data) ? body.data : body;
}

async function errorBody(response) {
  const body = dataBody(await jsonBody(response));
  return object(body.error) ? body.error : body;
}

async function requireError(response, status, code, label) {
  requireStatus(response, status, label);
  requireNoStore(response, label);
  const error = await errorBody(response);
  requireCondition(
    object(error) && error.code === code && typeof error.message === 'string',
    `${label} did not return ${code}`,
  );
  return error;
}

function requireKeys(value, expected, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const wanted = [...expected].sort((a, b) => a.localeCompare(b));
  requireCondition(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} returned an unexpected response shape`,
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
      : 'pilot curriculum integration assertion failed';
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

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]*)/g);
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

class PilotClient {
  constructor(baseURL, ipAddress = syntheticIP()) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.ipAddress = ipAddress;
    this.cookies = new CookieJar();
  }

  async request(
    path,
    { method = 'GET', body, rawBody, origin = this.origin, headers = {} } = {},
  ) {
    const requestHeaders = new Headers({ ...JSON_HEADERS, ...headers });
    if (!requestHeaders.has('X-Forwarded-For'))
      requestHeaders.set('X-Forwarded-For', this.ipAddress);
    if (!requestHeaders.has('CF-Connecting-IP'))
      requestHeaders.set('CF-Connecting-IP', this.ipAddress);
    if (body !== undefined || rawBody !== undefined)
      requestHeaders.set('Content-Type', 'application/json');
    if (origin !== null) requestHeaders.set('Origin', origin);
    this.cookies.attach(requestHeaders);
    const request = { method, headers: requestHeaders, redirect: 'manual' };
    if (rawBody !== undefined) request.body = rawBody;
    else if (body !== undefined) request.body = JSON.stringify(body);
    const response = await fetch(`${this.baseURL}${path}`, request);
    this.cookies.store(response);
    return response;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function curriculumDigest(value) {
  return `sha256:${createHash('sha256')
    .update(Buffer.from(canonical(value), 'utf8'))
    .digest('hex')}`;
}

function clone(value) {
  return structuredClone(value);
}

function packageWithVersion(version, title = null) {
  const value = clone(FIXTURE);
  value.lessonVersion = version;
  if (title !== null) value.title = title;
  return value;
}

function packageWithChangedCharacter(version) {
  const value = packageWithVersion(version);
  const character = value.characters[0];
  character.hanzi = '本';
  character.readings[0].audioText = '本';
  for (const association of character.wordAssociations) {
    association.text = association.text.replaceAll('木', '本');
    association.context.hanzi = association.context.hanzi.replaceAll(
      '木',
      '本',
    );
    association.context.targetCharacter = '本';
  }
  character.teaching.instructionEnglish = 'Listen for 本 in a familiar word.';
  character.teaching.delayedReview.instructionEnglish =
    'Later, listen once more and choose 本.';
  for (const check of value.recognitionChecks) {
    if (check.characterId !== character.characterId) continue;
    check.instructionEnglish = check.instructionEnglish.replaceAll('木', '本');
    check.prompt.hanzi = check.prompt.hanzi.replaceAll('木', '本');
    for (const choice of check.choices) {
      if (choice.hanzi === '木') choice.hanzi = '本';
    }
  }
  return value;
}

function packageWithCheckedProvenance(version) {
  const value = packageWithVersion(version);
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!object(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'sourceChecked') node[key] = true;
      else if (key === 'sourceCheckStatus') node[key] = 'mechanically-checked';
      else visit(child);
    }
  };
  visit(value);
  return value;
}

function reviewInput({
  requestId,
  contentDigest,
  previousReviewId = null,
  decision = 'rejected',
  allChecklist = false,
  reason = 'Synthetic registry probe decision',
}) {
  return {
    requestId,
    contentDigest,
    previousReviewId,
    decision,
    reviewerRef: 'synthetic-test-reviewer',
    reviewedAt: Date.now(),
    checklistVersion: 'hanzi-review-1',
    checklist: {
      scriptAndGlyphs: allChecklist,
      mandarinAndReadings: allChecklist,
      wordContexts: allChecklist,
      teachingAndChecks: allChecklist,
      ageSuitability: allChecklist,
      sourcesAndLicenses: allChecklist,
      deviceAudio: allChecklist,
    },
    evidenceRef: 'synthetic-fixture-only/registry-probe',
    reason,
  };
}

function rowValue(row, ...names) {
  if (!object(row)) return undefined;
  for (const name of names) if (Object.hasOwn(row, name)) return row[name];
  return undefined;
}

function rowID(row) {
  return rowValue(row, 'lesson_version', 'lessonVersion');
}

function registrySummary(snapshot) {
  requireObject(snapshot, 'registry inspection');
  for (const key of ['state', 'packages', 'characters', 'reviews', 'audit']) {
    requireCondition(
      Array.isArray(snapshot[key]),
      `registry inspection omitted ${key}`,
    );
  }
  const state = snapshot.state[0];
  const revision = state ? rowValue(state, 'revision') : 0;
  requireCondition(
    Number.isInteger(Number(revision)) && Number(revision) >= 0,
    'registry inspection returned an invalid revision',
  );
  return {
    revision: Number(revision),
    packages: snapshot.packages.length,
    characters: snapshot.characters.length,
    reviews: snapshot.reviews.length,
    audit: snapshot.audit.length,
  };
}

function requireSummaryEqual(before, after, label) {
  requireCondition(
    JSON.stringify(before) === JSON.stringify(after),
    `${label} changed registry state`,
  );
}

function requireSafeErrorText(error, forbidden, label) {
  requireCondition(
    !forbidden.some(
      (value) =>
        typeof value === 'string' && value && error.message.includes(value),
    ),
    `${label} exposed submitted private text`,
  );
}

function requireCoverageShape(body, label) {
  requireObject(body, label);
  requireCondition(
    body.schemaVersion === 's3-registry-foundation-1' &&
      Number.isInteger(body.revision) &&
      object(body.counts) &&
      object(body.releaseProof) &&
      Array.isArray(body.packages),
    `${label} omitted coverage fields`,
  );
  requireCondition(
    body.releaseProof.available === false &&
      body.releaseProof.code === 'STARTER_RELEASE_PROOF_UNAVAILABLE' &&
      body.counts.reviewedReadyDistinct === 0 &&
      body.counts.supervisedTrialDistinct === 0 &&
      body.counts.prospectiveStarterDistinct === 0 &&
      body.counts.starterReleasedDistinct === 0 &&
      body.counts.starterRequiredDistinct === 1600,
    `${label} reported release proof or usable coverage`,
  );
}

function requireNoRegistryLeak(body, label) {
  const forbiddenKeys =
    /^(package|manifest|reviews|reviewerRef|evidenceRef|requestDigest|writeId|answerKey)$/i;
  const forbiddenValues = ['forest-01-v2', 'synthetic-test-reviewer'];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        requireCondition(!forbiddenKeys.test(key), `${label} exposed ${key}`);
        visit(child);
      }
    } else if (typeof value === 'string') {
      requireCondition(
        !forbiddenValues.includes(value),
        `${label} exposed registry content`,
      );
    }
  };
  visit(body);
}

async function login(client, account, label) {
  const response = await client.request('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username: account.username, password: account.password },
  });
  requireStatus(response, 200, label);
  requireNoStore(response, label);
  const body = await jsonBody(response);
  requireObject(body, `${label} response`);
  requireCondition(
    !Object.keys(body).some((key) =>
      /password|hash|token|secret|email/i.test(key),
    ),
    `${label} returned a credential field`,
  );
}

function versionPath(version, suffix = '') {
  return `/api/pilot/curriculum/${encodeURIComponent(version)}${suffix}`;
}

async function importPackage(client, value, label, expectedStatus = 201) {
  const response = await client.request('/api/pilot/curriculum', {
    method: 'POST',
    body: { package: value },
  });
  requireStatus(response, expectedStatus, label);
  requireNoStore(response, label);
  const statuses = Array.isArray(expectedStatus)
    ? expectedStatus
    : [expectedStatus];
  return {
    response,
    body: statuses.every((status) => status >= 200 && status < 300)
      ? await jsonBody(response)
      : null,
  };
}

async function reviewPackage(
  client,
  version,
  value,
  label,
  expectedStatus = 201,
) {
  const response = await client.request(versionPath(version, '/reviews'), {
    method: 'POST',
    body: value,
  });
  requireStatus(response, expectedStatus, label);
  requireNoStore(response, label);
  const body =
    expectedStatus >= 200 && expectedStatus < 300
      ? await jsonBody(response)
      : null;
  return { response, body };
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

export async function runPilotCurriculumIntegration({
  baseURL,
  accounts,
  restart,
  testToken,
  testRunId,
  curriculumFixtures,
}) {
  const clients = new Map();
  const state = {
    operatorReady: false,
    imported: false,
    draftDigest: curriculumDigest(FIXTURE),
    reviewHead: null,
    fixtureVersion: null,
  };
  const secrets = [testToken, testRunId].filter(
    (value) => typeof value === 'string',
  );
  const account = (key) => accountFor(accounts, key);
  const clientFor = (key) => {
    if (!clients.has(key)) clients.set(key, new PilotClient(baseURL));
    return clients.get(key);
  };
  const ensureLogin = async (key) => {
    const client = clientFor(key);
    await login(client, account(key), `${key} sign-in`);
    return client;
  };
  const inspect = () =>
    dependencyCall(curriculumFixtures?.inspect, 'registry inspection');
  const results = [];

  results.push(
    await runCase(
      'C-R01-registry-role-origin-and-route-boundaries',
      async () => {
        requireDependency(
          typeof baseURL === 'string' && baseURL.length > 0,
          'base URL',
        );
        const anonymous = new PilotClient(baseURL);
        const anonymousResponse = await anonymous.request(
          '/api/pilot/curriculum',
        );
        await requireError(
          anonymousResponse,
          401,
          'UNAUTHORIZED',
          'anonymous registry list',
        );

        const operator = await ensureLogin('operator');
        const parent = await ensureLogin('parentA');
        const child = await ensureLogin('childA');
        const teacher = await ensureLogin('teacher');
        state.operatorReady = true;

        const sameOriginGet = await operator.request('/api/pilot/curriculum', {
          origin: null,
        });
        requireStatus(
          sameOriginGet,
          200,
          'operator registry GET without Origin',
        );
        requireNoStore(sameOriginGet, 'operator registry GET without Origin');
        requireCoverageShape(
          await jsonBody(sameOriginGet),
          'operator registry GET without Origin',
        );

        for (const [label, client] of [
          ['parent registry list', parent],
          ['child registry list', child],
          ['teacher registry list', teacher],
        ]) {
          const response = await client.request('/api/pilot/curriculum');
          await requireError(response, 403, 'FORBIDDEN', label);
        }

        const wrongOrigin = await operator.request('/api/pilot/curriculum', {
          origin: 'https://origin-not-configured.invalid',
        });
        await requireError(
          wrongOrigin,
          403,
          'FORBIDDEN',
          'wrong-origin registry list',
        );

        const wrongPasswordClient = new PilotClient(baseURL);
        const wrong = await wrongPasswordClient.request(
          '/api/auth/sign-in/username',
          {
            method: 'POST',
            body: {
              username: account('operator').username,
              password: 'wrong-password-for-registry-probe',
            },
          },
        );
        const unknown = await new PilotClient(baseURL).request(
          '/api/auth/sign-in/username',
          {
            method: 'POST',
            body: {
              username: 'qa.unknown.registry',
              password: 'wrong-password-for-registry-probe',
            },
          },
        );
        requireStatus(wrong, 401, 'known username wrong password');
        requireStatus(unknown, 401, 'unknown username');
        requireNoStore(wrong, 'known username wrong password');
        requireNoStore(unknown, 'unknown username');
        const wrongError = await errorBody(wrong);
        const unknownError = await errorBody(unknown);
        requireCondition(
          object(wrongError) &&
            object(unknownError) &&
            wrongError.code === unknownError.code &&
            wrongError.message === unknownError.message,
          'invalid username and password errors were not uniform',
        );

        for (const path of ['/api/curriculum', '/api/admin/curriculum']) {
          const outside = await operator.request(path);
          requireStatus(outside, 404, `outside-pilot route ${path}`);
          requireNoStore(outside, `outside-pilot route ${path}`);
        }
        const missing = await operator.request(
          versionPath('missing-curriculum-version'),
        );
        await requireError(
          missing,
          404,
          'NOT_FOUND',
          'missing operator curriculum resource',
        );
      },
      accounts,
      secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R02-import-replay-index-and-persistence',
      async () => {
        requireDependency(state.operatorReady, 'operator registry session');
        requireDependency(
          typeof testRunId === 'string' && testRunId.length > 0,
          'test run ID',
        );
        requireDependency(
          typeof testToken === 'string' && testToken.length > 0,
          'test token',
        );
        const operator = clientFor('operator');
        const before = registrySummary(await inspect());
        const expectedDigest = curriculumDigest(FIXTURE);
        requireCondition(
          expectedDigest === state.draftDigest,
          'independent digest changed between checks',
        );
        const imported = await importPackage(operator, FIXTURE, 'draft import');
        requireKeys(
          imported.body,
          ['contentDigest', 'created', 'lessonId', 'lessonVersion'],
          'draft import',
        );
        requireCondition(
          imported.body.lessonId === FIXTURE.lessonId &&
            imported.body.lessonVersion === FIXTURE.lessonVersion &&
            imported.body.contentDigest === expectedDigest &&
            imported.body.created === true,
          'draft import response did not match the independent digest',
        );
        const afterImport = registrySummary(await inspect());
        requireCondition(
          afterImport.revision === before.revision + 1 &&
            afterImport.packages === before.packages + 1 &&
            afterImport.characters ===
              before.characters + FIXTURE.characters.length &&
            afterImport.audit === before.audit + 1,
          'draft import did not create its package/index/audit atomically',
        );

        const coverageResponse = await operator.request(
          '/api/pilot/curriculum',
        );
        requireStatus(coverageResponse, 200, 'registry coverage');
        requireNoStore(coverageResponse, 'registry coverage');
        const coverage = await jsonBody(coverageResponse);
        requireCoverageShape(coverage, 'registry coverage');
        const packageRow = coverage.packages.find(
          (item) =>
            object(item) && item.lessonVersion === FIXTURE.lessonVersion,
        );
        requireCondition(
          object(packageRow) &&
            packageRow.lessonId === FIXTURE.lessonId &&
            packageRow.contentDigest === expectedDigest &&
            packageRow.characterCount === FIXTURE.characters.length &&
            packageRow.testFixture === true &&
            packageRow.reviewState === 'test-fixture',
          'coverage omitted the imported fixture package',
        );
        requireCondition(
          coverage.counts.humanReviewedDistinct === 0,
          'fixture import contributed to human-reviewed coverage',
        );

        const detailResponse = await operator.request(
          versionPath(FIXTURE.lessonVersion),
        );
        requireStatus(detailResponse, 200, 'registry package detail');
        requireNoStore(detailResponse, 'registry package detail');
        const detail = await jsonBody(detailResponse);
        requireKeys(
          detail,
          ['contentDigest', 'importedAt', 'package', 'reviews', 'testFixture'],
          'registry package detail',
        );
        requireCondition(
          detail.contentDigest === expectedDigest &&
            detail.testFixture === true &&
            Array.isArray(detail.reviews) &&
            canonical(detail.package) === canonical(FIXTURE),
          'registry detail did not preserve the canonical package',
        );

        const replay = await importPackage(
          operator,
          FIXTURE,
          'exact import replay',
          200,
        );
        requireKeys(
          replay.body,
          ['contentDigest', 'created', 'lessonId', 'lessonVersion'],
          'exact import replay',
        );
        requireCondition(
          replay.body.created === false,
          'exact import replay created another package',
        );
        requireSummaryEqual(
          afterImport,
          registrySummary(await inspect()),
          'exact import replay',
        );

        const concurrentPackage = packageWithVersion(
          'forest-01-v2-concurrent',
          'Build a Little Forest concurrently',
        );
        const concurrentDigest = curriculumDigest(concurrentPackage);
        const first = await ensureLogin('operator');
        const second = new PilotClient(baseURL);
        await login(second, account('operator'), 'concurrent operator sign-in');
        const concurrentResponses = await Promise.all([
          importPackage(
            first,
            concurrentPackage,
            'concurrent import A',
            [200, 201],
          ),
          importPackage(
            second,
            concurrentPackage,
            'concurrent import B',
            [200, 201],
          ),
        ]);
        const createdFlags = concurrentResponses.map(
          (item) => item.body?.created,
        );
        requireCondition(
          createdFlags.filter((value) => value === true).length === 1 &&
            createdFlags.filter((value) => value === false).length === 1 &&
            concurrentResponses.every(
              (item) => item.body?.contentDigest === concurrentDigest,
            ),
          'concurrent exact imports did not produce one create and one replay',
        );
        const concurrentRows = (await inspect()).packages.filter(
          (row) => rowID(row) === concurrentPackage.lessonVersion,
        );
        requireCondition(
          concurrentRows.length === 1,
          'concurrent import duplicated its package row',
        );

        requireDependency(
          typeof restart === 'function',
          'Worker restart callback',
        );
        await restart();
        const persisted = await operator.request(
          versionPath(FIXTURE.lessonVersion),
        );
        requireStatus(persisted, 200, 'persisted registry detail');
        requireNoStore(persisted, 'persisted registry detail');
        const persistedBody = await jsonBody(persisted);
        requireCondition(
          persistedBody.contentDigest === expectedDigest &&
            canonical(persistedBody.package) === canonical(FIXTURE),
          'registry package/index did not persist across restart',
        );
        const persistedCoverage = await operator.request(
          '/api/pilot/curriculum',
        );
        requireStatus(persistedCoverage, 200, 'persisted registry coverage');
        requireNoStore(persistedCoverage, 'persisted registry coverage');
        requireCoverageShape(
          await jsonBody(persistedCoverage),
          'persisted registry coverage',
        );
        state.imported = true;
      },
      accounts,
      secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R03-validation-and-identity-conflicts',
      async () => {
        requireDependency(state.imported, 'draft package import');
        const operator = clientFor('operator');
        const before = registrySummary(await inspect());
        const invalidUtf8 = Buffer.concat([
          Buffer.from('{"package":{"lessonId":"forest-01","title":"'),
          Buffer.from([0xc3, 0x28]),
          Buffer.from('"}}'),
        ]);
        const invalidUtf8Response = await operator.request(
          '/api/pilot/curriculum',
          { method: 'POST', rawBody: invalidUtf8 },
        );
        await requireError(
          invalidUtf8Response,
          400,
          'INVALID_REQUEST',
          'malformed UTF-8 registry request',
        );
        requireSummaryEqual(
          before,
          registrySummary(await inspect()),
          'malformed UTF-8 registry request',
        );
        const malformed = clone(FIXTURE);
        delete malformed.characters[0].teaching.delayedReview;
        const malformedResponse = await operator.request(
          '/api/pilot/curriculum',
          {
            method: 'POST',
            body: { package: malformed },
          },
        );
        const malformedError = await requireError(
          malformedResponse,
          400,
          'INVALID_PACKAGE',
          'malformed registry package',
        );
        requireSafeErrorText(
          malformedError,
          ['Synthetic test-only', 'Build a Little Forest'],
          'malformed package error',
        );
        requireSummaryEqual(
          before,
          registrySummary(await inspect()),
          'malformed package',
        );

        const unknownReview = reviewInput({
          requestId: 'cr03-unknown-review-field',
          contentDigest: state.draftDigest,
        });
        unknownReview.unexpectedApprovalField = true;
        const unknownResponse = await operator.request(
          versionPath(FIXTURE.lessonVersion, '/reviews'),
          {
            method: 'POST',
            body: unknownReview,
          },
        );
        await requireError(
          unknownResponse,
          400,
          'INVALID_REQUEST',
          'unknown approval field',
        );
        requireSummaryEqual(
          before,
          registrySummary(await inspect()),
          'unknown approval field',
        );

        const reservedLegacy = packageWithVersion(
          'forest-01-v1',
          'Reserved legacy version must remain outside S3 registry',
        );
        const reservedResponse = await operator.request(
          '/api/pilot/curriculum',
          {
            method: 'POST',
            body: { package: reservedLegacy },
          },
        );
        await requireError(
          reservedResponse,
          409,
          'CURRICULUM_VERSION_CONFLICT',
          'reserved legacy version conflict',
        );
        requireSummaryEqual(
          before,
          registrySummary(await inspect()),
          'reserved legacy version conflict',
        );

        const changedVersion = packageWithVersion(
          FIXTURE.lessonVersion,
          'Changed title must conflict',
        );
        const changedResponse = await operator.request(
          '/api/pilot/curriculum',
          {
            method: 'POST',
            body: { package: changedVersion },
          },
        );
        await requireError(
          changedResponse,
          409,
          'CURRICULUM_VERSION_CONFLICT',
          'changed content version conflict',
        );
        requireSummaryEqual(
          before,
          registrySummary(await inspect()),
          'changed content version conflict',
        );

        const identityConflict = packageWithChangedCharacter(
          'forest-01-v2-identity-conflict',
        );
        const identityResponse = await operator.request(
          '/api/pilot/curriculum',
          {
            method: 'POST',
            body: { package: identityConflict },
          },
        );
        await requireError(
          identityResponse,
          409,
          'CHARACTER_IDENTITY_CONFLICT',
          'stable character identity conflict',
        );
        requireSummaryEqual(
          before,
          registrySummary(await inspect()),
          'stable character identity conflict',
        );
      },
      accounts,
      secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R04-review-history-replay-and-stale-head',
      async () => {
        requireDependency(state.imported, 'draft package import');
        const operator = clientFor('operator');
        const digest = state.draftDigest;
        const firstInput = reviewInput({
          requestId: 'cr04-reject-first',
          contentDigest: digest,
          reason: 'Synthetic incomplete draft rejection',
        });
        const first = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          firstInput,
          'first incomplete review',
        );
        requireKeys(
          first.body,
          ['created', 'reviewId'],
          'first incomplete review',
        );
        requireCondition(
          first.body.created === true,
          'first review was not created',
        );
        state.reviewHead = first.body.reviewId;

        const correctionInput = reviewInput({
          requestId: 'cr04-reject-correction',
          contentDigest: digest,
          previousReviewId: state.reviewHead,
          reason: 'Synthetic correction preserves the rejection history',
        });
        const correction = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          correctionInput,
          'review correction',
        );
        requireKeys(
          correction.body,
          ['created', 'reviewId'],
          'review correction',
        );
        requireCondition(
          correction.body.created === true,
          'review correction was not created',
        );
        state.reviewHead = correction.body.reviewId;

        const detailResponse = await operator.request(
          versionPath(FIXTURE.lessonVersion),
        );
        requireStatus(detailResponse, 200, 'review history detail');
        requireNoStore(detailResponse, 'review history detail');
        const detail = await jsonBody(detailResponse);
        requireCondition(
          detail.reviews.length === 2,
          'review correction overwrote history',
        );
        requireCondition(
          detail.reviews[0].sequence === 1 &&
            detail.reviews[0].previousReviewId === null &&
            detail.reviews[1].sequence === 2 &&
            detail.reviews[1].previousReviewId === detail.reviews[0].reviewId,
          'review history sequence/head linkage is wrong',
        );
        for (const review of detail.reviews) {
          requireCondition(
            !Object.hasOwn(review, 'requestDigest') &&
              !Object.hasOwn(review, 'writeId'),
            'review detail exposed internal idempotency fields',
          );
        }

        const wrongDigest = reviewInput({
          requestId: 'cr04-wrong-digest',
          contentDigest: 'sha256:' + '0'.repeat(64),
          previousReviewId: state.reviewHead,
        });
        const wrongDigestResponse = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          wrongDigest,
          'wrong review digest',
          409,
        );
        await requireError(
          wrongDigestResponse.response,
          409,
          'CURRICULUM_VERSION_CONFLICT',
          'wrong review digest',
        );

        const stale = reviewInput({
          requestId: 'cr04-stale-head',
          contentDigest: digest,
          previousReviewId: null,
        });
        const staleResponse = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          stale,
          'stale review head',
          409,
        );
        await requireError(
          staleResponse.response,
          409,
          'STALE_REVIEW',
          'stale review head',
        );

        const replay = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          correctionInput,
          'exact review replay',
          200,
        );
        requireKeys(
          replay.body,
          ['created', 'reviewId'],
          'exact review replay',
        );
        requireCondition(
          replay.body.created === false &&
            replay.body.reviewId === state.reviewHead,
          'exact review replay was not idempotent',
        );

        const conflictInput = {
          ...correctionInput,
          reason: 'different replay body',
        };
        const conflictResponse = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          conflictInput,
          'conflicting review replay',
          409,
        );
        await requireError(
          conflictResponse.response,
          409,
          'REVIEW_EVENT_CONFLICT',
          'conflicting review replay',
        );

        const missingChecklist = { ...firstInput };
        delete missingChecklist.checklist;
        const missingResponse = await reviewPackage(
          operator,
          FIXTURE.lessonVersion,
          missingChecklist,
          'missing review checklist',
          400,
        );
        await requireError(
          missingResponse.response,
          400,
          'INVALID_REQUEST',
          'missing review checklist',
        );
      },
      accounts,
      secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R05-fixture-approval-and-content-guards',
      async () => {
        requireDependency(state.operatorReady, 'operator registry session');
        requireDependency(
          typeof testRunId === 'string' && testRunId.length > 0,
          'test run ID',
        );
        requireDependency(
          typeof testToken === 'string' && testToken.length > 0,
          'test token',
        );
        const operator = clientFor('operator');
        await dependencyCall(
          curriculumFixtures?.setTestContentAllowed,
          'test-content guard enable',
          true,
        );
        await dependencyCall(
          curriculumFixtures?.setFixtureRunId,
          'fixture run selection',
          testRunId,
        );
        const fixture = packageWithCheckedProvenance(
          'forest-01-v2-approved-fixture',
        );
        const fixtureDigest = curriculumDigest(fixture);
        state.fixtureVersion = fixture.lessonVersion;
        const imported = await importPackage(
          operator,
          fixture,
          'checked fixture import',
        );
        requireCondition(
          imported.body.created === true,
          'checked fixture was not imported',
        );
        const approved = await reviewPackage(
          operator,
          fixture.lessonVersion,
          reviewInput({
            requestId: 'cr05-fixture-approval',
            contentDigest: fixtureDigest,
            decision: 'approved',
            allChecklist: true,
            reason: 'Synthetic source-checked fixture approval',
          }),
          'checked fixture approval',
        );
        requireCondition(
          approved.body.created === true,
          'checked fixture approval was not created',
        );
        const coverageResponse = await operator.request(
          '/api/pilot/curriculum',
        );
        requireStatus(coverageResponse, 200, 'fixture coverage');
        requireNoStore(coverageResponse, 'fixture coverage');
        const coverage = await jsonBody(coverageResponse);
        requireCoverageShape(coverage, 'fixture coverage');
        const fixtureRow = coverage.packages.find(
          (item) => item.lessonVersion === fixture.lessonVersion,
        );
        requireCondition(
          object(fixtureRow) &&
            fixtureRow.testFixture === true &&
            fixtureRow.reviewState === 'test-fixture',
          'approved fixture did not remain test-fixture',
        );
        requireCondition(
          coverage.counts.humanReviewedDistinct === 0 &&
            coverage.counts.reviewedReadyDistinct === 0 &&
            coverage.counts.starterReleasedDistinct === 0,
          'fixture approval contributed to trusted coverage',
        );

        try {
          await dependencyCall(
            curriculumFixtures?.setTestContentAllowed,
            'test-content guard disable',
            false,
          );
          const denied = await operator.request('/api/pilot/curriculum', {
            method: 'POST',
            body: { package: packageWithVersion('forest-01-v2-guard-off') },
          });
          await requireError(
            denied,
            403,
            'TEST_CONTENT_DISABLED',
            'guard-off curriculum import',
          );
        } finally {
          await dependencyCall(
            curriculumFixtures?.setTestContentAllowed,
            'test-content guard restore',
            true,
          );
        }

        try {
          await dependencyCall(
            curriculumFixtures?.setFixtureRunId,
            'foreign fixture run selection',
            `${testRunId}-foreign`,
          );
          const foreignReview = await operator.request(
            versionPath(fixture.lessonVersion, '/reviews'),
            {
              method: 'POST',
              body: reviewInput({
                requestId: 'cr05-foreign-run-review',
                contentDigest: fixtureDigest,
                previousReviewId: approved.body.reviewId,
                decision: 'rejected',
                reason: 'Foreign fixture mutation must be refused',
              }),
            },
          );
          await requireError(
            foreignReview,
            409,
            'FIXTURE_SCOPE_MISMATCH',
            'foreign fixture review',
          );
        } finally {
          await dependencyCall(
            curriculumFixtures?.setFixtureRunId,
            'fixture run restore',
            testRunId,
          );
        }
      },
      accounts,
      secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R06-concurrent-reviews-and-late-audit-rollback',
      async () => {
        requireDependency(state.operatorReady, 'operator registry session');
        requireDependency(
          typeof testRunId === 'string' && testRunId.length > 0,
          'test run ID',
        );
        const operator = clientFor('operator');
        const latePackage = packageWithVersion('forest-01-v2-late-audit');
        const lateDigest = curriculumDigest(latePackage);
        try {
          await dependencyCall(
            curriculumFixtures?.setAuditAvailable,
            'audit fault enable',
            false,
          );
          const beforeImport = registrySummary(await inspect());
          const failedImport = await operator.request('/api/pilot/curriculum', {
            method: 'POST',
            body: { package: latePackage },
          });
          await requireError(
            failedImport,
            503,
            'STORAGE_UNAVAILABLE',
            'late-audit import failure',
          );
          requireSummaryEqual(
            beforeImport,
            registrySummary(await inspect()),
            'late-audit import rollback',
          );
        } finally {
          await dependencyCall(
            curriculumFixtures?.setAuditAvailable,
            'audit fault restore',
            true,
          );
        }

        const retry = await importPackage(
          operator,
          latePackage,
          'late-audit import retry',
        );
        requireCondition(
          retry.body.created === true,
          'late-audit import retry did not create package',
        );
        const beforeReview = registrySummary(await inspect());
        const failedReviewInput = reviewInput({
          requestId: 'cr06-late-audit-review',
          contentDigest: lateDigest,
          reason: 'Late audit review failure must roll back',
        });
        try {
          await dependencyCall(
            curriculumFixtures?.setAuditAvailable,
            'review audit fault enable',
            false,
          );
          const failedReview = await operator.request(
            versionPath(latePackage.lessonVersion, '/reviews'),
            {
              method: 'POST',
              body: failedReviewInput,
            },
          );
          await requireError(
            failedReview,
            503,
            'STORAGE_UNAVAILABLE',
            'late-audit review failure',
          );
          requireSummaryEqual(
            beforeReview,
            registrySummary(await inspect()),
            'late-audit review rollback',
          );
        } finally {
          await dependencyCall(
            curriculumFixtures?.setAuditAvailable,
            'review audit fault restore',
            true,
          );
        }

        const reviewRetry = await reviewPackage(
          operator,
          latePackage.lessonVersion,
          failedReviewInput,
          'late-audit review retry',
        );
        requireCondition(
          reviewRetry.body.created === true,
          'late-audit review retry did not create event',
        );
        const previousReviewId = reviewRetry.body.reviewId;
        const firstConcurrent = new PilotClient(baseURL);
        const secondConcurrent = new PilotClient(baseURL);
        await login(
          firstConcurrent,
          account('operator'),
          'first concurrent reviewer sign-in',
        );
        await login(
          secondConcurrent,
          account('operator'),
          'second concurrent reviewer sign-in',
        );
        const concurrentInputs = [
          reviewInput({
            requestId: 'cr06-concurrent-review-a',
            contentDigest: lateDigest,
            previousReviewId,
            reason: 'Concurrent review A',
          }),
          reviewInput({
            requestId: 'cr06-concurrent-review-b',
            contentDigest: lateDigest,
            previousReviewId,
            reason: 'Concurrent review B',
          }),
        ];
        const concurrentReviews = await Promise.all(
          [firstConcurrent, secondConcurrent].map((client, index) =>
            client.request(versionPath(latePackage.lessonVersion, '/reviews'), {
              method: 'POST',
              body: concurrentInputs[index],
            }),
          ),
        );
        const statuses = concurrentReviews
          .map((response) => response.status)
          .sort((a, b) => a - b);
        requireCondition(
          statuses[0] === 201 && statuses[1] === 409,
          'concurrent reviews did not produce one success and one stale head',
        );
        for (const [index, response] of concurrentReviews.entries()) {
          requireNoStore(response, `concurrent review ${index + 1}`);
          if (response.status === 409) {
            await requireError(
              response,
              409,
              'STALE_REVIEW',
              'concurrent stale review',
            );
          }
        }
        const afterConcurrent = registrySummary(await inspect());
        requireCondition(
          afterConcurrent.reviews === beforeReview.reviews + 2 &&
            afterConcurrent.audit === beforeReview.audit + 2 &&
            afterConcurrent.revision === beforeReview.revision + 2,
          'concurrent review changed registry rows more than once',
        );
      },
      accounts,
      secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R07-learner-boundary-and-legacy-projection',
      async () => {
        requireDependency(state.operatorReady, 'operator registry session');
        const operator = clientFor('operator');
        const parent = clientFor('parentA');
        const child = clientFor('childA');
        const teacher = clientFor('teacher');
        const link = await operator.request('/api/pilot/links', {
          method: 'POST',
          body: {
            parentId: account('parentA').id,
            childId: account('childA').id,
          },
        });
        requireStatus(link, [200, 201, 409], 'legacy parent-child link');
        requireNoStore(link, 'legacy parent-child link');
        const grant = await parent.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: account('childA').id,
            teacherId: account('teacher').id,
          },
        });
        requireStatus(grant, [200, 201, 409], 'legacy teacher grant');
        requireNoStore(grant, 'legacy teacher grant');

        for (const [label, client] of [
          ['parent', parent],
          ['child', child],
          ['teacher', teacher],
        ]) {
          const list = await client.request('/api/pilot/curriculum');
          await requireError(
            list,
            403,
            'FORBIDDEN',
            `${label} curriculum list`,
          );
          const detail = await client.request(
            versionPath(FIXTURE.lessonVersion),
          );
          await requireError(
            detail,
            403,
            'FORBIDDEN',
            `${label} curriculum detail`,
          );
          const profile = await client.request(
            `/api/pilot/children/${encodeURIComponent(account('childA').id)}`,
          );
          requireStatus(profile, 200, `${label} legacy child profile`);
          requireNoStore(profile, `${label} legacy child profile`);
          requireNoRegistryLeak(
            await jsonBody(profile),
            `${label} legacy child profile`,
          );
        }

        const assignment = await parent.request(
          `/api/pilot/children/${encodeURIComponent(account('childA').id)}/assignments`,
        );
        requireStatus(assignment, 200, 'parent legacy assignments');
        requireNoStore(assignment, 'parent legacy assignments');
        const assignmentBody = await jsonBody(assignment);
        requireNoRegistryLeak(assignmentBody, 'parent legacy assignments');
        requireCondition(
          Array.isArray(assignmentBody.assignments) &&
            Array.isArray(assignmentBody.availableLessons),
          'parent legacy assignments changed its public projection',
        );
        for (const lesson of assignmentBody.availableLessons) {
          requireCondition(
            object(lesson) &&
              typeof lesson.lessonId === 'string' &&
              typeof lesson.lessonVersion === 'string' &&
              typeof lesson.title === 'string' &&
              typeof lesson.canAssign === 'boolean',
            'legacy lesson release projection is incomplete',
          );
        }
        requireCondition(
          !JSON.stringify(assignmentBody).includes(FIXTURE.lessonVersion),
          'legacy assignments exposed the S3 registry package',
        );

        const teacherAssignments = await teacher.request(
          `/api/pilot/children/${encodeURIComponent(account('childA').id)}/assignments`,
        );
        requireStatus(teacherAssignments, 200, 'teacher legacy assignments');
        requireNoStore(teacherAssignments, 'teacher legacy assignments');
        requireNoRegistryLeak(
          await jsonBody(teacherAssignments),
          'teacher legacy assignments',
        );
      },
      accounts,
      secrets,
    ),
  );

  return results;
}
