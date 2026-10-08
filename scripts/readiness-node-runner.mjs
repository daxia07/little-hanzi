import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ROOT, digest, sourceFiles } from './qa-helpers.mjs';
import { freePort } from './qa-server.mjs';
export { freePort } from './qa-server.mjs';

const rootFiles = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.vercel.config.ts',
  'next.config.ts',
  'drizzle.config.ts',
  'vercel.json',
  'wrangler.json',
  'wrangler.jsonc',
  'postcss.config.mjs',
  'components.json',
  '.oxlintrc.json',
  '.oxfmtrc.json',
  'playwright.config.ts',
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'THIRD_PARTY.md',
]);
const sourceRoots = new Set([
  'app',
  'components',
  'lib',
  'db',
  'public',
  'content',
  'scripts',
  'tests',
  'docs',
]);
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.css',
  '.html',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.gif',
  '.avif',
  '.sql',
  '.sh',
  '.py',
  '.toml',
  '.yaml',
  '.yml',
  '.txt',
]);

export function candidateSource(file) {
  if (
    typeof file !== 'string' ||
    !file ||
    path.isAbsolute(file) ||
    file.includes('\\')
  )
    return false;
  const parts = file.split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '..' ||
        p === '.' ||
        p.startsWith('.env') ||
        p.startsWith('.dev.vars') ||
        [
          '.git',
          '.handoff',
          '.wrangler',
          '.qa-config',
          '.output',
          '.nitro',
          'node_modules',
          'outputs',
          'work',
          'backups',
          'private-backups',
          'private-recordings',
          'recordings',
          '.run',
        ].includes(p),
    )
  )
    return false;
  if (
    file.startsWith('public/audio/') ||
    /\.(?:sqlite|db|log|m4a|wav|mp3|aac|ogg|webm|pem|key)(?:-.*)?$/i.test(
      file,
    ) ||
    /(?:^|\/)(?:STATUS|NEXT-SESSION)\.md$/.test(file)
  )
    return false;
  return (
    rootFiles.has(file) ||
    (parts.length > 1 &&
      sourceRoots.has(parts[0]) &&
      sourceExtensions.has(path.extname(file).toLowerCase()))
  );
}

export function runtimeEnvironment(source = process.env) {
  const result = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'])
    if (source[key] !== undefined) result[key] = source[key];
  return { ...result, CI: '1', NO_COLOR: '1' };
}

function ownedFile(root, file) {
  if (!candidateSource(file)) throw new Error(`Rejected source path: ${file}`);
  let current = root;
  for (const part of file.split('/')) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new Error(`Missing source file: ${file}`);
    }
    if (stat.isSymbolicLink())
      throw new Error(`Source symlink rejected: ${file}`);
  }
  if (!fs.statSync(current).isFile())
    throw new Error(`Source is not a file: ${file}`);
  return current;
}

function ownedEvidenceLocation(manifest) {
  const file = path.join(manifest.work, '.hanzi-qa-evidence.json');
  const legacy = path.join(
    ROOT,
    'outputs',
    'qa',
    `readiness-${manifest.phase || 'r2'}`,
    manifest.runId,
  );
  // Old R2 manifests predate the portable record and retain their original rule.
  if (!fs.existsSync(file) && (!manifest.phase || manifest.phase === 'r2'))
    return legacy;
  try {
    const info = fs.lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 4096
    )
      throw new Error();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const suffix = path.join(
      'outputs',
      'qa',
      `readiness-${manifest.phase || 'r2'}`,
      manifest.runId,
    );
    if (
      Object.keys(saved).length !== 3 ||
      saved.schemaVersion !== 'readiness-evidence-location-1' ||
      saved.runId !== manifest.runId ||
      !path.isAbsolute(saved.output || '') ||
      path.normalize(saved.output) !== saved.output ||
      !saved.output.endsWith(path.sep + suffix)
    )
      throw new Error();
    return saved.output;
  } catch {
    throw new Error('Runner evidence location record is invalid');
  }
}

export function readinessPhase(phase) {
  if (!['r2', 'r3', 'r4', 'r5', 'r6'].includes(phase))
    throw new Error('Unsupported readiness phase');
  return {
    specVersion: `${phase}-spec-2`,
    integrationVersion: `${phase}-integration-1`,
    lessonVersion:
      phase === 'r6'
        ? 'hanzi-starter-draft-v1'
        : phase === 'r5'
          ? 'little-hanzi-path-1-v1'
          : phase === 'r2'
            ? 'forest-01-v3'
            : 'forest-01-v4',
  };
}

export function verifyNodeManifest(manifest, { built = false } = {}) {
  if (manifest?.phase !== undefined) readinessPhase(manifest.phase);
  if (
    manifest?.phase === 'r6' &&
    !Object.entries(readinessPhase('r6')).every(
      ([key, value]) => manifest[key] === value,
    )
  )
    throw new Error('Runner phase identity mismatch');
  if (
    !manifest ||
    !path.isAbsolute(manifest.work || '') ||
    fs.realpathSync(manifest.work) !== manifest.work ||
    !path.basename(manifest.work).startsWith('hanzi-node-')
  )
    throw new Error('An owned runner directory is required');
  if (!manifest.work.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
    throw new Error('Runner work must be in the actual temporary directory');
  const marker = path.join(manifest.work, '.hanzi-qa-owned');
  if (
    !fs.existsSync(marker) ||
    fs.readFileSync(marker, 'utf8') !== manifest.runId
  )
    throw new Error('Runner ownership marker mismatch');
  if (
    manifest.snapshot !== path.join(manifest.work, 'candidate') ||
    fs.realpathSync(manifest.snapshot) !== manifest.snapshot
  )
    throw new Error('Candidate snapshot must be inside its owned directory');
  if (!Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error('Candidate source files are required');
  for (const file of manifest.files) ownedFile(manifest.snapshot, file);
  if (digest(manifest.snapshot, manifest.files) !== manifest.digest)
    throw new Error('Candidate source digest changed');
  if (built) {
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(manifest.runId) ||
      manifest.output !== ownedEvidenceLocation(manifest)
    )
      throw new Error(
        'Candidate output must be its designated evidence directory',
      );
    if (
      manifest.nodeEntry !==
      path.join(manifest.snapshot, '.output', 'server', 'index.mjs')
    )
      throw new Error('Node entry must be the built candidate handler');
    const actual = artifactFiles(manifest.snapshot);
    if (
      !Array.isArray(manifest.artifactFiles) ||
      !actual.includes('.output/server/index.mjs') ||
      JSON.stringify(actual) !== JSON.stringify(manifest.artifactFiles) ||
      digest(manifest.snapshot, actual) !== manifest.artifactDigest
    )
      throw new Error('Built artifact identity changed');
  }
  return manifest;
}

function artifactFiles(snapshot) {
  const files = [];
  const visit = (relative) => {
    const full = path.join(snapshot, relative);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || fs.realpathSync(full) !== full)
      throw new Error('Built artifact symlinks are not permitted');
    if (stat.isDirectory())
      for (const name of fs.readdirSync(full).sort())
        visit(`${relative}/${name}`);
    else if (stat.isFile()) files.push(relative);
    else throw new Error('Unexpected built artifact type');
  };
  visit('.output');
  if (fs.existsSync(path.join(snapshot, '.openai/hosting.json')))
    visit('.openai/hosting.json');
  return files.sort((a, b) => a.localeCompare(b));
}

export function jsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function prepareNodeCandidate({
  phase = 'r2',
  reuseDependenciesFrom = null,
} = {}) {
  const phaseIdentity = readinessPhase(phase);
  const files = sourceFiles(ROOT).filter(candidateSource);
  for (const file of files) ownedFile(ROOT, file);
  const fingerprint = digest(ROOT, files);
  const candidateId = `readiness-${phase}-${fingerprint.slice(0, 12)}`;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${fingerprint.slice(0, 8)}`;
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-'),
  );
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), runId, { mode: 0o600 });
  const snapshot = path.join(work, 'candidate');
  const buildState = path.join(work, 'build-state');
  const output = path.join(ROOT, 'outputs', 'qa', `readiness-${phase}`, runId);
  fs.writeFileSync(
    path.join(work, '.hanzi-qa-evidence.json'),
    JSON.stringify({
      schemaVersion: 'readiness-evidence-location-1',
      runId,
      output,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  fs.mkdirSync(snapshot);
  fs.mkdirSync(buildState);
  fs.mkdirSync(output, { recursive: true });
  for (const file of files) {
    const destination = path.join(snapshot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), destination);
  }
  // The Worker build imports this shape. Generate a disposable binding record;
  // never copy the workspace hosting/project identity into a fixture.
  fs.mkdirSync(path.join(snapshot, '.openai'));
  fs.writeFileSync(
    path.join(snapshot, '.openai/hosting.json'),
    JSON.stringify({
      d1: 'DB',
      r2: null,
      project_id: 'isolated-readiness-candidate',
    }) + '\n',
  );
  const manifest = {
    runId,
    candidateId,
    phase,
    ...phaseIdentity,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
      .toString()
      .trim(),
    digest: fingerprint,
    files,
    work,
    snapshot,
    buildState,
    output,
    node: process.version,
    createdAt: new Date().toISOString(),
    checks: [],
  };
  verifyNodeManifest(manifest);
  if (reuseDependenciesFrom !== null) {
    const donor = verifyNodeManifest(
      JSON.parse(fs.readFileSync(reuseDependenciesFrom, 'utf8')),
    );
    if (
      !donor.checks.some(
        (check) =>
          check.command === 'npm ci --no-audit --no-fund' &&
          check.exitCode === 0,
      )
    )
      throw new Error('Dependency donor has no successful frozen installation');
    for (const name of ['package.json', 'package-lock.json']) {
      if (
        !fs
          .readFileSync(path.join(donor.snapshot, name))
          .equals(fs.readFileSync(path.join(snapshot, name)))
      )
        throw new Error('Dependency donor package or lock differs');
    }
    const dependencies = path.join(donor.snapshot, 'node_modules');
    if (
      !fs.lstatSync(dependencies).isDirectory() ||
      fs.realpathSync(dependencies) !== dependencies
    )
      throw new Error('Dependency donor must own a real installation');
    fs.symlinkSync(dependencies, path.join(snapshot, 'node_modules'), 'dir');
    manifest.dependencyReuse = {
      donorCandidateId: donor.candidateId,
      donorManifest: path.resolve(reuseDependenciesFrom),
      dependencies,
    };
    manifest.checks.push({
      command: 'Reuse owned lock-verified dependencies',
      exitCode: 0,
      signal: null,
      log: null,
    });
  }
  const emptyNpmConfig = path.join(work, 'empty.npmrc');
  fs.writeFileSync(emptyNpmConfig, '');
  const env = {
    ...runtimeEnvironment(),
    NPM_CONFIG_USERCONFIG: emptyNpmConfig,
    npm_config_cache: path.join(
      fs.realpathSync(os.tmpdir()),
      'hanzi-npm-cache',
    ),
    WRANGLER_SEND_METRICS: 'false',
    HANZI_PREVIEW_MODE: '1',
    HANZI_TEST_MODE: '1',
    HANZI_TEST_STATE_DIR: buildState,
    HANZI_TEST_RUN_ID: runId,
    HANZI_TEST_TOKEN: crypto.randomBytes(24).toString('hex'),
    HANZI_CANDIDATE_ID: candidateId,
  };
  const commands = [
    ...(reuseDependenciesFrom === null
      ? [['ci', '--no-audit', '--no-fund']]
      : []),
    ['run', 'typecheck'],
    ['test'],
    ...(['r5', 'r6'].includes(phase) ? [['run', 'test:pilot-ops-http']] : []),
    ...(phase === 'r6' ? [['run', 'test:corpus-database']] : []),
    ['run', 'curriculum:check'],
    ...(['r5', 'r6'].includes(phase)
      ? [
          [
            'run',
            'curriculum:check',
            '--',
            '--dir',
            'content/curriculum/collection',
            '--audit',
          ],
        ]
      : []),
    ...(phase === 'r6'
      ? [
          [
            'run',
            'curriculum:check',
            '--',
            '--dir',
            'content/curriculum/corpus',
            '--audit',
          ],
          [
            'run',
            'curriculum:check',
            '--',
            '--dir',
            'tests/fixtures/curriculum/corpus-stress/packages',
            '--audit',
          ],
        ]
      : []),
    // Limit discovery to every frozen source file. A source snapshot has no
    // Git metadata; default discovery can traverse its installed dependencies.
    [
      'run',
      'lint',
      '--',
      ...files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)),
    ],
    ['run', 'build:node'],
    ['run', 'build'],
  ];
  for (const args of commands) {
    const label = args.includes('--')
      ? args.slice(0, args.indexOf('--'))
      : args;
    const name =
      label.join('-').replace(/[^A-Za-z0-9_-]/g, '_') +
      (args.includes('content/curriculum/collection') ? '-collection' : '') +
      (args.includes('content/curriculum/corpus') ? '-corpus' : '') +
      (args.includes('tests/fixtures/curriculum/corpus-stress/packages')
        ? '-corpus-stress'
        : '');
    process.stdout.write(
      `${candidateId}: npm ${label.join(' ')}${args.includes('--') ? ' (all frozen source files)' : ''}\n`,
    );
    const result = spawnSync('npm', args, {
      cwd: snapshot,
      env,
      encoding: 'utf8',
      maxBuffer: 20_000_000,
      timeout: 300_000,
    });
    fs.writeFileSync(
      path.join(output, `${name}.log`),
      `${result.stdout || ''}\n${result.stderr || ''}`.replaceAll(
        env.HANZI_TEST_TOKEN,
        '[redacted]',
      ),
    );
    manifest.checks.push({
      command: `npm ${args.join(' ')}`,
      exitCode: result.status,
      signal: result.signal,
      log: `${name}.log`,
    });
    if (result.status !== 0) {
      jsonFile(path.join(output, 'prepare-failure.json'), manifest);
      throw new Error(
        `Candidate check failed: npm ${label.join(' ')}; see ${output}/${name}.log`,
      );
    }
  }
  verifyNodeManifest(manifest);
  const nodeEntry = path.join(snapshot, '.output', 'server', 'index.mjs');
  if (!fs.existsSync(nodeEntry)) throw new Error('Node build entry is missing');
  manifest.materializedPackages = materializeNitroPackages(manifest);
  manifest.nodeEntry = nodeEntry;
  manifest.artifactFiles = artifactFiles(snapshot);
  manifest.artifactDigest = digest(snapshot, manifest.artifactFiles);
  manifest.lockSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(snapshot, 'package-lock.json')))
    .digest('hex');
  manifest.fileHashes = Object.fromEntries(
    files.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(snapshot, file)))
        .digest('hex'),
    ]),
  );
  jsonFile(path.join(output, 'manifest.json'), manifest);
  process.stdout.write(`Manifest: ${path.join(output, 'manifest.json')}\n`);
  return manifest;
}

export function materializeNitroPackages(manifest) {
  verifyNodeManifest(manifest);
  const output = path.join(manifest.snapshot, '.output');
  const modules = path.join(output, 'server', 'node_modules');
  const store = path.join(modules, '.nf3');
  if (fs.realpathSync(output) !== output || !fs.lstatSync(output).isDirectory())
    throw new Error('Built artifact root must be an owned directory');
  const links = [];
  function plainTree(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink())
      throw new Error('Nested package links are not permitted');
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file))
        plainTree(path.join(file, entry));
    } else if (!stat.isFile())
      throw new Error('Package artifacts must be regular files');
  }
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (
        !file.startsWith(modules + path.sep) ||
        fs.realpathSync(store) !== store ||
        !target.startsWith(store + path.sep) ||
        !fs.lstatSync(target).isDirectory()
      )
        throw new Error(
          'Only internal Nitro package links may be materialized',
        );
      plainTree(target);
      links.push({ file, target });
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry));
    } else if (!stat.isFile())
      throw new Error('Built artifacts must be regular files');
  }
  // Validate the complete graph before replacing any link. Runtime manifests
  // continue to reject all symlinks and hash the materialized package bytes.
  visit(output);
  for (const { file, target } of links) {
    fs.unlinkSync(file);
    fs.cpSync(target, file, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  return links.map(({ file, target }) => ({
    file: path.relative(manifest.snapshot, file),
    target: path.relative(manifest.snapshot, target),
  }));
}

export function launched(command, args, options) {
  const secrets = options.secrets || [];
  const log = fs.createWriteStream(options.log, { flags: 'a', mode: 0o600 });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnError = null;
  child.on('error', (error) => {
    spawnError = error;
    log.write(`Process launch failed: ${error.code || 'unknown'}\n`);
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (let line of lines) {
        for (const secret of secrets)
          if (secret) line = line.replaceAll(secret, '[redacted]');
        log.write(line + '\n');
      }
    });
    stream.on('end', () => {
      for (const secret of secrets)
        if (secret) pending = pending.replaceAll(secret, '[redacted]');
      if (pending) log.write(pending);
    });
  }
  return {
    child,
    get error() {
      return spawnError;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null && !spawnError) {
        const exited = once(child, 'exit').catch(() => []);
        child.kill('SIGTERM');
        try {
          await bounded(exited, 4000, 'Owned process graceful stop');
        } catch {
          /* Escalate only this owned child below. */
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await bounded(exited, 4000, 'Owned process stop');
        }
      }
      await bounded(
        new Promise((resolve) => log.end(resolve)),
        2000,
        'Owned process log close',
      );
    },
  };
}

export async function serveNodeCandidate(manifestFile) {
  const manifest = verifyNodeManifest(
    JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
    { built: true },
  );
  const requireFromSnapshot = createRequire(
    path.join(manifest.snapshot, 'package.json'),
  );
  const { createClient } = await import(
    pathToFileURL(requireFromSnapshot.resolve('@libsql/client/web')).href
  );
  const output = path.join(manifest.output, `runtime-${Date.now()}`);
  fs.mkdirSync(output, { recursive: true });
  const state = fs.mkdtempSync(path.join(manifest.work, 'libsql-'));
  const sqldPath =
    process.env.HANZI_SQLD_BINARY || path.join(os.homedir(), '.turso', 'sqld');
  if (!fs.existsSync(sqldPath))
    throw new Error(
      'Local sqld is required; set HANZI_SQLD_BINARY to its absolute path',
    );
  const sqldVersion = execFileSync(sqldPath, ['--version'], {
    env: runtimeEnvironment(),
  })
    .toString()
    .trim();
  const ports = {
    database: await freePort(),
    app: await freePort(),
    ordinary: await freePort(),
    guard: await freePort(),
  };
  const urls = Object.fromEntries(
    Object.entries(ports).map(([key, value]) => [
      key,
      `http://127.0.0.1:${value}`,
    ]),
  );
  const token = crypto.randomBytes(32).toString('hex');
  const testRunId = `${manifest.runId}-node`;
  const owned = new Map();
  let control = null,
    closing = false,
    changing = false,
    stopRequested = false,
    resolveStop;
  const requestStop = () => {
    stopRequested = true;
    resolveStop?.();
  };
  const checkStop = () => {
    if (stopRequested) throw new Error('Runner stop requested');
  };
  const client = createClient({ url: urls.database, intMode: 'number' });
  const lifecycle = [];
  const record = (operation, service, pid) => {
    lifecycle.push({ operation, service, pid, at: new Date().toISOString() });
    jsonFile(path.join(output, 'processes.json'), {
      candidateId: manifest.candidateId,
      snapshot: manifest.snapshot,
      state,
      sqldPath,
      sqldVersion,
      ports,
      lifecycle,
    });
  };
  async function startDatabase() {
    checkStop();
    if (
      fs.realpathSync(state) !== state ||
      !state.startsWith(manifest.work + path.sep)
    )
      throw new Error('Database ownership changed');
    const service = launched(
      sqldPath,
      [
        '--db-path',
        state,
        '--http-listen-addr',
        `127.0.0.1:${ports.database}`,
        '--no-welcome',
        '--disable-metrics',
      ],
      {
        cwd: manifest.work,
        env: runtimeEnvironment(),
        log: path.join(output, 'sqld.log'),
      },
    );
    owned.set('database', service);
    record('start', 'database', service.child.pid);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      checkStop();
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned sqld process exited before ready');
      try {
        await bounded(
          client.execute('SELECT 1 AS readiness'),
          1000,
          'libSQL readiness',
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error('Owned sqld did not become ready');
  }
  async function startApp(name) {
    checkStop();
    const testing = name === 'app';
    const pilot = name === 'guard';
    const env = {
      ...runtimeEnvironment(),
      HOST: '127.0.0.1',
      PORT: String(ports[name]),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(ports[name]),
      HANZI_ALLOW_LOCAL_DATABASE: '1',
      HANZI_DATABASE_URL: urls.database,
      HANZI_PREVIEW_MODE: '1',
      HANZI_PILOT_MODE: pilot ? '1' : '0',
      HANZI_TEST_MODE: testing ? '1' : '0',
      HANZI_TEST_RUN_ID: testing ? testRunId : '',
      HANZI_TEST_TOKEN: testing ? token : '',
      HANZI_CANDIDATE_ID: manifest.candidateId,
    };
    const service = launched(process.execPath, [manifest.nodeEntry], {
      cwd: manifest.snapshot,
      env,
      log: path.join(output, `${name}.log`),
      secrets: [token],
    });
    owned.set(name, service);
    record('start', name, service.child.pid);
    if (pilot) {
      // Any HTTP response proves listener readiness; route denial is checked below.
      let response;
      for (let i = 0; i < 100; i++) {
        checkStop();
        try {
          response = await fetch(`${urls[name]}/api/preview/runs`, {
            signal: AbortSignal.timeout(1000),
          });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (response?.status !== 404)
        throw new Error('Pilot guard did not deny preview');
    } else {
      let response;
      for (let i = 0; i < 100; i++) {
        checkStop();
        if (service.error || service.child.exitCode !== null)
          throw new Error('Owned Node exited before ready');
        try {
          const r = await fetch(
            `${urls[name]}${testing ? '/api/test/identity' : '/api/preview/lessons/forest-01-v1/decision'}`,
            {
              headers: testing ? { 'X-Hanzi-Test-Token': token } : {},
              signal: AbortSignal.timeout(1000),
            },
          );
          if (r.ok) {
            response = r;
            break;
          }
        } catch {
          /* bounded startup poll */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!response) throw new Error('Owned Node did not become ready');
      const identity = await response.json();
      if (
        identity.candidateId !== manifest.candidateId ||
        (testing && identity.testRunId !== testRunId)
      )
        throw new Error('Owned Node identity mismatch');
    }
    if (service.error || service.child.exitCode !== null)
      throw new Error('Owned Node process exited');
  }
  async function stop(name) {
    const service = owned.get(name);
    if (service) {
      await service.stop();
      record('stop', name, service.child.pid);
      owned.delete(name);
    }
  }
  async function restart(name) {
    if (!['app', 'database', 'all'].includes(name))
      throw new Error('Unknown restart service');
    if (name === 'all') {
      for (const key of ['guard', 'ordinary', 'app', 'database'])
        await stop(key);
      await startDatabase();
      for (const key of ['app', 'ordinary', 'guard']) await startApp(key);
    } else {
      await stop(name);
      if (name === 'database') await startDatabase();
      else await startApp(name);
    }
  }
  const tokenFile = path.join(
    manifest.work,
    `runtime-${Date.now()}-private.json`,
  );
  async function cleanup() {
    if (closing) return;
    closing = true;
    const errors = [];
    if (control) {
      try {
        await bounded(
          new Promise((resolve) => control.close(resolve)),
          5000,
          'Control close',
        );
      } catch (error) {
        control.closeAllConnections();
        errors.push(error.message);
      }
    }
    for (const name of ['guard', 'ordinary', 'app', 'database']) {
      try {
        await stop(name);
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }
    client.close();
    fs.rmSync(tokenFile, { force: true });
    jsonFile(path.join(output, 'cleanup.json'), {
      ownedProcessesStopped: owned.size === 0,
      tokenRemoved: true,
      stateRetained: state,
      errors,
      at: new Date().toISOString(),
    });
    if (errors.length)
      throw new Error('Runner cleanup incomplete; inspect its cleanup.json');
  }
  try {
    process.on('SIGINT', requestStop);
    process.on('SIGTERM', requestStop);
    await startDatabase();
    await startApp('app');
    // Verify actual same-path persistence across both database and app restart.
    const response = await fetch(`${urls.app}/api/preview/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lessonId: 'forest-01',
        lessonVersion: 'forest-01-v1',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 201)
      throw new Error('Persistence sentinel create failed');
    const sentinel = await response.json();
    const sentinelPath = `/api/preview/runs/${encodeURIComponent(sentinel.runId)}`;
    const before = await (
      await fetch(urls.app + sentinelPath, {
        signal: AbortSignal.timeout(10000),
      })
    ).text();
    await stop('app');
    await stop('database');
    await startDatabase();
    await startApp('app');
    const after = await (
      await fetch(urls.app + sentinelPath, {
        signal: AbortSignal.timeout(10000),
      })
    ).text();
    if (before !== after)
      throw new Error(
        'Real libSQL persistence sentinel changed across restart',
      );
    const removed = await fetch(
      `${urls.app}/api/test/runs/${encodeURIComponent(sentinel.runId)}`,
      {
        method: 'DELETE',
        headers: { 'X-Hanzi-Test-Token': token },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!removed.ok) throw new Error('Persistence sentinel cleanup failed');
    await startApp('ordinary');
    await startApp('guard');
    control = http.createServer(async (req, res) => {
      const send = (status, body) => {
        res
          .writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          .end(JSON.stringify(body));
      };
      if (stopRequested) return send(503, { error: 'runner stopping' });
      if (req.headers['x-hanzi-test-token'] !== token)
        return send(403, { error: 'runner token required' });
      if (req.method !== 'POST') return send(404, { error: 'unknown control' });
      try {
        const text = await bounded(
          (async () => {
            let value = '';
            for await (const chunk of req) {
              value += chunk;
              if (value.length > 4096)
                throw new Error('control payload too large');
            }
            return value;
          })(),
          5000,
          'Control payload',
        );
        const body = JSON.parse(text || '{}');
        if (req.url === '/restart') {
          if (changing) return send(409, { error: 'restart in progress' });
          changing = true;
          try {
            await bounded(
              restart(body.service || 'app'),
              45000,
              'Owned restart',
            );
          } catch (error) {
            requestStop();
            throw error;
          } finally {
            changing = false;
          }
          return send(200, { restarted: true, service: body.service || 'app' });
        }
        if (req.url === '/inspect') {
          if (body.kind === 'legacy') {
            if (
              typeof body.profile !== 'string' ||
              !body.profile.startsWith('qa-legacy-')
            )
              return send(400, { error: 'synthetic legacy profile required' });
            const rows = await bounded(
              client.execute({
                sql: 'SELECT profile,id,created_at,payload FROM attempts WHERE profile=? ORDER BY id',
                args: [body.profile],
              }),
              10000,
              'Legacy inspection',
            );
            return send(200, { rows: Array.from(rows.rows) });
          }
          if (
            body.kind !== 'run' ||
            typeof body.runId !== 'string' ||
            !/^[A-Za-z0-9:_-]{1,120}$/.test(body.runId)
          )
            return send(400, { error: 'bounded run query required' });
          const run = await bounded(
            client.execute({
              sql: 'SELECT * FROM preview_runs WHERE run_id=?',
              args: [body.runId],
            }),
            10000,
            'Run inspection',
          );
          const row = run.rows[0];
          if (
            row &&
            !(row.synthetic === 1 && row.test_run_id === testRunId) &&
            !(row.synthetic === 0 && row.test_run_id === null)
          )
            return send(403, { error: 'different namespace' });
          const events = await bounded(
            client.execute({
              sql: 'SELECT * FROM preview_events WHERE run_id=? ORDER BY sequence',
              args: [body.runId],
            }),
            10000,
            'Event inspection',
          );
          return send(200, {
            run: row || null,
            events: Array.from(events.rows),
          });
        }
        return send(404, { error: 'unknown control' });
      } catch (error) {
        return send(500, { error: error.message });
      }
    });
    control.requestTimeout = 6000;
    control.headersTimeout = 6000;
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    jsonFile(tokenFile, { token });
    const handoff = {
      candidateId: manifest.candidateId,
      manifest: path.resolve(manifestFile),
      specVersion: manifest.specVersion,
      integrationVersion: manifest.integrationVersion,
      lessonVersion: manifest.lessonVersion,
      testRunId,
      baseURL: urls.app,
      ordinaryBaseURL: urls.ordinary,
      pilotGuardBaseURL: urls.guard,
      controlURL: `http://127.0.0.1:${control.address().port}`,
      tokenFile,
      state,
      snapshot: manifest.snapshot,
      output,
      sqldVersion,
      sourceDigest: manifest.digest,
      cdpURL: 'http://127.0.0.1:9222',
      sentinelSurvivedAppAndDatabaseRestart: true,
      sentinelRemoved: true,
      createdAt: new Date().toISOString(),
    };
    jsonFile(path.join(output, 'handoff.json'), handoff);
    process.stdout.write(`READY ${path.join(output, 'handoff.json')}\n`);
    await new Promise((resolve) => {
      resolveStop = resolve;
      if (stopRequested) resolve();
    });
  } finally {
    try {
      await cleanup();
    } finally {
      process.off('SIGINT', requestStop);
      process.off('SIGTERM', requestStop);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === 'prepare') await prepareNodeCandidate();
    else if (process.argv[2] === 'serve' && process.argv[3])
      await serveNodeCandidate(process.argv[3]);
    else
      throw new Error(
        'Usage: node scripts/readiness-node-runner.mjs prepare | serve <manifest.json>',
      );
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
