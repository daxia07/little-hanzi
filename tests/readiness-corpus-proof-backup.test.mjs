import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import {
  mixedCorpusRegistryArchive,
  ownedCorpusArchiveSource,
  corpusDigest,
} from './helpers/corpus-archive-fixture.mjs';
import * as archive from '../scripts/pilot-corpus-backup.mjs';

const owned = ownedCorpusArchiveSource();
after(owned.close);
const pair = await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
]);
const issuer = {
  issuerId: 'synthetic-proof-archive',
  publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  purpose: 'release',
  notBefore: 1,
  revokedAt: null,
};
const now = Date.parse('2026-09-27T00:00:00.000Z');
const d = 'sha256:' + 'a'.repeat(64);
const memberChecks = [
  'profile-source-assets',
  'familiarity-routes',
  'recognition-context',
  'delayed-replay',
  'safe-projection',
];
const familyChecks = [
  'selection',
  'approval',
  'recognition',
  'help',
  'audio-unavailable',
  'restart',
  'duplicate-conflict',
  'review-24h',
  'review-7d',
  'progress-export',
  'recovery',
  'ownership',
  'browser-family',
];
async function fixture({ verification = false } = {}) {
  const payload = mixedCorpusRegistryArchive(owned.source);
  const pkg = payload.tables.pilot_curriculum_package.at(-1);
  const member = {
    lessonVersion: pkg.lesson_version,
    contentDigest: pkg.content_digest,
  };
  const manifest = {
    schemaVersion: 'r6-corpus-1',
    corpusId: 'synthetic-proof-corpus',
    corpusVersion: 'synthetic-proof-corpus-v1',
    canonicalizationVersion: 's3-json-1',
    policyVersion: 'r6-corpus-policy-1',
    items: [
      {
        ...member,
        batchId: 'synthetic-unpopulated-batch',
        trackId: 'synthetic-track',
        sequence: 1,
      },
    ],
  };
  const corpus = {
    corpus_version: manifest.corpusVersion,
    corpus_id: manifest.corpusId,
    corpus_digest: corpusDigest(manifest),
    manifest_json: canonicalPackage(manifest),
    policy_version: manifest.policyVersion,
    imported_by: 'synthetic-union-operator',
    imported_at: 0,
  };
  payload.tables.pilot_corpus = [corpus];
  // Domain-isolated receipt fixture, not a full populated archive or executed renderer proof.
  const receipt = {
    schemaVersion: 'r6-proof-receipt-1',
    policyVersion: 'r6-corpus-proof-1',
    receiptId: 'synthetic-history-proof',
    issuerId: issuer.issuerId,
    issuedAt: new Date(now).toISOString(),
    candidateId: 'synthetic-history-candidate',
    sourceDigest: d,
    artifactDigest: d,
    buildId: 'synthetic-history-build',
    corpusVersion: corpus.corpus_version,
    corpusDigest: corpus.corpus_digest,
    ...member,
    canonicalizationVersion: 's3-json-1',
    adapterId: 'corpus-paired',
    adapterVersion: 'corpus-paired-v1',
    profileVersion: 'r6-paired-profile-1',
    evidenceInstallationId: verification
      ? payload.sourceInstallationId
      : 'synthetic-evidence-origin',
    targetInstallationId: payload.sourceInstallationId,
    namespace: 'synthetic-proof-origin',
    syntheticOnly: true,
    runnerManifestDigest: d,
    memberReportDigest: d,
    memberChecks: memberChecks.map((id) => ({
      id,
      outcome: 'PASS',
      evidenceDigest: d,
    })),
    familyEvidence: {
      reportDigest: d,
      representatives: [member],
      scenarios: familyChecks.map((id) => ({
        ...member,
        id,
        outcome: 'PASS',
        evidenceDigest: d,
      })),
    },
  };
  const row = {
    id: receipt.receiptId,
    corpus_version: receipt.corpusVersion,
    corpus_digest: receipt.corpusDigest,
    lesson_version: receipt.lessonVersion,
    content_digest: receipt.contentDigest,
    issuer_id: receipt.issuerId,
    receipt_version: receipt.schemaVersion,
    receipt_json: canonicalPackage(receipt),
    receipt_digest: corpusDigest(receipt),
    signature: '',
    issued_at: now,
    received_by: 'synthetic-union-operator',
    received_at: now + 10,
    installation_id: receipt.targetInstallationId,
    namespace: receipt.namespace,
    test_run_id: verification ? receipt.namespace : null,
  };
  row.signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      pair.privateKey,
      new TextEncoder().encode(row.receipt_json),
    ),
  ).toString('base64url');
  payload.tables.pilot_corpus_proof_receipt = [row];
  return payload;
}
async function verify(input, keys = [issuer]) {
  const payload = archive.validateCorpusRows(input, owned.source);
  if (process.env.CORPUS_PROOF_ARCHIVE_BASELINE === 'structural')
    return payload;
  const { validateCorpusProofFacts } =
    await import('../scripts/pilot-corpus-proof-backup.mjs');
  return validateCorpusProofFacts(payload, keys);
}
test('[R6-E-004/013] historical signed origin stays attributed after later issuer revocation', async () => {
  const p = await fixture();
  await verify(p);
  await verify(p, [{ ...issuer, revokedAt: now + 20 }]);
  assert.equal(
    JSON.parse(p.tables.pilot_corpus_proof_receipt[0].receipt_json)
      .evidenceInstallationId,
    'synthetic-evidence-origin',
  );
});
test('[R6-E-004/013] row/body/digest/signature and received-at issuer window must all agree', async () => {
  for (const mutation of [
    (r) => {
      r.installation_id = 'other-target';
    },
    (r) => {
      r.namespace = 'other-origin';
    },
    (r) => {
      r.issued_at++;
    },
    (r) => {
      r.received_by = 'unknown-actor';
    },
    (r) => {
      r.receipt_digest = d;
    },
    (r) => {
      r.signature = 'A'.repeat(86);
    },
    (r) => {
      const v = JSON.parse(r.receipt_json);
      v.evidenceInstallationId = 'changed-origin';
      r.receipt_json = canonicalPackage(v);
      r.receipt_digest = corpusDigest(v);
    },
  ]) {
    const p = await fixture();
    mutation(p.tables.pilot_corpus_proof_receipt[0]);
    await assert.rejects(() => verify(p));
  }
  await assert.rejects(() => verify(awaited, []));
});
const awaited = await fixture();
test('[R6-E-004/005/013] historical acceptance before revocation and verification scope remain exact', async () => {
  await assert.rejects(() =>
    verify(awaited, [{ ...issuer, revokedAt: now + 5 }]),
  );
  await assert.rejects(() =>
    verify(awaited, [{ ...issuer, purpose: 'candidate' }]),
  );
  const scoped = await fixture({ verification: true });
  await verify(scoped, [{ ...issuer, purpose: 'candidate' }]);
  const wrongNamespace = structuredClone(scoped);
  wrongNamespace.tables.pilot_corpus_proof_receipt[0].test_run_id =
    'foreign-namespace';
  await assert.rejects(() =>
    verify(wrongNamespace, [{ ...issuer, purpose: 'candidate' }]),
  );
  const wrongOrigin = await fixture();
  wrongOrigin.tables.pilot_corpus_proof_receipt[0].test_run_id =
    'synthetic-proof-origin';
  await assert.rejects(() =>
    verify(wrongOrigin, [{ ...issuer, purpose: 'candidate' }]),
  );
});
