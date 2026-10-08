/** R6 durable learning. Historical ACKs are receipts, not current release grants. */
import { parseCorpusBindings } from './corpus-config.ts';
import type { CorpusContext, CorpusRow } from './corpus-db.ts';
import {
  corpusOne,
  corpusRows,
  corpusBatch,
  corpusInsert,
  corpusNewId,
  corpusNow,
  corpusISO,
  sqlValue as q,
} from './corpus-db.ts';
import {
  corpusInstallation,
  requireCorpusActor,
  corpusInstallationGuard,
  corpusActorGuard,
} from './corpus-db.ts';
import {
  familyScope,
  planDisplay,
  proposalDisplay,
} from './corpus-family-store.ts';
import { registeredCorpus, loadCorpusPackage } from './corpus-store.ts';
import {
  readCurrentCorpusAuthority,
  readCorpusPackageAuthority,
  requireCorpusFamilyScope,
  corpusAuthorityGuard,
  assertCorpusAuthorityConfiguration,
  corpusAuthorityIdentity,
  corpusAuthorityDigest,
  finalCorpusScope,
} from './corpus-authority.ts';
import type {
  CorpusAuthority,
  CorpusPackageAuthority,
} from './corpus-authority.ts';
import { corpusNamespace } from './corpus-db.ts';
import { corpusId, corpusRequest } from './corpus-policy.ts';
import {
  corpusSeed,
  inspectCorpusStartInput,
  inspectCorpusAction,
  inspectCorpusEventPolicy,
} from './corpus-learning-policy.ts';
import {
  createCorpusRun,
  validateCorpusRun,
  applyCorpusAction,
  projectCorpusRun,
} from '../curriculum/corpus-runtime.ts';
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { fail } from './story-policy.ts';
import type { CorpusRunView, CorpusPhase } from '../curriculum/corpus-types.ts';
const same = (a: unknown, b: unknown) => json(a) === json(b);
async function availability(c: CorpusContext, row: CorpusRow) {
  const base = await familyScope(c, String(row.child_id)),
    a = await readCurrentCorpusAuthority(c, String(row.corpus_version));
  if (
    !a ||
    a.status !== 'released' ||
    a.releaseId !== row.publication_id ||
    a.installationId !== row.installation_id ||
    row.test_run_id !== corpusNamespace(c)
  )
    return { base, a: null, p: null, available: false, guard: base.guard };
  try {
    const scope = await requireCorpusFamilyScope(c, a, String(row.child_id)),
      p = await readCorpusPackageAuthority(c, a, String(row.lesson_version));
    return { base, a, p, available: p.available, guard: scope.guard };
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND')
      return { base, a: null, p: null, available: false, guard: base.guard };
    throw error;
  }
}
async function finalLearningRead(
  c: CorpusContext,
  base: { installationId: string; guard: string },
  current: Array<{
    a: CorpusAuthority;
    p: CorpusPackageAuthority;
    guard: string;
  }>,
) {
  for (const status of current) assertCorpusAuthorityConfiguration(c, status.a);
  const access = `${corpusActorGuard(c)} AND ${corpusInstallationGuard(base.installationId)} AND (${base.guard})`,
    guards =
      current
        .map(
          (status) =>
            `(${status.guard} AND ${corpusAuthorityGuard(c, status.a, [status.p])})`,
        )
        .join(' AND ') || '1';
  const row = await corpusOne(
    c,
    `SELECT CASE WHEN ${access} THEN 1 ELSE 0 END AS access_ok,CASE WHEN ${guards} THEN 1 ELSE 0 END AS authority_ok`,
  );
  if (!row || row.access_ok !== 1) fail('UNAUTHORIZED', 401);
  if (row.authority_ok !== 1) fail('LESSON_UNAVAILABLE', 409);
}
async function snapshot(c: CorpusContext, runId: string) {
  if (!corpusId(runId)) fail('INVALID_REQUEST', 400);
  const row = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_run WHERE id=${q(runId)}`,
  );
  if (!row) fail('NOT_FOUND', 404);
  const base = await familyScope(c, String(row.child_id)),
    l = await loadCorpusPackage(c, String(row.lesson_version)),
    run = validateCorpusRun(l.compiled, JSON.parse(String(row.run_json)));
  if (
    run.runId !== row.id ||
    run.identity.contentDigest !== row.content_digest ||
    run.seed !== corpusSeed(String(row.assignment_id)) ||
    run.revision !== Number(row.revision) ||
    run.state.phase !== row.phase ||
    run.createdAt !== corpusISO(row.created_at) ||
    run.updatedAt !== corpusISO(row.updated_at) ||
    run.state.completedAt !==
      (row.completed_at === null ? null : corpusISO(row.completed_at))
  )
    fail('STORAGE_UNAVAILABLE', 503);
  const ledger = await corpusRows(
    c,
    `SELECT * FROM pilot_corpus_event WHERE run_id=${q(runId)} ORDER BY sequence`,
  );
  if (ledger.length !== run.events.length) fail('STORAGE_UNAVAILABLE', 503);
  for (const [i, e] of ledger.entries()) {
    const r = JSON.parse(String(e.result_json)),
      fact = run.events[i],
      policy = await inspectCorpusEventPolicy(r.policy);
    const fingerprint = await H(
      corpusRequest(
        'action',
        String(row.child_id),
        String(row.installation_id),
        runId,
        JSON.parse(String(e.action_json)),
      ),
    );
    if (
      !same(r.event, fact) ||
      !same(fact.action, JSON.parse(String(e.action_json))) ||
      fact.sequence !== e.sequence ||
      fact.eventId !== e.event_id ||
      Date.parse(fact.serverTime) !== e.server_at ||
      fingerprint !== e.request_digest ||
      e.expected_revision !== fact.sequence - 1 ||
      policy.soundReview !== fact.soundReview ||
      policy.authority.releaseId !== row.publication_id ||
      r.ack.eventId !== fact.eventId ||
      r.ack.revision !== fact.sequence ||
      !same(r.ack.result, fact.result)
    )
      fail('STORAGE_UNAVAILABLE', 503);
  }
  const schedule = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_schedule WHERE id=${q(row.schedule_id)}`,
    ),
    pub = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_publication WHERE id=${q(row.publication_id)}`,
    ),
    corpus = await registeredCorpus(c, String(row.corpus_version));
  if (!schedule || !pub || corpus.corpus_digest !== row.corpus_digest)
    fail('STORAGE_UNAVAILABLE', 503);
  return { row, base, l, run, ledger, schedule, pub, corpus };
}
export async function getCorpusRun(
  c: CorpusContext,
  runId: string,
): Promise<CorpusRunView> {
  const s = await snapshot(c, runId),
    status = await availability(c, s.row),
    soundReview = status.available
      ? status.p!.soundReview
      : (s.run.events.at(-1)?.soundReview ?? 'pending'),
    projection = projectCorpusRun(s.l.compiled, s.run, { soundReview });
  const view = {
    ...projection,
    corpusId: String(s.corpus.corpus_id),
    corpusVersion: String(s.row.corpus_version),
    corpusDigest: String(s.row.corpus_digest),
    schemaVersion: 'r6-story-view-1' as const,
    runId,
    assignmentId: String(s.row.assignment_id),
    scheduleId: String(s.row.schedule_id),
    releaseId: String(s.row.publication_id),
    releaseRevision: Number(s.pub.revision),
    installationId: String(s.row.installation_id),
    childId: String(s.row.child_id),
    revision: s.run.revision,
    state: s.run.state,
    soundReview,
    available: status.available,
    reason: status.available ? null : 'This story is unavailable.',
    canContinue: status.available && projection.canContinue,
    dueAt: corpusISO(s.schedule.due_at),
    serverAt: corpusISO(corpusNow(c)),
    createdAt: s.run.createdAt,
    updatedAt: s.run.updatedAt,
  };
  await finalLearningRead(
    c,
    status.base,
    status.available
      ? [{ a: status.a!, p: status.p!, guard: status.guard }]
      : [],
  );
  return view;
}
async function startReplay(
  c: CorpusContext,
  row: CorpusRow,
  fingerprint: string,
) {
  if (row.start_request_digest !== fingerprint) fail('EVENT_CONFLICT', 409);
  const base = await familyScope(c, String(row.child_id));
  await finalCorpusScope(c, base.installationId, base.guard);
  return JSON.parse(String(row.start_ack_json));
}
export async function startCorpus(
  c: CorpusContext,
  assignmentId: string,
  input: unknown,
) {
  await requireCorpusActor(c, 'child');
  const body = inspectCorpusStartInput(input),
    install = await corpusInstallation(c);
  const assignment = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_assignment WHERE id=${q(assignmentId)} AND child_id=${q(c.user.id)} AND installation_id=${q(install)} AND test_run_id IS ${q(corpusNamespace(c))}`,
  );
  if (!assignment) fail('NOT_FOUND', 404);
  const base = await familyScope(c, c.user.id),
    schedule = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_schedule WHERE id=${q(body.scheduleId)} AND assignment_id=${q(assignmentId)} AND child_id=${q(c.user.id)} AND installation_id=${q(install)}`,
    );
  if (!schedule) fail('NOT_FOUND', 404);
  const request = corpusRequest(
      'start',
      c.user.id,
      install,
      assignmentId,
      body,
    ),
    fingerprint = await H(request),
    prior = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_run WHERE assignment_id=${q(assignmentId)} AND child_id=${q(c.user.id)} AND installation_id=${q(install)} AND start_request_id=${q(body.requestId)}`,
    );
  if (prior) return startReplay(c, prior, fingerprint);
  const opened = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_run WHERE schedule_id=${q(schedule.id)}`,
  );
  if (opened) {
    await finalCorpusScope(c, install, base.guard);
    return JSON.parse(String(opened.start_ack_json));
  }
  const status = await availability(c, assignment);
  if (!status.available) fail('LESSON_UNAVAILABLE', 409);
  const a = status.a!,
    p = status.p!;
  const l = await loadCorpusPackage(c, String(assignment.lesson_version)),
    at = corpusNow(c);
  if (Number(schedule.due_at) > at) fail('REVIEW_NOT_DUE', 409);
  const runId = corpusNewId('corpus-run'),
    run = createCorpusRun(l.compiled, {
      runId,
      seed: corpusSeed(assignmentId),
      phase: schedule.kind as CorpusPhase,
      now: at,
    }),
    ack = {
      runId,
      assignmentId,
      scheduleId: String(schedule.id),
      lessonVersion: String(assignment.lesson_version),
      revision: 0 as const,
    };
  const guard = `${status.guard} AND ${corpusAuthorityGuard(c, a, [p])} AND EXISTS(SELECT 1 FROM pilot_corpus_schedule WHERE id=${q(schedule.id)} AND assignment_id=${q(assignmentId)} AND due_at<=${at})`;
  assertCorpusAuthorityConfiguration(c, a);
  try {
    await corpusBatch(c, [
      corpusInsert(
        'pilot_corpus_run',
        {
          id: runId,
          assignment_id: assignmentId,
          schedule_id: schedule.id,
          child_id: c.user.id,
          installation_id: install,
          corpus_version: assignment.corpus_version,
          corpus_digest: assignment.corpus_digest,
          lesson_version: assignment.lesson_version,
          content_digest: assignment.content_digest,
          publication_id: assignment.publication_id,
          adapter_id: 'corpus-paired',
          adapter_version: 'corpus-paired-v1',
          phase: schedule.kind,
          seed: run.seed,
          start_request_id: body.requestId,
          start_request_json: json(request),
          start_request_digest: fingerprint,
          start_ack_json: json(ack),
          run_json: json(run),
          revision: 0,
          completed_at: null,
          created_at: at,
          updated_at: at,
          test_run_id: assignment.test_run_id,
        },
        guard,
      ),
      `INSERT INTO pilot_corpus_learning_audit(id,run_id,plan_id,actor_id,action,event_id,revision,created_at) VALUES(${q(corpusNewId('corpus-audit'))},CASE WHEN ${guard} AND EXISTS(SELECT 1 FROM pilot_corpus_run WHERE id=${q(runId)}) THEN ${q(runId)} ELSE NULL END,NULL,${q(c.user.id)},'run-start',NULL,0,${at})`,
    ]);
  } catch (error) {
    await finalCorpusScope(c, install, base.guard);
    const raced = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_run WHERE schedule_id=${q(schedule.id)}`,
    );
    if (raced) {
      if (raced.start_request_id === body.requestId)
        return startReplay(c, raced, fingerprint);
      return JSON.parse(String(raced.start_ack_json));
    }
    if (!(await availability(c, assignment)).available)
      fail('LESSON_UNAVAILABLE', 409);
    throw error;
  }
  await finalCorpusScope(c, install, base.guard);
  return ack;
}
async function eventPolicy(a: CorpusAuthority, p: CorpusPackageAuthority) {
  return inspectCorpusEventPolicy({
    soundReview: p.soundReview,
    authority: corpusAuthorityIdentity(a),
    authorityDigest: await corpusAuthorityDigest(a),
    packageEligibilityDigest: p.eligibilityDigest,
    reviewId: p.reviewId,
    proofId: p.proofId,
  });
}
export async function advanceCorpus(
  c: CorpusContext,
  runId: string,
  input: unknown,
) {
  await requireCorpusActor(c, 'child');
  const action = inspectCorpusAction(input),
    s = await snapshot(c, runId),
    install = await corpusInstallation(c);
  if (s.row.child_id !== c.user.id) fail('NOT_FOUND', 404);
  if (
    s.row.installation_id !== install ||
    s.row.test_run_id !== corpusNamespace(c)
  )
    fail('LESSON_UNAVAILABLE', 409);
  const fingerprint = await H(
      corpusRequest('action', c.user.id, install, runId, action),
    ),
    duplicate = s.ledger.find((e) => e.event_id === action.eventId);
  if (duplicate) {
    if (duplicate.request_digest !== fingerprint) fail('EVENT_CONFLICT', 409);
    await finalCorpusScope(c, install, s.base.guard);
    return {
      ack: JSON.parse(String(duplicate.result_json)).ack,
      replayed: true,
    };
  }
  if (action.expectedRevision !== s.run.revision) fail('STALE_REVISION', 409);
  const status = await availability(c, s.row);
  if (!status.available) fail('LESSON_UNAVAILABLE', 409);
  const a = status.a!,
    p = status.p!,
    policy = await eventPolicy(a, p),
    at = corpusNow(c);
  let result;
  try {
    result = applyCorpusAction(s.l.compiled, s.run, action, {
      now: at,
      soundReview: p.soundReview,
    });
  } catch (error) {
    const code = String((error as { code?: string }).code ?? 'INVALID_REQUEST');
    fail(code, code === 'INVALID_REQUEST' ? 400 : 409);
  }
  const eventId = corpusNewId('corpus-event'),
    guard = `${status.guard} AND ${corpusAuthorityGuard(c, a, [p])} AND EXISTS(SELECT 1 FROM pilot_corpus_run WHERE id=${q(runId)} AND revision=${s.run.revision})`;
  const statements = [
    corpusInsert(
      'pilot_corpus_event',
      {
        id: eventId,
        run_id: runId,
        event_id: action.eventId,
        sequence: result.event.sequence,
        expected_revision: s.run.revision,
        request_digest: fingerprint,
        action_json: json(action),
        result_json: json({ event: result.event, ack: result.ack, policy }),
        server_at: at,
      },
      guard,
    ),
    `UPDATE pilot_corpus_run SET run_json=${q(json(result.run))},revision=${result.run.revision},updated_at=${at},completed_at=${q(result.run.state.completedAt === null ? null : Date.parse(result.run.state.completedAt))} WHERE id=${q(runId)} AND revision=${s.run.revision} AND EXISTS(SELECT 1 FROM pilot_corpus_event WHERE id=${q(eventId)})`,
  ];
  if (
    s.run.state.phase === 'initial' &&
    s.run.state.completedAt === null &&
    result.run.state.completedAt !== null
  )
    for (const [kind, delay] of [
      ['review-24h', 86400000],
      ['review-7d', 604800000],
    ] as const)
      statements.push(
        corpusInsert('pilot_corpus_schedule', {
          id: corpusNewId('corpus-schedule'),
          assignment_id: s.row.assignment_id,
          child_id: c.user.id,
          installation_id: install,
          kind,
          due_at: at + delay,
          policy_version: 'r6-review-24h-7d-1',
          initial_run_id: runId,
          completion_event_id: eventId,
          initial_completed_at: at,
          created_at: at,
        }),
      );
  const final = `${status.guard} AND ${corpusActorGuard(c, 'child')} AND ${corpusInstallationGuard(install)} AND EXISTS(SELECT 1 FROM pilot_corpus_event WHERE id=${q(eventId)}) AND EXISTS(SELECT 1 FROM pilot_corpus_run WHERE id=${q(runId)} AND revision=${result.run.revision})`;
  statements.push(
    `INSERT INTO pilot_corpus_learning_audit(id,run_id,plan_id,actor_id,action,event_id,revision,created_at) VALUES(${q(corpusNewId('corpus-audit'))},${q(runId)},NULL,${q(c.user.id)},'run-action',CASE WHEN ${final} THEN ${q(eventId)} ELSE NULL END,${result.run.revision},${at})`,
  );
  assertCorpusAuthorityConfiguration(c, a);
  try {
    await corpusBatch(c, statements);
  } catch (error) {
    await finalCorpusScope(c, install, s.base.guard);
    const retry = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_event WHERE run_id=${q(runId)} AND event_id=${q(action.eventId)}`,
    );
    if (retry) {
      if (retry.request_digest !== fingerprint) fail('EVENT_CONFLICT', 409);
      return { ack: JSON.parse(String(retry.result_json)).ack, replayed: true };
    }
    const current = await corpusOne(
      c,
      `SELECT revision FROM pilot_corpus_run WHERE id=${q(runId)}`,
    );
    if (current?.revision !== s.run.revision) fail('STALE_REVISION', 409);
    if (!(await availability(c, s.row)).available)
      fail('LESSON_UNAVAILABLE', 409);
    throw error;
  }
  await finalCorpusScope(c, install, s.base.guard);
  return { ack: result.ack, replayed: false };
}

export async function corpusPlacement(
  c: CorpusContext,
  childId: string,
  version: string,
) {
  const base = await familyScope(c, childId);
  await registeredCorpus(c, version);
  const setup = await corpusOne(
      c,
      `SELECT 1 AS ok FROM pilot_onboarding WHERE child_id=${q(childId)}`,
    ),
    row = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_proposal WHERE child_id=${q(childId)} AND installation_id=${q(base.installationId)} AND corpus_version=${q(version)} AND test_run_id IS ${q(corpusNamespace(c))} ORDER BY selection_ordinal DESC LIMIT 1`,
    );
  const proposal = row ? await proposalDisplay(c, row) : null;
  await finalCorpusScope(c, base.installationId, base.guard);
  return {
    setupComplete: !!setup,
    proposal,
    reason: setup ? null : 'Finish saved setup before choosing a story.',
  };
}
export async function corpusPlans(
  c: CorpusContext,
  childId: string,
  version: string,
) {
  const base = await familyScope(c, childId);
  await registeredCorpus(c, version);
  const rows = await corpusRows(
      c,
      `SELECT p.*,s.selection_ordinal FROM pilot_corpus_plan p JOIN pilot_corpus_proposal s ON s.id=p.proposal_id WHERE p.child_id=${q(childId)} AND p.corpus_version=${q(version)} ORDER BY CASE WHEN p.installation_id=${q(base.installationId)} AND p.test_run_id IS ${q(corpusNamespace(c))} THEN 1 ELSE 0 END,p.installation_id,p.test_run_id,s.selection_ordinal`,
    ),
    history = await Promise.all(rows.map((row) => planDisplay(c, row))),
    current = rows
      .filter(
        (row) =>
          row.installation_id === base.installationId &&
          row.test_run_id === corpusNamespace(c),
      )
      .at(-1),
    plan = current ? history[rows.indexOf(current)] : null;
  const live: Array<{
    a: CorpusAuthority;
    p: CorpusPackageAuthority;
    guard: string;
  }> = [];
  for (const [i, projection] of history.entries())
    if (projection.available) {
      const item = projection.items[0],
        status = await availability(c, {
          ...rows[i],
          publication_id: item.releaseId,
          lesson_version: item.lessonVersion,
          content_digest: item.contentDigest,
        });
      if (!status.available) fail('LESSON_UNAVAILABLE', 409);
      live.push({ a: status.a!, p: status.p!, guard: status.guard });
    }
  await finalLearningRead(c, base, live);
  return { plan, history };
}
export async function corpusPractice(
  c: CorpusContext,
  childId: string,
  version: string,
) {
  const base = await familyScope(c, childId),
    corpus = await registeredCorpus(c, version),
    items = [],
    current: Array<{
      a: CorpusAuthority;
      p: CorpusPackageAuthority;
      guard: string;
    }> = [];
  for (const row of await corpusRows(
    c,
    `SELECT s.*,a.corpus_version,a.corpus_digest,a.lesson_version,a.content_digest,a.publication_id,a.test_run_id,a.installation_id,p.lesson_id,i.title,i.display_json,r.id AS run_id,r.run_json,r.completed_at,pub.revision AS release_revision FROM pilot_corpus_schedule s JOIN pilot_corpus_assignment a ON a.id=s.assignment_id JOIN pilot_curriculum_package p ON p.lesson_version=a.lesson_version JOIN pilot_corpus_item i ON i.corpus_version=a.corpus_version AND i.lesson_version=a.lesson_version JOIN pilot_corpus_publication pub ON pub.id=a.publication_id LEFT JOIN pilot_corpus_run r ON r.schedule_id=s.id WHERE s.child_id=${q(childId)} AND a.corpus_version=${q(version)} ORDER BY s.due_at,s.id`,
  )) {
    if (row.completed_at !== null) continue;
    const status = await availability(c, { ...row, child_id: childId }),
      due = Number(row.due_at) <= corpusNow(c),
      run = row.run_json ? JSON.parse(String(row.run_json)) : null;
    if (status.available && due)
      current.push({ a: status.a!, p: status.p!, guard: status.guard });
    items.push({
      corpusId: String(corpus.corpus_id),
      corpusVersion: version,
      corpusDigest: String(corpus.corpus_digest),
      lessonId: String(row.lesson_id),
      lessonVersion: String(row.lesson_version),
      contentDigest: String(row.content_digest),
      adapterId: 'corpus-paired' as const,
      adapterVersion: 'corpus-paired-v1' as const,
      title: String(row.title),
      targets: JSON.parse(String(row.display_json)).targets,
      installationId: String(row.installation_id),
      assignmentId: String(row.assignment_id),
      scheduleId: String(row.id),
      runId: row.run_id === null ? null : String(row.run_id),
      releaseId: String(row.publication_id),
      releaseRevision: Number(row.release_revision),
      kind: row.kind as CorpusPhase,
      dueAt: corpusISO(row.due_at),
      available: status.available && due,
      reason: !status.available
        ? 'This story is unavailable.'
        : due
          ? null
          : 'Review is not due yet.',
      stepId: run?.state.stepId ?? null,
    });
  }
  const incomplete = items.filter(
      (i) => i.available && i.installationId === base.installationId && i.runId,
    ),
    due = items.filter(
      (i) =>
        i.available &&
        i.installationId === base.installationId &&
        i.kind !== 'initial',
    ),
    next = items.filter(
      (i) =>
        i.available &&
        i.installationId === base.installationId &&
        i.kind === 'initial' &&
        !i.runId,
    ),
    selected = incomplete[0] ?? due[0] ?? next[0];
  await finalLearningRead(c, base, current);
  return {
    items,
    primary: selected
      ? {
          kind: incomplete.includes(selected)
            ? ('continue' as const)
            : selected.kind === 'initial'
              ? ('next' as const)
              : ('review' as const),
          assignmentId: selected.assignmentId,
          scheduleId: selected.scheduleId,
          runId: selected.runId,
        }
      : {
          kind: 'prepare' as const,
          assignmentId: null,
          scheduleId: null,
          runId: null,
        },
  };
}
export async function corpusProgress(c: CorpusContext, childId: string) {
  const base = await familyScope(c, childId);
  if (
    !(await corpusOne(
      c,
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pilot_corpus_plan'",
    ))
  )
    return [];
  const result = [];
  for (const origin of await corpusRows(
    c,
    `SELECT DISTINCT corpus_version,installation_id FROM pilot_corpus_plan WHERE child_id=${q(childId)} ORDER BY corpus_version,installation_id`,
  )) {
    const version = String(origin.corpus_version),
      install = String(origin.installation_id),
      corpus = await registeredCorpus(c, version),
      plans = await corpusPlans(c, childId, version),
      practice = await corpusPractice(c, childId, version),
      visits = [];
    for (const row of await corpusRows(
      c,
      `SELECT s.*,a.lesson_version,a.content_digest,a.publication_id,p.lesson_id,i.title,i.display_json,r.id AS run_id FROM pilot_corpus_schedule s JOIN pilot_corpus_assignment a ON a.id=s.assignment_id JOIN pilot_curriculum_package p ON p.lesson_version=a.lesson_version JOIN pilot_corpus_item i ON i.corpus_version=a.corpus_version AND i.lesson_version=a.lesson_version LEFT JOIN pilot_corpus_run r ON r.schedule_id=s.id WHERE s.child_id=${q(childId)} AND a.corpus_version=${q(version)} AND a.installation_id=${q(install)} ORDER BY s.due_at,s.id`,
    )) {
      const run = row.run_id ? await getCorpusRun(c, String(row.run_id)) : null;
      visits.push({
        corpusId: String(corpus.corpus_id),
        corpusVersion: version,
        corpusDigest: String(corpus.corpus_digest),
        lessonId: String(row.lesson_id),
        lessonVersion: String(row.lesson_version),
        contentDigest: String(row.content_digest),
        adapterId: 'corpus-paired' as const,
        adapterVersion: 'corpus-paired-v1' as const,
        title: String(row.title),
        targets: JSON.parse(String(row.display_json)).targets,
        installationId: install,
        assignmentId: String(row.assignment_id),
        scheduleId: String(row.id),
        runId: run?.runId ?? null,
        releaseId: String(row.publication_id),
        phase: row.kind as CorpusPhase,
        dueAt: corpusISO(row.due_at),
        completedAt: run?.state.completedAt ?? null,
        introducedTargets:
          run?.state.phase === 'initial' && run.state.targetRoutes
            ? run.state.targetRoutes.map((t) => t.characterId)
            : [],
        recap: run?.recap ?? null,
      });
    }
    result.push({
      corpusId: String(corpus.corpus_id),
      corpusVersion: version,
      corpusDigest: String(corpus.corpus_digest),
      schemaVersion: 'r6-family-progress-1' as const,
      installationId: install,
      childId,
      plans: plans.history.filter((p) => p.installationId === install),
      practice: practice.items.filter((p) => p.installationId === install),
      visits,
      evidenceLimits: [
        'Saved responses do not establish mastery or fluency.',
        'Missing visits provide no evidence.',
        'Synthetic verification is not actual child evidence or human acceptance.',
      ],
    });
  }
  const live: Array<{
    a: CorpusAuthority;
    p: CorpusPackageAuthority;
    guard: string;
  }> = [];
  for (const group of result) {
    const entries = group.practice
      .filter((item) => item.available)
      .map((item) => ({
        installationId: item.installationId,
        releaseId: item.releaseId,
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
      }));
    for (const plan of group.plans.filter((plan) => plan.available))
      for (const item of plan.items)
        entries.push({
          installationId: plan.installationId,
          releaseId: item.releaseId!,
          lessonVersion: item.lessonVersion,
          contentDigest: item.contentDigest,
        });
    for (const item of entries) {
      const status = await availability(c, {
        child_id: childId,
        corpus_version: group.corpusVersion,
        installation_id: item.installationId,
        publication_id: item.releaseId,
        lesson_version: item.lessonVersion,
        content_digest: item.contentDigest,
        test_run_id: corpusNamespace(c),
      });
      if (!status.available) fail('LESSON_UNAVAILABLE', 409);
      live.push({ a: status.a!, p: status.p!, guard: status.guard });
    }
  }
  await finalLearningRead(c, base, live);
  return result;
}
export async function isCorpusResource(
  c: Pick<CorpusContext, 'db'>,
  kind: 'proposal' | 'assignment' | 'run',
  id: string,
) {
  if (!corpusId(id)) return false;
  const table = 'pilot_corpus_' + kind;
  if (
    !(await c.db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=${q(table)}`,
      )
      .first())
  )
    return false;
  return !!(await c.db
    .prepare(`SELECT 1 AS ok FROM ${table} WHERE id=${q(id)}`)
    .first());
}

/** Bind R6 only when a stored or explicit R6 request selected it. */
export function corpusLearningContext(
  c: Pick<CorpusContext, 'db' | 'config' | 'user' | 'session'>,
): CorpusContext {
  if ('corpus' in c) return c as CorpusContext;
  fail('STORAGE_UNAVAILABLE', 503);
}
export async function corpusProgressForSession(
  c: Pick<CorpusContext, 'db' | 'config' | 'user' | 'session'>,
  childId: string,
) {
  if (
    !(await c.db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pilot_corpus_plan'",
      )
      .first()) ||
    !(await c.db
      .prepare('SELECT 1 AS ok FROM pilot_corpus_plan WHERE child_id=? LIMIT 1')
      .bind(childId)
      .first())
  )
    return [];
  if ('corpus' in c) return corpusProgress(c as CorpusContext, childId);
  const { pilotBindings } = await import('./runtime.ts');
  return corpusProgress(
    {
      ...c,
      corpus: parseCorpusBindings(
        pilotBindings() as unknown as Record<string, unknown>,
      ),
    },
    childId,
  );
}
