/** Browser-only R5 wire/recovery boundary. No package compiler, reducer or grading imports. */
import { inspectJson } from './curriculum/json.ts';
import {
  getPilotMe,
  hasPendingSignOut,
  pilotRequest,
  type PilotMe,
} from './pilot-client.ts';
import type {
  CollectionAction,
  CollectionAck,
  CollectionRunView,
  CollectionPackageIdentity,
  CollectionLibraryResponse,
  CollectionPlacementResponse,
  CollectionProposalResponse,
  CollectionApproveResponse,
  CollectionPlanResponse,
  CollectionPracticeResponse,
  CollectionProgress,
  CollectionProposalInput,
} from './curriculum/collection-types.ts';
export const COLLECTION_VERSION = 'little-hanzi-path-1-v1';
export type CollectionScope = CollectionPackageIdentity & {
  installationId: string;
  accountId: string;
  childId: string;
  assignmentId: string;
  scheduleId: string;
  publicationId: string;
};
export class CollectionApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(
    status: number,
    code: string,
    message = 'Your learning could not be loaded. Retry.',
  ) {
    super(message);
    this.name = 'CollectionApiError';
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
    throw new CollectionApiError(502, 'INVALID_RESPONSE');
  return r.value;
}
function decode<T>(value: unknown, rule: Rule): T {
  const r = copied(value);
  if (!accepts(r, rule)) throw new CollectionApiError(502, 'INVALID_RESPONSE');
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
  collectionId: str(80),
  collectionVersion: str(80),
  collectionDigest: digest,
  lessonId: str(80),
  lessonVersion: str(80),
  contentDigest: digest,
  adapterId: enumOf('paired-story'),
  adapterVersion: enumOf('paired-story-v1'),
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
  schemaVersion: enumOf('r5-story-view-1'),
  runId: str(120),
  assignmentId: str(120),
  scheduleId: str(120),
  publicationId: str(120),
  publicationGeneration: integer,
  installationId: str(120),
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
export function normalizeCollectionRun(
  value: unknown,
  scope: CollectionScope,
): CollectionRunView {
  const r = decode<CollectionRunView>(value, runRule);
  for (const key of [
    'installationId',
    'childId',
    'assignmentId',
    'scheduleId',
    'publicationId',
    'collectionId',
    'collectionVersion',
    'collectionDigest',
    'lessonId',
    'lessonVersion',
    'contentDigest',
    'adapterId',
    'adapterVersion',
  ] as const)
    if (r[key] !== scope[key])
      throw new CollectionApiError(
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
    throw new CollectionApiError(502, 'INVALID_RESPONSE');
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
    throw new CollectionApiError(502, 'INVALID_RESPONSE');
  const invalid = () => {
    throw new CollectionApiError(502, 'INVALID_RESPONSE');
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
const library = {
  ...identity,
  title: str(120),
  targets: list({ characterId: str(80), hanzi: str(8) }, 2, 2),
  trackId: str(80),
  sequence: integer,
  publicationId: nullable(str(120)),
  generation: nullable(integer),
  available: bool,
  reason: nullable(str(800)),
  assignmentId: nullable(str(120)),
  completed: bool,
};
const proposal = {
  ...identity,
  proposalId: str(120),
  childId: str(120),
  installationId: str(120),
  predecessorProposalId: nullable(str(120)),
  selectionOrdinal: integer,
  publicationId: str(120),
  generation: integer,
  sourceDigest: digest,
  reason: str(800),
  selectedByParent: bool,
  createdAt: date,
  expiresAt: date,
};
const plan = {
  collectionId: str(80),
  collectionVersion: str(80),
  collectionDigest: digest,
  planId: str(120),
  proposalId: str(120),
  childId: str(120),
  installationId: str(120),
  approvedAt: date,
  available: bool,
  reason: nullable(str(800)),
  items: list({ ...library, planItemId: str(120), ordinal: enumOf(0) }, 1, 1),
};
const practice = {
  ...identity,
  assignmentId: str(120),
  scheduleId: str(120),
  runId: nullable(str(120)),
  publicationId: str(120),
  generation: integer,
  kind: phase,
  dueAt: date,
  available: bool,
  reason: nullable(str(800)),
  stepId: nullable(step),
};
const primary = (v: unknown) =>
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
const progress = {
  schemaVersion: enumOf('r5-family-progress-1'),
  collectionId: str(80),
  collectionVersion: str(80),
  collectionDigest: digest,
  installationId: str(120),
  childId: str(120),
  plans: list(plan),
  practice: list(practice, 300),
  visits: list(
    {
      ...identity,
      assignmentId: str(120),
      scheduleId: str(120),
      runId: nullable(str(120)),
      publicationId: str(120),
      phase,
      dueAt: date,
      completedAt: nullable(date),
      introducedTargets: list(str(80), 2),
      recap: nullable(recap),
    },
    300,
  ),
  evidenceLimits: list(str(800), 16),
};
export function createCollectionClient(
  me: PilotMe,
  {
    request = pilotRequest,
    verify = async (child?: string) => {
      const current = await getPilotMe();
      return (
        !hasPendingSignOut() &&
        current.user.id === me.user.id &&
        current.user.role === me.user.role &&
        (!child ||
          (current.user.role === 'child'
            ? current.user.id === child
            : current.children.some((linked) => linked.id === child))) &&
        current.installationId === me.installationId &&
        !current.user.mustChangePassword
      );
    },
  }: {
    request?: typeof pilotRequest;
    verify?: (child?: string) => Promise<boolean>;
  } = {},
) {
  async function call<T>(path: string, rule: Rule, body?: unknown): Promise<T> {
    const childMatch = /^\/api\/pilot\/children\/([^/]+)\//.exec(path);
    const child = childMatch ? decodeURIComponent(childMatch[1]) : undefined;
    if (hasPendingSignOut() || !(await verify(child)))
      throw new CollectionApiError(401, 'IDENTITY_CHANGED');
    const v = await request(path, {
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!(await verify(child)))
      throw new CollectionApiError(401, 'IDENTITY_CHANGED');
    return decode<T>(v, rule);
  }
  const route = (child: string, suffix: string) =>
    `/api/pilot/children/${encodeURIComponent(child)}/${suffix}`;
  const query = `?collectionVersion=${encodeURIComponent(COLLECTION_VERSION)}`;
  return {
    library: (child: string) =>
      call<CollectionLibraryResponse>(route(child, 'library') + query, {
        items: list(library, 100),
      }),
    placement: (child: string) =>
      call<CollectionPlacementResponse>(route(child, 'placement') + query, {
        setupComplete: bool,
        proposal: nullable(proposal),
        reason: nullable(str(800)),
      }),
    propose: (child: string, input: CollectionProposalInput) =>
      call<CollectionProposalResponse>(
        route(child, 'placement/proposals'),
        { proposal },
        input,
      ),
    approve: (child: string, p: { proposalId: string; sourceDigest: string }) =>
      call<CollectionApproveResponse>(
        route(child, 'placement/approve'),
        { plan },
        p,
      ),
    plan: (child: string) =>
      call<CollectionPlanResponse>(route(child, 'plan') + query, {
        plan: nullable(plan),
        history: list(plan),
      }),
    practice: (child: string) =>
      call<CollectionPracticeResponse>(route(child, 'practice') + query, {
        items: list(practice, 300),
        primary,
      }),
    async progress(child: string): Promise<CollectionProgress[]> {
      const v = await call<Record<string, unknown>>(
        route(child, 'progress'),
        (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x),
      );
      const result = decode<CollectionProgress[]>(
        v.collections ?? [],
        list(progress, 100),
      );
      if (
        result.some(
          (p) => p.childId !== child || p.installationId !== me.installationId,
        )
      )
        throw new CollectionApiError(401, 'IDENTITY_CHANGED');
      return result;
    },
    async export(child: string) {
      const v = await call<Record<string, unknown>>(
        route(child, 'export'),
        (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x),
      );
      decode(v.collections ?? [], list(progress, 100));
      return v;
    },
    collections: () =>
      call<{
        items: Array<{
          collectionId: string;
          collectionVersion: string;
          collectionDigest: string;
          trackId: string;
          lessonCount: number;
          importedAt: string;
        }>;
      }>('/api/pilot/collections', {
        items: list({
          collectionId: str(80),
          collectionVersion: str(80),
          collectionDigest: digest,
          trackId: str(80),
          lessonCount: integer,
          importedAt: date,
        }),
      }),
    register: (collection: unknown) =>
      call<{ collectionVersion: string; collectionDigest: string }>(
        '/api/pilot/collections',
        { collectionVersion: str(80), collectionDigest: digest },
        { collection },
      ),
  };
}
export interface CollectionTransport {
  start: () => Promise<unknown>;
  get: (runId: string) => Promise<unknown>;
  send: (runId: string, action: CollectionAction) => Promise<CollectionAck>;
}
export function createCollectionTransport(
  scope: CollectionScope,
  {
    request = pilotRequest,
    verify,
    startId,
  }: {
    request?: typeof pilotRequest;
    verify: () => Promise<boolean>;
    startId: () => string;
  },
): CollectionTransport {
  let started: { runId: string } | null = null;
  async function call(path: string, body?: unknown) {
    if (!(await verify()))
      throw new CollectionApiError(401, 'IDENTITY_CHANGED');
    const v = await request(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
    });
    if (!(await verify()))
      throw new CollectionApiError(401, 'IDENTITY_CHANGED');
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
          throw new CollectionApiError(401, 'IDENTITY_CHANGED');
        started = ack;
      }
      return call(runPath(started.runId));
    },
    get: (id) => call(runPath(id)),
    async send(id, a) {
      return decode<{ ack: CollectionAck; replayed: boolean }>(
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
export interface CollectionPending {
  runId: string;
  action: CollectionAction;
}
export interface CollectionRecovery {
  available: () => boolean;
  startId: () => string;
  read: (runId: string) => CollectionPending[];
  write: (runId: string, pending: CollectionPending[]) => boolean;
  clear: () => void;
}
export function collectionRecoveryKey(scope: CollectionScope) {
  return (
    'little-hanzi:pilot:collection:' +
    Object.keys(scope)
      .sort()
      .map((key) => encodeURIComponent(scope[key as keyof CollectionScope]))
      .join(':')
  );
}
export function createCollectionRecovery(
  scope: CollectionScope,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  id = () => crypto.randomUUID(),
): CollectionRecovery {
  const prefix = collectionRecoveryKey(scope),
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
        const v = decode<{ identity: string; pending: CollectionPending[] }>(
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
export type CollectionSaveState =
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
export interface CollectionSnapshot {
  run: CollectionRunView | null;
  pending: CollectionPending[];
  status: CollectionSaveState;
  notice: string;
  reportReady: boolean;
  conflictReady: boolean;
  storageAvailable: boolean;
}
export function createCollectionSession({
  scope,
  transport,
  recovery,
  verify,
  onChange = () => {},
  id = () => crypto.randomUUID(),
}: {
  scope: CollectionScope;
  transport: CollectionTransport;
  recovery: CollectionRecovery;
  verify: () => Promise<boolean>;
  onChange?: (s: CollectionSnapshot) => void;
  id?: () => string;
}) {
  let run: CollectionRunView | null = null,
    pending: CollectionPending[] = [],
    status: CollectionSaveState = 'idle',
    notice = '',
    reportReady = true,
    conflictReady = false,
    dead = false,
    epoch = 0,
    readSequence = 0;
  let draining: Promise<void> | null = null;
  const acknowledgedAnswers = new Set<string>();
  const snapshot = (): CollectionSnapshot => ({
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
      run = normalizeCollectionRun(value, scope);
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
      run = normalizeCollectionRun(value, scope);
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
            const checked = decode<CollectionAck>(a, ack);
            if (
              checked.eventId !== item.action.eventId ||
              checked.revision !== item.action.expectedRevision + 1
            )
              throw new CollectionApiError(502, 'INVALID_ACK');
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
    type: CollectionAction['type'],
    payload: Record<string, unknown>,
    occurrenceId: string | null,
  ) {
    if (!run) return;
    const action: CollectionAction = {
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
      type: CollectionAction['type'],
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
