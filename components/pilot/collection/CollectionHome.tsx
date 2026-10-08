'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createCollectionClient,
  type CollectionScope,
} from '@/lib/pilot-collection-client';
import {
  createScopeGuard,
  registerPilotStoryController,
  localStoryDate,
} from '@/lib/pilot-story-client';
import type {
  CollectionPracticeResponse,
  CollectionPracticeItem,
  CollectionLibraryItem,
} from '@/lib/curriculum/collection-types';
import CollectionLesson from './CollectionLesson';
import styles from './collection.module.css';
export default function CollectionHome({
  me,
  onActiveChange,
}: {
  me: PilotMe;
  onActiveChange: (active: boolean) => void;
}) {
  const api = useMemo(() => createCollectionClient(me), [me]),
    guard = useMemo(
      () => createScopeGuard(`${me.installationId}:${me.user.id}`),
      [me.installationId, me.user.id],
    );
  const [data, setData] = useState<CollectionPracticeResponse | null>(null),
    [items, setItems] = useState<CollectionLibraryItem[]>([]),
    [selected, setSelected] = useState<CollectionPracticeItem | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const load = useCallback(
    async function load() {
      const token = guard.begin();
      setLoading(true);
      setError('');
      try {
        const [practice, library] = await Promise.all([
          api.practice(me.user.id),
          api.library(me.user.id),
        ]);
        if (!guard.current(token)) return;
        setData(practice);
        setItems(library.items);
      } catch (e) {
        if (guard.current(token)) {
          setData(null);
          setItems([]);
          setError(
            e instanceof Error ? e.message : 'Your learning could not load.',
          );
        }
      } finally {
        if (guard.current(token)) setLoading(false);
      }
    },
    [api, guard, me.user.id],
  );
  useEffect(() => {
    guard.activate();
    const token = guard.capture();
    queueMicrotask(() => {
      if (guard.current(token)) void load();
    });
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      setData(null);
      setItems([]);
      setSelected(null);
    });
    return () => {
      guard.destroy();
      unregister();
    };
  }, [guard, load]);
  const scope = useMemo<CollectionScope | null>(
    () =>
      selected
        ? {
            collectionId: selected.collectionId,
            collectionVersion: selected.collectionVersion,
            collectionDigest: selected.collectionDigest,
            lessonId: selected.lessonId,
            lessonVersion: selected.lessonVersion,
            contentDigest: selected.contentDigest,
            adapterId: selected.adapterId,
            adapterVersion: selected.adapterVersion,
            installationId: me.installationId,
            accountId: me.user.id,
            childId: me.user.id,
            assignmentId: selected.assignmentId,
            scheduleId: selected.scheduleId,
            publicationId: selected.publicationId,
          }
        : null,
    [selected, me.installationId, me.user.id],
  );
  if (selected && scope)
    return (
      <CollectionLesson
        key={`${scope.assignmentId}:${scope.scheduleId}`}
        scope={scope}
        runId={selected.runId}
        onHome={() => {
          setSelected(null);
          onActiveChange(false);
          void load();
        }}
      />
    );
  const ordered = data
    ? [...data.items].sort(
        (a, b) =>
          Number(b.scheduleId === data.primary.scheduleId) -
            Number(a.scheduleId === data.primary.scheduleId) ||
          Date.parse(a.dueAt) - Date.parse(b.dueAt),
      )
    : [];
  return (
    <section
      className={styles.collection}
      data-role="collection-home"
      data-ready={!loading && !error && !!data}
      data-account-id={me.user.id}
      data-installation-id={me.installationId}
    >
      <h2>Your next small step</h2>
      {loading ? (
        <p>Loading your saved learning…</p>
      ) : error ? (
        <>
          <p role="alert" className={styles.error}>
            {error}
          </p>
          <button data-control="collection-refresh" onClick={() => void load()}>
            Refresh learning
          </button>
        </>
      ) : (
        <>
          <p>
            {data?.primary.kind === 'continue'
              ? 'Continue your unfinished lesson. Later reviews are here too.'
              : data?.primary.kind === 'review'
                ? 'A later review is ready.'
                : data?.primary.kind === 'next'
                  ? 'Your approved lesson is ready.'
                  : 'Your parent can help choose your next lesson.'}
          </p>
          {ordered.map((i) => {
            const isPrimary = i.scheduleId === data?.primary.scheduleId;
            return (
              <section
                className={styles.surface}
                key={i.scheduleId}
                data-schedule-id={i.scheduleId}
                data-assignment-id={i.assignmentId}
                data-phase={i.kind}
                data-primary={isPrimary}
              >
                <h3>
                  {items.find((l) => l.lessonVersion === i.lessonVersion)
                    ?.title ?? 'Your saved lesson'}
                </h3>
                <p>
                  {i.kind === 'initial'
                    ? i.runId
                      ? 'Ready to continue'
                      : 'Approved lesson'
                    : i.kind === 'review-24h'
                      ? 'First later review'
                      : 'Seven-day review'}
                </p>
                {i.kind !== 'initial' && (
                  <p>
                    {i.available ? 'Ready since' : 'Ready on'}{' '}
                    {localStoryDate(i.dueAt)}
                  </p>
                )}
                {i.reason && <p>{i.reason}</p>}
                <button
                  className={isPrimary ? styles.primary : undefined}
                  data-control={
                    i.runId
                      ? 'collection-continue'
                      : i.kind !== 'initial'
                        ? 'collection-review'
                        : 'collection-start'
                  }
                  disabled={!i.available}
                  onClick={() => {
                    setSelected(i);
                    onActiveChange(true);
                  }}
                >
                  {i.runId
                    ? 'Continue'
                    : i.kind !== 'initial'
                      ? 'Review'
                      : 'Start lesson'}
                  {isPrimary ? ' · suggested' : ''}
                </button>
              </section>
            );
          })}
          {ordered.length === 0 && <p>No next lesson is ready.</p>}
          <button data-control="collection-refresh" onClick={() => void load()}>
            Refresh learning
          </button>
        </>
      )}
    </section>
  );
}
