// Executable case functions; adapter must use real frozen HTTP/auth/DB controls.
// No default base URL and no product modules. Root runtime adapter is pending.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CONTRACT,
  ANSWERS,
  ROUTES,
  CLEAN_FINAL,
  HELPED_FINAL,
  DAY_MS,
} from './oracle.mjs';
const route = (id) =>
  `/api/pilot/curriculum/learning-runs/${encodeURIComponent(id)}`;
export const HTTP_ADAPTER_REQUIREMENTS = Object.freeze([
  'verifyFrozenIdentity',
  'familyFixture',
  'request',
  'inspectRun',
  'inspectAtomicGroups',
  'setScopedTime',
  'withFinalWriteFailure',
  'restartOwnedRuntime',
]);
// request(actor,method,path,body) preserves real session+Origin, no-store and
// sanitized error checks. familyFixture obtains root-owned named fixture only;
// it never fabricates a reviewed ordinary family or resets active family data.
export function createHTTPCases(h) {
  const stable = (v) =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([key]) => key !== 'serverAt')
              .map(([key, value]) => [key, stable(value)]),
          )
        : v;
  const get = async (f) => {
    const r = await h.request(f.child, 'GET', route(f.runId));
    assert.equal(r.status, 200);
    assert.equal(r.body.lessonVersion, CONTRACT.lesson);
    return r.body;
  };
  const action = async (f, type, payload = {}) => {
    const v = await get(f);
    const r = await h.request(f.child, 'POST', route(f.runId) + '/actions', {
      eventId: randomUUID(),
      expectedRevision: v.revision,
      stepId: v.state.stepId,
      type,
      payload,
    });
    assert.equal(r.status, 200);
    return r;
  };
  const next = (f) => action(f, 'continue');
  const answer = (f, q, c) =>
    action(f, 'answer', { questionId: q, choiceId: c });
  const count = (g) => ({
    total: g.total,
    independentCorrect: g.independent,
    supported: g.supported,
    unavailable: g.unavailable,
    pending: g.pending,
  });
  async function readback(f) {
    const v = await get(f),
      sql = await h.inspectRun(f.runId);
    assert.equal(sql.run.revision, v.revision);
    assert.deepEqual(
      sql.events.map((x) => x.event_id),
      v.events.map((x) => x.eventId),
    );
    assert.equal(
      sql.audits.filter((x) => x.action === 'run-action').length,
      v.events.length,
    );
    return sql;
  }
  async function fullRoute(f, name, helped = false) {
    await next(f);
    for (const [q, c] of ROUTES[name].familiarity) {
      await answer(f, q, c);
      if ((await get(f)).state.questionStatus !== 'open') await next(f);
    }
    const panels = [];
    while ((await get(f)).state.stepId === 'learn') {
      panels.push((await get(f)).state.learnPanel);
      await next(f);
    }
    assert.deepEqual(panels, ROUTES[name].panels);
    await action(f, 'place-component', { componentId: 'mu-a', slot: 'left' });
    await action(f, 'place-component', { componentId: 'mu-b', slot: 'right' });
    await next(f);
    for (const q of ['find-mu', 'find-lin']) {
      await answer(f, q, ANSWERS[q]);
      await next(f);
    }
    await next(f);
    await next(f);
    if (helped) {
      await answer(f, 'check-mu-sound', 'lin');
      await answer(f, 'check-mu-sound', 'ren');
    } else await answer(f, 'check-mu-sound', 'mu');
    await next(f);
    await answer(f, 'check-lin-sound', 'lin');
    await next(f);
    if (helped) await action(f, 'hint', { questionId: 'check-mu-reading' });
    await answer(f, 'check-mu-reading', 'audio-mu');
    await next(f);
    if (helped)
      await action(f, 'audio-unavailable', { questionId: 'check-lin-reading' });
    else await answer(f, 'check-lin-reading', 'audio-lin');
    await next(f);
    const v = await get(f);
    assert(v.state.completedAt);
    assert.deepEqual(
      count(v.recap.immediate),
      helped ? HELPED_FINAL : CLEAN_FINAL,
    );
    assert.deepEqual(count(v.recap.familiarity), {
      total: 2,
      ...ROUTES[name].first,
      pending: 0,
    });
    await readback(f);
    return v;
  }
  return [
    ...Object.keys(ROUTES).map((name) => ({
      id: `I11-${name}`,
      ears: ['002', '010', '014'],
      run: async () => {
        const f = await h.familyFixture(`route-${name}`);
        return fullRoute(f, name);
      },
    })),
    {
      id: 'I11-helped',
      ears: ['002', '014'],
      run: async () =>
        fullRoute(await h.familyFixture('route-helped'), 'new', true),
    },
    {
      id: 'I10-role-ownership',
      ears: ['011'],
      run: async () => {
        const f = await h.familyFixture('role-ownership'),
          before = await get(f);
        for (const actor of [f.parent, f.teacher, f.operator]) {
          const r = await h.request(
            actor,
            'POST',
            route(f.runId) + '/actions',
            {
              eventId: randomUUID(),
              expectedRevision: before.revision,
              stepId: before.state.stepId,
              type: 'continue',
              payload: {},
            },
          );
          assert.equal(r.status, 403);
        }
        for (const actor of [f.otherChild, f.otherParent, f.ungrantedTeacher])
          assert.equal(
            (await h.request(actor, 'GET', route(f.runId))).status,
            404,
          );
        assert.deepEqual(stable(await get(f)), stable(before));
        await readback(f);
      },
    },
    {
      id: 'I12-replay-conflict',
      ears: ['007', '016'],
      run: async () => {
        const f = await h.familyFixture('replay-conflict');
        await next(f);
        const v = await get(f),
          body = {
            eventId: randomUUID(),
            expectedRevision: v.revision,
            stepId: v.state.stepId,
            type: 'answer',
            payload: { questionId: 'fam-mu', choiceId: 'mu' },
          };
        const first = await h.request(
          f.child,
          'POST',
          route(f.runId) + '/actions',
          body,
        );
        assert.equal(first.status, 200);
        await next(f);
        const advanced = await get(f);
        const replay = await h.request(
          f.child,
          'POST',
          route(f.runId) + '/actions',
          body,
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        assert.deepEqual(replay.body.ack, first.body.ack);
        assert.equal(
          (
            await h.request(f.child, 'POST', route(f.runId) + '/actions', {
              ...body,
              payload: { questionId: 'fam-mu', choiceId: 'lin' },
            })
          ).status,
          409,
        );
        assert.deepEqual(stable(await get(f)), stable(advanced));
        const sql = await readback(f);
        assert.equal(
          sql.events.filter((x) => x.event_id === body.eventId).length,
          1,
        );
      },
    },
    {
      id: 'I13-due-boundary',
      ears: ['014'],
      run: async () => {
        const f = await h.familyFixture('due-boundary'),
          v = await fullRoute(f, 'familiar');
        const due = Date.parse(v.state.completedAt) + DAY_MS;
        assert.equal(Date.parse(v.reviewAvailableAt), due);
        await h.setScopedTime(f, due - 1);
        const early = await get(f);
        const response = await h.request(
          f.child,
          'POST',
          route(f.runId) + '/actions',
          {
            eventId: randomUUID(),
            expectedRevision: early.revision,
            stepId: early.state.stepId,
            type: 'start-review',
            payload: {},
          },
        );
        assert.equal(response.status, 409);
        assert.equal(response.body.error.code, 'REVIEW_NOT_DUE');
        await h.setScopedTime(f, due);
        await action(f, 'start-review');
        for (const q of ['review-mu-sound', 'review-lin-sound']) {
          await answer(f, q, ANSWERS[q]);
          await next(f);
        }
        const after = await get(f);
        assert.deepEqual(after.recap.immediate, v.recap.immediate);
        assert.deepEqual(count(after.recap.delayed), {
          total: 2,
          independentCorrect: 2,
          supported: 0,
          unavailable: 0,
          pending: 0,
        });
        await readback(f);
      },
    },
  ];
}
