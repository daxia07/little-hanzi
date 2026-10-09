/** Fixed paired draft authoring only; no service, database, audio generation or release. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { curriculumDigest } from '../lib/curriculum/digest.ts';
import { validateCurriculumPackage } from '../lib/curriculum/validate.ts';
import { inspectCorpusManifest } from '../lib/pilot/corpus-policy.ts';
import { inspectCorpusBatch } from '../lib/pilot/corpus-store.ts';

export function assertDistinctPairedReadings(characters) {
  if (new Set(characters.map(c => c.numberedPinyin)).size !== 2) {
    throw Error('Paired sound checks require distinct selected readings');
  }
}

export function assertContextConsistentWords(character) {
  for (const word of character.words) {
    const position = word.text.indexOf(character.hanzi);
    if (position < 0 || word.numberedPinyin.split(' ')[position] !== character.numberedPinyin) {
      throw Error('Word context must preserve the selected target reading, including neutral tones');
    }
  }
}

export async function buildPairedDraft(config) {
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--check')) throw Error('Use no arguments or --check');
const check = args[0] === '--check';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const draft = read(config.draftPath);
const source = read(draft.sourceEvidence);
if (draft.status !== 'unreviewed' || draft.schemaVersion !== config.draftSchema) throw Error('Draft status required');
for (const entry of source.entries) {
  if (entry.kind === 'compositional-phrase' && (entry.humanReviewed !== false || entry.components.map(c => c.simplified).join('') !== entry.simplified || entry.components.map(c => c.numberedPinyin).join(' ') !== entry.numberedPinyin || entry.components.some(c => c.kind !== 'dictionary-entry'))) throw Error('Invalid compositional source binding');
}
const provenance = text => ({
  source: 'CC-CEDICT/MDBG pinned dictionary facts; original Little Hanzi contexts; human review pending',
  license: `CC-BY-SA-4.0; attribution in ${draft.sourceEvidence}`,
  evidenceRef: `${draft.sourceEvidence}#${text}`, sourceChecked: false,
});
const packages = [];
for (const lesson of draft.lessons) {
  if (lesson.characters.length !== 2) throw Error('Two targets required');
  assertDistinctPairedReadings(lesson.characters);
  for (const c of lesson.characters) {
    if (config.contextConsistentReadings) assertContextConsistentWords(c);
    for (const entry of [{text: c.hanzi, numberedPinyin: c.numberedPinyin}, ...c.words]) {
      if (!source.entries.some(e => e.simplified === entry.text && e.numberedPinyin === entry.numberedPinyin)) throw Error(`Dictionary match missing: ${entry.text}`);
    }
  }
  const checks = [], targets = [], cues = [];
  const characters = lesson.characters.map((c, index) => {
    const hex = c.hanzi.codePointAt(0).toString(16), characterId = `char-${hex}`, readingId = `reading-${hex}`;
    const words = c.words.map((w, i) => ({
      wordId: `word-${hex}-${i + 1}`, text: w.text, pinyin: w.pinyin, english: w.english, readingId,
      context: { hanzi: w.sentence, english: w.translation, targetCharacter: c.hanzi }, provenance: provenance(w.text),
    }));
    const checkIds = ['familiar', 'check', 'review', 'practice-one', 'practice-two'].map(kind => `${kind}-${hex}`);
    checkIds.forEach((checkId, i) => {
      const prompt = i < 3 ? c.hanzi : words[i - 3].text;
      const position = ['first', 'second', 'third', 'fourth'][prompt.indexOf(c.hanzi)];
      const precisePractice = i >= 3 && config.preciseWordPrompts;
      if (precisePractice && !position) throw Error('Word target position unsupported');
      // The four literal distractors are authored, not inferred from a dictionary answer key.
      const choices = [lesson.characters[0].hanzi, lesson.characters[1].hanzi, '木', '口'];
      checks.push({ checkId, characterId, kind: i < 3 ? 'plain-print' : 'word-context',
        instructionEnglish: precisePractice ? `Listen to the word, then choose its ${position} printed character.` : 'Listen, then choose a printed character.',
        prompt: { english: i < 3 ? 'Which printed character matches the sound?' : precisePractice ? `Which is the ${position} character in the spoken word?` : 'Which character from this lesson is in the spoken word?', hanzi: prompt },
        choices: choices.map((hanzi, n) => ({ choiceId: `${checkId}-choice-${n + 1}`, hanzi })), correctChoiceId: `${checkId}-choice-${index + 1}` });
      cues.push({ cueId: `cue-${checkId}`, readingId: null, wordId: null, checkId, transcript: prompt, assetId: 'asset-mandarin', assetUrl: null, assetDigest: null });
    });
    cues.push({ cueId: `cue-${readingId}`, readingId, wordId: null, checkId: null, transcript: c.hanzi, assetId: 'asset-mandarin', assetUrl: null, assetDigest: null });
    words.forEach(w => cues.push({ cueId: `cue-reader-${w.wordId}`, readingId: null, wordId: w.wordId, checkId: null, transcript: w.context.hanzi, assetId: 'asset-mandarin', assetUrl: null, assetDigest: null }));
    targets.push({ characterId, readingId, familiarityCheckId: checkIds[0], practice: words.map((w, i) => ({ wordId: w.wordId, checkId: checkIds[i + 3] })), immediateCheckId: checkIds[1], reviewCheckId: checkIds[2] });
    return { characterId, hanzi: c.hanzi, readings: [{ readingId, pinyin: c.pinyin, audioText: c.hanzi, provenance: provenance(c.hanzi) }],
      meanings: [{ english: c.meaning, provenance: provenance(c.hanzi) }], wordAssociations: words,
      teaching: { instructionEnglish: 'Look at the character and listen to two useful words.', hintEnglish: c.hint, demonstrationEnglish: `This is ${c.hanzi}. Notice its printed shape in each word.`, recognitionCheckId: checkIds[1],
        delayedReview: { promptId: `later-${hex}`, instructionEnglish: 'Listen again and choose the printed character.', cueEnglish: 'What do you remember from this sound?', recognitionCheckId: checkIds[2] } }, assets: [`asset-glyph-${hex}`, 'asset-system-font', 'asset-mandarin'] };
  });
  const assets = characters.map(c => ({ assetId: `asset-glyph-${c.hanzi.codePointAt(0).toString(16)}`, kind: 'glyph', source: 'Unicode character rendered by the local CJK system font', license: 'Character identity; device font not redistributed', evidenceRef: `draft/device/${lesson.lessonVersion}/${c.characterId}`, sourceChecked: false, sourceCheckStatus: 'pending-owner' }));
  assets.push({ assetId: 'asset-system-font', kind: 'font', source: 'Local CJK system fallback', license: 'System font supplied by the device; not redistributed', evidenceRef: `draft/device/${lesson.lessonVersion}/font`, sourceChecked: false, sourceCheckStatus: 'pending-owner' },
    { assetId: 'asset-mandarin', kind: 'audio', source: 'Local device Mandarin speech; no reviewed voice allowlist configured', license: 'Device speech suitability and terms require review', evidenceRef: `draft/audio/${lesson.lessonVersion}/local-device`, sourceChecked: false, sourceCheckStatus: 'pending-owner' });
  const p = { lessonId: lesson.lessonId, lessonVersion: lesson.lessonVersion, title: lesson.title, canonicalizationVersion: 's3-json-1', placement: { trackId: 'everyday-hanzi', sequence: lesson.sequence },
    renderer: { adapterId: 'corpus-paired', adapterVersion: 'corpus-paired-v1', capabilities: ['selection-v1', 'recognition-v1', 'delayed-review-v1', 'progress-export-v1'] },
    instructionsEnglish: { welcome: lesson.welcome, objective: 'Recognise two characters in useful words and ordinary print.', completion: 'Your responses are saved. A later visit gives us new evidence.', recovery: 'If saving pauses, keep this page open and use the displayed retry action.' }, characters,
    steps: ['familiarity', 'teach', 'practice', 'plain-print-check', 'recap'].map((kind, i) => ({ stepId: `${lesson.lessonId}-${kind}`, kind,
      instructionEnglish: ['Try two sounds without teaching clues.', 'Look at each character and its useful words.', 'Listen to words and choose the matching character.', 'Try the sounds again in ordinary print.', 'See what was saved and what you can revisit.'][i],
      recognitionCheckIds: i === 0 ? targets.map(t => t.familiarityCheckId) : i === 2 ? targets.flatMap(t => t.practice.map(w => w.checkId)) : i === 3 ? targets.map(t => t.immediateCheckId) : [] })), recognitionChecks: checks, assets,
    pairedStory: { schemaVersion: 'r5-paired-story-1', welcome: { title: lesson.title, instructionEnglish: lesson.welcome }, targets,
      reader: { title: lesson.readerTitle, instructionEnglish: 'Listen and follow each short sentence. These are supported reading examples.', wordIds: characters.flatMap(c => c.wordAssociations.map(w => w.wordId)) },
      playback: { schemaVersion: 'r5-playback-1', kind: 'local-device', voices: [], fallback: 'unavailable', cues } } };
  const result = validateCurriculumPackage(p);
  if (!result.ok) throw Error(JSON.stringify(result.errors));
  packages.push(p);
}
const previous = read(config.previousManifest);
const batchSize = config.batchSize ?? packages.length;
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) throw Error('Authoring batch capacity must be between 1 and 50');
const batchIdFor = i => packages.length > batchSize ? `${config.batchId}-${String(Math.floor(i / batchSize) + 1).padStart(2, '0')}` : config.batchId;
const items = await Promise.all(packages.map(async (p, i) => ({ lessonVersion: p.lessonVersion, contentDigest: await curriculumDigest(p), batchId: batchIdFor(i), ...p.placement })));
const manifest = { ...previous, corpusVersion: config.corpusVersion, items: [...previous.items, ...items] };
inspectCorpusManifest(manifest);
const seen = new Set();
for (const item of previous.items) {
  const locations = ['content/curriculum/corpus', 'content/curriculum/nature', 'content/curriculum/everyday', 'content/curriculum/people', 'content/curriculum/expansion'].map(dir => `${dir}/${item.lessonVersion}.json`);
  const prior = read(locations.find(p => fs.existsSync(path.join(root, p))));
  for (const c of prior.characters) { if (seen.has(c.hanzi)) throw Error('Duplicate prior target'); seen.add(c.hanzi); }
}
for (const p of packages) for (const c of p.characters) { if (seen.has(c.hanzi)) throw Error('Duplicate new target'); seen.add(c.hanzi); }
const batches = [];
for (let from = 0; from < packages.length; from += batchSize) {
  const batchId = batchIdFor(from);
  const batch = { schemaVersion: 'r6-authoring-batch-1', batchId, batchVersion: `${batchId}-v1`, items: packages.slice(from, from + batchSize).map((p, i) => ({ lessonVersion: p.lessonVersion, contentDigest: items[from + i].contentDigest,
    characters: p.characters.map(c => ({ characterId: c.characterId, coverageIdentity: c.hanzi })), sourceRefs: [config.sourceId], licenseRefs: ['CC-BY-SA-4.0'], reviewerRefs: [], adapterId: 'corpus-paired', adapterVersion: 'corpus-paired-v1', ...p.placement })), intendedScope: 'draft', unresolvedFields: ['UNVERIFIED_SOURCE', 'UNREVIEWED_CONTENT', 'UNREVIEWED_AUDIO'] };
  inspectCorpusBatch(batch);
  batches.push(batch);
}
const requests = [];
for (const [i, p] of packages.entries()) {
  const grouped = new Map();
  for (const cue of p.pairedStory.playback.cues) {
    if (!grouped.has(cue.transcript)) {
      const authored = draft.lessons[i].characters.flatMap(c => [{ text: c.hanzi, numberedPinyin: c.numberedPinyin }, ...c.words]).find(w => w.text === cue.transcript);
      grouped.set(cue.transcript, { requestId: `${p.lessonVersion}-render-${String(grouped.size + 1).padStart(2, '0')}`, lessonVersion: p.lessonVersion, contentDigest: items[i].contentDigest, script: cue.transcript,
        lexicalNumberedPinyin: authored?.numberedPinyin ?? null, pronunciationReview: 'pending; verify selected sense, connected speech, tones, sandhi and neutral tones by listening', consumers: [], renderStatus: 'not-rendered', listeningStatus: 'pending', deviceStatus: 'pending', audioSha256: null });
    }
    grouped.get(cue.transcript).consumers.push({ lessonVersion: p.lessonVersion, cueId: cue.cueId });
  }
  requests.push(...grouped.values());
}
const outputs = new Map(packages.map(p => [`${config.packageDirectory}/${p.lessonVersion}.json`, p]));
outputs.set(config.manifestPath, manifest);
for (const batch of batches) outputs.set(`${config.batchDirectory}/${batch.batchVersion}.json`, batch);
outputs.set(config.audioWorklistPath, { schemaVersion: config.audioWorklistSchema, status: 'pending', corpusVersion: manifest.corpusVersion, corpusDigest: await curriculumDigest(manifest), requests });
for (const [name, value] of outputs) {
  const text = JSON.stringify(value, null, 2) + '\n', file = path.join(root, name);
  if (check) {
    if (fs.readFileSync(file, 'utf8') !== text) throw Error(`Generated artifact drift: ${name}`);
  } else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
}
console.log(JSON.stringify({ mode: check ? 'check' : 'draft', packages: packages.length, newTargets: packages.flatMap(p => p.characters).length, combinedTargets: manifest.items.length * 2, audioRequests: requests.length, consumers: requests.reduce((n, r) => n + r.consumers.length, 0), humanApproval: false, publication: false }));

}
