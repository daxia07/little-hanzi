'use client';
import { useEffect, useRef, useState } from 'react';
import {
  createCorpusEntryPager,
  type CorpusEntryPage,
  type CorpusEntryPageSnapshot,
} from '@/lib/pilot-corpus-entry-client';
import { registerPilotStoryController } from '@/lib/pilot-story-client';
export function useCorpusEntryPage<T, P extends CorpusEntryPage<T>>(
  read: (cursor: string | null) => Promise<P>,
  verify: () => Promise<boolean>,
  keyOf: (item: T) => string,
  defaultFirst = false,
) {
  const [view, setView] = useState<CorpusEntryPageSnapshot<T, P>>({
    status: 'idle',
    page: null,
    selected: null,
    previous: false,
    notice: '',
  });
  const controller = useRef<ReturnType<
    typeof createCorpusEntryPager<T, P>
  > | null>(null);
  useEffect(() => {
    let alive = true;
    const c = createCorpusEntryPager<T, P>({
      read,
      verify,
      keyOf,
      defaultFirst,
      onChange: (s) => {
        if (alive) setView(s);
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
  }, [read, verify, keyOf, defaultFirst]);
  return { view, controller };
}
export function EntryPaging({
  view,
  controller,
  prefix,
  disabled = false,
}: {
  view: {
    status: string;
    notice: string;
    previous: boolean;
    page: { nextCursor: string | null } | null;
  };
  controller: {
    current: {
      previous: () => Promise<void>;
      next: () => Promise<void>;
      first: () => Promise<void>;
      retry: () => Promise<void>;
    } | null;
  };
  prefix: string;
  disabled?: boolean;
}) {
  return (
    <>
      <output aria-live="polite">
        {view.status === 'idle' || view.status === 'loading'
          ? 'Loading available curriculum…'
          : view.notice}
      </output>
      <div>
        {view.previous && (
          <button
            data-control={`${prefix}-previous`}
            disabled={disabled || view.status !== 'ready'}
            onClick={() => void controller.current?.previous()}
          >
            Previous page
          </button>
        )}
        {view.page?.nextCursor && (
          <button
            data-control={`${prefix}-next`}
            disabled={disabled || view.status !== 'ready'}
            onClick={() => void controller.current?.next()}
          >
            Next page
          </button>
        )}
        {view.status === 'error' && (
          <button
            data-control={`${prefix}-retry`}
            disabled={disabled}
            onClick={() => void controller.current?.retry()}
          >
            Retry loading
          </button>
        )}
        {view.status === 'stale' && (
          <button
            data-control={`${prefix}-first`}
            disabled={disabled}
            onClick={() => void controller.current?.first()}
          >
            Load first page
          </button>
        )}
      </div>
    </>
  );
}
