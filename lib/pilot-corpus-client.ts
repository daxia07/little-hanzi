/** R6 browser DTO and scoped recovery; no package, reducer or policy imports. */
import { inspectJson } from './curriculum/json.ts';
import {
  pilotRequest,
  getPilotMe,
  hasPendingSignOut,
  type PilotMe,
} from './pilot-client.ts';
import type {
  CorpusAction,
  CorpusAck,
  CorpusRunView,
  CorpusPackageIdentity,
  CorpusProposal,
  CorpusPlan,
  CorpusProposalInput,
  CorpusPlacementResponse,
  CorpusPlanResponse,
  CorpusPracticeResponse,
  CorpusProgress,
} from './curriculum/corpus-types.ts';
export type CorpusScope = CorpusPackageIdentity & {
  installationId: string;
  accountId: string;
  childId: string;
  assignmentId: string;
  scheduleId: string;
  releaseId: string;
  releaseRevision: number;
};
export class CorpusApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    status: number,
    code: string,
    message = 'Your learning could not be loaded. Retry.',
  ) {
    super(message);
    this.name = 'CorpusApiError';
    this.status = status;
    this.code = code;
  }
}
type Rule = ((v: unknown) => boolean) | { [key: string]: Rule };
const str =
  (max = 240) =>
  (v: unknown) =>
    typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim();
const nullable = (rule: Rule) => (v: unknown) => v === null || accepts(v, rule);
const enumOf =
  (...values: unknown[]) =>
  (v: unknown) =>
    values.includes(v);
const bool = (v: unknown) => typeof v === 'boolean';
const integer = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v;
const digest = (v: unknown) =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const list =
  (rule: Rule, max = 100, min = 0) =>
  (v: unknown) =>
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every((i) => accepts(i, rule));
function accepts(v: unknown, rule: Rule): boolean {
  if (typeof rule === 'function') return rule(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    Object.keys(o).sort().join(',') === Object.keys(rule).sort().join(',') &&
    Object.entries(rule).every(([k, r]) => accepts(o[k], r))
  );
}
function copied(value: unknown): unknown {
  const r = inspectJson(value);
  if (r.errors.length || JSON.stringify(r.value).length > 500_000)
    throw new CorpusApiError(502, 'INVALID_RESPONSE');
  return r.value;
}
function decode<T>(value: unknown, rule: Rule): T {
  const r = copied(value);
  if (!accepts(r, rule)) throw new CorpusApiError(502, 'INVALID_RESPONSE');
  return r as T;
}
const phase = enumOf('initial', 'review-24h', 'review-7d'),
  step = enumOf(
    'welcome',
    'familiarity',
    'teach',
    'practice',
    'reader',
    'check',
    'recap',
  );
const identity = {
  corpusId: str(80),
  corpusVersion: str(80),
  corpusDigest: digest,
  lessonId: str(80),
  lessonVersion: str(80),
  contentDigest: digest,
  adapterId: enumOf('corpus-paired'),
  adapterVersion: enumOf('corpus-paired-v1'),
};
const choice = { choiceId: str(80), hanzi: str(8) };
const result = {
  outcome: enumOf(
    'continued',
    'incorrect',
    'correct',
    'hint',
    'demonstrated',
    'unavailable',
    'completed',
  ),
  firstResponse: bool,
  assisted: bool,
};
const ack = { eventId: str(120), revision: integer, result };
const group = {
  total: integer,
  independent: integer,
  supported: integer,
  unavailable: integer,
  pending: integer,
  firstResponses: integer,
  helpCount: integer,
};
const recap = {
  phase,
  completedAt: nullable(date),
  familiarity: group,
  practice: group,
  check: group,
  evidenceLimits: list(str(800), 16),
};
const playback = {
  schemaVersion: enumOf('r5-playback-1'),
  kind: enumOf('local-device', 'recorded'),
  voices: list(
    { name: str(120), lang: str(32), localService: enumOf(true) },
    8,
  ),
  fallback: enumOf('unavailable'),
  cues: list(
    {
      cueId: str(80),
      readingId: nullable(str(80)),
      wordId: nullable(str(80)),
      checkId: nullable(str(80)),
      transcript: str(120),
      assetId: str(80),
      assetUrl: nullable(str(500)),
      assetDigest: nullable(digest),
    },
    3,
  ),
};
const state = {
  phase,
  stepId: step,
  panelIndex: integer,
  questionIndex: integer,
  questionStatus: nullable(
    enumOf('open', 'answered', 'demonstrated', 'unavailable'),
  ),
  attempts: integer,
  hintLevel: enumOf(0, 1, 2),
  assisted: bool,
  targetRoutes: nullable(
    list({ characterId: str(80), mode: enumOf('full', 'reminder') }, 2, 2),
  ),
  completedAt: nullable(date),
};
const question = {
  occurrenceId: str(180),
  characterId: str(80),
  checkId: str(80),
  kind: enumOf('plain-print', 'word-context'),
  instructionEnglish: str(),
  promptEnglish: str(),
  audioText: str(120),
  requiresAudio: bool,
  status: enumOf('open', 'answered', 'demonstrated', 'unavailable'),
  attempts: integer,
  assisted: bool,
  hintLevel: enumOf(0, 1, 2),
  choices: list(choice, 4, 4),
  hintEnglish: nullable(str()),
  demonstrationEnglish: nullable(str()),
};
const teaching = {
  panelId: str(120),
  characterId: str(80),
  hanzi: str(8),
  mode: enumOf('full', 'reminder'),
  instructionEnglish: str(),
  hintEnglish: str(),
  demonstrationEnglish: str(),
  readings: list(
    { readingId: str(80), pinyin: str(), audioText: str(120) },
    1,
    1,
  ),
  meanings: list(str(), 32, 1),
  words: list(
    {
      wordId: str(80),
      text: str(32),
      pinyin: str(),
      english: str(),
      context: { hanzi: str(120), english: str(240) },
    },
    2,
    2,
  ),
};
const reader = {
  panelId: str(120),
  title: str(120),
  instructionEnglish: str(),
  text: str(120),
  english: str(),
  audioText: str(120),
  highlight: str(32),
};
const event = {
  eventId: str(120),
  sequence: integer,
  occurrenceId: nullable(str(180)),
  type: enumOf('continue', 'answer', 'help', 'audio-unavailable'),
  serverAt: date,
  result,
  choiceId: nullable(str(80)),
};
const runRule = {
  ...identity,
  schemaVersion: enumOf('r6-story-view-1'),
  runId: str(120),
  assignmentId: str(120),
  scheduleId: str(120),
  releaseId: str(120),
  releaseRevision: integer,
  installationId: str(240),
  childId: str(120),
  revision: integer,
  state,
  soundReview: enumOf('pending', 'reviewed', 'synthetic'),
  question: nullable(question),
  teachingPanel: nullable(teaching),
  readerPanel: nullable(reader),
  welcomePanel: nullable({ title: str(120), instructionEnglish: str() }),
  lesson: {
    title: str(120),
    targets: list({ characterId: str(80), hanzi: str(8) }, 2, 2),
    instructionsEnglish: {
      welcome: str(),
      objective: str(),
      completion: str(),
      recovery: str(),
    },
    playback,
  },
  events: list(event, 160),
  recap,
  available: bool,
  reason: nullable(str(800)),
  canContinue: bool,
  dueAt: date,
  serverAt: date,
  createdAt: date,
  updatedAt: date,
};
export function normalizeCorpusRun(
  value: unknown,
  scope: CorpusScope,
): CorpusRunView {
  const r = decode<CorpusRunView>(value, runRule);
  for (const key of [
    'installationId',
    'childId',
    'assignmentId',
    'scheduleId',
    'releaseId',
    'releaseRevision',
    'corpusId',
    'corpusVersion',
    'corpusDigest',
    'lessonId',
    'lessonVersion',
    'contentDigest',
    'adapterId',
    'adapterVersion',
  ] as const)
    if (r[key] !== scope[key])
      throw new CorpusApiError(
        401,
        'IDENTITY_CHANGED',
        'Your account or learning plan changed. Sign in again.',
      );
  const cues = r.lesson.playback.cues,
    q = r.question;
  if (
    r.recap.phase !== r.state.phase ||
    r.recap.completedAt !== r.state.completedAt ||
    r.revision !== r.events.length
  )
    throw new CorpusApiError(502, 'INVALID_RESPONSE');
  if (
    q
      ? cues.length !== 1 ||
        cues[0].checkId !== q.checkId ||
        cues[0].readingId !== null ||
        cues[0].wordId !== null ||
        q.status !== r.state.questionStatus ||
        q.attempts !== r.state.attempts ||
        q.hintLevel !== r.state.hintLevel
      : r.state.stepId === 'teach'
        ? cues.length !== 3 || !r.teachingPanel
        : r.state.stepId === 'reader'
          ? cues.length !== 1 || !r.readerPanel
          : cues.length !== 0
  )
    throw new CorpusApiError(502, 'INVALID_RESPONSE');
  const invalid = () => {
    throw new CorpusApiError(502, 'INVALID_RESPONSE');
  };
  for (const g of [r.recap.familiarity, r.recap.practice, r.recap.check])
    if (
      g.independent + g.supported + g.unavailable + g.pending !== g.total ||
      g.firstResponses > g.total ||
      g.helpCount > g.total * 2
    )
      invalid();
  if (q) {
    if (
      cues[0].transcript !== q.audioText ||
      !q.requiresAudio ||
      new Set(q.choices.map((v) => v.choiceId)).size !== 4 ||
      new Set(q.choices.map((v) => v.hanzi)).size !== 4 ||
      q.occurrenceId !== `${r.state.phase}:${r.state.stepId}:${q.checkId}`
    )
      invalid();
  } else if (r.teachingPanel) {
    const t = r.teachingPanel;
    const reading = cues.filter((c) => c.readingId !== null),
      words = cues.filter((c) => c.checkId !== null);
    if (
      reading.length !== 1 ||
      reading[0].readingId !== t.readings[0].readingId ||
      reading[0].transcript !== t.readings[0].audioText ||
      words.length !== 2 ||
      words.some(
        (c, i) =>
          c.wordId !== null ||
          c.readingId !== null ||
          c.transcript !== t.words[i].text,
      )
    )
      invalid();
  } else if (r.readerPanel) {
    if (
      cues[0].transcript !== r.readerPanel.audioText ||
      cues[0].wordId === null ||
      cues[0].readingId !== null ||
      cues[0].checkId !== null
    )
      invalid();
  }
  for (const cue of cues) {
    if (
      r.lesson.playback.kind === 'local-device'
        ? cue.assetUrl !== null || cue.assetDigest !== null
        : !cue.assetUrl ||
          !/^\/story\/[A-Za-z0-9_./-]+$/.test(cue.assetUrl) ||
          cue.assetUrl.split('/').some((s) => s === '.' || s === '..') ||
          !cue.assetDigest
    )
      invalid();
  }
  return r;
}
export interface CorpusTransport {
  start: () => Promise<unknown>;
  get: (runId: string) => Promise<unknown>;
  send: (runId: string, action: CorpusAction) => Promise<CorpusAck>;
}
export function createCorpusTransport(
  scope: CorpusScope,
  {
    request = pilotRequest,
    verify,
    startId,
  }: {
    request?: typeof pilotRequest;
    verify: () => Promise<boolean>;
    startId: () => string;
  },
): CorpusTransport {
  let started: { runId: string } | null = null;
  async function call(path: string, body?: unknown) {
    if (!(await verify())) throw new CorpusApiError(401, 'IDENTITY_CHANGED');
    const v = await request(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
    });
    if (!(await verify())) throw new CorpusApiError(401, 'IDENTITY_CHANGED');
    return v;
  }
  const runPath = (id: string) =>
    `/api/pilot/curriculum/learning-runs/${encodeURIComponent(id)}`;
  return {
    async start() {
      if (!started) {
        const ack = decode<{
          runId: string;
          assignmentId: string;
          scheduleId: string;
          lessonVersion: string;
          revision: 0;
        }>(
          await call(
            `/api/pilot/curriculum/assignments/${encodeURIComponent(scope.assignmentId)}/start`,
            { requestId: startId(), scheduleId: scope.scheduleId },
          ),
          {
            runId: str(120),
            assignmentId: str(120),
            scheduleId: str(120),
            lessonVersion: str(80),
            revision: enumOf(0),
          },
        );
        if (
          ack.assignmentId !== scope.assignmentId ||
          ack.scheduleId !== scope.scheduleId ||
          ack.lessonVersion !== scope.lessonVersion
        )
          throw new CorpusApiError(401, 'IDENTITY_CHANGED');
        started = ack;
      }
      return call(runPath(started.runId));
    },
    get: (id) => call(runPath(id)),
    async send(id, a) {
      return decode<{ ack: CorpusAck; replayed: boolean }>(
        await call(runPath(id) + '/actions', {
          eventId: a.eventId,
          expectedRevision: a.expectedRevision,
          occurrenceId: a.occurrenceId,
          type: a.type,
          payload: a.payload,
        }),
        { ack, replayed: bool },
      ).ack;
    },
  };
}
export interface CorpusPending {
  runId: string;
  action: CorpusAction;
}
export interface CorpusRecovery {
  available: () => boolean;
  startId: () => string;
  read: (runId: string) => CorpusPending[];
  write: (runId: string, pending: CorpusPending[]) => boolean;
  clear: () => void;
}
export function corpusRecoveryKey(scope: CorpusScope) {
  return (
    'little-hanzi:pilot:corpus:' +
    Object.keys(scope)
      .sort()
      .map((key) => encodeURIComponent(scope[key as keyof CorpusScope]))
      .join(':')
  );
}
export function createCorpusRecovery(
  scope: CorpusScope,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  id = () => crypto.randomUUID(),
): CorpusRecovery {
  const prefix = corpusRecoveryKey(scope),
    identity = JSON.stringify(
      Object.fromEntries(
        Object.entries(scope).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  const touched = new Set<string>();
  let supported = !!storage,
    start: string | null = null;
  const get = (key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      supported = false;
      return null;
    }
  };
  const set = (key: string, value: string) => {
    try {
      if (!storage) return false;
      storage.setItem(key, value);
      return true;
    } catch {
      supported = false;
      return false;
    }
  };
  const actionRule = {
    eventId: str(120),
    expectedRevision: integer,
    occurrenceId: nullable(str(180)),
    type: enumOf('continue', 'answer', 'help', 'audio-unavailable'),
    payload: (v: unknown) =>
      accepts(v, {}) || accepts(v, { choiceId: str(80) }),
  };
  return {
    available: () => supported,
    startId() {
      if (!start) {
        start = get(prefix + ':start') ?? id();
        if (!set(prefix + ':start', start)) supported = false;
      }
      return start;
    },
    read(runId) {
      touched.add(prefix + ':' + encodeURIComponent(runId));
      try {
        const v = decode<{ identity: string; pending: CorpusPending[] }>(
          JSON.parse(get(prefix + ':' + encodeURIComponent(runId)) ?? 'null'),
          {
            identity: str(2000),
            pending: list({ runId: str(120), action: actionRule }, 4),
          },
        );
        return v.identity === identity &&
          v.pending.every((p) => p.runId === runId)
          ? v.pending
          : [];
      } catch {
        return [];
      }
    },
    write(runId, pending) {
      touched.add(prefix + ':' + encodeURIComponent(runId));
      return set(
        prefix + ':' + encodeURIComponent(runId),
        JSON.stringify({ identity, pending }),
      );
    },
    clear() {
      start = null;
      try {
        storage?.removeItem(prefix + ':start');
        for (const key of touched) storage?.removeItem(key);
        touched.clear();
      } catch {
        supported = false;
      }
    },
  };
}
export type CorpusSaveState =
  | 'idle'
  | 'loading'
  | 'saved'
  | 'saving'
  | 'pending'
  | 'readback-pending'
  | 'conflict'
  | 'error'
  | 'unavailable'
  | 'locked';
export interface CorpusSnapshot {
  run: CorpusRunView | null;
  pending: CorpusPending[];
  status: CorpusSaveState;
  notice: string;
  reportReady: boolean;
  conflictReady: boolean;
  storageAvailable: boolean;
}
export function createCorpusSession({
  scope,
  transport,
  recovery,
  verify,
  onChange = () => {},
  id = () => crypto.randomUUID(),
}: {
  scope: CorpusScope;
  transport: CorpusTransport;
  recovery: CorpusRecovery;
  verify: () => Promise<boolean>;
  onChange?: (s: CorpusSnapshot) => void;
  id?: () => string;
}) {
  let run: CorpusRunView | null = null,
    pending: CorpusPending[] = [],
    status: CorpusSaveState = 'idle',
    notice = '',
    reportReady = true,
    conflictReady = false,
    dead = false,
    epoch = 0,
    readSequence = 0;
  let draining: Promise<void> | null = null;
  const acknowledgedAnswers = new Set<string>();
  const snapshot = (): CorpusSnapshot => ({
    run,
    pending: [...pending],
    status,
    notice,
    reportReady,
    conflictReady,
    storageAvailable: recovery.available(),
  });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    dead = true;
    epoch++;
    run = null;
    pending = [];
    acknowledgedAnswers.clear();
    status = 'locked';
    notice = 'Your account changed. Sign in again.';
    recovery.clear();
    onChange(snapshot());
  }
  async function allowed(token: number) {
    const v = await verify();
    if (dead || token !== epoch) return false;
    if (!v) {
      lock();
      return false;
    }
    return true;
  }
  const authError = (e: unknown) =>
    [401, 403, 404].includes((e as { status?: number })?.status ?? 0);
  const persist = () => {
    if (run && !recovery.write(run.runId, pending))
      notice =
        'Browser recovery is unavailable. Keep this page open and retry.';
  };
  async function load(initialRunId: string | null) {
    if (dead || draining || pending.length) return;
    const token = ++epoch;
    status = 'loading';
    emit();
    try {
      if (!(await allowed(token))) return;
      const value = initialRunId
        ? await transport.get(initialRunId)
        : await transport.start();
      if (dead || token !== epoch) return;
      run = normalizeCorpusRun(value, scope);
      pending = recovery.read(run.runId);
      reportReady = true;
      conflictReady = false;
      status = !run.available
        ? 'unavailable'
        : pending.length
          ? 'pending'
          : 'saved';
      notice =
        run.reason ??
        (pending.length
          ? 'An unsent action is ready to retry with its original identity.'
          : '');
      emit();
    } catch (e) {
      if (dead || token !== epoch) return;
      if (authError(e)) {
        lock();
        return;
      }
      status = 'error';
      notice = 'Your saved lesson could not load. Retry.';
      emit();
    }
  }
  async function readback(conflict = false) {
    if (!run || dead) return;
    const token = epoch;
    const sequence = ++readSequence;
    const runId = run.runId;
    reportReady = false;
    conflictReady = false;
    if (conflict)
      notice =
        'Refreshing the latest saved step. Your unsent input is retained.';
    emit();
    try {
      if (!(await allowed(token))) return;
      const value = await transport.get(runId);
      if (dead || token !== epoch || sequence !== readSequence) return;
      run = normalizeCorpusRun(value, scope);
      reportReady = true;
      conflictReady = conflict;
      status = conflict
        ? 'conflict'
        : !run.available
          ? 'unavailable'
          : pending.length
            ? 'pending'
            : 'saved';
      notice = conflict
        ? 'Read the saved step, then choose Continue from saved state. Your unsent input is retained.'
        : (run.reason ?? '');
      emit();
    } catch (e) {
      if (dead || token !== epoch || sequence !== readSequence) return;
      if (authError(e)) {
        lock();
        return;
      }
      reportReady = false;
      conflictReady = false;
      status = conflict ? 'conflict' : 'readback-pending';
      notice = conflict
        ? 'The latest saved step could not load. Refresh before accepting it.'
        : 'Your action is saved. Refreshing the saved lesson failed; retry refresh.';
      emit();
    }
  }
  async function drain() {
    if (draining) return draining;
    if (
      dead ||
      !run ||
      !run.available ||
      !pending.length ||
      status === 'conflict'
    )
      return;
    const token = epoch;
    status = 'saving';
    emit();
    draining = (async () => {
      do {
        while (run && pending.length && !dead && token === epoch) {
          const item = pending[0];
          try {
            if (!(await allowed(token))) return;
            const a = await transport.send(run.runId, item.action);
            if (dead || token !== epoch) return;
            const checked = decode<CorpusAck>(a, ack);
            if (
              checked.eventId !== item.action.eventId ||
              checked.revision !== item.action.expectedRevision + 1
            )
              throw new CorpusApiError(502, 'INVALID_ACK');
            run = {
              ...run,
              revision: Math.max(run.revision, checked.revision),
            };
            if (item.action.type === 'answer' && item.action.occurrenceId)
              acknowledgedAnswers.add(item.action.occurrenceId);
            pending.shift();
            reportReady = false;
            persist();
            emit();
          } catch (e) {
            if (dead || token !== epoch) return;
            if (authError(e)) {
              lock();
              return;
            }
            if ((e as { status?: number }).status === 409) {
              status = 'conflict';
              conflictReady = false;
              reportReady = false;
              await readback(true);
              return;
            }
            status = 'pending';
            notice =
              'Saving is unconfirmed. Your original action is retained. Retry save.';
            emit();
            return;
          }
        }
        if (!dead && token === epoch) await readback();
      } while (
        !dead &&
        token === epoch &&
        run?.available &&
        pending.length &&
        snapshot().status !== 'conflict'
      );
    })().finally(() => {
      draining = null;
    });
    return draining;
  }
  function enqueue(
    type: CorpusAction['type'],
    payload: Record<string, unknown>,
    occurrenceId: string | null,
  ) {
    if (!run) return;
    const action: CorpusAction = {
      eventId: id(),
      expectedRevision: pending.length
        ? pending[pending.length - 1].action.expectedRevision + 1
        : run.revision,
      occurrenceId,
      type,
      payload: structuredClone(payload),
    };
    pending.push({ runId: run.runId, action });
    persist();
  }
  return {
    snapshot,
    load,
    lock,
    destroy() {
      dead = true;
      epoch++;
      run = null;
      pending = [];
      acknowledgedAnswers.clear();
    },
    async submit(
      type: CorpusAction['type'],
      payload: Record<string, unknown> = {},
    ) {
      if (
        dead ||
        !run ||
        !run.available ||
        status !== 'saved' ||
        !reportReady ||
        pending.length
      )
        return false;
      enqueue(type, payload, run.question?.occurrenceId ?? null);
      await drain();
      return status === 'saved';
    },
    failAudio(occurrenceId: string) {
      if (
        dead ||
        !run ||
        !run.available ||
        run.question?.occurrenceId !== occurrenceId ||
        run.question.status === 'unavailable' ||
        pending.some(
          (p) =>
            p.action.type === 'audio-unavailable' &&
            p.action.occurrenceId === occurrenceId,
        )
      )
        return;
      const answered =
        acknowledgedAnswers.has(occurrenceId) ||
        run.question.attempts > 0 ||
        ['answered', 'demonstrated'].includes(run.question.status) ||
        pending.some(
          (p) =>
            p.action.type === 'answer' &&
            p.action.occurrenceId === occurrenceId,
        );
      if (!answered) return;
      enqueue('audio-unavailable', {}, occurrenceId);
      notice =
        'Sound stopped. Saving this question as unavailable before continuing.';
      emit();
      void drain();
    },
    retry: () =>
      status === 'readback-pending'
        ? readback()
        : status === 'conflict'
          ? readback(true)
          : drain(),
    refreshConflict: () => readback(true),
    acceptConflict() {
      if (status !== 'conflict' || !conflictReady || !run || !run.available)
        return false;
      pending = [];
      persist();
      status = 'saved';
      notice =
        'Continue from saved state. The unsent action was not resubmitted.';
      emit();
      return true;
    },
    canNavigate: () =>
      !!run &&
      run.available &&
      status === 'saved' &&
      reportReady &&
      !pending.length,
  };
}

export type CorpusCatalogScope = {
  accountId: string;
  installationId: string;
  childId: string;
  corpusVersion: string;
};
export interface CorpusCatalogSnapshot {
  status:
    | 'idle'
    | 'loading'
    | 'ready'
    | 'stale'
    | 'unavailable'
    | 'error'
    | 'locked';
  page: import('./curriculum/corpus-types.ts').CorpusCatalogResponse | null;
  query: string;
  limit: 20 | 50;
  previous: boolean;
  notice: string;
  selected: import('./curriculum/corpus-types.ts').CorpusCatalogItem | null;
}
const reasonCode = enumOf(
  'FIXTURE',
  'PLACEHOLDER',
  'UNVERIFIED_SOURCE',
  'MISSING_LICENSE',
  'ALIAS',
  'DUPLICATE_IDENTITY',
  'INCOMPLETE_WORD_CONTEXT',
  'UNREVIEWED_CONTENT',
  'UNREVIEWED_AUDIO',
  'MISSING_PROMPT',
  'MISSING_ASSET',
  'UNSUPPORTED_RENDERER',
  'INVALID_PROOF',
  'STALE_EVIDENCE',
  'HISTORICAL_INSTALLATION',
  'WITHDRAWN',
  'OWNER_DECISION_PENDING',
  'PACKAGE_INELIGIBLE',
);
export function normalizeCorpusCatalog(
  value: unknown,
  corpusVersion: string,
  limit = 20,
): import('./curriculum/corpus-types.ts').CorpusCatalogResponse {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new CorpusApiError(400, 'INVALID_QUERY');
  const r = decode<
    import('./curriculum/corpus-types.ts').CorpusCatalogResponse
  >(value, {
    schemaVersion: enumOf('r6-catalog-1'),
    corpusVersion: str(80),
    corpusDigest: digest,
    releaseRevision: integer,
    items: list(
      {
        lessonVersion: str(80),
        contentDigest: digest,
        adapterId: enumOf('corpus-paired'),
        adapterVersion: enumOf('corpus-paired-v1'),
        title: str(120),
        targets: list({ characterId: str(80), hanzi: str(8) }, 2, 2),
        words: list({ text: str(32), english: str(240) }, 4),
        trackId: str(80),
        sequence: integer,
        releaseId: str(120),
        releaseRevision: integer,
        available: bool,
        reasonCode: nullable(reasonCode),
      },
      limit,
    ),
    nextCursor: nullable(str(4096)),
  });
  if (
    r.corpusVersion !== corpusVersion ||
    r.items.some((i) => i.releaseRevision !== r.releaseRevision) ||
    new Set(r.items.map((i) => i.lessonVersion)).size !== r.items.length
  )
    throw new CorpusApiError(502, 'INVALID_RESPONSE');
  return r;
}
export function createCorpusCatalog({
  scope,
  verify,
  request = pilotRequest,
  onChange = () => {},
}: {
  scope: CorpusCatalogScope;
  verify: (scope: CorpusCatalogScope) => Promise<boolean>;
  request?: typeof pilotRequest;
  onChange?: (s: CorpusCatalogSnapshot) => void;
}) {
  let state: CorpusCatalogSnapshot = {
    status: 'idle',
    page: null,
    query: '',
    limit: 20,
    previous: false,
    notice: '',
    selected: null,
  };
  let dead = false,
    epoch = 0,
    cursor: string | null = null,
    previous: Array<string | null> = [],
    attemptedPage: {
      cursor: string | null;
      history: Array<string | null>;
    } | null = null;
  const snapshot = () => ({ ...state });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    dead = true;
    epoch++;
    cursor = null;
    previous = [];
    attemptedPage = null;
    state = {
      ...state,
      status: 'locked',
      page: null,
      selected: null,
      notice: 'Your account changed. Sign in again.',
      previous: false,
    };
    onChange(snapshot());
  }
  async function allowed(token: number) {
    const ok = await verify(scope);
    if (dead || token !== epoch) return false;
    if (!ok) {
      lock();
      return false;
    }
    return true;
  }
  async function load(target = attemptedPage ?? { cursor, history: previous }) {
    if (dead) return;
    // Retain the requested page separately; commit cursor/history only on success.
    const transition = { cursor: target.cursor, history: [...target.history] };
    attemptedPage = transition;
    const token = ++epoch;
    state = {
      ...state,
      status: 'loading',
      page: null,
      selected: null,
      notice: '',
    };
    emit();
    try {
      if (!(await allowed(token))) return;
      const params = new URLSearchParams({
        corpusVersion: scope.corpusVersion,
        limit: String(state.limit),
      });
      if (state.query) params.set('q', state.query);
      if (transition.cursor) params.set('cursor', transition.cursor);
      const value = await request(
        `/api/pilot/children/${encodeURIComponent(scope.childId)}/catalog?${params}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      if (!(await allowed(token))) return;
      const page = normalizeCorpusCatalog(
        value,
        scope.corpusVersion,
        state.limit,
      );
      cursor = transition.cursor;
      previous = transition.history;
      attemptedPage = null;
      state = {
        ...state,
        status: 'ready',
        page,
        previous: previous.length > 0,
        notice: page.items.length
          ? ''
          : 'No eligible lessons match this search.',
      };
      emit();
    } catch (e) {
      if (dead || token !== epoch) return;
      const error = e as { status?: number; code?: string };
      if (error.status === 401) {
        lock();
        return;
      }
      const stale = error.code === 'CURSOR_STALE';
      if (stale) {
        cursor = null;
        previous = [];
        attemptedPage = null;
      }
      state = {
        ...state,
        page: null,
        selected: null,
        status: stale
          ? 'stale'
          : [403, 404].includes(error.status ?? 0)
            ? 'unavailable'
            : 'error',
        previous: !stale && previous.length > 0,
        notice: stale
          ? 'The lesson list changed. Load the first page.'
          : [403, 404].includes(error.status ?? 0)
            ? 'This lesson list is no longer available.'
            : 'The lesson list could not load. Retry.',
      };
      emit();
    }
  }
  return {
    snapshot,
    load: () => load(),
    retry: () => load(),
    lock,
    destroy() {
      dead = true;
      epoch++;
      attemptedPage = null;
      state = { ...state, page: null, selected: null };
    },
    async search(query: string, limit: 20 | 50 = 20) {
      if (dead) return;
      const q = query.normalize('NFC').trim().replace(/\s+/gu, ' ');
      if (Array.from(q).length > 80 || ![20, 50].includes(limit)) {
        state = { ...state, notice: 'Use a search of 80 characters or fewer.' };
        emit();
        return;
      }
      cursor = null;
      previous = [];
      state = { ...state, query: q, limit, previous: false };
      await load({ cursor: null, history: [] });
    },
    async next() {
      if (state.status !== 'ready' || !state.page?.nextCursor || dead) return;
      await load({
        cursor: state.page.nextCursor,
        history: [...previous, cursor],
      });
    },
    async previous() {
      if (state.status !== 'ready' || !previous.length || dead) return;
      await load({
        cursor: previous[previous.length - 1],
        history: previous.slice(0, -1),
      });
    },
    first() {
      cursor = null;
      previous = [];
      state = { ...state, previous: false };
      return load({ cursor: null, history: [] });
    },
    select(lessonVersion: string) {
      if (state.status !== 'ready' || dead) return null;
      const item =
        state.page?.items.find(
          (i) =>
            i.lessonVersion === lessonVersion &&
            i.available &&
            i.reasonCode === null,
        ) ?? null;
      state = { ...state, selected: item };
      emit();
      return item
        ? {
            corpusVersion: scope.corpusVersion,
            selection: {
              lessonVersion: item.lessonVersion,
              contentDigest: item.contentDigest,
              releaseId: item.releaseId,
              releaseRevision: item.releaseRevision,
            },
          }
        : null;
    },
  };
}

export type CorpusPlanRead = CorpusPlacementResponse & CorpusPlanResponse;
export type CorpusPlanPending =
  | { kind: 'propose'; body: CorpusProposalInput; ack: boolean }
  | {
      kind: 'approve';
      body: { proposalId: string; sourceDigest: string };
      ack: boolean;
    };
export interface CorpusPlanSnapshot extends CorpusPlanRead {
  status:
    | 'idle'
    | 'loading'
    | 'saved'
    | 'saving'
    | 'pending'
    | 'readback-pending'
    | 'conflict'
    | 'error'
    | 'locked';
  pending: CorpusPlanPending | null;
  conflictReady: boolean;
  notice: string;
}
export interface CorpusPlanApi {
  read: () => Promise<CorpusPlanRead>;
  propose: (body: CorpusProposalInput) => Promise<{ proposal: CorpusProposal }>;
  approve: (body: {
    proposalId: string;
    sourceDigest: string;
  }) => Promise<{ plan: CorpusPlan }>;
}
/** Private memory-only pending parent choice. A known ACK is never resent. */
export function createCorpusPlanController({
  scope,
  api,
  verify,
  onChange = () => {},
}: {
  scope: CorpusCatalogScope;
  api: CorpusPlanApi;
  verify: (scope: CorpusCatalogScope) => Promise<boolean>;
  onChange?: (s: CorpusPlanSnapshot) => void;
}) {
  const empty = () =>
    ({
      setupComplete: false,
      proposal: null,
      reason: null,
      plan: null,
      history: [],
    }) as CorpusPlanRead;
  let view: CorpusPlanSnapshot = {
      ...empty(),
      status: 'idle',
      pending: null,
      conflictReady: false,
      notice: '',
    },
    dead = false,
    epoch = 0;
  const snapshot = (): CorpusPlanSnapshot => ({
    ...view,
    pending: view.pending ? (copied(view.pending) as CorpusPlanPending) : null,
  });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    if (dead) return;
    dead = true;
    epoch++;
    view = {
      ...empty(),
      status: 'locked',
      pending: null,
      conflictReady: false,
      notice: 'Your account or access changed. Sign in again.',
    };
    onChange(snapshot());
  }
  async function allowed(token: number) {
    const ok = await verify(scope);
    if (dead || token !== epoch) return false;
    if (!ok) {
      lock();
      return false;
    }
    return true;
  }
  function failure(error: unknown) {
    const e = error as { status?: number };
    if ([401, 403, 404].includes(e.status ?? 0)) {
      lock();
      return;
    }
    view = {
      ...view,
      status: view.pending?.ack
        ? 'readback-pending'
        : e.status === 409
          ? 'conflict'
          : view.pending
            ? 'pending'
            : 'error',
      conflictReady: false,
      notice: view.pending?.ack
        ? 'Your change is saved. Retry the refresh.'
        : e.status === 409
          ? 'Your saved choice changed. Load it before continuing.'
          : view.pending
            ? 'Saving is unconfirmed. Retry the same change.'
            : 'Saved learning could not load. Retry.',
    };
    emit();
  }
  async function read(token: number, conflict = false) {
    if (!(await allowed(token))) return false;
    const next = await api.read();
    if (!(await allowed(token))) return false;
    view = {
      ...view,
      ...next,
      status: conflict ? 'conflict' : 'saved',
      pending: conflict ? view.pending : null,
      conflictReady: conflict,
      notice: conflict
        ? 'Saved choice loaded. Use it to discard the stale change.'
        : '',
    };
    emit();
    return true;
  }
  async function load() {
    if (dead || view.status === 'saving' || (view.pending && !view.pending.ack))
      return;
    const token = ++epoch;
    view = { ...view, status: 'loading', conflictReady: false, notice: '' };
    emit();
    try {
      await read(token);
    } catch (error) {
      if (!dead && token === epoch) failure(error);
    }
  }
  async function mutate(op: CorpusPlanPending) {
    if (dead) return;
    const token = ++epoch;
    view = {
      ...view,
      status: 'saving',
      pending: op,
      conflictReady: false,
      notice: '',
    };
    emit();
    try {
      if (!(await allowed(token))) return;
      if (!op.ack) {
        if (op.kind === 'propose') {
          const ack = await api.propose(op.body);
          if (!(await allowed(token))) return;
          view = { ...view, proposal: ack.proposal };
        } else {
          const ack = await api.approve(op.body);
          if (!(await allowed(token))) return;
          view = { ...view, plan: ack.plan };
        }
        op.ack = true;
        view = { ...view, pending: op };
      }
      await read(token);
    } catch (error) {
      if (!dead && token === epoch) failure(error);
    }
  }
  return {
    snapshot,
    load,
    lock,
    destroy() {
      dead = true;
      epoch++;
      view = {
        ...empty(),
        status: 'locked',
        pending: null,
        conflictReady: false,
        notice: '',
      };
    },
    async propose(body: CorpusProposalInput) {
      if (dead || view.pending || view.status === 'saving') return;
      if (body.corpusVersion !== scope.corpusVersion)
        throw new CorpusApiError(400, 'INVALID_REQUEST');
      await mutate({
        kind: 'propose',
        body: copied(body) as CorpusProposalInput,
        ack: false,
      });
    },
    async approve(body: { proposalId: string; sourceDigest: string }) {
      if (dead || view.pending || view.status === 'saving') return;
      await mutate({
        kind: 'approve',
        body: copied(body) as typeof body,
        ack: false,
      });
    },
    async retry() {
      if (dead) return;
      const pending = view.pending;
      if (pending?.ack) {
        const token = ++epoch;
        view = { ...view, status: 'loading' };
        emit();
        try {
          await read(token);
        } catch (error) {
          if (!dead && token === epoch) failure(error);
        }
      } else if (pending && view.status === 'pending') await mutate(pending);
      else if (!pending) await load();
    },
    async refreshConflict() {
      if (dead || !view.pending || view.status !== 'conflict') return;
      const token = ++epoch;
      view = { ...view, conflictReady: false };
      emit();
      try {
        await read(token, true);
      } catch (error) {
        if (!dead && token === epoch) {
          if (
            [401, 403, 404].includes((error as { status?: number }).status ?? 0)
          ) {
            lock();
            return;
          }
          view = {
            ...view,
            status: 'conflict',
            conflictReady: false,
            notice: 'Saved choice could not load. Retry the refresh.',
          };
          emit();
        }
      }
    },
    acceptConflict() {
      if (dead || view.status !== 'conflict' || !view.conflictReady)
        return false;
      view = {
        ...view,
        status: 'saved',
        pending: null,
        conflictReady: false,
        notice: '',
      };
      emit();
      return true;
    },
  };
}

const targetsRule = list({ characterId: str(80), hanzi: str(8) }, 2, 2);
const corpusIdentityRule = {
  corpusId: str(120),
  corpusVersion: str(120),
  corpusDigest: digest,
};
const packageIdentityRule = {
  ...corpusIdentityRule,
  lessonId: str(120),
  lessonVersion: str(120),
  contentDigest: digest,
  adapterId: enumOf('corpus-paired'),
  adapterVersion: enumOf('corpus-paired-v1'),
};
const proposalRule = {
  ...packageIdentityRule,
  title: str(120),
  targets: targetsRule,
  proposalId: str(120),
  childId: str(120),
  installationId: str(240),
  predecessorProposalId: nullable(str(120)),
  selectionOrdinal: integer,
  releaseId: str(120),
  releaseRevision: integer,
  sourceDigest: digest,
  reason: str(800),
  selectedByParent: bool,
  createdAt: date,
  expiresAt: date,
};
const libraryRule = {
  ...packageIdentityRule,
  title: str(120),
  targets: targetsRule,
  trackId: str(120),
  sequence: integer,
  releaseId: nullable(str(120)),
  releaseRevision: nullable(integer),
  available: bool,
  reason: nullable(str(800)),
  assignmentId: nullable(str(120)),
  completed: bool,
};
const planRule = {
  ...corpusIdentityRule,
  planId: str(120),
  proposalId: str(120),
  childId: str(120),
  installationId: str(240),
  approvedAt: date,
  available: bool,
  reason: nullable(str(800)),
  items: list(
    { ...libraryRule, planItemId: str(120), ordinal: enumOf(0) },
    1,
    1,
  ),
};
const practiceRule = {
  ...packageIdentityRule,
  title: str(120),
  targets: targetsRule,
  installationId: str(240),
  assignmentId: str(120),
  scheduleId: str(120),
  runId: nullable(str(120)),
  releaseId: str(120),
  releaseRevision: integer,
  kind: phase,
  dueAt: date,
  available: bool,
  reason: nullable(str(800)),
  stepId: nullable(step),
};
const primaryRule = (v: unknown) =>
  accepts(v, {
    kind: enumOf('continue', 'review', 'next'),
    assignmentId: str(120),
    scheduleId: str(120),
    runId: nullable(str(120)),
  }) ||
  accepts(v, {
    kind: enumOf('prepare'),
    assignmentId: enumOf(null),
    scheduleId: enumOf(null),
    runId: enumOf(null),
  });
const visitRule = {
  ...packageIdentityRule,
  title: str(120),
  targets: targetsRule,
  installationId: str(240),
  assignmentId: str(120),
  scheduleId: str(120),
  runId: nullable(str(120)),
  releaseId: str(120),
  phase,
  dueAt: date,
  completedAt: nullable(date),
  introducedTargets: list(str(80), 2),
  recap: nullable(recap),
};
const progressRule = {
  ...corpusIdentityRule,
  schemaVersion: enumOf('r6-family-progress-1'),
  installationId: str(240),
  childId: str(120),
  plans: list(planRule, 2000),
  practice: list(practiceRule, 6000),
  visits: list(visitRule, 6000),
  evidenceLimits: list(str(800), 16),
};
function familyIdentity(
  value: { corpusVersion: string; childId?: string; installationId?: string },
  scope: CorpusCatalogScope,
  current = false,
) {
  if (
    value.corpusVersion !== scope.corpusVersion ||
    (value.childId !== undefined && value.childId !== scope.childId) ||
    (current && value.installationId !== scope.installationId)
  )
    throw new CorpusApiError(401, 'IDENTITY_CHANGED');
}
export function normalizeCorpusPlacement(
  value: unknown,
  scope: CorpusCatalogScope,
): CorpusPlacementResponse {
  const r = decode<CorpusPlacementResponse>(value, {
    setupComplete: bool,
    proposal: nullable(proposalRule),
    reason: nullable(str(800)),
  });
  if (r.proposal) familyIdentity(r.proposal, scope, true);
  return r;
}
export function normalizeCorpusPlans(
  value: unknown,
  scope: CorpusCatalogScope,
): CorpusPlanResponse {
  const r = decode<CorpusPlanResponse>(value, {
    plan: nullable(planRule),
    history: list(planRule, 2000),
  });
  if (r.plan) familyIdentity(r.plan, scope, true);
  for (const p of r.history) {
    familyIdentity(p, scope);
    if (
      p.installationId !== scope.installationId &&
      (p.available || p.items.some((i) => i.available))
    )
      throw new CorpusApiError(502, 'INVALID_RESPONSE');
  }
  return r;
}
export function normalizeCorpusPractice(
  value: unknown,
  scope: CorpusCatalogScope,
): CorpusPracticeResponse {
  const r = decode<CorpusPracticeResponse>(value, {
    items: list(practiceRule, 6000),
    primary: primaryRule,
  });
  for (const i of r.items) {
    familyIdentity(i, scope);
    if (i.installationId !== scope.installationId && i.available)
      throw new CorpusApiError(502, 'INVALID_RESPONSE');
  }
  if (
    r.primary.kind !== 'prepare' &&
    !r.items.some(
      (i) =>
        i.assignmentId === r.primary.assignmentId &&
        i.scheduleId === r.primary.scheduleId &&
        i.runId === r.primary.runId &&
        i.installationId === scope.installationId &&
        i.available,
    )
  )
    throw new CorpusApiError(502, 'INVALID_RESPONSE');
  return r;
}
export function normalizeCorpusProgress(
  value: unknown,
  scope: CorpusCatalogScope,
): CorpusProgress[] {
  const r = decode<CorpusProgress[]>(value, list(progressRule, 1000));
  const keys = new Set<string>();
  for (const g of r) {
    familyIdentity(g, scope);
    const key = JSON.stringify([g.corpusVersion, g.installationId]);
    if (keys.has(key)) throw new CorpusApiError(502, 'INVALID_RESPONSE');
    keys.add(key);
    for (const p of g.plans)
      if (
        p.childId !== g.childId ||
        p.installationId !== g.installationId ||
        p.corpusVersion !== g.corpusVersion ||
        p.corpusId !== g.corpusId ||
        p.corpusDigest !== g.corpusDigest ||
        p.items.some(
          (i) =>
            i.corpusVersion !== g.corpusVersion ||
            i.corpusId !== g.corpusId ||
            i.corpusDigest !== g.corpusDigest,
        )
      )
        throw new CorpusApiError(502, 'INVALID_RESPONSE');
    for (const item of [...g.practice, ...g.visits])
      if (
        item.installationId !== g.installationId ||
        item.corpusVersion !== g.corpusVersion ||
        item.corpusId !== g.corpusId ||
        item.corpusDigest !== g.corpusDigest
      )
        throw new CorpusApiError(502, 'INVALID_RESPONSE');
  }
  return r;
}
/** Explicit known corpus only; /me guards scope before and after every request. */
export function createCorpusFamilyClient(
  me: PilotMe,
  corpusVersion: string,
  {
    request = pilotRequest,
    verify = async (child: string) => {
      const current = await getPilotMe();
      return (
        !hasPendingSignOut() &&
        current.installationId === me.installationId &&
        current.user.id === me.user.id &&
        current.user.role === me.user.role &&
        !current.user.mustChangePassword &&
        (current.user.role === 'child'
          ? current.user.id === child
          : current.children.some((c) => c.id === child))
      );
    },
  }: {
    request?: typeof pilotRequest;
    verify?: (child: string) => Promise<boolean>;
  } = {},
) {
  if (!str(120)(corpusVersion))
    throw new CorpusApiError(400, 'INVALID_REQUEST');
  const route = (child: string, suffix: string) =>
    `/api/pilot/children/${encodeURIComponent(child)}/${suffix}`;
  const query = `?corpusVersion=${encodeURIComponent(corpusVersion)}`;
  const scope = (child: string): CorpusCatalogScope => ({
    accountId: me.user.id,
    installationId: me.installationId,
    childId: child,
    corpusVersion,
  });
  async function call(child: string, suffix: string, body?: unknown) {
    if (hasPendingSignOut() || !(await verify(child)))
      throw new CorpusApiError(401, 'IDENTITY_CHANGED');
    const v = await request(route(child, suffix), {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
    });
    if (hasPendingSignOut() || !(await verify(child)))
      throw new CorpusApiError(401, 'IDENTITY_CHANGED');
    return v;
  }
  const parent = () => {
    if (me.user.role !== 'parent') throw new CorpusApiError(403, 'FORBIDDEN');
  };
  return {
    verify,
    scope,
    placement: async (child: string) =>
      normalizeCorpusPlacement(
        await call(child, 'placement' + query),
        scope(child),
      ),
    plan: async (child: string) =>
      normalizeCorpusPlans(await call(child, 'plan' + query), scope(child)),
    practice: async (child: string) =>
      normalizeCorpusPractice(
        await call(child, 'practice' + query),
        scope(child),
      ),
    async propose(child: string, input: CorpusProposalInput) {
      parent();
      const body = decode<CorpusProposalInput>(input, {
        corpusVersion: str(120),
        selection: nullable({
          lessonVersion: str(120),
          contentDigest: digest,
          releaseId: str(120),
          releaseRevision: integer,
        }),
        predecessorProposalId: nullable(str(120)),
        expectedSourceDigest: nullable(digest),
      });
      if (
        body.corpusVersion !== corpusVersion ||
        body.selection?.releaseRevision === 0
      )
        throw new CorpusApiError(400, 'INVALID_REQUEST');
      const raw = await call(child, 'catalog/proposals', body),
        r = decode<{ proposal: CorpusProposal }>(raw, {
          proposal: proposalRule,
        });
      familyIdentity(r.proposal, scope(child), true);
      return r;
    },
    async approve(
      child: string,
      input: { proposalId: string; sourceDigest: string },
    ) {
      parent();
      const body = decode<typeof input>(input, {
        proposalId: str(120),
        sourceDigest: digest,
      });
      const r = decode<{ plan: CorpusPlan }>(
        await call(child, 'placement/approve', body),
        { plan: planRule },
      );
      familyIdentity(r.plan, scope(child), true);
      return r;
    },
    async progress(child: string) {
      const raw = copied(await call(child, 'progress')) as Record<
        string,
        unknown
      >;
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        !Object.hasOwn(raw, 'corpora') ||
        !Array.isArray(raw.corpora)
      )
        throw new CorpusApiError(502, 'INVALID_RESPONSE');
      const filtered = raw.corpora.filter(
        (g) =>
          g &&
          typeof g === 'object' &&
          (g as Record<string, unknown>).corpusVersion === corpusVersion,
      );
      return normalizeCorpusProgress(filtered, scope(child));
    },
    async export(child: string) {
      parent();
      const raw = copied(await call(child, 'export')) as Record<
        string,
        unknown
      >;
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        !Array.isArray(raw.corpora)
      )
        throw new CorpusApiError(502, 'INVALID_RESPONSE');
      normalizeCorpusProgress(
        raw.corpora.filter(
          (g) =>
            g &&
            typeof g === 'object' &&
            (g as Record<string, unknown>).corpusVersion === corpusVersion,
        ),
        scope(child),
      );
      return raw;
    },
  };
}
