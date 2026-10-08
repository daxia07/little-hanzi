'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createFamilyStoryClient,
  createScopeGuard,
  localStoryDate,
} from '@/lib/pilot-story-client';
import type {
  CurriculumProgress,
  StoryGroup,
} from '@/lib/curriculum/story-types';
import styles from './story/family.module.css';
import ParentFeedbackForm from './ops/ParentFeedbackForm';
export default function ParentStoryProgress({
  me,
  readOnly = false,
}: {
  me: PilotMe;
  readOnly?: boolean;
}) {
  const [child, setChild] = useState(me.children[0]?.id ?? '');
  return (
    <section className={styles.family} data-role="ordinary-story-progress">
      <h2>Saved story learning</h2>
      {me.children.length ? (
        <>
          <label>
            Choose child
            <select
              data-control="progress-child"
              value={child}
              onChange={(e) => setChild(e.target.value)}
            >
              {me.children.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Progress
            key={`${me.installationId}:${me.user.id}:${child}`}
            me={me}
            child={child}
            readOnly={readOnly}
          />
        </>
      ) : (
        <p>No child learning is currently shared with this account.</p>
      )}
    </section>
  );
}
function Counts({ name, group }: { name: string; group: StoryGroup }) {
  return (
    <section className={styles.record} data-evidence-group={name}>
      <h3>
        {name === 'immediate'
          ? 'Four final checks'
          : name === 'familiarity'
            ? 'First look'
            : 'Later review'}
      </h3>
      <div className={styles.counts}>
        {(['independent', 'supported', 'unavailable', 'pending'] as const).map(
          (category) => (
            <span key={category} data-category={category}>
              {group[category]}{' '}
              {category === 'pending' ? 'not completed' : category}
            </span>
          ),
        )}
      </div>
    </section>
  );
}
function Progress({
  me,
  child,
  readOnly,
}: {
  me: PilotMe;
  child: string;
  readOnly: boolean;
}) {
  const api = useMemo(() => createFamilyStoryClient(me), [me]);
  const guard = useMemo(
    () => createScopeGuard(`${me.installationId}:${me.user.id}:${child}`),
    [me.installationId, me.user.id, child],
  );
  const [data, setData] = useState<CurriculumProgress | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [exporting, setExporting] = useState(false);
  const load = useCallback(
    async function load() {
      const token = guard.begin();
      setLoading(true);
      setError('');
      try {
        const result = await api.progress(child);
        if (guard.current(token)) setData(result.curriculum ?? null);
      } catch (e) {
        if (guard.current(token)) {
          setData(null);
          setError(
            e instanceof Error ? e.message : 'Saved progress could not load.',
          );
        }
      } finally {
        if (guard.current(token)) setLoading(false);
      }
    },
    [api, guard, child],
  );
  useEffect(() => {
    guard.activate();
    const token = guard.capture();
    queueMicrotask(() => {
      if (guard.current(token)) void load();
    });
    return () => guard.destroy();
  }, [guard, load]);
  async function exportSaved() {
    const token = guard.begin();
    setExporting(true);
    try {
      const result = await api.export(child);
      if (!guard.current(token)) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: 'application/json',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'saved-learning.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (guard.current(token))
        setError(e instanceof Error ? e.message : 'Export could not load.');
    } finally {
      if (guard.current(token)) setExporting(false);
    }
  }
  return (
    <div data-child-id={child} aria-busy={loading}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          data-control="refresh-story-progress"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh saved learning
        </button>
        {!readOnly && (
          <button
            data-control="export-story-progress"
            disabled={loading || exporting}
            onClick={() => void exportSaved()}
          >
            Export saved learning
          </button>
        )}
      </div>
      {loading ? (
        <p>Loading saved learning…</p>
      ) : !data?.runs.length ? (
        <p>No saved story evidence yet.</p>
      ) : (
        data.runs.map((run) => (
          <section
            className={styles.record}
            key={run.runId}
            data-story-run-id={run.runId}
          >
            <h3>{run.lesson.title}</h3>
            <p>
              {run.state.reviewCompletedAt
                ? 'Later review saved'
                : run.state.completedAt
                  ? 'Initial story saved'
                  : 'Story in progress'}{' '}
              · {localStoryDate(run.updatedAt)}
            </p>
            {!run.available && (
              <p data-unavailable>
                {run.reason ?? 'History only. This story is no longer active.'}
              </p>
            )}
            <Counts name="familiarity" group={run.recap.familiarity} />
            <Counts name="immediate" group={run.recap.immediate} />
            <Counts name="delayed" group={run.recap.delayed} />
            <p>
              Story activities completed: {run.recap.game.completed} of{' '}
              {run.recap.game.total}.
            </p>
            <p data-due-at={run.reviewAvailableAt ?? undefined}>
              Later review:{' '}
              {run.state.reviewCompletedAt
                ? 'Saved'
                : run.reviewDue
                  ? 'Ready'
                  : localStoryDate(run.reviewAvailableAt)}
              .
            </p>
            <details>
              <summary>First responses and support</summary>
              {run.events.map((e) => (
                <p
                  key={e.eventId}
                  data-event-id={e.eventId}
                  data-record-id={e.questionId ?? undefined}
                >
                  {e.questionId ?? 'Story step'} · {e.outcome} ·{' '}
                  {e.firstResponse ? 'first response' : 'later action'} ·{' '}
                  {e.assisted ? 'supported' : 'no extra help'}
                </p>
              ))}
            </details>
            {!readOnly && (
              <ParentFeedbackForm
                key={run.runId}
                me={me}
                childId={child}
                runId={run.runId}
                title={run.lesson.title}
                version={run.lessonVersion}
              />
            )}
            {run.recap.evidenceLimits.map((limit) => (
              <p key={limit}>{limit}</p>
            ))}
          </section>
        ))
      )}
      {data?.evidenceLimits.map((limit) => (
        <p key={limit}>{limit}</p>
      ))}
    </div>
  );
}
