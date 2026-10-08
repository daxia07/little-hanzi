/** Historical authority stage, after authenticated registry/proof/snapshot stages.
 * Embedded configuration is attribution only; current roles/sessions are never grants.
 */
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import {
  corpusId,
  corpusRequest,
  safeCorpusJson,
} from '../lib/pilot/corpus-policy.ts';
const check = (v) => {
  if (!v) throw new Error('BACKUP_CORPUS_INVALID');
};
const same = (a, b) => json(a) === json(b);
const key = (...v) => json(v);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exact = (v, fields) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  same(Object.keys(v).sort(order), [...fields].sort(order));
const parsed = (raw) => {
  const v = JSON.parse(raw);
  check(json(v) === raw);
  return v;
};
const time = (at) => {
  check(Number.isSafeInteger(at) && at >= 0);
  return new Date(at).toISOString();
};
function scope(input, verification = false) {
  const v = safeCorpusJson(input, 64 * 1024);
  if (exact(v, ['kind']) && v.kind === 'starter') return v;
  check(
    exact(
      v,
      verification ? ['kind', 'namespace', 'members'] : ['kind', 'members'],
    ) &&
      v.kind === (verification ? 'verification' : 'supervised-trial') &&
      (!verification || corpusId(v.namespace)) &&
      Array.isArray(v.members) &&
      v.members.length >= 1 &&
      v.members.length <= 100,
  );
  check(
    v.members.every(
      (m) =>
        exact(m, ['parentId', 'childId']) &&
        corpusId(m.parentId) &&
        corpusId(m.childId),
    ) && new Set(v.members.map((m) => m.childId)).size === v.members.length,
  );
  return {
    ...v,
    members: [...v.members].sort(
      (a, b) => order(a.childId, b.childId) || order(a.parentId, b.parentId),
    ),
  };
}
async function request(row, operation, resource, fields, users) {
  const e = parsed(row.request_json);
  check(
    users.has(row.actor_id) &&
      corpusId(row.id) &&
      corpusId(row.request_id) &&
      exact(e, [
        'schemaVersion',
        'actorId',
        'installationId',
        'resourceId',
        'request',
      ]) &&
      exact(e.request, fields) &&
      e.actorId === row.actor_id &&
      e.request.requestId === row.request_id &&
      same(
        e,
        corpusRequest(
          operation,
          row.actor_id,
          row.installation_id,
          resource,
          e.request,
        ),
      ) &&
      (await H(e)) === row.request_digest,
  );
  safeCorpusJson(e.request, 64 * 1024);
  return e.request;
}
function bound(row, s) {
  check(
    s &&
      s.row.status === 'sealed' &&
      s.row.sealed_at <= (row.decided_at ?? row.created_at),
  );
  const p = s.plan;
  check(
    row.snapshot_id === s.row.id &&
      row.corpus_digest === p.corpusDigest &&
      row.installation_id === p.installationId,
  );
  return p;
}
/** Returns maps and a historical selected-package availability predicate.
 * Equal-millisecond successors do not establish causal precedence.
 */
export async function validateCorpusAuthorityFacts(
  payload,
  { registry, proofs, snapshots },
) {
  const t = payload.tables,
    users = new Set(t.pilot_auth_user.map((u) => u.id));
  const owners = new Map(),
    publications = new Map(),
    heads = new Map(),
    requests = new Set();
  function packageAt(plan, p, at) {
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !p ||
      p.packageEligibility.targets.length !== 2
    )
      return false;
    const e = p.packageEligibility,
      verification = plan.lane === 'verification';
    if (verification ? !e.machineUsableVerification : !e.realEligible)
      return false;
    for (const target of e.targets) {
      const source = registry.sources.get(target.sourceEvidenceId);
      if (
        !source ||
        source.created_at > at ||
        [...registry.sources.values()].some(
          (r) => r.supersedes_id === source.id && r.created_at < at,
        )
      )
        return false;
    }
    if (e.review) {
      const r = t.pilot_curriculum_review.find(
        (r) => r.review_id === e.review.reviewId,
      );
      if (
        !r ||
        r.recorded_at > at ||
        t.pilot_curriculum_review.some(
          (n) =>
            n.lesson_version === p.lessonVersion &&
            n.review_sequence > r.review_sequence &&
            n.recorded_at < at,
        )
      )
        return false;
    } else if (!verification) return false;
    if (e.proof) {
      const proof = proofs.get(e.proof.proofId);
      if (
        !proof ||
        proof.row.received_at > at ||
        (proof.issuer.revokedAt !== null && proof.issuer.revokedAt <= at)
      )
        return false;
    } else if (!verification) return false;
    return true;
  }
  function wholeAt(plan, at) {
    return (
      plan.releasedPackages.length > 0 &&
      plan.releasedPackages.every((i) => {
        const p = plan.packages.find(
          (p) =>
            p.lessonVersion === i.lessonVersion &&
            p.contentDigest === i.contentDigest,
        );
        return packageAt(plan, p, at);
      })
    );
  }
  for (const row of t.pilot_corpus_owner_decision) {
    check(!owners.has(row.id));
    time(row.decided_at);
    const s = snapshots.get(row.snapshot_id),
      p = bound(row, s);
    check(
      p.lane === 'ordinary' &&
        row.test_run_id === null &&
        row.candidate_id === p.candidateId &&
        row.source_digest === p.sourceDigest &&
        row.artifact_digest === p.artifactDigest &&
        typeof row.owner_session_id === 'string' &&
        row.owner_session_id.length > 0 &&
        row.owner_session_id.length <= 500 &&
        ['accepted', 'rejected'].includes(row.decision),
    );
    const b = await request(
        row,
        'owner-decision',
        p.corpusVersion,
        [
          'requestId',
          'snapshotId',
          'corpusDigest',
          'candidateId',
          'sourceDigest',
          'artifactDigest',
          'scope',
          'decision',
        ],
        users,
      ),
      sc = scope(parsed(row.scope_json));
    check(
      same(sc, parsed(row.scope_json)) &&
        (await H(sc)) === row.scope_digest &&
        same(scope(b.scope), sc) &&
        b.snapshotId === row.snapshot_id &&
        b.corpusDigest === p.corpusDigest &&
        b.candidateId === p.candidateId &&
        b.sourceDigest === p.sourceDigest &&
        b.artifactDigest === p.artifactDigest &&
        b.decision === row.decision,
    );
    if (sc.kind !== 'starter')
      check(
        sc.members.every((m) => users.has(m.parentId) && users.has(m.childId)),
      );
    check(
      same(parsed(row.ack_json), {
        requestId: row.request_id,
        recordId: row.id,
        recordedAt: time(row.decided_at),
      }),
    );
    const rk = key(
      'owner',
      row.actor_id,
      row.installation_id,
      p.corpusVersion,
      row.request_id,
    );
    check(!requests.has(rk));
    requests.add(rk);
    if (row.decision === 'accepted')
      check(
        wholeAt(p, row.decided_at) &&
          (sc.kind !== 'starter' || p.counts.includedCharacterCount >= 1600),
      );
    owners.set(row.id, { row, plan: p, scope: sc });
  }
  const chains = new Map();
  for (const row of t.pilot_corpus_publication) {
    check(!publications.has(row.id));
    time(row.created_at);
    const s = snapshots.get(row.snapshot_id),
      p = bound(row, s),
      verification = row.scope_kind === 'verification';
    check(
      p.corpusVersion === row.corpus_version &&
        ['released', 'withdrawn'].includes(row.status) &&
        Number.isSafeInteger(row.revision) &&
        row.revision >= 1,
    );
    const b = await request(
        row,
        'publication',
        p.corpusVersion,
        row.status === 'released'
          ? [
              'requestId',
              'snapshotId',
              'ownerDecisionId',
              'expectedRevision',
              'predecessorPublicationId',
            ]
          : ['requestId', 'expectedRevision', 'predecessorPublicationId'],
        users,
      ),
      sc = scope(parsed(row.scope_json), verification);
    check(
      same(sc, parsed(row.scope_json)) &&
        row.scope_kind === sc.kind &&
        (await H(sc)) === row.scope_digest &&
        b.expectedRevision === row.revision - 1 &&
        b.predecessorPublicationId === row.predecessor_id,
    );
    if (verification)
      check(
        p.lane === 'verification' &&
          row.owner_decision_id === null &&
          row.namespace_key === p.namespace &&
          row.test_run_id === p.namespace &&
          sc.namespace === p.namespace,
      );
    else {
      const o = owners.get(row.owner_decision_id);
      check(
        p.lane === 'ordinary' &&
          row.namespace_key === 'ordinary' &&
          row.test_run_id === null &&
          o?.row.decision === 'accepted' &&
          o.row.decided_at <= row.created_at &&
          o.row.snapshot_id === row.snapshot_id &&
          same(o.scope, sc),
      );
    }
    if (row.status === 'released')
      check(
        b.snapshotId === row.snapshot_id &&
          b.ownerDecisionId === row.owner_decision_id &&
          wholeAt(p, row.created_at) &&
          (verification ||
            sc.kind !== 'starter' ||
            p.counts.includedCharacterCount >= 1600),
      );
    check(
      same(parsed(row.ack_json), {
        requestId: row.request_id,
        recordId: row.id,
        recordedAt: time(row.created_at),
        revision: row.revision,
        corpusDigest: row.corpus_digest,
        snapshotId: row.snapshot_id,
      }),
    );
    const rk = key(
      'pub',
      row.actor_id,
      row.installation_id,
      row.corpus_version,
      row.request_id,
    );
    check(!requests.has(rk));
    requests.add(rk);
    const audits = t.pilot_corpus_publication_audit.filter(
      (a) => a.publication_id === row.id,
    );
    check(
      audits.length === 1 &&
        audits[0].actor_id === row.actor_id &&
        audits[0].action === row.status &&
        audits[0].request_id === row.request_id &&
        audits[0].created_at === row.created_at &&
        corpusId(audits[0].id),
    );
    const members = t.pilot_corpus_trial_member.filter(
      (m) => m.publication_id === row.id,
    );
    check(
      members.every(
        (m) =>
          m.installation_id === row.installation_id &&
          users.has(m.parent_id) &&
          users.has(m.child_id),
      ) &&
        same(
          members
            .map((m) => ({ parentId: m.parent_id, childId: m.child_id }))
            .sort(
              (a, b) =>
                order(a.childId, b.childId) || order(a.parentId, b.parentId),
            ),
          sc.kind === 'starter' ? [] : sc.members,
        ),
    );
    const entry = { row, plan: p, scope: sc };
    publications.set(row.id, entry);
    const ck = key(row.corpus_version, row.installation_id, row.namespace_key),
      list = chains.get(ck) ?? [];
    list.push(entry);
    chains.set(ck, list);
  }
  check(
    t.pilot_corpus_publication_audit.length === publications.size &&
      t.pilot_corpus_trial_member.every((m) =>
        publications.has(m.publication_id),
      ),
  );
  for (const [ck, chain] of chains) {
    chain.sort((a, b) => a.row.revision - b.row.revision);
    for (const [i, v] of chain.entries()) {
      const prev = chain[i - 1];
      check(
        v.row.revision === i + 1 &&
          v.row.predecessor_id === (prev?.row.id ?? null) &&
          (!prev || v.row.created_at >= prev.row.created_at),
      );
      if (v.row.status === 'withdrawn')
        check(
          prev &&
            v.row.snapshot_id === prev.row.snapshot_id &&
            v.row.owner_decision_id === prev.row.owner_decision_id &&
            same(v.scope, prev.scope),
        );
    }
    const last = chain.at(-1).row,
      matches = t.pilot_corpus_publication_state.filter(
        (h) => key(h.corpus_version, h.installation_id, h.namespace_key) === ck,
      );
    check(
      matches.length === 1 &&
        matches[0].latest_publication_id === last.id &&
        matches[0].revision === last.revision &&
        matches[0].updated_at === last.created_at,
    );
    heads.set(ck, matches[0]);
  }
  check(t.pilot_corpus_publication_state.length === heads.size);
  function validAt(publicationId, at, childId, parentId, lessonVersion) {
    const v = publications.get(publicationId);
    if (
      !v ||
      !Number.isSafeInteger(at) ||
      v.row.status !== 'released' ||
      v.row.created_at > at
    )
      return false;
    const chain = chains.get(
      key(v.row.corpus_version, v.row.installation_id, v.row.namespace_key),
    );
    if (
      chain.some(
        (n) => n.row.revision > v.row.revision && n.row.created_at < at,
      )
    )
      return false;
    if (
      (childId !== undefined && !users.has(childId)) ||
      (parentId !== undefined && !users.has(parentId))
    )
      return false;
    if (
      childId !== undefined &&
      v.scope.kind !== 'starter' &&
      !v.scope.members.some(
        (m) =>
          m.childId === childId &&
          (parentId === undefined || m.parentId === parentId),
      )
    )
      return false;
    if (lessonVersion !== undefined) {
      if (
        !v.plan.releasedPackages.some((p) => p.lessonVersion === lessonVersion)
      )
        return false;
      return packageAt(
        v.plan,
        v.plan.packages.find((p) => p.lessonVersion === lessonVersion),
        at,
      );
    }
    return wholeAt(v.plan, at);
  }
  return { owners, publications, heads, validAt };
}
