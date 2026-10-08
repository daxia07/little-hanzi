import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedAuthRoute,
  validateIssuedAccountInput,
  safePilotUser,
  canReadChild,
} from '../lib/pilot/policy.ts';
import {
  PILOT_AUTH_TABLES,
  PILOT_DATA_TABLES,
  PILOT_MIGRATION_VERSIONS,
  PILOT_AUTH_MIGRATION_SQL,
} from '../db/pilot-schema.ts';
import * as pilotSchema from '../db/pilot-schema.ts';

test('[S2-AC-001][U-01] auth exposes only the four configured routes', () => {
  assert.equal(isAllowedAuthRoute('POST', '/api/auth/sign-in/username'), true);
  assert.equal(isAllowedAuthRoute('GET', '/api/auth/get-session'), true);
  assert.equal(isAllowedAuthRoute('POST', '/api/auth/sign-out'), true);
  assert.equal(isAllowedAuthRoute('POST', '/api/auth/change-password'), true);
  assert.equal(isAllowedAuthRoute('POST', '/api/auth/sign-up/email'), false);
  assert.equal(isAllowedAuthRoute('POST', '/api/auth/sign-in/email'), false);
  assert.equal(
    isAllowedAuthRoute('POST', '/api/auth/is-username-available'),
    false,
  );
  assert.equal(isAllowedAuthRoute('GET', '/api/auth/sign-out'), false);
});

test('[S2-AC-005][U-01] issued account input rejects role spoofing and malformed credentials', () => {
  assert.deepEqual(
    validateIssuedAccountInput({
      username: 'child.one',
      name: 'Child One',
      password: 'safe-password',
      role: 'child',
    }),
    {
      username: 'child.one',
      name: 'Child One',
      password: 'safe-password',
      role: 'child',
    },
  );
  assert.equal(
    validateIssuedAccountInput({
      username: 'child.one',
      name: 'Child One',
      password: 'safe-password',
      role: 'admin',
    }),
    null,
  );
  assert.equal(
    validateIssuedAccountInput({
      username: 'x',
      name: 'Child One',
      password: 'safe-password',
      role: 'child',
    }),
    null,
  );
  assert.equal(
    validateIssuedAccountInput({
      username: 'child.one',
      name: 'Child One',
      password: 'short',
      role: 'child',
    }),
    null,
  );
  assert.equal(
    validateIssuedAccountInput({
      username: 'child.one',
      name: 'Child One',
      password: 'safe-password',
      role: 'child',
      disabled: false,
    }),
    null,
  );
});

test('[S2-AC-003][U-01] safe user metadata excludes internal email, disabled internals, hashes, and tokens', () => {
  const safe = safePilotUser({
    id: 'opaque-user',
    name: 'Child One',
    username: 'child.one',
    role: 'child',
    mustChangePassword: true,
    disabled: false,
    email: 'internal-random@accounts.invalid',
    password: 'scrypt-hash',
    token: 'session-token',
  });
  assert.deepEqual(safe, {
    id: 'opaque-user',
    name: 'Child One',
    username: 'child.one',
    role: 'child',
    mustChangePassword: true,
  });
});

test('[S2-AC-004][U-01] learner reads require the current parent link or teacher grant', () => {
  assert.equal(
    canReadChild({ role: 'child', id: 'child-a' }, 'child-a', {
      linked: false,
      granted: false,
    }),
    true,
  );
  assert.equal(
    canReadChild({ role: 'child', id: 'child-a' }, 'child-b', {
      linked: false,
      granted: false,
    }),
    false,
  );
  assert.equal(
    canReadChild({ role: 'parent', id: 'parent-a' }, 'child-a', {
      linked: true,
      granted: false,
    }),
    true,
  );
  assert.equal(
    canReadChild({ role: 'parent', id: 'parent-a' }, 'child-a', {
      linked: false,
      granted: true,
    }),
    false,
  );
  assert.equal(
    canReadChild({ role: 'teacher', id: 'teacher-a' }, 'child-a', {
      linked: false,
      granted: true,
    }),
    true,
  );
  assert.equal(
    canReadChild({ role: 'teacher', id: 'teacher-a' }, 'child-a', {
      linked: true,
      granted: false,
    }),
    false,
  );
  assert.equal(
    canReadChild({ role: 'operator', id: 'operator-a' }, 'child-a', {
      linked: true,
      granted: true,
    }),
    false,
  );
});

test('[S2-AC-009][U-01] pilot migrations are isolated from legacy tables and versioned', () => {
  assert.ok(
    PILOT_AUTH_TABLES.every((table) => table.startsWith('pilot_auth_')),
  );
  assert.ok(PILOT_DATA_TABLES.every((table) => table.startsWith('pilot_')));
  assert.ok(
    ![...PILOT_AUTH_TABLES, ...PILOT_DATA_TABLES].some((table) =>
      ['attempts', 'settings', 'drafts'].includes(table),
    ),
  );
  assert.deepEqual(PILOT_MIGRATION_VERSIONS, [
    'pilot-auth-0000',
    'pilot-data-0001',
    'pilot-learning-0002',
    'pilot-curriculum-0003',
    'pilot-curriculum-runtime-0004',
  ]);
});

test('[S2-AC-002][U-01] database rate limits have an adapter id and unique request key', () => {
  assert.match(
    PILOT_AUTH_MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS pilot_auth_rate_limit \(\s*id TEXT PRIMARY KEY NOT NULL,\s*key TEXT NOT NULL UNIQUE/s,
  );
});

test('[S3-AC-011][U-01] curriculum registry migration is additive and declares all five immutable tables', () => {
  assert.equal(typeof pilotSchema.PILOT_CURRICULUM_MIGRATION_SQL, 'string');
  for (const table of [
    'pilot_curriculum_registry_state',
    'pilot_curriculum_package',
    'pilot_curriculum_character',
    'pilot_curriculum_review',
    'pilot_curriculum_audit',
  ]) {
    assert.match(
      pilotSchema.PILOT_CURRICULUM_MIGRATION_SQL,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`),
    );
  }
  const declarations = {
    pilotCurriculumRegistryState: pilotSchema.pilotCurriculumRegistryState,
    pilotCurriculumPackage: pilotSchema.pilotCurriculumPackage,
    pilotCurriculumCharacter: pilotSchema.pilotCurriculumCharacter,
    pilotCurriculumReview: pilotSchema.pilotCurriculumReview,
    pilotCurriculumAudit: pilotSchema.pilotCurriculumAudit,
  };
  for (const declaration of Object.values(declarations)) {
    assert.equal(typeof declaration, 'object');
  }
  assert.match(
    pilotSchema.PILOT_CURRICULUM_MIGRATION_SQL,
    /UNIQUE\s*\(lesson_version, content_digest\)/s,
  );
  assert.match(
    pilotSchema.PILOT_CURRICULUM_MIGRATION_SQL,
    /PRIMARY KEY\s*\(lesson_version, character_id\)/s,
  );
});
