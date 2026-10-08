// Actual owned Node/auth/libSQL transport for independent R5 HTTP suite.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runHttpSuite } from './http-suite.mjs';
export async function createHttpAdapter(h, output, lessonVersion = null) {
  const manifest = JSON.parse(await readFile(h.manifest, 'utf8'));
  assert.equal(manifest.phase, 'r5');
  assert.equal(manifest.candidateId, h.candidateId);
  const work = await realpath(manifest.work);
  assert.equal(
    await readFile(path.join(work, '.hanzi-qa-owned'), 'utf8'),
    manifest.runId,
  );
  assert(path.resolve(output).startsWith(work + path.sep));
  for (const key of ['baseURL', 'controlURL']) {
    const u = new URL(h[key]);
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, '127.0.0.1');
  }
  const cu = new URL(h.collection.controlURL);
  assert.equal(cu.protocol, 'http:');
  assert.equal(cu.hostname, '127.0.0.1');
  const file = await realpath(h.credentialsFile);
  assert(file.startsWith(work + path.sep));
  assert.equal((await stat(file)).mode & 0o077, 0);
  const privateData = JSON.parse(await readFile(file, 'utf8')),
    accounts = new Map(privateData.accounts.map((a) => [a.label, a])),
    cookies = new Map(),
    actions = new Map(),
    transcript = [];
  async function record() {
    await writeFile(
      path.join(output, 'transcript.json'),
      JSON.stringify({ candidateId: h.candidateId, transcript }, null, 2) +
        '\n',
    );
  }
  async function signIn(a, base = h.baseURL) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(
        new URL('/api/auth/sign-in/username', base),
        {
          method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: a.username, password: a.password }),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        },
      );
      if (response.status === 429) {
        const header = response.headers.get('retry-after'),
          seconds =
            header && /^\d+$/.test(header) ? Math.min(300, Number(header)) : 61;
        transcript.push({
          method: 'auth',
          role: a.role,
          status: 429,
          attempt,
          waitSeconds: seconds,
        });
        await record();
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        continue;
      }
      assert.equal(response.status, 200, 'Ordinary synthetic sign-in');
      const cookie = response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      assert(cookie);
      cookies.set(base + a.id, cookie);
      return cookie;
    }
    throw Error('Ordinary auth retry exhausted');
  }
  async function request(
    who,
    method,
    endpoint,
    body,
    { base = h.baseURL, originalSession = false } = {},
  ) {
    const a = [...accounts.values()].find((x) => x.id === who.id);
    assert(a);
    assert(endpoint.startsWith('/api/'));
    const cookie = originalSession
      ? cookies.get(h.baseURL + a.id)
      : cookies.get(base + a.id) || (await signIn(a, base));
    const response = await fetch(new URL(endpoint, base), {
      method,
      headers: {
        Origin: base,
        Cookie: cookie,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    const result = await response.json();
    transcript.push({
      actorRole: a.role,
      method,
      path: endpoint,
      status: response.status,
      errorCode: result.error?.code ?? null,
    });
    await record();
    return { status: response.status, body: result };
  }
  async function control(base, route, body) {
    const startedAt = Date.now();
    const response = await fetch(new URL(route, base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hanzi-Test-Token': privateData.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    const result = await response.json();
    const tableCounts = (value) =>
      value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([name, count]) =>
                /^pilot_[a-z0-9_]+$/.test(name) &&
                Number.isSafeInteger(count) &&
                count >= 0,
            ),
          )
        : null;
    transcript.push({
      kind: 'owned-control',
      path: route,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      outcome: ['REFUSED', 'NOT_COMMITTED', 'UNCONFIRMED'].includes(
        result.status,
      )
        ? result.status
        : null,
      errorCode: /^[A-Z0-9_]+$/.test(result.error ?? '') ? result.error : null,
      format: /^pilot-admin-backup-[0-9]+$/.test(result.format ?? '')
        ? result.format
        : null,
      commit: ['confirmed', 'unconfirmed'].includes(result.commit)
        ? result.commit
        : null,
      hasBaseURL: typeof result.baseURL === 'string',
      code: /^[A-Z0-9_]+$/.test(result.code ?? '') ? result.code : null,
      sessionCount: Number.isSafeInteger(result.readback?.sessionCount)
        ? result.readback.sessionCount
        : null,
      verificationCount: Number.isSafeInteger(
        result.readback?.verificationCount,
      )
        ? result.readback.verificationCount
        : null,
      counts: tableCounts(result.counts),
      readbackCounts: tableCounts(result.readback?.counts),
    });
    await record();
    assert.equal(response.status, 200, 'Closed owned control');
    return result;
  }
  const publicActor = (label) => {
    const a = accounts.get(label);
    assert(a);
    return { id: a.id, label };
  };
  async function verify() {
    for (const [names, expected] of [
      [manifest.files, h.sourceDigest],
      [manifest.artifactFiles, h.artifactDigest],
    ]) {
      const hash = createHash('sha256');
      for (const name of names) {
        assert(!path.isAbsolute(name) && !name.split('/').includes('..'));
        const file = path.join(h.snapshot, name);
        assert.equal(await realpath(file), file);
        hash.update(name + '\0');
        hash.update(await readFile(file));
        hash.update('\0');
      }
      assert.equal(hash.digest('hex'), expected.replace(/^sha256:/, ''));
    }
  }
  await verify();
  return {
    request,
    rememberAction: (id, body, result) => actions.set(id, { body, result }),
    lastAction: (id) => actions.get(id),
    backup: () => control(h.controlURL, '/backup', { name: 'populated' }),
    restore: () =>
      control(h.controlURL, '/restore', { name: 'populated', fault: 'none' }),
    async familyFixture(label) {
      const browser = lessonVersion && label === 'r5-browser';
      const variant =
        lessonVersion && /^r5-path-\d{2}-v1-[01]$/.test(label)
          ? Number(label.slice(-1))
          : null;
      const parent = publicActor(browser ? 'parent-b' : 'parent-a');
      const child = browser
        ? publicActor('child-b')
        : variant === 0
          ? publicActor('child-a2')
          : variant === 1
            ? publicActor('child-a')
            : lessonVersion
              ? {
                  id: h.collection.childIdsByLesson[lessonVersion],
                  label: 'package-child',
                }
              : publicActor('child-a2');
      const f = {
        parent,
        child,
        otherParent: publicActor(browser ? 'parent-a' : 'parent-b'),
        operator: publicActor('operator'),
        teacher: publicActor('teacher'),
      };
      const result = await request(
        f.parent,
        'PUT',
        '/api/pilot/children/' + f.child.id + '/onboarding',
        {
          nickname: 'QA ' + label.slice(0, 30),
          experience: 'new',
          audioReady: true,
        },
      );
      assert.equal(result.status, 200);
      return f;
    },
    setServerTime: (at) => control(h.controlURL, '/clock', { at }),
    restartOwnedRuntime: (service) =>
      control(h.controlURL, '/restart', { service }),
    inspectAssignment: (assignmentId) =>
      control(h.collection.controlURL, '/inspect', {
        kind: 'assignment',
        assignmentId,
      }),
    inspectRun: (runId) =>
      control(h.collection.controlURL, '/inspect', { kind: 'run', runId }),
    async recordResults(results) {
      await writeFile(
        path.join(output, 'report.json'),
        JSON.stringify(
          {
            candidateId: h.candidateId,
            sourceDigest: h.sourceDigest,
            artifactDigest: h.artifactDigest,
            results,
          },
          null,
          2,
        ) + '\n',
      );
    },
    verifyFrozenIdentity: verify,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [handoffFile, output] = process.argv.slice(2);
  assert(handoffFile && output && process.argv.length === 4);
  await mkdir(output, { mode: 0o700 });
  const h = JSON.parse(await readFile(handoffFile, 'utf8')),
    a = await createHttpAdapter(h, output);
  const results = await runHttpSuite(a);
  await a.verifyFrozenIdentity();
  process.exitCode =
    results.length > 0 && results.every((r) => r.outcome === 'PASS') ? 0 : 1;
}
