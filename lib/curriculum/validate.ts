import { validateCorpusSection } from './corpus-profile.ts';
import { validatePairedSection } from './paired-profile.ts';
import { validateStorySection } from './story-package.ts';
import { fieldPath, inspectJson, orderIssues, type JsonIssue } from './json.ts';

type Rule =
  | {
      kind: 'text';
      max: number;
      slug?: boolean;
      han?: boolean;
      nfc?: boolean;
      choice?: boolean;
    }
  | { kind: 'object'; fields: Record<string, Rule>; incompleteCode?: string }
  | { kind: 'array'; item: Rule; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'boolean' | 'sequence' | 'capabilities' };

const text = (max = 240): Rule => ({ kind: 'text', max });
const slug = (max = 64): Rule => ({ kind: 'text', max, slug: true });
const han = (choice = false): Rule => ({
  kind: 'text',
  max: 1,
  han: true,
  nfc: true,
  choice,
});
const hanText = (max = 120): Rule => ({ kind: 'text', max, nfc: true });
const object = (
  fields: Record<string, Rule>,
  incompleteCode?: string,
): Rule => ({
  kind: 'object',
  fields,
  incompleteCode,
});
const array = (item: Rule, min: number, max: number): Rule => ({
  kind: 'array',
  item,
  min,
  max,
});
const enumeration = (...values: string[]): Rule => ({ kind: 'enum', values });
const capabilities = [
  'selection-v1',
  'recognition-v1',
  'delayed-review-v1',
  'progress-export-v1',
];
const provenance = object(
  {
    source: text(),
    license: text(),
    evidenceRef: text(),
    sourceChecked: { kind: 'boolean' },
  },
  'PROVENANCE_INCOMPLETE',
);
const schema = object({
  lessonId: slug(),
  lessonVersion: slug(80),
  title: text(120),
  canonicalizationVersion: enumeration('s3-json-1'),
  placement: object({ trackId: slug(), sequence: { kind: 'sequence' } }),
  renderer: object({
    adapterId: slug(),
    adapterVersion: slug(80),
    capabilities: { kind: 'capabilities' },
  }),
  instructionsEnglish: object({
    welcome: text(),
    objective: text(),
    completion: text(),
    recovery: text(),
  }),
  characters: array(
    object({
      characterId: slug(),
      hanzi: han(),
      readings: array(
        object({
          readingId: slug(),
          pinyin: text(),
          audioText: hanText(),
          provenance,
        }),
        1,
        16,
      ),
      meanings: array(object({ english: text(), provenance }), 1, 32),
      wordAssociations: array(
        object({
          wordId: slug(),
          text: hanText(32),
          pinyin: text(),
          english: text(),
          readingId: slug(),
          context: object({
            hanzi: hanText(),
            english: text(),
            targetCharacter: han(),
          }),
          provenance,
        }),
        2,
        32,
      ),
      teaching: object({
        instructionEnglish: text(),
        hintEnglish: text(),
        demonstrationEnglish: text(),
        recognitionCheckId: slug(),
        delayedReview: object(
          {
            promptId: slug(),
            instructionEnglish: text(),
            cueEnglish: text(),
            recognitionCheckId: slug(),
          },
          'DELAYED_REVIEW_MISSING',
        ),
      }),
      assets: array(slug(), 0, 1024),
    }),
    1,
    256,
  ),
  steps: array(
    object({
      stepId: slug(),
      instructionEnglish: text(),
      kind: enumeration(
        'familiarity',
        'teach',
        'practice',
        'plain-print-check',
        'recap',
      ),
      recognitionCheckIds: array(slug(), 0, 1024),
    }),
    1,
    64,
  ),
  recognitionChecks: array(
    object({
      checkId: slug(),
      characterId: slug(),
      kind: enumeration('plain-print', 'word-context'),
      instructionEnglish: text(),
      prompt: object({ english: text(), hanzi: hanText() }),
      choices: array(object({ choiceId: slug(), hanzi: han(true) }), 2, 4),
      correctChoiceId: slug(),
    }),
    1,
    1024,
  ),
  assets: array(
    object({
      assetId: slug(),
      kind: enumeration('glyph', 'font', 'audio', 'illustration'),
      source: text(),
      license: text(),
      evidenceRef: text(),
      sourceChecked: { kind: 'boolean' },
      sourceCheckStatus: enumeration('pending-owner', 'mechanically-checked'),
    }),
    0,
    1024,
  ),
});

interface Character {
  characterId: string;
  hanzi: string;
  readings: Array<{ readingId: string; audioText: string }>;
  wordAssociations: Array<{
    wordId: string;
    text: string;
    readingId: string;
    context: { hanzi: string; targetCharacter: string };
  }>;
  teaching: {
    recognitionCheckId: string;
    delayedReview: { promptId: string; recognitionCheckId: string };
  };
  assets: string[];
}
interface Check {
  checkId: string;
  characterId: string;
  kind: string;
  choices: Array<{ choiceId: string; hanzi: string }>;
  correctChoiceId: string;
}
interface Package {
  lessonId: string;
  lessonVersion: string;
  characters: Character[];
  recognitionChecks: Check[];
  steps: Array<{ stepId: string; kind: string; recognitionCheckIds: string[] }>;
  assets: Array<{ assetId: string }>;
}

export function validateCurriculumPackage(input: unknown): {
  ok: boolean;
  errors: JsonIssue[];
} {
  // Dispatch only on inspected copies; caller proxies/accessors must never run.
  const inspected = inspectJson(input);
  if (inspected.errors.length) return { ok: false, errors: inspected.errors };
  input = inspected.value;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const candidate = input as Record<string, unknown>;
    const renderer = candidate.renderer as Record<string, unknown> | undefined;
    if (renderer?.adapterId === 'corpus-paired') {
      const { pairedStory: _pairedStory, ...envelope } = candidate;
      const result = validateGenericCurriculumPackage(envelope);
      if (!result.ok) return result;
      if (validateCorpusSection(candidate)) return { ok: true, errors: [] };
      return {
        ok: false,
        errors: [{ path: 'pairedStory', code: 'CORPUS_PROFILE_INVALID' }],
      };
    }
    if (
      renderer?.adapterId === 'paired-story' ||
      Object.hasOwn(candidate, 'pairedStory')
    ) {
      const { pairedStory: _pairedStory, ...envelope } = candidate;
      const result = validateGenericCurriculumPackage(envelope);
      if (!result.ok) return result;
      if (validatePairedSection(candidate)) return { ok: true, errors: [] };
      return {
        ok: false,
        errors: [{ path: 'pairedStory', code: 'PAIRED_PROFILE_INVALID' }],
      };
    }
    if (
      renderer?.adapterId === 'forest-story' ||
      candidate.lessonVersion === 'forest-01-v4'
    ) {
      const { story: _story, ...envelope } = candidate;
      const result = validateGenericCurriculumPackage(envelope);
      if (!result.ok) return result;
      try {
        if (validateStorySection(candidate)) return { ok: true, errors: [] };
      } catch {}
      return {
        ok: false,
        errors: [{ path: 'story', code: 'STORY_PROFILE_INVALID' }],
      };
    }
  }
  return validateGenericCurriculumPackage(input);
}

function validateGenericCurriculumPackage(input: unknown): {
  ok: boolean;
  errors: JsonIssue[];
} {
  const inspected = inspectJson(input);
  const errors = inspected.errors;
  input = inspected.value;
  const add = (path: string, code: string) =>
    errors.push({ path: path || '$', code });
  const finish = () => ({
    ok: errors.length === 0,
    errors: orderIssues(errors),
  });
  if (errors.length) return finish();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add('', 'INPUT_NOT_OBJECT');
    return finish();
  }
  function validate(value: unknown, rule: Rule, path: string) {
    switch (rule.kind) {
      case 'object': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          add(path, 'WRONG_TYPE');
          if (rule.incompleteCode) add(path, rule.incompleteCode);
          return;
        }
        const record = value as Record<string, unknown>;
        const start = errors.length;
        for (const key of Object.keys(record).sort()) {
          if (!Object.hasOwn(rule.fields, key))
            add(fieldPath(path, key), 'UNKNOWN_KEY');
        }
        for (const [key, child] of Object.entries(rule.fields)) {
          if (!Object.hasOwn(record, key)) {
            add(fieldPath(path, key), 'MISSING_KEY');
            if (child.kind === 'object' && child.incompleteCode)
              add(fieldPath(path, key), child.incompleteCode);
          } else validate(record[key], child, fieldPath(path, key));
        }
        if (rule.incompleteCode && errors.length > start)
          add(path, rule.incompleteCode);
        return;
      }
      case 'array':
        if (!Array.isArray(value)) {
          add(path, 'WRONG_TYPE');
          return;
        }
        if (value.length < rule.min) add(path, 'ARRAY_TOO_SHORT');
        if (value.length > rule.max) {
          add(path, 'ARRAY_TOO_LONG');
          return;
        }
        value.forEach((item, index) =>
          validate(item, rule.item, `${path}[${index}]`),
        );
        return;
      case 'boolean':
        if (typeof value !== 'boolean') add(path, 'WRONG_TYPE');
        return;
      case 'sequence':
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0 ||
          value > 1_000_000
        )
          add(path, 'SEQUENCE_INVALID');
        return;
      case 'enum':
        if (typeof value !== 'string' || !rule.values.includes(value))
          add(path, 'WRONG_TYPE');
        return;
      case 'capabilities':
        if (
          !Array.isArray(value) ||
          value.length !== capabilities.length ||
          value.some((entry, i) => entry !== capabilities[i])
        )
          add(path, 'CAPABILITY_SET_INVALID');
        return;
      case 'text':
        if (typeof value !== 'string') {
          add(path, 'WRONG_TYPE');
          return;
        }
        if (!value.trim())
          add(path, rule.choice ? 'CHOICE_EMPTY' : 'EMPTY_STRING');
        if (value !== value.trim()) add(path, 'NOT_TRIMMED');
        // The package contract counts Unicode code points, not displayed graphemes.
        if (Array.from(value).length > rule.max && !rule.han)
          add(path, 'STRING_TOO_LONG');
        if (
          rule.slug &&
          (!/^[a-z0-9][a-z0-9._-]*$/.test(value) || value.length > rule.max)
        )
          add(path, 'ID_FORMAT');
        if (rule.nfc && value !== value.normalize('NFC'))
          add(path, 'HANZI_NOT_NFC');
        if (rule.han && !/^\p{Script=Han}$/u.test(value))
          add(path, 'HANZI_NOT_SINGLE_HAN');
    }
  }
  validate(input, schema, '');
  if (errors.length) return finish();

  const pkg = input as Package;
  const identities = new Set<string>();
  function declare(id: string, path: string) {
    if (identities.has(id)) add(path, 'DUPLICATE_ID');
    identities.add(id);
  }
  declare(pkg.lessonId, 'lessonId');
  declare(pkg.lessonVersion, 'lessonVersion');
  const characters = new Map(
    pkg.characters.map((character) => [character.characterId, character]),
  );
  const checks = new Map(
    pkg.recognitionChecks.map((check) => [check.checkId, check]),
  );
  const assets = new Set(pkg.assets.map((asset) => asset.assetId));
  const usedChecks = new Set<string>();
  const plainPrintChecks = new Set<string>();
  const glyphs = new Set<string>();
  function checkReference(
    id: string,
    path: string,
    characterId?: string,
    requirePlain = false,
  ) {
    const check = checks.get(id);
    if (!check) {
      add(path, 'REFERENCE_UNKNOWN');
      return false;
    }
    usedChecks.add(id);
    let valid = true;
    if (characterId && check.characterId !== characterId) {
      add(path, 'CHARACTER_MISMATCH');
      valid = false;
    }
    if (requirePlain && check.kind !== 'plain-print') {
      add(path, 'PLAIN_PRINT_CHECK_MISSING');
      valid = false;
    }
    return valid;
  }
  pkg.assets.forEach((asset, index) =>
    declare(asset.assetId, `assets[${index}].assetId`),
  );
  pkg.steps.forEach((step, index) => {
    const path = `steps[${index}]`;
    declare(step.stepId, `${path}.stepId`);
    const references = new Set<string>();
    step.recognitionCheckIds.forEach((id, i) => {
      const refPath = `${path}.recognitionCheckIds[${i}]`;
      if (references.has(id)) add(refPath, 'DUPLICATE_ID');
      references.add(id);
      checkReference(id, refPath);
      if (
        step.kind === 'plain-print-check' &&
        checks.get(id)?.kind === 'plain-print'
      )
        plainPrintChecks.add(id);
    });
    if (
      step.kind === 'plain-print-check' &&
      !step.recognitionCheckIds.some(
        (id) => checks.get(id)?.kind === 'plain-print',
      )
    )
      add(`${path}.recognitionCheckIds`, 'PLAIN_PRINT_CHECK_MISSING');
  });
  if (!plainPrintChecks.size) add('steps', 'PLAIN_PRINT_CHECK_MISSING');
  pkg.characters.forEach((character, index) => {
    const path = `characters[${index}]`;
    declare(character.characterId, `${path}.characterId`);
    if (glyphs.has(character.hanzi)) add(`${path}.hanzi`, 'DUPLICATE_ID');
    glyphs.add(character.hanzi);
    const readings = new Set(
      character.readings.map((reading) => reading.readingId),
    );
    character.readings.forEach((reading, i) => {
      declare(reading.readingId, `${path}.readings[${i}].readingId`);
      if (
        !reading.audioText.includes(character.hanzi) ||
        assets.has(reading.audioText)
      )
        add(`${path}.readings[${i}].audioText`, 'AUDIO_TEXT_INVALID');
    });
    const words = new Set<string>();
    character.wordAssociations.forEach((word, i) => {
      const wordPath = `${path}.wordAssociations[${i}]`;
      declare(word.wordId, `${wordPath}.wordId`);
      if (words.has(word.text)) add(`${wordPath}.text`, 'DUPLICATE_ID');
      words.add(word.text);
      if (!readings.has(word.readingId))
        add(`${wordPath}.readingId`, 'REFERENCE_UNKNOWN');
      if (!word.text.includes(character.hanzi))
        add(`${wordPath}.text`, 'WORD_MISSING_CHARACTER');
      if (!word.context.hanzi.includes(word.text))
        add(`${wordPath}.context.hanzi`, 'CONTEXT_MISSING_WORD');
      if (word.context.targetCharacter !== character.hanzi)
        add(`${wordPath}.context.targetCharacter`, 'CHARACTER_MISMATCH');
    });
    const teachingPath = `${path}.teaching.recognitionCheckId`;
    checkReference(
      character.teaching.recognitionCheckId,
      teachingPath,
      character.characterId,
      true,
    );
    if (!plainPrintChecks.has(character.teaching.recognitionCheckId))
      add(teachingPath, 'PLAIN_PRINT_CHECK_MISSING');
    declare(
      character.teaching.delayedReview.promptId,
      `${path}.teaching.delayedReview.promptId`,
    );
    const delayedValid = checkReference(
      character.teaching.delayedReview.recognitionCheckId,
      `${path}.teaching.delayedReview.recognitionCheckId`,
      character.characterId,
    );
    if (!delayedValid)
      add(`${path}.teaching.delayedReview`, 'DELAYED_REVIEW_MISSING');
    const seenAssets = new Set<string>();
    character.assets.forEach((asset, i) => {
      if (!assets.has(asset)) add(`${path}.assets[${i}]`, 'REFERENCE_UNKNOWN');
      if (seenAssets.has(asset)) add(`${path}.assets[${i}]`, 'DUPLICATE_ID');
      seenAssets.add(asset);
    });
  });
  pkg.recognitionChecks.forEach((check, index) => {
    const path = `recognitionChecks[${index}]`;
    declare(check.checkId, `${path}.checkId`);
    const target = characters.get(check.characterId);
    if (!target) add(`${path}.characterId`, 'REFERENCE_UNKNOWN');
    if (!usedChecks.has(check.checkId))
      add(`${path}.checkId`, 'CHECK_ORPHANED');
    const choiceIds = new Set<string>();
    const choiceGlyphs = new Set<string>();
    check.choices.forEach((choice, i) => {
      if (choiceIds.has(choice.choiceId))
        add(`${path}.choices[${i}].choiceId`, 'CHOICE_DUPLICATE');
      if (choiceGlyphs.has(choice.hanzi))
        add(`${path}.choices[${i}].hanzi`, 'CHOICE_DUPLICATE');
      choiceIds.add(choice.choiceId);
      choiceGlyphs.add(choice.hanzi);
    });
    const correct = check.choices.filter(
      (choice) => choice.choiceId === check.correctChoiceId,
    );
    if (correct.length !== 1)
      add(`${path}.correctChoiceId`, 'CORRECT_CHOICE_MISSING');
    else if (target && correct[0].hanzi !== target.hanzi)
      add(`${path}.correctChoiceId`, 'CHARACTER_MISMATCH');
  });
  return finish();
}
