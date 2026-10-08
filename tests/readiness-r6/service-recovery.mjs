/** Real owned-browser response faults; server commits and SQL readback stay real. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectOwnedChrome } from '../../scripts/owned-cdp.mjs';
import { literalNextAction } from './learning-support.mjs';
export function trackRecoveryTask(start, tasks, onError) {
  const task = Promise.resolve().then(start).catch(onError);
  tasks.add(task);
  void task.then(() => tasks.delete(task));
  return task;
}
export async function waitRecoveryArrival(promise, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('RECOVERY_HANDLER_WAIT_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runServiceRecovery(http, binding, oracles, evidence) {
  const h = http.handoff,
    f = h.families[6],
    item = binding.items[0];
  const route = '/api/pilot/children/' + f.childId,
    query = '?corpusVersion=' + encodeURIComponent(h.corpusVersion);
  assert.equal(
    (
      await http.request(f.parentId, 'PUT', route + '/onboarding', {
        nickname: 'Synthetic recovery learner',
        experience: 'new',
        audioReady: true,
      })
    ).status,
    200,
  );
  const previous = await http.request(
    f.parentId,
    'GET',
    route + '/placement' + query,
  );
  assert.equal(previous.status, 200);
  const catalog = await http.request(
    f.parentId,
    'GET',
    route +
      '/catalog' +
      query +
      '&q=' +
      encodeURIComponent(
        oracles.find((o) => o.lessonVersion === item.lessonVersion).targets[0]
          .hanzi,
      ),
  );
  assert.equal(catalog.status, 200);
  const selected = catalog.body.items.find(
    (x) => x.lessonVersion === item.lessonVersion,
  );
  assert(selected);
  const proposed = await http.request(
    f.parentId,
    'POST',
    route + '/catalog/proposals',
    {
      corpusVersion: h.corpusVersion,
      selection: {
        lessonVersion: selected.lessonVersion,
        contentDigest: selected.contentDigest,
        releaseId: selected.releaseId,
        releaseRevision: selected.releaseRevision,
      },
      predecessorProposalId: previous.body.proposal?.proposalId ?? null,
      expectedSourceDigest: previous.body.proposal?.sourceDigest ?? null,
    },
  );
  assert.equal(proposed.status, 200);
  const approved = await http.request(
    f.parentId,
    'POST',
    route + '/placement/approve',
    {
      proposalId: proposed.body.proposal.proposalId,
      sourceDigest: proposed.body.proposal.sourceDigest,
    },
  );
  assert.equal(approved.status, 200);
  const assignmentId = approved.body.plan.items.find(
    (x) => x.lessonVersion === item.lessonVersion,
  ).assignmentId;
  const assigned = await http.inspect({ kind: 'assignment', assignmentId });
  assert.equal(assigned.assignment.id, assignmentId);
  const initial = assigned.schedules.filter(
    (s) => s.kind === 'initial' && s.assignmentId === assignmentId,
  );
  assert.equal(initial.length, 1);
  const scheduleId = initial[0].id;
  const oracle = oracles.find((o) => o.lessonVersion === item.lessonVersion);
  let connection, context, page, runId, cleanupError, result;
  let phase = 'setup';
  const releases = [];
  const handlers = new Set(),
    findings = [],
    handlerErrors = [];
  const control = (name) => page.locator('[data-control="' + name + '"]');
  const waitState = (state) =>
    page
      .locator('[data-role="corpus-run"][data-save-state="' + state + '"]')
      .waitFor({ state: 'visible' });
  const stored = () => http.inspect({ kind: 'run', runId });
  const read = async () => {
    const r = await http.request(
      f.childId,
      'GET',
      '/api/pilot/curriculum/learning-runs/' + runId,
    );
    assert.equal(r.status, 200);
    return r.body;
  };
  function install(pattern, handler) {
    return page.route(pattern, (route) => {
      const requestPhase = phase;
      const method = route.request().method();
      const pathname = new URL(route.request().url()).pathname;
      return trackRecoveryTask(
        () => handler(route),
        handlers,
        (error) => {
          handlerErrors.push({
            phase: requestPhase,
            currentPhase: phase,
            pattern,
            method,
            pathname,
            name: error.name,
            message: String(error.message).slice(0, 500),
          });
        },
      );
    });
  }
  async function trigger(view) {
    if (view.question?.status === 'open')
      await control('corpus-without-sound').click();
    else await control('corpus-next').click();
  }
  try {
    connection = await connectOwnedChrome(h.cdpURL);
    context = await connection.browser.newContext({
      viewport: { width: 820, height: 1180 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    const session = await context.newCDPSession(page),
      info = (await session.send('Target.getTargetInfo')).targetInfo;
    evidence('recovery-owned-native-ids', {
      browserContextId: info.browserContextId,
      targetId: info.targetId,
    });
    await session.detach();
    await page.goto(h.baseURL);
    const account = h.accounts.find((x) => x.id === f.childId);
    await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/auth/sign-in/username',
      );
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const r = await response;
      if (r.status() === 429 && attempt < 2) {
        const seconds = Number(r.headers()['retry-after']);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Number.isFinite(seconds) && seconds > 0
              ? Math.min(120000, seconds * 1000 + 100)
              : 61000,
          ),
        );
        continue;
      }
      assert.equal(r.status(), 200);
      break;
    }
    await page
      .locator('[data-role="corpus-child-home"][data-home-state="ready"]')
      .waitFor({ state: 'visible' });
    const slot = page.locator(
      '[data-schedule-id="' + scheduleId + '"][data-phase="initial"]',
    );
    await slot.locator('[data-control="corpus-start"]').click();
    await waitState('saved');
    runId = await page
      .locator('[data-role="corpus-run"]')
      .getAttribute('data-run-id');
    assert(runId);
    const actionPattern =
        '**/api/pilot/curriculum/learning-runs/' + runId + '/actions',
      getPattern = '**/api/pilot/curriculum/learning-runs/' + runId;
    let posted,
      intercepted = 0;
    phase = 'lost-accepted-response';
    await install(actionPattern, async (r) => {
      intercepted++;
      posted = r.request().postDataJSON();
      const response = await r.fetch();
      assert.equal(response.status(), 200);
      await r.abort('failed');
    });
    const before = await stored();
    await trigger(await read());
    await waitState('pending');
    assert.equal(intercepted, 1);
    assert(posted?.eventId);
    await page.unroute(actionPattern);
    const committed = await stored();
    assert.equal(committed.events.length, before.events.length + 1);
    const exactRetry = page.waitForRequest(
      (r) =>
        r.method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/' + runId + '/actions'),
    );
    await control('corpus-retry').click();
    assert.deepEqual(
      (await exactRetry).postDataJSON(),
      posted,
      'Retry changed immutable pending action body',
    );
    await waitState('saved');
    const retried = await stored();
    assert.equal(retried.events.length, committed.events.length);
    assert.equal(retried.run.revision, committed.run.revision);
    findings.push({
      id: 'lost-accepted-response',
      eventId: posted.eventId,
      exactRetryOneEvent: true,
    });
    let getFaults = 0,
      posts = 0;
    const countPost = (req) => {
      if (
        req.method() === 'POST' &&
        new URL(req.url()).pathname.endsWith('/' + runId + '/actions')
      )
        posts++;
    };
    page.on('request', countPost);
    phase = 'known-ack-readback-failure';
    await install(getPattern, async (r) => {
      if (r.request().method() === 'GET') {
        getFaults++;
        await r.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'QA_READ_UNAVAILABLE' } }),
        });
      } else await r.continue();
    });
    const knownBefore = await stored();
    await trigger(await read());
    await waitState('readback-pending');
    assert.equal(posts, 1);
    assert.equal(getFaults, 1);
    await page.unroute(getPattern);
    await control('corpus-retry').click();
    await waitState('saved');
    assert.equal(posts, 1);
    assert.equal((await stored()).events.length, knownBefore.events.length + 1);
    page.off('request', countPost);
    findings.push({
      id: 'known-ack-readback-failure',
      postCount: posts,
      getFaults,
      getOnlyRetry: true,
    });
    const stale = await read(),
      body = literalNextAction(stale, oracle, randomUUID());
    const other = await http.request(
      f.childId,
      'POST',
      '/api/pilot/curriculum/learning-runs/' + runId + '/actions',
      body,
    );
    assert.equal(other.status, 200);
    await trigger(stale);
    await waitState('conflict');
    await control('corpus-accept-saved').waitFor({ state: 'visible' });
    let release,
      arrived,
      held = 0;
    const arrival = new Promise((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    releases.push(release);
    phase = 'real-second-writer-conflict';
    await install(getPattern, async (r) => {
      held++;
      arrived();
      const response = await r.fetch();
      await gate;
      await r.fulfill({ response });
    });
    await control('corpus-refresh-conflict').click();
    await waitRecoveryArrival(arrival);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-control="corpus-accept-saved"]')
          ?.disabled === true,
    );
    assert.equal(held, 1);
    assert.equal(await control('corpus-accept-saved').isEnabled(), false);
    release();
    await Promise.allSettled(handlers);
    await page.unroute(getPattern);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-control="corpus-accept-saved"]')
          ?.disabled === false,
    );
    await control('corpus-accept-saved').click();
    await waitState('saved');
    assert.equal(
      Number(
        await page
          .locator('[data-role="corpus-run"]')
          .getAttribute('data-revision'),
      ),
      other.body.ack.revision,
    );
    findings.push({
      id: 'real-second-writer-conflict',
      heldRefresh: held,
      acceptDisabledWhileHeld: true,
      authoritativeRevision: other.body.ack.revision,
    });
    const signingOutBefore = await stored();
    let releaseLate,
      committedLate,
      latePosts = 0;
    const lateAccepted = new Promise((resolve) => {
      committedLate = resolve;
    });
    const lateGate = new Promise((resolve) => {
      releaseLate = resolve;
    });
    releases.push(releaseLate);
    phase = 'signout-late-response';
    await install(actionPattern, async (r) => {
      latePosts++;
      const response = await r.fetch();
      assert.equal(response.status(), 200);
      committedLate();
      await lateGate;
      await r.fulfill({ response });
    });
    await trigger(await read());
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-role="corpus-run"]')
          ?.getAttribute('data-save-state') === 'saving',
    );
    await waitRecoveryArrival(lateAccepted);
    const signOut = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/auth/sign-out',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    assert.equal((await signOut).status(), 200);
    releaseLate();
    await Promise.allSettled(handlers);
    await page.unroute(actionPattern);
    await page
      .getByLabel('Username', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-role="corpus-run"]').count(), 0);
    assert.equal(latePosts, 1);
    const afterSignOut = await stored();
    assert.equal(
      afterSignOut.events.length,
      signingOutBefore.events.length + 1,
    );
    findings.push({
      id: 'signout-late-response',
      lateCommittedPostCount: latePosts,
      privateViewAbsent: true,
    });
    result = {
      findings,
      provenance:
        'Actual HTTP, persisted events, owned Chrome; only response delivery/GET outage intercepted. No app or grading mock.',
    };
  } finally {
    for (const release of releases) release();
    let contextClosed = !context,
      disconnected = !connection;
    try {
      await waitRecoveryArrival(Promise.allSettled(handlers));
      if (page) await page.unrouteAll({ behavior: 'wait' });
      await waitRecoveryArrival(Promise.allSettled(handlers));
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        if (context) await context.close();
        contextClosed = true;
      } catch (error) {
        cleanupError ??= error;
      } finally {
        try {
          if (connection) connection.disconnect();
          disconnected = true;
        } catch (error) {
          cleanupError ??= error;
        }
        evidence('recovery-cleanup', {
          ownedBrowserContextsClosed: contextClosed,
          sharedBrowserDisconnected: disconnected,
          handlerErrors,
          completedFindings: findings,
          metadata: connection?.metadata ?? null,
          error: cleanupError
            ? String(cleanupError.message).slice(0, 500)
            : null,
        });
      }
    }
  }
  if (cleanupError) throw cleanupError;
  assert.equal(
    handlerErrors.length,
    0,
    'Unexpected recovery route delivery failure: ' +
      JSON.stringify(handlerErrors),
  );
  return result;
}
