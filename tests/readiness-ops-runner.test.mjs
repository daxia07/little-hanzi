import test from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../scripts/readiness-node-runner.mjs';
import * as opsRunner from '../scripts/readiness-ops-node-runner.mjs';
const { validateOpsControl } = opsRunner;

test('[R4-E-001] owned app explicitly admits its separate local ops binding and scopes fault clocks', () => {
  assert.equal(typeof opsRunner.opsCandidateBindings, 'function');
  const input = {
    name: 'app',
    binding: 'available',
    databaseURL: 'http://127.0.0.1:1234',
    scope: { environment: 'synthetic' },
    clock: 1000,
    testFault: 'feedback-final-write',
  };
  const value = opsRunner.opsCandidateBindings(input);
  assert.equal(value.HANZI_OPS_ALLOW_LOCAL_DATABASE, '1');
  assert.equal(value.HANZI_OPS_TEST_NOW, '1000');
  assert.equal(value.HANZI_OPS_TEST_FAULT, 'feedback-final-write');
  const ordinary = opsRunner.opsCandidateBindings({
    ...input,
    name: 'ordinary',
  });
  assert.equal(ordinary.HANZI_OPS_TEST_NOW, '');
  assert.equal(ordinary.HANZI_OPS_TEST_FAULT, '');
  assert.equal(
    opsRunner.opsCandidateBindings({ ...input, binding: 'missing' })
      .HANZI_OPS_DATABASE_URL,
    '',
  );
});

test('[R4-E-015] frozen R4 runner phase has its own identities and preserves R2/R3', () => {
  assert.equal(typeof runner.readinessPhase, 'function');
  assert.deepEqual(runner.readinessPhase('r4'), {
    specVersion: 'r4-spec-2',
    integrationVersion: 'r4-integration-1',
    lessonVersion: 'forest-01-v4',
  });
  assert.equal(runner.readinessPhase('r2').lessonVersion, 'forest-01-v3');
  assert.equal(runner.readinessPhase('r3').specVersion, 'r3-spec-2');
  assert.throws(() => runner.readinessPhase('arbitrary'));
});

test('[R4-E-004][R4-E-015] candidate operations controls reject arbitrary side effects and success claims', () => {
  for (const [route, body] of [
    ['/dispatch', { kind: 'backup', success: true }],
    ['/dispatch', { kind: 'backup', sourceURL: 'https://production' }],
    ['/dispatch', { kind: 'reconcile' }],
    ['/inspect', { kind: 'sql', sql: 'DELETE FROM ops_job' }],
    ['/archive-readback', { jobId: '../private' }],
    ['/restart', { service: 'production' }],
    ['/fault', { stage: 'auth', mode: 'unavailable' }],
    ['/clock', { at: 1, token: 'extra' }],
    ['/restore', { jobId: 'job', fault: 'none', destination: '/private/live' }],
    ['/rollback', { target: '/some/build' }],
  ])
    assert.throws(() => validateOpsControl(route, body));
  for (const [route, body] of [
    ['/dispatch', { kind: 'backup' }],
    ['/dispatch', { kind: 'reconcile', subjectJobId: 'job-1' }],
    ['/inspect', { kind: 'record', id: 'feedback-1' }],
    ['/binding', { state: 'missing' }],
    ['/restart', { service: 'all' }],
    ['/restore', { jobId: 'job-1', fault: 'operations-ack-lost' }],
    ['/rollback', { target: 'retained' }],
  ])
    assert.equal(validateOpsControl(route, body), true);
});
