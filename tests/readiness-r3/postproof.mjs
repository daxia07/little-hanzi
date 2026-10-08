// Independent real API post-signing phase. Never constructs a signed PASS receipt.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntimeAdapter } from './runtime-adapter.mjs';
import { receiptNegativeCases } from './receipt-cases.mjs';
import { V4_TABLES, CONTRACT } from './oracle.mjs';
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  assert(
    ['--handoff', '--receipt', '--output'].includes(k) &&
      !Object.hasOwn(flags, k),
  );
  assert(process.argv[i + 1]);
  flags[k] = process.argv[i + 1];
}
assert(flags['--handoff'] && flags['--receipt'] && flags['--output']);
const hp = await realpath(flags['--handoff']);
assert.equal((await stat(hp)).mode & 0o077, 0);
const h = JSON.parse(await readFile(hp, 'utf8'));
const output = path.resolve(flags['--output']);
assert.equal(await realpath(path.dirname(output)), path.dirname(output));
await mkdir(output, { recursive: false, mode: 0o700 });
const signed = JSON.parse(await readFile(flags['--receipt'], 'utf8'));
assert(signed.receipt && typeof signed.signature === 'string');
const accounts = JSON.parse(await readFile(h.credentialsFile, 'utf8')).accounts;
const account = (label) => {
  const a = accounts.find((v) => v.label === label);
  assert(a);
  return { id: a.id, label: a.label };
};
const operator = account('operator'),
  parent = account('parent-a'),
  child = account('child-a');
const scope = {
  kind: 'supervised-trial',
  members: [
    { childId: child.id, parentId: parent.id, planScope: CONTRACT.lesson },
  ],
};
const report = {
  schemaVersion: 'r3-postproof-report-1',
  candidateId: h.candidateId,
  sourceDigest: h.sourceDigest,
  artifactDigest: h.artifactDigest,
  contentDigest: h.contentDigest,
  startedAt: Date.now(),
  cases: [],
  limitations: [
    'Synthetic rejected owner/review facts are not human acceptance.',
    'Only actual returned table counts support population claims.',
  ],
};
let runtime, runId;
async function test(id, fn) {
  let outcome = 'PASS',
    detail;
  try {
    detail = await fn();
  } catch (e) {
    outcome = e.code === 'QA_BLOCKED' ? 'BLOCKED' : 'FAIL';
    detail = { message: e.message };
  }
  const file = `${id}.json`;
  await writeFile(
    path.join(output, file),
    JSON.stringify({ id, outcome, ...detail }, null, 2) + '\n',
  );
  report.cases.push({ id, outcome, evidenceRefs: [file] });
  return outcome;
}
try {
  runtime = await createRuntimeAdapter({ handoff: h, output });
  await runtime.verifyFrozenIdentity();
  const acceptedOutcome =
    await test('P01-accept-real-executed-receipt', async () => {
      const before = await runtime.namedControl('/inspect', { kind: 'counts' });
      const r = await runtime.request(
        operator,
        'POST',
        '/api/pilot/curriculum/proofs',
        signed,
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.receiptId, signed.receipt.receiptId);
      assert.equal(r.body.eligible, true);
      const replay = await runtime.request(
        operator,
        'POST',
        '/api/pilot/curriculum/proofs',
        signed,
      );
      assert.equal(replay.status, 200);
      const after = await runtime.namedControl('/inspect', { kind: 'counts' });
      assert.equal(
        after.counts.pilot_curriculum_proof_receipt,
        before.counts.pilot_curriculum_proof_receipt + 1,
      );
      return { ack: r.body, counts: after.counts };
    });
  if (acceptedOutcome !== 'PASS')
    throw Object.assign(
      Error(
        'Post-proof dependent phase blocked: actual receipt acceptance failed',
      ),
      { code: 'QA_BLOCKED' },
    );
  await test('P02-signed-byte-and-shape-rejections', async () => {
    const before = await runtime.namedControl('/inspect', { kind: 'counts' }),
      results = [];
    for (const mutation of receiptNegativeCases(
      signed.receipt,
      Date.now(),
    ).filter((v) => !v.trustMutation)) {
      const payload = {
        receipt: mutation.receipt || {
          ...signed.receipt,
          reportDigest: 'sha256:' + '0'.repeat(64),
        },
        signature: mutation.signature || signed.signature,
      };
      payload.receipt = {
        ...payload.receipt,
        receiptId: 'qa-negative-' + randomUUID(),
      };
      const r = await runtime.request(
        operator,
        'POST',
        '/api/pilot/curriculum/proofs',
        payload,
      );
      assert.equal(r.status, 409, mutation.id);
      assert(
        [
          'PROOF_INVALID',
          'PROOF_UNTRUSTED',
          'PROOF_IDENTITY_MISMATCH',
        ].includes(r.body.error?.code),
        mutation.id + ' must reach refusal, not existing-ID replay conflict',
      );
      results.push({
        id: mutation.id,
        status: r.status,
        code: r.body.error?.code || r.body.code,
      });
    }
    const after = await runtime.namedControl('/inspect', { kind: 'counts' });
    assert.deepEqual(after, before);
    return {
      results,
      scope:
        'Fresh IDs and deliberately unchanged signature test malformed/tampered refusal only; not isolated valid-signed time or issuer eligibility.',
      notRunTrustMutations: [
        'purpose',
        'revokedAt',
        'notBefore: require separately frozen server trust configuration',
      ],
    };
  });
  await test('P02a-same-receipt-id-conflict', async () => {
    const r = await runtime.request(
      operator,
      'POST',
      '/api/pilot/curriculum/proofs',
      {
        receipt: {
          ...signed.receipt,
          reportDigest: 'sha256:' + '0'.repeat(64),
        },
        signature: signed.signature,
      },
    );
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'EVENT_CONFLICT');
    return { status: r.status, code: r.body.error.code };
  });
  await test('P02b-stale-proposal-and-final-plan-rollback', async () => {
    const setup = '/api/pilot/children/' + child.id + '/onboarding',
      proposal = '/api/pilot/children/' + child.id + '/placement/proposals',
      approve = '/api/pilot/children/' + child.id + '/placement/approve';
    assert.equal(
      (
        await runtime.request(parent, 'PUT', setup, {
          nickname: 'QA atomic first',
          experience: 'new',
          audioReady: true,
        })
      ).status,
      200,
    );
    const p = await runtime.request(parent, 'POST', proposal, {
      lessonVersion: CONTRACT.lesson,
    });
    assert.equal(p.status, 200);
    assert.equal(
      (
        await runtime.request(parent, 'PUT', setup, {
          nickname: 'QA atomic changed',
          experience: 'new',
          audioReady: true,
        })
      ).status,
      200,
    );
    const stale = await runtime.request(parent, 'POST', approve, {
      proposalId: p.body.proposal.proposalId,
      sourceDigest: p.body.proposal.sourceDigest,
    });
    assert.equal(stale.status, 409);
    const fresh = await runtime.request(parent, 'POST', proposal, {
      lessonVersion: CONTRACT.lesson,
    });
    assert.equal(fresh.status, 200);
    const body = {
        proposalId: fresh.body.proposal.proposalId,
        sourceDigest: fresh.body.proposal.sourceDigest,
      },
      before = await runtime.namedControl('/inspect', { kind: 'counts' });
    await runtime.namedControl('/fault-final', {
      operation: 'plan',
      enabled: true,
    });
    let rejected;
    try {
      rejected = await runtime.request(parent, 'POST', approve, body);
      assert.equal(rejected.status, 503);
      assert.deepEqual(
        await runtime.namedControl('/inspect', { kind: 'counts' }),
        before,
      );
    } finally {
      await runtime.namedControl('/fault-final', {
        operation: 'plan',
        enabled: false,
      });
    }
    const accepted = await runtime.request(parent, 'POST', approve, body);
    assert.equal(accepted.status, 200);
    const replay = await runtime.request(parent, 'POST', approve, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.plan.planId, accepted.body.plan.planId);
    return {
      stale: stale.status,
      fault: rejected.status,
      planId: accepted.body.plan.planId,
    };
  });
  await test('P02c-final-action-rollback', async () => {
    const f = await runtime.familyFixture('postproof-final-action'),
      v = await runtime.readRunThroughHTTP(f.child, f.runId),
      body = {
        eventId: randomUUID(),
        expectedRevision: v.revision,
        stepId: v.state.stepId,
        type: 'continue',
        payload: {},
      },
      endpoint = '/api/pilot/curriculum/learning-runs/' + f.runId + '/actions',
      before = await runtime.namedControl('/inspect', {
        kind: 'run',
        runId: f.runId,
      });
    await runtime.namedControl('/fault-final', {
      operation: 'action',
      enabled: true,
    });
    try {
      assert.equal(
        (await runtime.request(f.child, 'POST', endpoint, body)).status,
        503,
      );
      assert.deepEqual(
        await runtime.namedControl('/inspect', { kind: 'run', runId: f.runId }),
        before,
      );
    } finally {
      await runtime.namedControl('/fault-final', {
        operation: 'action',
        enabled: false,
      });
    }
    assert.equal(
      (await runtime.request(f.child, 'POST', endpoint, body)).status,
      200,
    );
    const after = await runtime.namedControl('/inspect', {
      kind: 'run',
      runId: f.runId,
    });
    assert.equal(after.events.length, before.events.length + 1);
    return { runId: f.runId, eventId: body.eventId };
  });
  await test('P02d-current-auth-link-grant-revocation', async () => {
    const f = await runtime.familyFixture('postproof-auth-revocation'),
      v = await runtime.readRunThroughHTTP(f.child, f.runId),
      endpoint = '/api/pilot/curriculum/learning-runs/' + f.runId,
      body = {
        eventId: randomUUID(),
        expectedRevision: v.revision,
        stepId: v.state.stepId,
        type: 'continue',
        payload: {},
      };
    assert.equal(
      (
        await runtime.request(
          operator,
          'POST',
          '/api/pilot/accounts/' + f.child.id + '/status',
          { disabled: true },
        )
      ).status,
      200,
    );
    assert.equal(
      (await runtime.request(f.child, 'POST', endpoint + '/actions', body))
        .status,
      401,
    );
    assert.equal(
      (
        await runtime.request(
          operator,
          'POST',
          '/api/pilot/accounts/' + f.child.id + '/status',
          { disabled: false },
        )
      ).status,
      200,
    );
    assert.equal((await runtime.request(f.child, 'GET', endpoint)).status, 401);
    await runtime.freshFixtureSession(f.child);
    assert.equal((await runtime.request(f.child, 'GET', endpoint)).status, 200);
    const teacher = account('teacher');
    assert.equal(
      (
        await runtime.request(f.parent, 'POST', '/api/pilot/grants', {
          childId: f.child.id,
          teacherId: teacher.id,
        })
      ).status,
      201,
    );
    assert.equal((await runtime.request(teacher, 'GET', endpoint)).status, 200);
    assert.equal(
      (
        await runtime.request(f.parent, 'DELETE', '/api/pilot/grants', {
          childId: f.child.id,
          teacherId: teacher.id,
        })
      ).status,
      200,
    );
    assert.equal((await runtime.request(teacher, 'GET', endpoint)).status, 404);
    assert.equal(
      (
        await runtime.request(operator, 'DELETE', '/api/pilot/links', {
          parentId: f.parent.id,
          childId: f.child.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (await runtime.request(f.parent, 'GET', endpoint)).status,
      404,
    );
    const blocked = await runtime.request(
      f.child,
      'POST',
      endpoint + '/actions',
      { ...body, eventId: randomUUID() },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'LESSON_UNAVAILABLE');
    assert.equal(
      (
        await runtime.request(operator, 'POST', '/api/pilot/links', {
          parentId: f.parent.id,
          childId: f.child.id,
        })
      ).status,
      201,
    );
    const resetPassword = 'Qa-temp-' + randomUUID(),
      restoredPassword = 'Qa-new-' + randomUUID();
    assert.equal(
      (
        await runtime.request(
          operator,
          'POST',
          '/api/pilot/accounts/' + f.child.id + '/reset',
          { password: resetPassword },
        )
      ).status,
      200,
    );
    assert.equal((await runtime.request(f.child, 'GET', endpoint)).status, 401);
    runtime.setPrivateFixturePassword(f.child, resetPassword);
    await runtime.freshFixtureSession(f.child);
    const required = await runtime.request(f.child, 'GET', endpoint);
    assert.equal(required.status, 403);
    assert.equal(required.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(
      (
        await runtime.request(f.child, 'POST', '/api/auth/change-password', {
          currentPassword: resetPassword,
          newPassword: restoredPassword,
          revokeOtherSessions: true,
        })
      ).status,
      200,
    );
    runtime.setPrivateFixturePassword(f.child, restoredPassword);
    await runtime.freshFixtureSession(f.child);
    assert.equal((await runtime.request(f.child, 'GET', endpoint)).status, 200);
    assert.equal(
      (await runtime.request(f.child, 'POST', '/api/auth/sign-out', {})).status,
      200,
    );
    assert.equal((await runtime.request(f.child, 'GET', endpoint)).status, 401);
    return {
      runId: f.runId,
      disabledAndResetOldSession: 401,
      mustChange: 403,
      revokedParentTeacher: 404,
      lostLinkNewAction: 409,
      scope:
        'Synthetic child-a2; passwords retained only in adapter memory, never evidence',
    };
  });
  await test('P03-synthetic-rejected-review-owner', async () => {
    const progress = await runtime.request(
      parent,
      'GET',
      `/api/pilot/children/${child.id}/progress`,
    );
    assert.equal(progress.status, 200);
    assert(progress.body.curriculum.runs.length);
    runId = progress.body.curriculum.runs[0].runId;
    const detail = await runtime.request(
      operator,
      'GET',
      `/api/pilot/curriculum/${CONTRACT.lesson}`,
    );
    assert.equal(detail.status, 200);
    const reviews = detail.body.reviews;
    assert(Array.isArray(reviews));
    const previousReviewId = reviews.at(-1)?.reviewId || null;
    const review = {
      requestId: 'qa-rejected-' + randomUUID(),
      contentDigest: h.contentDigest,
      previousReviewId,
      decision: 'rejected',
      reviewerRef: 'synthetic-qa-no-human-review',
      reviewedAt: Date.now(),
      checklistVersion: 'hanzi-review-1',
      checklist: Object.fromEntries(
        [
          'scriptAndGlyphs',
          'mandarinAndReadings',
          'wordContexts',
          'teachingAndChecks',
          'ageSuitability',
          'sourcesAndLicenses',
          'deviceAudio',
        ].map((k) => [k, false]),
      ),
      evidenceRef: 'synthetic:independent-negative-contract-only',
      reason: 'Synthetic rejection; no owner or Mandarin review occurred.',
    };
    const rr = await runtime.request(
      operator,
      'POST',
      `/api/pilot/curriculum/${CONTRACT.lesson}/reviews`,
      review,
    );
    assert.equal(rr.status, 201);
    const owner = {
      requestId: 'qa-owner-rejected-' + randomUUID(),
      contentDigest: h.contentDigest,
      candidateId: h.candidateId,
      artifactDigest: h.artifactDigest,
      targetInstallationId: h.targetInstallationId,
      scope,
      ownerIdentity: 'synthetic-qa-not-owner',
      decision: 'rejected',
      decidedAt: Date.now(),
      evidenceRef: 'synthetic:no-human-acceptance',
    };
    const or = await runtime.request(
      operator,
      'POST',
      `/api/pilot/curriculum/${CONTRACT.lesson}/decisions`,
      owner,
    );
    assert.equal(or.status, 200);
    return { review: rr.body, owner: or.body, syntheticOnly: true };
  });
  await test('P03b-publication-final-fault-cas-withdrawal', async () => {
    const pub = await runtime.namedControl('/inspect', { kind: 'publication' }),
      head = pub.publications.at(-1);
    assert(head);
    const members = pub.members
      .filter((m) => m.publication_id === head.id)
      .map((m) => ({
        childId: m.child_id,
        parentId: m.parent_id,
        planScope: CONTRACT.lesson,
      }));
    assert(members.length);
    const body = {
        requestId: 'qa-withdraw-' + randomUUID(),
        expectedRevision: Number(head.generation),
        predecessorId: head.id,
        contentDigest: h.contentDigest,
        reviewId: head.review_id,
        proofId: head.proof_id,
        ownerDecisionId: head.owner_decision_id,
        status: 'withdrawn',
        scope: { kind: 'supervised-trial', members },
      },
      endpoint = '/api/pilot/curriculum/' + CONTRACT.lesson + '/publications',
      before = await runtime.namedControl('/inspect', { kind: 'counts' });
    await runtime.namedControl('/fault-final', {
      operation: 'publication',
      enabled: true,
    });
    try {
      assert.equal(
        (await runtime.request(operator, 'POST', endpoint, body)).status,
        503,
      );
      assert.deepEqual(
        await runtime.namedControl('/inspect', { kind: 'counts' }),
        before,
      );
    } finally {
      await runtime.namedControl('/fault-final', {
        operation: 'publication',
        enabled: false,
      });
    }
    const competing = {
        ...body,
        requestId: 'qa-withdraw-race-' + randomUUID(),
      },
      results = await Promise.all([
        runtime.request(operator, 'POST', endpoint, body),
        runtime.request(operator, 'POST', endpoint, competing),
      ]);
    assert.deepEqual(
      results.map((r) => r.status).sort((a, b) => a - b),
      [200, 409],
    );
    const winner = results[0].status === 200 ? body : competing;
    assert.equal(
      (await runtime.request(operator, 'POST', endpoint, winner)).status,
      200,
    );
    assert.equal(
      (
        await runtime.request(operator, 'POST', endpoint, {
          ...winner,
          status: 'rejected',
        })
      ).status,
      409,
    );
    const view = await runtime.readRunThroughHTTP(parent, runId);
    assert.equal(view.available, false);
    const denied = await runtime.request(
      child,
      'POST',
      '/api/pilot/curriculum/learning-runs/' + runId + '/actions',
      {
        eventId: randomUUID(),
        expectedRevision: view.revision,
        stepId: view.state.stepId,
        type: 'continue',
        payload: {},
      },
    );
    assert.equal(denied.status, 409);
    const proposal = await runtime.request(
      parent,
      'POST',
      '/api/pilot/children/' + child.id + '/placement/proposals',
      { lessonVersion: CONTRACT.lesson },
    );
    assert.equal(proposal.status, 409);
    return {
      raceStatuses: results.map((r) => r.status),
      withdrawnHistory: view.runId,
      actionDenied: denied.status,
    };
  });
  await test('P04-populated-35-table-backup', async () => {
    const counts = await runtime.namedControl('/inspect', { kind: 'counts' });
    assert.equal(Object.keys(counts.counts).length, 14);
    for (const [table, count] of Object.entries(counts.counts))
      assert(count > 0, `New table not populated through actual API: ${table}`);
    const result = await runtime.namedControl('/backup', { name: 'populated' });
    return {
      newTableCounts: counts.counts,
      backup: result,
      scope:
        'All14new tables populated; all35 exported. Existing unrelated legacy tables may be empty.',
    };
  });
  for (const fault of ['checksum-corrupt', 'final-write', 'uncertain', 'none'])
    await test('P05-restore-' + fault, async () => {
      const r = await runtime.namedControl('/restore', {
        name: 'populated',
        fault,
      });
      assert(r.readback);
      assert.deepEqual(
        Object.keys(r.readback.counts).sort(),
        [...V4_TABLES].sort(),
      );
      assert.notEqual(r.readback.installationId, h.evidenceInstallationId);
      assert.equal(r.readback.sessionCount, 0);
      assert.equal(r.readback.verificationCount, 0);
      if (fault === 'checksum-corrupt' || fault === 'final-write') {
        assert.equal(
          r.status,
          fault === 'checksum-corrupt' ? 'REFUSED' : 'NOT_COMMITTED',
        );
        if (fault === 'checksum-corrupt')
          assert.equal(r.error, 'BACKUP_CHECKSUM_INVALID');
        for (const table of V4_TABLES.slice(21))
          assert.equal(r.readback.counts[table], 0);
      } else {
        assert(r.baseURL);
        assert(runId, 'Actual source history run required');
        const history = await runtime.request(
          parent,
          'GET',
          `/api/pilot/curriculum/learning-runs/${runId}`,
          undefined,
          { base: r.baseURL },
        );
        assert.equal(history.status, 200);
        assert.equal(history.body.available, false);
        const denied = await runtime.request(
          child,
          'POST',
          `/api/pilot/curriculum/learning-runs/${runId}/actions`,
          {
            eventId: randomUUID(),
            expectedRevision: history.body.revision,
            stepId: history.body.state.stepId,
            type: 'continue',
            payload: {},
          },
          { base: r.baseURL },
        );
        assert([403, 409].includes(denied.status));
        const library = await runtime.request(
          parent,
          'GET',
          `/api/pilot/children/${child.id}/library`,
          undefined,
          { base: r.baseURL },
        );
        assert.equal(library.status, 200);
        assert(library.body.items.every((i) => !i.available));
      }
      return { fault, result: r };
    });
  await runtime.verifyFrozenIdentity();
} catch (error) {
  report.cases.push({
    id: 'postproof-preflight',
    outcome: 'BLOCKED',
    message: error.message,
    evidenceRefs: [],
  });
} finally {
  await runtime?.cleanupOwnedContexts();
  report.finishedAt = Date.now();
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
process.exitCode = report.cases.every((c) => c.outcome === 'PASS') ? 0 : 1;
