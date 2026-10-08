import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPilotBackup } from '../scripts/pilot-backup.mjs';
import {
  validateStoryControl,
  syntheticStoryAccounts,
  storyBindings,
  validateStoryScope,
  validateRestartLibrary,
  restoreFaultClient,
  corruptStoryChecksum,
  safeAuthFailure,
  runnerOperationFailure,
  restoreFailureCode,
} from '../scripts/readiness-story-node-runner.mjs';
const ids = ['child-a', 'child-a2', 'child-b'];
const scope = {
  installationId: 'install',
  contentDigest: 'sha256:' + 'a'.repeat(64),
  namespace: 'qa-r3',
  childIds: ids,
  parentIds: ['parent-a', 'parent-b'],
};
test('private controls reject arbitrary SQL, paths, unknown fields and foreign fixture IDs', () => {
  for (const [path, body] of [
    ['/inspect', { sql: 'DROP TABLE x' }],
    ['/inspect', { kind: 'run', runId: '../secret' }],
    ['/clock', { at: 1, sql: 'x' }],
    ['/fault-final', { operation: 'auth', enabled: true }],
    ['/backup', { name: '../../prod' }],
    ['/restore', { name: 'populated', url: 'https://active' }],
    ['/restart', { service: 'family' }],
    ['/inspect', { kind: 'plan', childId: 'foreign' }],
    ['/verify-and-sign', { suite: 'family-story', passed: true }],
    ['/verify-and-sign', { suite: 'arbitrary' }],
  ])
    assert.throws(() => validateStoryControl(path, body, scope));
});
test('real private backup reader checksum refusal maps to named REFUSED code', () => {
  const work = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-checksum-reader-')),
  );
  fs.chmodSync(work, 0o700);
  fs.writeFileSync(
    path.join(work, '.hanzi-qa-owned'),
    'Fresh synthetic checksum reader fixture',
    { mode: 0o600 },
  );
  const directory = path.join(work, 'private-backups');
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, 'checksum-corrupt.json');
  try {
    const payload = {
      format: 'pilot-admin-backup-4',
      createdAt: '2026-09-27T00:00:00Z',
    };
    const envelope = {
      payload,
      sha256: crypto
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    };
    fs.writeFileSync(file, JSON.stringify(corruptStoryChecksum(envelope)), {
      mode: 0o600,
      flag: 'wx',
    });
    assert.throws(
      () => readPilotBackup(file),
      (error) => {
        assert.equal(error.message, 'Pilot backup: backup checksum is invalid');
        assert.equal(restoreFailureCode(error), 'BACKUP_CHECKSUM_INVALID');
        return true;
      },
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
test('structured backup validation failure preserves suite evidence while process failures still stop', () => {
  const failure = {
    code: 'BACKUP_STORY_INVALID',
    message: 'private SQL/password body',
  };
  assert.deepEqual(runnerOperationFailure('/backup', failure), {
    route: '/backup',
    code: 'BACKUP_STORY_INVALID',
    stop: false,
  });
  for (const route of ['/restart', '/clock', '/restore'])
    assert.equal(runnerOperationFailure(route, failure).stop, true);
  for (const failure of [
    new Error('Unknown failure'),
    { code: 'BACKUP_TIMEOUT' },
    { code: 'BACKUP_STORY_INVALID', name: 'TimeoutError' },
  ])
    assert.equal(runnerOperationFailure('/backup', failure).stop, true);
  assert.deepEqual(
    runnerOperationFailure('/arbitrary-secret-path', {
      code: 'secret/password',
    }),
    { route: '/unknown', code: 'OWNED_RUNNER_UNAVAILABLE', stop: false },
  );
});
test('restore final-write and uncertain fixtures preserve real batch transaction boundaries', async () => {
  let statements,
    writes = 0;
  const real = {
    execute: async () => ({ rows: [] }),
    batch: async (input, mode) => {
      assert.equal(mode, 'write');
      statements = input;
      writes++;
      return [];
    },
  };
  await assert.rejects(
    restoreFaultClient(real, 'uncertain').batch(
      [{ sql: 'INSERT owned' }],
      'write',
    ),
  );
  assert.equal(writes, 1);
  assert.equal(statements.length, 1);
  await restoreFaultClient(real, 'final-write').batch(
    [{ sql: 'INSERT owned' }],
    'write',
  );
  assert.equal(writes, 2);
  assert.equal(statements.length, 2);
  assert.equal(
    statements[1].sql,
    'INSERT INTO pilot_curriculum_registry_state(id,revision,updated_at) VALUES(1,0,0)',
  );
  assert.equal(restoreFaultClient(real, 'none'), real);
});
test('restart readback rejects an HTTP-success library with wrong or unavailable publication identity', () => {
  const item = {
    lessonVersion: 'forest-01-v4',
    contentDigest: scope.contentDigest,
    publicationId: 'publication',
    available: true,
  };
  assert.equal(
    validateRestartLibrary({ items: [item] }, scope, 'publication'),
    true,
  );
  for (const items of [
    [],
    [{ ...item, available: false }],
    [{ ...item, contentDigest: 'sha256:' + 'b'.repeat(64) }],
    [{ ...item, publicationId: 'other' }],
  ])
    assert.throws(() =>
      validateRestartLibrary({ items }, scope, 'publication'),
    );
});
test('named controls retain strict clock restart fault and readback contracts', () => {
  for (const [path, body] of [
    ['/clock', { at: 1780000000000 }],
    ['/restart', { service: 'all' }],
    ['/fault-final', { operation: 'plan', enabled: true }],
    ['/inspect', { kind: 'run', runId: 'story-run-id' }],
    ['/inspect', { kind: 'plan', childId: 'child-a' }],
    ['/backup', { name: 'populated' }],
    ['/restore', { name: 'populated', fault: 'none' }],
    ['/restore', { name: 'populated', fault: 'checksum-corrupt' }],
    ['/verify-and-sign', { suite: 'family-story' }],
  ])
    assert.equal(validateStoryControl(path, body, scope), true);
});
test('named checksum fault changes only cloned payload and preserves original envelope/checksum', () => {
  const original = {
    payload: { createdAt: '2026-09-27', tables: { owned: [] } },
    sha256: 'a'.repeat(64),
  };
  const changed = corruptStoryChecksum(original);
  assert.equal(changed.sha256, original.sha256);
  assert.notDeepEqual(changed.payload, original.payload);
  assert.deepEqual(original, {
    payload: { createdAt: '2026-09-27', tables: { owned: [] } },
    sha256: 'a'.repeat(64),
  });
  assert.notEqual(changed.payload.tables, original.payload.tables);
});
test('synthetic account inventory supports two families and same-parent child switch without real identities', () => {
  const accounts = syntheticStoryAccounts('qa-r3');
  assert.equal(accounts.length, 7);
  assert.equal(accounts.filter((a) => a.role === 'child').length, 3);
  assert.ok(accounts.every((a) => a.username.startsWith('qa_')));
  assert.ok(accounts.every((a) => a.password.length >= 24));
  assert.equal(new Set(accounts.map((a) => a.id)).size, accounts.length);
  // Pinned BetterAuth username plugin default: /^[a-zA-Z0-9_.]+$/.
  assert.ok(
    accounts.every((account) => /^[a-zA-Z0-9_.]+$/.test(account.username)),
  );
  assert.ok(accounts.every((account) => account.id.startsWith('qa-story-')));
});
test('ordinary sign-in failure diagnostics retain only numeric status and declared error code', () => {
  assert.equal(
    safeAuthFailure(400, {
      code: 'USERNAME_IS_INVALID',
      message: 'private password',
    }),
    'Ordinary synthetic sign-in failed (400 USERNAME_IS_INVALID)',
  );
  assert.equal(
    safeAuthFailure(500, { code: 'secret:password', cookie: 'private' }),
    'Ordinary synthetic sign-in failed (500 UNKNOWN_AUTH_ERROR)',
  );
});
test('ordinary denial app carries no capability token testclock or trust; inherited active credentials are absent', () => {
  const bindings = storyBindings(
    {
      testing: false,
      port: 1234,
      databaseURL: 'http://127.0.0.1:5678',
      candidateId: 'candidate',
      authSecret: 'syntheticsecret',
      origin: 'http://127.0.0.1:1234',
      scope,
      trust: {},
      token: 'token',
      clock: 1780000000000,
    },
    {
      PATH: '/usr/bin',
      HANZI_DATABASE_URL: 'https://active',
      TURSO_AUTH_TOKEN: 'secret',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  );
  assert.equal(bindings.HANZI_PILOT_MODE, '1');
  assert.equal(bindings.HANZI_TEST_MODE, '0');
  assert.equal(bindings.HANZI_STORY_CAPABILITY, '');
  assert.equal(bindings.HANZI_CURRICULUM_TRUST, '');
  assert.equal(bindings.HANZI_TEST_TOKEN, '');
  assert.equal(bindings.HANZI_CURRICULUM_TEST_NOW, '');
  assert.equal(bindings.TURSO_AUTH_TOKEN, undefined);
  assert.equal(bindings.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(bindings.HANZI_DATABASE_URL, 'http://127.0.0.1:5678');
});
test('runner configuration refuses remote databases and mismatched scope before process launch', () => {
  assert.throws(() =>
    storyBindings({
      testing: true,
      databaseURL: 'https://active.example',
      scope,
    }),
  );
  assert.throws(() =>
    validateStoryScope(
      { ...scope, childIds: ['foreign'] },
      syntheticStoryAccounts('qa-r3'),
    ),
  );
});

test('positive profile is closed, fixed-path and requires a distinct target installation', async () => {
  const api = await import('../scripts/readiness-story-node-runner.mjs');
  assert.equal(
    api.storyProfile().packagePath,
    'content/curriculum/forest-01-v4.json',
  );
  assert.equal(
    api.storyProfile('positive-publication').packagePath,
    'tests/fixtures/curriculum/forest-01-v4-positive-publication.json',
  );
  for (const invalid of [
    '../package.json',
    'positive',
    { packagePath: 'secret' },
  ])
    assert.throws(() => api.storyProfile(invalid));
  assert.throws(() => api.validatePositiveTarget('same', 'same'));
  assert.equal(api.validatePositiveTarget('evidence', 'target'), true);
});
test('positive controls bind only ordinary target and closed issuer states without relaxing defaults', () => {
  const body = { target: 'ordinary', kind: 'counts' };
  assert.equal(
    validateStoryControl('/inspect', body, scope, 'positive-publication'),
    true,
  );
  assert.throws(() => validateStoryControl('/inspect', body, scope));
  for (const state of [
    'active',
    'revoked',
    'future-not-before',
    'candidate-purpose',
  ])
    assert.equal(
      validateStoryControl(
        '/target-issuer',
        { state },
        scope,
        'positive-publication',
      ),
      true,
    );
  for (const body of [
    { state: 'active', key: 'secret' },
    { state: 'arbitrary' },
    { target: 'evidence', kind: 'counts' },
  ])
    assert.throws(() =>
      validateStoryControl(
        body.kind ? '/inspect' : '/target-issuer',
        body,
        scope,
        'positive-publication',
      ),
    );
});
test('ordinary positive target pins public release trust while every synthetic bypass remains off', () => {
  const bindings = storyBindings({
    testing: false,
    ordinaryTrust: { issuers: [{ purpose: 'release' }] },
    port: 1234,
    databaseURL: 'http://127.0.0.1:5678',
    candidateId: 'candidate',
    authSecret: 'owned',
    origin: 'http://127.0.0.1:1234',
    scope,
    trust: {},
    clock: 1,
    token: 'secret',
  });
  assert.equal(
    JSON.parse(bindings.HANZI_CURRICULUM_TRUST).issuers[0].purpose,
    'release',
  );
  for (const key of [
    'HANZI_STORY_CAPABILITY',
    'HANZI_TEST_TOKEN',
    'HANZI_CURRICULUM_TEST_NOW',
  ])
    assert.equal(bindings[key], '');
  assert.equal(bindings.HANZI_TEST_MODE, '0');
  assert.equal(bindings.HANZI_PILOT_TEST_CONTENT, '0');
  assert.equal(bindings.HANZI_PREVIEW_MODE, '0');
});
test('live issuer changes preserve original archive identity and derive owned timestamps', async () => {
  const api = await import('../scripts/readiness-story-node-runner.mjs');
  const issuer = {
    issuerId: 'release-owned',
    purpose: 'release',
    notBefore: 10,
    revokedAt: null,
    publicKeyJwk: { kty: 'OKP' },
  };
  assert.equal(api.liveStoryIssuer(issuer, 'revoked', 100).revokedAt, 100);
  assert.equal(
    api.liveStoryIssuer(issuer, 'future-not-before', 100).notBefore,
    300100,
  );
  assert.equal(
    api.liveStoryIssuer(issuer, 'candidate-purpose', 100).purpose,
    'candidate',
  );
  assert.deepEqual(api.liveStoryIssuer(issuer, 'active', 100), issuer);
  assert.equal(issuer.revokedAt, null);
  assert.equal(issuer.purpose, 'release');
  assert.throws(() => api.liveStoryIssuer(issuer, 'arbitrary', 100));
});
