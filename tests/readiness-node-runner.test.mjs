import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  candidateSource,
  runtimeEnvironment,
  verifyNodeManifest,
  materializeNitroPackages,
} from '../scripts/readiness-node-runner.mjs';

test('[R2 isolation] snapshot allowlist rejects credentials, private recordings and runtime evidence', () => {
  for (const file of [
    '.env',
    '.env.local',
    '.env.example',
    '.npmrc',
    '.handoff/token.json',
    '.openai/hosting.json',
    'public/audio/child.wav',
    'docs/private-recordings/child.wav',
    'docs/private-recordings/child.mp3',
    'outputs/qa/report.json',
    'docs/.env.example',
    'lib/private.sqlite',
    'lib/link.pem',
    '../app/page.tsx',
    '/app/page.tsx',
    'app/../secret.ts',
    'docs/STATUS.md',
  ]) {
    assert.equal(candidateSource(file), false, file);
  }
  for (const file of [
    'app/preview/shade-01/page.tsx',
    'public/story/forest-01-v3/mascot.svg',
    'lib/preview/domain.ts',
    'package-lock.json',
    'vite.vercel.config.ts',
    'docs/sprints/readiness-r2.md',
  ]) {
    assert.equal(candidateSource(file), true, file);
  }
});

test('[R2 artifact packaging] internal Nitro packages become portable bytes; escaping links fail before changes', () => {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-unit-'),
  );
  const snapshot = path.join(work, 'candidate');
  const modules = path.join(snapshot, '.output/server/node_modules');
  const packagePath = path.join(modules, '.nf3/example@1.0.0');
  fs.mkdirSync(packagePath, { recursive: true });
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'unit');
  fs.writeFileSync(path.join(snapshot, 'package.json'), '{}');
  fs.writeFileSync(
    path.join(packagePath, 'index.js'),
    'export const value = 7;',
  );
  fs.symlinkSync('.nf3/example@1.0.0', path.join(modules, 'example'));
  const manifest = {
    work,
    snapshot,
    runId: 'unit',
    files: ['package.json'],
    digest: crypto
      .createHash('sha256')
      .update('package.json\0{}\0')
      .digest('hex'),
  };
  try {
    fs.symlinkSync(
      path.join(work, '.hanzi-qa-owned'),
      path.join(modules, 'escape'),
    );
    assert.throws(
      () => materializeNitroPackages(manifest),
      /link|package|artifact/,
    );
    assert.equal(
      fs.lstatSync(path.join(modules, 'example')).isSymbolicLink(),
      true,
      'invalid graph must cause no partial materialization',
    );
    fs.unlinkSync(path.join(modules, 'escape'));
    const copies = materializeNitroPackages(manifest);
    assert.equal(copies.length, 1);
    assert.equal(
      fs.lstatSync(path.join(modules, 'example')).isSymbolicLink(),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(modules, 'example/index.js'), 'utf8'),
      'export const value = 7;',
    );
    fs.writeFileSync(path.join(packagePath, 'index.js'), 'changed');
    assert.equal(
      fs.readFileSync(path.join(modules, 'example/index.js'), 'utf8'),
      'export const value = 7;',
      'copied artifact must be independent',
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[R2 runner review RR-01] built entry, artifacts and output cannot be substituted', () => {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-unit-'),
  );
  const snapshot = path.join(work, 'candidate');
  fs.mkdirSync(path.join(snapshot, '.output/server'), { recursive: true });
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'unit');
  fs.writeFileSync(path.join(snapshot, 'package.json'), '{}');
  fs.writeFileSync(
    path.join(snapshot, '.output/server/index.mjs'),
    'export {};',
  );
  const hash = (file, bytes) =>
    crypto
      .createHash('sha256')
      .update(file)
      .update('\0')
      .update(bytes)
      .update('\0')
      .digest('hex');
  const manifest = {
    work,
    snapshot,
    runId: 'unit',
    files: ['package.json'],
    digest: hash('package.json', '{}'),
    nodeEntry: path.join(snapshot, '.output/server/index.mjs'),
    output: path.resolve('outputs/qa/readiness-r2/unit'),
    artifactFiles: ['.output/server/index.mjs'],
    artifactDigest: hash('.output/server/index.mjs', 'export {};'),
  };
  try {
    assert.equal(verifyNodeManifest(manifest, { built: true }), manifest);
    assert.throws(
      () =>
        verifyNodeManifest(
          { ...manifest, nodeEntry: '/private/tmp/other.mjs' },
          { built: true },
        ),
      /entry/,
    );
    assert.throws(
      () =>
        verifyNodeManifest(
          { ...manifest, output: '/private/tmp/other' },
          { built: true },
        ),
      /output/,
    );
    fs.writeFileSync(manifest.nodeEntry, 'export const changed=true;');
    assert.throws(
      () => verifyNodeManifest(manifest, { built: true }),
      /artifact/,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[R2 isolation] runner environment drops inherited database/auth/test/cloud credentials', () => {
  const env = runtimeEnvironment({
    PATH: '/usr/bin',
    HOME: '/local',
    TMPDIR: '/tmp',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    HANZI_DATABASE_URL: 'https://active.example',
    TURSO_AUTH_TOKEN: 'private',
    VERCEL: '1',
    AWS_ACCESS_KEY_ID: 'private',
    HANZI_TEST_TOKEN: 'private',
    SQLD_HTTP_LISTEN_ADDR: '0.0.0.0:8080',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/local',
    TMPDIR: '/tmp',
    CI: '1',
    NO_COLOR: '1',
  });
});

test('[R3-E-003][R3-E-017] a relocated frozen verifier retains its owned evidence location and refuses substitution', async () => {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-portable-'),
  );
  const snapshot = path.join(work, 'candidate');
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  fs.mkdirSync(path.join(snapshot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(snapshot, '.output/server'), { recursive: true });
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'portable');
  for (const name of [
    'readiness-node-runner.mjs',
    'qa-helpers.mjs',
    'qa-server.mjs',
  ]) {
    fs.copyFileSync(
      path.join(sourceRoot, 'scripts', name),
      path.join(snapshot, 'scripts', name),
    );
  }
  fs.writeFileSync(path.join(snapshot, 'package.json'), '{}');
  fs.writeFileSync(
    path.join(snapshot, '.output/server/index.mjs'),
    'export {};',
  );
  const hash = (file, bytes) =>
    crypto
      .createHash('sha256')
      .update(file + '\0' + bytes + '\0')
      .digest('hex');
  const manifest = {
    phase: 'r3',
    work,
    snapshot,
    runId: 'portable',
    files: ['package.json'],
    digest: hash('package.json', '{}'),
    nodeEntry: path.join(snapshot, '.output/server/index.mjs'),
    output: path.join(sourceRoot, 'outputs/qa/readiness-r3/portable'),
    artifactFiles: ['.output/server/index.mjs'],
    artifactDigest: hash('.output/server/index.mjs', 'export {};'),
  };
  const marker = path.join(work, '.hanzi-qa-evidence.json');
  fs.writeFileSync(
    marker,
    JSON.stringify({
      schemaVersion: 'readiness-evidence-location-1',
      runId: manifest.runId,
      output: manifest.output,
    }),
    { mode: 0o600 },
  );
  try {
    const frozen = await import(
      pathToFileURL(path.join(snapshot, 'scripts/readiness-node-runner.mjs'))
        .href
    );
    assert.equal(
      frozen.verifyNodeManifest(manifest, { built: true }),
      manifest,
    );
    assert.equal(verifyNodeManifest(manifest, { built: true }), manifest);
    assert.throws(
      () =>
        frozen.verifyNodeManifest(
          {
            ...manifest,
            output: path.join(snapshot, 'outputs/qa/readiness-r3/portable'),
          },
          { built: true },
        ),
      /evidence|output/,
    );
    const original = fs.readFileSync(marker);
    fs.writeFileSync(
      marker,
      JSON.stringify({
        schemaVersion: 'readiness-evidence-location-1',
        runId: 'another',
        output: manifest.output,
      }),
    );
    assert.throws(
      () => frozen.verifyNodeManifest(manifest, { built: true }),
      /evidence|output/,
    );
    fs.writeFileSync(marker, original);
    fs.chmodSync(marker, 0o644);
    assert.throws(
      () => frozen.verifyNodeManifest(manifest, { built: true }),
      /evidence|output/,
    );
    fs.chmodSync(marker, 0o600);
    fs.renameSync(marker, marker + '.saved');
    fs.symlinkSync(marker + '.saved', marker);
    assert.throws(
      () => frozen.verifyNodeManifest(manifest, { built: true }),
      /evidence|output/,
    );
    fs.unlinkSync(marker);
    assert.throws(
      () => frozen.verifyNodeManifest(manifest, { built: true }),
      /evidence|output/,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('[R2 isolation] manifests require marker, snapshot ownership, file digest and no symlink escapes', () => {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-unit-'),
  );
  try {
    const snapshot = path.join(work, 'candidate');
    fs.mkdirSync(snapshot);
    const manifest = {
      work,
      snapshot,
      files: ['package.json'],
      digest: 'wrong',
      runId: 'unit',
    };
    assert.throws(() => verifyNodeManifest(manifest), /marker|owned/);
    fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'unit');
    fs.writeFileSync(path.join(snapshot, 'package.json'), '{}');
    assert.throws(() => verifyNodeManifest(manifest), /digest/);
    assert.throws(
      () => verifyNodeManifest({ ...manifest, files: ['../.hanzi-qa-owned'] }),
      /source|path/,
    );
    fs.symlinkSync(
      path.join(work, '.hanzi-qa-owned'),
      path.join(snapshot, 'lib'),
    );
    assert.throws(
      () => verifyNodeManifest({ ...manifest, files: ['lib/key.ts'] }),
      /source|path|file|symlink/,
    );
    assert.throws(
      () => verifyNodeManifest({ ...manifest, snapshot: work }),
      /snapshot/,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
