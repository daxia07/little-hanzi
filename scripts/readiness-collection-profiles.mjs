/** Closed runner-only collection assets; never caller paths or content. */
const profiles = Object.freeze({
  'draft-collection': Object.freeze({
    name: 'draft-collection',
    manifestPath: 'content/collections/little-hanzi-path-1-v1.json',
    packageDirectory: 'content/curriculum/collection',
  }),
  'positive-collection': Object.freeze({
    name: 'positive-collection',
    manifestPath:
      'tests/fixtures/curriculum/collection-positive/collection.json',
    packageDirectory: 'tests/fixtures/curriculum/collection-positive',
  }),
});
export function collectionProfile(name = 'draft-collection') {
  if (typeof name !== 'string' || !Object.hasOwn(profiles, name))
    throw new Error('COLLECTION_PROFILE_INVALID');
  return profiles[name];
}
