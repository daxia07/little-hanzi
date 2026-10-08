import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = process.cwd(),
  dep =
    '/private/var/folders/hr/l9ynfm_j31g54lqlsqychm0m0000gp/T/hanzi-r2-dependencies-a2tj4rrw/node_modules/@libsql/client';
const { createClient } = await import(
  pathToFileURL(path.join(dep, 'lib-esm/node.js'))
);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hanzi-r6-ops-'));
await fs.writeFile(path.join(work, '.hanzi-qa-owned'), 'r6-ops-1');
const out = path.join(root, 'outputs/qa/readiness-r6/ops-migration-3');
await fs.mkdir(out, { recursive: false });
const files = [
    'db/pilot-ops-migrations/0000_ops.sql',
    'db/pilot-ops-migrations/0001_collection_archives.sql',
    'outputs/implementation/readiness-r6/archive/0002_corpus_archives.sql',
  ],
  texts = await Promise.all(files.map((p) => fs.readFile(p, 'utf8'))),
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  hashes = texts.map(sha);
assert.equal(
  hashes[2],
  '524eaf2c844099b1eb76de1434ded5b05cefac0eb214f5dbda4b36df4da6ec20',
);
const report = {
  sourceHashes: Object.fromEntries(files.map((p, i) => [p, hashes[i]])),
  work,
  cases: [],
  startedAt: Date.now(),
  method: 'raw atomic SQL and ledger via embedded libSQL; not executor/HTTP',
};
const D = 'sha256:' + 'a'.repeat(64),
  J = JSON.stringify;
let client;
async function row(db, t, o) {
  const values = {};
  for (const c of (await db.execute('PRAGMA table_info(' + t + ')')).rows)
    if (c.notnull)
      values[c.name] =
        c.type === 'INTEGER'
          ? 0
          : c.name.endsWith('_digest')
            ? D
            : c.name.endsWith('_json')
              ? '{}'
              : 'fixture';
  Object.assign(values, o);
  const k = Object.keys(values);
  return db.execute({
    sql:
      'INSERT INTO ' +
      t +
      '(' +
      k.join(',') +
      ') VALUES(' +
      k.map(() => '?').join(',') +
      ')',
    args: k.map((x) => values[x]),
  });
}
async function txMigration(db, text, version, checksum, fault = false) {
  const tx = await db.transaction('write');
  try {
    await tx.executeMultiple(text);
    await tx.execute({
      sql: 'INSERT INTO ops_schema_history VALUES(?,?,?,0)',
      args: [
        version,
        version === 1
          ? '0001_collection_archives.sql'
          : '0002_corpus_archives.sql',
        checksum,
      ],
    });
    if (fault)
      await tx.execute(
        'INSERT INTO ops_schema_history SELECT * FROM ops_schema_history WHERE version=2',
      );
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}
async function snapshot(db) {
  const tables = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ops_%' ORDER BY name",
    )
  ).rows.map((r) => r.name);
  const rows = {};
  for (const t of tables)
    rows[t] = (await db.execute('SELECT * FROM ' + t + ' ORDER BY 1')).rows.map(
      (r) => Object.fromEntries(Object.entries(r)),
    );
  return rows;
}
async function fresh(name) {
  const c = createClient({ url: 'file:' + path.join(work, name + '.db') });
  await c.executeMultiple(texts[0]);
  await c.execute({
    sql: 'INSERT INTO ops_schema_history VALUES(0,?,?,0)',
    args: ['0000_ops.sql', hashes[0]],
  });
  await c.execute(
    "INSERT INTO ops_installation VALUES(1,'ops','synthetic','learning','pilot-ops-schema-1',7,0)",
  );
  await txMigration(c, texts[1], 1, hashes[1]);
  return c;
}
async function test(id, f) {
  try {
    await f();
    report.cases.push({ id, outcome: 'PASS' });
  } catch (e) {
    report.cases.push({ id, outcome: 'FAIL', error: e.message });
    throw e;
  }
}
try {
  client = await fresh('populated');
  report.engine = (await client.execute('SELECT sqlite_version() v')).rows[0].v;
  const tx = await client.transaction('write');
  try {
    const scope = {
      environment: 'synthetic',
      installation_id: 'learning',
      ops_installation_id: 'ops',
      build_id: 'build',
    };
    await row(tx, 'ops_job', {
      ...scope,
      id: 'job',
      kind: 'backup',
      utc_slot: 'slot',
      revision: 1,
      status: 'running',
      attempt_id: 'attempt',
      attempt_number: 1,
      lease_until: 1,
      latest_event_id: 'je',
    });
    await row(tx, 'ops_job_event', {
      environment: scope.environment,
      installation_id: scope.installation_id,
      ops_installation_id: scope.ops_installation_id,
      id: 'je',
      job_id: 'job',
      sequence: 1,
      attempt_id: 'attempt',
      kind: 'acquired',
      status_after: 'running',
    });
    await row(tx, 'ops_archive', {
      ...scope,
      id: 'archive',
      job_id: 'job',
      attempt_id: 'attempt',
      kind: 'learning',
      format: 'pilot-admin-backup-5',
      object_ref: 'private-synthetic-object',
      key_id: 'synthetic-key',
      byte_size: 1,
      daily_slot: 'daily',
      verification_event_id: 'je',
    });
    await row(tx, 'ops_feedback', {
      ...scope,
      id: 'feedback',
      kind: 'observation',
      submission_build_id: 'build',
      source_role: 'operator',
      actor_key: 'operator',
      operator_user_id: 'op',
      request_id: 'submit',
      candidate_id: 'candidate',
      lesson_id: 'fixture',
      lesson_version: 'fixture-v1',
      observation_kind: 'synthetic',
      observed_at: 0,
      private_json: J({ text: 'SIMULATED' }),
      request_json: '{}',
      receipt_json: J({ recordId: 'feedback', revision: 1 }),
      expires_at: 2592000000,
      revision: 1,
      severity: 'normal',
      status: 'open',
      latest_event_id: 'fe',
    });
    await row(tx, 'ops_feedback_event', {
      environment: scope.environment,
      installation_id: scope.installation_id,
      ops_installation_id: scope.ops_installation_id,
      id: 'fe',
      record_id: 'feedback',
      sequence: 1,
      kind: 'submitted',
      actor_key: 'operator',
      request_id: 'submit',
      request_json: '{}',
      private_json: J({ text: 'SIMULATED' }),
      receipt_json: J({ recordId: 'feedback', revision: 1 }),
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
  const original = await snapshot(client),
    schema = (
      await client.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'ops_%' ORDER BY type,name",
      )
    ).rows.map((r) => ({ ...r }));
  await test('O01-final-ledger-fault-rolls-back', async () => {
    await assert.rejects(
      () => txMigration(client, texts[2], 2, hashes[2], true),
      /UNIQUE/,
    );
    assert.deepEqual(await snapshot(client), original);
    assert.deepEqual(
      (
        await client.execute(
          "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'ops_%' ORDER BY type,name",
        )
      ).rows.map((r) => ({ ...r })),
      schema,
    );
  });
  await test('O02-populated-upgrade-preservation', async () => {
    await txMigration(client, texts[2], 2, hashes[2]);
    const after = await snapshot(client);
    for (const [t, rows] of Object.entries(original)) {
      if (t === 'ops_installation')
        assert.deepEqual(
          after[t],
          rows.map((r) => ({ ...r, schema_version: 'pilot-ops-schema-3' })),
        );
      else if (t === 'ops_schema_history')
        assert.deepEqual(after[t].slice(0, 2), rows);
      else assert.deepEqual(after[t], rows);
    }
    assert.equal(after.ops_schema_history.length, 3);
    assert.equal(
      (await client.execute('PRAGMA foreign_key_check')).rows.length,
      0,
    );
  });
  await test('O03-immutability-and-queue-preserved', async () => {
    await assert.rejects(
      () =>
        client.execute("UPDATE ops_archive SET byte_size=2 WHERE id='archive'"),
      /OPS_IMMUTABLE/,
    );
    await assert.rejects(
      () => client.execute('DELETE FROM ops_schema_history WHERE version=2'),
      /OPS_IMMUTABLE/,
    );
    const before = Number(
      (await client.execute('SELECT queue_revision FROM ops_installation'))
        .rows[0].queue_revision,
    );
    const tx = await client.transaction('write');
    try {
      const feedback = {
        ...original.ops_feedback[0],
        id: 'feedback2',
        request_id: 'submit2',
        latest_event_id: 'fe2',
      };
      const event = {
        ...original.ops_feedback_event[0],
        id: 'fe2',
        record_id: 'feedback2',
        request_id: 'submit2',
      };
      await row(tx, 'ops_feedback', feedback);
      await row(tx, 'ops_feedback_event', event);
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      tx.close();
    }
    assert.equal(
      Number(
        (await client.execute('SELECT queue_revision FROM ops_installation'))
          .rows[0].queue_revision,
      ),
      before + 1,
    );
  });
  await test('O04-invalid-prefix-no-effects', async () => {
    const invalid = createClient({
      url: 'file:' + path.join(work, 'invalid.db'),
    });
    try {
      await invalid.executeMultiple(texts[0]);
      await invalid.execute({
        sql: 'INSERT INTO ops_schema_history VALUES(0,?,?,0)',
        args: ['0000_ops.sql', hashes[0]],
      });
      await invalid.execute(
        "INSERT INTO ops_installation VALUES(1,'ops','synthetic','learning','pilot-ops-schema-1',0,0)",
      );
      const before = await snapshot(invalid);
      await assert.rejects(
        () => txMigration(invalid, texts[2], 2, hashes[2]),
        /CHECK/,
      );
      assert.deepEqual(await snapshot(invalid), before);
    } finally {
      invalid.close();
    }
  });
} catch (e) {
  report.failure = e.message;
  process.exitCode = 1;
} finally {
  client?.close();
  await fs.rm(work, { recursive: true, force: true });
  report.finishedAt = Date.now();
  report.cleanup = { ownedClientsClosed: true, ownedDirectoryRemoved: true };
  report.hashesUnchanged = (
    await Promise.all(files.map((p) => fs.readFile(p)))
  ).every((b, i) => sha(b) === hashes[i]);
  await fs.writeFile(path.join(out, 'report.json'), J(report, null, 2));
  console.log(
    J({
      cases: report.cases,
      failure: report.failure,
      cleanup: report.cleanup,
    }),
  );
}
