import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { PilotApiError } from '../lib/pilot-client.ts';
import {
  ReviewDeskController,
  getCurriculumCoverage,
  getCurriculumDetail,
  importCurriculumPackage,
  recordCurriculumReview,
} from '../lib/pilot-curriculum-client.ts';

const PACKAGE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);
const VERSION = PACKAGE.lessonVersion;
const DIGEST =
  'sha256:aab500668c340a4497e32ecaa54e8bfb350ac24e05a62949fa7e2843b642f246';
const PACKAGE_V3 = { ...PACKAGE, lessonVersion: 'forest-01-v3' };
const INSTALLATION = 'installation-a';
const ACCOUNT = 'operator-a';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const DIGEST_V3 = `sha256:${createHash('sha256').update(canonical(PACKAGE_V3)).digest('hex')}`;

const ME = {
  user: {
    id: ACCOUNT,
    name: 'Operator A',
    username: 'operator-a',
    role: 'operator',
    mustChangePassword: false,
  },
  installationId: INSTALLATION,
  children: [],
  capabilities: { manageAccounts: true },
};

const COVERAGE = {
  schemaVersion: 's3-registry-foundation-1',
  revision: 1,
  counts: {
    machineValidDistinct: 2,
    humanReviewedDistinct: 0,
    reviewedReadyDistinct: 0,
    supervisedTrialDistinct: 0,
    prospectiveStarterDistinct: 0,
    starterReleasedDistinct: 0,
    starterRequiredDistinct: 1600,
  },
  releaseProof: {
    available: false,
    code: 'STARTER_RELEASE_PROOF_UNAVAILABLE',
  },
  packages: [
    {
      lessonId: PACKAGE.lessonId,
      lessonVersion: VERSION,
      title: PACKAGE.title,
      contentDigest: DIGEST,
      characterCount: PACKAGE.characters.length,
      importedAt: 1790313600000,
      testFixture: false,
      reviewState: 'pending',
    },
  ],
};

function detail(reviews = [], packageValue = PACKAGE, contentDigest = DIGEST) {
  return {
    package: packageValue,
    contentDigest,
    importedAt: 1790313600000,
    testFixture: false,
    reviews,
  };
}

function review(reviewId, sequence, previousReviewId = null) {
  return {
    reviewId,
    previousReviewId,
    sequence,
    decision: 'rejected',
    reviewerRef: 'Mina Chen',
    reviewedAt: 1790313600000,
    checklistVersion: 'hanzi-review-1',
    checklist: {
      scriptAndGlyphs: false,
      mandarinAndReadings: false,
      wordContexts: false,
      teachingAndChecks: false,
      ageSuitability: false,
      sourcesAndLicenses: false,
      deviceAudio: false,
    },
    evidenceRef: 'owner-review/forest-01-v2',
    reason: 'Needs a further review.',
    recordedBy: ACCOUNT,
    recordedAt: 1790313600000,
    testFixture: false,
  };
}

const BLANK_CHECKLIST = {
  scriptAndGlyphs: false,
  mandarinAndReadings: false,
  wordContexts: false,
  teachingAndChecks: false,
  ageSuitability: false,
  sourcesAndLicenses: false,
  deviceAudio: false,
};

const DRAFT = {
  decision: 'rejected',
  reviewerRef: 'Mina Chen',
  reviewedAt: '2026-09-25T05:20',
  evidenceRef: 'owner-review/forest-01-v2',
  reason: 'Needs a further review.',
  checklist: { ...BLANK_CHECKLIST },
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function pathOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input && typeof input === 'object' && typeof input.url === 'string'
    ? input.url
    : '';
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function error(status, code, message = 'private server detail') {
  return new PilotApiError(status, message, code);
}

function clone(value) {
  return structuredClone(value);
}

function makeApi(overrides = {}) {
  const calls = {
    me: 0,
    coverage: 0,
    details: [],
    imports: [],
    reviews: [],
  };
  const api = {
    async getMe() {
      calls.me += 1;
      if (overrides.getMe) return overrides.getMe(calls.me);
      return clone(overrides.me ?? ME);
    },
    async getCoverage() {
      calls.coverage += 1;
      if (overrides.getCoverage) return overrides.getCoverage(calls.coverage);
      return clone(overrides.coverage ?? COVERAGE);
    },
    async getDetail(version) {
      calls.details.push(version);
      if (overrides.getDetail)
        return overrides.getDetail(version, calls.details.length);
      return clone(overrides.detail ?? detail());
    },
    async importPackage(value) {
      calls.imports.push(clone(value));
      return clone(
        overrides.importResult ?? {
          lessonId: PACKAGE.lessonId,
          lessonVersion: VERSION,
          contentDigest: DIGEST,
          created: true,
        },
      );
    },
    async recordReview(version, body) {
      calls.reviews.push({ version, body: clone(body) });
      if (overrides.recordReview)
        return overrides.recordReview(version, body, calls.reviews.length);
      return { reviewId: body.requestId, created: true };
    },
  };
  return { api, calls };
}

async function ready(api, options = {}) {
  const controller = new ReviewDeskController(
    { accountId: ACCOUNT, installationId: INSTALLATION },
    {
      api,
      makeId: options.makeId ?? (() => 'request-1'),
      now: options.now ?? (() => 1790313600000),
    },
  );
  await controller.refresh();
  return controller;
}

async function selected(api, options = {}) {
  const controller = await ready(api, options);
  await controller.select(VERSION);
  return controller;
}

test('[S3-RD-AC-002/003/004] registry wrappers use exact routes, bodies, credentials, no-store and safe projections', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    requests.push({ path, init: { ...init } });
    if (path === '/api/pilot/curriculum') {
      if ((init.method ?? 'GET') === 'GET')
        return response({ ...COVERAGE, transportSecret: 'do-not-expose' });
      return response(
        {
          lessonId: PACKAGE.lessonId,
          lessonVersion: VERSION,
          contentDigest: DIGEST,
          created: true,
          transportSecret: 'do-not-expose',
        },
        201,
      );
    }
    if (path === `/api/pilot/curriculum/${VERSION}`)
      return response({ ...detail(), transportSecret: 'do-not-expose' });
    if (path === '/api/pilot/curriculum/forest%2F01/reviews')
      return response(
        {
          reviewId: 'request-1',
          created: true,
          transportSecret: 'do-not-expose',
        },
        201,
      );
    throw new Error(`unexpected synthetic path: ${path}`);
  };
  try {
    const coverage = await getCurriculumCoverage();
    const imported = await importCurriculumPackage(PACKAGE);
    const inspected = await getCurriculumDetail(VERSION);
    const body = {
      requestId: 'request-1',
      contentDigest: DIGEST,
      previousReviewId: null,
      decision: 'rejected',
      reviewerRef: 'Mina Chen',
      reviewedAt: 1790313600000,
      checklistVersion: 'hanzi-review-1',
      checklist: { ...BLANK_CHECKLIST },
      evidenceRef: 'owner-review/forest-01-v2',
      reason: 'Needs a further review.',
    };
    const recorded = await recordCurriculumReview('forest/01', body);
    assert.equal(coverage.transportSecret, undefined);
    assert.equal(imported.transportSecret, undefined);
    assert.equal(inspected.transportSecret, undefined);
    assert.equal(recorded.transportSecret, undefined);
    assert.deepEqual(JSON.parse(requests[1].init.body), { package: PACKAGE });
    assert.deepEqual(JSON.parse(requests[3].init.body), body);
    assert.equal(requests[3].path, '/api/pilot/curriculum/forest%2F01/reviews');
    for (const request of requests) {
      assert.equal(request.init.credentials, 'same-origin');
      assert.equal(request.init.cache, 'no-store');
      assert.equal(
        new Headers(request.init.headers).get('accept'),
        'application/json',
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('[S3-RD-AC-002/003] malformed registry responses and server failures stay fixed and sanitized', async () => {
  const previousFetch = globalThis.fetch;
  let mode = 'malformed';
  globalThis.fetch = async () => {
    if (mode === 'malformed')
      return response({ schemaVersion: 'wrong', packages: [] });
    return response(
      {
        error: {
          code: 'STORAGE_UNAVAILABLE',
          message: 'password=private-value',
        },
      },
      503,
    );
  };
  try {
    await assert.rejects(
      () => getCurriculumCoverage(),
      (caught) =>
        caught?.code === 'INVALID_RESPONSE' &&
        !caught.message.includes('private-value'),
    );
    mode = 'server-error';
    await assert.rejects(
      () => getCurriculumCoverage(),
      (caught) =>
        caught?.code === 'STORAGE_UNAVAILABLE' &&
        caught.status === 503 &&
        !caught.message.includes('private-value'),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('[S3-RD-AC-004/005] controller builds the exact review body from the selected server head', async () => {
  const { api, calls } = makeApi({ detail: detail([review('head-1', 1)]) });
  const controller = await selected(api, { makeId: () => 'request-exact' });
  controller.setDraft(DRAFT);
  await controller.submitReview();
  assert.deepEqual(calls.reviews[0], {
    version: VERSION,
    body: {
      requestId: 'request-exact',
      contentDigest: DIGEST,
      previousReviewId: 'head-1',
      decision: 'rejected',
      reviewerRef: 'Mina Chen',
      reviewedAt: 1790313600000,
      checklistVersion: 'hanzi-review-1',
      checklist: { ...BLANK_CHECKLIST },
      evidenceRef: 'owner-review/forest-01-v2',
      reason: 'Needs a further review.',
    },
  });
  assert.equal(controller.getSnapshot().draft.decision, '');
});

test('[S3-RD-AC-002] controller imports only the parsed package and clears text after confirmed save', async () => {
  const { api, calls } = makeApi();
  const controller = await ready(api);
  controller.setImportText(JSON.stringify(PACKAGE));
  await controller.importPackage();
  assert.deepEqual(calls.imports, [PACKAGE]);
  assert.equal(controller.getSnapshot().importText, '');
  assert.equal(controller.getSnapshot().error, '');
});

test('[S3-RD-AC-006] ambiguous review keeps an exact frozen body across refreshed heads and retry', async () => {
  const firstDetail = detail([review('head-1', 1)]);
  const advancedDetail = detail([review('head-2', 2, 'head-1')]);
  const retry = deferred();
  let uncertain = false;
  const { api, calls } = makeApi({
    detail: firstDetail,
    getDetail: () => clone(uncertain ? advancedDetail : firstDetail),
    recordReview: (_version, body, count) => {
      if (count === 1) {
        uncertain = true;
        return retry.promise;
      }
      return { reviewId: body.requestId, created: true };
    },
  });
  const controller = await selected(api, { makeId: () => 'request-frozen' });
  controller.setDraft(DRAFT);
  const submitting = controller.submitReview();
  await Promise.resolve();
  retry.reject(new Error('synthetic network loss after submission'));
  await submitting;
  const afterFailure = controller.getSnapshot();
  assert.equal(afterFailure.retryAvailable, true);
  assert.deepEqual(afterFailure.draft, DRAFT);
  assert.equal(
    afterFailure.detail.reviews.at(-1).reviewId,
    'head-2',
    'an uncertain save re-fetches the exact selected version before offering retry',
  );
  assert.equal(calls.reviews.length, 1);
  const frozen = clone(calls.reviews[0].body);
  await controller.retryReview();
  assert.equal(calls.reviews.length, 2);
  assert.deepEqual(calls.reviews[1].body, frozen);
  assert.equal(calls.reviews[1].body.previousReviewId, 'head-1');
  assert.equal(calls.reviews[1].body.contentDigest, DIGEST);
  assert.equal(controller.getSnapshot().draft.decision, '');
});

test('[S3-RD-AC-006] editing a failed review invalidates its retry body and requires a new request', async () => {
  const pending = deferred();
  const started = deferred();
  const { api, calls } = makeApi({
    recordReview: (_version, body, count) => {
      started.resolve();
      return count === 1
        ? pending.promise
        : { reviewId: body.requestId, created: true };
    },
  });
  let id = 0;
  const controller = await selected(api, { makeId: () => `request-${++id}` });
  controller.setDraft(DRAFT);
  const failed = controller.submitReview();
  await started.promise;
  pending.reject(new Error('synthetic network loss after submission'));
  await failed;
  const frozen = clone(calls.reviews[0].body);
  controller.setDraft({
    decision: 'approved',
    checklist: {
      scriptAndGlyphs: true,
      mandarinAndReadings: true,
      wordContexts: true,
      teachingAndChecks: true,
      ageSuitability: true,
      sourcesAndLicenses: true,
      deviceAudio: true,
    },
  });
  await controller.retryReview();
  assert.equal(calls.reviews.length, 1);
  await controller.submitReview();
  assert.equal(calls.reviews.length, 2);
  assert.equal(calls.reviews[1].body.requestId, 'request-2');
  assert.equal(calls.reviews[1].body.decision, 'approved');
  assert.notDeepEqual(calls.reviews[1].body, frozen);
});

test('[S3-RD-AC-006] changed account, installation, role, password gate and auth failures clear private state and reject late data', async () => {
  const cases = [
    { name: 'account', me: { ...ME, user: { ...ME.user, id: 'operator-b' } } },
    { name: 'installation', me: { ...ME, installationId: 'installation-b' } },
    { name: 'role', me: { ...ME, user: { ...ME.user, role: 'parent' } } },
    {
      name: 'password',
      me: { ...ME, user: { ...ME.user, mustChangePassword: true } },
    },
    {
      name: 'unauthorized',
      getMe: () => {
        throw error(401, 'UNAUTHORIZED');
      },
    },
    {
      name: 'forbidden',
      getMe: () => {
        throw error(403, 'FORBIDDEN');
      },
    },
  ];
  for (const item of cases) {
    const oldDetail = deferred();
    let meCalls = 0;
    const { api } = makeApi({
      getDetail: () => oldDetail.promise,
      getMe: () => {
        meCalls += 1;
        if (item.getMe) return item.getMe();
        return meCalls === 1 ? clone(ME) : clone(item.me);
      },
    });
    const controller = new ReviewDeskController(
      { accountId: ACCOUNT, installationId: INSTALLATION },
      { api, makeId: () => 'request-context' },
    );
    await controller.refresh();
    controller.setImportText('private package text');
    controller.setDraft(DRAFT);
    const selecting = controller.select(VERSION);
    await Promise.resolve();
    await controller.refresh();
    oldDetail.resolve(detail([review('late-head', 1)]));
    await selecting;
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.coverage, null, item.name);
    assert.equal(snapshot.detail, null, item.name);
    assert.equal(snapshot.selectedVersion, '', item.name);
    assert.equal(snapshot.importText, '', item.name);
    assert.equal(snapshot.draft.decision, '', item.name);
    assert.notEqual(snapshot.access, 'ready', item.name);
  }
});

test('[S3-RD-AC-006] duplicate clicks are one review flight and do not create duplicate request bodies', async () => {
  const pending = deferred();
  const recordStarted = deferred();
  const { api, calls } = makeApi({
    recordReview: () => {
      recordStarted.resolve();
      return pending.promise;
    },
  });
  const controller = await selected(api, {
    makeId: () => 'request-single-flight',
  });
  controller.setDraft(DRAFT);
  const first = controller.submitReview();
  const second = controller.submitReview();
  await recordStarted.promise;
  assert.equal(calls.reviews.length, 1);
  pending.resolve({ reviewId: 'review-1', created: true });
  await Promise.all([first, second]);
  assert.equal(calls.reviews.length, 1);
});

test('[S3-RD-AC-005/006] stale head reloads detail but requires explicit resubmission with a new request ID', async () => {
  const staleDetail = detail([review('head-1', 1)]);
  const currentDetail = detail([review('head-2', 2, 'head-1')]);
  let detailReads = 0;
  const { api, calls } = makeApi({
    getDetail: () => clone(++detailReads === 1 ? staleDetail : currentDetail),
    recordReview: (_version, body, count) => {
      if (count === 1) throw error(409, 'STALE_REVIEW');
      return { reviewId: body.requestId, created: true };
    },
  });
  let id = 0;
  const controller = await selected(api, { makeId: () => `request-${++id}` });
  controller.setDraft(DRAFT);
  await controller.submitReview();
  assert.equal(calls.reviews.length, 1);
  assert.equal(
    controller.getSnapshot().detail.reviews.at(-1).reviewId,
    'head-2',
  );
  assert.deepEqual(controller.getSnapshot().draft, DRAFT);
  await controller.submitReview();
  assert.equal(calls.reviews.length, 2);
  assert.equal(calls.reviews[0].body.requestId, 'request-1');
  assert.equal(calls.reviews[1].body.requestId, 'request-2');
  assert.equal(calls.reviews[1].body.previousReviewId, 'head-2');
});

test('[S3-RD-AC-003] out-of-order selection cannot overwrite the newer selected version or fall back silently', async () => {
  const otherVersion = 'forest-01-v3';
  const first = deferred();
  const second = deferred();
  const { api } = makeApi({
    getDetail: (version) =>
      version === VERSION ? first.promise : second.promise,
  });
  const controller = await ready(api);
  const firstSelection = controller.select(VERSION);
  const secondSelection = controller.select(otherVersion);
  second.resolve({
    ...detail([], PACKAGE_V3, DIGEST_V3),
  });
  await secondSelection;
  first.resolve(detail());
  await firstSelection;
  assert.equal(controller.getSnapshot().selectedVersion, otherVersion);
  assert.equal(
    controller.getSnapshot().detail.package.lessonVersion,
    otherVersion,
  );
  const missing = deferred();
  const missingApi = makeApi({ getDetail: () => missing.promise });
  const missingController = await ready(missingApi.api);
  const request = missingController.select('forest-unknown');
  missing.reject(error(404, 'NOT_FOUND'));
  await request;
  assert.equal(
    missingController.getSnapshot().selectedVersion,
    'forest-unknown',
  );
  assert.equal(missingController.getSnapshot().detail, null);
});

test('[S3-RD-AC-007] same-context refresh preserves in-memory drafts and never touches browser storage', async () => {
  const previousWindow = globalThis.window;
  let accesses = 0;
  globalThis.window = {
    get localStorage() {
      accesses += 1;
      throw new Error('storage must not be read');
    },
    get sessionStorage() {
      accesses += 1;
      throw new Error('storage must not be read');
    },
  };
  try {
    const { api } = makeApi();
    const controller = await ready(api);
    controller.setImportText('{ synthetic private package }');
    controller.setDraft(DRAFT);
    await controller.refresh();
    assert.equal(accesses, 0);
    assert.equal(
      controller.getSnapshot().importText,
      '{ synthetic private package }',
    );
    assert.deepEqual(controller.getSnapshot().draft, DRAFT);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('[S3-RD-AC-006] dispose invalidates pending refreshes and clears all private state', async () => {
  const pendingCoverage = deferred();
  const { api } = makeApi({ getCoverage: () => pendingCoverage.promise });
  const controller = new ReviewDeskController(
    { accountId: ACCOUNT, installationId: INSTALLATION },
    { api },
  );
  const refreshing = controller.refresh();
  controller.setImportText('private package text');
  controller.setDraft(DRAFT);
  controller.dispose();
  pendingCoverage.resolve(COVERAGE);
  await refreshing;
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.coverage, null);
  assert.equal(snapshot.detail, null);
  assert.equal(snapshot.importText, '');
  assert.equal(snapshot.draft.decision, '');
  assert.equal(snapshot.selectedVersion, '');
  assert.equal(snapshot.busy, false);
});
