/** Server-only fixed r6-paired-profile-1 wrapper. Original R6 bytes/identity are preserved. */
import { createPairedEngine } from './paired-engine.ts';
import type { CompiledStoryLesson, StoryRun } from './paired-engine.ts';
export { PairedRuntimeError as CorpusRuntimeError } from './paired-engine.ts';
export type { CorpusIdentity } from './paired-engine.ts';
export type CompiledCorpusLesson = CompiledStoryLesson<'corpus'>;
export type CorpusRun = StoryRun<'corpus'>;
const engine = createPairedEngine('corpus');
export const compileCorpusRuntime = engine.compile;
export const createCorpusRun = engine.create;
export const validateCorpusRun = engine.validate;
export const applyCorpusAction = engine.apply;
export const projectCorpusRun = engine.project;
