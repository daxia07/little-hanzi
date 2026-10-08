/*
 * C-R08 populated registry recovery probe.
 *
 * The runner owns real disposable D1 source/destination installations and
 * exposes private backup/fault callbacks.  This probe uses ordinary HTTP for
 * account and registry setup, computes its own content/request digests, and
 * reports only fixed scenario IDs plus sanitized assertion text.
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
const V2_TABLES = Object.freeze([...LEGACY_TABLES, ...REGISTRY_TABLES]);
const RUNTIME_TABLES = Object.freeze([
  'pilot_curriculum_runtime_run',
  'pilot_curriculum_runtime_event',
  'pilot_curriculum_runtime_audit',
]);
const V3_TABLES = Object.freeze([...V2_TABLES, ...RUNTIME_TABLES]);
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
const FORBIDDEN_TABLES = new Set([
  'pilot_installation',
  'pilot_auth_session',
  'pilot_auth_verification',
  'pilot_schema_history',
  'pilot_d1_migrations',
  'pilot_curriculum_runtime_proof',
  'pilot_curriculum_release',
]);
const TOKEN_COLUMNS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'access_token_expires_at',
  'refresh_token_expires_at',
  'scope',
]);
const COLUMNS = Object.freeze({
  pilot_auth_user: [
    'id',
    'name',
    'email',
    'email_verified',
    'image',
    'created_at',
    'updated_at',
    'username',
    'display_username',
    'role',
    'must_change_password',
    'disabled',
  ],
  pilot_auth_account: [
    'id',
    'account_id',
    'provider_id',
    'user_id',
    'password',
    'created_at',
    'updated_at',
  ],
  pilot_auth_rate_limit: ['id', 'key', 'count', 'last_request'],
  pilot_parent_child: ['parent_id', 'child_id', 'created_at', 'created_by'],
  pilot_teacher_grant: [
    'child_id',
    'teacher_id',
    'granting_parent_id',
    'created_at',
  ],
  pilot_account_audit: [
    'id',
    'action',
    'actor_user_id',
    'target_user_id',
    'metadata',
    'created_at',
  ],
  pilot_onboarding: [
    'child_id',
    'nickname',
    'experience',
    'audio_ready',
    'updated_at',
    'updated_by',
  ],
  pilot_assignment: [
    'child_id',
    'lesson_version',
    'status',
    'created_at',
    'created_by',
  ],
  pilot_run_ownership: ['run_id', 'child_id', 'lesson_version', 'created_at'],
  pilot_learning_release: [
    'lesson_version',
    'release_kind',
    'content_digest',
    'reviewer_label',
    'evidence_ref',
    'candidate_id',
    'test_run_id',
    'released_at',
  ],
  pilot_learning_run: [
    'run_id',
    'seed',
    'state_json',
    'revision',
    'created_at',
    'updated_at',
  ],
  pilot_learning_event: [
    'run_id',
    'event_id',
    'sequence',
    'phase',
    'step_id',
    'question_id',
    'type',
    'payload_json',
    'action_json',
    'server_time',
    'first_response',
    'assisted',
    'outcome',
    'ack_json',
  ],
  pilot_learning_audit: [
    'id',
    'action',
    'actor_user_id',
    'child_id',
    'metadata',
    'created_at',
  ],
  pilot_curriculum_registry_state: ['id', 'revision', 'updated_at'],
  pilot_curriculum_package: [
    'lesson_version',
    'lesson_id',
    'content_digest',
    'canonicalization_version',
    'manifest_json',
    'import_id',
    'imported_by_user_id',
    'imported_at',
    'test_run_id',
  ],
  pilot_curriculum_character: [
    'lesson_version',
    'character_id',
    'hanzi',
    'character_index',
  ],
  pilot_curriculum_review: [
    'review_id',
    'lesson_version',
    'content_digest',
    'review_sequence',
    'previous_review_id',
    'decision',
    'reviewer_ref',
    'reviewed_at',
    'checklist_version',
    'checklist_json',
    'evidence_ref',
    'reason',
    'recorded_by_user_id',
    'recorded_at',
    'request_digest',
    'write_id',
    'test_run_id',
  ],
  pilot_curriculum_audit: [
    'id',
    'action',
    'actor_user_id',
    'lesson_version',
    'content_digest',
    'review_id',
    'created_at',
  ],
});
const MIGRATIONS = [
  ['0000-auth.sql', 'pilot-auth-0000'],
  ['0001-data.sql', 'pilot-data-0001'],
  ['0002-learning.sql', 'pilot-learning-0002'],
  ['0003-curriculum.sql', 'pilot-curriculum-0003'],
];
const MIGRATIONS_V3 = [
  ...MIGRATIONS,
  ['0004-curriculum-runtime.sql', 'pilot-curriculum-runtime-0004'],
];
let nextIP = 1;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

async function callback(callback, label, ...args) {
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

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function contentDigest(value) {
  return `sha256:${hashText(canonical(value))}`;
}

function rawHash(value) {
  return hashText(JSON.stringify(value));
}

function clone(value) {
  return structuredClone(value);
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
  return rawHash(normalized);
}

function fixturePackage(version) {
  const value = clone(FIXTURE);
  value.lessonVersion = version;
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
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

function requestDigest(lessonVersion, actorUserId, testRunId, input) {
  return contentDigest({
    schemaVersion: 's3-review-request-1',
    lessonVersion,
    actorUserId,
    testRunId,
    input,
  });
}

function reviewInput({
  requestId,
  contentDigest: digest,
  previousReviewId,
  decision,
  reviewedAt,
}) {
  return {
    requestId,
    contentDigest: digest,
    previousReviewId,
    decision,
    reviewerRef: 'synthetic-curriculum-reviewer',
    reviewedAt,
    checklistVersion: 'hanzi-review-1',
    checklist: {
      scriptAndGlyphs: true,
      mandarinAndReadings: true,
      wordContexts: true,
      teachingAndChecks: true,
      ageSuitability: true,
      sourcesAndLicenses: true,
      deviceAudio: true,
    },
    evidenceRef: 'synthetic-test-only/curriculum-restore',
    reason: 'Synthetic fixture decision for recovery rehearsal',
  };
}

function reviewSecrets(inputs) {
  return Object.values(inputs).flatMap((input) =>
    Object.values(input).filter((value) => typeof value === 'string'),
  );
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
    if (this.#cookies.size) headers.set('Cookie', this.header());
  }

  header() {
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

class PilotClient {
  constructor(baseURL) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.ip = `198.51.100.${nextIP++}`;
    this.cookies = new CookieJar();
  }

  async request(
    path,
    { method = 'GET', body, headers = {}, origin = this.origin } = {},
  ) {
    const requestHeaders = new Headers({
      Accept: 'application/json',
      Connection: 'close',
      ...headers,
    });
    requestHeaders.set('X-Forwarded-For', this.ip);
    requestHeaders.set('CF-Connecting-IP', this.ip);
    if (body !== undefined)
      requestHeaders.set('Content-Type', 'application/json');
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

async function expectJSON(response, status, label) {
  requireCondition(
    response.status === status,
    `${label} returned HTTP ${response.status}`,
  );
  requireCondition(
    /(?:^|,\s*)no-store(?:\s*,|$)/i.test(
      response.headers.get('cache-control') || '',
    ),
    `${label} omitted no-store`,
  );
  const body = bodyData(await jsonBody(response));
  requireCondition(object(body), `${label} did not return an object`);
  return body;
}

async function expectSuccess(response, label) {
  requireCondition(
    response.status >= 200 && response.status < 300,
    `${label} returned HTTP ${response.status}`,
  );
  requireCondition(
    /(?:^|,\s*)no-store(?:\s*,|$)/i.test(
      response.headers.get('cache-control') || '',
    ),
    `${label} omitted no-store`,
  );
  const body = bodyData(await jsonBody(response));
  requireCondition(object(body), `${label} did not return an object`);
  requireSafeBody(body, label);
  return body;
}

function requireSafeBody(body, label) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/password|hash|token|secret/i.test(key)) {
        requireCondition(
          key === 'mustChangePassword' && typeof child === 'boolean',
          `${label} exposed a credential field`,
        );
      }
      visit(child);
    }
  };
  visit(body);
}

async function login(client, account, label) {
  const body = await expectJSON(
    await client.request('/api/auth/sign-in/username', {
      method: 'POST',
      body: { username: account.username, password: account.password },
    }),
    200,
    label,
  );
  requireSafeBody(body, label);
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

function rows(snapshot, table, label) {
  requireCondition(
    object(snapshot?.tables) && Array.isArray(snapshot.tables[table]),
    `${label} omitted ${table}`,
  );
  return snapshot.tables[table];
}

function tablesFor(format) {
  return format === FORMAT_V3 ? V3_TABLES : V2_TABLES;
}

function columnsFor(table) {
  return COLUMNS[table] || RUNTIME_COLUMNS[table];
}

function requireSnapshot(
  snapshot,
  label,
  fresh = false,
  allowSessions = false,
  format = FORMAT_V2,
) {
  requireDependency(object(snapshot), `${label} inspection is unavailable`);
  requireDependency(
    typeof snapshot.installationId === 'string',
    `${label} installation identity is unavailable`,
  );
  requireDependency(
    object(snapshot.tables),
    `${label} table inspection is unavailable`,
  );
  requireDependency(
    Array.isArray(snapshot.schemaObjects),
    `${label} schema inspection is unavailable`,
  );
  requireDependency(
    object(snapshot.fault),
    `${label} fault inspection is unavailable`,
  );
  const actual = Object.keys(snapshot.tables).sort();
  const expectedTables = tablesFor(format);
  requireCondition(
    JSON.stringify(actual) === JSON.stringify([...expectedTables].sort()),
    `${label} did not expose exactly ${expectedTables.length} tables`,
  );
  requireCondition(
    !actual.some((table) => FORBIDDEN_TABLES.has(table)),
    `${label} exposed a forbidden table`,
  );
  for (const table of expectedTables) {
    requireCondition(
      Array.isArray(snapshot.tables[table]),
      `${label} ${table} is not a row array`,
    );
    for (const row of snapshot.tables[table]) {
      requireCondition(object(row), `${label} has an invalid ${table} row`);
      const keys = Object.keys(row).sort();
      requireCondition(
        JSON.stringify(keys) ===
          JSON.stringify(
            [...columnsFor(table)].sort((a, b) => a.localeCompare(b)),
          ),
        `${label} has an unexpected ${table} column set`,
      );
      requireCondition(
        !keys.some((key) => TOKEN_COLUMNS.has(key)),
        `${label} exposed an OAuth token column`,
      );
    }
  }
  requireCondition(
    Array.isArray(snapshot.sessions) &&
      (allowSessions || snapshot.sessions.length === 0),
    `${label} retained unexpected sessions`,
  );
  requireCondition(
    Array.isArray(snapshot.verification) && snapshot.verification.length === 0,
    `${label} retained verification rows`,
  );
  const schemaNames = snapshot.schemaObjects
    .map((item) => item?.name)
    .filter((name) => typeof name === 'string');
  requireCondition(
    !schemaNames.some((name) =>
      /pilot_restore_guard|pilot_restore_fault|runtime_proof|curriculum_release/.test(
        name,
      ),
    ),
    `${label} exposed restore or future release schema`,
  );
  requireCondition(
    snapshot.restoreGuardExists === false,
    `${label} retained restore guard`,
  );
  if (format === FORMAT_V3)
    for (const table of RUNTIME_TABLES)
      requireCondition(
        rows(snapshot, table, label).length === 0,
        `${label} unexpectedly populated ${table}`,
      );
  if (fresh) {
    for (const table of expectedTables.filter(
      (table) => table !== 'pilot_curriculum_registry_state',
    ))
      requireCondition(
        rows(snapshot, table, label).length === 0,
        `${label} is not empty`,
      );
    const state = rows(snapshot, 'pilot_curriculum_registry_state', label);
    requireCondition(
      state.length === 1 &&
        state[0].id === 1 &&
        state[0].revision === 0 &&
        state[0].updated_at === 0,
      `${label} registry baseline is not empty`,
    );
  }
}

function requireEnvelope(
  envelope,
  label,
  sourceInstallationId,
  fixtureVersion,
  format = FORMAT_V2,
) {
  requireCondition(object(envelope), `${label} is unavailable`);
  requireCondition(
    JSON.stringify(Object.keys(envelope).sort()) ===
      JSON.stringify(['payload', 'sha256']),
    `${label} has an invalid outer shape`,
  );
  requireCondition(
    /^[a-f0-9]{64}$/.test(envelope.sha256) &&
      envelope.sha256 === rawHash(envelope.payload),
    `${label} checksum is not canonical`,
  );
  const payload = envelope.payload;
  requireCondition(
    object(payload) && payload.format === format,
    `${label} is not a ${format} envelope`,
  );
  requireCondition(
    JSON.stringify(Object.keys(payload).sort()) ===
      JSON.stringify([
        'candidateId',
        'contentIdentities',
        'createdAt',
        'format',
        'migrations',
        'schema',
        'schemaDigest',
        'sourceInstallationId',
        'tables',
      ]),
    `${label} has an invalid payload shape`,
  );
  requireCondition(
    payload.sourceInstallationId === sourceInstallationId &&
      typeof payload.createdAt === 'string' &&
      typeof payload.candidateId === 'string',
    `${label} has invalid source metadata`,
  );
  requireCondition(
    JSON.stringify(
      payload.migrations.map((item) => [item.name, item.version]),
    ) === JSON.stringify(format === FORMAT_V3 ? MIGRATIONS_V3 : MIGRATIONS),
    `${label} migration set is not the expected candidate set`,
  );
  requireCondition(
    Array.isArray(payload.schema) &&
      payload.schemaDigest === rawHash(payload.schema),
    `${label} schema digest is not independent`,
  );
  requireCondition(
    object(payload.contentIdentities) &&
      JSON.stringify(Object.keys(payload.contentIdentities).sort()) ===
        JSON.stringify(['curriculum', 'legacy']),
    `${label} content identity namespaces are wrong`,
  );
  requireCondition(object(payload.tables), `${label} omitted table rows`);
  requireCondition(
    JSON.stringify(Object.keys(payload.tables).sort()) ===
      JSON.stringify([...tablesFor(format)].sort()),
    `${label} does not contain the expected table arrays`,
  );
  for (const table of tablesFor(format)) {
    requireCondition(
      Array.isArray(payload.tables[table]),
      `${label} omitted ${table}`,
    );
    for (const row of payload.tables[table]) {
      const keys = Object.keys(row).sort();
      requireCondition(
        JSON.stringify(keys) ===
          JSON.stringify(
            [...columnsFor(table)].sort((a, b) => a.localeCompare(b)),
          ),
        `${label} has an unexpected row shape`,
      );
      requireCondition(
        !keys.some((key) => TOKEN_COLUMNS.has(key)),
        `${label} contains an OAuth token column`,
      );
    }
  }
  const curriculum = payload.contentIdentities.curriculum[fixtureVersion];
  requireCondition(
    object(curriculum) &&
      curriculum.canonicalizationVersion === 's3-json-1' &&
      curriculum.digest ===
        payload.tables.pilot_curriculum_package[0]?.content_digest,
    `${label} lost curriculum identity`,
  );
  const legacy = payload.contentIdentities.legacy['forest-01-v1'];
  requireCondition(
    object(legacy) &&
      legacy.algorithm === 's2-json-stringify-sha256-v1' &&
      /^[a-f0-9]{64}$/.test(legacy.digest),
    `${label} lost legacy identity`,
  );
  if (format === FORMAT_V3)
    for (const table of RUNTIME_TABLES)
      requireCondition(
        payload.tables[table].length === 0,
        `${label} included runtime rows in the C-R08 fixture`,
      );
  return payload;
}

function requireRegistryHistory(snapshot, state, label) {
  const packages = rows(snapshot, 'pilot_curriculum_package', label);
  const characters = rows(snapshot, 'pilot_curriculum_character', label);
  const reviews = rows(snapshot, 'pilot_curriculum_review', label).sort(
    (a, b) => a.review_sequence - b.review_sequence,
  );
  const audits = rows(snapshot, 'pilot_curriculum_audit', label);
  const registryState = rows(
    snapshot,
    'pilot_curriculum_registry_state',
    label,
  );
  requireCondition(
    packages.length === 1 &&
      packages[0].lesson_version === state.fixtureVersion,
    `${label} package history is incomplete`,
  );
  const pkg = packages[0];
  requireCondition(
    pkg.content_digest === state.fixtureDigest &&
      pkg.test_run_id === state.testRunId,
    `${label} package identity or fixture namespace changed`,
  );
  const manifest = JSON.parse(pkg.manifest_json);
  requireCondition(
    canonical(manifest) === pkg.manifest_json &&
      contentDigest(manifest) === pkg.content_digest,
    `${label} manifest canonical identity changed`,
  );
  requireCondition(
    characters.length === manifest.characters.length,
    `${label} character index is incomplete`,
  );
  manifest.characters.forEach((character, index) => {
    const row = characters.find((item) => item.character_index === index);
    requireCondition(
      row?.lesson_version === state.fixtureVersion &&
        row.character_id === character.characterId &&
        row.hanzi === character.hanzi,
      `${label} character index changed`,
    );
  });
  requireCondition(
    reviews.length === 2 &&
      reviews[0].review_sequence === 1 &&
      reviews[1].review_sequence === 2 &&
      reviews[0].previous_review_id === null &&
      reviews[1].previous_review_id === reviews[0].review_id,
    `${label} review chain changed`,
  );
  for (const review of reviews) {
    const input = state.reviewInputs[review.review_id];
    requireCondition(
      input &&
        review.lesson_version === state.fixtureVersion &&
        review.content_digest === state.fixtureDigest &&
        review.test_run_id === state.testRunId &&
        review.recorded_by_user_id === state.reviewerId,
      `${label} review attribution changed`,
    );
    requireCondition(
      review.request_digest ===
        requestDigest(
          state.fixtureVersion,
          state.reviewerId,
          state.testRunId,
          input,
        ),
      `${label} review fingerprint changed`,
    );
  }
  requireCondition(
    audits.length === 3 &&
      audits.filter((row) => row.action === 'import').length === 1 &&
      audits.filter((row) => row.action === 'review').length === 2,
    `${label} import/review audits are incomplete`,
  );
  requireCondition(
    audits.every(
      (row) =>
        row.lesson_version === state.fixtureVersion &&
        row.content_digest === state.fixtureDigest,
    ),
    `${label} audit identity changed`,
  );
  requireCondition(
    registryState.length === 1 &&
      registryState[0].id === 1 &&
      registryState[0].revision === 3,
    `${label} registry revision changed`,
  );
  const reviewer = rows(snapshot, 'pilot_auth_user', label).find(
    (row) => row.id === state.reviewerId,
  );
  requireCondition(
    reviewer?.disabled === 1,
    `${label} disabled reviewer state was not preserved`,
  );
  requireCondition(
    rows(snapshot, 'pilot_account_audit', label).some(
      (row) =>
        row.target_user_id === state.reviewerId &&
        /disable/i.test(String(row.action)),
    ),
    `${label} reviewer disable audit is missing`,
  );
}

function requireRowsEqual(left, right, label) {
  requireCondition(
    tableDigest(left.tables) === tableDigest(right.tables),
    `${label} row sets changed`,
  );
}

function requireFreshUnchanged(before, after, label) {
  requireCondition(
    before.installationId === after.installationId,
    `${label} changed installation identity`,
  );
  requireRowsEqual(before, after, label);
  requireCondition(
    canonical(before.schemaObjects) === canonical(after.schemaObjects),
    `${label} changed schema objects`,
  );
  requireCondition(
    canonical(before.migrations) === canonical(after.migrations),
    `${label} changed migration state`,
  );
  requireCondition(
    canonical(before.sessions) === canonical(after.sessions),
    `${label} changed sessions`,
  );
  requireCondition(
    canonical(before.verification) === canonical(after.verification),
    `${label} changed verification rows`,
  );
  requireCondition(
    after.restoreGuardExists === false,
    `${label} retained restore guard`,
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
    const expectedCode = String(code);
    requireCondition(
      error.code === expectedCode ||
        String(error.message || '').includes(expectedCode),
      `${label} did not return ${expectedCode}`,
    );
  }
}

function sanitizeMessage(error, accounts, secrets = []) {
  let message =
    error instanceof Error
      ? error.message
      : 'curriculum restore assertion failed';
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

export async function runPilotCurriculumRestoreIntegration(context) {
  const source = context?.source;
  const accounts = source?.accounts || {};
  const format = source?.format || FORMAT_V2;
  requireDependency(
    format === FORMAT_V2 || format === FORMAT_V3,
    'C-R08 requires a v2 or v3 source installation',
  );
  const state = {
    fixtureVersion: 'forest-01-cr08-restore-fixture',
    fixtureDigest: null,
    testRunId: source?.testRunId,
    reviewerId: null,
    reviewInputs: {},
    sourceBefore: null,
    sourceFingerprint: null,
    oldCookie: null,
    backupId: null,
    envelope: null,
    freshDestination: null,
  };
  const results = [];

  results.push(
    await runCase(
      'C-R08-01-populated-v2-backup',
      async () => {
        requireDependency(
          typeof source?.baseURL === 'string',
          'source Worker is required',
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
          typeof source.testRunId === 'string' && source.testRunId.length > 0,
          'source fixture namespace is required',
        );
        const reviewer = accountFor(accounts, 'reviewer');
        state.reviewerId = reviewer.id;
        const reviewerClient = new PilotClient(source.baseURL);
        await login(reviewerClient, reviewer, 'reviewer sign-in');
        const operator = new PilotClient(source.baseURL);
        await login(
          operator,
          accountFor(accounts, 'operator'),
          'source operator sign-in',
        );
        await expectSuccess(
          await operator.request('/api/pilot/links', {
            method: 'POST',
            body: {
              parentId: accountFor(accounts, 'parentA').id,
              childId: accountFor(accounts, 'childA').id,
            },
          }),
          'source family link',
        );
        const parentA = new PilotClient(source.baseURL);
        await login(
          parentA,
          accountFor(accounts, 'parentA'),
          'source parent A sign-in',
        );
        await expectSuccess(
          await parentA.request('/api/pilot/grants', {
            method: 'POST',
            body: {
              childId: accountFor(accounts, 'childA').id,
              teacherId: accountFor(accounts, 'teacher').id,
            },
          }),
          'source teacher grant',
        );
        const onboarding = await expectJSON(
          await parentA.request(
            `/api/pilot/children/${encodeURIComponent(accountFor(accounts, 'childA').id)}/onboarding`,
            {
              method: 'PUT',
              body: {
                nickname: "Mina's 林",
                experience: 'new',
                audioReady: false,
              },
            },
          ),
          200,
          'source parent A onboarding save',
        );
        requireCondition(
          onboarding.onboarding?.nickname === "Mina's 林",
          'source onboarding did not preserve the UTF-8 nickname',
        );
        const fixture = fixturePackage(state.fixtureVersion);
        state.fixtureDigest = contentDigest(fixture);
        const imported = await expectJSON(
          await reviewerClient.request('/api/pilot/curriculum', {
            method: 'POST',
            body: { package: fixture },
          }),
          201,
          'curriculum fixture import',
        );
        requireCondition(
          imported.created === true &&
            imported.contentDigest === state.fixtureDigest,
          'curriculum fixture import identity is wrong',
        );
        const baseTime = Date.now() - 1000;
        const approved = reviewInput({
          requestId: 'cr08-approval',
          contentDigest: state.fixtureDigest,
          previousReviewId: null,
          decision: 'approved',
          reviewedAt: baseTime,
        });
        state.reviewInputs[approved.requestId] = approved;
        const approvedBody = await expectJSON(
          await reviewerClient.request(
            `/api/pilot/curriculum/${encodeURIComponent(state.fixtureVersion)}/reviews`,
            { method: 'POST', body: approved },
          ),
          201,
          'curriculum fixture approval',
        );
        requireCondition(
          typeof approvedBody.reviewId === 'string' &&
            approvedBody.created === true,
          'curriculum fixture approval was not recorded',
        );
        state.reviewInputs[approvedBody.reviewId] = approved;
        const rejected = reviewInput({
          requestId: 'cr08-rejection',
          contentDigest: state.fixtureDigest,
          previousReviewId: approvedBody.reviewId,
          decision: 'rejected',
          reviewedAt: baseTime - 1,
        });
        state.reviewInputs[rejected.requestId] = rejected;
        const rejectedBody = await expectJSON(
          await reviewerClient.request(
            `/api/pilot/curriculum/${encodeURIComponent(state.fixtureVersion)}/reviews`,
            { method: 'POST', body: rejected },
          ),
          201,
          'curriculum fixture correction',
        );
        requireCondition(
          typeof rejectedBody.reviewId === 'string' &&
            rejectedBody.created === true,
          'curriculum fixture correction was not recorded',
        );
        state.reviewInputs[rejectedBody.reviewId] = rejected;
        await expectJSON(
          await operator.request(
            `/api/pilot/accounts/${encodeURIComponent(reviewer.id)}/status`,
            { method: 'POST', body: { disabled: true } },
          ),
          200,
          'disable historical reviewer',
        );
        const child = new PilotClient(source.baseURL);
        await login(
          child,
          accountFor(accounts, 'childA'),
          'source child session',
        );
        state.oldCookie = child.cookies.header();
        requireCondition(
          state.oldCookie.length > 0,
          'source cookie was not captured before backup',
        );
        state.sourceBefore = await callback(
          context.inspect,
          'source inspection',
          'source',
        );
        requireSnapshot(state.sourceBefore, 'source', false, true, format);
        requireCondition(
          state.sourceBefore.sessions.length > 0,
          'source lacks the ordinary logged-in session fixture',
        );
        requireRegistryHistory(state.sourceBefore, state, 'source');
        requireCondition(
          rows(state.sourceBefore, 'pilot_parent_child', 'source').length > 0 &&
            rows(state.sourceBefore, 'pilot_teacher_grant', 'source').length >
              0 &&
            rows(state.sourceBefore, 'pilot_learning_run', 'source').length >
              0 &&
            rows(state.sourceBefore, 'pilot_learning_event', 'source').length >
              0 &&
            rows(state.sourceBefore, 'pilot_learning_audit', 'source').length >
              0,
          'legacy learning evidence is incomplete',
        );
        state.sourceFingerprint = await callback(
          context.fingerprintSource,
          'source fingerprint',
        );
        requireDependency(
          typeof state.sourceFingerprint === 'string',
          'source fingerprint is unavailable',
        );
        const created = await context.backup({ name: 'cr08-populated-v2' });
        requireCondition(
          object(created) &&
            typeof created.id === 'string' &&
            object(created.summary),
          'backup did not return a private artifact',
        );
        requireCondition(
          created.fileMode === 0o600 && created.directoryMode === 0o700,
          'backup private modes are unsafe',
        );
        state.backupId = created.id;
        state.envelope = await context.readBackup(state.backupId);
        const payload = requireEnvelope(
          state.envelope,
          'v2 backup',
          state.sourceBefore.installationId,
          state.fixtureVersion,
          format,
        );
        requireCondition(
          payload.tables.pilot_curriculum_review.length === 2 &&
            payload.tables.pilot_curriculum_audit.length === 3,
          'backup omitted linked review history',
        );
        requireCondition(
          tableDigest(payload.tables) ===
            tableDigest(state.sourceBefore.tables),
          'backup rows differ from source',
        );
        const after = await callback(
          context.inspect,
          'source inspection after backup',
          'source',
        );
        requireRowsEqual(state.sourceBefore, after, 'backup source');
        requireCondition(
          (await callback(
            context.fingerprintSource,
            'source fingerprint after backup',
          )) === state.sourceFingerprint,
          'backup changed source fingerprint',
        );
        await expectRejected(
          () => context.backup({ name: 'cr08-populated-v2' }),
          'exclusive backup creation',
        );
        const unchanged = await context.readBackup(state.backupId);
        requireCondition(
          unchanged.sha256 === state.envelope.sha256,
          'duplicate backup changed original artifact',
        );
      },
      accounts,
      [state.fixtureVersion, ...reviewSecrets(state.reviewInputs)],
    ),
  );

  results.push(
    await runCase(
      'C-R08-02-restore-fresh-v2-and-ordinary-access',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore && state.fixtureDigest,
          'C-R08-01 backup state',
        );
        requireDependency(
          typeof context?.createDestination === 'function' &&
            typeof context?.restore === 'function',
          'destination callbacks are required',
        );
        const destination = await context.createDestination({
          format: format === FORMAT_V3 ? 'v3' : 'v2',
        });
        requireCondition(
          object(destination) &&
            typeof destination.id === 'string' &&
            typeof destination.baseURL === 'string',
          'v2 destination is incomplete',
        );
        const restored = await context.restore({
          backupId: state.backupId,
          destinationId: destination.id,
        });
        requireCondition(
          object(restored) &&
            restored.format === format &&
            restored.installationId !== state.sourceBefore.installationId,
          'fresh v2 restore summary is invalid',
        );
        const after = await callback(
          context.inspect,
          'restored curriculum inspection',
          destination.id,
        );
        requireSnapshot(
          after,
          'restored curriculum destination',
          false,
          false,
          format,
        );
        requireRowsEqual(state.sourceBefore, after, 'fresh v2 restore');
        requireRegistryHistory(after, state, 'restored curriculum');
        const replay = new PilotClient(destination.baseURL);
        await expectJSON(
          await replay.request('/api/pilot/me', {
            headers: { Cookie: state.oldCookie },
          }),
          401,
          'pre-restore source cookie',
        );
        const operator = new PilotClient(destination.baseURL);
        await login(
          operator,
          accountFor(accounts, 'operator'),
          'restored operator sign-in',
        );
        const detail = await expectJSON(
          await operator.request(
            `/api/pilot/curriculum/${encodeURIComponent(state.fixtureVersion)}`,
          ),
          200,
          'restored curriculum detail',
        );
        requireCondition(
          detail.package?.lessonVersion === state.fixtureVersion &&
            detail.contentDigest === state.fixtureDigest &&
            detail.testFixture === true &&
            Array.isArray(detail.reviews) &&
            detail.reviews.length === 2 &&
            detail.reviews[0]?.sequence === 1 &&
            detail.reviews[1]?.sequence === 2,
          'restored operator did not read exact fixture history',
        );
        requireCondition(
          detail.reviews.every((review) => review.testFixture === true),
          'restored review history lost fixture namespace',
        );
        const coverage = await expectJSON(
          await operator.request('/api/pilot/curriculum'),
          200,
          'restored fixture coverage',
        );
        const coverageRow = coverage.packages?.find(
          (item) => item.lessonVersion === state.fixtureVersion,
        );
        requireCondition(
          coverageRow?.testFixture === true &&
            coverageRow.reviewState === 'test-fixture' &&
            coverage.releaseProof?.available === false &&
            coverage.counts?.reviewedReadyDistinct === 0,
          'restored fixture contributed trusted coverage',
        );
        const disabled = new PilotClient(destination.baseURL);
        const disabledSignIn = await disabled.request(
          '/api/auth/sign-in/username',
          {
            method: 'POST',
            body: {
              username: accountFor(accounts, 'reviewer').username,
              password: accountFor(accounts, 'reviewer').password,
            },
          },
        );
        await expectJSON(disabledSignIn, 401, 'disabled reviewer sign-in');
        state.freshDestination = destination;
      },
      accounts,
      [state.fixtureVersion],
    ),
  );

  results.push(
    await runCase(
      'C-R08-03-reversed-row-order-restore',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'C-R08-01 backup state',
        );
        requireDependency(
          typeof context?.writeBackupVariant === 'function' &&
            typeof context?.createDestination === 'function' &&
            typeof context?.restore === 'function',
          'row-order restore callbacks are required',
        );
        const variant = await context.writeBackupVariant(state.backupId, {
          kind: 'row-order',
        });
        const destination = await context.createDestination({
          format: format === FORMAT_V3 ? 'v3' : 'v2',
        });
        const restored = await context.restore({
          backupId: variant,
          destinationId: destination.id,
        });
        requireCondition(
          restored.format === format,
          'row-order restore returned the wrong format',
        );
        const after = await callback(
          context.inspect,
          'row-order destination inspection',
          destination.id,
        );
        requireSnapshot(after, 'row-order destination', false, false, format);
        requireRowsEqual(state.sourceBefore, after, 'row-order restore');
        requireRegistryHistory(after, state, 'row-order destination');
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'C-R08-04-corruption-and-populated-destination-refusal',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'C-R08-01 backup state',
        );
        requireDependency(
          typeof context?.writeBackupVariant === 'function' &&
            typeof context?.createDestination === 'function' &&
            typeof context?.restore === 'function',
          'corruption restore callbacks are required',
        );
        const destination = await context.createDestination({
          format: format === FORMAT_V3 ? 'v3' : 'v2',
        });
        const baseline = await callback(
          context.inspect,
          'corruption baseline inspection',
          destination.id,
        );
        requireSnapshot(baseline, 'corruption baseline', true, false, format);
        for (const kind of [
          'malformed-json',
          'manifest',
          'review-chain',
          'audit-time',
          'revision',
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
            `${kind} restore`,
          );
          const after = await callback(
            context.inspect,
            `${kind} refusal inspection`,
            destination.id,
          );
          requireSnapshot(after, `${kind} refusal`, true, false, format);
          requireFreshUnchanged(baseline, after, `${kind} refusal`);
        }
        requireDependency(
          state.freshDestination,
          'populated destination from C-R08-02',
        );
        const beforePopulated = await callback(
          context.inspect,
          'populated destination before refusal',
          state.freshDestination.id,
        );
        await expectRejected(
          () =>
            context.restore({
              backupId: state.backupId,
              destinationId: state.freshDestination.id,
            }),
          'populated destination restore',
        );
        const afterPopulated = await callback(
          context.inspect,
          'populated destination after refusal',
          state.freshDestination.id,
        );
        requireFreshUnchanged(
          beforePopulated,
          afterPopulated,
          'populated destination refusal',
        );
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'C-R08-05-curriculum-audit-fault-rolls-back-and-retries',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'C-R08-01 backup state',
        );
        requireDependency(
          typeof context?.createDestination === 'function' &&
            typeof context?.setRestoreFault === 'function' &&
            typeof context?.restore === 'function',
          'audit fault callbacks are required',
        );
        const destination = await context.createDestination({
          format: format === FORMAT_V3 ? 'v3' : 'v2',
        });
        const before = await callback(
          context.inspect,
          'audit fault baseline inspection',
          destination.id,
        );
        requireSnapshot(before, 'audit fault baseline', true, false, format);
        let restoreError = null;
        let failed = null;
        await callback(context.setRestoreFault, 'audit fault enable', {
          destinationId: destination.id,
          kind: 'curriculum-audit',
        });
        try {
          await context.restore({
            backupId: state.backupId,
            destinationId: destination.id,
          });
        } catch (error) {
          restoreError = error;
        } finally {
          try {
            failed = await callback(
              context.inspect,
              'audit fault rollback inspection',
              destination.id,
            );
          } finally {
            await callback(context.setRestoreFault, 'audit fault disable', {
              destinationId: destination.id,
              kind: null,
            });
          }
        }
        requireCondition(
          restoreError,
          'audit fault restore unexpectedly succeeded',
        );
        requireSnapshot(failed, 'audit fault rollback', true, false, format);
        requireFreshUnchanged(before, failed, 'audit fault rollback');
        requireCondition(
          failed.fault.batchObserved === 1 &&
            failed.fault.injected === 1 &&
            failed.fault.committed === 0,
          'audit fault was not observed inside the restore batch',
        );
        const retried = await context.restore({
          backupId: state.backupId,
          destinationId: destination.id,
        });
        requireCondition(
          retried.format === format,
          'audit fault retry returned the wrong format',
        );
        const after = await callback(
          context.inspect,
          'audit fault retry inspection',
          destination.id,
        );
        requireSnapshot(after, 'audit fault retry', false, false, format);
        requireRowsEqual(state.sourceBefore, after, 'audit fault retry');
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'C-R08-06-postcommit-verification-fault-preserves-commit',
      async () => {
        requireDependency(
          state.backupId && state.sourceBefore,
          'C-R08-01 backup state',
        );
        requireDependency(
          typeof context?.createDestination === 'function' &&
            typeof context?.setRestoreFault === 'function' &&
            typeof context?.restore === 'function',
          'postcommit fault callbacks are required',
        );
        const destination = await context.createDestination({
          format: format === FORMAT_V3 ? 'v3' : 'v2',
        });
        await callback(context.setRestoreFault, 'postcommit fault enable', {
          destinationId: destination.id,
          kind: 'postcommit-read',
        });
        let restoreError = null;
        let after = null;
        try {
          await context.restore({
            backupId: state.backupId,
            destinationId: destination.id,
          });
        } catch (error) {
          restoreError = error;
        } finally {
          try {
            after = await callback(
              context.inspect,
              'postcommit fault inspection',
              destination.id,
            );
          } finally {
            await callback(
              context.setRestoreFault,
              'postcommit fault disable',
              {
                destinationId: destination.id,
                kind: null,
              },
            );
          }
        }
        requireCondition(
          restoreError,
          'postcommit fault restore unexpectedly succeeded',
        );
        requireCondition(
          restoreError.code === 'RESTORE_UNCONFIRMED' ||
            String(restoreError.message || '').includes('RESTORE_UNCONFIRMED'),
          'postcommit fault did not return RESTORE_UNCONFIRMED',
        );
        requireSnapshot(
          after,
          'postcommit fault destination',
          false,
          false,
          format,
        );
        requireRowsEqual(
          state.sourceBefore,
          after,
          'postcommit fault committed rows',
        );
        requireCondition(
          after.fault.batchObserved === 1 &&
            after.fault.injected === 1 &&
            after.fault.committed === 1,
          'postcommit fault did not record a committed batch',
        );
        await expectRejected(
          () =>
            context.restore({
              backupId: state.backupId,
              destinationId: destination.id,
            }),
          'second restore after postcommit fault',
        );
        const unchanged = await callback(
          context.inspect,
          'postcommit refusal inspection',
          destination.id,
        );
        requireFreshUnchanged(after, unchanged, 'postcommit refusal');
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'C-R08-07-v1-v2-compatibility-boundary',
      async () => {
        requireDependency(state.backupId, 'C-R08-01 v2 backup');
        requireDependency(
          typeof context?.createDestination === 'function' &&
            typeof context?.backup === 'function' &&
            typeof context?.readBackup === 'function' &&
            typeof context?.restore === 'function',
          'version boundary callbacks are required',
        );
        const legacySource = await context.createDestination({ format: 'v1' });
        requireCondition(
          object(legacySource) && typeof legacySource.id === 'string',
          'legacy D1 schema fixture is unavailable',
        );
        const legacyBackup = await context.backup({
          name: 'cr08-legacy-v1',
          sourceId: legacySource.id,
        });
        requireCondition(
          object(legacyBackup) && typeof legacyBackup.id === 'string',
          'legacy backup fixture was not created',
        );
        const legacyEnvelope = await context.readBackup(legacyBackup.id);
        requireCondition(
          legacyEnvelope?.payload?.format === FORMAT_V1,
          'legacy fixture did not produce a v1 backup',
        );
        const v2Destination = await context.createDestination({ format: 'v2' });
        const v2Before = await callback(
          context.inspect,
          'v1-to-v2 baseline inspection',
          v2Destination.id,
        );
        await expectRejected(
          () =>
            context.restore({
              backupId: legacyBackup.id,
              destinationId: v2Destination.id,
            }),
          'v1-to-v2 restore',
          'BACKUP_VERSION_INCOMPATIBLE',
        );
        const v2After = await callback(
          context.inspect,
          'v1-to-v2 refusal inspection',
          v2Destination.id,
        );
        requireFreshUnchanged(v2Before, v2After, 'v1-to-v2 refusal');
        const v1Destination = await context.createDestination({ format: 'v1' });
        const v1Before = await callback(
          context.inspect,
          'v2-to-v1 baseline inspection',
          v1Destination.id,
        );
        await expectRejected(
          () =>
            context.restore({
              backupId: state.backupId,
              destinationId: v1Destination.id,
            }),
          'v2-to-v1 restore',
          'BACKUP_VERSION_INCOMPATIBLE',
        );
        const v1After = await callback(
          context.inspect,
          'v2-to-v1 refusal inspection',
          v1Destination.id,
        );
        requireFreshUnchanged(v1Before, v1After, 'v2-to-v1 refusal');
        const sourceAfter = await callback(
          context.inspect,
          'source final compatibility inspection',
          'source',
        );
        requireSnapshot(sourceAfter, 'source final', false, true, format);
        requireRowsEqual(
          state.sourceBefore,
          sourceAfter,
          'compatibility source',
        );
        requireCondition(
          (await callback(
            context.fingerprintSource,
            'source final fingerprint',
          )) === state.sourceFingerprint,
          'compatibility attempts changed source fingerprint',
        );
      },
      accounts,
    ),
  );

  return results;
}
