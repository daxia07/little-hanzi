'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createCorpusFamilyClient,
  createCorpusPlanController,
  type CorpusPlanSnapshot,
} from '@/lib/pilot-corpus-client';
import type { CorpusProposalInput } from '@/lib/curriculum/corpus-types';
import { registerPilotStoryController } from '@/lib/pilot-story-client';
import CorpusCatalog from './CorpusCatalog';
import styles from './corpus.module.css';
import type { CorpusInitialLoadStatus } from '@/lib/pilot-corpus-load-priority';
const EMPTY: CorpusPlanSnapshot = {
  setupComplete: false,
  proposal: null,
  reason: null,
  plan: null,
  history: [],
  status: 'idle',
  pending: null,
  conflictReady: false,
  notice: '',
};
function ParentSession({
  me,
  childId,
  corpusVersion,
  onInitialCatalog,
}: {
  me: PilotMe;
  childId: string;
  corpusVersion: string;
  onInitialCatalog?: (status: CorpusInitialLoadStatus) => void;
}) {
  const api = useMemo(
    () => createCorpusFamilyClient(me, corpusVersion),
    [me, corpusVersion],
  );
  const scope = useMemo(() => api.scope(childId), [api, childId]);
  const verify = useCallback(() => api.verify(childId), [api, childId]);
  const [view, setView] = useState(EMPTY);
  const controller = useRef<ReturnType<
    typeof createCorpusPlanController
  > | null>(null);
  useEffect(() => {
    let alive = true;
    const c = createCorpusPlanController({
      scope,
      verify,
      onChange: (s) => {
        if (alive) setView(s);
      },
      api: {
        read: async () => {
          const [placement, plans] = await Promise.all([
            api.placement(childId),
            api.plan(childId),
          ]);
          return { ...placement, ...plans };
        },
        propose: (b) => api.propose(childId, b),
        approve: (b) => api.approve(childId, b),
      },
    });
    controller.current = c;
    const unregister = registerPilotStoryController(() => c.lock());
    void c.load();
    return () => {
      alive = false;
      unregister();
      c.destroy();
      controller.current = null;
    };
  }, [api, childId, scope, verify]);
  const ready = view.status === 'saved',
    proposal = view.proposal;
  useEffect(() => {
    if (view.status === 'error' || view.status === 'locked')
      onInitialCatalog?.(view.status);
    else if (view.status === 'saved' && !view.setupComplete)
      onInitialCatalog?.('ready');
  }, [view.status, view.setupComplete, onInitialCatalog]);
  const choose = (selection: CorpusProposalInput['selection']) => {
    if (!ready || !view.setupComplete) return;
    void controller.current?.propose({
      corpusVersion,
      selection,
      predecessorProposalId: proposal?.proposalId ?? null,
      expectedSourceDigest: proposal?.sourceDigest ?? null,
    });
  };
  return (
    <section
      className={styles.corpus}
      data-role="corpus-parent-plan"
      data-save-state={view.status}
      data-corpus-version={corpusVersion}
      aria-busy={view.status === 'loading' || view.status === 'saving'}
    >
      <h2>Plan the next story</h2>
      <p>
        Choose a story, review the suggestion, then approve it for your child.
      </p>
      <output className={styles.status} aria-live="polite">
        {view.status === 'idle' || view.status === 'loading'
          ? 'Loading saved learning…'
          : view.status === 'saving'
            ? 'Saving your choice…'
            : view.notice || view.reason || 'Saved learning loaded.'}
      </output>
      {view.status === 'error' ||
      view.status === 'pending' ||
      view.status === 'readback-pending' ? (
        <button
          data-control="corpus-plan-retry"
          onClick={() => void controller.current?.retry()}
        >
          {view.status === 'pending' ? 'Retry saving' : 'Retry refresh'}
        </button>
      ) : null}
      {view.status === 'conflict' && (
        <div className={styles.row}>
          <button
            data-control="corpus-plan-refresh-conflict"
            onClick={() => void controller.current?.refreshConflict()}
          >
            Load saved choice
          </button>
          <button
            data-control="corpus-plan-accept-conflict"
            disabled={!view.conflictReady}
            onClick={() => controller.current?.acceptConflict()}
          >
            Use saved choice
          </button>
        </div>
      )}
      {ready && !view.setupComplete && (
        <p>Complete your child’s saved setup before choosing a story.</p>
      )}
      {proposal && (
        <article
          className={styles.surface}
          data-role="corpus-proposal"
          data-proposal-id={proposal.proposalId}
        >
          <h3>{proposal.title}</h3>
          <p className={styles.hanzi}>
            {proposal.targets.map((t) => t.hanzi).join(' · ')}
          </p>
          <p>{proposal.reason}</p>
          <button
            className={styles.primary}
            data-control="corpus-approve"
            disabled={!ready || !view.setupComplete}
            onClick={() =>
              void controller.current?.approve({
                proposalId: proposal.proposalId,
                sourceDigest: proposal.sourceDigest,
              })
            }
          >
            Approve this story
          </button>
        </article>
      )}
      {view.plan && (
        <article className={styles.surface} data-role="corpus-approved-plan">
          <h3>Approved story</h3>
          <p>{view.plan.items[0].title}</p>
          <p>
            {view.plan.available
              ? 'Ready for your child to start or continue.'
              : view.plan.reason || 'This saved story is unavailable.'}
          </p>
        </article>
      )}
      <button
        data-control="corpus-recommend"
        disabled={!ready || !view.setupComplete}
        onClick={() => choose(null)}
      >
        Suggest a story
      </button>
      {view.status !== 'locked' && (
        <CorpusCatalog
          scope={scope}
          verify={verify}
          disabled={!ready || !view.setupComplete}
          onSelect={(b) => choose(b.selection)}
          onInitialSettled={onInitialCatalog}
        />
      )}
      {view.history.length > 0 && (
        <details>
          <summary>Earlier approved stories</summary>
          {view.history.map((p) => (
            <p key={p.planId}>
              {p.items[0].title} ·{' '}
              {p.installationId !== me.installationId
                ? 'Historical learning'
                : p.available
                  ? 'Available'
                  : p.reason || 'Unavailable'}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
/** Explicit known-corpus entry; discovery belongs to the shell’s later contract. */
export default function ParentCorpusPlan({
  me,
  corpusVersion,
  childId: controlledChildId,
  onInitialCatalog,
}: {
  me: PilotMe;
  corpusVersion: string;
  childId?: string;
  onInitialCatalog?: (status: CorpusInitialLoadStatus) => void;
}) {
  const [selected, setSelected] = useState(me.children[0]?.id ?? '');
  const candidate = controlledChildId ?? selected;
  const childId = me.children.some((c) => c.id === candidate)
    ? candidate
    : controlledChildId === undefined
      ? (me.children[0]?.id ?? '')
      : '';
  if (me.user.role !== 'parent') return null;
  return (
    <section className={styles.corpus}>
      {controlledChildId === undefined && (
        <label>
          Child
          <select
            data-control="corpus-plan-child"
            value={childId}
            onChange={(e) => setSelected(e.target.value)}
          >
            {me.children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {childId ? (
        <ParentSession
          key={JSON.stringify([
            me.installationId,
            me.user.id,
            childId,
            corpusVersion,
          ])}
          me={me}
          childId={childId}
          corpusVersion={corpusVersion}
          onInitialCatalog={onInitialCatalog}
        />
      ) : (
        <p>No linked child is available.</p>
      )}
    </section>
  );
}
