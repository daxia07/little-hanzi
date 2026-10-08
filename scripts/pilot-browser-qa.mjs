import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { assertPilotCompatibilityManifest } from './readiness-worker-compat.mjs';
import { loadManifest } from './qa-helpers.mjs';
import { server } from './qa-server.mjs';
import { localD1, sqlValue } from './pilot-local-db.mjs';
import { accountInsert } from './pilot-accounts.mjs';

const index = process.argv.indexOf('--manifest');
const manifest = loadManifest(index < 0 ? null : process.argv[index + 1]);
assertPilotCompatibilityManifest(manifest);
const discovery = process.argv.includes('--list');
const name = `pilot-browser-${Date.now()}`;
const output = path.join(manifest.output, name);
const privateOutput = path.join(manifest.work, `${name}-private`);
const fixtureFile = path.join(privateOutput, 'accounts.private.json');
fs.mkdirSync(output);
fs.mkdirSync(privateOutput, { mode: 0o700 });
const token = crypto.randomBytes(24).toString('hex');
const authSecret = crypto.randomBytes(32).toString('hex');
const secrets = [token, authSecret];
const groups = {};
const evidence = {
  candidateId: manifest.candidateId,
  startedAt: new Date().toISOString(),
  mode: discovery ? 'discovery-only' : 'browser',
  checks: [],
};
let running;
let db;

function redact(text) {
  for (const value of secrets.filter(Boolean))
    text = text.replaceAll(value, '[redacted]');
  return text;
}

async function playwright(env, extra = []) {
  const child = spawn(
    path.join(manifest.snapshot, 'node_modules/.bin/playwright'),
    ['test', '--project=pilot-chromium', '--project=pilot-webkit', ...extra],
    {
      cwd: manifest.snapshot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const chunks = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => chunks.push(chunk));
  const [code] = await once(child, 'exit');
  // Reporter output may describe a filled password. Keep it private until all
  // fixture secrets can be removed, rather than forwarding raw child stdout.
  fs.writeFileSync(
    path.join(privateOutput, 'playwright.log'),
    Buffer.concat(chunks),
    { mode: 0o600 },
  );
  return typeof code === 'number' ? code : 1;
}

function publishSanitized(directory, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'accounts.private.json') continue;
    const file = path.join(directory, entry.name);
    const target = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected artifact symlink');
    if (entry.isDirectory()) {
      publishSanitized(file, target);
      continue;
    }
    const extension = path.extname(entry.name);
    if (['.json', '.log', '.txt', '.md'].includes(extension)) {
      fs.writeFileSync(target, redact(fs.readFileSync(file, 'utf8')));
    } else if (extension === '.png') {
      const data = fs.readFileSync(file);
      if (secrets.some((value) => value && data.includes(Buffer.from(value))))
        throw new Error('Screenshot contains private fixture bytes');
      fs.writeFileSync(target, data);
    } else if (entry.name !== '.gitignore') {
      throw new Error('Unexpected browser artifact format; retained privately');
    }
  }
}

try {
  const env = {
    ...process.env,
    HANZI_PILOT_BROWSER: '1',
    HANZI_QA_OUTPUT: privateOutput,
    HANZI_PILOT_FIXTURES: fixtureFile,
    PLAYWRIGHT_BROWSERS_PATH: manifest.browsersPath,
  };
  if (discovery) {
    process.exitCode = await playwright(env, ['--list']);
    evidence.checks.push({
      id: 'PILOT-BROWSER-DISCOVERY',
      status: process.exitCode === 0 ? 'PASS' : 'FAIL',
      detail:
        'Test discovery only; no browser launched and no learning scenario executed',
    });
  } else {
    const preflight = spawnSync(
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
      { cwd: manifest.snapshot, env, encoding: 'utf8', timeout: 30_000 },
    );
    fs.writeFileSync(
      path.join(privateOutput, 'browser-preflight.log'),
      `${preflight.stdout || ''}\n${preflight.stderr || ''}`,
      { mode: 0o600 },
    );
    if (preflight.status !== 0) {
      evidence.checks.push({
        id: 'PILOT-BROWSER-LAUNCH',
        status: 'BLOCKED',
        detail: 'Browser engines could not launch; no pilot E2E scenario ran',
      });
      throw new Error('Browser preflight failed');
    }
    running = await server(manifest, {
      name,
      testing: true,
      token,
      authSecret,
      pilot: true,
      pilotTestContent: true,
      output: privateOutput,
      beforeStart: async (options) => {
        db = localD1(manifest, options);
        evidence.migrations = db.migrate();
        const inserts = [];
        for (const project of ['pilot-chromium', 'pilot-webkit']) {
          groups[project] = {};
          for (const scenario of [
            'recovery',
            'switch',
            'signout',
            'journey',
            'design',
            'cleanup',
            'password',
            'accounts',
            'grant',
          ]) {
            const accounts = {};
            for (const [key, role] of Object.entries({
              operator: 'operator',
              parentA: 'parent',
              parentB: 'parent',
              childA: 'child',
              childB: 'child',
              teacher: 'teacher',
              otherTeacher: 'teacher',
            })) {
              const password = crypto.randomBytes(20).toString('base64url');
              secrets.push(password);
              const name = `Synthetic ${scenario} ${key}`;
              const created = await accountInsert(
                {
                  username: `${project.slice(6, 7)}.${scenario}.${key.toLowerCase()}.${crypto.randomBytes(3).toString('hex')}`,
                  name,
                  role,
                  password,
                },
                {
                  mustChangePassword:
                    scenario === 'password' && key === 'childA',
                },
              );
              inserts.push(created.sql);
              accounts[key] = { ...created.account, name, role };
            }
            groups[project][scenario] = accounts;
          }
        }
        db.query(inserts.join('\n'));
      },
    });
    const { FOREST_LESSON } = await import(
      pathToFileURL(path.join(manifest.snapshot, 'lib/preview/content.ts'))
    );
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(FOREST_LESSON))
      .digest('hex');
    db.query(`INSERT INTO pilot_learning_release(lesson_version,release_kind,content_digest,reviewer_label,evidence_ref,candidate_id,test_run_id,released_at)
      VALUES('forest-01-v1','test-fixture',${sqlValue(digest)},'Synthetic browser fixture','isolated browser verification',${sqlValue(manifest.candidateId)},${sqlValue(running.testRunId)},${Date.now()});`);
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify({
        candidateId: manifest.candidateId,
        testRunId: running.testRunId,
        baseURL: running.baseURL,
        groups,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    evidence.checks.push({
      id: 'PILOT-BROWSER-FIXTURES',
      status: 'PASS',
      detail:
        'Distinct ordinary account groups per browser/scenario, guarded synthetic content, owned fresh local D1',
    });
    process.exitCode = await playwright({
      ...env,
      HANZI_BASE_URL: running.baseURL,
    });
  }
} catch {
  evidence.error =
    'Pilot browser verification did not complete; inspect sanitized evidence. No unavailable scenario is counted as passing.';
  process.exitCode = 1;
} finally {
  if (running) {
    await running.stop();
    try {
      secrets.push(
        ...db
          .query(
            'SELECT password FROM pilot_auth_account WHERE password IS NOT NULL;',
          )[0]
          .results.map((row) => row.password),
      );
      secrets.push(
        ...db
          .query('SELECT token FROM pilot_auth_session;')[0]
          .results.map((row) => row.token),
      );
      const log = fs.readFileSync(
        path.join(privateOutput, `${name}-server.log`),
        'utf8',
      );
      const leaked =
        secrets.some((value) => value && log.includes(value)) ||
        /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(log);
      evidence.checks.push({
        id: 'PILOT-BROWSER-LOGS',
        status: leaked ? 'FAIL' : 'PASS',
        detail:
          'Stopped Worker log inspected for private fixture values and serialized credentials',
      });
      if (leaked) {
        process.exitCode = 1;
        fs.writeFileSync(
          path.join(privateOutput, `${name}-server.log`),
          redact(log)
            .split('\n')
            .map((line) =>
              /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(
                line,
              )
                ? '[credential-bearing log line redacted]'
                : line,
            )
            .join('\n'),
        );
      }
    } catch {
      evidence.checks.push({
        id: 'PILOT-BROWSER-LOGS',
        status: 'BLOCKED',
        detail: 'Could not inspect stopped Worker log',
      });
      process.exitCode = 1;
    }
    fs.rmSync(running.configPath, { force: true });
  }
  fs.rmSync(fixtureFile, { force: true });
  evidence.finishedAt = new Date().toISOString();
  try {
    publishSanitized(privateOutput, output);
    fs.rmSync(privateOutput, { recursive: true });
  } catch {
    evidence.artifactError =
      'Some browser artifacts remain private because sanitization could not complete';
    process.exitCode = 1;
  }
  fs.writeFileSync(
    path.join(output, 'runner.json'),
    JSON.stringify(evidence, null, 2),
  );
  const logFile = path.join(output, 'playwright.log');
  if (fs.existsSync(logFile))
    console.log(fs.readFileSync(logFile, 'utf8').slice(-16_000));
  console.log(`Pilot browser evidence: ${output}`);
}
