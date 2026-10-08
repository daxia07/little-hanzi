'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import { createCorpusFamilyClient } from '@/lib/pilot-corpus-client';
import type { CorpusProgress } from '@/lib/curriculum/corpus-types';
import {
  createScopeGuard,
  localStoryDate,
  registerPilotStoryController,
} from '@/lib/pilot-story-client';
import { CorpusCounts } from './CorpusStory';
import styles from './corpus.module.css';
function ProgressSession({
  me,
  childId,
  corpusVersion,
}: {
  me: PilotMe;
  childId: string;
  corpusVersion: string;
}) {
  const api = useMemo(
    () => createCorpusFamilyClient(me, corpusVersion),
    [me, corpusVersion],
  );
  const [groups, setGroups] = useState<CorpusProgress[]>([]),
    [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'locked'>(
      'loading',
    ),
    [exporting, setExporting] = useState(false),
    [notice, setNotice] = useState('');
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
    setGroups([]);
    setStatus('loading');
    try {
      const data = await api.progress(childId);
      if (!guard.current(token)) return;
      setGroups(data);
      setStatus('ready');
    } catch (e) {
      if (!guard.current(token)) return;
      const denied = [401, 403, 404].includes(
        (e as { status?: number }).status ?? 0,
      );
      if (denied) guard.destroy();
      setStatus(denied ? 'locked' : 'error');
    }
  }, [api, childId, guard]);
  useEffect(() => {
    guard.activate();
    const unregister = registerPilotStoryController(() => {
      guard.destroy();
      setGroups([]);
      setStatus('locked');
      setNotice('');
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
  const download = async () => {
    if (
      me.user.role !== 'parent' ||
      exporting ||
      !guard.current(guard.capture()) ||
      status !== 'ready'
    )
      return;
    const token = guard.capture();
    setExporting(true);
    setNotice('');
    try {
      const data = await api.export(childId);
      if (!guard.current(token)) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'saved-learning.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (guard.current(token)) {
        if ([401, 403, 404].includes((e as { status?: number }).status ?? 0)) {
          guard.destroy();
          setGroups([]);
          setStatus('locked');
        } else setNotice('Export could not load. Retry export.');
      }
    } finally {
      if (guard.current(token)) setExporting(false);
    }
  };
  return (
    <section
      className={styles.corpus}
      data-role="corpus-progress"
      data-progress-state={status}
      data-corpus-version={corpusVersion}
      aria-busy={status === 'loading'}
    >
      <h2>Saved story learning</h2>
      <output className={styles.status} aria-live="polite">
        {status === 'loading'
          ? 'Loading saved learning…'
          : status === 'error'
            ? 'Saved learning could not load. Retry.'
            : status === 'locked'
              ? 'Your account or access changed. Sign in again.'
              : groups.length
                ? 'Saved learning loaded.'
                : 'No saved story learning yet.'}
      </output>
      {notice && <output aria-live="polite">{notice}</output>}
      {status === 'error' && (
        <button
          data-control="corpus-progress-retry"
          onClick={() => void load()}
        >
          Retry saved learning
        </button>
      )}
      {status === 'ready' && me.user.role === 'parent' && (
        <button
          data-control="corpus-progress-export"
          disabled={exporting}
          onClick={() => void download()}
        >
          {exporting ? 'Loading export…' : 'Export saved learning'}
        </button>
      )}
      {groups.map((g) => (
        <article
          className={styles.surface}
          key={JSON.stringify([g.corpusVersion, g.installationId])}
          data-original-installation={g.installationId}
        >
          {g.installationId !== me.installationId && (
            <p>
              Historical learning from an earlier installation. It does not
              grant current story access.
            </p>
          )}
          {g.visits.map((v) => (
            <section
              className={styles.surface}
              key={v.scheduleId}
              data-run-id={v.runId ?? undefined}
              data-phase={v.phase}
            >
              <h3>{v.title}</h3>
              <p>
                {v.phase === 'initial'
                  ? 'First story'
                  : v.phase === 'review-24h'
                    ? 'Next-day review'
                    : 'One-week review'}{' '}
                ·{' '}
                {v.completedAt
                  ? `Saved ${localStoryDate(v.completedAt)}`
                  : `Review time ${localStoryDate(v.dueAt)}`}
              </p>
              {v.recap ? (
                <>
                  {v.recap.completedAt && <p>Story completed</p>}
                  {(['familiarity', 'practice', 'check'] as const).map(
                    (name) => (
                      <CorpusCounts
                        key={name}
                        name={name}
                        group={v.recap![name]}
                      />
                    ),
                  )}
                </>
              ) : (
                <p>No saved completion recap yet.</p>
              )}
            </section>
          ))}
          {g.evidenceLimits.map((limit, i) => (
            <p className={styles.muted} key={i}>
              {limit}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}
export default function CorpusProgressPanel({
  me,
  corpusVersion,
  childId: controlledChildId,
}: {
  me: PilotMe;
  corpusVersion: string;
  childId?: string;
}) {
  const [selected, setSelected] = useState(me.children[0]?.id ?? '');
  const candidate = controlledChildId ?? selected;
  const childId = me.children.some((c) => c.id === candidate)
    ? candidate
    : controlledChildId === undefined
      ? (me.children[0]?.id ?? '')
      : '';
  if (!['parent', 'teacher'].includes(me.user.role)) return null;
  return (
    <section className={styles.corpus}>
      {controlledChildId === undefined && (
        <label>
          Child
          <select
            data-control="corpus-progress-child"
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
        <ProgressSession
          key={JSON.stringify([
            me.installationId,
            me.user.id,
            me.user.role,
            childId,
            corpusVersion,
          ])}
          me={me}
          childId={childId}
          corpusVersion={corpusVersion}
        />
      ) : (
        <p>No authorized child is available.</p>
      )}
    </section>
  );
}
