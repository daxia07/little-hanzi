// Real UI case functions. Frozen runner provides owned page, public map and
// real sign-in helpers; no application controller/store is invoked by these tests.
import assert from 'node:assert/strict';
import { ROUTES, ANSWERS, CLEAN_FINAL } from './oracle.mjs';
export const BROWSER_ADAPTER_REQUIREMENTS = Object.freeze([
  'page',
  'publicControls',
  'signInThroughUI',
  'signOutThroughUI',
  'familyFixture',
  'inspectRun',
  'readRunThroughHTTP',
  'holdRealResponse',
  'currentIdentity',
  'readActiveRun',
  'requestsAfterIdentitySwitch',
  'reconcilePendingThroughUI',
]);
export function createBrowserCases(h) {
  const page = h.page;
  const control = (name) => {
    assert(h.publicControls[name], `Frozen public control missing: ${name}`);
    return page.locator(h.publicControls[name]);
  };
  async function keyboard(selector, key = 'Enter') {
    for (let i = 0; i < 120; i++) {
      if (
        await page.evaluate((s) => document.activeElement?.matches(s), selector)
      ) {
        const focus = await page.evaluate(() => {
          const s = getComputedStyle(document.activeElement);
          return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
        });
        assert(focus, 'Visible keyboard focus');
        if (key) await page.keyboard.press(key);
        return;
      }
      await page.keyboard.press('Tab');
    }
    throw Error(`Keyboard unreachable control ${selector}`);
  }
  async function click(name, keys = false) {
    if (keys) await keyboard(h.publicControls[name]);
    else await control(name).click();
  }
  async function story(keys = false) {
    const saved = () => page.locator('[data-save-state="saved"]').waitFor();
    async function submit(selector) {
      const ack = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          /\/api\/pilot\/curriculum\/learning-runs\/[^/]+\/actions$/.test(
            new URL(r.url()).pathname,
          ),
      );
      if (keys) await keyboard(selector);
      else await page.locator(selector).click();
      assert.equal((await ack).status(), 200);
      await saved();
    }
    const next = () => submit('[data-control="continue"]');
    async function answer(q, c) {
      if (c.startsWith('audio-')) {
        const selector = `[data-control="option-play"][data-option-id="${c}"]`;
        if (keys) await keyboard(selector, 'Space');
        else await page.locator(selector).click();
      } else if (!q.startsWith('find-')) await click('cue', keys);
      await submit(`[data-question-id="${q}"] [data-choice-id="${c}"]`);
    }
    await saved();
    await click('sound-check', keys);
    await click('sound-heard', keys);
    await next();
    for (const [q, c] of ROUTES.familiar.familiarity) {
      await answer(q, c);
      await next();
    }
    assert.equal(
      await page.locator('[data-learn-panel]').getAttribute('data-learn-panel'),
      'reminder',
    );
    await next();
    await submit('[data-piece-id="mu-a"][data-slot="left"]');
    assert(await control('continue').isDisabled());
    await submit('[data-piece-id="mu-b"][data-slot="right"]');
    await next();
    for (const q of ['find-mu', 'find-lin']) {
      await answer(q, ANSWERS[q]);
      await next();
    }
    await next();
    await next();
    for (const q of [
      'check-mu-sound',
      'check-lin-sound',
      'check-mu-reading',
      'check-lin-reading',
    ]) {
      await answer(q, ANSWERS[q]);
      await next();
    }
    await page.locator('[data-step="recap"]').waitFor();
    const active = await h.readActiveRun(),
      view = await h.readRunThroughHTTP(
        await h.currentIdentity(),
        active.runId,
      ),
      g = view.recap.immediate;
    assert.deepEqual(
      {
        total: g.total,
        independentCorrect: g.independent,
        supported: g.supported,
        unavailable: g.unavailable,
        pending: g.pending,
      },
      CLEAN_FINAL,
    );
    const sql = await h.inspectRun(view.runId);
    assert.equal(sql.run.revision, view.revision);
    assert.deepEqual(
      sql.events.map((e) => e.event_id),
      view.events.map((e) => e.eventId),
    );
    return view;
  }
  async function prepare(f, keys = false) {
    await h.signInThroughUI(f.parent, { keyboard: keys });
    await page.locator('[data-role="parent-story-plan"]').waitFor();
    await page.waitForFunction(() =>
      Boolean(
        document.querySelector(
          '[data-control="story-nickname"], [data-role="story-setup-summary"]',
        ),
      ),
    );
    const editSetup = page.locator('[data-control="edit-setup"]');
    if (await editSetup.isVisible()) await editSetup.click();
    await page.locator('[data-control="story-nickname"]').waitFor();
    if (!keys) await h.captureAccessibleView('parent-plan');
    if (keys) {
      await keyboard(h.publicControls['story-nickname'], null);
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('QA child');
    } else await control('story-nickname').fill('QA child');
    await click('sound-check', keys);
    await click('sound-heard', keys);
    async function committed(method, endpoint, action) {
      const pending = page.waitForResponse(
        (r) =>
          r.request().method() === method &&
          new URL(r.url()).pathname === endpoint,
      );
      await action();
      const response = await pending;
      assert.equal(
        response.status(),
        200,
        'Actual parent UI operation response',
      );
      return response.json();
    }
    await committed('PUT', `/api/pilot/children/${f.child.id}/onboarding`, () =>
      click('save-setup', keys),
    );
    await page.locator('[data-plan-save-state="saved"]').waitFor();
    const proposed = await committed(
      'POST',
      `/api/pilot/children/${f.child.id}/placement/proposals`,
      () => click('request-proposal', keys),
    );
    assert(proposed.proposal?.proposalId);
    await page
      .locator(`[data-proposal-id="${proposed.proposal.proposalId}"]`)
      .waitFor();
    assert.match(
      await page.locator('[data-role="parent-story-plan"]').innerText(),
      /starting suggestion/i,
    );
    const approved = await committed(
      'POST',
      `/api/pilot/children/${f.child.id}/placement/approve`,
      () => click('approve-plan', keys),
    );
    assert(approved.plan?.planId);
    assert.equal(approved.plan.proposalId, proposed.proposal.proposalId);
    await page.locator(`[data-plan-id="${approved.plan.planId}"]`).waitFor();
    await click('handover-signout', keys);
    await h.signInThroughUI(f.child, { keyboard: keys });
    const identity = await h.currentIdentity();
    assert.equal(identity.accountId, f.child.id);
    await page.locator('[data-role="child-story"]').waitFor();
    await page.waitForFunction(() => {
      const refresh = document.querySelector(
        '[data-control=refresh-child-story]',
      );
      return refresh && !refresh.disabled;
    });
    const assignment = approved.plan.items[0].assignmentId;
    assert(assignment);
    await page
      .locator(
        `[data-assignment-id="${assignment}"] [data-control="start-story"]`,
      )
      .waitFor({ state: 'visible' });
    if (!keys) await h.captureAccessibleView('child-home');
    await click('start-story', keys);
    await page.locator('[data-story-version="forest-01-v4"]').waitFor();
  }
  return [
    {
      id: 'B01-family-handover',
      ears: ['008', '009', '010', '015'],
      run: async () => {
        const f = await h.familyFixture('browser-handover');
        await prepare(f);
        const run = await story();
        await h.signOutThroughUI();
        await h.signInThroughUI(f.parent);
        await click('refresh-story-progress');
        await page.locator(`[data-story-run-id="${run.runId}"]`).waitFor();
        await h.captureAccessibleView('parent-progress');
        const actual = await h.readRunThroughHTTP(f.parent, run.runId);
        assert.equal(actual.revision, run.revision);
        const sql = await h.inspectRun(run.runId);
        assert.equal(sql.run.revision, actual.revision);
      },
    },
    {
      id: 'B09-keyboard-family',
      ears: ['019'],
      run: async () => {
        const f = await h.familyFixture('browser-keyboard');
        await prepare(f, true);
        await story(true);
      },
    },
    {
      id: 'B06-parent-late-child-response',
      ears: ['012'],
      run: async () => {
        const f = await h.familyFixture('browser-parent-switch');
        assert(
          f.parent.children.length >= 2,
          'Two linked synthetic children required',
        );
        await h.signInThroughUI(f.parent);
        const a = f.parent.children[0],
          b = f.parent.children[1];
        await control('story-child').selectOption(a.id);
        const held = await h.holdRealResponse({
          method: 'POST',
          path: `/api/pilot/children/${encodeURIComponent(a.id)}/placement/proposals`,
        });
        await click('request-proposal');
        await held.arrived;
        await control('story-child').selectOption(b.id);
        await page
          .locator(`[data-child-id="${b.id}"] [data-plan-save-state="saved"]`)
          .waitFor();
        await held.release();
        assert.equal(
          await page
            .locator(
              `[data-child-id="${b.id}"] [data-proposal-id="${held.body.proposal.proposalId}"]`,
            )
            .count(),
          0,
        );
      },
    },
    {
      id: 'B06-child-pending-identity-switch',
      ears: ['012', '013'],
      run: async () => {
        const f = await h.familyFixture('browser-child-switch');
        await prepare(f);
        const run = await h.readActiveRun();
        await click('sound-check');
        await click('sound-heard');
        const held = await h.holdRealResponse({
          method: 'POST',
          path: `/api/pilot/curriculum/learning-runs/${encodeURIComponent(run.runId)}/actions`,
        });
        await click('continue');
        await held.arrived;
        await h.signOutThroughUI();
        await h.signInThroughUI(f.otherChild);
        await held.release();
        assert.equal(
          await page.locator(`[data-run-id="${run.runId}"]`).count(),
          0,
        );
        const requests = await h.requestsAfterIdentitySwitch();
        assert(
          !requests.some(
            (r) => r.method === 'POST' && r.path.includes(run.runId),
          ),
          'Prior child queue not submitted under new identity',
        );
        await h.signOutThroughUI();
        await h.signInThroughUI(f.child);
        await click('continue-story');
        const authoritative = await h.readRunThroughHTTP(f.child, run.runId);
        await h.reconcilePendingThroughUI();
        const after = await h.readRunThroughHTTP(f.child, run.runId);
        assert.equal(
          after.revision,
          authoritative.revision,
          'Committed held response must not duplicate',
        );
      },
    },
  ];
}
