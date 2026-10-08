import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inspectExecutedCollectionReport,
  COLLECTION_PROOF_SCENARIOS,
  buildCollectionProofReceipt,
} from '../scripts/readiness-collection-proof-issuer.mjs';
test('[R5-P-002] issuer requires executed cases, exact binding and owned evidence, never an asserted PASS alone', () => {
  const output = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-proof-unit-'),
  );
  try {
    fs.writeFileSync(
      path.join(output, 'case.json'),
      JSON.stringify({ actual: 'synthetic validator fixture' }),
    );
    const identity = {
      candidateId: 'test',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      buildId: 'build',
      lessonVersion: 'path-01-v1',
      contentDigest: `sha256:${'c'.repeat(64)}`,
      evidenceInstallationId: 'evidence',
      targetInstallationId: 'target',
      namespace: 'test-only',
    };
    const context = {
      identity,
      output,
      startedAt: 1000,
      finishedAt: 2000,
      testSourceHashes: { 'tests/readiness-r5/run.mjs': 'a'.repeat(64) },
      exitCode: 0,
    };
    const report = {
      schemaVersion: 'r5-executed-report-1',
      ...identity,
      startedAt: 1000,
      finishedAt: 2000,
      testSourceHashes: context.testSourceHashes,
      scenarios: COLLECTION_PROOF_SCENARIOS.map((id) => ({
        id,
        outcome: 'PASS',
        caseIds: ['case'],
        evidenceFiles: ['case.json'],
      })),
      cases: [{ id: 'case', outcome: 'PASS', evidenceRefs: ['case.json'] }],
    };
    assert.equal(inspectExecutedCollectionReport(report, context).length, 13);
    for (const change of [
      (value) => {
        value.lessonVersion = 'path-02-v1';
      },
      (value) => {
        value.scenarios = value.scenarios.filter((s) => s.id !== 'review-7d');
      },
      (value) => {
        value.candidateId = 'another';
      },
      (value) => {
        value.scenarios[0].outcome = 'BLOCKED';
      },
      (value) => {
        value.cases[0].outcome = 'FAIL';
      },
      (value) => {
        value.scenarios[0].caseIds = ['unexecuted'];
      },
      (value) => {
        value.scenarios[0].evidenceFiles = ['../outside.json'];
      },
      (value) => {
        value.scenarios.push({ ...value.scenarios[0] });
      },
      (value) => {
        value.testSourceHashes = {};
      },
      (value) => {
        value.startedAt = 1;
      },
    ]) {
      const copy = structuredClone(report);
      change(copy);
      assert.throws(
        () => inspectExecutedCollectionReport(copy, context),
        /PROOF_EXECUTION_INVALID/,
      );
    }
    assert.throws(
      () =>
        inspectExecutedCollectionReport(report, { ...context, exitCode: 1 }),
      /PROOF_EXECUTION_INVALID/,
    );
    fs.symlinkSync(
      path.join(output, 'case.json'),
      path.join(output, 'alias.json'),
    );
    const linked = structuredClone(report);
    linked.scenarios[0].evidenceFiles = ['alias.json'];
    assert.throws(
      () => inspectExecutedCollectionReport(linked, context),
      /PROOF_EXECUTION_INVALID/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
test('[R5-P-002] collection receipt retains exact paired identity and both separate review proofs without granting human consent', () => {
  const identity = {
    lessonVersion: 'path-03-v1',
    contentDigest: 'sha256:' + 'c'.repeat(64),
    evidenceInstallationId: 'evidence',
    targetInstallationId: 'different-target',
  };
  const receipt = buildCollectionProofReceipt(identity, {
    scenarios: COLLECTION_PROOF_SCENARIOS.map((id) => ({
      id,
      outcome: 'PASS',
      evidenceDigest: 'sha256:' + 'd'.repeat(64),
    })),
  });
  assert.equal(receipt.adapterId, 'paired-story');
  assert.equal(receipt.adapterVersion, 'paired-story-v1');
  assert.equal(receipt.lessonVersion, 'path-03-v1');
  assert.equal(receipt.targetInstallationId, 'different-target');
  assert.equal(receipt.syntheticOnly, true);
  assert.equal(receipt.scenarios.length, 13);
  assert(!Object.hasOwn(receipt, 'signature'));
});
