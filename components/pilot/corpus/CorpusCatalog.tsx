'use client';
import { useEffect, useRef, useState } from 'react';
import {
  createCorpusCatalog,
  type CorpusCatalogScope,
  type CorpusCatalogSnapshot,
} from '@/lib/pilot-corpus-client';
import type { CorpusProposalInput } from '@/lib/curriculum/corpus-types';
import { registerPilotStoryController } from '@/lib/pilot-story-client';
import styles from './corpus.module.css';
import type { CorpusInitialLoadStatus } from '@/lib/pilot-corpus-load-priority';
const EMPTY: CorpusCatalogSnapshot = {
  status: 'idle',
  page: null,
  query: '',
  limit: 20,
  previous: false,
  notice: '',
  selected: null,
};
/** Standalone catalog foundation. The shell owns linked-child identity and proposal CAS. */
function CatalogSession({
  scope,
  verify,
  onSelect,
  disabled = false,
  onInitialSettled,
}: {
  disabled?: boolean;
  onInitialSettled?: (status: CorpusInitialLoadStatus) => void;
  scope: CorpusCatalogScope;
  verify: (scope: CorpusCatalogScope) => Promise<boolean>;
  onSelect: (
    input: Pick<CorpusProposalInput, 'corpusVersion' | 'selection'>,
  ) => void;
}) {
  const [view, setView] = useState(EMPTY),
    [query, setQuery] = useState(''),
    [limit, setLimit] = useState<20 | 50>(20);
  const controller = useRef<ReturnType<typeof createCorpusCatalog> | null>(
    null,
  );
  useEffect(() => {
    if (
      view.status !== 'idle' &&
      view.status !== 'loading' &&
      (view.status !== 'ready' || !disabled)
    )
      onInitialSettled?.(view.status);
  }, [view.status, disabled, onInitialSettled]);
  useEffect(() => {
    let alive = true;
    const c = createCorpusCatalog({
      scope,
      verify,
      onChange: (s) => {
        if (alive) setView(s);
      },
    });
    controller.current = c;
    const unregister = registerPilotStoryController(() => {
      c.lock();
      setQuery('');
    });
    void c.load();
    return () => {
      alive = false;
      unregister();
      c.destroy();
      controller.current = null;
    };
  }, [scope, verify]);
  return (
    <section
      className={styles.corpus}
      data-role="corpus-catalog"
      data-catalog-state={view.status}
      data-release-revision={view.page?.releaseRevision}
      data-corpus-version={scope.corpusVersion}
      aria-busy={view.status === 'loading'}
    >
      <h2>Choose a lesson</h2>
      <p>Search by English title, character or word.</p>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          void controller.current?.search(query, limit);
        }}
      >
        <label>
          Search lessons
          <input
            data-control="corpus-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={view.status === 'locked'}
          />
        </label>
        <label>
          Lessons per page
          <select
            data-control="corpus-page-size"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) as 20 | 50)}
          >
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </label>
        <button
          data-control="corpus-search-submit"
          disabled={view.status === 'loading' || view.status === 'locked'}
        >
          Search
        </button>
      </form>
      <output aria-live="polite" className={styles.status}>
        {view.status === 'loading'
          ? 'Loading lessons…'
          : view.notice ||
            (view.status === 'ready'
              ? `${view.page?.items.length ?? 0} lessons on this page`
              : '')}
      </output>
      {view.status === 'stale' && (
        <button
          data-control="corpus-first-page"
          onClick={() => void controller.current?.first()}
        >
          Load first page
        </button>
      )}
      {view.status === 'error' && (
        <button
          data-control="corpus-catalog-retry"
          onClick={() => void controller.current?.retry()}
        >
          Retry lesson list
        </button>
      )}
      {view.status === 'ready' &&
        view.page?.items.map((item) => (
          <article
            className={styles.surface}
            key={item.lessonVersion}
            data-lesson-version={item.lessonVersion}
            data-content-digest={item.contentDigest}
          >
            <h3>{item.title}</h3>
            <p className={styles.hanzi}>
              {item.targets.map((t) => t.hanzi).join(' · ')}
            </p>
            <p>
              {item.words.map((w) => `${w.text} · ${w.english}`).join('; ')}
            </p>
            <button
              data-control="corpus-select"
              disabled={disabled || !item.available || item.reasonCode !== null}
              onClick={() => {
                const selected = controller.current?.select(item.lessonVersion);
                if (selected) onSelect(selected);
              }}
            >
              Choose this lesson
            </button>
          </article>
        ))}
      <nav className={styles.row} aria-label="Lesson pages">
        <button
          data-control="corpus-previous-page"
          disabled={view.status !== 'ready' || !view.previous}
          onClick={() => void controller.current?.previous()}
        >
          Previous page
        </button>
        <button
          data-control="corpus-next-page"
          disabled={view.status !== 'ready' || !view.page?.nextCursor}
          onClick={() => void controller.current?.next()}
        >
          Next page
        </button>
      </nav>
    </section>
  );
}

export default function CorpusCatalog(
  props: Parameters<typeof CatalogSession>[0],
) {
  return (
    <CatalogSession
      key={JSON.stringify(
        Object.entries(props.scope).sort(([a], [b]) => a.localeCompare(b)),
      )}
      {...props}
    />
  );
}
