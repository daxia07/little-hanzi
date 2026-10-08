'use client';
import { useCallback, useMemo, useEffect, useState } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import { createCorpusEntryApi } from '@/lib/pilot-corpus-entry-client';
import type { CorpusFamilyEntryResponse } from '@/lib/curriculum/corpus-entry-types';
import { useCorpusEntryPage, EntryPaging } from './CorpusEntryPager';
import KnownCorpusPanels from './KnownCorpusPanels';
import styles from './corpus.module.css';
import type { CorpusInitialLoadStatus } from '@/lib/pilot-corpus-load-priority';
type Item = CorpusFamilyEntryResponse['items'][number];
const keyOf = (i: Item) => i.corpusVersion;
export default function FamilyCorpusEntry({
  me,
  childId,
  onActiveChange,
  onContextChange,
  active = true,
  backgroundReady = true,
  onInitialEntry,
  onInitialCatalog,
}: {
  me: PilotMe;
  childId: string;
  onActiveChange?: (active: boolean) => void;
  onContextChange?: (available: boolean) => void;
  active?: boolean;
  backgroundReady?: boolean;
  onInitialEntry?: (status: CorpusInitialLoadStatus, selected: boolean) => void;
  onInitialCatalog?: (status: CorpusInitialLoadStatus) => void;
}) {
  const [running, setRunning] = useState(false);
  const api = useMemo(() => createCorpusEntryApi(me), [me]);
  const read = useCallback(
    (cursor: string | null) => api.family(childId, cursor),
    [api, childId],
  );
  const verify = useCallback(() => api.verify(childId), [api, childId]);
  const { view, controller } = useCorpusEntryPage<
    Item,
    CorpusFamilyEntryResponse
  >(read, verify, keyOf, true);
  useEffect(() => {
    onInitialEntry?.(view.status, view.selected !== null);
  }, [view.status, view.selected, onInitialEntry]);
  useEffect(() => {
    if (
      view.status === 'ready' ||
      view.status === 'locked' ||
      view.status === 'stale'
    )
      onContextChange?.(view.selected !== null);
  }, [view.selected, view.status, onContextChange]);
  const activeChange = useCallback(
    (active: boolean) => {
      setRunning(active);
      onActiveChange?.(active);
    },
    [onActiveChange],
  );
  const selected =
    view.status === 'locked' || view.status === 'stale' ? null : view.selected;
  return (
    <section
      className={styles.corpus}
      data-role="corpus-family-entry"
      data-entry-state={view.status}
      data-child-id={childId}
    >
      <div hidden={running}>
        <h2>
          {me.user.role === 'child' ? 'Your stories' : 'Story curriculum'}
        </h2>
        <EntryPaging
          view={view}
          controller={controller}
          prefix="corpus-entry"
        />
        {view.page && view.page.items.length > 0 && (
          <label>
            Curriculum
            <select
              data-control="corpus-entry-select"
              value={
                view.page.items.some(
                  (i) => i.corpusVersion === selected?.corpusVersion,
                )
                  ? selected?.corpusVersion
                  : ''
              }
              onChange={(e) => controller.current?.select(e.target.value)}
            >
              <option value="" disabled>
                Choose curriculum
              </option>
              {view.page.items.map((i) => (
                <option key={i.corpusVersion} value={i.corpusVersion}>
                  {i.title} · {i.targets.map((t) => t.hanzi).join(' ')}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {active && selected && (
        <>
          <p hidden={running}>
            {selected.title}
            {!selected.available
              ? ' · Historical learning or currently unavailable'
              : ''}
          </p>
          <KnownCorpusPanels
            key={JSON.stringify([
              me.user.id,
              me.installationId,
              childId,
              selected.corpusVersion,
            ])}
            me={me}
            childId={childId}
            corpusVersion={selected.corpusVersion}
            onActiveChange={activeChange}
            backgroundReady={backgroundReady}
            onInitialCatalog={onInitialCatalog}
          />
        </>
      )}
    </section>
  );
}
