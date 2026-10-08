import type { ForestLessonDefinition, ForestQuestion, PreviewStep, LessonVersion } from './types.ts';

/**
 * The reviewed lesson manifest is deliberately versioned. The answer keys live
 * in this server-owned module; a browser may use publicLessonMetadata instead.
 */
export const FOREST_LESSON: ForestLessonDefinition = {
  lessonId: 'forest-01',
  lessonVersion: 'forest-01-v1',
  title: 'Build a Little Forest',
  tutor: {
    kind: 'scripted',
    description: 'A reviewed scripted tutor responds to answers, hints, and repeated difficulty.',
  },
  characters: [
    { id: 'mu', hanzi: '木', pinyin: 'mù', raw: 'mu', meaning: 'wood; tree', word: '木头' },
    { id: 'lin', hanzi: '林', pinyin: 'lín', raw: 'lin', meaning: 'woods; grove', word: '树林' },
    { id: 'ren', hanzi: '人', pinyin: 'rén', raw: 'ren', meaning: 'person', word: '人' },
    { id: 'da', hanzi: '大', pinyin: 'dà', raw: 'da', meaning: 'big', word: '大' },
  ],
  examples: [
    { text: '木头', meaning: 'wood', audioText: '木头' },
    { text: '树林', meaning: 'woods', audioText: '树林' },
  ],
  steps: ['welcome', 'familiarity', 'learn', 'build', 'find', 'read', 'check', 'recap', 'delayed-review'],
  questions: [
    soundQuestion('fam-mu', 0, 'familiarity', 'mu', '木头的木', ['mu', 'lin', 'ren'], 'mu'),
    soundQuestion('fam-lin', 1, 'familiarity', 'lin', '树林的林', ['lin', 'mu', 'da'], 'lin'),
    sceneQuestion('find-mu', 2, 'mu', '找一找木', 'mu'),
    sceneQuestion('find-lin', 3, 'lin', '找一找林', 'lin'),
    soundQuestion('check-mu-sound', 4, 'check', 'mu', '木头的木', ['mu', 'lin', 'ren'], 'mu'),
    soundQuestion('check-lin-sound', 5, 'check', 'lin', '树林的林', ['lin', 'mu', 'da'], 'lin'),
    readingQuestion('check-mu-reading', 6, 'mu', '听一听这个字怎么读', ['audio-mu', 'audio-lin', 'audio-ren'], 'audio-mu'),
    readingQuestion('check-lin-reading', 7, 'lin', '听一听这个字怎么读', ['audio-lin', 'audio-mu', 'audio-da'], 'audio-lin'),
    soundQuestion('review-mu-sound', 8, 'delayed-review', 'mu', '木头的木', ['mu', 'lin', 'ren'], 'mu'),
    soundQuestion('review-lin-sound', 9, 'delayed-review', 'lin', '树林的林', ['lin', 'mu', 'da'], 'lin'),
  ],
  assets: [
    { id: 'glyph-mu', kind: 'glyph', source: 'Unicode CJK Unified Ideograph U+6728; rendered through the selected system font', license: 'Unicode data and platform font licensing', sourceChecked: true, reviewStatus: 'pending-owner' },
    { id: 'glyph-lin', kind: 'glyph', source: 'Unicode CJK Unified Ideograph U+6797; rendered through the selected system font', license: 'Unicode data and platform font licensing', sourceChecked: true, reviewStatus: 'pending-owner' },
    { id: 'forest-meaning-illustration', kind: 'illustration', source: 'Little Hanzi original preview illustration', license: 'Project-owned original asset; content review pending owner', sourceChecked: true, reviewStatus: 'pending-owner' },
    { id: 'mandarin-device-speech', kind: 'audio', source: 'Device Mandarin speech synthesis for local preview', license: 'Platform-provided voice; no recording stored; pronunciation review pending owner', sourceChecked: true, reviewStatus: 'pending-owner' },
    { id: 'system-cjk-font', kind: 'font', source: 'System CJK font fallback', license: 'Platform font licensing', sourceChecked: true, reviewStatus: 'pending-owner' },
  ],
  captions: [
    { id: 'read-wood', text: '这是木头。', highlight: 'mu', narration: 'This is wood. An adult or narrator helps read the sentence.' },
    { id: 'read-grove', text: '小鸟住在树林里。', highlight: 'lin', narration: 'A little bird lives in the woods. An adult or narrator helps read the sentence.' },
  ],
  componentLayout: {
    glyph: '林',
    left: '木',
    right: '木',
    proportions: 'two ordinary 木 components with balanced left and right spacing',
  },
};

function soundQuestion(
  id: string,
  ordinal: number,
  stepId: PreviewStep,
  characterId: 'mu' | 'lin',
  prompt: string,
  choiceIds: string[],
  correctChoiceId: string,
): ForestQuestion {
  return {
    id,
    ordinal,
    stepId,
    characterId,
    prompt,
    cueText: characterId === 'mu' ? '木头' : '树林',
    kind: 'sound-to-print',
    choices: choiceIds.map((id) => ({ id, label: characterLabel(id) })),
    correctChoiceId,
    soundDependent: true,
    hint: characterId === 'mu' ? 'Listen for the word 木头 and look for the tree character.' : 'Listen for the word 树林 and look for the two-tree character.',
    demonstration: characterId === 'mu' ? '木 means wood or tree.' : '林 shows two 木 trees together.',
  };
}

function readingQuestion(
  id: string,
  ordinal: number,
  characterId: 'mu' | 'lin',
  prompt: string,
  choiceIds: string[],
  correctChoiceId: string,
): ForestQuestion {
  return {
    id,
    ordinal,
    stepId: 'check',
    characterId,
    prompt,
    cueText: characterId === 'mu' ? '木' : '林',
    kind: 'print-to-audio',
    choices: choiceIds.map((id, index) => ({ id, label: `Listen to option ${index + 1}`, audioText: characterLabel(id.replace('audio-', '')) })),
    correctChoiceId,
    soundDependent: true,
    hint: characterId === 'mu' ? 'Listen again for the reading used with 木头.' : 'Listen again for the reading used with 树林.',
    demonstration: characterId === 'mu' ? 'Listen to the reading for 木, then choose the matching sound.' : 'Listen to the reading for 林, then choose the matching sound.',
  };
}

function sceneQuestion(
  id: string,
  ordinal: number,
  characterId: 'mu' | 'lin',
  prompt: string,
  correctChoiceId: string,
): ForestQuestion {
  return {
    id,
    ordinal,
    stepId: 'find',
    characterId,
    prompt,
    cueText: characterId === 'mu' ? '木' : '林',
    kind: 'scene',
    choices: ['mu', 'lin', 'ren', 'da'].map((id) => ({ id, label: characterLabel(id) })),
    correctChoiceId,
    soundDependent: false,
    hint: characterId === 'mu' ? 'Look for the single 木 tree.' : 'Look for the character made from two 木 trees.',
    demonstration: characterId === 'mu' ? 'This ordinary character is 木.' : 'These two 木 components make 林.',
  };
}

function characterLabel(id: string): string {
  return ({ mu: '木', lin: '林', ren: '人', da: '大' } as Record<string, string>)[id] ?? id;
}

const QUESTION_IDS = [
  'fam-mu', 'fam-lin', 'find-mu', 'find-lin', 'check-mu-sound', 'check-lin-sound',
  'check-mu-reading', 'check-lin-reading', 'review-mu-sound', 'review-lin-sound',
];

export function question(id: string, version: LessonVersion = 'forest-01-v1'): ForestQuestion | undefined {
  return lessonForVersion(version).questions.find((item) => item.id === id);
}

export function rotatedChoices(questionId: string, seed: number, version: LessonVersion = 'forest-01-v1'): string[] {
  const item = question(questionId, version);
  if (!item) return [];
  const count = item.choices.length;
  const shift = (Math.abs(seed >>> 0) + item.ordinal) % count;
  const ids = item.choices.map((choice) => choice.id);
  return ids.slice(shift).concat(ids.slice(0, shift));
}

export function validateForestLesson(value: unknown): { ok: true } | { ok: false; errors: string[] } {
  const lesson = value as ForestLessonDefinition | null;
  const errors: string[] = [];
  if (!lesson || lesson.lessonId !== 'forest-01') errors.push('lessonId must be forest-01');
  if (!lesson || !isLessonVersion(lesson.lessonVersion)) errors.push('lessonVersion must be forest-01-v1 or forest-01-v3');
  if (!lesson || lesson.tutor?.kind !== 'scripted') errors.push('tutor must be scripted');
  if (!lesson || lesson.characters?.filter((character) => character.id === 'mu' || character.id === 'lin').length !== 2) errors.push('exactly 木 and 林 are teaching targets');
  if (!lesson || lesson.examples?.some((example) => !['木头', '树林'].includes(example.text)) !== false) errors.push('reviewed examples are required');
  if (!lesson || lesson.componentLayout?.glyph !== '林' || lesson.componentLayout?.left !== '木' || lesson.componentLayout?.right !== '木') errors.push('林 component layout is incomplete');
  if (!lesson || lesson.captions?.length !== 2 || !lesson.captions.every((caption) => caption.text.includes(caption.highlight === 'mu' ? '木' : '林'))) errors.push('captioned untaught reading is incomplete');
  if (!lesson || !Array.isArray(lesson.assets) || lesson.assets.length === 0 || lesson.assets.some((asset) => !asset.source || !asset.license || !asset.sourceChecked || !['pending-owner', 'mechanically-checked', 'approved'].includes(asset.reviewStatus))) errors.push('asset source/license references are required');
  if (!lesson || !Array.isArray(lesson.questions) || lesson.questions.length !== QUESTION_IDS.length) errors.push('all stable question IDs are required');
  if (lesson?.questions) {
    for (const id of QUESTION_IDS) {
      const item = lesson.questions.find((questionItem) => questionItem.id === id);
      if (!item || !item.correctChoiceId || !item.choices.some((choice) => choice.id === item.correctChoiceId)) errors.push(`question ${id} has no reviewed answer`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export const PUBLIC_FOREST_LESSON = {
  ...FOREST_LESSON,
  questions: FOREST_LESSON.questions.map(({ correctChoiceId: _correctChoiceId, ...item }) => item),
};

if (!validateForestLesson(FOREST_LESSON).ok) {
  throw new Error('forest-01 lesson manifest is invalid');
}

/** V3 changes presentation only; the frozen S1 question oracle remains exact. */
export const FOREST_STORY_LESSON: ForestLessonDefinition = {
  ...structuredClone(FOREST_LESSON),
  lessonVersion: 'forest-01-v3',
  title: 'A shady place to read',
  tutor: {
    kind: 'scripted',
    description:
      'A versioned story preview; Mandarin and animation review remain pending.',
  },
};
export const PUBLIC_FOREST_STORY_LESSON = {
  ...FOREST_STORY_LESSON,
  questions: FOREST_STORY_LESSON.questions.map(
    ({ correctChoiceId: _correctChoiceId, ...item }) => item,
  ),
};
export function isLessonVersion(value: unknown): value is LessonVersion {
  return value === 'forest-01-v1' || value === 'forest-01-v3';
}
export function lessonForVersion(version: string): ForestLessonDefinition {
  if (version === 'forest-01-v1') return FOREST_LESSON;
  if (version === 'forest-01-v3') return FOREST_STORY_LESSON;
  throw new Error('unsupported forest lesson version');
}
