import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
const root = path.resolve(import.meta.dirname, '..');
const baseline = process.env.CORPUS_FIXTURE_BASELINE === 'collection';
const corpusProfile = baseline
  ? (await import('../scripts/readiness-collection-profiles.mjs'))
      .collectionProfile
  : (await import('../scripts/readiness-corpus-profiles.mjs')).corpusProfile;
const read = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('[R6-E-005] the runner accepts only fixed immutable corpus profiles, never paths or prototype names', () => {
  for (const name of ['draft-corpus', 'stress-corpus']) {
    const profile = corpusProfile(name);
    assert.equal(profile.name, name);
    assert.equal(Object.isFrozen(profile), true);
    assert.ok(profile.manifestPath.endsWith('.json'));
    assert.ok(profile.oraclePath.endsWith('/oracles.json'));
  }
  for (const input of [
    '../content',
    'constructor',
    '__proto__',
    '',
    null,
    {},
    'positive-collection',
  ])
    assert.throws(() => corpusProfile(input), /CORPUS_PROFILE_INVALID/);
});

test('[R6-E-001][R6-E-017] the twenty-character corpus preserves pending authored teaching and uses new exact R6 identities', async () => {
  const profile = corpusProfile('draft-corpus');
  const corpus = read(profile.manifestPath);
  const oracles = read(profile.oraclePath);
  assert.equal(corpus.schemaVersion, 'r6-corpus-1');
  assert.equal(corpus.items.length, 10);
  assert.equal(oracles.corpusDigest, await curriculumDigest(corpus));
  const expected = [
    '木林',
    '日月',
    '人口',
    '山水',
    '大小',
    '上下',
    '田土',
    '火雨',
    '手目',
    '门车',
  ];
  for (const [index, item] of corpus.items.entries()) {
    const old = read(
      `content/curriculum/collection/path-${String(index + 1).padStart(2, '0')}-v1.json`,
    );
    const current = read(
      `${profile.packageDirectory}/${item.lessonVersion}.json`,
    );
    assert.notEqual(current.lessonVersion, old.lessonVersion);
    assert.equal(current.renderer.adapterId, 'corpus-paired');
    assert.equal(item.contentDigest, await curriculumDigest(current));
    assert.equal(
      current.characters.map((c) => c.hanzi).join(''),
      expected[index],
    );
    const normalized = structuredClone(current);
    normalized.lessonId = old.lessonId;
    normalized.lessonVersion = old.lessonVersion;
    normalized.renderer = old.renderer;
    assert.deepEqual(
      normalized,
      old,
      'R6 must not silently edit pending teaching, sources or audio',
    );
    assert.deepEqual(current.pairedStory.playback.voices, []);
    assert.ok(
      current.characters.every((c) =>
        c.readings.every((r) => !r.provenance.sourceChecked),
      ),
    );
    assert.equal(oracles.items[index].contentDigest, item.contentDigest);
    assert.deepEqual(
      oracles.items[index].targets.map((t) => t.hanzi),
      Array.from(expected[index]),
    );
  }
});

test('[R6-E-004][R6-E-005][R6-E-014] the fixed stress manifest binds 800 synthetic pairs, 1600 literal targets and sixteen bounded batches', async () => {
  const profile = corpusProfile('stress-corpus');
  const corpus = read(profile.manifestPath);
  const oracles = read(profile.oraclePath);
  assert.equal(corpus.items.length, 800);
  assert.equal(oracles.items.length, 800);
  assert.equal(oracles.corpusDigest, await curriculumDigest(corpus));
  const seen = new Set();
  for (const [index, item] of corpus.items.entries()) {
    const current = read(
      `${profile.packageDirectory}/${item.lessonVersion}.json`,
    );
    const oracle = oracles.items[index];
    assert.equal(await curriculumDigest(current), item.contentDigest);
    assert.equal(oracle.contentDigest, item.contentDigest);
    assert.equal(oracle.lessonVersion, item.lessonVersion);
    assert.match(current.title, /^SIMULATED /);
    assert.equal(current.renderer.adapterId, 'corpus-paired');
    assert.equal(oracle.checks.length, 10);
    for (const [targetIndex, target] of current.characters.entries()) {
      const expected = String.fromCodePoint(0x3400 + index * 2 + targetIndex);
      assert.equal(target.hanzi, expected);
      assert.equal(oracle.targets[targetIndex].hanzi, expected);
      assert.match(target.readings[0].provenance.source, /SIMULATED/);
      assert.equal(target.wordAssociations.length, 2);
      assert.equal(new Set(target.wordAssociations.map((w) => w.text)).size, 2);
      for (const check of oracle.checks.filter(
        (c) => c.characterId === target.characterId,
      ))
        assert.equal(
          check.expectedHanzi,
          expected,
          'literal oracle cannot copy a grader choice ID',
        );
      seen.add(expected);
    }
  }
  assert.equal(seen.size, 1600);
  const batches = fs
    .readdirSync(path.join(root, profile.batchDirectory))
    .filter((f) => f.endsWith('.json'));
  assert.equal(batches.length, 16);
  assert.equal(
    batches.reduce((count, name) => {
      const batch = read(`${profile.batchDirectory}/${name}`);
      assert.equal(batch.items.length, 50);
      assert.equal(batch.intendedScope, 'draft');
      return count + batch.items.length;
    }, 0),
    800,
  );
});
