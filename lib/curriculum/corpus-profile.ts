/** Fixed R6 binding over the unchanged pairedStory/playback section schemas. */
import { validatePairedEngineSection } from './paired-profile.ts';
export function validateCorpusSection(input: unknown): boolean {
  return validatePairedEngineSection(input, 'corpus-paired');
}
