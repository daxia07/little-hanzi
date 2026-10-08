import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEX = 'a'.repeat(64);
const SUPPORTED_TABLES = Object.freeze([
  [
    'pilot_auth_user',
    [
      'id',
      'name',
      'email',
      'email_verified',
      'image',
      'created_at',
      'updated_at',
      'username',
      'display_username',
      'role',
      'must_change_password',
      'disabled',
    ],
  ],
  [
    'pilot_auth_account',
    [
      'id',
      'account_id',
      'provider_id',
      'user_id',
      'password',
      'created_at',
      'updated_at',
    ],
  ],
  ['pilot_auth_rate_limit', ['id', 'key', 'count', 'last_request']],
  ['pilot_parent_child', ['parent_id', 'child_id', 'created_at', 'created_by']],
  [
    'pilot_teacher_grant',
    ['child_id', 'teacher_id', 'granting_parent_id', 'created_at'],
  ],
  [
    'pilot_account_audit',
    [
      'id',
      'action',
      'actor_user_id',
      'target_user_id',
      'metadata',
      'created_at',
    ],
  ],
  [
    'pilot_onboarding',
    [
      'child_id',
      'nickname',
      'experience',
      'audio_ready',
      'updated_at',
      'updated_by',
    ],
  ],
  [
    'pilot_assignment',
    ['child_id', 'lesson_version', 'status', 'created_at', 'created_by'],
  ],
  [
    'pilot_run_ownership',
    ['run_id', 'child_id', 'lesson_version', 'created_at'],
  ],
  [
    'pilot_learning_release',
    [
      'lesson_version',
      'release_kind',
      'content_digest',
      'reviewer_label',
      'evidence_ref',
      'candidate_id',
      'test_run_id',
      'released_at',
    ],
  ],
  [
    'pilot_learning_run',
    ['run_id', 'seed', 'state_json', 'revision', 'created_at', 'updated_at'],
  ],
  [
    'pilot_learning_event',
    [
      'run_id',
      'event_id',
      'sequence',
      'phase',
      'step_id',
      'question_id',
      'type',
      'payload_json',
      'action_json',
      'server_time',
      'first_response',
      'assisted',
      'outcome',
      'ack_json',
    ],
  ],
  [
    'pilot_learning_audit',
    ['id', 'action', 'actor_user_id', 'child_id', 'metadata', 'created_at'],
  ],
]);

async function loadBackupModule() {
  try {
    return await import('../scripts/pilot-backup.mjs');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      error.code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error('scripts/pilot-backup.mjs is unavailable');
    }
    throw error;
  }
}

function privateTree() {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-backup-'),
  );
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'unit\n', {
    mode: 0o600,
  });
  const privateBackups = path.join(work, 'private-backups');
  fs.mkdirSync(privateBackups, { mode: 0o700 });
  return { work, privateBackups };
}

function schemaDescriptors() {
  return SUPPORTED_TABLES.map(([name, columns]) => ({
    type: 'table',
    name,
    tbl_name: name,
    sql: `CREATE TABLE ${String(name)} (${columns.join(',')})`,
  }));
}

function emptyTables() {
  return Object.fromEntries(SUPPORTED_TABLES.map(([name]) => [name, []]));
}

function validPayload(overrides = {}) {
  return {
    format: 'pilot-admin-backup-1',
    createdAt: '2026-09-26T00:00:00.000Z',
    candidateId: 'candidate-synthetic',
    sourceInstallationId: 'source-installation-synthetic',
    migrations: [
      { name: '0000-auth.sql', version: 'pilot-auth-0000', sha256: HEX },
      { name: '0001-data.sql', version: 'pilot-data-0001', sha256: HEX },
      {
        name: '0002-learning.sql',
        version: 'pilot-learning-0002',
        sha256: HEX,
      },
    ],
    schemaDigest: checksum(schemaDescriptors()),
    schema: schemaDescriptors(),
    contentVersions: { 'forest-01-v1': HEX },
    tables: emptyTables(),
    ...overrides,
  };
}

function checksum(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function envelope(payload = validPayload()) {
  return { payload, sha256: checksum(payload) };
}

function writeEnvelope(filePath, value = envelope(), mode = 0o600) {
  fs.writeFileSync(filePath, JSON.stringify(value), { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

function assertRejected(action, pattern) {
  return assert.rejects(
    async () => action(),
    (error) => {
      assert.match(String(error), pattern);
      assert.doesNotMatch(String(error), /password|hash|token|secret/i);
      return true;
    },
  );
}

test('[S2-AC-007][R-U-00] backup tooling exports the administrative module contract', async () => {
  const backupTool = await loadBackupModule();
  assert.equal(typeof backupTool.backupPilot, 'function');
  assert.equal(typeof backupTool.restorePilot, 'function');
  assert.equal(typeof backupTool.readPilotBackup, 'function');
});

test('[S2-AC-007][R-U-01] parser accepts the versioned private envelope and validates its checksum', async () => {
  const backupTool = await loadBackupModule();
  const tree = privateTree();
  try {
    const file = writeEnvelope(path.join(tree.privateBackups, 'valid.json'));
    const parsed = await backupTool.readPilotBackup(file);
    assert.equal(parsed.payload.format, 'pilot-admin-backup-1');
    assert.equal(parsed.sha256, checksum(parsed.payload));
    assert.equal(
      Object.keys(parsed.payload.tables).length,
      SUPPORTED_TABLES.length,
    );
  } finally {
    fs.rmSync(tree.work, { recursive: true, force: true });
  }
});

test('[S2-AC-007][R-U-02] corrupt checksum is rejected before private data is accepted', async () => {
  const backupTool = await loadBackupModule();
  const tree = privateTree();
  try {
    const value = envelope();
    value.sha256 = 'b'.repeat(64);
    const file = writeEnvelope(
      path.join(tree.privateBackups, 'corrupt.json'),
      value,
    );
    await assertRejected(
      () => backupTool.readPilotBackup(file),
      /checksum|integrity/i,
    );
  } finally {
    fs.rmSync(tree.work, { recursive: true, force: true });
  }
});

test('[S2-AC-007][R-U-04] unknown format and malformed schema are rejected', async () => {
  const backupTool = await loadBackupModule();
  const tree = privateTree();
  try {
    const unknown = validPayload({ format: 'pilot-admin-backup-999' });
    const unknownFile = writeEnvelope(
      path.join(tree.privateBackups, 'unknown-format.json'),
      envelope(unknown),
    );
    await assertRejected(
      () => backupTool.readPilotBackup(unknownFile),
      /format|version|unsupported/i,
    );

    const malformedSchema = validPayload({ schema: { tables: [] } });
    const schemaFile = writeEnvelope(
      path.join(tree.privateBackups, 'malformed-schema.json'),
      envelope(malformedSchema),
    );
    await assertRejected(
      () => backupTool.readPilotBackup(schemaFile),
      /schema|column|table/i,
    );
  } finally {
    fs.rmSync(tree.work, { recursive: true, force: true });
  }
});

test('[S2-AC-007][R-U-03] serialized database values retain their declared column types', async () => {
  const backupTool = await loadBackupModule();
  const tree = privateTree();
  try {
    const invalid = validPayload();
    invalid.tables = {
      ...invalid.tables,
      pilot_auth_user: [
        {
          id: 'user-synthetic',
          name: 'Synthetic User',
          email: 'synthetic-account',
          email_verified: 0,
          image: null,
          created_at: 'not-an-integer',
          updated_at: 0,
          username: 'synthetic-user',
          display_username: 'synthetic-user',
          role: 'child',
          must_change_password: 0,
          disabled: 0,
        },
      ],
    };
    const file = writeEnvelope(
      path.join(tree.privateBackups, 'invalid-value-type.json'),
      envelope(invalid),
    );
    await assertRejected(
      () => backupTool.readPilotBackup(file),
      /value|type|database/i,
    );
  } finally {
    fs.rmSync(tree.work, { recursive: true, force: true });
  }
});

test('[S2-AC-012][R-U-04] malformed JSON and unsafe private paths or modes are rejected', async () => {
  const backupTool = await loadBackupModule();
  const tree = privateTree();
  const outside = path.join(tree.work, 'outside.json');
  try {
    fs.writeFileSync(outside, '{not-json', { mode: 0o600 });
    await assertRejected(
      () => backupTool.readPilotBackup(outside),
      /private|backup|owned|path/i,
    );

    const malformed = path.join(tree.privateBackups, 'malformed.json');
    fs.writeFileSync(malformed, '{not-json', { mode: 0o600 });
    await assertRejected(
      () => backupTool.readPilotBackup(malformed),
      /json|serialized|malformed/i,
    );

    const worldReadable = writeEnvelope(
      path.join(tree.privateBackups, 'world-readable.json'),
      envelope(),
      0o644,
    );
    await assertRejected(
      () => backupTool.readPilotBackup(worldReadable),
      /mode|permission|owner|0600|private/i,
    );

    const outsideLink = path.join(tree.privateBackups, 'escape.json');
    fs.symlinkSync(outside, outsideLink);
    await assertRejected(
      () => backupTool.readPilotBackup(outsideLink),
      /symlink|regular|private|escape|path/i,
    );

    fs.chmodSync(tree.privateBackups, 0o755);
    const unsafeDirectoryFile = path.join(
      tree.privateBackups,
      'directory-mode.json',
    );
    writeEnvelope(unsafeDirectoryFile);
    await assertRejected(
      () => backupTool.readPilotBackup(unsafeDirectoryFile),
      /mode|permission|0700|private/i,
    );
  } finally {
    fs.rmSync(tree.work, { recursive: true, force: true });
  }
});
