/** Ordinary playback accepts only the exact server-projected immutable media profile. */
import {
  createStoryAudio,
  type StoryPlayback,
  type StoryAudioSnapshot,
} from './story-audio.ts';
import type { CollectionSafePlayback } from './curriculum/collection-types.ts';
type AudioOptions = NonNullable<Parameters<typeof createStoryAudio>[0]>;
export function createCollectionAudio({
  profile,
  ...options
}: AudioOptions & { profile: () => CollectionSafePlayback | null }) {
  const device =
    options.synth ??
    (typeof window === 'undefined'
      ? undefined
      : (window.speechSynthesis as unknown as NonNullable<
          AudioOptions['synth']
        >));
  const filtered = device
    ? {
        getVoices: () =>
          device
            .getVoices()
            .filter(
              (v) =>
                profile()?.kind === 'local-device' &&
                profile()?.voices.some(
                  (p) =>
                    p.name === v.name &&
                    p.lang === v.lang &&
                    v.localService === true,
                ),
            ),
        speak: device.speak.bind(device),
        cancel: device.cancel.bind(device),
      }
    : undefined;
  const local = createStoryAudio({ ...options, synth: filtered });
  let epoch = 0,
    questionId: string | null = null,
    muted = false,
    recording: HTMLAudioElement | null = null,
    url: string | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    dead = false,
    last: { text: string; options: StoryPlayback } | null = null;
  const heard = new Set<string>();
  let state: StoryAudioSnapshot['status'] = 'idle';
  const key = (id: string, option?: string) => `${id}:${option ?? 'cue'}`;
  const recorded = () => profile()?.kind === 'recorded';
  const snapshot = (): StoryAudioSnapshot =>
    recorded()
      ? { status: state, questionId, muted, voice: null, readyKeys: [...heard] }
      : local.snapshot();
  const emit = () => {
    if (!dead) options.onChange?.(snapshot());
  };
  function stopRecording() {
    epoch++;
    if (timer) clearTimeout(timer);
    timer = null;
    recording?.pause();
    recording = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  function cancel() {
    stopRecording();
    local.cancel();
    state = muted ? 'muted' : 'idle';
    emit();
  }
  async function playRecording(cueId: string, opts: StoryPlayback) {
    stopRecording();
    last = { text: cueId, options: opts };
    const token = epoch,
      current = questionId,
      p = profile();
    const valid = () => !dead && epoch === token && current === questionId;
    const fail = () => {
      if (!valid()) return false;
      stopRecording();
      if (opts.questionId) heard.delete(key(opts.questionId, opts.optionId));
      state = 'unavailable';
      emit();
      opts.onFailure?.();
      return false;
    };
    const cue = p?.cues.find((c) => c.cueId === cueId);
    if (
      !opts.gesture ||
      muted ||
      !cue?.assetUrl ||
      !cue.assetDigest ||
      !/^\/story\/[A-Za-z0-9_./-]+$/.test(cue.assetUrl) ||
      cue.assetUrl.split('/').some((s) => s === '.' || s === '..') ||
      (opts.required && opts.questionId !== questionId)
    )
      return fail();
    state = 'loading';
    emit();
    timer = setTimeout(fail, 10000);
    try {
      const response = await fetch(cue.assetUrl, {
        cache: 'force-cache',
        credentials: 'same-origin',
      });
      if (!response.ok) return fail();
      const bytes = await response.arrayBuffer();
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      if (!valid()) return false;
      if (`sha256:${hash}` !== cue.assetDigest) return fail();
      url = URL.createObjectURL(
        new Blob([bytes], {
          type: response.headers.get('content-type') ?? 'audio/mpeg',
        }),
      );
      recording = new Audio(url);
      recording.onplaying = () => {
        if (!valid()) return;
        state = 'playing';
        if (opts.required && opts.questionId)
          heard.add(key(opts.questionId, opts.optionId));
        emit();
        opts.onStart?.();
      };
      recording.onended = () => {
        if (!valid()) return;
        if (timer) clearTimeout(timer);
        timer = null;
        state = 'ended';
        emit();
      };
      recording.onerror = () => {
        fail();
      };
      await recording.play();
      return true;
    } catch {
      return fail();
    }
  }
  function play(cueId: string, opts: StoryPlayback) {
    if (dead) return false;
    if (recorded()) return playRecording(cueId, opts);
    last = { text: cueId, options: opts };
    const declared =
      profile()?.schemaVersion === 'r5-playback-1' &&
      profile()?.kind === 'local-device' &&
      profile()?.cues.some((c) => c.cueId === cueId);
    return local.play(
      profile()?.cues.find((c) => c.cueId === cueId)?.transcript ?? '',
      { ...opts, gesture: opts.gesture && !!declared },
    );
  }
  return {
    snapshot,
    play,
    ready: (id: string, option?: string) =>
      recorded()
        ? id === questionId && heard.has(key(id, option))
        : local.ready(id, option),
    setContext(id: string | null) {
      if (questionId === id) return;
      cancel();
      questionId = id;
      heard.clear();
      last = null;
      local.setContext(id);
      emit();
    },
    cancel,
    setMuted(value: boolean) {
      muted = value;
      heard.clear();
      stopRecording();
      local.setMuted(value);
      state = muted ? 'muted' : 'idle';
      emit();
    },
    replay: () =>
      last ? play(last.text, { ...last.options, gesture: true }) : false,
    destroy() {
      cancel();
      dead = true;
      local.destroy();
    },
  };
}
