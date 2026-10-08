import test from 'node:test';
import assert from 'node:assert/strict';
import { corpusRuntimeFailure } from '../scripts/readiness-corpus-runtime-controls.mjs';
void test('built synthetic actor IDs use valid login names through ordinary Better Auth on actual SQLD', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { hashPassword } = await import('better-auth/crypto');
  const { createPilotAuth } = await import('../lib/pilot/auth.ts');
  const { createLibsqlD1Database } =
    await import('../lib/platform/libsql-d1.ts');
  const { corpusRuntimeUsername } =
    await import('../scripts/readiness-corpus-runtime-controls.mjs');
  const { applyLibsqlMigrations } =
    await import('../scripts/pilot-libsql-admin.mjs');
  const { startOwnedCorpusDatabase, stopOwnedCorpusDatabase } =
    await import('../scripts/readiness-corpus-database.mjs');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-auth-probe-'));
  fs.chmodSync(parent, 0o700);
  fs.writeFileSync(
    path.join(parent, '.owned-probe'),
    'synthetic ordinary auth',
    { mode: 0o600 },
  );
  let daemon;
  try {
    daemon = await startOwnedCorpusDatabase({ parent });
    await applyLibsqlMigrations({
      client: daemon.client,
      root: path.resolve(import.meta.dirname, '..'),
    });
    const origin = 'http://127.0.0.1:18473';
    const auth = createPilotAuth(createLibsqlD1Database(daemon.client), {
      origin,
      secret: randomBytes(32).toString('hex'),
    });
    for (const [id, role] of [
      ['r6-operator', 'operator'],
      ['r6-parent-01', 'parent'],
    ]) {
      const username = corpusRuntimeUsername(id);
      const password = randomBytes(24).toString('base64url');
      const clock = Date.now();
      await daemon.client.execute({
        sql: 'INSERT INTO pilot_auth_user(id,name,email,email_verified,created_at,updated_at,username,display_username,role,must_change_password,disabled) VALUES(?,?,?,0,?,?,?,?,?,0,0)',
        args: [
          id,
          id,
          id + '@synthetic.invalid',
          clock,
          clock,
          username,
          username,
          role,
        ],
      });
      await daemon.client.execute({
        sql: "INSERT INTO pilot_auth_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)",
        args: [
          'credential-' + id,
          id,
          id,
          await hashPassword(password),
          clock,
          clock,
        ],
      });
      const response = await auth.handler(
        new Request(origin + '/api/auth/sign-in/username', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }),
      );
      assert.equal(
        response.status,
        200,
        'normal sign-in accepts the fixed synthetic login name',
      );
      const body = await response.json();
      assert.equal(body.user.id, id);
      assert.equal(body.user.role, role);
      assert.ok(response.headers.has('set-cookie'));
      const saved = await daemon.client.execute({
        sql: 'SELECT count(*) n FROM pilot_auth_session WHERE user_id=?',
        args: [id],
      });
      assert.equal(saved.rows[0].n, 1);
    }
  } finally {
    if (daemon) await stopOwnedCorpusDatabase(daemon);
    if (
      fs.readFileSync(path.join(parent, '.owned-probe'), 'utf8') ===
      'synthetic ordinary auth'
    )
      fs.rmSync(parent, { recursive: true });
  }
});
void test('fresh SQLD transport retains its exact modern file identity and uses one HTTP client', async (t) => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const {
    startOwnedCorpusDatabase,
    ownsCorpusDatabase,
    stopOwnedCorpusDatabase,
  } = await import('../scripts/readiness-corpus-database.mjs');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-sqld-probe-'));
  fs.chmodSync(parent, 0o700);
  fs.writeFileSync(
    path.join(parent, '.owned-probe'),
    'synthetic author SQLD lifecycle',
    { mode: 0o600 },
  );
  let daemon;
  try {
    daemon = await startOwnedCorpusDatabase({ parent });
    assert.equal(ownsCorpusDatabase(daemon), true);
    assert.equal(daemon.file, path.join(daemon.directory, 'dbs/default/data'));
    assert.equal(ownsCorpusDatabase({ ...daemon }), false);
    const { applyLibsqlMigrations } =
      await import('../scripts/pilot-libsql-admin.mjs');
    await applyLibsqlMigrations({
      client: daemon.client,
      root: path.resolve(import.meta.dirname, '..'),
    });
    assert.equal(
      (
        await daemon.client.execute(
          'SELECT count(*) n FROM pilot_d1_migrations',
        )
      ).rows[0].n,
      8,
    );
    await daemon.client.execute(
      'CREATE TABLE synthetic_transport_probe(value TEXT NOT NULL)',
    );
    await daemon.client.execute({
      sql: 'INSERT INTO synthetic_transport_probe VALUES(?)',
      args: ['SYNTHETIC ONLY'],
    });
    assert.equal(
      (
        await daemon.client.execute(
          'SELECT count(*) n FROM synthetic_transport_probe',
        )
      ).rows[0].n,
      1,
    );
    assert.equal(ownsCorpusDatabase(daemon), true);
    const { installCorpusRuntimeFault } =
      await import('../scripts/readiness-corpus-runtime-controls.mjs');
    await installCorpusRuntimeFault(daemon.client, {
      stage: 'publication',
      mode: 'final-constraint',
    });
    let actualError;
    await assert.rejects(
      daemon.client.batch(
        [
          {
            sql: 'INSERT INTO synthetic_transport_probe VALUES(?)',
            args: ['MUST ROLLBACK'],
          },
          {
            sql: "INSERT INTO pilot_corpus_publication_audit(id,publication_id,actor_id,action,request_id,created_at) VALUES('SYNTHETIC','SYNTHETIC','SYNTHETIC','released','SYNTHETIC',0)",
            args: [],
          },
        ],
        'write',
      ),
      (error) => {
        actualError = error;
        return true;
      },
    );
    t.diagnostic(
      JSON.stringify({
        actualSQLDTrigger: {
          code: actualError.code,
          message: actualError.message,
        },
      }),
    );
    assert.deepEqual(corpusRuntimeFailure(actualError), {
      status: 503,
      code: 'CORPUS_TERMINAL_CONSTRAINT',
    });
    assert.equal(
      (
        await daemon.client.execute(
          'SELECT count(*) n FROM synthetic_transport_probe',
        )
      ).rows[0].n,
      1,
    );
    await installCorpusRuntimeFault(daemon.client, {
      stage: 'publication',
      mode: 'none',
    });
    await daemon.client.execute({
      sql: 'INSERT INTO synthetic_transport_probe VALUES(?)',
      args: ['RETRY AFTER DISARM'],
    });
    assert.equal(
      (
        await daemon.client.execute(
          'SELECT count(*) n FROM synthetic_transport_probe',
        )
      ).rows[0].n,
      2,
    );
  } finally {
    if (daemon) await stopOwnedCorpusDatabase(daemon);
    if (daemon) assert.equal(ownsCorpusDatabase(daemon), false);
    if (
      fs.readFileSync(path.join(parent, '.owned-probe'), 'utf8') ===
      'synthetic author SQLD lifecycle'
    )
      fs.rmSync(parent, { recursive: true });
  }
});

void test('invalid binary is refused before allocating a factory directory; early child is recorded and exited on readiness failure', async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const { startOwnedCorpusDatabase } =
    await import('../scripts/readiness-corpus-database.mjs');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-sqld-failure-'));
  fs.chmodSync(parent, 0o700);
  fs.writeFileSync(
    path.join(parent, '.owned-probe'),
    'synthetic startup failure',
    { mode: 0o600 },
  );
  const original = process.env.HANZI_SQLD_BINARY;
  const recorded = [];
  try {
    process.env.HANZI_SQLD_BINARY = path.join(parent, 'missing-binary');
    await assert.rejects(
      startOwnedCorpusDatabase({
        parent,
        onOwnedProcess: (s) => recorded.push(s),
      }),
    );
    assert.equal(recorded.length, 0);
    assert.deepEqual(fs.readdirSync(parent), ['.owned-probe']);
    process.env.HANZI_SQLD_BINARY = '/usr/bin/true';
    await assert.rejects(
      startOwnedCorpusDatabase({
        parent,
        onOwnedProcess: (s) => recorded.push(s),
      }),
      /CORPUS_SQLD_EXIT/,
    );
    assert.equal(recorded.length, 1);
    assert.ok(
      recorded[0].child.exitCode !== null ||
        recorded[0].child.signalCode !== null,
    );
    assert.deepEqual(fs.readdirSync(parent), ['.owned-probe']);
  } finally {
    if (original === undefined) delete process.env.HANZI_SQLD_BINARY;
    else process.env.HANZI_SQLD_BINARY = original;
    if (
      fs.readFileSync(path.join(parent, '.owned-probe'), 'utf8') ===
      'synthetic startup failure'
    )
      fs.rmSync(parent, { recursive: true });
  }
});

void test('startup cleanup preserves an unfamiliar file and marker after an observed child exit', async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const { startOwnedCorpusDatabase } =
    await import('../scripts/readiness-corpus-database.mjs');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-sqld-retain-'));
  fs.chmodSync(parent, 0o700);
  fs.writeFileSync(
    path.join(parent, '.owned-probe'),
    'synthetic unknown file preservation',
    { mode: 0o600 },
  );
  let child, directory;
  try {
    await assert.rejects(
      startOwnedCorpusDatabase({
        parent,
        onOwnedProcess(service) {
          child = service.child;
          directory = child.spawnargs[child.spawnargs.indexOf('--db-path') + 1];
          fs.writeFileSync(
            path.join(directory, 'unfamiliar-file'),
            'PRESERVE',
            { mode: 0o600 },
          );
          child.kill('SIGTERM');
        },
      }),
    );
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(
      fs.readFileSync(path.join(directory, 'unfamiliar-file'), 'utf8'),
      'PRESERVE',
    );
    assert.ok(fs.existsSync(path.join(directory, '.hanzi-qa-owned')));
  } finally {
    if (
      fs.readFileSync(path.join(parent, '.owned-probe'), 'utf8') ===
      'synthetic unknown file preservation'
    )
      fs.rmSync(parent, { recursive: true });
  }
});
