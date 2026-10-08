import test from 'node:test';
import assert from 'node:assert/strict';
import { createPilotAuth } from '../lib/pilot/auth.ts';

test('[S2-AC-001] anonymous session initialization validates the pinned auth adapter schema', async () => {
  // This checks the real library's schema validation, before credentials or a
  // database lookup. Real storage/authentication is covered by the HTTP suite.
  const auth = createPilotAuth({
    prepare() { throw new Error('Anonymous session initialization must not query user records'); },
    async batch() { throw new Error('Anonymous session initialization must not mutate storage'); },
  }, {
    origin: 'http://127.0.0.1:5000',
    secret: 'synthetic-schema-test-only-not-a-runtime-secret',
  });
  const session = await auth.api.getSession({ headers: new Headers() });
  assert.equal(session, null);
});

test('[S2-AC-002] HTTPS sessions use Secure HttpOnly cookies without a shared parent domain', async () => {
  const auth = createPilotAuth({
    prepare() { throw new Error('Cookie configuration must not query user records'); },
    async batch() { throw new Error('Cookie configuration must not mutate storage'); },
  }, {
    origin: 'https://learning.example',
    secret: 'synthetic-cookie-test-only-not-a-runtime-secret',
  });
  const context = await auth.$context;
  const cookie = context.authCookies.sessionToken;
  assert.equal(cookie.attributes.secure, true);
  assert.equal(cookie.attributes.httpOnly, true);
  assert.equal(cookie.attributes.sameSite, 'lax');
  assert.equal(cookie.attributes.path, '/');
  assert.equal(cookie.attributes.domain, undefined);
  assert.match(cookie.name, /^__Secure-/);
});
