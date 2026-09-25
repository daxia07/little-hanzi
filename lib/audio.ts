/** Reviewed Mandarin prompts used by the public browser speech-synthesis path. */
export const SPEECH_PROMPTS: Readonly<Record<string, string>> = {
  yi: '一',
  'yi-word': '第一',
  er: '二',
  'er-word': '二月',
  san: '三',
  'san-word': '三天',
  da: '大',
  'da-word': '大人',
  xiao: '小',
  'xiao-word': '小手',
  ren: '人',
  'ren-word': '家人',
  welcome: '欢迎来到小小汉字。今天，我们一起听一听、认一认，再用小手写一写。',
  write: '请用手指，跟着笔画写一写。',
  pinyin: '拼音由字母和声调组成。',
  recognition: '请听发音，选出你听到的汉字。',
};

/** Select a Mandarin voice, preferring voices installed on this device. */
export function selectMandarinVoice(voices: readonly SpeechSynthesisVoice[]) {
  return voices
    .filter(voice => voice.lang.toLowerCase().replace('_', '-') === 'zh-cn')
    .sort((a, b) => Number(b.localService) - Number(a.localService))[0];
}
