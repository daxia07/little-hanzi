/** Controlled learning-stage premises, not store execution or human acceptance. */
import fs from 'node:fs';
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../../lib/curriculum/digest.ts';
import {
  compileCorpusRuntime,
  createCorpusRun,
  projectCorpusRun,
  applyCorpusAction,
} from '../../lib/curriculum/corpus-runtime.ts';
import { corpusRequest } from '../../lib/pilot/corpus-policy.ts';

export async function learningHistoryModel() {
  const document = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../content/curriculum/corpus/corpus-path-01-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const compiled = await compileCorpusRuntime(document);
  const d = 'sha256:' + 'a'.repeat(64),
    installationId = 'original-install';
  const scope = {
    kind: 'verification',
    namespace: 'unit-learning',
    members: [{ parentId: 'parent', childId: 'child' }],
  };
  const identity = {
    schemaVersion: 'r6-authority-1',
    corpusVersion: 'unit-corpus-v1',
    corpusDigest: d,
    installationId,
    namespaceKey: 'unit-learning',
    releaseId: 'release',
    releaseRevision: 1,
    snapshotId: 'snapshot',
    candidateId: 'candidate',
    sourceDigest: d,
    artifactDigest: d,
    buildId: 'build',
    scope,
    ownerDecisionId: null,
    configuration: {
      trust: {
        candidateId: 'candidate',
        sourceDigest: d,
        artifactDigest: d,
        buildId: 'build',
        issuers: [],
        archiveIssuers: [],
      },
      candidateId: 'candidate',
      capability: {
        installationId,
        corpusVersion: 'unit-corpus-v1',
        corpusDigest: d,
        namespace: 'unit-learning',
        parentIds: ['parent'],
        childIds: ['child'],
      },
      ownerIds: [],
    },
  };
  const member = {
    lessonVersion: document.lessonVersion,
    contentDigest: compiled.identity.contentDigest,
    packageEligibilityDigest: d,
    packageEligibility: { packageEligible: true, review: null, proof: null },
  };
  const snapshot = {
    corpusVersion: identity.corpusVersion,
    corpusDigest: d,
    installationId,
    namespace: 'unit-learning',
    candidateId: 'candidate',
    sourceDigest: d,
    artifactDigest: d,
    buildId: 'build',
    lane: 'verification',
    packages: [member],
  };
  const publication = {
    id: 'release',
    corpus_version: identity.corpusVersion,
    corpus_digest: d,
    installation_id: installationId,
    test_run_id: 'unit-learning',
    namespace_key: 'unit-learning',
    revision: 1,
    snapshot_id: 'snapshot',
    owner_decision_id: null,
    scope_kind: 'verification',
    scope_json: json(scope),
    status: 'released',
    created_at: 0,
  };
  const assignment = {
    id: 'assignment',
    plan_item_id: 'item',
    child_id: 'child',
    installation_id: installationId,
    corpus_version: identity.corpusVersion,
    corpus_digest: d,
    lesson_version: document.lessonVersion,
    content_digest: compiled.identity.contentDigest,
    publication_id: 'release',
    created_at: 1000,
    test_run_id: 'unit-learning',
  };
  const tables = {
    pilot_auth_user: [
      { id: 'child', role: 'child' },
      { id: 'parent', role: 'parent' },
    ],
    pilot_corpus_plan: [{ id: 'plan', parent_id: 'parent', approved_at: 1000 }],
    pilot_corpus_plan_item: [{ id: 'item', plan_id: 'plan' }],
    pilot_corpus_assignment: [assignment],
    pilot_corpus_schedule: [],
    pilot_corpus_run: [],
    pilot_corpus_event: [],
    pilot_corpus_learning_audit: [
      {
        id: 'audit-plan',
        plan_id: 'plan',
        run_id: null,
        actor_id: 'parent',
        action: 'plan-approval',
        event_id: null,
        revision: null,
        created_at: 1000,
      },
    ],
  };
  const policy = {
    soundReview: 'synthetic',
    authority: identity,
    authorityDigest: await H(identity),
    packageEligibilityDigest: d,
    reviewId: null,
    proofId: null,
  };
  // Fixed independent FNV-1a expectation for the literal assignment ID. Do not import
  // the store's seed helper into the expected fixture construction.
  let seed = 2166136261;
  for (const ch of assignment.id)
    seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  seed >>>= 0;
  let initial = null,
    completed = null;
  for (const [phase, offset] of [
    ['initial', 0],
    ['review-24h', 86400000],
    ['review-7d', 604800000],
  ]) {
    const due = phase === 'initial' ? 1000 : initial.completed_at + offset;
    const schedule = {
      id: 'schedule-' + phase,
      assignment_id: assignment.id,
      child_id: 'child',
      installation_id: installationId,
      kind: phase,
      due_at: due,
      policy_version: 'r6-review-24h-7d-1',
      initial_run_id: initial?.id ?? null,
      completion_event_id: completed?.id ?? null,
      initial_completed_at: initial?.completed_at ?? null,
      created_at: initial?.completed_at ?? 1000,
    };
    tables.pilot_corpus_schedule.push(schedule);
    const runId = 'run-' + phase;
    let run = createCorpusRun(compiled, { runId, seed, phase, now: due });
    const body = { requestId: 'start-' + phase, scheduleId: schedule.id };
    const request = corpusRequest(
      'start',
      'child',
      installationId,
      assignment.id,
      body,
    );
    tables.pilot_corpus_learning_audit.push({
      id: 'audit-' + runId,
      plan_id: null,
      run_id: runId,
      actor_id: 'child',
      action: 'run-start',
      event_id: null,
      revision: 0,
      created_at: due,
    });
    let last = null;
    while (!run.state.completedAt) {
      if (run.revision >= 150) throw new Error('Fixture did not finish');
      const view = projectCorpusRun(compiled, run, {
          soundReview: 'synthetic',
        }),
        q = view.question;
      let type = 'continue',
        payload = {};
      if (q && !view.canContinue) {
        const target = document.characters.find(
          (c) => c.characterId === q.characterId,
        ).hanzi;
        type = 'answer';
        payload = {
          choiceId: q.choices.find((c) => c.hanzi === target).choiceId,
        };
        if (
          phase === 'initial' &&
          run.state.stepId === 'familiarity' &&
          run.state.questionIndex === 0
        ) {
          if (!q.attempts)
            payload = {
              choiceId: q.choices.find((c) => c.hanzi !== target).choiceId,
            };
          else if (!q.hintLevel) {
            type = 'help';
            payload = {};
          }
        } else if (phase === 'initial' && run.state.stepId === 'familiarity') {
          type = 'audio-unavailable';
          payload = {};
        }
      }
      const action = {
        eventId: runId + '-event-' + (run.revision + 1),
        expectedRevision: run.revision,
        occurrenceId: q?.occurrenceId ?? null,
        type,
        payload,
      };
      const at = due + run.revision + 1;
      const next = applyCorpusAction(compiled, run, action, {
        now: at,
        soundReview: 'synthetic',
      });
      run = next.run;
      last = {
        id: 'row-' + action.eventId,
        run_id: runId,
        event_id: action.eventId,
        sequence: run.revision,
        expected_revision: action.expectedRevision,
        request_digest: await H(
          corpusRequest('action', 'child', installationId, runId, action),
        ),
        action_json: json(action),
        result_json: json({ event: next.event, ack: next.ack, policy }),
        server_at: at,
      };
      tables.pilot_corpus_event.push(last);
      tables.pilot_corpus_learning_audit.push({
        id: 'audit-' + action.eventId,
        plan_id: null,
        run_id: runId,
        actor_id: 'child',
        action: 'run-action',
        event_id: last.id,
        revision: run.revision,
        created_at: at,
      });
    }
    const row = {
      id: runId,
      assignment_id: assignment.id,
      schedule_id: schedule.id,
      child_id: 'child',
      installation_id: installationId,
      corpus_version: identity.corpusVersion,
      corpus_digest: d,
      lesson_version: document.lessonVersion,
      content_digest: compiled.identity.contentDigest,
      publication_id: 'release',
      adapter_id: 'corpus-paired',
      adapter_version: 'corpus-paired-v1',
      phase,
      seed,
      start_request_id: body.requestId,
      start_request_json: json(request),
      start_request_digest: await H(request),
      start_ack_json: json({
        runId,
        assignmentId: assignment.id,
        scheduleId: schedule.id,
        lessonVersion: document.lessonVersion,
        revision: 0,
      }),
      run_json: json(run),
      revision: run.revision,
      completed_at: Date.parse(run.state.completedAt),
      created_at: due,
      updated_at: Date.parse(run.updatedAt),
      test_run_id: 'unit-learning',
    };
    tables.pilot_corpus_run.push(row);
    if (phase === 'initial') {
      initial = row;
      completed = last;
    }
  }
  return {
    payload: { tables },
    document,
    publication,
    snapshot,
    scope,
    unavailableAt: null,
  };
}
export function learningDependencies(model) {
  const t = model.payload.tables;
  const keyed = (rows) => new Map(rows.map((r) => [r.id, r]));
  return {
    registry: {
      documents: new Map([[model.document.lessonVersion, model.document]]),
    },
    snapshots: new Map([
      ['snapshot', { row: { id: 'snapshot' }, plan: model.snapshot }],
    ]),
    authority: {
      publications: new Map([
        [
          'release',
          { row: model.publication, plan: model.snapshot, scope: model.scope },
        ],
      ]),
      validAt: (_id, at) =>
        model.unavailableAt === null || at < model.unavailableAt,
    },
    selection: {
      plans: keyed(t.pilot_corpus_plan),
      items: keyed(t.pilot_corpus_plan_item),
      assignments: keyed(t.pilot_corpus_assignment),
      schedules: keyed(t.pilot_corpus_schedule),
    },
  };
}
