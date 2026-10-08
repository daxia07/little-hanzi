import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRuntimeAdapter } from './browser-suite.mjs';
import { createOpsUI } from './ui-adapter.mjs';
import { createControls } from './controls.mjs';
const [handoffFile, output] = process.argv.slice(2);
const h = JSON.parse(await readFile(handoffFile, 'utf8'));
await mkdir(output, { mode: 0o700 });
const infra = await createRuntimeAdapter({ handoff: h, output });
const privateData = JSON.parse(await readFile(h.credentialsFile, 'utf8'));
const control = createControls(h, privateData.token),
  results = [];
const save = () =>
  writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ candidateId: h.candidateId, results }, null, 2) + '\n',
  );
try {
  const f = await infra.familyFixture('r4-browser-extra');
  await infra.signInThroughUI(f.parent);
  const page = infra.page,
    run = { runId: f.runId, childId: f.child.id },
    ui = createOpsUI(page, run);
  await ui.waitAuthoritativeLoadedUI('saved-run-feedback');
  const form = page.locator(`[data-feedback-run-id="${f.runId}"]`),
    endpoint = `/api/pilot/children/${f.child.id}/feedback`;
  async function fill(label) {
    await form.locator('[data-control=report-problem]').click();
    await form
      .locator('[data-control=feedback-observed]')
      .fill('QA_PRIVATE_EXTRA_' + label);
    await form
      .locator('[data-control=feedback-expected]')
      .fill('Expected durable receipt');
  }
  // B01: real accepted POST, browser response loss, exact explicit retry.
  try {
    await fill('lost');
    let original, receipt;
    await page.route('**' + endpoint, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      original = route.request().postDataJSON();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      receipt = await response.json();
      await route.abort('failed');
    });
    await form.locator('[data-control=feedback-save]').click();
    await form.locator('[data-ops-write-state=retry]').waitFor();
    await page.unroute('**' + endpoint);
    const retry = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === endpoint &&
        r.request().method() === 'POST',
    );
    await form.locator('[data-control=write-retry]').click();
    const response = await retry;
    assert.deepEqual(response.request().postDataJSON(), original);
    assert.deepEqual(await response.json(), receipt);
    await form.locator('[data-ops-write-state=saved]').waitFor();
    const inspected = await control('/inspect', {
      kind: 'record',
      id: receipt.recordId,
    });
    assert.equal(inspected.body.matchingRequestCount, 1);
    assert.equal(inspected.body.matchingSubmissionEventCount, 1);
    results.push({
      id: 'B01-lost-accepted-exact-retry',
      outcome: 'PASS',
      recordId: receipt.recordId,
      matchingEvents: 1,
    });
  } catch (error) {
    results.push({
      id: 'B01-lost-accepted-exact-retry',
      outcome: 'FAIL',
      error: error.message,
    });
  }
  await save();
  // B02: accepted held response then actual sign-out cannot reopen old form.
  try {
    await form.locator('[data-control=feedback-new]').click();
    await form
      .locator('[data-control=feedback-observed]')
      .fill('QA_PRIVATE_EXTRA_late');
    await form
      .locator('[data-control=feedback-expected]')
      .fill('Remain locked after sign-out');
    let release, entered, finished;
    const enteredPromise = new Promise((r) => (entered = r)),
      hold = new Promise((r) => (release = r));
    const done = new Promise((r) => (finished = r));
    let disposition;
    let receipt;
    await page.route('**' + endpoint, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      receipt = await response.json();
      entered();
      await hold;
      try {
        await route.fulfill({ response });
        disposition = 'delivered';
      } catch (error) {
        assert(/already handled|cancel|closed/i.test(error.message));
        disposition = 'canceled-by-signout';
      } finally {
        finished();
      }
    });
    await form.locator('[data-control=feedback-save]').click();
    await enteredPromise;
    await infra.signOutThroughUI();
    release();
    await done;
    await page.unroute('**' + endpoint);
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.locator('[data-feedback-run-id]').count(), 0);
    const inspected = await control('/inspect', {
      kind: 'record',
      id: receipt.recordId,
    });
    assert.equal(inspected.body.matchingSubmissionEventCount, 1);
    results.push({
      id: 'B02-held-response-signout-lock',
      outcome: 'PASS',
      recordId: receipt.recordId,
      disposition,
    });
  } catch (error) {
    results.push({
      id: 'B02-held-response-signout-lock',
      outcome: 'FAIL',
      error: error.message,
    });
  }
  await save();
  // B03: loaded parent feedback and operator status layouts; actual CSS zoom.
  try {
    await infra.signInThroughUI(f.parent);
    await ui.waitAuthoritativeLoadedUI('saved-run-feedback');
    await fill('layout');
    await infra.captureAccessibleView('parent-feedback');
    await form.scrollIntoViewIfNeeded();
    await form.screenshot({
      path: path.join(output, 'parent-feedback-form.png'),
    });
    await infra.signInThroughUI(f.operator);
    await ui.waitAuthoritativeLoadedUI('ops-status');
    await infra.captureAccessibleView('operator-status');
    const monitor = page.locator('[data-role=ops-monitor]');
    await monitor.scrollIntoViewIfNeeded();
    await monitor.screenshot({
      path: path.join(output, 'operator-status-content.png'),
    });
    results.push({
      id: 'B03-populated-parent-status-access',
      outcome: 'PASS',
      method: 'Chromium390/820 CSS zoom1/2 reduced-motion; not physical device',
    });
  } catch (error) {
    results.push({
      id: 'B03-populated-parent-status-access',
      outcome: 'FAIL',
      error: error.message,
    });
  }
  await save();
} finally {
  await infra.cleanupOwnedContexts();
  await save();
}
process.exitCode =
  results.length === 3 && results.every((r) => r.outcome === 'PASS') ? 0 : 1;
