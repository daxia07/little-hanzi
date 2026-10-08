import { canonicalPackage, curriculumDigest } from '../curriculum/digest.ts';
import { validateCurriculumPackage } from '../curriculum/validate.ts';
import { FOREST_LESSON } from '../preview/content.ts';
import {
  isCurriculumReviewInput,
  hasCompleteCurriculumProvenance as provenanceComplete,
  curriculumReviewRequest,
  type CurriculumReviewInput as ReviewInput,
} from '../curriculum/review.ts';
import type { PilotDatabase } from './db.ts';
import type { PilotSessionContext } from './http.ts';
import { exact as exactObject } from '../curriculum/story-package.ts';

type Row = Record<string, string | number | null>;
interface Character {
  characterId: string;
  hanzi: string;
  assets: string[];
  readings: Array<{ provenance: { sourceChecked: boolean } }>;
  meanings: Array<{ provenance: { sourceChecked: boolean } }>;
  wordAssociations: Array<{ provenance: { sourceChecked: boolean } }>;
}
interface Package {
  renderer?: { adapterId: string };
  lessonId: string;
  lessonVersion: string;
  title: string;
  canonicalizationVersion: string;
  characters: Character[];
  assets: Array<{
    assetId: string;
    kind: string;
    sourceChecked: boolean;
    sourceCheckStatus: string;
  }>;
}
interface Registry {
  state: Row[];
  packages: Row[];
  characters: Row[];
  reviews: Row[];
  audit: Row[];
  users: string[];
}
interface VerifiedRegistry extends Registry {
  manifests: Map<string, Package>;
}

const COLUMNS = {
  state: ['id', 'revision', 'updated_at'],
  packages: [
    'lesson_version',
    'lesson_id',
    'content_digest',
    'canonicalization_version',
    'manifest_json',
    'import_id',
    'imported_by_user_id',
    'imported_at',
    'test_run_id',
  ],
  characters: ['lesson_version', 'character_id', 'hanzi', 'character_index'],
  reviews: [
    'review_id',
    'lesson_version',
    'content_digest',
    'review_sequence',
    'previous_review_id',
    'decision',
    'reviewer_ref',
    'reviewed_at',
    'checklist_version',
    'checklist_json',
    'evidence_ref',
    'reason',
    'recorded_by_user_id',
    'recorded_at',
    'request_digest',
    'write_id',
    'test_run_id',
  ],
  audit: [
    'id',
    'action',
    'actor_user_id',
    'lesson_version',
    'content_digest',
    'review_id',
    'created_at',
  ],
} as const;
const TABLES = {
  state: 'registry_state',
  packages: 'package',
  characters: 'character',
  reviews: 'review',
  audit: 'audit',
} as const;
const INTEGER = new Set([
  'revision',
  'updated_at',
  'imported_at',
  'character_index',
  'review_sequence',
  'reviewed_at',
  'recorded_at',
  'created_at',
]);
const OPERATOR =
  "EXISTS(SELECT 1 FROM pilot_auth_user WHERE id=? AND role='operator' AND disabled=0 AND must_change_password=0)";

class RegistryError extends Error {
  code: string;
  status: number;
  errors?: Array<{ path: string; code: string }>;
  constructor(
    code: string,
    status = 409,
    errors?: Array<{ path: string; code: string }>,
  ) {
    super(code);
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
}
const unavailable = (): never => {
  throw new RegistryError('STORAGE_UNAVAILABLE', 503);
};
function check(value: unknown): asserts value {
  if (!value) unavailable();
}
function reviewInput(value: unknown, now: number): ReviewInput {
  if (!isCurriculumReviewInput(value, now))
    throw new RegistryError('INVALID_REQUEST', 400);
  return value;
}
function inputFromRow(row: Row): ReviewInput {
  return reviewInput(
    {
      requestId: row.review_id,
      contentDigest: row.content_digest,
      previousReviewId: row.previous_review_id,
      decision: row.decision,
      reviewerRef: row.reviewer_ref,
      reviewedAt: row.reviewed_at,
      checklistVersion: row.checklist_version,
      checklist: JSON.parse(String(row.checklist_json)),
      evidenceRef: row.evidence_ref,
      reason: row.reason,
    },
    Number(row.recorded_at),
  );
}
const fingerprint = (
  lessonVersion: string,
  actorUserId: string,
  testRunId: string | null,
  input: ReviewInput,
) =>
  curriculumDigest(
    curriculumReviewRequest(lessonVersion, actorUserId, testRunId, input),
  );

// One SQL statement captures every row used for the projection. Neither the
// revision nor a review head can come from a later transaction.
async function registrySnapshot(db: PilotDatabase): Promise<VerifiedRegistry> {
  try {
    const fields = Object.entries(COLUMNS).map(([key, columns]) => {
      const table = `pilot_curriculum_${TABLES[key as keyof typeof TABLES]}`;
      const object = columns.map((column) => `'${column}',${column}`).join(',');
      return `'${key}',json((SELECT json_group_array(json_object(${object})) FROM ${table}))`;
    });
    fields.push(
      "'users',json((SELECT json_group_array(id) FROM pilot_auth_user))",
    );
    const result = await db
      .prepare(`SELECT json_object(${fields.join(',')}) AS snapshot`)
      .first<{ snapshot: string }>();
    check(result);
    const rows = JSON.parse(result.snapshot) as Registry;
    for (const [key, columns] of Object.entries(COLUMNS)) {
      check(Array.isArray(rows[key as keyof typeof COLUMNS]));
      for (const row of rows[key as keyof typeof COLUMNS]) {
        check(exactObject(row, columns));
        for (const [column, value] of Object.entries(row)) {
          const nullable =
            column === 'test_run_id' ||
            column === 'previous_review_id' ||
            (key === 'audit' && column === 'review_id');
          if (nullable && value === null) continue;
          check(
            INTEGER.has(column) || (key === 'state' && column === 'id')
              ? Number.isSafeInteger(value) && Number(value) >= 0
              : typeof value === 'string' &&
                  value.isWellFormed() &&
                  value.length > 0,
          );
        }
      }
    }
    check(rows.state.length === 1 && rows.state[0].id === 1);
    check(
      rows.state[0].revision === rows.packages.length + rows.reviews.length &&
        rows.audit.length === rows.state[0].revision,
    );
    const manifests = new Map<string, Package>();
    const characterIDs = new Map<string, string>();
    const digests = new Set<string>();
    const importIDs = new Set<string>();
    for (const pkg of rows.packages) {
      const version = String(pkg.lesson_version);
      const manifest = JSON.parse(String(pkg.manifest_json)) as Package;
      check(
        validateCurriculumPackage(manifest).ok &&
          canonicalPackage(manifest) === pkg.manifest_json &&
          (await curriculumDigest(manifest)) === pkg.content_digest &&
          manifest.lessonId === pkg.lesson_id &&
          manifest.lessonVersion === version &&
          manifest.canonicalizationVersion === pkg.canonicalization_version,
      );
      check(
        !manifests.has(version) &&
          !digests.has(String(pkg.content_digest)) &&
          !importIDs.has(String(pkg.import_id)) &&
          rows.users.includes(String(pkg.imported_by_user_id)),
      );
      manifests.set(version, manifest);
      digests.add(String(pkg.content_digest));
      importIDs.add(String(pkg.import_id));
      const indexes = rows.characters
        .filter((row) => row.lesson_version === version)
        .sort((a, b) => Number(a.character_index) - Number(b.character_index));
      check(indexes.length === manifest.characters.length);
      manifest.characters.forEach((character, index) => {
        const row = indexes[index];
        check(
          row.character_index === index &&
            row.character_id === character.characterId &&
            row.hanzi === character.hanzi,
        );
        check(
          !characterIDs.has(character.characterId) ||
            characterIDs.get(character.characterId) === character.hanzi,
        );
        characterIDs.set(character.characterId, character.hanzi);
      });
      const audit = rows.audit.filter(
        (row) => row.action === 'import' && row.lesson_version === version,
      );
      check(
        audit.length === 1 &&
          audit[0].review_id === null &&
          audit[0].content_digest === pkg.content_digest &&
          audit[0].actor_user_id === pkg.imported_by_user_id &&
          audit[0].created_at === pkg.imported_at,
      );
      const history = rows.reviews
        .filter((row) => row.lesson_version === version)
        .sort((a, b) => Number(a.review_sequence) - Number(b.review_sequence));
      for (const [index, row] of history.entries()) {
        check(
          row.review_sequence === index + 1 &&
            row.previous_review_id ===
              (history[index - 1]?.review_id ?? null) &&
            row.content_digest === pkg.content_digest &&
            row.test_run_id === pkg.test_run_id &&
            rows.users.includes(String(row.recorded_by_user_id)),
        );
        const input = inputFromRow(row);
        check(input.decision !== 'approved' || provenanceComplete(manifest));
        check(
          row.request_digest ===
            (await fingerprint(
              version,
              String(row.recorded_by_user_id),
              row.test_run_id as string | null,
              input,
            )),
        );
        const audits = rows.audit.filter(
          (a) => a.action === 'review' && a.review_id === row.review_id,
        );
        check(
          audits.length === 1 &&
            audits[0].lesson_version === version &&
            audits[0].content_digest === pkg.content_digest &&
            audits[0].actor_user_id === row.recorded_by_user_id &&
            audits[0].created_at === row.recorded_at,
        );
      }
    }
    check(
      rows.characters.every((row) =>
        manifests.has(String(row.lesson_version)),
      ) &&
        rows.reviews.every((row) => manifests.has(String(row.lesson_version))),
    );
    check(
      new Set(rows.reviews.map((row) => row.review_id)).size ===
        rows.reviews.length &&
        new Set(rows.reviews.map((row) => row.write_id)).size ===
          rows.reviews.length &&
        new Set(rows.audit.map((row) => row.id)).size === rows.audit.length,
    );
    check(
      rows.audit.every(
        (row) =>
          ['import', 'review'].includes(String(row.action)) &&
          manifests.has(String(row.lesson_version)) &&
          Number(row.created_at) <= Number(rows.state[0].updated_at),
      ),
    );
    return { ...rows, manifests };
  } catch {
    return unavailable();
  }
}

function fixtureNamespace(context: PilotSessionContext): string | null {
  const config = context.config;
  if (!config.testMode) return null;
  if (
    !config.testContentAllowed ||
    !config.testRunId ||
    !config.testToken ||
    !config.candidateExplicitlyBound
  )
    throw new RegistryError('TEST_CONTENT_DISABLED', 403);
  return config.testRunId;
}
function fixtureScope(pkg: Row, namespace: string | null) {
  if (pkg.test_run_id !== namespace)
    throw new RegistryError('FIXTURE_SCOPE_MISMATCH');
}
async function currentOperator(context: PilotSessionContext) {
  const user = await context.db
    .prepare(
      'SELECT role,disabled,must_change_password FROM pilot_auth_user WHERE id=?',
    )
    .bind(context.user.id)
    .first<Row>();
  if (!user || user.disabled !== 0)
    throw new RegistryError('UNAUTHORIZED', 401);
  if (user.must_change_password !== 0)
    throw new RegistryError('PASSWORD_CHANGE_REQUIRED', 403);
  if (user.role !== 'operator') throw new RegistryError('FORBIDDEN', 403);
}
function packageRow(snapshot: Registry, version: string): Row {
  const pkg = snapshot.packages.find((row) => row.lesson_version === version);
  if (!pkg) throw new RegistryError('NOT_FOUND', 404);
  return pkg;
}
function currentHead(snapshot: Registry, version: string): Row | undefined {
  return snapshot.reviews
    .filter((row) => row.lesson_version === version)
    .sort((a, b) => Number(b.review_sequence) - Number(a.review_sequence))[0];
}
async function importPackage(context: PilotSessionContext, input: unknown) {
  if (!exactObject(input, ['package']))
    throw new RegistryError('INVALID_REQUEST', 400);
  const validated = validateCurriculumPackage(input.package);
  if (!validated.ok)
    throw new RegistryError('INVALID_PACKAGE', 400, validated.errors);
  const namespace = fixtureNamespace(context);
  const manifest = input.package as Package;
  if (manifest.lessonVersion === FOREST_LESSON.lessonVersion) {
    throw new RegistryError('CURRICULUM_VERSION_CONFLICT');
  }
  const canonical = canonicalPackage(manifest),
    digest = await curriculumDigest(manifest);
  const before = await registrySnapshot(context.db);
  const resolve = (snapshot: Registry, importId?: string) => {
    const pkg = snapshot.packages.find(
      (row) => row.lesson_version === manifest.lessonVersion,
    );
    if (!pkg) return null;
    fixtureScope(pkg, namespace);
    if (pkg.content_digest !== digest || pkg.lesson_id !== manifest.lessonId)
      throw new RegistryError('CURRICULUM_VERSION_CONFLICT');
    return {
      lessonId: manifest.lessonId,
      lessonVersion: manifest.lessonVersion,
      contentDigest: digest,
      created: pkg.import_id === importId,
    };
  };
  const duplicate = resolve(before);
  if (duplicate) {
    await currentOperator(context);
    return duplicate;
  }
  if (before.packages.some((row) => row.content_digest === digest))
    throw new RegistryError('CURRICULUM_DIGEST_CONFLICT');
  if (
    manifest.characters.some((character) =>
      before.characters.some(
        (row) =>
          row.character_id === character.characterId &&
          row.hanzi !== character.hanzi,
      ),
    )
  )
    throw new RegistryError('CHARACTER_IDENTITY_CONFLICT');
  const id = crypto.randomUUID(),
    now = Date.now(),
    db = context.db;
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO pilot_curriculum_package(${COLUMNS.packages.join(',')}) SELECT ?,?,?,?,?,?,?,?,?
        WHERE ${OPERATOR} AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_package WHERE lesson_version=? OR content_digest=?)`)
        .bind(
          manifest.lessonVersion,
          manifest.lessonId,
          digest,
          manifest.canonicalizationVersion,
          canonical,
          id,
          context.user.id,
          now,
          namespace,
          context.user.id,
          manifest.lessonVersion,
          digest,
        ),
      db
        .prepare(`INSERT INTO pilot_curriculum_character(${COLUMNS.characters.join(',')})
        SELECT p.lesson_version,json_extract(c.value,'$.characterId'),json_extract(c.value,'$.hanzi'),CAST(c.key AS INTEGER)
        FROM pilot_curriculum_package p,json_each(p.manifest_json,'$.characters') c WHERE p.import_id=?`)
        .bind(id),
      db
        .prepare(
          `INSERT INTO pilot_curriculum_audit(${COLUMNS.audit.join(',')}) SELECT ?,'import',imported_by_user_id,lesson_version,content_digest,NULL,imported_at FROM pilot_curriculum_package WHERE import_id=?`,
        )
        .bind(crypto.randomUUID(), id),
      db
        .prepare(
          'UPDATE pilot_curriculum_registry_state SET revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=1 AND EXISTS(SELECT 1 FROM pilot_curriculum_package WHERE import_id=?)',
        )
        .bind(now, id),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('CURRICULUM_CHARACTER_IDENTITY')
    )
      throw new RegistryError('CHARACTER_IDENTITY_CONFLICT');
    return unavailable();
  }
  await currentOperator(context);
  const after = await registrySnapshot(db);
  const result = resolve(after, id);
  if (result) return result;
  if (after.packages.some((row) => row.content_digest === digest))
    throw new RegistryError('CURRICULUM_DIGEST_CONFLICT');
  return unavailable();
}

async function recordReview(
  context: PilotSessionContext,
  version: string,
  value: unknown,
) {
  const input = reviewInput(value, Date.now()),
    namespace = fixtureNamespace(context);
  const before = await registrySnapshot(context.db),
    pkg = packageRow(before, version);
  fixtureScope(pkg, namespace);
  const digest = await fingerprint(version, context.user.id, namespace, input);
  const replay = (snapshot: Registry, writeId?: string) => {
    const row = snapshot.reviews.find(
      (row) => row.review_id === input.requestId,
    );
    if (!row) return null;
    if (row.request_digest !== digest)
      throw new RegistryError('REVIEW_EVENT_CONFLICT');
    return { reviewId: input.requestId, created: row.write_id === writeId };
  };
  const previous = replay(before);
  if (previous) {
    await currentOperator(context);
    return previous;
  }
  if (pkg.content_digest !== input.contentDigest)
    throw new RegistryError('CURRICULUM_VERSION_CONFLICT');
  if (
    (currentHead(before, version)?.review_id ?? null) !== input.previousReviewId
  )
    throw new RegistryError('STALE_REVIEW');
  if (
    input.decision === 'approved' &&
    !provenanceComplete(before.manifests.get(version)!)
  )
    throw new RegistryError('PROVENANCE_INCOMPLETE');
  const id = crypto.randomUUID(),
    now = Date.now(),
    db = context.db;
  const head =
    '(SELECT review_id FROM pilot_curriculum_review WHERE lesson_version=? ORDER BY review_sequence DESC LIMIT 1)';
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO pilot_curriculum_review(${COLUMNS.reviews.join(',')})
        SELECT ?,?,?,(SELECT COALESCE(MAX(review_sequence),0)+1 FROM pilot_curriculum_review WHERE lesson_version=?),?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE ${OPERATOR} AND NOT EXISTS(SELECT 1 FROM pilot_curriculum_review WHERE review_id=?)
        AND ? IS ${head} AND EXISTS(SELECT 1 FROM pilot_curriculum_package WHERE lesson_version=? AND content_digest=? AND test_run_id IS ?)`)
        .bind(
          input.requestId,
          version,
          input.contentDigest,
          version,
          input.previousReviewId,
          input.decision,
          input.reviewerRef,
          input.reviewedAt,
          input.checklistVersion,
          canonicalPackage(input.checklist),
          input.evidenceRef,
          input.reason,
          context.user.id,
          now,
          digest,
          id,
          namespace,
          context.user.id,
          input.requestId,
          input.previousReviewId,
          version,
          version,
          input.contentDigest,
          namespace,
        ),
      db
        .prepare(
          `INSERT INTO pilot_curriculum_audit(${COLUMNS.audit.join(',')}) SELECT ?,'review',recorded_by_user_id,lesson_version,content_digest,review_id,recorded_at FROM pilot_curriculum_review WHERE write_id=?`,
        )
        .bind(crypto.randomUUID(), id),
      db
        .prepare(
          'UPDATE pilot_curriculum_registry_state SET revision=revision+1,updated_at=MAX(updated_at,?) WHERE id=1 AND EXISTS(SELECT 1 FROM pilot_curriculum_review WHERE write_id=?)',
        )
        .bind(now, id),
    ]);
  } catch {
    return unavailable();
  }
  await currentOperator(context);
  const after = await registrySnapshot(db);
  const result = replay(after, id);
  if (result) return result;
  if (
    (currentHead(after, version)?.review_id ?? null) !== input.previousReviewId
  )
    throw new RegistryError('STALE_REVIEW');
  return unavailable();
}

/** Server-only projection over an already verified complete registry snapshot. */
export function registryCoverageForSnapshot(snapshot: VerifiedRegistry) {
  const machine = new Set<string>(),
    human = new Set<string>();
  const packages = snapshot.packages
    .map((pkg) => {
      const manifest = snapshot.manifests.get(String(pkg.lesson_version))!;
      const head = currentHead(snapshot, manifest.lessonVersion);
      const fixture =
        pkg.test_run_id !== null || Boolean(head && head.test_run_id !== null);
      manifest.characters.forEach((character) => {
        machine.add(character.hanzi);
        if (!fixture && manifest.renderer?.adapterId !== 'corpus-paired' && head?.decision === 'approved')
          human.add(character.hanzi);
      });
      return {
        lessonId: manifest.lessonId,
        lessonVersion: manifest.lessonVersion,
        title: manifest.title,
        contentDigest: pkg.content_digest,
        characterCount: manifest.characters.length,
        importedAt: pkg.imported_at,
        testFixture: fixture,
        reviewState: fixture ? 'test-fixture' : (head?.decision ?? 'pending'),
      };
    })
    .sort((a, b) =>
      a.lessonVersion < b.lessonVersion
        ? -1
        : a.lessonVersion > b.lessonVersion
          ? 1
          : 0,
    );
  return {
    schemaVersion: 's3-registry-foundation-1',
    revision: snapshot.state[0].revision,
    counts: {
      machineValidDistinct: machine.size,
      humanReviewedDistinct: human.size,
      reviewedReadyDistinct: 0,
      supervisedTrialDistinct: 0,
      prospectiveStarterDistinct: 0,
      starterReleasedDistinct: 0,
      starterRequiredDistinct: 1600,
    },
    releaseProof: {
      available: false,
      code: 'STARTER_RELEASE_PROOF_UNAVAILABLE',
    },
    packages,
  };
}
function detail(snapshot: VerifiedRegistry, version: string) {
  const pkg = packageRow(snapshot, version);
  return {
    package: snapshot.manifests.get(version),
    contentDigest: pkg.content_digest,
    importedAt: pkg.imported_at,
    testFixture: pkg.test_run_id !== null,
    reviews: snapshot.reviews
      .filter((row) => row.lesson_version === version)
      .sort((a, b) => Number(a.review_sequence) - Number(b.review_sequence))
      .map((row) => ({
        reviewId: row.review_id,
        previousReviewId: row.previous_review_id,
        sequence: row.review_sequence,
        decision: row.decision,
        reviewerRef: row.reviewer_ref,
        reviewedAt: row.reviewed_at,
        checklistVersion: row.checklist_version,
        checklist: JSON.parse(String(row.checklist_json)),
        evidenceRef: row.evidence_ref,
        reason: row.reason,
        recordedBy: row.recorded_by_user_id,
        recordedAt: row.recorded_at,
        testFixture: row.test_run_id !== null,
      })),
  };
}
async function strictBody(request: Request, limit: number): Promise<unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await request.arrayBuffer(),
    );
    if (text.length > limit) throw new Error();
    return JSON.parse(text);
  } catch {
    throw new RegistryError('INVALID_REQUEST', 400);
  }
}

export async function curriculumRoute(
  request: Request,
  operation: 'coverage' | 'detail' | 'import' | 'review',
  version = '',
): Promise<Response> {
  const { json, requireAccountManager, requireOrigin, requirePilotSession } =
    await import('./http.ts');
  const required = await requirePilotSession(request);
  if (required instanceof Response) return required;
  const denial =
    requireAccountManager(required) ??
    ((operation === 'coverage' || operation === 'detail') &&
    !request.headers.has('Origin')
      ? null
      : requireOrigin(request, required.config));
  if (denial) return denial;
  try {
    if (operation === 'import' || operation === 'review') {
      const input = await strictBody(
        request,
        operation === 'import' ? 1_000_000 : 16_000,
      );
      const result =
        operation === 'import'
          ? await importPackage(required, input)
          : await recordReview(required, version, input);
      return json(result, result.created ? 201 : 200);
    }
    const snapshot = await registrySnapshot(required.db);
    return json(
      operation === 'coverage' ? registryCoverageForSnapshot(snapshot) : detail(snapshot, version),
    );
  } catch (error) {
    const known =
      error instanceof RegistryError
        ? error
        : new RegistryError('STORAGE_UNAVAILABLE', 503);
    return json(
      {
        error: {
          code: known.code,
          message:
            known.code === 'STORAGE_UNAVAILABLE'
              ? 'Curriculum storage is unavailable.'
              : 'Curriculum request could not be completed.',
        },
        ...(known.errors ? { errors: known.errors } : {}),
      },
      known.status,
    );
  }
}

/** Reused by closed candidate bootstrap; same current operator, validator and registry transaction. */
export async function importCurriculumPackage(
  context: PilotSessionContext,
  input: unknown,
) {
  await currentOperator(context);
  return importPackage(context, input);
}
