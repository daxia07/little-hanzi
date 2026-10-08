/** Independent real R4 jobs/recovery/rollback suite. No mocks, browser or hosted claims. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createControls } from './controls.mjs';
import { verifyPair } from './archive-readback.mjs';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const opaque = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
function privateJSON(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o600);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function loopback(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert(url.port);
  assert(!url.username && !url.password && !url.search && !url.hash);
  return url.origin;
}
function args(argv) {
  assert.equal(argv.length, 6);
  const map = new Map();
  for (let n = 0; n < argv.length; n += 2) {
    assert(['--manifest', '--rollback-manifest', '--output'].includes(argv[n]));
    assert(!map.has(argv[n]));
    assert(path.isAbsolute(argv[n + 1]));
    map.set(argv[n], argv[n + 1]);
  }
  return {
    manifest: map.get('--manifest'),
    retained: map.get('--rollback-manifest'),
    output: map.get('--output'),
  };
}
async function childResult(command, argv, options) {
  const child = spawn(command, argv, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (v) => {
    stdout += v;
  });
  child.stderr.on('data', (v) => {
    stderr += v;
  });
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          resolve({ code, signal, stdout, stderr }),
        );
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(Error('Owned CLI timeout'));
        }, 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runJobsSuite(options) {
  const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8')),
    retained = JSON.parse(fs.readFileSync(options.retained, 'utf8'));
  const { verifyNodeManifest } = await import(
    pathToFileURL(
      path.join(manifest.snapshot, 'scripts/readiness-node-runner.mjs'),
    ).href
  );
  verifyNodeManifest(manifest, { built: true });
  verifyNodeManifest(retained, { built: true });
  assert.equal(manifest.phase, 'r4');
  assert.equal(retained.phase, 'r3');
  assert.notEqual(manifest.candidateId, retained.candidateId);
  const output = path.resolve(options.output);
  fs.mkdirSync(output, { recursive: true });
  assert.equal(
    fs.readdirSync(output).length,
    0,
    'fresh evidence folder required',
  );
  const report = {
    candidateId: manifest.candidateId,
    sourceDigest: manifest.digest,
    artifactDigest: manifest.artifactDigest,
    retainedCandidateId: retained.candidateId,
    testerHash: hash(fs.readFileSync(import.meta.filename)),
    scenarios: [],
    hosted: 'NOT RUN',
    human: 'NOT RUN',
    startedAt: Date.now(),
  };
  const save = () =>
    fs.writeFileSync(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  let runner, handoff, privateData, readyReject, readyResolve, runnerExit;
  const runtimeLog = fs.createWriteStream(
    path.join(output, 'runner-launch.log'),
    { flags: 'wx' },
  );
  let launchText = '';
  try {
    runner = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(manifest.snapshot, 'scripts/readiness-ops-node-runner.mjs'),
        'serve',
        options.manifest,
        '--rollback-manifest',
        options.retained,
      ],
      { cwd: manifest.snapshot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    runnerExit = new Promise((resolve) =>
      runner.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    runner.once('error', readyReject);
    runner.once('exit', () =>
      readyReject(Error('Owned runner exited before READY')),
    );
    runner.stdout.on('data', (bytes) => {
      runtimeLog.write(bytes);
      launchText += bytes.toString('utf8');
      const match = /^READY (.+)$/m.exec(launchText);
      if (match) readyResolve(match[1]);
    });
    runner.stderr.on('data', (bytes) => runtimeLog.write(bytes));
    let readyTimer;
    const handoffFile = await Promise.race([
      ready,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(Error('Runner readiness bounded240s timeout')),
          240000,
        );
      }),
    ]).finally(() => clearTimeout(readyTimer));
    handoff = privateJSON(handoffFile);
    assert.equal(handoff.candidateId, manifest.candidateId);
    assert.equal(handoff.operations.rollbackCandidateId, retained.candidateId);
    assert.equal(handoff.operations.localOnly, true);
    assert.equal(handoff.operations.notification, 'unconfigured');
    assert.equal(handoff.snapshot, manifest.snapshot);
    assert(
      fs
        .realpathSync(handoff.operations.state)
        .startsWith(manifest.work + path.sep),
    );
    assert.equal(
      fs.readFileSync(
        path.join(handoff.operations.state, '.hanzi-qa-owned'),
        'utf8',
      ),
      manifest.runId,
    );
    privateData = privateJSON(handoff.credentialsFile);
    loopback(handoff.baseURL);
    loopback(handoff.operations.controlURL);
    const control = createControls(handoff, privateData.token),
      accounts = new Map(privateData.accounts.map((a) => [a.label, a])),
      cookies = new Map();
    const evidence = (name, value) =>
      fs.writeFileSync(
        path.join(output, name + '.json'),
        JSON.stringify(value, null, 2) + '\n',
      );
    async function special(route, body) {
      assert(['/restore', '/rollback'].includes(route));
      assert.deepEqual(
        Object.keys(body).sort((a, b) => String(a).localeCompare(String(b))),
        route === '/restore' ? ['fault', 'jobId'] : ['target'],
      );
      if (route === '/restore') {
        assert(opaque(body.jobId));
        assert(
          [
            'none',
            'wrong-key',
            'tag-corrupt',
            'metadata-corrupt',
            'payload-checksum',
            'learning-final-write',
            'learning-ack-lost',
            'operations-final-write',
            'operations-ack-lost',
          ].includes(body.fault),
        );
      } else
        assert(['retained', 'current', 'incompatible'].includes(body.target));
      const r = await fetch(new URL(route, handoff.operations.controlURL), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hanzi-Test-Token': privateData.token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
        redirect: 'error',
      });
      return { status: r.status, body: await r.json() };
    }
    async function c(route, body) {
      const r = await control(route, body, 120000);
      assert.equal(r.status, 200, route + ' exact control status');
      return r.body;
    }
    async function signIn(label, base = handoff.baseURL) {
      const a = accounts.get(label);
      assert(a);
      const r = await fetch(new URL('/api/auth/sign-in/username', base), {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: a.username, password: a.password }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      assert.equal(
        r.status,
        200,
        'real sign-in; rate limit is a blocker, never bypassed',
      );
      const cookie = r.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; ');
      assert(cookie);
      cookies.set(base + ':' + label, cookie);
      return cookie;
    }
    const httpResults = [];
    async function request(
      label,
      method,
      route,
      body,
      base = handoff.baseURL,
      cookieOverride,
    ) {
      loopback(base);
      assert(route.startsWith('/api/'));
      const cookie =
        cookieOverride ??
        cookies.get(base + ':' + label) ??
        (await signIn(label, base));
      const r = await fetch(new URL(route, base), {
        method,
        headers: {
          Origin: base,
          Cookie: cookie,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
      const responseBody = await r.json();
      const code = responseBody.error?.code;
      httpResults.push({
        label,
        method,
        route,
        base,
        status: r.status,
        errorCode:
          typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : null,
      });
      evidence('http-results', httpResults);
      return { status: r.status, body: responseBody };
    }
    async function legacyFixture(selected) {
      assert(
        [manifest.candidateId, retained.candidateId].includes(
          selected.candidateId,
        ),
      );
      assert.equal(handoff.namespace, manifest.runId + '-story');
      assert.equal(handoff.scope.namespace, handoff.namespace);
      const ownedState = fs.realpathSync(handoff.state);
      assert(ownedState.startsWith(manifest.work + path.sep));
      assert.equal(
        fs.readFileSync(path.join(manifest.work, '.hanzi-qa-owned'), 'utf8'),
        manifest.runId,
      );
      const journal = JSON.parse(
        fs.readFileSync(path.join(handoff.output, 'processes.json'), 'utf8'),
      );
      assert.equal(journal.candidateId, manifest.candidateId);
      assert.equal(journal.state, ownedState);
      const config = privateJSON(handoff.operations.configFile);
      assert.equal(config.environment, 'synthetic');
      assert.equal(config.localSynthetic, true);
      assert.equal(
        config.installationId,
        handoff.operations.learningInstallationId,
      );
      loopback(config.learningURL);
      assert.equal(
        new URL(config.learningURL).port,
        String(journal.ports.database),
      );
      const tokenStat = fs.lstatSync(config.learningTokenFile);
      assert.equal(tokenStat.mode & 0o777, 0o600);
      assert(tokenStat.isFile() && !tokenStat.isSymbolicLink());
      const requireFrom = createRequire(
        path.join(manifest.snapshot, 'package.json'),
      );
      const client = requireFrom('@libsql/client').createClient({
        url: config.learningURL,
        authToken: fs.readFileSync(config.learningTokenFile, 'utf8'),
        intMode: 'number',
      });
      try {
        const install = await client.execute(
          'SELECT installation_id FROM pilot_installation WHERE id=1',
        );
        assert.equal(install.rows[0].installation_id, config.installationId);
        const people = await client.execute(
          'SELECT id,role FROM pilot_auth_user ORDER BY id',
        );
        const expected = privateData.accounts
          .map((a) => ({ id: a.id, role: a.role }))
          .sort((a, b) => a.id.localeCompare(b.id));
        assert.equal(expected.length, 7);
        assert.deepEqual(
          people.rows.map((r) => ({ id: r.id, role: r.role })),
          expected,
        );
        const { FOREST_LESSON } = await import(
          pathToFileURL(path.join(selected.snapshot, 'lib/preview/content.ts'))
            .href
        );
        const digest = hash(Buffer.from(JSON.stringify(FOREST_LESSON)));
        const sql = `INSERT OR REPLACE INTO pilot_learning_release(lesson_version,release_kind,content_digest,reviewer_label,evidence_ref,candidate_id,test_run_id,released_at) SELECT 'forest-01-v1','test-fixture',?,'Synthetic independent QA','guarded own learning DB; no owner acceptance',?,?,? WHERE (SELECT installation_id FROM pilot_installation WHERE id=1)=? AND (SELECT COUNT(*) FROM pilot_auth_user)=7 AND NOT EXISTS(SELECT 1 FROM pilot_auth_user WHERE id NOT IN (${expected.map(() => '?').join(',')}))`;
        const written = await client.execute({
          sql,
          args: [
            digest,
            selected.candidateId,
            handoff.namespace,
            Date.now(),
            config.installationId,
            ...expected.map((a) => a.id),
          ],
        });
        assert.equal(written.rowsAffected, 1);
        report.syntheticLegacyFixtures ??= [];
        report.syntheticLegacyFixtures.push({
          kind: 'test-fixture',
          lessonVersion: 'forest-01-v1',
          candidateId: selected.candidateId,
          namespace: handoff.namespace,
          installationId: config.installationId,
          contentDigest: digest,
          personaCount: 7,
          noHumanApproval: true,
        });
        save();
      } finally {
        client.close();
      }
    }
    let clock = Date.now(),
      legacyRun,
      observationId,
      lastBackup,
      pairMetadata;
    async function setClock(at) {
      assert(at >= clock);
      await c('/clock', { at });
      clock = at;
    }
    const nextDay = () =>
      Math.floor((clock - 7200000) / 86400000) * 86400000 +
      7200000 +
      86400000 +
      1000;
    async function run(id, ears, task) {
      const startedAt = Date.now();
      try {
        const result = await task();
        report.scenarios.push({
          id,
          ears,
          outcome: 'PASS',
          startedAt,
          endedAt: Date.now(),
          evidence: result,
        });
        save();
      } catch (error) {
        report.scenarios.push({
          id,
          ears,
          outcome: 'FAIL',
          startedAt,
          endedAt: Date.now(),
          message: String(error.message).slice(0, 1000),
        });
        save();
        throw error;
      }
    }
    await run(
      'J01-private-cli-paired-archive',
      ['R4-E-004', '005', '015'],
      async () => {
        // Preserve ordinary forest V1 assignment and run before snapshots. No preview API.
        const child = accounts.get('child-a').id,
          prefix = '/api/pilot/children/' + child;
        let r = await request('parent-a', 'PUT', prefix + '/onboarding', {
          nickname: 'QA jobs child',
          experience: 'new',
          audioReady: false,
        });
        assert.equal(r.status, 200);
        r = await request('parent-a', 'POST', prefix + '/assignments', {
          lessonVersion: 'forest-01-v1',
        });
        assert.equal(
          r.status,
          409,
          'unreleased V1 denies assignment before synthetic fixture',
        );
        assert.equal(r.body.error.code, 'LESSON_NOT_RELEASED');
        await legacyFixture(manifest);
        r = await request('parent-a', 'POST', prefix + '/assignments', {
          lessonVersion: 'forest-01-v1',
        });
        assert(
          [200, 201].includes(r.status),
          'synthetic V1 assignment status=' +
            r.status +
            ' code=' +
            r.body.error?.code,
        );
        r = await request('child-a', 'POST', prefix + '/runs', {
          lessonVersion: 'forest-01-v1',
        });
        assert([200, 201].includes(r.status));
        legacyRun = r.body;
        assert.equal(legacyRun.state.stepId, 'welcome');
        const commands = [];
        for (const kind of ['backup', 'monitor']) {
          const result = await childResult(
            process.execPath,
            [
              '--experimental-strip-types',
              path.join(manifest.snapshot, 'scripts/pilot-ops.mjs'),
              kind,
              '--config',
              handoff.operations.configFile,
            ],
            { cwd: manifest.snapshot },
          );
          assert.equal(result.code, 0, 'actual private CLI exit');
          assert.equal(result.stderr, '');
          assert(!result.stdout.includes(privateData.token));
          const value = JSON.parse(result.stdout);
          assert.equal(
            value.status,
            kind === 'backup' ? 'verified' : 'succeeded',
          );
          commands.push({ kind, exitCode: result.code, result: value });
          if (kind === 'backup') lastBackup = value.jobId;
        }
        const pair = await verifyPair(handoff, control, lastBackup);
        const status = await request(
          'operator',
          'GET',
          '/api/pilot/ops/status',
        );
        assert.equal(status.status, 200);
        assert.equal(status.body.status.monitorState, 'healthy');
        const observation = {
          kind: 'synthetic',
          participantLabel: 'anonymous QA fixture',
          candidateId: handoff.candidateId,
          lessonVersion: 'forest-01-v4',
          contentDigest: handoff.contentDigest,
          observedAt: Date.now(),
          device: 'Synthetic Node HTTP fixture',
          browser: 'No browser observation',
          parentAgreementRef: 'synthetic-not-human',
          tasks: ['private job recovery'],
          completion: 'partial',
          savedRecapRef: null,
          adultHelp: 'Not observed',
          interruptions: 'Not observed',
          observedBehavior: 'QA_PRIVATE_JOB_OBSERVATION',
          observerInterpretation:
            'Synthetic operational test; no human acceptance',
          laterRecall: { status: 'not-run' },
        };
        r = await request('operator', 'POST', '/api/pilot/ops/observations', {
          requestId: crypto.randomUUID(),
          observation,
        });
        assert.equal(r.status, 200);
        observationId = r.body.recordId;
        assert(opaque(observationId));
        evidence('J01-cli', {
          commands,
          pair,
          legacyRunId: legacyRun.runId,
          observationId,
        });
        return { commands, pair };
      },
    );
    await run(
      'J02-concurrent-lease-and-replay',
      ['R4-E-003', '004'],
      async () => {
        await setClock(nextDay());
        const before = await c('/inspect', { kind: 'counts' });
        await c('/hold', { stage: 'after-lease', enabled: true });
        let first;
        try {
          first = c('/dispatch', { kind: 'backup' });
          const deadline = Date.now() + 5000;
          let observedLease;
          while (Date.now() < deadline) {
            observedLease = await c('/inspect', { kind: 'counts' });
            if (
              observedLease.counts.ops_job_event ===
              before.counts.ops_job_event + 1
            )
              break;
            await delay(50);
          }
          assert.equal(
            observedLease.counts.ops_job_event,
            before.counts.ops_job_event + 1,
            'first lease durable before concurrent duplicate',
          );
          const duplicate = await c('/dispatch', { kind: 'backup' });
          assert.equal(duplicate.status, 'running');
          const held = await c('/inspect', {
            kind: 'job',
            id: duplicate.jobId,
          });
          assert.equal(held.admission, 'busy');
          assert.equal(held.job.revision, 1);
          assert.equal(held.job.archives.length, 0);
          const during = await c('/inspect', { kind: 'counts' });
          assert.equal(during.counts.ops_job, before.counts.ops_job + 1);
          assert.equal(
            during.counts.ops_job_event,
            before.counts.ops_job_event + 1,
          );
          await c('/hold', { stage: 'after-lease', enabled: false });
          const settled = await first;
          assert.equal(settled.status, 'verified');
          assert.equal(settled.jobId, duplicate.jobId);
          const replay = await c('/dispatch', { kind: 'backup' });
          assert.deepEqual(replay, settled);
          lastBackup = settled.jobId;
          return { jobId: lastBackup, during, settled };
        } finally {
          await c('/hold', { stage: 'after-lease', enabled: false });
          if (first) await first;
        }
      },
    );
    await run(
      'J03-uncertain-effects-and-final-commit',
      ['R4-E-003', '004', '005'],
      async () => {
        const results = [];
        for (const [stage, mode] of [
          ['upload', 'ack-lost'],
          ['commit', 'final-constraint'],
        ]) {
          await setClock(nextDay());
          await c('/fault', { stage, mode });
          const uncertain = await c('/dispatch', { kind: 'backup' });
          assert.equal(uncertain.status, 'uncertain');
          const held = await c('/inspect', {
            kind: 'job',
            id: uncertain.jobId,
          });
          assert.equal(held.job.archives.length, 0);
          const filesBefore = fs
            .readdirSync(handoff.operations.archiveRoot)
            .filter((v) => v.endsWith('.hanzi'))
            .sort((a, b) => String(a).localeCompare(String(b)));
          await c('/fault', { stage, mode: 'none' });
          const reconcile = await c('/dispatch', {
            kind: 'reconcile',
            subjectJobId: uncertain.jobId,
          });
          assert.equal(reconcile.status, 'succeeded');
          const saved = await c('/inspect', {
            kind: 'job',
            id: uncertain.jobId,
          });
          assert.equal(saved.job.status, 'succeeded');
          assert.equal(saved.job.archives.length, 2);
          assert.deepEqual(
            fs
              .readdirSync(handoff.operations.archiveRoot)
              .filter((v) => v.endsWith('.hanzi'))
              .sort((a, b) => String(a).localeCompare(String(b))),
            filesBefore,
          );
          const pair = await verifyPair(handoff, control, uncertain.jobId);
          lastBackup = uncertain.jobId;
          results.push({ stage, mode, jobId: lastBackup, reconcile, pair });
        }
        return results;
      },
    );
    await run('J04-freshness-and-last-good', ['R4-E-001', '006'], async () => {
      const list = await c('/inspect', { kind: 'archives' });
      pairMetadata = list.archives.filter((a) => a.jobId === lastBackup);
      assert.equal(pairMetadata.length, 2);
      const dataAt = Math.min(...pairMetadata.map((a) => a.dataAt));
      await setClock(dataAt + 26 * 3600000);
      await c('/dispatch', { kind: 'monitor' });
      let status = await request('operator', 'GET', '/api/pilot/ops/status');
      assert.equal(status.status, 200);
      assert.equal(status.body.status.backupAgeMs, 93600000);
      assert.equal(status.body.status.monitorState, 'healthy');
      await setClock(clock + 1);
      status = await request('operator', 'GET', '/api/pilot/ops/status');
      assert.equal(status.body.status.backupAgeMs, 93600001);
      assert.equal(status.body.status.monitorState, 'unhealthy');
      assert(
        status.body.status.alerts.some((a) => a.code === 'OPS_BACKUP_STALE'),
      );
      assert.equal(status.body.status.lastBackupDataAt, dataAt);
      await setClock(clock + 60000);
      await c('/fault', { stage: 'monitor', mode: 'unavailable' });
      const failed = await c('/dispatch', { kind: 'monitor' });
      assert.equal(failed.status, 'uncertain');
      await c('/fault', { stage: 'monitor', mode: 'none' });
      const unknown = await request('operator', 'GET', '/api/pilot/ops/status');
      assert.equal(unknown.status, 200);
      assert.equal(unknown.body.status.monitorState, 'unknown');
      assert.equal(unknown.body.status.lastBackupDataAt, dataAt);
      const archives = await c('/inspect', { kind: 'archives' });
      assert.equal(
        archives.archives.filter((a) => a.jobId === lastBackup && !a.deleted)
          .length,
        2,
      );
      return { dataAt, boundaryAge: 93600000, staleAge: 93600001, failed };
    });
    await run(
      'J05-daily-weekly-retention-and-unrelated-file',
      ['R4-E-005', '007'],
      async () => {
        const unrelated = path.join(
          handoff.operations.archiveRoot,
          'qa-unverified-object.hanzi',
        );
        fs.writeFileSync(unrelated, 'synthetic unrelated object', {
          mode: 0o600,
          flag: 'wx',
        });
        const sentinelHash = hash(fs.readFileSync(unrelated));
        for (let day = 0; day < 31; day++) {
          await setClock(nextDay());
          const saved = await c('/dispatch', { kind: 'backup' });
          assert.equal(saved.status, 'verified');
          lastBackup = saved.jobId;
        }
        const before = (await c('/inspect', { kind: 'archives' })).archives;
        const grouped = new Map();
        for (const a of before.filter((a) => !a.deleted)) {
          const value = grouped.get(a.jobId) ?? [];
          value.push(a);
          grouped.set(a.jobId, value);
        }
        const points = [...grouped]
          .map(([id, values]) => ({ id, slot: values[0].dailySlot, values }))
          .sort(
            (a, b) => b.slot.localeCompare(a.slot) || a.id.localeCompare(b.id),
          );
        const expected = new Set(
          [
            ...points.slice(0, 7),
            ...points
              .filter((p) => new Date(p.slot).getUTCDay() === 0)
              .slice(0, 4),
          ].map((p) => p.id),
        );
        const retainedJob = await c('/dispatch', { kind: 'retention' });
        assert.equal(retainedJob.status, 'succeeded');
        const after = (await c('/inspect', { kind: 'archives' })).archives;
        const live = new Set(
          after.filter((a) => !a.deleted).map((a) => a.jobId),
        );
        assert.deepEqual(
          [...live].sort((a, b) => String(a).localeCompare(String(b))),
          [...expected].sort((a, b) => String(a).localeCompare(String(b))),
        );
        assert(live.has(lastBackup));
        assert.equal(hash(fs.readFileSync(unrelated)), sentinelHash);
        for (const a of after) {
          const exists = fs.existsSync(
            path.join(handoff.operations.archiveRoot, a.objectRef + '.hanzi'),
          );
          assert.equal(exists, !a.deleted);
        }
        const pair = await verifyPair(handoff, control, lastBackup);
        evidence('J05-retention', {
          pointCount: points.length,
          kept: [...live].sort((a, b) => String(a).localeCompare(String(b))),
          deleted: points.length - live.size,
          unrelatedPreserved: true,
          pair,
        });
        fs.unlinkSync(unrelated);
        return {
          pointCount: points.length,
          keptCount: live.size,
          deleted: points.length - live.size,
          unrelatedPreserved: true,
        };
      },
    );
    await run(
      'J06-encrypted-fresh-recovery-and-conservative-faults',
      ['R4-E-008', '012'],
      async () => {
        const results = [];
        for (const fault of [
          'wrong-key',
          'tag-corrupt',
          'metadata-corrupt',
          'payload-checksum',
        ]) {
          const r = await special('/restore', { jobId: lastBackup, fault });
          assert.equal(r.status, 200);
          assert.equal(r.body.status, 'refused');
          assert.equal(r.body.destinationsCreated, 0);
          if (fault === 'payload-checksum')
            assert.equal(r.body.code, 'BACKUP_CHECKSUM_INVALID');
          results.push(r.body);
        }
        for (const fault of [
          'learning-final-write',
          'operations-final-write',
          'learning-ack-lost',
          'operations-ack-lost',
          'none',
        ]) {
          const r = await special('/restore', { jobId: lastBackup, fault });
          assert.equal(r.status, 200);
          assert.equal(r.body.destinationsCreated, 2);
          assert.equal(r.body.readback.learning.sessionCount, 0);
          assert.equal(r.body.readback.learning.verificationCount, 0);
          assert.equal(r.body.readback.operations.currentJobCount, 0);
          if (fault === 'learning-final-write') {
            assert.equal(r.body.status, 'not-committed');
            assert.equal(r.body.readback.learning.counts.pilot_auth_user, 0);
          } else if (fault === 'operations-final-write') {
            assert.equal(r.body.status, 'partial');
            assert.equal(r.body.operations.error, 'OPS_RESTORE_NOT_COMMITTED');
            assert(r.body.readback.learning.counts.pilot_auth_user > 0);
            assert.equal(r.body.readback.operations.counts.ops_job, 0);
          } else {
            assert.equal(r.body.status, 'confirmed');
            assert.notEqual(
              r.body.installationId,
              handoff.operations.learningInstallationId,
            );
            assert.notEqual(
              r.body.opsInstallationId,
              handoff.operations.opsInstallationId,
            );
            if (fault === 'learning-ack-lost')
              assert.equal(
                r.body.learning.commit,
                'confirmed-after-uncertainty',
              );
            if (fault === 'operations-ack-lost')
              assert.equal(
                r.body.operations.commit,
                'confirmed-after-uncertainty',
              );
          }
          if (fault === 'none') {
            const base = loopback(r.body.baseURL),
              oldCookie = cookies.get(handoff.baseURL + ':operator');
            const denied = await request(
              'operator',
              'GET',
              '/api/pilot/ops/status',
              undefined,
              base,
              oldCookie,
            );
            assert.equal(denied.status, 401);
            const status = await request(
              'operator',
              'GET',
              '/api/pilot/ops/status',
              undefined,
              base,
            );
            assert.equal(status.status, 200);
            assert.equal(status.body.status.monitorState, 'unknown');
            assert.equal(status.body.status.lastVerifiedBackupAt, null);
            const detail = await request(
              'operator',
              'GET',
              '/api/pilot/ops/feedback/' + observationId,
              undefined,
              base,
            );
            assert.equal(detail.status, 200);
            assert.equal(detail.body.record.historical, true);
            assert.equal(detail.body.record.readOnly, true);
            assert.equal(detail.body.record.detailsRemoved, true);
            assert.equal(detail.body.record.details, null);
            const library = await request(
              'child-a',
              'GET',
              '/api/pilot/children/' + accounts.get('child-a').id + '/library',
              undefined,
              base,
            );
            assert.equal(library.status, 200);
            assert(library.body.items.every((item) => !item.available));
            results.push({
              fault,
              ...r.body,
              historicalOpsUnknown: true,
              oldCookieDenied: true,
              privateDetailsRemoved: true,
              noHistoricalStoryAuthority: true,
            });
          } else results.push({ fault, ...r.body });
        }
        evidence('J06-recovery', results);
        return results;
      },
    );
    await run(
      'J07-distinct-retained-process-rollback-and-backup',
      ['R4-E-009'],
      async () => {
        const refused = await special('/rollback', { target: 'incompatible' });
        assert.equal(refused.status, 503);
        assert.equal(refused.body.error, 'OPS_ROLLBACK_INCOMPATIBLE');
        const healthBefore = await fetch(
          new URL('/api/pilot/health', handoff.baseURL),
        );
        assert.equal(
          (await healthBefore.json()).candidateId,
          manifest.candidateId,
        );
        const rolled = await special('/rollback', { target: 'retained' });
        assert.equal(rolled.status, 200);
        assert.equal(rolled.body.to, retained.candidateId);
        assert.notEqual(rolled.body.from, rolled.body.to);
        assert.equal(
          rolled.body.installationId,
          handoff.operations.learningInstallationId,
        );
        assert.equal(rolled.body.preflight.status, 'compatible');
        const child = accounts.get('child-a').id,
          prefix = '/api/pilot/children/' + child + '/runs/' + legacyRun.runId;
        let saved = await request('child-a', 'GET', prefix);
        assert.equal(saved.status, 200);
        assert.equal(saved.body.revision, 0);
        const eventId = crypto.randomUUID();
        const action = {
          eventId,
          expectedRevision: 0,
          stepId: 'welcome',
          type: 'continue',
          payload: {},
        };
        const oldBinding = await request(
          'child-a',
          'POST',
          prefix + '/actions',
          action,
        );
        assert.equal(
          oldBinding.status,
          409,
          'old R4 synthetic release must not authorize retained R3 write',
        );
        assert.equal(oldBinding.body.error.code, 'LESSON_NOT_RELEASED');
        await legacyFixture(retained);
        const write = await request(
          'child-a',
          'POST',
          prefix + '/actions',
          action,
        );
        assert.equal(write.status, 200);
        assert.equal(write.body.revision, 1);
        assert.equal(write.body.state.questionId, 'fam-mu');
        const replay = await request(
          'child-a',
          'POST',
          prefix + '/actions',
          action,
        );
        assert.equal(replay.status, 200);
        assert.deepEqual(replay.body, write.body);
        const read = await request('parent-a', 'GET', prefix);
        assert.equal(read.status, 200);
        assert.equal(read.body.revision, 1);
        const foreign = await request('parent-b', 'GET', prefix);
        assert.equal(foreign.status, 404);
        await setClock(nextDay());
        const backup = await c('/dispatch', { kind: 'backup' });
        assert.equal(backup.status, 'verified');
        const pair = await verifyPair(
          {
            ...handoff,
            candidateId: retained.candidateId,
            sourceDigest: 'sha256:' + retained.digest,
            artifactDigest: 'sha256:' + retained.artifactDigest,
          },
          control,
          backup.jobId,
        );
        const current = await special('/rollback', { target: 'current' });
        assert.equal(current.status, 200);
        assert.equal(current.body.to, manifest.candidateId);
        saved = await request('child-a', 'GET', prefix);
        assert.equal(saved.status, 200);
        assert.equal(saved.body.revision, 1);
        const finalHealth = await fetch(
          new URL('/api/pilot/health', handoff.baseURL),
        );
        assert.equal(
          (await finalHealth.json()).candidateId,
          manifest.candidateId,
        );
        return {
          rolled: rolled.body,
          current: current.body,
          legacyRunId: legacyRun.runId,
          persistedRevision: 1,
          foreignStatus: foreign.status,
          pair,
        };
      },
    );
    report.status = 'PASS';
    return report;
  } catch (error) {
    report.status = 'FAIL';
    if (!report.scenarios.some((s) => s.outcome === 'FAIL'))
      report.infrastructureError = String(error.message).slice(0, 1000);
    throw error;
  } finally {
    if (runner && runner.exitCode === null) {
      runner.kill('SIGINT');
      await Promise.race([runnerExit, delay(20000)]);
      if (runner.exitCode === null) {
        runner.kill('SIGTERM');
        await Promise.race([runnerExit, delay(10000)]);
      }
    }
    runtimeLog.end();
    report.finishedAt = Date.now();
    report.cleanup = {
      runnerExited: runner ? runner.exitCode !== null : false,
    };
    if (handoff) {
      const cleanupFile = path.join(handoff.output, 'cleanup.json');
      if (fs.existsSync(cleanupFile))
        report.cleanup.runtime = JSON.parse(
          fs.readFileSync(cleanupFile, 'utf8'),
        );
      const opsCleanup = path.join(handoff.output, 'ops-cleanup.json');
      if (fs.existsSync(opsCleanup))
        report.cleanup.operations = JSON.parse(
          fs.readFileSync(opsCleanup, 'utf8'),
        );
    }
    if (privateData) {
      const secrets = [
        privateData.token,
        ...privateData.accounts.map((a) => a.password),
      ];
      const reportBytes = JSON.stringify(report);
      assert(!secrets.some((secret) => reportBytes.includes(secret)));
      privateData = null;
    }
    save();
    verifyNodeManifest(manifest, { built: true });
    verifyNodeManifest(retained, { built: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = await runJobsSuite(args(process.argv.slice(2)));
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        candidateId: report.candidateId,
        scenarios: report.scenarios.length,
      }) + '\n',
    );
  } catch {
    process.stderr.write(
      'R4_JOBS_SUITE_FAILED; inspect redacted report.json\n',
    );
    process.exitCode = 1;
  }
}
