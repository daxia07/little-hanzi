// Independent normal-gate positive fixture cases; real adapter wiring is frozen separately.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ANSWERS, CONTRACT, V4_TABLES, DAY_MS } from './oracle.mjs';
import { canonical, receiptNegativeCases } from './receipt-cases.mjs';
import { createHTTPCases } from './http-suite.mjs';
export const FIXTURE_PATH =
  'tests/fixtures/curriculum/forest-01-v4-positive-publication.json';
export const POSITIVE_ADAPTER_REQUIREMENTS = Object.freeze([
  'handoff',
  'fixture',
  'intended',
  'operator',
  'parent',
  'child',
  'scope',
  'request',
  'control',
  'normalAdapter',
  'signedReceipt',
  'evidenceRequest',
]);
const digest = (v) =>
  'sha256:' +
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
export function createPositiveCases(h) {
  for (const field of POSITIVE_ADAPTER_REQUIREMENTS)
    assert(h[field], `Missing real positive adapter ${field}`);
  const version = CONTRACT.lesson,
    endpoint = '/api/pilot/curriculum/' + version,
    proofEndpoint = '/api/pilot/curriculum/proofs';
  let reviewId, ownerId, publication, completedRun;
  const counts = () =>
    h.control('/inspect', { target: 'ordinary', kind: 'counts' });
  const publications = () =>
    h.control('/inspect', { target: 'ordinary', kind: 'publication' });
  const publicationBody = (head, status = 'released') => ({
    requestId: 'qa-positive-' + randomUUID(),
    expectedRevision: Number(head?.generation || 0),
    predecessorId: head?.id || null,
    contentDigest: h.handoff.contentDigest,
    reviewId,
    proofId: h.signedReceipt.receipt.receiptId,
    ownerDecisionId: ownerId,
    status,
    scope: h.scope,
  });
  const reviewBody = (previous, decision) => ({
    requestId: 'qa-simulated-' + randomUUID(),
    contentDigest: h.handoff.contentDigest,
    previousReviewId: previous,
    decision,
    reviewerRef: 'simulated-qa-review-not-human',
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
      ].map((k) => [k, decision === 'approved']),
    ),
    evidenceRef: 'synthetic:positive-publication-contract-only',
    reason: 'Simulated QA input; no actual Mandarin/content/owner acceptance.',
  });
  async function release() {
    const head = (await publications()).publications.at(-1),
      body = publicationBody(head),
      r = await h.request(h.operator, 'POST', endpoint + '/publications', body);
    assert.equal(r.status, 200);
    const after = await publications();
    publication = after.publications.at(-1);
    assert.equal(publication.status, 'released');
    assert.equal(publication.scope_kind, 'supervised-trial');
    assert.equal(publication.test_run_id, null);
    for (const key of ['review_id', 'proof_id', 'owner_decision_id'])
      assert(publication[key]);
    return { body, ack: r.body };
  }
  return [
    {
      id: 'P001-fixed-profile-identity',
      ears: ['R3-P-001', 'R3-P-003'],
      run: async () => {
        assert.equal(h.handoff.profile, 'positive-publication');
        assert.equal(h.handoff.packagePath, FIXTURE_PATH);
        assert.notEqual(
          h.handoff.evidenceInstallationId,
          h.handoff.targetInstallationId,
        );
        assert.equal(digest(h.fixture), h.handoff.contentDigest);
        assert.notEqual(digest(h.fixture), digest(h.intended));
        for (const key of [
          'steps',
          'questions',
          'learningPanels',
          'build',
          'find',
          'reader',
          'rules',
          'delayed',
        ])
          assert.deepEqual(h.fixture.story[key], h.intended.story[key]);
        for (const q of h.fixture.story.questions)
          assert.equal(q.correctChoiceId, ANSWERS[q.id]);
        for (const key of ['kind', 'voices', 'fallback'])
          assert.deepEqual(
            h.fixture.story.playback[key],
            h.intended.story.playback[key],
          );
        assert.deepEqual(
          h.fixture.story.playback.cues.map(
            ({ source: _, license: __, ...cue }) => cue,
          ),
          h.intended.story.playback.cues.map(
            ({ source: _, license: __, ...cue }) => cue,
          ),
        );
        const evidence = await h.control('/inspect', { kind: 'installation' }),
          target = await h.control('/inspect', {
            target: 'ordinary',
            kind: 'installation',
          });
        assert.equal(evidence.installationId, h.handoff.evidenceInstallationId);
        assert.equal(target.installationId, h.handoff.targetInstallationId);
        return {
          evidenceInstallationId: evidence.installationId,
          targetInstallationId: target.installationId,
          fixtureDigest: h.handoff.contentDigest,
          simulated: true,
        };
      },
    },
    {
      id: 'P002-ordinary-bootstrap-denial',
      ears: ['R3-P-002'],
      run: async () => {
        const before = await counts(),
          results = [];
        for (const [route, fixture] of [
          ['/api/test/pilot/story-bootstrap', 'family-story'],
          ['/api/test/pilot/story-positive-bootstrap', 'positive-publication'],
        ]) {
          const r = await h.request(h.operator, 'POST', route, { fixture });
          assert.equal(r.status, 404);
          results.push({ route, status: r.status });
        }
        assert.deepEqual(await counts(), before);
        const route = '/api/test/pilot/story-positive-bootstrap';
        for (const probe of [
          {
            actor: h.operator,
            body: { fixture: 'positive-publication' },
            token: false,
            status: 403,
          },
          {
            actor: h.child,
            body: { fixture: 'positive-publication' },
            token: true,
            status: 403,
          },
          {
            actor: h.operator,
            body: { fixture: 'unknown' },
            token: true,
            status: 400,
          },
          {
            actor: h.operator,
            body: { fixture: 'positive-publication', extra: true },
            token: true,
            status: 400,
          },
        ]) {
          const r = await h.evidenceRequest(
            probe.actor,
            'POST',
            route,
            probe.body,
            { privateToken: probe.token },
          );
          assert.equal(r.status, probe.status);
          results.push({
            guard: 'evidence',
            actor: probe.actor.label,
            tokenPresent: probe.token,
            status: r.status,
          });
        }
        return { results };
      },
    },
    {
      id: 'P003-normal-prerequisite-chain',
      ears: ['R3-P-003', 'R3-P-004'],
      run: async () => {
        const imported = await h.request(
          h.operator,
          'POST',
          '/api/pilot/curriculum',
          { package: h.fixture },
        );
        assert.equal(imported.status, 201);
        assert.equal(imported.body.contentDigest, h.handoff.contentDigest);
        const detail = await h.request(h.operator, 'GET', endpoint);
        assert.equal(detail.status, 200);
        const review = await h.request(
          h.operator,
          'POST',
          endpoint + '/reviews',
          reviewBody(detail.body.reviews.at(-1)?.reviewId || null, 'approved'),
        );
        assert.equal(review.status, 201);
        reviewId = review.body.reviewId;
        const receipt = h.signedReceipt.receipt;
        assert.equal(
          receipt.targetInstallationId,
          h.handoff.targetInstallationId,
        );
        assert.equal(
          receipt.evidenceInstallationId,
          h.handoff.evidenceInstallationId,
        );
        assert.equal(receipt.syntheticOnly, true);
        assert.equal(receipt.contentDigest, h.handoff.contentDigest);
        const proof = await h.request(
          h.operator,
          'POST',
          proofEndpoint,
          h.signedReceipt,
        );
        assert.equal(proof.status, 200);
        assert.equal(proof.body.eligible, true);
        assert.equal(
          (await h.request(h.operator, 'POST', proofEndpoint, h.signedReceipt))
            .status,
          200,
        );
        const mutationResults = [],
          beforeMutations = await counts();
        for (const mutation of receiptNegativeCases(receipt, Date.now()).filter(
          (v) => !v.trustMutation,
        )) {
          const payload = {
            receipt: {
              ...(mutation.receipt || {
                ...receipt,
                reportDigest: 'sha256:' + '0'.repeat(64),
              }),
              receiptId: 'qa-positive-negative-' + randomUUID(),
            },
            signature: mutation.signature || h.signedReceipt.signature,
          };
          const refused = await h.request(
            h.operator,
            'POST',
            proofEndpoint,
            payload,
          );
          assert.equal(refused.status, 409, mutation.id);
          assert(
            [
              'PROOF_INVALID',
              'PROOF_UNTRUSTED',
              'PROOF_IDENTITY_MISMATCH',
            ].includes(refused.body.error?.code),
            mutation.id,
          );
          mutationResults.push({
            id: mutation.id,
            status: refused.status,
            code: refused.body.error.code,
          });
        }
        assert.deepEqual(await counts(), beforeMutations);
        const conflict = await h.request(h.operator, 'POST', proofEndpoint, {
          ...h.signedReceipt,
          receipt: { ...receipt, reportDigest: 'sha256:' + '0'.repeat(64) },
        });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.error.code, 'EVENT_CONFLICT');
        const owner = await h.request(
          h.operator,
          'POST',
          endpoint + '/decisions',
          {
            requestId: 'qa-simulated-owner-' + randomUUID(),
            contentDigest: h.handoff.contentDigest,
            candidateId: h.handoff.candidateId,
            artifactDigest: h.handoff.artifactDigest,
            targetInstallationId: h.handoff.targetInstallationId,
            scope: h.scope,
            ownerIdentity: 'simulated-qa-owner-not-real-owner',
            decision: 'accepted',
            decidedAt: Date.now(),
            evidenceRef: 'synthetic:simulated-owner-contract-input',
          },
        );
        assert.equal(owner.status, 200);
        ownerId = owner.body.decisionId;
        return {
          reviewId,
          ownerId,
          receiptId: receipt.receiptId,
          simulatedDecisions: true,
          mutationResults,
          mutationScope:
            'Fresh IDs with unchanged signature test tamper/shape refusal; live target issuer states separately test actual authority.',
        };
      },
    },
    {
      id: 'P004-positive-final-fault-cas-replay',
      ears: ['R3-P-004', 'R3-P-005'],
      run: async () => {
        assert(reviewId && ownerId);
        const before = await counts(),
          head = (await publications()).publications.at(-1),
          body = publicationBody(head);
        await h.control('/fault-final', {
          target: 'ordinary',
          operation: 'publication',
          enabled: true,
        });
        try {
          assert.equal(
            (
              await h.request(
                h.operator,
                'POST',
                endpoint + '/publications',
                body,
              )
            ).status,
            503,
          );
          assert.deepEqual(await counts(), before);
        } finally {
          await h.control('/fault-final', {
            target: 'ordinary',
            operation: 'publication',
            enabled: false,
          });
        }
        const competing = {
            ...body,
            requestId: 'qa-positive-race-' + randomUUID(),
          },
          r = await Promise.all([
            h.request(h.operator, 'POST', endpoint + '/publications', body),
            h.request(
              h.operator,
              'POST',
              endpoint + '/publications',
              competing,
            ),
          ]);
        assert.deepEqual(
          r.map((x) => x.status).sort((a, b) => a - b),
          [200, 409],
        );
        const winner = r[0].status === 200 ? body : competing,
          ack = r.find((x) => x.status === 200).body;
        assert.deepEqual(
          (
            await h.request(
              h.operator,
              'POST',
              endpoint + '/publications',
              winner,
            )
          ).body,
          ack,
        );
        assert.equal(
          (
            await h.request(h.operator, 'POST', endpoint + '/publications', {
              ...winner,
              status: 'withdrawn',
            })
          ).status,
          409,
        );
        const p = await publications();
        assert.equal(p.publications.length, 1);
        publication = p.publications[0];
        assert.equal(publication.scope_kind, 'supervised-trial');
        assert.equal(publication.test_run_id, null);
        assert.equal(publication.review_id, reviewId);
        assert.equal(publication.proof_id, h.signedReceipt.receipt.receiptId);
        assert.equal(publication.owner_decision_id, ownerId);
        assert.equal(
          (
            await h.request(h.operator, 'POST', endpoint + '/publications', {
              ...competing,
              requestId: 'qa-stale-' + randomUUID(),
            })
          ).status,
          409,
        );
        const library = await h.request(
          h.parent,
          'GET',
          `/api/pilot/children/${h.child.id}/library`,
        );
        assert.equal(library.status, 200);
        assert(
          library.body.items.some(
            (i) => i.available && i.contentDigest === h.handoff.contentDigest,
          ),
        );
        return {
          publicationId: publication.id,
          generation: publication.generation,
          raceStatuses: r.map((x) => x.status),
          nonBootstrap: true,
        };
      },
    },
    ...createHTTPCases(h.normalAdapter)
      .filter((c) => c.id.startsWith('I11'))
      .map((c) => ({
        id: 'P005-' + c.id,
        ears: ['R3-P-004'],
        run: async () => {
          await c.run();
          const f = await h.normalAdapter.latestCompletedFixture();
          const view = await h.normalAdapter.readRunThroughHTTP(
            f.child,
            f.runId,
          );
          assert.equal(view.state.soundReview, 'reviewed');
          assert.equal(
            Date.parse(view.reviewAvailableAt) -
              Date.parse(view.state.completedAt),
            DAY_MS,
          );
          completedRun = view.runId;
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
          const progress = await h.request(
            f.parent,
            'GET',
            `/api/pilot/children/${f.child.id}/progress`,
          );
          const exported = await h.request(
            f.parent,
            'GET',
            `/api/pilot/children/${f.child.id}/export`,
          );
          assert.equal(progress.status, 200);
          assert.equal(exported.status, 200);
          for (const endpoint of ['progress', 'export'])
            assert.equal(
              (
                await h.request(
                  f.otherParent,
                  'GET',
                  `/api/pilot/children/${f.child.id}/${endpoint}`,
                )
              ).status,
              404,
            );
          assert.equal(
            progress.body.curriculum.installationId,
            h.handoff.targetInstallationId,
          );
          assert.equal(progress.body.curriculum.childId, f.child.id);
          assert.deepEqual(
            stable(exported.body.curriculum),
            stable(progress.body.curriculum),
          );
          const saved = progress.body.curriculum.runs.find(
            (r) => r.runId === view.runId,
          );
          assert(saved);
          assert.equal(saved.installationId, h.handoff.targetInstallationId);
          assert.equal(saved.contentDigest, h.handoff.contentDigest);
          assert.equal(saved.lessonVersion, version);
          assert.deepEqual(stable(saved), stable(view));
          assert(
            !JSON.stringify(progress.body.curriculum).includes(
              'correctChoiceId',
            ),
            'Authoritative answer keys absent from parent projection',
          );
          return {
            runId: view.runId,
            soundReview: view.state.soundReview,
            reviewDue: view.reviewAvailableAt,
            clockOverride: false,
            parentProgress: progress.body.curriculum,
            parentExport: exported.body.curriculum,
          };
        },
      })),
    {
      id: 'P006-live-trust-and-review-authority',
      ears: ['R3-P-006'],
      run: async () => {
        assert(completedRun);
        const results = [];
        for (const state of [
          'revoked',
          'future-not-before',
          'candidate-purpose',
        ]) {
          await h.control('/target-issuer', { state: 'active' });
          if ((await publications()).publications.at(-1).status !== 'released')
            await release();
          const f = await h.normalAdapter.familyFixture(
              'positive-trust-' + state,
            ),
            view = await h.normalAdapter.readRunThroughHTTP(f.child, f.runId);
          const approvedBefore = (
            await h.control('/inspect', {
              target: 'ordinary',
              kind: 'plan',
              childId: f.child.id,
            })
          ).plans.at(-1);
          assert(approvedBefore);
          const savedSetup = await h.request(
            f.parent,
            'PUT',
            `/api/pilot/children/${f.child.id}/onboarding`,
            {
              nickname: 'QA pending ' + state,
              experience: 'new',
              audioReady: true,
            },
          );
          assert.equal(savedSetup.status, 200);
          const pending = await h.request(
            f.parent,
            'POST',
            `/api/pilot/children/${f.child.id}/placement/proposals`,
            { lessonVersion: version },
          );
          assert.equal(pending.status, 200);
          assert.notEqual(
            pending.body.proposal.proposalId,
            approvedBefore.proposal_id,
            'Require genuinely new unapproved proposal, not idempotent approval replay',
          );
          const placement = await h.request(
            f.parent,
            'GET',
            `/api/pilot/children/${f.child.id}/placement`,
          );
          assert.equal(placement.status, 200);
          assert.equal(
            placement.body.proposal.proposalId,
            pending.body.proposal.proposalId,
          );
          assert.equal(
            (
              await h.control('/inspect', {
                target: 'ordinary',
                kind: 'plan',
                childId: f.child.id,
              })
            ).plans.at(-1).id,
            approvedBefore.id,
          );
          await h.control('/target-issuer', { state });
          const beforeDenied = await counts();
          const deniedApproval = await h.request(
            f.parent,
            'POST',
            `/api/pilot/children/${f.child.id}/placement/approve`,
            {
              proposalId: pending.body.proposal.proposalId,
              sourceDigest: pending.body.proposal.sourceDigest,
            },
          );
          assert.equal(deniedApproval.status, 409);
          assert.deepEqual(await counts(), beforeDenied);
          const oldApproval = await h.request(
            f.parent,
            'POST',
            `/api/pilot/children/${f.child.id}/placement/approve`,
            {
              proposalId: approvedBefore.proposal_id,
              sourceDigest: approvedBefore.source_digest,
            },
          );
          assert.equal(
            oldApproval.status,
            200,
            'Exact prior approval remains idempotent after invalidation',
          );
          assert.equal(oldApproval.body.plan.planId, approvedBefore.id);
          assert.deepEqual(await counts(), beforeDenied);
          const history = await h.request(
            f.child,
            'GET',
            `/api/pilot/curriculum/learning-runs/${f.runId}`,
          );
          assert.equal(history.status, 200);
          assert.equal(history.body.available, false);
          assert.equal(
            (
              await h.request(
                f.parent,
                'POST',
                `/api/pilot/children/${f.child.id}/placement/proposals`,
                { lessonVersion: version },
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await h.request(
                f.child,
                'POST',
                `/api/pilot/curriculum/assignments/${f.assignmentId}/start`,
                { requestId: randomUUID() },
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await h.request(
                f.child,
                'POST',
                `/api/pilot/curriculum/learning-runs/${f.runId}/actions`,
                {
                  eventId: randomUUID(),
                  expectedRevision: view.revision,
                  stepId: view.state.stepId,
                  type: 'continue',
                  payload: {},
                },
              )
            ).status,
            409,
          );
          const sameProof = await h.request(
            h.operator,
            'POST',
            proofEndpoint,
            h.signedReceipt,
          );
          assert.equal(sameProof.status, 200);
          assert.equal(sameProof.body.eligible, false);
          const head = (await publications()).publications.at(-1),
            withdraw = publicationBody(head, 'withdrawn');
          assert.equal(
            (
              await h.request(
                h.operator,
                'POST',
                endpoint + '/publications',
                withdraw,
              )
            ).status,
            200,
          );
          results.push({
            state,
            history: true,
            newWritesDenied: true,
            withdrawal: true,
          });
        }
        await h.control('/target-issuer', { state: 'active' });
        await release();
        const reject = await h.request(
          h.operator,
          'POST',
          endpoint + '/reviews',
          reviewBody(reviewId, 'rejected'),
        );
        assert.equal(reject.status, 201);
        assert.equal(
          (
            await h.request(
              h.parent,
              'POST',
              `/api/pilot/children/${h.child.id}/placement/proposals`,
              { lessonVersion: version },
            )
          ).status,
          409,
        );
        const historical = await h.request(
          h.parent,
          'GET',
          `/api/pilot/curriculum/learning-runs/${completedRun}`,
        );
        assert.equal(historical.status, 200);
        assert.equal(historical.body.available, false);
        return {
          results,
          rejectedReview: reject.body.reviewId,
          simulated: true,
        };
      },
    },
    {
      id: 'P007-positive-chain-35-table-recovery',
      ears: ['R3-P-007'],
      run: async () => {
        const populated = await counts();
        assert.equal(Object.keys(populated.counts).length, 14);
        for (const [table, count] of Object.entries(populated.counts))
          assert(count > 0, table + ' must be populated through valid APIs');
        const backup = await h.control('/backup', {
            target: 'ordinary',
            name: 'populated',
          }),
          results = [];
        for (const fault of [
          'checksum-corrupt',
          'final-write',
          'uncertain',
          'none',
        ]) {
          const r = await h.control('/restore', {
            target: 'ordinary',
            name: 'populated',
            fault,
          });
          assert.deepEqual(
            Object.keys(r.readback.counts).sort(),
            [...V4_TABLES].sort(),
          );
          assert.notEqual(
            r.readback.installationId,
            h.handoff.targetInstallationId,
          );
          assert.equal(r.readback.sessionCount, 0);
          assert.equal(r.readback.verificationCount, 0);
          if (['checksum-corrupt', 'final-write'].includes(fault)) {
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
            const history = await h.request(
              h.parent,
              'GET',
              `/api/pilot/curriculum/learning-runs/${completedRun}`,
              undefined,
              { base: r.baseURL },
            );
            assert.equal(history.status, 200);
            assert.equal(history.body.available, false);
            const denied = await h.request(
              h.child,
              'POST',
              `/api/pilot/curriculum/learning-runs/${completedRun}/actions`,
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
          }
          results.push({ fault, readback: r.readback, status: r.status });
        }
        return {
          populated: populated.counts,
          backup,
          results,
          simulatedPositiveChain: true,
        };
      },
    },
    {
      id: 'P008-human-gates-remain-pending',
      ears: ['R3-P-008'],
      run: async () => ({
        fixturePath: FIXTURE_PATH,
        simulated: true,
        actualOwnerAcceptance: 'NOT RUN',
        actualMandarinContentReview: 'NOT RUN',
        physicalDevice: 'NOT RUN',
        hostedRecovery: 'NOT RUN',
        productionWrites: false,
      }),
    },
  ];
}

// Fixed executable entry point. The caller supplies only owned handoff, genuine
// issued receipt and a fresh output location; no adapter or PASS input is accepted.
async function executePositive() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { createRuntimeAdapter } = await import('./runtime-adapter.mjs');
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    assert(['--handoff', '--receipt', '--output'].includes(key));
    assert(!Object.hasOwn(flags, key) && process.argv[i + 1]);
    flags[key] = process.argv[i + 1];
  }
  assert(Object.keys(flags).length === 3);
  const hp = await fs.realpath(flags['--handoff']);
  assert.equal((await fs.stat(hp)).mode & 0o077, 0);
  const h = JSON.parse(await fs.readFile(hp, 'utf8'));
  assert.equal(h.profile, 'positive-publication');
  for (const base of [h.baseURL, h.targetBaseURL, h.controlURL]) {
    const u = new URL(base);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, '127.0.0.1');
    assert(u.port);
  }
  assert.notEqual(h.baseURL, h.targetBaseURL);
  const output = path.resolve(flags['--output']);
  const manifest = JSON.parse(await fs.readFile(h.manifest, 'utf8'));
  assert(output.startsWith((await fs.realpath(manifest.work)) + path.sep));
  assert.equal(await fs.realpath(path.dirname(output)), path.dirname(output));
  await fs.mkdir(output, { recursive: false, mode: 0o700 });
  const privateData = JSON.parse(await fs.readFile(h.credentialsFile, 'utf8'));
  const account = (label) => {
    const a = privateData.accounts.find((v) => v.label === label);
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
  const signedReceipt = JSON.parse(
    await fs.readFile(flags['--receipt'], 'utf8'),
  );
  assert(signedReceipt.receipt && typeof signedReceipt.signature === 'string');
  const fixture = JSON.parse(
    await fs.readFile(path.join(h.snapshot, FIXTURE_PATH), 'utf8'),
  );
  const intended = JSON.parse(
    await fs.readFile(
      path.join(h.snapshot, 'content/curriculum/forest-01-v4.json'),
      'utf8',
    ),
  );
  const instances = new Map(),
    restoreInstallations = new Map();
  let original, lastFixture;
  async function runtime(base = h.targetBaseURL) {
    if (!instances.has(base)) {
      // Archived run DTOs retain their source installation identity; the
      // independently read destination installation must be fresh and distinct.
      if (base !== h.targetBaseURL) {
        assert(
          restoreInstallations.has(base),
          'Actual restore installation readback is required',
        );
        assert.notEqual(restoreInstallations.get(base), h.targetInstallationId);
      }
      const installationId = h.targetInstallationId;
      instances.set(
        base,
        await createRuntimeAdapter({
          handoff: {
            ...h,
            baseURL: base,
            evidenceInstallationId: installationId,
          },
          output,
        }),
      );
    }
    return instances.get(base);
  }
  async function control(endpoint, body) {
    assert(
      [
        '/inspect',
        '/fault-final',
        '/backup',
        '/restore',
        '/target-issuer',
      ].includes(endpoint),
    );
    const r = await fetch(new URL(endpoint, h.controlURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hanzi-Test-Token': privateData.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        ['/backup', '/restore'].includes(endpoint) ? 100000 : 60000,
      ),
    });
    assert.equal(r.status, 200, 'Named positive control ' + endpoint);
    const value = await r.json();
    if (endpoint === '/restore' && value.baseURL)
      restoreInstallations.set(value.baseURL, value.readback.installationId);
    return value;
  }
  const request = async (actor, method, endpoint, body, options = {}) =>
    (await runtime(options.base)).request(
      actor,
      method,
      endpoint,
      body,
      options,
    );
  const normalAdapter = {
    request,
    familyFixture: async (label) => {
      lastFixture = await (await runtime()).familyFixture(label);
      return lastFixture;
    },
    latestCompletedFixture: async () => {
      assert(lastFixture);
      return lastFixture;
    },
    readRunThroughHTTP: async (actor, id) => {
      const r = await request(
        actor,
        'GET',
        '/api/pilot/curriculum/learning-runs/' + id,
      );
      assert.equal(r.status, 200);
      return r.body;
    },
    inspectRun: (runId) =>
      control('/inspect', { target: 'ordinary', kind: 'run', runId }),
  };
  const report = {
    schemaVersion: 'r3-positive-publication-report-1',
    candidateId: h.candidateId,
    sourceDigest: h.sourceDigest,
    artifactDigest: h.artifactDigest,
    contentDigest: h.contentDigest,
    evidenceInstallationId: h.evidenceInstallationId,
    targetInstallationId: h.targetInstallationId,
    startedAt: Date.now(),
    cases: [],
    limitations: [
      'Simulated review and owner facts are not human acceptance.',
      'Ordinary target has no test clock or capability.',
    ],
  };
  try {
    original = await createRuntimeAdapter({ handoff: h, output });
    await original.verifyFrozenIdentity();
    for (const c of createPositiveCases({
      handoff: h,
      fixture,
      intended,
      operator,
      parent,
      child,
      scope,
      signedReceipt,
      request,
      control,
      normalAdapter,
      evidenceRequest: (...args) => original.request(...args),
    })) {
      let outcome = 'PASS',
        detail;
      try {
        detail = await c.run();
      } catch (error) {
        outcome = error.code === 'QA_BLOCKED' ? 'BLOCKED' : 'FAIL';
        detail = { message: error.message };
      }
      const file = c.id + '.json';
      await fs.writeFile(
        path.join(output, file),
        JSON.stringify({ id: c.id, outcome, detail }, null, 2) + '\n',
        { flag: 'wx' },
      );
      report.cases.push({
        id: c.id,
        outcome,
        ears: c.ears,
        evidenceRefs: [file],
      });
      if (outcome !== 'PASS') break; // No cascading positive facts after prerequisite failure.
    }
    await original.verifyFrozenIdentity();
  } finally {
    for (const r of instances.values()) await r.cleanupOwnedContexts();
    await original?.cleanupOwnedContexts();
    report.finishedAt = Date.now();
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx' },
    );
  }
  process.exitCode =
    report.cases.length === 12 &&
    report.cases.every((c) => c.outcome === 'PASS')
      ? 0
      : 1;
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await executePositive();
