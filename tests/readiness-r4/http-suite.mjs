/** Independent H01–H07: actual frozen ordinary HTTP, named owned controls and read-only SQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const uid = () => randomUUID();
const recordRoute = (id) => '/api/pilot/ops/feedback/' + encodeURIComponent(id);
const runRoute = (id) =>
  '/api/pilot/curriculum/learning-runs/' + encodeURIComponent(id);
const triage = (revision, extra = {}) => ({
  requestId: uid(),
  expectedRevision: revision,
  severity: 'normal',
  ownerRef: null,
  status: 'open',
  acIds: [],
  disposition: '',
  retestRef: null,
  nextReviewAt: null,
  ...extra,
});
const assertReceipt = (r) =>
  assert.deepEqual(
    Object.keys(r).sort(),
    ['requestId', 'recordId', 'revision', 'recordedAt'].sort(),
  );
export function createHTTPCases(h) {
  let f,
    other,
    receipt,
    original,
    observationReceipt,
    observation,
    historyRecord;
  const feedback = (input) =>
    h.request(
      f.parent,
      'POST',
      `/api/pilot/children/${f.child.id}/feedback`,
      input,
    );
  const detail = async (id) => {
    const r = await h.request(h.operator, 'GET', recordRoute(id));
    assert.equal(r.status, 200);
    return r.body.record;
  };
  const envelope = (r) => {
    assert.equal(r.body.schemaVersion, 'r4-ops-view-1');
    assert.equal(r.body.installationId, h.handoff.evidenceInstallationId);
    assert.equal(
      r.body.opsInstallationId,
      h.handoff.operations.opsInstallationId,
    );
    assert.equal(r.body.buildId, h.handoff.candidateId);
    assert(Number.isSafeInteger(r.body.serverAt));
  };
  return [
    {
      id: 'H01',
      ears: ['R4-E-001'],
      run: async () => {
        f = await h.family('child-a', 'parent-a');
        other = await h.family('child-b', 'parent-b');
        const before = await h.request(f.child, 'GET', runRoute(f.runId));
        assert.equal(before.status, 200);
        await h.ops('/binding', { state: 'missing' });
        const unavailable = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/status',
        );
        assert.equal(unavailable.status, 503);
        assert.equal(unavailable.body.status.monitorState, 'unknown');
        const action = {
          eventId: uid(),
          expectedRevision: before.body.revision,
          stepId: before.body.state.stepId,
          type: 'continue',
          payload: {},
        };
        const saved = await h.request(
          f.child,
          'POST',
          runRoute(f.runId) + '/actions',
          action,
        );
        assert.equal(saved.status, 200);
        await h.ops('/restart', { service: 'all' });
        const resumed = await h.request(f.child, 'GET', runRoute(f.runId));
        assert.equal(resumed.status, 200);
        assert.equal(resumed.body.revision, before.body.revision + 1);
        assert.equal(
          (
            await h.learning('/inspect', { kind: 'run', runId: f.runId })
          ).events.filter((e) => e.event_id === action.eventId).length,
          1,
        );
        await h.ops('/binding', { state: 'available' });
        const available = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/status',
        );
        assert.equal(available.status, 200);
        envelope(available);
        await h.ops('/fault', { stage: 'monitor', mode: 'unavailable' });
        const failed = await h.ops('/dispatch', { kind: 'monitor' });
        assert.equal(failed.status, 'uncertain');
        assert.equal(
          (await h.request(h.operator, 'GET', '/api/pilot/ops/status')).body
            .status.monitorState,
          'unknown',
        );
        await h.ops('/fault', { stage: 'monitor', mode: 'none' });
        return { durableLearningEvent: action.eventId, runId: f.runId };
      },
    },
    {
      id: 'H02',
      ears: ['R4-E-002', 'R4-E-013'],
      run: async () => {
        original = {
          requestId: uid(),
          runId: f.runId,
          category: 'saving',
          observed: 'SYNTHETIC private access sample',
          expected: '',
        };
        const created = await feedback(original);
        assert.equal(created.status, 200);
        receipt = created.body;
        assertReceipt(receipt);
        for (const actor of [f.parent, f.child, h.teacher, other.parent])
          for (const endpoint of [
            '/api/pilot/ops/status',
            '/api/pilot/ops/feedback',
            recordRoute(receipt.recordId),
            recordRoute(receipt.recordId) + '/history',
          ])
            assert.equal((await h.request(actor, 'GET', endpoint)).status, 403);
        for (const actor of [f.child, h.teacher])
          assert.equal(
            (
              await h.request(
                actor,
                'POST',
                `/api/pilot/children/${f.child.id}/feedback`,
                original,
              )
            ).status,
            403,
          );
        assert.equal(
          (
            await h.request(
              other.parent,
              'POST',
              `/api/pilot/children/${f.child.id}/feedback`,
              original,
            )
          ).status,
          404,
        );
        for (const body of [
          { ...original, runId: other.runId },
          { ...original, runId: 'unknown-saved-run' },
        ])
          assert.equal((await feedback(body)).status, 404);
        assert.equal(
          (await h.request(null, 'GET', recordRoute(receipt.recordId))).status,
          401,
        );
        assert.equal(
          (
            await h.request(
              f.parent,
              'POST',
              `/api/pilot/children/${f.child.id}/feedback`,
              original,
              { origin: 'http://wrong.invalid' },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await h.request(
              f.parent,
              'POST',
              `/api/pilot/children/${f.child.id}/feedback`,
              original,
              { origin: null },
            )
          ).status,
          403,
        );
        assert.equal(
          (await h.request(h.operator, 'PUT', '/api/pilot/ops/status', {}))
            .status,
          405,
        );
        for (const key of [
          'environment',
          'installationId',
          'buildId',
          'synthetic',
        ])
          assert.equal(
            (await feedback({ ...original, [key]: 'caller' })).status,
            400,
          );
        await h.request(h.operator, 'DELETE', '/api/pilot/links', {
          parentId: f.parent.id,
          childId: f.child.id,
        });
        assert.equal(
          (await feedback({ ...original, requestId: uid() })).status,
          404,
        );
        assert.equal(
          (
            await h.request(h.operator, 'POST', '/api/pilot/links', {
              parentId: f.parent.id,
              childId: f.child.id,
            })
          ).status,
          201,
        );
        await h.revokeChecks(recordRoute(receipt.recordId));
        return { receipt: receipt.recordId, rolesDenied: 4 };
      },
    },
    {
      id: 'H03',
      ears: ['R4-E-003', 'R4-E-006'],
      run: async () => {
        assert.deepEqual((await feedback(original)).body, receipt);
        const before = await detail(receipt.recordId),
          input = triage(before.revision, {
            severity: 'high',
            ownerRef: 'SYNTHETIC operator reference',
            disposition: 'SYNTHETIC disposition',
          }),
          route = recordRoute(receipt.recordId) + '/triage';
        const first = await h.request(h.operator, 'POST', route, input);
        assert.equal(first.status, 200);
        assertReceipt(first.body);
        assert.deepEqual(
          (await h.request(h.operator, 'POST', route, input)).body,
          first.body,
        );
        for (const body of [
          { ...input, severity: 'low' },
          { ...input, requestId: uid() },
        ]) {
          const r = await h.request(h.operator, 'POST', route, body);
          assert.equal(r.status, 409);
          assert.equal(r.body.currentRevision, first.body.revision);
          envelope(r);
        }
        const read = await detail(receipt.recordId),
          competing = await Promise.all(
            ['one', 'two'].map((label) =>
              h.request(
                h.operator,
                'POST',
                route,
                triage(read.revision, {
                  disposition: 'SYNTHETIC CAS ' + label,
                }),
              ),
            ),
          );
        assert.deepEqual(
          competing.map((r) => r.status).sort((a, b) => a - b),
          [200, 409],
        );
        const sql = await h.ops('/inspect', {
          kind: 'record',
          id: receipt.recordId,
        });
        assert.equal(sql.revision, read.revision + 1);
        assert.equal(sql.events.length, sql.revision);
        const stable = await detail(receipt.recordId);
        await h.ops('/fault', { stage: 'feedback', mode: 'final-constraint' });
        try {
          assert.equal(
            (
              await h.request(
                h.operator,
                'POST',
                route,
                triage(stable.revision),
              )
            ).status,
            503,
          );
        } finally {
          await h.ops('/fault', { stage: 'feedback', mode: 'none' });
        }
        assert.deepEqual(await detail(receipt.recordId), stable);
        const status = await h.request(
            h.operator,
            'GET',
            '/api/pilot/ops/status',
          ),
          alert = status.body.status.alerts.find(
            (a) => a.code === 'OPS_BACKUP_STALE',
          );
        assert(alert);
        const ack = { requestId: uid(), expectedRevision: alert.revision },
          ackRoute = `/api/pilot/ops/alerts/${alert.id}/ack`;
        await h.ops('/fault', { stage: 'alert', mode: 'final-constraint' });
        try {
          assert.equal(
            (await h.request(h.operator, 'POST', ackRoute, ack)).status,
            503,
          );
        } finally {
          await h.ops('/fault', { stage: 'alert', mode: 'none' });
        }
        const accepted = await h.request(h.operator, 'POST', ackRoute, ack);
        assert.equal(accepted.status, 200);
        assert.deepEqual(
          (await h.request(h.operator, 'POST', ackRoute, ack)).body,
          accepted.body,
        );
        assert.equal(
          (
            await h.request(h.operator, 'POST', ackRoute, {
              ...ack,
              expectedRevision: ack.expectedRevision + 1,
            })
          ).status,
          409,
        );
        const after = (
          await h.request(h.operator, 'GET', '/api/pilot/ops/status')
        ).body.status;
        assert(
          after.alerts.some(
            (a) => a.id === alert.id && a.status === 'acknowledged',
          ),
        );
        assert.notEqual(after.monitorState, 'healthy');
        return { singleCASWinner: true, atomicRollback: true };
      },
    },
    {
      id: 'H04',
      ears: ['R4-E-010'],
      run: async () => {
        for (const observed of ['', '😀'.repeat(1001), '   '])
          assert.equal(
            (await feedback({ ...original, requestId: uid(), observed }))
              .status,
            400,
          );
        const text = '😀'.repeat(1000),
          accepted = await feedback({
            ...original,
            requestId: uid(),
            observed: text,
            expected: '',
          });
        assert.equal(accepted.status, 200);
        const actual = await detail(accepted.body.recordId);
        assert.equal(actual.details.observed, text);
        assert.equal(actual.childId, f.child.id);
        assert.equal(actual.runId, f.runId);
        assert.equal(
          actual.runInstallationId,
          h.handoff.evidenceInstallationId,
        );
        assert.equal(actual.lessonVersion, 'forest-01-v4');
        assert.equal(actual.contentDigest, h.handoff.contentDigest);
        assert.equal(actual.sourceRole, 'parent');
        assert.equal(
          (
            await feedback({
              ...original,
              requestId: uid(),
              category: 'unknown',
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await feedback({
              ...original,
              requestId: uid(),
              expected: '😀'.repeat(1001),
            })
          ).status,
          400,
        );
        const whitespace = await feedback({
          ...original,
          requestId: uid(),
          observed: '  SYNTHETIC retained whitespace  ',
          expected: '  ',
        });
        assert.equal(whitespace.status, 200);
        assert.equal(
          (await detail(whitespace.body.recordId)).details.observed,
          '  SYNTHETIC retained whitespace  ',
        );
        const queue = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/feedback',
        );
        assert(!JSON.stringify(queue.body).includes('retained whitespace'));
        const route = recordRoute(receipt.recordId) + '/triage',
          current = await detail(receipt.recordId);
        for (const extra of [
          { status: 'resolved', disposition: '', retestRef: null },
          {
            status: 'resolved',
            disposition: 'SYNTHETIC explanation',
            retestRef: null,
          },
        ])
          assert.equal(
            (
              await h.request(
                h.operator,
                'POST',
                route,
                triage(current.revision, extra),
              )
            ).status,
            400,
          );
        return { unicodeCodePoints: 1000, derivedScope: true };
      },
    },
    {
      id: 'H05',
      ears: ['R4-E-002', 'R4-E-003', 'R4-E-010'],
      run: async () => {
        for (let n = 0; n < 22; n++)
          assert.equal(
            (
              await feedback({
                ...original,
                requestId: uid(),
                observed: 'SYNTHETIC paging ' + n,
              })
            ).status,
            200,
          );
        const first = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/feedback',
        );
        assert.equal(first.body.items.length, 20);
        assert(first.body.nextCursor);
        const second = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/feedback?cursor=' +
            encodeURIComponent(first.body.nextCursor),
        );
        assert.equal(second.status, 200);
        const ids = [...first.body.items, ...second.body.items];
        assert.equal(new Set(ids.map((r) => r.id)).size, ids.length);
        assert.deepEqual(
          ids.map((r) => [r.createdAt, r.id]),
          ids
            .map((r) => [r.createdAt, r.id])
            .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])),
        );
        for (const query of [
          'limit=51',
          'status=unknown',
          'kind=unknown',
          'extra=1',
          'limit=1&limit=2',
          'cursor=bad',
        ])
          assert.equal(
            (
              await h.request(
                h.operator,
                'GET',
                '/api/pilot/ops/feedback?' + query,
              )
            ).status,
            400,
          );
        assert.equal(
          (
            await h.request(
              h.operator,
              'GET',
              '/api/pilot/ops/feedback?status=all&cursor=' +
                encodeURIComponent(first.body.nextCursor),
            )
          ).status,
          400,
        );
        await feedback({ ...original, requestId: uid() });
        const stale = await h.request(
          h.operator,
          'GET',
          '/api/pilot/ops/feedback?cursor=' +
            encodeURIComponent(first.body.nextCursor),
        );
        assert.equal(stale.status, 409);
        assert.equal(stale.body.error.code, 'OPS_CURSOR_STALE');
        assert.equal(stale.body.refreshRequired, true);
        envelope(stale);
        historyRecord = receipt.recordId;
        const current = await detail(historyRecord);
        for (let n = 0; n < 21; n++) {
          const r = await h.request(
            h.operator,
            'POST',
            recordRoute(historyRecord) + '/triage',
            triage(current.revision, { disposition: 'SYNTHETIC history ' + n }),
          );
          assert.equal(r.status, 200);
          current.revision = r.body.revision;
        }
        const latest = await detail(historyRecord);
        assert.equal(latest.history.length, 20);
        assert(latest.nextCursor);
        const older = await h.request(
          h.operator,
          'GET',
          recordRoute(historyRecord) +
            '/history?cursor=' +
            encodeURIComponent(latest.nextCursor),
        );
        assert.equal(older.status, 200);
        const sequences = [...older.body.items, ...latest.history].map(
          (r) => r.sequence,
        );
        assert.deepEqual(
          sequences,
          Array.from({ length: latest.revision }, (_, n) => n + 1),
        );
        await h.request(
          h.operator,
          'POST',
          recordRoute(historyRecord) + '/triage',
          triage(latest.revision),
        );
        assert.equal(
          (
            await h.request(
              h.operator,
              'GET',
              recordRoute(historyRecord) +
                '/history?cursor=' +
                encodeURIComponent(latest.nextCursor),
            )
          ).status,
          409,
        );
        return { queuePages: 2, historyRevision: latest.revision };
      },
    },
    {
      id: 'H06',
      ears: ['R4-E-011'],
      run: async () => {
        const at = (await h.request(h.operator, 'GET', '/api/pilot/ops/status'))
          .body.serverAt;
        observation = {
          kind: 'synthetic',
          participantLabel: 'Anonymous QA',
          candidateId: h.handoff.candidateId,
          lessonVersion: 'forest-01-v4',
          contentDigest: h.handoff.contentDigest,
          observedAt: at,
          device: 'Synthetic HTTP',
          browser: 'Node fetch',
          parentAgreementRef: 'SIMULATED agreement ref only',
          tasks: ['Story'],
          completion: 'ended',
          savedRecapRef: null,
          adultHelp: 'SYNTHETIC adult help',
          interruptions: 'SYNTHETIC interruption',
          observedBehavior: 'SYNTHETIC behavior',
          observerInterpretation: 'SYNTHETIC interpretation',
          laterRecall: { status: 'not-run' },
        };
        const created = await h.request(
          h.operator,
          'POST',
          '/api/pilot/ops/observations',
          { requestId: uid(), observation },
        );
        assert.equal(created.status, 200);
        observationReceipt = created.body;
        const current = await detail(observationReceipt.recordId);
        assert.equal(current.observationKind, 'synthetic');
        assert.equal(current.details.observation.savedRecapRef, null);
        assert.equal(current.details.observation.completion, 'ended');
        for (const changed of [
          {
            ...observation,
            laterRecall: {
              status: 'observed',
              observedAt: at - 1,
              evidenceRef: 'SIMULATED',
              adultHelp: '',
              observation: '',
            },
          },
          { ...observation, unknown: true },
        ])
          assert.equal(
            (
              await h.request(
                h.operator,
                'POST',
                '/api/pilot/ops/observations',
                { requestId: uid(), observation: changed },
              )
            ).status,
            400,
          );
        const correction = {
            requestId: uid(),
            expectedRevision: current.revision,
            observation: {
              ...observation,
              completion: 'partial',
              observedBehavior: 'SYNTHETIC correction',
            },
            correctionReason: 'SYNTHETIC attribution correction',
          },
          route = `/api/pilot/ops/observations/${current.id}/corrections`;
        const saved = await h.request(h.operator, 'POST', route, correction);
        assert.equal(saved.status, 200);
        assert.deepEqual(
          (await h.request(h.operator, 'POST', route, correction)).body,
          saved.body,
        );
        assert.equal(
          (
            await h.request(h.operator, 'POST', route, {
              ...correction,
              requestId: uid(),
            })
          ).status,
          409,
        );
        for (const key of [
          'candidateId',
          'lessonVersion',
          'contentDigest',
          'kind',
        ])
          assert.equal(
            (
              await h.request(h.operator, 'POST', route, {
                ...correction,
                requestId: uid(),
                expectedRevision: saved.body.revision,
                observation: {
                  ...observation,
                  [key]: key === 'kind' ? 'actual' : 'wrong',
                },
              })
            ).status,
            400,
          );
        const after = await detail(current.id);
        assert.equal(after.history[1].kind, 'corrected');
        assert.equal(after.history.length, 2);
        assert.equal(after.details.observation.completion, 'partial');
        return { kind: 'synthetic', attributedOnly: true };
      },
    },
    {
      id: 'H07',
      ears: ['R4-E-012'],
      run: async () => {
        const current = await detail(receipt.recordId),
          deadline = current.createdAt + 30 * 86400000;
        await h.ops('/clock', { at: deadline - 1 });
        assert((await detail(receipt.recordId)).details);
        await h.ops('/clock', { at: deadline });
        const expired = await detail(receipt.recordId);
        assert.equal(expired.status, 'expired');
        assert.equal(expired.details, null);
        assert.equal(expired.ownerRef, null);
        assert(
          expired.history.every((e) => e.private === null && e.detailsRemoved),
        );
        assert(!JSON.stringify(expired).includes('SYNTHETIC disposition'));
        assert.equal(
          (
            await h.request(
              h.operator,
              'POST',
              recordRoute(receipt.recordId) + '/triage',
              triage(expired.revision),
            )
          ).body.error.code,
          'OPS_DETAILS_EXPIRED',
        );
        assert.deepEqual((await feedback(original)).body, receipt);
        const observationExpired = await detail(observationReceipt.recordId);
        if (observationExpired.createdAt + 30 * 86400000 > deadline)
          await h.ops('/clock', {
            at: observationExpired.createdAt + 30 * 86400000,
          });
        const obs = await detail(observationReceipt.recordId);
        assert.equal(obs.details, null);
        const corrected = await h.request(
          h.operator,
          'POST',
          `/api/pilot/ops/observations/${obs.id}/corrections`,
          {
            requestId: uid(),
            expectedRevision: obs.revision,
            observation,
            correctionReason: 'SYNTHETIC after expiry',
          },
        );
        assert.equal(corrected.body.error.code, 'OPS_DETAILS_EXPIRED');
        const sql = await h.privateRedaction(receipt.recordId);
        assert.equal(sql.privateColumns, 0);
        assert.equal(sql.redactionEvents, 1);
        assert.equal(sql.submissions, 1);
        const again = await detail(receipt.recordId);
        assert.equal(again.revision, expired.revision);
        return { deadline, redactionEvents: 1, exactReceiptReplay: true };
      },
    },
  ];
}
