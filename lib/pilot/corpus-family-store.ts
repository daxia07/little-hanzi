/** R6 family-only catalog/parent selection. Shared dispatch is a later slice. */
import type { CorpusContext } from './corpus-db.ts';
import type {
  CorpusCatalogItem,
  CorpusCatalogResponse,
} from '../curriculum/corpus-types.ts';
import {
  corpusId,
  normalizeCorpusSearch,
  corpusRequest,
} from './corpus-policy.ts';
import {
  corpusOne,
  corpusRows,
  corpusInstallation,
  requireCorpusActor,
  corpusNow,
  corpusBatch,
  corpusInsert,
  corpusNewId,
  corpusISO,
  corpusNamespace,
  sqlValue as q,
} from './corpus-db.ts';
import { fail } from './story-policy.ts';
import { registeredCorpus } from './corpus-store.ts';
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import {
  readCurrentCorpusAuthority,
  readCorpusPackageAuthority,
  requireCorpusFamilyScope,
  corpusEligiblePackageGuard,
  corpusAuthorityGuard,
  corpusMemberGuard,
  finalCorpusScope,
  corpusAuthorityIdentity,
  corpusAuthorityDigest,
  assertCorpusAuthorityConfiguration,
  type CorpusAuthority,
  type CorpusPackageAuthority,
} from './corpus-authority.ts';
import {
  issueCorpusCursor,
  readCorpusCursor,
  type CorpusCursorBinding,
} from './corpus-cursor.ts';
import {
  inspectCorpusProposalInput,
  inspectCorpusApprovalInput,
  inspectCorpusPlacementSource,
  corpusPrefixUpperBound,
} from './corpus-family-policy.ts';

/** Base link permission also applies before any release exists and to historical receipts. */
export async function familyScope(
  c: CorpusContext,
  childId: string,
  parentOnly = false,
) {
  if (!corpusId(childId)) fail('INVALID_REQUEST', 400);
  if (
    parentOnly
      ? c.user.role !== 'parent'
      : !['parent', 'child', 'teacher'].includes(c.user.role)
  )
    fail('FORBIDDEN', 403);
  await requireCorpusActor(c);
  const links = await corpusRows(
    c,
    `SELECT l.parent_id,l.child_id FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user u ON u.id=l.child_id WHERE l.child_id=${q(childId)} AND p.role='parent' AND p.disabled=0 AND p.must_change_password=0 AND u.role='child' AND u.disabled=0 AND u.must_change_password=0 ORDER BY l.parent_id`,
  );
  const permitted = [];
  for (const l of links) {
    if (
      (c.user.role === 'parent' && l.parent_id === c.user.id) ||
      (c.user.role === 'child' && childId === c.user.id) ||
      (c.user.role === 'teacher' &&
        (await corpusOne(
          c,
          `SELECT 1 AS ok FROM pilot_teacher_grant WHERE teacher_id=${q(c.user.id)} AND child_id=${q(childId)} AND granting_parent_id=${q(l.parent_id)}`,
        )))
    )
      permitted.push(l);
  }
  if (!permitted.length) fail('NOT_FOUND', 404);
  const guard =
    '(' +
    permitted
      .map(
        (l) =>
          `(${corpusMemberGuard(String(l.parent_id), childId)}${c.user.role === 'teacher' ? ` AND EXISTS(SELECT 1 FROM pilot_teacher_grant WHERE teacher_id=${q(c.user.id)} AND child_id=${q(childId)} AND granting_parent_id=${q(l.parent_id)})` : ''})`,
      )
      .join(' OR ') +
    ')';
  const installationId = await corpusInstallation(c);
  await finalCorpusScope(c, installationId, guard);
  return {
    guard,
    installationId,
    authRevision: await curriculumDigest({
      role: c.user.role,
      links: permitted,
    }),
  };
}
export async function readCorpusCatalog(
  c: CorpusContext,
  childId: string,
  version: string,
  paging: { q?: unknown; limit?: unknown; cursor?: unknown } = {},
): Promise<CorpusCatalogResponse> {
  if (!corpusId(version)) fail('INVALID_REQUEST', 400);
  const search = normalizeCorpusSearch(paging.q ?? '', paging.limit ?? 20);
  const base = await familyScope(c, childId),
    corpus = await registeredCorpus(c, version),
    authority = await readCurrentCorpusAuthority(c, version);
  const scope = authority
    ? await requireCorpusFamilyScope(c, authority, childId)
    : base;
  const binding: CorpusCursorBinding = {
    kind: 'catalog',
    actorId: c.user.id,
    sessionId: String(c.session.id),
    authRevision: scope.authRevision,
    installationId: base.installationId,
    resourceId: childId,
    corpusVersion: version,
    corpusDigest: String(corpus.corpus_digest),
    buildId: authority?.buildId ?? c.config.curriculumTrust?.buildId ?? '',
    releaseRevision: authority?.releaseRevision ?? 0,
    evidenceEpoch: authority?.evidenceEpoch ?? 0,
    q: search.q,
    limit: search.limit,
  };
  let last: string[] | null = null;
  if (paging.cursor !== undefined) {
    const cursor = await readCorpusCursor(
      c.config.secret ?? '',
      paging.cursor,
      binding,
      corpusNow(c),
    );
    last = cursor.last;
    if (
      last.length !== 3 ||
      !corpusId(last[0]) ||
      !corpusId(last[2]) ||
      !/^\d+$/u.test(last[1]) ||
      !Number.isSafeInteger(Number(last[1])) ||
      String(Number(last[1])) !== last[1]
    )
      fail('CURSOR_INVALID', 400);
  }
  const result: CorpusCatalogResponse = {
    schemaVersion: 'r6-catalog-1',
    corpusVersion: version,
    corpusDigest: String(corpus.corpus_digest),
    releaseRevision: binding.releaseRevision,
    items: [],
    nextCursor: null,
  };
  if (!authority || authority.status !== 'released') {
    await finalCorpusScope(c, base.installationId, base.guard);
    return result;
  }
  const tokens = search.tokens.map((t) => {
    const upper = corpusPrefixUpperBound(t);
    return `EXISTS(SELECT 1 FROM pilot_corpus_search_term st WHERE st.corpus_version=item.corpus_version AND st.lesson_version=item.lesson_version AND st.term>=${q(t)}${upper === null ? '' : ` AND st.term<${q(upper)}`})`;
  });
  const assigned =
    c.user.role === 'parent'
      ? '1'
      : `EXISTS(SELECT 1 FROM pilot_corpus_assignment ass WHERE ass.child_id=${q(childId)} AND ass.installation_id=${q(base.installationId)} AND ass.corpus_version=item.corpus_version AND ass.lesson_version=item.lesson_version AND ass.content_digest=item.content_digest AND ass.publication_id=${q(authority.releaseId)})`;
  const after = last
    ? `(item.track_id,item.sequence,item.lesson_version)>(${q(last[0])},${q(Number(last[1]))},${q(last[2])})`
    : '1';
  const rows = await corpusRows(
    c,
    `SELECT item.* FROM pilot_corpus_item item WHERE item.corpus_version=${q(version)} AND ${corpusEligiblePackageGuard(c, authority, 'item')} AND ${assigned} AND ${after}${tokens.map((t) => ' AND ' + t).join('')} ORDER BY item.track_id,item.sequence,item.lesson_version LIMIT ${search.limit + 1}`,
  );
  const inspected = rows.slice(0, search.limit);
  for (const row of inspected) {
    const available = await readCorpusPackageAuthority(
      c,
      authority,
      String(row.lesson_version),
    );
    if (!available.available) continue;
    const display = JSON.parse(String(row.display_json)) as Pick<
      CorpusCatalogItem,
      'title' | 'targets' | 'words'
    >;
    result.items.push({
      lessonVersion: String(row.lesson_version),
      contentDigest: String(row.content_digest),
      adapterId: 'corpus-paired',
      adapterVersion: 'corpus-paired-v1',
      title: display.title,
      targets: display.targets,
      words: display.words,
      trackId: String(row.track_id),
      sequence: Number(row.sequence),
      releaseId: authority.releaseId,
      releaseRevision: authority.releaseRevision,
      available: true,
      reasonCode: null,
    });
  }
  if (rows.length > search.limit) {
    const row = inspected.at(-1)!;
    result.nextCursor = await issueCorpusCursor(
      c.config.secret ?? '',
      binding,
      [String(row.track_id), String(row.sequence), String(row.lesson_version)],
      corpusNow(c),
    );
  }
  await requireCorpusFamilyScope(c, authority, childId);
  await finalCorpusScope(
    c,
    base.installationId,
    `${scope.guard} AND ${corpusAuthorityGuard(c, authority)}`,
  );
  return result;
}

const reason = (chosen: boolean) =>
  chosen
    ? 'You chose this available story. Saved setup and responses do not establish mastery.'
    : 'This is the first available unfinished story. Familiarity checks will guide the introduction.';
const namespaceGuard = (c: CorpusContext, alias = 'r') =>
  `${alias}.test_run_id IS ${q(corpusNamespace(c))}`;
async function placementFacts(
  c: CorpusContext,
  childId: string,
  a: CorpusAuthority,
) {
  const onboarding = await corpusOne(
    c,
    `SELECT nickname,experience,audio_ready,updated_at,updated_by FROM pilot_onboarding WHERE child_id=${q(childId)}`,
  );
  if (!onboarding) fail('ONBOARDING_REQUIRED', 409);
  const evidence = {
    schemaVersion: 'r6-placement-evidence-1',
    childId,
    installationId: a.installationId,
    legacy: {},
    collection: {},
    corpus: {},
  };
  const predicates: string[] = [];
  for (const [kind, run, event] of [
    [
      'legacy',
      'pilot_curriculum_learning_run',
      'pilot_curriculum_learning_event',
    ],
    ['collection', 'pilot_collection_run', 'pilot_collection_event'],
    ['corpus', 'pilot_corpus_run', 'pilot_corpus_event'],
  ] as const) {
    const filter = `r.child_id=${q(childId)} AND r.installation_id=${q(a.installationId)} AND ${namespaceGuard(c)}${kind === 'corpus' ? ` AND r.corpus_version=${q(a.corpusVersion)}` : ''}`;
    const complete =
      kind === 'legacy'
        ? "json_extract(r.run_json,'$.state.completedAt') IS NOT NULL"
        : "r.phase='initial' AND r.completed_at IS NOT NULL";
    const queries = {
      runCount: `SELECT count(*) FROM ${run} r WHERE ${filter}`,
      eventCount: `SELECT count(*) FROM ${event} e JOIN ${run} r ON r.id=e.run_id WHERE ${filter}`,
      revisionTotal: `SELECT coalesce(sum(r.revision),0) FROM ${run} r WHERE ${filter}`,
      completedInitialCount: `SELECT count(*) FROM ${run} r WHERE ${filter} AND ${complete}`,
    };
    const counts: Record<string, number> = {};
    for (const [key, sql] of Object.entries(queries)) {
      const row = await corpusOne(c, `SELECT (${sql}) AS n`);
      const n = Number(row?.n);
      if (!Number.isSafeInteger(n) || n < 0) fail('STORAGE_UNAVAILABLE', 503);
      counts[key] = n;
      predicates.push(`(${sql})=${n}`);
    }
    evidence[kind] = counts;
  }
  predicates.push(
    `EXISTS(SELECT 1 FROM pilot_onboarding WHERE child_id=${q(childId)} AND ${Object.entries(
      onboarding,
    )
      .map(([k, v]) => `${k} IS ${q(v)}`)
      .join(' AND ')})`,
  );
  return {
    onboardingDigest: await curriculumDigest(onboarding),
    evidenceDigest: await curriculumDigest(evidence),
    guard: predicates.join(' AND '),
  };
}
async function proposalHead(
  c: CorpusContext,
  childId: string,
  a: CorpusAuthority,
) {
  return corpusOne(
    c,
    `SELECT * FROM pilot_corpus_proposal WHERE child_id=${q(childId)} AND installation_id=${q(a.installationId)} AND corpus_version=${q(a.corpusVersion)} AND test_run_id IS ${q(corpusNamespace(c))} ORDER BY selection_ordinal DESC LIMIT 1`,
  );
}
async function sourceFor(
  c: CorpusContext,
  childId: string,
  a: CorpusAuthority,
  p: CorpusPackageAuthority,
  selectionOrdinal: number,
  predecessorProposalId: string | null,
  predecessorSourceDigest: string | null,
  chosen: boolean,
  createdAt: number,
) {
  const facts = await placementFacts(c, childId, a);
  const source = {
    schemaVersion: 'r6-placement-source-1',
    policyVersion: 'r6-placement-1',
    actorId: c.user.id,
    childId,
    installationId: a.installationId,
    corpusVersion: a.corpusVersion,
    corpusDigest: a.corpusDigest,
    namespace: corpusNamespace(c),
    selectionOrdinal,
    predecessorProposalId,
    predecessorSourceDigest,
    selection: {
      lessonVersion: p.lessonVersion,
      contentDigest: p.contentDigest,
      releaseId: a.releaseId,
      releaseRevision: a.releaseRevision,
    },
    evidenceEpoch: a.evidenceEpoch,
    packageEligibilityDigest: p.eligibilityDigest,
    authority: corpusAuthorityIdentity(a),
    authorityDigest: await corpusAuthorityDigest(a),
    onboardingDigest: facts.onboardingDigest,
    evidenceDigest: facts.evidenceDigest,
    selectedByParent: chosen,
    reason: reason(chosen),
    createdAt,
  };
  await inspectCorpusPlacementSource(source);
  return { source, digest: await curriculumDigest(source), guard: facts.guard };
}
export async function proposalDisplay(
  c: CorpusContext,
  row: Record<string, string | number | null>,
) {
  const source = JSON.parse(String(row.source_json));
  const pkg = await corpusOne(
      c,
      `SELECT lesson_id FROM pilot_curriculum_package WHERE lesson_version=${q(source.selection.lessonVersion)} AND content_digest=${q(source.selection.contentDigest)}`,
    ),
    corpus = await registeredCorpus(c, String(row.corpus_version)),
    display = await corpusOne(
      c,
      `SELECT title,display_json FROM pilot_corpus_item WHERE corpus_version=${q(row.corpus_version)} AND lesson_version=${q(source.selection.lessonVersion)} AND content_digest=${q(source.selection.contentDigest)}`,
    );
  if (!pkg || !display) fail('STORAGE_UNAVAILABLE', 503);
  return {
    corpusId: String(corpus.corpus_id),
    corpusVersion: String(row.corpus_version),
    corpusDigest: String(row.corpus_digest),
    lessonId: String(pkg.lesson_id),
    ...source.selection,
    title: String(display.title),
    targets: JSON.parse(String(display.display_json)).targets,
    adapterId: 'corpus-paired' as const,
    adapterVersion: 'corpus-paired-v1' as const,
    proposalId: String(row.id),
    childId: String(row.child_id),
    installationId: String(row.installation_id),
    predecessorProposalId: row.predecessor_id as string | null,
    selectionOrdinal: Number(row.selection_ordinal),
    sourceDigest: String(row.source_digest),
    reason: source.reason,
    selectedByParent: source.selectedByParent,
    createdAt: corpusISO(row.created_at),
    expiresAt: corpusISO(row.expires_at),
  };
}
function unfinished(
  c: CorpusContext,
  childId: string,
  a: CorpusAuthority,
  alias = 'item',
) {
  return `NOT EXISTS(SELECT 1 FROM pilot_corpus_run r WHERE r.child_id=${q(childId)} AND r.installation_id=${q(a.installationId)} AND r.corpus_version=${q(a.corpusVersion)} AND r.lesson_version=${alias}.lesson_version AND r.content_digest=${alias}.content_digest AND ${namespaceGuard(c)} AND r.phase='initial' AND r.completed_at IS NOT NULL)`;
}
export async function proposeCorpus(
  c: CorpusContext,
  childId: string,
  input: unknown,
) {
  const base = await familyScope(c, childId, true),
    request = inspectCorpusProposalInput(input);
  await registeredCorpus(c, request.corpusVersion);
  const a = await readCurrentCorpusAuthority(c, request.corpusVersion);
  if (!a || a.status !== 'released') fail('PLACEMENT_UNAVAILABLE', 409);
  const scope = await requireCorpusFamilyScope(c, a, childId),
    head = await proposalHead(c, childId, a),
    at = corpusNow(c);
  const req = corpusRequest(
      'proposal',
      c.user.id,
      base.installationId,
      request.corpusVersion,
      request,
    ),
    requestDigest = await curriculumDigest(req);
  const old = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_proposal WHERE child_id=${q(childId)} AND installation_id=${q(a.installationId)} AND corpus_version=${q(a.corpusVersion)} AND parent_id=${q(c.user.id)} AND request_digest=${q(requestDigest)} ORDER BY selection_ordinal DESC LIMIT 1`,
  );
  if (old) {
    if (
      !head ||
      head.id !== old.id ||
      at >= Number(old.expires_at) ||
      canonicalPackage(req) !== String(old.request_json)
    )
      fail('PLACEMENT_STALE', 409);
    const prior = JSON.parse(String(old.source_json)),
      p = await readCorpusPackageAuthority(c, a, prior.selection.lessonVersion);
    const check = await sourceFor(
      c,
      childId,
      a,
      p,
      Number(old.selection_ordinal),
      old.predecessor_id as string | null,
      old.predecessor_source_digest as string | null,
      prior.selectedByParent,
      Number(old.created_at),
    );
    if (!p.available || check.digest !== old.source_digest)
      fail('PLACEMENT_STALE', 409);
    await finalCorpusScope(
      c,
      a.installationId,
      `${scope.guard} AND ${corpusAuthorityGuard(c, a, [p])} AND ${check.guard}`,
    );
    const proposal = await proposalDisplay(c, old);
    await finalCorpusScope(c, a.installationId, scope.guard);
    return { proposal };
  }
  if (
    (head?.id ?? null) !== request.predecessorProposalId ||
    (head?.source_digest ?? null) !== request.expectedSourceDigest
  )
    fail('PLACEMENT_STALE', 409);
  let selected: CorpusPackageAuthority | null = null;
  if (request.selection) {
    const sel = request.selection;
    if (
      sel.releaseId !== a.releaseId ||
      sel.releaseRevision !== a.releaseRevision
    )
      fail('PLACEMENT_STALE', 409);
    selected = await readCorpusPackageAuthority(c, a, sel.lessonVersion);
    if (
      !selected.available ||
      selected.contentDigest !== sel.contentDigest ||
      !(await corpusOne(
        c,
        `SELECT 1 AS ok FROM pilot_corpus_item item WHERE item.corpus_version=${q(a.corpusVersion)} AND item.lesson_version=${q(sel.lessonVersion)} AND ${unfinished(c, childId, a)}`,
      ))
    )
      fail('PLACEMENT_UNAVAILABLE', 409);
  } else {
    let last: [string, number, string] | null = null;
    while (!selected) {
      const after = last
        ? `(item.track_id,item.sequence,item.lesson_version)>(${q(last[0])},${q(last[1])},${q(last[2])})`
        : '1';
      const candidates = await corpusRows(
        c,
        `SELECT item.track_id,item.sequence,item.lesson_version FROM pilot_corpus_item item WHERE item.corpus_version=${q(a.corpusVersion)} AND ${corpusEligiblePackageGuard(c, a, 'item')} AND ${unfinished(c, childId, a)} AND ${after} ORDER BY item.track_id,item.sequence,item.lesson_version LIMIT 50`,
      );
      for (const candidate of candidates) {
        last = [
          String(candidate.track_id),
          Number(candidate.sequence),
          String(candidate.lesson_version),
        ];
        const p = await readCorpusPackageAuthority(c, a, last[2]);
        if (p.available) {
          selected = p;
          break;
        }
      }
      if (candidates.length < 50) break;
    }
  }
  if (!selected) fail('PLACEMENT_UNAVAILABLE', 409);
  const ordinal = Number(head?.selection_ordinal ?? 0) + 1;
  const facts = await sourceFor(
    c,
    childId,
    a,
    selected,
    ordinal,
    request.predecessorProposalId,
    request.expectedSourceDigest,
    request.selection !== null,
    at,
  );
  const id = corpusNewId('corpus-proposal'),
    chain = `(SELECT coalesce(max(selection_ordinal),0) FROM pilot_corpus_proposal WHERE child_id=${q(childId)} AND installation_id=${q(a.installationId)} AND corpus_version=${q(a.corpusVersion)} AND test_run_id IS ${q(corpusNamespace(c))})=${ordinal - 1}`;
  const guard = `${scope.guard} AND ${corpusAuthorityGuard(c, a, [selected])} AND ${facts.guard} AND ${chain}`;
  assertCorpusAuthorityConfiguration(c, a);
  await corpusBatch(c, [
    corpusInsert(
      'pilot_corpus_proposal',
      {
        id,
        child_id: childId,
        installation_id: a.installationId,
        corpus_version: a.corpusVersion,
        corpus_digest: a.corpusDigest,
        policy_version: 'r6-placement-1',
        parent_id: c.user.id,
        selection_ordinal: ordinal,
        predecessor_id: request.predecessorProposalId,
        predecessor_source_digest: request.expectedSourceDigest,
        source_json: canonicalPackage(facts.source),
        source_digest: facts.digest,
        request_json: canonicalPackage(req),
        request_digest: requestDigest,
        reason_json: canonicalPackage({
          schemaVersion: 'r6-placement-reason-1',
          text: facts.source.reason,
          selectedByParent: facts.source.selectedByParent,
        }),
        created_at: at,
        expires_at: at + 86400000,
        test_run_id: corpusNamespace(c),
      },
      guard,
    ),
  ]);
  const saved = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_proposal WHERE id=${q(id)}`,
  );
  if (!saved) fail('PLACEMENT_STALE', 409);
  const proposal = await proposalDisplay(c, saved);
  await finalCorpusScope(c, a.installationId, scope.guard);
  return { proposal };
}
export async function planDisplay(
  c: CorpusContext,
  row: Record<string, string | number | null>,
) {
  const corpus = await registeredCorpus(c, String(row.corpus_version)),
    source = await corpusOne(
      c,
      `SELECT source_json FROM pilot_corpus_proposal WHERE id=${q(row.proposal_id)}`,
    ),
    s = JSON.parse(String(source?.source_json)),
    a = await readCurrentCorpusAuthority(c, String(row.corpus_version));
  let available = false;
  if (a && a.status === 'released' && a.releaseId === s.selection.releaseId) {
    try {
      await requireCorpusFamilyScope(c, a, String(row.child_id));
      available = (
        await readCorpusPackageAuthority(c, a, s.selection.lessonVersion)
      ).available;
    } catch (error) {
      if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
    }
  }
  const items = await corpusRows(
    c,
    `SELECT i.*,ass.id AS assignment_id,p.lesson_id,it.title,it.display_json,it.track_id,it.sequence FROM pilot_corpus_plan_item i JOIN pilot_corpus_assignment ass ON ass.plan_item_id=i.id JOIN pilot_curriculum_package p ON p.lesson_version=i.lesson_version AND p.content_digest=i.content_digest JOIN pilot_corpus_item it ON it.corpus_version=i.corpus_version AND it.lesson_version=i.lesson_version WHERE i.plan_id=${q(row.id)} ORDER BY i.ordinal`,
  );
  return {
    corpusId: String(corpus.corpus_id),
    corpusVersion: String(row.corpus_version),
    corpusDigest: String(row.corpus_digest),
    planId: String(row.id),
    proposalId: String(row.proposal_id),
    childId: String(row.child_id),
    installationId: String(row.installation_id),
    approvedAt: corpusISO(row.approved_at),
    available,
    reason: available ? null : 'This story is unavailable.',
    items: items.map((i) => ({
      corpusId: String(corpus.corpus_id),
      corpusVersion: String(row.corpus_version),
      corpusDigest: String(row.corpus_digest),
      lessonId: String(i.lesson_id),
      lessonVersion: String(i.lesson_version),
      contentDigest: String(i.content_digest),
      adapterId: 'corpus-paired' as const,
      adapterVersion: 'corpus-paired-v1' as const,
      title: String(i.title),
      targets: JSON.parse(String(i.display_json)).targets,
      trackId: String(i.track_id),
      sequence: Number(i.sequence),
      releaseId: String(i.publication_id),
      releaseRevision: s.selection.releaseRevision,
      available,
      reason: available ? null : 'This story is unavailable.',
      assignmentId: String(i.assignment_id),
      completed: false,
      planItemId: String(i.id),
      ordinal: 0 as const,
    })),
  };
}
export async function approveCorpus(
  c: CorpusContext,
  childId: string,
  input: unknown,
) {
  const base = await familyScope(c, childId, true),
    request = inspectCorpusApprovalInput(input);
  const proposal = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_proposal WHERE id=${q(request.proposalId)} AND child_id=${q(childId)} AND installation_id=${q(base.installationId)} AND test_run_id IS ${q(corpusNamespace(c))}`,
  );
  if (!proposal) fail('NOT_FOUND', 404);
  const req = corpusRequest(
      'approval',
      c.user.id,
      base.installationId,
      request.proposalId,
      request,
    ),
    requestDigest = await curriculumDigest(req);
  const existing = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_plan WHERE proposal_id=${q(proposal.id)}`,
  );
  if (existing) {
    if (
      existing.parent_id !== c.user.id ||
      existing.source_digest !== request.sourceDigest ||
      existing.request_digest !== requestDigest ||
      existing.request_json !== canonicalPackage(req)
    )
      fail('PLACEMENT_STALE', 409);
    const plan = await planDisplay(c, existing);
    await finalCorpusScope(c, base.installationId, base.guard);
    return { plan };
  }
  const a = await readCurrentCorpusAuthority(
    c,
    String(proposal.corpus_version),
  );
  if (
    !a ||
    a.status !== 'released' ||
    proposal.source_digest !== request.sourceDigest ||
    proposal.parent_id !== c.user.id ||
    corpusNow(c) >= Number(proposal.expires_at)
  )
    fail('PLACEMENT_STALE', 409);
  const scope = await requireCorpusFamilyScope(c, a, childId),
    head = await proposalHead(c, childId, a);
  if (head?.id !== proposal.id) fail('PLACEMENT_STALE', 409);
  const source = JSON.parse(String(proposal.source_json)),
    selected = await readCorpusPackageAuthority(
      c,
      a,
      source.selection.lessonVersion,
    );
  const facts = await sourceFor(
    c,
    childId,
    a,
    selected,
    Number(proposal.selection_ordinal),
    proposal.predecessor_id as string | null,
    proposal.predecessor_source_digest as string | null,
    source.selectedByParent,
    Number(proposal.created_at),
  );
  if (!selected.available || facts.digest !== request.sourceDigest)
    fail('PLACEMENT_STALE', 409);
  const at = corpusNow(c),
    id = corpusNewId('corpus-plan'),
    itemId = corpusNewId('corpus-plan-item'),
    assignmentId = corpusNewId('corpus-assignment');
  const common = {
    child_id: childId,
    installation_id: a.installationId,
    corpus_version: a.corpusVersion,
    corpus_digest: a.corpusDigest,
  };
  const guard = `${scope.guard} AND ${corpusAuthorityGuard(c, a, [selected])} AND ${facts.guard} AND NOT EXISTS(SELECT 1 FROM pilot_corpus_proposal next WHERE next.predecessor_id=${q(proposal.id)}) AND EXISTS(SELECT 1 FROM pilot_corpus_proposal WHERE id=${q(proposal.id)} AND expires_at>${at})`;
  assertCorpusAuthorityConfiguration(c, a);
  await corpusBatch(c, [
    corpusInsert(
      'pilot_corpus_plan',
      {
        id,
        proposal_id: proposal.id,
        ...common,
        parent_id: c.user.id,
        policy_version: 'r6-placement-1',
        source_digest: request.sourceDigest,
        request_json: canonicalPackage(req),
        request_digest: requestDigest,
        ack_json: canonicalPackage({
          planId: id,
          proposalId: proposal.id,
          sourceDigest: request.sourceDigest,
          approvedAt: corpusISO(at),
        }),
        approved_at: at,
        test_run_id: corpusNamespace(c),
      },
      guard,
    ),
    corpusInsert('pilot_corpus_plan_item', {
      id: itemId,
      plan_id: id,
      ...common,
      ordinal: 0,
      publication_id: a.releaseId,
      lesson_version: selected.lessonVersion,
      content_digest: selected.contentDigest,
      reason_json: proposal.reason_json,
    }),
    corpusInsert('pilot_corpus_assignment', {
      id: assignmentId,
      plan_item_id: itemId,
      ...common,
      publication_id: a.releaseId,
      lesson_version: selected.lessonVersion,
      content_digest: selected.contentDigest,
      created_at: at,
      test_run_id: corpusNamespace(c),
    }),
    corpusInsert('pilot_corpus_schedule', {
      id: corpusNewId('corpus-schedule'),
      assignment_id: assignmentId,
      child_id: childId,
      installation_id: a.installationId,
      kind: 'initial',
      due_at: at,
      policy_version: 'r6-review-24h-7d-1',
      initial_run_id: null,
      completion_event_id: null,
      initial_completed_at: null,
      created_at: at,
    }),
    corpusInsert('pilot_corpus_learning_audit', {
      id: corpusNewId('corpus-audit'),
      run_id: null,
      plan_id: id,
      actor_id: c.user.id,
      action: 'plan-approval',
      event_id: null,
      revision: null,
      created_at: at,
    }),
  ]);
  const saved = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_plan WHERE id=${q(id)}`,
  );
  if (!saved) fail('STORAGE_UNAVAILABLE', 503);
  const plan = await planDisplay(c, saved);
  await finalCorpusScope(c, base.installationId, base.guard);
  return { plan };
}
