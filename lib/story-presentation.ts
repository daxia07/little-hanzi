/** Browser-safe display metadata derived from the frozen S1/R2 specification.
 * This module has no correct choice, scoring function or server content import.
 */
export const STORY_ASSET_ROOT = '/story/forest-01-v3';
export const STORY_LABELS: Readonly<Record<string, string>> = {
  mu: '木',
  lin: '林',
  ren: '人',
  da: '大',
};
export const STORY_WORDS = {
  mu: { word: '木头', meaning: 'wood / a piece of wood' },
  lin: { word: '树林', meaning: 'a grove / woods' },
};
export const STORY_READERS = {
  'read-wood': { text: '这是木头。', meaning: 'This is wood.', target: '木' },
  'read-grove': {
    text: '小鸟住在树林里。',
    meaning: 'A little bird lives in the woods.',
    target: '林',
  },
};
export interface StoryQuestionDisplay {
  id: string;
  ordinal: number;
  kind: 'sound-to-print' | 'print-to-audio' | 'scene';
  target: 'mu' | 'lin';
  choices: readonly string[];
  cue: string;
  hint: string;
  demonstration: string;
}
const identities = [
  ['fam-mu', 'mu', ['mu', 'lin', 'ren']],
  ['fam-lin', 'lin', ['lin', 'mu', 'da']],
  ['find-mu', 'mu', ['mu', 'lin', 'ren', 'da']],
  ['find-lin', 'lin', ['mu', 'lin', 'ren', 'da']],
  ['check-mu-sound', 'mu', ['mu', 'lin', 'ren']],
  ['check-lin-sound', 'lin', ['lin', 'mu', 'da']],
  ['check-mu-reading', 'mu', ['audio-mu', 'audio-lin', 'audio-ren']],
  ['check-lin-reading', 'lin', ['audio-lin', 'audio-mu', 'audio-da']],
  ['review-mu-sound', 'mu', ['mu', 'lin', 'ren']],
  ['review-lin-sound', 'lin', ['lin', 'mu', 'da']],
] as const;
const QUESTIONS: StoryQuestionDisplay[] = identities.map(
  ([id, target, choices], ordinal) => {
    const reading = id.includes('reading'),
      scene = id.startsWith('find-');
    return {
      id,
      ordinal,
      target,
      choices,
      kind: reading ? 'print-to-audio' : scene ? 'scene' : 'sound-to-print',
      cue:
        reading || scene
          ? STORY_LABELS[target]
          : target === 'mu'
            ? '木头的木'
            : '树林的林',
      hint: reading
        ? `Listen again for the reading used with ${target === 'mu' ? '木头' : '树林'}.`
        : scene
          ? target === 'mu'
            ? 'Look for the single 木 tree.'
            : 'Look for the character made from two 木 trees.'
          : target === 'mu'
            ? 'Listen for 木头 and look for the tree character.'
            : 'Listen for 树林 and look for the two-tree character.',
      demonstration: reading
        ? `Listen to the reading for ${STORY_LABELS[target]}, then choose the matching sound.`
        : target === 'mu'
          ? '木 means wood or tree.'
          : '林 shows two 木 trees together.',
    };
  },
);
export function storyQuestion(id: string) {
  return QUESTIONS.find((q) => q.id === id) ?? null;
}
export function storyChoices(id: string, seed: number) {
  const q = storyQuestion(id);
  if (!q) return [];
  const shift = ((seed >>> 0) + q.ordinal) % q.choices.length;
  return [...q.choices.slice(shift), ...q.choices.slice(0, shift)];
}
export function optionSpeech(choiceId: string) {
  return STORY_LABELS[choiceId.replace('audio-', '')] ?? '';
}
export const STORY_COPY = {
  title: 'A shady place to read',
  preview: 'Review preview · lesson not released',
  intro:
    'Our capybara has a book. Let’s find a shady place to read. A parent stays nearby while you control the story.',
  soundCheck: 'Try the Mandarin sound, then tell us whether you heard it.',
  soundPending:
    'Sound is available for listening, but its review is still pending. You can continue without sound; these questions will stay separate from wrong answers.',
  synthetic:
    'Synthetic technical preview. These results are not real-child evidence or human audio approval.',
  firstLook: 'Let’s see which characters you recognise.',
  wood: '木 is our tree / wood character. Use its shape to remember the word 木头.',
  grove:
    '林 puts two 木 trees together to show a grove. This is a memory aid, not a claim about historical etymology.',
  reminder:
    'You recognised these on your first look. Hear the words, then carry on.',
  targetReminder:
    'You recognised this on your first look. Here is a short reminder.',
  build:
    'Put two separate 木 pieces beside each other. This is a structure activity, not independent reading.',
  buildHelp:
    'Use two different pieces: tree 1 in one place, tree 2 in the other. Each button works with Enter or Space.',
  find: 'Find the character for our story. Sound is optional in this game.',
  reader:
    'These captions include words we have not taught. Listening and English meaning support this reading; we do not score whole-sentence reading.',
  sentenceDraft:
    'Draft sentence and sound · attributed Mandarin review pending.',
  quietSound: 'Listen to the word cue, then choose the matching character.',
  quietReading:
    'Look at this character. Listen to the options, then choose its sound.',
  clue: 'A small clue',
  demonstration: 'Let’s try it together',
  unavailable:
    'This question is unavailable. Missing or unreviewed sound is kept separate from wrong answers.',
  supported: 'You matched it with support. You can move on.',
  independent: 'You matched it on your first response.',
  demonstrated: 'We used a demonstration. You can move on.',
  finish:
    'Our capybara can settle with a book in the shade. You finished the activities; your answers and any help are shown separately.',
  recap:
    'Supported sentence reading and game completion are separate from independent target recognition. Four checks do not establish mastery or fluency.',
  review:
    'Return for two ordinary-print questions after 24 hours. The server decides when they are due.',
};
export const STORY_QUESTION_IDS = QUESTIONS.map((q) => q.id);
export function storyReviewLines() {
  return {
    english: Object.values(STORY_COPY),
    questions: QUESTIONS.map((q) => ({
      id: q.id,
      cue: q.cue,
      hint: q.hint,
      demonstration: q.demonstration,
    })),
    audio: [
      '你好',
      '木头的木',
      '树林的林',
      '木',
      '林',
      '人',
      '大',
      '木头',
      '树林',
      ...Object.values(STORY_READERS).map((r) => r.text),
    ],
  };
}
