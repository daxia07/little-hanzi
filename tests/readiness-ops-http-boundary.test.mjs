import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Narrow response-presentation unit: replace auth/platform/store imports only.
// Real HTTP authentication/SQL is separately exercised by external H01-H07.
const file = new URL('../lib/pilot/ops-http.ts', import.meta.url);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ops-http-boundary-'),
);
const target = pathToFileURL(path.join(temporary, 'boundary.ts'));
let source = await fs.readFile(file, 'utf8');
source = source
  .replace(
    /import \{[\s\S]*?\} from '\.\/http\.ts';/,
    'const requirePilotSession=async()=>globalThis.__opsHttpSession;const requireOrigin=()=>null;const bodyJson=async request=>request.json();const json=(body,status=200)=>new Response(JSON.stringify(body),{status});',
  )
  .replace(
    "import { opsContext } from './ops-runtime.ts';",
    'const opsContext=async()=>globalThis.__opsHttpContext;',
  )
  .replace(
    "import * as store from './ops-store.ts';",
    "const store={triageFeedback:async()=>{throw new OpsError('OPS_CONFLICT',409,7);}};",
  );
source = source.replaceAll(
  /from '(\.[^']+)'/g,
  (_match, relative) => "from '" + new URL(relative, file).href + "'",
);
await fs.writeFile(target, source);
const { opsRoute } = await import(target.href);
await fs.rm(temporary, { recursive: true, force: true });
globalThis.__opsHttpSession = {
  user: { id: 'operator-unit', role: 'operator' },
  config: { candidateId: 'build-unit' },
};
globalThis.__opsHttpContext = {
  installationId: 'learn-unit',
  opsInstallationId: 'ops-unit',
  buildId: 'build-unit',
  now: () => 123,
};
test('R4-E003 authorized conflict carries safe scope envelope/current revision', async () => {
  const response = await opsRoute(
    new Request('http://127.0.0.1/api/pilot/ops/feedback/record/triage', {
      method: 'POST',
      body: '{}',
    }),
    'triage',
    'record',
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.schemaVersion, 'r4-ops-view-1');
  assert.equal(body.installationId, 'learn-unit');
  assert.equal(body.opsInstallationId, 'ops-unit');
  assert.equal(body.buildId, 'build-unit');
  assert.equal(body.serverAt, 123);
  assert.equal(body.currentRevision, 7);
  assert.equal(body.status, undefined);
});
