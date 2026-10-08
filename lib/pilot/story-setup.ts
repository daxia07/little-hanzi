export type StorySetupExperience = 'new' | 'some' | 'confident' | 'unsure';
export type StorySetupSoundResponse = 'unanswered' | 'heard' | 'unavailable';
export const STORY_SETUP_SOUND_SAMPLE = '你好';

export interface SavedStorySetup {
  nickname: string;
  experience: StorySetupExperience;
  audioReady: boolean;
}

export interface StorySetupDraft {
  nickname: string;
  experience: StorySetupExperience;
  soundResponse: StorySetupSoundResponse;
  saved: boolean;
}

export function createInitialStorySetup(
  childName: string,
  savedSetup: SavedStorySetup | null,
): StorySetupDraft {
  const fallbackName = childName.trim() || 'Your child';
  if (!savedSetup) {
    return {
      nickname: fallbackName,
      experience: 'unsure',
      soundResponse: 'unanswered',
      saved: false,
    };
  }
  return {
    nickname: savedSetup.nickname.trim() || fallbackName,
    experience: savedSetup.experience,
    soundResponse: savedSetup.audioReady ? 'heard' : 'unavailable',
    saved: true,
  };
}

export function canSaveStorySetup(input: {
  soundResponse: StorySetupSoundResponse;
}) {
  return input.soundResponse !== 'unanswered';
}

export function canMarkStorySoundHeard(input: { sampleStarted: boolean }) {
  return input.sampleStarted;
}

export function storySetupAudioReady(
  response: StorySetupSoundResponse,
): boolean | null {
  if (response === 'unanswered') return null;
  return response === 'heard';
}
