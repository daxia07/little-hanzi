'use client';
import { useCallback, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import { newOpsRequestId } from '@/lib/pilot-ops-client';
import type {
  OpsCategory,
  OpsFeedbackInput,
  OpsReceipt,
} from '@/lib/pilot-ops-types';
import { useOpsApi, useOpsWrite, WriteStatus, styles } from './shared';
export default function ParentFeedbackForm({
  me,
  childId,
  runId,
  title,
  version,
}: {
  me: PilotMe;
  childId: string;
  runId: string;
  title: string;
  version: string;
}) {
  const api = useOpsApi(me);
  const [open, setOpen] = useState(false),
    [category, setCategory] = useState<OpsCategory>('confusion'),
    [observed, setObserved] = useState(''),
    [expected, setExpected] = useState('');
  const send = useCallback(
    (body: OpsFeedbackInput) => api.feedback(childId, body),
    [api, childId],
  );
  // Parents cannot read the private operator queue. The direct receipt confirms this report.
  const read = useCallback(async (receipt: OpsReceipt | null) => receipt, []);
  const write = useOpsWrite(send, read);
  const editing = write.snapshot.state === 'idle';
  return (
    <div className={styles.panel} data-feedback-run-id={runId}>
      <button
        data-control="report-problem"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Report a problem
      </button>
      {open && (
        <form
          className={styles.card + ' ' + styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void write.controller.submit({
              requestId: newOpsRequestId(),
              runId,
              category,
              observed,
              expected,
            });
          }}
        >
          <h4>Report a problem with this story</h4>
          <p>
            {title} · {version}. Your saved answers stay as they are.
          </p>
          <label>
            Problem type
            <select
              data-control="feedback-category"
              disabled={!editing}
              value={category}
              onChange={(e) => setCategory(e.target.value as OpsCategory)}
            >
              {['confusion', 'sound', 'saving', 'access', 'other'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            What happened?
            <textarea
              data-control="feedback-observed"
              required
              maxLength={2000}
              disabled={!editing}
              value={observed}
              onChange={(e) => setObserved(e.target.value)}
            />
          </label>
          <label>
            What did you expect? <span className={styles.muted}>Optional</span>
            <textarea
              data-control="feedback-expected"
              maxLength={2000}
              disabled={!editing}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </label>
          <p className={styles.muted}>
            Use up to 1,000 characters per answer. Leave out names and personal
            details. Private details are removed after 30 days; restricted
            backups may keep earlier text until their own expiry.
          </p>
          <button
            className={styles.primary}
            data-control="feedback-save"
            disabled={
              !editing ||
              !observed.trim() ||
              Array.from(observed).length > 1000 ||
              Array.from(expected).length > 1000
            }
          >
            Save report
          </button>
          <WriteStatus write={write} />
          {write.snapshot.state === 'saved' && (
            <button
              data-control="feedback-new"
              type="button"
              onClick={() => {
                write.controller.reset();
                setObserved('');
                setExpected('');
              }}
            >
              Report another problem
            </button>
          )}
        </form>
      )}
    </div>
  );
}
