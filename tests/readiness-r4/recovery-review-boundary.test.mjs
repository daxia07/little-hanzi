import { legacyStoryOperationsRoot } from '../helpers/legacy-pilot-root.mjs';
/** Independent host-only source/refusal probes. No DB, app, manifest or sign-off simulation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sealArchive,
  PrivateArchiveStore,
} from '../../scripts/pilot-ops-archive.mjs';
import {
  readEncryptedPair,
  restoreEncryptedPair,
  assertRollbackCompatibility,
} from '../../scripts/pilot-ops-recovery.mjs';
import { storySchemaSource } from '../../scripts/pilot-story-schema.mjs';
import { opsSchemaSource } from '../../scripts/pilot-ops-schema.mjs';
import { PILOT_V4_TABLES } from '../../scripts/pilot-backup.mjs';
import { FOREST_LESSON } from '../../lib/preview/content.ts';
import { OPS_TABLES } from '../../lib/pilot/ops-schema.ts';
import { assertFreshStorySnapshot } from '../../scripts/pilot-story-libsql-backup.mjs';
import { assertFreshOpsSnapshot } from '../../scripts/pilot-ops-libsql.mjs';
const hash = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const historicalRoot = legacyStoryOperationsRoot(process.cwd());
function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'r4-independent-recovery-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const learning = storySchemaSource(historicalRoot),
    ops = opsSchemaSource(historicalRoot, { version: 1 }),
    at = Date.parse('2026-09-27T02:00:00Z');
  const learningTables = Object.fromEntries(
    PILOT_V4_TABLES.map((name) => [
      name,
      name === 'pilot_curriculum_registry_state'
        ? [{ id: 1, revision: 0, updated_at: 0 }]
        : [],
    ]),
  );
  const operationTables = Object.fromEntries(
    OPS_TABLES.map((name) => [name, []]),
  );
  operationTables.ops_installation = [
    {
      id: 1,
      installation_id: 'old-ops',
      environment: 'synthetic',
      learning_installation_id: 'old-learning',
      schema_version: 'pilot-ops-schema-1',
      queue_revision: 0,
      created_at: at,
    },
  ];
  operationTables.ops_schema_history = [
    {
      version: 0,
      name: '0000_ops.sql',
      checksum: ops.migrations[0].sha256,
      applied_at: at,
    },
  ];
  const payloads = {
    learning: {
      format: 'pilot-admin-backup-4',
      createdAt: new Date(at).toISOString(),
      sourceInstallationId: 'old-learning',
      candidateId: 'old-build',
      migrations: learning.migrations,
      schemaDigest: hash(learning.schema),
      schema: learning.schema,
      tables: learningTables,
      contentIdentities: {
        legacy: {
          'forest-01-v1': {
            lessonId: 'forest-01',
            algorithm: 's2-json-stringify-sha256-v1',
            digest: hash(FOREST_LESSON),
          },
        },
        curriculum: {},
      },
    },
    operations: {
      format: 'pilot-ops-backup-1',
      createdAt: new Date(at).toISOString(),
      sourceInstallationId: 'old-learning',
      sourceOpsInstallationId: 'old-ops',
      environment: 'synthetic',
      buildId: 'old-build',
      migrations: ops.migrations,
      schemaDigest: hash(ops.schema),
      schema: ops.schema,
      tables: operationTables,
    },
  };
  const key = crypto.randomBytes(32),
    archiveStore = new PrivateArchiveStore(root),
    build = {
      candidateId: 'old-build',
      sourceDigest: 'sha256:' + 'a'.repeat(64),
      artifactDigest: 'sha256:' + 'b'.repeat(64),
    };
  let destinations = 0;
  const options = {
    sourceRoot: historicalRoot,
    archiveStore,
    keys: new Map([['archive-key', key]]),
    sourceScope: {
      environment: 'synthetic',
      installationId: 'old-learning',
      opsInstallationId: 'old-ops',
    },
    admission: {
      job: { kind: 'backup', buildId: 'old-build' },
      utcSlot: new Date(at).toISOString(),
      objects: {
        learning: {
          archiveId: 'learning-archive',
          objectId: 'learning-object',
        },
        operations: { archiveId: 'ops-archive', objectId: 'ops-object' },
      },
    },
    resolveBuild: () => build,
    createDestination: async () => {
      destinations++;
      throw Error('unit must not create destination');
    },
  };
  const put = (kind, alterPayload, alterEnvelope) => {
    const p = structuredClone(payloads[kind]);
    alterPayload?.(p);
    const envelope = sealArchive({
      bytes: Buffer.from(JSON.stringify({ payload: p, sha256: hash(p) })),
      key,
      metadata: {
        payloadFormat: p.format,
        archiveId: options.admission.objects[kind].archiveId,
        environment: 'synthetic',
        sourceInstallationId: 'old-learning',
        opsInstallationId: 'old-ops',
        candidateId: 'old-build',
        sourceDigest: build.sourceDigest,
        artifactDigest: build.artifactDigest,
        schemaDigest: 'sha256:' + p.schemaDigest,
        createdAt: at,
        keyId: 'archive-key',
      },
    });
    alterEnvelope?.(envelope);
    archiveStore.put(
      options.admission.objects[kind].objectId,
      Buffer.from(JSON.stringify(envelope)),
    );
  };
  return { options, payloads, put, destinations: () => destinations };
}
// Build seal metadata explicitly, avoiding an untrusted extra scope alias.
test('independent valid empty35+8-table sources decrypt and both semantic validators pass', async (t) => {
  const f = fixture(t);
  f.put('learning');
  f.put('operations');
  const result = await readEncryptedPair(f.options);
  assert.deepEqual(
    result.payloads.learning.payload.tables,
    f.payloads.learning.tables,
  );
  assert.equal(result.metadata.length, 2);
  assert.equal(f.destinations(), 0);
});
for (const [name, change, expected] of [
  [
    'unknown key',
    (f) => {
      f.options.keys.clear();
    },
    /OPS_ARCHIVE_KEY/,
  ],
  [
    'wrong key',
    (f) => {
      f.options.keys.set('archive-key', crypto.randomBytes(32));
    },
    /OPS_ARCHIVE_AUTH/,
  ],
  ['missing operations object', () => {}, /OPS_EFFECT_UNCONFIRMED/],
  [
    'authenticated operations schema mismatch',
    (f) =>
      f.put('operations', (p) => {
        p.schema[0].sql += ' MODIFIED';
        p.schemaDigest = hash(p.schema);
      }),
    /OPS_SCHEMA_MISMATCH/,
  ],
  [
    'authenticated operations scope mismatch',
    (f) =>
      f.put('operations', (p) => {
        p.sourceOpsInstallationId = 'foreign-ops';
      }),
    /OPS_ARCHIVE_SCOPE/,
  ],
  [
    'operations tag corruption',
    (f) =>
      f.put('operations', undefined, (e) => {
        e.tag = Buffer.alloc(16).toString('base64url');
      }),
    /OPS_ARCHIVE_AUTH/,
  ],
])
  test(`independent ${String(name)} refuses before destination factory`, async (t) => {
    const f = fixture(t);
    f.put('learning');
    change(f);
    await assert.rejects(restoreEncryptedPair(f.options), expected);
    assert.equal(f.destinations(), 0);
  });
test('historical learning IDs and auth sessions cannot be fresh destination ownership', () => {
  const source = {
    sourceInstallationId: 'old-learning',
    tables: {
      pilot_learning_plan: [{ installation_id: 'historical-plan' }],
      pilot_curriculum_proof_receipt: [
        {
          receipt_json: JSON.stringify({
            targetInstallationId: 'historical-target',
            evidenceInstallationId: 'historical-evidence',
          }),
        },
      ],
    },
  };
  const fresh = {
    installationId: 'new-learning',
    sessionCount: 0,
    verificationCount: 0,
    tables: Object.fromEntries(
      PILOT_V4_TABLES.map((name) => [
        name,
        name === 'pilot_curriculum_registry_state'
          ? [{ id: 1, revision: 0, updated_at: 0 }]
          : [],
      ]),
    ),
  };
  for (const id of [
    'old-learning',
    'historical-plan',
    'historical-target',
    'historical-evidence',
  ])
    assert.throws(
      () => assertFreshStorySnapshot({ ...fresh, installationId: id }, source),
      /RESTORE_DESTINATION_NOT_FRESH/,
    );
  assert.throws(
    () => assertFreshStorySnapshot({ ...fresh, sessionCount: 1 }, source),
    /RESTORE_DESTINATION_NOT_FRESH/,
  );
  assert.throws(
    () => assertFreshStorySnapshot({ ...fresh, verificationCount: 1 }, source),
    /RESTORE_DESTINATION_NOT_FRESH/,
  );
});
test('all historical ops domain scopes exclude restoration into revived ownership', () => {
  const tables = Object.fromEntries(OPS_TABLES.map((name) => [name, []]));
  const scope = {
    environment: 'synthetic',
    installationId: 'new-learning',
    opsInstallationId: 'new-ops',
  };
  const snapshot = {
    tables: {
      ...tables,
      ops_installation: [
        {
          id: 1,
          installation_id: 'new-ops',
          learning_installation_id: 'new-learning',
          environment: 'synthetic',
          queue_revision: 0,
        },
      ],
    },
  };
  for (const table of [
    'ops_job',
    'ops_job_event',
    'ops_archive',
    'ops_alert_event',
    'ops_feedback',
    'ops_feedback_event',
  ]) {
    const source = {
      sourceOpsInstallationId: 'old-ops',
      tables: structuredClone(tables),
    };
    source.tables[table].push({ ops_installation_id: 'new-ops' });
    assert.throws(
      () => assertFreshOpsSnapshot(snapshot, source, scope),
      /OPS_RESTORE_NOT_FRESH/,
    );
  }
});
test('migration checksum drift/content loss and same build refuse compatibility', () => {
  const current = {
    candidateId: 'new',
    learningMigrations: [{ name: '0000.sql', sha256: 'a' }],
    operationsMigrations: [{ name: '0000_ops.sql', sha256: 'b' }],
    contentVersions: ['poc-1', 'forest-01-v4'],
  };
  const target = { ...structuredClone(current), candidateId: 'old' };
  assert.equal(assertRollbackCompatibility(current, target), true);
  for (const altered of [
    current,
    {
      ...target,
      learningMigrations: [{ name: '0000.sql', sha256: 'different' }],
    },
    {
      ...target,
      operationsMigrations: [{ name: '0000_ops.sql', sha256: 'different' }],
    },
    { ...target, contentVersions: ['poc-1'] },
  ])
    assert.throws(
      () => assertRollbackCompatibility(current, altered),
      /OPS_ROLLBACK_/,
    );
});

test('RR01 actual named checksum fault reaches semantic checksum refusal before destination creation', async (t) => {
  const { createOwnedOpsRecovery } =
    await import('../../scripts/readiness-ops-recovery.mjs');
  const f = fixture(t);
  f.put('learning');
  f.put('operations');
  let clientsOpened = 0;
  const helper = createOwnedOpsRecovery(
    {
      manifest: {
        snapshot: historicalRoot,
        work: os.tmpdir(),
        runId: 'host-only-refusal',
      },
      createClient: () => {
        clientsOpened++;
        throw Error('no destination permitted');
      },
      accounts: [],
      archiveIssuers: [],
    },
    {
      executor: {
        context: () => ({}),
        store: { readJobForReconcile: async () => f.options.admission },
      },
      archiveStore: f.options.archiveStore,
      keys: f.options.keys,
      scope: f.options.sourceScope,
      resolveBuild: f.options.resolveBuild,
      now: () => Date.parse('2026-09-27T02:00:00Z'),
    },
  );
  const result = await helper.restore({
    jobId: 'host-only-job',
    fault: 'payload-checksum',
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.destinationsCreated, 0);
  assert.equal(clientsOpened, 0);
  assert.equal(result.code, 'BACKUP_CHECKSUM_INVALID');
  await helper.cleanup();
});
