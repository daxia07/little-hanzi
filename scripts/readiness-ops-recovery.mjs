/** Named recovery effects for runner-owned synthetic databases only. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  freePort,
  launched,
  runtimeEnvironment,
  bounded,
} from './readiness-node-runner.mjs';
import { storyBindings } from './readiness-story-node-runner.mjs';
import { applyLibsqlMigrations } from './pilot-libsql-admin.mjs';
import { initializeOpsLibsql, captureOpsLibsql } from './pilot-ops-libsql.mjs';
import {
  restoreEncryptedPair,
  opsLearningAdapter,
} from './pilot-ops-recovery.mjs';
import { openArchive, sealArchive } from './pilot-ops-archive.mjs';
import { safeOpsCode } from './pilot-ops-jobs.mjs';

export function createOwnedOpsRecovery(parent, privateOptions) {
  const {
    manifest,
    binary,
    createClient,
    output,
    record,
    archiveIssuers,
    accounts,
  } = parent;
  const { executor, archiveStore, keys, scope, now, resolveBuild } =
    privateOptions;
  const owned = new Map(),
    clients = [],
    states = [];
  let sequence = 0;
  async function database(name) {
    const state = fs.mkdtempSync(path.join(manifest.work, 'ops-recovery-'));
    fs.chmodSync(state, 0o700);
    fs.writeFileSync(path.join(state, '.hanzi-qa-owned'), manifest.runId, {
      mode: 0o600,
    });
    states.push(state);
    const port = await freePort(),
      url = `http://127.0.0.1:${port}`;
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
        log: path.join(output, name + '.log'),
      },
    );
    owned.set(name, service);
    record('start', name, service);
    const client = createClient({ url, intMode: 'number' });
    clients.push(client);
    for (let i = 0; i < 100; i++) {
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned recovery database exited');
      try {
        await bounded(client.execute('SELECT 1'), 1000, 'Recovery readiness');
        return { client, url };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Owned recovery database unavailable');
  }
  function faultClient(client, fault, kind) {
    if (!fault.startsWith(kind + '-')) return client;
    return {
      execute: (...args) => client.execute(...args),
      async batch(statements, mode) {
        const sql =
          kind === 'learning'
            ? 'INSERT INTO pilot_curriculum_registry_state(id,revision,updated_at) VALUES(1,0,0)'
            : 'INSERT INTO ops_installation SELECT * FROM ops_installation';
        const result = await client.batch(
          fault.endsWith('final-write')
            ? [...statements, { sql, args: [] }]
            : statements,
          mode,
        );
        if (fault.endsWith('ack-lost'))
          throw new Error('Owned committed recovery acknowledgement lost');
        return result;
      },
    };
  }
  async function startRestoredApp(destination, n) {
    const port = await freePort(),
      baseURL = `http://127.0.0.1:${port}`,
      name = `ops-restored-app-${n}`;
    const authSecret = crypto.randomBytes(40).toString('base64url');
    const env = storyBindings({
      testing: true,
      port,
      databaseURL: destination.learningURL,
      candidateId: manifest.candidateId,
      authSecret,
      origin: baseURL,
      scope: { namespace: manifest.runId },
      trust: {},
      token: parent.token,
    });
    // No story capability or current issuer is installed by recovery. Ops clock is
    // guarded synthetic-only so expiration after restore is testable through HTTP.
    env.HANZI_STORY_CAPABILITY = '';
    env.HANZI_CURRICULUM_TRUST = '';
    Object.assign(env, {
      HANZI_OPS_DATABASE_URL: destination.operationsURL,
      HANZI_OPS_ALLOW_LOCAL_DATABASE: '1',
      HANZI_OPS_ENVIRONMENT: destination.scope.environment,
      HANZI_OPS_TEST_NOW: String(now()),
    });
    const service = launched(process.execPath, [manifest.nodeEntry], {
      cwd: manifest.snapshot,
      env,
      log: path.join(output, name + '.log'),
      secrets: [parent.token, authSecret, ...accounts.map((a) => a.password)],
    });
    owned.set(name, service);
    record('start', name, service);
    for (let i = 0; i < 100; i++) {
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned restored app exited');
      try {
        const r = await fetch(baseURL + '/api/pilot/health', {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok && (await r.json()).candidateId === manifest.candidateId)
          return baseURL;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Owned restored app unavailable');
  }
  async function restore({ jobId, fault }) {
    const n = ++sequence,
      before = states.length,
      startedAt = Date.now();
    const admission = await executor.store.readJobForReconcile(
      executor.context(),
      jobId,
    );
    let destination;
    const selectedStore = {
      get(objectId) {
        const original = archiveStore.get(objectId);
        if (
          !original ||
          fault === 'none' ||
          !['tag-corrupt', 'metadata-corrupt', 'payload-checksum'].includes(
            fault,
          )
        )
          return original;
        const envelope = JSON.parse(original.toString('utf8'));
        if (fault === 'tag-corrupt') {
          const tag = Buffer.from(envelope.tag, 'base64url');
          tag[0] ^= 1;
          envelope.tag = tag.toString('base64url');
        } else if (fault === 'metadata-corrupt')
          envelope.metadata.candidateId = 'foreign-build';
        else {
          const opened = openArchive({
              envelope,
              keys,
              expected: {
                environment: scope.environment,
                sourceInstallationId: scope.installationId,
                opsInstallationId: scope.opsInstallationId,
              },
            }),
            archive = JSON.parse(opened.bytes.toString('utf8'));
          archive.sha256 = '0'.repeat(64);
          const { plaintextDigest: _plaintextDigest, ...metadata } =
            envelope.metadata;
          return Buffer.from(
            JSON.stringify(
              sealArchive({
                bytes: Buffer.from(JSON.stringify(archive)),
                metadata,
                key: keys.get(metadata.keyId),
              }),
            ),
          );
        }
        return Buffer.from(JSON.stringify(envelope));
      },
    };
    let result;
    try {
      result = await restoreEncryptedPair(
        {
          sourceRoot: manifest.snapshot,
          archiveStore: selectedStore,
          keys: fault === 'wrong-key' ? new Map() : keys,
          sourceScope: scope,
          admission,
          resolveBuild,
          archiveIssuers,
          now,
          createDestination: async () => {
            const learning = await database(`ops-restore-learning-${n}`),
              operations = await database(`ops-restore-operations-${n}`);
            await applyLibsqlMigrations({
              client: learning.client,
              root: manifest.snapshot,
            });
            const install = await learning.client.execute(
              'SELECT installation_id FROM pilot_installation WHERE id=1',
            );
            const targetScope = {
              environment: scope.environment,
              installationId: String(install.rows[0].installation_id),
              opsInstallationId: crypto.randomUUID(),
            };
            await initializeOpsLibsql({
              client: operations.client,
              sourceRoot: manifest.snapshot,
              scope: targetScope,
              now: now(),
            });
            destination = {
              learningClient: learning.client,
              operationsClient: operations.client,
              learningURL: learning.url,
              operationsURL: operations.url,
              scope: targetScope,
            };
            return destination;
          },
        },
        {
          decorateLearning: (c) => faultClient(c, fault, 'learning'),
          decorateOperations: (c) => faultClient(c, fault, 'operations'),
        },
      );
    } catch (error) {
      return {
        status: destination ? 'unconfirmed' : 'refused',
        code: safeOpsCode(error),
        destinationsCreated: states.length - before,
        startedAt,
        endedAt: Date.now(),
      };
    }
    const learning = await opsLearningAdapter(manifest.snapshot).capture(
      destination.learningClient,
      destination.scope.installationId,
    );
    const operations = await captureOpsLibsql({
      client: destination.operationsClient,
      sourceRoot: manifest.snapshot,
      scope: destination.scope,
    });
    const readback = {
      learning: {
        sessionCount: learning.sessionCount,
        verificationCount: learning.verificationCount,
        counts: Object.fromEntries(
          Object.entries(learning.tables).map(([name, rows]) => [
            name,
            rows.length,
          ]),
        ),
      },
      operations: {
        counts: Object.fromEntries(
          Object.entries(operations.tables).map(([name, rows]) => [
            name,
            rows.length,
          ]),
        ),
        currentJobCount: operations.tables.ops_job.filter(
          (row) =>
            row.ops_installation_id === destination.scope.opsInstallationId,
        ).length,
      },
    };
    const baseURL =
      result.status === 'confirmed'
        ? await startRestoredApp(destination, n)
        : null;
    return {
      ...result,
      baseURL,
      readback,
      destinationsCreated: states.length - before,
      startedAt,
      endedAt: Date.now(),
    };
  }
  async function cleanup() {
    const errors = [];
    for (const [name, service] of [...owned].reverse()) {
      try {
        await service.stop();
        record('stop', name, service);
        owned.delete(name);
      } catch {
        errors.push(name);
      }
    }
    for (const client of clients) client.close();
    if (errors.length) throw new Error('Owned recovery cleanup incomplete');
  }
  return { restore, cleanup };
}
