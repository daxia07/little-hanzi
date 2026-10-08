import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { corpusPrefixUpperBound } from '../lib/pilot/corpus-family-policy.ts';

test('[FS02] indexed SQLite BINARY prefix ranges retain supplementary Han continuations and exact all-scalar semantics', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hanzi-corpus-prefix-'),
  );
  fs.writeFileSync(
    path.join(directory, '.hanzi-qa-owned'),
    'FS02 disposable SQLite predicate only',
  );
  const client = createClient({
    url: 'file:' + path.join(directory, 'predicate.sqlite'),
  });
  try {
    await client.execute(
      'CREATE TABLE indexed_terms(term TEXT COLLATE BINARY PRIMARY KEY)',
    );
    const terms = [
      '木',
      '木木',
      '木𠀀',
      '木𠀀林',
      '朩',
      '𠀀',
      '𠀀木',
      '𠀁',
      'a',
      'a𠀀',
      'b',
      'é',
      'é𠀀',
      'ê',
      'x' + String.fromCodePoint(0x10ffff),
      'x' + String.fromCodePoint(0x10ffff) + '木',
      'y',
      String.fromCodePoint(0x10ffff),
      String.fromCodePoint(0x10ffff) + '木',
    ];
    for (const term of terms)
      await client.execute({
        sql: 'INSERT INTO indexed_terms VALUES(?)',
        args: [term],
      });
    for (const prefix of [
      '木',
      '𠀀',
      'a',
      'é',
      'x' + String.fromCodePoint(0x10ffff),
      String.fromCodePoint(0x10ffff),
    ]) {
      const upper = corpusPrefixUpperBound(prefix),
        rows = (
          await client.execute({
            sql:
              'SELECT term FROM indexed_terms WHERE term>=?' +
              (upper === null ? '' : ' AND term<?') +
              ' ORDER BY term',
            args: upper === null ? [prefix] : [prefix, upper],
          })
        ).rows;
      assert.deepEqual(
        new Set(rows.map((r) => r.term)),
        new Set(terms.filter((term) => term.startsWith(prefix))),
        prefix,
      );
    }
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('[FS02] scalar successor carries maximum code points and skips the surrogate range', () => {
  assert.equal(corpusPrefixUpperBound('木'), '朩');
  assert.equal(
    corpusPrefixUpperBound('a' + String.fromCodePoint(0x10ffff)),
    'b',
  );
  assert.equal(
    corpusPrefixUpperBound(String.fromCodePoint(0xffff)),
    String.fromCodePoint(0x10000),
  );
  assert.equal(
    corpusPrefixUpperBound(String.fromCodePoint(0xd7ff)),
    String.fromCodePoint(0xe000),
  );
  assert.equal(corpusPrefixUpperBound(String.fromCodePoint(0x10ffff)), null);
  assert.throws(() => corpusPrefixUpperBound(''));
  assert.throws(() => corpusPrefixUpperBound('\ud800'));
});
