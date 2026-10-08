/** Fresh marked author libSQL only. No active service/default database path. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import { applyLibsqlMigrations } from '../../scripts/pilot-libsql-admin.mjs';
import { createLibsqlD1Database } from '../../lib/platform/libsql-d1.ts';
import { importCurriculumPackage } from '../../lib/pilot/curriculum.ts';
import { curriculumDigest } from '../../lib/curriculum/digest.ts';
const reviewedSqlHash =
  '8360c2dff5612a66a926b08866d227f40d8751ad4121e751e071ce689e27aec8';
export async function withCorpusFixture(fn, options = {}) {
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-r6-author-'));
  fs.writeFileSync(
    path.join(directory, '.hanzi-qa-owned'),
    'R6 synthetic author administration fixture',
  );
  const client = createClient({
    url: 'file:' + path.join(directory, 'fresh.db'),
  });
  try {
    await applyLibsqlMigrations({ client, root: sourceRoot });
    const proposed = new URL(
        '../../outputs/implementation/readiness-r6/backend/0007-corpus-learning.sql',
        import.meta.url,
      ),
      installed = new URL(
        '../../db/pilot-migrations/0007-corpus-learning.sql',
        import.meta.url,
      ),
      sql = fs.readFileSync(
        fs.existsSync(installed) ? installed : proposed,
        'utf8',
      );
    assertSql(sql);
    // Before canonical admission the held SQL is explicit; afterwards the exact
    // migration runner has already installed it, including its singleton row.
    if (!fs.existsSync(installed)) await client.executeMultiple(sql);
    const clock = Date.now();
    for (const [id, role] of [
      ['r6-op', 'operator'],
      ['r6-parent', 'parent'],
      ['r6-child', 'child'],
      ['r6-other', 'operator'],
      ['r6-teacher', 'teacher'],
    ]) {
      await client.execute({
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,0,0,?,?,?,0,0)',
        args: [id, id, id + '@synthetic.invalid', id, id, role],
      });
      await client.execute({
        sql: 'INSERT INTO pilot_auth_session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)',
        args: [
          'session-' + id,
          clock + 86400000,
          'SYNTHETIC-AUTHOR-ONLY-' + id,
          clock,
          clock,
          id,
        ],
      });
    }
    await client.execute(
      "UPDATE pilot_installation SET installation_id='r6-author-install' WHERE id=1",
    );
    await client.execute(
      "INSERT INTO pilot_parent_child VALUES('r6-parent','r6-child',0,'r6-op')",
    );
    if (options.instrumentClient) await options.instrumentClient(client);
    const db = createLibsqlD1Database(client),
      config = {
        pilotMode: true,
        testMode: false,
        testContentAllowed: false,
        testRunId: null,
        testToken: null,
        origin: 'http://synthetic.invalid',
        secret: 'SYNTHETIC-AUTHOR-CURSOR-SECRET',
        candidateId: 'r6-author',
        candidateExplicitlyBound: true,
        curriculumTestNow: null,
        curriculumTrust: options.trust ?? null,
        database: db,
      };
    const context = (id = 'r6-op') => ({
      db,
      config,
      user: {
        id,
        role:
          id === 'r6-parent'
            ? 'parent'
            : id === 'r6-child'
              ? 'child'
              : id === 'r6-teacher'
                ? 'teacher'
                : 'operator',
      },
      session: { id: 'session-' + id },
      corpus: {
        ownerIds: ['r6-parent'],
        fixtureBinding: {
          schemaVersion: 'r6-fixture-binding-1',
          installationId: 'r6-author-install',
          mode: 'synthetic-only',
        },
        capability: null,
      },
    });
    const manifest = JSON.parse(
        fs.readFileSync(
          new URL(
            '../../content/corpora/hanzi-starter-draft-v1.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
      batch = JSON.parse(
        fs.readFileSync(
          new URL(
            '../../content/corpora/batches/hanzi-starter-draft-batch-01-v1.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    for (const item of manifest.items) {
      const document = JSON.parse(
        fs.readFileSync(
          new URL(
            '../../content/curriculum/corpus/' + item.lessonVersion + '.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      if (options.longDisplay && item === manifest.items[0]) {
        document.title = 'A'.repeat(100);
        document.characters[0].wordAssociations[0].english = 'B'.repeat(180);
        const digest = await curriculumDigest(document);
        item.contentDigest = digest;
        batch.items.find(
          (x) => x.lessonVersion === item.lessonVersion,
        ).contentDigest = digest;
      }
      await importCurriculumPackage(context(), { package: document });
    }
    await fn({
      client,
      db,
      config,
      context,
      manifest,
      batch,
      clock,
      directory,
      packageDigest: curriculumDigest,
    });
  } finally {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function assertSql(sql) {
  if (crypto.createHash('sha256').update(sql).digest('hex') !== reviewedSqlHash)
    throw Error('R6_SQL_NOT_EXACT_REVIEWED_SOURCE');
}
