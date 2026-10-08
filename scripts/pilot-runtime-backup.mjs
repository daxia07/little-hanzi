import crypto from 'node:crypto';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import {
  compileCurriculumRuntime,
  projectCurriculumProgress,
} from '../lib/curriculum/runtime.ts';

// This module validates historical facts, never current HTTP eligibility.
export const RUNTIME_COLUMNS = {
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
};
export const RUNTIME_TABLES = Object.keys(RUNTIME_COLUMNS);
export const RUNTIME_TRIGGERS = [
  'pilot_curriculum_runtime_run_no_identity_update',
  'pilot_curriculum_runtime_run_no_delete',
  'pilot_curriculum_runtime_event_no_update',
  'pilot_curriculum_runtime_event_no_delete',
  'pilot_curriculum_runtime_audit_no_update',
  'pilot_curriculum_runtime_audit_no_delete',
];

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_CLOCK = 8_640_000_000_000_000;
const INTEGERS = new Set(['revision', 'sequence', 'created_at', 'updated_at']);
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value) =>
  typeof value === 'string' && value.length > 0 && value.isWellFormed();
const slug = (value) => text(value) && ID.test(value);
const integer = (value, minimum = 0) =>
  Number.isSafeInteger(value) && value >= minimum;
const clock = (value) => integer(value) && value <= MAX_CLOCK;
const hash = (value) =>
  `sha256:${crypto.createHash('sha256').update(canonicalPackage(value)).digest('hex')}`;

export function runtimeBackupInvalid() {
  const error = new Error(
    'Pilot backup: BACKUP_RUNTIME_INVALID: runtime backup validation failed',
  );
  error.code = 'BACKUP_RUNTIME_INVALID';
  throw error;
}

function check(condition) {
  if (!condition) runtimeBackupInvalid();
}

function json(value) {
  try {
    const parsed = JSON.parse(value);
    check(record(parsed));
    return parsed;
  } catch {
    runtimeBackupInvalid();
  }
}

function addUnique(set, value) {
  check(!set.has(value));
  set.add(value);
}

/** Structural checks are synchronous so private-file parsing stays compatible. */
export function validateRuntimeRows(payload) {
  const tables = payload.tables;
  for (const table of RUNTIME_TABLES) {
    check(Array.isArray(tables[table]));
    for (const row of tables[table]) {
      check(exact(row, RUNTIME_COLUMNS[table]));
      for (const [key, value] of Object.entries(row)) {
        if (
          table === 'pilot_curriculum_runtime_audit' &&
          key === 'event_id' &&
          value === null
        )
          continue;
        check(INTEGERS.has(key) ? integer(value) : text(value));
        if (key === 'created_at' || key === 'updated_at') check(clock(value));
      }
    }
  }
  const users = new Map(tables.pilot_auth_user.map((row) => [row.id, row]));
  check(users.size === tables.pilot_auth_user.length);
  const packages = new Map(
    tables.pilot_curriculum_package.map((row) => [row.lesson_version, row]),
  );
  const runs = new Map();
  const requestIds = new Set();
  for (const row of tables.pilot_curriculum_runtime_run) {
    check(slug(row.run_id) && slug(row.request_id) && slug(row.lesson_version));
    check(
      row.child_id.length <= 120 &&
        DIGEST.test(row.request_digest) &&
        DIGEST.test(row.content_digest),
    );
    check(!runs.has(row.run_id));
    addUnique(requestIds, row.request_id);
    check(
      row.purpose === 'test-verification' && row.updated_at >= row.created_at,
    );
    check(
      users.get(row.child_id)?.role === 'child' &&
        users.get(row.created_by_user_id)?.role === 'operator',
    );
    const pkg = packages.get(row.lesson_version);
    check(
      pkg &&
        pkg.content_digest === row.content_digest &&
        pkg.test_run_id === row.test_run_id,
    );
    const manifest = json(pkg.manifest_json);
    const expectedIdentity = {
      lessonId: pkg.lesson_id,
      lessonVersion: row.lesson_version,
      contentDigest: row.content_digest,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
    };
    const expectedFingerprint = hash({
      schemaVersion: 's3-runtime-http-request-1',
      lessonVersion: row.lesson_version,
      request: {
        requestId: row.request_id,
        contentDigest: row.content_digest,
        childId: row.child_id,
      },
      actorUserId: row.created_by_user_id,
      installationId: row.installation_id,
      candidateId: row.candidate_id,
      testRunId: row.test_run_id,
    });
    check(row.request_digest === expectedFingerprint);
    const run = json(row.run_json);
    check(
      run.runId === row.run_id &&
        run.revision === row.revision &&
        run.createdAt === row.created_at &&
        run.updatedAt === row.updated_at &&
        exact(run.identity, Object.keys(expectedIdentity)) &&
        Object.entries(expectedIdentity).every(
          ([key, value]) => run.identity[key] === value,
        ),
    );
    runs.set(row.run_id, {
      row: { ...row },
      manifest,
      expectedIdentity,
      run,
      events: [],
      audits: [],
      eventIds: new Set(),
    });
  }
  for (const row of tables.pilot_curriculum_runtime_event) {
    const saved = runs.get(row.run_id);
    check(saved && slug(row.event_id) && integer(row.sequence, 1));
    addUnique(saved.eventIds, row.event_id);
    const event = json(row.event_json);
    check(
      event.runId === row.run_id &&
        event.eventId === row.event_id &&
        event.sequence === row.sequence &&
        event.serverTime === row.created_at,
    );
    saved.events.push(event);
  }
  const auditIds = new Set();
  for (const row of tables.pilot_curriculum_runtime_audit) {
    addUnique(auditIds, row.id);
    const saved = runs.get(row.run_id);
    check(saved && users.has(row.actor_user_id));
    saved.audits.push({ ...row });
  }
  for (const saved of runs.values()) {
    const { row, events, audits } = saved;
    events.sort((a, b) => a.sequence - b.sequence);
    audits.sort((a, b) => a.revision - b.revision);
    check(events.length === row.revision && audits.length === row.revision + 1);
    const creation = audits[0];
    check(
      creation?.revision === 0 &&
        creation.action === 'create' &&
        creation.event_id === null &&
        creation.actor_user_id === row.created_by_user_id &&
        creation.created_at === row.created_at,
    );
    for (let index = 0; index < events.length; index++) {
      const event = events[index],
        audit = audits[index + 1];
      check(
        event.sequence === index + 1 &&
          audit.revision === index + 1 &&
          audit.action === 'action' &&
          audit.event_id === event.eventId &&
          audit.actor_user_id === row.child_id &&
          audit.created_at === event.serverTime,
      );
    }
  }
  return [...runs.values()];
}

/** Replay only inspected copies captured synchronously before the first await. */
export async function validateRuntimeSemantics(entries) {
  const compiled = new Map();
  try {
    for (const saved of entries) {
      const key = saved.expectedIdentity.contentDigest;
      if (!compiled.has(key))
        compiled.set(key, await compileCurriculumRuntime(saved.manifest));
      const lesson = compiled.get(key);
      check(
        Object.entries(saved.expectedIdentity).every(
          ([name, value]) => lesson.identity[name] === value,
        ),
      );
      projectCurriculumProgress(lesson, saved.run, saved.events);
    }
  } catch {
    runtimeBackupInvalid();
  }
}
