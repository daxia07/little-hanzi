import {
  getPilotMe,
  pilotRequest,
  PilotApiError,
  type PilotMe,
} from './pilot-client.ts';
import {
  isCurriculumReviewInput,
  type CurriculumReviewInput,
} from './curriculum/review.ts';
import { parseCurriculumDisplayDocument } from './curriculum/display-document.ts';

export const REVIEW_CHECKLIST = [
  { key: 'scriptAndGlyphs', label: 'Script and glyphs' },
  { key: 'mandarinAndReadings', label: 'Mandarin and readings' },
  { key: 'wordContexts', label: 'Words and contexts' },
  { key: 'teachingAndChecks', label: 'Teaching and recognition checks' },
  { key: 'ageSuitability', label: 'Age suitability' },
  { key: 'sourcesAndLicenses', label: 'Sources and licences' },
  { key: 'deviceAudio', label: 'Device audio' },
] as const;
export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST)[number]['key'];
export type ReviewChecklist = Record<ReviewChecklistKey, boolean>;
export interface ReviewDraft {
  decision: '' | 'approved' | 'rejected';
  reviewerRef: string;
  reviewedAt: string;
  evidenceRef: string;
  reason: string;
  checklist: ReviewChecklist;
}
export interface CurriculumPackageDocument {
  lessonId: string;
  lessonVersion: string;
  title: string;
  characters: Array<{
    characterId: string;
    hanzi: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}
export interface CurriculumPackageSummary {
  lessonId: string;
  lessonVersion: string;
  title: string;
  contentDigest: string;
  characterCount: number;
  importedAt: number;
  testFixture: boolean;
  reviewState: 'pending' | 'approved' | 'rejected' | 'test-fixture';
}
export interface CurriculumCoverage {
  schemaVersion: 's3-registry-foundation-1';
  revision: number;
  counts: {
    machineValidDistinct: number;
    humanReviewedDistinct: number;
    reviewedReadyDistinct: number;
    supervisedTrialDistinct: number;
    prospectiveStarterDistinct: number;
    starterReleasedDistinct: number;
    starterRequiredDistinct: 1600;
  };
  releaseProof: { available: false; code: 'STARTER_RELEASE_PROOF_UNAVAILABLE' };
  packages: CurriculumPackageSummary[];
}
export interface CurriculumReview {
  reviewId: string;
  previousReviewId: string | null;
  sequence: number;
  decision: 'approved' | 'rejected';
  reviewerRef: string;
  reviewedAt: number;
  checklistVersion: 'hanzi-review-1';
  checklist: ReviewChecklist;
  evidenceRef: string;
  reason: string;
  recordedBy: string;
  recordedAt: number;
  testFixture: boolean;
}
export interface CurriculumDetail {
  package: CurriculumPackageDocument;
  contentDigest: string;
  importedAt: number;
  testFixture: boolean;
  reviews: CurriculumReview[];
}
export interface CurriculumImportResult {
  lessonId: string;
  lessonVersion: string;
  contentDigest: string;
  created: boolean;
}
export interface CurriculumReviewResult {
  reviewId: string;
  created: boolean;
}

const MESSAGES: Record<string, string> = {
  INVALID_REQUEST:
    'Enter the actual reviewer, UTC review time, evidence reference, reason and decision. Approval needs every checklist item.',
  INVALID_PACKAGE:
    'The package is invalid. Check its required content and provenance fields before importing.',
  INVALID_RESPONSE:
    'The service returned an incomplete curriculum response. Refresh and try again.',
  UNAUTHORIZED: 'Your session has ended. Sign in again to review content.',
  PASSWORD_CHANGE_REQUIRED:
    'Change your issued password before reviewing content.',
  FORBIDDEN: 'Operator access is required. Refresh your account to continue.',
  NOT_FOUND:
    'Version unavailable. Choose an available version or retry this lookup.',
  CURRICULUM_VERSION_CONFLICT:
    'That version already identifies different content. Inspect the saved version; changed content needs a new version.',
  CURRICULUM_DIGEST_CONFLICT:
    'This content is already registered under another identity.',
  CHARACTER_IDENTITY_CONFLICT:
    'A character identity conflicts with an existing package.',
  STALE_REVIEW:
    'Another review is now the latest decision. Inspect the refreshed history, then explicitly submit your decision again.',
  REVIEW_EVENT_CONFLICT:
    'This submission already identifies different saved input. Inspect the history and edit your decision before submitting again.',
  PROVENANCE_INCOMPLETE:
    'Approval needs complete package provenance. A rejection may record the actual incomplete state.',
  FIXTURE_SCOPE_MISMATCH:
    'This test package belongs to a different test context. Refresh the available versions.',
  TEST_CONTENT_DISABLED: 'Test content is unavailable in this installation.',
  STORAGE_UNAVAILABLE:
    'The curriculum service is temporarily unavailable. Your unsent review remains in this tab.',
  NETWORK_UNAVAILABLE:
    'The curriculum service could not be reached. Recheck your connection and retry.',
};
function safeError(error: unknown): PilotApiError {
  if (error instanceof PilotApiError) {
    const code = Object.hasOwn(MESSAGES, error.code)
      ? error.code
      : error.status === 401
        ? 'UNAUTHORIZED'
        : error.status === 403
          ? 'FORBIDDEN'
          : error.status >= 500
            ? 'STORAGE_UNAVAILABLE'
            : 'INVALID_REQUEST';
    return new PilotApiError(error.status, MESSAGES[code], code);
  }
  return new PilotApiError(
    0,
    MESSAGES.NETWORK_UNAVAILABLE,
    'NETWORK_UNAVAILABLE',
  );
}
function invalidResponse(): never {
  throw new PilotApiError(502, MESSAGES.INVALID_RESPONSE, 'INVALID_RESPONSE');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalidResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed())
    invalidResponse();
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidResponse();
  return Number(value);
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidResponse();
  return value;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) invalidResponse();
  return result;
}
function checklist(value: unknown): ReviewChecklist {
  const body = record(value);
  return Object.fromEntries(
    REVIEW_CHECKLIST.map(({ key }) => [key, bool(body[key])]),
  ) as ReviewChecklist;
}
async function transport(
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  try {
    return record(
      await pilotRequest(
        path,
        body === undefined
          ? {}
          : { method: 'POST', body: JSON.stringify(body) },
      ),
    );
  } catch (error) {
    throw safeError(error);
  }
}
function versionPath(version: string): string {
  return `/api/pilot/curriculum/${encodeURIComponent(version)}`;
}
export async function getCurriculumCoverage(): Promise<CurriculumCoverage> {
  const body = await transport('/api/pilot/curriculum');
  const counts = record(body.counts);
  const proof = record(body.releaseProof);
  if (
    body.schemaVersion !== 's3-registry-foundation-1' ||
    proof.available !== false ||
    proof.code !== 'STARTER_RELEASE_PROOF_UNAVAILABLE' ||
    counts.starterRequiredDistinct !== 1600 ||
    !Array.isArray(body.packages)
  )
    invalidResponse();
  const packages = body.packages.map((value): CurriculumPackageSummary => {
    const item = record(value);
    const state = item.reviewState;
    if (
      state !== 'pending' &&
      state !== 'approved' &&
      state !== 'rejected' &&
      state !== 'test-fixture'
    )
      invalidResponse();
    return {
      lessonId: text(item.lessonId),
      lessonVersion: text(item.lessonVersion),
      title: text(item.title),
      contentDigest: digest(item.contentDigest),
      characterCount: integer(item.characterCount),
      importedAt: integer(item.importedAt),
      testFixture: bool(item.testFixture),
      reviewState: state,
    };
  });
  return {
    schemaVersion: 's3-registry-foundation-1',
    revision: integer(body.revision),
    counts: {
      machineValidDistinct: integer(counts.machineValidDistinct),
      humanReviewedDistinct: integer(counts.humanReviewedDistinct),
      reviewedReadyDistinct: integer(counts.reviewedReadyDistinct),
      supervisedTrialDistinct: integer(counts.supervisedTrialDistinct),
      prospectiveStarterDistinct: integer(counts.prospectiveStarterDistinct),
      starterReleasedDistinct: integer(counts.starterReleasedDistinct),
      starterRequiredDistinct: 1600,
    },
    releaseProof: {
      available: false,
      code: 'STARTER_RELEASE_PROOF_UNAVAILABLE',
    },
    packages,
  };
}
export async function getCurriculumDetail(
  version: string,
): Promise<CurriculumDetail> {
  const body = await transport(versionPath(version));
  const manifest = parseCurriculumDisplayDocument(body.package);
  if (
    !manifest ||
    manifest.lessonVersion !== version ||
    !Array.isArray(body.reviews)
  )
    invalidResponse();
  const reviews = body.reviews
    .map((value): CurriculumReview => {
      const item = record(value);
      if (
        (item.decision !== 'approved' && item.decision !== 'rejected') ||
        item.checklistVersion !== 'hanzi-review-1'
      )
        invalidResponse();
      return {
        reviewId: text(item.reviewId),
        previousReviewId:
          item.previousReviewId === null ? null : text(item.previousReviewId),
        sequence: integer(item.sequence),
        decision: item.decision,
        reviewerRef: text(item.reviewerRef),
        reviewedAt: integer(item.reviewedAt),
        checklistVersion: 'hanzi-review-1',
        checklist: checklist(item.checklist),
        evidenceRef: text(item.evidenceRef),
        reason: text(item.reason),
        recordedBy: text(item.recordedBy),
        recordedAt: integer(item.recordedAt),
        testFixture: bool(item.testFixture),
      };
    })
    .sort((a, b) => a.sequence - b.sequence);
  for (const [index, item] of reviews.entries()) {
    if (
      item.sequence !== index + 1 ||
      item.previousReviewId !== (reviews[index - 1]?.reviewId ?? null) ||
      reviews
        .slice(0, index)
        .some((earlier) => earlier.reviewId === item.reviewId)
    )
      invalidResponse();
  }
  return {
    package: manifest as CurriculumPackageDocument,
    contentDigest: digest(body.contentDigest),
    importedAt: integer(body.importedAt),
    testFixture: bool(body.testFixture),
    reviews,
  };
}
export async function importCurriculumPackage(
  pkg: unknown,
): Promise<CurriculumImportResult> {
  const body = await transport('/api/pilot/curriculum', { package: pkg });
  return {
    lessonId: text(body.lessonId),
    lessonVersion: text(body.lessonVersion),
    contentDigest: digest(body.contentDigest),
    created: bool(body.created),
  };
}
export async function recordCurriculumReview(
  version: string,
  input: CurriculumReviewInput,
): Promise<CurriculumReviewResult> {
  const body = await transport(`${versionPath(version)}/reviews`, input);
  if (body.reviewId !== input.requestId) invalidResponse();
  return { reviewId: text(body.reviewId), created: bool(body.created) };
}

export interface ReviewDeskApi {
  getMe(): Promise<PilotMe>;
  getCoverage(): Promise<CurriculumCoverage>;
  getDetail(version: string): Promise<CurriculumDetail>;
  importPackage(pkg: unknown): Promise<CurriculumImportResult>;
  recordReview(
    version: string,
    body: CurriculumReviewInput,
  ): Promise<CurriculumReviewResult>;
}
export interface ReviewDeskSnapshot {
  access: 'checking' | 'ready' | 'unavailable' | 'denied';
  busy: boolean;
  coverage: CurriculumCoverage | null;
  selectedVersion: string;
  detail: CurriculumDetail | null;
  draft: ReviewDraft;
  importText: string;
  error: string;
  errorCode: string;
  notice: string;
  retryAvailable: boolean;
}
function blankDraft(): ReviewDraft {
  return {
    decision: '',
    reviewerRef: '',
    reviewedAt: '',
    evidenceRef: '',
    reason: '',
    checklist: Object.fromEntries(
      REVIEW_CHECKLIST.map(({ key }) => [key, false]),
    ) as ReviewChecklist,
  };
}
function blankState(): ReviewDeskSnapshot {
  return {
    access: 'checking',
    busy: false,
    coverage: null,
    selectedVersion: '',
    detail: null,
    draft: blankDraft(),
    importText: '',
    error: '',
    errorCode: '',
    notice: '',
    retryAvailable: false,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function utcTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return NaN;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const timestamp = Date.parse(`${normalized}.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 19) === normalized
    ? timestamp
    : NaN;
}
const CANCELLED = Symbol('review-desk-cancelled');

/** The UI's private, memory-only state. No credentials, browser storage or logging. */
export class ReviewDeskController {
  private state: ReviewDeskSnapshot = freeze(blankState());
  private readonly listeners = new Set<() => void>();
  private readonly context: { accountId: string; installationId: string };
  private readonly api: ReviewDeskApi;
  private readonly makeId: () => string;
  private readonly now: () => number;
  private generation = 0;
  private disposed = false;
  private writing = false;
  private attempted: { version: string; body: CurriculumReviewInput } | null =
    null;

  constructor(
    context: { accountId: string; installationId: string },
    options: {
      api?: ReviewDeskApi;
      makeId?: () => string;
      now?: () => number;
    } = {},
  ) {
    this.context = { ...context };
    this.api = options.api ?? {
      getMe: getPilotMe,
      getCoverage: getCurriculumCoverage,
      getDetail: getCurriculumDetail,
      importPackage: importCurriculumPackage,
      recordReview: recordCurriculumReview,
    };
    this.makeId = options.makeId ?? (() => `review-${crypto.randomUUID()}`);
    this.now = options.now ?? Date.now;
  }
  getSnapshot = (): ReviewDeskSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private current(ticket: number): boolean {
    return !this.disposed && ticket === this.generation;
  }
  private update(patch: Partial<ReviewDeskSnapshot>): void {
    if (this.disposed) return;
    // Copy incoming data, while reusing immutable package/history projections
    // when only a form field or request status changes.
    this.state = freeze({ ...this.state, ...structuredClone(patch) });
    for (const listener of this.listeners) listener();
  }
  private deny(error: PilotApiError): void {
    this.generation += 1;
    this.attempted = null;
    this.writing = false;
    this.update({
      ...blankState(),
      access: 'denied',
      error: error.message,
      errorCode: error.code,
    });
  }
  private async authorize(ticket: number): Promise<void> {
    if (!this.current(ticket)) throw CANCELLED;
    this.update({ access: 'checking' });
    let me: PilotMe;
    try {
      me = await this.api.getMe();
    } catch (error) {
      if (!this.current(ticket)) throw CANCELLED;
      const safe = safeError(error);
      if (safe.status === 401 || safe.status === 403) this.deny(safe);
      else this.update({ access: 'unavailable' });
      throw safe;
    }
    if (!this.current(ticket)) throw CANCELLED;
    if (
      me.user.id !== this.context.accountId ||
      me.installationId !== this.context.installationId ||
      me.user.role !== 'operator' ||
      me.user.mustChangePassword ||
      !me.capabilities.manageAccounts
    ) {
      this.deny(new PilotApiError(403, MESSAGES.FORBIDDEN, 'FORBIDDEN'));
      throw CANCELLED;
    }
    this.update({ access: 'ready' });
  }
  private fail(error: unknown, ticket: number): void {
    if (error === CANCELLED || !this.current(ticket)) return;
    const safe = safeError(error);
    if (safe.status === 401 || safe.status === 403) {
      this.deny(safe);
      return;
    }
    const missing = safe.status === 404;
    if (missing) this.attempted = null;
    this.update({
      error: safe.message,
      errorCode: safe.code,
      ...(missing
        ? { detail: null, draft: blankDraft(), retryAvailable: false }
        : {}),
    });
  }
  private finish(ticket: number): void {
    if (this.current(ticket)) this.update({ busy: false });
  }
  private async detailFor(
    version: string,
    ticket: number,
  ): Promise<CurriculumDetail> {
    const detail = await this.api.getDetail(version);
    await this.authorize(ticket);
    if (detail.package.lessonVersion !== version) invalidResponse();
    return detail;
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.writing) {
      const ticket = this.generation;
      try {
        await this.authorize(ticket);
      } catch (error) {
        this.fail(error, ticket);
      }
      return;
    }
    const ticket = ++this.generation;
    const version = this.state.selectedVersion;
    this.update({ busy: true, error: '', errorCode: '', notice: '' });
    try {
      await this.authorize(ticket);
      const coverage = await this.api.getCoverage();
      await this.authorize(ticket);
      const detail = version ? await this.detailFor(version, ticket) : null;
      if (this.current(ticket)) this.update({ coverage, detail });
    } catch (error) {
      this.fail(error, ticket);
    } finally {
      this.finish(ticket);
    }
  }
  async select(version: string): Promise<void> {
    if (this.disposed || this.writing) return;
    if (version === this.state.selectedVersion) {
      await this.refresh();
      return;
    }
    const ticket = ++this.generation;
    this.attempted = null;
    this.update({
      selectedVersion: version,
      detail: null,
      draft: blankDraft(),
      retryAvailable: false,
      busy: true,
      error: '',
      errorCode: '',
      notice: '',
    });
    try {
      await this.authorize(ticket);
      const detail = await this.detailFor(version, ticket);
      if (this.current(ticket)) this.update({ detail });
    } catch (error) {
      this.fail(error, ticket);
    } finally {
      this.finish(ticket);
    }
  }
  setDraft(patch: Partial<ReviewDraft>): void {
    if (this.disposed || this.writing || this.state.access !== 'ready') return;
    const draft = {
      ...this.state.draft,
      ...patch,
      checklist: { ...(patch.checklist ?? this.state.draft.checklist) },
    };
    if (JSON.stringify(draft) === JSON.stringify(this.state.draft)) return;
    this.attempted = null;
    this.update({
      draft,
      retryAvailable: false,
      error: '',
      errorCode: '',
      notice: '',
    });
  }
  setImportText(importText: string): void {
    if (!this.disposed && !this.writing && this.state.access === 'ready')
      this.update({ importText, error: '', errorCode: '', notice: '' });
  }
  async importPackage(): Promise<void> {
    if (this.disposed || this.writing) return;
    const source = this.state.importText;
    const ticket = ++this.generation;
    this.writing = true;
    this.update({ busy: true, error: '', errorCode: '', notice: '' });
    try {
      await this.authorize(ticket);
      let pkg: unknown;
      try {
        if (!source.length || source.length > 1_000_000) throw new Error();
        pkg = JSON.parse(source);
        if (JSON.stringify({ package: pkg }).length > 1_000_000)
          throw new Error();
      } catch {
        throw new PilotApiError(
          400,
          MESSAGES.INVALID_PACKAGE,
          'INVALID_PACKAGE',
        );
      }
      const result = await this.api.importPackage(pkg);
      await this.authorize(ticket);
      const coverage = await this.api.getCoverage();
      const detail = await this.detailFor(result.lessonVersion, ticket);
      if (
        detail.contentDigest !== result.contentDigest ||
        detail.package.lessonId !== result.lessonId
      )
        invalidResponse();
      if (this.current(ticket)) {
        this.attempted = null;
        this.update({
          coverage,
          selectedVersion: result.lessonVersion,
          detail,
          importText: '',
          draft: blankDraft(),
          retryAvailable: false,
          notice: result.created
            ? 'Package imported. Content review and release remain separate.'
            : 'This exact package is already imported.',
        });
      }
    } catch (error) {
      this.fail(error, ticket);
    } finally {
      if (this.current(ticket)) this.writing = false;
      this.finish(ticket);
    }
  }
  private prepare(detail: CurriculumDetail): CurriculumReviewInput {
    const draft = this.state.draft;
    const head = detail.reviews.reduce<CurriculumReview | null>(
      (last, item) => (!last || item.sequence > last.sequence ? item : last),
      null,
    );
    const body = {
      requestId: this.makeId(),
      contentDigest: detail.contentDigest,
      previousReviewId: head?.reviewId ?? null,
      decision: draft.decision,
      reviewerRef: draft.reviewerRef,
      reviewedAt: utcTime(draft.reviewedAt),
      checklistVersion: 'hanzi-review-1',
      checklist: { ...draft.checklist },
      evidenceRef: draft.evidenceRef,
      reason: draft.reason,
    };
    if (!isCurriculumReviewInput(body, this.now()))
      throw new PilotApiError(400, MESSAGES.INVALID_REQUEST, 'INVALID_REQUEST');
    return body;
  }
  async submitReview(): Promise<void> {
    await this.saveReview(false);
  }
  async retryReview(): Promise<void> {
    if (this.attempted) await this.saveReview(true);
  }
  private async saveReview(retry: boolean): Promise<void> {
    if (this.disposed || this.writing || !this.state.selectedVersion) return;
    const ticket = ++this.generation;
    const version = this.state.selectedVersion;
    this.writing = true;
    this.update({ busy: true, error: '', errorCode: '', notice: '' });
    try {
      await this.authorize(ticket);
      const detail = await this.detailFor(version, ticket);
      if (!this.current(ticket)) return;
      this.update({ detail });
      // Even submitReview cannot accidentally replace an uncertain identical submission.
      if (!this.attempted) {
        if (retry) return;
        this.attempted = {
          version,
          body: structuredClone(this.prepare(detail)),
        };
      }
      const attempt = this.attempted;
      if (attempt.version !== version) invalidResponse();
      const result = await this.api.recordReview(
        version,
        structuredClone(attempt.body),
      );
      await this.authorize(ticket);
      if (result.reviewId !== attempt.body.requestId) invalidResponse();
      const savedDetail = await this.detailFor(version, ticket);
      const coverage = await this.api.getCoverage();
      await this.authorize(ticket);
      if (this.current(ticket)) {
        this.attempted = null;
        this.update({
          detail: savedDetail,
          coverage,
          draft: blankDraft(),
          retryAvailable: false,
          notice: result.created
            ? 'Review decision saved. This does not release the lesson.'
            : 'This exact review decision was already saved.',
        });
      }
    } catch (error) {
      if (!this.current(ticket) || error === CANCELLED) return;
      const safe = safeError(error);
      const uncertain = safe.status === 0 || safe.status >= 500;
      if (!uncertain) this.attempted = null;
      this.update({ retryAvailable: uncertain && this.attempted !== null });
      this.fail(safe, ticket);
      if ((safe.code === 'STALE_REVIEW' || uncertain) && this.current(ticket)) {
        try {
          await this.authorize(ticket);
          const detail = await this.detailFor(version, ticket);
          if (this.current(ticket)) this.update({ detail });
        } catch (refreshError) {
          this.fail(refreshError, ticket);
        }
      }
    } finally {
      if (this.current(ticket)) this.writing = false;
      this.finish(ticket);
    }
  }
  dispose(): void {
    this.generation += 1;
    this.disposed = true;
    this.writing = false;
    this.attempted = null;
    this.listeners.clear();
    this.state = freeze({ ...blankState(), access: 'denied' });
  }
}
