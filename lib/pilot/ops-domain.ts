import { inspectJson } from '../curriculum/json.ts';
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import type {
  OpsFeedbackInput,
  OpsTriageInput,
  OpsObservationInput,
  OpsCorrectionInput,
  OpsObservation,
  OpsAckInput,
  OpsJobKind,
  OpsAlertCode,
} from '../pilot-ops-types.ts';
export { canonicalPackage };
export const OPS_RETENTION_MS = 2592000000,
  OPS_FRESHNESS_MS = 93600000,
  OPS_LEASE_MS = 300000;
export const OPS_ALERT_CODES: readonly OpsAlertCode[] = [
  'OPS_BACKUP_FAILED',
  'OPS_PROBE_FAILED',
  'OPS_BACKUP_STALE',
  'OPS_MONITOR_UNKNOWN',
  'OPS_NOTIFICATION_FAILED',
  'OPS_RETENTION_FAILED',
];
export class OpsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly currentRevision?: number;
  constructor(code: string, status = 409, currentRevision?: number) {
    super(code);
    this.name = 'OpsError';
    this.code = code;
    this.status = status;
    this.currentRevision = currentRevision;
  }
}
export function fail(code: string, status = 409, revision?: number): never {
  throw new OpsError(code, status, revision);
}
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export const exact = (
  v: unknown,
  keys: readonly string[],
): v is Record<string, unknown> =>
  object(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export const text = (
  v: unknown,
  min = 1,
  max = 120,
  trim = true,
): v is string =>
  typeof v === 'string' &&
  v.isWellFormed() &&
  Array.from(v).length >= min &&
  Array.from(v).length <= max &&
  (!trim || v.trim() === v) &&
  (!min || v.trim().length > 0);
export const slug = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v);
export const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export const integer = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
export const nullableText = (v: unknown, max = 120): v is string | null =>
  v === null || text(v, 1, max);
export function safeJson(value: unknown, max = 64000): unknown {
  try {
    const r = inspectJson(value);
    if (
      r.errors.length ||
      new TextEncoder().encode(canonicalPackage(r.value)).length > max
    )
      fail('INVALID_REQUEST', 400);
    return JSON.parse(canonicalPackage(r.value));
  } catch {
    fail('INVALID_REQUEST', 400);
  }
}
const valid = <T>(
  value: unknown,
  test: (v: Record<string, unknown>) => boolean,
): T => {
  const v = safeJson(value);
  if (!object(v) || !test(v)) fail('INVALID_REQUEST', 400);
  return v as T;
};
export function parseFeedback(value: unknown): OpsFeedbackInput {
  return valid(
    value,
    (v) =>
      exact(v, ['requestId', 'runId', 'category', 'observed', 'expected']) &&
      slug(v.requestId) &&
      slug(v.runId) &&
      ['confusion', 'sound', 'saving', 'access', 'other'].includes(
        String(v.category),
      ) &&
      text(v.observed, 1, 1000, false) &&
      text(v.expected, 0, 1000, false),
  );
}
const ac = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(?:R4-E-(?:00[1-9]|01[0-5])|R4-AC-00[1-5]|R3-E-(?:00[1-9]|01[0-9]|020)|R3-AC-00[1-8]|R3-P-00[1-8]|S1-AC-(?:00[1-9]|01[0-9]|02[0-3])|S2-AC-(?:00[1-9]|01[0-2])|DR-00[1-7])$/.test(
    v,
  );
export function parseTriage(value: unknown): OpsTriageInput {
  return valid(
    value,
    (v) =>
      exact(v, [
        'requestId',
        'expectedRevision',
        'severity',
        'ownerRef',
        'status',
        'acIds',
        'disposition',
        'retestRef',
        'nextReviewAt',
      ]) &&
      slug(v.requestId) &&
      integer(v.expectedRevision, 1) &&
      ['blocking', 'high', 'normal', 'low'].includes(String(v.severity)) &&
      nullableText(v.ownerRef) &&
      ['open', 'in-progress', 'awaiting-review', 'resolved'].includes(
        String(v.status),
      ) &&
      Array.isArray(v.acIds) &&
      v.acIds.length <= 8 &&
      v.acIds.every(ac) &&
      new Set(v.acIds).size === v.acIds.length &&
      text(v.disposition, 0, 1000, false) &&
      nullableText(v.retestRef, 240) &&
      (v.nextReviewAt === null || integer(v.nextReviewAt)) &&
      (v.status !== 'resolved' ||
        (text(v.disposition, 1, 1000, false) && v.retestRef !== null)),
  );
}
export function validObservation(v: unknown, now: number): v is OpsObservation {
  if (
    !exact(v, [
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
    ])
  )
    return false;
  if (
    !['actual', 'synthetic'].includes(String(v.kind)) ||
    !text(v.participantLabel, 1, 40) ||
    !slug(v.candidateId) ||
    !slug(v.lessonVersion) ||
    !digest(v.contentDigest) ||
    !integer(v.observedAt) ||
    v.observedAt > now ||
    !text(v.device) ||
    !text(v.browser) ||
    !text(v.parentAgreementRef, 1, 240) ||
    !Array.isArray(v.tasks) ||
    v.tasks.length < 1 ||
    v.tasks.length > 20 ||
    !v.tasks.every((t) => text(t)) ||
    !['not-started', 'partial', 'ended'].includes(String(v.completion)) ||
    !nullableText(v.savedRecapRef, 240) ||
    ![
      'adultHelp',
      'interruptions',
      'observedBehavior',
      'observerInterpretation',
    ].every((k) => text(v[k], 0, 1000, false))
  )
    return false;
  const r = v.laterRecall;
  if (exact(r, ['status']) && r.status === 'not-run') return true;
  return (
    exact(r, [
      'status',
      'observedAt',
      'evidenceRef',
      'adultHelp',
      'observation',
    ]) &&
    r.status === 'observed' &&
    integer(r.observedAt) &&
    r.observedAt >= v.observedAt &&
    r.observedAt <= now &&
    text(r.evidenceRef, 1, 240) &&
    text(r.adultHelp, 0, 1000, false) &&
    text(r.observation, 0, 1000, false)
  );
}
export function parseObservation(
  value: unknown,
  now: number,
): OpsObservationInput {
  return valid(
    value,
    (v) =>
      exact(v, ['requestId', 'observation']) &&
      slug(v.requestId) &&
      validObservation(v.observation, now),
  );
}
export function parseCorrection(
  value: unknown,
  now: number,
): OpsCorrectionInput {
  return valid(
    value,
    (v) =>
      exact(v, [
        'requestId',
        'expectedRevision',
        'observation',
        'correctionReason',
      ]) &&
      slug(v.requestId) &&
      integer(v.expectedRevision, 1) &&
      validObservation(v.observation, now) &&
      text(v.correctionReason, 1, 1000),
  );
}
export function parseAck(value: unknown): OpsAckInput {
  return valid(
    value,
    (v) =>
      exact(v, ['requestId', 'expectedRevision']) &&
      slug(v.requestId) &&
      integer(v.expectedRevision, 1),
  );
}
export function jobSlot(kind: OpsJobKind, now: number): string {
  if (!integer(now)) fail('INVALID_REQUEST', 400);
  if (kind === 'backup' || kind === 'retention') {
    const d = new Date(now);
    d.setUTCHours(2, 0, 0, 0);
    if (d.getTime() > now) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }
  return new Date(Math.floor(now / 60000) * 60000).toISOString();
}
export const hash = curriculumDigest;
export const requestEnvelope = (
  scope: {
    environment: string;
    installationId: string;
    opsInstallationId: string;
  },
  actorUserId: string,
  operation: string,
  request: unknown,
) => ({
  schemaVersion: 'r4-ops-request-1',
  ...scope,
  actorUserId,
  operation,
  request,
});
