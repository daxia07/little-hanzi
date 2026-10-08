'use client';
import { useCallback, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import type {
  OpsObservation,
  OpsObservationInput,
  OpsCorrectionInput,
  OpsDetail,
  OpsDetailResponse,
} from '@/lib/pilot-ops-types';
import { newOpsRequestId } from '@/lib/pilot-ops-client';
import { useOpsApi, useOpsWrite, WriteStatus, styles } from './shared';
const empty: OpsObservation = {
  kind: 'synthetic',
  participantLabel: '',
  candidateId: '',
  lessonVersion: '',
  contentDigest: '',
  observedAt: 0,
  device: '',
  browser: '',
  parentAgreementRef: '',
  tasks: [],
  completion: 'not-started',
  savedRecapRef: null,
  adultHelp: '',
  interruptions: '',
  observedBehavior: '',
  observerInterpretation: '',
  laterRecall: { status: 'not-run' },
};
function localInput(ms: number) {
  if (!ms) return '';
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export default function ObservationForm({
  me,
  record,
  onSaved,
  onExpired,
}: {
  me: PilotMe;
  record?: OpsDetail;
  onSaved?: (result: OpsDetailResponse) => void;
  onExpired?: () => void;
}) {
  const api = useOpsApi(me);
  const original =
    record?.details && 'observation' in record.details
      ? record.details.observation
      : empty;
  const [draft, setDraft] = useState(() => structuredClone(original)),
    [date, setDate] = useState(localInput(original.observedAt)),
    [taskText, setTasks] = useState(original.tasks.join('\n')),
    [reason, setReason] = useState(''),
    [recallDate, setRecallDate] = useState(
      original.laterRecall.status === 'observed'
        ? localInput(original.laterRecall.observedAt)
        : '',
    );
  const send = useCallback(
    async (body: OpsObservationInput | OpsCorrectionInput) => {
      try {
        return record
          ? await api.correct(record.id, body as OpsCorrectionInput)
          : await api.observation(body);
      } catch (e) {
        if (
          e &&
          typeof e === 'object' &&
          'code' in e &&
          e.code === 'OPS_DETAILS_EXPIRED'
        )
          onExpired?.();
        throw e;
      }
    },
    [api, record, onExpired],
  );
  const read = useCallback(
    async (receipt: { recordId: string } | null) => {
      if (!receipt) throw new Error('No acknowledgement yet.');
      const result = await api.detail(receipt.recordId);
      onSaved?.(result);
      return result;
    },
    [api, onSaved],
  );
  const write = useOpsWrite(send, read);
  const editing = write.snapshot.state === 'idle' && !record?.readOnly;
  const set = <K extends keyof OpsObservation>(
    key: K,
    value: OpsObservation[K],
  ) => setDraft((previous) => ({ ...previous, [key]: value }));
  const textField = (
    key:
      | 'participantLabel'
      | 'candidateId'
      | 'lessonVersion'
      | 'contentDigest'
      | 'device'
      | 'browser'
      | 'parentAgreementRef',
    label: string,
    max = 120,
  ) => (
    <label key={key}>
      {label}
      <input
        data-control={'observation-' + key}
        value={draft[key]}
        disabled={
          !editing ||
          (!!record &&
            ['candidateId', 'lessonVersion', 'contentDigest'].includes(key))
        }
        required
        maxLength={max * 2}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const notes = (
    key:
      | 'adultHelp'
      | 'interruptions'
      | 'observedBehavior'
      | 'observerInterpretation',
    label: string,
  ) => (
    <label key={key}>
      {label}
      <textarea
        data-control={'observation-' + key}
        maxLength={2000}
        disabled={!editing}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  function submit() {
    const observation = {
      ...draft,
      participantLabel: draft.participantLabel.trim(),
      candidateId: draft.candidateId.trim(),
      lessonVersion: draft.lessonVersion.trim(),
      contentDigest: draft.contentDigest.trim(),
      device: draft.device.trim(),
      browser: draft.browser.trim(),
      parentAgreementRef: draft.parentAgreementRef.trim(),
      observedAt: new Date(date).getTime(),
      tasks: taskText
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
      laterRecall:
        draft.laterRecall.status === 'observed'
          ? { ...draft.laterRecall, observedAt: new Date(recallDate).getTime() }
          : draft.laterRecall,
    };
    const body = { requestId: newOpsRequestId(), observation };
    void write.controller.submit(
      record
        ? {
            ...body,
            expectedRevision: record.revision,
            correctionReason: reason.trim(),
          }
        : body,
    );
  }
  return (
    <form
      className={styles.card + ' ' + styles.form}
      data-role={record ? 'observation-correction' : 'observation-create'}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2>{record ? 'Correct observation notes' : 'Record an observation'}</h2>
      <p>
        These are attributed notes, not content approval or learning proof. A
        synthetic session cannot stand in for an actual child observation.
      </p>
      <div className={styles.fields}>
        <label>
          Observation kind
          <select
            data-control="observation-kind"
            disabled={!editing || !!record}
            value={draft.kind}
            onChange={(e) =>
              set('kind', e.target.value as OpsObservation['kind'])
            }
          >
            <option value="synthetic">Synthetic test</option>
            <option value="actual">Actual observation</option>
          </select>
        </label>
        {textField('participantLabel', 'Anonymous participant label', 40)}
        {textField('candidateId', 'Observed candidate ID')}
        {textField('lessonVersion', 'Lesson version')}
        {textField('contentDigest', 'Content digest')}
        <label>
          Observation date and time{' '}
          <span className={styles.muted}>Local time</span>
          <input
            data-control="observation-date"
            type="datetime-local"
            required
            disabled={!editing || !!record}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {textField('device', 'Device')}
        {textField('browser', 'Browser')}
        {textField('parentAgreementRef', 'Parent agreement reference', 240)}
      </div>
      <p className={styles.muted}>
        Enter an actual agreement reference for actual notes. Recording a
        reference does not grant agreement or acceptance. Do not include a
        child’s name or personal details.
      </p>
      <label>
        Tasks attempted{' '}
        <span className={styles.muted}>
          One short label per line, up to 20.
        </span>
        <textarea
          data-control="observation-tasks"
          required
          disabled={!editing}
          value={taskText}
          onChange={(e) => setTasks(e.target.value)}
        />
      </label>
      <label>
        Completion observed
        <select
          data-control="observation-completion"
          value={draft.completion}
          disabled={!editing}
          onChange={(e) =>
            set('completion', e.target.value as OpsObservation['completion'])
          }
        >
          <option value="not-started">Not started</option>
          <option value="partial">Partial or stopped</option>
          <option value="ended">Story ending reached</option>
        </select>
      </label>
      <label>
        Saved recap reference{' '}
        <span className={styles.muted}>Optional, up to 240 characters.</span>
        <input
          data-control="observation-recap"
          maxLength={480}
          value={draft.savedRecapRef ?? ''}
          disabled={!editing}
          onChange={(e) =>
            set('savedRecapRef', e.target.value.trim() ? e.target.value : null)
          }
        />
      </label>
      <p>
        {draft.savedRecapRef
          ? 'Recap reference is attributed and unverified.'
          : 'Saving is unconfirmed. An observed ending does not prove a saved completion.'}
      </p>
      {notes('adultHelp', 'Adult help provided')}
      {notes('interruptions', 'Interruptions')}
      {notes('observedBehavior', 'Observed behavior or confusion')}
      {notes('observerInterpretation', 'Observer interpretation')}
      <label>
        Later recall
        <select
          data-control="observation-recall-status"
          disabled={!editing}
          value={draft.laterRecall.status}
          onChange={(e) =>
            set(
              'laterRecall',
              e.target.value === 'observed'
                ? {
                    status: 'observed',
                    observedAt: 0,
                    evidenceRef: '',
                    adultHelp: '',
                    observation: '',
                  }
                : { status: 'not-run' },
            )
          }
        >
          <option value="not-run">Not run</option>
          <option value="observed">Separately observed</option>
        </select>
      </label>
      {draft.laterRecall.status === 'observed' && (
        <>
          <label>
            Later observation date{' '}
            <span className={styles.muted}>
              Local time; at or after the original visit.
            </span>
            <input
              data-control="observation-recall-date"
              required
              type="datetime-local"
              disabled={!editing}
              value={recallDate}
              onChange={(e) => setRecallDate(e.target.value)}
            />
          </label>
          {(['evidenceRef', 'adultHelp', 'observation'] as const).map((key) => (
            <label key={key}>
              {key === 'evidenceRef'
                ? 'Later recall evidence reference'
                : key === 'adultHelp'
                  ? 'Later recall adult help'
                  : 'Later recall observation'}
              <textarea
                data-control={'observation-recall-' + key}
                required={key === 'evidenceRef'}
                disabled={!editing}
                maxLength={key === 'evidenceRef' ? 480 : 2000}
                value={
                  draft.laterRecall.status === 'observed'
                    ? draft.laterRecall[key]
                    : ''
                }
                onChange={(e) =>
                  setDraft((previous) => ({
                    ...previous,
                    laterRecall:
                      previous.laterRecall.status === 'observed'
                        ? { ...previous.laterRecall, [key]: e.target.value }
                        : previous.laterRecall,
                  }))
                }
              />
            </label>
          ))}
        </>
      )}
      {record && (
        <label>
          Correction reason
          <textarea
            data-control="observation-correction-reason"
            required
            maxLength={2000}
            disabled={!editing}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      <button
        className={styles.primary}
        data-control={record ? 'observation-correct' : 'observation-save'}
        disabled={!editing}
      >
        {record ? 'Save correction' : 'Save observation'}
      </button>
      <WriteStatus write={write} />
      {write.snapshot.state === 'saved' && (
        <button
          type="button"
          data-control="observation-new"
          onClick={() => {
            write.controller.reset();
            if (!record) {
              setDraft(structuredClone(empty));
              setDate('');
              setTasks('');
              setRecallDate('');
            } else {
              setDraft(structuredClone(original));
              setTasks(original.tasks.join('\n'));
            }
            setReason('');
          }}
        >
          {record ? 'Review another correction' : 'Record another observation'}
        </button>
      )}
      <p className={styles.muted}>
        Private details are removed after 30 days from submission, including
        earlier revisions. Restricted backups may retain earlier text until
        their own expiry.
      </p>
    </form>
  );
}
