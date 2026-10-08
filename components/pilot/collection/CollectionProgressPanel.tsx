'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import { createCollectionClient } from '@/lib/pilot-collection-client';
import {
  createScopeGuard,
  registerPilotStoryController,
  localStoryDate,
} from '@/lib/pilot-story-client';
import type { CollectionProgress } from '@/lib/curriculum/collection-types';
import { CollectionCounts } from './CollectionLesson';
import styles from './collection.module.css';
export default function CollectionProgressPanel({
  me,
  readOnly = false,
}: {
  me: PilotMe;
  readOnly?: boolean;
}) {
  const [child, setChild] = useState(me.children[0]?.id ?? '');
  return (
    <section className={styles.collection} data-role="collection-progress">
      <h2>Saved collection learning</h2>
      {me.children.length ? (
        <>
          <label>
            Choose child
            <select
              data-control="collection-progress-child"
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
function Progress({
  me,
  child,
  readOnly,
}: {
  me: PilotMe;
  child: string;
  readOnly: boolean;
}) {
  const api = useMemo(() => createCollectionClient(me), [me]),
    guard = useMemo(
      () => createScopeGuard(`${me.installationId}:${me.user.id}:${child}`),
      [me.installationId, me.user.id, child],
    );
  const [data, setData] = useState<CollectionProgress[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [exporting, setExporting] = useState(false);
  const load = useCallback(
    async function load() {
      const token = guard.begin();
      setLoading(true);
      setError('');
      try {
        const value = await api.progress(child);
        if (guard.current(token)) setData(value);
      } catch (e) {
        if (guard.current(token)) {
          setData([]);
          setError(
            e instanceof Error ? e.message : 'Saved learning could not load.',
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
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      setData([]);
      setError('');
    });
    return () => {
      guard.destroy();
      unregister();
    };
  }, [guard, load]);
  async function download() {
    const token = guard.capture();
    setExporting(true);
    try {
      const value = await api.export(child);
      if (!guard.current(token)) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'little-hanzi-learning.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (guard.current(token))
        setError(e instanceof Error ? e.message : 'Export could not load.');
    } finally {
      if (guard.current(token)) setExporting(false);
    }
  }
  return (
    <div
      data-child-id={child}
      data-ready={!loading && !error}
      aria-busy={loading}
    >
      {loading ? (
        <p>Loading saved learning…</p>
      ) : error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : data.length === 0 ? (
        <p>No collection learning has been saved yet.</p>
      ) : (
        data.map((collection) => (
          <section
            key={collection.collectionDigest}
            data-collection-version={collection.collectionVersion}
          >
            {collection.visits.map((v) => (
              <section
                className={styles.surface}
                key={v.scheduleId}
                data-schedule-id={v.scheduleId}
                data-run-id={v.runId ?? undefined}
                data-phase={v.phase}
              >
                <h3>
                  {v.lessonVersion} ·{' '}
                  {v.phase === 'initial'
                    ? 'Initial lesson'
                    : v.phase === 'review-24h'
                      ? 'First later review'
                      : 'Seven-day review'}
                </h3>
                <p>
                  {v.completedAt
                    ? `Completed ${localStoryDate(v.completedAt)}`
                    : v.runId
                      ? 'This visit is unfinished'
                      : `Ready on ${localStoryDate(v.dueAt)}`}
                </p>
                {v.phase === 'initial' && (
                  <p>{v.introducedTargets.length} targets introduced</p>
                )}
                {v.recap ? (
                  <>
                    {v.phase === 'initial' && (
                      <>
                        <CollectionCounts
                          name="familiarity"
                          group={v.recap.familiarity}
                        />
                        <CollectionCounts
                          name="practice"
                          group={v.recap.practice}
                        />
                      </>
                    )}
                    <CollectionCounts name="check" group={v.recap.check} />
                  </>
                ) : (
                  <p>
                    No saved evidence for this visit yet. A missed visit does
                    not mean decline.
                  </p>
                )}
                <details>
                  <summary>Lesson version and evidence limits</summary>
                  <p>{v.lessonVersion}</p>
                  <p>{v.contentDigest}</p>
                  {v.recap?.evidenceLimits.map((t) => (
                    <p key={t}>{t}</p>
                  ))}
                </details>
              </section>
            ))}
            {collection.evidenceLimits.map((t) => (
              <p className={styles.muted} key={t}>
                {t}
              </p>
            ))}
          </section>
        ))
      )}
      <div className={styles.row}>
        <button
          data-control="collection-progress-refresh"
          disabled={loading || exporting}
          onClick={() => void load()}
        >
          Refresh saved learning
        </button>
        {!readOnly && (
          <button
            data-control="collection-export"
            disabled={loading || exporting || !!error}
            onClick={() => void download()}
          >
            {exporting ? 'Preparing export…' : 'Export learning'}
          </button>
        )}
      </div>
    </div>
  );
}
