import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const STORY_MIGRATIONS = [
  '0000-auth.sql',
  '0001-data.sql',
  '0002-learning.sql',
  '0003-curriculum.sql',
  '0004-curriculum-runtime.sql',
  '0005-family-story.sql',
];
export const normalizeSchemaSql = (sql) =>
  String(sql)
    .replaceAll(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '')
    .trim();

/** Parse trusted source SQL with SQLite's statement parser; do not execute it. */
export function storySchemaSource(
  root = path.resolve(import.meta.dirname, '..'),
) {
  return migrationSchemaSource(root, STORY_MIGRATIONS, {
    knownSuccessors: [
      '0006-collection-learning.sql',
      '0007-corpus-learning.sql',
    ],
  });
}

/** An explicit historical prefix may be read from a known successor source tree.
 * Capture/restore still compare the actual installed schema and complete format.
 * Unknown future migrations are never skipped. */
export function migrationSchemaSource(
  root,
  expected,
  { knownSuccessors = [] } = {},
) {
  const directory = path.join(root, 'db/pilot-migrations');
  const actual = fs
    .readdirSync(directory)
    .filter((name) => /^\d+-.+\.sql$/.test(name))
    .sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) &&
    !(
      knownSuccessors.length &&
      actual.length > expected.length &&
      actual.length <= expected.length + knownSuccessors.length &&
      JSON.stringify(actual) ===
        JSON.stringify(
          [...expected, ...knownSuccessors].slice(0, actual.length),
        )
    )
  )
    throw new Error('BACKUP_VERSION_INCOMPATIBLE');
  const names = expected;
  const sources = names.map((name) =>
    fs.readFileSync(path.join(directory, name), 'utf8'),
  );
  const migrations = names.map((name, index) => ({
    name,
    version: name.replace(/^(\d+)-(.+)\.sql$/, 'pilot-$2-$1'),
    sha256: crypto.createHash('sha256').update(sources[index]).digest('hex'),
  }));
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json, sqlite3, sys',
        'result=[]',
        'for source in json.load(sys.stdin):',
        '    start=0',
        '    for index, character in enumerate(source):',
        '        if character == ";" and sqlite3.complete_statement(source[start:index+1]):',
        '            result.append(source[start:index+1]); start=index+1',
        '    if source[start:].strip(): raise SystemExit(2)',
        'print(json.dumps(result))',
      ].join('\n'),
    ],
    {
      input: JSON.stringify(sources),
      encoding: 'utf8',
      maxBuffer: 4_000_000,
      timeout: 10000,
    },
  );
  if (parsed.status !== 0) throw new Error('BACKUP_SCHEMA_SOURCE_INVALID');
  const statements = JSON.parse(parsed.stdout);
  const schema = [];
  for (const statement of statements) {
    const match =
      /\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        statement,
      );
    if (!match) continue;
    const type = match[1].toLowerCase(),
      name = match[2];
    if (['pilot_schema_history', 'pilot_d1_migrations'].includes(name))
      continue;
    const sql = statement.slice(match.index).trim().replace(/;$/, '');
    const table =
      type === 'table'
        ? name
        : /\bON\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql)?.[1];
    if (!table) throw new Error('BACKUP_SCHEMA_SOURCE_INVALID');
    schema.push({ type, name, tbl_name: table, sql });
  }
  return { migrations, schema, statements };
}

export function assertStorySchema(payload, source = storySchemaSource()) {
  if (JSON.stringify(payload.migrations) !== JSON.stringify(source.migrations))
    throw new Error('BACKUP_MIGRATION_MISMATCH');
  const expected = new Map(
    source.schema.map((row) => [`${row.type}:${row.name}`, row]),
  );
  if (!Array.isArray(payload.schema) || payload.schema.length !== expected.size)
    throw new Error('BACKUP_SCHEMA_MISMATCH');
  const seen = new Set();
  for (const row of payload.schema) {
    const identity = `${row.type}:${row.name}`,
      original = expected.get(identity);
    if (
      seen.has(identity) ||
      !original ||
      original.tbl_name !== row.tbl_name ||
      normalizeSchemaSql(original.sql) !== normalizeSchemaSql(row.sql)
    )
      throw new Error('BACKUP_SCHEMA_MISMATCH');
    seen.add(identity);
  }
}
