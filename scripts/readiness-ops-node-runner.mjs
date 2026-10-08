/** Owned R4 runtime: separate synthetic learning/ops databases and private controls. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  prepareNodeCandidate,
  verifyNodeManifest,
  freePort,
  launched,
  runtimeEnvironment,
  bounded,
  jsonFile,
} from './readiness-node-runner.mjs';
import { serveStoryNodeCandidate } from './readiness-story-node-runner.mjs';
import { initializeOpsLibsql } from './pilot-ops-libsql.mjs';
import { PrivateArchiveStore } from './pilot-ops-archive.mjs';
import { createOpsExecutor, safeOpsCode } from './pilot-ops-jobs.mjs';
import { createOwnedOpsRecovery } from './readiness-ops-recovery.mjs';
import {
  preflightOpsRollback,
  opsCompatibility,
  assertRollbackCompatibility,
} from './pilot-ops-recovery.mjs';

const exact = (value, fields) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((k) => Object.hasOwn(value, k));
const id = (s) => typeof s === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(s);
export function opsCandidateBindings({
  name,
  binding,
  databaseURL,
  scope,
  clock,
  testFault = '',
}) {
  return {
    HANZI_OPS_DATABASE_URL: binding === 'missing' ? '' : databaseURL,
    HANZI_OPS_ALLOW_LOCAL_DATABASE: '1',
    HANZI_OPS_ENVIRONMENT: scope.environment,
    HANZI_OPS_TEST_NOW: name === 'app' && clock !== null ? String(clock) : '',
    HANZI_OPS_TEST_FAULT: name === 'app' ? testFault : '',
  };
}
export function validateOpsControl(route, body) {
  let valid = false;
  if (route === '/dispatch')
    valid =
      (exact(body, ['kind']) &&
        ['backup', 'monitor', 'retention'].includes(body.kind)) ||
      (exact(body, ['kind', 'subjectJobId']) &&
        body.kind === 'reconcile' &&
        id(body.subjectJobId));
  else if (route === '/clock')
    valid =
      exact(body, ['at']) &&
      Number.isSafeInteger(body.at) &&
      body.at >= 0 &&
      body.at <= 253402300799999;
  else if (route === '/binding')
    valid =
      exact(body, ['state']) &&
      ['available', 'missing', 'unavailable'].includes(body.state);
  else if (route === '/restart')
    valid =
      exact(body, ['service']) &&
      ['app', 'learning-database', 'ops-database', 'all'].includes(
        body.service,
      );
  else if (route === '/inspect')
    valid =
      (exact(body, ['kind']) &&
        ['counts', 'installation', 'archives'].includes(body.kind)) ||
      (exact(body, ['kind', 'id']) &&
        ['record', 'job'].includes(body.kind) &&
        id(body.id));
  else if (route === '/archive-readback')
    valid = exact(body, ['jobId']) && id(body.jobId);
  else if (route === '/restore')
    valid =
      exact(body, ['jobId', 'fault']) &&
      id(body.jobId) &&
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
      ].includes(body.fault);
  else if (route === '/rollback')
    valid =
      exact(body, ['target']) &&
      ['retained', 'current', 'incompatible'].includes(body.target);
  else if (route === '/fault')
    valid =
      exact(body, ['stage', 'mode']) &&
      ((['upload', 'readback', 'delete'].includes(body.stage) &&
        ['none', 'unavailable', 'ack-lost'].includes(body.mode)) ||
        (body.stage === 'commit' &&
          ['none', 'final-constraint', 'ack-lost'].includes(body.mode)) ||
        (['feedback', 'alert'].includes(body.stage) &&
          ['none', 'final-constraint'].includes(body.mode)) ||
        (body.stage === 'monitor' &&
          ['none', 'unavailable', 'probe-failed'].includes(body.mode)));
  else if (route === '/hold')
    valid =
      exact(body, ['stage', 'enabled']) &&
      ['after-lease', 'before-readback', 'before-commit'].includes(
        body.stage,
      ) &&
      typeof body.enabled === 'boolean';
  if (!valid) throw new Error('Invalid named R4 control');
  return true;
}

export async function operationsFactory(
  parent,
  { retainedManifest = null } = {},
) {
  const {
    manifest,
    output,
    client: learningClient,
    scope: learningScope,
    token,
    binary,
    createClient,
    restart,
    record,
    urls,
    archiveIssuers,
  } = parent;
  verifyNodeManifest(manifest, { built: true });
  if (!['r4', 'r5'].includes(manifest.phase))
    throw new Error('Frozen R4/R5 candidate required');
  const privateRoot = fs.mkdtempSync(path.join(manifest.work, 'ops-private-'));
  fs.chmodSync(privateRoot, 0o700);
  fs.writeFileSync(path.join(privateRoot, '.hanzi-qa-owned'), manifest.runId, {
    mode: 0o600,
  });
  const state = fs.mkdtempSync(path.join(manifest.work, 'ops-libsql-'));
  fs.writeFileSync(path.join(state, '.hanzi-qa-owned'), manifest.runId, {
    mode: 0o600,
  });
  const archiveRoot = path.join(privateRoot, 'objects');
  fs.mkdirSync(archiveRoot, { mode: 0o700 });
  const keyRingFile = path.join(privateRoot, 'keys.json');
  const keyFile = path.join(privateRoot, 'active-key.bin'),
    learningTokenFile = path.join(privateRoot, 'learning.token'),
    operationsTokenFile = path.join(privateRoot, 'operations.token'),
    configFile = path.join(privateRoot, 'operations.json'),
    cliManifest = path.join(privateRoot, 'manifest.json'),
    archiveIssuersFile = path.join(privateRoot, 'archive-issuers.json');
  const activeKeyId = 'qa-r4-' + crypto.randomUUID(),
    key = crypto.randomBytes(32),
    keys = new Map([[activeKeyId, key]]);
  fs.writeFileSync(
    keyRingFile,
    JSON.stringify({
      format: 'pilot-ops-keys-1',
      activeKeyId,
      keys: [{ id: activeKeyId, value: key.toString('base64url') }],
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const port = await freePort(),
    databaseURL = 'http://127.0.0.1:' + port;
  const operationsClient = createClient({
    url: databaseURL,
    intMode: 'number',
  });
  const scope = {
    environment: 'synthetic',
    installationId: learningScope.installationId,
    opsInstallationId: crypto.randomUUID(),
  };
  fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
  for (const file of [learningTokenFile, operationsTokenFile])
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), {
      mode: 0o600,
      flag: 'wx',
    });
  fs.writeFileSync(cliManifest, JSON.stringify(manifest), {
    mode: 0o600,
    flag: 'wx',
  });
  fs.writeFileSync(
    archiveIssuersFile,
    JSON.stringify(
      archiveIssuers.map((issuer) => ({
        issuerId: issuer.issuerId,
        publicKeyJwk: issuer.publicKeyJwk,
        purpose: issuer.purpose,
        revokedAt: issuer.revokedAt,
        notBefore: issuer.notBefore,
      })),
    ),
    { mode: 0o600, flag: 'wx' },
  );
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      format: 'pilot-ops-config-1',
      ...scope,
      localSynthetic: true,
      manifestPath: cliManifest,
      learningURL: urls.database,
      operationsURL: databaseURL,
      healthURL: urls.app + '/api/pilot/health',
      learningTokenFile,
      operationsTokenFile,
      activeKeyId,
      keyFiles: { [activeKeyId]: keyFile },
      archiveIssuersFile,
      archiveRoot,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  let processHandle = null,
    control = null,
    clock = null,
    binding = 'available',
    closing = false,
    restartInProgress = false;
  let recovery = null,
    application = manifest;
  const buildOf = (m) => ({
    candidateId: m.candidateId,
    sourceDigest: 'sha256:' + m.digest,
    artifactDigest: 'sha256:' + m.artifactDigest,
  });
  const resolveBuild = (candidateId) =>
    [manifest, retainedManifest]
      .filter(Boolean)
      .find((m) => m.candidateId === candidateId);
  if (retainedManifest) verifyNodeManifest(retainedManifest, { built: true });
  const now = () => clock ?? Date.now();
  const jobs = new Set(),
    barriers = new Map(),
    faults = {
      upload: 'none',
      readback: 'none',
      commit: 'none',
      delete: 'none',
      monitor: 'none',
      feedback: 'none',
      alert: 'none',
    };
  const operationLog = [];
  const note = (operation, result) => {
    operationLog.push({ operation, at: new Date().toISOString(), ...result });
    jsonFile(path.join(output, 'ops-operations.json'), operationLog);
  };
  async function startDatabase() {
    if (processHandle) return;
    if (
      fs.realpathSync(state) !== state ||
      !state.startsWith(manifest.work + path.sep) ||
      fs.readFileSync(path.join(state, '.hanzi-qa-owned'), 'utf8') !==
        manifest.runId
    )
      throw new Error('Ops owned state changed');
    const service = launched(
      binary,
      [
        '--db-path',
        state,
        '--http-listen-addr',
        `127.0.0.1:${port}`,
        '--no-welcome',
        '--disable-metrics',
      ],
      {
        cwd: manifest.work,
        env: runtimeEnvironment(),
        log: path.join(output, 'ops-sqld.log'),
      },
    );
    processHandle = service;
    record('start', 'operations-database', service);
    for (let n = 0; n < 100; n++) {
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned operations database exited');
      try {
        await bounded(
          operationsClient.execute('SELECT 1'),
          1000,
          'Operations database readiness',
        );
        return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Owned operations database readiness timed out');
  }
  async function stopDatabase() {
    if (processHandle) {
      const service = processHandle;
      await service.stop();
      record('stop', 'operations-database', service);
      processHandle = null;
    }
  }
  async function barrier(name) {
    const current = barriers.get(name);
    if (current) {
      current.entered++;
      await bounded(current.promise, 45000, 'Owned job barrier');
    }
  }
  function fault(code = 'OPS_EFFECT_UNCONFIRMED') {
    const e = new Error(code);
    e.code = code;
    throw e;
  }
  const effects = {
    afterLease: () => barrier('after-lease'),
    beforeUpload: async () => {
      if (faults.upload === 'unavailable') fault();
    },
    afterUpload: async ({ kind }) => {
      if (faults.upload === 'ack-lost' && kind === 'operations') fault();
    },
    beforeReadback: async () => {
      await barrier('before-readback');
      if (faults.readback !== 'none') fault();
    },
    beforeCommit: async () => {
      await barrier('before-commit');
      if (faults.commit === 'final-constraint')
        await operationsClient.execute(
          "CREATE TRIGGER qa_r4_job_final BEFORE INSERT ON ops_job_event WHEN NEW.kind IN ('archive-verified','completed','reconciled') BEGIN SELECT RAISE(ABORT,'QA_R4_FINAL_CONSTRAINT'); END",
        );
    },
    afterCommit: async () => {
      if (faults.commit === 'ack-lost') fault();
    },
    beforeDelete: async () => {
      if (faults.delete === 'unavailable') fault();
    },
    afterDelete: async () => {
      if (faults.delete === 'ack-lost') fault();
    },
  };
  async function cleanup() {
    if (closing) return;
    closing = true;
    const errors = [];
    for (const value of barriers.values()) value.release();
    barriers.clear();
    try {
      await bounded(Promise.allSettled(jobs), 10000, 'Operations jobs cleanup');
    } catch {
      errors.push('OPS_PENDING_JOB');
    }
    if (control) {
      try {
        await bounded(
          new Promise((resolve) => control.close(resolve)),
          5000,
          'Operations control close',
        );
      } catch {
        control.closeAllConnections();
        errors.push('OPS_CONTROL_CLOSE');
      }
    }
    if (recovery) {
      try {
        await recovery.cleanup();
      } catch {
        errors.push('OPS_RECOVERY_STOP');
      }
    }
    try {
      await stopDatabase();
    } catch {
      errors.push('OPS_PROCESS_STOP');
    }
    operationsClient.close();
    for (const file of [
      keyRingFile,
      keyFile,
      learningTokenFile,
      operationsTokenFile,
      configFile,
    ])
      fs.rmSync(file, { force: true });
    for (const value of keys.values()) value.fill(0);
    keys.clear();
    jsonFile(path.join(output, 'ops-cleanup.json'), {
      ownedProcessesStopped: processHandle === null,
      keyFileRemoved: [
        keyRingFile,
        keyFile,
        learningTokenFile,
        operationsTokenFile,
        configFile,
      ].every((file) => !fs.existsSync(file)),
      stateRetained: state,
      ciphertextRetained: archiveRoot,
      errors,
    });
    if (errors.length) throw new Error('Operations cleanup incomplete');
  }
  try {
    await startDatabase();
    await initializeOpsLibsql({
      client: operationsClient,
      sourceRoot: manifest.snapshot,
      scope,
    });
    const installedOps = await operationsClient.execute(
      'SELECT schema_version FROM ops_installation WHERE id=1',
    );
    const schemaVersion = String(installedOps.rows[0].schema_version);
    const archiveStore = new PrivateArchiveStore(archiveRoot);
    const executor = await createOpsExecutor({
      sourceRoot: manifest.snapshot,
      learningClient,
      operationsClient,
      scope,
      archiveStore,
      keys,
      activeKeyId,
      archiveIssuers,
      now,
      build: () => buildOf(application),
      resolveBuild: (candidateId) => {
        const m = resolveBuild(candidateId);
        return m ? buildOf(m) : null;
      },
      effects,
      probe: async () => {
        if (faults.monitor === 'unavailable') fault('OPS_MONITOR_UNKNOWN');
        const response = await fetch(urls.app + '/api/pilot/health', {
          signal: AbortSignal.timeout(5000),
        });
        if (faults.monitor === 'probe-failed') return 'unhealthy';
        if (!response.ok) return 'unhealthy';
        const body = await response.json();
        return body.candidateId === application.candidateId
          ? 'healthy'
          : 'unhealthy';
      },
    });
    recovery = createOwnedOpsRecovery(parent, {
      executor,
      archiveStore,
      keys,
      scope,
      now,
      resolveBuild: (candidateId) => {
        const m = resolveBuild(candidateId);
        return m ? buildOf(m) : null;
      },
    });
    jsonFile(
      path.join(output, 'ops-compatibility.json'),
      opsCompatibility(manifest),
    );
    async function inspect(body) {
      if (body.kind === 'installation') return scope;
      if (body.kind === 'archives')
        return {
          archives: await executor.store.listVerifiedArchives(
            executor.context(),
          ),
        };
      if (body.kind === 'job')
        return executor.store.readJobForReconcile(executor.context(), body.id);
      if (body.kind === 'counts') {
        const names = [
          'ops_job',
          'ops_job_event',
          'ops_archive',
          'ops_alert_event',
          'ops_feedback',
          'ops_feedback_event',
          'ops_installation',
          'ops_schema_history',
        ];
        const results = await operationsClient.batch(
          names.map((table) => ({
            sql: `SELECT COUNT(*) AS n FROM ${table}`,
            args: [],
          })),
          'read',
        );
        return {
          counts: Object.fromEntries(
            names.map((name, i) => [name, Number(results[i].rows[0].n)]),
          ),
        };
      }
      const result = await operationsClient.batch(
        [
          {
            sql: 'SELECT id,revision,status,request_id,details_removed_at FROM ops_feedback WHERE id=?',
            args: [body.id],
          },
          {
            sql: 'SELECT id,sequence,kind,request_id,redacted_at FROM ops_feedback_event WHERE record_id=? ORDER BY sequence',
            args: [body.id],
          },
          {
            sql: 'SELECT COUNT(*) AS n FROM ops_feedback f JOIN ops_feedback original ON f.environment=original.environment AND f.installation_id=original.installation_id AND f.ops_installation_id=original.ops_installation_id AND f.actor_key=original.actor_key AND f.request_id=original.request_id WHERE original.id=?',
            args: [body.id],
          },
        ],
        'read',
      );
      const recordRow = result[0].rows[0];
      if (!recordRow) return { record: null };
      return {
        record: Object.fromEntries(Object.entries(recordRow)),
        revision: Number(recordRow.revision),
        events: result[1].rows.map((row) =>
          Object.fromEntries(Object.entries(row)),
        ),
        matchingRequestCount: Number(result[2].rows[0].n),
        matchingSubmissionEventCount: result[1].rows.filter(
          (r) =>
            r.kind === 'submitted' && r.request_id === recordRow.request_id,
        ).length,
      };
    }
    control = http.createServer(async (request, response) => {
      const send = (status, value) =>
        response
          .writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          .end(JSON.stringify(value));
      if (
        request.method !== 'POST' ||
        request.headers['x-hanzi-test-token'] !== token
      )
        return send(403, { error: 'OPS_CONTROL_DENIED' });
      if (closing || restartInProgress)
        return send(503, { error: 'OPS_RUNNER_BUSY' });
      let body;
      try {
        let text = '';
        for await (const chunk of request) {
          text += chunk;
          if (text.length > 4096) throw new Error();
        }
        body = JSON.parse(text || '{}');
        validateOpsControl(request.url, body);
      } catch {
        return send(400, { error: 'OPS_CONTROL_INVALID' });
      }
      try {
        if (request.url === '/inspect') return send(200, await inspect(body));
        if (request.url === '/archive-readback') {
          const admission = await executor.store.readJobForReconcile(
            executor.context(),
            body.jobId,
          );
          return send(200, {
            jobId: body.jobId,
            objects: admission.objects,
            archives: await executor.readPair(admission),
          });
        }
        if (request.url === '/fault') {
          faults[body.stage] = body.mode;
          if (['feedback', 'alert'].includes(body.stage)) {
            const other = body.stage === 'feedback' ? 'alert' : 'feedback';
            faults[other] = 'none';
            restartInProgress = true;
            try {
              await restart('app');
            } finally {
              restartInProgress = false;
            }
          }
          return send(200, { ...body });
        }
        if (request.url === '/hold') {
          if (body.enabled && !barriers.has(body.stage)) {
            let release;
            const promise = new Promise((resolve) => {
              release = resolve;
            });
            barriers.set(body.stage, { promise, release, entered: 0 });
          } else if (!body.enabled && barriers.has(body.stage)) {
            barriers.get(body.stage).release();
            barriers.delete(body.stage);
          }
          return send(200, { ...body });
        }
        if (request.url === '/dispatch') {
          const running = executor
            .dispatch(
              body.kind,
              body.kind === 'reconcile'
                ? { subjectJobId: body.subjectJobId }
                : {},
            )
            .finally(async () => {
              try {
                await operationsClient.execute(
                  'DROP TRIGGER IF EXISTS qa_r4_job_final',
                );
              } catch {}
            });
          jobs.add(running);
          try {
            const result = await running;
            note('dispatch', { kind: body.kind, ...result });
            return send(200, result);
          } finally {
            jobs.delete(running);
          }
        }
        restartInProgress = true;
        try {
          if (request.url === '/restore') {
            if (jobs.size) return send(409, { error: 'OPS_JOB_BUSY' });
            const result = await recovery.restore(body);
            note('restore', {
              status: result.status,
              code: result.code ?? null,
              destinationsCreated: result.destinationsCreated,
            });
            return send(200, result);
          }
          if (request.url === '/rollback') {
            if (jobs.size) return send(409, { error: 'OPS_JOB_BUSY' });
            if (body.target === 'incompatible') {
              const current = opsCompatibility(application, manifest.snapshot);
              assertRollbackCompatibility(current, {
                ...current,
                candidateId: 'incompatible-future',
                learningMigrations: [],
              });
            }
            const selected =
              body.target === 'retained' ? retainedManifest : manifest;
            if (!selected)
              return send(409, { error: 'OPS_ROLLBACK_NOT_CONFIGURED' });
            const preflight = await preflightOpsRollback({
              currentManifest: application,
              targetManifest: selected,
              operationsSourceRoot: manifest.snapshot,
              learningClient,
              operationsClient,
              scope,
              archiveIssuers,
              now: now(),
            });
            const previous = application;
            application = selected;
            try {
              await restart('app');
            } catch (error) {
              application = previous;
              await restart('app');
              throw error;
            }
            note('rollback', {
              from: previous.candidateId,
              to: application.candidateId,
            });
            return send(200, {
              status: 'replaced',
              from: previous.candidateId,
              to: application.candidateId,
              installationId: scope.installationId,
              preflight,
            });
          }
          if (request.url === '/clock') {
            if (clock !== null && body.at < clock)
              return send(400, { error: 'OPS_CLOCK_BACKWARDS' });
            clock = body.at;
            await restart('app');
            return send(200, { at: clock });
          }
          if (request.url === '/binding') {
            binding = body.state;
            if (binding === 'unavailable') await stopDatabase();
            else await startDatabase();
            await restart('app');
            return send(200, { state: binding });
          }
          if (body.service === 'ops-database' || body.service === 'all') {
            await stopDatabase();
            await startDatabase();
          }
          if (body.service === 'all') await restart('all');
          else if (body.service === 'app') await restart('app');
          else if (body.service === 'learning-database')
            await restart('database');
          return send(200, { restarted: true, service: body.service });
        } finally {
          restartInProgress = false;
        }
      } catch (error) {
        const code = safeOpsCode(error);
        note('control-failure', { route: request.url, code });
        return send(503, { error: code });
      }
    });
    control.requestTimeout = 6000;
    control.headersTimeout = 6000;
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    return {
      application: (name) => (name === 'app' ? application : manifest),
      bindings: (name) =>
        opsCandidateBindings({
          name,
          binding,
          databaseURL,
          scope,
          clock,
          testFault:
            faults.feedback !== 'none'
              ? 'feedback-final-write'
              : faults.alert !== 'none'
                ? 'alert-final-write'
                : '',
        }),
      handoff: {
        ...scope,
        learningInstallationId: scope.installationId,
        controlURL: `http://127.0.0.1:${control.address().port}`,
        databaseURL,
        state,
        archiveRoot,
        keyRingFile,
        configFile,
        schemaVersion,
        dataVersion: manifest.phase === 'r5' ? 'r5-operations-1' : 'r4-data-2',
        localOnly: true,
        notification: 'unconfigured',
        rollbackCandidateId: retainedManifest?.candidateId ?? null,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === 'prepare' && process.argv.length === 3)
      await prepareNodeCandidate({ phase: 'r4' });
    else if (
      process.argv[2] === 'serve' &&
      (process.argv.length === 4 ||
        (process.argv.length === 6 &&
          process.argv[4] === '--rollback-manifest'))
    ) {
      const manifest = verifyNodeManifest(
        JSON.parse(fs.readFileSync(process.argv[3], 'utf8')),
        { built: true },
      );
      if (
        path.resolve(process.argv[1]) !==
        path.join(manifest.snapshot, 'scripts/readiness-ops-node-runner.mjs')
      )
        throw new Error('Run the frozen snapshot operations runner');
      const retainedManifest = process.argv[5]
        ? verifyNodeManifest(
            JSON.parse(fs.readFileSync(process.argv[5], 'utf8')),
            { built: true },
          )
        : null;
      await serveStoryNodeCandidate(process.argv[3], {
        operationsFactory: (parent) =>
          operationsFactory(parent, { retainedManifest }),
      });
    } else
      throw new Error(
        'Usage: readiness-ops-node-runner.mjs prepare | serve <manifest>',
      );
  } catch (error) {
    process.stderr.write(safeOpsCode(error) + '\n');
    process.exitCode = 1;
  }
}
