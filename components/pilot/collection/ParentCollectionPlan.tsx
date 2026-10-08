'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  COLLECTION_VERSION,
  createCollectionClient,
} from '@/lib/pilot-collection-client';
import {
  createScopeGuard,
  registerPilotStoryController,
} from '@/lib/pilot-story-client';
import type {
  CollectionLibraryItem,
  CollectionProposal,
  CollectionPlan,
  CollectionProposalInput,
} from '@/lib/curriculum/collection-types';
import styles from './collection.module.css';
type Pending =
  | { kind: 'propose'; body: CollectionProposalInput; ack: boolean }
  | {
      kind: 'approve';
      body: { proposalId: string; sourceDigest: string };
      ack: boolean;
    };
export default function ParentCollectionPlan({
  me,
  onSignOut,
}: {
  me: PilotMe;
  onSignOut: () => void;
}) {
  const [child, setChild] = useState(me.children[0]?.id ?? '');
  return (
    <section className={styles.collection} data-role="collection-plan">
      <h2>Choose a starting lesson</h2>
      <p>
        Explore short stories, one pair of characters at a time. A starting
        suggestion is not a mastery judgment.
      </p>
      {me.children.length ? (
        <>
          <label>
            Choose child
            <select
              data-control="collection-child"
              value={child}
              onChange={(e) => setChild(e.target.value)}
            >
              {me.children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Plan
            key={`${me.installationId}:${me.user.id}:${child}`}
            me={me}
            child={child}
            onSignOut={onSignOut}
          />
        </>
      ) : (
        <p>No child is currently linked to your account.</p>
      )}
    </section>
  );
}
function Plan({
  me,
  child,
  onSignOut,
}: {
  me: PilotMe;
  child: string;
  onSignOut: () => void;
}) {
  const api = useMemo(() => createCollectionClient(me), [me]),
    guard = useMemo(
      () => createScopeGuard(`${me.installationId}:${me.user.id}:${child}`),
      [me.installationId, me.user.id, child],
    );
  const [items, setItems] = useState<CollectionLibraryItem[]>([]),
    [proposal, setProposal] = useState<CollectionProposal | null>(null),
    [plan, setPlan] = useState<CollectionPlan | null>(null),
    [setup, setSetup] = useState(false),
    [selection, setSelection] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [status, setStatus] = useState('loading');
  const pending = useRef<Pending | null>(null);
  const read = useCallback(
    async function read(token: ReturnType<typeof guard.begin>) {
      const [library, placement, saved] = await Promise.all([
        api.library(child),
        api.placement(child),
        api.plan(child),
      ]);
      if (!guard.current(token)) return false;
      setItems(library.items);
      setProposal(placement.proposal);
      setPlan(saved.plan);
      setSetup(placement.setupComplete);
      setNotice(placement.reason ?? '');
      pending.current = null;
      setStatus('saved');
      return true;
    },
    [api, guard, child],
  );
  const refresh = useCallback(
    async function refresh() {
      const token = guard.begin();
      setStatus('loading');
      setError('');
      try {
        await read(token);
      } catch (e) {
        if (guard.current(token)) {
          setStatus(
            pending.current?.ack
              ? 'readback-pending'
              : pending.current
                ? 'conflict'
                : 'error',
          );
          setError(
            e instanceof Error ? e.message : 'The collection could not load.',
          );
        }
      }
    },
    [guard, read],
  );
  useEffect(() => {
    guard.activate();
    const token = guard.capture();
    queueMicrotask(() => {
      if (guard.current(token)) void refresh();
    });
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      pending.current = null;
      setItems([]);
      setProposal(null);
      setPlan(null);
      setSelection('');
      setStatus('locked');
    });
    return () => {
      guard.destroy();
      pending.current = null;
      unregister();
    };
  }, [guard, refresh]);
  async function mutate(kind: 'propose' | 'approve', retry = false) {
    const token = guard.begin();
    if (!retry) {
      pending.current =
        kind === 'propose'
          ? {
              kind,
              body: {
                collectionVersion: COLLECTION_VERSION,
                lessonVersion: selection || null,
                predecessorProposalId: proposal?.proposalId ?? null,
                expectedSourceDigest: proposal?.sourceDigest ?? null,
              },
              ack: false,
            }
          : proposal
            ? {
                kind,
                body: {
                  proposalId: proposal.proposalId,
                  sourceDigest: proposal.sourceDigest,
                },
                ack: false,
              }
            : null;
    }
    const op = pending.current;
    if (!op) return;
    setStatus('saving');
    setError('');
    try {
      if (!op.ack) {
        if (op.kind === 'propose') await api.propose(child, op.body);
        else await api.approve(child, op.body);
        if (!guard.current(token)) return;
        op.ack = true;
      }
      await read(token);
      if (guard.current(token)) {
        setNotice(
          kind === 'approve'
            ? 'Plan approved. Sign out so your child can control the lesson.'
            : 'Your current starting suggestion is ready to review.',
        );
        setSelection('');
      }
    } catch (e) {
      if (!guard.current(token)) return;
      const code = (e as { status?: number }).status;
      if ([401, 403, 404].includes(code ?? 0)) {
        pending.current = null;
        setItems([]);
        setProposal(null);
        setPlan(null);
        setSelection('');
        setStatus('locked');
      } else
        setStatus(
          op.ack
            ? 'readback-pending'
            : code === 409
              ? 'conflict'
              : code === 400
                ? 'error'
                : 'pending',
        );
      setError(
        e instanceof Error ? e.message : 'Saving is unconfirmed. Retry.',
      );
    }
  }
  const busy = [
    'loading',
    'saving',
    'pending',
    'readback-pending',
    'conflict',
    'locked',
  ].includes(status);
  return (
    <div
      data-child-id={child}
      data-save-state={status}
      aria-busy={status === 'loading' || status === 'saving'}
    >
      <output className={styles.status}>
        {status === 'saved'
          ? 'Saved collection loaded'
          : status === 'pending'
            ? 'Save unconfirmed'
            : status === 'readback-pending'
              ? 'Saved; refreshing'
              : status === 'conflict'
                ? 'Saved choice changed'
                : status === 'locked'
                  ? 'Sign in again'
                  : status === 'loading'
                    ? 'Loading your collection…'
                    : status === 'saving'
                      ? 'Saving…'
                      : 'Collection could not load'}
      </output>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}
      {status === 'pending' && (
        <button
          data-control="collection-retry"
          onClick={() => void mutate(pending.current!.kind, true)}
        >
          Retry the same change
        </button>
      )}
      {status === 'readback-pending' && (
        <button data-control="collection-retry" onClick={() => void refresh()}>
          Retry refresh
        </button>
      )}
      {status === 'conflict' && (
        <button
          data-control="collection-refresh-conflict"
          onClick={() => void refresh()}
        >
          Refresh saved choice
        </button>
      )}
      <button
        data-control="collection-refresh"
        disabled={
          status === 'saving' || status === 'pending' || status === 'locked'
        }
        onClick={() => void refresh()}
      >
        Refresh collection
      </button>
      {!setup && (
        <p>
          Save your child’s starting setup above, then refresh this collection.
        </p>
      )}
      <label>
        Starting lesson
        <select
          data-control="collection-lesson-select"
          disabled={busy || !setup}
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
        >
          <option value="">Use the suggested next lesson</option>
          {items.map((i) => (
            <option
              value={i.lessonVersion}
              key={`${i.lessonVersion}:${i.assignmentId ?? 'candidate'}`}
              disabled={!i.available || i.completed}
            >
              {i.sequence}. {i.title}
              {!i.available
                ? ' — unavailable'
                : i.completed
                  ? ' — completed'
                  : ''}
            </option>
          ))}
        </select>
      </label>
      <button
        className={styles.primary}
        data-control="collection-propose"
        disabled={
          busy || !setup || !items.some((i) => i.available && !i.completed)
        }
        onClick={() => void mutate('propose')}
      >
        {selection
          ? 'Review this starting choice'
          : 'Suggest a starting lesson'}
      </button>
      {!items.some((i) => i.available && !i.completed) &&
        status === 'saved' && <p>No next lesson is ready.</p>}
      {proposal && (
        <section
          className={styles.surface}
          data-proposal-id={proposal.proposalId}
          data-source-digest={proposal.sourceDigest}
        >
          <h3>Starting suggestion</h3>
          <p>
            {items.find((i) => i.lessonVersion === proposal.lessonVersion)
              ?.title ?? proposal.lessonVersion}
          </p>
          <p>{proposal.reason}</p>
          <p className={styles.muted}>
            Familiarity checks decide which targets get a full introduction or
            reminder.
          </p>
          <button
            data-control="collection-approve"
            className={styles.primary}
            disabled={busy || !setup}
            onClick={() => void mutate('approve')}
          >
            Approve starting plan
          </button>
        </section>
      )}
      {plan && (
        <section className={styles.surface} data-plan-id={plan.planId}>
          <h3>
            {plan.available
              ? 'Approved starting plan'
              : 'Starting plan unavailable'}
          </h3>
          {plan.items.map((i) => (
            <p key={i.planItemId}>{i.title}</p>
          ))}
          {plan.reason && <p>{plan.reason}</p>}
          <button
            data-control="collection-sign-out"
            disabled={busy}
            onClick={onSignOut}
          >
            Sign out for child
          </button>
        </section>
      )}
    </div>
  );
}
