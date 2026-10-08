import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRun,
  choicesFor,
  summarize,
} from '../../docs/design/readiness/state.mjs';
function answer(run, id, choice) {
  run.audioStarted(id, choice.startsWith('audio-') ? choice : null);
  return run.answer(id, choice);
}
test('setup retains edits; explicit sound and confirmation are mandatory', () => {
  const r = createRun();
  assert.equal(r.setup.sound, null);
  assert.equal(r.setup.confirmed, false);
  r.setup.nickname = '  Bea  ';
  assert.equal(r.prepare(), false);
  assert.equal(r.setup.nickname, '  Bea  ');
  r.setup.sound = 'heard';
  assert.equal(r.prepare(), true);
  assert.equal(r.confirm(), false);
  r.setup.confirmed = true;
  assert.equal(r.confirm(), true);
  assert.equal(r.setup.nickname, 'Bea');
  assert.equal(r.step, 'handover');
});
test('rotation uses independent seed 17 oracle and delayed positions change', () => {
  assert.deepEqual(choicesFor('fam-mu'), ['ren', 'mu', 'lin']);
  assert.deepEqual(choicesFor('check-mu-sound'), ['mu', 'lin', 'ren']);
  assert.deepEqual(choicesFor('review-mu-sound'), ['lin', 'ren', 'mu']);
});
test('routing uses actual first responses and preserves help history', () => {
  const r = createRun('familiar');
  answer(r, 'fam-mu', 'lin');
  assert.equal(r.questions['fam-mu'].status, 'open');
  r.help('fam-mu');
  answer(r, 'fam-mu', 'mu');
  answer(r, 'fam-lin', 'lin');
  assert.equal(r.route(), 'mixed-lin');
  assert.equal(r.questions['fam-mu'].first, 'lin');
  assert.equal(r.questions['fam-mu'].assisted, true);
  assert.equal(r.introduction('mu').kind, 'learn');
  assert.equal(r.introduction('lin').kind, 'reminder');
});
test('required cue and selected audio option must start before answering', () => {
  const r = createRun();
  assert.equal(r.answer('fam-mu', 'mu'), false);
  assert.equal(r.answer('check-mu-reading', 'audio-mu'), false);
  r.audioStarted('check-mu-reading', 'audio-lin');
  assert.equal(r.answer('check-mu-reading', 'audio-mu'), false);
});
test('two wrong answers demonstrate; later help remains question-local; exact 1/2/1 recap', () => {
  const r = createRun('needs-help');
  answer(r, 'check-mu-sound', 'lin');
  assert.equal(r.questions['check-mu-sound'].helpLevel, 1);
  answer(r, 'check-mu-sound', 'ren');
  assert.equal(r.questions['check-mu-sound'].status, 'demonstrated');
  answer(r, 'check-lin-sound', 'lin');
  r.help('check-mu-reading');
  answer(r, 'check-mu-reading', 'audio-mu');
  r.unavailable('check-lin-reading');
  assert.deepEqual(summarize(r, 'final'), {
    total: 4,
    independentCorrect: 1,
    supported: 2,
    unavailable: 1,
    pending: 0,
  });
  assert.equal(r.questions['check-mu-sound'].first, 'lin');
});
test('games are separate; same piece cannot fill both slots', () => {
  const r = createRun();
  r.place('mu-a', 'left');
  assert.equal(r.buildComplete(), false);
  r.place('mu-a', 'right');
  assert.equal(r.buildComplete(), false);
  r.place('mu-b', 'left');
  assert.equal(r.buildComplete(), true);
  assert.equal(summarize(r, 'final').independentCorrect, 0);
});
test('synthetic resume, review clock, pending retry and expiry cannot invent saved state', () => {
  assert.equal(createRun('resume').step, 'build');
  assert.equal(createRun('resume').presetFamiliarity, true);
  const due = createRun('due'),
    early = createRun('not-due');
  assert.equal(due.reviewDue, true);
  assert.equal(early.reviewDue, false);
  assert.equal(
    Date.parse(due.serverAt) - Date.parse(due.completedAt),
    86400000,
  );
  assert.equal(
    Date.parse(early.serverAt) - Date.parse(early.completedAt),
    82800000,
  );
  const pending = createRun('pending-save');
  pending.retry();
  assert.equal(pending.notice, 'Sample retry complete; nothing saved');
  const expired = createRun('session-expired');
  assert.equal(expired.evidenceVisible, false);
  expired.signIn();
  assert.equal(expired.evidenceVisible, true);
  assert.equal(expired.step, 'parent-recap');
  assert.equal(expired.saved, false);
});
test('reset starts fresh evidence even after a completed run', () => {
  const old = createRun();
  answer(old, 'check-mu-sound', 'mu');
  assert.equal(summarize(createRun(), 'final').pending, 4);
});

test('failed cue or option withdraws started credit from unanswered question', () => {
  const r = createRun();
  r.audioStarted('fam-mu');
  r.audioFailed('fam-mu');
  assert.equal(r.answer('fam-mu', 'mu'), false);
  r.audioStarted('check-mu-reading', 'audio-mu');
  r.audioFailed('check-mu-reading', 'audio-mu');
  assert.equal(r.answer('check-mu-reading', 'audio-mu'), false);
});

test('speech error after current answer preserves history but withdraws independent credit', () => {
  const r = createRun();
  answer(r, 'check-mu-sound', 'mu');
  r.audioFailed('check-mu-sound');
  assert.equal(r.questions['check-mu-sound'].first, 'mu');
  assert.deepEqual(r.questions['check-mu-sound'].attempts, ['mu']);
  assert.equal(r.questions['check-mu-sound'].status, 'unavailable');
  assert.equal(summarize(r, 'final').independentCorrect, 0);
  assert.equal(summarize(r, 'final').unavailable, 1);
});

test('failed required cue is unavailable, and a successful retry reopens without a wrong response', () => {
  const r = createRun();
  r.audioFailed('fam-mu');
  assert.equal(r.questions['fam-mu'].status, 'unavailable');
  assert.equal(summarize(r, 'familiarity').unavailable, 1);
  r.audioStarted('fam-mu');
  assert.equal(r.questions['fam-mu'].status, 'open');
  assert.equal(r.questions['fam-mu'].first, null);
  assert.equal(r.answer('fam-mu', 'mu'), true);
});

test('find is a print game and remains playable without required speech', () => {
  const r = createRun();
  assert.equal(r.answer('find-mu', 'mu'), true);
  assert.equal(r.answer('find-lin', 'lin'), true);
  assert.equal(summarize(r, 'final').independentCorrect, 0);
});

test('requested help does not replace the first-wrong retry before demonstration', () => {
  const r = createRun();
  r.help('check-mu-sound');
  answer(r, 'check-mu-sound', 'lin');
  assert.equal(r.questions['check-mu-sound'].helpLevel, 1);
  assert.equal(r.questions['check-mu-sound'].status, 'open');
  answer(r, 'check-mu-sound', 'ren');
  assert.equal(r.questions['check-mu-sound'].helpLevel, 2);
  assert.equal(r.questions['check-mu-sound'].status, 'demonstrated');
});
test('actual familiarity results yield one combined familiar reminder or two differentiated introductions', () => {
  const familiar = createRun('new');
  answer(familiar, 'fam-mu', 'mu');
  answer(familiar, 'fam-lin', 'lin');
  assert.deepEqual(familiar.learningPages(), [
    { targets: ['mu', 'lin'], kind: 'reminder' },
  ]);
  const mixed = createRun('familiar');
  answer(mixed, 'fam-mu', 'mu');
  mixed.unavailable('fam-lin');
  assert.deepEqual(mixed.learningPages(), [
    { targets: ['mu'], kind: 'reminder' },
    { targets: ['lin'], kind: 'learn' },
  ]);
  const fresh = createRun('familiar');
  fresh.unavailable('fam-mu');
  fresh.unavailable('fam-lin');
  assert.equal(fresh.learningPages().length, 2);
  assert.equal(
    fresh.learningPages().every((p) => p.kind === 'learn'),
    true,
  );
});
