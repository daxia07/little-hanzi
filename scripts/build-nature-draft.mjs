/** Fixed nature destinations; no service, database or audio generation. */
import { buildPairedDraft } from './build-paired-draft.mjs';
await buildPairedDraft({
  draftPath: 'content/authoring/nature-draft-v1.json', draftSchema: 'nature-authoring-draft-1',
  previousManifest: 'content/corpora/hanzi-starter-draft-v1.json',
  batchId: 'hanzi-starter-draft-batch-02', sourceId: 'nature-cc-cedict-20261008',
  corpusVersion: 'hanzi-starter-draft-v2', manifestPath: 'content/corpora/hanzi-starter-draft-v2.json',
  packageDirectory: 'content/curriculum/nature', batchDirectory: 'content/corpora/nature-batches',
  audioWorklistPath: 'content/authoring/nature-audio-worklist-v1.json', audioWorklistSchema: 'nature-audio-worklist-1',
});
