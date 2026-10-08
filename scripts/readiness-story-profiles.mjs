/** Closed runner-only fixture selection. These paths are never caller uploads. */
const profiles = Object.freeze({
  'family-story': Object.freeze({
    name: 'family-story',
    packagePath: 'content/curriculum/forest-01-v4.json',
    bootstrapPath: '/api/test/pilot/story-bootstrap',
    bootstrapFixture: 'family-story',
  }),
  'positive-publication': Object.freeze({
    name: 'positive-publication',
    packagePath:
      'tests/fixtures/curriculum/forest-01-v4-positive-publication.json',
    bootstrapPath: '/api/test/pilot/story-positive-bootstrap',
    bootstrapFixture: 'positive-publication',
  }),
});

export function storyProfile(name = 'family-story') {
  if (typeof name !== 'string' || !Object.hasOwn(profiles, name))
    throw new Error('STORY_PROFILE_INVALID');
  return profiles[name];
}
