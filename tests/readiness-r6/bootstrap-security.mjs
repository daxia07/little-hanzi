/** Actual owned factory/direct-store tests only. Execution requires frozen pins. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  withOwnedCorpusFixture,
  prepareOwnedCorpus,
  publishOwnedCorpus,
  bootstrapOwnedCorpus,
} from '../../scripts/readiness-corpus-bootstrap.mjs';
const options = { timeout: 120000 };
async function count(f, table) {
  return Number(
    (await f.client.execute('SELECT count(*) AS n FROM ' + table)).rows[0].n,
  );
}
async function authorityCounts(f) {
  const out = {};
  for (const name of [
    'pilot_corpus_publication',
    'pilot_corpus_publication_state',
    'pilot_corpus_publication_audit',
    'pilot_corpus_trial_member',
    'pilot_corpus_owner_decision',
    'pilot_corpus_proof_receipt',
    'pilot_curriculum_review',
  ])
    out[name] = await count(f, name);
  return out;
}

test(
  'BS01 same-path database replacement is refused without adopting or deleting it',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const database = path.join(f.directory, 'fresh.db'),
        original = path.join(f.directory, 'independent-original.db');
      fs.renameSync(database, original);
      fs.copyFileSync(original, database);
      try {
        await assert.rejects(
          () => prepareOwnedCorpus(f.handle),
          /CORPUS_OWNERSHIP_CHANGED/,
        );
        assert.ok(fs.existsSync(database));
      } finally {
        fs.unlinkSync(database);
        fs.renameSync(original, database);
      }
    }),
);

test(
  'BS02 foreign/copied handles and arbitrary factory options cannot confer authority',
  options,
  async () => {
    await assert.rejects(
      () => prepareOwnedCorpus({}),
      /CORPUS_HANDLE_REQUIRED/,
    );
    await assert.rejects(
      () =>
        withOwnedCorpusFixture('draft-corpus', () => {}, {
          directory: '/not-an-owned-fixture',
        }),
      /CORPUS_FACTORY_INVALID/,
    );
    await withOwnedCorpusFixture('draft-corpus', async (f) => {
      const before = await authorityCounts(f);
      await assert.rejects(
        () => bootstrapOwnedCorpus({ ...f.handle }),
        /CORPUS_HANDLE_REQUIRED/,
      );
      assert.deepEqual(await authorityCounts(f), before);
    });
  },
);

test(
  'BS03 marker/data/session/link/config changes deny the first verification authority',
  options,
  async () => {
    for (const kind of [
      'marker',
      'unrelated-data',
      'session',
      'link',
      'capability',
    ])
      await withOwnedCorpusFixture('draft-corpus', async (f) => {
        const before = await authorityCounts(f),
          marker = path.join(f.directory, '.hanzi-qa-owned'),
          bytes = fs.readFileSync(marker);
        try {
          if (kind === 'marker')
            fs.writeFileSync(marker, 'INDEPENDENT-WRONG-MARKER');
          if (kind === 'unrelated-data')
            await f.client.execute(
              "UPDATE pilot_auth_user SET name='changed-private-fact' WHERE id='r6-other'",
            );
          if (kind === 'session')
            await f.client.execute(
              "DELETE FROM pilot_auth_session WHERE id='session-r6-op'",
            );
          if (kind === 'link')
            await f.client.execute(
              "DELETE FROM pilot_parent_child WHERE parent_id='r6-parent'",
            );
          if (kind === 'capability')
            f.context().corpus.capability.namespace = 'foreign-capability';
          await assert.rejects(() => bootstrapOwnedCorpus(f.handle));
          assert.deepEqual(await authorityCounts(f), before);
        } finally {
          if (kind === 'marker') fs.writeFileSync(marker, bytes);
        }
      });
  },
);

test(
  'BS04 actual bootstrap saves fixture-only complete snapshot/group and exact replay',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const ack = await bootstrapOwnedCorpus(f.handle),
        before = await authorityCounts(f);
      assert.equal(before.pilot_corpus_publication, 1);
      assert.equal(before.pilot_corpus_publication_state, 1);
      assert.equal(before.pilot_corpus_publication_audit, 1);
      assert.equal(before.pilot_corpus_trial_member, 2);
      for (const table of [
        'pilot_corpus_owner_decision',
        'pilot_corpus_proof_receipt',
        'pilot_curriculum_review',
      ])
        assert.equal(before[table], 0);
      const header = (
        await f.client.execute('SELECT * FROM pilot_corpus_snapshot')
      ).rows[0];
      assert.equal(header.status, 'sealed');
      const plan = JSON.parse(header.plan_json);
      assert.equal(plan.lane, 'verification');
      assert.equal(plan.counts.includedCharacterCount, 0);
      assert.equal(plan.counts.verificationPackageCount, 10);
      assert.equal(await count(f, 'pilot_corpus_snapshot_member'), 20);
      assert.deepEqual(await bootstrapOwnedCorpus(f.handle), ack);
      assert.deepEqual(await authorityCounts(f), before);
    }),
);

test(
  'BS05 real terminal group constraint rolls back authority; exact retry succeeds once',
  options,
  async () => {
    let armed = false,
      fired = 0,
      engineCode;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const prepared = await prepareOwnedCorpus(f.handle),
          body = {
            requestId: 'independent-fault-group',
            snapshotId: prepared.snapshotId,
            expectedRevision: 0,
            predecessorPublicationId: null,
          },
          before = await authorityCounts(f);
        armed = true;
        await assert.rejects(() => publishOwnedCorpus(f.handle, body));
        assert.equal(fired, 1);
        assert.ok(engineCode?.startsWith('SQLITE_CONSTRAINT'));
        assert.deepEqual(await authorityCounts(f), before);
        const ack = await publishOwnedCorpus(f.handle, body);
        assert.equal(ack.revision, 1);
        assert.deepEqual(await publishOwnedCorpus(f.handle, body), ack);
        assert.equal(await count(f, 'pilot_corpus_publication'), 1);
      },
      {
        instrumentClient(client) {
          const batch = client.batch.bind(client);
          client.batch = async (statements, mode) => {
            if (
              armed &&
              statements.some((s) =>
                String(s.sql).includes('INSERT INTO pilot_corpus_publication('),
              )
            ) {
              armed = false;
              fired++;
              try {
                return await batch(
                  [
                    ...statements,
                    {
                      sql: 'INSERT INTO pilot_installation SELECT * FROM pilot_installation WHERE id=1',
                      args: [],
                    },
                  ],
                  mode,
                );
              } catch (e) {
                engineCode = typeof e.code === 'string' ? e.code : null;
                throw e;
              }
            }
            return batch(statements, mode);
          };
        },
      },
    );
  },
);

test(
  'BS06 concurrent initial head CAS has one complete winner',
  options,
  async () =>
    withOwnedCorpusFixture('draft-corpus', async (f) => {
      const prepared = await prepareOwnedCorpus(f.handle),
        results = await Promise.allSettled(
          ['left', 'right'].map((id) =>
            publishOwnedCorpus(f.handle, {
              requestId: 'independent-cas-' + id,
              snapshotId: prepared.snapshotId,
              expectedRevision: 0,
              predecessorPublicationId: null,
            }),
          ),
        );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(await count(f, 'pilot_corpus_publication'), 1);
      assert.equal(await count(f, 'pilot_corpus_publication_audit'), 1);
      assert.equal(await count(f, 'pilot_corpus_publication_state'), 1);
      assert.equal(await count(f, 'pilot_corpus_trial_member'), 2);
    }),
);
