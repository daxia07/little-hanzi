import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readinessPhase,
  verifyNodeManifest,
} from '../scripts/readiness-node-runner.mjs';

test('[R6-E-004/014] corpus phase binds its own spec and default corpus marker', () => {
  assert.deepEqual(readinessPhase('r6'), {
    specVersion: 'r6-spec-2',
    integrationVersion: 'r6-integration-1',
    lessonVersion: 'hanzi-starter-draft-v1',
  });
  assert.equal(readinessPhase('r5').lessonVersion, 'little-hanzi-path-1-v1');
  assert.throws(() => readinessPhase('r7'), /Unsupported/);
});

test('[R6-E-004/014] actual source verification refuses a relabelled corpus identity', () => {
  const work = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'hanzi-node-r6-unit-'),
  );
  const snapshot = path.join(work, 'candidate');
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(work, '.hanzi-qa-owned'), 'r6-unit');
  fs.writeFileSync(path.join(snapshot, 'package.json'), '{}');
  const manifest = {
    work,
    snapshot,
    runId: 'r6-unit',
    phase: 'r6',
    specVersion: 'r6-spec-2',
    integrationVersion: 'r6-integration-1',
    lessonVersion: 'hanzi-starter-draft-v1',
    files: ['package.json'],
    digest: crypto
      .createHash('sha256')
      .update('package.json\0{}\0')
      .digest('hex'),
  };
  try {
    assert.equal(verifyNodeManifest(manifest), manifest);
    for (const change of [
      { specVersion: 'r5-spec-2' },
      { integrationVersion: 'r5-integration-1' },
      { lessonVersion: 'forest-01-v4' },
      { specVersion: undefined },
    ])
      assert.throws(
        () => verifyNodeManifest({ ...manifest, ...change }),
        /phase identity/,
      );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
