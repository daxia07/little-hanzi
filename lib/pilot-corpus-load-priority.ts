export type CorpusInitialLoadStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'stale'
  | 'unavailable'
  | 'locked';
export function createCorpusLoadPriority(scope = 'initial') {
  if (typeof scope !== 'string' || !scope)
    throw new Error('CORPUS_LOAD_SCOPE_INVALID');
  let state: 'entry' | 'catalog' | 'released' | 'locked' = 'entry';
  let alive = true;
  const listeners = new Set<() => void>();
  const change = (next: typeof state) => {
    if (!alive || state === 'locked' || state === 'released' || next === state)
      return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    activate: () => {
      alive = true;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    entry: (status: CorpusInitialLoadStatus, selected: boolean) => {
      if (!alive) return;
      if (status === 'locked') {
        state = 'locked';
        for (const listener of listeners) listener();
        return;
      }
      if (state !== 'entry') return;
      if (status === 'ready') change(selected ? 'catalog' : 'released');
      else if (
        status === 'error' ||
        status === 'stale' ||
        status === 'unavailable'
      )
        change('released');
    },
    catalog: (status: CorpusInitialLoadStatus) => {
      if (!alive) return;
      if (status === 'locked') {
        state = 'locked';
        for (const listener of listeners) listener();
        return;
      }
      if (state !== 'catalog') return;
      if (
        status === 'ready' ||
        status === 'error' ||
        status === 'stale' ||
        status === 'unavailable'
      )
        change('released');
    },
    lock: () => {
      if (!alive || state === 'locked') return;
      state = 'locked';
      for (const listener of listeners) listener();
    },
    destroy: () => {
      alive = false;
      listeners.clear();
    },
  };
}
