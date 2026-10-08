/** Authenticated HTTP+named SQL readback. Pure oracle is test-owned. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  literalNextAction,
  actionBody,
  assertSafeRun,
} from './learning-support.mjs';
const DAY = 86400000;
const childPath = (id, suffix) =>
  '/api/pilot/children/' + encodeURIComponent(id) + '/' + suffix;
const runPath = (id) =>
  '/api/pilot/curriculum/learning-runs/' + encodeURIComponent(id);
const value = (r, status = 200) => {
  assert.equal(
    r.status,
    status,
    JSON.stringify({
      status: r.status,
      code: r.body?.error?.code ?? r.body?.code,
    }),
  );
  return r.body;
};
export async function runServiceFamily(http, oracles, execute, browserInitial) {
  const h = http.handoff,
    v = h.corpusVersion,
    query = '?corpusVersion=' + encodeURIComponent(v),
    journeys = [];
  const family = (index) => {
    const f = h.families.find((x) => x.index === index);
    assert(f);
    return f;
  };
  function assertVisits(object, j) {
    assert(Array.isArray(object.corpora));
    const groups = object.corpora.filter(
      (g) =>
        g.corpusVersion === v &&
        g.corpusDigest === h.corpusDigest &&
        g.installationId === h.installationId &&
        g.childId === j.childId,
    );
    assert.equal(groups.length, 1);
    const visits = groups[0].visits.filter(
      (visit) =>
        visit.lessonVersion === j.rep.lessonVersion &&
        visit.contentDigest === j.rep.contentDigest &&
        visit.assignmentId === j.assignmentId,
    );
    assert.equal(visits.length, 3);
    assert.deepEqual(j.savedVisits.map((x) => x.phase).sort(), [
      'initial',
      'review-24h',
      'review-7d',
    ]);
    for (const expected of j.savedVisits) {
      const matching = visits.filter(
        (visit) =>
          visit.runId === expected.runId && visit.phase === expected.phase,
      );
      assert.equal(matching.length, 1);
      assert.equal(matching[0].installationId, h.installationId);
      assert.equal(matching[0].completedAt, expected.completedAt);
      assert.deepEqual(matching[0].recap, expected.recap);
      assert.equal(matching[0].recap.check.independent, 2);
    }
  }
  async function get(j) {
    const view = value(await http.request(j.childId, 'GET', runPath(j.runId)));
    assert.equal(view.lessonVersion, j.rep.lessonVersion);
    assert.equal(view.contentDigest, j.rep.contentDigest);
    assert.equal(view.corpusVersion, v);
    assert.equal(view.installationId, h.installationId);
    assertSafeRun(view);
    return view;
  }
  async function action(j, body) {
    const before = await get(j);
    const saved = value(
      await http.request(
        j.childId,
        'POST',
        runPath(j.runId) + '/actions',
        body,
      ),
    );
    assert.equal(saved.replayed, false);
    const ack = saved.ack;
    assert(ack);
    const after = await get(j);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(ack.revision, after.revision);
    return { ack, after };
  }
  async function choose(rep, index, mode) {
    const f = family(index),
      oracle = oracles.find((x) => x.lessonVersion === rep.lessonVersion);
    assert(oracle);
    value(
      await http.request(
        f.parentId,
        'PUT',
        childPath(f.childId, 'onboarding'),
        {
          nickname: 'Synthetic candidate learner',
          experience: 'new',
          audioReady: true,
        },
      ),
    );
    const catalog = value(
      await http.request(
        f.parentId,
        'GET',
        childPath(f.childId, 'catalog') +
          query +
          '&q=' +
          encodeURIComponent(oracle.targets[0].hanzi),
      ),
    );
    const selected = catalog.items.find(
      (x) => x.lessonVersion === rep.lessonVersion,
    );
    assert(selected, 'Literal representative absent from real catalog');
    const proposal = value(
      await http.request(
        f.parentId,
        'POST',
        childPath(f.childId, 'catalog/proposals'),
        {
          corpusVersion: v,
          selection: {
            lessonVersion: selected.lessonVersion,
            contentDigest: selected.contentDigest,
            releaseId: selected.releaseId,
            releaseRevision: selected.releaseRevision,
          },
          predecessorProposalId: null,
          expectedSourceDigest: null,
        },
      ),
    ).proposal;
    const plan = value(
      await http.request(
        f.parentId,
        'POST',
        childPath(f.childId, 'placement/approve'),
        {
          proposalId: proposal.proposalId,
          sourceDigest: proposal.sourceDigest,
        },
      ),
    ).plan;
    assert.equal(plan.proposalId, proposal.proposalId);
    const assignmentId = plan.items.find(
      (x) => x.lessonVersion === rep.lessonVersion,
    )?.assignmentId;
    assert(assignmentId, 'Approved safe plan omitted assignment');
    const stored = await http.inspect({ kind: 'assignment', assignmentId });
    assert.equal(stored.assignment.id, assignmentId);
    const slot = stored.schedules.find((x) => x.kind === 'initial');
    assert(slot);
    const ack = value(
      await http.request(
        f.childId,
        'POST',
        '/api/pilot/curriculum/assignments/' +
          encodeURIComponent(assignmentId) +
          '/start',
        { requestId: randomUUID(), scheduleId: slot.id },
      ),
    );
    assert.equal(ack.assignmentId, assignmentId);
    return {
      ...f,
      rep,
      oracle,
      mode,
      assignmentId,
      runId: ack.runId,
      proposalId: proposal.proposalId,
      planId: plan.planId,
      sourceDigest: proposal.sourceDigest,
      slots: stored.schedules,
      savedVisits: [],
    };
  }
  async function drive(j) {
    let injected = false,
      steps = 0;
    for (; steps < 160; steps++) {
      let view = await get(j);
      if (view.state.completedAt) {
        j.completedAt = Date.parse(view.state.completedAt);
        assert(Number.isFinite(j.completedAt));
        const expected = {
          runId: view.runId,
          phase: view.state.phase,
          completedAt: view.state.completedAt,
          recap: view.recap,
        };
        assert(view.recap);
        if (!j.savedVisits.some((x) => x.runId === view.runId))
          j.savedVisits.push(expected);
        return view;
      }
      if (view.question?.status === 'open' && !injected && j.mode !== 'clean') {
        injected = true;
        if (j.mode === 'help') {
          const before = view;
          const correct = literalNextAction(view, j.oracle, randomUUID())
            .payload.choiceId;
          const wrong = view.question.choices.find(
            (x) => x.choiceId !== correct,
          );
          assert(wrong);
          const first = await action(
            j,
            actionBody(view, randomUUID(), 'answer', {
              choiceId: wrong.choiceId,
            }),
          );
          assert.equal(first.ack.result.outcome, 'incorrect');
          assert.equal(first.ack.result.firstResponse, true);
          view = await get(j);
          await action(j, actionBody(view, randomUUID(), 'help'));
          view = await get(j);
          const corrected = await action(
            j,
            literalNextAction(view, j.oracle, randomUUID()),
          );
          assert(corrected.after.revision > before.revision);
          assert.equal(corrected.ack.result.firstResponse, false);
          assert.equal(corrected.ack.result.assisted, true);
        } else {
          const first = await action(
            j,
            literalNextAction(view, j.oracle, randomUUID()),
          );
          assert.equal(first.ack.result.outcome, 'correct');
          const preserved = first.after.events;
          const unavailable = await action(
            j,
            actionBody(first.after, randomUUID(), 'audio-unavailable'),
          );
          assert.equal(unavailable.ack.result.outcome, 'unavailable');
          assert.deepEqual(
            unavailable.after.events.slice(0, preserved.length),
            preserved,
          );
        }
        continue;
      }
      await action(j, literalNextAction(view, j.oracle, randomUUID()));
    }
    assert.fail('Finite real lesson did not complete');
  }
  for (const rep of h.representatives) {
    let primary;
    await execute(rep, 'selection', async () => {
      primary = await choose(rep, rep.familyIndex, 'clean');
      journeys.push(primary);
      return {
        assignmentId: primary.assignmentId,
        proposalId: primary.proposalId,
        planId: primary.planId,
      };
    });
    if (!primary) continue;
    await execute(rep, 'approval', async () => {
      const before = await http.inspect({ kind: 'counts' });
      const ack = value(
        await http.request(
          primary.parentId,
          'POST',
          childPath(primary.childId, 'placement/approve'),
          {
            proposalId: primary.proposalId,
            sourceDigest: primary.sourceDigest,
          },
        ),
      );
      assert.equal(ack.plan.planId, primary.planId);
      assert.deepEqual(
        (await http.inspect({ kind: 'counts' })).counts,
        before.counts,
      );
      return { exactReplay: true, planId: primary.planId };
    });
    await execute(rep, 'duplicate-conflict', async () => {
      const view = await get(primary),
        body = literalNextAction(view, primary.oracle, randomUUID());
      const first = await action(primary, body),
        sql = await http.inspect({ kind: 'run', runId: primary.runId });
      const replay = value(
        await http.request(
          primary.childId,
          'POST',
          runPath(primary.runId) + '/actions',
          body,
        ),
      );
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.ack, first.ack);
      assert.deepEqual(
        await http.inspect({ kind: 'run', runId: primary.runId }),
        sql,
      );
      const conflict = await http.request(
        primary.childId,
        'POST',
        runPath(primary.runId) + '/actions',
        { ...body, expectedRevision: body.expectedRevision + 1 },
      );
      assert.equal(conflict.status, 409);
      assert.equal(
        conflict.body.error?.code ?? conflict.body.code,
        'EVENT_CONFLICT',
      );
      assert.deepEqual(
        await http.inspect({ kind: 'run', runId: primary.runId }),
        sql,
      );
      return {
        eventId: body.eventId,
        exactReplay: true,
        changedBodyStatus: conflict.status,
      };
    });
    await execute(rep, 'recognition', async () => {
      const result = await drive(primary);
      assert.equal(result.recap.check.independent, 2);
      const sql = await http.inspect({ kind: 'run', runId: primary.runId });
      assert.equal(sql.run.revision, result.revision);
      assert(sql.events.length > 0);
      return {
        runId: primary.runId,
        revision: result.revision,
        recap: result.recap,
      };
    });
    await execute(rep, 'help', async () => {
      const j = await choose(rep, rep.helpFamilyIndex, 'help');
      journeys.push(j);
      const result = await drive(j);
      assert(result.recap.familiarity.supported > 0);
      return { runId: j.runId, recap: result.recap };
    });
    await execute(rep, 'audio-unavailable', async () => {
      const j = await choose(rep, rep.audioFamilyIndex, 'unavailable');
      journeys.push(j);
      const result = await drive(j);
      assert(result.recap.familiarity.unavailable > 0);
      return { runId: j.runId, recap: result.recap };
    });
    await execute(rep, 'ownership', async () => {
      const r = await http.request(
        h.foreignParentId,
        'GET',
        runPath(primary.runId),
      );
      assert.equal(r.status, 404);
      const denied = await http.request(
        h.ungrantedTeacherId,
        'GET',
        childPath(primary.childId, 'progress'),
      );
      assert.equal(denied.status, 404);
      return {
        foreignRunStatus: r.status,
        ungrantedProgressStatus: denied.status,
      };
    });
    await execute(rep, 'restart', async () => {
      const before = await get(primary);
      value(await http.control('/restart', {}));
      const after = await get(primary);
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.recap, before.recap);
      return { runId: primary.runId, revision: after.revision };
    });
  }
  await browserInitial();
  for (const phase of ['review-24h', 'review-7d']) {
    const offset = phase === 'review-24h' ? DAY : 7 * DAY,
      due = Math.max(
        ...journeys
          .filter((j) => j.mode === 'clean')
          .map((j) => j.completedAt + offset),
      );
    const boundaries = new Map();
    for (const j of journeys.filter((x) => x.mode === 'clean')) {
      const stored = await http.inspect({
          kind: 'assignment',
          assignmentId: j.assignmentId,
        }),
        slot = stored.schedules.find((x) => x.kind === phase);
      assert(slot);
      const premature = await http.request(
        j.childId,
        'POST',
        '/api/pilot/curriculum/assignments/' +
          encodeURIComponent(j.assignmentId) +
          '/start',
        { requestId: randomUUID(), scheduleId: slot.id },
      );
      assert.equal(premature.status, 409);
      assert.equal(
        premature.body.error?.code ?? premature.body.code,
        'REVIEW_NOT_DUE',
      );
      boundaries.set(j.rep.lessonVersion, premature.status);
    }
    value(await http.control('/clock', { at: due }));
    for (const j of journeys.filter((j) => j.mode === 'clean'))
      await execute(j.rep, phase, async () => {
        const stored = await http.inspect({
            kind: 'assignment',
            assignmentId: j.assignmentId,
          }),
          slot = stored.schedules.find((x) => x.kind === phase);
        assert(slot);
        assert.equal(Number(slot.dueAt), j.completedAt + offset);
        const ack = value(
          await http.request(
            j.childId,
            'POST',
            '/api/pilot/curriculum/assignments/' +
              encodeURIComponent(j.assignmentId) +
              '/start',
            { requestId: randomUUID(), scheduleId: slot.id },
          ),
        );
        const visit = { ...j, runId: ack.runId, mode: 'clean' },
          result = await drive(visit);
        assert.equal(result.state.phase, phase);
        assert.equal(result.recap.check.independent, 2);
        return {
          runId: visit.runId,
          dueAt: Number(slot.dueAt),
          preboundaryStatus: boundaries.get(j.rep.lessonVersion),
          phase,
          recap: result.recap,
        };
      });
  }
  for (const j of journeys.filter((x) => x.mode === 'clean'))
    await execute(j.rep, 'progress-export', async () => {
      const progress = value(
          await http.request(
            j.parentId,
            'GET',
            childPath(j.childId, 'progress'),
          ),
        ),
        exported = value(
          await http.request(j.parentId, 'GET', childPath(j.childId, 'export')),
        );
      for (const object of [progress, exported]) assertVisits(object, j);
      return {
        childId: j.childId,
        version: j.rep.lessonVersion,
        threePhases: true,
      };
    });
  const backup = value(await http.control('/backup', {}));
  assert.equal(backup.tableCount, 67);
  const restored = value(
    await http.control('/restore', {
      archiveId: backup.archiveId,
      variant: 'exact',
    }),
  );
  assert.equal(restored.status, 'CONFIRMED');
  assert(restored.baseURL);
  assert.notEqual(restored.installationId, h.installationId);
  for (const j of journeys.filter((x) => x.mode === 'clean'))
    await execute(j.rep, 'recovery', async () => {
      const oldSession = await http.replaySession(
        j.parentId,
        childPath(j.childId, 'progress'),
        restored.baseURL,
      );
      assert.equal(
        oldSession.status,
        401,
        'Original installation session survived fresh restore',
      );
      const result = value(
        await http.request(
          j.parentId,
          'GET',
          childPath(j.childId, 'progress'),
          undefined,
          restored.baseURL,
        ),
      );
      assertVisits(result, j);
      const plans = value(
        await http.request(
          j.childId,
          'GET',
          childPath(j.childId, 'plan') + query,
          undefined,
          restored.baseURL,
        ),
      );
      assert.equal(plans.plan, null);
      const denied = await http.request(
        j.childId,
        'POST',
        '/api/pilot/curriculum/assignments/' +
          encodeURIComponent(j.assignmentId) +
          '/start',
        { requestId: randomUUID(), scheduleId: j.slots[0].id },
        restored.baseURL,
      );
      assert.equal(denied.status, 404);
      return {
        restoredInstallationId: restored.installationId,
        historicalVersion: j.rep.lessonVersion,
        newStartStatus: denied.status,
      };
    });
  return journeys;
}
