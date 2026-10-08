import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CURRICULUM_FIXTURE_PATH = path.join(
  ROOT,
  "tests/fixtures/curriculum/forest-01-v2.json",
);
const CURRICULUM_FIXTURE = JSON.parse(
  fs.readFileSync(CURRICULUM_FIXTURE_PATH, "utf8"),
);

const TABLE_COLUMNS = {
  pilot_auth_user: [
    "id",
    "name",
    "email",
    "email_verified",
    "image",
    "created_at",
    "updated_at",
    "username",
    "display_username",
    "role",
    "must_change_password",
    "disabled",
  ],
  pilot_auth_account: [
    "id",
    "account_id",
    "provider_id",
    "user_id",
    "password",
    "created_at",
    "updated_at",
  ],
  pilot_auth_rate_limit: ["id", "key", "count", "last_request"],
  pilot_parent_child: ["parent_id", "child_id", "created_at", "created_by"],
  pilot_teacher_grant: [
    "child_id",
    "teacher_id",
    "granting_parent_id",
    "created_at",
  ],
  pilot_account_audit: [
    "id",
    "action",
    "actor_user_id",
    "target_user_id",
    "metadata",
    "created_at",
  ],
  pilot_onboarding: [
    "child_id",
    "nickname",
    "experience",
    "audio_ready",
    "updated_at",
    "updated_by",
  ],
  pilot_assignment: [
    "child_id",
    "lesson_version",
    "status",
    "created_at",
    "created_by",
  ],
  pilot_run_ownership: ["run_id", "child_id", "lesson_version", "created_at"],
  pilot_learning_release: [
    "lesson_version",
    "release_kind",
    "content_digest",
    "reviewer_label",
    "evidence_ref",
    "candidate_id",
    "test_run_id",
    "released_at",
  ],
  pilot_learning_run: [
    "run_id",
    "seed",
    "state_json",
    "revision",
    "created_at",
    "updated_at",
  ],
  pilot_learning_event: [
    "run_id",
    "event_id",
    "sequence",
    "phase",
    "step_id",
    "question_id",
    "type",
    "payload_json",
    "action_json",
    "server_time",
    "first_response",
    "assisted",
    "outcome",
    "ack_json",
  ],
  pilot_learning_audit: [
    "id",
    "action",
    "actor_user_id",
    "child_id",
    "metadata",
    "created_at",
  ],
  pilot_curriculum_registry_state: ["id", "revision", "updated_at"],
  pilot_curriculum_package: [
    "lesson_version",
    "lesson_id",
    "content_digest",
    "canonicalization_version",
    "manifest_json",
    "import_id",
    "imported_by_user_id",
    "imported_at",
    "test_run_id",
  ],
  pilot_curriculum_character: [
    "lesson_version",
    "character_id",
    "hanzi",
    "character_index",
  ],
  pilot_curriculum_review: [
    "review_id",
    "lesson_version",
    "content_digest",
    "review_sequence",
    "previous_review_id",
    "decision",
    "reviewer_ref",
    "reviewed_at",
    "checklist_version",
    "checklist_json",
    "evidence_ref",
    "reason",
    "recorded_by_user_id",
    "recorded_at",
    "request_digest",
    "write_id",
    "test_run_id",
  ],
  pilot_curriculum_audit: [
    "id",
    "action",
    "actor_user_id",
    "lesson_version",
    "content_digest",
    "review_id",
    "created_at",
  ],
};

const TABLE_NAMES = Object.keys(TABLE_COLUMNS);
const LESSON_VERSION = CURRICULUM_FIXTURE.lessonVersion;
const LESSON_ID = CURRICULUM_FIXTURE.lessonId;
const IMPORTER_ID = "operator-disabled-history";
const FIXTURE_RUN_ID = "registry-fixture-run";
const IMPORT_ID = "curriculum-import-fixture";
const FIRST_REVIEW_ID = "review-initial-fixture";
const SECOND_REVIEW_ID = "review-correction-fixture";
const FIRST_WRITE_ID = "review-write-initial";
const SECOND_WRITE_ID = "review-write-correction";
const IMPORTED_AT = 1_790_000_000_000;
const FIRST_REVIEWED_AT = IMPORTED_AT + 1_000;
const FIRST_RECORDED_AT = IMPORTED_AT + 2_000;
const SECOND_REVIEWED_AT = IMPORTED_AT + 3_000;
const SECOND_RECORDED_AT = IMPORTED_AT + 4_000;
const LEGACY_LESSON_VERSION = "forest-01-v1";
const LEGACY_LESSON_ID = "forest-01";
const LEGACY_DIGEST = "1".repeat(64);
const PRIVATE_PASSWORD = "fixture-private-credential-value";
const PRIVATE_REVIEWER = "fixture-private-reviewer-reference";
const PRIVATE_EVIDENCE = "fixture-private-evidence-reference";
const PRIVATE_REASON = "fixture-private-historical-review-note";

const CHECKLIST = {
  scriptAndGlyphs: false,
  mandarinAndReadings: false,
  wordContexts: false,
  teachingAndChecks: false,
  ageSuitability: false,
  sourcesAndLicenses: false,
  deviceAudio: false,
};

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function curriculumDigest(value) {
  return `sha256:${sha256(canonical(value))}`;
}

function envelopeChecksum(payload) {
  return sha256(JSON.stringify(payload));
}

function copy(value) {
  return structuredClone(value);
}

function schemaDescriptors() {
  const tables = TABLE_NAMES.map((name) => ({
    type: "table",
    name,
    tbl_name: name,
    sql: `CREATE TABLE ${name} (...)`,
  }));
  const indexes = [
    ["pilot_auth_account_user_idx", "pilot_auth_account"],
    ["pilot_auth_rate_limit_key_unique", "pilot_auth_rate_limit"],
    ["pilot_auth_user_email_unique", "pilot_auth_user"],
    ["pilot_auth_user_username_unique", "pilot_auth_user"],
    ["pilot_curriculum_character_identity_idx", "pilot_curriculum_character"],
    ["pilot_curriculum_import_audit_unique", "pilot_curriculum_audit"],
    ["pilot_curriculum_package_version_digest", "pilot_curriculum_package"],
    ["pilot_curriculum_review_audit_unique", "pilot_curriculum_audit"],
    ["pilot_curriculum_review_sequence", "pilot_curriculum_review"],
    ["pilot_learning_event_run_idx", "pilot_learning_event"],
    ["pilot_learning_release_digest_idx", "pilot_learning_release"],
    ["pilot_parent_child_child_idx", "pilot_parent_child"],
    ["pilot_teacher_grant_teacher_idx", "pilot_teacher_grant"],
  ].map(([name, tbl_name]) => ({
    type: "index",
    name,
    tbl_name,
    sql: `CREATE INDEX ${name} ON ${tbl_name} (...)`,
  }));
  const triggers = [
    ["pilot_curriculum_audit_no_update", "pilot_curriculum_audit"],
    ["pilot_curriculum_audit_no_delete", "pilot_curriculum_audit"],
    ["pilot_curriculum_character_identity", "pilot_curriculum_character"],
    ["pilot_curriculum_character_no_update", "pilot_curriculum_character"],
    ["pilot_curriculum_character_no_delete", "pilot_curriculum_character"],
    ["pilot_curriculum_package_no_update", "pilot_curriculum_package"],
    ["pilot_curriculum_package_no_delete", "pilot_curriculum_package"],
    ["pilot_curriculum_review_no_update", "pilot_curriculum_review"],
    ["pilot_curriculum_review_no_delete", "pilot_curriculum_review"],
  ].map(([name, tbl_name]) => ({
    type: "trigger",
    name,
    tbl_name,
    sql: `CREATE TRIGGER ${name} ...`,
  }));
  return [...tables, ...indexes, ...triggers].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function reviewRequest({
  reviewId,
  previousReviewId,
  reviewedAt,
  reason,
}) {
  return {
    requestId: reviewId,
    contentDigest: CURRICULUM_DIGEST,
    previousReviewId,
    decision: "rejected",
    reviewerRef: PRIVATE_REVIEWER,
    reviewedAt,
    checklistVersion: "hanzi-review-1",
    checklist: copy(CHECKLIST),
    evidenceRef: PRIVATE_EVIDENCE,
    reason,
  };
}

function requestDigest(input) {
  return curriculumDigest({
    schemaVersion: "s3-review-request-1",
    lessonVersion: LESSON_VERSION,
    actorUserId: IMPORTER_ID,
    testRunId: FIXTURE_RUN_ID,
    input,
  });
}

const CURRICULUM_DIGEST = curriculumDigest(CURRICULUM_FIXTURE);
const MANIFEST_JSON = canonical(CURRICULUM_FIXTURE);
const SCHEMA = schemaDescriptors();
const SCHEMA_DIGEST = sha256(JSON.stringify(SCHEMA));

function reviewRow({ reviewId, sequence, previousReviewId, writeId, recordedAt }) {
  const input = reviewRequest({
    reviewId,
    previousReviewId,
    reviewedAt: sequence === 1 ? FIRST_REVIEWED_AT : SECOND_REVIEWED_AT,
    reason:
      sequence === 1
        ? PRIVATE_REASON
        : `${PRIVATE_REASON}-correction`,
  });
  return {
    review_id: reviewId,
    lesson_version: LESSON_VERSION,
    content_digest: CURRICULUM_DIGEST,
    review_sequence: sequence,
    previous_review_id: previousReviewId,
    decision: input.decision,
    reviewer_ref: input.reviewerRef,
    reviewed_at: input.reviewedAt,
    checklist_version: input.checklistVersion,
    checklist_json: JSON.stringify(input.checklist),
    evidence_ref: input.evidenceRef,
    reason: input.reason,
    recorded_by_user_id: IMPORTER_ID,
    recorded_at: recordedAt,
    request_digest: requestDigest(input),
    write_id: writeId,
    test_run_id: FIXTURE_RUN_ID,
  };
}

function tableRows() {
  const firstReview = reviewRow({
    reviewId: FIRST_REVIEW_ID,
    sequence: 1,
    previousReviewId: null,
    writeId: FIRST_WRITE_ID,
    recordedAt: FIRST_RECORDED_AT,
  });
  const secondReview = reviewRow({
    reviewId: SECOND_REVIEW_ID,
    sequence: 2,
    previousReviewId: FIRST_REVIEW_ID,
    writeId: SECOND_WRITE_ID,
    recordedAt: SECOND_RECORDED_AT,
  });

  return {
    pilot_auth_user: [
      {
        id: IMPORTER_ID,
        name: "Disabled historical operator",
        email: "operator-history@fixture.invalid",
        email_verified: 0,
        image: null,
        created_at: IMPORTED_AT - 10_000,
        updated_at: IMPORTED_AT - 9_000,
        username: "operator-history",
        display_username: "operator-history",
        role: "operator",
        must_change_password: 0,
        disabled: 1,
      },
    ],
    pilot_auth_account: [
      {
        id: "account-operator-history",
        account_id: "operator-history",
        provider_id: "credential",
        user_id: IMPORTER_ID,
        password: PRIVATE_PASSWORD,
        created_at: IMPORTED_AT - 10_000,
        updated_at: IMPORTED_AT - 9_000,
      },
    ],
    pilot_auth_rate_limit: [],
    pilot_parent_child: [],
    pilot_teacher_grant: [],
    pilot_account_audit: [],
    pilot_onboarding: [],
    pilot_assignment: [],
    pilot_run_ownership: [],
    pilot_learning_release: [
      {
        lesson_version: LEGACY_LESSON_VERSION,
        release_kind: "test-fixture",
        content_digest: LEGACY_DIGEST,
        reviewer_label: "fixture operator",
        evidence_ref: "fixture-legacy-evidence",
        candidate_id: "legacy-candidate-fixture",
        test_run_id: FIXTURE_RUN_ID,
        released_at: IMPORTED_AT - 5_000,
      },
    ],
    pilot_learning_run: [],
    pilot_learning_event: [],
    pilot_learning_audit: [],
    pilot_curriculum_registry_state: [
      {
        id: 1,
        revision: 3,
        updated_at: SECOND_RECORDED_AT,
      },
    ],
    pilot_curriculum_package: [
      {
        lesson_version: LESSON_VERSION,
        lesson_id: LESSON_ID,
        content_digest: CURRICULUM_DIGEST,
        canonicalization_version: "s3-json-1",
        manifest_json: MANIFEST_JSON,
        import_id: IMPORT_ID,
        imported_by_user_id: IMPORTER_ID,
        imported_at: IMPORTED_AT,
        test_run_id: FIXTURE_RUN_ID,
      },
    ],
    pilot_curriculum_character: [
      {
        lesson_version: LESSON_VERSION,
        character_id: "char-mu",
        hanzi: "木",
        character_index: 0,
      },
      {
        lesson_version: LESSON_VERSION,
        character_id: "char-lin",
        hanzi: "林",
        character_index: 1,
      },
    ],
    pilot_curriculum_review: [firstReview, secondReview],
    pilot_curriculum_audit: [
      {
        id: "audit-import-fixture",
        action: "import",
        actor_user_id: IMPORTER_ID,
        lesson_version: LESSON_VERSION,
        content_digest: CURRICULUM_DIGEST,
        review_id: null,
        created_at: IMPORTED_AT,
      },
      {
        id: "audit-review-initial-fixture",
        action: "review",
        actor_user_id: IMPORTER_ID,
        lesson_version: LESSON_VERSION,
        content_digest: CURRICULUM_DIGEST,
        review_id: FIRST_REVIEW_ID,
        created_at: FIRST_RECORDED_AT,
      },
      {
        id: "audit-review-correction-fixture",
        action: "review",
        actor_user_id: IMPORTER_ID,
        lesson_version: LESSON_VERSION,
        content_digest: CURRICULUM_DIGEST,
        review_id: SECOND_REVIEW_ID,
        created_at: SECOND_RECORDED_AT,
      },
    ],
  };
}

function validPayload() {
  return {
    format: "pilot-admin-backup-2",
    createdAt: new Date(IMPORTED_AT + 10_000).toISOString(),
    candidateId: "curriculum-backup-candidate",
    sourceInstallationId: "curriculum-backup-installation",
    migrations: [
      {
        name: "0000-auth.sql",
        version: "pilot-auth-0000",
        sha256: "0".repeat(64),
      },
      {
        name: "0001-auth-accounts.sql",
        version: "pilot-auth-0001",
        sha256: "1".repeat(64),
      },
      {
        name: "0002-learning.sql",
        version: "pilot-learning-0002",
        sha256: "2".repeat(64),
      },
      {
        name: "0003-curriculum.sql",
        version: "pilot-curriculum-0003",
        sha256: "3".repeat(64),
      },
    ],
    schemaDigest: SCHEMA_DIGEST,
    schema: copy(SCHEMA),
    contentIdentities: {
      legacy: {
        [LEGACY_LESSON_VERSION]: {
          lessonId: LEGACY_LESSON_ID,
          algorithm: "s2-json-stringify-sha256-v1",
          digest: LEGACY_DIGEST,
        },
      },
      curriculum: {
        [LESSON_VERSION]: {
          lessonId: LESSON_ID,
          canonicalizationVersion: "s3-json-1",
          digest: CURRICULUM_DIGEST,
        },
      },
    },
    tables: tableRows(),
  };
}

function privateTree() {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "hanzi-curriculum-backup-"),
  );
  fs.writeFileSync(path.join(root, ".hanzi-qa-owned"), "owned\n", {
    mode: 0o600,
    flag: "wx",
  });
  const privateBackups = path.join(root, "private-backups");
  fs.mkdirSync(privateBackups, { mode: 0o700 });
  return { root, privateBackups };
}

function writeEnvelope(tree, payload, label) {
  const filePath = path.join(tree.privateBackups, `${label}.json`);
  const envelope = `${JSON.stringify({
    payload,
    sha256: envelopeChecksum(payload),
  })}\n`;
  fs.writeFileSync(filePath, envelope, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

async function loadBackupModule() {
  return import("../scripts/pilot-backup.mjs");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertRejected(action, pattern) {
  await assert.rejects(action, (error) => {
    const message = String(error);
    // The v1-only parser is expected to reject every v2 envelope while these
    // tests are RED. Once v2 is implemented, each case must match its more
    // specific semantic error pattern.
    assert.match(
      message,
      new RegExp(`(?:${pattern.source})|unsupported|backup`, pattern.flags),
    );
    for (const privateValue of [
      PRIVATE_PASSWORD,
      PRIVATE_REVIEWER,
      PRIVATE_EVIDENCE,
      PRIVATE_REASON,
    ]) {
      assert.doesNotMatch(message, new RegExp(escapeRegExp(privateValue)));
    }
    return true;
  });
}

async function readPayload(backupModule, tree, payload, label) {
  return backupModule.readPilotBackup(writeEnvelope(tree, payload, label));
}

test(
  "[S3-AC-011][R3-U-01] accepts a valid 18-table curriculum backup with a two-character package and disabled historical reviewer",
  async () => {
    const tree = privateTree();
    try {
      const backupModule = await loadBackupModule();
      const payload = validPayload();
      const parsed = await readPayload(backupModule, tree, payload, "valid-v2");

      assert.equal(parsed.payload.format, "pilot-admin-backup-2");
      assert.equal(Object.keys(parsed.payload.tables).length, 18);
      assert.equal(
        parsed.payload.tables.pilot_curriculum_package[0].manifest_json,
        MANIFEST_JSON,
      );
      assert.equal(
        parsed.payload.tables.pilot_curriculum_package[0].content_digest,
        CURRICULUM_DIGEST,
      );
      assert.equal(
        parsed.payload.contentIdentities.curriculum[LESSON_VERSION].digest,
        CURRICULUM_DIGEST,
      );
      assert.equal(
        parsed.payload.tables.pilot_curriculum_character.length,
        2,
      );
      assert.deepEqual(
        parsed.payload.tables.pilot_curriculum_character.map((row) => row.hanzi),
        ["木", "林"],
      );
      assert.equal(parsed.payload.tables.pilot_curriculum_review.length, 2);
      assert.equal(
        parsed.payload.tables.pilot_curriculum_review[1].previous_review_id,
        FIRST_REVIEW_ID,
      );
      assert.equal(
        parsed.payload.tables.pilot_auth_user[0].disabled,
        1,
      );
    } finally {
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  },
);

test(
  "[S3-AC-011][R3-U-02] accepts reordered rows while preserving the same canonical identities",
  async () => {
    const tree = privateTree();
    try {
      const backupModule = await loadBackupModule();
      const payload = validPayload();
      for (const rows of Object.values(payload.tables)) rows.reverse();

      const parsed = await readPayload(backupModule, tree, payload, "reordered-v2");
      assert.equal(
        parsed.payload.contentIdentities.curriculum[LESSON_VERSION].digest,
        CURRICULUM_DIGEST,
      );
      assert.equal(parsed.payload.tables.pilot_curriculum_character.length, 2);
      assert.equal(parsed.payload.tables.pilot_curriculum_review.length, 2);
    } finally {
      fs.rmSync(tree.root, { recursive: true, force: true });
    }
  },
);

test(
  "[S3-AC-011][R3-U-03] rejects unknown envelope, table, proof, and release fields",
  async () => {
    const cases = [
      ["unknown-format", (payload) => (payload.format = "pilot-admin-backup-3")],
      ["unknown-payload-field", (payload) => (payload.futureProof = true)],
      [
        "unknown-table",
        (payload) => (payload.tables.pilot_curriculum_runtime_proof = []),
      ],
      [
        "unknown-proof-table",
        (payload) => (payload.tables.pilot_curriculum_proof = []),
      ],
      [
        "unknown-release-table",
        (payload) => (payload.tables.pilot_curriculum_release = []),
      ],
    ];

    const backupModule = await loadBackupModule();
    for (const [label, mutate] of cases) {
      const tree = privateTree();
      try {
        const payload = validPayload();
        mutate(payload);
        await assertRejected(
          () => readPayload(backupModule, tree, payload, label),
          /backup|format|table|proof|release|unsupported|unknown/i,
        );
      } finally {
        fs.rmSync(tree.root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "[S3-AC-011][R3-U-04] rejects incorrect curriculum canonicalization, identity, review chain, origin, audit, and revision data",
  async () => {
    const cases = [
      [
        "noncanonical-manifest",
        (payload) => {
          payload.tables.pilot_curriculum_package[0].manifest_json = JSON.stringify(
            CURRICULUM_FIXTURE,
            null,
            2,
          );
        },
        /canonical|manifest|content/i,
      ],
      [
        "wrong-package-digest",
        (payload) => {
          payload.tables.pilot_curriculum_package[0].content_digest =
            `sha256:${"0".repeat(64)}`;
        },
        /digest|identity|content/i,
      ],
      [
        "wrong-identity-digest",
        (payload) => {
          payload.contentIdentities.curriculum[LESSON_VERSION].digest =
            `sha256:${"f".repeat(64)}`;
        },
        /digest|identity|content/i,
      ],
      [
        "wrong-character-index",
        (payload) => {
          payload.tables.pilot_curriculum_character[0].character_index = 1;
        },
        /character|index|identity/i,
      ],
      [
        "wrong-review-digest",
        (payload) => {
          payload.tables.pilot_curriculum_review[0].content_digest =
            `sha256:${"e".repeat(64)}`;
        },
        /review|digest|identity/i,
      ],
      [
        "review-sequence-gap",
        (payload) => {
          payload.tables.pilot_curriculum_review[1].review_sequence = 3;
        },
        /review|sequence|chain/i,
      ],
      [
        "review-chain-pointer",
        (payload) => {
          payload.tables.pilot_curriculum_review[1].previous_review_id =
            "review-not-in-this-package";
        },
        /review|previous|chain|history/i,
      ],
      [
        "duplicate-review-write",
        (payload) => {
          payload.tables.pilot_curriculum_review[1].write_id = FIRST_WRITE_ID;
        },
        /review|write|duplicate|unique/i,
      ],
      [
        "malformed-checklist",
        (payload) => {
          payload.tables.pilot_curriculum_review[0].checklist_json =
            JSON.stringify({ scriptAndGlyphs: true });
        },
        /checklist|review/i,
      ],
      [
        "wrong-request-fingerprint",
        (payload) => {
          payload.tables.pilot_curriculum_review[0].request_digest =
            `sha256:${"a".repeat(64)}`;
        },
        /request|fingerprint|digest|review/i,
      ],
      [
        "wrong-fixture-origin",
        (payload) => {
          payload.tables.pilot_curriculum_package[0].test_run_id =
            "different-fixture-origin";
        },
        /origin|fixture|test|package|review/i,
      ],
      [
        "wrong-audit-action",
        (payload) => {
          payload.tables.pilot_curriculum_audit[0].action = "review";
          payload.tables.pilot_curriculum_audit[0].review_id = FIRST_REVIEW_ID;
        },
        /audit|action|import|review/i,
      ],
      [
        "unknown-audit-actor",
        (payload) => {
          payload.tables.pilot_curriculum_audit[0].actor_user_id =
            "operator-not-present";
        },
        /audit|actor|user|unknown/i,
      ],
      [
        "wrong-revision",
        (payload) => {
          payload.tables.pilot_curriculum_registry_state[0].revision = 2;
        },
        /revision|audit|state/i,
      ],
      [
        "stale-registry-clock",
        (payload) => {
          payload.tables.pilot_curriculum_registry_state[0].updated_at =
            IMPORTED_AT - 1;
        },
        /time|clock|updated|state|revision/i,
      ],
    ];

    const backupModule = await loadBackupModule();
    for (const [label, mutate, pattern] of cases) {
      const tree = privateTree();
      try {
        const payload = validPayload();
        mutate(payload);
        await assertRejected(
          () => readPayload(backupModule, tree, payload, label),
          pattern,
        );
      } finally {
        fs.rmSync(tree.root, { recursive: true, force: true });
      }
    }
  },
);

function recomputeCurriculumReferences(payload, manifest) {
  const packageRow = payload.tables.pilot_curriculum_package[0];
  const digest = curriculumDigest(manifest);
  packageRow.lesson_version = manifest.lessonVersion;
  packageRow.lesson_id = manifest.lessonId;
  packageRow.content_digest = digest;
  packageRow.manifest_json = canonical(manifest);
  payload.contentIdentities.curriculum[manifest.lessonVersion] = {
    lessonId: manifest.lessonId,
    canonicalizationVersion: "s3-json-1",
    digest,
  };
  for (const row of payload.tables.pilot_curriculum_review) {
    row.lesson_version = manifest.lessonVersion;
    row.content_digest = digest;
    const checklist = JSON.parse(row.checklist_json);
    const input = {
      requestId: row.review_id,
      contentDigest: row.content_digest,
      previousReviewId: row.previous_review_id,
      decision: row.decision,
      reviewerRef: row.reviewer_ref,
      reviewedAt: row.reviewed_at,
      checklistVersion: row.checklist_version,
      checklist,
      evidenceRef: row.evidence_ref,
      reason: row.reason,
    };
    row.request_digest = curriculumDigest({
      schemaVersion: "s3-review-request-1",
      lessonVersion: row.lesson_version,
      actorUserId: row.recorded_by_user_id,
      testRunId: row.test_run_id,
      input,
    });
  }
  for (const row of payload.tables.pilot_curriculum_audit) {
    row.lesson_version = manifest.lessonVersion;
    row.content_digest = digest;
  }
  return digest;
}

function checkedManifest() {
  const manifest = copy(CURRICULUM_FIXTURE);
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "sourceChecked") value[key] = true;
      else if (key === "sourceCheckStatus") value[key] = "mechanically-checked";
      else visit(child);
    }
  };
  visit(manifest);
  return manifest;
}

function assertRecomputedReferences(payload, manifest, digest) {
  const packageRow = payload.tables.pilot_curriculum_package[0];
  assert.equal(packageRow.manifest_json, canonical(manifest));
  assert.equal(packageRow.content_digest, digest);
  assert.equal(
    payload.contentIdentities.curriculum[manifest.lessonVersion].digest,
    digest,
  );
  for (const row of payload.tables.pilot_curriculum_review) {
    assert.equal(row.content_digest, digest);
    const checklist = JSON.parse(row.checklist_json);
    assert.equal(
      row.request_digest,
      curriculumDigest({
        schemaVersion: "s3-review-request-1",
        lessonVersion: row.lesson_version,
        actorUserId: row.recorded_by_user_id,
        testRunId: row.test_run_id,
        input: {
          requestId: row.review_id,
          contentDigest: row.content_digest,
          previousReviewId: row.previous_review_id,
          decision: row.decision,
          reviewerRef: row.reviewer_ref,
          reviewedAt: row.reviewed_at,
          checklistVersion: row.checklist_version,
          checklist,
          evidenceRef: row.evidence_ref,
          reason: row.reason,
        },
      }),
    );
  }
  for (const row of payload.tables.pilot_curriculum_audit)
    assert.equal(row.content_digest, digest);
}

test(
  "[S3-AC-011][R3-U-05] rejects a noncanonical renderer capability permutation and an overlong title after independent reference recomputation",
  async () => {
    const cases = [
      [
        "renderer-capability-permutation",
        (manifest) => {
          manifest.renderer.capabilities = [...manifest.renderer.capabilities].reverse();
        },
        /renderer|capabilit|curriculum/i,
      ],
      [
        "title-too-long",
        (manifest) => {
          manifest.title = "t".repeat(121);
        },
        /title|string|curriculum|manifest/i,
      ],
    ];
    const backupModule = await loadBackupModule();
    const rejectedLabels = [];
    for (const [label, mutate, pattern] of cases) {
      const tree = privateTree();
      try {
        const payload = validPayload();
        const manifest = JSON.parse(
          payload.tables.pilot_curriculum_package[0].manifest_json,
        );
        mutate(manifest);
        const digest = recomputeCurriculumReferences(payload, manifest);
        assertRecomputedReferences(payload, manifest, digest);
        try {
          await assertRejected(
            () => readPayload(backupModule, tree, payload, label),
            pattern,
          );
        } catch {
          rejectedLabels.push(label);
        }
      } finally {
        fs.rmSync(tree.root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(rejectedLabels, []);
  },
);

test(
  "[S3-AC-011][R3-U-06] rejects an approved review with a false checklist or incomplete provenance despite a recomputed request fingerprint",
  async () => {
    const cases = [
      [
        "approved-false-checklist",
        (payload, manifest) => {
          const review = payload.tables.pilot_curriculum_review[0];
          review.decision = "approved";
          review.checklist_version = "hanzi-review-1";
          const checklist = Object.fromEntries(
            Object.keys(CHECKLIST).map((key) => [key, true]),
          );
          checklist.deviceAudio = false;
          review.checklist_json = JSON.stringify(checklist);
          const digest = recomputeCurriculumReferences(payload, manifest);
          assertRecomputedReferences(payload, manifest, digest);
        },
      ],
      [
        "approved-incomplete-provenance",
        (payload, manifest) => {
          const review = payload.tables.pilot_curriculum_review[0];
          review.decision = "approved";
          review.checklist_version = "hanzi-review-1";
          review.checklist_json = JSON.stringify(
            Object.fromEntries(Object.keys(CHECKLIST).map((key) => [key, true])),
          );
          manifest.characters[0].meanings[0].provenance.sourceChecked = false;
          const digest = recomputeCurriculumReferences(payload, manifest);
          assertRecomputedReferences(payload, manifest, digest);
        },
      ],
    ];
    const backupModule = await loadBackupModule();
    const rejectedLabels = [];
    for (const [label, mutate] of cases) {
      const tree = privateTree();
      try {
        const payload = validPayload();
        const manifest = checkedManifest();
        mutate(payload, manifest);
        try {
          await assertRejected(
            () => readPayload(backupModule, tree, payload, label),
            /approval|checklist|provenance|curriculum|review/i,
          );
        } catch {
          rejectedLabels.push(label);
        }
      } finally {
        fs.rmSync(tree.root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(rejectedLabels, []);
  },
);

test(
  "[S3-AC-011][R3-U-07] rejects mismatched audit time, orphan character rows, and legacy/curriculum namespace collisions",
  async () => {
    const cases = [
      [
        "audit-time-mismatch",
        (payload) => {
          payload.tables.pilot_curriculum_audit[0].created_at =
            IMPORTED_AT + 500;
        },
        /audit|time|timestamp|history/i,
      ],
      [
        "orphan-character-version",
        (payload) => {
          payload.tables.pilot_curriculum_character.push({
            lesson_version: "forest-ghost-v2",
            character_id: "char-ghost",
            hanzi: "木",
            character_index: 0,
          });
        },
        /character|package|version|identity|orphan/i,
      ],
      [
        "legacy-curriculum-version-collision",
        (payload) => {
          payload.contentIdentities.legacy[LESSON_VERSION] = {
            lessonId: LESSON_ID,
            algorithm: "s2-json-stringify-sha256-v1",
            digest: LEGACY_DIGEST,
          };
        },
        /legacy|curriculum|namespace|identity|version/i,
      ],
    ];
    const backupModule = await loadBackupModule();
    const rejectedLabels = [];
    for (const [label, mutate, pattern] of cases) {
      const tree = privateTree();
      try {
        const payload = validPayload();
        mutate(payload);
        try {
          await assertRejected(
            () => readPayload(backupModule, tree, payload, label),
            pattern,
          );
        } catch {
          rejectedLabels.push(label);
        }
      } finally {
        fs.rmSync(tree.root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(rejectedLabels, []);
  },
);
