import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { hasCompleteCurriculumProvenance } from '../lib/curriculum/review.ts';
import { validateCollectionPackages } from '../lib/pilot/collection-policy.ts';
const read = (p) =>
  JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const baseline = process.env.COLLECTION_FIXTURE_BASELINE === 'draft';
function contentOnly(p) {
  const out = structuredClone(p);
  for (const c of out.characters) {
    for (const r of c.readings) delete r.provenance;
    for (const m of c.meanings) delete m.provenance;
    for (const w of c.wordAssociations) delete w.provenance;
  }
  out.assets = out.assets.map(({ assetId, kind }) => ({ assetId, kind }));
  out.pairedStory.playback.voices = [];
  return out;
}
test('[R5-P-001] all ten positive packages retain teaching and dictionary attribution while changing only labelled mechanical provenance/local voice', async () => {
  const drafts = [],
    positive = [];
  for (let i = 1; i <= 10; i++) {
    const name = `path-${String(i).padStart(2, '0')}-v1`;
    const draft = read(`../content/curriculum/collection/${name}.json`);
    const p = baseline
      ? draft
      : read(`./fixtures/curriculum/collection-positive/${name}.json`);
    drafts.push(draft);
    positive.push(p);
    validateCurriculumPackage(p);
    assert.equal(hasCompleteCurriculumProvenance(draft), false);
    assert.equal(
      hasCompleteCurriculumProvenance(p),
      true,
      `${name} must be a labelled mechanically complete fixture`,
    );
    assert.deepEqual(contentOnly(p), contentOnly(draft));
    assert.notEqual(await curriculumDigest(p), await curriculumDigest(draft));
    assert.deepEqual(p.pairedStory.playback.voices, [
      { name: 'Tingting', lang: 'zh-CN', localService: true },
    ]);
    for (let c = 0; c < p.characters.length; c++)
      for (const key of ['readings', 'meanings', 'wordAssociations'])
        for (let r = 0; r < p.characters[c][key].length; r++) {
          const src = draft.characters[c][key][r].provenance,
            v = p.characters[c][key][r].provenance;
          assert.ok(
            v.source.includes(src.source) && v.source.includes('SIMULATED'),
          );
          assert.equal(v.license, src.license);
          assert.ok(v.evidenceRef.startsWith('SIMULATED/'));
        }
    assert.ok(
      p.assets.every(
        (a) =>
          a.source.includes('SIMULATED') &&
          a.sourceChecked === true &&
          a.sourceCheckStatus === 'mechanically-checked',
      ),
    );
  }
  const manifest = read(
    baseline
      ? '../content/collections/little-hanzi-path-1-v1.json'
      : './fixtures/curriculum/collection-positive/collection.json',
  );
  const checked = await validateCollectionPackages(manifest, positive);
  assert.equal(checked.manifest.items.length, 10);
  for (let i = 0; i < 10; i++)
    assert.equal(
      manifest.items[i].contentDigest,
      await curriculumDigest(positive[i]),
    );
});
