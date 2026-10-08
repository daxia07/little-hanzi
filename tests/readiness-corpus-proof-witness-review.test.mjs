/** Synthetic direct-store policy checks; these signatures are never execution proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
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

test('Independent: held candidate replay final witness refuses live family unlink', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      body = await p.signed('ind-held-replay');
    await ingestCorpusProof(p.c, p.version, body);
    const before = await facts(f),
      db = Object.create(f.db);
    let checks = 0,
      fired = false;
    db.prepare = (sql) => {
      const s = f.db.prepare(sql);
      if (
        sql.startsWith('SELECT 1 AS ok WHERE') &&
        sql.includes('pilot_corpus_item ci')
      ) {
        const first = s.first.bind(s);
        s.first = async (...args) => {
          if (++checks === 2) {
            fired = true;
            await f.client.execute(
              "DELETE FROM pilot_parent_child WHERE child_id='r6-child-2'",
            );
          }
          return first(...args);
        };
      }
      return s;
    };
    await assert.rejects(
      ingestCorpusProof({ ...p.c, db }, p.version, body),
      /CAPABILITY_DENIED|FORBIDDEN/,
    );
    assert.equal(fired, true);
    assert.deepEqual(await facts(f), before);
  });
});
test('Independent: epoch change at final INSERT prepare refuses without proof writes', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      db = Object.create(f.db),
      body = await p.signed('ind-epoch-race'),
      before = await facts(f);
    let fired = false;
    db.batch = async (statements) => {
      fired = true;
      await f.client.execute(
        'UPDATE pilot_corpus_evidence_epoch SET revision=revision+1 WHERE id=1',
      );
      return f.db.batch(statements);
    };
    await assert.rejects(
      ingestCorpusProof({ ...p.c, db }, p.version, body),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(fired, true);
    assert.deepEqual(await facts(f), {
      proofs: before.proofs,
      epoch: before.epoch + 1,
    });
  });
});
test('Independent: test-content revocation at final INSERT prepare cannot commit candidate proof', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      db = Object.create(f.db),
      body = await p.signed('ind-config-race'),
      before = await facts(f);
    let fired = false;
    db.prepare = (sql) => {
      const s = f.db.prepare(sql);
      if (sql.startsWith('INSERT INTO pilot_corpus_proof_receipt')) {
        fired = true;
        p.c.config.testContentAllowed = false;
      }
      return s;
    };
    await assert.rejects(
      ingestCorpusProof({ ...p.c, db }, p.version, body),
      /CAPABILITY_DENIED|PROOF_UNTRUSTED/,
    );
    assert.equal(fired, true);
    assert.deepEqual(await facts(f), before);
  });
});

test('Independent: candidate replay cannot ACK when test-content revoked during final witness query', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await bootstrapOwnedCorpus(f.handle);
    const p = await policyFixture(f),
      body = await p.signed('ind-replay-config');
    await ingestCorpusProof(p.c, p.version, body);
    const before = await facts(f),
      db = Object.create(f.db);
    let checks = 0,
      fired = false;
    db.prepare = (sql) => {
      const s = f.db.prepare(sql);
      if (
        sql.startsWith('SELECT 1 AS ok WHERE') &&
        sql.includes('pilot_corpus_item ci')
      ) {
        const first = s.first.bind(s);
        s.first = async (...args) => {
          if (++checks === 2) {
            fired = true;
            p.c.config.testContentAllowed = false;
          }
          return first(...args);
        };
      }
      return s;
    };
    await assert.rejects(
      ingestCorpusProof({ ...p.c, db }, p.version, body),
      /CAPABILITY_DENIED|PROOF_UNTRUSTED/,
    );
    assert.equal(fired, true);
    assert.deepEqual(await facts(f), before);
  });
});
