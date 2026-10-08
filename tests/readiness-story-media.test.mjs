import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryAudio, selectStoryVoice } from '../lib/story-audio.ts';
import { storyChoices, storyQuestion } from '../lib/story-presentation.ts';
function fixture() {
  let last;
  const tasks = new Map();
  let i = 0;
  const synth = {
    getVoices: () => [{ name: 'Tingting', lang: 'zh-CN', localService: true }],
    cancel() {},
    speak(u) {
      last = u;
    },
  };
  class U {
    constructor(t) {
      this.text = t;
    }
  }
  const audio = createStoryAudio({
    synth,
    Utterance: U,
    schedule: (fn) => {
      tasks.set(++i, fn);
      return i;
    },
    unschedule: (id) => tasks.delete(id),
  });
  return {
    audio,
    tasks,
    get last() {
      return last;
    },
  };
}
test('only local Mandarin voice qualifies, with Tingting preference', () => {
  assert.equal(
    selectStoryVoice([
      { name: 'Remote', lang: 'zh-CN', localService: false },
      { name: 'Cantonese', lang: 'zh-HK', localService: true },
    ]),
    null,
  );
  assert.equal(
    selectStoryVoice([
      { name: 'Other', lang: 'zh-TW', localService: true, default: true },
      { name: 'Tingting', lang: 'zh-CN', localService: true },
    ]).name,
    'Tingting',
  );
});
test('returned speak does not unlock choices; only active question onstart does', () => {
  const f = fixture();
  f.audio.setContext('check-mu-reading');
  f.audio.play('木', {
    gesture: true,
    questionId: 'check-mu-reading',
    optionId: 'audio-mu',
    required: true,
  });
  assert.equal(f.audio.ready('check-mu-reading', 'audio-mu'), false);
  f.last.onstart();
  assert.equal(f.audio.ready('check-mu-reading', 'audio-mu'), true);
  assert.equal(f.audio.ready('check-mu-reading', 'audio-lin'), false);
  f.audio.setContext('check-lin-reading');
  f.last.onstart();
  assert.equal(f.audio.ready('check-lin-reading', 'audio-mu'), false);
});
test('same-question error clears readiness and signals failure; navigation/mute cancels stale callbacks', () => {
  const f = fixture();
  let failures = 0;
  f.audio.setContext('fam-mu');
  f.audio.play('木头的木', {
    gesture: true,
    questionId: 'fam-mu',
    required: true,
    onFailure: () => failures++,
  });
  f.last.onstart();
  f.last.onerror();
  assert.equal(f.audio.ready('fam-mu'), false);
  assert.equal(failures, 1);
  f.audio.play('木', {
    gesture: true,
    questionId: 'fam-mu',
    required: true,
    onFailure: () => failures++,
  });
  const old = f.last;
  f.audio.setMuted(true);
  old.onstart();
  old.onerror();
  assert.equal(failures, 1);
  assert.equal(f.audio.ready('fam-mu'), false);
});
test('bounded timeout signals unavailable and optional narration cannot confer question readiness', () => {
  const f = fixture();
  let failed = 0;
  f.audio.setContext('find-mu');
  f.audio.play('木', {
    gesture: true,
    required: false,
    onFailure: () => failed++,
  });
  f.last.onstart();
  assert.equal(f.audio.ready('find-mu'), false);
  [...f.tasks.values()][0]();
  assert.equal(failed, 1);
  assert.equal(f.audio.snapshot().status, 'unavailable');
});
test('safe choice metadata uses seeded positions and contains no correctness or scoring keys', () => {
  assert.deepEqual(storyChoices('check-mu-reading', 17), [
    'audio-ren',
    'audio-mu',
    'audio-lin',
  ]);
  const q = storyQuestion('check-mu-reading');
  assert.equal('correctChoiceId' in q, false);
  assert.equal('answer' in q, false);
  assert.equal('score' in q, false);
});

test('versioned rig exposes finite focused, Aha and Delighted acting with separate face layers', async () => {
  const { readFile } = await import('node:fs/promises');
  const { mountMascot } =
    await import('../public/story/forest-01-v3/mascot.mjs');
  const svgSource = await readFile(
    new URL('../public/story/forest-01-v3/mascot-layered.svg', import.meta.url),
    'utf8',
  );
  const layers = new Map();
  const animations = [],
    jobs = [];
  const svg = {
    style: {},
    querySelector(selector) {
      const name = selector.match(/"([^"]+)"/)[1];
      if (!svgSource.includes(`data-layer="${name}"`)) return null;
      if (!layers.has(name))
        layers.set(name, {
          style: {},
          animate(frames, options) {
            const a = {
              options,
              cancel() {
                this.cancelled = true;
              },
              finished: Promise.resolve(),
            };
            animations.push(a);
            return a;
          },
        });
      return layers.get(name);
    },
  };
  const doc = {
    createElement: () => ({
      style: {},
      append() {},
      replaceChildren() {},
      addEventListener() {},
    }),
    importNode: () => svg,
    defaultView: {
      matchMedia: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
      setTimeout: (fn, ms) => {
        jobs.push({ fn, ms });
        return jobs.length;
      },
      clearTimeout() {},
      fetch: async () => ({ ok: true, text: async () => svgSource }),
      DOMParser: class {
        parseFromString() {
          return { documentElement: svg, querySelector: () => null };
        }
      },
    },
  };
  const host = { ownerDocument: doc, dataset: {}, replaceChildren() {} };
  const mascot = mountMascot(host, {});
  await new Promise((r) => setImmediate(r));
  for (const name of ['focused', 'aha', 'delighted']) {
    mascot.perform(name);
    assert.equal(host.dataset.motion, 'playing');
    assert.equal(host.dataset.performance, name);
    assert.equal(layers.get(`mouth-${name}`).style.display, '');
    assert.ok(
      animations
        .slice(-5)
        .every((a) => a.options.duration <= 1800 && a.options.iterations === 1),
    );
    jobs.at(-1).fn();
    assert.equal(host.dataset.motion, 'rest');
  }
  mascot.destroy();
});

test('review manifest canonical digest, exact assets and pending human review are honest', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const manifest = JSON.parse(
    await readFile(
      new URL('../content/story/forest-01-v3.json', import.meta.url),
      'utf8',
    ),
  );
  const { digest, ...body } = manifest;
  const sorted = (v) =>
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? v.map(sorted)
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
      : v;
  assert.equal(
    digest,
    `sha256:${createHash('sha256')
      .update(JSON.stringify(sorted(body)))
      .digest('hex')}`,
  );
  assert.deepEqual(manifest.targets, ['木', '林']);
  assert.equal(manifest.adapter.id, 'forest-story-preview-v1');
  assert.equal(manifest.humanReview.status, 'pending');
  assert.equal(manifest.humanReview.reviewer, null);
  assert.equal(manifest.humanReview.date, null);
  assert.equal(manifest.humanReview.evidence, null);
  assert.ok(manifest.audio.lines.some((l) => l.text === '这是木头。'));
  assert.ok(manifest.audio.lines.some((l) => l.text === '小鸟住在树林里。'));
  assert.ok(
    manifest.audio.lines.every(
      (l) => l.review.status === 'pending' && l.review.reviewer === null,
    ),
  );
  for (const a of manifest.assets) {
    if (a.file) {
      const bytes = await readFile(new URL(`../${a.file}`, import.meta.url));
      assert.equal(a.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
  }
  assert.deepEqual(
    JSON.parse(
      await readFile(
        new URL(
          '../public/story/forest-01-v3/review-manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
    manifest,
  );
});
