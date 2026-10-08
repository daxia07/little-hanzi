/** Actual UI journey; only declared speech synthesis is stubbed. */
import assert from 'node:assert/strict';
import { connectOwnedChrome } from '../../scripts/owned-cdp.mjs';
import { browserSpeechFixture } from '../readiness-r2/speech-boundary.mjs';
import { literalChoice } from './oracle.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runServiceBrowser(http, oracles, execute, evidence) {
  const h = http.handoff;
  assert(h.cdpURL, 'Actual authorized CDP required for proof browser-family');
  let connection,
    context,
    page,
    closed = false,
    disconnected = false,
    cleanupError,
    mutationCount = 0;
  const contextCleanups = [];
  const control = (name) => page.locator('[data-control="' + name + '"]');
  async function signIn(id) {
    const account = h.accounts.find((x) => x.id === id);
    assert(account);
    await page.goto(h.baseURL);
    await page
      .getByLabel('Username', { exact: true })
      .waitFor({ state: 'visible' });
    await page.getByLabel('Username', { exact: true }).fill(account.username);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    for (let i = 0; i < 3; i++) {
      const pending = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/auth/sign-in/username',
      );
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const response = await pending;
      if (response.status() === 429 && i < 2) {
        const seconds = Number(response.headers()['retry-after']);
        await pause(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(120000, seconds * 1000 + 100)
            : 61000,
        );
        continue;
      }
      assert.equal(response.status(), 200);
      await page
        .getByRole('button', { name: 'Sign out', exact: true })
        .waitFor({ state: 'visible' });
      return;
    }
    assert.fail('Browser ordinary sign-in exhausted');
  }
  async function signOut() {
    const r = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/auth/sign-out',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    assert.equal((await r).status(), 200);
    await page
      .getByLabel('Username', { exact: true })
      .waitFor({ state: 'visible' });
  }
  async function mutate(button, run) {
    const old = Number(await run.getAttribute('data-revision'));
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/learning-runs\/[^/]+\/actions$/u.test(new URL(r.url()).pathname),
    );
    await button.click();
    assert.equal((await response).status(), 200);
    mutationCount++;
    await page.waitForFunction(
      ({ id, revision }) => {
        const el = document.querySelector('[data-role="corpus-run"]');
        return (
          el?.getAttribute('data-run-id') === id &&
          Number(el.getAttribute('data-revision')) > revision &&
          el.getAttribute('data-save-state') === 'saved'
        );
      },
      { id: await run.getAttribute('data-run-id'), revision: old },
    );
  }
  try {
    connection = await connectOwnedChrome(h.cdpURL);
    for (const rep of h.representatives)
      await execute(rep, 'browser-family', async () => {
        mutationCount = 0;
        let caseClosed = false;
        try {
          context = await connection.browser.newContext({
            viewport: { width: 820, height: 1180 },
          });
          await context.addInitScript(browserSpeechFixture);
          page = await context.newPage();
          page.setDefaultTimeout(20000);
          page.setDefaultNavigationTimeout(30000);
          const session = await context.newCDPSession(page);
          const { targetInfo } = await session.send('Target.getTargetInfo');
          evidence(rep.lessonVersion + '-browser-owned-native-ids', {
            browserContextId: targetInfo.browserContextId,
            targetId: targetInfo.targetId,
          });
          await session.detach();
          const family = h.families.find(
              (x) => x.index === rep.browserFamilyIndex,
            ),
            oracle = oracles.find((x) => x.lessonVersion === rep.lessonVersion);
          assert(family && oracle);
          const setup = await http.request(
            family.parentId,
            'PUT',
            '/api/pilot/children/' + family.childId + '/onboarding',
            {
              nickname: 'Synthetic browser learner',
              experience: 'new',
              audioReady: true,
            },
          );
          assert.equal(setup.status, 200);
          await signIn(family.parentId);
          await page
            .locator(
              '[data-role="corpus-parent-plan"][data-save-state="saved"]',
            )
            .waitFor({ state: 'visible' });
          await control('corpus-search').fill(oracle.targets[0].hanzi);
          await control('corpus-search-submit').click();
          const card = page.locator(
            '[data-role="corpus-catalog"] [data-lesson-version="' +
              rep.lessonVersion +
              '"]',
          );
          await card.waitFor({ state: 'visible' });
          const proposed = page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              new URL(r.url()).pathname.endsWith('/catalog/proposals'),
          );
          await card.locator('[data-control="corpus-select"]').click();
          assert.equal((await proposed).status(), 200);
          const approved = page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              new URL(r.url()).pathname.endsWith('/placement/approve'),
          );
          await control('corpus-approve').click();
          assert.equal((await approved).status(), 200);
          await page
            .locator('[data-role="corpus-approved-plan"]')
            .waitFor({ state: 'visible' });
          await signOut();
          await signIn(family.childId);
          await page
            .locator('[data-role="corpus-child-home"][data-home-state="ready"]')
            .waitFor({ state: 'visible' });
          const slot = page.locator(
            '[data-role="corpus-child-home"] [data-lesson-version="' +
              rep.lessonVersion +
              '"][data-phase="initial"]',
          );
          await slot.locator('[data-control="corpus-start"]').click();
          const run = page.locator(
            '[data-role="corpus-run"][data-save-state="saved"]',
          );
          await run.waitFor({ state: 'visible' });
          const runId = await run.getAttribute('data-run-id');
          mutationCount = 0;
          let terminalView;
          let unavailable = 0,
            answered = 0;
          for (let n = 0; n < 160; n++) {
            await run.waitFor({ state: 'visible' });
            const response = await page.request.get(
              h.baseURL + '/api/pilot/curriculum/learning-runs/' + runId,
            );
            assert.equal(response.status(), 200);
            const view = await response.json();
            assert.equal(view.lessonVersion, rep.lessonVersion);
            assert.equal(view.contentDigest, rep.contentDigest);
            assert.equal(
              Number(await run.getAttribute('data-revision')),
              view.revision,
            );
            if (view.state.completedAt) {
              terminalView = view;
              break;
            }
            if (view.question?.status === 'open') {
              const listens = run.locator('[data-control="corpus-listen"]');
              if (await listens.count()) {
                await listens.first().click();
                await pause(100);
              }
              const choice = literalChoice(view.question, oracle),
                button = run.locator(
                  '[data-choice-id="' + choice.choiceId + '"]',
                );
              if (await button.isEnabled()) {
                await mutate(button, run);
                answered++;
              } else {
                await mutate(
                  run.locator('[data-control="corpus-without-sound"]'),
                  run,
                );
                unavailable++;
              }
            } else
              await mutate(
                run.locator('[data-control="corpus-next"]').first(),
                run,
              );
            assert(n < 159, 'Finite browser lesson did not complete');
          }
          await run
            .locator('[data-evidence-group="check"]')
            .waitFor({ state: 'visible' });
          const screenshot = 'browser-' + rep.lessonVersion + '.png';
          await page.screenshot({
            path: evidence.path(screenshot),
            fullPage: false,
          });
          const saved = await http.inspect({ kind: 'run', runId });
          assert(terminalView?.state.completedAt);
          assert.equal(saved.run.runId, runId);
          assert.equal(saved.run.childId, family.childId);
          assert.equal(saved.run.lessonVersion, rep.lessonVersion);
          assert.equal(saved.run.contentDigest, rep.contentDigest);
          assert.equal(saved.run.installationId, h.installationId);
          assert.equal(saved.run.revision, terminalView.revision);
          assert.equal(saved.run.phase, 'initial');
          assert.equal(
            saved.run.completedAt,
            Date.parse(terminalView.state.completedAt),
          );
          assert.deepEqual(saved.run.recap, terminalView.recap);
          assert.equal(
            answered + unavailable,
            8,
            'Initial path must submit all eight scored occurrences',
          );
          assert.equal(saved.events.length, mutationCount);
          assert.equal(saved.receipts.length, mutationCount);
          assert.equal(
            saved.events.filter((e) => e.type === 'answer').length,
            answered,
          );
          assert.equal(
            saved.events.filter((e) => e.type === 'audio-unavailable').length,
            unavailable,
          );
          for (const e of saved.events.filter((e) => e.type === 'answer'))
            assert.equal(e.result.outcome, 'correct');
          for (const e of saved.events.filter(
            (e) => e.type === 'audio-unavailable',
          ))
            assert.equal(e.result.outcome, 'unavailable');
          await run
            .locator('[data-saved-recap]')
            .getByRole('button', { name: 'Learning home', exact: true })
            .click();
          await signOut();
          return {
            runId,
            answered,
            unavailable,
            sqlEventCount: saved.events.length,
            screenshot,
            speechProvenance:
              'declared synthetic browser SpeechSynthesis boundary only; no actual voice quality or file playback claim',
          };
        } finally {
          try {
            if (context) await context.close();
            caseClosed = true;
          } finally {
            contextCleanups.push({
              lessonVersion: rep.lessonVersion,
              closed: caseClosed,
            });
            evidence(rep.lessonVersion + '-browser-context-cleanup', {
              closed: caseClosed,
            });
            context = undefined;
            page = undefined;
          }
        }
      });
  } finally {
    let contextClosed = !context && contextCleanups.every((c) => c.closed);
    let transportDisconnected = !connection;
    try {
      if (context) await context.close();
      contextClosed = contextCleanups.every((c) => c.closed);
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        if (connection) connection.disconnect();
        transportDisconnected = true;
      } catch (error) {
        cleanupError ??= error;
      }
      evidence('browser-cleanup', {
        ownedBrowserContextsClosed: contextClosed,
        sharedBrowserDisconnected: transportDisconnected,
        contexts: contextCleanups,
        metadata: connection?.metadata ?? null,
        error: cleanupError ? String(cleanupError.message).slice(0, 500) : null,
      });
    }
    closed = contextClosed;
    disconnected = transportDisconnected;
  }
  if (cleanupError) throw cleanupError;
  return {
    ownedBrowserContextsClosed: closed,
    sharedBrowserDisconnected: disconnected,
  };
}
