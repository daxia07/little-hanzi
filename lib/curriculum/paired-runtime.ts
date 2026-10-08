/** Strict R5 entry points; R6 never enters this compiled-object partition. */
import { createPairedEngine } from './paired-engine.ts';
import type { CompiledStoryLesson } from './paired-engine.ts';
export { PairedRuntimeError } from './paired-engine.ts';
export type { PairedErrorCode } from './paired-engine.ts';
export type CompiledPairedLesson = CompiledStoryLesson<'paired'>;
const engine = createPairedEngine('paired');
export const compilePairedRuntime = engine.compile;
export const createPairedRun = engine.create;
export const validatePairedRun = engine.validate;
export const applyPairedAction = engine.apply;
export const projectPairedRun = engine.project;
