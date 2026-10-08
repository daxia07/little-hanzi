import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { applyLibsqlMigrations } from '../scripts/pilot-libsql-admin.mjs';
import { withOwnedCorpusFixture } from '../scripts/readiness-corpus-bootstrap.mjs';
import { populateCorpusVisits } from './helpers/corpus-populated-fixture.mjs';
import { corpusColumns } from '../scripts/pilot-corpus-backup.mjs';
import * as old from '../scripts/pilot-collection-libsql-backup.mjs';
const root = path.resolve(import.meta.dirname, '..');
const next = new URL(
  '../scripts/pilot-corpus-libsql-backup.mjs',
  import.meta.url,
);
const api = fs.existsSync(next)
  ? await import(next.href)
  : {
      createCorpusBackupPayload: old.createCollectionBackupPayload,
      captureCorpusLibsql: old.captureCollectionLibsql,
      restoreCorpusBackupPayload: old.restoreCollectionBackupPayload,
    };
const digest = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const tableDigest = (t) =>
  digest(
    Object.entries(corpusColumns()).map(([name, cols]) => [
      name,
      t[name].map((r) => JSON.stringify(cols.map((c) => r[c]))).sort(),
    ]),
  );
async function target(fn) {
  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hanzi-r6-restore-target-'),
  );
  fs.writeFileSync(
    path.join(work, '.hanzi-qa-owned'),
    'R6 author isolated restore target',
  );
  const client = createClient({ url: 'file:' + path.join(work, 'fresh.db') });
  try {
    const applied = await applyLibsqlMigrations({ client, root });
    assert.equal(applied.migrationCount, 8);
    const installationId = (
      await client.execute(
        'SELECT installation_id FROM pilot_installation WHERE id=1',
      )
    ).rows[0].installation_id;
    return await fn({ client, installationId });
  } finally {
    client.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
test('[R6-E-013/015] exact reviewed eight-migration source is installed only in a fresh owned destination', async () => {
  await target(async ({ client }) =>
    assert.equal(
      (await client.execute('SELECT COUNT(*) AS n FROM pilot_schema_history'))
        .rows[0].n,
      8,
    ),
  );
});
test('[R6-E-013] actual three visits and withdrawn generation capture67 tables and replay constrained projections into a fresh installation', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const facts = await populateCorpusVisits(f);
    const archive = await api.createCorpusBackupPayload({
      sourceRoot: root,
      candidateId: f.config.candidateId,
      client: f.client,
      installationId: f.installationId,
      createdAtMs: facts.at,
    });
    assert.equal(archive.payload.format, 'pilot-admin-backup-6');
    assert.equal(Object.keys(archive.payload.tables).length, 67);
    assert.equal(archive.payload.tables.pilot_corpus_run.length, 3);
    assert.equal(archive.payload.tables.pilot_corpus_schedule.length, 3);
    assert.equal(archive.payload.tables.pilot_corpus_publication.length, 2);
    for (const excluded of [
      'pilot_auth_session',
      'pilot_auth_verification',
      'pilot_corpus_evidence_epoch',
      'pilot_installation',
    ])
      assert(!Object.hasOwn(archive.payload.tables, excluded));
    await target(async ({ client, installationId }) => {
      const result = await api.restoreCorpusBackupPayload({
        sourceRoot: root,
        archive,
        client,
        installationId,
      });
      assert.equal(result.commit, 'confirmed');
      const after = await api.captureCorpusLibsql(client, installationId);
      assert.equal(
        tableDigest(after.tables),
        tableDigest(archive.payload.tables),
      );
      assert.equal(after.sessionCount, 0);
      assert.equal(after.verificationCount, 0);
      assert.equal(
        (await client.execute('PRAGMA foreign_key_check')).rows.length,
        0,
      );
      assert.equal(
        (
          await client.execute(
            'SELECT revision FROM pilot_corpus_publication_state',
          )
        ).rows[0].revision,
        2,
      );
      assert.equal(
        (
          await client.execute(
            'SELECT count(*) AS n FROM pilot_corpus_run WHERE completed_at IS NOT NULL',
          )
        ).rows[0].n,
        3,
      );
      assert.notEqual(installationId, f.installationId);
      await assert.rejects(
        () =>
          api.restoreCorpusBackupPayload({
            sourceRoot: root,
            archive,
            client,
            installationId,
          }),
        /RESTORE_DESTINATION_NOT_FRESH/,
      );
    });
    for (const corrupt of [
      (a) => {
        a.sha256 = '0'.repeat(64);
      },
      (a) => {
        a.payload.tables.pilot_corpus_event.pop();
        a.sha256 = digest(a.payload);
      },
      (a) => {
        a.payload.format = 'pilot-admin-backup-7';
        a.sha256 = digest(a.payload);
      },
      (a) => {
        a.payload.sourceInstallationId = 'I'.repeat(241);
        a.sha256 = digest(a.payload);
      },
    ]) {
      const copy = structuredClone(archive);
      corrupt(copy);
      let calls = 0;
      await assert.rejects(() =>
        api.restoreCorpusBackupPayload({
          sourceRoot: root,
          archive: copy,
          client: {
            execute() {
              calls++;
            },
            batch() {
              calls++;
            },
          },
          installationId: 'unqueried-new-install',
        }),
      );
      assert.equal(calls, 0, 'all source checks precede destination I/O');
    }
  });
});
test('[R6-E-013] real terminal SQL refusal rolls back every table and lost acknowledgment probes exact committed history', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await populateCorpusVisits(f);
    const archive = await api.createCorpusBackupPayload({
      sourceRoot: root,
      candidateId: f.config.candidateId,
      client: f.client,
      installationId: f.installationId,
    });
    await target(async ({ client, installationId }) => {
      const before = await api.captureCorpusLibsql(client, installationId);
      let faults = 0;
      await assert.rejects(
        () =>
          api.restoreCorpusBackupPayload(
            { sourceRoot: root, archive, client, installationId },
            {
              decorateClient: (real) => ({
                execute: real.execute.bind(real),
                batch: async (statements, mode) => {
                  faults++;
                  return real.batch(
                    [
                      ...statements,
                      {
                        sql: 'INSERT INTO pilot_corpus_evidence_epoch(id,revision,updated_at) VALUES(1,0,0)',
                        args: [],
                      },
                    ],
                    mode,
                  );
                },
              }),
            },
          ),
        /RESTORE_NOT_COMMITTED/,
      );
      assert.equal(faults, 1);
      const unchanged = await api.captureCorpusLibsql(client, installationId);
      assert.equal(tableDigest(unchanged.tables), tableDigest(before.tables));
      assert.deepEqual(unchanged.evidenceEpoch, before.evidenceEpoch);
      let lost = 0;
      const result = await api.restoreCorpusBackupPayload(
        { sourceRoot: root, archive, client, installationId },
        {
          decorateClient: (real) => ({
            execute: real.execute.bind(real),
            batch: async (statements, mode) => {
              lost++;
              await real.batch(statements, mode);
              throw new Error('SYNTHETIC_LOST_ACK');
            },
          }),
        },
      );
      assert.equal(lost, 1);
      assert.equal(result.commit, 'confirmed-after-uncertainty');
      assert.equal(
        tableDigest(
          (await api.captureCorpusLibsql(client, installationId)).tables,
        ),
        tableDigest(archive.payload.tables),
      );
    });
  });
});
