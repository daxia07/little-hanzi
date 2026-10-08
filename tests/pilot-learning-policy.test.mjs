import test from 'node:test';
import assert from 'node:assert/strict';

import { FOREST_LESSON } from '../lib/preview/content.ts';
import {
  FOREST_LESSON_VERSION,
  getLessonRelease,
  validateLessonVersionInput,
  validateOnboardingInput,
} from '../lib/pilot/learning.ts';
import {
  PILOT_LEARNING_MIGRATION_SQL,
  PILOT_MIGRATION_VERSIONS,
} from '../db/pilot-schema.ts';

function fakeDatabase(row) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return row;
            },
          };
        },
      };
    },
  };
}

async function lessonDigest() {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(FOREST_LESSON)),
    ),
  );
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function config(overrides = {}) {
  return {
    pilotMode: true,
    testMode: true,
    testContentAllowed: true,
    testRunId: 'test-run-1',
    testToken: 'test-token',
    origin: 'http://localhost:8787',
    secret: 'x'.repeat(32),
    candidateId: 'candidate-1',
    database: null,
    ...overrides,
  };
}

test('[S2-AC-004][L-U01] onboarding accepts only the exact persisted shape and trims the nickname', () => {
  assert.deepEqual(
    validateOnboardingInput({
      nickname: '  Mina  ',
      experience: 'new',
      audioReady: false,
    }),
    { nickname: 'Mina', experience: 'new', audioReady: false },
  );
  assert.equal(
    validateOnboardingInput({
      nickname: 'Mina',
      experience: 'new',
      audioReady: false,
      school: 'unaccepted',
    }),
    null,
  );
  assert.equal(
    validateOnboardingInput({
      nickname: 'Mina',
      experience: 'expert',
      audioReady: true,
    }),
    null,
  );
  assert.equal(
    validateOnboardingInput({
      nickname: '   ',
      experience: 'new',
      audioReady: true,
    }),
    null,
  );
  assert.equal(
    validateOnboardingInput({
      nickname: 'Mina',
      experience: 'new',
      audioReady: 1,
    }),
    null,
  );
});

test('[S2-AC-009][L-U02] learning migration is isolated, versioned, and append-only by run identities', () => {
  assert.deepEqual(PILOT_MIGRATION_VERSIONS, [
    'pilot-auth-0000',
    'pilot-data-0001',
    'pilot-learning-0002',
    'pilot-curriculum-0003',
    'pilot-curriculum-runtime-0004',
  ]);
  assert.match(
    PILOT_LEARNING_MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS pilot_installation/,
  );
  assert.match(
    PILOT_LEARNING_MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS pilot_learning_release/,
  );
  assert.match(
    PILOT_LEARNING_MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS pilot_learning_run/,
  );
  assert.match(
    PILOT_LEARNING_MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS pilot_learning_event/,
  );
  assert.match(
    PILOT_LEARNING_MIGRATION_SQL,
    /PRIMARY KEY \(run_id, event_id\)/,
  );
  assert.match(PILOT_LEARNING_MIGRATION_SQL, /UNIQUE \(run_id, sequence\)/);
  assert.match(
    PILOT_LEARNING_MIGRATION_SQL,
    /pilot_run_ownership\(child_id, lesson_version\)/,
  );
});

test('[S2-AC-009][L-U03] synthetic release requires every test guard and the exact candidate/run namespace', async () => {
  const digest = await lessonDigest();
  const row = {
    lesson_version: FOREST_LESSON_VERSION,
    release_kind: 'test-fixture',
    content_digest: digest,
    reviewer_label: 'fixture',
    evidence_ref: 'test',
    candidate_id: 'candidate-1',
    test_run_id: 'test-run-1',
    released_at: Date.now(),
  };

  const usable = await getLessonRelease(fakeDatabase(row), config());
  assert.equal(usable.releaseState, 'test-fixture');
  assert.equal(usable.canAssign, true);

  const guardOff = await getLessonRelease(
    fakeDatabase(row),
    config({ testContentAllowed: false }),
  );
  assert.equal(guardOff.releaseState, 'test-fixture');
  assert.equal(guardOff.canAssign, false);

  const wrongRun = await getLessonRelease(
    fakeDatabase(row),
    config({ testRunId: 'different-run' }),
  );
  assert.equal(wrongRun.canAssign, false);

  const wrongCandidate = await getLessonRelease(
    fakeDatabase(row),
    config({ candidateId: 'different-candidate' }),
  );
  assert.equal(wrongCandidate.canAssign, false);

  const editedContent = await getLessonRelease(
    fakeDatabase({ ...row, content_digest: `${digest.slice(0, -1)}0` }),
    config(),
  );
  assert.equal(editedContent.releaseState, 'pending');
  assert.equal(editedContent.canAssign, false);
});

test('[S2-AC-009][L-U04] ordinary owner approval remains distinct from a synthetic fixture', async () => {
  const digest = await lessonDigest();
  const approved = await getLessonRelease(
    fakeDatabase({
      lesson_version: FOREST_LESSON_VERSION,
      release_kind: 'owner-approved',
      content_digest: digest,
      reviewer_label: 'owner',
      evidence_ref: 'review-1',
      candidate_id: 'candidate-1',
      test_run_id: null,
      released_at: Date.now(),
    }),
    config({
      testMode: false,
      testContentAllowed: false,
      testRunId: null,
      testToken: null,
    }),
  );
  assert.equal(approved.releaseState, 'approved');
  assert.equal(approved.canAssign, true);
});

test('[S2-AC-009][L-U05] lesson assignment and run bodies accept only the server-selected version', () => {
  assert.equal(
    validateLessonVersionInput({ lessonVersion: FOREST_LESSON_VERSION }),
    true,
  );
  assert.equal(
    validateLessonVersionInput({
      lessonVersion: FOREST_LESSON_VERSION,
      candidateId: 'forged',
    }),
    false,
  );
  assert.equal(
    validateLessonVersionInput({ lessonVersion: 'forest-01-v2' }),
    false,
  );
});
