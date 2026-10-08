'use client';
import type { PilotMe } from '@/lib/pilot-client';
import ParentCorpusPlan from './ParentCorpusPlan';
import CorpusHome from './CorpusHome';
import CorpusProgressPanel from './CorpusProgressPanel';
import type { CorpusInitialLoadStatus } from '@/lib/pilot-corpus-load-priority';
/** Mount only after the shell resolves an authorized known corpus; no discovery fallback. */
export default function KnownCorpusPanels({
  me,
  corpusVersion,
  childId,
  onActiveChange,
  backgroundReady = true,
  onInitialCatalog,
}: {
  me: PilotMe;
  corpusVersion: string;
  childId?: string;
  onActiveChange?: (active: boolean) => void;
  backgroundReady?: boolean;
  onInitialCatalog?: (status: CorpusInitialLoadStatus) => void;
}) {
  if (me.user.mustChangePassword) return null;
  if (me.user.role === 'child')
    return (
      <CorpusHome
        me={me}
        corpusVersion={corpusVersion}
        onActiveChange={onActiveChange}
      />
    );
  if (me.user.role === 'parent')
    return (
      <>
        <ParentCorpusPlan
          me={me}
          corpusVersion={corpusVersion}
          childId={childId}
          onInitialCatalog={onInitialCatalog}
        />
        {backgroundReady ? (
          <CorpusProgressPanel
            me={me}
            corpusVersion={corpusVersion}
            childId={childId}
          />
        ) : (
          <section aria-busy="true" data-role="corpus-progress-pending">
            <h2>Saved story learning</h2>
            <output>Loading the lesson choices before saved learning…</output>
          </section>
        )}
      </>
    );
  if (me.user.role === 'teacher')
    return (
      <CorpusProgressPanel
        me={me}
        corpusVersion={corpusVersion}
        childId={childId}
      />
    );
  return null;
}
