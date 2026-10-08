import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { loadManifest } from './qa-helpers.mjs';
import { server } from './qa-server.mjs';
import { legacyPreviewSentinelVersion } from './readiness-worker-compat.mjs';

const args = process.argv.slice(2);
const suite = args[0];
if (!['integration', 'e2e'].includes(suite))
  throw new Error('Choose integration or e2e');
const manifestIndex = args.indexOf('--manifest');
const manifest = loadManifest(
  manifestIndex >= 0 ? args[manifestIndex + 1] : undefined,
);
const sentinelLessonVersion = legacyPreviewSentinelVersion(manifest);
const output = path.join(manifest.output, `${suite}-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const token = crypto.randomBytes(24).toString('hex');
const owned = [];
let control;
const suiteInstance = `${suite}-${Date.now()}`;
try {
  if (suite === 'e2e') {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { chromium, webkit } from 'playwright';
      for (const [name, engine] of Object.entries({ chromium, webkit })) {
        try { const browser = await engine.launch(); await browser.close(); console.log(name + ': available'); }
        catch (error) { console.error(name + ': ' + error.message); process.exitCode = 1; }
      }
    `,
      ],
      {
        cwd: manifest.snapshot,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: manifest.browsersPath,
        },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1_000_000,
      },
    );
    fs.writeFileSync(
      path.join(output, 'browser-preflight.log'),
      `${probe.stdout || ''}\n${probe.stderr || ''}`,
    );
    if (probe.status !== 0)
      throw new Error(
        'Browser execution is blocked before E2E tests; see browser-preflight.log. No browser scenario has passed.',
      );
  }
  const app = await server(manifest, {
    name: `${suiteInstance}-test`,
    testing: true,
    token,
    output,
  });
  owned.push(app);
  // Prove this owned persistence directory survives a restart before the
  // tester creates learner fixtures. This record is synthetic and disposable.
  const sentinelResponse = await fetch(`${app.baseURL}/api/preview/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lessonId: 'forest-01',
      lessonVersion: sentinelLessonVersion,
    }),
  });
  if (sentinelResponse.status !== 201)
    throw new Error('Isolated persistence sentinel could not be created');
  const sentinel = await sentinelResponse.json();
  const sentinelURL = `${app.baseURL}/api/preview/runs/${encodeURIComponent(sentinel.runId)}`;
  const beforeRestart = await (await fetch(sentinelURL)).text();
  await app.restart();
  const persisted = await fetch(sentinelURL);
  if (!persisted.ok || (await persisted.text()) !== beforeRestart)
    throw new Error('Owned D1 sentinel did not survive restart');
  const removed = await fetch(
    `${app.baseURL}/api/test/runs/${encodeURIComponent(sentinel.runId)}`,
    {
      method: 'DELETE',
      headers: { 'X-Hanzi-Test-Token': token },
    },
  );
  if (!removed.ok) throw new Error('Synthetic sentinel cleanup failed');
  fs.writeFileSync(
    path.join(output, 'isolation.json'),
    JSON.stringify(
      {
        candidateId: manifest.candidateId,
        state: app.state,
        testRunId: app.testRunId,
        sentinelSurvivedRestart: true,
        sentinelRemoved: true,
      },
      null,
      2,
    ),
  );
  const ordinary = await server(manifest, {
    name: `${suiteInstance}-ordinary`,
    testing: false,
    output,
  });
  owned.push(ordinary);
  control = http.createServer(async (req, res) => {
    if (req.headers['x-hanzi-test-token'] !== token) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/restart') {
      res.writeHead(404).end();
      return;
    }
    try {
      await app.restart();
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ restarted: true }));
    } catch (error) {
      res.writeHead(503).end(error.message);
    }
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  const env = {
    ...process.env,
    HANZI_BASE_URL: app.baseURL,
    HANZI_TEST_TOKEN: token,
    HANZI_ORDINARY_BASE_URL: ordinary.baseURL,
    HANZI_CONTROL_URL: `http://127.0.0.1:${control.address().port}`,
    HANZI_QA_OUTPUT: output,
    HANZI_TEST_RUN_ID: app.testRunId,
    HANZI_CANDIDATE_ID: manifest.candidateId,
    HANZI_TEST_FAULTS: '1',
    PLAYWRIGHT_BROWSERS_PATH: manifest.browsersPath,
  };
  fs.writeFileSync(
    path.join(output, 'environment.json'),
    JSON.stringify(
      {
        candidateId: manifest.candidateId,
        specVersion: manifest.specVersion,
        suite,
        testRunId: app.testRunId,
        baseURL: app.baseURL,
        ordinaryBaseURL: ordinary.baseURL,
        stateDirectory: app.state,
        snapshot: manifest.snapshot,
        browserPath: manifest.browsersPath,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const projects =
    suite === 'integration'
      ? ['--project=integration']
      : ['--project=chromium', '--project=webkit'];
  const child = spawn(
    path.join(manifest.snapshot, 'node_modules', '.bin', 'playwright'),
    ['test', ...projects],
    { cwd: manifest.snapshot, env, stdio: 'inherit' },
  );
  const [code] = await once(child, 'exit');
  process.exitCode = typeof code === 'number' ? code : 1;
} catch (error) {
  fs.writeFileSync(
    path.join(output, 'blocked.json'),
    JSON.stringify(
      {
        result: 'BLOCKED',
        error: error.message,
        candidateId: manifest.candidateId,
      },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (control) await new Promise((resolve) => control.close(resolve));
  for (const service of owned.reverse()) {
    await service.stop();
    fs.rmSync(service.configPath, { force: true });
  }
  const redaction = spawnSync(
    'python3',
    [path.join(manifest.snapshot, 'scripts', 'qa-redact.py'), output],
    { env: { ...process.env, HANZI_REDACT_TOKEN: token }, encoding: 'utf8' },
  );
  if (redaction.status !== 0) {
    console.error(
      'Evidence redaction failed; do not publish raw artifacts.',
      redaction.stderr,
    );
    process.exitCode = 1;
  }
  console.log(`Evidence: ${output}`);
}
