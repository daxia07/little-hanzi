'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createCorpusFamilyClient,
  type CorpusScope,
} from '@/lib/pilot-corpus-client';
import type {
  CorpusPracticeItem,
  CorpusPracticeResponse,
} from '@/lib/curriculum/corpus-types';
import {
  createScopeGuard,
  localStoryDate,
  registerPilotStoryController,
} from '@/lib/pilot-story-client';
import CorpusStory from './CorpusStory';
import styles from './corpus.module.css';
function HomeSession({
  me,
  corpusVersion,
  onActiveChange,
}: {
  me: PilotMe;
  corpusVersion: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const api = useMemo(
    () => createCorpusFamilyClient(me, corpusVersion),
    [me, corpusVersion],
  );
  const [practice, setPractice] = useState<CorpusPracticeResponse | null>(null),
    [selected, setSelected] = useState<CorpusPracticeItem | null>(null),
    [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'locked'>(
      'loading',
    );
  const guard = useMemo(
    () =>
      createScopeGuard(
        JSON.stringify([me.installationId, me.user.id, corpusVersion]),
      ),
    [me.installationId, me.user.id, corpusVersion],
  );
  const load = useCallback(async () => {
    if (!guard.current(guard.capture())) return;
    const token = guard.begin();
    setStatus('loading');
    setPractice(null);
    try {
      const p = await api.practice(me.user.id);
      if (!guard.current(token)) return;
      setPractice(p);
      setStatus('ready');
    } catch (e) {
      if (!guard.current(token)) return;
      const denied = [401, 403, 404].includes(
        (e as { status?: number }).status ?? 0,
      );
      if (denied) guard.destroy();
      setStatus(denied ? 'locked' : 'error');
    }
  }, [api, me.user.id, guard]);
  useEffect(() => {
    guard.activate();
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      setPractice(null);
      setSelected(null);
      setStatus('locked');
    });
    const token = guard.capture();
    queueMicrotask(() => {
      if (guard.current(token)) void load();
    });
    return () => {
      guard.destroy();
      unregister();
    };
  }, [load, guard]);
  useEffect(() => {
    onActiveChange?.(selected !== null);
    return () => onActiveChange?.(false);
  }, [selected, onActiveChange]);
  const choose = async (item: CorpusPracticeItem) => {
    const token = guard.capture();
    if (
      !item.available ||
      item.installationId !== me.installationId ||
      status !== 'ready' ||
      !guard.current(token)
    )
      return;
    try {
      const permitted = await api.verify(me.user.id);
      if (!guard.current(token)) return;
      if (!permitted) {
        guard.destroy();
        setPractice(null);
        setStatus('locked');
        return;
      }
      if (!guard.current(token)) return;
      setSelected(item);
    } catch {
      if (guard.current(token)) {
        setPractice(null);
        setStatus('error');
      }
    }
  };
  if (selected) {
    const scope: CorpusScope = {
      corpusId: selected.corpusId,
      corpusVersion: selected.corpusVersion,
      corpusDigest: selected.corpusDigest,
      lessonId: selected.lessonId,
      lessonVersion: selected.lessonVersion,
      contentDigest: selected.contentDigest,
      adapterId: selected.adapterId,
      adapterVersion: selected.adapterVersion,
      installationId: selected.installationId,
      accountId: me.user.id,
      childId: me.user.id,
      assignmentId: selected.assignmentId,
      scheduleId: selected.scheduleId,
      releaseId: selected.releaseId,
      releaseRevision: selected.releaseRevision,
    };
    return (
      <CorpusStory
        scope={scope}
        runId={selected.runId}
        onHome={() => {
          setSelected(null);
          const token = guard.capture();
          queueMicrotask(() => {
            if (guard.current(token)) void load();
          });
        }}
      />
    );
  }
  const primary = practice?.primary;
  const items = practice
    ? [...practice.items].sort(
        (a, b) =>
          Number(b.scheduleId === primary?.scheduleId) -
          Number(a.scheduleId === primary?.scheduleId),
      )
    : [];
  return (
    <section
      className={styles.corpus}
      data-role="corpus-child-home"
      data-home-state={status}
      data-corpus-version={corpusVersion}
      aria-busy={status === 'loading'}
    >
      <h2>Your stories</h2>
      <output className={styles.status} aria-live="polite">
        {status === 'loading'
          ? 'Loading your stories…'
          : status === 'error'
            ? 'Your stories could not load. Retry.'
            : status === 'locked'
              ? 'Your account or access changed. Sign in again.'
              : !items.length
                ? 'Ask your parent to choose a story.'
                : 'Choose a story to begin.'}
      </output>
      {status === 'error' && (
        <button data-control="corpus-home-retry" onClick={() => void load()}>
          Retry stories
        </button>
      )}
      {status === 'ready' &&
        items.map((item) => (
          <article
            className={styles.surface}
            key={item.scheduleId}
            data-schedule-id={item.scheduleId}
            data-lesson-version={item.lessonVersion}
            data-phase={item.kind}
            data-primary={item.scheduleId === primary?.scheduleId}
          >
            <h3>{item.title}</h3>
            <p className={styles.hanzi}>
              {item.targets.map((t) => t.hanzi).join(' · ')}
            </p>
            {item.kind !== 'initial' && (
              <p data-due-at={item.dueAt}>
                Review time: {localStoryDate(item.dueAt)}
              </p>
            )}
            {!item.available && (
              <p>{item.reason || 'This saved story is unavailable.'}</p>
            )}
            <button
              className={
                item.scheduleId === primary?.scheduleId
                  ? styles.primary
                  : undefined
              }
              data-control="corpus-start"
              disabled={
                !item.available || item.installationId !== me.installationId
              }
              onClick={() => void choose(item)}
            >
              {item.runId
                ? 'Continue story'
                : item.kind === 'initial'
                  ? 'Start story'
                  : 'Review story'}
            </button>
          </article>
        ))}
    </section>
  );
}
export default function CorpusHome(props: Parameters<typeof HomeSession>[0]) {
  if (props.me.user.role !== 'child') return null;
  return (
    <HomeSession
      key={JSON.stringify([
        props.me.installationId,
        props.me.user.id,
        props.corpusVersion,
      ])}
      {...props}
    />
  );
}
