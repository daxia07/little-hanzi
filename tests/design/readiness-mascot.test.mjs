import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMascot } from '../../docs/design/readiness/mascot.mjs';

// Unit boundary only: DOM import, WAAPI, fetch and timers are declared fakes.
function fixture() {
  let resolve, reject; const animations = []; const timers = new Map(); let tick = 0;
  const media = { matches: false, addEventListener(_, fn) { this.listener = fn; }, removeEventListener() { this.listener = null; } };
  class Element {
    constructor(name = 'div') { this.name = name; this.dataset = {}; this.style = {}; this.children = []; this.hidden = false; }
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    remove() { this.removed = true; }
    addEventListener(name, fn) { this[name] = fn; }
    querySelector(selector) { return this.layers?.[selector] ?? null; }
    querySelectorAll() { return Object.values(this.layers ?? {}); }
    animate(frames, options) { const a = { frames, options, cancel() { this.cancelled = true; }, finished: new Promise(r => { this.finish = r; }) }; animations.push(a); return a; }
  }
  const svg = new Element('svg'); svg.layers = Object.fromEntries(['head', 'arm-left', 'arm-right', 'brows', 'eyes', 'mouth-rest', 'mouth-welcome', 'mouth-hint', 'mouth-encourage', 'eyes-rest', 'eyes-hint', 'eyes-encourage'].map(n => [`[data-layer="${n}"]`, new Element(n)]));
  const win = {
    fetch() { return new Promise((r, j) => { resolve = r; reject = j; }); },
    DOMParser: class { parseFromString() { return { documentElement: svg, querySelector() { return null; } }; } },
    matchMedia() { return media; },
    setTimeout(fn, duration) { timers.set(++tick, { fn, duration }); return tick; }, clearTimeout(id) { timers.delete(id); }
  };
  const document = { defaultView: win, createElement: name => new Element(name), importNode: element => element };
  const host = new Element(); host.ownerDocument = document;
  const statuses = []; const controller = mountMascot(host, { onStatus: s => statuses.push(s) });
  const load = async () => { resolve({ ok: true, text: async () => '<svg/>' }); await new Promise(r => setImmediate(r)); };
  return { host, controller, statuses, svg, animations, timers, media, load, fail: async () => { reject(new Error('missing asset')); await new Promise(r => setImmediate(r)); } };
}

test('immediate controller and accepted static fallback while loading', () => {
  const f = fixture(); assert.equal(typeof f.controller.perform, 'function'); assert.equal(f.host.dataset.motion, 'loading');
  assert.ok(f.host.children[0].children.some(e => e.name === 'img' && e.src.endsWith('capybara-welcome-v6.png')));
  f.controller.destroy();
});
test('all performances use facial and limb animation and finitely return to rest', async () => {
  const f = fixture(); await f.load();
  for (const name of ['welcome', 'hint', 'encourage']) {
    f.controller.perform(name); assert.equal(f.host.dataset.motion, 'playing');
    assert.equal(f.host.dataset.performance, name);
    const current = f.animations.filter(a => !a.cancelled); assert.ok(current.length >= 4);
    assert.ok(current.every(a => a.options.duration <= 1800 && a.options.iterations === 1));
    assert.equal(f.svg.layers[`[data-layer="mouth-${name}"]`].style.display, '');
    [...f.timers.values()].forEach(t => t.fn()); assert.equal(f.host.dataset.motion, 'rest');
    assert.ok(current.every(a => a.cancelled));
  }
  f.controller.destroy();
});
test('quiet during load suppresses art and never reappears when loading finishes', async () => {
  const f = fixture(); f.controller.perform('hint'); f.controller.setMode('quiet'); await f.load();
  assert.equal(f.host.dataset.motion, 'quiet'); assert.equal(f.host.children[0].hidden, true);
  assert.equal(f.animations.length, 0); assert.equal(f.host.dataset.performance, 'rest'); f.controller.destroy();
});
test('destroy during loading prevents callbacks and imported artwork', async () => {
  const f = fixture(); f.controller.destroy(); const statuses = [...f.statuses]; await f.load();
  assert.deepEqual(f.statuses, statuses); assert.equal(f.host.dataset.motion, 'destroyed'); assert.equal(f.host.children.length, 0);
});
test('quiet cancels synchronously and obsolete completion cannot restore acting', async () => {
  const f = fixture(); await f.load(); f.controller.perform('welcome'); const stale = [...f.timers.values()];
  f.controller.setMode('quiet'); assert.ok(f.animations.every(a => a.cancelled)); stale.forEach(t => t.fn());
  assert.equal(f.host.dataset.motion, 'quiet'); f.controller.setMode('teaching'); assert.equal(f.host.dataset.motion, 'rest'); f.controller.destroy();
});
test('system and local reduced motion interrupt acting and preserve static actions', async () => {
  const f = fixture(); await f.load(); f.controller.perform('hint'); f.media.matches = true; f.media.listener({ matches: true });
  assert.equal(f.host.dataset.motion, 'rest'); assert.ok(f.animations.every(a => a.cancelled));
  const count = f.animations.length; f.controller.perform('encourage'); assert.equal(f.animations.length, count);
  f.media.matches = false; f.media.listener({ matches: false }); f.controller.setReducedMotion(true); f.controller.perform('welcome'); assert.equal(f.animations.length, count);
  f.controller.setReducedMotion(false); f.controller.perform('welcome'); assert.ok(f.animations.length > count); f.controller.destroy(); assert.equal(f.media.listener, null);
});
test('asset failure preserves fallback; fallback failure leaves text and quiet remains cue free', async () => {
  const f = fixture(); await f.fail(); assert.equal(f.host.dataset.motion, 'fallback');
  const image = f.host.children[0].children.find(e => e.name === 'img'); image.error(); assert.equal(image.hidden, true);
  assert.ok(f.host.children[0].children.some(e => e.name === 'p' && e.textContent));
  f.controller.setMode('quiet'); assert.equal(f.host.children[0].hidden, true); assert.equal(f.host.dataset.motion, 'quiet'); f.controller.destroy();
});
test('perform before loading is discarded and reduced preference during load survives import', async () => {
  const f = fixture(); f.controller.perform('welcome'); f.controller.setReducedMotion(true); await f.load();
  assert.equal(f.animations.length, 0); assert.equal(f.host.dataset.motion, 'rest'); f.controller.destroy();
});

test('a replaced performance ignores the old finite-rest callback', async () => {
  const f = fixture(); await f.load(); f.controller.perform('welcome');
  const obsolete = [...f.timers.values()]; f.controller.perform('hint');
  obsolete.forEach(t => t.fn()); assert.equal(f.host.dataset.motion, 'playing'); assert.equal(f.host.dataset.performance, 'hint');
  assert.ok([...f.timers.values()].every(t => t.duration <= 1800)); f.controller.destroy();
});
test('current OS preference blocks motion even before its change event is delivered', async () => {
  const f = fixture(); await f.load(); f.media.matches = true; f.controller.perform('welcome');
  assert.equal(f.animations.length, 0); assert.equal(f.host.dataset.motion, 'rest'); f.controller.destroy();
});
test('load rejection after quiet cannot show static artwork', async () => {
  const f = fixture(); f.controller.setMode('quiet'); await f.fail();
  assert.equal(f.host.dataset.motion, 'quiet'); assert.equal(f.host.children[0].hidden, true); f.controller.destroy();
});
