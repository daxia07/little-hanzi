// Independent external tester: real ordinary HTTP/SQL/browser boundaries only.
// Run only after lead schedules this candidate. Never added to its signed proof.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const flags = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (i % 2 === 0) pairs.push([value, all[i + 1]]);
    return pairs;
  }, []),
);
assert.equal(
  flags['--scheduled'],
  'yes',
  'Lead must schedule this external tester',
);
for (const k of ['--handoff', '--output', '--candidate', '--tester-sha256'])
  assert(flags[k], k);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const testerFile = path.resolve(import.meta.filename);
assert.equal(hash(await fs.readFile(testerFile)), flags['--tester-sha256']);
const handoffPath = path.resolve(flags['--handoff']);
const handoffStat = await fs.lstat(handoffPath);
assert(handoffStat.isFile() && !handoffStat.isSymbolicLink());
assert.equal(handoffStat.mode & 0o077, 0, 'Private handoff required');
assert.equal(handoffStat.uid, process.getuid(), 'Owned handoff required');
assert(handoffStat.size > 0 && handoffStat.size <= 1048576);
const h = JSON.parse(await fs.readFile(handoffPath, 'utf8'));
assert.equal(h.candidateId, flags['--candidate']);
assert.equal(new URL(h.baseURL).hostname, '127.0.0.1');
const manifest = JSON.parse(await fs.readFile(h.manifest, 'utf8'));
assert.equal(manifest.candidateId, h.candidateId);
assert.equal(h.buildId, manifest.candidateId);
assert.equal(await fs.realpath(h.snapshot), manifest.snapshot);
assert.equal(path.dirname(h.output), manifest.output);
assert(/^story-runtime-\d+$/.test(path.basename(h.output)));
assert.equal(await fs.realpath(h.output), h.output);
assert.equal(handoffPath, path.join(h.output, 'handoff.json'));
assert.equal(await fs.realpath(handoffPath), handoffPath);
const publicOutput = path.resolve(flags['--output']);
const publicParent = path.resolve('outputs/qa/readiness-r3/client-recovery');
assert.equal(path.dirname(publicOutput), publicParent);
assert.equal(await fs.realpath(publicParent), publicParent);
const output = path.join(
  manifest.work,
  `external-client-recovery-${crypto.randomUUID()}`,
);
const helperNames = [
  'scripts/readiness-node-runner.mjs',
  'scripts/owned-cdp.mjs',
  'tests/readiness-r3/runtime-adapter.mjs',
];
const helperHashes = Object.fromEntries(
  await Promise.all(
    helperNames.map(async (f) => [
      f,
      hash(await fs.readFile(path.join(h.snapshot, f))),
    ]),
  ),
);
const { verifyNodeManifest } = await import(
  pathToFileURL(path.join(h.snapshot, helperNames[0])).href
);
const { connectOwnedChrome } = await import(
  pathToFileURL(path.join(h.snapshot, helperNames[1])).href
);
const { createRuntimeAdapter } = await import(
  pathToFileURL(path.join(h.snapshot, helperNames[2])).href
);
verifyNodeManifest(manifest, { built: true });
await fs.mkdir(output, { recursive: false, mode: 0o700 });
await fs.mkdir(publicOutput, { recursive: false, mode: 0o700 });
const api = await createRuntimeAdapter({ handoff: h, output });
async function verify() {
  verifyNodeManifest(manifest, { built: true });
  await api.verifyFrozenIdentity();
  for (const f of helperNames)
    assert.equal(
      hash(await fs.readFile(path.join(h.snapshot, f))),
      helperHashes[f],
    );
  assert.equal(hash(await fs.readFile(testerFile)), flags['--tester-sha256']);
}
const report = {
  schemaVersion: 'r3-external-client-recovery-1',
  candidateId: h.candidateId,
  sourceDigest: h.sourceDigest,
  artifactDigest: h.artifactDigest,
  buildId: h.buildId,
  installationId: h.evidenceInstallationId,
  namespace: h.namespace,
  testerHashes: {
    [path.relative(process.cwd(), testerFile)]: flags['--tester-sha256'],
    ...helperHashes,
  },
  cases: [],
  limitations: [
    'Synthetic browser speech boundary only; no human pronunciation claim.',
    'External evidence is separate from signed base proof.',
  ],
};
const owned = [];
const privateValues = new Set();
const safeMessage = (error) => {
  let message = String(error?.message ?? 'External tester failed');
  for (const value of privateValues)
    if (value) message = message.split(value).join('[redacted]');
  return message;
};
const heldReleases = new Set();
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let connection;
const route = (id) =>
  `/api/pilot/curriculum/learning-runs/${encodeURIComponent(id)}`;
const read = (f) => api.readRunThroughHTTP(f.child, f.runId);
async function action(f, type, payload = {}) {
  const v = await read(f);
  const r = await api.request(f.child, 'POST', route(f.runId) + '/actions', {
    eventId: crypto.randomUUID(),
    expectedRevision: v.revision,
    stepId: v.state.stepId,
    type,
    payload,
  });
  assert.equal(r.status, 200);
  return r.body;
}
async function makeBrowser(f) {
  connection ||= await connectOwnedChrome(h.cdpURL);
  const context = await connection.browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  owned.push(context);
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    const active = new Set();
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [
          { name: 'Tingting', lang: 'zh-CN', localService: true },
        ],
        cancel: () => active.clear(),
        speak: (u) => {
          active.add(u);
          queueMicrotask(() => {
            if (active.has(u)) {
              u.onstart?.({});
              setTimeout(() => {
                if (active.has(u)) u.onend?.({});
              }, 30);
            }
          });
        },
      },
    });
  });
  const page = await context.newPage();
  const credentials = JSON.parse(await fs.readFile(h.credentialsFile, 'utf8'));
  privateValues.add(credentials.token);
  for (const a of credentials.accounts) privateValues.add(a.password);
  const account = credentials.accounts.find((a) => a.id === f.child.id);
  assert(account);
  await page.goto(h.baseURL);
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/api/auth/sign-in/username',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const r = await response;
    if (r.status() !== 429) {
      assert.equal(r.status(), 200);
      break;
    }
    assert(attempt < 2, 'Ordinary rate limit exhausted bounded retries');
    const seconds = Number(r.headers()['retry-after']) || 61;
    report.cases.push({
      id: `ordinary-auth-cooldown-${report.cases.length}`,
      outcome: 'OBSERVED',
      status: 429,
      cooldownSeconds: seconds,
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.ceil(seconds) * 1000),
    );
  }
  await open(page, f);
  return { context, page };
}
const control = (p, name) => p.locator(`[data-control="${name}"]`);
async function open(page, f) {
  await page.locator('[data-role="child-story"]').waitFor();
  await page
    .locator(
      `[data-assignment-id="${f.assignmentId}"] [data-control="continue-story"]`,
    )
    .click();
  await page.locator(`#story-activity[data-run-id="${f.runId}"]`).waitFor();
  await page
    .locator('[data-save-state="saved"], [data-save-state="pending"]')
    .waitFor();
}
async function saved(p) {
  await p.locator('[data-save-state="saved"]').waitFor();
}
async function noAccept(p) {
  const b = control(p, 'accept-conflict');
  if (await b.count()) assert(await b.isDisabled());
}
async function runCase(id, fn) {
  await verify();
  try {
    const evidence = await fn();
    await verify();
    report.cases.push({ id, outcome: 'PASS', ...evidence });
  } catch (error) {
    report.cases.push({
      id,
      outcome: error.message.includes(
        'Ordinary rate limit exhausted bounded retries',
      )
        ? 'BLOCKED'
        : 'FAIL',
      message: safeMessage(error),
    });
    process.exitCode = 1;
  } finally {
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}
const suite = async () => {
  await runCase('C-R01-accepted-answer-lost-reload-exact-retry', async () => {
    const f = await api.familyFixture('external-lost-answer');
    await action(f, 'continue');
    const { page } = await makeBrowser(f),
      before = await read(f);
    assert.equal(before.state.questionId, 'fam-mu');
    let original, accepted;
    const target = h.baseURL + route(f.runId) + '/actions';
    const lose = async (r) => {
      original = r.request().postDataJSON();
      const actual = await r.fetch();
      assert.equal(actual.status(), 200);
      accepted = await actual.json();
      await r.abort('failed');
    };
    await page.route(target, lose);
    await control(page, 'cue').click();
    await page
      .locator('[data-question-id="fam-mu"] [data-choice-id="mu"]')
      .click();
    await page.locator('[data-save-state="pending"]').waitFor();
    assert.equal(original.type, 'answer');
    await page.unroute(target, lose);
    const committed = await read(f);
    assert.equal(committed.revision, before.revision + 1);
    const trace = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === route(f.runId)) trace.push(r.method());
    });
    await page.reload();
    await open(page, f);
    assert(
      trace.includes('GET'),
      'Reload opens authenticated authoritative run GET',
    );
    const posts = [];
    page.on('request', (r) => {
      if (r.url() === target && r.method() === 'POST')
        posts.push(r.postDataJSON());
    });
    await control(page, 'retry-save').click();
    await saved(page);
    assert.deepEqual(posts, [original]);
    const sql = await api.inspectRun(f.runId),
      after = await read(f);
    assert.equal(after.revision, committed.revision);
    assert.equal(
      sql.events.filter((e) => e.event_id === original.eventId).length,
      1,
    );
    assert.equal(
      sql.audits.filter(
        (a) =>
          a.event_id ===
          sql.events.find((e) => e.event_id === original.eventId).id,
      ).length,
      1,
    );
    return {
      ears: ['012', '013'],
      runId: f.runId,
      eventId: original.eventId,
      revision: after.revision,
      ackRevision: accepted.ack.revision,
      reloadGet: true,
      exactRetry: true,
      events: 1,
    };
  });
  await runCase('C-R02-saved-recap-get-outage-get-only-retry', async () => {
    const f = await api.familyFixture('external-report-outage');
    const next = () => action(f, 'continue');
    const answer = (q, c) =>
      action(f, 'answer', { questionId: q, choiceId: c });
    await next();
    for (const [q, c] of [
      ['fam-mu', 'mu'],
      ['fam-lin', 'lin'],
    ]) {
      await answer(q, c);
      await next();
    }
    await next();
    await action(f, 'place-component', { componentId: 'mu-a', slot: 'left' });
    await action(f, 'place-component', { componentId: 'mu-b', slot: 'right' });
    await next();
    for (const [q, c] of [
      ['find-mu', 'mu'],
      ['find-lin', 'lin'],
    ]) {
      await answer(q, c);
      await next();
    }
    await next();
    await next();
    for (const [q, c] of [
      ['check-mu-sound', 'mu'],
      ['check-lin-sound', 'lin'],
      ['check-mu-reading', 'audio-mu'],
    ]) {
      await answer(q, c);
      await next();
    }
    await answer('check-lin-reading', 'audio-lin');
    const { page } = await makeBrowser(f),
      before = await read(f);
    const requests = [];
    page.on('request', (r) => {
      if (r.url().startsWith(h.baseURL + route(f.runId)))
        requests.push({ method: r.method(), path: new URL(r.url()).pathname });
    });
    const target = h.baseURL + route(f.runId),
      fail = async (r) => {
        if (r.request().method() === 'GET')
          await r.fulfill({
            status: 503,
            contentType: 'application/json',
            headers: { 'cache-control': 'no-store' },
            body: JSON.stringify({
              error: {
                code: 'CONTROLLED_READBACK_OUTAGE',
                message: 'Synthetic browser readback transport outage',
              },
            }),
          });
        else await r.continue();
      };
    await page.route(target, fail);
    await control(page, 'continue').click();
    await page.locator('[data-save-state="readback-pending"]').waitFor();
    assert.equal(
      await page.locator('[data-category]').count(),
      0,
      'No recap counts displayed without authoritative GET',
    );
    const committed = await read(f);
    assert.equal(committed.revision, before.revision + 1);
    assert.equal(committed.state.stepId, 'recap');
    await page.unroute(target, fail);
    const checkpoint = requests.length;
    await control(page, 'retry-report').click();
    await saved(page);
    await page.locator('[data-category]').first().waitFor();
    assert(requests.slice(checkpoint).some((r) => r.method === 'GET'));
    assert(!requests.slice(checkpoint).some((r) => r.method === 'POST'));
    const after = await read(f),
      sql = await api.inspectRun(f.runId);
    assert.equal(after.revision, committed.revision);
    assert.equal(sql.events.length, after.events.length);
    return {
      ears: ['013'],
      runId: f.runId,
      revision: after.revision,
      reportHiddenDuringOutage: true,
      retryMethods: requests.slice(checkpoint).map((r) => r.method),
    };
  });
  await runCase('C-R03-two-tab-conflict-held-authoritative-get', async () => {
    const f = await api.familyFixture('external-two-tabs'),
      { context, page: a } = await makeBrowser(f),
      b = await context.newPage();
    await b.goto(h.baseURL);
    await open(b, f);
    await control(a, 'sound-check').click();
    await control(a, 'sound-heard').click();
    await control(b, 'sound-check').click();
    await control(b, 'sound-heard').click();
    const target = h.baseURL + route(f.runId);
    let mode = 'fail',
      release,
      arrivedResolve;
    const arrived = new Promise((resolve) => (arrivedResolve = resolve));
    const held = new Promise((resolve) => (release = resolve));
    heldReleases.add(release);
    const gate = async (r) => {
      if (mode === 'fail')
        await r.fulfill({
          status: 503,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: '{}',
        });
      else {
        const actual = await r.fetch();
        assert.equal(actual.status(), 200);
        arrivedResolve();
        await held;
        await r.fulfill({ response: actual });
      }
    };
    await b.route(target, gate);
    const before = await read(f);
    await control(a, 'continue').click();
    await saved(a);
    const stale = b.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url() === target + '/actions',
    );
    await control(b, 'continue').click();
    assert.equal((await stale).status(), 409);
    await b.locator('[data-save-state="conflict"]').waitFor();
    await noAccept(b);
    mode = 'hold';
    await control(b, 'refresh-run').click();
    await bounded(arrived, 30000, 'Held authoritative GET arrival');
    await noAccept(b);
    const sqlBefore = await api.inspectRun(f.runId);
    assert.equal(sqlBefore.run.revision, before.revision + 1);
    release();
    await b.locator('[data-control="accept-conflict"]:enabled').waitFor();
    await control(b, 'accept-conflict').click();
    await saved(b);
    const after = await read(f),
      sql = await api.inspectRun(f.runId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(sql.events.length, sqlBefore.events.length);
    await b.unroute(target, gate);
    return {
      ears: ['012', '013'],
      runId: f.runId,
      revision: after.revision,
      staleStatus: 409,
      acceptBlockedUntilGET: true,
      noResend: true,
    };
  });
};
try {
  await bounded(suite(), 900000, 'External client recovery suite');
} catch (error) {
  report.failure = safeMessage(error);
  process.exitCode = 1;
} finally {
  for (const release of heldReleases) release();
  const cleanup = await Promise.allSettled(
    owned.map(async (context) => {
      try {
        for (const page of context.pages())
          await bounded(
            page.unrouteAll({ behavior: 'wait' }),
            10000,
            'Owned route cleanup',
          );
      } finally {
        await bounded(context.close(), 10000, 'Owned context close');
      }
    }),
  );
  report.cleanupFailures = cleanup
    .filter((r) => r.status === 'rejected')
    .map((r) => safeMessage(r.reason));
  connection?.disconnect();
  await bounded(api.cleanupOwnedContexts(), 10000, 'Frozen adapter cleanup');
  report.cdpOwnership = connection?.metadata;
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  // This report contains only asserted synthetic IDs/counts, identity hashes and
  // fault outcomes. Do not copy private adapter artifacts or credential files.
  await fs.writeFile(
    path.join(publicOutput, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
}
