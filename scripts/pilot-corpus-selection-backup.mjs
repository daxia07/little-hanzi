/** Historical proposal/approval stage. Embedded configuration is attribution, never trust. */
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import { corpusId, corpusRequest } from '../lib/pilot/corpus-policy.ts';
import {
  inspectCorpusProposalInput,
  inspectCorpusApprovalInput,
  inspectCorpusPlacementSource,
  inspectCorpusPlacementReason,
  inspectCorpusApprovalAck,
} from '../lib/pilot/corpus-family-policy.ts';
const check = (value) => {
  if (!value) throw new Error('BACKUP_CORPUS_INVALID');
};
const same = (a, b) => json(a) === json(b);
const key = (...parts) => json(parts);
function parsed(value) {
  const result = JSON.parse(value);
  check(json(result) === value);
  return result;
}
function keyed(rows) {
  const map = new Map();
  for (const row of rows) {
    check(corpusId(row.id) && !map.has(row.id));
    map.set(row.id, row);
  }
  return map;
}
const identity = [
  'child_id',
  'installation_id',
  'corpus_version',
  'corpus_digest',
];
const bound = (a, b, fields = identity) =>
  fields.every((field) => a[field] === b[field]);
async function envelope(row, op, actor, resource) {
  const stored = parsed(row.request_json),
    expected = corpusRequest(
      op,
      actor,
      row.installation_id,
      resource,
      stored.request,
    );
  check(same(stored, expected) && (await H(stored)) === row.request_digest);
  return stored.request;
}

export async function validateCorpusSelectionFacts(
  payload,
  { registry, snapshots, authority },
) {
  const t = payload.tables,
    users = new Map(t.pilot_auth_user.map((u) => [u.id, u]));
  const publications = new Map(
    t.pilot_corpus_publication.map((p) => [p.id, p]),
  );
  const proposals = keyed(t.pilot_corpus_proposal),
    plans = keyed(t.pilot_corpus_plan),
    items = keyed(t.pilot_corpus_plan_item),
    assignments = keyed(t.pilot_corpus_assignment),
    schedules = keyed(t.pilot_corpus_schedule);
  const sources = new Map(),
    chains = new Map(),
    requests = new Set();
  for (const row of proposals.values()) {
    check(
      users.has(row.parent_id) &&
        users.has(row.child_id) &&
        row.policy_version === 'r6-placement-1' &&
        row.expires_at === row.created_at + 86400000,
    );
    const body = inspectCorpusProposalInput(
      await envelope(row, 'proposal', row.parent_id, row.corpus_version),
    );
    const source = await inspectCorpusPlacementSource(parsed(row.source_json));
    check(
      (await H(source)) === row.source_digest &&
        source.actorId === row.parent_id &&
        source.childId === row.child_id &&
        source.installationId === row.installation_id &&
        source.corpusVersion === row.corpus_version &&
        source.corpusDigest === row.corpus_digest &&
        source.namespace === row.test_run_id &&
        source.policyVersion === row.policy_version &&
        source.selectionOrdinal === row.selection_ordinal &&
        source.predecessorProposalId === row.predecessor_id &&
        source.predecessorSourceDigest === row.predecessor_source_digest &&
        source.createdAt === row.created_at,
    );
    const reason = inspectCorpusPlacementReason(parsed(row.reason_json));
    check(
      same(reason, {
        schemaVersion: 'r6-placement-reason-1',
        text: source.reason,
        selectedByParent: source.selectedByParent,
      }),
    );
    check(
      body.corpusVersion === row.corpus_version &&
        body.predecessorProposalId === row.predecessor_id &&
        body.expectedSourceDigest === row.predecessor_source_digest &&
        source.selectedByParent === (body.selection !== null) &&
        (body.selection === null || same(body.selection, source.selection)),
    );
    const pub = publications.get(source.selection.releaseId),
      snap = pub ? snapshots.get(pub.snapshot_id) : null;
    check(
      pub &&
        snap &&
        pub.corpus_version === row.corpus_version &&
        pub.corpus_digest === row.corpus_digest &&
        pub.installation_id === row.installation_id &&
        pub.test_run_id === row.test_run_id &&
        pub.revision === source.selection.releaseRevision,
    );
    const a = source.authority,
      plan = snap.plan;
    check(
      a.corpusVersion === pub.corpus_version &&
        a.corpusDigest === pub.corpus_digest &&
        a.installationId === pub.installation_id &&
        a.namespaceKey === pub.namespace_key &&
        a.releaseId === pub.id &&
        a.releaseRevision === pub.revision &&
        a.snapshotId === pub.snapshot_id &&
        a.ownerDecisionId === pub.owner_decision_id &&
        same(a.scope, parsed(pub.scope_json)) &&
        a.candidateId === plan.candidateId &&
        a.sourceDigest === plan.sourceDigest &&
        a.artifactDigest === plan.artifactDigest &&
        a.buildId === plan.buildId &&
        source.evidenceEpoch >= plan.evidenceEpoch + 1,
    );
    const member = plan.packages.find(
      (p) =>
        p.lessonVersion === source.selection.lessonVersion &&
        p.contentDigest === source.selection.contentDigest,
    );
    check(
      member?.packageEligibility.packageEligible &&
        member.packageEligibilityDigest === source.packageEligibilityDigest &&
        registry.packages.get(source.selection.lessonVersion)
          ?.content_digest === source.selection.contentDigest,
    );
    check(
      await authority.validAt(
        pub.id,
        row.created_at,
        row.child_id,
        row.parent_id,
        source.selection.lessonVersion,
      ),
    );
    // Onboarding/activity are original opaque fingerprints. Mutable current rows
    // cannot recreate overwritten historical inputs or grant new authority.
    const scopeKey = key(
      row.child_id,
      row.installation_id,
      row.corpus_version,
      row.test_run_id,
    );
    const requestKey = key(scopeKey, row.request_digest);
    check(!requests.has(requestKey));
    requests.add(requestKey);
    const chain = chains.get(scopeKey) ?? [];
    chain.push(row);
    chains.set(scopeKey, chain);
    sources.set(row.id, source);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.selection_ordinal - b.selection_ordinal);
    for (const [index, row] of chain.entries()) {
      const before = chain[index - 1];
      check(
        row.selection_ordinal === index + 1 &&
          row.predecessor_id === (before?.id ?? null) &&
          row.predecessor_source_digest === (before?.source_digest ?? null) &&
          (!before || row.created_at >= before.created_at),
      );
    }
  }
  const planByProposal = new Map();
  for (const row of plans.values()) {
    const proposal = proposals.get(row.proposal_id),
      source = sources.get(row.proposal_id);
    check(
      proposal &&
        source &&
        bound(row, proposal) &&
        row.parent_id === proposal.parent_id &&
        row.test_run_id === proposal.test_run_id &&
        row.policy_version === proposal.policy_version &&
        row.source_digest === proposal.source_digest &&
        row.approved_at >= proposal.created_at &&
        row.approved_at < proposal.expires_at &&
        !planByProposal.has(proposal.id),
    );
    const successor = [...proposals.values()].find(
      (p) => p.predecessor_id === proposal.id,
    );
    check(!successor || row.approved_at <= successor.created_at);
    const body = inspectCorpusApprovalInput(
      await envelope(row, 'approval', row.parent_id, proposal.id),
    );
    check(
      body.proposalId === proposal.id &&
        body.sourceDigest === proposal.source_digest,
    );
    const ack = inspectCorpusApprovalAck(parsed(row.ack_json));
    check(
      same(ack, {
        planId: row.id,
        proposalId: proposal.id,
        sourceDigest: proposal.source_digest,
        approvedAt: new Date(row.approved_at).toISOString(),
      }),
    );
    check(
      await authority.validAt(
        source.selection.releaseId,
        row.approved_at,
        row.child_id,
        row.parent_id,
        source.selection.lessonVersion,
      ),
    );
    check([...items.values()].filter((i) => i.plan_id === row.id).length === 1);
    const audits = t.pilot_corpus_learning_audit.filter(
      (a) => a.plan_id === row.id,
    );
    check(
      audits.length === 1 &&
        audits[0].action === 'plan-approval' &&
        audits[0].actor_id === row.parent_id &&
        audits[0].created_at === row.approved_at &&
        audits[0].run_id === null &&
        audits[0].event_id === null &&
        audits[0].revision === null &&
        corpusId(audits[0].id),
    );
    planByProposal.set(proposal.id, row);
  }
  const assignmentByItem = new Map();
  for (const row of assignments.values()) {
    const item = items.get(row.plan_item_id),
      plan = item ? plans.get(item.plan_id) : null;
    check(
      item &&
        plan &&
        bound(row, item) &&
        bound(row, item, [
          'publication_id',
          'lesson_version',
          'content_digest',
        ]) &&
        row.created_at === plan.approved_at &&
        row.test_run_id === plan.test_run_id &&
        !assignmentByItem.has(item.id),
    );
    assignmentByItem.set(item.id, row);
    const initial = [...schedules.values()].filter(
      (s) => s.assignment_id === row.id && s.kind === 'initial',
    );
    check(
      initial.length === 1 &&
        initial[0].child_id === row.child_id &&
        initial[0].installation_id === row.installation_id &&
        initial[0].policy_version === 'r6-review-24h-7d-1' &&
        initial[0].due_at === plan.approved_at &&
        initial[0].created_at === plan.approved_at &&
        initial[0].initial_run_id === null &&
        initial[0].completion_event_id === null &&
        initial[0].initial_completed_at === null,
    );
  }
  for (const row of items.values()) {
    const plan = plans.get(row.plan_id),
      proposal = plan ? proposals.get(plan.proposal_id) : null,
      source = proposal ? sources.get(proposal.id) : null;
    check(
      plan &&
        proposal &&
        source &&
        bound(row, plan) &&
        row.ordinal === 0 &&
        row.publication_id === source.selection.releaseId &&
        row.lesson_version === source.selection.lessonVersion &&
        row.content_digest === source.selection.contentDigest &&
        row.reason_json === proposal.reason_json &&
        assignmentByItem.has(row.id),
    );
  }
  const slots = new Set();
  for (const row of schedules.values()) {
    const assignment = assignments.get(row.assignment_id),
      slot = key(row.assignment_id, row.kind);
    check(
      assignment &&
        row.child_id === assignment.child_id &&
        row.installation_id === assignment.installation_id &&
        !slots.has(slot),
    );
    slots.add(slot);
    check(
      ['initial', 'review-24h', 'review-7d'].includes(row.kind) &&
        row.policy_version === 'r6-review-24h-7d-1',
    );
    // Exact later-review completion offsets/run/event replay belong to the next stage.
  }
  const auditIds = new Set();
  for (const row of t.pilot_corpus_learning_audit) {
    check(corpusId(row.id) && !auditIds.has(row.id));
    auditIds.add(row.id);
    if (row.action === 'plan-approval') check(plans.has(row.plan_id));
    else check(row.plan_id === null);
  }
  return { proposals, plans, items, assignments, schedules, sources };
}
