import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOpsConfig } from '../scripts/pilot-ops-config.mjs';
import { parseOpsArgs, runOpsCommand } from '../scripts/pilot-ops.mjs';
function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ops-cli-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name, value) => {
    const p = path.join(root, name);
    fs.writeFileSync(p, value, { mode: 0o600 });
    return p;
  };
  const archiveRoot = path.join(root, 'archives');
  fs.mkdirSync(archiveRoot, { mode: 0o700 });
  const config = {
    format: 'pilot-ops-config-1',
    environment: 'synthetic',
    localSynthetic: true,
    installationId: 'learning-test',
    opsInstallationId: 'ops-test',
    manifestPath: file(
      'manifest.json',
      JSON.stringify({
        phase: 'r4',
        candidateId: 'test-build',
        snapshot: root,
        digest: 'a'.repeat(64),
        artifactDigest: 'b'.repeat(64),
      }),
    ),
    learningURL: 'http://127.0.0.1:9001',
    operationsURL: 'http://127.0.0.1:9002',
    healthURL: 'http://127.0.0.1:9003/api/pilot/health',
    learningTokenFile: file('learning-token', 'private-learning'),
    operationsTokenFile: file('ops-token', 'private-ops'),
    keyFiles: { 'key-a': file('key', Buffer.alloc(32, 7)) },
    activeKeyId: 'key-a',
    archiveIssuersFile: file('issuers.json', '[]'),
    archiveRoot,
  };
  const configPath = file('config.json', JSON.stringify(config));
  const write = () => fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    root,
    config,
    configPath,
    write,
    load: (env = {}) =>
      loadOpsConfig(configPath, {
        environment: env,
        verifyManifest: (m, o) => {
          assert.equal(o.built, true);
          return m;
        },
      }),
  };
}
test('strict CLI accepts closed jobs and one private config reference', () => {
  assert.deepEqual(parseOpsArgs(['backup', '--config', '/private/config']), {
    command: 'backup',
    configPath: '/private/config',
    input: {},
  });
  assert.equal(
    parseOpsArgs(['reconcile', '--config', '/private/config', '--job', 'job-1'])
      .input.subjectJobId,
    'job-1',
  );
  for (const args of [
    ['restore', '--config', '/x'],
    ['backup', '--config', '/x', '--token', 'secret'],
    ['reconcile', '--config', '/x'],
    ['monitor', '--config', '/x', '--job', 'j'],
    ['backup', '--config', '/x', '--config', '/y'],
  ])
    assert.throws(() => parseOpsArgs(args), { code: 'OPS_CLI_INVALID' });
});
test('private config reads separate secrets and verified frozen build before any client', (t) => {
  const f = fixture(t),
    loaded = f.load();
  assert.equal(loaded.scope.installationId, 'learning-test');
  assert.equal(loaded.keys.get('key-a').length, 32);
  assert.equal(loaded.learningToken, 'private-learning');
  loaded.dispose();
  assert.equal(loaded.keys.size, 0);
});
test('production, Vercel, false synthetic, credentials/query/foreign/local URLs are refused', (t) => {
  const f = fixture(t);
  for (const env of [{ NODE_ENV: 'production' }, { VERCEL: '1' }])
    assert.throws(() => f.load(env));
  for (const [key, value] of [
    ['localSynthetic', false],
    ['learningURL', 'http://example.test'],
    ['operationsURL', 'file:/tmp/data'],
    ['healthURL', 'https://user:secret@example.test/health'],
    ['learningURL', 'https://example.test?token=secret'],
    ['environment', 'production'],
  ]) {
    const old = f.config[key];
    f.config[key] = value;
    f.write();
    assert.throws(() => f.load());
    f.config[key] = old;
  }
});
test('scope, unknown properties and malformed secret/key/issuer references refuse before clients', (t) => {
  const f = fixture(t);
  for (const [key, value] of [
    ['opsInstallationId', 'learning-test'],
    ['activeKeyId', 'missing'],
    ['extra', 'secret'],
    ['archiveIssuersFile', f.config.learningTokenFile],
  ]) {
    const old = f.config[key];
    f.config[key] = value;
    f.write();
    assert.throws(() => f.load());
    if (old === undefined) delete f.config[key];
    else f.config[key] = old;
  }
});
test('world readable files, symlinks, hard links and archive permissions are refused', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.config.learningTokenFile, 0o644);
  assert.throws(() => f.load());
  fs.chmodSync(f.config.learningTokenFile, 0o600);
  const original = f.config.learningTokenFile;
  const link = path.join(f.root, 'link');
  fs.symlinkSync(original, link);
  f.config.learningTokenFile = link;
  f.write();
  assert.throws(() => f.load());
  f.config.learningTokenFile = original;
  fs.unlinkSync(link);
  fs.linkSync(original, link);
  f.write();
  assert.throws(() => f.load());
  fs.unlinkSync(link);
  fs.chmodSync(f.config.archiveRoot, 0o755);
  assert.throws(() => f.load());
});
test('failed manifest verification is sanitized and cannot open clients', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      loadOpsConfig(f.configPath, {
        environment: {},
        verifyManifest: () => {
          throw Error('private SQL token');
        },
      }),
    { code: 'OPS_CONFIG_INVALID' },
  );
});
test('known executor effects use exact command and clean up every opened client', async () => {
  const calls = [],
    closed = [];
  const config = {
    scope: {},
    keys: new Map(),
    dispose: () => calls.push('dispose'),
  };
  const result = await runOpsCommand(
    {
      command: 'reconcile',
      configPath: '/private/config',
      input: { subjectJobId: 'job-1' },
    },
    {
      load: () => config,
      openClient: async (_config, kind) => ({ close: () => closed.push(kind) }),
      executor: async (options) => {
        assert.ok(options.learningClient);
        assert.ok(options.operationsClient);
        return {
          dispatch: async (kind, input) => {
            calls.push([kind, input]);
            return {
              jobId: 'job-1',
              status: 'uncertain',
              revision: 2,
              code: 'OPS_EFFECT_UNCONFIRMED',
              archives: [],
              secret: 'never output',
            };
          },
        };
      },
    },
  );
  assert.deepEqual(calls[0], ['reconcile', { subjectJobId: 'job-1' }]);
  assert.deepEqual(closed, ['learning', 'operations']);
  assert.equal(calls.at(-1), 'dispose');
  assert.equal(result.secret, undefined);
});
test('partial client-open failure closes first client and never logs raw exceptions', async () => {
  let closed = 0,
    disposed = 0;
  await assert.rejects(
    runOpsCommand(
      { command: 'backup', configPath: '/x', input: {} },
      {
        load: () => ({ dispose: () => disposed++ }),
        openClient: async (_config, kind) => {
          if (kind === 'operations') throw Error('password SQL');
          return { close: () => closed++ };
        },
      },
    ),
    { code: 'OPS_UNAVAILABLE' },
  );
  assert.equal(closed, 1);
  assert.equal(disposed, 1);
});

test('real Ed25519 public issuer record is accepted, noncanonical key and private key rejected', async (t) => {
  const { generateKeyPairSync } = await import('node:crypto');
  const f = fixture(t);
  const pair = generateKeyPairSync('ed25519');
  const issuer = {
    issuerId: 'historic-key',
    publicKeyJwk: pair.publicKey.export({ format: 'jwk' }),
    purpose: 'release',
    notBefore: 1,
    revokedAt: null,
  };
  fs.writeFileSync(f.config.archiveIssuersFile, JSON.stringify([issuer]));
  const loaded = f.load();
  assert.equal(loaded.archiveIssuers.length, 1);
  loaded.dispose();
  issuer.publicKeyJwk.x += '=';
  fs.writeFileSync(f.config.archiveIssuersFile, JSON.stringify([issuer]));
  assert.throws(() => f.load());
  issuer.publicKeyJwk = pair.privateKey.export({ format: 'jwk' });
  fs.writeFileSync(f.config.archiveIssuersFile, JSON.stringify([issuer]));
  assert.throws(() => f.load());
});
test('cleanup failure remains sanitized while both clients and keys are disposed', async () => {
  const cleaned = [];
  await assert.rejects(
    runOpsCommand(
      { command: 'backup', configPath: '/x', input: {} },
      {
        load: () => ({ dispose: () => cleaned.push('keys') }),
        openClient: async (_config, kind) => ({
          close: () => {
            cleaned.push(kind);
            if (kind === 'learning') throw Error('private cleanup token');
          },
        }),
        executor: async () => ({
          dispatch: async () => ({
            jobId: 'job-1',
            status: 'verified',
            revision: 1,
            archives: [],
          }),
        }),
      },
    ),
    { code: 'OPS_UNAVAILABLE' },
  );
  assert.deepEqual(cleaned, ['learning', 'operations', 'keys']);
});

test('a verified older phase cannot authorize the R4 executor', (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(f.config.manifestPath, 'utf8'));
  manifest.phase = 'r3';
  fs.writeFileSync(f.config.manifestPath, JSON.stringify(manifest));
  assert.throws(() => f.load(), { code: 'OPS_CONFIG_INVALID' });
});

test('actual CLI refuses secret argv with sanitized JSON and no echo', async () => {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/pilot-ops.mjs',
      'backup',
      '--config',
      '/private/config',
      '--token',
      'PRIVATE_SENTINEL',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr), {
    status: 'refused',
    code: 'OPS_CLI_INVALID',
  });
  assert.ok(!child.stderr.includes('PRIVATE_SENTINEL'));
});

test('persisted uncertain executor result retains job identity instead of invalid-result refusal', async () => {
  const result = await runOpsCommand(
    { command: 'backup', configPath: '/x', input: {} },
    {
      load: () => ({ dispose() {} }),
      openClient: async () => ({ close() {} }),
      executor: async () => ({
        dispatch: async () => ({
          jobId: 'job-uncertain',
          status: 'uncertain',
          revision: 2,
          archiveId: 'job-uncertain',
          archives: [],
          code: 'OPS_EFFECT_UNCONFIRMED',
        }),
      }),
    },
  );
  assert.deepEqual(result, {
    jobId: 'job-uncertain',
    status: 'uncertain',
    revision: 2,
    archiveId: 'job-uncertain',
    code: 'OPS_EFFECT_UNCONFIRMED',
    archiveCount: 0,
  });
});
