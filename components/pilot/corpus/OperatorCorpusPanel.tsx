'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createCorpusAdminApi,
  createCorpusAdminMutation,
  createCorpusAdminValidation,
  type CorpusAdminValidationSnapshot,
  type CorpusAdminSnapshot,
  type CorpusAdminOperation,
} from '@/lib/pilot-corpus-admin-client';
import type {
  CorpusMetadataResponse,
  CorpusCoverageResponse,
  CorpusSnapshotResponse,
  CorpusSnapshotMembersResponse,
} from '@/lib/curriculum/corpus-types';
import type {
  CorpusSnapshotPackagesResponse,
  CorpusOwnerDecisionsResponse,
  CorpusSafeDecision,
  CorpusPublicationHeadResponse,
} from '@/lib/curriculum/corpus-entry-types';
import {
  createScopeGuard,
  registerPilotStoryController,
} from '@/lib/pilot-story-client';
import { useCorpusEntryPage, EntryPaging } from './CorpusEntryPager';
import styles from './corpus-admin.module.css';
const metadataKey = (i: CorpusMetadataResponse['items'][number]) =>
  i.corpusVersion;
const packageKey = (i: CorpusSnapshotPackagesResponse['items'][number]) =>
  i.lessonVersion;
const memberKey = (i: CorpusSnapshotMembersResponse['items'][number]) =>
  i.coverageIdentity + ':' + i.lessonVersion;
const decisionKey = (i: CorpusOwnerDecisionsResponse['items'][number]) =>
  i.receipt.recordId;
const empty: CorpusAdminSnapshot = {
  status: 'idle',
  pending: null,
  ack: null,
  readback: null,
  conflictReady: false,
  notice: '',
};
function Recovery({
  view,
  c,
}: {
  view: CorpusAdminSnapshot;
  c: { current: ReturnType<typeof createCorpusAdminMutation> | null };
}) {
  return (
    <div data-save-state={view.status}>
      <output aria-live="polite">
        {view.status === 'saving' ? 'Saving…' : view.notice}
      </output>
      {['pending', 'readback-pending'].includes(view.status) && (
        <button
          data-control="corpus-admin-retry"
          onClick={() => void c.current?.retry()}
        >
          {view.status === 'pending'
            ? 'Retry original request'
            : 'Retry saved-state check'}
        </button>
      )}
      {view.status === 'conflict' && (
        <>
          <button onClick={() => void c.current?.refreshConflict()}>
            Load current saved state
          </button>
          <button
            disabled={!view.conflictReady}
            onClick={() => c.current?.acceptConflict()}
          >
            Discard stale request
          </button>
        </>
      )}
    </div>
  );
}
function useAdminMutation(api: ReturnType<typeof createCorpusAdminApi>) {
  const [view, setView] = useState(empty),
    c = useRef<ReturnType<typeof createCorpusAdminMutation> | null>(null);
  useEffect(() => {
    let alive = true;
    const controller = createCorpusAdminMutation({
      verify: api.verify,
      send: (op) => api.send(op),
      read: (op, ack) => api.read(op, ack),
      onChange: (v) => {
        if (alive) setView(v);
      },
    });
    c.current = controller;
    const unregister = registerPilotStoryController(() => controller.lock());
    return () => {
      alive = false;
      unregister();
      controller.destroy();
      c.current = null;
    };
  }, [api]);
  return { view, c };
}
function MemberPage({
  api,
  id,
  status,
}: {
  api: ReturnType<typeof createCorpusAdminApi>;
  id: string;
  status: 'included' | 'excluded';
}) {
  const read = useCallback(
    (cursor: string | null) => api.members(id, status, cursor),
    [api, id, status],
  );
  const { view, controller } = useCorpusEntryPage<
    CorpusSnapshotMembersResponse['items'][number],
    CorpusSnapshotMembersResponse
  >(read, api.verify, memberKey);
  return (
    <section>
      <h4>{status === 'included' ? 'Included targets' : 'Excluded targets'}</h4>
      <EntryPaging
        view={view}
        controller={controller}
        prefix={`snapshot-${status}`}
      />
      {view.page?.items.map((i) => (
        <p key={memberKey(i)}>
          {i.coverageIdentity} ·{' '}
          {i.reasonCodes.join(', ') || 'Included in the saved plan'}
        </p>
      ))}
    </section>
  );
}
function SnapshotWork({
  api,
  snapshot,
  disabled,
  onWrite,
}: {
  api: ReturnType<typeof createCorpusAdminApi>;
  snapshot: CorpusSnapshotResponse;
  disabled: boolean;
  onWrite: (op: CorpusAdminOperation) => void;
}) {
  const read = useCallback(
    (cursor: string | null) => api.packages(snapshot.snapshotId, cursor),
    [api, snapshot.snapshotId],
  );
  const { view, controller } = useCorpusEntryPage<
    CorpusSnapshotPackagesResponse['items'][number],
    CorpusSnapshotPackagesResponse
  >(read, api.verify, packageKey);
  const [selected, setSelected] = useState<string[]>([]);
  const decisionRead = useCallback(
    (cursor: string | null) => api.decisions(snapshot.snapshotId, cursor),
    [api, snapshot.snapshotId],
  );
  const decisions = useCorpusEntryPage<
    CorpusSafeDecision,
    CorpusOwnerDecisionsResponse
  >(decisionRead, api.verify, decisionKey);
  const [head, setHead] = useState<CorpusPublicationHeadResponse | null>(null),
    [headNotice, setHeadNotice] = useState(''),
    [confirmation, setConfirmation] = useState(false),
    [withdrawConfirm, setWithdrawConfirm] = useState(false);
  const guard = useMemo(
    () => createScopeGuard(snapshot.snapshotId),
    [snapshot.snapshotId],
  );
  useEffect(() => {
    guard.activate();
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      setHead(null);
      setSelected([]);
      setConfirmation(false);
    });
    return () => {
      guard.destroy();
      unregister();
    };
  }, [guard]);
  const loadHead = async () => {
    const token = guard.begin();
    setHead(null);
    setConfirmation(false);
    setWithdrawConfirm(false);
    setHeadNotice('Loading current publication…');
    try {
      const h = await api.head();
      if (!guard.current(token)) return;
      setHead(h);
      setHeadNotice('Current publication loaded.');
    } catch {
      if (guard.current(token))
        setHeadNotice(
          'Current publication could not load. Retry loading before publishing.',
        );
    }
  };
  const checked = (view.page?.items ?? []).filter(
    (i) => selected.includes(i.lessonVersion) && !i.chunked,
  );
  const decision =
    decisions.view.status === 'ready' ? decisions.view.selected : null;
  const ordinary =
    snapshot.lane === 'ordinary' &&
    head?.publication?.scope.kind !== 'verification';
  return (
    <section
      className={styles.card}
      data-role="corpus-snapshot-work"
      data-snapshot-id={snapshot.snapshotId}
    >
      <h3>Prepared curriculum</h3>
      <p>
        {snapshot.status === 'sealed'
          ? 'Sealed preparation'
          : 'Preparation in progress'}
      </p>
      <p>
        Saved plan: {snapshot.counts.packageCount} packages ·{' '}
        {snapshot.counts.includedCharacterCount} included characters ·{' '}
        {snapshot.counts.excludedTargetCount} excluded targets.
      </p>
      <details>
        <summary>Exact preparation identity</summary>
        <p>{snapshot.snapshotId}</p>
        <p>Build {snapshot.buildId}</p>
        <p>Plan digest {snapshot.planDigest}</p>
      </details>
      <EntryPaging
        view={view}
        controller={controller}
        prefix="snapshot-packages"
      />
      {view.page?.items.map((i) => (
        <label key={i.lessonVersion}>
          <input
            type="checkbox"
            checked={selected.includes(i.lessonVersion)}
            disabled={disabled || snapshot.status === 'sealed' || i.chunked}
            onChange={(e) =>
              setSelected((s) =>
                e.target.checked
                  ? [...s, i.lessonVersion]
                  : s.filter((v) => v !== i.lessonVersion),
              )
            }
          />
          {i.title} · {i.targets.map((t) => t.hanzi).join(' ')} ·{' '}
          {i.chunked ? 'Already recorded' : 'Not recorded'}
        </label>
      ))}
      <button
        data-control="snapshot-chunk"
        disabled={
          disabled ||
          snapshot.status === 'sealed' ||
          checked.length === 0 ||
          checked.length > 50
        }
        onClick={() => {
          onWrite({
            kind: 'chunk',
            snapshotId: snapshot.snapshotId,
            body: {
              requestId: crypto.randomUUID(),
              packages: checked.map((i) => ({
                lessonVersion: i.lessonVersion,
                contentDigest: i.contentDigest,
              })),
            },
          });
          setSelected([]);
        }}
      >
        Record selected packages
      </button>
      <button
        data-control="snapshot-seal"
        disabled={disabled || snapshot.status === 'sealed'}
        onClick={() =>
          onWrite({
            kind: 'seal',
            snapshotId: snapshot.snapshotId,
            body: {
              requestId: crypto.randomUUID(),
              expectedPlanDigest: snapshot.planDigest,
            },
          })
        }
      >
        Seal complete preparation
      </button>
      <MemberPage api={api} id={snapshot.snapshotId} status="included" />
      <MemberPage api={api} id={snapshot.snapshotId} status="excluded" />
      <h3>Owner decision and publication</h3>
      <p>
        An operator can inspect attributed decisions. Only a configured owner
        can review the material and record a decision.
      </p>
      <EntryPaging
        view={decisions.view}
        controller={decisions.controller}
        prefix="snapshot-decisions"
      />
      <label>
        Recorded decision
        <select
          data-control="publication-decision"
          value={decision?.receipt.recordId ?? ''}
          onChange={(e) => {
            decisions.controller.current?.select(e.target.value);
            setConfirmation(false);
          }}
        >
          <option value="" disabled>
            Choose an accepted decision
          </option>
          {decisions.view.page?.items.map((d) => (
            <option
              key={d.receipt.recordId}
              value={d.receipt.recordId}
              disabled={d.decision !== 'accepted'}
            >
              {d.decision} ·{' '}
              {d.scope.kind === 'starter'
                ? 'Starter curriculum'
                : `Trial for ${d.scope.members.length} linked children`}{' '}
              · {new Date(d.receipt.recordedAt).toLocaleDateString()}
            </option>
          ))}
        </select>
      </label>
      <button
        data-control="publication-load-head"
        disabled={disabled}
        onClick={() => void loadHead()}
      >
        Load current publication
      </button>
      <output aria-live="polite">{headNotice}</output>
      {head && (
        <p>
          {head.publication
            ? `${head.publication.status} · Revision ${head.publication.receipt.revision}`
            : 'No publication has been recorded.'}
        </p>
      )}
      {head &&
        ordinary &&
        snapshot.status === 'sealed' &&
        decision?.decision === 'accepted' && (
          <>
            <label>
              <input
                data-control="publication-confirm"
                type="checkbox"
                checked={confirmation}
                disabled={disabled}
                onChange={(e) => setConfirmation(e.target.checked)}
              />
              Publish this sealed preparation for the exact{' '}
              {decision.scope.kind === 'starter'
                ? 'starter scope'
                : `trial scope of ${decision.scope.members.length} linked children`}{' '}
              recorded in the selected owner decision.
            </label>
            <details>
              <summary>Confirm exact scope and evidence</summary>
              <p>
                {snapshot.snapshotId} · {snapshot.buildId}
              </p>
              <p>{snapshot.corpusDigest}</p>
              <p>Owner decision {decision.receipt.recordId}</p>
              {decision.scope.kind === 'supervised-trial' &&
                decision.scope.members.map((m) => (
                  <p key={m.childId}>
                    Parent {m.parentId} · Child {m.childId}
                  </p>
                ))}
            </details>
            <button
              data-control="corpus-publish"
              disabled={disabled || !confirmation}
              onClick={() => {
                setConfirmation(false);
                onWrite({
                  kind: 'publish',
                  body: {
                    requestId: crypto.randomUUID(),
                    snapshotId: snapshot.snapshotId,
                    ownerDecisionId: decision.receipt.recordId,
                    expectedRevision: head.publication?.receipt.revision ?? 0,
                    predecessorPublicationId:
                      head.publication?.receipt.recordId ?? null,
                  },
                });
              }}
            >
              Publish confirmed scope
            </button>
          </>
        )}
      {head?.publication &&
        ordinary &&
        head.publication.status === 'released' && (
          <>
            <label>
              <input
                type="checkbox"
                data-control="corpus-withdraw-confirm"
                checked={withdrawConfirm}
                disabled={disabled}
                onChange={(e) => setWithdrawConfirm(e.target.checked)}
              />
              Withdraw the current exact publication for its recorded scope.
            </label>
            <button
              data-control="corpus-withdraw"
              disabled={disabled || !withdrawConfirm}
              onClick={() =>
                onWrite({
                  kind: 'withdraw',
                  body: {
                    requestId: crypto.randomUUID(),
                    expectedRevision: head.publication!.receipt.revision,
                    predecessorPublicationId:
                      head.publication!.receipt.recordId,
                  },
                })
              }
            >
              Withdraw confirmed publication
            </button>
          </>
        )}
      {head?.publication?.scope.kind === 'verification' && (
        <p>
          This is a verification fixture publication. Ordinary publishing
          controls are unavailable.
        </p>
      )}
    </section>
  );
}
function AdminSession({
  me,
  version,
  onBusyChange,
  registered = true,
}: {
  me: PilotMe;
  version: string;
  onBusyChange: (busy: boolean) => void;
  registered?: boolean;
}) {
  const api = useMemo(() => createCorpusAdminApi(me, version), [me, version]),
    { view, c } = useAdminMutation(api);
  const [validationView, setValidationView] =
    useState<CorpusAdminValidationSnapshot>({
      status: 'idle',
      input: '',
      report: null,
      notice: '',
    });
  const validationController = useRef<ReturnType<
    typeof createCorpusAdminValidation
  > | null>(null);
  const [notice, setNotice] = useState(''),
    [snapshot, setSnapshot] = useState<CorpusSnapshotResponse | null>(null);
  const batchText = validationView.input,
    validation = validationView.report,
    validating = validationView.status === 'checking';
  const guard = useMemo(
    () =>
      createScopeGuard(
        JSON.stringify([me.installationId, me.user.id, version]),
      ),
    [me.installationId, me.user.id, version],
  );
  useEffect(() => {
    guard.activate();
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      setSnapshot(null);
      setNotice('');
    });
    return () => {
      guard.destroy();
      unregister();
    };
  }, [guard]);
  const coverageRead = useCallback(
    (cursor: string | null) =>
      registered
        ? api.coverage(cursor)
        : Promise.reject(new Error('Not registered')),
    [api, registered],
  );
  const coverage = useCorpusEntryPage<
    CorpusCoverageResponse['items'][number],
    CorpusCoverageResponse
  >(coverageRead, api.verify, memberKey);
  useEffect(() => {
    let alive = true;
    const controller = createCorpusAdminValidation({
      verify: api.verify,
      validate: (batch) => api.validate(batch),
      onChange: (s) => {
        if (alive) setValidationView(s);
      },
      onLock: () => {
        guard.destroy();
        c.current?.lock();
        coverage.controller.current?.lock();
        setSnapshot(null);
        setNotice('');
      },
    });
    validationController.current = controller;
    const unregister = registerPilotStoryController(() => controller.lock());
    return () => {
      alive = false;
      unregister();
      controller.destroy();
      validationController.current = null;
    };
  }, [api, c, guard, coverage.controller]);
  const disabled =
    !!view.pending ||
    view.status === 'saving' ||
    view.status === 'locked' ||
    validating;
  const effectiveSnapshot =
    view.status === 'saved' &&
    view.readback &&
    typeof view.readback === 'object' &&
    'schemaVersion' in view.readback &&
    (view.readback as { schemaVersion: string }).schemaVersion ===
      'r6-snapshot-1'
      ? (view.readback as CorpusSnapshotResponse)
      : snapshot;
  useEffect(() => {
    onBusyChange(!!view.pending || view.status === 'saving');
    return () => onBusyChange(false);
  }, [view.pending, view.status, onBusyChange]);
  const write = (op: CorpusAdminOperation) => void c.current?.perform(op);
  const report = coverage.view.page;
  return (
    <div
      data-role="corpus-admin-session"
      data-save-state={view.status}
      data-corpus-version={version}
    >
      <h3>{registered ? 'Current coverage' : 'Prepare before registration'}</h3>
      {!registered && (
        <p>
          This explicit version is being prepared. Register its manifest after
          saving the required batches. Current coverage and publication are
          unavailable until registration.
        </p>
      )}
      <button
        disabled={disabled || !registered}
        onClick={() => void coverage.controller.current?.first()}
      >
        Refresh current coverage
      </button>
      {registered && (
        <EntryPaging
          view={coverage.view}
          controller={coverage.controller}
          prefix="corpus-coverage"
        />
      )}
      {report && (
        <>
          <p>
            {report.lane === 'verification'
              ? 'Verification diagnostics · synthetic fixtures are not real readiness.'
              : 'Current curriculum evidence'}
          </p>
          <dl className={styles.counts}>
            {Object.entries(report.counts).map(([key, value]) => (
              <div key={key}>
                <dt>
                  {{
                    fixture: 'Fixture characters',
                    machineValidDraft: 'Machine-valid draft',
                    reviewedReady: 'Reviewed and ready',
                    supervisedTrial: 'Supervised trial',
                    prospectiveStarter: 'Prospective starter',
                    committedStarter: 'Committed starter',
                  }[key] ?? key}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p>
            Fixture characters: {report.fixtureCharacterCount} · Verification
            packages: {report.verificationPackageCount}. Starter readiness still
            requires 1,600 real reviewed characters.
          </p>
          {report.items.map((i) => (
            <p key={memberKey(i)}>
              {i.coverageIdentity} ·{' '}
              {i.reasonCodes.join(', ') || i.classification}
            </p>
          ))}
          {report.snapshot && (
            <button
              disabled={disabled}
              onClick={() => {
                const token = guard.begin();
                void api
                  .snapshot(report.snapshot!.snapshotId)
                  .then((s) => {
                    if (guard.current(token)) setSnapshot(s);
                  })
                  .catch(() => {
                    if (guard.current(token))
                      setNotice(
                        'The saved preparation could not load. Retry loading.',
                      );
                  });
              }}
            >
              Load saved sealed preparation
            </button>
          )}
        </>
      )}
      <Recovery view={view} c={c} />
      {view.status === 'saved' &&
        !!view.readback &&
        typeof view.readback === 'object' &&
        'schemaVersion' in view.readback &&
        (view.readback as { schemaVersion: string }).schemaVersion ===
          'r6-batch-1' && (
          <p>
            Batch saved at{' '}
            {(view.readback as unknown as { recordedAt: string }).recordedAt}.
            This receipt does not publish curriculum.
          </p>
        )}
      <output aria-live="polite">{notice || validationView.notice}</output>
      {view.status !== 'locked' && (
        <>
          <section className={styles.card}>
            <h3>Prepare a bounded batch</h3>
            <p>
              Use an explicit batch of at most 50 already imported packages.
              Validation does not save a batch or import unseen content.
            </p>
            <label>
              Batch JSON
              <textarea
                data-control="corpus-batch-input"
                value={batchText}
                disabled={disabled}
                onChange={(e) =>
                  validationController.current?.setInput(e.target.value)
                }
              />
            </label>
            <button
              data-control="corpus-batch-validate"
              disabled={disabled || !batchText.trim()}
              onClick={() => void validationController.current?.check()}
            >
              {validating ? 'Checking…' : 'Validate batch'}
            </button>
            {validation && (
              <>
                <p>
                  Checked {new Date(validation.checkedAt).toLocaleString()} ·
                  not saved.
                </p>
                {validation.items.map((i) => (
                  <p key={i.lessonVersion}>
                    {i.lessonVersion} · {i.state}
                    {i.errors.map((e) => ` · ${e.fieldId}: ${e.code}`).join('')}
                  </p>
                ))}
                <button
                  data-control="corpus-batch-save"
                  disabled={
                    disabled ||
                    validation.items.some((i) => i.state !== 'accepted')
                  }
                  onClick={() =>
                    write({
                      kind: 'batch',
                      body: {
                        requestId: crypto.randomUUID(),
                        batch: JSON.parse(batchText),
                      },
                    })
                  }
                >
                  Save validated batch
                </button>
              </>
            )}
          </section>
          <button
            data-control="snapshot-begin"
            disabled={disabled || !registered}
            onClick={() =>
              write({ kind: 'begin', body: { requestId: crypto.randomUUID() } })
            }
          >
            Begin a new preparation
          </button>
          {effectiveSnapshot && (
            <SnapshotWork
              key={JSON.stringify([
                effectiveSnapshot.snapshotId,
                effectiveSnapshot.status,
                view.ack,
              ])}
              api={api}
              snapshot={effectiveSnapshot}
              disabled={disabled}
              onWrite={write}
            />
          )}
        </>
      )}
    </div>
  );
}
export default function OperatorCorpusPanel({ me }: { me: PilotMe }) {
  const api = useMemo(() => createCorpusAdminApi(me, ''), [me]);
  const read = useCallback(
    (cursor: string | null) => api.metadata(cursor),
    [api],
  );
  const { view, controller } = useCorpusEntryPage<
    CorpusMetadataResponse['items'][number],
    CorpusMetadataResponse
  >(read, api.verify, metadataKey, true);
  const mutation = useAdminMutation(api),
    [raw, setRaw] = useState(''),
    [notice, setNotice] = useState(''),
    [contextBusy, setContextBusy] = useState(false),
    [futureVersion, setFutureVersion] = useState(''),
    [preparedVersion, setPreparedVersion] = useState<string | null>(null);
  useEffect(() => {
    const unregister = registerPilotStoryController(() => {
      setRaw('');
      setNotice('');
      setFutureVersion('');
      setPreparedVersion(null);
    });
    return unregister;
  }, []);
  if (me.user.role !== 'operator') return null;
  return (
    <section className={styles.admin} data-role="operator-corpus-panel">
      <h2>Corpus preparation and publication</h2>
      <p>
        Prepare exact imported content, inspect evidence, and publish only a
        scope accepted by a configured owner. Fixture diagnostics never count as
        real reviewed readiness.
      </p>
      <EntryPaging
        view={view}
        controller={controller}
        prefix="corpus-metadata"
        disabled={contextBusy || !!mutation.view.pending}
      />
      {view.page?.items.length !== 0 && (
        <label>
          Corpus
          <select
            data-control="operator-corpus-select"
            disabled={contextBusy || !!mutation.view.pending}
            value={view.selected?.corpusVersion ?? ''}
            onChange={(e) => {
              setPreparedVersion(null);
              controller.current?.select(e.target.value);
            }}
          >
            <option value="" disabled>
              Choose an imported corpus
            </option>
            {view.page?.items.map((i) => (
              <option key={i.corpusVersion} value={i.corpusVersion}>
                {i.corpusId} · {i.packageCount} packages
              </option>
            ))}
          </select>
        </label>
      )}
      <details>
        <summary>Prepare a new corpus version</summary>
        <p>
          Save a bounded batch for an explicit future version before registering
          its complete manifest. This choice grants no learning authority.
        </p>
        <label>
          Future corpus version
          <input
            data-control="corpus-prepare-version"
            value={futureVersion}
            maxLength={240}
            disabled={contextBusy || !!mutation.view.pending}
            onChange={(e) => setFutureVersion(e.target.value)}
          />
        </label>
        <button
          data-control="corpus-prepare-new"
          disabled={
            contextBusy ||
            !!mutation.view.pending ||
            !futureVersion.trim() ||
            Array.from(futureVersion.trim()).length > 120
          }
          onClick={() => setPreparedVersion(futureVersion.trim())}
        >
          Prepare this version
        </button>
      </details>
      <details>
        <summary>Register an explicit corpus manifest</summary>
        <label>
          Corpus manifest JSON
          <textarea
            value={raw}
            disabled={
              !!mutation.view.pending || mutation.view.status === 'locked'
            }
            onChange={(e) => setRaw(e.target.value)}
          />
        </label>
        <button
          disabled={
            !raw.trim() ||
            !!mutation.view.pending ||
            mutation.view.status === 'locked'
          }
          onClick={() => {
            try {
              const corpus: unknown = JSON.parse(raw);
              void mutation.c.current?.perform({
                kind: 'register',
                body: { corpus },
              });
            } catch {
              setNotice('Check the manifest JSON before registering.');
            }
          }}
        >
          Register manifest
        </button>
        <output>{notice}</output>
        <Recovery view={mutation.view} c={mutation.c} />
        <button onClick={() => void controller.current?.first()}>
          Refresh imported corpora
        </button>
      </details>
      {(preparedVersion || view.selected) &&
        view.status !== 'locked' &&
        view.status !== 'stale' && (
          <AdminSession
            key={preparedVersion ?? view.selected!.corpusVersion}
            me={me}
            version={preparedVersion ?? view.selected!.corpusVersion}
            registered={!preparedVersion}
            onBusyChange={setContextBusy}
          />
        )}
    </section>
  );
}
