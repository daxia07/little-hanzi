/** Fixed people/grammar destinations; drafts only, no recording or service writes. */
import { buildPairedDraft } from './build-paired-draft.mjs';
await buildPairedDraft({
  preciseWordPrompts: true,
  contextConsistentReadings: true,
  draftPath: 'content/authoring/people-draft-v1.json', draftSchema: 'people-authoring-draft-1',
  previousManifest: 'content/corpora/hanzi-starter-draft-v3.json',
  batchId: 'hanzi-starter-draft-batch-04', sourceId: 'people-cc-cedict-20261008',
  corpusVersion: 'hanzi-starter-draft-v4', manifestPath: 'content/corpora/hanzi-starter-draft-v4.json',
  packageDirectory: 'content/curriculum/people', batchDirectory: 'content/corpora/people-batches',
  audioWorklistPath: 'content/authoring/people-audio-worklist-v1.json', audioWorklistSchema: 'people-audio-worklist-1',
});
