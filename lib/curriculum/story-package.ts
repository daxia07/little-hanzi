import { canonicalPackage, curriculumDigest } from './digest.ts';
import { FOREST_STORY_LESSON } from '../preview/content.ts';
import type { PlaybackProfile } from './story-types.ts';
export const STORY_LINEAGE =
  'sha256:bfd06daa7d205bc077b2e8136c7dc47ebb6d645921de8adee34f92da30a7b1fb';
export const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const exact = (
  v: unknown,
  keys: readonly string[],
): v is Record<string, unknown> =>
  record(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export const text = (v: unknown, max = 2000): v is string =>
  typeof v === 'string' &&
  v.trim() === v &&
  v.length > 0 &&
  v.length <= max &&
  v.isWellFormed();
export function storyDefinition(playback: PlaybackProfile) {
  return {
    schemaVersion: 'r3-story-package-1',
    lineageDigest: STORY_LINEAGE,
    steps: FOREST_STORY_LESSON.steps,
    questions: FOREST_STORY_LESSON.questions,
    learningPanels: {
      introduction: ['learn-mu', 'learn-lin'],
      reminder: ['reminder'],
      mixed: 'per-target',
    },
    build: { pieces: ['mu-a', 'mu-b'], slots: ['left', 'right'], glyph: '林' },
    find: { ids: ['find-mu', 'find-lin'], soundRequired: false },
    reader: FOREST_STORY_LESSON.captions,
    rules: {
      firstResponse: true,
      helpAssists: true,
      secondWrongDemonstrates: true,
      lateFailure: 'append-unavailable-current-question',
    },
    delayed: {
      questionIds: ['review-mu-sound', 'review-lin-sound'],
      delayMs: 86400000,
    },
    playback,
  };
}
export type StoryPackage = Record<string, unknown> & {
  lessonId: 'forest-01';
  lessonVersion: 'forest-01-v4';
  title: string;
  canonicalizationVersion: 's3-json-1';
  renderer: {
    adapterId: 'forest-story';
    adapterVersion: 'forest-story-v1';
    capabilities: string[];
  };
  characters: Array<{
    characterId: string;
    hanzi: string;
    readings: Array<{ audioText: string }>;
    wordAssociations: Array<{ text: string; context: { hanzi: string } }>;
  }>;
  story: ReturnType<typeof storyDefinition>;
};
export function validPlayback(
  value: unknown,
  required: readonly string[],
): value is PlaybackProfile {
  if (
    !exact(value, ['schemaVersion', 'kind', 'voices', 'fallback', 'cues']) ||
    value.schemaVersion !== 'r3-playback-1' ||
    !['local-device', 'recorded'].includes(String(value.kind)) ||
    value.fallback !== 'unavailable' ||
    !Array.isArray(value.voices) ||
    !Array.isArray(value.cues)
  )
    return false;
  if (
    (value.kind === 'local-device' && value.voices.length === 0) ||
    (value.kind === 'recorded' && value.voices.length !== 0)
  )
    return false;
  if (
    value.voices.some(
      (v) =>
        !exact(v, ['name', 'lang', 'localService']) ||
        !text(v.name, 120) ||
        typeof v.lang !== 'string' ||
        !/^(?:zh-(?:CN|SG|TW)|cmn(?:-(?:Hans|Hant))?(?:-(?:CN|SG|TW))?)$/i.test(
          v.lang,
        ) ||
        v.localService !== true,
    )
  )
    return false;
  const ids = new Set<string>(),
    transcripts = new Set<string>();
  for (const c of value.cues) {
    if (
      !exact(c, [
        'id',
        'transcript',
        'source',
        'license',
        'assetUrl',
        'assetDigest',
      ]) ||
      !text(c.id, 120) ||
      !text(c.transcript) ||
      !text(c.source) ||
      !text(c.license) ||
      ids.has(c.id) ||
      transcripts.has(c.transcript)
    )
      return false;
    ids.add(c.id);
    transcripts.add(c.transcript);
    if (value.kind === 'local-device') {
      if (c.assetUrl !== null || c.assetDigest !== null) return false;
    } else if (
      typeof c.assetUrl !== 'string' ||
      !/^\/[A-Za-z0-9/_.,-]+$/.test(c.assetUrl) ||
      c.assetUrl.includes('..') ||
      !digest(c.assetDigest)
    )
      return false;
  }
  return required.every((t) => transcripts.has(t));
}
export function requiredTranscripts(pick: Pick<StoryPackage, 'characters'>) {
  return [
    ...new Set(
      ['你好'].concat(
        FOREST_STORY_LESSON.questions
          .flatMap((q) => [
            q.prompt,
            q.cueText,
            ...q.choices
              .map((c) => c.audioText)
              .filter((v): v is string => !!v),
          ])
          .concat(
            FOREST_STORY_LESSON.examples.map((e) => e.audioText),
            FOREST_STORY_LESSON.captions.map((c) => c.text),
            pick.characters.flatMap((c) =>
              c.readings
                .map((r) => r.audioText)
                .concat(
                  c.wordAssociations.flatMap((w) => [w.text, w.context.hanzi]),
                ),
            ),
          ),
      ),
    ),
  ];
}
export function validateStorySection(input: unknown): boolean {
  if (
    !record(input) ||
    input.lessonId !== 'forest-01' ||
    input.lessonVersion !== 'forest-01-v4' ||
    input.title !== 'A shady place to read' ||
    input.canonicalizationVersion !== 's3-json-1' ||
    !exact(input.renderer, ['adapterId', 'adapterVersion', 'capabilities']) ||
    input.renderer.adapterId !== 'forest-story' ||
    input.renderer.adapterVersion !== 'forest-story-v1' ||
    !Array.isArray(input.characters) ||
    input.characters.length !== 2
  )
    return false;
  const p = input as StoryPackage;
  if (
    p.characters[0].characterId !== 'char-mu' ||
    p.characters[0].hanzi !== '木' ||
    p.characters[1].characterId !== 'char-lin' ||
    p.characters[1].hanzi !== '林' ||
    !record(p.story) ||
    !validPlayback(p.story.playback, requiredTranscripts(p))
  )
    return false;
  return (
    canonicalPackage(p.story) ===
    canonicalPackage(storyDefinition(p.story.playback))
  );
}
export interface CompiledStory {
  identity: {
    lessonVersion: 'forest-01-v4';
    contentDigest: string;
    adapterId: 'forest-story';
    adapterVersion: 'forest-story-v1';
  };
  package: StoryPackage;
}
export async function compileStoryPackage(
  input: unknown,
): Promise<CompiledStory> {
  const { validateCurriculumPackage } = await import('./validate.ts');
  if (!validateCurriculumPackage(input).ok || !validateStorySection(input))
    throw new Error('RUNTIME_PACKAGE_UNSUPPORTED');
  const p = structuredClone(input) as StoryPackage;
  return {
    identity: {
      lessonVersion: 'forest-01-v4',
      contentDigest: await curriculumDigest(p),
      adapterId: 'forest-story',
      adapterVersion: 'forest-story-v1',
    },
    package: p,
  };
}
