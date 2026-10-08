'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import type {
  OpsDetail,
  OpsObservation,
  OpsDetailResponse,
  OpsHistory,
  OpsTriageInput,
  OpsSeverity,
  OpsRecordStatus,
} from '@/lib/pilot-ops-types';
import { newOpsRequestId, createOpsReadGuard } from '@/lib/pilot-ops-client';
import {
  useOpsApi,
  useOpsRead,
  useOpsWrite,
  WriteStatus,
  opsDate,
  styles,
} from './shared';
import ObservationForm from './ObservationForm';
function ObservationNotes({ value }: { value: OpsObservation }) {
  return (
    <details>
      <summary>Observation notes</summary>
      <p>
        {value.kind} · Participant {value.participantLabel} ·{' '}
        {opsDate(value.observedAt)}
      </p>
      <p>
        Device: {value.device} · Browser: {value.browser}
      </p>
      <p>Agreement reference: {value.parentAgreementRef} (attributed)</p>
      <p>Tasks: {value.tasks.join('; ')}</p>
      <p>
        Completion observed: {value.completion}. Saving:{' '}
        {value.savedRecapRef
          ? 'Reference attributed and unverified: ' + value.savedRecapRef
          : 'Unconfirmed'}
        .
      </p>
      <p>Adult help: {value.adultHelp || 'None recorded'}</p>
      <p>Interruptions: {value.interruptions || 'None recorded'}</p>
      <p>Observed behavior: {value.observedBehavior || 'No notes'}</p>
      <p>
        Observer interpretation: {value.observerInterpretation || 'No notes'}
      </p>
      <p>Later recall: {value.laterRecall.status}</p>
      {value.laterRecall.status === 'observed' && (
        <>
          <p>
            {opsDate(value.laterRecall.observedAt)} · Evidence{' '}
            {value.laterRecall.evidenceRef} (attributed)
          </p>
          <p>Adult help: {value.laterRecall.adultHelp || 'None recorded'}</p>
          <p>Observation: {value.laterRecall.observation || 'No notes'}</p>
        </>
      )}
    </details>
  );
}
export function HistoryEntry({ entry }: { entry: OpsHistory }) {
  return (
    <div className={styles.history} data-history-sequence={entry.sequence}>
      <p>
        {entry.kind} · {opsDate(entry.recordedAt)} · {entry.public.status} ·{' '}
        {entry.public.severity}
      </p>
      {entry.detailsRemoved ? (
        <p>Details removed</p>
      ) : (
        entry.private && (
          <>
            <p>Owner: {entry.private.ownerRef ?? 'Unassigned'}</p>
            {entry.private.disposition && (
              <p>Disposition: {entry.private.disposition}</p>
            )}
            {entry.private.retestRef && (
              <p>Retest: {entry.private.retestRef}</p>
            )}
            {entry.private.correctionReason && (
              <p>Correction: {entry.private.correctionReason}</p>
            )}
            {entry.private.observation && (
              <ObservationNotes value={entry.private.observation} />
            )}
          </>
        )
      )}
    </div>
  );
}
function Triage({
  me,
  record,
  onSaved,
  onExpired,
}: {
  me: PilotMe;
  record: OpsDetail;
  onSaved: (result: OpsDetailResponse) => void;
  onExpired: () => void;
}) {
  const api = useOpsApi(me);
  const [severity, setSeverity] = useState<OpsSeverity>(record.severity),
    [status, setStatus] = useState<Exclude<OpsRecordStatus, 'expired'>>(
      record.status === 'expired' ? 'open' : record.status,
    ),
    [owner, setOwner] = useState(record.ownerRef ?? ''),
    [ac, setAc] = useState(''),
    [disposition, setDisposition] = useState(''),
    [retest, setRetest] = useState(''),
    [due, setDue] = useState('');
  const send = useCallback(
    async (body: OpsTriageInput) => {
      try {
        return await api.triage(record.id, body);
      } catch (e) {
        if (
          e &&
          typeof e === 'object' &&
          'code' in e &&
          e.code === 'OPS_DETAILS_EXPIRED'
        )
          onExpired();
        throw e;
      }
    },
    [api, record.id, onExpired],
  );
  const read = useCallback(async () => {
    const result = await api.detail(record.id);
    onSaved(result);
    return result;
  }, [api, record.id, onSaved]);
  const write = useOpsWrite(send, read);
  const editing = write.snapshot.state === 'idle';
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void write.controller.submit({
          requestId: newOpsRequestId(),
          expectedRevision: record.revision,
          severity,
          status,
          ownerRef: owner.trim() || null,
          acIds: ac.split(/[\s,]+/).filter(Boolean),
          disposition,
          retestRef: retest.trim() || null,
          nextReviewAt: due ? new Date(due).getTime() : null,
        });
      }}
    >
      <h3>Triage this record</h3>
      <div className={styles.fields}>
        <label>
          Severity
          <select
            data-control="triage-severity"
            disabled={!editing}
            value={severity}
            onChange={(e) => setSeverity(e.target.value as OpsSeverity)}
          >
            {['blocking', 'high', 'normal', 'low'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            data-control="triage-status"
            disabled={!editing}
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as Exclude<OpsRecordStatus, 'expired'>)
            }
          >
            {['open', 'in-progress', 'awaiting-review', 'resolved'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Owner reference <span className={styles.muted}>Optional</span>
          <input
            data-control="triage-owner"
            maxLength={240}
            disabled={!editing}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </label>
        <label>
          Next review{' '}
          <span className={styles.muted}>Optional local date and time</span>
          <input
            data-control="triage-due"
            type="datetime-local"
            disabled={!editing}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
      </div>
      <label>
        Acceptance references{' '}
        <span className={styles.muted}>
          Up to 8 known AC or EARS IDs, separated by spaces.
        </span>
        <input
          data-control="triage-ac"
          disabled={!editing}
          value={ac}
          onChange={(e) => setAc(e.target.value)}
        />
      </label>
      <label>
        Disposition
        <textarea
          data-control="triage-disposition"
          maxLength={2000}
          required={status === 'resolved'}
          disabled={!editing}
          value={disposition}
          onChange={(e) => setDisposition(e.target.value)}
        />
      </label>
      <label>
        Retest reference
        <input
          data-control="triage-retest"
          required={status === 'resolved'}
          maxLength={480}
          disabled={!editing}
          value={retest}
          onChange={(e) => setRetest(e.target.value)}
        />
      </label>
      <button
        data-control="triage-save"
        className={styles.primary}
        disabled={!editing}
      >
        Save triage
      </button>
      <WriteStatus write={write} />
      {write.snapshot.state === 'saved' && (
        <button
          type="button"
          data-control="triage-new"
          onClick={() => write.controller.reset()}
        >
          Review another change
        </button>
      )}
    </form>
  );
}
export default function FeedbackDetail({
  me,
  recordId,
  onSaved,
}: {
  me: PilotMe;
  recordId: string;
  onSaved: () => void;
}) {
  const api = useOpsApi(me);
  const load = useCallback(() => api.detail(recordId), [api, recordId]);
  const resource = useOpsRead(load);
  const [older, setOlder] = useState<OpsHistory[]>([]),
    [olderCursor, setOlderCursor] = useState<string | null | undefined>(
      undefined,
    ),
    [historyError, setHistoryError] = useState(''),
    [paging, setPaging] = useState(false);
  const record = resource.value?.record;
  const historyGuard = useMemo(() => createOpsReadGuard(), []);
  useEffect(() => {
    historyGuard.activate();
    return () => historyGuard.lock();
  }, [historyGuard]);
  async function history() {
    const cursor = olderCursor === undefined ? record?.nextCursor : olderCursor;
    if (!cursor) return;
    const token = historyGuard.begin();
    setPaging(true);
    setHistoryError('');
    try {
      const result = await api.history(recordId, { cursor });
      if (!historyGuard.current(token)) return;
      if (result.recordRevision !== record?.historyRevision)
        throw new Error('The history changed. Refresh this record.');
      setOlder((previous) => [...result.items, ...previous]);
      setOlderCursor(result.nextCursor);
    } catch (e) {
      if (!historyGuard.current(token)) return;
      setHistoryError(
        e instanceof Error ? e.message : 'History could not load.',
      );
    } finally {
      if (historyGuard.current(token)) setPaging(false);
    }
  }
  const removeRecord = resource.clear;
  const expired = useCallback(() => {
    historyGuard.lock();
    setOlder([]);
    setOlderCursor(undefined);
    setPaging(false);
    removeRecord(
      'Details removed. Refresh this record to load its retained history.',
    );
  }, [historyGuard, removeRecord]);
  const acceptRecord = resource.accept;
  const refresh = useCallback(
    (result: OpsDetailResponse) => {
      historyGuard.activate();
      setPaging(false);
      setOlder([]);
      setOlderCursor(undefined);
      acceptRecord(result);
      onSaved();
    },
    [historyGuard, acceptRecord, onSaved],
  );
  return (
    <section
      className={styles.card}
      data-role="ops-feedback-detail"
      data-record-revision={record?.revision}
      data-feedback-id={recordId}
    >
      <h2>Record details</h2>
      <button
        data-control="feedback-detail-refresh"
        type="button"
        disabled={resource.loading}
        onClick={() => {
          historyGuard.activate();
          setPaging(false);
          setOlder([]);
          setOlderCursor(undefined);
          void resource.refresh();
        }}
      >
        Refresh record
      </button>
      {resource.error && (
        <p role="alert" className={styles.error}>
          {resource.error}
        </p>
      )}
      {resource.loading ? (
        <p>Loading saved details…</p>
      ) : (
        record && (
          <>
            <p>
              {record.kind} · {record.status} · {record.severity} · revision{' '}
              {record.revision}
            </p>
            <p>
              Owner: {record.ownerRef ?? 'Unassigned'} · Next review:{' '}
              {opsDate(record.nextReviewAt)}
            </p>
            <p className={styles.code}>
              {record.lessonVersion} · {record.contentDigest} · Source build{' '}
              {record.buildId} · Submission {record.submissionBuildId}
            </p>
            {record.historical && (
              <p className={styles.notice}>
                Historical information. Changes are unavailable here.
              </p>
            )}
            {record.detailsRemoved ? (
              <p className={styles.notice}>
                Details removed. Expiry does not resolve the reported problem.
              </p>
            ) : record.details && 'observed' in record.details ? (
              <>
                <h3>What happened</h3>
                <p>{record.details.observed}</p>
                <h3>What was expected</h3>
                <p>{record.details.expected || 'Not supplied'}</p>
              </>
            ) : record.details && 'observation' in record.details ? (
              <>
                <p>
                  {record.details.observation.kind} observation ·{' '}
                  {record.details.observation.completion}
                </p>
                <p>
                  Observed:{' '}
                  {record.details.observation.observedBehavior || 'No notes'}
                </p>
                <p>
                  Interpretation:{' '}
                  {record.details.observation.observerInterpretation ||
                    'No notes'}
                </p>
                <p>
                  Adult help:{' '}
                  {record.details.observation.adultHelp || 'None recorded'}
                </p>
                <p>
                  Interruptions:{' '}
                  {record.details.observation.interruptions || 'None recorded'}
                </p>
                <ObservationNotes value={record.details.observation} />
                <p>
                  Saving:{' '}
                  {record.details.observation.savedRecapRef
                    ? 'Reference attributed; unverified'
                    : 'Unconfirmed'}
                  . Later recall:{' '}
                  {record.details.observation.laterRecall.status}.
                </p>
              </>
            ) : null}
            <h3>Saved history</h3>
            {[...older, ...record.history].map((entry) => (
              <HistoryEntry entry={entry} key={entry.id} />
            ))}
            {(olderCursor === undefined ? record.nextCursor : olderCursor) && (
              <button
                data-control="history-older"
                type="button"
                disabled={paging}
                onClick={() => void history()}
              >
                Load older history
              </button>
            )}
            {historyError && (
              <p className={styles.error} role="alert">
                {historyError} Refresh the record to restart history paging.
              </p>
            )}
            {!record.readOnly && !record.detailsRemoved && (
              <>
                <Triage
                  key={record.id}
                  me={me}
                  record={record}
                  onSaved={refresh}
                  onExpired={expired}
                />
                {record.kind === 'observation' && (
                  <ObservationForm
                    key={'correction:' + record.id}
                    me={me}
                    record={record}
                    onSaved={refresh}
                    onExpired={expired}
                  />
                )}
              </>
            )}
          </>
        )
      )}
    </section>
  );
}
