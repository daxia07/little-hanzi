/** Browser-only operations transport and memory-only write recovery. No server validators. */
import { PilotApiError, type PilotMe } from './pilot-client.ts';
import type * as Ops from './pilot-ops-types.ts';
export type {
  OpsObservation,
  OpsReceipt,
  OpsDetail,
  OpsSummary,
} from './pilot-ops-types.ts';
const CATEGORIES = ['confusion', 'sound', 'saving', 'access', 'other'];
const SEVERITIES = ['blocking', 'high', 'normal', 'low'];
const STATES = [
  'open',
  'in-progress',
  'awaiting-review',
  'resolved',
  'expired',
];
const ALERTS = [
  'OPS_BACKUP_FAILED',
  'OPS_PROBE_FAILED',
  'OPS_BACKUP_STALE',
  'OPS_MONITOR_UNKNOWN',
  'OPS_NOTIFICATION_FAILED',
  'OPS_RETENTION_FAILED',
];
const JOBS = ['backup', 'monitor', 'retention', 'reconcile'];
const NOTIFICATIONS = ['unconfigured', 'delivered', 'failed'];
const AC =
  /^(?:R4-(?:E-0(?:0[1-9]|1[0-5])|AC-00[1-5])|S1-AC-0(?:0[1-9]|1[0-9]|2[0-3])|S2-AC-0(?:0[1-9]|1[0-2]))$/;
export class OpsApiError extends PilotApiError {
  readonly unknown: boolean;
  readonly currentRevision: number | null;
  readonly refreshRequired: boolean;
  constructor(
    status: number,
    code: string,
    {
      unknown = false,
      currentRevision = null,
      refreshRequired = false,
    }: {
      unknown?: boolean;
      currentRevision?: number | null;
      refreshRequired?: boolean;
    } = {},
  ) {
    const messages: Record<string, string> = {
      OPS_UNAVAILABLE:
        'Operations are unavailable. Monitoring status is unknown. Your learning can continue.',
      OPS_CONFLICT:
        'A newer change is saved. Refresh the record before reviewing your draft.',
      OPS_CURSOR_STALE:
        'The queue changed. Refresh to load the current records.',
      OPS_DETAILS_EXPIRED:
        'Details have been removed. This record cannot be changed.',
      OPS_HISTORY_ONLY:
        'This is historical information. It cannot be changed here.',
      INVALID_RESPONSE:
        'The service returned an incomplete operations response. Refresh and try again.',
      INVALID_REQUEST: 'Check the details and try again.',
      LOCKED: 'This account view has closed. Sign in again.',
      NETWORK: 'The service could not be reached. Retry when connected.',
    };
    super(
      status,
      messages[code] ??
        (status === 401
          ? 'Your session has ended. Sign in again.'
          : status === 403
            ? 'You do not have permission for this action.'
            : status === 404
              ? 'That record is no longer available.'
              : status === 429
                ? 'Too many attempts. Wait a moment and retry.'
                : 'The operation could not be completed. Retry when connected.'),
      code,
    );
    this.unknown = unknown;
    this.currentRevision = currentRevision;
    this.refreshRequired = refreshRequired;
  }
}
function invalid(): never {
  throw new OpsApiError(502, 'INVALID_RESPONSE');
}
function check(value: unknown): asserts value {
  if (!value) invalid();
}
type JsonRecord = Record<string, unknown>;
function obj(v: unknown): v is JsonRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function exact(v: unknown, keys: string[]): v is JsonRecord {
  return (
    obj(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
function text(v: unknown, max = 120, empty = false): v is string {
  return (
    typeof v === 'string' &&
    v.isWellFormed() &&
    Array.from(v).length <= max &&
    (empty || v.trim().length > 0)
  );
}
const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v);
const integer = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const enumeration = (v: unknown, values: string[]) =>
  typeof v === 'string' && values.includes(v);
const nullable = (v: unknown, valid: (v: unknown) => boolean) =>
  v === null || valid(v);
const array = (
  v: unknown,
  max: number,
  valid: (v: unknown) => boolean,
  min = 0,
) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(valid);
const digest = (v: unknown) =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const cursor = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(v);
const bool = (v: unknown) => typeof v === 'boolean';
/** Never read a getter from a supplied response or draft. Shape checks use this copy. */
function safeJson(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0,
    units = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 24) invalid();
    if (
      v === null ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return v;
    if (typeof v === 'string') {
      units += v.length;
      if (!v.isWellFormed() || v.length > 16384 || units > 524288) invalid();
      return v;
    }
    if (!obj(v) && !Array.isArray(v)) invalid();
    if (seen.has(v)) invalid();
    const a = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (
      proto !== (a ? Array.prototype : Object.prototype) &&
      !(proto === null && !a)
    )
      invalid();
    seen.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.length > 20000) invalid();
    const length = a ? Object.getOwnPropertyDescriptor(v, 'length') : null;
    if (
      a &&
      (!length ||
        !Object.hasOwn(length, 'value') ||
        !integer(length.value) ||
        length.value > 20000)
    )
      invalid();
    const result: JsonRecord | unknown[] = a ? [] : {};
    let count = 0;
    for (const key of keys) {
      if (a && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        invalid();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) invalid();
      units += key.length;
      if (units > 524288 || (a && key !== String(count))) invalid();
      Object.defineProperty(result, key, {
        value: copy(d.value, depth + 1),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      count++;
    }
    if (a && count !== length?.value) invalid();
    seen.delete(v);
    return result;
  };
  try {
    const copied = copy(value, 0);
    if (new TextEncoder().encode(JSON.stringify(copied)).length > 524288)
      invalid();
    return copied;
  } catch {
    invalid();
  }
}
const RECEIPT = ['requestId', 'recordId', 'revision', 'recordedAt'];
function receipt(v: unknown): v is Ops.OpsReceipt {
  return (
    exact(v, RECEIPT) &&
    id(v.requestId) &&
    id(v.recordId) &&
    integer(v.revision, 1) &&
    integer(v.recordedAt)
  );
}
const OBS = [
  'kind',
  'participantLabel',
  'candidateId',
  'lessonVersion',
  'contentDigest',
  'observedAt',
  'device',
  'browser',
  'parentAgreementRef',
  'tasks',
  'completion',
  'savedRecapRef',
  'adultHelp',
  'interruptions',
  'observedBehavior',
  'observerInterpretation',
  'laterRecall',
];
function observation(v: unknown): v is Ops.OpsObservation {
  if (
    !exact(v, OBS) ||
    !enumeration(v.kind, ['actual', 'synthetic']) ||
    !text(v.participantLabel, 40) ||
    !id(v.candidateId) ||
    !id(v.lessonVersion) ||
    !digest(v.contentDigest) ||
    !integer(v.observedAt) ||
    !text(v.device) ||
    !text(v.browser) ||
    !text(v.parentAgreementRef, 240) ||
    !array(v.tasks, 20, (x) => text(x), 1) ||
    !enumeration(v.completion, ['not-started', 'partial', 'ended']) ||
    !nullable(v.savedRecapRef, (x) => text(x, 240)) ||
    ![
      'adultHelp',
      'interruptions',
      'observedBehavior',
      'observerInterpretation',
    ].every((k) => text(v[k], 1000, true))
  )
    return false;
  const recall = v.laterRecall;
  return (
    (exact(recall, ['status']) && recall.status === 'not-run') ||
    (exact(recall, [
      'status',
      'observedAt',
      'evidenceRef',
      'adultHelp',
      'observation',
    ]) &&
      recall.status === 'observed' &&
      integer(recall.observedAt) &&
      recall.observedAt >= v.observedAt &&
      text(recall.evidenceRef, 240) &&
      text(recall.adultHelp, 1000, true) &&
      text(recall.observation, 1000, true))
  );
}
const SUMMARY = [
  'id',
  'kind',
  'revision',
  'createdAt',
  'updatedAt',
  'candidateId',
  'lessonId',
  'lessonVersion',
  'contentDigest',
  'buildId',
  'submissionBuildId',
  'category',
  'severity',
  'ownerRef',
  'status',
  'nextReviewAt',
  'detailsRemoved',
  'historical',
  'readOnly',
];
function summary(v: unknown, withDetail = false): v is Ops.OpsSummary {
  if (!obj(v)) return false;
  return (
    (withDetail ? obj(v) : exact(v, SUMMARY)) &&
    [
      'id',
      'candidateId',
      'lessonId',
      'lessonVersion',
      'buildId',
      'submissionBuildId',
    ].every((k) => id(v[k])) &&
    enumeration(v.kind, ['feedback', 'observation']) &&
    integer(v.revision, 1) &&
    integer(v.createdAt) &&
    integer(v.updatedAt) &&
    v.updatedAt >= v.createdAt &&
    digest(v.contentDigest) &&
    nullable(v.category, (x) => enumeration(x, CATEGORIES)) &&
    enumeration(v.severity, SEVERITIES) &&
    nullable(v.ownerRef, (x) => text(x)) &&
    enumeration(v.status, STATES) &&
    nullable(v.nextReviewAt, integer) &&
    bool(v.detailsRemoved) &&
    bool(v.historical) &&
    bool(v.readOnly) &&
    (!v.historical || v.readOnly === true) &&
    (!v.detailsRemoved ||
      (v.status === 'expired' &&
        v.ownerRef === null &&
        v.nextReviewAt === null &&
        v.readOnly === true))
  );
}
function history(v: unknown): v is Ops.OpsHistory {
  if (
    !exact(v, [
      'id',
      'sequence',
      'kind',
      'recordedAt',
      'actorUserId',
      'receipt',
      'public',
      'private',
      'detailsRemoved',
    ]) ||
    !id(v.id) ||
    !integer(v.sequence, 1) ||
    !enumeration(v.kind, ['submitted', 'triaged', 'corrected', 'redacted']) ||
    !integer(v.recordedAt) ||
    !nullable(v.actorUserId, id) ||
    !receipt(v.receipt) ||
    !bool(v.detailsRemoved)
  )
    return false;
  const p = v.public;
  if (
    !exact(p, [
      'status',
      'severity',
      'nextReviewAt',
      'acIds',
      'observationKind',
      'observedAt',
      'completion',
      'laterRecallStatus',
    ]) ||
    !enumeration(p.status, STATES) ||
    !enumeration(p.severity, SEVERITIES) ||
    !nullable(p.nextReviewAt, integer) ||
    !array(p.acIds, 8, (x) => typeof x === 'string' && AC.test(x)) ||
    !nullable(p.observationKind, (x) =>
      enumeration(x, ['actual', 'synthetic']),
    ) ||
    !nullable(p.observedAt, integer) ||
    !nullable(p.completion, (x) =>
      enumeration(x, ['not-started', 'partial', 'ended']),
    ) ||
    !nullable(p.laterRecallStatus, (x) =>
      enumeration(x, ['not-run', 'observed']),
    )
  )
    return false;
  if (v.detailsRemoved) return v.private === null;
  return (
    v.private === null ||
    (exact(v.private, [
      'ownerRef',
      'disposition',
      'retestRef',
      'correctionReason',
      'observation',
    ]) &&
      nullable(v.private.ownerRef, (x) => text(x)) &&
      text(v.private.disposition, 1000, true) &&
      nullable(v.private.retestRef, (x) => text(x, 240)) &&
      nullable(v.private.correctionReason, (x) => text(x, 1000)) &&
      nullable(v.private.observation, observation))
  );
}
function detail(v: unknown): v is Ops.OpsDetail {
  if (
    !exact(v, [
      ...SUMMARY,
      'childId',
      'runId',
      'runInstallationId',
      'sourceRole',
      'observationKind',
      'details',
      'history',
      'historyRevision',
      'nextCursor',
    ]) ||
    !summary(v, true) ||
    !['childId', 'runId', 'runInstallationId'].every((k) =>
      nullable(v[k], id),
    ) ||
    !enumeration(v.sourceRole, ['parent', 'operator']) ||
    !nullable(v.observationKind, (x) =>
      enumeration(x, ['actual', 'synthetic']),
    ) ||
    !array(v.history, 20, history) ||
    !integer(v.historyRevision, 1) ||
    !nullable(v.nextCursor, cursor)
  )
    return false;
  if (v.detailsRemoved)
    return (
      v.details === null &&
      Array.isArray(v.history) &&
      v.history.every(
        (h: Ops.OpsHistory) => h.private === null && h.detailsRemoved,
      )
    );
  return v.kind === 'feedback'
    ? exact(v.details, ['observed', 'expected']) &&
        text(v.details.observed, 1000) &&
        text(v.details.expected, 1000, true)
    : exact(v.details, ['observation']) && observation(v.details.observation);
}
function job(v: unknown): v is Ops.OpsJob {
  return (
    exact(v, [
      'id',
      'kind',
      'revision',
      'status',
      'startedAt',
      'endedAt',
      'errorCode',
      'acknowledgedOperationId',
      'buildId',
      'historical',
      'archives',
    ]) &&
    id(v.id) &&
    enumeration(v.kind, JOBS) &&
    integer(v.revision, 1) &&
    enumeration(v.status, ['running', 'uncertain', 'succeeded', 'failed']) &&
    integer(v.startedAt) &&
    nullable(v.endedAt, integer) &&
    nullable(v.errorCode, (x) =>
      enumeration(x, [...ALERTS, 'OPS_JOB_FAILED', 'OPS_EFFECT_UNCONFIRMED']),
    ) &&
    id(v.acknowledgedOperationId) &&
    id(v.buildId) &&
    bool(v.historical) &&
    array(
      v.archives,
      2,
      (a) =>
        exact(a, [
          'id',
          'kind',
          'plaintextDigest',
          'ciphertextDigest',
          'byteSize',
          'keyId',
          'verifiedAt',
        ]) &&
        id(a.id) &&
        enumeration(a.kind, ['learning', 'operations']) &&
        digest(a.plaintextDigest) &&
        digest(a.ciphertextDigest) &&
        integer(a.byteSize) &&
        id(a.keyId) &&
        integer(a.verifiedAt),
    )
  );
}
function alert(v: unknown): v is Ops.OpsAlert {
  return (
    exact(v, [
      'id',
      'revision',
      'code',
      'status',
      'createdAt',
      'updatedAt',
      'jobId',
      'acknowledgedBy',
      'acknowledgedAt',
      'notification',
      'historical',
    ]) &&
    id(v.id) &&
    integer(v.revision, 1) &&
    enumeration(v.code, ALERTS) &&
    enumeration(v.status, ['open', 'acknowledged', 'resolved']) &&
    integer(v.createdAt) &&
    integer(v.updatedAt) &&
    nullable(v.jobId, id) &&
    nullable(v.acknowledgedBy, id) &&
    nullable(v.acknowledgedAt, integer) &&
    enumeration(v.notification, NOTIFICATIONS) &&
    bool(v.historical)
  );
}
function status(v: unknown): v is Ops.OpsStatus {
  return (
    exact(v, [
      'monitorState',
      'targets',
      'lastVerifiedBackupAt',
      'lastBackupDataAt',
      'backupAgeMs',
      'lastMonitorAt',
      'notification',
      'jobs',
      'alerts',
    ]) &&
    enumeration(v.monitorState, ['healthy', 'unhealthy', 'unknown']) &&
    exact(v.targets, [
      'dailyAtUtc',
      'dailyPoints',
      'weeklyPoints',
      'freshnessMs',
      'feedbackRetentionMs',
    ]) &&
    v.targets.dailyAtUtc === '02:00' &&
    v.targets.dailyPoints === 7 &&
    v.targets.weeklyPoints === 4 &&
    v.targets.freshnessMs === 93600000 &&
    v.targets.feedbackRetentionMs === 2592000000 &&
    [
      'lastVerifiedBackupAt',
      'lastBackupDataAt',
      'backupAgeMs',
      'lastMonitorAt',
    ].every((k) => nullable(v[k], integer)) &&
    enumeration(v.notification, NOTIFICATIONS) &&
    array(v.jobs, 20, job) &&
    array(v.alerts, 6, alert) &&
    (v.monitorState !== 'healthy' ||
      (['lastVerifiedBackupAt', 'lastBackupDataAt', 'lastMonitorAt'].every(
        (k) => integer(v[k]),
      ) &&
        integer(v.backupAgeMs) &&
        v.backupAgeMs <= 93600000 &&
        Array.isArray(v.alerts) &&
        !v.alerts.some(
          (a) =>
            obj(a) &&
            a.historical === false &&
            a.status !== 'resolved' &&
            [
              'OPS_BACKUP_FAILED',
              'OPS_PROBE_FAILED',
              'OPS_BACKUP_STALE',
            ].includes(String(a.code)),
        )))
  );
}
const ENVELOPE = [
  'schemaVersion',
  'installationId',
  'opsInstallationId',
  'buildId',
  'serverAt',
];
type Views = {
  status: Ops.OpsStatusResponse;
  job: Ops.OpsJobResponse;
  queue: Ops.OpsQueueResponse;
  detail: Ops.OpsDetailResponse;
  history: Ops.OpsHistoryResponse;
};
export function parseOpsView<K extends keyof Views>(
  value: unknown,
  kind: K,
  installationId: string,
): Views[K] {
  const v = safeJson(value);
  const payloads = {
    status: ['status'],
    job: ['job'],
    queue: ['items', 'queueRevision', 'nextCursor'],
    detail: ['record'],
    history: ['items', 'recordId', 'recordRevision', 'nextCursor'],
  };
  check(
    exact(v, [...ENVELOPE, ...payloads[kind]]) &&
      v.schemaVersion === 'r4-ops-view-1' &&
      v.installationId === installationId &&
      id(v.installationId) &&
      nullable(v.opsInstallationId, id) &&
      id(v.buildId) &&
      integer(v.serverAt),
  );
  check(
    kind === 'status'
      ? status(v.status)
      : kind === 'job'
        ? job(v.job)
        : kind === 'detail'
          ? detail(v.record)
          : kind === 'queue'
            ? array(v.items, 50, summary) &&
              integer(v.queueRevision) &&
              nullable(v.nextCursor, cursor)
            : array(v.items, 50, history) &&
              id(v.recordId) &&
              integer(v.recordRevision, 1) &&
              nullable(v.nextCursor, cursor),
  );
  return v as unknown as Views[K];
}
function input(
  value: unknown,
  kind: 'feedback' | 'ack' | 'triage' | 'observation' | 'correction',
): JsonRecord {
  let v: unknown;
  try {
    v = safeJson(value);
  } catch {
    throw new OpsApiError(400, 'INVALID_REQUEST');
  }
  const keys = {
    feedback: ['requestId', 'runId', 'category', 'observed', 'expected'],
    ack: ['requestId', 'expectedRevision'],
    triage: [
      'requestId',
      'expectedRevision',
      'severity',
      'ownerRef',
      'status',
      'acIds',
      'disposition',
      'retestRef',
      'nextReviewAt',
    ],
    observation: ['requestId', 'observation'],
    correction: [
      'requestId',
      'expectedRevision',
      'observation',
      'correctionReason',
    ],
  };
  let valid =
    exact(v, keys[kind]) &&
    typeof v.requestId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v.requestId);
  if (valid && obj(v)) {
    if (kind === 'feedback')
      valid =
        id(v.runId) &&
        enumeration(v.category, CATEGORIES) &&
        text(v.observed, 1000) &&
        text(v.expected, 1000, true);
    else if (kind === 'triage')
      valid =
        integer(v.expectedRevision, 1) &&
        enumeration(v.severity, SEVERITIES) &&
        nullable(v.ownerRef, (x) => text(x)) &&
        enumeration(
          v.status,
          STATES.filter((x) => x !== 'expired'),
        ) &&
        array(v.acIds, 8, (x) => typeof x === 'string' && AC.test(x)) &&
        text(v.disposition, 1000, v.status !== 'resolved') &&
        nullable(v.retestRef, (x) => text(x, 240)) &&
        (v.status !== 'resolved' || text(v.retestRef, 240)) &&
        nullable(v.nextReviewAt, integer);
    else if (kind === 'ack') valid = integer(v.expectedRevision, 1);
    else
      valid =
        observation(v.observation) &&
        (kind !== 'correction' ||
          (integer(v.expectedRevision, 1) && text(v.correctionReason, 1000)));
  }
  if (!valid) throw new OpsApiError(400, 'INVALID_REQUEST');
  return v as JsonRecord;
}
export function createPilotOpsClient(
  me: PilotMe,
  { fetcher = fetch }: { fetcher?: typeof fetch } = {},
) {
  const account = structuredClone(me);
  let dead = false,
    generation = 0;
  const guard = () => {
    if (dead || account.user.mustChangePassword)
      throw new OpsApiError(401, 'LOCKED');
  };
  const operator = () => {
    guard();
    if (account.user.role !== 'operator')
      throw new OpsApiError(403, 'FORBIDDEN');
  };
  async function request(route: string, init: RequestInit = {}) {
    guard();
    const token = generation;
    let response: Response;
    try {
      response = await fetcher(route, {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch {
      if (dead || token !== generation) throw new OpsApiError(401, 'LOCKED');
      throw new OpsApiError(0, 'NETWORK');
    }
    if (dead || token !== generation) throw new OpsApiError(401, 'LOCKED');
    const body = await response.json().catch(() => null);
    if (dead || token !== generation) throw new OpsApiError(401, 'LOCKED');
    if (!response.ok) {
      const v = safeJson(body);
      if (
        obj(v) &&
        v.installationId !== undefined &&
        v.installationId !== account.installationId
      )
        invalid();
      const code =
        obj(v) &&
        obj(v.error) &&
        typeof v.error.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(v.error.code)
          ? v.error.code
          : 'REQUEST_FAILED';
      if (response.status === 401 || response.status === 403) {
        lockPilotOpsControllers();
        if (typeof window !== 'undefined')
          window.dispatchEvent(new Event('little-hanzi:ops-access-ended'));
      }
      throw new OpsApiError(response.status, code, {
        unknown: response.status === 503,
        currentRevision:
          obj(v) && integer(v.currentRevision, 1) ? v.currentRevision : null,
        refreshRequired: obj(v) && v.refreshRequired === true,
      });
    }
    return body;
  }
  const part = (value: string) => {
    if (!id(value)) throw new OpsApiError(400, 'INVALID_REQUEST');
    return encodeURIComponent(value);
  };
  const read = async <K extends keyof Views>(route: string, kind: K) => {
    operator();
    return parseOpsView(await request(route), kind, account.installationId);
  };
  const write = async (
    route: string,
    body: unknown,
    kind: Parameters<typeof input>[1],
    operatorOnly = true,
    expectedRecordId?: string,
  ) => {
    if (operatorOnly) operator();
    const payload = input(body, kind);
    const result = safeJson(
      await request(route, { method: 'POST', body: JSON.stringify(payload) }),
    );
    check(
      receipt(result) &&
        result.requestId === payload.requestId &&
        (expectedRecordId === undefined ||
          result.recordId === expectedRecordId),
    );
    return result;
  };
  function query(
    options: Ops.OpsQueueOptions | Ops.OpsHistoryOptions = {},
    queue = false,
  ) {
    const v = safeJson(options);
    check(obj(v));
    if (
      Object.keys(v).some(
        (k) =>
          !(
            queue ? ['status', 'kind', 'cursor', 'limit'] : ['cursor', 'limit']
          ).includes(k),
      )
    )
      throw new OpsApiError(400, 'INVALID_REQUEST');
    if (
      (v.status !== undefined &&
        !enumeration(v.status, ['active', 'all', ...STATES])) ||
      (v.kind !== undefined &&
        !enumeration(v.kind, ['all', 'feedback', 'observation'])) ||
      (v.cursor !== undefined && !cursor(v.cursor)) ||
      (v.limit !== undefined && (!integer(v.limit, 1) || v.limit > 50))
    )
      throw new OpsApiError(400, 'INVALID_REQUEST');
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(v))
      search.set(key, String(value));
    return search.size ? '?' + search.toString() : '';
  }
  const api = {
    status: () => read('/api/pilot/ops/status', 'status'),
    async job(jobId: string) {
      const result = await read('/api/pilot/ops/jobs/' + part(jobId), 'job');
      check(result.job.id === jobId);
      return result;
    },
    queue: async (options: Ops.OpsQueueOptions = {}) =>
      read('/api/pilot/ops/feedback' + query(options, true), 'queue'),
    async detail(recordId: string) {
      const result = await read(
        '/api/pilot/ops/feedback/' + part(recordId),
        'detail',
      );
      check(result.record.id === recordId);
      return result;
    },
    async history(recordId: string, options: Ops.OpsHistoryOptions = {}) {
      const result = await read(
        '/api/pilot/ops/feedback/' +
          part(recordId) +
          '/history' +
          query(options),
        'history',
      );
      check(result.recordId === recordId);
      return result;
    },
    ack: async (alertId: string, body: Ops.OpsAckInput) =>
      write(
        '/api/pilot/ops/alerts/' + part(alertId) + '/ack',
        body,
        'ack',
        true,
        alertId,
      ),
    triage: async (recordId: string, body: Ops.OpsTriageInput) =>
      write(
        '/api/pilot/ops/feedback/' + part(recordId) + '/triage',
        body,
        'triage',
        true,
        recordId,
      ),
    observation: (body: Ops.OpsObservationInput) =>
      write('/api/pilot/ops/observations', body, 'observation'),
    correct: async (recordId: string, body: Ops.OpsCorrectionInput) =>
      write(
        '/api/pilot/ops/observations/' + part(recordId) + '/corrections',
        body,
        'correction',
        true,
        recordId,
      ),
    async feedback(childId: string, body: Ops.OpsFeedbackInput) {
      guard();
      if (
        account.user.role !== 'parent' ||
        !account.children.some((c) => c.id === childId)
      )
        throw new OpsApiError(403, 'FORBIDDEN');
      return write(
        '/api/pilot/children/' + part(childId) + '/feedback',
        body,
        'feedback',
        false,
      );
    },
    activate() {
      dead = false;
      generation++;
      liveClients.add(api);
    },
    lock() {
      dead = true;
      generation++;
      liveClients.delete(api);
    },
  };
  liveClients.add(api);
  return api;
}
const liveClients = new Set<{ lock: () => void }>();
const liveWrites = new Set<{ lock: () => void }>();
export function lockPilotOpsControllers() {
  for (const api of liveClients) api.lock();
  for (const controller of liveWrites) controller.lock();
}
export type OpsWriteState =
  | 'idle'
  | 'saving'
  | 'retry'
  | 'conflict'
  | 'readback-pending'
  | 'saved'
  | 'locked';
export interface OpsWriteSnapshot<T> {
  state: OpsWriteState;
  receipt: Ops.OpsReceipt | null;
  readback: T | null;
  error: string;
  code: string;
}
export function createOpsWrite<B, T>({
  send,
  read,
  onChange = () => {},
}: {
  send: (body: B) => Promise<Ops.OpsReceipt>;
  read: (receipt: Ops.OpsReceipt | null) => Promise<T>;
  onChange?: (snapshot: OpsWriteSnapshot<T>) => void;
}) {
  let state: OpsWriteState = 'idle',
    pending: B | null = null,
    ack: Ops.OpsReceipt | null = null,
    readback: T | null = null,
    error = '',
    code = '',
    generation = 0;
  const snapshot = (): OpsWriteSnapshot<T> => ({
    state,
    receipt: ack ? structuredClone(ack) : null,
    readback: readback === null ? null : structuredClone(readback),
    error,
    code,
  });
  const emit = () => onChange(snapshot());
  const current = (token: number) => state !== 'locked' && generation === token;
  const failed = (e: unknown) => {
    code =
      e instanceof PilotApiError
        ? e.code
        : obj(e) && typeof e.code === 'string'
          ? e.code
          : 'NETWORK';
    error =
      e instanceof PilotApiError ? e.message : new OpsApiError(0, code).message;
  };
  async function load(token: number, conflict = false) {
    try {
      const saved = await read(ack);
      if (!current(token)) return;
      readback = structuredClone(saved);
      error = '';
      code = '';
      state = conflict ? 'conflict' : 'saved';
    } catch (e) {
      if (!current(token)) return;
      failed(e);
      state = conflict ? 'conflict' : 'readback-pending';
    }
    emit();
  }
  async function sendPending() {
    if (pending === null || state === 'locked') return;
    const token = ++generation;
    state = 'saving';
    error = '';
    emit();
    try {
      const result = await send(structuredClone(pending));
      if (!current(token)) return;
      check(receipt(result));
      ack = structuredClone(result);
      pending = null;
      state = 'readback-pending';
      emit();
      await load(token);
    } catch (e) {
      if (!current(token)) return;
      failed(e);
      if (code === 'INVALID_REQUEST' && obj(e) && e.status === 400) {
        pending = null;
        state = 'idle';
        emit();
        return;
      }
      state =
        code === 'OPS_CONFLICT'
          ? 'conflict'
          : code === 'OPS_DETAILS_EXPIRED' || code === 'OPS_HISTORY_ONLY'
            ? 'conflict'
            : 'retry';
      emit();
    }
  }
  const controller = {
    configure(nextSend: typeof send, nextRead: typeof read) {
      send = nextSend;
      read = nextRead;
    },
    snapshot,
    async submit(body: B) {
      if (state !== 'idle' && state !== 'saved') return;
      try {
        pending = safeJson(body) as B;
      } catch {
        pending = null;
        code = 'INVALID_REQUEST';
        error = new OpsApiError(400, code).message;
        state = 'idle';
        emit();
        return;
      }
      ack = null;
      readback = null;
      await sendPending();
    },
    async retry() {
      if (state === 'retry') await sendPending();
      else if (state === 'readback-pending' || state === 'conflict')
        await load(++generation, state === 'conflict');
    },
    activate() {
      if (state === 'locked') {
        state = 'idle';
        liveWrites.add(controller);
        emit();
      }
    },
    reset() {
      if (state === 'conflict' && readback === null) return;
      if (
        state === 'saving' ||
        state === 'readback-pending' ||
        state === 'retry' ||
        state === 'locked'
      )
        return;
      generation++;
      pending = null;
      ack = null;
      readback = null;
      state = 'idle';
      error = '';
      code = '';
      emit();
    },
    lock() {
      generation++;
      pending = null;
      ack = null;
      readback = null;
      error = '';
      code = '';
      state = 'locked';
      liveWrites.delete(controller);
      emit();
    },
  };
  liveWrites.add(controller);
  return controller;
}
export const newOpsRequestId = () => crypto.randomUUID();
export function opsDate(value: number | null) {
  return value === null
    ? 'Not recorded'
    : new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

export function createOpsReadGuard() {
  let active = false,
    generation = 0;
  return {
    activate() {
      active = true;
      generation++;
    },
    lock() {
      active = false;
      generation++;
    },
    begin() {
      return ++generation;
    },
    capture() {
      return generation;
    },
    current(token: number) {
      return active && token === generation;
    },
  };
}
