/** Owned built R6 runner. Never imported by product code. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  verifyNodeManifest,
  prepareNodeCandidate,
  runtimeEnvironment,
  launched,
  bounded,
  freePort,
} from './readiness-node-runner.mjs';
import {
  corpusExecutionBinding,
  verifyAndSignCorpusProof,
} from './readiness-corpus-proof-issuer.mjs';

import {
  validateCorpusRuntimeControl,
  corpusMutationStage,
  createCorpusPublicationBarrier,
  corpusAppOrigin,
  corpusHandoffLocation,
  stopCorpusRuntimeChild,
  corpusRuntimeFailure,
} from './readiness-corpus-runtime-controls.mjs';

import {
  compileCorpusRuntime,
  validateCorpusRun,
  projectCorpusRun,
} from '../lib/curriculum/corpus-runtime.ts';
import { corpusCoverage } from '../lib/pilot/corpus-coverage.ts';
import { applyLibsqlMigrations } from './pilot-libsql-admin.mjs';
export { validateCorpusRuntimeControl } from './readiness-corpus-runtime-controls.mjs';
const ROOT = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (r) => Object.fromEntries(Object.entries(r));
export function verifyCorpusRunnerManifest(manifest, profile = 'draft-corpus') {
  verifyNodeManifest(manifest, { built: true });
  if (manifest.phase !== 'r6' || fs.realpathSync(manifest.snapshot) !== ROOT)
    throw new Error('CORPUS_FROZEN_EXECUTION_REQUIRED');
  return corpusExecutionBinding(manifest, profile);
}
export async function serveCorpusNodeCandidate(
  manifestPath,
  { profile = 'draft-corpus', signal } = {},
) {
  const { createClient } = await import('@libsql/client');
  const {
    withBuiltCorpusFixture,
    withBuiltNegativeCorpusFixture,
    bootstrapOwnedCorpus,
    prepareOwnedCorpus,
    publishOwnedCorpus,
    withdrawOwnedCorpus,
    setBuiltCorpusRuntimeFault,
    shareBuiltCorpusCredentials,
  } = await import('./readiness-corpus-bootstrap.mjs');
  const {
    captureCorpusLibsql,
    createCorpusBackupPayload,
    restoreCorpusBackupPayload,
    validateCorpusBackupEnvelope,
  } = await import('./pilot-corpus-libsql-backup.mjs');
  const setupStarted = Date.now();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const binding = verifyCorpusRunnerManifest(manifest, profile);
  const output = path.join(manifest.output, `corpus-runtime-${Date.now()}`);
  fs.mkdirSync(output, { mode: 0o700 });
  const work = fs.mkdtempSync(path.join(manifest.work, 'corpus-runtime-'));
  fs.chmodSync(work, 0o700);
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), manifest.runId, {
    mode: 0o600,
    flag: 'wx',
  });
  const binary =
    process.env.HANZI_SQLD_BINARY ?? path.join(process.env.HOME, '.turso/sqld');
  if (!path.isAbsolute(binary) || !fs.statSync(binary).isFile())
    throw new Error('CORPUS_SQLD_REQUIRED');
  const setupTimer = setTimeout(
    () => {
      abort.abort();
      stopResolve?.();
    },
    profile === 'stress-corpus' ? 600000 : 120000,
  );
  const owned = new Map(),
    clients = [],
    archives = new Map(),
    cleanupFailures = [];
  let handoff, control, proxy, stopResolve;
  const stopped = new Promise((r) => (stopResolve = r)),
    abort = new AbortController();
  const stop = () => {
    abort.abort();
    stopResolve();
  };
  signal?.addEventListener('abort', stop, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const processes = () =>
    Array.from(owned, ([kind, s]) => ({ kind, pid: s.child.pid }));
  const record = () =>
    fs.writeFileSync(
      path.join(output, 'processes.json'),
      JSON.stringify({ processes: processes(), work }),
      { mode: 0o600 },
    );
  async function stopProcess(kind) {
    const s = owned.get(kind);
    if (!s) return;
    await stopCorpusRuntimeChild(s.child);
    owned.delete(kind);
    record();
  }
  async function sqlService(kind, directory) {
    const port = await freePort();
    const s = launched(
      binary,
      [
        '--db-path',
        directory,
        '--http-listen-addr',
        `127.0.0.1:${port}`,
        '--no-welcome',
        '--disable-metrics',
      ],
      {
        cwd: work,
        env: runtimeEnvironment(),
        log: path.join(output, kind + '.log'),
      },
    );
    owned.set(kind, s);
    record();
    const url = `http://127.0.0.1:${port}`,
      client = createClient({ url, intMode: 'number' });
    clients.push(client);
    for (let i = 0; i < 100; i++) {
      if (abort.signal.aborted) throw new Error('CORPUS_CANCELLED');
      try {
        await bounded(client.execute('SELECT 1'), 1000, 'SQL readiness');
        return { url, client };
      } catch {
        await wait(100);
      }
    }
    throw new Error('CORPUS_SQL_READINESS');
  }
  async function app(kind, database, config, { ordinary = false } = {}) {
    const port = await freePort(),
      baseURL = `http://127.0.0.1:${port}`;
    const env = {
      ...runtimeEnvironment(),
      HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      HANZI_ALLOW_LOCAL_DATABASE: '1',
      HANZI_DATABASE_URL: database,
      HANZI_PILOT_MODE: '1',
      HANZI_PREVIEW_MODE: '0',
      HANZI_AUTH_ORIGIN: corpusAppOrigin(config, baseURL, ordinary),
      HANZI_AUTH_SECRET: config.secret,
      HANZI_CANDIDATE_ID: manifest.candidateId,
      HANZI_TEST_MODE: ordinary ? '0' : '1',
      HANZI_PILOT_TEST_CONTENT: ordinary ? '0' : '1',
      HANZI_TEST_RUN_ID: ordinary ? '' : config.testRunId,
      HANZI_TEST_TOKEN: ordinary ? '' : config.testToken,
      HANZI_CURRICULUM_TEST_NOW: ordinary
        ? ''
        : String(config.curriculumTestNow ?? ''),
      HANZI_CURRICULUM_TRUST: JSON.stringify(config.curriculumTrust),
      HANZI_STORY_CAPABILITY: '',
      HANZI_COLLECTION_CAPABILITY: '',
      HANZI_CORPUS_OWNER_IDS: JSON.stringify(config.corpus.ownerIds),
      HANZI_CORPUS_FIXTURE_BINDING: JSON.stringify(
        config.corpus.fixtureBinding,
      ),
      HANZI_CORPUS_CAPABILITY: ordinary
        ? ''
        : JSON.stringify(config.corpus.capability),
    };
    const s = launched(process.execPath, [manifest.nodeEntry], {
      cwd: manifest.snapshot,
      env,
      log: path.join(output, kind + '.log'),
      secrets: [
        config.secret,
        config.testToken,
        ...(config.credentials ?? []).map((a) => a.password),
      ],
    });
    owned.set(kind, s);
    record();
    for (let i = 0; i < 100; i++) {
      if (abort.signal.aborted) throw new Error('CORPUS_CANCELLED');
      if (s.child.exitCode !== null || s.error)
        throw new Error('CORPUS_APP_EXIT');
      try {
        const r = await fetch(baseURL + '/api/pilot/health', {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) return baseURL;
      } catch {}
      await wait(250);
    }
    throw new Error('CORPUS_APP_READINESS');
  }
  try {
    await withBuiltCorpusFixture(
      manifest,
      profile,
      async (evidence) => {
        await withBuiltNegativeCorpusFixture(
          manifest,
          profile,
          async (negative) => {
            try {
              await shareBuiltCorpusCredentials(
                evidence.handle,
                negative.handle,
              );
              const token = evidence.config.testToken;
              const key = crypto.generateKeyPairSync('ed25519');
              const publicIssuer = {
                issuerId: 'r6-built-candidate',
                publicKeyJwk: key.publicKey.export({ format: 'jwk' }),
                notBefore: Date.now() - 1000,
                revokedAt: null,
                purpose: 'candidate',
              };
              // Verification setup has no human review/proof; runtime public trust is independently bound.
              const initialClock = Date.now();
              evidence.config.curriculumTestNow = String(initialClock);
              const bootstrap = await bootstrapOwnedCorpus(evidence.handle);
              verifyCorpusRunnerManifest(manifest, profile);
              const sql = {
                  url: evidence.databaseURL,
                  client: evidence.client,
                },
                negsql = { url: negative.databaseURL, client: negative.client };
              const config = {
                ...evidence.config,
                corpus: evidence.context().corpus,
                credentials: evidence.credentials,
              };
              // Keep bootstrap's pristine trust/capability handles unchanged; service trust has the actual ephemeral issuer.
              config.curriculumTrust = {
                ...config.curriculumTrust,
                issuers: [publicIssuer],
                archiveIssuers: [publicIssuer],
              };
              let appURL;
              const proxyPort = await freePort();
              const baseURL = `http://127.0.0.1:${proxyPort}`;
              config.origin = baseURL;
              appURL = await app('evidence-app', sql.url, config);
              const negativeURL = await app(
                'negative-app',
                negsql.url,
                {
                  ...negative.config,
                  curriculumTrust: config.curriculumTrust,
                  corpus: negative.context().corpus,
                  credentials: negative.credentials,
                },
                { ordinary: true },
              );
              const publicationBarrier = createCorpusPublicationBarrier({
                signal: abort.signal,
              });
              let fault = { stage: 'action', mode: 'none' },
                clock = initialClock,
                proofAttempted = false,
                proofResult = null;
              proxy = http.createServer(async (req, res) => {
                try {
                  const url = new URL(req.url, appURL),
                    chunks = [];
                  for await (const b of req) chunks.push(b);
                  const headers = new Headers();
                  for (const [k, v] of Object.entries(req.headers))
                    if (
                      v &&
                      ![
                        'host',
                        'connection',
                        'content-length',
                        'origin',
                      ].includes(k)
                    )
                      headers.set(k, Array.isArray(v) ? v.join(',') : v);
                  if (req.headers.origin)
                    headers.set('Origin', req.headers.origin);
                  const response = await fetch(url, {
                    method: req.method,
                    headers,
                    body: ['GET', 'HEAD'].includes(req.method)
                      ? undefined
                      : Buffer.concat(chunks),
                    redirect: 'manual',
                    signal: AbortSignal.timeout(30000),
                  });
                  const bytes = Buffer.from(await response.arrayBuffer());
                  const stage = corpusMutationStage(
                    new URL(req.url, baseURL).pathname,
                  );
                  if (
                    req.method === 'POST' &&
                    response.ok &&
                    fault.mode === 'accepted-response-loss' &&
                    stage === fault.stage
                  ) {
                    fault = { ...fault, mode: 'none' };
                    res.destroy();
                    return;
                  }
                  const out = {};
                  for (const [k, v] of response.headers)
                    if (
                      ![
                        'content-encoding',
                        'transfer-encoding',
                        'content-length',
                      ].includes(k)
                    )
                      out[k] = v;
                  if (response.headers.getSetCookie)
                    out['set-cookie'] = response.headers.getSetCookie();
                  res.writeHead(response.status, out);
                  res.end(bytes);
                } catch {
                  if (!res.destroyed) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end('{"error":{"code":"RUNNER_UPSTREAM_UNAVAILABLE"}}');
                  }
                }
              });
              proxy.listen(proxyPort, '127.0.0.1');
              await once(proxy, 'listening');
              // App origin must be the visible proxy origin for normal Origin and auth checks.
              config.origin = baseURL;
              const families = evidence.families;
              const indices = [
                0,
                Math.floor((binding.items.length - 1) / 2),
                binding.items.length - 1,
              ];
              const representatives = indices
                .filter((v, i, a) => a.indexOf(v) === i)
                .map((v, i) => ({
                  ...binding.items[v],
                  familyIndex: [1, 5, 10][i],
                  helpFamilyIndex: [2, 6, 8][i],
                  audioFamilyIndex: [3, 7, 9][i],
                  browserFamilyIndex: 4,
                }));
              let cdpURL = null;
              try {
                const r = await fetch('http://127.0.0.1:9222/json/version', {
                  signal: AbortSignal.timeout(2000),
                });
                if (
                  r.ok &&
                  String((await r.json()).Browser).startsWith('Chrome/')
                )
                  cdpURL = 'http://127.0.0.1:9222';
              } catch {}
              handoff = {
                schemaVersion: 'r6-corpus-runtime-1',
                manifestPath: path.resolve(manifestPath),
                runId: manifest.runId,
                candidateId: manifest.candidateId,
                phase: 'r6',
                specVersion: manifest.specVersion,
                integrationVersion: manifest.integrationVersion,
                ...binding.identity,
                installationId: evidence.installationId,
                namespace: evidence.namespace,
                baseURL,
                ordinaryNegativeBaseURL: negativeURL,
                controlURL: null,
                token,
                cdpURL,
                initialClock,
                accounts: evidence.credentials,
                families,
                representatives,
                configuredOwnerId: 'r6-parent-01',
                grantedTeacherId: 'r6-teacher-granted',
                ungrantedTeacherId: 'r6-teacher-ungranted',
                foreignParentId: 'r6-parent-foreign',
                publicIssuer,
                bootstrap,
                output,
                work,
                processes: processes(),
                setup: {
                  durationMs: Date.now() - setupStarted,
                  packageCount: binding.items.length,
                  targetCount: binding.items.length * 2,
                },
              };
              async function inspect(body) {
                const rows = async (sql, args = []) =>
                  (
                    await bounded(
                      evidence.client.execute({ sql, args }),
                      30000,
                      'inspect',
                    )
                  ).rows.map(row);
                if (body.kind === 'counts') {
                  const selected =
                    body.target === 'ordinary-negative' ? negative : evidence;
                  const captured = await captureCorpusLibsql(
                    selected.client,
                    selected.installationId,
                  );
                  const counts = Object.fromEntries(
                    Object.entries(captured.tables).map(([k, v]) => [
                      k,
                      v.length,
                    ]),
                  );
                  const actual = await corpusCoverage(
                    {
                      ...selected.context(),
                      config: {
                        ...selected.config,
                        curriculumTrust: config.curriculumTrust,
                      },
                    },
                    binding.identity.corpusVersion,
                  );
                  return {
                    installationId: selected.installationId,
                    counts,
                    evidenceEpoch: captured.evidenceEpoch[0].revision,
                    coverage: {
                      ...actual.counts,
                      fixtureCharacterCount: actual.fixtureCharacterCount,
                      verificationPackageCount: actual.verificationPackageCount,
                      lane: actual.lane,
                    },
                  };
                }
                if (body.kind === 'head') {
                  const r = (
                    await rows(
                      'SELECT p.id,p.revision,p.status,p.snapshot_id FROM pilot_corpus_publication_state s JOIN pilot_corpus_publication p ON p.id=s.latest_publication_id WHERE s.installation_id=? AND s.corpus_version=?',
                      [evidence.installationId, binding.identity.corpusVersion],
                    )
                  )[0];
                  return {
                    installationId: evidence.installationId,
                    head: r
                      ? {
                          id: r.id,
                          revision: r.revision,
                          status: r.status,
                          snapshotId: r.snapshot_id,
                        }
                      : null,
                  };
                }
                const assignment =
                  body.kind === 'assignment'
                    ? (
                        await rows(
                          'SELECT a.id,a.plan_item_id,a.child_id,a.installation_id,a.lesson_version,a.created_at,i.plan_id FROM pilot_corpus_assignment a JOIN pilot_corpus_plan_item i ON i.id=a.plan_item_id WHERE a.id=? AND a.installation_id=?',
                          [body.assignmentId, evidence.installationId],
                        )
                      )[0]
                    : null;
                const run =
                  body.kind === 'run'
                    ? (
                        await rows(
                          'SELECT id,assignment_id,schedule_id,child_id,installation_id,lesson_version,content_digest,run_json,phase,revision,completed_at,created_at,updated_at FROM pilot_corpus_run WHERE id=? AND installation_id=?',
                          [body.runId, evidence.installationId],
                        )
                      )[0]
                    : null;
                if (!assignment && !run)
                  throw new Error('CORPUS_RESOURCE_NOT_OWNED');
                const schedules = (
                  await rows(
                    'SELECT s.id,s.assignment_id,s.kind,s.due_at,s.initial_run_id,s.initial_completed_at,r.id AS completion_run_id,r.completed_at FROM pilot_corpus_schedule s LEFT JOIN pilot_corpus_run r ON r.schedule_id=s.id WHERE s.assignment_id=?',
                    [assignment?.id ?? run.assignment_id],
                  )
                ).map((r) => ({
                  id: r.id,
                  assignmentId: r.assignment_id,
                  kind: r.kind,
                  dueAt: r.due_at,
                  initialRunId: r.initial_run_id,
                  initialCompletedAt: r.initial_completed_at,
                  completionRunId: r.completion_run_id,
                  completedAt: r.completed_at,
                }));
                if (assignment)
                  return {
                    installationId: evidence.installationId,
                    assignment: {
                      id: assignment.id,
                      planId: assignment.plan_id,
                      childId: assignment.child_id,
                      installationId: assignment.installation_id,
                      lessonVersion: assignment.lesson_version,
                      createdAt: assignment.created_at,
                    },
                    schedules,
                  };
                const events = (
                  await rows(
                    'SELECT id,event_id,sequence,expected_revision,server_at,action_json,result_json FROM pilot_corpus_event WHERE run_id=? ORDER BY sequence',
                    [run.id],
                  )
                ).map((r) => {
                  const result = JSON.parse(r.result_json),
                    action = JSON.parse(r.action_json);
                  return {
                    id: r.id,
                    eventId: r.event_id,
                    revision: r.sequence,
                    expectedRevision: r.expected_revision,
                    serverAt: r.server_at,
                    occurrenceId: action.occurrenceId,
                    type: action.type,
                    result: result.ack?.result ?? result.event?.result,
                  };
                });
                const pkg = (
                  await rows(
                    'SELECT manifest_json FROM pilot_curriculum_package WHERE lesson_version=? AND content_digest=?',
                    [run.lesson_version, run.content_digest],
                  )
                )[0];
                const compiled = await compileCorpusRuntime(
                  JSON.parse(pkg.manifest_json),
                );
                const recap = projectCorpusRun(
                  compiled,
                  validateCorpusRun(compiled, JSON.parse(run.run_json)),
                  { soundReview: 'pending' },
                ).recap;
                return {
                  installationId: evidence.installationId,
                  run: {
                    runId: run.id,
                    childId: run.child_id,
                    lessonVersion: run.lesson_version,
                    contentDigest: run.content_digest,
                    installationId: run.installation_id,
                    revision: run.revision,
                    completedAt: run.completed_at,
                    phase: run.phase,
                    recap,
                  },
                  events,
                  receipts: events.map((r) => ({
                    eventId: r.eventId,
                    revision: r.revision,
                    result: r.result,
                  })),
                  audits: (
                    await rows(
                      'SELECT id,action,event_id,revision,created_at FROM pilot_corpus_learning_audit WHERE run_id=? ORDER BY revision',
                      [run.id],
                    )
                  ).map((r) => ({
                    id: r.id,
                    action: r.action,
                    eventId: r.event_id,
                    revision: r.revision,
                    createdAt: r.created_at,
                  })),
                  schedules,
                };
              }
              async function setFault(body) {
                await setBuiltCorpusRuntimeFault(evidence.handle, body);
                fault = body;
                return body;
              }
              async function restore(body) {
                const original = archives.get(body.archiveId);
                if (!original) throw new Error('CORPUS_ARCHIVE_NOT_OWNED');
                const archive = structuredClone(original);
                if (body.variant === 'invalid-digest')
                  archive.sha256 = '0'.repeat(64);
                if (body.variant === 'unknown-format') {
                  archive.payload.format = 'pilot-admin-backup-7';
                  archive.sha256 = crypto
                    .createHash('sha256')
                    .update(JSON.stringify(archive.payload))
                    .digest('hex');
                }
                try {
                  await validateCorpusBackupEnvelope({
                    archive,
                    sourceRoot: manifest.snapshot,
                    archiveIssuers: [publicIssuer],
                  });
                } catch (error) {
                  return {
                    variant: body.variant,
                    status: 'REFUSED',
                    commit: 'not-attempted',
                    installationId: null,
                    baseURL: null,
                    counts: null,
                    error: { code: error.code ?? error.message },
                  };
                }
                const directory = fs.mkdtempSync(path.join(work, 'restored-'));
                fs.writeFileSync(
                  path.join(directory, '.hanzi-qa-owned'),
                  manifest.runId,
                  { mode: 0o600 },
                );
                const restored = await sqlService(
                    'restore-sqld-' + archives.size + '-' + Date.now(),
                    directory,
                  ),
                  installationId = 'r6-restored-' + crypto.randomUUID();
                await applyLibsqlMigrations({
                  client: restored.client,
                  root: manifest.snapshot,
                });
                await restored.client.execute({
                  sql: 'UPDATE pilot_installation SET installation_id=? WHERE id=1',
                  args: [installationId],
                });
                try {
                  const decorateClient =
                    body.variant === 'final-constraint'
                      ? (c) => ({
                          execute: c.execute.bind(c),
                          batch: async (statements) =>
                            c.batch(
                              [
                                ...statements,
                                {
                                  sql: 'INSERT INTO pilot_installation SELECT * FROM pilot_installation',
                                  args: [],
                                },
                              ],
                              'write',
                            ),
                        })
                      : body.variant === 'lost-ack'
                        ? (c) => ({
                            execute: c.execute.bind(c),
                            batch: async (statements) => {
                              await c.batch(statements, 'write');
                              throw new Error('R6_RESTORE_LOST_ACK');
                            },
                          })
                        : undefined;
                  const outcome = await restoreCorpusBackupPayload(
                    {
                      sourceRoot: manifest.snapshot,
                      client: restored.client,
                      installationId,
                      archiveIssuers: [publicIssuer],
                      archive,
                    },
                    { decorateClient },
                  );
                  const cfg = {
                    ...negative.config,
                    secret: crypto.randomBytes(40).toString('base64url'),
                    curriculumTrust: negative.config.curriculumTrust,
                    corpus: {
                      ownerIds: [],
                      capability: null,
                      fixtureBinding: {
                        schemaVersion: 'r6-fixture-binding-1',
                        installationId,
                        mode: 'synthetic-only',
                      },
                    },
                  };
                  const restoredBaseURL = await app(
                    'restored-app-' + Date.now(),
                    restored.url,
                    cfg,
                    { ordinary: true },
                  );
                  return {
                    variant: body.variant,
                    status: 'CONFIRMED',
                    commit: outcome.commit,
                    installationId,
                    baseURL: restoredBaseURL,
                    counts: Object.fromEntries(
                      Object.entries(
                        (
                          await captureCorpusLibsql(
                            restored.client,
                            installationId,
                          )
                        ).tables,
                      ).map(([k, v]) => [k, v.length]),
                    ),
                  };
                } catch (error) {
                  fs.writeFileSync(
                    path.join(output, 'restore-' + Date.now() + '.json'),
                    JSON.stringify({
                      variant: body.variant,
                      code: error.code ?? error.message,
                      destinationInstallationId: installationId,
                    }),
                    { mode: 0o600 },
                  );
                  return {
                    variant: body.variant,
                    status:
                      error.code === 'RESTORE_UNCONFIRMED'
                        ? 'UNCONFIRMED'
                        : error.code === 'RESTORE_NOT_COMMITTED'
                          ? 'NOT_COMMITTED'
                          : 'REFUSED',
                    commit:
                      error.code === 'RESTORE_UNCONFIRMED'
                        ? 'unknown'
                        : error.code === 'RESTORE_NOT_COMMITTED'
                          ? 'not-committed'
                          : 'not-attempted',
                    installationId: null,
                    baseURL: null,
                    counts: null,
                    error: { code: error.code ?? error.message },
                  };
                }
              }
              control = http.createServer(async (req, res) => {
                const send = (status, v) =>
                  res
                    .writeHead(status, {
                      'Content-Type': 'application/json',
                      'Cache-Control': 'no-store',
                    })
                    .end(JSON.stringify(v));
                if (req.method !== 'POST')
                  return send(404, { error: { code: 'CONTROL_NOT_FOUND' } });
                if (req.headers['x-hanzi-test-token'] !== token)
                  return send(403, {
                    error: { code: 'CONTROL_TOKEN_REQUIRED' },
                  });
                try {
                  const raw = await bounded(
                    (async () => {
                      let raw = '';
                      for await (const chunk of req) {
                        raw += chunk;
                        if (Buffer.byteLength(raw) > 4096)
                          throw new Error('CONTROL_OVERSIZE');
                      }
                      return raw;
                    })(),
                    5000,
                    'control body',
                  );
                  const body = JSON.parse(raw);
                  validateCorpusRuntimeControl(req.url, body);
                  let result;
                  if (req.url === '/inspect') result = await inspect(body);
                  else if (req.url === '/fault') result = await setFault(body);
                  else if (req.url === '/clock' || req.url === '/restart') {
                    if (req.url === '/clock') {
                      if (body.at < clock) throw new Error('CLOCK_RETROGRADE');
                      clock = body.at;
                      config.curriculumTestNow = String(clock);
                      evidence.config.curriculumTestNow = String(clock);
                    }
                    await stopProcess('evidence-app');
                    appURL = await app('evidence-app', sql.url, config);
                    result =
                      req.url === '/clock'
                        ? { at: clock, installationId: evidence.installationId }
                        : { baseURL, installationId: evidence.installationId };
                  } else if (req.url === '/hold') {
                    result =
                      body.operation === 'arm'
                        ? publicationBarrier.arm()
                        : body.operation === 'release'
                          ? publicationBarrier.release()
                          : publicationBarrier.status();
                  } else if (req.url === '/verification') {
                    const previous = (
                      await evidence.client.execute({
                        sql: 'SELECT status,request_json FROM pilot_corpus_publication WHERE actor_id=? AND installation_id=? AND corpus_version=? AND request_id=?',
                        args: [
                          'r6-operator',
                          evidence.installationId,
                          binding.identity.corpusVersion,
                          body.requestId,
                        ],
                      })
                    ).rows[0];
                    if (previous) {
                      if (
                        previous.status !==
                        (body.operation === 'withdraw'
                          ? 'withdrawn'
                          : 'released')
                      )
                        throw new Error('CORPUS_CONTROL_CONFLICT');
                      const original = JSON.parse(
                        previous.request_json,
                      ).request;
                      const input = {
                        requestId: original.requestId,
                        expectedRevision: original.expectedRevision,
                        predecessorPublicationId:
                          original.predecessorPublicationId,
                      };
                      result =
                        body.operation === 'withdraw'
                          ? await withdrawOwnedCorpus(evidence.handle, input)
                          : await publishOwnedCorpus(evidence.handle, {
                              ...input,
                              snapshotId: original.snapshotId,
                            });
                    } else {
                      const head = (await inspect({ kind: 'head' })).head;
                      if (body.operation === 'withdraw')
                        result = await withdrawOwnedCorpus(evidence.handle, {
                          requestId: body.requestId,
                          expectedRevision: head.revision,
                          predecessorPublicationId: head.id,
                        });
                      else {
                        const prep = await prepareOwnedCorpus(evidence.handle);
                        const captured = await publicationBarrier.wait({
                          requestId: body.requestId,
                          snapshotId: prep.snapshotId,
                          expectedRevision: head.revision,
                          predecessorPublicationId: head.id,
                        });
                        result = await publishOwnedCorpus(
                          evidence.handle,
                          captured,
                        );
                      }
                    }
                  } else if (req.url === '/backup') {
                    if (fault.mode !== 'none')
                      throw new Error('FAULT_MUST_BE_DISARMED');
                    const archive = await createCorpusBackupPayload({
                      sourceRoot: manifest.snapshot,
                      candidateId: manifest.candidateId,
                      client: evidence.client,
                      installationId: evidence.installationId,
                      archiveIssuers: [publicIssuer],
                      createdAtMs: clock,
                    });
                    const archiveId = 'archive-' + crypto.randomUUID();
                    archives.set(archiveId, archive);
                    result = {
                      archiveId,
                      formatVersion: 6,
                      tableCount: 67,
                      capturedAt: Date.parse(archive.payload.createdAt),
                    };
                  } else if (req.url === '/restore')
                    result = await restore(body);
                  else if (req.url === '/ops-recovery') {
                    const { runCorpusOpsRecovery } =
                      await import('./readiness-corpus-ops-recovery.mjs');
                    result = await runCorpusOpsRecovery({
                      manifest,
                      client: evidence.client,
                      installationId: evidence.installationId,
                      archiveIssuers: [publicIssuer],
                      at: clock,
                      signal: abort.signal,
                    });
                  } else if (req.url === '/verify-and-sign') {
                    verifyCorpusRunnerManifest(manifest, profile);
                    if (proofResult) {
                      send(200, proofResult);
                      return;
                    }
                    if (proofAttempted)
                      throw new Error('PROOF_ALREADY_ATTEMPTED');
                    proofAttempted = true;
                    const proofOutput = path.join(
                      manifest.work,
                      'corpus-proof-' + crypto.randomUUID(),
                    );
                    const out = await verifyAndSignCorpusProof({
                      manifest,
                      handoff,
                      output: proofOutput,
                      issuerId: publicIssuer.issuerId,
                      privateKey: key.privateKey,
                      signal: abort.signal,
                    });
                    const destination = path.join(
                      output,
                      path.basename(proofOutput),
                    );
                    fs.cpSync(proofOutput, destination, {
                      recursive: true,
                      errorOnExist: true,
                    });
                    const receiptSource = path.join(
                      proofOutput,
                      out.receiptsFile,
                    );
                    if (fs.statSync(receiptSource).size > 32 * 1024 * 1024)
                      throw new Error('PROOF_RECEIPTS_TOO_LARGE');
                    fs.copyFileSync(
                      receiptSource,
                      path.join(output, 'issued-receipts.json'),
                      fs.constants.COPYFILE_EXCL,
                    );
                    fs.chmodSync(
                      path.join(output, 'issued-receipts.json'),
                      0o600,
                    );
                    result = {
                      ...out,
                      receiptsFile: 'issued-receipts.json',
                      reportFile:
                        path.basename(proofOutput) + '/' + out.reportFile,
                    };
                    proofResult = result;
                  }
                  if (
                    req.url === '/verification' &&
                    fault.stage === 'publication' &&
                    fault.mode === 'accepted-response-loss'
                  ) {
                    fault = { ...fault, mode: 'none' };
                    res.destroy();
                    return;
                  }
                  send(
                    req.url === '/restore' && result.status !== 'CONFIRMED'
                      ? 409
                      : 200,
                    result,
                  );
                } catch (error) {
                  if (error.details)
                    fs.writeFileSync(
                      path.join(
                        output,
                        'control-error-' + Date.now() + '.json',
                      ),
                      JSON.stringify(error.details),
                      { mode: 0o600 },
                    );
                  const refusal = corpusRuntimeFailure(error);
                  send(refusal.status, { error: { code: refusal.code } });
                }
              });
              control.requestTimeout = 6000;
              control.listen(0, '127.0.0.1');
              await once(control, 'listening');
              handoff.controlURL = `http://127.0.0.1:${control.address().port}`;
              const handoffFile = corpusHandoffLocation(work, output);
              fs.writeFileSync(handoffFile, JSON.stringify(handoff), {
                mode: 0o600,
                flag: 'wx',
              });
              clearTimeout(setupTimer);
              console.log('READY ' + handoffFile);
              await stopped;
            } finally {
              abort.abort();
              for (const server of [control, proxy])
                if (server) {
                  server.closeAllConnections();
                  await bounded(
                    new Promise((r) => server.close(r)),
                    5000,
                    'owned controls close',
                  ).catch(() => {});
                }
              control = null;
              proxy = null;
              for (const kind of Array.from(owned.keys()).reverse())
                await stopProcess(kind).catch(() =>
                  cleanupFailures.push({
                    kind,
                    code: 'PROCESS_EXIT_UNCONFIRMED',
                  }),
                );
              for (const c of clients) c.close();
            }
          },
          {
            signal: abort.signal,
            onDatabaseProcess(service) {
              owned.set('negative-sqld', service);
              record();
            },
          },
        );
      },
      {
        signal: abort.signal,
        onDatabaseProcess(service) {
          owned.set('evidence-sqld', service);
          record();
        },
      },
    );
  } finally {
    clearTimeout(setupTimer);
    abort.abort();
    fs.rmSync(corpusHandoffLocation(work, output), { force: true });
    for (const s of [control, proxy])
      if (s) {
        s.closeAllConnections();
        await bounded(
          new Promise((r) => s.close(r)),
          5000,
          'control shutdown',
        ).catch(() => {});
      }
    for (const kind of Array.from(owned.keys()).reverse())
      await stopProcess(kind).catch(() =>
        cleanupFailures.push({ kind, code: 'PROCESS_EXIT_UNCONFIRMED' }),
      );
    for (const c of clients) c.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
    fs.writeFileSync(
      path.join(output, 'cleanup.json'),
      JSON.stringify({
        ownedProcessesStopped: owned.size === 0,
        ownedControlsClosed: true,
        cleanupFailures,
        remainingProcesses: processes(),
      }),
      { mode: 0o600 },
    );
  }
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === 'prepare')
    await prepareNodeCandidate({ phase: 'r6' });
  else if (
    process.argv[2] === 'serve' &&
    process.argv[3] &&
    (process.argv.length === 4 ||
      (process.argv.length === 6 && process.argv[4] === '--profile'))
  )
    await serveCorpusNodeCandidate(process.argv[3], {
      profile: process.argv[5] ?? 'draft-corpus',
    });
  else
    throw new Error(
      'Usage: readiness-corpus-node-runner.mjs prepare | serve <manifest> [--profile draft-corpus|stress-corpus]',
    );
}
