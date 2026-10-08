import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialStorySetup,
  canSaveStorySetup,
  canMarkStorySoundHeard,
  STORY_SETUP_SOUND_SAMPLE,
  storySetupAudioReady,
} from '../lib/pilot/story-setup.ts';

test('[F1-002] a new story setup uses the linked child and waits for an explicit sound response', () => {
  assert.equal(STORY_SETUP_SOUND_SAMPLE, '你好');
  assert.deepEqual(createInitialStorySetup('Learner', null), {
    nickname: 'Learner',
    experience: 'unsure',
    soundResponse: 'unanswered',
    saved: false,
  });
  assert.equal(canSaveStorySetup({ soundResponse: 'unanswered' }), false);
  assert.equal(storySetupAudioReady('unanswered'), null);
  assert.equal(canMarkStorySoundHeard({ sampleStarted: false }), false);
  assert.equal(canMarkStorySoundHeard({ sampleStarted: true }), true);
});

test('[F1-002] saved setup is restored without treating unavailable sound as unheard', () => {
  assert.deepEqual(
    createInitialStorySetup('Learner', {
      nickname: 'Learner at home',
      experience: 'some',
      audioReady: false,
    }),
    {
      nickname: 'Learner at home',
      experience: 'some',
      soundResponse: 'unavailable',
      saved: true,
    },
  );
  assert.equal(canSaveStorySetup({ soundResponse: 'unavailable' }), true);
  assert.equal(storySetupAudioReady('unavailable'), false);
  assert.equal(storySetupAudioReady('heard'), true);
});
