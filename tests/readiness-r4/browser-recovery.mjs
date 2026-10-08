import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRuntimeAdapter } from './browser-suite.mjs';
import { createOpsUI } from './ui-adapter.mjs';
import { createControls } from './controls.mjs';
const [handoffFile, output] = process.argv.slice(2),
  h = JSON.parse(await readFile(handoffFile, 'utf8'));
await mkdir(output, { mode: 0o700 });
const infra = await createRuntimeAdapter({ handoff: h, output });
const credentials = JSON.parse(await readFile(h.credentialsFile, 'utf8')),
  control = createControls(h, credentials.token),
  results = [];
const save = () =>
  writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ candidateId: h.candidateId, results }, null, 2) + '\n',
  );
try {
  const f = await infra.familyFixture('r4-read-recovery');
  await infra.signInThroughUI(f.parent);
  const page = infra.page,
    session = await page.context().newCDPSession(page);
  const owned = await session.send('Target.getTargetInfo');
  assert(owned.targetInfo.browserContextId && owned.targetInfo.targetId);
  await writeFile(
    path.join(output, 'owned-browser-ids.json'),
    JSON.stringify(
      {
        browserContextId: owned.targetInfo.browserContextId,
        targetId: owned.targetInfo.targetId,
      },
      null,
      2,
    ) + '\n',
  );
  await session.detach();
  const ui = createOpsUI(page, { runId: f.runId, childId: f.child.id });
  await ui.waitAuthoritativeLoadedUI('saved-run-feedback');
  const saved = await ui.submitFeedbackThroughUI({
      category: 'saving',
      observed: 'QA_PRIVATE_recovery',
      expected: 'Exact recovery',
    }),
    id = saved.receipt.recordId;
  await infra.signInThroughUI(f.operator);
  await ui.waitAuthoritativeLoadedUI('feedback-detail', id);
  const detail = page.locator(
      `[data-role=ops-feedback-detail][data-feedback-id="${id}"]`,
    ),
    getPath = `/api/pilot/ops/feedback/${id}`,
    postPath = getPath + '/triage';
  try {
    let postCount = 0;
    const listener = (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === postPath)
        postCount++;
    };
    page.on('request', listener);
    await page.route('**' + getPath, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'OPS_UNAVAILABLE', unknown: true }),
          })
        : route.continue(),
    );
    await detail
      .locator('[data-control=triage-disposition]')
      .fill('QA known receipt then GET outage');
    const ack = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === postPath &&
        r.request().method() === 'POST',
    );
    await detail.locator('[data-control=triage-save]').click();
    const receipt = await (await ack).json();
    await detail.locator('[data-ops-write-state=readback-pending]').waitFor();
    await page.unroute('**' + getPath);
    await detail.locator('[data-control=readback-retry]').click();
    await detail.locator('[data-ops-write-state=saved]').waitFor();
    assert.equal(postCount, 1);
    page.off('request', listener);
    const sql = await control('/inspect', { kind: 'record', id });
    assert.equal(sql.body.revision, receipt.revision);
    assert.equal(sql.body.events.filter((e) => e.kind === 'triaged').length, 1);
    results.push({
      id: 'B01-known-ack-get-only-recovery',
      outcome: 'PASS',
      revision: receipt.revision,
      postCount,
    });
  } catch (error) {
    results.push({
      id: 'B01-known-ack-get-only-recovery',
      outcome: 'FAIL',
      error: error.message,
    });
  }
  await save();
  try {
    await detail.locator('[data-control=triage-new]').click();
    const revision = Number(await detail.getAttribute('data-record-revision'));
    const draft = 'QA preserved conflicting draft';
    await detail.locator('[data-control=triage-disposition]').fill(draft);
    const other = await infra.request(f.operator, 'POST', postPath, {
      requestId: randomUUID(),
      expectedRevision: revision,
      severity: 'high',
      ownerRef: null,
      status: 'in-progress',
      acIds: ['R4-E-003'],
      disposition: 'Other operator authoritative change',
      retestRef: null,
      nextReviewAt: null,
    });
    assert.equal(other.status, 200);
    const conflict = page.waitForResponse(
      (r) => new URL(r.url()).pathname === postPath && r.status() === 409,
    );
    await detail.locator('[data-control=triage-save]').click();
    await conflict;
    await detail.locator('[data-ops-write-state=conflict]').waitFor();
    assert.equal(
      await detail.locator('[data-control=triage-disposition]').inputValue(),
      draft,
    );
    await detail.locator('[data-control=conflict-refresh]').click();
    await detail.locator('[data-control=conflict-new]').waitFor();
    const before = await control('/inspect', { kind: 'record', id });
    assert.equal(before.body.revision, other.body.revision);
    await detail.locator('[data-control=conflict-new]').click();
    const after = await control('/inspect', { kind: 'record', id });
    assert.equal(after.body.revision, before.body.revision);
    results.push({
      id: 'B01-conflict-no-auto-rebase',
      outcome: 'PASS',
      revision: after.body.revision,
    });
  } catch (error) {
    results.push({
      id: 'B01-conflict-no-auto-rebase',
      outcome: 'FAIL',
      error: error.message,
    });
  }
} finally {
  await infra.cleanupOwnedContexts();
  await save();
  await writeFile(
    path.join(output, 'cleanup.json'),
    JSON.stringify({ ownedContextsClosed: true, disconnected: true }) + '\n',
  );
}
process.exitCode =
  results.length === 2 && results.every((r) => r.outcome === 'PASS') ? 0 : 1;
