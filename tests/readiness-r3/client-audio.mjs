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
  `external-client-audio-${crypto.randomUUID()}`,
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
  schemaVersion: 'r3-external-client-audio-1',
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
    window.__r3AudioUtterances = [];
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
          window.__r3AudioUtterances.push(u);
          queueMicrotask(() => {
            if (active.has(u)) {
              u.onstart?.({});
              // Explicit held speech: test invokes late error/end itself.
              // Browser audio timeout remains active, never faked as human media.
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

async function currentAnswer(f, page, { help = false } = {}) {
  await control(page, 'cue').click();
  await page.waitForFunction(() => window.__r3AudioUtterances?.length > 0);
  const cue = await page.evaluate(() => window.__r3AudioUtterances.length - 1);
  if (help) {
    await control(page, 'help').click();
    await saved(page);
  }
  await page
    .locator('[data-question-id="fam-mu"] [data-choice-id="mu"]')
    .click();
  await saved(page);
  const before = await read(f),
    sql = await api.inspectRun(f.runId);
  assert.equal(before.state.questionStatus, 'answered');
  assert.equal(before.recap.familiarity.unavailable, 0);
  assert.equal(before.recap.familiarity.independent, help ? 0 : 1);
  assert.equal(before.recap.familiarity.supported, help ? 1 : 0);
  return { cue, before, sql };
}
async function error(page, cue) {
  await page.evaluate(
    (i) =>
      window.__r3AudioUtterances[i].onerror?.({
        error: 'synthetic-late-error',
      }),
    cue,
  );
}
const suite = async () => {
  for (const help of [false, true])
    await runCase(
      help
        ? 'C-A02-assisted-first-preserved-late-failure'
        : 'C-A01-independent-answer-late-failure',
      async () => {
        const f = await api.familyFixture(
          help ? 'external-audio-help' : 'external-audio-late',
        );
        await action(f, 'continue');
        const { page } = await makeBrowser(f),
          { cue, before, sql } = await currentAnswer(f, page, { help });
        const accepted = page.waitForResponse(
          (r) =>
            r.url() === h.baseURL + route(f.runId) + '/actions' &&
            r.request().method() === 'POST',
        );
        await error(page, cue);
        assert.equal((await accepted).status(), 200);
        await saved(page);
        const after = await read(f),
          afterSql = await api.inspectRun(f.runId);
        assert.equal(after.revision, before.revision + 1);
        assert.equal(after.state.questionId, 'fam-mu');
        assert.equal(after.state.questionStatus, 'unavailable');
        assert.equal(after.state.attempts, before.state.attempts);
        assert.equal(after.state.hintLevel, before.state.hintLevel);
        assert.equal(after.state.assisted, before.state.assisted);
        assert.equal(after.recap.familiarity.unavailable, 1);
        assert.equal(after.recap.familiarity.independent, 0);
        assert.equal(after.recap.familiarity.supported, 0);
        assert.deepEqual(
          afterSql.events.slice(0, sql.events.length),
          sql.events,
        );
        assert.deepEqual(
          afterSql.audits.slice(0, sql.audits.length),
          sql.audits,
        );
        assert.equal(afterSql.events.length, sql.events.length + 1);
        assert.equal(afterSql.audits.length, sql.audits.length + 1);
        const last = JSON.parse(afterSql.events.at(-1).action_json);
        assert.equal(last.type, 'audio-unavailable');
        assert.equal(last.payload.questionId, 'fam-mu');
        return {
          ears: ['002', '012'],
          runId: f.runId,
          eventSequence: after.revision,
          help,
          firstAndHelpFactsPreserved: true,
          currentUnavailable: true,
          independent: 0,
        };
      },
    );
  await runCase(
    'C-A03-stale-callback-after-navigation-and-identity-lock',
    async () => {
      const f = await api.familyFixture('external-audio-stale');
      await action(f, 'continue');
      const { page } = await makeBrowser(f),
        { cue } = await currentAnswer(f, page);
      await control(page, 'continue').click();
      await saved(page);
      const before = await read(f),
        sql = await api.inspectRun(f.runId);
      assert.equal(before.state.questionId, 'fam-lin');
      const posts = [];
      page.on('request', (r) => {
        if (
          r.method() === 'POST' &&
          r.url() === h.baseURL + route(f.runId) + '/actions'
        )
          posts.push(r.postDataJSON());
      });
      await error(page, cue);
      await page.waitForTimeout(1500);
      const after = await read(f),
        afterSql = await api.inspectRun(f.runId);
      assert.equal(after.revision, before.revision);
      assert.equal(after.state.questionId, 'fam-lin');
      assert.equal(after.state.questionStatus, 'open');
      assert.deepEqual(afterSql.events, sql.events);
      assert.equal(posts.length, 0);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Sign in', exact: true })
        .waitFor();
      await error(page, cue);
      await page.waitForTimeout(1500);
      const locked = await read(f),
        lockedSql = await api.inspectRun(f.runId);
      assert.equal(locked.revision, before.revision);
      assert.deepEqual(lockedSql.events, sql.events);
      assert.equal(posts.length, 0);
      assert.equal(
        await page.locator(`#story-activity[data-run-id="${f.runId}"]`).count(),
        0,
      );
      return {
        ears: ['002', '012'],
        runId: f.runId,
        revision: locked.revision,
        staleAfterNavigationWrites: 0,
        staleAfterIdentityLockWrites: 0,
        noReopening: true,
      };
    },
  );
};
try {
  await bounded(suite(), 900000, 'External client audio suite');
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
