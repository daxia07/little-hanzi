/** Operator DTOs and immutable-request recovery. No server validators or graders. */
import {
  pilotRequest,
  hasPendingSignOut,
  type PilotMe,
} from './pilot-client.ts';
import {
  createCorpusEntryApi,
  CorpusEntryError,
  copyEntryJson,
  decodeEntry,
  entryAccepts,
  entryText as text,
  entryInteger as integer,
  entryBool as bool,
  entryEnum as oneOf,
  entryDigest as digest,
  entryDate as date,
  entryNullable as nullable,
  entryList as list,
  entryTargetRule,
} from './pilot-corpus-entry-client.ts';
import type {
  CorpusMetadataResponse,
  CorpusCoverageResponse,
  CorpusBatchResponse,
  CorpusSnapshotResponse,
  CorpusSnapshotMembersResponse,
  CorpusSnapshotBeginReceipt,
  CorpusSnapshotChunkReceipt,
  CorpusSnapshotSealReceipt,
  CorpusPublicationReceipt,
} from './curriculum/corpus-types.ts';
import type {
  CorpusBatchValidationResponse,
  CorpusSnapshotPackagesResponse,
  CorpusSafeDecision,
  CorpusOwnerDecisionsResponse,
  CorpusSafePublication,
  CorpusPublicationHeadResponse,
} from './curriculum/corpus-entry-types.ts';
const receipt = { requestId: text(120), recordId: text(120), recordedAt: date };
const members = list({ parentId: text(120), childId: text(120) }, 100, 1);
const ordinaryScope = (v: unknown) => entryScope(v, false),
  publicationScope = (v: unknown) => entryScope(v, true);
function entryScope(v: unknown, verification: boolean) {
  try {
    decodeEntry(v, { kind: oneOf('starter') });
    return true;
  } catch {}
  try {
    const s = decodeEntry<{
      kind: string;
      members: Array<{ parentId: string; childId: string }>;
    }>(v, {
      kind: verification
        ? oneOf('supervised-trial', 'verification')
        : oneOf('supervised-trial'),
      members,
    });
    return new Set(s.members.map((m) => m.childId)).size === s.members.length;
  } catch {
    return false;
  }
}
const publicationReceipt = {
  ...receipt,
  revision: integer,
  corpusDigest: digest,
  snapshotId: text(120),
};
const safeDecisionRule = {
  receipt,
  snapshotId: text(120),
  scope: ordinaryScope,
  decision: oneOf('accepted', 'rejected'),
};
const safePublicationRule = {
  receipt: publicationReceipt,
  snapshotId: text(120),
  ownerDecisionId: nullable(text(120)),
  scope: publicationScope,
  status: oneOf('released', 'withdrawn'),
  predecessorPublicationId: nullable(text(120)),
};
const counts = {
  fixture: integer,
  machineValidDraft: integer,
  reviewedReady: integer,
  supervisedTrial: integer,
  prospectiveStarter: integer,
  committedStarter: integer,
};
const coverageItem = {
  coverageIdentity: text(8),
  characterId: text(120),
  lessonVersion: text(120),
  contentDigest: digest,
  classification: oneOf(
    'verification-fixture',
    'unverified-draft',
    'real-source-reviewed',
  ),
  eligible: bool,
  reasonCodes: list(text(120), 32),
  evidenceRefs: list(text(240), 32),
};
const batchItems = list(
  {
    lessonVersion: text(120),
    contentDigest: digest,
    state: oneOf('accepted', 'rejected'),
    errors: list({ fieldId: text(120), code: text(120) }, 100),
  },
  50,
  1,
);
const snapshotCounts = {
  candidatePackageCount: integer,
  targetCount: integer,
  packageCount: integer,
  includedCharacterCount: integer,
  excludedTargetCount: integer,
  fixtureCharacterCount: integer,
  verificationPackageCount: integer,
};
export function normalizeCorpusMetadata(v: unknown): CorpusMetadataResponse {
  return decodeEntry(v, {
    schemaVersion: oneOf('r6-corpora-1'),
    items: list({
      corpusId: text(120),
      corpusVersion: text(120),
      corpusDigest: digest,
      policyVersion: oneOf('r6-corpus-policy-1'),
      packageCount: integer,
      importedAt: date,
    }),
    nextCursor: nullable(text(4096)),
  });
}
export function normalizeCorpusCoverage(
  v: unknown,
  version: string,
): CorpusCoverageResponse {
  const r = decodeEntry<CorpusCoverageResponse>(v, {
    schemaVersion: oneOf('r6-coverage-1'),
    corpusVersion: text(120),
    corpusDigest: digest,
    dataAt: date,
    lane: oneOf('ordinary', 'verification'),
    fixtureCharacterCount: integer,
    verificationPackageCount: integer,
    counts,
    snapshot: nullable({
      snapshotId: text(120),
      digest,
      includedCharacterCount: integer,
      excludedTargetCount: integer,
      packageCount: integer,
      createdAt: date,
    }),
    release: nullable({
      releaseId: text(120),
      revision: integer,
      status: oneOf('released', 'withdrawn'),
      snapshotCharacterCount: integer,
      currentEligibleCharacterCount: integer,
    }),
    items: list(coverageItem),
    nextCursor: nullable(text(4096)),
  });
  if (r.corpusVersion !== version)
    throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
  return r;
}
export function normalizeCorpusBatch(v: unknown): CorpusBatchResponse {
  return decodeEntry(v, {
    schemaVersion: oneOf('r6-batch-1'),
    batchId: text(120),
    batchVersion: text(120),
    manifestDigest: digest,
    recordedAt: date,
    items: batchItems,
  });
}
export function normalizeCorpusBatchValidation(
  v: unknown,
): CorpusBatchValidationResponse {
  return decodeEntry(v, {
    schemaVersion: oneOf('r6-batch-validation-1'),
    batchId: text(120),
    batchVersion: text(120),
    manifestDigest: digest,
    checkedAt: date,
    items: batchItems,
  });
}
export function normalizeCorpusSnapshot(
  v: unknown,
  version: string,
  id: string,
): CorpusSnapshotResponse {
  const r = decodeEntry<CorpusSnapshotResponse>(v, {
    schemaVersion: oneOf('r6-snapshot-1'),
    snapshotId: text(120),
    corpusVersion: text(120),
    corpusDigest: digest,
    status: oneOf('building', 'sealed'),
    lane: oneOf('ordinary', 'verification'),
    candidateId: text(120),
    buildId: text(120),
    planDigest: digest,
    prospectiveDigest: nullable(digest),
    exclusionReportDigest: nullable(digest),
    createdAt: date,
    sealedAt: nullable(date),
    counts: snapshotCounts,
  });
  if (r.snapshotId !== id || r.corpusVersion !== version)
    throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
  return r;
}
export function normalizeCorpusSnapshotPackages(
  v: unknown,
  id: string,
): CorpusSnapshotPackagesResponse {
  const r = decodeEntry<CorpusSnapshotPackagesResponse>(v, {
    schemaVersion: oneOf('r6-snapshot-packages-1'),
    snapshotId: text(120),
    items: list({
      lessonVersion: text(120),
      contentDigest: digest,
      title: text(120),
      targets: list(entryTargetRule, 2, 2),
      chunked: bool,
    }),
    nextCursor: nullable(text(4096)),
  });
  if (r.snapshotId !== id) throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
  if (new Set(r.items.map((i) => i.lessonVersion)).size !== r.items.length)
    throw new CorpusEntryError(502, 'INVALID_RESPONSE');
  return r;
}
export function normalizeCorpusDecision(v: unknown): CorpusSafeDecision {
  return decodeEntry(v, safeDecisionRule);
}
export function normalizeCorpusDecisions(
  v: unknown,
  id: string,
): CorpusOwnerDecisionsResponse {
  const r = decodeEntry<CorpusOwnerDecisionsResponse>(v, {
    schemaVersion: oneOf('r6-owner-decisions-1'),
    snapshotId: text(120),
    items: list(safeDecisionRule),
    nextCursor: nullable(text(4096)),
  });
  if (r.snapshotId !== id || r.items.some((i) => i.snapshotId !== id))
    throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
  return r;
}
export function normalizeCorpusPublication(v: unknown): CorpusSafePublication {
  const r = decodeEntry<CorpusSafePublication>(v, safePublicationRule);
  if (r.receipt.snapshotId !== r.snapshotId)
    throw new CorpusEntryError(502, 'INVALID_RESPONSE');
  return r;
}
export function normalizeCorpusPublicationHead(
  v: unknown,
): CorpusPublicationHeadResponse {
  const r = decodeEntry<CorpusPublicationHeadResponse>(v, {
    publication: nullable(safePublicationRule),
  });
  if (r.publication) normalizeCorpusPublication(r.publication);
  return r;
}
export type CorpusAdminKind =
  | 'register'
  | 'batch'
  | 'begin'
  | 'chunk'
  | 'seal'
  | 'publish'
  | 'withdraw';
export interface CorpusAdminOperation {
  kind: CorpusAdminKind;
  body: unknown;
  snapshotId?: string;
}
export interface CorpusAdminSnapshot {
  status:
    | 'idle'
    | 'saving'
    | 'saved'
    | 'pending'
    | 'readback-pending'
    | 'conflict'
    | 'error'
    | 'locked';
  pending: CorpusAdminOperation | null;
  ack: unknown;
  readback: unknown;
  conflictReady: boolean;
  notice: string;
}
/** Private pending requests survive unknown responses; confirmed ACK recovery reads only. */
export function createCorpusAdminMutation({
  verify,
  send,
  read,
  onChange = () => {},
}: {
  verify: () => Promise<boolean>;
  send: (op: CorpusAdminOperation) => Promise<unknown>;
  read: (op: CorpusAdminOperation, ack: unknown) => Promise<unknown>;
  onChange?: (s: CorpusAdminSnapshot) => void;
}) {
  let s: CorpusAdminSnapshot = {
      status: 'idle',
      pending: null,
      ack: null,
      readback: null,
      conflictReady: false,
      notice: '',
    },
    dead = false,
    epoch = 0;
  const snapshot = () => ({
    ...s,
    pending: s.pending
      ? (copyEntryJson(s.pending) as CorpusAdminOperation)
      : null,
    ack: s.ack === null ? null : copyEntryJson(s.ack),
    readback: s.readback === null ? null : copyEntryJson(s.readback),
  });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    if (dead) return;
    epoch++;
    dead = true;
    s = {
      status: 'locked',
      pending: null,
      ack: null,
      readback: null,
      conflictReady: false,
      notice: 'Your account or access changed. Sign in again.',
    };
    onChange(snapshot());
  }
  async function allowed(token: number) {
    const ok = await verify();
    if (dead || token !== epoch) return false;
    if (!ok) {
      lock();
      return false;
    }
    return true;
  }
  async function run(readOnly: boolean, conflict = false) {
    if (dead || !s.pending) return;
    const token = ++epoch,
      op = copyEntryJson(s.pending) as CorpusAdminOperation;
    s = {
      ...s,
      status: conflict ? 'conflict' : readOnly ? 'readback-pending' : 'saving',
      conflictReady: false,
      notice: '',
    };
    emit();
    try {
      if (!(await allowed(token))) return;
      if (!readOnly) {
        const ack = await send(op);
        if (!(await allowed(token))) return;
        s = { ...s, ack: copyEntryJson(ack), status: 'readback-pending' };
        emit();
      }
      const result = await read(op, s.ack);
      if (!(await allowed(token))) return;
      s = {
        ...s,
        readback: copyEntryJson(result),
        status: conflict ? 'conflict' : 'saved',
        pending: conflict ? s.pending : null,
        conflictReady: conflict,
        notice: conflict
          ? 'Current saved state loaded. Discard the stale request explicitly.'
          : 'Saved and checked.',
      };
      emit();
    } catch (error) {
      if (dead || token !== epoch) return;
      const e = error as { status?: number };
      if ([401, 403, 404].includes(e.status ?? 0)) {
        lock();
        return;
      }
      if (conflict || e.status === 409)
        s = {
          ...s,
          status: 'conflict',
          conflictReady: false,
          notice: 'Saved state changed. Load current state before continuing.',
        };
      else if (s.ack !== null)
        s = {
          ...s,
          status: 'readback-pending',
          notice: 'The request was saved. Retry the saved-state check.',
        };
      else if (e.status === 400)
        s = {
          ...s,
          status: 'error',
          pending: null,
          notice: 'This request was refused. Check the input.',
        };
      else
        s = {
          ...s,
          status: 'pending',
          notice: 'Saving is unconfirmed. Retry this exact request.',
        };
      emit();
    }
  }
  return {
    snapshot,
    async perform(op: CorpusAdminOperation) {
      if (dead || s.pending || s.status === 'saving') return;
      try {
        const original = copyEntryJson(
          op,
          2 * 1024 * 1024,
        ) as CorpusAdminOperation;
        s = { ...s, pending: original, ack: null, readback: null };
      } catch {
        s = {
          ...s,
          status: 'error',
          pending: null,
          notice:
            'This request exceeds the supported input bounds. Check the input.',
        };
        emit();
        return;
      }
      await run(false);
    },
    retry: () =>
      s.status === 'pending'
        ? run(false)
        : s.status === 'readback-pending'
          ? run(true)
          : Promise.resolve(),
    refreshConflict: () =>
      s.status === 'conflict' ? run(true, true) : Promise.resolve(),
    acceptConflict() {
      if (dead || s.status !== 'conflict' || !s.conflictReady) return false;
      s = {
        ...s,
        status: 'idle',
        pending: null,
        ack: null,
        conflictReady: false,
        notice:
          'Stale request discarded. Review current state before making a new request.',
      };
      emit();
      return true;
    },
    lock,
    destroy() {
      dead = true;
      epoch++;
      s = { ...s, pending: null, ack: null, readback: null };
    },
  };
}
export interface CorpusAdminValidationSnapshot {
  status: 'idle' | 'checking' | 'checked' | 'error' | 'locked';
  input: string;
  report: CorpusBatchValidationResponse | null;
  notice: string;
}
/** Validation is a read-only check; access denial clears its private editable input. */
export function createCorpusAdminValidation({
  verify,
  validate,
  onChange = () => {},
  onLock = () => {},
}: {
  verify: () => Promise<boolean>;
  validate: (batch: unknown) => Promise<CorpusBatchValidationResponse>;
  onChange?: (s: CorpusAdminValidationSnapshot) => void;
  onLock?: () => void;
}) {
  let s: CorpusAdminValidationSnapshot = {
      status: 'idle',
      input: '',
      report: null,
      notice: '',
    },
    dead = false,
    epoch = 0;
  const snapshot = () => ({
    ...s,
    report: s.report
      ? (copyEntryJson(s.report) as CorpusBatchValidationResponse)
      : null,
  });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    if (dead) return;
    dead = true;
    epoch++;
    s = {
      status: 'locked',
      input: '',
      report: null,
      notice: 'Your access changed. Sign in again.',
    };
    onChange(snapshot());
    onLock();
  }
  async function allowed(token: number) {
    const ok = await verify();
    if (dead || token !== epoch) return false;
    if (!ok) {
      lock();
      return false;
    }
    return true;
  }
  return {
    snapshot,
    lock,
    destroy() {
      dead = true;
      epoch++;
      s = { ...s, input: '', report: null };
    },
    setInput(input: string) {
      if (dead || s.status === 'checking') return;
      s = { status: 'idle', input, report: null, notice: '' };
      emit();
    },
    async check() {
      if (dead || s.status === 'checking') return;
      const token = ++epoch;
      s = { ...s, status: 'checking', report: null, notice: '' };
      emit();
      try {
        if (!(await allowed(token))) return;
        const report = await validate(JSON.parse(s.input));
        if (!(await allowed(token))) return;
        s = {
          ...s,
          status: 'checked',
          report: copyEntryJson(report) as CorpusBatchValidationResponse,
          notice:
            'Validation checked current bindings. This batch has not been saved.',
        };
        emit();
      } catch (error) {
        if (dead || token !== epoch) return;
        if ([401, 403].includes((error as { status?: number }).status ?? 0)) {
          lock();
          return;
        }
        s = {
          ...s,
          status: 'error',
          report: null,
          notice:
            'Validation could not finish. Check the input or retry validation.',
        };
        emit();
      }
    },
  };
}
function bindBatchIdentity<T extends { batchId: string; batchVersion: string }>(
  report: T,
  batch: unknown,
): T {
  const b = copyEntryJson(batch) as {
    batchId?: unknown;
    batchVersion?: unknown;
  };
  if (report.batchId !== b?.batchId || report.batchVersion !== b?.batchVersion)
    throw new CorpusEntryError(502, 'INVALID_ACK');
  return report;
}
export function createCorpusAdminApi(
  me: PilotMe,
  version: string,
  {
    request = pilotRequest,
    verify,
  }: { request?: typeof pilotRequest; verify?: () => Promise<boolean> } = {},
) {
  const entry = createCorpusEntryApi(me);
  const permitted = verify ?? (() => entry.verify());
  const root = '/api/pilot/corpora/' + encodeURIComponent(version),
    snapshotPath = (id: string) =>
      root + '/snapshots/' + encodeURIComponent(id);
  async function call(path: string, body?: unknown) {
    if (me.user.role !== 'operator')
      throw new CorpusEntryError(403, 'FORBIDDEN');
    if (hasPendingSignOut() || !(await permitted()))
      throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
    const v = await request(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            body: JSON.stringify(copyEntryJson(body, 2 * 1024 * 1024)),
          }),
    });
    if (hasPendingSignOut() || !(await permitted()))
      throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
    return v;
  }
  const query = (cursor: string | null) => {
    const p = new URLSearchParams({ limit: '20' });
    if (cursor) p.set('cursor', cursor);
    return '?' + p;
  };
  return {
    verify: permitted,
    async metadata(cursor: string | null = null) {
      return normalizeCorpusMetadata(
        await call('/api/pilot/corpora' + query(cursor)),
      );
    },
    async coverage(cursor: string | null = null) {
      return normalizeCorpusCoverage(
        await call(root + '/coverage' + query(cursor)),
        version,
      );
    },
    async validate(batch: unknown) {
      const original = copyEntryJson(batch);
      return bindBatchIdentity(
        normalizeCorpusBatchValidation(
          await call(root + '/batches/validate', { batch: original }),
        ),
        original,
      );
    },
    async snapshot(id: string) {
      return normalizeCorpusSnapshot(await call(snapshotPath(id)), version, id);
    },
    async packages(id: string, cursor: string | null = null) {
      return normalizeCorpusSnapshotPackages(
        await call(snapshotPath(id) + '/packages' + query(cursor)),
        id,
      );
    },
    async members(
      id: string,
      status: 'included' | 'excluded',
      cursor: string | null = null,
    ) {
      const r = decodeEntry<CorpusSnapshotMembersResponse>(
        await call(
          snapshotPath(id) + '/members' + query(cursor) + '&status=' + status,
        ),
        {
          schemaVersion: oneOf('r6-snapshot-members-1'),
          snapshotId: text(120),
          status: oneOf(status),
          items: list(coverageItem),
          nextCursor: nullable(text(4096)),
        },
      );
      if (r.snapshotId !== id)
        throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
      return r;
    },
    async decisions(id: string, cursor: string | null = null) {
      return normalizeCorpusDecisions(
        await call(snapshotPath(id) + '/decisions' + query(cursor)),
        id,
      );
    },
    async head() {
      return normalizeCorpusPublicationHead(await call(root + '/publications'));
    },
    async send(op: CorpusAdminOperation) {
      const object = (v: unknown) =>
        !!v && typeof v === 'object' && !Array.isArray(v);
      const shapes = {
        register: { corpus: object },
        batch: { requestId: text(120), batch: object },
        begin: { requestId: text(120) },
        chunk: {
          requestId: text(120),
          packages: list(
            { lessonVersion: text(120), contentDigest: digest },
            50,
            1,
          ),
        },
        seal: { requestId: text(120), expectedPlanDigest: digest },
        publish: {
          requestId: text(120),
          snapshotId: text(120),
          ownerDecisionId: text(120),
          expectedRevision: integer,
          predecessorPublicationId: nullable(text(120)),
        },
        withdraw: {
          requestId: text(120),
          expectedRevision: integer,
          predecessorPublicationId: text(120),
        },
      };
      const body = copyEntryJson(op.body, 2 * 1024 * 1024) as Record<
        string,
        unknown
      >;
      if (
        !shapes[op.kind] ||
        !entryAccepts(body, shapes[op.kind]) ||
        (['chunk', 'seal'].includes(op.kind) && !text(120)(op.snapshotId))
      )
        throw new CorpusEntryError(400, 'INVALID_REQUEST');
      let ack: unknown;
      switch (op.kind) {
        case 'register':
          ack = decodeEntry(await call('/api/pilot/corpora', body), {
            corpusVersion: text(120),
            corpusDigest: digest,
          });
          break;
        case 'batch':
          return bindBatchIdentity(
            normalizeCorpusBatch(await call(root + '/batches', body)),
            body.batch,
          );
        case 'begin':
          ack = decodeEntry<CorpusSnapshotBeginReceipt>(
            await call(root + '/snapshots', body),
            {
              requestId: text(120),
              snapshotId: text(120),
              status: oneOf('building'),
              recordedAt: date,
              packageCount: integer,
              targetCount: integer,
            },
          );
          break;
        case 'chunk':
          ack = decodeEntry<CorpusSnapshotChunkReceipt>(
            await call(snapshotPath(op.snapshotId!) + '/chunks', body),
            {
              requestId: text(120),
              snapshotId: text(120),
              packageCount: integer,
              targetRowCount: integer,
              recordedAt: date,
            },
          );
          break;
        case 'seal':
          ack = decodeEntry<CorpusSnapshotSealReceipt>(
            await call(snapshotPath(op.snapshotId!) + '/seal', body),
            {
              requestId: text(120),
              snapshotId: text(120),
              status: oneOf('sealed'),
              prospectiveDigest: digest,
              packageCount: integer,
              includedCharacterCount: integer,
              excludedTargetCount: integer,
              recordedAt: date,
            },
          );
          break;
        case 'publish':
        case 'withdraw':
          ack = decodeEntry<CorpusPublicationReceipt>(
            await call(
              root +
                '/publications' +
                (op.kind === 'withdraw' ? '/withdraw' : ''),
              body,
            ),
            publicationReceipt,
          );
      }
      const a = ack as {
        requestId?: string;
        snapshotId?: string;
        corpusVersion?: string;
      };
      if (
        op.kind === 'register' &&
        a.corpusVersion !==
          (body.corpus as { corpusVersion?: unknown })?.corpusVersion
      )
        throw new CorpusEntryError(502, 'INVALID_ACK');
      if (
        (op.kind !== 'register' && a.requestId !== body.requestId) ||
        (op.snapshotId && a.snapshotId !== op.snapshotId) ||
        (op.kind === 'publish' && a.snapshotId !== body.snapshotId)
      )
        throw new CorpusEntryError(502, 'INVALID_ACK');
      return ack;
    },
    async read(op: CorpusAdminOperation, ack: unknown) {
      const originalBody = copyEntryJson(op.body) as {
        batch?: { batchId?: string };
      };
      const a = ack as {
        batchId?: string;
        snapshotId?: string;
        recordId?: string;
      };
      if (op.kind === 'register')
        return normalizeCorpusMetadata(
          await call('/api/pilot/corpora?limit=20'),
        );
      if (op.kind === 'batch') {
        const batchId = a?.batchId ?? originalBody.batch?.batchId;
        if (!batchId)
          return normalizeCorpusCoverage(
            await call(root + '/coverage?limit=20'),
            version,
          );
        return bindBatchIdentity(
          normalizeCorpusBatch(
            await call(root + '/batches/' + encodeURIComponent(batchId)),
          ),
          originalBody.batch,
        );
      }
      if (['begin', 'chunk', 'seal'].includes(op.kind)) {
        const id = a?.snapshotId ?? op.snapshotId;
        if (!id)
          return normalizeCorpusCoverage(
            await call(root + '/coverage?limit=20'),
            version,
          );
        return normalizeCorpusSnapshot(
          await call(snapshotPath(id)),
          version,
          id,
        );
      }
      return a?.recordId
        ? normalizeCorpusPublication(
            await call(
              root + '/publications/' + encodeURIComponent(a.recordId),
            ),
          )
        : normalizeCorpusPublicationHead(await call(root + '/publications'));
    },
  };
}
