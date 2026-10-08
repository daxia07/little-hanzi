import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPackage as json,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import {
  learningHistoryModel,
  learningDependencies,
} from './helpers/corpus-learning-history-model.mjs';
const baseline = process.env.CORPUS_LEARNING_STAGE_BASELINE === 'selection';
const validate = baseline
  ? async () => true
  : (await import('../scripts/pilot-corpus-learning-backup.mjs'))
      .validateCorpusLearningFacts;
const original = await learningHistoryModel();
const model = () => structuredClone(original);
const run = (f) => validate(f.payload, learningDependencies(f));
test('[R6-E-011/013] three replayable separate visits retain one original completion and two exact later schedules', async () => {
  const f = model(),
    before = json(f.payload);
  await run(f);
  assert.equal(json(f.payload), before);
  assert.equal(f.payload.tables.pilot_corpus_run.length, 3);
  const events = f.payload.tables.pilot_corpus_event.map(
    (e) => JSON.parse(e.result_json).event,
  );
  assert(
    events.some(
      (e) => e.result.firstResponse && e.result.outcome === 'incorrect',
    ),
  );
  assert(events.some((e) => e.result.assisted));
  assert(events.some((e) => e.result.outcome === 'unavailable'));
});
test('[R6-E-013] rewritten scoring or original request/ACK and incomplete or extra ledger facts refuse', async () => {
  for (const change of [
    (f) => {
      const r = f.payload.tables.pilot_corpus_run[0],
        x = JSON.parse(r.run_json);
      x.state.assisted = !x.state.assisted;
      r.run_json = json(x);
    },
    (f) => {
      const r = f.payload.tables.pilot_corpus_run[0],
        x = JSON.parse(r.start_ack_json);
      x.revision = 1;
      r.start_ack_json = json(x);
    },
    (f) => f.payload.tables.pilot_corpus_event.pop(),
    (f) => f.payload.tables.pilot_corpus_learning_audit.pop(),
    (f) => {
      const a = structuredClone(
        f.payload.tables.pilot_corpus_learning_audit[1],
      );
      a.id = 'extra-audit';
      f.payload.tables.pilot_corpus_learning_audit.push(a);
    },
    (f) => {
      const e = structuredClone(f.payload.tables.pilot_corpus_event[0]);
      e.id = 'extra-event';
      e.run_id = 'absent';
      f.payload.tables.pilot_corpus_event.push(e);
    },
  ]) {
    const f = model();
    change(f);
    await assert.rejects(() => run(f), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-011/013] wrong offsets, completion links, shared phase seed and before-due start refuse', async () => {
  for (const change of [
    (f) => f.payload.tables.pilot_corpus_schedule.pop(),
    (f) => f.payload.tables.pilot_corpus_schedule[1].due_at++,
    (f) =>
      (f.payload.tables.pilot_corpus_schedule[1].completion_event_id =
        f.payload.tables.pilot_corpus_event[0].id),
    (f) => f.payload.tables.pilot_corpus_run[1].seed++,
    (f) => f.payload.tables.pilot_corpus_run[1].created_at--,
  ]) {
    const f = model();
    change(f);
    await assert.rejects(() => run(f), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-013] false authority results at a later action or delayed start are not discarded', async () => {
  for (const at of [
    1001,
    original.payload.tables.pilot_corpus_run[1].created_at,
  ]) {
    const f = model();
    f.unavailableAt = at;
    await assert.rejects(() => run(f), /BACKUP_CORPUS_INVALID/);
  }
});
test('[R6-E-013] rehashed foreign group, snapshot or selected eligibility cannot authenticate event policy', async () => {
  for (const field of [
    'releaseId',
    'snapshotId',
    'sourceDigest',
    'packageEligibilityDigest',
    'reviewId',
  ]) {
    const f = model(),
      e = f.payload.tables.pilot_corpus_event[0],
      r = JSON.parse(e.result_json);
    if (field === 'packageEligibilityDigest')
      r.policy[field] = 'sha256:' + 'b'.repeat(64);
    else if (field === 'reviewId') r.policy[field] = 'unrelated-review';
    else {
      r.policy.authority[field] =
        field === 'sourceDigest' ? 'sha256:' + 'b'.repeat(64) : 'foreign';
      r.policy.authorityDigest = await H(r.policy.authority);
    }
    e.result_json = json(r);
    await assert.rejects(() => run(f), /BACKUP_CORPUS_INVALID/);
  }
});

test('[R6-E-005/013] rehashing away verification trust, capability or a scoped member still refuses', async () => {
  for (const change of [
    (config) => {
      config.capability = null;
    },
    (config) => {
      config.trust = null;
    },
    (config) => {
      config.capability.parentIds = ['unrelated-parent'];
    },
    (config) => {
      config.capability.childIds = ['unrelated-child'];
    },
  ]) {
    const f = model(),
      event = f.payload.tables.pilot_corpus_event[0],
      result = JSON.parse(event.result_json);
    change(result.policy.authority.configuration);
    result.policy.authorityDigest = await H(result.policy.authority);
    event.result_json = json(result);
    await assert.rejects(() => run(f), /BACKUP_CORPUS_INVALID/);
  }
});
