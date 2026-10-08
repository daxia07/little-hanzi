// Independent real smoke cases; no default URL, product imports or mock adapter.
// Runtime wiring waits for the frozen R4 handoff/public control map.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export const SMOKE_REQUIREMENTS = Object.freeze([
  'handoff',
  'operator',
  'parent',
  'savedRun',
  'verifyFrozenIdentity',
  'signInThroughUI',
  'waitAuthoritativeLoadedUI',
  'submitFeedbackThroughUI',
  'request',
  'inspectRecord',
  'inspectJob',
  'restartOwnedRuntime',
  'dispatchPrivateJob',
  'verifyActualEncryptedReadback',
  'auditActualServedAssets',
  'capturePopulatedAccessibility',
]);
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => k !== 'serverAt')
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export function createSmokeCases(h) {
  for (const name of SMOKE_REQUIREMENTS)
    assert(h[name], 'Missing actual R4 adapter ' + name);
  let receipt, detail;
  let submission = {
    runId: h.savedRun.runId,
    category: 'saving',
    observed: 'QA_PRIVATE_SMOKE_observed_' + randomUUID(),
    expected: 'QA_PRIVATE_SMOKE_expected_' + randomUUID(),
  };
  const endpoint = `/api/pilot/children/${encodeURIComponent(h.savedRun.childId)}/feedback`;
  return [
    {
      id: 'S01-auth-loaded-feedback',
      ears: ['R4-E-001', 'R4-E-002', 'R4-E-010'],
      run: async () => {
        await h.verifyFrozenIdentity();
        assert.equal(
          h.savedRun.installationId,
          h.handoff.learningInstallationId,
        );
        await h.signInThroughUI(h.operator);
        await h.waitAuthoritativeLoadedUI('ops-status');
        const status = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/status',
        );
        assert.equal(status.status, 200);
        assert.equal(status.body.schemaVersion, 'r4-ops-view-1');
        await h.signInThroughUI(h.parent);
        await h.waitAuthoritativeLoadedUI('saved-run-feedback');
        const saved = await h.submitFeedbackThroughUI(submission);
        assert.equal(saved.requestBody.runId, submission.runId);
        for (const key of ['category', 'observed', 'expected'])
          assert.equal(saved.requestBody[key], submission[key]);
        assert(typeof saved.requestBody.requestId === 'string');
        submission = saved.requestBody;
        receipt = saved.receipt;
        assert.deepEqual(
          Object.keys(receipt).sort(),
          ['requestId', 'recordId', 'revision', 'recordedAt'].sort(),
        );
        assert.equal(receipt.requestId, submission.requestId);
        assert(Number.isInteger(receipt.revision) && receipt.revision > 0);
        assert(Number.isInteger(receipt.recordedAt));
        return {
          requestId: receipt.requestId,
          recordId: receipt.recordId,
          revision: receipt.revision,
        };
      },
    },
    {
      id: 'S02-durable-ack-sql-readback',
      ears: ['R4-E-003', 'R4-E-010'],
      run: async () => {
        assert(receipt, 'Actual feedback receipt prerequisite');
        const replay = await h.request(h.parent, 'POST', endpoint, submission);
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, receipt);
        const current = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/feedback/' + receipt.recordId,
        );
        assert.equal(current.status, 200);
        assert.equal(current.body.schemaVersion, 'r4-ops-view-1');
        detail = current.body.record;
        assert.equal(detail.id, receipt.recordId);
        assert.equal(detail.status, 'open');
        assert.equal(detail.severity, 'normal');
        assert.equal(detail.ownerRef, null);
        assert.equal(detail.nextReviewAt, null);
        const sql = await h.inspectRecord(receipt.recordId);
        assert.equal(sql.matchingRequestCount, 1);
        assert.equal(sql.matchingSubmissionEventCount, 1);
        assert.equal(sql.revision, receipt.revision);
        return {
          recordId: receipt.recordId,
          revision: receipt.revision,
          matchingEvents: 1,
        };
      },
    },
    {
      id: 'S03-owned-restart-readback',
      ears: ['R4-E-001', 'R4-E-003', 'R4-E-010'],
      run: async () => {
        assert(detail);
        await h.restartOwnedRuntime('all');
        const current = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/feedback/' + receipt.recordId,
        );
        assert.equal(current.status, 200);
        assert.deepEqual(stable(current.body.record), stable(detail));
        await h.signInThroughUI(h.operator);
        await h.waitAuthoritativeLoadedUI('feedback-detail', receipt.recordId);
        await h.verifyFrozenIdentity();
        return {
          recordId: receipt.recordId,
          revision: current.body.record.revision,
          restartReadback: true,
        };
      },
    },
    {
      id: 'S04-real-encrypted-archive-assets',
      ears: ['R4-E-005', 'R4-E-008', 'R4-E-015'],
      run: async () => {
        assert(detail);
        const result = await h.dispatchPrivateJob('backup');
        assert.equal(result.status, 'verified');
        const job = await h.inspectJob(result.jobId);
        assert.equal(job.job.status, 'succeeded');
        const actual = await h.verifyActualEncryptedReadback(result.jobId);
        assert.equal(actual.objects.length, 2);
        assert.deepEqual(actual.objects.map((o) => o.kind).sort(), [
          'learning',
          'operations',
        ]);
        assert.equal(
          actual.objects.find((o) => o.kind === 'learning').tableCount,
          35,
        );
        assert.equal(
          actual.objects.find((o) => o.kind === 'operations').tableCount,
          8,
        );
        const assets = await h.auditActualServedAssets();
        assert.equal(assets.oracleLeak, false);
        assert.equal(assets.privateCanaryLeak, false);
        assert.equal(assets.allBytesMatchFrozenArtifact, true);
        return {
          archiveId: result.archiveId,
          objects: actual.objects,
          method: actual.method,
          assetCount: assets.assetCount,
        };
      },
    },
    {
      id: 'S05-populated-accessibility',
      ears: ['R4-E-014'],
      run: async () => {
        assert(detail);
        await h.capturePopulatedAccessibility({
          widths: [390, 820],
          cssZoom: [1, 2],
          views: ['parent-feedback', 'operator-status', 'feedback-detail'],
          reducedMotion: true,
          essentialTargetCSSPixels: 44,
          normalTextContrast: 4.5,
          controlFocusContrast: 3,
        });
        return {
          method:
            'Chromium emulation / CSS layout zoom; not physical device or OS text scaling',
        };
      },
    },
  ];
}
