import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const MEMBER_CHECK_IDS = Object.freeze([
  'profile-source-assets',
  'familiarity-routes',
  'recognition-context',
  'delayed-replay',
  'safe-projection',
]);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort(compareText)
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
export const digest = (value) =>
  'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const exact = (value, keys) =>
  assert.deepEqual(
    Object.keys(value).sort(compareText),
    [...keys].sort(compareText),
  );
const text = (value) =>
  assert.equal(typeof value === 'string' && value.trim().length > 0, true);
export function inspectLiteralOracle(input) {
  const oracle = structuredClone(input);
  exact(oracle, [
    'schemaVersion',
    'lessonVersion',
    'contentDigest',
    'targets',
    'checks',
  ]);
  assert.equal(oracle.schemaVersion, 'r6-member-oracle-1');
  text(oracle.lessonVersion);
  assert.match(oracle.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(oracle.targets.length, 2);
  assert.equal(new Set(oracle.targets.map((t) => t.characterId)).size, 2);
  for (const target of oracle.targets) {
    exact(target, ['characterId', 'hanzi', 'reading', 'words']);
    text(target.characterId);
    assert.equal(Array.from(target.hanzi).length, 1);
    assert.match(target.hanzi, /^\p{Script=Han}$/u);
    exact(target.reading, ['readingId', 'pinyin', 'audioText']);
    Object.values(target.reading).forEach(text);
    assert.equal(target.words.length, 2);
    assert.equal(new Set(target.words.map((w) => w.text)).size, 2);
    for (const word of target.words) {
      exact(word, ['wordId', 'text', 'pinyin', 'english', 'context']);
      ['wordId', 'text', 'pinyin', 'english'].forEach((key) => text(word[key]));
      exact(word.context, ['hanzi', 'english']);
      Object.values(word.context).forEach(text);
      assert(word.text.includes(target.hanzi));
      assert(word.context.hanzi.includes(word.text));
    }
  }
  assert.equal(oracle.checks.length, 10);
  assert.equal(new Set(oracle.checks.map((c) => c.checkId)).size, 10);
  for (const check of oracle.checks) {
    exact(check, [
      'checkId',
      'characterId',
      'kind',
      'expectedHanzi',
      'promptHanzi',
    ]);
    text(check.checkId);
    const target = oracle.targets.find(
      (t) => t.characterId === check.characterId,
    );
    assert(target);
    assert.equal(check.expectedHanzi, target.hanzi);
    assert(['plain-print', 'word-context'].includes(check.kind));
    assert(
      check.kind === 'word-context'
        ? target.words.some((w) => w.text === check.promptHanzi)
        : target.reading.audioText === check.promptHanzi,
    );
  }
  for (const target of oracle.targets) {
    const checks = oracle.checks.filter(
      (c) => c.characterId === target.characterId,
    );
    assert.equal(checks.filter((c) => c.kind === 'plain-print').length, 3);
    assert.equal(checks.filter((c) => c.kind === 'word-context').length, 2);
  }
  return oracle;
}
export function literalChoice(question, oracle) {
  const check = oracle.checks.find((c) => c.checkId === question.checkId);
  assert(check, 'Current check is absent from the independent literal oracle');
  assert.equal(question.characterId, check.characterId);
  assert.equal(question.kind, check.kind);
  assert.equal(question.audioText, check.promptHanzi);
  const matches = question.choices.filter(
    (c) => c.hanzi === check.expectedHanzi,
  );
  assert.equal(
    matches.length,
    1,
    'Exactly one public print choice must match literal target',
  );
  return matches[0];
}
