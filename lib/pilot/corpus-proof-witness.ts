/** Persisted evidence of the closed bootstrap, never a request-supplied flag. */
import { canonicalPackage } from '../curriculum/digest.ts';
import { fail } from './story-policy.ts';
import {
  readCurrentCorpusAuthority,
  requireCorpusVerificationBinding,
  corpusScopeGuard,
  corpusEligiblePackageGuard,
  type CorpusAuthority,
} from './corpus-authority.ts';
import {
  corpusOne,
  corpusActorGuard,
  corpusInstallationGuard,
  sqlValue as q,
  type CorpusContext,
} from './corpus-db.ts';

export interface CorpusProofWitness {
  authority: CorpusAuthority;
  guard: string;
  evidenceEpoch: number;
}

export async function requireCorpusProofWitness(
  c: CorpusContext,
  witness: CorpusProofWitness,
) {
  await requireCorpusVerificationBinding(c, witness.authority);
  if (
    !(await corpusOne(
      c,
      `SELECT 1 AS ok WHERE ${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(witness.authority.installationId)} AND ${witness.guard}`,
    ))
  )
    fail('CAPABILITY_DENIED', 403);
}

export async function readCorpusProofWitness(
  c: CorpusContext,
  version: string,
  corpusDigest: string,
  lessonVersion: string,
  contentDigest: string,
): Promise<CorpusProofWitness> {
  const a = await readCurrentCorpusAuthority(c, version);
  if (
    !a ||
    a.status !== 'released' ||
    a.scope.kind !== 'verification' ||
    a.corpusDigest !== corpusDigest
  )
    fail('CAPABILITY_DENIED', 403);
  // Immutable publication/snapshot identity plus the live head and current links.
  // The snapshot epoch is deliberately not compared with today's epoch: storing
  // the first valid receipt must not invalidate the remaining corpus receipts.
  const snapshot = [
      `s.status='sealed'`,
      `s.installation_id=${q(a.installationId)}`,
      `s.corpus_version=${q(version)}`,
      `s.corpus_digest=${q(corpusDigest)}`,
      `s.candidate_id=${q(a.candidateId)}`,
      `s.source_digest=${q(a.sourceDigest)}`,
      `s.artifact_digest=${q(a.artifactDigest)}`,
      `s.test_run_id=${q(a.namespaceKey)}`,
      ...Object.entries({
        lane: 'verification',
        installationId: a.installationId,
        corpusVersion: version,
        corpusDigest,
        namespace: a.namespaceKey,
        candidateId: a.candidateId,
        sourceDigest: a.sourceDigest,
        artifactDigest: a.artifactDigest,
        buildId: a.buildId,
      }).map(
        ([key, value]) => `json_extract(s.plan_json,'$.${key}')=${q(value)}`,
      ),
    ].join(' AND '),
    guard = `EXISTS(SELECT 1 FROM pilot_corpus_publication_state h JOIN pilot_corpus_publication p ON p.id=h.latest_publication_id JOIN pilot_corpus_snapshot s ON s.id=p.snapshot_id WHERE h.corpus_version=${q(version)} AND h.installation_id=${q(a.installationId)} AND h.namespace_key=${q(a.namespaceKey)} AND h.revision=${a.releaseRevision} AND p.id=${q(a.releaseId)} AND p.snapshot_id=${q(a.snapshotId)} AND p.status='released' AND p.scope_kind='verification' AND p.scope_json=${q(canonicalPackage(a.scope))} AND p.corpus_version=${q(version)} AND p.corpus_digest=${q(corpusDigest)} AND p.installation_id=${q(a.installationId)} AND p.namespace_key=${q(a.namespaceKey)} AND p.test_run_id=${q(a.namespaceKey)} AND ${snapshot}) AND ${corpusScopeGuard({ kind: 'supervised-trial', members: a.scope.members })} AND EXISTS(SELECT 1 FROM pilot_corpus_item ci WHERE ci.corpus_version=${q(version)} AND ci.lesson_version=${q(lessonVersion)} AND ci.content_digest=${q(contentDigest)} AND ${corpusEligiblePackageGuard(c, a, 'ci')})`,
    witness = { authority: a, guard, evidenceEpoch: a.evidenceEpoch };
  await requireCorpusProofWitness(c, witness);
  return witness;
}
