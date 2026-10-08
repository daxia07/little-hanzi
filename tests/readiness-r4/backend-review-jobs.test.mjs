import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { createOpsExecutor } from '../../scripts/pilot-ops-jobs.mjs';
import {
  initializeOpsLibsql,
  createOpsBackupPayload,
  restoreOpsLibsql,
} from '../../scripts/pilot-ops-libsql.mjs';
import { storySchemaSource } from '../../scripts/pilot-story-schema.mjs';
import { PrivateArchiveStore } from '../../scripts/pilot-ops-archive.mjs';
import { runOpsCommand } from '../../scripts/pilot-ops.mjs';
// Historical R4 fixture deliberately binds six learning migrations + ops schema1.
const repoRoot = fs.realpathSync(path.resolve(import.meta.dirname, '../..'));
const sourceRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r4-historical-source-')),
);
fs.writeFileSync(
  path.join(sourceRoot, '.hanzi-qa-owned'),
  'r4-historical-source',
);
for (const dir of ['lib', 'content'])
  fs.cpSync(path.join(repoRoot, dir), path.join(sourceRoot, dir), {
    recursive: true,
  });
fs.mkdirSync(path.join(sourceRoot, 'db/pilot-migrations'), { recursive: true });
for (const name of fs
  .readdirSync(path.join(repoRoot, 'db/pilot-migrations'))
  .filter((n) => /^000[0-5]-/.test(n)))
  fs.copyFileSync(
    path.join(repoRoot, 'db/pilot-migrations', name),
    path.join(sourceRoot, 'db/pilot-migrations', name),
  );
fs.mkdirSync(path.join(sourceRoot, 'db/pilot-ops-migrations'), {
  recursive: true,
});
fs.copyFileSync(
  path.join(repoRoot, 'db/pilot-ops-migrations/0000_ops.sql'),
  path.join(sourceRoot, 'db/pilot-ops-migrations/0000_ops.sql'),
);
fs.symlinkSync(
  fs.realpathSync(path.join(repoRoot, 'node_modules')),
  path.join(sourceRoot, 'node_modules'),
);
after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
const initial = Date.parse('2026-09-27T03:00:00Z');
async function owned(callback) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'r4-independent-ops-')),
  );
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(
    path.join(root, 'owned-test.json'),
    JSON.stringify({
      format: 'r4-independent-ops-unit-1',
      syntheticOnly: true,
    }),
    { mode: 0o600 },
  );
  const learning = createClient({
      url: 'file:' + path.join(root, 'learning.db'),
    }),
    ops = createClient({ url: 'file:' + path.join(root, 'operations.db') });
  let at = initial;
  const scope = {
    environment: 'independent-qa',
    installationId: 'learning-independent',
    opsInstallationId: 'ops-independent',
  };
  try {
    const schema = storySchemaSource(sourceRoot);
    await learning.executeMultiple(schema.statements.join('\n'));
    await learning.execute(
      'CREATE TABLE pilot_d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,applied_at TEXT NOT NULL)',
    );
    await learning.execute({
      sql: 'UPDATE pilot_installation SET installation_id=? WHERE id=1',
      args: [scope.installationId],
    });
    for (const m of schema.migrations) {
      await learning.execute({
        sql: 'INSERT INTO pilot_schema_history(version,checksum,applied_at) VALUES(?,?,?)',
        args: [m.version, m.sha256, at],
      });
      await learning.execute({
        sql: 'INSERT INTO pilot_d1_migrations(name,applied_at) VALUES(?,?)',
        args: [m.name, new Date(at).toISOString()],
      });
    }
    await initializeOpsLibsql({ client: ops, sourceRoot, scope, now: at });
    const archiveDir = path.join(root, 'archives');
    fs.mkdirSync(archiveDir, { mode: 0o700 });
    const options = {
      sourceRoot,
      learningClient: learning,
      operationsClient: ops,
      scope,
      archiveStore: new PrivateArchiveStore(archiveDir),
      keys: new Map([['synthetic-independent-key', crypto.randomBytes(32)]]),
      activeKeyId: 'synthetic-independent-key',
      now: () => at,
      build: () => ({
        candidateId: 'independent-build',
        sourceDigest: 'sha256:' + 'a'.repeat(64),
        artifactDigest: 'sha256:' + 'b'.repeat(64),
      }),
      probe: async () => 'healthy',
    };
    await callback({
      root,
      learning,
      ops,
      options,
      set: (value) => (at = value),
    });
  } finally {
    learning.close();
    ops.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('BR-R4-01 paired actual captures/encryption/readback terminal ack and duplicate dispatch', async () =>
  owned(async ({ ops, options }) => {
    let captures = 0;
    const executor = await createOpsExecutor({
      ...options,
      effects: { beforeCapture: () => captures++ },
    });
    const first = await executor.dispatch('backup');
    assert.equal(first.status, 'verified');
    assert.equal(first.archives.length, 2);
    assert.equal((await executor.dispatch('backup')).jobId, first.jobId);
    assert.equal(captures, 1);
    assert.equal(
      Number(
        (await ops.execute('SELECT count(*) n FROM ops_archive')).rows[0].n,
      ),
      2,
    );
  }));
test('BR-R4-02 one uploaded object remains uncertain across slot and named reconcile', async () =>
  owned(async ({ ops, options, set }) => {
    let uploads = 0;
    const executor = await createOpsExecutor({
      ...options,
      effects: {
        afterUpload: () => {
          if (++uploads === 1) throw Error('SIMULATED private failure');
        },
      },
    });
    const first = await executor.dispatch('backup');
    assert.equal(first.status, 'uncertain');
    assert.equal(first.archives.length, 0);
    set(initial + 86400000);
    const reconcile = await executor.dispatch('reconcile', {
      subjectJobId: first.jobId,
    });
    assert.equal(reconcile.status, 'uncertain');
    assert.equal(
      (
        await executor.store.readJobForReconcile(
          executor.context(),
          first.jobId,
        )
      ).job.status,
      'uncertain',
    );
    assert.equal(uploads, 1);
    assert.equal(
      Number(
        (await ops.execute('SELECT count(*) n FROM ops_archive')).rows[0].n,
      ),
      0,
    );
  }));
test('BR-R4-03 pair uploaded before lost final write reconciles original slot without recapture', async () =>
  owned(async ({ ops, options, set }) => {
    let captures = 0;
    const executor = await createOpsExecutor({
      ...options,
      effects: {
        beforeCapture: () => captures++,
        beforeCommit: () => {
          throw Error('SIMULATED lost before commit');
        },
      },
    });
    const first = await executor.dispatch('backup');
    assert.equal(first.status, 'uncertain');
    set(initial + 86400000);
    const restored = await createOpsExecutor(options),
      reconcile = await restored.dispatch('reconcile', {
        subjectJobId: first.jobId,
      });
    assert.equal(reconcile.status, 'succeeded');
    const subject = await restored.store.readJobForReconcile(
      restored.context(),
      first.jobId,
    );
    assert.equal(subject.job.status, 'succeeded');
    assert.equal(subject.utcSlot, '2026-09-27T02:00:00.000Z');
    assert.equal(captures, 1);
    assert(
      (await ops.execute('SELECT daily_slot FROM ops_archive')).rows.every(
        (r) => r.daily_slot === subject.utcSlot,
      ),
    );
  }));
test('BR-R4-04 actual uncertain monitor executor outcome survives private CLI sanitized output', async () =>
  owned(async ({ options }) => {
    const executor = await createOpsExecutor({
      ...options,
      probe: async () => {
        throw Error('SIMULATED sensitive failure');
      },
    });
    const result = await runOpsCommand(
      {
        command: 'monitor',
        configPath: path.join(sourceRoot, 'unit-only-config.json'),
        input: {},
      },
      {
        load: () => ({ dispose() {} }),
        openClient: async () => ({ close() {} }),
        executor: async () => executor,
      },
    );
    assert.equal(result.status, 'uncertain');
    assert(!JSON.stringify(result).includes('sensitive'));
  }));
test('BR-R4-05 operations lost restore acknowledgement confirms actual committed historical rows', async () =>
  owned(async ({ ops, options, root }) => {
    const executor = await createOpsExecutor(options);
    await executor.dispatch('monitor');
    const archive = await createOpsBackupPayload({
      client: ops,
      sourceRoot,
      scope: options.scope,
      buildId: 'independent-build',
      now: initial,
    });
    const destination = createClient({
        url: 'file:' + path.join(root, 'restore.db'),
      }),
      scope = { ...options.scope, opsInstallationId: 'fresh-ops-independent' };
    try {
      await initializeOpsLibsql({
        client: destination,
        sourceRoot,
        scope,
        now: initial,
      });
      const result = await restoreOpsLibsql(
        { client: destination, sourceRoot, archive, scope },
        {
          decorateClient: (c) => ({
            batch: async (...args) => {
              await c.batch(...args);
              throw Error('SIMULATED lost acknowledgement');
            },
          }),
        },
      );
      assert.equal(result.commit, 'confirmed-after-uncertainty');
      const restored = await createOpsExecutor({
        ...options,
        operationsClient: destination,
        scope,
      });
      const status = await restored.store.readOpsStatus(restored.context());
      assert.equal(status.jobs.length, 0);
      assert.equal(status.monitorState, 'unknown');
    } finally {
      destination.close();
    }
  }));

test('BR-R4-06 busy subject reconciliation cannot claim succeeded for unconfirmed observation', async () =>
  owned(async ({ options }) => {
    let release, arrived;
    const held = new Promise((r) => (release = r)),
      waiting = new Promise((r) => (arrived = r));
    const active = await createOpsExecutor({
      ...options,
      effects: {
        afterLease: async () => {
          arrived();
          await held;
        },
      },
    });
    const running = active.dispatch('monitor');
    try {
      await waiting;
      const rows = await active
        .context()
        .db.prepare("SELECT id FROM ops_job WHERE kind='monitor'")
        .all();
      const reconcile = await (
        await createOpsExecutor(options)
      ).dispatch('reconcile', { subjectJobId: rows.results[0].id });
      assert.equal(reconcile.status, 'uncertain');
    } finally {
      release();
      await running;
    }
  }));

test('BR-R4-07 private config denies credential-bearing URLs and permissive secret files before clients', async () => {
  const { loadOpsConfig } = await import('../../scripts/pilot-ops-config.mjs');
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'r4-independent-config-')),
  );
  fs.chmodSync(root, 0o700);
  try {
    const file = (name) => path.join(root, name),
      write = (name, value) => {
        fs.writeFileSync(file(name), value, { mode: 0o600 });
        return file(name);
      };
    const key = write('key', crypto.randomBytes(32)),
      token = write('token', 'SYNTHETIC_PRIVATE_TOKEN'),
      issuers = write('issuers', '[]'),
      manifest = write('manifest', '{}');
    fs.mkdirSync(file('archives'), { mode: 0o700 });
    const config = {
      format: 'pilot-ops-config-1',
      environment: 'synthetic',
      localSynthetic: true,
      installationId: 'learn',
      opsInstallationId: 'ops',
      manifestPath: manifest,
      learningURL: 'http://127.0.0.1:8101/',
      operationsURL: 'http://127.0.0.1:8102/',
      healthURL: 'http://127.0.0.1:8103/api/pilot/health',
      learningTokenFile: token,
      operationsTokenFile: token,
      keyFiles: { synthetic: key },
      activeKeyId: 'synthetic',
      archiveIssuersFile: issuers,
      archiveRoot: file('archives'),
    };
    const configFile = write('config', JSON.stringify(config)),
      opts = {
        environment: {},
        verifyManifest: () => ({
          phase: 'r4',
          candidateId: 'synthetic-build',
          snapshot: sourceRoot,
          digest: 'a'.repeat(64),
          artifactDigest: 'b'.repeat(64),
        }),
      };
    const accepted = loadOpsConfig(configFile, opts);
    accepted.dispose();
    assert.equal(accepted.keys.size, 0);
    assert.equal(accepted.learningToken, '');
    for (const change of [
      (c) => (c.learningURL = 'http://user:SECRET@127.0.0.1:8101/'),
      (c) => (c.operationsURL = c.learningURL),
      (c) => (c.healthURL += '?token=SECRET'),
      (c) => (c.localSynthetic = false),
      (c) => (c.learningURL = 'http://remote.invalid:8101/'),
    ]) {
      const c = structuredClone(config);
      change(c);
      fs.writeFileSync(configFile, JSON.stringify(c));
      assert.throws(
        () => loadOpsConfig(configFile, opts),
        (e) => e.code === 'OPS_CONFIG_INVALID' && !e.message.includes('SECRET'),
      );
    }
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.chmodSync(token, 0o644);
    assert.throws(
      () => loadOpsConfig(configFile, opts),
      (e) => e.code === 'OPS_CONFIG_INVALID',
    );
    fs.chmodSync(token, 0o600);
    assert.throws(
      () =>
        loadOpsConfig(configFile, {
          ...opts,
          environment: { NODE_ENV: 'production' },
        }),
      (e) => e.code === 'OPS_CONFIG_INVALID',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BR-R4-08 actual nine-point retention preserves Sunday and latest seven; lost deletion acknowledgement reconciles', async () =>
  owned(async ({ options, set }) => {
    const executor = await createOpsExecutor(options);
    const backups = [];
    for (let day = 0; day < 9; day++) {
      set(initial + day * 86400000);
      const result = await executor.dispatch('backup');
      assert.equal(result.status, 'verified');
      backups.push(result);
    }
    let deletes = 0;
    const uncertain = await createOpsExecutor({
      ...options,
      effects: {
        afterDelete: () => {
          if (++deletes === 2)
            throw Error('SIMULATED lost deletion acknowledgement');
        },
      },
    });
    const first = await uncertain.dispatch('retention');
    assert.equal(first.status, 'uncertain');
    assert.equal(deletes, 2);
    assert.equal(
      (await executor.store.listVerifiedArchives(executor.context())).filter(
        (a) => a.deleted,
      ).length,
      0,
    );
    set(initial + 9 * 86400000);
    const reconciled = await executor.dispatch('reconcile', {
      subjectJobId: first.jobId,
    });
    assert.equal(reconciled.status, 'succeeded');
    const rows = await executor.store.listVerifiedArchives(executor.context());
    assert.equal(rows.filter((a) => a.deleted).length, 2);
    assert(
      rows.filter((a) => a.deleted).every((a) => a.jobId === backups[1].jobId),
    );
    for (const preserved of rows.filter((a) => !a.deleted))
      assert(options.archiveStore.get(preserved.objectRef));
    assert(
      rows.filter((a) => a.jobId === backups[0].jobId).every((a) => !a.deleted),
    );
  }));
