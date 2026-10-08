import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client/node';
import { createLibsqlD1 } from '../lib/platform/libsql-d1.ts';
import { createPilotAuth } from '../lib/pilot/auth.ts';

await test('[V-AC-001][S2-AC-002] Vercel rate limits cannot be split with forged Cloudflare IP headers', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hanzi-vercel-ip-'));
  const client = createClient({
    url: `file:${path.join(folder, 'db.sqlite')}`,
  });
  try {
    await client.executeMultiple(
      fs.readFileSync(
        new URL('../db/pilot-migrations/0000-auth.sql', import.meta.url),
        'utf8',
      ),
    );
    const auth = createPilotAuth(createLibsqlD1(client), {
      origin: 'https://auth.example',
      secret: 'synthetic-ip-test-secret-not-a-deployment-secret',
      ipAddressHeader: 'x-forwarded-for',
    });
    for (let attempt = 0; attempt < 9; attempt++) {
      const response = await auth.handler(
        new Request('https://auth.example/api/auth/sign-in/username', {
          method: 'POST',
          headers: {
            Origin: 'https://auth.example',
            'Content-Type': 'application/json',
            'X-Forwarded-For': '198.51.100.7',
            'CF-Connecting-IP': `198.51.100.${attempt + 20}`,
          },
          body: JSON.stringify({
            username: 'unknown.fixture',
            password: 'synthetic-test-password',
          }),
        }),
      );
      assert.equal(response.status, attempt < 8 ? 401 : 429);
    }
  } finally {
    client.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
