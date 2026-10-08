import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [recordPath, output] = process.argv.slice(2);
const { work, source } = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
const { readEncryptedPair } = await import(
  pathToFileURL(path.join(source, 'scripts/pilot-ops-recovery.mjs'))
);
const { assertOpsSourcePair } = await import(
  pathToFileURL(path.join(source, 'scripts/pilot-ops-jobs.mjs'))
);
assert.throws(
  () => assertOpsSourcePair('pilot-admin-backup-6', 'pilot-ops-backup-2'),
  { code: 'OPS_SCHEMA_MISMATCH' },
);
let reads = 0,
  code = null;
try {
  await readEncryptedPair({
    sourceRoot: work,
    archiveStore: {
      get() {
        reads++;
        return null;
      },
    },
    keys: new Map(),
    sourceScope: {},
    admission: {
      job: { kind: 'backup', buildId: 'independent' },
      objects: { learning: { objectId: 'l' }, operations: { objectId: 'o' } },
    },
    resolveBuild: () => ({ candidateId: 'independent' }),
  });
} catch (error) {
  code = error.code ?? error.message;
}
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      caseId: 'AC606-pair',
      expected: 'OPS_SCHEMA_MISMATCH before archive I/O',
      actualCode: code,
      archiveReads: reads,
      outcome: code === 'OPS_SCHEMA_MISMATCH' && reads === 0 ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ),
);
assert.equal(
  reads,
  0,
  'unsupported source pair must refuse before archive reads',
);
assert.equal(code, 'OPS_SCHEMA_MISMATCH');
