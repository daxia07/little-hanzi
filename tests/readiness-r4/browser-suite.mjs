// Actual frozen Node/auth/libSQL/CDP adapter. No product services or app mocks.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { connectOwnedChrome } from '../../scripts/owned-cdp.mjs';
import { createHTTPCases } from '../readiness-r3/http-suite.mjs';
import { createBrowserCases } from '../readiness-r3/browser-suite.mjs';
import { V4_TABLES, CONTRACT } from '../readiness-r3/oracle.mjs';
export async function createRuntimeAdapter({ handoff: h, output }) {
  const manifest = JSON.parse(await readFile(h.manifest, 'utf8'));
  assert.equal(manifest.candidateId, h.candidateId);
  assert.equal(h.buildId, manifest.candidateId);
  assert.equal(manifest.phase, 'r4');

  const work = await realpath(manifest.work);
  assert.equal(work, manifest.work);
  assert.equal(
    await readFile(path.join(work, '.hanzi-qa-owned'), 'utf8'),
    manifest.runId,
  );
  assert(
    path.resolve(output).startsWith(work + path.sep),
    'Proof output must be inside marked owned work',
  );
  assert.equal(await realpath(h.snapshot), manifest.snapshot);
  for (const name of ['baseURL', 'ordinaryBaseURL', 'controlURL']) {
    const u = new URL(h[name]);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, '127.0.0.1');
    assert(u.port);
  }
  assert.equal(h.cdpURL, 'http://127.0.0.1:9222');
  assert(h.sentinelSurvivedAppAndDatabaseRestart && h.backupAdapterAvailable);
  const file = await realpath(h.credentialsFile);
  assert(file.startsWith(work + path.sep));
  assert.equal((await stat(file)).mode & 0o077, 0);
  const privateData = JSON.parse(await readFile(file, 'utf8'));
  assert(
    typeof privateData.token === 'string' && privateData.token.length >= 32,
  );
  const accounts = new Map(privateData.accounts.map((a) => [a.label, a])),
    cookies = new Map(),
    requests = [],
    ownedContexts = [],
    accessEvidence = [];
  let currentActor,
    connection,
    page,
    accessIndex = 0;
  const publicActor = (a) => ({ id: a.id, label: a.label });
  const throttleRecords = [];
  async function waitForOrdinaryLimit(header, attempt, method, role) {
    const numeric =
      header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : null;
    const date = header && numeric === null ? Date.parse(header) : NaN;
    const parsed =
      numeric !== null
        ? numeric
        : Number.isFinite(date)
          ? Math.max(0, (date - Date.now()) / 1000)
          : null;
    const waitSeconds =
      parsed !== null && parsed >= 0 && parsed <= 300 ? Math.ceil(parsed) : 61;
    const record = {
      status: 429,
      attempt,
      method,
      role,
      stage: 'sign-in submitted; waiting ordinary bucket',
      waitSeconds,
      source:
        parsed !== null && parsed >= 0 && parsed <= 300
          ? 'actual Retry-After'
          : 'frozen ordinary60second bucket;61second fallback',
      observedAt: Date.now(),
    };
    throttleRecords.push(record);
    await writeFile(
      path.join(output, 'auth-throttle.json'),
      JSON.stringify({ records: throttleRecords }, null, 2) + '\n',
    );
    if (attempt >= 2)
      throw Object.assign(
        Error('Ordinary auth rate limit persists after2bounded retries'),
        { code: 'QA_BLOCKED' },
      );
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
  async function recordSuccessfulAuth(attempt, method, role) {
    if (!throttleRecords.length) return;
    throttleRecords.push({
      status: 200,
      attempt,
      method,
      role,
      stage: 'actual sign-in response accepted',
      observedAt: Date.now(),
    });
    await writeFile(
      path.join(output, 'auth-throttle.json'),
      JSON.stringify({ records: throttleRecords }, null, 2) + '\n',
    );
  }
  async function signIn(a, base = h.baseURL) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const response = await fetch(
        new URL('/api/auth/sign-in/username', base),
        {
          method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: a.username, password: a.password }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (response.status === 429) {
        await waitForOrdinaryLimit(
          response.headers.get('retry-after'),
          attempt,
          'real HTTP sign-in',
          a.role,
        );
        continue;
      }
      assert.equal(response.status, 200, 'Real synthetic session sign-in');
      await recordSuccessfulAuth(attempt, 'real HTTP sign-in', a.role);
      const cookie = response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      assert(cookie);
      cookies.set(`${base}:${a.id}`, cookie);
      return cookie;
    }
    throw Error('Bounded sign-in exhausted');
  }
  function actor(value) {
    const id = value?.id || value?.accountId;
    const a = [...accounts.values()].find((x) => x.id === id);
    assert(a, 'Only preissued synthetic actor');
    return a;
  }
  async function request(
    who,
    method,
    endpoint,
    body,
    { base = h.baseURL, privateToken = false } = {},
  ) {
    const a = actor(who);
    assert(endpoint.startsWith('/api/'));
    const cookie = cookies.get(`${base}:${a.id}`) || (await signIn(a, base));
    const response = await fetch(new URL(endpoint, base), {
      method,
      headers: {
        Origin: base,
        Cookie: cookie,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(privateToken ? { 'X-Hanzi-Test-Token': privateData.token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    });
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    requests.push({
      actorId: a.id,
      method,
      path: endpoint,
      status: response.status,
    });
    const result = await response.json();
    if (
      response.status === 200 &&
      method === 'GET' &&
      /^\/api\/pilot\/curriculum\/learning-runs\/[^/]+$/.test(endpoint)
    ) {
      assert.equal(result.lessonVersion, CONTRACT.lesson);
      assert.equal(result.contentDigest, h.contentDigest);
      assert.equal(result.installationId, h.evidenceInstallationId);
      if (a.role === 'child') assert.equal(result.childId, a.id);
    }
    return { status: response.status, body: result };
  }
  async function control(endpoint, body) {
    assert(
      [
        '/inspect',
        '/clock',
        '/restart',
        '/fault-final',
        '/backup',
        '/restore',
      ].includes(endpoint),
    );
    const response = await fetch(new URL(endpoint, h.controlURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hanzi-Test-Token': privateData.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        ['/backup', '/restore'].includes(endpoint) ? 100000 : 55000,
      ),
    });
    assert.equal(response.status, 200, `Owned named control ${endpoint}`);
    return response.json();
  }
  async function verifyFrozenIdentity() {
    for (const [fields, expected] of [
      [manifest.files, h.sourceDigest],
      [manifest.artifactFiles, h.artifactDigest],
    ]) {
      assert(Array.isArray(fields) && fields.length);
      const sha = createHash('sha256');
      for (const relative of fields) {
        assert(
          !path.isAbsolute(relative) && !relative.split('/').includes('..'),
        );
        const target = path.join(h.snapshot, relative);
        assert.equal(await realpath(target), target);
        const bytes = await readFile(target);
        sha.update(relative + '\0');
        sha.update(bytes);
        sha.update('\0');
      }
      assert.equal('sha256:' + sha.digest('hex'), expected);
    }
    const health = await fetch(new URL('/api/pilot/health', h.baseURL), {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).candidateId, h.candidateId);
    assert.equal(
      (await control('/inspect', { kind: 'installation' })).installationId,
      h.evidenceInstallationId,
    );
    const current = await control('/inspect', { kind: 'publication' });
    assert(current.publications.length > 0);
    for (const publication of current.publications) {
      assert.equal(publication.installation_id, h.evidenceInstallationId);
      assert.equal(publication.lesson_version, CONTRACT.lesson);
      assert.equal(publication.content_digest, h.contentDigest);
      assert.equal(publication.test_run_id, h.namespace);
    }
  }
  async function fixture(label) {
    const b = label === 'role-ownership',
      child = accounts.get(
        b
          ? 'child-b'
          : label === 'postproof-auth-revocation'
            ? 'child-a2'
            : 'child-a',
      ),
      parent = accounts.get(b ? 'parent-b' : 'parent-a');
    const f = {
      parent: publicActor(parent),
      child: publicActor(child),
      teacher: publicActor(accounts.get('teacher')),
      operator: publicActor(accounts.get('operator')),
      otherChild: publicActor(accounts.get(b ? 'child-a' : 'child-b')),
      otherParent: publicActor(accounts.get(b ? 'parent-a' : 'parent-b')),
      ungrantedTeacher: publicActor(accounts.get('teacher')),
    };
    assert.equal(
      (
        await request(
          f.parent,
          'PUT',
          `/api/pilot/children/${child.id}/onboarding`,
          {
            nickname: 'QA ' + label.slice(0, 30),
            experience: 'new',
            audioReady: true,
          },
        )
      ).status,
      200,
    );
    const p = await request(
      f.parent,
      'POST',
      `/api/pilot/children/${child.id}/placement/proposals`,
      { lessonVersion: CONTRACT.lesson },
    );
    assert.equal(p.status, 200);
    const approved = await request(
      f.parent,
      'POST',
      `/api/pilot/children/${child.id}/placement/approve`,
      {
        proposalId: p.body.proposal.proposalId,
        sourceDigest: p.body.proposal.sourceDigest,
      },
    );
    assert.equal(approved.status, 200);
    const assignment = approved.body.plan.items[0].assignmentId;
    const started = await request(
      f.child,
      'POST',
      `/api/pilot/curriculum/assignments/${assignment}/start`,
      { requestId: randomUUID() },
    );
    assert.equal(started.status, 200);
    f.runId = started.body.runId;
    f.assignmentId = assignment;
    f.parent.children = b
      ? [publicActor(child)]
      : [publicActor(child), publicActor(accounts.get('child-a2'))];
    return f;
  }
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== 'serverAt')
              .map(([key, v]) => [key, stable(v)]),
          )
        : value;
  const controls = Object.fromEntries(
    [
      'story-child',
      'story-nickname',
      'story-experience',
      'save-setup',
      'request-proposal',
      'approve-plan',
      'handover-signout',
      'refresh-story-plan',
      'start-story',
      'continue-story',
      'start-due-review',
      'refresh-child-story',
      'refresh-story-progress',
      'cue',
      'continue',
      'sound-check',
      'sound-heard',
      'retry-save',
      'retry-report',
      'accept-conflict',
      'refresh-run',
    ].map((name) => [name, `[data-control="${name}"]`]),
  );
  async function initBrowser() {
    if (page) return;
    connection ||= await connectOwnedChrome(h.cdpURL);
    const context = await connection.browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    ownedContexts.push(context);
    context.setDefaultTimeout(10000);
    context.setDefaultNavigationTimeout(20000);
    await context.addInitScript(() => {
      const active = [];
      window.SpeechSynthesisUtterance = class {
        constructor(text) {
          this.text = text;
        }
      };
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => [
            { name: 'Tingting', lang: 'zh-CN', localService: true },
          ],
          cancel: () => {
            active.splice(0);
          },
          speak: (u) => {
            active.push(u);
            queueMicrotask(() => {
              if (!active.includes(u)) return;
              u.onstart?.({});
              setTimeout(() => {
                if (active.includes(u)) u.onend?.({});
              }, 30);
            });
          },
        },
      });
    });
    page = await context.newPage();
    const ownershipSession = await context.newCDPSession(page);
    const ownershipInfo = await ownershipSession.send('Target.getTargetInfo');
    assert(
      ownershipInfo.targetInfo.browserContextId &&
        ownershipInfo.targetInfo.targetId,
    );
    await writeFile(
      path.join(output, 'owned-browser-ids.json'),
      JSON.stringify(
        {
          browserContextId: ownershipInfo.targetInfo.browserContextId,
          targetId: ownershipInfo.targetInfo.targetId,
        },
        null,
        2,
      ) + '\n',
    );
    await ownershipSession.detach();
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/'))
        requests.push({
          actorId: currentActor?.id,
          method: r.method(),
          path: u.pathname,
          browser: true,
        });
    });
    await page.goto(h.baseURL);
  }
  async function signOutThroughUI() {
    const button = page.getByRole('button', { name: 'Sign out', exact: true });
    if (await button.count()) {
      await button.click();
      await page
        .getByRole('heading', { name: 'Sign in', exact: true })
        .waitFor();
    }
    currentActor = undefined;
  }
  async function signInThroughUI(who, { keyboard = false } = {}) {
    await initBrowser();
    if (currentActor) await signOutThroughUI();
    const a = actor(who);
    await page.goto(h.baseURL);
    await page
      .getByLabel('Username', { exact: true })
      .waitFor({ state: 'visible' });
    await page
      .getByLabel('Password', { exact: true })
      .waitFor({ state: 'visible' });
    async function submitSignIn(action) {
      for (let attempt = 0; attempt <= 2; attempt++) {
        const pending = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            new URL(r.url()).pathname === '/api/auth/sign-in/username',
        );
        await action();
        const response = await pending;
        if (response.status() === 429) {
          await waitForOrdinaryLimit(
            response.headers()['retry-after'],
            attempt,
            keyboard
              ? 'real keyboard form sign-in'
              : 'real pointer form sign-in',
            a.role,
          );
          continue;
        }
        assert.equal(response.status(), 200, 'Actual browser sign-in response');
        await recordSuccessfulAuth(
          attempt,
          keyboard ? 'real keyboard form sign-in' : 'real pointer form sign-in',
          a.role,
        );
        return;
      }
      throw Error('Bounded browser sign-in exhausted');
    }
    if (keyboard) {
      for (const [selector, value] of [
        ['input[autocomplete=username]', a.username],
        ['input[autocomplete=current-password]', a.password],
      ]) {
        let reached = false;
        for (let i = 0; i < 100; i++) {
          if (
            await page.evaluate(
              (s) => document.activeElement?.matches(s),
              selector,
            )
          ) {
            reached = true;
            break;
          }
          await page.keyboard.press('Tab');
        }
        assert(reached, 'Keyboard sign-in field reachable');
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type(value);
      }
      await submitSignIn(() => page.keyboard.press('Enter'));
    } else {
      await page.getByLabel('Username', { exact: true }).fill(a.username);
      await page.getByLabel('Password', { exact: true }).fill(a.password);
      await submitSignIn(() =>
        page.getByRole('button', { name: 'Sign in', exact: true }).click(),
      );
    }
    currentActor = a;
    await page
      .locator(
        a.role === 'parent'
          ? '[data-role="parent-story-plan"]'
          : a.role === 'operator'
            ? '[data-ops-tab=operations]'
            : '[data-role="child-story"]',
      )
      .waitFor();
    if (a.role === 'parent') {
      await page
        .locator('[data-role=parent-story-plan] [data-plan-save-state=saved]')
        .waitFor();
    }
    if (a.role === 'child')
      await page.waitForFunction(() => {
        const refresh = document.querySelector(
          '[data-control=refresh-child-story]',
        );
        return refresh && !refresh.disabled;
      });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
  }
  const adapter = {
    get page() {
      return page;
    },
    publicControls: controls,
    namedControl: control,
    freshFixtureSession: (who) => signIn(actor(who)),
    setPrivateFixturePassword: (who, value) => {
      actor(who).password = value;
    },
    async captureAccessibleView(label) {
      label = label + '-' + ++accessIndex;
      const samples = [];
      try {
        for (const [width, height] of [
          [820, 1180],
          [390, 844],
        ])
          for (const zoom of [1, 2]) {
            await page.setViewportSize({ width, height });
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.evaluate((z) => {
              document.documentElement.style.zoom = String(z);
            }, zoom);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
            });
            const metrics = await page.evaluate(() => {
              const visible = (e) => {
                const r = e.getBoundingClientRect(),
                  s = getComputedStyle(e);
                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  s.visibility !== 'hidden' &&
                  s.display !== 'none'
                );
              };
              const parse = (c) => {
                const v = c.match(/[\d.]+/g)?.map(Number);
                return v && v.length >= 3 ? v : null;
              };
              const luminance = (c) =>
                c
                  .slice(0, 3)
                  .map((v) => v / 255)
                  .map((v) =>
                    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
                  )
                  .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
              const contrasts = [
                ...document.querySelectorAll(
                  '[data-role] p,[data-role] h2,[data-role] h3,[data-role] label,[data-role] button',
                ),
              ]
                .filter(
                  (e) => visible(e) && !e.disabled && e.textContent.trim(),
                )
                .map((e) => {
                  const style = getComputedStyle(e),
                    fg = parse(style.color);
                  let bg;
                  for (let parent = e; parent; parent = parent.parentElement) {
                    const candidate = parse(
                      getComputedStyle(parent).backgroundColor,
                    );
                    if (
                      candidate &&
                      (candidate.length === 3 || candidate[3] === 1)
                    ) {
                      bg = candidate;
                      break;
                    }
                  }
                  bg ||= [255, 255, 255];
                  if (!fg || (fg.length === 4 && fg[3] !== 1))
                    return { unsupported: true };
                  const a = luminance(fg),
                    b = luminance(bg),
                    large =
                      parseFloat(style.fontSize) >= 24 ||
                      (parseFloat(style.fontSize) >= 18.66 &&
                        Number(style.fontWeight) >= 700);
                  return {
                    tag: e.tagName,
                    foreground: style.color,
                    background: bg.slice(0, 3),
                    ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
                    minimum: large ? 3 : 4.5,
                  };
                });
              return {
                clientWidth: document.documentElement.clientWidth,
                scrollWidth: document.documentElement.scrollWidth,
                overflow:
                  document.documentElement.scrollWidth >
                  document.documentElement.clientWidth + 1,
                targets: [
                  ...document.querySelectorAll('button,input,select,a[href]'),
                ]
                  .filter((e) => visible(e) && !e.disabled)
                  .map((e) => {
                    const label = e.matches(
                        'input[type=checkbox],input[type=radio]',
                      )
                        ? e.labels?.[0]
                        : null,
                      r = (
                        label && visible(label) ? label : e
                      ).getBoundingClientRect();
                    return {
                      tag: e.tagName,
                      control: e.dataset.control || null,
                      width: r.width,
                      height: r.height,
                    };
                  }),
                contrasts,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
              };
            });
            const diagnosticFile =
              'measure-' + label + '-' + width + '-' + zoom + '.json';
            await writeFile(
              path.join(output, diagnosticFile),
              JSON.stringify({ width, height, zoom, metrics }, null, 2) + '\n',
            );
            accessEvidence.push(diagnosticFile);
            await page.screenshot({
              path: path.join(
                output,
                'measure-' + label + '-' + width + '-' + zoom + '.png',
              ),
              fullPage: false,
            });
            accessEvidence.push(
              'measure-' + label + '-' + width + '-' + zoom + '.png',
            );
            assert.equal(
              metrics.overflow,
              false,
              label + ' layout overflow ' + width + '/' + zoom,
            );
            assert.equal(metrics.reduced, true);
            assert(
              metrics.contrasts.length > 0,
              'Actual rendered contrast samples',
            );
            for (const sample of metrics.contrasts)
              assert(
                !sample.unsupported && sample.ratio >= sample.minimum,
                label + ' rendered contrast ' + JSON.stringify(sample),
              );
            for (const target of metrics.targets)
              assert(
                target.width >= 44 && target.height >= 44,
                label + ' target ' + JSON.stringify(target),
              );
            const file = 'access-' + label + '-' + width + '-' + zoom + '.png';
            await page.screenshot({
              path: path.join(output, file),
              fullPage: zoom === 1,
            });
            accessEvidence.push(file);
            samples.push({
              width,
              height,
              zoom,
              method:
                'Chromium viewport emulation; CSS root zoom; reduced-motion media emulation',
              metrics,
              screenshot: file,
            });
          }
      } finally {
        await page.evaluate(() => {
          document.documentElement.style.zoom = '1';
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
      await writeFile(
        path.join(output, 'access-' + label + '.json'),
        JSON.stringify(
          {
            samples,
            limitations:
              'Not a physical tablet/phone. CSS layout zoom is not operating-system text scaling.',
          },
          null,
          2,
        ) + '\n',
      );
      accessEvidence.push('access-' + label + '.json');
    },
    request,
    familyFixture: fixture,
    verifyFrozenIdentity,
    inspectRun: (runId) => control('/inspect', { kind: 'run', runId }),
    inspectAtomicGroups: () => control('/inspect', { kind: 'counts' }),
    setScopedTime: (_f, at) => control('/clock', { at }),
    restartOwnedRuntime: (service) => control('/restart', { service }),
    signInThroughUI,
    signOutThroughUI,
    currentIdentity: async () => ({
      ...publicActor(currentActor),
      accountId: currentActor.id,
    }),
    readRunThroughHTTP: async (who, id) => {
      const r = await request(
        who,
        'GET',
        `/api/pilot/curriculum/learning-runs/${id}`,
      );
      assert.equal(r.status, 200);
      return r.body;
    },
    readActiveRun: async () => {
      const renderer = page.locator('section#story-activity[data-run-id]');
      await renderer.waitFor({ state: 'visible' });
      const id = await renderer.getAttribute('data-run-id');
      assert(
        typeof id === 'string' && id.length > 0,
        'Visible ordinary renderer must expose its actual run ID',
      );
      return { runId: id };
    },
    async holdRealResponse({ method, path: target }) {
      let arrived, release, finished;
      const done = new Promise((resolve) => {
        finished = resolve;
      });
      const reached = new Promise((r) => {
          arrived = r;
        }),
        held = new Promise((r) => {
          release = r;
        });
      const result = {
        arrived: Promise.race([
          reached,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  Error('Held real response did not arrive within15seconds'),
                ),
              15000,
            );
            timer.unref();
          }),
        ]),
        body: null,
        release: async () => {
          release();
          await done;
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
        },
      };
      await page.context().route('**' + target, async (r) => {
        if (r.request().method() !== method) return r.continue();
        const actual = await r.fetch();
        result.body = await actual.json();
        arrived();
        await held;
        try {
          await r.fulfill({ response: actual });
        } finally {
          finished();
        }
      });
      return result;
    },
    requestsAfterIdentitySwitch: async () =>
      requests.filter((r) => r.browser && r.actorId === currentActor?.id),
    reconcilePendingThroughUI: async () => {
      await page.locator('[data-save-state]').waitFor();
      if (await page.locator('[data-save-state="pending"]').count())
        await page.locator('[data-control="retry-save"]').click();
      await page.locator('[data-save-state="saved"]').waitFor();
    },
    async cleanupOwnedContexts() {
      if (connection) {
        for (const c of ownedContexts.splice(0)) await c.close();
        connection.disconnect();
        assert.equal(connection.metadata.adoptedExistingTargets, 0);
      }
    },
  };
  async function evidence(id, detail) {
    const name = `evidence-${id}.json`;
    await writeFile(
      path.join(output, name),
      JSON.stringify(
        {
          method:
            'Actual Node HTTP / ordinary auth / native owned CDP / real sqld named controls',
          speechBoundary:
            'Synthetic declared Tingting start/end fixture; no real listening',
          ...detail,
          requests: requests.splice(0),
        },
        null,
        2,
      ) + '\n',
    );
    return {
      evidenceRefs: [
        name,
        ...accessEvidence.splice(0),
        ...(throttleRecords.length ? ['auth-throttle.json'] : []),
      ],
    };
  }
  adapter.createIndependentCases = async () => {
    const cases = createHTTPCases(adapter).map((item) => ({
      ...item,
      scenarios: item.id.startsWith('I11-helped')
        ? ['recognition', 'help', 'audio-unavailable']
        : item.id.startsWith('I11-')
          ? ['recognition']
          : item.id.startsWith('I10')
            ? ['ownership']
            : item.id.startsWith('I12')
              ? ['duplicate-conflict']
              : ['delayed-review'],
      run: async () => {
        await item.run();
        return evidence(item.id, { ears: item.ears });
      },
    }));
    cases.push({
      id: 'family-selection-approval',
      scenarios: ['selection', 'approval'],
      run: async () => {
        const f = await fixture('selection-approval');
        const library = await request(
          f.parent,
          'GET',
          `/api/pilot/children/${f.child.id}/library`,
        );
        assert.equal(library.status, 200);
        for (const item of library.body.items) {
          assert.equal(item.contentDigest, h.contentDigest);
          assert.equal(item.lessonVersion, CONTRACT.lesson);
        }
        assert(
          library.body.items.some(
            (i) => i.lessonVersion === CONTRACT.lesson && i.available,
          ),
        );
        const counts = await control('/inspect', { kind: 'counts' });
        assert(counts.counts.pilot_learning_plan > 0);
        return evidence('selection-approval', {
          counts: counts.counts,
          fixtureScope: 'Explicit synthetic verification, not ordinary release',
        });
      },
    });
    cases.push({
      id: 'restart-real-run',
      scenarios: ['restart'],
      run: async () => {
        const f = await fixture('restart'),
          before = await adapter.readRunThroughHTTP(f.child, f.runId);
        await control('/restart', { service: 'all' });
        const after = await adapter.readRunThroughHTTP(f.child, f.runId);
        assert.deepEqual(stable(after), stable(before));
        return evidence('restart', {
          runId: f.runId,
          revision: after.revision,
        });
      },
    });
    cases.push({
      id: 'progress-export-real',
      scenarios: ['progress-export'],
      run: async () => {
        const f = await fixture('export');
        const progress = await request(
            f.parent,
            'GET',
            `/api/pilot/children/${f.child.id}/progress`,
          ),
          exported = await request(
            f.parent,
            'GET',
            `/api/pilot/children/${f.child.id}/export`,
          );
        assert.equal(progress.status, 200);
        assert.equal(exported.status, 200);
        assert.deepEqual(
          stable(exported.body.curriculum),
          stable(progress.body.curriculum),
        );
        assert.equal(
          (
            await request(
              f.child,
              'GET',
              `/api/pilot/children/${f.child.id}/export`,
            )
          ).status,
          403,
        );
        return evidence('progress-export', {
          childId: f.child.id,
          runId: f.runId,
        });
      },
    });
    cases.push({
      id: 'preproof-real-recovery',
      scenarios: ['recovery'],
      run: async () => {
        const backup = await control('/backup', { name: 'populated' }),
          restored = await control('/restore', {
            name: 'populated',
            fault: 'uncertain',
          });
        assert(restored.baseURL && restored.readback);
        assert.notEqual(
          restored.readback.installationId,
          h.evidenceInstallationId,
        );
        assert.equal(restored.readback.sessionCount, 0);
        assert.equal(restored.readback.verificationCount, 0);
        assert.deepEqual(
          Object.keys(restored.readback.counts).sort(),
          [...V4_TABLES].sort(),
        );
        for (const table of [
          'pilot_curriculum_learning_run',
          'pilot_curriculum_learning_event',
          'pilot_learning_plan',
        ])
          assert(restored.readback.counts[table] > 0);
        return evidence('recovery', {
          backup,
          restored,
          scope:
            'Pre-proof real35-table schema recovery; proof/owner rows may be empty. Full14-populated phase required after signing.',
        });
      },
    });
    for (const [index, id] of [
      'B01-family-handover',
      'B09-keyboard-family',
      'B06-parent-late-child-response',
      'B06-child-pending-identity-switch',
    ].entries())
      cases.push({
        id,
        scenarios: ['browser-family', 'ownership'],
        run: async () => {
          for (const context of ownedContexts.splice(0)) await context.close();
          page = undefined;
          currentActor = undefined;
          await initBrowser();
          const item = createBrowserCases(adapter)[index];
          assert.equal(item.id, id);
          await item.run();
          return evidence(item.id, {
            ears: item.ears,
            cdpOwnership: connection.metadata,
          });
        },
      });
    return cases;
  };
  return adapter;
}

// R4 coordinator: inherited real fixture/auth/CDP implementation above is used
// only as infrastructure. R3 scenario registration is not executed here.
import { mkdir, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createControls } from './controls.mjs';
import { createOpsUI } from './ui-adapter.mjs';
import { verifyPair } from './archive-readback.mjs';
import { createSmokeCases } from './smoke.mjs';
export async function runOpsSmoke({ handoff, output }) {
  await mkdir(output, { recursive: false, mode: 0o700 });
  const infra = await createRuntimeAdapter({ handoff, output });
  const privateData = JSON.parse(
    await readFile(handoff.credentialsFile, 'utf8'),
  );
  const control = createControls(handoff, privateData.token);
  const results = [];
  try {
    const fixture = await infra.familyFixture('r4-smoke');
    await infra.signInThroughUI(fixture.parent);
    const savedRun = {
      runId: fixture.runId,
      childId: fixture.child.id,
      installationId: handoff.operations.learningInstallationId,
    };
    const ui = createOpsUI(infra.page, savedRun);
    const harness = {
      ...infra,
      ...ui,
      handoff: { ...handoff, learningInstallationId: savedRun.installationId },
      savedRun,
      operator: fixture.operator,
      parent: fixture.parent,
      inspectRecord: async (id) => {
        const r = await control('/inspect', { kind: 'record', id });
        assert.equal(r.status, 200);
        return r.body;
      },
      inspectJob: async (id) => {
        const r = await control('/inspect', { kind: 'job', id });
        assert.equal(r.status, 200);
        return r.body;
      },
      restartOwnedRuntime: async (service) => {
        const r = await control('/restart', { service }, 60000);
        assert.equal(r.status, 200);
      },
      dispatchPrivateJob: async (kind) => {
        const r = await control('/dispatch', { kind }, 60000);
        assert.equal(r.status, 200);
        return r.body;
      },
      verifyActualEncryptedReadback: (jobId) =>
        verifyPair(handoff, control, jobId),
      auditActualServedAssets: async () => {
        const root = path.join(handoff.snapshot, '.output/public');
        const files = [];
        async function visit(dir) {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            assert(!entry.isSymbolicLink());
            if (entry.isDirectory()) await visit(file);
            else if (/\.(js|html)$/.test(entry.name)) files.push(file);
          }
        }
        await visit(root);
        assert(files.length > 0);
        const evidence = [];
        for (const file of files) {
          const relative = path.relative(root, file);
          const response = await fetch(
            new URL('/' + relative, handoff.baseURL),
            { redirect: 'error', signal: AbortSignal.timeout(15000) },
          );
          assert.equal(response.status, 200);
          const bytes = Buffer.from(await response.arrayBuffer());
          assert.deepEqual(bytes, await readFile(file));
          const text = bytes.toString('utf8');
          assert(!text.includes('QA_PRIVATE_SMOKE_'));
          assert(!/correctChoiceId|correct_choice_id/.test(text));
          evidence.push({
            path: relative,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        }
        await writeFile(
          path.join(output, 'served-assets.json'),
          JSON.stringify(
            {
              method:
                'Actual unauthenticated public JS/HTML requests; exact artifact bytes and explicit grading/private-canary marker scan',
              files: evidence,
            },
            null,
            2,
          ) + '\n',
        );
        return {
          oracleLeak: false,
          privateCanaryLeak: false,
          allBytesMatchFrozenArtifact: true,
          assetCount: files.length,
        };
      },
      capturePopulatedAccessibility: async () => {
        await infra.captureAccessibleView('r4-populated');
      },
    };
    for (const item of createSmokeCases(harness)) {
      try {
        results.push({
          id: item.id,
          ears: item.ears,
          outcome: 'PASS',
          evidence: await item.run(),
        });
      } catch (error) {
        results.push({
          id: item.id,
          ears: item.ears,
          outcome: error.message.startsWith('BLOCKED:') ? 'BLOCKED' : 'FAIL',
          error: error.message,
        });
        break;
      }
      await writeFile(
        path.join(output, 'report.json'),
        JSON.stringify({ candidateId: handoff.candidateId, results }, null, 2) +
          '\n',
      );
    }
  } finally {
    await infra.cleanupOwnedContexts();
    await writeFile(
      path.join(output, 'report.json'),
      JSON.stringify({ candidateId: handoff.candidateId, results }, null, 2) +
        '\n',
    );
  }
  return results;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4);
  assert.equal(args[0], '--handoff');
  assert.equal(args[2], '--output');
  const handoff = JSON.parse(await readFile(args[1], 'utf8'));
  const results = await runOpsSmoke({ handoff, output: args[3] });
  process.exitCode =
    results.length === 5 && results.every((r) => r.outcome === 'PASS') ? 0 : 1;
}
