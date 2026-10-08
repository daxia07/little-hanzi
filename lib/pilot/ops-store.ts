import {
  canonicalPackage,
  hash,
  fail,
  OpsError,
  safeJson,
  exact,
  slug,
  digest,
  integer,
  OPS_ALERT_CODES,
  OPS_RETENTION_MS,
  OPS_FRESHNESS_MS,
  OPS_LEASE_MS,
  parseFeedback,
  parseObservation,
  parseCorrection,
  parseTriage,
  parseAck,
  jobSlot,
  requestEnvelope,
} from './ops-domain.ts';
import {
  OPS_SCHEMA,
  OPS_SCHEMA_V2,
  OPS_SCHEMA_V3,
  OPS_MIGRATIONS_V1,
  OPS_MIGRATIONS_V2,
  OPS_MIGRATIONS_V3,
} from './ops-schema.ts';
import type {
  OpsContext,
  AcquireJobInput,
  JobAdmission,
  JobFence,
  UncertainJobInput,
  CompleteJobInput,
  FailedJobInput,
  ReconcileJobInput,
  OpsArchiveMetadata,
  VerifiedArchiveMetadata,
} from './ops-types.ts';
import type {
  OpsJob,
  OpsStatus,
  OpsReceipt,
  OpsSummary,
  OpsDetail,
  OpsHistory,
  OpsObservation,
  OpsQueueOptions,
  OpsHistoryOptions,
  OpsAlert,
  OpsAlertCode,
  OpsJobCode,
} from '../pilot-ops-types.ts';
export type * from './ops-types.ts';
type Row = Record<string, unknown>;
type Actor = { id: string; role: string };
const scope = (c: OpsContext) => ({
  environment: c.environment,
  installationId: c.installationId,
  opsInstallationId: c.opsInstallationId,
});
const params = (c: OpsContext) => [
  c.environment,
  c.installationId,
  c.opsInstallationId,
];
const current = (c: OpsContext, r: Row) =>
  r.environment === c.environment &&
  r.installation_id === c.installationId &&
  r.ops_installation_id === c.opsInstallationId;
const clock = (c: OpsContext) => {
  const at = c.now();
  if (!integer(at)) fail('OPS_UNAVAILABLE', 503);
  return at;
};
async function rows(
  c: OpsContext,
  sql: string,
  args: unknown[] = [],
): Promise<Row[]> {
  try {
    const r = await c.db
      .prepare(sql)
      .bind(...args)
      .all<Row>();
    if (!r.success) fail('OPS_UNAVAILABLE', 503);
    return r.results ?? [];
  } catch (error) {
    if (error instanceof OpsError) throw error;
    fail('OPS_UNAVAILABLE', 503);
  }
}
const one = async (c: OpsContext, sql: string, args: unknown[] = []) =>
  (await rows(c, sql, args))[0] ?? null;
const json = (v: unknown) => JSON.parse(String(v)) as Row;
const statement = (c: OpsContext, sql: string, args: unknown[] = []) =>
  c.db.prepare(sql).bind(...args);
const insert = (c: OpsContext, table: string, row: Row) =>
  statement(
    c,
    `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES(${Object.keys(
      row,
    )
      .map(() => '?')
      .join(',')})`,
    Object.values(row),
  );
const guard = (c: OpsContext, predicate: string, args: unknown[]) =>
  statement(
    c,
    `INSERT INTO ops_schema_history(version,name,checksum,applied_at) SELECT -1,'0000_ops.sql','0000000000000000000000000000000000000000000000000000000000000000',0 WHERE NOT (${predicate})`,
    args,
  );
async function batch(
  c: OpsContext,
  statements: ReturnType<typeof statement>[],
) {
  try {
    const r = await c.db.batch(statements);
    if (r.some((v) => !v.success)) fail('OPS_UNAVAILABLE', 503);
  } catch {
    fail('OPS_UNAVAILABLE', 503);
  }
}
async function feedbackBatch(
  c: OpsContext,
  statements: ReturnType<typeof statement>[],
) {
  return batch(
    c,
    c.testFault === 'feedback-final-write'
      ? [
          ...statements,
          statement(
            c,
            'INSERT INTO ops_installation SELECT * FROM ops_installation WHERE id=1',
          ),
        ]
      : statements,
  );
}
async function alertBatch(
  c: OpsContext,
  statements: ReturnType<typeof statement>[],
) {
  return batch(
    c,
    c.testFault === 'alert-final-write'
      ? [
          ...statements,
          statement(
            c,
            'INSERT INTO ops_installation SELECT * FROM ops_installation WHERE id=1',
          ),
        ]
      : statements,
  );
}
const scopedSql =
  'environment=? AND installation_id=? AND ops_installation_id=?';
const identity = () => crypto.randomUUID();
const actorRole = (actor: Actor, role: string) => {
  if (actor.role !== role) fail('FORBIDDEN', 403);
  if (!slug(actor.id)) fail('INVALID_REQUEST', 400);
};
async function requestIdentity(
  c: OpsContext,
  actor: Actor,
  operation: string,
  input: unknown,
  r?: Row,
) {
  const s = r
    ? {
        environment: String(r.environment),
        installationId: String(r.installation_id),
        opsInstallationId: String(r.ops_installation_id),
      }
    : scope(c);
  return {
    actorKey: await hash({ ...s, actorUserId: actor.id, operation }),
    request: requestEnvelope(s, actor.id, operation, input),
  };
}
const receipt = (
  requestId: string,
  recordId: string,
  revision: number,
  at: number,
): OpsReceipt => ({ requestId, recordId, revision, recordedAt: at });
const jobCode = (v: unknown): v is OpsJobCode =>
  OPS_ALERT_CODES.includes(v as OpsAlertCode) ||
  v === 'OPS_JOB_FAILED' ||
  v === 'OPS_EFFECT_UNCONFIRMED';
const rawJob = async (c: OpsContext, id: string) =>
  one(c, `SELECT * FROM ops_job WHERE id=? AND ${scopedSql}`, [
    id,
    ...params(c),
  ]);
async function jobView(c: OpsContext, r: Row): Promise<OpsJob> {
  const archives = await rows(
    c,
    'SELECT * FROM ops_archive WHERE job_id=? ORDER BY kind,id',
    [r.id],
  );
  return {
    id: String(r.id),
    kind: r.kind as OpsJob['kind'],
    revision: Number(r.revision),
    status: r.status as OpsJob['status'],
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    errorCode: r.error_code as OpsJob['errorCode'],
    acknowledgedOperationId: String(r.latest_event_id),
    buildId: String(r.build_id),
    historical: !current(c, r),
    archives: archives.map((a) => ({
      id: String(a.id),
      kind: a.kind as 'learning' | 'operations',
      plaintextDigest: String(a.plaintext_digest),
      ciphertextDigest: String(a.ciphertext_digest),
      byteSize: Number(a.byte_size),
      keyId: String(a.key_id),
      verifiedAt: Number(a.verified_at),
    })),
  };
}
async function admission(
  c: OpsContext,
  r: Row,
  dispatch = false,
): Promise<JobAdmission> {
  return {
    admission: dispatch
      ? 'dispatch'
      : r.status === 'succeeded' || r.status === 'failed'
        ? 'terminal'
        : r.status === 'uncertain' || Number(r.lease_until) <= clock(c)
          ? 'reconcile'
          : 'busy',
    job: await jobView(c, r),
    objects: json(r.objects_json).objects as JobAdmission['objects'],
    attemptId: String(r.attempt_id),
    utcSlot: String(r.utc_slot),
    lease: dispatch
      ? {
          attemptId: String(r.attempt_id),
          revision: Number(r.revision),
          leaseUntil: Number(r.lease_until),
        }
      : null,
  };
}
export async function readJobForReconcile(
  c: OpsContext,
  id: string,
): Promise<JobAdmission> {
  if (!slug(id)) fail('INVALID_REQUEST', 400);
  const r = await rawJob(c, id);
  if (!r) fail('NOT_FOUND', 404);
  return admission(c, r);
}
const eventPublic = (r: Row, input: unknown, extra: Row = {}) => ({
  schemaVersion: 'r4-job-event-1',
  statusAfter: r.status,
  code: r.error_code,
  leaseUntil: r.lease_until,
  attemptNumber: r.attempt_number,
  objects: json(r.objects_json).objects,
  verifiedArchiveIds: [],
  deletedArchiveIds: [],
  monitor: null,
  reconciliation: null,
  request: input,
  ...extra,
});
async function jobEvent(
  c: OpsContext,
  r: Row,
  eventId: string,
  kind: string,
  input: unknown,
  at: number,
  extra: Row = {},
) {
  return {
    id: eventId,
    job_id: r.id,
    environment: r.environment,
    installation_id: r.installation_id,
    ops_installation_id: r.ops_installation_id,
    sequence: r.revision,
    previous_event_id:
      Number(r.revision) === 1 ? null : (extra.previousEventId ?? null),
    attempt_id: r.attempt_id,
    kind,
    status_after: r.status,
    request_digest: await hash(input),
    public_json: canonicalPackage(
      eventPublic(
        r,
        input,
        Object.fromEntries(
          Object.entries(extra).filter(([k]) => k !== 'previousEventId'),
        ),
      ),
    ),
    created_at: at,
  };
}
async function validateRetentionPlan(
  c: OpsContext,
  plan: { archiveIds: string[]; verifiedPointJobId: string },
) {
  const archives = (await listVerifiedArchives(c)).filter((a) => !a.deleted),
    groups = new Map<string, OpsArchiveMetadata[]>();
  for (const a of archives)
    groups.set(a.jobId, [...(groups.get(a.jobId) ?? []), a]);
  const points = [...groups.values()]
    .filter((p) => p.length === 2 && new Set(p.map((a) => a.kind)).size === 2)
    .sort(
      (a, b) =>
        b[0].dailySlot.localeCompare(a[0].dailySlot) ||
        b[0].jobId.localeCompare(a[0].jobId),
    );
  if (!points.length || plan.verifiedPointJobId !== points[0][0].jobId)
    fail('INVALID_REQUEST', 400);
  const keep = new Set(
    [
      ...points.slice(0, 7),
      ...points.filter((p) => p[0].weeklySlot !== null).slice(0, 4),
    ].flatMap((p) => p.map((a) => a.id)),
  );
  const expected = points
    .flatMap((p) => p.map((a) => a.id))
    .filter((id) => !keep.has(id))
    .sort();
  if (
    canonicalPackage(plan.archiveIds.slice().sort()) !==
    canonicalPackage(expected)
  )
    fail('INVALID_REQUEST', 400);
}
export async function acquireJob(
  c: OpsContext,
  value: AcquireJobInput,
): Promise<JobAdmission> {
  const v = safeJson(value) as unknown as AcquireJobInput;
  const keys = ['jobId', 'kind', 'utcSlot', 'attemptId', 'eventId', 'objects'];
  if (
    !exact(
      v,
      Object.hasOwn(v, 'expectedRevision')
        ? [...keys, 'expectedRevision']
        : keys,
    ) ||
    ![v.jobId, v.attemptId, v.eventId].every(slug) ||
    !['backup', 'monitor', 'retention', 'reconcile'].includes(v.kind) ||
    v.utcSlot !== jobSlot(v.kind, clock(c))
  )
    fail('INVALID_REQUEST', 400);
  if (v.kind === 'backup') {
    if (
      !exact(v.objects, ['learning', 'operations']) ||
      !['learning', 'operations'].every((k) => {
        const x = (v.objects as Row)[k];
        return (
          exact(x, ['archiveId', 'objectId']) &&
          slug(x.archiveId) &&
          slug(x.objectId)
        );
      })
    )
      fail('INVALID_REQUEST', 400);
  } else if (v.kind === 'reconcile') {
    if (
      !exact(v.objects, ['subjectJobId']) ||
      !slug((v.objects as Row).subjectJobId)
    )
      fail('INVALID_REQUEST', 400);
  } else if (v.kind === 'retention') {
    if (
      !exact(v.objects, ['archiveIds', 'verifiedPointJobId']) ||
      !slug((v.objects as Row).verifiedPointJobId) ||
      !Array.isArray((v.objects as { archiveIds: string[] }).archiveIds) ||
      !(v.objects as { archiveIds: string[] }).archiveIds.every(slug) ||
      new Set((v.objects as { archiveIds: string[] }).archiveIds).size !==
        (v.objects as { archiveIds: string[] }).archiveIds.length
    )
      fail('INVALID_REQUEST', 400);
  } else if (!exact(v.objects, [])) fail('INVALID_REQUEST', 400);
  const existing = await one(
    c,
    `SELECT * FROM ops_job WHERE ${scopedSql} AND kind=? AND utc_slot=?`,
    [...params(c), v.kind, v.utcSlot],
  );
  if (existing) {
    if (
      v.jobId !== existing.id ||
      canonicalPackage(v.objects) !==
        canonicalPackage(json(existing.objects_json).objects)
    )
      fail('OPS_CONFLICT', 409, Number(existing.revision));
    const e = await one(c, 'SELECT * FROM ops_job_event WHERE id=?', [
      v.eventId,
    ]);
    if (e && e.request_digest !== (await hash(v)))
      fail('OPS_CONFLICT', 409, Number(existing.revision));
    if (
      existing.status === 'failed' &&
      v.expectedRevision === existing.revision
    ) {
      const at = clock(c),
        next = {
          ...existing,
          status: 'running',
          revision: Number(existing.revision) + 1,
          attempt_id: v.attemptId,
          attempt_number: Number(existing.attempt_number) + 1,
          lease_until: at + OPS_LEASE_MS,
          started_at: at,
          ended_at: null,
          error_code: null,
          latest_event_id: v.eventId,
        };
      if (
        v.jobId !== existing.id ||
        canonicalPackage(v.objects) !==
          canonicalPackage(json(existing.objects_json).objects)
      )
        fail('OPS_CONFLICT', 409, Number(existing.revision));
      const ev = await jobEvent(c, next, v.eventId, 'acquired', v, at, {
        previousEventId: existing.latest_event_id,
      });
      await batch(c, [
        guard(
          c,
          'EXISTS(SELECT 1 FROM ops_job WHERE id=? AND revision=? AND status=?)',
          [existing.id, existing.revision, 'failed'],
        ),
        statement(
          c,
          'UPDATE ops_job SET status=?,revision=?,attempt_id=?,attempt_number=?,lease_until=?,started_at=?,ended_at=NULL,error_code=NULL,latest_event_id=? WHERE id=?',
          [
            'running',
            next.revision,
            next.attempt_id,
            next.attempt_number,
            next.lease_until,
            at,
            v.eventId,
            existing.id,
          ],
        ),
        insert(c, 'ops_job_event', ev),
      ]);
      return admission(c, next, true);
    }
    return admission(c, existing);
  }
  if (v.kind === 'retention')
    await validateRetentionPlan(
      c,
      v.objects as { archiveIds: string[]; verifiedPointJobId: string },
    );
  if (
    v.kind === 'reconcile' &&
    !(await rawJob(c, String((v.objects as Row).subjectJobId)))
  )
    fail('INVALID_REQUEST', 400);
  const at = clock(c),
    r = {
      id: v.jobId,
      environment: c.environment,
      installation_id: c.installationId,
      ops_installation_id: c.opsInstallationId,
      build_id: c.buildId,
      kind: v.kind,
      utc_slot: v.utcSlot,
      objects_json: canonicalPackage({
        schemaVersion: 'r4-job-objects-1',
        objects: v.objects,
      }),
      revision: 1,
      status: 'running',
      attempt_id: v.attemptId,
      attempt_number: 1,
      lease_until: at + OPS_LEASE_MS,
      started_at: at,
      ended_at: null,
      error_code: null,
      latest_event_id: v.eventId,
    };
  const ev = await jobEvent(c, r, v.eventId, 'acquired', v, at);
  try {
    await batch(c, [insert(c, 'ops_job', r), insert(c, 'ops_job_event', ev)]);
  } catch (error) {
    const duplicate = await one(
      c,
      `SELECT * FROM ops_job WHERE ${scopedSql} AND kind=? AND utc_slot=?`,
      [...params(c), v.kind, v.utcSlot],
    );
    if (duplicate) return admission(c, duplicate);
    throw error;
  }
  return admission(c, r, true);
}
async function jobReplay(c: OpsContext, v: JobFence, input: unknown) {
  const e = await one(
    c,
    `SELECT * FROM ops_job_event WHERE id=? AND ${scopedSql}`,
    [v.eventId, ...params(c)],
  );
  if (!e) return null;
  if (e.job_id !== v.jobId || e.request_digest !== (await hash(input)))
    fail('OPS_CONFLICT', 409, Number(e.sequence));
  return {
    jobId: String(e.job_id),
    revision: Number(e.sequence),
    status: String(e.status_after),
    recordedAt: Number(e.created_at),
  };
}
async function fenced(c: OpsContext, v: JobFence) {
  if (
    ![v.jobId, v.attemptId, v.eventId].every(slug) ||
    !integer(v.expectedRevision, 1)
  )
    fail('INVALID_REQUEST', 400);
  const r = await rawJob(c, v.jobId);
  if (!r) fail('NOT_FOUND', 404);
  if (
    r.revision !== v.expectedRevision ||
    r.attempt_id !== v.attemptId ||
    !['running', 'uncertain'].includes(String(r.status))
  )
    fail('OPS_CONFLICT', 409, Number(r.revision));
  return r;
}
async function transition(
  c: OpsContext,
  v: JobFence,
  input: unknown,
  status: string,
  kind: string,
  code: OpsJobCode | null,
  extra: Row = {},
  archives: VerifiedArchiveMetadata[] = [],
) {
  const replay = await jobReplay(c, v, input);
  if (replay) return replay;
  const r = await fenced(c, v),
    at = clock(c);
  if (at < Number(r.started_at)) fail('OPS_CONFLICT', 409, Number(r.revision));
  const next = {
    ...r,
    revision: Number(r.revision) + 1,
    status,
    error_code: code,
    lease_until: null,
    ended_at: status === 'uncertain' ? null : at,
    latest_event_id: v.eventId,
  };
  const e = await jobEvent(c, next, v.eventId, kind, input, at, {
    previousEventId: r.latest_event_id,
    ...extra,
  });
  const statements = [
    guard(
      c,
      'EXISTS(SELECT 1 FROM ops_job WHERE id=? AND revision=? AND attempt_id=? AND status IN (?,?))',
      [r.id, r.revision, v.attemptId, 'running', 'uncertain'],
    ),
    statement(
      c,
      'UPDATE ops_job SET revision=?,status=?,error_code=?,lease_until=NULL,ended_at=?,latest_event_id=? WHERE id=?',
      [next.revision, status, code, next.ended_at, v.eventId, r.id],
    ),
  ];
  for (const a of archives)
    statements.push(
      insert(c, 'ops_archive', {
        id: a.id,
        job_id: r.id,
        attempt_id: r.attempt_id,
        environment: r.environment,
        installation_id: r.installation_id,
        ops_installation_id: r.ops_installation_id,
        build_id: r.build_id,
        kind: a.kind,
        format: a.format,
        object_ref: a.objectRef,
        key_id: a.keyId,
        plaintext_digest: a.plaintextDigest,
        ciphertext_digest: a.ciphertextDigest,
        byte_size: a.byteSize,
        data_at: a.dataAt,
        created_at: a.createdAt,
        verified_at: a.verifiedAt,
        daily_slot: a.dailySlot,
        weekly_slot: a.weeklySlot,
        verification_event_id: v.eventId,
      }),
    );
  statements.push(insert(c, 'ops_job_event', e));
  const condition =
    r.kind === 'backup'
      ? 'OPS_BACKUP_FAILED'
      : r.kind === 'monitor'
        ? 'OPS_PROBE_FAILED'
        : r.kind === 'retention'
          ? 'OPS_RETENTION_FAILED'
          : null;
  if (condition)
    statements.push(
      ...(await conditionStatements(
        c,
        condition,
        status !== 'succeeded' ||
          (r.kind === 'monitor' &&
            (extra.monitor as Row)?.health === 'unhealthy'),
        String(r.id),
        at,
      )),
    );
  if (r.kind === 'monitor' && status === 'succeeded')
    statements.push(
      ...(await conditionStatements(
        c,
        'OPS_MONITOR_UNKNOWN',
        false,
        String(r.id),
        at,
      )),
    );
  try {
    await batch(c, statements);
  } catch (error) {
    const acknowledged = await jobReplay(c, v, input);
    if (acknowledged) return acknowledged;
    const latest = await rawJob(c, v.jobId);
    if (latest && latest.revision !== r.revision)
      fail('OPS_CONFLICT', 409, Number(latest.revision));
    throw error;
  }
  return {
    jobId: String(r.id),
    revision: Number(next.revision),
    status,
    recordedAt: at,
  };
}
export async function markJobUncertain(
  c: OpsContext,
  value: UncertainJobInput,
) {
  const v = safeJson(value) as unknown as UncertainJobInput;
  if (
    !exact(v, ['jobId', 'attemptId', 'expectedRevision', 'eventId', 'code']) ||
    !jobCode(v.code)
  )
    fail('INVALID_REQUEST', 400);
  return transition(c, v, v, 'uncertain', 'uncertain', v.code);
}
async function archiveSchemaVersion(c: OpsContext): Promise<1 | 2 | 3> {
  const installation = await c.db
    .prepare('SELECT schema_version FROM ops_installation WHERE id=1')
    .first<Row>();
  const version =
    installation?.schema_version === 'pilot-ops-schema-1'
      ? 1
      : installation?.schema_version === 'pilot-ops-schema-2'
        ? 2
        : installation?.schema_version === 'pilot-ops-schema-3'
          ? 3
          : 0;
  if (!version) fail('OPS_UNAVAILABLE', 503);
  const expected =
      version === 1
        ? OPS_SCHEMA
        : version === 2
          ? OPS_SCHEMA_V2
          : OPS_SCHEMA_V3,
    migrations =
      version === 1
        ? OPS_MIGRATIONS_V1
        : version === 2
          ? OPS_MIGRATIONS_V2
          : OPS_MIGRATIONS_V3;
  const ledger = await c.db
    .prepare('SELECT * FROM ops_schema_history')
    .all<Row>();
  const schema = await c.db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'",
    )
    .all<Row>();
  const normalize = (v: unknown) =>
    String(v).replaceAll(/\s+/g, ' ').trim().replace(/;+$/, '');
  if (
    !ledger.success ||
    ledger.results?.length !== migrations.length ||
    migrations.some(
      (m) =>
        !ledger.results?.some(
          (r) =>
            r.version === m.version &&
            r.name === m.name &&
            r.checksum === m.sha256,
        ),
    ) ||
    !schema.success ||
    schema.results?.length !== expected.length ||
    schema.results.some(
      (r) =>
        !expected.some(
          (e) =>
            r.type === e.type &&
            r.name === e.name &&
            r.tbl_name === e.tbl_name &&
            normalize(r.sql) === normalize(e.sql),
        ),
    )
  )
    fail('OPS_UNAVAILABLE', 503);
  return version;
}
function validArchive(
  a: unknown,
  at: number,
  version: 1 | 2 | 3,
): a is VerifiedArchiveMetadata {
  return (
    exact(a, [
      'id',
      'kind',
      'format',
      'objectRef',
      'keyId',
      'plaintextDigest',
      'ciphertextDigest',
      'byteSize',
      'dataAt',
      'createdAt',
      'verifiedAt',
      'dailySlot',
      'weeklySlot',
    ]) &&
    slug(a.id) &&
    slug(a.objectRef) &&
    slug(a.keyId) &&
    ['learning', 'operations'].includes(String(a.kind)) &&
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
          ? ['pilot-ops-backup-2']
          : ['pilot-ops-backup-3']
    ).includes(String(a.format)) &&
    digest(a.plaintextDigest) &&
    digest(a.ciphertextDigest) &&
    integer(a.byteSize, 1) &&
    integer(a.dataAt) &&
    integer(a.createdAt) &&
    integer(a.verifiedAt) &&
    a.createdAt >= a.dataAt &&
    a.verifiedAt >= a.createdAt &&
    a.verifiedAt <= at &&
    typeof a.dailySlot === 'string' &&
    Number.isFinite(Date.parse(a.dailySlot)) &&
    a.dailySlot === new Date(Date.parse(a.dailySlot)).toISOString() &&
    (a.weeklySlot === null || a.weeklySlot === a.dailySlot)
  );
}
async function completeVerified(
  c: OpsContext,
  value: CompleteJobInput,
  original: unknown,
) {
  const v = safeJson(value) as unknown as CompleteJobInput;
  if (
    !exact(v, [
      'jobId',
      'attemptId',
      'expectedRevision',
      'eventId',
      'result',
    ]) ||
    !v.result
  )
    fail('INVALID_REQUEST', 400);
  const replay = await jobReplay(c, v, original);
  if (replay) return replay;
  const r = await fenced(c, v);
  if (v.result.kind !== r.kind) fail('INVALID_REQUEST', 400);
  const extra: Row = {},
    archives: VerifiedArchiveMetadata[] = [];
  if (v.result.kind === 'backup') {
    const version = await archiveSchemaVersion(c);
    if (
      !exact(v.result, ['kind', 'archives']) ||
      !Array.isArray(v.result.archives) ||
      v.result.archives.length !== 2 ||
      !v.result.archives.every((a) => validArchive(a, clock(c), version)) ||
      new Set(v.result.archives.map((a) => a.kind)).size !== 2
    )
      fail('INVALID_REQUEST', 400);
    const objects = json(r.objects_json).objects as Row;
    for (const a of v.result.archives) {
      const p = objects[a.kind] as Row;
      if (
        a.id !== p.archiveId ||
        a.objectRef !== p.objectId ||
        a.dailySlot !== r.utc_slot ||
        (a.weeklySlot !== null && new Date(a.dailySlot).getUTCDay() !== 0)
      )
        fail('INVALID_REQUEST', 400);
      archives.push(a);
    }
    extra.verifiedArchiveIds = archives.map((a) => a.id);
  } else if (v.result.kind === 'monitor') {
    if (
      !exact(v.result, ['kind', 'health', 'checkedAt', 'code']) ||
      !['healthy', 'unhealthy'].includes(v.result.health) ||
      !integer(v.result.checkedAt) ||
      v.result.checkedAt > clock(c) ||
      (v.result.code !== null && !OPS_ALERT_CODES.includes(v.result.code))
    )
      fail('INVALID_REQUEST', 400);
    extra.monitor = { health: v.result.health, checkedAt: v.result.checkedAt };
  } else if (v.result.kind === 'retention') {
    if (
      !exact(v.result, ['kind', 'deletedArchiveIds']) ||
      !Array.isArray(v.result.deletedArchiveIds) ||
      !v.result.deletedArchiveIds.every(slug) ||
      new Set(v.result.deletedArchiveIds).size !==
        v.result.deletedArchiveIds.length
    )
      fail('INVALID_REQUEST', 400);
    const points = await listVerifiedArchives(c);
    const deletions = v.result.deletedArchiveIds;
    const plan = json(r.objects_json).objects as Row;
    if (
      canonicalPackage(deletions) !== canonicalPackage(plan.archiveIds) ||
      !points.some((a) => a.jobId === plan.verifiedPointJobId && !a.deleted)
    )
      fail('INVALID_REQUEST', 400);
    for (const id of deletions)
      if (!points.some((a) => a.id === id && !a.deleted))
        fail('INVALID_REQUEST', 400);
    const live = points.filter((a) => !a.deleted),
      jobs = [...new Set(live.map((a) => a.jobId))];
    if (
      jobs.length &&
      jobs.every((j) =>
        live.filter((a) => a.jobId === j).some((a) => deletions.includes(a.id)),
      )
    )
      fail('INVALID_REQUEST', 400);
    for (const j of jobs) {
      const pair = live.filter((a) => a.jobId === j);
      if (
        pair.some((a) => deletions.includes(a.id)) &&
        !pair.every((a) => deletions.includes(a.id))
      )
        fail('INVALID_REQUEST', 400);
    }
    extra.deletedArchiveIds = deletions;
  } else if (v.result.kind === 'reconcile') {
    if (
      !exact(v.result, ['kind', 'subjectJobId', 'outcome']) ||
      !slug(v.result.subjectJobId) ||
      !['confirmed', 'not-committed'].includes(v.result.outcome)
    )
      fail('INVALID_REQUEST', 400);
    if (
      v.result.subjectJobId !==
      (json(r.objects_json).objects as Row).subjectJobId
    )
      fail('INVALID_REQUEST', 400);
    extra.reconciliation = {
      subjectJobId: v.result.subjectJobId,
      outcome: v.result.outcome,
    };
  }
  return transition(
    c,
    v,
    original,
    'succeeded',
    v.result.kind === 'retention' ? 'archive-deleted' : 'completed',
    null,
    extra,
    archives,
  );
}
export async function completeJobVerified(
  c: OpsContext,
  value: CompleteJobInput,
) {
  return completeVerified(c, value, value);
}
export async function completeJobFailed(c: OpsContext, value: FailedJobInput) {
  const v = safeJson(value) as unknown as FailedJobInput;
  if (
    !exact(v, [
      'jobId',
      'attemptId',
      'expectedRevision',
      'eventId',
      'code',
      'settled',
    ]) ||
    !jobCode(v.code) ||
    typeof v.settled !== 'boolean'
  )
    fail('INVALID_REQUEST', 400);
  return transition(
    c,
    v,
    v,
    v.settled ? 'failed' : 'uncertain',
    v.settled ? 'failed' : 'uncertain',
    v.code,
  );
}
export async function reconcileJob(c: OpsContext, value: ReconcileJobInput) {
  const v = safeJson(value) as unknown as ReconcileJobInput;
  if (
    !exact(v, [
      'jobId',
      'attemptId',
      'expectedRevision',
      'eventId',
      'observation',
    ])
  )
    fail('INVALID_REQUEST', 400);
  const o = v.observation;
  if (exact(o, ['outcome']) && o.outcome === 'unconfirmed')
    return transition(
      c,
      v,
      v,
      'uncertain',
      'reconciled',
      'OPS_EFFECT_UNCONFIRMED',
      { reconciliation: { subjectJobId: v.jobId, outcome: o.outcome } },
    );
  if (
    exact(o, ['outcome', 'settled']) &&
    o.outcome === 'not-committed' &&
    o.settled === true
  )
    return transition(c, v, v, 'failed', 'reconciled', 'OPS_JOB_FAILED', {
      reconciliation: { subjectJobId: v.jobId, outcome: o.outcome },
    });
  if (exact(o, ['outcome', 'result']) && o.outcome === 'confirmed') {
    const result = await completeVerified(
      c,
      {
        jobId: v.jobId,
        attemptId: v.attemptId,
        expectedRevision: v.expectedRevision,
        eventId: v.eventId,
        result: o.result,
      },
      v,
    );
    return result;
  }
  fail('INVALID_REQUEST', 400);
}
export async function listVerifiedArchives(
  c: OpsContext,
): Promise<OpsArchiveMetadata[]> {
  const a = await rows(
    c,
    `SELECT * FROM ops_archive WHERE ${scopedSql} ORDER BY daily_slot,id`,
    params(c),
  );
  const events = await rows(
    c,
    `SELECT public_json FROM ops_job_event WHERE ${scopedSql}`,
    params(c),
  );
  const deleted = new Set(
    events.flatMap((e) => json(e.public_json).deletedArchiveIds as string[]),
  );
  return a.map((r) => ({
    id: String(r.id),
    kind: r.kind as 'learning' | 'operations',
    format: r.format as VerifiedArchiveMetadata['format'],
    objectRef: String(r.object_ref),
    keyId: String(r.key_id),
    plaintextDigest: String(r.plaintext_digest),
    ciphertextDigest: String(r.ciphertext_digest),
    byteSize: Number(r.byte_size),
    dataAt: Number(r.data_at),
    createdAt: Number(r.created_at),
    verifiedAt: Number(r.verified_at),
    dailySlot: String(r.daily_slot),
    weeklySlot: r.weekly_slot as string | null,
    jobId: String(r.job_id),
    attemptId: String(r.attempt_id),
    environment: String(r.environment),
    installationId: String(r.installation_id),
    opsInstallationId: String(r.ops_installation_id),
    buildId: String(r.build_id),
    deleted: deleted.has(String(r.id)),
  }));
}
const feedbackRow = async (c: OpsContext, id: string) =>
  one(c, 'SELECT * FROM ops_feedback WHERE id=?', [id]);
const pubFeedback = (
  r: Row,
  obs: OpsObservation | null = null,
  acIds: string[] = [],
) => ({
  schemaVersion: 'r4-feedback-event-1',
  status: r.status,
  severity: r.severity,
  nextReviewAt: r.next_review_at,
  acIds,
  observationKind: r.observation_kind,
  observedAt: obs?.observedAt ?? r.observed_at,
  completion: obs?.completion ?? null,
  laterRecallStatus: obs?.laterRecall.status ?? null,
});
const privFeedback = (
  r: Row,
  obs: OpsObservation | null = null,
  extra: Row = {},
) => ({
  schemaVersion: 'r4-feedback-private-1',
  ownerRef: r.owner_ref,
  disposition: '',
  retestRef: null,
  correctionReason: null,
  observation: obs,
  ...extra,
});
async function feedbackEvent(
  c: OpsContext,
  r: Row,
  actor: Actor,
  operation: string,
  input: Row,
  eventId: string,
  kind: string,
  at: number,
  publicData: Row,
  privateData: Row | null,
  previous: string | null,
) {
  const req = await requestIdentity(c, actor, operation, input, r);
  return {
    id: eventId,
    record_id: r.id,
    environment: r.environment,
    installation_id: r.installation_id,
    ops_installation_id: r.ops_installation_id,
    sequence: r.revision,
    previous_event_id: previous,
    kind,
    actor_user_id: actor.role === 'operator' ? actor.id : null,
    actor_key: req.actorKey,
    request_id: input.requestId,
    request_digest: await hash(req.request),
    request_json: kind === 'redacted' ? null : canonicalPackage(req.request),
    receipt_json: canonicalPackage(
      receipt(String(input.requestId), String(r.id), Number(r.revision), at),
    ),
    public_json: canonicalPackage(publicData),
    private_json: privateData === null ? null : canonicalPackage(privateData),
    redacted_at: kind === 'redacted' ? at : null,
    created_at: at,
  };
}
async function createRecord(
  c: OpsContext,
  actor: Actor,
  input: Row,
  operation: string,
  binding: Row,
  privateData: Row,
  obs: OpsObservation | null,
) {
  const req = await requestIdentity(c, actor, operation, input),
    dg = await hash(req.request);
  const duplicate = await one(
    c,
    `SELECT * FROM ops_feedback WHERE ${scopedSql} AND actor_key=? AND request_id=?`,
    [...params(c), req.actorKey, input.requestId],
  );
  if (duplicate) {
    if (duplicate.request_digest !== dg)
      fail('OPS_CONFLICT', 409, Number(duplicate.revision));
    return json(duplicate.receipt_json) as unknown as OpsReceipt;
  }
  const at = clock(c),
    id = identity(),
    eid = identity();
  const r = {
    id,
    environment: c.environment,
    installation_id: c.installationId,
    ops_installation_id: c.opsInstallationId,
    build_id: binding.build_id,
    kind: obs ? 'observation' : 'feedback',
    submission_build_id: c.buildId,
    source_role: actor.role,
    actor_key: req.actorKey,
    operator_user_id: actor.role === 'operator' ? actor.id : null,
    request_id: input.requestId,
    request_digest: dg,
    request_json: canonicalPackage(req.request),
    receipt_json: canonicalPackage(receipt(String(input.requestId), id, 1, at)),
    ...binding,
    private_json: canonicalPackage(privateData),
    created_at: at,
    expires_at: at + OPS_RETENTION_MS,
    revision: 1,
    severity: 'normal',
    owner_ref: null,
    status: 'open',
    next_review_at: null,
    updated_at: at,
    details_removed_at: null,
    latest_event_id: eid,
    redaction_event_id: null,
  };
  const e = await feedbackEvent(
    c,
    r,
    actor,
    operation,
    input,
    eid,
    'submitted',
    at,
    pubFeedback(r, obs),
    privFeedback(r, obs),
    null,
  );
  try {
    await feedbackBatch(c, [
      insert(c, 'ops_feedback', r),
      insert(c, 'ops_feedback_event', e),
    ]);
  } catch (error) {
    const saved = await one(
      c,
      `SELECT * FROM ops_feedback WHERE ${scopedSql} AND actor_key=? AND request_id=?`,
      [...params(c), req.actorKey, input.requestId],
    );
    if (saved && saved.request_digest === dg)
      return json(saved.receipt_json) as unknown as OpsReceipt;
    if (saved) fail('OPS_CONFLICT', 409, Number(saved.revision));
    throw error;
  }
  return receipt(String(input.requestId), id, 1, at);
}
export async function createFeedback(
  c: OpsContext,
  actor: Actor,
  value: unknown,
  source: {
    childId: string;
    runId: string;
    runInstallationId: string;
    candidateId: string;
    lessonId: string;
    lessonVersion: string;
    contentDigest: string;
    buildId: string;
  },
) {
  actorRole(actor, 'parent');
  const v = parseFeedback(value);
  if (
    v.runId !== source.runId ||
    source.lessonVersion !== 'forest-01-v4' ||
    !digest(source.contentDigest) ||
    ![
      source.childId,
      source.runInstallationId,
      source.candidateId,
      source.buildId,
    ].every(slug)
  )
    fail('INVALID_REQUEST', 400);
  return createRecord(
    c,
    actor,
    v as unknown as Row,
    `POST /api/pilot/children/${source.childId}/feedback`,
    {
      child_id: source.childId,
      run_id: source.runId,
      run_installation_id: source.runInstallationId,
      candidate_id: source.candidateId,
      lesson_id: source.lessonId,
      lesson_version: source.lessonVersion,
      content_digest: source.contentDigest,
      build_id: source.buildId,
      category: v.category,
      observation_kind: null,
      observed_at: null,
    },
    {
      schemaVersion: 'r4-feedback-details-1',
      observed: v.observed,
      expected: v.expected,
    },
    null,
  );
}
export async function createObservation(
  c: OpsContext,
  actor: Actor,
  value: unknown,
) {
  actorRole(actor, 'operator');
  const v = parseObservation(value, clock(c)),
    o = v.observation;
  return createRecord(
    c,
    actor,
    v as unknown as Row,
    'POST /api/pilot/ops/observations',
    {
      child_id: null,
      run_id: null,
      run_installation_id: null,
      candidate_id: o.candidateId,
      lesson_id: o.lessonVersion.replace(/-v\d+$/, ''),
      lesson_version: o.lessonVersion,
      content_digest: o.contentDigest,
      build_id: o.candidateId,
      category: null,
      observation_kind: o.kind,
      observed_at: o.observedAt,
    },
    { schemaVersion: 'r4-observation-details-1', observation: o },
    o,
  );
}
async function recordReplay(
  c: OpsContext,
  r: Row,
  actor: Actor,
  operation: string,
  input: Row,
) {
  const req = await requestIdentity(c, actor, operation, input, r);
  const e = await one(
    c,
    'SELECT * FROM ops_feedback_event WHERE environment=? AND installation_id=? AND ops_installation_id=? AND actor_key=? AND request_id=?',
    [
      r.environment,
      r.installation_id,
      r.ops_installation_id,
      req.actorKey,
      input.requestId,
    ],
  );
  if (!e) return null;
  if (e.record_id !== r.id || e.request_digest !== (await hash(req.request)))
    fail('OPS_CONFLICT', 409, Number(r.revision));
  return json(e.receipt_json) as unknown as OpsReceipt;
}
async function currentObservation(
  c: OpsContext,
  r: Row,
): Promise<OpsObservation | null> {
  if (r.kind !== 'observation' || r.details_removed_at !== null) return null;
  const e = await rows(
    c,
    'SELECT private_json FROM ops_feedback_event WHERE record_id=? AND private_json IS NOT NULL ORDER BY sequence DESC',
    [r.id],
  );
  for (const v of e) {
    const p = json(v.private_json);
    if (p.observation) return p.observation as OpsObservation;
  }
  return json(r.private_json).observation as OpsObservation;
}
async function mutateRecord(
  c: OpsContext,
  actor: Actor,
  id: string,
  value: Row,
  kind: string,
  operation: string,
) {
  actorRole(actor, 'operator');
  let r = await feedbackRow(c, id);
  if (!r) fail('NOT_FOUND', 404);
  const replay = await recordReplay(c, r, actor, operation, value);
  if (replay) return replay;
  await expireFeedback(c, { recordIds: [id] });
  r = await feedbackRow(c, id);
  if (!r) fail('NOT_FOUND', 404);
  if (r.details_removed_at !== null)
    fail('OPS_DETAILS_EXPIRED', 409, Number(r.revision));
  if (!current(c, r)) fail('OPS_HISTORY_ONLY', 409, Number(r.revision));
  if (r.revision !== value.expectedRevision)
    fail('OPS_CONFLICT', 409, Number(r.revision));
  let obs = await currentObservation(c, r);
  if (kind === 'corrected') {
    if (r.kind !== 'observation') fail('INVALID_REQUEST', 400);
    const o = value.observation as OpsObservation;
    if (
      o.kind !== r.observation_kind ||
      o.candidateId !== r.candidate_id ||
      o.lessonVersion !== r.lesson_version ||
      o.contentDigest !== r.content_digest
    )
      fail('INVALID_REQUEST', 400);
    obs = o;
  }
  const at = clock(c);
  if (at < Number(r.updated_at)) fail('OPS_CONFLICT', 409, Number(r.revision));
  const eid = identity(),
    next = {
      ...r,
      revision: Number(r.revision) + 1,
      updated_at: at,
      latest_event_id: eid,
      ...(kind === 'triaged'
        ? {
            severity: value.severity,
            owner_ref: value.ownerRef,
            status: value.status,
            next_review_at: value.nextReviewAt,
          }
        : {}),
    };
  const e = await feedbackEvent(
    c,
    next,
    actor,
    operation,
    value,
    eid,
    kind,
    at,
    pubFeedback(next, obs, kind === 'triaged' ? (value.acIds as string[]) : []),
    privFeedback(
      next,
      obs,
      kind === 'triaged'
        ? { disposition: value.disposition, retestRef: value.retestRef }
        : { correctionReason: value.correctionReason },
    ),
    String(r.latest_event_id),
  );
  const commands = [
    guard(
      c,
      'EXISTS(SELECT 1 FROM ops_feedback WHERE id=? AND revision=? AND details_removed_at IS NULL AND expires_at>?)',
      [id, r.revision, at],
    ),
    statement(
      c,
      'UPDATE ops_feedback SET revision=?,severity=?,owner_ref=?,status=?,next_review_at=?,updated_at=?,latest_event_id=? WHERE id=?',
      [
        next.revision,
        next.severity,
        next.owner_ref,
        next.status,
        next.next_review_at,
        at,
        eid,
        id,
      ],
    ),
    insert(c, 'ops_feedback_event', e),
  ];
  try {
    await feedbackBatch(c, commands);
  } catch (error) {
    const latest = await feedbackRow(c, id);
    if (latest) {
      const saved = await recordReplay(c, latest, actor, operation, value);
      if (saved) return saved;
      if (latest.revision !== r.revision)
        fail('OPS_CONFLICT', 409, Number(latest.revision));
    }
    throw error;
  }
  return receipt(String(value.requestId), id, Number(next.revision), at);
}
export async function triageFeedback(
  c: OpsContext,
  actor: Actor,
  id: string,
  value: unknown,
) {
  return mutateRecord(
    c,
    actor,
    id,
    parseTriage(value) as unknown as Row,
    'triaged',
    `POST /api/pilot/ops/feedback/${id}/triage`,
  );
}
export async function correctObservation(
  c: OpsContext,
  actor: Actor,
  id: string,
  value: unknown,
) {
  return mutateRecord(
    c,
    actor,
    id,
    parseCorrection(value, clock(c)) as unknown as Row,
    'corrected',
    `POST /api/pilot/ops/observations/${id}/corrections`,
  );
}
export async function expireFeedback(
  c: OpsContext,
  options: { recordIds?: string[]; limit?: number } = {},
) {
  const at = clock(c),
    limit = options.limit ?? 50;
  if (
    !integer(limit, 1) ||
    limit > 100 ||
    (options.recordIds && !options.recordIds.every(slug))
  )
    fail('INVALID_REQUEST', 400);
  const ids = options.recordIds;
  const found = await rows(
    c,
    `SELECT * FROM ops_feedback WHERE details_removed_at IS NULL AND expires_at<=? ${ids ? 'AND id IN (' + ids.map(() => '?').join(',') + ')' : ''} ORDER BY expires_at,id LIMIT ?`,
    [at, ...(ids ?? []), limit],
  );
  const expiredIds: string[] = [];
  for (const r of found) {
    const eid = identity(),
      next = {
        ...r,
        revision: Number(r.revision) + 1,
        status: 'expired',
        owner_ref: null,
        next_review_at: null,
        updated_at: at,
        details_removed_at: at,
        latest_event_id: eid,
        redaction_event_id: eid,
      };
    const input = { requestId: `expire-${eid}`, expectedRevision: r.revision };
    const actor = { id: 'ops-retention', role: 'system' };
    const e = await feedbackEvent(
      c,
      next,
      actor,
      'retention-expiry',
      input,
      eid,
      'redacted',
      at,
      pubFeedback(next),
      null,
      String(r.latest_event_id),
    );
    await feedbackBatch(c, [
      guard(
        c,
        'EXISTS(SELECT 1 FROM ops_feedback WHERE id=? AND revision=? AND details_removed_at IS NULL AND expires_at<=?)',
        [r.id, r.revision, at],
      ),
      statement(
        c,
        "UPDATE ops_feedback SET revision=?,status='expired',owner_ref=NULL,next_review_at=NULL,updated_at=?,details_removed_at=?,latest_event_id=?,redaction_event_id=?,private_json=NULL,request_json=NULL WHERE id=?",
        [next.revision, at, at, eid, eid, r.id],
      ),
      statement(
        c,
        'UPDATE ops_feedback_event SET request_json=NULL,private_json=NULL,redacted_at=? WHERE record_id=? AND redacted_at IS NULL',
        [at, r.id],
      ),
      insert(c, 'ops_feedback_event', e),
    ]);
    expiredIds.push(String(r.id));
  }
  const ledger = await one(
    c,
    'SELECT queue_revision FROM ops_installation WHERE id=1',
  );
  return { expiredIds, queueRevision: Number(ledger?.queue_revision ?? 0) };
}
const summary = (c: OpsContext, r: Row): OpsSummary => ({
  id: String(r.id),
  kind: r.kind as OpsSummary['kind'],
  revision: Number(r.revision),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  candidateId: String(r.candidate_id),
  lessonId: String(r.lesson_id),
  lessonVersion: String(r.lesson_version),
  contentDigest: String(r.content_digest),
  buildId: String(r.build_id),
  submissionBuildId: String(r.submission_build_id),
  category: r.category as OpsSummary['category'],
  severity: r.severity as OpsSummary['severity'],
  ownerRef: r.owner_ref as string | null,
  status: r.status as OpsSummary['status'],
  nextReviewAt: r.next_review_at as number | null,
  detailsRemoved: r.details_removed_at !== null,
  historical: !current(c, r),
  readOnly: r.details_removed_at !== null || !current(c, r),
});
const encode = (value: unknown) =>
  btoa(
    String.fromCharCode(...new TextEncoder().encode(canonicalPackage(value))),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
function decode(value: string): Row {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      fail('INVALID_REQUEST', 400);
    const data = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const v = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(data, (ch) => ch.charCodeAt(0))),
    );
    if (encode(v) !== value) fail('INVALID_REQUEST', 400);
    return v;
  } catch {
    fail('INVALID_REQUEST', 400);
  }
}
function cursorCheck(c: OpsContext, v: Row, kind: string, revision: number) {
  if (
    v.schemaVersion !== 'r4-ops-cursor-1' ||
    v.kind !== kind ||
    v.installationId !== c.installationId ||
    v.opsInstallationId !== c.opsInstallationId
  )
    fail('INVALID_REQUEST', 400);
  if (v.revision !== revision) fail('OPS_CURSOR_STALE', 409, revision);
}
const historyView = (r: Row): OpsHistory => {
  const pub = json(r.public_json),
    priv = r.private_json === null ? null : json(r.private_json);
  const { schemaVersion: _pub, ...publicData } = pub;
  const privateData = priv
    ? {
        ownerRef: priv.ownerRef as string | null,
        disposition: String(priv.disposition),
        retestRef: priv.retestRef as string | null,
        correctionReason: priv.correctionReason as string | null,
        observation: priv.observation as OpsObservation | null,
      }
    : null;
  return {
    id: String(r.id),
    sequence: Number(r.sequence),
    kind: r.kind as OpsHistory['kind'],
    recordedAt: Number(r.created_at),
    actorUserId: r.actor_user_id as string | null,
    receipt: json(r.receipt_json) as unknown as OpsReceipt,
    public: publicData as unknown as OpsHistory['public'],
    private: privateData,
    detailsRemoved: r.redacted_at !== null,
  };
};
export async function readFeedbackHistory(
  c: OpsContext,
  id: string,
  options: OpsHistoryOptions = {},
) {
  await expireFeedback(c, { recordIds: [id] });
  const r = await feedbackRow(c, id);
  if (!r) fail('NOT_FOUND', 404);
  const limit = options.limit ?? 20;
  if (!integer(limit, 1) || limit > 50) fail('INVALID_REQUEST', 400);
  let before = Number(r.revision) + 1;
  if (options.cursor) {
    const v = decode(options.cursor);
    if (v.recordId !== id || !integer(v.lastSequence, 1))
      fail('INVALID_REQUEST', 400);
    cursorCheck(c, v, 'history', Number(r.revision));
    before = Number(v.lastSequence);
  }
  const found = await rows(
    c,
    'SELECT * FROM ops_feedback_event WHERE record_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?',
    [id, before, limit + 1],
  );
  if (r.details_removed_at === null && clock(c) >= Number(r.expires_at)) {
    await expireFeedback(c, { recordIds: [id] });
    return readFeedbackHistory(c, id, options);
  }
  const selected = found.slice(0, limit),
    last = selected.at(-1);
  return {
    items: selected.map(historyView).reverse(),
    recordId: id,
    recordRevision: Number(r.revision),
    nextCursor:
      found.length > limit && last
        ? encode({
            schemaVersion: 'r4-ops-cursor-1',
            kind: 'history',
            installationId: c.installationId,
            opsInstallationId: c.opsInstallationId,
            recordId: id,
            revision: r.revision,
            lastSequence: last.sequence,
          })
        : null,
  };
}
export async function readFeedback(
  c: OpsContext,
  id: string,
): Promise<OpsDetail> {
  await expireFeedback(c, { recordIds: [id] });
  let r = await feedbackRow(c, id);
  if (!r) fail('NOT_FOUND', 404);
  const h = await readFeedbackHistory(c, id);
  r = await feedbackRow(c, id);
  if (!r) fail('NOT_FOUND', 404);
  const p = r.private_json === null ? null : json(r.private_json);
  const obs = await currentObservation(c, r);
  if (r.details_removed_at === null && clock(c) >= Number(r.expires_at)) {
    await expireFeedback(c, { recordIds: [id] });
    return readFeedback(c, id);
  }
  return {
    ...summary(c, r),
    childId: r.child_id as string | null,
    runId: r.run_id as string | null,
    runInstallationId: r.run_installation_id as string | null,
    sourceRole: r.source_role as OpsDetail['sourceRole'],
    observationKind: r.observation_kind as OpsDetail['observationKind'],
    details:
      p === null
        ? null
        : r.kind === 'observation'
          ? { observation: obs! }
          : { observed: String(p.observed), expected: String(p.expected) },
    history: h.items,
    historyRevision: h.recordRevision,
    nextCursor: h.nextCursor,
  };
}
export async function listFeedback(
  c: OpsContext,
  options: OpsQueueOptions = {},
) {
  const filter = {
      status: options.status ?? 'active',
      kind: options.kind ?? 'all',
    },
    limit = options.limit ?? 20;
  if (
    ![
      'active',
      'all',
      'open',
      'in-progress',
      'awaiting-review',
      'resolved',
      'expired',
    ].includes(filter.status) ||
    !['all', 'feedback', 'observation'].includes(filter.kind) ||
    !integer(limit, 1) ||
    limit > 50
  )
    fail('INVALID_REQUEST', 400);
  for (let n = 0; n < 1000; n++) {
    const redacted = await expireFeedback(c, { limit: 100 });
    if (redacted.expiredIds.length < 100) break;
    if (n === 999) fail('OPS_UNAVAILABLE', 503);
  }
  const ledger = await one(
    c,
    'SELECT queue_revision FROM ops_installation WHERE id=1',
  );
  const revision = Number(ledger?.queue_revision ?? 0);
  let boundary = '',
    args: unknown[] = [];
  if (options.cursor) {
    const v = decode(options.cursor);
    cursorCheck(c, v, 'queue', revision);
    if (
      canonicalPackage(v.filter) !== canonicalPackage(filter) ||
      !integer(v.lastCreatedAt) ||
      !slug(v.lastId)
    )
      fail('INVALID_REQUEST', 400);
    boundary = ' AND (created_at>? OR (created_at=? AND id>?))';
    args = [v.lastCreatedAt, v.lastCreatedAt, v.lastId];
  }
  const where =
    filter.status === 'all'
      ? '1=1'
      : `${scopedSql} AND ` +
        (filter.status === 'active'
          ? "status NOT IN ('resolved','expired')"
          : 'status=?');
  const bindings =
    filter.status === 'all'
      ? []
      : [...params(c), ...(filter.status === 'active' ? [] : [filter.status])];
  const found = await rows(
    c,
    `SELECT * FROM ops_feedback WHERE ${where} ${filter.kind === 'all' ? '' : 'AND kind=?'} ${boundary} ORDER BY created_at,id LIMIT ?`,
    [
      ...bindings,
      ...(filter.kind === 'all' ? [] : [filter.kind]),
      ...args,
      limit + 1,
    ],
  );
  if (
    found.some(
      (r) => r.details_removed_at === null && clock(c) >= Number(r.expires_at),
    )
  ) {
    await expireFeedback(c, { recordIds: found.map((r) => String(r.id)) });
    return listFeedback(c, options);
  }
  const selected = found.slice(0, limit),
    last = selected.at(-1);
  return {
    items: selected.map((r) => summary(c, r)),
    queueRevision: revision,
    nextCursor:
      found.length > limit && last
        ? encode({
            schemaVersion: 'r4-ops-cursor-1',
            kind: 'queue',
            installationId: c.installationId,
            opsInstallationId: c.opsInstallationId,
            filter,
            revision,
            lastCreatedAt: last.created_at,
            lastId: last.id,
          })
        : null,
  };
}
async function conditionStatements(
  c: OpsContext,
  code: OpsAlertCode,
  active: boolean,
  jobId: string | null,
  at: number,
) {
  const existing = await one(
    c,
    `SELECT * FROM ops_alert_event WHERE ${scopedSql} AND code=? ORDER BY sequence DESC LIMIT 1`,
    [...params(c), code],
  );
  if (!active && (!existing || existing.status_after === 'resolved')) return [];
  if (active && existing && existing.status_after !== 'resolved') return [];
  const id = identity(),
    alertId = existing ? String(existing.alert_id) : identity(),
    sequence = Number(existing?.sequence ?? 0) + 1,
    status = active ? 'open' : 'resolved';
  const request = {
    schemaVersion: 'r4-alert-operation-1',
    operation: 'condition',
    eventId: id,
    code,
    active,
    jobId,
  };
  const publicData = {
    schemaVersion: 'r4-alert-event-1',
    statusAfter: status,
    condition: code,
    jobId,
    notification: existing
      ? json(existing.public_json).notification
      : 'unconfigured',
    acknowledgedAt: null,
    acknowledgedBy: null,
    request,
  };
  const row = {
    id,
    alert_id: alertId,
    environment: c.environment,
    installation_id: c.installationId,
    ops_installation_id: c.opsInstallationId,
    build_id: c.buildId,
    sequence,
    previous_event_id: existing?.id ?? null,
    kind: existing ? (active ? 'reopened' : 'resolved') : 'opened',
    status_after: status,
    code,
    job_id: jobId,
    actor_user_id: null,
    request_id: id,
    actor_key: await hash({ ...scope(c), operation: 'condition', code }),
    request_digest: await hash(request),
    receipt_json: canonicalPackage(receipt(id, alertId, sequence, at)),
    public_json: canonicalPackage(publicData),
    created_at: at,
  };
  return [
    guard(
      c,
      existing
        ? 'NOT EXISTS(SELECT 1 FROM ops_alert_event WHERE alert_id=? AND sequence>?)'
        : `NOT EXISTS(SELECT 1 FROM ops_alert_event WHERE ${scopedSql} AND code=?)`,
      existing ? [alertId, existing.sequence] : [...params(c), code],
    ),
    insert(c, 'ops_alert_event', row),
  ];
}
export async function recordOpsNotification(c: OpsContext, value: unknown) {
  const v = safeJson(value);
  if (
    !exact(v, ['alertId', 'eventId', 'outcome']) ||
    !slug(v.alertId) ||
    !slug(v.eventId) ||
    !['delivered', 'failed'].includes(String(v.outcome))
  )
    fail('INVALID_REQUEST', 400);
  const saved = await one(
    c,
    `SELECT * FROM ops_alert_event WHERE id=? AND ${scopedSql}`,
    [v.eventId, ...params(c)],
  );
  if (saved) {
    if (saved.request_digest !== (await hash(v)))
      fail('OPS_CONFLICT', 409, Number(saved.sequence));
    return json(saved.receipt_json);
  }
  const r = await one(
    c,
    `SELECT * FROM ops_alert_event WHERE alert_id=? AND ${scopedSql} ORDER BY sequence DESC LIMIT 1`,
    [v.alertId, ...params(c)],
  );
  if (!r) fail('NOT_FOUND', 404);
  const at = clock(c),
    sequence = Number(r.sequence) + 1,
    ack = receipt(String(v.eventId), String(v.alertId), sequence, at),
    pub = json(r.public_json);
  await alertBatch(c, [
    guard(
      c,
      'NOT EXISTS(SELECT 1 FROM ops_alert_event WHERE alert_id=? AND sequence>?)',
      [v.alertId, r.sequence],
    ),
    insert(c, 'ops_alert_event', {
      ...r,
      id: v.eventId,
      sequence,
      previous_event_id: r.id,
      kind:
        v.outcome === 'delivered'
          ? 'notification-delivered'
          : 'notification-failed',
      actor_user_id: null,
      request_id: v.eventId,
      actor_key: await hash({
        ...scope(c),
        operation: 'notification',
        alertId: v.alertId,
      }),
      request_digest: await hash(v),
      receipt_json: canonicalPackage(ack),
      public_json: canonicalPackage({
        ...pub,
        notification: v.outcome,
        request: v,
      }),
      created_at: at,
    }),
    ...(await conditionStatements(
      c,
      'OPS_NOTIFICATION_FAILED',
      v.outcome === 'failed',
      r.job_id as string | null,
      at,
    )),
  ]);
  return ack;
}
async function alertRows(c: OpsContext) {
  return rows(
    c,
    `SELECT e.* FROM ops_alert_event e WHERE e.${scopedSql.replaceAll(' AND ', ' AND e.')} AND e.sequence=(SELECT max(x.sequence) FROM ops_alert_event x WHERE x.alert_id=e.alert_id) ORDER BY e.created_at,e.alert_id`,
    params(c),
  );
}
const alertView = (c: OpsContext, r: Row): OpsAlert => {
  const p = json(r.public_json);
  return {
    id: String(r.alert_id),
    revision: Number(r.sequence),
    code: r.code as OpsAlertCode,
    status: r.status_after as OpsAlert['status'],
    createdAt: Number(p.openedAt ?? r.created_at),
    updatedAt: Number(r.created_at),
    jobId: r.job_id as string | null,
    acknowledgedBy: p.acknowledgedBy as string | null,
    acknowledgedAt: p.acknowledgedAt as number | null,
    notification: p.notification as OpsAlert['notification'],
    historical: !current(c, r),
  };
};
export async function acknowledgeAlert(
  c: OpsContext,
  actor: Actor,
  id: string,
  value: unknown,
) {
  actorRole(actor, 'operator');
  const v = parseAck(value),
    r = await one(
      c,
      'SELECT * FROM ops_alert_event WHERE alert_id=? ORDER BY sequence DESC LIMIT 1',
      [id],
    );
  if (!r) fail('NOT_FOUND', 404);
  const operation = `POST /api/pilot/ops/alerts/${id}/ack`,
    req = await requestIdentity(c, actor, operation, v, r),
    dg = await hash(req.request);
  const saved = await one(
    c,
    'SELECT * FROM ops_alert_event WHERE actor_key=? AND request_id=?',
    [req.actorKey, v.requestId],
  );
  if (saved) {
    if (saved.request_digest !== dg)
      fail('OPS_CONFLICT', 409, Number(r.sequence));
    return json(saved.receipt_json) as unknown as OpsReceipt;
  }
  if (!current(c, r)) fail('OPS_HISTORY_ONLY', 409, Number(r.sequence));
  if (v.expectedRevision !== r.sequence || r.status_after === 'resolved')
    fail('OPS_CONFLICT', 409, Number(r.sequence));
  const at = clock(c),
    revision = Number(r.sequence) + 1,
    eid = identity(),
    p = json(r.public_json);
  await alertBatch(c, [
    guard(
      c,
      'NOT EXISTS(SELECT 1 FROM ops_alert_event WHERE alert_id=? AND sequence>?)',
      [id, r.sequence],
    ),
    insert(c, 'ops_alert_event', {
      ...r,
      id: eid,
      sequence: revision,
      previous_event_id: r.id,
      kind: 'acknowledged',
      status_after: 'acknowledged',
      actor_user_id: actor.id,
      request_id: v.requestId,
      actor_key: req.actorKey,
      request_digest: dg,
      receipt_json: canonicalPackage(receipt(v.requestId, id, revision, at)),
      public_json: canonicalPackage({
        ...p,
        statusAfter: 'acknowledged',
        acknowledgedAt: at,
        acknowledgedBy: actor.id,
        request: req.request,
      }),
      created_at: at,
    }),
  ]);
  return receipt(v.requestId, id, revision, at);
}
export async function readOpsStatus(c: OpsContext): Promise<OpsStatus> {
  const jobs = await rows(
      c,
      `SELECT * FROM ops_job WHERE ${scopedSql} ORDER BY started_at DESC,id LIMIT 20`,
      params(c),
    ),
    a = await listVerifiedArchives(c),
    points = new Map<string, OpsArchiveMetadata[]>();
  for (const archive of a)
    if (!archive.deleted)
      points.set(archive.jobId, [
        ...(points.get(archive.jobId) ?? []),
        archive,
      ]);
  const pairs = [...points.values()]
    .filter((p) => p.length === 2 && new Set(p.map((v) => v.kind)).size === 2)
    .sort(
      (p, q) =>
        q[0].dailySlot.localeCompare(p[0].dailySlot) ||
        q[0].jobId.localeCompare(p[0].jobId),
    );
  const pair = pairs[0],
    dataAt = pair ? Math.min(...pair.map((v) => v.dataAt)) : null,
    verified = pair ? Math.max(...pair.map((v) => v.verifiedAt)) : null,
    at = clock(c);
  const monitors = await rows(
    c,
    `SELECT e.* FROM ops_job_event e JOIN ops_job j ON j.id=e.job_id WHERE j.${scopedSql.replaceAll(' AND ', ' AND j.')} AND j.kind='monitor' AND e.kind='completed' ORDER BY e.created_at DESC,e.id LIMIT 1`,
    params(c),
  );
  const monitor = monitors[0]
    ? (json(monitors[0].public_json).monitor as Row)
    : null;
  const conditions = [
    ...(await conditionStatements(
      c,
      'OPS_BACKUP_STALE',
      dataAt === null || at - dataAt > OPS_FRESHNESS_MS,
      null,
      at,
    )),
    ...(await conditionStatements(
      c,
      'OPS_MONITOR_UNKNOWN',
      !monitor,
      null,
      at,
    )),
  ];
  if (conditions.length) await batch(c, conditions);
  const alerts = (await alertRows(c))
    .map((r) => alertView(c, r))
    .filter((r) => r.status !== 'resolved');
  const age = dataAt === null ? null : Math.max(0, at - dataAt);
  let state: OpsStatus['monitorState'] = !monitor
    ? 'unknown'
    : dataAt === null ||
        age! > OPS_FRESHNESS_MS ||
        monitor.health !== 'healthy' ||
        alerts.some((v) =>
          [
            'OPS_BACKUP_FAILED',
            'OPS_PROBE_FAILED',
            'OPS_BACKUP_STALE',
          ].includes(v.code),
        )
      ? 'unhealthy'
      : 'healthy';
  if (
    jobs.some(
      (j) =>
        j.kind === 'monitor' &&
        j.status !== 'succeeded' &&
        (!monitor ||
          Number(j.started_at) > Number(monitors[0]?.created_at ?? 0)),
    )
  )
    state = 'unknown';
  return {
    monitorState: state,
    targets: {
      dailyAtUtc: '02:00',
      dailyPoints: 7,
      weeklyPoints: 4,
      freshnessMs: OPS_FRESHNESS_MS,
      feedbackRetentionMs: OPS_RETENTION_MS,
    },
    lastVerifiedBackupAt: verified,
    lastBackupDataAt: dataAt,
    backupAgeMs: age,
    lastMonitorAt: monitor ? Number(monitor.checkedAt) : null,
    notification: alerts.some((v) => v.notification === 'failed')
      ? 'failed'
      : alerts.some((v) => v.notification === 'delivered')
        ? 'delivered'
        : 'unconfigured',
    jobs: await Promise.all(jobs.map((r) => jobView(c, r))),
    alerts,
  };
}
export async function readOpsJob(c: OpsContext, id: string) {
  const r = await one(c, 'SELECT * FROM ops_job WHERE id=?', [id]);
  if (!r) fail('NOT_FOUND', 404);
  return jobView(c, r);
}
