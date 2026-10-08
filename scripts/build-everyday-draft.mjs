/** Fixed everyday destinations; no service, database or audio generation. */
import { buildPairedDraft } from './build-paired-draft.mjs';
await buildPairedDraft({
  preciseWordPrompts: true,
  draftPath: 'content/authoring/everyday-draft-v1.json', draftSchema: 'everyday-authoring-draft-1',
  previousManifest: 'content/corpora/hanzi-starter-draft-v2.json',
  batchId: 'hanzi-starter-draft-batch-03', sourceId: 'everyday-cc-cedict-20261008',
  corpusVersion: 'hanzi-starter-draft-v3', manifestPath: 'content/corpora/hanzi-starter-draft-v3.json',
  packageDirectory: 'content/curriculum/everyday', batchDirectory: 'content/corpora/everyday-batches',
  audioWorklistPath: 'content/authoring/everyday-audio-worklist-v1.json', audioWorklistSchema: 'everyday-audio-worklist-1',
});
