import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  withOwnedCorpusFixture,
  bootstrapOwnedCorpus,
  prepareOwnedCorpus,
  publishOwnedCorpus,
  withdrawOwnedCorpus,
} from '../scripts/readiness-corpus-bootstrap.mjs';

test('[R6-E-005/006/008] owned fixture bootstrap grants machine-only group with complete members and zero real coverage', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const receipt = await bootstrapOwnedCorpus(f.handle);
    const groups = (
      await f.client.execute(
        'SELECT scope_kind,owner_decision_id,test_run_id FROM pilot_corpus_publication',
      )
    ).rows;
    assert.equal(
      groups.length,
      1,
      'closed bootstrap must persist one verification authority',
    );
    assert.equal(groups[0].scope_kind, 'verification');
    assert.equal(groups[0].owner_decision_id, null);
    assert.equal(groups[0].test_run_id, f.namespace);
    const rows = (
      await f.client.execute(
        'SELECT status,expected_included_count,expected_package_count FROM pilot_corpus_snapshot',
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sealed');
    assert.equal(rows[0].expected_included_count, 0);
    assert.equal(rows[0].expected_package_count, 10);
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_snapshot_member',
        )
      ).rows[0].n,
      20,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_publication_audit',
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_owner_decision',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_proof_receipt',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_curriculum_review',
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await bootstrapOwnedCorpus(f.handle), receipt);
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_publication_audit',
        )
      ).rows[0].n,
      1,
    );
  });
});
const count = async (f, table) =>
  (await f.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n;
test('[R6-E-006] changed marker, database identity, installation and capability never grant authority', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const marker = path.join(f.directory, '.hanzi-qa-owned'),
      saved = fs.readFileSync(marker);
    try {
      fs.writeFileSync(marker, 'foreign');
      await assert.rejects(
        () => bootstrapOwnedCorpus(f.handle),
        /CORPUS_OWNERSHIP_CHANGED/,
      );
    } finally {
      fs.writeFileSync(marker, saved);
    }
    const db = path.join(f.directory, 'fresh.db'),
      retained = path.join(f.directory, 'owned-original.db');
    fs.renameSync(db, retained);
    fs.writeFileSync(db, 'foreign replacement');
    try {
      await assert.rejects(
        () => bootstrapOwnedCorpus(f.handle),
        /CORPUS_OWNERSHIP_CHANGED/,
      );
    } finally {
      fs.unlinkSync(db);
      fs.renameSync(retained, db);
    }
    const original = f.config.testRunId;
    f.config.testRunId = 'different-namespace';
    await assert.rejects(
      () => bootstrapOwnedCorpus(f.handle),
      /CAPABILITY_DENIED/,
    );
    f.config.testRunId = original;
    await f.client.execute(
      "UPDATE pilot_installation SET installation_id='foreign-install' WHERE id=1",
    );
    await assert.rejects(
      () => bootstrapOwnedCorpus(f.handle),
      /CAPABILITY_DENIED/,
    );
    assert.equal(await count(f, 'pilot_corpus_publication'), 0);
  });
});
test('[R6-E-006/008] late unrelated account or link revocation cannot sneak into initial authority', async () => {
  for (const sql of [
    "INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES('foreign','foreign','foreign@synthetic.invalid',0,0,0,'foreign','foreign','parent',0,0)",
    "UPDATE pilot_auth_user SET name='unrelated replacement' WHERE id='r6-other'",
    "DELETE FROM pilot_parent_child WHERE parent_id='r6-parent'",
  ]) {
    let arm = false,
      fired = 0;
    await withOwnedCorpusFixture(
      'draft-corpus',
      async (f) => {
        const prepared = await prepareOwnedCorpus(f.handle);
        arm = true;
        await assert.rejects(() =>
          publishOwnedCorpus(f.handle, {
            requestId: 'late-freshness',
            snapshotId: prepared.snapshotId,
            expectedRevision: 0,
            predecessorPublicationId: null,
          }),
        );
        assert.equal(fired, 1);
        assert.equal(await count(f, 'pilot_corpus_publication'), 0);
        assert.equal(await count(f, 'pilot_corpus_publication_state'), 0);
        assert.equal(await count(f, 'pilot_corpus_trial_member'), 0);
        assert.equal(await count(f, 'pilot_corpus_publication_audit'), 0);
      },
      {
        instrumentClient(client) {
          const original = client.batch.bind(client);
          client.batch = async (statements, ...args) => {
            if (
              arm &&
              statements.some((x) =>
                (typeof x === 'string' ? x : x.sql).includes(
                  'INSERT INTO pilot_corpus_publication(',
                ),
              )
            ) {
              arm = false;
              fired++;
              await client.execute(sql);
            }
            return original(statements, ...args);
          };
        },
      },
    );
  }
});
test('[R6-E-008] real terminal audit constraint rolls back head, scope and epoch then exact retry succeeds', async () => {
  let arm = false,
    fired = 0;
  await withOwnedCorpusFixture(
    'draft-corpus',
    async (f) => {
      const prepared = await prepareOwnedCorpus(f.handle),
        before = (
          await f.client.execute(
            'SELECT revision FROM pilot_corpus_evidence_epoch',
          )
        ).rows[0].revision;
      const body = {
        requestId: 'audit-failure',
        snapshotId: prepared.snapshotId,
        expectedRevision: 0,
        predecessorPublicationId: null,
      };
      arm = true;
      await assert.rejects(
        () => publishOwnedCorpus(f.handle, body),
        /constraint|R6_AUDIT_BINDING/i,
      );
      assert.equal(fired, 1);
      for (const t of [
        'pilot_corpus_publication',
        'pilot_corpus_publication_state',
        'pilot_corpus_trial_member',
        'pilot_corpus_publication_audit',
      ])
        assert.equal(await count(f, t), 0);
      assert.equal(
        (
          await f.client.execute(
            'SELECT revision FROM pilot_corpus_evidence_epoch',
          )
        ).rows[0].revision,
        before,
      );
      const ack = await publishOwnedCorpus(f.handle, body);
      assert.deepEqual(await publishOwnedCorpus(f.handle, body), ack);
      assert.equal(await count(f, 'pilot_corpus_publication_audit'), 1);
      await assert.rejects(
        () => publishOwnedCorpus(f.handle, { ...body, expectedRevision: 1 }),
        /CONFLICT/,
      );
    },
    {
      instrumentClient(client) {
        const original = client.batch.bind(client);
        client.batch = async (statements, ...args) => {
          if (
            arm &&
            statements.some((x) =>
              (typeof x === 'string' ? x : x.sql).includes(
                'INSERT INTO pilot_corpus_publication(',
              ),
            )
          ) {
            arm = false;
            fired++;
            statements = [
              ...statements.slice(0, -1),
              {
                sql: "INSERT INTO pilot_corpus_publication_audit(id,publication_id,actor_id,action,request_id,created_at) VALUES('forced-audit',NULL,'r6-op','released','audit-failure',0)",
                args: [],
              },
            ];
          }
          return original(statements, ...args);
        };
      },
    },
  );
});
test('[R6-E-008] concurrent publication has one head; withdrawal and new preparation preserve historical groups', async () => {
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    const prepared = await prepareOwnedCorpus(f.handle);
    const results = await Promise.allSettled(
      ['race-a', 'race-b'].map((requestId) =>
        publishOwnedCorpus(f.handle, {
          requestId,
          snapshotId: prepared.snapshotId,
          expectedRevision: 0,
          predecessorPublicationId: null,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await count(f, 'pilot_corpus_publication_audit'), 1);
    const winner = results.find((r) => r.status === 'fulfilled').value;
    const withdrawn = await withdrawOwnedCorpus(f.handle, {
      requestId: 'withdraw',
      expectedRevision: 1,
      predecessorPublicationId: winner.recordId,
    });
    assert.equal(withdrawn.revision, 2);
    assert.equal(
      (
        await f.client.execute(
          'SELECT p.status FROM pilot_corpus_publication_state h JOIN pilot_corpus_publication p ON p.id=h.latest_publication_id',
        )
      ).rows[0].status,
      'withdrawn',
    );
    const next = await prepareOwnedCorpus(f.handle),
      again = await publishOwnedCorpus(f.handle, {
        requestId: 'republish',
        snapshotId: next.snapshotId,
        expectedRevision: 2,
        predecessorPublicationId: withdrawn.recordId,
      });
    assert.equal(again.revision, 3);
    assert.equal(await count(f, 'pilot_corpus_publication'), 3);
    assert.equal(await count(f, 'pilot_corpus_publication_audit'), 3);
    assert.equal(await count(f, 'pilot_corpus_snapshot'), 2);
    await f.client.execute(
      "DELETE FROM pilot_auth_session WHERE id='session-r6-op'",
    );
    await assert.rejects(
      () =>
        publishOwnedCorpus(f.handle, {
          requestId: 'republish',
          snapshotId: next.snapshotId,
          expectedRevision: 2,
          predecessorPublicationId: withdrawn.recordId,
        }),
      /CAPABILITY_DENIED/,
    );
  });
});
test('[R6-E-006] copied and serialized handles cannot grant fixture authority', async () => {
  await assert.rejects(
    () => bootstrapOwnedCorpus({}),
    /CORPUS_HANDLE_REQUIRED/,
  );
  await withOwnedCorpusFixture('draft-corpus', async (f) => {
    await assert.rejects(
      () => bootstrapOwnedCorpus({ ...f.handle }),
      /CORPUS_HANDLE_REQUIRED/,
    );
    await assert.rejects(
      () => bootstrapOwnedCorpus(JSON.parse(JSON.stringify(f.handle))),
      /CORPUS_HANDLE_REQUIRED/,
    );
    assert.equal(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pilot_corpus_publication',
        )
      ).rows[0].n,
      0,
    );
  });
});
