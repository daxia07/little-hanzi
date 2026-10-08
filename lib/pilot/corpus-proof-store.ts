/** Saved signed evidence only; never provenance, owner acceptance or publication. */
import { canonicalPackage } from '../curriculum/digest.ts';
import { exact } from '../curriculum/story-package.ts';
import type { CorpusProofSaved } from '../curriculum/corpus-types.ts';
import { safeCorpusJson } from './corpus-policy.ts';
import {
  authenticateCorpusProof,
  inspectCorpusProof,
  verifyCorpusProof,
} from './corpus-proof.ts';
import { registeredCorpus } from './corpus-store.ts';
import {
  readCorpusProofWitness,
  requireCorpusProofWitness,
} from './corpus-proof-witness.ts';
import { fail } from './story-policy.ts';
import {
  corpusOne,
  corpusRows,
  corpusInstallation,
  requireCorpusActor,
  requireCorpusScope,
  corpusNow,
  corpusISO,
  corpusNamespace,
  corpusActorGuard,
  corpusInstallationGuard,
  sqlValue as q,
  type CorpusContext,
  type CorpusRow,
} from './corpus-db.ts';
function saved(row: CorpusRow): CorpusProofSaved {
  return {
    receiptId: String(row.id),
    receiptDigest: String(row.receipt_digest),
    lessonVersion: String(row.lesson_version),
    contentDigest: String(row.content_digest),
    receivedAt: corpusISO(row.received_at),
  };
}
function proofScope(c: CorpusContext) {
  return canonicalPackage({
    trust: c.config.curriculumTrust,
    candidateId: c.config.candidateId,
    capability: c.corpus.capability,
    fixtureBinding: c.corpus.fixtureBinding,
    testMode: c.config.testMode,
    testContentAllowed: c.config.testContentAllowed,
    testRunId: c.config.testRunId,
    testToken: c.config.testToken,
    candidateExplicitlyBound: c.config.candidateExplicitlyBound,
    curriculumTestNow: c.config.curriculumTestNow ?? null,
  });
}
export async function ingestCorpusProof(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusProofSaved> {
  await requireCorpusActor(c, 'operator');
  const installation = await corpusInstallation(c),
    corpus = await registeredCorpus(c, version),
    raw = safeCorpusJson(input, 128 * 1024);
  if (!exact(raw, ['receipt', 'signature'])) fail('INVALID_REQUEST', 400);
  const members = (
      await corpusRows(
        c,
        `SELECT lesson_version,content_digest FROM pilot_corpus_item WHERE corpus_version=${q(version)} ORDER BY ordinal`,
      )
    ).map((r) => ({
      lessonVersion: String(r.lesson_version),
      contentDigest: String(r.content_digest),
    })),
    receipt = inspectCorpusProof(raw.receipt, members),
    body = canonicalPackage(receipt);
  const old = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_proof_receipt WHERE id=${q(receipt.receiptId)}`,
  );
  if (old) {
    if (old.installation_id !== installation || old.corpus_version !== version)
      fail('NOT_FOUND', 404);
    if (old.receipt_json !== body || old.signature !== raw.signature)
      fail('PROOF_CONFLICT');
    // Ordinary immutable attribution replay is historical, not a new grant.
    // Candidate rows still require their current closed verification witness.
    if (!c.config.testMode && old.test_run_id === null) {
      await requireCorpusScope(c, installation);
      return saved(old);
    }
  }
  const trust = c.config.curriculumTrust;
  if (!trust) fail('STORAGE_UNAVAILABLE', 503);
  const now = corpusNow(c);
  const verification = c.config.testMode || !!old?.test_run_id;
  const witness = verification
    ? await readCorpusProofWitness(
        c,
        version,
        String(corpus.corpus_digest),
        receipt.lessonVersion,
        receipt.contentDigest,
      )
    : null;
  const scopeBytes = proofScope(c);
  const authenticated = await authenticateCorpusProof(
    receipt,
    raw.signature,
    trust,
    members,
    now,
    verification,
  );
  const origin = verification
      ? installation
      : authenticated.receipt.evidenceInstallationId,
    namespace = verification
      ? String(c.config.testRunId)
      : authenticated.receipt.namespace;
  const checked = await verifyCorpusProof(
    receipt,
    raw.signature,
    trust,
    {
      candidateId: trust.candidateId,
      sourceDigest: trust.sourceDigest,
      artifactDigest: trust.artifactDigest,
      buildId: trust.buildId,
      installationId: installation,
      evidenceInstallationId: origin,
      corpusVersion: version,
      corpusDigest: String(corpus.corpus_digest),
      namespace,
      verification,
      members,
      lessonVersion: receipt.lessonVersion,
      contentDigest:
        members.find((m) => m.lessonVersion === receipt.lessonVersion)
          ?.contentDigest ?? '',
    },
    now,
  );
  if (trust.candidateId !== c.config.candidateId)
    fail('PROOF_IDENTITY_MISMATCH');
  if (proofScope(c) !== scopeBytes) fail('PROOF_UNTRUSTED');
  await requireCorpusActor(c, 'operator');
  if ((await corpusInstallation(c)) !== installation) fail('UNAUTHORIZED', 401);
  if (witness) await requireCorpusProofWitness(c, witness);
  if (proofScope(c) !== scopeBytes) fail('PROOF_UNTRUSTED');
  if (old) return saved(old);
  const statement = c.db
    .prepare(
      `INSERT INTO pilot_corpus_proof_receipt(id,corpus_version,corpus_digest,lesson_version,content_digest,issuer_id,receipt_version,receipt_json,receipt_digest,signature,issued_at,received_by,received_at,installation_id,namespace,test_run_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(installation)}${witness ? ` AND ${witness.guard} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${witness.evidenceEpoch})` : ''}`,
    )
    .bind(
      receipt.receiptId,
      version,
      corpus.corpus_digest,
      receipt.lessonVersion,
      receipt.contentDigest,
      receipt.issuerId,
      receipt.schemaVersion,
      body,
      checked.receiptDigest,
      raw.signature,
      Date.parse(receipt.issuedAt),
      c.user.id,
      now,
      installation,
      namespace,
      corpusNamespace(c),
    );
  if (proofScope(c) !== scopeBytes) fail('PROOF_UNTRUSTED');
  try {
    const result = await c.db.batch([statement]);
    if (result.some((r) => !r.success)) fail('STORAGE_UNAVAILABLE', 503);
  } catch {
    const committed = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_proof_receipt WHERE id=${q(receipt.receiptId)}`,
    );
    if (
      !committed ||
      committed.installation_id !== installation ||
      committed.corpus_version !== version ||
      committed.receipt_json !== body ||
      committed.signature !== raw.signature
    )
      fail('STORAGE_UNAVAILABLE', 503);
  }
  const stored = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_proof_receipt WHERE id=${q(receipt.receiptId)}`,
  );
  await requireCorpusScope(c, installation);
  if (witness) await requireCorpusProofWitness(c, witness);
  if (proofScope(c) !== scopeBytes) fail('PROOF_UNTRUSTED');
  if (!stored) fail('STORAGE_UNAVAILABLE', 503);
  return saved(stored);
}
