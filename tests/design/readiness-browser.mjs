/** Independent R1 browser checks. No application imports or existing browser tabs.
 * node tests/design/readiness-browser.mjs /absolute/path/to/frozen-handoff.json
 * Execution requires a frozen, owned design snapshot/server. See case document.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';

const arg = process.argv[2];
if (!arg) throw new Error('Frozen handoff JSON required; no default family URL or workspace server.');
const handoff = JSON.parse(await readFile(arg, 'utf8'));
assert.equal(handoff.specVersion, 'r1-ears-2');
assert.match(handoff.sourceDigest, /^[a-f0-9]{64}$/);
assert.equal(handoff.frozen, true);
assert.equal(handoff.runnerOwnedServer, true);
const root = await realpath(handoff.staticRoot);
const temp = await realpath(os.tmpdir());
assert(root.startsWith(`${temp}${path.sep}`), 'Static root must be a temporary frozen design snapshot');
const base = new URL(handoff.baseUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
assert(base.pathname.endsWith('/readiness/index.html'), 'Use R1 artifact entry, not old storyboard');
assert(Array.isArray(handoff.declaredRequests));
assert(handoff.controls && typeof handoff.controls === 'object', 'Public labels must be handed off');
// Normalize the implementation's explicit public selector handoff, not private state.
const publicMap = handoff.controls;
const labels = { ...publicMap,
 next: publicMap.primary, soundFailed: publicMap.soundUnavailable, parentSignOut: publicMap.signOut,
 childSignIn: publicMap.signIn, simulatedSignIn: publicMap.expiredSignIn, questionCue: publicMap.cue,
 audioRetry: publicMap.retry, audioContinue: publicMap.primary, saveRetry: publicMap.retrySave,
 performanceWelcome: publicMap.welcomePerformance, performanceHint: publicMap.hintPerformance,
 performanceEncourage: publicMap.encouragePerformance, unsureValue: 'unsure',
 placeMuALeft: {selector: '[data-piece-id="mu-a"][data-slot="left"]'},
 placeMuBRight: {selector: '[data-piece-id="mu-b"][data-slot="right"]'},
 finalEvidence: {selector: '[data-evidence-group="final"]'},
 independentCount: {selector: '[data-category="independentCorrect"]'},
 supportedCount: {selector: '[data-category="supported"]'}, unavailableCount: {selector: '[data-category="unavailable"]'},
};
const output = path.resolve(handoff.outputDir);
assert(output.includes(`${path.sep}outputs${path.sep}design${path.sep}`));
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const report = { specVersion: handoff.specVersion, sourceDigest: handoff.sourceDigest,
  browser: browser.version(), baseUrl: base.href, speech: 'Injected browser speech start/end/error/cancel; no pronunciation or physical-device evidence',
  results: [], pending: ['Physical iPad', 'Mandarin review', 'Animation fidelity/friendliness', 'Exact artifact owner acceptance', 'Real lesson/API/database integration'] };

// Overrides only the declared browser speech boundary, never the application.
function speechBoundary() {
  const state = { mode: 'normal', active: [], started: [], cancelled: 0, completed: [], language: [], utterances: [] };
  window.__r1Speech = state;
  class Utterance {
    constructor(text) { this.text = text; this.lang = ''; this.listeners = new Map(); }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x !== fn)); }
    dispatchEvent(event) { this[`on${event.type}`]?.(event); for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
  }
  const emit = (u, type, error) => u.dispatchEvent({ type, error, utterance: u });
  state.fail = index => emit(state.utterances[index], 'error', 'synthesis-failed');
  const synth = {
    getVoices: () => state.mode === 'missing' ? [] : state.mode === 'remote' ? [{name:'QA remote Mandarin rejected',lang:'zh-CN',localService:false}] : state.mode === 'cantonese' ? [{name:'QA Cantonese rejected',lang:'zh-HK',localService:true}] : [{ name: 'QA injected Mandarin voice', lang: 'zh-CN', localService: true, default: true, voiceURI: 'qa-injected' }],
    addEventListener() {}, removeEventListener() {},
    cancel() { state.cancelled++; for (const u of state.active.splice(0)) emit(u, 'error', 'canceled'); },
    speak(u) {
      state.utterances.push(u); state.language.push(u.lang);
      if (state.mode === 'throw') throw new Error('QA rejected speech');
      if (state.mode === 'error') { queueMicrotask(() => emit(u, 'error', 'audio-busy')); return; }
      state.active.push(u);
      queueMicrotask(() => {
        if (!state.active.includes(u) || state.mode === 'timeout') return;
        state.started.push(u.text); emit(u, 'start');
        if (state.mode === 'hold') return;
        setTimeout(() => {
          if (!state.active.includes(u)) return;
          state.active = state.active.filter(x => x !== u); state.completed.push(u.text); emit(u, 'end');
        }, 25);
      });
    },
    get speaking() { return state.active.length > 0; }, get pending() { return state.active.length > 0; }, get paused() { return false; },
  };
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  // Observe persistent writes without replacing app logic or suppressing writes.
  window.__r1Writes = [];
  const record = (name, object, method) => {
    if (!object?.[method]) return;
    const original = object[method];
    object[method] = function (...args) { window.__r1Writes.push(name); return original.apply(this, args); };
  };
  for (const method of ['setItem', 'removeItem', 'clear']) record(`Storage.${method}`, Storage.prototype, method);
  for (const method of ['open', 'deleteDatabase']) record(`indexedDB.${method}`, indexedDB, method);
  record('caches.open', window.caches, 'open');
  record('serviceWorker.register', navigator.serviceWorker, 'register');
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookie?.set) Object.defineProperty(Document.prototype, 'cookie', { ...cookie, set(value) { window.__r1Writes.push('cookie'); return cookie.set.call(this, value); } });
}

async function scenario(name, ids, callback, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 900 }, reducedMotion: options.reducedMotion || 'no-preference' });
  context.setDefaultTimeout(6000); context.setDefaultNavigationTimeout(15000);
  const requests = [], violations = [], errors = [];
  await context.addInitScript(speechBoundary);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    const entry = { method: req.method(), pathname: url.pathname, origin: url.origin };
    requests.push(entry);
    const allowed = url.origin === base.origin && ['GET', 'HEAD'].includes(req.method()) && handoff.declaredRequests.includes(url.pathname);
    if (!allowed) { violations.push(entry); return route.abort('blockedbyclient'); }
    if ((options.failSvg && url.pathname.endsWith('/mascot-layered.svg')) || (options.failRaster && url.pathname.endsWith('/capybara-welcome-v6.png'))) return route.fulfill({ status: 404, body: 'QA asset failure' });
    return route.continue();
  });
  const step = () => page.locator('[data-step]').filter({ visible: true });
  const control = key => {
    assert(labels[key], `Missing public label handoff: ${key}`);
    return labels[key].selector ? page.locator(labels[key].selector) : page.getByRole(labels[key].role || 'button', { name: labels[key].name, exact: true });
  };
  const click = async key => { await control(key).click(); };
  const at = async id => { await page.locator(`[data-step="${id}"]`).waitFor({ state: 'visible' }); };
  const current = async () => step().getAttribute('data-step');
  const reviewTools = async () => { if (!(await page.locator('#review-tools').evaluate(e => e.open))) await page.locator('#review-tools > summary').click(); };
  const select = async value => { await reviewTools(); await control('scenario').selectOption(value); };
  const next = async () => click('next');
  const until = async target => {
    for (let i = 0; i < 20; i++) { if (await current() === target) return; await next(); }
    throw new Error(`Did not reach ${target}`);
  };
  const enterStory = async () => {
    await at('parent-setup'); await click('soundHeard'); await next(); await at('parent-plan');
    await click('confirmPlan'); await next(); await click('parentSignOut'); await click('childSignIn');
    await at('child-home'); await next(); await at('welcome'); await next(); await at('familiarity');
  };
  const question = id => page.locator(`[data-question-id="${id}"]`);
  const choose = async (id, choice) => { await question(id).locator(`[data-choice-id="${choice}"]`).click(); };
  const cue = async id => {
    const started = await page.evaluate(() => window.__r1Speech.started.length);
    await question(id).locator(labels.questionCue.selector).click();
    await page.waitForFunction(n => window.__r1Speech.started.length > n, started);
  };
  const reading = async (id, choice) => {
    const started = await page.evaluate(() => window.__r1Speech.started.length);
    await question(id).locator(`[data-control="option-play"][data-option-id="${choice}"]`).click();
    await page.waitForFunction(n => window.__r1Speech.started.length > n, started);
    await choose(id, choice);
  };
  const answer = async (id, choice) => {
    if (choice.startsWith('audio-') && choice !== 'audio-unavailable') return reading(id, choice);
    if (choice === 'audio-unavailable') return click('unavailable');
    if (!id.startsWith('find-')) await cue(id);
    await choose(id, choice);
  };
  const familiarity = async (muFirst, linFirst) => {
    await at('familiarity');
    await answer('fam-mu', muFirst); if (muFirst !== 'mu') await answer('fam-mu', 'mu'); await next();
    await answer('fam-lin', linFirst); if (linFirst !== 'lin') await answer('fam-lin', 'lin'); await next();
  };
  const build = async () => {
    await at('build'); await click('placeMuALeft');
    assert(await control('next').isDisabled(), 'One piece must not complete build');
    await click('placeMuBRight'); await next();
  };
  const activity = async () => {
    await build(); await answer('find-mu', 'mu'); await next(); await answer('find-lin', 'lin'); await next();
    await at('read'); assert.match(await step().innerText(), /这是木头。/); await next();
    assert.match(await step().innerText(), /小鸟住在树林里。/); await next(); await at('check');
  };
  const finals = async helped => {
    if (helped) { await answer('check-mu-sound', 'lin'); await answer('check-mu-sound', 'ren'); }
    else await answer('check-mu-sound', 'mu');
    await next(); await answer('check-lin-sound', 'lin'); await next();
    if (helped) await click('help');
    await answer('check-mu-reading', 'audio-mu'); await next();
    await answer('check-lin-reading', helped ? 'audio-unavailable' : 'audio-lin'); await next();
    await at('finish'); await until('parent-recap');
  };
  const evidence = async (independent, supported, unavailable) => {
    const scope = page.locator(labels.finalEvidence.selector);
    for (const [name, number] of Object.entries({ independent, supported, unavailable }))
      assert.equal((await scope.locator(labels[`${name}Count`].selector).innerText()).trim(), String(number), `${name} final count`);
  };
  try {
    await page.goto(base.href);
    await callback({ page, context, step, control, click, at, current, select, reviewTools, next, until, enterStory, question, choose, cue, answer, familiarity, build, activity, finals, evidence });
    const visible = await page.locator('body').innerText();
    assert.match(visible, /Design preview · sample data · nothing is saved/);
    assert.deepEqual(violations, [], 'Undeclared/network mutation request');
    assert.deepEqual(await page.evaluate(() => window.__r1Writes), [], 'Persistent storage write');
    assert.deepEqual(await context.cookies(), [], 'Cookie written');
    assert.deepEqual(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, db: (await indexedDB.databases()).length, cache: (await caches.keys()).length })), { local: 0, session: 0, db: 0, cache: 0 });
    assert.deepEqual(errors, [], 'Unhandled browser error');
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    report.results.push({ name, ids, status: 'PASS', requests }); console.log(`${name}: PASS`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    report.results.push({ name, ids, status: 'FAIL', error: error.stack, requests, violations, errors }); console.log(`${name}: FAIL ${error.message}`);
  } finally { await context.close(); } // Never close the attached browser or another context.
}

try {
  await scenario('setup-handover', ['R1-T01', 'R1-T02', 'R1-E-001', 'R1-E-002', 'R1-E-003', 'R1-E-004'], async h => {
    await h.at('parent-setup'); assert.equal(await h.control('nickname').inputValue(), 'Learner');
    assert.equal(await h.control('experience').inputValue(), labels.unsureValue);
    assert.equal(await h.control('soundHeard').isChecked(), false); assert.equal(await h.control('soundFailed').isChecked(), false);
    await h.control('nickname').fill('  QA Learner  '); await h.click('next'); await h.at('parent-setup');
    assert.equal(await h.control('nickname').inputValue(), '  QA Learner  ');
    await h.click('soundHeard'); await h.next(); await h.at('parent-plan');
    assert.match(await h.step().innerText(), /8.?10/); assert.match(await h.step().innerText(), /24/);
    assert.equal(await h.control('confirmPlan').isChecked(), false); await h.next(); await h.at('parent-plan');
    await h.click('confirmPlan'); await h.next(); await h.at('handover');
    assert.equal(await h.page.locator('input[type=password]').count(), 0);
    await h.click('parentSignOut'); await h.click('childSignIn'); await h.at('child-home');
  });
  for (const [route, mu, lin, helped] of [['new', 'lin', 'mu', false], ['mixed-mu', 'mu', 'mu', false], ['mixed-lin', 'lin', 'lin', false], ['familiar', 'mu', 'lin', false], ['needs-help', 'lin', 'mu', true]]) {
    await scenario(`journey-${route}`, ['R1-T03', 'R1-T04', 'R1-T05', 'R1-T06', 'R1-E-005', 'R1-E-006', 'R1-E-007'], async h => {
      await h.select(route); await h.enterStory(); await h.familiarity(mu, lin);
      // Count actual reminder/introduction screens, not only a route attribute.
      const observedTargets = new Map(); let panels = 0;
      while (await h.current() === 'learn') {
        panels++;
        for (const item of await h.page.locator('[data-target][data-learning-mode]').all()) {
          observedTargets.set(await item.getAttribute('data-target'), await item.getAttribute('data-learning-mode'));
        }
        assert(panels <= 2, 'Unexpected extra learning panel'); await h.next();
      }
      assert.equal(panels, route === 'familiar' ? 1 : 2, 'Familiar route must be visibly shorter');
      assert.deepEqual(Object.fromEntries(observedTargets), { mu: mu === 'mu' ? 'reminder' : 'introduction', lin: lin === 'lin' ? 'reminder' : 'introduction' });
      await h.at('build'); await h.activity(); await h.finals(helped);
      await h.evidence(helped ? 1 : 4, helped ? 2 : 0, helped ? 1 : 0);
      assert.doesNotMatch(await h.step().innerText(), /you (?:have )?(?:mastered|are fluent)|independently read (?:the|a) sentence/i);
      await h.page.reload(); await h.at('parent-setup');
    });
  }
  await scenario('finite-layered-performances', ['R1-T07', 'R1-E-008'], async h => {
    await h.select('resume'); await h.page.locator('[data-motion=rest]').waitFor();
    for (const [key, name] of [['performanceWelcome', 'welcome'], ['performanceHint', 'hint'], ['performanceEncourage', 'encourage']]) {
      const began = Date.now(); await h.click(key);
      await h.page.locator(`[data-motion="playing"][data-performance="${name}"]`).waitFor();
      const parts = await h.page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').map(a => a.effect.target.getAttribute('data-layer')));
      assert(parts.includes('arm-left') && parts.includes('arm-right') && parts.includes('brows') && parts.includes('eyes'), 'Actual face and limb animations');
      assert(await h.page.locator(`[data-layer="mouth-${name}"]`).isVisible(), 'Distinct facial state visible');
      await h.page.locator('[data-motion=rest]').waitFor({ timeout: 1900 });
      assert(Date.now() - began <= 2100, '1800ms contract plus bounded runner scheduling tolerance');
      assert.equal(await h.page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length), 0);
    }
  });
  await scenario('long-nickname-phone', ['R1-T16', 'R1-E-015'], async h => {
    await h.control('nickname').fill('W'.repeat(40)); await h.click('soundHeard'); await h.next(); await h.at('parent-plan');
    const noOverflow = async () => assert(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '40-character nickname must not create horizontal page overflow');
    await noOverflow(); await h.click('confirmPlan'); await h.next(); await h.click('parentSignOut'); await h.click('childSignIn'); await h.at('child-home'); await noOverflow();
  }, { viewport: { width: 390, height: 844 } });
  await scenario('requested-help-does-not-consume-wrong-attempt', ['R1-T06', 'R1-E-006'], async h => {
    await h.select('resume'); await h.activity(); await h.click('help');
    assert.equal(await h.question('check-mu-sound').locator('[data-help-level]').getAttribute('data-help-level'), '1');
    await h.answer('check-mu-sound', 'lin');
    assert.equal(await h.question('check-mu-sound').locator('[data-help-level]').getAttribute('data-help-level'), '1');
    assert.equal(await h.question('check-mu-sound').locator('[data-choice-id="ren"]').count(), 1, 'First wrong still offers retry');
    await h.answer('check-mu-sound', 'ren');
    assert.equal(await h.question('check-mu-sound').locator('[data-help-level]').getAttribute('data-help-level'), '2');
    await h.next(); await h.answer('check-lin-sound', 'lin'); await h.next();
    await h.answer('check-mu-reading', 'audio-mu'); await h.next(); await h.answer('check-lin-reading', 'audio-lin'); await h.next(); await h.until('parent-recap');
    await h.evidence(3, 1, 0);
    assert.match(await h.page.locator('[data-record-id="check-mu-sound"]').innerText(), /First response: 林.*attempts: 2.*extra help: yes.*demonstrated/s);
  });
  await scenario('quiet-race', ['R1-T08', 'R1-T09', 'R1-E-009', 'R1-E-010', 'R1-E-012'], async h => {
    await h.select('resume'); await h.at('build');
    await h.page.locator('[data-motion=rest]').waitFor();
    await h.click('performanceHint'); assert.equal(await h.page.locator('[data-motion=playing]').count(), 1); await h.click('performanceEncourage');
    await h.activity();
    const scope = h.question('check-mu-sound');
    assert.equal(await scope.locator('[data-motion="playing"]').count(), 0);
    assert.equal(await scope.locator('[data-teaching-art]').count(), 0);
    assert.doesNotMatch(await scope.innerText(), /木头的木|树林的林|mù|lín|tree|grove/i);
    const visibleText = await h.page.locator('body').innerText();
    assert.doesNotMatch(visibleText, /木头的木|树林的林|Expected categories|capybara|held.object|mù|lín/i);
    assert.equal(await h.page.locator('#transcript-sheet').isVisible(), false);
    assert.equal(await h.page.locator('.companion').filter({ visible: true }).count(), 0);
    assert.equal(await h.page.locator('#motion-setting').isVisible(), false);
    assert.equal(await h.page.locator('.brand-mark').isVisible(), false);
    await h.page.waitForTimeout(1900); // Deliberate obsolete-callback observation beyond contract's 1800 ms bound.
    assert.equal(await h.page.locator('[data-motion="playing"]').count(), 0);
    await h.page.evaluate(() => { window.__r1Speech.mode = 'hold'; }); await h.cue('check-mu-sound');
    await h.select('pending-save'); assert.equal(await h.page.evaluate(() => window.__r1Speech.active.length), 0);
  });
  for (const system of [true, false]) await scenario(`reduced-${system ? 'system' : 'toggle'}`, ['R1-T10', 'R1-E-016'], async h => {
    await h.select('resume'); await h.at('build');
    await h.page.locator('[data-motion=rest]').waitFor();
    if (!system) { await h.click('performanceWelcome'); assert.equal(await h.page.locator('[data-motion=playing]').count(), 1); await h.reviewTools(); await h.click('reduceMotion'); }
    await h.click('performanceHint');
    assert.equal(await h.page.locator('[data-motion="playing"]').count(), 0);
    assert.equal(await h.page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length), 0);
    await h.activity();
  }, { reducedMotion: system ? 'reduce' : 'no-preference' });
  await scenario('asset-fallback', ['R1-T11', 'R1-E-011'], async h => {
    await h.select('resume'); await h.at('build');
    await h.page.locator('[data-motion="fallback"]').waitFor();
    await h.activity();
  }, { failSvg: true });
  await scenario('speech-failure-mute', ['R1-T12', 'R1-T13', 'R1-E-012', 'R1-E-013'], async h => {
    await h.select('new'); await h.enterStory();
    await h.page.evaluate(() => { window.__r1Speech.mode = 'hold'; }); await h.cue('fam-mu');
    await h.click('mute'); assert.equal(await h.page.evaluate(() => window.__r1Speech.active.length), 0);
    await h.click('mute'); await h.page.evaluate(() => { window.__r1Speech.mode = 'error'; });
    await h.question('fam-mu').locator(labels.questionCue.selector).click();
    await h.control('audioRetry').waitFor({ state: 'visible' });
    await h.click('audioContinue');
    assert.equal(await h.page.locator('[data-question-id="fam-lin"]').count(), 1);
  });
  await scenario('speech-replay-and-live-system-preference', ['R1-T09', 'R1-T10', 'R1-T12', 'R1-E-010', 'R1-E-012', 'R1-E-016'], async h => {
    await h.select('resume'); await h.page.locator('[data-motion=rest]').waitFor();
    await h.click('performanceWelcome'); assert.equal(await h.page.locator('[data-motion=playing]').count(), 1);
    await h.page.evaluate(() => { window.__r1MediaDelivered = false; matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e => { if (e.matches) window.__r1MediaDelivered = true; }, {once:true}); });
    await h.page.emulateMedia({ reducedMotion: 'reduce' });
    await h.page.waitForFunction(() => window.__r1MediaDelivered && document.documentElement.dataset.reducedMotion === 'true', null, {timeout:1000});
    assert.equal(await h.page.locator('[data-motion=playing]').count(), 0);
    await h.page.emulateMedia({ reducedMotion: 'no-preference' });
    await h.activity(); await h.page.evaluate(() => { window.__r1Speech.mode = 'hold'; });
    await h.cue('check-mu-sound'); const began = await h.page.evaluate(() => window.__r1Speech.started.length);
    await h.click('replay'); await h.page.waitForFunction(n => window.__r1Speech.started.length > n, began);
    assert.equal(await h.page.evaluate(() => window.__r1Speech.active.length), 1);
    await h.reviewTools(); await h.click('reset'); assert.equal(await h.page.evaluate(() => window.__r1Speech.active.length), 0);
  });
  for (const mode of ['missing', 'remote', 'cantonese', 'throw', 'timeout']) await scenario(`speech-unavailable-${mode}`, ['R1-T13', 'R1-E-013'], async h => {
    await h.select('new'); await h.enterStory(); await h.page.evaluate(value => { window.__r1Speech.mode = value; }, mode);
    await h.question('fam-mu').locator(labels.questionCue.selector).click();
    await h.question('fam-mu').getByText('This question is unavailable.', { exact: false }).waitFor({ timeout: 12000 });
    assert.equal(await h.page.evaluate(() => window.__r1Speech.started.length), 0);
    await h.next(); await h.answer('fam-lin', 'audio-unavailable'); await h.next();
    assert.equal(await h.page.locator('[data-target="mu"]').getAttribute('data-learning-mode'), 'introduction');
  });
  await scenario('both-art-assets-fail', ['R1-T11', 'R1-E-011'], async h => {
    await h.select('resume'); await h.at('build'); await h.page.locator('[data-motion=fallback]').waitFor();
    assert.match(await h.page.locator('.mascot-art').innerText(), /Follow the activity instructions/);
    await h.activity();
  }, { failSvg: true, failRaster: true });
  await scenario('post-answer-error-and-stale-navigation', ['R1-T13', 'R1-E-007', 'R1-E-010', 'R1-E-013'], async h => {
    await h.select('resume'); await h.activity();
    await h.page.evaluate(() => { window.__r1Speech.mode = 'hold'; });
    await h.cue('check-mu-sound'); await h.choose('check-mu-sound', 'mu');
    const firstUtterance = await h.page.evaluate(() => window.__r1Speech.utterances.length - 1);
    await h.page.evaluate(i => window.__r1Speech.fail(i), firstUtterance);
    await h.question('check-mu-sound').getByText('This question is unavailable.', { exact: false }).waitFor();
    await h.next(); await h.answer('check-lin-sound', 'lin');
    const staleUtterance = await h.page.evaluate(() => window.__r1Speech.utterances.length - 1);
    await h.next(); // Navigation cancels and invalidates the previous sound callbacks.
    await h.page.evaluate(i => window.__r1Speech.fail(i), staleUtterance);
    await h.page.evaluate(() => { window.__r1Speech.mode = 'normal'; });
    await h.answer('check-mu-reading', 'audio-mu'); await h.next();
    await h.answer('check-lin-reading', 'audio-lin'); await h.next(); await h.until('parent-recap');
    await h.evidence(3, 0, 1);
    assert.match(await h.page.locator('[data-record-id="check-mu-sound"]').innerText(), /First response: 木.*attempts: 1.*unavailable/s);
    assert.match(await h.page.locator('[data-record-id="check-lin-sound"]').innerText(), /First response: 林.*attempts: 1.*answered/s);
  });
  await scenario('recovery-examples', ['R1-T02', 'R1-T14', 'R1-E-014'], async h => {
    await h.select('resume'); await h.at('build'); assert.match(await h.step().innerText(), /preset|synthetic/i);
    await h.select('due'); await h.until('delayed-review'); await h.answer('review-mu-sound', 'mu'); await h.next(); await h.answer('review-lin-sound', 'lin'); await h.next();
    await h.select('not-due'); assert.match(await h.step().innerText(), /23|not due/i);
    await h.select('unavailable-lesson'); await h.click('soundHeard'); await h.next(); await h.at('parent-plan'); assert.equal(await h.control('next').count(), 0);
    await h.select('pending-save'); await h.at('pending-save'); await h.click('saveRetry'); assert.match(await h.step().innerText(), /Sample retry complete; nothing saved/);
    await h.select('session-expired'); await h.at('session-expired'); assert.equal(await h.page.locator(labels.finalEvidence.selector).count(), 0);
    await h.click('simulatedSignIn'); assert.notEqual(await h.current(), 'session-expired');
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await scenario(`viewport-${viewport.width}x${viewport.height}`, ['R1-T15', 'R1-T16', 'R1-E-015'], async h => {
      await h.select('resume'); await h.at('build');
      await h.page.locator('.skip').focus(); await h.page.keyboard.press('Tab'); await h.page.keyboard.press('Shift+Tab');
      assert.equal(await h.page.locator('.skip').evaluate(e => document.activeElement === e), true, 'Keyboard focus exposes skip link');
      const skip = await h.page.locator('.skip').evaluate(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { width: r.width, height: r.height, outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth) }; });
      assert(skip.width >= 44 && skip.height >= 44 && skip.outlineStyle !== 'none' && skip.outlineWidth > 0, 'Focused skip link hit area and focus indicator');
      const problems = await h.page.evaluate(() => [...document.querySelectorAll('button,input,select,a')].filter(e => {
        const s = getComputedStyle(e), r = e.getBoundingClientRect(); return !e.disabled && s.visibility !== 'hidden' && s.display !== 'none' && r.width && r.height;
      }).flatMap(e => {
        const r = (e.matches('input[type=radio],input[type=checkbox]') ? e.closest('label') || e : e).getBoundingClientRect(); return r.width < 44 || r.height < 44 || r.left < 0 || r.right > innerWidth ? [{ label: e.textContent || e.getAttribute('aria-label'), width: r.width, height: r.height, left: r.left, right: r.right }] : [];
      }));
      assert.deepEqual(problems, [], 'Hit area/clipped controls');
      await h.page.keyboard.press('Tab'); assert(await h.page.evaluate(() => document.activeElement !== document.body));
      await h.control('placeMuALeft').focus(); await h.page.keyboard.press('Enter');
      await h.control('placeMuBRight').focus(); await h.page.keyboard.press('Space');
      assert.equal(await h.control('next').isDisabled(), false);
    }, { viewport });
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'readiness-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  // Do not call browser.close(): CDP attachment belongs to the owner's browser.
}
process.exit(report.results.some(r => r.status === 'FAIL') ? 1 : 0); // Disconnect owned CDP transport without a browser-close command.
