/*
 * Sprint 3 review-desk HTTP probe.
 *
 * The runner supplies a fresh Worker/D1 installation and ordinary seeded
 * accounts. The probe imports the candidate's browser client/controller and
 * gives it only a relative-URL fetch adapter backed by a real sign-in cookie.
 * It never uses the test token as an authentication mechanism.
 */

import fs from 'node:fs';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/curriculum/forest-01-v2.json', import.meta.url),
    'utf8',
  ),
);

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class ProbeAssertionError extends Error {
  constructor(label) {
    super(label);
    this.name = 'ProbeAssertionError';
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new ProbeAssertionError(message);
}

function accountFor(accounts, key) {
  const account = accounts?.[key];
  requireCondition(
    object(account) &&
      typeof account.id === 'string' &&
      typeof account.username === 'string' &&
      typeof account.password === 'string',
    `seed account ${key} is unavailable`,
  );
  return account;
}

function rowValue(row, ...names) {
  if (!object(row)) return undefined;
  for (const name of names) if (Object.hasOwn(row, name)) return row[name];
  return undefined;
}

function registryCounts(snapshot) {
  requireCondition(object(snapshot), 'registry inspection is unavailable');
  for (const key of ['state', 'packages', 'characters', 'reviews', 'audit'])
    requireCondition(Array.isArray(snapshot[key]), `registry omitted ${key}`);
  requireCondition(
    snapshot.state.length <= 1,
    'registry inspection returned duplicate state rows',
  );
  const revision = Number(rowValue(snapshot.state[0], 'revision'));
  requireCondition(
    Number.isSafeInteger(revision) && revision >= 0,
    'registry inspection returned an invalid revision',
  );
  return {
    revision,
    packages: snapshot.packages.length,
    characters: snapshot.characters.length,
    reviews: snapshot.reviews.length,
    audit: snapshot.audit.length,
  };
}

function requireCoverage(coverage, label) {
  requireCondition(
    object(coverage) &&
      coverage.schemaVersion === 's3-registry-foundation-1' &&
      object(coverage.releaseProof) &&
      object(coverage.counts) &&
      Array.isArray(coverage.packages) &&
      coverage.releaseProof.available === false &&
      coverage.releaseProof.code === 'STARTER_RELEASE_PROOF_UNAVAILABLE' &&
      coverage.counts.starterRequiredDistinct === 1600 &&
      coverage.counts.humanReviewedDistinct === 0 &&
      coverage.counts.reviewedReadyDistinct === 0 &&
      coverage.counts.supervisedTrialDistinct === 0 &&
      coverage.counts.prospectiveStarterDistinct === 0 &&
      coverage.counts.starterReleasedDistinct === 0,
    `${label} reported unexpected release or trusted coverage`,
  );
}

// Keep this oracle independent of the package validator. This fixture is
// intentionally incomplete: an approval must reach the Worker and be refused
// with PROVENANCE_INCOMPLETE, while a rejection remains valid.
function hasCompleteProvenance(pkg) {
  if (
    !object(pkg) ||
    !Array.isArray(pkg.assets) ||
    !Array.isArray(pkg.characters)
  )
    return false;
  const completeAsset = (asset) =>
    object(asset) &&
    asset.sourceChecked === true &&
    asset.sourceCheckStatus === 'mechanically-checked';
  if (!pkg.assets.every(completeAsset)) return false;
  return pkg.characters.every((character) => {
    if (!object(character)) return false;
    const facts = [
      ...(Array.isArray(character.readings) ? character.readings : []),
      ...(Array.isArray(character.meanings) ? character.meanings : []),
      ...(Array.isArray(character.wordAssociations)
        ? character.wordAssociations
        : []),
    ];
    if (
      !facts.every(
        (item) =>
          object(item.provenance) && item.provenance.sourceChecked === true,
      )
    )
      return false;
    const assetIds = new Set(
      Array.isArray(character.assets)
        ? character.assets.filter((value) => typeof value === 'string')
        : [],
    );
    return ['glyph', 'font', 'audio'].every((kind) =>
      pkg.assets.some(
        (asset) =>
          object(asset) && asset.kind === kind && assetIds.has(asset.assetId),
      ),
    );
  });
}

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    /^(requestDigest|writeId|password|hash|token|secret|email)$/i.test(key)
      ? true
      : containsForbiddenKey(child),
  );
}

function requireFixtureSummary(coverage, label) {
  requireCoverage(coverage, label);
  const row = coverage.packages.find(
    (item) => item.lessonVersion === FIXTURE.lessonVersion,
  );
  requireCondition(
    object(row) &&
      row.testFixture === true &&
      row.reviewState === 'test-fixture',
    `${label} omitted the synthetic fixture marker`,
  );
}

function reviewTime() {
  return new Date(Date.now() - 1_000).toISOString().slice(0, 16);
}

function allChecklist(value) {
  return {
    scriptAndGlyphs: value,
    mandarinAndReadings: value,
    wordContexts: value,
    teachingAndChecks: value,
    ageSuitability: value,
    sourcesAndLicenses: value,
    deviceAudio: value,
  };
}

function reviewBody(detail, requestId, overrides = {}) {
  const latest = detail.reviews[detail.reviews.length - 1];
  return {
    requestId,
    contentDigest: detail.contentDigest,
    previousReviewId: latest?.reviewId ?? null,
    decision: 'rejected',
    reviewerRef: 'synthetic-review-desk-reviewer',
    reviewedAt: Date.now() - 1_000,
    checklistVersion: 'hanzi-review-1',
    checklist: allChecklist(false),
    evidenceRef: 'synthetic-review-desk/evidence',
    reason: 'Synthetic rejection used only for isolated integration coverage.',
    ...overrides,
  };
}

function expectClientError(action, status, code, label) {
  return action().then(
    () => {
      throw new ProbeAssertionError(`${label} unexpectedly succeeded`);
    },
    (error) => {
      requireCondition(error && error.status === status, `${label} status`);
      requireCondition(error.code === code, `${label} code`);
    },
  );
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === 'function')
    return response.headers.getSetCookie();
  const value = response.headers.get('set-cookie') || '';
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]*)/g) : [];
}

function cookieHeader(values) {
  const cookies = new Map();
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const token = pair.slice(separator + 1).trim();
    if (token) cookies.set(name, token);
  }
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function ordinaryLogin(baseURL, account, originalFetch) {
  const origin = new URL(baseURL).origin;
  const response = await originalFetch(`${baseURL}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: origin,
      'CF-Connecting-IP': '198.51.100.61',
    },
    body: JSON.stringify({
      username: account.username,
      password: account.password,
    }),
  });
  requireCondition(response.status === 200, 'ordinary operator sign-in failed');
  const cookie = cookieHeader(responseCookies(response));
  requireCondition(
    cookie.length > 0,
    'ordinary operator sign-in set no cookie',
  );
  return { origin, cookie };
}

function installFetchAdapter(
  baseURL,
  session,
  originalFetch,
  requestLog,
  detailBodies,
) {
  const origin = session.origin;
  let dropNextReviewResponse = false;
  const setDropNextReviewResponse = () => {
    dropNextReviewResponse = true;
  };
  globalThis.fetch = async (input, init = {}) => {
    const sourceURL = typeof input === 'string' ? input : input.url;
    const url = new URL(sourceURL, baseURL);
    const headers = new Headers(
      typeof input === 'string' ? undefined : input.headers,
    );
    for (const [key, value] of new Headers(init.headers))
      headers.set(key, value);
    headers.set('Origin', origin);
    headers.set('Cookie', session.cookie);
    headers.set('CF-Connecting-IP', '198.51.100.61');
    const method = String(
      init.method ||
        (typeof input === 'string' ? 'GET' : input.method || 'GET'),
    ).toUpperCase();
    const body = init.body;
    if (url.pathname.endsWith('/reviews') && method === 'POST') {
      requestLog.push(typeof body === 'string' ? body : '');
    }
    const response = await originalFetch(url, {
      ...init,
      method,
      headers,
    });
    if (
      method === 'GET' &&
      /^\/api\/pilot\/curriculum\/[^/]+$/.test(url.pathname)
    ) {
      try {
        detailBodies.push(await response.clone().json());
      } catch {
        // The client will report an invalid response if the body is malformed.
      }
    }
    const returnedCookies = responseCookies(response);
    if (returnedCookies.length) session.cookie = cookieHeader(returnedCookies);
    if (
      dropNextReviewResponse &&
      url.pathname.endsWith('/reviews') &&
      method === 'POST'
    ) {
      dropNextReviewResponse = false;
      throw new Error('synthetic response loss after server write');
    }
    return response;
  };
  return { setDropNextReviewResponse };
}

function draftFor(controller, decision, reason, reviewerRef) {
  controller.setDraft({
    decision,
    reviewerRef,
    reviewedAt: reviewTime(),
    evidenceRef: 'synthetic-review-desk/evidence',
    reason,
    checklist: allChecklist(false),
  });
}

function latestDetail(controller, label) {
  const detail = controller.getSnapshot().detail;
  requireCondition(
    detail && detail.package.lessonVersion === FIXTURE.lessonVersion,
    label,
  );
  return detail;
}

async function runCase(id, action) {
  try {
    await action();
    return { id, status: 'PASS' };
  } catch (error) {
    if (error instanceof ProbeAssertionError)
      return { id, status: 'FAIL', detail: error.message };
    if (
      error &&
      typeof error === 'object' &&
      typeof error.code === 'string' &&
      /^[A-Z0-9_]+$/.test(error.code)
    )
      return {
        id,
        status: 'FAIL',
        detail: `client-${Number.isInteger(error.status) ? error.status : 0}-${error.code}`,
      };
    return { id, status: 'FAIL', detail: 'unexpected-probe-error' };
  }
}

export async function runPilotReviewDeskIntegration({
  baseURL,
  accounts,
  curriculumFixtures,
  revokeAccount,
}) {
  if (typeof curriculumFixtures?.inspect !== 'function')
    throw new Error(
      'Review desk probe requires the registry inspection callback',
    );
  if (typeof revokeAccount !== 'function')
    throw new Error(
      'Review desk probe requires the account revocation callback',
    );

  const account = accountFor(accounts, 'operator');
  const originalFetch = globalThis.fetch;
  const session = await ordinaryLogin(baseURL, account, originalFetch);
  const client = await import(
    new URL('../lib/pilot-curriculum-client.ts', import.meta.url)
  );
  const pilotClient = await import(
    new URL('../lib/pilot-client.ts', import.meta.url)
  );
  const requestLog = [];
  const detailBodies = [];
  const adapter = installFetchAdapter(
    baseURL,
    session,
    originalFetch,
    requestLog,
    detailBodies,
  );
  const results = [];
  let desk;
  try {
    const me = await pilotClient.getPilotMe();
    requireCondition(
      me.user.id === account.id && me.user.role === 'operator',
      'operator /me projection',
    );
    requireCondition(
      me.installationId.length > 0,
      'operator /me omitted installation',
    );
    desk = new client.ReviewDeskController(
      { accountId: me.user.id, installationId: me.installationId },
      {
        makeId: (() => {
          let sequence = 0;
          return () => `desk-review-${++sequence}`;
        })(),
      },
    );
    results.push(
      await runCase(
        'S3-RD-HTTP-01-ordinary-operator-and-release-boundary',
        async () => {
          await desk.refresh();
          const state = desk.getSnapshot();
          requireCondition(
            state.access === 'ready',
            'operator desk was not ready',
          );
          requireCondition(
            state.coverage && state.coverage.packages.length === 0,
            'empty coverage was not shown',
          );
          requireCoverage(state.coverage, 'empty coverage');
        },
      ),
    );

    results.push(
      await runCase('S3-RD-HTTP-02-import-repeat-and-safe-detail', async () => {
        const before = registryCounts(await curriculumFixtures.inspect());
        desk.setImportText(JSON.stringify(FIXTURE));
        await desk.importPackage();
        const imported = desk.getSnapshot();
        requireCondition(
          imported.detail?.testFixture === true,
          'import did not select fixture detail',
        );
        requireFixtureSummary(imported.coverage, 'fixture coverage');
        requireCondition(
          imported.detail.reviews.length === 0,
          'new fixture unexpectedly had review history',
        );
        requireCondition(
          !('requestDigest' in imported.detail) &&
            !('writeId' in imported.detail),
          'detail leaked internal fields',
        );
        for (const body of detailBodies) {
          requireCondition(
            !containsForbiddenKey(body),
            'raw detail response exposed private registry fields',
          );
        }
        const afterFirst = registryCounts(await curriculumFixtures.inspect());
        requireCondition(
          afterFirst.revision === before.revision + 1 &&
            afterFirst.packages === before.packages + 1 &&
            afterFirst.audit === before.audit + 1,
          'import did not append one registry event',
        );

        desk.setImportText(JSON.stringify(FIXTURE));
        await desk.importPackage();
        const repeated = desk.getSnapshot();
        requireCondition(
          repeated.notice.includes('already imported'),
          'exact import repeat was not identified',
        );
        const afterRepeat = registryCounts(await curriculumFixtures.inspect());
        requireCondition(
          JSON.stringify(afterRepeat) === JSON.stringify(afterFirst),
          'exact import repeat changed registry counts',
        );
      }),
    );

    results.push(
      await runCase(
        'S3-RD-HTTP-03-rejected-review-correction-and-stale-head',
        async () => {
          const beforeReviewRequests = requestLog.length;
          draftFor(
            desk,
            'rejected',
            'Synthetic rejection for isolated review desk.',
            'synthetic-reviewer-one',
          );
          await desk.submitReview();
          let detail = latestDetail(desk, 'first rejection detail');
          requireCondition(
            detail.reviews.length === 1 &&
              detail.reviews[0].decision === 'rejected',
            'first rejection was not saved',
          );
          const firstReview = structuredClone(detail.reviews[0]);

          draftFor(
            desk,
            'rejected',
            'Synthetic correction for isolated review desk.',
            'synthetic-reviewer-two',
          );
          await desk.submitReview();
          detail = latestDetail(desk, 'correction detail');
          requireCondition(
            detail.reviews.length === 2 &&
              detail.reviews[1].previousReviewId === detail.reviews[0].reviewId,
            'correction did not append current predecessor',
          );
          requireCondition(
            detail.reviews[0].reason !== detail.reviews[1].reason,
            'correction changed the original review',
          );
          const firstRequest = JSON.parse(requestLog[beforeReviewRequests]);
          const correctionRequest = JSON.parse(
            requestLog[beforeReviewRequests + 1],
          );
          requireCondition(
            firstRequest.requestId !== correctionRequest.requestId &&
              correctionRequest.previousReviewId === firstRequest.requestId,
            'correction did not prepare a new request against the first review',
          );
          const beforeStale = await curriculumFixtures.inspect();
          registryCounts(beforeStale);

          const stale = reviewBody(detail, 'desk-stale-review', {
            previousReviewId: null,
          });
          await expectClientError(
            () => client.recordCurriculumReview(FIXTURE.lessonVersion, stale),
            409,
            'STALE_REVIEW',
            'stale predecessor',
          );
          const after = await client.getCurriculumDetail(FIXTURE.lessonVersion);
          requireCondition(
            after.reviews.length === 2 &&
              JSON.stringify(after.reviews[0]) === JSON.stringify(firstReview),
            'stale predecessor changed review history',
          );
          const afterStale = await curriculumFixtures.inspect();
          registryCounts(afterStale);
          requireCondition(
            JSON.stringify(afterStale) === JSON.stringify(beforeStale),
            'stale predecessor changed registry rows',
          );
        },
      ),
    );

    results.push(
      await runCase(
        'S3-RD-HTTP-04-approval-checklist-and-provenance-gates',
        async () => {
          const detail = latestDetail(desk, 'approval detail');
          requireCondition(
            !hasCompleteProvenance(FIXTURE),
            'approval fixture unexpectedly has complete provenance',
          );
          const before = registryCounts(await curriculumFixtures.inspect());
          const checklistInvalid = reviewBody(
            detail,
            'desk-invalid-checklist',
            {
              decision: 'approved',
              checklist: allChecklist(false),
            },
          );
          await expectClientError(
            () =>
              pilotClient.pilotRequest(
                `/api/pilot/curriculum/${encodeURIComponent(FIXTURE.lessonVersion)}/reviews`,
                {
                  method: 'POST',
                  body: JSON.stringify(checklistInvalid),
                },
              ),
            400,
            'INVALID_REQUEST',
            'approval checklist gate',
          );
          const provenanceInvalid = reviewBody(
            detail,
            'desk-invalid-provenance',
            {
              decision: 'approved',
              checklist: allChecklist(true),
            },
          );
          await expectClientError(
            () =>
              client.recordCurriculumReview(
                FIXTURE.lessonVersion,
                provenanceInvalid,
              ),
            409,
            'PROVENANCE_INCOMPLETE',
            'approval provenance gate',
          );
          const after = await client.getCurriculumDetail(FIXTURE.lessonVersion);
          requireCondition(
            after.reviews.length === detail.reviews.length,
            'invalid approval changed history',
          );
          const afterCounts = registryCounts(
            await curriculumFixtures.inspect(),
          );
          requireCondition(
            JSON.stringify(afterCounts) === JSON.stringify(before),
            'invalid approval changed registry revision or audit',
          );
        },
      ),
    );

    results.push(
      await runCase('S3-RD-HTTP-05-uncertain-write-exact-replay', async () => {
        const before = registryCounts(await curriculumFixtures.inspect());
        draftFor(
          desk,
          'rejected',
          'Synthetic uncertain-write decision.',
          'synthetic-reviewer-three',
        );
        const beforeRequests = requestLog.length;
        adapter.setDropNextReviewResponse();
        await desk.submitReview();
        const uncertain = desk.getSnapshot();
        requireCondition(
          uncertain.retryAvailable &&
            uncertain.errorCode === 'NETWORK_UNAVAILABLE',
          'uncertain write did not retain retry state',
        );
        await desk.retryReview();
        const recovered = latestDetail(desk, 'recovered replay detail');
        requireCondition(
          recovered.reviews.length === before.reviews + 1,
          'uncertain write replay changed review count more than once',
        );
        requireCondition(
          requestLog.length === beforeRequests + 2 &&
            requestLog[beforeRequests] === requestLog[beforeRequests + 1],
          'retry did not reuse the exact attempted body',
        );
        const after = registryCounts(await curriculumFixtures.inspect());
        requireCondition(
          after.revision === before.revision + 1 &&
            after.reviews === before.reviews + 1 &&
            after.audit === before.audit + 1,
          'uncertain replay did not preserve one revision/audit',
        );
      }),
    );

    results.push(
      await runCase(
        'S3-RD-HTTP-06-missing-selection-and-session-revocation',
        async () => {
          await desk.select('missing-review-desk-version');
          const missing = desk.getSnapshot();
          requireCondition(
            missing.errorCode === 'NOT_FOUND' && missing.detail === null,
            'missing explicit version selected fallback content',
          );
          await desk.select(FIXTURE.lessonVersion);
          draftFor(
            desk,
            'rejected',
            'Private draft cleared by session revocation.',
            'synthetic-private-reviewer',
          );
          await revokeAccount(account.id);
          await desk.refresh();
          const denied = desk.getSnapshot();
          requireCondition(
            denied.access === 'denied' &&
              denied.detail === null &&
              denied.selectedVersion === '',
            'revoked session retained private review state',
          );
          requireCondition(
            !denied.draft.reviewerRef &&
              !denied.draft.evidenceRef &&
              !denied.draft.reason,
            'revoked session retained private draft fields',
          );
        },
      ),
    );
  } finally {
    desk?.dispose();
    globalThis.fetch = originalFetch;
  }
  return results;
}
