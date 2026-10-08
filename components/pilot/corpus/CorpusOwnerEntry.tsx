'use client';
import { useCallback, useMemo } from 'react';
import type { PilotMe } from '@/lib/pilot-client';
import { createCorpusEntryApi } from '@/lib/pilot-corpus-entry-client';
import type { CorpusOwnerEntryResponse } from '@/lib/curriculum/corpus-entry-types';
import { useCorpusEntryPage, EntryPaging } from './CorpusEntryPager';
import CorpusOwnerReview from './CorpusOwnerReview';
import styles from './corpus.module.css';
type Item = CorpusOwnerEntryResponse['items'][number];
const keyOf = (i: Item) => i.snapshotId;
export default function CorpusOwnerEntry({ me }: { me: PilotMe }) {
  const api = useMemo(() => createCorpusEntryApi(me), [me]);
  const read = useCallback((cursor: string | null) => api.owner(cursor), [api]);
  const verify = useCallback(() => api.verify(), [api]);
  const { view, controller } = useCorpusEntryPage<
    Item,
    CorpusOwnerEntryResponse
  >(read, verify, keyOf);
  if (view.page?.allowed === false) return null;
  if (!['parent', 'operator'].includes(me.user.role)) return null;
  const selected =
    view.status === 'locked' || view.status === 'stale' ? null : view.selected;
  return (
    <section
      className={styles.corpus}
      data-role="corpus-owner-entry"
      data-entry-state={view.status}
    >
      {view.page?.allowed && <h2>Curriculum review</h2>}
      <EntryPaging view={view} controller={controller} prefix="owner-entry" />
      {view.page?.allowed && (
        <>
          <p>
            Choose a prepared curriculum to review its material and exact scope.
            This list does not record acceptance.
          </p>
          <label>
            Prepared curriculum
            <select
              data-control="owner-entry-select"
              value={
                view.page.items.some(
                  (i) => i.snapshotId === selected?.snapshotId,
                )
                  ? selected?.snapshotId
                  : ''
              }
              onChange={(e) => controller.current?.select(e.target.value)}
            >
              <option value="" disabled>
                Choose a prepared curriculum
              </option>
              {view.page.items.map((i) => (
                <option key={i.snapshotId} value={i.snapshotId}>
                  {i.corpusId} · {new Date(i.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {selected &&
        (me.user.role === 'parent' || me.user.role === 'operator') && (
          <CorpusOwnerReview
            key={selected.snapshotId}
            scope={{
              accountId: me.user.id,
              installationId: me.installationId,
              role: me.user.role,
              corpusVersion: selected.corpusVersion,
              snapshotId: selected.snapshotId,
            }}
            verify={verify}
            scopeLabel={(scope) =>
              scope.kind === 'starter'
                ? 'Starter curriculum'
                : `Supervised trial · ${scope.members.map((m) => me.children.find((c) => c.id === m.childId)?.name ?? 'Linked child').join(', ')}`
            }
          />
        )}
    </section>
  );
}
