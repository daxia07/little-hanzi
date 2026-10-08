/** Protected owner DTO/controller. No curriculum package, policy or grading imports. */
import { inspectJson } from './curriculum/json.ts';
import { pilotRequest } from './pilot-client.ts';
import type {
  CorpusOwnerReviewResponse,
  CorpusOwnerItemResponse,
  CorpusScope,
  CorpusReceipt,
} from './curriculum/corpus-types.ts';
export class CorpusOwnerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'CorpusOwnerError';
    this.status = status;
    this.code = code;
  }
}
type Rule = ((v: unknown) => boolean) | { [key: string]: Rule };
const str =
  (max = 240) =>
  (v: unknown) =>
    typeof v === 'string' &&
    v.isWellFormed() &&
    v.length > 0 &&
    Array.from(v).length <= max &&
    v === v.trim();
const integer = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const bool = (v: unknown) => typeof v === 'boolean';
const values =
  (...v: unknown[]) =>
  (x: unknown) =>
    v.includes(x);
const digest = (v: unknown) =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const date = (v: unknown) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const nullable = (rule: Rule) => (v: unknown) => v === null || accepts(v, rule);
const list =
  (rule: Rule, max = 50, min = 0) =>
  (v: unknown) =>
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every((i) => accepts(i, rule));
function accepts(v: unknown, r: Rule): boolean {
  if (typeof r === 'function') return r(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    Object.keys(o).length === Object.keys(r).length &&
    Object.entries(r).every(
      ([k, rule]) => Object.hasOwn(o, k) && accepts(o[k], rule),
    )
  );
}
function decode<T>(value: unknown, rule: Rule): T {
  const r = inspectJson(value);
  if (
    r.errors.length ||
    new TextEncoder().encode(JSON.stringify(r.value)).length > 500_000 ||
    !accepts(r.value, rule)
  )
    throw new CorpusOwnerError(502, 'INVALID_OWNER_RESPONSE');
  return r.value as T;
}
const reason = values(
  'FIXTURE',
  'PLACEHOLDER',
  'UNVERIFIED_SOURCE',
  'MISSING_LICENSE',
  'ALIAS',
  'DUPLICATE_IDENTITY',
  'INCOMPLETE_WORD_CONTEXT',
  'UNREVIEWED_CONTENT',
  'UNREVIEWED_AUDIO',
  'MISSING_PROMPT',
  'MISSING_ASSET',
  'UNSUPPORTED_RENDERER',
  'INVALID_PROOF',
  'STALE_EVIDENCE',
  'HISTORICAL_INSTALLATION',
  'WITHDRAWN',
  'OWNER_DECISION_PENDING',
  'PACKAGE_INELIGIBLE',
);
const scopeRule = (v: unknown) =>
  accepts(v, { kind: values('starter') }) ||
  accepts(v, {
    kind: values('supervised-trial'),
    members: list({ parentId: str(120), childId: str(120) }, 1000, 1),
  });
const refs = list(str(120), 100);
const assetUrl = (v: unknown) =>
  typeof v === 'string' &&
  v.length <= 500 &&
  /^\/story\/[A-Za-z0-9_./-]+$/.test(v) &&
  !v.split('/').some((s) => s === '.' || s === '..');
const counts = {
  fixture: integer,
  machineValidDraft: integer,
  reviewedReady: integer,
  supervisedTrial: integer,
  prospectiveStarter: integer,
  committedStarter: integer,
};
export function normalizeCorpusOwnerReview(
  value: unknown,
  corpusVersion: string,
  snapshotId: string,
  limit = 20,
): CorpusOwnerReviewResponse {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new CorpusOwnerError(400, 'INVALID_QUERY');
  const r = decode<CorpusOwnerReviewResponse>(value, {
    schemaVersion: values('r6-owner-review-1'),
    snapshotId: str(120),
    corpusVersion: str(120),
    corpusDigest: digest,
    prospectiveDigest: digest,
    candidateId: str(120),
    sourceDigest: digest,
    artifactDigest: digest,
    dataAt: date,
    counts,
    permittedScopes: list(
      {
        scope: scopeRule,
        scopeDigest: digest,
        available: bool,
        reasonCode: nullable(reason),
      },
      102,
    ),
    items: list(
      {
        coverageIdentity: str(120),
        characterId: str(120),
        lessonVersion: str(120),
        contentDigest: digest,
        classification: values(
          'verification-fixture',
          'unverified-draft',
          'real-source-reviewed',
        ),
        eligible: bool,
        reasonCodes: list(reason, 20),
        evidenceRefs: refs,
      },
      limit,
    ),
    nextCursor: nullable(str(4096)),
  });
  if (
    r.corpusVersion !== corpusVersion ||
    r.snapshotId !== snapshotId ||
    new Set(r.permittedScopes.map((s) => s.scopeDigest)).size !==
      r.permittedScopes.length
  )
    throw new CorpusOwnerError(502, 'INVALID_OWNER_RESPONSE');
  return r;
}
export function normalizeCorpusOwnerItem(
  value: unknown,
  snapshotId: string,
  lessonVersion: string,
  contentDigest: string,
): CorpusOwnerItemResponse {
  const r = decode<CorpusOwnerItemResponse>(value, {
    schemaVersion: values('r6-owner-item-1'),
    snapshotId: str(120),
    lessonVersion: str(120),
    contentDigest: digest,
    title: str(120),
    targets: list(
      {
        characterId: str(120),
        hanzi: str(8),
        meanings: list(str(), 32, 1),
        readings: list({ pinyin: str(), audioText: str(120) }, 16, 1),
        words: list(
          {
            text: str(32),
            pinyin: str(),
            english: str(),
            context: { hanzi: str(), english: str() },
          },
          2,
          2,
        ),
        teaching: {
          instructionEnglish: str(),
          hintEnglish: str(),
          demonstrationEnglish: str(),
        },
      },
      2,
      2,
    ),
    readers: list(
      {
        title: str(120),
        instructionEnglish: str(),
        text: str(),
        english: str(),
      },
      4,
      4,
    ),
    prompts: list(
      {
        phases: list(values('initial', 'review-24h', 'review-7d'), 3, 1),
        stepId: values('familiarity', 'practice', 'check'),
        instructionEnglish: str(),
        promptEnglish: str(),
        audioText: str(120),
        expectedAnswerHanzi: str(8),
      },
      10,
      10,
    ),
    playback: {
      kind: values('local-device', 'recorded'),
      voices: list(
        { name: str(120), lang: str(32), localService: values(true) },
        8,
      ),
      assets: list(
        {
          assetId: str(120),
          url: nullable(assetUrl),
          digest: nullable(digest),
          transcript: str(120),
          reviewRef: str(120),
        },
        16,
        16,
      ),
    },
    imageRefs: list(
      { assetId: str(120), url: assetUrl, digest, licenseRef: str() },
      4,
    ),
    evidenceRefs: {
      source: refs,
      contentReview: refs,
      audioReview: refs,
      proof: refs,
      assetInventory: refs,
    },
  });
  if (
    r.snapshotId !== snapshotId ||
    r.lessonVersion !== lessonVersion ||
    r.contentDigest !== contentDigest ||
    r.prompts.some((p) => new Set(p.phases).size !== p.phases.length) ||
    r.playback.assets.some((a) =>
      r.playback.kind === 'recorded'
        ? a.url === null || a.digest === null
        : a.url !== null || a.digest !== null,
    )
  )
    throw new CorpusOwnerError(502, 'INVALID_OWNER_RESPONSE');
  return r;
}
export interface CorpusOwnerScope {
  accountId: string;
  installationId: string;
  role: 'parent' | 'operator';
  corpusVersion: string;
  snapshotId: string;
}
export interface CorpusOwnerDecision {
  requestId: string;
  snapshotId: string;
  corpusDigest: string;
  candidateId: string;
  sourceDigest: string;
  artifactDigest: string;
  scope: CorpusScope;
  decision: 'accepted' | 'rejected';
}
export interface CorpusOwnerSnapshot {
  status:
    | 'idle'
    | 'loading'
    | 'ready'
    | 'saving'
    | 'pending'
    | 'readback-pending'
    | 'saved'
    | 'conflict'
    | 'unavailable'
    | 'error'
    | 'locked';
  review: CorpusOwnerReviewResponse | null;
  detail: CorpusOwnerItemResponse | null;
  detailStatus: 'idle' | 'loading' | 'ready' | 'error';
  selectedScopeDigest: string | null;
  confirmation: 'accepted' | 'rejected' | null;
  pending: CorpusOwnerDecision | null;
  receipt: CorpusReceipt | null;
  previous: boolean;
  limit: 20 | 50;
  notice: string;
}
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
const binding = (r: CorpusOwnerReviewResponse) =>
  canonical({
    snapshotId: r.snapshotId,
    corpusVersion: r.corpusVersion,
    corpusDigest: r.corpusDigest,
    prospectiveDigest: r.prospectiveDigest,
    candidateId: r.candidateId,
    sourceDigest: r.sourceDigest,
    artifactDigest: r.artifactDigest,
    permittedScopes: r.permittedScopes,
  });
export function createCorpusOwnerReview({
  scope,
  verify,
  request = pilotRequest,
  onChange = () => {},
  id = () => crypto.randomUUID(),
}: {
  scope: CorpusOwnerScope;
  verify: (scope: CorpusOwnerScope) => Promise<boolean>;
  request?: typeof pilotRequest;
  onChange?: (s: CorpusOwnerSnapshot) => void;
  id?: () => string;
}) {
  const bound = Object.freeze(
    decode<CorpusOwnerScope>(scope, {
      accountId: str(120),
      installationId: str(240),
      role: values('parent', 'operator'),
      corpusVersion: str(120),
      snapshotId: str(120),
    }),
  );
  const root = `/api/pilot/corpora/${encodeURIComponent(bound.corpusVersion)}`;
  let state: CorpusOwnerSnapshot = {
    status: 'idle',
    review: null,
    detail: null,
    detailStatus: 'idle',
    selectedScopeDigest: null,
    confirmation: null,
    pending: null,
    receipt: null,
    previous: false,
    limit: 20,
    notice: '',
  };
  let dead = false,
    epoch = 0,
    itemEpoch = 0,
    busy = false,
    identity: string | null = null,
    cursor: string | null = null,
    history: Array<string | null> = [],
    attempted: { cursor: string | null; history: Array<string | null> } | null =
      null;
  const snapshot = () => ({
    ...state,
    pending: state.pending ? structuredClone(state.pending) : null,
    receipt: state.receipt ? { ...state.receipt } : null,
  });
  const emit = () => {
    if (!dead) onChange(snapshot());
  };
  function lock() {
    dead = true;
    epoch++;
    itemEpoch++;
    identity = null;
    attempted = null;
    cursor = null;
    history = [];
    state = {
      ...state,
      status: 'locked',
      review: null,
      detail: null,
      detailStatus: 'idle',
      selectedScopeDigest: null,
      confirmation: null,
      pending: null,
      receipt: null,
      previous: false,
      notice: 'Your account changed. Sign in again.',
    };
    onChange(snapshot());
  }
  function accessError(status: number | undefined) {
    if (status === 401) {
      lock();
      return true;
    }
    if (status === 403 || status === 404) {
      dead = true;
      epoch++;
      itemEpoch++;
      identity = null;
      attempted = null;
      cursor = null;
      history = [];
      state = {
        ...state,
        status: 'unavailable',
        review: null,
        detail: null,
        detailStatus: 'idle',
        selectedScopeDigest: null,
        confirmation: null,
        pending: null,
        receipt: null,
        previous: false,
        notice: 'This curriculum review is not available to this account.',
      };
      onChange(snapshot());
      return true;
    }
    return false;
  }
  async function allowed(token: number) {
    const ok = await verify(bound);
    if (dead || epoch !== token) return false;
    if (!ok) {
      lock();
      return false;
    }
    return true;
  }
  function conflict() {
    itemEpoch++;
    identity = null;
    attempted = null;
    history = [];
    cursor = null;
    state = {
      ...state,
      status: 'conflict',
      review: null,
      detail: null,
      detailStatus: 'idle',
      selectedScopeDigest: null,
      confirmation: null,
      pending: null,
      previous: false,
      notice: state.receipt
        ? 'Decision saved; this curriculum review changed. Reload the current review.'
        : 'This curriculum review changed. Reload the current review.',
    };
    emit();
  }
  function readError(error: unknown, saved = false) {
    const e = error as { status?: number; code?: string };
    if (accessError(e.status)) return;
    if (e.status === 409) {
      conflict();
      return;
    }
    state = {
      ...state,
      status: saved ? 'readback-pending' : 'error',
      review: null,
      detail: null,
      detailStatus: 'idle',
      confirmation: null,
      notice: saved
        ? 'Decision saved; refreshing failed. Retry refresh.'
        : 'The curriculum review could not load. Retry.',
    };
    emit();
  }
  async function read(
    target = attempted ?? { cursor, history },
    saved = false,
  ) {
    if (dead || state.pending || busy) return;
    const token = ++epoch;
    itemEpoch++;
    const transition = { cursor: target.cursor, history: [...target.history] };
    attempted = transition;
    state = {
      ...state,
      status: 'loading',
      review: null,
      detail: null,
      detailStatus: 'idle',
      notice: saved ? 'Decision saved; refreshing…' : '',
    };
    emit();
    try {
      if (!(await allowed(token))) return;
      const query = new URLSearchParams({
        snapshotId: bound.snapshotId,
        limit: String(state.limit),
      });
      if (transition.cursor) query.set('cursor', transition.cursor);
      const raw = await request(`${root}/owner-review?${query}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!(await allowed(token))) return;
      const r = normalizeCorpusOwnerReview(
        raw,
        bound.corpusVersion,
        bound.snapshotId,
        state.limit,
      );
      if (
        bound.role === 'parent' &&
        r.permittedScopes.some(
          (s) =>
            s.scope.kind === 'supervised-trial' &&
            s.scope.members.some((m) => m.parentId !== bound.accountId),
        )
      )
        throw new CorpusOwnerError(502, 'INVALID_OWNER_RESPONSE');
      const nextIdentity = binding(r);
      if (identity !== null && identity !== nextIdentity) {
        conflict();
        return;
      }
      identity = nextIdentity;
      cursor = transition.cursor;
      history = transition.history;
      attempted = null;
      state = {
        ...state,
        status: saved ? 'saved' : 'ready',
        review: r,
        previous: history.length > 0,
        notice: saved
          ? 'Decision saved. The operator publishes separately.'
          : '',
      };
      emit();
    } catch (e) {
      if (dead || epoch !== token) return;
      readError(e, saved);
    }
  }
  async function flush() {
    if (dead || busy || !state.pending) return;
    const token = epoch,
      body = structuredClone(state.pending);
    busy = true;
    state = {
      ...state,
      status: 'saving',
      confirmation: null,
      notice: 'Saving your decision…',
    };
    emit();
    try {
      if (!(await allowed(token))) return;
      const raw = await request(`${root}/owner-decisions`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body),
      });
      if (!(await allowed(token))) return;
      const receipt = decode<CorpusReceipt>(raw, {
        requestId: str(120),
        recordId: str(120),
        recordedAt: date,
      });
      if (receipt.requestId !== body.requestId)
        throw new CorpusOwnerError(502, 'INVALID_OWNER_RESPONSE');
      state = {
        ...state,
        pending: null,
        receipt,
        status: 'readback-pending',
        notice: 'Decision saved; refreshing…',
      };
      emit();
    } catch (e) {
      if (dead || epoch !== token) return;
      const error = e as { status?: number };
      if (accessError(error.status)) return;
      if (error.status === 409) {
        conflict();
        return;
      }
      state = {
        ...state,
        status: 'pending',
        notice: 'Saving is unconfirmed. Retry your original decision.',
      };
      emit();
    } finally {
      busy = false;
    }
    if (!dead && epoch === token && !state.pending && state.receipt)
      await read({ cursor: null, history: [] }, true);
  }
  return {
    snapshot,
    load: () => read(),
    lock,
    destroy() {
      dead = true;
      epoch++;
      itemEpoch++;
      state = {
        ...state,
        review: null,
        detail: null,
        pending: null,
        receipt: null,
        confirmation: null,
      };
    },
    async retry() {
      if (state.pending) return flush();
      if (state.status === 'readback-pending')
        return read({ cursor: null, history: [] }, true);
      if (state.status === 'error') return read();
    },
    reload() {
      if (dead || busy || state.pending) return;
      identity = null;
      attempted = null;
      cursor = null;
      history = [];
      state = {
        ...state,
        selectedScopeDigest: null,
        confirmation: null,
        previous: false,
      };
      return read({ cursor: null, history: [] }, !!state.receipt);
    },
    async pageSize(limit: 20 | 50) {
      if (state.status !== 'ready' || ![20, 50].includes(limit)) return;
      state = { ...state, limit, previous: false };
      cursor = null;
      history = [];
      attempted = null;
      await read({ cursor: null, history: [] });
    },
    async next() {
      if (state.status !== 'ready' || !state.review?.nextCursor) return;
      await read({
        cursor: state.review.nextCursor,
        history: [...history, cursor],
      });
    },
    async previous() {
      if (state.status !== 'ready' || !history.length) return;
      await read({
        cursor: history[history.length - 1],
        history: history.slice(0, -1),
      });
    },
    chooseScope(scopeDigest: string) {
      if (state.status !== 'ready') return false;
      const scope = state.review?.permittedScopes.find(
        (s) =>
          s.scopeDigest === scopeDigest && s.available && s.reasonCode === null,
      );
      if (!scope) return false;
      state = {
        ...state,
        selectedScopeDigest: scopeDigest,
        confirmation: null,
      };
      emit();
      return true;
    },
    prepare(decision: 'accepted' | 'rejected') {
      if (
        state.status !== 'ready' ||
        !state.selectedScopeDigest ||
        !['accepted', 'rejected'].includes(decision)
      )
        return false;
      state = { ...state, confirmation: decision };
      emit();
      return true;
    },
    cancel() {
      if (state.status === 'ready') {
        state = { ...state, confirmation: null };
        emit();
      }
    },
    async confirm() {
      if (
        state.status !== 'ready' ||
        !state.review ||
        !state.confirmation ||
        state.pending
      )
        return;
      const selected = state.review.permittedScopes.find(
        (s) =>
          s.scopeDigest === state.selectedScopeDigest &&
          s.available &&
          s.reasonCode === null,
      );
      if (!selected) return;
      const r = state.review;
      state = {
        ...state,
        pending: {
          requestId: id(),
          snapshotId: r.snapshotId,
          corpusDigest: r.corpusDigest,
          candidateId: r.candidateId,
          sourceDigest: r.sourceDigest,
          artifactDigest: r.artifactDigest,
          scope: structuredClone(selected.scope),
          decision: state.confirmation,
        },
      };
      await flush();
    },
    async openItem(lessonVersion: string, contentDigest: string) {
      if (state.status !== 'ready' && state.status !== 'saved') return;
      const member = state.review?.items.find(
        (i) =>
          i.lessonVersion === lessonVersion &&
          i.contentDigest === contentDigest,
      );
      if (!member) return;
      const token = epoch,
        itemToken = ++itemEpoch;
      state = { ...state, detail: null, detailStatus: 'loading' };
      emit();
      try {
        if (!(await allowed(token))) return;
        const raw = await request(
          `${root}/owner-review/items/${encodeURIComponent(lessonVersion)}?${new URLSearchParams({ snapshotId: bound.snapshotId })}`,
          { credentials: 'same-origin', cache: 'no-store' },
        );
        if (!(await allowed(token)) || itemToken !== itemEpoch) return;
        const detail = normalizeCorpusOwnerItem(
          raw,
          bound.snapshotId,
          member.lessonVersion,
          member.contentDigest,
        );
        state = { ...state, detail, detailStatus: 'ready' };
        emit();
      } catch (e) {
        if (dead || epoch !== token || itemToken !== itemEpoch) return;
        const error = e as { status?: number };
        if (accessError(error.status)) return;
        if (error.status === 409) {
          conflict();
          return;
        }
        state = {
          ...state,
          detail: null,
          detailStatus: 'error',
          notice: 'Curriculum detail could not load. Retry its review link.',
        };
        emit();
      }
    },
  };
}
