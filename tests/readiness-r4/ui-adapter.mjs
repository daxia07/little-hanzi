// Public UI interactions on a caller-owned page. No app API or state injection.
import assert from 'node:assert/strict';
export function createOpsUI(page, savedRun) {
  async function settled() {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
  }
  async function waitAuthoritativeLoadedUI(kind, recordId) {
    if (kind === 'ops-status') {
      await page.locator('[data-ops-tab=operations]').click();
      await page
        .locator('[data-role=ops-monitor][data-ops-view-state=ready]')
        .waitFor({ state: 'visible' });
    } else if (kind === 'saved-run-feedback') {
      await page
        .locator(
          `[data-story-run-id="${savedRun.runId}"] [data-feedback-run-id="${savedRun.runId}"] [data-control=report-problem]`,
        )
        .waitFor({ state: 'visible' });
    } else if (kind === 'feedback-detail') {
      await page.locator('[data-ops-tab=feedback]').click();
      const queue = page.locator(
        '[data-role=ops-feedback-queue][data-ops-view-state=ready][data-queue-revision]',
      );
      await queue.waitFor({ state: 'visible' });
      await queue.locator('[data-control=queue-refresh]').click();
      await queue
        .locator(
          `[data-feedback-id="${recordId}"] [data-control=feedback-open]`,
        )
        .click();
      await page
        .locator(
          `[data-role=ops-feedback-detail][data-feedback-id="${recordId}"][data-record-revision]`,
        )
        .waitFor({ state: 'visible' });
    } else throw new Error('Unknown public R4 loaded view');
    await settled();
  }
  async function submitFeedbackThroughUI(input) {
    const form = page.locator(`[data-feedback-run-id="${savedRun.runId}"]`);
    await form.locator('[data-control=report-problem]').click();
    await form
      .locator('[data-control=feedback-category]')
      .selectOption(input.category);
    await form.locator('[data-control=feedback-observed]').fill(input.observed);
    await form.locator('[data-control=feedback-expected]').fill(input.expected);
    const pathname = `/api/pilot/children/${encodeURIComponent(savedRun.childId)}/feedback`;
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === pathname &&
        response.request().method() === 'POST',
    );
    await form.locator('[data-control=feedback-save]').click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const requestBody = response.request().postDataJSON();
    const receipt = await response.json();
    await form
      .locator('[data-ops-write-state=saved]')
      .waitFor({ state: 'visible' });
    assert.equal(requestBody.runId, savedRun.runId);
    assert.equal(receipt.requestId, requestBody.requestId);
    return { requestBody, receipt };
  }
  return { waitAuthoritativeLoadedUI, submitFeedbackThroughUI, settled };
}
