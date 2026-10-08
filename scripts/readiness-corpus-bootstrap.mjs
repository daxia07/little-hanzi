/** Closed Node direct-store fixture control. Never imported by product routes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { verifyNodeManifest, bounded } from './readiness-node-runner.mjs';
import { corpusExecutionBinding } from './readiness-corpus-proof-issuer.mjs';
import {
  corpusRuntimeActors,
  corpusRuntimeUsername,
  corpusControlSessionExpiry,
  installCorpusRuntimeFault,
} from './readiness-corpus-runtime-controls.mjs';
import { applyLibsqlMigrations } from './pilot-libsql-admin.mjs';
import { corpusProfile } from './readiness-corpus-profiles.mjs';
import {
  startOwnedCorpusDatabase,
  stopOwnedCorpusDatabase,
  ownsCorpusDatabase,
} from './readiness-corpus-database.mjs';
import { createLibsqlD1Database } from '../lib/platform/libsql-d1.ts';
import { importCurriculumPackage } from '../lib/pilot/curriculum.ts';
import {
  canonicalPackage as canonical,
  curriculumDigest as H,
} from '../lib/curriculum/digest.ts';
import {
  recordCorpusSource,
  registerCorpusBatch,
  registerCorpus,
} from '../lib/pilot/corpus-store.ts';
import {
  corpusRequest,
  assertExactCorpusReplay,
  corpusId,
  validateCorpusCapability,
} from '../lib/pilot/corpus-policy.ts';
import {
  corpusActorGuard,
  corpusInstallationGuard,
  corpusNow,
  corpusISO,
  sqlValue as q,
} from '../lib/pilot/corpus-db.ts';
import { evaluateSnapshotCandidate } from '../lib/pilot/corpus-snapshot-facts.ts';
import {
  buildSnapshotPlan,
  snapshotDigests,
  snapshotMemberFacts,
  validateSnapshotRows,
  inspectSnapshotPlan,
} from '../lib/pilot/corpus-snapshot-policy.ts';

const owned = new WeakMap();
const root = fileURLToPath(new URL('../', import.meta.url));
const SQL_HASH =
  '8360c2dff5612a66a926b08866d227f40d8751ad4121e751e071ce689e27aec8';
const PROFILE_HASHES = Object.freeze({
  'draft-corpus':
    '080f93f0f82fd5e5af4c7724f46b788672a9e9847a2673d7b0656bba5c7091e9',
  'stress-corpus':
    '9d8f38f3cd914ad35d70c8475680205963ca0187ce199428acb57a0d01655002',
});
const accounts = Object.freeze([
  ['r6-op', 'operator'],
  ['r6-other', 'operator'],
  ['r6-teacher', 'teacher'],
  ['r6-parent', 'parent'],
  ['r6-child', 'child'],
  ['r6-parent-2', 'parent'],
  ['r6-child-2', 'child'],
]);
const pairs = Object.freeze([
  { parentId: 'r6-parent', childId: 'r6-child' },
  { parentId: 'r6-parent-2', childId: 'r6-child-2' },
]);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const stop = (code) => {
  throw new Error(code);
};
function fixedFile(relative) {
  const file = path.join(root, relative);
  if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile())
    stop('CORPUS_PROFILE_INVALID');
  return fs.readFileSync(file);
}
function profileFiles(name) {
  const profile = corpusProfile(name);
  const files = [profile.manifestPath, profile.oraclePath];
  for (const folder of [profile.packageDirectory, profile.batchDirectory]) {
    const directory = path.join(root, folder);
    if (fs.realpathSync(directory) !== directory)
      stop('CORPUS_PROFILE_INVALID');
    files.push(
      ...fs
        .readdirSync(directory)
        .filter((f) => f.endsWith('.json'))
        .map((f) => folder + '/' + f),
    );
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const file of files)
    hash.update(file).update('\0').update(fixedFile(file)).update('\0');
  const digest = hash.digest('hex');
  if (digest !== PROFILE_HASHES[name]) stop('CORPUS_PROFILE_CHANGED');
  return { profile, files, digest };
}
async function schemaDigest(s) {
  const rows = (
    await s.client.execute(
      "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows;
  return H(rows.map((r) => ({ name: r.name, type: r.type, sql: r.sql })));
}
async function dataDigest(s, omitSnapshots = true) {
  const tables = (
    await s.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows;
  const contents = {};
  for (const { name } of tables) {
    if (
      omitSnapshots &&
      ['pilot_corpus_snapshot', 'pilot_corpus_snapshot_member'].includes(name)
    )
      continue;
    if (!/^[a-zA-Z0-9_]+$/u.test(name)) stop('CORPUS_SCHEMA_CHANGED');
    contents[name] = (await s.client.execute(`SELECT * FROM ${name}`)).rows
      .map((r) => canonical(Object.fromEntries(Object.entries(r))))
      .sort();
  }
  return H(contents);
}
function state(handle) {
  const s = owned.get(handle);
  if (!s || s.closed) stop('CORPUS_HANDLE_REQUIRED');
  return s;
}
function fileIdentity(file) {
  const stat = fs.lstatSync(file);
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
  };
}
function sameFile(file, identity) {
  try {
    return canonical(fileIdentity(file)) === canonical(identity);
  } catch {
    return false;
  }
}
function ownsFiles(s) {
  return (
    sameFile(s.directory, s.directoryIdentity) &&
    sameFile(s.file, s.fileIdentities[path.relative(s.directory, s.file)]) &&
    (!s.daemon ||
      ['dbs', 'dbs/default'].every((name) =>
        sameFile(path.join(s.directory, name), s.fileIdentities[name]),
      )) &&
    sameFile(
      path.join(s.directory, '.hanzi-qa-owned'),
      s.fileIdentities['.hanzi-qa-owned'],
    )
  );
}
function ownership(s) {
  if (
    !ownsFiles(s) ||
    (s.daemon && !ownsCorpusDatabase(s.daemon)) ||
    fs.realpathSync(s.directory) !== s.directory ||
    fs.realpathSync(s.file) !== s.file ||
    fs.readFileSync(path.join(s.directory, '.hanzi-qa-owned'), 'utf8') !==
      s.marker ||
    !path.basename(s.directory).startsWith('hanzi-r6-owned-')
  )
    stop('CORPUS_OWNERSHIP_CHANGED');
  profileFiles(s.profile.name);
}

/** Creates its own file/client/accounts. No caller database or directory option exists. */
export async function withOwnedCorpusFixture(name, fn, options = {}) {
  return withCorpusFactory(name, fn, options, null);
}
/** Built identity comes only from an actually verified manifest and executing frozen source. */
export async function withBuiltCorpusFixture(
  manifest,
  name,
  fn,
  { signal, onDatabaseProcess } = {},
) {
  verifyNodeManifest(manifest, { built: true });
  if (
    manifest.phase !== 'r6' ||
    fs.realpathSync(manifest.snapshot) !== fs.realpathSync(root)
  )
    stop('CORPUS_BUILT_SOURCE_REQUIRED');
  const binding = corpusExecutionBinding(manifest, name);
  return withCorpusFactory(
    name,
    fn,
    {},
    { ...binding, signal, onDatabaseProcess, work: manifest.work },
  );
}
export async function withBuiltNegativeCorpusFixture(
  manifest,
  name,
  fn,
  { signal, onDatabaseProcess } = {},
) {
  verifyNodeManifest(manifest, { built: true });
  if (
    manifest.phase !== 'r6' ||
    fs.realpathSync(manifest.snapshot) !== fs.realpathSync(root)
  )
    stop('CORPUS_BUILT_SOURCE_REQUIRED');
  return withCorpusFactory(
    name,
    fn,
    {},
    {
      ...corpusExecutionBinding(manifest, name),
      negative: true,
      signal,
      onDatabaseProcess,
      work: manifest.work,
    },
  );
}
async function withCorpusFactory(name, fn, options = {}, built = null) {
  if (built?.signal?.aborted) stop('CORPUS_CANCELLED');
  const actorSpec = built ? corpusRuntimeActors() : null;
  const selectedAccounts = actorSpec ? actorSpec.roles : accounts;
  const selectedPairs = actorSpec
    ? actorSpec.families.map(({ parentId, childId }) => ({ parentId, childId }))
    : pairs;
  const operatorId = built ? 'r6-operator' : 'r6-op';
  const credentials = built
    ? selectedAccounts.map(([id, role]) => ({
        id,
        username: corpusRuntimeUsername(id),
        password: crypto.randomBytes(24).toString('base64url'),
        role,
      }))
    : [];
  if (
    typeof fn !== 'function' ||
    !options ||
    Object.keys(options).some((k) => k !== 'instrumentClient')
  )
    stop('CORPUS_FACTORY_INVALID');
  const fixture = profileFiles(name);
  const daemon = built
    ? await startOwnedCorpusDatabase({
        parent: built.work,
        signal: built.signal,
        onOwnedProcess: built.onDatabaseProcess,
      })
    : null;
  const directory =
    daemon?.directory ??
    fs.realpathSync(
      fs.mkdtempSync(path.join(built?.work ?? os.tmpdir(), 'hanzi-r6-owned-')),
    );
  const marker =
    daemon?.marker ?? 'r6-owned-direct-store:' + crypto.randomUUID();
  const file = daemon?.file ?? path.join(directory, 'fresh.db');
  if (!daemon)
    fs.writeFileSync(path.join(directory, '.hanzi-qa-owned'), marker, {
      flag: 'wx',
    });
  const client = daemon?.client ?? createClient({ url: 'file:' + file });
  if (built)
    for (const method of ['execute', 'executeMultiple', 'batch']) {
      const original = client[method].bind(client);
      client[method] = async (...args) => {
        if (built.signal?.aborted) stop('CORPUS_CANCELLED');
        let onAbort;
        const cancellation = new Promise((_, reject) => {
          onAbort = () => reject(new Error('CORPUS_CANCELLED'));
          built.signal?.addEventListener('abort', onAbort, { once: true });
        });
        try {
          return await bounded(
            Promise.race([original(...args), cancellation]),
            30000,
            'Built corpus database operation',
          );
        } finally {
          built.signal?.removeEventListener('abort', onAbort);
        }
      };
    }

  const handle = Object.freeze({});
  const s = {
    ...fixture,
    directory,
    marker,
    file,
    client,
    handle,
    closed: false,
    snapshots: new Map(),
    published: false,
    daemon,
    builtNegative: !!built?.negative,
    credentials,
  };
  try {
    await applyLibsqlMigrations({ client, root });
    const proposed =
      'outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql';
    const installed = 'db/pilot-migrations/0007-corpus-learning.sql';
    const sql = fixedFile(
      fs.existsSync(path.join(root, installed)) ? installed : proposed,
    ).toString();
    if (sha(sql) !== SQL_HASH) stop('R6_SQL_NOT_EXACT_REVIEWED_SOURCE');
    if (
      !(
        await client.execute(
          "SELECT 1 FROM sqlite_master WHERE name='pilot_corpus'",
        )
      ).rows.length
    )
      await client.executeMultiple(sql);
    const clock = Date.now();
    for (const [id, role] of selectedAccounts) {
      await client.execute({
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,?,?,?, ?,?,0,0)',
        args: [
          id,
          id,
          id + '@synthetic.invalid',
          clock,
          clock,
          built ? corpusRuntimeUsername(id) : id,
          built ? corpusRuntimeUsername(id) : id,
          role,
        ],
      });
      await client.execute({
        sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
        args: [
          'session-' + id,
          corpusControlSessionExpiry(clock, !!built),
          'SYNTHETIC-OWNED-' + id,
          clock,
          clock,
          id,
        ],
      });
    }
    const installationId = 'r6-owned-' + crypto.randomUUID();
    await client.execute({
      sql: 'UPDATE pilot_installation SET installation_id=? WHERE id=1',
      args: [installationId],
    });
    for (const p of selectedPairs)
      await client.execute({
        sql: 'INSERT INTO pilot_parent_child VALUES(?,?,?,?)',
        args: [p.parentId, p.childId, clock, operatorId],
      });
    const db = createLibsqlD1Database(client);
    const manifest = JSON.parse(fixedFile(fixture.profile.manifestPath));
    const corpusDigest = await H(manifest);
    const namespace = 'r6-owned-test-' + crypto.randomUUID();
    const candidateId = built
      ? built.identity.candidateId
      : 'r6-direct-store-synthetic-' + name;
    const trust = built
      ? {
          candidateId,
          sourceDigest: built.identity.sourceDigest,
          artifactDigest: built.identity.artifactDigest,
          buildId: built.identity.buildId,
          issuers: [],
          archiveIssuers: [],
        }
      : {
          candidateId,
          sourceDigest: await H({
            synthetic: 'direct-store-source',
            fixtureDigest: fixture.digest,
          }),
          artifactDigest: await H({
            synthetic: 'no-built-artifact',
            fixtureDigest: fixture.digest,
          }),
          buildId: candidateId,
          issuers: [],
          archiveIssuers: [],
        };
    const config = {
      pilotMode: true,
      testMode: !built?.negative,
      testContentAllowed: !built?.negative,
      testRunId: built?.negative ? null : namespace,
      testToken: crypto.randomBytes(24).toString('hex'),
      origin: 'http://synthetic.invalid',
      secret: crypto.randomBytes(32).toString('hex'),
      candidateId,
      candidateExplicitlyBound: true,
      curriculumTestNow: null,
      curriculumTrust: trust,
      database: db,
    };
    const corpus = {
      ownerIds: [built ? 'r6-parent-01' : 'r6-parent'],
      fixtureBinding: {
        schemaVersion: 'r6-fixture-binding-1',
        installationId,
        mode: 'synthetic-only',
      },
      capability: built?.negative
        ? null
        : {
            installationId,
            corpusVersion: manifest.corpusVersion,
            corpusDigest,
            namespace,
            parentIds: selectedPairs.map((p) => p.parentId),
            childIds: selectedPairs.map((p) => p.childId),
          },
    };
    const context = (id = operatorId) => {
      const entry = selectedAccounts.find((a) => a[0] === id);
      if (!entry) stop('CORPUS_PERSONA_INVALID');
      return {
        db,
        config,
        user: { id, role: entry[1] },
        session: { id: 'session-' + id },
        corpus,
      };
    };
    Object.assign(s, {
      db,
      config,
      corpus,
      manifest,
      corpusDigest,
      installationId,
      namespace,
      context,
      clock,
      operatorId,
      builtRuntime: !!built,
      pairs: selectedPairs,
      trustBytes: canonical(trust),
      capabilityBytes: canonical(corpus.capability),
      testToken: config.testToken,
    });
    if (built) {
      const requireFrom = createRequire(path.join(root, 'package.json'));
      const { hashPassword } = await import(
        pathToFileURL(requireFrom.resolve('better-auth/crypto')).href
      );
      for (const a of credentials)
        await client.execute({
          sql: "INSERT INTO pilot_auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)",
          args: [
            crypto.randomUUID(),
            a.id,
            a.id,
            await hashPassword(a.password),
            clock,
            clock,
          ],
        });
      await client.execute({
        sql: 'INSERT INTO pilot_teacher_grant(child_id,teacher_id,granting_parent_id,created_at)VALUES(?,?,?,?)',
        args: ['r6-child-01', 'r6-teacher-granted', 'r6-parent-01', clock],
      });
    }
    for (const item of manifest.items) {
      if (built?.signal?.aborted) stop('CORPUS_CANCELLED');
      const document = JSON.parse(
        fixedFile(
          fixture.profile.packageDirectory + '/' + item.lessonVersion + '.json',
        ),
      );
      await importCurriculumPackage(context(), { package: document });
      await recordCorpusSource(context(), manifest.corpusVersion, {
        requestId: 'owned-source-' + item.lessonVersion,
        lessonVersion: item.lessonVersion,
        contentDigest: item.contentDigest,
        classification: 'unverified-draft',
        sourceRefs: ['SYNTHETIC-FIXED-PROFILE'],
        licenseRefs: ['SYNTHETIC-TEST-ONLY'],
        reviewRefs: [],
        identityReviews: [],
        predecessorEvidenceId: null,
        expectedEvidenceDigest: null,
      });
    }
    for (const f of fixture.files.filter((f) =>
      f.startsWith(fixture.profile.batchDirectory + '/'),
    )) {
      if (built?.signal?.aborted) stop('CORPUS_CANCELLED');
      const batch = JSON.parse(fixedFile(f));
      await registerCorpusBatch(context(), manifest.corpusVersion, {
        requestId: 'owned-batch-' + batch.batchVersion,
        batch,
      });
    }
    await registerCorpus(context(), { corpus: manifest });
    s.schemaDigest = await schemaDigest(s);
    s.pristineDigest = await dataDigest(s);
    s.directoryIdentity = fileIdentity(directory);
    s.fileIdentities = Object.fromEntries(
      fs
        .readdirSync(directory, { recursive: !!daemon })
        .map((name) => [name, fileIdentity(path.join(directory, name))]),
    );
    const importedImmutable = new Set([
      'pilot_curriculum_package',
      'pilot_curriculum_import_request',
      'pilot_corpus_source_evidence',
      'pilot_corpus_batch',
      'pilot_corpus',
      'pilot_corpus_item',
      'pilot_corpus_character',
      'pilot_corpus_search_term',
    ]);
    s.freshTables = [];
    for (const { name: table } of await rows(
      s,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )) {
      if (
        [
          'pilot_corpus_snapshot',
          'pilot_corpus_snapshot_member',
          'pilot_corpus_evidence_epoch',
        ].includes(table)
      )
        continue;
      const original = await rows(s, `SELECT * FROM ${table}`);
      // Imported rows are immutable under the exact schema and epoch guarded separately.
      // Mutable account/session/link/bookkeeping rows are matched in full, not count alone.
      s.freshTables.push({
        table,
        count: original.length,
        exact: importedImmutable.has(table)
          ? null
          : original.map((r) => Object.fromEntries(Object.entries(r))),
      });
    }
    s.schemaRows = (
      await rows(
        s,
        "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).map((r) => ({ name: r.name, type: r.type, sql: r.sql }));
    owned.set(handle, s);
    if (options.instrumentClient) await options.instrumentClient(client);
    await fn({
      handle,
      client,
      db,
      config,
      context,
      manifest,
      clock,
      directory,
      installationId,
      namespace,
      fixtureDigest: fixture.digest,
      syntheticBuild: !built,
      builtBinding: built,
      credentials,
      families: actorSpec?.families ?? null,
      file,
      databaseURL: daemon?.url ?? null,
      databaseProcess: daemon?.service ?? null,
    });
  } finally {
    s.closed = true;
    owned.delete(handle);
    if (daemon) await stopOwnedCorpusDatabase(daemon);
    client.close();
    // Delete only exact files this factory created. Unknown/replaced contents survive.
    if (
      s.fileIdentities &&
      ownsFiles(s) &&
      fs.readFileSync(path.join(directory, '.hanzi-qa-owned'), 'utf8') ===
        marker
    ) {
      for (const [name, identity] of Object.entries(s.fileIdentities)) {
        const target = path.join(directory, name);
        if (
          name !== '.hanzi-qa-owned' &&
          identity.type === 'file' &&
          sameFile(target, identity)
        )
          fs.unlinkSync(target);
      }
      for (const [name, identity] of Object.entries(s.fileIdentities).sort(
        ([a], [b]) => b.length - a.length,
      )) {
        const target = path.join(directory, name);
        if (
          identity.type === 'directory' &&
          sameFile(target, identity) &&
          fs.readdirSync(target).length === 0
        )
          fs.rmdirSync(target);
      }
      if (
        fs.readdirSync(directory).length === 1 &&
        fs.readdirSync(directory)[0] === '.hanzi-qa-owned' &&
        sameFile(
          path.join(directory, '.hanzi-qa-owned'),
          s.fileIdentities['.hanzi-qa-owned'],
        )
      ) {
        fs.unlinkSync(path.join(directory, '.hanzi-qa-owned'));
        fs.rmdirSync(directory);
      }
    } else if (
      !daemon &&
      !s.fileIdentities &&
      fs.existsSync(directory) &&
      fs.realpathSync(directory) === directory &&
      fs.readFileSync(path.join(directory, '.hanzi-qa-owned'), 'utf8') ===
        marker
    ) {
      // Setup never exposed this path/client to a callback. Its own failed setup is disposable.
      fs.rmSync(directory, { recursive: true });
    }
  }
}

const rows = async (s, sql) => (await s.client.execute(sql)).rows;
const one = async (s, sql) => (await rows(s, sql))[0] ?? null;
function memberGuard(p) {
  return `EXISTS(SELECT 1 FROM pilot_parent_child l JOIN pilot_auth_user p ON p.id=l.parent_id JOIN pilot_auth_user c ON c.id=l.child_id WHERE l.parent_id=${q(p.parentId)} AND l.child_id=${q(p.childId)} AND p.role='parent' AND c.role='child' AND p.disabled=0 AND c.disabled=0 AND p.must_change_password=0 AND c.must_change_password=0)`;
}
function guard(s) {
  return `${corpusActorGuard(s.context(), 'operator')} AND ${corpusInstallationGuard(s.installationId)} AND ${s.pairs.map(memberGuard).join(' AND ')}`;
}
function schemaGuard(s) {
  const match = s.schemaRows
    .map(
      (r) => `(name=${q(r.name)} AND type=${q(r.type)} AND sql IS ${q(r.sql)})`,
    )
    .join(' OR ');
  return `(SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')=${s.schemaRows.length} AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND NOT (${match}))`;
}
function freshnessGuard(s, final = false) {
  if (s.published) return '1';
  return s.freshTables
    .map(({ table, count, exact: original }) => {
      const addition = final
        ? table === 'pilot_corpus_publication' ||
          table === 'pilot_corpus_publication_state'
          ? 1
          : table === 'pilot_corpus_trial_member'
            ? s.pairs.length
            : 0
        : 0;
      const size = `(SELECT count(*) FROM ${table})=${count + addition}`;
      if (addition || !original?.length) return size;
      const match = original
        .map(
          (r) =>
            '(' +
            Object.entries(r)
              .map(([k, v]) => `${k} IS ${q(v)}`)
              .join(' AND ') +
            ')',
        )
        .join(' OR ');
      return `${size} AND NOT EXISTS(SELECT 1 FROM ${table} WHERE NOT (${match}))`;
    })
    .join(' AND ');
}
function configuration(s) {
  const c = s.config;
  if (
    !c.testMode ||
    !c.testContentAllowed ||
    !c.candidateExplicitlyBound ||
    c.testToken !== s.testToken ||
    c.testRunId !== s.namespace ||
    c.candidateId !== JSON.parse(s.trustBytes).candidateId ||
    canonical(c.curriculumTrust) !== s.trustBytes ||
    canonical(s.corpus.capability) !== s.capabilityBytes ||
    canonical(s.corpus.fixtureBinding) !==
      canonical({
        schemaVersion: 'r6-fixture-binding-1',
        installationId: s.installationId,
        mode: 'synthetic-only',
      })
  )
    stop('CAPABILITY_DENIED');
}
async function check(s) {
  ownership(s);
  configuration(s);
  if ((await schemaDigest(s)) !== s.schemaDigest) stop('CORPUS_SCHEMA_CHANGED');
  if (!(await one(s, `SELECT 1 AS ok WHERE ${guard(s)}`)))
    stop('CAPABILITY_DENIED');
  if (!s.published) {
    if ((await dataDigest(s)) !== s.pristineDigest) stop('CORPUS_NOT_FRESH');
    const headers = await rows(s, 'SELECT id FROM pilot_corpus_snapshot');
    if (headers.some((r) => !s.snapshots.has(r.id))) stop('CORPUS_NOT_FRESH');
  }
  // This result follows actual ownership/schema/content/authentication checks above.
  // It is never passed through a product request or reused for a foreign DB.
  validateCorpusCapability(s.corpus.capability, {
    installationId: s.installationId,
    corpusVersion: s.manifest.corpusVersion,
    corpusDigest: s.corpusDigest,
    namespace: s.namespace,
    candidateId: s.config.candidateId,
    testMode: s.config.testMode,
    testContent: s.config.testContentAllowed,
    tokenBound: s.config.testToken === s.testToken,
    freshOwnedInstallation: owned.get(s.handle) === s && !s.closed,
    currentParentIds: s.pairs.map((p) => p.parentId),
    currentChildIds: s.pairs.map((p) => p.childId),
    currentLinkedPairs: s.pairs,
  });
  ownership(s);
  configuration(s);
}
function statement(s, table, values, condition) {
  const names = Object.keys(values);
  return s.db
    .prepare(
      `INSERT INTO ${table}(${names.join(',')}) SELECT ${names.map(() => '?').join(',')} WHERE ${condition}`,
    )
    .bind(...Object.values(values));
}
async function batch(s, statements) {
  // No asynchronous boundary between current immutable ownership/config and dispatch.
  ownership(s);
  configuration(s);
  const result = await s.db.batch(statements);
  if (result.some((r) => !r.success)) stop('CORPUS_STORAGE_FAILED');
}
const id = (kind) => 'owned-' + kind + '-' + crypto.randomUUID();
async function epoch(s) {
  return Number(
    (
      await one(
        s,
        'SELECT revision FROM pilot_corpus_evidence_epoch WHERE id=1',
      )
    ).revision,
  );
}

/** Only a verified built factory handle can register the frozen temporary trigger. */
export async function setBuiltCorpusRuntimeFault(handle, body) {
  const s = state(handle);
  if (!s.builtRuntime) stop('CORPUS_BUILT_HANDLE_REQUIRED');
  await check(s); // reject all unrelated schema/config/ownership changes first
  await installCorpusRuntimeFault(s.client, body);
  s.schemaDigest = await schemaDigest(s);
  s.schemaRows = (
    await rows(
      s,
      "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).map((r) => ({ name: r.name, type: r.type, sql: r.sql }));
  return body;
}

/** Copy only the fixed synthetic credential hashes between two owned built factories. */
export async function shareBuiltCorpusCredentials(sourceHandle, targetHandle) {
  const source = state(sourceHandle),
    target = state(targetHandle);
  if (
    !source.builtRuntime ||
    !target.builtRuntime ||
    source.builtNegative ||
    !target.builtNegative ||
    source === target
  )
    stop('CORPUS_BUILT_HANDLE_REQUIRED');
  await check(source);
  ownership(target);
  if (
    (await schemaDigest(target)) !== target.schemaDigest ||
    (await dataDigest(target)) !== target.pristineDigest
  )
    stop('CORPUS_NOT_FRESH');
  const actors = corpusRuntimeActors().roles.map(([actor]) => actor);
  const copies = [];
  for (const actor of actors) {
    const credential = await one(
      source,
      "SELECT password FROM pilot_auth_account WHERE provider_id='credential' AND user_id=" +
        q(actor),
    );
    if (
      !credential ||
      typeof credential.password !== 'string' ||
      !credential.password
    )
      stop('CORPUS_CREDENTIALS_INVALID');
    copies.push({
      sql: "UPDATE pilot_auth_account SET password=? WHERE provider_id='credential' AND user_id=?",
      args: [credential.password, actor],
    });
  }
  ownership(source);
  ownership(target);
  const results = await target.client.batch(copies, 'write');
  if (results.some((r) => r.rowsAffected !== 1))
    stop('CORPUS_CREDENTIALS_INVALID');
  target.credentials.splice(
    0,
    target.credentials.length,
    ...source.credentials.map((a) => ({ ...a })),
  );
  target.pristineDigest = await dataDigest(target);
}

/** Prepare a new immutable verification snapshot; returns original begin/seal metadata. */
export async function prepareOwnedCorpus(handle) {
  const s = state(handle);
  await check(s);
  const version = s.manifest.corpusVersion,
    preparedEpoch = await epoch(s),
    candidates = [];
  const characters = await rows(
    s,
    `SELECT c.*,source.id AS current_source_id FROM pilot_corpus_character c JOIN pilot_corpus_source_evidence root ON root.id=c.source_evidence_id JOIN pilot_corpus_source_evidence source ON source.lineage_id=root.lineage_id AND NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence n WHERE n.supersedes_id=source.id) WHERE c.corpus_version=${q(version)} ORDER BY c.lesson_version,c.target_index`,
  );
  const sources = await rows(
    s,
    `SELECT source.* FROM pilot_corpus_source_evidence source WHERE source.installation_id=${q(s.installationId)} AND NOT EXISTS(SELECT 1 FROM pilot_corpus_source_evidence n WHERE n.supersedes_id=source.id)`,
  );
  for (const [ordinal, item] of s.manifest.items.entries()) {
    const document = JSON.parse(
      fixedFile(
        s.profile.packageDirectory + '/' + item.lessonVersion + '.json',
      ),
    );
    const review = await one(
      s,
      `SELECT * FROM pilot_curriculum_review WHERE lesson_version=${q(item.lessonVersion)} ORDER BY review_sequence DESC LIMIT 1`,
    );
    const candidate = await evaluateSnapshotCandidate({
      ordinal,
      document,
      contentDigest: item.contentDigest,
      characters,
      sources,
      review,
      proof: null,
      installationId: s.installationId,
      lane: 'verification',
    });
    if (
      !candidate.targets.every(
        (t) =>
          t.intrinsicEligibility.machineUsableVerification &&
          t.intrinsicEligibility.current,
      )
    )
      stop('CORPUS_FIXTURE_INELIGIBLE');
    candidates.push(candidate);
  }
  const trust = s.config.curriculumTrust;
  const plan = await buildSnapshotPlan(
    {
      corpusVersion: version,
      corpusDigest: s.corpusDigest,
      installationId: s.installationId,
      namespace: s.namespace,
      lane: 'verification',
      candidateId: trust.candidateId,
      sourceDigest: trust.sourceDigest,
      artifactDigest: trust.artifactDigest,
      buildId: trust.buildId,
      evidenceEpoch: preparedEpoch,
    },
    candidates,
  );
  const digests = await snapshotDigests(plan),
    snapshotId = id('snapshot'),
    at = corpusNow(s.context());
  const request = { requestId: id('begin') },
    envelope = corpusRequest(
      'snapshot',
      s.operatorId,
      s.installationId,
      version,
      request,
    );
  const ack = {
    requestId: request.requestId,
    snapshotId,
    status: 'building',
    recordedAt: corpusISO(at),
    packageCount: plan.counts.candidatePackageCount,
    targetCount: plan.counts.targetCount,
  };
  const prepared = `${guard(s)} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${preparedEpoch})`;
  const entry = { plan, digests, begin: ack, seal: null };
  s.snapshots.set(snapshotId, entry);
  await batch(s, [
    statement(
      s,
      'pilot_corpus_snapshot',
      {
        id: snapshotId,
        corpus_version: version,
        corpus_digest: s.corpusDigest,
        installation_id: s.installationId,
        candidate_id: plan.candidateId,
        source_digest: plan.sourceDigest,
        artifact_digest: plan.artifactDigest,
        evidence_epoch: preparedEpoch,
        plan_json: canonical(plan),
        plan_digest: digests.planDigest,
        expected_member_digest: digests.expectedMemberDigest,
        expected_included_count: plan.counts.includedCharacterCount,
        expected_exclusion_count: plan.counts.excludedTargetCount,
        expected_package_count: plan.counts.packageCount,
        released_package_digest: digests.releasedPackageDigest,
        status: 'building',
        created_by: s.operatorId,
        request_id: request.requestId,
        request_json: canonical(envelope),
        request_digest: await H(envelope),
        ack_json: canonical(ack),
        created_at: at,
        test_run_id: s.namespace,
      },
      prepared,
    ),
  ]);
  const facts = snapshotMemberFacts(plan);
  for (let offset = 0; offset < plan.packages.length; offset += 50) {
    const selected = plan.packages.slice(offset, offset + 50).map((p) => ({
      lessonVersion: p.lessonVersion,
      contentDigest: p.contentDigest,
    }));
    const chunk = { requestId: id('chunk'), packages: selected },
      chunkEnvelope = corpusRequest(
        'snapshot-chunk',
        s.operatorId,
        s.installationId,
        snapshotId,
        chunk,
      ),
      recordedAt = corpusNow(s.context());
    const chunkAck = {
      requestId: chunk.requestId,
      snapshotId,
      packageCount: selected.length,
      targetRowCount: selected.length * 2,
      recordedAt: corpusISO(recordedAt),
    };
    const chunkDigest = await H(chunkEnvelope),
      names = new Set(selected.map((p) => p.lessonVersion));
    await batch(
      s,
      facts
        .filter((m) => names.has(m.lesson_version))
        .map((m) =>
          statement(
            s,
            'pilot_corpus_snapshot_member',
            {
              snapshot_id: snapshotId,
              ...m,
              chunk_request_id: chunk.requestId,
              chunk_request_json: canonical(chunkEnvelope),
              chunk_digest: chunkDigest,
              chunk_ack_json: canonical(chunkAck),
              chunk_recorded_at: recordedAt,
            },
            `${prepared} AND EXISTS(SELECT 1 FROM pilot_corpus_snapshot WHERE id=${q(snapshotId)} AND status='building')`,
          ),
        ),
    );
  }
  const persisted = await rows(
    s,
    `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(snapshotId)} ORDER BY member_ordinal`,
  );
  await validateSnapshotRows(plan, persisted);
  const sealedAt = corpusNow(s.context()),
    sealRequest = {
      requestId: id('seal'),
      expectedPlanDigest: digests.planDigest,
    };
  const sealEnvelope = corpusRequest(
    'snapshot-seal',
    s.operatorId,
    s.installationId,
    snapshotId,
    sealRequest,
  );
  const sealAck = {
    requestId: sealRequest.requestId,
    snapshotId,
    status: 'sealed',
    prospectiveDigest: digests.prospectiveDigest,
    packageCount: plan.counts.packageCount,
    includedCharacterCount: plan.counts.includedCharacterCount,
    excludedTargetCount: plan.counts.excludedTargetCount,
    recordedAt: corpusISO(sealedAt),
  };
  await batch(s, [
    s.db
      .prepare(
        `UPDATE pilot_corpus_snapshot SET status='sealed',seal_request_id=?,seal_request_json=?,seal_request_digest=?,seal_ack_json=?,sealed_at=? WHERE id=? AND status='building' AND ${prepared}`,
      )
      .bind(
        sealRequest.requestId,
        canonical(sealEnvelope),
        await H(sealEnvelope),
        canonical(sealAck),
        sealedAt,
        snapshotId,
      ),
  ]);
  const saved = await one(
    s,
    `SELECT status FROM pilot_corpus_snapshot WHERE id=${q(snapshotId)}`,
  );
  if (saved?.status !== 'sealed') stop('SNAPSHOT_STALE');
  entry.seal = sealAck;
  await check(s);
  return structuredClone({ snapshotId, begin: ack, seal: sealAck });
}
function exact(input, keys) {
  if (
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== keys.length ||
    !keys.every(
      (k) =>
        Object.hasOwn(input, k) &&
        Object.getOwnPropertyDescriptor(input, k)?.get === undefined,
    )
  )
    return false;
  return true;
}
async function transition(s, input, status) {
  const keys =
    status === 'released'
      ? [
          'requestId',
          'snapshotId',
          'expectedRevision',
          'predecessorPublicationId',
        ]
      : ['requestId', 'expectedRevision', 'predecessorPublicationId'];
  if (
    !exact(input, keys) ||
    !corpusId(input.requestId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    (input.predecessorPublicationId !== null &&
      !corpusId(input.predecessorPublicationId)) ||
    (status === 'released' && !corpusId(input.snapshotId))
  )
    stop('CORPUS_CONTROL_INVALID');
  await check(s);
  const version = s.manifest.corpusVersion;
  const body =
    status === 'released' ? { ...input, ownerDecisionId: null } : { ...input };
  const envelope = corpusRequest(
      'publication',
      s.operatorId,
      s.installationId,
      version,
      body,
    ),
    requestDigest = await H(envelope);
  const old = await one(
    s,
    `SELECT * FROM pilot_corpus_publication WHERE actor_id=${q(s.operatorId)} AND installation_id=${q(s.installationId)} AND corpus_version=${q(version)} AND request_id=${q(input.requestId)}`,
  );
  if (old) {
    assertExactCorpusReplay(JSON.parse(old.request_json), envelope);
    await check(s);
    return JSON.parse(old.ack_json);
  }
  const head = await one(
    s,
    `SELECT * FROM pilot_corpus_publication_state WHERE corpus_version=${q(version)} AND installation_id=${q(s.installationId)} AND namespace_key=${q(s.namespace)}`,
  );
  if (
    (head?.revision ?? 0) !== input.expectedRevision ||
    (head?.latest_publication_id ?? null) !== input.predecessorPublicationId
  )
    stop('PUBLICATION_STALE');
  const prior = head
    ? await one(
        s,
        `SELECT snapshot_id FROM pilot_corpus_publication WHERE id=${q(head.latest_publication_id)}`,
      )
    : null;
  const snapshotId =
      status === 'released' ? input.snapshotId : prior?.snapshot_id,
    entry = s.snapshots.get(snapshotId);
  if (!entry?.seal) stop('CORPUS_SNAPSHOT_NOT_OWNED');
  const header = await one(
    s,
    `SELECT * FROM pilot_corpus_snapshot WHERE id=${q(snapshotId)}`,
  );
  if (
    !header ||
    header.status !== 'sealed' ||
    header.plan_json !== canonical(entry.plan)
  )
    stop('SNAPSHOT_STALE');
  const plan = await inspectSnapshotPlan(JSON.parse(header.plan_json));
  await validateSnapshotRows(
    plan,
    await rows(
      s,
      `SELECT * FROM pilot_corpus_snapshot_member WHERE snapshot_id=${q(snapshotId)} ORDER BY member_ordinal`,
    ),
  );
  const currentEpoch = await epoch(s);
  if (status === 'released' && plan.evidenceEpoch !== currentEpoch)
    stop('SNAPSHOT_STALE');
  const publicationId = id('publication'),
    at = corpusNow(s.context()),
    revision = input.expectedRevision + 1;
  const scope = {
    kind: 'verification',
    namespace: s.namespace,
    members: s.pairs
      .map((p) => ({ ...p }))
      .sort((a, b) =>
        a.childId < b.childId
          ? -1
          : a.childId > b.childId
            ? 1
            : a.parentId < b.parentId
              ? -1
              : a.parentId > b.parentId
                ? 1
                : 0,
      ),
  };
  const ack = {
    requestId: input.requestId,
    recordId: publicationId,
    recordedAt: corpusISO(at),
    revision,
    corpusDigest: s.corpusDigest,
    snapshotId,
  };
  const headKey = `corpus_version=${q(version)} AND installation_id=${q(s.installationId)} AND namespace_key=${q(s.namespace)}`;
  const headCAS = head
    ? `EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE ${headKey} AND revision=${input.expectedRevision} AND latest_publication_id=${q(input.predecessorPublicationId)})`
    : `NOT EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE ${headKey})`;
  const pre = `${guard(s)} AND ${headCAS} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${currentEpoch}) AND ${freshnessGuard(s)} AND ${schemaGuard(s)}`;
  const inserted = `EXISTS(SELECT 1 FROM pilot_corpus_publication WHERE id=${q(publicationId)})`;
  const statements = [
    statement(
      s,
      'pilot_corpus_publication',
      {
        id: publicationId,
        corpus_version: version,
        corpus_digest: s.corpusDigest,
        snapshot_id: snapshotId,
        installation_id: s.installationId,
        namespace_key: s.namespace,
        revision,
        predecessor_id: input.predecessorPublicationId,
        status,
        scope_kind: 'verification',
        scope_json: canonical(scope),
        scope_digest: await H(scope),
        owner_decision_id: null,
        actor_id: s.operatorId,
        request_id: input.requestId,
        request_digest: requestDigest,
        request_json: canonical(envelope),
        ack_json: canonical(ack),
        created_at: at,
        test_run_id: s.namespace,
      },
      pre,
    ),
  ];
  for (const p of scope.members)
    statements.push(
      statement(
        s,
        'pilot_corpus_trial_member',
        {
          publication_id: publicationId,
          installation_id: s.installationId,
          parent_id: p.parentId,
          child_id: p.childId,
        },
        inserted,
      ),
    );
  if (head)
    statements.push(
      s.db.prepare(
        `UPDATE pilot_corpus_publication_state SET revision=${revision},latest_publication_id=${q(publicationId)},updated_at=${at} WHERE ${headKey} AND revision=${input.expectedRevision} AND latest_publication_id=${q(input.predecessorPublicationId)} AND ${inserted}`,
      ),
    );
  else
    statements.push(
      statement(
        s,
        'pilot_corpus_publication_state',
        {
          corpus_version: version,
          installation_id: s.installationId,
          namespace_key: s.namespace,
          revision,
          latest_publication_id: publicationId,
          updated_at: at,
        },
        inserted,
      ),
    );
  const final = `${guard(s)} AND EXISTS(SELECT 1 FROM pilot_corpus_publication_state WHERE ${headKey} AND latest_publication_id=${q(publicationId)} AND revision=${revision}) AND (SELECT count(*) FROM pilot_corpus_trial_member WHERE publication_id=${q(publicationId)})=${scope.members.length} AND EXISTS(SELECT 1 FROM pilot_corpus_evidence_epoch WHERE id=1 AND revision=${currentEpoch + 1}) AND ${freshnessGuard(s, true)} AND ${schemaGuard(s)}`;
  statements.push(
    s.db.prepare(
      `INSERT INTO pilot_corpus_publication_audit(id,publication_id,actor_id,action,request_id,created_at) VALUES(${q(id('audit'))},CASE WHEN ${final} THEN ${q(publicationId)} ELSE NULL END,${q(s.operatorId)},${q(status)},${q(input.requestId)},${at})`,
    ),
  );
  // Recheck the actual fresh data and schema after all asynchronous preparation.
  await check(s);
  try {
    await batch(s, statements);
  } catch (error) {
    const saved = await one(
      s,
      `SELECT * FROM pilot_corpus_publication WHERE id=${q(publicationId)}`,
    );
    if (!saved) {
      const current = await one(
        s,
        `SELECT revision,latest_publication_id FROM pilot_corpus_publication_state WHERE ${headKey}`,
      );
      if (
        (current?.revision ?? 0) !== input.expectedRevision ||
        (current?.latest_publication_id ?? null) !==
          input.predecessorPublicationId
      )
        stop('PUBLICATION_STALE');
      throw error;
    }
    assertExactCorpusReplay(JSON.parse(saved.request_json), envelope);
    s.published = true;
    await check(s);
    return JSON.parse(saved.ack_json);
  }
  const saved = await one(
    s,
    `SELECT * FROM pilot_corpus_publication WHERE id=${q(publicationId)}`,
  );
  if (!saved) stop('PUBLICATION_STALE');
  s.published = true;
  await check(s);
  return JSON.parse(saved.ack_json);
}
export async function publishOwnedCorpus(handle, input) {
  return transition(state(handle), input, 'released');
}
export async function withdrawOwnedCorpus(handle, input) {
  return transition(state(handle), input, 'withdrawn');
}
export async function bootstrapOwnedCorpus(handle) {
  const s = state(handle);
  await check(s);
  if (!s.bootstrapSnapshot)
    s.bootstrapSnapshot = (await prepareOwnedCorpus(handle)).snapshotId;
  return publishOwnedCorpus(handle, {
    requestId: 'owned-initial-publication',
    snapshotId: s.bootstrapSnapshot,
    expectedRevision: 0,
    predecessorPublicationId: null,
  });
}
