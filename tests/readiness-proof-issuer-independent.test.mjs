/** Independent pure proof identity guards; no service calls or fabricated execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { storyProfile } from '../scripts/readiness-story-profiles.mjs';
import {
  proofProfileBinding,
  buildStoryProofReceipt,
} from '../scripts/readiness-proof-issuer.mjs';

test('[R3-P-003] final receipt formatter uses verified identity rather than conflicting detail aliases', () => {
  const identity = {
    candidateId: 'unit-only',
    sourceDigest: 'sha256:' + 'a'.repeat(64),
    artifactDigest: 'sha256:' + 'b'.repeat(64),
    buildId: 'build',
    lessonVersion: 'forest-01-v4',
    contentDigest: 'sha256:' + 'c'.repeat(64),
    evidenceInstallationId: 'owned-evidence',
    targetInstallationId: 'owned-distinct-target',
    namespace: 'formatting-only',
  };
  const receipt = buildStoryProofReceipt(identity, {
    receiptId: 'unit',
    issuerId: 'unit',
    issuedAt: 1,
    scenarios: [],
    reportDigest: 'sha256:' + 'd'.repeat(64),
    targetInstallationId: 'foreign',
    evidenceInstallationId: 'foreign',
    contentDigest: 'foreign',
  });
  for (const [field, value] of Object.entries(identity))
    assert.equal(receipt[field], value);
  assert.equal(Object.hasOwn(receipt, 'signature'), false);
  assert.equal(
    buildStoryProofReceipt(
      { ...identity, targetInstallationId: identity.evidenceInstallationId },
      {
        receiptId: 'unit',
        issuerId: 'unit',
        issuedAt: 1,
        scenarios: [],
        reportDigest: 'unit',
      },
    ).targetInstallationId,
    identity.evidenceInstallationId,
  );
});

test('[R3-P-001] fixed profile records cannot be mutated or selected by prototype/alternate paths', () => {
  const positive = storyProfile('positive-publication');
  assert(Object.isFrozen(positive));
  assert.throws(() => {
    positive.packagePath = '../arbitrary';
  }, TypeError);
  assert.equal(
    storyProfile('positive-publication').packagePath,
    'tests/fixtures/curriculum/forest-01-v4-positive-publication.json',
  );
  for (const name of [
    '__proto__',
    'constructor',
    'toString',
    'family-story/',
    'positive-publication\0',
    '',
    null,
  ])
    assert.throws(() => storyProfile(name));
});

test('[R3-P-003] symlinked/missing target ownership, misleading origins and foreign private keys refuse', () => {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-independent-proof-')),
  );
  const privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const candidateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const issuer = (key, purpose) => ({
    issuerId: purpose,
    publicKeyJwk: crypto.createPublicKey(key).export({ format: 'jwk' }),
    notBefore: 1,
    revokedAt: null,
    purpose,
  });
  try {
    const targetState = path.join(work, 'target');
    fs.mkdirSync(targetState, { mode: 0o700 });
    const input = {
      manifest: { work },
      profile: 'positive-publication',
      installationId: 'evidence',
      targetInstallationId: 'target',
      issuerId: 'release',
      privateKey,
      handoff: {
        profile: 'positive-publication',
        packagePath: storyProfile('positive-publication').packagePath,
        evidenceInstallationId: 'evidence',
        targetInstallationId: 'target',
        baseURL: 'http://127.0.0.1:44101',
        ordinaryBaseURL: 'http://127.0.0.1:44102',
        targetBaseURL: 'http://127.0.0.1:44103',
        state: path.join(work, 'evidence'),
        targetState,
        publicIssuer: issuer(candidateKey, 'candidate'),
        targetIssuer: issuer(privateKey, 'release'),
      },
    };
    assert.equal(proofProfileBinding(input).name, 'positive-publication');
    const linked = path.join(work, 'linked-target');
    fs.symlinkSync(targetState, linked);
    for (const patch of [
      { targetState: linked },
      { targetState: path.join(work, 'missing') },
      { targetState: work },
      { targetBaseURL: 'http://localhost:44103' },
      { targetBaseURL: 'http://127.0.0.1:44103/path' },
      { targetBaseURL: 'http://127.0.0.1:44103?key=secret' },
      { targetBaseURL: 'http://user:password@127.0.0.1:44103' },
      { targetBaseURL: input.handoff.ordinaryBaseURL },
      { profile: undefined },
      { packagePath: undefined },
    ])
      assert.throws(
        () =>
          proofProfileBinding({
            ...input,
            handoff: { ...input.handoff, ...patch },
          }),
        /PROOF_EXECUTION_INVALID/,
      );
    assert.throws(
      () => proofProfileBinding({ ...input, privateKey: candidateKey }),
      /PROOF_EXECUTION_INVALID/,
    );
    const original = {
      ...input,
      profile: 'family-story',
      targetInstallationId: 'evidence',
      issuerId: 'candidate',
      privateKey: candidateKey,
      handoff: {
        ...input.handoff,
        evidenceInstallationId: 'evidence',
        targetInstallationId: 'evidence',
        profile: undefined,
        packagePath: undefined,
      },
    };
    assert.equal(
      proofProfileBinding(original).name,
      'family-story',
      'existing default handoff without profile metadata stays compatible',
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
