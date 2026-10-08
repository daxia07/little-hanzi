// Independent literal target oracle from the frozen collection contract.
// No product reducer, package, grading-key or answer-map import.
export const COLLECTION = Object.freeze({
  id: 'little-hanzi-path-1',
  version: 'little-hanzi-path-1-v1',
  track: 'everyday-hanzi',
  adapter: 'paired-story',
  adapterVersion: 'paired-story-v1',
});
export const LESSONS = Object.freeze(
  [
    { version: 'path-01-v1', sequence: 1, targets: ['木', '林'] },
    { version: 'path-02-v1', sequence: 2, targets: ['日', '月'] },
    { version: 'path-03-v1', sequence: 3, targets: ['人', '口'] },
    { version: 'path-04-v1', sequence: 4, targets: ['山', '水'] },
    { version: 'path-05-v1', sequence: 5, targets: ['大', '小'] },
    { version: 'path-06-v1', sequence: 6, targets: ['上', '下'] },
    { version: 'path-07-v1', sequence: 7, targets: ['田', '土'] },
    { version: 'path-08-v1', sequence: 8, targets: ['火', '雨'] },
    { version: 'path-09-v1', sequence: 9, targets: ['手', '目'] },
    { version: 'path-10-v1', sequence: 10, targets: ['门', '车'] },
  ].map((item) =>
    Object.freeze({ ...item, targets: Object.freeze(item.targets) }),
  ),
);
export const TARGETS = Object.freeze({
  木: { reading: 'mù', meaning: 'tree / wood' },
  林: { reading: 'lín', meaning: 'woods' },
  日: { reading: 'rì', meaning: 'sun / day' },
  月: { reading: 'yuè', meaning: 'moon / month' },
  人: { reading: 'rén', meaning: 'person' },
  口: { reading: 'kǒu', meaning: 'mouth' },
  山: { reading: 'shān', meaning: 'mountain' },
  水: { reading: 'shuǐ', meaning: 'water' },
  大: { reading: 'dà', meaning: 'big' },
  小: { reading: 'xiǎo', meaning: 'small' },
  上: { reading: 'shàng', meaning: 'up / above' },
  下: { reading: 'xià', meaning: 'down / below' },
  田: { reading: 'tián', meaning: 'field' },
  土: { reading: 'tǔ', meaning: 'earth / soil' },
  火: { reading: 'huǒ', meaning: 'fire' },
  雨: { reading: 'yǔ', meaning: 'rain' },
  手: { reading: 'shǒu', meaning: 'hand' },
  目: { reading: 'mù', meaning: 'eye' },
  门: { reading: 'mén', meaning: 'door / gate' },
  车: { reading: 'chē', meaning: 'vehicle' },
});
export const PHASES = Object.freeze({
  initial: 0,
  'review-24h': 86400000,
  'review-7d': 604800000,
});
// The frozen DTO will bind public question IDs/options to these literal targets.
// Do not infer answer IDs from server correctness or hard-code a choice position.
export function findPrintedTarget(choices, target) {
  if (!Object.hasOwn(TARGETS, target))
    throw new Error('Unknown independent target');
  const matches = choices.filter((choice) => choice.hanzi === target);
  if (matches.length !== 1)
    throw new Error('Expected one exact ordinary-print target');
  return matches[0];
}
