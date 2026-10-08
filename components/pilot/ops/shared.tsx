'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import {
  createPilotOpsClient,
  createOpsWrite,
  createOpsReadGuard,
  opsDate,
  type OpsWriteSnapshot,
} from '@/lib/pilot-ops-client';
import type { OpsReceipt } from '@/lib/pilot-ops-types';
import styles from './ops.module.css';
export { styles, opsDate };
export function useOpsApi(me: PilotMe) {
  const api = useMemo(() => createPilotOpsClient(me), [me]);
  useEffect(() => {
    api.activate();
    return () => api.lock();
  }, [api]);
  return api;
}
export function useOpsRead<T>(load: () => Promise<T>, active = true) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(active);
  const guard = useMemo(() => createOpsReadGuard(), []);
  const refresh = useCallback(async () => {
    const token = guard.begin();
    setLoading(true);
    setError('');
    try {
      const next = await load();
      if (guard.current(token)) setValue(next);
    } catch (e) {
      if (guard.current(token)) {
        setValue(null);
        setError(
          e instanceof Error ? e.message : 'This information could not load.',
        );
      }
    } finally {
      if (guard.current(token)) setLoading(false);
    }
  }, [load, guard]);
  const accept = useCallback(
    (next: T) => {
      const token = guard.capture();
      if (guard.current(token)) {
        guard.begin();
        setValue(next);
        setLoading(false);
        setError('');
      }
    },
    [guard],
  );
  const clear = useCallback(
    (message: string) => {
      const token = guard.capture();
      if (guard.current(token)) {
        guard.begin();
        setValue(null);
        setLoading(false);
        setError(message);
      }
    },
    [guard],
  );
  const fail = useCallback(
    (message: string) => {
      if (guard.current(guard.capture())) {
        guard.begin();
        setLoading(false);
        setError(message);
      }
    },
    [guard],
  );
  useEffect(() => {
    guard.activate();
    const token = guard.capture();
    queueMicrotask(() => {
      if (active && guard.current(token)) void refresh();
    });
    return () => guard.lock();
  }, [guard, refresh, active]);
  return { value, error, loading, refresh, accept, clear, fail };
}
export function useOpsWrite<B, T>(
  send: (body: B) => Promise<OpsReceipt>,
  read: (receipt: OpsReceipt | null) => Promise<T>,
) {
  const [snapshot, setSnapshot] = useState<OpsWriteSnapshot<T>>({
    state: 'idle',
    receipt: null,
    readback: null,
    error: '',
    code: '',
  });
  const [controller] = useState(() =>
    createOpsWrite<B, T>({ send, read, onChange: setSnapshot }),
  );
  useEffect(() => {
    controller.configure(send, read);
  }, [controller, send, read]);
  useEffect(() => {
    controller.activate();
    return () => controller.lock();
  }, [controller]);
  return { controller, snapshot };
}
export function WriteStatus<T>({
  write,
}: {
  write: {
    controller: { retry: () => Promise<void>; reset: () => void };
    snapshot: OpsWriteSnapshot<T>;
  };
}) {
  const { snapshot: s, controller } = write;
  return (
    <div data-ops-write-state={s.state} aria-live="polite">
      {s.error && (
        <p role="alert" className={styles.error}>
          {s.error}
        </p>
      )}
      {s.state === 'saving' && <p>Saving…</p>}
      {s.state === 'saved' && (
        <p>
          Saved. Acknowledgement {s.receipt?.recordId}, revision{' '}
          {s.receipt?.revision}.
        </p>
      )}
      {s.state === 'readback-pending' && (
        <p>The change is saved. Updated information has not loaded yet.</p>
      )}
      {s.state === 'retry' && (
        <button
          data-control="write-retry"
          type="button"
          onClick={() => void controller.retry()}
        >
          Retry this save
        </button>
      )}
      {s.state === 'readback-pending' && (
        <button
          data-control="readback-retry"
          type="button"
          onClick={() => void controller.retry()}
        >
          Retry saved information
        </button>
      )}
      {s.state === 'conflict' && (
        <>
          <p>
            Your draft has been kept. Refresh the saved record before starting a
            new change.
          </p>
          <button
            data-control="conflict-refresh"
            type="button"
            onClick={() => void controller.retry()}
          >
            Refresh saved record
          </button>
          {s.readback !== null && (
            <button
              data-control="conflict-new"
              type="button"
              onClick={() => controller.reset()}
            >
              Review a new change
            </button>
          )}
        </>
      )}
    </div>
  );
}
