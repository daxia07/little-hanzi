import { parseCorpusBindings } from '../lib/pilot/corpus-config.ts';
import { inspectCorpusLearningQuery } from '../lib/pilot/corpus-learning-policy.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  corpusSeed,
  inspectCorpusStartInput,
  inspectCorpusAction,
} from '../lib/pilot/corpus-learning-policy.ts';
test('assignment seed is deterministic uint32 shared by all schedules', () => {
  assert.equal(corpusSeed('assignment'), corpusSeed('assignment'));
  assert.notEqual(corpusSeed('assignment'), corpusSeed('other'));
  assert.equal(corpusSeed(''), 2166136261);
});
for (const body of [
  { requestId: 'start', scheduleId: 'slot', clock: 0 },
  { requestId: 'start' },
  { requestId: 'start', scheduleId: false },
])
  test(
    'start refuses caller fields and wrong schedule shape ' +
      JSON.stringify(body),
    () => assert.throws(() => inspectCorpusStartInput(body), /INVALID_REQUEST/),
  );
for (const body of [
  {
    eventId: 'event',
    expectedRevision: 0,
    occurrenceId: null,
    type: 'continue',
    payload: {},
    soundReview: 'reviewed',
  },
  {
    eventId: 'event',
    expectedRevision: -1,
    occurrenceId: null,
    type: 'continue',
    payload: {},
  },
  {
    eventId: 'event',
    expectedRevision: 0,
    occurrenceId: null,
    type: 'answer',
    payload: { choiceId: 'choice', correct: true },
  },
  {
    eventId: 'event',
    expectedRevision: 0,
    occurrenceId: null,
    type: 'audio-unavailable',
    payload: { reason: 'fake' },
  },
])
  test(
    'action refuses caller authority and malformed shape ' +
      JSON.stringify(body),
    () => assert.throws(() => inspectCorpusAction(body), /INVALID_REQUEST/),
  );

for (const [operation, query] of [
  ['plan', 'corpusVersion=a&collectionVersion=b'],
  ['practice', 'corpusVersion=a&corpusVersion=b'],
  ['placement', 'corpusVersion=a&extra=b'],
  ['run', 'corpusVersion=a'],
  ['action', 'collectionVersion=b'],
])
  test('stored adapter/query rejects ' + operation + ' ' + query, () =>
    assert.throws(
      () => inspectCorpusLearningQuery(new URLSearchParams(query), operation),
      (e) => e.code === 'INVALID_REQUEST' && e.status === 400,
    ),
  );
test('fixture binding accepts exact240 installation bound without widening other corpus IDs', () => {
  for (const length of [120, 240])
    assert.equal(
      parseCorpusBindings({
        HANZI_CORPUS_FIXTURE_BINDING: JSON.stringify({
          schemaVersion: 'r6-fixture-binding-1',
          installationId: 'x'.repeat(length),
          mode: 'synthetic-only',
        }),
      }).fixtureBinding.installationId.length,
      length,
    );
  for (const installationId of ['', 'x'.repeat(241), '\ud800', false])
    assert.throws(
      () =>
        parseCorpusBindings({
          HANZI_CORPUS_FIXTURE_BINDING: JSON.stringify({
            schemaVersion: 'r6-fixture-binding-1',
            installationId,
            mode: 'synthetic-only',
          }),
        }),
      (e) => e.code === 'STORAGE_UNAVAILABLE',
    );
});
