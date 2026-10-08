/** Browser display boundary only. Server package validation owns teaching semantics. */
type Document = Record<string, unknown>;
const object = (value: unknown): value is Document =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const list = (
  value: unknown,
  min: number,
  max: number,
  check: (item: unknown) => boolean,
): boolean =>
  Array.isArray(value) &&
  value.length >= min &&
  value.length <= max &&
  value.every(check);
const texts = (value: unknown, min = 0, max = 1024): boolean =>
  list(value, min, max, text);
const fields = (value: unknown, names: string[]): value is Document =>
  object(value) && names.every((name) => text(value[name]));
const provenance = (value: unknown): boolean =>
  fields(value, ['source', 'license', 'evidenceRef']) &&
  typeof value.sourceChecked === 'boolean';

/** Copy descriptor values without invoking accessors; reject non-JSON and excessive inputs. */
function copyJson(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  let size = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 50_000 || depth > 32) throw new Error('limit');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      size += item.length;
      if (!item.isWellFormed() || item.length > 16_384 || size > 1_048_576)
        throw new Error('limit');
      return item;
    }
    if (typeof item !== 'object' || item === null || seen.has(item))
      throw new Error('json');
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (
      proto !== (array ? Array.prototype : Object.prototype) &&
      !(proto === null && !array)
    )
      throw new Error('prototype');
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    const length = array
      ? Object.getOwnPropertyDescriptor(item, 'length')
      : null;
    if (
      array &&
      (!length ||
        !Object.hasOwn(length, 'value') ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > 50_000)
    )
      throw new Error('length');
    const result: unknown[] | Document = array ? [] : {};
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        throw new Error('key');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      )
        throw new Error('descriptor');
      size += key.length;
      if (size > 1_048_576 || (array && key !== String(count)))
        throw new Error('limit');
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      count++;
    }
    if (array && count !== length?.value) throw new Error('sparse');
    seen.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1_048_576)
    throw new Error('limit');
  return result;
}
function displayShape(value: unknown): value is Document {
  if (
    !fields(value, [
      'lessonId',
      'lessonVersion',
      'title',
      'canonicalizationVersion',
    ])
  )
    return false;
  if (
    !object(value.placement) ||
    !text(value.placement.trackId) ||
    !Number.isSafeInteger(value.placement.sequence)
  )
    return false;
  if (
    !fields(value.renderer, ['adapterId', 'adapterVersion']) ||
    !texts(value.renderer.capabilities, 1, 64)
  )
    return false;
  if (
    !fields(value.instructionsEnglish, [
      'welcome',
      'objective',
      'completion',
      'recovery',
    ])
  )
    return false;
  if (
    !list(value.characters, 1, 256, (character) => {
      if (!fields(character, ['characterId', 'hanzi'])) return false;
      if (
        !list(
          character.readings,
          1,
          16,
          (reading) =>
            fields(reading, ['readingId', 'pinyin', 'audioText']) &&
            provenance(reading.provenance),
        )
      )
        return false;
      if (
        !list(
          character.meanings,
          1,
          32,
          (meaning) =>
            fields(meaning, ['english']) && provenance(meaning.provenance),
        )
      )
        return false;
      if (
        !list(
          character.wordAssociations,
          2,
          32,
          (word) =>
            fields(word, [
              'wordId',
              'text',
              'pinyin',
              'english',
              'readingId',
            ]) &&
            fields(word.context, ['hanzi', 'english', 'targetCharacter']) &&
            provenance(word.provenance),
        )
      )
        return false;
      return (
        fields(character.teaching, [
          'instructionEnglish',
          'hintEnglish',
          'demonstrationEnglish',
          'recognitionCheckId',
        ]) &&
        fields(character.teaching.delayedReview, [
          'promptId',
          'instructionEnglish',
          'cueEnglish',
          'recognitionCheckId',
        ]) &&
        texts(character.assets)
      );
    })
  )
    return false;
  if (
    !list(
      value.steps,
      1,
      64,
      (step) =>
        fields(step, ['stepId', 'instructionEnglish', 'kind']) &&
        texts(step.recognitionCheckIds),
    )
  )
    return false;
  if (
    !list(
      value.recognitionChecks,
      1,
      1024,
      (check) =>
        fields(check, [
          'checkId',
          'characterId',
          'kind',
          'instructionEnglish',
        ]) &&
        fields(check.prompt, ['english', 'hanzi']) &&
        list(check.choices, 2, 4, (choice) =>
          fields(choice, ['choiceId', 'hanzi']),
        ),
    )
  )
    return false;
  if (
    !list(
      value.assets,
      0,
      1024,
      (asset) =>
        fields(asset, [
          'assetId',
          'kind',
          'source',
          'license',
          'evidenceRef',
          'sourceCheckStatus',
        ]) && typeof asset.sourceChecked === 'boolean',
    )
  )
    return false;
  // Optional authenticated story material is opaque, bounded JSON, never graded here.
  return value.story === undefined || object(value.story);
}
export function parseCurriculumDisplayDocument(
  value: unknown,
): Document | null {
  try {
    const copied = copyJson(value);
    return displayShape(copied) ? copied : null;
  } catch {
    return null;
  }
}
