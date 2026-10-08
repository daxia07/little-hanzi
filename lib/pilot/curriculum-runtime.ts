import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import {
  applyCurriculumAction,
  compileCurriculumRuntime,
  createCurriculumRun,
  projectCurriculumProgress,
  projectCurriculumRun,
  CurriculumRuntimeError as EngineRuntimeError,
  type CompiledCurriculumLesson,
  type CurriculumActionResult,
  type CurriculumEvent,
  type CurriculumProgress,
  type CurriculumRun,
  type CurriculumRunView,
} from '../curriculum/runtime.ts';
import { validateCurriculumPackage } from '../curriculum/validate.ts';
import { errorResponse, json } from './http.ts';
import { PilotDbError, type PilotDatabase, type PilotUserRecord } from './db.ts';
import type { PilotRuntimeConfig } from './runtime.ts';

export interface CurriculumRuntimeContext {
  config: PilotRuntimeConfig;
  db: PilotDatabase;
  user: PilotUserRecord;
}

export type CurriculumRuntimeHttpCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'RUNTIME_IDENTITY_MISMATCH'
  | 'RUNTIME_ADAPTER_UNAVAILABLE'
  | 'RUNTIME_PACKAGE_UNSUPPORTED'
  | 'EVENT_CONFLICT'
  | 'STALE_REVISION'
  | 'INVALID_TRANSITION'
  | 'REVIEW_NOT_DUE'
  | 'STORAGE_UNAVAILABLE';

const MESSAGES: Record<CurriculumRuntimeHttpCode, string> = {
  NOT_FOUND: 'The requested curriculum runtime was not found.',
  FORBIDDEN: 'This account cannot access the requested curriculum runtime.',
  INVALID_REQUEST: 'The curriculum request is invalid.',
  PASSWORD_CHANGE_REQUIRED: 'Password change is required before ordinary access.',
  RUNTIME_IDENTITY_MISMATCH: 'The curriculum identity does not match the request.',
  RUNTIME_ADAPTER_UNAVAILABLE: 'The declared curriculum renderer is unavailable.',
  RUNTIME_PACKAGE_UNSUPPORTED: 'The curriculum package is not supported by this runtime.',
  EVENT_CONFLICT: 'The event ID conflicts with an earlier request.',
  STALE_REVISION: 'The curriculum revision is stale.',
  INVALID_TRANSITION: 'The curriculum action is not valid here.',
  REVIEW_NOT_DUE: 'The delayed review is not due yet.',
  STORAGE_UNAVAILABLE: 'The curriculum runtime is temporarily unavailable.',
};

export class CurriculumRuntimeHttpError extends Error {
  readonly code: CurriculumRuntimeHttpCode;
  readonly status: 400 | 403 | 404 | 409 | 503;

  constructor(code: CurriculumRuntimeHttpCode, status?: CurriculumRuntimeHttpError['status']) {
    super(MESSAGES[code]);
    this.name = 'CurriculumRuntimeHttpError';
    this.code = code;
    this.status = status ?? statusFor(code);
  }
}

function statusFor(code: CurriculumRuntimeHttpCode): CurriculumRuntimeHttpError['status'] {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'FORBIDDEN' || code === 'PASSWORD_CHANGE_REQUIRED') return 403;
  if (code === 'INVALID_REQUEST') return 400;
  if (code === 'STORAGE_UNAVAILABLE') return 503;
  return 409;
}

export function curriculumRuntimeErrorResponse(caught: unknown): Response {
  if (caught instanceof CurriculumRuntimeHttpError)
    return errorResponse(caught.code, caught.message, caught.status);
  if (caught instanceof EngineRuntimeError) {
    const mapped = mapEngineError(caught);
    return errorResponse(mapped.code, mapped.message, mapped.status);
  }
  if (caught instanceof PilotDbError && caught.code === 'INVALID_REQUEST')
    return errorResponse('INVALID_REQUEST', MESSAGES.INVALID_REQUEST, 400);
  return errorResponse('STORAGE_UNAVAILABLE', MESSAGES.STORAGE_UNAVAILABLE, 503);
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const MAX_CLOCK = 8_640_000_000_000_000;
const PURPOSE = 'test-verification' as const;
const REQUEST_SCHEMA = 's3-runtime-http-request-1' as const;
const CAPABILITIES = [
  'selection-v1',
  'recognition-v1',
  'delayed-review-v1',
  'progress-export-v1',
] as const;

interface PackageRow {
  lesson_version: string;
  lesson_id: string;
  canonicalization_version: string;
  content_digest: string;
  manifest_json: string;
  test_run_id: string | null;
}

interface InstallationRow { installation_id: string; }

interface RunRow {
  run_id: string;
  request_id: string;
  request_digest: string;
  child_id: string;
  lesson_version: string;
  lesson_id: string;
  canonicalization_version: string;
  content_digest: string;
  adapter_id: string;
  adapter_version: string;
  installation_id: string;
  candidate_id: string;
  test_run_id: string;
  purpose: string;
  created_by_user_id: string;
  run_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
  package_test_run_id: string | null;
  current_installation_id: string;
  manifest_json: string;
  events_json: string;
  audits_json: string;
}

interface ExistingRunRow {
  run_id: string;
  request_id: string;
  request_digest: string;
  child_id: string;
  installation_id: string;
  candidate_id: string;
  test_run_id: string;
}

interface AuditRow {
  id: string;
  run_id: string;
  actor_user_id: string;
  action: string;
  event_id: string | null;
  revision: number;
  created_at: number;
}

interface RuntimeSnapshot {
  row: RunRow;
  lesson: CompiledCurriculumLesson;
  run: CurriculumRun;
  events: CurriculumEvent[];
  audits: AuditRow[];
}

type Access = 'child' | 'parent' | 'teacher' | 'operator';

function fixedError(code: CurriculumRuntimeHttpCode): never {
  throw new CurriculumRuntimeHttpError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringValue(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function digestValue(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function idValue(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function changes(result: D1Result<unknown> | undefined): number {
  const count = (result as { meta?: { changes?: unknown } } | undefined)?.meta?.changes;
  return typeof count === 'number' ? count : Number(count ?? 0);
}

async function first<T>(db: PilotDatabase, query: string, values: unknown[] = []): Promise<T | null> {
  try {
    return await db.prepare(query).bind(...values).first<T>();
  } catch {
    fixedError('STORAGE_UNAVAILABLE');
  }
}

async function executeBatch(db: PilotDatabase, statements: D1PreparedStatement[], options: { rethrowConstraint?: boolean } = {}): Promise<D1Result<unknown>[]> {
  try {
    return await db.batch(statements) as D1Result<unknown>[];
  } catch (caught) {
    if (options.rethrowConstraint && caught instanceof Error && /unique|constraint/i.test(caught.message)) throw caught;
    fixedError('STORAGE_UNAVAILABLE');
  }
}

export function requireCurriculumRuntimeConfig(config: PilotRuntimeConfig): void {
  if (!config.testMode || !config.testContentAllowed || !config.testToken || !config.testRunId || !config.candidateExplicitlyBound || !config.candidateId)
    fixedError('NOT_FOUND');
}

function runtimeNow(config: PilotRuntimeConfig): number {
  const configured = config.curriculumTestNow;
  if (configured === null || configured === '') return Date.now();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(configured)) fixedError('STORAGE_UNAVAILABLE');
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CLOCK) fixedError('STORAGE_UNAVAILABLE');
  return value;
}

function mapEngineError(error: EngineRuntimeError): CurriculumRuntimeHttpError {
  switch (error.code) {
    case 'INVALID_REQUEST': return new CurriculumRuntimeHttpError('INVALID_REQUEST', 400);
    case 'RUNTIME_IDENTITY_MISMATCH': return new CurriculumRuntimeHttpError('RUNTIME_IDENTITY_MISMATCH', 409);
    case 'RUNTIME_ADAPTER_UNAVAILABLE': return new CurriculumRuntimeHttpError('RUNTIME_ADAPTER_UNAVAILABLE', 409);
    case 'RUNTIME_PACKAGE_UNSUPPORTED': return new CurriculumRuntimeHttpError('RUNTIME_PACKAGE_UNSUPPORTED', 409);
    case 'EVENT_CONFLICT': return new CurriculumRuntimeHttpError('EVENT_CONFLICT', 409);
    case 'STALE_REVISION': return new CurriculumRuntimeHttpError('STALE_REVISION', 409);
    case 'INVALID_TRANSITION': return new CurriculumRuntimeHttpError('INVALID_TRANSITION', 409);
    case 'REVIEW_NOT_DUE': return new CurriculumRuntimeHttpError('REVIEW_NOT_DUE', 409);
    default: return new CurriculumRuntimeHttpError('STORAGE_UNAVAILABLE', 503);
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) fixedError('STORAGE_UNAVAILABLE');
  try { return JSON.parse(value); } catch { fixedError('STORAGE_UNAVAILABLE'); }
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function iso(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fixedError('STORAGE_UNAVAILABLE');
  return date.toISOString();
}

interface CurriculumRuntimeCompletion {
  initialCompletedAt: string | null;
  reviewAvailableAt: string | null;
  reviewCompletedAt: string | null;
  reviewPolicyVersion: CurriculumRunView['completion']['reviewPolicyVersion'];
}

type PublicRunView = Omit<CurriculumRunView, 'completion'> & { completion: CurriculumRuntimeCompletion };
type PublicProgress = Omit<CurriculumProgress, 'completion'> & { completion: CurriculumRuntimeCompletion };

function completionIso(completion: CurriculumRunView['completion']): CurriculumRuntimeCompletion {
  return {
    initialCompletedAt: iso(completion.initialCompletedAt),
    reviewAvailableAt: iso(completion.reviewAvailableAt),
    reviewCompletedAt: iso(completion.reviewCompletedAt),
    reviewPolicyVersion: completion.reviewPolicyVersion,
  };
}

function publicRunView(view: CurriculumRunView): PublicRunView {
  return { ...view, completion: completionIso(view.completion) };
}

function publicProgress(progress: CurriculumProgress): PublicProgress {
  return { ...progress, completion: completionIso(progress.completion) };
}

function accessPredicate(access: Access): string {
  if (access === 'child') return `c.role='child' AND c.disabled=0 AND c.must_change_password=0 AND c.id=?`;
  if (access === 'parent') return `EXISTS(
    SELECT 1 FROM pilot_auth_user actor
    JOIN pilot_parent_child link ON link.parent_id=actor.id AND link.child_id=r.child_id
    WHERE actor.id=? AND actor.role='parent' AND actor.disabled=0 AND actor.must_change_password=0
  )`;
  if (access === 'teacher') return `EXISTS(
    SELECT 1 FROM pilot_auth_user actor
    JOIN pilot_teacher_grant grant_row ON grant_row.teacher_id=actor.id AND grant_row.child_id=r.child_id
    JOIN pilot_parent_child link ON link.parent_id=grant_row.granting_parent_id AND link.child_id=grant_row.child_id
    JOIN pilot_auth_user parent ON parent.id=link.parent_id
    WHERE actor.id=? AND actor.role='teacher' AND actor.disabled=0 AND actor.must_change_password=0
      AND parent.role='parent' AND parent.disabled=0
  )`;
  return `EXISTS(
    SELECT 1 FROM pilot_auth_user actor
    WHERE actor.id=? AND actor.role='operator' AND actor.disabled=0 AND actor.must_change_password=0
  ) AND c.role='child' AND c.disabled=0`;
}

function snapshotQuery(access: Access): string {
  return `SELECT
    r.run_id,r.request_id,r.request_digest,r.child_id,r.lesson_version,r.content_digest,
    r.adapter_id,r.adapter_version,r.installation_id,r.candidate_id,r.test_run_id,
    r.purpose,r.created_by_user_id,r.run_json,r.revision,r.created_at,r.updated_at,
    p.lesson_id,p.canonicalization_version,p.manifest_json,p.test_run_id AS package_test_run_id,
    i.installation_id AS current_installation_id,
    COALESCE((SELECT json_group_array(json_object(
      'event_id',e.event_id,'sequence',e.sequence,'created_at',e.created_at,'event_json',json(e.event_json)
    )) FROM (
      SELECT event_id,sequence,created_at,event_json
      FROM pilot_curriculum_runtime_event WHERE run_id=r.run_id ORDER BY sequence
    ) e),'[]') AS events_json,
    COALESCE((SELECT json_group_array(json_object(
      'id',a.id,'run_id',a.run_id,'actor_user_id',a.actor_user_id,'action',a.action,
      'event_id',a.event_id,'revision',a.revision,'created_at',a.created_at
    )) FROM (
      SELECT id,run_id,actor_user_id,action,event_id,revision,created_at
      FROM pilot_curriculum_runtime_audit WHERE run_id=r.run_id ORDER BY revision
    ) a),'[]') AS audits_json
  FROM pilot_curriculum_runtime_run r
  JOIN pilot_curriculum_package p ON p.lesson_version=r.lesson_version AND p.content_digest=r.content_digest
  JOIN pilot_auth_user c ON c.id=r.child_id
  LEFT JOIN pilot_installation i ON i.id=1
  WHERE r.run_id=? AND r.child_id=? AND c.role='child' AND c.disabled=0 AND c.must_change_password=0
    AND (i.installation_id IS NULL OR r.installation_id=i.installation_id)
    AND r.candidate_id=? AND r.test_run_id=?
    AND p.test_run_id=? AND r.purpose=? AND ${accessPredicate(access)}`;
}

async function loadSnapshot(context: CurriculumRuntimeContext, childId: string, runId: string, access: Access): Promise<RuntimeSnapshot | null> {
  requireCurriculumRuntimeConfig(context.config);
  const values = [runId, childId, context.config.candidateId, context.config.testRunId as string, context.config.testRunId as string, PURPOSE, context.user.id];
  const row = await first<RunRow>(context.db, snapshotQuery(access), values);
  if (!row) return null;
  return validateSnapshot(row, context, runtimeNow(context.config));
}

async function validateSnapshot(row: RunRow, context: CurriculumRuntimeContext, now: number): Promise<RuntimeSnapshot> {
  try {
    if (
      row.purpose !== PURPOSE || !stringValue(row.run_id, 160) || !stringValue(row.child_id, 120) ||
      !stringValue(row.lesson_version, 80) || !stringValue(row.lesson_id, 120) || row.canonicalization_version !== 's3-json-1' || !digestValue(row.content_digest) || !digestValue(row.request_digest) ||
      !isSafeInteger(Number(row.revision)) || !isSafeInteger(Number(row.created_at)) || !isSafeInteger(Number(row.updated_at)) ||
      Number(row.updated_at) < Number(row.created_at) || row.installation_id !== row.current_installation_id ||
      row.candidate_id !== context.config.candidateId || row.test_run_id !== context.config.testRunId ||
      row.package_test_run_id !== context.config.testRunId || !stringValue(row.manifest_json, 2_000_000) || !stringValue(row.run_json, 2_000_000)
    ) fixedError('STORAGE_UNAVAILABLE');
    const manifest = parseJson(row.manifest_json);
    if (!validateCurriculumPackage(manifest).ok || canonicalPackage(manifest) !== row.manifest_json || !isRecord(manifest) || manifest.canonicalizationVersion !== row.canonicalization_version) fixedError('STORAGE_UNAVAILABLE');
    if (await curriculumDigest(manifest) !== row.content_digest) fixedError('STORAGE_UNAVAILABLE');
    const lesson = await compileCurriculumRuntime(manifest);
    if (lesson.identity.lessonId !== row.lesson_id || lesson.identity.lessonVersion !== row.lesson_version || lesson.identity.contentDigest !== row.content_digest || lesson.identity.adapterId !== row.adapter_id || lesson.identity.adapterVersion !== row.adapter_version) fixedError('STORAGE_UNAVAILABLE');
    const run = parseJson(row.run_json) as CurriculumRun;
    if (!isRecord(run) || run.runId !== row.run_id || run.revision !== Number(row.revision) || run.createdAt !== Number(row.created_at) || run.updatedAt !== Number(row.updated_at) || run.identity?.lessonId !== row.lesson_id || run.identity?.lessonVersion !== row.lesson_version || run.identity?.contentDigest !== row.content_digest || run.identity?.adapterId !== row.adapter_id || run.identity?.adapterVersion !== row.adapter_version) fixedError('STORAGE_UNAVAILABLE');
    const rawEvents = parseJson(row.events_json), rawAudits = parseJson(row.audits_json);
    if (!Array.isArray(rawEvents) || !Array.isArray(rawAudits) || rawEvents.length !== Number(row.revision) || rawAudits.length !== Number(row.revision) + 1) fixedError('STORAGE_UNAVAILABLE');
    const eventRows = rawEvents as Array<Record<string, unknown>>;
    const events: CurriculumEvent[] = [];
    for (const eventRow of eventRows) {
      if (!isRecord(eventRow) || typeof eventRow.event_id !== 'string' || !isSafeInteger(eventRow.sequence, 1) || !isSafeInteger(eventRow.created_at) || !isRecord(eventRow.event_json)) fixedError('STORAGE_UNAVAILABLE');
      if (eventRow.event_json.eventId !== eventRow.event_id || eventRow.event_json.sequence !== eventRow.sequence || eventRow.event_json.serverTime !== eventRow.created_at) fixedError('STORAGE_UNAVAILABLE');
      events.push(eventRow.event_json as unknown as CurriculumEvent);
    }
    const audits = rawAudits as AuditRow[];
    const eventIDs = new Set<string>();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!isRecord(event) || event.runId !== row.run_id || event.sequence !== index + 1 || typeof event.eventId !== 'string' || eventIDs.has(event.eventId) || !isSafeInteger(event.serverTime)) fixedError('STORAGE_UNAVAILABLE');
      eventIDs.add(event.eventId);
    }
    const auditIDs = new Set<string>();
    const createAudit = audits[0];
    if (!isRecord(createAudit) || typeof createAudit.id !== 'string' || createAudit.action !== 'create' || createAudit.run_id !== row.run_id || createAudit.revision !== 0 || createAudit.event_id !== null || createAudit.actor_user_id !== row.created_by_user_id || createAudit.created_at !== Number(row.created_at)) fixedError('STORAGE_UNAVAILABLE');
    auditIDs.add(createAudit.id);
    for (let index = 1; index < audits.length; index += 1) {
      const audit = audits[index], event = events[index - 1];
      if (!isRecord(audit) || typeof audit.id !== 'string' || auditIDs.has(audit.id) || audit.run_id !== row.run_id || audit.action !== 'action' || audit.revision !== index || audit.event_id !== event.eventId || audit.actor_user_id !== row.child_id || audit.created_at !== event.serverTime) fixedError('STORAGE_UNAVAILABLE');
      auditIDs.add(audit.id);
    }
    // The aggregate query is the snapshot boundary; replay is the semantic
    // check that makes duplicated SQL columns and forged JSON unusable.
    projectCurriculumRun(lesson, run, events, now);
    projectCurriculumProgress(lesson, run, events);
    return { row, lesson, run, events, audits };
  } catch (caught) {
    if (caught instanceof CurriculumRuntimeHttpError) throw caught;
    fixedError('STORAGE_UNAVAILABLE');
  }
}

async function packageRow(context: CurriculumRuntimeContext, version: string): Promise<PackageRow> {
  const row = await first<PackageRow>(context.db, `SELECT lesson_version,lesson_id,content_digest,canonicalization_version,manifest_json,test_run_id
    FROM pilot_curriculum_package WHERE lesson_version=?`, [version]);
  if (!row || row.test_run_id !== context.config.testRunId) fixedError('NOT_FOUND');
  return row;
}

async function installation(context: CurriculumRuntimeContext): Promise<string> {
  const row = await first<InstallationRow>(context.db, 'SELECT installation_id FROM pilot_installation WHERE id=1');
  if (!row || !stringValue(row.installation_id, 240)) fixedError('STORAGE_UNAVAILABLE');
  return row.installation_id;
}

async function childExists(context: CurriculumRuntimeContext, childId: string): Promise<void> {
  const row = await first<{ id: string }>(context.db, `SELECT id FROM pilot_auth_user WHERE id=? AND role='child' AND disabled=0 AND must_change_password=0`, [childId]);
  if (!row) fixedError('NOT_FOUND');
}

async function operatorExists(context: CurriculumRuntimeContext): Promise<void> {
  const row = await first<{ id: string }>(context.db, `SELECT id FROM pilot_auth_user WHERE id=? AND role='operator' AND disabled=0 AND must_change_password=0`, [context.user.id]);
  if (!row) fixedError('FORBIDDEN');
}

async function compilePackage(row: PackageRow): Promise<CompiledCurriculumLesson> {
  try {
    const manifest = parseJson(row.manifest_json);
    if (!validateCurriculumPackage(manifest).ok || canonicalPackage(manifest) !== row.manifest_json || !isRecord(manifest) || manifest.canonicalizationVersion !== row.canonicalization_version) fixedError('STORAGE_UNAVAILABLE');
    const lesson = await compileCurriculumRuntime(manifest);
    if (lesson.identity.contentDigest !== row.content_digest || lesson.identity.lessonVersion !== row.lesson_version || lesson.identity.lessonId !== row.lesson_id) fixedError('STORAGE_UNAVAILABLE');
    if (!CAPABILITIES.every((capability) => lesson.adapter.capabilities.includes(capability))) fixedError('RUNTIME_PACKAGE_UNSUPPORTED');
    return lesson;
  } catch (caught) {
    if (caught instanceof CurriculumRuntimeHttpError) throw caught;
    if (caught instanceof EngineRuntimeError && (caught.code === 'RUNTIME_ADAPTER_UNAVAILABLE' || caught.code === 'RUNTIME_PACKAGE_UNSUPPORTED')) throw mapEngineError(caught);
    throw new CurriculumRuntimeHttpError('STORAGE_UNAVAILABLE', 503);
  }
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0];
}

function randomRunId(): string { return `runtime-${crypto.randomUUID()}`; }

async function requestFingerprint(version: string, input: { requestId: string; contentDigest: string; childId: string }, context: CurriculumRuntimeContext, installationId: string): Promise<string> {
  return curriculumDigest({
    schemaVersion: REQUEST_SCHEMA,
    lessonVersion: version,
    request: input,
    actorUserId: context.user.id,
    installationId,
    candidateId: context.config.candidateId,
    testRunId: context.config.testRunId,
  });
}

function validateCreateInput(value: unknown): { requestId: string; contentDigest: string; childId: string } {
  if (!exactObject(value, ['requestId', 'contentDigest', 'childId'])) fixedError('INVALID_REQUEST');
  if (!idValue(value.requestId) || !digestValue(value.contentDigest) || !stringValue(value.childId, 120)) fixedError('INVALID_REQUEST');
  return { requestId: value.requestId, contentDigest: value.contentDigest, childId: value.childId };
}

function metadata(snapshot: RuntimeSnapshot) {
  return {
    schemaVersion: 's3-runtime-verification-1' as const,
    runId: snapshot.run.runId,
    childId: snapshot.row.child_id,
    identity: snapshot.run.identity,
    purpose: PURPOSE,
    createdAt: iso(snapshot.run.createdAt) as string,
  };
}

async function existingRequest(context: CurriculumRuntimeContext, requestId: string): Promise<ExistingRunRow | null> {
  return first<ExistingRunRow>(context.db, `SELECT run_id,request_id,request_digest,child_id,installation_id,candidate_id,test_run_id
    FROM pilot_curriculum_runtime_run WHERE request_id=?`, [requestId]);
}

export async function createCurriculumRuntimeVerification(context: CurriculumRuntimeContext, version: string, value: unknown): Promise<{ body: ReturnType<typeof metadata>; created: boolean }> {
  requireCurriculumRuntimeConfig(context.config);
  await operatorExists(context);
  const input = validateCreateInput(value);
  const installationId = await installation(context);
  const requestDigest = await requestFingerprint(version, input, context, installationId);
  const previous = await existingRequest(context, input.requestId);
  if (previous) {
    if (previous.request_digest !== requestDigest || previous.installation_id !== installationId || previous.candidate_id !== context.config.candidateId || previous.test_run_id !== context.config.testRunId) fixedError('EVENT_CONFLICT');
    const replay = await loadSnapshot(context, previous.child_id, previous.run_id, 'operator');
    if (!replay) fixedError('NOT_FOUND');
    return { body: metadata(replay), created: false };
  }
  const packageValue = await packageRow(context, version);
  if (packageValue.content_digest !== input.contentDigest) fixedError('RUNTIME_IDENTITY_MISMATCH');
  await childExists(context, input.childId);
  const lesson = await compilePackage(packageValue);
  const now = runtimeNow(context.config);
  const run = createCurriculumRun(lesson, { runId: randomRunId(), seed: randomSeed(), now });
  const runJson = canonicalPackage(run), auditId = `runtime-audit-${crypto.randomUUID()}`;
  let result: D1Result<unknown>[];
  try {
    result = await executeBatch(context.db, [
      context.db.prepare(`INSERT INTO pilot_curriculum_runtime_run
      (run_id,request_id,request_digest,child_id,lesson_version,content_digest,adapter_id,adapter_version,installation_id,candidate_id,test_run_id,purpose,created_by_user_id,run_json,revision,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM pilot_installation WHERE id=1 AND installation_id=?)
        AND EXISTS(SELECT 1 FROM pilot_auth_user WHERE id=? AND role='operator' AND disabled=0 AND must_change_password=0)
        AND EXISTS(SELECT 1 FROM pilot_auth_user WHERE id=? AND role='child' AND disabled=0 AND must_change_password=0)
        AND EXISTS(SELECT 1 FROM pilot_curriculum_package WHERE lesson_version=? AND content_digest=? AND test_run_id=?)
        AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_runtime_run WHERE request_id=?)`)
      .bind(run.runId, input.requestId, requestDigest, input.childId, version, input.contentDigest, run.identity.adapterId, run.identity.adapterVersion, installationId, context.config.candidateId, context.config.testRunId, PURPOSE, context.user.id, runJson, run.revision, run.createdAt, run.updatedAt, installationId, context.user.id, input.childId, version, input.contentDigest, context.config.testRunId, input.requestId),
    context.db.prepare(`INSERT INTO pilot_curriculum_runtime_audit
      (id,run_id,actor_user_id,action,event_id,revision,created_at)
      SELECT ?,?,?, 'create',NULL,0,? WHERE changes()=1`)
        .bind(auditId, run.runId, context.user.id, run.createdAt),
    ], { rethrowConstraint: true });
  } catch {
    const raced = await existingRequest(context, input.requestId);
    if (!raced) fixedError('STORAGE_UNAVAILABLE');
    if (raced.request_digest !== requestDigest || raced.installation_id !== installationId || raced.candidate_id !== context.config.candidateId || raced.test_run_id !== context.config.testRunId) fixedError('EVENT_CONFLICT');
    const replay = await loadSnapshot(context, raced.child_id, raced.run_id, 'operator');
    if (!replay) fixedError('NOT_FOUND');
    return { body: metadata(replay), created: false };
  }
  if (changes(result[0]) !== 1 || changes(result[1]) !== 1) {
    const raced = await existingRequest(context, input.requestId);
    if (raced) {
      if (raced.request_digest !== requestDigest || raced.installation_id !== installationId || raced.candidate_id !== context.config.candidateId || raced.test_run_id !== context.config.testRunId) fixedError('EVENT_CONFLICT');
      const replay = await loadSnapshot(context, raced.child_id, raced.run_id, 'operator');
      if (!replay) fixedError('NOT_FOUND');
      return { body: metadata(replay), created: false };
    }
    fixedError('NOT_FOUND');
  }
  const saved = await loadSnapshot(context, input.childId, run.runId, 'operator');
  if (!saved) fixedError('STORAGE_UNAVAILABLE');
  return { body: metadata(saved), created: true };
}

function viewAccess(context: CurriculumRuntimeContext): Access | null {
  if (context.user.role === 'child') return 'child';
  if (context.user.role === 'parent') return 'parent';
  if (context.user.role === 'teacher') return 'teacher';
  return null;
}

export async function getCurriculumRuntimeView(context: CurriculumRuntimeContext, childId: string, runId: string): Promise<Record<string, unknown>> {
  requireCurriculumRuntimeConfig(context.config);
  const access = viewAccess(context);
  if (!access) fixedError(context.user.role === 'operator' ? 'NOT_FOUND' : 'FORBIDDEN');
  const snapshot = await loadSnapshot(context, childId, runId, access);
  if (!snapshot) fixedError('NOT_FOUND');
  if (context.user.role !== 'child' || context.user.id !== childId) fixedError('FORBIDDEN');
  return { schemaVersion: 's3-runtime-http-1', purpose: PURPOSE, childId, run: publicRunView(projectCurriculumRun(snapshot.lesson, snapshot.run, snapshot.events, runtimeNow(context.config))) };
}

function validateActionInput(value: unknown): unknown {
  if (!exactObject(value, ['eventId', 'expectedRevision', 'occurrenceId', 'type', 'payload'])) fixedError('INVALID_REQUEST');
  return value;
}

export async function applyCurriculumRuntimeAction(context: CurriculumRuntimeContext, childId: string, runId: string, value: unknown): Promise<Record<string, unknown>> {
  requireCurriculumRuntimeConfig(context.config);
  const access = viewAccess(context);
  if (!access) fixedError('NOT_FOUND');
  const snapshot = await loadSnapshot(context, childId, runId, access);
  if (!snapshot) fixedError('NOT_FOUND');
  if (context.user.role !== 'child' || context.user.id !== childId) fixedError('FORBIDDEN');
  const now = runtimeNow(context.config);
  let applied: CurriculumActionResult;
  try { applied = applyCurriculumAction(snapshot.lesson, snapshot.run, snapshot.events, validateActionInput(value), now); }
  catch (caught) {
    if (caught instanceof CurriculumRuntimeHttpError) throw caught;
    if (caught instanceof EngineRuntimeError) throw mapEngineError(caught);
    fixedError('STORAGE_UNAVAILABLE');
  }
  if (applied.replayed) return { schemaVersion: 's3-runtime-action-1', ack: applied.ack, replayed: true };
  const event = applied.event;
  const result = await executeBatch(context.db, [
    context.db.prepare(`UPDATE pilot_curriculum_runtime_run SET run_json=?,revision=?,updated_at=?
      WHERE run_id=? AND revision=? AND installation_id=? AND installation_id=(SELECT installation_id FROM pilot_installation WHERE id=1)
        AND candidate_id=? AND test_run_id=? AND purpose=?
        AND EXISTS(SELECT 1 FROM pilot_curriculum_package p WHERE p.lesson_version=pilot_curriculum_runtime_run.lesson_version AND p.content_digest=pilot_curriculum_runtime_run.content_digest AND p.test_run_id=?)
        AND child_id=?
        AND EXISTS(SELECT 1 FROM pilot_auth_user WHERE id=? AND role='child' AND disabled=0 AND must_change_password=0)`)
      .bind(canonicalPackage(applied.run), applied.run.revision, applied.run.updatedAt, runId, snapshot.run.revision, snapshot.row.installation_id, context.config.candidateId, context.config.testRunId, PURPOSE, context.config.testRunId, childId, context.user.id),
    context.db.prepare(`INSERT INTO pilot_curriculum_runtime_event(run_id,event_id,sequence,event_json,created_at)
      SELECT ?,?,?,?,? WHERE changes()=1`)
      .bind(runId, event.eventId, event.sequence, canonicalPackage(event), event.serverTime),
    context.db.prepare(`INSERT INTO pilot_curriculum_runtime_audit(id,run_id,actor_user_id,action,event_id,revision,created_at)
      SELECT ?,?,?, 'action',?,?,? WHERE changes()=1`)
      .bind(`runtime-audit-${crypto.randomUUID()}`, runId, context.user.id, event.eventId, event.sequence, event.serverTime),
  ]);
  if (changes(result[0]) === 1 && changes(result[1]) === 1 && changes(result[2]) === 1) return { schemaVersion: 's3-runtime-action-1', ack: applied.ack, replayed: false };
  if (changes(result[0]) === 1) fixedError('STORAGE_UNAVAILABLE');
  const current = await loadSnapshot(context, childId, runId, 'child');
  if (!current) fixedError('NOT_FOUND');
  try {
    const replay = applyCurriculumAction(current.lesson, current.run, current.events, value, runtimeNow(context.config));
    if (replay.replayed) return { schemaVersion: 's3-runtime-action-1', ack: replay.ack, replayed: true };
  } catch (caught) { if (caught instanceof EngineRuntimeError) throw mapEngineError(caught); fixedError('STORAGE_UNAVAILABLE'); }
  fixedError('STORAGE_UNAVAILABLE');
}

export async function getCurriculumRuntimeProgress(context: CurriculumRuntimeContext, childId: string, runId: string): Promise<Record<string, unknown>> {
  requireCurriculumRuntimeConfig(context.config);
  const access = viewAccess(context);
  if (!access) fixedError('NOT_FOUND');
  const snapshot = await loadSnapshot(context, childId, runId, access);
  if (!snapshot) fixedError('NOT_FOUND');
  return { schemaVersion: 's3-runtime-progress-1', purpose: PURPOSE, childId, progress: publicProgress(projectCurriculumProgress(snapshot.lesson, snapshot.run, snapshot.events)) };
}

export function runtimeJson(body: unknown, status = 200): Response { return json(body, status); }
