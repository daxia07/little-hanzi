/*
 * Sprint 2 local backup/restore probe.
 *
 * The runner owns two real local D1 installations and supplies this context:
 *
 *   source: { baseURL, accounts, testRunId, format? }
 *   backup({ name }) -> { id, summary }
 *   readBackup(id) -> validated private envelope in memory
 *   writeBackupVariant(id, { kind }) -> artifact id
 *   createDestination() -> { id, baseURL }
 *   restore({ backupId, destinationId }) -> sanitized summary
 *   inspect(id = 'source') -> { installationId, tables, sessions, verification }
 *   setRestoreFault(...) is intentionally unnecessary: the foreign-key
 *   variant supplies a late atomic failure without changing the schema.
 *   fingerprintSource() -> a stable source-database digest
 *
 * The runner must throw for rejected backup/restore operations. It must keep
 * private backup contents and credentials out of callback errors and reports.
 * This module compares private rows only in memory and emits generic messages.
 */

import crypto from 'node:crypto';
import { collectionTableNames } from '../scripts/pilot-collection-backup.mjs';
import { COLLECTION_MIGRATIONS } from '../scripts/pilot-collection-schema.mjs';

const FORMAT = 'pilot-admin-backup-1';
const FORMAT_V2 = 'pilot-admin-backup-2';
const FORMAT_V3 = 'pilot-admin-backup-3';
const FORMAT_V4 = 'pilot-admin-backup-4';
const FORMAT_V5 = 'pilot-admin-backup-5';
const TABLES = Object.freeze([
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
const CURRICULUM_TABLES = Object.freeze([
  'pilot_curriculum_registry_state',
  'pilot_curriculum_package',
  'pilot_curriculum_character',
  'pilot_curriculum_review',
  'pilot_curriculum_audit',
]);
const V2_TABLES = Object.freeze([...TABLES, ...CURRICULUM_TABLES]);
const RUNTIME_TABLES = Object.freeze([
  'pilot_curriculum_runtime_run',
  'pilot_curriculum_runtime_event',
  'pilot_curriculum_runtime_audit',
]);
const V3_TABLES = Object.freeze([...V2_TABLES, ...RUNTIME_TABLES]);
const STORY_TABLES = Object.freeze([
  'pilot_curriculum_proof_receipt',
  'pilot_curriculum_owner_decision',
  'pilot_curriculum_publication',
  'pilot_curriculum_trial_member',
  'pilot_curriculum_publication_state',
  'pilot_curriculum_publication_audit',
  'pilot_placement_proposal',
  'pilot_learning_plan',
  'pilot_learning_plan_item',
  'pilot_curriculum_assignment',
  'pilot_learning_schedule',
  'pilot_curriculum_learning_run',
  'pilot_curriculum_learning_event',
  'pilot_curriculum_learning_audit',
]);
const V4_TABLES = Object.freeze([...V3_TABLES, ...STORY_TABLES]);
const V4_MIGRATIONS = Object.freeze([
  '0000-auth.sql',
  '0001-data.sql',
  '0002-learning.sql',
  '0003-curriculum.sql',
  '0004-curriculum-runtime.sql',
  '0005-family-story.sql',
]);
const FORBIDDEN_TABLES = new Set([
  'pilot_installation',
  'pilot_schema_history',
  'pilot_d1_migrations',
  'pilot_auth_session',
  'pilot_auth_verification',
  'attempts',
  'settings',
  'drafts',
]);
const FORBIDDEN_ACCOUNT_COLUMNS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'access_token_expires_at',
  'refresh_token_expires_at',
  'scope',
]);

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireDependency(condition, message) {
  if (!condition) throw new DependencyBlockedError(message);
}

class DependencyBlockedError extends Error {
  constructor(message) {
    super(`BLOCKED: ${message}`);
    this.name = 'DependencyBlockedError';
  }
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

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
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
  requireCondition(object(body), `${label} did not return a JSON object`);
  const forbiddenKey = /(?:password|hash|token|secret|email)/i;
  const forbiddenValue = /@[\w.-]+\.invalid\b/i;
  requireCondition(
    !collectEntries(body).some(
      ({ key, value }) =>
        (forbiddenKey.test(key) &&
          !(key === 'mustChangePassword' && typeof value === 'boolean')) ||
        (typeof value === 'string' && forbiddenValue.test(value)),
    ),
    `${label} returned a private credential field`,
  );
}

function requireNoAnswerKey(body, label) {
  requireCondition(
    !collectEntries(body).some(({ key }) =>
      /^(?:answerKey|correctAnswer|mastery|mastered)$/i.test(key),
    ),
    `${label} returned a private lesson oracle`,
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

function sanitizeMessage(error, accounts) {
  let message =
    error instanceof Error
      ? error.message
      : 'pilot restore integration assertion failed';
  const credentials = Object.values(accounts || {}).flatMap((account) =>
    object(account) ? [account.id, account.username, account.password] : [],
  );
  for (const value of credentials) {
    if (typeof value === 'string' && value.length > 0)
      message = message.split(value).join('[redacted]');
  }
  return message.replace(
    /(password|hash|token|secret|email)[^\s]*/gi,
    '[redacted]',
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function tableRows(snapshot, table, label) {
  requireCondition(
    object(snapshot.tables) && Array.isArray(snapshot.tables[table]),
    `${label} omitted ${table}`,
  );
  return snapshot.tables[table];
}

function tablesFor(format) {
  if (format === FORMAT_V5) return collectionTableNames();
  if (![FORMAT, FORMAT_V2, FORMAT_V3, FORMAT_V4].includes(format))
    throw new Error('Unknown restore oracle format');
  if (format === FORMAT_V4) return V4_TABLES;
  if (format === FORMAT_V3) return V3_TABLES;
  return format === FORMAT_V2 ? V2_TABLES : TABLES;
}

function requireTableSet(snapshot, label, format = FORMAT) {
  requireCondition(
    object(snapshot) && object(snapshot.tables),
    `${label} omitted tables`,
  );
  const names = Object.keys(snapshot.tables).sort();
  requireCondition(
    JSON.stringify(names) === JSON.stringify([...tablesFor(format)].sort()),
    `${label} has an unexpected table set`,
  );
  requireCondition(
    !names.some((name) => FORBIDDEN_TABLES.has(name)),
    `${label} exposed a forbidden table`,
  );
  if ([FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format))
    for (const table of [
      ...RUNTIME_TABLES,
      ...([FORMAT_V4, FORMAT_V5].includes(format) ? STORY_TABLES : []),
      ...(format === FORMAT_V5
        ? collectionTableNames().filter((t) => !V4_TABLES.includes(t))
        : []),
    ])
      requireCondition(
        Array.isArray(snapshot.tables[table]) &&
          snapshot.tables[table].length === 0,
        `${label} unexpectedly populated ${table}`,
      );
  if ([FORMAT_V4, FORMAT_V5].includes(format)) {
    const expectedMigrations =
      format === FORMAT_V5 ? COLLECTION_MIGRATIONS : V4_MIGRATIONS;
    const migrations = snapshot.migrations;
    const recorded = Array.isArray(migrations)
      ? migrations
      : migrations?.applied;
    requireCondition(
      Array.isArray(recorded) &&
        JSON.stringify(recorded.map((row) => row.name)) ===
          JSON.stringify(expectedMigrations),
      `${label} omitted exact ${expectedMigrations.length} migrations for ${format}`,
    );
    if (Array.isArray(migrations))
      requireCondition(
        migrations.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)),
        `${label} omitted migration checksums`,
      );
    else {
      requireCondition(
        Array.isArray(migrations?.history) &&
          migrations.history.length === expectedMigrations.length &&
          migrations.history.every(
            (row) =>
              expectedMigrations.some(
                (name) =>
                  row.version ===
                  name.replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
              ) && /^[a-f0-9]{64}$/.test(row.checksum),
          ),
        `${label} omitted exact checksum history rows for ${format}`,
      );
      const expected = [
        ...tablesFor(format),
        'pilot_installation',
        'pilot_auth_session',
        'pilot_auth_verification',
        'pilot_schema_history',
        'pilot_d1_migrations',
      ].sort();
      requireCondition(
        Array.isArray(snapshot.schemaObjects) &&
          JSON.stringify(
            snapshot.schemaObjects
              .filter((row) => row.type === 'table')
              .map((row) => row.name)
              .sort(),
          ) === JSON.stringify(expected),
        `${label} omitted exact schema tables for ${format}`,
      );
      requireCondition(
        Array.isArray(snapshot.foreignKeyViolations) &&
          snapshot.foreignKeyViolations.length === 0,
        `${label} contains foreign-key violations`,
      );
    }
  }
}
export function assertLegacyRestoreSnapshot(snapshot, format) {
  requireTableSet(snapshot, 'Legacy restore boundary', format);
  return true;
}

function requireEmptyDestination(snapshot, label, format = FORMAT) {
  requireTableSet(snapshot, label, format);
  const importedTables = [FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format)
    ? tablesFor(format).filter(
        (table) => table !== 'pilot_curriculum_registry_state',
      )
    : format === FORMAT_V2
      ? V2_TABLES.filter((table) => table !== 'pilot_curriculum_registry_state')
      : TABLES;
  requireCondition(
    importedTables.every(
      (table) => tableRows(snapshot, table, label).length === 0,
    ),
    `${label} contains imported rows after refusal`,
  );
  if ([FORMAT_V2, FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format)) {
    const state = tableRows(snapshot, 'pilot_curriculum_registry_state', label);
    requireCondition(
      state.length === 1 &&
        state[0]?.id === 1 &&
        state[0]?.revision === 0 &&
        state[0]?.updated_at === 0,
      `${label} did not retain the empty registry baseline`,
    );
  }
  requireCondition(
    Array.isArray(snapshot.sessions) &&
      snapshot.sessions.length === 0 &&
      Array.isArray(snapshot.verification) &&
      snapshot.verification.length === 0,
    `${label} retained sessions or verification records`,
  );
  requireCondition(
    snapshot.restoreGuardExists === false,
    `${label} retained the restore guard table`,
  );
}

function requireEnvelope(envelope, label, format = FORMAT) {
  requireCondition(
    object(envelope) && object(envelope.payload),
    `${label} omitted payload`,
  );
  requireCondition(
    envelope.payload.format === format &&
      typeof envelope.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(envelope.sha256),
    `${label} has an invalid envelope`,
  );
  requireTableSet(envelope.payload, label, format);
  if ([FORMAT_V2, FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format)) {
    requireCondition(
      object(envelope.payload.contentIdentities) &&
        JSON.stringify(
          Object.keys(envelope.payload.contentIdentities).sort(),
        ) === JSON.stringify(['curriculum', 'legacy']) &&
        object(envelope.payload.contentIdentities.legacy) &&
        object(envelope.payload.contentIdentities.curriculum),
      `${label} omitted v2 content identities`,
    );
  }
  if ([FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format)) {
    for (const table of [
      ...RUNTIME_TABLES,
      ...([FORMAT_V4, FORMAT_V5].includes(format) ? STORY_TABLES : []),
      ...(format === FORMAT_V5
        ? collectionTableNames().filter((t) => !V4_TABLES.includes(t))
        : []),
    ])
      requireCondition(
        Array.isArray(envelope.payload.tables[table]) &&
          envelope.payload.tables[table].length === 0,
        `${label} included runtime rows in an R01-R05 fixture`,
      );
  }
  requireCondition(
    !Object.keys(envelope.payload.tables).some((name) =>
      FORBIDDEN_TABLES.has(name),
    ),
    `${label} included forbidden records`,
  );
  for (const row of tableRows(envelope.payload, 'pilot_auth_account', label)) {
    requireCondition(
      !Object.keys(row).some((column) => FORBIDDEN_ACCOUNT_COLUMNS.has(column)),
      `${label} included an OAuth token column`,
    );
  }
}

function requireSummary(summary, label, format = FORMAT) {
  requireCondition(object(summary), `${label} omitted its sanitized summary`);
  requireCondition(
    summary.format === format &&
      typeof summary.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(summary.sha256) &&
      typeof summary.installationId === 'string' &&
      object(summary.counts),
    `${label} returned an invalid sanitized summary`,
  );
}

function assertSnapshotEqual(left, right, label) {
  requireCondition(
    digest(left.tables) === digest(right.tables) &&
      left.installationId === right.installationId &&
      left.sessions.length === right.sessions.length &&
      left.verification.length === right.verification.length &&
      left.restoreGuardExists === right.restoreGuardExists,
    `${label} changed persisted data`,
  );
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]*)/g);
}

class CookieJar {
  #cookies = new Map();

  attach(headers) {
    if (!this.#cookies.size || headers.has('Cookie')) return;
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

  header() {
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

let nextSyntheticIP = 1;

function syntheticIP() {
  const value = nextSyntheticIP;
  nextSyntheticIP = (nextSyntheticIP % 240) + 1;
  return `198.51.100.${value}`;
}

class PilotClient {
  constructor(baseURL) {
    requireCondition(
      typeof baseURL === 'string' && baseURL.length > 0,
      'baseURL is required',
    );
    this.baseURL = baseURL.replace(/\/$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.ipAddress = syntheticIP();
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
    if (!requestHeaders.has('X-Forwarded-For'))
      requestHeaders.set('X-Forwarded-For', this.ipAddress);
    if (!requestHeaders.has('CF-Connecting-IP'))
      requestHeaders.set('CF-Connecting-IP', this.ipAddress);
    if (body !== undefined)
      requestHeaders.set('Content-Type', 'application/json');
    if (origin !== null) requestHeaders.set('Origin', origin);
    this.cookies.attach(requestHeaders);
    const request = { method, headers: requestHeaders, redirect: 'manual' };
    if (body !== undefined) request.body = JSON.stringify(body);
    const response = await fetch(`${this.baseURL}${path}`, request);
    this.cookies.store(response);
    return response;
  }

  cookieHeader() {
    return this.cookies.header();
  }
}

async function login(client, account, label) {
  const response = await client.request('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username: account.username, password: account.password },
  });
  requireCondition(
    response.status >= 200 && response.status < 300,
    `${label} returned HTTP ${response.status}`,
  );
  requireSafeJSON(await jsonBody(response), `${label} response`);
}

function childPath(childID, suffix) {
  return `/api/pilot/children/${encodeURIComponent(childID)}${suffix}`;
}

async function requireJSON(
  response,
  expectedStatus,
  label,
  expectedCode = null,
) {
  requireStatus(response, expectedStatus, label);
  requireNoStore(response, label);
  if (expectedStatus < 200 || expectedStatus >= 300) {
    if (expectedCode) {
      const body = await jsonBody(response);
      requireCondition(
        object(body?.error) &&
          body.error.code === expectedCode &&
          typeof body.error.message === 'string',
        `${label} returned the wrong error code`,
      );
    }
    return null;
  }
  const body = await jsonBody(response);
  requireSafeJSON(body, label);
  return body;
}

async function expectRestoreRejected(restore, backupId, destinationId, label) {
  let rejected = false;
  try {
    await restore({ backupId, destinationId });
  } catch (error) {
    rejected = true;
    requireCondition(
      !/(?:password|hash|token|secret|email)\s*[:=]/i.test(
        error instanceof Error ? error.message : String(error),
      ),
      `${label} exposed private error details`,
    );
  }
  requireCondition(rejected, `${label} unexpectedly succeeded`);
}

async function expectCallbackRejected(action, label) {
  let rejected = false;
  try {
    await action();
  } catch (error) {
    rejected = true;
    const message = error instanceof Error ? error.message : String(error);
    requireCondition(
      !/(?:password|hash|token|secret|email)\s*[:=]/i.test(message),
      `${label} exposed private error details`,
    );
  }
  requireCondition(rejected, `${label} unexpectedly succeeded`);
}

async function runCase(id, action, accounts) {
  try {
    await action();
    return { id, status: 'PASS' };
  } catch (error) {
    return {
      id,
      status: error instanceof DependencyBlockedError ? 'BLOCKED' : 'FAIL',
      message: sanitizeMessage(error, accounts),
    };
  }
}

export async function runPilotRestoreIntegration(context) {
  const {
    source,
    backup,
    readBackup,
    writeBackupVariant,
    createDestination,
    restore,
    inspect,
    fingerprintSource,
  } = context || {};
  const accounts = source?.accounts || {};
  // An absent marker intentionally keeps the existing v1 oracle unchanged.
  const format = source?.format === undefined ? FORMAT : source.format;
  tablesFor(format); // Explicit unsupported profiles refuse, never fall back to legacy V1.
  const requireCurrentTableSet = (snapshot, label) =>
    requireTableSet(snapshot, label, format);
  const requireCurrentEmptyDestination = (snapshot, label) =>
    requireEmptyDestination(snapshot, label, format);
  const requireCurrentEnvelope = (envelope, label) =>
    requireEnvelope(envelope, label, format);
  const requireCurrentSummary = (summary, label) =>
    requireSummary(summary, label, format);
  const state = {
    sourceBefore: null,
    sourceFingerprint: null,
    oldCookie: null,
    backupId: null,
    envelope: null,
    restoredDestination: null,
  };
  const results = [];

  results.push(
    await runCase(
      'R-01-backup-private-learning-evidence',
      async () => {
        requireDependency(
          source && typeof source.baseURL === 'string',
          'source Worker is required',
        );
        requireDependency(
          typeof backup === 'function',
          'backup callback is required',
        );
        requireDependency(
          typeof readBackup === 'function',
          'readBackup callback is required',
        );
        requireDependency(
          typeof inspect === 'function',
          'inspect callback is required',
        );
        requireDependency(
          typeof fingerprintSource === 'function',
          'fingerprintSource callback is required',
        );
        const operator = new PilotClient(source.baseURL);
        const parentA = new PilotClient(source.baseURL);
        await login(
          operator,
          accountFor(accounts, 'operator'),
          'source operator sign-in',
        );
        const link = await operator.request('/api/pilot/links', {
          method: 'POST',
          body: {
            parentId: accountFor(accounts, 'parentA').id,
            childId: accountFor(accounts, 'childA').id,
          },
        });
        requireCondition(
          link.status >= 200 && link.status < 300,
          `source family link returned HTTP ${link.status}`,
        );
        requireNoStore(link, 'source family link');
        await login(
          parentA,
          accountFor(accounts, 'parentA'),
          'source parent A sign-in',
        );
        const grant = await parentA.request('/api/pilot/grants', {
          method: 'POST',
          body: {
            childId: accountFor(accounts, 'childA').id,
            teacherId: accountFor(accounts, 'teacher').id,
          },
        });
        requireCondition(
          grant.status >= 200 && grant.status < 300,
          `source teacher grant returned HTTP ${grant.status}`,
        );
        requireNoStore(grant, 'source teacher grant');
        const onboardingResponse = await parentA.request(
          childPath(accountFor(accounts, 'childA').id, '/onboarding'),
          {
            method: 'PUT',
            body: {
              nickname: "Mina's 林",
              experience: 'new',
              audioReady: false,
            },
          },
        );
        const savedOnboarding = await requireJSON(
          onboardingResponse,
          200,
          'source parent A onboarding save',
        );
        requireCondition(
          savedOnboarding.onboarding?.nickname === "Mina's 林",
          'source onboarding did not preserve the UTF-8 nickname',
        );
        const sourceChild = new PilotClient(source.baseURL);
        await login(
          sourceChild,
          accountFor(accounts, 'childA'),
          'source child A sign-in',
        );
        state.oldCookie = sourceChild.cookieHeader();
        requireCondition(
          state.oldCookie.length > 0,
          'source sign-in did not create a session cookie',
        );
        state.sourceBefore = await inspect('source');
        requireCurrentTableSet(state.sourceBefore, 'source inspection');
        requireCondition(
          tableRows(
            state.sourceBefore,
            'pilot_parent_child',
            'source inspection',
          ).length > 0 &&
            tableRows(
              state.sourceBefore,
              'pilot_teacher_grant',
              'source inspection',
            ).length > 0 &&
            tableRows(
              state.sourceBefore,
              'pilot_learning_run',
              'source inspection',
            ).length > 0 &&
            tableRows(
              state.sourceBefore,
              'pilot_learning_event',
              'source inspection',
            ).length > 0 &&
            tableRows(
              state.sourceBefore,
              'pilot_account_audit',
              'source inspection',
            ).length > 0 &&
            tableRows(
              state.sourceBefore,
              'pilot_learning_audit',
              'source inspection',
            ).length > 0,
          'source lacks linked learning and audit evidence',
        );
        state.sourceFingerprint = await fingerprintSource();
        requireCondition(
          typeof state.sourceFingerprint === 'string',
          'source fingerprint is unavailable',
        );
        const created = await backup({ name: 's2-restore-r01' });
        requireCondition(
          object(created) && typeof created.id === 'string',
          'backup did not return an artifact id',
        );
        requireCurrentSummary(created.summary, 'backup');
        requireCondition(
          created.fileMode === 0o600 && created.directoryMode === 0o700,
          'backup private file or directory permissions are unsafe',
        );
        state.backupId = created.id;
        state.envelope = await readBackup(state.backupId);
        requireCurrentEnvelope(state.envelope, 'backup envelope');
        for (const table of [
          'pilot_parent_child',
          'pilot_teacher_grant',
          'pilot_onboarding',
          'pilot_assignment',
          'pilot_run_ownership',
          'pilot_learning_release',
          'pilot_learning_run',
          'pilot_learning_event',
          'pilot_account_audit',
          'pilot_learning_audit',
        ]) {
          requireCondition(
            tableRows(state.envelope.payload, table, 'backup envelope').length >
              0,
            `backup omitted ${table} evidence`,
          );
        }
        await expectCallbackRejected(
          () => backup({ name: 's2-restore-r01' }),
          'backup exclusive creation',
        );
        const unchangedEnvelope = await readBackup(state.backupId);
        requireCurrentEnvelope(
          unchangedEnvelope,
          'backup after duplicate attempt',
        );
        requireCondition(
          unchangedEnvelope.sha256 === state.envelope.sha256,
          'duplicate backup attempt changed the original artifact',
        );
        requireCondition(
          digest(state.envelope.payload.tables) ===
            digest(state.sourceBefore.tables),
          'backup rows differ from the source snapshot',
        );
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'R-02-restore-fresh-destination-and-invalidate-session',
      async () => {
        requireDependency(
          state.backupId !== null,
          'R-01 backup was not created',
        );
        requireDependency(
          typeof createDestination === 'function',
          'createDestination callback is required',
        );
        requireDependency(
          typeof restore === 'function',
          'restore callback is required',
        );
        requireDependency(
          typeof inspect === 'function',
          'inspect callback is required',
        );
        requireDependency(
          typeof state.oldCookie === 'string' && state.oldCookie.length > 0,
          'R-01 pre-restore session was not captured',
        );
        const oldCookie = state.oldCookie;
        requireCondition(
          oldCookie.length > 0,
          'source sign-in did not create a session cookie',
        );
        const destination = await createDestination();
        requireCondition(
          object(destination) &&
            typeof destination.id === 'string' &&
            typeof destination.baseURL === 'string',
          'destination is incomplete',
        );
        const restored = await restore({
          backupId: state.backupId,
          destinationId: destination.id,
        });
        requireCurrentSummary(restored, 'restore');
        requireCondition(
          restored.installationId !== state.sourceBefore.installationId,
          'restore reused the source installation ID',
        );
        const after = await inspect(destination.id);
        requireCurrentTableSet(after, 'restored destination');
        requireCondition(
          digest(after.tables) === digest(state.sourceBefore.tables) &&
            after.installationId === restored.installationId,
          'restored rows or installation identity differ from the source contract',
        );
        requireCondition(
          Array.isArray(after.sessions) &&
            after.sessions.length === 0 &&
            Array.isArray(after.verification) &&
            after.verification.length === 0 &&
            after.restoreGuardExists === false,
          'restore retained sessions or verification records',
        );
        const replay = new PilotClient(destination.baseURL);
        const replayResponse = await replay.request('/api/pilot/me', {
          headers: { Cookie: oldCookie },
        });
        await requireJSON(
          replayResponse,
          401,
          'pre-restore session replay',
          'UNAUTHORIZED',
        );
        const freshChild = new PilotClient(destination.baseURL);
        await login(
          freshChild,
          accountFor(accounts, 'childA'),
          'restored child A sign-in',
        );
        const me = await requireJSON(
          await freshChild.request('/api/pilot/me'),
          200,
          'restored child A account read',
        );
        requireCondition(
          me.installationId === after.installationId &&
            me.user?.id === accountFor(accounts, 'childA').id,
          'restored sign-in used the wrong installation or account',
        );
        state.restoredDestination = { ...destination, freshChild };
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'R-03-restore-family-boundaries-and-synthetic-release',
      async () => {
        requireDependency(
          state.restoredDestination,
          'R-02 destination was not restored',
        );
        const destination = state.restoredDestination;
        const parentA = new PilotClient(destination.baseURL);
        const parentB = new PilotClient(destination.baseURL);
        const teacher = new PilotClient(destination.baseURL);
        await login(
          parentA,
          accountFor(accounts, 'parentA'),
          'restored parent A sign-in',
        );
        await login(
          parentB,
          accountFor(accounts, 'parentB'),
          'restored parent B sign-in',
        );
        await login(
          teacher,
          accountFor(accounts, 'teacher'),
          'restored teacher sign-in',
        );
        const parentMe = await requireJSON(
          await parentA.request('/api/pilot/me'),
          200,
          'restored parent A account read',
        );
        requireCondition(
          Array.isArray(parentMe.children) &&
            parentMe.children.length === 1 &&
            parentMe.children[0]?.id === accountFor(accounts, 'childA').id,
          'parent A received another family child',
        );
        const lessonList = await requireJSON(
          await parentA.request(
            childPath(accountFor(accounts, 'childA').id, '/assignments'),
          ),
          200,
          'restored parent A assignments',
        );
        const lesson = lessonList.availableLessons?.find(
          (item) => item?.lessonVersion === 'forest-01-v1',
        );
        requireCondition(
          lesson?.releaseState === 'test-fixture',
          'restored synthetic release became owner-approved or disappeared',
        );
        const parentProgress = await requireJSON(
          await parentA.request(
            childPath(accountFor(accounts, 'childA').id, '/progress'),
          ),
          200,
          'restored parent A progress',
        );
        const teacherProgress = await requireJSON(
          await teacher.request(
            childPath(accountFor(accounts, 'childA').id, '/progress'),
          ),
          200,
          'restored teacher progress',
        );
        requireNoAnswerKey(parentProgress, 'restored parent A progress');
        requireNoAnswerKey(teacherProgress, 'restored teacher progress');
        const ownFamily = await requireJSON(
          await parentB.request(
            childPath(accountFor(accounts, 'childB').id, '/progress'),
          ),
          200,
          'restored parent B own progress',
        );
        requireNoAnswerKey(ownFamily, 'restored parent B own progress');
        await requireJSON(
          await parentB.request(
            childPath(accountFor(accounts, 'childA').id, '/progress'),
          ),
          404,
          'cross-family progress read',
          'NOT_FOUND',
        );
        const exportResponse = await parentA.request(
          childPath(accountFor(accounts, 'childA').id, '/export'),
        );
        const exported = await requireJSON(
          exportResponse,
          200,
          'restored parent A export',
        );
        requireCondition(
          exported.schemaVersion === 'pilot-learning-export-1' &&
            exported.child?.id === accountFor(accounts, 'childA').id,
          'restored export has the wrong schema or child',
        );
        requireNoAnswerKey(exported, 'restored parent A export');
        requireCondition(
          !JSON.stringify(exported).includes(accountFor(accounts, 'childB').id),
          'restored parent A export contains another family child',
        );
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'R-04-reject-corrupt-or-incompatible-backups-before-import',
      async () => {
        requireDependency(
          state.backupId !== null,
          'R-01 backup was not created',
        );
        requireDependency(
          typeof writeBackupVariant === 'function',
          'writeBackupVariant callback is required',
        );
        requireDependency(
          typeof createDestination === 'function',
          'createDestination callback is required',
        );
        requireDependency(
          typeof restore === 'function',
          'restore callback is required',
        );
        requireDependency(
          typeof inspect === 'function',
          'inspect callback is required',
        );
        const destination = await createDestination();
        requireCondition(
          object(destination) && typeof destination.id === 'string',
          'R-04 destination is incomplete',
        );
        const before = await inspect(destination.id);
        requireCurrentEmptyDestination(before, 'R-04 fresh destination');
        for (const kind of [
          'checksum',
          'migration',
          'schema',
          'content',
          'provider',
          'json',
          'value-type',
          'release-digest',
        ]) {
          const variant = await writeBackupVariant(state.backupId, { kind });
          requireCondition(
            typeof variant === 'string' && variant.length > 0,
            `R-04 ${kind} variant is unavailable`,
          );
          await expectRestoreRejected(
            restore,
            variant,
            destination.id,
            `R-04 ${kind}`,
          );
          const after = await inspect(destination.id);
          requireCurrentEmptyDestination(after, `R-04 ${kind} destination`);
          requireCondition(
            after.installationId === before.installationId,
            `R-04 ${kind} changed the destination installation`,
          );
        }
        requireCondition(
          (await fingerprintSource()) === state.sourceFingerprint,
          'invalid restore attempts changed the source',
        );
      },
      accounts,
    ),
  );

  results.push(
    await runCase(
      'R-05-populated-destination-rollback-and-retry',
      async () => {
        requireDependency(
          state.backupId !== null,
          'R-01 backup was not created',
        );
        requireDependency(
          state.restoredDestination,
          'R-02 destination was not restored',
        );
        requireDependency(
          typeof writeBackupVariant === 'function',
          'writeBackupVariant callback is required',
        );
        requireDependency(
          typeof createDestination === 'function',
          'createDestination callback is required',
        );
        requireDependency(
          typeof restore === 'function',
          'restore callback is required',
        );
        requireDependency(
          typeof inspect === 'function',
          'inspect callback is required',
        );
        const populatedBefore = await inspect(state.restoredDestination.id);
        await expectRestoreRejected(
          restore,
          state.backupId,
          state.restoredDestination.id,
          'R-05 populated destination',
        );
        const populatedAfter = await inspect(state.restoredDestination.id);
        assertSnapshotEqual(
          populatedBefore,
          populatedAfter,
          'populated destination refusal',
        );

        const rollbackDestination = await createDestination();
        requireCondition(
          object(rollbackDestination) &&
            typeof rollbackDestination.id === 'string',
          'R-05 rollback destination is incomplete',
        );
        const emptyBefore = await inspect(rollbackDestination.id);
        requireCurrentEmptyDestination(
          emptyBefore,
          'R-05 rollback destination',
        );
        const foreignKeyVariant = await writeBackupVariant(state.backupId, {
          kind: 'foreign-key',
        });
        await expectRestoreRejected(
          restore,
          foreignKeyVariant,
          rollbackDestination.id,
          'R-05 injected foreign-key failure',
        );
        const emptyAfterFailure = await inspect(rollbackDestination.id);
        requireCurrentEmptyDestination(
          emptyAfterFailure,
          'R-05 rollback destination after failure',
        );
        requireCondition(
          emptyAfterFailure.installationId === emptyBefore.installationId,
          'R-05 failed restore changed the destination installation',
        );
        const rowOrderVariant = await writeBackupVariant(state.backupId, {
          kind: 'row-order',
        });
        await restore({
          backupId: rowOrderVariant,
          destinationId: rollbackDestination.id,
        });
        const retried = await inspect(rollbackDestination.id);
        requireCurrentTableSet(retried, 'R-05 retried destination');
        requireCondition(
          digest(retried.tables) === digest(state.sourceBefore.tables) &&
            retried.installationId === emptyBefore.installationId &&
            retried.restoreGuardExists === false,
          'R-05 retry did not restore the original evidence with a new installation',
        );
        requireCondition(
          (await fingerprintSource()) === state.sourceFingerprint,
          'R-05 restore changed the source',
        );
      },
      accounts,
    ),
  );

  return results;
}
