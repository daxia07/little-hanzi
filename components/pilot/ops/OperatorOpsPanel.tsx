'use client';
import { useCallback, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import type {
  OpsAlert,
  OpsAckInput,
  OpsStatusResponse,
  OpsQueueOptions,
} from '@/lib/pilot-ops-types';
import { newOpsRequestId } from '@/lib/pilot-ops-client';
import {
  useOpsApi,
  useOpsRead,
  useOpsWrite,
  WriteStatus,
  opsDate,
  styles,
} from './shared';
import FeedbackDetail from './FeedbackDetail';
import ObservationForm from './ObservationForm';
const alertWords: Record<string, string> = {
  OPS_BACKUP_FAILED: 'Backup failed',
  OPS_PROBE_FAILED: 'Save probe failed',
  OPS_BACKUP_STALE: 'Backup is overdue',
  OPS_MONITOR_UNKNOWN: 'Monitoring status is unknown',
  OPS_NOTIFICATION_FAILED: 'Notification delivery failed',
  OPS_RETENTION_FAILED: 'Retention failed',
};
function AlertItem({
  me,
  alert,
  onSaved,
  onReadFailure,
}: {
  me: PilotMe;
  alert: OpsAlert;
  onSaved: (value: OpsStatusResponse) => void;
  onReadFailure: (message: string) => void;
}) {
  const api = useOpsApi(me);
  const send = useCallback(
    (body: OpsAckInput) => api.ack(alert.id, body),
    [api, alert.id],
  );
  const read = useCallback(async () => {
    try {
      const result = await api.status();
      onSaved(result);
      return result;
    } catch (e) {
      onReadFailure(
        e instanceof Error
          ? e.message
          : 'Operations are unavailable. Monitoring status is unknown.',
      );
      throw e;
    }
  }, [api, onSaved, onReadFailure]);
  const write = useOpsWrite(send, read);
  return (
    <article className={styles.card} data-alert-id={alert.id}>
      <h3>{alertWords[alert.code]}</h3>
      <p>
        {alert.status} · {opsDate(alert.updatedAt)}
      </p>
      <p>
        Notification: {alert.notification}. Acknowledgement does not resolve
        this condition.
      </p>
      {alert.historical ? (
        <p>Historical alert; acknowledgement unavailable here.</p>
      ) : (
        <button
          data-control="ops-alert-ack"
          type="button"
          disabled={alert.status !== 'open' || write.snapshot.state !== 'idle'}
          onClick={() =>
            void write.controller.submit({
              requestId: newOpsRequestId(),
              expectedRevision: alert.revision,
            })
          }
        >
          Acknowledge alert
        </button>
      )}
      <WriteStatus write={write} />
    </article>
  );
}
function JobDetails({ me, id }: { me: PilotMe; id: string }) {
  const api = useOpsApi(me),
    load = useCallback(() => api.job(id), [api, id]);
  const resource = useOpsRead(load);
  return (
    <section className={styles.card} data-role="ops-job-detail">
      <h3>Job details</h3>
      {resource.error && (
        <p className={styles.error} role="alert">
          {resource.error}
        </p>
      )}
      <button
        data-control="ops-job-refresh"
        type="button"
        disabled={resource.loading}
        onClick={() => void resource.refresh()}
      >
        Refresh job
      </button>
      {resource.loading ? (
        <p>Loading job…</p>
      ) : (
        resource.value && (
          <>
            <p>
              {resource.value.job.kind} · {resource.value.job.status}
            </p>
            <p>
              Started {opsDate(resource.value.job.startedAt)} · Ended{' '}
              {opsDate(resource.value.job.endedAt)}
            </p>
            <p className={styles.code}>
              Operation {resource.value.job.acknowledgedOperationId} · Build{' '}
              {resource.value.job.buildId}
            </p>
            {resource.value.job.errorCode && (
              <p>Code: {resource.value.job.errorCode}</p>
            )}
            {resource.value.job.historical && (
              <p>Historical job. Its lease will not resume.</p>
            )}
            {resource.value.job.archives.map((archive) => (
              <div key={archive.id} className={styles.history}>
                <p>
                  {archive.kind} archive · {archive.byteSize} bytes · verified{' '}
                  {opsDate(archive.verifiedAt)}
                </p>
                <p className={styles.code}>
                  {archive.plaintextDigest} · {archive.ciphertextDigest} · Key
                  reference {archive.keyId}
                </p>
              </div>
            ))}
          </>
        )
      )}
    </section>
  );
}
function Operations({ me, active }: { me: PilotMe; active: boolean }) {
  const api = useOpsApi(me),
    load = useCallback(() => api.status(), [api]);
  const resource = useOpsRead(load, active);
  const [jobId, setJob] = useState('');
  const status = resource.value?.status;
  return (
    <section
      className={styles.panel}
      hidden={!active}
      data-role="ops-monitor"
      data-ops-view-state={
        resource.loading
          ? 'loading'
          : resource.error
            ? 'error'
            : resource.value
              ? 'ready'
              : 'loading'
      }
    >
      <div className={styles.card}>
        <h2>Operations</h2>
        <p>
          Current backup and monitoring information. Learning can continue if
          this desk is unavailable.
        </p>
        <button
          data-control="ops-refresh"
          type="button"
          disabled={resource.loading}
          onClick={() => void resource.refresh()}
        >
          Refresh operations
        </button>
        {resource.error && (
          <p className={styles.error} role="alert">
            {resource.error}
          </p>
        )}
        {resource.loading ? (
          <p>Loading operations…</p>
        ) : (
          <>
            <h3>
              Monitoring:{' '}
              {resource.error ? 'unknown' : (status?.monitorState ?? 'unknown')}
            </h3>
            {status && (
              <>
                <p>Last monitor: {opsDate(status.lastMonitorAt)}</p>
                <p>
                  Last verified backup: {opsDate(status.lastVerifiedBackupAt)}
                </p>
                <p>Backup data time: {opsDate(status.lastBackupDataAt)}</p>
                <p>
                  Data age:{' '}
                  {status.backupAgeMs === null
                    ? 'Not known'
                    : (status.backupAgeMs / 3600000).toFixed(1) + ' hours'}
                  . The freshness limit is 26 hours.
                </p>
                <p>Daily slot: 02:00 UTC · Keep 7 daily and 4 weekly points.</p>
                <p>
                  Notification: {status.notification}. A recorded alert is not
                  proof of delivery.
                </p>
              </>
            )}
          </>
        )}
      </div>
      <h2>Alerts</h2>
      {status?.alerts.length ? (
        status.alerts.map((alert) => (
          <AlertItem
            key={alert.id}
            me={me}
            alert={alert}
            onSaved={resource.accept}
            onReadFailure={resource.fail}
          />
        ))
      ) : (
        <p>
          {status
            ? 'No current alerts are listed.'
            : 'Alert information is unavailable.'}
        </p>
      )}
      <h2>Recent jobs</h2>
      {status?.jobs.map((job) => (
        <article className={styles.card} key={job.id} data-job-id={job.id}>
          <h3>
            {job.kind} · {job.status}
          </h3>
          <p>
            {opsDate(job.startedAt)}
            {job.historical ? ' · Historical' : ''}
          </p>
          <button
            data-control="ops-job-open"
            type="button"
            onClick={() => setJob(job.id)}
          >
            View job details
          </button>
        </article>
      ))}
      {jobId && <JobDetails key={jobId} me={me} id={jobId} />}
    </section>
  );
}
function FeedbackQueue({ me, active }: { me: PilotMe; active: boolean }) {
  const api = useOpsApi(me);
  const [filter, setFilter] = useState<OpsQueueOptions['status']>('active'),
    [kind, setKind] = useState<OpsQueueOptions['kind']>('all'),
    [cursor, setCursor] = useState<string | undefined>(),
    [previous, setPrevious] = useState<(string | undefined)[]>([]),
    [selected, setSelected] = useState('');
  const load = useCallback(
    () => api.queue({ status: filter, kind, ...(cursor ? { cursor } : {}) }),
    [api, filter, kind, cursor],
  );
  const resource = useOpsRead(load, active);
  const reloadQueue = resource.refresh;
  const refresh = useCallback(() => {
    setPrevious([]);
    if (cursor) setCursor(undefined);
    else void reloadQueue();
  }, [cursor, reloadQueue]);
  return (
    <section
      className={styles.panel}
      hidden={!active}
      data-role="ops-feedback-queue"
      data-queue-revision={resource.value?.queueRevision}
      data-ops-view-state={
        resource.loading
          ? 'loading'
          : resource.error
            ? 'error'
            : resource.value
              ? 'ready'
              : 'loading'
      }
    >
      <div className={styles.card}>
        <h2>Feedback and observations</h2>
        <p>
          Unresolved records are shown oldest first. New records need triage;
          saving notes does not grant human acceptance.
        </p>
        <div className={styles.fields}>
          <label>
            Status
            <select
              data-control="queue-status"
              value={filter}
              onChange={(e) => {
                setCursor(undefined);
                setPrevious([]);
                setSelected('');
                setFilter(e.target.value as OpsQueueOptions['status']);
              }}
            >
              {[
                'active',
                'all',
                'open',
                'in-progress',
                'awaiting-review',
                'resolved',
                'expired',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select
              data-control="queue-kind"
              value={kind}
              onChange={(e) => {
                setCursor(undefined);
                setPrevious([]);
                setSelected('');
                setKind(e.target.value as OpsQueueOptions['kind']);
              }}
            >
              {['all', 'feedback', 'observation'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          data-control="queue-refresh"
          disabled={resource.loading}
          type="button"
          onClick={refresh}
        >
          Refresh queue
        </button>
        {resource.error && (
          <p className={styles.error} role="alert">
            {resource.error} Refresh restarts paging with current records.
          </p>
        )}
      </div>
      {resource.loading ? (
        <p>Loading saved records…</p>
      ) : (
        resource.value && (
          <>
            <p>
              {resource.value.items.length} records on this page · Queue
              revision {resource.value.queueRevision}
            </p>
            {!resource.value.items.length && <p>No matching records.</p>}
            {resource.value.items.map((record) => (
              <article
                className={styles.card}
                key={record.id}
                data-feedback-id={record.id}
              >
                <h3>
                  {record.kind} · {record.status} · {record.severity}
                </h3>
                <p>
                  {record.lessonVersion} · {opsDate(record.createdAt)}
                </p>
                <p>
                  {record.ownerRef ?? 'Needs triage · Unassigned'} · Next
                  review: {opsDate(record.nextReviewAt)}
                </p>
                {record.detailsRemoved && <p>Details removed</p>}
                {record.historical && <p>Historical · Read only</p>}
                <button
                  data-control="feedback-open"
                  type="button"
                  onClick={() => setSelected(record.id)}
                >
                  View record
                </button>
              </article>
            ))}
            <div className={styles.row}>
              {previous.length > 0 && (
                <button
                  data-control="queue-previous"
                  type="button"
                  onClick={() => {
                    setCursor(previous.at(-1));
                    setPrevious((value) => value.slice(0, -1));
                  }}
                >
                  Previous page
                </button>
              )}
              {resource.value.nextCursor && (
                <button
                  data-control="queue-next"
                  type="button"
                  onClick={() => {
                    setPrevious((value) => [...value, cursor]);
                    setCursor(resource.value?.nextCursor ?? undefined);
                  }}
                >
                  Next page
                </button>
              )}
            </div>
          </>
        )
      )}
      {selected && (
        <FeedbackDetail
          key={selected}
          me={me}
          recordId={selected}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
export default function OperatorOpsPanel({
  me,
  view,
  active,
}: {
  me: PilotMe;
  view: 'operations' | 'feedback' | 'observations';
  active: boolean;
}) {
  return (
    <div className={styles.panel} hidden={!active} inert={!active || undefined}>
      <Operations me={me} active={active && view === 'operations'} />
      <FeedbackQueue me={me} active={active && view === 'feedback'} />
      <section
        className={styles.panel}
        hidden={!active || view !== 'observations'}
        data-role="ops-observations"
      >
        <ObservationForm me={me} />
      </section>
    </div>
  );
}
