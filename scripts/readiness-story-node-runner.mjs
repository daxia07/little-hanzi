/** Fresh real Node/libSQL ordinary-story candidate harness; never the family database. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { collectionProfile } from './readiness-collection-profiles.mjs';
import { storyProfile } from './readiness-story-profiles.mjs';
import { storySchemaSource } from './pilot-story-schema.mjs';
import { collectionSchemaSource } from './pilot-collection-schema.mjs';
export { storyProfile } from './readiness-story-profiles.mjs';

/** Stage an exact known schema prefix for a historical runner, never edit its snapshot. */
export function stageStoryMigrationSource(sourceRoot, targetRoot, phase) {
  if (!['r3', 'r4', 'r5'].includes(phase))
    throw new Error('Unsupported historical story runner');
  const source =
    phase === 'r5'
      ? collectionSchemaSource(sourceRoot)
      : storySchemaSource(sourceRoot);
  fs.mkdirSync(targetRoot, { mode: 0o700 });
  const directory = path.join(targetRoot, 'db', 'pilot-migrations');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const migration of source.migrations) {
    const bytes = fs.readFileSync(
      path.join(sourceRoot, 'db', 'pilot-migrations', migration.name),
    );
    if (
      crypto.createHash('sha256').update(bytes).digest('hex') !==
      migration.sha256
    )
      throw new Error('Historical migration changed during staging');
    fs.writeFileSync(path.join(directory, migration.name), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return targetRoot;
}
export function validatePositiveTarget(evidence, target) {
  if (!opaque(evidence) || !opaque(target) || evidence === target)
    throw new Error('Positive target must be a distinct owned installation');
  return true;
}
export function liveStoryIssuer(issuer, state, now = Date.now()) {
  if (
    !['active', 'revoked', 'future-not-before', 'candidate-purpose'].includes(
      state,
    ) ||
    !Number.isSafeInteger(now)
  )
    throw new Error('Invalid named issuer state');
  return {
    ...structuredClone(issuer),
    ...(state === 'revoked'
      ? { revokedAt: now }
      : state === 'future-not-before'
        ? { notBefore: now + 300000 }
        : state === 'candidate-purpose'
          ? { purpose: 'candidate' }
          : {}),
  };
}
import {
  verifyNodeManifest,
  prepareNodeCandidate,
  runtimeEnvironment,
  launched,
  bounded,
  jsonFile,
  freePort,
} from './readiness-node-runner.mjs';
const strict = (body, keys) =>
  body &&
  typeof body === 'object' &&
  !Array.isArray(body) &&
  Object.keys(body).length === keys.length &&
  keys.every((k) => Object.hasOwn(body, k));
const opaque = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v);
export function validateRestartLibrary(body, scope, publicationId) {
  if (
    !Array.isArray(body?.items) ||
    !body.items.some(
      (item) =>
        item.lessonVersion === 'forest-01-v4' &&
        item.contentDigest === scope.contentDigest &&
        item.publicationId === publicationId &&
        item.available === true,
    )
  )
    throw new Error('Authenticated restart library identity changed');
  return true;
}
export function restoreFaultClient(client, fault) {
  if (fault === 'none') return client;
  if (!['final-write', 'uncertain'].includes(fault))
    throw new Error('Invalid restore fault');
  return {
    execute: (...args) => client.execute(...args),
    async batch(statements, mode) {
      const result = await client.batch(
        fault === 'final-write'
          ? [
              ...statements,
              {
                sql: 'INSERT INTO pilot_curriculum_registry_state(id,revision,updated_at) VALUES(1,0,0)',
              },
            ]
          : statements,
        mode,
      );
      if (fault === 'uncertain')
        throw new Error('Synthetic committed restore acknowledgement lost');
      return result;
    },
  };
}
export function corruptStoryChecksum(envelope) {
  const clone = structuredClone(envelope);
  clone.payload.createdAt = `${clone.payload.createdAt}-corrupt`;
  return clone;
}
export function safeAuthFailure(status, body) {
  const code =
    typeof body?.code === 'string' && /^[A-Z_]{1,80}$/.test(body.code)
      ? body.code
      : 'UNKNOWN_AUTH_ERROR';
  return `Ordinary synthetic sign-in failed (${Number.isInteger(status) ? status : 0} ${code})`;
}
export function runnerOperationFailure(route, error) {
  const known = [
    '/clock',
    '/restart',
    '/fault-final',
    '/inspect',
    '/backup',
    '/restore',
    '/verify-and-sign',
    '/target-issuer',
  ];
  const fixedRoute = known.includes(route) ? route : '/unknown';
  const code =
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : 'OWNED_RUNNER_UNAVAILABLE';
  const timeout =
    error?.name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    /(?:^|_)TIMEOUT(?:_|$)|(?:^|_)TIMED_OUT(?:_|$)/.test(code) ||
    /timed out$/i.test(String(error?.message || ''));
  const recoverable =
    fixedRoute === '/backup' && /^BACKUP_[A-Z0-9_]+$/.test(code) && !timeout;
  return {
    route: fixedRoute,
    code,
    stop:
      ['/restart', '/clock', '/backup', '/restore', '/target-issuer'].includes(
        fixedRoute,
      ) && !recoverable,
  };
}
export function restoreFailureCode(error) {
  if (
    error?.code === 'BACKUP_CHECKSUM_INVALID' ||
    error?.message === 'Pilot backup: backup checksum is invalid'
  )
    return 'BACKUP_CHECKSUM_INVALID';
  return typeof error?.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : 'RESTORE_FAILED';
}
export function validateStoryControl(
  route,
  body,
  scope,
  profile = 'family-story',
) {
  const config = storyProfile(profile);
  if (Object.hasOwn(body || {}, 'target')) {
    if (
      config.name !== 'positive-publication' ||
      body.target !== 'ordinary' ||
      !['/inspect', '/fault-final', '/backup', '/restore'].includes(route)
    )
      throw new Error('Invalid named target');
    const { target: _target, ...rest } = body;
    return validateStoryControl(route, rest, scope, profile);
  }
  let valid = false;
  switch (route) {
    case '/target-issuer':
      valid =
        config.name === 'positive-publication' &&
        strict(body, ['state']) &&
        [
          'active',
          'revoked',
          'future-not-before',
          'candidate-purpose',
        ].includes(body.state);
      break;
    case '/clock':
      valid =
        strict(body, ['at']) && Number.isSafeInteger(body.at) && body.at >= 0;
      break;
    case '/restart':
      valid =
        strict(body, ['service']) &&
        ['app', 'database', 'all'].includes(body.service);
      break;
    case '/fault-final':
      valid =
        strict(body, ['operation', 'enabled']) &&
        ['plan', 'publication', 'action'].includes(body.operation) &&
        typeof body.enabled === 'boolean';
      break;
    case '/inspect':
      valid =
        (strict(body, ['kind']) &&
          ['counts', 'publication', 'installation'].includes(body.kind)) ||
        (strict(body, ['kind', 'runId']) &&
          body.kind === 'run' &&
          opaque(body.runId)) ||
        (strict(body, ['kind', 'childId']) &&
          body.kind === 'plan' &&
          scope.childIds.includes(body.childId));
      break;
    case '/backup':
      valid = strict(body, ['name']) && body.name === 'populated';
      break;
    case '/restore':
      valid =
        strict(body, ['name', 'fault']) &&
        body.name === 'populated' &&
        ['none', 'final-write', 'uncertain', 'checksum-corrupt'].includes(
          body.fault,
        );
      break;
    case '/verify-and-sign':
      valid = strict(body, ['suite']) && body.suite === 'family-story';
      break;
  }
  if (!valid) throw new Error('Invalid named runner control');
  return true;
}
export function syntheticStoryAccounts(namespace, { collection = false } = {}) {
  if (!opaque(namespace)) throw new Error('Synthetic namespace required');
  return [
    ['operator', 'operator'],
    ['parent-a', 'parent'],
    ['parent-b', 'parent'],
    ['child-a', 'child'],
    ['child-a2', 'child'],
    ['child-b', 'child'],
    ['teacher', 'teacher'],
    ...(collection
      ? Array.from({ length: 10 }, (_, i) => [
          `collection-child-${String(i + 1).padStart(2, '0')}`,
          'child',
        ])
      : []),
  ].map(([label, role]) => ({
    id: `qa-story-${label}`,
    label,
    name: `QA ${label.replaceAll('-', ' ')}`,
    username: `qa_story_${label.replaceAll('-', '_')}`,
    role,
    password: crypto.randomBytes(24).toString('base64url'),
  }));
}
export function validateStoryScope(scope, accounts) {
  if (
    !strict(scope, [
      'installationId',
      'contentDigest',
      'namespace',
      'childIds',
      'parentIds',
    ]) ||
    !opaque(scope.installationId) ||
    !opaque(scope.namespace) ||
    !/^sha256:[a-f0-9]{64}$/.test(scope.contentDigest) ||
    !Array.isArray(scope.childIds) ||
    !Array.isArray(scope.parentIds) ||
    !scope.childIds.length ||
    !scope.parentIds.length ||
    new Set(scope.childIds).size !== scope.childIds.length ||
    new Set(scope.parentIds).size !== scope.parentIds.length ||
    scope.childIds.some(
      (id) => !accounts.some((a) => a.id === id && a.role === 'child'),
    ) ||
    scope.parentIds.some(
      (id) => !accounts.some((a) => a.id === id && a.role === 'parent'),
    )
  )
    throw new Error('Invalid synthetic account capability');
  return true;
}
export function storyBindings(
  {
    testing,
    port,
    databaseURL,
    candidateId,
    authSecret,
    origin,
    scope,
    trust,
    token = '',
    clock = null,
    ordinaryTrust = null,
  },
  source = process.env,
) {
  const url = new URL(databaseURL);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.username ||
    url.password
  )
    throw new Error('Runner database must be its loopback listener');
  return {
    ...runtimeEnvironment(source),
    HOST: '127.0.0.1',
    PORT: String(port),
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: String(port),
    HANZI_ALLOW_LOCAL_DATABASE: '1',
    HANZI_DATABASE_URL: databaseURL,
    HANZI_PILOT_MODE: '1',
    HANZI_PREVIEW_MODE: '0',
    HANZI_TEST_MODE: testing ? '1' : '0',
    HANZI_PILOT_TEST_CONTENT: testing ? '1' : '0',
    HANZI_TEST_RUN_ID: testing ? scope.namespace : '',
    HANZI_TEST_TOKEN: testing ? token : '',
    HANZI_CANDIDATE_ID: candidateId,
    HANZI_AUTH_ORIGIN: origin,
    HANZI_AUTH_SECRET: authSecret,
    HANZI_CURRICULUM_TRUST: testing
      ? JSON.stringify(trust)
      : ordinaryTrust
        ? JSON.stringify(ordinaryTrust)
        : '',
    HANZI_STORY_CAPABILITY: testing ? JSON.stringify(scope) : '',
    HANZI_CURRICULUM_TEST_NOW: testing && clock !== null ? String(clock) : '',
  };
}
export function verifyStoryManifest(manifest) {
  if (
    !['r3', 'r4', 'r5'].includes(manifest?.phase) ||
    manifest.specVersion !== `${manifest.phase}-spec-2` ||
    manifest.integrationVersion !== `${manifest.phase}-integration-1` ||
    manifest.lessonVersion !==
      (manifest.phase === 'r5' ? 'little-hanzi-path-1-v1' : 'forest-01-v4')
  )
    throw new Error('Frozen R3/R4/R5 candidate required');
  return verifyNodeManifest(manifest, { built: true });
}
async function provisionAccounts(
  client,
  manifest,
  namespace,
  existingAccounts = null,
) {
  const requireFrom = createRequire(
    path.join(manifest.snapshot, 'package.json'),
  );
  const { hashPassword } = await import(
    pathToFileURL(requireFrom.resolve('better-auth/crypto')).href
  );
  const count = await client.execute(
    'SELECT COUNT(*) AS n FROM pilot_auth_user',
  );
  if (Number(count.rows[0].n) !== 0)
    throw new Error('Account provisioning requires fresh empty storage');
  const accounts =
    existingAccounts ??
    syntheticStoryAccounts(namespace, { collection: manifest.phase === 'r5' });
  const now = Date.now();
  const statements = [];
  for (const a of accounts) {
    const hash = await hashPassword(a.password);
    statements.push(
      {
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,?,?,?,?,?,0,0)',
        args: [
          a.id,
          a.name,
          `${a.id}@accounts.invalid`,
          now,
          now,
          a.username,
          a.username,
          a.role,
        ],
      },
      {
        sql: "INSERT INTO pilot_auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)",
        args: [crypto.randomUUID(), a.id, a.id, hash, now, now],
      },
      {
        sql: "INSERT INTO pilot_account_audit(id,action,actor_user_id,target_user_id,metadata,created_at) VALUES(?,'local-provision',NULL,?,?,?)",
        args: [
          crypto.randomUUID(),
          a.id,
          JSON.stringify({ role: a.role }),
          now,
        ],
      },
    );
  }
  for (const [child, parent] of [
    ['child-a', 'parent-a'],
    ['child-a2', 'parent-a'],
    ['child-b', 'parent-b'],
  ])
    statements.push({
      sql: 'INSERT INTO pilot_parent_child(parent_id,child_id,created_at,created_by)VALUES(?,?,?,?)',
      args: [
        `qa-story-${parent}`,
        `qa-story-${child}`,
        now,
        'qa-story-operator',
      ],
    });
  statements.push({
    sql: 'INSERT INTO pilot_teacher_grant(child_id,teacher_id,granting_parent_id,created_at)VALUES(?,?,?,?)',
    args: ['qa-story-child-a', 'qa-story-teacher', 'qa-story-parent-a', now],
  });
  if (manifest.phase === 'r5')
    for (let i = 1; i <= 10; i++) {
      const child = `qa-story-collection-child-${String(i).padStart(2, '0')}`;
      if (!accounts.some((a) => a.id === child && a.role === 'child'))
        throw new Error('Fixed collection child missing');
      statements.push(
        {
          sql: 'INSERT INTO pilot_parent_child(parent_id,child_id,created_at,created_by)VALUES(?,?,?,?)',
          args: ['qa-story-parent-a', child, now, 'qa-story-operator'],
        },
        {
          sql: 'INSERT INTO pilot_teacher_grant(child_id,teacher_id,granting_parent_id,created_at)VALUES(?,?,?,?)',
          args: [child, 'qa-story-teacher', 'qa-story-parent-a', now],
        },
      );
    }
  await client.batch(statements, 'write');
  return accounts;
}
export async function serveStoryNodeCandidate(
  manifestFile,
  {
    backupAdapter = null,
    profile = 'family-story',
    operationsFactory = null,
    collectionFactory = null,
    collectionProfileName = null,
  } = {},
) {
  const profileConfig = storyProfile(profile);
  const collectionConfig = collectionFactory
    ? collectionProfile(collectionProfileName ?? 'draft-collection')
    : null;
  if (collectionProfileName !== null && !collectionFactory)
    throw new Error('Collection profile requires its runner');
  const positive =
    profileConfig.name === 'positive-publication' ||
    collectionConfig?.name === 'positive-collection';
  const manifest = verifyStoryManifest(
    JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
  );
  if (
    (manifest.phase === 'r4' && typeof operationsFactory !== 'function') ||
    (operationsFactory && (manifest.phase === 'r3' || positive))
  )
    throw new Error(
      'R4 requires its frozen operations runner; optional R5 operations require draft collection',
    );
  if ((manifest.phase === 'r5') !== (typeof collectionFactory === 'function'))
    throw new Error('R5 requires its frozen collection runner');
  let operations = null,
    collection = null;
  const requireFrom = createRequire(
    path.join(manifest.snapshot, 'package.json'),
  );
  const { createClient } = await import(
    pathToFileURL(requireFrom.resolve('@libsql/client/web')).href
  );
  const { applyLibsqlMigrations } = await import(
    pathToFileURL(
      path.join(manifest.snapshot, 'scripts/pilot-libsql-admin.mjs'),
    ).href
  );
  const archiveAdapter = await import(
    pathToFileURL(
      path.join(
        manifest.snapshot,
        manifest.phase === 'r5'
          ? 'scripts/pilot-collection-libsql-backup.mjs'
          : 'scripts/pilot-story-libsql-backup.mjs',
      ),
    ).href
  );
  const backupStoryLibsql =
    manifest.phase === 'r5'
      ? archiveAdapter.backupCollectionLibsql
      : archiveAdapter.backupStoryLibsql;
  const restoreStoryLibsql =
    manifest.phase === 'r5'
      ? archiveAdapter.restoreCollectionLibsql
      : archiveAdapter.restoreStoryLibsql;
  const captureStoryLibsql =
    manifest.phase === 'r5'
      ? archiveAdapter.captureCollectionLibsql
      : archiveAdapter.captureStoryLibsql;
  const output = path.join(manifest.output, `story-runtime-${Date.now()}`);
  fs.mkdirSync(output, { recursive: true });
  const state = fs.mkdtempSync(path.join(manifest.work, 'story-libsql-'));
  const migrationRoot = stageStoryMigrationSource(
    manifest.snapshot,
    path.join(state, 'migration-source'),
    manifest.phase,
  );
  const binary =
    process.env.HANZI_SQLD_BINARY ?? path.join(os.homedir(), '.turso/sqld');
  if (!path.isAbsolute(binary) || !fs.existsSync(binary))
    throw new Error('Absolute local sqld binary required');
  const sqldVersion = execFileSync(binary, ['--version'], {
    env: runtimeEnvironment(),
    timeout: 5000,
  })
    .toString()
    .trim();
  const ports = {
    database: await freePort(),
    app: await freePort(),
    ordinary: await freePort(),
    ...(positive
      ? { targetDatabase: await freePort(), target: await freePort() }
      : {}),
  };
  const urls = Object.fromEntries(
    Object.entries(ports).map(([k, v]) => [k, `http://127.0.0.1:${v}`]),
  );
  const client = createClient({ url: urls.database, intMode: 'number' });
  const targetClient = positive
    ? createClient({ url: urls.targetDatabase, intMode: 'number' })
    : null;
  const targetState = positive
    ? fs.mkdtempSync(path.join(manifest.work, 'story-positive-target-'))
    : null;
  if (targetState)
    fs.writeFileSync(
      path.join(targetState, '.hanzi-qa-owned'),
      'Synthetic positive publication target',
      { mode: 0o600 },
    );
  const targetAuthSecret = positive
    ? crypto.randomBytes(40).toString('base64url')
    : null;
  const namespace = `${manifest.runId}-story`;
  const token = crypto.randomBytes(32).toString('hex'),
    authSecret = crypto.randomBytes(40).toString('base64url');
  const privateFile = path.join(
    manifest.work,
    `story-${Date.now()}-private.json`,
  );
  const owned = new Map();
  const proofAbort = new AbortController();
  const restoreClients = [];
  const lifecycle = [];
  const operationErrors = [];
  let control = null,
    scope = null,
    trust = null,
    targetScope = null,
    targetTrust = null,
    clock = null,
    closing = false,
    changing = false,
    proofInProgress = false,
    stopRequested = false,
    resolveStop,
    accounts = [];
  const keys = crypto.generateKeyPairSync('ed25519');
  const issuer = {
    issuerId: `candidate-${manifest.digest.slice(0, 12)}`,
    publicKeyJwk: keys.publicKey.export({ format: 'jwk' }),
    notBefore: Date.now() - 300000,
    revokedAt: null,
    purpose: 'candidate',
  };
  const releaseKeys = positive ? crypto.generateKeyPairSync('ed25519') : null;
  const targetIssuer = positive
    ? {
        issuerId: `synthetic-release-${manifest.digest.slice(0, 12)}`,
        publicKeyJwk: releaseKeys.publicKey.export({ format: 'jwk' }),
        notBefore: Date.now() - 300000,
        revokedAt: null,
        purpose: 'release',
      }
    : null;
  const record = (operation, name, service) => {
    lifecycle.push({
      operation,
      name,
      pid: service.child.pid,
      at: new Date().toISOString(),
    });
    jsonFile(path.join(output, 'processes.json'), {
      candidateId: manifest.candidateId,
      state,
      ports,
      lifecycle,
      sqldVersion,
    });
  };
  const requestStop = () => {
    stopRequested = true;
    proofAbort.abort();
    resolveStop?.();
  };
  const checkStop = () => {
    if (stopRequested) throw new Error('Runner stop requested');
  };
  async function startDatabase(name = 'database') {
    checkStop();
    const databaseState = name === 'targetDatabase' ? targetState : state;
    const databaseClient = name === 'targetDatabase' ? targetClient : client;
    if (
      fs.realpathSync(databaseState) !== databaseState ||
      !databaseState.startsWith(manifest.work + path.sep)
    )
      throw new Error('Owned database path changed');
    const service = launched(
      binary,
      [
        '--db-path',
        databaseState,
        '--http-listen-addr',
        `127.0.0.1:${ports[name]}`,
        '--no-welcome',
        '--disable-metrics',
      ],
      {
        cwd: manifest.work,
        env: runtimeEnvironment(),
        log: path.join(
          output,
          name === 'database' ? 'sqld.log' : `${name}-sqld.log`,
        ),
      },
    );
    owned.set(name, service);
    record('start', name, service);
    for (let i = 0; i < 100; i++) {
      checkStop();
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned sqld exited');
      try {
        await bounded(
          databaseClient.execute('SELECT 1'),
          1000,
          'Database readiness',
        );
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Owned sqld readiness timed out');
  }
  async function startApp(name) {
    checkStop();
    const testing = name === 'app';
    const application = operations?.application?.(name) ?? manifest;
    verifyNodeManifest(application, { built: true });
    const env = storyBindings({
      testing,
      port: ports[name],
      databaseURL: name === 'target' ? urls.targetDatabase : urls.database,
      candidateId: application.candidateId,
      origin: urls[name],
      authSecret: name === 'target' ? targetAuthSecret : authSecret,
      scope,
      trust,
      token,
      clock,
      ordinaryTrust: name === 'target' ? targetTrust : null,
    });
    const service = launched(process.execPath, [application.nodeEntry], {
      cwd: application.snapshot,
      env: {
        ...env,
        ...operations?.bindings?.(name),
        ...collection?.bindings?.(name),
      },
      log: path.join(output, `${name}.log`),
      secrets: [
        token,
        authSecret,
        ...(targetAuthSecret ? [targetAuthSecret] : []),
        ...accounts.map((a) => a.password),
      ],
    });
    owned.set(name, service);
    record('start', name, service);
    for (let i = 0; i < 100; i++) {
      checkStop();
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned Node exited');
      try {
        const r = await fetch(`${urls[name]}/api/pilot/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          const identity = await r.json();
          if (identity.candidateId !== application.candidateId)
            throw new Error('Node identity mismatch');
          return;
        }
      } catch (error) {
        if (error.message === 'Node identity mismatch') throw error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Owned Node readiness timed out');
  }
  async function stop(name) {
    const service = owned.get(name);
    if (service) {
      await service.stop();
      record('stop', name, service);
      owned.delete(name);
    }
  }
  async function restart(name) {
    if (name === 'all') {
      await stop('ordinary');
      await stop('app');
      await stop('database');
      await startDatabase();
      await startApp('app');
      await startApp('ordinary');
    } else if (name === 'database') {
      await stop('database');
      await startDatabase();
    } else {
      await stop('app');
      await startApp('app');
    }
  }
  async function signIn(account, baseURL = urls.app) {
    const r = await fetch(`${baseURL}/api/auth/sign-in/username`, {
      method: 'POST',
      headers: { Origin: baseURL, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: account.username,
        password: account.password,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      let failure = null;
      try {
        failure = await r.json();
      } catch {}
      throw new Error(safeAuthFailure(r.status, failure));
    }
    const cookies = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    if (!cookies) throw new Error('Synthetic session cookie missing');
    return cookies;
  }
  const archiveFiles = new Map();
  let restoreSequence = 0;
  async function ownedBackup(body, operation) {
    const selector = body.target === 'ordinary' ? 'ordinary' : 'evidence';
    const databaseClient = selector === 'ordinary' ? targetClient : client;
    const selectedScope = selector === 'ordinary' ? targetScope : scope;
    const archivedIssuer = selector === 'ordinary' ? targetIssuer : issuer;
    const archiveFile = archiveFiles.get(selector);
    if (operation === 'backup') {
      const filePath = path.join(
        manifest.work,
        'private-backups',
        `populated-${selector}-${crypto.randomUUID()}.json`,
      );
      const result = await backupStoryLibsql({
        manifest,
        client: databaseClient,
        installationId: selectedScope.installationId,
        archiveIssuers: [archivedIssuer],
        filePath,
      });
      archiveFiles.set(selector, filePath);
      return result;
    }
    if (!archiveFile)
      throw new Error('Named populated backup has not been created');
    const number = ++restoreSequence;
    const name = `restore-database-${number}`,
      restoredState = fs.mkdtempSync(
        path.join(manifest.work, 'story-restore-'),
      );
    const port = await freePort(),
      url = `http://127.0.0.1:${port}`;
    const service = launched(
      binary,
      [
        '--db-path',
        restoredState,
        '--http-listen-addr',
        `127.0.0.1:${port}`,
        '--no-welcome',
        '--disable-metrics',
      ],
      {
        cwd: manifest.work,
        env: runtimeEnvironment(),
        log: path.join(output, `${name}.log`),
      },
    );
    owned.set(name, service);
    record('start', name, service);
    const restoredClient = createClient({ url, intMode: 'number' });
    restoreClients.push(restoredClient);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      checkStop();
      if (service.error || service.child.exitCode !== null)
        throw new Error('Owned restore sqld exited');
      try {
        await bounded(
          restoredClient.execute('SELECT 1'),
          1000,
          'Restore readiness',
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error('Owned restore sqld readiness timed out');
    await applyLibsqlMigrations({
      client: restoredClient,
      root: migrationRoot,
    });
    const install = await restoredClient.execute(
      'SELECT installation_id FROM pilot_installation WHERE id=1',
    );
    const installationId = String(install.rows[0].installation_id);
    let result,
      failure = null;
    let selectedArchive = archiveFile;
    if (body.fault === 'checksum-corrupt') {
      selectedArchive = path.join(
        manifest.work,
        'private-backups',
        `checksum-corrupt-${crypto.randomUUID()}.json`,
      );
      fs.writeFileSync(
        selectedArchive,
        JSON.stringify(
          corruptStoryChecksum(
            JSON.parse(fs.readFileSync(archiveFile, 'utf8')),
          ),
        ),
        { mode: 0o600, flag: 'wx' },
      );
    }
    try {
      result = await restoreStoryLibsql(
        {
          manifest,
          client: restoredClient,
          installationId,
          archiveIssuers: [archivedIssuer],
          filePath: selectedArchive,
        },
        {
          decorateClient: (live) =>
            restoreFaultClient(
              live,
              body.fault === 'checksum-corrupt' ? 'none' : body.fault,
            ),
        },
      );
    } catch (error) {
      failure = restoreFailureCode(error);
    }
    const snapshot = await captureStoryLibsql(restoredClient, installationId);
    const readback = {
      installationId,
      sessionCount: snapshot.sessionCount,
      verificationCount: snapshot.verificationCount,
      counts: Object.fromEntries(
        Object.entries(snapshot.tables).map(([table, rows]) => [
          table,
          rows.length,
        ]),
      ),
    };
    if (failure)
      return {
        status:
          failure === 'BACKUP_CHECKSUM_INVALID'
            ? 'REFUSED'
            : failure === 'RESTORE_NOT_COMMITTED'
              ? 'NOT_COMMITTED'
              : 'UNCONFIRMED',
        error: failure,
        readback,
      };
    const appPort = await freePort(),
      baseURL = `http://127.0.0.1:${appPort}`,
      appName = `restore-app-${number}`,
      restoredAuthSecret = crypto.randomBytes(40).toString('base64url');
    const restoredApp = launched(process.execPath, [manifest.nodeEntry], {
      cwd: manifest.snapshot,
      env: storyBindings({
        testing: false,
        port: appPort,
        databaseURL: url,
        candidateId: manifest.candidateId,
        origin: baseURL,
        authSecret: restoredAuthSecret,
        scope,
        trust,
      }),
      log: path.join(output, `${appName}.log`),
      secrets: [
        restoredAuthSecret,
        ...accounts.map((account) => account.password),
      ],
    });
    owned.set(appName, restoredApp);
    record('start', appName, restoredApp);
    for (let attempt = 0; attempt < 100; attempt++) {
      checkStop();
      if (restoredApp.error || restoredApp.child.exitCode !== null)
        throw new Error('Owned restored app exited');
      try {
        const response = await fetch(`${baseURL}/api/pilot/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          const identity = await response.json();
          if (identity.candidateId !== manifest.candidateId)
            throw new Error('Restored app identity mismatch');
          return {
            ...result,
            readback,
            baseURL,
            sourceInstallationId: selectedScope.installationId,
          };
        }
      } catch (error) {
        if (error.message === 'Restored app identity mismatch') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Owned restored app readiness timed out');
  }
  async function inspect(body) {
    const databaseClient = body.target === 'ordinary' ? targetClient : client;
    const selectedScope = body.target === 'ordinary' ? targetScope : scope;
    const selectedNamespace = body.target === 'ordinary' ? null : namespace;
    if (body.kind === 'installation')
      return { installationId: selectedScope.installationId };
    if (body.kind === 'counts') {
      const names = [
        'pilot_placement_proposal',
        'pilot_learning_plan',
        'pilot_learning_plan_item',
        'pilot_curriculum_assignment',
        'pilot_learning_schedule',
        'pilot_curriculum_learning_run',
        'pilot_curriculum_learning_event',
        'pilot_curriculum_learning_audit',
        'pilot_curriculum_publication',
        'pilot_curriculum_publication_state',
        'pilot_curriculum_trial_member',
        'pilot_curriculum_publication_audit',
        'pilot_curriculum_proof_receipt',
        'pilot_curriculum_owner_decision',
      ];
      const counts = {};
      for (const table of names) {
        const r = await databaseClient.execute(
          `SELECT COUNT(*) AS count FROM ${table}`,
        );
        counts[table] = Number(r.rows[0].count);
      }
      return { counts };
    }
    if (body.kind === 'publication') {
      const r = await databaseClient.execute({
        sql: 'SELECT * FROM pilot_curriculum_publication WHERE installation_id=? AND test_run_id IS ? ORDER BY generation',
        args: [selectedScope.installationId, selectedNamespace],
      });
      const members = await databaseClient.execute({
        sql: 'SELECT m.* FROM pilot_curriculum_trial_member m JOIN pilot_curriculum_publication p ON p.id=m.publication_id WHERE p.installation_id=? AND p.test_run_id IS ? ORDER BY m.child_id',
        args: [selectedScope.installationId, selectedNamespace],
      });
      return {
        publications: Array.from(r.rows),
        members: Array.from(members.rows),
      };
    }
    if (body.kind === 'plan') {
      const r = await databaseClient.execute({
        sql: 'SELECT * FROM pilot_learning_plan WHERE child_id=? AND installation_id=? AND test_run_id IS ? ORDER BY approved_at',
        args: [body.childId, selectedScope.installationId, selectedNamespace],
      });
      return { plans: Array.from(r.rows) };
    }
    const r = await databaseClient.execute({
      sql: 'SELECT * FROM pilot_curriculum_learning_run WHERE id=? AND installation_id=? AND test_run_id IS ?',
      args: [body.runId, selectedScope.installationId, selectedNamespace],
    });
    if (!r.rows.length) return { run: null, events: [], audits: [] };
    const events = await databaseClient.execute({
      sql: 'SELECT * FROM pilot_curriculum_learning_event WHERE run_id=? ORDER BY sequence',
      args: [body.runId],
    });
    const audits = await databaseClient.execute({
      sql: 'SELECT * FROM pilot_curriculum_learning_audit WHERE run_id=? ORDER BY revision',
      args: [body.runId],
    });
    return {
      run: r.rows[0],
      events: Array.from(events.rows),
      audits: Array.from(audits.rows),
    };
  }
  async function faultFinal({ operation, enabled, target }) {
    const databaseClient = target === 'ordinary' ? targetClient : client;
    const selectedNamespace = target === 'ordinary' ? null : namespace;
    const collectionFault =
      manifest.phase === 'r5' && operation !== 'publication';
    const selectedInstallation =
      target === 'ordinary' ? targetScope.installationId : scope.installationId;
    const installationLiteral =
      "'" + selectedInstallation.replaceAll("'", "''") + "'";
    const name = `qa_r3_final_${operation}`;
    await databaseClient.execute(`DROP TRIGGER IF EXISTS ${name}`);
    if (!enabled) return { operation, enabled };
    const table =
      operation === 'publication'
        ? 'pilot_curriculum_publication_audit'
        : collectionFault
          ? 'pilot_collection_learning_audit'
          : 'pilot_curriculum_learning_audit';
    const when =
      operation === 'publication'
        ? 'EXISTS(SELECT 1 FROM pilot_curriculum_publication p WHERE p.id=NEW.publication_id AND p.test_run_id IS ? )'
        : collectionFault
          ? operation === 'plan'
            ? `NEW.action='plan-approval' AND EXISTS(SELECT 1 FROM pilot_collection_plan p WHERE p.id=NEW.plan_id AND p.installation_id=${installationLiteral} AND p.test_run_id IS ?)`
            : `NEW.action='run-action' AND EXISTS(SELECT 1 FROM pilot_collection_run r WHERE r.id=NEW.run_id AND r.installation_id=${installationLiteral} AND r.test_run_id IS ?)`
          : operation === 'plan'
            ? "NEW.action='plan-approval' AND EXISTS(SELECT 1 FROM pilot_learning_plan p WHERE p.id=NEW.plan_id AND p.test_run_id IS ?)"
            : "NEW.action='run-action' AND EXISTS(SELECT 1 FROM pilot_curriculum_learning_run r WHERE r.id=NEW.run_id AND r.test_run_id IS ?)";
    const escaped =
      selectedNamespace === null
        ? 'NULL'
        : "'" + selectedNamespace.replaceAll("'", "''") + "'";
    await databaseClient.execute(
      `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN ${when.replace('?', escaped)} BEGIN SELECT RAISE(ABORT,'QA_R3_FINAL_WRITE'); END`,
    );
    return { operation, enabled };
  }
  async function cleanup() {
    if (closing) return;
    closing = true;
    const errors = [];
    if (collection) {
      try {
        await collection.cleanup();
      } catch {
        errors.push('Collection runner cleanup incomplete');
      }
    }
    if (operations) {
      try {
        await operations.cleanup();
      } catch {
        errors.push('Operations runner cleanup incomplete');
      }
    }
    if (control) {
      try {
        await bounded(
          new Promise((r) => control.close(r)),
          5000,
          'Private control close',
        );
      } catch (e) {
        control.closeAllConnections();
        errors.push(e.message);
      }
    }
    for (const databaseClient of [
      client,
      ...(targetClient ? [targetClient] : []),
    ])
      for (const operation of ['plan', 'publication', 'action'])
        try {
          await bounded(
            databaseClient.execute(
              `DROP TRIGGER IF EXISTS qa_r3_final_${operation}`,
            ),
            1500,
            'Fault cleanup',
          );
        } catch {}
    for (const name of [...owned.keys()].reverse())
      try {
        await stop(name);
      } catch (e) {
        errors.push(e.message);
      }
    client.close();
    targetClient?.close();
    for (const restoredClient of restoreClients) restoredClient.close();
    fs.rmSync(privateFile, { force: true });
    jsonFile(path.join(output, 'cleanup.json'), {
      ownedProcessesStopped: owned.size === 0,
      privateCredentialsRemoved: !fs.existsSync(privateFile),
      stateRetained: state,
      ...(positive ? { targetStateRetained: targetState } : {}),
      errors,
    });
    if (errors.length) throw new Error('Runner cleanup incomplete');
  }
  try {
    process.on('SIGTERM', requestStop);
    process.on('SIGINT', requestStop);
    await startDatabase();
    const migrations = await applyLibsqlMigrations({
      client,
      root: migrationRoot,
    });
    if (migrations.migrationCount !== (manifest.phase === 'r5' ? 7 : 6))
      throw new Error('R3 requires reviewed exact 0000–0005 migrations');
    const install = await client.execute(
      'SELECT installation_id FROM pilot_installation WHERE id=1',
    );
    const definition = JSON.parse(
      fs.readFileSync(
        path.join(manifest.snapshot, profileConfig.packagePath),
        'utf8',
      ),
    );
    const sort = (v) =>
      v && typeof v === 'object'
        ? Array.isArray(v)
          ? v.map(sort)
          : Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, sort(v[k])]),
            )
        : v;
    const contentDigest = `sha256:${crypto
      .createHash('sha256')
      .update(JSON.stringify(sort(definition)))
      .digest('hex')}`;
    accounts = await provisionAccounts(client, manifest, namespace);
    scope = {
      installationId: String(install.rows[0].installation_id),
      contentDigest,
      namespace,
      childIds: accounts.filter((a) => a.role === 'child').map((a) => a.id),
      parentIds: accounts.filter((a) => a.role === 'parent').map((a) => a.id),
    };
    validateStoryScope(scope, accounts);
    trust = {
      candidateId: manifest.candidateId,
      sourceDigest: `sha256:${manifest.digest}`,
      artifactDigest: `sha256:${manifest.artifactDigest}`,
      buildId: manifest.candidateId,
      issuers: [issuer],
      archiveIssuers: [issuer],
    };
    if (operationsFactory)
      operations = await operationsFactory({
        manifest,
        output,
        client,
        scope,
        accounts,
        token,
        archiveIssuers: [issuer],
        urls,
        binary,
        createClient,
        restart,
        record,
      });
    if (collectionFactory)
      collection = await collectionFactory({
        manifest,
        output,
        client,
        scope,
        accounts,
        token,
        trust,
        urls,
        archiveIssuers: [issuer],
        restart,
        record,
        signIn,
        profile: collectionConfig.name,
        targetContext: () => ({ client: targetClient, scope: targetScope }),
        signProof: async ({ lessonVersion, contentDigest }) => {
          if (proofInProgress)
            throw new Error('Collection proof already running');
          proofInProgress = true;
          try {
            const { verifyAndSignCollectionProof } = await import(
              pathToFileURL(
                path.join(
                  manifest.snapshot,
                  'scripts/readiness-collection-proof-issuer.mjs',
                ),
              ).href
            );
            return await verifyAndSignCollectionProof({
              manifest,
              handoff,
              output: path.join(
                manifest.work,
                `proof-collection-${crypto.randomUUID()}`,
              ),
              profile: collectionConfig.name,
              lessonVersion,
              contentDigest,
              targetInstallationId: positive
                ? targetScope.installationId
                : scope.installationId,
              issuerId: positive ? targetIssuer.issuerId : issuer.issuerId,
              privateKey: positive ? releaseKeys.privateKey : keys.privateKey,
              installationId: scope.installationId,
              namespace,
              signal: proofAbort.signal,
            });
          } finally {
            proofInProgress = false;
          }
        },
      });
    jsonFile(privateFile, { token, accounts });
    if (positive) {
      await startDatabase('targetDatabase');
      const targetMigrations = await applyLibsqlMigrations({
        client: targetClient,
        root: migrationRoot,
      });
      if (targetMigrations.migrationCount !== (manifest.phase === 'r5' ? 7 : 6))
        throw new Error('Positive target requires exact six migrations');
      const targetInstall = await targetClient.execute(
        'SELECT installation_id FROM pilot_installation WHERE id=1',
      );
      const targetInstallationId = String(
        targetInstall.rows[0].installation_id,
      );
      validatePositiveTarget(scope.installationId, targetInstallationId);
      await provisionAccounts(targetClient, manifest, namespace, accounts);
      targetScope = { ...scope, installationId: targetInstallationId };
      targetTrust = {
        ...trust,
        issuers: [targetIssuer],
        archiveIssuers: [targetIssuer],
      };
      await startApp('target');
      for (const [route, fixture] of [
        ['story-bootstrap', 'family-story'],
        ['story-positive-bootstrap', 'positive-publication'],
      ]) {
        const refusal = await fetch(`${urls.target}/api/test/pilot/${route}`, {
          method: 'POST',
          headers: { Origin: urls.target, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fixture }),
          signal: AbortSignal.timeout(10000),
        });
        if (refusal.status !== 404)
          throw new Error('Ordinary positive target must deny bootstrap');
      }
    }
    await startApp('app');
    const cookie = await signIn(accounts.find((a) => a.role === 'operator'));
    if (profileConfig.name === 'positive-publication') {
      const imported = await fetch(`${urls.app}/api/pilot/curriculum`, {
        method: 'POST',
        headers: {
          Origin: urls.app,
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ package: definition }),
        signal: AbortSignal.timeout(10000),
      });
      if (
        !imported.ok ||
        (await imported.json()).contentDigest !== contentDigest
      )
        throw new Error('Positive evidence ordinary import identity mismatch');
    }
    const bootstrap = await fetch(`${urls.app}${profileConfig.bootstrapPath}`, {
      method: 'POST',
      headers: {
        Origin: urls.app,
        Cookie: cookie,
        'X-Hanzi-Test-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fixture: profileConfig.bootstrapFixture }),
      signal: AbortSignal.timeout(10000),
    });
    if (!bootstrap.ok)
      throw new Error(
        `Ordinary-session story bootstrap failed (${bootstrap.status})`,
      );
    const publication = await bootstrap.json();
    if (collection) {
      await collection.initialize();
      clock = collection.handoff.initialClock;
    }
    const before = JSON.stringify(await inspect({ kind: 'publication' }));
    await stop('app');
    await stop('database');
    await startDatabase();
    await startApp('app');
    const after = JSON.stringify(await inspect({ kind: 'publication' }));
    if (before !== after)
      throw new Error(
        'Real R3 libSQL publication sentinel changed across restart',
      );
    const view = await fetch(
      `${urls.app}/api/pilot/children/${scope.childIds[0]}/library`,
      {
        headers: {
          Cookie: await signIn(accounts.find((a) => a.role === 'parent')),
          Origin: urls.app,
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!view.ok) throw new Error('Authenticated R3 sentinel readback failed');
    validateRestartLibrary(await view.json(), scope, publication.publicationId);
    await startApp('ordinary');
    const denied = await fetch(
      `${urls.ordinary}/api/test/pilot/story-bootstrap`,
      {
        method: 'POST',
        headers: { Origin: urls.ordinary, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixture: 'family-story' }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (denied.status !== 404)
      throw new Error('Ordinary configuration must deny bootstrap');
    control = http.createServer(async (req, res) => {
      const send = (code, value) =>
        res
          .writeHead(code, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          .end(JSON.stringify(value));
      if (req.headers['x-hanzi-test-token'] !== token)
        return send(403, { error: 'runner token required' });
      if (req.method !== 'POST') return send(404, { error: 'unknown control' });
      if (stopRequested) return send(503, { error: 'runner stopping' });
      if (changing) return send(409, { error: 'runner operation in progress' });
      try {
        const text = await bounded(
          (async () => {
            let raw = '';
            for await (const chunk of req) {
              raw += chunk;
              if (raw.length > 4096)
                throw new Error('control payload too large');
            }
            return raw;
          })(),
          5000,
          'Control body',
        );
        let body;
        try {
          body = JSON.parse(text || '{}');
          validateStoryControl(
            req.url,
            body,
            scope,
            positive ? 'positive-publication' : profileConfig.name,
          );
          if (
            ['r4', 'r5'].includes(manifest.phase) &&
            req.url === '/verify-and-sign'
          )
            throw new Error('R4 is not the signed R3 proof profile');
        } catch {
          return send(400, { error: 'invalid named control' });
        }
        if (req.url === '/verify-and-sign') {
          if (proofInProgress)
            return send(409, { error: 'proof suite already running' });
          proofInProgress = true;
          try {
            const { verifyAndSignStoryProof } = await import(
              pathToFileURL(
                path.join(
                  manifest.snapshot,
                  'scripts/readiness-proof-issuer.mjs',
                ),
              ).href
            );
            const proofOutput = path.join(
              manifest.work,
              `proof-${crypto.randomUUID()}`,
            );
            return send(
              200,
              await verifyAndSignStoryProof({
                manifest,
                handoff,
                output: proofOutput,
                profile: profileConfig.name,
                targetInstallationId: positive
                  ? targetScope.installationId
                  : scope.installationId,
                issuerId: positive ? targetIssuer.issuerId : issuer.issuerId,
                privateKey: positive ? releaseKeys.privateKey : keys.privateKey,
                installationId: scope.installationId,
                contentDigest: scope.contentDigest,
                namespace,
                signal: proofAbort.signal,
              }),
            );
          } finally {
            proofInProgress = false;
          }
        }
        changing = true;
        try {
          if (req.url === '/target-issuer') {
            targetTrust = {
              ...targetTrust,
              issuers: [liveStoryIssuer(targetIssuer, body.state)],
            };
            await bounded(
              (async () => {
                await stop('target');
                await startApp('target');
              })(),
              20000,
              'Owned target issuer restart',
            );
            return send(200, {
              state: body.state,
              targetInstallationId: targetScope.installationId,
            });
          }
          if (req.url === '/inspect')
            return send(
              200,
              await bounded(inspect(body), 10000, 'Named inspection'),
            );
          if (req.url === '/fault-final')
            return send(
              200,
              await bounded(faultFinal(body), 10000, 'Final-write fixture'),
            );
          if (req.url === '/restart') {
            await bounded(restart(body.service), 45000, 'Owned restart');
            return send(200, { restarted: true, service: body.service });
          }
          if (req.url === '/clock') {
            clock = body.at;
            await bounded(restart('app'), 20000, 'Clock-scoped restart');
            return send(200, { at: clock, namespace });
          }
          if (!backupAdapter)
            return send(
              200,
              await bounded(
                ownedBackup(body, req.url.slice(1)),
                90000,
                'Owned backup/restore',
              ),
            );
          return send(
            200,
            await backupAdapter({
              operation: req.url.slice(1),
              body,
              manifest,
              client: body.target === 'ordinary' ? targetClient : client,
              scope: body.target === 'ordinary' ? targetScope : scope,
              archiveIssuers: [
                body.target === 'ordinary' ? targetIssuer : issuer,
              ],
              ownedWork: manifest.work,
              output,
              createClient,
              startDatabase,
              record,
            }),
          );
        } finally {
          changing = false;
        }
      } catch (error) {
        // A failed or timed-out process mutation must not leave a READY runner
        // while a late readiness operation continues in the background.
        const failure = runnerOperationFailure(req.url, error);
        operationErrors.push({
          route: failure.route,
          code: failure.code,
          at: new Date().toISOString(),
        });
        try {
          jsonFile(path.join(output, 'operation-errors.json'), operationErrors);
        } catch {
          requestStop();
        }
        if (failure.stop) requestStop();
        return send(503, { error: failure.code });
      }
    });
    control.requestTimeout = 6000;
    control.headersTimeout = 6000;
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    const handoff = {
      candidateId: manifest.candidateId,
      manifest: path.resolve(manifestFile),
      specVersion: manifest.specVersion,
      integrationVersion: manifest.integrationVersion,
      lessonVersion: manifest.lessonVersion,
      baseURL: urls.app,
      ordinaryBaseURL: urls.ordinary,
      profile: collectionConfig?.name ?? profileConfig.name,
      packagePath: profileConfig.packagePath,
      ...(positive
        ? { targetBaseURL: urls.target, targetState, targetIssuer }
        : {}),
      controlURL: `http://127.0.0.1:${control.address().port}`,
      credentialsFile: privateFile,
      tokenFile: privateFile,
      namespace,
      scope,
      contentDigest: scope.contentDigest,
      evidenceInstallationId: scope.installationId,
      targetInstallationId: positive
        ? targetScope.installationId
        : scope.installationId,
      publicIssuer: issuer,
      state,
      snapshot: manifest.snapshot,
      output,
      sqldVersion,
      sourceDigest: `sha256:${manifest.digest}`,
      artifactDigest: `sha256:${manifest.artifactDigest}`,
      buildId: manifest.candidateId,
      cdpURL: 'http://127.0.0.1:9222',
      sentinelSurvivedAppAndDatabaseRestart: true,
      sentinelKind:
        'synthetic publication generation and authenticated library readback',
      bootstrapPublication: publication,
      backupAdapterAvailable: true,
      ...(operations ? { operations: operations.handoff } : {}),
      ...(collection ? { collection: collection.handoff } : {}),
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
      process.off('SIGTERM', requestStop);
      process.off('SIGINT', requestStop);
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === 'prepare')
      await prepareNodeCandidate({ phase: 'r3' });
    else if (
      process.argv[2] === 'serve' &&
      process.argv[3] &&
      (process.argv.length === 4 ||
        (process.argv.length === 6 && process.argv[4] === '--profile'))
    )
      await serveStoryNodeCandidate(process.argv[3], {
        profile: process.argv[5] ?? 'family-story',
      });
    else
      throw new Error(
        'Usage: node scripts/readiness-story-node-runner.mjs prepare | serve <manifest> [--profile positive-publication]',
      );
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
