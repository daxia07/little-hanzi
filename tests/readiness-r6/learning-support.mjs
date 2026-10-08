/** Independent assertions/action planner for actual persisted R6 store tests. No execution evidence by itself. */
import assert from 'node:assert/strict';
import { canonical, digest, literalChoice } from './oracle.mjs';

export const LEARNING_TABLES = Object.freeze([
  'pilot_corpus_run',
  'pilot_corpus_event',
  'pilot_corpus_schedule',
  'pilot_corpus_learning_audit',
]);
export async function learningRows(client) {
  const rows = {};
  for (const table of LEARNING_TABLES)
    rows[table] = (
      await client.execute('SELECT * FROM ' + table + ' ORDER BY id')
    ).rows;
  return rows;
}
export function assertUnchangedRows(before, after) {
  assert.equal(
    canonical(after),
    canonical(before),
    'Rejected write changed durable learning facts',
  );
}
export function independentSeed(assignmentId) {
  let seed = 2166136261;
  for (let i = 0; i < assignmentId.length; i++)
    seed = Math.imul(seed ^ assignmentId.charCodeAt(i), 16777619);
  return seed >>> 0;
}
export function actionBody(view, eventId, type, payload = {}) {
  assert.equal(view.schemaVersion, 'r6-story-view-1');
  assert(Number.isSafeInteger(view.revision));
  return {
    eventId,
    expectedRevision: view.revision,
    occurrenceId: view.question?.occurrenceId ?? null,
    type,
    payload,
  };
}
export function literalNextAction(view, oracle, eventId) {
  if (view.question?.status === 'open')
    return actionBody(view, eventId, 'answer', {
      choiceId: literalChoice(view.question, oracle).choiceId,
    });
  return actionBody(view, eventId, 'continue');
}
export function assertClosedEventPolicy(policy, identity) {
  assert.deepEqual(Object.keys(policy).sort(), [
    'authority',
    'authorityDigest',
    'packageEligibilityDigest',
    'proofId',
    'reviewId',
    'soundReview',
  ]);
  assert.equal(policy.authorityDigest, digest(policy.authority));
  assert.match(policy.packageEligibilityDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(policy.authority.schemaVersion, 'r6-authority-1');
  for (const [key, value] of Object.entries(identity))
    assert.equal(
      policy.authority[key],
      value,
      'Event authority identity ' + key,
    );
  assert(['synthetic', 'pending', 'reviewed'].includes(policy.soundReview));
}
export function assertSafeRun(view) {
  const forbidden = new Set([
    'correctChoiceId',
    'expectedAnswerHanzi',
    'pairedStory',
    'authority',
    'authorityDigest',
    'packageEligibilityDigest',
    'configuration',
  ]);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbidden.has(key), 'Private field in safe run: ' + key);
      inspect(child);
    }
  }
  inspect(view);
  assert.equal(view.schemaVersion, 'r6-story-view-1');
  assert.equal(view.adapterId, 'corpus-paired');
  assert.equal(view.adapterVersion, 'corpus-paired-v1');
}
