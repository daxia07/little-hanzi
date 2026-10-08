import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotStoryAudio } from '../lib/pilot-story-audio.ts';
const profile = {
  schemaVersion: 'r3-playback-1',
  kind: 'local-device',
  voices: [{ name: 'Tingting', lang: 'zh-CN', localService: true }],
  fallback: 'unavailable',
  cues: [{ id: 'cue', transcript: '木', assetUrl: null, assetDigest: null }],
};
class Utterance {
  constructor(text) {
    this.text = text;
  }
}
function setup(voices) {
  let utterance;
  const controller = createPilotStoryAudio({
    profile: () => profile,
    synth: {
      getVoices: () => voices,
      cancel() {},
      speak: (u) => {
        utterance = u;
      },
    },
    Utterance,
    schedule: () => 1,
    unschedule() {},
  });
  controller.setContext('q');
  return { controller, get: () => utterance };
}
test('ordinary sound requires declared local voice and actual current onstart', () => {
  const h = setup([{ name: 'Tingting', lang: 'zh-CN', localService: true }]);
  void h.controller.play('木', {
    gesture: true,
    required: true,
    questionId: 'q',
  });
  assert.equal(h.controller.ready('q'), false);
  h.get().onstart();
  assert.equal(h.controller.ready('q'), true);
  h.controller.setContext('next');
  h.get().onstart();
  assert.equal(h.controller.ready('q'), false);
});
test('undeclared local Mandarin voice cannot stand in for reviewed profile', () => {
  const h = setup([{ name: 'Other', lang: 'zh-CN', localService: true }]);
  assert.equal(
    h.controller.play('木', { gesture: true, required: true, questionId: 'q' }),
    false,
  );
  assert.equal(h.get(), undefined);
  assert.equal(h.controller.snapshot().status, 'unavailable');
});
test('transcript outside exact inventory cannot play or establish readiness', () => {
  const h = setup([{ name: 'Tingting', lang: 'zh-CN', localService: true }]);
  assert.equal(
    h.controller.play('林', { gesture: true, required: true, questionId: 'q' }),
    false,
  );
  assert.equal(h.get(), undefined);
});
import { createHash } from 'node:crypto';
const bytes = new TextEncoder().encode('synthetic-media');
const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function recordedProbe(wrong = false) {
  const original = { fetch: globalThis.fetch, Audio: globalThis.Audio };
  let element;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
    headers: new Headers({ 'content-type': 'audio/wav' }),
  });
  class FakeAudio {
    constructor() {
      element = this;
    }
    pause() {}
    async play() {}
  }
  globalThis.Audio = FakeAudio;
  const p = {
    schemaVersion: 'r3-playback-1',
    kind: 'recorded',
    voices: [],
    fallback: 'unavailable',
    cues: [
      {
        id: 'wood',
        transcript: '木',
        assetUrl: '/story/test.wav',
        assetDigest: wrong ? 'sha256:' + '0'.repeat(64) : digest,
      },
    ],
  };
  const controller = createPilotStoryAudio({ profile: () => p });
  controller.setContext('q');
  try {
    const success = await controller.play('木', {
      gesture: true,
      questionId: 'q',
      required: true,
    });
    return { success, controller, element };
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.Audio = original.Audio;
  }
}
test('recorded profile verifies bytes and gates only actual playing, then cancels stale callback', async () => {
  const h = await recordedProbe();
  assert.equal(h.success, true);
  assert.equal(h.controller.ready('q'), false);
  h.element.onplaying();
  assert.equal(h.controller.ready('q'), true);
  h.controller.setContext('other');
  h.element.onplaying();
  assert.equal(h.controller.ready('q'), false);
  h.controller.destroy();
});
test('recorded digest mismatch cannot play or establish sound readiness', async () => {
  const h = await recordedProbe(true);
  assert.equal(h.success, false);
  assert.equal(h.element, undefined);
  assert.equal(h.controller.snapshot().status, 'unavailable');
  h.controller.destroy();
});
