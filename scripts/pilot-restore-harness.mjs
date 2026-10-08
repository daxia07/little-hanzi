import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { server } from './qa-server.mjs';
import { localD1 } from './pilot-local-db.mjs';
import {
  backupPilot,
  readPilotBackup,
  restorePilot,
  pilotBackupFormatForCandidate,
  PILOT_V4_TABLES,
} from './pilot-backup.mjs';

import { collectionTableNames } from './pilot-collection-backup.mjs';

const FORMAT_V1 = 'pilot-admin-backup-1';
const FORMAT_V2 = 'pilot-admin-backup-2';
const FORMAT_V3 = 'pilot-admin-backup-3';
const FORMAT_V4 = 'pilot-admin-backup-4';
const FORMAT_V5 = 'pilot-admin-backup-5';
const TABLES = [
  'pilot_auth_user',
  'pilot_auth_account',
  'pilot_auth_rate_limit',
  'pilot_parent_child',
  'pilot_teacher_grant',
  'pilot_account_audit',
  'pilot_onboarding',
  'pilot_assignment',
  'pilot_run_ownership',
  'pilot_learning_release',
  'pilot_learning_run',
  'pilot_learning_event',
  'pilot_learning_audit',
];
const REGISTRY_TABLES = [
  'pilot_curriculum_registry_state',
  'pilot_curriculum_package',
  'pilot_curriculum_character',
  'pilot_curriculum_review',
  'pilot_curriculum_audit',
];
const RUNTIME_TABLES = [
  'pilot_curriculum_runtime_run',
  'pilot_curriculum_runtime_event',
  'pilot_curriculum_runtime_audit',
];
const TABLES_BY_FORMAT = Object.freeze({
  [FORMAT_V1]: Object.freeze([...TABLES]),
  [FORMAT_V2]: Object.freeze([...TABLES, ...REGISTRY_TABLES]),
  [FORMAT_V3]: Object.freeze([
    ...TABLES,
    ...REGISTRY_TABLES,
    ...RUNTIME_TABLES,
  ]),
  [FORMAT_V4]: Object.freeze([...PILOT_V4_TABLES]),
});
export function restoreFormatProfile(format) {
  const tables =
    format === FORMAT_V5
      ? Object.freeze(collectionTableNames())
      : TABLES_BY_FORMAT[format];
  if (!tables) throw new Error('Unsupported restore harness format');
  return {
    tables,
    curriculum: [FORMAT_V2, FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format),
    runtime: [FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(format),
    story: [FORMAT_V4, FORMAT_V5].includes(format),
    collection: format === FORMAT_V5,
  };
}
const TOKEN_COLUMNS = [
  'access_token',
  'refresh_token',
  'id_token',
  'access_token_expires_at',
  'refresh_token_expires_at',
  'scope',
];
const ORDER = {
  pilot_parent_child: 'parent_id,child_id',
  pilot_teacher_grant: 'child_id,teacher_id,granting_parent_id',
  pilot_onboarding: 'child_id',
  pilot_assignment: 'child_id,lesson_version',
  pilot_run_ownership: 'run_id',
  pilot_learning_release: 'lesson_version',
  pilot_learning_run: 'run_id',
  pilot_learning_event: 'run_id,event_id',
  pilot_curriculum_registry_state: 'id',
  pilot_curriculum_package: 'lesson_version',
  pilot_curriculum_character: 'lesson_version,character_index',
  pilot_curriculum_review: 'lesson_version,review_sequence',
  pilot_curriculum_audit: 'id',
  pilot_curriculum_runtime_run: 'run_id',
  pilot_curriculum_runtime_event: 'run_id,sequence',
  pilot_curriculum_runtime_audit: 'run_id,revision',
  pilot_curriculum_trial_member: 'publication_id,child_id',
  pilot_curriculum_publication_state: 'installation_id,lesson_version',
  pilot_collection: 'collection_version',
  pilot_collection_item: 'collection_version,ordinal',
  pilot_collection_event: 'run_id,sequence',
};
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Disposable integration fixtures only; never imported by the application. */
export function restoreHarness({
  manifest,
  running,
  db,
  accounts,
  authSecret,
  token,
  output,
  name,
  historicalSchema,
}) {
  const format = pilotBackupFormatForCandidate(manifest, { historicalSchema });
  const { curriculum, runtime } = restoreFormatProfile(format);
  const destinations = new Map();
  const artifacts = new Map();
  const privateDirectory = path.join(manifest.work, 'private-backups');
  const sourceTarget = {
    manifest,
    historicalSchema,
    db,
    format,
    configPath: running.configPath,
    state: running.state,
  };
  const artifact = (id) => {
    const item = artifacts.get(id);
    if (!item) throw new Error('Unknown private backup fixture');
    return item;
  };
  const destination = (id) => {
    const item = destinations.get(id);
    if (!item) throw new Error('Unknown restore destination fixture');
    return item;
  };
  const queryRows = (target, query) => target.query(query)[0].results;
  const selected = (id) => (id === 'source' ? sourceTarget : destination(id));
  const freshFault = (kind = null) => ({
    kind,
    batchObserved: 0,
    injected: 0,
    committed: 0,
  });

  function decorateDatabase(target) {
    return (real) => ({
      ...real,
      query(sql) {
        const fault = target.fault;
        if (sql.includes('CREATE TABLE pilot_restore_guard')) {
          fault.batchObserved++;
          const trigger =
            fault.kind === 'runtime-event'
              ? "CREATE TRIGGER pilot_restore_runtime_event_fault BEFORE INSERT ON pilot_curriculum_runtime_event BEGIN SELECT RAISE(ABORT,'synthetic runtime event restore fault'); END;"
              : fault.kind === 'runtime-audit'
                ? "CREATE TRIGGER pilot_restore_runtime_audit_fault BEFORE INSERT ON pilot_curriculum_runtime_audit BEGIN SELECT RAISE(ABORT,'synthetic runtime audit restore fault'); END;"
                : fault.kind === 'curriculum-audit'
                  ? "CREATE TRIGGER pilot_restore_fault BEFORE INSERT ON pilot_curriculum_audit BEGIN SELECT RAISE(ABORT,'synthetic restore fault'); END;"
                  : null;
          if (trigger) {
            fault.injected++;
            return real.query(`${trigger}\n${sql}`);
          }
          const result = real.query(sql);
          fault.committed++;
          return result;
        }
        if (
          (fault.kind === 'postcommit-read' ||
            fault.kind === 'postcommitread') &&
          fault.committed > 0
        ) {
          fault.injected++;
          throw new Error('Synthetic postcommit verification failure');
        }
        return real.query(sql);
      },
    });
  }

  function inspect(targetId = 'source') {
    const target = selected(targetId);
    const selectedTables = restoreFormatProfile(target.format).tables;
    if (!selectedTables)
      throw new Error('Unsupported restore inspection format');
    const result = target.db.query(
      [
        ...selectedTables.map(
          (table) => `SELECT * FROM ${table} ORDER BY ${ORDER[table] || 'id'};`,
        ),
        'SELECT installation_id FROM pilot_installation WHERE id=1;',
        'SELECT * FROM pilot_auth_session;',
        'SELECT * FROM pilot_auth_verification;',
        "SELECT name FROM sqlite_master WHERE name='pilot_restore_guard';",
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name LIKE 'pilot_%' AND type IN ('table','index','trigger') ORDER BY type,name;",
        'SELECT * FROM pilot_schema_history ORDER BY version;',
        'SELECT * FROM pilot_d1_migrations ORDER BY name;',
        'PRAGMA foreign_key_check;',
      ].join('\n'),
    );
    const captured = Object.fromEntries(
      selectedTables.map((table, index) => [
        table,
        result[index].results.map((row) => {
          if (table !== 'pilot_auth_account') return row;
          return Object.fromEntries(
            Object.entries(row).filter(([key]) => !TOKEN_COLUMNS.includes(key)),
          );
        }),
      ]),
    );
    return {
      installationId: result[selectedTables.length].results[0].installation_id,
      tables: captured,
      format: target.format,
      sessions: result[selectedTables.length + 1].results,
      verification: result[selectedTables.length + 2].results,
      restoreGuardExists:
        result[selectedTables.length + 3].results.length !== 0,
      schemaObjects: result[selectedTables.length + 4].results,
      migrations: {
        history: result[selectedTables.length + 5].results,
        applied: result[selectedTables.length + 6].results,
      },
      foreignKeyViolations: result[selectedTables.length + 7].results,
      fault: { ...(target.fault || freshFault()) },
    };
  }

  const context = {
    source: {
      baseURL: running.baseURL,
      accounts,
      testRunId: running.testRunId,
      candidateId: manifest.candidateId,
      format,
    },
    backup: async ({ name: label, sourceId = 'source' }) => {
      if (!/^[a-z0-9-]{1,50}$/.test(label))
        throw new Error('Invalid backup fixture name');
      const target = selected(sourceId);
      const directory = path.join(target.manifest.work, 'private-backups');
      const filePath = path.join(directory, `${name}-${label}.json`);
      const summary = await backupPilot({
        manifest: target.manifest,
        historicalSchema: target.historicalSchema,
        configPath: target.configPath,
        state: target.state,
        filePath,
      });
      artifacts.set(label, filePath);
      return {
        id: label,
        summary,
        fileMode: fs.statSync(filePath).mode & 0o777,
        directoryMode: fs.statSync(directory).mode & 0o777,
      };
    },
    readBackup: async (id) => readPilotBackup(artifact(id)),
    writeBackupVariant: async (id, { kind }) => {
      const envelope = readPilotBackup(artifact(id));
      if (kind === 'checksum') envelope.sha256 = '0'.repeat(64);
      else if (kind === 'migration')
        envelope.payload.migrations[0].sha256 = '0'.repeat(64);
      else if (kind === 'schema') {
        envelope.payload.schema[0].sql +=
          ' /* deliberately incompatible schema */';
        envelope.payload.schemaDigest = hash(envelope.payload.schema);
      } else if (kind === 'content') {
        if (curriculum)
          envelope.payload.contentIdentities.legacy['forest-01-v1'].digest =
            '0'.repeat(64);
        else envelope.payload.contentVersions['forest-01-v1'] = '0'.repeat(64);
      } else if (kind === 'release-digest')
        envelope.payload.tables.pilot_learning_release[0].content_digest =
          '0'.repeat(64);
      else if (kind === 'value-type')
        envelope.payload.tables.pilot_auth_user[0].created_at = String(
          envelope.payload.tables.pilot_auth_user[0].created_at,
        );
      else if (kind === 'row-order') {
        for (const table of Object.values(envelope.payload.tables))
          table.reverse();
      } else if (kind === 'provider')
        envelope.payload.tables.pilot_auth_account[0].provider_id =
          'unsupported-synthetic';
      else if (kind === 'json')
        envelope.payload.tables.pilot_learning_run[0].state_json = '{invalid';
      else if (kind === 'foreign-key') {
        if (!envelope.payload.tables.pilot_learning_audit.length)
          throw new Error('Late import fault requires saved learning audit');
        envelope.payload.tables.pilot_learning_audit.at(-1).child_id =
          'missing-synthetic-child';
      } else if (kind === 'manifest')
        envelope.payload.tables.pilot_curriculum_package[0].manifest_json +=
          ' ';
      else if (kind === 'review-chain')
        envelope.payload.tables.pilot_curriculum_review[1].previous_review_id =
          'missing-synthetic-review';
      else if (kind === 'audit-time')
        envelope.payload.tables.pilot_curriculum_audit[0].created_at += 1;
      else if (kind === 'revision')
        envelope.payload.tables.pilot_curriculum_registry_state[0].revision += 1;
      else if (['runtime-run-identity', 'run-identity'].includes(kind)) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_run?.[0];
        if (!row) throw new Error('Runtime identity fixture requires a run');
        const value = JSON.parse(row.run_json);
        value.runId = `${value.runId}-changed`;
        row.run_json = JSON.stringify(value);
      } else if (['runtime-run-revision', 'run-revision'].includes(kind)) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_run?.[0];
        if (!row) throw new Error('Runtime revision fixture requires a run');
        row.revision += 1;
      } else if (
        ['runtime-request-fingerprint', 'request-fingerprint'].includes(kind)
      ) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_run?.[0];
        if (!row) throw new Error('Runtime request fixture requires a run');
        row.request_digest = `sha256:${'0'.repeat(64)}`;
      } else if (['runtime-event-time', 'event-time'].includes(kind)) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_event?.[0];
        if (!row)
          throw new Error('Runtime event-time fixture requires an event');
        row.created_at += 1;
      } else if (['runtime-event-sequence', 'event-sequence'].includes(kind)) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_event?.[0];
        if (!row)
          throw new Error('Runtime event-sequence fixture requires an event');
        row.sequence = 999;
      } else if (['runtime-event-result', 'event-result'].includes(kind)) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_event?.[0];
        if (!row)
          throw new Error('Runtime event-result fixture requires an event');
        const value = JSON.parse(row.event_json);
        value.result.outcome =
          value.result.outcome === 'correct' ? 'incorrect' : 'correct';
        value.ack.result.outcome = value.result.outcome;
        row.event_json = JSON.stringify(value);
      } else if (kind === 'runtime-schema') {
        const table = envelope.payload.schema?.find(
          (item) =>
            item.type === 'table' &&
            item.name === 'pilot_curriculum_runtime_run' &&
            item.tbl_name === 'pilot_curriculum_runtime_run',
        );
        if (!table)
          throw new Error('Runtime schema fixture requires a v3 schema');
        table.sql = 'CREATE TABLE pilot_curriculum_runtime_run (run_id,run_id)';
        envelope.payload.schemaDigest = hash(envelope.payload.schema);
      } else if (['runtime-audit-relation', 'audit-relation'].includes(kind)) {
        const row =
          envelope.payload.tables.pilot_curriculum_runtime_audit?.find(
            (item) => item.action === 'action',
          );
        if (!row)
          throw new Error(
            'Runtime audit relation fixture requires an action audit',
          );
        row.event_id = 'missing-runtime-event';
      } else if (['runtime-audit-time'].includes(kind)) {
        const row = envelope.payload.tables.pilot_curriculum_runtime_audit?.[0];
        if (!row)
          throw new Error('Runtime audit-time fixture requires an audit');
        row.created_at += 1;
      } else if (['runtime-missing-event', 'missing-event'].includes(kind)) {
        const events = envelope.payload.tables.pilot_curriculum_runtime_event;
        if (!events?.length)
          throw new Error('Runtime missing-event fixture requires an event');
        events.pop();
      } else if (['extra-proof', 'runtime-proof'].includes(kind))
        envelope.payload.tables.pilot_curriculum_runtime_proof = [];
      else if (['extra-release', 'runtime-release'].includes(kind))
        envelope.payload.tables.pilot_curriculum_release = [];
      else if (kind === 'unknown-proof')
        envelope.payload.tables.pilot_curriculum_runtime_proof = [];
      else if (kind === 'unknown-release')
        envelope.payload.tables.pilot_curriculum_release = [];
      else if (kind !== 'malformed-json')
        throw new Error('Unknown backup corruption fixture');
      if (kind !== 'checksum') envelope.sha256 = hash(envelope.payload);
      const key = `${id}-${kind}-${crypto.randomUUID()}`;
      const filePath = path.join(privateDirectory, `${key}.json`);
      fs.writeFileSync(
        filePath,
        kind === 'malformed-json' ? '{invalid' : JSON.stringify(envelope),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      artifacts.set(key, filePath);
      return key;
    },
    createDestination: async ({ format: requestedFormat } = {}) => {
      if (![undefined, 'v1', 'v2', 'v3', 'v4', 'v5'].includes(requestedFormat))
        throw new Error('Unknown schema fixture format');
      if (requestedFormat === 'v3' && !runtime)
        throw new Error('A v3 destination requires a v3 candidate');
      if (requestedFormat === 'v4' && ![FORMAT_V4, FORMAT_V5].includes(format))
        throw new Error('A v4 destination requires a v4 candidate');
      if (requestedFormat === 'v5' && format !== FORMAT_V5)
        throw new Error('A v5 destination requires a v5 candidate');
      const id = `destination-${destinations.size + 1}`;
      const requestedFullFormat =
        requestedFormat === undefined
          ? undefined
          : {
              v1: FORMAT_V1,
              v2: FORMAT_V2,
              v3: FORMAT_V3,
              v4: FORMAT_V4,
              v5: FORMAT_V5,
            }[requestedFormat];
      const currentDestination =
        requestedFullFormat === undefined || requestedFullFormat === format;
      if (
        !currentDestination &&
        ['v1', 'v2', 'v3', 'v4'].includes(requestedFormat)
      ) {
        const work = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-legacy-schema-')),
        );
        fs.chmodSync(work, 0o700);
        fs.writeFileSync(
          path.join(work, '.hanzi-qa-owned'),
          'Synthetic legacy schema fixture\n',
          { mode: 0o600 },
        );
        const snapshot = path.join(work, 'snapshot');
        const state = path.join(work, 'state');
        fs.mkdirSync(state, { mode: 0o700 });
        const lastMigration =
          requestedFormat === 'v1'
            ? 2
            : requestedFormat === 'v2'
              ? 3
              : requestedFormat === 'v3'
                ? 4
                : 5;
        const files = fs
          .readdirSync(path.join(manifest.snapshot, 'db/pilot-migrations'))
          .filter((file) => /^000[0-5]-.+\.sql$/.test(file))
          .filter((file) => Number(file.slice(0, 4)) <= lastMigration)
          .sort();
        if (files.length !== lastMigration + 1)
          throw new Error(
            `Schema fixture needs migrations through 000${lastMigration}`,
          );
        const migrationFiles = files.map(
          (file) => `db/pilot-migrations/${file}`,
        );
        const schemaFiles = [
          ...migrationFiles,
          'lib/preview/content.ts',
          'lib/preview/types.ts',
        ];
        for (const file of schemaFiles) {
          const to = path.join(snapshot, file);
          fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
          fs.copyFileSync(path.join(manifest.snapshot, file), to);
        }
        fs.symlinkSync(
          path.join(manifest.snapshot, 'node_modules'),
          path.join(snapshot, 'node_modules'),
          'dir',
        );
        const configPath = path.join(snapshot, 'wrangler.json');
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            name: 'hanzi-legacy-schema',
            compatibility_date: '2026-09-25',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'hanzi-legacy-schema',
                database_id: '00000000-0000-4000-8000-000000000000',
              },
            ],
          }),
          { mode: 0o600 },
        );
        const legacyManifest = {
          ...manifest,
          candidateId: `${manifest.candidateId}-${requestedFormat}-schema-fixture`,
          work,
          snapshot,
          buildState: state,
          files: schemaFiles,
          specVersion: 's2-spec-1',
        };
        const target = localD1(legacyManifest, { configPath, state });
        target.migrate();
        const destinationFormat = requestedFullFormat;
        destinations.set(id, {
          process: null,
          db: target,
          manifest: legacyManifest,
          configPath,
          state,
          format: destinationFormat,
          fault: freshFault(),
        });
        return { id, baseURL: null, format: destinationFormat };
      }
      let target;
      const process = await server(manifest, {
        name: `${name}-${id}`,
        testing: true,
        token,
        pilot: true,
        pilotTestContent: true,
        authSecret,
        output,
        beforeStart: (options) => {
          target = localD1(manifest, { ...options, historicalSchema });
          target.migrate();
        },
      });
      destinations.set(id, {
        process,
        historicalSchema,
        db: target,
        manifest,
        configPath: process.configPath,
        state: process.state,
        format,
        testRunId: process.testRunId,
        candidateId: manifest.candidateId,
        fault: freshFault(),
      });
      return { id, baseURL: process.baseURL, format };
    },
    setRestoreFault: async ({ destinationId, kind }) => {
      const target = destination(destinationId);
      const allowed = [FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(target.format)
        ? [
            null,
            'runtime-event',
            'runtime-audit',
            'curriculum-audit',
            'postcommit-read',
            'postcommitread',
          ]
        : target.format === FORMAT_V2
          ? [null, 'curriculum-audit', 'postcommit-read']
          : [null];
      if (!allowed.includes(kind))
        throw new Error('Invalid owned restore fault fixture');
      target.fault = freshFault(kind);
    },
    setRuntimeNamespace: async ({ destinationId }) => {
      const target = destination(destinationId);
      if (
        ![FORMAT_V3, FORMAT_V4, FORMAT_V5].includes(target.format) ||
        !target.process
      )
        throw new Error('Runtime namespace requires a v3 Worker destination');
      const config = JSON.parse(fs.readFileSync(target.configPath, 'utf8'));
      await target.process.stop();
      config.vars.HANZI_TEST_RUN_ID = running.testRunId;
      config.vars.HANZI_CANDIDATE_ID = manifest.candidateId;
      fs.writeFileSync(target.configPath, JSON.stringify(config), {
        mode: 0o600,
      });
      await target.process.restart({
        expectedCandidateId: manifest.candidateId,
      });
      target.testRunId = running.testRunId;
      target.candidateId = manifest.candidateId;
      const health = await fetch(`${target.process.baseURL}/api/pilot/health`, {
        headers: { Connection: 'close' },
      });
      if (
        !health.ok ||
        (await health.json()).candidateId !== manifest.candidateId
      )
        throw new Error('Runtime destination namespace health check failed');
    },
    setSourceClock: async (now) => {
      if (
        now !== null &&
        (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
      )
        throw new Error('Invalid source runtime clock');
      const config = JSON.parse(fs.readFileSync(running.configPath, 'utf8'));
      const value = now === null ? '' : String(now);
      if ((config.vars.HANZI_CURRICULUM_TEST_NOW ?? '') === value) return;
      await running.stop();
      config.vars.HANZI_CURRICULUM_TEST_NOW = value;
      fs.writeFileSync(running.configPath, JSON.stringify(config), {
        mode: 0o600,
      });
      await running.restart({ expectedCandidateId: manifest.candidateId });
    },
    restore: async ({ backupId, destinationId }) => {
      const target = destination(destinationId);
      target.fault = freshFault(target.fault.kind);
      if (target.process) await target.process.stop();
      try {
        return await restorePilot(
          {
            manifest: target.manifest,
            historicalSchema: target.historicalSchema,
            configPath: target.configPath,
            state: target.state,
            filePath: artifact(backupId),
          },
          { decorateDatabase: decorateDatabase(target) },
        );
      } finally {
        // Restore under maintenance, then await the owned Worker's health check
        // before exposing its result to ordinary HTTP verification.
        if (target.process) await target.process.restart();
      }
    },
    inspect: async (targetId) => inspect(targetId),
    fingerprintSource: async () => hash(inspect()),
  };

  async function close() {
    const checks = [];
    const secrets = [
      token,
      authSecret,
      ...Object.values(accounts).map((account) => account.password),
    ];
    for (const row of queryRows(
      db,
      'SELECT password FROM pilot_auth_account WHERE password IS NOT NULL;',
    ))
      secrets.push(row.password);
    for (const [id, target] of destinations) {
      if (!target.process) {
        // Retain private diagnostic state like other owned QA installations.
        // The tree is 0700 and is never copied into shareable evidence.
        checks.push({
          id: `S2-RESTORE-LOGS-${id}`,
          status: 'PASS',
          detail:
            'Owned legacy schema fixture has no Worker or HTTP log; private data retained outside reports',
        });
        continue;
      }
      await target.process.stop();
      try {
        const privateValues = [
          ...secrets,
          ...queryRows(target.db, 'SELECT token FROM pilot_auth_session;').map(
            (row) => row.token,
          ),
        ];
        const file = path.join(output, `${name}-${id}-server.log`);
        const text = fs.readFileSync(file, 'utf8');
        const sensitiveLine = (line) =>
          /(?:session_token=|["'](?:password|token|secret)["']\s*:)/i.test(
            line,
          );
        const leaked =
          privateValues.some((value) => value && text.includes(value)) ||
          sensitiveLine(text);
        let safe = text;
        for (const value of privateValues.filter(Boolean))
          safe = safe.replaceAll(value, '[redacted]');
        safe = safe
          .split('\n')
          .map((line) =>
            sensitiveLine(line)
              ? '[credential-bearing log line redacted]'
              : line,
          )
          .join('\n');
        fs.writeFileSync(file, safe);
        checks.push({
          id: `S2-RESTORE-LOGS-${id}`,
          status: leaked ? 'FAIL' : 'PASS',
          detail:
            'Stopped restore destination log inspected and private fixture values excluded',
        });
      } catch {
        checks.push({
          id: `S2-RESTORE-LOGS-${id}`,
          status: 'BLOCKED',
          detail: 'Restore destination log inspection could not complete',
        });
      } finally {
        fs.rmSync(target.process.configPath, { force: true });
      }
    }
    return checks;
  }
  return { context, close };
}
