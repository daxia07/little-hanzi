/** Historical learning replay after the complete registry/authority/selection stages. */
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import {
  compileCorpusRuntime,
  validateCorpusRun,
} from '../lib/curriculum/corpus-runtime.ts';
import { corpusId, corpusRequest } from '../lib/pilot/corpus-policy.ts';
import {
  corpusSeed,
  inspectCorpusStartInput,
  inspectCorpusAction,
  inspectCorpusEventPolicy,
} from '../lib/pilot/corpus-learning-policy.ts';
const check = (value) => {
  if (!value) throw new Error('BACKUP_CORPUS_INVALID');
};
const same = (a, b) => json(a) === json(b);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  same(Object.keys(v).sort(order), [...keys].sort(order));
const iso = (value) => new Date(value).toISOString();
const parsed = (value) => {
  const v = JSON.parse(value);
  check(json(v) === value);
  return v;
};
function keyed(rows) {
  const map = new Map();
  for (const row of rows) {
    check(corpusId(row.id) && !map.has(row.id));
    map.set(row.id, row);
  }
  return map;
}
const identityFields = [
  'child_id',
  'installation_id',
  'corpus_version',
  'corpus_digest',
  'lesson_version',
  'content_digest',
  'publication_id',
  'test_run_id',
];
const bound = (a, b, fields) => fields.every((k) => a[k] === b[k]);

export async function validateCorpusLearningFacts(
  payload,
  { registry, snapshots, authority, selection },
) {
  try {
    const t = payload.tables,
      runs = keyed(t.pilot_corpus_run),
      events = keyed(t.pilot_corpus_event),
      audits = keyed(t.pilot_corpus_learning_audit);
    const users = new Set(t.pilot_auth_user.map((u) => u.id));
    const compiled = new Map(),
      eventsByRun = new Map(),
      usedEvents = new Set(),
      usedAudits = new Set();
    const startAudits = new Map(),
      actionAudits = new Map(),
      planAudits = new Map();
    for (const audit of audits.values()) {
      check(users.has(audit.actor_id));
      const index =
        audit.action === 'plan-approval'
          ? planAudits
          : audit.action === 'run-start'
            ? startAudits
            : audit.action === 'run-action'
              ? actionAudits
              : null;
      check(index);
      const k =
        audit.action === 'plan-approval'
          ? audit.plan_id
          : audit.action === 'run-start'
            ? audit.run_id
            : audit.event_id;
      check(corpusId(k) && !index.has(k));
      index.set(k, audit);
    }
    for (const plan of selection.plans.values()) {
      const audit = planAudits.get(plan.id);
      check(
        audit &&
          audit.actor_id === plan.parent_id &&
          audit.run_id === null &&
          audit.event_id === null &&
          audit.revision === null &&
          audit.created_at === plan.approved_at,
      );
      usedAudits.add(audit.id);
    }
    for (const event of events.values()) {
      check(runs.has(event.run_id));
      const list = eventsByRun.get(event.run_id) ?? [];
      list.push(event);
      eventsByRun.set(event.run_id, list);
    }
    const runBySchedule = new Map(),
      runByPhase = new Map(),
      startKeys = new Set(),
      replayed = new Map();
    for (const row of runs.values()) {
      const assignment = selection.assignments.get(row.assignment_id),
        schedule = selection.schedules.get(row.schedule_id);
      check(
        assignment &&
          schedule &&
          users.has(row.child_id) &&
          bound(row, assignment, identityFields) &&
          schedule.assignment_id === assignment.id &&
          bound(row, schedule, ['child_id', 'installation_id']) &&
          schedule.kind === row.phase &&
          row.adapter_id === 'corpus-paired' &&
          row.adapter_version === 'corpus-paired-v1' &&
          row.created_at >= schedule.due_at &&
          row.seed === corpusSeed(assignment.id) &&
          !runBySchedule.has(schedule.id),
      );
      runBySchedule.set(schedule.id, row);
      const phaseKey = json([assignment.id, row.phase]);
      check(!runByPhase.has(phaseKey));
      runByPhase.set(phaseKey, row);
      const item = selection.items.get(assignment.plan_item_id),
        plan = item ? selection.plans.get(item.plan_id) : null;
      check(
        plan &&
          (await authority.validAt(
            row.publication_id,
            row.created_at,
            row.child_id,
            plan.parent_id,
            row.lesson_version,
          )),
      );
      const startKey = json([
        row.child_id,
        row.installation_id,
        row.assignment_id,
        row.start_request_id,
      ]);
      check(!startKeys.has(startKey));
      startKeys.add(startKey);
      const request = parsed(row.start_request_json),
        body = inspectCorpusStartInput(request.request);
      check(
        same(
          request,
          corpusRequest(
            'start',
            row.child_id,
            row.installation_id,
            row.assignment_id,
            body,
          ),
        ) &&
          (await H(request)) === row.start_request_digest &&
          body.requestId === row.start_request_id &&
          body.scheduleId === row.schedule_id &&
          same(parsed(row.start_ack_json), {
            runId: row.id,
            assignmentId: row.assignment_id,
            scheduleId: row.schedule_id,
            lessonVersion: row.lesson_version,
            revision: 0,
          }),
      );
      if (!compiled.has(row.lesson_version)) {
        const document = registry.documents.get(row.lesson_version);
        check(document);
        compiled.set(row.lesson_version, await compileCorpusRuntime(document));
      }
      const lesson = compiled.get(row.lesson_version),
        run = validateCorpusRun(lesson, parsed(row.run_json));
      const ledger = (eventsByRun.get(row.id) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      );
      check(
        run.runId === row.id &&
          run.identity.lessonVersion === row.lesson_version &&
          run.identity.contentDigest === row.content_digest &&
          run.seed === row.seed &&
          run.state.phase === row.phase &&
          run.revision === row.revision &&
          ledger.length === run.revision &&
          run.createdAt === iso(row.created_at) &&
          run.updatedAt === iso(row.updated_at) &&
          run.state.completedAt ===
            (row.completed_at === null ? null : iso(row.completed_at)),
      );
      replayed.set(row.id, run);
      const startAudit = startAudits.get(row.id);
      check(
        startAudit &&
          startAudit.plan_id === null &&
          startAudit.actor_id === row.child_id &&
          startAudit.event_id === null &&
          startAudit.revision === 0 &&
          startAudit.created_at === row.created_at,
      );
      usedAudits.add(startAudit.id);
      const publication = authority.publications.get(row.publication_id),
        pub = publication?.row;
      const snap = pub ? snapshots.get(pub.snapshot_id) : null,
        p = snap?.plan;
      const member = p?.packages.find(
        (x) =>
          x.lessonVersion === row.lesson_version &&
          x.contentDigest === row.content_digest,
      );
      check(pub && p && member?.packageEligibility.packageEligible);
      for (let i = 0; i < ledger.length; i++) {
        const event = ledger[i],
          result = parsed(event.result_json),
          action = inspectCorpusAction(parsed(event.action_json)),
          recorded = run.events[i];
        check(
          exact(result, ['event', 'ack', 'policy']) &&
            event.sequence === i + 1 &&
            event.expected_revision === i &&
            event.event_id === action.eventId &&
            action.expectedRevision === i &&
            same(action, recorded.action) &&
            same(result.event, recorded) &&
            event.server_at === Date.parse(recorded.serverTime) &&
            (await H(
              corpusRequest(
                'action',
                row.child_id,
                row.installation_id,
                row.id,
                action,
              ),
            )) === event.request_digest &&
            same(result.ack, {
              eventId: recorded.eventId,
              revision: recorded.sequence,
              result: recorded.result,
            }),
        );
        const policy = await inspectCorpusEventPolicy(result.policy),
          a = policy.authority;
        check(
          a.corpusVersion === row.corpus_version &&
            a.corpusDigest === row.corpus_digest &&
            a.installationId === row.installation_id &&
            a.namespaceKey === (row.test_run_id ?? 'ordinary') &&
            a.releaseId === pub.id &&
            a.releaseRevision === pub.revision &&
            a.snapshotId === pub.snapshot_id &&
            a.ownerDecisionId === pub.owner_decision_id &&
            same(a.scope, publication.scope) &&
            a.candidateId === p.candidateId &&
            a.sourceDigest === p.sourceDigest &&
            a.artifactDigest === p.artifactDigest &&
            a.buildId === p.buildId &&
            policy.packageEligibilityDigest ===
              member.packageEligibilityDigest &&
            policy.reviewId ===
              (member.packageEligibility.review?.reviewId ?? null) &&
            policy.proofId ===
              (member.packageEligibility.proof?.proofId ?? null) &&
            policy.soundReview === recorded.soundReview &&
            (await authority.validAt(
              pub.id,
              event.server_at,
              row.child_id,
              plan.parent_id,
              row.lesson_version,
            )),
        );
        const audit = actionAudits.get(event.id);
        check(
          audit &&
            audit.run_id === row.id &&
            audit.plan_id === null &&
            audit.actor_id === row.child_id &&
            audit.revision === event.sequence &&
            audit.created_at === event.server_at,
        );
        usedAudits.add(audit.id);
        usedEvents.add(event.id);
      }
    }
    for (const assignment of selection.assignments.values()) {
      const slots = [...selection.schedules.values()].filter(
          (s) => s.assignment_id === assignment.id,
        ),
        initial = runByPhase.get(json([assignment.id, 'initial']));
      const completed = initial !== undefined && initial.completed_at !== null;
      check(
        slots.length === (completed ? 3 : 1) &&
          slots.filter((s) => s.kind === 'initial').length === 1,
      );
      if (!completed) continue;
      const ledger = eventsByRun.get(initial.id),
        completion = ledger?.at(-1),
        outcome = completion
          ? parsed(completion.result_json).ack.result.outcome
          : null;
      check(
        completion &&
          outcome === 'completed' &&
          completion.server_at === initial.completed_at,
      );
      for (const [kind, offset] of [
        ['review-24h', 86400000],
        ['review-7d', 604800000],
      ]) {
        const matches = slots.filter((s) => s.kind === kind);
        check(matches.length === 1);
        const s = matches[0];
        check(
          s.policy_version === 'r6-review-24h-7d-1' &&
            s.initial_run_id === initial.id &&
            s.completion_event_id === completion.id &&
            s.initial_completed_at === initial.completed_at &&
            s.created_at === initial.completed_at &&
            s.due_at === initial.completed_at + offset &&
            s.child_id === assignment.child_id &&
            s.installation_id === assignment.installation_id,
        );
      }
    }
    check(usedAudits.size === audits.size && usedEvents.size === events.size);
    return { runs, events, replayed };
  } catch {
    throw new Error('BACKUP_CORPUS_INVALID');
  }
}
