/** Browser-only entry1 DTOs and request lifecycle. No package/grader/policy imports. */
import { inspectJson } from './curriculum/json.ts';
import {
  pilotRequest,
  getPilotMe,
  hasPendingSignOut,
  type PilotMe,
} from './pilot-client.ts';
import type {
  CorpusFamilyEntryResponse,
  CorpusOwnerEntryResponse,
} from './curriculum/corpus-entry-types.ts';
export class CorpusEntryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.name = 'CorpusEntryError';
  }
}
export type EntryRule =
  | ((v: unknown) => boolean)
  | { [key: string]: EntryRule };
export const entryText =
  (max = 240) =>
  (v: unknown) =>
    typeof v === 'string' &&
    v.isWellFormed() &&
    v.trim() === v &&
    v.length > 0 &&
    Array.from(v).length <= max;
export const entryInteger = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const entryBool = (v: unknown) => typeof v === 'boolean';
export const entryEnum =
  (...values: unknown[]) =>
  (v: unknown) =>
    values.includes(v);
export const entryDigest = (v: unknown) =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export const entryDate = (v: unknown) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export const entryNullable = (r: EntryRule) => (v: unknown) =>
  v === null || entryAccepts(v, r);
export const entryList =
  (r: EntryRule, max = 50, min = 0) =>
  (v: unknown) =>
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every((x) => entryAccepts(x, r));
export function entryAccepts(v: unknown, r: EntryRule): boolean {
  if (typeof r === 'function') return r(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    Object.keys(o).sort().join(',') === Object.keys(r).sort().join(',') &&
    Object.entries(r).every(([k, rule]) => entryAccepts(o[k], rule))
  );
}
export function copyEntryJson(v: unknown, max = 2 * 1024 * 1024): unknown {
  const result = inspectJson(v);
  if (
    result.errors.length ||
    new TextEncoder().encode(JSON.stringify(result.value)).length > max
  )
    throw new CorpusEntryError(502, 'INVALID_RESPONSE');
  return result.value;
}
export function decodeEntry<T>(v: unknown, r: EntryRule): T {
  const copy = copyEntryJson(v);
  if (!entryAccepts(copy, r))
    throw new CorpusEntryError(502, 'INVALID_RESPONSE');
  return copy as T;
}
export const entryTargetRule = {
  characterId: entryText(120),
  hanzi: entryText(8),
};
export interface CorpusEntryScope {
  accountId: string;
  role: PilotMe['user']['role'];
  installationId: string;
  childId?: string;
}
export function normalizeCorpusFamilyEntry(
  v: unknown,
  scope: CorpusEntryScope,
  limit = 20,
): CorpusFamilyEntryResponse {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new CorpusEntryError(400, 'INVALID_REQUEST');
  const r = decodeEntry<CorpusFamilyEntryResponse>(v, {
    schemaVersion: entryEnum('r6-family-corpora-1'),
    childId: entryText(120),
    installationId: entryText(240),
    items: entryList(
      {
        corpusId: entryText(120),
        corpusVersion: entryText(120),
        corpusDigest: entryDigest,
        title: entryText(120),
        targets: entryList(entryTargetRule, 2, 2),
        available: entryBool,
        reasonCode: entryNullable(entryText(120)),
      },
      limit,
    ),
    nextCursor: entryNullable(entryText(4096)),
  });
  if (r.childId !== scope.childId || r.installationId !== scope.installationId)
    throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
  if (
    new Set(r.items.map((i) => i.corpusVersion)).size !== r.items.length ||
    r.items.some((i) => i.available && i.reasonCode !== null)
  )
    throw new CorpusEntryError(502, 'INVALID_RESPONSE');
  return r;
}
export function normalizeCorpusOwnerEntry(
  v: unknown,
  scope: CorpusEntryScope,
  limit = 20,
): CorpusOwnerEntryResponse {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new CorpusEntryError(400, 'INVALID_REQUEST');
  const r = decodeEntry<CorpusOwnerEntryResponse>(v, {
    schemaVersion: entryEnum('r6-owner-entry-1'),
    installationId: entryText(240),
    allowed: entryBool,
    items: entryList(
      {
        corpusId: entryText(120),
        corpusVersion: entryText(120),
        corpusDigest: entryDigest,
        snapshotId: entryText(120),
        planDigest: entryDigest,
        candidateId: entryText(120),
        buildId: entryText(120),
        createdAt: entryDate,
      },
      limit,
    ),
    nextCursor: entryNullable(entryText(4096)),
  });
  if (r.installationId !== scope.installationId)
    throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
  if (
    (!r.allowed && (r.items.length || r.nextCursor !== null)) ||
    new Set(r.items.map((i) => i.snapshotId)).size !== r.items.length
  )
    throw new CorpusEntryError(502, 'INVALID_RESPONSE');
  return r;
}
export function createCorpusEntryApi(
  me: PilotMe,
  {
    request = pilotRequest,
    verify = async (childId?: string) => {
      const current = await getPilotMe();
      return (
        !hasPendingSignOut() &&
        !current.user.mustChangePassword &&
        current.user.id === me.user.id &&
        current.user.role === me.user.role &&
        current.installationId === me.installationId &&
        (!childId ||
          (current.user.role === 'child'
            ? current.user.id === childId
            : current.children.some((c) => c.id === childId)))
      );
    },
  }: {
    request?: typeof pilotRequest;
    verify?: (childId?: string) => Promise<boolean>;
  } = {},
) {
  const scope = (childId?: string): CorpusEntryScope => ({
    accountId: me.user.id,
    role: me.user.role,
    installationId: me.installationId,
    ...(childId ? { childId } : {}),
  });
  async function call(path: string, childId?: string) {
    if (hasPendingSignOut() || !(await verify(childId)))
      throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
    const v = await request(path, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (hasPendingSignOut() || !(await verify(childId)))
      throw new CorpusEntryError(401, 'IDENTITY_CHANGED');
    return v;
  }
  function paging(cursor: string | null, limit: 20 | 50) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return '?' + q;
  }
  return {
    scope,
    verify,
    async family(
      childId: string,
      cursor: string | null = null,
      limit: 20 | 50 = 20,
    ) {
      if (me.user.role === 'operator')
        throw new CorpusEntryError(403, 'FORBIDDEN');
      return normalizeCorpusFamilyEntry(
        await call(
          `/api/pilot/children/${encodeURIComponent(childId)}/corpora${paging(cursor, limit)}`,
          childId,
        ),
        scope(childId),
        limit,
      );
    },
    async owner(cursor: string | null = null, limit: 20 | 50 = 20) {
      if (!['parent', 'operator'].includes(me.user.role))
        throw new CorpusEntryError(403, 'FORBIDDEN');
      return normalizeCorpusOwnerEntry(
        await call('/api/pilot/curriculum-review' + paging(cursor, limit)),
        scope(),
        limit,
      );
    },
  };
}
export interface CorpusEntryPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface CorpusEntryPageSnapshot<T, P extends CorpusEntryPage<T>> {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'stale' | 'locked';
  page: P | null;
  selected: T | null;
  previous: boolean;
  notice: string;
}
/** Scoped paging commits cursor/history only after a successful read. Default context is read-only. */
export function createCorpusEntryPager<T, P extends CorpusEntryPage<T>>({
  read,
  verify,
  keyOf,
  defaultFirst = false,
  onChange = () => {},
}: {
  read: (cursor: string | null) => Promise<P>;
  verify: () => Promise<boolean>;
  keyOf: (item: T) => string;
  defaultFirst?: boolean;
  onChange?: (s: CorpusEntryPageSnapshot<T, P>) => void;
}) {
  let state: CorpusEntryPageSnapshot<T, P> = {
      status: 'idle',
      page: null,
      selected: null,
      previous: false,
      notice: '',
    },
    cursor: string | null = null,
    history: Array<string | null> = [],
    dead = false,
    epoch = 0,
    attempt: { cursor: string | null; history: Array<string | null> } | null =
      null;
  const snapshot = () => ({ ...state });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    if (dead) return;
    dead = true;
    epoch++;
    cursor = null;
    history = [];
    attempt = null;
    state = {
      ...state,
      status: 'locked',
      page: null,
      selected: null,
      previous: false,
      notice: 'Your account or access changed. Sign in again.',
    };
    onChange(snapshot());
  }
  async function allowed(token: number) {
    const valid = await verify();
    if (dead || token !== epoch) return false;
    if (!valid) {
      lock();
      return false;
    }
    return true;
  }
  async function load(
    transition = attempt ?? { cursor, history: [...history] },
  ) {
    if (dead || state.status === 'stale') return;
    const token = ++epoch;
    attempt = { cursor: transition.cursor, history: [...transition.history] };
    state = { ...state, status: 'loading', page: null, notice: '' };
    emit();
    try {
      if (!(await allowed(token))) return;
      const page = await read(transition.cursor);
      if (!(await allowed(token))) return;
      cursor = transition.cursor;
      history = transition.history;
      attempt = null;
      state = {
        ...state,
        status: 'ready',
        page,
        previous: history.length > 0,
        selected:
          state.selected ?? (defaultFirst ? (page.items[0] ?? null) : null),
        notice: page.items.length
          ? ''
          : page.nextCursor
            ? 'No lessons on this page. Continue to the next page.'
            : 'No available entries.',
      };
      emit();
    } catch (error) {
      if (dead || token !== epoch) return;
      const e = error as { status?: number; code?: string };
      if ([401, 403, 404].includes(e.status ?? 0)) {
        lock();
        return;
      }
      if (e.code === 'CURSOR_STALE') {
        cursor = null;
        history = [];
        attempt = null;
        state = {
          ...state,
          status: 'stale',
          page: null,
          selected: null,
          previous: false,
          notice: 'This list changed. Load the first page.',
        };
      } else
        state = {
          ...state,
          status: 'error',
          page: null,
          previous: history.length > 0,
          notice: 'The list could not load. Retry.',
        };
      emit();
    }
  }
  return {
    snapshot,
    load: () => load(),
    retry: () => (state.status === 'error' ? load() : Promise.resolve()),
    lock,
    destroy() {
      dead = true;
      epoch++;
      attempt = null;
      state = { ...state, page: null, selected: null };
    },
    next: async () => {
      if (dead || state.status !== 'ready' || !state.page?.nextCursor) return;
      await load({
        cursor: state.page.nextCursor,
        history: [...history, cursor],
      });
    },
    previous: async () => {
      if (dead || state.status !== 'ready' || !history.length) return;
      await load({
        cursor: history[history.length - 1],
        history: history.slice(0, -1),
      });
    },
    first() {
      if (dead) return Promise.resolve();
      cursor = null;
      history = [];
      attempt = null;
      state = { ...state, status: 'idle', selected: null, previous: false };
      return load({ cursor: null, history: [] });
    },
    select(key: string) {
      if (dead || state.status !== 'ready') return;
      const selected = state.page?.items.find((i) => keyOf(i) === key);
      if (selected) {
        state = { ...state, selected };
        emit();
      }
    },
  };
}
