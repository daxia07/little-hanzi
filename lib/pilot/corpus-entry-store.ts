/** Current R6 role entry and bounded immutable operator readback. */
import type { CorpusContext, CorpusRow } from './corpus-db.ts';
import type {
  CorpusFamilyEntryResponse,
  CorpusOwnerEntryResponse,
  CorpusSafeDecision,
  CorpusSafePublication,
  CorpusSnapshotPackagesResponse,
  CorpusOwnerDecisionsResponse,
  CorpusBatchValidationResponse,
} from '../curriculum/corpus-entry-types.ts';
import {
  corpusRows,
  corpusOne,
  corpusInstallation,
  corpusNamespace,
  corpusNow,
  corpusISO,
  requireCorpusActor,
  sqlValue as q,
} from './corpus-db.ts';
import { corpusId } from './corpus-policy.ts';
import { fail } from './story-policy.ts';
import { parsePageLimit } from './corpus-coverage.ts';
import {
  registeredCorpus,
  loadCorpusPackage,
  inspectCorpusBatch,
} from './corpus-store.ts';
import { familyScope } from './corpus-family-store.ts';
import { corpusOwnerGuard } from './corpus-owner-store.ts';
import {
  canonicalPackage,
  curriculumDigest as H,
} from '../curriculum/digest.ts';
import { exact } from '../curriculum/story-package.ts';
import { inspectSnapshotPlan } from './corpus-snapshot-policy.ts';
import {
  issueCorpusCursor,
  readCorpusCursor,
  type CorpusCursorBinding,
} from './corpus-cursor.ts';
import {
  corpusAuthorityConfiguration,
  corpusEvidenceEpoch,
  readCurrentCorpusAuthority,
  readCorpusPackageAuthority,
  requireCorpusFamilyScope,
  corpusEligiblePackageGuard,
  corpusAuthorityGuard,
  assertCorpusAuthorityConfiguration,
  finalCorpusScope,
} from './corpus-authority.ts';

type Page = { limit?: unknown; cursor?: unknown };
async function scope(c: CorpusContext, role?: string) {
  await requireCorpusActor(c, role);
  return {
    installation: await corpusInstallation(c),
    configuration: corpusAuthorityConfiguration(c),
    epoch: await corpusEvidenceEpoch(c),
  };
}
async function post(
  c: CorpusContext,
  s: Awaited<ReturnType<typeof scope>>,
  guard = '1',
) {
  if (corpusAuthorityConfiguration(c) !== s.configuration) fail('CURSOR_STALE');
  await finalCorpusScope(
    c,
    s.installation,
    `${guard} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${s.epoch})`,
  );
}
async function fingerprint(c: CorpusContext, sql: string) {
  return H(await corpusRows(c, sql));
}
async function pageBinding(
  c: CorpusContext,
  s: Awaited<ReturnType<typeof scope>>,
  kind: CorpusCursorBinding['kind'],
  resourceId: string,
  version: string,
  revision: string,
  limit: number,
): Promise<CorpusCursorBinding> {
  return {
    kind,
    actorId: c.user.id,
    sessionId: String(c.session.id),
    authRevision: await H({ configuration: s.configuration, revision }),
    installationId: s.installation,
    resourceId,
    corpusVersion: version,
    corpusDigest: '',
    buildId: c.config.curriculumTrust?.buildId ?? '',
    releaseRevision: 0,
    evidenceEpoch: s.epoch,
    q: '',
    limit,
  };
}
async function last(c: CorpusContext, input: Page, b: CorpusCursorBinding) {
  return input.cursor === undefined
    ? []
    : (
        await readCorpusCursor(
          c.config.secret ?? '',
          input.cursor,
          b,
          corpusNow(c),
        )
      ).last;
}
async function cursor(
  c: CorpusContext,
  b: CorpusCursorBinding,
  tuple: string[],
) {
  return issueCorpusCursor(c.config.secret ?? '', b, tuple, corpusNow(c));
}
function id(value: string) {
  if (!corpusId(value)) fail('INVALID_REQUEST', 400);
}
function decision(row: CorpusRow): CorpusSafeDecision {
  return {
    receipt: JSON.parse(String(row.ack_json)),
    snapshotId: String(row.snapshot_id),
    scope: JSON.parse(String(row.scope_json)),
    decision: row.decision as 'accepted' | 'rejected',
  };
}
function publication(row: CorpusRow): CorpusSafePublication {
  const raw = JSON.parse(String(row.scope_json));
  return {
    receipt: JSON.parse(String(row.ack_json)),
    snapshotId: String(row.snapshot_id),
    ownerDecisionId: row.owner_decision_id as string | null,
    scope:
      raw.kind === 'verification'
        ? { kind: 'verification', members: raw.members }
        : raw,
    status: row.status as 'released' | 'withdrawn',
    predecessorPublicationId: row.predecessor_id as string | null,
  };
}
export async function readCorpusPublication(
  c: CorpusContext,
  version: string,
  recordId: string,
) {
  id(recordId);
  const s = await scope(c, 'operator');
  await registeredCorpus(c, version);
  const row = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_publication WHERE id=${q(recordId)} AND corpus_version=${q(version)} AND installation_id=${q(s.installation)} AND test_run_id IS ${q(corpusNamespace(c))}`,
  );
  if (!row) fail('NOT_FOUND', 404);
  const result = publication(row);
  await post(c, s);
  return result;
}
export async function readCorpusPublicationHead(
  c: CorpusContext,
  version: string,
) {
  const s = await scope(c, 'operator');
  await registeredCorpus(c, version);
  const row = await corpusOne(
    c,
    `SELECT p.* FROM pilot_corpus_publication_state h JOIN pilot_corpus_publication p ON p.id=h.latest_publication_id WHERE h.corpus_version=${q(version)} AND h.installation_id=${q(s.installation)} AND h.namespace_key=${q(corpusNamespace(c) ?? 'ordinary')}`,
  );
  const result = { publication: row ? publication(row) : null };
  await post(c, s);
  return result;
}
async function decisionAccess(c: CorpusContext) {
  if (!['operator', 'parent'].includes(c.user.role)) fail('FORBIDDEN', 403);
  const s = await scope(c);
  if (c.user.role === 'parent' && !c.corpus.ownerIds.includes(c.user.id))
    fail('FORBIDDEN', 403);
  return s;
}
export async function readCorpusDecision(
  c: CorpusContext,
  version: string,
  recordId: string,
) {
  id(recordId);
  const s = await decisionAccess(c);
  await registeredCorpus(c, version);
  const row = await corpusOne(
    c,
    `SELECT d.* FROM pilot_corpus_owner_decision d JOIN pilot_corpus_snapshot p ON p.id=d.snapshot_id WHERE d.id=${q(recordId)} AND p.corpus_version=${q(version)} AND d.installation_id=${q(s.installation)} AND d.test_run_id IS NULL ${c.user.role === 'parent' ? `AND d.actor_id=${q(c.user.id)}` : ''}`,
  );
  if (!row) fail('NOT_FOUND', 404);
  const result = decision(row);
  await post(c, s, c.user.role === 'parent' ? corpusOwnerGuard(c) : '1');
  return result;
}
export async function readCorpusOwnerDecisions(
  c: CorpusContext,
  version: string,
  snapshotId: string,
  input: Page = {},
): Promise<CorpusOwnerDecisionsResponse> {
  id(snapshotId);
  const s = await decisionAccess(c);
  await registeredCorpus(c, version);
  if (
    !(await corpusOne(
      c,
      `SELECT 1 AS ok FROM pilot_corpus_snapshot WHERE id=${q(snapshotId)} AND corpus_version=${q(version)} AND installation_id=${q(s.installation)} AND test_run_id IS NULL`,
    ))
  )
    fail('NOT_FOUND', 404);
  const sql = `SELECT d.id,d.decided_at FROM pilot_corpus_owner_decision d JOIN pilot_corpus_snapshot p ON p.id=d.snapshot_id WHERE d.snapshot_id=${q(snapshotId)} AND p.corpus_version=${q(version)} AND d.installation_id=${q(s.installation)} AND d.test_run_id IS NULL ${c.user.role === 'parent' ? `AND d.actor_id=${q(c.user.id)}` : ''} ORDER BY d.decided_at DESC,d.id DESC`,
    rev = await fingerprint(c, sql),
    limit = input.limit === undefined ? 20 : parsePageLimit(input.limit),
    b = await pageBinding(
      c,
      s,
      'owner-decisions',
      snapshotId,
      version,
      rev,
      limit,
    ),
    previous = await last(c, input, b);
  if (
    previous.length &&
    (previous.length !== 2 ||
      !/^\d+$/u.test(previous[0]) ||
      !corpusId(previous[1]))
  )
    fail('CURSOR_INVALID', 400);
  const rows = await corpusRows(
      c,
      `SELECT d.* FROM pilot_corpus_owner_decision d JOIN pilot_corpus_snapshot p ON p.id=d.snapshot_id WHERE d.snapshot_id=${q(snapshotId)} AND p.corpus_version=${q(version)} AND d.installation_id=${q(s.installation)} AND d.test_run_id IS NULL ${c.user.role === 'parent' ? `AND d.actor_id=${q(c.user.id)}` : ''} ${previous.length ? `AND (d.decided_at,d.id)<(${q(Number(previous[0]))},${q(previous[1])})` : ''} ORDER BY d.decided_at DESC,d.id DESC LIMIT ${limit + 1}`,
    ),
    page = rows.slice(0, limit),
    end = page.at(-1),
    result = {
      schemaVersion: 'r6-owner-decisions-1' as const,
      snapshotId,
      items: page.map(decision),
      nextCursor:
        rows.length > limit && end
          ? await cursor(c, b, [String(end.decided_at), String(end.id)])
          : null,
    };
  if (rev !== (await fingerprint(c, sql))) fail('CURSOR_STALE');
  await post(c, s, c.user.role === 'parent' ? corpusOwnerGuard(c) : '1');
  return result;
}
export async function readCorpusBatch(
  c: CorpusContext,
  version: string,
  batchId: string,
) {
  id(version);
  id(batchId);
  const s = await scope(c, 'operator'),
    row = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_batch WHERE id=${q(batchId)} AND installation_id=${q(s.installation)} AND test_run_id IS ${q(corpusNamespace(c))} AND json_extract(request_json,'$.resourceId')=${q(version)}`,
    );
  if (!row) fail('NOT_FOUND', 404);
  const result = JSON.parse(String(row.result_json));
  await post(c, s);
  return result;
}
export async function validateCorpusBatch(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusBatchValidationResponse> {
  id(version);
  const s = await scope(c, 'operator');
  if (!exact(input, ['batch'])) fail('INVALID_REQUEST', 400);
  const batch = inspectCorpusBatch(input.batch),
    items: CorpusBatchValidationResponse['items'] = [];
  for (const item of batch.items) {
    const errors: Array<{ fieldId: string; code: string }> = [];
    try {
      const pkg = await loadCorpusPackage(c, item.lessonVersion);
      if (pkg.row.content_digest !== item.contentDigest)
        errors.push({ fieldId: 'contentDigest', code: 'BATCH_BINDING' });
      if (
        canonicalPackage(item.characters) !==
        canonicalPackage(
          (
            pkg.document.characters as Array<{
              characterId: string;
              hanzi: string;
            }>
          ).map((t) => ({
            characterId: t.characterId,
            coverageIdentity: t.hanzi,
          })),
        )
      )
        errors.push({ fieldId: 'characters', code: 'BATCH_BINDING' });
      if (
        canonicalPackage(pkg.document.placement) !==
        canonicalPackage({ trackId: item.trackId, sequence: item.sequence })
      )
        errors.push({ fieldId: 'placement', code: 'BATCH_BINDING' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'NOT_FOUND') throw e;
      errors.push({ fieldId: 'lessonVersion', code: 'NOT_FOUND' });
    }
    items.push({
      lessonVersion: item.lessonVersion,
      contentDigest: item.contentDigest,
      state: errors.length ? 'rejected' : 'accepted',
      errors,
    });
  }
  const result = {
    schemaVersion: 'r6-batch-validation-1' as const,
    batchId: batch.batchId,
    batchVersion: batch.batchVersion,
    manifestDigest: await H(batch),
    checkedAt: corpusISO(corpusNow(c)),
    items,
  };
  await post(c, s);
  return result;
}
export async function readCorpusSnapshotPackages(
  c: CorpusContext,
  version: string,
  snapshotId: string,
  input: Page = {},
): Promise<CorpusSnapshotPackagesResponse> {
  id(snapshotId);
  const s = await scope(c, 'operator');
  await registeredCorpus(c, version);
  const row = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus_snapshot WHERE id=${q(snapshotId)} AND corpus_version=${q(version)} AND installation_id=${q(s.installation)} AND test_run_id IS ${q(corpusNamespace(c))}`,
  );
  if (!row) fail('NOT_FOUND', 404);
  const plan = await inspectSnapshotPlan(JSON.parse(String(row.plan_json))),
    sql = `SELECT lesson_version,chunk_digest,chunk_request_id FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(snapshotId)} ORDER BY member_ordinal`,
    rev = await fingerprint(c, sql),
    limit = input.limit === undefined ? 20 : parsePageLimit(input.limit),
    b = await pageBinding(
      c,
      s,
      'snapshot-packages',
      snapshotId,
      version,
      await H({ planDigest: row.plan_digest, rev }),
      limit,
    ),
    previous = await last(c, input, b);
  if (previous.length && (previous.length !== 1 || !/^\d+$/u.test(previous[0])))
    fail('CURSOR_INVALID', 400);
  const start = previous.length ? Number(previous[0]) + 1 : 0,
    selected = plan.packages.slice(start, start + limit),
    chunked = new Set((await corpusRows(c, sql)).map((r) => r.lesson_version)),
    items = [];
  for (const p of selected) {
    const display = await corpusOne(
      c,
      `SELECT display_json FROM pilot_corpus_item WHERE corpus_version=${q(version)} AND lesson_version=${q(p.lessonVersion)} AND content_digest=${q(p.contentDigest)}`,
    );
    if (!display) fail('STORAGE_UNAVAILABLE', 503);
    const d = JSON.parse(String(display.display_json));
    items.push({
      lessonVersion: p.lessonVersion,
      contentDigest: p.contentDigest,
      title: d.title,
      targets: d.targets,
      chunked: chunked.has(p.lessonVersion),
    });
  }
  const result = {
    schemaVersion: 'r6-snapshot-packages-1' as const,
    snapshotId,
    items,
    nextCursor:
      start + items.length < plan.packages.length
        ? await cursor(c, b, [String(start + items.length - 1)])
        : null,
  };
  if (rev !== (await fingerprint(c, sql))) fail('CURSOR_STALE');
  await post(c, s);
  return result;
}
export async function discoverCorpusOwner(
  c: CorpusContext,
  input: Page = {},
): Promise<CorpusOwnerEntryResponse> {
  if (!['parent', 'operator'].includes(c.user.role)) fail('FORBIDDEN', 403);
  const s = await scope(c),
    allowed = c.corpus.ownerIds.includes(c.user.id),
    limit = input.limit === undefined ? 20 : parsePageLimit(input.limit);
  const result: CorpusOwnerEntryResponse = {
    schemaVersion: 'r6-owner-entry-1',
    installationId: s.installation,
    allowed,
    items: [],
    nextCursor: null,
  };
  const trust = c.config.curriculumTrust;
  if (!allowed || !trust || trust.candidateId !== c.config.candidateId) {
    await post(c, s);
    return result;
  }
  const filter = `s.installation_id=${q(s.installation)} AND s.test_run_id IS NULL AND s.status='sealed' AND s.candidate_id=${q(trust.candidateId)} AND s.source_digest=${q(trust.sourceDigest)} AND s.artifact_digest=${q(trust.artifactDigest)} AND json_extract(s.plan_json,'$.buildId')=${q(trust.buildId)} AND s.evidence_epoch=${s.epoch}`,
    sql = `SELECT s.id,s.sealed_at FROM pilot_corpus_snapshot s WHERE ${filter} ORDER BY s.sealed_at DESC,s.id DESC`,
    rev = await fingerprint(c, sql),
    b = await pageBinding(c, s, 'owner-entry', 'owner-entry', '', rev, limit),
    previous = await last(c, input, b);
  if (
    previous.length &&
    (previous.length !== 2 ||
      !/^\d+$/u.test(previous[0]) ||
      !corpusId(previous[1]))
  )
    fail('CURSOR_INVALID', 400);
  const rows = await corpusRows(
      c,
      `SELECT s.*,r.corpus_id FROM pilot_corpus_snapshot s JOIN pilot_corpus r ON r.corpus_version=s.corpus_version WHERE ${filter} ${previous.length ? `AND (s.sealed_at,s.id)<(${q(Number(previous[0]))},${q(previous[1])})` : ''} ORDER BY s.sealed_at DESC,s.id DESC LIMIT ${limit + 1}`,
    ),
    page = rows.slice(0, limit),
    end = page.at(-1);
  result.items = page.map((r) => ({
    corpusId: String(r.corpus_id),
    corpusVersion: String(r.corpus_version),
    corpusDigest: String(r.corpus_digest),
    snapshotId: String(r.id),
    planDigest: String(r.plan_digest),
    candidateId: String(r.candidate_id),
    buildId: trust.buildId,
    createdAt: corpusISO(r.created_at),
  }));
  result.nextCursor =
    rows.length > limit && end
      ? await cursor(c, b, [String(end.sealed_at), String(end.id)])
      : null;
  if (rev !== (await fingerprint(c, sql))) fail('CURSOR_STALE');
  await post(c, s, corpusOwnerGuard(c));
  return result;
}
export async function discoverChildCorpora(
  c: CorpusContext,
  childId: string,
  input: Page = {},
): Promise<CorpusFamilyEntryResponse> {
  const base = await familyScope(c, childId),
    s = await scope(c),
    limit = input.limit === undefined ? 20 : parsePageLimit(input.limit),
    assignmentSql = `SELECT count(*) AS n,max(id) AS last FROM pilot_corpus_assignment WHERE child_id=${q(childId)}`,
    corpusSql =
      'SELECT count(*) AS n,max(corpus_version) AS last FROM pilot_corpus',
    revision = await H({
      assignments: await fingerprint(c, assignmentSql),
      corpora: await fingerprint(c, corpusSql),
    }),
    binding = await pageBinding(
      c,
      s,
      'family-corpora',
      childId,
      '',
      await H({ revision, authRevision: base.authRevision }),
      limit,
    ),
    previous = await last(c, input, binding);
  if (previous.length && !(previous.length === 1 || previous.length === 4))
    fail('CURSOR_INVALID', 400);
  if (
    previous.some((v, i) => i !== 2 && !corpusId(v)) ||
    (previous.length === 4 && !/^\d+$/u.test(previous[2]))
  )
    fail('CURSOR_INVALID', 400);
  const resume = previous.length === 4,
    after = previous[0] ?? '',
    assignedCorpus =
      c.user.role === 'parent'
        ? '1'
        : `EXISTS(SELECT 1 FROM pilot_corpus_assignment a WHERE a.child_id=${q(childId)} AND a.corpus_version=r.corpus_version)`,
    corpora = await corpusRows(
      c,
      `SELECT r.* FROM pilot_corpus r WHERE ${assignedCorpus} AND r.corpus_version${resume ? '>=' : '>'}${q(after)} ORDER BY r.corpus_version COLLATE BINARY LIMIT ${limit + 1}`,
    ),
    result: CorpusFamilyEntryResponse = {
      schemaVersion: 'r6-family-corpora-1',
      childId,
      installationId: s.installation,
      items: [],
      nextCursor: null,
    };
  const positive: Array<{ guard: string; configuration: string }> = [];
  let inspected = 0,
    lastVersion = after;
  for (const corpus of corpora.slice(0, limit)) {
    const version = String(corpus.corpus_version),
      a = await readCurrentCorpusAuthority(c, version);
    let scopeGuard = base.guard,
      permitted = true;
    if (a)
      try {
        scopeGuard = (await requireCorpusFamilyScope(c, a, childId)).guard;
      } catch (e) {
        if (
          !['NOT_FOUND', 'LESSON_UNAVAILABLE'].includes(
            (e as { code: string }).code,
          )
        )
          throw e;
        permitted = false;
      }
    let tuple = resume && version === after ? previous.slice(1) : [],
      found: CorpusRow | null = null,
      available = false,
      exhausted = true;
    if (a && a.status === 'released' && permitted) {
      const remaining = 50 - inspected;
      if (remaining <= 0) {
        result.nextCursor = await cursor(c, binding, [lastVersion]);
        break;
      }
      const assigned =
          c.user.role === 'parent'
            ? '1'
            : `EXISTS(SELECT 1 FROM pilot_corpus_assignment ass WHERE ass.child_id=${q(childId)} AND ass.installation_id=${q(s.installation)} AND ass.corpus_version=item.corpus_version AND ass.lesson_version=item.lesson_version AND ass.content_digest=item.content_digest AND ass.publication_id=${q(a.releaseId)})`,
        key = tuple.length
          ? `AND (item.track_id,item.sequence,item.lesson_version)>(${q(tuple[0])},${q(Number(tuple[1]))},${q(tuple[2])})`
          : '',
        rows = await corpusRows(
          c,
          `SELECT item.* FROM pilot_corpus_item item WHERE item.corpus_version=${q(version)} AND ${assigned} AND ${corpusEligiblePackageGuard(c, a, 'item')} ${key} ORDER BY item.track_id,item.sequence,item.lesson_version LIMIT ${remaining + 1}`,
        );
      for (const row of rows.slice(0, remaining)) {
        inspected++;
        tuple = [
          String(row.track_id),
          String(row.sequence),
          String(row.lesson_version),
        ];
        const pkg = await readCorpusPackageAuthority(
          c,
          a,
          String(row.lesson_version),
        );
        if (!pkg.available) continue;
        found = row;
        available = true;
        positive.push({
          configuration: a.configuration,
          guard: `${scopeGuard} AND ${corpusAuthorityGuard(c, a, [pkg])}`,
        });
        break;
      }
      exhausted = !!found || rows.length <= remaining;
      if (!exhausted) {
        result.nextCursor = await cursor(c, binding, [version, ...tuple]);
        break;
      }
    }
    if (!found && exhausted)
      found = await corpusOne(
        c,
        `SELECT item.* FROM pilot_corpus_assignment ass JOIN pilot_corpus_item item ON item.corpus_version=ass.corpus_version AND item.lesson_version=ass.lesson_version AND item.content_digest=ass.content_digest WHERE ass.child_id=${q(childId)} AND ass.corpus_version=${q(version)} ORDER BY item.track_id,item.sequence,item.lesson_version LIMIT 1`,
      );
    if (found) {
      const display = JSON.parse(String(found.display_json));
      result.items.push({
        corpusId: String(corpus.corpus_id),
        corpusVersion: version,
        corpusDigest: String(corpus.corpus_digest),
        title: display.title,
        targets: display.targets,
        available,
        reasonCode: available ? null : 'LESSON_UNAVAILABLE',
      });
    }
    lastVersion = version;
    if (inspected >= 50) {
      if (corpora.some((r) => String(r.corpus_version) > version))
        result.nextCursor = await cursor(c, binding, [lastVersion]);
      break;
    }
  }
  if (!result.nextCursor && corpora.length > limit)
    result.nextCursor = await cursor(c, binding, [lastVersion]);
  if (
    revision !==
    (await H({
      assignments: await fingerprint(c, assignmentSql),
      corpora: await fingerprint(c, corpusSql),
    }))
  )
    fail('CURSOR_STALE');
  for (const p of positive)
    assertCorpusAuthorityConfiguration(c, {
      configuration: p.configuration,
    } as Parameters<typeof assertCorpusAuthorityConfiguration>[1]);
  await post(c, s, [base.guard, ...positive.map((p) => p.guard)].join(' AND '));
  return result;
}
