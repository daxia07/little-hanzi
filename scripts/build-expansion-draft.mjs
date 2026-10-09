/** Fixed expansion destinations; no service, database, recording or release writes. */
import { buildPairedDraft } from './build-paired-draft.mjs';
await buildPairedDraft({
  preciseWordPrompts: true,
  contextConsistentReadings: true,
  batchSize: 50,
  draftPath: 'content/authoring/expansion-draft-v1.json', draftSchema: 'expansion-authoring-draft-1',
  previousManifest: 'content/corpora/hanzi-starter-draft-v4.json',
  batchId: 'hanzi-starter-draft-batch-05', sourceId: 'expansion-cc-cedict-20261008',
  corpusVersion: 'hanzi-starter-draft-v5', manifestPath: 'content/corpora/hanzi-starter-draft-v5.json',
  packageDirectory: 'content/curriculum/expansion', batchDirectory: 'content/corpora/expansion-batches',
  audioWorklistPath: 'content/authoring/expansion-audio-worklist-v1.json', audioWorklistSchema: 'expansion-audio-worklist-1',
});
