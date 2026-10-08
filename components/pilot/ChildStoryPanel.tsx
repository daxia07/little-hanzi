'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createFamilyStoryClient,
  createScopeGuard,
  createPilotStoryRecovery,
  createPilotStoryTransport,
  ensurePilotStoryIdentity,
  localStoryDate,
  type PilotStoryScope,
} from '@/lib/pilot-story-client';
import type { PracticeItem, StoryPlan } from '@/lib/curriculum/story-types';
import OrdinaryStoryLesson from './story/OrdinaryStoryLesson';
import styles from './story/family.module.css';
export default function ChildStoryPanel({
  me,
  onActiveChange,
}: {
  me: PilotMe;
  onActiveChange: (active: boolean) => void;
}) {
  return (
    <ChildStory
      key={`${me.installationId}:${me.user.id}`}
      me={me}
      onActiveChange={onActiveChange}
    />
  );
}
function ChildStory({
  me,
  onActiveChange,
}: {
  me: PilotMe;
  onActiveChange: (active: boolean) => void;
}) {
  const api = useMemo(() => createFamilyStoryClient(me), [me]);
  const guard = useMemo(
    () => createScopeGuard(`${me.installationId}:${me.user.id}`),
    [me.installationId, me.user.id],
  );
  const [practice, setPractice] = useState<PracticeItem[]>([]),
    [plan, setPlan] = useState<StoryPlan | null>(null),
    [selected, setSelected] = useState<PracticeItem | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const load = useCallback(
    async function load() {
      const token = guard.begin();
      setLoading(true);
      setError('');
      try {
        const [p, s] = await Promise.all([
          api.plan(me.user.id),
          api.practice(me.user.id),
        ]);
        if (!guard.current(token)) return;
        setPlan(p.plan);
        setPractice(s.items);
      } catch (e) {
        if (guard.current(token)) {
          setPlan(null);
          setPractice([]);
          setError(
            e instanceof Error ? e.message : 'Your story could not load.',
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
    return () => guard.destroy();
  }, [guard, load]);
  const item =
    selected &&
    plan?.items.find(
      (i) =>
        i.assignmentId === selected.assignmentId &&
        i.publicationId === selected.publicationId,
    );
  if (selected && item && item.assignmentId) {
    const scope: PilotStoryScope = {
      installationId: me.installationId,
      accountId: me.user.id,
      childId: me.user.id,
      publicationId: item.publicationId,
      contentDigest: item.contentDigest,
      assignmentId: item.assignmentId,
    };
    return (
      <AssignedStory
        key={`${scope.publicationId}:${scope.assignmentId}`}
        scope={scope}
        runId={selected.runId}
        reviewRequested={selected.kind === 'delayed-review'}
        onHome={() => {
          setSelected(null);
          onActiveChange(false);
          void load();
        }}
      />
    );
  }
  return (
    <section
      className={styles.family}
      data-role="child-story"
      data-account-id={me.user.id}
      data-installation-id={me.installationId}
    >
      <h2>Your story</h2>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading your saved plan…</p>
      ) : !plan ? (
        <p>Your parent will prepare a starting story for you.</p>
      ) : !plan.available ? (
        <p data-unavailable>
          {plan.reason ??
            'This story is unavailable. Ask your parent to check your plan.'}
        </p>
      ) : practice.length === 0 ? (
        <p>
          Your learning is saved. More practice will appear when it is ready.
        </p>
      ) : (
        practice.map((p) => (
          <div
            className={styles.record}
            key={`${p.assignmentId}:${p.kind}`}
            data-assignment-id={p.assignmentId}
            data-practice-kind={p.kind}
          >
            <h3>
              {plan.items.find((i) => i.assignmentId === p.assignmentId)
                ?.title ?? 'A shady place to read'}
            </h3>
            <p>
              {p.kind === 'delayed-review'
                ? 'Later review'
                : 'Your approved story'}
            </p>
            {p.kind === 'delayed-review' && (
              <p data-due-at={p.dueAt}>
                Review time: {localStoryDate(p.dueAt)}
              </p>
            )}
            {p.available ? (
              <button
                className={styles.primary}
                data-control={
                  p.kind === 'delayed-review'
                    ? 'start-due-review'
                    : p.runId
                      ? 'continue-story'
                      : 'start-story'
                }
                disabled={loading}
                onClick={() => {
                  onActiveChange(true);
                  setSelected(p);
                }}
              >
                {p.kind === 'delayed-review'
                  ? 'Review'
                  : p.runId
                    ? 'Continue'
                    : 'Start story'}
              </button>
            ) : (
              <p data-unavailable>
                {p.reason ?? 'Not ready yet. Your saved learning is safe.'}
              </p>
            )}
          </div>
        ))
      )}
      <div className={styles.actions}>
        <button
          data-control="refresh-child-story"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh story
        </button>
      </div>
    </section>
  );
}
function AssignedStory({
  scope,
  runId,
  reviewRequested,
  onHome,
}: {
  scope: PilotStoryScope;
  runId: string | null;
  reviewRequested: boolean;
  onHome: () => void;
}) {
  const {
    installationId,
    accountId,
    childId,
    publicationId,
    assignmentId,
    contentDigest,
  } = scope;
  const stableScope = useMemo(
    () => ({
      installationId,
      accountId,
      childId,
      publicationId,
      assignmentId,
      contentDigest,
    }),
    [
      installationId,
      accountId,
      childId,
      publicationId,
      assignmentId,
      contentDigest,
    ],
  );
  const verifyIdentity = useMemo(
    () => () => ensurePilotStoryIdentity(stableScope),
    [stableScope],
  );
  const recovery = useMemo(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {}
    return createPilotStoryRecovery(stableScope, storage);
  }, [stableScope]);
  const transport = useMemo(
    () =>
      createPilotStoryTransport(stableScope, {
        verifyIdentity,
        id: recovery.startRequestId,
      }),
    [stableScope, recovery, verifyIdentity],
  );
  return (
    <OrdinaryStoryLesson
      scope={stableScope}
      verifyIdentity={verifyIdentity}
      recovery={recovery}
      transport={transport}
      initialRunId={runId}
      reviewRequested={reviewRequested}
      onHome={onHome}
    />
  );
}
