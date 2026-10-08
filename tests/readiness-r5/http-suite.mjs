// Independent normal HTTP journeys. The runner supplies only owned transport,
// scoped synthetic personas and closed controls; no app reducer/store imports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { COLLECTION, LESSONS, PHASES, findPrintedTarget } from './oracle.mjs';
const selector = '?collectionVersion=' + encodeURIComponent(COLLECTION.version);
const childPath = (id) => '/api/pilot/children/' + encodeURIComponent(id);
const runPath = (id) =>
  '/api/pilot/curriculum/learning-runs/' + encodeURIComponent(id);
export async function readRun(a, actor, id) {
  const r = await a.request(actor, 'GET', runPath(id));
  assert.equal(r.status, 200);
  assert.equal(r.body.schemaVersion, 'r5-story-view-1');
  return r.body;
}
export async function sendAction(a, actor, view, type, payload = {}) {
  const body = {
    eventId: randomUUID(),
    expectedRevision: view.revision,
    occurrenceId: view.question?.occurrenceId ?? null,
    type,
    payload,
  };
  const result = await a.request(
    actor,
    'POST',
    runPath(view.runId) + '/actions',
    body,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.ack.eventId, body.eventId);
  assert.equal(result.body.ack.revision, view.revision + 1);
  a.rememberAction?.(view.runId, body, result.body);
  return {
    body,
    result: result.body,
    view: await readRun(a, actor, view.runId),
  };
}
export async function completeRun(
  a,
  actor,
  id,
  { helpFirst = false, unavailable = false } = {},
) {
  let view = await readRun(a, actor, id),
    count = 0;
  const lesson = LESSONS.find((l) => l.version === view.lessonVersion);
  assert(lesson);
  while (!view.state.completedAt) {
    assert(++count < 80, 'Bounded generic journey');
    const question = view.question;
    if (question?.status === 'open') {
      if (helpFirst) {
        view = (await sendAction(a, actor, view, 'help')).view;
        helpFirst = false;
        continue;
      }
      if (
        unavailable ||
        (view.soundReview === 'pending' && question.requiresAudio)
      ) {
        view = (await sendAction(a, actor, view, 'audio-unavailable')).view;
        continue;
      }
      const index = view.lesson.targets.findIndex(
        (t) => t.characterId === question.characterId,
      );
      assert(index >= 0 && index < 2);
      assert.equal(view.lesson.targets[index].hanzi, lesson.targets[index]);
      const choice = findPrintedTarget(question.choices, lesson.targets[index]);
      view = (
        await sendAction(a, actor, view, 'answer', {
          choiceId: choice.choiceId,
        })
      ).view;
    } else view = (await sendAction(a, actor, view, 'continue')).view;
    const cues = view.lesson.playback.cues;
    assert(cues.length <= 3);
    if (view.question) assert.equal(cues.length, 1);
    if (['welcome', 'recap'].includes(view.state.stepId))
      assert.equal(cues.length, 0);
  }
  return view;
}
export async function selectStart(a, f, lessonVersion) {
  const base = childPath(f.child.id);
  const placed = await a.request(
    f.parent,
    'GET',
    base + '/placement' + selector,
  );
  assert.equal(placed.status, 200);
  const current = placed.body.proposal;
  const proposal = await a.request(
    f.parent,
    'POST',
    base + '/placement/proposals',
    {
      collectionVersion: COLLECTION.version,
      lessonVersion,
      predecessorProposalId: current?.proposalId ?? null,
      expectedSourceDigest: current?.sourceDigest ?? null,
    },
  );
  assert.equal(proposal.status, 200);
  const approved = await a.request(
    f.parent,
    'POST',
    base + '/placement/approve',
    {
      proposalId: proposal.body.proposal.proposalId,
      sourceDigest: proposal.body.proposal.sourceDigest,
    },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.plan.items.length, 1);
  const practice = await a.request(
    f.child,
    'GET',
    base + '/practice' + selector,
  );
  assert.equal(practice.status, 200);
  const initial = practice.body.items.find(
    (i) =>
      i.kind === 'initial' &&
      i.assignmentId === approved.body.plan.items[0].assignmentId &&
      i.lessonVersion === lessonVersion,
  );
  assert(initial);
  const started = await a.request(
    f.child,
    'POST',
    '/api/pilot/curriculum/assignments/' + initial.assignmentId + '/start',
    { requestId: randomUUID(), scheduleId: initial.scheduleId },
  );
  assert.equal(started.status, 200);
  return {
    proposal: proposal.body.proposal,
    plan: approved.body.plan,
    initial,
    runId: started.body.runId,
  };
}
export async function runHttpSuite(a, { lessonVersion = null } = {}) {
  if (lessonVersion) assert(LESSONS.some((l) => l.version === lessonVersion));
  const results = [];
  let thin;
  async function run(id, scenarios, fn) {
    try {
      results.push({ id, scenarios, outcome: 'PASS', evidence: await fn() });
    } catch (error) {
      results.push({ id, scenarios, outcome: 'FAIL', error: error.message });
    }
    await a.recordResults(results);
  }
  await run(
    'T01-initial-24h-7d-restart',
    ['recognition', 'review-24h', 'review-7d', 'restart', 'progress-export'],
    async () => {
      const f = await a.familyFixture('r5-thin'),
        selected = await selectStart(a, f, lessonVersion ?? 'path-01-v1');
      thin = { f, selected };
      const initial = await completeRun(a, f.child, selected.runId),
        completed = Date.parse(initial.state.completedAt);
      const before = JSON.stringify(initial.events),
        visits = [];
      for (const phase of ['review-24h', 'review-7d']) {
        await a.setServerTime(completed + PHASES[phase] - 1);
        const p = await a.request(
          f.child,
          'GET',
          childPath(f.child.id) + '/practice' + selector,
        );
        assert.equal(p.status, 200);
        const scheduled = p.body.items.find(
          (i) => i.assignmentId === initial.assignmentId && i.kind === phase,
        );
        assert(scheduled);
        assert.equal(Date.parse(scheduled.dueAt), completed + PHASES[phase]);
        const early = await a.request(
          f.child,
          'POST',
          '/api/pilot/curriculum/assignments/' +
            initial.assignmentId +
            '/start',
          { requestId: randomUUID(), scheduleId: scheduled.scheduleId },
        );
        assert.equal(early.status, 409);
        await a.setServerTime(completed + PHASES[phase]);
        const started = await a.request(
          f.child,
          'POST',
          '/api/pilot/curriculum/assignments/' +
            initial.assignmentId +
            '/start',
          { requestId: randomUUID(), scheduleId: scheduled.scheduleId },
        );
        assert.equal(started.status, 200);
        const reviewed = await completeRun(a, f.child, started.body.runId);
        assert.equal(reviewed.state.phase, phase);
        visits.push({
          phase,
          runId: reviewed.runId,
          completedAt: reviewed.state.completedAt,
        });
      }
      assert.equal(
        new Set([initial.runId, ...visits.map((v) => v.runId)]).size,
        3,
      );
      await a.restartOwnedRuntime('all');
      assert.equal(
        JSON.stringify((await readRun(a, f.child, initial.runId)).events),
        before,
      );
      const progress = await a.request(
        f.parent,
        'GET',
        childPath(f.child.id) + '/progress',
      );
      const exported = await a.request(
        f.parent,
        'GET',
        childPath(f.child.id) + '/export',
      );
      assert.equal(progress.status, 200);
      assert.equal(exported.status, 200);
      assert(progress.body.collections && exported.body.collections);
      for (const report of [progress.body, exported.body]) {
        const collection = report.collections.find(
          (c) => c.collectionVersion === COLLECTION.version,
        );
        assert(collection);
        const actual = collection.visits.filter(
          (v) => v.assignmentId === initial.assignmentId,
        );
        assert.equal(actual.length, 3);
        assert(
          actual.every(
            (v) =>
              v.lessonVersion === initial.lessonVersion &&
              v.contentDigest === initial.contentDigest &&
              v.completedAt,
          ),
        );
        assert.deepEqual(
          actual.map((v) => v.phase).sort(),
          Object.keys(PHASES).sort(),
        );
      }
      const sql = await a.inspectAssignment(initial.assignmentId);
      assert.deepEqual(
        sql.schedules.map((s) => s.kind).sort(),
        ['initial', 'review-24h', 'review-7d'].sort(),
      );
      assert.equal(sql.runs.length, 3);
      return {
        assignmentId: initial.assignmentId,
        initialRunId: initial.runId,
        visits,
      };
    },
  );
  if (results[0].outcome !== 'PASS') return results;
  await run(
    'H03-safe-library-selectors',
    ['selection', 'ownership'],
    async () => {
      const f = await a.familyFixture('r5-library'),
        base = childPath(f.child.id) + '/library';
      const r = await a.request(f.parent, 'GET', base + selector);
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 10);
      assert.deepEqual(
        r.body.items.map((i) => i.lessonVersion),
        LESSONS.map((l) => l.version),
      );
      assert(!/correctChoiceId|reviewNotes/.test(JSON.stringify(r.body)));
      assert.equal(
        (await a.request(f.parent, 'GET', base + '?collectionVersion=unknown'))
          .status,
        400,
      );
      assert.equal(
        (await a.request(f.otherParent, 'GET', base + selector)).status,
        404,
      );
      return { itemCount: 10 };
    },
  );
  if (!lessonVersion)
    await run(
      'H04-current-selection-approval',
      ['selection', 'approval', 'duplicate-conflict'],
      async () => {
        const f = await a.familyFixture('r5-selection-cas'),
          base = childPath(f.child.id);
        const current = await a.request(
          f.parent,
          'GET',
          base + '/placement' + selector,
        );
        assert.equal(current.status, 200);
        const previous = current.body.proposal;
        const first = await a.request(
          f.parent,
          'POST',
          base + '/placement/proposals',
          {
            collectionVersion: COLLECTION.version,
            lessonVersion: 'path-03-v1',
            predecessorProposalId: previous?.proposalId ?? null,
            expectedSourceDigest: previous?.sourceDigest ?? null,
          },
        );
        assert.equal(first.status, 200);
        const p = first.body.proposal;
        const second = await a.request(
          f.parent,
          'POST',
          base + '/placement/proposals',
          {
            collectionVersion: COLLECTION.version,
            lessonVersion: 'path-04-v1',
            predecessorProposalId: p.proposalId,
            expectedSourceDigest: p.sourceDigest,
          },
        );
        assert.equal(second.status, 200);
        assert.notEqual(second.body.proposal.proposalId, p.proposalId);
        const stale = await a.request(
          f.parent,
          'POST',
          base + '/placement/approve',
          { proposalId: p.proposalId, sourceDigest: p.sourceDigest },
        );
        assert.equal(stale.status, 409);
        const body = {
          proposalId: second.body.proposal.proposalId,
          sourceDigest: second.body.proposal.sourceDigest,
        };
        const approved = await a.request(
          f.parent,
          'POST',
          base + '/placement/approve',
          body,
        );
        assert.equal(approved.status, 200);
        const replay = await a.request(
          f.parent,
          'POST',
          base + '/placement/approve',
          body,
        );
        assert.equal(replay.status, 200);
        assert.equal(replay.body.plan.planId, approved.body.plan.planId);
        assert.equal(approved.body.plan.items.length, 1);
        return {
          planId: approved.body.plan.planId,
          lessonVersion: 'path-04-v1',
        };
      },
    );
  await run(
    'H07-exact-action-retry-conflict',
    ['duplicate-conflict'],
    async () => {
      const f = lessonVersion
        ? thin.f
        : await a.familyFixture('r5-action-retry');
      const selected = lessonVersion
        ? thin.selected
        : await selectStart(a, f, 'path-05-v1');
      const before = await readRun(a, f.child, selected.runId);
      const sent = lessonVersion
        ? a.lastAction(selected.runId)
        : await sendAction(a, f.child, before, 'continue');
      assert(sent);
      const replay = await a.request(
        f.child,
        'POST',
        runPath(before.runId) + '/actions',
        sent.body,
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.deepEqual(replay.body.ack, sent.result.ack);
      const changed = await a.request(
        f.child,
        'POST',
        runPath(before.runId) + '/actions',
        { ...sent.body, type: sent.body.type === 'help' ? 'continue' : 'help' },
      );
      assert.equal(changed.status, 409);
      const sql = await a.inspectRun(before.runId);
      assert.equal(
        sql.events.filter((e) => e.event_id === sent.body.eventId).length,
        1,
      );
      return {
        runId: before.runId,
        eventId: sent.body.eventId,
        matchingEventCount: 1,
      };
    },
  );
  if (lessonVersion)
    await run(
      'P-selection-current-approval',
      ['selection', 'approval'],
      async () => {
        const { f, selected } = thin;
        const approved = await a.request(
          f.parent,
          'POST',
          childPath(f.child.id) + '/placement/approve',
          {
            proposalId: selected.proposal.proposalId,
            sourceDigest: selected.proposal.sourceDigest,
          },
        );
        assert.equal(approved.status, 200);
        assert.equal(approved.body.plan.planId, selected.plan.planId);
        return {
          lessonVersion,
          planId: selected.plan.planId,
          runId: selected.runId,
        };
      },
    );
  const paths = lessonVersion
    ? [
        LESSONS.find((l) => l.version === lessonVersion),
        LESSONS.find((l) => l.version === lessonVersion),
      ]
    : LESSONS.slice(1);
  for (const [variant, lesson] of paths.entries())
    await run(
      'H06-' + lesson.version + '-' + variant,
      lessonVersion
        ? variant === 0
          ? ['recognition', 'help']
          : ['audio-unavailable']
        : ['recognition'],
      async () => {
        const f = await a.familyFixture('r5-' + lesson.version + '-' + variant),
          selected = await selectStart(a, f, lesson.version);
        const view = await completeRun(a, f.child, selected.runId, {
          helpFirst: lessonVersion ? variant === 0 : lesson.sequence % 3 === 0,
          unavailable: lessonVersion
            ? variant === 1
            : lesson.sequence % 3 === 1,
        });
        return {
          lessonVersion: lesson.version,
          targets: lesson.targets,
          runId: view.runId,
          recap: view.recap,
        };
      },
    );
  if (lessonVersion)
    await run('P-v5-package-recovery', ['recovery'], async () => {
      const f = await a.familyFixture('r5-recovery-readback');
      const prior = await a.request(
        f.parent,
        'GET',
        childPath(f.child.id) + '/progress',
      );
      assert.equal(prior.status, 200);
      const expected = prior.body.collections
        .flatMap((c) => c.visits)
        .filter((v) => v.lessonVersion === lessonVersion);
      assert(expected.length >= 3);
      const archive = await a.backup();
      assert.equal(archive.format, 'pilot-admin-backup-5');
      assert.equal(Object.keys(archive.counts).length, 45);
      const restored = await a.restore();
      assert(
        restored.baseURL,
        'Restore missing baseURL: ' +
          JSON.stringify({
            status: ['REFUSED', 'NOT_COMMITTED', 'UNCONFIRMED'].includes(
              restored.status,
            )
              ? restored.status
              : null,
            error: /^[A-Z0-9_]+$/.test(restored.error ?? '')
              ? restored.error
              : null,
            commit: ['confirmed', 'unconfirmed'].includes(restored.commit)
              ? restored.commit
              : null,
          }),
      );
      assert.notEqual(
        restored.readback.installationId,
        restored.sourceInstallationId,
      );
      const oldSession = await a.request(
        f.parent,
        'GET',
        '/api/pilot/me',
        undefined,
        { base: restored.baseURL, originalSession: true },
      );
      assert.equal(oldSession.status, 401);
      for (const route of ['progress', 'export']) {
        const response = await a.request(
          f.parent,
          'GET',
          childPath(f.child.id) + '/' + route,
          undefined,
          { base: restored.baseURL },
        );
        assert.equal(response.status, 200);
        const actual = response.body.collections
          .flatMap((c) => c.visits)
          .filter((v) => v.lessonVersion === lessonVersion);
        assert.deepEqual(actual, expected);
      }
      const start = await a.request(
        f.child,
        'POST',
        '/api/pilot/curriculum/assignments/' +
          expected[0].assignmentId +
          '/start',
        { requestId: randomUUID(), scheduleId: expected[0].scheduleId },
        { base: restored.baseURL },
      );
      assert(
        [403, 404, 409].includes(start.status),
        'Historical authority must not permit a new ordinary start',
      );
      return {
        lessonVersion,
        contentDigest: expected[0].contentDigest,
        format: archive.format,
        tableCount: 45,
        sourceInstallationId: restored.sourceInstallationId,
        restoredInstallationId: restored.readback.installationId,
        visitCount: expected.length,
      };
    });
  return results;
}
