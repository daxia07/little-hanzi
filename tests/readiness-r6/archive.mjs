import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { withOwnedCorpusFixture } from '../../scripts/readiness-corpus-bootstrap.mjs';
import { populateCorpusVisits } from '../helpers/corpus-populated-fixture.mjs';
import { applyLibsqlMigrations } from '../../scripts/pilot-libsql-admin.mjs';
import * as api from '../../scripts/pilot-corpus-libsql-backup.mjs';
import { createLibsqlD1Database } from '../../lib/platform/libsql-d1.ts';
import {
  corpusProgress,
  corpusPlans,
  getCorpusRun,
  startCorpus,
} from '../../lib/pilot/corpus-learning-store.ts';
import { validatePilotCollectionBackup } from '../../scripts/pilot-collection-backup.mjs';
import { validatePilotStoryBackup } from '../../scripts/pilot-backup.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const output = process.argv[2];
const results = [];
const hash = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const normalized = (tables) =>
  Object.fromEntries(
    Object.entries(tables)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, rows]) => [
        name,
        rows
          .map((r) =>
            JSON.stringify(
              Object.entries(r).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
            ),
          )
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
  );
async function record(id, fn) {
  if (process.argv[3] && id !== process.argv[3] && id !== 'AC601') return;
  const t = Date.now();
  try {
    const details = await fn();
    results.push({ id, outcome: 'PASS', elapsedMs: Date.now() - t, details });
  } catch (e) {
    results.push({
      id,
      outcome: 'FAIL',
      elapsedMs: Date.now() - t,
      error: e.code ?? e.message,
    });
  }
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        method:
          'fresh embedded libSQL; actual persisted synthetic factory visits; no HTTP',
        cases: results,
      },
      null,
      2,
    ),
  );
}
async function destination(fn) {
  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hanzi-r6-qa-destination-'),
  );
  fs.writeFileSync(
    path.join(work, '.hanzi-qa-owned'),
    'independent archive destination',
  );
  const client = createClient({ url: 'file:' + path.join(work, 'db') });
  try {
    await applyLibsqlMigrations({ client, root });
    const installationId = (
      await client.execute(
        'SELECT installation_id FROM pilot_installation WHERE id=1',
      )
    ).rows[0].installation_id;
    return await fn(client, installationId);
  } finally {
    client.close();
    fs.rmSync(work, { recursive: true });
  }
}
await withOwnedCorpusFixture('draft-corpus', async (f) => {
  const facts = await populateCorpusVisits(f);
  let archive;
  await record('AC601', async () => {
    archive = await api.createCorpusBackupPayload({
      sourceRoot: root,
      candidateId: f.config.candidateId,
      client: f.client,
      installationId: f.installationId,
      createdAtMs: facts.at,
    });
    assert.equal(Object.keys(archive.payload.tables).length, 67);
    assert.equal(archive.sha256, hash(archive.payload));
    assert.equal(archive.payload.migrations.length, 8);
    for (const n of [
      'pilot_auth_session',
      'pilot_auth_verification',
      'pilot_corpus_evidence_epoch',
      'pilot_installation',
    ])
      assert(!Object.hasOwn(archive.payload.tables, n));
    assert.equal(archive.payload.tables.pilot_corpus_run.length, 3);
    return {
      tableCount: 67,
      bytes: Buffer.byteLength(JSON.stringify(archive)),
      savedVisits: 3,
    };
  });
  if (!archive) return;
  await record('AC603', () =>
    destination(async (client, installationId) => {
      const result = await api.restoreCorpusBackupPayload({
        sourceRoot: root,
        archive,
        client,
        installationId,
      });
      assert.equal(result.commit, 'confirmed');
      const captured = await api.captureCorpusLibsql(client, installationId);
      assert.deepEqual(
        normalized(captured.tables),
        normalized(archive.payload.tables),
      );
      assert.notEqual(installationId, f.installationId);
      assert.equal(captured.sessionCount, 0);
      assert.equal(captured.verificationCount, 0);
      const db = createLibsqlD1Database(client);
      const config = {
        ...f.config,
        corpus: { ownerIds: [], fixtureBinding: null, capability: null },
        curriculumTrust: null,
        curriculumTestNow: String(facts.at),
      };
      const c = (id) => ({
        ...f.context(id),
        db,
        config,
        corpus: { ownerIds: [], fixtureBinding: null, capability: null },
      });
      await assert.rejects(
        () => corpusProgress(c('r6-parent'), 'r6-child'),
        (e) =>
          e.status === 401 || e.statusCode === 401 || e.code === 'UNAUTHORIZED',
      );
      for (const id of ['r6-parent', 'r6-child'])
        await client.execute({
          sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
          args: [
            'session-' + id,
            facts.at + 86400000,
            'fresh-' + id,
            facts.at,
            facts.at,
            id,
          ],
        });
      const progress = await corpusProgress(c('r6-parent'), 'r6-child');
      assert(JSON.stringify(progress).includes(f.installationId));
      assert.equal(
        (await corpusPlans(c('r6-child'), 'r6-child', f.manifest.corpusVersion))
          .plan,
        null,
      );
      const historical = await getCorpusRun(c('r6-child'), facts.runIds[0]);
      assert.equal(historical.available, false);
      assert.equal(historical.canContinue, false);
      const slot = archive.payload.tables.pilot_corpus_schedule[0];
      await assert.rejects(
        () =>
          startCorpus(c('r6-child'), facts.assignmentId, {
            requestId: 'fresh-restore-start',
            scheduleId: slot.id,
          }),
        (e) => e.code === 'NOT_FOUND',
      );
      return {
        commit: result.commit,
        exactTables: 67,
        newInstallation: true,
        oldSessionDenied: true,
        historicalParentRead: true,
      };
    }),
  );
  await record('AC604', async () => {
    const variants = [
      (a) => (a.sha256 = '0'.repeat(64)),
      (a) => {
        a.payload.tables.pilot_corpus_event.pop();
        a.sha256 = hash(a.payload);
      },
      (a) => {
        a.payload.format = 'pilot-admin-backup-7';
        a.sha256 = hash(a.payload);
      },
    ];
    const codes = [];
    for (const mutate of variants) {
      const a = structuredClone(archive);
      mutate(a);
      let calls = 0;
      await assert.rejects(
        () =>
          api.restoreCorpusBackupPayload({
            sourceRoot: root,
            archive: a,
            installationId: 'fresh-unopened',
            client: {
              execute() {
                calls++;
              },
              batch() {
                calls++;
              },
            },
          }),
        (e) => {
          codes.push(e.code ?? e.message);
          return true;
        },
      );
      assert.equal(calls, 0);
    }
    return { variants: 3, destinationCalls: 0, codes };
  });
  await record('AC605', () =>
    destination(async (client, installationId) => {
      const before = await api.captureCorpusLibsql(client, installationId);
      let faults = 0,
        engine = null;
      await assert.rejects(
        () =>
          api.restoreCorpusBackupPayload(
            { sourceRoot: root, archive, client, installationId },
            {
              decorateClient: (real) => ({
                execute: real.execute.bind(real),
                batch: async (s, m) => {
                  faults++;
                  try {
                    return await real.batch(
                      [
                        ...s,
                        {
                          sql: 'INSERT INTO pilot_corpus_evidence_epoch(id,revision,updated_at) VALUES(1,0,0)',
                          args: [],
                        },
                      ],
                      m,
                    );
                  } catch (e) {
                    engine = e.code;
                    throw e;
                  }
                },
              }),
            },
          ),
        /RESTORE_NOT_COMMITTED/,
      );
      assert.equal(faults, 1);
      assert.match(engine, /SQLITE_CONSTRAINT/);
      assert.deepEqual(
        normalized(
          (await api.captureCorpusLibsql(client, installationId)).tables,
        ),
        normalized(before.tables),
      );
      let lost = 0;
      const result = await api.restoreCorpusBackupPayload(
        { sourceRoot: root, archive, client, installationId },
        {
          decorateClient: (real) => ({
            execute: real.execute.bind(real),
            batch: async (s, m) => {
              lost++;
              await real.batch(s, m);
              throw Error('isolated accepted ACK lost');
            },
          }),
        },
      );
      assert.equal(lost, 1);
      assert.equal(result.commit, 'confirmed-after-uncertainty');
      assert.deepEqual(
        normalized(
          (await api.captureCorpusLibsql(client, installationId)).tables,
        ),
        normalized(archive.payload.tables),
      );
      return { faults, engine, lost, commit: result.commit };
    }),
  );
  await record('AC606-old-parser', async () => {
    await assert.rejects(() => validatePilotCollectionBackup(archive.payload));
    await assert.rejects(() => validatePilotStoryBackup(archive.payload));
    return { oldParsersRejectV6: 2 };
  });
});
if (results.some((r) => r.outcome !== 'PASS')) process.exitCode = 1;
