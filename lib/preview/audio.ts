/** Browser-side speech policy helpers. They report availability, never pronunciation quality. */

export interface MandarinVoice {
  lang: string;
  name?: string;
  localService?: boolean;
}

export type PlaybackResult = 'started' | 'unavailable' | 'failed';

function languageRank(lang: string): number {
  const normalized = lang.toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-cn' || normalized === 'zh-hans-cn') return 0;
  if (normalized === 'zh-sg' || normalized === 'zh-hans-sg') return 1;
  if (normalized === 'cmn-cn' || normalized === 'cmn-hans-cn') return 2;
  if (normalized === 'cmn-sg' || normalized === 'cmn-hans-sg') return 3;
  if (normalized === 'zh-tw' || normalized === 'zh-hant-tw') return 4;
  if (normalized === 'cmn-tw' || normalized === 'cmn-hant-tw') return 5;
  if (normalized === 'zh-hans') return 6;
  if (normalized === 'cmn') return 7;
  return -1;
}

export function selectMandarinVoice<T extends MandarinVoice>(voices: readonly T[]): T | null {
  return voices
    .map((voice, index) => ({ voice, index, rank: languageRank(voice.lang) }))
    .filter((item) => item.rank >= 0)
    .sort((left, right) => left.rank - right.rank || Number(right.voice.localService === true) - Number(left.voice.localService === true) || left.index - right.index)[0]?.voice ?? null;
}

export function classifyPlayback(input: { started: boolean; voiceAvailable: boolean; error?: boolean }): PlaybackResult {
  if (input.started) return 'started';
  if (!input.voiceAvailable) return 'unavailable';
  return input.error ? 'failed' : 'unavailable';
}

export function canSubmitSoundAnswer(input: { playback: PlaybackResult }): boolean {
  return input.playback === 'started';
}
