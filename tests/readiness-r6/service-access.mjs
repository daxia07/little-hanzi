/** Actual populated views with explicit CSS zoom, keyboard and computed contrast. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectOwnedChrome } from '../../scripts/owned-cdp.mjs';
import { corpusProfile } from '../../scripts/readiness-corpus-profiles.mjs';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runServiceAccess(http, binding, manifest, evidence) {
  const h = http.handoff,
    f = h.families[0],
    item = binding.items[1];
  assert(item);
  const oracles = JSON.parse(
      fs.readFileSync(
        path.join(manifest.snapshot, corpusProfile(h.profile).oraclePath),
        'utf8',
      ),
    ).items,
    oracle = oracles.find((x) => x.lessonVersion === item.lessonVersion);
  assert(oracle);
  let connection, context, page, cleanupError, result;
  const metrics = [];
  const control = (name) => page.locator('[data-control="' + name + '"]');
  async function signIn(id) {
    await page.goto(h.baseURL);
    const a = h.accounts.find((x) => x.id === id);
    assert(a);
    await page.getByLabel('Username', { exact: true }).fill(a.username);
    await page.getByLabel('Password', { exact: true }).fill(a.password);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/auth/sign-in/username',
      );
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const response = await pending;
      if (response.status() === 429 && attempt < 2) {
        const n = Number(response.headers()['retry-after']);
        await pause(
          Number.isFinite(n) && n > 0
            ? Math.min(120000, n * 1000 + 100)
            : 61000,
        );
        continue;
      }
      assert.equal(response.status(), 200);
      return performance.now();
    }
    assert.fail('Normal browser sign-in exhausted');
  }
  async function signOut() {
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/auth/sign-out',
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    assert.equal((await response).status(), 200);
    await page
      .getByLabel('Username', { exact: true })
      .waitFor({ state: 'visible' });
  }
  async function keyboardReach(name) {
    for (let n = 0; n < 150; n++) {
      await page.keyboard.press('Tab');
      if (
        await page.evaluate(
          (control) =>
            document.activeElement?.getAttribute('data-control') === control,
          name,
        )
      )
        return;
    }
    assert.fail('Keyboard cannot reach ' + name);
  }
  async function measure(label, section) {
    await section.waitFor({ state: 'visible' });
    try {
      for (const width of [820, 390])
        for (const zoom of [1, 2]) {
          await page.setViewportSize({ width, height: 1180 });
          await page.evaluate(
            (z) => (document.documentElement.style.zoom = String(z)),
            zoom,
          );
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          });
          await section.scrollIntoViewIfNeeded();
          const data = await section.evaluate((root) => {
            const visible = (e) => {
              const r = e.getBoundingClientRect();
              for (let a = e; a; a = a.parentElement) {
                const s = getComputedStyle(a);
                if (
                  s.display === 'none' ||
                  s.visibility === 'hidden' ||
                  Number(s.opacity) === 0
                )
                  return false;
              }
              return r.width > 0 && r.height > 0;
            };
            const rgba = (text) => {
              const values = text.match(/[\d.]+/gu)?.map(Number) ?? [];
              return [
                values[0] ?? 0,
                values[1] ?? 0,
                values[2] ?? 0,
                values[3] ?? 1,
              ];
            };
            const blend = (fg, bg) =>
              fg.slice(0, 3).map((x, i) => x * fg[3] + bg[i] * (1 - fg[3]));
            const luminance = (rgb) =>
              rgb
                .map((v) => {
                  const x = v / 255;
                  return x <= 0.04045
                    ? x / 12.92
                    : ((x + 0.055) / 1.055) ** 2.4;
                })
                .reduce(
                  (sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i],
                  0,
                );
            const ratio = (a, b) => {
              const x = luminance(a),
                y = luminance(b);
              return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
            };
            const background = (e) => {
              const chain = [];
              for (let a = e; a; a = a.parentElement) chain.push(a);
              return chain
                .reverse()
                .reduce(
                  (bg, a) =>
                    blend(rgba(getComputedStyle(a).backgroundColor), bg),
                  [255, 255, 255],
                );
            };
            const targets = [...root.querySelectorAll('[data-control]')]
              .filter((e) => visible(e) && !e.disabled)
              .map((e) => {
                const target = e.matches(
                  'input[type=checkbox],input[type=radio]',
                )
                  ? (e.closest('label') ?? e)
                  : e;
                const r = target.getBoundingClientRect();
                return {
                  control: e.getAttribute('data-control'),
                  width: r.width,
                  height: r.height,
                  method:
                    target === e
                      ? 'actual control rectangle'
                      : 'actual associated checkbox/radio label rectangle',
                };
              });
            const contrast = [
              ...root.querySelectorAll('p,h2,h3,label,button,output'),
            ]
              .filter((e) => visible(e) && !e.disabled && e.textContent.trim())
              .map((e) => {
                const style = getComputedStyle(e),
                  bg = background(e),
                  fg = blend(rgba(style.color), bg);
                return {
                  tag: e.tagName,
                  fontSize: parseFloat(style.fontSize),
                  color: style.color,
                  ratio: ratio(fg, bg),
                  threshold: 4.5,
                };
              });
            return {
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              targets,
              contrast,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)')
                .matches,
            };
          });
          const record = { view: label, width, zoom, ...data };
          metrics.push(record);
          evidence('access-' + label + '-' + width + '-' + zoom, record);
          await page.screenshot({
            path: evidence.path(
              'access-' + label + '-' + width + '-' + zoom + '.png',
            ),
            fullPage: false,
          });
          assert(
            data.scrollWidth <= data.clientWidth + 1,
            label + ' horizontal overflow',
          );
          assert(data.targets.length > 0);
          for (const target of data.targets)
            assert(
              target.width >= 44 && target.height >= 44,
              label + ' target below44px ' + target.control,
            );
          for (const sample of data.contrast)
            assert(
              sample.ratio + 0.01 >= sample.threshold,
              label + ' computed text contrast ' + sample.ratio,
            );
          assert(data.reducedMotion);
        }
    } finally {
      await page.evaluate(() => (document.documentElement.style.zoom = '1'));
      await page.setViewportSize({ width: 820, height: 1180 });
    }
  }
  try {
    connection = await connectOwnedChrome(h.cdpURL);
    context = await connection.browser.newContext({
      viewport: { width: 820, height: 1180 },
      reducedMotion: 'reduce',
    });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(30000);
    const session = await context.newCDPSession(page),
      info = (await session.send('Target.getTargetInfo')).targetInfo;
    evidence('access-owned-native-ids', {
      browserContextId: info.browserContextId,
      targetId: info.targetId,
    });
    await session.detach();
    const setup = await http.request(
      f.parentId,
      'PUT',
      '/api/pilot/children/' + f.childId + '/onboarding',
      {
        nickname: 'Synthetic accessibility learner',
        experience: 'new',
        audioReady: true,
      },
    );
    assert.equal(setup.status, 200);
    const readinessResponses = [];
    page.on('response', (response) => {
      const route = new URL(response.url()).pathname;
      if (route.startsWith('/api/'))
        readinessResponses.push({
          route,
          status: response.status(),
          at: performance.now(),
        });
    });
    const loadedAt = await signIn(f.parentId),
      catalog = page.locator('[data-role="corpus-catalog"]');
    await catalog
      .locator('[data-control="corpus-select"]')
      .first()
      .waitFor({ state: 'visible' });
    const catalogVisibleMs = performance.now() - loadedAt;
    await page.waitForFunction(() => {
      const b = document.querySelector(
        '[data-role="corpus-catalog"] [data-control="corpus-select"]',
      );
      return b && !b.disabled;
    });
    let keyboardPaging;
    const usableMs = performance.now() - loadedAt;
    evidence('access-authenticated-readiness-timing', {
      usableMs,
      catalogVisibleMs,
      budgetMs: 3000,
      clockStart: 'Successful normal sign-in response received',
      clockEnd: 'First catalog Select control visible and enabled',
      stages: readinessResponses.map(({ route, status, at }) => ({
        route,
        status,
        msFromAuthResponse: at - loadedAt,
      })),
    });
    assert(
      usableMs <= 3000,
      'Authenticated catalog usable delay exceeded3s: ' +
        usableMs.toFixed(1) +
        'ms',
    );
    await measure('parent-catalog', catalog);
    if (binding.items.length > 20) {
      const firstVersion = await catalog
        .locator('[data-lesson-version]')
        .first()
        .getAttribute('data-lesson-version');
      await keyboardReach('corpus-next-page');
      const nextResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          new URL(r.url()).pathname.endsWith('/catalog'),
      );
      await page.keyboard.press('Enter');
      assert.equal((await nextResponse).status(), 200);
      await page.waitForFunction((previous) => {
        const root = document.querySelector('[data-role="corpus-catalog"]');
        return (
          root?.getAttribute('data-catalog-state') === 'ready' &&
          root
            .querySelector('[data-lesson-version]')
            ?.getAttribute('data-lesson-version') !== previous
        );
      }, firstVersion);
      await keyboardReach('corpus-previous-page');
      const previousResponse = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          new URL(r.url()).pathname.endsWith('/catalog'),
      );
      await page.keyboard.press('Enter');
      assert.equal((await previousResponse).status(), 200);
      await page.waitForFunction((previous) => {
        const root = document.querySelector('[data-role="corpus-catalog"]');
        return (
          root?.getAttribute('data-catalog-state') === 'ready' &&
          root
            .querySelector('[data-lesson-version]')
            ?.getAttribute('data-lesson-version') === previous
        );
      }, firstVersion);
      keyboardPaging = 'actual next and previous pages operated by Tab/Enter';
    } else {
      assert.equal(await control('corpus-next-page').isEnabled(), false);
      keyboardPaging =
        'draft ten-item page has no next page; stress execution exercises actual paging';
    }
    await keyboardReach('corpus-search');
    const focus = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement);
      const chain = [];
      for (let node = document.activeElement; node; node = node.parentElement)
        chain.push(node);
      let background = [255, 255, 255];
      for (const node of chain.reverse()) {
        const values = getComputedStyle(node)
          .backgroundColor.match(/[\d.]+/gu)
          .map(Number);
        const alpha = values[3] ?? 1;
        background = background.map(
          (v, i) => values[i] * alpha + v * (1 - alpha),
        );
      }
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: parseFloat(s.outlineWidth),
        outlineColor: s.outlineColor,
        backgroundColor: 'rgb(' + background.join(',') + ')',
      };
    });
    const rgb = (text) =>
        text
          .match(/[\d.]+/gu)
          .slice(0, 3)
          .map(Number),
      lum = (values) =>
        values
          .map((v) => {
            const x = v / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const a = lum(rgb(focus.outlineColor)),
      b = lum(rgb(focus.backgroundColor));
    focus.contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert(focus.contrast >= 3, 'Visible focus contrast below3:1');
    evidence('access-keyboard-focus', focus);
    assert(
      focus.outlineStyle !== 'none' && focus.outlineWidth >= 3,
      'Search focus indicator absent',
    );
    await page.keyboard.type('definitelyabsentliteral');
    const emptyResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname.endsWith('/catalog'),
    );
    await page.keyboard.press('Enter');
    assert.equal((await emptyResponse).status(), 200);
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-role="corpus-catalog"]');
      return (
        root?.getAttribute('data-catalog-state') === 'ready' &&
        root.querySelectorAll('[data-lesson-version]').length === 0
      );
    });
    await measure('parent-empty', catalog);
    await control('corpus-search').fill(oracle.targets[0].hanzi);
    const search = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname.endsWith('/catalog'),
    );
    await control('corpus-search-submit').click();
    assert.equal((await search).status(), 200);
    const card = catalog.locator(
      '[data-lesson-version="' + item.lessonVersion + '"]',
    );
    await card.waitFor({ state: 'visible' });
    const proposed = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/catalog/proposals'),
    );
    await card.locator('[data-control="corpus-select"]').click();
    assert.equal((await proposed).status(), 200);
    const approval = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/placement/approve'),
    );
    await control('corpus-approve').click();
    assert.equal((await approval).status(), 200);
    await page
      .locator('[data-role="corpus-approved-plan"]')
      .waitFor({ state: 'visible' });
    await signOut();
    await signIn(f.childId);
    const home = page.locator(
      '[data-role="corpus-child-home"][data-home-state="ready"]',
    );
    await home.waitFor({ state: 'visible' });
    await measure('child-home', home);
    const slot = home.locator(
      '[data-lesson-version="' +
        item.lessonVersion +
        '"][data-phase="initial"]',
    );
    await slot.locator('[data-control="corpus-start"]').click();
    const run = page.locator(
      '[data-role="corpus-run"][data-save-state="saved"]',
    );
    await run.waitFor({ state: 'visible' });
    const runId = await run.getAttribute('data-run-id');
    assert(runId);
    const captured = new Set();
    let terminal;
    for (let n = 0; n < 160; n++) {
      await run.waitFor({ state: 'visible' });
      const response = await page.request.get(
        h.baseURL + '/api/pilot/curriculum/learning-runs/' + runId,
      );
      assert.equal(response.status(), 200);
      const view = await response.json();
      assert.equal(
        Number(await run.getAttribute('data-revision')),
        view.revision,
      );
      assert.equal(view.lessonVersion, item.lessonVersion);
      assert.equal(view.contentDigest, item.contentDigest);
      const label = view.state.completedAt
        ? 'child-recap'
        : view.teachingPanel
          ? 'child-teaching'
          : view.state.stepId === 'check'
            ? 'child-quiet-check'
            : null;
      if (label && !captured.has(label)) {
        await measure(label, run);
        captured.add(label);
        if (label === 'child-teaching') {
          const glyph = await run
            .getByText(view.teachingPanel.hanzi, { exact: true })
            .first()
            .evaluate((e) => ({
              fontSize: parseFloat(getComputedStyle(e).fontSize),
              tag: e.tagName,
            }));
          evidence('access-teaching-glyph', glyph);
          assert(
            glyph.fontSize >= 64,
            'Ordinary learning Hanzi below frozen64px',
          );
        }
        if (label === 'child-quiet-check') {
          const companion = await page
            .locator('[data-role="corpus-run"] aside')
            .count();
          assert.equal(companion, 0);
          const leaked = await page.evaluate(
            (targets) => {
              const visible = (e) => {
                const r = e.getBoundingClientRect();
                for (let a = e; a; a = a.parentElement) {
                  const s = getComputedStyle(a);
                  if (
                    s.display === 'none' ||
                    s.visibility === 'hidden' ||
                    Number(s.opacity) === 0
                  )
                    return false;
                }
                return r.width > 0 && r.height > 0;
              };
              return [
                ...document.querySelectorAll(
                  '[aria-label="Teaching companion"],p,h1,h2,h3,output',
                ),
              ]
                .filter(
                  (e) =>
                    visible(e) &&
                    !e.closest('[data-occurrence-id]') &&
                    (e.getAttribute('aria-label') === 'Teaching companion' ||
                      targets.includes(e.textContent.trim())),
                )
                .map((e) => ({
                  tag: e.tagName,
                  role: e.getAttribute('aria-label'),
                  text: e.textContent.trim(),
                }));
            },
            oracle.targets.map((t) => t.hanzi),
          );
          evidence('access-whole-page-quiet-leaks', { leaked });
          assert.deepEqual(
            leaked,
            [],
            'Whole visible page exposes teaching companion/target cue outside current question',
          );
          assert.equal(view.teachingPanel, null);
          evidence('access-quiet-check', {
            companionCount: companion,
            teachingPanel: null,
            currentOccurrenceId: view.question.occurrenceId,
          });
        }
      }
      if (view.state.completedAt) {
        terminal = view;
        break;
      }
      const pending = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname.endsWith('/' + runId + '/actions'),
      );
      if (view.question?.status === 'open')
        await run.locator('[data-control="corpus-without-sound"]').click();
      else await run.locator('[data-control="corpus-next"]').first().click();
      assert.equal((await pending).status(), 200);
      await page.waitForFunction(
        ({ runId, revision }) => {
          const e = document.querySelector('[data-role="corpus-run"]');
          return (
            e?.getAttribute('data-run-id') === runId &&
            Number(e.getAttribute('data-revision')) > revision &&
            e.getAttribute('data-save-state') === 'saved'
          );
        },
        { runId, revision: view.revision },
      );
    }
    assert(terminal?.state.completedAt);
    assert.deepEqual(
      [...captured].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ['child-quiet-check', 'child-recap', 'child-teaching'],
    );
    const sql = await http.inspect({ kind: 'run', runId });
    assert.equal(sql.run.completedAt, Date.parse(terminal.state.completedAt));
    assert.deepEqual(sql.run.recap, terminal.recap);
    await run.locator('[data-control="corpus-home"]').first().click();
    await signOut();
    await signIn(f.parentId);
    const progress = page.locator(
      '[data-role="corpus-progress"][data-progress-state="ready"]',
    );
    await progress.waitFor({ state: 'visible' });
    await progress
      .locator('[data-run-id="' + runId + '"]')
      .waitFor({ state: 'visible' });
    await measure('parent-populated-progress', progress);
    result = {
      metrics,
      usableMs,
      runId,
      initialUnavailableFacts: terminal.recap,
      keyboardSearch: true,
      keyboardPaging,
      focus,
      method:
        'Chromium820/390 viewport with CSS documentElement zoom1/2; fonts/layout awaited; actual controls/checkbox labels44px; computed foreground/background WCAG contrast; reduced-motion media. No physical-device/human acceptance claim.',
    };
  } finally {
    try {
      if (context) await context.close();
    } catch (error) {
      cleanupError = error;
    } finally {
      if (connection) connection.disconnect();
      evidence('access-cleanup', {
        ownedBrowserContextsClosed: !cleanupError,
        sharedBrowserDisconnected: true,
        metadata: connection?.metadata ?? null,
        error: cleanupError ? String(cleanupError.message).slice(0, 500) : null,
      });
    }
  }
  if (cleanupError) throw cleanupError;
  return result;
}
