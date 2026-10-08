import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client/node';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { createLibsqlD1Database } from '../lib/platform/libsql-d1.ts';

async function withDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'little-hanzi-libsql-'));
  const client = createClient({
    url: `file:${join(directory, 'test.sqlite')}`,
  });
  const db = createLibsqlD1Database(client);
  try {
    return await callback({ client, db });
  } finally {
    await Promise.resolve(client.close?.());
    await rm(directory, { recursive: true, force: true });
  }
}

await test('[V-AC-002][U-01] real libSQL preserves bound NULLs, ordered rows, first/all/raw results, and run metadata', async () => {
  await withDatabase(async ({ db }) => {
    await db
      .prepare(
        'CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT)',
      )
      .run();
    const inserted = await db
      .prepare('INSERT INTO records(label,note) VALUES(?,?)')
      .bind('first', null)
      .run();
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.last_row_id, 1);

    const updated = await db
      .prepare('UPDATE records SET note=? WHERE id=?')
      .bind('kept', 1)
      .run();
    assert.equal(updated.meta.changes, 1);

    const objectResult = await db
      .prepare('SELECT label,id,note FROM records ORDER BY id')
      .all();
    assert.deepEqual(objectResult.results, [
      { label: 'first', id: 1, note: 'kept' },
    ]);

    const rawResult = await db
      .prepare('SELECT id,label,note FROM records ORDER BY id')
      .raw({ columnNames: true });
    assert.deepEqual(rawResult, [
      ['id', 'label', 'note'],
      [1, 'first', 'kept'],
    ]);

    const rawRows = await db
      .prepare('SELECT id,label,note FROM records ORDER BY id')
      .raw();
    assert.deepEqual(rawRows, [[1, 'first', 'kept']]);

    assert.equal(
      await db
        .prepare('SELECT label FROM records WHERE id=?')
        .bind(1)
        .first('label'),
      'first',
    );
    assert.deepEqual(
      await db
        .prepare('SELECT id,label,note FROM records WHERE id=?')
        .bind(1)
        .first(),
      { id: 1, label: 'first', note: 'kept' },
    );
  });
});

await test('[V-AC-002][U-02] real libSQL batch results retain ordered SELECT and RETURNING rows', async () => {
  await withDatabase(async ({ db }) => {
    await db
      .prepare(
        'CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT NOT NULL)',
      )
      .run();
    await db.prepare('INSERT INTO records(label) VALUES(?)').bind('seed').run();

    const results = await db.batch([
      db.prepare('SELECT id,label FROM records ORDER BY id'),
      db
        .prepare('INSERT INTO records(label) VALUES(?) RETURNING id,label')
        .bind('batch'),
    ]);
    assert.deepEqual(results[0].results, [{ id: 1, label: 'seed' }]);
    assert.deepEqual(results[1].results, [{ id: 2, label: 'batch' }]);
  });
});

await test('[V-AC-002][I-01] a late foreign-key failure rolls back every earlier statement in the batch', async () => {
  await withDatabase(async ({ db }) => {
    await db.prepare('PRAGMA foreign_keys = ON').run();
    await db.prepare('CREATE TABLE parents (id INTEGER PRIMARY KEY)').run();
    await db
      .prepare(
        'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id))',
      )
      .run();

    await assert.rejects(
      db.batch([
        db.prepare('INSERT INTO parents(id) VALUES(?)').bind(7),
        db.prepare('INSERT INTO children(id,parent_id) VALUES(?,?)').bind(1, 7),
        db
          .prepare('INSERT INTO children(id,parent_id) VALUES(?,?)')
          .bind(2, 999),
      ]),
      /constraint|foreign key/i,
    );

    assert.deepEqual(
      (await db.prepare('SELECT * FROM parents').all()).results,
      [],
    );
    assert.deepEqual(
      (await db.prepare('SELECT * FROM children').all()).results,
      [],
    );
  });
});

await test('[V-AC-002][I-02] D1 batches reject prepared statements belonging to another libSQL client', async () => {
  await withDatabase(async ({ db }) => {
    await withDatabase(async ({ db: otherDb }) => {
      await assert.rejects(
        db.batch([otherDb.prepare('SELECT 1')]),
        /same libSQL client/i,
      );
    });
  });
});

await test('[V-AC-002][I-03] Drizzle D1 queries use the adapter against a real libSQL file database', async () => {
  await withDatabase(async ({ db }) => {
    await db
      .prepare(
        'CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT NOT NULL)',
      )
      .run();
    await db
      .prepare('INSERT INTO records(id,label) VALUES(?,?)')
      .bind(3, 'drizzle')
      .run();

    const orm = drizzle(db);
    const rows = await orm.all(
      sql`SELECT id, label FROM records WHERE id = ${3}`,
    );
    assert.deepEqual(rows, [{ id: 3, label: 'drizzle' }]);
  });
});
