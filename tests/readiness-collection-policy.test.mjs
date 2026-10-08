import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validCollectionReceipt,
  verifyCollectionProof,
  parseCollectionCapability,
  REQUIRED_SCENARIOS,
} from '../lib/pilot/collection-policy.ts';
import { validReceipt as validV4 } from '../lib/pilot/story-policy.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
const digest = 'sha256:' + 'a'.repeat(64),
  now = 1790467200000;
function receipt() {
  return {
    schemaVersion: 'r3-proof-receipt-1',
    receiptId: 'receipt-r5-unit',
    issuerId: 'issuer-r5-unit',
    issuedAt: now,
    candidateId: 'r5-candidate',
    sourceDigest: digest,
    artifactDigest: digest,
    buildId: 'r5-build',
    lessonVersion: 'path-01-v1',
    contentDigest: digest,
    canonicalizationVersion: 's3-json-1',
    adapterId: 'paired-story',
    adapterVersion: 'paired-story-v1',
    evidenceInstallationId: 'evidence-unit',
    targetInstallationId: 'target-unit',
    namespace: 'r5-unit',
    syntheticOnly: true,
    scenarios: REQUIRED_SCENARIOS.map((id) => ({
      id,
      outcome: 'PASS',
      evidenceDigest: digest,
    })),
    reportDigest: digest,
  };
}
test('R5-E002 strict paired receipt rejects V4, unknown path versions and incomplete scenario claims', () => {
  assert.equal(validCollectionReceipt(receipt()), true);
  assert.equal(validV4(receipt()), false);
  assert.equal(
    validCollectionReceipt({
      ...receipt(),
      lessonVersion: 'unrelated-version',
    }),
    false,
  );
  assert.equal(
    validCollectionReceipt({
      ...receipt(),
      adapterId: 'forest-story',
      adapterVersion: 'forest-story-v1',
      lessonVersion: 'forest-01-v4',
    }),
    false,
  );
  assert.equal(
    validCollectionReceipt({
      ...receipt(),
      scenarios: receipt().scenarios.slice(1),
    }),
    false,
  );
  assert.equal(
    validCollectionReceipt({ ...receipt(), syntheticOnly: false }),
    false,
  );
});
test('R5-E002 capability IDs are slugs and parsing never invokes getters or accepts duplicate personas', () => {
  const cap = {
    installationId: 'install-unit',
    collectionVersion: 'little-hanzi-path-1-v1',
    collectionDigest: digest,
    namespace: 'r5-unit',
    childIds: ['child-a'],
    parentIds: ['parent-a'],
  };
  assert.equal(
    canonicalPackage(parseCollectionCapability(cap)),
    canonicalPackage(cap),
  );
  assert.equal(
    parseCollectionCapability({ ...cap, collectionVersion: 'bad collection' }),
    null,
  );
  assert.equal(
    parseCollectionCapability({ ...cap, childIds: ['child-a', 'child-a'] }),
    null,
  );
  let count = 0;
  const hostile = { ...cap };
  Object.defineProperty(hostile, 'collectionVersion', {
    enumerable: true,
    get() {
      count++;
      return cap.collectionVersion;
    },
  });
  assert.equal(parseCollectionCapability(hostile), null);
  assert.equal(count, 0);
});
test('R5-E002 signed proof exact target/version and current vs historical revoked issuer remain separate', async () => {
  const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]),
    publicKeyJwk = await crypto.subtle.exportKey('jwk', key.publicKey),
    r = receipt(),
    bytes = await crypto.subtle.sign(
      'Ed25519',
      key.privateKey,
      new TextEncoder().encode(canonicalPackage(r)),
    ),
    signature = Buffer.from(bytes).toString('base64url'),
    issuer = {
      issuerId: r.issuerId,
      publicKeyJwk,
      notBefore: now - 1,
      revokedAt: null,
      purpose: 'release',
    },
    trust = {
      candidateId: r.candidateId,
      sourceDigest: digest,
      artifactDigest: digest,
      buildId: r.buildId,
      issuers: [issuer],
      archiveIssuers: [{ ...issuer, revokedAt: now + 1 }],
    },
    expected = {
      installationId: 'target-unit',
      contentDigest: digest,
      lessonVersion: 'path-01-v1',
    };
  assert.equal(
    (await verifyCollectionProof(r, signature, trust, expected, now)).receipt
      .lessonVersion,
    'path-01-v1',
  );
  await assert.rejects(
    verifyCollectionProof(
      r,
      signature,
      trust,
      { ...expected, lessonVersion: 'path-02-v1' },
      now,
    ),
    (x) => x.code === 'PROOF_IDENTITY_MISMATCH',
  );
  trust.issuers = [{ ...issuer, revokedAt: now + 1 }];
  await assert.rejects(
    verifyCollectionProof(r, signature, trust, expected, now),
    (x) => x.code === 'PROOF_UNTRUSTED',
  );
  assert.equal(
    (await verifyCollectionProof(r, signature, trust, expected, now + 2, true))
      .receipt.lessonVersion,
    'path-01-v1',
  );
  trust.archiveIssuers = [{ ...issuer, revokedAt: now - 1 }];
  await assert.rejects(
    verifyCollectionProof(r, signature, trust, expected, now + 2, true),
    (x) => x.code === 'PROOF_UNTRUSTED',
  );
});
