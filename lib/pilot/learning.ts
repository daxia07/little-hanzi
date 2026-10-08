import {
  actionAck,
  applyAction as reduceAction,
  createInitialRun,
  deriveRecap,
  isReviewDue,
  reviewAvailableAt,
  type ApplySuccess,
} from '../preview/domain.ts';
import { FOREST_LESSON } from '../preview/content.ts';
import type {
  ActionAck,
  LearningEvent,
  PreviewAction,
  PreviewFeedback,
  PreviewRun,
  RunView,
} from '../preview/types.ts';
import {
  getChildIfReadable,
  type PilotDatabase,
  type PilotUserRecord,
  PilotDbError,
} from './db.ts';
import type { SafePilotUser } from './policy.ts';
import type { PilotRuntimeConfig } from './runtime.ts';

export const FOREST_LESSON_ID = 'forest-01' as const;
export const FOREST_LESSON_VERSION = 'forest-01-v1' as const;

export const EXPERIENCE_VALUES = ['new', 'some', 'confident', 'unsure'] as const;
export type OnboardingExperience = typeof EXPERIENCE_VALUES[number];

export interface OnboardingInput {
  nickname: string;
  experience: OnboardingExperience;
  audioReady: boolean;
}

export interface OnboardingView extends OnboardingInput {
  updatedAt: string;
  updatedBy: string;
}

export interface AssignmentView {
  lessonId: typeof FOREST_LESSON_ID;
  lessonVersion: typeof FOREST_LESSON_VERSION;
  title: string;
  status: 'assigned';
  createdAt: string;
  runId: string | null;
}

export interface AvailableLessonView {
  lessonId: typeof FOREST_LESSON_ID;
  lessonVersion: typeof FOREST_LESSON_VERSION;
  title: string;
  releaseState: 'pending' | 'approved' | 'test-fixture';
  canAssign: boolean;
}

export interface ReleaseView extends AvailableLessonView {
  releaseKind: 'owner-approved' | 'test-fixture' | null;
}

export interface ProgressView {
  child: { id: string; name: string };
  assignments: AssignmentView[];
  runs: Array<RunView & { childId: string }>;
  evidenceLimits: EvidenceLimits;
}

export interface EvidenceLimits {
  completion: string;
  assistance: string;
  audio: string;
  review: string;
}

export interface CreateRunResult {
  run: RunView & { childId: string };
  created: boolean;
}

export interface AssignmentResult {
  assignment: AssignmentView;
  created: boolean;
}

interface ReleaseRow {
  lesson_version: string;
  release_kind: string;
  content_digest: string;
  reviewer_label: string;
  evidence_ref: string;
  candidate_id: string;
  test_run_id: string | null;
  released_at: number;
}

interface OnboardingRow {
  child_id: string;
  nickname: string;
  experience: OnboardingExperience;
  audio_ready: number;
  updated_at: number;
  updated_by: string;
}

interface AssignmentRow {
  child_id: string;
  lesson_version: string;
  status: string;
  created_at: number;
  created_by: string;
  run_id: string | null;
}

interface OwnershipRow {
  run_id: string;
  child_id: string;
  lesson_version: string;
  created_at: number;
}

interface RunRow {
  run_id: string;
  seed: number;
  state_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface OwnedRunRow extends RunRow {
  ownership_created_at: number;
}

interface EventRow {
  run_id: string;
  event_id: string;
  sequence: number;
  phase: LearningEvent['phase'];
  step_id: LearningEvent['stepId'];
  question_id: string | null;
  type: LearningEvent['type'];
  payload_json: string;
  action_json: string;
  server_time: number;
  first_response: number;
  assisted: number;
  outcome: LearningEvent['outcome'];
  ack_json: string;
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function validateOnboardingInput(value: unknown): OnboardingInput | null {
  if (!exactKeys(value, ['nickname', 'experience', 'audioReady'])) return null;
  const nickname = value.nickname;
  const experience = value.experience;
  const audioReady = value.audioReady;
  if (typeof nickname !== 'string') return null;
  const trimmed = nickname.trim();
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  if (typeof experience !== 'string' || !(EXPERIENCE_VALUES as readonly string[]).includes(experience)) return null;
  if (typeof audioReady !== 'boolean') return null;
  return { nickname: trimmed, experience: experience as OnboardingExperience, audioReady };
}

export function validateLessonVersionInput(value: unknown): value is { lessonVersion: typeof FOREST_LESSON_VERSION } {
  return exactKeys(value, ['lessonVersion']) && value.lessonVersion === FOREST_LESSON_VERSION;
}

const EVIDENCE_LIMITS: EvidenceLimits = {
  completion: 'Completing the initial activity records participation and task evidence; it does not establish independent mastery.',
  assistance: 'Hints, retries and demonstrations remain separate from an independent first response.',
  audio: 'Unavailable audio is recorded separately and does not count as a successful listening result.',
  review: 'Delayed review is separate evidence about a later attempt and does not prove durable learning.',
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] >>> 0;
}

function nowMs(value?: number): number {
  return value !== undefined && Number.isFinite(value) ? Number(value) : Date.now();
}

function iso(value: number): string {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot learning storage is unreadable');
  return result.toISOString();
}

function bool(value: unknown): boolean {
  return value === true || value === 1;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parse<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot learning storage is unreadable');
  }
}

function changes(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

async function first<T>(db: PilotDatabase, query: string, values: unknown[] = []): Promise<T | null> {
  try {
    return await db.prepare(query).bind(...values).first<T>();
  } catch {
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot learning storage is unavailable');
  }
}

async function all<T>(db: PilotDatabase, query: string, values: unknown[] = []): Promise<T[]> {
  try {
    const result = await db.prepare(query).bind(...values).all<T>();
    return result.results;
  } catch {
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot learning storage is unavailable');
  }
}

async function batch(db: PilotDatabase, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  try {
    return await db.batch(statements) as D1Result<unknown>[];
  } catch {
    // In particular, an injected event trigger is a storage failure. Do not
    // expose SQLite constraint/trigger text or map it to a client conflict.
    throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot learning storage is unavailable');
  }
}

function onboardingView(row: OnboardingRow): OnboardingView {
  return {
    nickname: row.nickname,
    experience: row.experience,
    audioReady: bool(row.audio_ready),
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
  };
}

function assignmentView(row: AssignmentRow): AssignmentView {
  return {
    lessonId: FOREST_LESSON_ID,
    lessonVersion: FOREST_LESSON_VERSION,
    title: FOREST_LESSON.title,
    status: 'assigned',
    createdAt: iso(row.created_at),
    runId: row.run_id,
  };
}

function releaseState(row: ReleaseRow | null, config: PilotRuntimeConfig, digest: string): ReleaseView {
  const base = {
    lessonId: FOREST_LESSON_ID,
    lessonVersion: FOREST_LESSON_VERSION,
    title: FOREST_LESSON.title,
  } as const;
  if (!row || row.content_digest !== digest) return { ...base, releaseState: 'pending', canAssign: false, releaseKind: null };
  if (row.release_kind === 'owner-approved') return { ...base, releaseState: 'approved', canAssign: true, releaseKind: 'owner-approved' };
  if (row.release_kind !== 'test-fixture') return { ...base, releaseState: 'pending', canAssign: false, releaseKind: null };
  const usable = config.testMode && config.testContentAllowed && !!config.testRunId && !!config.testToken
    && row.test_run_id === config.testRunId && row.candidate_id === config.candidateId;
  return { ...base, releaseState: 'test-fixture', canAssign: usable, releaseKind: 'test-fixture' };
}

async function lessonDigest(): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(FOREST_LESSON))));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function getLessonRelease(db: PilotDatabase, config: PilotRuntimeConfig): Promise<ReleaseView> {
  const [row, digest] = await Promise.all([
    first<ReleaseRow>(db, `SELECT lesson_version,release_kind,content_digest,reviewer_label,evidence_ref,candidate_id,test_run_id,released_at
      FROM pilot_learning_release WHERE lesson_version=?`, [FOREST_LESSON_VERSION]),
    lessonDigest(),
  ]);
  return releaseState(row, config, digest);
}

async function requireUsableRelease(db: PilotDatabase, config: PilotRuntimeConfig): Promise<ReleaseView> {
  const release = await getLessonRelease(db, config);
  if (!release.canAssign) throw new PilotDbError('LESSON_NOT_RELEASED', 'the forest lesson is not released for this installation');
  return release;
}

export async function getPilotInstallationId(db: PilotDatabase): Promise<string> {
  const row = await first<{ installation_id: string }>(db, 'SELECT installation_id FROM pilot_installation WHERE id=1');
  if (!row || !row.installation_id) throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot installation identity is unavailable');
  return row.installation_id;
}

export async function getOnboarding(db: PilotDatabase, childId: string): Promise<OnboardingView | null> {
  const row = await first<OnboardingRow>(db, `SELECT child_id,nickname,experience,audio_ready,updated_at,updated_by
    FROM pilot_onboarding WHERE child_id=?`, [childId]);
  return row ? onboardingView(row) : null;
}

export async function saveOnboarding(db: PilotDatabase, actorUserId: string, childId: string, input: OnboardingInput, at?: number): Promise<OnboardingView> {
  const now = nowMs(at);
  const saved = await batch(db, [
    db.prepare(`INSERT INTO pilot_onboarding(child_id,nickname,experience,audio_ready,updated_at,updated_by)
      SELECT ?,?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM pilot_parent_child l
        JOIN pilot_auth_user p ON p.id=l.parent_id
        JOIN pilot_auth_user c ON c.id=l.child_id
        WHERE l.parent_id=? AND l.child_id=? AND p.role='parent' AND p.disabled=0 AND c.role='child' AND c.disabled=0
      )
      ON CONFLICT(child_id) DO UPDATE SET nickname=excluded.nickname,experience=excluded.experience,
        audio_ready=excluded.audio_ready,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(childId, input.nickname, input.experience, input.audioReady ? 1 : 0, now, actorUserId, actorUserId, childId),
    db.prepare(`INSERT INTO pilot_learning_audit(id,action,actor_user_id,child_id,metadata,created_at)
      SELECT ?,?,?,?,?,? WHERE changes()=1`)
      .bind(id('learning-audit'), 'onboarding.save', actorUserId, childId, JSON.stringify({ experience: input.experience, audioReady: input.audioReady }), now),
  ]);
  if (changes(saved[0]) !== 1) throw new PilotDbError('NOT_FOUND', 'child was not found');
  const result = await getOnboarding(db, childId);
  if (!result) throw new PilotDbError('STORAGE_UNAVAILABLE', 'saved onboarding could not be read');
  return result;
}

async function assignmentRow(db: PilotDatabase, childId: string, actorParentId?: string): Promise<AssignmentRow | null> {
  const condition = actorParentId
    ? `AND EXISTS(SELECT 1 FROM pilot_parent_child l WHERE l.parent_id=? AND l.child_id=a.child_id)`
    : '';
  const values = actorParentId ? [childId, FOREST_LESSON_VERSION, actorParentId] : [childId, FOREST_LESSON_VERSION];
  return first<AssignmentRow>(db, `SELECT a.child_id,a.lesson_version,a.status,a.created_at,a.created_by,o.run_id
    FROM pilot_assignment a LEFT JOIN pilot_run_ownership o
      ON o.child_id=a.child_id AND o.lesson_version=a.lesson_version
    WHERE a.child_id=? AND a.lesson_version=? ${condition}`, values);
}

export async function listAssignments(db: PilotDatabase, childId: string): Promise<AssignmentView[]> {
  const row = await assignmentRow(db, childId);
  return row && row.status === 'assigned' ? [assignmentView(row)] : [];
}

export async function listAssignmentsForChildren(db: PilotDatabase, childIds: string[]): Promise<Map<string, AssignmentView>> {
  const result = new Map<string, AssignmentView>();
  if (!childIds.length) return result;
  const placeholders = childIds.map(() => '?').join(',');
  const rows = await all<AssignmentRow>(db, `SELECT a.child_id,a.lesson_version,a.status,a.created_at,a.created_by,o.run_id
    FROM pilot_assignment a LEFT JOIN pilot_run_ownership o
      ON o.child_id=a.child_id AND o.lesson_version=a.lesson_version
    WHERE a.lesson_version=? AND a.status='assigned' AND a.child_id IN (${placeholders})
    ORDER BY a.created_at,a.child_id`, [FOREST_LESSON_VERSION, ...childIds]);
  for (const row of rows) if (!result.has(row.child_id)) result.set(row.child_id, assignmentView(row));
  return result;
}

export async function assignLesson(db: PilotDatabase, config: PilotRuntimeConfig, actorUserId: string, childId: string, lessonVersion: string, at?: number): Promise<AssignmentResult> {
  if (lessonVersion !== FOREST_LESSON_VERSION) throw new PilotDbError('INVALID_REQUEST', 'lesson version is unsupported');
  const existing = await assignmentRow(db, childId, actorUserId);
  if (existing) return { assignment: assignmentView(existing), created: false };
  const onboarding = await first<{ child_id: string }>(db, `SELECT o.child_id FROM pilot_onboarding o
    JOIN pilot_parent_child l ON l.child_id=o.child_id
    WHERE o.child_id=? AND l.parent_id=?`, [childId, actorUserId]);
  if (!onboarding) throw new PilotDbError('ONBOARDING_REQUIRED', 'complete child onboarding before assigning a lesson');
  await requireUsableRelease(db, config);
  const now = nowMs(at);
  const result = await batch(db, [
    db.prepare(`INSERT OR IGNORE INTO pilot_assignment(child_id,lesson_version,status,created_at,created_by)
      SELECT ?,?,?,?,? WHERE EXISTS(
        SELECT 1 FROM pilot_parent_child l
        JOIN pilot_auth_user p ON p.id=l.parent_id
        JOIN pilot_auth_user c ON c.id=l.child_id
        JOIN pilot_onboarding o ON o.child_id=l.child_id
        WHERE l.parent_id=? AND l.child_id=? AND p.role='parent' AND p.disabled=0 AND c.role='child' AND c.disabled=0
      )`).bind(childId, FOREST_LESSON_VERSION, 'assigned', now, actorUserId, actorUserId, childId),
    db.prepare(`INSERT INTO pilot_learning_audit(id,action,actor_user_id,child_id,metadata,created_at)
      SELECT ?,?,?,?,?,? WHERE changes()=1`)
      .bind(id('learning-audit'), 'assignment.create', actorUserId, childId, JSON.stringify({ lessonVersion: FOREST_LESSON_VERSION }), now),
  ]);
  if (changes(result[0]) !== 1) {
    const replay = await assignmentRow(db, childId, actorUserId);
    if (replay) return { assignment: assignmentView(replay), created: false };
    throw new PilotDbError('NOT_FOUND', 'child was not found');
  }
  const created = await assignmentRow(db, childId, actorUserId);
  if (!created) throw new PilotDbError('STORAGE_UNAVAILABLE', 'saved assignment could not be read');
  return { assignment: assignmentView(created), created: true };
}

export async function assignmentsProjection(db: PilotDatabase, config: PilotRuntimeConfig, childId: string): Promise<{ assignments: AssignmentView[]; availableLessons: AvailableLessonView[] }> {
  const release = await getLessonRelease(db, config);
  const assignments = await listAssignments(db, childId);
  const lesson: AvailableLessonView = {
    lessonId: release.lessonId,
    lessonVersion: release.lessonVersion,
    title: release.title,
    releaseState: release.releaseState,
    canAssign: release.canAssign,
  };
  return { assignments, availableLessons: [lesson] };
}

function rowToRun(ownership: OwnershipRow, row: RunRow): PreviewRun {
  const createdAt = iso(row.created_at);
  return {
    runId: ownership.run_id,
    lessonId: FOREST_LESSON_ID,
    lessonVersion: ownership.lesson_version as typeof FOREST_LESSON_VERSION,
    seed: row.seed >>> 0,
    revision: row.revision,
    state: parse<PreviewRun['state']>(row.state_json),
    createdAt,
    updatedAt: iso(row.updated_at),
    synthetic: false,
    testRunId: null,
    scenario: null,
    effectiveTime: createdAt,
  };
}

function rowToEvent(row: EventRow): LearningEvent {
  const ack = parse<ActionAck>(row.ack_json);
  return {
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    phase: row.phase,
    stepId: row.step_id,
    questionId: row.question_id,
    type: row.type,
    payload: parse<Record<string, unknown>>(row.payload_json),
    serverTime: iso(row.server_time),
    firstResponse: bool(row.first_response),
    assisted: bool(row.assisted),
    outcome: row.outcome,
    result: ack.result,
  };
}

async function eventsForRun(db: PilotDatabase, runId: string): Promise<LearningEvent[]> {
  const rows = await all<EventRow>(db, `SELECT run_id,event_id,sequence,phase,step_id,question_id,type,payload_json,action_json,server_time,first_response,assisted,outcome,ack_json
    FROM pilot_learning_event WHERE run_id=? ORDER BY sequence`, [runId]);
  return rows.map(rowToEvent);
}

async function ownedRun(db: PilotDatabase, childId: string, runId: string): Promise<{ ownership: OwnershipRow; run: RunRow } | null> {
  const row = await first<OwnedRunRow & OwnershipRow>(db, `SELECT o.run_id,o.child_id,o.lesson_version,o.created_at AS ownership_created_at,
      r.seed,r.state_json,r.revision,r.created_at,r.updated_at
    FROM pilot_run_ownership o JOIN pilot_learning_run r ON r.run_id=o.run_id
    WHERE o.run_id=? AND o.child_id=?`, [runId, childId]);
  if (!row) return null;
  return {
    ownership: { run_id: row.run_id, child_id: row.child_id, lesson_version: row.lesson_version, created_at: Number(row.ownership_created_at) },
    run: { run_id: row.run_id, seed: Number(row.seed), state_json: row.state_json, revision: Number(row.revision), created_at: Number(row.created_at), updated_at: Number(row.updated_at) },
  };
}

async function runView(db: PilotDatabase, childId: string, runId: string, at?: number): Promise<(RunView & { childId: string }) | null> {
  const found = await ownedRun(db, childId, runId);
  if (!found) return null;
  const run = rowToRun(found.ownership, found.run);
  const events = await eventsForRun(db, runId);
  const now = iso(nowMs(at));
  const view: RunView = {
    ...run,
    events,
    recap: deriveRecap(events),
    feedback: [] as PreviewFeedback[],
    reviewAvailableAt: reviewAvailableAt(run),
    reviewDue: !run.state.reviewCompletedAt && isReviewDue(run.state.completedAt, now),
  };
  return { ...view, childId };
}

export async function getRunView(db: PilotDatabase, childId: string, runId: string, at?: number): Promise<(RunView & { childId: string })> {
  const view = await runView(db, childId, runId, at);
  if (!view) throw new PilotDbError('NOT_FOUND', 'run was not found');
  return view;
}

async function allRunViews(db: PilotDatabase, childId: string, at?: number): Promise<Array<RunView & { childId: string }>> {
  const rows = await all<OwnershipRow>(db, `SELECT o.run_id,o.child_id,o.lesson_version,o.created_at
    FROM pilot_run_ownership o JOIN pilot_learning_run r ON r.run_id=o.run_id
    WHERE o.child_id=? ORDER BY o.created_at,o.run_id`, [childId]);
  const views: Array<RunView & { childId: string }> = [];
  for (const row of rows) {
    const view = await runView(db, childId, row.run_id, at);
    if (view) views.push(view);
  }
  return views;
}

export async function getProgress(db: PilotDatabase, child: SafePilotUser, at?: number): Promise<ProgressView> {
  const [assignments, runs] = await Promise.all([
    listAssignments(db, child.id),
    allRunViews(db, child.id, at),
  ]);
  return { child: { id: child.id, name: child.name }, assignments, runs, evidenceLimits: EVIDENCE_LIMITS };
}

export async function getExport(db: PilotDatabase, child: SafePilotUser, at?: number): Promise<{
  schemaVersion: 'pilot-learning-export-1';
  exportedAt: string;
  child: { id: string; name: string };
  onboarding: OnboardingView | null;
  assignments: AssignmentView[];
  runs: Array<RunView & { childId: string }>;
  evidenceLimits: EvidenceLimits;
}> {
  const progress = await getProgress(db, child, at);
  return {
    schemaVersion: 'pilot-learning-export-1',
    exportedAt: iso(nowMs(at)),
    child: progress.child,
    onboarding: await getOnboarding(db, child.id),
    assignments: progress.assignments,
    runs: progress.runs,
    evidenceLimits: progress.evidenceLimits,
  };
}

export async function createRun(db: PilotDatabase, config: PilotRuntimeConfig, childId: string, lessonVersion: string, at?: number): Promise<CreateRunResult> {
  if (lessonVersion !== FOREST_LESSON_VERSION) throw new PilotDbError('INVALID_REQUEST', 'lesson version is unsupported');
  const assigned = await first<{ child_id: string }>(db, `SELECT child_id FROM pilot_assignment
    WHERE child_id=? AND lesson_version=? AND status='assigned'`, [childId, FOREST_LESSON_VERSION]);
  if (!assigned) throw new PilotDbError('ASSIGNMENT_REQUIRED', 'assign the forest lesson before starting it');
  await requireUsableRelease(db, config);
  const now = nowMs(at);
  const runId = id('pilot-run');
  const run = createInitialRun({ runId, seed: randomSeed(), now: iso(now) });
  const results = await batch(db, [
    db.prepare(`INSERT OR IGNORE INTO pilot_run_ownership(run_id,child_id,lesson_version,created_at)
      SELECT ?,?,?,? WHERE EXISTS(
        SELECT 1 FROM pilot_assignment a
        JOIN pilot_auth_user c ON c.id=a.child_id
        WHERE a.child_id=? AND a.lesson_version=? AND a.status='assigned' AND c.role='child' AND c.disabled=0
      )`).bind(runId, childId, FOREST_LESSON_VERSION, now, childId, FOREST_LESSON_VERSION),
    db.prepare(`INSERT INTO pilot_learning_run(run_id,seed,state_json,revision,created_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE changes()=1`).bind(runId, run.seed, JSON.stringify(run.state), run.revision, now, now),
  ]);
  if (changes(results[0]) === 1) return { run: { ...(await getRunView(db, childId, runId, now)) }, created: true };
  const existing = await first<{ run_id: string }>(db, `SELECT o.run_id FROM pilot_run_ownership o JOIN pilot_learning_run r ON r.run_id=o.run_id
    WHERE o.child_id=? AND o.lesson_version=?`, [childId, FOREST_LESSON_VERSION]);
  if (!existing) throw new PilotDbError('NOT_FOUND', 'child was not found');
  return { run: await getRunView(db, childId, existing.run_id, now), created: false };
}

async function existingEvent(db: PilotDatabase, runId: string, eventId: string): Promise<EventRow | null> {
  return first<EventRow>(db, `SELECT run_id,event_id,sequence,phase,step_id,question_id,type,payload_json,action_json,server_time,first_response,assisted,outcome,ack_json
    FROM pilot_learning_event WHERE run_id=? AND event_id=?`, [runId, eventId]);
}

function ackFromEvent(row: EventRow): ActionAck {
  return parse<ActionAck>(row.ack_json);
}

function asPilotError(caught: unknown): never {
  if (caught instanceof PilotDbError) throw caught;
  if (caught instanceof Error && caught.name === 'PreviewDomainError' && 'code' in caught && typeof (caught as { code?: unknown }).code === 'string') {
    const code = (caught as { code: PilotDbError['code'] }).code;
    throw new PilotDbError(code, caught.message);
  }
  throw new PilotDbError('STORAGE_UNAVAILABLE', 'pilot learning storage is unavailable');
}

export async function applyLearningAction(db: PilotDatabase, config: PilotRuntimeConfig, childId: string, runId: string, action: PreviewAction, at?: number): Promise<ActionAck> {
  try {
    const found = await ownedRun(db, childId, runId);
    if (!found) throw new PilotDbError('NOT_FOUND', 'run was not found');
    await requireUsableRelease(db, config);
    const duplicate = await existingEvent(db, runId, action.eventId);
    const fingerprint = stable(action);
    if (duplicate) {
      if (duplicate.action_json !== fingerprint) throw new PilotDbError('EVENT_CONFLICT', 'event ID was already used for different content');
      return ackFromEvent(duplicate);
    }
    const run = rowToRun(found.ownership, found.run);
    const events = await eventsForRun(db, runId);
    const reduced = reduceAction(run, events, action, iso(nowMs(at)));
    if (!reduced.ok) throw new PilotDbError(reduced.error.code, reduced.error.message);
    const ack = actionAck(reduced as ApplySuccess);
    const event = reduced.event;
    const now = Date.parse(event.serverTime);
    const results = await batch(db, [
      db.prepare(`UPDATE pilot_learning_run SET state_json=?,revision=?,updated_at=?
        WHERE run_id=? AND revision=? AND EXISTS(
          SELECT 1 FROM pilot_run_ownership o JOIN pilot_auth_user c ON c.id=o.child_id
          WHERE o.run_id=? AND o.child_id=? AND c.disabled=0
        )`).bind(JSON.stringify(reduced.run.state), reduced.run.revision, now, runId, run.revision, runId, childId),
      db.prepare(`INSERT INTO pilot_learning_event
        (run_id,event_id,sequence,phase,step_id,question_id,type,payload_json,action_json,server_time,first_response,assisted,outcome,ack_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
        .bind(runId, event.eventId, event.sequence, event.phase, event.stepId, event.questionId, event.type, JSON.stringify(event.payload), fingerprint, now, event.firstResponse ? 1 : 0, event.assisted ? 1 : 0, event.outcome, JSON.stringify(ack)),
    ]);
    if (changes(results[0]) === 1) return ack;
    const replay = await existingEvent(db, runId, action.eventId);
    if (replay) {
      if (replay.action_json !== fingerprint) throw new PilotDbError('EVENT_CONFLICT', 'event ID was already used for different content');
      return ackFromEvent(replay);
    }
    throw new PilotDbError('STALE_REVISION', 'the run revision is stale');
  } catch (caught) {
    return asPilotError(caught);
  }
}

export async function readableChild(db: PilotDatabase, actor: PilotUserRecord, childId: string): Promise<SafePilotUser> {
  const child = await getChildIfReadable(db, actor, childId);
  if (!child) throw new PilotDbError('NOT_FOUND', 'child was not found');
  return child;
}

export { EVIDENCE_LIMITS };
