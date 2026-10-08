import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as issuerModule from '../scripts/readiness-proof-issuer.mjs';
import {
  inspectExecutedStoryReport,
  PROOF_SCENARIOS,
} from '../scripts/readiness-proof-issuer.mjs';

test('[R3-P-003] receipt bytes retain the verified ordinary target, separately from evidence installation', () => {
  const identity = {
    candidateId: 'synthetic-receipt-format-test',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    buildId: 'synthetic-build',
    lessonVersion: 'forest-01-v4',
    contentDigest: `sha256:${'c'.repeat(64)}`,
    evidenceInstallationId: 'synthetic-evidence',
    targetInstallationId: 'synthetic-ordinary-target',
    namespace: 'format-test-only-no-execution-claim',
  };
  const receipt = issuerModule.buildStoryProofReceipt(identity, {
    receiptId: 'synthetic-format-only',
    issuerId: 'synthetic-unit-issuer',
    issuedAt: 1000,
    scenarios: PROOF_SCENARIOS.map((id) => ({
      id,
      outcome: 'PASS',
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
    })),
    reportDigest: `sha256:${'e'.repeat(64)}`,
  });
  // A pure formatting fixture has no signature, file output or trusted authority.
  const bytes = JSON.parse(JSON.stringify(receipt));
  assert.equal(bytes.targetInstallationId, 'synthetic-ordinary-target');
  assert.equal(bytes.evidenceInstallationId, 'synthetic-evidence');
  for (const [key, value] of Object.entries(identity))
    assert.equal(bytes[key], value);
  assert.equal(bytes.syntheticOnly, true);
  assert.equal(Object.hasOwn(bytes, 'signature'), false);
});

test('[R3-P-001/003] positive proof binds a fixed fixture, separate owned target and its release key', () => {
  assert.equal(typeof issuerModule.proofProfileBinding, 'function');
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-proof-profile-'),
  );
  const candidateKeys = crypto.generateKeyPairSync('ed25519');
  const releaseKeys = crypto.generateKeyPairSync('ed25519');
  const issuer = (keys, purpose) => ({
    issuerId: `synthetic-${purpose}-issuer`,
    publicKeyJwk: keys.publicKey.export({ format: 'jwk' }),
    notBefore: 1,
    revokedAt: null,
    purpose,
  });
  try {
    const targetState = path.join(work, 'ordinary-target');
    fs.mkdirSync(targetState, { mode: 0o700 });
    const base = {
      manifest: { work },
      profile: 'positive-publication',
      installationId: 'evidence-installation',
      targetInstallationId: 'ordinary-installation',
      issuerId: 'synthetic-release-issuer',
      privateKey: releaseKeys.privateKey,
      handoff: {
        profile: 'positive-publication',
        packagePath:
          'tests/fixtures/curriculum/forest-01-v4-positive-publication.json',
        evidenceInstallationId: 'evidence-installation',
        targetInstallationId: 'ordinary-installation',
        baseURL: 'http://127.0.0.1:43101',
        ordinaryBaseURL: 'http://127.0.0.1:43102',
        targetBaseURL: 'http://127.0.0.1:43103',
        targetState,
        state: path.join(work, 'evidence-state'),
        publicIssuer: issuer(candidateKeys, 'candidate'),
        targetIssuer: issuer(releaseKeys, 'release'),
      },
    };
    const call = (value) => issuerModule.proofProfileBinding(value);
    assert.equal(call(base).packagePath, base.handoff.packagePath);
    for (const mutate of [
      (v) => {
        v.profile = '../arbitrary';
      },
      (v) => {
        v.handoff.profile = 'family-story';
      },
      (v) => {
        v.handoff.packagePath = 'content/curriculum/forest-01-v4.json';
      },
      (v) => {
        v.handoff.targetInstallationId = 'foreign-installation';
      },
      (v) => {
        v.targetInstallationId = v.installationId;
        v.handoff.targetInstallationId = v.installationId;
      },
      (v) => {
        v.handoff.targetBaseURL = 'https://example.invalid';
      },
      (v) => {
        v.handoff.targetBaseURL = v.handoff.baseURL;
      },
      (v) => {
        v.handoff.targetState = path.dirname(work);
      },
      (v) => {
        v.handoff.targetIssuer.purpose = 'candidate';
      },
      (v) => {
        v.issuerId = 'another-issuer';
      },
      (v) => {
        v.privateKey = candidateKeys.privateKey;
      },
      (v) => {
        v.handoff.targetIssuer.publicKeyJwk.d = 'never-public';
      },
    ]) {
      const copy = {
        ...base,
        handoff: structuredClone(base.handoff),
      };
      mutate(copy);
      assert.throws(() => call(copy), /PROOF_EXECUTION_INVALID/);
    }
    const ordinaryDefault = {
      ...base,
      profile: 'family-story',
      targetInstallationId: base.installationId,
      issuerId: 'synthetic-candidate-issuer',
      privateKey: candidateKeys.privateKey,
      handoff: {
        ...base.handoff,
        profile: 'family-story',
        packagePath: 'content/curriculum/forest-01-v4.json',
        targetInstallationId: base.installationId,
      },
    };
    assert.equal(
      call(ordinaryDefault).packagePath,
      'content/curriculum/forest-01-v4.json',
    );
    assert.throws(
      () => call({ ...ordinaryDefault, targetInstallationId: 'different' }),
      /PROOF_EXECUTION_INVALID/,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[R3-E-003] issuer requires executed cases, exact binding and owned evidence, never an asserted PASS alone', () => {
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
      lessonVersion: 'forest-01-v4',
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
      testSourceHashes: { 'tests/readiness-r3/run.mjs': 'a'.repeat(64) },
      exitCode: 0,
    };
    const report = {
      schemaVersion: 'r3-executed-report-1',
      ...identity,
      startedAt: 1000,
      finishedAt: 2000,
      testSourceHashes: context.testSourceHashes,
      scenarios: PROOF_SCENARIOS.map((id) => ({
        id,
        outcome: 'PASS',
        caseIds: ['case'],
        evidenceFiles: ['case.json'],
      })),
      cases: [{ id: 'case', outcome: 'PASS', evidenceRefs: ['case.json'] }],
    };
    assert.equal(inspectExecutedStoryReport(report, context).length, 12);
    for (const change of [
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
        () => inspectExecutedStoryReport(copy, context),
        /PROOF_EXECUTION_INVALID/,
      );
    }
    assert.throws(
      () => inspectExecutedStoryReport(report, { ...context, exitCode: 1 }),
      /PROOF_EXECUTION_INVALID/,
    );
    fs.symlinkSync(
      path.join(output, 'case.json'),
      path.join(output, 'alias.json'),
    );
    const linked = structuredClone(report);
    linked.scenarios[0].evidenceFiles = ['alias.json'];
    assert.throws(
      () => inspectExecutedStoryReport(linked, context),
      /PROOF_EXECUTION_INVALID/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
