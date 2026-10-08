/** Historical signature/attribution stage, after complete registry validation. */
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { validIssuer } from '../lib/pilot/story-policy.ts';
import { verifyCorpusProof } from '../lib/pilot/corpus-proof.ts';

const check = (value) => {
  if (!value) throw new Error('BACKUP_CORPUS_INVALID');
};
const parsed = (value) => {
  const v = JSON.parse(value);
  check(canonicalPackage(v) === value);
  return v;
};

/** Input is the private inspected copy; supplied issuers are trusted archive configuration. */
export async function validateCorpusProofFacts(payload, archiveIssuers = []) {
  check(
    Array.isArray(archiveIssuers) &&
      archiveIssuers.every(validIssuer) &&
      new Set(archiveIssuers.map((i) => i.issuerId)).size ===
        archiveIssuers.length,
  );
  const users = new Set(payload.tables.pilot_auth_user.map((r) => r.id));
  const corpora = new Map(
    payload.tables.pilot_corpus.map((r) => [r.corpus_version, r]),
  );
  const packages = new Map(
    payload.tables.pilot_curriculum_package.map((r) => [r.lesson_version, r]),
  );
  const proofs = new Map();
  for (const row of payload.tables.pilot_corpus_proof_receipt) {
    check(!proofs.has(row.id));
    const corpus = corpora.get(row.corpus_version),
      pkg = packages.get(row.lesson_version);
    check(
      corpus?.corpus_digest === row.corpus_digest &&
        pkg?.content_digest === row.content_digest &&
        users.has(row.received_by),
    );
    const manifest = inspectCorpusManifest(parsed(corpus.manifest_json));
    const members = manifest.items.map((i) => ({
      lessonVersion: i.lessonVersion,
      contentDigest: i.contentDigest,
    }));
    const receipt = parsed(row.receipt_json),
      verification = row.test_run_id !== null;
    check(
      row.receipt_version === 'r6-proof-receipt-1' &&
        receipt.schemaVersion === row.receipt_version &&
        receipt.receiptId === row.id &&
        receipt.issuerId === row.issuer_id &&
        receipt.namespace === row.namespace &&
        Date.parse(receipt.issuedAt) === row.issued_at,
    );
    if (verification)
      check(
        row.test_run_id === row.namespace &&
          receipt.evidenceInstallationId === row.installation_id,
      );
    const verified = await verifyCorpusProof(
      receipt,
      row.signature,
      {
        candidateId: receipt.candidateId,
        sourceDigest: receipt.sourceDigest,
        artifactDigest: receipt.artifactDigest,
        buildId: receipt.buildId,
        issuers: [],
        archiveIssuers,
      },
      {
        candidateId: receipt.candidateId,
        sourceDigest: receipt.sourceDigest,
        artifactDigest: receipt.artifactDigest,
        buildId: receipt.buildId,
        installationId: row.installation_id,
        evidenceInstallationId: receipt.evidenceInstallationId,
        namespace: row.namespace,
        corpusVersion: row.corpus_version,
        corpusDigest: row.corpus_digest,
        lessonVersion: row.lesson_version,
        contentDigest: row.content_digest,
        verification,
        members,
      },
      row.received_at,
      true,
    );
    // Signature verification authenticates the retained historical origin above.
    // A revocation after issuance but before acceptance still forbade ingestion.
    check(
      verified.receiptDigest === row.receipt_digest &&
        (verified.issuer.revokedAt === null ||
          row.received_at < verified.issuer.revokedAt),
    );
    proofs.set(row.id, {
      row,
      receipt: verified.receipt,
      issuer: verified.issuer,
    });
  }
  return proofs;
}
