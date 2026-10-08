import { isLessonVersion } from './content.ts';
import {
  actionAck,
  applyAction as reduceAction,
  createInitialRun,
  error,
  isReviewDue,
  reviewAvailableAt,
} from './domain.ts';
import { PreviewDomainError } from './domain.ts';
import type {
  ActionAck,
  DecisionView,
  FeedbackCategory,
  FeedbackSource,
  LearningEvent,
  LessonVersion,
  PreviewAction,
  PreviewFeedback,
  PreviewRun,
  PreviewStep,
  ReviewDecision,
  RunView,
} from './types.ts';

export interface PreviewNamespace {
  synthetic: boolean;
  testRunId: string | null;
}

export interface CreateRunInput {
  lessonVersion?: LessonVersion;
  runId: string;
  seed: number;
  now: string;
  synthetic?: boolean;
  testRunId?: string | null;
  scenario?: string | null;
}

export interface FeedbackInput {
  feedbackId: string;
  stepId: PreviewStep | null;
  category: FeedbackCategory;
  text: string;
  source: FeedbackSource;
}

export interface DecisionInput {
  status: 'changes-requested' | 'approved';
  reviewerLabel: string;
  notes: string;
  candidateId: string;
  synthetic: boolean;
  testRunId: string | null;
}

export interface PreviewStore {
  ensureSchema(): Promise<void>;
  createRun(input: CreateRunInput): Promise<PreviewRun>;
  listRuns(): Promise<PreviewRun[]>;
  getRun(runId: string): Promise<PreviewRun | null>;
  getView(runId: string): Promise<RunView | null>;
  applyAction(runId: string, action: PreviewAction): Promise<ActionAck>;
  addFeedback(runId: string, input: FeedbackInput): Promise<PreviewFeedback>;
  getDecision(
    lessonVersion: string,
    candidateId: string,
  ): Promise<DecisionView>;
  addDecision(
    lessonVersion: string,
    input: DecisionInput,
  ): Promise<ReviewDecision>;
  setClock(runId: string, at: string): Promise<string>;
  deleteSyntheticRun(runId: string): Promise<void>;
  setStorageFault(enabled: boolean): Promise<void>;
  seedLegacyProfile(): Promise<string>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS preview_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    lesson_id TEXT NOT NULL,
    lesson_version TEXT NOT NULL,
    seed INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    review_completed_at TEXT,
    synthetic INTEGER NOT NULL DEFAULT 0,
    test_run_id TEXT,
    scenario TEXT,
    effective_time TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS preview_events (
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    phase TEXT NOT NULL,
    step_id TEXT NOT NULL,
    question_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    action_json TEXT NOT NULL,
    server_time TEXT NOT NULL,
    first_response INTEGER NOT NULL,
    assisted INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    ack_json TEXT NOT NULL,
    PRIMARY KEY (run_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS preview_feedback (
    run_id TEXT NOT NULL,
    feedback_id TEXT NOT NULL,
    lesson_version TEXT NOT NULL,
    step_id TEXT,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    request_json TEXT NOT NULL,
    PRIMARY KEY (run_id, feedback_id)
  )`,
  `CREATE TABLE IF NOT EXISTS preview_decisions (
    decision_id TEXT PRIMARY KEY NOT NULL,
    lesson_version TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewer_label TEXT NOT NULL,
    notes TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    synthetic INTEGER NOT NULL DEFAULT 0,
    test_run_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS preview_faults (
    test_run_id TEXT PRIMARY KEY NOT NULL,
    storage_failed INTEGER NOT NULL DEFAULT 0
  )`,
];

interface RunRow {
  run_id: string;
  lesson_id: string;
  lesson_version: string;
  seed: number;
  state_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  review_completed_at: string | null;
  synthetic: number;
  test_run_id: string | null;
  scenario: string | null;
  effective_time: string;
}

interface EventRow {
  run_id: string;
  event_id: string;
  sequence: number;
  phase: LearningEvent['phase'];
  step_id: PreviewStep;
  question_id: string | null;
  type: LearningEvent['type'];
  payload_json: string;
  action_json: string;
  server_time: string;
  first_response: number;
  assisted: number;
  outcome: LearningEvent['outcome'];
  ack_json: string;
}

interface FeedbackRow {
  run_id: string;
  feedback_id: string;
  lesson_version: LessonVersion;
  step_id: PreviewStep | null;
  category: FeedbackCategory;
  text: string;
  source: FeedbackSource;
  created_at: string;
  request_json: string;
}

interface DecisionRow {
  decision_id: string;
  lesson_version: LessonVersion;
  status: 'changes-requested' | 'approved';
  reviewer_label: string;
  notes: string;
  candidate_id: string;
  created_at: string;
  synthetic: number;
  test_run_id: string | null;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stable(item)).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function parse<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw error('STORAGE_UNAVAILABLE', 'stored preview data is unreadable');
  }
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

function rowToRun(row: RunRow): PreviewRun {
  if (!isLessonVersion(row.lesson_version))
    throw error(
      'STORAGE_UNAVAILABLE',
      'stored preview lesson version is unsupported',
    );
  const state = parse<PreviewRun['state']>(row.state_json);
  return {
    runId: row.run_id,
    lessonId: row.lesson_id as PreviewRun['lessonId'],
    lessonVersion: row.lesson_version as PreviewRun['lessonVersion'],
    seed: row.seed >>> 0,
    revision: row.revision,
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    synthetic: row.synthetic === 1,
    testRunId: row.test_run_id,
    scenario: row.scenario,
    effectiveTime: row.effective_time,
  };
}

function rowToEvent(row: EventRow): LearningEvent {
  const result = parse<{ result: LearningEvent['result'] }>(
    row.ack_json,
  ).result;
  return {
    eventId: row.event_id,
    runId: row.run_id,
    sequence: row.sequence,
    phase: row.phase,
    stepId: row.step_id,
    questionId: row.question_id,
    type: row.type,
    payload: parse<Record<string, unknown>>(row.payload_json),
    serverTime: row.server_time,
    firstResponse: row.first_response === 1,
    assisted: row.assisted === 1,
    outcome: row.outcome,
    result,
  };
}

function rowToFeedback(row: FeedbackRow): PreviewFeedback {
  return {
    feedbackId: row.feedback_id,
    runId: row.run_id,
    lessonVersion: row.lesson_version,
    stepId: row.step_id,
    category: row.category,
    text: row.text,
    source: row.source,
    createdAt: row.created_at,
  };
}

function rowToDecision(row: DecisionRow): ReviewDecision {
  return {
    decisionId: row.decision_id,
    lessonVersion: row.lesson_version,
    status: row.status,
    reviewerLabel: row.reviewer_label,
    notes: row.notes,
    candidateId: row.candidate_id,
    createdAt: row.created_at,
    synthetic: row.synthetic === 1,
  };
}

type D1Like = Pick<D1Database, 'prepare' | 'batch'>;

export class D1PreviewStore implements PreviewStore {
  private readonly db: D1Like;
  private schemaPromise: Promise<void> | null = null;
  private readonly namespace: PreviewNamespace;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(
    db: D1Like,
    options: {
      namespace: PreviewNamespace;
      now?: () => string;
      id?: () => string;
    },
  ) {
    this.db = db;
    this.namespace = options.namespace;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id =
      options.id ??
      (() =>
        `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  }

  async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.db
        .batch(SCHEMA.map((statement) => this.db.prepare(statement)))
        .then(() => undefined)
        .catch((cause) => {
          this.schemaPromise = null;
          throw error(
            'STORAGE_UNAVAILABLE',
            cause instanceof Error
              ? cause.message
              : 'preview storage is unavailable',
          );
        });
    }
    await this.schemaPromise;
  }

  private async assertHealthy(): Promise<void> {
    if (!this.namespace.synthetic || !this.namespace.testRunId) return;
    try {
      const row = await this.db
        .prepare(
          'SELECT storage_failed FROM preview_faults WHERE test_run_id=?',
        )
        .bind(this.namespace.testRunId)
        .first<{ storage_failed: number }>();
      if (row?.storage_failed === 1)
        throw error('STORAGE_UNAVAILABLE', 'injected preview storage failure');
    } catch (cause) {
      if (cause instanceof PreviewDomainError) throw cause;
      if (
        cause instanceof Error &&
        cause.message === 'injected preview storage failure'
      )
        throw cause;
      throw error('STORAGE_UNAVAILABLE', 'preview storage is unavailable');
    }
  }

  private visibilitySql(prefix = ''): { sql: string; values: unknown[] } {
    const p = prefix ? `${prefix}.` : '';
    return {
      sql: `${p}synthetic=? AND ${p}test_run_id IS ?`,
      values: [flag(this.namespace.synthetic), this.namespace.testRunId],
    };
  }

  private async row(runId: string): Promise<RunRow | null> {
    const visibility = this.visibilitySql();
    try {
      return await this.db
        .prepare(
          `SELECT * FROM preview_runs WHERE run_id=? AND ${visibility.sql}`,
        )
        .bind(runId, ...visibility.values)
        .first<RunRow>();
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview storage is unavailable',
      );
    }
  }

  private async events(runId: string): Promise<LearningEvent[]> {
    try {
      const result = await this.db
        .prepare(
          'SELECT * FROM preview_events WHERE run_id=? ORDER BY sequence',
        )
        .bind(runId)
        .all<EventRow>();
      return result.results.map(rowToEvent);
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview storage is unavailable',
      );
    }
  }

  async createRun(input: CreateRunInput): Promise<PreviewRun> {
    const version = input.lessonVersion ?? 'forest-01-v1';
    if (!isLessonVersion(version))
      throw error('INVALID_REQUEST', 'lesson version is unsupported');
    if (
      version === 'forest-01-v3' &&
      ((input.synthetic !== undefined &&
        input.synthetic !== this.namespace.synthetic) ||
        (input.testRunId !== undefined &&
          input.testRunId !== this.namespace.testRunId))
    )
      throw error(
        'INVALID_REQUEST',
        'run namespace does not match the server-owned preview namespace',
      );
    await this.ensureSchema();
    await this.assertHealthy();
    const synthetic = input.synthetic ?? this.namespace.synthetic;
    const testRunId = synthetic
      ? (input.testRunId ?? this.namespace.testRunId)
      : null;
    const run = createInitialRun({ ...input, synthetic, testRunId });
    try {
      await this.db
        .prepare(`INSERT INTO preview_runs
        (run_id,lesson_id,lesson_version,seed,state_json,revision,created_at,updated_at,completed_at,review_completed_at,synthetic,test_run_id,scenario,effective_time)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          run.runId,
          run.lessonId,
          run.lessonVersion,
          run.seed,
          JSON.stringify(run.state),
          run.revision,
          run.createdAt,
          run.updatedAt,
          null,
          null,
          flag(run.synthetic),
          run.testRunId,
          run.scenario,
          run.effectiveTime,
        )
        .run();
      return run;
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview run could not be created',
      );
    }
  }

  async listRuns(): Promise<PreviewRun[]> {
    await this.ensureSchema();
    const visibility = this.visibilitySql();
    try {
      const result = await this.db
        .prepare(
          `SELECT * FROM preview_runs WHERE ${visibility.sql} ORDER BY created_at DESC`,
        )
        .bind(...visibility.values)
        .all<RunRow>();
      return result.results.map(rowToRun);
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview runs could not be read',
      );
    }
  }

  async getRun(runId: string): Promise<PreviewRun | null> {
    await this.ensureSchema();
    const result = await this.row(runId);
    return result ? rowToRun(result) : null;
  }

  async getView(runId: string): Promise<RunView | null> {
    await this.ensureSchema();
    const row = await this.row(runId);
    if (!row) return null;
    const run = rowToRun(row);
    const [events, feedback] = await Promise.all([
      this.events(runId),
      this.feedbackFor(runId),
    ]);
    const { deriveRecap } = await import('./domain.ts');
    const reviewDue =
      !run.state.reviewCompletedAt &&
      isReviewDue(run.state.completedAt, this.actionTime(run));
    return {
      ...run,
      events,
      recap: deriveRecap(events),
      feedback,
      reviewAvailableAt: reviewAvailableAt(run),
      reviewDue,
    };
  }

  private actionTime(run: PreviewRun): string {
    return this.namespace.synthetic ? run.effectiveTime : this.now();
  }

  private async feedbackFor(runId: string): Promise<PreviewFeedback[]> {
    try {
      const result = await this.db
        .prepare(
          'SELECT * FROM preview_feedback WHERE run_id=? ORDER BY created_at',
        )
        .bind(runId)
        .all<FeedbackRow>();
      return result.results.map(rowToFeedback);
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview feedback could not be read',
      );
    }
  }

  private async existingEvent(
    runId: string,
    eventId: string,
  ): Promise<EventRow | null> {
    try {
      return await this.db
        .prepare('SELECT * FROM preview_events WHERE run_id=? AND event_id=?')
        .bind(runId, eventId)
        .first<EventRow>();
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview event could not be read',
      );
    }
  }

  async applyAction(runId: string, action: PreviewAction): Promise<ActionAck> {
    await this.ensureSchema();
    await this.assertHealthy();
    const row = await this.row(runId);
    if (!row) throw error('NOT_FOUND', 'preview run was not found');
    const duplicate = await this.existingEvent(runId, action.eventId);
    const fingerprint = stable(action);
    if (duplicate) {
      if (duplicate.action_json !== fingerprint)
        throw error(
          'EVENT_CONFLICT',
          'event ID was already used for different content',
        );
      return parse<ActionAck>(duplicate.ack_json);
    }
    const run = rowToRun(row);
    if (action.expectedRevision !== run.revision)
      throw error('STALE_REVISION', 'the run revision is stale');
    const events = await this.events(runId);
    const reduced = reduceAction(run, events, action, this.actionTime(run));
    if (!reduced.ok) throw reduced.error;
    const ack = actionAck(reduced);
    const event = reduced.event;
    const visibility = this.visibilitySql();
    try {
      const batch = await this.db.batch([
        this.db
          .prepare(`UPDATE preview_runs SET state_json=?,revision=?,updated_at=?,completed_at=?,review_completed_at=?
          WHERE run_id=? AND revision=? AND ${visibility.sql}`)
          .bind(
            JSON.stringify(reduced.run.state),
            reduced.run.revision,
            reduced.run.updatedAt,
            reduced.run.state.completedAt,
            reduced.run.state.reviewCompletedAt,
            runId,
            run.revision,
            ...visibility.values,
          ),
        this.db
          .prepare(`INSERT INTO preview_events
          (run_id,event_id,sequence,phase,step_id,question_id,type,payload_json,action_json,server_time,first_response,assisted,outcome,ack_json)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
          .bind(
            runId,
            event.eventId,
            event.sequence,
            event.phase,
            event.stepId,
            event.questionId,
            event.type,
            JSON.stringify(event.payload),
            fingerprint,
            event.serverTime,
            flag(event.firstResponse),
            flag(event.assisted),
            event.outcome,
            JSON.stringify(ack),
          ),
      ]);
      if (!batch[0] || batch[0].meta.changes !== 1) {
        const replay = await this.existingEvent(runId, action.eventId);
        if (replay) {
          if (replay.action_json !== fingerprint)
            throw error(
              'EVENT_CONFLICT',
              'event ID was already used for different content',
            );
          return parse<ActionAck>(replay.ack_json);
        }
        throw error('STALE_REVISION', 'the run revision is stale');
      }
      return ack;
    } catch (cause) {
      if (cause instanceof PreviewDomainError) throw cause;
      const replay = await this.existingEvent(runId, action.eventId).catch(
        () => null,
      );
      if (replay) {
        if (replay.action_json !== fingerprint)
          throw error(
            'EVENT_CONFLICT',
            'event ID was already used for different content',
          );
        return parse<ActionAck>(replay.ack_json);
      }
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview action could not be saved',
      );
    }
  }

  async addFeedback(
    runId: string,
    input: FeedbackInput,
  ): Promise<PreviewFeedback> {
    await this.ensureSchema();
    await this.assertHealthy();
    const row = await this.row(runId);
    if (!row) throw error('NOT_FOUND', 'preview run was not found');
    const requestJson = stable(input);
    try {
      const existing = await this.db
        .prepare(
          'SELECT * FROM preview_feedback WHERE run_id=? AND feedback_id=?',
        )
        .bind(runId, input.feedbackId)
        .first<FeedbackRow>();
      if (existing) {
        if (existing.request_json !== requestJson)
          throw error(
            'EVENT_CONFLICT',
            'feedback ID was already used for different content',
          );
        return rowToFeedback(existing);
      }
      const createdAt = this.now();
      await this.db
        .prepare(`INSERT INTO preview_feedback
        (run_id,feedback_id,lesson_version,step_id,category,text,source,created_at,request_json)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(
          runId,
          input.feedbackId,
          row.lesson_version,
          input.stepId,
          input.category,
          input.text,
          input.source,
          createdAt,
          requestJson,
        )
        .run();
      return {
        feedbackId: input.feedbackId,
        runId,
        lessonVersion: row.lesson_version as LessonVersion,
        stepId: input.stepId,
        category: input.category,
        text: input.text,
        source: input.source,
        createdAt,
      };
    } catch (cause) {
      if (cause instanceof PreviewDomainError) throw cause;
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'preview feedback could not be saved',
      );
    }
  }

  async getDecision(
    lessonVersion: string,
    candidateId: string,
  ): Promise<DecisionView> {
    if (!isLessonVersion(lessonVersion))
      throw error('INVALID_REQUEST', 'lesson version is unsupported');
    await this.ensureSchema();
    const synthetic = flag(this.namespace.synthetic);
    try {
      const result = await this.db
        .prepare(
          `SELECT * FROM preview_decisions WHERE lesson_version=? AND synthetic=? AND test_run_id IS ? ORDER BY created_at`,
        )
        .bind(lessonVersion, synthetic, this.namespace.testRunId)
        .all<DecisionRow>();
      const history = result.results.map(rowToDecision);
      const current = [...history]
        .reverse()
        .find((item) => item.candidateId === candidateId);
      return {
        lessonVersion: lessonVersion as LessonVersion,
        candidateId,
        status: current?.status ?? 'draft',
        history,
      };
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'review decision could not be read',
      );
    }
  }

  async addDecision(
    lessonVersion: string,
    input: DecisionInput,
  ): Promise<ReviewDecision> {
    if (!isLessonVersion(lessonVersion))
      throw error('INVALID_REQUEST', 'lesson version is unsupported');
    await this.ensureSchema();
    await this.assertHealthy();
    if (
      input.testRunId !== this.namespace.testRunId ||
      input.synthetic !== this.namespace.synthetic
    )
      throw error(
        'EVENT_CONFLICT',
        'decision namespace does not match this candidate',
      );
    const decision: ReviewDecision = {
      decisionId: this.id(),
      lessonVersion: lessonVersion as LessonVersion,
      status: input.status,
      reviewerLabel: input.reviewerLabel,
      notes: input.notes,
      candidateId: input.candidateId,
      createdAt: this.now(),
      synthetic: input.synthetic,
    };
    try {
      await this.db
        .prepare(`INSERT INTO preview_decisions
        (decision_id,lesson_version,status,reviewer_label,notes,candidate_id,created_at,synthetic,test_run_id)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(
          decision.decisionId,
          decision.lessonVersion,
          decision.status,
          decision.reviewerLabel,
          decision.notes,
          decision.candidateId,
          decision.createdAt,
          flag(decision.synthetic),
          input.testRunId,
        )
        .run();
      return decision;
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'review decision could not be saved',
      );
    }
  }

  async setClock(runId: string, at: string): Promise<string> {
    await this.ensureSchema();
    await this.assertHealthy();
    const row = await this.row(runId);
    if (!row || row.synthetic !== 1 || !this.namespace.synthetic)
      throw error(
        'EVENT_CONFLICT',
        'clock can only target a synthetic preview run',
      );
    if (!Number.isFinite(Date.parse(at)))
      throw error('INVALID_REQUEST', 'clock time must be an ISO date');
    const requested = new Date(at).toISOString();
    if (Date.parse(requested) < Date.parse(row.effective_time))
      throw error(
        'INVALID_TRANSITION',
        'synthetic clock can only move forward',
      );
    if (requested === row.effective_time) return requested;
    try {
      await this.db
        .prepare(
          'UPDATE preview_runs SET effective_time=?,updated_at=? WHERE run_id=?',
        )
        .bind(requested, this.now(), runId)
        .run();
      return requested;
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'synthetic clock could not be saved',
      );
    }
  }

  async deleteSyntheticRun(runId: string): Promise<void> {
    await this.ensureSchema();
    await this.assertHealthy();
    const row = await this.row(runId);
    if (
      !row ||
      row.synthetic !== 1 ||
      !this.namespace.synthetic ||
      row.test_run_id !== this.namespace.testRunId
    )
      throw error(
        'EVENT_CONFLICT',
        'only the selected synthetic run can be reset',
      );
    try {
      await this.db.batch([
        this.db
          .prepare('DELETE FROM preview_events WHERE run_id=?')
          .bind(runId),
        this.db
          .prepare('DELETE FROM preview_feedback WHERE run_id=?')
          .bind(runId),
        this.db.prepare('DELETE FROM preview_runs WHERE run_id=?').bind(runId),
      ]);
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'synthetic run could not be reset',
      );
    }
  }

  async setStorageFault(enabled: boolean): Promise<void> {
    await this.ensureSchema();
    if (!this.namespace.synthetic || !this.namespace.testRunId)
      throw error('EVENT_CONFLICT', 'fault injection requires test mode');
    try {
      await this.db
        .prepare(`INSERT INTO preview_faults(test_run_id,storage_failed) VALUES(?,?)
        ON CONFLICT(test_run_id) DO UPDATE SET storage_failed=excluded.storage_failed`)
        .bind(this.namespace.testRunId, flag(enabled))
        .run();
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'fault control could not be saved',
      );
    }
  }

  async seedLegacyProfile(): Promise<string> {
    await this.ensureSchema();
    await this.assertHealthy();
    if (!this.namespace.synthetic || !this.namespace.testRunId)
      throw error(
        'EVENT_CONFLICT',
        'legacy fixture seeding requires test mode',
      );
    const profile = `qa-legacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const attempt = {
      id: `legacy-${profile}`,
      at: '2026-09-25T00:00:00.000Z',
      characterId: 'yi',
      skill: 'recognition',
      mode: 'practice',
      correct: true,
      assisted: false,
      mistakes: 0,
      first: true,
      answer: '一',
      responseMode: 'choice',
      contentVersion: 'poc-1',
    };
    const settings = {
      enabled: ['yi', 'er', 'san', 'da', 'xiao', 'ren'],
      lessonSize: 3,
    };
    try {
      await this.db.batch([
        this.db.prepare(
          'CREATE TABLE IF NOT EXISTS attempts (profile TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile,id))',
        ),
        this.db.prepare(
          'CREATE TABLE IF NOT EXISTS settings (profile TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
        ),
        this.db.prepare(
          'CREATE TABLE IF NOT EXISTS drafts (profile TEXT PRIMARY KEY NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)',
        ),
        this.db
          .prepare(
            'INSERT INTO attempts(profile,id,created_at,payload) VALUES(?,?,?,?) ON CONFLICT(profile,id) DO NOTHING',
          )
          .bind(profile, attempt.id, attempt.at, JSON.stringify(attempt)),
        this.db
          .prepare(
            'INSERT INTO settings(profile,payload) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET payload=excluded.payload',
          )
          .bind(profile, JSON.stringify(settings)),
      ]);
      return profile;
    } catch (cause) {
      throw error(
        'STORAGE_UNAVAILABLE',
        cause instanceof Error
          ? cause.message
          : 'legacy fixture could not be seeded',
      );
    }
  }
}

export function createPreviewStore(
  db: D1Database,
  namespace: PreviewNamespace,
  options?: { now?: () => string; id?: () => string },
): D1PreviewStore {
  return new D1PreviewStore(db, { namespace, ...options });
}

export function makeRunId(prefix = 'run'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeDecisionId(): string {
  return `decision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
