import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalPackage } from '../lib/curriculum/digest.ts';
import { inspectJson } from '../lib/curriculum/json.ts';
import {
  compilePairedRuntime,
  validatePairedRun,
} from '../lib/curriculum/paired-runtime.ts';
import {
  collectionSeed,
  validateCollectionManifest,
  validateCollectionPackages,
  validCollectionReceipt,
  verifyCollectionProof,
  parseCollectionScope,
} from '../lib/pilot/collection-policy.ts';
import {
  PILOT_V4_COLUMNS,
  PILOT_V4_TABLES,
  PILOT_V4_SCHEMA_TABLES,
  validatePilotStoryBackup,
} from './pilot-backup.mjs';
import {
  STORY_COLUMNS,
  historicalStoryInstallationIds,
} from './pilot-story-backup.mjs';
import {
  COLLECTION_COLUMNS,
  COLLECTION_TABLES,
  COLLECTION_TYPES,
  COLLECTION_NULLABLE,
} from './pilot-collection-columns.mjs';
import {
  collectionSchemaSource,
  assertCollectionSchema,
} from './pilot-collection-schema.mjs';

export function historicalCollectionInstallationIds(payload) {
  const ids = historicalStoryInstallationIds(payload);
  for (const table of [
    'pilot_collection_proposal',
    'pilot_collection_plan',
    'pilot_collection_plan_item',
    'pilot_collection_assignment',
    'pilot_collection_run',
    'pilot_collection_schedule',
  ]) {
    for (const row of payload.tables[table] || []) ids.add(row.installation_id);
  }
  return ids;
}

export const collectionTableNames = () => [
  ...PILOT_V4_TABLES,
  ...COLLECTION_TABLES,
];
export const collectionSchemaTables = () => [
  ...PILOT_V4_SCHEMA_TABLES,
  ...COLLECTION_TABLES,
];
export const collectionColumns = () => ({
  ...PILOT_V4_COLUMNS,
  ...COLLECTION_COLUMNS,
});
const json = canonicalPackage;
const sha = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value) =>
  'sha256:' + crypto.createHash('sha256').update(json(value)).digest('hex');
const same = (a, b) => json(a) === json(b);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  same(
    Object.keys(v).sort((a, b) => a.localeCompare(b)),
    [...keys].sort((a, b) => a.localeCompare(b)),
  );
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const check = (v) => {
  if (!v) collectionBackupInvalid();
};
const iso = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

export function collectionBackupInvalid() {
  throw Object.assign(new Error('BACKUP_COLLECTION_INVALID'), {
    code: 'BACKUP_COLLECTION_INVALID',
  });
}
function parsed(text) {
  check(typeof text === 'string');
  const value = JSON.parse(text);
  check(json(value) === text);
  return value;
}
function keyed(rows, key = 'id') {
  const result = new Map();
  for (const row of rows) {
    check(!result.has(row[key]));
    result.set(row[key], row);
  }
  return result;
}
function request(
  row,
  kind,
  actor,
  installation,
  resource,
  fields,
  version = 'r5',
) {
  const value = parsed(row.request_json);
  check(
    exact(value, [
      'schemaVersion',
      'actorId',
      'installationId',
      'resourceId',
      'request',
    ]) &&
      value.schemaVersion === `${version}-${kind}-request-1` &&
      value.actorId === actor &&
      value.installationId === installation &&
      value.resourceId === resource &&
      digest(value) === row.request_digest &&
      exact(value.request, fields),
  );
  return value.request;
}

/** Shared authority is partitioned by the registered adapter, never by a caller flag. */
export function collectionAuthorityPartition(payload) {
  const tables = payload.tables;
  const versions = new Set(
    tables.pilot_curriculum_package
      .filter(
        (r) =>
          JSON.parse(r.manifest_json)?.renderer?.adapterId === 'paired-story',
      )
      .map((r) => r.lesson_version),
  );
  const publications = tables.pilot_curriculum_publication.filter((r) =>
    versions.has(r.lesson_version),
  );
  const ids = new Set(publications.map((r) => r.id));
  const proof = tables.pilot_curriculum_proof_receipt.filter(
    (r) => JSON.parse(r.receipt_json)?.adapterId === 'paired-story',
  );
  return {
    versions,
    pilot_curriculum_proof_receipt: proof,
    pilot_curriculum_owner_decision:
      tables.pilot_curriculum_owner_decision.filter((r) =>
        versions.has(r.lesson_version),
      ),
    pilot_curriculum_publication: publications,
    pilot_curriculum_trial_member: tables.pilot_curriculum_trial_member.filter(
      (r) => ids.has(r.publication_id),
    ),
    pilot_curriculum_publication_state:
      tables.pilot_curriculum_publication_state.filter((r) =>
        versions.has(r.lesson_version),
      ),
    pilot_curriculum_publication_audit:
      tables.pilot_curriculum_publication_audit.filter((r) =>
        ids.has(r.publication_id),
      ),
  };
}
export function collectionLegacyPayload(payload) {
  const partition = collectionAuthorityPartition(payload);
  const tables = Object.fromEntries(
    PILOT_V4_TABLES.map((name) => [name, payload.tables[name]]),
  );
  for (const [table, selected] of Object.entries(partition)) {
    if (table === 'versions') continue;
    const removed = new Set(selected);
    tables[table] = tables[table].filter((row) => !removed.has(row));
  }
  const schema = payload.schema.filter((row) =>
    PILOT_V4_SCHEMA_TABLES.includes(row.tbl_name),
  );
  return {
    ...payload,
    format: 'pilot-admin-backup-4',
    migrations: payload.migrations.slice(0, 6),
    schema,
    schemaDigest: sha(schema),
    tables,
  };
}

/** Exact basic shape before async validation or any destination query. */
export function validateCollectionRows(
  input,
  source = collectionSchemaSource(),
) {
  try {
    const inspected = inspectJson(input);
    check(!inspected.errors.length);
    const payload = inspected.value;
    check(
      exact(payload, [
        'format',
        'createdAt',
        'candidateId',
        'sourceInstallationId',
        'migrations',
        'schemaDigest',
        'schema',
        'contentIdentities',
        'tables',
      ]) &&
        payload.format === 'pilot-admin-backup-5' &&
        iso(payload.createdAt) &&
        typeof payload.candidateId === 'string' &&
        payload.candidateId.length > 0 &&
        typeof payload.sourceInstallationId === 'string' &&
        payload.sourceInstallationId.length > 0 &&
        exact(payload.tables, collectionTableNames()) &&
        payload.schemaDigest === sha(payload.schema),
    );
    assertCollectionSchema(payload, source);
    for (const table of collectionTableNames())
      check(Array.isArray(payload.tables[table]));
    validateCollectionRowFields(payload);
    return payload;
  } catch {
    collectionBackupInvalid();
  }
}

function validateCollectionRowFields(payload) {
  for (const table of COLLECTION_TABLES)
    for (const row of payload.tables[table]) {
      check(exact(row, COLLECTION_COLUMNS[table]));
      for (const [name, value] of Object.entries(row)) {
        if (value === null) {
          check(COLLECTION_NULLABLE[table].includes(name));
          continue;
        }
        check(
          COLLECTION_TYPES[table][name] === 'INTEGER'
            ? integer(value)
            : typeof value === 'string' &&
                value.length > 0 &&
                value.isWellFormed(),
        );
        if (name.endsWith('_digest'))
          check(/^sha256:[a-f0-9]{64}$/.test(value));
        if (name.endsWith('_json')) parsed(value);
      }
    }
}

/** Order is shared by relational validation and real restore; triggers stay enabled. */
export function collectionRestoreRows(payload) {
  const output = [];
  const append = (table, rows = payload.tables[table]) =>
    rows.forEach((row) => output.push({ table, row }));
  for (const table of PILOT_V4_TABLES) {
    if (table === 'pilot_curriculum_registry_state') continue;
    let rows = payload.tables[table];
    if (table === 'pilot_curriculum_review')
      rows = [...rows].sort(
        (a, b) =>
          a.lesson_version.localeCompare(b.lesson_version) ||
          a.review_sequence - b.review_sequence,
      );
    if (table === 'pilot_curriculum_publication')
      rows = [...rows].sort(
        (a, b) =>
          a.installation_id.localeCompare(b.installation_id) ||
          a.lesson_version.localeCompare(b.lesson_version) ||
          a.generation - b.generation,
      );
    append(table, rows);
  }
  append('pilot_collection');
  append('pilot_collection_item');
  append(
    'pilot_collection_proposal',
    [...payload.tables.pilot_collection_proposal].sort(
      (a, b) => a.selection_ordinal - b.selection_ordinal,
    ),
  );
  append('pilot_collection_plan');
  append('pilot_collection_plan_item');
  append('pilot_collection_assignment');
  const schedules = payload.tables.pilot_collection_schedule;
  const runs = payload.tables.pilot_collection_run;
  for (const initial of [true, false]) {
    append(
      'pilot_collection_schedule',
      schedules.filter((s) => (s.kind === 'initial') === initial),
    );
    const selected = runs.filter((r) => (r.phase === 'initial') === initial);
    append('pilot_collection_run', selected);
    const ids = new Set(selected.map((r) => r.id));
    append(
      'pilot_collection_event',
      payload.tables.pilot_collection_event
        .filter((e) => ids.has(e.run_id))
        .sort((a, b) => a.sequence - b.sequence),
    );
  }
  append('pilot_collection_learning_audit');
  return output;
}

function relationalCheck(payload, source) {
  const columns = collectionColumns();
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json,sqlite3,sys',
        'v=json.load(sys.stdin); db=sqlite3.connect(":memory:")',
        'for statement in v["schema"]: db.execute(statement)',
        'db.commit(); db.execute("BEGIN"); db.execute("PRAGMA defer_foreign_keys=ON")',
        's=v["registry"]; db.execute("UPDATE pilot_curriculum_registry_state SET revision=?,updated_at=? WHERE id=1",[s["revision"],s["updated_at"]])',
        'for entry in v["rows"]:',
        '    table=entry["table"]; cols=v["columns"][table]',
        '    sql="INSERT INTO "+table+" ("+",".join(cols)+") VALUES("+",".join(["?"]*len(cols))+")"',
        '    db.execute(sql,[entry["row"][c] for c in cols])',
        'if db.execute("PRAGMA foreign_key_check").fetchall(): raise ValueError("foreign keys")',
        'db.commit(); db.close(); print("VALID")',
      ].join('\n'),
    ],
    {
      input: JSON.stringify({
        schema: source.statements,
        columns,
        registry: payload.tables.pilot_curriculum_registry_state[0],
        rows: collectionRestoreRows(payload),
      }),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  check(result.status === 0 && result.stdout.trim() === 'VALID');
}

async function authorityCheck(payload, partition, archiveIssuers) {
  const t = payload.tables,
    packages = keyed(t.pilot_curriculum_package, 'lesson_version');
  const users = keyed(t.pilot_auth_user),
    reviews = keyed(t.pilot_curriculum_review, 'review_id');
  const proofs = keyed(partition.pilot_curriculum_proof_receipt),
    owners = keyed(partition.pilot_curriculum_owner_decision);
  const publications = keyed(partition.pilot_curriculum_publication);
  const receipts = new Map(),
    proofIssuers = new Map();
  for (const [table, rows] of Object.entries(partition)) {
    if (table === 'versions') continue;
    for (const row of rows) check(exact(row, STORY_COLUMNS[table]));
  }
  for (const row of proofs.values()) {
    const receipt = parsed(row.receipt_json),
      accepted = parsed(row.accepted_issuer_json);
    check(
      validCollectionReceipt(receipt) &&
        receipt.receiptId === row.id &&
        receipt.issuerId === row.issuer_id &&
        receipt.schemaVersion === row.receipt_version &&
        receipt.issuedAt === row.issued_at &&
        integer(row.accepted_at) &&
        row.accepted_at + 300000 >= row.issued_at &&
        receipt.namespace === row.namespace &&
        digest(receipt) === row.receipt_digest,
    );
    const trust = {
      candidateId: receipt.candidateId,
      sourceDigest: receipt.sourceDigest,
      artifactDigest: receipt.artifactDigest,
      buildId: receipt.buildId,
      issuers: [],
      archiveIssuers,
    };
    const verified = await verifyCollectionProof(
      receipt,
      row.signature,
      trust,
      {
        installationId: receipt.targetInstallationId,
        lessonVersion: receipt.lessonVersion,
        contentDigest: receipt.contentDigest,
        namespace: receipt.namespace,
      },
      row.accepted_at,
      true,
    );
    check(
      same(accepted.publicKeyJwk, verified.issuer.publicKeyJwk) &&
        accepted.issuerId === verified.issuer.issuerId &&
        accepted.purpose === verified.issuer.purpose &&
        accepted.notBefore === verified.issuer.notBefore &&
        packages.get(receipt.lessonVersion)?.content_digest ===
          receipt.contentDigest,
    );
    check(
      verified.issuer.revokedAt === null ||
        row.accepted_at < verified.issuer.revokedAt,
    );
    proofIssuers.set(row.id, verified.issuer);
    receipts.set(row.id, receipt);
  }
  for (const row of owners.values()) {
    check(
      users.get(row.recorded_by)?.role === 'operator' &&
        packages.get(row.lesson_version)?.content_digest ===
          row.content_digest &&
        packages.get(row.lesson_version)?.test_run_id === row.test_run_id &&
        ['accepted', 'rejected'].includes(row.decision),
    );
    const body = request(
      row,
      'owner',
      row.recorded_by,
      row.target_installation_id,
      row.lesson_version,
      [
        'requestId',
        'contentDigest',
        'candidateId',
        'artifactDigest',
        'targetInstallationId',
        'scope',
        'ownerIdentity',
        'decision',
        'decidedAt',
        'evidenceRef',
      ],
      'r3',
    );
    check(
      body.requestId === row.id &&
        body.contentDigest === row.content_digest &&
        body.candidateId === row.candidate_id &&
        body.artifactDigest === row.artifact_digest &&
        body.targetInstallationId === row.target_installation_id &&
        body.ownerIdentity === row.owner_identity &&
        body.decision === row.decision &&
        body.decidedAt === row.decided_at &&
        body.evidenceRef === row.evidence_ref &&
        digest(parseCollectionScope(body.scope, row.lesson_version)) ===
          row.scope_digest,
    );
  }
  for (const row of publications.values()) {
    const pkg = packages.get(row.lesson_version);
    check(
      pkg?.content_digest === row.content_digest &&
        pkg.test_run_id === row.test_run_id &&
        users.get(row.actor_id)?.role === 'operator',
    );
    const body = request(
      row,
      'publication',
      row.actor_id,
      row.installation_id,
      row.lesson_version,
      [
        'requestId',
        'expectedRevision',
        'predecessorId',
        'contentDigest',
        'reviewId',
        'proofId',
        'ownerDecisionId',
        'status',
        'scope',
      ],
      'r3',
    );
    check(
      body.requestId === row.request_id &&
        body.expectedRevision === row.generation - 1 &&
        body.predecessorId === row.predecessor_id &&
        body.contentDigest === row.content_digest &&
        body.status === row.status &&
        body.reviewId === row.review_id &&
        body.proofId === row.proof_id &&
        body.ownerDecisionId === row.owner_decision_id,
    );
    const scope = parseCollectionScope(body.scope, row.lesson_version);
    check(
      digest(scope) === row.scope_digest &&
        same(
          scope.members,
          partition.pilot_curriculum_trial_member
            .filter((m) => m.publication_id === row.id)
            .map((m) => ({
              childId: m.child_id,
              parentId: m.parent_id,
              planScope: m.plan_scope,
            }))
            .sort(
              (a, b) =>
                a.childId.localeCompare(b.childId) ||
                a.parentId.localeCompare(b.parentId),
            ),
        ),
    );
    check(
      scope.members.every(
        (m) =>
          users.get(m.childId)?.role === 'child' &&
          users.get(m.parentId)?.role === 'parent',
      ),
    );
    check(
      same(parsed(row.ack_json), {
        publicationId: row.id,
        generation: row.generation,
        revision: row.generation,
        status: row.status,
      }),
    );
    if (row.generation === 1)
      check(row.predecessor_id === null && row.status === 'released');
    else {
      const previous = publications.get(row.predecessor_id);
      check(
        previous &&
          previous.generation + 1 === row.generation &&
          previous.lesson_version === row.lesson_version &&
          previous.content_digest === row.content_digest &&
          previous.installation_id === row.installation_id &&
          previous.created_at <= row.created_at,
      );
      if (row.status !== 'released') {
        for (const key of [
          'scope_kind',
          'scope_digest',
          'review_id',
          'proof_id',
          'owner_decision_id',
          'candidate_id',
          'artifact_digest',
          'test_run_id',
        ])
          check(row[key] === previous[key]);
      }
    }
    if (row.scope_kind === 'verification') {
      check(
        row.test_run_id !== null &&
          row.review_id === null &&
          row.proof_id === null &&
          row.owner_decision_id === null,
      );
    } else {
      const review = reviews.get(row.review_id),
        receipt = receipts.get(row.proof_id),
        owner = owners.get(row.owner_decision_id);
      check(
        row.scope_kind === 'supervised-trial' &&
          row.test_run_id === null &&
          review?.decision === 'approved' &&
          review.test_run_id === null &&
          review.lesson_version === row.lesson_version &&
          review.content_digest === row.content_digest &&
          review.recorded_at <= row.created_at &&
          proofs.get(row.proof_id)?.accepted_at <= row.created_at &&
          owner.decided_at <= row.created_at &&
          body.reviewId === row.review_id &&
          body.proofId === row.proof_id &&
          body.ownerDecisionId === row.owner_decision_id &&
          receipt &&
          owner?.decision === 'accepted' &&
          owner.scope_digest === row.scope_digest &&
          owner.candidate_id === row.candidate_id &&
          owner.artifact_digest === row.artifact_digest &&
          owner.target_installation_id === row.installation_id &&
          owner.lesson_version === row.lesson_version &&
          owner.content_digest === row.content_digest &&
          receipt.targetInstallationId === row.installation_id &&
          receipt.contentDigest === row.content_digest &&
          receipt.lessonVersion === row.lesson_version &&
          receipt.candidateId === row.candidate_id &&
          receipt.artifactDigest === row.artifact_digest,
      );
    }
    const audits = partition.pilot_curriculum_publication_audit.filter(
      (a) => a.publication_id === row.id,
    );
    check(
      audits.length === 1 &&
        audits[0].actor_id === row.actor_id &&
        audits[0].action === row.status &&
        audits[0].request_id === row.request_id &&
        audits[0].created_at === row.created_at,
    );
    const chain = [...publications.values()].filter(
      (p) =>
        p.installation_id === row.installation_id &&
        p.lesson_version === row.lesson_version,
    );
    const heads = partition.pilot_curriculum_publication_state.filter(
      (h) =>
        h.installation_id === row.installation_id &&
        h.lesson_version === row.lesson_version,
    );
    const max = Math.max(...chain.map((p) => p.generation));
    check(
      heads.length === 1 &&
        heads[0].revision === max &&
        publications.get(heads[0].latest_publication_id)?.generation === max,
    );
  }
  check(
    partition.pilot_curriculum_publication_audit.length === publications.size,
  );
  const chainKeys = new Set(
    [...publications.values()].map((p) =>
      json([p.installation_id, p.lesson_version]),
    ),
  );
  check(partition.pilot_curriculum_publication_state.length === chainKeys.size);
  const validAt = (publicationId, at, childId = null, parentId = null) => {
    const publication = publications.get(publicationId);
    check(
      publication?.status === 'released' &&
        integer(at) &&
        at >= publication.created_at,
    );
    const successor = [...publications.values()].find(
      (p) => p.predecessor_id === publicationId,
    );
    const laterReview =
      publication.review_id === null
        ? null
        : [...reviews.values()].find(
            (r) => r.previous_review_id === publication.review_id,
          );
    // Millisecond ties cannot order two distinct commits; live guards own that order.
    check(
      at <=
        Math.min(
          successor?.created_at ?? Infinity,
          laterReview?.recorded_at ?? Infinity,
        ),
    );
    if (childId !== null)
      check(
        partition.pilot_curriculum_trial_member.some(
          (m) =>
            m.publication_id === publicationId &&
            m.child_id === childId &&
            (parentId === null || m.parent_id === parentId),
        ),
      );
    if (publication.proof_id !== null) {
      const proof = proofs.get(publication.proof_id),
        issuer = proofIssuers.get(publication.proof_id);
      check(
        proof &&
          issuer &&
          at >= proof.accepted_at &&
          (issuer.revokedAt === null || at <= issuer.revokedAt),
      );
    }
  };
  for (const p of publications.values())
    if (p.status === 'released') validAt(p.id, p.created_at);
  return { packages, publications, reviews, users, validAt };
}

async function learningCheck(payload, authority) {
  const t = payload.tables;
  const collections = keyed(t.pilot_collection, 'collection_version'),
    proposals = keyed(t.pilot_collection_proposal);
  const plans = keyed(t.pilot_collection_plan),
    assignments = keyed(t.pilot_collection_assignment),
    schedules = keyed(t.pilot_collection_schedule);
  const runs = keyed(t.pilot_collection_run),
    compiled = new Map();
  for (const row of collections.values()) {
    const manifest = validateCollectionManifest(parsed(row.manifest_json));
    check(
      digest(manifest) === row.collection_digest &&
        manifest.collectionId === row.collection_id &&
        manifest.collectionVersion === row.collection_version &&
        manifest.canonicalizationVersion === row.canonicalization_version &&
        authority.users.get(row.imported_by)?.role === 'operator',
    );
    const items = t.pilot_collection_item
      .filter((i) => i.collection_version === row.collection_version)
      .sort((a, b) => a.ordinal - b.ordinal);
    check(items.length === 10);
    const characters = new Set();
    for (let index = 0; index < items.length; index++) {
      const i = items[index],
        wanted = manifest.items[index],
        pkg = authority.packages.get(i.lesson_version);
      check(
        i.ordinal === index &&
          i.sequence === index + 1 &&
          i.track_id === manifest.trackId &&
          i.collection_digest === row.collection_digest &&
          i.lesson_version === wanted.lessonVersion &&
          i.content_digest === wanted.contentDigest &&
          same(
            parsed(i.prerequisites_json),
            wanted.introductionPrerequisites,
          ) &&
          pkg?.content_digest === i.content_digest,
      );
      const value = parsed(pkg.manifest_json),
        lesson = await compilePairedRuntime(value);
      check(
        lesson.identity.contentDigest === i.content_digest &&
          value.placement.trackId === i.track_id &&
          value.placement.sequence === i.sequence,
      );
      value.characters.forEach((c) => characters.add(c.hanzi));
      compiled.set(i.lesson_version, lesson);
    }
    check(characters.size === 20);
    await validateCollectionPackages(
      manifest,
      items.map((i) =>
        parsed(authority.packages.get(i.lesson_version).manifest_json),
      ),
    );
  }
  for (const row of proposals.values()) {
    authority.validAt(
      row.publication_id,
      row.created_at,
      row.child_id,
      row.actor_id,
    );
    const body = request(
      row,
      'proposal',
      row.actor_id,
      row.installation_id,
      row.child_id,
      [
        'collectionVersion',
        'lessonVersion',
        'predecessorProposalId',
        'expectedSourceDigest',
      ],
    );
    const source = parsed(row.source_json);
    check(
      exact(source, [
        'schemaVersion',
        'policyVersion',
        'childId',
        'installationId',
        'collectionVersion',
        'collectionDigest',
        'actorId',
        'selectionOrdinal',
        'predecessorProposalId',
        'predecessorSourceDigest',
        'lessonVersion',
        'contentDigest',
        'publicationId',
        'generation',
        'selectedByParent',
        'onboardingDigest',
        'evidenceDigest',
        'publicationDigest',
        'reason',
        'createdAt',
      ]) &&
        source.schemaVersion === 'r5-placement-source-1' &&
        source.policyVersion === row.policy_version &&
        row.policy_version === 'r5-placement-1' &&
        digest(source) === row.source_digest &&
        source.childId === row.child_id &&
        source.installationId === row.installation_id &&
        source.actorId === row.actor_id &&
        source.collectionVersion === row.collection_version &&
        source.collectionDigest === row.collection_digest &&
        source.lessonVersion === row.lesson_version &&
        source.contentDigest === row.content_digest &&
        source.publicationId === row.publication_id &&
        source.generation ===
          authority.publications.get(row.publication_id)?.generation &&
        source.selectionOrdinal === row.selection_ordinal &&
        source.predecessorProposalId === row.predecessor_id &&
        source.predecessorSourceDigest === row.predecessor_source_digest &&
        source.selectedByParent === Boolean(row.selected_by_parent) &&
        source.onboardingDigest === row.onboarding_digest &&
        source.evidenceDigest === row.evidence_digest &&
        source.publicationDigest === row.publication_digest &&
        source.createdAt === row.created_at &&
        same(parsed(row.reason_json), { text: source.reason }) &&
        body.collectionVersion === row.collection_version &&
        (body.lessonVersion === null ||
          body.lessonVersion === row.lesson_version) &&
        body.predecessorProposalId === row.predecessor_id &&
        body.expectedSourceDigest === row.predecessor_source_digest &&
        authority.users.get(row.actor_id)?.role === 'parent' &&
        authority.users.get(row.child_id)?.role === 'child',
    );
  }
  for (const row of plans.values()) {
    const proposal = proposals.get(row.proposal_id);
    check(
      proposal &&
        row.approved_at >= proposal.created_at &&
        row.approved_at < proposal.expires_at,
    );
    const successor = [...proposals.values()].find(
      (p) => p.predecessor_id === proposal.id,
    );
    check(!successor || row.approved_at <= successor.created_at);
    authority.validAt(
      proposal.publication_id,
      row.approved_at,
      row.child_id,
      row.parent_id,
    );
    const body = request(
      row,
      'approval',
      row.parent_id,
      row.installation_id,
      row.child_id,
      ['proposalId', 'sourceDigest'],
    );
    check(
      body.proposalId === row.proposal_id &&
        body.sourceDigest === row.source_digest &&
        authority.users.get(row.parent_id)?.role === 'parent' &&
        same(parsed(row.ack_json), {
          planId: row.id,
          proposalId: row.proposal_id,
          sourceDigest: row.source_digest,
          approvedAt: new Date(row.approved_at).toISOString(),
        }),
    );
    check(
      t.pilot_collection_plan_item.filter((i) => i.plan_id === row.id)
        .length === 1 &&
        t.pilot_collection_learning_audit.filter(
          (a) => a.plan_id === row.id && a.action === 'plan-approval',
        ).length === 1,
    );
  }
  for (const row of t.pilot_collection_plan_item)
    check(
      t.pilot_collection_assignment.filter((a) => a.plan_item_id === row.id)
        .length === 1,
    );
  for (const a of assignments.values()) {
    const slots = [...schedules.values()].filter(
      (s) => s.assignment_id === a.id,
    );
    const initial = [...runs.values()].find(
      (r) => r.assignment_id === a.id && r.phase === 'initial',
    );
    check(
      slots.filter((s) => s.kind === 'initial').length === 1 &&
        slots.length ===
          (initial?.completed_at !== null && initial !== undefined ? 3 : 1),
    );
    if (initial?.completed_at != null)
      check(
        ['review-24h', 'review-7d'].every((k) =>
          slots.some((s) => s.kind === k),
        ),
      );
  }
  for (const row of runs.values()) {
    authority.validAt(row.publication_id, row.created_at, row.child_id);
    const lesson = compiled.get(row.lesson_version);
    check(lesson && row.seed === collectionSeed(row.assignment_id));
    const run = validatePairedRun(lesson, parsed(row.run_json));
    const events = t.pilot_collection_event
      .filter((e) => e.run_id === row.id)
      .sort((a, b) => a.sequence - b.sequence);
    const requestRow = {
      request_json: row.start_request_json,
      request_digest: row.start_request_digest,
    };
    const start = request(
      requestRow,
      'start',
      row.child_id,
      row.installation_id,
      row.assignment_id,
      ['requestId', 'scheduleId'],
    );
    check(
      start.requestId === row.start_request_id &&
        start.scheduleId === row.schedule_id &&
        same(parsed(row.start_ack_json), {
          runId: row.id,
          assignmentId: row.assignment_id,
          scheduleId: row.schedule_id,
          lessonVersion: row.lesson_version,
          revision: 0,
        }) &&
        run.runId === row.id &&
        run.revision === row.revision &&
        run.seed === row.seed &&
        run.state.phase === row.phase &&
        run.createdAt === new Date(row.created_at).toISOString() &&
        run.updatedAt === new Date(row.updated_at).toISOString() &&
        run.state.completedAt ===
          (row.completed_at === null
            ? null
            : new Date(row.completed_at).toISOString()) &&
        run.identity.contentDigest === row.content_digest &&
        run.identity.lessonVersion === row.lesson_version &&
        run.events.length === events.length &&
        events.length === row.revision &&
        t.pilot_collection_learning_audit.filter(
          (a) => a.run_id === row.id && a.action === 'run-start',
        ).length === 1,
    );
    for (let i = 0; i < events.length; i++) {
      const e = events[i],
        result = parsed(e.result_json),
        action = parsed(e.action_json),
        event = run.events[i];
      check(
        e.sequence === i + 1 &&
          e.expected_revision === i &&
          e.event_id === action.eventId &&
          e.request_digest ===
            digest({
              schemaVersion: 'r5-action-request-1',
              actorId: row.child_id,
              installationId: row.installation_id,
              resourceId: row.id,
              request: action,
            }) &&
          exact(result, ['event', 'ack', 'policy']) &&
          same(result.event, event) &&
          same(result.ack, {
            eventId: event.eventId,
            revision: event.sequence,
            result: event.result,
          }) &&
          e.server_at === Date.parse(event.serverTime) &&
          same(event.action, action) &&
          t.pilot_collection_learning_audit.filter(
            (a) => a.event_id === e.id && a.action === 'run-action',
          ).length === 1,
      );
      authority.validAt(row.publication_id, e.server_at, row.child_id);
      const p = authority.publications.get(result.policy.publicationId);
      check(
        exact(result.policy, [
          'soundReview',
          'publicationId',
          'generation',
          'reviewId',
          'scopeKind',
          'candidateId',
        ]) &&
          p?.id === row.publication_id &&
          p.generation === result.policy.generation &&
          p.review_id === result.policy.reviewId &&
          p.scope_kind === result.policy.scopeKind &&
          p.candidate_id === result.policy.candidateId &&
          result.policy.soundReview === event.soundReview &&
          (p.scope_kind === 'verification'
            ? result.policy.soundReview === 'synthetic' ||
              result.policy.soundReview === 'pending'
            : result.policy.soundReview === 'reviewed'),
      );
    }
  }
}

export async function validatePilotCollectionBackup(
  input,
  { archiveIssuers = [], source = collectionSchemaSource() } = {},
) {
  try {
    const payload = validateCollectionRows(input, source);
    await validatePilotStoryBackup(collectionLegacyPayload(payload), {
      archiveIssuers,
    });
    await validateCollectionHistory(payload, { archiveIssuers, source });
    return payload;
  } catch {
    collectionBackupInvalid();
  }
}

/** Shared internal domain checks for an already-inspected V5 or V6 union.
 * This does not select an archive format and never grants restore authority. */
export async function validateCollectionHistory(
  payload,
  { archiveIssuers = [], source = collectionSchemaSource() } = {},
) {
  validateCollectionRowFields(payload);
  relationalCheck(payload, source);
  const partition = collectionAuthorityPartition(payload);
  const authority = await authorityCheck(payload, partition, archiveIssuers);
  await learningCheck(payload, authority);
}
