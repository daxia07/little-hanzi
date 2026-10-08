/** R6 administration store; ordinary learning dispatch is deliberately a later slice. */
import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import {
  compileCorpusRuntime,
  type CompiledCorpusLesson,
} from '../curriculum/corpus-runtime.ts';
import { exact, digest } from '../curriculum/story-package.ts';
import type {
  CorpusMetadata,
  CorpusMetadataResponse,
  CorpusReceipt,
  CorpusBatchResponse,
} from '../curriculum/corpus-types.ts';
import { fail } from './story-policy.ts';
import {
  safeCorpusJson,
  corpusId,
  normalizeCoverageIdentity,
  inspectCorpusManifest,
  inspectSourceRequest,
  assertSourceSuccessor,
  corpusRequest,
  assertExactCorpusReplay,
  corpusIndexTokens,
} from './corpus-policy.ts';
import {
  issueCorpusCursor,
  readCorpusCursor,
  type CorpusCursorBinding,
} from './corpus-cursor.ts';
import {
  corpusOne,
  corpusRows,
  corpusBatch,
  corpusInsert,
  sqlValue as q,
  requireCorpusActor,
  corpusActorGuard,
  corpusInstallationGuard,
  corpusInstallation,
  corpusNow,
  corpusISO,
  corpusNewId,
  corpusNamespace,
  type CorpusContext,
  type CorpusRow,
} from './corpus-db.ts';
export type { CorpusContext } from './corpus-db.ts';
const compiledCache = new Map<
  string,
  { compiled: CompiledCorpusLesson; document: Record<string, unknown> }
>();
export async function loadCorpusPackage(c: CorpusContext, version: string) {
  if (!corpusId(version)) fail('INVALID_REQUEST', 400);
  const row = await corpusOne(
    c,
    `SELECT * FROM pilot_curriculum_package WHERE lesson_version=${q(version)}`,
  );
  if (!row) fail('NOT_FOUND', 404);
  const cacheKey = String(row.content_digest);
  let cached = compiledCache.get(cacheKey);
  if (!cached) {
    try {
      const document = JSON.parse(String(row.manifest_json)),
        compiled = await compileCorpusRuntime(document);
      if (
        compiled.identity.contentDigest !== row.content_digest ||
        canonicalPackage(document) !== row.manifest_json
      )
        fail('STORAGE_UNAVAILABLE', 503);
      cached = { compiled, document };
      compiledCache.set(cacheKey, cached);
      if (compiledCache.size > 128)
        compiledCache.delete(compiledCache.keys().next().value!);
    } catch {
      fail('INVALID_PACKAGE', 400);
    }
  }
  if (
    canonicalPackage(cached.document) !== row.manifest_json ||
    cached.compiled.identity.lessonVersion !== version
  )
    fail('STORAGE_UNAVAILABLE', 503);
  return { row, ...cached };
}
async function rootSource(c: CorpusContext, version: string) {
  return corpusOne(
    c,
    `SELECT * FROM pilot_corpus_source_evidence WHERE lesson_version=${q(version)} AND source_ordinal=1 ORDER BY created_at,id LIMIT 1`,
  );
}
export async function currentCorpusSource(c: CorpusContext, rootId: string) {
  return corpusOne(
    c,
    `SELECT h.* FROM pilot_corpus_source_evidence root JOIN pilot_corpus_source_evidence h ON h.lineage_id=root.lineage_id WHERE root.id=${q(rootId)} ORDER BY h.source_ordinal DESC LIMIT 1`,
  );
}
export async function registeredCorpus(c: CorpusContext, version: string) {
  if (!corpusId(version)) fail('INVALID_REQUEST', 400);
  const r = await corpusOne(
    c,
    `SELECT * FROM pilot_corpus WHERE corpus_version=${q(version)}`,
  );
  if (!r) fail('NOT_FOUND', 404);
  return r;
}
function receipt(row: CorpusRow): CorpusReceipt {
  return JSON.parse(String(row.ack_json));
}
async function replay(
  c: CorpusContext,
  table: string,
  resource: string,
  requestId: string,
  envelope: unknown,
) {
  const installation = await corpusInstallation(c),
    r = await corpusOne(
      c,
      `SELECT * FROM ${table} WHERE actor_id=${q(c.user.id)} AND installation_id=${q(installation)} AND request_id=${q(requestId)} AND json_extract(request_json,'$.resourceId')=${q(resource)}`,
    );
  if (!r) return null;
  assertExactCorpusReplay(JSON.parse(String(r.request_json)), envelope);
  await requireCorpusActor(c, 'operator');
  if ((await corpusInstallation(c)) !== installation) fail('UNAUTHORIZED', 401);
  return r;
}
export async function recordCorpusSource(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusReceipt> {
  await requireCorpusActor(c, 'operator');
  if (!corpusId(version)) fail('INVALID_REQUEST', 400);
  const raw = safeCorpusJson(input);
  if (
    !exact(raw, [
      'requestId',
      'lessonVersion',
      'contentDigest',
      'classification',
      'sourceRefs',
      'licenseRefs',
      'reviewRefs',
      'identityReviews',
      'predecessorEvidenceId',
      'expectedEvidenceDigest',
    ]) ||
    !corpusId(raw.requestId) ||
    !corpusId(raw.lessonVersion)
  )
    fail('INVALID_REQUEST', 400);
  const installation = await corpusInstallation(c),
    envelope = corpusRequest(
      'source-evidence',
      c.user.id,
      installation,
      version,
      raw,
    ),
    old = await replay(
      c,
      'pilot_corpus_source_evidence',
      version,
      raw.requestId,
      envelope,
    );
  if (old) return receipt(old);
  const pkg = await loadCorpusPackage(c, raw.lessonVersion);
  if (pkg.row.content_digest !== raw.contentDigest) fail('CONTENT_MISMATCH');
  const headReview = await corpusOne(
      c,
      `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(raw.lessonVersion)} ORDER BY review_sequence DESC LIMIT 1`,
    ),
    targets = (
      pkg.document.characters as Array<{ characterId: string; hanzi: string }>
    ).map((t) => ({ characterId: t.characterId, hanzi: t.hanzi }));
  const request = inspectSourceRequest(
      raw,
      targets,
      headReview?.decision === 'approved' ? [String(headReview.review_id)] : [],
    ),
    root = await rootSource(c, request.lessonVersion),
    head = root ? await currentCorpusSource(c, String(root.id)) : null;
  const next = assertSourceSuccessor(
      request,
      head
        ? {
            id: String(head.id),
            lineageId: String(head.lineage_id),
            ordinal: Number(head.source_ordinal),
            digest: String(head.evidence_digest),
            classification: head.classification as
              | 'verification-fixture'
              | 'unverified-draft'
              | 'real-source-reviewed',
            lessonVersion: String(head.lesson_version),
            contentDigest: String(head.content_digest),
          }
        : null,
      Boolean(c.corpus.fixtureBinding) || pkg.row.test_run_id !== null,
    ),
    time = corpusNow(c),
    id = corpusNewId('corpus-source'),
    ack = {
      requestId: request.requestId,
      recordId: id,
      recordedAt: corpusISO(time),
    };
  const evidence = {
    schemaVersion: 'r6-source-evidence-1',
    lessonVersion: request.lessonVersion,
    contentDigest: request.contentDigest,
    classification: next.classification,
    lineageId: next.lineageId ?? id,
    sourceOrdinal: next.ordinal,
    predecessorEvidenceId: request.predecessorEvidenceId,
    sourceRefs: request.sourceRefs,
    licenseRefs: request.licenseRefs,
    reviewRefs: request.reviewRefs,
    identityReviews: request.identityReviews,
  };
  const values = {
    id,
    lesson_version: request.lessonVersion,
    content_digest: request.contentDigest,
    classification: next.classification,
    lineage_id: next.lineageId ?? id,
    supersedes_id: request.predecessorEvidenceId,
    source_ordinal: next.ordinal,
    source_digest: await curriculumDigest({
      schemaVersion: 'r6-source-refs-1',
      sourceRefs: request.sourceRefs,
      licenseRefs: request.licenseRefs,
    }),
    evidence_json: canonicalPackage(evidence),
    evidence_digest: await curriculumDigest(evidence),
    attribution_json: canonicalPackage({
      schemaVersion: 'r6-source-attribution-1',
      actorId: c.user.id,
      installationId: installation,
      fixtureOrigin: next.classification === 'verification-fixture',
    }),
    actor_id: c.user.id,
    installation_id: installation,
    request_id: request.requestId,
    request_json: canonicalPackage(envelope),
    request_digest: await curriculumDigest(envelope),
    ack_json: canonicalPackage(ack),
    created_at: time,
    test_run_id: corpusNamespace(c),
  };
  const sourceGuard = head
    ? `EXISTS(SELECT 1 FROM pilot_corpus_source_evidence h WHERE h.id=${q(head.id)} AND h.evidence_digest=${q(head.evidence_digest)} AND NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence n WHERE n.supersedes_id=h.id))`
    : `NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence s WHERE s.lesson_version=${q(request.lessonVersion)} AND s.installation_id=${q(installation)} AND s.source_ordinal=1)`;
  const reviewGuard =
    request.classification === 'real-source-reviewed'
      ? `EXISTS(SELECT 1 FROM pilot_curriculum_review r WHERE r.review_id=${q(headReview?.review_id)} AND r.decision='approved' AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_review later WHERE later.lesson_version=r.lesson_version AND later.review_sequence>r.review_sequence))`
      : '1';
  await corpusBatch(c, [
    corpusInsert(
      'pilot_corpus_source_evidence',
      values,
      `${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(installation)} AND ${sourceGuard} AND ${reviewGuard}`,
    ),
  ]);
  await requireCorpusActor(c, 'operator');
  const stored = await replay(
    c,
    'pilot_corpus_source_evidence',
    version,
    request.requestId,
    envelope,
  );
  if (!stored) fail('SOURCE_STALE');
  return receipt(stored);
}
export interface CorpusBatchManifest {
  schemaVersion: 'r6-authoring-batch-1';
  batchId: string;
  batchVersion: string;
  items: Array<{
    lessonVersion: string;
    contentDigest: string;
    characters: Array<{ characterId: string; coverageIdentity: string }>;
    sourceRefs: string[];
    licenseRefs: string[];
    reviewerRefs: string[];
    adapterId: 'corpus-paired';
    adapterVersion: 'corpus-paired-v1';
    trackId: string;
    sequence: number;
  }>;
  intendedScope: 'draft' | 'supervised-trial' | 'starter';
  unresolvedFields: string[];
}
const reasonIds = [
  'FIXTURE',
  'PLACEHOLDER',
  'UNVERIFIED_SOURCE',
  'MISSING_LICENSE',
  'ALIAS',
  'DUPLICATE_IDENTITY',
  'INCOMPLETE_WORD_CONTEXT',
  'UNREVIEWED_CONTENT',
  'UNREVIEWED_AUDIO',
  'MISSING_PROMPT',
  'MISSING_ASSET',
  'UNSUPPORTED_RENDERER',
  'INVALID_PROOF',
  'STALE_EVIDENCE',
  'HISTORICAL_INSTALLATION',
  'WITHDRAWN',
  'OWNER_DECISION_PENDING',
  'PACKAGE_INELIGIBLE',
];
export function inspectCorpusBatch(input: unknown): CorpusBatchManifest {
  const b = safeCorpusJson(input);
  if (
    !exact(b, [
      'schemaVersion',
      'batchId',
      'batchVersion',
      'items',
      'intendedScope',
      'unresolvedFields',
    ]) ||
    b.schemaVersion !== 'r6-authoring-batch-1' ||
    !corpusId(b.batchId) ||
    !corpusId(b.batchVersion) ||
    !Array.isArray(b.items) ||
    b.items.length < 1 ||
    b.items.length > 50 ||
    !['draft', 'supervised-trial', 'starter'].includes(
      String(b.intendedScope),
    ) ||
    !Array.isArray(b.unresolvedFields) ||
    b.unresolvedFields.length > reasonIds.length ||
    !b.unresolvedFields.every((r) => reasonIds.includes(String(r))) ||
    new Set(b.unresolvedFields).size !== b.unresolvedFields.length
  )
    fail('INVALID_BATCH', 400);
  const seen = new Set<string>();
  for (const item of b.items) {
    if (
      !exact(item, [
        'lessonVersion',
        'contentDigest',
        'characters',
        'sourceRefs',
        'licenseRefs',
        'reviewerRefs',
        'adapterId',
        'adapterVersion',
        'trackId',
        'sequence',
      ]) ||
      !corpusId(item.lessonVersion) ||
      !digest(item.contentDigest) ||
      seen.has(item.lessonVersion) ||
      item.adapterId !== 'corpus-paired' ||
      item.adapterVersion !== 'corpus-paired-v1' ||
      !corpusId(item.trackId) ||
      !Number.isSafeInteger(item.sequence) ||
      Number(item.sequence) < 1 ||
      Number(item.sequence) > 1000000 ||
      !Array.isArray(item.characters) ||
      item.characters.length !== 2
    )
      fail('INVALID_BATCH', 400);
    seen.add(item.lessonVersion);
    const chars = new Set<string>();
    for (const t of item.characters) {
      if (
        !exact(t, ['characterId', 'coverageIdentity']) ||
        !corpusId(t.characterId) ||
        chars.has(t.characterId)
      )
        fail('INVALID_BATCH', 400);
      normalizeCoverageIdentity(t.coverageIdentity);
      chars.add(t.characterId);
    }
    for (const k of ['sourceRefs', 'licenseRefs', 'reviewerRefs'])
      if (
        !Array.isArray(item[k]) ||
        item[k].length > 20 ||
        !item[k].every(corpusId) ||
        new Set(item[k]).size !== item[k].length
      )
        fail('INVALID_BATCH', 400);
  }
  return b as unknown as CorpusBatchManifest;
}
export async function registerCorpusBatch(
  c: CorpusContext,
  version: string,
  input: unknown,
): Promise<CorpusBatchResponse> {
  await requireCorpusActor(c, 'operator');
  if (!corpusId(version)) fail('INVALID_REQUEST', 400);
  const v = safeCorpusJson(input);
  if (!exact(v, ['requestId', 'batch']) || !corpusId(v.requestId))
    fail('INVALID_REQUEST', 400);
  const install = await corpusInstallation(c),
    envelope = corpusRequest('batch', c.user.id, install, version, v),
    previous = await replay(
      c,
      'pilot_corpus_batch',
      version,
      v.requestId,
      envelope,
    );
  if (previous) return JSON.parse(String(previous.result_json));
  const batch = inspectCorpusBatch(v.batch),
    existing = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus_batch WHERE id=${q(batch.batchId)} OR batch_version=${q(batch.batchVersion)}`,
    );
  if (existing) fail('BATCH_CONFLICT');
  for (const item of batch.items) {
    const pkg = await loadCorpusPackage(c, item.lessonVersion);
    if (
      pkg.row.content_digest !== item.contentDigest ||
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
        ) ||
      canonicalPackage(pkg.document.placement) !==
        canonicalPackage({ trackId: item.trackId, sequence: item.sequence })
    )
      fail('BATCH_BINDING');
  }
  const at = corpusNow(c),
    manifestDigest = await curriculumDigest(batch),
    ack = {
      requestId: v.requestId,
      recordId: batch.batchId,
      recordedAt: corpusISO(at),
    },
    result: CorpusBatchResponse = {
      schemaVersion: 'r6-batch-1',
      batchId: batch.batchId,
      batchVersion: batch.batchVersion,
      manifestDigest,
      recordedAt: corpusISO(at),
      items: batch.items.map((i) => ({
        lessonVersion: i.lessonVersion,
        contentDigest: i.contentDigest,
        state: 'accepted',
        errors: [],
      })),
    };
  await corpusBatch(c, [
    corpusInsert(
      'pilot_corpus_batch',
      {
        id: batch.batchId,
        batch_version: batch.batchVersion,
        manifest_json: canonicalPackage(batch),
        manifest_digest: manifestDigest,
        result_json: canonicalPackage(result),
        actor_id: c.user.id,
        installation_id: install,
        request_id: v.requestId,
        request_json: canonicalPackage(envelope),
        request_digest: await curriculumDigest(envelope),
        ack_json: canonicalPackage(ack),
        created_at: at,
        test_run_id: corpusNamespace(c),
      },
      `${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(install)}`,
    ),
  ]);
  await requireCorpusActor(c, 'operator');
  const saved = await replay(
    c,
    'pilot_corpus_batch',
    version,
    v.requestId,
    envelope,
  );
  if (!saved) fail('STORAGE_UNAVAILABLE', 503);
  return JSON.parse(String(saved.result_json));
}
function metadata(row: CorpusRow): CorpusMetadata {
  const manifest = inspectCorpusManifest(JSON.parse(String(row.manifest_json)));
  return {
    corpusId: String(row.corpus_id),
    corpusVersion: String(row.corpus_version),
    corpusDigest: String(row.corpus_digest),
    policyVersion: 'r6-corpus-policy-1',
    packageCount: manifest.items.length,
    importedAt: corpusISO(row.imported_at),
  };
}
export async function registerCorpus(
  c: CorpusContext,
  input: unknown,
): Promise<{ corpusVersion: string; corpusDigest: string }> {
  await requireCorpusActor(c, 'operator');
  const v = safeCorpusJson(input);
  if (!exact(v, ['corpus'])) fail('INVALID_REQUEST', 400);
  const install = await corpusInstallation(c);
  const manifest = inspectCorpusManifest(v.corpus),
    content = await curriculumDigest(manifest),
    old = await corpusOne(
      c,
      `SELECT * FROM pilot_corpus WHERE corpus_version=${q(manifest.corpusVersion)}`,
    );
  if (old) {
    if (
      old.corpus_digest !== content ||
      old.manifest_json !== canonicalPackage(manifest)
    )
      fail('CORPUS_CONFLICT');
    await requireCorpusActor(c, 'operator');
    if ((await corpusInstallation(c)) !== install) fail('UNAUTHORIZED', 401);
    return { corpusVersion: manifest.corpusVersion, corpusDigest: content };
  }
  const at = corpusNow(c),
    guard = `${corpusActorGuard(c, 'operator')} AND ${corpusInstallationGuard(install)}`,
    statements = [
      corpusInsert(
        'pilot_corpus',
        {
          corpus_version: manifest.corpusVersion,
          corpus_id: manifest.corpusId,
          corpus_digest: content,
          manifest_json: canonicalPackage(manifest),
          policy_version: manifest.policyVersion,
          imported_by: c.user.id,
          imported_at: at,
        },
        guard,
      ),
    ];
  for (const [ordinal, item] of manifest.items.entries()) {
    const pkg = await loadCorpusPackage(c, item.lessonVersion),
      batch = await corpusOne(
        c,
        `SELECT * FROM pilot_corpus_batch WHERE id=${q(item.batchId)}`,
      ),
      source = await rootSource(c, item.lessonVersion);
    if (pkg.row.content_digest !== item.contentDigest || !batch || !source)
      fail('CORPUS_BINDING');
    const b = inspectCorpusBatch(JSON.parse(String(batch.manifest_json)));
    if (
      !b.items.some(
        (i) =>
          i.lessonVersion === item.lessonVersion &&
          i.contentDigest === item.contentDigest &&
          i.trackId === item.trackId &&
          i.sequence === item.sequence,
      )
    )
      fail('CORPUS_BINDING');
    const p = pkg.document,
      characters = p.characters as Array<Record<string, unknown>>,
      display = {
        title: p.title,
        targets: characters.map((t) => ({
          characterId: t.characterId,
          hanzi: t.hanzi,
        })),
        words: characters
          .flatMap((t) =>
            (t.wordAssociations as Array<Record<string, unknown>>).map((w) => ({
              text: w.text,
              english: w.english,
            })),
          )
          .slice(0, 4),
      };
    const childGuard = `EXISTS(SELECT 1 FROM pilot_corpus s WHERE s.corpus_version=${q(manifest.corpusVersion)} AND s.corpus_digest=${q(content)} AND s.imported_by=${q(c.user.id)} AND s.imported_at=${at})`;
    statements.push(
      corpusInsert(
        'pilot_corpus_item',
        {
          corpus_version: manifest.corpusVersion,
          ordinal,
          lesson_version: item.lessonVersion,
          content_digest: item.contentDigest,
          batch_id: item.batchId,
          track_id: item.trackId,
          sequence: item.sequence,
          adapter_id: 'corpus-paired',
          adapter_version: 'corpus-paired-v1',
          title: p.title,
          display_json: canonicalPackage(display),
          search_digest: await curriculumDigest(display),
        },
        childGuard,
      ),
    );
    for (const [targetIndex, t] of characters.entries()) {
      const requirements = {
        schemaVersion: 'r6-target-requirements-1',
        characterId: t.characterId,
        readingIds: (t.readings as Array<Record<string, unknown>>).map(
          (r) => r.readingId,
        ),
        wordIds: (t.wordAssociations as Array<Record<string, unknown>>).map(
          (w) => w.wordId,
        ),
        assets: t.assets,
      };
      statements.push(
        corpusInsert(
          'pilot_corpus_character',
          {
            corpus_version: manifest.corpusVersion,
            lesson_version: item.lessonVersion,
            content_digest: item.contentDigest,
            character_id: t.characterId,
            target_index: targetIndex,
            coverage_identity: normalizeCoverageIdentity(t.hanzi),
            identity_version: 'r6-coverage-identity-1',
            source_evidence_id: source.id,
            requirements_json: canonicalPackage(requirements),
            requirements_digest: await curriculumDigest(requirements),
          },
          childGuard,
        ),
      );
    }
    const terms = new Map<string, { term: string; kind: string }>();
    for (const [kind, value] of [
      ['title-english', String(p.title)],
      ...display.targets.map((t) => ['hanzi', String(t.hanzi)]),
      ...display.words.flatMap((w) => [
        ['word-hanzi', String(w.text)],
        ['word-english', String(w.english)],
      ]),
    ])
      for (const term of corpusIndexTokens(
        value,
        kind === 'title-english' ? 120 : 240,
      ))
        terms.set(kind + '\0' + term, { kind, term });
    for (const entry of terms.values())
      statements.push(
        corpusInsert(
          'pilot_corpus_search_term',
          {
            corpus_version: manifest.corpusVersion,
            lesson_version: item.lessonVersion,
            content_digest: item.contentDigest,
            ...entry,
          },
          childGuard,
        ),
      );
  }
  statements.push(
    `UPDATE pilot_corpus_evidence_epoch SET revision=revision+1,updated_at=max(updated_at,${at}) WHERE id=1 AND EXISTS(SELECT 1 FROM pilot_corpus WHERE corpus_version=${q(manifest.corpusVersion)} AND corpus_digest=${q(content)} AND imported_at=${at})`,
  );
  await corpusBatch(c, statements);
  await requireCorpusActor(c, 'operator');
  const saved = await registeredCorpus(c, manifest.corpusVersion);
  if (saved.corpus_digest !== content) fail('CORPUS_CONFLICT');
  await requireCorpusActor(c, 'operator');
  if ((await corpusInstallation(c)) !== install) fail('UNAUTHORIZED', 401);
  await requireCorpusActor(c, 'operator');
  await corpusInstallation(c);
  return { corpusVersion: manifest.corpusVersion, corpusDigest: content };
}
export async function listCorpora(
  c: CorpusContext,
  input: { limit?: unknown; cursor?: unknown } = {},
): Promise<CorpusMetadataResponse> {
  await requireCorpusActor(c, 'operator');
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (
    (typeof input.limit !== 'number' &&
      input.limit !== undefined &&
      (typeof input.limit !== 'string' || !/^\d{1,2}$/u.test(input.limit))) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    fail('INVALID_QUERY', 400);
  const install = await corpusInstallation(c),
    epoch = await corpusOne(
      c,
      'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
    );
  if (!epoch || !c.config.secret) fail('STORAGE_UNAVAILABLE', 503);
  const binding: CorpusCursorBinding = {
    kind: 'corpora-list',
    actorId: c.user.id,
    sessionId: String(c.session.id),
    authRevision: c.user.role,
    installationId: install,
    resourceId: 'corpora',
    corpusVersion: 'corpora',
    corpusDigest: 'sha256:' + '0'.repeat(64),
    buildId: c.config.candidateId,
    releaseRevision: 0,
    evidenceEpoch: Number(epoch.revision),
    q: '',
    limit,
  };
  let last = '';
  if (input.cursor !== undefined) {
    const cursor = await readCorpusCursor(
      c.config.secret,
      input.cursor,
      binding,
      corpusNow(c),
    );
    if (cursor.last.length !== 1) fail('CURSOR_INVALID', 400);
    last = cursor.last[0];
  }
  const items = await corpusRows(
    c,
    `SELECT * FROM pilot_corpus WHERE corpus_version>${q(last)} ORDER BY corpus_version LIMIT ${limit + 1}`,
  );
  await requireCorpusActor(c, 'operator');
  if ((await corpusInstallation(c)) !== install) fail('UNAUTHORIZED', 401);
  const after = await corpusOne(
    c,
    'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
  );
  if (after?.revision !== epoch.revision) fail('CURSOR_STALE');
  const page = items.slice(0, limit);
  return {
    schemaVersion: 'r6-corpora-1',
    items: page.map(metadata),
    nextCursor:
      items.length > limit
        ? await issueCorpusCursor(
            c.config.secret,
            binding,
            [String(page.at(-1)!.corpus_version)],
            corpusNow(c),
          )
        : null,
  };
}
