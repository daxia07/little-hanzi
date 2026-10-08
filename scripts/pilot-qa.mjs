import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadManifest } from './qa-helpers.mjs';
import { server } from './qa-server.mjs';
import { localD1, sqlValue } from './pilot-local-db.mjs';
import { accountInsert } from './pilot-accounts.mjs';
import { restoreHarness } from './pilot-restore-harness.mjs';
import { pilotBackupFormatForCandidate } from './pilot-backup.mjs';
import { assertPilotCompatibilityManifest } from './readiness-worker-compat.mjs';

const index = process.argv.indexOf('--manifest');
const manifest = loadManifest(index >= 0 ? process.argv[index + 1] : null);
const schemaIndex = process.argv.indexOf('--historical-schema');
const historicalSchema =
  schemaIndex < 0 ? undefined : process.argv[schemaIndex + 1];
if (schemaIndex >= 0 && historicalSchema === undefined)
  throw new Error('Historical schema value required');
assertPilotCompatibilityManifest(manifest, { historicalSchema });
const registryRestore = process.argv.includes('--curriculum-restore');
const runtimeRestore = process.argv.includes('--runtime-restore');
const reviewDesk = process.argv.includes('--review-desk');
if (registryRestore && runtimeRestore)
  throw new Error(
    'Run curriculum and runtime restore as separate isolated probes',
  );
const restore =
  registryRestore || runtimeRestore || process.argv.includes('--restore');
const learning = restore || process.argv.includes('--learning');
const curriculum = process.argv.includes('--curriculum');
if (reviewDesk && (restore || learning || curriculum))
  throw new Error('Run the review desk as a separate isolated pilot probe');
if (curriculum && learning)
  throw new Error(
    'Run curriculum and learning/restore as separate isolated probes',
  );
const name = `${reviewDesk ? 'pilot-review-desk' : runtimeRestore ? 'pilot-runtime-restore' : registryRestore ? 'pilot-curriculum-restore' : curriculum ? 'pilot-curriculum' : restore ? 'pilot-restore' : learning ? 'pilot-learning' : 'pilot'}-${Date.now()}`;
const output = path.join(manifest.output, name);
fs.mkdirSync(output, { recursive: true });
const token = crypto.randomBytes(24).toString('hex');
const authSecret = crypto.randomBytes(32).toString('hex');
const accounts = {};
const storedSecrets = [];
const evidence = {
  candidateId: manifest.candidateId,
  specVersion: manifest.specVersion,
  historicalSchema: historicalSchema ?? null,
  startedAt: new Date().toISOString(),
  checks: [],
  scenarios: [],
};
let running;
let db;
let auditUnavailable = false;
let eventsUnavailable = false;
let curriculumAuditUnavailable = false;
let restoreFixtures;
try {
  if (restore) pilotBackupFormatForCandidate(manifest, { historicalSchema });
  const probe = await import(
    pathToFileURL(
      path.join(
        manifest.snapshot,
        reviewDesk
          ? 'tests/pilot-review-desk-integration.mjs'
          : curriculum
            ? 'tests/pilot-curriculum-integration.mjs'
            : learning
              ? 'tests/pilot-learning-integration.mjs'
              : 'tests/pilot-integration.mjs',
      ),
    )
  );
  const runProbe = curriculum
    ? probe.runPilotCurriculumIntegration
    : reviewDesk
      ? probe.runPilotReviewDeskIntegration
      : learning
        ? probe.runPilotLearningIntegration
        : probe.runPilotIntegration;
  running = await server(manifest, {
    name,
    testing: true,
    token,
    pilot: true,
    pilotTestContent: learning || curriculum || reviewDesk,
    authSecret,
    output,
    beforeStart: async (options) => {
      db = localD1(manifest, { ...options, historicalSchema });
      evidence.migrations = db.migrate();
      const configModifiedAt = fs.statSync(options.configPath).mtimeMs;
      db.query(
        "CREATE TABLE attempts(profile TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(profile,id)); INSERT INTO attempts VALUES('synthetic-legacy','sentinel','2026-09-25','{\"sentinel\":true}');",
      );
      db.migrate();
      if (fs.statSync(options.configPath).mtimeMs !== configModifiedAt)
        throw new Error('Repeated migration rewrote the Worker configuration');
      if (
        db.query('SELECT COUNT(*) AS count FROM attempts;')[0].results[0]
          .count !== 1
      )
        throw new Error('Repeat migration changed legacy fixture');
      evidence.checks.push({
        id: 'S2-MIGRATE-01',
        status: 'PASS',
        detail:
          'Fresh and repeated migrations preserve synthetic legacy record and leave configured Worker files unchanged',
      });
      const inserts = [];
      for (const [key, role] of Object.entries({
        operator: 'operator',
        parentA: 'parent',
        parentB: 'parent',
        childA: 'child',
        childB: 'child',
        teacher: 'teacher',
        otherTeacher: 'teacher',
        ...(registryRestore || runtimeRestore ? { reviewer: 'operator' } : {}),
      })) {
        const input = {
          username: `qa.${key.toLowerCase()}`,
          name: `Synthetic ${key}`,
          role,
          password: crypto.randomBytes(20).toString('base64url'),
        };
        const created = await accountInsert(input, {
          mustChangePassword: false,
        });
        accounts[key] = created.account;
        inserts.push(created.sql);
      }
      db.query(inserts.join('\n'));
      storedSecrets.push(
        ...db
          .query(
            'SELECT password FROM pilot_auth_account WHERE password IS NOT NULL;',
          )[0]
          .results.map((row) => row.password),
      );
      evidence.checks.push({
        id: 'S2-FIXTURES-01',
        status: 'PASS',
        detail: `${Object.keys(accounts).length} ordinary accounts created before server start; no HTTP fixture bypass`,
      });
    },
  });
  const setAuditAvailable = async (available) => {
    if (available === !auditUnavailable) return;
    if (typeof available !== 'boolean')
      throw new Error('Audit availability must be a boolean');
    db.query(
      available
        ? 'ALTER TABLE pilot_account_audit_unavailable RENAME TO pilot_account_audit;'
        : 'ALTER TABLE pilot_account_audit RENAME TO pilot_account_audit_unavailable;',
    );
    auditUnavailable = !available;
  };
  const learningFixtures = learning
    ? {
        testRunId: running.testRunId,
        setRelease: async ({ kind, testRunId = running.testRunId }) => {
          if (
            !['none', 'test-fixture'].includes(kind) ||
            typeof testRunId !== 'string'
          )
            throw new Error('Invalid synthetic content fixture');
          if (kind === 'none') {
            db.query(
              "DELETE FROM pilot_learning_release WHERE lesson_version='forest-01-v1';",
            );
            return;
          }
          const { FOREST_LESSON } = await import(
            pathToFileURL(
              path.join(manifest.snapshot, 'lib/preview/content.ts'),
            )
          );
          const digest = crypto
            .createHash('sha256')
            .update(JSON.stringify(FOREST_LESSON))
            .digest('hex');
          db.query(`INSERT OR REPLACE INTO pilot_learning_release
        (lesson_version,release_kind,content_digest,reviewer_label,evidence_ref,candidate_id,test_run_id,released_at)
        VALUES('forest-01-v1','test-fixture',${sqlValue(digest)},'Synthetic test fixture','isolated integration only',${sqlValue(manifest.candidateId)},${sqlValue(testRunId)},${Date.now()});`);
        },
        setTestContentAllowed: async (allowed) => {
          if (typeof allowed !== 'boolean')
            throw new Error('Content fixture guard must be boolean');
          const config = JSON.parse(
            fs.readFileSync(running.configPath, 'utf8'),
          );
          config.vars.HANZI_PILOT_TEST_CONTENT = allowed ? '1' : '0';
          fs.writeFileSync(running.configPath, JSON.stringify(config), {
            mode: 0o600,
          });
          await running.restart();
        },
        setLearningEventsAvailable: async (available) => {
          if (typeof available !== 'boolean')
            throw new Error('Event availability must be boolean');
          if (available === !eventsUnavailable) return;
          db.query(
            available
              ? 'DROP TRIGGER IF EXISTS pilot_learning_event_fail;'
              : "CREATE TRIGGER pilot_learning_event_fail BEFORE INSERT ON pilot_learning_event BEGIN SELECT RAISE(ABORT,'synthetic event write failure'); END;",
          );
          eventsUnavailable = !available;
        },
        inspectLearning: async () =>
          Object.fromEntries(
            [
              ['runs', 'pilot_learning_run'],
              ['ownership', 'pilot_run_ownership'],
              ['events', 'pilot_learning_event'],
              ['assignments', 'pilot_assignment'],
              ['onboarding', 'pilot_onboarding'],
            ].map(([key, table]) => [
              key,
              db.query(`SELECT * FROM ${table};`)[0].results,
            ]),
          ),
      }
    : {};
  const curriculumContext =
    curriculum || reviewDesk
      ? {
          testRunId: running.testRunId,
          curriculumFixtures: {
            inspect: async () => {
              const tables = [
                'pilot_curriculum_registry_state',
                'pilot_curriculum_package',
                'pilot_curriculum_character',
                'pilot_curriculum_review',
                'pilot_curriculum_audit',
              ];
              const existing = db
                .query(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pilot_curriculum_%';",
                )[0]
                .results.map((row) => row.name);
              const keys = [
                'state',
                'packages',
                'characters',
                'reviews',
                'audit',
              ];
              const selected = tables.filter((table) =>
                existing.includes(table),
              );
              const results = selected.length
                ? db.query(
                    selected
                      .map((table) => `SELECT * FROM ${table};`)
                      .join('\n'),
                  )
                : [];
              return Object.fromEntries(
                tables.map((table, index) => [
                  keys[index],
                  results[selected.indexOf(table)]?.results ?? [],
                ]),
              );
            },
            setAuditAvailable: async (available) => {
              if (typeof available !== 'boolean')
                throw new Error('Audit fixture flag must be boolean');
              if (available === !curriculumAuditUnavailable) return;
              db.query(
                available
                  ? 'DROP TRIGGER IF EXISTS pilot_curriculum_audit_fail;'
                  : "CREATE TRIGGER pilot_curriculum_audit_fail BEFORE INSERT ON pilot_curriculum_audit BEGIN SELECT RAISE(ABORT,'synthetic registry audit failure'); END;",
              );
              curriculumAuditUnavailable = !available;
            },
            setTestContentAllowed: async (allowed) => {
              if (typeof allowed !== 'boolean')
                throw new Error('Content fixture guard must be boolean');
              const config = JSON.parse(
                fs.readFileSync(running.configPath, 'utf8'),
              );
              config.vars.HANZI_PILOT_TEST_CONTENT = allowed ? '1' : '0';
              fs.writeFileSync(running.configPath, JSON.stringify(config), {
                mode: 0o600,
              });
              await running.restart();
            },
            setFixtureRunId: async (testRunId) => {
              if (
                ![running.testRunId, `${running.testRunId}-foreign`].includes(
                  testRunId,
                )
              )
                throw new Error('Fixture namespace must belong to this runner');
              const config = JSON.parse(
                fs.readFileSync(running.configPath, 'utf8'),
              );
              config.vars.HANZI_TEST_RUN_ID = testRunId;
              fs.writeFileSync(running.configPath, JSON.stringify(config), {
                mode: 0o600,
              });
              await running.restart();
            },
          },
        }
      : {};
  evidence.scenarios = await runProbe({
    baseURL: running.baseURL,
    accounts,
    restart: running.restart,
    testToken: token,
    expireSessions: async (userId) => {
      if (!Object.values(accounts).some((account) => account.id === userId))
        throw new Error('Expiry fixture must target a seeded account');
      db.query(
        `UPDATE pilot_auth_session SET expires_at=${Date.now() - 60_000} WHERE user_id=${sqlValue(userId)};`,
      );
    },
    revokeAccount: async (userId) => {
      if (!Object.values(accounts).some((account) => account.id === userId))
        throw new Error('Revocation fixture must target a seeded account');
      db.query(
        `DELETE FROM pilot_auth_session WHERE user_id=${sqlValue(userId)};
         UPDATE pilot_auth_user SET disabled=1 WHERE id=${sqlValue(userId)};`,
      );
    },
    inspectAudit: async () =>
      db.query(
        'SELECT id,action,actor_user_id,target_user_id,metadata,created_at FROM pilot_account_audit ORDER BY created_at,id;',
      )[0].results,
    setAuditAvailable,
    ...learningFixtures,
    ...curriculumContext,
  });
  if (restore) {
    if (evidence.scenarios.some((test) => test.status !== 'PASS'))
      throw new Error(
        'Restore rehearsal requires passing ordinary learning setup',
      );
    restoreFixtures = restoreHarness({
      manifest,
      historicalSchema,
      running,
      db,
      accounts,
      authSecret,
      token,
      output,
      name,
    });
    const restoreProbe = await import(
      pathToFileURL(
        path.join(
          manifest.snapshot,
          runtimeRestore
            ? 'tests/pilot-runtime-restore-integration.mjs'
            : registryRestore
              ? 'tests/pilot-curriculum-restore-integration.mjs'
              : 'tests/pilot-restore-integration.mjs',
        ),
      )
    );
    const runRestore = runtimeRestore
      ? restoreProbe.runPilotRuntimeRestoreIntegration
      : registryRestore
        ? restoreProbe.runPilotCurriculumRestoreIntegration
        : restoreProbe.runPilotRestoreIntegration;
    evidence.scenarios.push(...(await runRestore(restoreFixtures.context)));
  }
  // The sentinel is read directly from the same D1 after actual HTTP requests.
  if (
    db.query('SELECT COUNT(*) AS count FROM attempts;')[0].results[0].count !==
    1
  )
    throw new Error('Pilot testing changed legacy fixture');
  evidence.checks.push({
    id: 'S2-ISOLATION-01',
    status: 'PASS',
    detail: 'Legacy fixture remains intact after authenticated API exercises',
  });
  if (
    !evidence.scenarios.length ||
    evidence.scenarios.some((test) => test.status !== 'PASS')
  )
    process.exitCode = 1;
} catch (error) {
  evidence.error =
    error instanceof Error ? error.message : 'Pilot verification failed';
  process.exitCode = 1;
} finally {
  if (restoreFixtures) {
    try {
      const checks = await restoreFixtures.close();
      evidence.checks.push(...checks);
      if (checks.some((check) => check.status !== 'PASS')) process.exitCode = 1;
    } catch {
      evidence.cleanupError = 'Restore destination cleanup did not complete';
      process.exitCode = 1;
    }
  }
  if (eventsUnavailable && db) {
    try {
      db.query('DROP TRIGGER IF EXISTS pilot_learning_event_fail;');
    } catch {
      evidence.cleanupError = 'Could not restore synthetic event writes';
      process.exitCode = 1;
    }
  }
  if (curriculumAuditUnavailable && db) {
    try {
      db.query('DROP TRIGGER IF EXISTS pilot_curriculum_audit_fail;');
    } catch {
      evidence.cleanupError =
        'Could not restore synthetic curriculum audit writes';
      process.exitCode = 1;
    }
  }
  if (auditUnavailable && db) {
    try {
      db.query(
        'ALTER TABLE pilot_account_audit_unavailable RENAME TO pilot_account_audit;',
      );
    } catch {
      evidence.cleanupError = 'Could not restore synthetic audit table';
      process.exitCode = 1;
    }
  }
  if (running) {
    await running.stop();
    try {
      storedSecrets.push(
        ...db
          .query(
            'SELECT password FROM pilot_auth_account WHERE password IS NOT NULL;',
          )[0]
          .results.map((row) => row.password),
      );
      storedSecrets.push(
        ...db
          .query('SELECT token FROM pilot_auth_session;')[0]
          .results.map((row) => row.token),
      );
      const logText = fs.readFileSync(
        path.join(output, `${name}-server.log`),
        'utf8',
      );
      const secrets = [
        token,
        authSecret,
        ...storedSecrets,
        ...Object.values(accounts).map((account) => account.password),
      ];
      const secretFound =
        secrets.some((secret) => secret && logText.includes(secret)) ||
        /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(
          logText,
        );
      evidence.checks.push({
        id: 'S2-LOGS-01',
        status: secretFound ? 'FAIL' : 'PASS',
        detail:
          'Stopped server log checked for known fixture credentials, hashes, remaining session tokens and serialized credential fields',
      });
      if (secretFound) {
        process.exitCode = 1;
        let scrubbed = logText;
        for (const secret of secrets.filter(Boolean))
          scrubbed = scrubbed.replaceAll(secret, '[redacted]');
        scrubbed = scrubbed
          .split('\n')
          .map((line) =>
            /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(
              line,
            )
              ? '[credential-bearing log line redacted]'
              : line,
          )
          .join('\n');
        fs.writeFileSync(path.join(output, `${name}-server.log`), scrubbed);
      }
    } catch {
      evidence.checks.push({
        id: 'S2-LOGS-01',
        status: 'BLOCKED',
        detail: 'Could not complete stopped-server log inspection',
      });
      process.exitCode = 1;
    }
    fs.rmSync(running.configPath, { force: true });
  }
  evidence.finishedAt = new Date().toISOString();
  // Never persist synthetic credentials. A failed HTTP assertion may include
  // one, so scrub before creating the shareable report as well as console text.
  let report = JSON.stringify(evidence, null, 2);
  for (const secret of [
    token,
    authSecret,
    ...Object.values(accounts).map((account) => account.password),
  ])
    report = report.replaceAll(secret, '[redacted]');
  fs.writeFileSync(path.join(output, 'results.json'), report);
  for (const result of [...evidence.checks, ...evidence.scenarios])
    console.log(`${result.status} ${result.id}`);
  if (evidence.error)
    console.error(
      'Pilot verification stopped; inspect the sanitized results artifact.',
    );
  console.log(`Pilot evidence: ${path.join(output, 'results.json')}`);
}
