import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../../docs/design/readiness/audio.mjs';
function fixture(
  voices = [{ name: 'Test Mandarin', lang: 'zh-CN', localService: true }],
) {
  let last;
  const events = [];
  const jobs = new Map();
  let n = 0;
  const synth = {
    getVoices: () => voices,
    cancel: () => events.push('cancel'),
    speak: (u) => {
      last = u;
      events.push(u.text);
    },
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const a = createAudio({
    synth,
    Utterance,
    onStatus: (s) => events.push(s),
    schedule: (fn) => {
      jobs.set(++n, fn);
      return n;
    },
    unschedule: (id) => jobs.delete(id),
  });
  return {
    a,
    events,
    jobs,
    get last() {
      return last;
    },
  };
}
test('play requires explicit gesture and a Mandarin browser voice', () => {
  const f = fixture();
  assert.equal(f.a.play('木', { gesture: false }), false);
  assert.equal(fixture([]).a.play('木', { gesture: true }), false);
  assert.equal(
    fixture([{ lang: 'en-US' }]).a.play('木', { gesture: true }),
    false,
  );
});
test('started credit only comes from onstart; replay cancels old speech', () => {
  const f = fixture();
  let starts = 0;
  f.a.play('木', { gesture: true, onStart: () => starts++ });
  const old = f.last;
  assert.equal(starts, 0);
  f.a.play('林', { gesture: true, onStart: () => starts++ });
  old.onstart();
  assert.equal(starts, 0);
  f.last.onstart();
  assert.equal(starts, 1);
  assert.equal(f.a.voice().lang, 'zh-CN');
});
test('navigation cancellation invalidates old start, end and error callbacks', () => {
  const f = fixture();
  let starts = 0;
  f.a.play('木', { gesture: true, onStart: () => starts++ });
  const old = f.last;
  f.a.cancel();
  old.onstart();
  old.onerror();
  old.onend();
  assert.equal(starts, 0);
  assert.equal(f.a.status, 'idle');
  assert.equal(f.jobs.size, 0);
});
test('mute cancels and cannot confer audio credit', () => {
  const f = fixture();
  f.a.play('木', { gesture: true });
  f.a.setMuted(true);
  assert.equal(f.a.play('林', { gesture: true }), false);
  assert.equal(f.a.status, 'unavailable');
  f.a.setMuted(false);
  assert.equal(f.a.play('林', { gesture: true }), true);
});
test('timeout and browser error leave usable unavailable status', () => {
  const f = fixture();
  f.a.play('木', { gesture: true });
  [...f.jobs.values()][0]();
  assert.equal(f.a.status, 'unavailable');
  f.a.play('林', { gesture: true });
  f.last.onerror({ error: 'synthesis-failed' });
  assert.equal(f.a.status, 'unavailable');
});
test('rejected speak is unavailable, not successful playback', () => {
  class U {
    constructor(t) {
      this.text = t;
    }
  }
  const a = createAudio({
    synth: {
      getVoices: () => [{ lang: 'zh-CN', localService: true }],
      cancel() {},
      speak() {
        throw Error('rejected');
      },
    },
    Utterance: U,
  });
  assert.equal(a.play('木', { gesture: true }), false);
  assert.equal(a.status, 'unavailable');
});

test('Cantonese and remote Mandarin voices are unavailable', () => {
  assert.equal(
    fixture([{ lang: 'zh-HK', localService: true }]).a.play('木', {
      gesture: true,
    }),
    false,
  );
  assert.equal(
    fixture([{ lang: 'zh-CN', localService: false }]).a.play('木', {
      gesture: true,
    }),
    false,
  );
});
