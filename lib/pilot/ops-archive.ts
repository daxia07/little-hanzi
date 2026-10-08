/** Pure operations archive validation. Historical scope is never current authority. */
import { inspectJson } from '../curriculum/json.ts';
import {
  canonicalPackage,
  exact,
  integer,
  slug,
  digest,
  hash,
  OPS_RETENTION_MS,
  OPS_ALERT_CODES,
} from './ops-domain.ts';
import {
  OPS_TABLES,
  OPS_COLUMNS,
  OPS_SCHEMA,
  OPS_SCHEMA_V2,
  OPS_SCHEMA_V3,
  OPS_MIGRATIONS_V1,
  OPS_MIGRATIONS_V2,
  OPS_MIGRATIONS_V3,
} from './ops-schema.ts';
type Row = Record<string, unknown>;
export interface OpsArchivePayload {
  format: 'pilot-ops-backup-1' | 'pilot-ops-backup-2' | 'pilot-ops-backup-3';
  createdAt: string;
  sourceOpsInstallationId: string;
  sourceInstallationId: string;
  environment: string;
  buildId: string;
  migrations: unknown[];
  schemaDigest: string;
  schema: Row[];
  tables: Record<string, Row[]>;
}
const invalid = (): never => {
  throw new Error('OPS_ARCHIVE_INVALID');
};
const check = (ok: unknown) => {
  if (!ok) invalid();
};
const normalize = (v: unknown) =>
  String(v).replaceAll(/\s+/g, ' ').trim().replace(/;+$/, '');
const sameScope = (a: Row, b: Row) =>
  ['environment', 'installation_id', 'ops_installation_id'].every(
    (k) => a[k] === b[k],
  );
const json = (value: unknown): Row => {
  check(typeof value === 'string');
  let result: unknown;
  try {
    result = JSON.parse(value as string);
  } catch {
    invalid();
  }
  check(canonicalPackage(result) === value);
  check(!!result && typeof result === 'object' && !Array.isArray(result));
  return result as Row;
};
async function rawHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function chains(events: Row[], key: string) {
  const groups = new Map<string, Row[]>();
  for (const event of events) {
    check(
      slug(event.id) &&
        slug(event[key]) &&
        integer(event.sequence, 1) &&
        integer(event.created_at),
    );
    const list = groups.get(String(event[key])) ?? [];
    list.push(event);
    groups.set(String(event[key]), list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    for (let i = 0; i < list.length; i++) {
      const e = list[i],
        prev = list[i - 1];
      check(e.sequence === i + 1 && e.previous_event_id === (prev?.id ?? null));
      if (prev)
        check(
          sameScope(e, prev) && Number(e.created_at) >= Number(prev.created_at),
        );
    }
  }
  return groups;
}
function receipt(row: Row, recordId: unknown) {
  const r = json(row.receipt_json);
  check(
    exact(r, ['requestId', 'recordId', 'revision', 'recordedAt']) &&
      r.requestId === row.request_id &&
      r.recordId === recordId &&
      r.revision === (row.sequence ?? 1) &&
      r.recordedAt === row.created_at,
  );
}
function validateObjects(value: unknown, kind: unknown) {
  check(
    kind === 'backup'
      ? exact(value, ['learning', 'operations']) &&
          ['learning', 'operations'].every((k) => {
            const v = (value as Row)[k];
            return (
              exact(v, ['archiveId', 'objectId']) &&
              slug(v.archiveId) &&
              slug(v.objectId)
            );
          })
      : kind === 'reconcile'
        ? exact(value, ['subjectJobId']) && slug(value.subjectJobId)
        : kind === 'retention'
          ? exact(value, ['archiveIds', 'verifiedPointJobId']) &&
            slug(value.verifiedPointJobId) &&
            Array.isArray(value.archiveIds) &&
            value.archiveIds.every(slug) &&
            new Set(value.archiveIds).size === value.archiveIds.length
          : kind === 'monitor' && exact(value, []),
  );
}
function jobRequest(value: unknown, event: Row, parent: Row) {
  check(!!value && typeof value === 'object' && !Array.isArray(value));
  const v = value as Row;
  check(
    v.jobId === event.job_id &&
      v.attemptId === event.attempt_id &&
      v.eventId === event.id,
  );
  if (event.kind === 'acquired') {
    check(
      exact(
        v,
        Object.hasOwn(v, 'expectedRevision')
          ? [
              'jobId',
              'kind',
              'utcSlot',
              'attemptId',
              'eventId',
              'objects',
              'expectedRevision',
            ]
          : ['jobId', 'kind', 'utcSlot', 'attemptId', 'eventId', 'objects'],
      ) &&
        v.kind === parent.kind &&
        v.utcSlot === parent.utc_slot,
    );
    validateObjects(v.objects, v.kind);
    if (event.sequence !== 1)
      check(v.expectedRevision === Number(event.sequence) - 1);
  } else {
    check(v.expectedRevision === Number(event.sequence) - 1);
    const fence = ['jobId', 'attemptId', 'expectedRevision', 'eventId'];
    if (Object.hasOwn(v, 'observation')) {
      check(exact(v, [...fence, 'observation']));
      const o = v.observation;
      check(
        (exact(o, ['outcome']) && o.outcome === 'unconfirmed') ||
          (exact(o, ['outcome', 'settled']) &&
            o.outcome === 'not-committed' &&
            o.settled === true) ||
          (exact(o, ['outcome', 'result']) && o.outcome === 'confirmed'),
      );
    } else if (Object.hasOwn(v, 'result'))
      check(
        exact(v, [...fence, 'result']) &&
          !!v.result &&
          typeof v.result === 'object',
      );
    else
      check(
        exact(
          v,
          Object.hasOwn(v, 'settled')
            ? [...fence, 'code', 'settled']
            : [...fence, 'code'],
        ) &&
          typeof v.code === 'string' &&
          (OPS_ALERT_CODES.includes(v.code as never) ||
            ['OPS_JOB_FAILED', 'OPS_EFFECT_UNCONFIRMED'].includes(v.code)) &&
          (!Object.hasOwn(v, 'settled') || typeof v.settled === 'boolean'),
      );
  }
}
export async function validateOpsArchive(
  input: unknown,
  {
    source,
  }: {
    source?: { schema: readonly unknown[]; migrations: readonly unknown[] };
  } = {},
): Promise<OpsArchivePayload> {
  const inspected = inspectJson(input);
  check(!inspected.errors.length);
  const p = inspected.value as OpsArchivePayload;
  check(
    exact(p, [
      'format',
      'createdAt',
      'sourceOpsInstallationId',
      'sourceInstallationId',
      'environment',
      'buildId',
      'migrations',
      'schemaDigest',
      'schema',
      'tables',
    ]) &&
      [
        'pilot-ops-backup-1',
        'pilot-ops-backup-2',
        'pilot-ops-backup-3',
      ].includes(p.format),
  );
  check(
    [
      p.sourceOpsInstallationId,
      p.sourceInstallationId,
      p.environment,
      p.buildId,
    ].every(slug) &&
      typeof p.createdAt === 'string' &&
      Number.isFinite(Date.parse(p.createdAt)) &&
      new Date(p.createdAt).toISOString() === p.createdAt,
  );
  const version =
    p.format === 'pilot-ops-backup-1'
      ? 1
      : p.format === 'pilot-ops-backup-2'
        ? 2
        : 3;
  const expectedMigrations =
    version === 1
      ? OPS_MIGRATIONS_V1
      : version === 2
        ? OPS_MIGRATIONS_V2
        : OPS_MIGRATIONS_V3;
  const expectedSchema = (source?.schema ??
    (version === 1
      ? OPS_SCHEMA
      : version === 2
        ? OPS_SCHEMA_V2
        : OPS_SCHEMA_V3)) as unknown as Row[];
  check(Array.isArray(p.schema) && p.schema.length === expectedSchema.length);
  const seen = new Set();
  for (const row of p.schema) {
    check(exact(row, ['type', 'name', 'tbl_name', 'sql']));
    const id = String(row.type) + ':' + String(row.name),
      expected = expectedSchema.find(
        (r) => r.type === row.type && r.name === row.name,
      );
    check(
      expected &&
        !seen.has(id) &&
        expected.tbl_name === row.tbl_name &&
        normalize(expected.sql) === normalize(row.sql),
    );
    seen.add(id);
  }
  check(
    p.schemaDigest === (await rawHash(p.schema)) &&
      canonicalPackage(p.migrations) === canonicalPackage(expectedMigrations),
  );
  check(exact(p.tables, OPS_TABLES));
  for (const table of OPS_TABLES) {
    const list = p.tables[table];
    check(Array.isArray(list) && list.length <= 100000);
    const ids = new Set();
    for (const r of list) {
      check(
        exact(r, OPS_COLUMNS[table]) &&
          Object.values(r).every(
            (v) => v === null || typeof v === 'string' || integer(v),
          ),
      );
      const key = r.id ?? r.version;
      check(!ids.has(key));
      ids.add(key);
    }
  }
  const t = p.tables,
    installation = t.ops_installation;
  check(installation.length === 1);
  const i = installation[0];
  check(
    i.id === 1 &&
      i.installation_id === p.sourceOpsInstallationId &&
      i.learning_installation_id === p.sourceInstallationId &&
      i.environment === p.environment &&
      i.schema_version === `pilot-ops-schema-${version}` &&
      integer(i.queue_revision) &&
      integer(i.created_at),
  );
  check(t.ops_schema_history.length === expectedMigrations.length);
  for (const m of expectedMigrations)
    check(
      t.ops_schema_history.some(
        (r) =>
          r.version === m.version &&
          r.name === m.name &&
          r.checksum === m.sha256 &&
          integer(r.applied_at),
      ),
    );
  for (const table of OPS_TABLES.filter(
    (k) => !['ops_installation', 'ops_schema_history'].includes(k),
  ))
    for (const r of t[table])
      check(
        [r.environment, r.installation_id, r.ops_installation_id].every(slug),
      );
  const jobs = new Map(t.ops_job.map((r) => [r.id, r])),
    jobEvents = chains(t.ops_job_event, 'job_id'),
    feedback = new Map(t.ops_feedback.map((r) => [r.id, r])),
    feedbackEvents = chains(t.ops_feedback_event, 'record_id');
  const deleted = new Set<unknown>();
  for (const e of t.ops_job_event) {
    const parent = jobs.get(e.job_id);
    check(parent && sameScope(parent, e) && digest(e.request_digest));
    const pub = json(e.public_json);
    jobRequest(pub.request, e, parent!);
    check(
      exact(pub, [
        'schemaVersion',
        'statusAfter',
        'code',
        'leaseUntil',
        'attemptNumber',
        'objects',
        'verifiedArchiveIds',
        'deletedArchiveIds',
        'monitor',
        'reconciliation',
        'request',
      ]) &&
        pub.schemaVersion === 'r4-job-event-1' &&
        pub.statusAfter === e.status_after &&
        (await hash(pub.request)) === e.request_digest,
    );
    check(
      [
        'acquired',
        'uncertain',
        'archive-verified',
        'completed',
        'failed',
        'reconciled',
        'archive-deleted',
      ].includes(String(e.kind)) &&
        ['running', 'uncertain', 'succeeded', 'failed'].includes(
          String(e.status_after),
        ),
    );
    check(
      canonicalPackage(pub.objects) ===
        canonicalPackage(json(parent!.objects_json).objects),
    );
    check(
      Array.isArray(pub.verifiedArchiveIds) &&
        Array.isArray(pub.deletedArchiveIds),
    );
    for (const id of pub.deletedArchiveIds as unknown[]) {
      check(!deleted.has(id));
      deleted.add(id);
    }
  }
  for (const r of t.ops_job) {
    const events = jobEvents.get(String(r.id));
    check(events?.length === r.revision);
    const latest = events!.at(-1)!;
    const pub = json(latest.public_json);
    check(
      latest.id === r.latest_event_id &&
        latest.status_after === r.status &&
        latest.attempt_id === r.attempt_id &&
        pub.attemptNumber === r.attempt_number &&
        pub.code === r.error_code &&
        pub.leaseUntil === r.lease_until &&
        integer(r.started_at) &&
        integer(r.attempt_number, 1),
    );
    const objects = json(r.objects_json);
    check(
      exact(objects, ['schemaVersion', 'objects']) &&
        objects.schemaVersion === 'r4-job-objects-1',
    );
    validateObjects(objects.objects, r.kind);
    check(
      ['backup', 'monitor', 'retention', 'reconcile'].includes(String(r.kind)),
    );
    check(
      typeof r.utc_slot === 'string' &&
        Number.isFinite(Date.parse(r.utc_slot)) &&
        new Date(String(r.utc_slot)).toISOString() === r.utc_slot,
    );
    check(
      r.status === 'running'
        ? integer(r.lease_until) && r.ended_at === null
        : r.status === 'uncertain'
          ? r.lease_until === null && r.ended_at === null
          : r.lease_until === null &&
            integer(r.ended_at) &&
            Number(r.ended_at) >= Number(r.started_at),
    );
    if (r.status === 'succeeded' && r.kind === 'backup') {
      const verified = t.ops_archive.filter(
        (a) => a.verification_event_id === latest.id,
      );
      check(
        verified.length === 2 &&
          new Set(verified.map((a) => a.kind)).size === 2 &&
          canonicalPackage(
            (pub.verifiedArchiveIds as string[]).slice().sort(),
          ) === canonicalPackage(verified.map((a) => String(a.id)).sort()),
      );
    }
  }
  for (const a of t.ops_archive) {
    const parent = jobs.get(a.job_id),
      event = t.ops_job_event.find((e) => e.id === a.verification_event_id);
    check(
      parent &&
        event &&
        sameScope(a, parent) &&
        sameScope(a, event) &&
        event.job_id === a.job_id &&
        event.attempt_id === a.attempt_id &&
        event.status_after === 'succeeded' &&
        digest(a.plaintext_digest) &&
        digest(a.ciphertext_digest) &&
        integer(a.byte_size, 1) &&
        integer(a.data_at) &&
        integer(a.created_at) &&
        integer(a.verified_at) &&
        Number(a.created_at) >= Number(a.data_at) &&
        Number(a.verified_at) >= Number(a.created_at),
    );
    const objects = json(parent!.objects_json).objects as Row,
      planned = objects[String(a.kind)] as Row;
    check(
      planned &&
        a.id === planned.archiveId &&
        a.object_ref === planned.objectId &&
        a.daily_slot === parent!.utc_slot &&
        (a.kind === 'learning'
          ? version === 1
            ? ['pilot-admin-backup-4']
            : version === 2
              ? ['pilot-admin-backup-4', 'pilot-admin-backup-5']
              : [
                  'pilot-admin-backup-4',
                  'pilot-admin-backup-5',
                  'pilot-admin-backup-6',
                ]
          : version === 1
            ? ['pilot-ops-backup-1']
            : version === 2
              ? ['pilot-ops-backup-1', 'pilot-ops-backup-2']
              : [
                  'pilot-ops-backup-1',
                  'pilot-ops-backup-2',
                  'pilot-ops-backup-3',
                ]
        ).includes(String(a.format)),
    );
    check(
      a.weekly_slot === null ||
        (a.weekly_slot === a.daily_slot &&
          new Date(String(a.daily_slot)).getUTCDay() === 0),
    );
  }
  for (const id of deleted) check(t.ops_archive.some((a) => a.id === id));
  for (const e of t.ops_feedback_event) {
    const parent = feedback.get(e.record_id);
    check(parent && sameScope(parent, e) && digest(e.request_digest));
    receipt(e, e.record_id);
    const pub = json(e.public_json);
    check(
      exact(pub, [
        'schemaVersion',
        'status',
        'severity',
        'nextReviewAt',
        'acIds',
        'observationKind',
        'observedAt',
        'completion',
        'laterRecallStatus',
      ]) &&
        pub.schemaVersion === 'r4-feedback-event-1' &&
        Array.isArray(pub.acIds),
    );
    check(
      ['submitted', 'triaged', 'corrected', 'redacted'].includes(
        String(e.kind),
      ),
    );
    if (e.redacted_at === null) {
      check(
        e.request_json !== null &&
          e.private_json !== null &&
          (await hash(json(e.request_json))) === e.request_digest,
      );
      const priv = json(e.private_json);
      check(
        exact(priv, [
          'schemaVersion',
          'ownerRef',
          'disposition',
          'retestRef',
          'correctionReason',
          'observation',
        ]) && priv.schemaVersion === 'r4-feedback-private-1',
      );
    } else
      check(
        integer(e.redacted_at) &&
          e.private_json === null &&
          e.request_json === null &&
          parent!.details_removed_at !== null,
      );
  }
  for (const r of t.ops_feedback) {
    const events = feedbackEvents.get(String(r.id));
    check(events?.length === r.revision);
    const latest = events!.at(-1)!,
      pub = json(latest.public_json),
      first = events![0];
    check(
      first.kind === 'submitted' &&
        latest.id === r.latest_event_id &&
        pub.status === r.status &&
        pub.severity === r.severity &&
        pub.nextReviewAt === r.next_review_at &&
        r.updated_at === latest.created_at &&
        integer(r.created_at) &&
        r.expires_at === Number(r.created_at) + OPS_RETENTION_MS &&
        digest(r.request_digest) &&
        digest(r.content_digest),
    );
    receipt({ ...r, sequence: 1 }, r.id);
    if (r.details_removed_at !== null) {
      check(
        r.status === 'expired' &&
          integer(r.details_removed_at) &&
          Number(r.details_removed_at) >= Number(r.expires_at) &&
          r.private_json === null &&
          r.request_json === null &&
          r.owner_ref === null &&
          r.next_review_at === null &&
          r.redaction_event_id === latest.id &&
          latest.kind === 'redacted' &&
          events!.every(
            (e) =>
              e.redacted_at !== null &&
              e.private_json === null &&
              e.request_json === null,
          ),
      );
    } else {
      check(
        r.status !== 'expired' &&
          r.redaction_event_id === null &&
          r.request_json !== null &&
          r.private_json !== null &&
          (await hash(json(r.request_json))) === r.request_digest,
      );
      json(r.private_json);
    }
    check(
      r.kind === 'feedback'
        ? r.source_role === 'parent' &&
            r.child_id !== null &&
            r.run_id !== null &&
            r.operator_user_id === null
        : r.kind === 'observation' &&
            r.source_role === 'operator' &&
            r.operator_user_id !== null &&
            r.child_id === null &&
            r.run_id === null,
    );
  }
  const alertGroups = chains(t.ops_alert_event, 'alert_id'),
    conditions = new Set();
  for (const list of alertGroups.values()) {
    for (const e of list) {
      check(
        OPS_ALERT_CODES.includes(e.code as never) &&
          [
            'opened',
            'reopened',
            'acknowledged',
            'resolved',
            'notification-delivered',
            'notification-failed',
          ].includes(String(e.kind)),
      );
      if (e.job_id !== null)
        check(jobs.has(e.job_id) && sameScope(e, jobs.get(e.job_id)!));
      receipt(e, e.alert_id);
      const pub = json(e.public_json);
      check(
        exact(pub, [
          'schemaVersion',
          'statusAfter',
          'condition',
          'jobId',
          'notification',
          'acknowledgedAt',
          'acknowledgedBy',
          'request',
        ]) &&
          pub.schemaVersion === 'r4-alert-event-1' &&
          pub.statusAfter === e.status_after &&
          pub.condition === e.code &&
          pub.jobId === e.job_id &&
          (await hash(pub.request)) === e.request_digest,
      );
      check(e.code === list[0].code && sameScope(e, list[0]));
    }
    const first = list[0],
      key = canonicalPackage([
        first.environment,
        first.installation_id,
        first.ops_installation_id,
        first.code,
      ]);
    check(first.kind === 'opened' && !conditions.has(key));
    conditions.add(key);
  }
  return p;
}
