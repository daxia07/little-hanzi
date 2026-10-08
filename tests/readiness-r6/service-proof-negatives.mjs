/** Only authentic executed-coordinator receipts; mutations never create a proof. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
const canonical = (value) =>
  value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? '[' + value.map(canonical).join(',') + ']'
      : '{' +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
          .join(',') +
        '}';
export async function runProofNegatives(http, binding, execute, evidence) {
  const h = http.handoff,
    operator = h.accounts.find((a) => a.role === 'operator').id;
  const root = fs.realpathSync(h.output),
    filename = path.join(root, 'issued-receipts.json');
  assert.equal(root, h.output);
  const stat = fs.lstatSync(filename);
  assert(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o777) === 0o600,
  );
  assert(stat.size > 0 && stat.size <= 32 * 1024 * 1024);
  assert.equal(fs.realpathSync(filename), filename);
  const bytes = fs.readFileSync(filename),
    issued = JSON.parse(bytes);
  assert.equal(issued.schemaVersion, 'r6-issued-proofs-1');
  assert.equal(issued.candidateId, h.candidateId);
  assert.equal(issued.corpusVersion, h.corpusVersion);
  assert.equal(issued.corpusDigest, h.corpusDigest);
  assert.equal(issued.receipts.length, binding.items.length);
  const publicKey = createPublicKey({
    key: h.publicIssuer.publicKeyJwk,
    format: 'jwk',
  });
  for (let i = 0; i < binding.items.length; i++) {
    const entry = issued.receipts[i],
      item = binding.items[i];
    for (const key of [
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'buildId',
      'corpusVersion',
      'corpusDigest',
      'runnerManifestDigest',
    ])
      assert.equal(entry.receipt[key], h[key]);
    assert.equal(entry.receipt.lessonVersion, item.lessonVersion);
    assert.equal(entry.receipt.contentDigest, item.contentDigest);
    assert.equal(entry.receipt.evidenceInstallationId, h.installationId);
    assert.equal(entry.receipt.targetInstallationId, h.installationId);
    assert.equal(entry.receipt.namespace, h.namespace);
    assert.equal(entry.receipt.issuerId, h.publicIssuer.issuerId);
    assert.equal(entry.receipt.syntheticOnly, true);
    assert(
      verify(
        null,
        Buffer.from(canonical(entry.receipt)),
        publicKey,
        Buffer.from(entry.signature, 'base64url'),
      ),
      'Actual issued receipt signature failed independent verification',
    );
  }
  evidence('actual-issued-receipts-binding', {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    receiptCount: issued.receipts.length,
    lessonVersions: binding.items.map((x) => x.lessonVersion),
    signaturesIndependentlyVerified: true,
  });
  const route =
    '/api/pilot/corpora/' + encodeURIComponent(h.corpusVersion) + '/proofs';
  await execute('C09-actual-proof-ingestion-replay', async () => {
    const before = await http.inspect({ kind: 'counts' }),
      first = issued.receipts[0];
    const saved = await http.request(operator, 'POST', route, first);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.receiptId, first.receipt.receiptId);
    assert.equal(saved.body.lessonVersion, first.receipt.lessonVersion);
    assert.equal(saved.body.contentDigest, first.receipt.contentDigest);
    const after = await http.inspect({ kind: 'counts' });
    assert.equal(
      after.counts.pilot_corpus_proof_receipt,
      before.counts.pilot_corpus_proof_receipt + 1,
    );
    assert.equal(after.evidenceEpoch, before.evidenceEpoch + 1);
    const replay = await http.request(operator, 'POST', route, first);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, saved.body);
    assert.deepEqual(await http.inspect({ kind: 'counts' }), after);
    const changed = structuredClone(first);
    changed.signature =
      (changed.signature[0] === 'A' ? 'B' : 'A') + changed.signature.slice(1);
    const conflict = await http.request(operator, 'POST', route, changed);
    assert.equal(conflict.status, 409);
    assert.equal(
      conflict.body.error?.code ?? conflict.body.code,
      'PROOF_CONFLICT',
    );
    assert.deepEqual(await http.inspect({ kind: 'counts' }), after);
    return {
      receiptId: saved.body.receiptId,
      createdRows: 1,
      epochAdvancedOnce: true,
      exactReplay: true,
      sameIdChangedSignatureConflict: true,
    };
  });
  await execute('C09-signature-and-binding-refusals', async () => {
    const before = await http.inspect({ kind: 'counts' }),
      results = [];
    for (const field of [
      'candidateId',
      'sourceDigest',
      'artifactDigest',
      'targetInstallationId',
      'namespace',
      'issuerId',
    ]) {
      const changed = structuredClone(issued.receipts[0]);
      changed.receipt.receiptId = 'qa-tamper-' + randomUUID();
      changed.receipt[field] = field.endsWith('Digest')
        ? 'sha256:' + '0'.repeat(64)
        : 'qa-wrong-' + field;
      const r = await http.request(operator, 'POST', route, changed);
      assert.equal(r.status, 409);
      assert.equal(r.body.error?.code ?? r.body.code, 'PROOF_UNTRUSTED');
      results.push({
        field,
        status: r.status,
        code: r.body.error?.code ?? r.body.code,
      });
    }
    const unknown = await http.request(
      operator,
      'POST',
      '/api/pilot/corpora/qa-unknown-corpus-v1/proofs',
      issued.receipts[0],
    );
    assert.equal(unknown.status, 404);
    assert.deepEqual(await http.inspect({ kind: 'counts' }), before);
    return {
      results,
      unknownCorpusStatus: unknown.status,
      zeroEffects: true,
      limitation:
        'Fresh receipt IDs deliberately leave signatures invalid. These prove actual tamper refusal, not isolated validly signed identity/issuer-window eligibility. Live issuer mutation remains unavailable.',
    };
  });
  await execute('C09-ordinary-negative-valid-receipt-denial', async () => {
    const before = await http.control('/inspect', {
      kind: 'counts',
      target: 'ordinary-negative',
    });
    assert.equal(before.status, 200);
    const r = await http.request(
      operator,
      'POST',
      route,
      issued.receipts[0],
      h.ordinaryNegativeBaseURL,
    );
    assert.equal(r.status, 409);
    assert.equal(r.body.error?.code ?? r.body.code, 'PROOF_UNTRUSTED');
    const after = await http.control('/inspect', {
      kind: 'counts',
      target: 'ordinary-negative',
    });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, before.body);
    return {
      status: r.status,
      code: r.body.error?.code ?? r.body.code,
      negativeTargetInstall: before.body.installationId,
      zeroEffects: true,
      candidatePurposeCannotOrdinaryRelease: true,
    };
  });
}
