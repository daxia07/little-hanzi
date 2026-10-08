/** Synthetic direct-store policy checks; these signatures are never execution proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  withdrawOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';
import { ingestCorpusProof } from '../lib/pilot/corpus-proof-store.ts';
import {
  CORPUS_MEMBER_CHECKS,
  CORPUS_FAMILY_SCENARIOS,
  corpusRepresentatives,
} from '../lib/pilot/corpus-proof.ts';
import { canonicalPackage } from '../lib/curriculum/digest.ts';

const digest = 'sha256:' + 'a'.repeat(64);
async function policyFixture(f) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]),
    issuer = {
      issuerId: 'synthetic-witness-policy-test',
      publicKeyJwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
      notBefore: 0,
      revokedAt: null,
      purpose: 'candidate',
    },
    trust = {
      ...f.config.curriculumTrust,
      issuers: [issuer],
      archiveIssuers: [issuer],
    },
    c = { ...f.context(), config: { ...f.config, curriculumTrust: trust } },
    members = f.manifest.items.map(({ lessonVersion, contentDigest }) => ({
      lessonVersion,
      contentDigest,
    })),
    representatives = corpusRepresentatives(members);
  async function signed(id, changes = {}) {
    const receipt = {
      schemaVersion: 'r6-proof-receipt-1',
      policyVersion: 'r6-corpus-proof-1',
      receiptId: id,
      issuerId: issuer.issuerId,
      issuedAt: new Date().toISOString(),
      candidateId: trust.candidateId,
      sourceDigest: trust.sourceDigest,
      artifactDigest: trust.artifactDigest,
      buildId: trust.buildId,
      corpusVersion: f.manifest.corpusVersion,
      corpusDigest: c.corpus.capability.corpusDigest,
      ...members[0],
      canonicalizationVersion: 's3-json-1',
      adapterId: 'corpus-paired',
      adapterVersion: 'corpus-paired-v1',
      profileVersion: 'r6-paired-profile-1',
      evidenceInstallationId: f.installationId,
      targetInstallationId: f.installationId,
      namespace: f.namespace,
      syntheticOnly: true,
      runnerManifestDigest: digest,
      memberReportDigest: digest,
      memberChecks: CORPUS_MEMBER_CHECKS.map((id) => ({
        id,
        outcome: 'PASS',
        evidenceDigest: digest,
      })),
      familyEvidence: {
        reportDigest: digest,
        representatives,
        scenarios: representatives.flatMap((m) =>
          CORPUS_FAMILY_SCENARIOS.map((id) => ({
            ...m,
            id,
            outcome: 'PASS',
            evidenceDigest: digest,
          })),
        ),
      },
      ...changes,
    };
    const signature = Buffer.from(
      await crypto.subtle.sign(
        'Ed25519',
        keys.privateKey,
        new TextEncoder().encode(canonicalPackage(receipt)),
      ),
    ).toString('base64url');
    return { receipt, signature };
  }
  return { c, signed, issuer, trust, version: f.manifest.corpusVersion };
}
async function facts(f) {
  return JSON.parse(
    JSON.stringify(
      (
        await f.client.execute(
          'SELECT (SELECT count(*) FROM pilot_corpus_proof_receipt) AS proofs,revision AS epoch FROM pilot_corpus_evidence_epoch WHERE id=1',
        )
      ).rows[0],
    ),
  );
}

test('R6-E-004/005 persisted owned bootstrap permits candidate proof, exact replay and a second proof after epoch advances', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const p = await policyFixture(f),
      body = await p.signed('witness-first');
    await assert.rejects(
      ingestCorpusProof(p.c, p.version, body),
      /CAPABILITY_DENIED/,
    );
    assert.equal((await facts(f)).proofs, 0);
    await bootstrapOwnedCorpus(f.handle);
    const before = await facts(f),
      ack = await ingestCorpusProof(p.c, p.version, body);
    assert.equal(ack.receiptId, body.receipt.receiptId);
    const after = await facts(f);
    assert.equal(after.proofs, before.proofs + 1);
    assert.equal(after.epoch, before.epoch + 1);
    assert.deepEqual(await ingestCorpusProof(p.c, p.version, body), ack);
    assert.deepEqual(await facts(f), after);
    await ingestCorpusProof(p.c, p.version, await p.signed('witness-second'));
    assert.deepEqual(await facts(f), { proofs: 2, epoch: after.epoch + 1 });
  });
});

test('R6-E-004/005 candidate ingestion refuses mismatched bindings and an ordinary target without adding rows', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      before = await facts(f),
      body = await p.signed('witness-negative');
    const changed = [
      { config: { ...p.c.config, testMode: false, testRunId: null } },
      { config: { ...p.c.config, testContentAllowed: false } },
      { config: { ...p.c.config, testRunId: 'foreign-namespace' } },
      {
        config: {
          ...p.c.config,
          curriculumTrust: { ...p.trust, sourceDigest: digest },
        },
      },
      { corpus: { ...p.c.corpus, capability: null } },
      { corpus: { ...p.c.corpus, fixtureBinding: null } },
    ];
    for (const change of changed) {
      await assert.rejects(
        ingestCorpusProof({ ...p.c, ...change }, p.version, body),
        /CAPABILITY_DENIED|PROOF_UNTRUSTED/,
      );
      assert.deepEqual(await facts(f), before);
    }
    for (const change of [
      { targetInstallationId: 'foreign-target' },
      { evidenceInstallationId: 'foreign-origin' },
      { namespace: 'foreign-namespace' },
    ]) {
      await assert.rejects(
        ingestCorpusProof(
          p.c,
          p.version,
          await p.signed('witness-binding', change),
        ),
        /PROOF_IDENTITY_MISMATCH/,
      );
      assert.deepEqual(await facts(f), before);
    }
    await f.client.execute(
      "UPDATE pilot_installation SET installation_id='restored-fresh' WHERE id=1",
    );
    const restored = {
      ...p.c,
      corpus: {
        ...p.c.corpus,
        fixtureBinding: {
          ...p.c.corpus.fixtureBinding,
          installationId: 'restored-fresh',
        },
        capability: {
          ...p.c.corpus.capability,
          installationId: 'restored-fresh',
        },
      },
    };
    await assert.rejects(
      ingestCorpusProof(
        restored,
        p.version,
        await p.signed('witness-restored', {
          targetInstallationId: 'restored-fresh',
          evidenceInstallationId: 'restored-fresh',
        }),
      ),
      /CAPABILITY_DENIED/,
    );
    assert.deepEqual(await facts(f), before);
  });
});

test('R6-E-004 candidate replay requires current issuer and capability while preserving the stored receipt', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      body = await p.signed('witness-replay');
    await ingestCorpusProof(p.c, p.version, body);
    const before = await facts(f);
    for (const issuers of [[], [{ ...p.issuer, revokedAt: Date.now() }]]) {
      await assert.rejects(
        ingestCorpusProof(
          {
            ...p.c,
            config: { ...p.c.config, curriculumTrust: { ...p.trust, issuers } },
          },
          p.version,
          body,
        ),
        /PROOF_UNTRUSTED/,
      );
    }
    await assert.rejects(
      ingestCorpusProof(
        { ...p.c, config: { ...p.c.config, testMode: false, testRunId: null } },
        p.version,
        body,
      ),
      /CAPABILITY_DENIED/,
    );
    await assert.rejects(
      ingestCorpusProof(
        { ...p.c, corpus: { ...p.c.corpus, capability: null } },
        p.version,
        body,
      ),
      /CAPABILITY_DENIED/,
    );
    assert.deepEqual(await facts(f), before);
  });
});

test('R6-E-004/008 withdrawal denies new candidate proof and candidate replay', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const initial = await bootstrapOwnedCorpus(f.handle),
      p = await policyFixture(f),
      body = await p.signed('witness-withdraw');
    await ingestCorpusProof(p.c, p.version, body);
    await withdrawOwnedCorpus(f.handle, {
      requestId: 'withdraw-witness',
      expectedRevision: initial.revision,
      predecessorPublicationId: initial.recordId,
    });
    const before = await facts(f);
    await assert.rejects(
      ingestCorpusProof(p.c, p.version, body),
      /CAPABILITY_DENIED/,
    );
    await assert.rejects(
      ingestCorpusProof(
        p.c,
        p.version,
        await p.signed('witness-after-withdraw'),
      ),
      /CAPABILITY_DENIED/,
    );
    assert.deepEqual(await facts(f), before);
  });
});

test('R6-E-004/005 final SQL refuses a family link revoked after asynchronous proof verification', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      before = await facts(f),
      db = Object.create(f.db);
    let held = false;
    db.batch = async (statements) => {
      held = true;
      await f.client.execute(
        "DELETE FROM pilot_parent_child WHERE child_id='r6-child-2'",
      );
      return f.db.batch(statements);
    };
    await assert.rejects(
      ingestCorpusProof(
        { ...p.c, db },
        p.version,
        await p.signed('witness-held-link'),
      ),
      /FORBIDDEN|CAPABILITY_DENIED|STORAGE_UNAVAILABLE/,
    );
    assert.equal(held, true);
    assert.deepEqual(await facts(f), before);
  });
});

test('R6-E-004 final constraint rolls back proof and epoch; lost ACK reads the exact committed row', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      before = await facts(f),
      db = Object.create(f.db),
      body = await p.signed('witness-write-outcome');
    db.batch = (statements) =>
      f.db.batch([
        ...statements,
        f.db.prepare(
          'INSERT INTO pilot_installation SELECT * FROM pilot_installation',
        ),
      ]);
    await assert.rejects(
      ingestCorpusProof({ ...p.c, db }, p.version, body),
      /STORAGE_UNAVAILABLE/,
    );
    assert.deepEqual(await facts(f), before);
    db.batch = async (statements) => {
      await f.db.batch(statements);
      throw new Error('synthetic lost acknowledgement');
    };
    assert.equal(
      (await ingestCorpusProof({ ...p.c, db }, p.version, body)).receiptId,
      body.receipt.receiptId,
    );
    assert.deepEqual(await facts(f), { proofs: 1, epoch: before.epoch + 1 });
  });
});
