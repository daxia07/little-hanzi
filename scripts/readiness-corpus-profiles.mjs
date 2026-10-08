/** Closed runner-only assets. Neither profile is human-reviewed curriculum. */
const profiles = Object.freeze({
  'draft-corpus': Object.freeze({
    name: 'draft-corpus',
    manifestPath: 'content/corpora/hanzi-starter-draft-v1.json',
    packageDirectory: 'content/curriculum/corpus',
    batchDirectory: 'content/corpora/batches',
    oraclePath: 'tests/fixtures/curriculum/corpus-draft/oracles.json',
  }),
  'stress-corpus': Object.freeze({
    name: 'stress-corpus',
    manifestPath: 'tests/fixtures/curriculum/corpus-stress/corpus.json',
    packageDirectory: 'tests/fixtures/curriculum/corpus-stress/packages',
    batchDirectory: 'tests/fixtures/curriculum/corpus-stress/batches',
    oraclePath: 'tests/fixtures/curriculum/corpus-stress/oracles.json',
  }),
});
export function corpusProfile(name = 'draft-corpus') {
  if (typeof name !== 'string' || !Object.hasOwn(profiles, name))
    throw new Error('CORPUS_PROFILE_INVALID');
  return profiles[name];
}
