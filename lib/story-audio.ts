/** Local speech boundary. Actual onstart gates; no human review or score is inferred. */
export interface StoryVoice {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}
interface StoryUtterance {
  text: string;
  lang: string;
  rate: number;
  voice: StoryVoice | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
interface StorySpeech {
  getVoices: () => StoryVoice[];
  cancel: () => void;
  speak: (utterance: StoryUtterance) => void;
}
export interface StoryAudioSnapshot {
  status: 'idle' | 'loading' | 'playing' | 'ended' | 'unavailable' | 'muted';
  muted: boolean;
  voice: StoryVoice | null;
  questionId: string | null;
  readyKeys: string[];
}
export interface StoryPlayback {
  gesture: boolean;
  questionId?: string | null;
  optionId?: string;
  required?: boolean;
  onFailure?: () => void;
  onStart?: () => void;
}
export function selectStoryVoice(
  voices: readonly StoryVoice[],
): StoryVoice | null {
  const local = voices.filter(
    (v) =>
      v.localService === true &&
      /^(?:zh-(?:CN|SG|TW)|cmn(?:-(?:Hans|Hant))?(?:-(?:CN|SG|TW))?)$/i.test(
        v.lang,
      ),
  );
  return (
    local.find((v) => v.name === 'Tingting') ??
    local.find((v) => v.default) ??
    local[0] ??
    null
  );
}
export function createStoryAudio({
  synth = typeof window === 'undefined'
    ? undefined
    : (window.speechSynthesis as unknown as StorySpeech),
  Utterance = typeof window === 'undefined'
    ? undefined
    : (window.SpeechSynthesisUtterance as unknown as new (
        text: string,
      ) => StoryUtterance),
  onChange = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
}: {
  synth?: StorySpeech;
  Utterance?: new (text: string) => StoryUtterance;
  onChange?: (s: StoryAudioSnapshot) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (token: unknown) => void;
} = {}) {
  let generation = 0,
    questionId: string | null = null,
    status: StoryAudioSnapshot['status'] = 'idle',
    muted = false,
    timer: unknown = null;
  let last: { text: string; options: StoryPlayback } | null = null;
  const heard = new Set<string>();
  const voice = () => {
    try {
      return selectStoryVoice(synth?.getVoices() ?? []);
    } catch {
      return null;
    }
  };
  const snapshot = (): StoryAudioSnapshot => ({
    status,
    muted,
    questionId,
    voice: voice(),
    readyKeys: [...heard],
  });
  const emit = () => onChange(snapshot());
  function cancel() {
    generation++;
    if (timer !== null) unschedule(timer);
    timer = null;
    try {
      synth?.cancel();
    } catch {}
    status = muted ? 'muted' : 'idle';
    emit();
  }
  function key(id: string, option?: string) {
    return `${id}:${option ?? 'cue'}`;
  }
  function play(text: string, options: StoryPlayback) {
    cancel();
    last = { text, options };
    const token = generation,
      currentQuestion = questionId,
      currentVoice = voice();
    const valid = () => token === generation && questionId === currentQuestion;
    const fail = () => {
      if (!valid()) return;
      generation++;
      if (timer !== null) unschedule(timer);
      timer = null;
      try {
        synth?.cancel();
      } catch {}
      if (options.required && options.questionId)
        heard.delete(key(options.questionId, options.optionId));
      status = 'unavailable';
      emit();
      options.onFailure?.();
    };
    if (!options.gesture || muted || !synth || !Utterance || !currentVoice) {
      fail();
      return false;
    }
    if (options.required && options.questionId !== questionId) return false;
    const utterance = new Utterance(text);
    utterance.voice = currentVoice;
    utterance.lang = currentVoice.lang;
    utterance.rate = 0.82;
    utterance.onstart = () => {
      if (!valid()) return;
      status = 'playing';
      if (options.required && options.questionId === questionId && questionId)
        heard.add(key(questionId, options.optionId));
      emit();
      options.onStart?.();
    };
    utterance.onend = () => {
      if (!valid()) return;
      if (timer !== null) unschedule(timer);
      timer = null;
      status = 'ended';
      emit();
    };
    utterance.onerror = fail;
    status = 'loading';
    emit();
    timer = schedule(fail, 10000);
    try {
      synth.speak(utterance);
      return true;
    } catch {
      fail();
      return false;
    }
  }
  return {
    snapshot,
    play,
    ready: (id: string, optionId?: string) =>
      id === questionId && heard.has(key(id, optionId)),
    setContext(id: string | null) {
      if (questionId === id) return;
      cancel();
      questionId = id;
      heard.clear();
      last = null;
      emit();
    },
    cancel,
    setMuted(value: boolean) {
      muted = value;
      heard.clear();
      cancel();
    },
    replay() {
      return last ? play(last.text, { ...last.options, gesture: true }) : false;
    },
    destroy() {
      cancel();
      heard.clear();
      last = null;
    },
  };
}
