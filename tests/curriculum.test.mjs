import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FIXTURE_PATH = new URL(
  './fixtures/curriculum/forest-01-v2.json',
  import.meta.url,
);
const VALID_PACKAGE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

function clonePackage(value = VALID_PACKAGE) {
  return structuredClone(value);
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .reverse()
      .map((key) => [key, reverseObjectKeys(value[key])]),
  );
}

function errorPaths(result) {
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  for (const error of result.errors) {
    assert.equal(typeof error.path, 'string');
    assert.equal(typeof error.code, 'string');
    assert.notEqual(error.code.length, 0);
  }
  return result.errors.map((error) => error.path);
}

function assertError(result, pattern, code) {
  const errors = result.errors;
  errorPaths(result);
  assert.ok(
    errors.some((error) => pattern.test(error.path) && error.code === code),
    `expected ${code} at ${pattern}, got ${errors
      .map((error) => `${error.path}:${error.code}`)
      .join(', ')}`,
  );
}

function assertValid(result) {
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
}

async function loadCurriculumModules() {
  try {
    const [validator, digest] = await Promise.all([
      import('../lib/curriculum/validate.ts'),
      import('../lib/curriculum/digest.ts'),
    ]);
    return { validator, digest };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      error.code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error(
        'curriculum validator/digest implementation is unavailable',
      );
    }
    throw new Error(
      'curriculum validator/digest implementation could not load',
    );
  }
}

function assertDigest(value) {
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
}

function retargetCharacter(value, index, hanzi, words, contexts) {
  const character = value.characters[index];
  const oldHanzi = character.hanzi;
  character.hanzi = hanzi;
  character.readings.forEach((reading) => {
    reading.audioText = hanzi;
  });
  character.wordAssociations.forEach((association, wordIndex) => {
    association.text = words[wordIndex];
    association.context.hanzi = contexts[wordIndex];
    association.context.targetCharacter = hanzi;
  });
  for (const check of value.recognitionChecks) {
    if (check.characterId !== character.characterId) continue;
    const wordIndex = check.kind === 'word-context' ? 0 : null;
    check.prompt.hanzi = wordIndex === null ? hanzi : words[wordIndex];
    const correct = check.choices.find(
      (choice) => choice.choiceId === check.correctChoiceId,
    );
    if (correct) correct.hanzi = hanzi;
  }
  assert.notEqual(oldHanzi, hanzi);
  return value;
}

test('[S3-AC-003][C-U-00] curriculum validator and digest modules expose the agreed API', async () => {
  const api = await loadCurriculumModules();
  assert.deepEqual(Object.keys(api.validator).sort(), [
    'validateCurriculumPackage',
  ]);
  assert.deepEqual(Object.keys(api.digest).sort(), [
    'canonicalPackage',
    'curriculumDigest',
  ]);
  assert.equal(typeof api.validator.validateCurriculumPackage, 'function');
  assert.equal(typeof api.digest.canonicalPackage, 'function');
  assert.equal(typeof api.digest.curriculumDigest, 'function');
});

test('[S3-AC-003][C-U-01] the two-character 木林 package is machine-valid', async () => {
  const api = await loadCurriculumModules();
  const result = api.validator.validateCurriculumPackage(clonePackage());
  assertValid(result);
  const digest = await api.digest.curriculumDigest(clonePackage());
  assertDigest(digest);
});

test('[S3-AC-003][C-U-02] required English and context fields report stable actionable paths', async () => {
  const api = await loadCurriculumModules();
  const missingRecovery = clonePackage();
  delete missingRecovery.instructionsEnglish.recovery;
  const firstRecovery =
    api.validator.validateCurriculumPackage(missingRecovery);
  const secondRecovery =
    api.validator.validateCurriculumPackage(missingRecovery);
  assert.deepEqual(firstRecovery, secondRecovery);
  assertError(firstRecovery, /^instructionsEnglish\.recovery$/, 'MISSING_KEY');

  const missingContext = clonePackage();
  delete missingContext.characters[0].wordAssociations[0].context.english;
  assertError(
    api.validator.validateCurriculumPackage(missingContext),
    /^characters\[0\]\.wordAssociations\[0\]\.context\.english$/,
    'MISSING_KEY',
  );

  const missingStepInstruction = clonePackage();
  missingStepInstruction.steps[2].instructionEnglish = '';
  assertError(
    api.validator.validateCurriculumPackage(missingStepInstruction),
    /^steps\[2\]\.instructionEnglish$/,
    'EMPTY_STRING',
  );
});

test('[S3-AC-003][C-U-03] references, correct choices and delayed-review links are complete', async () => {
  const api = await loadCurriculumModules();

  const missingReading = clonePackage();
  missingReading.characters[0].wordAssociations[0].readingId =
    'reading-does-not-exist';
  assertError(
    api.validator.validateCurriculumPackage(missingReading),
    /^characters\[0\]\.wordAssociations\[0\]\.readingId$/,
    'REFERENCE_UNKNOWN',
  );

  const missingTeachingCheck = clonePackage();
  missingTeachingCheck.characters[0].teaching.recognitionCheckId =
    'check-does-not-exist';
  assertError(
    api.validator.validateCurriculumPackage(missingTeachingCheck),
    /^characters\[0\]\.teaching\.recognitionCheckId$/,
    'REFERENCE_UNKNOWN',
  );

  const missingDelayedCheck = clonePackage();
  missingDelayedCheck.characters[0].teaching.delayedReview.recognitionCheckId =
    'check-does-not-exist';
  assertError(
    api.validator.validateCurriculumPackage(missingDelayedCheck),
    /^characters\[0\]\.teaching\.delayedReview\.recognitionCheckId$/,
    'REFERENCE_UNKNOWN',
  );

  const wrongChoice = clonePackage();
  wrongChoice.recognitionChecks[0].correctChoiceId = 'choice-does-not-exist';
  assertError(
    api.validator.validateCurriculumPackage(wrongChoice),
    /^recognitionChecks\[0\]\.correctChoiceId$/,
    'CORRECT_CHOICE_MISSING',
  );

  const unknownStepCheck = clonePackage();
  unknownStepCheck.steps[1].recognitionCheckIds = ['check-does-not-exist'];
  assertError(
    api.validator.validateCurriculumPackage(unknownStepCheck),
    /^steps\[1\]\.recognitionCheckIds\[0\]$/,
    'REFERENCE_UNKNOWN',
  );
});

test('[S3-AC-003][C-U-04] each character keeps two contextual words and distinct identities', async () => {
  const api = await loadCurriculumModules();

  const oneWord = clonePackage();
  oneWord.characters[0].wordAssociations.pop();
  assertError(
    api.validator.validateCurriculumPackage(oneWord),
    /^characters\[0\]\.wordAssociations$/,
    'ARRAY_TOO_SHORT',
  );

  const duplicateCharacter = clonePackage();
  duplicateCharacter.characters[1].characterId =
    duplicateCharacter.characters[0].characterId;
  assertError(
    api.validator.validateCurriculumPackage(duplicateCharacter),
    /^characters\[1\]\.characterId$/,
    'DUPLICATE_ID',
  );

  const duplicateWord = clonePackage();
  duplicateWord.characters[0].wordAssociations[1].wordId =
    duplicateWord.characters[0].wordAssociations[0].wordId;
  assertError(
    api.validator.validateCurriculumPackage(duplicateWord),
    /^characters\[0\]\.wordAssociations\[1\]\.wordId$/,
    'DUPLICATE_ID',
  );

  const wrongTarget = clonePackage();
  wrongTarget.characters[0].wordAssociations[0].context.targetCharacter = '林';
  assertError(
    api.validator.validateCurriculumPackage(wrongTarget),
    /^characters\[0\]\.wordAssociations\[0\]\.context\.targetCharacter$/,
    'CHARACTER_MISMATCH',
  );
});

test('[S3-AC-003][C-U-05] English teaching fields and provenance cannot be omitted', async () => {
  const api = await loadCurriculumModules();

  const missingHint = clonePackage();
  missingHint.characters[1].teaching.hintEnglish = '';
  assertError(
    api.validator.validateCurriculumPackage(missingHint),
    /^characters\[1\]\.teaching\.hintEnglish$/,
    'EMPTY_STRING',
  );

  const missingMeaningProvenance = clonePackage();
  delete missingMeaningProvenance.characters[0].meanings[0].provenance.license;
  assertError(
    api.validator.validateCurriculumPackage(missingMeaningProvenance),
    /^characters\[0\]\.meanings\[0\]\.provenance$/,
    'PROVENANCE_INCOMPLETE',
  );

  const missingWordEvidence = clonePackage();
  delete missingWordEvidence.characters[1].wordAssociations[0].provenance
    .evidenceRef;
  assertError(
    api.validator.validateCurriculumPackage(missingWordEvidence),
    /^characters\[1\]\.wordAssociations\[0\]\.provenance$/,
    'PROVENANCE_INCOMPLETE',
  );

  const missingAssetLicense = clonePackage();
  missingAssetLicense.assets[2].license = '';
  assertError(
    api.validator.validateCurriculumPackage(missingAssetLicense),
    /^assets\[2\]\.license$/,
    'EMPTY_STRING',
  );

  const assetAudioText = clonePackage();
  assetAudioText.characters[0].readings[0].audioText = 'asset-audio-mandarin';
  assertError(
    api.validator.validateCurriculumPackage(assetAudioText),
    /^characters\[0\]\.readings\[0\]\.audioText$/,
    'AUDIO_TEXT_INVALID',
  );
});

test('[S3-AC-003][C-U-06] Hanzi validation counts Unicode scalars without deciding simplified status', async () => {
  const api = await loadCurriculumModules();

  const traditionalScalar = retargetCharacter(
    clonePackage(),
    0,
    '體',
    ['體育', '體操'],
    ['我們喜歡體育。', '這是一套體操。'],
  );
  assertValid(api.validator.validateCurriculumPackage(traditionalScalar));

  const multipleHanzi = clonePackage();
  multipleHanzi.characters[0].hanzi = '木林';
  assertError(
    api.validator.validateCurriculumPackage(multipleHanzi),
    /^characters\[0\]\.hanzi$/,
    'HANZI_NOT_SINGLE_HAN',
  );

  const nonNfcHanzi = clonePackage();
  nonNfcHanzi.characters[0].hanzi = '\uFA19';
  assertError(
    api.validator.validateCurriculumPackage(nonNfcHanzi),
    /^characters\[0\]\.hanzi$/,
    'HANZI_NOT_NFC',
  );

  const emoji = clonePackage();
  emoji.characters[0].hanzi = '😀';
  assertError(
    api.validator.validateCurriculumPackage(emoji),
    /^characters\[0\]\.hanzi$/,
    'HANZI_NOT_SINGLE_HAN',
  );

  const ascii = clonePackage();
  ascii.characters[0].hanzi = 'A';
  assertError(
    api.validator.validateCurriculumPackage(ascii),
    /^characters\[0\]\.hanzi$/,
    'HANZI_NOT_SINGLE_HAN',
  );
});

test('[S3-AC-003][C-U-07] IDs, bounds, choices and renderer capabilities fail closed', async () => {
  const api = await loadCurriculumModules();

  const invalidId = clonePackage();
  invalidId.characters[0].characterId = 'CHAR MU';
  assertError(
    api.validator.validateCurriculumPackage(invalidId),
    /^characters\[0\]\.characterId$/,
    'ID_FORMAT',
  );

  const invalidSequence = clonePackage();
  invalidSequence.placement.sequence = -1;
  assertError(
    api.validator.validateCurriculumPackage(invalidSequence),
    /^placement\.sequence$/,
    'SEQUENCE_INVALID',
  );

  const duplicateChoice = clonePackage();
  duplicateChoice.recognitionChecks[0].choices[1].choiceId =
    duplicateChoice.recognitionChecks[0].choices[0].choiceId;
  assertError(
    api.validator.validateCurriculumPackage(duplicateChoice),
    /^recognitionChecks\[0\]\.choices\[1\]\.choiceId$/,
    'CHOICE_DUPLICATE',
  );

  const missingCapability = clonePackage();
  missingCapability.renderer.capabilities = ['selection-v1'];
  assertError(
    api.validator.validateCurriculumPackage(missingCapability),
    /^renderer\.capabilities$/,
    'CAPABILITY_SET_INVALID',
  );

  const reorderedCapabilities = clonePackage();
  reorderedCapabilities.renderer.capabilities.reverse();
  assertError(
    api.validator.validateCurriculumPackage(reorderedCapabilities),
    /^renderer\.capabilities$/,
    'CAPABILITY_SET_INVALID',
  );
});

test('[S3-AC-003][C-U-07b] whitespace, approval-shaped fields and unsafe input never become review facts', async () => {
  const api = await loadCurriculumModules();

  const unknownApproval = clonePackage();
  unknownApproval.reviewed = true;
  assertError(
    api.validator.validateCurriculumPackage(unknownApproval),
    /^reviewed$/,
    'UNKNOWN_KEY',
  );

  const unknownNestedApproval = clonePackage();
  unknownNestedApproval.characters[0].reviewerLabel = 'synthetic';
  assertError(
    api.validator.validateCurriculumPackage(unknownNestedApproval),
    /^characters\[0\]\.reviewerLabel$/,
    'UNKNOWN_KEY',
  );

  const whitespace = clonePackage();
  whitespace.title = ' Build a Little Forest';
  assertError(
    api.validator.validateCurriculumPackage(whitespace),
    /^title$/,
    'NOT_TRIMMED',
  );

  const blank = clonePackage();
  blank.title = '';
  assertError(
    api.validator.validateCurriculumPackage(blank),
    /^title$/,
    'EMPTY_STRING',
  );

  const nonfinite = clonePackage();
  nonfinite.placement.sequence = Number.NaN;
  assertError(
    api.validator.validateCurriculumPackage(nonfinite),
    /^placement\.sequence$/,
    'NONFINITE_NUMBER',
  );

  const cyclic = clonePackage();
  cyclic.self = cyclic;
  assertError(
    api.validator.validateCurriculumPackage(cyclic),
    /^\$$/,
    'CYCLIC_VALUE',
  );

  const unsafe = clonePackage();
  unsafe.title = () => 'unsafe';
  assertError(
    api.validator.validateCurriculumPackage(unsafe),
    /^title$/,
    'UNSAFE_JSON_VALUE',
  );
});

test('[S3-AC-002][C-U-08] canonical JSON ignores object key order but preserves array order and content changes', async () => {
  const api = await loadCurriculumModules();
  const original = clonePackage();
  const canonical = api.digest.canonicalPackage(original);
  const reordered = reverseObjectKeys(original);
  const reorderedCanonical = api.digest.canonicalPackage(reordered);
  assert.equal(reorderedCanonical, canonical);
  assert.equal(
    await api.digest.curriculumDigest(reordered),
    await api.digest.curriculumDigest(original),
  );

  const arrayReordered = clonePackage();
  arrayReordered.steps.reverse();
  assert.notEqual(api.digest.canonicalPackage(arrayReordered), canonical);
  assert.notEqual(
    await api.digest.curriculumDigest(arrayReordered),
    await api.digest.curriculumDigest(original),
  );

  const changedContext = clonePackage();
  changedContext.characters[1].wordAssociations[1].context.english =
    'A little bird enters the grove.';
  assert.notEqual(
    await api.digest.curriculumDigest(changedContext),
    await api.digest.curriculumDigest(original),
  );
  assert.deepEqual(original, VALID_PACKAGE);
});

test('[S3-AC-002][C-U-09] canonical JSON rejects unsupported values and cycles deterministically', async () => {
  const api = await loadCurriculumModules();
  const unsupportedValues = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    () => {},
    Symbol('x'),
    1n,
  ];
  for (const value of unsupportedValues) {
    assert.throws(
      () => api.digest.canonicalPackage(value),
      /unsupported|non.?JSON|cycle|serializ/i,
    );
  }
  assert.equal(api.digest.canonicalPackage(-0), '0');

  for (const value of [new Date(), new Map(), new Set(), new Uint8Array([1])]) {
    assert.throws(() => api.digest.canonicalPackage(value));
  }

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => api.digest.canonicalPackage(sparse));

  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      return 'unsafe';
    },
  });
  assert.throws(() => api.digest.canonicalPackage(accessor));

  const symbolKey = { value: 'unsafe' };
  symbolKey[Symbol('private')] = 'unsafe';
  assert.throws(() => api.digest.canonicalPackage(symbolKey));

  assert.throws(() => api.digest.canonicalPackage({ hanzi: '\uFA19' }));
  assert.equal(
    api.digest.canonicalPackage({ value: '  keep spaces  ' }),
    '{"value":"  keep spaces  "}',
  );

  const nestedUndefined = clonePackage();
  nestedUndefined.extra = undefined;
  assert.throws(
    () => api.digest.canonicalPackage(nestedUndefined),
    /unsupported|non.?JSON|serializ/i,
  );

  const cyclic = clonePackage();
  cyclic.self = cyclic;
  assert.throws(
    () => api.digest.canonicalPackage(cyclic),
    /cycle|circular|serializ/i,
  );
});

test('[S3-AC-002][C-U-09b] canonical JSON rejects ill-formed Unicode in object keys', async () => {
  const api = await loadCurriculumModules();
  const illFormedKey = {};
  Object.defineProperty(illFormedKey, '\uD800', {
    value: 1,
    enumerable: true,
  });
  assert.throws(() => api.digest.canonicalPackage(illFormedKey));
});

test('[S3-AC-002][C-U-09c] canonical JSON rejects array subclasses as non-plain objects', async () => {
  const api = await loadCurriculumModules();
  class ArraySubclass extends Array {}
  const arraySubclass = new ArraySubclass(1, 2);
  assert.throws(() => api.digest.canonicalPackage(arraySubclass));
});

test('[S3-AC-003][C-U-10] validator preflight never invokes proxy getters or throws', async () => {
  const api = await loadCurriculumModules();
  let getterCalls = 0;
  const proxied = new Proxy(clonePackage(), {
    get() {
      getterCalls += 1;
      throw new Error('unexpected getter');
    },
  });

  let result;
  assert.doesNotThrow(() => {
    result = api.validator.validateCurriculumPackage(proxied);
  });
  assert.equal(getterCalls, 0);
  assert.ok(result && typeof result === 'object');
  if (!result.ok) {
    assert.ok(
      result.errors.some((error) => error.code === 'UNSAFE_JSON_VALUE'),
    );
  }
});

test('[S3-AC-003][C-U-11] validator errors sort by path before code even with NUL keys', async () => {
  const api = await loadCurriculumModules();
  const value = clonePackage();
  value.a = 1;
  value['a\u0000A'] = 2;
  const result = api.validator.validateCurriculumPackage(value);
  assert.equal(result.ok, false);
  const unknown = result.errors.filter((error) => error.code === 'UNKNOWN_KEY');
  assert.deepEqual(unknown, [
    { path: 'a', code: 'UNKNOWN_KEY' },
    { path: 'a\u0000A', code: 'UNKNOWN_KEY' },
  ]);
  const sorted = [...result.errors].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    return 0;
  });
  assert.deepEqual(result.errors, sorted);
});

test('[S3-AC-003][C-U-12] missing or unusable delayed-review coverage reports its relationship error', async () => {
  const api = await loadCurriculumModules();
  const delayedPath = /^characters\[0\]\.teaching\.delayedReview$/;

  const missing = clonePackage();
  delete missing.characters[0].teaching.delayedReview;
  const missingResult = api.validator.validateCurriculumPackage(missing);
  assertError(missingResult, delayedPath, 'DELAYED_REVIEW_MISSING');
  assertError(missingResult, delayedPath, 'MISSING_KEY');

  const nullValue = clonePackage();
  nullValue.characters[0].teaching.delayedReview = null;
  const nullResult = api.validator.validateCurriculumPackage(nullValue);
  assertError(nullResult, delayedPath, 'DELAYED_REVIEW_MISSING');
  assertError(nullResult, delayedPath, 'WRONG_TYPE');

  const missingCheck = clonePackage();
  delete missingCheck.characters[0].teaching.delayedReview.recognitionCheckId;
  const missingCheckResult =
    api.validator.validateCurriculumPackage(missingCheck);
  assertError(missingCheckResult, delayedPath, 'DELAYED_REVIEW_MISSING');
  assertError(
    missingCheckResult,
    /^characters\[0\]\.teaching\.delayedReview\.recognitionCheckId$/,
    'MISSING_KEY',
  );

  const unknownCheck = clonePackage();
  unknownCheck.characters[0].teaching.delayedReview.recognitionCheckId =
    'check-does-not-exist';
  const unknownCheckResult =
    api.validator.validateCurriculumPackage(unknownCheck);
  assertError(unknownCheckResult, delayedPath, 'DELAYED_REVIEW_MISSING');
  assertError(
    unknownCheckResult,
    /^characters\[0\]\.teaching\.delayedReview\.recognitionCheckId$/,
    'REFERENCE_UNKNOWN',
  );

  const wrongCharacter = clonePackage();
  wrongCharacter.characters[0].teaching.delayedReview.recognitionCheckId =
    'check-lin-word';
  const wrongCharacterResult =
    api.validator.validateCurriculumPackage(wrongCharacter);
  assertError(wrongCharacterResult, delayedPath, 'DELAYED_REVIEW_MISSING');
  assertError(
    wrongCharacterResult,
    /^characters\[0\]\.teaching\.delayedReview\.recognitionCheckId$/,
    'CHARACTER_MISMATCH',
  );
});
