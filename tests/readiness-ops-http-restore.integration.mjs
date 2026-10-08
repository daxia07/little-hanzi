// Actual disposable HTTP sqld regression; no active database, app or whole-app mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client/web';
import {
  launched,
  bounded,
  freePort,
  runtimeEnvironment,
} from '../scripts/readiness-node-runner.mjs';
import {
  initializeOpsLibsql,
  createOpsBackupPayload,
  restoreOpsLibsql,
  captureOpsLibsql,
} from '../scripts/pilot-ops-libsql.mjs';
import { createLibsqlD1Database } from '../lib/platform/libsql-d1.ts';
import { acquireJob } from '../lib/pilot/ops-store.ts';
import { jobSlot } from '../lib/pilot/ops-domain.ts';
const sourceRoot = path.resolve(import.meta.dirname, '..');
const binary =
  process.env.HANZI_SQLD_BINARY || path.join(os.homedir(), '.turso', 'sqld');
async function database(root, name) {
  const port = await freePort(),
    state = path.join(root, name);
  fs.mkdirSync(state, { mode: 0o700 });
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
      cwd: root,
      env: runtimeEnvironment(),
      log: path.join(root, name + '.log'),
    },
  );
  const client = createClient({
    url: `http://127.0.0.1:${port}`,
    intMode: 'number',
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (service.error || service.child.exitCode !== null)
        throw Error('Owned sqld exited');
      try {
        await bounded(client.execute('SELECT 1'), 500, 'HTTP sqld readiness');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert(ready);
    return { client, service };
  } catch (error) {
    client.close();
    await service.stop();
    throw error;
  }
}
for (const version of [1, 2])
  await test(
    `[OPS5-003] schema${version} restores nonempty historical facts through actual HTTP sqld with exact ledger binding`,
    { timeout: 60000 },
    async () => {
      assert(
        fs.existsSync(binary),
        'The explicit owned HTTP sqld prerequisite is required',
      );
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-ops-http-restore-')),
      );
      fs.chmodSync(root, 0o700);
      fs.writeFileSync(
        path.join(root, '.hanzi-qa-owned'),
        'Synthetic operations restore boundary',
        { mode: 0o600 },
      );
      const clients = [];
      const scope = {
          environment: 'synthetic',
          installationId: 'http-source-learning',
          opsInstallationId: 'http-source-ops',
        },
        target = {
          environment: 'synthetic',
          installationId: 'http-target-learning',
          opsInstallationId: 'http-target-ops',
        };
      const at = Date.now();
      try {
        const source = await database(root, 'source');
        clients.push(source);
        const destination = await database(root, 'destination');
        clients.push(destination);
        await initializeOpsLibsql({
          client: source.client,
          sourceRoot,
          scope,
          version,
          now: at,
        });
        await initializeOpsLibsql({
          client: destination.client,
          sourceRoot,
          scope: target,
          version,
          now: at,
        });
        const ctx = {
          db: createLibsqlD1Database(source.client),
          ...scope,
          buildId: 'synthetic-http-build',
          now: () => at,
        };
        const admission = await acquireJob(ctx, {
          jobId: 'http-monitor',
          kind: 'monitor',
          utcSlot: jobSlot('monitor', at),
          attemptId: 'http-attempt',
          eventId: 'http-acquired',
          objects: {},
        });
        assert.equal(admission.admission, 'dispatch');
        const archive = await createOpsBackupPayload({
          client: source.client,
          sourceRoot,
          scope,
          buildId: ctx.buildId,
          now: at,
        });
        assert.equal(archive.payload.migrations.length, version);
        assert.equal(archive.payload.tables.ops_job.length, 1);
        const result = await restoreOpsLibsql({
          client: destination.client,
          sourceRoot,
          archive,
          scope: target,
        });
        assert.equal(result.commit, 'confirmed');
        assert.equal(result.format, `pilot-ops-backup-${version}`);
        const after = await captureOpsLibsql({
          client: destination.client,
          sourceRoot,
          scope: target,
        });
        assert.equal(after.tables.ops_job.length, 1);
        assert.equal(after.tables.ops_job_event.length, 1);
        assert.equal(
          after.tables.ops_job[0].ops_installation_id,
          scope.opsInstallationId,
        );
        assert.equal(
          after.tables.ops_installation[0].installation_id,
          target.opsInstallationId,
        );
        assert.equal(
          after.tables.ops_installation[0].schema_version,
          `pilot-ops-schema-${version}`,
        );
        await assert.rejects(
          restoreOpsLibsql({
            client: destination.client,
            sourceRoot,
            archive,
            scope: target,
          }),
          (e) => e.code === 'OPS_RESTORE_NOT_FRESH',
        );

        // Actual immutable-ledger/identity constraints refuse concurrent mutation
        // attempts after the freshness read; no historical facts may appear.
        const mutations = [
          [
            'checksum',
            'UPDATE ops_schema_history SET checksum=? WHERE version=0',
            ['0'.repeat(64)],
          ],
          [
            'name',
            'UPDATE ops_schema_history SET name=? WHERE version=0',
            ['unknown_ops.sql'],
          ],
          [
            'extra-ledger',
            'INSERT INTO ops_schema_history(version,name,checksum,applied_at)VALUES(99,?,?,?)',
            ['unknown_ops.sql', '0'.repeat(64), at],
          ],
          ...(version === 2
            ? [
                [
                  'installed-version',
                  'UPDATE ops_installation SET schema_version=? WHERE id=1',
                  ['pilot-ops-schema-1'],
                ],
              ]
            : []),
        ];
        for (const [label, sql, args] of mutations) {
          const isolated = await database(root, 'race-' + label);
          clients.push(isolated);
          const fresh = {
            ...target,
            opsInstallationId: target.opsInstallationId + '-' + label,
          };
          await initializeOpsLibsql({
            client: isolated.client,
            sourceRoot,
            scope: fresh,
            version,
            now: at,
          });
          await assert.rejects(
            restoreOpsLibsql(
              { client: isolated.client, sourceRoot, archive, scope: fresh },
              {
                decorateClient: (live) => ({
                  batch: async (statements, mode) => {
                    await live.execute({ sql, args });
                    return live.batch(statements, mode);
                  },
                }),
              },
            ),
            (e) => e.code === 'OPS_RESTORE_NOT_COMMITTED',
          );
          assert.equal(
            Number(
              (
                await isolated.client.execute(
                  'SELECT COUNT(*) AS n FROM ops_job',
                )
              ).rows[0].n,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await isolated.client.execute(
                  'SELECT COUNT(*) AS n FROM ops_job_event',
                )
              ).rows[0].n,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await isolated.client.execute(
                  "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='ops_restore_guard'",
                )
              ).rows[0].n,
            ),
            0,
          );
        }
        const uncertain = await database(root, 'lost-ack');
        clients.push(uncertain);
        const uncertainScope = {
          ...target,
          opsInstallationId: target.opsInstallationId + '-lost-ack',
        };
        await initializeOpsLibsql({
          client: uncertain.client,
          sourceRoot,
          scope: uncertainScope,
          version,
          now: at,
        });
        const confirmed = await restoreOpsLibsql(
          {
            client: uncertain.client,
            sourceRoot,
            archive,
            scope: uncertainScope,
          },
          {
            decorateClient: (live) => ({
              batch: async (statements, mode) => {
                await live.batch(statements, mode);
                throw Error('Synthetic lost committed acknowledgement');
              },
            }),
          },
        );
        assert.equal(confirmed.commit, 'confirmed-after-uncertainty');
      } finally {
        for (const own of clients) {
          own.client.close();
          await own.service.stop();
          assert.notEqual(
            own.service.child.exitCode,
            null,
            'Owned sqld stopped',
          );
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
