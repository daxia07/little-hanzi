import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionAudio } from '../lib/pilot-collection-audio.ts';
import { createPilotStoryAudio } from '../lib/pilot-story-audio.ts';
const profile = {
  schemaVersion: 'r5-playback-1',
  kind: 'local-device',
  voices: [{ name: 'Tingting', lang: 'zh-CN', localService: true }],
  fallback: 'unavailable',
  cues: [
    {
      cueId: 'cue-current',
      readingId: null,
      wordId: null,
      checkId: 'current',
      transcript: '日',
      assetId: 'synthetic-audio',
      assetUrl: null,
      assetDigest: null,
    },
  ],
};
function boundary(factory = createCollectionAudio) {
  const utterances = [],
    timers = [];
  let selected = structuredClone(profile),
    failures = 0,
    starts = 0;
  const synth = {
    getVoices: () => [
      { name: 'Tingting', lang: 'zh-CN', localService: true },
      { name: 'remote', lang: 'zh-CN', localService: false },
    ],
    speak: (u) => utterances.push(u),
    cancel() {},
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const audio = factory({
    profile: () => selected,
    synth,
    Utterance,
    schedule: (fn) => {
      timers.push(fn);
      return fn;
    },
    unschedule() {},
  });
  audio.setContext('occurrence');
  return {
    audio,
    utterances,
    timers,
    get profile() {
      return selected;
    },
    set profile(v) {
      selected = v;
    },
    get failures() {
      return failures;
    },
    get starts() {
      return starts;
    },
    play: () =>
      audio.play('cue-current', {
        gesture: true,
        required: true,
        questionId: 'occurrence',
        onFailure: () => failures++,
        onStart: () => starts++,
      }),
  };
}
test('separate paired audio accepts cue IDs without broadening the frozen V4 adapter', async () => {
  const h = boundary(
    process.env.COLLECTION_AUDIO_BASELINE === 'v4'
      ? createPilotStoryAudio
      : createCollectionAudio,
  );
  assert.equal(await h.play(), true);
  assert.equal(h.utterances[0].text, '日');
  assert.equal(h.utterances[0].voice.localService, true);
  h.audio.destroy();
});
test('actual onstart alone gates heard readiness; play return and loading do not', async () => {
  const h = boundary();
  await h.play();
  assert.equal(h.audio.ready('occurrence'), false);
  assert.equal(h.audio.snapshot().status, 'loading');
  h.utterances[0].onstart();
  assert.equal(h.audio.ready('occurrence'), true);
  assert.equal(h.starts, 1);
  h.utterances[0].onerror();
  assert.equal(h.audio.ready('occurrence'), false);
  assert.equal(h.failures, 1);
  assert.equal(h.audio.snapshot().status, 'unavailable');
  h.audio.destroy();
});
test('empty approved voice list and undeclared cue stay unavailable; no remote fallback', async () => {
  const h = boundary();
  h.profile.voices = [];
  assert.equal(await h.play(), false);
  assert.equal(h.utterances.length, 0);
  assert.equal(h.failures, 1);
  h.profile = structuredClone(profile);
  assert.equal(await h.audio.play('future-cue', { gesture: true }), false);
  assert.equal(h.utterances.length, 0);
  h.audio.destroy();
});
test('account/question cancellation refuses late speech onstart/error and timeout callbacks', async () => {
  const h = boundary();
  await h.play();
  const u = h.utterances[0];
  h.audio.setContext('another');
  u.onstart();
  u.onerror();
  h.timers[0]();
  assert.equal(h.audio.ready('another'), false);
  assert.equal(h.starts, 0);
  assert.equal(h.failures, 0);
  h.audio.destroy();
  assert.equal(await h.play(), false);
});
test('recorded playback refuses API paths before any network request', async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('must not fetch');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const h = boundary();
  h.profile = {
    ...structuredClone(profile),
    kind: 'recorded',
    voices: [],
    cues: [
      {
        ...profile.cues[0],
        assetUrl: '/api/pilot/me',
        assetDigest: 'sha256:' + '0'.repeat(64),
      },
    ],
  };
  assert.equal(await h.play(), false);
  assert.equal(calls, 0);
  h.audio.destroy();
});
