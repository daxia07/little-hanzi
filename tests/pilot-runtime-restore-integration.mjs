/*
 * Sprint 3 runtime backup/restore probe.
 *
 * The runner owns disposable Worker/D1 installations and supplies private
 * backup/restore callbacks.  Runtime rows are populated through the ordinary
 * authenticated HTTP API; this probe never writes run, event, or audit rows
 * directly and never treats an engine response as a trusted proof.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);
const FORMAT_V1 = 'pilot-admin-backup-1';
const FORMAT_V2 = 'pilot-admin-backup-2';
const FORMAT_V3 = 'pilot-admin-backup-3';
const DAY = 86_400_000;
const LEGACY_TABLES = Object.freeze([
  'pilot_auth_user',
  'pilot_auth_account',
  'pilot_auth_rate_limit',
  'pilot_parent_child',
  'pilot_teacher_grant',
  'pilot_account_audit',
  'pilot_onboarding',
  'pilot_assignment',
  'pilot_run_ownership',
  'pilot_learning_release',
  'pilot_learning_run',
  'pilot_learning_event',
  'pilot_learning_audit',
]);
const REGISTRY_TABLES = Object.freeze([
  'pilot_curriculum_registry_state',
  'pilot_curriculum_package',
  'pilot_curriculum_character',
  'pilot_curriculum_review',
  'pilot_curriculum_audit',
]);
const RUNTIME_TABLES = Object.freeze([
  'pilot_curriculum_runtime_run',
  'pilot_curriculum_runtime_event',
  'pilot_curriculum_runtime_audit',
]);
const V3_TABLES = Object.freeze([
  ...LEGACY_TABLES,
  ...REGISTRY_TABLES,
  ...RUNTIME_TABLES,
]);
const RUNTIME_COLUMNS = Object.freeze({
  pilot_curriculum_runtime_run: [
    'run_id',
    'request_id',
    'request_digest',
    'child_id',
    'lesson_version',
    'content_digest',
    'adapter_id',
    'adapter_version',
    'installation_id',
    'candidate_id',
    'test_run_id',
    'purpose',
    'created_by_user_id',
    'run_json',
    'revision',
    'created_at',
    'updated_at',
  ],
  pilot_curriculum_runtime_event: [
    'run_id',
    'event_id',
    'sequence',
    'event_json',
    'created_at',
  ],
  pilot_curriculum_runtime_audit: [
    'id',
    'run_id',
    'actor_user_id',
    'action',
    'event_id',
    'revision',
    'created_at',
  ],
});
const MIGRATIONS_V3 = [
  ['0000-auth.sql', 'pilot-auth-0000'],
  ['0001-data.sql', 'pilot-data-0001'],
  ['0002-learning.sql', 'pilot-learning-0002'],
  ['0003-curriculum.sql', 'pilot-curriculum-0003'],
  ['0004-curriculum-runtime.sql', 'pilot-curriculum-runtime-0004'],
];
const FORBIDDEN_TABLES = new Set([
  'pilot_installation',
  'pilot_schema_history',
  'pilot_d1_migrations',
  'pilot_auth_session',
  'pilot_auth_verification',
  'pilot_curriculum_runtime_proof',
  'pilot_curriculum_release',
  'attempts',
  'settings',
  'drafts',
]);
const TOKEN_COLUMNS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'access_token_expires_at',
  'refresh_token_expires_at',
  'scope',
]);

let nextIP = 1;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function contentDigest(value) {
  return `sha256:${sha256(canonical(value))}`;
}

function rawDigest(value) {
  return sha256(JSON.stringify(value));
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

function tableDigest(tables) {
  const normalized = Object.fromEntries(
    Object.keys(tables)
      .sort()
      .map((table) => [
        table,
        tables[table].map((row) => canonical(row)).sort(),
      ]),
  );
  return rawDigest(normalized);
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

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
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

function splitSetCookie(value) {
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]*)/g) : [];
}

class CookieJar {
  #cookies = new Map();

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
      const cookie = pair.slice(separator + 1).trim();
      if (cookie) this.#cookies.set(name, cookie);
      else this.#cookies.delete(name);
    }
  }

  attach(headers) {
    if (this.#cookies.size)
      headers.set(
        'Cookie',
        [...this.#cookies.entries()]
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
      );
  }

  header() {
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

class PilotClient {
  constructor(baseURL) {
    requireCondition(
      typeof baseURL === 'string' && baseURL.length > 0,
      'baseURL is required',
    );
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.ip = `198.51.100.${nextIP++}`;
    this.cookies = new CookieJar();
  }

  async request(
    path,
    { method = 'GET', body, rawBody, origin = this.origin, headers = {} } = {},
  ) {
    const requestHeaders = new Headers({
      Accept: 'application/json',
      Connection: 'close',
      ...headers,
    });
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
      throw new Error(
        `network request failed [${error instanceof Error ? error.name : 'FetchError'}]`,
      );
    }
    this.cookies.store(response);
    return response;
  }
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function bodyData(body) {
  return object(body?.data) ? body.data : body;
}

function forbiddenPrivate(value) {
  const entries = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!object(node)) return;
    for (const [key, child] of Object.entries(node)) {
      entries.push([key, child]);
      visit(child);
    }
  };
  visit(value);
  return entries.some(
    ([key, child]) =>
      /password|hash|token|secret|email/i.test(key) &&
      !(key === 'mustChangePassword' && typeof child === 'boolean'),
  );
}

function requireNoStore(response, label) {
  requireCondition(
    /(?:^|,\s*)no-store(?:\s*,|$)/i.test(
      response.headers.get('cache-control') || '',
    ),
    `${label} omitted Cache-Control: no-store`,
  );
}

async function requireJSON(response, expected, label, code = null) {
  requireCondition(
    response.status === expected,
    `${label} returned HTTP ${response.status}`,
  );
  requireNoStore(response, label);
  const body = bodyData(await jsonBody(response));
  requireCondition(object(body), `${label} returned no JSON object`);
  if (expected >= 200 && expected < 300)
    requireCondition(
      !forbiddenPrivate(body),
      `${label} exposed private credentials`,
    );
  else {
    requireCondition(
      !forbiddenPrivate(body),
      `${label} exposed private credentials`,
    );
    if (code)
      requireCondition(
        body.error?.code === code || body.code === code,
        `${label} returned the wrong error code`,
      );
  }
  return body;
}

async function login(client, account, label) {
  await requireJSON(
    await client.request('/api/auth/sign-in/username', {
      method: 'POST',
      body: { username: account.username, password: account.password },
    }),
    200,
    label,
  );
}

async function importPackage(client, packageValue, label) {
  const response = await client.request('/api/pilot/curriculum', {
    method: 'POST',
    body: { package: packageValue },
  });
  const body = await requireJSON(response, 201, label);
  requireCondition(
    body.created === true &&
      body.lessonVersion === packageValue.lessonVersion &&
      body.contentDigest === contentDigest(packageValue),
    `${label} returned invalid package metadata`,
  );
  return body;
}

async function ensureRelationships(baseURL, accounts) {
  const operator = new PilotClient(baseURL);
  const parent = new PilotClient(baseURL);
  await login(
    operator,
    accountFor(accounts, 'operator'),
    'R09 operator relationship login',
  );
  await login(
    parent,
    accountFor(accounts, 'parentA'),
    'R09 parent relationship login',
  );
  const link = await operator.request('/api/pilot/links', {
    method: 'POST',
    body: {
      parentId: accountFor(accounts, 'parentA').id,
      childId: accountFor(accounts, 'childA').id,
    },
  });
  requireCondition(
    [200, 201, 409].includes(link.status),
    `R09 parent-child link returned HTTP ${link.status}`,
  );
  await requireJSON(link, link.status, 'R09 parent-child link');
  const grant = await parent.request('/api/pilot/grants', {
    method: 'POST',
    body: {
      childId: accountFor(accounts, 'childA').id,
      teacherId: accountFor(accounts, 'teacher').id,
    },
  });
  requireCondition(
    [200, 201, 409].includes(grant.status),
    `R09 teacher grant returned HTTP ${grant.status}`,
  );
  await requireJSON(grant, grant.status, 'R09 teacher grant');
}

function runtimePath(childId, runId, suffix = '') {
  return `/api/pilot/children/${encodeURIComponent(childId)}/curriculum-verifications/${encodeURIComponent(runId)}${suffix}`;
}

function packagePath(version, suffix = '') {
  return `/api/pilot/curriculum/${encodeURIComponent(version)}${suffix}`;
}

function runtimeFixture(version) {
  const value = clone(FIXTURE);
  value.lessonVersion = version;
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
    (item) => item.checkId === checkId,
  );
  requireCondition(check, `fixture check ${checkId} is unavailable`);
  return check;
}

function correctChoice(fixture, checkId) {
  return checkFor(fixture, checkId).correctChoiceId;
}

async function getRun(client, childId, runId, label, expected = 200) {
  const response = await client.request(runtimePath(childId, runId));
  if (expected !== 200) {
    await requireJSON(
      response,
      expected,
      label,
      expected === 401 ? 'UNAUTHORIZED' : 'NOT_FOUND',
    );
    return null;
  }
  const body = await requireJSON(response, 200, label);
  requireCondition(
    body.schemaVersion === 's3-runtime-http-1',
    `${label} schema mismatch`,
  );
  return bodyData(body);
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
    await requireJSON(
      response,
      expected,
      label,
      expected === 503 ? 'STORAGE_UNAVAILABLE' : 'INVALID_TRANSITION',
    );
    return null;
  }
  const body = await requireJSON(response, 200, label);
  requireCondition(
    body.schemaVersion === 's3-runtime-action-1',
    `${label} schema mismatch`,
  );
  requireCondition(object(body.ack), `${label} omitted ack`);
  return body;
}

async function createRun(client, version, input, label) {
  const body = await requireJSON(
    await client.request(packagePath(version, '/runtime-verifications'), {
      method: 'POST',
      body: input,
    }),
    201,
    label,
  );
  requireCondition(
    typeof body.runId === 'string' && body.purpose === 'test-verification',
    `${label} returned invalid metadata`,
  );
  return body;
}

async function driveInitial(
  client,
  childId,
  runId,
  fixture,
  prefix,
  stopAfter = 64,
  requireComplete = true,
) {
  let view = await getRun(client, childId, runId, `${prefix} initial view`);
  let actions = 0;
  while (!view.run.completion.initialCompletedAt && actions < stopAfter) {
    const question = view.run.question;
    const openQuestion = question?.questionStatus === 'open';
    const action = openQuestion
      ? {
          eventId: `${prefix}-answer-${actions}`,
          expectedRevision: view.run.revision,
          occurrenceId: question.occurrenceId,
          type: 'answer',
          payload: { choiceId: correctChoice(fixture, question.checkId) },
        }
      : {
          eventId: `${prefix}-continue-${actions}`,
          expectedRevision: view.run.revision,
          occurrenceId: question?.occurrenceId ?? null,
          type: 'continue',
          payload: {},
        };
    await postAction(
      client,
      childId,
      runId,
      action,
      `${prefix} action ${actions}`,
    );
    view = await getRun(client, childId, runId, `${prefix} reload ${actions}`);
    actions++;
  }
  if (requireComplete)
    requireCondition(
      view.run.completion.initialCompletedAt,
      `${prefix} did not complete within ${stopAfter} actions`,
    );
  return view.run;
}

function runtimeRows(snapshot, table, label) {
  requireCondition(
    Array.isArray(snapshot?.tables?.[table]),
    `${label} omitted ${table}`,
  );
  return snapshot.tables[table];
}

function requireV3Snapshot(
  snapshot,
  label,
  { fresh = false, sessions = false } = {},
) {
  requireDependency(object(snapshot), `${label} inspection is unavailable`);
  requireCondition(
    JSON.stringify(Object.keys(snapshot.tables || {}).sort()) ===
      JSON.stringify([...V3_TABLES].sort()),
    `${label} does not expose exactly 21 tables`,
  );
  requireCondition(
    !Object.keys(snapshot.tables).some((name) => FORBIDDEN_TABLES.has(name)),
    `${label} exposed a forbidden table`,
  );
  for (const table of V3_TABLES)
    requireCondition(
      Array.isArray(snapshot.tables[table]),
      `${label} ${table} is not a row array`,
    );
  for (const table of RUNTIME_TABLES) {
    for (const row of runtimeRows(snapshot, table, label)) {
      requireCondition(
        JSON.stringify(
          Object.keys(row).sort((left, right) => left.localeCompare(right)),
        ) ===
          JSON.stringify(
            [...RUNTIME_COLUMNS[table]].sort((left, right) =>
              left.localeCompare(right),
            ),
          ),
        `${label} ${table} row shape changed`,
      );
      requireCondition(
        !Object.keys(row).some((key) => TOKEN_COLUMNS.has(key)),
        `${label} ${table} exposed credentials`,
      );
    }
  }
  for (const row of runtimeRows(snapshot, 'pilot_auth_account', label))
    requireCondition(
      !Object.keys(row).some((key) => TOKEN_COLUMNS.has(key)),
      `${label} exposed OAuth columns`,
    );
  requireCondition(
    Array.isArray(snapshot.sessions) &&
      (sessions || snapshot.sessions.length === 0),
    `${label} retained unexpected sessions`,
  );
  requireCondition(
    Array.isArray(snapshot.verification) && snapshot.verification.length === 0,
    `${label} retained verification rows`,
  );
  requireCondition(
    snapshot.restoreGuardExists === false,
    `${label} retained restore guard`,
  );
  if (fresh) {
    for (const table of V3_TABLES.filter(
      (name) => name !== 'pilot_curriculum_registry_state',
    ))
      requireCondition(
        runtimeRows(snapshot, table, label).length === 0,
        `${label} ${table} is populated`,
      );
    const registry = runtimeRows(
      snapshot,
      'pilot_curriculum_registry_state',
      label,
    );
    requireCondition(
      registry.length === 1 &&
        registry[0]?.id === 1 &&
        registry[0]?.revision === 0 &&
        registry[0]?.updated_at === 0,
      `${label} registry baseline changed`,
    );
  }
}

function requireV3Envelope(envelope, label, sourceInstallationId) {
  requireCondition(
    object(envelope) && object(envelope.payload),
    `${label} is unavailable`,
  );
  requireCondition(
    envelope.sha256 === rawDigest(envelope.payload),
    `${label} checksum is not canonical`,
  );
  const payload = envelope.payload;
  requireCondition(
    payload.format === FORMAT_V3,
    `${label} is not a v3 envelope`,
  );
  requireCondition(
    JSON.stringify(
      payload.migrations.map((item) => [item.name, item.version]),
    ) === JSON.stringify(MIGRATIONS_V3),
    `${label} migration set is not v3`,
  );
  requireCondition(
    payload.sourceInstallationId === sourceInstallationId,
    `${label} source installation changed`,
  );
  requireCondition(
    JSON.stringify(Object.keys(payload.tables || {}).sort()) ===
      JSON.stringify([...V3_TABLES].sort()),
    `${label} does not contain exactly 21 table arrays`,
  );
  for (const table of RUNTIME_TABLES) {
    requireCondition(
      Array.isArray(payload.tables[table]),
      `${label} omitted ${table}`,
    );
    for (const row of payload.tables[table])
      requireCondition(
        JSON.stringify(
          Object.keys(row).sort((left, right) => left.localeCompare(right)),
        ) ===
          JSON.stringify(
            [...RUNTIME_COLUMNS[table]].sort((left, right) =>
              left.localeCompare(right),
            ),
          ),
        `${label} ${table} row shape changed`,
      );
  }
  requireCondition(
    !Object.keys(payload.tables).some((name) => FORBIDDEN_TABLES.has(name)),
    `${label} included forbidden records`,
  );
  return payload;
}

function assertSnapshotEqual(left, right, label) {
  requireCondition(
    tableDigest(left.tables) === tableDigest(right.tables),
    `${label} row sets changed`,
  );
  requireCondition(
    left.installationId === right.installationId,
    `${label} installation changed`,
  );
  requireCondition(
    stable(left.schemaObjects) &&
      JSON.stringify(stable(left.schemaObjects)) ===
        JSON.stringify(stable(right.schemaObjects)),
    `${label} schema changed`,
  );
  requireCondition(
    JSON.stringify(stable(left.migrations)) ===
      JSON.stringify(stable(right.migrations)),
    `${label} migration state changed`,
  );
  requireCondition(
    JSON.stringify(stable(left.sessions)) ===
      JSON.stringify(stable(right.sessions)),
    `${label} sessions changed`,
  );
  requireCondition(
    JSON.stringify(stable(left.verification)) ===
      JSON.stringify(stable(right.verification)),
    `${label} verification rows changed`,
  );
  requireCondition(
    right.restoreGuardExists === false,
    `${label} retained restore guard`,
  );
}

function sanitizeMessage(error, accounts, secrets = []) {
  let message =
    error instanceof Error ? error.message : 'runtime restore assertion failed';
  const privateValues = [
    ...Object.values(accounts || {}).flatMap((account) =>
      object(account) ? [account.id, account.username, account.password] : [],
    ),
    ...secrets,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const value of privateValues)
    message = message.split(value).join('[redacted]');
  return message.replace(
    /(?:password|hash|token|secret|email)[^\s]*/gi,
    '[redacted]',
  );
}

async function expectRejected(action, label, code = null) {
  let error = null;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  requireCondition(error, `${label} unexpectedly succeeded`);
  if (code) {
    const errorCode =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    const errorMessage = error instanceof Error ? error.message : String(error);
    requireCondition(
      errorCode === code || errorMessage.includes(code),
      `${label} did not return ${String(code)}`,
    );
  }
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

export async function runPilotRuntimeRestoreIntegration(context) {
  const source = context?.source;
  const accounts = source?.accounts || {};
  const state = {
    fixture: runtimeFixture('forest-01-v2'),
    fixtureDigest: null,
    completedRun: null,
    partialRun: null,
    completedRunId: null,
    partialRunId: null,
    completedRequestId: 'r09-reviewer-completed',
    partialRequestId: 'r09-reviewer-partial',
    oldCookie: null,
    sourceBefore: null,
    sourceFingerprint: null,
    backupId: null,
    envelope: null,
    destination: null,
    freshRun: null,
    secrets: [],
  };
  const results = [];

  results.push(
    await runCase(
      'C-R09-01-capture-runtime-history',
      async () => {
        requireDependency(
          typeof source?.baseURL === 'string',
          'source Worker is required',
        );
        requireDependency(
          source?.format === FORMAT_V3,
          'C-R09 requires a v3 source candidate',
        );
        requireDependency(
          typeof context?.backup === 'function' &&
            typeof context?.readBackup === 'function',
          'backup callbacks are required',
        );
        requireDependency(
          typeof context?.inspect === 'function' &&
            typeof context?.fingerprintSource === 'function',
          'source inspection callbacks are required',
        );
        requireDependency(
          typeof context?.setSourceClock === 'function',
          'source runtime clock callback is required',
        );
        const reviewer = accountFor(accounts, 'reviewer');
        const operator = new PilotClient(source.baseURL);
        const reviewerClient = new PilotClient(source.baseURL);
        const childA = new PilotClient(source.baseURL);
        const childB = new PilotClient(source.baseURL);
        await login(
          operator,
          accountFor(accounts, 'operator'),
          'R09 operator login',
        );
        await login(reviewerClient, reviewer, 'R09 reviewer login');
        await login(
          childA,
          accountFor(accounts, 'childA'),
          'R09 child A login',
        );
        await login(
          childB,
          accountFor(accounts, 'childB'),
          'R09 child B login',
        );
        await importPackage(
          operator,
          state.fixture,
          'R09 runtime package import',
        );
        await ensureRelationships(source.baseURL, accounts);
        state.oldCookie = childA.cookies.header();
        requireCondition(
          state.oldCookie.length > 0,
          'R09 source cookie was not captured',
        );
        state.fixtureDigest = contentDigest(state.fixture);
        const created = await createRun(
          reviewerClient,
          state.fixture.lessonVersion,
          {
            requestId: state.completedRequestId,
            contentDigest: state.fixtureDigest,
            childId: accountFor(accounts, 'childA').id,
          },
          'R09 reviewer completed run',
        );
        state.completedRunId = created.runId;
        await driveInitial(
          childA,
          accountFor(accounts, 'childA').id,
          state.completedRunId,
          state.fixture,
          'r09-completed',
        );
        let completedView = await getRun(
          childA,
          accountFor(accounts, 'childA').id,
          state.completedRunId,
          'R09 completed initial view',
        );
        const initialCompletedAt = Date.parse(
          completedView.run.completion.initialCompletedAt,
        );
        requireCondition(
          Number.isFinite(initialCompletedAt),
          'R09 completed run has no initial completion',
        );
        const dueAt =
          Date.parse(completedView.run.completion.reviewAvailableAt || '') ||
          initialCompletedAt + DAY;
        await context.setSourceClock(dueAt);
        try {
          await postAction(
            childA,
            accountFor(accounts, 'childA').id,
            state.completedRunId,
            {
              eventId: 'r09-start-review',
              expectedRevision: completedView.run.revision,
              occurrenceId: null,
              type: 'start-review',
              payload: {},
            },
            'R09 start delayed review',
          );
          for (let index = 0; index < 40; index++) {
            completedView = await getRun(
              childA,
              accountFor(accounts, 'childA').id,
              state.completedRunId,
              `R09 delayed reload ${index}`,
            );
            if (completedView.run.completion.reviewCompletedAt) break;
            const question = completedView.run.question;
            const openQuestion = question?.questionStatus === 'open';
            await postAction(
              childA,
              accountFor(accounts, 'childA').id,
              state.completedRunId,
              openQuestion
                ? {
                    eventId: `r09-delayed-answer-${index}`,
                    expectedRevision: completedView.run.revision,
                    occurrenceId: question.occurrenceId,
                    type: 'answer',
                    payload: {
                      choiceId: correctChoice(state.fixture, question.checkId),
                    },
                  }
                : {
                    eventId: `r09-delayed-continue-${index}`,
                    expectedRevision: completedView.run.revision,
                    occurrenceId: question?.occurrenceId ?? null,
                    type: 'continue',
                    payload: {},
                  },
              `R09 delayed action ${index}`,
            );
          }
          completedView = await getRun(
            childA,
            accountFor(accounts, 'childA').id,
            state.completedRunId,
            'R09 delayed completed view',
          );
          requireCondition(
            completedView.run.completion.reviewCompletedAt,
            'R09 delayed review did not complete',
          );
          state.completedRun = completedView.run;
        } finally {
          await context.setSourceClock(null);
        }

        const partial = await createRun(
          reviewerClient,
          state.fixture.lessonVersion,
          {
            requestId: state.partialRequestId,
            contentDigest: state.fixtureDigest,
            childId: accountFor(accounts, 'childB').id,
          },
          'R09 reviewer partial run',
        );
        state.partialRunId = partial.runId;
        await driveInitial(
          childB,
          accountFor(accounts, 'childB').id,
          state.partialRunId,
          state.fixture,
          'r09-partial',
          1,
          false,
        );
        state.partialRun = (
          await getRun(
            childB,
            accountFor(accounts, 'childB').id,
            state.partialRunId,
            'R09 partial view',
          )
        ).run;
        requireCondition(
          !state.partialRun.completion.initialCompletedAt &&
            state.partialRun.revision > 0,
          'R09 partial run is not partial',
        );

        const disable = await operator.request(
          `/api/pilot/accounts/${encodeURIComponent(reviewer.id)}/status`,
          {
            method: 'POST',
            body: { disabled: true },
          },
        );
        await requireJSON(disable, 200, 'R09 disable historical operator');
        state.sourceBefore = await context.inspect('source');
        requireV3Snapshot(state.sourceBefore, 'R09 source', { sessions: true });
        const runtimeRuns = runtimeRows(
          state.sourceBefore,
          'pilot_curriculum_runtime_run',
          'R09 source',
        );
        const reviewerRuns = runtimeRuns.filter(
          (row) => row.created_by_user_id === reviewer.id,
        );
        requireCondition(
          reviewerRuns.some((row) => row.run_id === state.completedRunId) &&
            reviewerRuns.some((row) => row.run_id === state.partialRunId),
          'runtime runs were not attributed to reviewer',
        );
        const reviewerRow = runtimeRows(
          state.sourceBefore,
          'pilot_auth_user',
          'R09 source',
        ).find((row) => row.id === reviewer.id);
        requireCondition(
          reviewerRow?.disabled === 1,
          'disabled historical operator was not preserved',
        );
        requireCondition(
          runtimeRows(
            state.sourceBefore,
            'pilot_curriculum_runtime_event',
            'R09 source',
          ).length > 0 &&
            runtimeRows(
              state.sourceBefore,
              'pilot_curriculum_runtime_audit',
              'R09 source',
            ).length > 0,
          'runtime history is empty',
        );
        state.sourceFingerprint = await context.fingerprintSource();
        const createdBackup = await context.backup({ name: 'r09-runtime-v3' });
        requireCondition(
          createdBackup?.id && createdBackup.summary?.format === FORMAT_V3,
          'R09 backup did not return a v3 summary',
        );
        requireCondition(
          createdBackup.fileMode === 0o600 &&
            createdBackup.directoryMode === 0o700,
          'R09 backup private modes are unsafe',
        );
        state.backupId = createdBackup.id;
        state.envelope = await context.readBackup(state.backupId);
        const payload = requireV3Envelope(
          state.envelope,
          'R09 v3 backup',
          state.sourceBefore.installationId,
        );
        requireCondition(
          tableDigest(payload.tables) ===
            tableDigest(state.sourceBefore.tables),
          'R09 backup rows differ from source',
        );
        for (const table of RUNTIME_TABLES)
          requireCondition(
            payload.tables[table].length ===
              state.sourceBefore.tables[table].length,
            `R09 backup omitted ${table}`,
          );
        const afterBackup = await context.inspect('source');
        assertSnapshotEqual(
          state.sourceBefore,
          afterBackup,
          'R09 source after backup',
        );
        requireCondition(
          (await context.fingerprintSource()) === state.sourceFingerprint,
          'R09 backup changed source',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R09-02-restore-and-invalidate',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'R09 capture state',
        );
        requireDependency(
          typeof context.createDestination === 'function' &&
            typeof context.restore === 'function',
          'destination callbacks are required',
        );
        const destination = await context.createDestination({ format: 'v3' });
        const restored = await context.restore({
          backupId: state.backupId,
          destinationId: destination.id,
        });
        requireCondition(
          restored?.format === FORMAT_V3 &&
            restored.installationId !== state.sourceBefore.installationId,
          'R09 fresh restore summary is invalid',
        );
        const after = await context.inspect(destination.id);
        requireV3Snapshot(after, 'R09 restored destination');
        requireCondition(
          tableDigest(after.tables) === tableDigest(state.sourceBefore.tables),
          'R09 restored row sets differ',
        );
        requireCondition(
          after.installationId !== state.sourceBefore.installationId,
          'R09 destination reused source installation',
        );
        requireCondition(
          after.sessions.length === 0 && after.verification.length === 0,
          'R09 restore retained sessions',
        );
        await context.setRuntimeNamespace({ destinationId: destination.id });
        const sourceCookie = new PilotClient(destination.baseURL);
        await requireJSON(
          await sourceCookie.request('/api/pilot/me', {
            headers: { Cookie: state.oldCookie },
          }),
          401,
          'R09 source cookie after restore',
          'UNAUTHORIZED',
        );
        const child = new PilotClient(destination.baseURL);
        const parent = new PilotClient(destination.baseURL);
        const teacher = new PilotClient(destination.baseURL);
        const operator = new PilotClient(destination.baseURL);
        await login(
          child,
          accountFor(accounts, 'childA'),
          'R09 restored child login',
        );
        await login(
          parent,
          accountFor(accounts, 'parentA'),
          'R09 restored parent login',
        );
        await login(
          teacher,
          accountFor(accounts, 'teacher'),
          'R09 restored teacher login',
        );
        await login(
          operator,
          accountFor(accounts, 'operator'),
          'R09 restored operator login',
        );
        await getRun(
          child,
          accountFor(accounts, 'childA').id,
          state.completedRunId,
          'R09 old child run after restore',
          404,
        );
        await getRun(
          child,
          accountFor(accounts, 'childB').id,
          state.partialRunId,
          'R09 old partial run after restore',
          404,
        );
        await requireJSON(
          await child.request(
            runtimePath(
              accountFor(accounts, 'childA').id,
              state.completedRunId,
              '/actions',
            ),
            {
              method: 'POST',
              body: {
                eventId: 'r09-stale',
                expectedRevision: 0,
                occurrenceId: null,
                type: 'continue',
                payload: {},
              },
            },
          ),
          404,
          'R09 old action after restore',
          'NOT_FOUND',
        );
        await requireJSON(
          await child.request(
            runtimePath(
              accountFor(accounts, 'childA').id,
              state.completedRunId,
              '/progress',
            ),
          ),
          404,
          'R09 old progress after restore',
          'NOT_FOUND',
        );
        const oldRequest = await operator.request(
          packagePath(state.fixture.lessonVersion, '/runtime-verifications'),
          {
            method: 'POST',
            body: {
              requestId: state.completedRequestId,
              contentDigest: state.fixtureDigest,
              childId: accountFor(accounts, 'childA').id,
            },
          },
        );
        await requireJSON(
          oldRequest,
          409,
          'R09 old request ID after restore',
          'EVENT_CONFLICT',
        );
        state.freshRun = await createRun(
          operator,
          state.fixture.lessonVersion,
          {
            requestId: 'r09-fresh-installation',
            contentDigest: state.fixtureDigest,
            childId: accountFor(accounts, 'childA').id,
          },
          'R09 fresh installation run',
        );
        const freshView = await getRun(
          child,
          accountFor(accounts, 'childA').id,
          state.freshRun.runId,
          'R09 fresh run view',
        );
        requireCondition(
          freshView.run.runId === state.freshRun.runId,
          'R09 fresh run is not readable',
        );
        await postAction(
          child,
          accountFor(accounts, 'childA').id,
          state.freshRun.runId,
          {
            eventId: 'r09-fresh-intro',
            expectedRevision: freshView.run.revision,
            occurrenceId: null,
            type: 'continue',
            payload: {},
          },
          'R09 fresh run action',
        );
        await requireJSON(
          await parent.request(
            runtimePath(
              accountFor(accounts, 'childA').id,
              state.freshRun.runId,
              '/progress',
            ),
          ),
          200,
          'R09 parent fresh progress',
        );
        await requireJSON(
          await teacher.request(
            runtimePath(
              accountFor(accounts, 'childA').id,
              state.freshRun.runId,
              '/progress',
            ),
          ),
          200,
          'R09 teacher fresh progress',
        );
        state.destination = { ...destination, freshView };
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R09-03-ordering-and-repeat-recovery',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore && state.destination,
          'R09 restore state',
        );
        const variant = await context.writeBackupVariant(state.backupId, {
          kind: 'row-order',
        });
        const orderedDestination = await context.createDestination({
          format: 'v3',
        });
        const orderedRestored = await context.restore({
          backupId: variant,
          destinationId: orderedDestination.id,
        });
        requireCondition(
          orderedRestored?.format === FORMAT_V3,
          'R09 row-order restore returned wrong format',
        );
        const orderedAfter = await context.inspect(orderedDestination.id);
        requireV3Snapshot(orderedAfter, 'R09 row-order destination');
        requireCondition(
          tableDigest(orderedAfter.tables) ===
            tableDigest(state.sourceBefore.tables),
          'R09 row-order restore changed rows',
        );
        const destinationBefore = await context.inspect(state.destination.id);
        // This is now an active source: scenario 02 signed in ordinary users.
        // Their sessions must remain on the source and be omitted from backup.
        requireV3Snapshot(destinationBefore, 'R09 repeat source', {
          sessions: true,
        });
        requireCondition(
          destinationBefore.sessions.length > 0,
          'R09 repeat source lost its ordinary sessions',
        );
        const historicalInstallations = new Set(
          destinationBefore.tables.pilot_curriculum_runtime_run.map(
            (row) => row.installation_id,
          ),
        );
        requireCondition(
          historicalInstallations.size === 2,
          'R09 repeat source omitted an installation history',
        );
        const repeatBackup = await context.backup({
          name: 'r09-repeat-v3',
          sourceId: state.destination.id,
        });
        requireCondition(
          repeatBackup?.summary?.format === FORMAT_V3,
          'R09 repeat backup returned wrong format',
        );
        const repeatEnvelope = await context.readBackup(repeatBackup.id);
        assertSnapshotEqual(
          destinationBefore,
          await context.inspect(state.destination.id),
          'R09 repeat source after backup',
        );
        requireV3Envelope(
          repeatEnvelope,
          'R09 repeat backup',
          destinationBefore.installationId,
        );
        const repeatDestination = await context.createDestination({
          format: 'v3',
        });
        await context.restore({
          backupId: repeatBackup.id,
          destinationId: repeatDestination.id,
        });
        const repeatAfter = await context.inspect(repeatDestination.id);
        requireV3Snapshot(repeatAfter, 'R09 repeat destination');
        requireCondition(
          tableDigest(repeatAfter.tables) ===
            tableDigest(destinationBefore.tables),
          'R09 repeat restore history changed',
        );
        requireCondition(
          repeatAfter.installationId !== destinationBefore.installationId &&
            !historicalInstallations.has(repeatAfter.installationId),
          'R09 repeat restore reused installation',
        );
        await context.setRuntimeNamespace({
          destinationId: repeatDestination.id,
        });
        const child = new PilotClient(repeatDestination.baseURL);
        await login(
          child,
          accountFor(accounts, 'childA'),
          'R09 repeat child login',
        );
        await getRun(
          child,
          accountFor(accounts, 'childA').id,
          state.completedRunId,
          'R09 historical run after repeat restore',
          404,
        );
        await getRun(
          child,
          accountFor(accounts, 'childA').id,
          state.freshRun.runId,
          'R09 second installation run after repeat restore',
          404,
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R09-04-corrupt-and-populated-refusal',
      async () => {
        requireDependency(
          state.backupId && state.destination,
          'R09 corruption state',
        );
        const destination = await context.createDestination({ format: 'v3' });
        const baseline = await context.inspect(destination.id);
        requireV3Snapshot(baseline, 'R09 corruption baseline', { fresh: true });
        for (const kind of [
          'runtime-run-identity',
          'runtime-run-revision',
          'runtime-request-fingerprint',
          'runtime-event-time',
          'runtime-event-sequence',
          'runtime-event-result',
          'runtime-audit-relation',
          'runtime-audit-time',
          'runtime-missing-event',
          'runtime-schema',
          'unknown-proof',
          'unknown-release',
        ]) {
          const variant = await context.writeBackupVariant(state.backupId, {
            kind,
          });
          await expectRejected(
            () =>
              context.restore({
                backupId: variant,
                destinationId: destination.id,
              }),
            `R09 ${kind} restore`,
          );
          const after = await context.inspect(destination.id);
          assertSnapshotEqual(baseline, after, `R09 ${kind} refusal`);
        }
        const populatedBefore = await context.inspect(state.destination.id);
        await expectRejected(
          () =>
            context.restore({
              backupId: state.backupId,
              destinationId: state.destination.id,
            }),
          'R09 populated destination refusal',
        );
        const populatedAfter = await context.inspect(state.destination.id);
        assertSnapshotEqual(
          populatedBefore,
          populatedAfter,
          'R09 populated destination',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R09-05-runtime-atomic-failures',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'R09 atomic state',
        );
        for (const kind of ['runtime-event', 'runtime-audit']) {
          const destination = await context.createDestination({ format: 'v3' });
          const before = await context.inspect(destination.id);
          requireV3Snapshot(before, `R09 ${kind} baseline`, { fresh: true });
          await context.setRestoreFault({
            destinationId: destination.id,
            kind,
          });
          let restoreError = null;
          try {
            await context.restore({
              backupId: state.backupId,
              destinationId: destination.id,
            });
          } catch (error) {
            restoreError = error;
          }
          requireCondition(
            restoreError,
            `R09 ${kind} restore unexpectedly succeeded`,
          );
          let failed;
          try {
            failed = await context.inspect(destination.id);
          } finally {
            await context.setRestoreFault({
              destinationId: destination.id,
              kind: null,
            });
          }
          assertSnapshotEqual(before, failed, `R09 ${kind} rollback`);
          requireCondition(
            failed.fault.batchObserved === 1 &&
              failed.fault.injected === 1 &&
              failed.fault.committed === 0,
            `R09 ${kind} fault was not observed in batch`,
          );
          await context.restore({
            backupId: state.backupId,
            destinationId: destination.id,
          });
          const retried = await context.inspect(destination.id);
          requireV3Snapshot(retried, `R09 ${kind} retry`);
          requireCondition(
            tableDigest(retried.tables) ===
              tableDigest(state.sourceBefore.tables),
            `R09 ${kind} retry changed rows`,
          );
        }
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R09-06-postcommit-uncertainty',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'R09 postcommit state',
        );
        const destination = await context.createDestination({ format: 'v3' });
        await context.setRestoreFault({
          destinationId: destination.id,
          kind: 'postcommit-read',
        });
        let restoreError = null;
        try {
          await context.restore({
            backupId: state.backupId,
            destinationId: destination.id,
          });
        } catch (error) {
          restoreError = error;
        }
        requireCondition(
          restoreError &&
            (restoreError.code === 'RESTORE_UNCONFIRMED' ||
              String(restoreError.message || '').includes(
                'RESTORE_UNCONFIRMED',
              )),
          'R09 postcommit fault did not preserve uncertainty',
        );
        let after;
        try {
          after = await context.inspect(destination.id);
        } finally {
          await context.setRestoreFault({
            destinationId: destination.id,
            kind: null,
          });
        }
        requireV3Snapshot(after, 'R09 postcommit committed destination');
        requireCondition(
          tableDigest(after.tables) === tableDigest(state.sourceBefore.tables),
          'R09 postcommit rows were lost',
        );
        requireCondition(
          after.fault.batchObserved === 1 &&
            after.fault.injected === 1 &&
            after.fault.committed === 1,
          'R09 postcommit batch counters are wrong',
        );
        await expectRejected(
          () =>
            context.restore({
              backupId: state.backupId,
              destinationId: destination.id,
            }),
          'R09 second restore after uncertainty',
        );
        assertSnapshotEqual(
          after,
          await context.inspect(destination.id),
          'R09 postcommit refusal',
        );
      },
      accounts,
      state.secrets,
    ),
  );

  results.push(
    await runCase(
      'C-R09-07-v1-v2-v3-compatibility',
      async () => {
        requireDependency(state.backupId, 'R09 v3 backup');
        for (const oldFormat of [FORMAT_V1, FORMAT_V2]) {
          const oldName = oldFormat === FORMAT_V1 ? 'v1' : 'v2';
          const oldSource = await context.createDestination({
            format: oldName,
          });
          const oldBackup = await context.backup({
            name: `r09-${oldName}`,
            sourceId: oldSource.id,
          });
          const v3Destination = await context.createDestination({
            format: 'v3',
          });
          const v3Before = await context.inspect(v3Destination.id);
          await expectRejected(
            () =>
              context.restore({
                backupId: oldBackup.id,
                destinationId: v3Destination.id,
              }),
            `${oldName}-to-v3 compatibility`,
            'BACKUP_VERSION_INCOMPATIBLE',
          );
          assertSnapshotEqual(
            v3Before,
            await context.inspect(v3Destination.id),
            `${oldName}-to-v3 refusal`,
          );
          const oldDestination = await context.createDestination({
            format: oldName,
          });
          const oldBefore = await context.inspect(oldDestination.id);
          await expectRejected(
            () =>
              context.restore({
                backupId: state.backupId,
                destinationId: oldDestination.id,
              }),
            `v3-to-${oldName} compatibility`,
            'BACKUP_VERSION_INCOMPATIBLE',
          );
          assertSnapshotEqual(
            oldBefore,
            await context.inspect(oldDestination.id),
            `v3-to-${oldName} refusal`,
          );
        }
      },
      accounts,
      state.secrets,
    ),
  );

  try {
    if (typeof context.setSourceClock === 'function')
      await context.setSourceClock(null);
    if (typeof context.setRestoreFault === 'function' && state.destination?.id)
      await context.setRestoreFault({
        destinationId: state.destination?.id,
        kind: null,
      });
  } catch {
    // Scenario results remain authoritative; the runner owns final cleanup.
  }
  return results;
}
