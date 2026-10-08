import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
assert(
  process.argv.length === 6 &&
    process.argv[2] === '--manifest' &&
    process.argv[4] === '--output',
  'Usage: http-runner.mjs --manifest <built manifest> --output <fresh report directory>',
);
const manifestFile = path.resolve(process.argv[3]),
  output = path.resolve(process.argv[5]);
assert(
  manifestFile.endsWith('/manifest.json') &&
    output.includes('/outputs/qa/readiness-r4/http/'),
  'Explicit frozen manifest and public report directory required',
);
await fs.mkdir(output, { recursive: false });
const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
assert.equal(manifest.phase, 'r4');
const snapshot = await fs.realpath(manifest.snapshot),
  work = await fs.realpath(manifest.work);
assert.equal(snapshot, manifest.snapshot);
assert.equal(work, manifest.work);
assert.equal(
  await fs.readFile(path.join(work, '.hanzi-qa-owned'), 'utf8'),
  manifest.runId,
);
const { verifyNodeManifest } = await import(
  pathToFileURL(path.join(snapshot, 'scripts/readiness-node-runner.mjs')).href
);
verifyNodeManifest(manifest, { built: true });
const manifestBefore = createHash('sha256')
    .update(await fs.readFile(manifestFile))
    .digest('hex'),
  tester = path.join(snapshot, 'tests/readiness-r4/http-suite.mjs'),
  testerHash = createHash('sha256')
    .update(await fs.readFile(tester))
    .digest('hex'),
  adapterHash = createHash('sha256')
    .update(await fs.readFile(import.meta.filename))
    .digest('hex');
const privateRoot = await fs.mkdtemp(path.join(work, 'http-independent-'));
await fs.chmod(privateRoot, 0o700);
await fs.writeFile(path.join(privateRoot, '.hanzi-qa-owned'), manifest.runId, {
  mode: 0o600,
});
const child = spawn(
  process.execPath,
  [
    '--experimental-strip-types',
    path.join(snapshot, 'scripts/readiness-ops-node-runner.mjs'),
    'serve',
    manifestFile,
  ],
  { cwd: snapshot, stdio: ['ignore', 'pipe', 'pipe'] },
);
let raw = '',
  closed = false;
child.once('close', () => (closed = true));
const privateLog = await fs.open(
  path.join(privateRoot, 'runner.log'),
  'wx',
  0o600,
);
child.stdout.on('data', (b) => {
  raw += b;
  void privateLog.write(b);
});
child.stderr.on('data', (b) => {
  void privateLog.write(b);
});
const results = [],
  requests = [],
  throttles = [],
  trace = [];
let learningSQL, opsSQL;
const cleanupFailures = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready() {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const match = /READY ([^\n]+handoff\.json)/.exec(raw);
    if (match) return match[1];
    assert(!closed, 'Owned runtime exited before READY');
    await wait(100);
  }
  throw Error('Owned runtime READY timeout');
}
try {
  const handoffFile = await ready(),
    h = JSON.parse(await fs.readFile(handoffFile, 'utf8'));
  assert.equal(h.candidateId, manifest.candidateId);
  assert(h.operations);
  assert.equal(
    await fs.realpath(handoffFile),
    path.join(h.output, 'handoff.json'),
  );
  assert.equal(path.dirname(h.output), manifest.output);
  assert(/^story-runtime-\d+$/.test(path.basename(h.output)));
  for (const u of [
    h.baseURL,
    h.controlURL,
    h.operations.controlURL,
    h.operations.databaseURL,
  ]) {
    const url = new URL(u);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    assert(url.port);
  }
  async function privateJson(file) {
    const actual = await fs.realpath(file);
    assert.equal(actual, file);
    assert(actual.startsWith(work + path.sep));
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o077, 0);
    if (process.getuid) assert.equal(stat.uid, process.getuid());
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  const credentials = await privateJson(h.credentialsFile),
    config = await privateJson(h.operations.configFile),
    accounts = new Map(credentials.accounts.map((a) => [a.label, a])),
    cookies = new Map();
  const require = createRequire(path.join(snapshot, 'package.json')),
    { createClient } = await import(
      pathToFileURL(require.resolve('@libsql/client')).href
    );
  learningSQL = createClient({ url: config.learningURL });
  opsSQL = createClient({ url: config.operationsURL });
  assert.equal(await fs.realpath(h.state), h.state);
  assert.equal(path.dirname(h.state), work);
  assert(/^story-libsql-[A-Za-z0-9]+$/.test(path.basename(h.state)));
  assert.equal(await fs.realpath(h.operations.state), h.operations.state);
  assert.equal(path.dirname(h.operations.state), work);
  assert.equal(
    await fs.readFile(path.join(h.operations.state, '.hanzi-qa-owned'), 'utf8'),
    manifest.runId,
  );
  const installed = await learningSQL.execute(
    'SELECT installation_id FROM pilot_installation WHERE id=1',
  );
  assert.equal(installed.rows[0].installation_id, h.evidenceInstallationId);
  const account = (who) =>
    accounts.get(typeof who === 'string' ? who : who?.label) ||
    [...accounts.values()].find((a) => a.id === who?.id);
  async function signIn(a) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(h.baseURL + '/api/auth/sign-in/username', {
        method: 'POST',
        headers: { Origin: h.baseURL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: a.username, password: a.password }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 429) {
        const header = response.headers.get('retry-after'),
          seconds =
            header && /^\d+$/.test(header) ? Math.min(Number(header), 300) : 61;
        throttles.push({ actorId: a.id, attempt, seconds, status: 429 });
        await fs.writeFile(
          path.join(output, 'auth-throttle.json'),
          JSON.stringify(throttles, null, 2),
        );
        assert(attempt < 2, 'Auth throttle persists after bounded retries');
        await wait(seconds * 1000);
        continue;
      }
      assert.equal(response.status, 200, 'Ordinary synthetic sign-in');
      const cookie = response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; ');
      assert(cookie);
      cookies.set(a.id, cookie);
      return;
    }
    throw Error('Sign-in attempts exhausted');
  }
  async function request(who, method, endpoint, body, opts = {}) {
    assert(endpoint.startsWith('/api/'));
    const a = who ? account(who) : null;
    if (who) assert(a, 'Only named synthetic actor');
    if (a && !cookies.has(a.id)) await signIn(a);
    const response = await fetch(h.baseURL + endpoint, {
      method,
      headers: {
        Accept: 'application/json',
        ...(opts.origin === null ? {} : { Origin: opts.origin ?? h.baseURL }),
        ...(a ? { Cookie: cookies.get(a.id) } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      assert.equal(
        response.status,
        405,
        'Only framework method denial may have nonJSON body',
      );
    }
    if (response.status !== 405)
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    requests.push({
      actorId: a?.id ?? null,
      method,
      path: endpoint.split('?')[0],
      status: response.status,
    });
    trace.push({
      actorId: a?.id ?? null,
      method,
      endpoint,
      input: body,
      status: response.status,
      body: parsed,
    });
    return { status: response.status, body: parsed };
  }
  async function control(base, endpoint, body) {
    const response = await fetch(base + endpoint, {
      method: 'POST',
      headers: {
        'X-Hanzi-Test-Token': credentials.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(response.status, 200, 'Owned named control ' + endpoint);
    return response.json();
  }
  const ops = (endpoint, body) =>
      control(h.operations.controlURL, endpoint, body),
    learning = (endpoint, body) => control(h.controlURL, endpoint, body),
    actor = (label) => ({ id: accounts.get(label).id, label });
  async function family(childLabel, parentLabel) {
    const child = actor(childLabel),
      parent = actor(parentLabel);
    assert.equal(
      (
        await request(
          parent,
          'PUT',
          `/api/pilot/children/${child.id}/onboarding`,
          {
            nickname: 'Synthetic HTTP QA',
            experience: 'new',
            audioReady: true,
          },
        )
      ).status,
      200,
    );
    const proposed = await request(
      parent,
      'POST',
      `/api/pilot/children/${child.id}/placement/proposals`,
      { lessonVersion: 'forest-01-v4' },
    );
    assert.equal(proposed.status, 200);
    const approved = await request(
      parent,
      'POST',
      `/api/pilot/children/${child.id}/placement/approve`,
      {
        proposalId: proposed.body.proposal.proposalId,
        sourceDigest: proposed.body.proposal.sourceDigest,
      },
    );
    assert.equal(approved.status, 200);
    const started = await request(
      child,
      'POST',
      `/api/pilot/curriculum/assignments/${approved.body.plan.items[0].assignmentId}/start`,
      { requestId: randomUUID() },
    );
    assert.equal(started.status, 200);
    return { child, parent, runId: started.body.runId };
  }
  const operator = actor('operator'),
    teacher = actor('teacher');
  async function revokeChecks(endpoint) {
    const username = 'qa_ops_' + randomUUID().replaceAll('-', '').slice(0, 10),
      password = 'SyntheticA_' + randomUUID();
    const created = await request(operator, 'POST', '/api/pilot/accounts', {
      username,
      name: 'Synthetic independent operator',
      password,
      role: 'operator',
    });
    assert.equal(created.status, 201);
    const a = {
      ...created.body.account,
      label: 'http-added-operator',
      username,
      password,
    };
    accounts.set(a.label, a);
    const who = actor(a.label);
    assert.equal((await request(who, 'GET', endpoint)).status, 403);
    async function change() {
      const next = 'SyntheticB_' + randomUUID();
      const changed = await request(who, 'POST', '/api/auth/change-password', {
        currentPassword: a.password,
        newPassword: next,
        revokeOtherSessions: true,
      });
      assert.equal(changed.status, 200);
      a.password = next;
      cookies.delete(a.id);
      await signIn(a);
    }
    await change();
    assert.equal((await request(who, 'GET', endpoint)).status, 200);
    await request(operator, 'POST', `/api/pilot/accounts/${a.id}/status`, {
      disabled: true,
    });
    assert.equal((await request(who, 'GET', endpoint)).status, 401);
    await request(operator, 'POST', `/api/pilot/accounts/${a.id}/status`, {
      disabled: false,
    });
    cookies.delete(a.id);
    await signIn(a);
    assert.equal((await request(who, 'GET', endpoint)).status, 200);
    const reset = 'SyntheticReset_' + randomUUID();
    assert.equal(
      (
        await request(operator, 'POST', `/api/pilot/accounts/${a.id}/reset`, {
          password: reset,
        })
      ).status,
      200,
    );
    assert.equal((await request(who, 'GET', endpoint)).status, 401);
    a.password = reset;
    cookies.delete(a.id);
    await signIn(a);
    assert.equal((await request(who, 'GET', endpoint)).status, 403);
    await change();
    assert.equal((await request(who, 'GET', endpoint)).status, 200);
    // Explicit fixture callback: only the newly API-created synthetic account in this marked owned DB.
    assert(accounts.get('http-added-operator').id === a.id);
    await learningSQL.execute({
      sql: 'UPDATE pilot_auth_session SET expires_at=0 WHERE user_id=?',
      args: [a.id],
    });
    assert.equal((await request(who, 'GET', endpoint)).status, 401);
    cookies.delete(a.id);
    await signIn(a);
    assert.equal(
      (await request(who, 'POST', '/api/auth/sign-out', {})).status,
      200,
    );
    assert.equal((await request(who, 'GET', endpoint)).status, 401);
  }
  async function privateRedaction(id) {
    const query = await opsSQL.execute({
      sql: "SELECT (SELECT count(*) FROM ops_feedback WHERE id=? AND (private_json IS NOT NULL OR request_json IS NOT NULL OR owner_ref IS NOT NULL))+(SELECT count(*) FROM ops_feedback_event WHERE record_id=? AND (private_json IS NOT NULL OR request_json IS NOT NULL)) AS private_columns,(SELECT count(*) FROM ops_feedback_event WHERE record_id=? AND kind='redacted') AS redaction_events,(SELECT count(*) FROM ops_feedback_event WHERE record_id=? AND kind='submitted') AS submissions",
      args: [id, id, id, id],
    });
    return {
      privateColumns: Number(query.rows[0].private_columns),
      redactionEvents: Number(query.rows[0].redaction_events),
      submissions: Number(query.rows[0].submissions),
    };
  }
  const { createHTTPCases } = await import(pathToFileURL(tester).href);
  for (const c of createHTTPCases({
    handoff: h,
    operator,
    teacher,
    request,
    family,
    ops,
    learning,
    revokeChecks,
    privateRedaction,
  })) {
    const startedAt = new Date().toISOString();
    try {
      const facts = await c.run();
      if (c.id === 'H03') {
        const prior = trace.find(
            (t) =>
              t.method === 'POST' &&
              t.endpoint.endsWith('/triage') &&
              t.status === 200,
          ),
          other = accounts.get('http-added-operator');
        assert(prior && other);
        cookies.delete(other.id);
        await signIn(other);
        const changedActor = await request(
          { id: other.id, label: other.label },
          'POST',
          prior.endpoint,
          prior.input,
        );
        assert.equal(changedActor.status, 409);
        facts.changedActorCannotAdoptReceipt = true;
      }
      if (c.id === 'H05') {
        const queue = await request(
          operator,
          'GET',
          '/api/pilot/ops/feedback?limit=1',
        );
        assert(queue.body.nextCursor);
        const token = JSON.parse(
          Buffer.from(queue.body.nextCursor, 'base64url').toString(),
        );
        token.opsInstallationId = 'foreign-ops';
        const foreign = Buffer.from(JSON.stringify(token)).toString(
          'base64url',
        );
        assert.equal(
          (
            await request(
              operator,
              'GET',
              '/api/pilot/ops/feedback?limit=1&cursor=' + foreign,
            )
          ).status,
          400,
        );
        const saved = trace.find(
          (t) =>
            t.method === 'POST' &&
            t.endpoint.endsWith('/feedback') &&
            t.status === 200,
        ).body.recordId;
        const d = await request(
          operator,
          'GET',
          '/api/pilot/ops/feedback/' + saved,
        );
        assert(d.body.record.nextCursor);
        const all = await request(
            operator,
            'GET',
            '/api/pilot/ops/feedback?limit=50',
          ),
          different = all.body.items.find((r) => r.id !== saved);
        assert.equal(
          (
            await request(
              operator,
              'GET',
              '/api/pilot/ops/feedback/' +
                different.id +
                '/history?cursor=' +
                encodeURIComponent(d.body.record.nextCursor),
            )
          ).status,
          400,
        );
        facts.foreignCursorScopeAndRecordDenied = true;
      }
      if (c.id === 'H07') {
        const submitted = trace.find(
            (t) =>
              t.method === 'POST' &&
              t.endpoint === '/api/pilot/ops/observations' &&
              t.status === 200,
          ),
          corrected = trace.find(
            (t) =>
              t.method === 'POST' &&
              t.endpoint.endsWith('/corrections') &&
              t.status === 200,
          );
        assert.deepEqual(
          (await request(operator, 'POST', submitted.endpoint, submitted.input))
            .body,
          submitted.body,
        );
        assert.deepEqual(
          (await request(operator, 'POST', corrected.endpoint, corrected.input))
            .body,
          corrected.body,
        );
        facts.expiredObservationAndCorrectionReceiptsReplay = true;
      }
      results.push({
        id: c.id,
        ears: c.ears,
        status: 'PASS',
        startedAt,
        facts,
      });
    } catch (error) {
      results.push({
        id: c.id,
        ears: c.ears,
        status: 'FAIL',
        startedAt,
        error: {
          name: error.name,
          message: String(error.message).slice(0, 600),
          code: error.code ?? null,
        },
      });
    }
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(
        {
          candidateId: h.candidateId,
          sourceDigest: h.sourceDigest,
          artifactDigest: h.artifactDigest,
          testerHash,
          adapterHash,
          results,
          requests,
          cleanupFailures,
        },
        null,
        2,
      ),
    );
  }
} finally {
  try {
    learningSQL?.close();
    opsSQL?.close();
  } catch {
    cleanupFailures.push('Owned SQL clients failed close');
  }
  if (!closed) {
    child.kill('SIGINT');
    const deadline = Date.now() + 60000;
    while (!closed && Date.now() < deadline) await wait(100);
    if (!closed) {
      cleanupFailures.push('Graceful runner cleanup timeout');
      child.kill('SIGTERM');
      await wait(2000);
    }
  }
  await privateLog.close();
  verifyNodeManifest(manifest, { built: true });
  const manifestAfter = createHash('sha256')
    .update(await fs.readFile(manifestFile))
    .digest('hex');
  assert.equal(manifestAfter, manifestBefore);
  assert.equal(
    createHash('sha256')
      .update(await fs.readFile(tester))
      .digest('hex'),
    testerHash,
  );
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        candidateId: manifest.candidateId,
        sourceDigest: 'sha256:' + manifest.digest,
        artifactDigest: 'sha256:' + manifest.artifactDigest,
        testerHash,
        adapterHash,
        manifestBefore,
        manifestAfter,
        results,
        requests,
        throttles,
        cleanupFailures,
        scope:
          'Independent real ordinary HTTP/named controls and owned synthetic SQL. No hosted/physical/human acceptance.',
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    candidateId: manifest.candidateId,
    passed: results.filter((r) => r.status === 'PASS').length,
    total: results.length,
    cleanupFailures,
  }),
);
process.exitCode =
  results.length === 7 &&
  results.every((r) => r.status === 'PASS') &&
  !cleanupFailures.length
    ? 0
    : 1;
