import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadManifest } from './qa-helpers.mjs';
import { server } from './qa-server.mjs';
import { localD1, sqlValue } from './pilot-local-db.mjs';
import { accountInsert } from './pilot-accounts.mjs';
import {
  backupPilot,
  readPilotBackup,
  validatePilotRuntimeBackup,
  validatePilotStoryBackup,
  pilotBackupFormatForCandidate,
} from './pilot-backup.mjs';

import { assertPilotCompatibilityManifest } from './readiness-worker-compat.mjs';
import { restoreFormatProfile } from './pilot-restore-harness.mjs';
import { validatePilotCollectionBackup } from './pilot-collection-backup.mjs';

const index = process.argv.indexOf('--manifest');
const manifest = loadManifest(index >= 0 ? process.argv[index + 1] : null);
assertPilotCompatibilityManifest(manifest);
const name = `pilot-curriculum-runtime-${Date.now()}`;
const output = path.join(manifest.output, name);
fs.mkdirSync(output, { recursive: true });
const token = crypto.randomBytes(24).toString('hex');
const authSecret = crypto.randomBytes(32).toString('hex');
const accounts = {};
const secrets = [token, authSecret];
const evidence = {
  candidateId: manifest.candidateId,
  contract: 's3-runtime-http-1',
  startedAt: new Date().toISOString(),
  checks: [],
  scenarios: [],
};
let running;
let db;
let corruptEvent = null;
const tables = [
  'pilot_curriculum_runtime_run',
  'pilot_curriculum_runtime_event',
  'pilot_curriculum_runtime_audit',
];
const faultTriggers = [
  'pilot_runtime_event_fault',
  'pilot_runtime_audit_fault',
];
const rows = (sql) => db.query(sql)[0].results;

function writeCorruptionRow(record, event) {
  db.query(`DROP TRIGGER pilot_curriculum_runtime_event_no_update;
    UPDATE pilot_curriculum_runtime_event SET sequence=${sqlValue(event.sequence)},event_json=${sqlValue(event.event_json)},created_at=${sqlValue(event.created_at)}
      WHERE run_id=${sqlValue(record.row.run_id)} AND event_id=${sqlValue(record.row.event_id)};
    ${record.trigger};`);
}
function restoreEventCorruption() {
  if (corruptEvent === null) return;
  writeCorruptionRow(corruptEvent, corruptEvent.row);
  corruptEvent = null;
}

try {
  const { runPilotCurriculumRuntimeIntegration } = await import(
    pathToFileURL(
      path.join(
        manifest.snapshot,
        'tests/pilot-curriculum-runtime-integration.mjs',
      ),
    )
  );
  running = await server(manifest, {
    name,
    testing: true,
    token,
    pilot: true,
    pilotTestContent: true,
    authSecret,
    output,
    beforeStart: async (options) => {
      db = localD1(manifest, options);
      evidence.migrations = db.migrate();
      const configTime = fs.statSync(options.configPath).mtimeMs;
      db.query(
        "CREATE TABLE attempts(profile TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(profile,id)); INSERT INTO attempts VALUES('synthetic-legacy','sentinel','2026-09-25','{\"sentinel\":true}');",
      );
      db.migrate();
      if (
        fs.statSync(options.configPath).mtimeMs !== configTime ||
        rows('SELECT COUNT(*) AS n FROM attempts')[0].n !== 1
      )
        throw new Error(
          'Repeated migration changed owned legacy fixture or configuration',
        );
      evidence.checks.push({
        id: 'C-H-MIGRATE',
        status: 'PASS',
        detail:
          'Fresh and repeated candidate migrations retain the legacy sentinel',
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
        secrets.push(created.account.password);
        inserts.push(created.sql);
      }
      db.query(inserts.join('\n'));
      secrets.push(
        ...rows(
          'SELECT password FROM pilot_auth_account WHERE password IS NOT NULL',
        ).map((row) => row.password),
      );
      evidence.checks.push({
        id: 'C-H-FIXTURES',
        status: 'PASS',
        detail:
          'Seven ordinary synthetic accounts provisioned before Worker startup; no session bypass',
      });
    },
  });

  const setVars = async (patch, expectedCandidateId = manifest.candidateId) => {
    const config = JSON.parse(fs.readFileSync(running.configPath, 'utf8'));
    if (
      Object.entries(patch).every(([key, value]) => config.vars[key] === value)
    )
      return;
    await running.stop();
    Object.assign(config.vars, patch);
    fs.writeFileSync(running.configPath, JSON.stringify(config), {
      mode: 0o600,
    });
    await running.restart({ expectedCandidateId });
  };
  const runtimeFixtures = {
    setEventCorruption: async (runId, kind) => {
      if (
        typeof runId !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(runId) ||
        ![null, 'time', 'sequence', 'result'].includes(kind)
      )
        throw new Error('Invalid owned event corruption');
      if (kind === null) {
        if (corruptEvent && corruptEvent.row.run_id !== runId)
          throw new Error('Corruption restoration run mismatch');
        restoreEventCorruption();
        return;
      }
      if (corruptEvent)
        throw new Error('Restore the previous corruption first');
      const owned =
        rows(`SELECT r.run_id FROM pilot_curriculum_runtime_run r JOIN pilot_installation i ON i.id=1 AND i.installation_id=r.installation_id
        WHERE r.run_id=${sqlValue(runId)} AND r.candidate_id=${sqlValue(manifest.candidateId)} AND r.test_run_id=${sqlValue(running.testRunId)} AND r.purpose='test-verification'`);
      if (owned.length !== 1)
        throw new Error(
          'Corruption target is outside the owned runtime binding',
        );
      const row = rows(
        `SELECT * FROM pilot_curriculum_runtime_event WHERE run_id=${sqlValue(runId)} ORDER BY sequence LIMIT 1`,
      )[0];
      const trigger = rows(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='pilot_curriculum_runtime_event_no_update'",
      )[0]?.sql;
      if (!row || !trigger)
        throw new Error(
          'Corruption requires an event and its immutable trigger',
        );
      const changed = { ...row };
      if (kind === 'time') changed.created_at += 1;
      if (kind === 'sequence') changed.sequence = 999;
      if (kind === 'result') {
        const value = JSON.parse(row.event_json);
        if (value.type !== 'continue')
          throw new Error('Semantic corruption requires a navigation event');
        value.result.outcome = 'correct';
        value.ack.result.outcome = 'correct';
        changed.event_json = JSON.stringify(value);
      }
      corruptEvent = { row, trigger };
      writeCorruptionRow(corruptEvent, changed);
    },
    inspect: async () => {
      const existing = new Set(
        rows("SELECT name FROM sqlite_master WHERE type='table'").map(
          (row) => row.name,
        ),
      );
      const values = tables.map((table) =>
        existing.has(table)
          ? rows(`SELECT * FROM ${table} ORDER BY rowid`)
          : [],
      );
      return {
        runs: values[0],
        events: values[1],
        audit: values[2],
        legacyCounts: Object.fromEntries(
          [
            'pilot_assignment',
            'pilot_run_ownership',
            'pilot_learning_run',
            'pilot_learning_event',
          ].map((table) => [
            table,
            rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,
          ]),
        ),
        registryRevision: rows(
          'SELECT revision FROM pilot_curriculum_registry_state WHERE id=1',
        )[0]?.revision,
        installationId: rows(
          'SELECT installation_id FROM pilot_installation WHERE id=1',
        )[0]?.installation_id,
      };
    },
    setWriteFault: async (kind) => {
      if (![null, 'event', 'audit'].includes(kind))
        throw new Error('Unknown runtime write fault');
      db.query(
        faultTriggers
          .map((trigger) => `DROP TRIGGER IF EXISTS ${trigger};`)
          .join('\n'),
      );
      if (kind !== null)
        db.query(
          `CREATE TRIGGER pilot_runtime_${kind}_fault BEFORE INSERT ON pilot_curriculum_runtime_${kind} BEGIN SELECT RAISE(ABORT,'synthetic runtime write failure'); END;`,
        );
    },
    setTestContentAllowed: async (allowed) => {
      if (typeof allowed !== 'boolean')
        throw new Error('Test content guard must be boolean');
      await setVars({ HANZI_PILOT_TEST_CONTENT: allowed ? '1' : '0' });
    },
    setCandidateBound: async (bound) => {
      if (typeof bound !== 'boolean')
        throw new Error('Candidate guard must be boolean');
      await setVars(
        { HANZI_CANDIDATE_ID: bound ? manifest.candidateId : '' },
        bound ? manifest.candidateId : 'local-pilot',
      );
    },
    setFixtureRunId: async (namespace) => {
      if (!['own', 'foreign'].includes(namespace))
        throw new Error('Invalid fixture namespace');
      await setVars({
        HANZI_TEST_RUN_ID:
          namespace === 'own'
            ? running.testRunId
            : `${running.testRunId}-foreign`,
      });
    },
    setClock: async (now) => {
      if (
        now !== null &&
        (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
      )
        throw new Error('Invalid fixture clock');
      await setVars({
        HANZI_CURRICULUM_TEST_NOW: now === null ? '' : String(now),
      });
    },
    rotateInstallation: async () => {
      const replacement = `runtime-qa-${crypto.randomUUID()}`;
      db.query(
        `UPDATE pilot_installation SET installation_id='${replacement}' WHERE id=1;`,
      );
      return replacement;
    },
  };
  evidence.scenarios = await runPilotCurriculumRuntimeIntegration({
    baseURL: running.baseURL,
    accounts,
    restart: running.restart,
    runtimeFixtures,
  });
  if (
    evidence.migrations.some(
      (item) => item.version === 'pilot-curriculum-runtime-0004',
    )
  ) {
    const before = await runtimeFixtures.inspect();
    if (evidence.scenarios.every((item) => item.status === 'PASS')) {
      if (!before.runs.length || !before.events.length || !before.audit.length)
        throw new Error(
          'Runtime immutability checks require populated HTTP evidence',
        );
      const forbiddenMutations = [
        "UPDATE pilot_curriculum_runtime_run SET candidate_id=candidate_id||'-changed'",
        'DELETE FROM pilot_curriculum_runtime_run',
        'UPDATE pilot_curriculum_runtime_event SET event_json=event_json',
        'DELETE FROM pilot_curriculum_runtime_event',
        'UPDATE pilot_curriculum_runtime_audit SET created_at=created_at',
        'DELETE FROM pilot_curriculum_runtime_audit',
      ];
      for (const sql of forbiddenMutations) {
        let rejected = false;
        try {
          db.query(sql);
        } catch {
          rejected = true;
        }
        if (
          !rejected ||
          JSON.stringify(before) !==
            JSON.stringify(await runtimeFixtures.inspect())
        )
          throw new Error(
            'Historical runtime identity/events/audit allowed mutation',
          );
      }
      evidence.checks.push({
        id: 'C-H-IMMUTABLE',
        status: 'PASS',
        detail:
          'Six forbidden mutations refused on HTTP-populated real D1 with exact runtime row preservation',
      });
    }
    const filePath = path.join(
      manifest.work,
      'private-backups',
      `${name}.json`,
    );
    const target = {
      manifest,
      configPath: running.configPath,
      state: running.state,
      filePath,
    };
    const backup = await backupPilot(target);
    const { payload } = readPilotBackup(filePath);
    const selectedFormat = pilotBackupFormatForCandidate(manifest);
    const profile = restoreFormatProfile(selectedFormat);
    if (selectedFormat === 'pilot-admin-backup-5')
      await validatePilotCollectionBackup(payload);
    else if (selectedFormat === 'pilot-admin-backup-4')
      await validatePilotStoryBackup(payload);
    else await validatePilotRuntimeBackup(payload);
    if (
      backup.format !== selectedFormat ||
      Object.keys(backup.counts).length !== profile.tables.length ||
      Object.keys(payload.tables).length !== profile.tables.length ||
      !payload.tables.pilot_curriculum_runtime_run.length ||
      (fs.statSync(filePath).mode & 0o777) !== 0o600 ||
      (fs.statSync(path.dirname(filePath)).mode & 0o777) !== 0o700 ||
      JSON.stringify(before) !== JSON.stringify(await runtimeFixtures.inspect())
    ) {
      throw new Error(
        'Runtime backup capture failed its format, privacy or source preservation check',
      );
    }
    evidence.checks.push({
      id: 'C-H-BACKUP-BOUNDARY',
      status: 'PASS',
      detail: `${selectedFormat} captures all ${profile.tables.length} tables, parses and replays runtime history with owner-only file modes and unchanged source rows; unknown future schemas remain covered by the Node boundary test`,
    });
  }
  if (rows('SELECT COUNT(*) AS n FROM attempts')[0].n !== 1)
    throw new Error('Runtime probe changed the legacy sentinel');
  evidence.checks.push({
    id: 'C-H-ISOLATION',
    status: 'PASS',
    detail: 'Legacy sentinel retained in disposable D1 after HTTP requests',
  });
  if (
    evidence.scenarios.length !== 7 ||
    evidence.scenarios.some((item) => item.status !== 'PASS')
  )
    process.exitCode = 1;
} catch (error) {
  evidence.error =
    error instanceof Error ? error.message : 'Runtime verification failed';
  process.exitCode = 1;
} finally {
  if (db) {
    try {
      restoreEventCorruption();
    } catch {
      evidence.cleanupError = 'Could not restore owned corrupt event fixture';
      process.exitCode = 1;
    }
    try {
      db.query(
        faultTriggers
          .map((trigger) => `DROP TRIGGER IF EXISTS ${trigger};`)
          .join('\n'),
      );
    } catch {
      evidence.cleanupError = 'Could not remove owned runtime fault triggers';
      process.exitCode = 1;
    }
  }
  if (running) {
    await running.stop();
    evidence.checks.push({
      id: 'C-H-CLEANUP',
      status: 'PASS',
      detail: 'Owned Worker stopped',
    });
    try {
      secrets.push(
        ...rows(
          'SELECT password FROM pilot_auth_account WHERE password IS NOT NULL',
        ).map((row) => row.password),
      );
      secrets.push(
        ...rows('SELECT token FROM pilot_auth_session').map((row) => row.token),
      );
      const file = path.join(output, `${name}-server.log`);
      let log = fs.readFileSync(file, 'utf8');
      const found =
        secrets.some((secret) => secret && log.includes(secret)) ||
        /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(log);
      evidence.checks.push({
        id: 'C-H-LOGS',
        status: found ? 'FAIL' : 'PASS',
        detail:
          'Stopped log inspected for fixture credentials, hashes, session tokens and serialized secrets',
      });
      if (found) {
        process.exitCode = 1;
        for (const secret of secrets.filter(Boolean))
          log = log.replaceAll(secret, '[redacted]');
        log = log
          .split('\n')
          .map((line) =>
            /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(
              line,
            )
              ? '[credential-bearing line redacted]'
              : line,
          )
          .join('\n');
        fs.writeFileSync(file, log);
      }
    } catch {
      evidence.checks.push({
        id: 'C-H-LOGS',
        status: 'BLOCKED',
        detail: 'Could not inspect stopped log',
      });
      process.exitCode = 1;
    }
    fs.rmSync(running.configPath, { force: true });
  }
  evidence.finishedAt = new Date().toISOString();
  let report = JSON.stringify(evidence, null, 2);
  for (const secret of secrets.filter(Boolean))
    report = report.replaceAll(secret, '[redacted]');
  fs.writeFileSync(path.join(output, 'results.json'), report);
  for (const item of [...evidence.checks, ...evidence.scenarios])
    console.log(`${item.status} ${item.id}`);
  if (evidence.error)
    console.error('Runtime verification stopped; see sanitized artifact.');
  console.log(`Runtime evidence: ${path.join(output, 'results.json')}`);
}
