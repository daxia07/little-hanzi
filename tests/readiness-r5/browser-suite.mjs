// Actual UI-only interactions. Selectors must come from frozen public handoff.
import assert from 'node:assert/strict';
import { LESSONS, findPrintedTarget } from './oracle.mjs';
export async function runBrowserSuite(a) {
  const results = [];
  async function record(id, scenarios, fn) {
    try {
      results.push({ id, scenarios, outcome: 'PASS', evidence: await fn() });
    } catch (error) {
      results.push({ id, scenarios, outcome: 'FAIL', error: error.message });
    }
    await a.recordResults(results);
  }
  const selector = (name, values = {}) => {
    assert(a.publicControls[name], 'Missing frozen public selector ' + name);
    return Object.entries(values).reduce(
      (s, [key, value]) => s.replaceAll('{' + key + '}', String(value)),
      a.publicControls[name],
    );
  };
  await record(
    'B01-generic-family-keyboard',
    ['browser-family', 'recognition', 'ownership'],
    async () => {
      const f = await a.familyFixture('r5-browser');
      await a.signInThroughUI(f.parent);
      await a.recordOwnedBrowserIds();
      const page = a.page;
      await page.locator(selector('collectionChild')).selectOption(f.child.id);
      await page
        .locator(selector('collectionLesson'))
        .selectOption(a.lessonVersion ?? 'path-02-v1');
      const proposalResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname ===
            '/api/pilot/children/' + f.child.id + '/placement/proposals',
      );
      await page.locator(selector('collectionPropose')).click();
      const proposed = await proposalResponse;
      assert.equal(proposed.status(), 200);
      const proposal = (await proposed.json()).proposal;
      await page
        .locator(
          '[data-role=collection-plan] [data-proposal-id="' +
            proposal.proposalId +
            '"]',
        )
        .waitFor();
      const approvalResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname ===
            '/api/pilot/children/' + f.child.id + '/placement/approve',
      );
      await page.locator(selector('collectionApprove')).click();
      const approved = await approvalResponse;
      assert.equal(approved.status(), 200);
      const planId = (await approved.json()).plan.planId;
      assert(planId);
      await page
        .locator('[data-role=collection-plan] [data-plan-id="' + planId + '"]')
        .waitFor();
      await a.signInThroughUI(f.child);
      await page.locator(selector('practiceReady')).waitFor();
      const scheduled = await a.nextInitial(
        f.child,
        a.lessonVersion ?? 'path-02-v1',
        planId,
        f.parent,
      );
      await page
        .locator(
          selector('scheduleStart', {
            phase: 'initial',
            scheduleId: scheduled.scheduleId,
          }),
        )
        .click();
      await page.locator(selector('runSaved')).waitFor();
      let view = await a.readActiveRun(),
        iterations = 0;
      while (!view.state.completedAt) {
        assert(++iterations < 80);
        const q = view.question;
        const getPromise = page.waitForResponse(
          (r) =>
            r.request().method() === 'GET' &&
            new URL(r.url()).pathname.endsWith('/learning-runs/' + view.runId),
        );
        const ackPromise = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            new URL(r.url()).pathname.endsWith(
              '/learning-runs/' + view.runId + '/actions',
            ),
        );
        if (q?.status === 'open') {
          const index = view.lesson.targets.findIndex(
            (t) => t.characterId === q.characterId,
          );
          assert(index >= 0);
          const lesson = LESSONS.find((l) => l.version === view.lessonVersion);
          assert(lesson);
          if (q.requiresAudio) {
            await page.locator(selector('cue')).click();
            await page.locator(selector('audioStarted')).waitFor();
          }
          const choice = findPrintedTarget(q.choices, lesson.targets[index]);
          await page
            .locator(selector('choice', { choiceId: choice.choiceId }))
            .click();
        } else {
          const control = page.locator(selector('continue'));
          await control.focus();
          await page.keyboard.press('Enter');
        }
        const response = await ackPromise;
        assert.equal(response.status(), 200);
        const ack = (await response.json()).ack;
        const loaded = await getPromise;
        assert.equal(loaded.status(), 200);
        assert.equal((await loaded.json()).revision, ack.revision);
        await page.locator(selector('runSaved')).waitFor();
        view = await a.readActiveRun();
        assert.equal(view.revision, ack.revision);
      }
      assert.equal(view.lessonVersion, a.lessonVersion ?? 'path-02-v1');
      await a.captureAccessibleView('r5-ordinary-recap');
      return {
        runId: view.runId,
        phase: view.state.phase,
        lessonVersion: view.lessonVersion,
        method:
          'Real UI with declared test-only speech boundary; no pronunciation approval',
      };
    },
  );
  return results;
}
