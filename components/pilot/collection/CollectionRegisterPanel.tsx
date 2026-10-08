'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import { createCollectionClient } from '@/lib/pilot-collection-client';
import {
  createScopeGuard,
  registerPilotStoryController,
  localStoryDate,
} from '@/lib/pilot-story-client';
import styles from './collection.module.css';
type Item = {
  collectionId: string;
  collectionVersion: string;
  collectionDigest: string;
  trackId: string;
  lessonCount: number;
  importedAt: string;
};
export default function CollectionRegisterPanel({ me }: { me: PilotMe }) {
  const api = useMemo(() => createCollectionClient(me), [me]),
    guard = useMemo(
      () => createScopeGuard(`${me.installationId}:${me.user.id}`),
      [me.installationId, me.user.id],
    );
  const [items, setItems] = useState<Item[]>([]),
    [draft, setDraft] = useState(''),
    [error, setError] = useState(''),
    [status, setStatus] = useState('loading');
  const pending = useRef<{ body: unknown; ack: boolean } | null>(null);
  const read = useCallback(
    async function read(token: ReturnType<typeof guard.begin>) {
      const v = await api.collections();
      if (!guard.current(token)) return;
      setItems(v.items);
      pending.current = null;
      setStatus('saved');
    },
    [api, guard],
  );
  const refresh = useCallback(
    async function refresh() {
      const token = guard.begin();
      setError('');
      setStatus('loading');
      try {
        await read(token);
      } catch (e) {
        if (guard.current(token)) {
          setStatus(pending.current?.ack ? 'readback-pending' : 'error');
          setError(
            e instanceof Error
              ? e.message
              : 'Collection metadata could not load.',
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
      setDraft('');
      setStatus('locked');
    });
    return () => {
      guard.destroy();
      pending.current = null;
      unregister();
    };
  }, [guard, refresh]);
  async function save(retry = false) {
    const token = guard.begin();
    setError('');
    if (!retry) {
      try {
        if (draft.length > 250_000)
          throw new Error('The collection document is too large.');
        pending.current = { body: JSON.parse(draft), ack: false };
      } catch {
        setStatus('error');
        setError(
          'Choose a valid collection JSON document. Your input is preserved.',
        );
        return;
      }
    }
    const p = pending.current;
    if (!p) return;
    setStatus('saving');
    try {
      if (!p.ack) {
        await api.register(p.body);
        if (!guard.current(token)) return;
        p.ack = true;
      }
      await read(token);
    } catch (e) {
      if (!guard.current(token)) return;
      const code = (e as { status?: number }).status;
      setStatus(
        p.ack
          ? 'readback-pending'
          : code === 409
            ? 'conflict'
            : code === 400
              ? 'error'
              : [401, 403, 404].includes(code ?? 0)
                ? 'locked'
                : 'pending',
      );
      if ([401, 403, 404].includes(code ?? 0)) {
        setItems([]);
        setDraft('');
        pending.current = null;
      }
      setError(
        e instanceof Error
          ? e.message
          : 'Import is unconfirmed. Retry the same document.',
      );
    }
  }
  return (
    <section
      className={styles.collection}
      data-role="collection-register"
      data-save-state={status}
    >
      <h2>Collection metadata</h2>
      <p>
        Register exact ordered package versions and digests. This does not
        review or publish teaching content.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <output className={styles.status}>
        {status === 'saved'
          ? 'Saved metadata loaded'
          : status === 'pending'
            ? 'Import unconfirmed'
            : status === 'readback-pending'
              ? 'Saved; refreshing'
              : status === 'conflict'
                ? 'Immutable version conflicts'
                : status === 'saving'
                  ? 'Saving…'
                  : status === 'loading'
                    ? 'Loading metadata…'
                    : status === 'locked'
                      ? 'Sign in again'
                      : 'Check the collection document'}
      </output>
      <label>
        Collection JSON
        <textarea
          data-control="collection-register-document"
          value={draft}
          disabled={[
            'pending',
            'readback-pending',
            'saving',
            'loading',
            'locked',
          ].includes(status)}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className={styles.row}>
        <button
          data-control="collection-register"
          disabled={
            [
              'pending',
              'readback-pending',
              'saving',
              'loading',
              'locked',
            ].includes(status) || !draft.trim()
          }
          onClick={() => void save()}
        >
          Register collection
        </button>
        {status === 'pending' && (
          <button
            data-control="collection-retry"
            onClick={() => void save(true)}
          >
            Retry the same import
          </button>
        )}
        <button
          data-control="collection-register-refresh"
          disabled={['pending', 'saving', 'locked'].includes(status)}
          onClick={() => void refresh()}
        >
          {status === 'readback-pending' ? 'Retry refresh' : 'Refresh metadata'}
        </button>
      </div>
      {items.map((i) => (
        <section key={i.collectionVersion} className={styles.surface}>
          <h3>{i.collectionVersion}</h3>
          <p>
            {i.lessonCount} package references · registered{' '}
            {localStoryDate(i.importedAt)}
          </p>
          <p>{i.collectionDigest}</p>
          <p>
            Each package still needs its own exact review, trusted renderer
            proof and owner-scoped release.
          </p>
        </section>
      ))}
    </section>
  );
}
