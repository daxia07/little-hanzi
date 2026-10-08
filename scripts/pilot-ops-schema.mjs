import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
export const OPS_MIGRATION_SHA =
  '26aa0f39b7b8cc7c06e8351f4d1b98d42f35425553db216cbfe5859cd49d429a';
export const OPS_MIGRATION_V2_SHA =
  '9bbb359d9a28ac0942976980a60bf26742e4df7e2bf837f49712b73d1b7686cf';
export const OPS_MIGRATION_V3_SHA =
  '524eaf2c844099b1eb76de1434ded5b05cefac0eb214f5dbda4b36df4da6ec20';
export const normalizeOpsSql = (sql) =>
  String(sql).replaceAll(/\s+/g, ' ').trim().replace(/;+$/, '');
export function opsSchemaSource(
  root = path.resolve(import.meta.dirname, '..'),
  { version } = {},
) {
  const dir = path.join(root, 'db/pilot-ops-migrations');
  const names = fs.readdirSync(dir).sort();
  if (
    ![
      JSON.stringify(['0000_ops.sql']),
      JSON.stringify(['0000_ops.sql', '0001_collection_archives.sql']),
      JSON.stringify([
        '0000_ops.sql',
        '0001_collection_archives.sql',
        '0002_corpus_archives.sql',
      ]),
    ].includes(JSON.stringify(names))
  )
    throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const latest = names.length;
  version ??= latest;
  if (![1, 2, 3].includes(version) || version > latest)
    throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const original = fs.readFileSync(path.join(dir, '0000_ops.sql'), 'utf8');
  if (
    crypto.createHash('sha256').update(original).digest('hex') !==
    OPS_MIGRATION_SHA
  )
    throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const upgrade =
    latest >= 2
      ? fs.readFileSync(path.join(dir, '0001_collection_archives.sql'), 'utf8')
      : null;
  if (
    upgrade !== null &&
    crypto.createHash('sha256').update(upgrade).digest('hex') !==
      OPS_MIGRATION_V2_SHA
  )
    throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const corpusUpgrade =
    latest === 3
      ? fs.readFileSync(path.join(dir, '0002_corpus_archives.sql'), 'utf8')
      : null;
  if (
    corpusUpgrade !== null &&
    crypto.createHash('sha256').update(corpusUpgrade).digest('hex') !==
      OPS_MIGRATION_V3_SHA
  )
    throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const sql = original;
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json,sqlite3,sys',
        'source=sys.stdin.read(); result=[]; start=0',
        'for index,c in enumerate(source):',
        '    if c==";" and sqlite3.complete_statement(source[start:index+1]):',
        '        result.append(source[start:index+1]); start=index+1',
        'if source[start:].strip(): raise SystemExit(2)',
        'print(json.dumps(result))',
      ].join('\n'),
    ],
    { input: sql, encoding: 'utf8', timeout: 10000, maxBuffer: 1000000 },
  );
  if (parsed.status !== 0) throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const statements = JSON.parse(parsed.stdout),
    schema = [],
    columns = {};
  for (const statement of statements) {
    const m =
      /\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        statement,
      );
    if (!m) continue;
    const type = m[1].toLowerCase(),
      name = m[2],
      ddl = statement.slice(m.index).trim().replace(/;$/, '');
    const table =
      type === 'table'
        ? name
        : /\bON\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(ddl)?.[1];
    if (!table) throw Error('OPS_SCHEMA_SOURCE_INVALID');
    schema.push({ type, name, tbl_name: table, sql: ddl });
    if (type === 'table')
      columns[name] = [
        ...ddl.matchAll(/^\s{2}([a-z][a-z_]+)\s+(?:TEXT|INTEGER)\b/gm),
      ].map((match) => match[1]);
  }
  const migrations = [
    { name: '0000_ops.sql', version: 0, sha256: OPS_MIGRATION_SHA },
  ];
  if (version === 1)
    return {
      version,
      format: 'pilot-ops-backup-1',
      sql,
      statements,
      schema,
      columns,
      migrations,
    };
  const derived = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json,sqlite3,sys',
        'v=json.load(sys.stdin);db=sqlite3.connect(":memory:");db.executescript(v["original"])',
        'db.execute("INSERT INTO ops_schema_history VALUES(0,?,?,0)",("0000_ops.sql",v["sha"]))',
        "db.execute(\"INSERT INTO ops_installation VALUES(1,'schema-source','schema-source','schema-source','pilot-ops-schema-1',0,0)\")",
        `for m in v["upgrades"]:
 db.executescript(m["sql"])
 db.execute("INSERT INTO ops_schema_history VALUES(?,?,?,0)",(m["version"],m["name"],m["sha256"]))`,
        'schema=[dict(zip(("type","name","tbl_name","sql"),r)) for r in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE \'sqlite_%\' ORDER BY name")]',
        'out=[];start=0',
        'for i,c in enumerate(v["upgrades"][-1]["sql"]):',
        ' if c==";" and sqlite3.complete_statement(v["upgrades"][-1]["sql"][start:i+1]):out.append(v["upgrades"][-1]["sql"][start:i+1]);start=i+1',
        'print(json.dumps({"schema":schema,"upgradeStatements":out}))',
      ].join('\n'),
    ],
    {
      input: JSON.stringify({
        original,
        sha: OPS_MIGRATION_SHA,
        upgrades: [
          {
            sql: upgrade,
            version: 1,
            name: '0001_collection_archives.sql',
            sha256: OPS_MIGRATION_V2_SHA,
          },
          ...(version === 3
            ? [
                {
                  sql: corpusUpgrade,
                  version: 2,
                  name: '0002_corpus_archives.sql',
                  sha256: OPS_MIGRATION_V3_SHA,
                },
              ]
            : []),
        ],
      }),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1000000,
    },
  );
  if (derived.status !== 0) throw Error('OPS_SCHEMA_SOURCE_INVALID');
  const final = JSON.parse(derived.stdout);
  const finalStatements = [
    ...final.schema.filter((r) => r.type === 'table'),
    ...final.schema.filter((r) => r.type !== 'table'),
  ].map((r) => r.sql + ';');
  migrations.push({
    name: '0001_collection_archives.sql',
    version: 1,
    sha256: OPS_MIGRATION_V2_SHA,
  });
  if (version === 3)
    migrations.push({
      name: '0002_corpus_archives.sql',
      version: 2,
      sha256: OPS_MIGRATION_V3_SHA,
    });
  return {
    version,
    format: `pilot-ops-backup-${version}`,
    sql: finalStatements.join('\n'),
    statements: finalStatements,
    schema: final.schema,
    columns,
    migrations,
    upgradeStatements: final.upgradeStatements,
  };
}
export function assertOpsSchema(payload, source = opsSchemaSource()) {
  if (JSON.stringify(payload.migrations) !== JSON.stringify(source.migrations))
    throw Error('OPS_MIGRATION_MISMATCH');
  if (
    !Array.isArray(payload.schema) ||
    payload.schema.length !== source.schema.length
  )
    throw Error('OPS_SCHEMA_MISMATCH');
  const seen = new Set();
  for (const row of payload.schema) {
    const id = row.type + ':' + row.name;
    const expected = source.schema.find((r) => r.type + ':' + r.name === id);
    if (
      seen.has(id) ||
      !expected ||
      row.tbl_name !== expected.tbl_name ||
      normalizeOpsSql(row.sql) !== normalizeOpsSql(expected.sql)
    )
      throw Error('OPS_SCHEMA_MISMATCH');
    seen.add(id);
  }
}
