// Account-only smoke checks. Reads credentials from stdin; never creates learning evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { origin, parentUsername, childUsername, password, output } = JSON.parse(
  fs.readFileSync(0, 'utf8'),
);
const parsed = new URL(origin);
assert.ok(
  parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'),
);
const checks = [];
const cookies = new Map();
async function request(route, { user, body, requestOrigin = origin } = {}) {
  const headers = { Origin: requestOrigin, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (user && cookies.has(user)) headers.Cookie = cookies.get(user);
  const response = await fetch(origin + route, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  if (user && response.headers.getSetCookie().length) {
    cookies.set(
      user,
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    );
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML routes also have checks. */
  }
  return { status: response.status, headers: response.headers, text, json };
}
function check(name, fn) {
  fn();
  checks.push({ name, status: 'PASS' });
}
let failed = false;
try {
  const root = await request('/');
  check('Public root redirects to pilot', () => {
    assert.equal(root.status, 307);
    assert.equal(root.headers.get('location'), '/pilot');
  });
  const shell = await request('/pilot');
  check('Public pilot shell', () => {
    assert.equal(shell.status, 200);
    assert.ok(shell.text.includes('Checking this invited account'));
  });
  for (const [route, status] of [
    ['/api/pilot/health', 200],
    ['/api/pilot/me', 401],
    ['/api/pilot/accounts', 401],
    ['/api/state', 404],
    ['/api/test/identity', 404],
    ['/api/preview/lessons/forest-01-v1/decision', 404],
    ['/.openai/drizzle/meta/_journal.json', 404],
  ]) {
    const response = await request(route);
    check(`Guard ${route}`, () => assert.equal(response.status, status));
  }
  const profiles = {};
  for (const [username, role] of [
    [parentUsername, 'parent'],
    [childUsername, 'child'],
  ]) {
    const signed = await request('/api/auth/sign-in/username', {
      user: username,
      body: { username, password },
    });
    check(`${role} ordinary sign-in and session flags`, () => {
      assert.equal(signed.status, 200);
      assert.equal(signed.json.user.role, role);
      assert.equal(signed.json.user.mustChangePassword, false);
      assert.ok(!('token' in signed.json));
      const cookie = signed.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      if (parsed.protocol === 'https:') assert.match(cookie, /;\s*Secure/i);
    });
    const me = await request('/api/pilot/me', { user: username });
    check(`${role} safe role projection`, () => {
      assert.equal(me.status, 200);
      assert.equal(me.json.capabilities.manageAccounts, false);
      assert.equal(me.json.children.length, 1);
    });
    profiles[role] = me.json;
  }
  const childId = profiles.child.user.id;
  check('Parent linked to child', () =>
    assert.equal(profiles.parent.children[0].id, childId),
  );
  for (const [route, user, status] of [
    [`/api/pilot/children/${childId}/export`, childUsername, 403],
    ['/api/pilot/accounts', parentUsername, 403],
    [`/api/pilot/children/${childId}/onboarding`, parentUsername, 200],
    [`/api/pilot/children/${childId}/assignments`, parentUsername, 200],
    [
      '/api/pilot/children/unknown-synthetic-id/onboarding',
      parentUsername,
      404,
    ],
  ]) {
    const response = await request(route, { user });
    check(`Role boundary ${route}`, () =>
      assert.equal(response.status, status),
    );
  }
  const originDenied = await request('/api/auth/sign-in/username', {
    requestOrigin: 'https://untrusted.example',
    body: { username: parentUsername, password },
  });
  check('Cross-origin credential request denied', () =>
    assert.equal(originDenied.status, 403),
  );
} catch (error) {
  failed = true;
  checks.push({
    name: 'Smoke assertion',
    status: 'FAIL',
    message: error.message,
  });
} finally {
  for (const user of cookies.keys()) {
    const result = await request('/api/auth/sign-out', { user, body: {} });
    const passed = result.status === 200;
    if (!passed) failed = true;
    checks.push({
      name: 'Revoke smoke session',
      status: passed ? 'PASS' : 'FAIL',
    });
  }
  const report = {
    origin,
    finishedAt: new Date().toISOString(),
    checks,
    learningDataMutated: false,
  };
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      checks: checks.length,
      passed: checks.filter((check) => check.status === 'PASS').length,
      failed,
    }),
  );
  process.exitCode = failed ? 1 : 0;
}
