// Narrow independent actual HTTP probe for owned R5 final-write fault controls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createHttpAdapter } from './http-runner.mjs';
import { readRun, sendAction } from './http-suite.mjs';
import { COLLECTION, findPrintedTarget, LESSONS } from './oracle.mjs';
export async function probeFinalWrite(h, output) {
  await fs.mkdir(output, { mode: 0o700 });
  const a = await createHttpAdapter(h, output);
  const secret = JSON.parse(await fs.readFile(h.credentialsFile, 'utf8'));
  const results = [];
  const control = async (route, body, base = h.controlURL) => {
    const r = await fetch(new URL(route, base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hanzi-Test-Token': secret.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const counts = () =>
    control('/inspect', { kind: 'counts' }, h.collection.controlURL);
  const f = await a.familyFixture('R5 final-write rollback');
  const child = '/api/pilot/children/' + f.child.id;
  const selector = '?collectionVersion=' + COLLECTION.version;
  try {
    const placement = await a.request(
      f.parent,
      'GET',
      child + '/placement' + selector,
    );
    assert.equal(placement.status, 200);
    const p = placement.body.proposal;
    const proposed = await a.request(
      f.parent,
      'POST',
      child + '/placement/proposals',
      {
        collectionVersion: COLLECTION.version,
        lessonVersion: 'path-01-v1',
        predecessorProposalId: p?.proposalId ?? null,
        expectedSourceDigest: p?.sourceDigest ?? null,
      },
    );
    assert.equal(proposed.status, 200);
    const approval = {
      proposalId: proposed.body.proposal.proposalId,
      sourceDigest: proposed.body.proposal.sourceDigest,
    };
    const beforePlan = await counts();
    await control('/fault-final', { operation: 'plan', enabled: true });
    const failedApproval = await a.request(
      f.parent,
      'POST',
      child + '/placement/approve',
      approval,
    );
    const afterFaultPlan = await counts();
    results.push({
      id: 'R5-E-005-final-plan',
      status: failedApproval.status,
      before: beforePlan,
      after: afterFaultPlan,
    });
    await fs.writeFile(
      path.join(output, 'results.json'),
      JSON.stringify({ candidateId: h.candidateId, results }, null, 2) + '\n',
    );
    assert.notEqual(
      failedApproval.status,
      200,
      'Enabled R5 plan fault must refuse approval',
    );
    assert.deepEqual(afterFaultPlan, beforePlan);
    await control('/fault-final', { operation: 'plan', enabled: false });
    const approved = await a.request(
      f.parent,
      'POST',
      child + '/placement/approve',
      approval,
    );
    assert.equal(approved.status, 200);
    const savedPlan = await counts();
    assert.equal(
      savedPlan.pilot_collection_plan,
      beforePlan.pilot_collection_plan + 1,
    );
    assert.equal(
      savedPlan.pilot_collection_assignment,
      beforePlan.pilot_collection_assignment + 1,
    );
    assert.equal(
      savedPlan.pilot_collection_schedule,
      beforePlan.pilot_collection_schedule + 1,
    );
    assert.equal(
      (
        await a.request(
          f.parent,
          'POST',
          child + '/placement/approve',
          approval,
        )
      ).status,
      200,
    );
    assert.deepEqual(await counts(), savedPlan);
    const practice = await a.request(
      f.child,
      'GET',
      child + '/practice' + selector,
    );
    assert.equal(practice.status, 200);
    const initial = practice.body.items.find(
      (i) =>
        i.kind === 'initial' &&
        i.assignmentId === approved.body.plan.items[0].assignmentId,
    );
    assert(initial);
    const started = await a.request(
      f.child,
      'POST',
      '/api/pilot/curriculum/assignments/' + initial.assignmentId + '/start',
      { requestId: randomUUID(), scheduleId: initial.scheduleId },
    );
    assert.equal(started.status, 200);
    let v = await readRun(a, f.child, started.body.runId),
      steps = 0;
    while (
      !(
        v.state.stepId === 'check' &&
        v.state.questionIndex === 1 &&
        v.question?.status !== 'open'
      )
    ) {
      assert(++steps < 80);
      const q = v.question;
      if (q?.status === 'open') {
        if (q.requiresAudio && v.soundReview === 'pending')
          v = (await sendAction(a, f.child, v, 'audio-unavailable')).view;
        else {
          const index = v.lesson.targets.findIndex(
            (t) => t.characterId === q.characterId,
          );
          assert(index >= 0);
          const choice = findPrintedTarget(
            q.choices,
            LESSONS[0].targets[index],
          );
          v = (
            await sendAction(a, f.child, v, 'answer', {
              choiceId: choice.choiceId,
            })
          ).view;
        }
      } else v = (await sendAction(a, f.child, v, 'continue')).view;
    }
    assert.equal(v.state.completedAt, null);
    const beforeCompletion = await counts();
    const beforeSlots = await a.inspectAssignment(initial.assignmentId);
    assert.equal(beforeSlots.schedules.length, 1);
    const envelope = {
      eventId: randomUUID(),
      expectedRevision: v.revision,
      occurrenceId: v.question.occurrenceId,
      type: 'continue',
      payload: {},
    };
    const endpoint =
      '/api/pilot/curriculum/learning-runs/' + v.runId + '/actions';
    await control('/fault-final', { operation: 'action', enabled: true });
    const failed = await a.request(f.child, 'POST', endpoint, envelope);
    assert.notEqual(failed.status, 200);
    assert.deepEqual(await counts(), beforeCompletion);
    const held = await readRun(a, f.child, v.runId);
    assert.equal(held.revision, v.revision);
    assert.equal(held.state.completedAt, null);
    assert.deepEqual(held.events, v.events);
    assert.equal(
      (await a.inspectAssignment(initial.assignmentId)).schedules.length,
      1,
    );
    await control('/fault-final', { operation: 'action', enabled: false });
    const committed = await a.request(f.child, 'POST', endpoint, envelope);
    assert.equal(committed.status, 200);
    assert.equal(committed.body.ack.revision, v.revision + 1);
    const completed = await readRun(a, f.child, v.runId);
    assert(completed.state.completedAt);
    const savedCounts = await counts();
    const slots = await a.inspectAssignment(initial.assignmentId);
    assert.equal(slots.schedules.length, 3);
    const at = Date.parse(completed.state.completedAt);
    for (const [kind, delay] of [
      ['review-24h', 86400000],
      ['review-7d', 604800000],
    ]) {
      const slot = slots.schedules.find((s) => s.kind === kind);
      assert(slot);
      assert.equal(Number(slot.due_at), at + delay);
      assert.equal(slot.initial_run_id, v.runId);
    }
    const duplicate = await a.request(f.child, 'POST', endpoint, envelope);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.replayed, true);
    assert.deepEqual(await counts(), savedCounts);
    assert.equal(
      (await readRun(a, f.child, v.runId)).state.completedAt,
      completed.state.completedAt,
    );
    results.push({
      id: 'R5-E-008-final-completion',
      failedStatus: failed.status,
      revisionBefore: v.revision,
      revisionAfter: completed.revision,
      completedAt: completed.state.completedAt,
      schedules: slots.schedules,
      counts: savedCounts,
      exactRetryAndDuplicate: true,
    });
    await a.verifyFrozenIdentity();
    return {
      candidateId: h.candidateId,
      sourceDigest: h.sourceDigest,
      artifactDigest: h.artifactDigest,
      outcome: 'PASS',
      results,
    };
  } catch (error) {
    return {
      candidateId: h.candidateId,
      outcome: 'FAIL',
      results,
      failure: {
        name: error.name,
        code: error.code ?? null,
        expected: typeof error.expected === 'number' ? error.expected : null,
        actual: typeof error.actual === 'number' ? error.actual : null,
      },
    };
  } finally {
    for (const operation of ['plan', 'action'])
      await control('/fault-final', { operation, enabled: false });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [handoff, output] = process.argv.slice(2);
  assert(handoff && output && process.argv.length === 4);
  const h = JSON.parse(await fs.readFile(handoff, 'utf8'));
  const r = await probeFinalWrite(h, output);
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(r, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      outcome: r.outcome,
      caseCount: r.results.length,
      failure: r.failure ?? null,
    }),
  );
  process.exitCode = r.outcome === 'PASS' ? 0 : 1;
}
