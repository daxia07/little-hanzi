import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFeedback,
  parseTriage,
  parseObservation,
  parseCorrection,
  jobSlot,
  OpsError,
} from '../lib/pilot/ops-domain.ts';
const now = Date.parse('2026-09-27T00:01:42Z');
const observation = {
  kind: 'synthetic',
  participantLabel: 'QA child',
  candidateId: 'candidate',
  lessonVersion: 'forest-01-v4',
  contentDigest: 'sha256:' + 'a'.repeat(64),
  observedAt: now,
  device: 'QA desktop',
  browser: 'Chrome',
  parentAgreementRef: 'SIMULATED agreement only',
  tasks: ['Story'],
  completion: 'ended',
  savedRecapRef: null,
  adultHelp: '',
  interruptions: '',
  observedBehavior: '',
  observerInterpretation: '',
  laterRecall: { status: 'not-run' },
};
test('R4-E010 feedback closedbody bounds and Unicode are validated without coercion', () => {
  assert.deepEqual(
    parseFeedback({
      requestId: 'f1',
      runId: 'run1',
      category: 'sound',
      observed: '木'.repeat(1000),
      expected: '',
    }),
    {
      requestId: 'f1',
      runId: 'run1',
      category: 'sound',
      observed: '木'.repeat(1000),
      expected: '',
    },
  );
  for (const change of [
    { observed: '木'.repeat(1001) },
    { expected: [] },
    { category: 'freeform' },
    { installationId: 'forged' },
    { requestId: 'bad space' },
  ])
    assert.throws(
      () =>
        parseFeedback({
          requestId: 'f1',
          runId: 'run1',
          category: 'sound',
          observed: 'Sound stopped',
          expected: '',
          ...change,
        }),
      OpsError,
    );
});
test('R4-E011 ended observation without confirmedrecap remains recordable; laterdate cannotprecedeinitial', () => {
  assert.deepEqual(parseObservation({ requestId: 'o1', observation }, now), {
    requestId: 'o1',
    observation,
  });
  assert.throws(
    () =>
      parseObservation(
        {
          requestId: 'o1',
          observation: {
            ...observation,
            laterRecall: {
              status: 'observed',
              observedAt: now - 1,
              evidenceRef: 'QAref',
              adultHelp: '',
              observation: '',
            },
          },
        },
        now,
      ),
    OpsError,
  );
  assert.throws(
    () =>
      parseObservation(
        {
          requestId: 'o1',
          observation: { ...observation, tasks: ['x'.repeat(121)] },
        },
        now,
      ),
    OpsError,
  );
});
test('R4-E003/010 resolution requires disposition/retest and boundedknownACrefs', () => {
  const body = {
    requestId: 't1',
    expectedRevision: 1,
    severity: 'normal',
    ownerRef: null,
    status: 'resolved',
    acIds: ['R4-E-010'],
    disposition: 'Retested',
    retestRef: 'synthetic/retest',
    nextReviewAt: null,
  };
  assert.deepEqual(parseTriage(body), body);
  for (const change of [
    { retestRef: null },
    { disposition: '' },
    { acIds: ['invented'] },
    { nextReviewAt: -1 },
    { expectedRevision: 1.5 },
  ])
    assert.throws(() => parseTriage({ ...body, ...change }), OpsError);
});
test('R4-E011 correction exactshape andreason are validated without evaluating getters', () => {
  assert.equal(
    parseCorrection(
      {
        requestId: 'c1',
        expectedRevision: 1,
        observation,
        correctionReason: 'Attribution correction',
      },
      now,
    ).expectedRevision,
    1,
  );
  let reads = 0;
  const value = { requestId: 'x' };
  Object.defineProperty(value, 'observation', {
    enumerable: true,
    get() {
      reads++;
      return observation;
    },
  });
  assert.throws(() => parseObservation(value, now), OpsError);
  assert.equal(reads, 0);
});
test('R4-E004 canonical daily/minute slots use latestboundary, including before02UTC', () => {
  assert.equal(jobSlot('backup', now), '2026-09-26T02:00:00.000Z');
  assert.equal(jobSlot('retention', now), '2026-09-26T02:00:00.000Z');
  assert.equal(jobSlot('monitor', now), '2026-09-27T00:01:00.000Z');
});
